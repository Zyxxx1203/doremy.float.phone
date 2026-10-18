"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft, CalendarDays, Coffee, Heart, MapPin, MessagesSquare, Eye,
  Pause, Play, Plus, RefreshCw, Send, Settings2, Sparkles, Users, X, Pencil, Trash2,
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
  type LifeTimelineEntry,
  type LifeSceneParticipant,
  type LifeSceneState,
  type LifePromptPreset,
  type LifeScheduleSlot,
  type VirtualLifeState,
} from "@/lib/life/life-types";
import { advanceActorTimeline, applyCharacterLifeScheduleChange, confirmLifeInvitation, generateWeeklyLifePlan, getActorClock, getCurrentActorSchedule, insertManualLifeScheduleSlot, makeLifeInvitation, placeAppointmentInActorSchedule, resolveActorLifeNow, settleActorTimelineToNow, upsertActorClock, upsertActorState, upsertLifeScene } from "@/lib/life/life-runtime";
import { appendLifeTimelineEntry, loadVirtualLifeState, saveVirtualLifeState } from "@/lib/life/life-storage";
import { LIFE_SCENE_OUTPUT_CONTRACT, buildLifeScenePromptContext } from "@/lib/life/life-scene-prompt";
import { evaluateEncounterAwareness } from "@/lib/life/life-engine";
import { evaluateLifeAutonomyWindow, chooseLifeAutonomyCharacter, notifyLifeSceneMessage, LIFE_AUTONOMY_TICK_MS } from "@/lib/life/life-autonomy";
import { armLifeSceneProactiveBailout, cancelLifeSceneProactiveBailouts, suspendIdleReconnectForLifeScene, refreshScheduledBailouts } from "@/lib/push-bailout-client";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { loadBindingConfig, loadImageGenerationSettings, loadPresets, loadWorldBooks, resolveBinding, resolveUserIdentity, USER_IDENTITIES_UPDATED_EVENT } from "@/lib/settings-storage";
import type { BindingConfig, PresetConfig, WorldBookConfig } from "@/lib/settings-types";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import "./life-rose-garden.css";
import { loadMediaObjectUrl, deleteMediaRef } from "@/lib/media-cache-storage";
import { LifeObservation } from "@/components/life/life-observation";

type Tab = "home" | "scene" | "daily" | "people" | "plans" | "invitations" | "experiences" | "locations" | "observe" | "settings";
type ActorChoice = { ownerType: LifeOwnerType; ownerId: string; name: string; avatar?: string | null; persona?: string };
type QuickPlanDraft = { id: string; ownerType: LifeOwnerType; ownerId: string; startAt: string; endAt: string; title: string; locationName: string };
const PLAYER_ID = "player";
const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_LOCATIONS: LifeLocation[] = [
  { id: "home", name: "家", description: "熟悉而放松的私人空间。日常起居、休息、吃饭，也可以在这里安静地陪伴彼此。", atmosphere: "温暖、私密、放松；随着时间和在场角色的状态自然变化。", layout: "入户门通向客厅；客厅有沙发和茶几，窗边有一处可以坐下的位置；厨房与卧室分别位于内侧。", props: ["沙发", "茶几", "抱枕", "窗帘", "水杯"], visibility: "private" },
  { id: "cafe", name: "街角咖啡店", description: "临街的咖啡店，适合偶遇、聊天、看书或短暂停留。", atmosphere: "咖啡香、轻柔的背景音乐、偶尔响起的杯碟声；忙碌程度随时段变化。", layout: "入口旁是点单柜台，靠窗有双人座，店内侧有几张小桌，后方通向洗手间。", props: ["菜单", "咖啡杯", "纸巾", "窗边座位", "手机"], visibility: "public" },
  { id: "park", name: "公园", description: "有步道、树荫和长椅的公共绿地，适合散步、运动或发呆。", atmosphere: "风声、树叶和远处的人声；天气、时段与在场者的活动会影响氛围。", layout: "入口连接环形步道；步道旁有长椅和树荫，中央有一片开阔草地。", props: ["长椅", "树荫", "步道", "草地", "饮料瓶"], visibility: "public" },
  { id: "library", name: "图书馆", description: "安静的阅读与学习空间，适合专注，也适合偶尔交换低声的几句话。", atmosphere: "安静、克制，只有翻页声、键盘声和轻微脚步声。", layout: "入口有借阅台，中央是书架，靠窗有单人桌，内侧有小组讨论区。", props: ["书籍", "书签", "台灯", "笔记本", "耳机"], visibility: "public" },
  { id: "school", name: "学校", description: "教室、图书馆与校园公共区域组成的学习空间。", atmosphere: "课间热闹、上课时安静，随时间段变化。", layout: "教学楼走廊连接教室与楼梯，校园道路通向图书馆和食堂。", props: ["课本", "笔记本", "书包", "校园卡"], visibility: "public" },
  { id: "work", name: "工作地点", description: "用于角色上班、处理事务或进行日常工作的地点。", atmosphere: "专注、规律，可能伴随交谈、键盘声或短暂休息。", layout: "入口连接公共区域，内部有工作桌、座位与休息区。", props: ["电脑", "文件", "水杯", "便签"], visibility: "public" },
  { id: "transit", name: "通勤途中", description: "连接不同地点的路程；角色可能步行、乘车或短暂停留。", atmosphere: "流动、短暂，周围声音和人流随路线变化。", layout: "以道路、站台或车厢为主，具体空间随出行方式变化。", props: ["手机", "耳机", "交通卡", "背包"], visibility: "public" },
  { id: "canteen", name: "食堂 / 附近餐馆", description: "用餐、休息和短暂交流的地方。", atmosphere: "餐食香气、人声与餐具声，饭点会更热闹。", layout: "入口附近有取餐或点单处，座位分布在用餐区。", props: ["餐盘", "筷子", "纸巾", "饮料"], visibility: "public" },
  { id: "studio", name: "音乐 / 创作空间", description: "适合练习乐器、写作、绘画或其他个人创作。", atmosphere: "专注、私密，可能有轻微音乐声或创作时的杂物声。", layout: "主要工作台靠近光源，乐器或材料收纳在一侧，留出活动空间。", props: ["耳机", "笔记本", "乐器 / 创作工具", "水杯"], visibility: "public" },
];
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const fmt = (value: Date | string) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(typeof value === "string" ? new Date(value) : value);
const toLocalDateTimeInput = (value: string) => { const d = new Date(value); if (!Number.isFinite(d.getTime())) return ""; const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); };
const fromLocalDateTimeInput = (value: string) => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toISOString() : ""; };
const mondayStart = (date: Date) => { const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };

function parseLifeOutput(text: string): { action?: string; dialogue: string; followRequest?: { durationMinutes: number; reason: string }; planChange?: { title: string; locationId: string; startAt: string; endAt: string }; invitation?: { time: string; locationId: string; activity: string; reason: string; durationMinutes: number } } {
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
  const invitation = inviteTag ? { time: attribute(inviteTag[1], "time"), locationId: attribute(inviteTag[1], "locationId") || "cafe", activity: attribute(inviteTag[1], "activity") || "一起做点什么", reason: attribute(inviteTag[1], "reason"), durationMinutes: Math.max(15, Math.min(Number.isFinite(inviteDuration) && inviteDuration ? inviteDuration : 60, 24 * 60)) } : undefined;
  const actionTag = text.match(/<life_action\b[^>]*>([\s\S]*?)<\/life_action\s*>/i);
  const dialogueTag = text.match(/<life_dialogue\b[^>]*>([\s\S]*?)<\/life_dialogue\s*>/i);
  const stripControlTags = (value: string) => value
    .replace(/<life_(?:action|dialogue|follow_request|plan_change|invitation)\b[^>]*\/?\s*>/ig, "")
    .replace(/<\/?(?:content|summary|thinking)>/ig, "")
    .trim();
  if (actionTag || dialogueTag) {
    const action = stripControlTags(actionTag?.[1] || "").replace(/^\*+|\*+$/g, "").trim();
    const dialogue = stripControlTags(dialogueTag?.[1] || "");
    return { action, dialogue, followRequest, planChange, invitation };
  }
  const clean = stripControlTags(text);
  const lines = clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const actionLines: string[] = [];
  const dialogueLines: string[] = [];
  for (const line of lines) {
    if (/^\*[^*].*\*$/.test(line) || /^（[^）]+）$/.test(line) || /^\*\*[^*].*\*\*$/.test(line)) actionLines.push(line.replace(/^\*+|\*+$/g, "").replace(/^（|）$/g, ""));
    else dialogueLines.push(line);
  }
  return { action: actionLines.join(" "), dialogue: dialogueLines.join("\n") || (actionLines.length ? "" : clean), followRequest, planChange, invitation };
}


