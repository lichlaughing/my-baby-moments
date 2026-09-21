# my-baby-moments · 项目长期笔记

朋友圈式的宝宝成长时间线。按 `photos/yyyy-MM-dd/` 组织媒体，自动整理并展示。两个宝宝（id `k1` 笑笑 2023-08-01 / `k2` 喜乐 2025-11-28；`aliases` 里保留了 `大宝`/`二宝`，演示数据的目录名用的就是别名）。

## 技术选型（不要随意更换）

- **零构建前端**：裸 DOM + `textContent` 防注入 + 内联 `<svg><use>` 图标雪碧图。**不用 React**，不加打包器。
- **只有两个运行时依赖**：`sharp`（普通图 / 缩略图）+ `heic-convert`（HEIC 真实解码）。
  HEIC 必须走 `heic-convert`，`sharp` 预编译包解不了 HEVC 像素。
- **唯一需要用户编辑的文件是 `moments.config.mjs`**，其余全部配置驱动，不要把规则硬编码进源码。
- 文件处理统一「一次 read、一次 write」，批量改动写单进程 Node 脚本，不要用 shell heredoc 落盘。
- **`POST /api/upload` 是唯一的写路径**，两段式：整条动态先在 `<cacheDir>/uploads/<token>/entry/`
  **组装成完整目录**（媒体改名 + `caption.md` + `meta.json`），再用**一次 `rename`** 入库。
  读者永远看不到半成品目录。改这里务必跑 `npm run verify:upload` 与 `npm run verify:concurrency`。
- **账号认证只拦"写"不拦"读"**：`src/auth.mjs`（scrypt 口令 + HMAC 签名 Cookie + 登录限流）。
  看照片始终匿名可读；只有上传要登录。改这里跑 `npm run verify:auth` 与 `npm run verify:ui`。

## 目录 / URL 约定

- 日期目录 `yyyy-MM-dd`（可带后缀），子文件夹 = 一条动态，散落文件每文件一条。
- **目录名前缀的单一真源是 `src/util.mjs` 的 `splitSortPrefix()`**，两种形态都认：
  ① `order`：`001` / `001-标题`；② `time`：`143027-k3f9` / `143027-k3f9-标题`
  （定长 6 位 `HHmmss` + `-` + 4 位随机，随机字母表去掉 i/l/o/u）。
  定长数字串的字典序 = 时间序 ⇒ 扫描器不需要额外解析。
  ⚠️ 正则的后向断言必须是 `(?=[-_.、\s]|$)`。放松成 `(?=\D|$)` 会把
  `2宝-出游` 剥成 `id=2/title=宝-出游`、`143027-k3f9m` 剥成 `id=143027-k3f9/title=m`。
  **宁可认不出来当完整标题，也不要猜错**。
- `meta.time` 优先级高于目录名；`meta.kid` > 目录名里的宝宝别名。
- 与视频同名的图片自动当封面：`role: 'poster'`，仍生成缩略图但被 `shown` 过滤掉，不进九宫格。
- **`meta.author` / `meta.authorId` 是署名**，由上传按登录身份写入，前端显示在卡片底部。
  `author` 给人看（改昵称后旧记录保持当时的样子），`authorId` 给程序用。
  手工放进来的照片没有这两个字段 ⇒ 是"有则显示"，不是占位。
- **`entry.dir` 是前端拼「复制文件夹路径」用的**：子目录形态取值就是 `entryKey`，
  单文件形态才 `slice(0, slash)`。改这里之前先看 `scan.mjs` 的注释。
- 缩略图磁盘布局 `<cacheDir>/<key>/<variant>/<rev>.webp`，`rev = mtimeMs-size` ⇒ 可 `immutable` 缓存。
  变体只有两个：`grid`（480 正方裁切，`sharp.strategy.attention`）、`view`（长边 1600，`fit: inside`）。
  **视频只生成 `grid`，没有 `view`** —— 任何拼 `thumbUrl(video, 'view')` 的代码都是 bug。

## 配色体系：微信朋友圈（2026-09-21 改版）

底色与文字取 Tencent 官方 **WeUI token**（微信小程序与微信本体同源），强调色取微信绿，
可点文字取朋友圈昵称蓝。全部落在 `public/assets/style.css` 的两个 `[data-theme]` 块里。

