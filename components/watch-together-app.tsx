"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Captions, ExternalLink, Expand, Heart, LoaderCircle, MessageCircle, Pause, Play, Send, Settings2, Volume2, VolumeX, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { kvGet, kvSet } from "@/lib/kv-db";
import { resolveVoiceConfig, synthesizeSpeech } from "@/lib/tts-service";

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Platform = "bilibili" | "youtube" | "tencent" | "youku" | "iqiyi" | "douyin" | "xiaohongshu" | "other";
type VideoTarget = { url: string; embedUrl: string | null; platform: Platform; platformName: string; supported: boolean };
type WatchComment = { id: string; characterId: string; characterName: string; text: string; createdAt: string };
type WatchSettings = { characterId: string; intervalMinutes: number; voiceEnabled: boolean; danmakuEnabled: boolean; subtitlesEnabled: boolean; currentMoment: string };

const SETTINGS_KEY = "ai_phone_watch_together_v1";
const DEFAULT_SETTINGS: WatchSettings = { characterId: "", intervalMinutes: 5, voiceEnabled: true, danmakuEnabled: true, subtitlesEnabled: true, currentMoment: "" };

function parseVideoUrl(value: string): VideoTarget | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    const original = url.toString();
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
    const parsed = JSON.parse(raw) as Partial<WatchSettings>;
    return {
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      intervalMinutes: typeof parsed.intervalMinutes === "number" ? Math.max(1, Math.min(60, parsed.intervalMinutes)) : 5,
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

export function WatchTogetherApp({ onClose, onNotice }: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<WatchSettings>(() => loadSettings());
  const [urlInput, setUrlInput] = useState("");
  const [target, setTarget] = useState<VideoTarget | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [comments, setComments] = useState<WatchComment[]>([]);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const commentBusyRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);
  const character = characters.find(item => item.id === settings.characterId) ?? characters[0] ?? null;

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
    const onFullscreen = () => setFullScreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);
  useEffect(() => () => { if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); }, []);

  const patchSettings = (patch: Partial<WatchSettings>) => setSettings(current => ({ ...current, ...patch }));
  const openVideo = () => {
    const parsed = parseVideoUrl(urlInput);
    if (!parsed) { onNotice?.("请粘贴完整的视频分享链接（http/https）。"); return; }
    setTarget(parsed);
    setVideoTitle(current => current || `${parsed.platformName}的一段视频`);
    setComments([]);
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

  const generateComment = useCallback(async (manual = false) => {
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
        `用户描述的当前片段/时间点：${settings.currentMoment.trim() || "用户暂未提供具体画面描述"}。`,
        "请结合角色自己的性格、兴趣和你们的关系，写一句自然的即时反应：可以吐槽、惊讶、共情、提问或分享感受。不要声称你真的看到了链接里无法读取的画面；不要编造剧情细节。只输出角色会直接说的话，最多60个汉字。",
      ].join("\n");
      const userMessage: ChatMessage = { id: `watch-${Date.now()}`, sessionId: session.id, role: "user", content: prompt, status: "sent", createdAt: new Date().toISOString() };
      const result = await generateChatCompletion(session, [...history, userMessage], {
        appId: "watch_together", appTags: ["watch_together"], toolsAllowed: false,
        ephemeralSystemNote: "你正在共同观影。不要调用工具、不要复述任务、不要声称直接读取了视频画面。只输出一句自然简短的角色发言。",
      });
      const text = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
      if (!text) return;
      const comment: WatchComment = { id: `comment-${Date.now()}`, characterId: character.id, characterName: character.name, text, createdAt: new Date().toISOString() };
      setComments(current => [...current.slice(-29), comment]);
      if (settings.voiceEnabled) void speakComment(text, character.id);
      if (manual) onNotice?.(`${character.name}说了一句。`);
    } catch (error) { onNotice?.("角色观影回应失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { commentBusyRef.current = false; setBusy(false); }
  }, [target, character, videoTitle, settings.currentMoment, settings.voiceEnabled, onNotice]);

  useEffect(() => {
    if (!watching || !target) return;
    const timer = window.setInterval(() => { void generateComment(false); }, Math.max(1, Math.min(60, settings.intervalMinutes)) * 60_000);
    return () => window.clearInterval(timer);
  }, [watching, target, settings.intervalMinutes, generateComment]);

  const enterFullscreen = async () => {
    try {
      if (!playerRef.current) return;
      if (!document.fullscreenElement) await playerRef.current.requestFullscreen();
      else await document.exitFullscreen();
    } catch { onNotice?.("当前设备或浏览器不支持此播放器的全屏模式，请尝试播放器内的全屏按钮。"); }
  };

  const latestComment = comments[comments.length - 1];
  const platformNote = useMemo(() => {
    if (!target) return "粘贴视频分享链接，尽可能在同一页面播放。";
    if (target.supported) return `已识别为${target.platformName}。能否播放仍取决于平台的嵌入政策、登录状态、会员权限与 DRM。`;
    return `${target.platformName}暂时没有稳定的通用嵌入播放器。可尝试打开原始链接；角色陪看仍可基于你填写的当前片段描述进行回应。`;
  }, [target]);

  return <div className="watch-together-app pointer-events-auto isolate absolute inset-0 z-[1000] flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,#fffdf8_0%,#f5f0e8_52%,#e6ebe2_100%)] text-[#343b36]">
    <header className="relative z-[1001] flex shrink-0 items-center gap-3 border-b border-[#d9d8d0]/80 bg-white/82 px-4 py-3 shadow-[0_8px_28px_rgba(52,59,54,.08)] backdrop-blur-xl">
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#dedbd1] bg-white/80 shadow-sm transition hover:-translate-y-0.5 active:scale-95" aria-label="返回"><ArrowLeft size={17}/></button>
      <div className="min-w-0 flex-1"><div className="font-serif text-xl tracking-[.08em]">一起看</div><div className="text-[10px] tracking-[.18em] text-[#8d968a]">WATCH, PAUSE, TALK A LITTLE</div></div>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowSettings(value => !value); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#dedbd1] bg-white/80 shadow-sm transition hover:-translate-y-0.5 active:scale-95" aria-label="观影设置"><Settings2 size={17}/></button>
    </header>
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
      <section className="mx-auto max-w-4xl px-4 pb-8 pt-5 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={urlInput} onChange={event => setUrlInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") openVideo(); }} placeholder="粘贴抖音 / 小红书 / B站 / 腾讯 / 爱奇艺 / 优酷链接" className="min-w-0 flex-1 rounded-2xl border border-[#dcd8cd] bg-white/85 px-4 py-3.5 text-sm shadow-sm outline-none placeholder:text-[#a9aa9f] focus:border-[#87947e]"/>
          <button onClick={openVideo} className="rounded-2xl bg-gradient-to-r from-[#7e8b78] to-[#65765f] px-5 py-3.5 text-sm font-medium tracking-wide text-white shadow-[0_8px_20px_rgba(92,109,81,.2)] transition hover:brightness-105 active:scale-[.98]">载入视频</button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[#8c9185]">{platformNote}</p>

        {showSettings && <section className="mt-4 rounded-[24px] border border-white/80 bg-white/70 p-4 shadow-[0_10px_28px_rgba(52,59,54,.06)] backdrop-blur sm:p-5">
          <h2 className="font-serif text-lg">陪看方式</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-[#72796f]">陪你看的人<select value={character?.id ?? ""} onChange={event => patchSettings({ characterId: event.target.value })} className="mt-2 w-full rounded-lg border border-[#dedbd1] bg-white px-3 py-2.5 text-sm">{characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}</select></label>
            <label className="text-xs text-[#72796f]">主动说话间隔<select value={settings.intervalMinutes} onChange={event => patchSettings({ intervalMinutes: Number(event.target.value) })} className="mt-2 w-full rounded-lg border border-[#dedbd1] bg-white px-3 py-2.5 text-sm">{[1,2,3,5,8,10,15,20,30,45,60].map(value => <option key={value} value={value}>{value} 分钟</option>)}</select></label>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <label className="flex items-center gap-2 rounded-xl bg-[#efeee7] p-3 text-xs"><input type="checkbox" checked={settings.voiceEnabled} onChange={event => patchSettings({ voiceEnabled: event.target.checked })} className="accent-[#7e8b78]"/>角色语音（需绑定语音）</label>
            <label className="flex items-center gap-2 rounded-xl bg-[#efeee7] p-3 text-xs"><input type="checkbox" checked={settings.danmakuEnabled} onChange={event => patchSettings({ danmakuEnabled: event.target.checked })} className="accent-[#7e8b78]"/>角色弹幕</label>
            <label className="flex items-center gap-2 rounded-xl bg-[#efeee7] p-3 text-xs"><input type="checkbox" checked={settings.subtitlesEnabled} onChange={event => patchSettings({ subtitlesEnabled: event.target.checked })} className="accent-[#7e8b78]"/>角色字幕</label>
          </div>
          <p className="mt-3 text-[10px] leading-5 text-[#92958a]">角色发言使用你已配置的聊天模型与语音绑定；平台自带字幕/弹幕的开关通常不能跨站控制，下面的开关控制的是角色陪看层。</p>
        </section>}

        <section ref={playerRef} className={`relative mt-5 overflow-hidden rounded-[24px] border border-white/60 bg-[#222723] shadow-[0_16px_40px_rgba(43,49,41,.18)] ${fullScreen ? "h-screen rounded-none" : ""}`}>
          {target?.embedUrl ? <iframe key={target.embedUrl} src={target.embedUrl} title={videoTitle || target.platformName} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" className="aspect-video w-full border-0"/> : <div className="flex aspect-video flex-col items-center justify-center px-6 text-center text-[#c8cec3]"><div className="grid h-14 w-14 place-items-center rounded-full border border-white/20"><Play size={23}/></div><div className="mt-4 font-serif text-lg">{target ? `${target.platformName}需要外部打开` : "把喜欢的视频带进来"}</div><p className="mt-2 max-w-sm text-xs leading-6 text-[#a8b0a4]">{target ? "该平台没有稳定的通用嵌入方式。点击下方按钮打开原视频，返回后仍可和角色一起聊。" : "视频播放器会在这里出现。不同平台对内嵌播放的支持不同。"} </p>{target && <button onClick={() => window.open(target.url, "_blank", "noopener,noreferrer")} className="mt-4 flex items-center gap-2 rounded-full border border-white/25 px-4 py-2 text-xs"><ExternalLink size={13}/>打开原视频</button>}</div>}
          {target?.embedUrl && settings.danmakuEnabled && comments.length > 0 && <div className="pointer-events-none absolute inset-0 overflow-hidden">{comments.slice(-6).map((comment,index) => <div key={comment.id} className="absolute right-2 max-w-[90%] animate-[watchDanmaku_12s_linear_forwards] whitespace-nowrap rounded-full bg-black/35 px-3 py-1 text-sm text-white drop-shadow" style={{ top: `${12 + index * 12}%`, animationDelay: `${index * .45}s` }}>{comment.characterName}：{comment.text}</div>)}</div>}
          {target && settings.subtitlesEnabled && latestComment && <div className="pointer-events-none absolute bottom-4 left-3 right-3 text-center"><span className="rounded-md bg-black/70 px-3 py-2 text-sm leading-6 text-white [box-decoration-break:clone]">{latestComment.text}</span></div>}
          <div className="absolute right-2 top-2 flex gap-1"><button onClick={() => void enterFullscreen()} className="grid h-8 w-8 place-items-center rounded-lg bg-black/45 text-white" aria-label="全屏"><Expand size={15}/></button></div>
        </section>

        <div className="mt-4 rounded-2xl border border-[#dedbd1] bg-[#f9f7f1] p-4">
          <div className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1"><input value={videoTitle} onChange={event => setVideoTitle(event.target.value)} placeholder="给这段视频起个名字（可选）" className="w-full bg-transparent font-serif text-lg outline-none placeholder:text-[#b4b3a8]"/></div><button onClick={() => void generateComment(true)} disabled={!target || !character || busy} className="flex items-center gap-2 rounded-full bg-[#7e8b78] px-4 py-2.5 text-xs text-white disabled:opacity-40">{busy ? <LoaderCircle size={14} className="animate-spin"/> : <MessageCircle size={14}/>}请TA说一句</button></div>
          <label className="mt-3 block text-[10px] tracking-[.15em] text-[#9b9d91]">此刻看到的片段 / 时间点（可选）</label>
          <textarea value={settings.currentMoment} onChange={event => patchSettings({ currentMoment: event.target.value })} rows={2} placeholder="例如：00:43，他终于回头看了她一眼……你也可以写下自己的感受。" className="mt-2 w-full resize-y rounded-xl border border-[#e2dfd5] bg-white/70 p-3 text-xs leading-5 outline-none focus:border-[#87947e]"/>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[#e4e1d7] pt-3"><div className="text-xs text-[#777e73]">{character ? `和 ${character.name} 一起看` : "请先导入角色卡"}</div><div className="flex gap-2"><button onClick={() => { setWatching(value => !value); if (!watching) void generateComment(false); }} disabled={!target || !character} className="flex items-center gap-2 rounded-full border border-[#c7c9bd] px-4 py-2 text-xs text-[#66715f] disabled:opacity-40">{watching ? <Pause size={13}/> : <Play size={13}/>} {watching ? "暂停陪看" : "开始陪看"}</button><button onClick={() => setComments([])} className="grid h-9 w-9 place-items-center rounded-full border border-[#dedbd1] text-[#96998e]" aria-label="清空角色弹幕"><X size={14}/></button></div></div>
        </div>

        {comments.length > 0 && <section className="mt-5"><div className="mb-3 flex items-center gap-2 text-[10px] tracking-[.2em] text-[#9b9d91]"><Heart size={12}/> JUST SAID</div><div className="space-y-2">{comments.slice().reverse().map(comment => <div key={comment.id} className="rounded-2xl border border-white/90 bg-white/75 px-4 py-3 shadow-sm transition hover:bg-white"><div className="flex items-center justify-between gap-3"><span className="text-xs text-[#7e8b78]">{comment.characterName}</span><span className="text-[10px] text-[#b1b1a6]">{new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span></div><p className="mt-1 font-serif text-sm leading-6 text-[#4e564d]">{comment.text}</p></div>)}</div></section>}
      </section>
    </main>
    <audio ref={audioRef} className="hidden" />
  </div>;
}
