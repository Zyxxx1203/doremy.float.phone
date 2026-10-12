import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import {
  createEmptyVirtualLifeState,
  DEFAULT_LIFE_ENGINE_SETTINGS,
  type LifeActorClock,
  type LifeEvent,
  type LifeEventStatus,
  type LifeEngineSettings,
  type VirtualLifeState,
} from "./life-types";

const STORAGE_KEY = "ai_phone_virtual_life_state_v1";
registerKvMigration(STORAGE_KEY);

function normalizeActorClock(value: unknown): LifeActorClock | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LifeActorClock>;
  if ((raw.ownerType !== "player" && raw.ownerType !== "character") || typeof raw.ownerId !== "string") return null;
  const validMode = raw.mode === "simulation" || raw.mode === "review" ? raw.mode : "real-time";
  const now = new Date().toISOString();
  const realAnchorAt = typeof raw.realAnchorAt === "string" ? raw.realAnchorAt : now;
  const virtualAnchorAt = typeof raw.virtualAnchorAt === "string" ? raw.virtualAnchorAt : realAnchorAt;
  const speed = typeof raw.speed === "number" && Number.isFinite(raw.speed) && raw.speed > 0 ? Math.min(raw.speed, 1000) : 1;
  return { ownerType: raw.ownerType, ownerId: raw.ownerId, mode: validMode, realAnchorAt, virtualAnchorAt, speed, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now };
}

function normalizeSettings(value: unknown): LifeEngineSettings {
  const raw = value && typeof value === "object" ? value as Partial<LifeEngineSettings> : {};
  const settings = { ...DEFAULT_LIFE_ENGINE_SETTINGS, ...raw };
  settings.defaultSpeed = Number.isFinite(settings.defaultSpeed) ? Math.max(0.01, Math.min(settings.defaultSpeed, 1000)) : 1;
  settings.panelOpacity = Number.isFinite(settings.panelOpacity) ? Math.max(50, Math.min(settings.panelOpacity, 100)) : 96;
  settings.dialogueFontSize = Number.isFinite(settings.dialogueFontSize) ? Math.max(12, Math.min(settings.dialogueFontSize, 24)) : 15;
  settings.narrationFontSize = Number.isFinite(settings.narrationFontSize) ? Math.max(10, Math.min(settings.narrationFontSize, 20)) : 12;
  if (!/^#[0-9a-f]{6}$/i.test(settings.accentColor)) settings.accentColor = DEFAULT_LIFE_ENGINE_SETTINGS.accentColor;
  return settings;
}

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
      speed: typeof clock.speed === "number" && Number.isFinite(clock.speed) && clock.speed > 0 ? Math.min(clock.speed, 1000) : 1,
    },
    actorClocks: Array.isArray(raw.actorClocks) ? raw.actorClocks.map(normalizeActorClock).filter((x): x is LifeActorClock => x !== null) : [],
    settings: normalizeSettings(raw.settings),
    locations: Array.isArray(raw.locations) ? raw.locations : [],
    actorStates: Array.isArray(raw.actorStates) ? raw.actorStates : [],
    schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],\n    sceneMessages: Array.isArray(raw.sceneMessages) ? raw.sceneMessages : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    invitations: Array.isArray(raw.invitations) ? raw.invitations : [],
    memories: Array.isArray(raw.memories) ? raw.memories : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : empty.updatedAt,
  };
}

/** Loads persisted state without generating schedules or advancing anyone's clock. */
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
  const saved = { ...state, schemaVersion: 1 as const, updatedAt: new Date().toISOString() };
  if (typeof window !== "undefined") kvSet(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

export function upsertLifeScheduleSlot(state: VirtualLifeState, slot: VirtualLifeState["schedules"][number]): VirtualLifeState {
  const schedules = state.schedules.filter(item => item.id !== slot.id);
  schedules.push({ ...slot, updatedAt: new Date().toISOString() });
  schedules.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return { ...state, schedules };
}

export function settleLifeEventOnce(
  state: VirtualLifeState,
  eventId: string,
  settlementKey: string,
  status: Extract<LifeEventStatus, "completed" | "cancelled">,
): { state: VirtualLifeState; changed: boolean } {
  const existing = state.events.find(event => event.id === eventId);
  if (!existing || existing.settlementKey === settlementKey || existing.status === "completed" || existing.status === "cancelled") {
    return { state, changed: false };
  }
  const now = new Date().toISOString();
  const nextEvent: LifeEvent = {
    ...existing, status, settlementKey, updatedAt: now,
    ...(status === "completed" ? { completedAt: now } : { cancelledAt: now }),
  };
  return { state: { ...state, events: state.events.map(event => event.id === eventId ? nextEvent : event) }, changed: true };
}
