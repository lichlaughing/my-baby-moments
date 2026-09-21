#!/usr/bin/env node
/**
 * 登录界面与访问门禁的自包含验证  ——  node scripts/verify-ui.mjs
 *
 * 为什么单独一个脚本：`verify-auth.mjs` 只打接口，它证明不了
 * 「页面上到底长什么样、点了会发生什么」——而这一轮改的恰恰是界面：
 * 顶栏「登录 / 发布」互斥、登录浮层、发布面板里的署名与退出、
 * 上传遇 401 时自动弹回登录并保留已选文件，以及
 * **未登录时只能看到最新一条 / 整站锁时连内容都不出现**。这些只有真浏览器能验。
 *
 * 做法：自己起一个临时服务（临时照片库 + 临时账号），再用 CDP 驱动真实 Chrome，
 * 走完「匿名 → 登录 → 发布 → 会话过期 → 重新登录接着发 → 退出」整条链路；
 * 最后再用一份 `scope: 'all'` 的配置起第二个服务，验整站门禁那一档。
 *
 * ⚠️ 两个环境前提（都不满足时会明确报错退出，不会静默跳过）：
 *   ① 本机要有 Chrome；找不到就设 CHROME_PATH 指过去。
 *   ② **CDP 需要在非沙箱下运行**。在本项目的开发环境里（macOS + Chrome 150），
 *      沙箱内 Chrome 自身的 sandbox 会 `sandbox initialization failed`，
 *      连带 GPU 进程崩溃，表现为 WS 握手成功但第一句 Page.enable 永久静默超时。
 *      只把 Node 提权不够，脚本里已固定加 `--no-sandbox`；但**外层执行环境同样要非沙箱**。
 *
 * 全程只动 <root>/.cache/verify-ui/（临时照片库 + 临时配置 + 截图），跑完自删。
 * 因为它依赖本机浏览器、且要非沙箱执行，所以**没有**放进 `npm run verify` 默认链，
 * 由 `npm run verify:ui` 单独跑。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.cache/verify-ui');
const MEDIA = path.join(WORK, 'photos');
const CACHE = path.join(WORK, 'cache');
const SHOTS = path.join(WORK, 'shots');
const CONFIG_ABS = path.join(WORK, 'config.mjs');
const CONFIG_REL = path.relative(ROOT, CONFIG_ABS);
/** 第二份配置：整站锁那一档（scope='all'），复用同一份临时照片库 */
const LOCKED_CONFIG_ABS = path.join(WORK, 'config-locked.mjs');
const LOCKED_CONFIG_REL = path.relative(ROOT, LOCKED_CONFIG_ABS);

const TEST_USER = '妈妈';
const TEST_ID = 'mama';
const TEST_PW = 'verify-ui-pass-1234';
/** 与 app.js 里 AUTH_LEAD.all 对应：整站锁形态下的开场白 */
const AUTH_LEAD_ALL = '这个相册需要登录才能查看。';

/* ── 结果统计 ─────────────────────────────────────────────────────── */
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
const note = (t) => console.log(`  · ${t}`);
const section = (t) => console.log(`\n${t}`);

/* ── 硬闸门 ──────────────────────────────────────────────────────────
   下面会对 WORK 做 rm -rf。路径一旦配错（哪怕只是有人手工把 WORK 改到
   ROOT/photos 想「就地测」），删掉的就是真实照片，不可逆。
   注意别写成「MEDIA 是否包含于 WORK」——它俩本来就是父子关系，那种判断恒为真。
   真正要守的是：① WORK 落在 <root>/.cache/ 之内；② WORK 与真实照片库互不包含。 */
const baseConfig = (await import(path.join(ROOT, 'moments.config.mjs'))).default;

const refuses = [];
const isUnder = (child, parent) => {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
};
const CACHE_ROOT = path.join(ROOT, '.cache');
if (!isUnder(WORK, CACHE_ROOT)) refuses.push(`临时工作区 ${WORK} 不在 ${CACHE_ROOT} 之内`);
const realMediaRoot = path.isAbsolute(baseConfig.paths.mediaRoot)
  ? baseConfig.paths.mediaRoot
  : path.join(ROOT, baseConfig.paths.mediaRoot);
if (isUnder(WORK, realMediaRoot) || isUnder(realMediaRoot, WORK)) {
  refuses.push(`临时工作区 ${WORK} 与真实照片库 ${realMediaRoot} 存在包含关系`);
}
if (refuses.length) {
  console.error('\n安全闸门拦下了这次运行：');
  for (const r of refuses) console.error(`  · ${r}`);
  console.error('\n本脚本会 rm -rf 临时工作区，路径不对就会删掉真实照片。');
  process.exit(2);
}

