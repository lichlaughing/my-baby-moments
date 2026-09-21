#!/usr/bin/env node
/**
 * 生成示例照片库，让页面第一次打开就有内容可看。
 *
 *   node scripts/seed-demo.mjs          只在 photos/ 为空时创建
 *   node scripts/seed-demo.mjs --force  先清掉上一次生成的示例条目，再重新创建
 *
 * 图片来自 picsum.photos（真实照片，占位用），视频来自公开测试片源。
 * 这些都是**占位素材**，把自己照片库整理好之后，直接删掉 photos/ 下这些日期目录即可。
 *
 * 注意：--force **只删本脚本自己生成的条目**（见 demoPaths()），
 * 不会 rm -rf 整个 photos/，所以你后面放进去的真实照片不会被误删。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHOTOS = path.join(ROOT, 'photos');
const VIDEO_URL = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';

/** [日期, 条目名, 图片数, 可选配置] */
const PLAN = [
  ['2026-09-20', '001-大宝-公园的下午', 3, { caption: '风挺大，捡了一下午树叶。\n回家路上一直说"明天还来"。' }],
  [
    '2026-09-20',
    '002-二宝-第一次翻身',
    4,
    {
      meta: { kid: '二宝', location: '家里', time: '16:20', notes: ['妈妈：翻过去之后自己愣住了', '奶奶：录下来了'] },
    },
  ],
  // 散落文件：直接放在日期目录下，单独成一条动态，文案用同名 .md
  ['2026-09-20', '003-随手拍', 1, { loose: true, caption: '顺手拍的一张。散落文件也可以单独写文案。' }],
  ['2026-09-06', '001-周末在家', 6, { meta: { kid: '大宝', location: '家', time: '10:05' } }],
  ['2026-09-06', '002-两宝合影', 9, { caption: '很难得两个人都在看镜头。' }],
  ['2026-08-15', '001-姐姐的积木', 12, { meta: { kid: '大宝', location: '客厅', time: '15:40' } }],
  ['2026-06-01', '001-儿童节', 2, { caption: '第一次坐旋转木马，全程没敢睁眼。' }],
];

const VIDEO_ENTRY = [
  '2026-08-02',
  '001-示例视频-学走路',
  { caption: '这里放视频。跟视频同名的 jpg 会自动被当作封面，不会重复显示成一张照片。' },
];

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` };

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.length;
}

/**
 * 本脚本会写出的全部路径，拆成「条目」和「日期目录」两组。
 * --force 只删这两组，绝不碰你自己加进来的照片。
 */
function demoPaths() {
  const entries = [];
  for (const [date, entry, , cfg] of PLAN) {
    const dayDir = path.join(PHOTOS, date);
    if (cfg?.loose) {
      // 散落文件直接躺在日期目录里，只删这两个文件
      entries.push(path.join(dayDir, `${entry}.jpg`), path.join(dayDir, `${entry}.md`));
    } else {
      entries.push(path.join(dayDir, entry));
    }
  }
  entries.push(path.join(PHOTOS, VIDEO_ENTRY[0], VIDEO_ENTRY[1]), path.join(PHOTOS, 'README.md'));

  const dates = [...new Set([...PLAN.map(([d]) => d), VIDEO_ENTRY[0]])];
  return { entries, dirs: dates.map((d) => path.join(PHOTOS, d)) };
}

/** 判断目录是否为空（不存在也算空） */
async function isEmptyDir(dir) {
  const names = await fs.readdir(dir).catch(() => null);
  return names !== null && names.length === 0;
}

async function runLimited(tasks, limit = 6) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  });
  await Promise.all(workers);
}

async function main() {
  const force = process.argv.includes('--force');

  const exists = await fs
    .readdir(PHOTOS)
    .then((f) => f.filter((n) => !n.startsWith('.')).length > 0)
    .catch(() => false);

  if (exists && !force) {
    console.log(c.yellow('  photos/ 里已经有内容了。加 --force 才会重新生成示例条目。'));
    console.log(c.dim('  （--force 只清本脚本生成的示例条目，不会删你自己的照片）'));
    return;
  }

  if (force) {
    const { entries, dirs } = demoPaths();
    // 先删具体条目，再收掉因此变空的日期目录（非空就留着，里面有你自己的东西）
    for (const p of entries) await fs.rm(p, { recursive: true, force: true });
    for (const p of dirs) {
      if (await isEmptyDir(p)) await fs.rmdir(p).catch(() => {});
    }
  }
  await fs.mkdir(PHOTOS, { recursive: true });

  const jobs = [];
  let count = 0;

  for (const [date, entry, n, cfg] of PLAN) {
    // loose：文件直接放日期目录下，而不是再套一层子文件夹
    const loose = Boolean(cfg.loose);
    const dir = loose ? path.join(PHOTOS, date) : path.join(PHOTOS, date, entry);
    await fs.mkdir(dir, { recursive: true });
    for (let k = 1; k <= n; k += 1) {
      const seq = loose && n === 1 ? '' : String(k).padStart(3, '0');
      const base = loose ? entry : seq;
      const dest = path.join(dir, `${base}.jpg`);
      const seed = `bm-${date}-${entry}-${seq || '1'}`.replace(/[^\w-]/g, '');
      jobs.push(async () => {
        try {
          await download(`https://picsum.photos/seed/${encodeURIComponent(seed)}/900/1200`, dest);
          count += 1;
        } catch (err) {
          console.error(c.yellow(`  ! ${dest} 下载失败：${err.message}`));
        }
      });
      if (loose && cfg.caption) {
        await fs.writeFile(path.join(dir, `${base}.md`), `${cfg.caption}\n`);
      }
    }
    if (!loose && cfg.caption) await fs.writeFile(path.join(dir, 'caption.md'), `${cfg.caption}\n`);
    if (!loose && cfg.meta) await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(cfg.meta, null, 2)}\n`);
  }

  // 视频条目：一个 mp4 + 同名 jpg 封面
  {
    const [date, entry, cfg] = VIDEO_ENTRY;
    const dir = path.join(PHOTOS, date, entry);
    await fs.mkdir(dir, { recursive: true });
    jobs.push(async () => {
      try {
        await download(VIDEO_URL, path.join(dir, '001.mp4'));
      } catch (err) {
        console.error(c.yellow(`  ! 示例视频下载失败：${err.message}`));
      }
    });
    jobs.push(async () => {
      try {
        await download('https://picsum.photos/seed/bm-video-poster/1280/720', path.join(dir, '001.jpg'));
        count += 1;
      } catch (err) {
        console.error(c.yellow(`  ! 视频封面下载失败：${err.message}`));
      }
    });
    await fs.writeFile(path.join(dir, 'caption.md'), `${cfg.caption}\n`);
  }

  console.log(c.dim(`  下载 ${jobs.length} 个占位素材…`));
  await runLimited(jobs, 6);

  await fs.writeFile(
    path.join(PHOTOS, 'README.md'),
    `# photos/ 目录规范

