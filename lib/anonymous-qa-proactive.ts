"use client";

import { createOrGetSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { requestBackgroundChatReply } from "@/lib/follow-up-service";

/**
 * 让某个角色现在去匿名提问箱提一个问题。
 *
 * 匿名提问工具本身已经有了，但模型不会无缘无故主动调用；这里用一次性系统提示
 * 触发一轮后台生成，明确要求它调用「匿名提问」工具。提问者身份仍由工具侧只暴露
 * 随机 alias，不会把系统提示或角色 id 写给目标。
 */
export async function requestAnonymousQuestionFromCharacter(input: {
    askerId: string;
    targetType: "user" | "character";
    targetId: string;
}): Promise<{ ok: boolean; skipped?: string }> {
    const asker = loadCharacters().find(character => character.id === input.askerId);
    if (!asker) return { ok: false, skipped: "missing_character" };
    let targetLabel = "用户";
    if (input.targetType === "character") {
        const target = loadCharacters().find(character => character.id === input.targetId);
        if (!target) return { ok: false, skipped: "missing_target" };
        targetLabel = target.name;
    }
    const session = createOrGetSession(asker.id);
    const note = [
        `（系统触发：现在请你以「${asker.name}」的身份，去匿名提问箱向${targetLabel}提一个问题。）`,
        `必须调用工具「匿名提问」，参数 targetType=${input.targetType}，targetId=${input.targetType === "character" ? input.targetId : "user"}，audience=target。`,
        "问题要具体、符合你的人设和你们最近的关系，不要问天气这种空话。",
        "不要在聊天正文里直接写出这个问题，也不要暴露你是提问者；工具会给你随机 alias。",
        "调用完成后，可以只简单回应用户一句「我去提问箱留了个问题」。",
    ].join("\n");
    return requestBackgroundChatReply(session.id, { ephemeralSystemNote: note });
}
