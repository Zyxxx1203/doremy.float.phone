import { kvGet, kvSet } from "@/lib/kv-db";
import { appendCustomAppTimelineEntry } from "@/lib/custom-app-storage";

export type GlobalWatchRecord = {
  id: string;
  characterId: string;
  characterName: string;
  text: string;
  createdAt: string;
  kind: "character" | "user";
  targetUrl: "global-watch";
  sessionId?: string;
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
    appendCustomAppTimelineEntry({ id: "global_watch", name: "全局陪看" }, {
      characterId: record.characterId,
      summary: "【全局陪看】" + (record.kind === "user" ? "用户回复：" : "角色主动说：") + record.text.slice(0, 1500),
      appLabel: "全局陪看",
      data: { kind: record.kind },
    });
    return true;
  } catch (error) {
    console.warn("[GlobalWatch] short-term memory write failed", error);
    return false;
  }
}


export function clearGlobalWatchRecords(): void {
  kvSet(GLOBAL_RECORDS_KEY, "[]");
  try {
    const shared = JSON.parse(kvGet(SHARED_WATCH_COMMENTS_KEY) || "{}") as Record<string, unknown>;
    delete shared["global-watch"];
    kvSet(SHARED_WATCH_COMMENTS_KEY, JSON.stringify(shared));
  } catch { /* ignore */ }
}
