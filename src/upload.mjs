/**
 * 上传：把浏览器发来的 multipart/form-data 落成一条新动态。
 *
 * 落盘形态就是扫描器原本认识的目录结构，所以上传完不用重启、不用手工登记：
 *   photos/2026-09-21/003-公园的下午/
 *     001.jpg   001.mov   002.jpg
 *     caption.md       ← 有文案时才写
 *     meta.json        ← 有标题/宝宝/地点/时间时才写
 *
 * 四个关键设计：
 *
 * 1. 流式解析，不落内存。
 *    push() 返回 Promise，调用方在 `for await (const c of req)` 里 await 它，
 *    背压天然成立 —— 上传 500MB 视频时进程 RSS 也不会跟着涨。
 *
 * 2. 两段式落盘。
 *    先写进 <cacheDir>/uploads/<token>/（在照片库之外），全部收完、校验通过，
 *    再在锁内分配序号并移进照片库。
 *
 * 3. 「整组原子入库」——多人同时上传时这条最关键。
 *    早先的写法是：先在 photos/<日期>/ 里 mkdir 出最终目录，再一个个把文件搬进去。
 *    那意味着目录一出现就是"空的"，随后逐个填满：任何在这段时间扫过照片库的人
 *    （另一个用户开着页面、fs.watch 触发重扫、你自己在命令行跑 scan）都会看到
 *    一条只有 1/5 张图、甚至 0 张图的动态。上传越大、文件越多，这个窗口越宽；
 *    照片库在移动硬盘上（cacheDir 与 mediaRoot 不同卷）时更宽，因为搬运退化成复制。
 *    现在改成：caption.md、meta.json、所有媒体先在暂存区**组装成一个完整目录**，
 *    最后用一次 rename 把它整体放进照片库。rename 在同一文件系统内是原子的 ⇒
 *    读者要么看不到这条动态，要么看到的就是完整的一条，不存在中间态。
 *
 * 4. 序号用「跨进程文件锁」保护。
 *    进程内的 Promise 链锁只能管住自己这一个 Node 进程。两处踩过的坑：
 *      · 同一个服务起两份（换端口做灰度、或误开了两个终端）；
 *      · 照片库放在 NAS/移动硬盘上，被多台机器同时挂载写入。
 *    这时两个进程读到的"已用序号"是同一份快照，会各自分配同一个号。
 *    实测 3 个进程各传 3 条，序号得到 1,2,2,3,3,4,5,5,6 —— 同一天里出现两个 002。
 *    所以序号分配 + 入库这一段放进一个用 mkdir 原子性实现的目录锁里，
 *    锁文件带持有者 pid，进程死掉后能被下一个上传者立刻抢占。
 *
 * 5. 同名文件共用一个序号。
 *    IMG_1234.jpg + IMG_1234.mov 会被重命名成 001.jpg + 001.mov，
 *    正好命中扫描器里「同名图片自动当视频封面」的规则（iPhone 实况照片就是这个形状）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { finished } from 'node:stream/promises';
import { extOf, humanSize, randomId, writeJsonAtomic } from './util.mjs';

/** 带 HTTP 状态码的上传错误，交给路由层直接转成响应 */
export class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

/* ─────────────────────────── multipart 解析 ─────────────────────────── */

