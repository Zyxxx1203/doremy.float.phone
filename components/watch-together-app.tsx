"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Expand, ExternalLink, FileText, Heart, ImagePlus, LoaderCircle, MessageCircle, Pause, Play, Settings2, Sparkles, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateChatCompletion, flattenCompletionResult, readCompressedImageDataUrl } from "@/lib/chat-engine";
import { createOrGetSession, loadChatContacts, loadChatMessages, loadChatSessions, pushChatMessage, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import { resolveVoiceConfig, synthesizeSpeech } from "@/lib/tts-service";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { loadVideoAnalysisSettings } from "@/lib/video-analysis-settings";
import { formatTranscriptTime, parseVideoTranscript, type VideoTranscriptSegment } from "@/lib/video-transcript";
import { DanmakuLayer } from "@/components/watch/danmaku-layer";
import { captureScreenshot, hasScreenshotBridge } from "@/lib/screenshot";
import { analyzeWholeVideoWithGemini } from "@/lib/gemini-video-understanding";
import { clearGlobalWatchRecords, loadGlobalWatchRecords, type GlobalWatchRecord } from "@/lib/global-watch-storage";
import { GlobalWatchCompanionApp } from "@/components/global-watch-companion-app";

/** 自动搭话的每日上限：护栏，避免暂停/挂机时白烧 API。 */
const WATCH_AUTO_DAILY_LIMIT = 24;
const WATCH_AUTO_DAY_KEY = "ai_phone_watch_auto_day_v1";

function readWatchAutoCount(): number {
  try {
    const raw = window.localStorage.getItem(WATCH_AUTO_DAY_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { day?: string; count?: number };
    return parsed?.day === new Date().toISOString().slice(0, 10) ? Math.max(0, Number(parsed.count) || 0) : 0;
  } catch { return 0; }
}

function bumpWatchAutoCount(): void {
  try {
    window.localStorage.setItem(WATCH_AUTO_DAY_KEY, JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      count: readWatchAutoCount() + 1,
    }));
  } catch { /* 存不下就不计数，不影响观看 */ }
}

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Platform = "bilibili" | "youtube" | "tencent" | "youku" | "iqiyi" | "douyin" | "kuaishou" | "xiaohongshu" | "other";
type VideoTarget = { url: string; embedUrl: string | null; platform: Platform; platformName: string; supported: boolean; nativeVideo?: boolean; nativeVideoUrl?: string; nativeCacheId?: string };
type WatchNativeBridge = { resolveShortVideoShareUrl?: (url: string, requestId: string) => boolean; deleteCachedShortVideo?: (cacheId: string) => boolean; setScreenOrientation?: (mode: string) => boolean };
type WatchNativeWindow = Window & { AndroidShell?: WatchNativeBridge };
type WatchNativeResolved = { requestId?: string; ok?: boolean; cacheId?: string; contentUri?: string; mediaUrl?: string; message?: string };
function openExternalUrl(url: string): void {
  if (!url) return;
  const native = typeof window !== "undefined" ? (window as WatchNativeWindow).AndroidShell : undefined;
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = native ? "_self" : "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return;
  } catch { /* 落到下面 */ }
  try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
}

type WatchComment = { id: string; characterId: string; characterName: string; text: string; createdAt: string; kind?: "character" | "user"; timepoint?: string; targetUrl?: string };
type WatchSettings = { characterId: string; intervalMinMinutes: number; intervalMaxMinutes: number; voiceEnabled: boolean; danmakuEnabled: boolean; danmakuColor: string; subtitlesEnabled: boolean; currentMoment: string };

const SETTINGS_KEY = "ai_phone_watch_together_v1";
const SETTINGS_MIGRATION_KEY = "ai_phone_watch_together_schema_v2";
const COMMENTS_KEY = "ai_phone_watch_together_comments_v1";
const DANMAKU_COLORS = ["#ffd9a0", "#ff8fae", "#9ad0ff", "#b8e986", "#ffffff", "#e6c49d"];
const DEFAULT_SETTINGS: WatchSettings = { characterId: "", intervalMinMinutes: 3, intervalMaxMinutes: 8, voiceEnabled: true, danmakuEnabled: true, danmakuColor: "#e6c49d", subtitlesEnabled: false, currentMoment: "" };
function formatVideoTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours > 0
    ? String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0")
    : String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
}
async function readTranscriptFile(file: File): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error("脚本文件超过 10 MB，请先拆分或压缩文件。");
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsText(file, "UTF-8");
  });
}

