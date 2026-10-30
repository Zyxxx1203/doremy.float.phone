export type PendingLifeSceneNotificationReply = {
  replyId: string;
  sceneId: string;
  characterId: string;
  replyMode: "action" | "dialogue";
};

const KEY = "life-scene-notification-reply-queue-v1";
const LIMIT = 20;

function readQueue(): PendingLifeSceneNotificationReply[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is PendingLifeSceneNotificationReply =>
      !!item && typeof item.replyId === "string" && typeof item.sceneId === "string"
      && typeof item.characterId === "string" && (item.replyMode === "action" || item.replyMode === "dialogue"),
    ).slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function enqueuePendingLifeSceneReply(item: PendingLifeSceneNotificationReply): void {
  if (typeof window === "undefined" || !item.replyId || !item.sceneId || !item.characterId) return;
  const queue = readQueue();
  if (queue.some(existing => existing.replyId === item.replyId)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...queue, item].slice(-LIMIT)));
  } catch {
    // The life-scene message itself is already persisted; queue failure only skips auto-reaction.
  }
}

export function peekPendingLifeSceneReply(): PendingLifeSceneNotificationReply | null {
  return readQueue()[0] ?? null;
}

export function acknowledgePendingLifeSceneReply(replyId: string): void {
  if (typeof window === "undefined" || !replyId) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(readQueue().filter(item => item.replyId !== replyId)));
  } catch {
    // Best effort; the reply's stable ID prevents duplicate scene-message writes.
  }
}
