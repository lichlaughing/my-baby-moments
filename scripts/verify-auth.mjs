#!/usr/bin/env node
/**
 * 账号认证的自包含验证  ——  node scripts/verify-auth.mjs
 *
 * 为什么单独一个脚本：鉴权是「静默失效」重灾区 —— 少了同源校验、Cookie 少了
 * HttpOnly、限流没生效、未登录也能传…… 这些都不会让任何页面报错，只会让门悄悄开着。
 * 所以把断言固化下来，改完 src/auth.mjs / src/server.mjs 跑一遍就有底。
 *
 * 覆盖：
 *   A 会话与登录（Cookie 属性、篡改、过期、续期）
 *   B 上传鉴权（未登录 401、署名写进 meta.json 并出现在 feed 里、换人署名跟着换）
 *   C 登录限流
 *   D 没配账号时不静默放行（读侧写侧都是 503，不是 401）
 *   E 关闭认证时全开
 *   F 读侧鉴权（auth.scope 三档：未登录能读到什么、被裁掉的媒体是不是真的取不到）
 *
 * 全程只动 <root>/.cache/verify-auth/，跑完自删，绝不碰 photos/。开头有硬闸门。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.cache/verify-auth');
const TMP_MEDIA = path.join(WORK, 'photos');
const TMP_CACHE = path.join(WORK, 'cache');
const TEST_DATE = '1998-02-03';

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
const section = (t) => console.log(`\n${t}`);

/* ── 硬闸门（与 verify-upload.mjs 同一套不变量） ──────────────────────
   下面会对 WORK 做 rm -rf。守两条：
     ① WORK 落在 <root>/.cache/ 之内；
     ② WORK 与真实照片库互不包含。
   别写成「TMP_MEDIA 包含于 WORK」—— 那是父子关系，恒为真，等于没写。 */
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
  console.error('\n本脚本会 rm -rf 临时工作区，路径不对就会删掉真实照片。请修正后再跑。');
  process.exit(2);
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */
const { createAuth, hashPassword } = await import(path.join(ROOT, 'src/auth.mjs'));
const sharp = (await import('sharp')).default;

const SECRET = 'verify-auth-secret-不要用于生产-0123456789';
const PW_MAMA = 'mama-口令-1';
const PW_BABA = 'baba-口令-2';
const USER_MAMA = { id: 'mama', name: '妈妈', passwordHash: hashPassword(PW_MAMA), aliases: ['宝妈'] };
const USER_BABA = { id: 'baba', name: '爸爸', passwordHash: hashPassword(PW_BABA) };

const JPG = await sharp({
  create: { width: 200, height: 150, channels: 3, background: { r: 90, g: 140, b: 60 } },
})
  .jpeg({ quality: 80 })
  .toBuffer();

/* ── 起服务 ───────────────────────────────────────────────────────── */
await fsp.rm(WORK, { recursive: true, force: true });
await fsp.mkdir(path.join(TMP_MEDIA, TEST_DATE), { recursive: true });

const writeConfig = (file, { users, authOn, scope = 'latest' }) => {
  fs.writeFileSync(
    path.join(WORK, file),
    `// 由 scripts/verify-auth.mjs 生成，跑完即删
import base from ${JSON.stringify(path.relative(WORK, path.join(ROOT, 'moments.config.mjs')))};
export default {
  ...base,
  paths: { ...base.paths, mediaRoot: ${JSON.stringify(path.relative(ROOT, TMP_MEDIA))} },
  thumbs: { ...base.thumbs, cacheDir: ${JSON.stringify(path.relative(ROOT, TMP_CACHE))} },
  upload: { ...base.upload, enabled: true, maxFiles: 4, maxFileMB: 25 },
  auth: {
    enabled: ${authOn},
    secret: ${JSON.stringify(SECRET)},
    sessionDays: 30,
    scope: ${JSON.stringify(scope)},
    previewCount: 1,
    maxAttempts: ${AUTH_MAX_ATTEMPTS},
    windowMinutes: 10,
    users: ${JSON.stringify(users)},
  },
  server: { ...base.server, watch: false },
};
`,
  );
};
const AUTH_MAX_ATTEMPTS = 4;

// 主服务走默认档（scope='latest'）：未登录只见最新一条。
// 另外两个只用来验「更严」和「更松」两档 —— 它们起在别的端口，共用同一份临时照片库。
writeConfig('config.mjs', { users: [USER_MAMA, USER_BABA], authOn: true });
writeConfig('config-nousers.mjs', { users: [], authOn: true });
writeConfig('config-off.mjs', { users: [], authOn: false });
writeConfig('config-all.mjs', { users: [USER_MAMA], authOn: true, scope: 'all' });
writeConfig('config-open.mjs', { users: [USER_MAMA], authOn: true, scope: 'upload' });