function parseVideoTime(value: string): number | null {
  const match = value.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

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
      // Short links and unusual Bilibili URL forms may not expose a BV/av id in the path.
      // Attempt the original page in an iframe rather than failing before playback is tried.
      return { url: original, embedUrl: original, platform: "bilibili", platformName: "哔哩哔哩", supported: false };
    }
    if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
      const id = host === "youtu.be" ? url.pathname.slice(1).split("/")[0] : url.searchParams.get("v") || /\/embed\/([^/]+)/.exec(url.pathname)?.[1] || /\/shorts\/([^/]+)/.exec(url.pathname)?.[1];
      return id ? { url: original, embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=0&playsinline=1`, platform: "youtube", platformName: "YouTube", supported: true } : { url: original, embedUrl: original, platform: "youtube", platformName: "YouTube", supported: false };
    }
    if (host === "v.qq.com" || host.endsWith(".qq.com")) {
      const vid = url.searchParams.get("vid") || /\/([a-zA-Z0-9]+)\.html/.exec(url.pathname)?.[1];
      return vid ? { url: original, embedUrl: `https://v.qq.com/txp/iframe/player.html?vid=${encodeURIComponent(vid)}`, platform: "tencent", platformName: "腾讯视频", supported: true } : { url: original, embedUrl: original, platform: "tencent", platformName: "腾讯视频", supported: false };
    }
    if (host === "youku.com" || host.endsWith(".youku.com")) {
      const id = /id_([^/.]+)\.html/.exec(url.pathname)?.[1];
      return id ? { url: original, embedUrl: `https://player.youku.com/embed/${encodeURIComponent(id)}`, platform: "youku", platformName: "优酷", supported: true } : { url: original, embedUrl: original, platform: "youku", platformName: "优酷", supported: false };
    }
    if (host === "iqiyi.com" || host.endsWith(".iqiyi.com")) return { url: original, embedUrl: original, platform: "iqiyi", platformName: "爱奇艺", supported: false };
    // Keep native extraction first for short-video share links. If native extraction is unavailable,
    // a direct iframe attempt remains a useful no-server fallback for pages that permit embedding.
    if (host === "douyin.com" || host.endsWith(".douyin.com")) return { url: original, embedUrl: null, platform: "douyin", platformName: "抖音", supported: false };
    if (host === "kuaishou.com" || host.endsWith(".kuaishou.com") || host === "gifshow.com" || host.endsWith(".gifshow.com")) return { url: original, embedUrl: original, platform: "kuaishou", platformName: "快手", supported: false };
    if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com") || host === "xhslink.cn" || host.endsWith(".xhslink.cn")) return { url: original, embedUrl: null, platform: "xiaohongshu", platformName: "小红书", supported: false };
    // Generic fallback: try rendering the supplied page inside the player instead of stopping
    // at "unsupported". Sites that set X-Frame-Options/CSP may still refuse embedding; the
    // existing native/platform-specific paths above take precedence where available.
    return { url: original, embedUrl: original, platform: "other", platformName: host, supported: false };
  } catch { return null; }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("截图读取失败"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function loadSettings(): WatchSettings {
  try {
    const raw = kvGet(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<WatchSettings> & { intervalMinutes?: number };
    const migrated = kvGet(SETTINGS_MIGRATION_KEY) === "2";
    const previousMin = typeof parsed.intervalMinMinutes === "number" ? parsed.intervalMinMinutes : typeof parsed.intervalMinutes === "number" ? parsed.intervalMinutes : 3;
    const previousMax = typeof parsed.intervalMaxMinutes === "number" ? parsed.intervalMaxMinutes : typeof parsed.intervalMinutes === "number" ? Math.min(60, parsed.intervalMinutes + 5) : 8;
    const untouchedDefault = !migrated && previousMin === 3 && previousMax === 8;
    return {
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      intervalMinMinutes: untouchedDefault ? 1 : Math.max(1, Math.min(60, previousMin)),
      intervalMaxMinutes: untouchedDefault ? 2 : Math.max(Math.max(1, Math.min(60, previousMin)), Math.min(60, previousMax)),
      voiceEnabled: parsed.voiceEnabled !== false,
      danmakuEnabled: parsed.danmakuEnabled !== false,
      danmakuColor: typeof parsed.danmakuColor === "string" && /^#[0-9a-f]{6}$/i.test(parsed.danmakuColor) ? parsed.danmakuColor : "#e6c49d",
      subtitlesEnabled: migrated ? parsed.subtitlesEnabled !== false : false,
      currentMoment: typeof parsed.currentMoment === "string" ? parsed.currentMoment.slice(0, 800) : "",
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(settings: WatchSettings): void {
  kvSet(SETTINGS_KEY, JSON.stringify(settings));
  kvSet(SETTINGS_MIGRATION_KEY, "2");
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
    const native = (window as WatchNativeWindow).AndroidShell;
    if (native?.setScreenOrientation?.("landscape")) return;
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
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const transcriptFileInputRef = useRef<HTMLInputElement>(null);
  const localVideoObjectUrlRef = useRef<string | null>(null);
  const nativeVideoCacheRef = useRef<{ url: string; cacheId: string } | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [resolverState, setResolverState] = useState<{ state: "idle" | "resolving" | "ok" | "failed"; message?: string }>({ state: "idle" });
  const [mediaPaused, setMediaPaused] = useState(false);
  const [danmakuDraft, setDanmakuDraft] = useState("");
  const [resolutionMessage, setResolutionMessage] = useState("");
  const [transcriberEndpoint, setTranscriberEndpoint] = useState(() => {
    try { return typeof window !== "undefined" ? window.localStorage.getItem("watch_transcriber_endpoint_v1") || "" : ""; } catch { return ""; }
  });
  const [transcriberToken, setTranscriberToken] = useState(() => {
    try { return typeof window !== "undefined" ? window.localStorage.getItem("watch_transcriber_token_v1") || "" : ""; } catch { return ""; }
  });
  const [transcriberModel, setTranscriberModel] = useState<"tiny" | "base" | "small" | "medium">("small");
  const [transcribing, setTranscribing] = useState(false);
  const [wholeVideoBusy, setWholeVideoBusy] = useState(false);
  const [wholeVideoProgress, setWholeVideoProgress] = useState("");
  const localVideoFileRef = useRef<File | null>(null);
  const wholeVideoAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!target?.nativeVideoUrl || !target.nativeVideoUrl.toLowerCase().includes(".m3u8")) return;
    const video = playerRef.current?.querySelector("video");
    if (!video) return;
    let cancelled = false;
    let hlsInstance: { destroy: () => void } | null = null;
    const attach = () => {
      if (cancelled) return;
      const HlsCtor = (window as Window & { Hls?: new (config?: Record<string, unknown>) => {
        loadSource: (url: string) => void;
        attachMedia: (media: HTMLMediaElement) => void;
        on: (event: string, callback: (...args: unknown[]) => void) => void;
        destroy: () => void;
      } }).Hls;
      if (HlsCtor && (HlsCtor as unknown as { isSupported?: () => boolean }).isSupported?.()) {
        video.removeAttribute("src");
        video.load();
        const instance = new HlsCtor({ enableWorker: true, lowLatencyMode: false, xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = true; } });
        hlsInstance = instance;
        instance.on("error", (...args: unknown[]) => {
          const data = args[1] as { fatal?: boolean; type?: string; details?: string } | undefined;
          if (data?.fatal) onNotice?.("HLS 流已找到，但播放失败：" + (data.details || data.type || "媒体流错误") + "。可能是平台防盗链、跨域或地址过期。");
        });
        instance.loadSource(target.nativeVideoUrl!);
        instance.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = target.nativeVideoUrl!;
        void video.play().catch(() => {});
      } else {
        onNotice?.("已解析到 HLS（m3u8）视频流，但当前环境缺少兼容解码器；请尝试 MP4 视频。");
      }
    };
    const existing = (window as Window & { Hls?: unknown }).Hls;
    if (existing) attach();
    else {
      const sources = [
        "https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js",
        "https://unpkg.com/hls.js@1.6.13/dist/hls.min.js",
      ];
      let sourceIndex = 0;
      const loadNext = () => {
        if (cancelled) return;
        if (sourceIndex >= sources.length) {
          onNotice?.("HLS 播放组件加载失败；视频地址已解析，但当前网络无法下载播放组件。");
          return;
        }
        const script = document.createElement("script");
        script.src = sources[sourceIndex++];
        script.async = true;
        script.onload = attach;
        script.onerror = loadNext;
        document.head.appendChild(script);
      };
      loadNext();
    }
    return () => { cancelled = true; hlsInstance?.destroy(); };
  }, [target?.nativeVideoUrl, onNotice]);

  useEffect(() => {
    const current = target;
    if (!current) { setResolutionMessage(""); return; }
    if (current.nativeVideo) { setResolutionMessage("解析成功：已取得可播放的视频源，当前由小手机内置播放器播放。"); return; }
    setResolutionMessage("正在检查此链接是否支持站内播放……");
    /**
     * Keep supported platform embeds in their own player. The Android native resolver currently
     * handles only public Douyin/Kuaishou/Xiaohongshu share pages; forcing Bilibili through it
     * guarantees failure because its host is intentionally not in the native allowlist.
     * Use native extraction only for the platforms the shell actually supports.
     */
    if ((current.embedUrl && current.embedUrl !== current.url) || current.supported) {
      setResolutionMessage("已识别链接，当前使用平台站内播放器。这不代表已经解析出真实视频流。");
      return;
    }
    const native = (window as WatchNativeWindow).AndroidShell;
    if (!native || !native.resolveShortVideoShareUrl) {
      setResolutionMessage("当前环境没有可用的原生提取桥，正在尝试网页内嵌播放；若平台禁止嵌入，请打开原网页或选择本地视频。");
      return;
    }
    setResolutionMessage("正在尝试提取公开视频资源；提取期间也会保留网页内嵌播放作为备用……");
    const requestId = "watch-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
    let active = true;
    setResolverState({ state: "resolving" });
    const onResolved = (event: Event) => {
      const detail = (event as CustomEvent<WatchNativeResolved>).detail;
      if (!detail || detail.requestId !== requestId) return;
      if (!active) {
        if (detail.cacheId) { try { native.deleteCachedShortVideo?.(detail.cacheId); } catch { /* native cache TTL is fallback */ } }
        return;
      }
      if (detail.ok && ((detail.cacheId && detail.contentUri) || detail.mediaUrl)) {
        if (detail.cacheId) nativeVideoCacheRef.current = { url: current.url, cacheId: detail.cacheId };
        setTarget(previous => previous && previous.url === current.url ? { ...previous, nativeVideo: true, nativeVideoUrl: detail.mediaUrl || detail.contentUri, nativeCacheId: detail.cacheId, supported: true } : previous);
        const message = detail.mediaUrl?.toLowerCase().includes(".m3u8")
          ? "解析成功：已取得 HLS 视频流，正在尝试在小手机内播放。"
          : "解析成功：已取得可在小手机内播放的视频流。";
        setResolutionMessage(message);
        onNotice?.(message);
      } else {
        const message = "解析失败：未取得可播放的视频流。" + (detail.message ? "原因：" + detail.message : "可能需要登录/会员权限，或平台使用防盗链与时效地址。") + " 可尝试站内嵌入、打开原视频或播放本地文件。";
        setResolutionMessage(message);
        onNotice?.(message);
      }
    };
    window.addEventListener("floatshell-shared-video-ready", onResolved);
    try {
      if (!native.resolveShortVideoShareUrl(current.url, requestId)) {
        const message = "APK 没有接受解析请求，请检查 APK 版本及支持的平台。";
        setResolutionMessage(message);
        onNotice?.(message);
      }
    } catch {
      const message = "调用 APK 原生解析失败，请检查 APK 版本与原生桥状态。";
      setResolutionMessage(message);
      onNotice?.(message);
    }
    return () => {
      active = false;
      window.removeEventListener("floatshell-shared-video-ready", onResolved);
      const cached = nativeVideoCacheRef.current;
      if (cached && cached.url === current.url) {
        try { native.deleteCachedShortVideo?.(cached.cacheId); } catch { /* native cache TTL is fallback */ }
        nativeVideoCacheRef.current = null;
      }
    };
  // URL alone defines the resolver lifetime so updating the target with its cache URI will not clear it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target && target.url]);

  useEffect(() => () => {
    const cached = nativeVideoCacheRef.current;
    if (cached) {
      try { (window as WatchNativeWindow).AndroidShell?.deleteCachedShortVideo?.(cached.cacheId); } catch { /* native cache TTL is fallback */ }
      nativeVideoCacheRef.current = null;
    }
  }, []);

  const [comments, setComments] = useState<WatchComment[]>([]);
  const [transcriptSegments, setTranscriptSegments] = useState<VideoTranscriptSegment[]>([]);
  const [transcriptName, setTranscriptName] = useState("");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState("");
  const screenshotFileInputRef = useRef<HTMLInputElement>(null);
  const [companionCollapsed, setCompanionCollapsed] = useState(false);
  const [showQuickChat, setShowQuickChat] = useState(false);
  const pendingDiscussionRef = useRef<Array<{ moment: string; timepoint?: string }>>([]);
  const [discussionDraft, setDiscussionDraft] = useState("");
  const [timepointDraft, setTimepointDraft] = useState("");
  const timepointDraftRef = useRef("");
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showGlobalCompanion, setShowGlobalCompanion] = useState(false);
  const [historyMode, setHistoryMode] = useState<"current" | "global">("current");
  const [globalWatchRecords, setGlobalWatchRecords] = useState<GlobalWatchRecord[]>(() => loadGlobalWatchRecords());
  const [fullScreen, setFullScreen] = useState(false);
  const originalOrientationRef = useRef<string | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const commentListRef = useRef<HTMLDivElement>(null);
  const commentListAtBottomRef = useRef(true);
  /** 跨站 iframe 读不到 currentTime，用观看秒表估一个时间点，让弹幕能对上进度。 */
  const iframeSecondsRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const commentBusyRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);
  const character = characters.find(item => item.id === settings.characterId) ?? characters[0] ?? null;
  const historyComments = historyMode === "global" ? globalWatchRecords : comments;
  useEffect(() => { if (showHistory) setGlobalWatchRecords(loadGlobalWatchRecords()); }, [showHistory]);
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
  useEffect(() => {
    const handleAppBack = (event: Event) => {
      const detail = (event as CustomEvent<{ handled?: boolean }>).detail;
      if (fullScreen) { setFullScreen(false); void restoreOrientation(); if (detail) detail.handled = true; }
      else if (showSettings) { setShowSettings(false); if (detail) detail.handled = true; }
      else if (showHistory) { setShowHistory(false); if (detail) detail.handled = true; }
    };
    window.addEventListener("floatphone-app-back", handleAppBack);
    return () => window.removeEventListener("floatphone-app-back", handleAppBack);
  }, [fullScreen, showSettings, showHistory]);

  useEffect(() => {
    // Script-first co-watching: don't silently sample the video or add screenshots to prompts.
    // The character uses the imported transcript around the current playback timestamp instead.
    iframeSecondsRef.current = 0;
  }, [target?.url]);

  // 跨站 iframe 拿不到 currentTime：用一张只在「正在看且页面可见」时走的秒表，
  // 给角色一个大致进度，弹幕说「第 12 分钟」时不至于永远是 0。
  useEffect(() => {
    if (!watching || !target?.embedUrl) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") iframeSecondsRef.current += 1;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [watching, target?.embedUrl, target?.url]);

  useEffect(() => {
    const list = commentListRef.current;
    if (!list || !commentListAtBottomRef.current) return;
    let first = 0;
    let second = 0;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const current = commentListRef.current;
        if (!current || !commentListAtBottomRef.current) return;
        current.scrollTo({ top: current.scrollHeight, behavior: "smooth" });
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [comments.length, fullScreen, busy]);
  const restoreOrientation = async () => {
    try { screen.orientation?.unlock?.(); } catch { /* orientation lock is optional */ }
    try { (window as WatchNativeWindow).AndroidShell?.setScreenOrientation?.("restore"); } catch { /* browser fallback below */ }
    const original = originalOrientationRef.current;
    if (original) {
      try {
        const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> };
        await orientation.lock?.(original);
      } catch { /* Browsers may only permit orientation locks while fullscreen. */ }
    }
    originalOrientationRef.current = null;
  };
  // This component owns an in-page immersive layout. Ignore document-wide fullscreen events:
  // platform iframe/player controls must never switch the entire app into our immersive layout.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    if (localVideoObjectUrlRef.current) URL.revokeObjectURL(localVideoObjectUrlRef.current);
    localVideoFileRef.current = null;
    wholeVideoAbortRef.current?.abort();
    try { screen.orientation?.unlock?.(); } catch { /* orientation lock is optional */ }
  }, []);

  const patchSettings = (patch: Partial<WatchSettings>) => setSettings(current => ({ ...current, ...patch }));

  const captureCurrentFrame = async () => {
    const video=playerRef.current?.querySelector("video");
    if (!video || !video.videoWidth || !video.videoHeight) {
      onNotice?.("当前播放器没有可读取的视频帧（外站 iframe 受浏览器隔离）。可点上传截图按钮选择一张画面。"); return;
    }
    try {
      const scale=Math.min(1,1024/Math.max(video.videoWidth,video.videoHeight));
      const canvas=document.createElement("canvas");
      canvas.width=Math.max(1,Math.round(video.videoWidth*scale)); canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
      const context=canvas.getContext("2d"); if(!context) throw new Error("无法创建截图画布。");
      context.drawImage(video,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/jpeg",0.78));
      if(!blob) throw new Error("截图编码失败。");
      setScreenshotDataUrl(await readCompressedImageDataUrl(blob));
      onNotice?.("已截取当前画面。下一次角色回应会尝试结合截图、字幕和时间点理解；请确认当前绑定的聊天 API 已开启图片识别，且模型支持看图。");
    } catch { onNotice?.("当前视频帧受跨域安全策略保护，无法直接截取。请上传截图或使用本地视频。"); }
  };
  const loadScreenshotFile = async (file?: File) => {
    if(!file) return;
    if(!file.type.startsWith("image/")) { onNotice?.("请选择图片文件。"); return; }
    if(file.size>12*1024*1024) { onNotice?.("截图超过 12 MB，请先压缩后再上传。"); return; }
    try { setScreenshotDataUrl(await readCompressedImageDataUrl(file)); onNotice?.("截图已载入；下一次角色回应会尝试结合视觉理解。请确认当前绑定的聊天 API 已开启图片识别，且模型支持看图。"); }
    catch(error) { onNotice?.("截图读取失败："+(error instanceof Error?error.message:String(error))); }
  };
  const openLocalVideo = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|m4v|mov|ogv|ogg)$/i.test(file.name)) {
      onNotice?.("请选择 MP4、WebM、MOV 或其他浏览器支持的视频文件。");
      return;
    }
    if (localVideoObjectUrlRef.current) URL.revokeObjectURL(localVideoObjectUrlRef.current);
    localVideoFileRef.current = file;
    const objectUrl = URL.createObjectURL(file);
    localVideoObjectUrlRef.current = objectUrl;
    const localTarget: VideoTarget = { url: objectUrl, embedUrl: null, platform: "other", platformName: "本地视频", supported: true, nativeVideo: true };
    setTarget(localTarget);
    setScreenshotDataUrl("");
    setTranscriptSegments([]); setTranscriptName("");
    setVideoTitle(file.name.replace(/\.[^.]+$/, "") || "本地视频");
    setComments([]);
    setDiscussionDraft("");
    setTimepointDraft("");
    setWatching(false);
    onNotice?.("已载入本地视频。视频在当前页面内播放，不会上传；切换文件或离开一起看后会释放临时引用。");
  };
  const openVideo = () => {
    const parsed = parseVideoUrl(urlInput);
    if (!parsed) { onNotice?.("请粘贴完整的视频分享链接（http/https）。"); return; }
    if (localVideoObjectUrlRef.current) {
      URL.revokeObjectURL(localVideoObjectUrlRef.current);
      localVideoObjectUrlRef.current = null;
    }
    localVideoFileRef.current = null;
    setTarget(parsed);
    setScreenshotDataUrl("");
    setTranscriptSegments([]); setTranscriptName("");
    setVideoTitle(current => current || `${parsed.platformName}的一段视频`);
    setComments(loadTargetComments(parsed.url));
    setDiscussionDraft(""); setTimepointDraft("");
    setWatching(false);
    if (!parsed.supported && (parsed.platform === "xiaohongshu" || parsed.platform === "douyin")) onNotice?.("正在尝试在小手机内解析" + parsed.platformName + "的公开视频流；如果平台要求登录或启用了防盗链，解析可能失败。");
  };


  /** Request timestamped JSON from the user's own local/self-hosted transcription service. */
  const transcribeFromUrl = async () => {
    const sourceUrl = urlInput.trim() || target?.url || "";
    const endpointBase = transcriberEndpoint.trim().replace(/\/+$/, "");
    const token = transcriberToken.trim();
    if (!sourceUrl) { onNotice?.("先粘贴一个视频链接，再生成脚本。"); return; }
    if (!endpointBase || !token) { onNotice?.("先配置转写服务的 HTTPS 地址和访问令牌。"); return; }
    let endpoint: URL;
    try {
      endpoint = new URL(endpointBase.endsWith("/transcribe") ? endpointBase : endpointBase + "/transcribe");
      if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)) {
        onNotice?.("手机访问部署中的转写服务时请使用受信任的 HTTPS 地址；浏览器会拦截 HTTPS 页面请求普通 HTTP 服务。");
        return;
      }
    } catch { onNotice?.("转写服务地址无效，请检查 http(s) 地址。"); return; }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30 * 60 * 1000);
    setTranscribing(true);
    try {
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ url: sourceUrl, language: "zh", model: transcriberModel }),
        signal: controller.signal,
      });
      const result = await response.json() as { ok?: boolean; error?: string; title?: string; transcript?: unknown };
      if (!response.ok || result.ok !== true || !result.transcript) {
        throw new Error(result.error || ("转写服务返回 HTTP " + response.status));
      }
      const source = typeof result.transcript === "string" ? result.transcript : JSON.stringify(result.transcript) || "";
      const parsed = parseVideoTranscript(source);
      if (!parsed.length) throw new Error("服务已返回结果，但没有识别到带时间戳的脚本片段。");
      setTranscriptSegments(parsed);
      setTranscriptName((result.title || new URL(sourceUrl).hostname) + " · 本地转写");
      if (result.title) setVideoTitle(result.title);
      onNotice?.("转写完成：已载入 " + parsed.length + " 段带时间戳脚本。开始播放后，陪看会引用当前播放时间附近的文字。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof DOMException && error.name === "AbortError";
      onNotice?.((timedOut ? "转写超时：" : "转写失败：") + message + "。请检查服务、CORS、令牌、平台登录状态或风控限制。");
    } finally {
      window.clearTimeout(timeout);
      setTranscribing(false);
    }
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

  /**
   * 静默取一帧画面，作为本轮「角色看到的画面」。
   * 同源 <video> 直接读像素；跨站 iframe 读不到，就用壳的无障碍整屏截图，
   * 并裁到播放器区域——全程不弹任何 UI、不打断播放。
   */
  const captureFrameForPrompt = useCallback(async (): Promise<string> => {
    const video = playerRef.current?.querySelector("video");
    if (video && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      try {
        const maxSide = 720;
        const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.62));
          if (blob) return await blobToDataUrl(blob);
        }
      } catch {
        // 跨域媒体会污染画布，继续走壳截图
      }
    }
    if (!hasScreenshotBridge()) return "";
    const player = playerRef.current;
    if (!player) return "";
    try {
      const shot = await captureScreenshot(7000);
      if (!shot.ok || !shot.base64) return "";
      const binary = atob(shot.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const rect = player.getBoundingClientRect();
      const viewportWidth = Math.max(1, window.innerWidth);
      const viewportHeight = Math.max(1, window.innerHeight);
      const scaleX = bitmap.width / viewportWidth;
      const scaleY = bitmap.height / viewportHeight;
      const sourceX = Math.max(0, Math.min(bitmap.width - 1, rect.left * scaleX));
      const sourceY = Math.max(0, Math.min(bitmap.height - 1, rect.top * scaleY));
      const sourceWidth = Math.max(1, Math.min(bitmap.width - sourceX, rect.width * scaleX));
      const sourceHeight = Math.max(1, Math.min(bitmap.height - sourceY, rect.height * scaleY));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth));
      canvas.height = Math.max(1, Math.round(sourceHeight));
      const context = canvas.getContext("2d");
      if (!context) { bitmap.close(); return ""; }
      context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.7));
      return blob ? await blobToDataUrl(blob) : "";
    } catch {
      return "";
    }
  }, []);

  const generateComment = useCallback(async (manual = false, momentOverride?: string, timepointOverride?: string) => {
    if (!target || !character || commentBusyRef.current) return;
    commentBusyRef.current = true; setBusy(true);
    let queuedAfterReply: { moment: string; timepoint?: string } | undefined;
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `watch-together-${character.id}`, contactId: contact?.id ?? character.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-12).filter(item => item.status !== "failed" && !item.isRetracted);
      // 用户自己附过截图就优先用它；否则静默取一帧，别让角色「瞎看」
      const frameDataUrl = screenshotDataUrl || (await captureFrameForPrompt());
      const videoElement = playerRef.current?.querySelector("video");
      const draftSeconds = parseVideoTime(timepointOverride || timepointDraftRef.current);
      const playbackSeconds = videoElement && Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : iframeSecondsRef.current;
      const transcriptSeconds = draftSeconds ?? playbackSeconds;
      const transcriptWindow = transcriptSegments.filter(segment =>
        segment.start <= transcriptSeconds + 18 && segment.end >= Math.max(0, transcriptSeconds - 12)
      ).slice(0, 10);
      const transcriptHasTimestamps = !(transcriptSegments.length === 1 && transcriptSegments[0].start === 0 && transcriptSegments[0].end >= 86400);
      const transcriptContext = transcriptWindow.map(segment =>
        (transcriptHasTimestamps ? "[" + formatTranscriptTime(segment.start) + "] " : "") + segment.text
      ).join("\n").slice(0, 6000);
      const prompt = [
        "你正在和用户一起看视频，是亲密、自然的陪伴，不是影评机器人。",
        "视频平台：" + target.platformName + "；视频标题（用户可编辑）：" + (videoTitle || "暂未命名") + "。",
        frameDataUrl ? "本轮附带了用户提供/截取的当前画面截图。结合截图与字幕判断人物、场景、动作和情绪；若截图无法辨认，不要编造。" : "",
        "用户描述的当前片段/时间点与两人的互动：" + ((momentOverride ?? settings.currentMoment).trim() || "用户暂未提供具体画面描述") + "。",
        transcriptName ? "已导入字幕/脚本文件：" + transcriptName : "",
        transcriptContext ? (transcriptHasTimestamps
          ? "当前播放时间附近的字幕脚本（含原始时间戳）：\n" + transcriptContext
          : "已导入脚本没有可用时间戳，以下只作为全片文字参考，不能假装与当前画面精确同步：\n" + transcriptContext) : "",
        frameDataUrl
          ? "本轮可结合附带截图与字幕/时间点理解；截图只代表这一帧，不可据此推断未展示的后续剧情。"
          : transcriptContext
            ? "本轮只读取上面的字幕/时间戳脚本；不得声称看见实际画面。只根据已经出现的文字讨论，不能推测后续剧情。"
            : "当前没有导入的字幕/脚本或可用截图。只根据用户明确描述的片段与互动回应，不要声称读取到了视频画面。",
        "请结合角色自己的性格、兴趣和你们的关系，写一句自然的即时反应：可以吐槽、惊讶、共情、提问或分享感受。只输出角色会直接说的话，最多60个汉字。不搜寻或推断视频后续剧情。",
      ].filter(Boolean).join("\n");
      const userMessage: ChatMessage = { id: `watch-${Date.now()}`, sessionId: session.id, role: "user", content: prompt, status: "sent", createdAt: new Date().toISOString() };
      const result = await generateChatCompletion(session, [...history, userMessage], {
        appId: "watch_together",
        appTags: ["watch_together"],
        toolsAllowed: false,
        attachedImages: frameDataUrl ? [frameDataUrl] : undefined,
        ephemeralSystemNote: frameDataUrl
          ? "你正在根据用户提供的当前视频截图、字幕/时间戳脚本与用户一起看视频。允许描述截图中清晰可见的内容，但不要推断截图之外的画面或后续剧情。不要调用工具，只输出一句自然简短的角色发言。"
          : "你正在根据字幕/时间戳脚本与用户一起看视频。你没有读取到真实视频画面；不要调用工具，不要假装看见画面，也不要剧透。只输出一句自然简短的角色发言。",
      });
      const responseText = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
      if (!responseText) return;
      // Treat a screenshot as a one-shot visual hint; do not resend the same frame on every auto-comment.
      if (screenshotDataUrl) setScreenshotDataUrl("");
      const responseTimepoint = timepointOverride || (transcriptWindow.length ? formatVideoTime(transcriptWindow[0].start) : undefined);
      const comment: WatchComment = { id: `comment-${Date.now()}`, characterId: character.id, characterName: character.name, text: responseText, createdAt: new Date().toISOString(), kind: "character", timepoint: responseTimepoint, targetUrl: target.url };
      setComments(current => { const next = [...current.slice(-99), comment]; saveTargetComments(target.url, next); return next; });
      if (settings.voiceEnabled) void speakComment(responseText, character.id);
      if (manual) setCompanionCollapsed(false);
    } catch (error) {
      onNotice?.("角色观影回应失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      commentBusyRef.current = false;
      setBusy(false);
      queuedAfterReply = pendingDiscussionRef.current.shift();
      if (queuedAfterReply) window.setTimeout(() => { void generateComment(true, queuedAfterReply!.moment, queuedAfterReply!.timepoint); }, 50);
    }
  }, [target, character, videoTitle, settings.currentMoment, settings.voiceEnabled, onNotice, transcriptSegments, transcriptName, screenshotDataUrl, captureFrameForPrompt]);

  /** 把一帧画面交给角色：手动截图和静默截屏共用这一条路径。 */

  /**
   * 专注模式：将用户主动选择的本地视频作为完整文件交给 Gemini，
   * 不再只依赖当前截图。使用角色在“一起看”中的现有 API 绑定与角色卡。
   */
  const persistWatchShortTermMemory = (characterId: string, characterName: string, videoName: string, responseText: string) => {
    try {
      const contact = loadChatContacts().find(item => item.characterId === characterId);
      if (!contact) {
        onNotice?.("观影回应已保存在一起看记录；未找到该角色的聊天联系人，因此暂未写入聊天短期记忆。");
        return;
      }
      const session = createOrGetSession(contact.id);
      const summary = "【一起看短期记忆】" + characterName + "与用户于" + new Date().toLocaleString("zh-CN") +
        "一起观看了视频《" + (videoName || "未命名视频") + "》。角色的观影回应与共同讨论内容：" + responseText.slice(0, 1200);
      pushChatMessage({ sessionId: session.id, role: "assistant", content: summary, origin: "custom_app" });
    } catch (error) {
      console.warn("[TogetherWatch] 保存短期记忆失败", error);
      onNotice?.("观影记录已保存，但写入短期记忆失败。");
    }
  };

  const analyzeWholeLocalVideo = async () => {
    const file = localVideoFileRef.current;
    if (!file || target?.platformName !== "本地视频") {
      onNotice?.("请先在一起看里选择一个本地视频。");
      return;
    }
    if (!character) {
      onNotice?.("请先选择一个陪看角色。");
      return;
    }
    if (wholeVideoBusy) return;

    const videoSettings = loadVideoAnalysisSettings();
    if (!videoSettings.apiKey.trim()) {
      onNotice?.("请先到系统设置 → 视频分析模型填写所选服务的 API Key。");
      return;
    }

    const controller = new AbortController();
    wholeVideoAbortRef.current = controller;
    setWholeVideoBusy(true);
    setWholeVideoProgress("正在准备完整视频…");
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `watch-together-${character.id}`, contactId: contact?.id ?? character.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-10)
        .filter(item => item.status !== "failed" && !item.isRetracted)
        .map(item => (item.role === "user" ? "用户" : character.name) + "：" + String(item.content || "").slice(0, 500))
        .join("\n").slice(-3500);
      const profile = character as unknown as Record<string, unknown>;
      const roleDetails = [
        typeof profile.description === "string" ? "角色介绍：" + profile.description : "",
        typeof profile.personality === "string" ? "性格：" + profile.personality : "",
        typeof profile.scenario === "string" ? "背景设定：" + profile.scenario : "",
        typeof profile.systemPrompt === "string" ? "角色指令：" + profile.systemPrompt : "",
      ].filter(Boolean).join("\n").slice(0, 5000);
      const prompt = [
        "请完整观看并理解用户上传的整段视频（包含可识别的画面、动作、场景变化以及模型可读取的音轨/对白），然后以角色身份与用户自然互动。",
        "角色名：" + character.name + "。",
        roleDetails,
        "视频文件名：" + file.name + "；视频大小：" + (file.size / 1024 / 1024).toFixed(1) + " MB。",
        videoTitle ? "用户给这段视频起的标题：" + videoTitle : "",
        settings.currentMoment ? "用户补充的观看上下文：" + settings.currentMoment : "",
        transcriptSegments.length ? "用户另行导入的字幕/脚本仅作为补充参考，不要用它替代实际视频内容。" : "",
        history ? "近期聊天上下文：\n" + history : "",
        "请像正在和用户一起看视频的角色一样说话，而不是冷冰冰的通用分析报告。先自然分享看完的感受，再提及几个确实来自视频的具体细节；如能可靠定位，可用时间点。不要编造看不清的细节，不要假装听清无法识别的音频，也不要剧透视频之外的内容。可指出剪辑节奏、镜头衔接、情绪或故事内容，但以真实视频为准。回复控制在约 150-350 字，使用角色自己的说话风格，并自然邀请用户继续聊。",
      ].filter(Boolean).join("\n\n");

      const responseText = await analyzeWholeVideoWithGemini({
        file,
        apiKey: videoSettings.apiKey,
        model: videoSettings.model,
        provider: videoSettings.provider,
        baseUrl: videoSettings.baseUrl,
        maxFileSizeMb: videoSettings.maxFileSizeMb,
        frameCount: videoSettings.frameCount,
        prompt,
        signal: controller.signal,
        onProgress: setWholeVideoProgress,
      });
      const comment: WatchComment = {
        id: `whole-video-${Date.now()}`,
        characterId: character.id,
        characterName: character.name,
        text: responseText,
        createdAt: new Date().toISOString(),
        kind: "character",
        targetUrl: target.url,
      };
      setComments(current => {
        const next = [...current, comment].slice(-100);
        saveTargetComments(target.url, next);
        return next;
      });
      persistWatchShortTermMemory(character.id, character.name, videoTitle || file.name, responseText);
      if (settings.voiceEnabled) void speakComment(responseText, character.id);
      setCompanionCollapsed(false);
      onNotice?.("完整视频已观看完成，回应已加入一起看记录，并尝试写入角色短期记忆。");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        onNotice?.("已取消完整视频分析。");
      } else {
        onNotice?.("完整视频观看失败：" + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (wholeVideoAbortRef.current === controller) wholeVideoAbortRef.current = null;
      setWholeVideoBusy(false);
      setWholeVideoProgress("");
    }
  };

  const submitDiscussion = (rawText?: string) => {
    const text=(rawText ?? discussionDraft).trim(); if(!target||!text) return;
    const timepoint=timepointDraft.trim().slice(0,16);
    const comment:WatchComment={id:`user-${Date.now()}`,characterId:"user",characterName:"我",text,createdAt:new Date().toISOString(),kind:"user",timepoint:timepoint||undefined,targetUrl:target.url};
    setComments(current=>{const next=[...current.slice(-99),comment];saveTargetComments(target.url,next);return next;});
    const moment=[timepoint ? `时间点 ${timepoint}` : "",text].filter(Boolean).join("：").slice(0,800);
    patchSettings({currentMoment:moment}); setDiscussionDraft("");
    if (commentBusyRef.current) {
      pendingDiscussionRef.current.push({ moment, timepoint: timepoint || undefined });
    } else void generateComment(true,moment,timepoint||undefined);
  };

  const actTogether = (cue: string) => {
    const nextMoment = [settings.currentMoment.trim(), cue].filter(Boolean).join("；").slice(0, 800);
    patchSettings({ currentMoment: nextMoment });
    if (commentBusyRef.current) pendingDiscussionRef.current.push({ moment: nextMoment });
    else void generateComment(true, nextMoment);
  };

  /**
   * 角色主动搭话的护栏（一起看专属，不和生活系统共用）：
   * 页面不可见、视频暂停/播完、超过当日上限，都只跳过这一轮并继续排下一次，
   * 不会因为暂停挂机白烧 API。弹幕仍然是角色**主动**说的，不改成手动触发。
   */
  useEffect(() => {
    if (!watching || !target) return;
    let timer = 0;
    let disposed = false;
    const scheduleNext = () => {
      const min = Math.max(1, Math.min(60, settings.intervalMinMinutes));
      const max = Math.max(min, Math.min(60, settings.intervalMaxMinutes));
      const delayMinutes = min + Math.floor(Math.random() * (max - min + 1));
      timer = window.setTimeout(async () => {
        const video = playerRef.current?.querySelector("video");
        const paused = Boolean(video && (video.paused || video.ended));
        const overLimit = readWatchAutoCount() >= WATCH_AUTO_DAILY_LIMIT;
        if (document.visibilityState === "visible" && !paused && !overLimit) {
          await generateComment(false);
          bumpWatchAutoCount();
        }
        if (!disposed) scheduleNext();
      }, delayMinutes * 60_000);
    };
    scheduleNext();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [watching, target, settings.intervalMinMinutes, settings.intervalMaxMinutes, generateComment]);

  /** Keep the same player node mounted during fullscreen. Native WebView custom-view fullscreen
   * can freeze the first frame when React simultaneously resizes/reparents the video surface. */
  const enterFullscreen = async () => {
    const entering = !fullScreen;
    const video = playerRef.current?.querySelector("video") ?? null;
    const wasPlaying = Boolean(video && !video.paused && !video.ended);
    if (entering) {
      try { originalOrientationRef.current = screen.orientation?.type ?? null; }
      catch { originalOrientationRef.current = null; }
      setFullScreen(true);
      await tryLockLandscape();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (video?.isConnected && wasPlaying && video.paused) {
        try { await video.play(); } catch { /* playback can require another user gesture */ }
      }
      window.dispatchEvent(new Event("resize"));
    } else {
      setFullScreen(false);
      await restoreOrientation();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (video?.isConnected && wasPlaying && video.paused) {
        try { await video.play(); } catch { /* playback can require another user gesture */ }
      }
      window.dispatchEvent(new Event("resize"));
    }
  };

  useEffect(() => {
    // The app uses CSS fullscreen rather than native media fullscreen. An iframe entering/exiting
    // its own fullscreen must not collapse the app's immersive layout unexpectedly.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !fullScreen) return;
      setFullScreen(false);
      void restoreOrientation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullScreen]);

  const danmakuItems = useMemo(() => comments
    .filter(item => !target?.url || !item.targetUrl || item.targetUrl === target.url)
    .filter(item => item.kind === "user" || settings.danmakuEnabled)
    .map(item => ({ id: item.id, text: item.text, kind: item.kind === "user" ? ("user" as const) : ("character" as const), name: item.characterName })), [comments, target?.url]);
  const latestComment = comments[comments.length - 1];
  const platformNote = useMemo(() => {
    if (!target) return "";
    if (target.platformName === "本地视频") return "本地视频只在当前页面临时播放，不会上传。";
    if (target.nativeVideoUrl) return target.platformName + "已解析到小手机内播放；仍受公开视频权限、链接时效与平台防盗链影响。";
    if (target.supported) return `已接入${target.platformName}。能否播放取决于平台嵌入政策、登录状态与会员权限。`;
    return `${target.platformName}还没有取得可播放的视频流；查看解析提示或选择本地视频，不会假称已实现站内播放。`;
  }, [target]);

  if (showGlobalCompanion) return <GlobalWatchCompanionApp onClose={() => setShowGlobalCompanion(false)} onNotice={onNotice} />;

  return <div data-watch-fullscreen={fullScreen ? "true" : "false"} className={"watch-together-app pointer-events-auto isolate flex min-w-0 flex-col overflow-hidden text-[#f0e6d8] " + (fullScreen ? "fixed inset-0 z-[3000]" : "absolute inset-0 z-[1000]")} style={{ background: "linear-gradient(180deg,#e8d8c3 0%,#d8c1a5 48%,#bca084 100%)", height: fullScreen ? "100dvh" : undefined, width: fullScreen ? "100vw" : undefined }}>
    {/* 弹幕动画：仓库里从未定义过 watchDanmaku，之前那条 animation 是空转，这里补上真实 keyframes */}
    <style>{`
      .watch-together-main { display:flex; flex-direction:column; }
      .watch-room-card { display:flex; flex-direction:column; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
      .watch-room-card>[data-part="message"] { order:1; }
      .watch-room-card>[data-part="composer"] { order:2; }
      .watch-room-card>[data-part="actions"], .watch-room-card>[data-part="actions2"] { order:3; }
      .watch-room-card>[data-part="history"] { order:4; }
      @keyframes watchWave { from { transform:scaleY(.45); opacity:.45 } to { transform:scaleY(1.15); opacity:1 } }
      @keyframes watchDanmaku { 0% { transform:translateX(0); opacity:0 } 6% { opacity:1 } 92% { opacity:1 } 100% { transform:translateX(calc(-100% - 100vw)); opacity:0 } }
      .watch-player { flex-shrink:0; border:5px solid #342a21!important; border-radius:22px!important; background:#090807; box-shadow:0 0 0 1px rgba(255,247,233,.45),0 8px 0 #8c6847,0 24px 42px rgba(68,44,24,.26)!important; }
      .watch-link-panel { flex-shrink:0; }
      .watch-interaction-panel { min-width:0; }
      .watch-danmaku-track { position:absolute; left:100%; max-width:none; white-space:nowrap; animation-name:watchDanmaku; animation-timing-function:linear; animation-fill-mode:forwards; pointer-events:none; }
      .watch-danmaku-track > span { display:inline-block; border-radius:999px; background:rgba(0,0,0,.45); padding:4px 10px; color:rgba(255,255,255,.96); font-size:clamp(11px,1.2vw,15px); text-shadow:0 1px 3px rgba(0,0,0,.85); }
      .watch-danmaku-track[data-kind="user"] > span { background:rgba(54,101,144,.82); }
      .watch-companion-overlay { max-height:calc(100dvh - 64px - env(safe-area-inset-bottom,0px)); overflow:visible; }
      .watch-companion-card, .watch-companion-pill { background:rgba(13,12,12,.72)!important; backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px); }

      @media (max-width:699px), (orientation:portrait) {
        .watch-together-app:not([data-watch-fullscreen="true"]) > main.watch-together-main {
          display:flex; flex-direction:column; gap:12px; padding:10px 12px max(20px,env(safe-area-inset-bottom));
          flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto!important; overscroll-behavior:contain;
        }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-room-title { order:0; width:100%; max-width:none; margin:0!important; padding:0!important; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player { order:1; width:100%; max-width:none; height:auto; min-height:0; aspect-ratio:16/9; max-height:48dvh; align-self:stretch; border-width:3px!important; border-radius:14px!important; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player > video,
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player > iframe { display:block; width:100%; height:100%; max-height:48dvh; aspect-ratio:16/9; object-fit:contain; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel { order:2; width:100%; max-width:none; min-height:0; height:auto; overflow:visible; margin:0!important; flex-shrink:0; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel > div { display:block; min-height:0; height:auto; overflow:visible; padding:12px!important; border-radius:18px!important; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel .watch-comment-list { min-height:110px; max-height:38vh; overflow-y:auto; overscroll-behavior:contain; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel section { flex:none; min-height:0; overflow:visible; display:block; margin-top:14px; padding-top:12px; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel { order:3; width:100%; max-width:none; margin:0!important; padding:10px!important; max-height:none; overflow:visible; flex-shrink:0; border-radius:16px!important; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel input { padding-top:10px!important; padding-bottom:10px!important; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel button { padding:9px 11px!important; }
      }
      @media (orientation:landscape) and (min-width:700px) {
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-together-main { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr); grid-template-rows:auto minmax(0,auto) minmax(0,1fr); grid-template-areas:"title interaction" "player interaction" "link interaction"; gap:10px; overflow:hidden; padding-bottom:12px; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player { grid-area:player; width:100%; max-width:none; align-self:start; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel { grid-area:link; min-width:0; overflow:auto; }
        .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel { grid-area:interaction; min-height:0; overflow-y:auto; overscroll-behavior:contain; margin-top:0!important; }
      }

      /* Single fullscreen layout authority: keep playback and conversation visible together. */
      .watch-together-app[data-watch-fullscreen="true"] {
        position:fixed!important; inset:0!important; z-index:2147483000!important;
        width:100vw!important; height:100dvh!important; max-height:100dvh!important;
        display:flex!important; flex-direction:column!important; overflow:hidden!important;
        box-sizing:border-box!important; background:#000!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] > header {
        position:relative!important; inset:auto!important; z-index:40!important; display:flex!important;
        flex:0 0 auto!important; min-height:42px!important; padding: max(4px,env(safe-area-inset-top)) 10px 5px!important;
        background:rgba(0,0,0,.72)!important; color:#fff!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] > main.watch-together-main {
        display:grid!important; position:relative!important; inset:auto!important;
        grid-template-columns:minmax(0,1.2fr) minmax(260px,.8fr)!important;
        grid-template-rows:minmax(0,1fr)!important; grid-template-areas:"player interaction"!important;
        flex:1 1 0!important; min-height:0!important; width:100%!important; height:auto!important;
        overflow:hidden!important; padding:6px 8px max(8px,env(safe-area-inset-bottom))!important;
        gap:8px!important; box-sizing:border-box!important; background:#000!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-room-title,
      .watch-together-app[data-watch-fullscreen="true"] .watch-link-panel,
      .watch-together-app[data-watch-fullscreen="true"] [data-resolver-state] { display:none!important; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player {
        display:block!important; grid-area:player!important; position:relative!important; inset:auto!important;
        width:100%!important; height:100%!important; min-width:0!important; min-height:0!important;
        max-width:none!important; max-height:none!important; aspect-ratio:auto!important;
        margin:0!important; padding:0!important; overflow:hidden!important; border:0!important;
        border-radius:8px!important; box-shadow:none!important; background:#000!important; transform:none!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > video,
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > iframe {
        position:absolute!important; inset:0!important; display:block!important; width:100%!important; height:100%!important;
        min-width:0!important; min-height:0!important; max-width:none!important; max-height:100%!important;
        border:0!important; aspect-ratio:auto!important; object-fit:contain!important; transform:none!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel {
        display:block!important; grid-area:interaction!important; position:relative!important;
        min-width:0!important; min-height:0!important; width:100%!important; height:100%!important;
        overflow:hidden!important; margin:0!important; z-index:5!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div {
        display:flex!important; flex-direction:column!important; width:100%!important; height:100%!important;
        min-height:0!important; max-width:none!important; box-sizing:border-box!important;
        overflow:hidden!important; padding:8px!important; border-radius:12px!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div > [data-part="message"] {
        flex:0 0 auto!important; min-height:0!important; max-height:96px!important; overflow:hidden!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div > [data-part="message"] p {
        display:-webkit-box!important; -webkit-line-clamp:2!important; -webkit-box-orient:vertical!important; overflow:hidden!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel .watch-discussion-composer { flex:0 0 auto!important; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel section[data-part="history"] {
        display:flex!important; flex:1 1 auto!important; flex-direction:column!important; min-height:0!important;
        margin-top:8px!important; padding-top:8px!important; overflow:hidden!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel section[data-part="history"] > p { flex:0 0 auto!important; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel .watch-comment-list {
        flex:1 1 auto!important; min-height:36px!important; max-height:none!important; overflow-y:auto!important;
        overscroll-behavior:contain!important; -webkit-overflow-scrolling:touch;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-room-card { overflow:hidden!important; }
      @media (orientation:portrait) {
        .watch-together-app[data-watch-fullscreen="true"] > main.watch-together-main {
          grid-template-columns:minmax(0,1fr)!important; grid-template-rows:minmax(130px,32dvh) minmax(0,1fr)!important;
          grid-template-areas:"player" "interaction"!important; gap:6px!important; padding:4px 6px max(6px,env(safe-area-inset-bottom))!important;
        }
        .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div { padding:6px!important; }
        .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel section[data-part="history"] { margin-top:5px!important; padding-top:5px!important; }
      }
      @media (prefers-reduced-motion:reduce) {
        .watch-together-app[data-watch-fullscreen="true"] .watch-danmaku-track { animation:none!important; }
      }
    `}</style>

    {/* 房间里的一点暖光：模拟落地灯与屏幕溢出的光晕 */}
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-24 top-10 h-72 w-72 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle, #c98f52 0%, transparent 70%)" }} />
      <div className="absolute -right-20 top-1/3 h-80 w-80 rounded-full opacity-25 blur-3xl" style={{ background: "radial-gradient(circle, #c99a78 0%, transparent 70%)" }} />
    </div>

    <header className="relative z-[1010] flex shrink-0 items-center gap-3 px-4 pb-3 text-[#4e3a2b]" style={{ paddingTop: "max(12px, var(--page-header-safe-top, 48px))" }}>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }} className="grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#b89979]/45 bg-[#fffaf2]/80 text-[#6d4e47] shadow-sm backdrop-blur transition hover:bg-white active:scale-95" aria-label="返回"><ArrowLeft size={17}/></button>
      <div className="min-w-0 flex-1">
        <div className="whitespace-nowrap font-serif text-lg tracking-[.08em]">一起看 · 同频</div>
        <div className="truncate whitespace-nowrap text-[10px] tracking-[.08em] text-[#806b57]">把喜欢的内容放上屏幕，和 TA 边看边聊</div>
      </div>
      {character && <div className="flex shrink-0 items-center gap-2 rounded-full border border-[#b89979]/40 bg-[#fffaf2]/75 px-2.5 py-1.5 shadow-sm">
        <span className="grid h-6 w-6 place-items-center overflow-hidden rounded-full bg-[#4a3d33] text-[10px] text-[#e6d8c4]">{character.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character.name.slice(0, 1)}</span>
        <span className="max-w-[72px] truncate text-[11px] font-medium text-[#6d5141]">{character.name}</span>
      </div>}
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowGlobalCompanion(true); }} className="relative z-[1011] flex h-11 shrink-0 cursor-pointer touch-manipulation items-center gap-1.5 rounded-2xl border border-[#b89979]/45 bg-[#fffaf2]/80 px-2.5 text-[11px] text-[#6d4e47] shadow-sm transition hover:bg-white active:scale-95" aria-label="全局陪看">全局</button>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowSettings(value => !value); }} className="relative z-[1011] grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#b89979]/45 bg-[#fffaf2]/80 text-[#6d4e47] shadow-sm transition hover:bg-white active:scale-95" aria-label="观影设置" aria-expanded={showSettings}><Settings2 size={17}/></button>
    </header>

    <main className="watch-together-main relative z-[1001] min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8" style={{backgroundImage:"radial-gradient(ellipse at 50% 0%,rgba(255,251,242,.72),transparent 62%)"}}>
      <div className="watch-room-title mx-auto mb-3 w-full max-w-3xl px-1 pt-1"><div className="relative isolate overflow-hidden rounded-2xl border border-[#b99b80]/30 bg-[#fffaf2]/80 px-3 py-2 shadow-[0_8px_22px_rgba(96,67,43,.07)] backdrop-blur"><div className="relative z-10 flex items-center gap-3 rounded-2xl border border-[#d6b18c]/15 bg-white/[.035] px-3 py-3"><div className="flex min-w-0 flex-1 items-center gap-2"><span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden border border-[#d6b18c]/45 bg-[#e6d4bf] text-xs text-[#694e43]">{character?.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character?.name.slice(0,1) ?? "TA"}</span><span className="min-w-0"><span className="block truncate text-xs text-[#f1dfc9]">{character?.name ?? "TA"}</span><span className="block text-[10px] text-[#a9937e]">{watching ? "正在陪你看" : "等你一起看"}</span></span></div><div className="flex h-10 min-w-[76px] flex-1 items-center justify-center gap-[3px]" aria-label="双人同步电波">{Array.from({length:15},(_,i)=><span key={i} className="w-[2px] rounded-full bg-[#c99a78]" style={{height:`${5+((i*7+3)%13)}px`,opacity:watching?0.95:0.45,animation:watching?`watchWave 900ms ease-in-out ${i*55}ms infinite alternate`:undefined}}/>)}</div><div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right"><span className="min-w-0"><span className="block truncate text-xs text-[#f1dfc9]">{playerIdentity?.name || "我"}</span><span className="block text-[10px] text-[#a9937e]">和你同频</span></span><span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden border border-[#d6b18c]/45 bg-[#6d5141] font-serif text-sm text-[#f1dfc9]">{playerIdentity?.avatarUrl ? <img src={playerIdentity.avatarUrl} alt="" className="h-full w-full object-cover"/> : (playerIdentity?.name || "我").slice(0, 1)}</span></div></div></div></div>
      <section
        ref={playerRef}
        className="watch-player relative mx-auto w-full max-w-3xl min-h-0 overflow-hidden rounded-[26px] border border-white/10 bg-[#0d0b09]"
        style={{ boxShadow: "0 0 0 1px rgba(255,214,170,.06), 0 28px 70px rgba(0,0,0,.6), 0 0 120px rgba(201,143,82,.16)" }}
      >
        {target?.nativeVideo ? (
          <video key={target.nativeVideoUrl || target.url} src={target.nativeVideoUrl || target.url} controls playsInline onPlay={() => setMediaPaused(false)} onPause={() => setMediaPaused(true)} className={fullScreen ? "h-full w-full object-contain bg-black" : "aspect-video w-full bg-black"} onEnded={() => { const cached = nativeVideoCacheRef.current; if (cached && cached.url === target.url) { try { (window as WatchNativeWindow).AndroidShell?.deleteCachedShortVideo?.(cached.cacheId); } catch { /* cache TTL fallback */ } nativeVideoCacheRef.current = null; } }} onError={() => { const cached = nativeVideoCacheRef.current; if (cached && cached.url === target.url) { try { (window as WatchNativeWindow).AndroidShell?.deleteCachedShortVideo?.(cached.cacheId); } catch { /* cache TTL fallback */ } nativeVideoCacheRef.current = null; } onNotice?.("视频无法在当前 WebView 播放，可能是格式、签名有效期或平台防盗链限制。"); }} />
        ) : target?.embedUrl ? (
          <iframe key={target.embedUrl} src={target.embedUrl} title={videoTitle || target.platformName} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" className={fullScreen ? "h-full w-full border-0" : "aspect-video w-full border-0"} />
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center px-6 text-center">
            <div className="mt-5 font-serif text-lg tracking-wide text-[#efe2d0]">{target ? `${target.platformName}需要外部打开` : "把想看的放上屏幕"}</div>
            <p className="mt-2 max-w-xs text-[11px] leading-6 text-[#9c9086]">
              {target ? "目前无法在小手机内播放这个链接。若原生解析失败，可尝试打开原视频或选择本地视频；角色只有在成功取得字幕/脚本后才能理解视频内容，不会假装看到了画面。" : "粘贴一个视频链接，或选择本地视频，让你们在同一个页面里边看边聊。"}
            </p>
            {target && <button onClick={() => openExternalUrl(target.url)} className="mt-5 flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs text-[#e6d8c4] transition active:scale-95"><ExternalLink size={13}/>打开原视频</button>}
          </div>
        )}

        {target && !target.supported && target.embedUrl === target.url && (
          <a
            href={target.url}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-2 right-2 z-20 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-black/75 px-3 py-2 text-[10px] text-white shadow-lg backdrop-blur"
            onClick={event => event.stopPropagation()}
          >
            <ExternalLink size={12}/>若无法播放，打开原网页
          </a>
        )}

        {fullScreen && target && <div className="watch-companion-overlay pointer-events-none absolute left-2 right-2 top-[max(48px,calc(env(safe-area-inset-top)+12px))] z-30">
          {companionCollapsed ? <button type="button" onClick={() => setCompanionCollapsed(false)} className="watch-companion-pill pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-white/25 bg-black/65 px-3 py-2 text-left text-white shadow-lg backdrop-blur-xl">
            {character?.avatar ? <img src={character.avatar} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover"/> : <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#8b6b57] text-xs">{character?.name.slice(0,1) || "TA"}</span>}
            <span className="min-w-0 flex-1 truncate text-xs">{latestComment?.text || "陪看已就绪"}</span><ChevronDown size={14} className="shrink-0"/>
          </button> : <div className="watch-companion-card pointer-events-auto max-w-[min(540px,100%)] rounded-2xl border border-white/20 bg-black/62 p-2.5 text-white shadow-xl backdrop-blur-xl">
            <div className="flex min-w-0 items-center gap-2">
              {character?.avatar ? <img src={character.avatar} alt="" className="h-9 w-9 shrink-0 rounded-full border border-white/20 object-cover"/> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#8b6b57] text-sm">{character?.name.slice(0,1) || "TA"}</span>}
              <div className="min-w-0 flex-1"><p className="truncate text-[10px] text-white/65">{character?.name || "TA"} · 陪你看</p><p className="mt-0.5 line-clamp-2 break-words text-xs leading-5">{latestComment ? latestComment.text : "开始播放后，TA 会把即时反应变成弹幕。"}</p></div>
              <button type="button" onClick={() => { setCompanionCollapsed(true); setShowQuickChat(false); }} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10" aria-label="收起陪看悬浮窗"><ChevronDown size={15}/></button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" onClick={() => actTogether("我们先停一下，聊聊刚才这一幕。")} disabled={!character} className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1.5 text-[10px] disabled:opacity-40">暂停聊聊</button>
              <button type="button" onClick={() => actTogether("我想和你分享一下刚才这一幕带给我的感受。")} disabled={!character} className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1.5 text-[10px] disabled:opacity-40">说说感受</button>
              <button type="button" onClick={() => actTogether("只根据已经出现的画面聊聊眼前线索，不推测或透露后续剧情。")} disabled={!character} className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1.5 text-[10px] disabled:opacity-40">聊聊线索</button>
              <button type="button" onClick={() => setShowQuickChat(value => !value)} disabled={!character} className="rounded-full bg-[#e6c49d] px-2.5 py-1.5 text-[10px] text-[#302218] disabled:opacity-40">发弹幕 / 交流</button>
              <button type="button" onClick={() => { setWatching(value => !value); if (!watching) void generateComment(false); }} disabled={!character} className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1.5 text-[10px] disabled:opacity-40">{watching ? "暂停自动搭话" : "开始自动陪看"}</button>
            </div>
            {showQuickChat && <form onSubmit={event => { event.preventDefault(); submitDiscussion(); }} className="mt-2 flex items-center gap-2 border-t border-white/15 pt-2">
              <input autoComplete="off" value={discussionDraft} onChange={event => setDiscussionDraft(event.target.value.slice(0,800))} placeholder="发一条只属于你们的弹幕…" className="min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white outline-none placeholder:text-white/45"/>
              <button type="submit" disabled={!discussionDraft.trim()} className="shrink-0 rounded-full bg-[#e6c49d] px-3 py-2 text-xs text-[#302218] disabled:opacity-40">发送</button>
            </form>}
          </div>}
        </div>}
        <DanmakuLayer enabled={Boolean(target?.embedUrl || target?.nativeVideo)} paused={mediaPaused} items={danmakuItems} userColor={settings.danmakuColor} />
        <div className="absolute right-2 top-2 z-20 flex gap-1">
          <button type="button" onClick={() => void captureCurrentFrame()} className="grid h-8 w-8 place-items-center rounded-lg bg-black/55 text-white/90 backdrop-blur transition active:scale-95" aria-label="截取当前画面并用于理解" title="截取当前画面"><ImagePlus size={14}/></button>
          <button type="button" onClick={() => screenshotFileInputRef.current?.click()} className="grid h-8 w-8 place-items-center rounded-lg bg-black/55 text-white/90 backdrop-blur transition active:scale-95" aria-label="上传截图" title="上传截图"><FileText size={14}/></button>
          <button type="button" disabled={!target} onClick={event => { event.preventDefault(); event.stopPropagation(); void enterFullscreen(); }} className="grid h-8 w-8 place-items-center rounded-lg bg-black/45 text-white/90 backdrop-blur transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35" aria-label={fullScreen ? "退出全屏" : "全屏"} title={fullScreen ? "退出全屏" : "全屏"}><Expand size={15}/></button>
        </div>
        {/* 屏幕洒在桌面上的余光 */}
        {!fullScreen && <div aria-hidden className="pointer-events-none absolute -bottom-6 left-1/2 h-6 w-[86%] -translate-x-1/2 rounded-[50%] opacity-40 blur-xl" style={{ background: "radial-gradient(ellipse, #d7a06a 0%, transparent 70%)" }} />}
        {fullScreen && <form onSubmit={event => { event.preventDefault(); const text = danmakuDraft.trim(); if (!text) return; submitDiscussion(text); setDanmakuDraft(""); }} className="absolute bottom-3 left-1/2 z-30 w-[min(560px,88%)] -translate-x-1/2"><div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/55 px-3 py-1.5 backdrop-blur"><input value={danmakuDraft} onChange={event => setDanmakuDraft(event.target.value.slice(0,120))} placeholder="发个弹幕…" className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/45"/><button type="submit" disabled={!danmakuDraft.trim()} className="shrink-0 rounded-full bg-[#e6c49d] px-3 py-1 text-xs text-[#302218] disabled:opacity-40">发送</button></div></form>}
      </section>
        {resolverState.state !== "idle" && <div className="mx-auto mt-2 flex w-full max-w-3xl items-start gap-1.5 px-1 text-[10px] leading-5" data-resolver-state={resolverState.state}><span className={resolverState.state==="ok"?"text-[#8fd0a2]":resolverState.state==="failed"?"text-[#e0938a]":"text-[#d9b489]"}>{resolverState.state==="resolving"?"正在解析视频链接…":resolverState.state==="ok"?"✓ 解析成功 · 已在应用内播放":"✕ 解析失败："+(resolverState.message||"未知原因")}</span></div>}

      {/* 没有视频时：链接输入放在「屏幕」下方，像往播放器里投一块碟 */}
      <div className="watch-link-panel mx-auto mt-4 w-full max-w-3xl rounded-3xl border border-[#b89979]/30 bg-[#fff8ed]/75 p-3 shadow-[0_12px_30px_rgba(96,67,43,.08)] backdrop-blur sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={urlInput} onPointerDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onChange={event => setUrlInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") openVideo(); }} placeholder="粘贴视频链接；短视频分享链接不保证能自动内嵌" className="min-w-0 flex-1 rounded-2xl border border-[#dac6ad] bg-white/90 px-4 py-3.5 text-sm text-[#554437] outline-none placeholder:text-[#a09383] focus:border-[#b88768] focus:ring-2 focus:ring-[#c99a6a]/15" />
          <button onClick={openVideo} className="rounded-2xl px-5 py-3.5 text-sm font-semibold tracking-wide text-[#2a1f16] shadow-sm transition hover:brightness-[1.02] active:scale-[.98]" style={{ background: "linear-gradient(135deg,#f0d0a8,#c99a6a)" }}>放上屏幕</button>
          <button type="button" onClick={() => videoFileInputRef.current?.click()} className="rounded-2xl border border-[#b89979]/50 bg-white/90 px-4 py-3.5 text-sm font-medium text-[#735440] transition hover:bg-white active:scale-[.98]">选择本地视频</button>
          <button type="button" onClick={() => transcriptFileInputRef.current?.click()} className="rounded-2xl border border-[#b89979]/50 bg-white/90 px-4 py-3.5 text-sm font-medium text-[#735440] transition hover:bg-white active:scale-[.98]">导入脚本 / 字幕</button>
        </div>
        <input ref={videoFileInputRef} type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.ogv" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; openLocalVideo(file); }} />
        <input ref={screenshotFileInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void loadScreenshotFile(file); }} />
        <input ref={transcriptFileInputRef} type="file" accept=".srt,.vtt,.txt,.json,text/plain,text/vtt,application/json" className="hidden" onChange={event => {
          const file = event.target.files?.[0]; event.currentTarget.value = "";
          if (!file) return;
          void readTranscriptFile(file).then(source => {
            const parsed = parseVideoTranscript(source);
            if (!parsed.length) { onNotice?.("没有识别到脚本正文或字幕时间轴。可导入 .srt、.vtt、.txt 或带 segments 的 .json。"); return; }
            setTranscriptSegments(parsed);
            setTranscriptName(file.name);
            const unsynced = parsed.length === 1 && parsed[0].start === 0 && parsed[0].end >= 86400;
            onNotice?.("已导入 " + file.name + "，识别到 " + parsed.length + " 段" + (unsynced ? "（纯文本，无精确时间戳）" : "时间戳片段") + "。陪看会优先引用当前时间附近的脚本。");
          }).catch(error => onNotice?.("脚本读取失败：" + (error instanceof Error ? error.message : String(error))));
        }} />
        {transcriptSegments.length > 0 && <div role="status" aria-live="polite" className="mt-2 flex items-start justify-between gap-3 rounded-xl border border-[#cdb79b]/60 bg-[#fffaf2] px-3 py-2 text-xs leading-5 text-[#82644c]"><span className="min-w-0">已载入脚本：{transcriptName} · {transcriptSegments.length} 段{transcriptSegments.length === 1 && transcriptSegments[0].end >= 86400 ? " · 无精确时间戳" : ""}</span><button type="button" onClick={() => { setTranscriptSegments([]); setTranscriptName(""); }} className="shrink-0 border-b border-[#cdb79b] text-[#8d6459]">移除</button></div>}
        {screenshotDataUrl && <div className="mt-2 flex items-center gap-3 rounded-xl border border-[#cdb79b]/60 bg-[#fffaf2] p-2 text-xs text-[#82644c]"><img src={screenshotDataUrl} alt="本轮陪看截图" className="h-14 w-20 rounded-lg object-contain bg-black/10"/><span className="min-w-0 flex-1">已附加画面截图 · 需绑定支持视觉的模型并开启图片识别</span><button type="button" onClick={() => setScreenshotDataUrl("")} className="shrink-0 border-b border-[#cdb79b] text-[#8d6459]">移除</button></div>}
        {target && target.platformName !== "本地视频" && !target.embedUrl && !target.nativeVideoUrl && <p role="status" aria-live="polite" className="mt-2 rounded-xl bg-[#f4e7d6] px-3 py-2 text-xs leading-5 text-[#82644c]">{resolutionMessage || "等待检查视频链接……"}</p>}
        {resolutionMessage && (target?.embedUrl || target?.nativeVideoUrl) && <p role="status" aria-live="polite" className="mt-2 rounded-xl border border-[#cdb79b]/60 bg-[#fffaf2] px-3 py-2 text-xs leading-5 text-[#82644c]">{resolutionMessage}</p>}
        {target?.platformName === "本地视频" && <p className="mt-2 px-1 text-[11px] leading-5 text-[#8b7665]">当前播放的是本地文件；选择新文件或输入链接可以切换视频。</p>}
        {platformNote && <p className="mt-2 px-1 text-[11px] leading-5 text-[#8b7665]">{platformNote}</p>}
        <details className="mt-3 rounded-2xl border border-[#b89979]/30 bg-[#fffaf2]/80 p-3 text-[#71553f]">
          <summary className="cursor-pointer text-xs font-medium">从链接生成时间戳脚本 · 本地 / Cloudflare 转写</summary>
          <p className="mt-2 text-[11px] leading-5 text-[#8b7665]">目标是让角色真正理解视频内容：优先使用平台可取得的字幕/时间戳，再用音轨转写补齐；脚本会按当前播放进度喂给角色，避免只凭标题猜剧情。视频播放和脚本解析是两条链路：某个平台能在这里播放，不代表它允许读取字幕或下载音轨。</p>
          <details className="mt-2 rounded-xl border border-[#b89979]/25 bg-white/50 p-2.5">
            <summary className="cursor-pointer text-[11px] font-medium">Cloudflare Workers AI 云端部署（电脑不用常开）</summary>
            <ol className="mt-2 list-decimal space-y-2 pl-4 text-[11px] leading-5 text-[#8b7665]">
              <li>在 GitHub 仓库的 <code>tools/cloudflare-video-transcriber</code> 目录查看完整教程。首次部署需要电脑安装 Node.js，并登录 Cloudflare；部署成功后转写运行在 Cloudflare，不需要电脑持续开机。</li>
              <li>在 Cloudflare Worker 配置里，把 <code>ALLOWED_ORIGINS</code> 改成当前小手机网页的准确源地址，把 <code>ALLOWED_MEDIA_HOSTS</code> 改成你信任且托管音频文件的域名；不要设为通配符。</li>
              <li>在该目录执行 <code>npx wrangler secret put TRANSCRIBE_TOKEN</code> 设置访问令牌，再运行 <code>npx wrangler deploy</code>。把部署后的 <code>https://…workers.dev</code> 地址和同一令牌填到下面。</li>
              <li><strong>当前云端版本只接收可直接访问的 HTTPS 音频文件</strong>（如 MP3/WAV/M4A/OGG，单个文件最多 8 MB），不能把 B 站、YouTube 等视频页面链接直接变成音轨。任意平台视频仍需要可获取的字幕，或使用下方本地转写服务。</li>
            </ol>
          </details>
          <details className="mt-2 rounded-xl border border-[#b89979]/25 bg-white/50 p-2.5">
            <summary className="cursor-pointer text-[11px] font-medium">本地转写服务部署（电脑需要运行）</summary>
            <ol className="mt-2 list-decimal space-y-2 pl-4 text-[11px] leading-5 text-[#8b7665]">
              <li>在电脑上安装 Python 3.10+ 和 FFmpeg；从项目仓库根目录运行 <code>pip install -r tools/video-transcriber/requirements.txt</code>。</li>
              <li>Windows PowerShell 中运行：<code>$env:VIDEO_TRANSCRIBER_TOKEN = (python -c "import secrets; print(secrets.token_urlsafe(32))")</code>，再设置 <code>$env:VIDEO_TRANSCRIBER_ALLOWED_ORIGINS = "你当前小手机网页的完整 https 地址"</code>。</li>
              <li>启动服务：<code>python tools/video-transcriber/server.py --host 127.0.0.1 --port 8765</code>。电脑需要保持开机；首次转写会下载语音模型，之后复用缓存。手机不能把电脑的 localhost 当成电脑地址。</li>
              <li>如果手机需要跨网络访问，可选用 Cloudflare Tunnel：在电脑安装 cloudflared 后，可先用临时隧道测试：<code>cloudflared tunnel --url http://localhost:8765</code>，将终端显示的 <code>https://…trycloudflare.com</code> 地址填入下方“服务地址”（应用会自动补上 <code>/transcribe</code>）。要长期使用再配置命名隧道。隧道只负责安全转发，不替你运行转写；电脑关机或服务停止后就不可用。不要公开分享隧道地址或访问令牌。</li>
              <li>把服务地址和令牌填入本页，粘贴视频链接后点“解析链接并生成脚本”。若平台限制下载、需要登录态或触发风控，转写可能失败；可尝试导入字幕文件，应用不会假装已经看懂未取得的内容。</li>
            </ol>
            <p className="mt-2 text-[10px] leading-4 text-[#8b7665]">本地方案能借助 yt-dlp 尝试获取部分平台字幕/音轨，兼容面更广但电脑必须运行。Cloudflare 云端方案无需电脑常开，但目前只支持配置白名单域名下的直接音频文件，不会解析任意视频平台页面。两种方案共用下面的服务地址和令牌输入框。</p>
          </details>
          <label className="mt-3 block text-[11px]">服务地址
            <input type="url" value={transcriberEndpoint} onChange={event => setTranscriberEndpoint(event.target.value)} placeholder="https://你的-worker.workers.dev 或本地服务地址" className="mt-1 w-full rounded-xl border border-[#dac6ad] bg-white px-3 py-2 text-xs outline-none focus:border-[#b88768]"/>
          </label>
          <label className="mt-2 block text-[11px]">访问令牌（仅保存在此设备）
            <input type="password" autoComplete="off" value={transcriberToken} onChange={event => setTranscriberToken(event.target.value)} placeholder="VIDEO_TRANSCRIBER_TOKEN" className="mt-1 w-full rounded-xl border border-[#dac6ad] bg-white px-3 py-2 text-xs outline-none focus:border-[#b88768]"/>
          </label>
          <label className="mt-2 block text-[11px]">转写模型
            <select value={transcriberModel} onChange={event => setTranscriberModel(event.target.value as typeof transcriberModel)} className="mt-1 w-full rounded-xl border border-[#dac6ad] bg-white px-3 py-2 text-xs outline-none"><option value="tiny">tiny · 最省资源（本地服务）</option><option value="base">base（本地服务）</option><option value="small">small · 中文均衡推荐（本地服务）</option><option value="medium">medium · 更高资源占用（本地服务）</option></select>
          </label>
          <p className="mt-1 text-[10px] leading-4 text-[#8b7665]">若服务地址是 Cloudflare Workers，模型固定使用 Cloudflare Whisper Large v3 Turbo，此处模型选项只影响本地转写服务。</p>
          <button type="button" disabled={transcribing || !(urlInput.trim() || target?.url)} onClick={() => void transcribeFromUrl()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[#87565b] px-3 py-2.5 text-xs text-white disabled:opacity-40">
            {transcribing ? <LoaderCircle size={13} className="animate-spin"/> : <FileText size={13}/>}
            {transcribing ? "正在生成脚本…" : "解析链接并生成脚本"}
          </button>
        </details>
      </div>

      {/* 角色在屏幕下方轻声说话 */}
      <section className="watch-interaction-panel mx-auto mt-4 w-full max-w-3xl">
        <div data-part="card" className="watch-room-card relative isolate overflow-hidden rounded-[28px] border border-[#d4a575]/25 bg-gradient-to-br from-[#49372b]/95 via-[#2d231d]/95 to-[#1c1714]/98 p-4 shadow-[0_18px_46px_rgba(57,37,24,.24),inset_0_1px_0_rgba(255,224,184,.12)] backdrop-blur-xl sm:p-5">
          <div data-part="message" className="relative z-10 flex items-start gap-3">
            {character && <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-[#4a3d33] text-xs text-[#e6d8c4]">{character.avatar ? <img src={character.avatar} alt="" className="h-full w-full object-cover"/> : character.name.slice(0, 1)}</span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2"><span className="text-[11px] tracking-[.08em] text-[#d6b18c]">{latestComment?.characterName ?? character?.name ?? "角色"}</span><span className="text-[10px] text-[#a9937e]">{busy ? "正在回应…" : watching ? "同频陪看" : "等待交流"}</span></div>
              <p className="mt-1.5 min-h-[22px] font-serif text-[15px] leading-7 text-[#efe2d0]">
                {latestComment ? latestComment.text : <span className="text-[#8b8077]">TA 还没说话。可以自己先说说此刻看到了什么。</span>}
              </p>
            </div>
          </div>

            <div data-part="composer" className="watch-discussion-composer mt-3 border-t border-[#d6b18c]/20 pt-3"><div className="flex items-center gap-2"><input value={timepointDraft} onPointerDown={event=>event.stopPropagation()} onTouchStart={event=>event.stopPropagation()} inputMode="numeric" autoComplete="off" maxLength={8} onChange={event=>{ const next=event.target.value.replace(/[^0-9:.]/g, "").slice(0,8); timepointDraftRef.current=next; setTimepointDraft(next); }} placeholder="时间点 03:12（可选）" aria-label="视频时间点，例如 03:12" className="w-[42%] min-w-0 border-b border-[#9c7b63]/60 bg-transparent px-1 py-2 text-xs text-[#f0dfcc] outline-none placeholder:text-[#907d6c] focus:border-[#e4c6a8]"/><span className="text-[10px] text-[#907d6c]">时间点 / 章节标记</span></div><textarea value={discussionDraft} onPointerDown={event=>event.stopPropagation()} onTouchStart={event=>event.stopPropagation()} onChange={event=>setDiscussionDraft(event.target.value.slice(0,800))} maxLength={800} rows={2} placeholder={target ? "写下你对这一幕的看法……" : "先放上视频，再写下你对这一幕的看法……"} className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-black/20 p-3 text-sm leading-6 text-[#efe2d0] outline-none placeholder:text-[#907d6c] focus:border-[#c99a78]/60 focus:ring-2 focus:ring-[#c99a78]/10"/><div className="mt-2 flex justify-end"><button type="button" onClick={() => submitDiscussion()} disabled={!target||!discussionDraft.trim()} className="inline-flex items-center rounded-full border border-[#c99a78]/60 bg-[#c99a78] px-4 py-2.5 text-xs font-medium text-[#2a1f16] shadow-sm transition hover:brightness-105 active:scale-[.98] disabled:opacity-40"><MessageCircle size={13} className="mr-1 inline"/>记下并问问 TA</button></div></div>
          <div data-part="actions" className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => void generateComment(true)} disabled={!target || !character || busy} className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs text-[#2a1f16] transition active:scale-95 disabled:opacity-40" style={{ background: "linear-gradient(135deg,#e8c39a,#c99a6a)" }}>
              {busy ? <LoaderCircle size={13} className="animate-spin"/> : <MessageCircle size={13}/>}让 TA 即时回应
            </button>
            <button onClick={() => { setWatching(value => !value); if (!watching) void generateComment(false); }} disabled={!target || !character} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs text-[#d8c9b6] transition active:scale-95 disabled:opacity-40">
              {watching ? <Pause size={13}/> : <Play size={13}/>}{watching ? "暂停陪看" : "开始陪看"}
            </button>
            {target?.platformName === "本地视频" && localVideoFileRef.current && <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 rounded-xl border border-[#c99a78]/30 bg-white/[.04] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold text-[#e6c49d]">专注模式 · 完整视频理解</div>
                <div className="mt-0.5 text-[10px] leading-4 text-[#a9937e]">把整个本地视频发送给 Gemini，而不只是当前截图；请确认允许将视频交给 Google 处理。</div>
                {wholeVideoProgress && <div role="status" aria-live="polite" className="mt-1 text-[10px] text-[#e6c49d]">{wholeVideoProgress}</div>}
              </div>
              <button type="button" onClick={() => { if (wholeVideoBusy) wholeVideoAbortRef.current?.abort(); else void analyzeWholeLocalVideo(); }} disabled={!wholeVideoBusy && !character} className="shrink-0 rounded-full border border-[#c99a78]/60 bg-[#c99a78] px-3 py-2 text-[11px] font-semibold text-[#2a1f16] disabled:opacity-40">{wholeVideoBusy ? "取消分析" : "让角色看完整视频"}</button>
            </div>}
            <button onClick={() => { setGlobalWatchRecords(loadGlobalWatchRecords()); setShowHistory(true); }} disabled={!comments.length && !globalWatchRecords.length} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs text-[#d8c9b6] transition active:scale-95 disabled:opacity-40">
              <Heart size={13}/>回看悄悄话 {comments.length > 0 && <span className="text-[#c99a6a]">{comments.length}</span>}
            </button>
            <button onClick={() => setShowSettings(value => !value)} className="ml-auto flex items-center gap-1 rounded-full px-2 py-2 text-[11px] text-[#8b8077] transition active:scale-95"><ChevronDown size={13} className={showSettings ? "rotate-180 transition" : "transition"}/>陪看方式</button>
          </div>

          <section data-part="history" className="relative z-10 mt-5 min-h-0 border-t border-[#d6b18c]/20 pt-4">
            <div className="flex items-baseline justify-between gap-2"><h2 className="font-serif text-base tracking-wide text-[#f0dfcc]">一起讨论</h2><span className="text-[10px] tracking-[.12em] text-[#a9937e]">SCENE NOTES · {comments.length}</span></div>
            <p className="mt-1 text-[10px] leading-5 text-[#a9937e]">把某一幕或想说的话记在对应时间点；你的消息和 TA 的回应都会出现在画面弹幕与下方讨论记录里。</p>
            {comments.some(item=>item.timepoint) && <div className="mt-3 flex flex-wrap gap-2">{[...new Set(comments.filter(item=>item.timepoint).map(item=>item.timepoint!))].map(point=><button key={point} type="button" onClick={()=>{setTimepointDraft(point);setDiscussionDraft(`想再聊聊 ${point} 这一幕`);const seconds=parseVideoTime(point);const video=playerRef.current?.querySelector("video");if(seconds===null){onNotice?.("这个时间点格式无法识别，已填入笔记但没有跳转。");return;}if(video){try{video.currentTime=seconds;onNotice?.(`已跳转到 ${point}`);}catch{onNotice?.("当前视频暂时无法跳转到该时间点。");}}else{onNotice?.("当前使用第三方网页播放器，无法由小手机控制播放进度；时间点已填入，可继续记笔记。");}} className="border-b border-[#c99a78]/60 px-1 py-1 text-[11px] text-[#e4c6a8]">{point} ↗</button>)}</div>}
            <div ref={commentListRef} onScroll={event => { const list = event.currentTarget; commentListAtBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 56; }} className="watch-comment-list mt-3 min-h-0 max-h-64 space-y-3 overflow-y-auto overscroll-contain pr-1">{comments.length ? comments.slice(-30).map(item=><div key={item.id} className={`flex ${item.kind==="user"?"justify-end":"justify-start"}`}><div className={`max-w-[88%] rounded-2xl border px-3 py-2.5 shadow-sm ${item.kind==="user"?"border-[#d6b18c]/35 bg-[#d6b18c]/10":"border-white/10 bg-white/[.045]"}`}><p className="whitespace-pre-wrap break-words font-serif text-sm leading-6 text-[#efe2d0]">{item.text}</p></div></div>) : <p className="border-l border-[#c99a78]/45 py-1 pl-3 text-xs leading-6 text-[#a9937e]">这里留给你们讨论剧情、吐槽片段，或标记想一起记住的时刻。</p>}</div>
          </section>
          <div data-part="actions2" className="relative z-10 mt-2 flex flex-wrap gap-1.5">
            {[
              ["✦", "暂停聊聊", "我们先停一下，聊聊刚才这一幕。"],
              ["◌", "标记这一幕", "这段值得记下来，之后我们再一起回看。"],
              ["♡", "说说感受", "我想和你分享一下刚才这一幕带给我的感受。"],
              ["↗", "聊聊眼前线索", "只根据已经出现的画面聊聊眼前线索，不推测或透露后续剧情。"],
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
            {([["voiceEnabled", "角色语音"], ["danmakuEnabled", "角色弹幕"]] as [keyof WatchSettings, string][]).map(([key, label]) => <button
              key={key}
              type="button"
              onClick={() => patchSettings({ [key]: !settings[key] } as Partial<WatchSettings>)}
              className={`rounded-full border px-3 py-2 text-[11px] transition active:scale-95 ${settings[key] ? "border-[#c99a6a]/60 bg-[#c99a6a]/15 text-[#e8c39a]" : "border-white/10 bg-white/5 text-[#8b8077]"}`}
            >{label}</button>)}
          </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-[#8b8077]">我的弹幕颜色</span>
              {DANMAKU_COLORS.map(color => <button key={color} type="button" aria-label={color} onClick={() => patchSettings({ danmakuColor: color })} className={"h-6 w-6 rounded-full border " + ((settings.danmakuColor || "#e6c49d").toLowerCase() === color.toLowerCase() ? "border-white ring-2 ring-white/30" : "border-white/20")} style={{ background: color }} />)}
              <label className="relative h-6 w-8 cursor-pointer overflow-hidden rounded border border-white/20" aria-label="自定义弹幕颜色"><input type="color" value={settings.danmakuColor} onChange={event => patchSettings({ danmakuColor: event.target.value })} className="absolute -left-1 -top-1 h-10 w-12 cursor-pointer border-0 bg-transparent p-0" /></label>
            </div>
          <p className="mt-3 text-[10px] leading-5 text-[#7d7268]">角色发言使用你已配置的聊天模型与语音绑定。平台自带的字幕/弹幕开关无法跨站控制，这里的开关只作用于「角色陪看」这一层。</p>
      </section>
    </div>}

    {/* 悄悄话抽屉：历史发言收起来，不占屏幕 */}
    {showHistory && <div className="absolute inset-0 z-[1012] flex flex-col justify-end bg-black/55 backdrop-blur-sm" onClick={() => setShowHistory(false)}>
      <section className="flex max-h-[72%] flex-col overflow-hidden rounded-t-[26px] border-t border-white/12 bg-[#221c17]" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-white/8 px-4 py-3.5">
          <div>
            <div className="font-serif text-base tracking-wide text-[#efe2d0]">{historyMode === "global" ? "全局陪看记录" : "今晚说过的话"}</div>
            <div className="mt-0.5 text-[10px] tracking-[.18em] text-[#7d7268]">{historyComments.length} 条 · 保存在一起看</div>
            <div className="mt-2 flex gap-2"><button type="button" onClick={() => setHistoryMode("current")} className={"rounded-full px-2.5 py-1 text-[10px] " + (historyMode === "current" ? "bg-[#c99a6a] text-[#241b15]" : "border border-white/10 text-[#a2948a]")}>应用内陪看</button><button type="button" onClick={() => { setGlobalWatchRecords(loadGlobalWatchRecords()); setHistoryMode("global"); }} className={"rounded-full px-2.5 py-1 text-[10px] " + (historyMode === "global" ? "bg-[#c99a6a] text-[#241b15]" : "border border-white/10 text-[#a2948a]")}>全局陪看</button></div>
          </div>
          <button onClick={() => setShowHistory(false)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-[#a2948a]"><X size={15}/></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {historyComments.length ? <div className="space-y-3">{[...historyComments].reverse().map(comment => <div key={comment.id} className="rounded-2xl border border-white/8 bg-white/[.035] px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] tracking-wide text-[#c99a6a]">{comment.kind === "user" ? "我" : comment.characterName}</span>
              <span className="text-[10px] text-[#6f665e]">{new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            <p className="mt-1 font-serif text-sm leading-6 text-[#ded0bd]">{comment.text}</p>
          </div>)}</div> : <p className="py-10 text-center text-xs text-[#7d7268]">{historyMode === "global" ? "还没有全局陪看记录。" : "还没有说过话。"}</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-white/8 px-4 py-3" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
          <span className="text-[10px] text-[#6f665e]">{watching ? "正在陪看" : "已暂停"}</span>
          <button onClick={() => { if (historyMode === "global") { clearGlobalWatchRecords(); setGlobalWatchRecords([]); } else { setComments([]); if (target) saveTargetComments(target.url, []); } }} className="flex items-center gap-1.5 border-b border-white/12 px-2 py-2 text-[11px] text-[#a2948a] transition active:opacity-60"><Sparkles size={12}/>清空记录</button>
        </footer>
      </section>
    </div>}

    <audio ref={audioRef} className="hidden" />
  </div>;
}
