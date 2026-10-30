import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-notification-queue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const values = new Map();
const localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};
const moduleBox = { exports: {} };
const sandbox = { module: moduleBox, exports: moduleBox.exports, window: {}, localStorage, Date, Math, console };
vm.runInNewContext(compiled, sandbox, { filename: "life-notification-queue.cjs" });
const { enqueuePendingLifeSceneReply, peekPendingLifeSceneReply, acknowledgePendingLifeSceneReply } = moduleBox.exports;

const first = { replyId: "reply-1", sceneId: "scene-a", characterId: "char-a", replyMode: "action" };
const second = { replyId: "reply-2", sceneId: "scene-a", characterId: "char-a", replyMode: "dialogue" };
enqueuePendingLifeSceneReply(first);
enqueuePendingLifeSceneReply(first);
enqueuePendingLifeSceneReply(second);
assert.deepEqual(JSON.parse(JSON.stringify(peekPendingLifeSceneReply())), first, "queue should preserve FIFO order and deduplicate stable reply IDs");
acknowledgePendingLifeSceneReply("reply-1");
assert.deepEqual(JSON.parse(JSON.stringify(peekPendingLifeSceneReply())), second, "acknowledging one reply should expose the next queued reply");
acknowledgePendingLifeSceneReply("reply-2");
assert.equal(peekPendingLifeSceneReply(), null, "queue should become empty after all replies are acknowledged");

console.log("Life notification reply queue tests passed.");
