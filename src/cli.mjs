#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   node src/cli.mjs serve   [--port 4310] [--host 127.0.0.1] [--open] [--no-watch]
 *   node src/cli.mjs scan    [--thumbs] [--json]
 *   node src/cli.mjs build   [--out dist] [--base /baby] [--copy-media]
 *   node src/cli.mjs clean   [--all]
 *   node src/cli.mjs passwd  [--id mama] [--name 妈妈]   生成上传账号的口令哈希
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from './server.mjs';
import { createScanner } from './scan.mjs';
import { createThumbs } from './thumbs.mjs';
import { resolveReadScope } from './auth.mjs';
import { decorateManifest, siteConfig, toScriptJson } from './manifest.mjs';
import { humanSize } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function loadConfig(args) {
  const cfgPath = args.config
    ? path.resolve(ROOT, String(args.config))
    : path.join(ROOT, 'moments.config.mjs');
  if (!fs.existsSync(cfgPath)) {
    console.error(c.red(`找不到配置文件：${cfgPath}`));
    process.exit(1);
  }
  const mod = await import(pathToFileURL(cfgPath).href);
  const config = mod.default;
  if (args.port) config.server.port = Number(args.port);
  if (args.host) config.server.host = String(args.host);
  if (args['no-watch']) config.server.watch = false;
  return config;
}

function summary(manifest) {
  const { stats, warnings = [] } = manifest;
  const lines = [
    `${c.bold('日期')}      ${String(stats.days).padStart(6)} 天`,
    `${c.bold('动态')}      ${String(stats.entries).padStart(6)} 条`,
    `${c.bold('照片')}      ${String(stats.photos).padStart(6)} 张`,
    `${c.bold('视频')}      ${String(stats.videos).padStart(6)} 个`,
  ];
  if (stats.firstDate) lines.push(`${c.bold('时间跨度')}  ${stats.firstDate} → ${stats.lastDate}`);
  if (warnings.length) {
    lines.push('');
    lines.push(c.yellow(`⚠ ${warnings.length} 条提示：`));
    for (const w of warnings.slice(0, 8)) lines.push(c.dim(`  - ${w}`));
    if (warnings.length > 8) lines.push(c.dim(`  ... 还有 ${warnings.length - 8} 条`));
  }
  return lines.join('\n');
}

const openBrowser = (url) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], () => {});
};

// ────────────────────────────── serve ──────────────────────────────
async function cmdServe(args) {
  const config = await loadConfig(args);
  const app = createServer(config, { root: ROOT });
  app.startWatch();

  const { port, host } = config.server;
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

  console.log('');
  console.log(`  ${c.bold(config.site.title)}  ${c.dim('· 本地预览')}`);
  console.log(`  ${c.cyan(url)}`);
  console.log(`  ${c.dim('照片库')} ${app.scanner.mediaRoot}`);
  console.log(`  ${c.dim('访问范围')} ${app.auth.describeRead()}`);
  console.log(`  ${c.dim('上传账号')} ${app.auth.describe()}`);
  console.log('');

  // 开了认证却没配账号时，请求会被挡住。这是刻意为之（静默放行更危险），
  // 所以必须把"怎么修"当场说清楚，别让人去翻源码。
  if (app.auth.misconfigured) {
    console.log(
      c.yellow(
        `  ⚠ 账号认证已开启，但一个账号都没有 —— 现在${app.auth.readsGated ? '整站都进不去' : '谁也传不了'}。`,
      ),
    );
    console.log(c.dim('    二选一：'));
    console.log(c.dim(`      1. ${c.bold('npm run passwd')}  生成账号，把输出粘进 moments.config.mjs → auth.users`));
    console.log(c.dim(`      2. 把 moments.config.mjs 里的 ${c.bold('auth.enabled')} 改成 false（谁都能看、谁都能传）`));
    console.log('');
  }

  const started = Date.now();
  const manifest = await app.getManifest(true);
  if (manifest.ok) {
    console.log(summary(manifest));
    console.log(c.dim(`\n  首次扫描 ${Date.now() - started}ms（缩略图在浏览时按需生成）\n`));
  } else {
    console.log(c.yellow(`  照片库还是空的，或目录不存在。`));
    console.log(c.dim(`  按下面的结构放照片，页面会自动刷新：\n`));
    console.log(c.dim(`    photos/2026-09-20/001-第一次翻身/001.jpg\n`));
  }
  if (config.server.watch) console.log(c.dim('  监听中：往照片目录丢文件，页面会自动更新\n'));

  if (args.open) openBrowser(url);

  const shutdown = () => {
    app.closeWatch();
    app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {});
}

