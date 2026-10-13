import { loadVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow } from "./life-runtime";

/**
 * Shared fact bridge: only confirmed life-scene facts involving this character
 * are surfaced in their normal chat context. Guesses and interpretations are
 * deliberately excluded so the character cannot acquire fabricated memories.
 */
export function buildLifeMemoryContext(characterId: string, limit = 10): string {
  const state = loadVirtualLifeState();
  if (!state.settings.enabled || !state.settings.saveConfirmedEventsToMemory) return "";
  const facts = state.memories
    .filter(memory => memory.participants.includes(characterId) && memory.fact.trim())
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, Math.max(0, Math.min(limit, 30)))
    .reverse();
  const characterSceneIds = new Set(state.scenes
    .filter(scene => scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId))
    .map(scene => scene.id));
  const timeline = (state.timeline ?? [])
    .filter(entry => entry.actorId === characterId || (!!entry.sceneId && characterSceneIds.has(entry.sceneId)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, Math.max(0, Math.min(limit * 2, 40)))
    .reverse();
  if (!facts.length && !timeline.length) return "";
  return [
    "【虚拟生活共同记忆｜已记录的相关事实】",
    "以下只包含这个角色参与、发起或身处相关共同场景时产生的记录。它们是生活记录，不代表角色知道自己没有观察到的其他人的私密行动；不得把计划、推测或未发生的事情当成事实。",
    ...facts.map(fact => `- ${new Date(fact.occurredAt).toLocaleString("zh-CN")}：${fact.fact}`),
    ...timeline.map(entry => `- ${new Date(entry.occurredAt).toLocaleString("zh-CN")}：${entry.title}${entry.details ? "；" + entry.details : ""}`),
  ].join("\n");
}

/**
 * Live presence shared with online chat. This is current character state, not
 * a fabricated memory; the prompt must respect sleep, work and actual location.
 */
export function buildLifePresenceContext(characterId: string): string {
  const state = loadVirtualLifeState();
  if (!state.settings.enabled) return "";
  const clock = getActorClock(state, "character", characterId);
  const now = resolveActorLifeNow(clock);
  const schedule = getCurrentActorSchedule(state, "character", characterId, now);
  const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === characterId);
  const scene = [...state.scenes].reverse().find(item =>
    (item.status === "active" || item.status === "paused")
    && item.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId),
  );
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
