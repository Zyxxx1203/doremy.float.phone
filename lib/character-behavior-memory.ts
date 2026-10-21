import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const KEY = "ai_phone_character_behavior_memory_v1";
const MAX_PER_CHARACTER = 80;
registerKvMigration(KEY);

export type CharacterBehaviorMemoryRecord = {
  id: string;
  characterId: string;
  sessionId: string;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type Ledger = Record<string, CharacterBehaviorMemoryRecord[]>;

function readLedger(): Ledger {
  try {
    const raw = kvGet(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Ledger : {};
  } catch {
    return {};
  }
}

/** Persist observed private-chat turns independently of the Life UI toggle. */
export function recordCharacterConversationEvent(input: Omit<CharacterBehaviorMemoryRecord, "id">): void {
  if (typeof window === "undefined") return;
  const content = String(input.content ?? "").replace(/\s+/g, " ").trim();
  if (!input.characterId || !content || content.length < 1) return;
  // Do not turn tool payloads, hidden instructions, or giant pasted data into character memories.
  if (content.length > 2400 || /^\s*(?:\{.*\}|<tool_|\[系统提示)/s.test(content)) return;
  try {
    const ledger = readLedger();
    const entries = Array.isArray(ledger[input.characterId]) ? ledger[input.characterId] : [];
    if (entries.some(entry => entry.messageId === input.messageId)) return;
    entries.push({
      ...input,
      id: "behavior_" + input.messageId,
      content: content.slice(0, 900),
    });
    ledger[input.characterId] = entries.slice(-MAX_PER_CHARACTER);
    kvSet(KEY, JSON.stringify(ledger));
  } catch {
    // Memory capture must never break normal chat sending.
  }
}

/**
 * Recent observed interaction ledger injected into future prompts.
 * These are events actually persisted in chat, not plans or inferred external activity.
 */
export function buildCharacterBehaviorMemoryContext(characterId: string, limit = 18): string {
  if (typeof window === "undefined" || !characterId) return "";
  const entries = readLedger()[characterId];
  if (!Array.isArray(entries) || !entries.length) return "";
  const recent = entries
    .filter(entry => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
    .slice(-Math.max(1, Math.min(limit, 30)));
  if (!recent.length) return "";
  const lines = recent.map(entry => {
    const time = new Date(entry.createdAt).toLocaleString("zh-CN");
    const speaker = entry.role === "assistant" ? "角色自己说过/做出的回应" : "用户对角色说过";
    return `- [${time}] ${speaker}：${entry.content.slice(0, 420)}`;
  });
  return [
    "【角色行为连续记忆｜来自已保存的真实聊天记录】",
    "以下内容是本角色确实发出或在私聊中收到的消息，可用于记起自己说过什么、用户如何回应以及尚未解决的情绪。先核对记录再回答，不要声称做过记录中没有的事。",
    "这些记录不代表角色知道用户在其他应用中的行为；角色的猜测、打算和梦境不能当成已发生事实。",
    ...lines,
  ].join("\n");
}
