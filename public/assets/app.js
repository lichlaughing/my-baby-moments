/**
 * 宝宝成长记 - 前端逻辑
 *
 * 无框架、无构建步骤，直接操作 DOM。
 * 所有来自文件系统的文本（文案、标题、地点、文件名）一律用 textContent 赋值，不拼 HTML，
 * 避免照片文案里出现 < > & 时把页面搞坏。
 */

const $ = (sel, root = document) => root.querySelector(sel);

const NS = 'http://www.w3.org/2000/svg';
const nf = new Intl.NumberFormat('zh-CN');

/* ────────────────────────────── DOM 小工具 ────────────────────────────── */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'onclick') el.addEventListener('click', v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    } else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(3)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function icon(name, cls = 'icon') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const num = (n) => nf.format(n);

/** 文件体积，给发布面板显示"已选几个 · 多大"用 */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/* ────────────────────────────── 状态 ────────────────────────────── */

const PREF_KEY = 'bm-theme';
const FILTER_KEY = 'bm-filter';

const state = {
  data: null,
  site: {},
  kids: [],
  /** 发布配置（来自 site-config，不在 /api/feed 里，所以单独存） */
  upload: null,
  /**
   * 会话状态：{ authRequired, readScope, configured, user }，来自 GET /api/session。
   * 只问"我是谁"，拿不到就当匿名 —— 不往页面里烘任何身份，静态导出也就不用脱敏。
   * null 表示还没问到（或压根没后端，比如静态导出）。
   */
  session: null,
  /**
   * 注入在 index.html 里的 auth.scope 有效值（'latest' / 'all' / 'upload'）。
   * 只在 /api/session 还没回来（或压根没后端）时用作回落 ——
   * 前端据此只是为了少发一个注定 401 的请求，真正的拦截在服务端。
   */
  readScope: 'upload',
  /** 刚发完动态时短暂静音 SSE，免得被 fs.watch 的第二次广播再刷一遍 */
  muteLiveUntil: 0,
  entries: [],
  rendered: 0,
  batch: 24,
  kid: 'all',
  videoOnly: false,
  lastDay: null,
  lastMonth: null,
  lastDayBody: null,
  pending: null,
  lb: { entry: null, index: 0, opener: null, touchX: null },
};

const hasJs = () => document.body.classList.add('has-js');

/* ────────────────────────────── 主题 ────────────────────────────── */

function resolveDark(pref) {
  return (
    pref === 'dark' ||
    (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  );
}

function applyTheme(pref, { persist = true } = {}) {
  const dark = resolveDark(pref);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePref = pref;
  if (persist) {
    try {
      localStorage.setItem(PREF_KEY, pref);
    } catch {
      /* 隐私模式忽略 */
    }
  }
  const btn = $('#theme-toggle');
  if (btn) {
    btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    btn.title = dark ? '切换到浅色' : '切换到深色';
    btn.setAttribute('aria-label', btn.title);
  }
}

function initTheme() {
  const pref = document.documentElement.dataset.themePref || 'auto';
  applyTheme(pref, { persist: false });
  $('#theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if ((document.documentElement.dataset.themePref || 'auto') === 'auto') {
        applyTheme('auto', { persist: false });
      }
    });
}

/* ────────────────────────────── 提示条 ────────────────────────────── */

let toastTimer = null;
function toast(text, action) {
  const box = $('#toast');
  $('#toast-text').textContent = text;
  const btn = $('#toast-action');
  if (action) {
    btn.hidden = false;
    btn.textContent = action.label;
    btn.onclick = () => {
      box.hidden = true;
      action.run();
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => (box.hidden = true), 2600);
}

/* ────────────────────────────── 加载数据 ────────────────────────────── */

/**
 * 「后端在，但明确拒绝了」的状态码：没登录、没权限、没配好。
 * 这类响应**不能**回落到构建产物里的 feed.json —— 那等于拿一份打包好的旧数据
 * 绕过鉴权，看起来还一切正常。
 * 反过来 404 是"压根没有后端"（静态导出），必须继续走回落。
 */
const FEED_DENIED = (s) => s === 401 || s === 403 || s === 503;

/**
 * 拉扫描结果。失败时把 HTTP 状态码与错误码带到 Error 上 ——
 * 调用方要靠 status === 401 区分"没登录/看不到"和"服务坏了"，
 * 只看 message 会在文案改动时静默失效。
 */
async function fetchFeed(refresh = false) {
  const urls = refresh ? ['/api/feed?refresh=1', '/api/feed'] : ['/api/feed'];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const err = new Error(body?.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = body?.code || '';
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      // 被明确拒绝时别再撞第二个地址（同一件事，结果一样）
      if (FEED_DENIED(err.status)) break;
    }
  }
  // 静态导出场景没有接口（/api/feed 会 404），回落到构建产物里的 feed.json
  if (!FEED_DENIED(lastErr?.status)) {
    try {
      const res = await fetch('./feed.json');
      if (res.ok) return await res.json();
    } catch {
      /* 继续抛原始错误 */
    }
  }
  throw lastErr || new Error('加载失败');
}

/* ────────────────────────────── 封面与筛选 ────────────────────────────── */

function renderCover() {
  const { site, kids } = state;
  document.title = site.title || '宝宝成长记';
  $('#cover-title').textContent = site.title || '宝宝成长记';
  $('#brand-title').textContent = site.title || '宝宝成长记';
  $('#cover-signature').textContent = site.signature || '';
  $('#footer-text').textContent = site.footer || '';

  const list = $('#cover-kids');
  list.replaceChildren();
  for (const k of kids) {
    if (!k.age) continue;
    list.append(
      h(
        'li',
        {},
        h('span', { class: 'cover__kid-name', text: k.name }),
        h('span', { class: 'cover__kid-age', text: k.age }),
      ),
    );
  }

  const avatar = $('#cover-avatar');
  if (site.avatar) {
    avatar.style.backgroundImage = `url("${site.avatar}")`;
    avatar.textContent = '';
  } else {
    avatar.textContent = (site.title || '宝').slice(0, 1);
    avatar.style.backgroundImage = '';
  }

  const media = $('#cover-media');
  if (site.cover) {
    const pre = new Image();
    pre.onload = () => {
      media.style.backgroundImage = `url("${site.cover}")`;
      media.classList.add('is-ready');
      requestAnimationFrame(() => $('#top')?.classList.add('is-settled'));
    };
    pre.src = site.cover;
  } else {
    media.style.backgroundImage = '';
    media.classList.remove('is-ready');
  }
}

function renderFilters() {
  const box = $('#filters');
  const all = state.data?.entries || [];
  const kids = state.kids || [];
  box.replaceChildren();

  const chip = (label, active, onClick, count) => {
    const b = h(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        onclick: onClick,
      },
      label,
    );
    if (count != null) b.append(h('span', { class: 'chip__count', text: num(count) }));
    return b;
  };

  const selectable = kids.filter((k) => all.some((e) => e.kid && e.kid.id === k.id));
  if (selectable.length === 0) {
    box.append(
      chip('全部', state.kid === 'all', () => setKid('all'), all.length),
    );
  } else {
    box.append(chip('全部', state.kid === 'all', () => setKid('all'), all.length));
    for (const k of selectable) {
      box.append(
        chip(
          k.name,
          state.kid === k.id,
          () => setKid(k.id),
          all.filter((e) => e.kid && e.kid.id === k.id).length,
        ),
      );
    }
  }

  const vo = $('#video-only');
  vo.setAttribute('aria-pressed', state.videoOnly ? 'true' : 'false');
}

function setKid(id) {
  state.kid = id;
  persistFilter();
  renderFilters();
  resetFeed();
}

