"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Expand, ExternalLink, Heart, ImagePlus, LoaderCircle, MessageCircle, Pause, Play, Settings2, Sparkles, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import { resolveVoiceConfig, synthesizeSpeech } from "@/lib/tts-service";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "@/lib/settings-storage";
import { readCompressedImageDataUrl } from "@/lib/chat-engine";
import { captureScreenshot, hasScreenshotBridge } from "@/lib/screenshot";

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
type Platform = "bilibili" | "youtube" | "tencent" | "youku" | "iqiyi" | "douyin" | "xiaohongshu" | "other";
type VideoTarget = { url: string; embedUrl: string | null; platform: Platform; platformName: string; supported: boolean; nativeVideo?: boolean; nativeVideoUrl?: string; nativeCacheId?: string };
type WatchNativeBridge = { resolveShortVideoShareUrl?: (url: string, requestId: string) => boolean; deleteCachedShortVideo?: (cacheId: string) => boolean };
type WatchNativeWindow = Window & { AndroidShell?: WatchNativeBridge };
type WatchNativeResolved = { requestId?: string; ok?: boolean; cacheId?: string; contentUri?: string; message?: string };
type WatchComment = { id: string; characterId: string; characterName: string; text: string; createdAt: string; kind?: "character" | "user"; timepoint?: string; targetUrl?: string };
type WatchSettings = { characterId: string; intervalMinMinutes: number; intervalMaxMinutes: number; voiceEnabled: boolean; danmakuEnabled: boolean; subtitlesEnabled: boolean; currentMoment: string };

