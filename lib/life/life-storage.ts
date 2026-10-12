import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import {
  createEmptyVirtualLifeState,
  type LifeEvent,
  type LifeEventStatus,
  type VirtualLifeState,
} from "./life-types";

const STORAGE_KEY = "ai_phone_virtual_life_state_v1";
registerKvMigration(STORAGE_KEY);

function normalizeState(value: unknown): VirtualLifeState {
  if (!value || typeof value !== "object") return createEmptyVirtualLifeState();
  const raw = value as Partial<VirtualLifeState>;
  const empty = createEmptyVirtualLifeState();
  const clock = raw.clock && typeof raw.clock === "object" ? raw.clock : empty.clock;
  return {
    schemaVersion: 1,
    clock: {
      mode: clock.mode === "simulation" || clock.mode === "review" ? clock.mode : "real-time",
      realAnchorAt: typeof clock.realAnchorAt === "string" ? clock.realAnchorAt : empty.clock.realAnchorAt,
      simulationAnchorAt: typeof clock.simulationAnchorAt === "string" ? clock.simulationAnchorAt : null,
      speed: typeof clock.speed === "number" && Number.isFinite(clock.speed) && clock.speed > 0
        ? Math.min(clock.speed, 1000)
        : 1,
    },
    locations: Array.isArray(raw.locations) ? raw.locations : [],
    actorStates: Array.isArray(raw.actorStates) ? raw.actorStates : [],
    schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    invitations: Array.isArray(raw.invitations) ? raw.invitations : [],
    memories: Array.isArray(raw.memories) ? raw.memories : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : empty.updatedAt,
  };
}

/** Loads the single persisted state; does not generate schedules or advance time. */
export function loadVirtualLifeState(): VirtualLifeState {
  if (typeof window === "undefined") return createEmptyVirtualLifeState();
  try {
    const raw = kvGet(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : createEmptyVirtualLifeState();
  } catch {
    return createEmptyVirtualLifeState();
  }
}

export function saveVirtualLifeState(state: VirtualLifeState): VirtualLifeState {
  const saved: VirtualLifeState = {
    ...state,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  };
  if (typeof window !== "undefined") kvSet(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

/**
 * Upserts a schedule slot by stable id. Callers should update only the affected
 * future slots when plans change, not regenerate an entire week.
 */
export function upsertLifeScheduleSlot(
  state: VirtualLifeState,
  slot: VirtualLifeState["schedules"][number],
): VirtualLifeState {
  const schedules = state.schedules.filter(item => item.id !== slot.id);
  schedules.push({ ...slot, updatedAt: new Date().toISOString() });
  schedules.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return { ...state, schedules };
}

/** Settle an event exactly once; repeated scheduler/push retries are harmless. */
export function settleLifeEventOnce(
  state: VirtualLifeState,
  eventId: string,
  settlementKey: string,
  status: Extract<LifeEventStatus, "completed" | "cancelled">,
): { state: VirtualLifeState; changed: boolean } {
  const existing = state.events.find(event => event.id === eventId);
  if (!existing) return { state, changed: false };
  if (
    existing.settlementKey === settlementKey
    || existing.status === "completed"
    || existing.status === "cancelled"
  ) {
    return { state, changed: false };
  }
  const now = new Date().toISOString();
  const nextEvent: LifeEvent = {
    ...existing,
    status,
    settlementKey,
    updatedAt: now,
    ...(status === "completed" ? { completedAt: now } : { cancelledAt: now }),
  };
  return {
    state: { ...state, events: state.events.map(event => event.id === eventId ? nextEvent : event) },
    changed: true,
  };
}