function persistFilter() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ kid: state.kid, videoOnly: state.videoOnly }));
  } catch {
    /* 忽略 */
  }
}

function restoreFilter(kids) {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    const valid = new Set(['all', ...kids.map((k) => k.id)]);
    if (raw.kid && valid.has(raw.kid)) state.kid = raw.kid;
    state.videoOnly = Boolean(raw.videoOnly);
  } catch {
    /* 忽略 */
  }
}

/* ────────────────────────────── 统计行 ────────────────────────────── */

function renderMeta() {
  const list = state.entries;
  const box = $('#meta-line');
  box.replaceChildren();
  if (list.length === 0) return;

  const days = new Set(list.map((e) => e.date)).size;
  const photos = list.reduce((n, e) => n + e.counts.image, 0);
  const videos = list.reduce((n, e) => n + e.counts.video, 0);
  const dates = list.map((e) => e.date).sort();

  const item = (n, unit) =>
    h('span', {}, h('b', { text: num(n) }), ` ${unit}`);

  box.append(item(days, '天'), item(list.length, '条动态'), item(photos, '张照片'));
  if (videos) box.append(item(videos, '个视频'));

  const from = dates[0];
  const to = dates[dates.length - 1];
  const span = from === to ? from : `${from.slice(0, 7)} 至 ${to.slice(0, 7)}`;
  box.append(h('span', { text: span }));
}

/* ────────────────────────────── 一条动态 ────────────────────────────── */

const kidById = (id) => state.kids.find((k) => k.id === id) || null;

function avatarEl(entry) {
  const kid = entry.kid ? kidById(entry.kid.id) : null;
  const src = (kid && kid.avatar) || state.site.avatar;
  const box = h('div', { class: 'moment__avatar', 'aria-hidden': 'true' });
  if (src) {
    box.append(h('img', { src, alt: '', loading: 'lazy', decoding: 'async' }));
  } else {
    box.textContent = (kid?.name || state.site.title || '宝').slice(0, 1);
  }
  return box;
}

/** 视频没有封面帧时的兜底瓦片 */
const videoTile = (ext) =>
  h('span', { class: 'vtile' }, h('span', { class: 'vtile__ext', text: ext || 'video' }));

const brokenTile = () =>
  h('span', { class: 'vtile vtile--quiet' }, icon('image', 'vtile__icon'));

function lazyImg(src, onFail) {
  const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
  if (onFail) {
    img.addEventListener(
      'error',
      () => {
        img.remove();
        onFail();
      },
      { once: true },
    );
  }
  return img;
}

function buildCell(entry, media, index, overflow) {
  const isVideo = media.kind === 'video';
  const btn = h('button', {
    class: isVideo ? 'moment__cell moment__cell--video' : 'moment__cell',
    type: 'button',
    'aria-label': isVideo
      ? `播放视频 ${media.name}`
      : `查看第 ${index + 1} 张照片`,
    onclick: () => openLightbox(entry, index),
  });

  const fill = () => btn.prepend(isVideo ? videoTile(media.ext) : brokenTile());
  if (media.urls.grid) btn.append(lazyImg(media.urls.grid, () => fill()));
  else fill();

  if (isVideo) btn.append(h('span', { class: 'moment__play' }, icon('play')));
  if (overflow) btn.append(h('span', { class: 'moment__more', text: `+${overflow}` }));
  return btn;
}

function buildSingle(entry, media, index) {
  const ratio = media.w && media.h ? media.w / media.h : media.kind === 'video' ? 16 / 9 : 4 / 3;
  const style = { '--ar': ratio.toFixed(4) };

  // 浏览器直接能播的视频就地播放，比塞进灯箱顺手。
  // playable === false 表示静态导出没带原视频，这时只当封面图展示，点了走灯箱文案。
  if (media.kind === 'video' && media.native && media.playable !== false) {
    const video = h('video', {
      controls: true,
      preload: 'metadata',
      playsinline: true,
      src: media.urls.src,
    });
    if (media.urls.poster) video.poster = media.urls.poster;
    return h('div', { class: 'moment__single', style }, video);
  }

  const wrap = h('button', {
    class: 'moment__single',
    type: 'button',
    style,
    'aria-label': media.kind === 'video' ? '播放视频' : '查看大图',
    onclick: () => openLightbox(entry, index),
  });
  const fill = () => wrap.prepend(media.kind === 'video' ? videoTile(media.ext) : brokenTile());
  const src = media.urls.view || media.urls.grid;
  if (src) wrap.append(lazyImg(src, () => fill()));
  else fill();
  if (media.kind === 'video') wrap.append(h('span', { class: 'moment__play' }, icon('play')));
  return wrap;
}

function buildMedia(entry) {
  const list = entry.media;
  const n = list.length;
  if (n === 1) return buildSingle(entry, list[0], 0);

  const cols = n === 2 || n === 4 ? 2 : 3;
  const cap = 9;
  const grid = h('div', { class: 'moment__grid', style: { '--cols': cols } });
  list.slice(0, cap).forEach((m, i) => {
    const isLastVisible = i === cap - 1 && n > cap;
    grid.append(buildCell(entry, m, i, isLastVisible ? n - cap + 1 : 0));
  });
  return grid;
}

function buildMenu(entry) {
  const first = entry.media[0];
  if (!first) return null;
  const pop = h('div', { class: 'menu__pop' });
  pop.append(
    h(
      'a',
      { class: 'menu__item', href: first.urls.src, target: '_blank', rel: 'noopener' },
      icon('arrows-out-simple'),
      '查看原图',
    ),
    h('a', { class: 'menu__item', href: first.urls.src, download: first.name }, icon('download-simple'), '保存'),
    h(
      'button',
      {
        class: 'menu__item',
        type: 'button',
        onclick: async () => {
          // entry.dir 是这条动态所在的目录（子目录形态就是目录本身，散落文件形态是它的父目录）
          const text = `photos/${entry.dir || entry.date}`;
          try {
            await navigator.clipboard.writeText(text);
            toast(`已复制 ${text}`);
          } catch {
            toast('复制失败，浏览器未授权剪贴板');
          }
        },
      },
      icon('folder-simple'),
      '复制文件夹路径',
    ),
  );
  const menu = h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'moment__menu', title: '更多操作' }, icon('more')),
    pop,
  );
  // 点了菜单项就收起（<details> 自己没有这个行为）
  pop.addEventListener('click', () => setTimeout(() => (menu.open = false), 120));
  return menu;
}

function buildMoment(entry) {
  const body = h('div', { class: 'moment__body' });

  if (entry.kid) {
    body.append(
      h(
        'div',
        { class: 'moment__head' },
        h('span', { class: 'moment__name', text: entry.kid.name }),
        entry.age ? h('span', { class: 'moment__age', text: entry.age }) : null,
      ),
    );
  }
  if (entry.title) body.append(h('h3', { class: 'moment__title', text: entry.title }));
  if (entry.caption) body.append(h('p', { class: 'moment__caption', text: entry.caption }));
  body.append(buildMedia(entry));

  if (entry.notes.length) {
    const ul = h('ul', { class: 'moment__notes' });
    for (const note of entry.notes) {
      const idx = note.indexOf('：');
      ul.append(
        h(
          'li',
          {},
          idx > 0 ? h('b', { text: note.slice(0, idx + 1) }) : null,
          idx > 0 ? note.slice(idx + 1).trim() : note,
        ),
      );
    }
    body.append(ul);
  }

  const foot = h('div', { class: 'moment__foot' });
  // 署名：这条是谁发的。只有走「页面发布」且当时有账号时才有值，
  // 手工放进 photos/ 的老照片不会有 —— 所以是有则显示，不是占位。
  if (entry.author) {
    foot.append(
      h(
        'span',
        {
          class: 'moment__author',
          title: entry.authorId ? `发布账号：${entry.authorId}` : null,
        },
        icon('user-circle'),
        h('span', { text: entry.author }),
      ),
    );
  }
  if (entry.time) foot.append(h('span', { class: 'moment__time', text: entry.time }));
  if (entry.location) {
    foot.append(
      h('span', { class: 'moment__place' }, icon('map-pin'), h('span', { text: entry.location })),
    );
  }
  if (entry.counts.video) {
    foot.append(
      h(
        'span',
        { class: 'moment__kinds' },
        icon('film-strip'),
        h('span', { text: `${entry.counts.video} 个视频` }),
      ),
    );
  }
  const menu = buildMenu(entry);
  if (menu) foot.append(menu);
  body.append(foot);

  return h('article', { class: 'moment', dataset: { date: entry.date } }, avatarEl(entry), body);
}

