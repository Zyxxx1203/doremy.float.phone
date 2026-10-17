"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { Archive, ArrowLeft, AudioLines, Check, File, Image as ImageIcon, LoaderCircle, RefreshCw, Search, Trash2, Video, X, Copy, HardDrive, ShieldAlert } from "lucide-react";
import { deleteMediaRef, listMediaCacheSummaries, loadMediaBlob, loadMediaObjectUrl, type MediaCacheSummary } from "@/lib/media-cache-storage";
import { loadChatSessions, loadChatMessages } from "@/lib/chat-storage";

type ArchiveItem = MediaCacheSummary & { ref: string; usedBy: string[]; objectUrl?: string };
type Props = { onClose: () => void; onNotice?: (message: string) => void };
const refFor = (id: string) => `media-store://${id}`;
const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const dateLabel = (value: number) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function ArchiveRoomApp({ onClose, onNotice }: Props) {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<"all" | "duplicates">("all");
  const [filter, setFilter] = useState<"all" | "image" | "audio" | "video" | "file">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanningDuplicates, setScanningDuplicates] = useState(false);
  const [duplicateIds, setDuplicateIds] = useState<Set<string>>(new Set());
  const [duplicateGroups, setDuplicateGroups] = useState<string[][]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const summaries = await listMediaCacheSummaries();
      const sessions = loadChatSessions();
      const used = new Map<string, Set<string>>();
      for (const session of sessions) {
        for (const msg of loadChatMessages(session.id)) {
          const refs = [msg.mediaUrl, ...(Array.isArray(msg.mediaData?.imageRefs) ? msg.mediaData.imageRefs as string[] : [])];
          for (const ref of refs) {
            if (typeof ref !== "string" || !ref.startsWith("media-store://")) continue;
            const id = ref.slice("media-store://".length);
            if (!used.has(id)) used.set(id, new Set());
            used.get(id)!.add(session.groupName || session.alias || session.contactId || session.id);
          }
        }
      }
      setItems(summaries.map(item => ({ ...item, ref: refFor(item.id), usedBy: [...(used.get(item.id) || [])] })).sort((a, b) => b.createdAt - a.createdAt));
      setSelected([]);
    } catch (error) {
      onNotice?.("读取媒体库失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { setLoading(false); }
  }, [onNotice]);

  useEffect(() => { void refresh(); }, [refresh]);

  const stats = useMemo(() => items.reduce((acc, item) => {
    acc.count += 1; acc.bytes += item.bytes; acc[item.category] += 1; return acc;
  }, { count: 0, bytes: 0, image: 0, audio: 0, video: 0, file: 0 }), [items]);

  const scanDuplicates = async () => {
    if (scanningDuplicates) return;
    setScanningDuplicates(true);
    try {
      const hashGroups = new Map<string, string[]>();
      // 逐个读取并计算摘要，不把所有媒体 Blob 同时放进内存。
      for (const item of items) {
        const loaded = await loadMediaBlob(item.ref);
        if (!loaded) continue;
        const digest = await crypto.subtle.digest("SHA-256", await loaded.blob.arrayBuffer());
        const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
        const ids = hashGroups.get(hash) || [];
        ids.push(item.id);
        hashGroups.set(hash, ids);
      }
      const groups = [...hashGroups.values()].filter(group => group.length > 1);
      const byId = new Map(items.map(item => [item.id, item]));
      // Prefer keeping files referenced by chat. Only recommend deleting an unreferenced
      // copy; if every copy is referenced, leave the group out of deletion candidates.
      // The current reference index covers chat messages, so this is deliberately
      // conservative rather than claiming a full cross-module reference audit.
      const candidates = groups.flatMap(group => {
        const sorted = group.slice().sort((a, b) => {
          const left = byId.get(a); const right = byId.get(b);
          const leftReferenced = (left?.usedBy.length ?? 0) > 0;
          const rightReferenced = (right?.usedBy.length ?? 0) > 0;
          if (leftReferenced !== rightReferenced) return leftReferenced ? -1 : 1;
          return (right?.bytes ?? 0) - (left?.bytes ?? 0) || (right?.createdAt ?? 0) - (left?.createdAt ?? 0);
        });
        return sorted.slice(1).filter(id => (byId.get(id)?.usedBy.length ?? 0) === 0);
      });
      setDuplicateGroups(groups);
      setDuplicateIds(new Set(candidates));
      setSelected([]);
      setTab("duplicates");
      const protectedCount = groups.reduce((count, group) => {
        const hasUnreferencedDuplicate = group.some(id => candidates.includes(id));
        return count + (hasUnreferencedDuplicate ? 0 : 1);
      }, 0);
      onNotice?.(groups.length
        ? `找到 ${groups.length} 组完全相同的文件；仅推荐删除未被聊天引用的副本。另有 ${protectedCount} 组没有安全删除候选，已保护不推荐删除。请检查后手动选择。`
        : "没有发现内容完全相同的文件。");
    } catch (error) {
      onNotice?.("重复扫描失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { setScanningDuplicates(false); }
  };

  const visibleItems = useMemo(() => items.filter(item => {
    if (tab === "duplicates" && !duplicateIds.has(item.id)) return false;
    if (filter !== "all" && item.category !== filter) return false;
    if (query && !item.id.toLowerCase().includes(query.toLowerCase()) && !item.usedBy.some(name => name.toLowerCase().includes(query.toLowerCase()))) return false;
    return true;
  }), [items, tab, duplicateIds, filter, query]);

  const toggle = (id: string) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const exportSelected = async () => {
    if (!selected.length) return;
    try {
      const zip = new JSZip();
      let exported = 0;
      for (const item of items.filter(entry => selected.includes(entry.id))) {
        const stored = await loadMediaBlob(item.ref);
        if (!stored) continue;
        const extension = stored.mimeType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") || "bin";
        zip.file(`${item.category}/${item.id}.${extension}`, stored.blob);
        exported += 1;
      }
      if (!exported) { onNotice?.("所选项目没有可导出的文件。"); return; }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `档案室导出-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      onNotice?.(`已导出 ${exported} 个文件。`);
    } catch (error) {
      onNotice?.("导出失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };

  const deleteSelected = async () => {
    const targets = items.filter(item => selected.includes(item.id));
    const referenced = targets.filter(item => item.usedBy.length > 0);
    if (referenced.length && !confirmDelete) {
      setConfirmDelete(true);
      onNotice?.(`其中 ${referenced.length} 个文件仍被聊天消息引用。再次确认才会删除文件；聊天文字会保留，但对应媒体可能无法显示。`);
      return;
    }
    try {
      await Promise.all(targets.map(item => deleteMediaRef(item.ref)));
      setConfirmDelete(false);
      onNotice?.(`已删除 ${targets.length} 个媒体文件。`);
      await refresh();
    } catch (error) {
      onNotice?.("删除失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };

  return <div className="absolute inset-0 z-[80] flex flex-col overflow-hidden bg-[#f6f4f0] text-stone-800">
    <header className="flex shrink-0 items-center gap-3 border-b border-stone-200 bg-white/90 px-4 py-3">
      <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-stone-100" aria-label="返回"><ArrowLeft size={18}/></button>
      <div className="min-w-0 flex-1"><div className="text-lg font-semibold tracking-wide">档案室</div><div className="text-xs text-stone-500">媒体资产与留存管理</div></div>
      <button onClick={() => void refresh()} disabled={loading} className="grid h-9 w-9 place-items-center rounded-full bg-stone-100" aria-label="刷新"><RefreshCw size={16} className={loading ? "animate-spin" : ""}/></button>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <section className="rounded-3xl bg-gradient-to-br from-[#e8e0d3] via-[#f4eee5] to-[#d9e3db] p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3"><div><div className="text-sm text-stone-600">已索引媒体</div><div className="mt-1 text-3xl font-semibold">{stats.count.toLocaleString()} <span className="text-sm font-normal text-stone-500">个文件</span></div><div className="mt-1 text-sm text-stone-600">索引媒体大小合计 {bytesLabel(stats.bytes)}</div></div><div className="rounded-2xl bg-white/65 p-3"><HardDrive size={26}/></div></div>
        <div className="mt-5 grid grid-cols-4 gap-2">{([{key:"image",label:"图片",Icon:ImageIcon},{key:"audio",label:"语音",Icon:AudioLines},{key:"video",label:"视频",Icon:Video},{key:"file",label:"文件",Icon:File}] as const).map(({key,label,Icon})=><button key={key} onClick={()=>{setFilter(key);setTab("all");}} className={`rounded-2xl border p-3 text-left ${filter===key?"border-stone-500 bg-white/80":"border-white/70 bg-white/40"}`}><Icon size={17}/><div className="mt-2 text-lg font-semibold">{stats[key]}</div><div className="text-xs text-stone-500">{label}</div></button>)}</div>
      </section>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button onClick={() => {setTab("all");setFilter("all");}} className={`rounded-2xl border p-4 text-left ${tab==="all"?"border-stone-400 bg-white":"border-stone-200 bg-white/60"}`}><Archive size={19}/><div className="mt-2 font-semibold">媒体库</div><div className="mt-1 text-xs text-stone-500">浏览、筛选与批量管理</div></button>
        <button onClick={() => void scanDuplicates()} disabled={scanningDuplicates || loading} className="rounded-2xl border border-stone-200 bg-white/60 p-4 text-left disabled:opacity-60">{scanningDuplicates?<LoaderCircle size={19} className="animate-spin"/>:<Copy size={19}/>}<div className="mt-2 font-semibold">重复文件扫描</div><div className="mt-1 text-xs text-stone-500">按文件内容精确比对</div></button>
      </div>
      {tab==="duplicates"&&<div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><ShieldAlert size={16} className="mb-1"/>仅识别文件内容完全一致的重复项，不会自动删除。相似但经过压缩或裁剪的图片不会在此列出。</div>}
      <div className="mt-5 flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-3 py-2"><Search size={16} className="shrink-0 text-stone-400"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索文件 ID 或关联会话" className="min-w-0 flex-1 bg-transparent text-sm outline-none"/>{query&&<button onClick={()=>setQuery("")}><X size={15}/></button>}</div>
      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">{([{key:"all",label:"全部"},{key:"image",label:"图片"},{key:"audio",label:"语音"},{key:"video",label:"视频"},{key:"file",label:"其他"}] as const).map(x=><button key={x.key} onClick={()=>setFilter(x.key)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${filter===x.key?"bg-stone-800 text-white":"bg-white text-stone-600"}`}>{x.label}</button>)}</div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-stone-500"><span>{visibleItems.length} 个项目{selected.length? ` · 已选 ${selected.length}`:""}</span><button onClick={()=>setSelected(selected.length===visibleItems.length?[]:visibleItems.map(x=>x.id))} className="font-medium text-stone-700">{selected.length===visibleItems.length&&visibleItems.length?"取消全选":"选择当前列表"}</button></div>
      <div className="mt-2 space-y-2 pb-24">{loading?<div className="py-12 text-center text-sm text-stone-500"><LoaderCircle className="mx-auto mb-2 animate-spin"/>正在扫描媒体索引…</div>:visibleItems.length===0?<div className="rounded-2xl border border-dashed border-stone-300 bg-white/50 px-4 py-12 text-center text-sm text-stone-500">{tab==="duplicates"?"没有重复项，或尚未完成扫描。":"当前范围没有找到媒体文件。"}</div>:visibleItems.map(item=><MediaRow key={item.id} item={item} checked={selected.includes(item.id)} onToggle={()=>toggle(item.id)}/>)}</div>
    </main>
    {selected.length>0&&<footer className="flex shrink-0 items-center gap-3 border-t border-stone-200 bg-white/95 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]"><div className="min-w-0 flex-1 text-sm"><div className="font-semibold">已选择 {selected.length} 项</div><div className="text-xs text-stone-500">约 {bytesLabel(items.filter(x=>selected.includes(x.id)).reduce((n,x)=>n+x.bytes,0))}</div></div><button onClick={()=>void exportSelected()} className="flex items-center gap-2 rounded-xl border border-stone-300 px-3 py-2.5 text-sm font-medium text-stone-700">导出 ZIP</button><button onClick={()=>{setSelected([]);setConfirmDelete(false);}} className="rounded-xl px-3 py-2 text-sm text-stone-600">取消</button><button onClick={()=>void deleteSelected()} className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white"><Trash2 size={16}/>{confirmDelete?"确认删除":"删除所选"}</button></footer>}
  </div>;
}

function MediaRow({ item, checked, onToggle }: { item: ArchiveItem; checked: boolean; onToggle: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let current = "";
    if (item.category === "image" || item.category === "video" || item.category === "audio") {
      void loadMediaObjectUrl(item.ref).then(value => { if (value) { current = value; setUrl(value); } });
    }
    return () => { if (current) URL.revokeObjectURL(current); };
  }, [item.ref, item.category]);
  const Icon = item.category === "image" ? ImageIcon : item.category === "audio" ? AudioLines : item.category === "video" ? Video : File;
  return <article className={`flex items-center gap-3 rounded-2xl border p-3 ${checked?"border-stone-500 bg-stone-50":"border-stone-200 bg-white"}`}>
    <button onClick={onToggle} className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${checked?"border-stone-800 bg-stone-800 text-white":"border-stone-300 text-transparent"}`} aria-label={checked?"取消选择":"选择"}><Check size={14}/></button>
    <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-stone-100">{item.category==="image"&&url?<img src={url} alt="" className="h-full w-full object-cover"/>:<Icon size={22} className="text-stone-500"/>}</div>
    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{item.id}</div><div className="mt-1 text-xs text-stone-500">{bytesLabel(item.bytes)} · {dateLabel(item.createdAt)}</div>{item.category === "audio" && url && <audio controls preload="none" src={url} className="mt-2 h-8 w-full max-w-[190px]"/>}<div className={item.usedBy.length ? "mt-1 truncate text-xs text-emerald-700" : "mt-1 truncate text-xs text-amber-700"}>{item.usedBy.length ? "关联 " + item.usedBy.length + " 个聊天会话" : "未发现聊天引用（不代表一定可删除）"}</div></div>
  </article>;
}
