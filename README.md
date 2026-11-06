# Float Phone｜AI 虚拟互动手机

Float Phone 是一个以 Next.js、React、TypeScript 构建的手机式 AI 互动应用，并包含独立的 Android WebView Shell。仓库在聊天与角色互动框架上扩展了生活系统、照片墙、一起看、媒体档案室、现实桥和多种设备侧能力。

> **重要：代码存在不等于服务已部署，也不等于功能已在所有设备验证。** 本项目的实际能力取决于网页部署、用户配置的模型服务、个人云服务、APK 版本、系统权限和设备环境。本文只陈述能够从当前仓库代码与配置定位的信息；无法由代码证明的运行状态会明确标为需自行验证。

## 文档目录

- [完整文档导航与维护约定](./docs/README.md)

## 从这里开始

| 你的目标 | 从这里开始 |
|---|---|
| 第一次体验或本地运行 | [本地开发](#本地开发) |
| 自己部署网页 | [部署边界](#部署边界) 与 `.env.example` |
| 构建 Android APK | [Android Shell 指南](./android-shell/README.md) |
| Fork 后构建自己的 APK | [Fork 与 APK 指南](./DEVICE_SETUP_GUIDE.md) |
| 排查 Android 白屏、闪退或桥接问题 | [Android 诊断](./android-shell/DIAGNOSTICS.md) |
| 了解隐私、数据发送和权限 | [隐私与权限说明](./docs/隐私与权限说明.md) |
| 了解生活系统云端日程 | [云端生活日程说明](./docs/cloud-life-scheduler.md) |
| 了解本仓库相对指定代码基线的差异 | [代码差异台账](./docs/fork-changes-overview.md) |
| 角色 ID 规范 | [角色 ID 契约](./docs/character-id-contract.md) |

## 功能概览与边界

| 模块 | 当前代码入口 | 使用与验证边界 |
|---|---|---|
| 聊天与角色 | `components/chat/*`、`lib/chat-engine.ts`、提示词与记忆相关 `lib/*` | 需要在应用中配置可用模型；生成质量和上下文效果受模型、提示词、用户数据影响 |
| 生活系统 | `components/life/life-engine-app.tsx`、`lib/life/*`、`supabase/functions/life-scheduler/index.ts` | 包含七日日程、场景、邀约、共同经历、观察和诊断等代码；云端日程评估需要个人 Supabase 部署。主动消息生成当前由多个代码开关固定关闭，不应视为后台主动消息已启用 |
| 照片墙 | `components/photo-wall-app.tsx`、`components/photo-wall/*`、`lib/photo-wall-*.ts` | 包含画布、素材、贴纸/涂鸦、模板和导出逻辑；存储、性能、手势与导出效果需在目标浏览器/WebView 验证 |
| 一起看 | `components/watch-together-app.tsx`、`lib/watch-resolver.ts`、`app/api/watch-resolver/*` | 包含链接处理、播放入口、观看记录、讨论和视频理解相关代码；第三方平台受登录态、风控、地区、DRM 和接口变化限制，不保证所有链接可解析 |
| 视频处理工具 | `tools/video-resolver`、`tools/video-transcriber`、`tools/cloudflare-video-transcriber` | 属于可选工具/服务，不等于网页部署后自动具备本地解析或转写能力 |
| 媒体档案室 | `components/archive-room-app.tsx` | 管理媒体缓存和引用；清理前需确认引用关系。缓存不等于备份 |
| 现实桥与设备联动 | `components/reality-bridge-app.tsx`、`lib/reality-bridge/*`、Android 原生桥 | 具体动作受平台 API、权限、设备能力和外部服务限制；桥接接口存在不代表每项动作已实机验收 |
| Android Shell | `android-shell/app/src/main` | WebView 壳及原生通知、回复、通话、小组件、截屏、设备感知/动作等入口；需安装对应 APK 并按设备逐项验收 |

### 生活系统：必须了解的当前限制

当前源码中，`components/life/life-engine-app.tsx` 与 `lib/life/life-proactive-scheduler.ts` 的 `LIFE_PROACTIVE_MESSAGES_ENABLED` 为 `false`，`lib/life/life-schedule-cloud.ts` 同步的 `proactiveEnabled` 也为 `false`。因此当前不能宣传角色会在后台自动生成并主动发送生活消息。

云端 `life-scheduler` 是日程快照评估/运行态更新链路，不等同于主动消息生成与通知投递。需要个人 Supabase Schema、Edge Function、Cron、密钥及网络条件配合；网页部署不会自动更新用户自己的 Supabase 项目。详见[云端生活日程说明](./docs/cloud-life-scheduler.md)。

## 本地开发

仓库使用 Next.js 15、React 19、TypeScript 和 npm。建议使用受当前 Next.js 15 支持的 Node.js LTS 版本。

```bash
git clone https://github.com/Zyxxx1203/doremy.float.phone.git
cd doremy.float.phone
npm install
cp .env.example .env.local
npm run dev
```

开发服务器启动后，以终端输出的地址为准。部分功能需要模型服务或云端配置；未配置时对应能力可能不可用。不要把真实 API Key、Supabase service role key、签名密钥或其他凭据提交到仓库。

### 常用脚本（以 package.json 为准）

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动本地开发服务器 |
| `npm run build` | 生成微信助手/个人推送构建产物并执行 Next.js 构建 |
| `npm run start` | 启动生产模式本地服务器 |
| `npm run lint` | 执行 ESLint |
| `npm run test:life` | 运行生活系统相关脚本测试集合 |
| `npm run test:photo-wall` | 运行照片墙相关脚本测试 |
| `npm run test:character-id` | 运行角色 ID 集成测试 |
| `npm run test:widget-output` | 运行桌面小组件输出测试 |
| `npm run check:sdk` | 检查自定义应用 SDK 一致性 |
| `npm run check:weixin` | 检查微信助手提示词等价性 |
| `npm run check:push` | 检查个人推送构建产物 |

这些脚本只覆盖各自编写的检查范围。脚本存在不代表最近已执行；测试通过也不代表第三方服务、生产云环境或所有 Android 机型端到端通过。

## 部署边界

项目包含多套独立部署面，不能把一次网页部署当作全栈部署完成。

1. **网页应用**：根目录 `netlify.toml` 配置 `npm run build`、`.next` 发布目录和 Netlify Next.js 插件。
2. **自部署模式**：`.env.example` 将 `NEXT_PUBLIC_SELF_HOSTED_MODE=true` 作为自部署默认示例。请按自己的部署方式配置变量；`NEXT_PUBLIC_*` 会进入浏览器，绝不能放服务端密钥。
3. **Supabase**：主云服务、个人推送/备份、生活日程以及独立特调服务存在不同配置边界。执行 SQL、部署 Edge Functions、设置 Cron 和 Secrets 需按具体功能文档操作；网页构建不会自动完成这些步骤。
4. **Android APK**：`.github/workflows/android-shell.yml` 使用 Java 17、Gradle 8.11.1 构建。未配置完整 release 签名 Secrets 时，工作流只发布可安装的 debug APK；配置签名后才会构建签名 release APK。
5. **网页与 APK 更新不同步**：纯网页逻辑随站点部署更新；Kotlin、Manifest、原生桥、原生资源或权限声明变化需要重新构建 APK。
6. **本地数据**：浏览器与 Android WebView 沙箱不互通。清除站点/App 数据或卸载可能造成仅本地保存的数据丢失。迁移前先用应用内备份并验证恢复。

环境变量清单以 [.env.example](./.env.example) 为准；其中有些变量仅供可选集成，不代表默认启用。

## Android 版本信息

当前源码 `android-shell/app/build.gradle` 配置：versionName `1.0.29`、versionCode `28`、minSdk `26`、targetSdk `34`、compileSdk `36`。这是仓库配置值，不代表所有 Android 版本或厂商系统都已通过兼容性测试。

- [Android Shell 构建、安装和推送说明](./android-shell/README.md)
- [Fork 后构建与设备验收指南](./DEVICE_SETUP_GUIDE.md)
- [Android 运行诊断与崩溃恢复](./android-shell/DIAGNOSTICS.md)

## 数据与隐私

应用可能在用户主动配置或调用功能时向模型供应商、云端项目、视频解析/转写服务、图床或其他第三方发送相应请求。具体数据类别与 Android 权限边界见[隐私、数据流与权限说明](./docs/隐私与权限说明.md)。该技术说明不是所有部署者均可直接使用的法律隐私政策；公开部署者应补充自己的运营者身份、日志、联系渠道和适用法律要求。

## 项目来源、对照与许可

GitHub 当前记录的 fork parent 为 `jianchu-in/momo.float.phone`。本仓库也曾以 `doremy1203/doremy.float.phone` 作为代码对照快照；它不是 GitHub 元数据记录的直接 parent。文件差异统计和边界见[代码差异台账](./docs/fork-changes-overview.md)。感谢上游作者及后续贡献者，具体代码归属以提交历史、文件内容和各自许可证为准。

项目许可证见 [LICENSE](./LICENSE)，第三方声明见 [NOTICE](./NOTICE)。本仓库许可证不自动替代第三方依赖、素材或服务各自的许可条款。
