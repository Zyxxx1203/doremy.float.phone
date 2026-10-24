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

/**
 * 把待发队列里的回复逐条写进聊天并触发角色回应。
 *
 * 会话已被删除时跳过——一条无归属的回复写不进去，也不该硬造一个会话。
 * 返回实际发出的条数。
 */
/**
 * Life-scene replies arrive through the same native queue as ordinary chat replies.
 * Preserve the existing chat delivery, but also mirror the user's words into the
 * active scene when the notification belongs to a character who is physically
 * present with the player. The stable native reply id makes this idempotent.
 */
function mirrorNotificationReplyToLifeScene(item: PendingNotificationReply, text: string): boolean {
    try {
        const session = loadChatSessions().find(candidate => candidate.id === item.sessionId);
        if (!session || session.isGroup) return false;
        const contact = loadChatContacts().find(candidate => candidate.id === session.contactId);
        const characterId = contact?.characterId;
        if (!characterId) return false;

        const state = loadVirtualLifeState();
        if (!state.settings.enabled || state.settings.recordSceneMessages === false) return false;
        const scene = state.scenes.find(candidate =>
            candidate.status === "active"
            && candidate.participants.some(participant => participant.ownerType === "player" && participant.ownerId === "player")
            && candidate.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId && participant.activity !== "离开")
        );
        if (!scene) return false;

        const messageId = item.id ? "notification-reply-" + item.id : "";
        if (messageId && state.sceneMessages.some(message => message.id === messageId)) return true;
        const createdAt = Number.isFinite(item.at) && item.at > 0 ? new Date(item.at).toISOString() : new Date().toISOString();
        const playerName = state.settings.playerDisplayName || "我";
        const message = {
            id: messageId || "notification-reply-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
            sceneId: scene.id,
            speakerType: "player" as const,
            speakerId: "player",
            speakerName: playerName,
            role: "player" as const,
            dialogue: text,
            createdAt,
        };
        let next = {
            ...state,
            scenes: state.scenes.map(candidate => candidate.id === scene.id ? { ...candidate, updatedAt: new Date().toISOString() } : candidate),
            sceneMessages: [...state.sceneMessages, message],
        };
        next = appendLifeTimelineEntry(next, {
            category: "dialogue",
            occurredAt: createdAt,
            title: playerName + "通过通知回复",
            details: text,
            actorId: "player",
            actorName: playerName,
            locationName: scene.locationName,
            sceneId: scene.id,
            sourceId: message.id,
        });
        saveVirtualLifeState(next);
        if (typeof window !== "undefined") window.dispatchEvent(new Event("life-scene-message-added"));
        return true;
    } catch (error) {
        console.warn("[NotificationReply] life-scene writeback failed:", error);
        return false;
    }
}

export async function flushPendingNotificationReplies(): Promise<number> {
    const pending = readPendingReplies();
    if (pending.length === 0) return 0;

    const sessionIds = new Set(loadChatSessions().map(s => s.id));
    let sent = 0;
    const touched = new Set<string>();
    for (const item of pending) {
        if (!sessionIds.has(item.sessionId)) continue;
        const text = item.text.trim();
        if (!text) continue;
        pushChatMessage({ sessionId: item.sessionId, role: "user", content: text });
        // Write the same user input into the active life scene when the replying
        // character is co-present. Ordinary chat replies retain their old path.
        mirrorNotificationReplyToLifeScene(item, text);
        touched.add(item.sessionId);
        sent += 1;
    }

    // 每个会话只触发一次回复：同一会话连回几句时，一次生成就该看到全部，
    // 逐条触发会连出好几轮，读起来像角色在自说自话。
    for (const sessionId of touched) {
        void requestBackgroundChatReply(sessionId).catch(() => undefined);
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