/* ── 找 Chrome ─────────────────────────────────────────────────────── */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
});
if (!chromePath) {
  console.error('\n找不到 Chrome / Chromium，这个脚本没法跑。');
  console.error('设一下环境变量再重跑，例如：');
  console.error('  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run verify:ui\n');
  process.exit(2);
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */
const sharp = (await import('sharp')).default;
const { hashPassword } = await import(path.join(ROOT, 'src/auth.mjs'));

const JPG = path.join(WORK, 'upload.jpg');
const jpegBuf = await sharp({
  create: { width: 640, height: 480, channels: 3, background: { r: 210, g: 160, b: 120 } },
})
  .jpeg({ quality: 82 })
  .toBuffer();

const freePort = () =>
  new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });

/* ── 准备临时工作区 + 临时服务 ─────────────────────────────────────── */
await fsp.rm(WORK, { recursive: true, force: true });
await fsp.mkdir(MEDIA, { recursive: true });
await fsp.mkdir(SHOTS, { recursive: true });
await fsp.writeFile(JPG, jpegBuf);

const PORT = await freePort();
const PORT_LOCKED = await freePort();

/**
 * 写一份临时配置。两份唯一的差别是 auth.scope ——
 * 分别用来验「未登录只见最新一条」（默认档）和「整站要登录」（最严档）。
 *
 * scope 显式写出来，不依赖配置里的默认值：否则哪天默认值一变，
 * 这个脚本会**静默**换掉被测行为，而断言看起来还是全绿。
 */
const writeConfig = (file, { port, scope }) =>
  fs.writeFileSync(
    file,
    `// 由 scripts/verify-ui.mjs 生成，跑完即删
import base from ${JSON.stringify(path.relative(WORK, path.join(ROOT, 'moments.config.mjs')))};
export default {
  ...base,
  paths: { ...base.paths, mediaRoot: ${JSON.stringify(path.relative(ROOT, MEDIA))} },
  thumbs: { ...base.thumbs, cacheDir: ${JSON.stringify(path.relative(ROOT, CACHE))} },
  auth: {
    ...base.auth,
    enabled: true,
    secret: 'verify-ui-secret',
    secure: null,
    scope: ${JSON.stringify(scope)},
    previewCount: 1,
    // 口令哈希在这里现生成：不把哈希写死在仓库里，换了 scrypt 参数也不会悄悄失效
    users: [{ id: ${JSON.stringify(TEST_ID)}, name: ${JSON.stringify(TEST_USER)}, passwordHash: ${JSON.stringify(hashPassword(TEST_PW))} }],
  },
  upload: { ...base.upload, enabled: true, naming: 'time' },
  server: { ...base.server, port: ${port}, host: '127.0.0.1', watch: false },
};
`,
  );

writeConfig(CONFIG_ABS, { port: PORT, scope: 'latest' });
// 整站锁那一档共用同一份照片库/缓存：起在别的端口，用不同的 scope 再跑一遍
writeConfig(LOCKED_CONFIG_ABS, { port: PORT_LOCKED, scope: 'all' });

const BASE = `http://127.0.0.1:${PORT}`;
const BASE_LOCKED = `http://127.0.0.1:${PORT_LOCKED}`;

const serverLog = [];
const childProcs = [];
const startServer = (configRel) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'src/cli.mjs'), 'serve', '--config', configRel], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => serverLog.push(d.toString()));
  p.stderr.on('data', (d) => serverLog.push(d.toString()));
  childProcs.push(p);
  return p;
};
const server = startServer(CONFIG_REL);
const killChildren = () => {
  for (const p of childProcs) {
    if (p && !p.killed) {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
    }
  }
};

/**
 * @param keepShots 失败时保留截图 —— 出问题的时候，截图是最有用的线索，
 *                  跟脚本一起删掉等于把证据也销毁了。成功时才整个清干净。
 */
const cleanup = async (keepShots = false) => {
  killChildren();
  if (keepShots) {
    // 只删临时库与浏览器 profile，把 shots/ 留在原地给人看
    for (const name of ['photos', 'cache', 'chrome-profile', 'config.mjs', 'config-locked.mjs', 'upload.jpg']) {
      await fsp.rm(path.join(WORK, name), { recursive: true, force: true });
    }
    return;
  }
  await fsp.rm(WORK, { recursive: true, force: true });
};

process.on('exit', killChildren);