const SETTINGS_KEY = "ai_phone_watch_together_v1";
const SETTINGS_MIGRATION_KEY = "ai_phone_watch_together_schema_v2";
const COMMENTS_KEY = "ai_phone_watch_together_comments_v1";
const DEFAULT_SETTINGS: WatchSettings = { characterId: "", intervalMinMinutes: 3, intervalMaxMinutes: 8, voiceEnabled: true, danmakuEnabled: true, subtitlesEnabled: false, currentMoment: "" };
function formatVideoTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours > 0
    ? String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0")
    : String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
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
    if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com") || host === "xhslink.cn" || host.endsWith(".xhslink.cn")) return { url: original, embedUrl: null, platform: "xiaohongshu", platformName: "小红书", supported: false };
    return { url: original, embedUrl: null, platform: "other", platformName: host, supported: false };
  } catch { return null; }
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
  const screenshotFileInputRef = useRef<HTMLInputElement>(null);
  const localVideoObjectUrlRef = useRef<string | null>(null);
  const nativeVideoCacheRef = useRef<{ url: string; cacheId: string } | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [resolutionMessage, setResolutionMessage] = useState("");

  useEffect(() => {
    const current = target;
    if (!current) { setResolutionMessage(""); return; }
    if (current.nativeVideo) { setResolutionMessage("解析成功：已取得可播放的视频源，当前由小手机内置播放器播放。"); return; }
    setResolutionMessage("正在检查此链接是否支持站内播放……");
    /**
     * 平台视频优先试一次「原生解析出真实视频流」：
     * 成功就换成同源 <video> 播放——真正的站内播放，还能直接截帧给角色看；
     * 失败就静默留在 iframe 上，不拿提示打扰用户。
     * （B 站要生效，壳侧 isSupportedShareUrl 需要把 bilibili.com / b23.tv 加进白名单。）
     */
    const preferNativeStream = current.platform === "bilibili";
    if ((current.embedUrl || current.supported) && !preferNativeStream) {
      setResolutionMessage("已识别链接，当前使用平台站内播放器。这不代表已经解析出真实视频流。");
      return;
    }
    let host = "";
    try { host = new URL(current.url).hostname.toLowerCase(); } catch { return; }
    const roots = ["xhslink.com", "xhslink.cn", "xiaohongshu.com", "douyin.com", "iesdouyin.com", "kuaishou.com", "bilibili.com", "b23.tv"];
    if (!roots.some(root => host === root || host.endsWith("." + root))) {
      setResolutionMessage("当前解析器不支持这个平台。可尝试站内嵌入、打开原视频或选择本地视频。");
      return;
    }
    const native = (window as WatchNativeWindow).AndroidShell;
    if (!native || !native.resolveShortVideoShareUrl) {
      setResolutionMessage("当前 APK 没有提供原生视频解析能力。可以使用支持嵌入的平台，或选择本地视频。");
      onNotice?.("原生解析不可用：请确认 APK 已更新并包含视频解析桥。");
      return;
    }
    setResolutionMessage("正在请求 APK 原生解析视频流……");
    const requestId = "watch-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
    let active = true;
    const onResolved = (event: Event) => {
      const detail = (event as CustomEvent<WatchNativeResolved>).detail;
      if (!detail || detail.requestId !== requestId) return;
      if (!active) {
        if (detail.cacheId) { try { native.deleteCachedShortVideo?.(detail.cacheId); } catch { /* native cache TTL is fallback */ } }
        return;
      }
      if (detail.ok && detail.cacheId && detail.contentUri) {
        nativeVideoCacheRef.current = { url: current.url, cacheId: detail.cacheId };
        setTarget(previous => previous && previous.url === current.url ? { ...previous, nativeVideo: true, nativeVideoUrl: detail.contentUri, nativeCacheId: detail.cacheId, supported: true } : previous);
        const message = "解析成功：已取得可在小手机内播放的视频流。";
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
  const [companionCollapsed, setCompanionCollapsed] = useState(false);
  const [showQuickChat, setShowQuickChat] = useState(false);
  const pendingDiscussionRef = useRef<Array<{ moment: string; timepoint?: string }>>([]);
  const [discussionDraft, setDiscussionDraft] = useState("");
  const [timepointDraft, setTimepointDraft] = useState("");
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const originalOrientationRef = useRef<string | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const commentListRef = useRef<HTMLDivElement>(null);
  const videoFramesRef = useRef<Array<{ targetUrl: string; seconds: number; timestamp: string; dataUrl: string }>>([]);
  /** 跨站 iframe 读不到 currentTime，用观看秒表估一个时间点，让弹幕能对上进度。 */
  const iframeSecondsRef = useRef(0);
  const frameCaptureFailedRef = useRef<string | null>(null);
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

  /**
   * 跨站 iframe（B 站等）网页层取不到播放器像素，但壳能**静默截整屏**。
   * 截完整屏后按播放器在屏幕上的位置裁一刀，只把视频画面交给角色：
   * 不弹预览、不弹按钮、不打断观看。
   */
  const captureSilentScreenFrame = useCallback(async (): Promise<string | null> => {
    if (!hasScreenshotBridge()) return null;
    const player = playerRef.current;
    if (!player) return null;
    try {
      const shot = await captureScreenshot(7000);
      if (!shot.ok || !shot.base64) return null;
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
      if (!context) { bitmap.close(); return null; }
      context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.62));
      if (!blob) return null;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("截图读取失败"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(blob);
      });
    } catch {
      // 静默失败：截图拿不到就不给画面，绝不用提示打断观看。
      return null;
    }
  }, []);

  const captureCurrentVideoFrame = useCallback(async (): Promise<void> => {
    if (!target) return;
    const video = playerRef.current?.querySelector("video");
    if (!video) {
      const targetUrl = target.url;
      if (target.embedUrl) {
        const silent = await captureSilentScreenFrame();
        if (silent) {
          const seconds = iframeSecondsRef.current;
          videoFramesRef.current = [
            ...videoFramesRef.current.filter(item => item.targetUrl === targetUrl && Math.abs(item.seconds - seconds) > 4),
            { targetUrl, seconds, timestamp: new Date().toISOString(), dataUrl: silent },
          ].slice(-8);
          frameCaptureFailedRef.current = null;
          return;
        }
      }
      frameCaptureFailedRef.current = target.embedUrl
        ? "该平台使用跨站 iframe，网页拿不到播放器内部画面。"
        : "该链接没有直接播放的 video 元素，因此网页无法截取当前画面。";
      return;
    }
    if (video.readyState < 2 || !Number.isFinite(video.currentTime)) return;
    const targetUrl = target.url;
    const seconds = Math.max(0, video.currentTime);
    try {
      const maxSide = 640;
      const scale = Math.min(1, maxSide / Math.max(video.videoWidth || 1, video.videoHeight || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round((video.videoWidth || 640) * scale));
      canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // toBlob encodes off the synchronous toDataURL path so the playback thread is less likely to stutter.
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.62));
      if (!blob) return;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("截图读取失败"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(blob);
      });
      if (!dataUrl) return;
      const frame = { targetUrl, seconds, timestamp: new Date().toISOString(), dataUrl };
      videoFramesRef.current = [...videoFramesRef.current.filter(item => item.targetUrl === targetUrl && Math.abs(item.seconds - seconds) > 1), frame].slice(-8);
      frameCaptureFailedRef.current = null;
    } catch {
      frameCaptureFailedRef.current = "这个视频源不允许网页读取画面（常见于跨站 iframe 或启用防截取的视频）。";
    }
  }, [target]);

  useEffect(() => {
    videoFramesRef.current = videoFramesRef.current.filter(frame => frame.targetUrl === target?.url);
    frameCaptureFailedRef.current = null;
    iframeSecondsRef.current = 0;
    // Capture silently from native in-page video only. Avoid pixel readback on clicks or React state updates.
    if (!target?.nativeVideo) return;
    const timer = window.setInterval(() => {
      const video = playerRef.current?.querySelector("video");
      if (!video || video.paused || video.ended || video.readyState < 2) return;
      captureCurrentVideoFrame();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [target?.url, target?.nativeVideo, captureCurrentVideoFrame]);

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
    if (!list) return;
    let first = 0;
    let second = 0;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const current = commentListRef.current;
        if (!current) return;
        current.scrollTop = current.scrollHeight;
        current.scrollTo({ top: current.scrollHeight, behavior: "smooth" });
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [comments.length, fullScreen, busy]);
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
    if (localVideoObjectUrlRef.current) URL.revokeObjectURL(localVideoObjectUrlRef.current);
    try { screen.orientation?.unlock?.(); } catch { /* orientation lock is optional */ }
  }, []);

  const patchSettings = (patch: Partial<WatchSettings>) => setSettings(current => ({ ...current, ...patch }));
  const openLocalVideo = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|m4v|mov|ogv|ogg)$/i.test(file.name)) {
      onNotice?.("请选择 MP4、WebM、MOV 或其他浏览器支持的视频文件。");
      return;
    }
    if (localVideoObjectUrlRef.current) URL.revokeObjectURL(localVideoObjectUrlRef.current);
    const objectUrl = URL.createObjectURL(file);
    localVideoObjectUrlRef.current = objectUrl;
    const localTarget: VideoTarget = { url: objectUrl, embedUrl: null, platform: "other", platformName: "本地视频", supported: true, nativeVideo: true };
    setTarget(localTarget);
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
    setTarget(parsed);
    setVideoTitle(current => current || `${parsed.platformName}的一段视频`);
    setComments(loadTargetComments(parsed.url));
    setDiscussionDraft(""); setTimepointDraft("");
    setWatching(false);
    if (!parsed.supported && (parsed.platform === "xiaohongshu" || parsed.platform === "douyin")) onNotice?.("正在尝试在小手机内解析" + parsed.platformName + "的公开视频流；如果平台要求登录或启用了防盗链，解析可能失败。");
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
    let queuedAfterReply: { moment: string; timepoint?: string } | undefined;
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `watch-together-${character.id}`, contactId: contact?.id ?? character.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-12).filter(item => item.status !== "failed" && !item.isRetracted);
      // Use cached samples only; never synchronously capture while a video is playing because some WebViews stall.
      const framesToSend = videoFramesRef.current
        .filter(frame => frame.targetUrl === target.url && Date.now() - new Date(frame.timestamp).getTime() <= 90000)
        .slice(-3);
      const activeBinding = resolveBinding(loadBindingConfig(), character.id, "watch_together");
      const visionConfig = loadApiConfigs().find(config => config.id === activeBinding.apiConfigId);
      const visionEnabled = visionConfig?.enableImageRecognition === true;
      const framesVisibleToModel = visionEnabled ? framesToSend : [];
      const frameMessages: ChatMessage[] = framesVisibleToModel.map((frame, index) => ({
        id: "watch-frame-" + Date.now() + "-" + index,
        sessionId: session.id,
        role: "user",
        content: "[视频画面截图，时间点 " + formatVideoTime(frame.seconds) + "。只评论这个时间点及之前已经出现的画面，绝不剧透后续内容。]",
        status: "sent",
        createdAt: frame.timestamp,
        mediaType: "image",
        mediaUrl: frame.dataUrl,
        mediaData: { label: "视频当前画面 " + formatVideoTime(frame.seconds) },
      }));
      const prompt = [
        "你正在和用户一起看视频，是亲密、自然的陪伴，不是影评机器人。",
        `视频平台：${target.platformName}；视频标题（用户可编辑）：${videoTitle || "暂未命名"}。`,
        `用户描述的当前片段/时间点与两人的互动：${(momentOverride ?? settings.currentMoment).trim() || "用户暂未提供具体画面描述"}。`,
        frameMessages.length
          ? "附带多张带时间戳的视频截图。先读截图标签中的时间点，再依照时间顺序理解片段。只能评论这些截图中已经出现的内容；禁止猜测、提示或泄露后续剧情/反转，也不能根据标题或常识补全未显示情节。看不清时坦白说看不清，不能编造画面。"
          : "本轮没有可供模型读取的视频截图。可能是跨站 iframe 无法截图，或图像识别没有开启。不得声称自己看见了画面；只能针对用户提供的文字内容自然回应。",
        "请结合角色自己的性格、兴趣和你们的关系，写一句自然的即时反应：可以吐槽、惊讶、共情、提问或分享感受。只输出角色会直接说的话，最多60个汉字。不搜寻或推断视频后续剧情。",
      ].join("\n");
      const userMessage: ChatMessage = { id: `watch-${Date.now()}`, sessionId: session.id, role: "user", content: prompt, status: "sent", createdAt: new Date().toISOString() };
      const visionSession = { ...session, visionImagePromptLimit: 3, visionImagePromptLimitUsesGlobal: false };
      const result = await generateChatCompletion(visionSession, [...history, ...frameMessages, userMessage], {
        appId: "watch_together",
        appTags: ["watch_together"],
        toolsAllowed: false,
        ephemeralSystemNote: "你正在共同观影。只有请求中实际附带的图像才算你看见的内容。不要调用工具，不要复述任务，不要假装看见不可读取的 iframe。只输出一句自然简短的角色发言，并严格避免剧透。",
      });
      const responseText = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
      if (!responseText) return;
      const lastFrame = framesVisibleToModel[framesVisibleToModel.length - 1];
      const responseTimepoint = timepointOverride || (lastFrame ? formatVideoTime(lastFrame.seconds) : undefined);
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
  }, [target, character, videoTitle, settings.currentMoment, settings.voiceEnabled, onNotice]);

  /** 把一帧画面交给角色：手动截图和静默截屏共用这一条路径。 */
  const submitFrameDataUrl = async (dataUrl: string, seconds: number, prefix = "用户附加截图") => {
    if (!target) return;
    const frame = { targetUrl: target.url, seconds, timestamp: new Date().toISOString(), dataUrl };
    videoFramesRef.current = [...videoFramesRef.current.filter(item => item.targetUrl === target.url), frame].slice(-8);
    const stamp = formatVideoTime(seconds);
    const moment = [settings.currentMoment.trim(), prefix + "时间点：" + stamp + "。请仅讨论该画面，不要推测后续。"].filter(Boolean).join("\n").slice(0, 800);
    if (commentBusyRef.current) pendingDiscussionRef.current.push({ moment, timepoint: stamp });
    else void generateComment(true, moment, stamp);
  };

  const submitScreenshotForCharacter = async (file?: File) => {
    if (!target || !file) return;
    if (!file.type.startsWith("image/")) { onNotice?.("请选择一张截图图片。"); return; }
    try {
      const dataUrl = await readCompressedImageDataUrl(file);
      const seconds = parseVideoTime(timepointDraft) ?? (() => {
        const video = playerRef.current?.querySelector("video");
        return video && Number.isFinite(video.currentTime) ? video.currentTime : iframeSecondsRef.current;
      })();
      await submitFrameDataUrl(dataUrl, seconds);
    } catch (error) {
      onNotice?.("截图读取失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (screenshotFileInputRef.current) screenshotFileInputRef.current.value = "";
    }
  };

  /**
   * 「让 TA 看一眼」：壳里就静默截整屏（连跨站 iframe 一起拍到），
   * 没有壳或没授权才退回选图。整个过程不弹预览、不打断播放。
   */
  const lookAtScreenNow = async () => {
    const silent = await captureSilentScreenFrame();
    if (!silent) { screenshotFileInputRef.current?.click(); return; }
    const video = playerRef.current?.querySelector("video");
    const seconds = video && Number.isFinite(video.currentTime) ? video.currentTime : iframeSecondsRef.current;
    await submitFrameDataUrl(silent, seconds, "用户让你看了一眼当前屏幕，");
  };

  const submitDiscussion = () => {
    const text=discussionDraft.trim(); if(!target||!text) return;
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

  /** 全屏进入横屏沉浸模式；退出时尽可能恢复进入前的屏幕方向和播放器布局。 */
  const enterFullscreen = async () => {
    if (!fullScreen) {
      originalOrientationRef.current = screen.orientation?.type ?? null;
      setFullScreen(true);
      await tryLockLandscape();
      return;
    }
    setFullScreen(false);
    await restoreOrientation();
  };

  const latestComment = comments[comments.length - 1];
  const platformNote = useMemo(() => {
    if (!target) return "";
    if (target.platformName === "本地视频") return "本地视频只在当前页面临时播放，不会上传。";
    if (target.nativeVideoUrl) return target.platformName + "已解析到小手机内播放；仍受公开视频权限、链接时效与平台防盗链影响。";
    if (target.supported) return `已接入${target.platformName}。能否播放取决于平台嵌入政策、登录状态与会员权限。`;
    return `${target.platformName}还没有取得可播放的视频流；查看解析提示或选择本地视频，不会假称已实现站内播放。`;
  }, [target]);

  return <div data-watch-fullscreen={fullScreen ? "true" : "false"} className={"watch-together-app pointer-events-auto isolate flex min-w-0 flex-col overflow-hidden text-[#f0e6d8] " + (fullScreen ? "fixed inset-0 z-[3000]" : "absolute inset-0 z-[1000]")} style={{ background: "linear-gradient(180deg,#e8d8c3 0%,#d8c1a5 48%,#bca084 100%)", height: fullScreen ? "100dvh" : undefined, width: fullScreen ? "100vw" : undefined }}>
    {/* 弹幕动画：仓库里从未定义过 watchDanmaku，之前那条 animation 是空转，这里补上真实 keyframes */}
    <style>{`\n      .watch-together-main { display:flex; flex-direction:column; }
      @keyframes watchWave { from { transform:scaleY(.45); opacity:.45 } to { transform:scaleY(1.15); opacity:1 } }\n      .watch-player { flex-shrink:0; border:5px solid #342a21!important; border-radius:22px!important; background:#090807; box-shadow:0 0 0 1px rgba(255,247,233,.45),0 8px 0 #8c6847,0 24px 42px rgba(68,44,24,.26)!important; }\n      .watch-link-panel { flex-shrink:0; }\n      .watch-interaction-panel { min-width:0; }
      /* Portrait mode: natural page scrolling; do not compress chat into a fixed-height tile. */
       @media (max-width: 699px), (orientation: portrait) {
         .watch-together-app:not([data-watch-fullscreen="true"]) > main.watch-together-main {
           display:flex; flex-direction:column; gap:12px; padding:10px 12px max(20px,env(safe-area-inset-bottom));
           flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:auto!important; overscroll-behavior:contain;
         }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-room-title { order:0; width:100%; max-width:none; margin:0!important; padding:0!important; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player { order:1; width:100%; max-width:none; height:auto; min-height:0; aspect-ratio:16 / 9; max-height:48dvh; align-self:stretch; border-width:3px!important; border-radius:14px!important; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player > video,
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-player > iframe { display:block; width:100%; height:100%; max-height:48dvh; aspect-ratio:16 / 9; object-fit:contain; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel { order:2; width:100%; max-width:none; min-height:0; height:auto; overflow:visible; margin:0!important; flex-shrink:0; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel > div { display:block; min-height:0; height:auto; overflow:visible; padding:12px!important; border-radius:18px!important; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel .watch-comment-list { min-height:110px; max-height:38vh; overflow-y:auto; overscroll-behavior:contain; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-interaction-panel section { flex:none; min-height:0; overflow:visible; display:block; margin-top:14px; padding-top:12px; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel { order:3; width:100%; max-width:none; margin:0!important; padding:10px!important; max-height:none; overflow:visible; flex-shrink:0; border-radius:16px!important; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel input { padding-top:10px!important; padding-bottom:10px!important; }
         .watch-together-app:not([data-watch-fullscreen="true"]) .watch-link-panel button { padding:9px 11px!important; }
       }
       .watch-together-app[data-watch-fullscreen="true"] > header { padding-top:max(3px,env(safe-area-inset-top))!important; padding-bottom:3px!important; }
      .watch-together-app[data-watch-fullscreen="true"] > main { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); grid-template-areas:"title interaction" "player interaction"; flex:1; min-height:0; overflow:hidden; gap:8px; padding:6px 8px max(8px,env(safe-area-inset-bottom)); }
      .watch-together-app[data-watch-fullscreen="true"] .watch-room-title { grid-area:title; width:100%; max-width:none; margin:0!important; padding:0!important; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player { grid-area:player; align-self:stretch; width:100%; max-width:none; height:100%; min-height:0; border-radius:12px!important; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-link-panel { display:none; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel { grid-area:interaction; min-height:0; height:100%; width:100%; max-width:none; margin:0!important; overflow-y:auto; overscroll-behavior:contain; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div { display:flex; flex-direction:column; height:100%; min-height:0; border-radius:16px!important; padding:10px!important; overflow:hidden; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div > .relative.z-10.mb-4 { display:none; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel section { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; margin-top:8px; padding-top:8px; overflow:hidden; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel .watch-comment-list { flex:1 1 auto; min-height:0; max-height:none; overflow-y:auto; overscroll-behavior:contain; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel .watch-discussion-composer { flex-shrink:0; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div > .relative.z-10.flex.items-start { flex-shrink:0; min-height:84px; max-height:84px; overflow:hidden; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div > .relative.z-10.flex.items-start p { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div { width:100%; max-width:none; box-sizing:border-box; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player { position:relative; box-sizing:border-box; aspect-ratio:auto; overflow:hidden; min-height:0; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > video,
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > iframe { position:absolute; inset:0; display:block; width:100%; height:100%; min-width:0; min-height:0; max-height:100%; aspect-ratio:auto; object-fit:contain; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > div { min-height:0; height:100%; }
      .watch-danmaku-track { position:absolute; left:100%; max-width:none; white-space:nowrap; animation-name:watchDanmaku; animation-timing-function:linear; animation-fill-mode:forwards; pointer-events:none; }
      .watch-danmaku-track > span { display:inline-block; border-radius:999px; background:rgba(0,0,0,.45); padding:4px 10px; color:rgba(255,255,255,.96); font-size:clamp(11px,1.2vw,15px); text-shadow:0 1px 3px rgba(0,0,0,.85); }
      @media (orientation: portrait) { .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div { padding:8px!important; } .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel section { margin-top:4px; padding-top:4px; } .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel .watch-comment-list { min-height:50px; } }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel section > div.mt-3.border-t { flex-shrink:0; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel > div > div.relative.z-10.mt-2 { display:none; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player video,.watch-together-app[data-watch-fullscreen="true"] .watch-player iframe { display:block; width:100%; height:100%; max-height:100%; aspect-ratio:auto; object-fit:contain; }
      @media (orientation: portrait) { .watch-together-app[data-watch-fullscreen="true"] > main { grid-template-columns:minmax(0,1fr); grid-template-rows:auto minmax(120px,30dvh) minmax(0,1fr); grid-template-areas:"title" "player" "interaction"; overflow:hidden; } }\n      @media (orientation: landscape) and (min-width: 700px) {\n        .watch-together-main { display:grid; grid-template-columns:minmax(0, 1.1fr) minmax(300px, .9fr); grid-template-rows:auto minmax(0, auto) minmax(0, 1fr); grid-template-areas:"title interaction" "player interaction" "link interaction"; gap:10px; overflow:hidden; padding-bottom:12px; }\n        .watch-player { grid-area:player; width:100%; max-width:none; align-self:start; }\n        .watch-link-panel { grid-area:link; min-width:0; overflow:auto; }\n        .watch-interaction-panel { grid-area:interaction; min-height:0; overflow-y:auto; overscroll-behavior:contain; margin-top:0!important; }\n      }\n
      .watch-together-app[data-watch-fullscreen="true"] > header {
        position:absolute!important; inset:0 0 auto 0!important; z-index:1100!important;
        display:flex; min-height:0!important; padding:calc(env(safe-area-inset-top,0px) + 5px) 10px 5px!important;
        background:linear-gradient(180deg,rgba(0,0,0,.62),transparent)!important; color:#fff!important; pointer-events:none;
      }
      .watch-together-app[data-watch-fullscreen="true"] > header button,
      .watch-together-app[data-watch-fullscreen="true"] > header a { pointer-events:auto; }
      .watch-together-app[data-watch-fullscreen="true"] > main {
        display:block!important; position:absolute!important; inset:0!important; flex:none!important; min-height:0!important;
        width:100%!important; overflow:hidden!important; padding:0!important; gap:0!important; background:none!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-room-title,
      .watch-together-app[data-watch-fullscreen="true"] .watch-link-panel,
      .watch-together-app[data-watch-fullscreen="true"] .watch-interaction-panel { display:none!important; }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player {
        position:absolute!important; inset:0!important; width:100%!important; height:100%!important; max-width:none!important;
        min-height:0!important; aspect-ratio:auto!important; margin:0!important; padding:0!important; overflow:hidden!important;
        border:0!important; border-radius:0!important; box-shadow:none!important; background:#000!important;
      }
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > video,
      .watch-together-app[data-watch-fullscreen="true"] .watch-player > iframe {
        position:absolute!important; inset:0!important; display:block!important; width:100%!important; height:100%!important;
        max-width:none!important; max-height:none!important; min-width:0!important; min-height:0!important;
        border:0!important; aspect-ratio:auto!important; object-fit:contain!important;
      }
      .watch-companion-overlay {
        max-height:calc(100dvh - 64px - env(safe-area-inset-bottom,0px)); overflow:visible;
      }
      .watch-companion-card, .watch-companion-pill {
        background:rgba(13,12,12,.72)!important; backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
      }
      .watch-danmaku-track[data-kind="user"] > span { background:rgba(54,101,144,.82); }
      @media (orientation:landscape) {
        .watch-together-app[data-watch-fullscreen="true"] .watch-companion-overlay {
          left:12px; right:auto; width:min(430px,44vw); top:max(48px,calc(env(safe-area-inset-top) + 12px));
        }
        .watch-together-app[data-watch-fullscreen="true"] .watch-companion-card { max-width:100%; }
      }
      @media (prefers-reduced-motion:reduce) {
        .watch-together-app[data-watch-fullscreen="true"] .watch-danmaku-track { animation:none!important; left:10px!important; transform:none!important; }
      }
    `}</style>
    <style>{`@keyframes watchDanmaku { 0% { transform: translateX(0); opacity: 0 } 6% { opacity: 1 } 92% { opacity: 1 } 100% { transform: translateX(calc(-100% - 100vw)); opacity: 0 } }`}</style>

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
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowSettings(value => !value); }} className="relative z-[1011] grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#b89979]/45 bg-[#fffaf2]/80 text-[#6d4e47] shadow-sm transition hover:bg-white active:scale-95" aria-label="观影设置" aria-expanded={showSettings}><Settings2 size={17}/></button>
    </header>

    <main className="watch-together-main relative z-[1001] min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8" style={{backgroundImage:"radial-gradient(ellipse at 50% 0%,rgba(255,251,242,.72),transparent 62%)"}}>
      <div className="watch-room-title mx-auto mb-3 w-full max-w-3xl px-1 pt-1"><div className="flex items-center justify-between gap-3 rounded-2xl border border-[#b99b80]/25 bg-[#fffaf2]/65 px-4 py-3 text-[#6d5141] shadow-[0_8px_22px_rgba(96,67,43,.06)] backdrop-blur"><div className="min-w-0"><p className="truncate font-serif text-sm">{target ? `一起看《${videoTitle || target.platformName + "的一段视频"}》` : "把想看的内容放上屏幕"}</p><p className="mt-0.5 text-[10px] tracking-wide text-[#8b7665]">{target ? (target.nativeVideoUrl ? target.platformName + " · 小手机内播放" : target.supported ? target.platformName + " · 链接播放" : target.platformName + " · 尝试站内解析") : "等待开始 · 选择视频或粘贴链接"}</p></div><span className="shrink-0 text-[10px] tracking-[.14em] text-[#a18172]">TOGETHER</span></div></div>
      <section
        ref={playerRef}
        className="watch-player relative mx-auto w-full max-w-3xl min-h-0 overflow-hidden rounded-[26px] border border-white/10 bg-[#0d0b09]"
        style={{ boxShadow: "0 0 0 1px rgba(255,214,170,.06), 0 28px 70px rgba(0,0,0,.6), 0 0 120px rgba(201,143,82,.16)" }}
      >
        {target?.nativeVideo ? (
          <video key={target.nativeVideoUrl || target.url} src={target.nativeVideoUrl || target.url} controls playsInline className={fullScreen ? "h-full w-full object-contain bg-black" : "aspect-video w-full bg-black"} onEnded={() => { const cached = nativeVideoCacheRef.current; if (cached && cached.url === target.url) { try { (window as WatchNativeWindow).AndroidShell?.deleteCachedShortVideo?.(cached.cacheId); } catch { /* cache TTL fallback */ } nativeVideoCacheRef.current = null; } }} onError={() => { const cached = nativeVideoCacheRef.current; if (cached && cached.url === target.url) { try { (window as WatchNativeWindow).AndroidShell?.deleteCachedShortVideo?.(cached.cacheId); } catch { /* cache TTL fallback */ } nativeVideoCacheRef.current = null; } onNotice?.("视频无法在当前 WebView 播放，可能是格式、签名有效期或平台防盗链限制。"); }} />
        ) : target?.embedUrl ? (
          <iframe key={target.embedUrl} src={target.embedUrl} title={videoTitle || target.platformName} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" className={fullScreen ? "h-full w-full border-0" : "aspect-video w-full border-0"} />
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center px-6 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-full border border-white/15 bg-white/5 text-[#d9b489]">
              {target ? <ExternalLink size={24}/> : <Play size={24}/>}
            </div>
            <div className="mt-5 font-serif text-lg tracking-wide text-[#efe2d0]">{target ? `${target.platformName}需要外部打开` : "把想看的放上屏幕"}</div>
            <p className="mt-2 max-w-xs text-[11px] leading-6 text-[#9c9086]">
              {target ? "目前无法在小手机内读取这个链接的真实画面；若原生解析失败，请选择本地视频，角色就能根据当前帧回应。" : "粘贴一个视频链接，或选择本地视频，让你们在同一个页面里边看边聊。"}
            </p>
            {target && <button onClick={() => window.open(target.url, "_blank", "noopener,noreferrer")} className="mt-5 flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs text-[#e6d8c4] transition active:scale-95"><ExternalLink size={13}/>打开原视频</button>}
          </div>
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
              <button type="button" onClick={() => { setWatching(value => !value); if (!watching) void generateComment(false); }} disabled={!character} className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1.5 text-[10px] disabled:opacity-40">{watching ? "暂停陪看" : "开始陪看"}</button>
            </div>
            {showQuickChat && <form onSubmit={event => { event.preventDefault(); submitDiscussion(); }} className="mt-2 flex items-center gap-2 border-t border-white/15 pt-2">
              <input autoComplete="off" value={discussionDraft} onChange={event => setDiscussionDraft(event.target.value.slice(0,800))} placeholder="发一条只属于你们的弹幕…" className="min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-3 py-2 text-xs text-white outline-none placeholder:text-white/45"/>
              <button type="submit" disabled={!discussionDraft.trim()} className="shrink-0 rounded-full bg-[#e6c49d] px-3 py-2 text-xs text-[#302218] disabled:opacity-40">发送</button>
            </form>}
          </div>}
        </div>}
        {(target?.embedUrl || target?.nativeVideo) && settings.danmakuEnabled && comments.some(comment => comment.targetUrl === target.url) && <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
          {comments.filter(comment => comment.targetUrl === target.url).slice(-8).map((comment, index) => {
            const lane = 10 + ((index * 13 + comment.id.length * 7) % 7) * 10;
            const duration = Math.max(8, Math.min(18, 8 + comment.text.length * 0.17));
            return <div key={comment.id} data-kind={comment.kind === "user" ? "user" : "character"} className="watch-danmaku-track" style={{ top: lane + "%", animationDuration: duration + "s", animationDelay: (index * 0.28) + "s" }}><span>{comment.kind === "user" ? "我" : comment.characterName}：{comment.text}</span></div>;
          })}
        </div>}
        <div className="absolute right-2 top-2 flex gap-1">
          <button onClick={() => void enterFullscreen()} className="grid h-8 w-8 place-items-center rounded-lg bg-black/45 text-white/90 backdrop-blur transition active:scale-95" aria-label="全屏"><Expand size={15}/></button>
        </div>
        {/* 屏幕洒在桌面上的余光 */}
        {!fullScreen && <div aria-hidden className="pointer-events-none absolute -bottom-6 left-1/2 h-6 w-[86%] -translate-x-1/2 rounded-[50%] opacity-40 blur-xl" style={{ background: "radial-gradient(ellipse, #d7a06a 0%, transparent 70%)" }} />}
      </section>

      {/* 没有视频时：链接输入放在「屏幕」下方，像往播放器里投一块碟 */}
      <div className="watch-link-panel mx-auto mt-4 w-full max-w-3xl rounded-3xl border border-[#b89979]/30 bg-[#fff8ed]/75 p-3 shadow-[0_12px_30px_rgba(96,67,43,.08)] backdrop-blur sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={urlInput} onChange={event => setUrlInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") openVideo(); }} placeholder="粘贴视频链接；短视频分享链接不保证能自动内嵌" className="min-w-0 flex-1 rounded-2xl border border-[#dac6ad] bg-white/90 px-4 py-3.5 text-sm text-[#554437] outline-none placeholder:text-[#a09383] focus:border-[#b88768] focus:ring-2 focus:ring-[#c99a6a]/15" />
          <button onClick={openVideo} className="rounded-2xl px-5 py-3.5 text-sm font-semibold tracking-wide text-[#2a1f16] shadow-sm transition hover:brightness-[1.02] active:scale-[.98]" style={{ background: "linear-gradient(135deg,#f0d0a8,#c99a6a)" }}>放上屏幕</button>
          <button type="button" onClick={() => videoFileInputRef.current?.click()} className="rounded-2xl border border-[#b89979]/50 bg-white/90 px-4 py-3.5 text-sm font-medium text-[#735440] transition hover:bg-white active:scale-[.98]">选择本地视频</button>
        </div>
        <input ref={videoFileInputRef} type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.ogv" className="hidden" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; openLocalVideo(file); }} />
        <input ref={screenshotFileInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.target.files?.[0]; void submitScreenshotForCharacter(file); }} />
        {target && target.platformName !== "本地视频" && !target.embedUrl && !target.nativeVideoUrl && <p role="status" aria-live="polite" className="mt-2 rounded-xl bg-[#f4e7d6] px-3 py-2 text-xs leading-5 text-[#82644c]">{resolutionMessage || "等待检查视频链接……"}</p>}
        {resolutionMessage && (target?.embedUrl || target?.nativeVideoUrl) && <p role="status" aria-live="polite" className="mt-2 rounded-xl border border-[#cdb79b]/60 bg-[#fffaf2] px-3 py-2 text-xs leading-5 text-[#82644c]">{resolutionMessage}</p>}
        {target?.platformName === "本地视频" && <p className="mt-2 px-1 text-[11px] leading-5 text-[#8b7665]">当前播放的是本地文件；选择新文件或输入链接可以切换视频。</p>}
        {platformNote && <p className="mt-2 px-1 text-[11px] leading-5 text-[#8b7665]">{platformNote}</p>}
      </div>

      {/* 角色在屏幕下方轻声说话 */}
      <section className="watch-interaction-panel mx-auto mt-4 w-full max-w-3xl">
        <div className="relative isolate overflow-hidden rounded-[28px] border border-[#d4a575]/25 bg-gradient-to-br from-[#49372b]/95 via-[#2d231d]/95 to-[#1c1714]/98 p-4 shadow-[0_18px_46px_rgba(57,37,24,.24),inset_0_1px_0_rgba(255,224,184,.12)] backdrop-blur-xl sm:p-5">
          {/* 双人电波连线：用头像和波形表达同步陪伴，不再绘制伪沙发。 */}
          <div className="relative z-10 mb-4 flex items-center gap-3 rounded-2xl border border-[#d6b18c]/15 bg-white/[.035] px-3 py-3">
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
            <button onClick={() => void lookAtScreenNow()} disabled={!target || busy} className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs text-[#d8c9b6] transition active:scale-95 disabled:opacity-40"><ImagePlus size={13}/>让 TA 看一眼</button>
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

          <section className="relative z-10 mt-5 min-h-0 border-t border-[#d6b18c]/20 pt-4">
            <div className="flex items-baseline justify-between gap-2"><h2 className="font-serif text-base tracking-wide text-[#f0dfcc]">一起讨论</h2><span className="text-[10px] tracking-[.12em] text-[#a9937e]">SCENE NOTES · {comments.length}</span></div>
            <p className="mt-1 text-[10px] leading-5 text-[#a9937e]">把某一幕或想说的话记在对应时间点；你的消息和 TA 的回应都会出现在画面弹幕与下方讨论记录里。</p>
            {comments.some(item=>item.timepoint) && <div className="mt-3 flex flex-wrap gap-2">{[...new Set(comments.filter(item=>item.timepoint).map(item=>item.timepoint!))].map(point=><button key={point} type="button" onClick={()=>{setTimepointDraft(point);setDiscussionDraft(`想再聊聊 ${point} 这一幕`);}} className="border-b border-[#c99a78]/60 px-1 py-1 text-[11px] text-[#e4c6a8]">{point} ↗</button>)}</div>}
            <div ref={commentListRef} className="watch-comment-list mt-3 min-h-0 max-h-64 space-y-3 overflow-y-auto overscroll-contain pr-1">{comments.length ? comments.slice(-30).map(item=><div key={item.id} className={`flex ${item.kind==="user"?"justify-end":"justify-start"}`}><div className={`max-w-[88%] rounded-2xl border px-3 py-2.5 shadow-sm ${item.kind==="user"?"border-[#d6b18c]/35 bg-[#d6b18c]/10":"border-white/10 bg-white/[.045]"}`}><div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-[#c4a58a]"><span>{item.kind==="user"?"我":item.characterName}</span>{item.timepoint&&<button type="button" onClick={()=>setTimepointDraft(item.timepoint||"")} className="border-b border-[#c99a78]/50 text-[#e4c6a8]">{item.timepoint}</button>}<span className="text-[#85756a]">{new Date(item.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</span></div><p className="whitespace-pre-wrap break-words font-serif text-sm leading-6 text-[#efe2d0]">{item.text}</p></div></div>) : <p className="border-l border-[#c99a78]/45 py-1 pl-3 text-xs leading-6 text-[#a9937e]">这里留给你们讨论剧情、吐槽片段，或标记想一起记住的时刻。</p>}</div>
            <div className="watch-discussion-composer mt-3 border-t border-[#d6b18c]/20 pt-3"><div className="flex items-center gap-2"><input value={timepointDraft} onChange={event=>setTimepointDraft(event.target.value.slice(0,16))} disabled={!target} placeholder="时间点 03:12（可选）" className="w-[42%] min-w-0 border-b border-[#9c7b63]/60 bg-transparent px-1 py-2 text-xs text-[#f0dfcc] outline-none placeholder:text-[#907d6c] focus:border-[#e4c6a8]"/><span className="text-[10px] text-[#907d6c]">章节 / 剧情标记</span></div><textarea value={discussionDraft} onChange={event=>setDiscussionDraft(event.target.value.slice(0,800))} disabled={!target} maxLength={800} rows={2} placeholder={target ? "写下你对这一幕的看法……" : "先放上视频，再写下你对这一幕的看法……"} className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-black/20 p-3 text-sm leading-6 text-[#efe2d0] outline-none placeholder:text-[#907d6c] focus:border-[#c99a78]/60 focus:ring-2 focus:ring-[#c99a78]/10"/><div className="mt-2 flex justify-end"><button type="button" onClick={submitDiscussion} disabled={!target||!discussionDraft.trim()} className="inline-flex items-center rounded-full border border-[#c99a78]/60 bg-[#c99a78] px-4 py-2.5 text-xs font-medium text-[#2a1f16] shadow-sm transition hover:brightness-105 active:scale-[.98] disabled:opacity-40"><MessageCircle size={13} className="mr-1 inline"/>记下并问问 TA</button></div></div>
          </section>
          <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
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
