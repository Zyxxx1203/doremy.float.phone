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
const { enqueuePendingLifeSceneReply, peekPendingLifeSceneReply, claimPendingLifeSceneReply, retryPendingLifeSceneReply, acknowledgePendingLifeSceneReply } = moduleBox.exports;

const first = { replyId: "reply-1", sceneId: "scene-a", characterId: "char-a", replyMode: "action" };
const second = { replyId: "reply-2", sceneId: "scene-a", characterId: "char-a", replyMode: "dialogue" };
enqueuePendingLifeSceneReply(first);
enqueuePendingLifeSceneReply(first);
enqueuePendingLifeSceneReply(second);
assert.equal(peekPendingLifeSceneReply().replyId, first.replyId, "queue should preserve FIFO order and deduplicate stable reply IDs");
assert.equal(peekPendingLifeSceneReply().status, "pending");
const claimed = claimPendingLifeSceneReply("reply-1", 1000);
assert.equal(claimed.status, "processing", "claiming a reply should persist a processing lease");
assert.equal(claimPendingLifeSceneReply("reply-1", 1001), null, "a second worker must not claim an already-processing reply");
assert.equal(peekPendingLifeSceneReply(2000).replyId, "reply-1", "processing replies remain durable until acknowledged");
retryPendingLifeSceneReply("reply-1", "model temporarily busy", 2000);
const retryable = peekPendingLifeSceneReply(2001);
assert.equal(retryable.replyId, "reply-1", "failed attempts should remain in the durable queue");
assert.equal(retryable.status, "pending", "retry should return the item to pending");
assert.equal(peekPendingLifeSceneReply(6999).replyId, "reply-1", "retry delay must not discard the queued item");
const claimedAgain = claimPendingLifeSceneReply("reply-1", 7000);
assert.equal(claimedAgain.status, "processing", "reply should be claimable after backoff");
acknowledgePendingLifeSceneReply("reply-1");
assert.equal(peekPendingLifeSceneReply().replyId, second.replyId, "acknowledging a completed reply should expose the next queue item");
acknowledgePendingLifeSceneReply("reply-2");
assert.equal(peekPendingLifeSceneReply(), null, "queue should become empty after all replies are acknowledged");

const third = { replyId: "reply-3", sceneId: "scene-b", characterId: "char-b", replyMode: "dialogue" };
enqueuePendingLifeSceneReply(third);
claimPendingLifeSceneReply("reply-3", 10000);
assert.equal(peekPendingLifeSceneReply(10000).status, "processing");
assert.equal(peekPendingLifeSceneReply(10000 + 90_001).status, "pending", "expired processing lease should recover after an interrupted page");
acknowledgePendingLifeSceneReply("reply-3");

const exhausted = { replyId: "reply-4", sceneId: "scene-c", characterId: "char-c", replyMode: "action" };
enqueuePendingLifeSceneReply(exhausted);
for (let attempt = 0; attempt < 5; attempt++) {
  const item = peekPendingLifeSceneReply(20000 + attempt * 600000);
  if (item.replyId !== "reply-4") break;
  claimPendingLifeSceneReply("reply-4", 20000 + attempt * 600000);
  retryPendingLifeSceneReply("reply-4", "persistent error", 20000 + attempt * 600000);
}
assert.equal(peekPendingLifeSceneReply(9999999), null, "exhausted items should stop retrying after the configured attempt limit");

console.log("Life notification reply queue tests passed.");
