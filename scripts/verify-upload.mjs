#!/usr/bin/env node
/**
 * 上传能力的自包含验证  ——  node scripts/verify-upload.mjs
 *
 * 为什么单独一个脚本：`POST /api/upload` 是整个项目里唯一的**写路径**，
 * 它会直接改动你的照片库。这类路径一旦回归是「静默且破坏性」的
 * （目录名算错、序号撞车、路径穿越写出去、半成品目录留在库里），
 * 所以把断言固化下来，改完 src/upload.mjs 跑一遍就有底。
 *
 * 两段：
 *   A. 白盒 —— 把 createUploader 拉进本进程，用自造的 Readable 当 req 喂它。
 *      走 HTTP 测不出的三件事：body 被切成 3 字节、boundary 反复跨界；
 *      内容里恰好出现 "\r\n--boundary" 这串字节；以及 200MB body 到底有没有进内存。
 *   B. 端到端 —— 起一个临时服务，发真实 multipart，逐项核对落盘结果。
 *
 * 全程只动 <root>/.cache/verify/（临时照片库 + 临时缩略图缓存），
 * 跑完自删，绝不碰 photos/。开头有硬闸门再确认一次。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.cache/verify');
const TMP_MEDIA = path.join(WORK, 'photos');
const TMP_CACHE = path.join(WORK, 'cache');
const STAGE_ROOT = path.join(TMP_CACHE, 'uploads');
// 配置路径从 WORK 派生，不要另写一份字面量 —— 否则改了 WORK 这里会静默对不上
const CONFIG_ABS = path.join(WORK, 'config.mjs');
const CONFIG_REL = path.relative(ROOT, CONFIG_ABS);
const TEST_DATE = '1999-01-01';
const TEST_DIR = path.join(TMP_MEDIA, TEST_DATE);

// 宝宝的名字是**用户可编辑**的 —— 多数人第一件事就是改成真名。
// 所以期望值必须从真实配置里读，不能写死：写死会在别人改名那天突然红掉，
// 而且红的是「上传链路回归」这个完全误导的名义（实测踩过一次）。
const REAL_CONFIG = (await import(path.join(ROOT, 'moments.config.mjs'))).default;
/** 上传用例固定写 kid: 'k1'，所以这里也锚定这个 id，期望名字跟着配置走 */
const KID_UNDER_TEST = 'k1';
const KID_NAME = REAL_CONFIG.kids?.find((k) => k.id === KID_UNDER_TEST)?.name;

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
   下面会对 WORK 做 rm -rf。一旦路径被配错（哪怕只是有人手工把 WORK 改到
   ROOT/photos 想「就地测」），删掉的就是真实照片，不可逆。
   注意别写成「TMP_MEDIA 是否包含于 WORK」—— 它俩本来就是父子关系，
   那种判断恒为真，等于没写。真正要守的两个不变量是：
     ① WORK 落在 <root>/.cache/ 之内；
     ② WORK 与真实照片库互不包含（更不许相等）。
   ② 需要先拿到真实配置里的 mediaRoot，所以把 import 提到闸门之前。 */
const baseConfig = (await import(path.join(ROOT, 'moments.config.mjs'))).default;

const refuses = [];
const isUnder = (child, parent) => {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
};

const CACHE_ROOT = path.join(ROOT, '.cache');
if (!isUnder(WORK, CACHE_ROOT)) {
  refuses.push(`临时工作区 ${WORK} 不在 ${CACHE_ROOT} 之内`);
}

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
  console.error('请修正脚本里的 WORK / moments.config.mjs 的 paths.mediaRoot，然后重跑。');
  process.exit(2);
}

/* ── 夹具 ─────────────────────────────────────────────────────────── */
const sharp = (await import('sharp')).default;