/** 轮询等服务起来。两个服务（默认档 / 整站锁档）都用它。 */
const waitHttp = async (url, tries = 80) => {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

const ready = await waitHttp(`${BASE}/api/session`);

if (!ready) {
  console.error(`\n临时服务起不来：\n${serverLog.join('').split('\n').slice(-15).join('\n')}`);
  await cleanup();
  process.exit(2);
}

section('0. 临时服务就绪');
ok('GET /api/session 可用', ready.ok === true, JSON.stringify(ready));
ok('authRequired = true', ready.authRequired === true, JSON.stringify(ready));
ok("readScope = 'latest'（配置里显式指定，不靠默认值）", ready.readScope === 'latest', JSON.stringify(ready.readScope));
ok('账号已配置（configured）', ready.configured === true, JSON.stringify(ready));
ok('当前匿名（user = null）', ready.user === null, JSON.stringify(ready.user));

/* ── 起 Chrome（非沙箱 CDP）─────────────────────────────────────────── */
const PROFILE = path.join(WORK, 'chrome-profile');

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const raw = ev.data;
      // undici 的 WebSocket 事件里 data 不保证是字符串；JSON.parse 抛错会被事件回调吞掉，
      // 现象和「静默超时」一模一样，所以这里显式兜一下
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} 超时（多半是 Chrome 崩了或没在非沙箱下运行）`));
        }
      }, 20000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  async waitFor(expr, ms = 12000, label = expr) {
    const t0 = Date.now();
    for (;;) {
      try {
        if (await this.evaluate(expr)) return true;
      } catch {
        /* 页面可能正在导航 */
      }
      if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  async shot(name) {
    // send() 已经解包到 msg.result，所以这里直接取 data，不要再点一层 .result
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(SHOTS, `${name}.png`);
    await fsp.writeFile(f, Buffer.from(data, 'base64'));
    return f;
  }
}

const chromeArgs = [
  '--headless=new',
  `--user-data-dir=${PROFILE}`,
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  // 本机实测：Chrome 自带 sandbox 会 `sandbox initialization failed: Operation not permitted`，
  // 连带 GPU 进程崩溃，症状是 WS 握手成功但零帧回包。
  '--no-sandbox',
  // 环境里有 HTTP_PROXY 时 Chrome 会把 127.0.0.1 也走代理，
  // 导航落到 chrome-error://chromewebdata/，所有探针读到 null
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
  'about:blank',
];
const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
childProcs[1] = chrome;
const chromeErr = [];
chrome.stderr.on('data', (d) => chromeErr.push(d.toString()));
chrome.stdout.on('data', () => {
  /* 丢弃，避免管道写满阻塞 */
});

const debugPort = await (async () => {
  const f = path.join(PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < 80; i += 1) {
    try {
      const txt = await fsp.readFile(f, 'utf8');
      const p = Number(txt.split('\n')[0]);
      if (Number.isInteger(p) && p > 0) return p;
    } catch {
      /* 还没写出来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})();

if (!debugPort) {
  console.error(`\nChrome 没暴露调试端口：\n${chromeErr.join('').slice(-800)}`);
  await cleanup();
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!pageTarget) {
  console.error(`\n没找到 page target：${JSON.stringify(targets).slice(0, 300)}`);
  await cleanup();
  process.exit(2);
}

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
});
const cdp = new Cdp(ws);

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');
} catch (err) {
  console.error(`\nCDP 通道打不通：${err.message}`);
  console.error('若提示 Page.enable 超时，请确认本进程是在**非沙箱**环境下运行的。\n');
  await cleanup();
  process.exit(2);
}

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 900,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
});
await cdp.send('Network.clearBrowserCookies');

const HELPERS = `
  window.__t = (s) => document.querySelector(s);
  window.__vis = (s) => { const el = window.__t(s); if (!el) return 'missing';
    const c = getComputedStyle(el);
    return (c.display !== 'none' && c.visibility !== 'hidden') ? 'visible' : 'hidden'; };
  window.__txt = (s) => (window.__t(s)?.textContent || '').trim();
  window.__set = (s, v) => { const el = window.__t(s); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true })); };
  'ok';