| token | 亮 / 暗 | 语义 | 能否承载文字 |
| --- | --- | --- | --- |
| `--canvas` / `--canvas-2` | `#ededed` `#e3e3e3` / `#111111` `#1c1c1c` | 页底 / 图片占位底·封面底·进度槽 | 🔴 `--canvas-2` 不承载任何文字 |
| `--surface` / `--surface-2` | `#ffffff` `#f7f7f7` / `#191919` `#1e1e1e` | 白卡 / 次级底 | — |
| `--ink` `--ink-2` `--ink-3` | `#191919` `#5c5c5c` `#6b6b6b` / `#ededed` `#a0a0a0` `#8f8f8f` | 正文 / 次要 / 元信息 | 是 |
| `--accent` | `#07c160` / `#07c160` | 微信绿原色：纯装饰 + 实底 + `::selection` | 🔴 **否**（白底 2.38:1） |
| `--accent-strong` | `#047c3d` / `#07c160` | 承载文字 / 描边 / 焦点环 / 进度条 | 是（≥4.53:1） |
| `--accent-soft` | `#e8f7ee` / `#12281c` | 绿的浅底（选中态、字母头像底） | — |
| `--accent-ink` | `#04240f` / `#0b1f13` | 压在 `--accent` 实底上的字 | 是（6.96 / 7.22） |
| `--link` | `#576b95` / `#7d90a9` | 朋友圈昵称蓝：署名、文案人名、空状态路径 | 是（5.33 / 5.39） |
| `--danger` | `#c62828` / `#ff8080` | 发布面板校验提示 | 是 |

- 🔴 **微信自己的配色大多不达标 WCAG AA**（`#07c160` 白底 2.38、`#10aeff` 2.46、
  `rgba(0,0,0,.3)` 2.10、`#fa5151` 3.30、白字压绿底 2.38）。**标志性的绿按钮保住了原色，
  动的是字色**（白 → `#04240f`，6.96:1）。三级文字 / 链接蓝 / 错误红则都换了可达标的值。
- **「灰底 + 白卡」里的白卡是补出来的**：原来 `.moment` 直接平铺在页底色上（无 `background`），
  底色一改灰会更闷。卡片**不加阴影**（灰底与白底已分得开，加阴影就不像微信）。
  同时补了 `.moment + .moment` 与 `.day + .day` 的间距 —— 原先靠 `.moment` 的 padding 撑开，卡片化后会塌。
- `<meta name="theme-color">` **不读 CSS 变量**，是纯硬编码出口（现为 `#ededed` / `#111111`）。

## 硬性约束

1. 图标必须有 `fill: currentColor`（`svg` 基础规则 + `<symbol fill="currentColor">`）。Phosphor 的 path 不带 fill，漏了就全黑。
2. `decorateManifest(config, manifest, base, { mediaAvailable })`：静态导出不加 `--copy-media` 时必须传 `false`，
   否则视频 poster / 动图原图指向不存在的 `/media/*`。
3. `scripts/fetch-icons.mjs` 必须保持幂等：两个 `<!--ICON_SPRITE_*-->` 标记都要写回替换串。
4. `scripts/seed-demo.mjs --force` 只准删 `demoPaths()` 里的条目，禁止 `rm -rf photos/`。
5. 路径一律经 `path.resolve` 前缀校验；`decodeRelPath` 拒 `..` 与绝对路径。
6. `siteConfig()` / `toScriptJson()` 在 `manifest.mjs`，serve 与 build **共用**；build 注入 `upload.enabled: false`。
   前端 `initPublish` 里 `if (!cfg.enabled) { btn.hidden = true; return; }` —— 提前 return ⇒ 不挂任何监听，
   所以导出物里即便手动摘掉 `hidden` 也打不开面板。这条链任一环断了都**不报错**，只让按钮悄悄冒出来 ⇒
   改动后必须跑 `npm run verify:static`。
7. 上传接口的 CSRF 是双保险：自定义头 `X-BM-Upload: 1` + `Origin`/`Host` 同源校验；
   `OPTIONS` 预检**只回显同源 Origin**，不要退回 `Allow-Origin: *`。
