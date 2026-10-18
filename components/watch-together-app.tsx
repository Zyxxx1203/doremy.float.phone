"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Expand, ExternalLink, Heart, LoaderCircle, MessageCircle, Pause, Play, Settings2, Sparkles, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import { resolveVoiceConfig, synthesizeSpeech } from "@/lib/tts-service";
import { resolveUserIdentity } from "@/lib/settings-storage";

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Platform = "bilibili" | "youtube" | "tencent" | "youku" | "iqiyi" | "douyin" | "xiaohongshu" | "other";
type VideoTarget = { url: string; embedUrl: string | null; platform: Platform; platformName: string; supported: boolean; nativeVideo?: boolean };
type WatchComment = { id: string; characterId: string; characterName: string; text: string; createdAt: string; kind?: "character" | "user"; timepoint?: string; targetUrl?: string };
type WatchSettings = { characterId: string; intervalMinMinutes: number; intervalMaxMinutes: number; voiceEnabled: boolean; danmakuEnabled: boolean; subtitlesEnabled: boolean; currentMoment: string };

const SETTINGS_KEY = "ai_phone_watch_together_v1";
const COMMENTS_KEY = "ai_phone_watch_together_comments_v1";
const DEFAULT_SETTINGS: WatchSettings = { characterId: "", intervalMinMinutes: 3, intervalMaxMinutes: 8, voiceEnabled: true, danmakuEnabled: true, subtitlesEnabled: true, currentMoment: "" };
function parseVideoUrl(value: string): VideoTarget | null {
  try {
    const source = value.trim();
    const extracted = new RegExp("https?://\\S+", "i").exec(source)?.[0] ?? source;
    const cleanUrl = extracted.replace(/[)\]},，。！？、；;,.!?]+$/u, "");
    const url = new URL(cleanUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const original = url.toString();
    if (new RegExp("\\.(mp4|webm|ogg|ogv|m3u8)$", "i").test(url.pathname)) return { url: original, embedUrl: null, platform: "other", platformName: "视频文件", supported: true, nativeVideo: true };
    if (host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv") {
      const bvid = /\/(BV[0-9A-Za-z]{10})/i.exec(url.pathname)?.[1];
      const aid = /\/av(\d+)/i.exec(url.pathname)?.[1];
      if (bvid) return { url: original, embedUrl: `https://player.bilibili.com/player.html?bvid=${bvid}&page=${url.searchParams.get("p") || "1"}&autoplay=0&danmaku=0`, platform: "bilibili", platformName: "哔哩哔哩", supported: true };
      if (aid) return { url: original, embedUrl: `https://player.bilibili.com/player.html?aid=${aid}&page=1&autoplay=0&danmaku=0`, platform: "bilibili", platformName: "哔哩哔哩", supported: true };
      return { url: original, embedUrl: null, platform: "bilibili", platformName: "哔哩哔哩", supported: false };
    }
    if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
      const id = host === "youtu.be" ? url.pathname.slice(1).split("/")[0] : url.searchParams.get("v") || /\/embed\/([^/]+)/.exec(url.pathname)?.[1] || /\/shorts\/([^/]+)/.exec(url.pathname)?.[1];
      return id ? { url: original, embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=0&playsinline=1`, platform: "youtube", platformName: "YouTube", supported: true } : { url: original, embedUrl: null, platform: "youtube", platformName: "YouTube", supported: false };
    }
    if (host === "v.qq.com" || host.endsWith(".qq.com")) {
      const vid = url.searchParams.get("vid") || /\/([a-zA-Z0-9]+)\.html/.exec(url.pathname)?.[1];
      return vid ? { url: original, embedUrl: `https://v.qq.com/txp/iframe/player.html?vid=${encodeURIComponent(vid)}`, platform: "tencent", platformName: "腾讯视频", supported: true } : { url: original, embedUrl: null, platform: "tencent", platformName: "腾讯视频", supported: false };
    }
    if (host === "youku.com" || host.endsWith(".youku.com")) {
      const id = /id_([^/.]+)\.html/.exec(url.pathname)?.[1];
      return id ? { url: original, embedUrl: `https://player.youku.com/embed/${encodeURIComponent(id)}`, platform: "youku", platformName: "优酷", supported: true } : { url: original, embedUrl: null, platform: "youku", platformName: "优酷", supported: false };
    }
    if (host === "iqiyi.com" || host.endsWith(".iqiyi.com")) return { url: original, embedUrl: null, platform: "iqiyi", platformName: "爱奇艺", supported: false };
    if (host === "douyin.com" || host.endsWith(".douyin.com")) return { url: original, embedUrl: null, platform: "douyin", platformName: "抖音", supported: false };
    if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com") return { url: original, embedUrl: null, platform: "xiaohongshu", platformName: "小红书", supported: false };
    return { url: original, embedUrl: null, platform: "other", platformName: host, supported: false };
  } catch { return null; }
}

