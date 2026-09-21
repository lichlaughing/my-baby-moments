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
 *   D 没配账号时不静默放行（503 而不是 401）
 *   E 关闭认证时上传不需要登录
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

const writeConfig = (file, { users, authOn }) => {
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

writeConfig('config.mjs', { users: [USER_MAMA, USER_BABA], authOn: true });
writeConfig('config-nousers.mjs', { users: [], authOn: true });
writeConfig('config-off.mjs', { users: [], authOn: false });

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
  ok('不泄露账号列表', !('users' in (s.body || {})), JSON.stringify(s.body));
  ok('页面仍可匿名访问（看照片不需要登录）', (await fetch(`${main.base}/`)).status === 200);
  ok('feed 也可匿名访问', (await fetch(`${main.base}/api/feed`)).status === 200);
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
  const flip = (s) => s.slice(0, -1) + (s.slice(-1) === 'A' ? 'B' : 'A');

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

  const feed = await (await fetch(`${main.base}/api/feed?refresh=1`)).json();
  const e = feed.entries.find((x) => x.key.endsWith(dir));
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

/* ── 收尾 ─────────────────────────────────────────────────────────── */
stopAll();
await fsp.rm(WORK, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log(`\n失败项：\n - ${failures.join('\n - ')}`);
console.log(`临时工作区已清理：${path.relative(ROOT, WORK)}（真实 photos/ 全程未被触碰）\n`);
process.exit(fail ? 1 : 0);
