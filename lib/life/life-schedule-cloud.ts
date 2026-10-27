/**
 * 把「当前日程地点 / 同场场景」同步到云端，供 push-generate 在 App 关闭后
 * 执行生活主动消息前复核：玩家和角色是否仍在同一个日程地点。
 */
import { loadVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow } from "./life-runtime";

const SNAPSHOT_RULE_ID = "life-schedule";
let lastJson = "";

export async function syncLifeScheduleSnapshot(force = false): Promise<void> {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  try {
    const state = loadVirtualLifeState();
    if (!state.settings.enabled) return;
    const now = resolveActorLifeNow(getActorClock(state, "player", "player"));
    const playerSlot = getCurrentActorSchedule(state, "player", "player", now);
    const playerLocationId = playerSlot?.plannedLocationId
      ?? state.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player")?.actualLocationId
      ?? "";
    const scenes = state.scenes
      .filter(scene => scene.status === "active")
      .map(scene => ({
        id: scene.id,
        locationId: scene.locationId,
        characterIds: scene.participants.filter(p => p.ownerType === "character").map(p => p.ownerId),
      }));
    const characterLocations = Object.fromEntries(
      [...new Set(state.scenes.flatMap(scene => scene.participants.filter(p => p.ownerType === "character").map(p => p.ownerId)))]
        .map(id => {
          const slot = getCurrentActorSchedule(state, "character", id, resolveActorLifeNow(getActorClock(state, "character", id)));
          return [id, slot?.plannedLocationId ?? ""];
        }),
    );
    const payload = { version: 1, updatedAt: new Date().toISOString(), playerLocationId, scenes, characterLocations };
    const json = JSON.stringify(payload);
    if (!force && json === lastJson) return;
    const response = await fetch("/api/push/bridge-snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots: [{ ruleId: SNAPSHOT_RULE_ID, payload }] }),
    });
    if (response.ok) lastJson = json;
  } catch {
    // 云端未配置/未登录时静默；服务端会按无快照兼容旧任务。
  }
}
