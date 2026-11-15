import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-engine.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox, exports: moduleBox.exports,
  console, JSON, Set, Map, Array, String, Number, Boolean, RegExp, Date, Math,
}, { filename: "life-engine.cjs" });
const { buildLifeSceneResponderQueue, findCurrentLifeScene, findLifeSceneForLocation, mergeLifeSceneParticipants } = moduleBox.exports;

assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b", "c"], randomEnabled: true, randomSeed: 1,
    selectedCharacterId: "a", awarenessCharacterId: "c",
  })),
  ["b", "a", "c"],
  "random + specified + awareness can produce three distinct responders in order",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b", "c"], randomEnabled: true, randomSeed: 1,
    selectedCharacterId: "b", awarenessCharacterId: "b",
  })),
  ["b"],
  "the same character selected by all three routes must respond only once",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b", "c"], randomEnabled: false, randomSeed: 1,
    selectedCharacterId: "a", awarenessCharacterId: "c",
  })),
  ["a", "c"],
  "manual mode keeps the specified and independently aware characters without random selection",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b"], randomEnabled: true, randomSeed: 0,
    awarenessCharacterId: "b",
  })),
  ["a", "b"],
  "random mode can add a separate awareness responder",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: [], randomEnabled: true, randomSeed: 0,
    selectedCharacterId: "missing", awarenessCharacterId: "missing",
  })),
  [],
  "non-present characters are never queued",
);


const foregroundRoom = findCurrentLifeScene([
  { id: "legacy-active", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", status: "active", eventId: "old-event", participants: [], lastSettledEventIds: [] },
  { id: "location-active", locationId: "home", locationName: "家", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z", status: "paused", participants: [], lastSettledEventIds: [] },
]);
assert.equal(foregroundRoom.id, "location-active", "legacy event-linked scenes must not win foreground selection over a location room");

const canonicalRoom = findLifeSceneForLocation([
  { id: "legacy-event-room", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z", status: "active", eventId: "old-event", participants: [], lastSettledEventIds: [] },
  { id: "canonical-location-room", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", status: "paused", participants: [], lastSettledEventIds: [] },
], "cafe");
assert.equal(canonicalRoom.id, "canonical-location-room", "a normal location room must win over a newer legacy event-linked room");

const mergedParticipants = mergeLifeSceneParticipants(
  [
    { ownerType: "player", ownerId: "player", activity: "在咖啡店", awarenessByActorId: { a: "aware" } },
    { ownerType: "character", ownerId: "a", activity: "正在看书", awarenessByActorId: { player: "aware" } },
    { ownerType: "character", ownerId: "b", activity: "正在喝咖啡", awarenessByActorId: { player: "suspects" } },
  ],
  [
    { ownerType: "player", ownerId: "player", activity: "刚来到这里", awarenessByActorId: {} },
    { ownerType: "character", ownerId: "a", activity: "正在看书", awarenessByActorId: { player: "aware", b: "aware" } },
    { ownerType: "character", ownerId: "c", activity: "刚刚同行到达", awarenessByActorId: { player: "aware" } },
  ],
);
assert.deepEqual(
  Array.from(mergedParticipants, item => item.ownerType + ":" + item.ownerId),
  ["player:player", "character:a", "character:b", "character:c"],
  "destination room members are retained and newly arrived companions are appended exactly once",
);
assert.equal(mergedParticipants.find(item => item.ownerId === "player").activity, "刚来到这里");
assert.equal(mergedParticipants.find(item => item.ownerId === "a").awarenessByActorId.b, "aware");

console.log("Life scene responder queue and destination participant merge tests passed.");
