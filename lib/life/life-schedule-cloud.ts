/**
 * 把「当前日程地点 / 同场场景」同步到云端，供 push-generate 在 App 关闭后
 * 执行生活主动消息前复核：玩家和角色是否仍在同一个日程地点。
 */
import { loadVirtualLifeState } from "./life-storage";
import { recordLifeDiagnostic } from "./life-diagnostics";
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
    const fingerprint = JSON.stringify({ version: 1, playerLocationId, scenes, characterLocations });
    if (!force && fingerprint === lastJson) return;
    const payload = { version: 1, updatedAt: new Date().toISOString(), playerLocationId, scenes, characterLocations };
    const response = await fetch("/api/push/bridge-snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots: [{ ruleId: SNAPSHOT_RULE_ID, payload }] }),
    });
    if (response.ok) { lastJson = fingerprint; recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "ok", detail: "玩家地点与 " + Object.keys(characterLocations).length + " 个角色位置已同步。", meta: { sceneCount: scenes.length, playerLocationId } }); } else { recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: "快照接口返回 HTTP " + response.status, meta: { playerLocationId } }); }
  } catch (error) { recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: error instanceof Error ? error.message : String(error) }); }
}
