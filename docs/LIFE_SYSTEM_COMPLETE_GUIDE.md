# 生活系统完整功能说明、运行链路与使用指南

> 仓库：`Zyxxx1203/doremy.float.phone`  
> 基线：`main` @ `d10eac85bce960496695a13aae1c1b171db09b28`  
> 类型：产品功能说明 + 使用手册 + 技术链路 + 现状审计  
> 边界：本轮以生活系统需求与链路梳理为基础，已开始修复确认的地点聊天室链路缺陷；不涉及 `doremy1203/doremy.float.phone` 旧公开仓库；日历功能不在本轮范围。

## 0. 如何阅读

本文把证据分成四类：
- **代码已确认**：在该基线源代码中找到实现。
- **测试已覆盖**：仓库存在相关自动化测试，不等于真机端到端通过。
- **风险待验证**：静态结构显示风险，但没有动态复现证据。
- **目标行为**：建议最终实现效果，不代表当前已经实现。

静态审查不能替代 Android 真机验证。没有实际执行的构建、测试、设备操作不会标记为通过。

## 1. 系统总览

生活系统是独立于普通线上私聊和长篇故事模式的虚拟生活状态与线下场景系统。它围绕玩家、角色、地点、日程、活动、邀请、现场消息、共同经历、观察记录组织数据。

核心职责：
1. 维护玩家与角色的生活状态；
2. 根据日程推导角色当前活动和位置；
3. 管理地点资料与地点聊天室；
4. 支持用户与多个在场角色进行线下互动；
5. 记录共同活动和已确认生活事实；
6. 将部分生活事实与实时状态提供给普通聊天上下文；
7. 通过前台协调、云端快照和通知桥接支持部分后台能力；
8. 提供诊断、导出和完整重置。

### 1.1 页面地图

主页面入口：`app/life/page.tsx`，主体：`components/life/life-engine-app.tsx`。主组件定义以下 Tab：

| Tab | 页面 | 主要职责 |
|---|---|---|
| home | 首页 | 生活状态总览和功能入口 |
| scene | 现场 | 地点聊天室、现场互动 |
| daily | 日常 | 玩家/角色当前活动与位置 |
| people | 人物 | 人物生活资料和角色状态 |
| plans | 计划 | 七日日程生成、查看和编辑 |
| invitations | 邀请 | 共同活动邀请和确认 |
| experiences | 经历 | 事件、共同经历和时间线 |
| locations | 地点 | 地点资料、地点库和导入 |
| observe | 观察 | 角色生活片段观察记录 |
| settings | 设置 | 运行规则、行为开关、记录和外观 |

辅助组件：`components/life/life-observation.tsx`、`components/life/life-diagnostics-panel.tsx`。本文已确认 Tab 标识和主组件入口；并非每个按钮/弹窗都已逐一做 JSX 级盘点，后续应继续补齐控件清单。

### 1.2 模块地图

| 模块 | 文件 | 责任 |
|---|---|---|
| 主页面编排 | `components/life/life-engine-app.tsx` | Tab、状态、现场、日程、设置及主要用户操作 |
| 领域类型 | `lib/life/life-types.ts` | 角色、地点、日程、场景、消息、事件、邀请、记忆 |
| 运行规则 | `lib/life/life-runtime.ts` | 位置解析、日程生成/结算、事件和邀请 |
| 状态存储 | `lib/life/life-storage.ts` | 生活状态加载与保存 |
| 场景提示词 | `lib/life/life-scene-prompt.ts` | 地点和现场上下文 |
| 回应角色队列 | `lib/life/life-engine.ts` | 遭遇感知、回应角色选择 |
| 输出协议 | `lib/life/life-output.ts` | AI 行动/对白解析与校验 |
| 自主行为 | `lib/life/life-autonomy.ts` | 自主行动窗口和角色选择 |
| 前台调度 | `lib/life/life-scheduler-coordinator.ts` | 前台场景租约协调 |
| 云端快照 | `lib/life/life-schedule-cloud.ts` | 本地状态转为云端调度快照 |
| 主动消息 | `lib/life/life-proactive-scheduler.ts` | 主动消息任务管理 |
| 通知队列 | `lib/life/life-notification-queue.ts` | 通知栏现场回复持久队列 |
| 记忆桥 | `lib/life/life-memory-bridge.ts` | 生活记忆/实时状态进入普通聊天 |
| 普通聊天 | `lib/chat-engine.ts` | 普通聊天上下文和模型调用 |
| 观察 | `components/life/life-observation.tsx` | 观察记录生成、图片和保留策略 |
| 诊断 | `lib/life/life-diagnostics.ts`、`components/life/life-diagnostics-panel.tsx` | 本机/云端诊断和失败队列查看 |
| 地点导入 | `lib/life/life-location-import.ts` | 角色卡/世界书等地点解析合并 |
| 云端调度 | `supabase/functions/life-scheduler/index.ts`、`public/ai-phone-push/life-scheduler.mjs` | 云端日程任务执行 |
| 通知桥接 | `lib/notification-reply.ts` | 原生通知回复接入 |

## 2. 核心数据模型

主要类型在 `lib/life/life-types.ts`，主状态由 `VirtualLifeState` 聚合。