function parseHeaders(raw) {
  const out = {};
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * 取 Content-Disposition 里的文件名。
 * 优先 RFC 5987 的 filename*=UTF-8''%E7%85%A7%E7%89%87.jpg，其次裸 filename="照片.jpg"。
 */
function filenameOf(cd) {
  if (!cd) return '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(cd);
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, '');
    const m = /^[^']*'[^']*'(.*)$/.exec(raw);
    const val = m ? m[1] : raw;
    try {
      return decodeURIComponent(val);
    } catch {
      return val;
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  return plain ? plain[1].trim() : '';
}

function fieldNameOf(cd) {
  if (!cd) return '';
  const m =
    /(?:^|;)\s*name\s*=\s*"([^"]*)"/i.exec(cd) || /(?:^|;)\s*name\s*=\s*([^;]+)/i.exec(cd);
  return m ? m[1].trim() : '';
}

/**
 * 流式 multipart/form-data 解析器。
 *
 * @param boundary  不带前导 -- 的 boundary 字符串
 * @param onFile    async ({ filename, field, type }) => sink；sink 需实现 write/end/abort
 * @param onField   async (name) => sink
 */
function createMultipart(boundary, onFile, onField) {
  const FIRST = Buffer.from(`--${boundary}`);
  const SEP = Buffer.from(`\r\n--${boundary}`);
  /** 判定一个分隔符需要多看到 2 字节（\r\n 或 --），留这么多尾巴防跨界 */
  const KEEP = SEP.length + 2;

  let buf = Buffer.alloc(0);
  let state = 'start'; // start | headers | body | done
  let sink = null;

  async function fail(err) {
    state = 'done';
    if (sink) {
      const s = sink;
      sink = null;
      await s.abort?.().catch?.(() => {});
    }
    throw err;
  }

  async function drive() {
    for (;;) {
      if (state === 'done') return;

      if (state === 'start') {
        const i = buf.indexOf(FIRST);
        if (i < 0) {
          buf = buf.slice(Math.max(0, buf.length - KEEP));
          return;
        }
        const a = i + FIRST.length;
        if (buf.length < a + 2) {
          buf = buf.slice(i);
          return;
        }
        const tail = buf.toString('latin1', a, a + 2);
        buf = buf.slice(a + 2);
        if (tail === '--') {
          state = 'done';
          return;
        }
        if (tail !== '\r\n') throw new UploadError(400, 'multipart 格式不正确');
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        const j = buf.indexOf('\r\n\r\n');
        if (j < 0) return;
        const headers = parseHeaders(buf.toString('utf8', 0, j));
        buf = buf.slice(j + 4);
        const cd = headers['content-disposition'] || '';
        const filename = filenameOf(cd);
        const field = fieldNameOf(cd);
        sink = filename
          ? await onFile({ filename, field, type: headers['content-type'] || '' })
          : await onField(field);
        state = 'body';
        continue;
      }

      // state === 'body'：找真正的分隔符。
      // 数据里也可能出现 \r\n--boundary 这串字节，只有后面跟 \r\n 或 -- 才是分隔符。
      let hit = -1;
      let need = false;
      let mark = '';
      for (let from = 0; ; ) {
        const i = buf.indexOf(SEP, from);
        if (i < 0) break;
        const a = i + SEP.length;
        if (buf.length < a + 2) {
          hit = i;
          need = true;
          break;
        }
        const t = buf.toString('latin1', a, a + 2);
        if (t === '\r\n' || t === '--') {
          hit = i;
          mark = t;
          break;
        }
        from = i + 1;
      }

      if (need) {
        // 位置已知但还差后面 2 字节。先把 hit 之前的确定数据冲出去。
        if (hit > 0) {
          await sink.write(buf.slice(0, hit));
          buf = buf.slice(hit);
        }
        return;
      }

      if (hit < 0) {
        const safe = buf.length - KEEP;
        if (safe > 0) {
          await sink.write(buf.slice(0, safe));
          buf = buf.slice(safe);
        }
        return;
      }

      if (hit > 0) await sink.write(buf.slice(0, hit));
      buf = buf.slice(hit + SEP.length + 2);
      const closed = sink;
      sink = null;
      await closed.end();
      state = mark === '--' ? 'done' : 'headers';
    }
  }

  return {
    async push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        await drive();
      } catch (err) {
        await fail(err);
      }
    },
    /** body 提前断掉时（连接中断）把半截 sink 收干净，不让写流泄漏 */
    async end() {
      try {
        await drive();
      } finally {
        if (sink) {
          const s = sink;
          sink = null;
          await s.abort?.().catch?.(() => {});
        }
      }
    },
  };
}

