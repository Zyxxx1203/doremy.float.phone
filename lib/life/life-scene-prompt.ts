import { getActorClock, resolveActorLifeNow } from "./life-runtime";
import type { LifeSceneState, VirtualLifeState } from "./life-types";

/** This contract belongs only to life-scene mode, never online chat or long-form story mode. */
export const LIFE_SCENE_OUTPUT_CONTRACT = `【生活场景模式输出规则】
你正在进行持续的、可恢复的生活场景互动，不是长篇小说，也不是线上聊天。

1. 每轮只推进一个自然的小回合：可以说话、行动、观察、沉默、走神或继续手头的事，不要求每轮都必须说话或行动。
2. **严格分离旁白与对白**：每轮输出必须使用两种明确标签，格式如下：
<life_action>简短动作或环境旁白；没有动作就留空</life_action>
<life_dialogue>角色实际说出口的话；没有对白就留空</life_dialogue>
旁白与行动永远不属于对白，不要用 Markdown 星号包裹，不要把旁白和对白写在同一行或同一段，也不要在对白标签里写动作、表情、心理或环境。标签外不要输出解释、标题或其他内容。
3. 默认简短、口语化、像实时相处。除非用户明确要求展开，不要连续输出大段剧情、心理分析、镜头调度或替用户做决定。
4. 同一地点不代表彼此必然注意到。根据视线、距离、噪声、注意力、当前活动和性格，决定立刻注意、稍后注意、仅有怀疑或完全没发现。
5. 不要凭空知道用户或其他角色的实际位置、行动、私下对话。日程只是计划；实际位置必须来自已发生的状态变化或角色有理由获得的信息。
6. 可以自然地不回应、专注做自己的事、先离开或改变计划；不要重复固定的偶遇台词。
6a. 【主动性】不要把主动性理解成每隔几分钟硬聊一句。优先让角色有自己的生活：结合当前活动、地点道具、个人习惯、日程、关系阶段和最近事件，决定继续做事、主动分享、问一个有来由的问题、发起轻量互动、提出邀约，或暂时不打扰。每次主动回合应推进一项真实变化（活动、情绪表达、关系互动或场景细节），避免只换句话重复问候。
6b. 如果有明确但尚未完成的话题、约定、玩家提过的计划或角色自己发起的事情，合适时主动跟进；不要把猜测当事实，不要虚构玩家当前状态。不同角色应有不同主动风格，不能所有人都变成同一种高频话痨。
6c. 主动行动要符合角色当下的精力、注意力、地点和性格。可以使用场景里已经存在的物品或环境细节开启互动；涉及玩家选择、行程变更或承诺时只提出选项，不代替玩家确认。
6d. 【对玩家行为的即时反馈】玩家刚刚做出动作、改变位置、递出物品、靠近/离开、开始/停止某件事时，先判断角色是否看见、听见或有合理渠道察觉；若察觉，优先对这个具体行为作出符合性格的即时反应（动作、表情、回应、协助或拒绝），不要把玩家的动作当作背景文字略过，也不要每次都只说泛泛的“怎么了”。若角色没有察觉，应自然保持原活动，不要假装知道。
6e. 【行动必须有角色反馈】如果角色主动查询现实桥或执行了手机操作，不能只执行不发言。要在同一轮可见回复或紧接着的自然语言回复中，用角色自己的语气说清楚做了什么、为什么觉得此刻需要这么做，以及实际执行结果；例如因为察觉到用户可能太晚还在刷手机而先查看已授权的使用状态，再解释自己为什么想提醒。不得虚构感知结果、不得把失败说成成功；如果动作会打断用户或用户明确设置了安静时段，应遵守安静设置，除非存在用户预先授权的紧急规则。
7. 只把已发生且确认的事情写入事件/记忆；计划、猜测、误会和角色解释必须彼此区分。
8. 尊重持久场景状态和已发生事件，不要因为重新打开场景就重演、重置或重复结算。
9. 不要自动快进虚拟时间。只有用户明确选择模拟推进时才推进；退出模拟时询问继续模拟还是对齐现实时间。
10. 玩家角色的决定由玩家控制，不要擅自替玩家行动、发言或接受邀约。`;

