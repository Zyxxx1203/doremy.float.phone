/**
 * Synchronize authoritative player/character presence and active scenes for offline validation.
 */
import { loadVirtualLifeState } from "./life-storage";
import { resolveActorLocation } from "./life-runtime";
import { recordLifeDiagnostic } from "./life-diagnostics";
import { readLifeSceneForegroundLease } from "./life-scheduler-coordinator";

const SNAPSHOT_RULE_ID = "life-schedule";
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000;
let lastJson = "";
let lastSyncedAt = 0;

function foregroundLeaseSnapshot(): { foregroundSceneId: string; foregroundLeaseUntil: string } {
  const lease = readLifeSceneForegroundLease();
  return lease
    ? { foregroundSceneId: lease.sceneId, foregroundLeaseUntil: new Date(lease.expiresAt).toISOString() }
    : { foregroundSceneId: "", foregroundLeaseUntil: "" };
}


export async function syncLifeScheduleSnapshot(force = false): Promise<boolean> {
  if (typeof window === "undefined" || typeof fetch !== "function") return false;
  try {
    const state = loadVirtualLifeState();
    if (!state.settings.enabled) return false;
    const playerLocationId = resolveActorLocation(state, "player", "player")?.id ?? "";
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
    const characterLocations = Object.fromEntries([...characterIds].map(id => [id, resolveActorLocation(state, "character", id)?.id ?? ""]));
    // Keep the complete seven-day itinerary in the encrypted cloud snapshot. The
    // server can then evaluate the real current schedule while the WebView is closed,
    // instead of replaying an old "study/work" prompt for the entire repeat chain.
    const relevantOwnerIds = new Set([PLAYER_ID, ...characterIds]);
    const scheduleSlots = state.schedules
      .filter(slot => relevantOwnerIds.has(slot.ownerId)
        && (slot.ownerType === "player" || slot.ownerType === "character"))
      .map(slot => ({
        ownerType: slot.ownerType,
        ownerId: slot.ownerId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        title: slot.title,
        kind: slot.kind,
        plannedLocationId: slot.plannedLocationId ?? "",
        plannedLocationName: slot.plannedLocationName ?? "",
      }));
    const actorStates = state.actorStates
      .filter(actor => relevantOwnerIds.has(actor.ownerId))
      .map(actor => ({ ownerType: actor.ownerType, ownerId: actor.ownerId, activity: actor.activity }));
    const foregroundLease = foregroundLeaseSnapshot();
    const fingerprint = JSON.stringify({ version: 3, playerLocationId, scenes, characterLocations, scheduleSlots, actorStates, ...foregroundLease });
    if (!force && fingerprint === lastJson && Date.now() - lastSyncedAt < MAX_SNAPSHOT_AGE_MS) return true;
    const payload = { version: 3, updatedAt: new Date().toISOString(), playerLocationId, scenes, characterLocations, scheduleSlots, actorStates, ...foregroundLease };
    const response = await fetch("/api/push/bridge-snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots: [{ ruleId: SNAPSHOT_RULE_ID, payload }] }),
    });
    if (response.ok) {
      lastJson = fingerprint;
      lastSyncedAt = Date.now();
      recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "ok", detail: "玩家地点与 " + Object.keys(characterLocations).length + " 个角色地点已同步。", meta: { sceneCount: scenes.length, playerLocationId } });
      return true;
    }
    recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: "快照接口返回 HTTP " + response.status, meta: { playerLocationId } });
    return false;
  } catch (error) {
    recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
