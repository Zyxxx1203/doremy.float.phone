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
    kvSet(KEY, JSON.stringify(rows));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("anonymous-qa-updated", { detail: rows }));
}
function alias(): string { return ALIASES[Math.floor(Math.random() * ALIASES.length)] + "·" + Math.random().toString(36).slice(2, 5); }

function appendAnonymousQaTimelineEvent(
    row: AnonymousQaQuestion,
    kind: "question" | "answer" | "updated" | "deleted",
): void {
    const characters = loadCharacters();
    const targetName = row.targetType === "user"
        ? "用户"
        : characters.find(character => character.id === row.targetId)?.name || "某位角色";
    for (const character of characters) {
        const isRecipient = row.targetType === "character" && row.targetId === character.id;
        const content = kind === "question"
            ? `匿名提问箱新增公开问题。\n问题编号：${row.id}\n${row.askerAlias} 向${targetName} 提问：${row.question}\n${isRecipient ? "这是问你的问题，你可以使用“回答匿名提问”工具作答。" : row.targetType === "character" ? `指定回答对象是${targetName}，你可以围观，但不要代替 TA 回答。` : "这是一条公开问题，你可以在匿名提问箱查看。"} 提问者身份对所有人保密，不要猜测或追查。`
            : kind === "answer"
                ? `匿名提问箱有一条新回答。\n问题：${row.question}\n回答对象：${targetName}\n回答：${row.answer || ""}`
                : kind === "updated"
                    ? `匿名提问箱中的问题已更新。\n问题编号：${row.id}\n${row.askerAlias} 向${targetName} 提问：${row.question}\n${isRecipient && row.status === "pending" ? "这是问你的问题，可以使用“回答匿名提问”工具作答。" : row.answer ? `当前回答：${row.answer}` : row.targetType === "character" ? `指定回答对象是${targetName}，请勿代答。` : "请在匿名提问箱查看更新内容。"}`
                    : `匿名提问箱中的一条问题已被删除或撤回。\n原问题：${row.question}`;
        const session = createOrGetSession(character.id);
        pushChatMessage({
            id: `anonymous_qa_${kind}_${row.id}_${character.id}_${Date.now()}`,
            sessionId: session.id,
            role: "system",
            mediaType: "system_instruction",
            content,
            mediaData: { compactSystemInstruction: true, shortTermMemoryEvent: true },
        });
    }
}

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
    appendAnonymousQaTimelineEvent(row, "question");
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
    if (row.answer) appendAnonymousQaTimelineEvent(row, "answer");
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
    const previousTargetType = row.targetType;
    const previousTargetId = row.targetId;
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
    if (previousTargetType === "character" && (row.targetType !== previousTargetType || row.targetId !== previousTargetId)) {
        const previousTarget = loadCharacters().find(character => character.id === previousTargetId);
        if (previousTarget) {
            const session = createOrGetSession(previousTarget.id);
            pushChatMessage({
                id: `anonymous_qa_retargeted_${row.id}_${previousTarget.id}_${Date.now()}`,
                sessionId: session.id,
                role: "system",
                mediaType: "system_instruction",
                content: "这条匿名问题已更改回答对象，原先给你的通知已失效，请忽略。",
                mediaData: { compactSystemInstruction: true, shortTermMemoryEvent: true },
            });
        }
    }
    appendAnonymousQaTimelineEvent(row, "updated");
    return row;
}

export function deleteAnonymousQuestion(questionId: string): boolean {
    const rows = load();
    const row = rows.find(item => item.id === questionId);
    if (!row) return false;
    appendAnonymousQaTimelineEvent(row, "deleted");
    save(rows.filter(item => item.id !== questionId));
    return true;
}