/* ────────────────────────────── 渲染列表 ────────────────────────────── */

const monthLabel = (date) => {
  const [y, m] = date.split('-');
  return `${y}年${Number(m)}月`;
};

const dayLabel = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  const wd = '日一二三四五六'[new Date(y, m - 1, d).getDay()];
  return { date: `${m}月${d}日`, weekday: `周${wd}` };
};

/** 入场动画：只给视口内的做错峰，避免一次性几百个 transition */
const revealObserver =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (records, obs) => {
          let i = 0;
          for (const r of records) {
            if (!r.isIntersecting) continue;
            const el = r.target;
            obs.unobserve(el);
            el.style.transitionDelay = `${Math.min(i, 5) * 45}ms`;
            el.classList.add('is-in');
            i += 1;
          }
        },
        { rootMargin: '0px 0px -6% 0px' },
      )
    : null;

function observeReveal(el) {
  if (revealObserver) revealObserver.observe(el);
  else el.classList.add('is-in');
}

function buildDaySection(date) {
  const { date: d, weekday } = dayLabel(date);
  const head = h(
    'div',
    { class: 'day__head' },
    h('span', { class: 'day__date', text: d }),
    h('span', { class: 'day__weekday', text: weekday }),
    h('span', { class: 'day__count' }),
  );
  // 动态重新挂一个 day__body：分页刚好切在同一天时，要靠它把后半条接回原 section
  const body = h('div', { class: 'day__body' });
  return h('section', { class: 'day', dataset: { date } }, head, body);
}

function appendEntries(entries) {
  const feed = $('#feed');
  const frag = document.createDocumentFragment();
  let dayBody = state.lastDayBody;
  const touched = new Set();
  if (dayBody) touched.add(dayBody.parentElement);

  for (const entry of entries) {
    if (entry.date !== state.lastDay) {
      const mKey = entry.date.slice(0, 7);
      if (mKey !== state.lastMonth) {
        frag.append(h('div', { class: 'month-divider', text: monthLabel(entry.date) }));
        state.lastMonth = mKey;
      }
      const section = buildDaySection(entry.date);
      frag.append(section);
      dayBody = section.lastElementChild;
      touched.add(section);
      state.lastDay = entry.date;
      state.lastDayBody = dayBody;
    }
    const moment = buildMoment(entry);
    dayBody.append(moment);
    observeReveal(moment);
  }
  feed.append(frag);

  // 日期头右侧的条数：只更新这一批碰到的 section，避免每次翻页都全量遍历
  for (const sec of touched) {
    if (!sec) continue;
    const n = sec.querySelectorAll('.moment').length;
    const el = sec.querySelector('.day__count');
    if (el) el.textContent = `${n} 条`;
  }
}

function renderMore() {
  const next = state.entries.slice(state.rendered, state.rendered + state.batch);
  if (next.length === 0) {
    $('#load-more').hidden = true;
    return 0;
  }
  appendEntries(next);
  state.rendered += next.length;
  $('#load-more').hidden = state.rendered >= state.entries.length;
  return next.length;
}

function resetFeed() {
  state.entries = filterEntries();
  state.rendered = 0;
  state.lastDay = null;
  state.lastMonth = null;
  state.lastDayBody = null;
  $('#feed').replaceChildren();
  renderMeta();
  renderNotices();

  if (state.entries.length === 0) {
    $('#load-more').hidden = true;
    renderEmpty();
    return;
  }
  $('#empty')?.remove();
  renderMore();
}

function filterEntries() {
  let list = state.data?.entries || [];
  if (state.kid !== 'all') list = list.filter((e) => e.kid && e.kid.id === state.kid);
  if (state.videoOnly) list = list.filter((e) => e.counts.video > 0);
  return list;
}

/* ────────────────────────────── 空态 / 提示 ────────────────────────────── */

const TREE = `photos/
├── 2026-09-20/            文件夹名就是日期，必须是 yyyy-MM-dd
│   ├── 001-第一次翻身/     一个子文件夹 = 一条动态
│   │   ├── 001.jpg
│   │   ├── 002.mp4
│   │   └── caption.md     可选：这条动态的文案
│   ├── 002-公园散步/
│   └── 随手拍.jpg          直接放文件 = 每条文件各成一条动态
└── 2026-09-18/`;

const STEP_ITEMS = [
  ['1', '在项目里的 photos/ 下新建一个 yyyy-MM-dd 命名的文件夹。'],
  ['2', '把当天的照片和视频放进去。一天想发多条，就建带序号的子文件夹，例如 001-、002-。'],
  ['3', '想要文案就在子文件夹里放 caption.md；想标注是哪个宝宝，写 meta.json 里的 kid 字段。'],
  ['4', '页面监听着照片目录，丢进去就会自动刷新，不用重启。'],
];

function buildSteps() {
  const ol = h('ol', { class: 'empty__steps' });
  for (const [n, text] of STEP_ITEMS) {
    ol.append(h('li', {}, h('span', { text: n }), h('span', { text })));
  }
  return ol;
}

function renderEmpty() {
  $('#empty')?.remove();
  const filtered = (state.data?.entries?.length || 0) > 0;
  const box = h('div', { class: 'empty', id: 'empty' });

  if (filtered) {
    box.append(
      icon('film-strip', 'empty__icon'),
      h('h2', { class: 'empty__title', text: '这个筛选下还没有内容' }),
      h('p', {
        class: 'empty__lead',
        text: state.videoOnly
          ? '当前照片库里没有视频。关掉「视频」筛选可以看全部动态。'
          : '换个宝宝或者回到全部试试。',
      }),
      h(
        'button',
        {
          class: 'btn btn--primary',
          type: 'button',
          onclick: () => {
            state.kid = 'all';
            state.videoOnly = false;
            persistFilter();
            renderFilters();
            resetFeed();
          },
        },
        '看全部动态',
      ),
    );
    $('#feed').append(box);
    return;
  }

  box.append(
    icon('folder-simple', 'empty__icon'),
    h('h2', { class: 'empty__title', text: '还没有照片' }),
    h('p', {
      class: 'empty__lead',
      text: '把照片和视频按日期放进 photos/ 目录，页面会自动整理成朋友圈样式的时间线。不需要手动登记，目录结构本身就是数据源。',
    }),
    h('pre', { class: 'empty__tree', text: TREE }),
    buildSteps(),
  );
  // 有发布能力时给个更省事的入口：连文件夹都不用建
  if (state.upload?.enabled) {
    box.append(
      h(
        'button',
        { class: 'btn btn--primary empty__cta', type: 'button', onclick: openPublish },
        icon('camera'),
        '直接在这里发布第一条',
      ),
    );
  }
  $('#feed').append(box);
}

