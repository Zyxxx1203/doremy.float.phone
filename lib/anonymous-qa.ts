"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";

export type AnonymousQaQuestion = {
    id: string;
    askerType: "user" | "character";
    askerId: string;
    askerAlias: string;
    targetType: "user" | "character";
    targetId: string;
    question: string;
    answer?: string;
    audience: "public" | "target";
    status: "pending" | "answered";
    revealIdentity: boolean;
    createdAt: number;
    answeredAt?: number;
};

const KEY = "ai_phone_anonymous_qa_v1";
registerKvMigration(KEY);
const MAX_QUESTIONS = 500;
const ALIASES = ["匿名的小猫", "路过的云", "不署名的人", "夜里的风", "一个问号", "隔壁的星星", "纸飞机", "没有名字的花"];

function uid(): string { return `aq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function load(): AnonymousQaQuestion[] {
    try {
        const raw = kvGet(KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : [];
        return Array.isArray(parsed) ? parsed as AnonymousQaQuestion[] : [];
    } catch { return []; }
}
function save(rows: AnonymousQaQuestion[]): void {
    kvSet(KEY, JSON.stringify(rows.slice(-MAX_QUESTIONS)));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("anonymous-qa-updated", { detail: rows.slice(-MAX_QUESTIONS) }));
}
function alias(): string { return ALIASES[Math.floor(Math.random() * ALIASES.length)] + "·" + Math.random().toString(36).slice(2, 5); }

export function loadAnonymousQa(): AnonymousQaQuestion[] {
    return load().slice().sort((a, b) => b.createdAt - a.createdAt);
}
export function loadPublicAnonymousQa(): AnonymousQaQuestion[] {
    return loadAnonymousQa();
}
export function askAnonymousQuestion(input: {
    askerType: "user" | "character";
    askerId: string;
    targetType: "user" | "character";
    targetId: string;
    question: string;
    audience?: "public" | "target";
    revealIdentity?: boolean;
}): AnonymousQaQuestion {
    const question = String(input.question || "").trim();
    if (!question) throw new Error("问题不能为空");
    const rows = load();
    const row: AnonymousQaQuestion = {
        id: uid(),
        askerType: input.askerType,
        askerId: input.askerId,
        askerAlias: alias(),
        targetType: input.targetType,
        targetId: input.targetId,
        question: question.slice(0, 500),
        audience: "public",
        status: "pending",
        revealIdentity: false,
        createdAt: Date.now(),
    };
    rows.push(row);
    save(rows);
    return row;
}
export function answerAnonymousQuestion(questionId: string, answer: string, expectedTarget?: { targetType: "user" | "character"; targetId: string }): AnonymousQaQuestion | null {
    const rows = load();
    const row = rows.find(q => q.id === questionId);
    if (!row) return null;
    if (expectedTarget && (row.targetType !== expectedTarget.targetType || row.targetId !== expectedTarget.targetId)) return null;
    row.answer = String(answer || "").trim().slice(0, 1000);
    row.status = row.answer ? "answered" : "pending";
    row.answeredAt = row.answer ? Date.now() : undefined;
    save(rows);
    return row;
}
export function questionsForTarget(targetType: "user" | "character", targetId: string): AnonymousQaQuestion[] {
    return loadAnonymousQa().filter(q => q.targetType === targetType && q.targetId === targetId);
}
/** 将共享匿名提问箱中的问题和回答注入每位角色上下文；提问者真实身份不进入提示词。 */
export function buildAnonymousQaContext(characterId?: string): string {
    if (!characterId) return "";
    const all = loadPublicAnonymousQa().slice(0, 40);
    if (!all.length) return "";
    const pendingForMe = all.filter(q => q.targetType === "character" && q.targetId === characterId && q.status === "pending");
    const answeredForMe = all.filter(q => q.targetType === "character" && q.targetId === characterId && q.status === "answered");
    const parts = [
        "【匿名提问箱·所有角色共享】以下问题与回答对所有角色可见。提问者身份始终隐藏，每封问题只显示本次随机匿名代号。",
        ...all.map(q => `- [${q.status === "answered" ? "已回答" : "待回答"}] ${q.askerAlias} → ${q.targetType === "user" ? "用户" : (loadCharacters().find(c => c.id === q.targetId)?.name || "某位角色")}：${q.question}${q.answer ? `\n  回答：${q.answer}` : ""}${q.targetType === "character" && q.targetId === characterId && q.status === "pending" ? `（questionId=${q.id}；这是问你的问题，你可以使用「回答匿名提问」回复）` : ""}`),
    ];
    if (pendingForMe.length) parts.push("其中标记为问你的待回答问题，可以由你回答；其他问题只供围观和了解，不要冒充收件人回答。");
    if (answeredForMe.length) parts.push("你之前回答过的问题及其回答也在共享列表中。");
    parts.push("不要尝试猜测、追查或透露匿名提问者的真实身份。");
    return parts.join("\n");
}
