/**
 * 全局生活主动消息调度器。
 *
 * 和 life-engine 里的“当前场景自主回合”不同：这里不要求用户打开生活页面，
 * 只看「玩家当前日程地点」和「角色当前日程地点」是否相同。相同就视为线下同场，
 * 在应用还活着时挂一条服务端离线预约；挂上之后退出 App/小手机，任务仍在
 * push_jobs 里，由服务端到点生成并推送。
 *
 * 这是“日程地点同场”的调度，不是“角色必须和玩家在同一个 active scene 对象里”。
 */
import { loadCharacters } from "@/lib/character-storage";
import { loadChatContacts, loadChatSessions } from "@/lib/chat-storage";
import { armLifeSceneProactiveBailout } from "@/lib/push-bailout-client";
import { buildLifeScenePromptOverride, getActiveLifePromptPreset, getLifePromptPresets } from "./life-presets";
import { loadVirtualLifeState, saveVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow, upsertLifeScene } from "./life-runtime";
import type { LifeSceneState, VirtualLifeState } from "./life-types";

const PLAYER_ID = "player";
const ARM_META_PREFIX = "life-schedule-arm:";
const TICK_MS = 60_000;
const MIN_DELAY_MS = 3 * 60_000;
const MAX_DELAY_MS = 9 * 60_000;

function playerLocation(state: VirtualLifeState): { id: string; name: string } | null {
  const now = resolveActorLifeNow(getActorClock(state, "player", PLAYER_ID));
  const slot = getCurrentActorSchedule(state, "player", PLAYER_ID, now);
  if (slot?.plannedLocationId) {
    return { id: slot.plannedLocationId, name: slot.plannedLocationName || state.locations.find(l => l.id === slot.plannedLocationId)?.name || "当前地点" };
  }
  const actor = state.actorStates.find(item => item.ownerType === "player" && item.ownerId === PLAYER_ID);
  if (actor?.actualLocationId) {
    return { id: actor.actualLocationId, name: actor.actualLocationName || state.locations.find(l => l.id === actor.actualLocationId)?.name || "当前地点" };
  }
  return null;
}

function characterLocation(state: VirtualLifeState, characterId: string): string | null {
  const now = resolveActorLifeNow(getActorClock(state, "character", characterId));
  const slot = getCurrentActorSchedule(state, "character", characterId, now);
  if (slot?.plannedLocationId) return slot.plannedLocationId;
  return state.actorStates.find(item => item.ownerType === "character" && item.ownerId === characterId)?.actualLocationId ?? null;
}

function ensureScene(state: VirtualLifeState, locationId: string, locationName: string, characterId: string): { state: VirtualLifeState; scene: LifeSceneState } {
  const now = new Date().toISOString();
  const existing = state.scenes.find(scene => scene.locationId === locationId && scene.status === "active")
    ?? state.scenes.find(scene => scene.locationId === locationId)
    ?? null;
  const participants = [
    { ownerType: "player" as const, ownerId: PLAYER_ID, activity: "在当前地点", awarenessByActorId: { [PLAYER_ID]: "aware" as const } },
    { ownerType: "character" as const, ownerId: characterId, activity: "在同一地点", awarenessByActorId: { [PLAYER_ID]: "aware" as const } },
  ];
  const scene: LifeSceneState = existing
    ? { ...existing, participants: [...existing.participants.filter(p => p.ownerType === "player" || p.ownerId !== characterId), ...participants.filter(p => !existing.participants.some(old => old.ownerType === p.ownerType && old.ownerId === p.ownerId))], updatedAt: now, status: "active" }
    : { id: "life-schedule-" + Date.now().toString(36), locationId, locationName, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
  // 只保留一个 active scene，避免服务端回写时找不到当前场景。
  const next: VirtualLifeState = {
    ...state,
    scenes: [
      ...state.scenes.filter(item => item.id !== scene.id).map(item => item.status === "active" && item.locationId !== locationId ? { ...item, status: "paused" as const, updatedAt: now } : item),
      scene,
    ],
  };
  return { state: upsertLifeScene(next, scene), scene };
}

function nextArmAt(triggerKey: string, now: number): number {
  try {
    const raw = localStorage.getItem(ARM_META_PREFIX + triggerKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { executeAt?: number };
      // 还未到执行时刻：沿用，避免每分钟 POST 把任务不断往后推。
      if (typeof parsed.executeAt === "number" && parsed.executeAt > now + 60_000) return parsed.executeAt;
    }
  } catch { /* fall through */ }
  const executeAt = now + MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  try { localStorage.setItem(ARM_META_PREFIX + triggerKey, JSON.stringify({ executeAt })); } catch { /* best effort */ }
  return executeAt;
}

const armedCache = new Map<string, number>();

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let stopped = false;

async function runOnce(): Promise<void> {
  if (running || stopped || typeof document === "undefined") return;
  running = true;
  try {
    const state = loadVirtualLifeState();
    if (!state.settings.enabled || !state.settings.enableCharacterAutonomy || state.settings.enableProactiveSceneMessages === false) return;
    const player = playerLocation(state);
    if (!player) return;
    const characters = loadCharacters();
    const presets = getLifePromptPresets(state.settings.promptPresets);
    const preset = getActiveLifePromptPreset(presets, state.settings.activePromptPresetId);
    const lifeScenePrompt = buildLifeScenePromptOverride(preset, state.settings.customPrompt);
    const now = Date.now();
    for (const character of characters) {
      if (characterLocation(state, character.id) !== player.id) continue;
      const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
      if (/睡眠|睡觉|入睡|午休/.test(actor?.activity || "")) continue;
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup);
      if (!session) continue;
      const sceneResult = ensureScene(state, player.id, player.name, character.id);
      const scene = sceneResult.scene;
      // 把场景持久化，outbox 回写时才能找到 active scene。
      saveVirtualLifeState(sceneResult.state);
      const trigger = scene.id + ":" + character.id;
      const executeAtMs = nextArmAt(trigger, now);
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
        lifeScenePrompt,
        executeAtMs,
      });
      if (!result.ok) console.warn("[LifeSchedule] 主动消息未挂上：", character.name, result.reason);
    }
  } catch (error) {
    console.warn("[LifeSchedule] scheduler failed:", error);
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
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  };
}
