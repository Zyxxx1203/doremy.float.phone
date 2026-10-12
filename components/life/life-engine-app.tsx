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
    for (const character of characters) next = generateWeeklyLifePlan(next, "character", character.id, character.name, start, { id: "home", name: "家" });
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
    for (const character of characters) next = generateWeeklyLifePlan(next, "character", character.id, character.name, start, { id: "home", name: "家" });
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
    if (!selectedLocation) { setNotice("请先创建或选择一个地点。"); return; }
    const chosen = characters.filter(char => selectedCharacterIds.includes(char.id));
    if (!chosen.length) { setNotice("至少选择一位角色，才能开始生活场景。"); return; }
    const now = new Date().toISOString();
    const participants: LifeSceneParticipant[] = [
      { ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "正在看看周围", awarenessByActorId: {} },
      ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id, activity: "正在做自己的事", awarenessByActorId: {} })),
    ];
    let next = { ...state, scenes: state.scenes.map(scene => scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    const scene: LifeSceneState = { id: id("scene"), locationId: selectedLocation.id, locationName: selectedLocation.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    for (const actor of [{ ownerType: "player" as const, ownerId: PLAYER_ID }, ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id }))]) {
      next = upsertActorState(next, { ...actor, activity: actor.ownerType === "player" ? playerActivity : "正在做自己的事", actualLocationId: selectedLocation.id, actualLocationName: selectedLocation.name, updatedAt: now });
    }
    commit(next);
    setTab("scene");
    setNotice("场景已建立并保存；之后重新打开会接着当前状态，不会重演。");
  };

  const pushSceneMessage = (message: LifeSceneMessage) => {
    const updatedScene = activeScene ? { ...activeScene, updatedAt: new Date().toISOString() } : null;
    const latest = stateRef.current;
    let next = { ...latest, sceneMessages: [...latest.sceneMessages, message] };
    if (updatedScene) next = upsertLifeScene(next, updatedScene);
    commit(next);
  };

  const sendSceneTurn = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeScene || !sceneInput.trim() || busy) return;
    const userText = sceneInput.trim();
    setSceneInput("");
    const now = new Date().toISOString();
    pushSceneMessage({ id: id("turn"), sceneId: activeScene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: playerName, role: "player", dialogue: userText, createdAt: now });
    const targetId = selectedSpeakerId || activeScene.participants.find(p => p.ownerType === "character")?.ownerId || "";
    const target = characters.find(char => char.id === targetId);
    if (!target) { setNotice("请先选择场景中的一位角色作为回应对象。"); return; }
    const contacts = loadChatContacts();
    const sessions = loadChatSessions();
    const contact = contacts.find(item => item.characterId === target.id);
    const session = sessions.find(item => item.contactId === contact?.id && !item.isGroup);
    if (!session) { setNotice(`找不到「${target.name}」的线上聊天会话。请先在小手机中与TA建立私聊，再回来使用共享角色设定生成场景回应。`); return; }
    setBusy(true);
    try {
      const previous = loadChatMessages(session.id, 12).filter(message => message.status !== "failed" && !message.isRetracted);
      const sceneContext = buildLifeScenePromptContext(state, activeScene);
      const settingsInstructions = [
        LIFE_SCENE_OUTPUT_CONTRACT,
        settings.showActionNarration ? "动作旁白要短，单独一行使用 *动作* 格式；对白只写说出口的话。" : "不要输出动作旁白，只输出角色说出口的话。",
        settings.keepDialogueConcise ? "一轮通常 1-3 句，除非用户明确要求展开。" : "允许适度展开，但仍保持实时互动感。",
        settings.allowCharactersToStaySilent ? "如果角色当下忙碌、没注意到或不想说话，可以自然沉默。" : "本轮需要对玩家的输入作出回应。",
        settings.customPrompt ? `用户自定义规则：${settings.customPrompt}` : "",
      ].filter(Boolean).join("\n");
      const promptMessage: ChatMessage = {
        id: id("life-user"), sessionId: session.id, role: "user", status: "sent", createdAt: now,
        content: `[仅本轮使用生活场景模式规则，不要写入线上聊天历史]\n${settingsInstructions}\n\n${sceneContext}\n\n场景内玩家刚刚说：${userText}\n请让${target.name}按其既有人设自然回应。不要替玩家发言或行动。`,
      };
      const result = await generateOfflineChatCompletion(session, [...previous, promptMessage]);
      const parsed = parseLifeOutput(result.content);
      pushSceneMessage({ id: id("turn"), sceneId: activeScene.id, speakerType: "character", speakerId: target.id, speakerName: target.name, role: "character", action: settings.showActionNarration ? parsed.action : undefined, dialogue: parsed.dialogue, createdAt: new Date().toISOString() });
      if (settings.saveConfirmedEventsToMemory && userText.trim() && parsed.dialogue.trim()) {
        const eventId = id("event"), eventNow = new Date().toISOString();
        const event = { id: eventId, kind: "activity" as const, status: "completed" as const, locationId: activeScene.locationId, locationName: activeScene.locationName, participantIds: ["player", target.id], title: "生活场景对话", details: `${playerName}：${userText}\n${target.name}：${parsed.dialogue}`, createdAt: eventNow, updatedAt: eventNow, completedAt: eventNow };
        commit({ ...state, events: [event, ...state.events], memories: [{ id: id("memory"), eventId, occurredAt: eventNow, participants: ["player", target.id], fact: `在${activeScene.locationName}，${playerName}与${target.name}进行了一次对话。` }, ...state.memories].slice(0, 500) });
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

  const addInvitation = (event: FormEvent) => {
    event.preventDefault();
    if (!inviteCharacterId || !inviteAt || !inviteActivity.trim()) return;
    const character = characters.find(item => item.id === inviteCharacterId);
    const location = state.locations.find(item => item.id === inviteLocationId);
    if (!character) return;
    const next = makeLifeInvitation(state, { characterId: character.id, playerId: PLAYER_ID, proposedAt: new Date(inviteAt).toISOString(), locationId: location?.id, locationName: location?.name, activity: inviteActivity.trim() });
    commit(next);
    setNotice("邀约已记录为待确认；只有确认后才会建立双方日程事件。");
  };

  const confirmInvitation = (inviteId: string) => {
    const next = confirmLifeInvitation(state, inviteId);
    const invite = next.invitations.find(item => item.id === inviteId);
    if (invite?.eventId) {
      const char = characters.find(item => item.id === invite.characterId);
      const playerClock = getActorClock(next, "player", PLAYER_ID);
      const charClock = getActorClock(next, "character", invite.characterId);
      const startsAt = new Date(invite.proposedAt);
      const endAt = new Date(startsAt.getTime() + 60 * 60_000);
      const mkSlot = (ownerType: LifeOwnerType, ownerId: string): LifeScheduleSlot => ({ id: `invite-slot-${invite.eventId}-${ownerType}-${ownerId}`, ownerType, ownerId, startAt: startsAt.toISOString(), endAt: endAt.toISOString(), title: invite.activity, kind: "appointment", source: "event", plannedLocationId: invite.locationId, plannedLocationName: invite.locationName, updatedAt: new Date().toISOString() });
      const withSlots = { ...next, schedules: [...next.schedules, mkSlot("player", PLAYER_ID), mkSlot("character", invite.characterId)] };
      void playerClock; void charClock; void char;
      commit(withSlots);
    } else commit(next);
  };

  const addManualPlanTitle = (slot: LifeScheduleSlot, title: string) => {
    commit({ ...state, schedules: state.schedules.map(item => item.id === slot.id ? { ...item, title, source: "manual", updatedAt: new Date().toISOString() } : item) });
  };

  const themeClass = settings.sceneTheme === "night-sky" ? "from-slate-950 via-slate-900 to-indigo-950 text-slate-100" : settings.sceneTheme === "sage" ? "from-[#eaf0e8] via-[#f3f4eb] to-[#dce8dc] text-stone-800" : settings.sceneTheme === "rose" ? "from-[#fff0f1] via-[#fff8f6] to-[#f7e3e5] text-stone-800" : "from-[#fbf4e9] via-[#f7efe4] to-[#ead9c6] text-stone-800";
  const cssVars = { "--life-accent": settings.accentColor, "--life-opacity": settings.panelOpacity / 100, "--life-font": `${settings.dialogueFontSize}px`, "--life-narration-font": `${settings.narrationFontSize}px` } as CSSProperties;

  if (!ready) return <main className="flex min-h-screen items-center justify-center bg-[#f7efe4] text-stone-500">正在打开生活档案…</main>;

  return <main style={cssVars} className={`min-h-screen bg-gradient-to-br ${themeClass} px-3 py-4 sm:px-6 sm:py-8`}>
    <div className="mx-auto max-w-6xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">{onClose && <button onClick={onClose} aria-label="返回桌面" className="grid h-10 w-10 place-items-center rounded-xl bg-white/70 shadow-sm"><ArrowLeft size={18}/></button>}<div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/75 text-[var(--life-accent)] shadow-sm"><Heart size={22}/></div><div><p className="text-[10px] font-semibold uppercase tracking-[0.26em] opacity-60">LIFE SIMULATOR · PERSONAL WORLD</p><h1 className="text-2xl font-semibold tracking-tight">虚拟生活引擎</h1><p className="mt-0.5 text-xs opacity-65">各自生活 · 独立时间 · 自然相遇 · 持续记忆</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-white/70 bg-white/60 px-3 py-1.5 text-xs">{actors.length} 位生活参与者</span><button onClick={ensurePlans} className="inline-flex items-center gap-2 rounded-full bg-[var(--life-accent)] px-4 py-2 text-sm font-medium text-white shadow-sm"><CalendarDays size={15}/>生成本周日程</button></div>
      </header>
      {notice && <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-[var(--life-accent)]/20 bg-white/75 px-4 py-3 text-sm text-stone-700"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
      <nav className="mb-5 grid grid-cols-5 gap-1 rounded-2xl border border-white/80 bg-white/55 p-1 shadow-sm">
        {([{id:"home",label:"生活总览",icon:Heart},{id:"scene",label:"生活场景",icon:MessageCircle},{id:"plans",label:"七日日程",icon:CalendarDays},{id:"invitations",label:"邀约",icon:Coffee},{id:"settings",label:"自定义",icon:Settings2}] as const).map(item => { const Icon=item.icon; return <button key={item.id} onClick={() => setTab(item.id)} className={`flex flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[11px] transition sm:flex-row sm:text-sm ${tab===item.id?"bg-white text-[var(--life-accent)] shadow-sm":"opacity-65 hover:opacity-100"}`}><Icon size={16}/>{item.label}</button>; })}
      </nav>

      {tab === "home" && <div className="grid gap-4 lg:grid-cols-[1.15fr_.85fr]">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
          <SectionTitle eyebrow="Independent timelines" title="每个人都有自己的时间" note="调整某个人的流速，不会改变其他人的时钟。模拟时间不会在退出时偷偷跳回现实。" />
          <div className="space-y-3">{actors.map(actor => { const clock=getActorClock(state,actor.ownerType,actor.ownerId), now=actorNow(actor), current=actorSchedule(actor), actual=actorState(actor); return <div key={`${actor.ownerType}:${actor.ownerId}`} className={`rounded-2xl border p-3 transition ${selectedActorKey===`${actor.ownerType}:${actor.ownerId}`?"border-[var(--life-accent)]/45 bg-white":"border-stone-200/70 bg-white/55"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2"><button onClick={()=>setSelectedActorKey(`${actor.ownerType}:${actor.ownerId}`)} className="flex min-w-0 items-center gap-3 text-left">{actor.avatar ? <img src={actor.avatar} alt="" className="h-10 w-10 rounded-full object-cover"/> : <span className="grid h-10 w-10 place-items-center rounded-full bg-[#efe1d2] text-sm">{actor.ownerType==="player"?"我":actor.name.slice(0,1)}</span>}<span><span className="block font-medium">{actor.name}</span><span className="block text-xs opacity-60">{actorClockLabel(clock)} · {fmt(now)}</span></span></button><span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] text-stone-600">{current?.title ?? "当前没有日程"}</span></div>
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center"><label className="text-xs text-stone-500">时间流速：×{clock.speed}<input type="range" min="0.1" max="100" step="0.1" value={clock.speed} onChange={e=>patchActorClock(actor,{speed:Number(e.target.value),mode:clock.mode==="real-time"?"simulation":clock.mode})} className="mt-2 w-full accent-[var(--life-accent)]"/></label><div className="flex flex-wrap gap-1.5"><select aria-label={`${actor.name}的时间模式`} value={clock.mode} onChange={e=>patchActorClock(actor,{mode:e.target.value as LifeActorClock["mode"]})} className="rounded-xl border border-stone-200 bg-white px-2 py-2 text-xs"><option value="real-time">跟随现实</option><option value="simulation">独立模拟</option><option value="review">暂停回顾</option></select><button onClick={()=>commit(fastForwardActor(state,actor.ownerType,actor.ownerId,60))} className="rounded-xl bg-[#f0e3d5] px-3 py-2 text-xs text-stone-700">+1 虚拟小时</button></div></div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-500"><MapPin size={13}/><span>实际地点：{actual?.actualLocationName ?? "未记录"}</span><select aria-label={`${actor.name}实际地点`} value={actual?.actualLocationId ?? ""} onChange={e=>updateActorLocation(actor,e.target.value)} className="max-w-36 rounded-lg border border-stone-200 bg-white px-2 py-1"><option value="" disabled>更新实际地点…</option>{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select><span className="opacity-40">·</span><span>计划地点：{current?.plannedLocationName ?? "暂无提示"}</span></div>
          </div>; })}</div>
          <p className="mt-4 text-xs leading-relaxed text-stone-500">提示：倍速只影响该角色的虚拟时钟；计划地点不等于实时定位。真实位置仍需要场景状态或合理的信息来源。</p>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
          <SectionTitle eyebrow="Meet by chance" title="进入一个地点" note="同处一地不等于彼此一定看见。你可以决定谁和你一起进入场景，之后再自然互动。" />
          <label className="mb-3 block text-sm">选择地点<select value={selectedLocationId} onChange={e=>setSelectedLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name} · {loc.visibility==="public"?"公共":"私人"}</option>)}</select></label>
          <div className="mb-3 flex gap-2"><input value={newLocationName} onChange={e=>setNewLocationName(e.target.value)} placeholder="自定义新地点…" className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/><button onClick={addLocation} className="rounded-xl bg-white px-3 text-[var(--life-accent)] shadow-sm"><Plus size={17}/></button></div>
          <label className="mb-2 block text-sm">你正在做什么？<input value={playerActivity} onChange={e=>setPlayerActivity(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label>
          <p className="mb-2 mt-4 text-sm font-medium">选择同行角色</p>
          <div className="mb-4 grid grid-cols-2 gap-2">{characters.map(char=><label key={char.id} className="flex cursor-pointer items-center gap-2 rounded-xl border border-stone-200/70 bg-white/70 p-2.5 text-sm"><input type="checkbox" checked={selectedCharacterIds.includes(char.id)} onChange={e=>setSelectedCharacterIds(old=>e.target.checked?[...old,char.id]:old.filter(id=>id!==char.id))} className="accent-[var(--life-accent)]"/><span className="truncate">{char.name}</span></label>)}</div>
          <button onClick={createScene} disabled={!characters.length} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--life-accent)] px-4 py-3 font-medium text-white disabled:opacity-40"><Play size={16}/>进入生活场景</button>
          {activeScene && <button onClick={()=>setTab("scene")} className="mt-2 w-full rounded-2xl border border-[var(--life-accent)]/30 bg-white px-4 py-3 text-sm text-[var(--life-accent)]">继续上次场景：{activeScene.locationName}</button>}
        </section>
      </div>}

      {tab === "scene" && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle eyebrow="Live scene" title={activeScene ? activeScene.locationName : "还没有正在进行的场景"} note={activeScene ? `场景始于 ${fmt(activeScene.startedAt)} · ${activeScene.participants.length} 位参与者 · 已保存，可随时回来继续` : "先从生活总览中选择地点和参与角色，创建一个持续场景。"} />{activeScene && <button onClick={()=>commit({...state,scenes:state.scenes.map(scene=>scene.id===activeScene.id?{...scene,status:"paused" as const,updatedAt:new Date().toISOString()}:scene)})} className="inline-flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs"><Pause size={14}/>暂时离开</button>}</div>
        {activeScene && <>
          <div className="mb-4 flex flex-wrap gap-2">{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerId===p.ownerId&&a.ownerType===p.ownerType);return <button key={p.ownerId} onClick={()=>p.ownerType==="character"&&setSelectedSpeakerId(p.ownerId)} className={`rounded-full px-3 py-1.5 text-xs ${selectedSpeakerId===p.ownerId?"bg-[var(--life-accent)] text-white":"bg-[#f1e5d8] text-stone-700"}`}>{actor?.name??p.ownerId} · {p.activity}</button>})}</div>
          <div className="mb-4 max-h-[48vh] min-h-48 space-y-3 overflow-y-auto rounded-2xl bg-white/65 p-3 sm:p-5" style={{fontSize:"var(--life-font)"}}>
            {sceneMessages.length===0 && <div className="grid min-h-36 place-items-center text-center text-sm text-stone-400"><div><Sparkles className="mx-auto mb-2" size={22}/><p>场景已经准备好了。</p><p className="mt-1 text-xs">角色可以忙自己的事，也可以回应你；不会自动写成长篇剧情。</p></div></div>}
            {sceneMessages.map(message=><div key={message.id} className={`flex ${message.role==="player"?"justify-end":"justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"} ${message.role==="player"?"bg-[#e9d4c0] text-stone-800":"bg-white text-stone-800 shadow-sm"}`}>{message.role!=="player"&&<p className="mb-1 text-[11px] font-semibold text-[var(--life-accent)]">{message.speakerName}</p>}{message.action&&<p className="mb-1.5 italic text-stone-500" style={{fontSize:"var(--life-narration-font)"}}>*{message.action}*</p>}<p className="whitespace-pre-wrap leading-relaxed">{message.dialogue}</p><p className="mt-1 text-right text-[10px] opacity-45">{new Date(message.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</p></div></div>)}
            {busy&&<div className="text-xs text-stone-400">角色正在回应……</div>}
          </div>
          <form onSubmit={sendSceneTurn} className="flex gap-2"><input value={sceneInput} onChange={e=>setSceneInput(e.target.value)} placeholder="在这里说话、询问或描述你自己的行动…" className="min-w-0 flex-1 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm" disabled={busy}/><button disabled={busy||!sceneInput.trim()} className="grid w-12 shrink-0 place-items-center rounded-2xl bg-[var(--life-accent)] text-white disabled:opacity-40"><Send size={17}/></button></form>
          <p className="mt-2 text-xs text-stone-500">生成使用角色现有私聊会话和模型配置；本轮场景指令只临时注入，不会把场景规则写进原线上聊天记录。</p>
        </>}
      </section>}

      {tab === "plans" && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle eyebrow="Weekly plans" title="未来七天的生活日程" note="计划每周生成一次并保存在本地；已有日程不会被重复生成覆盖。点击标题可编辑，计划地点只作为线索。" /><button onClick={ensurePlans} className="inline-flex items-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white"><RefreshCw size={14}/>检查并补全</button></div>
        {actors.map(actor=>{const slots=state.schedules.filter(slot=>slot.ownerType===actor.ownerType&&slot.ownerId===actor.ownerId).sort((a,b)=>a.startAt.localeCompare(b.startAt));return <div key={`${actor.ownerType}:${actor.ownerId}`} className="mb-5"><h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-[var(--life-accent)]"/>{actor.name}<span className="text-xs font-normal text-stone-400">{slots.length} 条安排</span></h3>{slots.length===0?<p className="rounded-xl bg-white/60 p-3 text-sm text-stone-400">还没有日程，点击「生成本周日程」。</p>:<div className="space-y-2">{slots.filter(slot=>new Date(slot.endAt).getTime()>Date.now()-DAY_MS).slice(0,24).map(slot=><div key={slot.id} className="grid grid-cols-[90px_1fr] items-center gap-3 rounded-xl border border-stone-200/70 bg-white/65 p-3 sm:grid-cols-[130px_1fr_auto]"><span className="text-xs text-stone-500">{fmt(slot.startAt)}</span><input aria-label="编辑日程标题" value={slot.title} onChange={e=>addManualPlanTitle(slot,e.target.value)} className="min-w-0 rounded-lg bg-transparent px-1 py-1 text-sm focus:bg-white focus:outline-none"/><span className="col-span-2 text-[11px] text-stone-400 sm:col-span-1">{slot.plannedLocationName??"地点未指定"} · {slot.kind}</span></div>)}</div>}</div>;})}
      </section>}

      {tab === "invitations" && <div className="grid gap-4 lg:grid-cols-[.85fr_1.15fr]">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Make a plan together" title="创建邀约" note="邀约先处于待确认状态。确认后才同步双方日程；不会瞬间跳到约定时间。" />
          <form onSubmit={addInvitation} className="space-y-3"><label className="block text-sm">邀请谁<select value={inviteCharacterId} onChange={e=>setInviteCharacterId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="">选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="block text-sm">活动<input value={inviteActivity} onChange={e=>setInviteActivity(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">时间<input type="datetime-local" value={inviteAt} onChange={e=>setInviteAt(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">地点<select value={inviteLocationId} onChange={e=>setInviteLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label><button className="w-full rounded-2xl bg-[var(--life-accent)] px-4 py-3 text-sm font-medium text-white">发出邀约</button></form>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Invitation inbox" title="邀约记录" />
          {state.invitations.length===0?<p className="rounded-2xl bg-white/60 p-4 text-sm text-stone-400">这里会保存待确认、已确认和已取消的邀约。</p>:<div className="space-y-3">{state.invitations.map(invite=>{const char=characters.find(c=>c.id===invite.characterId);return <div key={invite.id} className="rounded-2xl border border-stone-200/70 bg-white/70 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{char?.name??"未知角色"} · {invite.activity}</p><p className="mt-1 text-xs text-stone-500">{fmt(invite.proposedAt)} · {invite.locationName??"地点待定"}</p></div><span className="rounded-full bg-[#f0e3d5] px-2.5 py-1 text-[11px]">{({proposed:"待确认",confirmed:"已确认",declined:"已拒绝",cancelled:"已取消",completed:"已完成"} as Record<string,string>)[invite.status]}</span></div>{invite.status==="proposed"&&<div className="mt-3 flex gap-2"><button onClick={()=>confirmInvitation(invite.id)} className="rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">确认并同步日程</button><button onClick={()=>commit({...state,invitations:state.invitations.map(item=>item.id===invite.id?{...item,status:"declined" as const,updatedAt:new Date().toISOString()}:item)})} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">拒绝</button></div>}</div>;})}</div>}
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
            <Toggle checked={settings.enableInvitations} onChange={v=>patchSettings({enableInvitations:v})} label="启用邀约系统"/>
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
          <label className="mb-4 block text-sm">场景主题<select value={settings.sceneTheme} onChange={e=>patchSettings({sceneTheme:e.target.value as LifeEngineSettings["sceneTheme"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="warm-paper">暖米棕纸感</option><option value="sage">鼠尾草绿</option><option value="rose">柔和玫瑰</option><option value="night-sky">夜空深色</option></select></label>
          <label className="mb-4 flex items-center justify-between gap-3 text-sm">强调色<input type="color" value={settings.accentColor} onChange={e=>patchSettings({accentColor:e.target.value})} className="h-10 w-16 rounded-lg border-0 bg-transparent"/></label>
          <label className="mb-4 block text-sm">面板不透明度：{settings.panelOpacity}%<input type="range" min="50" max="100" value={settings.panelOpacity} onChange={e=>patchSettings({panelOpacity:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">对白字号：{settings.dialogueFontSize}px<input type="range" min="12" max="24" value={settings.dialogueFontSize} onChange={e=>patchSettings({dialogueFontSize:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">动作旁白字号：{settings.narrationFontSize}px<input type="range" min="10" max="20" value={settings.narrationFontSize} onChange={e=>patchSettings({narrationFontSize:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">对白气泡<select value={settings.dialogueBubbleStyle} onChange={e=>patchSettings({dialogueBubbleStyle:e.target.value as LifeEngineSettings["dialogueBubbleStyle"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="rounded">圆润气泡</option><option value="soft">柔和大圆角</option><option value="square">简洁方形</option></select></label>
          <Toggle checked={settings.compactLayout} onChange={v=>patchSettings({compactLayout:v})} label="紧凑布局"/>
          <label className="mt-4 block text-sm">默认时间模式<select value={settings.defaultClockMode} onChange={e=>patchSettings({defaultClockMode:e.target.value as LifeEngineSettings["defaultClockMode"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="real-time">跟随现实</option><option value="simulation">独立模拟</option><option value="review">暂停回顾</option></select></label>
          <label className="mt-4 block text-sm">新角色默认流速：×{settings.defaultSpeed}<input type="range" min="0.1" max="100" step="0.1" value={settings.defaultSpeed} onChange={e=>patchSettings({defaultSpeed:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mt-4 block text-sm">自定义场景提示词<textarea value={settings.customPrompt} onChange={e=>patchSettings({customPrompt:e.target.value})} rows={5} placeholder="例如：角色更重视生活习惯；不要每次见面都主动热情打招呼……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <button onClick={()=>patchSettings({ ...DEFAULT_LIFE_ENGINE_SETTINGS })} className="mt-4 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm text-stone-600">恢复默认设置</button>
        </section>
      </div>}
      <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] opacity-55"><span>数据保存在当前设备的 KV 数据库中</span><span>生活时钟按角色独立 · 计划不等于现实 · 场景持续保存</span></footer>
    </div>
  </main>;
}
