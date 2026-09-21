#!/usr/bin/env node
/**
 * 从 Phosphor Icons 官方仓库拉取所需图标，内联成 <symbol> 雪碧图写进 public/index.html。
 *
 * 为什么内联：`<use href="外部文件#id">` 里 `currentColor` 的传递在部分浏览器上不可靠，
 * 内联到同一文档最稳；同时也省掉一个运行时请求和 CDN 依赖。
 *
 * 为什么不用手写 path：图标路径数据由官方包提供，手搓容易画歪。
 *
 * 用法：node scripts/fetch-icons.mjs   （幂等，可重复执行；只在网络可用时需要跑）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'public', 'index.html');
const VERSION = '2.1.1';
const BASE = `https://unpkg.com/@phosphor-icons/core@${VERSION}/assets`;

/** [文件名, 输出 id 后缀] */
const ICONS = [
  ['play', 'play'],
  ['x', 'x'],
  ['caret-left', 'caret-left'],
  ['caret-right', 'caret-right'],
  ['caret-down', 'caret-down'],
  ['sun', 'sun'],
  ['moon', 'moon'],
  ['arrow-up', 'arrow-up'],
  ['arrow-clockwise', 'refresh'],
  ['download-simple', 'download-simple'],
  ['arrows-out-simple', 'arrows-out-simple'],
  ['image', 'image'],
  ['images', 'images'],
  ['film-strip', 'film-strip'],
  ['folder-simple', 'folder-simple'],
  ['warning-circle', 'warning'],
  ['spinner-gap', 'spinner'],
  ['dots-three', 'more'],
  ['map-pin', 'map-pin'],
  ['clock', 'clock'],
  ['camera', 'camera'],
  ['video-camera', 'video-camera'],
  ['upload-simple', 'upload-simple'],
  ['check-circle', 'check-circle'],
  ['trash-simple', 'trash'],
  ['calendar-blank', 'calendar'],
  // 账号认证：登录 / 退出 / 账号 / 口令 / 口令显隐 / 身份标识
  ['sign-in', 'sign-in'],
  ['sign-out', 'sign-out'],
  ['user', 'user'],
  ['user-circle', 'user-circle'],
  ['lock-simple', 'lock'],
  ['eye', 'eye'],
  ['eye-slash', 'eye-slash'],
];

const MARK_START = '<!--ICON_SPRITE_START-->';
const MARK_END = '<!--ICON_SPRITE_END-->';

function toSymbol(name, id, svg) {
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] || '0 0 256 256';
  // fill="currentColor" 必须显式写上：Phosphor 的 path 不带 fill 属性，
  // 靠 CSS 的 `svg { fill: currentColor }` 兜底只覆盖得到本项目的选择器。
  // 写进 symbol 后，图标在任何宿主（甚至脱离本项目的 CSS）里都跟随文字颜色。
  return `      <symbol id="i-${id}" viewBox="${viewBox}" fill="currentColor">${inner}</symbol>`;
}

async function main() {
  const html = await fs.readFile(TARGET, 'utf8');
  if (!html.includes(MARK_START) || !html.includes(MARK_END)) {
    console.error(`× 在 public/index.html 里找不到图标占位标记，无法写入。`);
    process.exit(1);
  }

  const symbols = [];
  const failed = [];
  for (const [file, id] of ICONS) {
    const res = await fetch(`${BASE}/regular/${file}.svg`).catch(() => null);
    if (!res?.ok) {
      failed.push(`${file} (HTTP ${res?.status ?? 'network'})`);
      continue;
    }
    const svg = await res.text();
    if (!/<path|<circle|<rect/.test(svg)) {
      failed.push(`${file} (内容不是图标)`);
      continue;
    }
    symbols.push(toSymbol(file, id, svg));
  }

  if (symbols.length === 0) {
    console.error('× 一个图标都没拉到，检查网络后重试。');
    process.exit(1);
  }

  // 两个标记都必须出现在写回的 block 里。
  // 早先的写法把 MARK_START 从替换串里剥掉了，于是标记被自己的输出吃掉：
  // 第一次跑成功、第二次跑直接报「找不到占位标记」——所谓的幂等是假的。
  const block = [
    MARK_START,
    `      <!-- Phosphor Icons v${VERSION} · MIT · https://phosphoricons.com -->`,
    ...symbols,
    `      ${MARK_END}`,
  ].join('\n');

  const next = html.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
  await fs.writeFile(TARGET, next);

  console.log(`✓ 已写入 ${symbols.length} 个图标到 public/index.html`);
  if (failed.length) console.warn(`  跳过 ${failed.length} 个：${failed.join(', ')}`);
}

main();
