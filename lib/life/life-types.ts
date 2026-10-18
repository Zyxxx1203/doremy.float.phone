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

export type LifePromptPreset = {
  id: string;
  name: string;
  description?: string;
  sourcePresetId?: string;
  sourcePresetName?: string;
  basePresetPrompt?: string;
  sceneOutputPrompt?: string;
  sceneBehaviorPrompt?: string;
  sceneTaskPrompt?: string;
  toolCallingPrompt?: string;
  scheduleGenerationPrompt?: string;
  invitationResponsePrompt?: string;
  locationHabitPrompt?: string;
  customPrompt?: string;
};

export type LifeEngineSettings = {
  promptPresets?: LifePromptPreset[];
  activePromptPresetId?: string;
  playerDisplayName: string;
  enabled: boolean;
  autoGenerateWeeklyPlans: boolean;
  generateSpecialEvents: boolean;
  enableCoincidences: boolean;
  enableCharacterAutonomy: boolean;
  enableScheduleChangeTool: boolean;
  enableFollowRequestTool: boolean;
  enableInvitations: boolean;
  saveConfirmedEventsToMemory: boolean;
  showActionNarration: boolean;
  keepDialogueConcise: boolean;
  allowCharactersToStaySilent: boolean;
  revealExactLocations: "ask-only" | "clues" | "open";
  defaultClockMode: LifeClockMode;
  defaultSpeed: number;
  sceneTheme: "warm-paper" | "night-sky" | "sage" | "rose" | "lavender" | "ocean" | "matcha" | "peach" | "midnight" | "custom";
  accentColor: string;
  accentColorMode?: "theme" | "custom";
  panelOpacity: number;
  dialogueFontSize: number;
  narrationFontSize: number;
  /** CSS font-family for dialogue; accepts a system font name or CSS font stack. */
  dialogueFontFamily: string;
  /** CSS font-family for narration and scene cards. */
  narrationFontFamily: string;
  /** Inner padding for life-scene dialogue bubbles, in pixels. */
  bubblePadding: number;
  /** Vertical gap between life-scene messages, in pixels. */
  messageGapPx: number;
  /** Vertical gap between narration and dialogue within a turn, in pixels. */
  narrationGapPx: number;
  /** Dialogue messages combined into one life timeline record. */
  sceneRecordBatchSize?: number;
  dialogueBubbleStyle: "rounded" | "soft" | "square";
  /** User CSS overrides for the life scene chat only. */
  customSceneCss?: string;
  compactLayout: boolean;
  showTimeline: boolean;
  showLocationHints: boolean;
  recordLocationChanges: boolean;
  recordSceneMessages: boolean;
  recordCharacterActions: boolean;
  recordScheduleChanges: boolean;
  recordToolCalls: boolean;
  recordSocialActivity: boolean;
  recordDiaryActivity: boolean;
  recordChatActivity: boolean;
  enableAmbientDetails: boolean;
  /** Let present characters occasionally initiate short life-scene dialogue. */
  enableProactiveSceneMessages?: boolean;
  /** Minimum real-time minutes between proactive turns in an active scene. */
  proactiveSceneIntervalMinutes?: number;
  /** Maximum real-time minutes between proactive turns; the next interval is randomized within the range. */
  proactiveSceneIntervalMaxMinutes?: number;
  /** Request a browser/system notification for a proactive scene message. */
  enableLifeMessageNotifications?: boolean;
  /** Allow server-side proactive scene jobs while the app is backgrounded or terminated. */
  enableLifeOfflinePush?: boolean;
  autoGenerateSceneImages: boolean;
  sceneImageCount: 1 | 2 | 3 | 4;
  sceneImageStyle: string;
  sceneImagePrompt: string;
  customPrompt: string;
};
export const DEFAULT_LIFE_ENGINE_SETTINGS: LifeEngineSettings = {
  playerDisplayName: "我",
  enabled: true,
  autoGenerateWeeklyPlans: true,
  generateSpecialEvents: true,
  enableCoincidences: true,
  enableCharacterAutonomy: true,
  enableScheduleChangeTool: true,
  enableFollowRequestTool: true,
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
  accentColorMode: "theme",
  panelOpacity: 96,
  dialogueFontSize: 13,
  narrationFontSize: 12,
  dialogueFontFamily: "",
  narrationFontFamily: "",
  bubblePadding: 3,
  messageGapPx: 4,
  narrationGapPx: 4,
  sceneRecordBatchSize: 10,
  dialogueBubbleStyle: "rounded",
  customSceneCss: "",
  compactLayout: false,
  showTimeline: true,
  showLocationHints: true,
  recordLocationChanges: true,
  recordSceneMessages: true,
  recordCharacterActions: true,
  recordScheduleChanges: true,
  recordToolCalls: true,
  recordSocialActivity: true,
  recordDiaryActivity: true,
  recordChatActivity: true,
  enableAmbientDetails: true,
  enableProactiveSceneMessages: true,
  proactiveSceneIntervalMinutes: 5,
  proactiveSceneIntervalMaxMinutes: 15,
  enableLifeMessageNotifications: true,
  enableLifeOfflinePush: true,
  autoGenerateSceneImages: false,
  sceneImageCount: 2,
  sceneImageStyle: "温暖自然的生活感，电影级构图，表情与动作自然，保持角色外观一致",
  sceneImagePrompt: "",
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
  source: "weekly-generation" | "manual" | "event" | "character-tool";
  updatedAt: string;
};

