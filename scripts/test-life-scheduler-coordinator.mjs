import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-scheduler-coordinator.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const values = new Map();
const localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
const moduleBox = { exports: {} };
const sandbox = { module: moduleBox, exports: moduleBox.exports, window: {}, localStorage, Date, Math, console };
vm.runInNewContext(compiled, sandbox, { filename: "life-scheduler-coordinator.cjs" });
const { LIFE_SCENE_FOREGROUND_LEASE_KEY, setLifeSceneForegroundLease, readLifeSceneForegroundLease } = moduleBox.exports;

setLifeSceneForegroundLease("scene-a", true);
assert.equal(readLifeSceneForegroundLease().sceneId, "scene-a", "visible scene should own the lease");
setLifeSceneForegroundLease("scene-b", false);
assert.equal(readLifeSceneForegroundLease().sceneId, "scene-a", "a different scene must not clear the current lease");
assert.ok(values.has(LIFE_SCENE_FOREGROUND_LEASE_KEY));
setLifeSceneForegroundLease("scene-a", false);
assert.equal(readLifeSceneForegroundLease(), null, "the owning scene should be able to release its lease");
setLifeSceneForegroundLease("scene-a", true);
assert.equal(readLifeSceneForegroundLease(Date.now() + 121_000), null, "an expired lease must not block offline jobs");

console.log("Life scheduler coordinator tests passed.");
