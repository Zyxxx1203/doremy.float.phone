"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { payWithWalletAccount } from "@/lib/wallet-storage";
import { characterSpend } from "./character-ledger";

export type JointFundMemberType = "user" | "character";

export type JointFundTransaction = {
    id: string;
    fundId: string;
    at: number;
    memberType: JointFundMemberType;
    memberId: string;
    kind: "deposit" | "withdraw" | "adjust";
    amount: number;
    note: string;
    balanceAfter: number;
};

export type JointFundPlan = {
    id: string;
    fundId: string;
    memberType: JointFundMemberType;
    memberId: string;
    cadence: "daily" | "weekly" | "monthly";
    amount: number;
    nextRunAt: number;
    enabled: boolean;
    /** 最近一次已提醒的 nextRunAt；用于避免同一期重复弹提醒。 */
    remindedForRunAt?: number;
};

export type JointFundPlanRunResult = {
    planId: string;
    fundId: string;
    fundName: string;
    memberType: JointFundMemberType;
    amount: number;
    ok: boolean;
    error?: string;
};

export type JointFund = {
    id: string;
    name: string;
    goalLabel: string;
    goalAmount: number;
    balance: number;
    userId: string;
    characterId: string;
    status: "active" | "completed" | "paused";
    createdAt: number;
    updatedAt: number;
};

type JointFundState = { funds: JointFund[]; transactions: JointFundTransaction[]; plans: JointFundPlan[] };
const KEY = "ai_phone_joint_funds_v1";
registerKvMigration(KEY);
export const JOINT_FUND_UPDATED_EVENT = "joint-fund-updated";
const MAX_TX = 1000;

