#!/usr/bin/env node
/**
 * 并发与原子性的自包含验证  ——  node scripts/verify-concurrency.mjs
 *
 * 为什么单独一个脚本：多人（多标签页 / 手机 + 电脑 / 多个服务进程）同时往
 * 同一个日期里发动态时，会踩到两类"平时看不见、出事就是脏数据"的问题：
 *
 *   ① 分组不是原子的 —— 读者（另一个人的页面 / fs.watch 触发的重扫 / 命令行 scan）
 *      可能恰好撞见"目录已经建出来、文件才搬进去一半"的中间态。
 *   ② 序号撞车 —— order 模式要"读出已用序号再 +1"，这是个读-改-写，
 *      两个写入者读到同一份快照就会占同一个号（同标题下直接 mkdir EEXIST 报错）。
 *
 * 这两件事都只在并发下发生，靠人工点几下测不出来，所以固化在这里。
 *
 * 五段：
 *   A. 原子性 —— 一边喂 body 一边用 setImmediate 轮询日期目录，数"半成品"观察到多少次。
 *   B. 进程内并发 —— 8 个请求同时打同一天，核对目录名唯一 + 序号连续。
 *   C. 跨进程并发 —— 3 个子进程各传 3 条（父进程 spawn 自己，--worker 角色）。
 *   D. time 命名模式 —— 目录名形态、并发不重名、扫描器能剥离前缀、顺序按时间。
 *   E. 锁本身 —— 陈旧锁 / 死进程锁能被抢占，活锁会等到超时回 503（而不是无锁放行）。
 *
 * 全程只动 <root>/.cache/verify-concurrency/（临时照片库 + 临时缓存），跑完自删，
 * 绝不碰 photos/。开头有硬闸门再确认一次。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.cache/verify-concurrency');
const MEDIA = path.join(WORK, 'photos');
const CACHE = path.join(WORK, 'cache');
const LOCKS = path.join(CACHE, 'locks');

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
   注意别写成「MEDIA 是否包含于 WORK」—— 它俩本来就是父子关系，
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

/* ── 配置工厂 ─────────────────────────────────────────────────────── */
const makeConfig = (over = {}) => ({
  ...baseConfig,
  paths: { ...baseConfig.paths, mediaRoot: MEDIA },
  thumbs: { ...baseConfig.thumbs, cacheDir: CACHE },
  upload: { enabled: true, maxFiles: 30, maxFileMB: 1000, ...over },
});

const config = makeConfig();

/* ── 夹具 ─────────────────────────────────────────────────────────── */
const { createUploader } = await import(path.join(ROOT, 'src/upload.mjs'));
const { createScanner } = await import(path.join(ROOT, 'src/scan.mjs'));
const sharp = (await import('sharp')).default;

/** 造一张真 JPEG（sharp 能解、缩略图能生成 —— 扫描器不会因为解不开而报 warning） */
async function makeJpeg(seed) {
  const [r, g, b] = [(seed * 60) % 256, 140, (seed * 97) % 200];
  return sharp({ create: { width: 320, height: 240, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 80 })
    .toBuffer();
}
const JPG = await makeJpeg(1);

/* ── 把 uploader.handle 当普通函数调用所需的假 req/res ───────────── */
const jsonRes = (res, code, payload) => {
  res.writeHead(code);
  res.end(JSON.stringify(payload));
};

function makeRes() {
  let settle;
  const done = new Promise((r) => (settle = r));
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

function buildBody(boundary, files, fields) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        f.buf,
        Buffer.from('\r\n'),
      ]),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function makeReq(boundary, body, chunkSize) {
  let sent = 0;
  const req = new Readable({
    read() {
      if (sent >= body.length) return this.push(null);
      const n = Math.min(chunkSize, body.length - sent);
      this.push(body.subarray(sent, sent + n));
      sent += n;
    },
  });
  req.method = 'POST';
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-bm-upload': '1',
    'content-length': String(body.length),
  };
  return req;
}

let boundarySeq = 0;
async function uploadOnce(uploader, { files, fields, chunkSize = 64 * 1024, user = null }) {
  const boundary = `----VerifyConcurrency${(boundarySeq += 1)}`;
  const body = buildBody(boundary, files, fields);
  const res = makeRes();
  await uploader.handle(makeReq(boundary, body, chunkSize), res, jsonRes, { user });
  await res.done;
  return { status: res.status, body: res.body };
}

const readDirNames = (dir) => fsp.readdir(dir).catch(() => []);

