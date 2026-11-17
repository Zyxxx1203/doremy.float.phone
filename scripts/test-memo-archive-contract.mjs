import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [storage, tools, ui, assembler] = await Promise.all([
  readFile("lib/memo-archive-storage.ts", "utf8"),
  readFile("lib/tool-executor.ts", "utf8"),
  readFile("components/memo-archive-app.tsx", "utf8"),
  readFile("lib/short-term-assembler.ts", "utf8"),
]);

// Local-only persistence and owner isolation.
assert.match(storage, /super\("floatphone-memo-archive-v1"\)/);
assert.match(storage, /if\(old&&!same\(old\.owner,owner\)\)throw Error/);
assert.match(storage, /if\(!f\|\|!same\(f\.owner,owner\)\)throw Error/);
assert.match(storage, /只有用户自己的备忘录可以分享/);
assert.match(storage, /owner\.type==="user"\?raw\.sharedWith as string\[\]:\[\]/);

// Import must validate structure and references before committing.
assert.match(storage, /不支持的备份格式/);
assert.match(storage, /备份中存在不存在的档案盒引用/);
assert.match(storage, /备忘录标签或待办数据无效/);
assert.match(storage, /d\.transaction\("rw",d\.folders,d\.notes/);

// Batch todo writes are atomic and append to the latest persisted version.
assert.match(storage, /export async function appendMemoTodos/);
assert.match(storage, /d\.transaction\("rw",d\.notes/);
assert.match(storage, /todos:\[\\.\\.\\.current\\.todos,\\.\\.\\.additions\\]/);
assert.match(tools, /appendMemoTodos\(owner/);
assert.match(tools, /items 至少需要包含一条有效 text/);

// Review scheduling is bounded and only consumed after successful generation.
assert.match(storage, /slice\(0, 5\)/);
assert.match(storage, /maxChars = 850/);
assert.match(storage, /pendingMemoReviewIds/);
assert.match(storage, /markMemoReviewCompleted/);\nassert.match(storage, /getMemoReviewStatus/);
assert.match(storage, /note\.body\.replace\(/);
assert.ok(storage.includes("replace(/" + String.fromCharCode(92) + "s+/g"), "digest must collapse whitespace");

// Capability stays private-chat-only and shared user notes are read-only.
assert.match(tools, /备忘录工具仅允许在一对一私聊中使用/);
assert.match(tools, /用户分享（只读）/);
assert.match(tools, /readSharedMemoNotes/);

// UI exposes archive lifecycle, backup, review and per-space typography preferences.
for (const token of ["我的备忘录", "角色备忘录", "全部手记", "待办清单", "分类", "已收起的手记", "回收站", "偏好与备份", "导出当前空间", "永久删除", "memo-archive-appearance:"]) {
  assert.ok(ui.includes(token), `missing memo UI contract: ${token}`);
}
assert.match(ui, /setSelectedId\(null\); setTab\("settings"\)/);
assert.match(ui, /setMobileMoreOpen/);
assert.match(ui, /formatToolbar/);
assert.match(ui, /detailBody/);
assert.match(ui, /data-theme=\{theme\}/);
assert.match(assembler, /loadMemoTimelineProjectionEntries/);
assert.match(assembler, /sourceApp: "memo"/);

console.log("Memo archive contract checks passed.");
