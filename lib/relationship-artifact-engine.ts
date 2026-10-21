/**
 * Relationship event/execution layer.
 *
 * Decisions are made from the existing relationship state values and recent chat,
 * while execution is responsible for producing a persistent, clickable keepsake card.
 * This module intentionally does not access the device camera or silently capture screens.
 */
import { loadChatMessages, loadChatSessions, pushChatMessage, type ChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";

export type RelationshipArtifactType =
  | "apology" | "reflection" | "reconciliation" | "confession" | "privilege"
  | "jealousy" | "candid_photo" | "couple_photo" | "invitation" | "promise";

export type RelationshipEventKind = "argument" | "reconciliation" | "jealousy" | "affection" | "date" | "spontaneous";

export type RelationshipArtifactDraft = {
  type: RelationshipArtifactType;
  title: string;
  subtitle?: string;
  body: string;
  signature?: string;
  imageUrl?: string;
  accent?: string;
  eventId?: string;
};

const STORAGE_KEY = "momo.relationship-artifacts.v1";
const COOLDOWN_KEY = "momo.relationship-artifact-cooldowns.v1";

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be full */ }
}

export type RelationshipArtifactRecord = RelationshipArtifactDraft & {
  id: string;
  characterId: string;
  sessionId: string;
  createdAt: string;
  acknowledgedAt?: string;
};

