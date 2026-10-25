"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Pause, Play, Send, ShieldCheck, Square, Camera, MessageCircle, Settings2 } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { kvGet, kvSet } from "@/lib/kv-db";
import { loadVideoAnalysisSettings } from "@/lib/video-analysis-settings";
import { analyzeCapturedImage } from "@/lib/video-keyframe-analysis";
import { loadGlobalWatchRecords, persistGlobalWatchMemory, saveGlobalWatchRecord, type GlobalWatchRecord } from "@/lib/global-watch-storage";

type GlobalWatchSettings = {
  characterId: string;
  randomSpeechEnabled: boolean;
  captureIntervalMinSeconds: number;
  captureIntervalMaxSeconds: number;
  speechIntervalMinMinutes: number;
  speechIntervalMaxMinutes: number;
};
type GlobalWatchNative = {
  startGlobalWatch?: (configJson: string) => boolean;
  stopGlobalWatch?: () => void;
  pauseGlobalWatch?: (paused: boolean) => void;
  captureGlobalWatchNow?: () => void;
  sendGlobalWatchReply?: (text: string) => void;
  showGlobalWatchComment?: (text: string) => void;
  isGlobalWatchRunning?: () => boolean;
  getGlobalWatchDiagnostics?: () => string;
  getGlobalWatchRecords?: () => string;
};
type GlobalWatchWindow = Window & { AndroidShell?: GlobalWatchNative };
type Props = { onClose: () => void; onNotice?: (message: string) => void };

