"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import {
  clearLifeDiagnostics,
  readLifeDiagnostics,
  type LifeDiagnosticEntry,
  type LifeDiagnosticStatus,
} from "@/lib/life/life-diagnostics";

const STATUS_LABEL: Record<LifeDiagnosticStatus, string> = {
  ok: "成功",
  warning: "警告",
  error: "失败",
  info: "记录",
};

const STATUS_STYLE: Record<LifeDiagnosticStatus, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  error: "bg-rose-100 text-rose-700",
  info: "bg-stone-100 text-stone-600",
};

type DiagnosticFilter = "all" | LifeDiagnosticStatus;

export function LifeDiagnosticsPanel() {
  const [entries, setEntries] = useState<LifeDiagnosticEntry[]>([]);
  const [filter, setFilter] = useState<DiagnosticFilter>("all");

  const refresh = () => setEntries(readLifeDiagnostics());

  useEffect(() => {
    refresh();
    const onUpdated = () => refresh();
    window.addEventListener("life-diagnostics-updated", onUpdated);
    return () => window.removeEventListener("life-diagnostics-updated", onUpdated);
  }, []);

  const visible = filter === "all"
    ? entries
    : entries.filter(entry => entry.status === filter);

  const counts = entries.reduce<Record<LifeDiagnosticStatus, number>>(
    (result, entry) => {
      result[entry.status] += 1;
      return result;
    },
    { ok: 0, warning: 0, error: 0, info: 0 },
  );

  const exportLog = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "life-diagnostics.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const clearLog = () => {
    if (!window.confirm("清空本机诊断记录？不会影响生活数据。")) return;
    clearLifeDiagnostics();
    refresh();
  };

  return (
    <section className="rounded-3xl border border-[var(--life-accent)]/25 bg-white/75 p-4 shadow-sm sm:p-6 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--life-accent)]">
            System diagnostics
          </p>
          <h2 className="mt-1 text-lg font-semibold text-stone-800">生活系统诊断记录</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-500">
            自动记录日程同步、主动消息调度、通知回复等关键链路。仅保存在本设备，最多 300 条。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs"
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            type="button"
            disabled={!entries.length}
            onClick={exportLog}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs disabled:opacity-40"
          >
            <Download size={14} />
            导出 JSON
          </button>
          <button
            type="button"
            disabled={!entries.length}
            onClick={clearLog}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-rose-200 bg-white px-3 text-xs text-rose-700 disabled:opacity-40"
          >
            <Trash2 size={14} />
            清空
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2">
        {(["ok", "warning", "error", "info"] as const).map(status => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(current => current === status ? "all" : status)}
            className={`rounded-xl border px-2 py-2 text-left ${
              filter === status
                ? "border-[var(--life-accent)] bg-[var(--life-accent)]/10"
                : "border-stone-200 bg-white/80"
            }`}
          >
            <b className="block text-lg">{counts[status]}</b>
            <span className="text-[10px] text-stone-500">{STATUS_LABEL[status]}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs font-medium text-stone-600">最近记录 · {visible.length}</p>
        <select
          value={filter}
          onChange={event => setFilter(event.target.value as DiagnosticFilter)}
          className="rounded-lg border bg-white px-2 py-1.5 text-xs"
          aria-label="筛选诊断记录"
        >
          <option value="all">全部</option>
          <option value="error">失败</option>
          <option value="warning">警告</option>
          <option value="ok">成功</option>
          <option value="info">记录</option>
        </select>
      </div>

      <div
        className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto pr-1"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {visible.slice(0, 100).map(entry => (
          <article key={entry.id} className="rounded-xl border border-stone-200/70 bg-white/85 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS_STYLE[entry.status]}`}>
                {STATUS_LABEL[entry.status]}
              </span>
              <b className="text-xs">{entry.source} · {entry.event}</b>
              <time className="ml-auto text-[10px] text-stone-400">
                {new Date(entry.at).toLocaleString("zh-CN")}
              </time>
            </div>

            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600">
              {entry.detail}
            </p>

            {entry.meta && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] text-stone-400">链路参数</summary>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-stone-50 p-2 text-[10px]">
                  {JSON.stringify(entry.meta, null, 2)}
                </pre>
              </details>
            )}
          </article>
        ))}

        {!visible.length && (
          <p className="rounded-xl bg-white/70 p-4 text-center text-xs text-stone-500">
            暂无记录；执行日程同步或主动消息链路后会自动显示。
          </p>
        )}
      </div>

      <p className="mt-2 text-[10px] text-stone-400">
        导出前请检查是否包含不想分享的角色名称或错误详情；诊断不会自动上传。
      </p>
    </section>
  );
}