function loadSettings(): WatchSettings {
  try {
    const raw = kvGet(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<WatchSettings> & { intervalMinutes?: number };
    return {
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      intervalMinMinutes: Math.max(1, Math.min(60, typeof parsed.intervalMinMinutes === "number" ? parsed.intervalMinMinutes : typeof parsed.intervalMinutes === "number" ? parsed.intervalMinutes : 3)),
      intervalMaxMinutes: Math.max(Math.max(1, Math.min(60, typeof parsed.intervalMinMinutes === "number" ? parsed.intervalMinMinutes : typeof parsed.intervalMinutes === "number" ? parsed.intervalMinutes : 3)), Math.min(60, typeof parsed.intervalMaxMinutes === "number" ? parsed.intervalMaxMinutes : typeof parsed.intervalMinutes === "number" ? Math.min(60, parsed.intervalMinutes + 5) : 8)),
      voiceEnabled: parsed.voiceEnabled !== false,
      danmakuEnabled: parsed.danmakuEnabled !== false,
      subtitlesEnabled: parsed.subtitlesEnabled !== false,
      currentMoment: typeof parsed.currentMoment === "string" ? parsed.currentMoment.slice(0, 800) : "",
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(settings: WatchSettings): void {
  kvSet(SETTINGS_KEY, JSON.stringify(settings));
}
function loadCommentStore(): Record<string, WatchComment[]> {
  try { const raw=kvGet(COMMENTS_KEY); if(!raw) return {}; const parsed=JSON.parse(raw) as Record<string,unknown>; return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, WatchComment[]] => Array.isArray(entry[1]))); }
  catch { return {}; }
}
function loadTargetComments(url: string): WatchComment[] { return loadCommentStore()[url] ?? []; }
function saveTargetComments(url: string, comments: WatchComment[]): void {
  const store=loadCommentStore();
  delete store[url];
  store[url]=comments.slice(-100);
  const keys=Object.keys(store);
  while(keys.length>20){const oldest=keys.shift();if(oldest)delete store[oldest];}
  kvSet(COMMENTS_KEY,JSON.stringify(store));
}

/** Screen orientation locking is not included in every TypeScript DOM lib/browser. */
async function tryLockLandscape(): Promise<void> {
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (value: "landscape") => Promise<void>;
    };
    await orientation.lock?.("landscape");
  } catch {
    // Orientation locking is optional; immersive playback still works without it.
  }
}