export function listRelationshipArtifacts(characterId?: string): RelationshipArtifactRecord[] {
  const all = readJson<RelationshipArtifactRecord[]>(STORAGE_KEY, []);
  return all.filter(item => !characterId || item.characterId === characterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markRelationshipArtifactAcknowledged(id: string): void {
  const all = readJson<RelationshipArtifactRecord[]>(STORAGE_KEY, []);
  writeJson(STORAGE_KEY, all.map(item => item.id === id ? { ...item, acknowledgedAt: new Date().toISOString() } : item));
}

function artifactAccent(type: RelationshipArtifactType): string {
  if (type === "privilege" || type === "invitation") return "#b18b4f";
  if (type === "reflection" || type === "candid_photo") return "#9b7a69";
  if (type === "jealousy" || type === "promise") return "#a87883";
  return "#bd7189";
}

/** Store an artifact and deliver a special chat card. Repeated event IDs are idempotent. */
export function deliverRelationshipArtifact(
  sessionId: string,
  characterId: string,
  draft: RelationshipArtifactDraft,
): RelationshipArtifactRecord | null {
  if (typeof window === "undefined" || !sessionId || !characterId || !draft.body.trim()) return null;
  const eventId = draft.eventId?.trim();
  const existing = listRelationshipArtifacts(characterId).find(item =>
    eventId && item.eventId === eventId && item.sessionId === sessionId
  );
  if (existing) return existing;

  const record: RelationshipArtifactRecord = {
    ...draft,
    id: `keepsake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    sessionId,
    createdAt: new Date().toISOString(),
    accent: draft.accent || artifactAccent(draft.type),
  };
  const all = readJson<RelationshipArtifactRecord[]>(STORAGE_KEY, []);
  writeJson(STORAGE_KEY, [record, ...all].slice(0, 500));

  pushChatMessage({
    sessionId,
    role: "assistant",
    content: record.body,
    mediaType: "relationship_artifact",
    mediaData: {
      relationshipArtifactId: record.id,
      relationshipArtifactType: record.type,
      appCardTitle: record.title,
      relationshipArtifactSubtitle: record.subtitle,
      relationshipArtifactBody: record.body,
      relationshipArtifactSignature: record.signature,
      relationshipArtifactAccent: record.accent,
      relationshipArtifactImageUrl: record.imageUrl,
    },
  });
  return record;
}

export type RelationshipEventDecision = {
  eligible: boolean;
  kind: RelationshipEventKind;
  suggestedArtifact: RelationshipArtifactType;
  reason: string;
};

/**
 * Event-layer recommendation, not an unconditional trigger.
 * The caller should provide a stable event ID and let the character's response/context
 * supply the actual prose. Existing state values are reused; no second emotion scale.
 */
export function evaluateRelationshipEvent(input: {
  event: RelationshipEventKind;
  stateValues?: Array<{ name: string; value: number }>;
  recentMessages?: Array<Pick<ChatMessage, "role" | "content" | "createdAt">>;
  lastArtifactAt?: string;
  now?: number;
}): RelationshipEventDecision {
  const values = input.stateValues || [];
  const find = (terms: string[]) => values.find(v => terms.some(t => v.name.includes(t)))?.value ?? 0;
  const possessiveness = find(["占有欲"]);
  const jealousy = find(["吃醋", "嫉妒"]);
  const trust = find(["信任"]);
  const now = input.now ?? Date.now();
  const last = input.lastArtifactAt ? new Date(input.lastArtifactAt).getTime() : 0;
  const cooldownPassed = !last || !Number.isFinite(last) || now - last >= 6 * 60 * 60 * 1000;
  const recentText = (input.recentMessages || []).slice(-8).map(m => m.content).join("\n");
  const recentArgument = /吵架|生气|误会|冷战|分手|道歉|和好/.test(recentText);

  let suggestedArtifact: RelationshipArtifactType = "confession";
  let reason = "关系氛围适合留下一份小小的心意";
  if (input.event === "argument") {
    suggestedArtifact = trust < 35 ? "reflection" : "apology";
    reason = "发生争执后，用认真回应而不是强行跳过矛盾";
  } else if (input.event === "reconciliation") {
    suggestedArtifact = "reconciliation";
    reason = "和好后把这次关系变化留成纪念";
  } else if (input.event === "jealousy") {
    suggestedArtifact = possessiveness >= 70 || jealousy >= 60 ? "privilege" : "jealousy";
    reason = "占有欲/吃醋状态较强，可用带边界感的表达传递在意";
  } else if (input.event === "date") {
    suggestedArtifact = "invitation";
    reason = "把约会变成可回看的邀请函";
  } else if (input.event === "affection") {
    suggestedArtifact = possessiveness >= 75 ? "promise" : "confession";
    reason = "亲密互动后留下一份专属纪念";
  } else if (input.event === "spontaneous") {
    suggestedArtifact = Math.random() < 0.5 ? "candid_photo" : "couple_photo";
    reason = "偶发的生活瞬间适合成为照片收藏";
  }

  const eligible = cooldownPassed && (
    input.event === "argument" || input.event === "reconciliation" || input.event === "date" ||
    (input.event === "jealousy" && (possessiveness >= 55 || jealousy >= 50)) ||
    (input.event === "affection" && (possessiveness >= 45 || recentArgument)) ||
    (input.event === "spontaneous" && Math.random() < 0.2)
  );
  return { eligible, kind: input.event, suggestedArtifact, reason };
}

/** Used by event dispatchers to avoid repeating popups/cards after re-render or reload. */
export function canFireRelationshipEvent(characterId: string, eventKey: string, cooldownMs = 6 * 60 * 60 * 1000): boolean {
  const key = `${characterId}:${eventKey}`;
  const map = readJson<Record<string, number>>(COOLDOWN_KEY, {});
  const last = map[key] || 0;
  if (Date.now() - last < cooldownMs) return false;
  map[key] = Date.now();
  writeJson(COOLDOWN_KEY, map);
  return true;
}

export function getRelationshipCharacterName(characterId: string): string {
  return loadCharacters().find(item => item.id === characterId)?.name || "TA";
}

export function getRelationshipSession(sessionId: string) {
  return loadChatSessions().find(item => item.id === sessionId) || null;
}

export function getRecentRelationshipMessages(sessionId: string, count = 12): ChatMessage[] {
  return loadChatMessages(sessionId).slice(-Math.max(1, count));
}