`;

const loadPage = async (url = BASE) => {
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor(`document.readyState === 'complete'`, 20000, '页面加载');
  await cdp.evaluate(HELPERS);
};
const pickFile = async (selector) => {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [JPG] });
};

/* ══════════════════════════════════════════════════════════════════
   1. 匿名：顶栏只出现「登录」，看照片不需要登录
   ══════════════════════════════════════════════════════════════════ */
section('1. 匿名状态');
await loadPage();
await cdp.waitFor(`window.__vis('#open-auth') === 'visible'`, 12000, '登录按钮出现');
ok('「登录」按钮可见', (await cdp.evaluate(`window.__vis('#open-auth')`)) === 'visible');
ok('「发布」按钮隐藏（两者互斥）', (await cdp.evaluate(`window.__vis('#open-publish')`)) === 'hidden');
ok('按钮文案是「登录」', (await cdp.evaluate(`window.__txt('#open-auth').replace(/\\s+/g,'')`)) === '登录');
ok('页面本身匿名可读（有 feed 容器）', await cdp.evaluate(`!!window.__t('#feed')`));
ok('登录浮层默认关闭', (await cdp.evaluate(`window.__vis('#login')`)) === 'hidden');
note(`截图 ${await cdp.shot('01-anonymous')}`);

/* ══════════════════════════════════════════════════════════════════
   2. 登录浮层的交互细节
   ══════════════════════════════════════════════════════════════════ */
section('2. 登录浮层');
await cdp.evaluate(`window.__t('#open-auth').click()`);
await cdp.waitFor(`window.__vis('#login') === 'visible'`, 5000, '登录浮层出现');
ok('浮层可见', (await cdp.evaluate(`window.__vis('#login')`)) === 'visible');
ok('焦点落在账号输入框', (await cdp.evaluate(`document.activeElement?.id`)) === 'auth-user');

await cdp.evaluate(`window.__set('#auth-pass','abc')`);
ok('口令默认打码', (await cdp.evaluate(`window.__t('#auth-pass').type`)) === 'password');
await cdp.evaluate(`window.__t('#auth-reveal').click()`);
ok('点「显示口令」后变明文', (await cdp.evaluate(`window.__t('#auth-pass').type`)) === 'text');
ok('aria-pressed 同步为 true', (await cdp.evaluate(`window.__t('#auth-reveal').getAttribute('aria-pressed')`)) === 'true');
ok('图标换成 eye-slash', (await cdp.evaluate(`window.__t('#auth-reveal use').getAttribute('href')`)) === '#i-eye-slash');
await cdp.evaluate(`window.__t('#auth-reveal').click()`);
ok('再点一次回到打码', (await cdp.evaluate(`window.__t('#auth-pass').type`)) === 'password');
note(`截图 ${await cdp.shot('02-login-panel')}`);

/* ══════════════════════════════════════════════════════════════════
   3. 口令错：提示不区分「账号不存在 / 口令错」
   ══════════════════════════════════════════════════════════════════ */
section('3. 口令错误');
await cdp.evaluate(`window.__set('#auth-user','妈妈'); window.__set('#auth-pass','不对的')`);
await cdp.evaluate(`window.__t('#auth-submit').click()`);
await cdp.waitFor(`window.__t('#auth-note').classList.contains('is-error')`, 8000, '错误提示出现');
ok(
  '提示文案是「账号或密码不对」（不泄露账号是否存在）',
  (await cdp.evaluate(`window.__txt('#auth-note')`)) === '账号或密码不对',
  await cdp.evaluate(`window.__txt('#auth-note')`),
);
ok('浮层仍打开，输入内容保留', (await cdp.evaluate(`window.__vis('#login')`)) === 'visible');
ok('顶栏没有误切成「发布」', (await cdp.evaluate(`window.__vis('#open-publish')`)) === 'hidden');
note(`截图 ${await cdp.shot('03-login-error')}`);

/* ══════════════════════════════════════════════════════════════════
   4. 登录成功：按钮互换 + 发布面板自动打开 + 署名可见
   ══════════════════════════════════════════════════════════════════ */
section('4. 登录成功');
await cdp.evaluate(`window.__set('#auth-pass','${TEST_PW}')`);
await cdp.evaluate(`window.__t('#auth-submit').click()`);
await cdp.waitFor(`window.__vis('#open-publish') === 'visible'`, 10000, '发布按钮出现');
ok('「发布」按钮出现', (await cdp.evaluate(`window.__vis('#open-publish')`)) === 'visible');
ok('「登录」按钮隐藏', (await cdp.evaluate(`window.__vis('#open-auth')`)) === 'hidden');
ok('登录浮层已关闭', (await cdp.evaluate(`window.__vis('#login')`)) === 'hidden');

await cdp.waitFor(`window.__vis('#publish') === 'visible'`, 5000, '发布面板自动打开');
ok('发布面板自动打开（登录后少点一次）', (await cdp.evaluate(`window.__vis('#publish')`)) === 'visible');
const who = await cdp.evaluate(`window.__txt('#pub-who')`);
ok('底部显示「以 妈妈 的身份发布」', who.includes('以 妈妈 的身份发布'), who);
ok('署名行里有「退出」入口', who.includes('退出'), who);
note(`截图 ${await cdp.shot('04-logged-in')}`);

/* ══════════════════════════════════════════════════════════════════
   5. 发布：卡片带署名
   ══════════════════════════════════════════════════════════════════ */
section('5. 发布一条动态');
await pickFile('#pub-file');
await cdp.waitFor(`/已选 1 个/.test(window.__txt('#pub-count'))`, 8000, '选中文件');
ok('选中 1 个文件并显示体积', /已选 1 个/.test(await cdp.evaluate(`window.__txt('#pub-count')`)), await cdp.evaluate(`window.__txt('#pub-count')`));

await cdp.evaluate(`window.__set('#pub-title','春游'); window.__set('#pub-caption','今天去公园了')`);
await cdp.evaluate(`window.__t('#pub-submit').click()`);
await cdp.waitFor(`window.__vis('#publish') === 'hidden'`, 25000, '发布面板关闭');
ok('发布成功后自动关闭', (await cdp.evaluate(`window.__vis('#publish')`)) === 'hidden');

await cdp.waitFor(`!!window.__t('.moment__author')`, 15000, '卡片出现署名');
ok('动态卡片显示署名「妈妈」', (await cdp.evaluate(`window.__txt('.moment__author')`)) === '妈妈', await cdp.evaluate(`window.__txt('.moment__author')`));
ok(
  '署名带账号提示（title 里有 authorId）',
  (await cdp.evaluate(`window.__t('.moment__author').getAttribute('title')`)).includes(TEST_ID),
  await cdp.evaluate(`window.__t('.moment__author').getAttribute('title')`),
);
ok('标题渲染正确', (await cdp.evaluate(`window.__txt('.moment__title')`)) === '春游');
ok('文案渲染正确', (await cdp.evaluate(`window.__txt('.moment__caption')`)) === '今天去公园了');
note(`截图 ${await cdp.shot('05-published')}`);

/* ══════════════════════════════════════════════════════════════════
   6. 会话过期（401）：回登录，已选文件与已填内容都不丢
   ══════════════════════════════════════════════════════════════════ */
section('6. 上传时会话过期（401）');
await cdp.evaluate(`window.__t('#open-publish').click()`);
await cdp.waitFor(`window.__vis('#publish') === 'visible'`, 5000, '发布面板打开');
await pickFile('#pub-file');
await cdp.waitFor(`/已选 1 个/.test(window.__txt('#pub-count'))`, 8000, '选中文件');
await cdp.evaluate(`window.__set('#pub-title','第二次'); window.__set('#pub-caption','不能白填')`);
ok('输入已就位（前置条件）', (await cdp.evaluate(`window.__t('#pub-title').value`)) === '第二次');

// 清掉会话 Cookie，模拟"离开太久 / 在别处退出了"
await cdp.send('Network.clearBrowserCookies');
ok(
  '清掉 Cookie 后服务端确实认不出身份（前置条件成立）',
  (await (await fetch(`${BASE}/api/session`)).json()).user === null,
);

await cdp.evaluate(`window.__t('#pub-submit').click()`);
await cdp.waitFor(`window.__vis('#login') === 'visible'`, 15000, '自动弹回登录');
ok('上传被拒后自动弹回登录面板', (await cdp.evaluate(`window.__vis('#login')`)) === 'visible');
const expiredNote = await cdp.evaluate(`window.__txt('#auth-note')`);
ok('提示说明是会话过期、文件还在', expiredNote.includes('过期') && expiredNote.includes('文件还在'), expiredNote);
ok('发布面板已收起', (await cdp.evaluate(`window.__vis('#publish')`)) === 'hidden');
ok('顶栏换回「登录」', (await cdp.evaluate(`window.__vis('#open-auth')`)) === 'visible');
note(`截图 ${await cdp.shot('06-session-expired')}`);

/* ══════════════════════════════════════════════════════════════════
   7. 重新登录 → 那批文件与已填内容原样接上
   ══════════════════════════════════════════════════════════════════ */
section('7. 重新登录后接着发');
await cdp.evaluate(`window.__set('#auth-user','妈妈'); window.__set('#auth-pass','${TEST_PW}')`);
await cdp.evaluate(`window.__t('#auth-submit').click()`);
await cdp.waitFor(`window.__vis('#publish') === 'visible'`, 12000, '发布面板重开');
ok('登录后面板重新打开', (await cdp.evaluate(`window.__vis('#publish')`)) === 'visible');
ok(
  '刚选的文件还在（没让用户重选）',
  /已选 1 个/.test(await cdp.evaluate(`window.__txt('#pub-count')`)),
  await cdp.evaluate(`window.__txt('#pub-count')`),
);
ok('已填的标题还在', (await cdp.evaluate(`window.__t('#pub-title').value`)) === '第二次', await cdp.evaluate(`window.__t('#pub-title').value`));
ok('已填的文案还在', (await cdp.evaluate(`window.__t('#pub-caption').value`)) === '不能白填', await cdp.evaluate(`window.__t('#pub-caption').value`));

await cdp.evaluate(`window.__t('#pub-submit').click()`);
await cdp.waitFor(`window.__vis('#publish') === 'hidden'`, 25000, '第二次发布完成');
await cdp.waitFor(`document.querySelectorAll('.moment__author').length >= 2`, 15000, '两条署名');
ok('两条动态都带署名', (await cdp.evaluate(`document.querySelectorAll('.moment__author').length`)) >= 2);
ok(
  '接上的那次发布确实落盘了',
  (await cdp.evaluate(`[...document.querySelectorAll('.moment__title')].map(e=>e.textContent)`)).includes('第二次'),
  await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('.moment__title')].map(e=>e.textContent))`),
);