function uid(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function money(value: number): number { return Math.round(value * 100) / 100; }
function load(): JointFundState {
    try {
        const raw = kvGet(KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<JointFundState> : {};
        return {
            funds: Array.isArray(parsed.funds) ? parsed.funds : [],
            transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
            plans: Array.isArray(parsed.plans) ? parsed.plans : [],
        };
    } catch { return { funds: [], transactions: [], plans: [] }; }
}
function save(state: JointFundState): void {
    kvSet(KEY, JSON.stringify({ ...state, transactions: state.transactions.slice(0, MAX_TX) }));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(JOINT_FUND_UPDATED_EVENT, { detail: state }));
}

export function loadJointFunds(): JointFund[] { return load().funds.slice().sort((a, b) => b.createdAt - a.createdAt); }
export function loadJointFundTransactions(fundId?: string): JointFundTransaction[] {
    const rows = load().transactions;
    return (fundId ? rows.filter(t => t.fundId === fundId) : rows).slice().sort((a, b) => b.at - a.at);
}
export function loadJointFundPlans(fundId?: string): JointFundPlan[] {
    const rows = load().plans;
    return (fundId ? rows.filter(p => p.fundId === fundId) : rows).slice().sort((a, b) => a.nextRunAt - b.nextRunAt);
}
export function createJointFund(input: { name: string; goalLabel?: string; goalAmount: number; userId: string; characterId: string }): JointFund {
    const state = load();
    const fund: JointFund = {
        id: uid("jf"),
        name: String(input.name || "共同小金库").slice(0, 40),
        goalLabel: String(input.goalLabel || "目标").slice(0, 40),
        goalAmount: Math.max(1, money(input.goalAmount)),
        balance: 0,
        userId: input.userId, characterId: input.characterId,
        status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.funds.push(fund);
    save(state);
    return fund;
}
export function depositToJointFund(fundId: string, memberType: JointFundMemberType, memberId: string, amount: number, note: string): { ok: boolean; fund?: JointFund; error?: string } {
    const state = load();
    const fund = state.funds.find(f => f.id === fundId);
    if (!fund) return { ok: false, error: "找不到小金库" };
    if (fund.status === "paused") return { ok: false, error: "小金库已暂停" };
    const value = money(amount);
    if (value <= 0) return { ok: false, error: "金额无效" };
    if (memberType === "user") {
        const paid = payWithWalletAccount({ amount: value, title: `存入「${fund.name}」`, detail: note || "共同小金库存入", category: "小金库" });
        if (!paid.ok) return { ok: false, error: paid.error || "用户余额不足" };
    } else {
        try { characterSpend(memberId, value, "小金库", note || "共同小金库存入", fund.id); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : "角色余额不足" }; }
    }
    fund.balance = money(fund.balance + value);
    fund.updatedAt = Date.now();
    if (fund.balance >= fund.goalAmount) fund.status = "completed";
    state.transactions.unshift({ id: uid("jft"), fundId, at: Date.now(), memberType, memberId, kind: "deposit", amount: value, note: String(note || "").slice(0, 200), balanceAfter: fund.balance });
    save(state);
    return { ok: true, fund };
}
export function withdrawFromJointFund(fundId: string, memberType: JointFundMemberType, memberId: string, amount: number, note: string): { ok: boolean; fund?: JointFund; error?: string } {
    const state = load();
    const fund = state.funds.find(f => f.id === fundId);
    if (!fund) return { ok: false, error: "找不到小金库" };
    const value = money(amount);
    if (value <= 0 || value > fund.balance) return { ok: false, error: "取出金额无效或超过余额" };
    fund.balance = money(fund.balance - value);
    fund.status = "active";
    fund.updatedAt = Date.now();
    state.transactions.unshift({ id: uid("jft"), fundId, at: Date.now(), memberType, memberId, kind: "withdraw", amount: value, note: String(note || "").slice(0, 200), balanceAfter: fund.balance });
    save(state);
    return { ok: true, fund };
}
export function setJointFundPlan(input: { fundId: string; memberType: JointFundMemberType; memberId: string; cadence: "daily" | "weekly" | "monthly"; amount: number }): JointFundPlan | null {
    // 用户界面只能为自己建立自动存款计划；角色身份的存款只能由角色自己的动作触发。
    if (input.memberType === "user" && input.memberId !== "user") return null;
    if (input.memberType === "character" && !input.memberId) return null;
    const state = load();
    const fund = state.funds.find(f => f.id === input.fundId);
    if (!fund) return null;
    const now = Date.now();
    const nextRunAt = advanceJointFundRunAt(now, input.cadence);
    const plan: JointFundPlan = {
        id: uid("jfp"), fundId: input.fundId, memberType: input.memberType, memberId: input.memberId,
        cadence: input.cadence, amount: Math.max(0.01, money(input.amount)), nextRunAt, enabled: true,
    };
    state.plans = state.plans.filter(p => !(p.fundId === input.fundId && p.memberType === input.memberType && p.memberId === input.memberId));
    state.plans.push(plan);
    save(state);
    return plan;
}
export function removeJointFundPlan(planId: string): void {
    const state = load();
    state.plans = state.plans.filter(p => p.id !== planId);
    save(state);
}
export function advanceJointFundRunAt(from: number, cadence: JointFundPlan["cadence"]): number {
    return cadence === "daily" ? from + 86400000 : cadence === "weekly" ? from + 7 * 86400000 : from + 30 * 86400000;
}
/** 记录某一期已经提醒过，避免调度器每分钟重复弹。 */
export function markJointFundPlanReminded(planId: string, runAt: number): void {
    const state = load();
    const plan = state.plans.find(p => p.id === planId);
    if (!plan || plan.nextRunAt !== runAt || plan.remindedForRunAt === runAt) return;
    plan.remindedForRunAt = runAt;
    save(state);
}
/**
 * 执行所有到期计划，返回每个计划的结果。
 *
 * 注意：这里不能拿循环开始时的整份快照最后统一 save——depositToJointFund 会自己
 * load/save 并写入余额和流水，用旧快照回写会把刚存入的钱和流水一起抹掉。
 * 每笔之后重新 load，只更新该计划的 nextRunAt。
 */
export function runDueJointFundPlans(now = Date.now()): JointFundPlanRunResult[] {
    const results: JointFundPlanRunResult[] = [];
    const duePlans = load().plans.filter(plan => plan.enabled && plan.nextRunAt <= now);
    for (const plan of duePlans) {
        const fundBefore = load().funds.find(f => f.id === plan.fundId);
        if (!fundBefore) continue;
        const result = depositToJointFund(plan.fundId, plan.memberType, plan.memberId, plan.amount, "定时存入");
        // 失败（余额不足等）第二天重试，不要把整期直接跳过去。
        const nextRunAt = result.ok ? advanceJointFundRunAt(now, plan.cadence) : now + 86400000;
        const state = load();
        const current = state.plans.find(p => p.id === plan.id);
        if (current) {
            current.nextRunAt = nextRunAt;
            current.remindedForRunAt = undefined;
            save(state);
        }
        results.push({
            planId: plan.id,
            fundId: plan.fundId,
            fundName: fundBefore.name,
            memberType: plan.memberType,
            amount: plan.amount,
            ok: result.ok,
            error: result.error,
        });
    }
    return results;
}