export type LifeLocation = {
  id: string;
  name: string;
  description?: string;
  /** Alternate names used to match generated itinerary places back to this canonical location. */
  aliases?: string[];
  /** Per-character habits at this location, keyed by character ID. */
  characterHabits?: Record<string, string>;
  /** Character IDs explicitly sharing the player's home. */
  residents?: string[];
  /** User-authored atmosphere cues used by the live scene prompt and location cards. */
  atmosphere?: string;
  /** Stable spatial layout: where the door, seats, windows, counters, etc. are. */
  layout?: string;
  /** Persistent props/objects that can be referenced by later actions and dialogue. */
  props?: string[];
  visibility: "public" | "private";
};

export type LifeActorState = {
  ownerType: LifeOwnerType;
  ownerId: string;
  activity: string;
  scheduleSlotId?: string | null;
  actualLocationId?: string | null;
  actualLocationName?: string | null;
  /** Optional virtual-life time when a manually chosen location stay ends and the planned itinerary resumes. */
  actualLocationUntil?: string | null;
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
  /** Last scene-state fingerprint successfully auto-rendered; prevents duplicate cost after reopening. */
  lastAutoImageFingerprint?: string;
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
  /** Who initiated the invitation; old saved records omit this and are treated as character-origin. */
  proposedBy?: "player" | "character";
  responseReason?: string;
  kind?: "appointment" | "follow-request";
  durationMinutes?: number;
  characterId: string;
  playerId: string;
  proposedAt: string;
  locationId?: string;
  locationName?: string;
  activity: string;
  /** Why the inviter wants to meet; shown separately from the event/activity. */
  reason?: string;
  status: "proposed" | "confirmed" | "declined" | "cancelled" | "completed";
  confirmedAt?: string;
  updatedAt: string;
  eventId?: string;
};

export type LifeTimelineCategory = "location" | "scene" | "action" | "dialogue" | "schedule" | "tool" | "social" | "diary" | "chat" | "system";

export type LifeTimelineEntry = {
  id: string;
  category: LifeTimelineCategory;
  occurredAt: string;
  /** Real persistence time, used for incremental memory sync; occurredAt follows virtual life time. */
  recordedAt?: string;
  title: string;
  details?: string;
  actorId?: string;
  actorName?: string;
  locationName?: string;
  sceneId?: string;
  /** Related scene message id, chat session id, post id, diary id, or tool call id. */
  sourceId?: string;
  /** Optional user-requested illustration for this life record, stored in the existing media cache. */
  imageMediaRef?: string;
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
  /** Version of role-card-aware weekly schedule templates already applied. */
  scheduleProfileVersion?: number;
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
  timeline: LifeTimelineEntry[];
  updatedAt: string;
};

export function createEmptyVirtualLifeState(now = new Date().toISOString()): VirtualLifeState {
  return {
    schemaVersion: 1,
    scheduleProfileVersion: 3,
    clock: { mode: "real-time", realAnchorAt: now, simulationAnchorAt: null, speed: 1 },
    actorClocks: [],
    settings: { ...DEFAULT_LIFE_ENGINE_SETTINGS },
    locations: [],
    actorStates: [],
    schedules: [],
    scenes: [],
    sceneMessages: [],
    events: [],
    invitations: [],
    memories: [],
    timeline: [],
    updatedAt: now,
  };
}
