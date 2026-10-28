import { buildChatPromptMessages, previewMessagesForApi } from "./chat-engine";
import { loadCharacters } from "./character-storage";
import type { ChatMessage, ChatSession } from "./chat-storage";
import type { LLMMessage } from "./llm-prompt-assembler";
import { classifyPresetPrompts, type PresetPromptHit } from "./llm-prompt-assembler";
import { loadVirtualLifeState } from "./life/life-storage";
import { buildLifeScenePromptContext } from "./life/life-scene-prompt";

export type BuiltinAppPreviewId = "photo_wall" | "watch_together" | "reality_bridge" | "widget" | "life";

export type BuiltinAppPreviewResult = {
    messages: LLMMessage[];
    characterName: string;
    model: string;
    presetName: string;
    appTags: string[];
    presetHits: PresetPromptHit[];
};

const APP_PREVIEW_TAGS: Record<BuiltinAppPreviewId, { appId: string; appTags: string[] }> = {
    photo_wall: { appId: "photo_wall", appTags: ["photo_wall", "annotation"] },
    watch_together: { appId: "watch_together", appTags: ["watch_together", "review"] },
    reality_bridge: { appId: "reality_bridge", appTags: ["reality_bridge", "offline_library"] },
    widget: { appId: "phone_widget", appTags: ["phone_widget", "status"] },
    life: { appId: "life", appTags: ["life", "turn", "scene", "tools"] },
};

function samplePrompt(appId: BuiltinAppPreviewId, characterId: string): string {
    if (appId === "life") {
        const state = loadVirtualLifeState();
        const scene = state.scenes.find(item => item.status === "active");
        const context = scene ? buildLifeScenePromptContext(state, scene, characterId) : "";
        return [context, "玩家本轮行动：（预览）", "玩家本轮对白：（预览）", "请生成本轮生活现场回应。"].filter(Boolean).join("\n\n");
    }
    if (appId === "photo_wall") return "照片标题：示例照片。\n请据此写一条照片背面的批注。";
    if (appId === "watch_together") return "视频标题：示例视频。\n请据此写观后感与纪念卡。";
    if (appId === "reality_bridge") return "规则名称：示例规则\n触发信号：示例信号\n请据此生成离线回复库。";
    return "请留下一句今天的桌面状态。";
}

/**
 * 预览内置 APP 的最终提示词：走与真实发送完全相同的组装链路，
 * 并列出当前 appTags 下每个预设条目是命中还是未命中。
 */
export async function previewBuiltinAppPrompt(
    appId: BuiltinAppPreviewId,
    characterId: string,
): Promise<BuiltinAppPreviewResult> {
    const character = loadCharacters().find(item => item.id === characterId);
    if (!character) throw new Error("请选择一个角色");
    const { appId: requestAppId, appTags } = APP_PREVIEW_TAGS[appId];
    const session: ChatSession = {
        id: `preview-${appId}-${characterId}`,
        contactId: characterId,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
        isPinned: false,
        isGroup: false,
    };
    const message: ChatMessage = {
        id: `preview-${appId}-${Date.now()}`,
        sessionId: session.id,
        role: "user",
        content: samplePrompt(appId, characterId),
        status: "sent",
        createdAt: new Date().toISOString(),
    };
    const built = await buildChatPromptMessages(session, [message], { appId: requestAppId, appTags });
    return {
        messages: previewMessagesForApi(built.config, built.preset, built.llmMessages),
        characterName: `${appId}:${character.name}`,
        model: built.config.defaultModel,
        presetName: built.preset?.name ?? "默认预设",
        appTags,
        presetHits: classifyPresetPrompts(built.preset, appTags),
    };
}
