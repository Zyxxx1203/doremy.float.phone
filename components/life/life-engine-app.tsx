"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import {
  ArrowLeft, CalendarDays, Coffee, Heart, MapPin,
  Pause, Play, Plus, RefreshCw, Send, Settings2, Sparkles, Users, X,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { hydrateKvDb } from "@/lib/kv-db";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage } from "@/lib/chat-storage";
import { generateOfflineChatCompletion } from "@/lib/chat-engine";
import {
  createEmptyVirtualLifeState,
  DEFAULT_LIFE_ENGINE_SETTINGS,
  type LifeActorClock,
  type LifeActorState,
  type LifeEngineSettings,
  type LifeLocation,
  type LifeOwnerType,
  type LifeSceneMessage,
  type LifeSceneImage,
  type LifeSceneParticipant,
  type LifeSceneState,
  type LifeScheduleSlot,
  type VirtualLifeState,
} from "@/lib/life/life-types";
import { advanceActorTimeline, confirmLifeInvitation, generateWeeklyLifePlan, getActorClock, getCurrentActorSchedule, makeLifeInvitation, placeAppointmentInActorSchedule, resolveActorLifeNow, settleActorTimelineToNow, upsertActorClock, upsertActorState, upsertLifeScene } from "@/lib/life/life-runtime";
import { loadVirtualLifeState, saveVirtualLifeState } from "@/lib/life/life-storage";
import { LIFE_SCENE_OUTPUT_CONTRACT, buildLifeScenePromptContext } from "@/lib/life/life-scene-prompt";
import { evaluateEncounterAwareness } from "@/lib/life/life-engine";
import { loadImageGenerationSettings } from "@/lib/settings-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import { loadMediaObjectUrl, deleteMediaRef } from "@/lib/media-cache-storage";

type Tab = "home" | "scene" | "plans" | "invitations" | "settings";
type ActorChoice = { ownerType: LifeOwnerType; ownerId: string; name: string; avatar?: string | null; persona?: string };
const PLAYER_ID = "player";
const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_LOCATIONS: LifeLocation[] = [
  { id: "home", name: "家", description: "可以休息、吃饭和独处的地方", visibility: "private" },
  { id: "cafe", name: "街角咖啡店", description: "适合偶遇和闲聊", visibility: "public" },
  { id: "park", name: "公园", description: "散步、运动或发呆", visibility: "public" },
  { id: "library", name: "图书馆", description: "安静学习与阅读", visibility: "public" },
];
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const fmt = (value: Date | string) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(typeof value === "string" ? new Date(value) : value);
const mondayStart = (date: Date) => { const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };

