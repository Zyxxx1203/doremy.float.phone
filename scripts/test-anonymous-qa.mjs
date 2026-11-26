#!/usr/bin/env node
/* 匿名提问箱上下文冒烟测试：公开待答/已答、目标角色待答、提问者追问都要进 prompt。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(ROOT, "lib/anonymous-qa.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const store = new Map();
const kv = {
  kvGet: key => (store.has(key) ? store.get(key) : null),
  kvSet: (key, value) => { store.set(key, value); },
  registerKvMigration: () => {},
};
const characters = [{ id: "c1", name: "小林" }, { id: "c2", name: "顾总" }];
const module = { exports: {} };
const require = (id) => {
  if (id === "@/lib/kv-db") return kv;
  if (id === "@/lib/character-storage") return { loadCharacters: () => characters };
  throw new Error(`unexpected require: ${id}`);
};
const windowMock = { dispatchEvent: () => true };
const documentMock = {};
const CustomEventMock = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
new Function("require", "module", "exports", "window", "document", "CustomEvent", js)(
  require, module, module.exports, windowMock, documentMock, CustomEventMock,
);
const qa = module.exports;

let pass = 0;
let fail = 0;
function T(name, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ""}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ""}`); }
}

console.log("== 1. 用户公开提问后，目标角色能立刻看到 ==");
const q1 = qa.askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "character", targetId: "c1", question: "你最近是不是在躲我？", audience: "public" });
let ctx = qa.buildAnonymousQaContext("c1");
T("公开待答进入公共区", ctx.includes("公共匿名提问箱·待回答") && ctx.includes("你最近是不是在躲我"));
T("目标角色收到待回答", ctx.includes("等你回答") && ctx.includes(q1.id));
T("不带提问者 id", !ctx.includes("askerId") && !ctx.includes("\"user\""));
T("另一角色看到公共待答但不替答", qa.buildAnonymousQaContext("c2").includes("不是问你的"));

console.log("== 2. 回答后进入公共记忆，提问者能看到回答 ==");
qa.answerAnonymousQuestion(q1.id, "没有躲你，只是这两天在赶项目。");
ctx = qa.buildAnonymousQaContext("c1");
T("公共已答进入上下文", ctx.includes("公共匿名提问箱") && ctx.includes("赶项目"));
const q2 = qa.askAnonymousQuestion({ askerType: "character", askerId: "c2", targetType: "user", targetId: "user", question: "今晚想吃什么？", audience: "public" });
qa.answerAnonymousQuestion(q2.id, "想吃火锅。");
const askerCtx = qa.buildAnonymousQaContext("c2");
T("提问者能看到自己问题的回答", askerCtx.includes("你匿名提过的问题") && askerCtx.includes("想吃火锅"));

console.log("== 3. 公共 feed 包含待答，不是只显示已答 ==");
qa.askAnonymousQuestion({ askerType: "user", askerId: "user", targetType: "character", targetId: "c1", question: "周末有空吗？", audience: "public" });
const publicRows = qa.loadPublicAnonymousQa();
T("公开 feed 有三条", publicRows.length === 3, `count=${publicRows.length}`);
T("待答也在 feed 里", publicRows.some(row => row.status === "pending"));

console.log(`\n${fail === 0 ? "✅" : "❌"} 匿名提问箱上下文测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
