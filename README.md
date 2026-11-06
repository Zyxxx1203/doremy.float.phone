# Float Phone · AI 虚拟互动手机

Float Phone 是一个基于 Next.js、React 和 TypeScript 的可自部署 AI 虚拟手机项目。它把聊天、角色资料与多个扩展应用放在一个手机式界面中，可在浏览器运行，也可通过可选 Android WebView 壳访问同一站点。

本仓库是基于上游项目继续开发的个人 fork。**README 描述的是代码中存在的入口和设计，不代表所有功能已在所有设备、平台或云环境完成端到端验收。** 当前发布状态、自动化结果与待验证项目见[开发进度与验证清单](./docs/开发进度与验证清单.md)和[公开分享发布门禁](./docs/公开分享发布门禁.md)。

## 项目现状

- 默认自部署模式以浏览器本地存储为基础；具体功能可能使用 IndexedDB / 本地 KV、浏览器存储或 Android WebView 沙箱。
- LLM、生图、语音、视频理解等能力需要用户自行配置相应服务商与密钥。启用后，请求会发送到所配置的服务。
- Supabase 不是所有功能的统一必需项。账号/社区等站点功能、个人云备份、离线推送及云端生活日程等能力有各自的部署条件；只部署网页并不等于这些云端能力已启用。
- Android 壳提供 WebView 与部分原生能力。原生通知、后台连接、悬浮窗、桌面小组件、权限感知等功能受 APK 版本、系统授权、厂商后台策略和个人云部署影响。
- 本仓库目前应视为**可自部署的开发/公开测试项目**，不是已经完成全平台验收的稳定产品。

## 功能概览

以下按当前代码入口归纳，能力范围和限制以各功能设置页、对应文档及实际部署为准。

| 模块 | 当前代码覆盖的方向 | 使用边界 |
|---|---|---|
| 聊天与角色 | 私聊、群聊、角色卡、世界书、预设、记忆与提示词组装 | 模型能力、上下文长度和记忆效果取决于用户配置；不同应用是否注入短期上下文由对应配置与组装逻辑决定 |
| 生活 | 七日日程、地点与场景、邀约、共同经历、生活观察、角色自主行为、诊断记录 | 本地界面/状态与个人云调度并非同一链路；云端后台调度需部署个人 Supabase Schema、Edge Function 和 Cron，后台推送还受订阅与设备限制 |
| 照片墙 | 照片素材、画布摆放、模板、涂鸦、照片背面文字与导出 | 大图、复杂手势、不同 WebView 缩放比例和大画布导出仍需目标设备验收 |
| 一起看 | 视频播放入口、观看记录、时间点讨论、截图/字幕等上下文输入、AI 视频理解适配 | 不保证任意平台链接均可解析或播放；登录、签名、地区、风控、DRM、网络及服务商限制均可能影响结果 |
| 档案室及扩展应用 | 角色/世界资料管理及内置、可扩展应用入口 | 各应用的数据范围、云依赖和成熟度不同，不能据入口存在推断所有功能均已验收 |
| Android Shell | WebView 容器、原生通知/回复、推送连接、通话浮窗、设备桥接与诊断等 | 需要匹配版本 APK、权限和服务端配置；Android 厂商可能限制后台运行 |

### 一起看：解析与理解是不同能力

项目包含网页侧解析接口，也提供可选的本地视频解析/转写工具。它们不是通用的视频下载器，也不代表所有平台都可用。抖音、快手、B 站、小红书及普通直链的处理路径不同；具体支持范围请查看：

- [本地视频解析服务](./tools/video-resolver/README.md)
- [本地视频转写服务](./tools/video-transcriber/README.md)
- [Cloudflare 转写 Worker](./tools/cloudflare-video-transcriber/README.md)

请遵守视频平台条款、版权和所在地法律。对于无法访问、需要登录或受保护的内容，使用者应通过平台允许的方式提供本地文件、字幕或截图。

## 文档导航

| 文档 | 内容 |
|---|---|
| [DEVICE_SETUP_GUIDE.md](./DEVICE_SETUP_GUIDE.md) | Fork、自行构建 APK、安装与设备验收 |
| [android-shell/README.md](./android-shell/README.md) | Android 壳构建、签名、版本与原生能力说明 |
| [android-shell/DIAGNOSTICS.md](./android-shell/DIAGNOSTICS.md) | Android / WebView 诊断 |
| [docs/隐私与权限说明.md](./docs/隐私与权限说明.md) | 本地数据、外部服务数据流与 Android 权限 |
| [docs/cloud-life-scheduler.md](./docs/cloud-life-scheduler.md) | 个人云生活日程调度架构与部署边界 |
| [docs/开发进度与验证清单.md](./docs/开发进度与验证清单.md) | 当前代码、自动化检查和待验收事项 |
| [docs/公开分享发布门禁.md](./docs/公开分享发布门禁.md) | 构建、安全、云端部署与设备验收门禁 |
| [docs/fork-changes-overview.md](./docs/fork-changes-overview.md) | 相对上游的改动记录 |
| [docs/从诊断开始的开发差异台账.md](./docs/从诊断开始的开发差异台账.md) | 历史开发时间线与文件差异审计；其中带日期的统计是对应审计时点快照 |