| 数据 | 含义 | 关键字段/用途 |
|---|---|---|
| settings | 生活系统设置 | 总开关、日程、自主行为、记忆、现场显示 |
| locations | 地点库 | 描述、别名、布局、氛围、道具、居民、来源 |
| actorStates | 玩家/角色状态 | 活动、实际位置、临时位置有效期 |
| schedules | 日程槽 | 时间区间、活动、计划地点、来源 |
| scenes | 地点现场 | 场景 ID、地点、状态、参与者、图片 |
| sceneMessages | 现场消息 | 玩家/角色行动和对白 |
| events | 活动事件 | 计划、确认、进行中、完成、取消 |
| invitations | 邀请 | 发起人、参与人、地点、时间、状态 |
| memories | 共同记忆 | 符合条件的已确认生活事实 |
| timeline | 时间线 | 地点变化、日程、活动和现场记录 |

### 2.1 角色位置不是场景身份

`LifeActorState` 保存活动、日程槽、实际位置和临时位置有效期。  
`LifeScheduleSlot` 表示某时间段计划做什么、去哪里。  
`LifeSceneState` 保存某地点聊天室的历史身份、参与者和消息关联。

三者必须分开。角色位置变化不等于用户切换聊天室。

### 2.2 地点模型

`LifeLocation` 可保存名称、别名、分类、描述、氛围、布局、道具、角色习惯、居民、背景图、可见性和来源信息。字段来源标记用于区分用户、来源或 AI 内容，避免导入时无条件覆盖用户编辑。

### 2.3 场景模型

`LifeSceneState` 包含 id、locationId、locationName、startedAt、updatedAt、status、可选 eventId、participants、images、currentDescription 等。  
`LifeSceneMessage` 保存 speaker、role、action、dialogue、createdAt、来源渠道和可选 imageId。

当前类型允许 eventId，但用户已经明确：**不需要把日常场景和事件场景拆成两套聊天室。产品目标是一个地点一个线下聊天室。** eventId 只能作为兼容旧数据/活动关联字段审查，不应据此扩展出第二套场景。

---

# 第二部分：页面功能与使用指南

## 3. 首页（home）

**职责：**生活状态总览与功能入口。应让用户快速了解系统是否启用、角色活动/位置、待处理活动以及后续入口。

**数据来源：**settings、actorStates、schedules、events、invitations、timeline、场景摘要。

**正常效果：**
- 当前活动与有效日程一致；
- 实际位置和计划位置不混淆；
- 总览是当前状态的呈现，不应无故触发多次写入；
- 主动消息暂停时不应显示为后台主动消息正常运行。

**审计点：**首页读取是否为最新快照；状态是否混用计划/实际位置；刷新是否有副作用；页面切换后是否一致。

**使用建议：**首页用于看概况。地点或活动异常时，对照日常、计划和诊断记录，不要仅靠反复刷新掩盖问题。

## 4. 现场（scene）：地点聊天室

### 4.1 功能清单

| 功能 | 目标效果 |
|---|---|
| 进入现场 | 打开选定地点聊天室 |
| 地点设置 | 选择目的地 |
| 同行角色选择 | 指定陪同角色 |
| 确认前往 | 更新同行角色位置/行程并切换聊天室 |
| 在场角色 | 目的地原有角色保留，同行角色加入 |
| 对白输入 | 让在场角色按场景上下文回应 |
| 行动输入 | 记录玩家行动并推动场景 |
| 历史记录 | 再次进入同一地点恢复原消息 |
| 场景图片 | 生成、查看和管理与场景关联的图片 |

### 4.2 目标地点切换链路

~~~text
现场聊天室 → 地点设置 → 选择目的地 → 选择同行角色
     ↓
校验地点和同行角色
     ↓
按规则更新同行角色的位置/行程
     ↓
查找目的地唯一地点场景（无则创建）
     ↓
保留目的地原有在场角色
     ↓
合并本次同行角色（去重）
     ↓
设置当前场景身份
     ↓
加载目的地历史消息
     ↓
组装地点资料 + 在场角色 + 人设 + 相关记忆
     ↓
用户发言/行动 → AI 回应 → 保存消息和状态
~~~

必须遵守：
- 角色日程结算不能擅自切换用户当前聊天室；
- 角色实际位置变化不能改写既有场景的地点身份；
- 不能把旧地点历史搬到新地点；
- 目的地原有在场角色不能被同行角色覆盖；
- AI 回应对象必须来自当前有效在场参与者集合；
- 生成中的回合必须固定绑定发起时的 sceneId。

### 4.3 当前代码线索与风险

主组件：`components/life/life-engine-app.tsx`。当前场景选择器优先取第一个 active 场景，否则取最近更新的 paused 场景；消息按该场景 ID 过滤。

已识别的关键路径：
- `updateActorLocation`：更新实际位置并联动现场参与者；
- `performEnterLocationSolo`：单人进入地点；
- `performCreateScene`：创建场景；
- `performTransferSceneWithCompanions`：携带角色转移；
- `sendSceneTurn`：现场消息与 AI 回合；
- `buildLifeScenePromptContext`：现场上下文；
- `buildLifeSceneResponderQueue`：回应角色队列。

