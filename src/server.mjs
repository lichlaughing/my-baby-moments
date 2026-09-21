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
 * 拦哪一侧由 auth.scope 决定（默认 'latest'）：
 *   'latest'  未登录只能看**最新 N 条**（默认 1 条）→ feed 服务端裁到 N 条，
 *             其余媒体的 URL 在 /thumb、/media 上直接 401
 *   'all'     未登录什么都看不到 → feed / thumb / media / events 一律 401
 *   'upload'  读侧全放开，只有上传要登录
 *
 * /api/events 比别的读接口更严一档：只要读侧被限制，**未登录就不给连**，
 * 哪怕 'latest' 档允许他看最新那一条 —— 长连接会把"什么时候有新照片"暴露出去。
 *
 * 两条不变量，改动这里时必须守住：
 *   ① **裁剪在服务端**。前端"藏起来"没有意义 —— 抓一次包就绕过去了。
 *      所以未登录时 /api/feed 里根本不存在那些条目，stats 也只统计可见部分。
 *      另外 readLimit 是"给未登录的人看多少"，**别无条件套在所有人身上**：
 *      /api/feed 里必须写成 `g.anon ? anonEntries(...) : full.entries`
 *      （早期版本忘了这个三元，结果登录之后也只拿到一条）。
 *   ② 页面骨架（/ 与 /assets/*）**始终公开**。否则登录界面自己都加载不出来，
 *      css/js 也拿不到，就成了"锁上之后连钥匙孔都没有"。
 *      代价是站点标题在匿名访客的 <title> 里可见 —— 这是已知且可接受的取舍，
 *      所以未登录时会摘掉宝宝的生日与别名（见 serveIndex）。
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

  /**
   * 未登录时能读到哪里。Infinity = 不限制（scope='upload'，只有发布要登录）。
   * 下面所有裁剪都从这一个数字出发，别在别处再写死"1 条"。
   */
  const readsGated = auth.readsGated;
  const readLimit = auth.readLimit;

  /** 媒体 key → rel 的索引，用于 /thumb 反查 */
  let keyIndex = new Map();

  /**
   * 未登录可见的媒体白名单（readsGated 为假时恒为 null = 全放开）。
   * 存**绝对路径**而不是 rel：rel 来自扫描器、路径来自 URL，两边各自规范化过，
   * 直接比字符串在大小写/分隔符上容易假阴性；比绝对路径不会。
   */
  let previewKeys = null;
  let previewFiles = null;

  /**
   * 未登录视角下的条目 —— **只在 anon 为真时调用**。
   * 条目已按时间倒序，取前 N 条就是"最新的 N 条"。
   *
   * 注意别无条件用它：readLimit 是"给未登录的人看多少"，不是"所有人看多少"。
   * 早期版本在 /api/feed 里直接 slice，结果登录之后也只拿到一条。
   */
  const anonEntries = (entries) => entries.slice(0, readLimit);

  /**
   * 按可见条目重算 stats。
   * 别把"一共有多少条、从哪一年开始"漏给未登录的人 —— 那正是默认那档想收起来的信息。
   */
  function restats(entries) {
    const dates = entries.map((e) => e.date).sort();
    return {
      entries: entries.length,
      photos: entries.reduce((n, e) => n + e.counts.image, 0),
      videos: entries.reduce((n, e) => n + e.counts.video, 0),
      days: new Set(dates).size,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
    };
  }

  async function getManifest(force = false) {
    if (!force && manifestCache && Date.now() - manifestAt < TTL) return manifestCache;
    if (scanning) return scanning;
    scanning = (async () => {
      const data = await scanner.scan();
      keyIndex = new Map();
      for (const e of data.entries) for (const m of e.media) keyIndex.set(m.key, m);
      if (readsGated) {
        previewKeys = new Set();
        previewFiles = new Set();
        // 白名单 = 未登录视角（前 N 条）的全部媒体
        for (const e of anonEntries(data.entries)) {
          // 用 e.media 而不是装饰后的 entries：扫描结果里 poster 也在 media 里，
          // 而视频封面正好要靠它 —— 漏了会让未登录的人看到一堆 401 的黑封面。
          for (const m of e.media) {
            previewKeys.add(m.key);
            previewFiles.add(path.resolve(scanner.mediaRoot, m.rel));
          }
        }
      }
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
  /** 监听建不起来只提醒一次，别每帧刷屏 */
  let watchWarned = false;
  function startWatch() {
    if (!config.server.watch || watcher) return;

    /**
     * 放弃监听时给出**可见的信号**。
     *
     * 网络盘 / 网盘挂载点（WebDAV、SMB、FUSE）上 inotify / FSEvents 通常不可用，
     * 于是 fs.watch 抛错或立刻 error。这在以前是完全静默的 —— 用户以为
     * "往照片目录丢文件页面会自动刷新"，结果等半天没反应，还以为是程序坏了。
     * 现在至少说清楚：这是挂载点的正常现象，手动刷新即可。
     */
    const giveUp = (why) => {
      try { watcher?.close(); } catch { /* 已经坏了就算了 */ }
      watcher = null;
      if (watchWarned) return;
      watchWarned = true;
      warn(
        `照片目录监听没建起来（${why}），页面不会自动刷新。` +
          `网络盘 / 网盘挂载点通常不支持文件系统事件，属正常现象 —— 改完手动刷新页面即可。` +
          `想彻底关掉这条提示：把 server.watch 设成 false。`,
      );
    };

    try {
      watcher = fs.watch(scanner.mediaRoot, { recursive: true }, (_evt, file) => {
        if (file && /(^|\/)\./.test(file)) return;
        onFsChange();
      });
      watcher.on('error', (err) => giveUp(err?.code || err?.message || '未知错误'));
    } catch (err) {
      // 注意同时看 code 与 message：本机沙箱会把 code 改写成 CODEBUDDY_BROKER_DENY，
      // 真正的原因只在 message 里（和 isExists / isExdev 是同一类坑）。
      giveUp(err?.code || err?.message || '未知错误');
    }
  }

  async function serveIndex(req, res) {
    // 未登录时摘掉宝宝的生日与别名。页面骨架本身必须公开（否则登录界面自己都加载不出来），
    // 但没有理由把孩子的确切生日送到一个匿名访客的浏览器里。
    // 这里刻意不调 renewIfStale：页面是 no-cache 的，续期交给 /api/session 一个地方做。
    const anon = readsGated && !auth.currentUser(req);
    const raw = await fsp.readFile(path.join(publicDir, 'index.html'), 'utf8');
    const injected = raw.replace(
      '<!--SITE_CONFIG-->',
      `<script id="site-config" type="application/json">${toScriptJson(
        siteConfig(config, {
          uploadEnabled: uploader.enabled,
          authRequired: auth.enabled,
          // 前端拿它只是为了少发一个注定 401 的请求；真裁剪在 /api/feed
          readScope: auth.scope,
          redactKids: anon,
        }),
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

  /**
   * 读侧鉴权。返回 `{ ok, anon }`：
   *   ok=false → 已经回过响应了（401/503），调用方直接 return
   *   anon=true → 未登录。此时**内容本身可能还是允许看的**（scope='latest'），
   *               但只有白名单里那几条可达 —— 调用方必须按 anon 再收一次口
   *
   * 必须在任何 writeHead **之前**调用：会话临近过期时会顺手续期，
   * 而 Set-Cookie 一旦晚于 writeHead 就丢了 —— 症状是"用着用着突然要重新登录"，
   * 且只在会话过半之后才出现，很容易被当成偶发。
   */
  function checkRead(req, res) {
    if (!readsGated) return { ok: true, anon: false };
    // 配了认证却一个账号都没有：这时谁也认不出来，回 401 只会让人一直试口令。
    // 明确 503 + 怎么修，与上传侧同一种口径 —— 不静默放行。
    if (auth.misconfigured) {
      sendJson(res, 503, auth.notConfigured('read'));
      return { ok: false, anon: false };
    }
    if (auth.renewIfStale(req, res)) return { ok: true, anon: false };
    // scope='all'（readLimit 为 0）：一条都不给。
    // scope='latest'：放行，但调用方会把范围收成"最新 N 条" ——
    //   这里不能一律 401，否则默认那档就等于把整站也锁死了。
    if (readLimit === 0) {
      auth.denyUnauthorized(res, sendJson, 'read');
      return { ok: false, anon: true };
    }
    return { ok: true, anon: true };
  }

  /**
   * SSE 单独把关：只要读侧被限制（scope 不是 'upload'），**未登录就不给连** ——
   * 即便 'latest' 档允许他看最新那一条。
   *
   * 理由不是"怕泄内容"，而是防侧信道：匿名访客不需要实时推送（刷新页面就够），
   * 但一条长连接会不断告诉他"刚刚有新照片传上来了" ——
   * 那是超出预览范围的信息（能据此推断家里的作息）。
   */
  function checkEvents(req, res) {
    if (!readsGated) return true;
    if (auth.misconfigured) {
      sendJson(res, 503, auth.notConfigured('read'));
      return false;
    }
    if (auth.renewIfStale(req, res)) return true;
    auth.denyUnauthorized(res, sendJson, 'read');
    return false;
  }

  /**
   * 原图/原视频，支持 Range —— 视频拖进度条、大图断点都靠它。
   * anon=true 时只有白名单里的文件可达（白名单 = 未登录能看见的那几条动态的媒体）。
   */
  async function serveMedia(req, res, pathname, anon = false) {
    const rel = decodeRelPath(pathname.replace(/^\/media\/?/, ''));
    if (!rel) return sendError(res, 400, '非法路径');
    const full = path.resolve(scanner.mediaRoot, rel);
    if (!full.startsWith(path.resolve(scanner.mediaRoot))) return sendError(res, 403, '越权访问');
    // 白名单用绝对路径比：rel 比字符串在分隔符/大小写上容易假阴性
    if (anon && !previewFiles?.has(full)) return auth.denyUnauthorized(res, sendJson, 'read');

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

  async function serveThumb(req, res, pathname, anon = false) {
    const parts = pathname.replace(/^\/thumb\/?/, '').split('/');
    if (parts.length !== 3) return sendError(res, 400, '缩略图路径格式错误');
    const [key, variant, file] = parts;
    if (!['grid', 'view'].includes(variant)) return sendError(res, 400, '未知规格');
    // 不在白名单里就当作"没有这个媒体"：401 而不是 404，
    // 免得未登录的人靠"404 还是 401"把哪些 key 存在给枚举出来。
    if (anon && !previewKeys?.has(key)) return auth.denyUnauthorized(res, sendJson, 'read');

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
        // 文件名里带 rev，文件被替换后 URL 会变，可以放心长缓存。
        // 但未登录可见的缩略图不能标 public：那会在代理/共享缓存上留一份，
        // 下一个没登录的人只要拿到 URL 就能读出来。
        'Cache-Control': `${anon ? 'private' : 'public'}, max-age=31536000, immutable`,
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
            return sendJson(res, 503, auth.notConfigured('upload'));
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

      if (p === '/' || p === '/index.html') return await serveIndex(req, res);

      if (p === '/api/feed') {
        const g = checkRead(req, res);
        if (!g.ok) return undefined;
        const full = await getManifest(url.searchParams.has('refresh'));
        // 未登录时**在服务端裁掉**其余条目：抓包也拿不到。
        // stats 一起重算，否则"共 132 条"这种数字本身就是泄露。
        const entries = g.anon ? anonEntries(full.entries) : full.entries;
        const data = decorate(
          g.anon
            ? {
                ...full,
                entries,
                stats: restats(entries),
                // preview.limited 是给前端用的"你看到的不是全部"判据。
                // 由服务端算而不是前端猜：只有它知道到底裁没裁
                // （相册里本来就只有一条时不该弹"登录后看全部"）。
                preview: { scope: auth.scope, shown: entries.length, limited: full.entries.length > entries.length },
              }
            : full,
        );
        const body = JSON.stringify(data);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }

      if (p === '/api/events') {
        if (!checkEvents(req, res)) return undefined;
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

      if (p.startsWith('/thumb/')) {
        const g = checkRead(req, res);
        if (!g.ok) return undefined;
        return await serveThumb(req, res, p, g.anon);
      }
      if (p.startsWith('/media/')) {
        const g = checkRead(req, res);
        if (!g.ok) return undefined;
        return await serveMedia(req, res, p, g.anon);
      }
      // 站点资源始终公开：登录界面自己也要靠它渲染
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
    /** 监听是否真的建立起来了。false 且 config.server.watch 为真 = 这个文件系统不支持事件 */
    watchActive: () => !!watcher,
    closeWatch: () => watcher?.close(),
    stats: () => thumbs.cacheSize(),
  };
}
