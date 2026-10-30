/**
 * 全局生活主动消息调度器。
 *
 * 和 life-engine 里的“前台场景自主回合”不同：这里负责 App 退到后台后的日程同场兜底。
 * 角色必须同时满足：当前日程/实际地点与玩家一致，并且已经是当前 active scene 的参与者；
 * 不再凭地点相同就伪造一个场景。前台场景持有短租约时，本调度器暂停并撤销自己的任务，
 * 由前台回合接管；前台退出或进程被系统回收后，租约过期，后台调度重新接手。
 */
import { loadCharacters } from "@/lib/character-storage";
import { loadChatContacts, loadChatSessions } from "@/lib/chat-storage";
import { armLifeSceneProactiveBailout, cancelBailoutPrefix } from "@/lib/push-bailout-client";
import { syncLifeScheduleSnapshot } from "./life-schedule-cloud";
import { loadVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow } from "./life-runtime";
import type { VirtualLifeState } from "./life-types";
import { recordLifeDiagnostic } from "./life-diagnostics";

const PLAYER_ID = "player";
const ARM_META_PREFIX = "life-schedule-arm:";
const STATUS_KEY = "life-proactive-last-status-v1";
const FOREGROUND_LEASE_KEY = "life-scene-foreground-lease-v1";

export function setLifeSceneForegroundLease(sceneId: string, active: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const current = JSON.parse(localStorage.getItem(FOREGROUND_LEASE_KEY) || "null") as { sceneId?: string } | null;
    if (active && sceneId) localStorage.setItem(FOREGROUND_LEASE_KEY, JSON.stringify({ sceneId, expiresAt: Date.now() + 120_000 }));
    else if (!sceneId || current?.sceneId === sceneId) localStorage.removeItem(FOREGROUND_LEASE_KEY);
  } catch { /* best effort lease */ }
}


export type LifeProactiveStatus = { at: string; ok: boolean; character?: string; reason?: string };
export function readLifeProactiveStatus(): LifeProactiveStatus | null {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    return raw ? JSON.parse(raw) as LifeProactiveStatus : null;
  } catch { return null; }
}
function writeLifeProactiveStatus(status: LifeProactiveStatus) {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(status)); } catch { /* best effort */ }
}
const TICK_MS = 60_000;
const MIN_DELAY_MS = 3 * 60_000;
const MAX_DELAY_MS = 9 * 60_000;

function resolvedLocation(state: VirtualLifeState, ownerType: "player" | "character", ownerId: string): { id: string; name: string } | null {
  const now = resolveActorLifeNow(getActorClock(state, ownerType, ownerId));
  const actor = state.actorStates.find(item => item.ownerType === ownerType && item.ownerId === ownerId);
  const slot = getCurrentActorSchedule(state, ownerType, ownerId, now);
  const until = actor?.actualLocationUntil ? Date.parse(actor.actualLocationUntil) : Number.NaN;
  const temporaryOverride = Boolean(actor?.actualLocationId && Number.isFinite(until) && until > now.getTime());
  const manualOverride = Boolean(actor?.actualLocationId && actor.actualLocationUntil == null && actor.actualLocationId !== slot?.plannedLocationId);
  const useActual = temporaryOverride || manualOverride;
  const locationId = (useActual ? actor?.actualLocationId : slot?.plannedLocationId) || actor?.actualLocationId || "";
  if (!locationId) return null;
  const locationName = (useActual ? actor?.actualLocationName : slot?.plannedLocationName)
    || actor?.actualLocationName
    || state.locations.find(location => location.id === locationId)?.name
    || "当前地点";
  return { id: locationId, name: locationName };
}

function playerLocation(state: VirtualLifeState): { id: string; name: string } | null {
  return resolvedLocation(state, "player", PLAYER_ID);
}

function characterLocation(state: VirtualLifeState, characterId: string): string | null {
  return resolvedLocation(state, "character", characterId)?.id ?? null;
}

function nextArmAt(triggerKey: string, now: number): number {
  try {
    const raw = localStorage.getItem(ARM_META_PREFIX + triggerKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { executeAt?: number };
      // 还未到执行时刻：沿用，避免每分钟 POST 把任务不断往后推。
      // 已经挂过服务端循环链的，不在客户端重复续排；让服务端 idleRepeat 继续。
      if ((parsed as { repeat?: boolean }).repeat === true) {
        const repeatUntil = Number((parsed as { repeatUntil?: number }).repeatUntil) || 0;
        if (repeatUntil > now) return 0;
        localStorage.removeItem(ARM_META_PREFIX + triggerKey);
      }
      if (typeof parsed.executeAt === "number" && parsed.executeAt > now + 60_000) return parsed.executeAt;
    }
  } catch { /* fall through */ }
  const executeAt = now + MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  const repeatUntil = executeAt + 20 * 60_000 * 24;
  try { localStorage.setItem(ARM_META_PREFIX + triggerKey, JSON.stringify({ executeAt, repeat: true, repeatUntil })); } catch { /* best effort */ }
  return executeAt;
}

const armedCache = new Map<string, number>();
/** 已取消过线下循环的 scene:character，避免每 60 秒重复 DELETE。 */
const cancelledOffline = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let stopped = false;