| 风险 | 可能影响 |
|---|---|
| 当前场景 ID 由 active/paused 推断 | 多场景时选错聊天室 |
| 玩家位置更新路径可能改写 scene.locationId | A 地点历史被挂到 B 地点 |
| 不同入口查找/创建场景的规则不统一 | 重复场景或错误复用 |
| 同行角色与目的地原有角色合并路径不统一 | 漏角色、覆盖角色或回应队列不完整 |
| `updateActorLocation` 曾把玩家当前场景的 `locationId` 改成玩家新位置 | 旧地点聊天室的历史可能被错误挂到新地点；角色实际位置编辑会改变聊天室身份 |
| `settleActorTimelineToNow` 的临时停留到期分支曾把 active scene 的 `locationId` 改成计划地点 | 日程结算会在用户没有主动切换时搬动聊天室历史 |
| 邀请事件结算曾创建带 `eventId` 的独立场景、将其设为 active/completed，并暂停其他 active 场景 | 同一地点出现事件聊天室与地点聊天室两套记录；日程结算还能抢走用户当前聊天室 |
| 前台场景选择曾只取第一个 active 场景 | 旧事件场景可能因顺序/更新时间抢占当前地点聊天室 |
| 地点入口曾优先按 active/paused 状态找场景，未优先排除 legacy event-linked 场景 | 同地点可能复用到旧事件场景，造成历史分叉 |
| `performEnterLocationSolo` 曾用本次按实际位置发现的角色列表整体覆盖目的地场景参与者 | 目的地原本就在场、但 actor 快照不完整/不同步的角色会从聊天室消失 |
| `performCreateScene` 曾用本次勾选角色整体覆盖已有地点场景参与者 | 重新打开/创建时会丢失该地点已有角色 |
| 生成队列部分在内存 ref | 离开/卸载时丢待处理回合 |
| 通知带 sceneId 但页面未必消费 | 通知无法精确定位现场 |
| 历史消息自动格式迁移 | 普通对白可能被误判为行动 |

### 4.3.1 本轮已沿真实调用链确认并修复

这次不是只按函数名推测。已逐段检查 `updateActorLocation`、`performCreateScene`、`performTransferSceneWithCompanions`、`performEnterLocationSolo` 和 `sendSceneTurn`：

1. 地点设置的同行入口先对所选角色调用 `reserveCharacterLocationStay`，提交角色实际位置，再进入 `performEnterLocationSolo`。
2. 到达流程按目的地查找已有 active/paused 场景；有则复用原 `scene.id`，没有才创建。现场消息仍按该 `scene.id` 过滤。
3. **已修复：**进入目的地时，不再用本次实际位置发现列表整体替换旧参与者；改为保留目的地场景中仍指向该地点的原参与者，再合并本次到达角色，按 `ownerType + ownerId` 去重。缺少旧 actor 快照的兼容参与者也不会被直接删除。
4. **已修复：**`performCreateScene` 复用地点场景时也走同一参与者合并函数，避免另一个入口重新覆盖成员。
5. **已修复：**`updateActorLocation` 只更新玩家实际位置和时间线，不再把当前场景的 `locationId` 改成新位置。
6. **已修复：**`settleActorTimelineToNow` 的临时停留到期只更新实际位置和时间线，不再重命名/移动 active scene，也不再把位置变更时间线挂到旧聊天室。
7. **已修复：**邀请事件只更新事件状态/共同记忆，并把参与者合并到该地点的唯一聊天室；不会再新建 eventId 专属聊天室，不会把该地点房间标记 completed，也不会暂停用户当前正在看的其他地点房间。
8. **已修复：**新增 `findLifeSceneForLocation`，地点进入、创建和事件结算统一选择同地点 canonical room；优先复用普通地点场景，兼容旧 eventId 场景。重新进入旧事件场景时清除 eventId 标记，将其回归地点聊天室。
9. **已修复：**新增 `findCurrentLifeScene`，前台聊天室选择优先普通地点房间，旧 eventId 场景不会仅因更新时间较新就抢占当前现场。
10. **已修复：**新增 `findCurrentLifeScene`，优先普通地点聊天室，其次按 active/paused/completed 和更新时间稳定选择；旧 eventId 场景不会仅因状态/顺序抢占地点聊天室。`LifeSceneState.eventId` 已明确标记为兼容旧数据的元信息，不再承担聊天室身份。
11. `sendSceneTurn` 从固定的 `turnScene.participants` 取在场角色，并将去重后的角色集合交给 `buildLifeSceneResponderQueue`；因此参与者合并结果会直接决定谁能回应。

实现文件：
- `components/life/life-engine-app.tsx`
- `lib/life/life-engine.ts`
- `scripts/test-life-scene-responders.mjs`
- `scripts/test-life-wiring.mjs`

自动化测试补充了参与者合并的去重/保留/更新断言，以及“玩家位置编辑不得调用 `upsertLifeScene`”的防回归检查。当前 GitHub Actions 运行结果尚未取得，因此**代码已提交到 PR 分支，但测试尚不能标记通过**；后续必须等 CI 并检查完整调用链后再合并。

### 4.4 用户使用步骤

1. 确认目的地已在地点库中。
2. 打开现场聊天室的地点设置。
3. 选择目的地。
4. 只勾选实际希望同行的角色。
5. 确认前往。
6. 检查地点名称和在场角色：同行角色 + 目的地原有在场角色都应出现。
7. 发送短消息，确认回应角色符合现场人员。
8. 离开后再次进入同一地点，确认历史完整。
9. 角色日程变化时，当前打开的聊天室不应自动跳走。

## 5. 日常（daily）