function renderNotices() {
  $('#notice')?.remove();
  const warnings = state.data?.warnings || [];
  const blocks = [];

  // 未登录 + 服务端只放开了最新几条：明说"你看到的是不全的"。
  // 不说的话，用户会以为"我家就这一条动态"，然后开始怀疑照片丢了。
  // 判据用服务端给的 preview.limited（它知道到底裁没裁），不是前端自己猜。
  if (previewTruncated()) {
    blocks.push(
      h(
        'div',
        { class: 'notice' },
        icon('lock'),
        h(
          'div',
          { class: 'notice__body' },
          h('p', { class: 'notice__title', text: '只显示了最新的一条' }),
          h('p', { text: '登录后可以看到全部动态与照片。' }),
          h(
            'button',
            {
              class: 'btn btn--primary notice__cta',
              type: 'button',
              onclick: () => openLogin('登录后可以看全部'),
            },
            '登录查看全部',
          ),
        ),
      ),
    );
  }

  if (state.data && state.data.ok === false) {
    blocks.push(
      h(
        'div',
        { class: 'notice notice--warn' },
        icon('warning'),
        h(
          'div',
          { class: 'notice__body' },
          h('p', { class: 'notice__title', text: '照片库目录不存在' }),
          h('p', { text: '检查 moments.config.mjs 里的 paths.mediaRoot，或者先把目录建出来。' }),
        ),
      ),
    );
  }

  if (warnings.length) {
    const list = h('ul', { class: 'notice__list' });
    for (const w of warnings.slice(0, 5)) list.append(h('li', { text: w }));
    if (warnings.length > 5) list.append(h('li', { text: `还有 ${warnings.length - 5} 条同类提示` }));
    blocks.push(
      h(
        'div',
        { class: 'notice' },
        icon('warning'),
        h(
          'div',
          { class: 'notice__body' },
          h('p', { class: 'notice__title', text: '扫描时有文件或目录被跳过' }),
          list,
        ),
      ),
    );
  }

  if (!blocks.length) return;
  const wrap = h('div', { id: 'notice' }, blocks);
  $('#feed').before(wrap);
}

function renderSkeleton(n = 4) {
  const feed = $('#feed');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i += 1) {
    const grid = h('div', { class: 'skeleton__grid' });
    for (let j = 0; j < 3; j += 1) grid.append(h('span', { class: 'sk' }));
    frag.append(
      h(
        'div',
        { class: 'skeleton' },
        h('div', { class: 'skeleton__avatar sk' }),
        h(
          'div',
          {},
          h('div', { class: 'skeleton__line sk skeleton__line--w38' }),
          h('div', { class: 'skeleton__line sk skeleton__line--w60' }),
          grid,
        ),
      ),
    );
  }
  feed.replaceChildren(frag);
}

function renderError(err) {
  $('#feed').replaceChildren(
    h(
      'div',
      { class: 'notice notice--warn' },
      icon('warning'),
      h(
        'div',
        { class: 'notice__body' },
        h('p', { class: 'notice__title', text: '没能加载到照片数据' }),
        h('p', { text: err.message }),
        h(
          'p',
          { style: { marginTop: '10px' } },
          h(
            'button',
            {
              class: 'btn btn--ghost',
              type: 'button',
              onclick: () => load(),
            },
            icon('refresh'),
            '重试',
          ),
        ),
      ),
    ),
  );
}

/* ────────────────────────────── 灯箱 ────────────────────────────── */
/* 翻页范围就是「当前这条动态里的媒体」，和朋友圈点开某条动态的行为一致 */

function renderLightbox() {
  const { entry, index } = state.lb;
  const list = entry?.media || [];
  const target = list[index];
  if (!target) return;

  const stage = $('#lb-stage');
  stage.replaceChildren();

  if (target.kind === 'video') {
    // playable === false：静态导出没带上原视频，这里只剩封面图可看
    if (target.native && target.playable !== false) {
      const video = h('video', {
        controls: true,
        autoplay: true,
        playsinline: true,
        src: target.urls.src,
      });
      if (target.urls.poster) video.poster = target.urls.poster;
      stage.append(video);
    } else {
      // 两种走不到 <video> 的原因，文案不能混：浏览器不支持 vs 产物里压根没有源文件
      const missing = target.playable === false;
      const still = target.urls.poster || target.urls.grid;
      stage.append(
        h(
          'div',
          { class: 'lightbox__fallback' },
          h('p', { text: missing ? '这一版静态导出没有带上原视频' : `浏览器无法直接播放 .${target.ext} 格式` }),
          h(
            'p',
            { style: { marginTop: '8px' } },
            missing ? `加 --copy-media 重新导出即可播放 · ${target.name}` : `原文件：${target.name}`,
          ),
          still ? h('img', { class: 'lightbox__still', src: still, alt: '' }) : null,
          target.urls.src
            ? h(
                'p',
                { style: { marginTop: '14px' } },
                h(
                  'a',
                  { class: 'ghostbtn', href: target.urls.src, download: target.name },
                  icon('download-simple'),
                  '保存原文件',
                ),
              )
            : null,
        ),
      );
    }
  } else {
    stage.append(h('img', { src: target.urls.view || target.urls.grid, alt: '' }));
  }

  $('#lb-caption').textContent = entry.title || entry.caption.split('\n')[0] || target.name;
  const d = dayLabel(entry.date);
  const stamp = [d.date, entry.time, `${index + 1} / ${list.length}`].filter(Boolean).join(' · ');
  $('#lb-sub').textContent = stamp;

  const many = list.length > 1;
  $('#lb-prev').hidden = !many;
  $('#lb-next').hidden = !many;

  $('#lb-original').onclick = () => window.open(target.urls.src, '_blank', 'noopener');
  const dl = $('#lb-download');
  dl.href = target.urls.src;
  dl.download = target.name;

  // 预加载前后各一张，翻页不白屏
  if (many) {
    for (const i of [(index + 1) % list.length, (index - 1 + list.length) % list.length]) {
      const m = list[i];
      if (m && m.kind === 'image' && m.urls.view) new Image().src = m.urls.view;
    }
  }
}

function openLightbox(entry, mediaIndex) {
  state.lb.entry = entry;
  state.lb.index = mediaIndex;
  state.lb.opener = document.activeElement;
  renderLightbox();
  const box = $('#lightbox');
  box.hidden = false;
  lockScroll(true);
  $('#lb-close').focus();
}

function closeLightbox() {
  const box = $('#lightbox');
  if (box.hidden) return;
  box.hidden = true;
  $('#lb-stage').replaceChildren();
  state.lb.entry = null;
  lockScroll(false);
  state.lb.opener?.focus?.();
  state.lb.opener = null;
}

function stepLightbox(delta) {
  const len = state.lb.entry?.media.length || 0;
  if (len <= 1) return;
  state.lb.index = (state.lb.index + delta + len) % len;
  renderLightbox();
}

