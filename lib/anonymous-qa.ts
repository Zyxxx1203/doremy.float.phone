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
        audience: input.audience || "target",
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
    if (!characterId) return "";
    const all = loadAnonymousQa();
    const pending = all.filter(q =>
        q.targetType === "character" && q.targetId === characterId && q.status === "pending"
    ).slice(0, 8);
    const answered = all.filter(q =>
        q.targetType === "character" && q.targetId === characterId && q.status === "answered"
    ).slice(0, 8);
    const asked = all.filter(q =>
        q.askerType === "character" && q.askerId === characterId
    ).slice(0, 8);
    if (!pending.length && !answered.length && !asked.length) return "";
    const parts: string[] = [];
    if (pending.length) parts.push([
        "【匿名来信·只寄给你】",
        ...pending.map(q => `- ${q.askerAlias} 留言：${q.question}（questionId=${q.id}；如愿意回答，使用「回答匿名提问」）`),
        "每封信的匿名身份仅对本次投递有效。不要猜测或追查提问者真实身份。不要把信件内容转述给其他角色。",
    ].join("\n"));
    if (answered.length) parts.push([
        "【你已经回复的匿名来信】",
        ...answered.map(q => `- ${q.askerAlias}：${q.question}\n  你的回答：${q.answer || ""}`),
    ].join("\n"));
    if (asked.length) parts.push([
        "【你寄出的匿名信】",
        ...asked.map(q => `- 你曾匿名向 ${q.targetType === "user" ? "用户" : "另一位角色"} 提问：${q.question} → ${q.status === "answered" ? (q.answer || "（已回复）") : "（等待回复）"}`),
        "你寄出的信件不会向收件人暴露你的角色身份。",
    ].join("\n"));
    return parts.join("\n\n");
}
