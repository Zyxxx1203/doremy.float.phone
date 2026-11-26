#!/usr/bin/env node
/* 小金库计划 & 调度器逻辑冒烟测试
 *
 * 直接把 TS 源码用 typescript.transpileModule 转成 CommonJS，在受控的
 * kv/wallet/character 桩里跑，重点验证：
 *   1. 到期计划真的加进小金库余额和流水（旧实现用循环开始时的快照回写，
 *      会把 depositToJointFund 刚写入的余额/流水覆盖掉）；
 *   2. 用户/角色两种扣款路径；
 *   3. 扣款失败时第二天重试，不丢计划；
 *   4. 到期前提醒只发一次，下一期重新提醒。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadTs(rel, mocks, globals = {}) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`unexpected require: ${id}`);
  };
  const names = ["require", "module", "exports", "window", "document", "CustomEvent"];
  const values = [require, module, module.exports, globals.window, globals.document, globals.CustomEvent];
  new Function(...names, js)(...values);
  return module.exports;
}

let pass = 0;
let fail = 0;
function T(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

const store = new Map();
const kv = {
  kvGet: (key) => (store.has(key) ? store.get(key) : null),
  kvSet: (key, value) => { store.set(key, value); },
  registerKvMigration: () => {},
};
const wallet = { balance: 1000 };
const ledger = {};
const walletMock = {
  formatWalletAmount: (amount) => `¥${Number(amount).toFixed(2)}`,
  payWithWalletAccount: (input) => {
    if (wallet.balance < input.amount) return { ok: false, error: "余额不足", state: {} };
    wallet.balance = Math.round((wallet.balance - input.amount) * 100) / 100;
    return { ok: true, state: {}, transaction: { id: `wtx_${Date.now()}`, createdAt: new Date().toISOString() } };
  },
};
const ledgerMock = {
  characterSpend: (characterId, amount) => {
    const balance = ledger[characterId] ?? 1000;
    if (balance < amount) throw new Error("角色余额不足");
    ledger[characterId] = Math.round((balance - amount) * 100) / 100;
    return { characterId, balance: ledger[characterId], transactions: [{ id: `ctx_${Date.now()}` }] };
  },
};

const events = [];
const windowMock = {
  dispatchEvent: (event) => { events.push(event); return true; },
};
const documentMock = { hidden: false };
const CustomEventMock = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
};

const jointFund = loadTs("lib/economy/joint-fund.ts", {
  "@/lib/kv-db": kv,
  "@/lib/wallet-storage": walletMock,
  "./character-ledger": ledgerMock,
}, { window: windowMock, document: documentMock, CustomEvent: CustomEventMock });

console.log("== 1. 用户计划到期：余额 + 流水都要落库 ==");
const fund = jointFund.createJointFund({ name: "旅行基金", goalLabel: "机票", goalAmount: 2000, userId: "u1", characterId: "c1" });
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "u1", cadence: "weekly", amount: 100 });
let raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans[0].nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
let results = jointFund.runDueJointFundPlans();
let state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("计划执行成功", results.length === 1 && results[0].ok === true, JSON.stringify(results[0]));
T("小金库余额到账", state.funds[0].balance === 100, `balance=${state.funds[0].balance}`);
T("流水已写入", state.transactions.length === 1 && state.transactions[0].kind === "deposit", `tx=${state.transactions.length}`);
T("用户钱包扣款", wallet.balance === 900, `wallet=${wallet.balance}`);
T("下一期已推进", state.plans[0].nextRunAt > Date.now() + 6 * 86400000, new Date(state.plans[0].nextRunAt).toISOString());

console.log("== 2. 角色计划扣角色账本 ==");
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "character", memberId: "c1", cadence: "weekly", amount: 50 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.find((plan) => plan.memberType === "character").nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
results = jointFund.runDueJointFundPlans();
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("角色计划执行成功", results.length === 1 && results[0].ok === true, JSON.stringify(results[0]));
T("小金库余额累加", state.funds[0].balance === 150, `balance=${state.funds[0].balance}`);
T("角色账本扣款", ledger.c1 === 950, `character=${ledger.c1}`);

console.log("== 3. 扣款失败不吞计划 ==");
wallet.balance = 0;
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "u1", cadence: "monthly", amount: 80 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
const failedPlan = raw.plans.find((plan) => plan.memberType === "user");
failedPlan.nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
results = jointFund.runDueJointFundPlans();
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
const retryPlan = state.plans.find((plan) => plan.memberType === "user");
T("失败结果可上报", results.length === 1 && results[0].ok === false, results[0]?.error);
T("余额未被改动", state.funds[0].balance === 150, `balance=${state.funds[0].balance}`);
T("失败计划改为次日重试", retryPlan.nextRunAt > Date.now() + 23 * 3600000, new Date(retryPlan.nextRunAt).toISOString());

console.log("== 4. 到期提醒只发一次 ==");
wallet.balance = 1000;
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "u1", cadence: "monthly", amount: 20 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.forEach((plan) => { if (plan.memberType === "user") plan.nextRunAt = Date.now() + 3600000; });
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
const shellNotices = [];
const scheduler = loadTs("lib/economy/joint-fund-scheduler.ts", {
  "@/lib/bg-timer": { bgSetInterval: () => () => {} },
  "@/lib/browser-notification": { sendBrowserNotification: () => {} },
  "@/lib/shell-notify": { sendShellNotification: () => true },
  "@/lib/wallet-storage": walletMock,
  "./joint-fund": jointFund,
}, { window: windowMock, document: { hidden: true }, CustomEvent: CustomEventMock });
// 重置提醒状态，让本测试从干净的“未提醒”开始。
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.forEach((plan) => { delete plan.remindedForRunAt; });
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
scheduler.runJointFundSchedulerTick();
const afterFirst = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("第一期提醒已标记", afterFirst.plans.some((plan) => plan.remindedForRunAt === plan.nextRunAt));
const firstReminderEvents = events.filter((event) => event.type === "app-global-notice" && String(event.detail?.message || "").includes("自动存入"));
T("发出提醒横幅", firstReminderEvents.length >= 1, `count=${firstReminderEvents.length}`);
const beforeSecond = events.length;
scheduler.runJointFundSchedulerTick();
const secondReminderEvents = events.slice(beforeSecond).filter((event) => event.type === "app-global-notice" && String(event.detail?.message || "").includes("自动存入"));
T("同一期不重复提醒", secondReminderEvents.length === 0, `count=${secondReminderEvents.length}`);

console.log(`\n${fail === 0 ? "✅" : "❌"} 小金库逻辑测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
