/**
 * 把扫描结果补齐成前端直接可用的结构：填好所有媒体 URL。
 * 服务端实时渲染和静态导出共用这一份逻辑，避免两边 URL 规则跑偏。
 */
import { encodeRelPath, ageAt } from './util.mjs';

/**
 * 注入到 index.html 的站点配置（serve 与 build 共用一份，避免两边结构跑偏）。
 *
 * upload 段是前端决定「要不要显示发布按钮」的唯一依据：
 * 静态导出没有后端接口，必须传 uploadEnabled=false，否则按钮点下去必然报错。
 *
 * authRequired 只说明「上传需要登录」这件事本身，不代表当前用户已登录 ——
 * 当前身份是每人一份的，得由 /api/session 现场问，不能烘进页面里
 * （否则多人共用浏览器或页面被缓存时会串号）。
 *
 * readScope 是同一件事在读侧的说法（'latest' / 'all' / 'upload'）。它烘进页面是安全的：
 * 它不是"谁"的信息，而是"这个服务怎么配置的"。前端拿它只为了少发一个注定 401 的请求；
 * 真裁剪在服务端 —— 未登录时 /api/feed 里根本没有那些条目。
 *
 * redactKids：未登录时把宝宝的**生日与别名**摘掉。页面骨架必须公开
 * （不然登录界面自己都加载不出来，assets 里的 css/js 也拿不到），
 * 但没有任何理由把孩子的确切生日送到一个匿名访客的浏览器里。
 * 名字留着 —— 预览那几条动态本来就会显示它，藏了反而前后不一致。
 */
export function siteConfig(
  config,
  { uploadEnabled = true, authRequired = false, readScope = 'upload', redactKids = false } = {},
) {
  const up = config.upload || {};
  const enabled = uploadEnabled && up.enabled !== false;
  return {
    ...config.site,
    kids: redactKids
      ? (config.kids || []).map((k) => ({ id: k.id, name: k.name, avatar: null }))
      : config.kids,
    feed: config.feed,
    readScope,
    upload: {
      enabled,
      authRequired: enabled && authRequired,
      maxFiles: Math.max(1, Number(up.maxFiles) || 30),
      maxFileMB: Number(up.maxFileMB) || 500,
      // 前端选文件时先按扩展名筛一遍，不合规的当场提示，不用等传到一半才失败
      acceptImages: config.media.images,
      acceptVideos: config.media.videos,
    },
  };
}

/** 注入时统一把 < 转掉，避免文案里的尖括号提前闭合 <script> */
export const toScriptJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

/**
 * @param config   站点配置
 * @param manifest 扫描结果
 * @param base     部署前缀（静态导出到子路径时用，例如 '/baby'），默认空
 * @param opts.mediaAvailable 原始媒体是否可达。
 *   serve 模式恒为 true；静态导出未加 --copy-media 时为 false —— 这时
 *   `/media/*` 在产物里根本不存在，所有指向它的 URL 都会 404。必须显式
 *   告诉本函数，否则视频 poster / 动图原图会变成黑框和破图。
 */
export function decorateManifest(config, manifest, base = '', { mediaAvailable = true } = {}) {
  const b = base.replace(/\/+$/, '');
  const mediaUrl = (rel, rev) => `${b}/media/${encodeRelPath(rel)}?v=${encodeURIComponent(rev)}`;
  const thumbUrl = (m, variant) => `${b}/thumb/${m.key}/${variant}/${m.rev}.webp`;

  const entries = (manifest.entries || []).map((e) => {
    const all = e.media.map((m) => {
      const src = mediaUrl(m.rel, m.rev);
      const isPoster = m.role === 'poster';
      if (m.kind === 'video') {
        return {
          ...m,
          // playable=false 时前端不会去播（源文件不在产物里），只当封面图展示
          playable: mediaAvailable,
          urls: {
            src: mediaAvailable ? src : null,
            // 视频封面：优先用同名图片，其次靠 QuickLook 尽力抽帧（失败前端会退化成设计过的瓦片）
            grid: null,
            // 视频不生成大图，灯箱直接播视频本身
            view: null,
            // 真正的封面 URL 在下面的回填循环里填（那时才拿得到封面图对象）
            poster: null,
          },
        };
      }
      const animated = m.ext === 'gif';
      return {
        ...m,
        playable: true,
        urls: {
          src,
          grid: thumbUrl(m, 'grid'),
          // 灯箱里：动图优先放原图（webp 缩略图是静止的）；原始媒体不在产物里时退回缩略图，至少不 404
          view: isPoster ? null : animated && mediaAvailable ? src : thumbUrl(m, 'view'),
          poster: null,
        },
      };
    });

    // 视频封面回填：posterRel 指向同目录里的同名图片
    //
    // 注意 key/rev 必须取自**封面图**（poster）而不是视频本身：
    // 视频只有 grid 一个变体，拿它去拼 thumbUrl(..., 'view') 会得到一个
    // 永远不存在的地址（缩略图任务里根本没生成过它）→ 视频 poster 静默 404。
    const byRel = new Map(all.map((m) => [m.rel, m]));
    for (const m of all) {
      if (m.kind !== 'video') continue;
      const poster = m.posterRel ? byRel.get(m.posterRel) : null;
      m.urls.grid = poster ? poster.urls.grid : thumbUrl(m, 'grid');
      // 用 view 变体而不是原图：1600px 长边的 webp 比原图轻，两种模式行为也一致
      if (poster) m.urls.poster = thumbUrl(poster, 'view');
      else if (m.posterRel && mediaAvailable) m.urls.poster = mediaUrl(m.posterRel, m.rev);
    }

    const shown = all.filter((m) => m.role !== 'poster');
    const cover = shown.find((m) => m.key === e.cover) || shown[0] || null;
    return { ...e, media: shown, allMedia: all, coverUrl: cover ? cover.urls : null };
  });

  const site = { ...config.site };
  const firstImage = entries.flatMap((e) => e.media).find((m) => m.kind === 'image');
  if (!site.cover && firstImage) {
    site.cover = firstImage.urls.view || firstImage.urls.grid;
    site.coverRel = firstImage.rel;
  }
  if (!site.avatar && firstImage) site.avatar = firstImage.urls.grid;

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;

  return {
    ...manifest,
    entries,
    site,
    // 封面要显示"现在多大"，所以在这里算一次当时的年龄
    kids: (config.kids || []).map((k) => ({ ...k, age: ageAt(k.birthday, today) })),
    feedConfig: config.feed,
  };
}
