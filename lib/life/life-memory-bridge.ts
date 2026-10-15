import { loadVirtualLifeState, saveVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow, settleActorTimelineToNow } from "./life-runtime";

function loadSettledCharacterLifeState(characterId: string) {
  let state = loadVirtualLifeState();
  if (!state.settings.enabled) return state;
  const settled = settleActorTimelineToNow(state, "character", characterId);
  if (settled !== state) state = saveVirtualLifeState(settled);
  return state;
}

/**
 * Shared fact bridge: only confirmed life-scene facts involving this character
 * are surfaced in their normal chat context. Guesses and interpretations are
 * deliberately excluded so the character cannot acquire fabricated memories.
 */
export function buildLifeMemoryContext(characterId: string, limit = 10): string {
  const state = loadSettledCharacterLifeState(characterId);
  if (!state.settings.enabled || !state.settings.saveConfirmedEventsToMemory) return "";
  const facts = state.memories
    .filter(memory => memory.participants.includes(characterId) && memory.fact.trim())
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, Math.max(0, Math.min(limit, 30)))
    .reverse();
  if (!facts.length) return "";
  return [
    "【虚拟生活共同记忆｜已发生事实】",
    "以下是角色本人参与过的生活场景事件摘要。它们是已记录事实，不是猜测；不要擅自扩写成未发生的细节。",
    ...facts.map(fact => `- ${new Date(fact.occurredAt).toLocaleString("zh-CN")}：${fact.fact}`),
  ].join("\n");
}

/**
 * Live presence shared with online chat. This is current character state, not
 * a fabricated memory; the prompt must respect sleep, work and actual location.
 */
export function buildLifePresenceContext(characterId: string): string {
  const state = loadSettledCharacterLifeState(characterId);
  if (!state.settings.enabled) return "";
  const clock = getActorClock(state, "character", characterId);
  const now = resolveActorLifeNow(clock);
  const schedule = getCurrentActorSchedule(state, "character", characterId, now);
  const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === characterId);
  const belongsToCharacter = (item: typeof state.scenes[number]) =>
    item.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId);
  const scene = state.scenes.find(item => item.status === "active" && belongsToCharacter(item))
    ?? state.scenes
      .filter(item => item.status === "paused" && belongsToCharacter(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!schedule && !actor && !scene) return "";
  const activity = actor?.activity || schedule?.title || "暂时没有记录当前活动";
  const sleeping = /睡眠|睡觉|入睡|午休|休息/.test(activity) || /睡眠|睡觉|入睡|午休/.test(schedule?.title || "");
  const lines = [
    "【角色当前虚拟生活状态｜线上聊天必须遵守】",
    "角色虚拟时间：" + now.toLocaleString("zh-CN"),
    "当前活动：" + activity,
    "实际地点：" + (actor?.actualLocationName || "未记录"),
    "日程计划：" + (schedule?.title || "当前时段暂无计划"),
    scene ? "关联场景：" + scene.locationName + "（场景已保存；只记得自己参与或实际感知到的内容）" : "",
    sleeping
      ? "当前处于睡眠/休息时段。不要因为玩家发来一条线上消息就默认角色已清醒并立刻完整回复。应根据性格、消息紧急程度、是否开启消息提示和既有关系，表现为继续睡、被通知吵醒、迷迷糊糊查看、醒后再回复或第二天解释；不得把未发生的醒来或对话写成事实。"
      : "线上消息到达不代表角色立刻看见。结合当前活动、注意力和性格决定是马上查看、稍后查看，还是线下见面时再回应；不要让线上回复改变既定地点或直接瞬移。",
    "这份状态用于决定角色此刻能否回应，不要把计划地点当成实际定位，也不要让角色知道其没有观察到的玩家行动。",
  ].filter(Boolean);
  return lines.join("\n");
}
