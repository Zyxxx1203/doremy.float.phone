"use client";

// 通知栏「直接回复」的网页侧处理。
//
// 链路：用户在消息通知横幅上回一句 → 原生 NotificationReplyReceiver 落队列
//       → 戳一下页面（event=userReply）或等页面下次挂载 → 本模块拉队列 →
//         以「用户发言」写进对应会话 → 触发角色回复。
//
// 为什么由网页来写消息而不是原生直接写：聊天引擎（上下文组装、模型调用、
// 消息落库）整个跑在 WebView 的 JS 里，原生没有那套逻辑。原生只负责
// 「别把用户打的字弄丢」——这是它唯一能可靠承担的职责。

import { loadChatContacts, loadChatSessions, pushChatMessage } from "./chat-storage";
import { loadVirtualLifeState, saveVirtualLifeState, appendLifeTimelineEntry } from "./life/life-storage";
import { requestBackgroundChatReply } from "./follow-up-service";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "./shell-call-overlay";
import { recordLifeDiagnostic } from "./life/life-diagnostics";
import { enqueuePendingLifeSceneReply } from "./life/life-notification-queue";

type ReplyBridge = {
    consumePendingReplies?: () => string;
};

function bridge(): ReplyBridge | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: ReplyBridge }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否支持通知栏直接回复（老 APK 没有）。 */
export function hasNotificationReplyBridge(): boolean {
    return typeof bridge()?.consumePendingReplies === "function";
}

/** 原生队列里的一条待发回复。 */
export type PendingNotificationReply = {
    id: string;
    sessionId: string;
    text: string;
    /** 用户按下发送的时刻（原生记的墙钟），仅用于排查 */
    at: number;
    sceneId?: string;
    replyMode?: "action" | "dialogue" | "chat" | string;
};

/** 读走并清空原生队列。壳不支持或解析失败都返回空数组。 */
export function readPendingReplies(): PendingNotificationReply[] {
    try {
        const raw = bridge()?.consumePendingReplies?.();
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is PendingNotificationReply => (
            !!item
            && typeof item === "object"
            && typeof (item as PendingNotificationReply).sessionId === "string"
            && typeof (item as PendingNotificationReply).text === "string"
            && (item as PendingNotificationReply).text.trim().length > 0
        ));
    } catch {
        return [];
    }
}

/** Mirror a native life-scene reply into its exact active scene; non-life replies use chat fallback. */
/**
 * Life-scene replies arrive through the same native queue as ordinary chat replies.
 * Preserve the existing chat delivery, but also mirror the user's words into the
 * active scene when the notification belongs to a character who is physically
 * present with the player. The stable native reply id makes this idempotent.
 */
