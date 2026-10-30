import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [app, runtime, observation, cloud, scheduler, bailout, reply, push] = await Promise.all([
  read("../components/life/life-engine-app.tsx"),
  read("../lib/life/life-runtime.ts"),
  read("../components/life/life-observation.tsx"),
  read("../lib/life/life-schedule-cloud.ts"),
  read("../lib/life/life-proactive-scheduler.ts"),
  read("../lib/push-bailout-client.ts"),
  read("../lib/notification-reply.ts"),
  read("../supabase/functions/push-generate/index.ts"),
]);

assert.match(app, /if \(settings\.autoGenerateWeeklyPlans\)\s*\{\s*next = generateWeeklyLifePlan/);
assert.match(app, /if \(liveSettings\.autoGenerateWeeklyPlans\)/);
assert.match(app, /<LifeDiagnosticsPanel\s*\/>/);
assert.match(app, /life-scene-notification-reply/);
assert.match(app, /refreshForegroundLease/);\nassert.match(app, /document\.visibilityState === "visible"/);
assert.match(app, /synchronizeCharacterHomeSchedule/);
assert.match(app, /reserveCharacterLocationStay/);
assert.match(runtime, /export function synchronizeCharacterHomeSchedule/);
assert.match(runtime, /export function reserveCharacterLocationStay/);
assert.match(observation, /生活片段补写完成/);
assert.match(observation, /生活片段补写失败/);
assert.match(cloud, /const fingerprint = JSON\.stringify\(\{ version: 2, playerLocationId, scenes, characterLocations, \.\.\.foregroundLease \}\)/);
assert.match(cloud, /foregroundLeaseUntil/);
assert.match(cloud, /Promise<boolean>/);
assert.match(scheduler, /await syncLifeScheduleSnapshot\(\)/);
assert.match(scheduler, /source: "schedule"/);
assert.doesNotMatch(scheduler, /cancelBailoutPrefix\(prefix\)/);
assert.match(bailout, /input\.source \?\? "foreground"/);
assert.match(reply, /action: isAction \? text : ""/);
assert.match(reply, /dialogue: isAction \? "" : text/);
assert.match(reply, /场景回复闭环完成/);
assert.match(push, /snapshot missing; rejected safely/);
assert.match(push, /foreground scene lease active; deferred until/);
assert.match(push, /status: "pending"/);
assert.match(push, /characterLocation === snapshot\.playerLocationId/);
assert.doesNotMatch(push, /characterLocation === snapshot\.playerLocationId \|\| scene\?\.characterIds/);

console.log("Life-system wiring checks passed.");