**职责：**展示玩家/角色当前活动与位置。  
**相关实现：**`LifeActorState`、`LifeScheduleSlot`、`resolveActorLocation()`、`getCurrentActorSchedule()`、`settleActorTimelineToNow()`。

**正常效果：**
- 当前活动与命中的日程一致；
- 临时手动位置在有效期内优先；
- 临时位置过期后按规则恢复计划地点；
- 位置变化记录到状态/时间线；
- 位置变化不改变用户当前聊天室。

**审计点：**计划地点和实际地点是否混用；结算是否重复；临时位置是否按时恢复；搬家是否只同步未来居家日程；页面读取是否有写入副作用。

## 6. 人物（people）

**职责：**以角色为中心展示生活资料、状态、居住/常去地点、地点习惯和参与情况。

**正常效果：**角色卡继续作为身份与人设主要来源，生活系统维护生活层状态，不复制出冲突的人设。

**审计点：**
- 角色删除、改名或 ID 变化后，日程/邀请/场景/记忆如何处理；
- 住所更新是否同步未来居家日程；
- 编辑是否走统一状态更新路径；
- 导入地点是否保留来源追溯；
- 角色离开场景后是否保留历史消息。

## 7. 计划（plans）

**职责：**玩家与角色七日日程生成、查看、编辑、移动和取消。

**已确认函数：**
- `generateWeeklyLifePlan()`：生成周计划基线；
- `insertManualLifeScheduleSlot()`：插入手动日程；
- `overlayScheduleSlotsOverFreeTime()`：安排覆盖空闲时间；
- `applyCharacterLifeScheduleChange()`：应用角色日程变更；
- `settleActorTimelineToNow()`：结算时间线；
- `syncScheduleLocationsToLibrary()`：同步计划地点到地点库。

**正常使用：**选择玩家/角色 → 查看周计划 → 无计划时生成 → 检查时间/活动/地点 → 手动调整 → 确认下一次生成不会覆盖人工安排。

**正常效果：**
- 自动计划提供基础安排，不覆盖手动安排；
- 时间冲突按明确规则切分/替换；
- 用户删除的地点不被同步逻辑重新创建；
- 日程更新角色状态，但不切换用户聊天室；
- 日程结束后进入下一时间段。

**风险：**多入口结算写入整份状态；临时位置与计划位置优先级复杂；云端快照可能滞后；普通聊天 prompt 读取可能隐式结算。

## 8. 邀请（invitations）

**职责：**共同活动邀请的发起、确认、参与者、时间地点及状态流转。

**相关函数：**`makeLifeInvitation()`、`confirmLifeInvitation()`、`placeAppointmentInActorSchedule()`。

**正常效果：**
- 待处理/确认/进行中/完成/取消状态清晰；
- 确认后参与者日程与地点安排一致；
- 活动开始时可进入对应地点互动；
- 活动结束后记录结果，不破坏地点聊天室历史；
- 邀请不能无故切换用户正在查看的其他地点。

**审计点：**重复确认是否重复插日程；取消是否清理安排；事件是否重复创建；邀请是否制造同地点重复聊天室；参与者与现场参与者是否一致。

## 9. 经历（experiences）

**职责：**呈现已发生/已确认事件、时间线和共同经历。

**数据：**events、memories、timeline 及现场消息关联。

**正常效果：**
- 计划不能被写成已发生；
- 记忆只沉淀符合条件的事实；
- 记忆关联真实参与角色；
- 时间地点参与者可追溯；
- 修改来源记录不应静默制造矛盾。

**审计点：**事件结算幂等；同一事件是否重复生成记忆；取消事件是否仍显示为经历；记忆是否只注入参与角色；时间线重建是否覆盖用户删除意图。

## 10. 地点（locations）

**职责：**管理生活系统地点资料。来源可能是用户手动创建、角色卡、世界书或 AI 行程地点。

**已确认导入机制：**`lib/life/life-location-import.ts` 负责解析/合并；按来源键避免重复导入；记录来源；尽量保护用户编辑字段；识别自有住所、共享住所、工作地点等关系。

**使用步骤：**
1. 先检查地点是否已存在；
2. 使用稳定且唯一的地点名称；
3. 补充描述、氛围、布局；
4. 多人互动地点核对居民/角色习惯；
5. 导入后核对来源和合并结果；
6. 确认手动修改未被覆盖；
7. 删除前检查日程、角色状态和场景引用。

**审计点：**地点删除后被日程同步复活；同名误合并；别名匹配；来源刷新覆盖用户字段；背景图媒体清理；旧场景如何显示；关联是否稳定使用 locationId。

## 11. 观察（observe）

**职责：**以角色为单位生成和管理某时间范围的生活观察片段。

**已确认实现：**`components/life/life-observation.tsx` 使用独立键 `ai_phone_life_observation_v1`。设置包含保留天数和最大回补天数；角色配置包含 enabled、intervalMinutes、lastGeneratedAt、coveredUntil；记录可保存时间范围、内容、地点、人物、图片引用/提示词。默认保留 90 天，最大回补默认 3 天（数值受 clamp 限制）。

**正常效果：**
- 每条观察属于明确角色和时间段；
- 内容参考当时日程与时间线；
- 图片稳定关联；
- 超期数据按设置清理；
- 观察不改写日程和场景历史。

**审计点：**重复任务、后台中断、失败重试、对象 URL 释放、短期记忆重复注入、计划被误写成经历。