function parseLifeOutput(text: string): { action?: string; dialogue: string; followRequest?: { durationMinutes: number; reason: string }; planChange?: { title: string; locationId: string; startAt: string; endAt: string }; invitation?: { time: string; locationId: string; activity: string; durationMinutes: number } } {
  const attribute = (source: string, name: string) => {
    const match = source.match(new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
    return (match?.[1] || "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").trim();
  };
  const followTag = text.match(/<life_follow_request\b([^>]*)\/?\s*>/i);
  const planTag = text.match(/<life_plan_change\b([^>]*)\/?\s*>/i);
  const inviteTag = text.match(/<life_invitation\b([^>]*)\/?\s*>/i);
  const duration = Number(attribute(followTag?.[1] || "", "durationMinutes"));
  const followRequest = followTag ? { durationMinutes: Math.max(15, Math.min(Number.isFinite(duration) && duration ? duration : 120, 24 * 60)), reason: attribute(followTag[1], "reason") } : undefined;
  const planChange = planTag ? { title: attribute(planTag[1], "title"), locationId: attribute(planTag[1], "locationId") || "home", startAt: attribute(planTag[1], "startAt"), endAt: attribute(planTag[1], "endAt") } : undefined;
  const inviteDuration = Number(attribute(inviteTag?.[1] || "", "durationMinutes"));
  const invitation = inviteTag ? { time: attribute(inviteTag[1], "time"), locationId: attribute(inviteTag[1], "locationId") || "cafe", activity: attribute(inviteTag[1], "activity") || "一起做点什么", durationMinutes: Math.max(15, Math.min(Number.isFinite(inviteDuration) && inviteDuration ? inviteDuration : 60, 24 * 60)) } : undefined;
  const clean = text.replace(/<life_follow_request\b[^>]*\/?\s*>/ig, "").replace(/<life_plan_change\b[^>]*\/?\s*>/ig, "").replace(/<life_invitation\b[^>]*\/?\s*>/ig, "").trim();
  const lines = clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const actionLines: string[] = [];
  const dialogueLines: string[] = [];
  for (const line of lines) {
    if (/^\*[^*].*\*$/.test(line) || /^（[^）]+）$/.test(line) || /^\*\*[^*].*\*\*$/.test(line)) actionLines.push(line.replace(/^\*+|\*+$/g, "").replace(/^（|）$/g, ""));
    else if (!/^<\/?(?:content|summary|thinking)>/i.test(line)) dialogueLines.push(line);
  }
  return { action: actionLines.join(" "), dialogue: dialogueLines.join("\n") || (actionLines.length ? "" : clean), followRequest, planChange, invitation };
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
  const closeApp = () => {
    if (onClose) { onClose(); return; }
    if (typeof window !== "undefined" && window.history.length > 1) window.history.back();
    else if (typeof window !== "undefined") window.location.assign("/");
  };
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

  const [playerActivity, setPlayerActivity] = useState("");
  const [sceneInput, setSceneInput] = useState("");
  const [sceneActionInput, setSceneActionInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [inviteCharacterId, setInviteCharacterId] = useState("");
  const [inviteLocationId, setInviteLocationId] = useState("cafe");
  const [inviteActivity, setInviteActivity] = useState("一起喝杯咖啡");
  const [inviteAt, setInviteAt] = useState(() => { const d = new Date(Date.now() + 60 * 60_000); d.setMinutes(0,0,0); return new Date(d.getTime() - d.getTimezoneOffset()*60_000).toISOString().slice(0,16); });
  const [customSceneTitle, setCustomSceneTitle] = useState("今天的相处");
  const [sceneImageBusy, setSceneImageBusy] = useState(false);
  const [imageObjectUrls, setImageObjectUrls] = useState<Record<string,string>>({});
  const [imageViewerIndex, setImageViewerIndex] = useState(0);
  const [imageParticipantIds, setImageParticipantIds] = useState<string[]>([]);
  const autoImageSceneRef = useRef<string | null>(null);

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
    stateRef.current = next;
    setState(next);
    saveVirtualLifeState(next);
  }, []);

  const settings = state.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;
  const sceneImagePrompt = settings.sceneImagePrompt;
  const playerName = settings.playerDisplayName || "我";
  const actors = useMemo<ActorChoice[]>(() => [
    { ownerType: "player", ownerId: PLAYER_ID, name: playerName },
    ...characters.map(char => ({ ownerType: "character" as const, ownerId: char.id, name: char.name, avatar: char.avatar, persona: [char.persona, char.personality].filter(Boolean).join("\n") })),
  ], [characters, playerName]);
  const selectedActor = actors.find(actor => `${actor.ownerType}:${actor.ownerId}` === selectedActorKey) ?? actors[0];
  const activeScene = useMemo(() => state.scenes.find(scene => scene.status === "active") ?? state.scenes.find(scene => scene.status === "paused"), [state.scenes]);
  const sceneMessages = useMemo(() => activeScene ? state.sceneMessages.filter(message => message.sceneId === activeScene.id) : [], [state.sceneMessages, activeScene]);
  const selectedLocation = state.locations.find(location => location.id === selectedLocationId) ?? state.locations[0];

  useEffect(() => {
    if (!ready) return;
    let next = state;
    const thisMonday = mondayStart(new Date());
    const nextMonday = new Date(thisMonday.getTime() + 7 * 24 * 60 * 60 * 1000);
    const owners = [
      { ownerType: "player" as const, ownerId: PLAYER_ID, name: playerName, profile: "" },
      ...characters.map(character => ({ ownerType: "character" as const, ownerId: character.id, name: character.name, profile: [character.persona, character.personality].filter(Boolean).join(" ") })),
    ];
    for (const owner of owners) {
      if (!next.actorClocks.some(clock => clock.ownerType === owner.ownerType && clock.ownerId === owner.ownerId)) {
        next = upsertActorClock(next, owner.ownerType, owner.ownerId, { mode: settings.defaultClockMode, speed: settings.defaultSpeed });
      }
      // The current week is always complete. The switch controls advance pre-generation only.
      next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, thisMonday, { id: "home", name: "家" }, owner.profile, settings.generateSpecialEvents);
      if (settings.autoGenerateWeeklyPlans) {
        next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, nextMonday, { id: "home", name: "家" }, owner.profile, settings.generateSpecialEvents);
      }
    }
    if (next !== state) commit(next);
  }, [ready, settings.autoGenerateWeeklyPlans, settings.generateSpecialEvents, settings.defaultClockMode, settings.defaultSpeed, characters, playerName, state, commit]);

  useEffect(() => {
    if (!ready) return;
    const settleAll = () => {
      let next = stateRef.current;
      const liveSettings = next.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;
      const roster = loadCharacters();
      const owners = [
        { ownerType: "player" as const, ownerId: PLAYER_ID, name: liveSettings.playerDisplayName || "我", profile: "" },
        ...roster.map(character => ({ ownerType: "character" as const, ownerId: character.id, name: character.name, profile: [character.persona, character.personality].filter(Boolean).join(" ") })),
      ];
      for (const owner of owners) {
        const virtualNow = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
        const existing = next.schedules.filter(slot => slot.ownerType === owner.ownerType && slot.ownerId === owner.ownerId);
        const latestEnd = existing.reduce((max, slot) => Math.max(max, new Date(slot.endAt).getTime()), Number.NEGATIVE_INFINITY);
        let week = mondayStart(Number.isFinite(latestEnd) && latestEnd > virtualNow.getTime() ? new Date(latestEnd - 1) : virtualNow);
        const target = mondayStart(virtualNow);
        const targetEnd = new Date(target.getTime() + (liveSettings.autoGenerateWeeklyPlans ? 7 : 0) * 24 * 60 * 60 * 1000);
        for (let guard=0; week.getTime() <= targetEnd.getTime() && guard<520; guard++, week=new Date(week.getTime()+7*24*60*60*1000)) {
          next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, week, {id:"home",name:"家"}, owner.profile, liveSettings.generateSpecialEvents);
        }
        next = settleActorTimelineToNow(next, owner.ownerType, owner.ownerId);
      }
      if (next !== stateRef.current) commit(next);
    };
    settleAll();
    const timer = window.setInterval(settleAll, 30_000);
    window.addEventListener("focus", settleAll);
    const onVisibility = () => { if (document.visibilityState === "visible") settleAll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", settleAll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, commit]);

  const patchSettings = (patch: Partial<LifeEngineSettings>) => commit({ ...state, settings: { ...settings, ...patch } });
  const patchActorClock = (actor: ActorChoice, patch: Partial<Pick<LifeActorClock, "mode" | "speed">>) => {
    const clock = getActorClock(state, actor.ownerType, actor.ownerId);
    if (clock.mode === "simulation" && patch.mode === "real-time") {
      const align = window.confirm("要把这个角色的虚拟时间对齐到现实时间吗？\n确定：对齐现实时间；取消：继续保持独立模拟。");
      commit(upsertActorClock(state, actor.ownerType, actor.ownerId, { mode: align ? "real-time" : "simulation" }));
      return;
    }
    commit(upsertActorClock(state, actor.ownerType, actor.ownerId, patch));
  };
  const actorNow = (actor: ActorChoice) => resolveActorLifeNow(getActorClock(state, actor.ownerType, actor.ownerId));
  const actorState = (actor: ActorChoice) => state.actorStates.find(item => item.ownerType === actor.ownerType && item.ownerId === actor.ownerId);
  const actorSchedule = (actor: ActorChoice) => getCurrentActorSchedule(state, actor.ownerType, actor.ownerId, actorNow(actor));
  const advanceCharacterAutonomy = (actor: ActorChoice) => {
    if (actor.ownerType !== "character" || !settings.enableCharacterAutonomy) return;
    let next = advanceActorTimeline(state, actor.ownerType, actor.ownerId, 60, actor.name, actor.persona ?? "");
    const virtualNow = resolveActorLifeNow(getActorClock(next, actor.ownerType, actor.ownerId));
    const slot = getCurrentActorSchedule(next, actor.ownerType, actor.ownerId, virtualNow);
    const previous = state.actorStates.find(item => item.ownerType === actor.ownerType && item.ownerId === actor.ownerId);
    next = upsertActorState(next, {
      ownerType: actor.ownerType, ownerId: actor.ownerId,
      activity: slot?.title ?? previous?.activity ?? "正在自主安排时间",
      actualLocationId: slot?.plannedLocationId ?? previous?.actualLocationId ?? null,
      actualLocationName: slot?.plannedLocationName ?? previous?.actualLocationName ?? null,
      updatedAt: new Date().toISOString(),
    });
    commit(next);
    setNotice(`${actor.name}独立度过了一个虚拟小时；其他人的时间没有变化。`);
  };

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

  const recordPlayerAction = () => {
    const text = playerActivity.trim();
    if (!text) { setNotice("先写下你现在正在做什么。"); return; }
    const latest = stateRef.current;
    const currentPlayer = latest.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
    const locationId = currentPlayer?.actualLocationId ?? selectedLocation?.id ?? null;
    const locationName = currentPlayer?.actualLocationName ?? selectedLocation?.name ?? null;
    const now = new Date().toISOString();
    let next = upsertActorState(latest, {
      ownerType: "player", ownerId: PLAYER_ID, activity: text,
      scheduleSlotId: currentPlayer?.scheduleSlotId ?? null,
      actualLocationId: locationId, actualLocationName: locationName, updatedAt: now,
    });
    const currentScene = next.scenes.find(scene => scene.status === "active") ?? next.scenes.find(scene => scene.status === "paused");
    if (currentScene) {
      const participants = currentScene.participants.map(participant =>
        participant.ownerType === "player" && participant.ownerId === PLAYER_ID ? { ...participant, activity: text } : participant,
      );
      next = upsertLifeScene(next, { ...currentScene, participants, updatedAt: now });
      next = { ...next, sceneMessages: [...next.sceneMessages, {
        id: id("turn"), sceneId: currentScene.id, speakerType: "player", speakerId: PLAYER_ID,
        speakerName: playerName, role: "player", action: text, dialogue: "", createdAt: now,
      }] };
      const colocated = next.actorStates.filter(actor => actor.actualLocationId && actor.actualLocationId === locationId).map(actor => actor.ownerId);
      const participantsInFact = [...new Set([PLAYER_ID, ...colocated])];
      if (settings.saveConfirmedEventsToMemory) {
        const eventId = id("event");
        const eventNow = resolveActorLifeNow(getActorClock(next, "player", PLAYER_ID)).toISOString();
        next = {
          ...next,
          events: [...next.events, {
            id: eventId, kind: "activity" as const, status: "completed" as const,
            startsAt: eventNow, endsAt: eventNow,
            locationId: locationId ?? undefined, locationName: locationName ?? undefined,
            participantIds: participantsInFact, title: text,
            details: "玩家在共同生活场景中执行了该行动。", createdAt: now, updatedAt: now, completedAt: now,
          }],
          memories: [{
            id: id("memory"), eventId, occurredAt: eventNow, participants: participantsInFact,
            fact: playerName + "在" + (locationName ?? currentScene.locationName) + "：" + text,
          }, ...next.memories].slice(0, 500),
        };
      }
    }
    commit(next);
    setNotice("已记录你的行动；当前日程计划不会被改写，实际行为和地点单独保存。");
  };

  const createScene = () => {
    if (!settings.enabled) { setNotice("生活引擎当前已关闭，请先在自定义设置中启用。"); return; }
    if (!selectedLocation) { setNotice("请先创建或选择一个地点。"); return; }
    const chosen = characters.filter(char => selectedCharacterIds.includes(char.id));
    if (!chosen.length) { setNotice("至少选择一位角色，才能开始共同生活场景。"); return; }
    const now = new Date().toISOString();
    const ids = ["player", ...chosen.map(char => char.id)];
    const participants: LifeSceneParticipant[] = [
      { ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "刚来到这里", awarenessByActorId: Object.fromEntries(ids.filter(other => other !== PLAYER_ID).map(other => [other, "aware" as const])) },
      ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id, activity: "正在做自己的事", awarenessByActorId: Object.fromEntries(ids.filter(other => other !== char.id).map(other => [other, "aware" as const])) })),
    ];
    let next: VirtualLifeState = { ...state, scenes: state.scenes.map(scene => scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    const scene: LifeSceneState = { id: id("scene"), locationId: selectedLocation.id, locationName: selectedLocation.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    for (const actor of [{ ownerType: "player" as const, ownerId: PLAYER_ID }, ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id }))]) {
      next = upsertActorState(next, { ...actor, activity: actor.ownerType === "player" ? (playerActivity || "刚来到这里") : "正在做自己的事", actualLocationId: selectedLocation.id, actualLocationName: selectedLocation.name, updatedAt: now });
    }
    commit(next);
    setTab("home");
    setNotice("共同场景已建立并保存；重新打开会接着当前状态，不会重演。");

  };

  /** Arrival uses actual-location state only; planned locations never create encounters. */
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
      setNotice(noticed ? "你来到了" + selectedLocation.name + "，有角色注意到了你。" : "你来到了" + selectedLocation.name + "；有人在场，但暂时没人明确注意到你。");
    }
    setTab("home");
  };

  const autoImageFingerprint = activeScene
    ? [activeScene.id, activeScene.locationId, ...activeScene.participants.map(participant => participant.ownerType + ":" + participant.ownerId + ":" + participant.activity)].join("|")
    : "";
  useEffect(() => {
    const maybeGenerate = () => {
      if (!ready || !activeScene || !settings.autoGenerateSceneImages || !autoImageFingerprint || activeScene.lastAutoImageFingerprint === autoImageFingerprint || autoImageSceneRef.current === autoImageFingerprint) return;
      if (!loadImageGenerationSettings().enabled) {
        setNotice("已开启场景自动生图；请先在「小手机设置 → 生图设置」启用生图服务，启用后会自动尝试。");
        return;
      }
      autoImageSceneRef.current = autoImageFingerprint;
      void generateSceneImages({count:settings.sceneImageCount,autoFingerprint:autoImageFingerprint});
    };
    maybeGenerate();
    window.addEventListener("settings-image-generation-updated", maybeGenerate);
    return () => window.removeEventListener("settings-image-generation-updated", maybeGenerate);
  }, [ready, autoImageFingerprint, settings.autoGenerateSceneImages, settings.sceneImageCount]);

