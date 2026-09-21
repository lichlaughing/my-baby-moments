#!/usr/bin/env node
/**
 * 静态导出的契约验证  ——  node scripts/verify-static.mjs
 *
 * 守的是一条容易被静默破坏的契约：**导出的静态站里不能出现上传按钮**。
 * 静态站没有后端，`POST /api/upload` 不存在；如果按钮露出来，用户点了只会报错。
 * 实现方式是 build 时把 upload.enabled 写死成 false，前端据此隐藏按钮 ——
 * 这条链任何一环断了都不会报错，只是按钮悄悄冒出来，所以值得固化成断言。
 *
 * 顺带核对纯静态托管下的三件事：feed.json 回落、卡片渲染、无破图。
 * 前提：先跑 `npm run build`。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.BM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
};

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`\n没有找到静态产物：${DIST}/index.html\n先跑一次 npm run build，再执行本脚本。\n`);
  process.exit(2);
}
if (!fs.existsSync(CHROME)) {
  console.error(`\n找不到 Chrome：${CHROME}\n可用环境变量 BM_CHROME=... 指定路径。\n`);
  process.exit(2);
}

/* ── 静态文件服务 ─────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // 静态站没有后端：/api/* 一律 404，逼前端走 feed.json 回落
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"静态站无后端"}');
    return;
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (url.pathname === '/') file = path.join(DIST, 'index.html');
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const BASE = `http://127.0.0.1:${port}`;
console.log(`\n静态站：${BASE} （源自 ${path.relative(ROOT, DIST)}/）`);

/* ── 起 Chrome ────────────────────────────────────────────────────── */
const udd = mkdtempSync(path.join(tmpdir(), 'bm-static-'));
const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--user-data-dir=${udd}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-sandbox',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));
child.stdout.on('data', () => {});

const cleanup = () => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const wsUrl = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('Chrome 起不来\n' + stderr)), 20000);
  const scan = () => {
    const m = stderr.match(/ws:\/\/[^\s]+/);
    if (m) {
      clearTimeout(t);
      res(m[0]);
    }
  };
  child.stderr.on('data', scan);
  scan();
});

const targets = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');

let id = 0;
const pending = new Map();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('WS 连接失败')), { once: true });
});
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const { text, url = '' } = m.params.entry;
    // 两类噪声都不是构建缺陷：
    //   /api/* 404 —— 本脚本自己造的，用来逼前端回落 feed.json
    //   /favicon.ico 404 —— 项目没有 favicon，任何静态托管都会 404
    if (url.includes('/api/') || url.includes('favicon.ico')) return;
    errors.push(`${text} @ ${url}`);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => {
      if (pending.has(n)) {
        pending.delete(n);
        rej(new Error('CDP 超时 ' + method));
      }
    }, 45000);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(3000);

/* ── 断言 ─────────────────────────────────────────────────────────── */
console.log('\n─ 1. 上传按钮必须在导出物里消失');
{
  const cfg = JSON.parse(await ev(`document.getElementById('site-config').textContent`));
  ok('产物内 upload.enabled = false', cfg.upload?.enabled === false, String(cfg.upload?.enabled));

  const st = JSON.parse(
    await ev(`(() => {
      const b = document.getElementById('open-publish');
      if (!b) return JSON.stringify({ missing: true });
      return JSON.stringify({ hidden: b.hasAttribute('hidden'), display: getComputedStyle(b).display,
        width: b.getBoundingClientRect().width });
    })()`),
  );
  ok('按钮带 hidden 属性', st.hidden === true, JSON.stringify(st));
  ok('computed display = none', st.display === 'none', st.display);
  ok('不占位（宽 0）', st.width === 0, String(st.width));

  // 关键的第二道防线：initPublish 在没有 enabled 时提前 return，一个监听都不挂。
  // 所以即便有人手动摘掉 hidden，面板也打不开。
  const clicked = JSON.parse(
    await ev(`(() => {
      const b = document.getElementById('open-publish');
      b.removeAttribute('hidden');
      b.click();
      const sheet = document.getElementById('publish');
      return JSON.stringify({ visible: sheet.classList.contains('is-open') ||
        getComputedStyle(sheet).display !== 'none', display: getComputedStyle(sheet).display });
    })()`),
  );
  ok('手动摘掉 hidden 后点击，面板仍打不开（没挂监听）', clicked.visible === false, clicked.display);
}

console.log('\n─ 2. 纯静态托管下站点可用');
{
  const feed = JSON.parse(
    await ev(`(async () => {
      const r = await fetch('/feed.json');
      const j = await r.json();
      return JSON.stringify({ status: r.status, entries: (j.entries || []).length,
        cards: document.querySelectorAll('#feed .moment').length });
    })()`),
  );
  ok('feed.json 可取（/api/feed 已 404）', feed.status === 200, `HTTP ${feed.status}`);
  ok('feed.json 里有动态', feed.entries > 0, `${feed.entries} 条`);
  ok('页面渲染出动态卡片', feed.cards > 0, `${feed.cards} 张`);

  const broken = await ev(`[...document.images].filter((i) => i.src && i.complete && i.naturalWidth === 0).length`);
  ok('无破图', broken === 0, String(broken));
  ok('控制台无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
}

cleanup();
console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log(`\n失败项：\n - ${failures.join('\n - ')}`);
console.log('');
process.exit(fail ? 1 : 0);