## 12. 设置（settings）

设置字段定义于 `LifeEngineSettings`。以下是数据模型分类，控件的最终文案与布局应继续逐项对照 JSX。

**系统与行为**
- `enabled`：生活总开关；
- `autoGenerateWeeklyPlans`：自动生成周计划；
- `generateSpecialEvents`：特殊活动；
- `enableCoincidences`：偶遇；
- `enableCharacterAutonomy`：角色自主行为；
- `enableScheduleChangeTool`：日程调整工具；
- `enableFollowRequestTool`：跟随请求工具；
- `enableInvitations`：邀请；
- `saveConfirmedEventsToMemory`：共同经历记忆。

**现场互动**
- `randomSceneResponses`：随机选择在场角色回应；
- `showActionNarration`：行动叙述；
- `keepDialogueConcise`：对白简洁；
- `allowCharactersToStaySilent`：允许沉默；
- `maxConsecutiveActionOnly`：连续纯行动回合上限；
- `enableLifeFormatRepair`：格式修复；
- `revealExactLocations`：地点精确程度；
- `allowOnlineChatDuringSleep`：睡眠时允许普通线上聊天回复。

**记录**
- `recordLocationChanges`、`recordSceneMessages`、`recordCharacterActions`、`recordScheduleChanges`、`recordToolCalls`、`recordSocialActivity`、`recordDiaryActivity`、`recordChatActivity`。

**显示**
- 主题、强调色、透明度、对白/叙述字体字号、气泡样式、内边距、消息间距、紧凑布局、时间线、地点提示、背景图/模糊/亮度/遮罩、自定义 CSS。

**主动消息与图片**
- 主动现场消息开关与间隔、通知开关、静默时间；
- 自动生成场景图片、图片数量、风格和提示词。

### 12.1 主动消息当前状态（重要）

**代码已确认：**
- `components/life/life-engine-app.tsx` 中 `LIFE_PROACTIVE_MESSAGES_ENABLED = false`；
- `lib/life/life-proactive-scheduler.ts` 中同名常量也是 false；
- `lib/life/life-schedule-cloud.ts` 云端快照设置 `proactiveEnabled: false`。

所以主动消息机制虽然保留代码和配置字段，但当前被硬编码暂停。不能因为 UI 开关存在就宣称主动消息正在运行。日程快照/位置评估可能仍继续，不等于主动消息生成也在工作。

---

# 第三部分：运行链路说明

## 13. 状态加载与保存

~~~text
进入 /life
  → hydrateKvDb()
  → loadVirtualLifeState()
  → 页面 state / stateRef
  → 用户操作或后台逻辑生成新状态
  → commit / saveVirtualLifeState()
  → KV 持久化
  → 事件通知或重新读取
~~~

主要文件：`lib/life/life-storage.ts`、`lib/kv-db.ts`、`components/life/life-engine-app.tsx`。

**风险：**整份对象快照保存。多个异步调用分别读取旧状态、修改不同字段、先后保存时，后保存者可能覆盖先保存者。写入队列只能保证写入顺序，不能自动保证写入者使用最新快照。

**目标：**统一变更入口、revision/version、冲突检测/合并；覆盖同一 WebView、多标签页、多个 WebView 和云端写入；保存失败要可诊断。

## 14. 日程生成与结算

~~~text
触发周计划生成
 → 确定玩家/角色和周起始时间
 → 读取已有日程
 → 生成基础安排
 → 保留人工安排
 → 覆盖空闲时间段
 → 同步有效地点到地点库
 → 保存
~~~

结算函数 `settleActorTimelineToNow()` 会根据现实时间处理已到期日程、活动和临时位置，可能更新角色状态、事件、记忆和时间线。

**职责边界：日程结算只负责生活状态，不负责决定用户当前聊天室。**

## 15. 位置解析

`resolveActorLocation()` 综合临时位置、手动位置、当前日程计划地点和状态回退值。

目标规则：
- 临时地点有明确结束时间；
- 到期后按规则恢复计划地点；
- 位置变化更新角色状态和时间线；
- 不直接改写场景地点身份；
- 当前聊天室只由明确的场景切换操作改变。

## 16. 场景与参与者

当前主页面通过 active 场景或最近更新 paused 场景推断当前场景。地点进入、创建、携带同行角色转移、自动结算和手动位置更新存在多条路径，查找/复用规则需要统一。

**目标概念：**

| 概念 | 责任 |
|---|---|
| 角色实际位置 | 角色现在在哪里 |
| 角色计划位置 | 日程安排角色去哪里 |
| 场景 ID | 地点聊天室历史身份 |
| 场景地点 ID | 聊天室属于哪个地点 |
| 当前场景 ID | 用户正在查看的聊天室 |
| 场景参与者 | 目前在场、允许互动的对象 |

**目标地点切换契约：**
1. 接收目标 locationId；
2. 接收用户明确选择的同行角色；
3. 按产品规则更新同行角色位置/行程；
4. 查找目的地既有聊天室，无则创建；
5. 不更改目的地历史；
6. 保留目的地原有在场角色；
7. 加入同行角色并去重；
8. 从旧地点按规则移除已离开的角色；
9. 设置 currentSceneId；
10. 新消息和生成回合固定绑定 sceneId；
11. 按最新参与者重新计算回应队列。

不建立“日常聊天室/事件聊天室”两套系统。

