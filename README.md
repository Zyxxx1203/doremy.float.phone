# Float Phone · AI 虚拟互动手机

一个基于 Next.js 的 AI 虚拟手机：在浏览器（或 Android 壳）里模拟一部完整的手机，与你创建的 AI 角色聊天、共同生活、一起看视频、拼贴照片墙。所有 LLM 调用都使用**你自己的 API Key**，本项目不内置任何模型服务，也不上传你的数据。

> 本仓库是个人自部署 fork，在官方上游基础上新增了 **生活、照片墙、一起看、档案室** 四个核心 App 与整套 Android 原生壳。改动台账见 [docs/fork-changes-overview.md](./docs/fork-changes-overview.md)。

## 📚 文档导航

| 文档 | 内容 | 适合谁 |
|---|---|---|
| 本页 README | 项目简介、快速开始、功能总览、来源与致谢 | 所有人 |
| [DEVICE_SETUP_GUIDE.md](./DEVICE_SETUP_GUIDE.md) | Fork 仓库 → 构建 APK → 安装 → 机型适配 → 验收清单 | 想在 Android 上完整体验的用户 |
| [android-shell/README.md](./android-shell/README.md) | Android 壳构建配置、签名、站点地址 | 构建 APK 的用户 |
| [docs/fork-changes-overview.md](./docs/fork-changes-overview.md) | 相对官方上游的改动总台账（逐文件实证） | 维护者 / 二次开发者 |
| [docs/本次功能同步说明.md](./docs/本次功能同步说明.md) | 最近一次功能同步进 main 的改动索引 | 回顾与测试 |
| [docs/开发进度与验证清单.md](./docs/开发进度与验证清单.md) | 2026-10-24 更新摘要、已实现能力与仍需模拟/真机验证项 | 维护者 / 测试者 |
| [docs/从诊断开始的开发差异台账.md](./docs/从诊断开始的开发差异台账.md) | 从运行诊断开始的开发时间线、与分享仓库的当前净差异及同步注意事项 | 准备同步仓库的维护者 |
| [docs/verify-setup.md](./docs/verify-setup.md) 等其余 docs | 各云端功能的部署说明 | 需要对应功能的用户 |

> **差异审计（2026-10-24）**：开发仓库与分享仓库当前文件树有 83 个开发仓库独有路径、115 个同路径内容不同、0 个分享仓库独有路径；这不是功能数量。完整时间线、14 份有差异 Markdown 清单与同步注意事项见 [差异台账](./docs/从诊断开始的开发差异台账.md)。
>
> **最近更新（2026-10-24）**：`main` 已包含一起看内置视频解析与播放缓存、B 站短链换算、生活系统时钟/提示修复、照片墙缩略图与导出/手势修复、桌面小组件按实例存储，以及内置通话统计。功能代码已提交不等于所有平台均已实测；验收边界见 [开发进度与验证清单](./docs/开发进度与验证清单.md)。

## 功能总览

**核心系统**

- 仿真聊天：私聊 / 群聊 / 朋友圈 / 语音消息 / 转账红包卡片，角色有作息、记忆与长期关系
- 创作系统：角色卡、世界书、预设、正则；桌面 AI 助手「工坊」可以帮你写内容、装应用、连 GitHub 改代码
- 剧情玩法：剧情模式、视觉小说、查手机、访谈、地图冒险、日记、便签墙
- 扩展生态：应用市场（SDK 自定义 App）、游戏大厅、黑市剧场、多人联机房间
- 多媒体：AI 生图、Minimax 语音克隆、网易云在线音乐、3D 世界搭建（Tripo）
- 个人云：一键把备份、微信助手、离线回复、定时消息部署到你自己的 Supabase
- 现实桥：角色可调用你 iPhone 的快捷指令，支持 通知点击 / 屏幕速聊 / 邮件自动 三种回传方式
- 桌面美化：主题、壁纸、贴纸小组件、自定义 CSS，支持 PWA 安装到手机桌面

**四个重点 App**