remove draft sync  const sceneImageRecords = activeScene?.images ?? [];
  useEffect(() => {
    let alive = true;
    const urls: Record<string,string> = {};
    void Promise.all(sceneImageRecords.map(async image => {
      const url = await loadMediaObjectUrl(image.mediaRef);
      if (url) urls[image.id] = url;
    })).then(() => {
      if (!alive) { Object.values(urls).forEach(url=>URL.revokeObjectURL(url)); return; }
      setImageObjectUrls(previous => {
        Object.values(previous).forEach(url=>URL.revokeObjectURL(url));
        return urls;
      });
    });
    return () => { alive = false; };
  }, [activeScene?.id, sceneImageRecords.map(image=>image.id+":"+image.status).join("|")]);

  const composeSceneReferenceSheet = async (participantIds: string[]): Promise<string | undefined> => {
    const imageSettings = loadImageGenerationSettings();
    const sources: Array<{label:string;dataUrl:string}> = [];
    const playerAsset = imageSettings.userAppearanceReferenceAssetId;
    if(playerAsset && participantIds.includes(PLAYER_ID)) {
      const dataUrl=await getChatImageFromIndexedDB(playerAsset);
      if(dataUrl) sources.push({label:playerName,dataUrl});
    }
    for(const participantId of participantIds) {
      const ref=imageSettings.characterReferences?.[participantId];
      if(!ref?.assetId||ref.enabled===false)continue;
      const dataUrl=await getChatImageFromIndexedDB(ref.assetId);
      if(dataUrl) sources.push({label:characters.find(char=>char.id===participantId)?.name||"角色",dataUrl});
    }
    if(!sources.length)return undefined;
    const decoded=await Promise.all(sources.map(({label,dataUrl})=>new Promise<{label:string;image:HTMLImageElement}>((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve({label,image});image.onerror=()=>reject(new Error("参考图读取失败"));image.src=dataUrl;
    })));
    const cellW=512,cellH=340,cols=Math.min(2,decoded.length),rows=Math.ceil(decoded.length/cols);
    const canvas=document.createElement("canvas");canvas.width=cols*cellW;canvas.height=rows*cellH;
    const ctx=canvas.getContext("2d");if(!ctx)return undefined;
    ctx.fillStyle="#f7f0e7";ctx.fillRect(0,0,canvas.width,canvas.height);
    decoded.forEach(({label,image},index)=>{
      const x=(index%cols)*cellW,y=Math.floor(index/cols)*cellH;
      const scale=Math.min((cellW-32)/image.naturalWidth,(cellH-58)/image.naturalHeight);
      const w=image.naturalWidth*scale,h=image.naturalHeight*scale;
      ctx.drawImage(image,x+(cellW-w)/2,y+8+(cellH-48-h)/2,w,h);
      ctx.fillStyle="#49392f";ctx.font="600 18px sans-serif";ctx.textAlign="center";ctx.fillText(label,x+cellW/2,y+cellH-16,cellW-24);
    });
    return canvas.toDataURL("image/png");
  };

  const buildSceneImagePrompt = (participantIds: string[], customPrompt: string) => {
    const imageSettings = loadImageGenerationSettings();
    const parts = [
      "为虚拟生活场景生成一张单帧画面，不是拼贴、漫画分格或文字海报。",
      "当前场景："+(activeScene?.locationName || selectedLocation?.name || "日常场景"),
      "场景状态："+(activeScene?.participants.map(p=>{const actor=actors.find(a=>a.ownerId===p.ownerId&&a.ownerType===p.ownerType);return (actor?.name||p.ownerId)+"正在"+p.activity;}).join("；") || playerActivity),
      participantIds.includes(PLAYER_ID) && imageSettings.userAppearanceDescription?.trim() ? "玩家固定外观："+imageSettings.userAppearanceDescription.trim() : "",
      ...participantIds.map(pid=>{
        const char=characters.find(item=>item.id===pid);
        if(!char)return "";
        const ref=imageSettings.characterReferences?.[char.id];
        return char.name+"的外观与性格："+[char.persona,char.personality,ref?.featurePrompt].filter(Boolean).join("；");
      }),
      settings.sceneImageStyle,
      customPrompt.trim(),
    ];
    return parts.filter(Boolean).join("\n");
  };

  const generateSceneImages = async (options?: { prompt?: string; participantIds?: string[]; count?: number; autoFingerprint?: string }) => {
    if (!activeScene || sceneImageBusy) return;
    const imageSettings = loadImageGenerationSettings();
    if (!imageSettings.enabled) { setNotice("请先到「设置 → 生图设置」启用并配置生图 API。"); return; }
    const participantIds = options?.participantIds ?? (imageParticipantIds.length ? imageParticipantIds : activeScene.participants.filter(p=>p.ownerType==="character").map(p=>p.ownerId));
    const prompt = buildSceneImagePrompt(participantIds, options?.prompt ?? sceneImagePrompt);
    const count = Math.max(1,Math.min(4,options?.count ?? settings.sceneImageCount));
    setSceneImageBusy(true);
    setNotice("正在生成场景图。每张图会独立保存，失败的图片不会影响已有图库。");
    const generated: LifeSceneImage[] = [];
    try {
      const referenceSheet = await composeSceneReferenceSheet(participantIds);
      for(let index=0;index<count;index++){
        const referenceCharacterId = participantIds.find(pid=>imageSettings.characterReferences?.[pid]?.assetId && imageSettings.characterReferences?.[pid]?.enabled !== false);
        const result = await generateImageFromConfiguredApi({
          description: prompt+(count>1?"\n画面方案："+(index+1)+"，请在同一场景和角色外观基础上尝试不同自然构图。":""),
          characterId: referenceCharacterId,
          appId: "story",
          useReferenceImage: Boolean(referenceSheet || referenceCharacterId),
          referenceImageDataUrl: referenceSheet,
        });
        if(!result) throw new Error("生图服务未返回图片，请检查 API 配置和启用状态。");
        generated.push({id:id("scene-image"),sceneId:activeScene.id,mediaRef:result.mediaRef,prompt:result.prompt,participantIds:[...participantIds],createdAt:new Date().toISOString(),status:"active",alt:activeScene.locationName+"场景图"});
      }
      const latest=stateRef.current;
      const scene=latest.scenes.find(item=>item.id===activeScene.id);
      if(scene){
        const updated={...scene,images:[...(scene.images??[]).map(image=>({...image,status:"archived" as const})),...generated],lastAutoImageFingerprint:options?.autoFingerprint ?? scene.lastAutoImageFingerprint,updatedAt:new Date().toISOString()};
        commit({...latest,scenes:latest.scenes.map(item=>item.id===scene.id?updated:item)});
        setImageViewerIndex(0);
        setNotice("生成完成。旧图已归档，可在图库中恢复或删除以释放缓存空间。");
      }
    } catch(error) {
      await Promise.all(generated.map(image=>deleteMediaRef(image.mediaRef)));
      setNotice("场景图生成失败："+(error instanceof Error?error.message:"未知错误")+"；本轮未完成的图片已清理，旧图库未受影响。");
    } finally { setSceneImageBusy(false); }
  };

  const setSceneImageStatus = (imageId:string,status:"active"|"archived") => {
    if(!activeScene)return;
    const next={...stateRef.current,scenes:stateRef.current.scenes.map(scene=>scene.id!==activeScene.id?scene:{...scene,images:(scene.images??[]).map(image=>image.id===imageId?{...image,status}:image),updatedAt:new Date().toISOString()})};
    commit(next);
  };
  const removeSceneImage = async (imageId:string) => {
    if(!activeScene)return;
    const image=(activeScene.images??[]).find(item=>item.id===imageId);
    if(!image)return;
    const latest={...stateRef.current,scenes:stateRef.current.scenes.map(scene=>scene.id!==activeScene.id?scene:{...scene,images:(scene.images??[]).filter(item=>item.id!==imageId),updatedAt:new Date().toISOString()})};
    commit(latest);
    const url=imageObjectUrls[imageId]; if(url) URL.revokeObjectURL(url);
    setImageObjectUrls(previous=>{const copy={...previous};delete copy[imageId];return copy;});
    await deleteMediaRef(image.mediaRef);
    setNotice("图片记录已删除，关联媒体缓存也已清理。");
  };

  const pushSceneMessage = (message: LifeSceneMessage) => {
    const latest = stateRef.current;
    const currentScene = latest.scenes.find(scene => scene.status === "active") ?? latest.scenes.find(scene => scene.status === "paused");
    const updatedScene = currentScene ? { ...currentScene, updatedAt: new Date().toISOString() } : null;
    let next = { ...latest, sceneMessages: [...latest.sceneMessages, message] };
    if (updatedScene) next = upsertLifeScene(next, updatedScene);
    commit(next);
  };

  const sendSceneTurn = async (event: FormEvent) => {
    event.preventDefault();
    const userText = sceneInput.trim();
    const userAction = sceneActionInput.trim();
    if (!activeScene || (!userText && !userAction) || busy) return;
    const userTurn = [userAction ? `行动：${userAction}` : "", userText ? `说话：${userText}` : ""].filter(Boolean).join("\n");
    setSceneInput("");
    setSceneActionInput("");
    const now = new Date().toISOString();
    pushSceneMessage({ id: id("turn"), sceneId: activeScene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: playerName, role: "player", action: userAction || undefined, dialogue: userText, createdAt: now });
    const targetId = selectedSpeakerId || activeScene.participants.find(p => p.ownerType === "character")?.ownerId || "";
    const target = characters.find(char => char.id === targetId);
    if (!target) { setNotice("请先选择场景中的一位角色作为回应对象。"); return; }
    const targetClock = getActorClock(stateRef.current, "character", target.id);
    const targetNow = resolveActorLifeNow(targetClock);
    const targetSchedule = getCurrentActorSchedule(stateRef.current, "character", target.id, targetNow);
    const targetPresence = stateRef.current.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === target.id);
    const isSleeping = /睡眠|睡觉|入睡|午休/.test((targetPresence?.activity || "") + " " + (targetSchedule?.title || ""));
    const urgentMessage = /救命|紧急|出事了|危险|受伤|快来|急救/.test(userTurn);
    const easySleeper = /浅眠|警觉|敏感|担心|保护欲|容易醒/.test(target.personality || "");
    const wakeSeed = [...(target.id + userText)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const wokeFromSleep = isSleeping && (urgentMessage || wakeSeed % 100 < (easySleeper ? 60 : 15));
    if (isSleeping && settings.allowCharactersToStaySilent && !wokeFromSleep) {
      setNotice(target.name + "正在睡觉，没有被这条消息叫醒。消息留在当前场景里；TA醒来后才可能回应。");
      return;
    }
    const contacts = loadChatContacts();
    const sessions = loadChatSessions();
    const contact = contacts.find(item => item.characterId === target.id);
    const session = sessions.find(item => item.contactId === contact?.id && !item.isGroup);
    if (!session) { setNotice(`找不到「${target.name}」的线上聊天会话。请先在小手机中与TA建立私聊，再回来使用共享角色设定生成场景回应。`); return; }
    setBusy(true);
    try {
      const previous = loadChatMessages(session.id, 12).filter(message => message.status !== "failed" && !message.isRetracted);
      const sceneContext = buildLifeScenePromptContext(stateRef.current, activeScene, target.id);
      const settingsInstructions = [
        LIFE_SCENE_OUTPUT_CONTRACT,
        settings.showActionNarration ? "动作旁白要短，单独一行使用 *动作* 格式；对白只写说出口的话。" : "不要输出动作旁白，只输出角色说出口的话。",
        settings.keepDialogueConcise ? "一轮通常 1-3 句，除非用户明确要求展开。" : "允许适度展开，但仍保持实时互动感。",
        settings.allowCharactersToStaySilent ? "如果角色当下忙碌、没注意到或不想说话，可以自然沉默。" : "本轮需要对玩家的输入作出回应。",
        wokeFromSleep ? "角色原本正在睡觉，本轮是被消息或紧急情况吵醒；要表现困倦、反应迟缓或不想立刻长谈，不要突然精神饱满。" : "",
        settings.enableAmbientDetails ? "可以用一两笔简短环境细节营造现场感，不要扩写成长篇旁白。" : "不需要环境氛围描写，直接进行实时互动。",
        settings.enableCharacterAutonomy ? [
          "你可以按需调用下列已启用的生活工具，通过隐藏标签调用，不要向玩家解释标签。",
          settings.enableScheduleChangeTool ? "change_schedule：<life_plan_change startAt=\"ISO-8601开始时间\" endAt=\"ISO-8601结束时间\" title=\"新的安排\" locationId=\"home\" />。只调整当前虚拟日未来时段，保留前后日程，不覆盖确认约会。" : "",
          settings.enableInvitations ? "propose_invitation：<life_invitation time=\"ISO-8601时间\" locationId=\"cafe\" activity=\"活动\" durationMinutes=\"60\" />。这是待确认邀约，玩家确认后才同步日程。" : "",
          settings.enableInvitations && settings.enableFollowRequestTool ? "request_follow：<life_follow_request durationMinutes=\"120\" reason=\"简短原因\" />。需要玩家确认，可被拒绝。" : "",
          "每轮最多调用一个工具，仅在角色有真实动机时调用，不要为了展示功能调用。"
        ].filter(Boolean).join(" ") : "角色自主行动工具已关闭，不要输出生活工具标签.",
        settings.customPrompt ? `用户自定义规则：${settings.customPrompt}` : "",
      ].filter(Boolean).join("\n");
      const promptMessage: ChatMessage = {
        id: id("life-user"), sessionId: session.id, role: "user", status: "sent", createdAt: now,
        content: `[仅本轮使用生活场景模式规则，不要写入线上聊天历史]\n${settingsInstructions}\n\n${sceneContext}\n\n玩家本轮行动：${userAction || "（没有额外动作）"}\n玩家本轮对白：${userText || "（没有说话）"}\n请让${target.name}按其既有人设自然回应。行动与对白分开处理；玩家只行动时，不要擅自替玩家补台词。`,
      };
      const result = await generateOfflineChatCompletion(session, [...previous, promptMessage]);
      const parsed = parseLifeOutput(result.content);
      let structuredNext = stateRef.current;
      if (settings.enableCharacterAutonomy && settings.enableScheduleChangeTool && parsed.planChange?.title) {
        const characterNow = resolveActorLifeNow(getActorClock(structuredNext, "character", target.id));
        const startAt = new Date(parsed.planChange.startAt);
        const endAt = new Date(parsed.planChange.endAt);
        const sameDay = Number.isFinite(startAt.getTime()) && Number.isFinite(endAt.getTime())
          && startAt.getFullYear() === characterNow.getFullYear() && startAt.getMonth() === characterNow.getMonth() && startAt.getDate() === characterNow.getDate()
          && endAt.getFullYear() === characterNow.getFullYear() && endAt.getMonth() === characterNow.getMonth() && endAt.getDate() === characterNow.getDate();
        const location = structuredNext.locations.find(item => item.id === parsed.planChange?.locationId) ?? structuredNext.locations.find(item => item.id === "home");
        if (sameDay && startAt > characterNow && endAt > startAt) {
          const conflict = structuredNext.schedules.some(slot => slot.ownerType === "character" && slot.ownerId === target.id && slot.kind === "appointment" && new Date(slot.startAt) < endAt && new Date(slot.endAt) > startAt);
          if (!conflict) {
            const preserved: LifeScheduleSlot[] = [];
            for (const slot of structuredNext.schedules) {
              if (slot.ownerType !== "character" || slot.ownerId !== target.id || slot.kind === "appointment" || new Date(slot.endAt) <= startAt || new Date(slot.startAt) >= endAt) { preserved.push(slot); continue; }
              const a = new Date(slot.startAt).getTime(), b = new Date(slot.endAt).getTime();
              if (a < startAt.getTime()) preserved.push({ ...slot, id: slot.id + "-before-" + id("plan"), endAt: startAt.toISOString(), updatedAt: new Date().toISOString() });
              if (b > endAt.getTime()) preserved.push({ ...slot, id: slot.id + "-after-" + id("plan"), startAt: endAt.toISOString(), updatedAt: new Date().toISOString() });
            }
            preserved.push({ id: id("plan-change"), ownerType: "character", ownerId: target.id, startAt: startAt.toISOString(), endAt: endAt.toISOString(), title: parsed.planChange.title, plannedLocationId: location?.id ?? "home", plannedLocationName: location?.name ?? "家", kind: "free-time", source: "manual", updatedAt: new Date().toISOString() });
            structuredNext = { ...structuredNext, schedules: preserved.sort((a,b)=>a.startAt.localeCompare(b.startAt)) };
            setNotice(target.name + "调整了今天 " + startAt.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) + " 至 " + endAt.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) + " 的日程，其他时段保持不变。");
          } else setNotice(target.name + "想调整日程，但该时段已有确认约会，因此没有覆盖。");
        } else setNotice(target.name + "想调整日程，但时间不在当前虚拟日或已过去，因此没有修改。");
      }
      if (settings.enableCharacterAutonomy && parsed.invitation && settings.enableInvitations) {
        const proposedDate = new Date(parsed.invitation.time);
        const playerNow = resolveActorLifeNow(getActorClock(structuredNext, "player", PLAYER_ID));
        const characterNow = resolveActorLifeNow(getActorClock(structuredNext, "character", target.id));
        if (Number.isFinite(proposedDate.getTime()) && proposedDate > playerNow && proposedDate > characterNow) {
          const location = structuredNext.locations.find(item=>item.id===parsed.invitation?.locationId) ?? structuredNext.locations.find(item=>item.id==="cafe");
          structuredNext = makeLifeInvitation(structuredNext, {
            proposedBy: "character",
            characterId: target.id, playerId: PLAYER_ID, proposedAt: proposedDate.toISOString(),
            locationId: location?.id, locationName: location?.name, activity: parsed.invitation.activity,
            kind: "appointment", durationMinutes: parsed.invitation.durationMinutes,
          });
          setNotice(target.name+"主动提出邀约。请在「邀约活动」中确认、拒绝或调整；未确认前不会更改日程。");
        } else {
          setNotice(target.name+"提出的邀约时间无效或已经过去，因此没有写入日程。");
        }
      }
      if (settings.enableCharacterAutonomy && settings.enableFollowRequestTool && settings.enableInvitations && parsed.followRequest) {
        const playerNow = resolveActorLifeNow(getActorClock(structuredNext, "player", PLAYER_ID));
        const characterNow = resolveActorLifeNow(getActorClock(structuredNext, "character", target.id));
        const playerPresence = structuredNext.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
        structuredNext = makeLifeInvitation(structuredNext, {
          proposedBy: "character",
          characterId: target.id, playerId: PLAYER_ID,
          proposedAt: new Date(Math.max(playerNow.getTime(), characterNow.getTime()) + 60_000).toISOString(),
          locationId: playerPresence?.actualLocationId ?? undefined,
          locationName: playerPresence?.actualLocationName ?? undefined,
          activity: "申请陪伴并跟随你的行程" + (parsed.followRequest.reason ? "（" + parsed.followRequest.reason + "）" : ""),
          kind: "follow-request", durationMinutes: parsed.followRequest.durationMinutes,
        });
        setNotice(target.name + "提出了陪伴申请；你可以在「邀约活动」中确认或拒绝。");
      }
      if (structuredNext !== stateRef.current) commit(structuredNext);
      pushSceneMessage({ id: id("turn"), sceneId: activeScene.id, speakerType: "character", speakerId: target.id, speakerName: target.name, role: "character", action: settings.showActionNarration ? parsed.action : undefined, dialogue: parsed.dialogue, createdAt: new Date().toISOString() });
      if (settings.saveConfirmedEventsToMemory && (userText.trim() || userAction.trim()) && (parsed.dialogue.trim() || parsed.action?.trim())) {
        const eventId = id("event"), eventNow = new Date().toISOString();
        const event = { id: eventId, kind: "activity" as const, status: "completed" as const, locationId: activeScene.locationId, locationName: activeScene.locationName, participantIds: ["player", target.id], title: userAction.trim() && !userText.trim() ? "生活场景行动" : "生活场景互动", details: `${playerName}行动：${userAction || "无"}\n${playerName}对白：${userText || "无"}\n${target.name}行动：${parsed.action || "无"}\n${target.name}对白：${parsed.dialogue || "无"}`, createdAt: eventNow, updatedAt: eventNow, completedAt: eventNow };
        const latest = stateRef.current;
        const fact = `在${activeScene.locationName}，${playerName}${userAction.trim() ? "行动：“" + userAction.trim().slice(0, 120) + "”" : ""}${userText.trim() ? "说：“" + userText.trim().slice(0, 120) + "”" : ""}；${target.name}${parsed.action?.trim() ? "行动：“" + parsed.action.trim().slice(0, 120) + "”" : ""}${parsed.dialogue.trim() ? "说：“" + parsed.dialogue.trim().slice(0, 120) + "”" : ""}。`;
        commit({ ...latest, events: [event, ...latest.events], memories: [{ id: id("memory"), eventId, occurredAt: eventNow, participants: ["player", target.id], fact }, ...latest.memories].slice(0, 500) });
      }
    } catch (error) {
      setNotice(error instanceof Error ? `角色生成失败：${error.message}` : "角色生成失败，请检查聊天模型配置。");
    } finally { setBusy(false); }
  };

  const addLocation = () => {
    const name = newLocationName.trim();
    if (!name) return;
    const location: LifeLocation = { id: id("place"), name, description: "", visibility: "public" };
    commit({ ...state, locations: [...state.locations, location] });
    setSelectedLocationId(location.id);
    setNewLocationName("");
  };

  const addInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteCharacterId || !inviteAt || !inviteActivity.trim() || busy) return;
    const character = characters.find(item => item.id === inviteCharacterId);
    const location = stateRef.current.locations.find(item => item.id === inviteLocationId);
    if (!character) return;
    const proposedAt = new Date(inviteAt);
    const base = stateRef.current;
    const playerNow = resolveActorLifeNow(getActorClock(base, "player", PLAYER_ID));
    const characterNow = resolveActorLifeNow(getActorClock(base, "character", character.id));
    if (!Number.isFinite(proposedAt.getTime()) || proposedAt <= playerNow || proposedAt <= characterNow) {
      setNotice("邀约时间必须晚于你和角色各自的当前时间。");
      return;
    }
    const contacts = loadChatContacts();
    const sessions = loadChatSessions();
    const contact = contacts.find(item => item.characterId === character.id);
    const session = sessions.find(item => item.contactId === contact?.id && !item.isGroup);
    if (!session) {
      setNotice(`找不到「${character.name}」的线上私聊会话。请先在消息 APP 与 TA 建立私聊，再发出邀约。`);
      return;
    }
    const next = makeLifeInvitation(base, {
      proposedBy: "player",
      characterId: character.id, playerId: PLAYER_ID, proposedAt: proposedAt.toISOString(),
      locationId: location?.id, locationName: location?.name, activity: inviteActivity.trim(),
      kind: "appointment", durationMinutes: 60,
    });
    const invitation = next.invitations[0];
    commit(next);
    setBusy(true);
    setNotice(`已向${character.name}发出邀约，正在根据 TA 的人设和当前日程等待回应……`);
    try {
      const previous = loadChatMessages(session.id, 12).filter(message => message.status !== "failed" && !message.isRetracted);
      const prompt: ChatMessage = {
        id: id("life-invitation-response"), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
        content: [
          "【生活 APP 邀约确认】",
          `玩家向你发出邀约：${inviteActivity.trim()}`,
          `时间：${proposedAt.toLocaleString("zh-CN")}`,
          `地点：${location?.name ?? "地点待定"}`,
          "请根据你的人设、当前日程、关系和真实意愿，自主决定接受或拒绝。不要让玩家替你确认；不要为了讨好玩家而默认接受。",
          "只输出一个机器可读标签，并可在 reason 中写一句简短自然的理由：<life_invitation_response decision=\"accept|decline\" reason=\"理由\" />。没有明确接受就视为拒绝；不要改动日程，系统会在接受后处理冲突和排期。",
        ].join("\n"),
      };
      const result = await generateOfflineChatCompletion(session, [...previous, prompt]);
      const tag = result.content.match(/<life_invitation_response\b([^>]*)\/?\s*>/i);
      const attribute = (source: string, name: string) => source.match(new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"))?.[1]?.trim() ?? "";
      const decision = attribute(tag?.[1] ?? "", "decision").toLowerCase();
      const reason = attribute(tag?.[1] ?? "", "reason").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").slice(0, 240);
      const current = stateRef.current;
      if (decision === "accept") {
        const resolution = resolveInvitationConfirmation(current, invitation.id);
        if (resolution.ok) {
          const confirmedState = { ...resolution.state, invitations: resolution.state.invitations.map(item => item.id === invitation.id ? { ...item, responseReason: reason || "角色接受了邀约。" } : item) };
          commit(confirmedState);
          setNotice(`${character.name}答应了这次邀约。${reason ? " TA 的回应：" + reason : ""}`);
        } else {
          commit({ ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: resolution.notice, updatedAt: new Date().toISOString() } : item) });
          setNotice(`${character.name}愿意赴约，但排期未能成立：${resolution.notice}`);
        }
      } else {
        const declineReason = reason || (decision === "decline" ? "角色决定这次不赴约。" : "角色没有明确答应这次邀约，因此没有替 TA 自动确认。");
        commit({ ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: declineReason, updatedAt: new Date().toISOString() } : item) });
        setNotice(`${character.name}没有接受这次邀约。${declineReason}`);
      }
    } catch (error) {
      const current = stateRef.current;
      commit({ ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: "暂时无法取得角色回应，请稍后重新发起邀约。", updatedAt: new Date().toISOString() } : item) });
      setNotice(error instanceof Error ? `邀约已发出，但角色回应失败：${error.message}` : "邀约已发出，但角色回应失败。");
    } finally {
      setBusy(false);
    }
  };

  const resolveInvitationConfirmation = (base: VirtualLifeState, inviteId: string): { ok: boolean; state: VirtualLifeState; notice: string } => {
    const invite = base.invitations.find(item => item.id === inviteId && item.status === "proposed");
    if (!invite) return { ok: false, state: base, notice: "找不到仍待确认的邀约。" };
    const startsAt = new Date(invite.proposedAt);
    const durationMinutes = Math.max(15, Math.min(invite.durationMinutes ?? 60, 24 * 60));
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const playerNow = resolveActorLifeNow(getActorClock(base, "player", PLAYER_ID));
    const characterNow = resolveActorLifeNow(getActorClock(base, "character", invite.characterId));
    if (!Number.isFinite(startsAt.getTime()) || startsAt <= playerNow || startsAt <= characterNow) {
      return { ok: false, state: base, notice: "这个时间对你或角色来说已经过去了。请修改时间；不会为了赴约自动跳过时间。" };
    }
    const relevantOwners = invite.kind === "follow-request" ? new Set([invite.characterId]) : new Set([PLAYER_ID, invite.characterId]);
    const conflict = base.schedules.find(slot => relevantOwners.has(slot.ownerId) && (slot.ownerType === "player" || slot.ownerType === "character") && slot.kind === "appointment" && new Date(slot.startAt) < endsAt && new Date(slot.endAt) > startsAt);
    if (conflict) return { ok: false, state: base, notice: "这个时段已经有另一项已确认的约定。请先调整时间，避免两件事情同时发生。" };
    let next = confirmLifeInvitation(base, inviteId);
    const confirmed = next.invitations.find(item => item.id === inviteId);
    if (!confirmed?.eventId) return { ok: false, state: next, notice: "邀约状态更新失败，没有建立日程。" };
    const makeSlot = (ownerType: LifeOwnerType, ownerId: string): LifeScheduleSlot => ({
      id: "invite-slot-" + confirmed.eventId + "-" + ownerType + "-" + ownerId,
      ownerType, ownerId, startAt: startsAt.toISOString(), endAt: endsAt.toISOString(),
      title: confirmed.kind === "follow-request" ? "陪伴玩家并跟随其行程" : confirmed.activity,
      kind: "appointment", source: "event",
      plannedLocationId: confirmed.kind === "follow-request" ? null : confirmed.locationId,
      plannedLocationName: confirmed.kind === "follow-request" ? "跟随玩家的实际地点" : confirmed.locationName,
      updatedAt: new Date().toISOString(),
    });
    if (confirmed.kind === "follow-request") {
      next = placeAppointmentInActorSchedule(next, makeSlot("character", confirmed.characterId));
    } else {
      next = placeAppointmentInActorSchedule(next, makeSlot("player", PLAYER_ID));
      next = placeAppointmentInActorSchedule(next, makeSlot("character", confirmed.characterId));
    }
    return { ok: true, state: next, notice: confirmed.kind === "follow-request"
      ? "陪伴申请已接受。约定时间开始后，TA会跟随你的实际地点；你仍可随时取消。"
      : "邀约已确认，双方的冲突时段已保留前后部分并插入约定；只有两个人的虚拟时间都到达后，活动才会开始。" };
  };

  const confirmInvitation = (inviteId: string) => {
    const result = resolveInvitationConfirmation(stateRef.current, inviteId);
    if (!result.ok) { setNotice(result.notice); return; }
    commit(result.state);
    setNotice(result.notice);
  };

  const addManualPlanTitle = (slot: LifeScheduleSlot, title: string) => {
    commit({ ...state, schedules: state.schedules.map(item => item.id === slot.id ? { ...item, title, source: "manual", updatedAt: new Date().toISOString() } : item) });
  };

  const themeClass = settings.sceneTheme === "night-sky" ? "from-slate-950 via-slate-900 to-indigo-950 text-slate-100" : settings.sceneTheme === "sage" ? "from-[#eaf0e8] via-[#f3f4eb] to-[#dce8dc] text-stone-800" : settings.sceneTheme === "rose" ? "from-[#fff0f1] via-[#fff8f6] to-[#f7e3e5] text-stone-800" : "from-[#fbf4e9] via-[#f7efe4] to-[#ead9c6] text-stone-800";
  const cssVars = { "--life-accent": settings.accentColor, "--life-opacity": settings.panelOpacity / 100, "--life-font": `${settings.dialogueFontSize}px`, "--life-narration-font": `${settings.narrationFontSize}px` } as CSSProperties;
  const playerActor = actors[0];
  const playerNow = actorNow(playerActor);
  const playerDayStart = new Date(playerNow); playerDayStart.setHours(0,0,0,0);
  const playerDayEnd = new Date(playerDayStart.getTime() + 24 * 60 * 60 * 1000);
  const playerTodaySlots = state.schedules.filter(slot => slot.ownerType === "player" && slot.ownerId === PLAYER_ID && new Date(slot.startAt).getTime() < playerDayEnd.getTime() && new Date(slot.endAt).getTime() > playerDayStart.getTime()).sort((a,b)=>a.startAt.localeCompare(b.startAt));
  const playerPastSlots = playerTodaySlots.filter(slot => new Date(slot.endAt).getTime() <= playerNow.getTime());
  const playerCurrentSlot = playerTodaySlots.find(slot => new Date(slot.startAt).getTime() <= playerNow.getTime() && new Date(slot.endAt).getTime() > playerNow.getTime());
  const playerFutureSlots = playerTodaySlots.filter(slot => new Date(slot.startAt).getTime() > playerNow.getTime());
  const playerPresence = actorState(playerActor);
  const nearbyCharacters = characters.map(character => ({ character, presence: state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === character.id) })).filter(item => !!playerPresence?.actualLocationId && item.presence?.actualLocationId === playerPresence.actualLocationId);


  if (!ready) return <main className="flex min-h-screen items-center justify-center bg-[#f7efe4] text-stone-500">正在打开生活档案…</main>;

  return <main style={cssVars} className={`h-screen h-[100dvh] overflow-y-auto overscroll-y-contain touch-pan-y bg-gradient-to-br ${themeClass} ${settings.compactLayout ? "px-2 py-2 sm:px-3 sm:py-3" : "px-3 py-4 sm:px-6 sm:py-8"}`}>
    <div className="mx-auto max-w-6xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/75 text-[var(--life-accent)] shadow-sm"><Heart size={22}/></div><div><p className="text-[10px] font-semibold uppercase tracking-[0.26em] opacity-60">LIFE SIMULATOR · PERSONAL WORLD</p><h1 className="text-2xl font-semibold tracking-tight">虚拟生活引擎</h1><p className="mt-0.5 text-xs opacity-65">各自生活 · 独立时间 · 自然相遇 · 持续记忆</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><button onClick={()=>tab==="home"?closeApp():setTab("home")} aria-label="返回生活现场" className="inline-flex items-center gap-1 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-sm"><ArrowLeft size={15}/><span>返回</span></button><button onClick={closeApp} aria-label="退出生活 APP" className="inline-flex items-center gap-1 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-sm"><X size={15}/><span>退出</span></button><span className="rounded-full border border-white/70 bg-white/60 px-3 py-1.5 text-xs">{actors.length} 位生活参与者</span><button onClick={ensurePlans} className="inline-flex items-center gap-2 rounded-full bg-[var(--life-accent)] px-4 py-2 text-sm font-medium text-white shadow-sm"><CalendarDays size={15}/>生成本周日程</button></div>
      </header>
      {notice && <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-[var(--life-accent)]/20 bg-white/75 px-4 py-3 text-sm text-stone-700"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
      <nav className="mb-5 grid grid-cols-3 gap-1 rounded-2xl border border-white/80 bg-white/55 p-1 shadow-sm">
        {([{id:"home",label:"生活现场",icon:Heart},{id:"invitations",label:"邀约活动",icon:Coffee},{id:"settings",label:"自定义",icon:Settings2}] as const).filter(item => item.id !== "invitations" || settings.enableInvitations).map(item => { const Icon=item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`flex flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[11px] transition sm:flex-row sm:text-sm ${tab===item.id?"bg-white text-[var(--life-accent)] shadow-sm":"opacity-65 hover:opacity-100"}`}><Icon size={16}/>{item.label}</button>; })}
      </nav>

      {(tab === "home" || tab === "scene") && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle eyebrow="Live scene" title={activeScene ? activeScene.locationName : "还没有正在进行的场景"} note={activeScene ? `场景始于 ${fmt(activeScene.startedAt)} · ${activeScene.participants.length} 位参与者 · 已保存，可随时回来继续` : "先从生活总览中选择地点和参与角色，创建一个持续场景。"} />{activeScene && <button onClick={()=>commit({...state,scenes:state.scenes.map(scene=>scene.id===activeScene.id?{...scene,status:"paused" as const,updatedAt:new Date().toISOString()}:scene)})} className="inline-flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs"><Pause size={14}/>暂时离开</button>}</div>
        <div className="mb-4 rounded-2xl border border-stone-200/80 bg-white/75 p-3 sm:p-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="block text-sm font-medium">当前地点
              <select value={selectedLocationId} onChange={e=>setSelectedLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name} · {loc.visibility==="public"?"公共":"私人"}</option>)}</select>
            </label>
            <div className="flex items-end gap-2"><button type="button" onClick={enterLocationSolo} disabled={!settings.enabled} className="flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm disabled:opacity-40">前往地点</button><button type="button" onClick={createScene} disabled={!characters.length||!settings.enabled} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm text-white disabled:opacity-40">进入互动</button></div>
          </div>
          <div className="mt-2 flex gap-2"><input value={newLocationName} onChange={e=>setNewLocationName(e.target.value)} placeholder="添加一个新地点…" className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/><button type="button" onClick={addLocation} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">添加地点</button></div>
          <label className="mt-3 block text-sm font-medium text-stone-700">你现在的行动（可选）<input value={playerActivity} onChange={e=>setPlayerActivity(e.target.value)} placeholder="例如：坐在窗边看书、慢慢散步……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <div className="mt-3"><p className="mb-2 text-xs font-medium text-stone-600">选择一起互动的角色</p><div className="flex flex-wrap gap-2">{characters.map(char=><label key={char.id} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs"><input type="checkbox" checked={selectedCharacterIds.includes(char.id)} onChange={e=>setSelectedCharacterIds(old=>e.target.checked?[...new Set([...old,char.id])]:old.filter(id=>id!==char.id))}/>{char.name}</label>)}</div></div>
          {!characters.length&&<p className="mt-2 text-xs text-stone-500">还没有角色档案；先在小手机里创建角色，之后就能在这里互动。</p>}
        </div>
        {activeScene && <>
          <div className="mb-4 flex flex-wrap gap-2">{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerId===p.ownerId&&a.ownerType===p.ownerType);const awareness=p.awarenessByActorId.player;const status=awareness==="unaware"?"还没注意到你":awareness==="suspects"?"似乎察觉到你":awareness==="aware"?"注意到你":"";return <button key={p.ownerId} onClick={()=>p.ownerType==="character"&&setSelectedSpeakerId(p.ownerId)} className={`rounded-full px-3 py-1.5 text-xs ${selectedSpeakerId===p.ownerId?"bg-[var(--life-accent)] text-white":"bg-[#f1e5d8] text-stone-700"}`}>{actor?.name??p.ownerId} · {status || p.activity}</button>})}</div>
          <div className="mb-4 max-h-[48vh] min-h-48 space-y-3 overflow-y-auto rounded-2xl bg-white/65 p-3 sm:p-5" style={{fontSize:"var(--life-font)"}}>
            {sceneMessages.length===0 && <div className="grid min-h-36 place-items-center text-center text-sm text-stone-400"><div><Sparkles className="mx-auto mb-2" size={22}/><p>场景已经准备好了。</p><p className="mt-1 text-xs">角色可以忙自己的事，也可以回应你；不会自动写成长篇剧情。</p></div></div>}
            {sceneMessages.map(message=><div key={message.id} className={`flex ${message.role==="player"?"justify-end":"justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"} ${message.role==="player"?"bg-[#e9d4c0] text-stone-800":"bg-white text-stone-800 shadow-sm"}`}>{message.role!=="player"&&<p className="mb-1 text-[11px] font-semibold text-[var(--life-accent)]">{message.speakerName}</p>}{message.action&&<p className="mb-1.5 italic text-stone-500" style={{fontSize:"var(--life-narration-font)"}}>*{message.action}*</p>}{message.dialogue&&<p className="whitespace-pre-wrap leading-relaxed">{message.dialogue}</p>}<p className="mt-1 text-right text-[10px] opacity-45">{new Date(message.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</p></div></div>)}
            {busy&&<div className="text-xs text-stone-400">角色正在回应……</div>}
          </div>
          <section className="mb-3 rounded-2xl border border-stone-200/80 bg-white/60 p-2.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-stone-500">场景相册 · {sceneImageRecords.filter(image=>image.status==="active").length} 张</p>
              <button type="button" disabled={sceneImageBusy} onClick={()=>void generateSceneImages({count:settings.sceneImageCount,participantIds:imageParticipantIds.length?imageParticipantIds:activeScene.participants.filter(p=>p.ownerType==="character").map(p=>p.ownerId),prompt:sceneImagePrompt})} className="inline-flex items-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50"><Sparkles size={14}/>{sceneImageBusy?"正在生成…":"生成场景"}</button>
            </div>
            {sceneImageRecords.filter(image=>image.status==="active").length>0&&<div className="mt-2 flex gap-2 overflow-x-auto pb-1">{sceneImageRecords.filter(image=>image.status==="active").map((image,index)=><button type="button" key={image.id} onClick={()=>setImageViewerIndex(index)} aria-label={`查看第 ${index+1} 张场景图`} className={`shrink-0 overflow-hidden rounded-xl border ${index===imageViewerIndex?"border-[var(--life-accent)]":"border-stone-200"}`}>{imageObjectUrls[image.id]?<img src={imageObjectUrls[image.id]} alt={image.alt||"场景图"} className="h-16 w-16 object-cover"/>:<span className="grid h-16 w-16 place-items-center text-[10px] text-stone-400">加载中</span>}</button>)}</div>}
          </section>
          <form onSubmit={sendSceneTurn} className="space-y-2 rounded-2xl border border-stone-200/80 bg-white/80 p-3">
            <label className="block text-xs font-medium text-stone-600">行动 / 旁白（可单独发送）<textarea value={sceneActionInput} onChange={e=>setSceneActionInput(e.target.value)} placeholder="例如：走到她身边，轻轻碰了碰她的手。" rows={2} className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm" disabled={busy}/></label>
            <label className="block text-xs font-medium text-stone-600">说话 / 对话气泡（可留空）<textarea value={sceneInput} onChange={e=>setSceneInput(e.target.value)} placeholder="想对角色说的话……" rows={2} className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm" disabled={busy}/></label>
            <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-stone-500">可以只行动、只说话，也可以两者一起。</span><button disabled={busy||(!sceneInput.trim()&&!sceneActionInput.trim())} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm text-white disabled:opacity-40"><Send size={15}/>{busy?"角色正在回应…":"执行"}</button></div>
          </form>
          <p className="mt-2 text-xs text-stone-500">生成使用角色现有私聊会话和模型配置；本轮场景指令只临时注入，不会把场景规则写进原线上聊天记录。</p>
        </>}
      </section>}

      {tab === "home" && <div className="space-y-4">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle eyebrow="Your day · 24 hours" title={playerNow.toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long"})+" · 我的时间线"} note="已过去的时段可以折叠查看；快进会逐段结算日程，不会直接抹掉中间发生的生活。" />
            <button onClick={()=>setTab("plans")} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">查看完整七日日程</button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-2xl bg-white/75 p-3"><p className="text-[11px] text-stone-500">现在</p><p className="mt-1 text-lg font-semibold">{playerNow.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</p><p className="mt-1 text-xs text-stone-600">{playerPresence?.activity ?? playerCurrentSlot?.title ?? "时间线待补全"}</p></div>
            <div className="rounded-2xl bg-white/75 p-3"><p className="text-[11px] text-stone-500">实际地点</p><p className="mt-1 font-semibold">{playerPresence?.actualLocationName ?? "尚未记录"}</p><p className="mt-1 text-xs text-stone-500">计划：{settings.showLocationHints ? playerCurrentSlot?.plannedLocationName ?? "暂无提示" : "地点线索已隐藏"}</p></div>
            <div className="rounded-2xl bg-white/75 p-3"><p className="text-[11px] text-stone-500">当前场景</p><p className="mt-1 font-semibold">{activeScene?.locationName ?? "尚未进入场景"}</p><p className="mt-1 text-xs text-stone-500">{activeScene ? (activeScene.status==="active"?"正在进行":"已暂停，可继续") : "可以从下方选择地点进入"}</p></div>
          </div>
          {settings.showTimeline && <div className="mt-4">
            {playerPastSlots.length>0 && <details className="mb-3 rounded-2xl border border-stone-200/70 bg-white/55 p-3"><summary className="cursor-pointer text-sm font-medium text-stone-600">展开已度过的时段（{playerPastSlots.length}）</summary><div className="mt-3 space-y-2">{playerPastSlots.map(slot=><div key={slot.id} className="flex gap-3 rounded-xl bg-stone-50/80 p-2.5 text-xs"><span className="w-24 shrink-0 text-stone-400">{new Date(slot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><span className="min-w-0 flex-1">{slot.title}</span><span className="text-stone-400">{slot.plannedLocationName??"地点未定"}</span></div>)}</div></details>}
            <div className="space-y-2">
              {playerCurrentSlot && <div className="flex gap-3 rounded-2xl border border-[var(--life-accent)]/40 bg-white p-3 shadow-sm"><span className="w-24 shrink-0 text-xs font-semibold text-[var(--life-accent)]">{new Date(playerCurrentSlot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(playerCurrentSlot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="font-medium">{playerCurrentSlot.title}</p><p className="mt-1 text-xs text-stone-500">实际状态：{playerPresence?.activity??playerCurrentSlot.title} · {playerPresence?.actualLocationName??playerCurrentSlot.plannedLocationName??"地点未记录"}</p></div><span className="self-start rounded-full bg-[var(--life-accent)]/10 px-2 py-1 text-[10px] text-[var(--life-accent)]">正在进行</span></div>}
              {playerFutureSlots.slice(0,5).map(slot=><div key={slot.id} className="flex gap-3 rounded-xl bg-white/60 p-3 text-xs"><span className="w-24 shrink-0 text-stone-400">{new Date(slot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><span className="min-w-0 flex-1 font-medium">{slot.title}</span><span className="text-stone-400">{slot.plannedLocationName??"地点未定"}</span></div>)}
              {!playerCurrentSlot && playerTodaySlots.length===0 && <div className="rounded-xl bg-white/65 p-3 text-sm text-stone-500">今天的时间线还没生成。你可以开启自动日程，或到七日日程页补全。</div>}
            </div>
          </div>}
          <div className="mt-3"><p className="mb-2 text-sm font-medium">此刻和你在同一地点的角色</p>{nearbyCharacters.length ? <div className="flex flex-wrap gap-2">{nearbyCharacters.map(({character,presence})=><button key={character.id} onClick={()=>{setSelectedSpeakerId(character.id);setSelectedActorKey("character:"+character.id);setTab("home");}} className="flex items-center gap-2 rounded-xl bg-white/80 px-3 py-2 text-xs"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#efe1d2]">{character.name.slice(0,1)}</span><span className="text-left"><span className="block font-medium">{character.name}</span><span className="block text-stone-500">{presence?.activity??"正在自己的生活里"}</span></span></button>)}</div> : <p className="rounded-xl bg-white/55 p-3 text-xs text-stone-500">目前没有记录到和你同地点的角色。计划地点只是线索；你也可以前往其他地点看看会不会遇见谁。</p>}</div>
        </section>
        <div className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
          <SectionTitle eyebrow="Independent timelines" title="每个人都有自己的时间" note="调整某个人的流速，不会改变其他人的时钟。模拟时间不会在退出时偷偷跳回现实。" />
          <div className="space-y-3">{actors.map(actor => { const clock=getActorClock(state,actor.ownerType,actor.ownerId), now=actorNow(actor), current=actorSchedule(actor), actual=actorState(actor); return <div key={`${actor.ownerType}:${actor.ownerId}`} className={`rounded-2xl border p-3 transition ${selectedActorKey===`${actor.ownerType}:${actor.ownerId}`?"border-[var(--life-accent)]/45 bg-white":"border-stone-200/70 bg-white/55"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2"><button onClick={()=>setSelectedActorKey(`${actor.ownerType}:${actor.ownerId}`)} className="flex min-w-0 items-center gap-3 text-left">{actor.avatar ? <img src={actor.avatar} alt="" className="h-10 w-10 rounded-full object-cover"/> : <span className="grid h-10 w-10 place-items-center rounded-full bg-[#efe1d2] text-sm">{actor.ownerType==="player"?"我":actor.name.slice(0,1)}</span>}<span><span className="block font-medium">{actor.name}</span><span className="block text-xs opacity-60">{actorClockLabel(clock)} · {fmt(now)}</span></span></button><span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] text-stone-600">{current?.title ?? "当前没有日程"}</span></div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center"><label className="text-xs text-stone-500">时间流速：×{clock.speed}<input type="range" min="0.1" max="100" step="0.1" value={clock.speed} onChange={e=>patchActorClock(actor,{speed:Number(e.target.value),mode:clock.mode==="real-time"?"simulation":clock.mode})} className="mt-2 w-full accent-[var(--life-accent)]"/></label><div className="flex flex-wrap gap-1.5"><select aria-label={`${actor.name}的时间模式`} value={clock.mode} onChange={e=>patchActorClock(actor,{mode:e.target.value as LifeActorClock["mode"]})} className="rounded-xl border border-stone-200 bg-white px-2 py-2 text-xs"><option value="real-time">跟随现实</option><option value="simulation">独立模拟</option><option value="review">暂停回顾</option></select><button onClick={()=>commit(advanceActorTimeline(state,actor.ownerType,actor.ownerId,60,actor.name,actor.persona??""))} className="rounded-xl bg-[#f0e3d5] px-3 py-2 text-xs text-stone-700">+1 虚拟小时</button>{actor.ownerType==="character" && <button disabled={!settings.enableCharacterAutonomy} onClick={()=>advanceCharacterAutonomy(actor)} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-700 disabled:opacity-40">自主生活 +1h</button>}</div></div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500"><MapPin size={13}/><span>实际地点：{actor.ownerType==="player" || settings.revealExactLocations==="open" ? (actual?.actualLocationName ?? "未记录") : settings.revealExactLocations==="ask-only" ? "精确位置未公开" : actual?.actualLocationName ? "有位置线索" : "未记录"}</span><span className="opacity-40">·</span><span>计划地点：{settings.showLocationHints ? (current?.plannedLocationName ? `${current.plannedLocationName}（不保证在场）` : "暂无提示") : "地点线索已隐藏"}</span></div>
          </div>; })}</div>
          <p className="mt-4 text-xs leading-relaxed text-stone-500">提示：倍速只影响该角色的虚拟时钟；计划地点不等于实时定位。真实位置仍需要场景状态或合理的信息来源。</p>
        </section>
      </div></div>}

      {tab === "plans" && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle eyebrow="Weekly plans" title="未来七天的生活日程" note="计划每周生成一次并保存在本地；已有日程不会被重复生成覆盖。点击标题可编辑，计划地点只作为线索。" /><button onClick={ensurePlans} className="inline-flex items-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white"><RefreshCw size={14}/>检查并补全</button></div>
        {actors.map(actor=>{const slots=state.schedules.filter(slot=>slot.ownerType===actor.ownerType&&slot.ownerId===actor.ownerId).sort((a,b)=>a.startAt.localeCompare(b.startAt));return <div key={`${actor.ownerType}:${actor.ownerId}`} className="mb-5"><h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-[var(--life-accent)]"/>{actor.name}<span className="text-xs font-normal text-stone-400">{slots.length} 条安排</span></h3>{slots.length===0?<p className="rounded-xl bg-white/60 p-3 text-sm text-stone-400">还没有日程，点击「生成本周日程」。</p>:<div className="space-y-2">{slots.filter(slot=>new Date(slot.endAt).getTime()>Date.now()-DAY_MS).slice(0,24).map(slot=><div key={slot.id} className="grid grid-cols-[90px_1fr] items-center gap-3 rounded-xl border border-stone-200/70 bg-white/65 p-3 sm:grid-cols-[130px_1fr_auto]"><span className="text-xs text-stone-500">{fmt(slot.startAt)}</span><input aria-label="编辑日程标题" value={slot.title} onChange={e=>addManualPlanTitle(slot,e.target.value)} className="min-w-0 rounded-lg bg-transparent px-1 py-1 text-sm focus:bg-white focus:outline-none"/><span className="col-span-2 text-[11px] text-stone-400 sm:col-span-1">{slot.plannedLocationName??"地点未指定"} · {slot.kind}</span></div>)}</div>}</div>;})}
      </section>}

      {tab === "invitations" && <div className="grid gap-4 lg:grid-cols-[.85fr_1.15fr]">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Make a plan together" title="创建邀约" note="邀约先处于待确认状态。确认后才同步双方日程；不会瞬间跳到约定时间。" />
          <form onSubmit={addInvitation} className="space-y-3"><label className="block text-sm">邀请谁<select value={inviteCharacterId} onChange={e=>setInviteCharacterId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="">选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="block text-sm">活动<input value={inviteActivity} onChange={e=>setInviteActivity(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">时间<input type="datetime-local" value={inviteAt} onChange={e=>setInviteAt(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">地点<select value={inviteLocationId} onChange={e=>setInviteLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label><button className="w-full rounded-2xl bg-[var(--life-accent)] px-4 py-3 text-sm font-medium text-white">发出邀约</button></form>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Invitation inbox" title="邀约记录" />
          {state.invitations.length===0?<p className="rounded-2xl bg-white/60 p-4 text-sm text-stone-400">这里会保存待确认、已确认和已取消的邀约。</p>:<div className="space-y-3">{state.invitations.map(invite=>{const char=characters.find(c=>c.id===invite.characterId);return <div key={invite.id} className="rounded-2xl border border-stone-200/70 bg-white/70 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{char?.name??"未知角色"} · {invite.kind==="follow-request"?"陪伴申请":"邀约"} · {invite.activity}</p><p className="mt-1 text-xs text-stone-500">{fmt(invite.proposedAt)} · {invite.kind==="follow-request"?(invite.durationMinutes??120)+" 分钟 · 跟随你的实际行程":invite.locationName??"地点待定"}</p>{invite.responseReason&&<p className="mt-1 text-xs leading-relaxed text-stone-600">{invite.responseReason}</p>}</div><span className="rounded-full bg-[#f0e3d5] px-2.5 py-1 text-[11px]">{(invite.status==="proposed"&&invite.proposedBy==="player"?"等待角色回应":({proposed:"待确认",confirmed:"已确认",declined:"已拒绝",cancelled:"已取消",completed:"已完成"} as Record<string,string>)[invite.status])}</span></div>{invite.status==="proposed"&&invite.proposedBy!=="player"&&<div className="mt-3 flex gap-2"><button onClick={()=>confirmInvitation(invite.id)} className="rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">{invite.kind==="follow-request"?"接受陪伴申请":"确认并同步日程"}</button><button onClick={()=>commit({...state,invitations:state.invitations.map(item=>item.id===invite.id?{...item,status:"declined" as const,updatedAt:new Date().toISOString()}:item)})} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">拒绝</button></div>}</div>;})}</div>}
        </section>
      </div>}

      {tab === "settings" && <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Behavior switches" title="生活模拟规则" note="你可以把它调成轻量陪伴，也可以打开更多自主生活细节。" />
          <div className="space-y-2">
            <Toggle checked={settings.enabled} onChange={v=>patchSettings({enabled:v})} label="启用虚拟生活引擎" hint="关闭后保留数据，但暂停新生活场景功能。"/>
            <Toggle checked={settings.autoGenerateWeeklyPlans} onChange={v=>patchSettings({autoGenerateWeeklyPlans:v})} label="自动生成每周日程"/>
            <Toggle checked={settings.generateSpecialEvents} onChange={v=>patchSettings({generateSpecialEvents:v})} label="允许偶发特殊事件"/>
            <Toggle checked={settings.enableCoincidences} onChange={v=>patchSettings({enableCoincidences:v})} label="启用偶遇与注意力判断" hint="关闭后场景仍可互动，但不做随机偶遇判断。"/>
            <Toggle checked={settings.enableCharacterAutonomy} onChange={v=>patchSettings({enableCharacterAutonomy:v})} label="允许角色自主行动"/>
            <div className="ml-3 space-y-2 border-l-2 border-[#e7d4c1] pl-3"><Toggle checked={settings.enableScheduleChangeTool} onChange={v=>patchSettings({enableScheduleChangeTool:v})} label="允许角色自主调整日程" hint="只允许改当前虚拟日的未来时段，不会覆盖确认约会。"/><Toggle checked={settings.enableInvitations} onChange={v=>patchSettings({enableInvitations:v})} label="允许角色主动发出邀约"/><Toggle checked={settings.enableFollowRequestTool} onChange={v=>patchSettings({enableFollowRequestTool:v})} label="允许角色申请陪伴并跟随你"/></div>

            <Toggle checked={settings.saveConfirmedEventsToMemory} onChange={v=>patchSettings({saveConfirmedEventsToMemory:v})} label="将已发生的事件写入生活记忆"/>
            <Toggle checked={settings.showActionNarration} onChange={v=>patchSettings({showActionNarration:v})} label="显示简短动作旁白"/>
            <Toggle checked={settings.keepDialogueConcise} onChange={v=>patchSettings({keepDialogueConcise:v})} label="默认保持短回合对话"/>
            <Toggle checked={settings.allowCharactersToStaySilent} onChange={v=>patchSettings({allowCharactersToStaySilent:v})} label="允许角色沉默或专注做自己的事"/>
            <Toggle checked={settings.showTimeline} onChange={v=>patchSettings({showTimeline:v})} label="显示日程时间线"/>
            <Toggle checked={settings.showLocationHints} onChange={v=>patchSettings({showLocationHints:v})} label="显示计划地点线索"/>
            <Toggle checked={settings.enableAmbientDetails} onChange={v=>patchSettings({enableAmbientDetails:v})} label="启用环境细节"/>
          </div>
          <label className="mt-4 block text-sm">位置情报权限<select value={settings.revealExactLocations} onChange={e=>patchSettings({revealExactLocations:e.target.value as LifeEngineSettings["revealExactLocations"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="ask-only">只有询问或可靠渠道才能得知精确位置</option><option value="clues">默认只显示习惯与模糊线索</option><option value="open">允许公开查看实际位置</option></select></label>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Appearance & comfort" title="界面自定义" note="外观设置独立保存，不会影响角色数据或原有聊天主题。" />
          <label className="mb-4 block text-sm">玩家显示名称<input value={playerName} onChange={e=>patchSettings({playerDisplayName:e.target.value})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="mb-4 block text-sm">场景主题<select value={settings.sceneTheme} onChange={e=>patchSettings({sceneTheme:e.target.value as LifeEngineSettings["sceneTheme"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="warm-paper">暖米棕纸感</option><option value="sage">鼠尾草绿</option><option value="rose">柔和玫瑰</option><option value="night-sky">夜空深色</option></select></label>
          <label className="mb-4 flex items-center justify-between gap-3 text-sm">强调色<input type="color" value={settings.accentColor} onChange={e=>patchSettings({accentColor:e.target.value})} className="h-10 w-16 rounded-lg border-0 bg-transparent"/></label>
          <label className="mb-4 block text-sm">面板不透明度：{settings.panelOpacity}%<input type="range" min="50" max="100" value={settings.panelOpacity} onChange={e=>patchSettings({panelOpacity:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">对白字号：{settings.dialogueFontSize}px<input type="range" min="12" max="24" value={settings.dialogueFontSize} onChange={e=>patchSettings({dialogueFontSize:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">动作旁白字号：{settings.narrationFontSize}px<input type="range" min="10" max="20" value={settings.narrationFontSize} onChange={e=>patchSettings({narrationFontSize:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">对白气泡<select value={settings.dialogueBubbleStyle} onChange={e=>patchSettings({dialogueBubbleStyle:e.target.value as LifeEngineSettings["dialogueBubbleStyle"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="rounded">圆润气泡</option><option value="soft">柔和大圆角</option><option value="square">简洁方形</option></select></label>
          <Toggle checked={settings.compactLayout} onChange={v=>patchSettings({compactLayout:v})} label="紧凑布局"/>
          <label className="mt-4 block text-sm">默认时间模式<select value={settings.defaultClockMode} onChange={e=>patchSettings({defaultClockMode:e.target.value as LifeEngineSettings["defaultClockMode"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="real-time">跟随现实</option><option value="simulation">独立模拟</option><option value="review">暂停回顾</option></select></label>
          <label className="mt-4 block text-sm">新角色默认流速：×{settings.defaultSpeed}<input type="range" min="0.1" max="100" step="0.1" value={settings.defaultSpeed} onChange={e=>patchSettings({defaultSpeed:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <div className="mt-4 rounded-2xl border border-stone-200/80 bg-white/60 p-4"><p className="text-sm font-semibold">玩家形象设置</p><p className="mt-1 text-xs leading-relaxed text-stone-500">玩家形象描述和参考图统一在「小手机设置 → 生图设置 → 全局玩家形象」管理，整个小手机共用。场景生成时会自动读取该配置；如果所选角色也有参考图，会一起组成参考板。</p></div>
          <div className="mt-4 rounded-2xl border border-stone-200/80 bg-white/60 p-4">
            <p className="text-sm font-semibold">场景生图</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">复用小手机现有生图配置。所选角色和玩家的参考图会合成带标签的参考板，交给支持图生图的引擎；其他角色外观描述也会进入提示词。部分引擎（例如当前 NovelAI 文本生成路径）不支持参考板，会使用文字外观描述。</p>
            <div className="mt-3 space-y-2">
              <Toggle checked={settings.autoGenerateSceneImages} onChange={v=>patchSettings({autoGenerateSceneImages:v})} label="场景变化时自动生成图片" hint="关闭时只在你点生图按钮后生成；新场景、地点或参与者活动发生变化时才自动生成，同一状态不会因重开页面重复扣费。"/>
              <label className="block text-sm">每次生成张数<select value={settings.sceneImageCount} onChange={e=>patchSettings({sceneImageCount:Number(e.target.value) as 1|2|3|4})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value={1}>1 张</option><option value={2}>2 张</option><option value={3}>3 张</option><option value={4}>4 张</option></select></label>
              <label className="block text-sm">场景画风<textarea value={settings.sceneImageStyle} onChange={e=>patchSettings({sceneImageStyle:e.target.value})} rows={2} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
              <label className="block text-sm">场景画面补充描述<textarea value={sceneImagePrompt} onChange={e=>patchSettings({sceneImagePrompt:e.target.value})} rows={2} placeholder="例如：雨天咖啡店窗边，两个人捧着热饮。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
              {activeScene&&<div><p className="mb-1 text-sm">本次画面角色</p><div className="flex flex-wrap gap-2">{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerType===p.ownerType&&a.ownerId===p.ownerId);const checked=imageParticipantIds.length===0?p.ownerType==="character":imageParticipantIds.includes(p.ownerId);return <label key={p.ownerType+":"+p.ownerId} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs"><input type="checkbox" checked={checked} onChange={e=>setImageParticipantIds(prev=>{const current=prev.length?prev:activeScene.participants.filter(item=>item.ownerType==="character").map(item=>item.ownerId);return e.target.checked?[...new Set([...current,p.ownerId])]:current.filter(id=>id!==p.ownerId)})}/>{actor?.name??p.ownerId}</label>;})}</div></div>}
            </div>
          </div>
          <label className="mt-4 block text-sm">自定义场景提示词<textarea value={settings.customPrompt} onChange={e=>patchSettings({customPrompt:e.target.value})} rows={5} placeholder="例如：角色更重视生活习惯；不要每次见面都主动热情打招呼……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <button onClick={()=>patchSettings({ ...DEFAULT_LIFE_ENGINE_SETTINGS })} className="mt-4 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm text-stone-600">恢复默认设置</button>
        </section>
      </div>}
      <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] opacity-55"><span>数据保存在当前设备的 KV 数据库中</span><span>生活时钟按角色独立 · 计划不等于现实 · 场景持续保存</span></footer>
    </div>
  </main>;
}