/** 造一张真 JPEG（sharp 能解、缩略图能生成） */
async function makeJpeg(seed) {
  const [r, g, b] = [(seed * 60) % 256, 140, (seed * 97) % 200];
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: { r, g, b } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** 造一段带可识别头的假 mp4：上传链路按扩展名判定类型，不解码内容 */
function makeMp4(size, tag = 0x5a) {
  const buf = Buffer.alloc(size, tag);
  buf.write('ftypisom', 4, 'latin1'); // 看起来像 mp4 的 ftyp box
  return buf;
}

const JPG = await makeJpeg(1);
const JPG2 = await makeJpeg(2);
const MP4 = makeMp4(64 * 1024);

/* ══════════════════════════════════════════════════════════════════
   A. 白盒：流式与分片边界
   ══════════════════════════════════════════════════════════════════ */
const { createUploader } = await import(path.join(ROOT, 'src/upload.mjs'));

const boxConfig = {
  ...baseConfig,
  paths: { ...baseConfig.paths, mediaRoot: TMP_MEDIA },
  thumbs: { ...baseConfig.thumbs, cacheDir: TMP_CACHE },
  upload: { enabled: true, maxFiles: 5, maxFileMB: 1000 },
};

const jsonRes = (res, code, payload) => {
  if (res.headersSent) return res.end();
  res.writeHead(code);
  res.end(JSON.stringify(payload));
};

function makeRes() {
  let settle;
  const done = new Promise((r) => {
    settle = r;
  });
  return {
    headersSent: false,
    status: 0,
    body: null,
    done,
    writeHead(code) {
      this.headersSent = true;
      this.status = code;
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null;
      settle(this);
    },
  };
}

/** 造一个分片大小可控的 multipart body，当成 req 用 */
function makeReq({ boundary, filename, payload, chunkSize }) {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const total = head.length + payload.length + tail.length;

  let emitted = 0;
  const req = new Readable({
    read() {
      if (emitted >= total) return this.push(null);
      const size = Math.min(chunkSize, total - emitted);
      const seg = Buffer.alloc(size);
      const from = emitted;
      for (let i = 0; i < size; i += 1) {
        const at = from + i;
        if (at < head.length) seg[i] = head[at];
        else if (at < head.length + payload.length) seg[i] = payload[at - head.length];
        else seg[i] = tail[at - head.length - payload.length];
      }
      emitted += size;
      this.push(seg);
    },
  });
  req.method = 'POST';
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-bm-upload': '1',
    'content-length': String(total),
  };
  return req;
}

const boxUploader = createUploader(boxConfig, { root: ROOT });
const boxSend = async (req) => {
  const res = makeRes();
  await boxUploader.handle(req, res, jsonRes);
  await res.done;
  return res;
};

await fsp.rm(WORK, { recursive: true, force: true });
await fsp.mkdir(TMP_MEDIA, { recursive: true });

section('A1. 极限分片：body 按 3 字节切开，boundary 反复跨界');
{
  const payload = crypto.randomBytes(512 * 1024);
  const res = await boxSend(
    makeReq({ boundary: '----ChoppyBoundary0123', filename: 'a.jpg', payload, chunkSize: 3 }),
  );
  ok('HTTP 200', res.status === 200, JSON.stringify(res.body));
  const dir = path.join(TMP_MEDIA, res.body.date, res.body.dir);
  const files = await fsp.readdir(dir);
  ok('落下一个文件（没被切成多个 part）', files.length === 1, files.join(','));
  const got = await fsp.readFile(path.join(dir, files[0]));
  ok('内容逐字节一致', got.equals(payload), `${got.length} vs ${payload.length}`);
}

section('A2. 内容里混入 "\\r\\n--boundary" 但不是真分隔符');
{
  const boundary = '----BoundaryWithDecoy';
  const decoy = Buffer.from(`\r\n--${boundary}X我在内容里但不是分隔符`);
  const payload = Buffer.concat([crypto.randomBytes(256 * 1024), decoy, crypto.randomBytes(64 * 1024)]);
  const res = await boxSend(makeReq({ boundary, filename: 'b.jpg', payload, chunkSize: 4096 }));
  ok('HTTP 200', res.status === 200, JSON.stringify(res.body));
  const dir = path.join(TMP_MEDIA, res.body.date, res.body.dir);
  const files = await fsp.readdir(dir);
  const got = await fsp.readFile(path.join(dir, files[0]));
  ok('含伪分隔符的内容仍然完整', got.equals(payload), `${got.length} vs ${payload.length}`);
  ok('伪分隔符原样保留在文件里', got.includes(decoy));
}

