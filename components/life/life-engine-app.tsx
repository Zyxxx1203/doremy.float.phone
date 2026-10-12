"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import {
  ArrowLeft, CalendarDays, Coffee, Heart, MapPin, MessageCircle,
  Pause, Play, Plus, RefreshCw, Send, Settings2, Sparkles,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { hydrateKvDb } from "@/lib/kv-db";
import { hydrateChatStorage, loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage } from "@/lib/chat-storage";
import { generateOfflineChatCompletion } from "@/lib/chat-engine";
import {
  createEmptyVirtualLifeState,
  DEFAULT_LIFE_ENGINE_SETTINGS,
  type LifeActorClock,
  type LifeEngineSettings,
  type LifeLocation,
  type LifeOwnerType,
  type LifeSceneMessage,
  type LifeSceneParticipant,
  type LifeSceneState,
  type LifeScheduleSlot,
  type VirtualLifeState,
} from "@/lib/life/life-types";
import { confirmLifeInvitation, fastForwardActor, generateWeeklyLifePlan, getActorClock, getCurrentActorSchedule, makeLifeInvitation, resolveActorLifeNow, upsertActorClock, upsertActorState, upsertLifeScene } from "@/lib/life/life-runtime";
import { loadVirtualLifeState, saveVirtualLifeState } from "@/lib/life/life-storage";
import { LIFE_SCENE_OUTPUT_CONTRACT, buildLifeScenePromptContext } from "@/lib/life/life-scene-prompt";
import { evaluateEncounterAwareness } from "@/lib/life/life-engine";

type Tab = "home" | "scene" | "plans" | "invitations" | "settings";
type ActorChoice = { ownerType: LifeOwnerType; ownerId: string; name: string; avatar?: string | null; persona?: string };
const PLAYER_ID = "player";
const INITIAL_LOCATIONS: LifeLocation[] = [
  { id: "home", name: "家", description: "可以休息、吃饭和独处的地方", visibility: "private" },
  { id: "cafe", name: "街角咖啡店", description: "适合偶遇和闲聊", visibility: "public" },
  { id: "park", name: "公园", description: "散步、运动或发呆", visibility: "public" },
  { id: "library", name: "图书馆", description: "安静学习与阅读", visibility: "public" },
];
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const fmt = (value: Date | string) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(typeof value === "string" ? new Date(value) : value);
const mondayStart = (date: Date) => { const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };

function parseLifeOutput(text: string): { action?: string; dialogue: string } {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const actionLines: string[] = [];
  const dialogueLines: string[] = [];
  for (const line of lines) {
    if (/^\*[^*].*\*$/.test(line) || /^（[^）]+）$/.test(line) || /^\*\*[^*].*\*\*$/.test(line)) actionLines.push(line.replace(/^\*+|\*+$/g, "").replace(/^（|）$/g, ""));
    else if (!/^<\/?(?:content|summary|thinking)>/i.test(line)) dialogueLines.push(line);
  }
  return { action: actionLines.join(" "), dialogue: dialogueLines.join("\n") || text.trim() };
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/70 px-4 py-3">
    <span className="min-w-0"><span className="block text-sm font-medium text-stone-800">{label}</span>{hint && <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">{hint}</span>}</span>
    <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? "bg-[#b88768]" : "bg-stone-300"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${checked ? "left-[22px]" : "left-0.5"}`} /></span>
  </label>;
}

function SectionTitle({ eyebrow, title, note }: { eyebrow: string; title: string; note?: string }) {
  return <div className="mb-4"><p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#a4775d]">{eyebrow}</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-stone-800">{title}</h2>{note && <p className="mt-1 text-sm leading-relaxed text-stone-500">{note}</p>}</div>;
}

export function LifeEngineApp({ onClose }: { onClose?: () => void } = {}) {
  const [state, setState] = useState<VirtualLifeState>(() => createEmptyVirtualLifeState());
  const stateRef = useRef(state);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [selectedActorKey, setSelectedActorKey] = useState("player:player");
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("cafe");
  const [newLocationName, setNewLocationName] = useState("");
  const [playerName, setPlayerName] = useState("我");
  const [playerActivity, setPlayerActivity] = useState("正在看看周围");
  const [sceneInput, setSceneInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [inviteCharacterId, setInviteCharacterId] = useState("");
  const [inviteLocationId, setInviteLocationId] = useState("cafe");
  const [inviteActivity, setInviteActivity] = useState("一起喝杯咖啡");
  const [inviteAt, setInviteAt] = useState(() => { const d = new Date(Date.now() + 60 * 60_000); d.setMinutes(0,0,0); return new Date(d.getTime() - d.getTimezoneOffset()*60_000).toISOString().slice(0,16); });

  useEffect(() => {
    let alive = true;
    void hydrateKvDb().then(() => hydrateChatStorage()).catch(() => undefined).finally(() => {
      if (!alive) return;
      const loaded = loadVirtualLifeState();
      const normalized = { ...loaded, locations: loaded.locations.length ? loaded.locations : INITIAL_LOCATIONS };
      stateRef.current = normalized;
      setState(normalized);
      setCharacters(loadCharacters());
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  const commit = useCallback((next: VirtualLifeState) => {
    setState(next);
    saveVirtualLifeState(next);
  }, []);

  const actors = useMemo<ActorChoice[]>(() => [
    { ownerType: "player", ownerId: PLAYER_ID, name: playerName },
    ...characters.map(char => ({ ownerType: "character" as const, ownerId: char.id, name: char.name, avatar: char.avatar, persona: [char.persona, char.personality].filter(Boolean).join("\n") })),
  ], [characters, playerName]);
  const activeScene = useMemo(() => state.scenes.find(scene => scene.status === "active") ?? state.scenes.find(scene => scene.status === "paused"), [state.scenes]);
  const sceneMessages = useMemo(() => activeScene ? state.sceneMessages.filter(message => message.sceneId === activeScene.id) : [], [state.sceneMessages, activeScene]);
  const selectedLocation = state.locations.find(location => location.id === selectedLocationId) ?? state.locations[0];
  const settings = state.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;

  useEffect(() => {
    if (!ready || !settings.autoGenerateWeeklyPlans) return;
    let next = state;
    const start = mondayStart(new Date());
    next = generateWeeklyLifePlan(next, "player", PLAYER_ID, playerName, start, { id: "home", name: "家" });
    for (const character of characters) next = generateWeeklyLifePlan(next, "character", character.id, character.name, start, { id: "home", name: "家" }, [character.persona, character.personality].filter(Boolean).join(" "), settings.generateSpecialEvents);
    if (next !== state) commit(next);
  }, [ready, settings.autoGenerateWeeklyPlans, characters, playerName, state, commit]);

  const patchSettings = (patch: Partial<LifeEngineSettings>) => commit({ ...state, settings: { ...settings, ...patch } });
  const patchActorClock = (actor: ActorChoice, patch: Partial<Pick<LifeActorClock, "mode" | "speed">>) => commit(upsertActorClock(state, actor.ownerType, actor.ownerId, patch));
  const actorNow = (actor: ActorChoice) => resolveActorLifeNow(getActorClock(state, actor.ownerType, actor.ownerId));
  const actorState = (actor: ActorChoice) => state.actorStates.find(item => item.ownerType === actor.ownerType && item.ownerId === actor.ownerId);
  const actorSchedule = (actor: ActorChoice) => getCurrentActorSchedule(state, actor.ownerType, actor.ownerId, actorNow(actor));
  const actorClockLabel = (clock: LifeActorClock) => clock.mode === "real-time" ? "跟随现实" : clock.mode === "review" ? "回顾暂停" : `模拟 ×${clock.speed}`;

  const ensurePlans = () => {
    let next = state;
    const start = mondayStart(new Date());
    next = generateWeeklyLifePlan(next, "player", PLAYER_ID, playerName, start, { id: "home", name: "家" });
    for (const character of characters) next = generateWeeklyLifePlan(next, "character", character.id, character.name, start, { id: "home", name: "家" }, [character.persona, character.personality].filter(Boolean).join(" "), settings.generateSpecialEvents);
    if (next === state) setNotice("本周计划已经存在，没有重新生成或覆盖你的修改。");
    else { commit(next); setNotice("已为你和角色生成本周可编辑的生活日程。"); }
  };

  const updateActorLocation = (actor: ActorChoice, locationId: string) => {
    const location = state.locations.find(item => item.id === locationId);
    if (!location) return;
    const current = actorState(actor);
    commit(upsertActorState(state, { ownerType: actor.ownerType, ownerId: actor.ownerId, activity: current?.activity || "正在这里活动", actualLocationId: location.id, actualLocationName: location.name, updatedAt: new Date().toISOString() }));
    setNotice(`${actor.name}的实际地点已更新为「${location.name}」。这与日程中的计划地点分开保存。`);
  };

  const createScene = () => {
    if (!settings.enabled) { setNotice("生活引擎当前已关闭，请先在自定义设置中启用。"); return; }
    if (!selectedLocation) { setNotice("请先创建或选择一个地点。"); return; }
    const chosen = characters.filter(char => selectedCharacterIds.includes(char.id));
    if (!chosen.length) { setNotice("至少选择一位角色，才能开始共同生活场景。"); return; }
    const now = new Date().toISOString();
    const ids = ["player", ...chosen.map(char => char.id)];
    const participants: LifeSceneParticipant[] = [
      { ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "正在看看周围", awarenessByActorId: Object.fromEntries(ids.filter(other => other !== PLAYER_ID).map(other => [other, "aware" as const])) },
      ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id, activity: "正在做自己的事", awarenessByActorId: Object.fromEntries(ids.filter(other => other !== char.id).map(other => [other, "aware" as const])) })),
    ];
    let next: VirtualLifeState = { ...state, scenes: state.scenes.map(scene => scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    const scene: LifeSceneState = { id: id("scene"), locationId: selectedLocation.id, locationName: selectedLocation.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    for (const actor of [{ ownerType: "player" as const, ownerId: PLAYER_ID }, ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id }))]) {
      next = upsertActorState(next, { ...actor, activity: actor.ownerType === "player" ? playerActivity : "正在做自己的事", actualLocationId: selectedLocation.id, actualLocationName: selectedLocation.name, updatedAt: now });
    }
    commit(next);
    setTab("scene");
    setNotice("共同场景已建立并保存；重新打开会接着当前状态，不会重演。");
  };

  /** Player arrival checks actual locations only; a planned location never creates an encounter. */
  const enterLocationSolo = () => {
    if (!settings.enabled) { setNotice("生活引擎当前已关闭，请先在自定义设置中启用。"); return; }
    if (!selectedLocation) return;
    const now = new Date().toISOString();
    const actualCharacters = settings.enableCoincidences
      ? characters.filter(char => state.actorStates.some(actor => actor.ownerType === "character" && actor.ownerId === char.id && actor.actualLocationId === selectedLocation.id))
      : [];
    const participants: LifeSceneParticipant[] = [{
      ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "正在看看周围", awarenessByActorId: {},
    }];
    for (const char of actualCharacters) {
      const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === char.id);
      if (!actor) continue;
      const perception = {
        distance: "medium" as const,
        lineOfSight: selectedLocation.visibility === "public",
        audible: true,
        attention: /专注|工作|学习|读书|写作|打电话/.test(actor.activity) ? "focused" as const : /发呆|等待|休息/.test(actor.activity) ? "distracted" as const : "normal" as const,
        activity: /等待|休息|发呆/.test(actor.activity) ? "waiting" as const : /工作|学习|读书|写作/.test(actor.activity) ? "busy" as const : "casual" as const,
        noticing: /外向|敏锐|警觉|好奇|观察力/.test(char.personality || "") ? 0.68 : 0.38,
        environmentNoise: /咖啡|车站|商场/.test(selectedLocation.name) ? 0.62 : 0.25,
      };
      const seed = [...char.id].reduce((sum, value) => sum + value.charCodeAt(0), 0);
      const awareness = evaluateEncounterAwareness(perception, seed);
      participants.push({ ownerType: "character", ownerId: char.id, activity: actor.activity, awarenessByActorId: { player: awareness } });
      participants[0].awarenessByActorId[char.id] = selectedLocation.visibility === "public" ? "aware" : "suspects";
    }
    let next: VirtualLifeState = { ...state, scenes: state.scenes.map(scene => scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    const scene: LifeSceneState = { id: id("scene"), locationId: selectedLocation.id, locationName: selectedLocation.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    next = upsertActorState(next, { ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "正在看看周围", actualLocationId: selectedLocation.id, actualLocationName: selectedLocation.name, updatedAt: now });
    commit(next);
    if (!actualCharacters.length) {
      const message: LifeSceneMessage = { id: id("turn"), sceneId: scene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: "场景记录", role: "system", dialogue: settings.enableCoincidences ? "你来到了这里。暂时没有发现实际在场的熟人；你可以自己待一会儿，也可以稍后再看看。" : "你来到了这里。偶遇功能当前关闭，你可以独自探索这个地点。", createdAt: now };
      commit({ ...stateRef.current, sceneMessages: [...stateRef.current.sceneMessages, message] });
    } else {
      const noticed = participants.filter(p => p.ownerType === "character" && p.awarenessByActorId.player === "aware").length;
      setNotice(noticed ? `你来到了${selectedLocation.name}，有角色注意到了你。` : `你来到了${selectedLocation.name}；有人在场，但暂时没人明确注意到你。`);
    }
    setTab("scene");
  };

