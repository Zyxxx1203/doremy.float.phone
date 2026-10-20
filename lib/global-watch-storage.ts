import { kvGet, kvSet } from "@/lib/kv-db";
import { createOrGetSession, loadChatContacts, pushChatMessage } from "@/lib/chat-storage";

export type GlobalWatchRecord = {
  id: string;
  characterId: string;
  characterName: string;
  text: string;
  createdAt: string;
  kind: "character" | "user";
  targetUrl: "global-watch";
};

const SHARED_WATCH_COMMENTS_KEY = "ai_phone_watch_together_comments_v1";
const GLOBAL_RECORDS_KEY = "global_watch_records_v1";

export function loadGlobalWatchRecords(): GlobalWatchRecord[] {
  try {
    const raw = kvGet(GLOBAL_RECORDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item.text === "string").slice(-100);
    }
    const shared = JSON.parse(kvGet(SHARED_WATCH_COMMENTS_KEY) || "{}") as Record<string, unknown>;
    const list = Array.isArray(shared["global-watch"]) ? shared["global-watch"] as GlobalWatchRecord[] : [];
    return list.slice(-100);
  } catch { return []; }
}

export function saveGlobalWatchRecord(record: GlobalWatchRecord): void {
  const records = [...loadGlobalWatchRecords(), record].slice(-100);
  kvSet(GLOBAL_RECORDS_KEY, JSON.stringify(records));
  try {
    const shared = JSON.parse(kvGet(SHARED_WATCH_COMMENTS_KEY) || "{}") as Record<string, unknown>;
    shared["global-watch"] = records;
    kvSet(SHARED_WATCH_COMMENTS_KEY, JSON.stringify(shared));
  } catch { /* dedicated record store remains the source of truth */ }
}

export function persistGlobalWatchMemory(record: GlobalWatchRecord): boolean {
  try {
    const contact = loadChatContacts().find(item => item.characterId === record.characterId);
    if (!contact) return false;
    const session = createOrGetSession(contact.id);
    const prefix = record.kind === "user" ? "用户在全局陪看横幅中回复：" : "角色在全局陪看中主动评价：";
    pushChatMessage({
      sessionId: session.id,
      role: record.kind === "user" ? "user" : "assistant",
      content: "【全局陪看短期记忆】" + record.characterName + "｜" + new Date(record.createdAt).toLocaleString("zh-CN") + "｜" + prefix + record.text.slice(0, 1500),
      origin: "custom_app",
    });
    return true;
  } catch (error) {
    console.warn("[GlobalWatch] short-term memory write failed", error);
    return false;
  }
}
