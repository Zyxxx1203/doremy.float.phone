import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-autonomy.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, Date, Math, console }, { filename: "life-autonomy.cjs" });
const { evaluateLifeAutonomyWindow, chooseLifeAutonomyCharacter } = moduleBox.exports;

const now = new Date("2026-10-17T12:00:00.000Z").getTime();
const scene = {
  id: "scene-1",
  status: "active",
  participants: [
    { ownerType: "player", ownerId: "player", activity: "在场" },
    { ownerType: "character", ownerId: "c1", activity: "看书" },
    { ownerType: "character", ownerId: "c2", activity: "喝咖啡" },
  ],
};
const base = {
  scene,
  playerId: "player",
  messages: [],
  now,
  lastAttemptAt: now - 10 * 60_000,
  intervalMinutes: 5,
  busy: false,
  visible: true,
  enabled: true,
};
assert.equal(evaluateLifeAutonomyWindow(base).eligible, true, "eligible co-present scene can take an autonomous turn");
assert.deepEqual(Array.from(evaluateLifeAutonomyWindow(base).characterIds), ["c1", "c2"]);

assert.equal(evaluateLifeAutonomyWindow({ ...base, enabled: false }).reason, "disabled");
assert.equal(evaluateLifeAutonomyWindow({ ...base, visible: false }).reason, "app-not-visible");
assert.equal(evaluateLifeAutonomyWindow({ ...base, busy: true }).reason, "another-turn-running");
assert.equal(evaluateLifeAutonomyWindow({ ...base, scene: { ...scene, status: "paused" } }).reason, "no-active-scene");
assert.equal(evaluateLifeAutonomyWindow({ ...base, scene: { ...scene, participants: scene.participants.filter(p => p.ownerType !== "player") } }).reason, "player-not-present");
assert.equal(evaluateLifeAutonomyWindow({ ...base, scene: { ...scene, participants: scene.participants.filter(p => p.ownerType !== "character") } }).reason, "no-character-present");
assert.equal(evaluateLifeAutonomyWindow({ ...base, lastAttemptAt: now - 60_000 }).reason, "cooldown");

const recentMessage = { sceneId: scene.id, role: "player", createdAt: new Date(now - 30_000).toISOString() };
assert.equal(evaluateLifeAutonomyWindow({ ...base, messages: [recentMessage] }).reason, "recent-scene-message");

const dailyMessages = Array.from({ length: 12 }, (_, index) => ({
  sceneId: scene.id,
  role: "character",
  createdAt: new Date(now - (index + 1) * 10 * 60_000).toISOString(),
}));
assert.equal(evaluateLifeAutonomyWindow({ ...base, messages: dailyMessages }).reason, "daily-limit");

assert.equal(chooseLifeAutonomyCharacter(["c1", "c2"], "c1") !== "c1", true, "speaker selection should avoid immediate repetition where possible");
assert.equal(chooseLifeAutonomyCharacter([], undefined), null);

console.log("Life autonomy guardrail tests passed.");
