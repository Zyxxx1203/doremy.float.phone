# Float Phone · AI 虚拟互动手机

这是一个以 Next.js、React 和 TypeScript 构建的手机式 AI 互动应用。项目保留上游的角色聊天与虚拟手机框架，并在此基础上增加生活系统、照片墙、一起看、媒体档案、现实桥和 Android Shell 等模块。

**本文只描述当前仓库中能定位到的代码入口与配置，不把“代码存在”写成“所有环境均已可用”。** 具体功能是否能运行，还取决于模型服务、个人云部署、Android APK 版本、系统授权和设备环境。

## 仓库关系与对照范围

本仓库：`Zyxxx1203/doremy.float.phone`

本次用于核对代码差异的仓库：`doremy1203/doremy.float.phone`。两边的 `main` 分支不是同一个提交。本次对照时，源仓库快照为 `8f4f7f1337f17513f401af9b0711c617cfee54f7`，本仓库快照为 `d9d445975a7098ca7d2847dc896e92ca95466f50`。按 Git tree 中的文件路径和 blob SHA 比较，目标仓库有 130 个源仓库快照中不存在的文件路径、2 个源仓库中存在而目标仓库中不存在的路径，以及 194 个同路径但内容不同的文件。这个统计是文件快照比较，不等于 130 项独立功能，也不代表所有差异都已逐行审计。

GitHub 仓库元数据当前显示，本仓库的 fork parent 是 `jianchu-in/momo.float.phone`；`doremy1203/doremy.float.phone` 是本次指定的对照仓库，不在 README 中将其误写为 GitHub 记录的直接 parent。上游项目来源与致谢见文末。

## 当前代码包含的主要模块

| 模块 | 当前代码中可定位的实现 | 使用边界 |
|---|---|---|
| 聊天与角色 | 手机桌面、角色资料、私聊/群聊、消息、提示词组装、记忆与工具调用 | 模型效果取决于用户配置的服务商、模型、提示词和上下文 |
| 生活系统 | `components/life/life-engine-app.tsx`；七日日程、角色/玩家活动地点、场景、邀约、共同经历、生活观察和诊断面板 | 本地界面和云端调度是不同链路；当前代码将生活主动消息生成开关硬编码为关闭，不能宣传为后台会主动发消息 |
| 照片墙 | `components/photo-wall-app.tsx`、画布/贴纸/模板/世界坐标/导出模块 | 依赖浏览器本地媒体存储；大图、复杂手势和不同 WebView 尺寸仍需设备验证 |
| 一起看 | `components/watch-together-app.tsx`；视频链接识别、播放入口、字幕/转写文本、时间点讨论、观看记录和视频理解调用 | 平台链接不保证都能解析或播放；登录态、风控、DRM、地区和服务商限制可能导致失败 |
| 视频解析与转写工具 | `lib/watch-resolver.ts`、`app/api/watch-resolver/*`，以及 `tools/video-resolver`、`tools/video-transcriber`、Cloudflare Worker | 站内解析、可选本地服务、转写和 AI 视频理解是不同环节，不是通用下载器 |
| 媒体档案室 | `components/archive-room-app.tsx`；媒体缓存浏览、引用来源检查、重复媒体扫描和删除 | 清理前应检查引用关系；本地缓存不等于云端备份 |
| 现实桥与设备联动 | `components/reality-bridge-app.tsx`、`lib/reality-bridge/*`、设备动作/感知桥接 | 规则、快捷指令和设备 API 需要对应平台、权限及外部服务；不能仅凭界面存在推断所有动作均已验证 |
| Android Shell | WebView、原生通知/回复、通话浮窗、桌面小组件、截屏、设备感知/动作桥、诊断与恢复 | 需要构建并安装匹配版本 APK；特殊权限、后台策略和厂商 ROM 会影响可用性 |

### 生活系统当前特别说明

生活系统包含七日日程和云端日程运行态计算代码：客户端可同步加密日程快照，`supabase/functions/life-scheduler/index.ts` 提供服务端日程评估逻辑，部署后由 Cron 驱动。

但当前代码中：
- `components/life/life-engine-app.tsx` 的 `LIFE_PROACTIVE_MESSAGES_ENABLED` 为 `false`；
- `lib/life/life-proactive-scheduler.ts` 的主动消息开关也为 `false`；
- `lib/life/life-schedule-cloud.ts` 同步的 `proactiveEnabled` 为 `false`。

因此，当前不能把角色后台主动发起生活消息描述为已启用功能。日程界面、场景交互和云端日程评估代码仍然存在；用户是否实际获得云端日程运行态更新，取决于其个人 Supabase Schema、Edge Function、Cron 和密钥是否部署正确。

### Android 原生能力当前版本