const SETTINGS_KEY = "global_watch_companion_settings_v1";
const DEFAULT_SETTINGS: GlobalWatchSettings = {
  characterId: "",
  randomSpeechEnabled: true,
  captureIntervalMinSeconds: 35,
  captureIntervalMaxSeconds: 95,
  speechIntervalMinMinutes: 2,
  speechIntervalMaxMinutes: 5,
};
function loadSettings(): GlobalWatchSettings {
  try {
    const raw = kvGet(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GlobalWatchSettings>;
    const captureMin = Math.max(15, Math.min(600, Number(parsed.captureIntervalMinSeconds) || 35));
    const speechMin = Math.max(1, Math.min(60, Number(parsed.speechIntervalMinMinutes) || 2));
    return {
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      randomSpeechEnabled: parsed.randomSpeechEnabled !== false,
      captureIntervalMinSeconds: captureMin,
      captureIntervalMaxSeconds: Math.max(captureMin, Math.min(900, Number(parsed.captureIntervalMaxSeconds) || 95)),
      speechIntervalMinMinutes: speechMin,
      speechIntervalMaxMinutes: Math.max(speechMin, Math.min(120, Number(parsed.speechIntervalMaxMinutes) || 5)),
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(value: GlobalWatchSettings) { kvSet(SETTINGS_KEY, JSON.stringify(value)); }

export function GlobalWatchCompanionApp({ onClose, onNotice }: Props) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<GlobalWatchSettings>(() => loadSettings());
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState("尚未启动。启动后，Android 会再次询问是否允许捕获屏幕。");
  const [consentChecked, setConsentChecked] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [records, setRecords] = useState<GlobalWatchRecord[]>(() => loadGlobalWatchRecords());
  const [busy, setBusy] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsText, setDiagnosticsText] = useState("尚未运行诊断。");
  const [latestCapturedAt, setLatestCapturedAt] = useState(0);
  const frameRef = useRef("");
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const lastSpeechAtRef = useRef(Date.now());
  const native = typeof window !== "undefined" ? (window as GlobalWatchWindow).AndroidShell : undefined;
  const character = characters.find(item => item.id === settings.characterId) ?? characters[0] ?? null;

  useEffect(() => {
    // Merge native service records after reopening the app; the Android service remains the source of truth in background.
    try {
      const raw = (window as GlobalWatchWindow).AndroidShell?.getGlobalWatchRecords?.();
      if (raw) {
        const items = JSON.parse(raw) as Array<{ id?: string; kind?: string; text?: string; createdAt?: number; characterId?: string; characterName?: string }>;
        const existing = new Set(loadGlobalWatchRecords().map(item => item.id));
        for (const item of items) {
          if (!item?.id || !item.text || existing.has(item.id)) continue;
          const record: GlobalWatchRecord = {
            id: item.id,
            characterId: item.characterId || "",
            characterName: item.characterName || "陪看角色",
            text: (item.kind === "error" ? "【分析失败】" : item.kind === "system" ? "【会话记录】" : "") + item.text,
            createdAt: new Date(typeof item.createdAt === "number" ? item.createdAt : Date.now()).toISOString(),
            kind: item.kind === "user" ? "user" : "character",
            targetUrl: "global-watch",
          };
          saveGlobalWatchRecord(record);
          existing.add(item.id);
        }
        setRecords(loadGlobalWatchRecords());
      }
    } catch { /* browser-only mode or native bridge unavailable */ }
    const list = loadCharacters();
    setCharacters(list);
    setSettings(current => {
      const next = { ...current, characterId: list.some(item => item.id === current.characterId) ? current.characterId : list[0]?.id ?? "" };
      saveSettings(next);
      return next;
    });
    try {
      if ((window as GlobalWatchWindow).AndroidShell?.isGlobalWatchRunning?.()) {
        setRunning(true);
        setStatus("检测到全局陪看服务仍在运行。");
      }
    } catch { /* browser-only mode */ }
  }, []);

  useEffect(() => { saveSettings(settings); }, [settings]);
  const patchSettings = <K extends keyof GlobalWatchSettings>(key: K, value: GlobalWatchSettings[K]) => {
    setSettings(current => {
      const next = { ...current, [key]: value };
      if (key === "captureIntervalMinSeconds" && next.captureIntervalMaxSeconds < Number(value)) next.captureIntervalMaxSeconds = Number(value);
      if (key === "speechIntervalMinMinutes" && next.speechIntervalMaxMinutes < Number(value)) next.speechIntervalMaxMinutes = Number(value);
      return next;
    });
  };

  const appendRecord = useCallback((kind: "character" | "user", text: string) => {
    if (!character || !text.trim()) return;
    const record: GlobalWatchRecord = {
      id: "global-watch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      characterId: character.id,
      characterName: character.name,
      text: text.trim().slice(0, 2000),
      createdAt: new Date().toISOString(),
      kind,
      targetUrl: "global-watch",
    };
    saveGlobalWatchRecord(record);
    setRecords(loadGlobalWatchRecords());
    const remembered = persistGlobalWatchMemory(record);
    if (!remembered) setStatus("记录已保存；没有找到角色聊天联系人，暂未写入该角色短期记忆。");
  }, [character]);

  const analyzeFrame = useCallback(async (dataUrl: string, userReply = "") => {
    if (!character || busyRef.current || !dataUrl) return;
    busyRef.current = true;
    lastSpeechAtRef.current = Date.now();
    setBusy(true);
    try {
      const videoSettings = loadVideoAnalysisSettings();
      const profile = character as unknown as Record<string, unknown>;
      const roleDetails = [
        typeof profile.persona === "string" ? "角色人设：" + profile.persona : "",
        typeof profile.description === "string" ? "角色介绍：" + profile.description : "",
        typeof profile.personality === "string" ? "性格：" + profile.personality : "",
        typeof profile.scenario === "string" ? "背景设定：" + profile.scenario : "",
        typeof profile.systemPrompt === "string" ? "角色指令：" + profile.systemPrompt : "",
      ].filter(Boolean).join("\n").slice(0, 3500);
      const prompt = [
        "你正在通过全局陪看横幅陪伴用户。下面是一张用户明确授权捕获的手机屏幕画面。",
        "请以角色身份自然回应，像陪用户一起刷视频/使用手机，而不是输出通用的图像识别报告。",
        "角色名：" + character.name,
        roleDetails,
        userReply ? "用户刚刚在悬浮横幅里直接回复你：" + userReply : "这是一次随机陪看时刻，请结合画面中可确认的内容，简短自然地分享一个观察或感受。",
        "隐私规则：不要复述密码、验证码、支付信息、私人聊天或其他敏感内容；如果画面可能包含这些内容，请忽略敏感部分，只做中性回应。不要假装知道被遮挡或看不清的细节。回复 1-3 句话，保持角色口吻。",
      ].filter(Boolean).join("\n");
      const result = await analyzeCapturedImage({
        dataUrl,
        apiKey: videoSettings.apiKey,
        model: videoSettings.model,
        provider: videoSettings.provider,
        baseUrl: videoSettings.baseUrl,
        prompt,
      });
      appendRecord("character", result);
      setStatus("角色已发言并保存记录。");
      try { (window as GlobalWatchWindow).AndroidShell?.showGlobalWatchComment?.(result); } catch { /* overlay may have stopped */ }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Failed model calls are part of the session audit trail too; never silently discard them.
      appendRecord("character", "【陪看分析失败】" + message);
      setStatus("屏幕分析失败，错误已写入全局陪看记录：" + message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [character, appendRecord]);

  const scheduleNextSpeech = useCallback(() => {
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    speechTimerRef.current = null;
    if (!running || paused || !settings.randomSpeechEnabled) return;
    const min = settings.speechIntervalMinMinutes;
    const max = Math.max(min, settings.speechIntervalMaxMinutes);
    const delay = (min + Math.random() * (max - min)) * 60_000;
    speechTimerRef.current = setTimeout(() => {
      const cooldownPassed = Date.now() - lastSpeechAtRef.current >= settings.speechIntervalMinMinutes * 60_000;
      if (frameRef.current && !busyRef.current && cooldownPassed) void analyzeFrame(frameRef.current);
      else if (!frameRef.current) setStatus("等待下一帧屏幕画面，再进行随机主动发言。");
      scheduleNextSpeech();
    }, delay);
  }, [running, paused, settings.randomSpeechEnabled, settings.speechIntervalMinMinutes, settings.speechIntervalMaxMinutes, analyzeFrame]);

  useEffect(() => {
    scheduleNextSpeech();
    return () => { if (speechTimerRef.current) clearTimeout(speechTimerRef.current); };
  }, [scheduleNextSpeech]);

  useEffect(() => {
    const onFrame = (event: Event) => {
      const detail = (event as CustomEvent<{ dataUrl?: string; capturedAt?: number }>).detail;
      if (detail?.dataUrl) {
        frameRef.current = detail.dataUrl;
        setLatestCapturedAt(Number(detail.capturedAt) || Date.now());
        setStatus("已收到屏幕帧；随机主动发言按设置的时间间隔触发。");
        // Android native service owns AI scheduling and requests. The WebView only mirrors capture status.
      }
    };
    const onReply = (event: Event) => {
      const text = String((event as CustomEvent<{ text?: string }>).detail?.text || "").trim();
      if (!text) return;
      if (running && native?.sendGlobalWatchReply) {
        // The native service persists the reply and invokes the model; don't duplicate it in WebView.
        return;
      }
      if (running && native?.sendGlobalWatchReply) return;
      appendRecord("user", text);
      if (frameRef.current) void analyzeFrame(frameRef.current, text);
      else setStatus("已保存你的回复；等待屏幕捕获后角色会回应。");
    };
    const onNativeRecord = (event: Event) => {
      try {
        const item = JSON.parse(String((event as CustomEvent<string>).detail || "{}")) as { id?: string; kind?: string; text?: string; createdAt?: number; characterId?: string; characterName?: string };
        if (!item.id || !item.text || loadGlobalWatchRecords().some(record => record.id === item.id)) return;
        const record: GlobalWatchRecord = {
          id: item.id,
          characterId: item.characterId || "",
          characterName: item.characterName || character?.name || "陪看角色",
          text: (item.kind === "error" ? "【分析失败】" : item.kind === "system" ? "【会话记录】" : "") + item.text,
          createdAt: new Date(typeof item.createdAt === "number" ? item.createdAt : Date.now()).toISOString(),
          kind: item.kind === "user" ? "user" : "character",
          targetUrl: "global-watch",
        };
        saveGlobalWatchRecord(record);
        setRecords(loadGlobalWatchRecords());
      } catch { /* ignore malformed native event */ }
    };
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; running?: boolean; paused?: boolean }>).detail || {};
      if (typeof detail.running === "boolean") setRunning(detail.running);
      if (typeof detail.paused === "boolean") setPaused(detail.paused);
      if (detail.message) setStatus(detail.message);
    };
    window.addEventListener("global-watch-frame", onFrame);
    window.addEventListener("global-watch-reply", onReply);
    window.addEventListener("global-watch-state", onState);
    window.addEventListener("global-watch-record", onNativeRecord);
    return () => {
      window.removeEventListener("global-watch-frame", onFrame);
      window.removeEventListener("global-watch-reply", onReply);
      window.removeEventListener("global-watch-state", onState);
      window.removeEventListener("global-watch-record", onNativeRecord);
    };
  }, [appendRecord, analyzeFrame, settings.randomSpeechEnabled, settings.speechIntervalMinMinutes, settings.speechIntervalMaxMinutes, running, paused]);

  const runDiagnostics = () => {
    const lines: string[] = [];
    lines.push("检查时间：" + new Date().toLocaleString());
    lines.push("运行环境：" + (native ? "检测到 AndroidShell 原生桥" : "未检测到 AndroidShell 原生桥（浏览器无法启动跨应用陪看）"));
    try {
      const raw = native?.getGlobalWatchDiagnostics?.();
      if (raw) {
        const d = JSON.parse(raw) as Record<string, unknown>;
        lines.push("原生桥可信页面：" + (d.trustedPage ? "通过" : "未通过"));
        lines.push("悬浮窗权限：" + (d.overlayPermission ? "已授予" : "未授予"));
        lines.push("原生服务：" + (d.running ? "运行中" : "未运行"));
        lines.push("暂停状态：" + (d.paused ? "已暂停" : "未暂停"));
        if (typeof d.sdkInt === "number") lines.push("Android API：" + d.sdkInt);
        if (typeof d.message === "string" && d.message) lines.push("原生提示：" + d.message);
      } else lines.push("原生诊断接口：当前 APK 未提供，请更新 APK。");
    } catch (error) {
      lines.push("读取原生诊断失败：" + (error instanceof Error ? error.message : String(error)));
    }
    lines.push("已选择角色：" + (character?.name || "未选择"));
    const video = loadVideoAnalysisSettings();
    lines.push("视频分析模型：" + (video.model ? video.model : "未配置模型 ID"));
    lines.push("API Key：" + (video.apiKey ? "已配置（不显示密钥）" : "未配置"));
    lines.push("最近捕获：" + (latestCapturedAt ? new Date(latestCapturedAt).toLocaleString() : "本次页面尚未收到屏幕帧"));
    lines.push("最近记录数：" + records.length);
    const report = lines.join("\\n");
    setDiagnosticsText(report);
    return report;
  };

  const start = () => {
    if (!character) { onNotice?.("请先创建并选择一个角色。"); return; }
    if (!consentChecked) { onNotice?.("请先确认你理解全局陪看会捕获其他应用画面。"); return; }
    if (!native?.startGlobalWatch) {
      setStatus("当前网页或 APK 尚未提供全局陪看原生桥。请更新 APK 后在 Android 壳内启动。");
      return;
    }
    const ok = native.startGlobalWatch(JSON.stringify({
      characterId: character.id,
      characterName: character.name,
      rolePrompt: [
        typeof (character as unknown as Record<string, unknown>).persona === "string" ? String((character as unknown as Record<string, unknown>).persona) : "",
        typeof (character as unknown as Record<string, unknown>).description === "string" ? String((character as unknown as Record<string, unknown>).description) : "",
        typeof (character as unknown as Record<string, unknown>).personality === "string" ? String((character as unknown as Record<string, unknown>).personality) : "",
        typeof (character as unknown as Record<string, unknown>).scenario === "string" ? String((character as unknown as Record<string, unknown>).scenario) : "",
        typeof (character as unknown as Record<string, unknown>).systemPrompt === "string" ? String((character as unknown as Record<string, unknown>).systemPrompt) : "",
      ].filter(Boolean).join("\n").slice(0, 3500),
      captureIntervalMinSeconds: settings.captureIntervalMinSeconds,
      captureIntervalMaxSeconds: settings.captureIntervalMaxSeconds,
      speechIntervalMinMinutes: settings.speechIntervalMinMinutes,
      speechIntervalMaxMinutes: settings.speechIntervalMaxMinutes,
      video: loadVideoAnalysisSettings(),
    }));
    if (!ok) {
      let reason = "原生桥拒绝启动。请打开「诊断与故障排查」查看权限和服务状态。";
      try {
        const raw = native.getGlobalWatchDiagnostics?.();
        if (raw) {
          const d = JSON.parse(raw) as { message?: string; overlayPermission?: boolean; running?: boolean; trustedPage?: boolean };
          reason = d.message || (!d.overlayPermission
            ? "尚未授予悬浮窗权限。系统设置页可能已打开，请授权后返回再启动。"
            : !d.trustedPage ? "当前页面未通过原生桥可信校验，请从已安装的正式 APK 首页进入。"
            : d.running ? "原生服务报告正在运行，但启动调用未成功；请查看诊断详情。"
            : reason);
        }
      } catch { /* retain actionable fallback */ }
      setStatus(reason);
      setDiagnosticsText(reason);
    } else setStatus("已请求启动。请在 Android 系统弹窗中确认屏幕捕获；授权后等待「捕获成功」状态。");
  };
  const stop = () => {
    native?.stopGlobalWatch?.();
    setRunning(false);
    setPaused(false);
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    setStatus("已请求停止全局陪看。");
  };
  const sendReply = () => {
    const text = replyDraft.trim();
    if (!text) return;
    setReplyDraft("");
    if (running && native?.sendGlobalWatchReply) {
      native.sendGlobalWatchReply(text);
    } else {
      appendRecord("user", text);
      if (frameRef.current) void analyzeFrame(frameRef.current, text);
    }
  };

  return <div className="global-watch-companion relative z-[1001] pointer-events-auto flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background,#fbf6ef)] text-[var(--foreground,#4a352b)]" style={{ touchAction: "pan-y" }}>
    <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border,rgba(120,80,55,.18))] px-4 py-3">
      <button type="button" onClick={() => { if (running) onNotice?.("全局陪看运行时请保持此模块打开；你可以按手机 Home 键切换到其他应用。返回前请先停止全局陪看。"); else onClose(); }} className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border,rgba(120,80,55,.2))]" aria-label="返回"><ArrowLeft size={18}/></button>
      <div className="min-w-0 flex-1"><h1 className="text-base font-semibold">全局陪看</h1><p className="text-xs opacity-65">跨应用悬浮横幅 · 随机主动发言 · 记录写入短期记忆</p></div>
      <span className={"h-2.5 w-2.5 rounded-full " + (running && !paused ? "bg-emerald-500" : "bg-stone-400")}/>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <section className="rounded-2xl border border-amber-700/20 bg-white/75 p-4 shadow-sm">
        <div className="flex items-center gap-2 font-semibold"><Settings2 size={17}/>陪看自定义设置</div>
        <label className="mt-4 block text-sm font-medium">陪看角色</label>
        <select value={character?.id || ""} onChange={e => patchSettings("characterId", e.target.value)} className="mt-2 w-full rounded-xl border border-stone-300 bg-white px-3 py-3 text-sm">
          {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-sm">捕获最短间隔（秒）<input type="number" min={15} max={600} value={settings.captureIntervalMinSeconds} onChange={e => patchSettings("captureIntervalMinSeconds", Number(e.target.value))} className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"/></label>
          <label className="text-sm">捕获最长间隔（秒）<input type="number" min={15} max={900} value={settings.captureIntervalMaxSeconds} onChange={e => patchSettings("captureIntervalMaxSeconds", Number(e.target.value))} className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"/></label>
          <label className="text-sm">主动发言最短间隔（分）<input type="number" min={1} max={60} value={settings.speechIntervalMinMinutes} onChange={e => patchSettings("speechIntervalMinMinutes", Number(e.target.value))} className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"/></label>
          <label className="text-sm">主动发言最长间隔（分）<input type="number" min={1} max={120} value={settings.speechIntervalMaxMinutes} onChange={e => patchSettings("speechIntervalMaxMinutes", Number(e.target.value))} className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2"/></label>
        </div>
        <button type="button" onClick={() => patchSettings("randomSpeechEnabled", !settings.randomSpeechEnabled)} className={"mt-4 flex w-full items-center justify-between rounded-xl border px-3 py-3 text-sm " + (settings.randomSpeechEnabled ? "border-emerald-600/30 bg-emerald-50" : "border-stone-300 bg-white")}>
          <span>随机主动发言</span><span>{settings.randomSpeechEnabled ? "已开启" : "已关闭"}</span>
        </button>
        <button type="button" role="checkbox" aria-checked={consentChecked} onClick={() => setConsentChecked(value => !value)} className={"mt-4 flex min-h-[76px] w-full items-center gap-3 rounded-2xl border-2 p-4 text-left transition " + (consentChecked ? "border-emerald-600 bg-emerald-50" : "border-amber-500 bg-amber-50 shadow-sm")}>
          <span className={"flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 text-lg font-bold " + (consentChecked ? "border-emerald-600 bg-emerald-600 text-white" : "border-amber-600 bg-white text-amber-700")}>{consentChecked ? "✓" : "!"}</span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-bold">{consentChecked ? "已确认全局陪看授权说明" : "启动前请点此确认授权说明"}</span><span className="mt-1 block text-xs leading-5 opacity-80">允许在其他应用上方显示悬浮横幅并捕获屏幕画面。敏感页面请暂停或停止；Android 仍会单独请求系统屏幕捕获授权。</span></span>
        </button>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {!running ? <button type="button" onClick={start} className="flex items-center justify-center gap-2 rounded-xl bg-[#b88768] px-3 py-3 text-sm font-semibold text-white"><Eye size={16}/>启动全局陪看</button> : <button type="button" onClick={() => { native?.pauseGlobalWatch?.(!paused); setPaused(!paused); }} className="flex items-center justify-center gap-2 rounded-xl bg-[#b88768] px-3 py-3 text-sm font-semibold text-white">{paused ? <Play size={16}/> : <Pause size={16}/>} {paused ? "继续陪看" : "暂停陪看"}</button>}
          {running ? <button type="button" onClick={() => native?.captureGlobalWatchNow?.()} className="flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-3 py-3 text-sm font-semibold"><Camera size={15}/>立即捕获</button> : <button type="button" onClick={() => { setDiagnosticsOpen(true); runDiagnostics(); }} className="flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-3 py-3 text-sm"><Camera size={15}/>检查捕获条件</button>}
          {running ? <button type="button" onClick={stop} className="col-span-2 flex items-center justify-center gap-2 rounded-xl border border-rose-300 bg-rose-50 px-3 py-3 text-sm font-semibold text-rose-700"><Square size={15}/>停止并关闭横幅</button> : null}
        </div>
        <p role="status" aria-live="polite" className="mt-3 break-words text-xs leading-5 opacity-75">{status}</p>
        {latestCapturedAt > 0 && <p className="mt-1 text-[11px] opacity-50">最近捕获：{new Date(latestCapturedAt).toLocaleTimeString()}</p>}
      </section>

      <section className="mt-4 rounded-2xl border-2 border-amber-600/40 bg-amber-50/80 p-3">
        <button type="button" onClick={() => { const next = !diagnosticsOpen; setDiagnosticsOpen(next); if (next) runDiagnostics(); }} className="flex min-h-[52px] w-full items-center justify-between rounded-xl bg-white px-3 py-3 text-left font-semibold shadow-sm">
          <span className="flex items-center gap-2"><Settings2 size={18}/>诊断与故障排查</span><span className="text-xs text-amber-800">{diagnosticsOpen ? "收起" : "打开诊断"}</span>
        </button>
        {diagnosticsOpen && <div className="mt-3">
          <pre className="whitespace-pre-wrap break-words rounded-xl border border-amber-700/20 bg-white p-3 text-xs leading-5">{diagnosticsText}</pre>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={runDiagnostics} className="rounded-xl border border-stone-300 bg-white px-3 py-3 text-sm font-medium">重新检查</button>
            <button type="button" onClick={() => { if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(diagnosticsText).then(() => setStatus("诊断报告已复制。")).catch(() => setStatus("无法自动复制，请长按诊断文本手动复制。")); else setStatus("当前环境不支持自动复制，请长按诊断文本手动复制。"); }} className="rounded-xl border border-stone-300 bg-white px-3 py-3 text-sm font-medium">复制诊断报告</button>
          </div>
        </div>}
      </section>

      <section className="mt-4 rounded-2xl border border-amber-700/20 bg-white/75 p-4">
        <div className="flex items-center gap-2 font-semibold"><MessageCircle size={17}/>全局陪看记录</div>
        <form onSubmit={e => { e.preventDefault(); sendReply(); }} className="mt-3 flex gap-2">
          <input value={replyDraft} onChange={e => setReplyDraft(e.target.value)} placeholder="直接回复陪看角色…" className="min-w-0 flex-1 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"/>
          <button type="submit" disabled={!replyDraft.trim()} className="flex shrink-0 items-center gap-1 rounded-xl bg-[#b88768] px-3 py-2 text-sm text-white disabled:opacity-40"><Send size={14}/>发送</button>
        </form>
        <div className="mt-3 space-y-2">
          {records.slice(-12).reverse().map(record => <article key={record.id} className="rounded-xl border border-stone-200 bg-[#fffaf5] p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] opacity-55"><span>{record.kind === "user" ? "我" : record.characterName}</span><time>{new Date(record.createdAt).toLocaleString()}</time></div>
            <p className="whitespace-pre-wrap text-sm leading-6">{record.text}</p>
          </article>)}
          {!records.length && <p className="py-4 text-center text-xs opacity-55">尚无全局陪看记录。主动发言和横幅回复都会保存在这里。</p>}
        </div>
      </section>
      <section className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-700/20 bg-emerald-50 p-3 text-xs leading-5 text-emerald-950/80">
        <ShieldCheck size={17} className="mt-0.5 shrink-0"/><p>屏幕帧只在内存中用于模型分析，不会作为原始截图写入记录。每次启动都需要 Android 系统授权；系统状态栏/系统投屏提示也会显示。分析会使用「系统设置 → 视频分析模型」中选定的服务，并可能产生费用。</p>
      </section>
    </div>
  </div>;
}