示例内容（\`2026-*\` 这些日期目录）是占位素材，整理好你自己的照片后删掉即可。

## 结构

\`\`\`
photos/
├── 2026-09-20/               一级目录名必须是 yyyy-MM-dd
│   ├── 001-第一次翻身/        子文件夹 = 一条动态，里面的照片排成九宫格
│   │   ├── 001.jpg
│   │   ├── 002.mp4
│   │   ├── 001.jpg            跟 002.mp4 同名 → 自动作为视频封面
│   │   ├── caption.md        可选：这条动态的文案
│   │   └── meta.json         可选：宝宝 / 地点 / 时间 / 留言
│   └── 随手拍.jpg             直接放文件 = 每个文件各成一条动态
└── 2026-09-18/
\`\`\`

## 规则

- **日期**：一级目录名必须能匹配 \`yyyy-MM-dd\`，后面可以跟后缀，例如 \`2026-09-20-秋游\`。
- **一天多条**：在日期目录下建子文件夹，名称用 \`001-\`、\`002-\` 前缀控制顺序（编号越大越靠前）。
- **文案**：子文件夹里放 \`caption.md\`（或 \`caption.txt\`）。散落文件则放同名的 \`.md\`，例如 \`随手拍.md\`。
- **顺序**：同一天里写了 \`meta.json\` 的 \`time\` 就按时间排，否则按文件名自然序（001 < 002 < 010）。
- **宝宝归属**：\`meta.json\` 里写 \`kid\` 最准确；没写的话会从目录名猜（例如 \`001-大宝-xxx\`）。

## meta.json 支持的字段

\`\`\`json
{
  "kid": "大宝",
  "title": "第一次翻身",
  "caption": "也可以把文案写在这里",
  "location": "家里",
  "time": "16:20",
  "notes": ["妈妈：太可爱了", "奶奶：长高了"],
  "media": {
    "001.mp4": { "duration": 12, "width": 1920, "height": 1080 }
  }
}
\`\`\`

- \`kid\` 可以填 \`moments.config.mjs\` 里任一宝宝的 \`id\`、\`name\` 或 \`aliases\`。
- \`title\` 不写时自动取文件夹名去掉序号前缀的那部分。
- \`notes\` 会渲染成类似朋友圈评论区的灰色留言块。
- \`media\` 用来给单个文件补充浏览器读不到的信息（视频时长、尺寸）。
`,
  );

  console.log(c.green(`\n  ✓ 示例照片库已生成：${count} 张图片 + 1 个视频\n`));
  console.log(c.dim('  运行 npm start 打开页面，或在 photos/ 里换成你自己的照片\n'));
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