8. 日期校验不能只依赖 `new Date(y,m-1,d)` —— 它会把 `2026-13-45` 静默进位成 `2027-02-14`，
   必须回读 `getFullYear/getMonth/getDate` 与原始三段比对。
9. `cmdClean` 要顺手清 `.cache/uploads`（上传中断会留半截临时文件），不带 `--all` 也清。
10. **并发正确性靠两把锁**：跨进程用 `mkdir` 的原子性做目录锁（`<cacheDir>/locks/date-<date>.lock`），
    进程内再叠一层按日期分桶的 Promise 链。两条**抢占条件缺一不可**：mtime 超 `lockStaleMs`，
    或锁里记的 pid 已不存在（`process.kill(pid, 0)` 抛 `ESRCH`）。
    **等不到锁回 503 让用户重试，绝不无锁放行。**
11. 🔴 **判定 `mkdir` 是否"已存在"必须同时看 `code` 与 `message` 前缀**（`isExists`）：
    本机沙箱会把 `code` 改写成 `CODEBUDDY_BROKER_DENY`，只在 `message` 里留 `EEXIST:`。
    只看 `code` ⇒ 误判成"锁不可用" ⇒ 静默降级成进程内锁 ⇒ **跨进程互斥直接失效**（= 分组乱掉）。
    同样地，`lockRoot` 的 `mkdir` 不许 `.catch(() => {})` 吞掉。
12. 🔴 **鉴权红线**：① 口令哈希与比较必须用**异步** scrypt（同步版会阻塞事件循环，
    一波失败登录即可卡死服务）；② 比较要**定长**（先 sha256 对齐长度再 `timingSafeEqual`），
    否则比较耗时会泄漏"口令长度猜对了"；③ 账号不存在也要跑一次假哈希；
    ④ Cookie **默认不带 `Secure`**（本机 http 下带上则浏览器不保存，登录永远失败）；
    ⑤ 续期要在 `writeHead` **之前**下发；⑥ **`auth.enabled: true` 但 `users` 为空 ⇒ 回 503，
    不静默放行**（静默放行 = "以为上了锁，其实门开着"）。
13. 🔴 **新增用 `hidden` 控制显隐的元素时，必须显式补 `[hidden] { display: none }`**：
    UA 样式表的 `[hidden]` 会被任何自定义 `display` 覆盖（如 `.iconbtn { display: inline-flex }`）。
    漏了按钮/区块会一直显示出来，而逻辑看起来毫无问题。
14. 🔴 **页面里出现第二个同 class 组件后，`$('.foo')` 形式的全局选择器就错了** ——
    `querySelector` 永远只返回文档里第一个。新增同类组件时要过一遍所有 `$('.…')`。
    （已有实例：`.sheet__scrim` 必须写成 `$('#publish .sheet__scrim')`。）
15. 🔴 **装饰色与「承载文字」的色必须拆成两个 token**（`--accent` / `--accent-strong`）：
    `--accent` 是微信绿原色，**白底只有 2.38:1，不能当文字用**，也不能作需要 3:1 的 UI 边界。
    凡「文字、描边、焦点环、进度条填充」一律走 `--accent-strong`
    （能过 AA 的**最亮**微信绿 = `#047c3d`；再亮一档 `#058743` 灰底就掉到 3.94:1）。
    新增绿色用法时先问一句：它是「看得见的图形」还是「要读的字」。
16. 🔴 **测试里禁止硬编码「用户可编辑的配置值」**。`verify-upload.mjs` 曾断言
    `kid.name === '大宝'`，而 `moments.config.mjs` 是用户可编辑的 —— 用户把宝宝改成真名那天，
    这条会以「上传链路回归」这个**完全误导**的名义红掉（实测踩过一次，卡了 20 分钟排查方向）。
    ⇒ 期望值一律 `await import` 真实配置后取（`REAL_CONFIG.kids.find(k => k.id === 'k1').name`），
    并让断言标签带上实际值（`宝宝归属正确（k1 = 笑笑）`），失败时一眼看得懂。
