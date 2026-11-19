import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type FallbackBody = {
  eventId?: unknown;
  fallback?: {
    ruleId?: unknown;
    ruleName?: unknown;
    type?: unknown;
    payload?: unknown;
    processedText?: unknown;
    replyText?: unknown;
    createdAt?: unknown;
    characterName?: unknown;
    chat?: {
      characterId?: unknown;
      sessionId?: unknown;
      role?: unknown;
      historyRole?: unknown;
      requestReply?: unknown;
    };
  };
};

const safePart = (value: unknown, max = 100) =>
  String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, max);

function eventTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const raw = String(value ?? "").trim();
  const numeric = /^\d{10,13}$/.test(raw) ? Number(raw) : NaN;
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

/** Persist the native-only fallback reply into the same outbox consumed by the chat UI. */
export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });

    const body = await request.json().catch(() => ({})) as FallbackBody;
    const eventId = safePart(body.eventId);
    const fallback = body.fallback;
    const ruleId = safePart(fallback?.ruleId);
    const type = String(fallback?.type ?? "").trim().slice(0, 60);
    const payload = String(fallback?.payload ?? "").trim().slice(0, 4000);
    const processedText = String(fallback?.processedText ?? payload).trim().slice(0, 4000);
    const replyText = String(fallback?.replyText ?? "").trim().slice(0, 4000);
    const chat = fallback?.chat;
    const characterId = String(chat?.characterId ?? "").trim().slice(0, 160);
    const sessionId = String(chat?.sessionId ?? "").trim().slice(0, 160);
    const role = String(chat?.role ?? "user");
    const historyRole = String(chat?.historyRole ?? "").trim();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(eventId) || !ruleId || !type || !payload
      || !replyText || !characterId || !sessionId || chat?.requestReply !== true
      || !["user", "assistant", "system"].includes(role)
      || (historyRole && !["user", "assistant", "system"].includes(historyRole))) {
      return NextResponse.json({ ok: false, error: "离线回复数据不完整。" }, { status: 400 });
    }

    const createdAt = eventTimestamp(fallback?.createdAt);
    const chatMessageId = `bridge_${ruleId}_${eventId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 240);
    const responseBatchId = `bridge_reply_${ruleId}_${eventId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 240);
    const outboxId = `bridge_fallback_${ruleId}_${eventId}`.slice(0, 240);
    const meta = {
      kind: "bridge",
      item: { id: eventId, type, payload, createdAt },
      chatMessageId,
      bridgeResponseBatchId: responseBatchId,
      ruleId,
      ruleName: String(fallback?.ruleName ?? "").slice(0, 120),
      executed: false,
      processedText,
      chat: {
        characterId,
        sessionId,
        role,
        ...(historyRole ? { historyRole } : {}),
        requestReply: true,
      },
      reply: {
        sessionId,
        characterName: String(fallback?.characterName ?? "").slice(0, 120),
        appId: "chat",
        appTags: ["chat", "text"],
      },
      nativeOfflineFallback: true,
    };

    const saved = await supabaseRestFetch("push_outbox", {
      method: "POST",
      body: JSON.stringify([{
        id: outboxId,
        user_id: account.id,
        session_id: sessionId,
        trigger_key: `bridge:fallback:${eventId}:${ruleId}`,
        raw_text: replyText,
        meta,
      }]),
    });
    if (!saved.ok) {
      if (/duplicate key|unique constraint/i.test(saved.error || "")) {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      return NextResponse.json({ ok: false, error: saved.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, queued: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(error instanceof Error ? error.message : String(error)) },
      { status: /未登录/.test(error instanceof Error ? error.message : String(error)) ? 401 : 500 },
    );
  }
}
