import type { LifeSceneState, LifeSceneMessage } from "./life-types";

export const LIFE_AUTONOMY_TICK_MS = 30_000;
export const LIFE_AUTONOMY_MIN_GAP_MS = 4 * 60_000;
export const LIFE_AUTONOMY_MAX_GAP_MS = 9 * 60_000;
export const LIFE_AUTONOMY_SCENE_COOLDOWN_MS = 2 * 60_000;
export const LIFE_AUTONOMY_DAILY_LIMIT = 12;

export type LifeAutonomyDecision = {
  eligible: boolean;
  reason: string;
  characterIds: string[];
};

/**
 * Deterministic guardrails for proactive life-scene turns.
 * The model decides what to say; this layer decides whether a turn is allowed.
 */
export function evaluateLifeAutonomyWindow(input: {
  scene: LifeSceneState | null;
  playerId: string;
  messages: LifeSceneMessage[];
  now?: number;
  lastAttemptAt?: number;
  intervalMinutes?: number;
  busy: boolean;
  visible: boolean;
  enabled: boolean;
}): LifeAutonomyDecision {
  const now = input.now ?? Date.now();
  const scene = input.scene;
  if (!input.enabled) return { eligible: false, reason: "disabled", characterIds: [] };
  if (!scene || scene.status !== "active") return { eligible: false, reason: "no-active-scene", characterIds: [] };
  if (!input.visible) return { eligible: false, reason: "app-not-visible", characterIds: [] };
  if (input.busy) return { eligible: false, reason: "another-turn-running", characterIds: [] };

  const playerPresent = scene.participants.some(p => p.ownerType === "player" && p.ownerId === input.playerId);
  if (!playerPresent) return { eligible: false, reason: "player-not-present", characterIds: [] };

  const characterIds = [...new Set(scene.participants
    .filter(p => p.ownerType === "character" && p.ownerId && p.activity !== "离开")
    .map(p => p.ownerId))];
  if (!characterIds.length) return { eligible: false, reason: "no-character-present", characterIds: [] };

  const lastMessage = [...input.messages].reverse().find(m => m.sceneId === scene.id);
  if (lastMessage && now - new Date(lastMessage.createdAt).getTime() < LIFE_AUTONOMY_SCENE_COOLDOWN_MS) {
    return { eligible: false, reason: "recent-scene-message", characterIds };
  }

  const minimumGap = Math.max(2, input.intervalMinutes ?? 5) * 60_000;
  if (input.lastAttemptAt && now - input.lastAttemptAt < minimumGap) {
    return { eligible: false, reason: "cooldown", characterIds };
  }

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const countToday = input.messages.filter(m =>
    m.sceneId === scene.id && m.role === "character" && new Date(m.createdAt).getTime() >= dayStart.getTime()
  ).length;
  if (countToday >= LIFE_AUTONOMY_DAILY_LIMIT) {
    return { eligible: false, reason: "daily-limit", characterIds };
  }

  return { eligible: true, reason: "eligible", characterIds };
}

export function chooseLifeAutonomyCharacter(characterIds: string[], lastSpeakerId?: string): string | null {
  if (!characterIds.length) return null;
  const alternatives = characterIds.filter(id => id !== lastSpeakerId);
  const pool = alternatives.length ? alternatives : characterIds;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

export function notifyLifeSceneMessage(title: string, body: string, onClick?: () => void): void {
  if (typeof window === "undefined") return;
  const safeBody = body.trim().slice(0, 180);
  window.dispatchEvent(new CustomEvent("life-scene-proactive-message", {
    detail: { title, body: safeBody, at: Date.now() },
  }));
  if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body: safeBody, tag: "life-scene-proactive" });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Notification permissions are optional; the in-app event remains available.
  }
}