function initLightbox() {
  $('#lb-close').addEventListener('click', closeLightbox);
  $('.lightbox__scrim').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => stepLightbox(-1));
  $('#lb-next').addEventListener('click', () => stepLightbox(1));

  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
    else if (e.key === 'ArrowRight') stepLightbox(1);
  });

  // 手机上左右滑动翻页
  const stage = $('#lb-stage');
  stage.addEventListener(
    'touchstart',
    (e) => {
      state.lb.touchX = e.changedTouches[0].clientX;
    },
    { passive: true },
  );
  stage.addEventListener(
    'touchend',
    (e) => {
      if (state.lb.touchX == null) return;
      const dx = e.changedTouches[0].clientX - state.lb.touchX;
      state.lb.touchX = null;
      if (Math.abs(dx) > 45) stepLightbox(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );

  // 点空白处关闭
  stage.addEventListener('click', (e) => {
    if (e.target === stage) closeLightbox();
  });
}

/* ────────────────────────────── 更多操作菜单 ────────────────────────────── */

/** <details> 原生的展开/收起不带"点外面关闭"，这里补上 */
function initMenus() {
  const closeAll = (except) => {
    for (const d of document.querySelectorAll('details.menu[open]')) {
      if (d !== except) d.open = false;
    }
  };
  document.addEventListener('click', (e) => {
    closeAll(e.target?.closest?.('details.menu') || null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAll(null);
  });
}

/* ─────────────────────────── 登录 / 访问门禁 ─────────────────────────── */
/*
 * 服务端按 auth.scope 决定未登录能读到什么（默认 'latest'：只见最新几条）：
 *   'latest' → feed 里只有最新那几条，媒体地址也只放行那几条；登录后才是全部
 *   'all'    → 一律 401，页面直接铺一屏登录，内容压根不加载
 *   'upload' → 读侧全放开，只有发布要登录
 *
 * 这里只做两件事：把状态显示对、该弹的登录框弹出来。
 * 真正的拦截在服务端 —— 前端"藏起来"没有任何意义，抓个包就绕过去了。
 *
 * 会话是服务端签名的 Cookie（HttpOnly），前端读不到也不需要读 ——
 * 每次开屏问一次 GET /api/session 拿"我是谁"，页面里不烘身份。
 */

const auth = { busy: false, fromGate: false };

/** 登录面板的开场白随访问范围而变：说错了会让人以为"登录就能看全部"，结果本来就是全部 */
const AUTH_LEAD = {
  all: '这个相册需要登录才能查看。',
  latest: '登录后可以看到全部动态，现在只放开了最新的一条。',
  upload: '看照片不用登录，只有往照片库里发布时才需要。',
};

async function fetchSession() {
  try {
    const res = await fetch('/api/session', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // 没有后端（静态导出）或服务没起来：当匿名处理
    return null;
  }
}

/**
 * 当前读侧范围。优先信服务端（/api/session），其次信注入的配置。
 * 两边都拿不到时按最松的 'upload' 处理：**前端不是防线**，
 * 真被限制的话 /api/feed 会回 401，那条路会把人送进门禁（见 load 的 401 分支）。
 * 反过来若在这里保守地猜"要登录"，静态导出（没有后端）就会莫名其妙弹一个永远登不上的框。
 */
function readScope() {
  return state.session?.readScope || state.readScope || 'upload';
}

const isAnon = () => !state.session?.user;
/** 整站锁：未登录时连内容都不该加载（连"有几条动态"都不给看） */
const gateActive = () => isAnon() && readScope() === 'all';
/** 服务端这次是否真的裁掉了东西（由 feed 载荷里的 preview.limited 说了算） */
const previewTruncated = () => isAnon() && state.data?.preview?.limited === true;

/**
 * 未登录时"发布"要不要先登录。
 * 拿不到 /api/session 时**回落到配置里的 authRequired**，而不是默认"不用登录"：
 * 会话接口刚好抽风时，宁可多弹一次登录框，也不能把发布按钮亮出来让用户白填一遍表单。
 * （后端对"配了认证但没配账号"也是同样态度 —— 直接 503，不静默放行。）
 */
function needsLoginForWrite() {
  if (!state.upload?.enabled) return false;
  const required = state.session ? !!state.session.authRequired : !!state.upload?.authRequired;
  return required && isAnon();
}

/** 未登录时"看"要不要先登录 */
const needsLoginForRead = () => isAnon() && readScope() !== 'upload';

/**
 * 顶栏「登录 / 发布」互斥：没登录只看到登录（读或写任一被拦就要能登），登录后只看到发布。
 * 门禁铺开时两个都收起来 —— 登录框已经占着整屏了，再给个「登录」按钮只是重复。
 */
function renderAuthUI() {
  const btnAuth = $('#open-auth');
  const btnPub = $('#open-publish');
  const locked = gateActive();
  btnAuth.hidden = locked || !(needsLoginForRead() || needsLoginForWrite());
  btnPub.hidden = locked || !state.upload?.enabled || needsLoginForWrite();
}

function setAuthNote(text, kind = '') {
  const el = $('#auth-note');
  el.textContent = text || '';
  el.className = kind ? `sheet__note is-${kind}` : 'sheet__note';
}

function setAuthBusy(on) {
  auth.busy = on;
  const submit = $('#auth-submit');
  submit.disabled = on;
  submit.textContent = on ? '登录中…' : '登录';
  $('#auth-close').disabled = on;
  $('#auth-cancel').disabled = on;
  $('#auth-user').disabled = on;
  $('#auth-pass').disabled = on;
}

function toggleReveal() {
  const btn = $('#auth-reveal');
  const input = $('#auth-pass');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? '隐藏口令' : '显示口令');
  btn.replaceChildren(icon(show ? 'eye-slash' : 'eye'));
  input.focus();
}

/**
 * 打开登录面板。
 *
 * forced=true 是"整站锁"形态：面板已经开着就不再重置输入框（用户可能正打到一半），
 * 并收起「取消 / 关闭」—— 关掉之后页面是空的，只会让人一脸茫然。
 * 此时遮罩与 Esc 也会被 closeLogin 挡掉，所以用户只有一个出口：登录成功。
 */
function openLogin(reason = '', { forced = false } = {}) {
  const box = $('#login');
  const alreadyOpen = !box.hidden;
  auth.fromGate = forced;
  box.classList.toggle('is-forced', forced);
  $('#auth-close').hidden = forced;
  $('#auth-cancel').hidden = forced;
  $('#auth-lead').textContent = AUTH_LEAD[readScope()] || AUTH_LEAD.upload;
  if (alreadyOpen) {
    if (reason) setAuthNote(reason);
    return;
  }
  setAuthBusy(false);
  $('#auth-pass').value = '';
  $('#auth-pass').type = 'password';
  $('#auth-reveal').setAttribute('aria-pressed', 'false');
  $('#auth-reveal').setAttribute('aria-label', '显示口令');
  $('#auth-reveal').replaceChildren(icon('eye'));
  setAuthNote(reason);
  box.hidden = false;
  lockScroll(true);
  // 账号名留着（多半是同一个人），光标直接落在下一个空字段上
  if ($('#auth-user').value) $('#auth-pass').focus();
  else $('#auth-user').focus();
}

function closeLogin() {
  const box = $('#login');
  if (box.hidden || auth.busy) return;
  // 门禁形态没有"取消"：关掉之后页面是空的，用户只会一脸茫然
  if (auth.fromGate) return;
  box.hidden = true;
  lockScroll(false);
  $('#open-auth')?.focus();
}

async function submitLogin() {
  if (auth.busy) return;
  const user = $('#auth-user').value.trim();
  const password = $('#auth-pass').value;
  if (!user || !password) {
    setAuthNote('账号和口令都要填', 'error');
    return;
  }

  setAuthBusy(true);
  setAuthNote('正在登录…');

  let body = null;
  let status = 0;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BM-Auth': '1' },
      body: JSON.stringify({ user, password }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (err) {
    setAuthBusy(false);
    setAuthNote(`连不上服务：${err.message}`, 'error');
    return;
  }

  if (status < 200 || status >= 300) {
    setAuthBusy(false);
    const msg = body?.error || `登录失败（HTTP ${status}）`;
    // 429 把还要等多久说清楚，否则用户只会一直重试、越试锁得越久
    if (status === 429 && body?.retryAfter) {
      setAuthNote(`${msg}（还要等 ${Math.ceil(body.retryAfter / 60)} 分钟）`, 'error');
    } else {
      setAuthNote(msg, 'error');
    }
    $('#auth-pass').select?.();
    return;
  }

  // 登录成功：服务端已经种下 Cookie，本地只需记住"我是谁"。
  // readScope 靠展开保留 —— 登录接口不回这个字段。
  state.session = { ...(state.session || {}), configured: true, authRequired: true, user: body.user };
  const wasGate = auth.fromGate;
  auth.fromGate = false;
  setAuthBusy(false);
  closeLogin();
  renderAuthUI();
  toast(`已登录 · ${body.user?.name || body.user?.id || ''}`);

  // 三条来源，处理方式不同：
  //   ① 整站锁弹的框 → 用户是冲着"看"来的，把内容拉出来就行，别把发布面板怼到脸上
  //   ② 上传途中会话过期被弹回来 → 把刚才那批文件原样接上，别让用户重选
  //   ③ 用户主动点「登录」→ 顺手把发布面板打开，省一次点击
  if (wasGate) {
    await reloadForAccess();
    return;
  }
  if (pub.afterLogin) {
    pub.afterLogin = false;
    openPublish({ fresh: false });
  } else {
    openPublish();
  }
}

async function doLogout() {
  // 服务端是无状态会话，这一步只是让浏览器把 Cookie 清掉；
  // 即便请求失败也要把界面上的身份清掉，否则"看着已登录、实际传不上去"更糟。
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'X-BM-Auth': '1' } });
  } catch {
    /* 忽略 */
  }
  state.session = { ...(state.session || {}), user: null };
  closePublish();
  renderAuthUI();
  toast('已退出登录');
  // 可见范围是服务端说了算：退出去之后可能只剩最新一条（甚至一条都没有），
  // 必须重新拉一次 —— 不能把上一个身份看到的照片继续留在屏幕上。
  await reloadForAccess();
}