function mirrorNotificationReplyToLifeScene(item: PendingNotificationReply, text: string): "written" | "missing-scene" | "not-life" | "failed" {
    try {
        if (!item.sceneId || !["action", "dialogue"].includes(item.replyMode || "")) return "not-life";
        const session = loadChatSessions().find(candidate => candidate.id === item.sessionId);
        if (!session || session.isGroup) return "failed";
        const contact = loadChatContacts().find(candidate => candidate.id === session.contactId);
        const characterId = contact?.characterId;
        if (!characterId) return "failed";
        const state = loadVirtualLifeState();
        if (!state.settings.enabled || state.settings.recordSceneMessages === false) return "missing-scene";
        const scene = state.scenes.find(candidate => candidate.id === item.sceneId && candidate.status === "active"
            && candidate.participants.some(participant => participant.ownerType === "player" && participant.ownerId === "player")
            && candidate.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId && participant.activity !== "离开"));
        if (!scene) return "missing-scene";
        const messageId = "notification-reply-" + item.id;
        if (state.sceneMessages.some(message => message.id === messageId)) return "written";
        const createdAt = Number.isFinite(item.at) && item.at > 0 ? new Date(item.at).toISOString() : new Date().toISOString();
        const playerName = state.settings.playerDisplayName || "我";
        const isAction = item.replyMode === "action";
        const message = {
            id: messageId, sceneId: scene.id, speakerType: "player" as const, speakerId: "player",
            speakerName: playerName, role: "player" as const,
            action: isAction ? text : "", dialogue: isAction ? "" : text, createdAt,
        };
        let next = {
            ...state,
            scenes: state.scenes.map(candidate => candidate.id === scene.id ? { ...candidate, updatedAt: new Date().toISOString() } : candidate),
            sceneMessages: [...state.sceneMessages, message],
        };
        next = appendLifeTimelineEntry(next, {
            category: isAction ? "action" : "dialogue", occurredAt: createdAt,
            title: playerName + (isAction ? "通过通知回复行动" : "通过通知回复"),
            details: text, actorId: "player", actorName: playerName,
            locationName: scene.locationName, sceneId: scene.id, sourceId: message.id,
        });
        saveVirtualLifeState(next);
        enqueuePendingLifeSceneReply({
            replyId: item.id,
            sceneId: scene.id,
            characterId,
            replyMode: isAction ? "action" : "dialogue",
        });
        if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("life-scene-message-added"));
            window.dispatchEvent(new CustomEvent("life-scene-notification-reply", { detail: { replyId: item.id, sceneId: scene.id, characterId, replyMode: item.replyMode } }));
            // The reply can arrive while the WebView is alive on another app/page.
            // Navigate to the life scene so the queued reaction is not lost with an absent listener.
            if (window.location.pathname.replace(/\\/+$/, "") !== "/life") {
                window.location.assign("/life?sceneId=" + encodeURIComponent(scene.id));
            }
        }
        recordLifeDiagnostic({ source: "通知回复", event: isAction ? "行动已写入生活现场" : "对白已写入生活现场", status: "ok", detail: "通知回复已写入指定现场并保留回复类型。", meta: { replyId: item.id, sceneId: scene.id, characterId, replyMode: item.replyMode } });
        return "written";
    } catch (error) {
        recordLifeDiagnostic({ source: "通知回复", event: "生活现场写回异常", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { replyId: item.id, sceneId: item.sceneId } });
        console.warn("[NotificationReply] life-scene writeback failed:", error);
        return "failed";
    }
}

export async function flushPendingNotificationReplies(): Promise<number> {
    const pending = readPendingReplies();
    if (pending.length === 0) return 0;

    const sessions = new Set(loadChatSessions().map(session => session.id));
    let sent = 0;
    const chatReplies = new Set<string>();
    for (const item of pending) {
        if (!sessions.has(item.sessionId)) {
            recordLifeDiagnostic({ source: "通知回复", event: "回复丢弃", status: "warning", detail: "对应会话已不存在。", meta: { replyId: item.id, sessionId: item.sessionId } });
            continue;
        }
        const text = item.text.trim();
        if (!text) continue;
        const result = mirrorNotificationReplyToLifeScene(item, text);
        if (result === "written") {
            recordLifeDiagnostic({ source: "通知回复", event: "场景回复闭环完成", status: "ok", detail: "生活现场已写回，不再重复触发普通聊天回复。", meta: { replyId: item.id, sceneId: item.sceneId, replyMode: item.replyMode } });
        } else {
            pushChatMessage({ sessionId: item.sessionId, role: "user", content: text });
            chatReplies.add(item.sessionId);
            recordLifeDiagnostic({ source: "通知回复", event: "普通聊天回复入队", status: "info", detail: result === "missing-scene" ? "原现场不存在，按普通聊天兼容处理。" : "已写入普通聊天会话。", meta: { replyId: item.id, sessionId: item.sessionId, replyMode: item.replyMode || "chat" } });
        }
        sent += 1;
    }
    for (const sessionId of chatReplies) {
        void requestBackgroundChatReply(sessionId).catch(error => recordLifeDiagnostic({ source: "通知回复", event: "普通聊天回复生成失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { sessionId } }));
    }
    return sent;
}

/**
 * 启动通知回复的处理：页面挂载时补发一次，之后每次收到 userReply 事件再拉一次。
 *
 * 返回取消函数（组件卸载时用）。重复调用无害——壳侧队列是「读到即清空」，
 * 拉两次不会把同一句话发两遍。
 */
export function startNotificationReplyBridge(): () => void {
    if (typeof window === "undefined") return () => { /* noop */ };
    if (!hasNotificationReplyBridge()) return () => { /* noop */ };

    // 挂载时补发：页面被系统回收期间，用户从通知里回的话都还堆在原生队列里
    void flushPendingNotificationReplies().catch(() => undefined);

    ensureShellOverlayListener();
    return subscribeShellOverlayEvents((event) => {
        if (event.action !== "userReply") return;
        void flushPendingNotificationReplies().catch(() => undefined);
    });
}
