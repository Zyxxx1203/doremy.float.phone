import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [app, cloud, scheduler, bailout, reply, push] = await Promise.all([
  read("../components/life/life-engine-app.tsx"),
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
assert.match(app, /setLifeSceneForegroundLease\(activeScene\.id, true\)/);
assert.match(cloud, /const fingerprint = JSON\.stringify\(\{ version: 1, playerLocationId, scenes, characterLocations \}\)/);
assert.match(cloud, /actualLocationUntil/);
assert.match(scheduler, /hasForegroundLease\(scene\.id/);
assert.match(scheduler, /source: "schedule"/);
assert.match(bailout, /input\.source \?\? "foreground"/);
assert.match(reply, /action: isAction \? text : ""/);
assert.match(reply, /dialogue: isAction \? "" : text/);
assert.match(reply, /场景回复闭环完成/);
assert.match(push, /snapshot missing; rejected safely/);
assert.match(push, /characterLocation === snapshot\.playerLocationId/);
assert.doesNotMatch(push, /characterLocation === snapshot\.playerLocationId \|\| scene\?\.characterIds/);

console.log("Life-system wiring checks passed.");