/* ─────────────────────────── 目录名安全化 ─────────────────────────── */

/**
 * 目录名安全化：去掉路径分隔符与 Windows 保留字符（防穿越），
 * 顺带清掉控制字符和首尾的点/空白（".", ".." 这种名字会被清空）。
 */
export function safeDirName(s, max = 60) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, max)
    .trim();
}

const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** 只认 1~3 位且后面不是数字的前缀，"2026-xx" 这种不会被误当成序号 */
const SEQ_RE = /^(\d{1,3})(?:\D|$)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「目标已存在」的判定。
 *
 * 常规运行时就是 err.code === 'EEXIST'，但有些环境会在中间插一层文件系统代理，
 * 把 code 换成自己的名字，只在 message 里保留原生前缀（实测本机沙箱返回
 * code=CODEBUDDY_BROKER_DENY、message="EEXIST: file already exists, mkdir ..."）。
 * 锁的正确性完全押在这个判断上，所以两边都认，代价只是多一次字符串前缀比较。
 *
 * 反过来说：**判断不出来的时候不能放行**。早先的写法是「非 EEXIST 就当锁不可用，
 * 退化成进程内锁继续跑」—— 在这种环境里那意味着跨进程锁从来没生效过，
 * 而且一声不响。宁可这次上传失败，也不要悄悄失去互斥。
 */
const isExists = (err) =>
  err?.code === 'EEXIST' || /^EEXIST\b/.test(String(err?.message || ''));

/** 同理：跨设备判断也要容忍 code 被替换 */
const isExdev = (err) => err?.code === 'EXDEV' || /^EXDEV\b/.test(String(err?.message || ''));

/* ─────────────────────────── 跨进程目录锁 ─────────────────────────── */

/**
 * 用 `mkdir` 的原子性做互斥：POSIX 与 Windows 上都保证「同名目录只有一个进程建得成，
 * 其余拿到 EEXIST」。比"先 stat 再创建"可靠 —— 那种写法本身就有时序窗口。
 *
 * 抢占条件有两条，缺一不可：
 *   a) 锁目录的 mtime 超过 staleMs（兜底，跨机器/pid 不可达时才有用）；
 *   b) 锁里记的 pid 已经不存在了（同机器上进程被 kill 的常见情形，毫秒级可判定）。
 * 注意别把"刚 mkdir 完还没写 owner 文件"当成 b)：那时 pid 读不出来，
 * 代码走的是"两条都不满足 ⇒ 不抢"，所以不会误抢一把刚建好的锁。
 */
