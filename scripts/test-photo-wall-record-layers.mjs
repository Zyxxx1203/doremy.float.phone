import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/photo-wall-storage.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox,
  exports: moduleBox.exports,
  require: id => {
    if (id === "@/lib/kv-db") return { kvGet: () => null, kvSet: () => undefined, registerKvMigration: () => undefined };
    throw new Error("unexpected require: " + id);
  },
  console, JSON, Set, Map, Array, String, Number, Boolean, RegExp, Date, Math,
}, { filename: "photo-wall-storage.cjs" });
const { normalizePhotoWallCreationRecords } = moduleBox.exports;
const doodle = { id: "d1", kind: "sticker", content: "♡", color: "#c2705a", width: 4, points: [{ x: 0.25, y: 0.4 }], createdAt: "2026-11-05T08:00:00.000Z" };
const records = normalizePhotoWallCreationRecords([
  { id: "legacy", createdAt: "2026-11-04T08:00:00.000Z", authorType: "user", authorName: "我", narrative: "旧记录", photoIds: ["photo-1"], doodles: [doodle] },
  { id: "layered", createdAt: "2026-11-05T08:00:00.000Z", authorType: "character", authorId: "char-a", authorName: "小满", narrative: "在照片正面留下贴纸", photoIds: ["photo-1"], layers: [{ kind: "photo", photoId: "photo-1", side: "front", doodles: [doodle] }], doodles: [doodle] },
  { id: "photo-only", createdAt: "2026-11-05T08:01:00.000Z", authorType: "user", authorName: "我", narrative: "上传照片", photoIds: ["photo-2"], layers: [], doodles: [] },
]);
assert.equal(records.length, 3, "legacy, layered and photo-only creation records must all survive normalization");
assert.equal(records[0].layers, undefined, "legacy records must not receive invented photo mappings");
assert.equal(records[1].layers[0].photoId, "photo-1");
assert.equal(records[1].layers[0].side, "front");
assert.equal(records[2].doodles.length, 0, "photo-only creation records are valid");
assert.deepEqual([...records[2].photoIds], ["photo-2"]);
console.log("Photo Wall creation-layer normalization tests passed.");
