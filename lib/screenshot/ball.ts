"use client";

// 截屏悬浮球 ↔ 安卓壳的桥。
//
// 与查岗的区别只有一个：**谁发起的**。
//   查岗 = 角色到点想看你 → 有明确的 characterId；
//   悬浮球 = 你自己点一下 → 没有 characterId，「发给谁」等同意后取最近会话。
// 两者点击后都走 CheckInService 那套预览与审批，所以这里只做「拉起/收起」两件事。

import type { ScreenshotBallCapabilities } from "./types";

type BallBridgeLike = {
  getScreenshotBallCapabilities?: () => string;
  prepareScreenshotBall?: () => boolean;
  stopScreenshotBall?: () => void;
};

function bridge(): BallBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: BallBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供悬浮球（老 APK 没有）。 */
export function hasScreenshotBallBridge(): boolean {
  return typeof bridge()?.prepareScreenshotBall === "function";
}

/** 读悬浮球能力与运行状态。 */
export function readScreenshotBallCapabilities(): ScreenshotBallCapabilities {
  try {
    const raw = bridge()?.getScreenshotBallCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ScreenshotBallCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 拉起悬浮球。返回 false 多半是没给浮窗权限——调用方据此引导授权。
 * 必须由网页在 App 前台时调用（Android 12+ 禁止后台启动前台服务）。
 */
export function prepareScreenshotBall(): boolean {
  try {
    return bridge()?.prepareScreenshotBall?.() === true;
  } catch {
    return false;
  }
}

/** 收掉悬浮球。 */
export function stopScreenshotBall(): void {
  try {
    bridge()?.stopScreenshotBall?.();
  } catch {
    /* 忽略 */
  }
}
