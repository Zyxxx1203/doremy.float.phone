import type {
  LifeActorState,
  LifeClockState,
  LifeEvent,
  LifeEventStatus,
  LifeInvitation,
  LifeScheduleSlot,
  LifeSceneState,
  VirtualLifeState,
} from "./life-types";

/** Resolve virtual time without mutating state. Simulation never advances by itself. */
export function resolveLifeNow(clock: LifeClockState, realNow = new Date()): Date {
  if (clock.mode !== "simulation" || !clock.simulationAnchorAt) return realNow;
  const realAnchor = new Date(clock.realAnchorAt);
  const simulatedAnchor = new Date(clock.simulationAnchorAt);
  if (!Number.isFinite(realAnchor.getTime()) || !Number.isFinite(simulatedAnchor.getTime())) return realNow;
  const elapsed = Math.max(0, realNow.getTime() - realAnchor.getTime());
  return new Date(simulatedAnchor.getTime() + elapsed * Math.max(0.01, Math.min(clock.speed, 1000)));
}

/** Explicit user-driven simulation jump; calling this is the only fast-forward operation. */
export function fastForwardLifeClock(
  clock: LifeClockState,
  minutes: number,
  realNow = new Date(),
): LifeClockState {
  const current = resolveLifeNow(clock, realNow);
  const next = new Date(current.getTime() + Math.max(0, minutes) * 60_000);
  return {
    mode: "simulation",
    realAnchorAt: realNow.toISOString(),
    simulationAnchorAt: next.toISOString(),
    speed: clock.speed,
  };
}

/** Leaving simulation deliberately requires an explicit user choice. */
export function realignLifeClock(clock: LifeClockState, choice: "continue-simulation" | "align-to-real", realNow = new Date()): LifeClockState {
  if (choice === "continue-simulation") {
    const current = resolveLifeNow(clock, realNow);
    return { mode: "simulation", realAnchorAt: realNow.toISOString(), simulationAnchorAt: current.toISOString(), speed: clock.speed };
  }
  return { mode: "real-time", realAnchorAt: realNow.toISOString(), simulationAnchorAt: null, speed: 1 };
}

export function findCurrentScheduleSlot(
  slots: LifeScheduleSlot[],
  ownerType: LifeScheduleSlot["ownerType"],
  ownerId: string,
  at: Date,
): LifeScheduleSlot | undefined {
  const time = at.getTime();
  return slots
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
    .filter(slot => new Date(slot.startAt).getTime() <= time && new Date(slot.endAt).getTime() > time)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
}

/** Plan slots can suggest whereabouts; they must never overwrite actual location. */
export function getPlannedLocationHint(
  slots: LifeScheduleSlot[],
  ownerType: LifeScheduleSlot["ownerType"],
  ownerId: string,
  at: Date,
): { locationId?: string | null; locationName?: string | null } | null {
  const slot = findCurrentScheduleSlot(slots, ownerType, ownerId, at);
  if (!slot) return null;
  return { locationId: slot.plannedLocationId, locationName: slot.plannedLocationName };
}

export type EncounterPerception = {
  distance: "near" | "medium" | "far";
  lineOfSight: boolean;
  audible: boolean;
  attention: "focused" | "normal" | "distracted";
  activity: "busy" | "casual" | "waiting";
  noticing: number;
  environmentNoise: number;
};

/** Awareness is evaluated independently; sharing a location alone does not imply noticing. */
export function evaluateEncounterAwareness(input: EncounterPerception, seed = 0): "unaware" | "suspects" | "aware" {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const distanceScore = input.distance === "near" ? 0.38 : input.distance === "medium" ? 0.17 : 0.02;
  const sightScore = input.lineOfSight ? 0.28 : 0;
  const soundScore = input.audible ? 0.14 * (1 - clamp(input.environmentNoise)) : 0;
  const attentionScore = input.attention === "focused" ? 0.02 : input.attention === "normal" ? 0.1 : 0.18;
  const activityScore = input.activity === "waiting" ? 0.16 : input.activity === "casual" ? 0.08 : 0;
  const score = clamp(distanceScore + sightScore + soundScore + attentionScore + activityScore + clamp(input.noticing) * 0.2);
  // Small stable variation prevents every encounter with identical inputs feeling scripted.
  const adjusted = clamp(score + ((Math.abs(seed) % 11) - 5) * 0.012);
  if (adjusted >= 0.55) return "aware";
  if (adjusted >= 0.3) return "suspects";
  return "unaware";
}

export function findActorState(
  state: VirtualLifeState,
  ownerType: LifeActorState["ownerType"],
  ownerId: string,
): LifeActorState | undefined {
  return state.actorStates.find(actor => actor.ownerType === ownerType && actor.ownerId === ownerId);
}

export function upsertActorState(state: VirtualLifeState, nextActor: LifeActorState): VirtualLifeState {
  const actorStates = state.actorStates.filter(actor =>
    !(actor.ownerType === nextActor.ownerType && actor.ownerId === nextActor.ownerId),
  );
  actorStates.push({ ...nextActor, updatedAt: new Date().toISOString() });
  return { ...state, actorStates };
}

export function upsertLifeEvent(state: VirtualLifeState, nextEvent: LifeEvent): VirtualLifeState {
  const events = state.events.filter(event => event.id !== nextEvent.id);
  events.push(nextEvent);
  events.sort((a, b) => (a.startsAt || a.createdAt).localeCompare(b.startsAt || b.createdAt));
  return { ...state, events };
}

export function transitionLifeEvent(
  state: VirtualLifeState,
  eventId: string,
  nextStatus: LifeEventStatus,
): VirtualLifeState {
  const current = state.events.find(event => event.id === eventId);
  if (!current) return state;
  const allowed: Record<LifeEventStatus, LifeEventStatus[]> = {
    planned: ["confirmed", "active", "cancelled"],
    confirmed: ["active", "cancelled"],
    active: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  };
  if (!allowed[current.status].includes(nextStatus)) return state;
  const now = new Date().toISOString();
  const updated: LifeEvent = {
    ...current,
    status: nextStatus,
    updatedAt: now,
    ...(nextStatus === "completed" ? { completedAt: now } : {}),
    ...(nextStatus === "cancelled" ? { cancelledAt: now } : {}),
  };
  return { ...state, events: state.events.map(event => event.id === eventId ? updated : event) };
}

export function transitionInvitation(
  state: VirtualLifeState,
  invitationId: string,
  action: "confirm" | "decline" | "cancel",
): VirtualLifeState {
  const current = state.invitations.find(invite => invite.id === invitationId);
  if (!current || current.status !== "proposed") return state;
  const now = new Date().toISOString();
  const status: LifeInvitation["status"] = action === "confirm" ? "confirmed" : action === "decline" ? "declined" : "cancelled";
  const next = { ...current, status, updatedAt: now, ...(action === "confirm" ? { confirmedAt: now } : {}) };
  return { ...state, invitations: state.invitations.map(invite => invite.id === invitationId ? next : invite) };
}

export function upsertLifeScene(state: VirtualLifeState, scene: LifeSceneState): VirtualLifeState {
  const scenes = state.scenes.filter(item => item.id !== scene.id);
  scenes.push(scene);
  return { ...state, scenes };
}
