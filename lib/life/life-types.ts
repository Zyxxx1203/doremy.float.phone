/**
 * Virtual Life Engine domain model.
 *
 * Life-scene is intentionally separate from online chat and long-form story mode.
 * Persistent entities are kept serializable so they can use the existing KV layer.
 */
export type LifeInteractionMode = "online-chat" | "life-scene" | "story-mode";
export type LifeClockMode = "real-time" | "simulation" | "review";
export type LifeOwnerType = "player" | "character";
export type LifeEventStatus = "planned" | "confirmed" | "active" | "completed" | "cancelled";

export type LifeClockState = {
  mode: LifeClockMode;
  realAnchorAt: string;
  simulationAnchorAt?: string | null;
  speed: number;
};

/** Independent clock: changing one actor never mutates any other actor's time. */
export type LifeActorClock = {
  ownerType: LifeOwnerType;
  ownerId: string;
  mode: LifeClockMode;
  realAnchorAt: string;
  virtualAnchorAt: string;
  speed: number;
  updatedAt: string;
};

export type LifeEngineSettings = {
  playerDisplayName: string;
  enabled: boolean;
  autoGenerateWeeklyPlans: boolean;
  generateSpecialEvents: boolean;
  enableCoincidences: boolean;
  enableCharacterAutonomy: boolean;
  enableInvitations: boolean;
  saveConfirmedEventsToMemory: boolean;
  showActionNarration: boolean;
  keepDialogueConcise: boolean;
  allowCharactersToStaySilent: boolean;
  revealExactLocations: "ask-only" | "clues" | "open";
  defaultClockMode: LifeClockMode;
  defaultSpeed: number;
  sceneTheme: "warm-paper" | "night-sky" | "sage" | "rose" | "custom";
  accentColor: string;
  panelOpacity: number;
  dialogueFontSize: number;
  narrationFontSize: number;
  dialogueBubbleStyle: "rounded" | "soft" | "square";
  compactLayout: boolean;
  showTimeline: boolean;
  showLocationHints: boolean;
  enableAmbientDetails: boolean;
  autoGenerateSceneImages: boolean;
  sceneImageCount: 1 | 2 | 3 | 4;
  sceneImageStyle: string;
  userAppearanceDescription: string;
  userAppearanceReferenceAssetId?: string;
  customPrompt: string;
};
export const DEFAULT_LIFE_ENGINE_SETTINGS: LifeEngineSettings = {
  playerDisplayName: "我",
  enabled: true,
  autoGenerateWeeklyPlans: true,
  generateSpecialEvents: true,
  enableCoincidences: true,
  enableCharacterAutonomy: true,
  enableInvitations: true,
  saveConfirmedEventsToMemory: true,
  showActionNarration: true,
  keepDialogueConcise: true,
  allowCharactersToStaySilent: true,
  revealExactLocations: "clues",
  defaultClockMode: "real-time",
  defaultSpeed: 1,
  sceneTheme: "warm-paper",
  accentColor: "#b88768",
  panelOpacity: 96,
  dialogueFontSize: 15,
  narrationFontSize: 12,
  dialogueBubbleStyle: "rounded",
  compactLayout: false,
  showTimeline: true,
  showLocationHints: true,
  enableAmbientDetails: true,
  autoGenerateSceneImages: false,
  sceneImageCount: 2,
  sceneImageStyle: "温暖自然的生活感，电影级构图，表情与动作自然，保持角色外观一致",
  userAppearanceDescription: "",
  customPrompt: "",
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
  activity: string;
  scheduleSlotId?: string | null;
  actualLocationId?: string | null;
  actualLocationName?: string | null;
  updatedAt: string;
};

export type LifeSceneParticipant = {
  ownerType: LifeOwnerType;
  ownerId: string;
  activity: string;
  awarenessByActorId: Record<string, "unaware" | "suspects" | "aware">;
};

export type LifeSceneMessage = {
  id: string;
  sceneId: string;
  speakerType: LifeOwnerType;
  speakerId: string;
  speakerName: string;
  role: "player" | "character" | "system";
  action?: string;
  dialogue: string;
  createdAt: string;
};

export type LifeSceneImage = {
  id: string;
  sceneId: string;
  mediaRef: string;
  prompt: string;
  participantIds: string[];
  createdAt: string;
  status: "active" | "archived";
  alt?: string;
};

export type LifeSceneState = {
  id: string;
  locationId: string;
  locationName: string;
  startedAt: string;
  updatedAt: string;
  status: "active" | "paused" | "completed";
  eventId?: string;
  participants: LifeSceneParticipant[];
  lastSettledEventIds: string[];
  images?: LifeSceneImage[];
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
  settlementKey?: string;
};

export type LifeInvitation = {
  id: string;
  kind?: "appointment" | "follow-request";
  durationMinutes?: number;
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
  interpretations?: Record<string, string>;
};

export type VirtualLifeState = {
  schemaVersion: 1;
  clock: LifeClockState;
  actorClocks: LifeActorClock[];
  settings: LifeEngineSettings;
  locations: LifeLocation[];
  actorStates: LifeActorState[];
  schedules: LifeScheduleSlot[];
  scenes: LifeSceneState[];
  sceneMessages: LifeSceneMessage[];
  events: LifeEvent[];
  invitations: LifeInvitation[];
  memories: LifeMemoryFact[];
  updatedAt: string;
};

export function createEmptyVirtualLifeState(now = new Date().toISOString()): VirtualLifeState {
  return {
    schemaVersion: 1,
    clock: { mode: "real-time", realAnchorAt: now, simulationAnchorAt: null, speed: 1 },
    actorClocks: [],
    settings: { ...DEFAULT_LIFE_ENGINE_SETTINGS },
    locations: [],
    actorStates: [],
    schedules: [],
    scenes: [],\n    sceneMessages: [],
    events: [],
    invitations: [],
    memories: [],
    updatedAt: now,
  };
}
