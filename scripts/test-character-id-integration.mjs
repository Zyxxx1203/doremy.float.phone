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

// Exercise the actual chat-storage hydration/migration path with an in-memory
// IndexedDB boundary. This catches ordering regressions that a helper-only test
// would miss while keeping the test deterministic and network-free.
const storedCharacters = [{ id: "char_alpha", name: "小满" }, { id: "char_beta", name: "小满" }];
const persisted = { sessions: [], contacts: [] };
const dbMock = {
  chatDb: {},
  initChatDb: async () => ({
    messages: [],
    contacts: [
      { id: "contact_alpha", characterId: "char_alpha", addedAt: "2026-01-01T00:00:00.000Z" },
      { id: "contact_beta", characterId: "char_beta", addedAt: "2026-01-02T00:00:00.000Z" },
    ],
    sessions: [
      { id: "sess_alpha", contactId: "contact_alpha", unreadCount: 0, updatedAt: "2026-01-01T00:00:00.000Z", isPinned: false },
      { id: "sess_beta_legacy", contactId: "char_beta", unreadCount: 0, updatedAt: "2026-01-02T00:00:00.000Z", isPinned: false },
      { id: "sess_group", contactId: "group_legacy", isGroup: true, participantIds: ["char_alpha", "char_beta"], unreadCount: 0, updatedAt: "2026-01-03T00:00:00.000Z", isPinned: false },
    ],
  }),
  dbReplaceSessions: rows => { persisted.sessions = rows; },
  dbReplaceContacts: rows => { persisted.contacts = rows; },
};
const noOp = () => undefined;
const moduleMocks = {
  "./chat-db": dbMock,
  "./settings-storage": { resolveUserIdentity: noOp },
  "./character-storage": { loadCharacters: () => storedCharacters, saveCharacters: noOp },
  "./kv-db": { kvGet: () => null, kvSet: noOp, registerKvMigration: noOp },
  "./chat-plugin-hooks": { emitChatPluginEvent: noOp, runChatPluginTransformSync: (_event, value) => value },
  "./rich-message-parser": { parseAIResponse: noOp },
  "./text-tool-protocol": { extractTextToolDirectiveText: value => value },
  "./chat-avatar-intent": { findUserAvatarChangeIntent: noOp, inferAvatarDecisionFromReply: noOp },
  "./life/life-storage": { appendLifeTimelineEntry: noOp, loadVirtualLifeState: () => ({ settings: { enabled: false } }), saveVirtualLifeState: noOp },
  "./life/life-runtime": { getActorClock: noOp, resolveActorLifeNow: () => new Date() },
  "./character-id-contract": identity,
};
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");
const chatStorageCompiled = ts.transpileModule(chatStorageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const chatStorageModule = { exports: {} };
const customRequire = name => moduleMocks[name] || new Proxy({}, { get: () => noOp });
const browserWindow = { dispatchEvent: noOp, localStorage: { getItem: () => null, setItem: noOp, removeItem: noOp } };
vm.runInNewContext(chatStorageCompiled, {
  module: chatStorageModule, exports: chatStorageModule.exports, require: customRequire,
  window: browserWindow, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  Date, Math, Promise, console, setTimeout, clearTimeout,
}, { filename: "chat-storage.integration.cjs" });
await chatStorageModule.exports.hydrateChatStorage();
const hydratedSessions = chatStorageModule.exports.loadChatSessions();
assert.equal(hydratedSessions.find(item => item.id === "sess_alpha")?.characterId, "char_alpha",
  "real chat-storage hydration must canonicalize ChatContact.id to Character.id");
assert.equal(hydratedSessions.find(item => item.id === "sess_beta_legacy")?.characterId, "char_beta",
  "real chat-storage hydration must preserve legacy Character.id sessions");
assert.equal(hydratedSessions.find(item => item.id === "sess_group")?.characterId, undefined,
  "group synthetic contact IDs must remain outside private character identity");
assert.equal(chatStorageModule.exports.resolveSessionCharacterId(
  hydratedSessions.find(item => item.id === "sess_alpha"),
), "char_alpha", "public chat-storage resolver must return canonical Character.id");
assert.equal(chatStorageModule.exports.createOrGetSession("contact_alpha").characterId, "char_alpha",
  "new private sessions must persist the canonical character ID alongside the contact reference");
assert.ok(persisted.sessions.some(item => item.id === "sess_alpha" && item.characterId === "char_alpha"),
  "canonical identity migration must be persisted back to IndexedDB");


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
