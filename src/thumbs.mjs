/**
 * 缩略图生成 + 磁盘缓存。
 *
 * 两种规格：
 *   grid —— 正方形裁切（默认 480px），喂九宫格；用 attention 智能裁切，尽量不切到脸
 *   view —— 长边 1600px，喂灯箱大图和单图排版；顺便把 HEIC 转成浏览器认得的 webp
 *
 * 解码兜底链（重要）：
 *   sharp 预编译包**只认 HEIC 的容器头、解不出 HEVC 像素**（专利原因），
 *   而 iPhone 导出的照片默认就是 HEIC。所以顺序是：
 *     heic/heif  → heic-convert（纯 JS/WASM 的 libheif，能真解 HEVC）
 *     图片        → sharp 直读
 *     视频        → ffmpeg 抽帧（装了就用）→ macOS QuickLook 抽帧（不用装东西）
 *     都失败      → macOS 自带 sips 转 JPEG 再交给 sharp
 *   视频一路必须兜底到底：iPhone 拍的视频默认没有同名封面图，
 *   所以"抽帧失败"是常见路径而不是边角情况，失败时前端会退化成设计好的瓦片。
 *   这样在 macOS / Linux 上都能跑，不依赖系统装没装 libheif。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLimiter, pathExists } from './util.mjs';

const execFileAsync = promisify(execFile);
const isMac = process.platform === 'darwin';
const HEIF_EXT = new Set(['heic', 'heif']);

export function createThumbs(config, { root, mediaRoot }) {
  const cacheDir = path.isAbsolute(config.thumbs.cacheDir)
    ? config.thumbs.cacheDir
    : path.join(root, config.thumbs.cacheDir);
  const thumbRoot = path.join(cacheDir, 'thumbs');

  // 真解码比读元信息重得多（HEIC 尤其吃内存），并发必须收着点
  const limit = createLimiter(Math.max(1, config.thumbs.concurrency || 4));
  const decodeLimit = createLimiter(Math.max(1, Math.min(2, config.thumbs.concurrency || 4)));

  let sharpMod = null;
  const getSharp = async () => (sharpMod ??= (await import('sharp')).default);

  // 同一张图被并发请求时只生成一次
  const inflight = new Map();

  const safeRev = (rev) => String(rev).replace(/[^\w.-]/g, '_');
  const thumbFile = (key, variant, rev) =>
    path.join(thumbRoot, key.slice(0, 2), key, `${variant}-${safeRev(rev)}.webp`);

  function resizeArgs(sharp, variant) {
    return variant === 'grid'
      ? {
          width: config.thumbs.gridSize,
          height: config.thumbs.gridSize,
          fit: 'cover',
          position: sharp.strategy.attention,
        }
      : {
          width: config.thumbs.viewSize,
          height: config.thumbs.viewSize,
          fit: 'inside',
          withoutEnlargement: true,
        };
  }

  const toWebp = (sharp, pipeline, variant) =>
    pipeline
      .resize(resizeArgs(sharp, variant))
      .webp({ quality: config.thumbs.quality, effort: 4, smartSubsample: true })
      .toBuffer();

  /** 尝试 1：heic-convert 解 HEVC → JPEG buffer → sharp 出 webp */
  async function renderViaHeic(src, variant) {
    const sharp = await getSharp();
    const { default: convert } = await import('heic-convert');
    const jpeg = await convert({ buffer: await fsp.readFile(src), format: 'JPEG', quality: 0.92 });
    // libheif 解码时已应用方向信息，这里不要再 rotate()
    return toWebp(sharp, sharp(Buffer.from(jpeg), { failOn: 'none' }), variant);
  }

  /** 尝试 2：sharp 直读 */
  async function renderViaSharp(src, variant) {
    const sharp = await getSharp();
    return toWebp(sharp, sharp(src, { failOn: 'none' }).rotate(), variant);
  }

  /** 尝试 3：macOS sips 转 JPEG，再交给 sharp（主要兜 RAW / 老式 HEIF） */
  async function renderViaSips(src, variant) {
    if (!isMac) throw new Error('sips 仅在 macOS 可用');
    const sharp = await getSharp();
    const tmp = path.join(os.tmpdir(), `babymoments-${process.pid}-${Date.now()}.jpg`);
    try {
      await execFileAsync('sips', ['-s', 'format', 'jpeg', '-Z', '2400', src, '--out', tmp], {
        timeout: 120_000,
      });
      if (!(await pathExists(tmp))) throw new Error('sips 未产出文件');
      return await toWebp(sharp, sharp(tmp, { failOn: 'none' }).rotate(), variant);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  /**
   * 尝试 4（仅视频）：ffmpeg 抽帧。装了 ffmpeg 就优先用它，帧位确定、跨平台。
   * 没装的话 execFile 会抛 ENOENT，这里缓存一下避免每次请求都白试一次。
   */
  let ffmpegMissing = false;
  async function renderViaFfmpeg(src, variant) {
    if (ffmpegMissing) throw new Error('未安装 ffmpeg');
    const sharp = await getSharp();
    const size = variant === 'view' ? config.thumbs.viewSize : config.thumbs.gridSize;
    const grab = async (seek) => {
      const args = ['-hide_banner', '-loglevel', 'error'];
      if (seek != null) args.push('-ss', String(seek));
      args.push('-i', src, '-frames:v', '1', '-vf', `scale=${size}:-2:flags=bicubic`);
      args.push('-f', 'image2pipe', '-vcodec', 'png', 'pipe:1');
      const { stdout } = await execFileAsync('ffmpeg', args, {
        encoding: 'buffer',
        maxBuffer: 96 * 1024 * 1024,
        timeout: 90_000,
      });
      return stdout?.length ? stdout : null;
    };
    let frame;
    try {
      frame = (await grab(0.5)) || (await grab(null));
    } catch (err) {
      if (/ENOENT/.test(err.message)) ffmpegMissing = true;
      throw err;
    }
    if (!frame) throw new Error('ffmpeg 没有抽到帧');
    return toWebp(sharp, sharp(frame, { failOn: 'none' }), variant);
  }

  /**
   * 尝试 5（仅视频）：macOS QuickLook。
   * 不用装任何东西，但依赖进程沙箱外部可用，在受限环境里会失败。
   */
  async function renderViaQuickLook(src, variant) {
    if (!isMac) throw new Error('QuickLook 仅在 macOS 可用');
    const sharp = await getSharp();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bm-ql-'));
    const size = Math.round(
      Math.max(config.thumbs.gridSize, variant === 'view' ? config.thumbs.viewSize : 0),
    );
    try {
      await execFileAsync('qlmanage', ['-t', '-s', String(size), '-o', dir, src], {
        timeout: 60_000,
      });
      const produced = (await fsp.readdir(dir)).find((f) => /\.(png|jpe?g|tiff?)$/i.test(f));
      if (!produced) throw new Error('QuickLook 没有产出预览图');
      return await toWebp(sharp, sharp(path.join(dir, produced), { failOn: 'none' }), variant);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  async function render(src, { ext, kind, variant }) {
    let order;
    if (kind === 'video') order = [renderViaFfmpeg, renderViaQuickLook];
    else if (HEIF_EXT.has(ext)) order = [renderViaHeic, renderViaSharp, renderViaSips];
    else order = [renderViaSharp, renderViaSips];

    const errors = [];
    for (const attempt of order) {
      try {
        return await attempt(src, variant);
      } catch (err) {
        errors.push(`${attempt.name.replace('renderVia', '')}: ${err.message.split('\n')[0]}`);
      }
    }
    const e = new Error(`无法生成缩略图 (${errors.join(' | ')})`);
    e.code = 'DECODE_FAILED';
    throw e;
  }

  /** 失败短期缓存：避免每次刷新页面都对同一个坏文件重试一遍 */
  const failures = new Map();
  const FAIL_TTL = 5 * 60 * 1000;

  /** 确保缩略图存在，返回 { file, cached }。rev 变化（文件被替换）时自动重生成。 */
  async function ensure({ key, rel, rev, variant, ext, kind = 'image' }) {
    const dest = thumbFile(key, variant, rev);
    if (await pathExists(dest)) return { file: dest, cached: true };

    const bad = failures.get(dest);
    if (bad && Date.now() - bad.at < FAIL_TTL) throw new Error(bad.message);
    if (bad) failures.delete(dest);

    if (inflight.has(dest)) return inflight.get(dest);

    const job = (async () => {
      const src = path.join(mediaRoot, rel);
      if (!(await pathExists(src))) {
        const e = new Error('源文件不存在');
        e.code = 'ENOENT_SRC';
        throw e;
      }
      let buf;
      try {
        buf = await decodeLimit(() => render(src, { ext, kind, variant }));
      } catch (err) {
        failures.set(dest, { at: Date.now(), message: err.message });
        throw err;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      return { file: dest, cached: false, bytes: buf.length };
    })().finally(() => inflight.delete(dest));

    inflight.set(dest, job);
    return job;
  }

  async function clearAll() {
    await fsp.rm(thumbRoot, { recursive: true, force: true });
  }

  async function cacheSize() {
    let bytes = 0;
    let files = 0;
    const walk = async (d) => {
      for (const it of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) await walk(p);
        else {
          files += 1;
          bytes += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(thumbRoot);
    return { bytes, files };
  }

  return { ensure, clearAll, cacheSize, thumbRoot, limit };
}
