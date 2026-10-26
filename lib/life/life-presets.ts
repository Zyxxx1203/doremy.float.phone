import { LIFE_SCENE_OUTPUT_CONTRACT } from "./life-scene-prompt";
import type { LifePromptPreset } from "./life-types";
import type { LifeScenePromptOverride } from "@/lib/chat-engine";

export const LIFE_NATURAL_SILENCE_PRESET_ID = "life-natural-silence";
export const LIFE_STRICT_DIALOGUE_PRESET_ID = "life-strict-dialogue";

export const LIFE_TOOL_PROMPT = [
    "你可以按需使用以下生活工具。它们只修改生活场景状态，不是手机系统工具。",
    "只填对应 JSON 字段；不需要就填 null；每轮最多 1 个非空工具字段。",
    "plan_change：{ \"startAt\": \"ISO-8601\", \"endAt\": \"ISO-8601\", \"title\": \"新的安排\", \"locationId\": \"home\" }。只调整当前虚拟日未来时段，保留前后日程，不覆盖已确认约会。",
    "invitation：{ \"time\": \"ISO-8601\", \"locationId\": \"cafe\", \"activity\": \"活动\", \"reason\": \"简短原因\", \"durationMinutes\": 60 }。这是待确认邀约，玩家确认后才同步日程。",
    "follow_request：{ \"durationMinutes\": 120, \"reason\": \"简短原因\" }。需要玩家确认，可被拒绝。",
    "只有角色有真实动机时才使用；不要为了展示功能调用。格式校验不通过时系统不会执行工具。",
].join("\n");

const LIFE_BEHAVIOR_PROMPT = [
    "动作与对白严格分离。动作写进 action，台词写进 dialogue；不要把神态、心理、环境写进对白。",
    "对白优先自然、口语化；动作只在对白需要支撑时出现，不要用行动卡代替说话。",
    "同一地点不代表彼此必然注意到；根据视线、距离、噪声、注意力、当前活动和性格决定是否察觉。",
    "不要凭空知道用户或其他角色的实际位置、行动、私下对话。日程只是计划，实际位置必须来自已发生的变化或有理由获得的信息。",
].join("\n");

const NATURAL_TASK_PROMPT = [
    "这是{characterName}的生活回合，不是线上聊天。",
    "优先写一句自然、有来由的对白；需要时再附一个动作。",
    "如果角色在安静场景里选择用动作表达关心，可以只给 action、dialogue 为空；但上一轮已经是纯行动时，本轮必须至少一句对白。",
    "没有对白也没有动作时，整轮不输出。不要只输出行动卡，不要替玩家行动或发言。",
].join("\n");

const STRICT_TASK_PROMPT = [
    "这是{characterName}的生活回合，不是线上聊天。",
    "每轮至少一句对白；需要时附一个动作。",
    "没有对白就不要输出 action；角色真的不想说话时，整轮不输出。",
    "不要只输出行动卡，不要替玩家行动或发言。",
].join("\n");

export function getDefaultLifePromptPresets(): LifePromptPreset[] {
    return [
        {
            id: LIFE_NATURAL_SILENCE_PRESET_ID,
            name: "自然留白（推荐）",
            description: "允许用动作表达关心；最多连续 1 个纯行动回合，之后必须有对白。",
            sceneOutputPrompt: LIFE_SCENE_OUTPUT_CONTRACT,
            sceneBehaviorPrompt: LIFE_BEHAVIOR_PROMPT,
            sceneTaskPrompt: NATURAL_TASK_PROMPT,
            toolCallingPrompt: LIFE_TOOL_PROMPT,
            maxConsecutiveActionOnly: 1,
        },
        {
            id: LIFE_STRICT_DIALOGUE_PRESET_ID,
            name: "严格对白",
            description: "每轮至少一句对白；纯行动回合不允许。",
            sceneOutputPrompt: LIFE_SCENE_OUTPUT_CONTRACT + "\n\n【本预设的附加限制】严格对白：不允许纯行动回合；每轮必须至少一条 dialogue，没有对白就不要输出 action。",
            sceneBehaviorPrompt: LIFE_BEHAVIOR_PROMPT,
            sceneTaskPrompt: STRICT_TASK_PROMPT,
            toolCallingPrompt: LIFE_TOOL_PROMPT,
            maxConsecutiveActionOnly: 0,
        },
    ];
}

export function getLifePromptPresets(existing?: LifePromptPreset[]): LifePromptPreset[] {
    const builtins = getDefaultLifePromptPresets();
    if (!existing?.length) return builtins;
    return [
        ...existing,
        ...builtins.filter(item => !existing.some(saved => saved.id === item.id)),
    ];
}

export function getActiveLifePromptPreset(
    presets: LifePromptPreset[],
    activeId?: string,
): LifePromptPreset {
    return presets.find(item => item.id === activeId) ?? presets[0] ?? getDefaultLifePromptPresets()[0];
}


export function buildLifeScenePromptOverride(
    preset: LifePromptPreset,
    globalCustomPrompt?: string,
): LifeScenePromptOverride {
    return {
        outputContract: preset.sceneOutputPrompt?.trim() || LIFE_SCENE_OUTPUT_CONTRACT,
        behaviorPrompt: [
            preset.basePresetPrompt,
            preset.sceneBehaviorPrompt,
            preset.locationHabitPrompt,
            globalCustomPrompt,
            preset.customPrompt,
        ].filter((value): value is string => Boolean(value && value.trim())).join("\n\n"),
        toolPrompt: preset.toolCallingPrompt?.trim() || LIFE_TOOL_PROMPT,
    };
}