/* ══════════════════════════════════════════════════════════════════
   C 段的子进程角色 —— 必须在父进程的准备动作之前分流出去，
   免得子进程把父进程刚建好的临时库又删一遍。
   ══════════════════════════════════════════════════════════════════ */
const workerIdx = process.argv.indexOf('--worker');
if (workerIdx !== -1) {
  const tag = process.argv[workerIdx + 1];
  const date = process.argv[workerIdx + 2];
  const uploader = createUploader(config, { root: ROOT });
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await uploadOnce(uploader, {
      files: [{ name: `${tag}${i}.jpg`, buf: JPG }],
      fields: { date, title: `进程${tag}` },
      chunkSize: 8 * 1024,
    });
    out.push({ status: r.status, dir: r.body?.dir || null, error: r.body?.error || null });
  }
  process.stdout.write(`@@RESULT@@${JSON.stringify(out)}\n`);
  process.exit(0);
}

/* ── 父进程：准备临时库 ───────────────────────────────────────────── */
await fsp.rm(WORK, { recursive: true, force: true });
await fsp.mkdir(MEDIA, { recursive: true });
await fsp.mkdir(CACHE, { recursive: true });

/* ══════════════════════════════════════════════════════════════════
   A. 分组是原子的：读者永远看不到半成品目录
   ══════════════════════════════════════════════════════════════════ */
section('A. 单条上传的原子性（边传边轮询）');
{
  const DATE = '2001-02-03';
  const dateDir = path.join(MEDIA, DATE);
  await fsp.mkdir(dateDir, { recursive: true });

  const uploader = createUploader(config, { root: ROOT });
  const FILES = [
    { name: 'a.jpg', buf: Buffer.alloc(120 * 1024, 1) },
    { name: 'b.jpg', buf: Buffer.alloc(120 * 1024, 2) },
    { name: 'c.jpg', buf: Buffer.alloc(120 * 1024, 3) },
  ];
  const EXPECTED = 5; // 3 个媒体 + caption.md + meta.json

  let observations = 0;
  let partial = 0;
  let worst = '';
  let polling = true;
  const poll = async () => {
    while (polling) {
      observations += 1;
      const groups = (await fsp.readdir(dateDir, { withFileTypes: true }).catch(() => [])).filter(
        (d) => d.isDirectory(),
      );
      for (const g of groups) {
        const files = await readDirNames(path.join(dateDir, g.name));
        // 还没搬完（或搬完了但组目录提前可见）都算半成品
        if (files.length !== EXPECTED) {
          partial += 1;
          if (!worst) {
            worst = `${g.name} 只看到 ${files.length}/${EXPECTED}：${[...files].sort().join(' ')}`;
          }
        }
      }
      // setImmediate 让轮询插进每一次 await fs.* 的让出点，观察密度才够
      await new Promise((r) => setImmediate(r));
    }
  };

  const poller = poll();
  const r = await uploadOnce(uploader, {
    files: FILES,
    fields: { date: DATE, title: '原子性探针', caption: '一句话' },
  });
  // 上传返回后再多观察一小会儿，覆盖"rename 完成 → finally 清理暂存区"这段
  await new Promise((r2) => setTimeout(r2, 50));
  polling = false;
  await poller;

  const finalDirs = await readDirNames(dateDir);
  ok(`上传成功（HTTP ${r.status}）`, r.status === 200, JSON.stringify(r.body));
  ok('落盘目录名带标题', String(r.body?.dir || '').endsWith('-原子性探针'), String(r.body?.dir));
  ok(
    `最终目录内容完整（${EXPECTED} 项）`,
    (await readDirNames(path.join(dateDir, r.body?.dir || ''))).length === EXPECTED,
    String((await readDirNames(path.join(dateDir, r.body?.dir || ''))).length),
  );

  note(`轮询 ${observations} 次，半成品观察 ${partial} 次`);
  if (worst) note(`最差一次：${worst}`);
  // 观察次数太少的"0 次半成品"没有说服力，所以把"真的观察了"也断言下来
  ok('轮询密度足够（> 200 次）', observations > 200, String(observations));
  ok('读者一次都没有看到半成品目录', partial === 0, worst || String(partial));
  ok('日期目录里只有这一条动态', finalDirs.length === 1, finalDirs.join(','));
}

/* ══════════════════════════════════════════════════════════════════
   B. 进程内并发：同一时刻 8 个请求抢同一天
   ══════════════════════════════════════════════════════════════════ */
