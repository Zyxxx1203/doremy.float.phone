"use client";

// 通知栏「直接回复」的网页侧处理：普通聊天写回会话，生活现场回复写回原场景。
// 原生只负责把文本、sceneId 和回复类型可靠落入持久队列；上下文组装、模型回应
// 与生活现场时间线仍由 WebView 中的 JS 引擎完成。

import { loadChatContacts, loadChatMessages, loadChatSessions, pushChatMessage } from "./chat-storage";
import { loadVirtualLifeState, saveVirtualLifeState, appendLifeTimelineEntry } from "./life/life-storage";
import { requestBackgroundChatReply } from "./follow-up-service";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "./shell-call-overlay";
import { recordLifeDiagnostic } from "./life/life-diagnostics";
import { enqueuePendingLifeSceneReply } from "./life/life-notification-queue";

type ReplyBridge = {
    consumePendingReplies?: () => string;
    peekPendingReplies?: () => string;
    acknowledgePendingReplies?: (idsJson: string) => boolean;
};

function bridge(): ReplyBridge | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: ReplyBridge }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否支持通知栏直接回复（老 APK 没有）。 */
export function hasNotificationReplyBridge(): boolean {
    const api = bridge();
    return typeof api?.consumePendingReplies === "function"
        || (typeof api?.peekPendingReplies === "function" && typeof api?.acknowledgePendingReplies === "function");
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
        const api = bridge();
        const raw = typeof api?.peekPendingReplies === "function" && typeof api?.acknowledgePendingReplies === "function"
            ? api.peekPendingReplies()
            : api?.consumePendingReplies?.();
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
        const alreadyWritten = state.sceneMessages.some(message => message.id === messageId);
        const createdAt = Number.isFinite(item.at) && item.at > 0 ? new Date(item.at).toISOString() : new Date().toISOString();
        const playerName = state.settings.playerDisplayName || "我";
        const isAction = item.replyMode === "action";
        if (!alreadyWritten) {
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
        }
        const queued = enqueuePendingLifeSceneReply({
            replyId: item.id, sceneId: scene.id, characterId, replyMode: isAction ? "action" : "dialogue",
        });
        if (!queued) {
            recordLifeDiagnostic({ source: "通知回复", event: "生活现场回复队列持久化失败", status: "error", detail: "现场消息已写入，但本机自动回应队列未能保存；原生通知队列将保留并重试。", meta: { replyId: item.id, sceneId: scene.id, characterId } });
            return "failed";
        }
        if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("life-scene-message-added"));
            window.dispatchEvent(new CustomEvent("life-scene-notification-reply", { detail: { replyId: item.id, sceneId: scene.id, characterId, replyMode: item.replyMode } }));
            if (window.location.pathname !== "/life" && window.location.pathname !== "/life/") {
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
    const api = bridge();
    const durableNativeQueue = typeof api?.peekPendingReplies === "function" && typeof api?.acknowledgePendingReplies === "function";
    const pending = readPendingReplies();
    if (pending.length === 0) return 0;

    const sessions = new Set(loadChatSessions().map(session => session.id));
    let sent = 0;
    const chatReplies = new Set<string>();
    const acknowledge = (replyId: string) => {
        if (!durableNativeQueue) return true; // Legacy APK already consumed the native queue.
        try { return api?.acknowledgePendingReplies?.(JSON.stringify([replyId])) === true; }
        catch { return false; }
    };

    for (const item of pending) {
        if (!item.id) continue;
        if (!sessions.has(item.sessionId)) {
            recordLifeDiagnostic({ source: "通知回复", event: "回复丢弃", status: "warning", detail: "对应会话已不存在，已从原生队列确认丢弃。", meta: { replyId: item.id, sessionId: item.sessionId } });
            if (!acknowledge(item.id)) recordLifeDiagnostic({ source: "通知回复", event: "原生回复队列确认失败", status: "error", detail: "会话已不存在，但原生队列未能确认删除；下次启动会再次检查。", meta: { replyId: item.id } });
            continue;
        }
        const text = item.text.trim();
        if (!text) { acknowledge(item.id); continue; }
        const result = mirrorNotificationReplyToLifeScene(item, text);
        if (result === "failed") {
            // Keep the native item. A transient storage failure must not turn a life-scene reply into a duplicate chat message.
            recordLifeDiagnostic({ source: "通知回复", event: "原生回复暂未确认", status: "warning", detail: "生活现场写回失败，原生队列保留该回复，等待下次重试。", meta: { replyId: item.id, sceneId: item.sceneId } });
            continue;
        }
        if (result === "written") {
            recordLifeDiagnostic({ source: "通知回复", event: "通知回复已写入并排队", status: "ok", detail: "生活现场与本机自动回应队列均已持久化。", meta: { replyId: item.id, sceneId: item.sceneId, replyMode: item.replyMode } });
        } else {
            const stableMessageId = "notification-reply-" + item.id;
            if (!loadChatMessages(item.sessionId).some(message => message.id === stableMessageId)) {
                pushChatMessage({ id: stableMessageId, sessionId: item.sessionId, role: "user", content: text });
            }
            chatReplies.add(item.sessionId);
            recordLifeDiagnostic({ source: "通知回复", event: "普通聊天回复入队", status: "info", detail: result === "missing-scene" ? "原现场不存在，按普通聊天兼容处理。" : "已写入普通聊天会话。", meta: { replyId: item.id, sessionId: item.sessionId, replyMode: item.replyMode || "chat" } });
        }
        if (!acknowledge(item.id)) {
            recordLifeDiagnostic({ source: "通知回复", event: "原生回复队列确认失败", status: "warning", detail: "网页数据已持久化，但原生队列确认失败；下次读取会通过稳定 ID 去重。", meta: { replyId: item.id, sessionId: item.sessionId } });
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
