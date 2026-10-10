"use client";

// 主动查岗设置：**每个角色各一套**开关与节奏，嵌在「截屏」设置页里。
//
// 为什么按角色而不是一个全局开关：查岗是「TA 想看看你在干嘛」，
// 这件事的合适程度完全取决于你和这个角色的关系——黏人的那位想半小时看一次，
// 正经的那位一天一次都嫌多。一个总开关只能逼你二选一。
//
// 三条硬边界写在界面上，用户才知道自己给了什么：
//  ① 每次都会弹浮层让你过目，你点「给它看」才发得出去；
//  ② 你点「不给」，那张图当场丢弃，从未离开这台设备；
//  ③ 默认关闭，且只对开了的角色生效。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import {
  checkInReadiness,
  disableAllCheckIn,
  loadCheckInConfig,
  prepareCheckInService,
  runCheckIn,
  saveCharacterCheckIn,
  stopCheckInService,
  type CheckInConfigMap,
} from "@/lib/screenshot";
import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";

/** 每日上限与间隔的允许范围，与 lib/screenshot/checkin-config.ts 里的钳制保持一致。 */
const MIN_ALLOWED = 5;
const MAX_ALLOWED = 720;
const DAILY_ALLOWED = 20;

export function CheckInSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [configs, setConfigs] = useState<CheckInConfigMap>(() => loadCheckInConfig());
  const [busyId, setBusyId] = useState<string | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const inShell = useMemo(() => isShell(), []);
  const readiness = checkInReadiness();

  const refresh = useCallback(() => setConfigs(loadCheckInConfig()), []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("check-in-config-changed", onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => {
      window.removeEventListener("check-in-config-changed", onChange);
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [refresh]);

  const anyEnabled = Object.values(configs).some(item => item.enabled);

  const toggle = useCallback((characterId: string, on: boolean) => {
    saveCharacterCheckIn(characterId, { enabled: on });
    refresh();
    if (!on) {
      // 关到最后一个时把常驻服务也收掉，不留一个空跑的前台服务
      if (!Object.values(loadCheckInConfig()).some(item => item.enabled)) stopCheckInService();
      return;
    }
    if (!inShell) { onNotice?.("当前不在小手机 App 内，查岗需要安卓壳"); return; }
    if (!readiness.supported) { onNotice?.("系统版本太低，查岗需要 Android 11 及以上"); return; }
    if (!readiness.accessibilityOn) { onNotice?.("还需要开启无障碍服务，查岗才能截到屏"); return; }
    // 开启时把服务暖起来（此刻 App 在前台，是唯一能合法启动前台服务的时机）
    if (!prepareCheckInService()) {
      onNotice?.("没能准备查岗浮层，请先授予「显示在其他应用上层」权限");
      return;
    }
    onNotice?.("查岗已开启。到点它会截屏，但会先弹窗问你要不要给它看");
  }, [refresh, inShell, readiness.supported, readiness.accessibilityOn, onNotice]);

  const patch = useCallback((characterId: string, next: { minMinutes?: number; maxMinutes?: number; dailyLimit?: number }) => {
    saveCharacterCheckIn(characterId, next);
    refresh();
  }, [refresh]);

  const doTest = useCallback(async (characterId: string) => {
    if (busyId) return;
    setBusyId(characterId);
    try {
      const result = await runCheckIn(characterId, loadCheckInConfig()[characterId]);
      if (!result.ok) {
        onNotice?.(result.reason);
      } else if (result.accepted) {
        onNotice?.("已发给它，等它的回应");
      } else if (result.reason === "user_rejected") {
        onNotice?.("你选了不给——那张图已经丢弃");
      } else {
        onNotice?.("这次没能截图（已如实告诉它）");
      }
      refresh();
    } finally {
      setBusyId(null);
    }
  }, [busyId, onNotice, refresh]);

  const disableAll = useCallback(() => {
    disableAllCheckIn();
    stopCheckInService();
    refresh();
    onNotice?.("已关闭全部查岗");
  }, [refresh, onNotice]);

  return (
    <div>
      <div className="settings-menu-section-title">主动查岗</div>

      <div className="per-note is-warn" style={{ padding: "0 var(--ui-padding, 16px)", marginBottom: 10 }}>
        <div style={{ fontWeight: 600 }}>它会先截屏给你看，你点头才发给它</div>
        <div style={{ marginTop: 6, lineHeight: 1.65 }}>
          到点截屏 → 弹浮层问你 → 你点了才发。点「不给」当场丢弃，图没离开过本机。
        </div>
      </div>

      {!inShell && (
        <div className="per-note is-warn" style={{ padding: "0 var(--ui-padding, 16px)", marginBottom: 10 }}>
          当前不在小手机 App 内（浏览器/PWA）。查岗需要安卓壳，这里只能预览界面。
        </div>
      )}

      {characters.length === 0 ? (
        <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
          还没有角色。先创建角色，再回来给 TA 开启查岗。
        </div>
      ) : (
        <div className="page-menu" style={{ gap: 12 }}>
          {characters.map(character => {
            const config = configs[character.id];
            const enabled = config?.enabled === true;
            const min = config?.minMinutes ?? 30;
            const max = config?.maxMinutes ?? 90;
            const limit = config?.dailyLimit ?? 3;
            return (
              <div className="menu-group" key={character.id}>
                <div className="menu-item" style={{ cursor: "default" }}>
                  <div className="menu-label-group">
                    <span className="menu-label">{character.name}</span>
                    <span className="menu-desc">
                      {enabled ? `每 ${min}~${max} 分钟一次，每天最多 ${limit} 次` : "未开启"}
                    </span>
                  </div>
                  <Toggle checked={enabled} onChange={(v: boolean) => toggle(character.id, v)} />
                </div>

                {enabled && (
                  <>
                    {/* 间隔：两个直接输入的分钟数，不再给固定档位——
                        「我要 47 分钟」这种需求给按钮满足不了。 */}
                    <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                      <div className="menu-label-group">
                        <span className="menu-label">间隔（分钟）</span>
                        <span className="menu-desc">
                          在这个范围里随机取，不做固定节拍
                        </span>
                      </div>
                      <div className="menu-right" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          className="per-field-input"
                          style={{ width: 62 }}
                          type="number"
                          inputMode="numeric"
                          min={MIN_ALLOWED}
                          max={MAX_ALLOWED}
                          value={min}
                          aria-label="间隔下限（分钟）"
                          onChange={e => patch(character.id, { minMinutes: Number(e.target.value) })}
                        />
                        <span className="menu-desc">~</span>
                        <input
                          className="per-field-input"
                          style={{ width: 62 }}
                          type="number"
                          inputMode="numeric"
                          min={MIN_ALLOWED}
                          max={MAX_ALLOWED}
                          value={max}
                          aria-label="间隔上限（分钟）"
                          onChange={e => patch(character.id, { maxMinutes: Number(e.target.value) })}
                        />
                      </div>
                    </div>

                    <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                      <div className="menu-label-group">
                        <span className="menu-label">每天最多（次）</span>
                        <span className="menu-desc">到上限就停，不会没完没了</span>
                      </div>
                      <input
                        className="per-field-input"
                        style={{ width: 62 }}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={DAILY_ALLOWED}
                        value={limit}
                        aria-label="每天最多查岗次数"
                        onChange={e => patch(character.id, { dailyLimit: Number(e.target.value) })}
                      />
                    </div>

                    <div className="menu-item" style={{ cursor: "default" }}>
                      <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                        <Eye size={17} strokeWidth={1.8} />
                      </div>
                      <div className="menu-label-group">
                        <span className="menu-label">现在试一次</span>
                        <span className="menu-desc">立刻走一遍完整流程：截屏 → 弹浮层 → 你决定</span>
                      </div>
                      <button
                        type="button"
                        className="ui-btn ui-btn-outline"
                        disabled={busyId !== null}
                        onClick={() => void doTest(character.id)}
                      >
                        {busyId === character.id ? <Loader2 size={16} className="animate-spin" /> : "试一次"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="menu-group" style={{ marginTop: 12 }}>
        <div className="menu-item" style={{ cursor: "default" }}>
          <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
            <ShieldAlert size={17} strokeWidth={1.8} />
          </div>
          <div className="menu-label-group">
            <span className="menu-label">浮层就绪状态</span>
            <span className="menu-desc">
              {readiness.bridgeAvailable
                ? readiness.ready
                  ? "查岗浮层已就绪，到点能弹出来"
                  : !readiness.supported
                    ? "系统版本太低（需要 Android 11 及以上）"
                    : !readiness.accessibilityOn
                      ? "无障碍服务未开启"
                      : "浮窗权限未授予（与你开通话浮窗用的是同一个权限）"
                : "当前 App 版本还没有查岗浮层，请更新安卓壳"}
            </span>
          </div>
        </div>
      </div>

      {anyEnabled && (
        <div className="per-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={disableAll}>
            全部关闭
          </button>
        </div>
      )}
    </div>
  );
}
