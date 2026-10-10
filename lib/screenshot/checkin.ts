"use client";

// 查岗 ↔ 安卓壳原生浮层的对接层。
//
// 与截屏桥的区别：截屏桥是「截了直接回网页」，查岗是**三段式**——
//   ① 网页请求查岗 → ② 原生截屏并弹浮层给用户过目 → ③ 用户决定后才回传结果。
// 中间那段完全在原生，网页不参与，也就拿不到「用户看到的那张图」——
// 这正是隐私设计的关键：**没同意之前，图根本不会到网页**。
//
// 所以这里的 requestCheckIn 返回 Promise，等原生把用户的选择回推过来。

import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";
import type { CheckInCapabilities, CheckInOutcome } from "./types";

type CheckInBridgeLike = {
  getCheckInCapabilities?: () => string;
  prepareCheckIn?: () => boolean;
  stopCheckIn?: () => void;
  requestCheckIn?: (characterId: string, name: string, avatar: string) => void;
};

function bridge(): CheckInBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: CheckInBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供查岗浮层（老 APK 没有）。 */
export function hasCheckInBridge(): boolean {
  return typeof bridge()?.requestCheckIn === "function";
}

/** 读查岗能力与状态（系统支持 / 无障碍 / 浮窗权限）。 */
export function readCheckInCapabilities(): CheckInCapabilities {
  try {
    const raw = bridge()?.getCheckInCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CheckInCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 预热查岗服务。用户开启任一角色的查岗时（App 在前台）调用一次。
 * 返回是否成功发起；false 多半是没给浮窗权限。
 */
export function prepareCheckInService(): boolean {
  try {
    return bridge()?.prepareCheckIn?.() === true;
  } catch {
    return false;
  }
}

/** 收掉查岗服务（所有角色的查岗都关了时调用）。 */
export function stopCheckInService(): void {
  try {
    bridge()?.stopCheckIn?.();
  } catch {
    /* 忽略 */
  }
}

/**
 * 请求一次查岗：截当前屏并弹浮层，等用户决定。
 *
 * 返回：
 *   { accepted: true, base64, width, height } —— 用户同意，可以发给角色
 *   { accepted: false, reason }               —— 用户拒绝 / 超时 / 截屏失败
 *
 * **永远 resolve，不 reject**：调用方要么拿到图，要么拿到一句能转述的原因。
 *
 * @param timeoutMs 等用户决定的时长。要比原生自己的自动关闭（90 秒）长一点，
 *                  让原生先收场；这里只是兜底，防止事件没送到时 Promise 永远悬着。
 */
export function requestCheckIn(
  characterId: string,
  name: string,
  avatar: string,
  timeoutMs = 100_000,
): Promise<CheckInOutcome> {
  return new Promise<CheckInOutcome>((resolve) => {
    const b = bridge();
    if (!b?.requestCheckIn) {
      resolve({ accepted: false, reason: "当前 App 版本不支持查岗，需要更新安卓壳" });
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    // 用户随口说的那句话（同意/拒绝都可能有），统一在下面几处带进结果里。
    const finish = (result: CheckInOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };

    // 先订阅、再请求：浮层若很快出结果，反过来会漏掉事件。
    ensureShellOverlayListener();
    unsubscribe = subscribeShellOverlayEvents((event) => {
      if (event.action !== "checkIn") return;
      // 同一时刻可能只有一次查岗，但仍按 characterId 校验，避免张冠李戴
      if (event.characterId && event.characterId !== characterId) return;
      const reply = typeof event.reply === "string" && event.reply.trim() ? event.reply.trim() : undefined;
      if (event.accepted === true && typeof event.base64 === "string" && event.base64) {
        finish({
          accepted: true,
          base64: event.base64,
          width: typeof event.width === "number" ? event.width : 0,
          height: typeof event.height === "number" ? event.height : 0,
          reply,
        });
        return;
      }
      finish({ accepted: false, reason: event.reason || "user_rejected", reply });
    });

    timer = setTimeout(() => {
      finish({ accepted: false, reason: "timeout" });
    }, Math.max(1000, timeoutMs));

    try {
      b.requestCheckIn(characterId, name, avatar || "");
    } catch {
      finish({ accepted: false, reason: "查岗请求失败" });
    }
  });
}
