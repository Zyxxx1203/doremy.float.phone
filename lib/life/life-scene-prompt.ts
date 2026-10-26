import { getActorClock, resolveActorLifeNow } from "./life-runtime";
import type { LifeSceneState, VirtualLifeState } from "./life-types";

/** This contract belongs only to life-scene mode, never online chat or long-form story mode. */
export const LIFE_SCENE_OUTPUT_CONTRACT = `【生活现场输出协议 v3｜JSON】
你正在生活现场里扮演一个角色，不是写小说，也不是线上聊天。
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要输出 JSON 以外的任何文字。

JSON 字段：
{
  "action": "一段完整的动作、神态、移动或环境反应；没有就空字符串",
  "dialogue": ["一句真正说出口的话", "第二句对白"],
  "plan_change": null,
  "invitation": null,
  "follow_request": null
}

规则：
1. action 最多一段，必须是字符串；多个动作必须合并成一段。
2. dialogue 必须是字符串数组；每条只写说出口的话，不写动作、神态、心理、环境、角色名前缀、括号、星号。
3. action 里不能写引号台词，不能写“说/问/答/道”后面的说话内容。
4. 允许 dialogue 为空（纯行动回合），但禁止连续 2 轮 dialogue 都为空；上一轮 dialogue 为空时，本轮必须至少 1 条 dialogue。
5. 如果角色这一轮不想说话也不想行动，输出 action 为空、dialogue 为空；不要用行动卡代替说话。
6. plan_change / invitation / follow_request 每轮最多 1 个非空；不需要就填 null。它们只修改生活场景状态，不是手机系统工具。
7. 不要输出 action/dialogue 之外的字段；不要输出思考过程。

正确示例：
{
  "action": "她把杯子往你面前推了推，抬眼看你。",
  "dialogue": ["“先喝点热的吧。”"],
  "plan_change": null,
  "invitation": null,
  "follow_request": null
}

正确示例（安静地用动作表达关心）：
{
  "action": "她把毯子轻轻盖在你腿上，没有出声。",
  "dialogue": [],
  "plan_change": null,
  "invitation": null,
  "follow_request": null
}

错误示例：
- 输出两个 action 字符串，或把两段动作拆成两个字段；
- 把“她笑了笑，说……”写进 dialogue；
- 把“别熬夜了”写进 action；
- 在 JSON 外再写解释或 Markdown。`;
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
  const sceneMessages = state.sceneMessages.filter(message => message.sceneId === scene.id);
  const recentMessages = sceneMessages.slice(-12);
  const turnGroups = new Map<string, { speakerName: string; speakerId: string; action: string[]; dialogue: string[]; createdAt: string }>();
  for (const message of recentMessages) {
    if (message.role === "system") continue;
    const key = `${message.speakerId}|${message.createdAt}`;
    const group = turnGroups.get(key) ?? { speakerName: message.speakerName, speakerId: message.speakerId, action: [], dialogue: [], createdAt: message.createdAt };
    if (message.action?.trim()) group.action.push(message.action.trim());
    if (message.dialogue?.trim()) group.dialogue.push(message.dialogue.trim());
    turnGroups.set(key, group);
  }
  const recentTurns = [...turnGroups.values()].map(group => {
    const actionText = group.action.join("；");
    const dialogueText = group.dialogue.join(" / ");
    if (actionText && dialogueText) return `- ${group.speakerName}（动作：${actionText}）说：“${dialogueText}”`;
    if (actionText) return `- ${group.speakerName}（仅动作，无对白）：${actionText}`;
    return `- ${group.speakerName}（仅对白）：“${dialogueText}”`;
  });
  const characterMessages = sceneMessages.filter(message => message.role === "character" && (!viewerId || message.speakerId === viewerId));
  const lastCharacterAt = characterMessages[characterMessages.length - 1]?.createdAt;
  const lastCharacterTurn = lastCharacterAt ? characterMessages.filter(message => message.createdAt === lastCharacterAt) : [];
  const lastCharacterTurnHasDialogue = lastCharacterTurn.some(message => Boolean(message.dialogue?.trim()));
  const lastCharacterTurnHasAction = lastCharacterTurn.some(message => Boolean(message.action?.trim()));
  const lastCharacterTurnActionOnly = lastCharacterTurnHasAction && !lastCharacterTurnHasDialogue;
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
    location?.description ? `地点固定描写：${location.description}` : "",
    scene.currentDescription?.trim() ? `【当前现场描述（由本场景原始行动与对白整理；用于保持连续性，不得覆盖原始记录）】\n${scene.currentDescription.trim()}` : "",
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
    lastCharacterTurnActionOnly ? "【上一轮格式】上一轮只有动作、没有对白；本轮必须至少一句对白。" : "",
    "注意：计划地点不能替代实际地点；只允许角色使用自己已观察到或有合理渠道得知的信息。场景历史用于保持连续性，不代表所有参与者都知道每件事。",
    "角色可以结合近期互动和关系阶段判断是否要主动发起生活工具。调整行程前先核对这份自己的当前日程、已确认邀约和手动安排；只有本轮互动确实改变计划且符合角色意愿时才调用日程调整工具，不能为了迎合玩家或展示功能而调用。玩家邀请不等于必须接受；角色应给出符合性格、关系与实际时间冲突的真实决定。",
  ];
  return lines.filter(Boolean).join("\n");
}