section('B. 进程内并发（order 模式，8 个请求同时发）');
{
  const DATE = '2002-03-04';
  const dateDir = path.join(MEDIA, DATE);
  await fsp.mkdir(dateDir, { recursive: true });
  const uploader = createUploader(config, { root: ROOT });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      uploadOnce(uploader, {
        files: [{ name: `f${i}.jpg`, buf: JPG }],
        fields: { date: DATE, title: `并发${i}` },
      }),
    ),
  );

  const failed = results.filter((r) => r.status !== 200);
  ok('8 个请求全部成功', failed.length === 0, failed.map((f) => `${f.status}`).join(','));

  const dirs = results.map((r) => r.body?.dir).filter(Boolean);
  ok('目录名两两不同', new Set(dirs).size === dirs.length, dirs.join(' | '));

  const seqs = dirs.map((d) => Number(String(d).slice(0, 3))).sort((a, b) => a - b);
  ok(
    '序号连续且唯一 1..8',
    seqs.join(',') === '1,2,3,4,5,6,7,8',
    seqs.join(','),
  );
  ok('磁盘上的目录数 = 8', (await readDirNames(dateDir)).length === 8, String((await readDirNames(dateDir)).length));

  // 顺序：未写 time 时按目录名自然序兜底，所以 order 模式下目录名顺序 = 发布顺序
  const scanned = await createScanner(config, { root: ROOT }).scan();
  const dayEntries = scanned.entries.filter((e) => e.date === DATE);
  ok('扫描出 8 条', dayEntries.length === 8, String(dayEntries.length));
  ok(
    '扫描器把前缀当序号、标题只剩正文',
    dayEntries.every((e) => /^并发\d$/.test(e.title)),
    dayEntries.map((e) => e.title).join(','),
  );
}

/* ══════════════════════════════════════════════════════════════════
   C. 跨进程并发：3 个进程各传 3 条
   ══════════════════════════════════════════════════════════════════ */
section('C. 跨进程并发（3 个子进程 × 3 条，脚本自己 spawn 自己）');
{
  const DATE = '2003-04-05';
  await fsp.mkdir(path.join(MEDIA, DATE), { recursive: true });

  const tags = ['A', 'B', 'C'];
  const children = tags.map(
    (t) =>
      new Promise((resolve) => {
        const cp = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), '--worker', t, DATE],
          { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let buf = '';
        cp.stdout.on('data', (d) => (buf += d));
        cp.stderr.on('data', (d) => (buf += d));
        cp.on('exit', (code) => {
          const m = /@@RESULT@@(.*)/.exec(buf);
          resolve({ tag: t, code, results: m ? JSON.parse(m[1]) : [], raw: buf.slice(-400) });
        });
      }),
  );

  const settled = await Promise.all(children);
  const all = settled.flatMap((c) => c.results);
  const failed = all.filter((r) => r.status !== 200);
  const dirs = all.map((r) => r.dir).filter(Boolean);
  const seqs = dirs.map((d) => Number(String(d).slice(0, 3))).sort((a, b) => a - b);

  note(`子进程退出码 ${settled.map((c) => `${c.tag}:${c.code}`).join(' ')}`);
  note(`目录名 ${dirs.join(' | ')}`);
  if (failed.length) note(`失败详情 ${failed.map((f) => `${f.status} ${f.error}`).join(' | ')}`);

  ok('子进程都正常退出', settled.every((c) => c.code === 0), settled.map((c) => `${c.tag}:${c.code}`).join(' '));
  ok('9 个请求全部成功', failed.length === 0, failed.map((f) => `${f.status} ${f.error}`).join(' | '));
  ok('目录名两两不同', new Set(dirs).size === dirs.length, dirs.join(' | '));
  ok(
    '跨进程序号连续且唯一 1..9（无锁时会得到 1,2,2,3,3,4,5,5,6 这种）',
    seqs.join(',') === '1,2,3,4,5,6,7,8,9',
    seqs.join(','),
  );
  ok(
    '磁盘上的目录数 = 9',
    (await readDirNames(path.join(MEDIA, DATE))).length === 9,
    String((await readDirNames(path.join(MEDIA, DATE))).length),
  );
}

/* ══════════════════════════════════════════════════════════════════
   D. time 命名模式（前缀不用数字，但仍然时间可排序）
   ══════════════════════════════════════════════════════════════════ */
