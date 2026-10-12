import type { LifeSceneState, VirtualLifeState } from "./life-types";

/**
 * Prompt contract for the new life-scene mode only.
 * Do not use this for online chat or the existing long-form story mode.
 */
export const LIFE_SCENE_OUTPUT_CONTRACT = `【生活场景模式输出规则】
你正在进行持续的、可恢复的生活场景互动，不是长篇小说，也不是线上聊天。

1. 每轮只推进一个自然的小回合：可以说话、行动、观察、沉默、走神或继续手头的事，不要求每轮都必须说话或行动。
2. 动作/环境叙述使用简短的斜体旁白，单独放在对白气泡之外；对白气泡只放角色实际说出口的话。
3. 默认简短、口语化、像实时相处。除非用户明确要求展开，不要连续输出大段剧情、心理分析、镜头调度或替用户做决定。
4. 同一地点不代表彼此必然注意到。根据视线、距离、噪声、注意力、当前活动和性格，决定立刻注意、稍后注意、仅有怀疑或完全没发现。
5. 不要凭空知道用户或其他角色的实际位置、行动、私下对话。日程只是计划；实际位置必须来自已发生的状态变化或角色有理由获得的信息。
6. 可以自然地不回应、专注做自己的事、先离开或改变计划；不要重复固定的偶遇台词。
7. 只把已发生且确认的事情写入事件/记忆；计划、猜测、误会和角色解释必须彼此区分。
8. 尊重持久场景状态和已发生事件，不要因为重新打开场景就重演、重置或重复结算。
9. 不要自动快进虚拟时间。只有用户明确选择模拟推进时才推进；退出模拟时询问继续模拟还是对齐现实时间。
10. 玩家角色的决定由玩家控制，不要擅自替玩家行动、发言或接受邀约。`;

export function buildLifeScenePromptContext(
  state: VirtualLifeState,
  scene: LifeSceneState,
): string {
  const lines = [
    "【当前生活场景状态】",
    `场景：${scene.locationName}（locationId=${scene.locationId}）`,
    `场景状态：${scene.status}`,
    `场景开始时间：${scene.startedAt}`,
    "参与者当前活动：",
    ...scene.participants.map(participant =>
      `- ${participant.ownerType} ${participant.ownerId}：${participant.activity || "当前活动未知"}`,
    ),
    "当前已知的实际状态（仅供场景连续性使用，不代表其他角色都知道）：",
    ...state.actorStates.map(actor =>
      `- ${actor.ownerType} ${actor.ownerId}：${actor.activity || "活动未知"}；实际地点：${actor.actualLocationName || "未知"}`,
    ),
    "注意：计划地点不能替代实际地点；只允许角色使用自己已观察到或有合理渠道得知的信息。",
  ];
  return lines.join("\n");
}
