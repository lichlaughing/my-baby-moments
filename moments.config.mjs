/**
 * 站点配置。改这里就够了，不用动源码。
 *
 * 所有相对路径都相对于本文件所在目录（项目根目录）。
 */
export default {
    site: {
        /** 页面标题，也用作顶部导航的站点名 */
        title: '宝宝成长记',
        /** 顶部封面区域的一句话签名 */
        signature: '一天一天，慢慢长大',
        /**
         * 封面大图。留 null 会自动使用最新一条动态里的第一张照片。
         * 也可以写静态资源路径，例如 '/assets/cover.jpg'（放在 public/assets 下）。
         */
        cover: null,
        /**
         * 头像：留 null 时用宝宝名字首字生成字母头像。
         * 可填 '/media/xxx.jpg' 或任意 URL。
         */
        avatar: null,
        /** 页脚署名 */
        footer: '用照片记录时间'
    },

    paths: {
        /**
         * 照片库根目录（相对项目根）。按 yyyy-MM-dd 分文件夹丢进来就行。
         * 想指向别处（比如移动硬盘、Photos 导出目录）就改成绝对路径。
         */
        mediaRoot: 'photos'
    },

    /**
     * 宝宝信息。birthday 用于自动计算每条动态时的年龄（"3岁4个月"）。
     * aliases 用于从目录名/文件名里自动识别这条动态属于谁，例如 "001-大宝-第一次翻身"。
     */
    kids: [
        {
            id: 'k1',
            name: '笑笑',
            aliases: ['大宝', '姐姐', 'k1'],
            birthday: '2023-08-01',
            avatar: null
        },
        {
            id: 'k2',
            name: '喜乐',
            aliases: ['二宝', '弟弟', 'k2'],
            birthday: '2025-11-28',
            avatar: null
        }
    ],

    feed: {
        /** 首页每批加载多少条，滚动到底部再加载下一批 */
        pageSize: 24,
        /** 默认筛选：'all' 或某个宝宝 id */
        defaultKid: 'all',
        /**
         * 无 meta.json 时是否从目录名/文件名猜宝宝归属。
         * 关掉后就只有显式写了 meta.json 的动态才带宝宝标签。
         */
        detectKidFromName: true
    },

    media: {
        images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif'],
        videos: ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'mkv'],
        /** 扫描时忽略的目录名（不区分大小写） */
        ignoreDirs: ['@eaDir', '#recycle', 'node_modules', '.git', '.cache', 'thumbs'],
        /** 忽略的文件名前缀 */
        ignorePrefix: ['.', '_']
    },

    thumbs: {
        /** 九宫格小图：正方形裁切，边长（px） */
        gridSize: 480,
        /** 大图预览：长边限制（px），灯箱和单图排版用它，比原图小很多 */
        viewSize: 1600,
        /** webp 质量 */
        quality: 78,
        /** 缩略图生成并发数，机器吃不消就调小 */
        concurrency: 4,
        /** 缓存目录（相对项目根）。可安全删除，删了会重新生成。 */
        cacheDir: '.cache'
    },

    /**
     * 账号认证 —— 默认「未登录只能看最新一条」，登录后才看得到全部。
     *
     * 一条命令生成口令哈希，并打印可直接粘贴的配置：
     *     npm run passwd
     *
     * 说明几点取舍：
     *   · 账号写在这里，没有注册流程，也没有用户表 —— 家里几个人，几行配置就够。
     *   · 口令只存 scrypt 哈希。直接写明文 password 也能跑（方便先试），
     *     但服务每次启动都会警告，建议换掉。
     *   · 会话是签过名的 Cookie，服务端不存 session，所以重启不掉线。
     *     签名密钥第一次启动自动生成到 .cache/session.key，不要提交到仓库。
     *   · enabled: true 但 users 是空的时候，**整站都进不去**（不只是上传被挡）。
     *     这是故意的：静默放行等于"以为上了锁，其实门开着"。
     *     确实想要谁都能看（比如只在自己电脑上跑），把 enabled 设成 false。
     */
    auth: {
        enabled: true,

        /**
         * 拦到哪一步 —— 未登录时能读到什么。三档：
         *
         *   'latest'  默认。未登录只能看**最新的一条动态**（条数见 previewCount），
         *             登录后才是全部。想给家人留一个"先看一眼"的入口，
         *             又不把整个相册摊开，用这个。
         *   'all'     最严。未登录什么都看不到：内容不加载，缩略图和原图也拿不到，
         *             连"一共有几条动态"都不暴露 —— 直接铺一屏登录。
         *   'upload'  看照片完全不需要登录，只有发布要认证。
         *
         * ⚠️ 这一项是**在服务端裁剪**的：未登录时 /api/feed 里根本就没有那些条目，
         *    对应媒体的地址直接回 401。不是前端藏起来 —— 藏起来抓个包就能绕过。
         *
         * ⚠️ 静态导出（npm run build）没有后端，三档都不生效，产物是全员可看的。
         *    构建时会打印提醒，别指望用它来保护照片。
         */
        scope: 'latest',

        /**
         * scope 为 'latest' 时，未登录能看见几条动态。
         * 0 相当于 'all'（只是前端仍会正常渲染骨架而已）。
         */
        previewCount: 1,

        /**
         * 登录后多久需要重新登录（天）。会话会在剩下不到一半时自动续期，
         * 所以正常使用不会突然掉线。
         */
        sessionDays: 30,

        /** 同一个 IP + 账号连续失败多少次就临时锁定 */
        maxAttempts: 8,
        /** 计数的滑动窗口，也是锁定持续时长（分钟） */
        windowMinutes: 10,

        /** 签名密钥。留空则自动生成到 .cache/session.key 并在重启后复用 */
        secret: null,
        /**
         * Cookie 是否带 Secure。
         * 留空 = 自动：走 https（或反代透传 x-forwarded-proto: https）时带上。
         * 本机 http://127.0.0.1 下别强制打开，否则浏览器不保存 Cookie，登录会永远失败。
         */
        secure: null,

        users: [
            // 加一个用户：
            //   1) npm run passwd        （输入昵称和口令，它会打印下面这段）
            //   2) 粘贴进来，重启服务
            // {
            //     id: 'mama',
            //     name: '妈妈',
            //     passwordHash: 'scrypt$1$16384$8$1$...',
            //     aliases: ['宝妈']
            {
                id: 'lichenghao',
                name: '爸爸',
                passwordHash:
                    'scrypt$1$16384$8$1$ATvXocJyCdAEwrymaUXa9g$2YXFz9TyNxA1JWT5950jFIcp8eZZnkOYbJYrFgaWMis'
            }
        ]
    },

    /**
     * 发布（页面右上角的按钮）。
     *
     * 打开后可以直接把照片拖进页面：选好文件点发布，服务端会自动建出
     * photos/<日期>/<前缀>-<标题>/ 目录并写进文案与宝宝归属，
     * 不需要自己去建文件夹 —— 目录结构由它替你维护。
     *
     * 只在 `npm start` 的本地服务下有效；静态导出（npm run build）里没有后端，
     * 按钮会自动隐藏。想彻底关掉就设成 false。
     */
    upload: {
        enabled: true,
        /** 一次最多几个文件 */
        maxFiles: 30,
        /** 单个文件大小上限（MB） */
        maxFileMB: 500,

        /**
         * 同一日期下的目录名前缀怎么起。两种写法扫描器都认，可以随时改，历史目录不受影响：
         *
         *   'order'  001 / 001-第一次翻身           默认。短、好读，按发布先后编号。
         *   'time'   143027-k3f9 / 143027-k3f9-公园 时间可排序 + 随机去重。
         *
         * 差别不只在长相：
         *   order 要"读出已用序号再 +1"，这是个读-改-写，必须靠互斥锁串起来才不会撞号。
         *   time 直接生成不重复的名字，撞名就重摇一次，因此**连锁都不依赖** ——
         *        照片库放在 NAS / 网盘挂载点上、文件系统锁不可靠时，这个更稳。
         * 两者都保证同一日期内按时间排好序（顺序以 meta.json 的 time 为准，
         * 没写 time 时再按目录名自然排序）。
         */
        naming: 'order',

        /**
         * 跨进程上传锁。锁是一把目录锁（靠 mkdir 的原子性），
         * 保护"读已用序号 → 起名 → 入库"这一段，让多个服务进程同时写同一天也不会撞。
         * 正常情况下用不到这两个值，只有进程被强杀留下陈旧锁时才相关。
         */
        /** 锁被持有超过这么久视为陈旧，可被抢占（毫秒） */
        lockStaleMs: 30000,
        /** 等锁的总时长上限（毫秒），等不到就回 503 让用户重试 */
        lockWaitMs: 20000
    },

    server: {
        port: 4310,
        host: '127.0.0.1',
        /** 监听照片目录变化，自动刷新页面 */
        watch: true
    }
};
