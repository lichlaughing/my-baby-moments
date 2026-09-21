#!/usr/bin/env node
/**
 * 部署前自检 —— 换一台机器（NAS、容器、另一台电脑）之前先跑这个，
 * 回答一个问题：「这台机器能不能正常跑这个服务」。
 *
 *   npm run doctor
 *   npm run doctor -- --config /app/data/moments.config.mjs
 *   容器里跑：docker compose run --rm baby-moments node scripts/preflight.mjs
 *
 * 取向是**能实测的就不推断**，每条都给读数。最典型的一条是"缓存与照片库是不是
 * 同一个挂载点"：`df` 会告诉你二者落在同一块硬盘上，但 Linux 的 rename(2) 是按
 * **挂载点**判断的 —— 两个 bind mount 指向同一个文件系统照样返回 EXDEV。
 * 所以这里直接真的 rename 一次，让 errno 说话。
 *
 * 会写盘的地方只有照片库顶层两个以 `.` 开头的探针文件。三层保险保证它不会被当成内容：
 *   ① 扫描器在照片库顶层只递归目录，非目录直接跳过（src/scan.mjs:355）；
 *   ② `.tmp` 不在媒体扩展名表里（src/util.mjs:VID）；
 *   ③ 目录监听回调跳过点文件。
 * 而且无论成败都在 finally 里删掉。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VID, extOf, humanSize } from '../src/util.mjs';
import { SCOPES, resolveReadScope } from '../src/auth.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

if (has('--help') || has('-h')) {
  console.log(`用法：node scripts/preflight.mjs [--config <路径>]

检查项：Node 版本、照片库与缓存的可读写、跨挂载点 rename 的原子性、
        sharp / HEIC / ffmpeg 的解码能力、目录监听能否建立、账号与读侧范围配置。
只读为主，唯一的写入是照片库顶层两个 . 开头的探针文件，最后会删掉。
退出码：有 ✗ 时为 1。`);
  process.exit(0);
}

// ── 输出小工具 ────────────────────────────────────────────────
const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (n) => (s) => (tty ? `\u001b[${n}m${s}\u001b[0m` : String(s));
const c = { dim: paint(2), b: paint(1), g: paint(32), y: paint(33), r: paint(31) };

// 中日韩字符占两格，直接用 padEnd 会错位
const widthOf = (s) =>
  [...String(s)].reduce(
    (n, ch) =>
      n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1),
    0,
  );
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - widthOf(s)));

let pass = 0;
let warn = 0;
let fail = 0;
const section = (t) => console.log(`\n${c.b(t)}`);
function report(level, label, detail = '', hint = '') {
  if (level === 'ok') pass++;
  else if (level === 'warn') warn++;
  else fail++;
  const glyph = level === 'ok' ? c.g('✓') : level === 'warn' ? c.y('!') : c.r('✗');
  console.log(`  ${glyph} ${pad(label, 16)} ${c.dim(detail)}`);
  if (hint) console.log(`    ${pad('', 16)} ${c.dim(hint)}`);
}

// 沙箱/打包器会把 err.code 改写掉、只在 message 里留原始前缀，
// 所以 code 与 message 前缀两个都要看（和项目里 isExists 的写法一致）。
const isExdev = (err) => codeOf(err) === 'EXDEV';

// 取一个**可信**的错误码。某些运行环境（本机沙箱就是）会把 err.code 改写成
// CODEBUDDY_BROKER_DENY，只在 message 里留 "ENOENT: ..." 这样的原始前缀 ——
// 和项目里 isExists 处理的是同一个坑。诊断工具尤其不能把这种改写过的码当成原因报出去。
const KNOWN_ERRNO = /^(EACCES|EPERM|ENOENT|EROFS|EXDEV|ENOTDIR|EEXIST|EBUSY|ENAMETOOLONG|EMFILE|ENOSPC|EIO|EINVAL|ESTALE|ENOTSUP)\b/;
const codeOf = (err) => {
  const fromMsg = KNOWN_ERRNO.exec(String(err?.message || ''));
  return fromMsg ? fromMsg[1] : err?.code || '未知错误';
};

console.log(c.b('\n宝宝成长记 · 部署前自检'));

// ── 配置 ─────────────────────────────────────────────────────
const cfgPath = val('--config') ? path.resolve(ROOT, val('--config')) : path.join(ROOT, 'moments.config.mjs');
if (!fs.existsSync(cfgPath)) {
  report('fail', '配置文件', `找不到 ${cfgPath}`);
  console.log(`\n${c.r('汇总')}：0 项通过 / 0 项注意 / 1 项失败（连配置都没有，后面的检查没意义）\n`);
  process.exit(1);
}
const config = (await import(pathToFileURL(cfgPath).href)).default || {};
const abs = (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(ROOT, String(p)));
const mediaRoot = abs(config.paths?.mediaRoot ?? 'photos');
const cacheDir = abs(config.thumbs?.cacheDir ?? '.cache');
console.log(`  ${c.dim('配置文件')} ${cfgPath}`);
console.log(`  ${c.dim('项目根')}   ${ROOT}`);

const stamp = `${process.pid}-${Date.now()}`;
const probeCache = path.join(cacheDir, `.preflight-${stamp}.tmp`);
const probeLib = path.join(mediaRoot, `.preflight-${stamp}.tmp`);
const probeMoved = path.join(mediaRoot, `.preflight-${stamp}-moved.tmp`);
let watcher = null;
let exitCode = 0;

try {
  // ── 运行时 ──────────────────────────────────────────────────
  section('运行时');
  const major = Number(process.versions.node.split('.')[0]);
  report(major >= 20 ? 'ok' : 'fail', 'Node 版本', `${process.versions.node}${major >= 20 ? '' : '（要求 ≥ 20）'}`);
  const inContainer =
    fs.existsSync('/.dockerenv') || /docker|containerd|podman|kube/i.test(process.env.container || '');
  report('ok', '平台', `${process.platform} / ${process.arch} · ${os.cpus().length} 核${inContainer ? ' · 容器内' : ''}`);

  // ── 文件系统 ────────────────────────────────────────────────
  section('文件系统');
  const libExists = fs.existsSync(mediaRoot);
  // 扩展名与忽略规则一律**从配置读**，与 src/scan.mjs 的 classify() / isIgnored() 同源。
  // 内置的 VID 表只是"普遍情况"，配置才是事实来源：往 media.images 里加了 cr3，
  // 这里也必须认，否则读数和 `npm run scan` 对不上。
  const imageExts = new Set((config.media?.images || []).map((e) => String(e).toLowerCase()));
  const videoExts = new Set((config.media?.videos || []).map((e) => String(e).toLowerCase()));
  const ignoreDirs = new Set((config.media?.ignoreDirs || []).map((d) => String(d).toLowerCase()));
  const ignorePrefix = (config.media?.ignorePrefix || ['.']).map(String);
  const HEIF = new Set(['heic', 'heif']);
  const kindOf = (name) => {
    const ext = extOf(name);
    return imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : null;
  };
  const ignored = (name) =>
    ignoreDirs.has(name.toLowerCase()) || ignorePrefix.some((p) => p && name.startsWith(p));

  let images = 0;
  let videos = 0;
  let posters = 0;
  let others = 0;
  let bytes = 0;
  let firstHeic = null;

  const baseOf = (name) => path.basename(name, path.extname(name)).toLowerCase();

  async function walk(dir, depth = 0) {
    if (depth > 8) return;
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = [];
    const subs = [];
    for (const it of items) {
      if (ignored(it.name)) continue;
      if (it.isDirectory()) subs.push(path.join(dir, it.name));
      else if (it.isFile()) names.push(it.name);
    }
    // 与视频**同名**的图片是它的封面（scan.mjs 里 role: 'poster'），不计入照片数。
    // 这里必须同口径，否则读数跟 `npm run scan` 差一个数，看起来就像哪里坏了。
    const videoBases = new Set(names.filter((n) => kindOf(n) === 'video').map(baseOf));
    for (const name of names) {
      const full = path.join(dir, name);
      const kind = kindOf(name);
      if (!kind) {
        others++;
        continue;
      }
      if (kind === 'video') videos++;
      else if (videoBases.has(baseOf(name))) posters++;
      else images++;
      if (!firstHeic && HEIF.has(extOf(name))) firstHeic = full;
      bytes += await fsp.stat(full).then((s) => s.size).catch(() => 0);
    }
    for (const p of subs) await walk(p, depth + 1);
  }

  if (!libExists) {
    report('fail', '照片库', `不存在：${mediaRoot}`);
  } else {
    report('ok', '照片库', mediaRoot);
    await walk(mediaRoot);
    report(
      'ok',
      '库内容',
      `${images} 张照片 / ${videos} 个视频${posters ? ` / ${posters} 张视频封面` : ''}` +
        `${others ? ` / 其他 ${others} 个文件` : ''}，共 ${humanSize(bytes)}`,
    );
    const fsStat = await fsp.statfs(mediaRoot).catch(() => null);
    if (fsStat) report('ok', '可用空间', humanSize(fsStat.bsize * fsStat.bavail));
  }

  // 目录监听 + 两个探针。
  // 结构说明：监听探针靠"往照片库写一个文件"来触发事件，但
  // **缓存可写性与入库原子性这两项与 watch 无关**，不能跟着 watch 一起被关掉
  // （否则配置里写了 watch: false 就再也查不出跨挂载点问题）。
  if (!libExists) {
    // 照片库都不在，探针没有落点 —— 上面已经报 ✗ 了。
    // 但缓存目录独立检查一次：它跟照片库没关系，早点报出来省一轮往返。
    let cacheErr = null;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(probeCache, 'preflight');
    } catch (err) {
      cacheErr = err;
    }
    report(
      cacheErr ? 'fail' : 'ok',
      '缓存目录可写',
      cacheErr ? `${cacheDir} —— ${codeOf(cacheErr)}（缩略图与暂存区都要写这里）` : cacheDir,
    );
  } else {
    const watchEnabled = config.server?.watch !== false;
    let watchErr = null;
    let events = 0;
    if (watchEnabled) {
      try {
        watcher = fs.watch(mediaRoot, { recursive: true }, () => {
          events++;
        });
        watcher.on('error', () => {});
      } catch (err) {
        watcher = null;
        watchErr = err;
      }
    }

    // 照片库可写吗（顺便就是 watch 探针的触发源）
    let libWriteErr = null;
    try {
      await fsp.writeFile(probeLib, 'preflight');
    } catch (err) {
      libWriteErr = err;
    }
    report(
      libWriteErr ? (config.upload?.enabled === false ? 'warn' : 'fail') : 'ok',
      '照片库可写',
      libWriteErr
        ? `${codeOf(libWriteErr)} —— 上传会失败${config.upload?.enabled === false ? '（upload.enabled 已关，影响不大）' : '；只读挂载就设 upload.enabled: false'}`
        : '上传入库需要',
    );

    // ── 关键一项：cacheDir → 照片库 的 rename 是否还是原子的 ──
    let cacheWriteErr = null;
    await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {});
    try {
      await fsp.writeFile(probeCache, 'preflight');
    } catch (err) {
      cacheWriteErr = err;
    }
    if (cacheWriteErr) {
      report('fail', '缓存目录可写', `${cacheDir} —— ${codeOf(cacheWriteErr)}（缩略图与暂存区都要写这里）`);
    } else if (libWriteErr) {
      report('warn', '入库原子性', '照片库不可写，探针跳过');
    } else {
      try {
        await fsp.rename(probeCache, probeMoved);
        report('ok', '入库原子性', 'rename 成功 —— 缓存与照片库在同一挂载点，入库是原子的');
      } catch (err) {
        if (isExdev(err)) {
          report(
            'warn',
            '入库原子性',
            'EXDEV：缓存与照片库不在同一挂载点',
            '入库会退化成"复制+删除"（src/upload.mjs 的 commitDir），目标目录逐步出现 —— ' +
              '一批上传途中读者可能看到只有一半文件的动态。' +
              '解法：把 cacheDir 与 mediaRoot 放进同一个挂载点（见 docker-compose.yml）。' +
              '若照片库确实只能在别的挂载点上，把 upload.naming 改成 \'time\'（它不依赖文件锁）。',
          );
        } else {
          report('fail', '入库原子性', `rename 探针失败：${codeOf(err)} ${err.message.split('\n')[0]}`);
        }
      }
    }

    // 监听能力：能建立 ≠ 能收到事件，等一个探针事件的往返
    if (!watchEnabled) {
      report('ok', '目录监听', '已按配置关闭（server.watch: false）—— 改动后手动刷新页面');
    } else if (!watcher) {
      report('warn', '目录监听', `${watchErr ? codeOf(watchErr) : '建不起来'} —— 网络盘常见；改动后手动刷新页面`);
    } else if (libWriteErr) {
      report('warn', '目录监听', '已建立（照片库不可写，没法实测事件）');
    } else {
      for (let i = 0; i < 8 && events === 0; i++) await sleep(150);
      report(
        events > 0 ? 'ok' : 'warn',
        '目录监听',
        events > 0 ? '已建立，且实测收到探针写入的事件' : '建起来了，但 1.2 秒内没收到探针事件',
        events > 0
          ? ''
          : '网络挂载点上 inotify 收不到远端改动 —— 看着是开着，其实永远不会自动刷新。' +
            '建议把 server.watch 设成 false，改完手动刷新页面。',
      );
    }
  }

  // ── 解码能力 ────────────────────────────────────────────────
  section('解码能力');
  try {
    const { default: sharp } = await import('sharp');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).webp().toBuffer();
    report('ok', 'sharp', `${sharp.versions.sharp} / libvips ${sharp.versions.vips}（webp 编码已实测）`);
  } catch (err) {
    report('fail', 'sharp', `${err.message.split('\n')[0]} —— 原生包没装对，跨平台拷 node_modules 就会这样`);
  }
  try {
    const { default: convert } = await import('heic-convert');
    if (firstHeic) {
      const jpeg = await convert({ buffer: await fsp.readFile(firstHeic), format: 'JPEG', quality: 0.8 });
      report('ok', 'HEIC 解码', `${path.basename(firstHeic)} → JPEG ${humanSize(jpeg.length)}（真解了一张）`);
    } else {
      report('ok', 'HEIC 解码', '模块可用（库里没有 HEIC 样本，未做真解码）');
    }
  } catch (err) {
    report('fail', 'HEIC 解码', err.message.split('\n')[0]);
  }
  let ffver = null;
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 15000 });
    ffver = String(stdout).split('\n')[0].replace(/^ffmpeg version /, '').split(' ')[0];
  } catch {
    ffver = null;
  }
  if (ffver) {
    report('ok', 'ffmpeg', ffver);
  } else if (videos > 0) {
    report('warn', 'ffmpeg', `未安装 —— 库里 ${videos} 个视频会退化成瓦片（不会报错，只是没封面）`);
  } else {
    report('ok', 'ffmpeg', '未安装（库里没有视频，用不上）');
  }
  if (process.platform === 'darwin') {
    const probe = async (bin, args) => {
      try {
        await execFileAsync(bin, args, { timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    };
    const sipsOk = await probe('sips', ['--help']);
    const qlOk = await probe('qlmanage', ['-h']);
    report('ok', 'sips / QuickLook', `sips ${sipsOk ? '可用' : '不可用'} / QuickLook ${qlOk ? '可用' : '不可用'}（macOS 专有兜底）`);
  } else {
    report('ok', 'sips / QuickLook', 'macOS 专有，非 macOS 自动跳过（src/thumbs.mjs 里有平台判断，不会报错）');
  }

  // ── 服务配置 ────────────────────────────────────────────────
  section('服务配置');
  const host = config.server?.host ?? '127.0.0.1';
  const port = config.server?.port ?? 4310;
  if (inContainer && (host === '127.0.0.1' || host === 'localhost')) {
    report('fail', '监听地址', `${host}:${port} —— 容器里绑回环地址，端口映射到外面也连不上；改成 '0.0.0.0'`);
  } else {
    report('ok', '监听地址', `${host}:${port}`);
  }

  const auth = config.auth || {};
  if (auth.enabled === false) {
    report('ok', '账号认证', '关闭（任何人都能看、能传）');
  } else {
    const users = Array.isArray(auth.users)
      ? auth.users.filter((u) => u && u.id && (u.passwordHash || u.password))
      : [];
    if (!users.length) {
      report('fail', '账号', 'auth.enabled 开着但一个账号都没配 ⇒ 整站都进不去（这是故意的，但你现在就得配）');
    } else {
      const plain = users.some((u) => u.password && !u.passwordHash);
      report(
        'ok',
        '账号',
        `${users.length} 个：${users.map((u) => u.name || u.id).join('、')}${plain ? '（有明文口令，启动会告警）' : ''}`,
      );
    }
    const raw = auth.scope;
    const unknown = raw != null && !SCOPES.includes(String(raw).trim().toLowerCase());
    const { scope, previewCount } = resolveReadScope(auth);
    const human =
      scope === 'all'
        ? '未登录什么都看不到（整站要登录）'
        : scope === 'upload'
          ? '未登录可看全部，只有发布要登录'
          : `未登录只见最新 ${previewCount} 条，登录后看全部`;
    report(unknown ? 'warn' : 'ok', '读侧范围', unknown ? `scope "${raw}" 不认识 ⇒ 已按 latest 处理` : human);
    if (auth.secure === true) {
      report('warn', 'Cookie Secure', '强制开启 ⇒ 只有前端是 https（或反代透传 x-forwarded-proto: https）时登录得上，纯 http 下浏览器不存 Cookie');
    } else {
      report('ok', 'Cookie Secure', '自动（按请求协议决定）');
    }
  }
  const renameMode = config.upload?.naming === 'time' ? 'time' : 'order';
  report(
    'ok',
    '上传命名',
    config.upload?.enabled === false
      ? '上传已关闭'
      : `naming: '${renameMode}'${renameMode === 'time' ? '（不依赖文件锁）' : ''}`,
  );

  exitCode = fail ? 1 : 0;
} finally {
  watcher?.close();
  await Promise.all([probeCache, probeLib, probeMoved].map((p) => fsp.rm(p, { force: true }).catch(() => {})));
}

const head = fail ? c.r('汇总') : warn ? c.y('汇总') : c.g('汇总');
console.log(`\n${head}：${pass} 项通过 / ${warn} 项注意 / ${fail} 项失败`);
if (fail) console.log(c.dim('  ✗ 的项要先解决，否则部署上去会以某种形式不工作。'));
if (warn) console.log(c.dim('  ! 的项不影响能不能跑，只影响体验，按需处理。'));
console.log('');
process.exit(exitCode);