17. 🔴 **读侧鉴权（`auth.scope`）六条不变量**——`resolveReadScope()` 在 `src/auth.mjs` 单独导出，
    serve 与 build 共问同一句。`'latest'`（默认，`readLimit = previewCount` 默认 1）/
    `'all'`（`readLimit = 0`）/ `'upload'`（`Infinity`，回到旧行为）。拼错 ⇒ 回 `'latest'` + warn，
    **绝不回退"全开"**。
    ① **裁剪在服务端**：被裁条目**不在 `/api/feed` 里**，其媒体在 `/thumb`、`/media` 回 401，
    `stats` 一并 `restats()` 重算（否则"共 132 条"本身就是泄露）；
    ② 🔴 `readLimit` 是"给**未登录**的人看多少"⇒ feed 里必须
    `g.anon ? anonEntries(full.entries) : full.entries`（漏了三元 ⇒ **登录后也只剩 1 条**）；
    ③ 骨架 `/` 与 `/assets/*` **永远公开**（否则登录界面自己加载不出来），但未登录要
    `redactKids` 摘掉 `kids[].birthday` / `aliases`；
    ④ `/api/events`（SSE）**比读接口再严一档**：读侧受限时未登录一律拒连（防侧信道推断作息），
    单独 `checkEvents()`，不复用 `checkRead()`；
    ⑤ 未登录可见的缩略图缓存头必须 `private`，不能 `public`；
    ⑥ 前端 `fetchFeed`：`FEED_DENIED = 401|403|503` ⇒ **绝不**回落 `feed.json`（= 绕过鉴权），
    而 **404 必须回落**（静态导出没后端）。
18. 🔴 **base64 末位字符有填充位**：32 字节 HMAC → 43 个 base64url 字符，末位字符只有前 2 位有效，
    `A`(000000) 与 `B`(000001) 解出的字节**完全相同**。⇒ 测试里"改签名"**不能改末位**
    （`verify-auth.mjs` 的 `flip` 改首字符），否则约 3% 概率假红，而产品侧比的是解出的字节、容忍它是对的。

## 本机环境注意

- `HTTP_PROXY=http://127.0.0.1:64403` 会劫持 127.0.0.1 ⇒ `curl --noproxy '*'`、Chrome `--no-proxy-server`、
  启服务时 `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`。
- 无头 Chrome 必须 `--no-sandbox --disable-gpu --disable-dev-shm-usage --no-proxy-server`，
  且 Node 跑在 `dangerouslyDisableSandbox` 下；CDP 要用 `/json/list` 的 page target ws，
  端口用 `--remote-debugging-port=0` 再从 `<udd>/DevToolsActivePort` 读回。
  **症状与根因**：WS 握手成功但第一句 `Page.enable` 永久静默超时 —— 根因不是"Node 被沙箱限制"，
  而是 **Chrome 自身的 sandbox 初始化失败**（`sandbox initialization failed: Operation not permitted`），
  连带 GPU 进程 `exit_code=6`、整个浏览器退出 ⇒ WS 被关闭。只把 Node 提权**不够**。
  排查手法：`chrome.on('exit')` + 抓 stderr 尾部，一眼能看到 `GPU process isn't usable. Goodbye.`。
  且**同一实例探针失败后重试必然连带失败** ⇒ 每次尝试起**全新** Chrome（新 `user-data-dir`）。
- `qlmanage` 在本机沙箱内起不来，`ffmpeg` 未安装 ⇒ 视频抽帧不可用；给视频配同名封面图即可绕过。
- BSD `grep "A\|B"` 静默返回空；`zsh` 不做变量分词。核验命令本身也要按 POSIX 写。
- **CDP `Page.captureScreenshot` 的 `clip` 恒为文档坐标**，与 `captureBeyondViewport` 无关：
  后者为 `false` 只是「不渲染视口外内容」，裁到当前滚动位置**之上**会得到一张**纯色空图**（文件照写、退出码照 0）。
  且 sticky 元素在整页渲染里的位置与 `getBoundingClientRect` 读数不一致。
  ✅ 要截某个元素：**整视口原样截屏 + 用 sharp 按视口坐标裁**；并**必须加像素断言**（主色命中数 / 色相桶数）证明不是空图。
  （实测补充：给 `clip` 加 `captureBeyondViewport: true` 也能取到视口下方的内容；
  两者都不加时，元素在视口外会截到**大片空白**，看起来像"元素没渲染"。）