/* ── 访问范围变化后的重新对齐 ── */

let live = null;

function stopLive() {
  live?.close();
  live = null;
}

/**
 * 整站锁：未登录时连内容都不该出现。
 *
 * 只把登录框盖上去是不够的 —— 那样 DOM 里还留着上一个人的照片，
 * 截图、右键、"查看网页源代码"都能捞出来。所以这里真的把内容清掉，
 * 再用 body.is-gated 把整块照片区域收起来（登录成功后 applyData 会摘掉这个类）。
 */
function renderGate(reason = '') {
  stopLive();
  closeLightbox();
  state.data = null;
  state.entries = [];
  state.rendered = 0;
  state.pending = null;
  $('#feed')?.replaceChildren();
  $('#notice')?.remove();
  $('#meta-line')?.replaceChildren();
  document.body.classList.add('is-gated');
  openLogin(reason || AUTH_LEAD.all, { forced: true });
}

let resyncing = false;

/**
 * 身份变了（登录 / 退出 / 会话过期 / 服务端把范围改严了）之后重新对齐一次。
 * 可见范围由服务端决定，前端只能重新问、重新拉。
 *
 * 返回 true 表示"已经处理过了，调用方不用再做别的"。
 *
 * resyncing 是防重入闸门：load() 自己也会在 401 时回到这里，
 * 没有它就会绕成"拉 → 401 → 重问 → 再拉"的死循环。
 * 重入被挡掉时返回 false，让调用方**继续往下走**（去 renderError 报错），
 * 否则页面会永远停在骨架屏上 —— 既不重拉也不报错，看起来像卡死了。
 */
async function reloadForAccess(reason = '') {
  if (resyncing) return false;
  resyncing = true;
  try {
    const s = await fetchSession();
    if (s) state.session = s;
    renderAuthUI();
    if (gateActive()) {
      renderGate(reason);
      return true;
    }
    document.body.classList.remove('is-gated');
    // 只重试这一次：再被拒就直接显示错误，别绕成死循环
    await load({ retryOnDenied: false });
    initLive();
    return true;
  } finally {
    resyncing = false;
  }
}

function initAuth() {
  $('#open-auth').addEventListener('click', () => openLogin());
  $('#auth-close').addEventListener('click', closeLogin);
  $('#auth-cancel').addEventListener('click', closeLogin);
  $('#auth-submit').addEventListener('click', submitLogin);
  $('#auth-reveal').addEventListener('click', toggleReveal);
  $('#login .sheet__scrim').addEventListener('click', closeLogin);
  // 在输入框里按回车 = 点登录。表单没有 submit 按钮时，浏览器的隐式提交会派发 submit 事件
  $('#auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitLogin();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#login').hidden) return;
    if (e.key === 'Escape') closeLogin();
  });

  // 会话状态要等接口回来才知道，先按配置把按钮摆好（错的那一侧也只是短暂出现）。
  //
  // 注意这里不再看 upload.enabled 提前 return：读侧也可能被拦
  // （scope='all' 时即便关掉了上传，整站仍然要登录），跳过就等于把门开着。
  renderAuthUI();
  return fetchSession().then((s) => {
    if (s) state.session = s;
    renderAuthUI();
  });
}

/* ────────────────────────────── 发布 ────────────────────────────── */
/*
 * 「自动分组」就落在这里：用户只管挑文件、写一句话，
 * 目录（photos/<日期>/<序号>-<标题>/）、编号、caption.md、meta.json 都由服务端补齐。
 * 前端只做三件事：挑文件时的就地校验、上传进度、以及完事之后把页面刷新到最新。
 */

/** 浏览器能直接渲染的格式，用来决定预览格子是 <img>/<video> 还是瓦片 */
const PREVIEW_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);
const PREVIEW_VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);

const pub = { items: [], kid: '', busy: false, seq: 0, afterLogin: false };

const extOfName = (name) => {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

const kindOfExt = (ext, cfg) =>
  (cfg.acceptImages || []).includes(ext)
    ? 'image'
    : (cfg.acceptVideos || []).includes(ext)
      ? 'video'
      : null;

const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 打开浮层时锁滚动，并补上滚动条宽度，避免背景横向抖一下 */
function lockScroll(on) {
  const gap = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = on ? 'hidden' : '';
  document.body.style.paddingRight = on && gap > 0 ? `${gap}px` : '';
}

function setNote(text, kind = '') {
  const el = $('#pub-note');
  el.textContent = text || '';
  el.className = kind ? `sheet__note is-${kind}` : 'sheet__note';
}

const updateHint = () => {
  if (pub.busy) return;
  setNote(`会按日期存进 photos/${$('#pub-date').value}/ 下，同一天发多条会自动编号`);
};

function growCaption() {
  const ta = $('#pub-caption');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`;
}

function renderKids() {
  const box = $('#pub-kids');
  box.replaceChildren();
  const mk = (id, label) =>
    h(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-pressed': pub.kid === id ? 'true' : 'false',
        onclick: () => {
          pub.kid = id;
          renderKids();
        },
      },
      label,
    );
  box.append(mk('', '不指定'));
  for (const k of state.kids || []) box.append(mk(k.id, k.name));
}

function renderPicked() {
  const grid = $('#pub-grid');
  grid.replaceChildren();
  $('#pub-picked').hidden = pub.items.length === 0;

  for (const it of pub.items) {
    const cell = h('li', { class: 'picked__cell' });
    if (it.kind === 'image' && PREVIEW_IMAGE_EXT.has(it.ext)) {
      cell.append(h('img', { src: it.url, alt: '', loading: 'lazy', decoding: 'async' }));
    } else if (it.kind === 'video' && PREVIEW_VIDEO_EXT.has(it.ext)) {
      // #t=0.1 让浏览器把首帧当封面画出来，否则默认是一块黑
      cell.append(
        h('video', { src: `${it.url}#t=0.1`, preload: 'metadata', muted: true, playsinline: true }),
      );
    } else {
      cell.append(h('span', { class: 'vtile' }, h('span', { class: 'vtile__ext', text: it.ext })));
    }
    if (it.kind === 'video') cell.append(h('span', { class: 'picked__badge' }, icon('film-strip')));
    cell.append(
      h(
        'button',
        {
          class: 'picked__x',
          type: 'button',
          'aria-label': `移除 ${it.file.name}`,
          onclick: () => removeItem(it.id),
        },
        icon('x'),
      ),
    );
    grid.append(cell);
  }

  $('#pub-count').textContent = pub.items.length
    ? `已选 ${pub.items.length} 个 · ${humanSize(pub.items.reduce((s, i) => s + i.file.size, 0))}`
    : '';
  $('#pub-submit').disabled = pub.items.length === 0;
}

