/**
 * Virtual Life Engine domain model.
 *
 * Keep life-scene conversations separate from the existing long-form offline
 * story mode. These types intentionally describe state, not UI components.
 */

export type LifeInteractionMode = "online-chat" | "life-scene" | "story-mode";
export type LifeClockMode = "real-time" | "simulation" | "review";
export type LifeOwnerType = "player" | "character";
export type LifeEventStatus = "planned" | "confirmed" | "active" | "completed" | "cancelled";

export type LifeClockState = {
  mode: LifeClockMode;
  /** ISO timestamp for the last clock synchronization. */
  realAnchorAt: string;
  /** Simulated ISO time at the anchor; null means use real time. */
  simulationAnchorAt?: string | null;
  /** Simulation speed multiplier; 1 means one virtual minute per real minute. */
  speed: number;
};

export type LifeScheduleSlot = {
  id: string;
  ownerType: LifeOwnerType;
  ownerId: string;
  startAt: string;
  endAt: string;
  title: string;
  plannedLocationId?: string | null;
  plannedLocationName?: string | null;
  kind: "habit" | "work" | "study" | "meal" | "commute" | "free-time" | "appointment" | "special";
  source: "weekly-generation" | "manual" | "event";
  /** Slots are persisted so opening the app does not regenerate a person's week. */
  updatedAt: string;
};

export type LifeLocation = {
  id: string;
  name: string;
  description?: string;
  visibility: "public" | "private";
};

export type LifeActorState = {
  ownerType: LifeOwnerType;
  ownerId: string;
  /** What the person is actually doing now, not merely what was planned. */
  activity: string;
  actualLocationId?: string | null;
  actualLocationName?: string | null;
  updatedAt: string;
};

export type LifeSceneParticipant = {
  ownerType: LifeOwnerType;
  ownerId: string;
  /** Per-scene activity/state. */
  activity: string;
  /** Whether this participant currently notices the player/other participants. */
  awarenessByActorId: Record<string, "unaware" | "suspects" | "aware">;
};

export type LifeSceneState = {
  id: string;
  locationId: string;
  locationName: string;
  startedAt: string;
  updatedAt: string;
  status: "active" | "paused" | "completed";
  participants: LifeSceneParticipant[];
  /** Stable scene state means reopening resumes, rather than recreating the event. */
  lastSettledEventIds: string[];
};

export type LifeEvent = {
  id: string;
  kind: "encounter" | "invitation" | "activity" | "life-change" | "memory";
  status: LifeEventStatus;
  startsAt?: string;
  endsAt?: string;
  locationId?: string;
  locationName?: string;
  participantIds: string[];
  title: string;
  details?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  /** Prevent duplicate settlement after restart, time-skip or push retry. */
  settlementKey?: string;
};

export type LifeInvitation = {
  id: string;
  characterId: string;
  playerId: string;
  proposedAt: string;
  locationId?: string;
  locationName?: string;
  activity: string;
  status: "proposed" | "confirmed" | "declined" | "cancelled" | "completed";
  confirmedAt?: string;
  updatedAt: string;
  eventId?: string;
};

export type LifeMemoryFact = {
  id: string;
  eventId: string;
  occurredAt: string;
  participants: string[];
  fact: string;
  /** Optional character interpretation is kept distinct from the observed fact. */
  interpretations?: Record<string, string>;
};

export type VirtualLifeState = {
  schemaVersion: 1;
  clock: LifeClockState;
  locations: LifeLocation[];
  actorStates: LifeActorState[];
  schedules: LifeScheduleSlot[];
  scenes: LifeSceneState[];
  events: LifeEvent[];
  invitations: LifeInvitation[];
  memories: LifeMemoryFact[];
  updatedAt: string;
};

export function createEmptyVirtualLifeState(now = new Date().toISOString()): VirtualLifeState {
  return {
    schemaVersion: 1,
    clock: { mode: "real-time", realAnchorAt: now, simulationAnchorAt: null, speed: 1 },
    locations: [],
    actorStates: [],
    schedules: [],
    scenes: [],
    events: [],
    invitations: [],
    memories: [],
    updatedAt: now,
  };
}