/* ══════════════════════════════════════════════════════════════════
   8. 退出登录
   ══════════════════════════════════════════════════════════════════ */
section('8. 退出登录');
await cdp.evaluate(`window.__t('#open-publish').click()`);
await cdp.waitFor(`window.__vis('#publish') === 'visible'`, 5000, '发布面板打开');
await cdp.evaluate(`window.__t('#pub-who .linkbtn').click()`);
await cdp.waitFor(`window.__vis('#open-auth') === 'visible'`, 10000, '换回登录按钮');
ok('退出后顶栏换回「登录」', (await cdp.evaluate(`window.__vis('#open-auth')`)) === 'visible');
ok('「发布」按钮隐藏', (await cdp.evaluate(`window.__vis('#open-publish')`)) === 'hidden');
ok('发布面板已关闭', (await cdp.evaluate(`window.__vis('#publish')`)) === 'hidden');
ok('Cookie 已被清掉', (await (await fetch(`${BASE}/api/session`)).json()).user === null);
note(`截图 ${await cdp.shot('07-logged-out-again')}`);

/* ══════════════════════════════════════════════════════════════════
   8b. 退出之后：未登录只能看到最新一条（scope='latest' 的默认档）
   ══════════════════════════════════════════════════════════════════
   库里已经有两条（上面发的「春游」和「第二次」）。
   退出去之后必须只剩一条，并且**明说**"你看到的不是全部" ——
   不说的话，用户会以为家里就一条动态，然后怀疑照片丢了。 */