function createDirLock({ lockRoot, staleMs, waitMs, onWarn }) {
  async function isStale(lockPath) {
    let st;
    try {
      st = await fsp.stat(lockPath);
    } catch {
      return false; // 已经没了，下一轮 mkdir 会成功
    }
    if (Date.now() - st.mtimeMs > staleMs) return true;

    const owner = await fsp.readFile(path.join(lockPath, 'owner'), 'utf8').catch(() => '');
    const pid = Number(String(owner).split('\n')[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0); // 信号 0：只探活，不真的发信号
    } catch (err) {
      if (err.code === 'ESRCH') return true; // 持有者已经没了
    }
    return false;
  }

  return async function withDirLock(name, fn) {
    const lockPath = path.join(lockRoot, `${name}.lock`);
    // 锁根目录要先存在，否则第一次 mkdir 会 ENOENT。这里失败只能直接报错：
    // 上传本来就要往 cacheDir 写暂存文件，锁目录写不了说明整套都不可用。
    try {
      await fsp.mkdir(lockRoot, { recursive: true });
    } catch (err) {
      if (!isExists(err)) {
        throw new UploadError(503, `上传锁目录不可用：${lockRoot}（${err.code || err.message}）`);
      }
    }

    const deadline = Date.now() + waitMs;
    let delay = 4;

    for (;;) {
      try {
        await fsp.mkdir(lockPath);
        break;
      } catch (err) {
        // 只有「已存在」才代表锁被占用，继续等。
        // 其它错误（权限、只读、代理拦截）一律失败 —— 放行就等于在无锁状态下分配序号。
        if (!isExists(err)) {
          throw new UploadError(503, `无法创建上传锁：${err.code || err.message}`);
        }
      }

      if (await isStale(lockPath)) {
        onWarn(`发现陈旧的锁 ${path.basename(lockPath)}，已抢占`);
        await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }

      if (Date.now() > deadline) {
        throw new UploadError(503, '同一天还有别的上传在处理，等了一会儿没轮到，稍后重试');
      }
      // 退避 + 抖动：几个请求同时撞上来时不会同步重试
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 200);
    }

    await fsp
      .writeFile(path.join(lockPath, 'owner'), `${process.pid}\n${Date.now()}\n`)
      .catch(() => {});
    try {
      return await fn();
    } finally {
      await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/* ─────────────────────────── 上传器 ─────────────────────────── */

export function createUploader(config, { root, onWarn = () => {} } = {}) {
  const mediaRoot = path.isAbsolute(config.paths.mediaRoot)
    ? config.paths.mediaRoot
    : path.join(root, config.paths.mediaRoot);
  const cacheDir = path.isAbsolute(config.thumbs.cacheDir)
    ? config.thumbs.cacheDir
    : path.join(root, config.thumbs.cacheDir);
  const stageRoot = path.join(cacheDir, 'uploads');

  const up = config.upload || {};
  const enabled = up.enabled !== false;
  const maxFiles = Math.max(1, Number(up.maxFiles) || 30);
  const maxBytes = (Number(up.maxFileMB) || 500) * 1024 * 1024;
  /** 锁被持有超过这么久就视为陈旧（进程被 SIGKILL 时不会走 finally） */
  const lockStaleMs = Math.max(200, Number(up.lockStaleMs) || 30_000);
  /** 等锁的总时长上限；临界区只有几毫秒，等不到基本说明有东西卡住了 */
  const lockWaitMs = Math.max(500, Number(up.lockWaitMs) || 20_000);

  /**
   * 目录名前缀的生成方式（两种写法扫描器都认，可以随时改，历史目录不受影响）：
   *   'order' 001 / 001-标题              默认。短、好读，按发布顺序编号
   *   'time'  143027-k3f9 / …             时间可排序 + 随机去重
   *
   * 差别不只在长相：order 要"读出已用序号再 +1"，是个读-改-写，必须靠锁串起来；
   * time 直接生成不重复的名字，撞名就重摇一次，因此连锁都不依赖。
   */
  const naming = up.naming === 'time' ? 'time' : 'order';

  const IMAGE_EXT = new Set(config.media.images);
  const VIDEO_EXT = new Set(config.media.videos);

  const withDirLock = createDirLock({
    lockRoot: path.join(cacheDir, 'locks'),
    staleMs: lockStaleMs,
    waitMs: lockWaitMs,
    onWarn,
  });

  /**
   * 进程内的锁，按日期分桶。
   * 外层这一把只是为了让同一进程里对同一日期的请求排队（少几个一起空转的等待者）；
   * 真正保证跨进程正确性的是里面那把目录锁。
   */
  const chains = new Map();
  const withProcLock = (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  };

  /** 同设备用 rename（原子）；跨设备时退化成复制 */
  async function moveFile(from, to) {
    try {
      await fsp.rename(from, to);
    } catch (err) {
      if (!isExdev(err)) throw err;
      await fsp.copyFile(from, to);
      await fsp.unlink(from).catch(() => {});
    }
  }

  /**
   * 把一个**已经组装完整**的目录放进照片库。
   *
   * rename 在同一文件系统内是原子的：读者要么看到目录不存在，要么看到完整内容，
   * 不会看到"目录在、文件只搬进去一半"。这正是并发上传时「分组不乱」的关键。
   *
   * 跨设备（照片库在移动硬盘、cacheDir 在本地盘）时无法 rename，只能复制：
   * 复制期间目标目录会逐步出现，原子性拿不回来，但至少失败时不会留残骸。
   */
  async function commitDir(from, to) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!isExdev(err)) throw err;
    }
    try {
      await fsp.cp(from, to, { recursive: true });
    } catch (err) {
      await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    await fsp.rm(from, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * @param ctx.user 已登录用户（启用账号认证时由路由层传入）。写进 meta.json 作为署名。
   */
  async function handle(req, res, json, { user = null } = {}) {
    if (!enabled) {
      return json(res, 403, { error: '上传功能已关闭（moments.config.mjs → upload.enabled）' });
    }
    // 自定义头：跨站表单提交带不上它，天然挡住 CSRF
    if (req.headers['x-bm-upload'] !== '1') {
      return json(res, 403, { error: '缺少上传标识' });
    }
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch {
        ok = false;
      }
      if (!ok) return json(res, 403, { error: '拒绝跨站上传' });
    }

    const ctype = req.headers['content-type'] || '';
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (!/^multipart\/form-data/i.test(ctype) || !bm) {
      return json(res, 400, { error: '只接受 multipart/form-data' });
    }
    const boundary = (bm[1] || bm[2]).trim();
    if (!boundary) return json(res, 400, { error: '缺少 boundary' });

    const cap = maxBytes * maxFiles;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > cap) {
      // 先把 body 读干净再回错，否则浏览器只会看到"连接被重置"而拿不到原因。
      // drainRequest 在超过上限时会主动放弃（这次的 body 必然更大，没必要为了一句提示全读）。
      await drainRequest(req);
      return json(res, 413, {
        error: `这次上传合计 ${humanSize(declared)}，超过上限 ${humanSize(cap)}`,
        code: 'TOO_LARGE',
      });
    }

    const token = crypto.randomBytes(12).toString('hex');
    const stageDir = path.join(stageRoot, token);
    const fields = {};
    const files = [];
    let accepted = 0;

    try {
      await fsp.mkdir(stageDir, { recursive: true });

      const fieldSink = (name) => {
        const chunks = [];
        return {
          async write(c) {
            chunks.push(c);
          },
          async end() {
            if (name) fields[name] = Buffer.concat(chunks).toString('utf8');
          },
          async abort() {},
        };
      };

      const fileSink = async ({ filename }) => {
        // 客户端可能发 "C:\Users\x\照片.jpg"（老 IE）或相对路径，只取最后一段
        const base = String(filename).split(/[/\\]/).pop() || '';
        const ext = extOf(base);
        const isImage = IMAGE_EXT.has(ext);
        const isVideo = VIDEO_EXT.has(ext);
        if (!isImage && !isVideo) {
          throw new UploadError(415, `不支持的格式：${base || '(无扩展名)'}`);
        }
        if (accepted >= maxFiles) {
          throw new UploadError(400, `一次最多上传 ${maxFiles} 个文件`);
        }
        accepted += 1;
        const tmp = path.join(stageDir, `f${files.length}.${ext}`);
        const rec = { originalName: base, ext, kind: isImage ? 'image' : 'video', tmp, bytes: 0 };
        files.push(rec);

        const ws = fs.createWriteStream(tmp);
        return {
          async write(c) {
            rec.bytes += c.length;
            if (rec.bytes > maxBytes) {
              throw new UploadError(
                413,
                `${base} 超过单个文件上限 ${humanSize(maxBytes)}`,
              );
            }
            if (!ws.write(c)) await new Promise((r) => ws.once('drain', r));
          },
          async end() {
            ws.end();
            await finished(ws);
          },
          async abort() {
            ws.destroy();
            await finished(ws).catch(() => {});
          },
        };
      };

      const parser = createMultipart(boundary, fileSink, fieldSink);
      for await (const chunk of req) await parser.push(chunk);
      await parser.end();

      /* ── 校验 ── */
      if (files.length === 0) throw new UploadError(400, '没有收到任何照片或视频');
      const blank = files.find((f) => f.bytes === 0);
      if (blank) throw new UploadError(400, `${blank.originalName} 是空文件`);

      let date = String(fields.date || '').trim() || todayStr();
      // 注意不能只靠 parseDateOnly：它内部走 new Date(y, m-1, d)，而 JS 会把
      // 2026-13-45 这种自动进位成 2027-02-14 —— 非法日期会被悄悄接受并建成一个新日期目录。
      // 必须把三个字段回读比对，确认没有被 Date 修正过。
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      const [dy, dmo, dd] = dm ? [Number(dm[1]), Number(dm[2]), Number(dm[3])] : [0, 0, 0];
      const probe = dm ? new Date(dy, dmo - 1, dd) : null;
      const dateOk =
        probe &&
        probe.getFullYear() === dy &&
        probe.getMonth() === dmo - 1 &&
        probe.getDate() === dd &&
        dy >= 1900 &&
        dy <= 2200;
      if (!dateOk) throw new UploadError(400, `日期不合法：${date}`);
      date = `${dm[1]}-${dm[2]}-${dm[3]}`;

      const title = safeDirName(fields.title);
      // 浏览器发 multipart 时会把换行统一成 CRLF（规范要求），落盘前归一回 LF，
      // 否则 caption.md 与手工写的那些文件换行风格不一致
      const caption = String(fields.caption || '')
        .replace(/\r\n?/g, '\n')
        .trim()
        .slice(0, 4000);
      const locationRaw = String(fields.location || '').trim().slice(0, 60);
      const timeRaw = String(fields.time || '').trim();
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(timeRaw) ? timeRaw : '';

      // time 模式的前缀：写了时间就用它（补 00 秒），没写就用落地时的钟点。
      // 定长 6 位是有意的 —— 定长数字串的字典序恰好等于时间序，扫描器不用额外解析，
      // 直接靠目录名自然排序就能排出正确的先后。
      const clock = new Date();
      const prefixStamp = time
        ? `${time.replace(':', '')}00`
        : `${pad2(clock.getHours())}${pad2(clock.getMinutes())}${pad2(clock.getSeconds())}`;
      const kid = fields.kid
        ? (config.kids || []).find(
            (k) => k.id === fields.kid || k.name === fields.kid || (k.aliases || []).includes(fields.kid),
          ) || null
        : null;

      /* ── 组装：把这一条动态的全部内容在暂存区拼成一个完整目录 ──
         这一步刻意放在照片库之外。照片库里此刻什么都没有，
         所以另一个用户的页面、fs.watch 触发的重扫、命令行里的 scan 都看不到半成品。 */
      const staged = path.join(stageDir, 'entry');
      await fsp.mkdir(staged);

      // 同名（去扩展名）的文件共用一个序号 —— 实况照片 JPG+MOV 会因此配成一对
      const groups = [];
      const byBase = new Map();
      for (const f of files) {
        const stem =
          path.basename(f.originalName, path.extname(f.originalName)).toLowerCase() ||
          f.originalName.toLowerCase();
        let g = byBase.get(stem);
        if (!g) {
          g = [];
          byBase.set(stem, g);
          groups.push(g);
        }
        g.push(f);
      }

      let n = 0;
      for (const g of groups) {
        n += 1;
        const seq = String(n).padStart(3, '0');
        for (const f of g) await moveFile(f.tmp, path.join(staged, `${seq}.${f.ext}`));
      }

      if (caption) await fsp.writeFile(path.join(staged, 'caption.md'), `${caption}\n`, 'utf8');

      const meta = {};
      if (title) meta.title = title;
      if (kid) meta.kid = kid.id;
      if (locationRaw) meta.location = locationRaw;
      if (time) meta.time = time;
      if (user) {
        // 署名：谁传的。目录名不承载这个信息，只写进 meta.json 才不会丢。
        // author 给人看（改昵称后旧记录保持当时的样子），authorId 给程序用。
        meta.author = user.name;
        meta.authorId = user.id;
      }
      if (Object.keys(meta).length) await writeJsonAtomic(path.join(staged, 'meta.json'), meta);

      /* ── 入库：起名字 + 整体 rename，全程持锁 ──
         临界区只有一次 rename（time 模式连锁都不依赖），锁的持有时间可以忽略不计 ——
         这也是把组装挪到锁外的意义：500MB 的搬运不再占着锁，别人不用陪着等，
         同时名字又不会撞。 */
      const dirName = await withProcLock(date, () =>
        withDirLock(`date-${date}`, async () => {
          const dateDir = path.join(mediaRoot, date);
          await fsp.mkdir(dateDir, { recursive: true });
          const named = (id) => (title ? `${id}-${title}` : id);

          /* time 模式：直接生成 <HHmmss><-随机>，不做读-改-写。
             撞名只可能是随机串重复（或恰好有人手工建了同名目录），重摇一次即可。 */
          if (naming === 'time') {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const candidate = named(`${prefixStamp}-${randomId(4)}`);
              try {
                await commitDir(staged, path.join(dateDir, candidate));
                return candidate;
              } catch (err) {
                if (!isExists(err) && err.code !== 'ENOTEMPTY') throw err;
              }
            }
            throw new UploadError(500, '同一日期下的动态太多了，换个日期吧');
          }

          /* order 模式：001 / 002 …
             这一段是"读出已用序号 → 取最大值 +1"，属于读-改-写，
             两个写入者会读到同一份快照，所以必须由锁串起来。 */
          const taken = new Set(
            (await fsp.readdir(dateDir, { withFileTypes: true }).catch(() => [])).map((i) => i.name),
          );
          let seqNo = 0;
          for (const it of taken) {
            const m = SEQ_RE.exec(it);
            if (m) seqNo = Math.max(seqNo, Number(m[1]));
          }

          for (let attempt = 0; attempt < 200; attempt += 1) {
            seqNo += 1;
            const candidate = named(String(seqNo).padStart(3, '0'));
            if (taken.has(candidate)) continue;
            try {
              await commitDir(staged, path.join(dateDir, candidate));
              return candidate;
            } catch (err) {
              // 兜底：万一有别的东西不按这把锁来（手工建目录、别的程序在写），
              // 撞名就往后退一个号，不要整体失败
              if (isExists(err) || err.code === 'ENOTEMPTY' || err.code === 'EISDIR') {
                taken.add(candidate);
                continue;
              }
              throw err;
            }
          }
          throw new UploadError(500, '同一日期下的动态太多了，换个日期吧');
        }),
      );

      const result = {
        date,
        dir: dirName,
        path: `${date}/${dirName}`,
        files: files.length,
        groups: groups.length,
        bytes: files.reduce((s, f) => s + f.bytes, 0),
        title,
        caption,
        location: locationRaw,
        time,
        kid: kid ? { id: kid.id, name: kid.name } : null,
        author: user ? { id: user.id, name: user.name } : null,
      };

      const payload = { ok: true, ...result };
      json(res, 200, payload);
      return payload;
    } catch (err) {
      const status = err instanceof UploadError ? err.status : 500;
      if (!(err instanceof UploadError)) console.error('[upload]', err);
      const aborted = err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE';
      if (res.headersSent) return res.end();
      return json(res, aborted ? 499 : status, {
        error: aborted ? '上传被中断' : err.message,
        code: err instanceof UploadError ? 'UPLOAD' : 'INTERNAL',
      });
    } finally {
      await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    enabled,
    handle,
    mediaRoot,
    stageRoot,
    lockRoot: path.join(cacheDir, 'locks'),
    lockStaleMs,
  };
}