function releasePreviews() {
  for (const it of pub.items) URL.revokeObjectURL(it.url);
  pub.items = [];
}

function removeItem(id) {
  const i = pub.items.findIndex((it) => it.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(pub.items[i].url);
  pub.items.splice(i, 1);
  renderPicked();
  updateHint();
}

function addFiles(fileList) {
  const cfg = state.upload;
  if (!cfg || pub.busy) return;
  const maxFiles = cfg.maxFiles || 30;
  const maxBytes = (cfg.maxFileMB || 500) * 1024 * 1024;
  const errors = [];
  let added = 0;

  for (const file of fileList) {
    if (pub.items.length >= maxFiles) {
      errors.push(`一次最多 ${maxFiles} 个文件`);
      break;
    }
    const ext = extOfName(file.name);
    const kind = kindOfExt(ext, cfg);
    if (!kind) {
      errors.push(`${file.name}：格式不支持`);
      continue;
    }
    if (!file.size) {
      errors.push(`${file.name}：空文件`);
      continue;
    }
    if (file.size > maxBytes) {
      errors.push(`${file.name}：超过 ${cfg.maxFileMB}MB`);
      continue;
    }
    // 同名同大小视为重复，删了再加的场景很常见，不该叠出一堆副本
    if (pub.items.some((it) => it.file.name === file.name && it.file.size === file.size)) continue;
    pub.items.push({
      id: `p${(pub.seq += 1)}`,
      file,
      ext,
      kind,
      url: URL.createObjectURL(file),
    });
    added += 1;
  }

  renderPicked();
  if (errors.length) setNote(errors.slice(0, 3).join('；'), 'error');
  else updateHint();
  return added;
}

function setBusy(on) {
  pub.busy = on;
  $('#pub-submit').disabled = on || pub.items.length === 0;
  $('#pub-submit').textContent = on ? '发布中…' : '发布';
  $('#pub-close').disabled = on;
  $('#pub-cancel').disabled = on;
  $('#pub-drop').disabled = on;
  $('#pub-clear').disabled = on;
}

function setBar(ratio) {
  const bar = $('#pub-bar');
  bar.hidden = ratio == null;
  if (ratio != null) $('#pub-bar-fill').style.width = `${Math.round(ratio * 100)}%`;
}

function openPublish({ fresh = true } = {}) {
  const box = $('#publish');
  if (!box.hidden || !state.upload?.enabled) return;
  // 没登录就先登录，登录成功后 submitLogin 会替我们把这一步接着做完。
  // 注意用的是"写"那一侧判断：读侧被拦（scope='all'）时门禁面板已经占着屏幕了，
  // 发布面板根本打不开，不该在这里再叠加一层。
  if (needsLoginForWrite()) {
    openLogin('先登录，再发布');
    return;
  }
  if (fresh) {
    releasePreviews();
    pub.kid = '';
    $('#pub-caption').value = '';
    $('#pub-title').value = '';
    $('#pub-location').value = '';
    const now = new Date();
    $('#pub-date').value = isoDate(now);
    $('#pub-time').value = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    setBar(null);
  }
  renderKids();
  renderPicked();
  renderWho();
  setBusy(false);
  updateHint();
  box.hidden = false;
  lockScroll(true);
  growCaption();
  if (fresh) $('#pub-caption').focus();
}

/** 面板底部那行「以 X 的身份发布 · 退出」—— 让署名这件事在发布前就看得见 */
function renderWho() {
  const el = $('#pub-who');
  el.replaceChildren();
  const s = state.session;
  if (!s?.authRequired || !s?.user) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.append(
    icon('user-circle'),
    h('span', { class: 'sheet__who-name', text: `以 ${s.user.name || s.user.id} 的身份发布` }),
    h('button', { class: 'linkbtn', type: 'button', onclick: doLogout }, '退出'),
  );
}

/**
 * 关闭发布面板。
 * keepFiles = true 时不释放已选文件（对象 URL 留着），用于
 * "会话过期 → 去登录 → 回来接着用这批文件"这条路径。
 */
function closePublish({ keepFiles = false } = {}) {
  const box = $('#publish');
  if (box.hidden || pub.busy) return;
  box.hidden = true;
  if (!keepFiles) releasePreviews();
  lockScroll(false);
  if (!keepFiles) $('#open-publish')?.focus();
}

/** fetch 拿不到上传进度，所以这一段用 XHR */
function uploadXHR(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-BM-Upload', '1');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* 服务器可能返回了非 JSON（比如被中间层拦了） */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok) resolve(body);
      else {
        // 把状态码带上：401（会话过期）要走"回登录"那条路，不能和普通失败混在一起
        const err = new Error(body?.error || `上传失败（HTTP ${xhr.status}）`);
        err.status = xhr.status;
        err.code = body?.code || '';
        reject(err);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('网络中断，这次没发出去')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(formData);
  });
}

async function submitPublish() {
  if (pub.busy || pub.items.length === 0) return;

  const fd = new FormData();
  fd.append('date', $('#pub-date').value || isoDate(new Date()));
  const time = $('#pub-time').value;
  if (time) fd.append('time', time);
  const caption = $('#pub-caption').value.trim();
  if (caption) fd.append('caption', caption);
  if (pub.kid) fd.append('kid', pub.kid);
  const title = $('#pub-title').value.trim();
  if (title) fd.append('title', title);
  const location = $('#pub-location').value.trim();
  if (location) fd.append('location', location);
  for (const it of pub.items) fd.append('files', it.file, it.file.name);

  setBusy(true);
  setBar(0);
  setNote(`正在上传 ${pub.items.length} 个文件…`);

  try {
    const res = await uploadXHR(fd, (p) => {
      setBar(p);
      setNote(`正在上传… ${Math.round(p * 100)}%`);
    });
    setBar(null);
    pub.busy = false;
    closePublish();
    // 先反馈再刷新：重扫大照片库要时间，别让面板关掉之后页面毫无动静
    toast(`已发布到 ${res.date}${res.kid ? ` · ${res.kid.name}` : ''}`);
    // 落盘后服务端会连发两次 change（一次它自己广播、一次 fs.watch 的 debounce），
    // 短时间内静音，免得页面刚滚到顶又被第二次刷新拽回去
    state.muteLiveUntil = Date.now() + 2000;
    applyData(await fetchFeed(true));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    setBar(null);
    setBusy(false);

    // 会话过期（或只读 Cookie 被清）—— 服务端说 401，那就回登录，
    // 并且把刚选好的那批文件原样留着，登完接着发，不用重选。
    if (err.status === 401) {
      state.session = { ...(state.session || {}), user: null, authRequired: true };
      pub.afterLogin = true;
      closePublish({ keepFiles: true });
      renderAuthUI();
      openLogin('登录状态已过期，重新登录后这批文件还在，直接点发布即可');
      return;
    }
    // 503 且说的是"没配账号"，重试一万次也没用，直接把修法摆出来
    if (err.status === 503 && err.code === 'AUTH_NOT_CONFIGURED') {
      setNote(`${err.message}（改完 moments.config.mjs 要重启服务）`, 'error');
      return;
    }
    setNote(err.message, 'error');
  }
}