## 17. 现场 AI 回合

~~~text
玩家输入
 → 确定当前 scene 和参与者
 → 写入玩家消息
 → 构造 responder queue
 → 组装地点/场景/参与者/人设/世界书上下文
 → 调用模型
 → 解析 life-output 协议
 → 校验行动/对白
 → 必要时格式修复重试
 → 保存角色行动/对白
 → 更新场景与时间线
~~~

格式修复应保持同一角色、同一场景、同一回合，不能制造新回合。

**风险：**玩家消息先写入，模型回复后生成；若中途卸载或失败，会留下半截回合。部分 busy 队列是内存 ref，不能保证退出后恢复。

## 18. 共同经历与普通聊天记忆桥

`lib/life/life-memory-bridge.ts` 提供：
- `buildLifeMemoryContext(characterId)`：已确认共同生活事实、近期已结算日程；
- `buildLifePresenceContext(characterId)`：实时活动、睡眠/清醒、位置和日程。

`lib/chat-engine.ts` 导入并调用两个桥接函数。

目标：
- 角色只接收自己参与的记忆；
- 计划不伪装成已发生事实；
- 实时状态和历史记忆分开；
- 统一进入普通聊天上下文；
- 不重复注入；
- prompt builder 尽量只读。

**当前风险已确认：**`loadSettledCharacterLifeState()` 在构建记忆/位置上下文时会调用 `settleActorTimelineToNow()`，状态变化时调用 `saveVirtualLifeState()`。这使普通聊天提示词组装可能间接结算并写入生活状态。

建议把结算放到明确调度/页面动作；记忆桥读取已结算快照，不在 prompt builder 中隐藏写入。

## 19. 图片链路

场景图片元数据保存在场景 images，媒体字节通过 media storage 引用，消息可通过 imageId 关联。图片生成开关、数量、风格和提示词在 settings。

正常效果：
- 图片关联正确 sceneId；
- 删除图片同步处理媒体引用、消息关联和图库元数据；
- 文字聊天不依赖图片加载成功；
- 生成完成后不能写到用户已切换的另一个场景。

**风险：**主页面存在从 scene.images 回填消息的逻辑。若用户删了消息但保留图片元数据，重新挂载可能再次创建消息。建议同步删除或增加 tombstone。

## 20. 通知栏回复

~~~text
AndroidShell 原生回复队列
 → 网页读取待处理回复
 → 判断普通聊天/现场回复
 → sessionId / sceneId / replyMode 定位
 → 写入对应消息
 → 现场回复进入持久队列
 → claim 防重复
 → AI 生成
 → 成功 acknowledge / 失败 retry
 → 诊断面板展示失败项
~~~

`lib/notification-reply.ts` 负责桥接；`lib/life/life-notification-queue.ts` 支持 replyId 去重、processing 租约、过期恢复、有界重试、失败状态。

待验证：sceneId 是否被页面真正消费并定位；目标角色是否仍在场；原生 ack 是否发生在网页持久化成功之后；旧 APK read-and-clear 兼容是否可能丢回复。

## 21. 后台调度与云端

`life-schedule-cloud.ts` 将玩家/角色位置、active scene、参与者、七日日程、角色状态、设置和前台租约整理为云端快照。根据环境选择个人云端或站点 API。

云端实现位置：
- `supabase/functions/life-scheduler/index.ts`
- `public/ai-phone-push/life-scheduler.mjs`

必须区分：
- 云端能评估/结算日程；
- 云端能否实际生成主动消息；
- Android 设备是否允许 WebView/应用后台执行。

当前主动消息有硬编码 false，不能宣传为已启用。前台 JS 定时器不等于可靠原生常驻服务。厂商后台限制必须真机验证。

---

# 第四部分：数据边界与开关影响

## 22. 持久化位置

| 数据 | 存储 |
|---|---|
| 生活主状态 | KV：`ai_phone_virtual_life_state_v1` |
| 观察记录 | KV：`ai_phone_life_observation_v1` |
| 通知现场回复队列 | localStorage：`life-scene-notification-reply-queue-v2`（兼容 v1） |
| 本机诊断 | life diagnostics 本地存储 |
| 云端诊断 | 生活调度诊断 API/表 |
| 场景图片 | media cache/storage，场景存 mediaRef |
| 普通聊天历史 | chat storage，和现场消息分开 |
| 云端日程快照 | push bridge / personal cloud |

重要边界：
- 现场消息 ≠ 普通私聊消息；
- 地点资料 ≠ 地点聊天室历史；
- 日程计划 ≠ 已发生经历；
- 观察记录 ≠ 已确认共同记忆；
- 云端快照不应在无同步协议时反向覆盖本地权威状态。

## 23. 开关影响矩阵（初步）

| 开关 | 应影响 | 不应意外影响 |
|---|---|---|
| 生活总开关 | 生活功能运行 | 普通聊天基础功能 |
| 自动周计划 | 自动生成日程 | 已有手动日程 |
| 特殊活动 | 周计划特殊活动 | 普通地点聊天室 |
| 角色自主行为 | 自主行为评估/后台任务 | 用户手动现场消息 |
| 日程变更工具 | AI 日程工具调用 | 用户手动编辑 |
| 跟随请求工具 | AI 请求同行 | 普通角色在场状态 |
| 邀请 | 邀请流程 | 普通地点切换 |
| 共同经历记忆 | 记忆保存/注入 | 原始现场消息 |
| 记录现场消息 | 现场记录 | 即时 UI（具体分支需核验） |
| 主动消息 | 角色主动发起 | 用户主动对话 |
| 自动场景图片 | 图片生成 | 文字消息保存 |
| 睡眠时线上回复 | 普通聊天临时唤醒 | 角色原始日程 |