function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return <div className="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/70 px-4 py-3">
    <span className="min-w-0"><span className="block text-sm font-medium text-stone-800">{label}</span>{hint && <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">{hint}</span>}</span>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition focus:outline-none focus:ring-2 focus:ring-[#b88768]/40 ${checked ? "bg-[#b88768]" : "bg-stone-300"}`}><span aria-hidden className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${checked ? "left-[22px]" : "left-0.5"}`} /></button>
  </div>;
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
  const [playerIdentity, setPlayerIdentity] = useState(() => resolveUserIdentity());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [sceneView, setSceneView] = useState(false);
  const [locationDossierOpen, setLocationDossierOpen] = useState(false);
  const [locationStatsTick, setLocationStatsTick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setLocationStatsTick(value => value + 1), 30_000); return () => window.clearInterval(timer); }, []);
  const [phonePresets, setPhonePresets] = useState<PresetConfig[]>([]);
  const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
  const [bindingConfig, setBindingConfig] = useState<BindingConfig>(() => loadBindingConfig());
  const [selectedPhonePresetId, setSelectedPhonePresetId] = useState("");
  const [dailySubtab, setDailySubtab] = useState<"people" | "plans" | "observe">("people");
  const [experienceActorFilter, setExperienceActorFilter] = useState("all");
  const [experienceCategoryFilter, setExperienceCategoryFilter] = useState("all");
  const [experienceDateFilter, setExperienceDateFilter] = useState("");
  const [experienceGroupBy, setExperienceGroupBy] = useState<"date" | "character">("date");
  const [timelineImageBusyId, setTimelineImageBusyId] = useState("");
  const [timelineImageUrls, setTimelineImageUrls] = useState<Record<string, string>>({});
  const timelineImageObjectUrlsRef = useRef<Record<string, string>>({});
  const [selectedActorKey, setSelectedActorKey] = useState("player:player");
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("cafe");
  const [stayDurationMinutes, setStayDurationMinutes] = useState(120);
  const [newLocationName, setNewLocationName] = useState("");
  const [locationDescriptionDraft, setLocationDescriptionDraft] = useState("");
  const [locationAtmosphereDraft, setLocationAtmosphereDraft] = useState("");
  const [locationLayoutDraft, setLocationLayoutDraft] = useState("");
  const [locationPropsDraft, setLocationPropsDraft] = useState("");
  const [locationHabitDrafts, setLocationHabitDrafts] = useState<Record<string, string>>({});

  const [quickPlanText, setQuickPlanText] = useState("");
  const [quickPlanDrafts, setQuickPlanDrafts] = useState<QuickPlanDraft[]>([]);
  const [playerActivity, setPlayerActivity] = useState("");
  const [sceneInput, setSceneInput] = useState("");
  const sceneChatScrollRef = useRef<HTMLDivElement | null>(null);
  const [sceneActionInput, setSceneActionInput] = useState("");
  const [messageActionTarget, setMessageActionTarget] = useState<LifeSceneMessage | null>(null);
  const [messageActionMode, setMessageActionMode] = useState<"menu" | "edit" | "delete-confirm">("menu");
  const [messageEditDraft, setMessageEditDraft] = useState("");
  const [messageEditActionDraft, setMessageEditActionDraft] = useState("");
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [notice, setNotice] = useState("");
  const [sceneToast, setSceneToast] = useState<{ title: string; body: string } | null>(null);
  const proactiveAttemptAtRef = useRef<Record<string, number>>({});
  const proactiveNextAtRef = useRef<Record<string, number>>({});
  const proactiveBusyRef = useRef(false);
  const proactiveLastSpeakerRef = useRef<Record<string, string>>({});
  const [inviteCharacterId, setInviteCharacterId] = useState("");
  const [inviteLocationId, setInviteLocationId] = useState("cafe");
  const [inviteActivity, setInviteActivity] = useState("一起喝杯咖啡");
  const [inviteReason, setInviteReason] = useState("");
  const [inviteAt, setInviteAt] = useState("");
  const [inviteAtEdited, setInviteAtEdited] = useState(false);
  const [editingInvitationId, setEditingInvitationId] = useState<string | null>(null);
  const [editInvitationDraft, setEditInvitationDraft] = useState({ activity: "", reason: "", proposedAt: "", locationId: "", durationMinutes: "60" });
  const inviteDefaultInitializedRef = useRef(false);
  const [sceneImageBusy, setSceneImageBusy] = useState(false);
  const [imageObjectUrls, setImageObjectUrls] = useState<Record<string,string>>({});
  const [imageViewerIndex, setImageViewerIndex] = useState(0);
  const [imageParticipantIds, setImageParticipantIds] = useState<string[]>([]);
  const autoImageSceneRef = useRef<string | null>(null);
  const openDaily = (subtab: "people" | "plans") => { setDailySubtab(subtab); setTab("daily"); };
  useEffect(() => {
    const refreshPhonePresets = () => setPhonePresets(loadPresets());
    const refreshWorldBooks = () => setWorldBooks(loadWorldBooks());
    const refreshBindings = () => setBindingConfig(loadBindingConfig());
    refreshPhonePresets(); refreshWorldBooks(); refreshBindings();
    window.addEventListener("settings-presets-updated", refreshPhonePresets);
    window.addEventListener("settings-worldbooks-updated", refreshWorldBooks);
    window.addEventListener("settings-bindings-updated", refreshBindings);
    return () => { window.removeEventListener("settings-presets-updated", refreshPhonePresets); window.removeEventListener("settings-worldbooks-updated", refreshWorldBooks); window.removeEventListener("settings-bindings-updated", refreshBindings); };
  }, []);

  useEffect(() => {
    let alive = true;
    void hydrateKvDb().then(() => hydrateChatStorage()).catch(() => undefined).finally(() => {
      if (!alive) return;
      const loaded = loadVirtualLifeState();
      let normalized: VirtualLifeState = { ...loaded, locations: [...INITIAL_LOCATIONS.filter(location => !loaded.locations.some(saved => saved.id === location.id)), ...loaded.locations.map(saved => { const defaults = INITIAL_LOCATIONS.find(location => location.id === saved.id); return defaults ? { ...defaults, ...saved, description: saved.description || defaults.description, atmosphere: saved.atmosphere || defaults.atmosphere, layout: saved.layout || defaults.layout, props: saved.props?.length ? saved.props : defaults.props } : saved; })] };
      // One-time migration: rebuild only auto-generated character schedule slots in the current/next two weeks.
      // This version incorporates bound world books, saved location habits, and canonical place matching.
      // User-authored and completed historical entries remain untouched.
      if ((normalized.scheduleProfileVersion ?? 0) < 3) {
        const realNow = Date.now();
        const rebuildUntil = realNow + 14 * DAY_MS;
        normalized = {
          ...normalized,
          scheduleProfileVersion: 3,
          schedules: normalized.schedules.filter(slot => !(
            slot.ownerType === "character" &&
            slot.source === "weekly-generation" &&
            new Date(slot.startAt).getTime() < rebuildUntil &&
            new Date(slot.endAt).getTime() > realNow
          )),
        };
        saveVirtualLifeState(normalized);
      }
      const hasContinuingScene = normalized.scenes.some(scene => scene.status === "active" || scene.status === "paused");
      if (!hasContinuingScene && normalized.settings.enabled) {
        const player = normalized.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
        const virtualNow = resolveActorLifeNow(getActorClock(normalized, "player", PLAYER_ID));
        const currentSlot = getCurrentActorSchedule(normalized, "player", PLAYER_ID, virtualNow);
        const location = normalized.locations.find(item => item.id === (player?.actualLocationId || currentSlot?.plannedLocationId)) || normalized.locations.find(item => item.id === "home") || normalized.locations[0];
        if (location) {
          const now = new Date().toISOString();
          const scene: LifeSceneState = { id: id("scene"), locationId: location.id, locationName: player?.actualLocationName || currentSlot?.plannedLocationName || location.name, startedAt: now, updatedAt: now, status: "active", participants: [{ ownerType: "player", ownerId: PLAYER_ID, activity: player?.activity || currentSlot?.title || "正在度过今天", awarenessByActorId: {} }], lastSettledEventIds: [] };
          normalized = { ...normalized, scenes: [...normalized.scenes, scene] };
          saveVirtualLifeState(normalized);
        }
      }
      const restoredScene = normalized.scenes.find(scene => scene.status === "active")
        ?? normalized.scenes.filter(scene => scene.status === "paused").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const restoredPlayer = normalized.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
      setSelectedLocationId(restoredPlayer?.actualLocationId || restoredScene?.locationId || normalized.locations[0]?.id || "cafe");
      stateRef.current = normalized;
      setState(normalized);
      setCharacters(loadCharacters());
      setPlayerIdentity(resolveUserIdentity());
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  const commit = useCallback((next: VirtualLifeState) => {
    stateRef.current = next;
    setState(next);
    saveVirtualLifeState(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncExternalLifeChanges = () => {
      // Chat, diary, moments and tool execution write timeline entries outside this component.
      // Reload without saving so the next UI action does not overwrite those entries.
      const latest = loadVirtualLifeState();
      stateRef.current = latest;
      setState(latest);
    };
    window.addEventListener("virtual-life-state-updated", syncExternalLifeChanges);
    return () => window.removeEventListener("virtual-life-state-updated", syncExternalLifeChanges);
  }, []);

  useEffect(() => {
    if (!ready || inviteDefaultInitializedRef.current || inviteAtEdited) return;
    const virtualNow = resolveActorLifeNow(getActorClock(state, "player", PLAYER_ID));
    const rounded = new Date(virtualNow.getTime() + 60 * 60_000);
    rounded.setMinutes(0, 0, 0);
    setInviteAt(new Date(rounded.getTime() - rounded.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    inviteDefaultInitializedRef.current = true;
  }, [ready, state.actorClocks, inviteAtEdited]);

  const settings = state.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;
  const promptPresets = settings.promptPresets ?? [];
  const activePromptPreset: LifePromptPreset = promptPresets.find(preset => preset.id === settings.activePromptPresetId) ?? promptPresets[0] ?? { id: "life-default", name: "生活现场默认预设" };
  const activePromptPresetText = [activePromptPreset.basePresetPrompt, activePromptPreset.sceneBehaviorPrompt, activePromptPreset.customPrompt].filter(value => typeof value === "string" && value.trim()).join("\n\n");
  const activeSceneOutputPrompt = activePromptPreset.sceneOutputPrompt?.trim() || LIFE_SCENE_OUTPUT_CONTRACT;
  const sceneImagePrompt = settings.sceneImagePrompt;
  const playerName = settings.playerDisplayName || "我";
  useEffect(() => {
    const syncIdentity = () => setPlayerIdentity(resolveUserIdentity(selectedSpeakerId || undefined));
    syncIdentity();
    window.addEventListener(USER_IDENTITIES_UPDATED_EVENT, syncIdentity);
    return () => window.removeEventListener(USER_IDENTITIES_UPDATED_EVENT, syncIdentity);
  }, [selectedSpeakerId]);
  const getCharacterWorldBookContext = (characterId: string) => {
    const chatBinding = resolveBinding(bindingConfig, characterId, "chat");
    const dwellingBinding = resolveBinding(bindingConfig, characterId, "dwelling");
    const ids = new Set([...(chatBinding.worldBookIds ?? []), ...(dwellingBinding.worldBookIds ?? [])]);
    return worldBooks.filter(book => ids.has(book.id)).flatMap(book =>
      book.entries.filter(entry => !entry.disable).map(entry => [entry.comment, entry.key, entry.content].filter(Boolean).join("："))
    ).slice(0, 30).join("\n").slice(0, 8000);
  };
  const actors = useMemo<ActorChoice[]>(() => [
    { ownerType: "player", ownerId: PLAYER_ID, name: playerName, avatar: playerIdentity?.avatarUrl },
    ...characters.map(char => ({ ownerType: "character" as const, ownerId: char.id, name: char.name, avatar: char.avatar, persona: [char.persona, char.personality, ...(char.tags ?? []), getCharacterWorldBookContext(char.id), ...state.locations.map(location => location.characterHabits?.[char.id] ? `${location.name}地点习惯：${location.characterHabits[char.id]}` : "")].filter(Boolean).join("\n") })),
  ], [characters, playerName, playerIdentity?.avatarUrl, worldBooks, bindingConfig, state.locations]);
  const selectedActor = actors.find(actor => `${actor.ownerType}:${actor.ownerId}` === selectedActorKey) ?? actors[0];
  const activeScene = useMemo(() => state.scenes.find(scene => scene.status === "active") ?? state.scenes.filter(scene => scene.status === "paused").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0], [state.scenes]);
  const sceneMessages = useMemo(() => activeScene ? state.sceneMessages.filter(message => message.sceneId === activeScene.id) : [], [state.sceneMessages, activeScene]);
  const selectedLocation = state.locations.find(location => location.id === selectedLocationId) ?? state.locations[0];
  const selectedLocationVisitStats = useMemo(() => {
    if (!selectedLocation) return { visits: 0, minutes: 0, activeMinutes: 0 };
    const virtualNow = resolveActorLifeNow(getActorClock(state, "player", PLAYER_ID));
    const locationEntries = state.timeline
      .filter(entry => entry.category === "location" && entry.actorId === PLAYER_ID && !!entry.locationName)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const visits = locationEntries.filter(entry => entry.title.startsWith("你来到了"));
    let minutes = 0;
    let activeMinutes = 0;
    let count = 0;
    visits.forEach(entry => {
      if (entry.locationName !== selectedLocation.name) return;
      count += 1;
      const nextLocationEntry = locationEntries.find(next => next.occurredAt > entry.occurredAt);
      const isStillHere = state.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID)?.actualLocationId === selectedLocation.id && !nextLocationEntry;
      const endAt = nextLocationEntry ? new Date(nextLocationEntry.occurredAt) : isStillHere ? virtualNow : new Date(entry.occurredAt);
      const duration = Math.max(0, Math.floor((endAt.getTime() - new Date(entry.occurredAt).getTime()) / 60_000));
      minutes += duration;
      if (isStillHere) activeMinutes = duration;
    });
    return { visits: count, minutes, activeMinutes };
  }, [state.timeline, state.actorStates, state.actorClocks, selectedLocation, locationStatsTick]);
  // In a live scene, the viewport belongs to the scene itself rather than the document.
  const immersiveScene = !!activeScene && ((tab === "home" && sceneView) || tab === "scene");

  useEffect(() => {
    if (!immersiveScene) return;
    const scroller = sceneChatScrollRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [immersiveScene, activeScene?.id, sceneMessages.length, busy]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--life-viewport-height", `${Math.max(240, Math.round(height))}px`);
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [immersiveScene]);

  useEffect(() => {
    setLocationDescriptionDraft(selectedLocation?.description ?? "");
    setLocationAtmosphereDraft(selectedLocation?.atmosphere ?? "");
    setLocationLayoutDraft(selectedLocation?.layout ?? "");
    setLocationPropsDraft((selectedLocation?.props ?? []).join("、"));
    setLocationHabitDrafts(selectedLocation?.characterHabits ?? {});
  }, [selectedLocation?.id]);

  useEffect(() => {
    if (!activeScene) return;
    const firstParticipant = activeScene.participants.find(participant => participant.ownerType === "character");
    if (!activeScene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === selectedSpeakerId)) {
      setSelectedSpeakerId(firstParticipant?.ownerId ?? "");
    }
  }, [activeScene?.id, activeScene?.participants, selectedSpeakerId]);



  useEffect(() => {
    if (!ready) return;
    let next = state;
    const owners = [
      { ownerType: "player" as const, ownerId: PLAYER_ID, name: playerName, profile: "" },
      ...characters.map(character => ({ ownerType: "character" as const, ownerId: character.id, name: character.name, profile: [character.persona, character.personality, ...(character.tags ?? []), getCharacterWorldBookContext(character.id), ...state.locations.map(location => location.characterHabits?.[character.id] ? `${location.name}地点习惯：${location.characterHabits[character.id]}` : "")].filter(Boolean).join(" ") })),
    ];
    for (const owner of owners) {
      if (!next.actorClocks.some(clock => clock.ownerType === owner.ownerType && clock.ownerId === owner.ownerId)) {
        next = upsertActorClock(next, owner.ownerType, owner.ownerId, { mode: settings.defaultClockMode, speed: settings.defaultSpeed });
      }
      const actorNow = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
      const thisMonday = mondayStart(actorNow);
      const nextMonday = new Date(thisMonday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      // Each person's schedule follows their own virtual calendar, not the device date.
      next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, thisMonday, { id: "home", name: "家" }, [owner.profile, activePromptPreset.scheduleGenerationPrompt].filter(Boolean).join(" "), settings.generateSpecialEvents);
      if (settings.autoGenerateWeeklyPlans) {
        next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, nextMonday, { id: "home", name: "家" }, [owner.profile, activePromptPreset.scheduleGenerationPrompt].filter(Boolean).join(" "), settings.generateSpecialEvents);
      }
    }
    if (next !== state) commit(next);
  }, [ready, settings.autoGenerateWeeklyPlans, settings.generateSpecialEvents, settings.defaultClockMode, settings.defaultSpeed, activePromptPreset.scheduleGenerationPrompt, characters, playerName, state, worldBooks, bindingConfig, commit]);

  useEffect(() => {
    if (!ready) return;
    const settleAll = () => {
      let next = stateRef.current;
      const liveSettings = next.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;
      const roster = loadCharacters();
      const owners = [
        { ownerType: "player" as const, ownerId: PLAYER_ID, name: liveSettings.playerDisplayName || "我", profile: "" },
        ...roster.map(character => ({ ownerType: "character" as const, ownerId: character.id, name: character.name, profile: [character.persona, character.personality, ...(character.tags ?? []), getCharacterWorldBookContext(character.id), ...stateRef.current.locations.map(location => location.characterHabits?.[character.id] ? `${location.name}地点习惯：${location.characterHabits[character.id]}` : "")].filter(Boolean).join(" ") })),
      ];
      for (const owner of owners) {
        const virtualNow = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
        // Always inspect the current virtual week first. A future manual slot
        // must not prevent missing baseline days from being generated.
        let week = mondayStart(virtualNow);
        const target = mondayStart(virtualNow);
        const targetEnd = new Date(target);
        targetEnd.setDate(targetEnd.getDate() + (liveSettings.autoGenerateWeeklyPlans ? 7 : 0));
        for (let guard = 0; week.getTime() <= targetEnd.getTime() && guard < 520; guard++) {
          next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, week, { id: "home", name: "家" }, [owner.profile, activePromptPreset.scheduleGenerationPrompt].filter(Boolean).join(" "), liveSettings.generateSpecialEvents);
          week.setDate(week.getDate() + 7);
        }
        const beforeSettle = next;
        const beforeActor = beforeSettle.actorStates.find(item => item.ownerType === owner.ownerType && item.ownerId === owner.ownerId);
        const beforeEventIds = new Set(beforeSettle.events.map(event => event.id));
        next = settleActorTimelineToNow(next, owner.ownerType, owner.ownerId);
        {
          const nowForOwner = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
          const recentCutoff = nowForOwner.getTime() - 24 * 60 * 60 * 1000;
          for (const event of next.events) {
            if (beforeEventIds.has(event.id) || event.kind !== "activity" || event.status !== "completed" || !event.settlementKey?.startsWith("schedule:")) continue;
            const ended = new Date(event.endsAt ?? event.createdAt).getTime();
            if (!Number.isFinite(ended) || ended < recentCutoff) continue;
            next = appendLifeTimelineEntry(next, { category: "schedule", occurredAt: event.endsAt ?? event.createdAt, title: owner.name + "结束了一个时段：" + event.title, details: event.locationName ? "地点：" + event.locationName : undefined, actorId: owner.ownerId, actorName: owner.name, locationName: event.locationName ?? undefined, sourceId: event.id });
          }
          const afterActor = next.actorStates.find(item => item.ownerType === owner.ownerType && item.ownerId === owner.ownerId);
          if (beforeActor && afterActor && (beforeActor.activity !== afterActor.activity || beforeActor.actualLocationId !== afterActor.actualLocationId)) {
            next = appendLifeTimelineEntry(next, { category: "schedule", title: owner.name + "现在" + afterActor.activity, details: afterActor.actualLocationName ? "当前地点：" + afterActor.actualLocationName : undefined, actorId: owner.ownerId, actorName: owner.name, locationName: afterActor.actualLocationName ?? undefined });
          }
          if (beforeActor && afterActor && beforeActor.actualLocationId !== afterActor.actualLocationId && afterActor.actualLocationName) {
            next = appendLifeTimelineEntry(next, {
              category: "location",
              title: owner.name + "来到了" + afterActor.actualLocationName,
              details: beforeActor.actualLocationName ? "从" + beforeActor.actualLocationName + "前往" + afterActor.actualLocationName : "实际地点发生变化",
              actorId: owner.ownerId, actorName: owner.name, locationName: afterActor.actualLocationName,
            });
            if (owner.ownerType === "character") {
              const player = next.actorStates.find(item => item.ownerType === "player" && item.ownerId === PLAYER_ID);
              if (player?.actualLocationId) {
                const sharedScene = next.scenes.find(scene => scene.status === "active" && scene.locationId === player.actualLocationId);
                if (beforeActor.actualLocationId === player.actualLocationId && afterActor.actualLocationId !== player.actualLocationId) {
                  next = appendLifeTimelineEntry(next, {
                    category: "scene", title: owner.name + "离开了你所在的场景",
                    details: "TA 前往了" + afterActor.actualLocationName,
                    actorId: owner.ownerId, actorName: owner.name, locationName: beforeActor.actualLocationName ?? undefined,
                    sceneId: sharedScene?.id,
                  });
                  if (sharedScene) {
                    next = upsertLifeScene(next, {
                      ...sharedScene,
                      participants: sharedScene.participants.filter(participant => !(participant.ownerType === "character" && participant.ownerId === owner.ownerId)),
                      updatedAt: new Date().toISOString(),
                    });
                  }
                } else if (beforeActor.actualLocationId !== player.actualLocationId && afterActor.actualLocationId === player.actualLocationId) {
                  next = appendLifeTimelineEntry(next, {
                    category: "scene", title: owner.name + "进入了你所在的场景",
                    details: "TA 现在也在" + afterActor.actualLocationName,
                    actorId: owner.ownerId, actorName: owner.name, locationName: afterActor.actualLocationName,
                    sceneId: sharedScene?.id,
                  });
                  if (sharedScene && !sharedScene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === owner.ownerId)) {
                    next = upsertLifeScene(next, {
                      ...sharedScene,
                      participants: [
                        ...sharedScene.participants.map(participant => participant.ownerType === "player"
                          ? { ...participant, awarenessByActorId: { ...participant.awarenessByActorId, [owner.ownerId]: "aware" as const } }
                          : participant),
                        { ownerType: "character", ownerId: owner.ownerId, activity: afterActor.activity, awarenessByActorId: { [PLAYER_ID]: "aware" } },
                      ],
                      updatedAt: new Date().toISOString(),
                    });
                  }
                }
              }
            }
          }
        }
      }
      // Keep one continuous scene anchored to the player's current virtual life state.
      const continuingScene = next.scenes.find(scene => scene.status === "active") ?? next.scenes.filter(scene => scene.status === "paused").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const currentPlayer = next.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
      const playerNow = resolveActorLifeNow(getActorClock(next, "player", PLAYER_ID));
      const playerSlot = getCurrentActorSchedule(next, "player", PLAYER_ID, playerNow);
      const sceneLocationId = currentPlayer?.actualLocationId || playerSlot?.plannedLocationId || continuingScene?.locationId;
      const sceneLocationName = currentPlayer?.actualLocationName || playerSlot?.plannedLocationName || continuingScene?.locationName;
      if (continuingScene && sceneLocationId && sceneLocationName && (continuingScene.locationId !== sceneLocationId || continuingScene.locationName !== sceneLocationName)) {
        next = upsertLifeScene(next, { ...continuingScene, locationId: sceneLocationId, locationName: sceneLocationName, updatedAt: new Date().toISOString(), participants: continuingScene.participants.map(participant => participant.ownerType === "player" ? { ...participant, activity: currentPlayer?.activity || playerSlot?.title || participant.activity } : participant) });
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
  }, [ready, commit, worldBooks, bindingConfig, activePromptPreset.scheduleGenerationPrompt]);

  const patchSettings = (patch: Partial<LifeEngineSettings>) => commit({ ...stateRef.current, settings: { ...stateRef.current.settings, ...patch } });
  const patchActivePromptPreset = (patch: Partial<LifePromptPreset>) => {
    const currentSettings = stateRef.current.settings;
    let presets = [...(currentSettings.promptPresets ?? [])];
    let activeId = currentSettings.activePromptPresetId;
    if (!presets.length) {
      presets = [{ id: "life-default", name: "生活现场默认预设" }];
      activeId = "life-default";
    }
    if (!activeId || !presets.some(preset => preset.id === activeId)) activeId = presets[0].id;
    presets = presets.map(preset => preset.id === activeId ? { ...preset, ...patch } : preset);
    commit({ ...stateRef.current, settings: { ...currentSettings, promptPresets: presets, activePromptPresetId: activeId } });
  };
  const createLifePromptPreset = () => {
    const presets = [...(stateRef.current.settings.promptPresets ?? [])];
    const preset: LifePromptPreset = { id: id("life-prompt-preset"), name: `生活预设 ${presets.length + 1}` };
    commit({ ...stateRef.current, settings: { ...stateRef.current.settings, promptPresets: [...presets, preset], activePromptPresetId: preset.id } });
  };
  const deleteActiveLifePromptPreset = () => {
    const presets = stateRef.current.settings.promptPresets ?? [];
    if (presets.length <= 1) { setNotice("至少保留一个生活预设；可以清空其中的内容恢复默认。"); return; }
    const next = presets.filter(preset => preset.id !== activePromptPreset.id);
    commit({ ...stateRef.current, settings: { ...stateRef.current.settings, promptPresets: next, activePromptPresetId: next[0]?.id } });
  };
  const importPhonePromptPreset = () => {
    const source = phonePresets.find(preset => preset.id === selectedPhonePresetId);
    if (!source) { setNotice("请先选择一个小手机原有预设。"); return; }
    const imported = source.prompts.filter(prompt => prompt.enabled !== false && prompt.content?.trim()).map(prompt => `【${prompt.name || prompt.identifier}】\\n${prompt.content}`).join("\\n\\n");
    patchActivePromptPreset({ sourcePresetId: source.id, sourcePresetName: source.name, basePresetPrompt: imported });
    setNotice(`已将「${source.name}」中启用的提示词导入当前生活预设。导入内容可继续直接编辑，不会修改原小手机预设。`);
  };
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
    const nextActivity = slot?.title ?? previous?.activity ?? "正在自主安排时间";
    const nextLocationId = slot?.plannedLocationId ?? previous?.actualLocationId ?? null;
    const nextLocationName = slot?.plannedLocationName ?? previous?.actualLocationName ?? null;
    next = upsertActorState(next, {
      ownerType: actor.ownerType, ownerId: actor.ownerId,
      activity: nextActivity,
      actualLocationId: nextLocationId,
      actualLocationName: nextLocationName,
      updatedAt: new Date().toISOString(),
    });
    if (previous?.activity !== nextActivity) {
      next = appendLifeTimelineEntry(next, { category: "schedule", title: actor.name + "现在" + nextActivity, details: nextLocationName ? "当前地点：" + nextLocationName : undefined, actorId: actor.ownerId, actorName: actor.name, locationName: nextLocationName ?? undefined });
    }
    if (previous?.actualLocationId !== nextLocationId && nextLocationName) {
      next = appendLifeTimelineEntry(next, { category: "location", title: actor.name + "来到了" + nextLocationName, details: previous?.actualLocationName ? "从" + previous.actualLocationName + "前往" + nextLocationName : "自主生活时更新了地点", actorId: actor.ownerId, actorName: actor.name, locationName: nextLocationName });
    }
    commit(next);
    setNotice(`${actor.name}独立度过了一个虚拟小时；其他人的时间没有变化。`);
  };

  const actorClockLabel = (clock: LifeActorClock) => clock.mode === "real-time" ? "跟随现实" : clock.mode === "review" ? "回顾暂停" : `模拟 ×${clock.speed}`;

  const ensurePlans = () => {
    let next = state;
    const playerVirtualNow = resolveActorLifeNow(getActorClock(next, "player", PLAYER_ID));
    next = generateWeeklyLifePlan(next, "player", PLAYER_ID, playerName, mondayStart(playerVirtualNow), { id: "home", name: "家" });
    for (const character of characters) {
      const characterVirtualNow = resolveActorLifeNow(getActorClock(next, "character", character.id));
      next = generateWeeklyLifePlan(next, "character", character.id, character.name, mondayStart(characterVirtualNow), { id: "home", name: "家" }, [character.persona, character.personality, ...(character.tags ?? []), activePromptPreset.scheduleGenerationPrompt].filter(Boolean).join(" "), settings.generateSpecialEvents);
    }
    if (next === state) setNotice("本周计划已经存在，没有重新生成或覆盖你的修改。");
    else { commit(next); setNotice("已按每个人自己的虚拟时间生成可编辑的生活日程。"); }
  };

  const updateActorLocation = (actor: ActorChoice, locationId: string) => {
    // Read and update the latest persisted-in-memory snapshot so a rapid location
    // change cannot overwrite another life action committed since this render.
    const currentState = stateRef.current;
    const location = currentState.locations.find(item => item.id === locationId);
    if (!location) return;
    const current = currentState.actorStates.find(item => item.ownerType === actor.ownerType && item.ownerId === actor.ownerId);
    let next = upsertActorState(currentState, { ownerType: actor.ownerType, ownerId: actor.ownerId, activity: current?.activity || "正在这里活动", actualLocationId: location.id, actualLocationName: location.name, actualLocationUntil: null, updatedAt: new Date().toISOString() });
    next = appendLifeTimelineEntry(next, { category: "location", title: actor.name + "来到了" + location.name, details: current?.actualLocationName ? "从" + current.actualLocationName + "前往" + location.name : "首次记录实际地点", actorId: actor.ownerId, actorName: actor.name, locationName: location.name });
    if (actor.ownerType === "player" && current?.actualLocationId !== location.id) {
      const scene = next.scenes.find(item => item.status === "active") ?? next.scenes.filter(item => item.status === "paused").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (scene) {
        const now = new Date().toISOString();
        next = appendLifeTimelineEntry(next, { category: "scene", title: "当前场景转移至" + location.name, details: "你从" + (current?.actualLocationName || scene.locationName) + "前往" + location.name + "；沿用同一条持续场景记录", actorId: PLAYER_ID, actorName: playerName, locationName: location.name, sceneId: scene.id });
        next = upsertLifeScene(next, { ...scene, locationId: location.id, locationName: location.name, status: "active", updatedAt: now, participants: scene.participants.map(participant => participant.ownerType === "player" && participant.ownerId === PLAYER_ID ? { ...participant, activity: playerActivity || participant.activity } : participant) });
      }
    } else if (actor.ownerType === "character") {
      const player = next.actorStates.find(item => item.ownerType === "player" && item.ownerId === PLAYER_ID);
      const scene = player?.actualLocationId
        ? next.scenes.find(item => item.status === "active" && item.locationId === player.actualLocationId)
        : undefined;
      if (scene && current?.actualLocationId === player?.actualLocationId && location.id !== player?.actualLocationId
        && scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === actor.ownerId)) {
        next = appendLifeTimelineEntry(next, { category: "scene", title: actor.name + "离开了你所在的场景", details: "TA 前往了" + location.name, actorId: actor.ownerId, actorName: actor.name, locationName: scene.locationName, sceneId: scene.id });
        next = upsertLifeScene(next, { ...scene, participants: scene.participants.filter(participant => !(participant.ownerType === "character" && participant.ownerId === actor.ownerId)), updatedAt: new Date().toISOString() });
      } else if (scene && location.id === player?.actualLocationId
        && !scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === actor.ownerId)) {
        next = appendLifeTimelineEntry(next, { category: "scene", title: actor.name + "进入了你所在的场景", details: "TA 现在也在" + location.name, actorId: actor.ownerId, actorName: actor.name, locationName: location.name, sceneId: scene.id });
        next = upsertLifeScene(next, { ...scene, participants: [
          ...scene.participants.map(participant => participant.ownerType === "player" ? { ...participant, awarenessByActorId: { ...participant.awarenessByActorId, [actor.ownerId]: "aware" as const } } : participant),
          { ownerType: "character", ownerId: actor.ownerId, activity: current?.activity || "正在这里活动", awarenessByActorId: { [PLAYER_ID]: "aware" } },
        ], updatedAt: new Date().toISOString() });
      }
    }
    commit(next);
    setNotice(`${actor.name}的实际地点已更新为「${location.name}」。这与日程中的计划地点分开保存。`);
  };

  const performCreateScene = () => {
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
    const existingScene = stateRef.current.scenes.find(scene => scene.status === "active" && scene.locationId === selectedLocation.id) ?? stateRef.current.scenes.filter(scene => scene.status === "paused" && scene.locationId === selectedLocation.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const shouldRecordSceneEntry = !existingScene || existingScene.status === "paused";
    const isFirstSceneEntry = !existingScene;
    let next: VirtualLifeState = { ...stateRef.current, scenes: stateRef.current.scenes.map(scene => (scene.status === "active" || scene.status === "paused") ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    const scene: LifeSceneState = existingScene
      ? { ...existingScene, locationId: selectedLocation.id, locationName: selectedLocation.name, updatedAt: now, status: "active", participants }
      : { id: id("scene"), locationId: selectedLocation.id, locationName: selectedLocation.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    for (const actor of [{ ownerType: "player" as const, ownerId: PLAYER_ID }, ...chosen.map(char => ({ ownerType: "character" as const, ownerId: char.id }))]) {
      next = upsertActorState(next, { ...actor, activity: actor.ownerType === "player" ? (playerActivity || "刚来到这里") : "正在做自己的事", actualLocationId: selectedLocation.id, actualLocationName: selectedLocation.name, actualLocationUntil: actor.ownerType === "player" ? new Date(resolveActorLifeNow(getActorClock(stateRef.current, "player", PLAYER_ID)).getTime() + stayDurationMinutes * 60_000).toISOString() : null, updatedAt: now });
    }
    if (shouldRecordSceneEntry) {
      const entryText = isFirstSceneEntry
        ? "你来到了" + selectedLocation.name + "。场景从这里开始。"
        : "你回到了" + selectedLocation.name + "。先前的场景与互动仍在继续。";
      next = appendLifeTimelineEntry(next, { category: "scene", title: isFirstSceneEntry ? "你和" + chosen.map(char=>char.name).join("、") + "进入了" + selectedLocation.name : "你回到了" + selectedLocation.name, details: entryText, actorName: "场景旁白", locationName: selectedLocation.name, sceneId: scene.id });
      const entryNarration: LifeSceneMessage = { id: id("turn"), sceneId: scene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: "场景旁白", role: "system", action: entryText, dialogue: "", createdAt: now };
      next = { ...next, sceneMessages: [...next.sceneMessages, entryNarration] };
    }
    commit(next);
    setTab("home");
    setSceneView(true);
    setNotice("共同场景已建立并保存；重新打开会接着当前状态，不会重演。");

  };

  const transitionSceneAction = (action: () => void) => {
    if (typeof document === "undefined" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)) {
      action();
      return;
    }
    const viewTransitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => { finished?: Promise<void> };
    };
    if (typeof viewTransitionDocument.startViewTransition !== "function") {
      action();
      return;
    }
    let actionStarted = false;
    const runOnce = () => {
      if (actionStarted) return;
      actionStarted = true;
      flushSync(action);
    };
    try {
      viewTransitionDocument.startViewTransition(runOnce);
    } catch {
      if (!actionStarted) action();
    }
  };

  const createScene = () => transitionSceneAction(performCreateScene);

  /** Arrival uses actual-location state only; planned locations never create encounters. */
  /** Arrival uses actual-location state only; planned locations never create encounters. */
  const performEnterLocationSolo = (targetLocationId = selectedLocationId) => {
    const destination = stateRef.current.locations.find(location => location.id === targetLocationId);
    if (!settings.enabled) { setNotice("生活引擎当前已关闭，请先在自定义设置中启用。"); return; }
    if (!destination) return;
    const now = new Date().toISOString();
    const actualCharacters = settings.enableCoincidences
      ? characters.filter(char => state.actorStates.some(actor => actor.ownerType === "character" && actor.ownerId === char.id && actor.actualLocationId === destination.id))
      : [];
    const participants: LifeSceneParticipant[] = [{
      ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "刚来到这里", awarenessByActorId: {},
    }];
    for (const char of actualCharacters) {
      const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === char.id);
      if (!actor) continue;
      const perception = {
        distance: "medium" as const,
        lineOfSight: destination.visibility === "public",
        audible: true,
        attention: /专注|工作|学习|读书|写作|打电话/.test(actor.activity) ? "focused" as const : /发呆|等待|休息/.test(actor.activity) ? "distracted" as const : "normal" as const,
        activity: /等待|休息|发呆/.test(actor.activity) ? "waiting" as const : /工作|学习|读书|写作/.test(actor.activity) ? "busy" as const : "casual" as const,
        noticing: /外向|敏锐|警觉|好奇|观察力/.test(char.personality || "") ? 0.68 : 0.38,
        environmentNoise: /咖啡|车站|商场/.test(destination.name) ? 0.62 : 0.25,
      };
      const seed = [...char.id].reduce((sum, value) => sum + value.charCodeAt(0), 0);
      const awareness = evaluateEncounterAwareness(perception, seed);
      participants.push({ ownerType: "character", ownerId: char.id, activity: actor.activity, awarenessByActorId: { player: awareness } });
      participants[0].awarenessByActorId[char.id] = destination.visibility === "public" ? "aware" : "suspects";
    }
    const existingScene = stateRef.current.scenes.find(scene => scene.status === "active" && scene.locationId === destination.id) ?? stateRef.current.scenes.filter(scene => scene.status === "paused" && scene.locationId === destination.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    // Startup may create a placeholder active scene before the user actually enters it. Record the first real entry if this scene has no entry card/timeline record yet.
    const hasRecordedEntry = !!existingScene && (
      stateRef.current.sceneMessages.some(message => message.sceneId === existingScene.id && message.role === "system" && /你来到了|你回到了/.test(message.action || message.dialogue || "")) ||
      stateRef.current.timeline.some(entry => entry.sceneId === existingScene.id && entry.category === "location" && entry.title.startsWith("你来到了"))
    );
    const shouldRecordSceneEntry = !existingScene || existingScene.status === "paused" || !hasRecordedEntry;
    const isFirstSceneEntry = !existingScene || !hasRecordedEntry;
    let next: VirtualLifeState = { ...stateRef.current, scenes: stateRef.current.scenes.map(scene => (scene.status === "active" || scene.status === "paused") ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    const scene: LifeSceneState = existingScene
      ? { ...existingScene, locationId: destination.id, locationName: destination.name, updatedAt: now, status: "active", participants: [{ ...participants[0], activity: playerActivity || "正在这里活动" }, ...existingScene.participants.filter(p => p.ownerType === "character" && participants.some(candidate => candidate.ownerType === "character" && candidate.ownerId === p.ownerId))] }
      : { id: id("scene"), locationId: destination.id, locationName: destination.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    next = upsertActorState(next, { ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "正在这里活动", actualLocationId: destination.id, actualLocationName: destination.name, actualLocationUntil: new Date(resolveActorLifeNow(getActorClock(stateRef.current, "player", PLAYER_ID)).getTime() + stayDurationMinutes * 60_000).toISOString(), updatedAt: now });
    if (shouldRecordSceneEntry) {
      const entryText = isFirstSceneEntry
        ? "你来到了" + destination.name + "。场景从这里开始。"
        : "你回到了" + destination.name + "。先前的场景与互动仍在继续。";
      next = appendLifeTimelineEntry(next, { category: "scene", title: isFirstSceneEntry ? "你进入了" + destination.name : "你回到了" + destination.name, details: entryText, actorId: PLAYER_ID, actorName: "场景旁白", locationName: destination.name, sceneId: scene.id });
      const entryNarration: LifeSceneMessage = { id: id("turn"), sceneId: scene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: "场景旁白", role: "system", action: entryText, dialogue: "", createdAt: now };
      next = { ...next, sceneMessages: [...next.sceneMessages, entryNarration] };
      next = appendLifeTimelineEntry(next, { category: "location", title: "你来到了" + destination.name, details: [playerActivity || "开始探索这个地点", `预计停留 ${stayDurationMinutes} 分钟；到期后自动恢复当前日程地点。`].join(" · "), actorId: PLAYER_ID, actorName: playerName, locationName: destination.name, sceneId: scene.id });
      if (isFirstSceneEntry && actualCharacters.length) next = appendLifeTimelineEntry(next, { category: "scene", title: "在" + destination.name + "遇见了" + actualCharacters.map(char=>char.name).join("、"), actorName: playerName, locationName: destination.name, sceneId: scene.id });
    }
    commit(next);
    if (!actualCharacters.length) {
      setNotice(settings.enableCoincidences ? "你来到了" + destination.name + "。再次打开当前场景不会重复添加记录；点击「暂时离开」后返回才会添加返回旁白。" : "你来到了" + destination.name + "。偶遇功能当前关闭，你可以独自探索这个地点。");
    } else {
      const noticed = participants.filter(p => p.ownerType === "character" && p.awarenessByActorId.player === "aware").length;
      setNotice(noticed ? "你来到了" + destination.name + "，有角色注意到了你。" : "你来到了" + destination.name + "；有人在场，但暂时没人明确注意到你。");
    }
    setSelectedLocationId(destination.id);
    setSelectedCharacterIds(actualCharacters.map(character => character.id));
    setTab("home");
    setSceneView(true);
  };

  const enterLocationSolo = (targetLocationId = selectedLocationId) => {
    const destination = stateRef.current.locations.find(location => location.id === targetLocationId);
    if (!settings.enabled) { setNotice("生活引擎当前已关闭，请先在自定义设置中启用。"); return; }
    if (!destination) return;
    transitionSceneAction(() => performEnterLocationSolo(targetLocationId));
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

  const sceneImageRecords = activeScene?.images ?? [];
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
    const sources: Array<{label:string;dataUrl:string;faceCrop?:{x:number;y:number;size:number}}> = [];
    const playerAsset = imageSettings.userAppearanceReferenceAssetId;
    if(playerAsset && participantIds.includes(PLAYER_ID)) {
      const dataUrl=await getChatImageFromIndexedDB(playerAsset);
      if(dataUrl) sources.push({label:playerName,dataUrl,faceCrop:imageSettings.userAppearanceFaceCrop});
    }
    for(const participantId of participantIds) {
      const ref=imageSettings.characterReferences?.[participantId];
      if(!ref?.assetId||ref.enabled===false)continue;
      const dataUrl=await getChatImageFromIndexedDB(ref.assetId);
      if(dataUrl) sources.push({label:characters.find(char=>char.id===participantId)?.name||"角色",dataUrl,faceCrop:ref.faceCrop});
    }
    if(!sources.length)return undefined;
    const decoded=await Promise.all(sources.map(({label,dataUrl,faceCrop})=>new Promise<{label:string;image:HTMLImageElement;faceCrop?:{x:number;y:number;size:number}}>((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve({label,image,faceCrop});image.onerror=()=>reject(new Error("参考图读取失败"));image.src=dataUrl;
    })));
    const cellW=512,cellH=340,cols=Math.min(2,decoded.length),rows=Math.ceil(decoded.length/cols);
    const canvas=document.createElement("canvas");canvas.width=cols*cellW;canvas.height=rows*cellH;
    const ctx=canvas.getContext("2d");if(!ctx)return undefined;
    ctx.fillStyle="#f7f0e7";ctx.fillRect(0,0,canvas.width,canvas.height);
    decoded.forEach(({label,image,faceCrop},index)=>{
      const x=(index%cols)*cellW,y=Math.floor(index/cols)*cellH;
      if(faceCrop){
        const width=image.naturalWidth||image.width, height=image.naturalHeight||image.height;
        const side=Math.max(1,Math.round(Math.min(width,height)*Math.max(0.18,Math.min(1,faceCrop.size))));
        const sx=Math.max(0,Math.min(width-side,Math.round(faceCrop.x*width)));
        const sy=Math.max(0,Math.min(height-side,Math.round(faceCrop.y*height)));
        const targetSize=Math.min(cellW-32,cellH-58);
        ctx.drawImage(image,sx,sy,side,side,x+(cellW-targetSize)/2,y+8+(cellH-48-targetSize)/2,targetSize,targetSize);
      }else{
        const scale=Math.min((cellW-32)/image.naturalWidth,(cellH-58)/image.naturalHeight);
        const w=image.naturalWidth*scale,h=image.naturalHeight*scale;
        ctx.drawImage(image,x+(cellW-w)/2,y+8+(cellH-48-h)/2,w,h);
      }
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
      participantIds.includes(PLAYER_ID) && imageSettings.userAppearanceReferenceAssetId ? "参考板中标注“"+playerName+"”的图片用于保持玩家本人身份特征；不要把玩家与角色混为一人。" : "",
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
    const participantIds = options?.participantIds ?? (imageParticipantIds.length
      ? imageParticipantIds
      : [
          ...(activeScene.participants.some(participant => participant.ownerType === "player" && participant.ownerId === PLAYER_ID)
            && (imageSettings.userAppearanceReferenceAssetId || imageSettings.userAppearanceDescription?.trim())
            ? [PLAYER_ID]
            : []),
          ...activeScene.participants.filter(participant => participant.ownerType === "character").map(participant => participant.ownerId),
        ]);
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

  const openMessageActions = (message: LifeSceneMessage) => {
    setMessageActionTarget(message);
    setMessageEditDraft(message.dialogue);
    setMessageEditActionDraft(message.action || "");
    setMessageActionMode("menu");
  };

  const clearMessageLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const saveMessageEdit = () => {
    if (!messageActionTarget) return;
    const message = messageActionTarget;
    const dialogue = messageEditDraft.trim();
    const action = messageEditActionDraft.trim();
    const latest = stateRef.current;
    const sceneMessages = latest.sceneMessages.map(item => item.id === message.id ? { ...item, dialogue, action: action || undefined } : item);
    let timeline = latest.timeline
      .filter(entry => !(entry.sourceId === message.id && ((entry.category === "dialogue" && !dialogue) || (entry.category === "action" && !action))))
      .map(entry => {
        if (entry.sourceId !== message.id) return entry;
        if (entry.category === "dialogue") return { ...entry, title: (message.speakerName || playerName) + "说", details: dialogue };
        if (entry.category === "action") return { ...entry, title: (message.speakerName || playerName) + "的行动", details: action };
        return entry;
      });
    let next: VirtualLifeState = { ...latest, sceneMessages, timeline };
    const locationName = latest.scenes.find(scene => scene.id === message.sceneId)?.locationName;
    if (dialogue && !timeline.some(entry => entry.sourceId === message.id && entry.category === "dialogue")) {
      next = appendLifeTimelineEntry(next, { category: "dialogue", title: (message.speakerName || playerName) + "说", details: dialogue, actorId: message.speakerId, actorName: message.speakerName || playerName, locationName, sceneId: message.sceneId, sourceId: message.id });
      timeline = next.timeline;
    }
    if (action && !timeline.some(entry => entry.sourceId === message.id && entry.category === "action")) {
      next = appendLifeTimelineEntry(next, { category: "action", title: (message.speakerName || playerName) + "的行动", details: action, actorId: message.speakerId, actorName: message.speakerName || playerName, locationName, sceneId: message.sceneId, sourceId: message.id });
    }
    commit(next);
    setMessageActionTarget(null);
    setNotice("消息已保存，生活时间线也已同步。");
  };

  const deleteSceneMessage = () => {
    if (!messageActionTarget) return;
    const message = messageActionTarget;
    const latest = stateRef.current;
    commit({
      ...latest,
      sceneMessages: latest.sceneMessages.filter(item => item.id !== message.id),
      timeline: latest.timeline.filter(entry => entry.sourceId !== message.id),
    });
    setMessageActionTarget(null);
    setNotice("消息及其对应的生活时间线记录已删除。");
  };

  const regenerateSceneMessage = async (message: LifeSceneMessage) => {
    const latestAtStart = stateRef.current;
    let targetMessage = message;
    if (message.role === "player") {
      const playerIndex = latestAtStart.sceneMessages.findIndex(item => item.id === message.id);
      targetMessage = latestAtStart.sceneMessages.slice(playerIndex + 1).find(item =>
        item.sceneId === message.sceneId && item.role === "character"
        && !latestAtStart.sceneMessages.slice(playerIndex + 1, latestAtStart.sceneMessages.indexOf(item)).some(previous => previous.sceneId === message.sceneId && previous.role === "player")
      ) as LifeSceneMessage;
      if (!targetMessage) {
        setNotice("这条玩家输入后面还没有角色回复，先发送一次互动再重新生成。");
        return;
      }
    } else if (message.role !== "character") {
      setNotice("系统记录可以编辑或删除；重新生成需要选中玩家输入或角色回复。");
      return;
    }
    const character = characters.find(item => item.id === targetMessage.speakerId);
    const contact = loadChatContacts().find(item => item.characterId === targetMessage.speakerId);
    const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup);
    const scene = stateRef.current.scenes.find(item => item.id === targetMessage.sceneId);
    if (!character || !session || !scene) {
      setNotice("找不到角色聊天会话或原场景，暂时无法重新生成。");
      return;
    }
    const sceneIndex = stateRef.current.sceneMessages.findIndex(item => item.id === targetMessage.id);
    const previousPlayer = message.role === "player"
      ? message
      : stateRef.current.sceneMessages.slice(0, sceneIndex).reverse().find(item => item.sceneId === targetMessage.sceneId && item.role === "player");
    if (!previousPlayer) {
      setNotice("找不到这条回复对应的玩家输入，无法重新生成。");
      return;
    }
    setBusy(true);
    setMessageActionTarget(null);
    try {
      const previous = loadChatMessages(session.id, 12).filter(item => item.status !== "failed" && !item.isRetracted);
      const sceneContext = buildLifeScenePromptContext(stateRef.current, scene, character.id);
      const prompt: ChatMessage = {
        id: id("life-regenerate"), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
        content: [
          "【仅本轮使用生活场景模式规则，不要写入线上聊天历史】",
          activeSceneOutputPrompt,
          settings.showActionNarration ? "动作旁白单独一行，使用 *动作* 格式；对白只写说出口的话。" : "不要输出动作旁白，只输出角色说出口的话。",
          settings.keepDialogueConcise ? "一轮通常 1-3 句，保持实时互动感。" : "允许适度展开，但保持实时互动感。",
          activePromptPresetText ? "小手机预设继承内容与当前生活预设规则：\n" + activePromptPresetText : "",
          activePromptPreset.locationHabitPrompt ? "地点习惯规则：\n" + activePromptPreset.locationHabitPrompt : "",
          settings.customPrompt ? "用户自定义规则：" + settings.customPrompt : "",
          sceneContext,
          "玩家行动：" + (previousPlayer.action || "无"),
          "玩家对白：" + (previousPlayer.dialogue || "无"),
          (activePromptPreset.sceneTaskPrompt?.trim() || "请重新生成{characterName}对这条输入的自然回应。只生成角色回应，不要重复玩家内容。").replace(/\{characterName\}/g, character.name).replace(/\{playerName\}/g, playerName).replace(/\{locationName\}/g, scene.locationName),
        ].filter(Boolean).join("\n"),
      };
      const result = await generateOfflineChatCompletion(session, [...previous, prompt]);
      const parsed = parseLifeOutput(result.content);
      const latest = stateRef.current;
      const sceneMessages = latest.sceneMessages.map(item => item.id === targetMessage.id
        ? { ...item, action: settings.showActionNarration ? parsed.action : undefined, dialogue: parsed.dialogue, createdAt: new Date().toISOString() }
        : item);
      let next: VirtualLifeState = {
        ...latest,
        sceneMessages,
        timeline: latest.timeline.filter(entry => !(entry.sourceId === targetMessage.id && (entry.category === "action" || entry.category === "dialogue"))),
      };
      if (settings.showActionNarration && parsed.action) {
        next = appendLifeTimelineEntry(next, { category: "action", title: character.name + "的行动", details: parsed.action, actorId: character.id, actorName: character.name, locationName: scene.locationName, sceneId: scene.id, sourceId: targetMessage.id });
      }
      if (parsed.dialogue.trim()) {
        next = appendLifeTimelineEntry(next, { category: "dialogue", title: character.name + "说", details: parsed.dialogue, actorId: character.id, actorName: character.name, locationName: scene.locationName, sceneId: scene.id, sourceId: targetMessage.id });
      }
      commit(next);
      setNotice("角色回复已重新生成，生活时间线也已同步。");
    } catch (error) {
      setNotice(error instanceof Error ? "重新生成失败：" + error.message : "重新生成失败，请检查模型配置。");
    } finally {
      setBusy(false);
    }
  };

  const handleMessageAction = (action: "edit" | "delete" | "regenerate") => {
    if (!messageActionTarget) return;
    if (action === "edit") {
      setMessageEditDraft(messageActionTarget.dialogue);
      setMessageEditActionDraft(messageActionTarget.action || "");
      setMessageActionMode("edit");
    } else if (action === "delete") {
      setMessageActionMode("delete-confirm");
    } else {
      void regenerateSceneMessage(messageActionTarget);
    }
  };

  const pushSceneMessage = (message: LifeSceneMessage) => {
    const latest = stateRef.current;
    const currentScene = latest.scenes.find(scene => scene.id === message.sceneId);
    const updatedScene = currentScene ? { ...currentScene, updatedAt: new Date().toISOString() } : null;
    let next = { ...latest, sceneMessages: [...latest.sceneMessages, message] };
    if (updatedScene) next = upsertLifeScene(next, updatedScene);
    const actorName = message.speakerName || (message.role === "player" ? playerName : "生活记录");
    if (message.role === "system") {
      const sceneRecordText = message.action || message.dialogue;
      next = appendLifeTimelineEntry(next, { category: "scene", title: sceneRecordText.slice(0, 100), details: sceneRecordText, actorName, locationName: currentScene?.locationName, sceneId: message.sceneId, sourceId: message.id });
    } else {
      if (message.action) {
        next = appendLifeTimelineEntry(next, { category: "action", title: actorName + (message.role === "player" ? "进行了行动" : "的行动"), details: message.action, actorId: message.speakerId, actorName, locationName: currentScene?.locationName, sceneId: message.sceneId, sourceId: message.id });
      }
      if (message.dialogue.trim()) {
        next = appendLifeTimelineEntry(next, { category: "dialogue", title: actorName + (message.role === "player" ? "说" : "说"), details: message.dialogue, actorId: message.speakerId, actorName, locationName: currentScene?.locationName, sceneId: message.sceneId, sourceId: message.id });
      }
    }
    commit(next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("life-scene-message-added"));
  };

  // Foreground life-scene autonomy plus a server snapshot as a background/terminated-app fallback.
  // When the app is visible, local scene generation wins and cancels the queued server turn.
  useEffect(() => {
    if (!ready || !settings.enabled || !settings.enableCharacterAutonomy || settings.enableProactiveSceneMessages === false || !activeScene || activeScene.status !== "active" || !immersiveScene) return;
    let disposed = false;
    const minIntervalMinutes = Math.max(2, Math.min(60, settings.proactiveSceneIntervalMinutes ?? 5));
    const maxIntervalMinutes = Math.max(minIntervalMinutes, Math.min(60, settings.proactiveSceneIntervalMaxMinutes ?? 15));
    const getRandomIntervalMs = () => (minIntervalMinutes + Math.floor(Math.random() * (maxIntervalMinutes - minIntervalMinutes + 1))) * 60_000;
    const candidateIds = [...new Set(activeScene.participants
      .filter(participant => participant.ownerType === "character" && participant.ownerId && participant.activity !== "离开")
      .map(participant => participant.ownerId))];
    const buildPrompt = (character: Character): string => {
      const sceneContext = buildLifeScenePromptContext(stateRef.current, activeScene, character.id);
      return [
        "【生活现场自主回合：不是对玩家新消息的回复】",
        activeSceneOutputPrompt,
        settings.showActionNarration ? "动作旁白与角色对白必须严格分开。" : "只输出角色实际说出口的对白。",
        settings.keepDialogueConcise ? "保持自然简短，像真实相处时的一小句或一个小动作。" : "可以适度展开，但不要写成长篇故事。",
        "当前没有新的玩家输入。请结合角色正在做的事、性格、地点习惯、最近发生的事情和场景气氛，自主判断是否有自然的发言或行动动机。可以主动搭话、分享正在做的事、提出轻微互动，也可以继续忙自己的事或保持沉默。不要为了触发功能强行说话；不要替玩家行动或发言；不要重复上一条内容。",
        activePromptPresetText,
        activePromptPreset.sceneBehaviorPrompt || "",
        activePromptPreset.locationHabitPrompt || "",
        settings.customPrompt || "",
        sceneContext,
        (activePromptPreset.sceneTaskPrompt?.trim() || "请生成{characterName}此刻自然、自主的一小回合。没有值得说的话时，动作和对白都可以留空。")
          .replace(/\{characterName\}/g, character.name)
          .replace(/\{playerName\}/g, playerName)
          .replace(/\{locationName\}/g, activeScene.locationName),
      ].filter(Boolean).join("\n\n");
    };
    const pickCandidate = () => {
      const lastSceneSpeaker = [...stateRef.current.sceneMessages].reverse().find(message => message.sceneId === activeScene.id && message.role === "character")?.speakerId;
      const speakerId = chooseLifeAutonomyCharacter(
        candidateIds,
        proactiveLastSpeakerRef.current[activeScene.id] || lastSceneSpeaker,
        stateRef.current.sceneMessages,
        activeScene.id,
      );
      const character = characters.find(item => item.id === speakerId);
      if (!character) return null;
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup);
      return session ? { character, session } : null;
    };
    const armOfflineBailout = async () => {
      if (disposed || settings.enableLifeOfflinePush === false) return;
      await cancelLifeSceneProactiveBailouts(activeScene.id);
      const candidate = pickCandidate();
      if (!candidate) return;
      const result = await armLifeSceneProactiveBailout({
        sessionId: candidate.session.id,
        sceneId: activeScene.id,
        characterId: candidate.character.id,
        characterName: candidate.character.name,
        prompt: buildPrompt(candidate.character),
        // Give the foreground 1-2 ticks to cancel and take over before the server runs.
        executeAtMs: Date.now() + getRandomIntervalMs() + LIFE_AUTONOMY_TICK_MS * 2,
      });
      if (!result.ok && result.reason !== "当前账号没有可用的离线推送订阅" && result.reason !== "当前环境不支持服务端离线预约") {
        console.debug("[LifeAutonomy] background fallback not armed:", result.reason);
      }
    };
    const tick = async () => {
      if (disposed || document.visibilityState !== "visible" || busyRef.current || proactiveBusyRef.current) return;
      const now = Date.now();
      const previousAttempt = proactiveAttemptAtRef.current[activeScene.id];
      if (previousAttempt == null) {
        proactiveAttemptAtRef.current[activeScene.id] = now;
        proactiveNextAtRef.current[activeScene.id] = now + getRandomIntervalMs();
        return;
      }
      const nextAllowedAt = proactiveNextAtRef.current[activeScene.id];
      if (nextAllowedAt != null && now < nextAllowedAt) return;
      const decision = evaluateLifeAutonomyWindow({
        scene: activeScene, playerId: PLAYER_ID, messages: stateRef.current.sceneMessages, now,
        lastAttemptAt: previousAttempt, intervalMinutes: settings.proactiveSceneIntervalMinutes ?? 5,
        busy: busyRef.current, visible: document.visibilityState === "visible",
        enabled: settings.enableProactiveSceneMessages !== false && settings.enableCharacterAutonomy,
      });
      if (!decision.eligible) return;
      const candidate = pickCandidate();
      if (!candidate) return;
      const { character, session } = candidate;
      proactiveAttemptAtRef.current[activeScene.id] = now;
      proactiveNextAtRef.current[activeScene.id] = now + getRandomIntervalMs();
      proactiveLastSpeakerRef.current[activeScene.id] = character.id;
      proactiveBusyRef.current = true;
      await cancelLifeSceneProactiveBailouts(activeScene.id);
      setBusy(true);
      try {
        const history = loadChatMessages(session.id, 10).filter(item => item.status !== "failed" && !item.isRetracted);
        const proactivePrompt: ChatMessage = {
          id: id("life-autonomy"), sessionId: session.id, role: "user", status: "sent",
          createdAt: new Date().toISOString(), content: buildPrompt(character),
        };
        const result = await generateOfflineChatCompletion(session, [...history, proactivePrompt]);
        if (disposed) return;
        const parsed = parseLifeOutput(result.content);
        if (!parsed.action?.trim() && !parsed.dialogue.trim()) return;
        const message: LifeSceneMessage = {
          id: id("life-proactive"), sceneId: activeScene.id, speakerType: "character",
          speakerId: character.id, speakerName: character.name, role: "character",
          action: settings.showActionNarration ? parsed.action?.trim() || undefined : undefined,
          dialogue: parsed.dialogue.trim(), createdAt: new Date().toISOString(),
        };
        pushSceneMessage(message);
        const body = [message.action, message.dialogue].filter(Boolean).join(" ");
        if (settings.enableLifeMessageNotifications !== false) {
          setSceneToast({ title: character.name + "主动说话了", body });
          notifyLifeSceneMessage(character.name + " · 生活现场", body, () => setTab("scene"));
          window.setTimeout(() => setSceneToast(current => current?.body === body ? null : current), 6500);
        }
      } catch (error) {
        console.warn("[LifeAutonomy] proactive scene turn failed:", error);
      } finally {
        proactiveBusyRef.current = false;
        if (!disposed) {
          setBusy(false);
          void armOfflineBailout();
        }
      }
    };
    const onSceneMessageAdded = () => {
      // The proactive loop re-arms once in finally; don't race a second job against it.
      if (proactiveBusyRef.current) return;
      // A manual player/character turn invalidates the old snapshot; replace it with fresh context.
      void armOfflineBailout();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        cancelLifeSceneProactiveBailouts(activeScene.id);
        void tick();
      } else {
        void armOfflineBailout();
      }
    };
    // Clear any locally scheduled online-chat follow-up for characters currently in this scene.
    for (const characterId of candidateIds) {
      const contact = loadChatContacts().find(item => item.characterId === characterId);
      const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup);
      if (session) cancelFollowUp(session.id);
    }
    void suspendIdleReconnectForLifeScene(candidateIds);
    void armOfflineBailout();
    const timer = window.setInterval(() => void tick(), LIFE_AUTONOMY_TICK_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("life-scene-message-added", onSceneMessageAdded);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("life-scene-message-added", onSceneMessageAdded);
      const latestSettings = stateRef.current.settings;
      const latestScene = stateRef.current.scenes.find(scene => scene.id === activeScene.id);
      // Keep the snapshot on ordinary page close/backgrounding, but cancel it when the
      // scene ends or the user explicitly disables proactive/offline behavior.
      if (!latestScene || latestScene.status !== "active" || !latestSettings.enabled
        || !latestSettings.enableCharacterAutonomy || latestSettings.enableProactiveSceneMessages === false
        || latestSettings.enableLifeOfflinePush === false) {
        cancelLifeSceneProactiveBailouts(activeScene.id);
      }
      // Refresh rules against the latest persisted scene state. The co-presence guard
      // keeps idle reconnect suspended while this scene remains active.
      void refreshScheduledBailouts();
    };
  }, [ready, settings.enabled, settings.enableCharacterAutonomy, settings.enableProactiveSceneMessages, settings.enableLifeOfflinePush, settings.proactiveSceneIntervalMinutes, settings.proactiveSceneIntervalMaxMinutes, settings.showActionNarration, settings.keepDialogueConcise, settings.customPrompt, activeScene?.id, activeScene?.status, activeScene?.locationId, activeScene?.participants.map(participant => participant.ownerType + ":" + participant.ownerId + ":" + participant.activity).join("|"), immersiveScene, characters, activeSceneOutputPrompt, activePromptPresetText, activePromptPreset.sceneBehaviorPrompt, activePromptPreset.locationHabitPrompt, activePromptPreset.sceneTaskPrompt, playerName]);
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
        activeSceneOutputPrompt,
        settings.showActionNarration ? "动作旁白要短，单独一行使用 *动作* 格式；对白只写说出口的话。" : "不要输出动作旁白，只输出角色说出口的话。",
        settings.keepDialogueConcise ? "一轮通常 1-3 句，除非用户明确要求展开。" : "允许适度展开，但仍保持实时互动感。",
        settings.allowCharactersToStaySilent ? "如果角色当下忙碌、没注意到或不想说话，可以自然沉默。" : "本轮需要对玩家的输入作出回应。",
        wokeFromSleep ? "角色原本正在睡觉，本轮是被消息或紧急情况吵醒；要表现困倦、反应迟缓或不想立刻长谈，不要突然精神饱满。" : "",
        settings.enableAmbientDetails ? "可以用一两笔简短环境细节营造现场感，不要扩写成长篇旁白。" : "不需要环境氛围描写，直接进行实时互动。",
        settings.enableCharacterAutonomy ? (activePromptPreset.toolCallingPrompt?.trim() || [
          "你可以按需调用下列已启用的生活工具，通过隐藏标签调用，不要向玩家解释标签。",
          settings.enableScheduleChangeTool ? "change_schedule：<life_plan_change startAt=\"ISO-8601开始时间\" endAt=\"ISO-8601结束时间\" title=\"新的安排\" locationId=\"home\" />。只调整当前虚拟日未来时段，保留前后日程，不覆盖确认约会。" : "",
          settings.enableInvitations ? "propose_invitation：<life_invitation time=\"ISO-8601时间\" locationId=\"cafe\" activity=\"活动\" durationMinutes=\"60\" />。这是待确认邀约，玩家确认后才同步日程。" : "",
          settings.enableFollowRequestTool ? "request_follow：<life_follow_request durationMinutes=\"120\" reason=\"简短原因\" />。需要玩家确认，可被拒绝。" : "",
          "每轮最多调用一个工具，仅在角色有真实动机时调用，不要为了展示功能调用。"
        ].filter(Boolean).join(" ")) : "角色自主行动工具已关闭，不要输出生活工具标签.",
        activePromptPresetText ? `小手机预设继承内容与当前生活预设规则：\n${activePromptPresetText}` : "",
        activePromptPreset.locationHabitPrompt ? `地点习惯规则：\n${activePromptPreset.locationHabitPrompt}` : "",
        settings.customPrompt ? `用户自定义规则：${settings.customPrompt}` : "",
      ].filter(Boolean).join("\n");
      const promptMessage: ChatMessage = {
        id: id("life-user"), sessionId: session.id, role: "user", status: "sent", createdAt: now,
        content: `[仅本轮使用生活场景模式规则，不要写入线上聊天历史]\n${settingsInstructions}\n\n${sceneContext}\n\n玩家本轮行动：${userAction || "（没有额外动作）"}\n玩家本轮对白：${userText || "（没有说话）"}\n${(activePromptPreset.sceneTaskPrompt?.trim() || "请让{characterName}按其既有人设自然回应。行动与对白分开处理；玩家只行动时，不要擅自替玩家补台词。").replace(/\{characterName\}/g, target.name).replace(/\{playerName\}/g, playerName).replace(/\{locationName\}/g, activeScene.locationName)}`,
      };
      const result = await generateOfflineChatCompletion(session, [...previous, promptMessage]);
      const parsed = parseLifeOutput(result.content);
      let structuredNext = stateRef.current;
      if (settings.enableCharacterAutonomy && settings.enableScheduleChangeTool && parsed.planChange?.title) {
        const startText = String(parsed.planChange.startAt ?? "");
        const endText = String(parsed.planChange.endAt ?? "");
        const changed = applyCharacterLifeScheduleChange(structuredNext, target.id, {
          startAt: startText,
          endAt: endText,
          title: parsed.planChange.title,
          locationId: parsed.planChange.locationId,
        });
        if (changed.error) {
          setNotice(target.name + "想调整日程，但" + changed.error);
        } else {
          const startAt = new Date(startText);
          const endAt = new Date(endText);
          const location = changed.state.locations.find(item => item.id === parsed.planChange?.locationId);
          structuredNext = appendLifeTimelineEntry(changed.state, {
            category: "schedule",
            title: target.name + "调整了日程：" + parsed.planChange.title,
            details: startText + " – " + endText,
            actorId: target.id,
            actorName: target.name,
            locationName: location?.name,
            occurredAt: resolveActorLifeNow(getActorClock(changed.state, "character", target.id)).toISOString(),
          });
          setNotice(target.name + "调整了今天 " + startAt.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) + " 至 " + endAt.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) + " 的日程，其他时段保持不变。");
        }
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
            locationId: location?.id, locationName: location?.name, activity: parsed.invitation.activity, reason: parsed.invitation.reason || undefined,
            kind: "appointment", durationMinutes: parsed.invitation.durationMinutes,
          });
          setNotice(target.name+"主动提出邀约。请在「邀约活动」中确认、拒绝或调整；未确认前不会更改日程。");
        } else {
          setNotice(target.name+"提出的邀约时间无效或已经过去，因此没有写入日程。");
        }
      }
      if (settings.enableCharacterAutonomy && settings.enableFollowRequestTool && parsed.followRequest) {
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
    const location: LifeLocation = { id: id("place"), name, description: "一个由你定义、可持续探索的地点。", atmosphere: "", layout: "", props: [], visibility: "public" };
    let next = { ...stateRef.current, locations: [...stateRef.current.locations, location] };
    next = appendLifeTimelineEntry(next, { category: "location", title: "创建了新地点：" + location.name, actorName: playerName, locationName: location.name });
    commit(next);
    setSelectedLocationId(location.id);
    setNewLocationName("");
  };

  const saveCharacterLocationHabit = (characterId: string) => {
    if (!selectedLocation) return;
    const habit = (locationHabitDrafts[characterId] ?? "").trim();
    const current = stateRef.current;
    const next = { ...current, locations: current.locations.map(location => {
      if (location.id !== selectedLocation.id) return location;
      const characterHabits = { ...(location.characterHabits ?? {}) };
      if (habit) characterHabits[characterId] = habit;
      else delete characterHabits[characterId];
      return { ...location, characterHabits };
    }) };
    commit(next);
    setNotice(habit ? `已保存角色在「${selectedLocation.name}」的地点习惯。` : "已清除该角色在此地点的自定义习惯。");
  };
  const selectLifePromptPreset = (presetId: string) => {
    const currentSettings = stateRef.current.settings;
    let presets = [...(currentSettings.promptPresets ?? [])];
    if (!presets.some(preset => preset.id === presetId)) presets = [{ id: presetId, name: "生活现场默认预设" }, ...presets];
    commit({ ...stateRef.current, settings: { ...currentSettings, promptPresets: presets, activePromptPresetId: presetId } });
  };
  const saveLocationDetails = () => {
    if (!selectedLocation) return;
    const next = {
      ...stateRef.current,
      locations: stateRef.current.locations.map(location => location.id !== selectedLocation.id ? location : {
        ...location,
        description: locationDescriptionDraft.trim(),
        atmosphere: locationAtmosphereDraft.trim(),
        layout: locationLayoutDraft.trim(),
        props: [...new Set(locationPropsDraft.split(/[、,，;；\n]/).map(prop => prop.trim()).filter(Boolean))],
      }),
    };
    commit(next);
    setNotice(`已保存「${selectedLocation.name}」的环境描写、空间布局与道具；后续场景互动会读取这些设定。`);
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
    let next = makeLifeInvitation(base, {
      proposedBy: "player",
      characterId: character.id, playerId: PLAYER_ID, proposedAt: proposedAt.toISOString(),
      locationId: location?.id, locationName: location?.name, activity: inviteActivity.trim(), reason: inviteReason.trim() || undefined,
      kind: "appointment", durationMinutes: 60,
    });
    const invitation = next.invitations[0];
    next = appendLifeTimelineEntry(next, { category: "schedule", title: "你向" + character.name + "发起邀约", details: inviteActivity.trim() + " · " + proposedAt.toLocaleString("zh-CN") + (location?.name ? " · " + location.name : ""), actorId: PLAYER_ID, actorName: playerName, locationName: location?.name, sourceId: invitation.id });
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
          `邀约理由：${inviteReason.trim() || "未填写"}`,
          activePromptPreset.invitationResponsePrompt?.trim() || "请根据你的人设、当前日程、关系和真实意愿，自主决定接受或拒绝。不要让玩家替你确认；不要为了讨好玩家而默认接受。",
          activePromptPresetText ? "小手机预设补充规则：\n" + activePromptPresetText : "",
          settings.customPrompt ? "用户自定义规则：" + settings.customPrompt : "",
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
          const logged = appendLifeTimelineEntry(confirmedState, { category: "schedule", title: character.name + "接受了你的邀约", details: invitation.activity + (reason ? " · " + reason : ""), actorId: character.id, actorName: character.name, locationName: invitation.locationName, sourceId: invitation.id });
          commit(logged);
          setNotice(`${character.name}答应了这次邀约。${reason ? " TA 的回应：" + reason : ""}`);
        } else {
          commit({ ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: resolution.notice, updatedAt: new Date().toISOString() } : item) });
          setNotice(`${character.name}愿意赴约，但排期未能成立：${resolution.notice}`);
        }
      } else {
        const declineReason = reason || (decision === "decline" ? "角色决定这次不赴约。" : "角色没有明确答应这次邀约，因此没有替 TA 自动确认。");
        let declinedState = { ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: declineReason, updatedAt: new Date().toISOString() } : item) };
        declinedState = appendLifeTimelineEntry(declinedState, { category: "schedule", title: character.name + "拒绝了你的邀约", details: invitation.activity + " · " + declineReason, actorId: character.id, actorName: character.name, locationName: invitation.locationName, sourceId: invitation.id });
        commit(declinedState);
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
    const conflict = base.schedules.find(slot => relevantOwners.has(slot.ownerId) && ((slot.ownerType === "player" && invite.kind !== "follow-request" && slot.ownerId === PLAYER_ID) || (slot.ownerType === "character" && slot.ownerId === invite.characterId)) && (slot.kind === "appointment" || slot.source === "event") && new Date(slot.startAt) < endsAt && new Date(slot.endAt) > startsAt);
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
    const base = stateRef.current;
    const result = resolveInvitationConfirmation(base, inviteId);
    if (!result.ok) { setNotice(result.notice); return; }
    const invite = base.invitations.find(item => item.id === inviteId);
    const character = invite ? characters.find(item => item.id === invite.characterId) : undefined;
    const logged = invite ? appendLifeTimelineEntry(result.state, {
      category: "schedule",
      title: invite.kind === "follow-request" ? (character?.name ?? "角色") + "的陪伴申请已被接受" : (character?.name ?? "角色") + "的邀约已确认",
      details: invite.activity + " · " + new Date(invite.proposedAt).toLocaleString("zh-CN"),
      actorId: invite.characterId, actorName: character?.name ?? "角色", locationName: invite.locationName, sourceId: invite.id,
    }) : result.state;
    commit(logged);
    setNotice(result.notice);
  };

  const beginEditInvitation = (inviteId: string) => {
    const invite = stateRef.current.invitations.find(item => item.id === inviteId);
    if (!invite || !["proposed", "confirmed"].includes(invite.status)) return;
    const localDate = new Date(invite.proposedAt);
    const localValue = Number.isFinite(localDate.getTime())
      ? new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      : "";
    setEditingInvitationId(invite.id);
    setEditInvitationDraft({
      activity: invite.activity,
      reason: invite.reason ?? "",
      proposedAt: localValue,
      locationId: invite.locationId ?? stateRef.current.locations.find(location => location.name === invite.locationName)?.id ?? stateRef.current.locations[0]?.id ?? "",
      durationMinutes: String(invite.durationMinutes ?? 60),
    });
  };

  const saveInvitationEdit = (inviteId: string) => {
    const current = stateRef.current;
    const invite = current.invitations.find(item => item.id === inviteId);
    if (!invite || !["proposed", "confirmed"].includes(invite.status)) return;
    const activity = editInvitationDraft.activity.trim();
    const start = new Date(editInvitationDraft.proposedAt);
    const duration = Math.max(15, Math.min(1440, Number(editInvitationDraft.durationMinutes) || 60));
    const end = new Date(start.getTime() + duration * 60_000);
    const location = current.locations.find(item => item.id === editInvitationDraft.locationId);
    if (!activity || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      setNotice("请填写有效的活动内容和时间。原邀约没有改变。");
      return;
    }
    const playerNow = resolveActorLifeNow(getActorClock(current, "player", PLAYER_ID));
    const characterNow = resolveActorLifeNow(getActorClock(current, "character", invite.characterId));
    if (start <= playerNow || start <= characterNow) {
      setNotice("新时间必须晚于你和角色各自的当前虚拟时间。原邀约没有改变。");
      return;
    }
    const linkedEvent = invite.status === "confirmed"
      ? current.events.find(event => event.id === invite.eventId && event.kind === "invitation")
      : undefined;
    if (invite.status === "confirmed" && !linkedEvent) {
      setNotice("找不到这条已确认邀约对应的日程事件，未修改任何内容。");
      return;
    }
    const linkedPrefix = linkedEvent ? "invite-slot-" + linkedEvent.id + "-" : "";
    const linkedSlots = linkedPrefix ? current.schedules.filter(slot => slot.id.startsWith(linkedPrefix)) : [];
    const linkedIds = new Set(linkedSlots.map(slot => slot.id));
    const ownerIds = invite.kind === "follow-request" ? [invite.characterId] : [PLAYER_ID, invite.characterId];
    for (const ownerId of ownerIds) {
      const ownerType: LifeOwnerType = ownerId === PLAYER_ID ? "player" : "character";
      const conflict = current.schedules.find(slot =>
        slot.ownerId === ownerId && slot.ownerType === ownerType && !linkedIds.has(slot.id)
        && new Date(slot.startAt).getTime() < end.getTime()
        && new Date(slot.endAt).getTime() > start.getTime()
        && (slot.kind === "appointment" || slot.source === "manual" || slot.source === "event" || slot.source === "character-tool")
      );
      if (conflict) {
        setNotice("新时间与「" + conflict.title + "」冲突。原邀约和双方日程均未改变。");
        return;
      }
    }
    const now = new Date().toISOString();
    const updatedInvitation = {
      ...invite,
      activity,
      reason: editInvitationDraft.reason.trim() || undefined,
      proposedAt: start.toISOString(),
      durationMinutes: duration,
      locationId: invite.kind === "follow-request" ? undefined : location?.id,
      locationName: invite.kind === "follow-request" ? undefined : location?.name,
      updatedAt: now,
      ...(invite.status === "confirmed" ? { responseReason: (invite.responseReason ? invite.responseReason + " · " : "") + "邀约内容已由用户调整。" } : {}),
    };
    let next: VirtualLifeState = {
      ...current,
      invitations: current.invitations.map(item => item.id === invite.id ? updatedInvitation : item),
    };
    if (linkedEvent) {
      next = {
        ...next,
        events: next.events.map(event => event.id === linkedEvent.id ? {
          ...event, startsAt: start.toISOString(), endsAt: end.toISOString(), title: activity,
          locationId: invite.kind === "follow-request" ? undefined : location?.id,
          locationName: invite.kind === "follow-request" ? undefined : location?.name,
          updatedAt: now,
        } : event),
        schedules: next.schedules.filter(slot => !linkedIds.has(slot.id)),
      };
      for (const ownerId of ownerIds) {
        const ownerType: LifeOwnerType = ownerId === PLAYER_ID ? "player" : "character";
        const slot: LifeScheduleSlot = {
          id: "invite-slot-" + linkedEvent.id + "-" + ownerType + "-" + ownerId,
          ownerType, ownerId, startAt: start.toISOString(), endAt: end.toISOString(),
          title: invite.kind === "follow-request" ? "陪伴玩家并跟随其行程" : activity,
          kind: "appointment", source: "event",
          plannedLocationId: invite.kind === "follow-request" ? null : location?.id ?? null,
          plannedLocationName: invite.kind === "follow-request" ? "跟随玩家的实际地点" : location?.name ?? null,
          updatedAt: now,
        };
        next = placeAppointmentInActorSchedule(next, slot);
      }
    }
    next = appendLifeTimelineEntry(next, {
      category: "schedule", title: "重新安排邀约：" + activity,
      details: start.toLocaleString("zh-CN") + " · " + (location?.name ?? (invite.kind === "follow-request" ? "跟随玩家" : "地点待定")),
      actorId: invite.characterId, actorName: characters.find(character => character.id === invite.characterId)?.name,
      locationName: location?.name, sourceId: invite.id,
    });
    commit(next);
    setEditingInvitationId(null);
    setNotice(invite.status === "confirmed" ? "邀约已调整，双方日程已同步。请记得把变更告知角色；当前系统不会自动发起第二轮角色同意流程。" : "邀约内容已更新。");
  };

  const cancelInvitation = (inviteId: string) => {
    const current = stateRef.current;
    const invite = current.invitations.find(item => item.id === inviteId && ["proposed", "confirmed"].includes(item.status));
    if (!invite) return;
    const event = invite.status === "confirmed" ? current.events.find(item => item.id === invite.eventId && item.kind === "invitation") : undefined;
    const prefix = event ? "invite-slot-" + event.id + "-" : "";
    const linkedSlots = prefix ? current.schedules.filter(slot => slot.id.startsWith(prefix)) : [];
    const linkedIds = new Set(linkedSlots.map(slot => slot.id));
    const now = new Date().toISOString();
    let next: VirtualLifeState = {
      ...current,
      invitations: current.invitations.map(item => item.id === inviteId ? { ...item, status: "cancelled" as const, updatedAt: now, responseReason: (item.responseReason ? item.responseReason + " · " : "") + "邀约已取消。" } : item),
      events: event ? current.events.map(item => item.id === event.id ? { ...item, status: "cancelled" as const, cancelledAt: now, updatedAt: now } : item) : current.events,
      schedules: current.schedules.filter(slot => !linkedIds.has(slot.id)),
    };
    if (event) {
      const startMs = new Date(event.startsAt ?? invite.proposedAt).getTime();
      const endMs = new Date(event.endsAt ?? (startMs + (invite.durationMinutes ?? 60) * 60_000)).getTime();
      for (const slot of linkedSlots) {
        const occupied = next.schedules.some(other => other.ownerType === slot.ownerType && other.ownerId === slot.ownerId && new Date(other.startAt).getTime() < endMs && new Date(other.endAt).getTime() > startMs);
        if (!occupied && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
          next.schedules = [...next.schedules, {
            id: id("cancelled-invite-free-time"), ownerType: slot.ownerType, ownerId: slot.ownerId,
            startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(),
            title: "自由活动", kind: "free-time", source: "weekly-generation",
            plannedLocationId: slot.plannedLocationId, plannedLocationName: slot.plannedLocationName, updatedAt: now,
          }];
        }
      }
    }
    next = appendLifeTimelineEntry(next, { category: "schedule", title: "取消邀约：" + invite.activity, details: "已取消，不再占用双方的约定时段。", actorId: invite.characterId, locationName: invite.locationName, sourceId: invite.id });
    commit(next);
    setEditingInvitationId(null);
    setNotice("邀约已取消；相关日程已解除占用。");
  };

  const reuseInvitation = (inviteId: string) => {
    const invite = stateRef.current.invitations.find(item => item.id === inviteId);
    if (!invite) return;
    setInviteCharacterId(invite.characterId);
    setInviteActivity(invite.activity);
    setInviteReason(invite.reason ?? "");
    setInviteLocationId(invite.locationId ?? stateRef.current.locations.find(location => location.name === invite.locationName)?.id ?? "cafe");
    const d = new Date(invite.proposedAt);
    if (Number.isFinite(d.getTime())) {
      setInviteAt(new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
      setInviteAtEdited(true);
    }
    setEditingInvitationId(null);
    setNotice("已将这条邀约复制到创建表单。修改时间后即可重新发起。");
  };

  const declineInvitation = (inviteId: string) => {
    const base = stateRef.current;
    const invite = base.invitations.find(item => item.id === inviteId && item.status === "proposed");
    if (!invite) return;
    const character = characters.find(item => item.id === invite.characterId);
    const updated = {
      ...base,
      invitations: base.invitations.map(item => item.id === inviteId
        ? { ...item, status: "declined" as const, responseReason: "你暂时没有接受这项安排。", updatedAt: new Date().toISOString() }
        : item),
    };
    const logged = appendLifeTimelineEntry(updated, {
      category: "schedule",
      title: invite.kind === "follow-request" ? "你拒绝了" + (character?.name ?? "角色") + "的陪伴申请" : "你拒绝了" + (character?.name ?? "角色") + "的邀约",
      details: invite.activity, actorId: PLAYER_ID, actorName: playerName, locationName: invite.locationName, sourceId: invite.id,
    });
    commit(logged);
    setNotice("已记录你的决定，双方日程没有被更改。");
  };

  const updateManualPlan = (slot: LifeScheduleSlot, patch: Partial<Pick<LifeScheduleSlot, "title" | "startAt" | "endAt" | "plannedLocationName">>) => {
    const now = new Date().toISOString();
    const current = stateRef.current;
    const changedLocation = patch.plannedLocationName !== undefined;
    const normalizedLocationName = changedLocation ? patch.plannedLocationName?.trim() ?? "" : slot.plannedLocationName ?? "";
    const matchedLocation = changedLocation
      ? current.locations.find(location => location.name.trim() === normalizedLocationName)
      : undefined;
    const updated: LifeScheduleSlot = {
      ...slot,
      ...patch,
      plannedLocationName: changedLocation ? normalizedLocationName || null : slot.plannedLocationName,
      plannedLocationId: changedLocation ? matchedLocation?.id ?? null : slot.plannedLocationId,
      source: slot.source === "event" ? "event" : "manual",
      updatedAt: now,
    };

    // Confirmed appointments are one shared event represented by multiple
    // participant slots. Editing only one slot would desynchronize the event,
    // the other participant, and the eventual scene/memory.
    const linkedEvent = slot.kind === "appointment" && slot.source === "event"
      ? current.events.find(event =>
          event.kind === "invitation"
          && slot.id.startsWith("invite-slot-" + event.id + "-")
        )
      : undefined;
    if (slot.kind === "appointment" && slot.source === "event" && !linkedEvent) {
      setNotice("找不到这条日程关联的邀约，未修改任何内容。");
      return;
    }
    if (linkedEvent) {
      const startMs = new Date(updated.startAt).getTime();
      const endMs = new Date(updated.endAt).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        setNotice("日程时间无效，结束时间必须晚于开始时间。已保留原日程。");
        return;
      }
      const eventSlotPrefix = "invite-slot-" + linkedEvent.id + "-";
      const linkedSlots = current.schedules.filter(item => item.id.startsWith(eventSlotPrefix));
      const linkedSlotIds = new Set(linkedSlots.map(item => item.id));
      const keepFollowLocation = linkedEvent.details === "follow-player";
      const expectedOwnerIds = linkedEvent.participantIds.filter(ownerId => !keepFollowLocation || ownerId !== PLAYER_ID);
      // Repair a missing participant slot while editing an existing appointment;
      // the shared event must never become a one-sided calendar entry.
      const participantSlots: LifeScheduleSlot[] = expectedOwnerIds.map(ownerId => {
        const ownerType: LifeOwnerType = ownerId === PLAYER_ID ? "player" : "character";
        const existing = linkedSlots.find(item => item.ownerId === ownerId && item.ownerType === ownerType);
        return existing ?? {
          id: eventSlotPrefix + ownerType + "-" + ownerId,
          ownerType,
          ownerId,
          startAt: linkedEvent.startsAt ?? slot.startAt,
          endAt: linkedEvent.endsAt ?? slot.endAt,
          title: keepFollowLocation ? "陪伴玩家并跟随其行程" : linkedEvent.title,
          kind: "appointment",
          source: "event",
          plannedLocationId: keepFollowLocation ? null : linkedEvent.locationId ?? null,
          plannedLocationName: keepFollowLocation ? "跟随玩家的实际地点" : linkedEvent.locationName ?? null,
          updatedAt: now,
        };
      });
      for (const participantSlot of participantSlots) {
        const conflict = current.schedules.find(other =>
          other.ownerType === participantSlot.ownerType
          && other.ownerId === participantSlot.ownerId
          && !linkedSlotIds.has(other.id)
          && new Date(other.startAt).getTime() < endMs
          && new Date(other.endAt).getTime() > startMs
          && (other.kind === "appointment" || other.source === "manual" || other.source === "event" || other.source === "character-tool")
        );
        if (conflict) {
          setNotice("这段时间与「" + conflict.title + "」冲突。已保留原约会和双方日程。");
          return;
        }
      }
      const nextEvent = {
        ...linkedEvent,
        startsAt: updated.startAt,
        endsAt: updated.endAt,
        title: updated.title,
        ...(changedLocation && !keepFollowLocation
          ? { locationId: matchedLocation?.id, locationName: normalizedLocationName || undefined }
          : {}),
        updatedAt: now,
      };
      let next: VirtualLifeState = {
        ...current,
        events: current.events.map(event => event.id === linkedEvent.id ? nextEvent : event),
        invitations: current.invitations.map(invitation => invitation.eventId === linkedEvent.id
          ? {
              ...invitation,
              proposedAt: updated.startAt,
              durationMinutes: Math.max(15, Math.min((endMs - startMs) / 60_000, 24 * 60)),
              activity: updated.title,
              ...(changedLocation && !keepFollowLocation
                ? { locationId: matchedLocation?.id, locationName: normalizedLocationName || undefined }
                : {}),
              updatedAt: now,
            }
          : invitation),
        schedules: current.schedules.filter(item => !linkedSlotIds.has(item.id)),
      };
      const slotsToUpdate: LifeScheduleSlot[] = participantSlots;
      for (const original of slotsToUpdate) {
        const nextSlot: LifeScheduleSlot = {
          ...original,
          title: updated.title,
          startAt: updated.startAt,
          endAt: updated.endAt,
          plannedLocationId: keepFollowLocation ? null : updated.plannedLocationId,
          plannedLocationName: keepFollowLocation ? "跟随玩家的实际地点" : updated.plannedLocationName,
          kind: "appointment",
          source: "event",
          updatedAt: now,
        };
        next = placeAppointmentInActorSchedule(next, nextSlot);
      }
      commit(next);
      return;
    }

    // Editing a plan must not leave a hole behind when its start/end moves.
    // Temporarily restore the old interval as free time, then let the insertion
    // helper split that filler wherever the edited plan overlaps it.
    const restoredOldInterval: LifeScheduleSlot = {
      ...slot,
      id: id("edited-plan-free-time"),
      title: "自由活动",
      kind: "free-time",
      source: "weekly-generation",
      updatedAt: now,
    };
    const withoutEditedSlot = {
      ...current,
      schedules: [
        ...current.schedules.filter(item => item.id !== slot.id),
        restoredOldInterval,
      ],
    };
    const inserted = insertManualLifeScheduleSlot(withoutEditedSlot, updated);
    if (inserted.conflict) {
      setNotice("这段时间与「" + inserted.conflict.title + "」冲突。已保留原日程，请调整时间后再试。");
      return;
    }
    if (inserted.error) {
      setNotice(inserted.error + " 已保留原日程。");
      return;
    }
    commit(inserted.state);
  };

  const recordManualPlanEdit = (slot: LifeScheduleSlot) => {
    const current = stateRef.current.schedules.find(item => item.id === slot.id);
    if (!current) return;
    const next = appendLifeTimelineEntry(stateRef.current, { category: "schedule", title: "修改了日程：" + current.title, details: current.startAt + " – " + current.endAt + " · " + (current.plannedLocationName || "地点待定"), actorId: current.ownerId, actorName: actors.find(actor => actor.ownerId === current.ownerId && actor.ownerType === current.ownerType)?.name, locationName: current.plannedLocationName ?? undefined, sourceId: current.id });
    commit(next);
  };

  const addManualPlan = (actor: ActorChoice) => {
    const now = actorNow(actor);
    const start = new Date(now); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60_000);
    const current = actorState(actor);
    const locationName = current?.actualLocationName || state.locations.find(item => item.id === current?.actualLocationId)?.name || "家";
    const slot: LifeScheduleSlot = { id: id("manual-plan"), ownerType: actor.ownerType, ownerId: actor.ownerId, startAt: start.toISOString(), endAt: end.toISOString(), title: "新的日程", plannedLocationName: locationName, kind: "free-time", source: "manual", updatedAt: new Date().toISOString() };
    const inserted = insertManualLifeScheduleSlot(stateRef.current, slot);
    if (inserted.conflict) {
      setNotice("无法添加日程：与「" + inserted.conflict.title + "」时间冲突。请调整时间后再试。");
      return;
    }
    if (inserted.error) { setNotice(inserted.error); return; }
    commit(inserted.state);
    setNotice("已添加日程；系统自动为这段安排腾出了时间，并保留前后未受影响的行程。");
  };

  const deleteManualPlan = (slot: LifeScheduleSlot) => {
    if (slot.source !== "manual" && slot.source !== "character-tool") { setNotice("系统生成的计划可以编辑；目前只允许删除手动添加或角色主动调整的日程。"); return; }
    const current = stateRef.current;
    const now = new Date().toISOString();
    const restoredFreeTime: LifeScheduleSlot = {
      ...slot,
      id: id("restored-free-time"),
      title: "自由活动",
      kind: "free-time",
      source: "weekly-generation",
      updatedAt: now,
    };
    let next: VirtualLifeState = {
      ...current,
      schedules: [...current.schedules.filter(item => item.id !== slot.id), restoredFreeTime]
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    };
    const owner = actors.find(item => item.ownerType === slot.ownerType && item.ownerId === slot.ownerId);
    next = appendLifeTimelineEntry(next, {
      category: "schedule",
      title: "删除日程：" + slot.title,
      details: fmt(new Date(slot.startAt)) + "–" + fmt(new Date(slot.endAt)) + " · 该时段已恢复为自由活动",
      actorId: slot.ownerId,
      actorName: owner?.name,
      locationName: slot.plannedLocationName ?? undefined,
      sourceId: slot.id,
    });
    commit(next);
    setNotice("已删除这条日程，该时段已恢复为自由活动，整日日程不会留下空洞。");
  };

  const goToCharacter = (character: Character) => {
    const current = stateRef.current;
    const presence = current.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
    const schedule = getCurrentActorSchedule(current, "character", character.id, resolveActorLifeNow(getActorClock(current, "character", character.id)));
    const placeName = presence?.actualLocationName || schedule?.plannedLocationName;
    if (!placeName) {
      setNotice(`还不知道${character.name}此刻在哪里；可以先查看 TA 的日程，或通过聊天向 TA 问问。`);
      openDaily("plans");
      return;
    }
    let next = current;
    let location = next.locations.find(item => item.id === presence?.actualLocationId && item.name === placeName)
      || next.locations.find(item => item.name.trim().toLocaleLowerCase() === placeName.trim().toLocaleLowerCase());
    if (!location) {
      location = { id: id("location"), name: placeName, description: "从角色当前动态定位到的地点", visibility: "public" };
      next = { ...next, locations: [...next.locations, location] };
    }
    const now = new Date().toISOString();
    next = upsertActorState(next, { ownerType: "player", ownerId: PLAYER_ID, activity: "正在去找" + character.name, actualLocationId: location.id, actualLocationName: location.name, updatedAt: now });
    const scene = next.scenes.find(item => item.status === "active") ?? next.scenes.filter(item => item.status === "paused").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (scene) {
      const participants = scene.participants.filter(item => !(item.ownerType === "player" && item.ownerId === PLAYER_ID));
      next = upsertLifeScene(next, { ...scene, locationId: location.id, locationName: location.name, status: "active", updatedAt: now, participants: [{ ownerType: "player", ownerId: PLAYER_ID, activity: "正在去找" + character.name, awarenessByActorId: { [character.id]: "aware" } }, ...participants.filter(item => item.ownerType !== "character" || item.ownerId !== character.id), { ownerType: "character", ownerId: character.id, activity: presence?.activity || schedule?.title || "在这里活动", awarenessByActorId: { [PLAYER_ID]: "aware" } }] });
    }
    next = appendLifeTimelineEntry(next, { category: "location", title: "你去找" + character.name, details: "前往" + location.name + (presence?.actualLocationName ? "（角色记录的当前位置）" : "（根据角色日程推测）"), actorId: PLAYER_ID, actorName: playerName, locationName: location.name });
    commit(next);
    setSelectedLocationId(location.id);
    setSelectedCharacterIds(ids => ids.includes(character.id) ? ids : [...ids, character.id]);
    setNotice(`已前往「${location.name}」，并将${character.name}加入当前互动场景。若地点来自日程推测，实际位置仍需角色或场景确认。`);
    setTab("home");
  };

  const themeClass = settings.sceneTheme === "night-sky" ? "from-slate-950 via-slate-900 to-indigo-950 text-slate-100" : settings.sceneTheme === "sage" ? "from-[#eaf0e8] via-[#f3f4eb] to-[#dce8dc] text-stone-800" : settings.sceneTheme === "rose" ? "from-[#fff0f1] via-[#fff8f6] to-[#f7e3e5] text-stone-800" : "from-[#fbf4e9] via-[#f7efe4] to-[#ead9c6] text-stone-800";
  const lifePalette = settings.sceneTheme === "night-sky" ? {"--life-surface-rgb":"30 41 59","--life-strong-rgb":"15 23 42","--life-soft-rgb":"51 65 85","--life-border-rgb":"100 116 139","--life-text":"#f1f5f9","--life-muted":"#cbd5e1","--life-faint":"#94a3b8","--life-overlay":"rgba(15,23,42,.98)"} : settings.sceneTheme === "sage" ? {"--life-surface-rgb":"239 244 235","--life-strong-rgb":"248 250 245","--life-soft-rgb":"222 233 218","--life-border-rgb":"166 190 161","--life-text":"#354438","--life-muted":"#596c5b","--life-faint":"#718473","--life-overlay":"rgba(245,249,241,.98)"} : settings.sceneTheme === "rose" ? {"--life-surface-rgb":"255 242 243","--life-strong-rgb":"255 249 248","--life-soft-rgb":"250 224 228","--life-border-rgb":"231 183 191","--life-text":"#65464b","--life-muted":"#89676c","--life-faint":"#a17d82","--life-overlay":"rgba(255,247,247,.985)"} : {"--life-surface-rgb":"250 244 235","--life-strong-rgb":"255 251 245","--life-soft-rgb":"239 225 210","--life-border-rgb":"217 194 174","--life-text":"#514237","--life-muted":"#79695c","--life-faint":"#9a8879","--life-overlay":"rgba(255,252,246,.985)"};
  const cssVars = { ...lifePalette, "--life-accent": settings.accentColor, "--life-opacity": settings.panelOpacity / 100, "--life-font": `${settings.dialogueFontSize}px`, "--life-narration-font": `${settings.narrationFontSize}px` } as CSSProperties;
  const playerActor = actors[0];
  const playerNow = actorNow(playerActor);
  const playerDayStart = new Date(playerNow); playerDayStart.setHours(0,0,0,0);
  const playerDayEnd = new Date(playerDayStart); playerDayEnd.setDate(playerDayEnd.getDate() + 1);
  const playerTodaySlots = state.schedules.filter(slot => slot.ownerType === "player" && slot.ownerId === PLAYER_ID && new Date(slot.startAt).getTime() < playerDayEnd.getTime() && new Date(slot.endAt).getTime() > playerDayStart.getTime()).sort((a,b)=>a.startAt.localeCompare(b.startAt));
  const playerPastSlots = playerTodaySlots.filter(slot => new Date(slot.endAt).getTime() <= playerNow.getTime());
  const playerCurrentSlot = playerTodaySlots.find(slot => new Date(slot.startAt).getTime() <= playerNow.getTime() && new Date(slot.endAt).getTime() > playerNow.getTime());
  const playerFutureSlots = playerTodaySlots.filter(slot => new Date(slot.startAt).getTime() > playerNow.getTime());
  const playerPresence = actorState(playerActor);
  const nearbyCharacters = characters.map(character => ({ character, presence: state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === character.id) })).filter(item => !!playerPresence?.actualLocationId && item.presence?.actualLocationId === playerPresence.actualLocationId);
  const playerLocationId = playerPresence?.actualLocationId || playerCurrentSlot?.plannedLocationId || activeScene?.locationId || "home";
  const locationCards = state.locations.map(location => {
    const people = characters.map(character => {
      const presence = state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === character.id);
      const currentSlot = getCurrentActorSchedule(state, "character", character.id, resolveActorLifeNow(getActorClock(state, "character", character.id)));
      const isActuallyHere = presence?.actualLocationId === location.id;
      const isExpectedHere = !presence?.actualLocationId && currentSlot?.plannedLocationId === location.id;
      return { character, activity: presence?.activity || currentSlot?.title || "正在自己的生活里", isActuallyHere, isExpectedHere };
    }).filter(person => person.isActuallyHere || person.isExpectedHere);
    const dynamicActivity = people.filter(person => person.isActuallyHere).map(person => person.activity).filter(Boolean);
    const inferredAtmosphere = dynamicActivity.length
      ? `现场有${dynamicActivity.join("、")}的生活动静。`
      : people.some(person => person.isExpectedHere) ? "日程显示有人可能会来这里，但实际在场尚未确认。" : "暂时没有记录到角色在场，环境保持安静。";
    const atmosphere = [location.atmosphere?.trim(), inferredAtmosphere].filter(Boolean).join(" ");
    return { location, people, atmosphere, isCurrent: location.id === playerLocationId };
  }).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.people.filter(person => person.isActuallyHere).length - a.people.filter(person => person.isActuallyHere).length || a.location.name.localeCompare(b.location.name, "zh-CN"));

  const lifeTimeline = (state.timeline ?? []).filter(entry => {
    if (entry.category === "location" || entry.category === "scene") return settings.recordLocationChanges;
    if (entry.category === "action") return settings.recordCharacterActions;
    if (entry.category === "dialogue") return settings.recordSceneMessages;
    if (entry.category === "schedule") return settings.recordScheduleChanges;
    if (entry.category === "tool") return settings.recordToolCalls;
    if (entry.category === "social") return settings.recordSocialActivity;
    if (entry.category === "diary") return settings.recordDiaryActivity;
    if (entry.category === "chat") return settings.recordChatActivity;
    return true;
  }).slice().sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));
  const timelineImageRefsKey = lifeTimeline.filter(entry => entry.imageMediaRef).map(entry => entry.id + ":" + entry.imageMediaRef).join("|");
  useEffect(() => {
    let alive = true;
    const urls: Record<string, string> = {};
    void Promise.all(lifeTimeline.filter(entry => entry.imageMediaRef).map(async entry => {
      const url = await loadMediaObjectUrl(entry.imageMediaRef!);
      if (url) urls[entry.id] = url;
    })).then(() => {
      if (!alive) { Object.values(urls).forEach(url => URL.revokeObjectURL(url)); return; }
      Object.values(timelineImageObjectUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
      timelineImageObjectUrlsRef.current = urls;
      setTimelineImageUrls(urls);
    });
    return () => { alive = false; };
  }, [timelineImageRefsKey]);
  useEffect(() => () => {
    Object.values(timelineImageObjectUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
    timelineImageObjectUrlsRef.current = {};
  }, []);
  const generateTimelineImage = async (entry: LifeTimelineEntry) => {
    if (timelineImageBusyId) return;
    const imageSettings = loadImageGenerationSettings();
    if (!imageSettings.enabled) { setNotice("请先到「小手机设置 → 生图设置」启用并配置生图服务。"); return; }
    setTimelineImageBusyId(entry.id);
    setNotice("正在为这条生活记录生成图片……");
    try {
      const characterId = entry.actorId && entry.actorId !== PLAYER_ID && characters.some(character => character.id === entry.actorId) ? entry.actorId : undefined;
      const result = await generateImageFromConfiguredApi({
        description: [
          "为一条虚拟生活记录生成一张自然、温暖、有生活感的单帧场景插画或写实画面。",
          "不要拼贴、不要漫画分格、不要在图片中添加文字或水印。",
          "事件：" + entry.title,
          entry.details ? "事件细节：" + entry.details : "",
          entry.locationName ? "地点：" + entry.locationName : "",
          entry.actorName ? "主要人物：" + entry.actorName : "",
          "尽量表现记录中真实发生的瞬间，不要凭空添加无关人物或戏剧化情节。"
        ].filter(Boolean).join("\n"),
        characterId,
        appId: "story",
        useReferenceImage: Boolean(characterId),
      });
      if (!result) throw new Error("生图服务未返回图片，请检查 API 配置。");
      const latest = stateRef.current;
      const currentEntry = latest.timeline.find(item => item.id === entry.id);
      if (!currentEntry) {
        await deleteMediaRef(result.mediaRef);
        throw new Error("这条生活记录已不存在，图片没有保存。");
      }
      commit({ ...latest, timeline: latest.timeline.map(item => item.id === entry.id ? { ...item, imageMediaRef: result.mediaRef } : item) });
      if (currentEntry.imageMediaRef && currentEntry.imageMediaRef !== result.mediaRef) {
        await deleteMediaRef(currentEntry.imageMediaRef).catch(() => undefined);
      }
      setNotice("生活记录图片已生成并保存。");
    } catch (error) {
      setNotice("生活记录生图失败：" + (error instanceof Error ? error.message : "未知错误"));
    } finally {
      setTimelineImageBusyId("");
    }
  };
  const recentLifeTimeline = lifeTimeline.slice(0, 5);
  const olderLifeTimeline = lifeTimeline.slice(5);
  const localDateKey = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const experienceTimeline = lifeTimeline.filter(entry =>
    (experienceActorFilter === "all" || entry.actorId === experienceActorFilter)
    && (experienceCategoryFilter === "all" || entry.category === experienceCategoryFilter)
    && (!experienceDateFilter || localDateKey(entry.occurredAt) === experienceDateFilter)
  );
  const experienceGroups = new Map<string, typeof experienceTimeline>();
  for (const entry of experienceTimeline) {
    const groupKey = experienceGroupBy === "date" ? localDateKey(entry.occurredAt) || "日期未知" : entry.actorName || "未标记角色";
    const group = experienceGroups.get(groupKey) ?? [];
    group.push(entry);
    experienceGroups.set(groupKey, group);
  }
  const sortedExperienceGroups = [...experienceGroups.entries()].sort(([aKey, aItems], [bKey, bItems]) =>
    experienceGroupBy === "date"
      ? (bItems[0]?.occurredAt ?? "").localeCompare(aItems[0]?.occurredAt ?? "")
      : aKey.localeCompare(bKey, "zh-CN")
  );
  const pendingCharacterInvitations = state.invitations.filter(invite => invite.status === "proposed" && invite.proposedBy !== "player");


  if (!ready) return <main className="flex min-h-screen items-center justify-center bg-[#f7efe4] text-stone-500">正在打开生活档案…</main>;

  return <main style={{ ...cssVars, ...(immersiveScene ? { height: "var(--life-viewport-height, 100dvh)" } : {}) }} className={`life-rose-garden ${immersiveScene ? "flex flex-col overflow-hidden overscroll-none" : "min-h-screen min-h-[100dvh] overflow-y-auto overscroll-y-contain touch-pan-y"} bg-gradient-to-br ${themeClass} ${settings.compactLayout ? "px-1.5 py-1.5 sm:px-3 sm:py-3" : "px-2 py-2 sm:px-4 sm:py-4"}`}>
    <style>{`
      /* Tie the spatial transition to the real scene-state update; no artificial waiting screen. */
      @keyframes life-view-leave {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0; transform: scale(.982); }
      }
      @keyframes life-view-arrive {
        from { opacity: 0; transform: scale(1.018); }
        to { opacity: 1; transform: scale(1); }
      }
      ::view-transition-old(root) {
        animation: life-view-leave 220ms cubic-bezier(.4, 0, 1, 1) both;
      }
      ::view-transition-new(root) {
        animation: life-view-arrive 380ms cubic-bezier(.16, 1, .3, 1) both;
      }
      /* Scene transitions: spatial, responsive, and respectful of reduced-motion preferences. */
      @keyframes life-scene-enter {
        0% { opacity: 0; transform: translate3d(0, 14px, 0) scale(.985); filter: blur(3px); }
        65% { opacity: 1; transform: translate3d(0, -2px, 0) scale(1.003); filter: blur(0); }
        100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); filter: blur(0); }
      }
      @keyframes life-place-card-enter {
        from { opacity: 0; transform: translate3d(0, 12px, 0) scale(.99); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }
      .life-scene-panel { animation: life-scene-enter 420ms cubic-bezier(.2, .8, .2, 1) both; transform-origin: 50% 80%; }
      .life-place-list { animation: life-scene-enter 300ms cubic-bezier(.2, .8, .2, 1) both; }
      .life-place-card { animation: life-place-card-enter 360ms cubic-bezier(.2, .8, .2, 1) both; will-change: opacity, transform; }
      .life-place-card:active { transform: scale(.992); }
      @media (prefers-reduced-motion: reduce) {
        .life-scene-panel, .life-place-list, .life-place-card { animation: none !important; will-change: auto; }
        ::view-transition-old(root), ::view-transition-new(root) { animation: none !important; }
      }
      .life-scene-display-options[open] {
        position: fixed !important;
        inset: max(8px, env(safe-area-inset-top, 0px)) 8px max(8px, env(safe-area-inset-bottom, 0px)) !important;
        z-index: 2147483000 !important;
        display: flex;
        flex-direction: column;
        min-width: 0;
        max-height: none !important;
        overflow: hidden;
        padding: 12px;
        border-radius: 20px;
        border: 1px solid rgba(168, 137, 106, .35);
        background: var(--life-overlay);
        box-shadow: 0 24px 80px rgba(42, 34, 25, .28);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        pointer-events: auto;
      }
      .life-scene-display-options[open] > summary { flex: 0 0 auto; padding: 10px 8px; line-height: 1.5; overflow-wrap: anywhere; }
      .life-scene-display-options-body { min-width: 0; }
      .life-scene-display-options[open] .life-scene-display-options-body {
        flex: 1 1 auto; min-height: 0; max-height: none !important; overflow: auto;
        padding: 10px 4px 16px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
      }
      .life-scene-display-options-body label { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; }
      .life-scene-display-options-body input, .life-scene-display-options-body select, .life-scene-display-options-body textarea { box-sizing: border-box; max-width: 100%; min-width: 0; }
      .life-scene-display-options-body .grid { min-width: 0; }
      /* 原先这一组数值项写死 grid-cols-2：手机上每列仅约 160px，
         「气泡内边距（px）」这类标签被迫折行、输入框顶破格子、与相邻卡片重叠。
         窄屏改单列，并把每项压成「左标签 + 右窄输入框」一行，纵向高度也随之减半。 */
      @media (max-width: 559px) {
        .life-scene-display-options-body .grid-cols-2 { grid-template-columns: minmax(0, 1fr) !important; }
      }
      .life-scene-display-options-body .grid-cols-2 > label {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 6px 8px !important;
      }
      .life-scene-display-options-body .grid-cols-2 > label > input,
      .life-scene-display-options-body .grid-cols-2 > label > select {
        flex: 0 0 auto; width: 74px; margin-top: 0 !important; padding: 4px 6px !important;
        text-align: center; font-variant-numeric: tabular-nums;
      }
      /* 字体这类长文本仍占整行，否则会把自己挤成一条缝 */
      .life-scene-display-options-body .grid-cols-2 > label.col-span-2 { flex-wrap: wrap; }
      .life-scene-display-options-body .grid-cols-2 > label.col-span-2 > input { flex: 1 1 100%; width: 100%; text-align: left; }
      @media (min-width: 560px) {
        .life-scene-display-options[open] { left: max(24px, calc((100vw - 720px) / 2)) !important; right: max(24px, calc((100vw - 720px) / 2)) !important; }
      }
    `}</style>
    <style>{`
      .life-rose-garden [class~="bg-white"],
.life-rose-garden [class~="bg-white/95"],
.life-rose-garden [class~="bg-white/90"],
.life-rose-garden [class~="bg-white/85"],
.life-rose-garden [class~="bg-white/80"],
.life-rose-garden [class~="bg-white/75"],
.life-rose-garden [class~="bg-white/70"],
.life-rose-garden [class~="bg-white/65"],
.life-rose-garden [class~="bg-white/60"],
.life-rose-garden [class~="bg-white/55"],
.life-rose-garden [class~="bg-white/50"],
.life-rose-garden [class~="bg-white/45"],
.life-rose-garden [class~="bg-white/40"],
.life-rose-garden [class~="bg-white/35"] { background-color: rgb(var(--life-strong-rgb) / .78) !important; }
      .life-rose-garden [class~="bg-[#efe1d2]"],
.life-rose-garden [class~="bg-[#f3e8dc]"],
.life-rose-garden [class~="bg-[#f0e3d5]"],
.life-rose-garden [class~="bg-[#e9d4c0]"],
.life-rose-garden [class~="bg-[#f5e9dd]/70"],
.life-rose-garden [class~="bg-stone-50/80"],
.life-rose-garden [class~="bg-stone-50/90"],
.life-rose-garden [class~="bg-stone-100"] { background-color: rgb(var(--life-soft-rgb) / .86) !important; }
      .life-rose-garden [class~="bg-[#fbf7f0]/90"],
.life-rose-garden [class~="bg-[#fbf7f0]"],
.life-rose-garden [class~="bg-[#fffaf5]"],
.life-rose-garden [class~="bg-[#fffaf3]/95"],
.life-rose-garden [class~="bg-[#fffdf9]"],
.life-rose-garden [class~="bg-[#fbf5ee]"],
.life-rose-garden [class~="bg-[#faf5ef]"],
.life-rose-garden [class~="bg-[#f8f4ee]"],
.life-rose-garden [class~="bg-[#f7efe4]"],
.life-rose-garden [class~="bg-[#f5ede4]"],
.life-rose-garden [class~="bg-[#f8f2eb]/85"] { background-color: rgb(var(--life-surface-rgb) / .94) !important; }
      .life-rose-garden [class~="border-white/80"],
.life-rose-garden [class~="border-white/70"],
.life-rose-garden [class~="border-stone-200"],
.life-rose-garden [class~="border-stone-200/80"],
.life-rose-garden [class~="border-stone-200/70"],
.life-rose-garden [class~="border-stone-200/60"],
.life-rose-garden [class~="border-stone-200/50"],
.life-rose-garden [class~="border-stone-300"],
.life-rose-garden [class~="border-[#d9c2ae]"],
.life-rose-garden [class~="border-[#d8c1ad]/60"] { border-color: rgb(var(--life-border-rgb) / .76) !important; }
      .life-rose-garden [class~="text-stone-800"], .life-rose-garden [class~="text-stone-700"], .life-rose-garden [class~="text-stone-600"] { color: var(--life-text) !important; }
      .life-rose-garden [class~="text-stone-500"] { color: var(--life-muted) !important; }
      .life-rose-garden [class~="text-stone-400"] { color: var(--life-faint) !important; }
      .life-rose-garden [class~="bg-[#b88768]"] { background-color: var(--life-accent) !important; }
      .life-rose-garden [class~="text-[#a4775d]"] { color: var(--life-accent) !important; }
      .life-rose-garden nav[aria-label="生活导航"] { background-color: rgb(var(--life-surface-rgb) / .96) !important; border-color: rgb(var(--life-border-rgb) / .76) !important; }
      .life-rose-garden nav[aria-label="生活导航"] button[aria-current="page"] { background-color: rgb(var(--life-strong-rgb) / .98) !important; color: var(--life-accent) !important; }
      .life-rose-garden input:not([type="checkbox"]):not([type="radio"]):not([type="color"]), .life-rose-garden select, .life-rose-garden textarea { color: var(--life-text); border-color: rgb(var(--life-border-rgb) / .85); }
      /* Theme every text utility, not just the three shades used by the original palette. */
      .life-rose-garden [class~="text-stone-900"],
      .life-rose-garden [class~="text-stone-800"],
      .life-rose-garden [class~="text-stone-700"],
      .life-rose-garden [class~="text-stone-600"],
      .life-rose-garden [class~="text-gray-900"],
      .life-rose-garden [class~="text-gray-800"],
      .life-rose-garden [class~="text-gray-700"],
      .life-rose-garden [class~="text-gray-600"] { color: var(--life-text) !important; }
      .life-rose-garden [class~="text-stone-500"],
      .life-rose-garden [class~="text-stone-400"],
      .life-rose-garden [class~="text-stone-300"],
      .life-rose-garden [class~="text-gray-500"],
      .life-rose-garden [class~="text-gray-400"],
      .life-rose-garden [class~="text-gray-300"] { color: var(--life-muted) !important; }
      /* Native controls and switches follow the selected scene palette. */
      .life-rose-garden input:not([type="color"]):not([type="checkbox"]):not([type="radio"]),
      .life-rose-garden select,
      .life-rose-garden textarea {
        background-color: rgb(var(--life-surface-rgb) / .96);
        color: var(--life-text) !important;
        caret-color: var(--life-accent);
      }
      .life-rose-garden input[type="checkbox"],
      .life-rose-garden input[type="radio"] { accent-color: var(--life-accent); }
      .life-rose-garden input[type="range"] { accent-color: var(--life-accent); }
      .life-rose-garden [role="switch"] {
        border-color: rgb(var(--life-border-rgb) / .9) !important;
        background-color: rgb(var(--life-soft-rgb) / .95);
      }
      .life-rose-garden [role="switch"][aria-checked="true"] { background-color: var(--life-accent) !important; }
      .life-rose-garden [role="switch"] > span { background-color: #fff !important; }
      .life-rose-garden button:focus-visible,
      .life-rose-garden input:focus-visible,
      .life-rose-garden select:focus-visible,
      .life-rose-garden textarea:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--life-accent) 70%, transparent);
        outline-offset: 2px;
      }
      .life-rose-garden .life-scene-display-options[open] { background: var(--life-overlay) !important; border-color: rgb(var(--life-border-rgb) / .8); }
      .life-rose-garden [class~="bg-[#fffaf3]/95"], .life-rose-garden [class~="bg-[#fffaf5]"] { background-color: var(--life-overlay) !important; }
    `}</style>
    {settings.customSceneCss?.trim() && <style>{settings.customSceneCss.replace(/<\/style/gi, "<\\/style")}</style>}
    <div className={`mx-auto w-full max-w-none ${immersiveScene ? "flex min-h-0 flex-1 flex-col" : ""}`}>
      <header className={`${immersiveScene ? "hidden" : "mb-2 flex flex-wrap items-center justify-between gap-2"}`}>
        <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/75 text-[var(--life-accent)] shadow-sm"><Heart size={22}/></div><div><p className="text-[10px] font-semibold uppercase tracking-[0.26em] opacity-60">A LIVING WORLD · SHARED MOMENTS</p><h1 className="text-2xl font-semibold tracking-tight">生活世界</h1><p className="mt-0.5 text-xs opacity-65">角色有自己的生活，你也可以随时加入</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><button onClick={()=>tab==="home"?closeApp():setTab("home")} aria-label="返回生活现场" className="inline-flex items-center gap-1 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-sm"><ArrowLeft size={15}/><span>返回</span></button><button onClick={closeApp} aria-label="退出生活 APP" className="inline-flex items-center gap-1 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-sm"><X size={15}/><span>退出</span></button><span className="rounded-full border border-white/70 bg-white/60 px-3 py-1.5 text-xs">{actors.length} 位生活参与者</span></div>
      </header>
      {sceneToast && immersiveScene && <div role="status" aria-live="polite" className="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-[120] w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-[var(--life-accent)]/30 bg-[#fffaf3]/95 px-4 py-3 shadow-xl backdrop-blur-md"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--life-accent)]">{sceneToast.title}</p><p className="mt-1 text-sm leading-relaxed text-stone-700">{sceneToast.body}</p></div><button type="button" onClick={() => setSceneToast(null)} aria-label="关闭主动消息提示" className="shrink-0 text-stone-400">×</button></div></div>}
      {notice && !immersiveScene && <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-[var(--life-accent)]/20 bg-white/75 px-4 py-3 text-sm text-stone-700"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
      <nav aria-label="生活导航" className={`${immersiveScene ? "hidden" : "sticky top-0 z-20 mb-2 flex max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-white/80 bg-[#fbf7f0]/90 p-1 shadow-sm backdrop-blur-md [scrollbar-width:none]"}`}>
        {([{id:"home",label:"生活现场",icon:MessagesSquare},{id:"daily",label:"角色日程",icon:CalendarDays},{id:"invitations",label:"邀约活动",icon:Coffee},{id:"experiences",label:"共同经历",icon:Heart},{id:"locations",label:"地点库",icon:MapPin},{id:"settings",label:"设置",icon:Settings2}] as const).filter(item => item.id !== "invitations" || settings.enableInvitations || settings.enableFollowRequestTool || pendingCharacterInvitations.length > 0).map(item => { const Icon=item.icon; const active=item.id===tab||(item.id==="daily"&&(tab==="daily"||tab==="people"||tab==="plans")); return <button key={item.id} onClick={() => { if(item.id==="daily"){setTab("daily");setSceneView(false);return;} setTab(item.id); if(item.id==="home" || item.id==="locations") setSceneView(false); if(item.id==="locations") setLocationDossierOpen(false); }} aria-current={active?"page":undefined} className={`flex shrink-0 flex-row items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs transition sm:px-3 sm:text-sm ${active?"bg-white text-[var(--life-accent)] shadow-sm":"opacity-70 hover:opacity-100"}`}><span className="relative inline-flex"><Icon size={16}/>{item.id==="invitations"&&pendingCharacterInvitations.length>0&&<span className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] text-white">{pendingCharacterInvitations.length}</span>}</span><span className="truncate">{item.label}</span></button>; })}
      </nav>

      {(tab === "home" || tab === "scene") && <div className={immersiveScene ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
        {tab === "scene" && !immersiveScene && <details open className="rounded-2xl border border-white/80 bg-white/55 shadow-sm"><summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-stone-600">生活状态与时间线 · {playerNow.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})} · 展开查看</summary><section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle eyebrow="Your day · 24 hours" title={playerNow.toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long"})+" · 我的时间线"} note="已过去的时段可以折叠查看；快进会逐段结算日程，不会直接抹掉中间发生的生活。" />
            <button onClick={()=>openDaily("plans")} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">查看完整七日日程</button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="min-w-0 rounded-2xl bg-white/75 p-2 sm:p-3"><p className="text-[10px] text-stone-500 sm:text-[11px]">现在</p><p className="mt-1 text-base font-semibold sm:text-lg">{playerNow.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</p><p className="mt-1 truncate text-[10px] text-stone-600 sm:text-xs">{playerPresence?.activity ?? playerCurrentSlot?.title ?? "时间线待补全"}</p></div>
            <div className="min-w-0 rounded-2xl bg-white/75 p-2 sm:p-3"><p className="text-[10px] text-stone-500 sm:text-[11px]">实际地点</p><p className="mt-1 truncate text-sm font-semibold sm:text-base">{playerPresence?.actualLocationName ?? "尚未记录"}</p><p className="mt-1 truncate text-[10px] text-stone-500 sm:text-xs">计划：{settings.showLocationHints ? playerCurrentSlot?.plannedLocationName ?? "暂无提示" : "地点线索已隐藏"}</p></div>
            <div className="min-w-0 rounded-2xl bg-white/75 p-2 sm:p-3"><p className="text-[10px] text-stone-500 sm:text-[11px]">当前场景</p><p className="mt-1 truncate text-sm font-semibold sm:text-base">{activeScene?.locationName ?? "尚未进入场景"}</p><p className="mt-1 truncate text-[10px] text-stone-500 sm:text-xs">{activeScene ? (activeScene.status==="active"?"正在进行":"已暂停，可继续") : "可以从下方选择地点进入"}</p></div>
          </div>

          {pendingCharacterInvitations.length > 0 && <section className="mt-3 rounded-2xl border border-rose-200/80 bg-rose-50/75 p-3 sm:p-4"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="text-sm font-semibold text-stone-800">有 {pendingCharacterInvitations.length} 项等你回应</p><p className="mt-1 text-xs text-stone-600">角色主动发来的邀约或陪伴申请，不会自动修改日程。</p></div><button onClick={() => setTab("invitations")} className="shrink-0 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">查看并决定</button></div></section>}
          {settings.showTimeline && <div className="mt-4">
            {playerPastSlots.length>0 && <details className="mb-3 rounded-2xl border border-stone-200/70 bg-white/55 p-3"><summary className="cursor-pointer text-sm font-medium text-stone-600">展开已度过的时段（{playerPastSlots.length}）</summary><div className="mt-3 space-y-2">{playerPastSlots.map(slot=><div key={slot.id} className="flex gap-3 rounded-xl bg-stone-50/80 p-2.5 text-xs"><span className="w-24 shrink-0 text-stone-400">{new Date(slot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><span className="min-w-0 flex-1">{slot.title}</span><span className="text-stone-400">{slot.plannedLocationName??"地点未定"}</span></div>)}</div></details>}
            <div className="space-y-2">
              {playerCurrentSlot && <div className="flex gap-3 rounded-2xl border border-[var(--life-accent)]/40 bg-white p-3 shadow-sm"><span className="w-24 shrink-0 text-xs font-semibold text-[var(--life-accent)]">{new Date(playerCurrentSlot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(playerCurrentSlot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="font-medium">{playerCurrentSlot.title}</p><p className="mt-1 text-xs text-stone-500">实际状态：{playerPresence?.activity??playerCurrentSlot.title} · {playerPresence?.actualLocationName??playerCurrentSlot.plannedLocationName??"地点未记录"}</p></div><span className="self-start rounded-full bg-[var(--life-accent)]/10 px-2 py-1 text-[10px] text-[var(--life-accent)]">正在进行</span></div>}
              {playerFutureSlots.slice(0,5).map(slot=><div key={slot.id} className="flex gap-3 rounded-xl bg-white/60 p-3 text-xs"><span className="w-24 shrink-0 text-stone-400">{new Date(slot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><span className="min-w-0 flex-1 font-medium">{slot.title}</span><span className="text-stone-400">{slot.plannedLocationName??"地点未定"}</span></div>)}
              {!playerCurrentSlot && playerTodaySlots.length===0 && <div className="rounded-xl bg-white/65 p-3 text-sm text-stone-500">今天的时间线还没生成。你可以开启自动日程，或到七日日程页补全。</div>}
            </div>
          </div>}
          <div className="mt-3"><p className="mb-2 text-sm font-medium">此刻和你在同一地点的角色</p>{nearbyCharacters.length ? <div className="flex flex-wrap gap-2">{nearbyCharacters.map(({character,presence})=><button key={character.id} onClick={()=>{setSelectedSpeakerId(character.id);setSelectedActorKey("character:"+character.id);setTab("home");}} className="flex items-center gap-2 rounded-xl bg-white/80 px-3 py-2 text-xs"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#efe1d2]">{character.name.slice(0,1)}</span><span className="text-left"><span className="block font-medium">{character.name}</span><span className="block text-stone-500">{presence?.activity??"正在自己的生活里"}</span></span></button>)}</div> : <p className="rounded-xl bg-white/55 p-3 text-xs text-stone-500">暂时没有角色在场</p>}</div>
        </section></details>}
      {tab === "home" && !sceneView && <section className="life-place-list space-y-4">
        <div className="flex items-end justify-between gap-3 px-1">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--life-accent)]">Places & people</p><h2 className="mt-1 text-2xl font-semibold tracking-tight text-stone-800">此刻</h2></div>
          <button onClick={() => openDaily("plans")} className="shrink-0 rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-xs text-stone-600">我的日程</button>
        </div>
        {locationCards.map(({location, people, atmosphere, isCurrent}, index) => <article key={location.id} style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }} className={`life-place-card overflow-hidden rounded-3xl border shadow-sm transition ${isCurrent ? "border-[var(--life-accent)]/45 bg-white/90 ring-1 ring-[var(--life-accent)]/10" : "border-white/80 bg-white/65"}`}>
          <div role="button" tabIndex={0} onClick={() => { setSelectedLocationId(location.id); setSelectedCharacterIds(people.filter(person => person.isActuallyHere).map(person => person.character.id)); enterLocationSolo(location.id); }} onKeyDown={event => { if(event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedLocationId(location.id); setSelectedCharacterIds(people.filter(person => person.isActuallyHere).map(person => person.character.id)); enterLocationSolo(location.id); } }} className="cursor-pointer p-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--life-accent)] sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold text-stone-800">{location.name}</h3>{isCurrent && <span className="rounded-full bg-[var(--life-accent)]/10 px-2 py-1 text-[10px] font-medium text-[var(--life-accent)]">你在这里</span>}{location.visibility === "private" && <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">私人空间</span>}</div><p className="mt-1 text-sm leading-relaxed text-stone-600">{location.description || "这个地点还没有添加描写。"}</p></div>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#f3e8dc] text-[var(--life-accent)]"><MapPin size={19}/></span>
            </div>
            <div className="mt-3"><p className="mb-2 text-xs font-semibold text-stone-600">在场角色 · {people.filter(person => person.isActuallyHere).length} 位实际在场{people.some(person => person.isExpectedHere) ? " · 另有日程预计" : ""}</p>
              {people.length ? <div className="flex flex-wrap gap-2">{people.map(({character,activity,isActuallyHere,isExpectedHere}) => <span key={character.id} className="inline-flex items-center gap-2 rounded-full border border-stone-200/70 bg-white/80 px-2.5 py-1.5 text-xs text-stone-700"><span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-[#efe1d2]">{character.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character.name.slice(0,1)}</span><span><span className="block font-medium">{character.name}</span><span className="block max-w-44 truncate text-[10px] text-stone-500">{activity}{isExpectedHere && !isActuallyHere ? " · 日程预计，未确认在场" : ""}</span></span></span>)}</div> : <p className="rounded-xl bg-white/70 px-3 py-2 text-xs text-stone-500">目前没有角色在场</p>}
            </div>
            <div className="mt-3 rounded-2xl bg-[#f8f2eb]/85 p-3"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-stone-400">Atmosphere · 此刻氛围</p><p className="mt-1 text-sm leading-relaxed text-stone-700">{atmosphere}</p></div>
            {(location.layout || location.props?.length) && <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-stone-500">{location.layout ? `空间：${location.layout} ` : ""}{location.props?.length ? `· 可用道具：${location.props.slice(0,5).join("、")}` : ""}</p>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-stone-200/50 bg-white/45 px-4 py-3 sm:px-5"><span className="text-[11px] text-stone-400">{isCurrent ? "你的当前位置" : people.some(person => person.isActuallyHere) ? "角色正在这里生活" : "可以前往探索"}</span><button type="button" onClick={() => { setSelectedLocationId(location.id); setSelectedCharacterIds(people.filter(person => person.isActuallyHere).map(person => person.character.id)); enterLocationSolo(location.id); }} className="inline-flex min-h-12 min-w-[92px] touch-manipulation shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-4 py-3 text-sm font-semibold text-white shadow-sm"><MapPin size={14}/>{isCurrent ? "进入现场" : "前往"}</button></div>
        </article>)}
        <button type="button" onClick={() => { setSelectedLocationId(playerLocationId); setSceneView(false); setTab("locations"); }} className="w-full rounded-2xl border border-dashed border-stone-300 bg-white/40 px-4 py-3 text-sm text-stone-600">管理地点库 · 添加地点、布局、道具与角色习惯</button>
      </section>}
      {((tab === "home" && sceneView) || tab === "scene") && <section className={`life-scene-panel flex min-w-0 flex-col rounded-2xl border border-white/70 bg-white/35 p-1.5 shadow-sm sm:p-2 ${immersiveScene ? "h-full max-h-full min-h-0 flex-1 overflow-hidden rounded-none border-0 bg-transparent" : ""}`}>
        <div className="mb-1 flex shrink-0 items-center justify-between gap-2 border-b border-stone-200/60 px-1.5 py-1.5 sm:px-2 sm:py-2"><div className="min-w-0 flex-1"><p className="truncate text-base font-semibold text-stone-800">{activeScene ? activeScene.locationName : "还没有正在进行的场景"}</p><p className="truncate text-[11px] text-stone-500">{activeScene ? `${activeScene.participants.length} 位在场 · ${state.locations.find(location => location.id === activeScene.locationId)?.atmosphere || "生活现场"}` : "先从地点列表选择一个地点。"}</p></div><div className="flex shrink-0 items-center gap-2"><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); transitionSceneAction(() => { setSceneView(false); setTab("home"); setLocationDossierOpen(false); }); }} className="relative z-[100] isolate pointer-events-auto inline-flex min-h-11 min-w-[112px] touch-manipulation select-none cursor-pointer items-center justify-center gap-1 rounded-xl border border-stone-300 bg-white px-2 py-2 text-xs font-semibold text-stone-700 shadow-sm active:scale-[0.98]"><ArrowLeft size={16} className="pointer-events-none" aria-hidden/><span>返回地点列表</span></button>{activeScene && <button type="button" onClick={(event)=>{event.preventDefault();event.stopPropagation();transitionSceneAction(() => {const now=new Date().toISOString();const wasPaused=activeScene.status==="paused";const returnNarrationId=wasPaused?id("turn"):undefined;let next={...stateRef.current,scenes:stateRef.current.scenes.map(scene=>scene.id===activeScene.id?{...scene,status:(wasPaused?"active":"paused") as "active"|"paused",updatedAt:now}:{...scene,status:scene.status==="active"?"paused" as const:scene.status})};next=appendLifeTimelineEntry(next,{category:"scene",title:(wasPaused?"你回到了":"你暂时离开了")+activeScene.locationName,details:wasPaused?"继续之前的场景，保留原有互动记录。":"场景已暂停；再次点击继续时才在现场添加返回旁白。",actorName:playerName,locationName:activeScene.locationName,sceneId:activeScene.id,sourceId:returnNarrationId});if(wasPaused){const narration:LifeSceneMessage={id:returnNarrationId??id("turn"),sceneId:activeScene.id,speakerType:"player",speakerId:PLAYER_ID,speakerName:"场景旁白",role:"system",action:"你回到了"+activeScene.locationName+"。先前的场景与互动仍在继续。",dialogue:"",createdAt:now};next={...next,sceneMessages:[...next.sceneMessages,narration]};}commit(next);setNotice(wasPaused?"已回到原场景；返回记录以旁白形式加入聊天。":"你暂时离开了场景；再次点继续时才会添加返回旁白。")})}} className="relative z-[100] isolate pointer-events-auto inline-flex min-h-11 min-w-[104px] touch-manipulation select-none items-center justify-center gap-1 rounded-xl border border-stone-300 bg-white px-2 py-2 text-xs font-semibold shadow-sm active:scale-[0.98]">{activeScene.status==="active"?<><Pause size={14} className="pointer-events-none" aria-hidden/><span>暂时离开</span></>:<><Play size={14} className="pointer-events-none" aria-hidden/><span>回到场景</span></>}</button>}</div></div>
        <details open={!activeScene} className="mb-1 shrink-0 rounded-xl border border-stone-200/70 bg-white/65"><summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-stone-600">场景设置 · {activeScene ? activeScene.locationName : "选择地点并开始互动"}</summary><div className="max-h-[45dvh] overflow-y-auto overscroll-contain touch-pan-y px-3 pb-3 sm:px-4" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="block text-sm font-medium">当前地点
              <select value={selectedLocationId} onChange={e=>setSelectedLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name} · {loc.visibility==="public"?"公共":"私人"}</option>)}</select>
            </label>
            <div className="flex items-end gap-2"><button type="button" onClick={() => enterLocationSolo()} disabled={!settings.enabled} className="flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm disabled:opacity-40">前往地点</button><button type="button" onClick={createScene} disabled={!characters.length||!settings.enabled} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm text-white disabled:opacity-40">进入互动</button></div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block text-xs font-medium text-stone-600">预计停留时间
              <select value={stayDurationMinutes} onChange={event=>setStayDurationMinutes(Number(event.target.value))} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-700">
                <option value={30}>半小时</option><option value={60}>1 小时</option><option value={120}>2 小时</option><option value={240}>4 小时</option><option value={480}>8 小时</option>
              </select>
            </label>
            {playerPresence?.actualLocationUntil && <button type="button" onClick={()=>{
              const now=new Date().toISOString();
              const current=getCurrentActorSchedule(stateRef.current,"player",PLAYER_ID,resolveActorLifeNow(getActorClock(stateRef.current,"player",PLAYER_ID)));
              const location=stateRef.current.locations.find(item=>item.id===current?.plannedLocationId) ?? stateRef.current.locations.find(item=>item.id==="home") ?? stateRef.current.locations[0];
              if(!location){setNotice("找不到原计划地点，请先检查日程。");return;}
              let next=upsertActorState(stateRef.current,{ownerType:"player",ownerId:PLAYER_ID,activity:current?.title||playerPresence.activity,scheduleSlotId:current?.id??playerPresence.scheduleSlotId,actualLocationId:location.id,actualLocationName:location.name,actualLocationUntil:null,updatedAt:now});
              const scene=next.scenes.find(item=>item.status==="active");
              if(scene) next=upsertLifeScene(next,{...scene,locationId:location.id,locationName:location.name,updatedAt:now});
              next=appendLifeTimelineEntry(next,{category:"schedule",title:"已恢复原计划",details:"结束临时停留，回到当前日程地点「"+location.name+"」。",actorId:PLAYER_ID,actorName:playerName,locationName:location.name,sceneId:scene?.id});
              commit(next);setSelectedLocationId(location.id);setNotice("已提前结束临时停留，恢复当前日程地点。");
            }} className="rounded-xl border border-[#d9c2ae] bg-[#fbf5ee] px-3 py-2.5 text-xs text-stone-700">恢复原计划</button>}
          </div>
          {playerPresence?.actualLocationUntil && <p className="mt-2 text-[11px] text-stone-500">临时停留预计于 {new Date(playerPresence.actualLocationUntil).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})} 结束；届时会自动恢复当前行程地点。你也可以提前恢复原计划。</p>}
          <div className="mt-2 flex gap-2"><input value={newLocationName} onChange={e=>setNewLocationName(e.target.value)} placeholder="添加一个新地点…" className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/><button type="button" onClick={addLocation} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">添加地点</button></div>
          <label className="mt-3 block text-sm font-medium text-stone-700">你现在的行动（可选）<input value={playerActivity} onChange={e=>setPlayerActivity(e.target.value)} placeholder="例如：坐在窗边看书、慢慢散步……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <div className="mt-3"><p className="mb-2 text-xs font-medium text-stone-600">选择一起互动的角色</p><div className="flex flex-wrap gap-2">{characters.map(char=><label key={char.id} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs"><input type="checkbox" checked={selectedCharacterIds.includes(char.id)} onChange={e=>setSelectedCharacterIds(old=>e.target.checked?[...new Set([...old,char.id])]:old.filter(id=>id!==char.id))}/>{char.name}</label>)}</div></div>
          {!characters.length&&<p className="mt-2 text-xs text-stone-500">还没有角色档案；先在小手机里创建角色，之后就能在这里互动。</p>}
          {selectedLocation && <div className="mt-4 border-t border-stone-200/70 pt-4">
            <div className="mb-3"><p className="text-sm font-semibold text-stone-700">地点布置与描写</p><p className="mt-1 text-xs leading-relaxed text-stone-500">这里的设定会保存在这个地点，并注入后续场景对话。固定布局帮助角色理解彼此位置，道具可以被拿起、放下或在行动中引用。</p></div>
            <label className="mb-3 block text-xs font-medium text-stone-600">环境描写<textarea value={locationDescriptionDraft} onChange={event=>setLocationDescriptionDraft(event.target.value)} rows={2} placeholder="这里是什么样的地方？光线、声音、气味和整体细节……" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mb-3 block text-xs font-medium text-stone-600">氛围<textarea value={locationAtmosphereDraft} onChange={event=>setLocationAtmosphereDraft(event.target.value)} rows={2} placeholder="例如：傍晚的暖光、低声交谈、窗外有雨……" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mb-3 block text-xs font-medium text-stone-600">空间布局<textarea value={locationLayoutDraft} onChange={event=>setLocationLayoutDraft(event.target.value)} rows={3} placeholder="例如：门在左侧，靠窗有沙发，桌上有茶具，角色能从沙发走到厨房……" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mb-3 block text-xs font-medium text-stone-600">可用道具（用顿号或逗号分隔）<textarea value={locationPropsDraft} onChange={event=>setLocationPropsDraft(event.target.value)} rows={2} placeholder="茶杯、书本、手机、毯子……" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <button type="button" onClick={saveLocationDetails} className="w-full rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white">保存地点布置</button>
          </div>}
        </div></details>
        {activeScene && <>
          <div className={`mb-1 flex shrink-0 items-center gap-1.5 overflow-x-auto pb-0.5 ${settings.compactLayout ? "max-h-8" : "max-h-10"}`}>{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerId===p.ownerId&&a.ownerType===p.ownerType);const awareness=p.awarenessByActorId.player;const status=awareness==="unaware"?"还没注意到你":awareness==="suspects"?"似乎察觉到你":awareness==="aware"?"注意到你":p.activity;return <button key={p.ownerType+":"+p.ownerId} onClick={()=>p.ownerType==="character"&&setSelectedSpeakerId(p.ownerId)} className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${selectedSpeakerId===p.ownerId?"border-[var(--life-accent)] bg-white shadow-sm":"border-white/70 bg-white/55"}`}><span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-[#efe1d2] text-[10px] text-stone-700">{actor?.avatar?<img src={actor.avatar} alt="" className="h-full w-full object-cover"/>:(actor?.name??p.ownerId).slice(0,1)}</span><span className="text-left"><span className="block font-medium">{actor?.name??p.ownerId}</span><span className="block max-w-28 truncate text-[9px] opacity-60">{status}</span></span></button>})}</div>
          <div ref={sceneChatScrollRef} className={`life-scene-chat mb-1 min-h-0 min-w-0 flex-1 flex flex-col overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y rounded-xl bg-white/80 ${settings.compactLayout ? "p-1 sm:p-1.5" : "p-1.5 sm:p-2"} ${immersiveScene ? "" : "h-[58dvh] min-h-[280px] max-h-[760px]"}`} style={{fontSize:"var(--life-font)", rowGap: `${settings.messageGapPx ?? 4}px`, WebkitOverflowScrolling:"touch"}}>
            {sceneMessages.length===0 && <div className="grid min-h-36 place-items-center text-center text-sm text-stone-400"><div><Sparkles className="mx-auto mb-2" size={22}/><p>场景已经准备好了。</p><p className="mt-1 text-xs">角色可以忙自己的事，也可以回应你；不会自动写成长篇剧情。</p></div></div>}
            {sceneMessages.map(message=><div key={message.id} className="group flex min-w-0 max-w-full flex-col rounded-xl transition-colors" onTouchStart={() => { longPressTriggeredRef.current = false; clearMessageLongPress(); longPressTimerRef.current = window.setTimeout(() => { longPressTriggeredRef.current = true; openMessageActions(message); }, 550); }} onTouchEnd={clearMessageLongPress} onTouchMove={clearMessageLongPress} onTouchCancel={clearMessageLongPress} onContextMenu={event => { event.preventDefault(); clearMessageLongPress(); openMessageActions(message); }}>
              {message.role==="system" ? <div className="life-scene-entry-card mx-auto flex w-fit max-w-[92%] items-center justify-center gap-1.5 rounded-xl border border-[#d8c1ad]/60 bg-[#f5e9dd]/70 px-2.5 py-1.5 text-center"><MapPin size={12} className="shrink-0 text-[#a4775d]"/><p className="whitespace-pre-wrap text-center leading-snug text-stone-600" style={{fontSize:"var(--life-narration-font)",fontFamily:settings.narrationFontFamily || undefined}}>{message.action || message.dialogue}</p></div> : <>
                {message.action&&<div className="flex items-center gap-2 px-1" style={{marginBlock: `${settings.narrationGapPx ?? 4}px`}} aria-label="行动旁白"><span className="h-px flex-1 bg-stone-300/80"/><p className="min-w-0 max-w-[82%] break-words text-center italic leading-relaxed text-stone-500 [overflow-wrap:anywhere]" style={{fontSize:"var(--life-narration-font)",fontFamily:settings.narrationFontFamily || undefined}}>{message.action}</p><span className="h-px flex-1 bg-stone-300/80"/></div>}
                {message.dialogue&&<div className={`flex min-w-0 max-w-full items-end gap-1.5 ${message.role==="player"?"justify-end":"justify-start"}`}>{message.role!=="player"&&<span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[#efe1d2] text-[11px] text-stone-700">{actors.find(actor=>actor.ownerType==="character"&&actor.ownerId===message.speakerId)?.avatar?<img src={actors.find(actor=>actor.ownerType==="character"&&actor.ownerId===message.speakerId)?.avatar??undefined} alt="" className="h-full w-full object-cover"/>:(message.speakerName||"角").slice(0,1)}</span>}<div style={{fontSize:"var(--life-font)", fontFamily:settings.dialogueFontFamily || undefined, padding: `${settings.bubblePadding}px ${settings.bubblePadding}px`}} className={`life-scene-bubble min-w-0 max-w-[88%] break-words [overflow-wrap:anywhere] ${settings.compactLayout ? "rounded-xl px-2 py-1" : "rounded-2xl px-2.5 py-1.5"} ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"} ${message.role==="player"?"bg-[#e9d4c0] text-stone-800":"bg-white text-stone-800 shadow-sm"}`}>{message.role!=="player"&&<p className="mb-0.5 text-[10px] font-semibold text-[var(--life-accent)]">{message.speakerName}</p>}<p className="min-w-0 whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{message.dialogue}</p></div>{message.role==="player"&&<span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[#e9d4c0] text-[11px] text-stone-700">{playerIdentity?.avatarUrl?<img src={playerIdentity.avatarUrl} alt="" className="h-full w-full object-cover"/>:playerName.slice(0,1)}</span>}</div>}
              </>}
            </div>)}
            {busy&&<div className="text-xs text-stone-400">角色正在回应……</div>}
          </div>
           <details className="mb-1 shrink-0 rounded-xl border border-stone-200/70 bg-white/50 px-2 py-1.5">
             <summary className="cursor-pointer list-none text-xs text-stone-500">场景相册 · {sceneImageRecords.filter(image=>image.status==="active").length} 张 · 生图</summary>
             <div className="mt-2 flex items-center justify-end gap-3">
               <button type="button" disabled={sceneImageBusy} onClick={()=>void generateSceneImages({count:settings.sceneImageCount,participantIds:imageParticipantIds.length?imageParticipantIds:activeScene.participants.filter(p=>p.ownerType==="character").map(p=>p.ownerId),prompt:sceneImagePrompt})} className="inline-flex items-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50"><Sparkles size={14}/>{sceneImageBusy?"正在生成…":"生成场景"}</button>
             </div>
             {sceneImageRecords.filter(image=>image.status==="active").length>0&&<div className="mt-2 flex gap-2 overflow-x-auto pb-1">{sceneImageRecords.filter(image=>image.status==="active").map((image,index)=><button type="button" key={image.id} onClick={()=>setImageViewerIndex(index)} aria-label={`查看第 ${index+1} 张场景图`} className={`shrink-0 overflow-hidden rounded-xl border ${index===imageViewerIndex?"border-[var(--life-accent)]":"border-stone-200"}`}>{imageObjectUrls[image.id]?<img src={imageObjectUrls[image.id]} alt={image.alt||"场景图"} className="h-16 w-16 object-cover"/>:<span className="grid h-16 w-16 place-items-center text-[10px] text-stone-400">加载中</span>}</button>)}</div>}
           </details>
          
          
          <form onSubmit={sendSceneTurn} className={`life-scene-composer shrink-0 rounded-xl border border-stone-200/70 bg-white/95 ${settings.compactLayout ? "space-y-1 p-1.5" : "space-y-1.5 p-2"}`}>
            <div className={`grid gap-1.5 sm:grid-cols-[0.75fr_1.25fr] ${settings.compactLayout ? "sm:gap-1" : ""}`}>
              <label className="block text-xs font-medium text-stone-600">行动 / 旁白<textarea value={sceneActionInput} onChange={e=>setSceneActionInput(e.target.value)} placeholder="行动（可选）" rows={1} className="mt-1 w-full resize-y rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm leading-snug" disabled={busy}/></label>
              <label className="block text-xs font-medium text-stone-600">说话 / 对话气泡<textarea value={sceneInput} onChange={e=>setSceneInput(e.target.value)} placeholder="想对角色说的话……" rows={1} className="mt-1 w-full resize-y rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm leading-snug" disabled={busy}/></label>
            </div>
            <div className="flex items-center justify-end gap-2"><span className="mr-auto truncate text-[10px] text-stone-400">{busy ? "角色正在回应…" : "行动与对白可分开发送"}</span><button disabled={busy||(!sceneInput.trim()&&!sceneActionInput.trim())} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--life-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"><Send size={13}/>{busy?"等待中":"发送"}</button></div>
          </form>
          
        </>}
      </section>}
          <section className={`mt-4 rounded-2xl border border-stone-200/70 bg-white/60 p-3 sm:p-4 ${immersiveScene || (tab === "home" && !sceneView) ? "hidden" : ""}`}>
            <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-stone-800">今天发生的事</p><p className="mt-0.5 text-[11px] text-stone-500">生活、行动和互动会按发生时间连续记录</p></div><span className="rounded-full bg-white px-2.5 py-1 text-[10px] text-stone-500">{lifeTimeline.length} 条</span></div>
            {recentLifeTimeline.length ? <div className="space-y-2">{recentLifeTimeline.map(entry=><div key={entry.id} className="flex gap-3 rounded-xl bg-white/80 p-3"><span className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums text-stone-400">{new Date(entry.occurredAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-stone-800">{entry.title}</p>{entry.details&&<p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600">{entry.details}</p>}<p className="mt-1 text-[10px] text-stone-400">{entry.actorName ? entry.actorName+" · " : ""}{entry.locationName ? entry.locationName+" · " : ""}{entry.category === "location" ? "地点" : entry.category === "scene" ? "场景" : entry.category === "action" ? "行动" : entry.category === "dialogue" ? "对话" : entry.category === "schedule" ? "日程" : entry.category === "tool" ? "工具" : entry.category === "social" ? "朋友圈" : entry.category === "diary" ? "日记" : entry.category === "chat" ? "消息" : "生活记录"}</p>{timelineImageUrls[entry.id]&&<img src={timelineImageUrls[entry.id]} alt={entry.title} className="mt-2 max-h-56 w-auto max-w-full rounded-xl object-contain"/>}<button type="button" disabled={Boolean(timelineImageBusyId)} onClick={()=>void generateTimelineImage(entry)} className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-600 disabled:opacity-50"><Sparkles size={12}/>{timelineImageBusyId===entry.id?"正在生成…":entry.imageMediaRef?"重新生成图片":"生成场景图片"}</button></div></div>)}</div> : <div className="rounded-xl bg-white/70 p-4 text-center text-xs text-stone-500">还没有符合当前筛选条件的记录。开始行动或互动后，这里会逐渐形成你的一天。</div>}
            {olderLifeTimeline.length>0&&<details className="mt-3 rounded-xl border border-stone-200/70 bg-white/50 p-3"><summary className="cursor-pointer text-xs font-medium text-stone-600">展开更早的记录（{olderLifeTimeline.length}）</summary><div className="mt-3 space-y-2">{olderLifeTimeline.map(entry=><div key={entry.id} className="flex gap-3 border-l-2 border-stone-200 pl-3 py-1"><span className="w-12 shrink-0 text-[10px] tabular-nums text-stone-400">{new Date(entry.occurredAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="text-xs font-medium">{entry.title}</p>{entry.details&&<p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-stone-500">{entry.details}</p>}{timelineImageUrls[entry.id]&&<img src={timelineImageUrls[entry.id]} alt={entry.title} className="mt-2 max-h-48 w-auto max-w-full rounded-lg object-contain"/>}<button type="button" disabled={Boolean(timelineImageBusyId)} onClick={()=>void generateTimelineImage(entry)} className="mt-1.5 inline-flex min-h-7 items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-[10px] text-stone-600 disabled:opacity-50"><Sparkles size={11}/>{timelineImageBusyId===entry.id?"正在生成…":entry.imageMediaRef?"重新生成图片":"生成场景图片"}</button></div></div>)}</div></details>}
          </section>
        <div className={`grid gap-4 lg:grid-cols-[1.15fr_.85fr] ${immersiveScene || (tab === "home" && !sceneView) ? "hidden" : ""}`}>
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

      {tab === "locations" && <div className="space-y-4">
        <section className="rounded-3xl border border-white/80 bg-white/75 p-4 shadow-sm sm:p-6">
          {!locationDossierOpen && <><SectionTitle eyebrow="Canonical location library" title="地点库" note="点开地点卡片进入独立档案页，编辑设定、添加角色习惯并查看历史。角色生成日程时会优先复用这里已有的地点。"/>
          <form onSubmit={event => { event.preventDefault(); addLocation(); }} className="flex gap-2">
            <input value={newLocationName} onChange={event => setNewLocationName(event.target.value)} placeholder="创建一个新地点，例如：旧城区的花店" className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
            <button type="submit" className="shrink-0 rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white"><Plus size={15} className="mr-1 inline"/>添加地点</button>
          </form>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {state.locations.map(location => {
              const entries = state.timeline.filter(entry => entry.locationName === location.name);
              const eventCount = state.events.filter(event => event.locationId === location.id || event.locationName === location.name).length;
              const actualPeople = characters.filter(character => state.actorStates.some(actor => actor.ownerType === "character" && actor.ownerId === character.id && actor.actualLocationId === location.id));
              return <button type="button" key={location.id} onClick={() => { setSelectedLocationId(location.id); setLocationDossierOpen(true); }} className={`min-h-12 touch-manipulation rounded-2xl border p-3 text-left transition ${selectedLocationId === location.id ? "border-[var(--life-accent)] bg-[#fffaf5] shadow-sm" : "border-stone-200/70 bg-white/70 hover:bg-white"}`}>
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="font-semibold text-stone-800">{location.name}</h3><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-stone-500">{location.description || "尚未添加地点描写"}</p></div><span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">{location.visibility === "private" ? "私人" : "公共"}</span></div>
                <div className="mt-3 flex flex-wrap gap-1.5">{actualPeople.length ? actualPeople.map(person => <span key={person.id} className="rounded-full bg-[#efe1d2] px-2 py-1 text-[10px] text-stone-700">{person.name} · 在场</span>) : <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">目前没有实际在场角色</span>}</div>
                <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-stone-400"><span>生活记录 {entries.length} 条 · 事件 {eventCount} 件</span><span>{location.props?.length ?? 0} 件道具 · 查看档案 →</span></div>
              </button>;
            })}
          </div>
          </>}
        </section>
        {locationDossierOpen && selectedLocation && <section className="rounded-3xl border border-white/80 bg-white/75 p-4 shadow-sm sm:p-6">
          <button type="button" onClick={() => setLocationDossierOpen(false)} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700"><ArrowLeft size={16}/>返回地点列表</button>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <div className="rounded-2xl bg-[#f5ede4] p-3"><p className="text-[10px] text-stone-500">到访次数</p><p className="mt-1 text-lg font-semibold text-stone-800">{selectedLocationVisitStats.visits}</p></div>
            <div className="rounded-2xl bg-[#f5ede4] p-3"><p className="text-[10px] text-stone-500">累计停留</p><p className="mt-1 text-lg font-semibold text-stone-800">{Math.floor(selectedLocationVisitStats.minutes / 60)}h {selectedLocationVisitStats.minutes % 60}m</p></div>
            <div className="rounded-2xl bg-[#f5ede4] p-3"><p className="text-[10px] text-stone-500">本次停留</p><p className="mt-1 text-lg font-semibold text-stone-800">{Math.floor(selectedLocationVisitStats.activeMinutes / 60)}h {selectedLocationVisitStats.activeMinutes % 60}m</p></div>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-stone-500">统计按生活系统的虚拟时间计算：每次前往会记入生活时间线，离开或临时停留到期后自动结算。它是实际到访记录，不会把尚未发生的计划误记为已到访。</p>
          <SectionTitle eyebrow="Location dossier" title={selectedLocation.name + " · 地点档案"} note="这些设定会持久保存，并注入后续场景提示词。布局定义空间关系，道具可在行动中被引用，角色习惯会影响其在此处的行为，但不应限制角色临时做出新行动。"/>
          <label className="mb-3 block text-sm font-medium text-stone-700">地点名称<input value={selectedLocation.name} onChange={event => commit({ ...stateRef.current, locations: stateRef.current.locations.map(location => location.id === selectedLocation.id ? { ...location, name: event.target.value } : location) })} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label>
          <label className="mb-3 block text-sm font-medium text-stone-700">别名 / 日程匹配关键词<textarea value={(selectedLocation.aliases ?? []).join("、")} onChange={event => commit({ ...stateRef.current, locations: stateRef.current.locations.map(location => location.id === selectedLocation.id ? { ...location, aliases: event.target.value.split(/[、,，;；\n]/).map(value => value.trim()).filter(Boolean) } : location) })} rows={2} placeholder="例如：旧城区花店、花店、花房" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <label className="mb-3 block text-sm font-medium text-stone-700">环境描写<textarea value={locationDescriptionDraft} onChange={event => setLocationDescriptionDraft(event.target.value)} rows={3} placeholder="空间是什么样的？光线、声音、气味、固定陈设……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <label className="mb-3 block text-sm font-medium text-stone-700">氛围<textarea value={locationAtmosphereDraft} onChange={event => setLocationAtmosphereDraft(event.target.value)} rows={2} placeholder="时段、天气、人声、气味、情绪氛围……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <label className="mb-3 block text-sm font-medium text-stone-700">固定空间布局<textarea value={locationLayoutDraft} onChange={event => setLocationLayoutDraft(event.target.value)} rows={3} placeholder="门窗、家具、通道、柜台、座位之间的空间关系……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <label className="mb-4 block text-sm font-medium text-stone-700">可用道具<textarea value={locationPropsDraft} onChange={event => setLocationPropsDraft(event.target.value)} rows={2} placeholder="用顿号或逗号分隔，例如：花剪、包装纸、玻璃花瓶" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <button type="button" onClick={saveLocationDetails} className="w-full rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white">保存地点设定</button>
          <div className="mt-5 border-t border-stone-200/70 pt-4">
            <SectionTitle eyebrow="Character habits" title="角色在这里的习惯" note="写长期倾向，不是强制动作。比如某角色每次来书店会先看新书区、习惯坐最里面的位置，或会顺手给别人带一杯热饮。"/>
            <div className="space-y-3">{characters.map(character => {
              const history = state.timeline.filter(entry => entry.locationName === selectedLocation.name && (entry.actorId === character.id || entry.actorName === character.name));
              const frequentActions = [...new Set(history.map(entry => entry.title).filter(Boolean))].slice(0, 4);
              return <div key={character.id} className="rounded-2xl border border-stone-200/70 bg-white/80 p-3">
                <div className="flex items-center gap-2">{character.avatar ? <img src={character.avatar} alt="" className="h-9 w-9 rounded-full object-cover"/> : <span className="grid h-9 w-9 place-items-center rounded-full bg-[#efe1d2]">{character.name.slice(0,1)}</span>}<div className="min-w-0 flex-1"><p className="text-sm font-semibold">{character.name}</p><p className="text-[10px] text-stone-500">在此地点有 {history.length} 条行动 / 生活记录</p></div></div>
                <label className="mt-3 block text-xs font-medium text-stone-600">地点习惯<textarea value={locationHabitDrafts[character.id] ?? ""} onChange={event => setLocationHabitDrafts(current => ({ ...current, [character.id]: event.target.value }))} rows={2} placeholder={`描述 ${character.name} 在「${selectedLocation.name}」经常做的事；留空表示没有特别设定。`} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
                {frequentActions.length > 0 && <div className="mt-2"><p className="text-[10px] font-medium text-stone-500">已记录过的事情</p><div className="mt-1 flex flex-wrap gap-1.5">{frequentActions.map(action => <span key={action} className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-600">{action}</span>)}</div></div>}
                <button type="button" onClick={() => saveCharacterLocationHabit(character.id)} className="mt-3 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">保存 {character.name} 的习惯</button>
              </div>;
            })}</div>
          </div>
          <div className="mt-5 border-t border-stone-200/70 pt-4"><SectionTitle eyebrow="Recent history" title="这里发生过什么" note="记录来自生活系统已经保存的行动、对白、日程与事件，不会把计划误当成已经发生的事情。"/>
            {state.timeline.filter(entry => entry.locationName === selectedLocation.name).slice().sort((a,b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0,20).length ? <div className="space-y-2">{state.timeline.filter(entry => entry.locationName === selectedLocation.name).slice().sort((a,b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0,20).map(entry => <div key={entry.id} className="rounded-xl bg-white/80 p-3"><p className="text-sm font-medium">{entry.title}</p>{entry.details && <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-500">{entry.details}</p>}<p className="mt-1 text-[10px] text-stone-400">{entry.actorName || "生活记录"} · {new Date(entry.occurredAt).toLocaleString("zh-CN")}</p></div>)}</div> : <p className="rounded-xl bg-white/70 p-4 text-sm text-stone-500">这个地点还没有已发生的生活记录。角色习惯和地点设定保存后，会影响未来互动。</p>}
          </div>
        </section>}
      </div>}

      {tab === "daily" && <div role="tablist" aria-label="角色日程视图" className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-white/80 bg-white/55 p-1">
        <button type="button" role="tab" aria-selected={dailySubtab === "people"} onClick={() => setDailySubtab("people")} className={`min-w-0 rounded-xl px-2 py-2.5 text-sm transition ${dailySubtab === "people" ? "bg-white font-semibold text-[var(--life-accent)] shadow-sm" : "text-stone-500"}`}>角色动态</button>
        <button type="button" role="tab" aria-selected={dailySubtab === "plans"} onClick={() => setDailySubtab("plans")} className={`min-w-0 rounded-xl px-2 py-2.5 text-sm transition ${dailySubtab === "plans" ? "bg-white font-semibold text-[var(--life-accent)] shadow-sm" : "text-stone-500"}`}>七日日程</button>
        <button type="button" role="tab" aria-selected={dailySubtab === "observe"} onClick={() => setDailySubtab("observe")} className={`min-w-0 rounded-xl px-2 py-2.5 text-sm transition ${dailySubtab === "observe" ? "bg-white font-semibold text-[var(--life-accent)] shadow-sm" : "text-stone-500"}`}>观察生活</button>
      </div>}
      {tab === "daily" && dailySubtab === "observe" && <div className="rounded-3xl border border-white/80 bg-white/55 p-3 shadow-sm sm:p-4"><LifeObservation characters={characters} active={true} onNotice={setNotice} /></div>}
      {(tab === "people" || (tab === "daily" && dailySubtab === "people")) && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <SectionTitle eyebrow="Character presence" title="角色动态" note="汇总所有已载入角色的虚拟时间、当前活动和位置。实际记录与日程推测会分开标记；未知位置不会伪装成实时定位。" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {characters.map(character => {
            const presence = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
            const virtualNow = resolveActorLifeNow(getActorClock(state, "character", character.id));
            const schedule = getCurrentActorSchedule(state, "character", character.id, virtualNow);
            const actualLocation = presence?.actualLocationName || state.locations.find(item => item.id === presence?.actualLocationId)?.name;
            const scene = state.scenes.find(item => item.status === "active" && item.participants.some(p => p.ownerType === "character" && p.ownerId === character.id)) ?? state.scenes.filter(item => item.status === "paused" && item.participants.some(p => p.ownerType === "character" && p.ownerId === character.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            const place = actualLocation || schedule?.plannedLocationName || scene?.locationName;
            const isActual = !!actualLocation;
            return <article key={character.id} className="rounded-2xl border border-stone-200/80 bg-white/75 p-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{character.name}</h3><p className="mt-1 text-xs text-stone-500">{virtualNow.toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})} · 角色虚拟时间</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${isActual?"bg-emerald-50 text-emerald-700":"bg-amber-50 text-amber-700"}`}>{isActual?"位置已记录":place?"按日程推测":"位置未知"}</span></div>
              <div className="mt-3 rounded-xl bg-stone-50/90 p-3"><p className="text-sm font-medium">{presence?.activity || schedule?.title || "暂未记录当前活动"}</p><p className="mt-1 text-xs text-stone-500">地点：{place || "未知"}{!isActual && schedule?.plannedLocationName ? "（计划地点，不代表实时在场）" : ""}</p>{scene && <p className="mt-1 text-[11px] text-[var(--life-accent)]">正在互动场景中</p>}</div>
              <div className="mt-3 flex gap-2"><button type="button" onClick={()=>goToCharacter(character)} disabled={!place} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40">去找 TA</button><button type="button" onClick={()=>{setSelectedActorKey("character:"+character.id);openDaily("plans");}} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">看日程</button></div>
            </article>;
          })}
          {characters.length===0 && <p className="rounded-xl bg-white/60 p-4 text-sm text-stone-500">还没有载入角色。添加角色后，这里会统一显示他们的动态。</p>}
        </div>
      </section>}

      {(tab === "plans" || (tab === "daily" && dailySubtab === "plans")) && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="mb-4 rounded-2xl border border-[#d9c2ae] bg-[#fbf5ee] p-3 sm:p-4">
          <p className="text-sm font-semibold text-stone-800">一句话安排日程</p>
          <p className="mt-1 text-xs leading-relaxed text-stone-500">把安排一次说完，每行一件事。支持“明天下午3点到5点在咖啡馆画画”，也可以写“角色名：周五晚上7点去公园散步”。识别后会生成可继续编辑的日程。</p>
          <textarea value={quickPlanText} onChange={e=>setQuickPlanText(e.target.value)} rows={3} placeholder={"明天下午3点到5点在咖啡馆画画\n周五晚上7点去公园散步"} className="mt-3 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
          <button type="button" onClick={()=>{
            const lines=quickPlanText.split(/\n|；|;/).map(line=>line.trim()).filter(Boolean);
            if(!lines.length){setNotice("先写下你想安排的事情。");return;}
            let next=stateRef.current;const drafts:QuickPlanDraft[]=[];const errors:string[]=[];
            const parseClock=(raw:string, fallbackHour:number)=>{
              const m=raw.trim().match(/^(上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*(\d{1,2})(?:[:：点时](\d{1,2})分?)?$/);
              if(!m)return {hour:fallbackHour,minute:0};
              let hour=Number(m[2]),minute=Number(m[3]||0);const period=m[1]||"";
              if(["下午","傍晚","晚上","夜里"].includes(period)&&hour<12)hour+=12;
              if(["凌晨"].includes(period)&&hour===12)hour=0;
              if(["中午"].includes(period)&&hour<11)hour+=12;
              if(["上午","早上","清晨"].includes(period)&&hour===12)hour=0;
              return {hour:Math.min(23,Math.max(0,hour)),minute:Math.min(59,Math.max(0,minute))};
            };
            for(const line of lines){
              const pref=line.match(/^([^：:]{1,30})[：:]\s*(.+)$/);
              const namedActor=pref?actors.find(a=>a.name.trim()===pref[1].trim()):undefined;
              const actor=namedActor||(selectedActor&&selectedActor.ownerType?selectedActor:actors[0]);
              let body=(pref?pref[2]:line).trim();
              const day=new Date(actorNow(actor));day.setSeconds(0,0);
              if(/后天/.test(body))day.setDate(day.getDate()+2);else if(/明天|明日/.test(body))day.setDate(day.getDate()+1);else if(/今天|今日/.test(body)){}else{
                const weekday=body.match(/周([一二三四五六日天])|星期([一二三四五六日天])/);
                if(weekday){const weekMap:Record<string,number>={"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"日":0,"天":0};const n=weekMap[weekday[1]||weekday[2]]??0;let delta=(n-day.getDay()+7)%7;if(delta===0)delta=7;day.setDate(day.getDate()+delta);}
              }
              const range=body.match(/((?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*\d{1,2}(?:[:：点时]\d{1,2}分?)?)\s*(?:到|至|—|-)\s*((?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*\d{1,2}(?:[:：点时]\d{1,2}分?)?)/);
              const single=body.match(/(?:在|于|约|大概)?\s*((?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*\d{1,2}(?:[:：点时]\d{1,2}分?))/);
              if(!range&&!single){errors.push(line);continue;}
              const startClock=parseClock(range?.[1]||single?.[1]||"",9);
              const endClock=range?parseClock(range[2],startClock.hour+1):{hour:(startClock.hour+1)%24,minute:startClock.minute};if(range&&startClock.hour>=12&&startClock.hour<20&&endClock.hour<startClock.hour&&!/(上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)/.test(range[2]))endClock.hour+=12;
              const start=new Date(day);start.setHours(startClock.hour,startClock.minute,0,0);
              const end=new Date(day);end.setHours(endClock.hour,endClock.minute,0,0);if(end<=start)end.setDate(end.getDate()+1);
              const knownLocation=next.locations.find(loc=>body.includes(loc.name));
              const placeMatch=body.match(/(?:在|去|到|于)\s*([^，,。；;\s]+?)(?=(?:做|和|跟|一起|参加|开会|学习|工作|看|吃|喝|玩|逛|运动|散步|读|写|画|练|休息|睡|聊|见|约|$))/);
              const placeName=knownLocation?.name||placeMatch?.[1];
              let location=knownLocation;
              if(!location&&placeName){location={id:id("location"),name:placeName,description:"从快速日程输入识别的地点",visibility:"public"};next={...next,locations:[...next.locations,location]};}
              let title=body.replace(/后天|明天|明日|今天|今日|周[一二三四五六日天]|星期[一二三四五六日天]/g,"").replace(/((?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*\d{1,2}(?:[:：点时]\d{1,2}分?)?)\s*(?:到|至|—|-)\s*((?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*\d{1,2}(?:[:：点时]\d{1,2}分?)?)/g,"").replace(/(?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*\d{1,2}(?:[:：点时]\d{1,2}分?)/g,"");
              if(placeMatch)title=title.replace(placeMatch[0],"");
              else if(location){for(const prefix of ["在","去","到","于"])title=title.replace(prefix+location.name,"");}
              title=title.replace(/\s+/g," ").replace(/^[，,、\s]+|[，,。；;\s]+$/g,"").trim();
              if(!title)title=location?"在"+location.name+"活动":"日程安排";
              const actual=next.actorStates.find(item=>item.ownerType===actor.ownerType&&item.ownerId===actor.ownerId);
              drafts.push({id:id("quick-plan-draft"),ownerType:actor.ownerType,ownerId:actor.ownerId,startAt:start.toISOString(),endAt:end.toISOString(),title,locationName:location?.name??actual?.actualLocationName??""});
            }
            if(drafts.length){setQuickPlanDrafts(drafts);setNotice("识别出 "+drafts.length+" 条待确认日程。请检查并修改下面的表单，再点击确认保存。");}
            else setNotice("没能识别出时间范围。试试“明天下午3点到5点在咖啡馆画画”，一件事写一行。");
            if(errors.length&&drafts.length)setNotice("识别出 "+drafts.length+" 条；另有 "+errors.length+" 条未识别，请补充明确时间后重新识别。");
          }} className="mt-2 rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white">识别并填入日程</button>
          {quickPlanDrafts.length>0 && <div className="mt-4 rounded-2xl border border-stone-200 bg-white/85 p-3">
            <div className="mb-3 flex items-center justify-between gap-2"><p className="text-sm font-semibold">识别结果 · {quickPlanDrafts.length} 条待保存</p><button type="button" onClick={()=>setQuickPlanDrafts([])} className="text-xs text-stone-500">清空</button></div>
            <div className="space-y-3">{quickPlanDrafts.map((draft,index)=>{const owner=actors.find(actor=>actor.ownerType===draft.ownerType&&actor.ownerId===draft.ownerId);const update=(patch:Partial<QuickPlanDraft>)=>setQuickPlanDrafts(items=>items.map(item=>item.id===draft.id?{...item,...patch}:item));return <div key={draft.id} className="rounded-xl border border-stone-200/80 bg-[#fffdf9] p-3">
              <p className="mb-2 text-xs font-medium text-[var(--life-accent)]">安排 {index+1} · {owner?.name??"角色"}</p>
              <div className="grid gap-2 sm:grid-cols-2"><label className="text-[11px] text-stone-500">开始时间<input type="datetime-local" value={toLocalDateTimeInput(draft.startAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)update({startAt:value});}} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label><label className="text-[11px] text-stone-500">结束时间<input type="datetime-local" value={toLocalDateTimeInput(draft.endAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)update({endAt:value});}} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label></div>
              <label className="mt-2 block text-[11px] text-stone-500">活动内容<input value={draft.title} onChange={e=>update({title:e.target.value})} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/></label>
              <label className="mt-2 block text-[11px] text-stone-500">计划地点<input value={draft.locationName} onChange={e=>update({locationName:e.target.value})} placeholder="可留空" className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/></label>
              <button type="button" onClick={()=>setQuickPlanDrafts(items=>items.filter(item=>item.id!==draft.id))} className="mt-2 text-xs text-rose-600">删除这条</button>
            </div>})}</div>
            <div className="mt-3 flex gap-2"><button type="button" onClick={()=>setQuickPlanDrafts([])} className="flex-1 rounded-xl border border-stone-200 px-3 py-2.5 text-sm">取消</button><button type="button" onClick={()=>{let next=stateRef.current;let saved=0;const invalid:string[]=[];for(const draft of quickPlanDrafts){const start=new Date(draft.startAt);const end=new Date(draft.endAt);if(!draft.title.trim()||!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<=start){invalid.push(draft.title||"未命名安排");continue;}const owner=actors.find(actor=>actor.ownerType===draft.ownerType&&actor.ownerId===draft.ownerId);let location=draft.locationName.trim()?next.locations.find(item=>item.name.trim().toLocaleLowerCase()===draft.locationName.trim().toLocaleLowerCase()):undefined;if(draft.locationName.trim()&&!location){location={id:id("location"),name:draft.locationName.trim(),description:"从快速日程表单添加的地点",visibility:"public"};next={...next,locations:[...next.locations,location]};}const actual=next.actorStates.find(item=>item.ownerType===draft.ownerType&&item.ownerId===draft.ownerId);const slot: LifeScheduleSlot = {id:id("quick-plan"),ownerType:draft.ownerType,ownerId:draft.ownerId,startAt:start.toISOString(),endAt:end.toISOString(),title:draft.title.trim(),plannedLocationId:location?.id??actual?.actualLocationId??undefined,plannedLocationName:location?.name??actual?.actualLocationName??undefined,kind:"free-time",source:"manual",updatedAt:new Date().toISOString()};const inserted=insertManualLifeScheduleSlot(next,slot);if(inserted.conflict){invalid.push(draft.title.trim()+"（与「"+inserted.conflict.title+"」时间冲突）");continue;}if(inserted.error){invalid.push(draft.title.trim()+"（"+inserted.error+"）");continue;}next=inserted.state;next=appendLifeTimelineEntry(next,{category:"schedule",title:(owner?.name??"角色")+"新增日程："+draft.title.trim(),details:fmt(start)+"–"+fmt(end)+(location?" · "+location.name:""),actorId:draft.ownerId,actorName:owner?.name,locationName:location?.name});saved++;}if(saved){commit(next);setQuickPlanDrafts([]);setQuickPlanText("");setNotice("已保存 "+saved+" 条日程。");}if(invalid.length)setNotice("有 "+invalid.length+" 条未保存："+invalid.slice(0,3).join("；")+(invalid.length>3?"；其余原因已省略。":""));}} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm font-medium text-white">确认保存日程</button></div>
          </div>}
        </div>
      </section>}
      {tab === "plans" && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle eyebrow="Weekly plans" title="未来七天的生活日程" note="计划每周生成一次并保存在本地；已有日程不会被重复生成覆盖。点击标题可编辑，计划地点只作为线索。" /><button onClick={ensurePlans} className="inline-flex items-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white"><RefreshCw size={14}/>检查并补全</button></div>
        {actors.map(actor=>{const virtualNow=actorNow(actor);const slots=state.schedules.filter(slot=>slot.ownerType===actor.ownerType&&slot.ownerId===actor.ownerId).sort((a,b)=>a.startAt.localeCompare(b.startAt));return <div key={`${actor.ownerType}:${actor.ownerId}`} className="mb-5"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-[var(--life-accent)]"/>{actor.name}<span className="text-xs font-normal text-stone-400">{slots.length} 条安排</span></h3><button type="button" onClick={()=>addManualPlan(actor)} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">＋ 添加日程</button></div>{slots.length===0?<p className="rounded-xl bg-white/60 p-3 text-sm text-stone-400">还没有日程，可以直接添加，也可以点击「检查并补全」。</p>:<div className="space-y-3">{slots.filter(slot=>new Date(slot.endAt).getTime()>virtualNow.getTime()-DAY_MS).slice(0,40).map(slot=><div key={slot.id} className="rounded-xl border border-stone-200/70 bg-white/65 p-3"><div className="grid gap-2 sm:grid-cols-2"><label className="text-[11px] text-stone-500">开始时间<input aria-label="编辑日程开始时间" type="datetime-local" value={toLocalDateTimeInput(slot.startAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)updateManualPlan(slot,{startAt:value});}} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full min-w-0 rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label><label className="text-[11px] text-stone-500">结束时间<input aria-label="编辑日程结束时间" type="datetime-local" value={toLocalDateTimeInput(slot.endAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)updateManualPlan(slot,{endAt:value});}} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full min-w-0 rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label><label className="text-[11px] text-stone-500 sm:col-span-2">事件 / 活动内容<input aria-label="编辑日程标题" value={slot.title} onChange={e=>updateManualPlan(slot,{title:e.target.value})} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full min-w-0 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="text-[11px] text-stone-500 sm:col-span-2">地点（可自由填写）<input aria-label="编辑日程地点" value={slot.plannedLocationName??""} placeholder="输入地点名称，不必先创建地点" onChange={e=>updateManualPlan(slot,{plannedLocationName:e.target.value})} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full min-w-0 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/></label></div><div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-stone-400">{slot.kind} · {slot.source==="manual"?"手动日程":slot.source==="character-tool"?"角色主动调整":"可编辑计划"}</span><button type="button" onClick={()=>deleteManualPlan(slot)} className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-[11px] text-stone-500">删除</button></div></div>)}</div>}</div>;})}
      </section>}



      {tab === "invitations" && <div className="grid gap-4 lg:grid-cols-[.85fr_1.15fr]">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Make a plan together" title="创建邀约" note="你发出的邀约由角色根据人设和日程决定是否接受；角色主动发出的邀约由你决定是否接受。双方同意后才同步日程，不会瞬间跳到约定时间。" />
          <form onSubmit={addInvitation} className="space-y-3"><label className="block text-sm">邀请谁<select value={inviteCharacterId} onChange={e=>setInviteCharacterId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="">选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="block text-sm">事件 / 活动<input value={inviteActivity} onChange={e=>setInviteActivity(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">邀约理由<textarea value={inviteReason} onChange={e=>setInviteReason(e.target.value)} placeholder="例如：最近想和你聊聊，或者想把这件有趣的事分享给你" rows={2} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">时间<input type="datetime-local" value={inviteAt} onChange={e=>{setInviteAtEdited(true);setInviteAt(e.target.value)}} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/><span className="mt-1 block text-[11px] text-stone-500">默认按你的虚拟时间预填；双方时钟不同步时，系统仍会分别检查是否来得及赴约。</span></label><label className="block text-sm">地点<select value={inviteLocationId} onChange={e=>setInviteLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label><button disabled={busy} className="w-full rounded-2xl bg-[var(--life-accent)] px-4 py-3 text-sm font-medium text-white disabled:opacity-50">{busy?"等待角色回应…":"发出邀约"}</button></form>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Invitation inbox" title="邀约记录" />
          {state.invitations.length===0?<p className="rounded-2xl bg-white/60 p-4 text-sm text-stone-400">这里会保存待确认、已确认和已取消的邀约。</p>:<div className="space-y-3">{state.invitations.map(invite=>{const char=characters.find(c=>c.id===invite.characterId);const editable=invite.status==="proposed"||invite.status==="confirmed";const editing=editingInvitationId===invite.id;return <div key={invite.id} className="rounded-2xl border border-stone-200/70 bg-white/70 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium">{char?.name??"未知角色"} · {invite.kind==="follow-request"?"陪伴申请":"邀约"} · {invite.activity}</p><p className="mt-1 text-xs text-stone-500">{fmt(invite.proposedAt)} · {invite.kind==="follow-request"?(invite.durationMinutes??120)+" 分钟 · 跟随你的实际行程":invite.locationName??"地点待定"} · {invite.durationMinutes??60} 分钟</p>{invite.reason&&<p className="mt-1 text-xs leading-relaxed text-stone-600">理由：{invite.reason}</p>}{invite.responseReason&&<p className="mt-1 text-xs leading-relaxed text-stone-600">回应：{invite.responseReason}</p>}</div><span className="shrink-0 rounded-full bg-[#f0e3d5] px-2.5 py-1 text-[11px]">{(invite.status==="proposed"&&invite.proposedBy==="player"?"等待角色回应":({proposed:"待确认",confirmed:"已确认",declined:"已拒绝",cancelled:"已取消",completed:"已完成"} as Record<string,string>)[invite.status])}</span></div>{editing&&<div className="mt-4 grid gap-3 rounded-2xl bg-[#faf5ef] p-3"><label className="block text-xs">活动内容<input value={editInvitationDraft.activity} onChange={e=>setEditInvitationDraft(d=>({...d,activity:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="block text-xs">邀约理由<textarea value={editInvitationDraft.reason} onChange={e=>setEditInvitationDraft(d=>({...d,reason:e.target.value}))} rows={2} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="block text-xs">时间<input type="datetime-local" value={editInvitationDraft.proposedAt} onChange={e=>setEditInvitationDraft(d=>({...d,proposedAt:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="block text-xs">持续时长（分钟）<input type="number" min={15} max={1440} step={15} value={editInvitationDraft.durationMinutes} onChange={e=>setEditInvitationDraft(d=>({...d,durationMinutes:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label>{invite.kind!=="follow-request"&&<label className="block text-xs">地点<select value={editInvitationDraft.locationId} onChange={e=>setEditInvitationDraft(d=>({...d,locationId:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">{state.locations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label>}<div className="flex gap-2"><button type="button" onClick={()=>saveInvitationEdit(invite.id)} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">保存并同步日程</button><button type="button" onClick={()=>setEditingInvitationId(null)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">取消编辑</button></div></div>}{!editing&&<div className="mt-3 flex flex-wrap gap-2">{invite.status==="proposed"&&invite.proposedBy!=="player"&&<><button onClick={()=>confirmInvitation(invite.id)} className="rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">{invite.kind==="follow-request"?"接受陪伴申请":"确认并同步日程"}</button><button onClick={()=>declineInvitation(invite.id)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">拒绝</button></>}{editable&&<button onClick={()=>beginEditInvitation(invite.id)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">编辑 / 重新安排</button>}{editable&&<button onClick={()=>cancelInvitation(invite.id)} className="rounded-xl border border-red-200 px-3 py-2 text-xs text-red-600">取消邀约</button>}{(invite.status==="declined"||invite.status==="cancelled")&&<button onClick={()=>reuseInvitation(invite.id)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">复制并重新发起</button>}</div>}</div>;})}</div>}
        </section>
      </div>}

      {tab === "experiences" && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <SectionTitle eyebrow="Shared memories" title="共同经历" note="这里按实际发生时间整理生活记录。你可以按角色、日期或事件类型筛选；隐藏记录只影响显示，不会删除原始数据。" />
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs font-medium text-stone-600">参与角色
            <select value={experienceActorFilter} onChange={event => setExperienceActorFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
              <option value="all">所有角色</option>
              {actors.map(actor => <option key={actor.ownerType + ":" + actor.ownerId} value={actor.ownerId}>{actor.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-stone-600">记录类型
            <select value={experienceCategoryFilter} onChange={event => setExperienceCategoryFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
              <option value="all">全部类型</option>
              <option value="location">地点变化</option><option value="scene">场景</option><option value="action">行动</option><option value="dialogue">对话</option><option value="schedule">日程</option><option value="tool">工具</option><option value="social">社交动态</option><option value="diary">日记</option><option value="chat">消息</option><option value="system">系统记录</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-stone-600">指定日期
            <input type="date" value={experienceDateFilter} onChange={event => setExperienceDateFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
          </label>
          <label className="block text-xs font-medium text-stone-600">分组方式
            <select value={experienceGroupBy} onChange={event => setExperienceGroupBy(event.target.value as "date" | "character")} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
              <option value="date">按日期分组</option><option value="character">按角色分组</option>
            </select>
          </label>
        </div>
        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-stone-500"><span>找到 {experienceTimeline.length} 条记录</span><button type="button" onClick={() => { setExperienceActorFilter("all"); setExperienceCategoryFilter("all"); setExperienceDateFilter(""); setExperienceGroupBy("date"); }} className="rounded-lg border border-stone-200 bg-white px-3 py-1.5">重置筛选</button></div>
        {sortedExperienceGroups.length === 0 ? <div className="rounded-2xl bg-white/65 p-8 text-center"><p className="text-sm font-medium text-stone-700">还没有符合条件的经历</p><p className="mt-1 text-xs text-stone-500">开始行动、聊天或一起参加活动后，记录会逐渐出现在这里。</p></div> : <div className="max-h-[62dvh] space-y-4 overflow-y-auto overscroll-contain touch-pan-y pr-1" style={{ WebkitOverflowScrolling: "touch" }}>
          {sortedExperienceGroups.map(([groupKey, entries]) => <section key={groupKey} className="overflow-hidden rounded-2xl border border-stone-200/70 bg-white/60">
            <h3 className="border-b border-stone-200/70 bg-[#fbf7f0] px-4 py-3 text-sm font-semibold text-stone-700">{experienceGroupBy === "date" ? (groupKey === "日期未知" ? groupKey : new Date(groupKey + "T12:00:00").toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })) : groupKey}</h3>
            <div className="space-y-2 p-3">{entries.map(entry => <article key={entry.id} className="flex gap-3 rounded-xl bg-white/85 p-3">
              <span className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums text-stone-400">{new Date(entry.occurredAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-stone-800">{entry.title}</p>{entry.details && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600">{entry.details}</p>}
                <p className="mt-1 text-[10px] text-stone-400">{experienceGroupBy === "character" ? localDateKey(entry.occurredAt) + " · " : ""}{entry.actorName ? entry.actorName + " · " : ""}{entry.locationName ? entry.locationName + " · " : ""}{entry.category === "location" ? "地点变化" : entry.category === "scene" ? "场景" : entry.category === "action" ? "行动" : entry.category === "dialogue" ? "对话" : entry.category === "schedule" ? "日程" : entry.category === "tool" ? "工具" : entry.category === "social" ? "社交动态" : entry.category === "diary" ? "日记" : entry.category === "chat" ? "消息" : "生活记录"}</p>{timelineImageUrls[entry.id]&&<img src={timelineImageUrls[entry.id]} alt={entry.title} className="mt-2 max-h-56 w-auto max-w-full rounded-xl object-contain"/>}<button type="button" disabled={Boolean(timelineImageBusyId)} onClick={()=>void generateTimelineImage(entry)} className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-600 disabled:opacity-50"><Sparkles size={12}/>{timelineImageBusyId===entry.id?"正在生成…":entry.imageMediaRef?"重新生成图片":"生成场景图片"}</button>
              </div>
            </article>)}</div>
          </section>)}
        </div>}
      </section>}
      {tab === "settings" && <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Behavior switches" title="生活模拟规则" note="你可以把它调成轻量陪伴，也可以打开更多自主生活细节。" />
          <div className="space-y-2">
            <Toggle checked={settings.enabled} onChange={v=>patchSettings({enabled:v})} label="启用虚拟生活引擎" hint="关闭后保留数据，但暂停新生活场景功能。"/>
            <Toggle checked={settings.autoGenerateWeeklyPlans} onChange={v=>patchSettings({autoGenerateWeeklyPlans:v})} label="自动生成每周日程"/>
            <Toggle checked={settings.generateSpecialEvents} onChange={v=>patchSettings({generateSpecialEvents:v})} label="允许偶发特殊事件"/>
            <Toggle checked={settings.enableCoincidences} onChange={v=>patchSettings({enableCoincidences:v})} label="启用偶遇与注意力判断" hint="关闭后场景仍可互动，但不做随机偶遇判断。"/>
            <Toggle checked={settings.enableCharacterAutonomy} onChange={v=>patchSettings({enableCharacterAutonomy:v})} label="允许角色自主行动"/>
            <p className="ml-3 rounded-xl bg-white/60 p-3 text-xs leading-relaxed text-stone-500">具体生活工具的独立开关已放入现场聊天工具箱；这里仅保留角色自主行动总开关。</p>

            <Toggle checked={settings.saveConfirmedEventsToMemory} onChange={v=>patchSettings({saveConfirmedEventsToMemory:v})} label="将已发生的事件写入生活记忆"/>
            <Toggle checked={settings.showActionNarration} onChange={v=>patchSettings({showActionNarration:v})} label="显示简短动作旁白"/>
            <Toggle checked={settings.keepDialogueConcise} onChange={v=>patchSettings({keepDialogueConcise:v})} label="默认保持短回合对话"/>
            <Toggle checked={settings.allowCharactersToStaySilent} onChange={v=>patchSettings({allowCharactersToStaySilent:v})} label="允许角色沉默或专注做自己的事"/>
            <Toggle checked={settings.showTimeline} onChange={v=>patchSettings({showTimeline:v})} label="显示日程时间线"/>
            <Toggle checked={settings.showLocationHints} onChange={v=>patchSettings({showLocationHints:v})} label="显示计划地点线索"/>
            <div className="mt-3 rounded-2xl border border-stone-200/70 bg-white/60 p-3"><p className="mb-2 text-xs font-semibold text-stone-700">生活记录显示筛选</p><div className="space-y-2">
              <Toggle checked={settings.recordLocationChanges} onChange={v=>patchSettings({recordLocationChanges:v})} label="地点与场景变化"/>
              <Toggle checked={settings.recordCharacterActions} onChange={v=>patchSettings({recordCharacterActions:v})} label="我和角色的行动"/>
              <Toggle checked={settings.recordSceneMessages} onChange={v=>patchSettings({recordSceneMessages:v})} label="生活现场的对话气泡"/>
              <Toggle checked={settings.recordChatActivity} onChange={v=>patchSettings({recordChatActivity:v})} label="消息 APP 聊天动态"/>
              <Toggle checked={settings.recordSocialActivity} onChange={v=>patchSettings({recordSocialActivity:v})} label="朋友圈动态"/>
              <Toggle checked={settings.recordDiaryActivity} onChange={v=>patchSettings({recordDiaryActivity:v})} label="日记动态"/>
              <Toggle checked={settings.recordToolCalls} onChange={v=>patchSettings({recordToolCalls:v})} label="角色调用工具"/>
              <Toggle checked={settings.recordScheduleChanges} onChange={v=>patchSettings({recordScheduleChanges:v})} label="日程与时间变化"/>
            </div><p className="mt-2 text-[10px] leading-relaxed text-stone-500">关闭某一项只会将该类记录从时间线隐藏，不会删除已保存的记录。</p></div>
            <div className="mt-4 rounded-2xl border border-[var(--life-accent)]/25 bg-white/70 p-4">
              <p className="text-sm font-semibold">生活现场主动性</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">角色与玩家同处一个正在进行的场景时，可以在没有新输入的情况下自主发起简短互动。系统有冷却和每日上限，不会每隔几秒强制刷消息。</p>
              <div className="mt-3"><Toggle checked={settings.enableProactiveSceneMessages !== false} onChange={v=>patchSettings({enableProactiveSceneMessages:v})} label="允许角色在生活现场主动说话"/></div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="block min-w-0 text-xs text-stone-600">最短间隔（分钟）
                  <input type="number" inputMode="numeric" min={2} max={60} step={1} value={settings.proactiveSceneIntervalMinutes ?? 5} onChange={e=>{const min=Math.max(2,Math.min(60,Number(e.target.value)||2));patchSettings({proactiveSceneIntervalMinutes:min,proactiveSceneIntervalMaxMinutes:Math.max(min,settings.proactiveSceneIntervalMaxMinutes??15)});}} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/>
                </label>
                <label className="block min-w-0 text-xs text-stone-600">最长间隔（分钟）
                  <input type="number" inputMode="numeric" min={2} max={60} step={1} value={settings.proactiveSceneIntervalMaxMinutes ?? 15} onChange={e=>{const max=Math.max(settings.proactiveSceneIntervalMinutes??5,Math.min(60,Number(e.target.value)||2));patchSettings({proactiveSceneIntervalMaxMinutes:max});}} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/>
                </label>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-stone-500">每次自主互动会在最短与最长间隔之间随机安排，不再固定按同一个周期触发。</p>
              <div className="mt-3"><Toggle checked={settings.enableLifeMessageNotifications !== false} onChange={async v=>{if(v && typeof Notification!=="undefined" && Notification.permission==="default"){try{await Notification.requestPermission();}catch{/* permission prompt may be unavailable in WebView */}}patchSettings({enableLifeMessageNotifications:v});}} label="主动消息弹窗提示"/></div>
              <div className="mt-3"><Toggle checked={settings.enableLifeOfflinePush !== false} onChange={v=>patchSettings({enableLifeOfflinePush:v})} label="后台/关闭应用时继续主动推送" hint="需要已配置推送订阅和服务端任务；关闭后只在前台生活现场主动互动。"/></div>
              <p className="mt-2 text-[10px] leading-relaxed text-stone-500">前台优先在生活现场生成；进入后台或应用被关闭时，会尝试交给已配置的服务端离线推送任务。需要先启用推送订阅与个人 Supabase/自部署推送服务；无订阅时只保留前台主动性。离线生成结果会在下次打开应用后合并回原生活场景，不写入线上聊天记录。</p>
            </div>
            <Toggle checked={settings.enableAmbientDetails} onChange={v=>patchSettings({enableAmbientDetails:v})} label="启用环境细节"/>
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--life-accent)]/25 bg-white/70 p-4">
            <p className="text-sm font-semibold">角色可调用的生活工具</p>
            <p className="mt-1 text-xs leading-relaxed text-stone-500">这些工具不需要你手动替角色创建。角色在生活现场或消息 APP 私聊中有真实动机时，可以自己发起；只有需要你参与的邀约和陪伴申请才会进入待确认列表。</p>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3"><div><code>life_propose_invitation</code><p className="mt-1 text-stone-500">角色主动邀约你一起做某件事</p></div><span className={settings.enableCharacterAutonomy&&settings.enableInvitations?"text-emerald-700":"text-stone-400"}>{settings.enableCharacterAutonomy&&settings.enableInvitations?"已启用":"已关闭"}</span></div>
              <div className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3"><div><code>life_request_follow</code><p className="mt-1 text-stone-500">角色主动申请陪伴，并跟随你的实际行程</p></div><span className={settings.enableCharacterAutonomy&&settings.enableFollowRequestTool?"text-emerald-700":"text-stone-400"}>{settings.enableCharacterAutonomy&&settings.enableFollowRequestTool?"已启用":"已关闭"}</span></div>
              <div className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3"><div><code>life_change_schedule</code><p className="mt-1 text-stone-500">角色调整自己当天未开始的普通日程</p></div><span className={settings.enableCharacterAutonomy&&settings.enableScheduleChangeTool?"text-emerald-700":"text-stone-400"}>{settings.enableCharacterAutonomy&&settings.enableScheduleChangeTool?"已启用":"已关闭"}</span></div>
            </div>
          </div>
          <label className="mt-4 block text-sm">位置情报权限<select value={settings.revealExactLocations} onChange={e=>patchSettings({revealExactLocations:e.target.value as LifeEngineSettings["revealExactLocations"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="ask-only">只有询问或可靠渠道才能得知精确位置</option><option value="clues">默认只显示习惯与模糊线索</option><option value="open">允许公开查看实际位置</option></select></label>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle eyebrow="Appearance & comfort" title="界面自定义" note="外观设置独立保存，不会影响角色数据或原有聊天主题。" />
          <label className="mb-4 block text-sm">玩家显示名称<input value={playerName} onChange={e=>patchSettings({playerDisplayName:e.target.value})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="mb-4 block text-sm">场景主题<select value={settings.sceneTheme} onChange={e=>patchSettings({sceneTheme:e.target.value as LifeEngineSettings["sceneTheme"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="warm-paper">暖米棕纸感</option><option value="sage">鼠尾草绿</option><option value="rose">柔和玫瑰</option><option value="night-sky">夜空深色</option></select></label>
          <label className="mb-4 flex items-center justify-between gap-3 text-sm">强调色<input type="color" value={settings.accentColor} onChange={e=>patchSettings({accentColor:e.target.value})} className="h-10 w-16 rounded-lg border-0 bg-transparent"/></label>
          <label className="mb-4 block text-sm">面板不透明度：{settings.panelOpacity}%<input type="range" min="50" max="100" value={settings.panelOpacity} onChange={e=>patchSettings({panelOpacity:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">对白字号（px）<input key={settings.dialogueFontSize} type="number" inputMode="numeric" min="8" max="48" defaultValue={settings.dialogueFontSize} onBlur={e=>patchSettings({dialogueFontSize:Math.max(8,Math.min(48,Number(e.currentTarget.value)||16))})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">动作旁白字号（px）<input key={settings.narrationFontSize} type="number" inputMode="numeric" min="8" max="36" defaultValue={settings.narrationFontSize} onBlur={e=>patchSettings({narrationFontSize:Math.max(8,Math.min(36,Number(e.currentTarget.value)||14))})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">气泡内边距（px）<input key={settings.bubblePadding} type="number" inputMode="numeric" min="0" max="24" defaultValue={settings.bubblePadding} onBlur={e=>patchSettings({bubblePadding:Math.max(0,Math.min(24,Number(e.currentTarget.value)||0))})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">对白字体（CSS font-family）<input value={settings.dialogueFontFamily} onChange={e=>patchSettings({dialogueFontFamily:e.target.value})} placeholder="系统默认 / Arial / sans-serif" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">旁白字体（CSS font-family）<input value={settings.narrationFontFamily} onChange={e=>patchSettings({narrationFontFamily:e.target.value})} placeholder='"Microsoft YaHei", sans-serif' className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
          <Toggle checked={settings.compactLayout} onChange={v=>patchSettings({compactLayout:v})} label="紧凑布局"/>
           <div className="mt-4 rounded-2xl border border-stone-200 bg-[#f8f4ee] p-3">
             <p className="mb-2 text-sm font-semibold text-stone-700">聊天显示实时预览</p>
             <p className="mb-3 text-xs text-stone-500">调整参数会即时更新预览并应用到生活聊天室；聊天室本身不再放置这组设置，把空间留给互动。</p>
             <div className="life-scene-chat flex min-w-0 flex-col rounded-xl bg-white/80 p-2" style={{fontSize:"var(--life-font)",rowGap:`${settings.messageGapPx ?? 4}px`}}>
               <div className="flex items-center gap-2" style={{marginBlock:`${settings.narrationGapPx ?? 4}px`}}><span className="h-px flex-1 bg-stone-300/80"/><p className="max-w-[82%] text-center italic leading-relaxed text-stone-500" style={{fontSize:`${settings.narrationFontSize}px`,fontFamily:settings.narrationFontFamily || undefined}}>轻轻推开门，走到窗边坐下。</p><span className="h-px flex-1 bg-stone-300/80"/></div>
               <div className="flex justify-start"><div className={`life-scene-bubble min-w-0 max-w-[88%] break-words bg-white text-stone-800 shadow-sm ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"}`} style={{fontSize:`${settings.dialogueFontSize}px`,fontFamily:settings.dialogueFontFamily || undefined,padding:`${settings.bubblePadding}px`}}><p className="mb-0.5 text-[10px] font-semibold text-[var(--life-accent)]">角色示例</p><p>这样就能预览字号、气泡、间距和字体效果。</p></div></div>
               <div className="flex justify-end"><div className={`life-scene-bubble min-w-0 max-w-[88%] break-words bg-[#e9d4c0] text-stone-800 ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"}`} style={{fontSize:`${settings.dialogueFontSize}px`,fontFamily:settings.dialogueFontFamily || undefined,padding:`${settings.bubblePadding}px`}}>玩家示例消息</div></div>
             </div>
           </div>
           <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
             <label className="block min-w-0 text-sm">消息间距（px）<input key={settings.messageGapPx ?? 4} type="number" inputMode="numeric" min="0" max="24" defaultValue={settings.messageGapPx ?? 4} onBlur={e=>patchSettings({messageGapPx:Math.max(0,Math.min(24,Number(e.currentTarget.value)||0))})} className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
             <label className="block min-w-0 text-sm">旁白间距（px）<input key={settings.narrationGapPx ?? 4} type="number" inputMode="numeric" min="0" max="24" defaultValue={settings.narrationGapPx ?? 4} onBlur={e=>patchSettings({narrationGapPx:Math.max(0,Math.min(24,Number(e.currentTarget.value)||0))})} className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
             <label className="block min-w-0 text-sm">对白气泡形状<select value={settings.dialogueBubbleStyle} onChange={e=>patchSettings({dialogueBubbleStyle:e.target.value as LifeEngineSettings["dialogueBubbleStyle"]})} className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"><option value="rounded">圆润</option><option value="soft">柔和大圆角</option><option value="square">方形</option></select></label>
             <label className="block min-w-0 text-sm">旁白 / 场景卡片字体<input value={settings.narrationFontFamily} onChange={e=>patchSettings({narrationFontFamily:e.target.value})} placeholder='"Microsoft YaHei", sans-serif' className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
           </div>
           <label className="mt-4 block min-w-0 text-sm">自定义 CSS（仅生活聊天室）<textarea value={settings.customSceneCss ?? ""} onChange={e=>patchSettings({customSceneCss:e.target.value})} rows={5} spellCheck={false} placeholder=".life-scene-bubble { padding: 6px 9px !important; max-width: 76% !important; }" className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white p-3 font-mono text-xs"/></label>
           <p className="mt-1 text-xs leading-relaxed text-stone-500">可用类名：.life-scene-chat、.life-scene-bubble、.life-scene-composer。CSS 即时保存并应用；预览用于快速检查常见样式。</p>

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
              {activeScene&&<div><p className="mb-1 text-sm">本次画面角色</p><div className="flex flex-wrap gap-2">{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerType===p.ownerType&&a.ownerId===p.ownerId);const checked=imageParticipantIds.length===0?p.ownerType==="character":imageParticipantIds.includes(p.ownerId);return <label key={p.ownerType+":"+p.ownerId} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs"><input type="checkbox" checked={checked} onChange={e=>setImageParticipantIds(prev=>{const current=prev.length?prev:activeScene.participants.filter(item=>item.ownerType==="character").map(item=>item.ownerId);return e.target.checked?[...new Set([...current,p.ownerId])]:current.filter(id=>id!==p.ownerId)})}/>{actor?.name??p.ownerId}</label>;})}</div></div>}              {activeScene?.images?.some(image=>image.status==="archived")&&<div className="mt-3 border-t border-stone-200 pt-3"><p className="mb-2 text-sm font-medium">旧图归档 · 可恢复或删除</p><div className="space-y-2">{activeScene.images.filter(image=>image.status==="archived").map(image=><div key={image.id} className="flex items-center gap-2 rounded-xl bg-white/80 p-2">{imageObjectUrls[image.id]?<img src={imageObjectUrls[image.id]} alt={image.alt||""} className="h-12 w-12 rounded-lg object-cover"/>:<div className="h-12 w-12 rounded-lg bg-stone-100"/>}<span className="min-w-0 flex-1 truncate text-[11px] text-stone-500">{new Date(image.createdAt).toLocaleString("zh-CN")}</span><button type="button" onClick={()=>setSceneImageStatus(image.id,"active")} className="rounded-lg bg-stone-100 px-2 py-1.5 text-[11px]">恢复</button><button type="button" onClick={()=>{if(window.confirm("永久删除这张旧图并清理媒体缓存？"))void removeSceneImage(image.id)}} className="rounded-lg px-2 py-1.5 text-[11px] text-red-600">删除</button></div>)}</div></div>}
            </div>
          </div>
          <section className="mt-4 rounded-2xl border border-[var(--life-accent)]/25 bg-white/70 p-4">
            <SectionTitle eyebrow="Prompt studio" title="生活系统提示词与预设" note="生活预设与小手机原有预设体系衔接：可以导入某个小手机预设里已启用的提示词作为基础，再在这里直接修改。只导入文本，不会改动原预设，也不会覆盖角色卡或世界书。"/>
            <div className="flex flex-wrap gap-2">
              <select value={activePromptPreset.id} onChange={event => selectLifePromptPreset(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
                {(promptPresets.length ? promptPresets : [{ id: "life-default", name: "生活现场默认预设" }]).map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
              <button type="button" onClick={createLifePromptPreset} className="rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm text-white"><Plus size={14} className="mr-1 inline"/>新建</button>
              <button type="button" onClick={deleteActiveLifePromptPreset} disabled={promptPresets.length <= 1} className="rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm disabled:opacity-40"><Trash2 size={14} className="mr-1 inline"/>删除</button>
            </div>
            <label className="mt-3 block text-sm font-medium">预设名称<input value={activePromptPreset.name} onChange={event => patchActivePromptPreset({ name: event.target.value })} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label>
            <div className="mt-3 rounded-xl border border-stone-200 bg-white/80 p-3">
              <p className="text-sm font-semibold">从小手机现有预设导入</p>
              <p className="mt-1 text-xs text-stone-500">导入其启用的提示词文本，作为生活场景的额外上下文；之后可以自由改写。</p>
              <div className="mt-2 flex gap-2"><select value={selectedPhonePresetId} onChange={event => setSelectedPhonePresetId(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"><option value="">选择小手机预设…</option>{phonePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}{preset.builtIn ? " · 内置" : ""}</option>)}</select><button type="button" onClick={importPhonePromptPreset} disabled={!phonePresets.length} className="shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm disabled:opacity-40">导入提示词</button></div>
              {activePromptPreset.sourcePresetName && <p className="mt-2 text-[11px] text-stone-500">当前基础文本来源：{activePromptPreset.sourcePresetName}（已复制为独立文本，修改不会反向影响原预设）</p>}
            </div>
            <label className="mt-4 block text-sm font-medium">导入的小手机提示词 / 基础上下文<textarea value={activePromptPreset.basePresetPrompt ?? ""} onChange={event => patchActivePromptPreset({ basePresetPrompt: event.target.value })} rows={5} placeholder="可直接粘贴小手机预设中的规则、格式约定或角色互动约束。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">生活现场输出协议<textarea value={activePromptPreset.sceneOutputPrompt ?? LIFE_SCENE_OUTPUT_CONTRACT} onChange={event => patchActivePromptPreset({ sceneOutputPrompt: event.target.value })} rows={10} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">角色行为 / 沉浸感补充规则<textarea value={activePromptPreset.sceneBehaviorPrompt ?? ""} onChange={event => patchActivePromptPreset({ sceneBehaviorPrompt: event.target.value })} rows={4} placeholder="角色如何使用场景、道具、习惯和空间；如何保持自然互动、不抢玩家控制权……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">每轮回应任务提示词<textarea value={activePromptPreset.sceneTaskPrompt ?? ""} onChange={event => patchActivePromptPreset({ sceneTaskPrompt: event.target.value })} rows={3} placeholder="留空使用默认任务。可用占位符：{characterName}、{playerName}、{locationName}。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">生活工具调用完整提示词<textarea value={activePromptPreset.toolCallingPrompt ?? ""} onChange={event => patchActivePromptPreset({ toolCallingPrompt: event.target.value })} rows={7} placeholder="留空使用系统默认的邀约、陪伴申请和日程调整工具说明。填写后将替换默认工具调用说明。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">日程生成补充规则<textarea value={activePromptPreset.scheduleGenerationPrompt ?? ""} onChange={event => patchActivePromptPreset({ scheduleGenerationPrompt: event.target.value })} rows={4} placeholder="补充角色职业、世界观、生活规律和地点偏好关键词；日程仍会优先参考角色卡与已保存地点库。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">邀约接受 / 拒绝判断提示词<textarea value={activePromptPreset.invitationResponsePrompt ?? ""} onChange={event => patchActivePromptPreset({ invitationResponsePrompt: event.target.value })} rows={4} placeholder="留空使用默认规则。可以自定义角色如何结合人设、关系、日程和真实意愿决定是否赴约。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">地点习惯执行规则<textarea value={activePromptPreset.locationHabitPrompt ?? ""} onChange={event => patchActivePromptPreset({ locationHabitPrompt: event.target.value })} rows={4} placeholder="例如：把地点习惯当作倾向而非强制脚本；习惯可以被新事件改变，但不要无缘无故遗忘长期习惯。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <label className="mt-4 block text-sm font-medium">此预设的通用补充规则<textarea value={activePromptPreset.customPrompt ?? ""} onChange={event => patchActivePromptPreset({ customPrompt: event.target.value })} rows={4} placeholder="只作用于当前生活预设。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
            <p className="mt-3 text-[11px] leading-relaxed text-stone-500">注意：场景输出协议、角色行为规则、地点习惯规则和小手机预设基础文本会实际加入生活现场生成请求；日程生成目前采用角色卡画像 + 地点库匹配的本地规则生成，不会伪装成调用了 AI。日程补充规则会参与角色画像关键词匹配。</p>
          </section>
          <label className="mt-4 block text-sm">自定义场景提示词<textarea value={settings.customPrompt} onChange={e=>patchSettings({customPrompt:e.target.value})} rows={5} placeholder="例如：角色更重视生活习惯；不要每次见面都主动热情打招呼……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <button onClick={()=>patchSettings({ ...DEFAULT_LIFE_ENGINE_SETTINGS })} className="mt-4 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm text-stone-600">恢复默认设置</button>
        </section>
      </div>}
      {messageActionTarget && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-stone-950/35 p-3 sm:items-center" onMouseDown={event => { if (event.target === event.currentTarget) setMessageActionTarget(null); }}>
        <section role="dialog" aria-modal="true" aria-label="消息操作" className="w-full max-w-md rounded-3xl border border-white/70 bg-[#fffaf5] p-4 shadow-2xl sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-medium text-[var(--life-accent)]">消息操作</p><h3 className="mt-1 text-base font-semibold text-stone-800">{messageActionTarget.speakerName || "场景消息"}</h3></div><button type="button" onClick={() => setMessageActionTarget(null)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full bg-white text-stone-500"><X size={18}/></button></div>
          {messageActionMode === "menu" && <>
            <p className="mb-4 line-clamp-3 whitespace-pre-wrap rounded-2xl bg-white/80 p-3 text-sm leading-relaxed text-stone-600">{messageActionTarget.dialogue || messageActionTarget.action || "这条记录没有对白文本。"}</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => handleMessageAction("edit")} className="flex items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm"><Pencil size={16}/>编辑消息</button>
              <button type="button" onClick={() => handleMessageAction("delete")} className="flex items-center justify-center gap-2 rounded-xl border border-red-100 bg-white px-3 py-3 text-sm text-red-600"><Trash2 size={16}/>删除消息</button>
              <button type="button" disabled={messageActionTarget.role === "system" || busy} onClick={() => handleMessageAction("regenerate")} className="col-span-2 flex items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-3 text-sm text-white disabled:opacity-40"><RefreshCw size={16}/>{messageActionTarget.role === "player" ? "重新生成对应角色回复" : "重新生成这条角色回复"}</button>
            </div>
            <p className="mt-3 text-center text-[11px] text-stone-400">删除会同步清理这条消息的时间线记录。</p>
          </>}
          {messageActionMode === "edit" && <>
            <label className="mb-3 block text-sm font-medium text-stone-700">动作 / 旁白（可选）<textarea value={messageEditActionDraft} onChange={event => setMessageEditActionDraft(event.target.value)} rows={2} className="mt-2 w-full resize-y rounded-2xl border border-stone-200 bg-white p-3 text-sm leading-relaxed outline-none focus:border-[var(--life-accent)]" placeholder="编辑动作；留空会移除动作。"/></label>
            <label className="block text-sm font-medium text-stone-700">对白内容<textarea autoFocus value={messageEditDraft} onChange={event => setMessageEditDraft(event.target.value)} rows={4} className="mt-2 w-full resize-y rounded-2xl border border-stone-200 bg-white p-3 text-sm leading-relaxed outline-none focus:border-[var(--life-accent)]" placeholder="编辑对白；留空也可以保存。"/></label>
            <div className="mt-3 flex gap-2"><button type="button" onClick={() => setMessageActionMode("menu")} className="flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">返回</button><button type="button" onClick={saveMessageEdit} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm text-white">保存修改</button></div>
          </>}
          {messageActionMode === "delete-confirm" && <>
            <p className="rounded-2xl bg-white/80 p-3 text-sm leading-relaxed text-stone-600">确定删除这条消息吗？关联的行动／对白时间线记录也会一起删除，此操作无法撤销。</p>
            <div className="mt-3 flex gap-2"><button type="button" onClick={() => setMessageActionMode("menu")} className="flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">取消</button><button type="button" onClick={deleteSceneMessage} className="flex-1 rounded-xl bg-red-600 px-3 py-2.5 text-sm text-white">确认删除</button></div>
          </>}
        </section>
      </div>}
      <footer className={`mt-6 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] opacity-55 ${immersiveScene ? "hidden" : ""}`}><span>数据保存在当前设备的 KV 数据库中</span><span>生活时钟按角色独立 · 计划不等于现实 · 场景持续保存</span></footer>
    </div>
  </main>;
}