section('A3. 200MB 流式上传：RSS 不该跟着涨（背压真的生效）');
{
  const TOTAL = 200 * 1024 * 1024;
  const boundary = '----BigStreamBoundary';
  const block = Buffer.alloc(64 * 1024, 0xa5); // 同一块反复发，源数据本身不占内存
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="big.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const total = head.length + TOTAL + tail.length;

  let emitted = 0;
  const req = new Readable({
    read() {
      if (emitted >= total) return this.push(null);
      const next = emitted < head.length ? head : emitted < head.length + TOTAL ? block : tail;
      emitted = Math.min(emitted + next.length, total);
      this.push(next);
    },
  });
  req.method = 'POST';
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-bm-upload': '1',
    'content-length': String(total),
  };

  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  let peak = rssBefore;
  const ticker = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);

  const res = await boxSend(req);
  clearInterval(ticker);

  ok('HTTP 200', res.status === 200, JSON.stringify(res.body));
  ok('服务端收到 200MB', res.body?.bytes === TOTAL, `${res.body?.bytes} vs ${TOTAL}`);

  const dest = path.join(TMP_MEDIA, res.body.date, res.body.dir, '001.mp4');
  const stat = await fsp.stat(dest);
  ok('落盘 200MB（没截断）', stat.size === TOTAL, `${stat.size} vs ${TOTAL}`);

  const fh = await fsp.open(dest, 'r');
  const headProbe = Buffer.alloc(4096);
  const midProbe = Buffer.alloc(4096);
  await fh.read(headProbe, 0, 4096, 0);
  await fh.read(midProbe, 0, 4096, 100 * 1024 * 1024);
  await fh.close();
  ok('首段内容正确', headProbe.every((b) => b === 0xa5));
  ok('中段内容正确', midProbe.every((b) => b === 0xa5));
  await fsp.rm(dest);

  const growMb = (peak - rssBefore) / 1048576;
  ok(`峰值 RSS 增幅 ${growMb.toFixed(1)}MB < 60MB（200MB body 没进内存）`, growMb < 60, `${growMb.toFixed(1)}MB`);
  note(`RSS ${(rssBefore / 1048576).toFixed(1)}MB → 峰值 ${(peak / 1048576).toFixed(1)}MB`);
  if (!global.gc) note('（没带 --expose-gc，读数是上界，仍然够用）');
}

/* ══════════════════════════════════════════════════════════════════
   B. 端到端：临时服务 + 真实 multipart
   ══════════════════════════════════════════════════════════════════ */

// 临时配置：只把路径指向工作区，其它全继承真实配置（kids 要留着，测宝宝归属）
//
// auth 必须显式关掉：真实配置里 auth.enabled 默认是 true，而认证是否配了账号
// 由使用者决定。若照搬过来、恰好没配 users，服务会对上传回 503 AUTH_NOT_CONFIGURED，
// 于是这个脚本测的就不再是「上传链路」而是「认证配置」了 —— 那属于 verify-auth.mjs 的范围。
// 这里只关心没有认证介入时的上传行为，所以把它关掉，让这条用例的成败只反映上传本身。
await fsp.mkdir(path.dirname(CONFIG_ABS), { recursive: true });
fs.writeFileSync(
  CONFIG_ABS,
  `// 由 scripts/verify-upload.mjs 生成，跑完即删
import base from ${JSON.stringify(path.relative(path.dirname(CONFIG_ABS), path.join(ROOT, 'moments.config.mjs')))};
export default {
  ...base,
  paths: { ...base.paths, mediaRoot: ${JSON.stringify(path.relative(ROOT, TMP_MEDIA))} },
  thumbs: { ...base.thumbs, cacheDir: ${JSON.stringify(path.relative(ROOT, TMP_CACHE))} },
  auth: { ...base.auth, enabled: false },
  upload: { enabled: true, maxFiles: 3, maxFileMB: 25 },
  server: { ...base.server, watch: false },
};
`,
);