| App | 一句话 | 详见 |
|---|---|---|
| 🌆 生活 | 角色有自己的日程、地点与自主行动，你可随时进入现场陪 TA | [生活](#-生活-app) |
| 🖼 照片墙 | 你与角色的共同回忆拼贴墙：拍照、收藏、AI 生成、涂鸦、导出 | [照片墙](#-照片墙-app) |
| 📺 一起看 | 和角色一起看 B站/小红书/本地视频，边看边聊，角色能看懂画面 | [一起看](#-一起看-app) |
| 🗄 档案室 | 角色与世界的资料档案管理 | 应用内查看 |

## 快速开始

要求 Node.js 20+。

```bash
git clone -b main <repo-url>
cd <repo-dir>
npm install
cp .env.example .env.local   # 默认已开启 NEXT_PUBLIC_SELF_HOSTED_MODE=true
npm run dev
```

浏览器打开 `http://localhost:3001`（默认端口 3001，`PORT` 可改）。单机模式跳过账号系统，直接进入后：

1. **设置 → API 设置**：添加你的 LLM API（OpenAI 兼容 / Anthropic / Google Gemini）；
2. 创建或导入角色卡，开始聊天；
3. 可选：继续配置生图、语音、音乐等增强功能。

## 🌆 生活 App

角色不再只是等你发消息——TA 有自己的虚拟时钟、每周日程、常去地点和自主行动。

- **生活现场**：9 个默认地点（家 / 咖啡店 / 公园 / 图书馆…），可自定义地点库（布局、道具、角色习惯、专属背景）；进入现场后与角色沉浸式对话，支持行动 / 对白分离输入、场景生图
- **角色日程**：按角色卡与世界书自动生成七日周计划，也可手动或用一句中文（"周五下午三点去咖啡店"）快速添加；AI 可整周重排
- **邀约活动**：你发出的邀约由角色按人设决定是否接受；角色也会主动邀请你；双方同意后同步日程，不会瞬间跳到约定时间
- **共同经历**：按实际发生时间整理生活记录（地点变化 / 对话 / 日程 / 工具调用…），可筛选、分组、生成场景图
- **自主行动**：角色可在现场主动搭话（有冷却与每日上限），也可通过邀约 / 陪伴 / 调整日程三个工具改变自己的行程
- **与聊天联动**：聊天时角色的实时生活状态会注入上下文；角色睡觉时消息会延迟回复

数据全部保存在本机（IndexedDB KV），可随数据管理一起备份。生命周期回归测试：`npm run test:life`。

## 🖼 照片墙 App

一整面可以自由布置的拍立得墙：

- **添加照片**：本地上传（自动压缩 / EXIF 拍摄时间）、从聊天收藏、请角色生成（每日显影可自动生成，支持设定角色与提示词模板）
- **自由布置**：拖拽 / 缩放 / 旋转 / 层级 / 锁定，5 种相框；双指缩放与平移全程锚点跟随（手机 / 平板）
- **摆放模板**：心形、星河、随手散落等 8 种内置构图，可保存自定义布局
- **涂鸦**：画笔 / 贴纸 / 橡皮，可写在照片正面、背面或整面墙上；角色也可以帮你涂鸦装饰（LLM 输出经白名单校验）
- **翻面与批注**：点击照片翻到背面写手记，角色也能留下批注
- **导出**：整面墙一键导出 PNG；相册视图、时间轴视图、共创记录一应俱全

## 📺 一起看 App

和角色坐在同一块屏幕前看视频，角色能看懂剧情：

- **视频源**（按优先级自动回退）：
  - B站 BV/av 直链 → 官方站内播放器；`b23.tv` 短链会自动在服务端换算成真实视频
  - 腾讯视频 / 优酷 / YouTube → 对应官方嵌入播放器
  - 直链视频文件（`.mp4` / `.webm` / `.m3u8`，HLS 由 hls.js 支持）与本地视频文件
  - 小红书 / 抖音 / 快手 → 通过**本地解析服务**提取直连流后下载到本地缓存播放（见下）
- **AI 陪看**：绑定角色后，角色按随机间隔主动聊剧情（每日上限护栏，挂机不烧 API）；可截取当前画面 / 上传截图 / 导入字幕脚本，配合「视频理解」模型（Gemini / 方舟 / TwelveLabs / OpenAI 兼容 / Claude）让角色真正看懂视频
- **标记重点**：看片途中一键标记当前时间点，角色立刻就该时间点给出反馈；历史评论的时间点可点击回跳
- **观看记录**：每次一起看自动建档计时，积累共同记忆
- **全局陪看**（Android APK）：离开 App 后继续截屏陪看

### 本地解析服务（可选，用于小红书 / 抖音 / 快手等平台）

站内无法直接嵌入的短视频平台，由一个跑在你自己设备上的小服务完成「解析 → 下载 → 本地缓存播放」：

```bash
cd tools/video-resolver
pip install -r requirements.txt
python app.py                # 默认 http://127.0.0.1:8765
```

- Android 上可用 Termux 一键部署：App 内「一起看 → 设置 → 本地视频下载引擎 → 复制 Termux 一键部署命令」
- **平台支持现状**（实测）：
  - 小红书（含 `xhslink.cn` 短链）：✅ 免登录直接解析
  - 抖音：⚠️ 平台风控严格，**必须**在「设置 → 本地视频下载引擎 → 平台 Cookies」粘贴从电脑浏览器导出的 Netscape 格式 Cookies（无需登录，浏览任意视频后导出即可）
  - 快手：支持同链路，未逐一验证
  - 网盘分享页（夸克 / 百度网盘）：❌ 需要登录与私有接口，不支持；请下载后用「本地视频」播放
- 服务支持访问令牌（`VIDEO_RESOLVER_TOKEN`）与缓存上限（`VIDEO_RESOLVER_MAX_MB`），缓存 24 小时自动清理

链接转写（生成时间戳字幕脚本）需要另行部署 [tools/video-transcriber](./tools/video-transcriber/README.md)（Whisper / Cloudflare Worker）。

## Android 壳（可选）

[android-shell/](./android-shell/README.md) 提供全屏 WebView 原生壳：状态栏注入、来电提醒、通知回复、截屏速聊、全局陪看截屏、推送唤醒等。网页端功能不受影响，壳只是增强。

## 部署到 Netlify / Vercel

1. 新建站点并关联本仓库，选择 `main`（正常设备）或 `test`（兼容设备，部分设备全屏异常时用）分支；
2. 构建设置保持默认（Netlify 自动读取 `netlify.toml`，Vercel 自动识别 Next.js）；
3. 在平台后台添加环境变量 `NEXT_PUBLIC_SELF_HOSTED_MODE=true`（平台不会读取 `.env.example`）；
4. 部署完成后按「快速开始」配置即可。

### 环境变量总表

除 `NEXT_PUBLIC_SELF_HOSTED_MODE` 外全部可选，不填时对应功能自动隐藏或停用。

| 变量 | 用途 |
|---|---|
| `NEXT_PUBLIC_SELF_HOSTED_MODE` | `true`=单机模式（自部署推荐）；`false`=启用账号/激活码门禁（需配 Supabase） |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | 站点账号、社区功能使用的 Supabase（服务端专用） |
| `MIXOLOGY_SUPABASE_URL` / `MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY` | 独家特调专用独立 Supabase |
| `ACCOUNT_GATE_SECRET` | 账号门禁签名密钥 |
| `VERIFY_ADMIN_KEY` / `APP_MARKET_ADMIN_KEY` | 成年审核 / 应用市场后台密钥 |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 便签墙实时刷新与多人联机 |
| `NEXT_PUBLIC_IMAGE_GEN_PROXY_URL` | 通用生图代理地址 |
| `NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE` | 网易云音乐 API（自部署 NeteaseCloudMusicApi 兼容实例） |
| `NEXT_PUBLIC_NETEASE_REAL_IP` | 网易云 API 解锁地区限制用 |
| `TRIPO_API_KEY` / `IMGBB_API_KEY` | 服务端兜底，一般不用填 |
| `WEIXIN_PROXY` | 微信本地助手代理 |
| `RESEND_API_KEY` / `REALITY_BRIDGE_EMAIL_FROM` / `SHORTCUT_EMAIL_VERIFICATION_SECRET` | 现实桥「邮件自动」实验通道（普通推送快捷动作不需要） |

> ⚠️ `NEXT_PUBLIC_*` 变量会打包进浏览器代码、完全公开。不要把 Supabase `service_role`、后台密钥、第三方 API 私钥写进任何 `NEXT_PUBLIC_*` 变量。

## 启用自己的 Supabase（可选云端功能）

账号、激活码、成年审核、便签墙、游戏大厅、应用市场、黑市等云端共享功能需要你自己的 Supabase。推荐在 Supabase SQL Editor 直接执行 [docs/supabase-all-in-one.sql](./docs/supabase-all-in-one.sql) 一键建齐（幂等），然后：

```env
NEXT_PUBLIC_SELF_HOSTED_MODE=false
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ACCOUNT_GATE_SECRET=your-random-long-secret
```

也可以按需执行 `docs/` 下的单个脚本（`account` / `verify` / `notewall` / `game-hall` / `custom-app-market` / `black-market` / `online-play` / `moderation`）。不配置任何 Supabase 也能完整使用单机模式。

**个人云**（每位用户自己的 Supabase 项目）与站点运营库是两件事：在「设置 → 云服务部署」粘贴你自己的 Supabase Access Token，应用会自动创建 `AI Phone Personal Cloud` 项目并部署备份 / 微信助手 / 离线推送等云函数。详见应用内引导。

## iOS 现实桥

角色可以调用你 iPhone 的快捷指令，并在结果回传后继续对话。三种送达方式：

1. **通知点击运行**（推荐）：随个人云一起部署，无需 Resend；
2. **屏幕速聊**：双击辅助触控球截取当前屏幕，在系统弹窗里与角色连续对话；要求个人云 Schema v3，App 内「现实桥 → 屏幕速聊」有一键导入步骤；
3. **邮件自动**（实验）：通过 Resend 发送触发邮件自动运行快捷指令，需要站点配置 Resend 与验证域名，步骤见 App 内「现实桥 → iOS 快捷动作」页的完整引导。

## 常用命令

```bash
npm run dev            # 本地开发（端口 3001）
npm run build          # 生产构建
npm run start          # 生产运行
npm run lint           # 代码检查
npm run test:life      # 生活系统回归测试
npm run check:push     # 校验个人云部署包一致性
npm run check:weixin   # 校验微信分发文件
npm run check:sdk      # 校验自定义 App SDK 一致性
```

## 目录速览

```
app/                 Next.js 路由与 API（auth / push / image-generation / resolve-short-link …）
components/          UI 组件（desktop-shell、聊天、生活、照片墙、一起看…）
lib/                 核心逻辑（存储、聊天引擎、生活运行时、照片墙存储…）
tools/video-resolver 视频解析服务（FastAPI + yt-dlp + parse-video-py）
tools/video-transcriber  视频转写服务
tools/weixin-local-assistant  微信本地助手
android-shell/       Android 原生壳
docs/                Supabase SQL、部署与移植指南、改动台账
scripts/             构建、校验与测试脚本
```

## 🧭 项目来源与致谢

### 上游继承关系

- **小笼包老师（原始项目）**：建立了核心框架——仿真手机界面与 AI 角色互动、私聊/群聊/朋友圈、角色卡/世界书/预设/记忆与剧情创作、小手机内应用与多媒体扩展、本地运行与部署基础架构。
  原始项目：https://github.com/xiaolongbao0709/ai-virtual-phone
- **末末老师（直接上游）**：持续二次开发——剧情分页/分支/多人剧情、动态邀请见面卡片、公共方案仓库与备份迁移、记忆标签筛选与私聊拉黑、聊天记录导入数据保护、全局聊天设置与新消息音效等。
  直接上游仓库：https://github.com/jianchu-in/momo.float.phone

### 本仓库的二次开发方向

以下为继承上游后持续开发的方向（归纳而非完整清单；具体归属以代码和提交记录为准）：

| 方向 | 主要内容 |
|---|---|
| 全局通话与持续互动 | 通话状态全局化、可拖动缩放的通话小窗与原生浮窗、自动搭话与消息排队补发、语音留档、浮窗设置与自检诊断 |
| 安卓原生能力与 APK 适配 | 壳与网页端通信桥扩展、原生通知与通知回复、系统级通话浮窗、桌面小组件、设备感知、状态栏/安全区/权限/设备兼容性维护 |
| 离线推送与定时消息 | 离线推送长连接与原生通知链路、定时任务保存/撤销/同步、推送自检与断线重连 |
| 现实桥与设备联动 | 设备感知与动作执行、快捷动作与任务调度、设备端与云端状态同步 |
| 新增独立 App | 生活（角色自主生活）、照片墙（共同回忆拼贴）、一起看（AI 陪看与视频解析）、档案室 |

### 致谢

再次感谢小笼包老师提供原始项目基础，感谢末末老师在直接上游版本中的持续开发与维护。本仓库只是在两位老师的成果上做维护、补充和适配。开源项目的贡献关系有时比较复杂，如果来源标注不清或归属错误，欢迎指出，我会及时更正。也希望大家在尊重原有成果的前提下，继续探索和开发。

## License

本项目基于 [AGPL-3.0-only](./LICENSE) 开源。

## Credits

本项目为独立实现，但部分产品设计和系统抽象受 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（AGPL-3.0）启发，包括预设、正则处理、世界书 / lorebook / WorldInfo 等概念。视频解析依赖 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 与 [parse-video-py](https://github.com/wujunwei928/parse-video-py)。字体、贴纸素材、3D 模型等第三方资源的授权说明见 [NOTICE](./NOTICE)。
