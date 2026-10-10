"use client";

// 查岗引擎：决定「该不该查」→ 请原生弹浮层 → 按用户的选择推进。
//
// 三条路径：
//   ① 用户同意 → 这张图以「你发的图片」进聊天，触发角色点评；
//   ② 用户拒绝 → 只写一条系统事件（图根本没产生），让角色知道这次没给看；
//   ③ 截屏失败/超时 → 同上，但原因不同，角色不会以为「你拒绝了」。
//
// 关键边界：
//  - **没同意就没有图**：图片数据只在原生内存里；拒绝路径上网页侧从头到尾
//    没拿到过 base64，所以这里不需要「清理」什么，也就不会漏删。
//  - **不做隐蔽触发**：只有 shouldFireCheckIn 判定该触发时才调用，且
//    每次都会弹浮层让用户当场决定——不存在「悄悄截了存起来」的路径。
//  - **失败如实说**：没能截图时写的是「截屏失败」而不是「对方没给看」，
//    免得角色误以为用户拒绝、做出委屈的反应。

import { pushChatMessage, loadChatSessions, loadCharacters } from "../chat-storage";
import { requestBackgroundChatReply } from "../follow-up-service";
import { storeMediaBase64 } from "../media-cache-storage";
import {
  loadCharacterCheckIn,
  loadCheckInConfig,
  markCheckInFired,
  shouldFireCheckIn,
  type CheckInCharacterConfig,
} from "./checkin-config";
import { consumePendingUserShot, hasCheckInBridge, readCheckInCapabilities, requestCheckIn } from "./checkin";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";

/** 一次查岗尝试的结论（给调用方/设置页做记录用）。 */
export type CheckInAttempt =
  | { ok: true; accepted: true }
  | { ok: true; accepted: false; reason: string }
  | { ok: false; reason: string };

/** 查岗是否具备条件（不开浮层也点不动）。 */
export function checkInReadiness(): {
  bridgeAvailable: boolean;
  supported: boolean;
  accessibilityOn: boolean;
  overlayReady: boolean;
  ready: boolean;
} {
  const caps = readCheckInCapabilities();
  const bridgeAvailable = hasCheckInBridge();
  const supported = caps.supported === true;
  const accessibilityOn = caps.accessibilityOn === true;
  const overlayReady = caps.canDraw === true;
  return {
    bridgeAvailable,
    supported,
    accessibilityOn,
    overlayReady,
    ready: bridgeAvailable && supported && accessibilityOn && overlayReady,
  };
}

