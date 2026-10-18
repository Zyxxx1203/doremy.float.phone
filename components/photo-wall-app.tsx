"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, Download, Feather, Heart, ImagePlus, LoaderCircle, MessageCircle, MoreHorizontal, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { loadImageGenerationSettings } from "@/lib/settings-storage";
import type { Character } from "@/lib/character-types";
import { generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import { loadMediaBlob, loadMediaObjectUrl, storeMediaBlob, deleteMediaRef } from "@/lib/media-cache-storage";
import { loadVirtualLifeState } from "@/lib/life/life-storage";
import { generateChatCompletion, flattenCompletionResult, readCompressedImageDataUrl } from "@/lib/chat-engine";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import {
  createPhotoWallId, DEFAULT_PHOTO_WALL_SETTINGS, loadPhotoWallState, savePhotoWallState,
  type PhotoWallDoodle, type PhotoWallPhoto, type PhotoWallPlacement, type PhotoWallState, type PhotoWallTemplate, type PhotoWallWorld,
} from "@/lib/photo-wall-storage";
import { PhotoWallCanvas, fallbackPlacement } from "@/components/photo-wall/photo-wall-canvas";
import { applyWorldGrow, planWorldGrow, remapDoodles, remapPlacement, wallWorldOf, type WorldGrow } from "@/lib/photo-wall-world";
import { buildTemplateSlots, listAllTemplates, loadCustomTemplates, saveCustomTemplates } from "@/lib/photo-wall-templates";
import { downloadPhotoWallPng } from "@/lib/photo-wall-export";

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Filter = "all" | "mine" | "characters";

const KIND_LABEL: Record<PhotoWallPhoto["kind"], string> = {
  favorite: "珍藏", selfie: "自拍", candid: "不经意的你", scenery: "沿途风景", object: "喜欢的小物", moment: "共同瞬间",
};
const KIND_OPTIONS: PhotoWallPhoto["kind"][] = ["favorite", "selfie", "candid", "scenery", "object", "moment"];
const DAY_MS = 24 * 60 * 60 * 1000;
const PHOTO_WALL_PROMPT_KEY = "ai_phone_photo_wall_prompt_v1";
const PHOTO_WALL_ACTIVE_TEMPLATE_KEY = "ai_phone_photo_wall_active_template_v1";
const PHOTO_WALL_CHARACTER_KEY = "ai_phone_photo_wall_selected_character_v1";
const DEFAULT_PHOTO_WALL_PROMPT = [
  "请生成一张真实相机拍摄的私人生活照片，而不是插画、海报或拼贴。",
  "角色：{characterName}",
  "角色设定：{characterPersona}",
  "照片类型：{photoType}",
  "近期生活片段：{lifeEvent}",
  "参考图要求：{referenceText}",
  "画面风格：温柔、文艺、自然光、低饱和胶片色彩、细微颗粒、构图克制、真实生活细节。",
  "不要出现文字、水印、拼接边框或不自然的手指。",
].join("\n");
function readPhotoWallPrompt(): string { try { return typeof window !== "undefined" ? window.localStorage.getItem(PHOTO_WALL_PROMPT_KEY) || DEFAULT_PHOTO_WALL_PROMPT : DEFAULT_PHOTO_WALL_PROMPT; } catch { return DEFAULT_PHOTO_WALL_PROMPT; } }
function readPhotoWallTemplate(): string { try { return typeof window !== "undefined" ? window.localStorage.getItem(PHOTO_WALL_ACTIVE_TEMPLATE_KEY) || "builtin-scatter" : "builtin-scatter"; } catch { return "builtin-scatter"; } }
function readPhotoWallCharacter(): string { try { return typeof window !== "undefined" ? window.localStorage.getItem(PHOTO_WALL_CHARACTER_KEY) || "" : ""; } catch { return ""; } }

function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "某个日子";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function getPhotoBackText(photo: PhotoWallPhoto): string {
  const manual = photo.backNote?.trim() ?? "";
  const legacyNotes = (photo.annotations ?? []).map(note => {
    const date = new Date(note.createdAt);
    const when = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
    return `${note.authorName}${when ? `（${when}）` : ""}：${note.content.trim()}`;
  }).filter(Boolean);
  return [manual, ...legacyNotes].filter(Boolean).join("\n\n");
}
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

async function composePhotoReferenceSheet(sources: Array<{ label: string; dataUrl: string; crop?: { x: number; y: number; size: number } }>): Promise<string | undefined> {
  if (!sources.length) return undefined;
  const decoded = await Promise.all(sources.map(source => new Promise<{ label: string; image: HTMLImageElement; crop?: { x: number; y: number; size: number } }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ label: source.label, image, crop: source.crop });
    image.onerror = () => reject(new Error("参考图读取失败"));
    image.src = source.dataUrl;
  })));
  const cell = 384;
  const columns = Math.min(2, decoded.length);
  const rows = Math.ceil(decoded.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = columns * cell;
  canvas.height = rows * (cell + 36);
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.fillStyle = "#f7f0e7";
  context.fillRect(0, 0, canvas.width, canvas.height);
  decoded.forEach(({ label, image, crop }, index) => {
    const x = (index % columns) * cell;
    const y = Math.floor(index / columns) * (cell + 36);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (crop) {
      const side = Math.max(1, Math.round(Math.min(width, height) * Math.max(0.18, Math.min(1, crop.size))));
      const sx = Math.max(0, Math.min(width - side, Math.round(crop.x * width)));
      const sy = Math.max(0, Math.min(height - side, Math.round(crop.y * height)));
      context.drawImage(image, sx, sy, side, side, x + 12, y + 8, cell - 24, cell - 24);
    } else {
      const scale = Math.min((cell - 24) / width, (cell - 24) / height);
      const w = width * scale, h = height * scale;
      context.drawImage(image, x + (cell - w) / 2, y + 8 + (cell - 24 - h) / 2, w, h);
    }
    context.fillStyle = "#49392f";
    context.font = "600 16px sans-serif";
    context.textAlign = "center";
    context.fillText(label, x + cell / 2, y + cell + 22, cell - 20);
  });
  return canvas.toDataURL("image/png");
}
async function optimizeUpload(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("图片无法读取")); image.src = url; });
      const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const type = file.type === "image/png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.88));
      return blob && blob.size < file.size ? blob : file;
    } finally { URL.revokeObjectURL(url); }
  } catch { return file; }
}

