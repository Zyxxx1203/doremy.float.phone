import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [app, runtime, observation, cloud, coordinator, scheduler, bailout, reply, queue, push, chatStorage, nativeBridge, nativeReceiver] = await Promise.all([
  read("../components/life/life-engine-app.tsx"),
  read("../lib/life/life-runtime.ts"),
  read("../components/life/life-observation.tsx"),
  read("../lib/life/life-schedule-cloud.ts"),
  read("../lib/life/life-scheduler-coordinator.ts"),
  read("../lib/life/life-proactive-scheduler.ts"),
  read("../lib/push-bailout-client.ts"),
  read("../lib/notification-reply.ts"),
  read("../lib/life/life-notification-queue.ts"),
  read("../supabase/functions/push-generate/index.ts"),
  read("../lib/chat-storage.ts"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/NotificationReplyReceiver.kt"),
]);

assert.match(app, /if \(settings\.autoGenerateWeeklyPlans\)\s*\{\s*next = generateWeeklyLifePlan/);
assert.match(app, /if \(liveSettings\.autoGenerateWeeklyPlans\)/);
assert.match(app, /<LifeDiagnosticsPanel\s*\/>/);
assert.match(app, /life-scene-notification-reply/);
assert.match(app, /peekPendingLifeSceneReply/);
assert.match(app, /claimPendingLifeSceneReply/);
assert.match(app, /retryPendingLifeSceneReply/);
assert.match(app, /failPendingLifeSceneReply/);
assert.match(app, /if \(!ready \|\| busy\) return/);
assert.match(app, /acknowledgePendingLifeSceneReply\(pending\.replyId\)/);
assert.match(app, /outcome === "completed"/);
assert.match(app, /sendSceneTurn\(undefined, true, pending\.replyId\)/);
assert.match(app, /notification-reply-response-/);
assert.match(app, /outcome !== "deferred"/);
assert.match(app, /refreshNotificationReplyQueue\(value => value \+ 1\)/);
const notificationOutcomeIndex = app.indexOf("const outcome = await sendSceneTurn(undefined, true, pending.replyId)");
const notificationAckIndex = app.indexOf("acknowledgePendingLifeSceneReply(pending.replyId)", notificationOutcomeIndex);
assert.ok(notificationOutcomeIndex >= 0 && notificationAckIndex > notificationOutcomeIndex, "notification queue must only acknowledge after the AI turn completes");

assert.match(app, /return "completed"/);
assert.match(app, /return forceReaction \? "deferred" : "failed"/);
assert.match(app, /refreshForegroundLease/);
assert.match(app, /setLifeSceneForegroundLease/);
assert.match(app, /document\.visibilityState === "visible"/);
assert.match(app, /synchronizeCharacterHomeSchedule/);
assert.match(app, /reserveCharacterLocationStay/);
assert.match(app, /前台后续兜底任务已挂载/);
assert.match(app, /请先启用生活系统、角色自主行动和主动消息/);
assert.match(runtime, /export function synchronizeCharacterHomeSchedule/);
assert.match(runtime, /export function reserveCharacterLocationStay/);
assert.match(runtime, /export function resolveActorLocation/);
assert.match(cloud, /resolveActorLocation\(state, "player", "player"\)/);
assert.match(scheduler, /resolveActorLocation\(state, "character", characterId\)/);
assert.match(observation, /生活片段补写完成/);
assert.match(observation, /生活片段补写失败/);
assert.match(observation, /const fromMs = Math\.max\(previousCovered, defaultStart\)/);
assert.match(observation, /coveredUntil: new Date\(nowMs\)\.toISOString\(\)/);
assert.match(observation, /busyRef\.current\.add\(character\.id\)/);
assert.match(cloud, /const fingerprint = JSON\.stringify\(\{ version: 2, playerLocationId, scenes, characterLocations, \.\.\.foregroundLease \}\)/);
assert.match(cloud, /foregroundLeaseUntil/);
assert.match(cloud, /readLifeSceneForegroundLease/);
assert.match(coordinator, /export function setLifeSceneForegroundLease/);
assert.match(coordinator, /export function readLifeSceneForegroundLease/);
assert.match(coordinator, /120_000/);
assert.match(cloud, /Promise<boolean>/);
assert.match(cloud, /MAX_SNAPSHOT_AGE_MS = 5 \* 60_000/);
assert.match(scheduler, /await syncLifeScheduleSnapshot\(\)/);
assert.match(scheduler, /rerunRequested = true/);
assert.match(scheduler, /const onScheduleChanged = \(\) => \{ start\(\); \}/);
assert.match(scheduler, /const scene = state\.scenes\.find\(item => item\.status === "active"\s*&& item\.locationId === player\.id/);
assert.match(scheduler, /source: "schedule"/);
assert.match(scheduler, /主动消息已关闭，撤销待执行任务/);
assert.match(scheduler, /scene\.status === "active" && scene\.locationId === player\.id/);
assert.doesNotMatch(scheduler, /cancelBailoutPrefix\(prefix\)/);
assert.match(bailout, /input\.source \?\? "foreground"/);
assert.match(bailout, /characterId \+ ":foreground"/);
assert.match(reply, /action: isAction \? text : ""/);
assert.match(reply, /dialogue: isAction \? "" : text/);
assert.match(reply, /通知回复已写入并排队/);
assert.match(reply, /peekPendingReplies/);
assert.match(reply, /acknowledgePendingReplies\(JSON\.stringify\(completedIds\)\)/);
assert.match(reply, /notification-reply-chat-/);
assert.match(reply, /notificationReplyFlushPromise/);
assert.match(reply, /if \(result === "retry"\)/);
assert.match(reply, /enqueuePendingLifeSceneReply/);
assert.match(reply, /if \(!queued\)/);
assert.match(chatStorage, /if \(msg\.id\)/);
assert.match(chatStorage, /getSortedSessionMessages\(msg\.sessionId\)\.find/);
assert.match(nativeBridge, /fun peekPendingReplies/);
assert.match(nativeBridge, /fun acknowledgePendingReplies/);
assert.match(nativeReceiver, /fun peekPendingReplies/);
assert.match(nativeReceiver, /fun acknowledgePendingReplies/);
assert.match(app, /待处理回复已交给生活现场 AI/);
assert.match(app, /生活现场已生成角色回应/);
assert.match(reply, /enqueuePendingLifeSceneReply/);
assert.match(reply, /window\.location\.assign\("\/life\?sceneId=/);
assert.match(queue, /export function enqueuePendingLifeSceneReply/);
assert.match(queue, /export function claimPendingLifeSceneReply/);
assert.match(queue, /export function retryPendingLifeSceneReply/);
assert.match(queue, /export function failPendingLifeSceneReply/);
assert.match(queue, /export function renewPendingLifeSceneReply/);
assert.match(app, /renewPendingLifeSceneReply\(pending\.replyId\)/);
assert.match(queue, /PROCESSING_LEASE_MS/);
assert.match(push, /snapshot missing; rejected safely/);
assert.match(push, /foreground scene lease active; deferred until/);
assert.match(push, /status: "pending"/);
assert.match(push, /characterLocation === snapshot\.playerLocationId/);
assert.doesNotMatch(push, /characterLocation === snapshot\.playerLocationId \|\| scene\?\.characterIds/);

console.log("Life-system wiring checks passed.");
