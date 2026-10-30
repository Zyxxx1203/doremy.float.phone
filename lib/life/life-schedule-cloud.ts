/**
 * Synchronize authoritative player/character presence and active scenes for offline validation.
 */
import { loadVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow } from "./life-runtime";
import { recordLifeDiagnostic } from "./life-diagnostics";

const SNAPSHOT_RULE_ID = "life-schedule";
let lastJson = "";

function actorLocation(state: ReturnType<typeof loadVirtualLifeState>, ownerType: "player" | "character", ownerId: string): string {
  const now = resolveActorLifeNow(getActorClock(state, ownerType, ownerId));
  const actor = state.actorStates.find(item => item.ownerType === ownerType && item.ownerId === ownerId);
  const temporaryUntil = actor?.actualLocationUntil ? Date.parse(actor.actualLocationUntil) : Number.NaN;
  if (actor?.actualLocationId && Number.isFinite(temporaryUntil) && temporaryUntil > now.getTime()) return actor.actualLocationId;
  const slot = getCurrentActorSchedule(state, ownerType, ownerId, now);
  return slot?.plannedLocationId || actor?.actualLocationId || "";
}

export async function syncLifeScheduleSnapshot(force = false): Promise<void> {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  try {
    const state = loadVirtualLifeState();
    if (!state.settings.enabled) return;
    const playerLocationId = actorLocation(state, "player", "player");
    const characterIds = new Set([
      ...state.actorStates.filter(actor => actor.ownerType === "character").map(actor => actor.ownerId),
      ...state.schedules.filter(slot => slot.ownerType === "character").map(slot => slot.ownerId),
      ...state.scenes.flatMap(scene => scene.participants.filter(p => p.ownerType === "character").map(p => p.ownerId)),
    ]);
    const scenes = state.scenes.filter(scene => scene.status === "active").map(scene => ({
      id: scene.id,
      locationId: scene.locationId,
      characterIds: scene.participants.filter(p => p.ownerType === "character" && p.activity !== "离开").map(p => p.ownerId),
    }));
    const characterLocations = Object.fromEntries([...characterIds].map(id => [id, actorLocation(state, "character", id)]));
    const fingerprint = JSON.stringify({ version: 1, playerLocationId, scenes, characterLocations });
    if (!force && fingerprint === lastJson) return;
    const payload = { version: 1, updatedAt: new Date().toISOString(), playerLocationId, scenes, characterLocations };
    const response = await fetch("/api/push/bridge-snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots: [{ ruleId: SNAPSHOT_RULE_ID, payload }] }),
    });
    if (response.ok) {
      lastJson = fingerprint;
      recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "ok", detail: "玩家地点与 " + Object.keys(characterLocations).length + " 个角色地点已同步。", meta: { sceneCount: scenes.length, playerLocationId } });
    } else {
      recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: "快照接口返回 HTTP " + response.status, meta: { playerLocationId } });
    }
  } catch (error) {
    recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: error instanceof Error ? error.message : String(error) });
  }
}