function initPublish() {
  const cfg = state.upload;
  const btn = $('#open-publish');
  if (!cfg?.enabled) {
    btn.hidden = true;
    return;
  }
  // 显不显示交给 renderAuthUI —— 它还要看当前有没有登录，这里只管绑行为
  $('#pub-file').accept = [...(cfg.acceptImages || []), ...(cfg.acceptVideos || [])]
    .map((e) => `.${e}`)
    .join(',');

  btn.addEventListener('click', () => openPublish());
  $('#pub-close').addEventListener('click', () => closePublish());
  $('#pub-cancel').addEventListener('click', () => closePublish());
  $('#pub-submit').addEventListener('click', submitPublish);
  $('#pub-clear').addEventListener('click', () => {
    releasePreviews();
    renderPicked();
    updateHint();
  });
  // 页面里现在有两个 .sheet（发布 + 登录），必须显式限定，否则拿到的永远是文档里第一个
  $('#publish .sheet__scrim').addEventListener('click', () => closePublish());

  $('#pub-drop').addEventListener('click', () => $('#pub-file').click());
  const fileInput = $('#pub-file');
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) addFiles(fileInput.files);
    fileInput.value = ''; // 允许再次选同一个文件
  });

  $('#pub-caption').addEventListener('input', growCaption);
  $('#pub-date').addEventListener('change', updateHint);
  $('#pub-time').addEventListener('input', updateHint);

  // 拖拽：拖到浮层任意位置都算，不用精确命中小方框
  const box = $('#publish');
  const drop = $('#pub-drop');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  box.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || pub.busy) return;
    e.preventDefault();
    drop.classList.add('is-over');
  });
  box.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  box.addEventListener('dragleave', (e) => {
    // 在面板内部元素之间移动也会触发 dragleave，靠 relatedTarget 排除
    if (e.relatedTarget && box.contains(e.relatedTarget)) return;
    drop.classList.remove('is-over');
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    if (box.hidden) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') closePublish();
  });
}

/* ────────────────────────────── 滚动行为 ────────────────────────────── */

function initScroll() {
  const topbar = $('#topbar');
  const toTop = $('#to-top');
  const cover = $('#top');

  const io = new IntersectionObserver(
    ([r]) => {
      topbar.classList.toggle('is-pinned', !r.isIntersecting);
      toTop.hidden = r.isIntersecting && window.scrollY < 400;
    },
    { rootMargin: '-60px 0px 0px 0px', threshold: 0 },
  );
  if (cover) io.observe(cover);

  toTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function initInfiniteScroll() {
  const sentinel = $('#sentinel');
  const more = $('#load-more');
  more.addEventListener('click', () => renderMore());

  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (records) => {
      if (records.some((r) => r.isIntersecting)) renderMore();
    },
    { rootMargin: '900px 0px' },
  );
  io.observe(sentinel);
}

/* ────────────────────────────── 目录监听 ────────────────────────────── */

function initLive() {
  // 门禁还开着就别连：注定 401，而且 EventSource 会一直重连，日志里刷一片。
  // 注意 'latest' 档也算 —— 服务端对未登录的 SSE 一律拒绝（免得从推送时间推断作息），
  // 所以判断条件是"未登录 + 读侧被限制"，不是仅仅 gateActive()。
  if (live || !('EventSource' in window)) return;
  if (isAnon() && readScope() !== 'upload') return;
  let timer = null;
  const es = new EventSource('/api/events');
  live = es;
  es.addEventListener('change', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      // 刚发布完的那两秒不响应：上传接口自己会广播一次，fs.watch 的 debounce 还会再来一次，
      // 两次都刷新会让页面刚滚到顶又被拽一遍
      if (Date.now() < state.muteLiveUntil) return;
      try {
        const data = await fetchFeed(true);
        const before = state.data?.stats?.entries ?? 0;
        const after = data.stats?.entries ?? 0;
        if (after === before && data.generatedAt === state.data?.generatedAt) return;
        if (window.scrollY < 160) {
          applyData(data);
          return;
        }
        state.pending = data;
        const diff = after - before;
        toast(diff > 0 ? `多了 ${diff} 条新动态` : '照片库有变化', {
          label: '刷新',
          run: () => {
            applyData(state.pending);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          },
        });
      } catch (err) {
        // 401 别静默吞掉：页面会一直停在旧数据上，
        // 用户只知道"新发的动态没出现"，完全看不出是身份掉了。
        if (err.status === 401 || err.status === 403) await reloadForAccess();
        /* 其余情况多半是目录正在被写入，下次事件再试 */
      }
    }, 500);
  });
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

function applyData(data) {
  // 数据都拿到了，说明门禁已经放开 —— 把被收起的内容区域放回来
  document.body.classList.remove('is-gated');
  state.data = data;
  state.pending = null;
  state.site = data.site || {};
  state.kids = data.kids || [];
  state.batch = data.feedConfig?.pageSize || 24;
  renderCover();
  renderFilters();
  resetFeed();
}

function initConfigBootstrap() {
  const el = $('#site-config');
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

/**
 * @param retryOnDenied 收到 401/403 时要不要先重新对齐身份再重试一次。
 *   reloadForAccess() 内部调用时传 false（它自己就是那次重试），
 *   否则会变成"重试里再重试"的递归。
 */
async function load({ retryOnDenied = true } = {}) {
  renderSkeleton();
  let data;
  try {
    data = await fetchFeed();
  } catch (err) {
    // 401/403：服务端已经不认这个身份了（会话过期 / 在别处退出了 / 范围被改严了）。
    // 重新问一次"我是谁"，再按新的范围决定是铺门禁还是重拉 —— 别当"网络错误"处理。
    if (retryOnDenied && (err.status === 401 || err.status === 403)) {
      if (await reloadForAccess('登录状态已过期，重新登录后就能看到全部内容')) return;
    }
    renderError(err);
    return;
  }
  applyData(data);
}

async function init() {
  hasJs();
  initTheme();
  initLightbox();
  initScroll();
  initInfiniteScroll();
  initMenus();

  // 兜底：万一渲染过程中抛错，别让已经渲染出来的动态永远停在 opacity:0
  window.addEventListener('error', () => {
    for (const el of document.querySelectorAll('.moment:not(.is-in)')) el.classList.add('is-in');
  });

  const boot = initConfigBootstrap();
  if (boot) {
    state.site = boot;
    state.kids = boot.kids || [];
    state.batch = boot.feed?.pageSize || 24;
    // upload 只在 site-config 里，applyData 赋值 data.site 时不会带上它，得单独存
    state.upload = boot.upload || null;
    state.readScope = boot.readScope || 'upload';
    // 筛选状态要在首次渲染前恢复，否则会白渲染一遍再重排
    restoreFilter(state.kids);
    renderCover();
    renderFilters();
  }
  // 先问会话再绑发布：顶栏那个按钮显示「登录」还是「发布」取决于当前身份，
  // 顺序反了会先亮出发布按钮、再被换成登录按钮，看着像闪了一下
  await initAuth();
  initPublish();

  $('#video-only').addEventListener('click', () => {
    state.videoOnly = !state.videoOnly;
    persistFilter();
    renderFilters();
    resetFeed();
  });

  // 整站锁：连 feed 都不必去拉（注定 401），直接铺门禁。
  // 也就顺带不建立 SSE、不请求任何缩略图 —— 未登录访客的网络面板应该是干净的。
  if (gateActive()) {
    renderGate();
    return;
  }

  await load();

  if (!boot) {
    restoreFilter(state.kids);
    renderFilters();
    resetFeed();
  }

  initLive();
}

init();
