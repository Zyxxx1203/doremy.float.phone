# 相对对照仓库的代码差异台账

> 更新基线：2026-11-25。对照仓库 `doremy1203/doremy.float.phone` 的 `main`（`8f4f7f1337f17513f401af9b0711c617cfee54f7`）。
>
> 这是 Git tree 文件路径与 blob SHA 的快照比较：本仓库 130 个路径在源仓库快照中不存在；源仓库有 2 个路径在本仓库快照中不存在；194 个同路径文件的 blob SHA 不同。它不等于独立功能数量，也不等于完整逐行语义审查。以下只列出能从当前代码入口确认的主要方向。

## 1. 生活系统

本仓库新增了 `components/life/life-engine-app.tsx` 及 `lib/life/*` 多个模块，并新增：
- `app/life/page.tsx`、生活重置与日程诊断 API；
- `supabase/functions/life-scheduler/index.ts`；
- `public/ai-phone-push/life-scheduler.mjs`；
- 生活系统诊断、观察、日程协调和通知回复队列相关代码；
- `scripts/test-life-*.mjs` 回归脚本。

当前 UI 覆盖七日日程、角色/玩家活动与地点、生活场景、邀约、共同经历、生活观察和诊断入口。

生活系统近期还包含：
- **主动消息**：客户端与调度器的 `LIFE_PROACTIVE_MESSAGES_ENABLED` 已恢复为 `true`；生活设置提供后台主动消息开关、消息间隔和现场安静时长。后台生成依赖个人 Supabase Schema、`life-scheduler`、`push-generate`、Cron、推送订阅与设备后台策略，未部署时只有前台现场本地主动消息可用。
- **前台让行**：生活现场前台租约约 120 秒过期；现场可见时线上追问暂停触发但不删除排期，服务端把非生活任务延后到现场结束后。
- **角色工具**：新增 `life_move_location`，可立即去指定地点或玩家当前所在地点；原有查日程、邀约、申请跟随、创建/修改/取消日程的工具描述改为主动触发式。详细链路见[云端生活日程说明](./cloud-life-scheduler.md)。
- **场景归并**：同一地点只保留一个聊天室，全局最多一个 active；旧场景消息与时间线重挂。
- **位置来源与临时起意**：位置来源标记、手动改地点 TTL、同行/手动地点改写日程、临时起意开关与每日次数上限。

## 2. 照片墙与媒体档案室

本仓库新增：
- `components/photo-wall-app.tsx`；
- `components/photo-wall/photo-wall-canvas.tsx`、`photo-wall-sticker.tsx`；
- `lib/photo-wall-storage.ts`、`photo-wall-world.ts`、`photo-wall-templates.ts`、`photo-wall-export.ts` 等；
- `components/archive-room-app.tsx`。

照片墙代码包含照片素材、位置/缩放/旋转、画布世界尺寸、模板、贴纸/涂鸦、背景与 PNG 导出等实现。媒体档案室读取媒体缓存，检查聊天和照片墙引用，并提供媒体筛选与重复项扫描。删除前仍应检查引用关系；这不代表所有大图和机型手势已通过实机验收。多图共创记录的作者署名使用实际上传者，不再统一写成角色。

## 3. 一起看与视频处理

本仓库新增或扩展：
- `components/watch-together-app.tsx`；
- `lib/watch-resolver.ts` 与 `app/api/watch-resolver/*`；
- `app/api/resolve-short-link/route.ts`；
- `lib/video-transcript.ts`、`lib/video-keyframe-analysis.ts`、`lib/gemini-video-understanding.ts`；
- `tools/video-resolver`、`tools/video-transcriber`、`tools/cloudflare-video-transcriber`。

一起看包含链接识别、播放入口、观看记录、时间点讨论、字幕/转写文本处理和 AI 视频理解调用。站内解析服务使用服务端缓存；本地解析/转写工具需用户另行安装部署。不同平台链接可能受登录、Cookie、风控、地区、DRM 和接口变化影响，不保证通用解析成功。

## 4. 现实桥、设备诊断与 Android 增量

