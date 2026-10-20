"use client";

import { useContext, useEffect, useState } from "react";
import { Check, Eye, EyeOff, Film, ShieldCheck } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { loadVideoAnalysisSettings, saveVideoAnalysisSettings, type VideoAnalysisSettings } from "@/lib/video-analysis-settings";

export function VideoAnalysisSettingsPanel() {
  const { setSubpageTitle } = useContext(SettingsContext);
  const [settings, setSettings] = useState<VideoAnalysisSettings>(() => loadVideoAnalysisSettings());
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSubpageTitle("视频分析模型");
    return () => setSubpageTitle(null);
  }, [setSubpageTitle]);

  const update = <K extends keyof VideoAnalysisSettings>(key: K, value: VideoAnalysisSettings[K]) => {
    setSettings(current => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const save = () => {
    saveVideoAnalysisSettings(settings);
    setSettings(loadVideoAnalysisSettings());
    setSaved(true);
  };

  return <div className="flex flex-col gap-4 pb-6">
    <section className="rounded-2xl border border-[var(--border,rgba(128,128,128,.2))] bg-[var(--card,rgba(128,128,128,.05))] p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600"><Film size={22} /></span>
        <div>
          <h3 className="text-base font-semibold">一起看 · 完整视频理解</h3>
          <p className="mt-1 text-sm leading-6 opacity-75">独立于普通聊天 API 配置。选择本地视频后，专注模式会把完整视频交给这里配置的视频模型分析。</p>
        </div>
      </div>
      <label className="mt-5 block text-sm font-medium">视频分析服务</label>
      <select value={settings.provider} onChange={e => update("provider", e.target.value as VideoAnalysisSettings["provider"])} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm">
        <option value="gemini">Google Gemini 原生视频 API</option>
      </select>
      <p className="mt-2 text-xs leading-5 opacity-65">当前版本已实现 Gemini 原生视频文件上传。其他视频模型的接口协议不同，不能只改模型名就保证能接收整段视频；后续可在此扩展更多服务。</p>

      <label className="mt-4 block text-sm font-medium">API Key</label>
      <div className="mt-2 flex gap-2">
        <input value={settings.apiKey} onChange={e => update("apiKey", e.target.value)} type={showKey ? "text" : "password"} autoComplete="off" placeholder="输入 Gemini API Key" className="min-w-0 flex-1 rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" />
        <button type="button" onClick={() => setShowKey(v => !v)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} className="flex w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border,rgba(128,128,128,.25))]">{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
      </div>

      <label className="mt-4 block text-sm font-medium">视频分析模型 ID</label>
      <input value={settings.model} onChange={e => update("model", e.target.value)} placeholder="例如 gemini-2.5-flash" spellCheck={false} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" />
      <p className="mt-1 text-xs leading-5 opacity-65">请填写你的 API Key 所支持、且具备视频输入能力的 Gemini 模型 ID。模型可用性受 Google 账号地区、配额和 API 权限影响。</p>

      <label className="mt-4 block text-sm font-medium">单个视频大小上限（MB）</label>
      <input type="number" min={50} max={2048} step={50} value={settings.maxFileSizeMb} onChange={e => update("maxFileSizeMb", Number(e.target.value))} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" />
      <p className="mt-1 text-xs leading-5 opacity-65">建议根据网络和手机性能设置。服务商本身的文件大小、时长和计费限制仍然适用。</p>

      <button type="button" onClick={save} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--primary,#b88768)] px-4 py-3 text-sm font-semibold text-white">
        <Check size={17} />{saved ? "已保存" : "保存视频模型设置"}
      </button>
      {saved && <p role="status" className="mt-2 text-center text-xs text-emerald-600">设置已保存，可返回「一起看」使用。</p>}
    </section>
    <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} />隐私与费用提示</div>
      <p className="mt-2 text-sm leading-6 opacity-75">只有你主动点击「让角色看完整视频」时才会上传；不会自动上传整个相册或后台视频。视频会发送给所选服务商处理，可能产生 API 费用。上传后系统会尝试删除服务商端临时文件，但网络失败时无法保证删除请求一定成功。</p>
    </section>
  </div>;
}