section('8b. 退出后只剩最新一条');
await cdp.waitFor(`document.querySelectorAll('#feed .moment').length === 1`, 12000, '只剩一张卡片');
ok(
  '只渲染了 1 张卡片',
  (await cdp.evaluate(`document.querySelectorAll('#feed .moment').length`)) === 1,
  await cdp.evaluate(`document.querySelectorAll('#feed .moment').length`),
);
ok(
  '显示的是最新那条（后发的「第二次」）',
  (await cdp.evaluate(`window.__txt('.moment__title')`)) === '第二次',
  await cdp.evaluate(`window.__txt('.moment__title')`),
);
await cdp.waitFor(`!!window.__t('#notice')`, 8000, '出现提示条');
ok(
  '提示条说明"只显示了最新的一条"',
  (await cdp.evaluate(`window.__txt('#notice .notice__title')`)) === '只显示了最新的一条',
  await cdp.evaluate(`window.__txt('#notice .notice__title')`),
);
ok(
  '提示条里有「登录查看全部」的入口',
  (await cdp.evaluate(`window.__txt('#notice .notice__cta')`)) === '登录查看全部',
  await cdp.evaluate(`window.__txt('#notice .notice__cta')`),
);
// 服务端裁掉的条目，前端连 URL 都不该拿到
ok(
  '接口层也只有 1 条（不是前端藏起来的）',
  (await (await fetch(`${BASE}/api/feed?refresh=1`)).json()).entries.length === 1,
);
const anonFeed = await (await fetch(`${BASE}/api/feed?refresh=1`)).json();
ok('preview.limited = true', anonFeed.preview?.limited === true, JSON.stringify(anonFeed.preview));
ok('stats 也只算可见部分（不泄露"总共几条"）', anonFeed.stats?.entries === 1, JSON.stringify(anonFeed.stats));
ok('未登录不连 SSE（省一个注定 401 的长连接）', (await (await fetch(`${BASE}/api/events`)).status) === 401);
note(`截图 ${await cdp.shot('08-preview-limited')}`);

