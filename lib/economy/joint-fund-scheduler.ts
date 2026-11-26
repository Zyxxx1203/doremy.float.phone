"use client";

import { bgSetInterval } from "@/lib/bg-timer";
import { sendBrowserNotification } from "@/lib/browser-notification";
import { sendShellNotification } from "@/lib/shell-notify";
import { formatWalletAmount } from "@/lib/wallet-storage";
import {
    loadJointFundPlans,
    loadJointFunds,
    markJointFundPlanReminded,
    runDueJointFundPlans,
} from "./joint-fund";

const CHECK_INTERVAL_MS = 60_000;
const REMIND_LEAD_MS = 12 * 60 * 60_000;
const MAX_REMINDERS_PER_TICK = 3;

let activeStop: (() => void) | null = null;

function sendNotice(title: string, body: string, kind: "success" | "error" | "info"): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message: body } }));
    if (typeof document === "undefined" || !document.hidden) return;
    if (!sendShellNotification(`小金库 · ${title}`, body)) {
        sendBrowserNotification(`小金库 · ${title}`, { body });
    }
}

function formatLead(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    return `${hours} 小时`;
}

/**
 * 小金库调度器：App 存活期间每分钟检查到期计划，并在到期前 12 小时提醒。
 *
 * WebView 被系统冻结时无法保证准点执行，所以这里同时依赖：
 *  - 启动/回到前台时补跑到期计划（catch-up）；
 *  - 保存计划时 nextRunAt 已写好，用户下次打开 App 仍会补上。
 * 真正需要「杀进程也准点」的场景应交给原生闹钟；本调度器不伪装成那层保证。
 */
export function runJointFundSchedulerTick(now = Date.now()): void {
    const results = runDueJointFundPlans(now);
    for (const result of results) {
        if (result.ok) {
            sendNotice(
                "自动存入",
                `「${result.fundName}」已自动存入 ${formatWalletAmount(result.amount)}（${result.memberType === "user" ? "你" : "TA"}）。`,
                "success",
            );
        } else {
            sendNotice(
                "自动存入失败",
                `「${result.fundName}」定时存入失败：${result.error || "余额不足"}。明天会自动重试。`,
                "error",
            );
        }
    }

    const plans = loadJointFundPlans().filter(plan => (
        plan.enabled
        && plan.nextRunAt > now
        && plan.nextRunAt - now <= REMIND_LEAD_MS
        && plan.remindedForRunAt !== plan.nextRunAt
    ));
    if (plans.length === 0) return;

    const funds = new Map(loadJointFunds().map(fund => [fund.id, fund]));
    let sent = 0;
    for (const plan of plans) {
        if (sent >= MAX_REMINDERS_PER_TICK) break;
        const fund = funds.get(plan.fundId);
        if (!fund) continue;
        markJointFundPlanReminded(plan.id, plan.nextRunAt);
        sendNotice(
            "即将自动存入",
            `「${fund.name}」将在 ${formatLead(plan.nextRunAt - now)}后自动存入 ${formatWalletAmount(plan.amount)}（${plan.memberType === "user" ? "你" : "TA"}），记得留足余额。`,
            "info",
        );
        sent += 1;
    }
}

export function startJointFundScheduler(): () => void {
    if (typeof window === "undefined") return () => {};
    if (activeStop) return activeStop;

    const tick = () => {
        try {
            runJointFundSchedulerTick();
        } catch (error) {
            console.warn("[JointFund] scheduler tick failed:", error);
        }
    };
    tick();

    const stopTimer = bgSetInterval(tick, CHECK_INTERVAL_MS);
    const handleVisibility = () => {
        if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", tick);

    const stop = () => {
        stopTimer();
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener("pageshow", tick);
        if (activeStop === stop) activeStop = null;
    };
    activeStop = stop;
    return stop;
}

export function stopJointFundScheduler(): void {
    activeStop?.();
}