async function runOnce(): Promise<void> {
  if (running || stopped || typeof document === "undefined") return;
  running = true;
  try {
    const state = loadVirtualLifeState();
    if (!state.settings.enabled || !state.settings.enableCharacterAutonomy || state.settings.enableProactiveSceneMessages === false) { recordLifeDiagnostic({ source: "主动调度", event: "调度巡检跳过", status: "info", detail: "生活引擎、自主行动或主动消息开关处于关闭状态。", meta: { enabled: state.settings.enabled, autonomy: state.settings.enableCharacterAutonomy, proactive: state.settings.enableProactiveSceneMessages } }); return; }
    const snapshotSynced = await syncLifeScheduleSnapshot();
    if (!snapshotSynced) {
      recordLifeDiagnostic({ source: "主动调度", event: "快照未同步，暂停挂载", status: "error", detail: "无法确认最新玩家/角色地点，本轮不创建离线主动任务。" });
      return;
    }
    // Keep a server-side schedule chain armed even while the scene is foregrounded.
    // push-generate reads the lease in the snapshot and defers, rather than losing the
    // 24-turn background fallback if Android kills the WebView without a clean unload.
    const player = playerLocation(state);
    if (!player) return;
    const characters = loadCharacters();
    // 玩家离开后，旧地点的线下循环立即撤销；角色离开玩家地点也撤销它自己的链。
    const coLocated = new Set(
      characters.filter(character => characterLocation(state, character.id) === player.id).map(character => "life-scene:" + character.id),
    );
    for (const scene of state.scenes) {
      for (const participant of scene.participants) {
        if (participant.ownerType !== "character") continue;
        const exact = "life-scene:" + participant.ownerId;
        const triggerPrefix = "life-scene:" + scene.id + ":" + participant.ownerId;
        const isCoLocated = scene.locationId === player.id && coLocated.has(exact);
        if (!isCoLocated && !cancelledOffline.has(triggerPrefix)) {
          cancelledOffline.add(triggerPrefix);
          try { localStorage.removeItem(ARM_META_PREFIX + scene.id + ":" + participant.ownerId); } catch { /* best effort */ }
          void cancelBailoutPrefix(triggerPrefix).catch(() => undefined);
        } else if (isCoLocated) {
          cancelledOffline.delete(triggerPrefix);
        }
      }
    }
    const now = Date.now();
    for (const character of characters) {
      const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
      if (/睡眠|睡觉|入睡|午休/.test(actor?.activity || "")) continue;
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup);
      if (!session) continue;
      // 只在玩家当前所在的现场里触发：角色必须是 active scene 的参与者。
      // 不再按角色新建场景，避免同一地点出现多个互不相干的“生活现场”。
      const scene = state.scenes.find(item => item.status === "active"
        && item.participants.some(p => p.ownerType === "player")
        && item.participants.some(p => p.ownerType === "character" && p.ownerId === character.id && p.activity !== "离开"));
      if (!scene) continue;
      const trigger = scene.id + ":" + character.id;
      const executeAtMs = nextArmAt(trigger, now);
      if (!executeAtMs) continue;
      if (armedCache.get(trigger) === executeAtMs) continue;
      armedCache.set(trigger, executeAtMs);
      const result = await armLifeSceneProactiveBailout({
        sessionId: session.id,
        sceneId: scene.id,
        characterId: character.id,
        characterName: character.name,
        prompt: [
          "【日程同场自动搭话：不是对玩家新消息的回复】",
          "你和玩家当前都在：" + player.name,
          "角色：" + character.name,
          "请以角色身份自然发起一小回合生活现场对话或行动；不要替玩家发言，不要写成长篇。",
          "如果此刻没有自然的话可说，可以保持安静，但本轮优先给一句有来由的对白。",
        ].join("\n\n"),
        appId: "life",
        appTags: ["life", "turn", "autonomy", ...(state.settings.enableCharacterAutonomy ? ["tools"] : [])],
        executeAtMs,        // 20 分钟一轮，最多 24 轮（约 8 小时）；服务端执行完一单后自己续下一单，
        // 因此 App 完全关闭也能持续主动搭话。
        repeat: { intervalMs: 20 * 60_000, remaining: 24 },
        source: "schedule",
      });
      writeLifeProactiveStatus({ at: new Date().toISOString(), ok: result.ok, character: character.name, reason: result.ok ? undefined : result.reason });
      recordLifeDiagnostic({ source: "主动调度", event: result.ok ? "离线主动任务已挂载" : "离线主动任务挂载失败", status: result.ok ? "ok" : "error", detail: result.ok ? character.name + " 的主动消息已提交服务端预约。" : character.name + "：" + (result.reason || "未知原因"), meta: { sceneId: scene.id, characterId: character.id, sessionId: session.id, executeAt: new Date(executeAtMs).toISOString() } });
      if (!result.ok) {
        // 没挂上就清掉“已挂”标记，下一轮继续重试，不能一次失败永远不排。
        try { localStorage.removeItem(ARM_META_PREFIX + trigger); } catch { /* best effort */ }
        console.warn("[LifeSchedule] 主动消息未挂上：", character.name, result.reason);
      }
    }
  } catch (error) {
    console.warn("[LifeSchedule] scheduler failed:", error);
    recordLifeDiagnostic({ source: "主动调度", event: "调度器异常", status: "error", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}

export function installLifeScheduleProactiveScheduler(): () => void {
  if (typeof window === "undefined") return () => undefined;
  stopped = false;
  const start = () => { void runOnce(); };
  start();
  timer = setInterval(start, TICK_MS);
  const onVisible = () => { if (document.visibilityState === "visible") start(); };
  const onScheduleChanged = () => { void syncLifeScheduleSnapshot(true); start(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("life-force-sync", onScheduleChanged);
  window.addEventListener("virtual-life-state-updated", onScheduleChanged);
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("life-force-sync", onScheduleChanged);
    window.removeEventListener("virtual-life-state-updated", onScheduleChanged);
  };
}