const freePort = () =>
  new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });

const servers = [];
function startServer(configFile) {
  const child = { out: '', dead: false, proc: null, base: '' };
  servers.push(child);
  return freePort().then((port) => {
    child.base = `http://127.0.0.1:${port}`;
    child.proc = spawn(
      process.execPath,
      [
        path.join(ROOT, 'src/cli.mjs'),
        'serve',
        `--config=${path.relative(ROOT, path.join(WORK, configFile))}`,
        `--port=${port}`,
        '--no-watch',
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.proc.stdout.on('data', (d) => (child.out += d.toString()));
    child.proc.stderr.on('data', (d) => (child.out += d.toString()));
    return child;
  });
}

const stopAll = () => {
  for (const s of servers) {
    if (s.dead) continue;
    s.dead = true;
    try {
      s.proc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
};
process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

async function waitReady(child, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${child.base}/api/session`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const main = await startServer('config.mjs');
if (!(await waitReady(main))) {
  console.error(`\n临时服务起不来（${main.base}）：\n${main.out.split('\n').slice(-15).join('\n')}`);
  stopAll();
  await fsp.rm(WORK, { recursive: true, force: true });
  process.exit(2);
}

/* ── HTTP 小工具 ──────────────────────────────────────────────────── */

/**
 * HTTP 头只能是 latin1 字节串。一旦把中文塞进 Cookie，
 * undici 会在发出请求前抛 `Cannot convert argument to a ByteString ...`——
 * 堆栈指向 fetch 而非调用处，极易被误读成"服务端炸了"。
 * 这里在发送前拦一道，把错误定位到真正的调用点。
 */
const assertHeaderSafe = (label, value) => {
  if (value == null) return;
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 255) {
      throw new Error(
        `${label} 含有非 latin1 字符（第 ${i} 位是「${s[i]}」）。` +
          `HTTP 头不能带中文 —— 若想测"乱码"，请改用 ASCII 垃圾串。`,
      );
    }
  }
};

const login = async (base, user, password, { header = true, origin } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (header) headers['X-BM-Auth'] = '1';
  if (origin) headers.Origin = origin;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user, password }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 可能空响应 */
  }
  return { status: res.status, body, setCookie: res.headers.get('set-cookie') || '' };
};

const session = async (base, cookie) => {
  assertHeaderSafe('session() 的 cookie', cookie);
  const res = await fetch(`${base}/api/session`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') || '' };
};

/**
 * 通用 GET，用来打读侧接口（feed / thumb / media / 页面 / assets）。
 * 不预设响应是 JSON —— 媒体接口回的是二进制，回 401 时才是 JSON。
 */
const get = async (base, urlPath, cookie) => {
  // 上游断言挂掉时 urlPath 会是 undefined。与其抛一句 "Failed to parse URL ...undefined"
  // 把人引到 undici 的堆栈里，不如直接把话说清楚。
  if (!urlPath) throw new Error(`get() 收到的 urlPath 是空的（${urlPath}）—— 多半是上游那条断言已经失败了`);
  assertHeaderSafe('get() 的 cookie', cookie);
  const res = await fetch(`${base}${urlPath}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    /* 不是 JSON（图片字节、HTML）就当没有 body */
  }
  return {
    status: res.status,
    headers: res.headers,
    body,
    bytes: buf.length,
    type: res.headers.get('content-type') || '',
    // 只有文本类响应才留字符串，图片字节不转（免得白占内存）
    text: /text|json/i.test(res.headers.get('content-type') || '') ? buf.toString('utf8') : '',
  };
};

/**
 * 只取状态码就断开。专给 SSE（/api/events）用 ——
 * 它永远不会主动结束响应，走 get() 会一直等下去（表现为脚本静默挂死）。
 */
const statusOnly = async (base, urlPath, cookie, ms = 4000) => {
  assertHeaderSafe('statusOnly() 的 cookie', cookie);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${base}${urlPath}`, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: ac.signal,
    });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
    ac.abort(); // 拿到状态码就够了，别把连接留在那儿
  }
};

/** 从页面 HTML 里取出注入的站点配置（取不到就回 null，让断言去报） */
const siteConfigOf = (html) => {
  const m = /<script id="site-config" type="application\/json">([\s\S]*?)<\/script>/.exec(html || '');
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};

const upload = async (base, { cookie, files = [], fields = {}, headers = {} } = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) {
    fd.append('files', new Blob([f.buf], { type: f.type || 'application/octet-stream' }), f.name);
  }
  const h = { 'X-BM-Upload': '1', ...headers };
  assertHeaderSafe('upload() 的 cookie', cookie);
  if (cookie) h.Cookie = cookie;
  const res = await fetch(`${base}/api/upload`, { method: 'POST', body: fd, headers: h });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 可能空响应 */
  }
  return { status: res.status, body };
};

/** 用与服务端相同的密钥自己签一个 token —— 用来测"过期"和"续期"这两条只有时间能触发的路径 */
const signToken = ({ u, name, exp }) => {
  const key = crypto.createHash('sha256').update(`bm-session:${SECRET}`).digest();
  const body = Buffer.from(
    JSON.stringify({ v: 1, u, n: name, iat: Date.now(), exp }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest().toString('base64url');
  return `bm_session=${body}.${sig}`;
};

/* ══════════════════════════════════════════════════════════════════
   A. 会话与登录
   ══════════════════════════════════════════════════════════════════ */
section('A1. 匿名访问');
{
  const s = await session(main.base);
  ok('GET /api/session → 200', s.status === 200, String(s.status));
  ok('authRequired = true', s.body?.authRequired === true, JSON.stringify(s.body));
  ok('user = null', s.body?.user === null, JSON.stringify(s.body?.user));
  // 默认档：未登录只见最新一条（真正的裁剪在 F 段逐条验）
  ok("readScope = 'latest'（配置没写 scope 时的默认档）", s.body?.readScope === 'latest', JSON.stringify(s.body?.readScope));
  ok('不泄露账号列表', !('users' in (s.body || {})), JSON.stringify(s.body));
  // 页面骨架必须匿名可取：否则登录界面自己都加载不出来，css/js 也一并拿不到
  ok('页面骨架匿名可取（否则登录界面自己都加载不出来）', (await get(main.base, '/')).status === 200);
  ok('站点资源匿名可取', (await get(main.base, '/assets/app.js')).status === 200);
}

section('A2. 登录接口的防护');
{
  const noHdr = await login(main.base, '妈妈', PW_MAMA, { header: false });
  ok('缺 X-BM-Auth 头 → 403', noHdr.status === 403, `${noHdr.status} ${JSON.stringify(noHdr.body)}`);

  const cross = await login(main.base, '妈妈', PW_MAMA, { origin: 'https://evil.example' });
  ok('跨站 Origin → 403', cross.status === 403, `${cross.status} ${JSON.stringify(cross.body)}`);

  const getIt = await fetch(`${main.base}/api/login`);
  ok('GET /api/login → 405', getIt.status === 405, String(getIt.status));

  const bad = await login(main.base, '妈妈', '不对的口令');
  ok('口令错 → 401', bad.status === 401, `${bad.status} ${JSON.stringify(bad.body)}`);
  ok('提示不区分"账号不存在/口令错"', bad.body?.error === '账号或密码不对', bad.body?.error);

  const missing = await fetch(`${main.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BM-Auth': '1' },
    body: JSON.stringify({ user: '', password: '' }),
  });
  ok('账号或口令为空 → 400', missing.status === 400, String(missing.status));

  const garbage = await fetch(`${main.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BM-Auth': '1' },
    body: '不是 json',
  });
  ok('body 不是 JSON → 400（不炸）', garbage.status === 400, String(garbage.status));
}

let COOKIE_MAMA = '';
section('A3. 登录成功与 Cookie 属性');
{
  const r = await login(main.base, '妈妈', PW_MAMA);
  ok('用姓名登录 → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  ok('回显用户', r.body?.user?.id === 'mama', JSON.stringify(r.body?.user));

  const sc = r.setCookie;
  ok('下发 bm_session', sc.startsWith('bm_session='), sc.slice(0, 40));
  ok('HttpOnly（脚本读不到）', /HttpOnly/i.test(sc), sc);
  ok('SameSite=Lax', /SameSite=Lax/i.test(sc), sc);
  ok('Path=/', /Path=\//.test(sc), sc);
  ok('没有 Secure（本机 http 下带上会导致登录永远失败）', !/Secure/i.test(sc), sc);
  ok('带 Max-Age', /Max-Age=\d+/.test(sc), sc);
  COOKIE_MAMA = sc.split(';')[0];

  const s = await session(main.base, COOKIE_MAMA);
  ok('带 Cookie 查会话 → 认出身份', s.body?.user?.id === 'mama', JSON.stringify(s.body?.user));

  // 用别名登录
  const alias = await login(main.base, '宝妈', PW_MAMA);
  ok('别名也能登录', alias.status === 200, `${alias.status}`);

  const byId = await login(main.base, 'mama', PW_MAMA);
  ok('id 也能登录', byId.status === 200, `${byId.status}`);
}

section('A4. Cookie 篡改与过期');
{
  const [name, token] = COOKIE_MAMA.split('=');
  const [body, sig] = token.split('.');
  /**
   * 篡改一个字符串再送回去。
   *
   * ⚠️ 这里**不能改最后一个字符**：base64 每 4 个字符编码 3 个字节，
   * 收尾那一两个字符里有一部分位是填充位，解码时被丢弃。
   * 实测 32 字节的 HMAC 是 43 个字符，末位字符 A(000000) 与 B(000001) 的**有效位都是 00**
   * ⇒ 把末位在 A/B 之间来回改，`Buffer.from(..., 'base64url')` 解出来的 32 字节一模一样，
   * 等于"没改"，而 token 当然验得过 —— 这条断言就会以约 3% 的概率假红
   * （跑一次签名不一样，末位撞上 A/B 就红）。payload 同理会红（base64 长度 ≡1 mod 3 时）。
   *
   * 改首字符就没有这个问题：首字符的 6 个 bit 全部落在第 1 个字节里，一定改变解出的字节。
   * 顺带说明产品侧是对的：服务端比的是**解出来的字节**（timingSafeEqual），
   * 字节没变就该验过 —— 假红的是测试，不是实现。
   */
  const flip = (s) => (s.slice(0, 1) === 'A' ? 'B' : 'A') + s.slice(1);

  ok('改签名 → 匿名', (await session(main.base, `${name}=${body}.${flip(sig)}`)).body?.user === null);
  ok('改载荷（换成另一个账号）→ 拒绝', (await session(main.base, `${name}=${flip(body)}.${sig}`)).body?.user === null);
  ok('只给载荷没签名 → 匿名', (await session(main.base, `${name}=${body}`)).body?.user === null);

  // 注意：HTTP 头只接受 latin1 字节串，所以这里刻意只用 ASCII。
  // 用中文当"乱码"会让 undici 在发请求前就抛 TypeError，根本到不了服务端 —— 测不到任何东西。
  ok('非 base64url 的垃圾串 → 匿名', (await session(main.base, `${name}=%%%garbage%%%`)).body?.user === null);
  ok('空值 → 匿名', (await session(main.base, `${name}=`)).body?.user === null);

  // 更严的一档：形态合法（是 base64url、也带了签名段）但内容不是合法会话。
  const junkBody = Buffer.from('not json at all').toString('base64url');
  const junkSig = crypto.createHash('sha256').update('whatever').digest().toString('base64url');
  ok(
    'base64url 合法但内容不是 JSON → 匿名（不抛异常）',
    (await session(main.base, `${name}=${junkBody}.${junkSig}`)).body?.user === null,
  );

  const jsonNoFields = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
  ok(
    '缺 v/u/exp 字段的 JSON → 匿名',
    (await session(main.base, `${name}=${jsonNoFields}.${junkSig}`)).body?.user === null,
  );

  const otherKey = crypto.createHash('sha256').update('bm-session:完全不同的密钥').digest();
  const forgedBody = Buffer.from(JSON.stringify({ v: 1, u: 'mama', n: '妈妈', exp: Date.now() + 1e9 })).toString('base64url');
  const forgedSig = crypto.createHmac('sha256', otherKey).update(forgedBody).digest().toString('base64url');
  ok(
    '换密钥伪造的合法 token → 拒绝',
    (await session(main.base, `${name}=${forgedBody}.${forgedSig}`)).body?.user === null,
  );

  const expired = signToken({ u: 'mama', name: '妈妈', exp: Date.now() - 1000 });
  ok('自己签的已过期 token → 匿名', (await session(main.base, expired)).body?.user === null);

  const expUpload = await upload(main.base, {
    cookie: expired,
    files: [{ buf: JPG, name: 'a.jpg' }],
    fields: { date: TEST_DATE },
  });
  ok('过期会话不能上传 → 401', expUpload.status === 401, `${expUpload.status} ${JSON.stringify(expUpload.body)}`);
}

section('A5. 滑动续期');
{
  // 剩余不足一半有效期时才续期。签一个只剩 1 分钟的会话来触发这条路径。
  const soon = signToken({ u: 'mama', name: '妈妈', exp: Date.now() + 60_000 });
  const s = await session(main.base, soon);
  ok('临近过期的会话仍可用', s.body?.user?.id === 'mama', JSON.stringify(s.body?.user));
  ok('并自动下发新的 Set-Cookie（续期）', s.setCookie.startsWith('bm_session='), s.setCookie.slice(0, 40));

  const fresh = signToken({ u: 'mama', name: '妈妈', exp: Date.now() + 29 * 86400_000 });
  const s2 = await session(main.base, fresh);
  ok('刚登录的会话不重复续期', s2.setCookie === '', s2.setCookie.slice(0, 40));
}

section('A6. 退出');
{
  const res = await fetch(`${main.base}/api/logout`, {
    method: 'POST',
    headers: { 'X-BM-Auth': '1', Cookie: COOKIE_MAMA },
  });
  const sc = res.headers.get('set-cookie') || '';
  ok('POST /api/logout → 200', res.status === 200, String(res.status));
  ok('清空 Cookie（Max-Age=0）', /Max-Age=0/.test(sc), sc);

  // 服务端不存 session，所以旧 Cookie 在到期前依然有效。这是无状态设计的固有性质，
  // 把这一点写成断言，是为了以后有人改成"退出即全局失效"时能立刻发现行为变了。
  const s = await session(main.base, COOKIE_MAMA);
  ok(
    '退出后旧 Cookie 在到期前仍可用（无状态会话的已知性质，非缺陷）',
    s.body?.user?.id === 'mama',
    JSON.stringify(s.body?.user),
  );

  const after = await login(main.base, '妈妈', PW_MAMA);
  COOKIE_MAMA = after.setCookie.split(';')[0];
}

/* ══════════════════════════════════════════════════════════════════
   B. 上传鉴权与署名
   ══════════════════════════════════════════════════════════════════ */
section('B1. 未登录不能上传');
{
  const r = await upload(main.base, {
    files: [{ buf: JPG, name: 'a.jpg' }],
    fields: { date: TEST_DATE, title: '偷偷传' },
  });
  ok('无 Cookie → 401', r.status === 401, `${r.status} ${JSON.stringify(r.body)}`);
  ok('错误码是 UNAUTHORIZED（前端据此弹登录框）', r.body?.code === 'UNAUTHORIZED', r.body?.code);

  // 同样只能用 ASCII：HTTP 头是 latin1 字节串，中文会让 undici 在发送前抛错。
  const badCookie = await upload(main.base, {
    cookie: 'bm_session=bogus.payload',
    files: [{ buf: JPG, name: 'a.jpg' }],
    fields: { date: TEST_DATE },
  });
  ok('坏 Cookie → 401', badCookie.status === 401, String(badCookie.status));

  const dir = await fsp.readdir(path.join(TMP_MEDIA, TEST_DATE)).catch(() => []);
  ok('未授权的上传没有在照片库留下任何目录', dir.length === 0, dir.join(','));
}

section('B2. 登录后上传，署名写进 meta.json');
{
  const r = await upload(main.base, {
    cookie: COOKIE_MAMA,
    files: [{ buf: JPG, name: 'IMG_1.jpg', type: 'image/jpeg' }],
    fields: { date: TEST_DATE, title: '妈妈发的', caption: '一句话' },
  });
  ok('HTTP 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
  ok('响应里带回署名', r.body?.author?.name === '妈妈', JSON.stringify(r.body?.author));

  const dir = r.body?.dir || '';
  const meta = JSON.parse(
    await fsp.readFile(path.join(TMP_MEDIA, TEST_DATE, dir, 'meta.json'), 'utf8'),
  );
  ok('meta.author = 妈妈', meta.author === '妈妈', JSON.stringify(meta));
  ok('meta.authorId = mama', meta.authorId === 'mama', JSON.stringify(meta));

  // 带身份读 feed：此刻库里已经有条目，未登录那条路只会看到最新的一条（见 F 段）
  const feed = await get(main.base, '/api/feed?refresh=1', COOKIE_MAMA);
  const e = feed.body?.entries?.find((x) => x.key.endsWith(dir));
  ok('扫描结果带 author（页面能显示署名）', e?.author === '妈妈', JSON.stringify(e?.author));
  ok('扫描结果带 authorId', e?.authorId === 'mama', JSON.stringify(e?.authorId));

  // 换个人上传，署名要跟着换（证明署名来自会话而不是写死的）
  const baba = await login(main.base, '爸爸', PW_BABA);
  const COOKIE_BABA = baba.setCookie.split(';')[0];
  const r2 = await upload(main.base, {
    cookie: COOKIE_BABA,
    files: [{ buf: JPG, name: 'IMG_2.jpg', type: 'image/jpeg' }],
    fields: { date: TEST_DATE, title: '爸爸发的' },
  });
  ok('爸爸也能上传', r2.status === 200, JSON.stringify(r2.body));
  const meta2 = JSON.parse(
    await fsp.readFile(path.join(TMP_MEDIA, TEST_DATE, r2.body.dir, 'meta.json'), 'utf8'),
  );
  ok('署名是爸爸（不是上一个登录的人）', meta2.author === '爸爸', JSON.stringify(meta2));

  // 两个人先后上传，序号/前缀不冲突
  ok('两条动态目录不同', r.body.dir !== r2.body.dir, `${r.body.dir} vs ${r2.body.dir}`);
}

/* ══════════════════════════════════════════════════════════════════
   C. 登录限流
   ══════════════════════════════════════════════════════════════════ */
section(`C. 连续错口令 ${AUTH_MAX_ATTEMPTS} 次后锁定`);
{
  const victim = '爸爸';
  let last = null;
  for (let i = 0; i < AUTH_MAX_ATTEMPTS; i += 1) {
    last = await login(main.base, victim, `错口令-${i}`);
    if (last.status !== 401) break;
  }
  ok(`第 ${AUTH_MAX_ATTEMPTS} 次失败仍是 401`, last?.status === 401, `${last?.status}`);

  const locked = await login(main.base, victim, PW_BABA);
  ok('锁定后正确口令也被拒 → 429', locked.status === 429, `${locked.status} ${JSON.stringify(locked.body)}`);
  ok('返回 Retry-After', Number(locked.body?.retryAfter) > 0, JSON.stringify(locked.body));

  // 另一个账号不受影响（锁的是 IP+账号，不是整个 IP）
  const other = await login(main.base, '妈妈', PW_MAMA);
  ok('另一个账号不受影响 → 200', other.status === 200, `${other.status} ${JSON.stringify(other.body)}`);
}

/* ══════════════════════════════════════════════════════════════════
   D. 没配账号时不静默放行
   ══════════════════════════════════════════════════════════════════ */
section('D. auth.enabled 但没有 users');
{
  const bare = await startServer('config-nousers.mjs');
  if (!(await waitReady(bare))) {
    ok('备用服务能起来', false, bare.out.split('\n').slice(-8).join(' | '));
  } else {
    const s = await session(bare.base);
    ok('session 报 configured=false', s.body?.configured === false, JSON.stringify(s.body));

    const r = await upload(bare.base, {
      files: [{ buf: JPG, name: 'a.jpg' }],
      fields: { date: TEST_DATE },
    });
    ok('上传 → 503（不是 401）', r.status === 503, `${r.status} ${JSON.stringify(r.body)}`);
    ok('错误码 AUTH_NOT_CONFIGURED', r.body?.code === 'AUTH_NOT_CONFIGURED', r.body?.code);
    ok('提示里说明了怎么修', /auth\.users/.test(r.body?.error || ''), r.body?.error);

    const l = await login(bare.base, '谁', '什么都行');
    ok('登录 → 503 并说明原因', l.status === 503, `${l.status} ${JSON.stringify(l.body)}`);

    // 读侧同样不静默放行：认不出任何人的时候，"读"也不能当匿名放过去
    const rd = await get(bare.base, '/api/feed');
    ok('读接口也是 503（不是 401，更不是 200）', rd.status === 503, `${rd.status} ${JSON.stringify(rd.body)}`);
    ok('读侧提示也说明了怎么修', /auth\.users/.test(rd.body?.error || ''), rd.body?.error);
    ok('读侧错误码同样是 AUTH_NOT_CONFIGURED', rd.body?.code === 'AUTH_NOT_CONFIGURED', rd.body?.code);

    const dir = await fsp.readdir(path.join(TMP_MEDIA, TEST_DATE)).catch(() => []);
    ok('没有偷偷落盘', dir.length === 2, `${dir.length}：${dir.join(',')}`);
  }
}

/* ══════════════════════════════════════════════════════════════════
   E. 关闭认证时上传不需要登录
   ══════════════════════════════════════════════════════════════════ */
section('E. auth.enabled = false');
{
  const off = await startServer('config-off.mjs');
  if (!(await waitReady(off))) {
    ok('备用服务能起来', false, off.out.split('\n').slice(-8).join(' | '));
  } else {
    const s = await session(off.base);
    ok('session 报 authRequired=false', s.body?.authRequired === false, JSON.stringify(s.body));
    ok("readScope 回落成 'upload'（关掉认证 = 读侧也全开）", s.body?.readScope === 'upload', JSON.stringify(s.body?.readScope));

    const r = await upload(off.base, {
      files: [{ buf: JPG, name: 'c.jpg' }],
      fields: { date: TEST_DATE, title: '匿名也能传' },
    });
    ok('匿名上传 → 200', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    ok('这种模式下不写署名', !r.body?.author, JSON.stringify(r.body?.author));

    const meta = JSON.parse(
      await fsp.readFile(path.join(TMP_MEDIA, TEST_DATE, r.body.dir, 'meta.json'), 'utf8'),
    );
    ok('meta.json 里没有 author 字段', !('author' in meta), JSON.stringify(meta));
  }
}

/* ══════════════════════════════════════════════════════════════════
   F. 读侧鉴权：未登录能看到什么（auth.scope 三档）
   ══════════════════════════════════════════════════════════════════
   这一段的重点不是"前端有没有藏起来"，而是**服务端到底发出了什么**：
   /api/feed 里有没有那些条目、被裁掉的媒体地址是不是真的取不到。
   前端隐藏是装饰，抓个包就绕过 —— 所以断言全部打在 HTTP 响应上。 */
section('F1. scope = latest（默认）：未登录只看得到最新一条');
{
  const anon = await get(main.base, '/api/feed?refresh=1');
  ok('匿名 feed → 200（不是 401）', anon.status === 200, String(anon.status));
  ok('只回最新 1 条', anon.body?.entries?.length === 1, `${anon.body?.entries?.length} 条`);
  ok(
    'preview.limited = true（前端据此提示"登录后看全部"）',
    anon.body?.preview?.limited === true,
    JSON.stringify(anon.body?.preview),
  );
  // stats 也要跟着裁 —— 否则"共 N 条 / 从 X 年开始"本身就是泄露
  ok('stats.entries 只统计可见部分', anon.body?.stats?.entries === 1, JSON.stringify(anon.body?.stats));
  ok('stats.days 只统计可见部分', anon.body?.stats?.days === 1, JSON.stringify(anon.body?.stats));

  const full = (await get(main.base, '/api/feed', COOKIE_MAMA)).body;
  ok('登录后拿到全部（前置条件）', full?.entries?.length > 1, `${full?.entries?.length} 条`);

  const seen = new Set((anon.body?.entries || []).map((e) => e.key));
  const hidden = (full?.entries || []).filter((e) => !seen.has(e.key));
  ok('确实有被裁掉的条目（否则下面两条是空验）', hidden.length > 0, `${hidden.length} 条`);

  const shownMedia = anon.body?.entries?.[0]?.media?.[0];
  const hidMedia = hidden[0]?.media?.[0];
  ok('可见条目里有媒体（否则下面几条是空验）', !!shownMedia?.urls?.grid, JSON.stringify(shownMedia?.urls));
  ok('被裁掉的条目里有媒体（否则下面几条是空验）', !!hidMedia?.urls?.grid, JSON.stringify(hidMedia?.urls));

  const shownThumb = await get(main.base, shownMedia?.urls?.grid);
  ok('可见条目的缩略图匿名可取', shownThumb.status === 200, `${shownThumb.status} ${shownMedia?.urls?.grid}`);
  ok(
    '匿名拿到的缩略图标 private（不落共享/代理缓存）',
    /private/.test(shownThumb.headers.get('cache-control') || ''),
    shownThumb.headers.get('cache-control'),
  );
  ok('可见条目的原图匿名可取', (await get(main.base, shownMedia?.urls?.src)).status === 200, shownMedia?.urls?.src);

  const hidThumb = await get(main.base, hidMedia?.urls?.grid);
  ok('被裁掉条目的缩略图 → 401', hidThumb.status === 401, `${hidThumb.status} ${hidMedia?.urls?.grid}`);
  const hidSrc = await get(main.base, hidMedia?.urls?.src);
  ok('被裁掉条目的原图 → 401（这是整套机制的关键一条）', hidSrc.status === 401, `${hidSrc.status} ${hidMedia?.urls?.src}`);
  ok('提示说的是"查看"而不是"上传"', hidSrc.body?.error === '请先登录再查看照片', hidSrc.body?.error);
  ok('错误码仍是 UNAUTHORIZED', hidSrc.body?.code === 'UNAUTHORIZED', hidSrc.body?.code);
  ok(
    '匿名 SSE → 401（未登录不给连，免得从推送时间推断"什么时候传了新照片"）',
    (await statusOnly(main.base, '/api/events')) === 401,
  );
  ok('登录后 SSE → 200（不是一刀切谁都连不上）', (await statusOnly(main.base, '/api/events', COOKIE_MAMA)) === 200);

  // 登录之后，刚才 401 的地址必须能取到 —— 否则"登录后看全部"就是句空话
  ok('登录后同一张原图可取', (await get(main.base, hidMedia?.urls?.src, COOKIE_MAMA)).status === 200);
  const authThumb = await get(main.base, hidMedia?.urls?.grid, COOKIE_MAMA);
  ok('登录后缩略图 → 200', authThumb.status === 200, String(authThumb.status));
  ok(
    '登录后缩略图恢复 public 缓存',
    /public/.test(authThumb.headers.get('cache-control') || ''),
    authThumb.headers.get('cache-control'),
  );
}

section("F2. scope = all：整站要登录，连骨架之外一概不给");
{
  const locked = await startServer('config-all.mjs');
  if (!(await waitReady(locked))) {
    ok('备用服务能起来', false, locked.out.split('\n').slice(-8).join(' | '));
  } else {
    const s = await session(locked.base);
    ok("readScope = 'all'", s.body?.readScope === 'all', JSON.stringify(s.body?.readScope));

    const feed = await get(locked.base, '/api/feed');
    ok('匿名 feed → 401', feed.status === 401, `${feed.status} ${JSON.stringify(feed.body)}`);
    ok('提示是"请先登录再查看照片"', feed.body?.error === '请先登录再查看照片', feed.body?.error);
    ok('匿名 SSE → 401', (await statusOnly(locked.base, '/api/events')) === 401);

    // 媒体地址一律取不到。用 main 那边已拿到的真实地址来打，避免拿一个不存在的 key 空验。
    const full = (await get(main.base, '/api/feed', COOKIE_MAMA)).body;
    const any = full?.entries?.[0]?.media?.[0];
    ok('有可用的真实媒体地址（前置条件）', !!any?.urls?.src, JSON.stringify(any?.urls));
    ok('匿名缩略图 → 401', (await get(locked.base, any?.urls?.grid)).status === 401);
    ok('匿名原图 → 401', (await get(locked.base, any?.urls?.src)).status === 401);

    // 骨架必须还能取：否则登录界面自己都加载不出来，就成了"锁上之后连钥匙孔都没有"
    const page = await get(locked.base, '/');
    ok('页面骨架仍可取（登录界面要靠它渲染）', page.status === 200, String(page.status));
    ok('站点资源仍可取', (await get(locked.base, '/assets/style.css')).status === 200);

    // 未登录时不该把孩子的生日/别名送到匿名访客的浏览器里
    const cfg = siteConfigOf(page.text);
    ok('页面里注入了 readScope=all', cfg?.readScope === 'all', JSON.stringify(cfg?.readScope));
    ok('kids 里有条目（否则下一句是空验）', (cfg?.kids || []).length > 0, JSON.stringify(cfg?.kids));
    ok('未登录时摘掉了生日', (cfg?.kids || []).every((k) => !('birthday' in k)), JSON.stringify(cfg?.kids?.[0]));
    ok('未登录时摘掉了别名', (cfg?.kids || []).every((k) => !('aliases' in k)), JSON.stringify(cfg?.kids?.[0]));
    ok('名字留着（预览那几条本来就会显示它）', !!cfg?.kids?.[0]?.name, JSON.stringify(cfg?.kids?.[0]));

    const lg = await login(locked.base, '妈妈', PW_MAMA);
    ok('登录 → 200', lg.status === 200, `${lg.status} ${JSON.stringify(lg.body)}`);
    const COOKIE = lg.setCookie.split(';')[0];
    const after = await get(locked.base, '/api/feed', COOKIE);
    ok('登录后 feed → 200 且是全部', (after.body?.entries?.length || 0) > 1, `${after.body?.entries?.length} 条`);
    ok('登录后缩略图可取', (await get(locked.base, any?.urls?.grid, COOKIE)).status === 200);
    const page2 = await get(locked.base, '/', COOKIE);
    const cfg2 = siteConfigOf(page2.text);
    ok('登录后页面里带回了生日（不再脱敏）', 'birthday' in (cfg2.kids?.[0] || {}), JSON.stringify(cfg2.kids?.[0]));
  }
}

section("F3. scope = upload：读侧全放开（回归旧行为）");
{
  const open = await startServer('config-open.mjs');
  if (!(await waitReady(open))) {
    ok('备用服务能起来', false, open.out.split('\n').slice(-8).join(' | '));
  } else {
    const s = await session(open.base);
    ok("readScope = 'upload'", s.body?.readScope === 'upload', JSON.stringify(s.body?.readScope));

    const feed = await get(open.base, '/api/feed');
    ok('匿名 feed → 200 且是全部', (feed.body?.entries?.length || 0) > 1, `${feed.body?.entries?.length} 条`);
    ok('没有 preview.limited 标记', feed.body?.preview?.limited !== true, JSON.stringify(feed.body?.preview));

    const any = feed.body?.entries?.[0]?.media?.[0];
    const thumb = await get(open.base, any?.urls?.grid);
    ok('匿名缩略图 → 200', thumb.status === 200, `${thumb.status} ${any?.urls?.grid}`);
    ok(
      '缩略图缓存头是 public（没有把非私密内容当成私密）',
      /public/.test(thumb.headers.get('cache-control') || ''),
      thumb.headers.get('cache-control'),
    );
    ok('匿名原图 → 200', (await get(open.base, any?.urls?.src)).status === 200);
    ok('匿名 SSE → 200（连得上）', (await statusOnly(open.base, '/api/events')) === 200);
  }
}

/* ── 收尾 ─────────────────────────────────────────────────────────── */
stopAll();
await fsp.rm(WORK, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log(`\n失败项：\n - ${failures.join('\n - ')}`);
console.log(`临时工作区已清理：${path.relative(ROOT, WORK)}（真实 photos/ 全程未被触碰）\n`);
process.exit(fail ? 1 : 0);
