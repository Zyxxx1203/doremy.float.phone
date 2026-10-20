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
      <select value={settings.provider} onChange={e => { const provider = e.target.value as VideoAnalysisSettings["provider"]; setSettings(current => ({ ...current, provider, baseUrl: provider === "ark" ? "https://ark.cn-beijing.volces.com/api/v3" : provider === "anthropic" ? "https://api.anthropic.com" : provider === "openai-compatible" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com", model: provider === "ark" ? (current.model.startsWith("gemini-") || current.model.startsWith("gpt-") || current.model.startsWith("claude-") ? "doubao-seed-2-1-pro-260915" : current.model) : provider === "anthropic" ? "claude-sonnet-4-5" : provider === "openai-compatible" ? (current.model.startsWith("gemini-") || current.model.startsWith("doubao-") || current.model.startsWith("claude-") ? "gpt-4.1-mini" : current.model) : (current.model.startsWith("doubao-") || current.model.startsWith("gpt-") || current.model.startsWith("claude-") ? "gemini-2.5-flash" : current.model) })); setSaved(false); }} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm">
        <option value="gemini">Google Gemini 原生视频 API</option>
        <option value="ark">火山方舟 / 豆包原生视频理解</option>
        <option value="openai-compatible">OpenAI 兼容视觉模型（抽帧）</option>
        <option value="anthropic">Anthropic Claude 视觉模型（抽帧）</option>
      </select>
      <p className="mt-2 text-xs leading-5 opacity-65">Gemini、豆包可走原生视频输入；OpenAI 兼容服务和 Claude 会从本地视频抽取关键帧再分析。抽帧模式不传原始音轨。</p>

      <label className="mt-4 block text-sm font-medium">API Key</label>
      <div className="mt-2 flex gap-2">
        <input value={settings.apiKey} onChange={e => update("apiKey", e.target.value)} type={showKey ? "text" : "password"} autoComplete="off" placeholder={settings.provider === "gemini" ? "输入 Gemini API Key" : settings.provider === "ark" ? "输入火山方舟 ARK_API_KEY" : settings.provider === "anthropic" ? "输入 Anthropic API Key" : "输入 API Key；本地服务可按服务端要求留空"} className="min-w-0 flex-1 rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" />
        <button type="button" onClick={() => setShowKey(v => !v)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} className="flex w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--border,rgba(128,128,128,.25))]">{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
      </div>

      {settings.provider !== "gemini" && <><label className="mt-4 block text-sm font-medium">{settings.provider === "ark" ? "方舟 API 地址" : settings.provider === "anthropic" ? "Anthropic API 地址" : "兼容 API 根地址"}</label><input value={settings.baseUrl} onChange={e => update("baseUrl", e.target.value)} placeholder={settings.provider === "ark" ? "https://ark.cn-beijing.volces.com/api/v3" : settings.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" /><p className="mt-1 text-xs leading-5 opacity-65">{settings.provider === "ark" ? "填写方舟 API 根地址；文件上传需要服务端支持 Files API。" : settings.provider === "anthropic" ? "Claude 视觉模式会调用 Messages API；服务端需允许浏览器跨域请求。" : "可连接 OpenAI、Qwen、SiliconFlow、OpenRouter、Ollama、LM Studio 或自建 vLLM 等兼容接口；服务端必须支持图片输入和浏览器跨域请求。局域网/本机地址取决于 WebView 网络与 HTTPS 限制。"}</p></>}
      <label className="mt-4 block text-sm font-medium">视频分析模型 ID</label>
      <input value={settings.model} onChange={e => update("model", e.target.value)} placeholder="例如 gemini-2.5-flash、doubao-seed-2-1-pro-260915、gpt-4.1-mini 或 claude-sonnet-4-5" spellCheck={false} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" />
      <p className="mt-1 text-xs leading-5 opacity-65">请填写该服务支持的视频输入模型（原生视频模式）或图片理解模型（抽帧模式）。模型 ID 必须与所选服务一致。</p>

      {(settings.provider === "openai-compatible" || settings.provider === "anthropic") && <><label className="mt-4 block text-sm font-medium">视频关键帧数量</label><input type="number" min={4} max={24} step={2} value={settings.frameCount} onChange={e => update("frameCount", Number(e.target.value))} className="mt-2 w-full rounded-xl border border-[var(--border,rgba(128,128,128,.25))] bg-[var(--background,transparent)] px-3 py-3 text-sm" /><p className="mt-1 text-xs leading-5 opacity-65">从视频时长范围内均匀抽取 4–24 帧。帧数越多越能覆盖剪辑变化，但图片 token 和费用也越高；这两种模式不会分析原始音轨。</p></>}

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