section('D. time 命名模式（HHmmss-随机，时间可排序）');
{
  const DATE = '2004-05-06';
  const dateDir = path.join(MEDIA, DATE);
  await fsp.mkdir(dateDir, { recursive: true });
  const timeConfig = makeConfig({ naming: 'time' });
  const uploader = createUploader(timeConfig, { root: ROOT });

  // D1. 形态：写了 time 就用它（补 00 秒）
  const one = await uploadOnce(uploader, {
    files: [{ name: 'a.jpg', buf: JPG }],
    fields: { date: DATE, title: '公园', time: '13:16' },
  });
  ok('上传成功', one.status === 200, JSON.stringify(one.body));
  ok(
    '目录名形如 131600-xxxx-公园',
    /^131600-[0-9a-z]{4}-公园$/.test(String(one.body?.dir || '')),
    String(one.body?.dir),
  );
  ok('前缀是 6 位定长数字（字典序=时间序）', /^131600$/.test(String(one.body?.dir || '').slice(0, 6)));

  const stripped = await createScanner(timeConfig, { root: ROOT }).scan();
  const e1 = stripped.entries.find((e) => e.date === DATE);
  ok('扫描器剥离前缀：标题是「公园」而不是整串目录名', e1?.title === '公园', e1?.title);
  ok('扫描结果带 time', e1?.time === '13:16', String(e1?.time));

  // D2. 并发不重名
  const many = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      uploadOnce(uploader, {
        files: [{ name: `m${i}.jpg`, buf: JPG }],
        fields: { date: DATE, title: '同时', time: '09:00' },
      }),
    ),
  );
  const dirs = many.map((r) => r.body?.dir).filter(Boolean);
  ok('8 个并发请求全部成功', many.every((r) => r.status === 200), many.map((r) => r.status).join(','));
  ok('同一分钟内 8 个目录名两两不同（随机段去重）', new Set(dirs).size === dirs.length, dirs.join(' | '));

  // D3. 纯前缀目录（没写标题）→ 标题为空，不该把前缀当标题
  const bare = await uploadOnce(uploader, {
    files: [{ name: 'b.jpg', buf: JPG }],
    fields: { date: DATE, time: '11:11' },
  });
  ok('无标题时目录名只有 111100-xxxx', /^111100-[0-9a-z]{4}$/.test(String(bare.body?.dir || '')), String(bare.body?.dir));

  // D4. 顺序：写了 time 的按时间排（同日降序 = 新的在前）
  const DATE2 = '2004-05-07';
  await fsp.mkdir(path.join(MEDIA, DATE2), { recursive: true });
  for (const t of ['08:00', '10:30', '09:15']) {
    const r = await uploadOnce(uploader, {
      files: [{ name: 'x.jpg', buf: JPG }],
      fields: { date: DATE2, title: `时刻${t}`, time: t },
    });
    ok(`写入 ${t} 成功`, r.status === 200, String(r.status));
  }
  const scanned2 = await createScanner(timeConfig, { root: ROOT }).scan();
  const times = scanned2.entries.filter((e) => e.date === DATE2).map((e) => e.time);
  ok('同日按 time 排序（新的在前）', times.join(',') === '10:30,09:15,08:00', times.join(','));
  note('顺序以 meta.json 的 time 为准；没写 time 时退回按目录名自然序，两者都不需要额外解析');

  // D5. order 模式回归 —— 改了 naming 不该影响另一种写法
  const DATE3 = '2004-05-08';
  await fsp.mkdir(path.join(MEDIA, DATE3), { recursive: true });
  const back = await uploadOnce(createUploader(makeConfig(), { root: ROOT }), {
    files: [{ name: 'z.jpg', buf: JPG }],
    fields: { date: DATE3, title: '序号模式' },
  });
  ok('order 模式仍产出 001-序号模式', back.body?.dir === '001-序号模式', String(back.body?.dir));
}

/* ══════════════════════════════════════════════════════════════════
   E. 锁本身：两条抢占条件 + 等锁超时
   ══════════════════════════════════════════════════════════════════ */
