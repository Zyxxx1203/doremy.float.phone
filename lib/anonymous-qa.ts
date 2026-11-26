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
    return loadAnonymousQa().filter(q => q.audience === "public");
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
        audience: input.audience || "public",
        status: "pending",
        revealIdentity: input.revealIdentity === true,
        createdAt: Date.now(),
    };
    rows.push(row);
    save(rows);
    return row;
}
export function answerAnonymousQuestion(questionId: string, answer: string): AnonymousQaQuestion | null {
    const rows = load();
    const row = rows.find(q => q.id === questionId);
    if (!row) return null;
    row.answer = String(answer || "").trim().slice(0, 1000);
    row.status = row.answer ? "answered" : "pending";
    row.answeredAt = row.answer ? Date.now() : undefined;
    save(rows);
    return row;
}
export function questionsForTarget(targetType: "user" | "character", targetId: string): AnonymousQaQuestion[] {
    return loadAnonymousQa().filter(q => q.targetType === targetType && q.targetId === targetId);
}
/** 公共问答进共同记忆：公开待答和已答都注入，且永远不带 askerId；角色自己的待答/追问只给该角色看。 */
export function buildAnonymousQaContext(characterId?: string): string {
    const all = loadAnonymousQa();
    const characterName = (id: string) => loadCharacters().find(c => c.id === id)?.name || "某个角色";
    const targetName = (q: AnonymousQaQuestion) => q.targetType === "character" ? characterName(q.targetId) : "用户";
    const pending = characterId
        ? all.filter(q => q.targetType === "character" && q.targetId === characterId && q.status === "pending").slice(0, 5)
        : [];
    const publicPending = all.filter(q => q.audience === "public" && q.status === "pending").slice(0, 6);
    const publicAnswered = all.filter(q => q.audience === "public" && q.status === "answered").slice(0, 10);
    const asked = characterId
        ? all.filter(q => q.askerType === "character" && q.askerId === characterId).slice(0, 5)
        : [];
    if (!pending.length && !publicPending.length && !publicAnswered.length && !asked.length) return "";
    const parts: string[] = [];
    if (pending.length) {
        parts.push([
            "【匿名提问箱·等你回答】",
            ...pending.map(q => `- ${q.askerAlias} 问：${q.question}（questionId=${q.id}；想回答就用「回答匿名提问」）`),
            "提问者身份不会暴露；不要猜是谁。",
        ].join("\n"));
    }
    if (publicPending.length) {
        parts.push([
            "【公共匿名提问箱·待回答】",
            ...publicPending.map(q => `- ${q.askerAlias} 问 ${targetName(q)}：${q.question}${q.targetType === "character" && q.targetId === characterId ? `（questionId=${q.id}，这是问你的，可以用「回答匿名提问」）` : "（不是问你的，不要替别人回答）"}`),
        ].join("\n"));
    }
    if (publicAnswered.length) {
        const lines = publicAnswered.map(q => `- ${q.askerAlias} 问 ${targetName(q)}：${q.question}\n  ${targetName(q)} 答：${q.answer || ""}`);
        parts.push(`【公共匿名提问箱】\n${lines.join("\n")}`);
    }
    if (asked.length) {
        parts.push([
            "【你匿名提过的问题】",
            ...asked.map(q => `- 你问 ${targetName(q)}：${q.question} → ${q.status === "answered" ? (q.answer || "（已回答）") : "（还在等回答）"}`),
            "这些回答已经回到提问箱；用户或其他角色不知道提问者是你，除非你主动说。",
        ].join("\n"));
    }
    return parts.join("\n\n");
}