function PhotoThumbnail({ photo, onOpen }: { photo: PhotoWallPhoto; onOpen: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    void loadMediaObjectUrl(photo.mediaRef).then(value => {
      if (!active) { if (value) URL.revokeObjectURL(value); return; }
      if (value) { url = value; setSrc(value); }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [photo.mediaRef]);
  return <button type="button" onClick={onOpen} aria-label={`查看照片：${photo.title || "未命名的瞬间"}`} className="group relative block w-full text-left">
    <div className="relative aspect-square overflow-hidden bg-[#e9e3d8]">
      {src ? <img src={src} alt={photo.title} loading="lazy" className="h-full w-full object-contain transition duration-500 group-hover:scale-[1.01]" /> : <div className="grid h-full place-items-center text-[#9c907f]"><ImagePlus size={25}/></div>}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" style={{overflow:"visible"}}>
        {(photo.doodles ?? []).map(doodle => doodle.kind === "stroke" ? <polyline key={doodle.id} points={doodle.points.map(point=>`${point.x*100},${point.y*100}`).join(" ")} fill="none" stroke={doodle.color} strokeWidth={Math.max(0.8,doodle.width/2)} strokeLinecap="round" strokeLinejoin="round"/> : <text key={doodle.id} x={(doodle.points[0]?.x ?? .5)*100} y={(doodle.points[0]?.y ?? .5)*100} fill={doodle.color} fontSize="12" textAnchor="middle" dominantBaseline="middle">{doodle.content || "✦"}</text>)}
      </svg>
      <span className="absolute left-1.5 top-1.5 bg-[#fffaf0]/90 px-1.5 py-0.5 text-[9px] tracking-wide text-[#7f6b58]">{KIND_LABEL[photo.kind]}</span>
    </div>
  </button>;
}
export function PhotoWallApp({ onClose, onNotice }: Props) {
  const [state, setState] = useState<PhotoWallState>(() => loadPhotoWallState());
  const [characters, setCharacters] = useState<Character[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [wallView, setWallView] = useState<"timeline" | "memories" | "edit" | "settings">("edit");
  const [panoramaZoom, setPanoramaZoom] = useState(100);
  const [timelineRange, setTimelineRange] = useState<"all" | "7d" | "30d" | "90d" | "year">("all");
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  const pinchPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchModeRef = useRef(false);
  const singleTouchRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number; startedOnPhoto: boolean } | null>(null);
  const panoramaViewportRef = useRef<HTMLDivElement>(null);
  const panoramaZoomRef = useRef(100);
  /** 世界尺寸来自持久化状态：扩容后照片比例不变，只换分母。 */
  const world = wallWorldOf(state);
  const zoomInitializedRef = useRef(false);
  /** 等待下一帧补偿的滚动量（扩容往左长、或缩放锚点变化时用）。 */
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

  /**
   * 缩放时保持视口中心不动。
   * 只改 zoom 会让内容从左上角往外长，手指按住的地方就跑掉了；
   * 这里按同一比例把滚动位置一起推过去，手感才对。
   */
  const applyZoom = useCallback((nextZoom: number) => {
    const clamped = Math.max(15, Math.min(300, Math.round(nextZoom)));
    const previous = panoramaZoomRef.current;
    panoramaZoomRef.current = clamped;
    setPanoramaZoom(clamped);
    if (!previous || previous === clamped) return;
    const viewport = panoramaViewportRef.current;
    if (!viewport) return;
    const ratio = clamped / previous;
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    pendingScrollRef.current = {
      left: (viewport.scrollLeft + centerX) * ratio - centerX - viewport.scrollLeft,
      top: (viewport.scrollTop + centerY) * ratio - centerY - viewport.scrollTop,
    };
  }, []);
  const [wallBackgroundUrl, setWallBackgroundUrl] = useState("");
  const wallBackgroundInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { panoramaZoomRef.current = panoramaZoom; }, [panoramaZoom]);
  // 无界画布：首次进入编辑视图时把世界宽度适配成约 2.6 屏宽，
  // 和升级前的「三屏宽画布」观感一致；之后缩放完全交给双指。
  useEffect(() => {
    if (wallView !== "edit" || zoomInitializedRef.current) return;
    const width = panoramaViewportRef.current?.clientWidth ?? 0;
    if (!width) return;
    zoomInitializedRef.current = true;
    const fit = Math.round((260 * width) / Math.max(1, world.width));
    setPanoramaZoom(Math.min(180, Math.max(15, fit)));
  }, [wallView, world.width, state.photos.length]);
  useEffect(() => {
    if (wallView !== "edit") return;
    const viewport = panoramaViewportRef.current;
    if (!viewport) return;
    const touchDistance = (touches: TouchList) => Math.max(1, Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY));
    const pointsDistance = (points: { x: number; y: number }[]) => Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !(event.target instanceof Node) || !viewport.contains(event.target)) return;
      pinchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinchPointersRef.current.size < 2) return;
      const points = [...pinchPointersRef.current.values()].slice(0, 2);
      pinchStartRef.current = { distance: pointsDistance(points), zoom: panoramaZoomRef.current };
      pinchModeRef.current = true;
      singleTouchRef.current = null;
      window.dispatchEvent(new Event("photo-wall-pinch-start"));
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    const onPointerMove = (event: PointerEvent) => {
      const pointers = pinchPointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!pinchModeRef.current) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (pointers.size < 2 || !pinchStartRef.current) return;
      const nextZoom = Math.max(15, Math.min(300, Math.round(pinchStartRef.current.zoom * pointsDistance([...pointers.values()].slice(0, 2)) / pinchStartRef.current.distance)));
      applyZoom(nextZoom);
    };
    const onPointerEnd = (event: PointerEvent) => {
      const pointers = pinchPointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      const wasPinching = pinchModeRef.current;
      pointers.delete(event.pointerId);
      if (wasPinching && pointers.size < 2) {
        pinchModeRef.current = false;
        pinchStartRef.current = null;
        // End the pinch as soon as either finger lifts; the remaining finger
        // must not keep the canvas frozen, and any subsequent pinch starts fresh.
        window.dispatchEvent(new Event("photo-wall-pinch-end"));
      }
      if (pointers.size === 0) singleTouchRef.current = null;
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length >= 2) {
        if (!pinchModeRef.current) {
          pinchStartRef.current = { distance: touchDistance(event.touches), zoom: panoramaZoomRef.current };
          pinchModeRef.current = true;
          window.dispatchEvent(new Event("photo-wall-pinch-start"));
        }
        singleTouchRef.current = null;
          if (event.cancelable) event.preventDefault();
        return;
      }
      if (event.touches.length === 1) {
        const target = event.target instanceof Element ? event.target : null;
        singleTouchRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, startedOnPhoto: Boolean(target?.closest("[data-photo-wall-photo]")) };
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 2) {
        if (event.cancelable) event.preventDefault();
        if (!pinchStartRef.current) pinchStartRef.current = { distance: touchDistance(event.touches), zoom: panoramaZoomRef.current };
        if (!pinchModeRef.current) {
          pinchModeRef.current = true;
          window.dispatchEvent(new Event("photo-wall-pinch-start"));
        }
        const nextZoom = Math.max(15, Math.min(300, Math.round(pinchStartRef.current.zoom * touchDistance(event.touches) / pinchStartRef.current.distance)));
        applyZoom(nextZoom);
          return;
      }
      if (event.touches.length !== 1 || pinchModeRef.current) return;
      if (viewport.querySelector('[data-photo-wall-mode="doodle"]')) return;
      const start = singleTouchRef.current;
      if (!start || (start.startedOnPhoto && wallView === "edit")) return;
      const dx = event.touches[0].clientX - start.x, dy = event.touches[0].clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      if (event.cancelable) event.preventDefault();
      viewport.scrollLeft = start.scrollLeft - dx; viewport.scrollTop = start.scrollTop - dy;
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2 && pinchModeRef.current) {
        pinchModeRef.current = false;
        pinchStartRef.current = null;
        window.dispatchEvent(new Event("photo-wall-pinch-end"));
      }
      if (event.touches.length === 0) singleTouchRef.current = null;
      else if (event.touches.length === 1) singleTouchRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, startedOnPhoto: false };
    };
    // Window capture keeps tracking both fingers even if one leaves a photo frame.
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    viewport.addEventListener("touchstart", onTouchStart, { passive: false, capture: true });
    viewport.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    viewport.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
    viewport.addEventListener("touchcancel", onTouchEnd, { passive: false, capture: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      viewport.removeEventListener("touchstart", onTouchStart, true);
      viewport.removeEventListener("touchmove", onTouchMove, true);
      viewport.removeEventListener("touchend", onTouchEnd, true);
      viewport.removeEventListener("touchcancel", onTouchEnd, true);
    };
  }, [wallView]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>(() => readPhotoWallCharacter());
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let loadedUrl = "";
    const backgroundRef = state.wallBackgroundRef;
    if (!backgroundRef) { setWallBackgroundUrl(""); return; }
    void loadMediaObjectUrl(backgroundRef).then(url => {
      if (!active) { if (url) URL.revokeObjectURL(url); return; }
      loadedUrl = url || "";
      setWallBackgroundUrl(loadedUrl);
    }).catch(() => { if (active) setWallBackgroundUrl(""); });
    return () => { active = false; if (loadedUrl) URL.revokeObjectURL(loadedUrl); };
  }, [state.wallBackgroundRef]);
  const [timelineFlippedPhotoIds, setTimelineFlippedPhotoIds] = useState<Set<string>>(new Set());
  const [photoViewOnly, setPhotoViewOnly] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editTags, setEditTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [newKind, setNewKind] = useState<PhotoWallPhoto["kind"]>("favorite");
  const [referencePhotoId, setReferencePhotoId] = useState("");
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showChatPicker, setShowChatPicker] = useState(false);
  const [chatCandidates, setChatCandidates] = useState<Array<{ key: string; ref: string; title: string; sessionName: string; createdAt: string }>>([]);
  const [characterCommenterId, setCharacterCommenterId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const autoRunRef = useRef(false);

  // 拖动照片时每帧都写 localStorage 会明显卡手，这里把落盘延后合并。
  const saveTimerRef = useRef<number | null>(null);
  // 拖动是高频回调，且 setState 的更新函数必须是纯函数（StrictMode 会执行两次），
  // 所以不能把写盘副作用塞进更新函数里。用 ref 保存最新状态快照供回调同步读取。
  const stateRef = useRef(state);
  stateRef.current = state;
  const [templateText, setTemplateText] = useState("LOVE");
  const [activeTemplateId, setActiveTemplateId] = useState<string>(() => readPhotoWallTemplate());
  const [generationPromptTemplate, setGenerationPromptTemplate] = useState<string>(() => readPhotoWallPrompt());
  const [templateName, setTemplateName] = useState("");
  const [customTemplates, setCustomTemplates] = useState<PhotoWallTemplate[]>(() => loadCustomTemplates());
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  useEffect(() => {
    const handleAppBack = (event: Event) => {
      const detail = (event as CustomEvent<{ handled?: boolean }>).detail;
      if (showAddMenu) { setShowAddMenu(false); if (detail) detail.handled = true; return; }
      if (showChatPicker) { setShowChatPicker(false); if (detail) detail.handled = true; return; }
      if (selectedPhotoId) { setSelectedPhotoId(null); if (detail) detail.handled = true; return; }
      if (wallView === "settings" || wallView === "timeline" || wallView === "memories") { setWallView("edit"); if (detail) detail.handled = true; return; }
      if (wallView === "edit") { onClose(); if (detail) detail.handled = true; }
    };
    window.addEventListener("floatphone-app-back", handleAppBack);
    return () => window.removeEventListener("floatphone-app-back", handleAppBack);
  }, [wallView, showAddMenu, showChatPicker, selectedPhotoId]);

  const scheduleSave = useCallback((_next: PhotoWallState) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      savePhotoWallState(stateRef.current);
      saveTimerRef.current = null;
    }, 200);
  }, []);

  // 关闭照片墙、切到后台或页面进入 pagehide 时，立即冲刷防抖保存。
  // 移动端后台计时器可能被挂起，不能只依赖 200ms timeout。
  useEffect(() => {
    const flushPendingSave = () => {
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      savePhotoWallState(stateRef.current);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPendingSave();
    };
    window.addEventListener("pagehide", flushPendingSave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushPendingSave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushPendingSave();
    };
  }, []);

  /** 统一落盘入口：先更新状态快照与 React 状态，再合并写盘。 */
  const commitPhotos = useCallback((nextPhotos: PhotoWallPhoto[]) => {
    const next: PhotoWallState = { ...stateRef.current, photos: nextPhotos };
    stateRef.current = next;
    setState(next);
    scheduleSave(next);
  }, [scheduleSave]);

  /** 结构性变更（扩画布）要立刻落盘，不能等防抖——否则一滚回去就又是旧世界。 */
  const applyImmediate = useCallback((next: PhotoWallState) => {
    stateRef.current = next;
    setState(next);
    savePhotoWallState(next);
  }, []);

  /* ── 撤销 / 重做 ──────────────────────────────────────────────
     只存引用快照：照片对象是不可变的，整墙涂鸦也是数组替换，
     所以一份快照几乎不占内存，不需要深拷贝，也不会复制媒体数据。 */
  type WallSnapshot = { photos: PhotoWallPhoto[]; wallDoodles?: PhotoWallDoodle[]; world: PhotoWallWorld };
  const historyRef = useRef<WallSnapshot[]>([]);
  const futureRef = useRef<WallSnapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const snapshotOf = useCallback((source: PhotoWallState): WallSnapshot => ({
    photos: source.photos,
    wallDoodles: source.wallDoodles,
    world: wallWorldOf(source),
  }), []);
  const pushHistory = useCallback((source: PhotoWallState) => {
    historyRef.current.push(snapshotOf(source));
    if (historyRef.current.length > 80) historyRef.current.shift();
    futureRef.current = [];
    setHistoryVersion(value => value + 1);
  }, [snapshotOf]);
  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    const current = stateRef.current;
    futureRef.current.push(snapshotOf(current));
    applyImmediate({ ...current, photos: previous.photos, wallDoodles: previous.wallDoodles, world: previous.world });
    setHistoryVersion(value => value + 1);
  }, [applyImmediate, snapshotOf]);
  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    const current = stateRef.current;
    historyRef.current.push(snapshotOf(current));
    applyImmediate({ ...current, photos: next.photos, wallDoodles: next.wallDoodles, world: next.world });
    setHistoryVersion(value => value + 1);
  }, [applyImmediate, snapshotOf]);
  const canUndo = historyRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void historyVersion; // 快照栈变化时触发一次重渲染，好让按钮的禁用态跟上

  /**
   * 向左/向上扩容时补偿滚动。
   * 必须等到 React 把新的画布尺寸刷进 DOM 之后再改 scrollLeft——
   * 提前改会被浏览器按旧的 scrollWidth 夹回去，画面就跳了。
   */
  const compensateViewportScroll = useCallback((grow: WorldGrow) => {
    const zoom = panoramaZoomRef.current / 100;
    if (!grow.left && !grow.top) return;
    pendingScrollRef.current = { left: grow.left * zoom, top: grow.top * zoom };
  }, []);
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    const viewport = panoramaViewportRef.current;
    if (!viewport) return;
    if (pending.left) viewport.scrollLeft += pending.left;
    if (pending.top) viewport.scrollTop += pending.top;
  });

  /**
   * 拖动/缩放/旋转：只改这一张照片的摆放，位置用 0~1 比例存，换屏幕不会错位。
   * 注意这里**不扩容**——拖动中途改世界尺寸会让画布的拖拽基准失效，照片会跳。
   */
  const changePlacement = useCallback((photoId: string, placement: PhotoWallPlacement) => {
    commitPhotos(stateRef.current.photos.map(photo => photo.id === photoId ? { ...photo, placement } : photo));
  }, [commitPhotos]);

  /**
   * 松手后判一次扩容：落点贴到世界外圈就往那一侧扩。
   * 扩容把所有比例按像素重算 + 补偿滚动，所以照片和涂鸦在屏幕上不动，
   * 只是可滚动范围变大——「无限画布」就是这一步攒出来的。
   */
  const settlePlacement = useCallback((photoId: string, placement: PhotoWallPlacement) => {
    const current = stateRef.current;
    const grow = planWorldGrow(wallWorldOf(current), [{ x: placement.x, y: placement.y }]);
    if (!grow) return;
    const grown = applyWorldGrow(current, grow);
    compensateViewportScroll(grow);
    applyImmediate({
      ...grown,
      photos: grown.photos.map(photo => photo.id === photoId ? { ...photo, placement: remapPlacement(placement, grow) } : photo),
    });
  }, [applyImmediate, compensateViewportScroll]);

  /** 相框级涂鸦层：笔迹与贴纸跟着照片一起存。 */
  const changeDoodles = useCallback((photoId: string, doodles: PhotoWallDoodle[]) => {
    pushHistory(stateRef.current);
    commitPhotos(stateRef.current.photos.map(photo => photo.id === photoId ? { ...photo, doodles } : photo));
  }, [commitPhotos, pushHistory]);

  /** 套用模板骨架：照片按顺序吸附进槽位，套完仍然可以自由拖动。 */
  const applyTemplate = useCallback((templateId: string) => {
    const current = stateRef.current;
    const ordered = current.photos.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!ordered.length) { onNotice?.("墙上还没有照片。"); return; }
    const slots = buildTemplateSlots(templateId, ordered.length, templateText);
    if (!slots.length) return;
    commitPhotos(current.photos.map(photo => {
      const index = ordered.findIndex(item => item.id === photo.id);
      const slot = slots[index % slots.length];
      if (!slot) return photo;
      const base = photo.placement;
      return { ...photo, placement: { x: slot.x, y: slot.y, scale: slot.scale, rotation: slot.rotation, z: index + 1, frame: base?.frame ?? "polaroid", locked: base?.locked ?? false, frameColor: base?.frameColor ?? "#fffdf8" } as PhotoWallPlacement };
    }));
    setActiveTemplateId(templateId);
    try { window.localStorage.setItem(PHOTO_WALL_ACTIVE_TEMPLATE_KEY, templateId); } catch { /* current placements remain saved */ }
    onNotice?.("已按模板重新摆放；新照片也会沿用这个摆放轨迹。");
    setWallView("edit");
  }, [commitPhotos, onNotice, templateText]);

  /** 将当前墙面坐标保存为可重复使用的自定义模板。 */
  const saveCurrentLayoutAsTemplate = useCallback(() => {
    const current = stateRef.current;
    if (!current.photos.length) { onNotice?.("先放入几张照片，再保存摆放模板。"); return; }
    const name = templateName.trim();
    if (!name) { onNotice?.("请先给这个模板起个名字。"); return; }
    const ordered = current.photos.slice().sort((a, b) => (a.placement?.z ?? 0) - (b.placement?.z ?? 0));
    const slots = ordered.map((photo, index) => {
      const placement = photo.placement ?? fallbackPlacement(index);
      return { x: placement.x, y: placement.y, scale: placement.scale, rotation: placement.rotation };
    });
    const template: PhotoWallTemplate = { id: createPhotoWallId(), name: name.slice(0, 32), builtin: false, slots };
    const next = [...customTemplates.filter(item => item.id !== template.id), template].slice(-40);
    saveCustomTemplates(next);
    setCustomTemplates(next);
    setTemplateName("");
    onNotice?.("已保存模板「" + template.name + "」，之后可以重复套用。");
  }, [customTemplates, onNotice, templateName]);

  const deleteCustomTemplate = useCallback((templateId: string) => {
    const next = customTemplates.filter(item => item.id !== templateId);
    saveCustomTemplates(next);
    setCustomTemplates(next);
    if (editingTemplateId === templateId) setEditingTemplateId(null);
    onNotice?.("已删除自定义摆放模板。");
  }, [customTemplates, editingTemplateId, onNotice]);

  const updateTemplateSlot = useCallback((templateId: string, slotIndex: number, key: "x" | "y" | "scale" | "rotation", value: number) => {
    if (!Number.isFinite(value)) return;
    const next = customTemplates.map(template => {
      if (template.id !== templateId) return template;
      const slots = template.slots.map((slot, index) => {
        if (index !== slotIndex) return slot;
        const limits = key === "x" || key === "y" ? [0.06, 0.94] : key === "scale" ? [0.35, 3] : [-45, 45];
        const bounded = Math.min(limits[1], Math.max(limits[0], value));
        return { ...slot, [key]: Math.round(bounded * 100) / 100 };
      });
      return { ...template, slots };
    });
    setCustomTemplates(next);
    saveCustomTemplates(next);
  }, [customTemplates]);

  /** 整墙导出 PNG：canvas 重绘，不受滚动位置和屏幕尺寸影响。 */
  const exportWall = async () => {
    if (exportBusy) return;
    const targets = photos;
    if (!targets.length) { onNotice?.("墙上还没有照片可以导出。"); return; }
    setExportBusy(true);
    try {
      const ok = await downloadPhotoWallPng(targets, { aspect: world.width / world.height });
      onNotice?.(ok ? "已开始下载整墙 PNG。" : "导出失败：没有生成有效图片。");
    } catch (error) { onNotice?.("导出失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setExportBusy(false); }
  };

  const persist = useCallback((next: PhotoWallState) => {
    // 必须同步快照：commitPhotos 依赖 stateRef 读最新状态，
    // 否则上传/保存背面后紧接着拖动会用旧快照把新照片覆盖掉。
    stateRef.current = next;
    setState(next);
    savePhotoWallState(next);
  }, []);
  const refreshCharacters = useCallback(() => {
    const list = loadCharacters();
    setCharacters(list);
    setSelectedCharacterId(current => list.some(char => char.id === current) ? current : list[0]?.id ?? "");
    setCharacterCommenterId(current => list.some(char => char.id === current) ? current : list[0]?.id ?? "");
  }, []);
  useEffect(() => {
    refreshCharacters();
    const refresh = () => {
      const next = loadPhotoWallState();
      stateRef.current = next;
      setState(next);
    };
    window.addEventListener("photo-wall-updated", refresh);
    window.addEventListener("characters-updated", refreshCharacters);
    return () => { window.removeEventListener("photo-wall-updated", refresh); window.removeEventListener("characters-updated", refreshCharacters); };
  }, [refreshCharacters]);

  const photos = useMemo(() => state.photos.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.photos]);
  const timelinePhotos = useMemo(() => {
    if (timelineRange === "all") return photos;
    const floor = new Date();
    if (timelineRange === "year") { floor.setMonth(0, 1); floor.setHours(0, 0, 0, 0); }
    else { floor.setDate(floor.getDate() - Number(timelineRange.slice(0, -1))); floor.setHours(0, 0, 0, 0); }
    return photos.filter(photo => {
      const at = new Date(photo.capturedAt || photo.createdAt);
      return Number.isFinite(at.getTime()) && at.getTime() >= floor.getTime();
    });
  }, [photos, timelineRange]);
  /**
   * 整墙涂鸦在「一笔画完」时才回调，所以在这里扩容是安全的：
   * 不会边画边改画布，也不会把正在画的那笔截断。
   */
  const changeWallDoodles = useCallback((wallDoodles: PhotoWallDoodle[]) => {
    const current = stateRef.current;
    pushHistory(current);
    const grow = planWorldGrow(wallWorldOf(current), wallDoodles.flatMap(doodle => doodle.points));
    if (!grow) {
      persist({ ...current, wallDoodles });
      return;
    }
    compensateViewportScroll(grow);
    applyImmediate({ ...applyWorldGrow(current, grow), wallDoodles: remapDoodles(wallDoodles, grow) });
  }, [applyImmediate, compensateViewportScroll, persist, pushHistory]);
  const visiblePhotos = useMemo(() => photos.filter(photo => {
    if (filter === "mine") return photo.ownerType === "user";
    if (filter === "characters") return photo.ownerType === "character";
    return true;
  }), [photos, filter]);
  const selectedPhoto = photos.find(photo => photo.id === selectedPhotoId) ?? null;
  const selectedCharacter = characters.find(char => char.id === selectedCharacterId) ?? null;
  const toggleTimelineFlip = (photoId: string) => setTimelineFlippedPhotoIds(current => { const next = new Set(current); if (next.has(photoId)) next.delete(photoId); else next.add(photoId); return next; });
  const commenter = characters.find(char => char.id === characterCommenterId) ?? characters[0] ?? null;

  /**
   * 新照片的落点：跟着你当前看到的位置走。
   * 无界画布变大了以后，如果还按模板的绝对坐标散落，新照片会掉到视野外，
   * 用户会以为"没加上"。默认（builtin-scatter）就落在视野中心附近；
   * 只有用户明确挑过别的骨架模板时，才按模板槽位摆放。
   */
  const placementAnchor = useCallback((): { x: number; y: number } => {
    const viewport = panoramaViewportRef.current;
    const current = wallWorldOf(stateRef.current);
    const zoom = Math.max(0.05, panoramaZoomRef.current / 100);
    if (!viewport || !viewport.clientWidth) return { x: 0.5, y: 0.5 };
    const x = (viewport.scrollLeft + viewport.clientWidth / 2) / Math.max(1, current.width * zoom);
    const y = (viewport.scrollTop + viewport.clientHeight / 2) / Math.max(1, current.height * zoom);
    return { x: Math.min(0.9, Math.max(0.1, x)), y: Math.min(0.9, Math.max(0.1, y)) };
  }, []);

  const addPhoto = useCallback((photo: PhotoWallPhoto) => {
    const current = loadPhotoWallState();
    pushHistory(current);
    const order = current.photos.length;
    const explicitTemplate = Boolean(activeTemplateId) && activeTemplateId !== "builtin-scatter";
    const slot = explicitTemplate ? buildTemplateSlots(activeTemplateId, order + 1, templateText)[order] : undefined;
    const anchor = placementAnchor();
    const jitter = ((order % 5) - 2) * 0.018;
    const maxZ = current.photos.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
    const x = slot ? slot.x : Math.min(0.92, Math.max(0.08, anchor.x + jitter));
    const y = slot ? slot.y : Math.min(0.92, Math.max(0.08, anchor.y + jitter));
    const placed = { ...photo, placement: photo.placement ?? { x, y, scale: slot?.scale ?? 1, rotation: slot?.rotation ?? Math.round(jitter * 300), z: maxZ + 1, frame: "polaroid" as const, frameColor: "#fffdf8" } };
    persist({ ...current, photos: [placed, ...current.photos.filter(item => item.id !== photo.id)] });
    setSelectedPhotoId(photo.id);
  }, [persist, activeTemplateId, templateText, placementAnchor]);

  const openChatPicker = async () => {
    setShowAddMenu(false);
    setBusy(true); setBusyLabel("正在翻找聊天里珍藏的照片…");
    try {
      const candidates: Array<{ key: string; ref: string; title: string; sessionName: string; createdAt: string }> = [];
      for (const session of loadChatSessions()) {
        for (const message of loadChatMessages(session.id)) {
          const imageMessage = message.mediaType === "image" || (message.mediaType === "media_file" && message.mediaData?.fileType === "image");
          const refs = [message.mediaUrl, ...(Array.isArray(message.mediaData?.imageRefs) ? message.mediaData.imageRefs as string[] : [])];
          if (!imageMessage && !refs.some(ref => typeof ref === "string" && (ref.startsWith("media-store://") || ref.startsWith("data:image/")))) continue;
          for (const [index, ref] of refs.entries()) {
            if (typeof ref !== "string" || !(ref.startsWith("media-store://") || ref.startsWith("data:image/") || /^https?:\/\//i.test(ref))) continue;
            candidates.push({
              key: `${message.id}-${index}-${ref.slice(0, 32)}`, ref,
              title: message.content?.trim().slice(0, 48) || "聊天里的照片",
              sessionName: session.groupName || session.alias || session.contactId || session.id,
              createdAt: message.createdAt,
            });
          }
        }
      }
      const unique = candidates.filter((item, index, all) => all.findIndex(other => other.ref === item.ref) === index).slice(-120).reverse();
      setChatCandidates(unique);
      setShowChatPicker(true);
      if (!unique.length) onNotice?.("还没有找到可收藏的聊天图片。");
    } catch (error) { onNotice?.("读取聊天照片失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const importChatPhoto = async (candidate: { key: string; ref: string; title: string; sessionName: string; createdAt: string }) => {
    setBusy(true); setBusyLabel("正在把这张聊天照片收进照片墙…");
    try {
      let mediaRef = candidate.ref;
      if (!mediaRef.startsWith("media-store://")) {
        const response = await fetch(mediaRef);
        if (!response.ok) throw new Error("图片读取失败");
        const blob = await response.blob();
        mediaRef = await storeMediaBlob(blob, blob.type || "image/jpeg", "image");
      }
      const photo: PhotoWallPhoto = {
        id: createPhotoWallId(), mediaRef, createdAt: new Date().toISOString(),
        capturedAt: candidate.createdAt, ownerType: "user", ownerName: "我", kind: "favorite",
        title: candidate.title || "聊天里的照片", caption: `来自聊天：${candidate.sessionName}`,
        backNote: "", tags: ["聊天收藏", candidate.sessionName], annotations: [], shareWithCharacters: true, source: "chat-favorite",
      };
      addPhoto(photo);
      setShowChatPicker(false);
      onNotice?.("已把聊天照片收藏到照片墙。");
    } catch (error) { onNotice?.("收藏聊天照片失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(file => file.type.startsWith("image/"));
    if (!list.length) { onNotice?.("请选择图片文件。"); return; }
    setBusy(true); setBusyLabel("正在把照片收进相册…");
    try {
      const created: PhotoWallPhoto[] = [];
      for (const file of list.slice(0, 20)) {
        const blob = await optimizeUpload(file);
        const mime = blob.type || file.type || "image/jpeg";
        const ref = await storeMediaBlob(blob, mime, "image");
        created.push({
          id: createPhotoWallId(), mediaRef: ref, createdAt: new Date().toISOString(),
          ownerType: "user", ownerName: "我", kind: "favorite", title: file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "一张喜欢的照片",
          caption: "", backNote: "", tags: [], annotations: [], shareWithCharacters: true, source: "upload",
        });
      }
      const current = loadPhotoWallState();
      const maxZ = current.photos.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
      const slots = buildTemplateSlots(activeTemplateId, current.photos.length + created.length, templateText);
      const placedCreated = created.map((photo, index) => {
        const slot = slots[current.photos.length + index] ?? fallbackPlacement(current.photos.length + index);
        return { ...photo, placement: { ...slot, z: maxZ + index + 1, frame: "polaroid" as const, frameColor: "#fffdf8" } };
      });
      persist({ ...current, photos: [...placedCreated, ...current.photos] });
      setSelectedPhotoId(created[0]?.id ?? null);
      onNotice?.(`已收藏 ${created.length} 张照片。`);
    } catch (error) { onNotice?.("收藏失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const uploadCanvasBackground = async (file: File) => {
    if (!file.type.startsWith("image/")) { onNotice?.("背景需要是图片文件。"); return; }
    setBusy(true); setBusyLabel("正在设置画布背景…");
    let newRef = "";
    try {
      const blob = await optimizeUpload(file);
      newRef = await storeMediaBlob(blob, blob.type || file.type || "image/jpeg", "image");
      const current = stateRef.current;
      const oldRef = current.wallBackgroundRef;
      persist({ ...current, wallBackgroundRef: newRef });
      if (oldRef && oldRef !== newRef) void deleteMediaRef(oldRef);
      onNotice?.("画布背景已保存。");
    } catch (error) {
      if (newRef) await deleteMediaRef(newRef).catch(() => undefined);
      onNotice?.("设置背景失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { setBusy(false); setBusyLabel(""); }
  };

  const clearCanvasBackground = () => {
    const oldRef = stateRef.current.wallBackgroundRef;
    persist({ ...stateRef.current, wallBackgroundRef: undefined });
    if (oldRef) void deleteMediaRef(oldRef);
    onNotice?.("已移除画布背景，照片和涂鸦不会受影响。");
  };

  const generatePhoto = async (owner: Character | null, kind: PhotoWallPhoto["kind"], daily = false) => {
    if (busy) return;
    if (!owner) { onNotice?.("请先导入至少一张角色卡。"); return; }
    setBusy(true); setBusyLabel(daily ? "角色正在把今天的片刻留进照片墙…" : "正在显影这张照片…");
    try {
      const life = loadVirtualLifeState();
      const recent = life.timeline
        .filter(entry => {
          const at = Date.parse(entry.occurredAt);
          return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at < 7 * DAY_MS;
        })
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, 24);
      const belongsToCharacter = (entry: typeof recent[number]) => !entry.actorId || entry.actorId === owner.id;
      const warmMoment = recent.find(entry => belongsToCharacter(entry) && /开心|幸福|温暖|陪伴|拥抱|约会|惊喜|庆祝|一起|喜欢|安心|成功|完成|笑|礼物|咖啡|晚餐|散步|旅行|纪念/.test([entry.title, entry.details || ""].join(" ")));
      const event = warmMoment ?? recent.find(belongsToCharacter) ?? recent[0];
      const eventText = event
        ? `优先把这段真实生活片段转化成值得珍藏的照片：${event.title}${event.locationName ? `，地点是${event.locationName}` : ""}${event.details ? `。细节：${event.details}` : ""}。如果它带有温暖、幸福、亲密、轻松或小小成就的情绪，请抓住这种感觉；不必把事件逐字画出来，也不要凭空制造重大剧情。`
        : "没有明确的近期事件，请描绘一个自然、温暖、安静、可信的小日常，优先呈现陪伴、轻松或小确幸，不要凭空制造重大剧情。";
      const kindPrompt: Record<PhotoWallPhoto["kind"], string> = {
        favorite: "角色自己珍藏的一张照片，带有私人的情绪和生活痕迹。",
        selfie: "角色自然随手拍下的自拍，不摆拍，像发给亲近之人的私密日常。",
        candid: "从角色视角拍下用户不经意的生活瞬间，温柔、尊重、不带窥视或性化意味；没有用户参考图时，不要擅自编造清晰且具体的用户外貌。",
        scenery: "角色很喜欢的一处风景，带有真实摄影质感与个人审美。",
        object: "一件让角色想起用户的小物件、食物、书页或窗边光线。",
        moment: "一张像共同回忆的生活照片，强调温暖细节而非戏剧性。",
      };
      let referenceImageDataUrl: string | undefined;
      const refPhoto = referencePhotoId ? state.photos.find(photo => photo.id === referencePhotoId) : undefined;
      if (refPhoto) {
        const stored = await loadMediaBlob(refPhoto.mediaRef);
        if (stored) referenceImageDataUrl = await blobToDataUrl(stored.blob);
      } else if (kind === "candid" || kind === "moment") {
        // These photo types may depict the player, so use the player's global
        // reference and the character's own reference together when available.
        const imageSettings = loadImageGenerationSettings();
        const sources: Array<{ label: string; dataUrl: string; crop?: { x: number; y: number; size: number } }> = [];
        if (imageSettings.userAppearanceReferenceAssetId) {
          const dataUrl = await getChatImageFromIndexedDB(imageSettings.userAppearanceReferenceAssetId);
          if (dataUrl) sources.push({ label: "玩家本人", dataUrl, crop: imageSettings.userAppearanceFaceCrop });
        }
        const characterReference = imageSettings.characterReferences?.[owner.id];
        if (characterReference?.assetId && characterReference.enabled !== false) {
          const dataUrl = await getChatImageFromIndexedDB(characterReference.assetId);
          if (dataUrl) sources.push({ label: owner.name, dataUrl, crop: characterReference.faceCrop });
        }
        referenceImageDataUrl = await composePhotoReferenceSheet(sources);
      }
      const referenceText = referenceImageDataUrl
        ? (kind === "candid" || kind === "moment"
          ? "请参考图中标注的玩家本人和角色外观，分别保持身份特征一致；参考图只用于人物身份，不要复制原图构图。"
          : "请严格参考提供的参考照片中可见人物/物件的视觉特征，保持一致，不要复制原图构图。")
        : "";
      const description = (generationPromptTemplate.trim() || DEFAULT_PHOTO_WALL_PROMPT)
        .split("{characterName}").join(owner.name)
        .split("{characterPersona}").join((owner.persona || owner.personality || "").slice(0, 700))
        .split("{photoType}").join(kindPrompt[kind])
        .split("{lifeEvent}").join(eventText)
        .split("{referenceText}").join(referenceText);
      const result = await generateImageFromConfiguredApi({
        description, characterId: owner.id, appId: "photo_wall",
        useReferenceImage: Boolean(referenceImageDataUrl) || kind === "selfie",
        referenceImageDataUrl,
      });
      if (!result) throw new Error("没有可用的生图方案。请在系统设置中启用并配置图片生成服务。");
      const title = kind === "selfie" ? `${owner.name}的今日自拍` : kind === "candid" ? "你不经意的样子" : kind === "scenery" ? "路过的好天气" : kind === "object" ? "想起你的东西" : kind === "moment" ? "想留住的瞬间" : `${owner.name}的私藏`;
      const photo: PhotoWallPhoto = {
        id: createPhotoWallId(), mediaRef: result.mediaRef, createdAt: new Date().toISOString(),
        ownerType: "character", ownerId: owner.id, ownerName: owner.name, kind,
        title, caption: event?.title ? `记在这里：${event.title}` : "有些瞬间没有特别的理由，只是想留住。",
        backNote: "", tags: [KIND_LABEL[kind]], annotations: [], shareWithCharacters: true,
        referencePhotoId: refPhoto?.id, generationPrompt: result.prompt, source: event ? "life-event" : "generated",
      };
      addPhoto(photo);
      onNotice?.(`${owner.name}把一张照片放进了照片墙。`);
      return photo;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (daily) {
        const current = loadPhotoWallState();
        persist({ ...current, settings: { ...current.settings, lastDailyGenerationError: message } });
      }
      onNotice?.("生成照片失败：" + message);
      return null;
    } finally { setBusy(false); setBusyLabel(""); }
  };

  const runDailyGeneration = useCallback(async () => {
    if (autoRunRef.current || busy) return;
    const current = loadPhotoWallState();
    const today = dayKey();
    if (!current.settings.dailyGenerationEnabled || current.settings.lastDailyGenerationDay === today || characters.length === 0) return;
    autoRunRef.current = true;
    const count = current.settings.dailyPhotoCount;
    let generated = 0;
    try {
      for (let index = 0; index < count; index += 1) {
        const fresh = loadPhotoWallState();
        const owner = characters[(new Date().getDate() + index) % characters.length];
        const kinds: PhotoWallPhoto["kind"][] = ["selfie", "candid", "scenery", "object", "moment"];
        const kind = kinds[(new Date().getDate() + index * 2) % kinds.length];
        const result = await generatePhoto(owner, kind, true);
        if (!result) break;
        generated += 1;
        if (index < count - 1) await new Promise(resolve => window.setTimeout(resolve, 900));
      }
      const fresh = loadPhotoWallState();
      persist({ ...fresh, settings: { ...fresh.settings, lastDailyGenerationDay: generated ? today : fresh.settings.lastDailyGenerationDay, lastDailyGenerationAt: generated ? new Date().toISOString() : fresh.settings.lastDailyGenerationAt, lastDailyGenerationError: generated ? undefined : fresh.settings.lastDailyGenerationError } });
      if (generated) onNotice?.(`今日照片已显影：${generated} 张。`);
    } finally { autoRunRef.current = false; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters, persist, state.settings.dailyGenerationEnabled, state.settings.dailyPhotoCount]);

  useEffect(() => {
    if (!state.settings.dailyGenerationEnabled || characters.length === 0) return;
    const timer = window.setTimeout(() => { void runDailyGeneration(); }, 1600);
    return () => window.clearTimeout(timer);
  }, [state.settings.dailyGenerationEnabled, state.settings.dailyPhotoCount, state.settings.lastDailyGenerationDay, characters.length, runDailyGeneration]);

  const saveBack = () => {
    if (!selectedPhoto) return;
    const currentState = stateRef.current;
    const latestPhoto = currentState.photos.find(photo => photo.id === selectedPhoto.id) ?? selectedPhoto;
    const nextPhoto = { ...latestPhoto, title: editTitle.trim() || "未命名的瞬间", backNote: editNote, annotations: [], tags: editTags.split(/[,，#\n]/).map(tag => tag.trim()).filter(Boolean).slice(0, 20) };
    persist({ ...currentState, photos: currentState.photos.map(photo => photo.id === nextPhoto.id ? nextPhoto : photo) });
    setPhotoViewOnly(true);
    onNotice?.("照片背面的内容已保存。");
  };

  const askCharacterToWrite = async () => {
    if (!selectedPhoto || !commenter || busy) return;
    setBusy(true); setBusyLabel(`${commenter.name}正在认真看这张照片…`);
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === commenter.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `photo-wall-${commenter.id}`, contactId: contact?.id ?? commenter.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-16);
      const instruction = [
        "你正在和亲近的人一起翻看一张私人照片墙。",
        `照片标题：${selectedPhoto.title}。`,
        `照片背面已有内容：${editNote || getPhotoBackText(selectedPhoto) || selectedPhoto.caption || "还没有写下记录"}。`,
        `标签：${selectedPhoto.tags.join("、") || "没有标签"}。`,
        `照片类型：${KIND_LABEL[selectedPhoto.kind]}；拍摄者：${selectedPhoto.ownerName}。`,
        "请以角色本人的口吻写一条自然、具体、真诚的短批注，像在照片背面留下的一句话。不要解释任务，不要说自己是AI，最多80个汉字。若照片内容信息不足，不要编造看不见的细节。",
      ].join("\n");
      const promptMessage: ChatMessage = {
        id: createPhotoWallId(), sessionId: session.id, role: "user", content: instruction,
        status: "sent", createdAt: new Date().toISOString(),
      };
      const storedPhoto = await loadMediaBlob(selectedPhoto.mediaRef).catch(() => null);
      const attachedImages = storedPhoto ? [await readCompressedImageDataUrl(storedPhoto.blob)] : [];
      const result = await generateChatCompletion(session, [...history, promptMessage], {
        appId: "photo_wall", appTags: ["photo_wall"], toolsAllowed: false,
        attachedImages,
        ephemeralSystemNote: "这是照片墙上的一次性批注请求。若当前模型支持视觉识别，请结合附带的照片本身来写批注；如果没有读取到图片，不要猜测画面细节。只输出角色会写在照片背面的简短批注，不要调用工具，也不要将任务说明复述出来。",
      });
      const content = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
      if (!content) throw new Error("角色没有生成批注，请稍后再试。");
      const fresh = loadPhotoWallState();
      const existing = fresh.photos.find(photo => photo.id === selectedPhoto.id) ?? selectedPhoto;
      const baseText = editNote.trim() || getPhotoBackText(existing);
      const nextBackNote = [baseText, `${commenter.name}：${content}`].filter(Boolean).join("\n\n");
      persist({ ...fresh, photos: fresh.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, backNote: nextBackNote, annotations: [] } : photo) });
      setEditNote(nextBackNote);
      setPhotoViewOnly(false);
      onNotice?.(`${commenter.name}已经把一句话写进照片背面。`);
    } catch (error) { onNotice?.("请角色写批注失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const deleteSelectedPhoto = async () => {
    if (!selectedPhoto || !window.confirm("确定把这张照片从照片墙移除吗？这会删除图片文件，但不会删除其他照片或聊天记录。")) return;
    try {
      const currentState = stateRef.current;
      const ref = selectedPhoto.mediaRef;
      const sharedByAnotherPhoto = currentState.photos.some(photo => photo.id !== selectedPhoto.id && photo.mediaRef === ref);
      pushHistory(currentState);
      persist({ ...currentState, photos: currentState.photos.filter(photo => photo.id !== selectedPhoto.id) });
      // Chat favorites intentionally share the original media ref with the chat.
      // Never delete a shared blob when removing only its photo-wall card.
      if (!sharedByAnotherPhoto && selectedPhoto.source !== "chat-favorite") await deleteMediaRef(ref);
      setSelectedPhotoId(null);
      onNotice?.("照片已移除。");
    } catch (error) { onNotice?.("移除失败：" + (error instanceof Error ? error.message : String(error))); }
  };

  const openPhoto = (photo: PhotoWallPhoto, viewOnly = true) => {
    setPhotoViewOnly(viewOnly);
    setSelectedPhotoId(photo.id); setEditTitle(photo.title); setEditNote(getPhotoBackText(photo)); setEditTags(photo.tags.join("、"));
  };

  return <div className="photo-wall-app pointer-events-auto isolate absolute inset-0 z-[1000] flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,#fffdf8_0%,#f4f0e7_58%,#e9e1d4_100%)] text-[#51483d]" style={{ fontFamily: '"Noto Serif SC", "Songti SC", serif' }}>
    <header
      className="relative z-10 flex shrink-0 items-center gap-3 border-b border-[#ded5c7]/80 bg-white/75 px-4 pb-3 shadow-[0_8px_28px_rgba(94,76,53,.06)] backdrop-blur-xl"
      style={{ paddingTop: "max(12px, var(--page-header-safe-top, 48px))" }}
    >
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (showAddMenu) setShowAddMenu(false); else if (showChatPicker) setShowChatPicker(false); else if (selectedPhotoId) setSelectedPhotoId(null); else if (wallView === "settings" || wallView === "timeline" || wallView === "memories") setWallView("edit"); else onClose(); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#ded5c7] bg-white/80 text-[#7b6a58] shadow-sm transition hover:-translate-y-0.5 hover:bg-white active:scale-95" aria-label="返回上一级"><ArrowLeft size={17}/></button>
      <div className="min-w-0 flex-1"><div className="whitespace-nowrap font-serif text-lg tracking-[.04em]">{wallView === "settings" ? "墙面与显影设置" : wallView === "memories" ? "全部记忆" : wallView === "timeline" ? "时间轴" : "照片墙"}</div><div className="mt-0.5 truncate whitespace-nowrap text-[10px] tracking-[.1em] text-[#a09380]">{wallView === "settings" ? "WALL & DEVELOPING" : `A LITTLE ARCHIVE OF US · ${photos.length} PHOTOS`}</div></div>
      {wallView === "edit" && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowAddMenu(false); setWallView("settings"); }} className="relative z-[1002] pointer-events-auto min-h-10 shrink-0 cursor-pointer touch-manipulation border-b border-[#bda28d] px-2 py-1 text-sm tracking-wider text-[#79545a] transition active:opacity-60">设置</button>}
      {wallView === "edit" && <button type="button" onClick={() => void exportWall()} disabled={exportBusy || !photos.length} className="grid h-10 w-10 shrink-0 place-items-center border border-[#d8c4b4] bg-[#fffaf2] text-[#795b52] disabled:opacity-40" aria-label="导出整墙 PNG"><Download size={16}/></button>}
      {wallView === "edit" && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowAddMenu(value => !value); }} className="relative z-[1002] pointer-events-auto grid h-10 w-10 shrink-0 cursor-pointer touch-manipulation place-items-center border border-[#d8c4b4] bg-[#fffaf2] text-[#87565b] transition active:scale-95" aria-label="添加照片"><Plus size={18}/></button>}
      {(wallView === "edit" || wallView === "memories" || wallView === "timeline") && <button type="button" onClick={() => void exportWall()} disabled={exportBusy || !photos.length} className="grid h-10 w-10 shrink-0 place-items-center border border-[#d8c4b4] bg-[#fffaf3]/80 text-[#795b52] disabled:opacity-40" aria-label="导出整墙 PNG"><Download size={17}/></button>}
      {(wallView === "memories" || wallView === "timeline") && <button type="button" onClick={() => setWallView("edit")} className="shrink-0 border-b border-[#bda28d] px-2 py-2 text-sm text-[#79545a]">编辑</button>}
      {wallView === "edit" && <span className="shrink-0 text-xs tracking-wide text-[#87565b]">画布</span>}
    </header>

    {wallView !== "settings" && <nav className="absolute bottom-0 left-0 right-0 z-20 flex shrink-0 items-center justify-center gap-7 border-t border-[#d8c4b4] bg-[#f8f0e6]/96 px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
      <button type="button" onClick={() => setWallView("edit")} className={`border-b-2 px-1 py-2 text-sm ${wallView==="edit"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>画布</button>
      <button type="button" onClick={() => setWallView("memories")} className={`border-b-2 px-1 py-2 text-sm ${wallView==="memories"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>全部记忆</button>
      <button type="button" onClick={() => setWallView("timeline")} className={`border-b-2 px-1 py-2 text-sm ${wallView==="timeline"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>时间轴</button>
    </nav>}
    {wallView === "edit" && showAddMenu && <div className="absolute right-3 z-30 w-[min(17rem,calc(100vw-1.5rem))] border border-[#d7c2b1] bg-[#fffaf2] p-1 shadow-[0_16px_44px_rgba(60,42,32,.22)]" style={{top:"calc(max(12px, var(--page-header-safe-top, 48px)) + 64px)"}}>
      <button onClick={() => { setShowAddMenu(false); fileRef.current?.click(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] last:border-b-0 hover:bg-[#f3e9df]"><ImagePlus size={17}/>收藏我的照片</button>
      <button onClick={() => { setShowAddMenu(false); void openChatPicker(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><Heart size={17}/>从聊天收藏照片</button>
      <button onClick={() => { setShowAddMenu(false); if (!selectedCharacter) { setWallView("settings"); onNotice?.("请先在「今日照片与生成设置」中明确选择要生成照片的角色。"); return; } void generatePhoto(selectedCharacter, "moment"); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><Sparkles size={17}/>请角色生成一张</button>
      <button onClick={() => { setShowAddMenu(false); wallBackgroundInputRef.current?.click(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><ImagePlus size={17}/>上传画布背景</button>
      {state.wallBackgroundRef && <button onClick={() => { setShowAddMenu(false); clearCanvasBackground(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#8f5a54] hover:bg-[#f3e9df]"><X size={17}/>移除当前背景</button>}
      <button onClick={() => { setShowAddMenu(false); setWallView("settings"); }} className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><Camera size={17}/>今日照片与生成设置</button>
    </div>}
    <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={event => { if (event.target.files) void uploadFiles(event.target.files); event.currentTarget.value = ""; }}/>
    <input ref={wallBackgroundInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadCanvasBackground(file); event.currentTarget.value = ""; }}/>

    <main className={wallView === "edit" ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto overscroll-contain"} style={{ paddingBottom: "calc(58px + env(safe-area-inset-bottom, 0px))" }}>
      {wallView === "settings" ? <div className="min-h-full bg-[#f5ede3] px-4 pb-10 pt-5 sm:px-7" style={{backgroundImage:"repeating-linear-gradient(0deg,rgba(122,84,68,.025) 0,rgba(122,84,68,.025) 1px,transparent 1px,transparent 5px)"}}>
        <div className="mx-auto max-w-3xl">
          <p className="text-[10px] tracking-[.24em] text-[#a18172]">A QUIET CORNER FOR YOUR WALL</p>
          <h1 className="mt-2 font-serif text-2xl font-normal text-[#503d38]">把墙面布置成你喜欢的样子</h1>
          <p className="mt-2 text-xs leading-6 text-[#8b7569]">模板只保存摆放骨架，不会覆盖照片内容；应用后仍可回到画布继续拖动、缩放和涂鸦。</p>
          <section className="mt-5 border-y border-[#d9c6b6] bg-[#fffaf2]/75 px-4 py-4 shadow-[0_8px_24px_rgba(83,55,39,.05)]">
            <div className="flex items-center justify-between gap-3"><h2 className="font-serif text-lg text-[#5a403b]">日常显影</h2><span className="text-[10px] tracking-[.12em] text-[#a18172]">DAILY DEVELOPING</span></div>
            <p className="mt-2 text-xs leading-6 text-[#8b7569]">每天首次打开照片墙时，可依据最近生活记录生成照片。仅在应用运行时触发；图片由你配置的生图服务生成，可能产生 API 费用。</p>
            <label className="mt-4 flex min-h-11 items-center justify-between gap-4 border-b border-[#eadfd3] py-3 text-sm text-[#5d4942]"><span>每日自动生成</span><input type="checkbox" checked={state.settings.dailyGenerationEnabled} onChange={event => persist({ ...state, settings: { ...state.settings, dailyGenerationEnabled: event.target.checked } })} className="h-4 w-4 accent-[#87565b]"/></label>
            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-[#eadfd3] py-3 text-sm text-[#5d4942]"><span>每天最多生成</span><select value={state.settings.dailyPhotoCount} onChange={event => persist({ ...state, settings: { ...state.settings, dailyPhotoCount: Number(event.target.value) as 1 | 2 | 3 } })} className="max-w-[45%] border-b border-[#d7c2b1] bg-transparent px-2 py-1 text-right"><option value={1}>1 张</option><option value={2}>2 张</option><option value={3}>3 张</option></select></div>
            <label className="mt-4 block text-xs text-[#8b7569]">让谁生成照片<select value={selectedCharacterId} onChange={event => { const value = event.target.value; setSelectedCharacterId(value); try { window.localStorage.setItem(PHOTO_WALL_CHARACTER_KEY, value); } catch { /* explicit selection still applies for this session */ } }} className="mt-2 w-full border-b border-[#d7c2b1] bg-transparent px-2 py-2 text-sm text-[#5d4942]"><option value="">请选择角色</option>{characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}</select></label>
            <label className="mt-4 block text-xs text-[#8b7569]">角色照片生成提示词（可编辑；支持 {`{characterName}`}、{`{characterPersona}`}、{`{photoType}`}、{`{lifeEvent}`}、{`{referenceText}`} 变量）<textarea value={generationPromptTemplate} onChange={event => setGenerationPromptTemplate(event.target.value)} rows={7} placeholder={DEFAULT_PHOTO_WALL_PROMPT} className="mt-2 w-full resize-y rounded-xl border border-[#e6dccd] bg-[#fcf9f2] p-3 text-xs leading-6 text-[#655647]"/></label>
            <div className="mt-2 flex gap-2"><button type="button" onClick={() => { try { window.localStorage.setItem(PHOTO_WALL_PROMPT_KEY, generationPromptTemplate); onNotice?.("角色照片生成提示词已保存，将用于下一次生成。"); } catch { onNotice?.("保存提示词失败，请检查本地存储空间。"); } }} className="rounded-xl bg-[#87565b] px-3 py-2 text-xs text-white">保存提示词</button><button type="button" onClick={() => setGenerationPromptTemplate(DEFAULT_PHOTO_WALL_PROMPT)} className="rounded-xl border border-[#d7c2b1] px-3 py-2 text-xs text-[#79545a]">恢复默认</button></div>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#eadfd3] py-3 text-xs"><span className="text-[#8b7569]">生成参考图</span><select value={referencePhotoId} onChange={event => setReferencePhotoId(event.target.value)} className="min-w-0 flex-1 border-b border-[#d7c2b1] bg-transparent px-2 py-2"><option value="">使用角色外观参考设置</option>{photos.map(photo => <option key={photo.id} value={photo.id}>{photo.title}</option>)}</select></div>
            {state.settings.lastDailyGenerationAt && <p className="mt-3 text-[11px] leading-5 text-[#93836e]">上次显影：{formatDate(state.settings.lastDailyGenerationAt)}{state.settings.lastDailyGenerationError ? ` · 上次有错误：${state.settings.lastDailyGenerationError}` : ""}</p>}
            <button disabled={busy || !selectedCharacter} onClick={() => void generatePhoto(selectedCharacter, "moment")} className="mt-4 border border-[#87565b] bg-[#87565b] px-4 py-2.5 text-xs tracking-wide text-[#fff8f0] disabled:opacity-50"><Sparkles size={13} className="mr-1 inline"/>现在生成一张</button>
          </section>
          <section className="mt-6 border-y border-[#d9c6b6] bg-[#fffaf2]/75 px-4 py-4">
            <div className="flex items-center justify-between gap-3"><h2 className="font-serif text-lg text-[#5a403b]">摆放模板</h2><span className="text-[10px] text-[#a18172]">LAYOUT STUDIES</span></div>
            <p className="mt-2 text-xs leading-5 text-[#8b7569]">选一个构图骨架，照片会按相对位置排列；原始照片与内容不会被删除。</p>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {listAllTemplates().map(template => <div key={template.id} className="min-w-0 border-b border-[#eadfd3] py-2.5">
                <button type="button" onClick={() => applyTemplate(template.id)} className="block w-full text-left font-serif text-sm leading-5 text-[#5d4942] hover:text-[#87565b]">{template.name}</button>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-[#9a8174]">
                  {!template.builtin && <><button type="button" onClick={() => setEditingTemplateId(current => current === template.id ? null : template.id)} className="underline decoration-[#d7c2b1] underline-offset-4" aria-label={"编辑模板骨架 " + template.name}>编辑骨架</button><button type="button" onClick={() => deleteCustomTemplate(template.id)} className="underline decoration-[#d7c2b1] underline-offset-4">删除</button></>}
                  {template.builtin && <span>内置模板</span>}
                </div>
              </div>)}
            </div>
            <div className="mt-4 flex items-center gap-2 border-t border-[#eadfd3] pt-4">
              <input value={templateText} onChange={event => setTemplateText(event.target.value.slice(0, 12))} placeholder="文字骨架内容，如 LOVE / 家" className="min-w-0 flex-1 border-b border-[#d7c2b1] bg-transparent px-1 py-2 text-sm text-[#5d4942] outline-none focus:border-[#87565b]"/>
              <button type="button" onClick={() => applyTemplate("builtin-text")} className="shrink-0 border border-[#d7c2b1] px-3 py-2 text-xs text-[#79545a]">排成这个字</button>
            </div>
            <div className="mt-3 flex flex-col gap-2 border-t border-[#eadfd3] pt-3 sm:flex-row">
              <input value={templateName} onChange={event => setTemplateName(event.target.value.slice(0, 32))} placeholder="给当前布局命名" className="min-w-0 flex-1 border-b border-[#d7c2b1] bg-transparent px-1 py-2 text-sm text-[#5d4942] outline-none focus:border-[#87565b]"/>
              <button type="button" onClick={saveCurrentLayoutAsTemplate} disabled={!photos.length} className="shrink-0 border border-[#d7c2b1] px-3 py-2 text-xs text-[#79545a] disabled:opacity-40"><Check size={12} className="mr-1 inline"/>保存当前布局为模板</button>
            </div>
            {editingTemplateId && customTemplates.find(template => template.id === editingTemplateId) && (() => { const template=customTemplates.find(item=>item.id===editingTemplateId)!; return <div className="mt-4 border-t border-[#d9c6b6] pt-4"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="font-serif text-sm text-[#5d4942]">编辑骨架 · {template.name}</p><p className="mt-1 text-[10px] leading-5 text-[#8b7569]">调整槽位相对位置、大小与倾斜角度。</p></div><button type="button" onClick={() => setEditingTemplateId(null)} aria-label="关闭骨架编辑" className="px-2 py-1 text-[#87565b]"><X size={13}/></button></div><div className="mt-3 max-h-56 space-y-3 overflow-y-auto pr-1">{template.slots.map((slot,index)=><div key={index} className="border-b border-[#eadfd3] pb-3"><div className="mb-2 text-[11px] text-[#8b7569]">照片槽位 {index+1}</div><div className="grid grid-cols-2 gap-x-3 gap-y-2">{([["x","横向",0.06,0.94,0.01],["y","纵向",0.06,0.94,0.01],["scale","大小",0.35,3,0.05],["rotation","旋转",-45,45,1]] as const).map(([key,label,min,max,step])=><label key={key} className="min-w-0 text-[10px] text-[#8f7c66]"><span className="mb-1 flex items-center justify-between gap-1"><span>{label}</span><span className="font-mono text-[#6d5b47]">{slot[key].toFixed(2)}</span></span><input type="range" min={min} max={max} step={step} value={slot[key]} onChange={event=>updateTemplateSlot(template.id,index,key,Number(event.target.value))} className="w-full accent-[#87565b]"/></label>)}</div></div>)}</div></div>; })()}
          </section>
        </div>
      </div> : wallView === "edit" ? <>
      <div className="mx-4 flex min-h-10 items-center justify-between border-b border-[#d9c6b6] px-1 py-2 sm:mx-7"><span className="font-serif text-sm tracking-wide text-[#5d4942]">在墙上，慢慢摆好这些瞬间</span><span className="text-[10px] text-[#a18172]">{visiblePhotos.length} 张 · 可拖动微调</span></div>




      <nav className="sticky top-0 z-10 flex min-h-11 items-center gap-5 overflow-x-auto border-b border-[#e4dbce]/80 bg-[#f7efe5]/95 px-4 py-2 sm:px-7">
        {([{id:"all",label:"全部照片"},{id:"mine",label:"我收藏的"},{id:"characters",label:"角色留下的"}] as {id:Filter;label:string}[]).map(item => <button key={item.id} onClick={() => setFilter(item.id)} className={`shrink-0 border-b-2 px-0.5 py-2 text-xs font-medium tracking-wide transition duration-200 ${filter===item.id?"border-[#87565b] text-[#87565b]":"border-transparent text-[#8d7e6b] hover:text-[#70434a]"}`}>{item.label}</button>)}
        <button onClick={() => void exportWall()} disabled={exportBusy || !photos.length} className="ml-auto flex shrink-0 items-center gap-1.5 border-b border-[#cbbba6] px-1 py-2 text-[11px] tracking-wider text-[#795b52] disabled:opacity-40"><Download size={13}/>{exportBusy ? "导出中…" : "导出 PNG"}</button>
      </nav>

      <section className="px-3 pb-12 pt-3 sm:px-6">
        <div className="mb-2 flex items-center justify-between gap-2 border-b border-[#e2d2c3] px-1 py-2">
          <p className="font-serif text-sm text-[#5d4942]">自由画布</p><span className="text-[10px] text-[#9b8774]">{visiblePhotos.length} 张照片</span>
        </div>
        {busy && <div className="mb-3 flex items-center gap-2 rounded-xl border border-[#e4d8c6] bg-[#faf7f0] px-3 py-2.5 text-xs text-[#83725d]"><LoaderCircle size={15} className="animate-spin"/>{busyLabel || "请稍候…"}</div>}



        {visiblePhotos.length
          ? <div ref={panoramaViewportRef} data-photo-wall-viewport className="h-full min-h-0 w-full overflow-auto overscroll-contain" style={{ WebkitOverflowScrolling: "touch", touchAction: "none", overscrollBehavior: "contain" }}><div style={{ width: world.width * panoramaZoom / 100, height: world.height * panoramaZoom / 100, minWidth: "1px", maxWidth: "none" }}><PhotoWallCanvas
              photos={visiblePhotos}
              selectedId={selectedPhotoId}
              onSelect={setSelectedPhotoId}
              onChangePlacement={changePlacement}
              onPlacementSettled={settlePlacement}
              onDragBegin={() => pushHistory(stateRef.current)}
              onUndo={undo}
              onRedo={redo}
              canUndo={canUndo}
              canRedo={canRedo}
              onChangeDoodles={changeDoodles}
              wallDoodles={state.wallDoodles ?? []}
              onChangeWallDoodles={changeWallDoodles}
               backgroundImage={wallBackgroundUrl}
              onOpenDetail={photo => openPhoto(photo)}
            /></div></div>
          : <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center"><div className="grid h-16 w-16 place-items-center rounded-full border border-[#ddd0bd] text-[#a0917d]"><Feather size={24}/></div><h2 className="mt-5 font-serif text-xl font-normal">这面墙还空着</h2><p className="mt-2 text-xs leading-6 text-[#968674]">先收藏一张你喜欢的照片。之后，角色也会把自己想珍藏的风景、自拍和生活片段慢慢放进来。</p><button onClick={() => fileRef.current?.click()} className="mt-5 rounded-full border border-[#b7a48c] px-5 py-2.5 text-xs tracking-wider text-[#786953]">收藏第一张照片</button></div>}
      </section>

      </> : wallView === "memories" ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-4 sm:px-7" style={{WebkitOverflowScrolling:"touch"}}>
        {photos.length ? <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map(photo => <article key={photo.id} className="min-w-0 border border-[#e3d3c1] bg-[#fffdf8] p-2 pb-3 shadow-[2px_5px_12px_rgba(70,55,40,.10)]">
            <PhotoThumbnail photo={photo} onOpen={() => openPhoto(photo)}/>
            <button type="button" onClick={() => openPhoto(photo)} className="mt-2 block w-full break-words text-center font-serif text-sm leading-5 text-[#655342]">{photo.title || "未命名的瞬间"}</button>
            <p className="mt-1 text-center text-[10px] tracking-wide text-[#a08c74]">{formatDate(photo.capturedAt || photo.createdAt)}</p>
          </article>)}
        </div> : <div className="grid min-h-[45dvh] place-items-center text-center text-[#8f806d]"><div><Feather size={28} className="mx-auto"/><p className="mt-3">还没有收录的回忆</p><button type="button" onClick={() => { setWallView("edit"); setShowAddMenu(true); }} className="mt-3 border-b border-[#bda28d] px-2 py-2 text-sm">添加第一张照片</button></div></div>}
      </div> : <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4 sm:px-7" style={{WebkitOverflowScrolling:"touch"}}>
        <div className="sticky top-0 z-20 mx-auto mb-4 flex max-w-2xl items-center gap-2 border-b border-[#d8c4b4] bg-[#f3eadc]/95 px-2 py-2 backdrop-blur"><span className="shrink-0 text-[11px] text-[#8b7665]">时间</span><select value={timelineRange} onChange={event => setTimelineRange(event.target.value as typeof timelineRange)} aria-label="筛选照片时间" className="min-w-0 flex-1 rounded-lg border border-[#d8c4b4] bg-[#fffaf1] px-3 py-2 text-xs text-[#6d5946]"><option value="all">全部时间</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="90d">最近 90 天</option><option value="year">今年</option></select><span className="shrink-0 text-[10px] text-[#a18e7a]">{timelinePhotos.length} 张</span></div>
        {timelinePhotos.length === 0 ? <div className="grid min-h-[55dvh] place-items-center text-center text-[#8f806d]"><div><Feather size={28} className="mx-auto"/><p className="mt-3">还没有收录的回忆</p><p className="mt-1 text-xs">进入编辑，添加第一张照片。</p></div></div> : <div className="mx-auto max-w-2xl space-y-4">
          {[...new Set([...timelinePhotos].sort((a,b)=>(b.capturedAt || b.createdAt).localeCompare(a.capturedAt || a.createdAt)).map(photo => { const date = new Date(photo.capturedAt || photo.createdAt); return Number.isNaN(date.getTime()) ? "未知时间" : `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,"0")}`; }))].map(group => {
            const items = timelinePhotos.filter(photo => { const date = new Date(photo.capturedAt || photo.createdAt); return (Number.isNaN(date.getTime()) ? "未知时间" : `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,"0")}`) === group; }).sort((a,b)=>(b.capturedAt || b.createdAt).localeCompare(a.capturedAt || a.createdAt));
            return <section key={group} className="relative pl-5 before:absolute before:bottom-0 before:left-1 before:top-8 before:w-px before:bg-[#d8c4ab]">
              <h2 className="sticky top-0 z-10 mb-3 border-b border-[#d8c4b4] bg-[#f3eadc]/95 px-1 py-2 font-serif text-base text-[#75624d] backdrop-blur">{group} <span className="mx-1 text-[#c4ad91]">｜</span><span className="text-sm">我们的时光</span></h2>
              <div className="space-y-3">{items.map((photo,index) => <article key={photo.id} className="relative border-l border-[#d5bba7] pl-4 pb-2 text-left">
                <span className="absolute -left-[5px] top-5 h-2 w-2 border border-[#b88c82] bg-[#f3eadc]"/>
                <div className="mx-auto max-w-[260px] border border-[#e3d3c1] bg-[#fffdf8] p-2 pb-4 shadow-[2px_5px_12px_rgba(70,55,40,.13)]">
                  {timelineFlippedPhotoIds.has(photo.id) ? (
                    <button type="button" onClick={() => toggleTimelineFlip(photo.id)} aria-label="翻回照片正面" className="flex aspect-square w-full flex-col overflow-y-auto bg-[#fffaf2] p-4 text-left text-[#6b5947]">
                      <div className="border-b border-[#dfcfbe] pb-2 text-[9px] tracking-[.2em] text-[#a58f77]">THE BACK · 照片背面</div>
                      <h3 className="mt-3 break-words font-serif text-base leading-6">{photo.title || "未命名的瞬间"}</h3>
                      <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-6">{photo.backNote?.trim() || "这张照片的背面还空着。你可以打开详情，为它写下一段手记。"}</p>
                      {photo.caption && <p className="mt-3 border-t border-[#e8dccd] pt-2 text-[11px] leading-5 text-[#8d7a65]">照片说明：{photo.caption}</p>}
                      {photo.annotations.length > 0 && <div className="mt-3 border-t border-[#e8dccd] pt-2">{photo.annotations.map(note=><p key={note.id} className="mt-1 break-words text-xs leading-5">「{note.content}」<span className="ml-1 text-[10px] text-[#b29b88]">— {note.authorName}</span></p>)}</div>}
                      <span className="mt-auto pt-3 text-center text-[10px] text-[#aa927d]">点击卡片翻回正面</span>
                    </button>
                  ) : (
                    <>
                      <div className="overflow-hidden bg-[#e9dfd0]"><PhotoThumbnail photo={photo} onOpen={() => toggleTimelineFlip(photo.id)} /></div>
                      <button type="button" onClick={() => toggleTimelineFlip(photo.id)} className="mt-2 block w-full text-center font-serif text-sm leading-5 text-[#655342]">{photo.title || "未命名的瞬间"}</button>
                      {photo.caption && <p className="mt-1 whitespace-pre-wrap text-center font-serif text-xs leading-5 text-[#8d7a65]">{photo.caption}</p>}
                      {photo.tags.length > 0 && <p className="mt-2 text-center text-[10px] tracking-wide text-[#a18172]">{photo.tags.map(tag => "#" + tag).join("　")}</p>}
                      <p className="mt-2 text-center text-[10px] tracking-wide text-[#b29b88]">点击照片翻面，查看背面的手记与留言</p>
                    </>
                  )}
                  <button type="button" onClick={() => openPhoto(photo)} className="mt-3 block w-full rounded-lg border border-[#d8c4af] px-3 py-2 text-xs text-[#795b52]">查看大图 / 编辑</button>
                  <p className="mt-2 text-center text-[10px] tracking-wider text-[#a08c74]">{formatDate(photo.capturedAt || photo.createdAt)}</p>
                </div>
              </article>)}</div>
            </section>;
          })}
        </div>}
      </div>}
    </main>

    {showChatPicker && <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#332c24]/40 p-4 backdrop-blur-sm" onClick={() => setShowChatPicker(false)}>
      <section className="flex max-h-[82%] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-[#e3d7c6] bg-[#fffaf1] shadow-xl" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-[#e3d7c6] px-4 py-3"><div><h2 className="font-serif text-lg">从聊天里挑一张</h2><p className="mt-1 text-[10px] text-[#9b8a75]">收藏会保留原图，不会把同一张媒体重复复制</p></div><button onClick={() => setShowChatPicker(false)} aria-label="关闭"><X size={17}/></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {chatCandidates.length ? <div className="space-y-2">{chatCandidates.map(candidate => <button key={candidate.key} onClick={() => void importChatPhoto(candidate)} className="flex w-full items-center gap-3 rounded-xl border border-[#e6dccd] bg-[#fcf9f2] p-3 text-left hover:bg-white"><ChatCandidateThumb refId={candidate.ref}/><span className="min-w-0 flex-1"><span className="block truncate text-sm text-[#655647]">{candidate.title}</span><span className="mt-1 block truncate text-[10px] text-[#9a8973]">{candidate.sessionName} · {new Date(candidate.createdAt).toLocaleDateString("zh-CN")}</span></span><Plus size={15} className="shrink-0 text-[#87565b]"/></button>)}</div> : <p className="py-10 text-center text-xs text-[#9a8973]">没有找到可收藏的照片。</p>}
        </div>
      </section>
    </div>}

    {selectedPhoto && <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#332c24]/48 p-3 backdrop-blur-md" onClick={() => setSelectedPhotoId(null)}>
      <div className="relative flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-[20px] border border-white/70 bg-[#fffaf1] shadow-[0_24px_80px_rgba(20,15,10,.28)] sm:flex-row" onClick={event => event.stopPropagation()}>
        <button onClick={() => setSelectedPhotoId(null)} className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-[#f7f2e8]/90 text-[#7c6b58]" aria-label="关闭"><X size={16}/></button>
        <div className="flex h-[34dvh] max-h-[34dvh] min-h-[140px] shrink-0 items-center justify-center overflow-hidden bg-[#e7dfd2] p-2 sm:h-auto sm:max-h-none sm:min-h-0 sm:w-1/2">
          <PhotoLarge refId={selectedPhoto.mediaRef} title={selectedPhoto.title}/>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-5 pt-6 sm:px-6 sm:pt-8" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="text-[10px] tracking-[.25em] text-[#aa987f]">{selectedPhoto.ownerName.toUpperCase()} · {KIND_LABEL[selectedPhoto.kind]}</div>
          {photoViewOnly ? <h2 className="mt-3 font-serif text-xl text-[#5b4d3e]">{selectedPhoto.title || "未命名的瞬间"}</h2> : <input value={editTitle} onChange={event => setEditTitle(event.target.value)} className="mt-3 w-full border-b border-[#dfd3c1] bg-transparent pb-2 font-serif text-xl text-[#5b4d3e] outline-none focus:border-[#9e8b70]" placeholder="给这张照片起个名字"/>}
          <p className="mt-2 text-[10px] tracking-wider text-[#a39583]">{formatDate(selectedPhoto.createdAt)}</p>
          {photoViewOnly && <button type="button" onClick={() => { setPhotoViewOnly(false); setEditTitle(selectedPhoto.title); setEditNote(getPhotoBackText(selectedPhoto)); setEditTags(selectedPhoto.tags.join("、")); }} className="mt-3 self-start rounded-full border border-[#cbbba6] px-3 py-2 text-xs text-[#796952]">编辑这张照片</button>}
          <div className="mt-5 border-t border-[#e3d7c6] pt-3 font-serif text-base text-[#655342]">照片背面 · 手记与留言</div>
          {photoViewOnly ? <p className="mt-2 whitespace-pre-wrap rounded-sm bg-[#fcf9f2] p-3 font-serif text-sm leading-6 text-[#655647]">{getPhotoBackText(selectedPhoto) || selectedPhoto.caption || "还没有写下手记或留言。"}</p> : <textarea value={editNote} onChange={event => setEditNote(event.target.value)} rows={7} placeholder="把手记、你留下的话和角色回应都写在这里；它们共用这张照片的背面。" className="mt-2 w-full resize-y rounded-sm border border-[#e6dccd] bg-[#fcf9f2] p-3 font-serif text-sm leading-6 text-[#655647] outline-none placeholder:text-[#c1b5a4] focus:border-[#b5a18a]"/>}
          <label className="mt-3 block text-[10px] tracking-[.2em] text-[#9a8973]">标签 · TAGS</label>
          {photoViewOnly ? <p className="mt-2 text-xs text-[#8d7a65]">{selectedPhoto.tags.length ? selectedPhoto.tags.map(tag => `#${tag}`).join("　") : "暂无标签"}</p> : <input value={editTags} onChange={event => setEditTags(event.target.value)} placeholder="用逗号分隔，比如：雨天、回家、幸福" className="mt-2 w-full rounded-sm border border-[#e6dccd] bg-[#fcf9f2] px-3 py-2 text-xs outline-none focus:border-[#b5a18a]"/>}
          {!photoViewOnly && <><label className="mt-3 flex items-center gap-2 text-xs text-[#857460]"><input type="checkbox" checked={selectedPhoto.shareWithCharacters} onChange={event => { const currentState = stateRef.current; persist({ ...currentState, photos: currentState.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, shareWithCharacters: event.target.checked } : photo) }); }} className="accent-[#87565b]"/>允许角色看到这张照片及背面记录</label>
          <div className="mt-4 flex gap-2"><button onClick={saveBack} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#87565b] px-3 py-2.5 text-xs tracking-wider text-white"><Check size={14}/>保存背面</button><button onClick={() => void deleteSelectedPhoto()} className="grid h-10 w-10 place-items-center rounded-full border border-[#e3d7c6] text-[#9c7566]" aria-label="删除照片"><Trash2 size={15}/></button></div></>}
          {!photoViewOnly && <div className="mt-4 rounded-xl bg-[#eee7db] p-3">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-[#85745f]">请角色也来看看</span><select value={characterCommenterId} onChange={event => setCharacterCommenterId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[#ded1bf] bg-[#faf6ee] px-2 py-2 text-xs">{characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}</select></div>
            <button onClick={() => void askCharacterToWrite()} disabled={busy || !commenter || !selectedPhoto.shareWithCharacters} className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-[#87565b] px-3 py-2.5 text-xs tracking-wider text-white disabled:opacity-40"><Heart size={13}/>请 TA 把一句话写进同一张背面</button>
            {!selectedPhoto.shareWithCharacters && <p className="mt-2 text-[10px] text-[#9a7967]">这张照片目前不对角色开放。打开上方分享开关后，角色才可以回应。</p>}
          </div>}
        </div>
      </div>
    </div>}
  </div>;
}

function ChatCandidateThumb({ refId }: { refId: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!refId.startsWith("media-store://")) { setSrc(refId); return; }
    let active = true; let url = "";
    void loadMediaObjectUrl(refId).then(value => { if (!active) { if (value) URL.revokeObjectURL(value); return; } if (value) { url = value; setSrc(value); } });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [refId]);
  return <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#e7dfd2]">{src ? <img src={src} alt="" className="h-full w-full object-cover"/> : <ImagePlus size={16} className="text-[#a0917d]"/>}</span>;
}

function PhotoLarge({ refId, title }: { refId: string; title: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true; let url = "";
    void loadMediaObjectUrl(refId).then(value => { if (!active) { if (value) URL.revokeObjectURL(value); return; } if (value) { url = value; setSrc(value); } });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [refId]);
  return src ? <img src={src} alt={title} className="max-h-full max-w-full object-contain" /> : <div className="grid h-24 w-24 place-items-center text-[#9a8a75]"><LoaderCircle size={22} className="animate-spin"/></div>;
}