export function WatchTogetherApp({ onClose, onNotice }: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<WatchSettings>(() => loadSettings());
  const [urlInput, setUrlInput] = useState("");
  const [target, setTarget] = useState<VideoTarget | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [comments, setComments] = useState<WatchComment[]>([]);
  const [discussionDraft, setDiscussionDraft] = useState("");
  const [timepointDraft, setTimepointDraft] = useState("");
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const originalOrientationRef = useRef<string | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const commentBusyRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);
  const character = characters.find(item => item.id === settings.characterId) ?? characters[0] ?? null;
  const playerIdentity = resolveUserIdentity();

  useEffect(() => {
    const list = loadCharacters();
    setCharacters(list);
    setSettings(current => {
      const next = { ...current, characterId: list.some(item => item.id === current.characterId) ? current.characterId : list[0]?.id ?? "" };
      saveSettings(next);
      return next;
    });
  }, []);
  useEffect(() => { saveSettings(settings); }, [settings]);
  const restoreOrientation = async () => {
    try { screen.orientation?.unlock?.(); } catch { /* orientation lock is optional */ }
    const original = originalOrientationRef.current;
    if (original) {
      try {
        const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> };
        await orientation.lock?.(original);
      } catch { /* Browsers may only permit orientation locks while fullscreen. */ }
    }
    originalOrientationRef.current = null;
  };
  useEffect(() => {
    const onFullscreen = () => {
      const active = Boolean(document.fullscreenElement);
      setFullScreen(active);
      if (!active) void restoreOrientation();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    try { screen.orientation?.unlock?.(); } catch { /* orientation lock is optional */ }
  }, []);

  const patchSettings = (patch: Partial<WatchSettings>) => setSettings(current => ({ ...current, ...patch }));
  const openVideo = () => {
    const parsed = parseVideoUrl(urlInput);
    if (!parsed) { onNotice?.("请粘贴完整的视频分享链接（http/https）。"); return; }
    setTarget(parsed);
    setVideoTitle(current => current || `${parsed.platformName}的一段视频`);
    setComments(loadTargetComments(parsed.url));
    setDiscussionDraft(""); setTimepointDraft("");
    setWatching(false);
    if (!parsed.supported) onNotice?.(`${parsed.platformName}暂不保证站内嵌入播放，已保留原始链接，可尝试在当前 WebView 或外部播放器打开。`);
  };

  const speakComment = async (text: string, characterId: string) => {
    if (!settings.voiceEnabled) return;
    try {
      const voice = resolveVoiceConfig(characterId, "chat");
      if (!voice) { onNotice?.("还没有为这个角色绑定语音方案；可在角色/语音绑定设置中配置。"); return; }
      const blob = await synthesizeSpeech(text, voice);
      if (!blob) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.src = objectUrlRef.current; await audioRef.current.play(); }
    } catch (error) { onNotice?.("角色语音播放失败：" + (error instanceof Error ? error.message : String(error))); }
  };

  const generateComment = useCallback(async (manual = false, momentOverride?: string, timepointOverride?: string) => {
    if (!target || !character || commentBusyRef.current) return;
    commentBusyRef.current = true; setBusy(true);
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `watch-together-${character.id}`, contactId: contact?.id ?? character.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-12).filter(item => item.status !== "failed" && !item.isRetracted);
      const prompt = [
        "你正在和用户一起看视频，是亲密、自然的陪伴，不是影评机器人。",
        `视频平台：${target.platformName}；视频标题（用户可编辑）：${videoTitle || "暂未命名"}。`,
        `视频链接：${target.url}`,
        `用户描述的当前片段/时间点与两人的互动：${(momentOverride ?? settings.currentMoment).trim() || "用户暂未提供具体画面描述"}。`,
        "请结合角色自己的性格、兴趣和你们的关系，写一句自然的即时反应：可以吐槽、惊讶、共情、提问或分享感受。不要声称你真的看到了链接里无法读取的画面；不要编造剧情细节。只输出角色会直接说的话，最多60个汉字。",
      ].join("\n");
      const userMessage: ChatMessage = { id: `watch-${Date.now()}`, sessionId: session.id, role: "user", content: prompt, status: "sent", createdAt: new Date().toISOString() };
      const result = await generateChatCompletion(session, [...history, userMessage], {
        appId: "watch_together", appTags: ["watch_together"], toolsAllowed: false,
        ephemeralSystemNote: "你正在共同观影。不要调用工具、不要复述任务、不要声称直接读取了视频画面。只输出一句自然简短的角色发言。",
      });
      const text = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
      if (!text) return;
      const comment: WatchComment = { id: `comment-${Date.now()}`, characterId: character.id, characterName: character.name, text, createdAt: new Date().toISOString(), kind:"character", timepoint:timepointOverride, targetUrl:target.url };
      setComments(current => { const next=[...current.slice(-99),comment]; saveTargetComments(target.url,next); return next; });
      if (settings.voiceEnabled) void speakComment(text, character.id);
      if (manual) onNotice?.(`${character.name}说了一句。`);
    } catch (error) { onNotice?.("角色观影回应失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { commentBusyRef.current = false; setBusy(false); }
  }, [target, character, videoTitle, settings.currentMoment, settings.voiceEnabled, onNotice]);

  const submitDiscussion = () => {
    const text=discussionDraft.trim(); if(!target||!text) return;
    const timepoint=timepointDraft.trim().slice(0,16);
    const comment:WatchComment={id:`user-${Date.now()}`,characterId:"user",characterName:"我",text,createdAt:new Date().toISOString(),kind:"user",timepoint:timepoint||undefined,targetUrl:target.url};
    setComments(current=>{const next=[...current.slice(-99),comment];saveTargetComments(target.url,next);return next;});
    const moment=[timepoint?`时间点 ${timepoint}`:"",text].filter(Boolean).join("：").slice(0,800);
    patchSettings({currentMoment:moment}); setDiscussionDraft(""); void generateComment(true,moment,timepoint||undefined);
  };

  const actTogether = (cue: string) => {
    const nextMoment = [settings.currentMoment.trim(), cue].filter(Boolean).join("；").slice(0, 800);
    patchSettings({ currentMoment: nextMoment });
    void generateComment(true, nextMoment);
  };

  useEffect(() => {
    if (!watching || !target) return;
    let timer = 0;
    let disposed = false;
    const scheduleNext = () => {
      const min = Math.max(1, Math.min(60, settings.intervalMinMinutes));
      const max = Math.max(min, Math.min(60, settings.intervalMaxMinutes));
      const delayMinutes = min + Math.floor(Math.random() * (max - min + 1));
      timer = window.setTimeout(async () => {
        await generateComment(false);
        if (!disposed) scheduleNext();
      }, delayMinutes * 60_000);
    };
    scheduleNext();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [watching, target, settings.intervalMinMinutes, settings.intervalMaxMinutes, generateComment]);

  /** 全屏进入横屏沉浸模式；退出时尽可能恢复进入前的屏幕方向和播放器布局。 */
  const enterFullscreen = async () => {
    const element = playerRef.current;
    if (!element) return;
    if (!fullScreen) originalOrientationRef.current = screen.orientation?.type ?? null;

    // WebView / 部分移动浏览器没有 Fullscreen API：仍提供可退出的沉浸式布局，
    // 不要让全屏按钮看起来像失效。原生全屏可用时仍优先交给浏览器处理。
    if (fullScreen && !document.fullscreenElement) {
      setFullScreen(false);
      await restoreOrientation();
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      setFullScreen(false);
      await restoreOrientation();
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      return;
    }
    if (typeof element.requestFullscreen !== "function" || document.fullscreenEnabled === false) {
      setFullScreen(true);
      await tryLockLandscape();
      onNotice?.("当前环境不支持系统全屏，已切换沉浸式布局；再次点击右上角按钮可退出。");
      return;
    }
    try {
      await element.requestFullscreen();
      await tryLockLandscape();
    } catch {
      setFullScreen(true);
      await tryLockLandscape();
      onNotice?.("系统拒绝了原生全屏，已切换沉浸式布局；再次点击右上角按钮可退出。");
    }
  };

  const latestComment = comments[comments.length - 1];
  const platformNote = useMemo(() => {
    if (!target) return "";
    if (target.supported) return `已接入${target.platformName}。能否播放取决于平台嵌入政策、登录状态与会员权限。`;
    return `${target.platformName}暂无稳定嵌入播放器，可打开原视频，陪看仍会基于你描述的片段回应。`;
  }, [target]);

  return <div className="watch-together-app pointer-events-auto isolate absolute inset-0 z-[1000] flex min-w-0 flex-col overflow-hidden text-[#f0e6d8]" style={{ background: "linear-gradient(180deg,#e8d8c3 0%,#d8c1a5 48%,#bca084 100%)" }}>
    {/* 弹幕动画：仓库里从未定义过 watchDanmaku，之前那条 animation 是空转，这里补上真实 keyframes */}
    <style>{`\n      .watch-together-main { display:flex; flex-direction:column; }
      @keyframes watchWave { from { transform:scaleY(.45); opacity:.45 } to { transform:scaleY(1.15); opacity:1 } }\n      .watch-player { flex-shrink:0; border:9px solid #342a21!important; border-radius:7px!important; background:#090807; box-shadow:0 0 0 1px rgba(255,247,233,.45),0 7px 0 #8c6847,0 14px 28px rgba(68,44,24,.22)!important; }\n      .watch-link-panel { flex-shrink:0; }\n      .watch-interaction-panel { min-width:0; }\n      @media (orientation: landscape) and (min-width: 700px) {\n        .watch-together-main { display:grid; grid-template-columns:minmax(0, 1.1fr) minmax(300px, .9fr); grid-template-rows:auto minmax(0, auto) minmax(0, 1fr); grid-template-areas:"title interaction" "player interaction" "link interaction"; gap:10px; overflow:hidden; padding-bottom:12px; }\n        .watch-player { grid-area:player; width:100%; max-width:none; align-self:start; }\n        .watch-link-panel { grid-area:link; min-width:0; overflow:auto; }\n        .watch-interaction-panel { grid-area:interaction; min-height:0; overflow-y:auto; overscroll-behavior:contain; margin-top:0!important; }\n      }\n    `}</style>
    <style>{`@keyframes watchDanmaku { 0% { transform: translateX(28%); opacity: 0 } 8% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateX(-150%); opacity: 0 } }`}</style>

    {/* 房间里的一点暖光：模拟落地灯与屏幕溢出的光晕 */}
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-24 top-10 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle, #c98f52 0%, transparent 70%)" }} />
      <div className="absolute -right-20 top-1/3 h-80 w-80 rounded-full opacity-25 blur-3xl" style={{ background: "radial-gradient(circle, #c99a78 0%, transparent 70%)" }} />
    </div>

    <header className="relative z-[1010] flex shrink-0 items-center gap-3 px-4 pb-3 text-[#4e3a2b]" style={{ paddingTop: "max(12px, var(--page-header-safe-top, 48px))" }}>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }} className="grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-white/10 bg-white/5 text-[#e6d8c4] backdrop-blur transition active:scale-95" aria-label="返回"><ArrowLeft size={17}/></button>
      <div className="min-w-0 flex-1">
        <div className="whitespace-nowrap font-serif text-lg tracking-[.08em]">一起看 · 同频</div>
        <div className="truncate whitespace-nowrap text-[10px] tracking-[.08em] text-[#806b57]">把喜欢的内容放上屏幕，和 TA 边看边聊</div>
      </div>
      {character && <div className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5">
        <span className="grid h-6 w-6 place-items-center overflow-hidden rounded-full bg-[#4a3d33] text-[10px] text-[#e6d8c4]">{character.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character.name.slice(0, 1)}</span>
        <span className="max-w-[72px] truncate text-[11px] text-[#d8c9b6]">{character.name}</span>
      </div>}
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowSettings(value => !value); }} className="relative z-[1011] grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center border-b border-[#8f6a5a]/50 bg-[#fffaf2]/60 text-[#6d4e47] transition active:scale-95" aria-label="观影设置" aria-expanded={showSettings}><Settings2 size={17}/></button>
    </header>

    <main className="watch-together-main relative z-[1001] min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8" style={{backgroundImage:"radial-gradient(ellipse at 50% 0%,rgba(255,251,242,.72),transparent 62%)"}}>
      <div className="watch-room-title mx-auto mb-2 w-full max-w-3xl px-1"><div className="flex items-center justify-between gap-3 border-b border-[#b99b80]/40 pb-2 text-[#6d5141]"><div className="min-w-0"><p className="truncate font-serif text-sm">{target ? `一起看《${videoTitle || target.platformName + "的一段视频"}》` : "把想看的内容放上屏幕"}</p><p className="mt-0.5 text-[10px] tracking-wide text-[#8b7665]">{target ? (target.supported ? target.platformName + " · 链接播放" : target.platformName + " · 外部播放") : "等待开始 · 选择视频或粘贴链接"}</p></div><span className="shrink-0 text-[10px] tracking-[.14em] text-[#a18172]">TOGETHER</span></div></div>
      <section
        ref={playerRef}
        className={`watch-player relative mx-auto w-full max-w-3xl overflow-hidden rounded-[26px] border border-white/10 bg-[#0d0b09] ${fullScreen ? "fixed inset-0 z-[2000] h-[100dvh] w-screen max-w-none rounded-none" : ""}`}
        style={{ boxShadow: "0 0 0 1px rgba(255,214,170,.06), 0 28px 70px rgba(0,0,0,.6), 0 0 120px rgba(201,143,82,.16)" }}
      >
        {target?.nativeVideo ? (
          <video key={target.url} src={target.url} controls playsInline className={`${fullScreen ? "h-full w-full aspect-auto" : "aspect-video w-full"} bg-black`} onError={() => onNotice?.("这个视频文件无法在当前浏览器播放，可能是格式不支持或来源限制。")} />
        ) : target?.embedUrl ? (
          <iframe key={target.embedUrl} src={target.embedUrl} title={videoTitle || target.platformName} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" className={`${fullScreen ? "h-full w-full aspect-auto" : "aspect-video w-full"} border-0`} />
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center px-6 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-full border border-white/15 bg-white/5 text-[#d9b489]">
              {target ? <ExternalLink size={24}/> : <Play size={24}/>}
            </div>
            <div className="mt-5 font-serif text-lg tracking-wide text-[#efe2d0]">{target ? `${target.platformName}需要外部打开` : "把想看的放上屏幕"}</div>
            <p className="mt-2 max-w-xs text-[11px] leading-6 text-[#9c9086]">
              {target ? "这个平台没有稳定的通用嵌入方式。打开原视频后回来，TA 依然会陪着你聊。" : "粘贴一个视频链接，找个舒服的时刻，把这一段时间留给你们两个人。"}
            </p>
            {target && <button onClick={() => window.open(target.url, "_blank", "noopener,noreferrer")} className="mt-5 flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs text-[#e6d8c4] transition active:scale-95"><ExternalLink size={13}/>打开原视频</button>}
          </div>
        )}

        {target?.embedUrl && settings.danmakuEnabled && comments.length > 0 && <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {comments.slice(-6).map((comment, index) => <div key={comment.id} className="absolute right-2 max-w-[88%] whitespace-nowrap rounded-full bg-black/35 px-3 py-1 text-[13px] text-white/95 drop-shadow" style={{ top: `${14 + index * 12}%`, animation: "watchDanmaku 12s linear forwards", animationDelay: `${index * .45}s` }}>{comment.characterName}：{comment.text}</div>)}
        </div>}
        {target && settings.subtitlesEnabled && latestComment && <div className="pointer-events-none absolute bottom-5 left-4 right-4 text-center">
          <span className="rounded-md bg-black/65 px-3 py-2 text-sm leading-6 text-white/95 [box-decoration-break:clone]">{latestComment.text}</span>
        </div>}
        <div className="absolute right-2 top-2 flex gap-1">
          <button onClick={() => void enterFullscreen()} className="grid h-8 w-8 place-items-center rounded-lg bg-black/45 text-white/90 backdrop-blur transition active:scale-95" aria-label="全屏"><Expand size={15}/></button>
        </div>
        {/* 屏幕洒在桌面上的余光 */}
        {!fullScreen && <div aria-hidden className="pointer-events-none absolute -bottom-6 left-1/2 h-6 w-[86%] -translate-x-1/2 rounded-[50%] opacity-40 blur-xl" style={{ background: "radial-gradient(ellipse, #d7a06a 0%, transparent 70%)" }} />}
      </section>

      {/* 没有视频时：链接输入放在「屏幕」下方，像往播放器里投一块碟 */}
      {!target && <div className="watch-link-panel mx-auto mt-4 w-full max-w-3xl">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={urlInput} onChange={event => setUrlInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") openVideo(); }} placeholder="粘贴 B站 / 抖音 / 小红书 / 腾讯 / 优酷链接" className="min-w-0 flex-1 rounded-2xl border border-white/12 bg-white/6 px-4 py-3.5 text-sm text-[#f0e6d8] outline-none placeholder:text-[#8b8077] focus:border-[#c99a6a]" />
          <button onClick={openVideo} className="rounded-2xl px-5 py-3.5 text-sm font-medium tracking-wide text-[#2a1f16] transition active:scale-[.98]" style={{ background: "linear-gradient(135deg,#e8c39a,#c99a6a)" }}>放上屏幕</button>
        </div>
        {platformNote && <p className="mt-2 text-[11px] leading-5 text-[#8b8077]">{platformNote}</p>}
      </div>}

      {/* 角色在屏幕下方轻声说话 */}
      <section className="watch-interaction-panel mx-auto mt-4 w-full max-w-3xl">
        <div className="relative isolate overflow-hidden border-y border-[#d4a575]/20 bg-gradient-to-br from-[#49372b]/80 via-[#2d231d]/90 to-[#1c1714]/95 p-4 shadow-[inset_0_1px_0_rgba(255,224,184,.08)] backdrop-blur-xl sm:p-5">
          {/* 双人电波连线：用头像和波形表达同步陪伴，不再绘制伪沙发。 */}
          <div className="relative z-10 mb-4 flex items-center gap-3 border-y border-[#d6b18c]/20 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2"><span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden border border-[#d6b18c]/45 bg-[#e6d4bf] text-xs text-[#694e43]">{character?.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character?.name.slice(0,1) ?? "TA"}</span><span className="min-w-0"><span className="block truncate text-xs text-[#f1dfc9]">{character?.name ?? "TA"}</span><span className="block text-[10px] text-[#a9937e]">{watching ? "正在陪你看" : "等你一起看"}</span></span></div>
            <div className="flex h-10 min-w-[76px] flex-1 items-center justify-center gap-[3px]" aria-label="双人同步电波">{Array.from({length:15},(_,i)=><span key={i} className="w-[2px] rounded-full bg-[#c99a78]" style={{height:`${5+((i*7+3)%13)}px`,opacity:watching?0.95:0.45,animation:watching?`watchWave 900ms ease-in-out ${i*55}ms infinite alternate`:undefined}}/>)}</div>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right"><span className="min-w-0"><span className="block truncate text-xs text-[#f1dfc9]">{playerIdentity?.name || "我"}</span><span className="block text-[10px] text-[#a9937e]">和你同频</span></span><span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden border border-[#d6b18c]/45 bg-[#6d5141] font-serif text-sm text-[#f1dfc9]">{playerIdentity?.avatarUrl ? <img src={playerIdentity.avatarUrl} alt="" className="h-full w-full object-cover"/> : (playerIdentity?.name || "我").slice(0, 1)}</span></div>
          </div>
          <div className="relative z-10 flex items-start gap-3">
            {character && <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-[#4a3d33] text-xs text-[#e6d8c4]">{character.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character.name.slice(0, 1)}</span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="text-[11px] tracking-[.08em] text-[#d6b18c]">{latestComment?.characterName ?? character?.name ?? "角色"}</span><span className="text-[10px] text-[#a9937e]">{busy ? "正在回应…" : watching ? "同频陪看" : "等待交流"}</span></div>
              <p className="mt-1.5 min-h-[22px] font-serif text-[15px] leading-7 text-[#efe2d0]">
                {latestComment ? latestComment.text : <span className="text-[#8b8077]">TA 还没说话。可以自己先说说此刻看到了什么。</span>}
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => void generateComment(true)} disabled={!target || !character || busy} className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs text-[#2a1f16] transition active:scale-95 disabled:opacity-40" style={{ background: "linear-gradient(135deg,#e8c39a,#c99a6a)" }}>
              {busy ? <LoaderCircle size={13} className="animate-spin"/> : <MessageCircle size={13}/>}让 TA 说一句
            </button>
            <button onClick={() => { setWatching(value => !value); if (!watching) void generateComment(false); }} disabled={!target || !character} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs text-[#d8c9b6] transition active:scale-95 disabled:opacity-40">
              {watching ? <Pause size={13}/> : <Play size={13}/>}{watching ? "暂停陪看" : "开始陪看"}
            </button>
            <button onClick={() => setShowHistory(true)} disabled={!comments.length} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs text-[#d8c9b6] transition active:scale-95 disabled:opacity-40">
              <Heart size={13}/>悄悄话 {comments.length > 0 && <span className="text-[#c99a6a]">{comments.length}</span>}
            </button>
            <button onClick={() => setShowSettings(value => !value)} className="ml-auto flex items-center gap-1 rounded-full px-2 py-2 text-[11px] text-[#8b8077] transition active:scale-95"><ChevronDown size={13} className={showSettings ? "rotate-180 transition" : "transition"}/>陪看方式</button>
          </div>

          <section className="relative z-10 mt-5 border-t border-[#d6b18c]/20 pt-4">
            <div className="flex items-baseline justify-between gap-2"><h2 className="font-serif text-base tracking-wide text-[#f0dfcc]">一起讨论</h2><span className="text-[10px] tracking-[.12em] text-[#a9937e]">SCENE NOTES · {comments.length}</span></div>
            <p className="mt-1 text-[10px] leading-5 text-[#a9937e]">把某一幕、剧情转折或想说的话记在对应时间点。外部播放器的实际播放时间无法由跨站 iframe 读取，因此时间点可手动填写。</p>
            {comments.some(item=>item.timepoint) && <div className="mt-3 flex flex-wrap gap-2">{[...new Set(comments.filter(item=>item.timepoint).map(item=>item.timepoint!))].map(point=><button key={point} type="button" onClick={()=>{setTimepointDraft(point);setDiscussionDraft(`想再聊聊 ${point} 这一幕`);}} className="border-b border-[#c99a78]/60 px-1 py-1 text-[11px] text-[#e4c6a8]">{point} ↗</button>)}</div>}
            <div className="mt-3 max-h-64 space-y-3 overflow-y-auto overscroll-contain pr-1">{comments.length ? comments.slice(-30).map(item=><div key={item.id} className={`flex ${item.kind==="user"?"justify-end":"justify-start"}`}><div className={`max-w-[88%] border px-3 py-2.5 ${item.kind==="user"?"border-[#d6b18c]/35 bg-[#d6b18c]/10":"border-white/10 bg-white/[.045]"}`}><div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-[#c4a58a]"><span>{item.kind==="user"?"我":item.characterName}</span>{item.timepoint&&<button type="button" onClick={()=>setTimepointDraft(item.timepoint||"")} className="border-b border-[#c99a78]/50 text-[#e4c6a8]">{item.timepoint}</button>}<span className="text-[#85756a]">{new Date(item.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</span></div><p className="whitespace-pre-wrap break-words font-serif text-sm leading-6 text-[#efe2d0]">{item.text}</p></div></div>) : <p className="border-l border-[#c99a78]/45 py-1 pl-3 text-xs leading-6 text-[#a9937e]">这里留给你们讨论剧情、吐槽片段，或标记想一起记住的时刻。</p>}</div>
            <div className="mt-3 border-t border-[#d6b18c]/20 pt-3"><div className="flex items-center gap-2"><input value={timepointDraft} onChange={event=>setTimepointDraft(event.target.value.slice(0,16))} disabled={!target} placeholder="时间点 03:12（可选）" className="w-[42%] min-w-0 border-b border-[#9c7b63]/60 bg-transparent px-1 py-2 text-xs text-[#f0dfcc] outline-none placeholder:text-[#907d6c] focus:border-[#e4c6a8]"/><span className="text-[10px] text-[#907d6c]">章节 / 剧情标记</span></div><textarea value={discussionDraft} onChange={event=>setDiscussionDraft(event.target.value.slice(0,800))} disabled={!target} maxLength={800} rows={2} placeholder={target ? "写下你对这一幕的看法……" : "先放上视频，再写下你对这一幕的看法……"} className="mt-2 w-full resize-none border border-white/10 bg-black/15 p-3 text-sm leading-6 text-[#efe2d0] outline-none placeholder:text-[#907d6c] focus:border-[#c99a78]/60"/><div className="mt-2 flex justify-end"><button type="button" onClick={submitDiscussion} disabled={!target||!discussionDraft.trim()||busy} className="border border-[#c99a78]/60 bg-[#c99a78] px-4 py-2 text-xs text-[#2a1f16] disabled:opacity-40"><MessageCircle size={13} className="mr-1 inline"/>记下并问问 TA</button></div></div>
          </section>
          <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
            {[
              ["✦", "暂停聊聊", "我们先停一下，聊聊刚才这一幕。"],
              ["◌", "标记这一幕", "这段值得记下来，之后我们再一起回看。"],
              ["♡", "说说感受", "我想和你分享一下刚才这一幕带给我的感受。"],
              ["↗", "猜猜接下来", "你觉得接下来会发生什么？说说你的猜想。"],
            ].map(([icon, label, cue]) => <button key={label} type="button" onClick={() => actTogether(cue)} disabled={!target || busy || !character} className="rounded-full border border-[#d6b18c]/15 bg-[#d6b18c]/[.07] px-2.5 py-1.5 text-[10px] text-[#d8c2aa] transition hover:border-[#d6b18c]/35 hover:bg-[#d6b18c]/[.13] active:scale-95 disabled:opacity-40"><span className="mr-1">{icon}</span>{label}</button>)}
          </div>
        </div>

        {/* 陪看设置：抽屉式，默认收起，避免占据屏幕空间 */}

      </section>
    </main>

    {showSettings && <div className="absolute inset-0 z-[1012] flex items-end bg-black/45 backdrop-blur-sm" onClick={() => setShowSettings(false)}>
      <section className="max-h-[78%] w-full overflow-y-auto border-t border-[#c99a78]/30 bg-[#2a211a] p-4 pb-[max(16px,env(safe-area-inset-bottom))]" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-base tracking-wide text-[#efe2d0]">陪看方式</h2>
            <button onClick={() => setShowSettings(false)} aria-label="收起设置" className="text-[#8b8077]"><X size={15}/></button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-[#9c9086]">陪你看的人
              <select value={character?.id ?? ""} onChange={event => patchSettings({ characterId: event.target.value })} className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-[#efe2d0] outline-none">
                {characters.map(char => <option key={char.id} value={char.id} className="bg-[#241e19]">{char.name}</option>)}
              </select>
            </label>
            <div className="text-[11px] text-[#9c9086]">主动说话间隔（分钟）
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <label className="min-w-0">最短<input key={settings.intervalMinMinutes} type="number" inputMode="numeric" min="1" max="60" defaultValue={settings.intervalMinMinutes} onBlur={event => { const min = Math.max(1, Math.min(60, Number(event.currentTarget.value) || 1)); patchSettings({ intervalMinMinutes: min, intervalMaxMinutes: Math.max(min, settings.intervalMaxMinutes) }); }} className="mt-1 block w-full min-w-0 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2.5 text-sm text-[#efe2d0] outline-none"/></label>
                <label className="min-w-0">最长<input key={settings.intervalMaxMinutes} type="number" inputMode="numeric" min={settings.intervalMinMinutes} max="60" defaultValue={settings.intervalMaxMinutes} onBlur={event => { const max = Math.max(settings.intervalMinMinutes, Math.min(60, Number(event.currentTarget.value) || settings.intervalMinMinutes)); patchSettings({ intervalMaxMinutes: max }); }} className="mt-1 block w-full min-w-0 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2.5 text-sm text-[#efe2d0] outline-none"/></label>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-[#8b8077]">角色每次发言后，都会在这个范围内重新随机等待。</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {([["voiceEnabled", "角色语音"], ["danmakuEnabled", "角色弹幕"], ["subtitlesEnabled", "角色字幕"]] as [keyof WatchSettings, string][]).map(([key, label]) => <button
              key={key}
              type="button"
              onClick={() => patchSettings({ [key]: !settings[key] } as Partial<WatchSettings>)}
              className={`rounded-full border px-3 py-2 text-[11px] transition active:scale-95 ${settings[key] ? "border-[#c99a6a]/60 bg-[#c99a6a]/15 text-[#e8c39a]" : "border-white/10 bg-white/5 text-[#8b8077]"}`}
            >{label}</button>)}
          </div>
          <p className="mt-3 text-[10px] leading-5 text-[#7d7268]">角色发言使用你已配置的聊天模型与语音绑定。平台自带的字幕/弹幕开关无法跨站控制，这里的开关只作用于「角色陪看」这一层。</p>
      </section>
    </div>}

    {/* 悄悄话抽屉：历史发言收起来，不占屏幕 */}
    {showHistory && <div className="absolute inset-0 z-[1012] flex flex-col justify-end bg-black/55 backdrop-blur-sm" onClick={() => setShowHistory(false)}>
      <section className="flex max-h-[72%] flex-col overflow-hidden rounded-t-[26px] border-t border-white/12 bg-[#221c17]" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-white/8 px-4 py-3.5">
          <div>
            <div className="font-serif text-base tracking-wide text-[#efe2d0]">今晚说过的话</div>
            <div className="mt-0.5 text-[10px] tracking-[.18em] text-[#7d7268]">{comments.length} 句 · 只属于你们</div>
          </div>
          <button onClick={() => setShowHistory(false)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-[#a2948a]"><X size={15}/></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {comments.length ? <div className="space-y-3">{[...comments].reverse().map(comment => <div key={comment.id} className="rounded-2xl border border-white/8 bg-white/[.035] px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] tracking-wide text-[#c99a6a]">{comment.characterName}</span>
              <span className="text-[10px] text-[#6f665e]">{new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <p className="mt-1 font-serif text-sm leading-6 text-[#ded0bd]">{comment.text}</p>
          </div>)}</div> : <p className="py-10 text-center text-xs text-[#7d7268]">还没有说过话。</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-white/8 px-4 py-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
          <span className="text-[10px] text-[#6f665e]">{watching ? "正在陪看" : "已暂停"}</span>
          <button onClick={() => { setComments([]); if (target) saveTargetComments(target.url, []); }} className="flex items-center gap-1.5 border-b border-white/12 px-2 py-2 text-[11px] text-[#a2948a] transition active:opacity-60"><Sparkles size={12}/>清空记录</button>
        </footer>
      </section>
    </div>}

    <audio ref={audioRef} className="hidden" />
  </div>;
}
