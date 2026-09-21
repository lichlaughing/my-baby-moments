/**
 * 账号认证：零依赖（只用 node:crypto）。
 *
 * 场景是「家里的照片库，几个人一起往里传」，不是面向公网的产品，所以刻意做到最小：
 *
 *   1. 账号写在 moments.config.mjs 里，不建用户表、不做注册。
 *   2. 口令只存 scrypt 哈希；配置里直接写明文也能跑，但启动时会警告。
 *   3. 会话是 HMAC-SHA256 签名的 Cookie，服务端不存 session —— 重启不掉线。
 *      签名密钥首次启动自动生成到 <cacheDir>/session.key（0600），不进 git。
 *   4. 登录失败按「IP」和「IP+账号」双维度限流，挡住脚本猜口令。
 *      账号不存在时也照样跑一次 scrypt，避免用响应时间探测「这个账号存不存在」。
 *   5. 拦哪一侧由 auth.scope 决定：默认连「看」也拦（未登录只见最新几条），
 *      裁剪动作**在服务端完成** —— 未登录时 /api/feed 里根本没有那些数据，
 *      对应媒体的 URL 直接回 401。前端隐藏不算数，抓包就能绕过。
 *
 * 四条与安全直接相关的取舍，写在前面免得以后被"优化"掉：
 *
 *   · Cookie 默认不带 Secure —— 服务是 http://127.0.0.1，带上 Secure 浏览器直接不保存，
 *     等于登录永远失败。放到 HTTPS 反代后面时，靠 x-forwarded-proto 或配置显式打开。
 *   · 时间比较一律 timingSafeEqual（先 sha256 对齐长度），不用 ===。
 *   · auth.enabled 为真但没有账号时，**不静默放行**，而是把请求挡掉并给明确指引。
 *     静默放行等于"以为上了锁，其实门是开的"，比报错危险得多。scope 越严，挡掉的面越大。
 *     代价是"开了认证却忘了配账号"时整站都进不去 —— 这是刻意的，启动日志会明说怎么修。
 *   · scope 写错（拼写错误）时不退回"全开"，而是 warn + 退回默认的 'latest'。
 *     宁可少看几条，也不能因为一个字母就让整个相册裸奔。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** scrypt 参数。N=16384/r=8 需要 128*N*r = 16MB，低于 Node 默认 maxmem，不会抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const HASH_PREFIX = 'scrypt$1$';

export const COOKIE_NAME = 'bm_session';

/** 带 HTTP 状态码的认证错误，交给路由层直接转成响应 */
export class AuthError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/* ─────────────────────────── 读侧范围 ─────────────────────────── */

/** 未登录时能看到什么。只有三档。 */
export const SCOPES = ['latest', 'all', 'upload'];

/**
 * 从配置算出读侧的**有效**范围。抽成独立函数是为了让 `npm run build` 也能问同一句话：
 * 静态产物没有后端，三档全都不生效，构建时必须提醒（否则会以为导出物也上了锁）。
 *
 * @returns {{ scope: string, previewCount: number, readLimit: number }} readLimit 为 Infinity 表示不限制
 */
export function resolveReadScope(cfg = {}, onWarn = () => {}) {
  // 关掉认证就是全开：此时 scope 写什么都不该留个半开的门缝
  if (cfg.enabled === false) return { scope: 'upload', previewCount: 0, readLimit: Infinity };

  const raw = String(cfg.scope ?? 'latest')
    .trim()
    .toLowerCase();
  let scope = raw;
  if (!SCOPES.includes(raw)) {
    onWarn(
      `auth.scope 的值 "${cfg.scope}" 不认识（只认 ${SCOPES.join(' / ')}），已按 'latest' 处理 —— ` +
        `写错时不会退回"全开"，否则一个拼写错误就等于把整个相册放出去了。`,
    );
    scope = 'latest';
  }

  const n = Number(cfg.previewCount ?? 1);
  const previewCount = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1;
  return {
    scope,
    previewCount,
    readLimit: scope === 'all' ? 0 : scope === 'upload' ? Infinity : previewCount,
  };
}

