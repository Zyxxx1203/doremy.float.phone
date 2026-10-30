import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [app, runtime, observation, cloud, coordinator, scheduler, bailout, reply, queue, push] = await Promise.all([
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
]);

assert.match(app, /if \(settings\.autoGenerateWeeklyPlans\)\s*\{\s*next = generateWeeklyLifePlan/);
assert.match(app, /if \(liveSettings\.autoGenerateWeeklyPlans\)/);
assert.match(app, /<LifeDiagnosticsPanel\s*\/>/);
assert.match(app, /life-scene-notification-reply/);
assert.match(app, /peekPendingLifeSceneReply/);
assert.match(app, /acknowledgePendingLifeSceneReply/);
assert.match(app, /refreshForegroundLease/);
assert.match(app, /setLifeSceneForegroundLease/);
assert.match(app, /document\.visibilityState === "visible"/);
assert.match(app, /synchronizeCharacterHomeSchedule/);
assert.match(app, /reserveCharacterLocationStay/);
assert.match(app, /前台后续兜底任务已挂载/);
assert.match(runtime, /export function synchronizeCharacterHomeSchedule/);
assert.match(runtime, /export function reserveCharacterLocationStay/);
assert.match(observation, /生活片段补写完成/);
assert.match(observation, /生活片段补写失败/);
assert.match(cloud, /const fingerprint = JSON\.stringify\(\{ version: 2, playerLocationId, scenes, characterLocations, \.\.\.foregroundLease \}\)/);
assert.match(cloud, /foregroundLeaseUntil/);
assert.match(cloud, /readLifeSceneForegroundLease/);
assert.match(coordinator, /export function setLifeSceneForegroundLease/);
assert.match(coordinator, /export function readLifeSceneForegroundLease/);
assert.match(coordinator, /120_000/);
assert.match(cloud, /Promise<boolean>/);
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
assert.match(reply, /场景回复闭环完成/);
assert.match(reply, /enqueuePendingLifeSceneReply/);
assert.match(reply, /window\.location\.assign\("\/life\?sceneId=/);
assert.match(queue, /export function enqueuePendingLifeSceneReply/);
assert.match(queue, /export function acknowledgePendingLifeSceneReply/);
assert.match(push, /snapshot missing; rejected safely/);
assert.match(push, /foreground scene lease active; deferred until/);
assert.match(push, /status: "pending"/);
assert.match(push, /characterLocation === snapshot\.playerLocationId/);
assert.doesNotMatch(push, /characterLocation === snapshot\.playerLocationId \|\| scene\?\.characterIds/);

console.log("Life-system wiring checks passed.");