// ────────────────────────────── scan ──────────────────────────────
async function cmdScan(args) {
  const config = await loadConfig(args);
  const scanner = createScanner(config, { root: ROOT });
  const t0 = Date.now();
  const manifest = await scanner.scan();

  if (args.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${c.bold('扫描完成')}  ${c.dim(`${Date.now() - t0}ms`)}`);
  console.log('');
  console.log(summary(manifest));
  console.log('');

  if (!args.thumbs) {
    console.log(c.dim('  提示：加 --thumbs 可以预生成全部缩略图（首次浏览会更快）\n'));
    return;
  }

  const thumbs = createThumbs(config, { root: ROOT, mediaRoot: scanner.mediaRoot });
  const all = manifest.entries.flatMap((e) => e.media);
  const jobs = all.flatMap((m) =>
    m.kind === 'video'
      ? [{ m, variant: 'grid' }] // 视频只需要一个封面帧，没有"大图"这回事
      : [
          { m, variant: 'grid' },
          { m, variant: 'view' },
        ],
  );
  let done = 0;
  let failed = 0;
  let bytes = 0;
  const t1 = Date.now();
  for (const { m, variant } of jobs) {
    try {
      const r = await thumbs.ensure({
        key: m.key,
        rel: m.rel,
        rev: m.rev,
        variant,
        ext: m.ext,
        kind: m.kind,
      });
      if (!r.cached) bytes += r.bytes || 0;
    } catch (err) {
      failed += 1;
      console.error(c.red(`  ✗ ${m.rel} (${variant}): ${err.message.split('\n')[0]}`));
    }
    done += 1;
    if (done % 20 === 0 || done === jobs.length) {
      process.stdout.write(`\r  ${c.dim('生成缩略图')} ${done}/${jobs.length}`);
    }
  }
  process.stdout.write('\r\x1b[K');
  const size = await thumbs.cacheSize();
  console.log(
    `  ${c.green('缩略图就绪')}  ${all.length} 个媒体 · 新增 ${humanSize(bytes)} · 缓存共 ${humanSize(size.bytes)} / ${size.files} 个文件`,
  );
  if (failed) console.log(`  ${c.yellow(`${failed} 个失败`)}（上面有逐条原因）`);
  console.log(c.dim(`  耗时 ${Date.now() - t1}ms\n`));
}

// ────────────────────────────── build ──────────────────────────────
async function cmdBuild(args) {
  const config = await loadConfig(args);
  const outDir = path.resolve(ROOT, String(args.out || 'dist'));
  const base = args.base ? String(args.base) : '';

  const scanner = createScanner(config, { root: ROOT });
  const thumbs = createThumbs(config, { root: ROOT, mediaRoot: scanner.mediaRoot });
  const manifest = await scanner.scan();

  if (!manifest.ok || manifest.entries.length === 0) {
    console.error(c.red('  没有可导出的内容（照片库为空）'));
    process.exit(1);
  }

  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  // 1. 前端资源
  await fsp.cp(path.join(ROOT, 'public'), outDir, { recursive: true });

  // 1b. 站点配置注入（跟 serve 时同一套占位替换）
  //     静态产物没有后端，上传能力必须显式关掉，否则页面上的发布按钮点下去只会报错。
  //     readScope 同理写死成 'upload'（= 读侧不设限）：产物里没有任何鉴权，
  //     若把配置里的 'latest' / 'all' 照搬进去，页面会以为该弹登录框，而后端根本不存在。
  const cfgJson = toScriptJson(siteConfig(config, { uploadEnabled: false, readScope: 'upload' }));
  const indexPath = path.join(outDir, 'index.html');
  await fsp.writeFile(
    indexPath,
    (await fsp.readFile(indexPath, 'utf8')).replace(
      '<!--SITE_CONFIG-->',
      `<script id="site-config" type="application/json">${cfgJson}</script>`,
    ),
  );

  // 2. 缩略图（按 URL 布局落盘：thumb/<key>/<variant>/<rev>.webp）
  let thumbCount = 0;
  const all = manifest.entries.flatMap((e) => e.media);
  const jobs = all.flatMap((m) =>
    m.kind === 'video'
      ? [{ m, variant: 'grid' }]
      : [
          { m, variant: 'grid' },
          { m, variant: 'view' },
        ],
  );
  for (const { m, variant } of jobs) {
    try {
      const { file } = await thumbs.ensure({
        key: m.key,
        rel: m.rel,
        rev: m.rev,
        variant,
        ext: m.ext,
        kind: m.kind,
      });
      const dest = path.join(outDir, 'thumb', m.key, variant, `${m.rev}.webp`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(file, dest);
      thumbCount += 1;
    } catch (err) {
      console.error(c.yellow(`  ! 跳过缩略图 ${m.rel} (${variant}): ${err.message.split('\n')[0]}`));
    }
  }

  // 3. 原始媒体（可选；照片体积大，默认不复制，靠源站或本地目录提供）
  let mediaCount = 0;
  if (args['copy-media']) {
    for (const m of all) {
      const src = path.join(scanner.mediaRoot, m.rel);
      const dest = path.join(outDir, 'media', m.rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      mediaCount += 1;
    }
  }

  // 4. feed.json —— 页面在 /api/feed 404 时会自动回落到它
  //    没加 --copy-media 时产物里没有 /media/*，必须让装饰层知道，
  //    否则视频 poster 和动图原图会指向 404 的地址（视频直接黑屏）。
  const mediaAvailable = Boolean(args['copy-media']);
  const decorated = decorateManifest(config, manifest, base, { mediaAvailable });
  delete decorated.mediaRoot;
  delete decorated.scanMs;
  await fsp.writeFile(path.join(outDir, 'feed.json'), JSON.stringify(decorated));

  const videoCount = all.filter((m) => m.kind === 'video').length;

  console.log('');
  console.log(`  ${c.green('静态导出完成')}  →  ${c.bold(outDir)}`);
  console.log('');
  console.log(`  动态 ${manifest.stats.entries} 条 · 缩略图 ${thumbCount} 个${mediaCount ? ` · 原始媒体 ${mediaCount} 个` : ''}`);
  if (!args['copy-media']) {
    console.log(c.dim('  未复制原始图片/视频，静态站只带缩略图与 feed.json。'));
    console.log(c.dim('  图片正常显示（走缩略图），但原图和视频不在这里。'));
    if (videoCount > 0) {
      console.log(
        c.yellow(`  ! 有 ${videoCount} 个视频：静态站里放不了，只会显示封面图。`) +
          c.dim('\n    要能播就加 --copy-media，或把 videos 单独托管后改 feed.json 里的 urls.src。'),
      );
    }
    console.log(c.dim('  要连原图一起带走（可离线打开）加 --copy-media。'));
  }
  if (base) console.log(c.dim(`  部署前缀：${base}`));

  // 静态产物没有后端，auth.scope 三档全都不生效 —— 产物是全员可看的。
  // 不把这句说出来的话，很容易误以为"配了 scope 就等于上了锁"，然后把 dist 丢出去。
  const { scope: readScope } = resolveReadScope(config.auth || {});
  if (readScope !== 'upload') {
    console.log('');
    console.log(c.yellow('  ! 静态产物里没有任何鉴权 —— 照片对拿到地址的人都是可看的'));
    console.log(
      c.dim(
        `    配置里的 auth.scope = '${readScope}' 只在 npm start 的本地服务下生效；\n` +
          `    这里导出的是一堆静态文件，谁拿到就能看谁就能下载。\n` +
          `    要分享给家人又不想公开，用 npm start（可加 host: '0.0.0.0' 让局域网可访问），别用 dist。`,
      ),
    );
  }
  console.log(c.dim(`\n  本地验证：npx serve ${path.relative(ROOT, outDir) || '.'}\n`));
}

// ────────────────────────────── clean ──────────────────────────────
async function cmdClean(args) {
  const config = await loadConfig(args);
  const cacheDir = path.isAbsolute(config.thumbs.cacheDir)
    ? config.thumbs.cacheDir
    : path.join(ROOT, config.thumbs.cacheDir);
  // 不带 --all 时也要顺手收掉 uploads：上传中途被打断会在那里留下半截临时文件
  const targets = args.all
    ? [cacheDir]
    : [path.join(cacheDir, 'thumbs'), path.join(cacheDir, 'uploads')];
  let freed = 0;
  for (const target of targets) {
    const size = await fsp
      .stat(target)
      .then(
        async (s) => (s.isDirectory() ? (await dirSize(target)) : s.size),
        () => null,
      );
    await fsp.rm(target, { recursive: true, force: true });
    freed += size || 0;
    console.log(`  已删除 ${c.bold(path.relative(ROOT, target) || target)}`);
  }
  if (freed) console.log(c.dim(`  释放 ${humanSize(freed)}`));
  if (!args.all) console.log(c.dim('  加 --all 可以连扫描缓存一起删\n'));
}

async function dirSize(dir) {
  let total = 0;
  for (const it of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) total += await dirSize(p);
    else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// ────────────────────────────── passwd ──────────────────────────────
/**
 * 生成账号口令哈希，并打印可直接粘贴进 moments.config.mjs 的片段。
 *
 * 交互式输入口令时不开回显；**非交互终端（管道/CI）直接报错退出**，
 * 不做"试着读一行"这种动作 —— stdin 未关闭时会永久挂起，已关闭时会静默读到空串，
 * 两种都很难排查。
 */
async function cmdPasswd(args) {
  const { hashPassword } = await import('./auth.mjs');
  const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

  if (!process.stdin.isTTY && !args.password) {
    console.error(c.red('\n  这个命令需要交互式终端来输入口令（不回显）。'));
    console.error(c.dim('  当前 stdin 不是终端，不能安全地读口令。'));
    console.error(c.dim('  请在终端里直接跑：npm run passwd\n'));
    process.exit(1);
  }

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(c.dim(q));

  let name = String(args.name || '').trim();
  if (!name) name = (await ask('  昵称（显示在页面的署名里）：')).trim();
  if (!name) {
    console.error(c.red('\n  昵称不能为空。\n'));
    process.exit(1);
  }

  let id = String(args.id || '').trim();
  if (!id) {
    const guess = ID_RE.test(name) ? name.toLowerCase() : `u${Math.random().toString(36).slice(2, 5)}`;
    id = (await ask(`  账号 id（英文/数字/_-，回车用 ${c.bold(guess)}）：`)).trim() || guess;
  }
  if (!ID_RE.test(id)) {
    console.error(c.red(`\n  账号 id "${id}" 不合法：只允许字母、数字、下划线和短横线，最长 32 位。\n`));
    process.exit(1);
  }

  rl.close();

  let password = String(args.password || '');
  if (!password) {
    password = await askHidden('  口令（输入时不显示）：');
    const again = await askHidden('  再输一次确认：');
    if (password !== again) {
      console.error(c.red('\n  两次输入不一致，没有生成任何东西。\n'));
      process.exit(1);
    }
  }
  if (password.length < 6) {
    console.error(c.red('\n  口令太短了（至少 6 位）。没有生成任何东西。\n'));
    process.exit(1);
  }

  const hash = hashPassword(password);
  console.log('');
  console.log(`  ${c.green('已生成')}  ${c.dim('把下面这段放进 moments.config.mjs → auth.users 里：')}`);
  console.log('');
  console.log(`      {\n        id: ${JSON.stringify(id)},\n        name: ${JSON.stringify(name)},\n        passwordHash:\n          '${hash}'\n      },`);
  console.log('');
  console.log(c.dim('  口令本身没有被写进任何文件，只有哈希。改完重启 `npm start` 生效。\n'));
}

/** 读一行但不回显（终端里用 • 代替）。只在 TTY 下可用。 */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(c.dim(prompt));
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let val = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(val);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C：恢复终端设置再退出，否则 shell 会留在 raw 模式里
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (val) {
            val = val.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch === '\u001b' || ch < ' ') continue; // 方向键等控制序列直接忽略
        val += ch;
        process.stdout.write('•');
      }
    };
    stdin.on('data', onData);
  });
}

// ────────────────────────────── main ──────────────────────────────
const COMMANDS = { serve: cmdServe, scan: cmdScan, build: cmdBuild, clean: cmdClean, passwd: cmdPasswd };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args._[0] || 'serve';
  const fn = COMMANDS[name];
  if (!fn) {
    console.log(`\n  用法：node src/cli.mjs <${Object.keys(COMMANDS).join('|')}> [选项]\n`);
    process.exit(1);
  }
  await fn(args);
}

main().catch((err) => {
  console.error(c.red(`\n  ${err.message}\n`));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