/* ══════════════════════════════════════════════════════════════════
   9. 移动端：两个面板都是贴底抽屉，不再多占一个按钮位
   ══════════════════════════════════════════════════════════════════ */
section('9. 移动端（390×844）');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await loadPage();
await cdp.waitFor(`window.__vis('#open-auth') === 'visible'`, 12000, '移动端登录按钮出现');

const innerH = await cdp.evaluate(`window.innerHeight`);
const topbarBtns = JSON.parse(
  await cdp.evaluate(
    `JSON.stringify([...document.querySelectorAll('.topbar__actions > *')]
      .filter(b => b.tagName === 'BUTTON')
      .map(b => ({ id: b.id, w: Math.round(b.getBoundingClientRect().width),
                   h: Math.round(b.getBoundingClientRect().height),
                   d: getComputedStyle(b).display })))`,
  ),
);
const visibleBtns = topbarBtns.filter((b) => b.d !== 'none');
note(`顶栏可见按钮：${visibleBtns.map((b) => b.id).join(', ')}`);
ok('登录/发布不会同时出现', !(visibleBtns.some((b) => b.id === 'open-auth') && visibleBtns.some((b) => b.id === 'open-publish')));
ok(
  '可见按钮都是 34×34 的正圆（小屏压成纯图标）',
  visibleBtns.every((b) => b.w === 34 && b.h === 34),
  JSON.stringify(visibleBtns),
);
ok('按钮数量不超过 3 个（不挤爆顶栏）', visibleBtns.length <= 3, String(visibleBtns.length));

await cdp.evaluate(`window.__t('#open-auth').click()`);
await cdp.waitFor(`window.__vis('#login') === 'visible'`, 5000, '移动端登录浮层');
const loginRect = JSON.parse(
  await cdp.evaluate(`JSON.stringify(window.__t('#login .sheet__panel').getBoundingClientRect().toJSON())`),
);
ok(
  `登录面板贴底（bottom=${Math.round(loginRect.bottom)} / innerHeight=${innerH}）`,
  Math.abs(loginRect.bottom - innerH) <= 1,
  `${Math.round(loginRect.bottom)} vs ${innerH}`,
);
ok('登录面板占满宽度', Math.abs(loginRect.width - 390) <= 1, String(Math.round(loginRect.width)));
note(`截图 ${await cdp.shot('08-mobile-login')}`);

/* ══════════════════════════════════════════════════════════════════
   10. 整站锁（scope='all'）：未登录连内容都不出现
   ══════════════════════════════════════════════════════════════════
   另起一个服务（同一份照片库、同一个账号，只把 scope 换成 'all'）——
   scope 是启动期配置，改它必须重启，这也正是真实的用法。
   重点验三件事：① 门禁关不掉；② 被收起的区域里**没有**照片；
   ③ 登录之后一切恢复。 */
