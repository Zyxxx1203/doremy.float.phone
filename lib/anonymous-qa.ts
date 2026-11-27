"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import { createOrGetSession, pushChatMessage } from "@/lib/chat-storage";

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

    const characters = loadCharacters();
    const askerId = String(input.askerId || "").trim();
    if (input.askerType === "character" && !characters.some(character => character.id === askerId)) {
        throw new Error("无法识别提问角色，请使用有效的角色 ID");
    }
    if (input.askerType === "user" && askerId !== "user") {
        throw new Error("用户提问者 ID 无效");
    }

    let targetId = String(input.targetId || "").trim();
    if (input.targetType === "user") {
        targetId = "user";
    } else {
        if (!targetId) throw new Error("问角色时必须提供收件角色 ID");
        let target = characters.find(character => character.id === targetId);
        if (!target) {
            const matches = characters.filter(character => character.name.trim() === targetId);
            if (matches.length === 1) {
                target = matches[0];
                targetId = target.id;
            } else if (matches.length > 1) {
                throw new Error("收件角色名称重复，请改用唯一角色 ID");
            }
        }
        if (!target) throw new Error("无法识别收件角色，请检查角色 ID 或名称");
        if (input.askerType === "character" && targetId === askerId) {
            throw new Error("角色不能向自己提问，请选择另一位角色");
        }
    }

    const rows = load();
    const row: AnonymousQaQuestion = {
        id: uid(),
        askerType: input.askerType,
        askerId,
        askerAlias: alias(),
        targetType: input.targetType,
        targetId,
        question: question.slice(0, 500),
        audience: "public",
        status: "pending",
        revealIdentity: false,
        createdAt: Date.now(),
    };
    rows.push(row);
    save(rows);
    if (row.targetType === "character") {
        const target = characters.find(character => character.id === row.targetId);
        if (target) {
            const session = createOrGetSession(target.id);
            pushChatMessage({
                id: `anonymous_qa_${row.id}`,
                sessionId: session.id,
                role: "system",
                mediaType: "system_instruction",
                content: `匿名提问箱有一条新问题。\n${row.askerAlias} 留给你的问题：${row.question}\n你是这条问题的指定回答对象，可以在匿名提问箱中作答。提问者身份对你保密，不要猜测或追查。`,
                mediaData: { compactSystemInstruction: true, shortTermMemoryEvent: true },
            });
        }
    }
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

export function updateAnonymousQuestion(questionId: string, input: {
    question?: string;
    answer?: string;
    targetType?: "user" | "character";
    targetId?: string;
}): AnonymousQaQuestion | null {
    const rows = load();
    const row = rows.find(item => item.id === questionId);
    if (!row) return null;
    const nextQuestion = input.question === undefined ? row.question : String(input.question).trim();
    if (!nextQuestion) throw new Error("问题不能为空");
    if (input.targetType === "character") {
        const targetId = String(input.targetId || "").trim();
        if (!loadCharacters().some(character => character.id === targetId)) throw new Error("请选择有效的回答角色");
        row.targetType = "character";
        row.targetId = targetId;
    } else if (input.targetType === "user") {
        row.targetType = "user";
        row.targetId = "user";
    } else if (input.targetId !== undefined) {
        throw new Error("回答对象类型无效");
    }
    row.question = nextQuestion.slice(0, 500);
    if (input.answer !== undefined) {
        row.answer = String(input.answer).trim().slice(0, 1000) || undefined;
        row.status = row.answer ? "answered" : "pending";
        row.answeredAt = row.answer ? Date.now() : undefined;
    }
    save(rows);
    return row;
}

export function deleteAnonymousQuestion(questionId: string): boolean {
    const rows = load();
    const next = rows.filter(item => item.id !== questionId);
    if (next.length === rows.length) return false;
    save(next);
    return true;
}
