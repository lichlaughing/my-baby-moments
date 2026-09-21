/**
 * 扫描照片库 → 生成前端用的 manifest。
 *
 * 目录约定（详见 photos/README.md）：
 *   photos/
 *     2026-09-20/                  ← 一级目录必须是 yyyy-MM-dd
 *       001-第一次翻身/            ← 子目录 = 一条动态（多张媒体自动排成九宫格）
 *         001.jpg
 *         002.mp4
 *         caption.md              ← 可选文案
 *         meta.json               ← 可选：{ kid, location, time, title }
 *       随手拍.jpg                 ← 直接放媒体 = 每条媒体各成一条动态
 *
 * 同一天内的顺序：有 meta.time 的按时间，没有的按文件名自然序（001 < 002 < 010）；
 * 最终整体倒序展示，所以编号越大越靠前。
 *
 * 扫描是增量的：文件尺寸/宽高缓存到 .cache/filemeta.json，只对新增或改动过的文件重新探测。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DATE_DIR_RE,
  NATIVE_IMAGE_EXT,
  NATIVE_VIDEO_EXT,
  ageAt,
  createLimiter,
  dateMeta,
  extOf,
  naturalCompare,
  readJsonIfExists,
  shortHash,
  splitSortPrefix,
  writeJsonAtomic,
} from './util.mjs';

const CAPTION_FILES = ['caption.md', 'caption.txt', 'caption.markdown', 'story.md', '文案.md'];
const META_FILE = 'meta.json';

/**
 * 去掉目录名开头的排序前缀："001-第一次翻身" → "第一次翻身"，
 * "143027-k3f9-公园" → "公园"。两种前缀形态都由 splitSortPrefix 统一识别。
 * 只有前缀、没有标题时返回空串（调用方当作"没有标题"处理），
 * 否则上传出来的 003 / 143027-k3f9 会被显示成标题。
 */
const stripSortPrefix = (name) => splitSortPrefix(name).title;

/**
 * 从名字里认出宝宝之后，把名字里的宝宝别名也去掉，避免标题和上面的名字行重复。
 * "002-二宝-第一次翻身" 在名字行已经写了"二宝"的情况下，标题只剩"第一次翻身"更清爽。
 * 只对从目录名推导出来的标题生效，用户显式写在 meta.json 里的 title 一律不动。
 */
function stripKidAlias(title, kid) {
  if (!kid || !title) return title;
  let t = title;
  for (const alias of kid.aliases || []) {
    if (alias && alias.length >= 2 && t.includes(alias)) t = t.split(alias).join('');
  }
  t = t
    .replace(/^[\s\-_、,，:：|]+/, '')
    .replace(/[\s\-_、,，:：|]+$/, '')
    .trim();
  return t || title;
}

function isIgnored(name, config) {
  const lower = name.toLowerCase();
  if (config.media.ignoreDirs.some((d) => d.toLowerCase() === lower)) return true;
  if (config.media.ignorePrefix.some((p) => name.startsWith(p))) return true;
  return false;
}

function classify(file, config) {
  const ext = extOf(file);
  if (!ext) return null;
  if (config.media.images.includes(ext)) return 'image';
  if (config.media.videos.includes(ext)) return 'video';
  return null;
}

/** 从名称里探测这条动态属于哪个宝宝（支持 "001-大宝-xxx" / "[大宝]xxx"） */
function detectKid(text, kids) {
  if (!text) return null;
  const bracketed = [...text.matchAll(/[[【(（]([^\]】)）]+)[\]】)）]/g)].map((m) => m[1].trim());
  for (const kid of kids) {
    for (const alias of kid.aliases || []) {
      if (!alias) continue;
      if (bracketed.includes(alias)) return kid;
      // 中文别名普遍 2 字以上，"包含"判定比"前缀"更符合直觉
      if (alias.length >= 2 && text.includes(alias)) return kid;
    }
  }
  return null;
}

async function readFirstTextFile(dir, files) {
  for (const f of files) {
    const txt = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => '');
    if (txt.trim()) return txt.trim();
  }
  return '';
}

/** 递归收集目录下的媒体文件 */
async function collectFiles(dir, config, base = dir, out = []) {
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (isIgnored(item.name, config)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      await collectFiles(full, config, base, out);
    } else if (item.isFile()) {
      const kind = classify(item.name, config);
      if (kind) out.push({ name: item.name, full, rel: path.relative(base, full), kind });
    }
  }
  return out;
}