- **不要用肉眼判断缩略图里的配色**：暗色登录面板在缩略图里看着"底色偏亮、与输入框不一致"，
  实测 `getComputedStyle` + **PNG 像素取样**后确认完全正确（`rgb(33,35,39)` = 暗色 `--surface-2`）。
  涉及配色的结论一律用实测值，观感只作参考。
- 视觉断言不要硬编码主题色：暗色的 `--accent` 与亮色不同，主色应从 DOM `getComputedStyle` 读回。

## 验证基线（改动后请复跑）

- `npm run verify` → `verify:upload` **70** / `verify:auth` **118** / `verify:concurrency` **40** /
  `build` / `verify:static` **10**，全部 **0 失败**（合计 **238 / 0**）。
- `npm run verify:ui` → **86 通过 / 0 失败**（真实 Chrome，需非沙箱；**故意不进默认 `verify` 链**）。
  失败时保留截图到 `.cache/verify-ui/shots/` 而不清理 —— 出问题时截图是最有用的线索。
  ⚠️ 跑 `verify:ui` 要 `dangerouslyDisableSandbox` + `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`。
- 并发两条硬读数：分组原子性 **3038 次轮询 0 次半成品**（改造前 1654 轮询 / 503 次半成品）；
  跨进程序号 **1..9 连续唯一**（改造前得到 `1,2,2,3,3,4,5,5,6`）。
- 各 `verify-*.mjs` 都用自包含的临时工作区（`.cache/verify*/`），开头有安全闸门
  （`WORK` 必须在 `.cache/` 内、且与真实 `mediaRoot` 互不包含），跑完自删，全程不碰真实 `photos/`。
  ⚠️ **闸门不能写成恒真条件**：`TMP_MEDIA` 是从 `WORK` 派生的（`WORK/photos`），
  写「`TMP_MEDIA` 是否包含于 `WORK`」结构上永远为真 —— 是死代码，只给虚假安全感。
- ⚠️ `verify-upload.mjs` 的临时配置**必须显式 `auth: { ...base.auth, enabled: false }`**：
  它继承真实配置，若不关掉、而使用者恰好没配 `auth.users`，服务会对上传回 503，
  这条用例测的就不再是"上传链路"而是"认证配置"了（这曾是完整验证链抓到的真实回归）。
- `npm run scan` → 5 天 / 8 条 / 37 照片 / 1 视频。
- 视觉审计（`headless-visual-audit`）：亮 1280 与暗 1280 **各 101 个文本节点、各只有 1 项「不达标」**，
  且是同一个**既有假阳性** —— `.topbar__brand` 未吸顶时就是 `opacity: 0`，
  前景与背景因此都合成成 `--canvas`、比值恒为 1（不可见内容不适用对比度要求）。
  横向溢出 0px、破图 0。
- **审计盲区要主动补**：`#publish` / `#login` 默认 `hidden`，审计只对当下已渲染的节点成立。
  用 `--css '#login{display:flex!important}#login .sheet__scrim{display:none!important}'`
  强制可见后：发布面板亮暗各 **21** 个文本节点、登录面板各 **17** 个，**四组全部 0 项不达标**。
- **token 级交叉验算**（从真实 CSS 解析 token、按元素真实组合算，不手抄色值）**50 项 0 失败**。
  它抓到过两处 CDP 审计**看不到**的缺陷：字母头像（深绿压 `--canvas-2` 只有 4.14:1）
  与进度条填充（`#07c160` 压轨道只有 1.86:1 —— 而进度条**没有任何数字标签**，
  填充长度是唯一信息载体，必须 ≥3:1）。
- 顶栏：可见按钮等高 34px、等距 6px；「发布」对比度亮 6.02:1 / 暗 7.72:1；
  右侧内边距桌面 20px / 小屏 16px（小屏 `.topbar__inner,.page,.footer` 走 16px 断点，不是 bug）。
  小屏「登录 / 发布」互斥，可见按钮数 ≤ 3。