这是功能边界目标。每个设置在全部调用点的实际门控仍需全仓库逐项确认，不能只看类型定义或 UI 控件。

---

# 第五部分：现状审计与风险清单

## 24. P0：场景身份与角色位置冲突

**证据：**主页面通过 active/paused 推断当前场景；玩家位置更新路径可能改写场景 locationId；地点进入路径则按地点查找/创建场景。

**风险：**A 地点历史被挂到 B；返回 A 创建空场景；进入 B 错误复用 A 的历史；聊天室随位置结算跳转。

**建议：**
- currentSceneId 成为明确持久化身份；
- 场景地点身份不可由普通位置结算改写；
- 统一地点切换入口；
- 一个地点一个稳定聊天室；
- 旧数据先诊断，确定性迁移，不自动合并不确定历史。

影响：现场、日常、日程、位置更新、邀请、通知、图片和普通聊天 presence。

## 25. P0：参与者集合必须统一

风险：只更新界面或只移动同行角色，目的地原有角色可能丢失；AI 可能只认识同行者。

验收：
- 目的地原有角色全部保留；
- 用户选择的同行角色全部加入；
- 未同行且不在目的地者不凭空加入；
- 离开角色从有效参与者移除但保留历史；
- responder queue 与有效参与者一致；
- 多次切换不会重复添加角色。

## 26. P1：历史对白自动迁移风险

此前审查发现一次性迁移会对 dialogue 调用解析器推断 action/dialogue，再写入格式版本。解析器可能把“别站在门口，进来吧”误判为行动；版本标记可能使错误结果永久保留。

建议：
- 停止对所有旧 dialogue 自动推断；
- 只迁移明确标记的旧格式；
- 已结构化消息保持原样；
- 修复工具先预览后确认；
- 不清空历史后重建。

## 27. P1：图片回填可能复活已删除消息

如果 scene.images 元数据仍在，消息被删除后挂载时可能重新回填。建议删除时同步图库/消息，或保存 tombstone；回填逻辑必须尊重删除意图。

## 28. P1：生成中离开可能留下半截回合

玩家消息先写入，模型回复后生成；卸载或失败会留下无回复消息。建议持久化 pending turn，至少含 turnId、sceneId、playerMessageId、targetActorIds、status、createdAt；重试幂等，提供恢复/取消。

## 29. P2：整份状态多写入者覆盖风险

多个模块 load-modify-save 同一聚合对象，可能拿旧快照覆盖新数据。建议盘点所有写入者、建立状态协调层、revision/version、并发冲突检测/合并。简单 load-modify-save 不是跨 WebView/后台进程原子事务。

## 30. P2：prompt builder 写入副作用

普通聊天记忆桥读取时可能结算并保存生活状态，导致普通私聊间接改生活系统。建议记忆桥只读，结算由明确调度层完成。

## 31. P2：时间线重建破坏删除意图

若时间线由源消息重建且没有 tombstone，用户删除内容可能重新出现或因源消息变化而丢失。应明确权威来源、保存删除意图、重建前可审计。

## 32. 测试覆盖

`package.json` 的 `test:life` 包含角色 ID、地点导入、runtime、autonomy、scene responders、output parser、guided schedule、wiring、通知队列/桥接、scheduler coordinator、turn coordinator、cloud scheduler 测试。

这些测试有价值，但 wiring 测试中的源码字符串断言不能替代完整 UI、持久化和异步场景切换测试。

建议补充：
1. A 聊天 → B → A，A 历史不变；
2. 目的地原有角色 + 同行角色都参与；
3. 日程变化不修改 currentSceneId；
4. 普通私聊读取生活上下文不改 scene/messages/location；
5. 生成中切换地点，回复仍写原 scene；
6. 重启后当前场景身份恢复；
7. 通知 sceneId 精确定位；
8. 删除图片消息后重挂载不复活；
9. 旧格式迁移不误判普通对白；
10. 两个并发写入不会互相覆盖。

---

# 第六部分：改进路线与验收

## 33. 建议实施顺序

| 顺序 | 工作 | 原因 |
|---|---|---|
| 1 | 场景身份与地点切换统一 | 现场历史和多人互动的根基 |
| 2 | 参与者集合与回应队列统一 | 同行者和原有角色都能参与 |
| 3 | 历史迁移止损 | 防止错误固化 |
| 4 | 图片删除/回填一致性 | 防止已删除内容复活 |
| 5 | pending turn 持久化 | 解决半截回合 |
| 6 | 普通聊天记忆桥只读化 | 降低隐式写入 |
| 7 | 全局状态写入协调 | 防止旧快照覆盖 |
| 8 | 端到端诊断和回归测试 | 防止反复回归 |

不要同时开多个会修改相同核心文件的 PR；按依赖顺序完成、审查、合并后再进入下一阶段。

## 34. 验收标准

**场景：**
- 一个地点一个稳定聊天室身份；
- 历史不随角色位置变化迁移；
- currentSceneId 可恢复；
- 日程结算不切换用户聊天室；
- A → B → A 后 A 历史完整。