当前源码配置：`versionName 1.0.29`、`versionCode 28`、`minSdk 26`、`targetSdk 34`、`compileSdk 36`。以 `android-shell/app/build.gradle` 为准。

代码包含原生推送服务、通话相关服务、桌面小组件、截屏桥、设备感知/动作桥及现实桥接收器等实现。它们仍需要对应权限、站点配置和设备环境；安装成功不等于全部能力已经在每种机型上验收。

## 与对照仓库相比的主要增量方向

根据上述两个 Git tree 快照及本仓库新增/变更文件，当前差异集中在：

1. **生活系统模块化扩展**：新增生活系统 UI、运行时、存储、场景/日程/自主行为逻辑、诊断面板、云端日程 Edge Function 与 API 路由。
2. **照片墙与媒体管理**：新增照片墙应用、无限画布相关模块、贴纸/涂鸦/模板/导出，以及媒体档案室。
3. **一起看与视频处理**：新增站内解析 API、缓存播放逻辑、短链解析、视频字幕/关键帧/理解模块，以及可选本地解析和转写工具。
4. **现实桥与设备适配**：新增设备兼容设置和诊断、原生现实桥接收器、环境光监测服务及部分快捷指令/设备联动能力。
5. **聊天与数据链路调整**：修改聊天、提示词、记忆、角色 ID 解析、推送、备份、桌面小组件和设置等共享模块。
6. **工程检查和文档**：增加生活系统、照片墙、角色 ID、组件输出等测试脚本，以及多条 GitHub Actions 验证工作流和开发/诊断文档。

以上是按文件差异归纳的方向，不等于每一项功能都已通过真实设备或第三方服务验收。详细路径和状态见[相对对照仓库的改动台账](./docs/fork-changes-overview.md)。

## 本地运行

建议使用与当前 Next.js 15 项目兼容的 Node.js 版本和 npm。

```bash
git clone https://github.com/Zyxxx1203/doremy.float.phone.git
cd doremy.float.phone
npm install
cp .env.example .env.local
npm run dev
```

启动后以终端输出的本地地址为准。首次使用时，在应用设置中配置所需模型服务。不要将真实 API Key、service role key、邮件密钥或签名密钥写入客户端变量或提交到仓库。

## 常用命令

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run test:life
npm run test:photo-wall
npm run test:character-id
npm run test:widget-output
npm run check:sdk
npm run check:weixin
npm run check:push
```

`npm run build` 会先生成微信助手与个人推送相关部署产物，再执行 Next.js 构建。测试脚本只覆盖各自编写的测试范围；执行成功不代表第三方服务、云端部署或所有 Android 设备端到端通过。

## 部署边界

- **网页**：仓库包含 Netlify 配置；部署参数应以当前 Netlify 项目设置和 `netlify.toml` 为准。
- **模型服务**：聊天、生图、语音和视频理解按功能使用用户配置的服务商；未配置时相关能力不可用。
- **Supabase**：账号/在线服务、个人备份/推送、生活日程等有各自部署边界。网页发布不会自动升级用户独立的个人 Supabase 项目。
- **Android**：网页代码更新通常随线上站点部署生效；Kotlin、Manifest、原生桥、权限或资源变更需要重新构建 APK。
- **本地数据**：浏览器与 Android WebView 使用不同存储环境。卸载、清除站点数据或 App 数据可能造成仅本地保存的数据丢失，迁移前请使用应用内备份并验证恢复。

## 文档导航

- [设备 Fork 与 APK 使用指南](./DEVICE_SETUP_GUIDE.md)
- [Android Shell 构建说明](./android-shell/README.md)
- [Android 运行诊断](./android-shell/DIAGNOSTICS.md)
- [隐私、数据流与权限说明](./docs/隐私与权限说明.md)
- [云端生活日程架构](./docs/cloud-life-scheduler.md)
- [开发进度与验证清单](./docs/开发进度与验证清单.md)
- [公开分享发布门禁](./docs/公开分享发布门禁.md)
- [相对对照仓库的改动台账](./docs/fork-changes-overview.md)
- [角色 ID 契约](./docs/character-id-contract.md)

## 来源与许可

本仓库延续了虚拟手机项目的上游成果。GitHub 当前记录的 fork parent 为 [jianchu-in/momo.float.phone](https://github.com/jianchu-in/momo.float.phone)；原始项目为 [xiaolongbao0709/ai-virtual-phone](https://github.com/xiaolongbao0709/ai-virtual-phone)。本次另以 [doremy1203/doremy.float.phone](https://github.com/doremy1203/doremy.float.phone) 作为代码对照仓库。感谢原作者和后续贡献者；具体代码归属以提交历史和文件内容为准。

项目许可证见 [LICENSE](./LICENSE)，第三方素材与依赖说明见 [NOTICE](./NOTICE)。