const freePort = () =>
  new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(
  process.execPath,
  [path.join(ROOT, 'src/cli.mjs'), 'serve', `--config=${CONFIG_REL}`, `--port=${PORT}`, '--no-watch'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOut = '';
server.stdout.on('data', (d) => (serverOut += d.toString()));
server.stderr.on('data', (d) => (serverOut += d.toString()));

let serverDead = false;
const stopServer = () => {
  if (serverDead) return;
  serverDead = true;
  try {
    server.kill('SIGKILL');
  } catch {
    /* ignore */
  }
};
process.on('exit', stopServer);
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

/** 轮询等端口起来 */
async function waitReady(ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/feed`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

if (!(await waitReady())) {
  console.error(`\n临时服务起不来（${BASE}）：\n${serverOut.split('\n').slice(-15).join('\n')}`);
  stopServer();
  await fsp.rm(WORK, { recursive: true, force: true });
  process.exit(2);
}

const upload = async ({ files = [], fields = {}, headers = {}, signal } = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) {
    fd.append('files', new Blob([f.buf], { type: f.type || 'application/octet-stream' }), f.name);
  }
  const h = { 'X-BM-Upload': '1', ...headers };
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: fd, headers: h, signal });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 可能是空响应 */
  }
  return { status: res.status, body };
};

const listDir = async (p) =>
  (await fsp.readdir(p, { withFileTypes: true }).catch(() => [])).map((d) => d.name).sort();

await fsp.rm(TEST_DIR, { recursive: true, force: true });

section('B1. 基本上传：2 图 + 1 视频，带标题/文案/宝宝/时间/地点');
{
  const r = await upload({
    files: [
      { buf: JPG, name: 'IMG_0001.jpg', type: 'image/jpeg' },
      { buf: JPG2, name: 'IMG_0002.jpg', type: 'image/jpeg' },
      { buf: MP4, name: 'IMG_0003.mp4', type: 'video/mp4' },
    ],
    fields: {
      date: TEST_DATE,
      title: '测试动态',
      caption: '这是第一行\n这是第二行',
      kid: 'k1',
      time: '14:30',
      location: '外婆家',
    },
  });
  ok('HTTP 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
  ok('返回 ok=true', r.body?.ok === true);
  ok('目录名 = 001-测试动态', r.body?.dir === '001-测试动态', r.body?.dir);
  ok('识别到 3 个文件', r.body?.files === 3, String(r.body?.files));

  const names = await listDir(TEST_DIR);
  ok('日期目录已建出', names.includes('001-测试动态'), names.join(','));

  const inner = await listDir(path.join(TEST_DIR, '001-测试动态'));
  ok(
    '媒体重命名成 001/002/003 且保留扩展名',
    inner.join(' ') === '001.jpg 002.jpg 003.mp4 caption.md meta.json',
    inner.join(' '),
  );

  const meta = JSON.parse(await fsp.readFile(path.join(TEST_DIR, '001-测试动态/meta.json'), 'utf8'));
  ok('meta.title 正确', meta.title === '测试动态', JSON.stringify(meta));
  ok('meta.kid 写成 id', meta.kid === 'k1', JSON.stringify(meta));
  ok('meta.time 正确', meta.time === '14:30', JSON.stringify(meta));
  ok('meta.location 正确', meta.location === '外婆家', JSON.stringify(meta));

  const cap = await fsp.readFile(path.join(TEST_DIR, '001-测试动态/caption.md'), 'utf8');
  ok('caption.md 落盘为 LF 换行', cap.trim() === '这是第一行\n这是第二行', JSON.stringify(cap));

  const src = await fsp.readFile(path.join(TEST_DIR, '001-测试动态/001.jpg'));
  ok('图片字节完整（没被截断）', src.equals(JPG), `${src.length} vs ${JPG.length}`);

  const vid = await fsp.readFile(path.join(TEST_DIR, '001-测试动态/003.mp4'));
  ok('视频字节完整', vid.equals(MP4), `${vid.length} vs ${MP4.length}`);
}

section('B2. 实况照片：同名 jpg + mp4 共用同一序号（会自动配成封面）');
{
  const r = await upload({
    files: [
      { buf: JPG, name: 'IMG_9999.jpg', type: 'image/jpeg' },
      { buf: MP4, name: 'IMG_9999.mp4', type: 'video/mp4' },
    ],
    fields: { date: TEST_DATE, title: '实况' },
  });
  ok('HTTP 200', r.status === 200, JSON.stringify(r.body));
  const inner = await listDir(path.join(TEST_DIR, '002-实况'));
  ok('重命名为 001.jpg + 001.mp4', inner.join(' ') === '001.jpg 001.mp4 meta.json', inner.join(' '));
}

section('B3. 不写标题：目录名就是纯序号');
{
  const r = await upload({
    files: [{ buf: JPG, name: '随手拍.jpg', type: 'image/jpeg' }],
    fields: { date: TEST_DATE },
  });
  ok('HTTP 200', r.status === 200, JSON.stringify(r.body));
  ok('目录名 = 003（纯序号）', r.body?.dir === '003', r.body?.dir);
  const inner = await listDir(path.join(TEST_DIR, '003'));
  ok('只落一个媒体，不写 meta.json', inner.join(' ') === '001.jpg', inner.join(' '));
}

section('B4. 中文文件名与中文标题');
{
  const r = await upload({
    files: [{ buf: JPG, name: '宝宝的照片-01.jpg', type: 'image/jpeg' }],
    fields: { date: TEST_DATE, title: '公园里的下午茶' },
  });
  ok('HTTP 200', r.status === 200, JSON.stringify(r.body));
  ok('中文标题进目录名', r.body?.dir === '004-公园里的下午茶', r.body?.dir);
}

section('B5. 并发 3 个上传：序号不撞车');
{
  const rs = await Promise.all(
    ['A', 'B', 'C'].map((t) =>
      upload({
        files: [{ buf: JPG, name: `${t}.jpg`, type: 'image/jpeg' }],
        fields: { date: TEST_DATE, title: `并发${t}` },
      }),
    ),
  );
  const dirs = rs.map((r) => r.body?.dir).sort();
  ok('三个请求都 200', rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
  ok('序号互不相同', new Set(dirs).size === 3, dirs.join(','));
  // 哪个请求拿到哪个序号取决于到达顺序，只断言序号集合连续
  const seqs = rs.map((r) => Number((r.body?.dir || '').slice(0, 3))).sort((a, b) => a - b);
  ok('序号连续且接在 004 之后', seqs.join(',') === '5,6,7', seqs.join(','));
}

section('B6. 参数校验');
{
  const bad = await upload({ files: [{ buf: JPG, name: 'a.jpg' }], fields: { date: '2026-13-45' } });
  ok('非法日期 → 400', bad.status === 400, `${bad.status} ${JSON.stringify(bad.body)}`);

  const noFile = await upload({ files: [], fields: { date: TEST_DATE } });
  ok('没有文件 → 400', noFile.status === 400, `${noFile.status} ${JSON.stringify(noFile.body)}`);

  const badExt = await upload({
    files: [{ buf: Buffer.from('hi'), name: 'notes.txt' }],
    fields: { date: TEST_DATE },
  });
  ok('不支持的扩展名 → 415', badExt.status === 415, `${badExt.status} ${JSON.stringify(badExt.body)}`);

  const empty = await upload({ files: [{ buf: Buffer.alloc(0), name: 'blank.jpg' }], fields: { date: TEST_DATE } });
  ok('空文件 → 400', empty.status === 400, `${empty.status} ${JSON.stringify(empty.body)}`);

  const badTime = await upload({
    files: [{ buf: JPG, name: 't.jpg' }],
    fields: { date: TEST_DATE, title: '时间不合法', time: '25:99' },
  });
  ok('非法时间被丢弃（不报错）', badTime.status === 200, `${badTime.status} ${JSON.stringify(badTime.body)}`);
  const metaT = JSON.parse(await fsp.readFile(path.join(TEST_DIR, `${badTime.body.dir}/meta.json`), 'utf8'));
  ok('meta 里没有非法时间', !metaT.time, JSON.stringify(metaT.time));

  const tooMany = await upload({
    files: ['a', 'b', 'c', 'd'].map((n) => ({ buf: JPG, name: `${n}.jpg`, type: 'image/jpeg' })),
    fields: { date: TEST_DATE, title: '超量' },
  });
  ok('超过 maxFiles(3) → 400', tooMany.status === 400, `${tooMany.status} ${JSON.stringify(tooMany.body)}`);

  const tooBig = await upload({
    files: [{ buf: makeMp4(30 * 1024 * 1024), name: 'huge.mp4', type: 'video/mp4' }],
    fields: { date: TEST_DATE, title: '超大' },
  });
  ok('超过 maxFileMB(25) → 413', tooBig.status === 413, `${tooBig.status} ${JSON.stringify(tooBig.body)}`);
}

section('B7. 安全');
{
  const noHdr = await upload({
    files: [{ buf: JPG, name: 'a.jpg' }],
    fields: { date: TEST_DATE },
    headers: { 'X-BM-Upload': '' },
  });
  ok('缺少上传标识 → 403', noHdr.status === 403, `${noHdr.status} ${JSON.stringify(noHdr.body)}`);

  const cross = await upload({
    files: [{ buf: JPG, name: 'a.jpg' }],
    fields: { date: TEST_DATE },
    headers: { Origin: 'https://evil.example' },
  });
  ok('跨站 Origin → 403', cross.status === 403, `${cross.status} ${JSON.stringify(cross.body)}`);

  const same = await upload({
    files: [{ buf: JPG, name: 'same.jpg' }],
    fields: { date: TEST_DATE, title: '同源' },
    headers: { Origin: BASE },
  });
  ok('同源 Origin 放行 → 200', same.status === 200, `${same.status} ${JSON.stringify(same.body)}`);

  // 目录穿越：标题与文件名里都塞 ../..
  const evil = await upload({
    files: [{ buf: JPG, name: '../../etc/passwd.jpg' }],
    fields: { date: TEST_DATE, title: '../../../../tmp/escape' },
  });
  ok('恶意标题/文件名被安全化', evil.status === 200, JSON.stringify(evil.body));
  ok('没有写到工作区之外', !fs.existsSync('/tmp/escape'));
  const names = await listDir(TEST_DIR);
  ok(
    '穿越片段被清掉',
    names.some((n) => !n.includes('/') && !n.includes('..') && n.includes('escape')),
    names.join(','),
  );

  const getIt = await fetch(`${BASE}/api/upload`, { headers: { 'X-BM-Upload': '1' } });
  ok('GET /api/upload → 405', getIt.status === 405, String(getIt.status));

  const wrongType = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'X-BM-Upload': '1', 'Content-Type': 'application/json' },
    body: '{}',
  });
  ok('非 multipart → 400', wrongType.status === 400, String(wrongType.status));
}

section('B8. 上传后扫描器能正确读出来');
{
  const res = await fetch(`${BASE}/api/feed?refresh=1`);
  const feed = await res.json();
  const mine = feed.entries.filter((e) => e.date === TEST_DATE);
  // 上面每一段各自会建出几条：B1 1 + B2 1 + B3 1 + B4 1 + B5 3 + B6 时间不合法 1
  // + B7 同源 1 + B7 穿越 1 = 10。写成定值是为了让「意外多建/少建目录」也能被抓住。
  ok(
    '扫到全部新动态（10 条）',
    mine.length === 10,
    `实际 ${mine.length}：${mine.map((e) => e.key).join(' | ')}`,
  );

  const t1 = mine.find((e) => e.key.endsWith('001-测试动态'));
  ok('带标题的动态标题正确', t1?.title === '测试动态', t1?.title);
  // 注意是「配置里 k1 叫什么」，不是某个固定名字 —— moments.config.mjs 是用户可编辑的
  ok(
    `宝宝归属正确（k1 = ${KID_NAME ?? '配置里没有 k1！'}）`,
    Boolean(KID_NAME) && t1?.kid?.id === KID_UNDER_TEST && t1?.kid?.name === KID_NAME,
    JSON.stringify(t1?.kid),
  );
  ok('年龄按拍摄日算', Boolean(t1?.age), t1?.age);
  ok('时间 14:30 生效', t1?.time === '14:30', t1?.time);
  ok('地点生效', t1?.location === '外婆家', t1?.location);
  ok('文案多行保留', t1?.caption === '这是第一行\n这是第二行', JSON.stringify(t1?.caption));
  ok('3 个媒体：2 图 1 视频', t1?.counts.image === 2 && t1?.counts.video === 1, JSON.stringify(t1?.counts));
  ok('dir 字段可用（修掉 photos/undefined）', t1?.dir === `${TEST_DATE}/001-测试动态`, t1?.dir);

  const bare = mine.find((e) => e.key.endsWith('/003'));
  ok('纯序号目录 → 无标题（不再显示 "003"）', bare && bare.title === '', JSON.stringify(bare?.title));

  const live = mine.find((e) => e.key.endsWith('002-实况'));
  ok(
    '实况照片：jpg 被标记为 poster 且不重复展示',
    live?.media.length === 1 && live.media[0].kind === 'video',
    JSON.stringify(live?.media.map((m) => `${m.name}:${m.role}`)),
  );
  ok(
    '实况照片的视频有封面 URL',
    Boolean(live?.media[0]?.urls?.poster || live?.media[0]?.urls?.grid),
    JSON.stringify(live?.media[0]?.urls),
  );
}

section('B9. 缩略图能按需生成（新上传的照片立刻可看）');
{
  const res = await fetch(`${BASE}/api/feed`);
  const feed = await res.json();
  const t1 = feed.entries.find((e) => e.key.endsWith('001-测试动态'));
  let images = 0;
  for (const m of t1.media) {
    for (const [variant, url] of [
      ['grid', m.urls.grid],
      ['view', m.urls.view],
    ]) {
      if (!url) continue;
      const r = await fetch(`${BASE}${url}`);
      if (m.kind === 'video') {
        note(`${m.name} 的 ${variant} 缩略图 → HTTP ${r.status}（本机没有 ffmpeg/QuickLook 时抽帧必然失败，前端会渲染瓦片，不算错误）`);
      } else {
        images += 1;
        ok(`${m.name} 的 ${variant} 缩略图 200`, r.status === 200, `${r.status} ${url}`);
      }
    }
  }
  ok('照片缩略图确实跑了 4 次（2 张 × grid/view）', images === 4, String(images));
}

section('B10. 上传中断：临时目录与照片库都不能留半成品');
{
  const beforeStage = await listDir(STAGE_ROOT);
  const beforeEntries = await listDir(TEST_DIR);

  const ac = new AbortController();
  const fd = new FormData();
  fd.append('date', TEST_DATE);
  fd.append('files', new Blob([makeMp4(48 * 1024 * 1024)]), 'interrupted.mp4');
  const pending = fetch(`${BASE}/api/upload`, {
    method: 'POST',
    body: fd,
    headers: { 'X-BM-Upload': '1' },
    signal: ac.signal,
  }).catch(() => null);
  setTimeout(() => ac.abort(), 80);
  await pending;
  await new Promise((r) => setTimeout(r, 800));

  const afterStage = await listDir(STAGE_ROOT);
  ok('暂存目录没有残留', afterStage.length === beforeStage.length, `${beforeStage.length} → ${afterStage.length}`);
  const afterEntries = await listDir(TEST_DIR);
  ok('照片库里没有半成品条目', afterEntries.length === beforeEntries.length, afterEntries.join(','));
}

/* ── 收尾 ─────────────────────────────────────────────────────────── */
stopServer();
await fsp.rm(WORK, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log(`\n失败项：\n - ${failures.join('\n - ')}`);
console.log(`临时工作区已清理：${path.relative(ROOT, WORK)}（真实 photos/ 全程未被触碰）\n`);
process.exit(fail ? 1 : 0);