**多人互动：**
- 同行角色加入；
- 目的地原有角色保留；
- 参与者列表和 responder queue 一致；
- 不在场角色不参与；
- 离开角色不再被选中，但历史保留。

**消息：**
- 消息固定 sceneId；
- 每回合幂等；
- 失败有可见状态；
- 切换地点不改变生成回合归属；
- 退出重进可恢复待处理任务。

**记忆：**
- 普通聊天读取生活上下文不写生活状态；
- 计划和经历明确区分；
- 记忆只注入参与角色；
- 不重复、不虚构、不覆盖删除意图。

**后台：**
- 主动消息暂停状态明确；
- 快照失败有诊断；
- 前台租约不会永久阻断后台；
- 云端不可用时不宣称后台可靠运行；
- Android 后台能力经真机验证。

---

# 第七部分：常见问题排查

## 35. 切换地点后聊天记录错误

检查地点 ID、当前场景推断逻辑、位置结算是否改写 scene.locationId、同地点是否有多个场景、目标场景是否被错误复用。不要先删历史或重建地点。

## 36. 同行角色到了，但目的地原有角色消失

检查目的地 participants 是否保留；同行角色加入是否追加去重而非整体替换；prompt 是否读最新 participants；responder queue 是否过滤正确；角色是否被标成离开。

## 37. 日程变化导致聊天室跳转

检查 `settleActorTimelineToNow`、`updateActorLocation`、后台快照同步和 currentSceneId 是否被推断覆盖。

## 38. 退出后只剩玩家消息

检查模型请求失败/abort、角色 busy 状态、pending turn 是否只在内存、玩家消息先写入的路径、是否有恢复入口。

## 39. 普通聊天改变生活状态

检查 `buildLifeMemoryContext`、`buildLifePresenceContext`、`loadSettledCharacterLifeState` 是否触发结算与 `saveVirtualLifeState`。

## 40. 主动消息没有发送

当前基线主动消息硬编码暂停。打开设置不一定能恢复。检查云端快照 proactiveEnabled、本地旧任务清理、云端诊断、前台租约、通知权限和 Android 后台限制。

---

# 附录 A：关键文件索引

| 路径 | 用途 |
|---|---|
| `app/life/page.tsx` | 路由入口 |
| `components/life/life-engine-app.tsx` | 主页面、Tab、场景、日程和设置 |
| `components/life/life-observation.tsx` | 观察 |
| `components/life/life-diagnostics-panel.tsx` | 诊断和重置 |
| `lib/life/life-types.ts` | 数据模型与默认设置 |
| `lib/life/life-runtime.ts` | 位置、日程、邀请、事件、结算 |
| `lib/life/life-storage.ts` | 状态持久化 |
| `lib/life/life-scene-prompt.ts` | 现场提示词 |
| `lib/life/life-engine.ts` | 回应角色队列 |
| `lib/life/life-output.ts` | 输出解析/校验 |
| `lib/life/life-autonomy.ts` | 自主行为 |
| `lib/life/life-scheduler-coordinator.ts` | 前台租约 |
| `lib/life/life-schedule-cloud.ts` | 云端快照 |
| `lib/life/life-proactive-scheduler.ts` | 主动消息调度 |
| `lib/life/life-notification-queue.ts` | 通知现场回复队列 |
| `lib/life/life-memory-bridge.ts` | 普通聊天记忆/位置桥 |
| `lib/notification-reply.ts` | 原生通知回复 |
| `lib/chat-engine.ts` | 普通聊天引擎 |
| `lib/life/life-location-import.ts` | 地点导入 |
| `supabase/functions/life-scheduler/index.ts` | 云端调度 |
| `public/ai-phone-push/life-scheduler.mjs` | 推送侧调度 |
| `scripts/test-life-runtime.mjs` | runtime 测试 |
| `scripts/test-life-wiring.mjs` | 接线测试 |
| `scripts/test-life-cloud-scheduler.mjs` | 云端调度测试 |
| `scripts/test-life-notification-queue.mjs` | 通知队列测试 |
| `package.json` | test:life 集合 |

## 附录 B：本次尚未完成的核验

1. 未在真实 Android 设备逐项点击十个 Tab 并完成 UI 验收；
2. 未模拟系统杀进程、厂商省电策略和重启后的完整后台链路；
3. 未对全部设置控件追踪所有调用点；
4. 未逐一盘点每个按钮和弹窗的完整 JSX；
5. 本轮完整构建与生活系统测试由 PR CI 执行，结果以 GitHub Actions 最终状态为准；
6. 未对用户现存数据执行迁移、修复或删除；
7. 本轮已修改地点聊天室参与者合并与玩家位置/场景身份解耦逻辑；未执行现存用户数据迁移。

下一轮深化审计按“页面控件 → 对应函数 → 下游模块 → 数据读写 → 测试/真机验收”补齐，优先现场地点设置、同行角色选择、参与者合并和当前场景持久化。

## 文档维护规则

- 每次生活系统核心逻辑 PR 更新审查基线 SHA 和对应章节；
- 问题标记为代码已确认、风险待验证或用户报告；
- 修复后保留修复前问题与验收证据；
- 数据迁移必须说明兼容、回滚和用户删除意图保护；
- 不把未实现目标写成当前功能。