/* ─────────────────────────── 口令哈希 ─────────────────────────── */

/** 是否已经是 scrypt 哈希（否则当成配置里直接写的明文） */
export const isHashed = (s) => String(s || '').startsWith(HASH_PREFIX);

/** 生成 `scrypt$1$N$r$p$salt$hash`（salt 与 hash 都是 base64url，无 `$`，分割安全） */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `${HASH_PREFIX}${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${dk.toString(
    'base64url',
  )}`;
}

/**
 * 定长比较。两侧先 sha256 对齐长度 —— 直接 timingSafeEqual(a, b) 在长度不同时会抛错，
 * 而"抛错"和"返回 false"的耗时不同，等于把"口令长度猜对了"这件事漏出去。
 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 校验口令。stored 既可以是 hashPassword() 的产物，也可以是配置里直接写的明文。
 * 用异步 scrypt：登录是低频操作，但把它放在同步版本上会阻塞事件循环 ——
 * 一波失败的登录请求就能把整个服务卡住，反而是个放大攻击面。
 */
export async function verifyPassword(password, stored) {
  const raw = String(stored || '');
  if (!isHashed(raw)) return safeEqual(password, raw);

  const parts = raw.split('$');
  // scrypt $ 1 $ N $ r $ p $ salt $ hash
  if (parts.length !== 7) return false;
  const [, , n, r, p, salt, hash] = parts;
  const N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  if (!N || !rr || !pp || !salt || !hash) return false;

  let dk;
  try {
    dk = await scrypt(String(password), Buffer.from(salt, 'base64url'), SCRYPT.keylen, {
      N,
      r: rr,
      p: pp,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  const want = Buffer.from(hash, 'base64url');
  if (want.length !== dk.length) return false;
  return crypto.timingSafeEqual(want, dk);
}

/* ─────────────────────────── 会话 Cookie ─────────────────────────── */

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/**
 * 从请求里挑出 cookie。只按第一个 `=` 切分 —— cookie 值本身可能含 `=`（base64 填充）。
 */
function readCookie(req, name) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** 是否应当标记 Secure。看配置，其次看反代透传的协议。 */
function isSecure(req, cfg) {
  if (cfg.secure === true) return true;
  if (cfg.secure === false) return false;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

/* ─────────────────────────── 账号归一化 ─────────────────────────── */

/** id 只允许安全字符：它会出现在日志和 meta.json 里，不该带路径味道 */
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function normalizeUsers(list, warn) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((u, i) => {
    if (!u || typeof u !== 'object') return;
    const name = String(u.name || '').trim();
    const id = String(u.id || '').trim() || `u${i + 1}`;
    const secret = u.passwordHash || u.password;
    if (!name) {
      warn(`auth.users[${i}] 缺少 name，已跳过`);
      return;
    }
    if (!ID_RE.test(id)) {
      warn(`auth.users[${i}] 的 id "${id}" 含有不允许的字符（只允许字母数字与 _-），已跳过`);
      return;
    }
    if (seen.has(id)) {
      warn(`auth.users 里 id "${id}" 重复，后一个已跳过`);
      return;
    }
    if (!secret) {
      warn(`auth.users[${i}]（${name}）既没有 password 也没有 passwordHash，已跳过`);
      return;
    }
    if (!isHashed(secret)) {
      warn(
        `auth.users[${i}]（${name}）用的是明文口令。跑 \`npm run passwd ${id}\` 生成哈希后\n` +
          `      把 password 换成 passwordHash，明文就不会再留在配置文件里。`,
      );
    }
    seen.add(id);
    out.push({
      id,
      name,
      aliases: (Array.isArray(u.aliases) ? u.aliases : []).map((a) => String(a)),
      secret: String(secret),
      hashed: isHashed(secret),
    });
  });
  return out;
}

/* ─────────────────────────── 主体 ─────────────────────────── */

export function createAuth(config, { root, onWarn = () => {} } = {}) {
  const cfg = config.auth || {};
  const users = normalizeUsers(cfg.users, onWarn);

  const enabled = cfg.enabled !== false;
  /** 配了 auth 却一个账号都没有：不放行，把请求挡掉并说清楚怎么修 */
  const misconfigured = enabled && users.length === 0;

  /**
   * 未登录时能看到什么。真正算它的是 resolveReadScope()，
   * 这里只负责把结果接上（build 那边问的是同一个函数）。
   */
  const { scope, previewCount, readLimit } = resolveReadScope(cfg, onWarn);

  const sessionMs = Math.max(1, Number(cfg.sessionDays) || 30) * 24 * 3600 * 1000;
  const maxFails = Math.max(3, Number(cfg.maxAttempts) || 8);
  /** 单 IP 的总失败上限放宽一些：一个 IP 后面可能是好几个人 */
  const maxFailsPerIp = maxFails * 3;
  const windowMs = Math.max(1, Number(cfg.windowMinutes) || 10) * 60 * 1000;

  const cacheDir = path.isAbsolute(config.thumbs.cacheDir)
    ? config.thumbs.cacheDir
    : path.join(root, config.thumbs.cacheDir);

  /* 签名密钥：优先配置，其次落盘复用，最后退化成进程内随机 */
  const keyFile = path.join(cacheDir, 'session.key');
  let secret = String(cfg.secret || '').trim();
  let secretFrom = 'config';
  if (!secret) {
    secretFrom = 'file';
    try {
      secret = fs.readFileSync(keyFile, 'utf8').trim();
    } catch {
      /* 首次启动：下面生成 */
    }
    if (secret.length < 32) {
      secret = crypto.randomBytes(32).toString('hex');
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
      } catch (err) {
        // 落盘失败通常是没有写权限。仍然可用，但重启后所有会话失效，必须说出来。
        secretFrom = 'ephemeral';
        onWarn(`会话密钥无法写入 ${keyFile}（${err.code || err.message}），本次运行用临时密钥：重启后需要重新登录`);
      }
    }
  }
  const key = crypto.createHash('sha256').update(`bm-session:${secret}`).digest();

  /* 账号不存在时用来"陪跑"的哈希，让耗时与真实校验一致 */
  const dummyHash = hashPassword(crypto.randomBytes(24).toString('hex'));

  /* 登录失败计数：key → { fails, first, blockedUntil } */
  const attempts = new Map();

  const limitKeys = (req, id) => {
    const ip = req?.socket?.remoteAddress || req?.headers?.['x-forwarded-for'] || 'unknown';
    return { ip: `ip:${ip}`, id: `id:${ip}|${id || ''}` };
  };

  function blockedFor(key) {
    const rec = attempts.get(key);
    if (!rec) return 0;
    const now = Date.now();
    if (rec.blockedUntil > now) return rec.blockedUntil - now;
    if (now - rec.first > windowMs) attempts.delete(key);
    return 0;
  }

  function recordFail(key, ceiling) {
    const now = Date.now();
    let rec = attempts.get(key);
    if (!rec || now - rec.first > windowMs) rec = { fails: 0, first: now, blockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= ceiling) rec.blockedUntil = now + windowMs;
    attempts.set(key, rec);
    // 上限兜底：被大量伪造 IP 刷时不会把内存撑爆
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) {
        if (v.blockedUntil < now && now - v.first > windowMs) attempts.delete(k);
      }
      if (attempts.size > 5000) attempts.clear();
    }
  }

  function sign(payload) {
    const body = b64(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', key).update(body).digest();
    return `${body}.${b64(sig)}`;
  }

  /** 解开 token；签名不对、格式不对、过期，一律返回 null（不区分原因） */
  function unsign(token) {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const body = token.slice(0, i);
    let sig;
    try {
      sig = Buffer.from(token.slice(i + 1), 'base64url');
    } catch {
      return null;
    }
    const want = crypto.createHmac('sha256', key).update(body).digest();
    if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || payload.v !== 1 || typeof payload.exp !== 'number') return null;
    if (payload.exp <= Date.now()) return null;
    // 账号可能已经被删掉/改名，以配置为准
    const u = users.find((x) => x.id === payload.u);
    if (!u) return null;
    return { id: u.id, name: u.name, exp: payload.exp };
  }

  function cookieFor(user, { secure, maxAgeSec }) {
    const token = sign({ v: 1, u: user.id, n: user.name, iat: Date.now(), exp: Date.now() + sessionMs });
    return [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
      secure ? 'Secure' : null,
    ]
      .filter(Boolean)
      .join('; ');
  }

  function setCookie(res, req, user) {
    const v = cookieFor(user, { secure: isSecure(req, cfg), maxAgeSec: Math.floor(sessionMs / 1000) });
    if (typeof res.appendHeader === 'function') res.appendHeader('Set-Cookie', v);
    else res.setHeader('Set-Cookie', v);
  }

  function clearCookie(res, req) {
    const v = [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      isSecure(req, cfg) ? 'Secure' : null,
    ]
      .filter(Boolean)
      .join('; ');
    if (typeof res.appendHeader === 'function') res.appendHeader('Set-Cookie', v);
    else res.setHeader('Set-Cookie', v);
  }

  /** 当前登录用户；没登录/签名不对/过期/账号已删 → null */
  const currentUser = (req) => unsign(readCookie(req, COOKIE_NAME));

  /**
   * 会话滑动续期：剩余不足一半时换一张新的。
   * 必须在响应写头之前调用（json() 内部是 writeHead）。
   */
  function renewIfStale(req, res) {
    if (!enabled) return null;
    const s = currentUser(req);
    if (!s) return null;
    if (s.exp - Date.now() > sessionMs / 2) return s;
    setCookie(res, req, s);
    return s;
  }

  /* ── 路由处理 ── */

  /** 读 JSON body，带体积上限。超限或不是 JSON 都算 400。 */
  async function readJsonBody(req, limit = 4096) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new AuthError(413, '请求体过大');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new AuthError(400, '请求体不是合法 JSON');
    }
  }

  /** POST /api/login —— 自己读 body、自己回响应，与 uploader.handle 同一种形状 */
  async function handleLogin(req, res, json) {
    try {
      if (!enabled) return json(res, 400, { error: '没有开启账号认证（moments.config.mjs → auth.enabled）' });
      if (misconfigured) return json(res, 503, notConfigured('login'));

      const body = await readJsonBody(req);
      const idOrName = String(body.user || '').trim();
      const password = String(body.password || '');
      if (!idOrName || !password) {
        return json(res, 400, { error: '请填写账号和密码' });
      }

      const k = limitKeys(req, idOrName.toLowerCase());
      const wait = Math.max(blockedFor(k.id), blockedFor(k.ip));
      if (wait > 0) {
        const sec = Math.ceil(wait / 1000);
        if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(sec));
        return json(res, 429, {
          error: `登录尝试过于频繁，请 ${sec} 秒后再试`,
          code: 'TOO_MANY_ATTEMPTS',
          retryAfter: sec,
        });
      }

      const lower = idOrName.toLowerCase();
      const user = users.find(
        (u) => u.id.toLowerCase() === lower || u.name.toLowerCase() === lower || u.aliases.some((a) => a.toLowerCase() === lower),
      );

      // 账号不存在时也要花掉一次 scrypt —— 否则"立刻返回"和"算了 50ms 才返回"
      // 的差异，就是一个可用来枚举账号的计时侧信道。
      const pass = await verifyPassword(password, user ? user.secret : dummyHash);

      if (!user || !pass) {
        recordFail(k.id, maxFails);
        recordFail(k.ip, maxFailsPerIp);
        const left = Math.max(
          0,
          Math.min(maxFails - (attempts.get(k.id)?.fails || 0), maxFailsPerIp - (attempts.get(k.ip)?.fails || 0)),
        );
        return json(res, 401, {
          error: '账号或密码不对',
          code: 'BAD_CREDENTIALS',
          remaining: left,
        });
      }

      attempts.delete(k.id);
      attempts.delete(k.ip);
      setCookie(res, req, user);
      return json(res, 200, { ok: true, user: { id: user.id, name: user.name } });
    } catch (err) {
      if (res.headersSent) return res.end();
      return json(res, err instanceof AuthError ? err.status : 400, {
        error: err.message,
        code: 'BAD_REQUEST',
      });
    }
  }

  /** POST /api/logout */
  async function handleLogout(req, res, json) {
    // body 要读干净，否则 keep-alive 连接上残留的字节会被当成下一个请求
    for await (const _ of req) void _;
    clearCookie(res, req);
    return json(res, 200, { ok: true });
  }

  /**
   * GET /api/session 的载荷。刻意不回账号列表：那是"谁有账号"的信息，不该给匿名访客。
   *
   * readScope 是**有效值**（关掉认证时恒为 'upload'），前端据此决定：
   *   'all'    未登录什么都不给看 —— 直接铺一屏登录，连 feed 都不去拉
   *   'latest' 未登录只给看最新几条 —— 正常渲染，外加一条"登录后看全部"的提示
   *   'upload' reads 完全放开，只有发布要登录
   * 前端拿它只是为了少发一个注定 401 的请求；真正的裁剪在服务端，不靠它守。
   */
  const status = (req) => {
    const user = currentUser(req);
    return {
      ok: true,
      authRequired: enabled,
      readScope: scope,
      configured: !misconfigured,
      user: user ? { id: user.id, name: user.name } : null,
    };
  };

  /**
   * 未登录时挡回去。what 决定文案：
   * 上传和"看照片"是两件事，提示得说清是哪一件，否则用户不知道该去点哪里。
   */
  function denyUnauthorized(res, json, what = 'upload') {
    return json(res, 401, {
      error: what === 'read' ? '请先登录再查看照片' : '请先登录再上传',
      code: 'UNAUTHORIZED',
    });
  }

  /**
   * 配了认证但没账号时统一的 503 响应体，读侧 / 写侧 / 登录页共用 —— 指引只写一遍，
   * 三处说法不一致时最容易让人以为"是别的问题"。
   */
  const notConfigured = (what = 'upload') => ({
    error:
      what === 'read'
        ? '这个站点开了账号认证，但配置里没有任何账号，所以谁也进不来。见 moments.config.mjs → auth.users（可用 npm run passwd 生成）'
        : what === 'login'
          ? '已开启账号认证，但配置里没有任何账号。请在 moments.config.mjs 的 auth.users 里加一个用户。'
          : '服务端还没有配置账号，无法上传。见 moments.config.mjs → auth.users（可用 npm run passwd 生成）',
    code: 'AUTH_NOT_CONFIGURED',
  });

  /** 给启动日志用：读侧的一句话说明 */
  const describeRead = () => {
    if (!enabled) return '不限（任何人不登录就能看全部）';
    if (scope === 'upload') return '不限（未登录可看全部，只有发布要登录）';
    if (scope === 'all') return '未登录什么都看不到（整站要登录）';
    return `未登录只见最新 ${previewCount} 条，登录后看全部`;
  };

  /** 给启动日志用的一句话说明 */
  const describe = () => {
    if (!enabled) return '未开启（任何人都能上传）';
    if (misconfigured) return '已开启，但一个账号都没配 —— 上传会被挡住';
    return `${users.length} 个账号：${users.map((u) => u.name).join('、')}`;
  };

  return {
    enabled,
    misconfigured,
    scope,
    readLimit,
    previewCount,
    /** 读侧是否被限制（未登录时不能看全部） */
    readsGated: Number.isFinite(readLimit),
    users: users.map((u) => ({ id: u.id, name: u.name })),
    sessionMs,
    secretFrom,
    keyFile,
    currentUser,
    renewIfStale,
    setCookie,
    clearCookie,
    handleLogin,
    handleLogout,
    status,
    denyUnauthorized,
    notConfigured,
    describe,
    describeRead,
  };
}
