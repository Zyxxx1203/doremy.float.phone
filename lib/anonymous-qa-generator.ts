"use client";

import { createOrGetSession, type ChatMessage } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { generateOfflineChatCompletion } from "@/lib/chat-engine";
import { answerAnonymousQuestion, askAnonymousQuestion } from "./anonymous-qa";

type GeneratedRow = { question?: unknown; answer?: unknown; answered?: unknown };

const FALLBACK_ROWS: GeneratedRow[] = [
    { question: "最近有什么事让你偷偷开心了很久？", answer: "不告诉你，反正是好事。", answered: true },
    { question: "如果明天可以消失一天，你最想去哪？", answer: "去一个没人认识我的地方，睡到自然醒。", answered: true },
    { question: "你手机里最舍不得删的一张照片是什么？", answered: false },
    { question: "最近有没有哪句话，你其实很想对某个人说？", answered: false },
    { question: "你觉得我们现在算什么关系？", answer: "比普通朋友多一点，但又没人先开口。", answered: true },
    { question: "你上一次真心笑出声，是因为什么？", answered: false },
    { question: "如果只能保留一个习惯，你会留下什么？", answer: "每天睡前跟人说一句晚安。", answered: true },
];

function pickOne<T>(items: T[]): T { return items[Math.floor(Math.random() * items.length)]; }

function parseRows(raw: string): GeneratedRow[] {
    const first = raw.indexOf("[");
    const last = raw.lastIndexOf("]");
    if (first < 0 || last <= first) return [];
    try {
        const parsed = JSON.parse(raw.slice(first, last + 1)) as unknown;
        return Array.isArray(parsed) ? parsed.slice(0, 5) as GeneratedRow[] : [];
    } catch {
        return [];
    }
}

/**
 * 刷新匿名提问箱：让模型随机写 5 条匿名问答，再用现有存储落库。
 *
 * 只借用某个角色的会话拿 API 配置，不让模型扮演该角色；提问者/目标/是否已回答
 * 都由本地随机决定，所以不需要用户提前设置角色或模板。
 */
export async function generateAnonymousQaBatch(count = 5): Promise<{ created: number; answered: number; skipped: number }> {
    const characters = loadCharacters();
    if (!characters.length) throw new Error("先创建至少一个角色");
    const generator = pickOne(characters);
    const session = createOrGetSession(generator.id);
    const roster = characters.slice(0, 8).map(character => (
        `- ${character.name}${character.persona ? `：${String(character.persona).replace(/\s+/g, " ").slice(0, 90)}` : ""}`
    )).join("\n");
    const prompt = [
        "你是一个匿名提问箱的内容生成器，不是在扮演任何角色。",
        "请围绕用户和下面这些角色的日常、关系、好奇、吐槽，随机写 5 条匿名问答。",
        "不要色情、不要违法、不要人身攻击；问题要具体，像真的有人匿名投递。",
        "只输出 JSON 数组，不要解释、不要 markdown 代码块。",
        '每项格式：{"question":"问题，40字内","answer":"回答，60字内","answered":true或false}',
        "answered 为 true 表示已经有人回答；false 表示还在等回答。",
        "角色列表：",
        roster || "（暂无角色）",
    ].join("\n");
    const history = [{
        id: `anon_gen_${Date.now()}`,
        sessionId: session.id,
        role: "user",
        content: prompt,
        status: "sent",
        createdAt: new Date().toISOString(),
    } as ChatMessage];
    let raw = "";
    try {
        const result = await generateOfflineChatCompletion(session, history, {
            appId: "chat",
            appTags: ["chat", "text"],
            includeDirectChatEntries: false,
        });
        raw = String(result.content || "");
    } catch {
        // 模型/API 不可用时仍让刷新按钮可用，退回本地随机问答。
        raw = "";
    }
    const parsed = parseRows(raw);
    const rows: GeneratedRow[] = parsed.length ? parsed.slice(0, count) : FALLBACK_ROWS.slice(0, count);
    if (!rows.length) throw new Error("没有生成出可用的匿名问答");
    while (rows.length < count) rows.push({ ...FALLBACK_ROWS[Math.floor(Math.random() * FALLBACK_ROWS.length)] });
    let created = 0;
    let answeredCount = 0;
    let skipped = 0;
    for (const item of rows.slice(0, count)) {
        const question = String(item.question || "").trim().slice(0, 500);
        if (!question) { skipped += 1; continue; }
        const answer = String(item.answer || "").trim().slice(0, 1000);
        const shouldAnswer = answer.length > 0 && (item.answered === true || (item.answered !== false && Math.random() < 0.65));
        const userAsker = Math.random() < 0.5;
        const asker = userAsker ? null : pickOne(characters);
        const targetUser = Math.random() < 0.35;
        const targetCandidates = characters.filter(character => character.id !== asker?.id);
        const target = targetUser || !targetCandidates.length ? null : pickOne(targetCandidates);
        const row = askAnonymousQuestion({
            askerType: asker ? "character" : "user",
            askerId: asker?.id || "user",
            targetType: target ? "character" : "user",
            targetId: target?.id || "user",
            question,
            audience: "public",
            revealIdentity: false,
        });
        created += 1;
        if (shouldAnswer) {
            answerAnonymousQuestion(row.id, answer);
            answeredCount += 1;
        }
    }
    return { created, answered: answeredCount, skipped };
}
