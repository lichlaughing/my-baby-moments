/**
 * 本地服务：
 *   GET  /                    朋友圈页面（注入站点配置）
 *   GET  /api/feed            扫描结果 manifest（媒体 URL 已填好）
 *   GET  /api/events          SSE，照片目录一变就通知前端重新拉 feed
 *   GET  /api/session         当前登录状态（页面据此决定显示"登录"还是"发布"）
 *   POST /api/login           登录（JSON），成功下发签名会话 Cookie
 *   POST /api/logout          退出
 *   POST /api/upload          发布：multipart/form-data 落成一条新动态（需登录）
 *   GET  /thumb/:key/:variant 缩略图（按需生成后缓存）
 *   GET  /media/<路径>        原图/原视频，支持 Range（视频拖动进度条必需）
 *
 * 读接口（feed / 页面 / 缩略图 / 原图）是公开的 —— 需求是"上传要认证"，
 * 不是"看照片要认证"。想把整个站点也关起来是另一件事，见 README。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { createScanner } from './scan.mjs';
import { createThumbs } from './thumbs.mjs';
import { createUploader } from './upload.mjs';
import { createAuth } from './auth.mjs';
import { decodeRelPath, debounce, drainRequest } from './util.mjs';
import { decorateManifest, siteConfig, toScriptJson } from './manifest.mjs';

const PUBLIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const VIDEO_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
};

const IMAGE_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
};

const mimeForMedia = (ext) => IMAGE_MIME[ext] || VIDEO_MIME[ext] || 'application/octet-stream';

export function createServer(config, { root, onWarn } = {}) {
  const warn = onWarn || ((msg) => console.warn(`  ⚠ ${msg}`));
  const scanner = createScanner(config, { root });
  const thumbs = createThumbs(config, { root, mediaRoot: scanner.mediaRoot });
  const uploader = createUploader(config, { root, onWarn: warn });
  const auth = createAuth(config, { root, onWarn: warn });
  const publicDir = path.join(root, 'public');

  const clients = new Set();
  let manifestCache = null;
  let manifestAt = 0;
  let scanning = null;
  const TTL = 1500;

  /** 媒体 key → rel 的索引，用于 /thumb 反查 */
  let keyIndex = new Map();

  async function getManifest(force = false) {
    if (!force && manifestCache && Date.now() - manifestAt < TTL) return manifestCache;
    if (scanning) return scanning;
    scanning = (async () => {
      const data = await scanner.scan();
      keyIndex = new Map();
      for (const e of data.entries) for (const m of e.media) keyIndex.set(m.key, m);
      manifestCache = data;
      manifestAt = Date.now();
      return data;
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  const invalidate = () => {
    manifestCache = null;
    manifestAt = 0;
  };

  /** 拼接前端要用的所有 URL */
  const decorate = (manifest) => decorateManifest(config, manifest, '');

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  const onFsChange = debounce(() => {
    invalidate();
    broadcast('change', { at: Date.now() });
  }, 400);

  let watcher = null;
  function startWatch() {
    if (!config.server.watch || watcher) return;
    try {
      watcher = fs.watch(scanner.mediaRoot, { recursive: true }, (_evt, file) => {
        if (file && /(^|\/)\./.test(file)) return;
        onFsChange();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  async function serveIndex(res) {
    const raw = await fsp.readFile(path.join(publicDir, 'index.html'), 'utf8');
    const injected = raw.replace(
      '<!--SITE_CONFIG-->',
      `<script id="site-config" type="application/json">${toScriptJson(
        siteConfig(config, { uploadEnabled: uploader.enabled, authRequired: auth.enabled }),
      )}</script>`,
    );
    res.writeHead(200, {
      'Content-Type': PUBLIC_MIME['.html'],
      'Cache-Control': 'no-cache',
    });
    res.end(injected);
  }

  async function serveStatic(res, pathname) {
    const rel = decodeRelPath(pathname.replace(/^\/+/, ''));
    if (!rel) return sendError(res, 400, '非法路径');
    const full = path.join(publicDir, rel);
    if (!full.startsWith(publicDir)) return sendError(res, 403, '越权访问');
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isFile()) return sendError(res, 404, 'Not Found');
    res.writeHead(200, {
      'Content-Type': PUBLIC_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    });
    fs.createReadStream(full).pipe(res);
  }

  function sendJson(res, code, payload) {
    if (res.headersSent) return res.end();
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function sendError(res, code, msg) {
    sendJson(res, code, { error: msg, code });
  }

  /** 原图/原视频，支持 Range —— 视频拖进度条、大图断点都靠它 */
  async function serveMedia(req, res, pathname) {
    const rel = decodeRelPath(pathname.replace(/^\/media\/?/, ''));
    if (!rel) return sendError(res, 400, '非法路径');
    const full = path.resolve(scanner.mediaRoot, rel);
    if (!full.startsWith(path.resolve(scanner.mediaRoot))) return sendError(res, 403, '越权访问');

    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isFile()) return sendError(res, 404, '文件不存在');

    const etag = `W/"${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }

    const ext = path.extname(full).slice(1).toLowerCase();
    const headers = {
      'Content-Type': mimeForMedia(ext),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=604800',
      ETag: etag,
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`,
    };

    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      } else if (start !== null && end === null) {
        end = stat.size - 1;
      }
      start = Math.max(0, start ?? 0);
      end = Math.min(end ?? stat.size - 1, stat.size - 1);
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(full, { start, end }).pipe(res);
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  }

  async function serveThumb(req, res, pathname) {
    const parts = pathname.replace(/^\/thumb\/?/, '').split('/');
    if (parts.length !== 3) return sendError(res, 400, '缩略图路径格式错误');
    const [key, variant, file] = parts;
    if (!['grid', 'view'].includes(variant)) return sendError(res, 400, '未知规格');

    await getManifest();
    const media = keyIndex.get(key);
    if (!media) return sendError(res, 404, '未知媒体');

    const rev = path.basename(file, '.webp');
    try {
      const { file: dest } = await thumbs.ensure({
        key,
        rel: media.rel,
        rev,
        variant,
        ext: media.ext,
        kind: media.kind,
      });
      const stat = await fsp.stat(dest);
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': stat.size,
        // 文件名里带 rev，文件被替换后 URL 会变，可以放心长缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(dest).pipe(res);
    } catch (err) {
      const code = err.code === 'ENOENT_SRC' ? 404 : 415;
      if (res.headersSent) return res.end();
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: err.message,
          code,
          hint:
            code === 415
              ? '这个格式解码失败。若照片是 HEIC/RAW，确认 node_modules 里装好了 heic-convert；也可试 `npm run prewarm` 看具体报错。'
              : undefined,
        }),
      );
    }
  }

  /** 同源判定：带 Origin 时必须与 Host 一致（跨站请求一律挡掉，写接口尤其不能放开） */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') {
        // 早先这里是 Allow-Origin: * —— 等于给任意网站开了写接口的门。
        // 现在只回显同源 Origin，跨站连预检都过不去。
        req.resume();
        if (!sameOrigin(req)) {
          res.writeHead(403);
          return res.end();
        }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': req.headers.origin || '*',
          'Access-Control-Allow-Headers': 'content-type, x-bm-upload, x-bm-auth',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        return res.end();
      }

      /* ── 会话 ── */

      if (p === '/api/session') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          await drainRequest(req);
          return sendError(res, 405, '只支持 GET');
        }
        req.resume();
        // 顺手续期，页面打开就自动把快过期的会话往后推
        auth.renewIfStale(req, res);
        return sendJson(res, 200, auth.status(req));
      }

      if (p === '/api/login' || p === '/api/logout') {
        if (req.method !== 'POST') {
          await drainRequest(req);
          return sendError(res, 405, '只支持 POST');
        }
        // 自定义头 + 同源校验：跨站表单带不上自定义头，跨站请求也过不了同源检查
        if (req.headers['x-bm-auth'] !== '1') {
          await drainRequest(req);
          return sendError(res, 403, '缺少请求标识');
        }
        if (!sameOrigin(req)) {
          await drainRequest(req);
          return sendError(res, 403, '拒绝跨站请求');
        }
        return p === '/api/login'
          ? await auth.handleLogin(req, res, sendJson)
          : await auth.handleLogout(req, res, sendJson);
      }

      if (p === '/api/upload') {
        if (req.method !== 'POST') {
          await drainRequest(req);
          return sendError(res, 405, '只支持 POST');
        }
        if (!sameOrigin(req)) {
          await drainRequest(req);
          return sendError(res, 403, '拒绝跨站上传');
        }

        let me = null;
        if (auth.enabled) {
          // 先区分"没配账号"和"没登录"：前者是服务端的问题，回 401 会让人一直试口令
          if (auth.misconfigured) {
            await drainRequest(req);
            return sendJson(res, 503, {
              error: '服务端还没有配置账号，无法上传。见 moments.config.mjs → auth.users（可用 npm run passwd 生成）',
              code: 'AUTH_NOT_CONFIGURED',
            });
          }
          // renewIfStale 可能会下发续期 Cookie，必须在写响应头之前调用
          me = auth.renewIfStale(req, res);
          if (!me) {
            await drainRequest(req);
            return auth.denyUnauthorized(res, sendJson);
          }
        }

        const out = await uploader.handle(req, res, sendJson, { user: me });
        // 落盘后立刻失效缓存并广播，不等 fs.watch 的 debounce —— 发布完页面要马上能看到
        if (out?.ok) {
          invalidate();
          broadcast('change', { at: Date.now(), reason: 'upload', path: out.path });
        }
        return undefined;
      }

      if (p === '/' || p === '/index.html') return await serveIndex(res);

      if (p === '/api/feed') {
        const data = decorate(await getManifest(url.searchParams.has('refresh')));
        const body = JSON.stringify(data);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      if (p === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 3000\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return undefined;
      }

      if (p.startsWith('/thumb/')) return await serveThumb(req, res, p);
      if (p.startsWith('/media/')) return await serveMedia(req, res, p);
      if (p.startsWith('/assets/')) return await serveStatic(res, p);

      return sendError(res, 404, 'Not Found');
    } catch (err) {
      console.error('[server]', err);
      return sendError(res, 500, err.message);
    }
  });

  return {
    server,
    scanner,
    thumbs,
    uploader,
    auth,
    config,
    invalidate,
    getManifest,
    startWatch,
    closeWatch: () => watcher?.close(),
    stats: () => thumbs.cacheSize(),
  };
}