本仓库新增的可确认文件包括：
- `lib/device-compatibility.ts`、`components/settings/device-compatibility-settings.tsx`；
- `components/settings/module-diagnostics.tsx`、`performance-diagnostics.tsx`、`runtime-diagnostics.tsx`；
- `android-shell/app/src/main/java/app/floatphone/shell/AmbientLightMonitorService.kt`；
- `NativeRealityBridge.kt`、`PhoneWidgetConfigActivity.kt`；
- `android-shell/DIAGNOSTICS.md`。

Manifest 中注册了环境光监测前台服务和电源事件接收器；设备动作、感知、日历、健康、截屏、小组件等接口需结合实际 APK 版本与权限检查。接口声明或诊断面板显示“支持”只说明检测到桥方法，不代表某个动作已在所有设备上成功执行。

Android 壳还包含：
- **角色陪伴专注与看守锁**：内置专注 App、L1 提醒锁/L2 看守锁/L3 承诺死锁、全屏拦截页、白名单角色审批、通行证多选申请、申请制白名单与随机查岗。
- **推送服务加固**：`PushService` 缓存 Supabase 连接参数，站点短暂不可达时续连；`PushWatchdogReceiver` 每 15 分钟检查服务存活并尝试拉起。看门狗提高存活率，但不保证厂商不回收。
- **全屏处理**：网页在 `FloatShell/` 环境不再请求 DOM 全屏，避免 Android WebView 反复弹出全屏失败提示。

当前 `android-shell/app/build.gradle` 配置为 versionName `1.0.29`、versionCode `28`、minSdk `26`、targetSdk `34`、compileSdk `36`。版本升级应以该文件为准。

## 5. 聊天、记忆、推送、备份与小组件改动

与源仓库同路径但内容不同的文件包括：
- `lib/llm-prompt-assembler.ts`、`lib/short-term-assembler.ts`、`lib/memory-injector.ts` 等提示词和记忆链路；
- `lib/chat-engine.ts`、`lib/chat-storage.ts`、`components/chat/*` 等聊天链路；
- `lib/personal-push-cloud.ts`、`lib/push-bridge-*.ts`、`supabase/functions/push-*` 等推送链路；
- `lib/widget/*`、`components/widget/*`、Android 小组件代码；
- 备份、媒体缓存、设置和设备桥接代码。

这些是文件差异定位结果，不在此把每个文件变化都推断成一项新功能。角色 ID 规范见[角色 ID 契约](./character-id-contract.md)；推送和 Android 链路请结合诊断文档逐项验证。

近期同路径文件的主要行为变化还包括：
- 云端连续失败熔断：快照/推送通道连续 5 次失败后暂停自动重试并发送系统通知，诊断页可手动重试。
- 聊天工具描述改为主动触发式：照片墙、便签墙、音乐、角色日历、系统日历、本地资料库、感知、设备操作、备忘录、桌面留言等说明“什么时候该主动调用”；管理型工具箱动作保持中性。
- 生活现场对话气泡内边距默认值改为 6，旧默认 3/4 一次性迁移，用户自定义值保留。
- 生活现场重复的动作/对白规则合并，删除死代码与重复工具提示，日程请求不再重复注入角色卡/性格。

## 6. 内置应用与预设

- **内置应用去重**：市场安装版按 `id`、`manifest.id`、`identifier`、名称和 `app_<id>_` 前缀匹配，避免重复出现。
- **预设同步**：新增「补全内置条目」与常驻同步状态；专注条目改名并归入线上聊天作用域，清理历史重复副本与重复 `{{tools}}`。
- **备忘录**：记住上次选择的角色/空间，下次打开不再回到默认身份。
- **心意手作**：奖章柜两处圆形头像改用真实用户/角色头像，替换 emoji，并保留圆形裁剪。
- **原生离线回复**：随机跳过上一条已用模板，减少每次同一句的情况。

## 7. 工程与验证

本仓库新增多条工作流，包括聊天消息链路、生活系统、全局兼容性、组件输出、视频解析和 Android APK 构建相关工作流。新增测试脚本包括：
- `npm run test:life`
- `npm run test:photo-wall`
- `npm run test:character-id`
- `npm run test:widget-output`

其他检查命令见根目录 `package.json`。测试脚本存在不等于已执行；执行成功也只覆盖脚本明确检查的范围。