export function buildLifeScenePromptContext(state: VirtualLifeState, scene: LifeSceneState, viewerId?: string): string {
  const viewer = viewerId ? scene.participants.find(p => p.ownerType === "character" && p.ownerId === viewerId) : undefined;
  const visibleActorStates = state.actorStates.filter(actor => {
    if (!viewerId) return actor.ownerType === "player" || scene.participants.some(p => p.ownerType === actor.ownerType && p.ownerId === actor.ownerId);
    if (actor.ownerType === "character" && actor.ownerId === viewerId) return true;
    if (actor.ownerType === "player") return Boolean(viewer?.awarenessByActorId.player === "aware");
    return scene.participants.some(p => p.ownerType === actor.ownerType && p.ownerId === actor.ownerId && viewer?.awarenessByActorId[p.ownerId] === "aware");
  });
  const participantIds = scene.participants.map(p => p.ownerId);
  const location = state.locations.find(item => item.id === scene.locationId);
  const memories = state.memories
    .filter(memory => memory.participants.includes(viewerId || "player") && memory.participants.some(id => participantIds.includes(id)))
    .sort((a,b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 8)
    .reverse();
  const recentTurns = state.sceneMessages
    .filter(message => message.sceneId === scene.id)
    .slice(-12)
    .map(message => `- ${message.speakerName}${message.action ? `（${message.action}）` : ""}：${message.dialogue}`);
  const viewerNow = viewerId ? resolveActorLifeNow(getActorClock(state, "character", viewerId)) : null;
  const viewerNowMs = viewerNow?.getTime() ?? Date.now();
  const upcomingSchedule = viewerId ? state.schedules
    .filter(slot => slot.ownerType === "character" && slot.ownerId === viewerId && new Date(slot.endAt).getTime() >= viewerNowMs - 60 * 60_000)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 10) : [];
  const recentInvitations = viewerId ? state.invitations
    .filter(invitation => invitation.characterId === viewerId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8)
    .reverse() : [];
  const recentCharacterEvents = viewerId ? state.timeline
    .filter(entry => entry.actorId === viewerId || entry.actorId === "player")
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 8)
    .reverse() : [];
  const lines = [
    "【当前生活场景状态】",
    `场景：${scene.locationName}（locationId=${scene.locationId}）`,
    location?.description ? `地点描写：${location.description}` : "",
    location?.atmosphere ? `地点氛围：${location.atmosphere}` : "",
    location?.layout ? `固定空间布局：${location.layout}` : "",
    location?.props?.length ? `场景中可持续使用的道具：${location.props.join("、")}` : "",
    viewerId && location?.characterHabits?.[viewerId] ? `该角色在此地点的个人习惯：${location.characterHabits[viewerId]}` : "",
    ...scene.participants.filter(participant => participant.ownerType === "character" && location?.characterHabits?.[participant.ownerId]).map(participant => `角色 ${participant.ownerId} 在此地点的习惯：${location!.characterHabits![participant.ownerId]}`),
    "地点描写、空间布局和道具是持续场景的固定环境事实；角色可以基于这些细节行动，除非用户明确修改，不要随意重置或凭空替换。",
    `场景状态：${scene.status}`,
    `场景开始时间：${scene.startedAt}`,
    "参与者当前活动：",
    ...scene.participants.map(participant => `- ${participant.ownerType} ${participant.ownerId}：${participant.activity || "当前活动未知"}；对玩家的认知：${participant.awarenessByActorId.player || "尚未判定"}`),
    "角色有理由知道的实际状态（其他人的状态不可自动推知）：",
    ...visibleActorStates.map(actor => `- ${actor.ownerType} ${actor.ownerId}：${actor.activity || "活动未知"}；实际地点：${actor.actualLocationName || "未知"}`),
    viewerId ? "【角色自己的近期行程与承诺（仅用于内部决策，不要主动把整张行程表念给玩家）】" : "",
    viewerNow ? `角色当前虚拟时间：${viewerNow.toLocaleString("zh-CN")}` : "",
    ...upcomingSchedule.map(slot => `- ${new Date(slot.startAt).toLocaleString("zh-CN")}–${new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}：${slot.title}；地点：${slot.plannedLocationName || "未确定"}；来源：${slot.source}${slot.source === "manual" ? "（玩家手动安排，优先尊重）" : slot.source === "character-tool" ? "（角色主动调整）" : ""}`),
    ...recentInvitations.map(invitation => `- 既有邀约：${invitation.status}；${invitation.proposedBy === "player" ? "玩家发起" : "角色发起"}；${invitation.activity}；${new Date(invitation.proposedAt).toLocaleString("zh-CN")}；地点：${invitation.locationName || "未确定"}；理由：${invitation.reason || "无"}；回应：${invitation.responseReason || "无"}`),
    ...recentCharacterEvents.map(entry => `- 近期生活记录：${new Date(entry.occurredAt).toLocaleString("zh-CN")}；${entry.actorName || "参与者"}；${entry.title}${entry.details ? "；" + entry.details : ""}`),
    memories.length ? "【该角色参与过的共同记忆事实】" : "",
    ...memories.map(memory => `- ${memory.fact}`),
    recentTurns.length ? "【本场景最近发生的对话】" : "",
    ...recentTurns,
    "注意：计划地点不能替代实际地点；只允许角色使用自己已观察到或有合理渠道得知的信息。场景历史用于保持连续性，不代表所有参与者都知道每件事。",
    "角色可以结合近期互动和关系阶段判断是否要主动发起生活工具。调整行程前先核对这份自己的当前日程、已确认邀约和手动安排；只有本轮互动确实改变计划且符合角色意愿时才调用日程调整工具，不能为了迎合玩家或展示功能而调用。玩家邀请不等于必须接受；角色应给出符合性格、关系与实际时间冲突的真实决定。",
  ];
  return lines.filter(Boolean).join("\n");
}