section('E. 目录锁的抢占与超时');
{
  /** 造一把锁：owner 写谁、mtime 多旧，都直接指定 */
  async function plantLock(date, { ownerPid, mtimeAgoMs }) {
    const lockPath = path.join(LOCKS, `date-${date}.lock`);
    await fsp.rm(lockPath, { recursive: true, force: true });
    await fsp.mkdir(lockPath, { recursive: true });
    await fsp.writeFile(path.join(lockPath, 'owner'), `${ownerPid}\n${Date.now()}\n`);
    const when = new Date(Date.now() - mtimeAgoMs);
    await fsp.utimes(lockPath, when, when);
    return lockPath;
  }

  // E1. 陈旧锁（mtime 超过 lockStaleMs）→ 抢占
  {
    const DATE = '2005-06-01';
    await fsp.mkdir(path.join(MEDIA, DATE), { recursive: true });
    const warns = [];
    const uploader = createUploader(makeConfig({ lockStaleMs: 1000 }), {
      root: ROOT,
      onWarn: (m) => warns.push(m),
    });
    await plantLock(DATE, { ownerPid: 999999, mtimeAgoMs: 60_000 });

    const r = await uploadOnce(uploader, {
      files: [{ name: 'a.jpg', buf: JPG }],
      fields: { date: DATE, title: '陈旧锁' },
    });
    ok('陈旧锁被抢占后上传成功', r.status === 200, JSON.stringify(r.body));
    ok('发出过抢占告警', warns.some((w) => /陈旧/.test(w)), warns.join(' | '));
    ok('锁已被释放（不残留）', !(await fsp.stat(path.join(LOCKS, `date-${DATE}.lock`)).then(() => true, () => false)));
  }

  // E2. 新 mtime 但持有者进程已死 → 抢占（这条只在"同机被 kill"时才走）
  {
    const DATE = '2005-06-02';
    await fsp.mkdir(path.join(MEDIA, DATE), { recursive: true });

    // 起一个立刻退出的子进程，拿它已经回收的 pid —— 比硬编 999999 更贴近真实场景。
    // （pid 理论上会被复用，但这里只隔几毫秒，风险可忽略；真复用了会表现为"没抢占"，
    //   下面那条断言会直接报出来，不会静默放过。）
    const deadPid = await new Promise((resolve) => {
      const cp = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      cp.on('exit', () => resolve(cp.pid));
    });

    const warns = [];
    const uploader = createUploader(makeConfig({ lockStaleMs: 30_000 }), {
      root: ROOT,
      onWarn: (m) => warns.push(m),
    });
    // mtime 是"刚刚"，所以只能靠"pid 已不存在"这一条来抢占
    await plantLock(DATE, { ownerPid: deadPid, mtimeAgoMs: 0 });

    const r = await uploadOnce(uploader, {
      files: [{ name: 'a.jpg', buf: JPG }],
      fields: { date: DATE, title: '死进程锁' },
    });
    ok('持有者已死的锁被抢占（只靠 pid 判定，mtime 很新）', r.status === 200, JSON.stringify(r.body));
    ok('发出过抢占告警', warns.some((w) => /陈旧/.test(w)), warns.join(' | '));
  }

  // E3. 活锁（自己的 pid、mtime 很新）→ 不抢，等超时回 503，绝不无锁放行
  {
    const DATE = '2005-06-03';
    await fsp.mkdir(path.join(MEDIA, DATE), { recursive: true });
    const warns = [];
    const uploader = createUploader(makeConfig({ lockStaleMs: 30_000, lockWaitMs: 800 }), {
      root: ROOT,
      onWarn: (m) => warns.push(m),
    });
    // owner 写自己的 pid，锁实现里明确把"自己持有"视为不陈旧（避免同进程自抢）
    await plantLock(DATE, { ownerPid: process.pid, mtimeAgoMs: 0 });

    const t0 = Date.now();
    const r = await uploadOnce(uploader, {
      files: [{ name: 'a.jpg', buf: JPG }],
      fields: { date: DATE, title: '活锁' },
    });
    const spent = Date.now() - t0;
    ok('等不到锁 → 503（不是无锁放行）', r.status === 503, `${r.status} ${JSON.stringify(r.body)}`);
    ok('错误码 UPLOAD，提示让人重试', r.body?.code === 'UPLOAD' && /重试/.test(r.body?.error || ''), JSON.stringify(r.body));
    ok(`确实等满了 lockWaitMs（实测 ${spent}ms）`, spent >= 700, String(spent));
    ok('没有任何东西落进日期目录', (await readDirNames(path.join(MEDIA, DATE))).length === 0);
    ok('没有误判为陈旧', warns.every((w) => !/陈旧/.test(w)), warns.join(' | '));
  }
}

/* ── 收尾 ─────────────────────────────────────────────────────────── */
await fsp.rm(WORK, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) console.log(`\n失败项：\n - ${failures.join('\n - ')}`);
console.log(`临时工作区已清理：${path.relative(ROOT, WORK)}（真实 photos/ 全程未被触碰）\n`);
process.exit(fail ? 1 : 0);