export function createScanner(config, { root }) {
  const mediaRoot = path.isAbsolute(config.paths.mediaRoot)
    ? config.paths.mediaRoot
    : path.join(root, config.paths.mediaRoot);
  const cacheDir = path.isAbsolute(config.thumbs.cacheDir)
    ? config.thumbs.cacheDir
    : path.join(root, config.thumbs.cacheDir);
  const metaCacheFile = path.join(cacheDir, 'filemeta.json');

  let fileMetaCache = null;
  let fileMetaDirty = false;
  let sharpMod = null;

  const loadFileMeta = async () => {
    fileMetaCache ??= (await readJsonIfExists(metaCacheFile)) || {};
    return fileMetaCache;
  };

  const flushFileMeta = async () => {
    if (!fileMetaDirty || !fileMetaCache) return;
    await writeJsonAtomic(metaCacheFile, fileMetaCache);
    fileMetaDirty = false;
  };

  async function getSharp() {
    sharpMod ??= (await import('sharp')).default;
    return sharpMod;
  }

  /** 探测图片宽高（失败不抛错，交给缩略图环节兜底） */
  async function probeImage(full) {
    try {
      const sharp = await getSharp();
      const m = await sharp(full, { failOn: 'none' }).metadata();
      return {
        w: m.autoOrient?.width ?? m.width ?? null,
        h: m.autoOrient?.height ?? m.height ?? null,
        format: m.format || null,
      };
    } catch {
      return { w: null, h: null, format: null };
    }
  }

  /** 读文件元信息（带 mtime+size 校验的磁盘缓存） */
  async function mediaMeta(full, rel, stat, kind, limit) {
    const cache = await loadFileMeta();
    const hit = cache[rel];
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.kind === kind) return hit;

    const extra = kind === 'image' ? await limit(() => probeImage(full)) : { w: null, h: null, format: null };
    const rec = { kind, ext: extOf(rel), size: stat.size, mtimeMs: stat.mtimeMs, ...extra };
    cache[rel] = rec;
    fileMetaDirty = true;
    return rec;
  }

  async function buildEntry(opts) {
    const { date, entryKey, absDir, rawFiles, meta, caption, singleFile, limit } = opts;

    // 同名图片 + 视频 → 图片当作视频封面，不作为独立媒体
    const imageByBase = new Map();
    for (const f of rawFiles) {
      if (f.kind !== 'image') continue;
      imageByBase.set(path.basename(f.rel, path.extname(f.rel)).toLowerCase(), f);
    }
    const consumed = new Set();
    for (const f of rawFiles) {
      if (f.kind !== 'video') continue;
      const poster = imageByBase.get(path.basename(f.rel, path.extname(f.rel)).toLowerCase());
      if (poster) consumed.add(poster.rel);
    }

    const media = [];
    for (const f of rawFiles) {
      const stat = await fsp.stat(f.full).catch(() => null);
      if (!stat) continue;
      const relToRoot = path.relative(mediaRoot, f.full).split(path.sep).join('/');
      const info = await mediaMeta(f.full, relToRoot, stat, f.kind, limit);
      const posterFile =
        f.kind === 'video'
          ? imageByBase.get(path.basename(f.rel, path.extname(f.rel)).toLowerCase())
          : null;
      const override = (meta.media && (meta.media[f.rel] || meta.media[f.name])) || {};

      media.push({
        key: shortHash(relToRoot),
        rel: relToRoot,
        name: f.name,
        ext: info.ext,
        kind: f.kind,
        // 同名图片只作为视频封面存在，不算独立素材展示，但缩略图照样要生成
        role: consumed.has(f.rel) ? 'poster' : 'media',
        size: info.size,
        w: override.width ?? info.w ?? null,
        h: override.height ?? info.h ?? null,
        format: info.format || null,
        native:
          f.kind === 'image'
            ? NATIVE_IMAGE_EXT.has(info.ext)
            : NATIVE_VIDEO_EXT.has(info.ext),
        duration: override.duration ?? null,
        posterRel: posterFile
          ? path.relative(mediaRoot, posterFile.full).split(path.sep).join('/')
          : null,
        rev: `${Math.round(stat.mtimeMs)}-${stat.size}`,
      });
    }

    const shown = media.filter((m) => m.role !== 'poster');
    if (shown.length === 0) return null;

    const time = (meta.time || '').toString().slice(0, 5);
    const kid = meta.kid
      ? config.kids.find(
          (k) => k.id === meta.kid || k.name === meta.kid || (k.aliases || []).includes(meta.kid),
        ) || null
      : config.feed.detectKidFromName
        ? detectKid(entryKey, config.kids)
        : null;

    const slash = entryKey.lastIndexOf('/');

    return {
      id: shortHash(entryKey),
      key: entryKey,
      // 这条动态在照片库里的所在目录（前端「复制文件夹路径」用它）：
      // 子目录形态 entryKey 本身就是目录；散落文件形态要削掉文件名
      dir: singleFile ? (slash > 0 ? entryKey.slice(0, slash) : '') : entryKey,
      date,
      time: time || null,
      // 同日内排序用：time 缺省为 '00:00'，再按原始条目名自然序兜底
      sortKey: `${time || '00:00'}#${entryKey}`,
      title: meta.title || (singleFile ? '' : stripKidAlias(stripSortPrefix(path.basename(entryKey)), kid)),
      caption: (caption || meta.caption || '').toString().trim(),
      location: meta.location || '',
      // 谁上传的（页面发布时由 upload.mjs 写进 meta.json）。
      // author 给人看，authorId 给程序用 —— 昵称改了以后旧记录仍保留当时的写法。
      author: (meta.author || '').toString().trim(),
      authorId: (meta.authorId || '').toString().trim(),
      notes: Array.isArray(meta.notes) ? meta.notes.map((n) => String(n)).filter(Boolean) : [],
      kid: kid ? { id: kid.id, name: kid.name } : null,
      // 拍摄那天的实际年龄，前端直接显示，避免前后端两套算法
      age: kid ? ageAt(kid.birthday, date) : '',
      cover: (shown.find((m) => m.kind === 'image') || shown[0]).key,
      counts: {
        image: shown.filter((m) => m.kind === 'image').length,
        video: shown.filter((m) => m.kind === 'video').length,
      },
      media,
    };
  }

  async function scanDateDir(dirName, absDateDir, warnings) {
    const m = DATE_DIR_RE.exec(dirName);
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const dateSuffix = (m[4] || '').trim();

    const items = await fsp.readdir(absDateDir, { withFileTypes: true }).catch(() => []);
    const dateMetaJson = (await readJsonIfExists(path.join(absDateDir, META_FILE))) || {};
    const entries = [];
    const limit = createLimiter(8);

    for (const item of items) {
      if (isIgnored(item.name, config)) continue;
      const full = path.join(absDateDir, item.name);

      if (item.isDirectory()) {
        const rawFiles = (await collectFiles(full, config)).sort((a, b) =>
          naturalCompare(a.rel, b.rel),
        );
        if (rawFiles.length === 0) continue;
        const meta = (await readJsonIfExists(path.join(full, META_FILE))) || {};
        const entry = await buildEntry({
          date,
          entryKey: `${dirName}/${item.name}`,
          absDir: full,
          rawFiles,
          meta,
          caption: await readFirstTextFile(full, CAPTION_FILES),
          singleFile: false,
          limit,
        });
        if (entry) entries.push(entry);
        continue;
      }

      if (!item.isFile()) continue;
      const kind = classify(item.name, config);
      if (!kind) continue;
      const baseName = path.basename(item.name, path.extname(item.name));
      const story = await readFirstTextFile(absDateDir, [`${baseName}.md`, `${baseName}.txt`]);
      // 日期级 meta.json 只继承 kid / location，文案和标题保持独立
      const entry = await buildEntry({
        date,
        entryKey: `${dirName}/${item.name}`,
        absDir: absDateDir,
        rawFiles: [{ name: item.name, full, rel: item.name, kind }],
        meta: { kid: dateMetaJson.kid, location: dateMetaJson.location },
        caption: story,
        singleFile: true,
        limit,
      });
      if (entry) entries.push(entry);
    }

    entries.sort((a, b) => naturalCompare(b.sortKey, a.sortKey));
    for (const e of entries) e.dateSuffix = dateSuffix;
    return entries;
  }

  async function scan() {
    const warnings = [];
    const started = Date.now();

    const exists = await fsp.access(mediaRoot).then(
      () => true,
      () => false,
    );
    if (!exists) {
      return {
        ok: false,
        emptyReason: 'no-media-root',
        mediaRoot,
        warnings: [`照片库目录不存在：${mediaRoot}`],
        generatedAt: Date.now(),
        stats: { entries: 0, photos: 0, videos: 0, days: 0 },
        days: [],
        entries: [],
      };
    }

    const top = await fsp.readdir(mediaRoot, { withFileTypes: true });
    const dateDirs = [];
    for (const item of top) {
      if (isIgnored(item.name, config)) continue;
      if (!item.isDirectory()) continue;
      if (DATE_DIR_RE.test(item.name)) dateDirs.push(item.name);
      else warnings.push(`目录名不是 yyyy-MM-dd 开头，已跳过：${item.name}/`);
    }
    dateDirs.sort((a, b) => naturalCompare(b, a));

    const entries = [];
    const days = [];
    for (const d of dateDirs) {
      const dayEntries = await scanDateDir(d, path.join(mediaRoot, d), warnings);
      if (dayEntries.length === 0) continue;
      const dm = dateMeta(d.slice(0, 10));
      days.push({
        ...dm,
        suffix: dayEntries[0].dateSuffix || '',
        entryCount: dayEntries.length,
        photos: dayEntries.reduce((n, e) => n + e.counts.image, 0),
        videos: dayEntries.reduce((n, e) => n + e.counts.video, 0),
      });
      entries.push(...dayEntries);
    }

    await flushFileMeta();

    return {
      ok: true,
      mediaRoot,
      generatedAt: Date.now(),
      scanMs: Date.now() - started,
      warnings,
      stats: {
        entries: entries.length,
        photos: entries.reduce((n, e) => n + e.counts.image, 0),
        videos: entries.reduce((n, e) => n + e.counts.video, 0),
        days: days.length,
        firstDate: days.length ? days[days.length - 1].date : null,
        lastDate: days.length ? days[0].date : null,
      },
      days,
      entries,
    };
  }

  /** 清掉文件元信息缓存，强制下次重新探测宽高 */
  async function resetCache() {
    fileMetaCache = null;
    fileMetaDirty = false;
    await fsp.rm(metaCacheFile, { force: true });
  }

  return { scan, resetCache, mediaRoot, cacheDir };
}
