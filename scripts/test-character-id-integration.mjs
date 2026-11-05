import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleBox = { exports: {} };
  vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, Date, Math }, { filename: path });
  return moduleBox.exports;
}

const identity = await loadTs("../lib/character-id-contract.ts");
const guided = await loadTs("../lib/life/life-guided-schedule.ts");

const characters = new Set(["char_alpha", "char_beta"]);
const contacts = [
  { id: "contact_alpha", characterId: "char_alpha" },
  { id: "contact_beta", characterId: "char_beta" },
];

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "contact_alpha" }, contacts, characters,
), "char_alpha", "new-format contact references must resolve to Character.id");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "char_beta" }, contacts, characters,
), "char_beta", "legacy sessions that stored Character.id must remain readable");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "contact_alpha", characterId: "char_beta" }, contacts, characters,
), "char_beta", "a valid canonical session characterId must survive a changed contact mapping");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "group_123", isGroup: true }, contacts, characters,
), null, "synthetic group contact IDs must never resolve as a private character");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "contact_deleted" }, contacts, characters,
), null, "an orphaned contact ID must fail closed rather than guess by display name");

const now = new Date("2026-11-05T08:00:00.000Z");
const dayStart = new Date("2026-11-05T00:00:00.000Z");
const dayEnd = new Date("2026-11-12T00:00:00.000Z");
const contexts = [
  { ownerType: "character", ownerId: "char_alpha", name: "小满", now, dayStart, dayEnd, existing: [] },
  { ownerType: "character", ownerId: "char_beta", name: "小满", now, dayStart, dayEnd, existing: [] },
  { ownerType: "player", ownerId: "player", name: "我", now, dayStart, dayEnd, existing: [] },
];

const good = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_alpha", actorType: "character", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "阅读", location: "家",
}] }), contexts);
assert.equal(good.drafts.length, 1);
assert.equal(good.drafts[0].ownerId, "char_alpha", "the schedule draft must retain the canonical Character.id");

const legacyNameOnly = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorName: "我", actorType: "player", dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(legacyNameOnly.drafts.length, 1, "unique legacy name-only output remains compatible");

const ambiguousNameOnly = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorName: "小满", actorType: "character", dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(ambiguousNameOnly.drafts.length, 0, "same-name characters must not be guessed");

const wrongId = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_unknown", actorType: "character", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(wrongId.drafts.length, 0, "a supplied invalid actorId must not be overridden by actorName");

const wrongType = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_alpha", actorType: "player", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(wrongType.drafts.length, 0, "actorType mismatch must be rejected");

const overlap = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char_alpha", actorType: "character", actorName: "小满", dayOffset: 0, start: "15:00", end: "16:00", title: "阅读" },
  { actorId: "char_alpha", actorType: "character", actorName: "小满", dayOffset: 0, start: "15:30", end: "16:30", title: "写作" },
] }), contexts);
assert.equal(overlap.drafts.length, 1);
assert.equal(overlap.conflicts.length, 1, "overlapping drafts must be reported instead of silently dropped");

console.log("Character ID + guided schedule integration checks passed.");