/** 找一个角色的最新私聊会话（查岗只发生在私聊里）。 */
export function findLatestPrivateSession(characterId: string): string | null {
  const sessions = loadChatSessions()
    .filter(session => !session.isGroup && session.contactId === characterId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions[0]?.id ?? null;
}

/**
 * 对某个角色跑一次查岗（该不该触发要先由调用方判定）。
 *
 * @param config 该角色的查岗配置（调用方已读过，这里不再读一次，避免
 *               判定与执行之间配置被改动造成不一致）
 */
export async function runCheckIn(
  characterId: string,
  config?: CheckInCharacterConfig,
): Promise<CheckInAttempt> {
  const cfg = config ?? loadCharacterCheckIn(characterId);
  if (!cfg.enabled) return { ok: false, reason: "这个角色没有开启查岗" };

  const sessionId = findLatestPrivateSession(characterId);
  if (!sessionId) return { ok: false, reason: "还没有和这个角色的聊天" };

  const readiness = checkInReadiness();
  if (!readiness.bridgeAvailable) return { ok: false, reason: "当前 App 版本不支持查岗" };
  if (!readiness.supported) return { ok: false, reason: "系统版本太低，查岗需要 Android 11 及以上" };
  if (!readiness.accessibilityOn) return { ok: false, reason: "无障碍服务没有开启" };
  if (!readiness.overlayReady) return { ok: false, reason: "浮窗权限没有授予，弹不出确认浮层" };

  const character = loadCharacters().find(c => c.id === characterId);
  const name = character?.name?.trim() || "TA";
  const avatar = character?.avatar || "";

  // 先记一次触发：无论用户最终给不给看，这次查岗都已经发生过，
  // 都该计入当日上限——否则用户一直点「不给」就等于没有上限。
  markCheckInFired(characterId);

  const outcome = await requestCheckIn(characterId, name, avatar);

  if (outcome.accepted) {
    try {
      // 用户在浮层里顺手说的话，先作为普通发言发出去——
      // 这样角色看到的是「你说了一句话 + 一张图」，而不是一张没头没尾的截图。
      if (outcome.reply) {
        pushChatMessage({ sessionId, role: "user", content: outcome.reply });
      }
      const stored = await storeMediaBase64(outcome.base64, "image/png");
      pushChatMessage({
        sessionId,
        role: "user",
        content: "",
        mediaType: "image",
        mediaUrl: stored.ref,
        mediaData: { label: "给你看我现在的屏幕" },
      });
      void requestBackgroundChatReply(sessionId).catch(() => undefined);
      return { ok: true, accepted: true };
    } catch {
      return { ok: false, reason: "图片没能保存，这次没发出去" };
    }
  }

  // 拒绝时如果用户留了话，那句话是主动说的，照常作为发言送出。
  // 顺序很关键：先发送言、再写「没给看」的事件，读起来才是因果正确的。
  if (outcome.reply) {
    pushChatMessage({ sessionId, role: "user", content: outcome.reply });
  }

  // 拒绝 / 超时 / 截屏失败：写一条只有角色看得见来源的系统事件，
  // 让它能自然反应——但措辞要能区分「你不想给我看」和「没截成」。
  const declined = outcome.reason === "user_rejected";
  const timedOut = outcome.reason === "timeout";
  const note = declined
    ? `[${name}想看看你现在在做什么，你没有给它看${outcome.reply ? "，但回了一句话" : ""}]`
    : timedOut
      ? `[${name}想看看你现在在做什么，你没有回应]`
      : `[${name}想看看你现在在做什么，但没能截到屏幕（${outcome.reason}）]`;
  pushChatMessage({ sessionId, role: "system", content: note });
  // 拒绝也让它有反应（用户明确要的）——被拒时该失落还是说没关系，交给角色自己决定。
  void requestBackgroundChatReply(sessionId).catch(() => undefined);
  return { ok: true, accepted: false, reason: outcome.reason };
}

/**
 * 处理一次「用户主动截屏」（悬浮球发起）。
 *
 * 与查岗的区别：没有指定角色——用户点球时只是想分享，发给谁是**现在**决定的。
 * 取最近聊过的私聊会话作为目标：那是他此刻最可能想发的人。
 *
 * @param outcome 原生回传的结果（已确认用户点了「发给它」）
 */
export async function deliverUserShot(outcome: CheckInOutcome): Promise<{ ok: boolean; reason?: string }> {
  if (!outcome.accepted) return { ok: false, reason: outcome.reason || "没有可发送的内容" };

  // 取最近的私聊会话。没有会话就没法发——如实失败，不硬造一个。
  const sessions = loadChatSessions()
    .filter(session => !session.isGroup)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sessionId = sessions[0]?.id;
  if (!sessionId) return { ok: false, reason: "还没有任何聊天，不知道发给谁" };

  try {
    // 顺手说的话先发，图后发——读起来是「说了一句 + 配张图」。
    if (outcome.reply) {
      pushChatMessage({ sessionId, role: "user", content: outcome.reply });
    }
    const stored = await storeMediaBase64(outcome.base64, "image/png");
    pushChatMessage({
      sessionId,
      role: "user",
      content: "",
      mediaType: "image",
      mediaUrl: stored.ref,
      mediaData: { label: "给你看看我现在这边" },
    });
    void requestBackgroundChatReply(sessionId).catch(() => undefined);
    return { ok: true };
  } catch {
    return { ok: false, reason: "图片没能保存，这次没发出去" };
  }
}

/**
 * 拉一次「用户主动截屏」的结果并送出去。
 *
 * 页面挂载时、以及收到 checkIn 事件时各调一次：
 *   · 挂载时补发「点球那一刻页面已被系统回收」的那张；
 *   · 事件时处理当场送达的。
 * 原生侧是「读到即清空」，所以重复调用不会把同一张图发两遍。
 *
 * @returns 真正送出的一张图；没有待取或发送失败时返回 null。
 */
export async function flushPendingUserShot(): Promise<boolean> {
  const pending = consumePendingUserShot();
  if (!pending) return false;
  const result = await deliverUserShot(pending);
  return result.ok;
}

/**
 * 启动「用户主动截屏」的接收端：页面挂载时补发一次，之后收到 checkIn 事件再拉一次。
 *
 * 必须挂在桌面壳这种「一直在跑」的地方，而不是设置页——用户点球时
 * 多半正在别的 App 里，设置页根本没开。
 *
 * 重复调用无害：原生侧是「读到即清空」，拉两次不会把同一张图发两遍。
 * 角色查岗也会触发同一个事件，但那条路上原生不写 pendingUserShot，
 * 所以这里会拿到空、直接返回，不影响查岗自己的 Promise 流程。
 */
export function startUserShotBridge(): () => void {
  if (typeof window === "undefined") return () => { /* noop */ };
  if (!hasCheckInBridge()) return () => { /* noop */ };

  // 挂载时补发：点球那一刻页面若已被系统回收，事件是丢的，只能靠这里捞回来
  void flushPendingUserShot().catch(() => undefined);

  ensureShellOverlayListener();
  return subscribeShellOverlayEvents((event) => {
    if (event.action !== "checkIn") return;
    void flushPendingUserShot().catch(() => undefined);
  });
}

/**
 * 扫一遍所有角色，把到点的查岗跑一遍。
 *
 * 挂进桌面壳的轮询（与定时主动联系同一处）。刻意串行执行：
 * 同一时刻只弹一个浮层——两个浮层叠在一起，用户根本没法处理。
 */
export async function pollDueCheckIns(): Promise<number> {
  const all = loadCheckInConfig();
  let fired = 0;
  for (const [characterId, config] of Object.entries(all)) {
    if (!shouldFireCheckIn(characterId, config)) continue;
    const result = await runCheckIn(characterId, config);
    if (result.ok) fired += 1;
  }
  return fired;
}
