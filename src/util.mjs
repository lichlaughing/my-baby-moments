/**
 * 通用小工具：无第三方依赖。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 中文环境下的自然排序（"2" < "10"，与资源管理器一致） */
export const naturalCompare = new Intl.Collator('zh-Hans-CN', {
  numeric: true,
  sensitivity: 'base',
}).compare;

export const VID = {
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
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

/** 浏览器 <img> 直接支持、不需要转码的图片格式 */
export const NATIVE_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);

/** 浏览器 <video> 基本都能直接播的格式（h264/aac 的 mp4 最稳） */
export const NATIVE_VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

export const extOf = (file) => path.extname(file).slice(1).toLowerCase();

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

export const shortHash = (s, len = 16) => sha1(s).slice(0, len);

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function readJsonIfExists(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, p);
}

export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** HH:mm */
export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 把 URL 路径片段安全地编码，保留 '/' */
export const encodeRelPath = (rel) =>
  rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

/** 解码可能是编码过的相对路径，且拒绝越权（..）访问 */
export function decodeRelPath(raw) {
  try {
    const dec = decodeURIComponent(raw);
    if (dec.includes('\0')) return null;
    const normalized = path.posix.normalize(dec).replace(/^\/+/, '');
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

/** 极简并发闸门 */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}

/**
 * 提前回错时把请求体读掉。
 *
 * 为什么非读不可：请求体还没发完就关连接，浏览器/undici 只会报「连接被重置」，
 * 我们精心写的「请先登录 / 这次上传超过上限」根本传不到用户眼前。
 *
 * 为什么要有上限：上传的 body 动辄几百 MB，为了回一个 401 把几百 MB 读进来纯属浪费。
 * 超过 maxBytes 就直接断开连接 —— 代价是客户端可能只看到网络错误，
 * 所以调用方（前端）在收到任何上传错误后都会再问一次 /api/session，
 * 「会话过期」这件事最终仍会被正确识别出来，不会变成一句无解的"网络中断"。
 */
export async function drainRequest(req, maxBytes = 4 * 1024 * 1024) {
  let seen = 0;
  try {
    for await (const chunk of req) {
      seen += chunk.length;
      if (seen > maxBytes) {
        req.destroy();
        return;
      }
    }
  } catch {
    /* 客户端提前断开是正常情况 */
  }
}

/** 日期字符串 + 年龄。"3岁4个月" / "9个月" / "出生第 12 天" */
export function ageAt(birthday, dateStr) {
  if (!birthday) return '';
  const b = parseDateOnly(birthday);
  const d = parseDateOnly(dateStr);
  if (!b || !d) return '';
  if (d < b) return '还没出生';
  let months = (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth());
  if (d.getDate() < b.getDate()) months -= 1;
  if (months < 0) return '';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years >= 1) return rest > 0 ? `${years}岁${rest}个月` : `${years}岁`;
  if (months >= 1) return `${months}个月`;
  const days = Math.floor((d - b) / 86400000);
  return days <= 0 ? '出生当天' : `出生第 ${days + 1} 天`;
}

/** 'yyyy-MM-dd' → 本地时区当天 0 点的 Date（不能用 new Date(str)，会按 UTC 解析） */
export function parseDateOnly(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export const DATE_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[-_\s](.*))?$/;

/* ─────────────────────── 目录名的「排序前缀」 ───────────────────────
 *
 * 一条动态的目录名由「前缀 + 标题」组成，前缀决定同一日期内的并列顺序。
 * 支持两种写法，扫描器都能识别并剥掉，因此两种可以混用（手工建的目录不受影响）：
 *
 *   order  001 / 001-第一次翻身                     ← 默认，短、一眼能按顺序读
 *   time   143027-k3f9 / 143027-k3f9-第一次翻身     ← 时间可排序 + 随机去重
 *
 * time 形态的第二段是随机串，用来保证唯一：这样就不需要「读出已用序号再 +1」
 * 这个读-改-写动作，也就没有可竞争的临界区 —— 即便跨进程锁不可用也不会撞名。
 *
 * 为什么不是 nanoid：nanoid 是纯随机的，字典序与时间无关，恰好不满足
 * 「按时间排好序」这个要求。要可排序就必须带时间前缀，所以用的是它的变体。
 */
export const TIME_ID_RE = /^\d{6}-[0-9a-z]{4}(?=[-_.、\s]|$)/;
/**
 * 序号前缀放宽到 4 位：手工建的 "2026-秋游" 这类目录名也要能剥掉前缀当标题。
 *
 * 后面**必须**跟着分隔符或结尾。少了这个约束，"2宝-出游"（意思是"二宝-出游"）
 * 会被剥成前缀 "2" + 标题 "宝-出游"，把人家自己起的名字改坏；
 * 而 "143027-k3f9m" 这种随机串位数不对的名字也会被切出半个标题。
 * 宁可认不出来当完整标题，也不要猜错。
 */
export const ORDER_ID_RE = /^\d{1,4}(?=[-_.、\s]|$)/;

/**
 * 拆出「排序前缀」与「标题」。
 * 只写了前缀没写标题（"003" / "143027-k3f9"）时 title 为空串 —— 调用方据此
 * 判定「这条动态没有标题」，否则上传出来的纯 ID 目录会被当成标题显示。
 */
export function splitSortPrefix(name) {
  const s = String(name ?? '');
  const m = TIME_ID_RE.exec(s) || ORDER_ID_RE.exec(s);
  if (!m) return { id: '', title: s.trim() };
  return { id: m[0], title: s.slice(m[0].length).replace(/^[-_.、\s]+/, '').trim() };
}

/** 随机串用的字母表：去掉 i/l/o/u，避免在 Finder 里和 1/0 看混 */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** n 位随机 ID。256 是 32 的整数倍，取模不会引入偏斜。 */
export function randomId(n = 4) {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function dateMeta(dateStr) {
  const d = parseDateOnly(dateStr);
  if (!d) return { date: dateStr, year: '', month: '', dayLabel: dateStr, weekday: '', dateLabel: dateStr };
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return {
    date: dateStr,
    year: String(y),
    month: `${y}年${m}月`,
    monthKey: `${y}-${String(m).padStart(2, '0')}`,
    dayLabel: `${m}月${day}日`,
    weekday: WEEKDAYS[d.getDay()],
    dateLabel: `${y}年${m}月${day}日`,
  };
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