## 本地运行

要求 Node.js 22 或更高版本，建议使用 npm。

```bash
git clone https://github.com/Zyxxx1203/doremy.float.phone.git
cd doremy.float.phone
npm install
cp .env.example .env.local
npm run dev
```

默认开发端口为 `3001`，可通过 `PORT` 修改。浏览器访问 `http://localhost:3001`。

首次运行后，在应用设置中配置你自己的模型服务与 API Key。不要把真实密钥写入仓库或任何 `NEXT_PUBLIC_*` 变量。

## 部署说明

### 网页部署

仓库包含 Netlify 配置（`netlify.toml`），也使用 Next.js 项目结构。实际部署时应以当前平台识别出的构建命令、发布目录和环境变量为准。部署到个人站点时，至少检查：

1. 使用本仓库的 `main` 分支；不要假定存在可供普通用户部署的 `test` 分支。
2. 按部署模式设置 `NEXT_PUBLIC_SELF_HOSTED_MODE`。
3. 仅为确实启用的功能配置 Supabase、模型服务或其他第三方服务。
4. 云函数、SQL Schema、Cron 与网页代码分别部署和验证；网页发布不会自动更新用户自己的 Supabase 项目。

### 单机与云端能力

单机模式可运行基础网页和本地数据功能。以下能力需要额外部署或配置，不能仅凭网页部署成功判断可用：

- 账号、社区、多人协作等站点级 Supabase 功能；
- 个人云备份、推送及生活系统云端调度；
- 用户选择的 LLM、生图、语音、视频理解或邮件服务；
- Android 原生通知、后台服务与设备权限。

个人云与站点运营 Supabase 是不同的部署边界。请按应用内部署引导和对应文档分别配置。

## Android 壳

Android 壳位于 [android-shell](./android-shell/README.md)，通过 WebView 加载你自己的线上站点。当前源码版本为 **1.0.29（versionCode 28）**，最低 Android API 为 26，compileSdk 为 36，targetSdk 为 34。版本号以当前 `android-shell/app/build.gradle` 为准。

网页代码更新通常只需重新部署站点；修改 Kotlin、Manifest、原生桥、权限或资源后，才需要重新构建 APK。APK 签名不一致可能导致无法覆盖安装；长期使用应保管自己的签名密钥。debug 包用于测试，不应将其等同于正式分发包。

Android 原生能力是否可用，取决于设备、系统版本、权限、后台策略、站点来源和云端部署。请勿把“APK 安装成功”当作“通知、后台调度、浮窗和小组件均正常”。

## 常用命令

```bash
npm run dev             # 本地开发
npm run build           # 生产构建（含部署产物生成）
npm run start           # 运行生产构建
npm run lint            # ESLint
npm run test:life       # 生活系统回归测试
npm run test:photo-wall # 照片墙相关回归测试
npm run test:character-id
npm run test:widget-output
npm run check:sdk       # 自定义 App SDK 一致性检查
npm run check:weixin    # 微信助手提示词/产物一致性检查
npm run check:push      # 个人云推送部署产物一致性检查
```

自动化测试通过只说明对应测试覆盖范围内的检查通过，不代表第三方服务部署、真实推送或所有 Android 机型端到端通过。最新工作流结果见[开发进度与验证清单](./docs/开发进度与验证清单.md)。

## 来源与许可

本仓库基于以下上游项目继续开发：

- 原始项目：[xiaolongbao0709/ai-virtual-phone](https://github.com/xiaolongbao0709/ai-virtual-phone)
- 直接上游：[jianchu-in/momo.float.phone](https://github.com/jianchu-in/momo.float.phone)

感谢上游作者及贡献者。此 fork 的具体改动以当前代码、提交记录和[改动总台账](./docs/fork-changes-overview.md)为准；历史文档中的功能归属与统计应结合其审计日期理解。

项目许可证见 [LICENSE](./LICENSE)。第三方素材与依赖的额外说明见 [NOTICE](./NOTICE)。