section("10. 整站锁（scope='all'）");
{
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  });
  startServer(LOCKED_CONFIG_REL);
  const lockedReady = await waitHttp(`${BASE_LOCKED}/api/session`);
  ok('第二个服务（scope=all）起来了', !!lockedReady, serverLog.join('').split('\n').slice(-6).join(' | '));
  ok("readScope = 'all'", lockedReady?.readScope === 'all', JSON.stringify(lockedReady?.readScope));

  await cdp.send('Network.clearBrowserCookies');
  await loadPage(BASE_LOCKED);
  await cdp.waitFor(`window.__vis('#login') === 'visible'`, 12000, '门禁面板自动出现');

  ok('门禁面板自动打开（不用点任何东西）', (await cdp.evaluate(`window.__vis('#login')`)) === 'visible');
  ok('面板带 is-forced 标记', await cdp.evaluate(`window.__t('#login').classList.contains('is-forced')`));
  ok('body 带 is-gated 标记', await cdp.evaluate(`document.body.classList.contains('is-gated')`));
  ok(
    '开场白说的是"需要登录才能查看"',
    (await cdp.evaluate(`window.__txt('#auth-lead')`)) === AUTH_LEAD_ALL,
    await cdp.evaluate(`window.__txt('#auth-lead')`),
  );

  // 关不掉：×、取消、遮罩、Esc 四条路都必须无效
  ok('「关闭」按钮被收起', (await cdp.evaluate(`getComputedStyle(window.__t('#auth-close')).display`)) === 'none');
  ok('「取消」按钮被收起', (await cdp.evaluate(`getComputedStyle(window.__t('#auth-cancel')).display`)) === 'none');
  await cdp.evaluate(`window.__t('#login .sheet__scrim').click()`);
  ok('点遮罩关不掉', (await cdp.evaluate(`window.__vis('#login')`)) === 'visible');
  await cdp.evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  ok('按 Esc 关不掉', (await cdp.evaluate(`window.__vis('#login')`)) === 'visible');

  // 顶栏两个按钮都该收起来：登录框已经占着整屏了
  ok('顶栏「登录」按钮收起', (await cdp.evaluate(`window.__vis('#open-auth')`)) === 'hidden');
  ok('顶栏「发布」按钮收起', (await cdp.evaluate(`window.__vis('#open-publish')`)) === 'hidden');

  // 关键：照片必须真的不在 DOM 里，而不只是被盖住
  ok(
    '页面上没有任何动态卡片',
    (await cdp.evaluate(`document.querySelectorAll('#feed .moment').length`)) === 0,
    await cdp.evaluate(`document.querySelectorAll('#feed .moment').length`),
  );
  ok(
    '内容区域整体被收起（cover/page/footer 都是 none）',
    (await cdp.evaluate(
      `['.cover','.page','.footer'].every(s => getComputedStyle(window.__t(s)).display === 'none')`,
    )) === true,
  );
  ok(
    '整个 DOM 里没有任何 /media 或 /thumb 地址残留（不是只盖住，是真没有了）',
    !/\/media\/|\/thumb\//.test(await cdp.evaluate(`document.body.innerHTML`)),
  );
  // 接口层也要挡住（前端不加载 ≠ 服务端不给）
  ok('接口层：匿名 feed → 401', (await (await fetch(`${BASE_LOCKED}/api/feed`)).status) === 401);
  ok('接口层：匿名缩略图 → 401', (await (await fetch(`${BASE_LOCKED}/thumb/x/grid/y.webp`)).status) === 401);
  ok('页面骨架本身仍可取（否则登录框自己都渲染不出来）', (await (await fetch(BASE_LOCKED)).status) === 200);
  note(`截图 ${await cdp.shot('09-site-locked')}`);

  // 登录之后：门禁收起、内容回来、发布按钮出现
  await cdp.evaluate(`window.__set('#auth-user','${TEST_USER}'); window.__set('#auth-pass','${TEST_PW}')`);
  await cdp.evaluate(`window.__t('#auth-submit').click()`);
  await cdp.waitFor(`window.__vis('#login') === 'hidden'`, 15000, '门禁收起');
  ok('登录后门禁收起', (await cdp.evaluate(`window.__vis('#login')`)) === 'hidden');
  ok('body 上的 is-gated 被摘掉', (await cdp.evaluate(`document.body.classList.contains('is-gated')`)) === false);
  await cdp.waitFor(`document.querySelectorAll('#feed .moment').length >= 2`, 15000, '内容回来了');
  ok(
    '登录后能看到全部（≥2 条，不是只剩最新一条）',
    (await cdp.evaluate(`document.querySelectorAll('#feed .moment').length`)) >= 2,
    await cdp.evaluate(`document.querySelectorAll('#feed .moment').length`),
  );
  ok('没有误开「让未登录的人看 1 条」的提示', (await cdp.evaluate(`!window.__t('#notice')`)) === true);
  ok('顶栏换成「发布」', (await cdp.evaluate(`window.__vis('#open-publish')`)) === 'visible');
  ok('顶栏「登录」收起', (await cdp.evaluate(`window.__vis('#open-auth')`)) === 'hidden');
  // 走完门禁登录之后，不该顺手把发布面板怼到脸上（用户是来看的，不是来发的）
  ok('没有顺手打开发布面板', (await cdp.evaluate(`window.__vis('#publish')`)) === 'hidden');
  note(`截图 ${await cdp.shot('10-locked-after-login')}`);
}

/* ── 收尾 ─────────────────────────────────────────────────────────── */
ws.close();
await cleanup(fail > 0);

console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log(`\n失败项：\n - ${failures.join('\n - ')}`);
if (fail) console.log(`\n临时工作区保留（含截图）：${path.relative(ROOT, SHOTS)}/`);
else console.log('临时工作区已清理：.cache/verify-ui（真实 photos/ 全程未被触碰）');
console.log('');
process.exit(fail ? 1 : 0);
