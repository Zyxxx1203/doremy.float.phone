"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Droplet, Eraser, ImagePlus, Lock, Minus, Palette, Plus, RotateCcw, RotateCw, Sparkles, SquarePen, Smile, Unlock } from "lucide-react";
import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import {
  createPhotoWallId,
  type PhotoWallDoodle,
  type PhotoWallFrameStyle,
  type PhotoWallPhoto,
  type PhotoWallPlacement,
} from "@/lib/photo-wall-storage";

/** 相框留白比例：宝丽来下缘更宽，留给手写感。 */
const FRAME_PADDING: Record<PhotoWallFrameStyle, { x: number; y: number; bottom: number }> = {
  polaroid: { x: 0.055, y: 0.045, bottom: 0.16 },
  thin: { x: 0.018, y: 0.018, bottom: 0.03 },
  wood: { x: 0.05, y: 0.05, bottom: 0.09 },
  tape: { x: 0.03, y: 0.03, bottom: 0.06 },
  none: { x: 0, y: 0, bottom: 0 },
};

const FRAME_BG: Record<PhotoWallFrameStyle, string> = {
  polaroid: "#fffdf8",
  thin: "#f6f1e6",
  wood: "#a97c52",
  tape: "#fbf6ea",
  none: "transparent",
};

export const STICKER_CHOICES = ["❤", "✦", "✿", "☾", "☘", "♪", "★", "⌘"];
const BRUSH_COLORS = ["#c2705a", "#a77b77", "#b08a54", "#5d6b8a", "#8a6b8a", "#3c3a36"];

/** 照片墙基准宽度比例：单张照片默认占墙宽的比例，再乘 placement.scale。 */
const BASE_PHOTO_RATIO = 0.3;

/** 没有摆放坐标的老照片，给一个稳定但错落的默认落点。 */
export function fallbackPlacement(index: number): PhotoWallPlacement {
  const col = index % 3;
  const row = Math.floor(index / 3);
  const wobble = ((index * 37) % 11) - 5;
  return {
    x: Math.min(0.88, Math.max(0.12, 0.2 + col * 0.3 + wobble * 0.004)),
    y: Math.min(0.9, Math.max(0.1, 0.14 + row * 0.27 + wobble * 0.003)),
    scale: 1,
    rotation: wobble,
    z: index + 1,
    frame: "polaroid",
    frameColor: "#fffdf8",
  };
}

type Props = {
  photos: PhotoWallPhoto[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangePlacement: (id: string, placement: PhotoWallPlacement) => void;
  onChangeDoodles: (id: string, doodles: PhotoWallDoodle[]) => void;
  wallDoodles?: PhotoWallDoodle[];
  onChangeWallDoodles?: (doodles: PhotoWallDoodle[]) => void;
  onOpenDetail: (photo: PhotoWallPhoto) => void;
  readOnly?: boolean;
  fitHeight?: boolean;
};

type DragState = {
  id: string;
  pointerId: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  base: PhotoWallPlacement;
  wallWidth: number;
  wallHeight: number;
  moved: boolean;
};

export function PhotoWallCanvas({ photos, selectedId, onSelect, onChangePlacement, onChangeDoodles, wallDoodles = [], onChangeWallDoodles, onOpenDetail, readOnly = false, fitHeight = false }: Props) {
  const wallRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const strokeRef = useRef<{ id: string; photoId: string } | null>(null);
  const wallStrokeRef = useRef<{ id: string } | null>(null);
  const wallDraftPointsRef = useRef<{ x: number; y: number }[]>([]);
  const suppressClickRef = useRef(false);
  const multiTouchRef = useRef(false);
  const [flippedPhotoIds, setFlippedPhotoIds] = useState<Set<string>>(new Set());

  // Viewing is the safe default: taps flip; placement starts only on explicit opt-in.
  const [mode, setMode] = useState<"view" | "move" | "doodle">("view");
  const [brushColor, setBrushColor] = useState(BRUSH_COLORS[0]);
  const [brushWidth, setBrushWidth] = useState(3);
  const [sticker, setSticker] = useState<string | null>(null);
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onPinchStart = () => {
      multiTouchRef.current = true;
      dragRef.current = null;
      strokeRef.current = null;
      suppressClickRef.current = true;
      if (timer) clearTimeout(timer);
    };
    const onPinchEnd = () => {
      suppressClickRef.current = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        multiTouchRef.current = false;
        suppressClickRef.current = false;
      }, 420);
    };
    window.addEventListener("photo-wall-pinch-start", onPinchStart);
    window.addEventListener("photo-wall-pinch-end", onPinchEnd);
    return () => {
      window.removeEventListener("photo-wall-pinch-start", onPinchStart);
      window.removeEventListener("photo-wall-pinch-end", onPinchEnd);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const ordered = useMemo(() => photos.slice().sort((a, b) => (a.placement?.z ?? 0) - (b.placement?.z ?? 0)), [photos]);
  const placementOf = useCallback(
    (photo: PhotoWallPhoto, index: number) => photo.placement ?? fallbackPlacement(index),
    [],
  );

  const selectedPhoto = ordered.find(photo => photo.id === selectedId) ?? null;

  const commit = useCallback((id: string, next: PhotoWallPlacement) => onChangePlacement(id, next), [onChangePlacement]);

  /* ── 拖动 / 缩放 ───────────────────────────────── */
  const beginDrag = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number, dragMode: "move" | "resize") => {
    if (multiTouchRef.current) return;
    if (mode !== "move") { onSelect(photo.id); return; }
    if (dragMode === "move" && event.button !== undefined && event.button !== 0) return;
    const wall = wallRef.current;
    if (!wall) return;
    const currentPlacement = placementOf(photo, index);
    if (currentPlacement.locked) {
      onSelect(photo.id);
      return;
    }
    const rect = wall.getBoundingClientRect();
    // 不在 pointerdown 时抢占指针，否则普通轻触的 click 会落到墙容器上，
    // 照片卡片收不到 click，用户就无法翻面。只有真正开始拖动时再捕获。
    dragRef.current = {
      id: photo.id,
      pointerId: event.pointerId,
      mode: dragMode,
      startX: event.clientX,
      startY: event.clientY,
      base: placementOf(photo, index),
      wallWidth: rect.width || 1,
      wallHeight: rect.height || 1,
      moved: false,
    };
    onSelect(photo.id);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      // A tiny finger/mouse jitter must still count as a tap so the card flips.
      if (Math.abs(dx) + Math.abs(dy) <= 8) return;
      drag.moved = true;
      const wall = wallRef.current;
      if (wall && !wall.hasPointerCapture(event.pointerId)) wall.setPointerCapture(event.pointerId);
    }
    if (drag.mode === "move") {
      const nextX = Math.min(0.98, Math.max(0.02, drag.base.x + dx / drag.wallWidth));
      const nextY = Math.min(0.98, Math.max(0.02, drag.base.y + dy / drag.wallHeight));
      commit(drag.id, { ...drag.base, x: nextX, y: nextY });
    } else {
      const delta = (dx + dy) / 2 / drag.wallWidth;
      const scale = Math.min(3, Math.max(0.35, drag.base.scale + delta * 2));
      commit(drag.id, { ...drag.base, scale });
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    if (drag.moved) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  /* ── 涂鸦绘制 ─────────────────────────────────── */
  const pointOn = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number) => {
    const target = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const placement = placementOf(photo, index);
    // 归一化到这张照片的相框范围内
    const width = target.width || 1;
    const height = target.height || 1;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - target.left) / width)),
      y: Math.min(1, Math.max(0, (event.clientY - target.top) / height)),
      placement,
    };
  };

  const doodlePointerDown = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number) => {
    if (mode !== "doodle") return;
    event.stopPropagation();
    const point = pointOn(event, photo, index);
    const existing = photo.doodles ?? [];
    if (sticker) {
      onChangeDoodles(photo.id, [
        ...existing,
        { id: createPhotoWallId(), kind: "sticker", content: sticker, color: brushColor, width: brushWidth, points: [{ x: point.x, y: point.y }], createdAt: new Date().toISOString() },
      ]);
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const id = createPhotoWallId();
    strokeRef.current = { id, photoId: photo.id };
    setDraftPoints([{ x: point.x, y: point.y }]);
  };

  const doodlePointerMove = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number) => {
    if (!strokeRef.current || strokeRef.current.photoId !== photo.id) return;
    const point = pointOn(event, photo, index);
    setDraftPoints(prev => {
      const last = prev[prev.length - 1];
      if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.004) return prev;
      return [...prev, { x: point.x, y: point.y }];
    });
  };

  const doodlePointerUp = (event: React.PointerEvent, photo: PhotoWallPhoto) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.photoId !== photo.id) return;
    strokeRef.current = null;
    const points = draftPoints;
    setDraftPoints([]);
    if (points.length < 2) return;
    onChangeDoodles(photo.id, [
      ...(photo.doodles ?? []),
      { id: stroke.id, kind: "stroke", color: brushColor, width: brushWidth, points, createdAt: new Date().toISOString() },
    ]);
  };

  const wallPoint = (event: React.PointerEvent) => {
    const rect = wallRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))) };
  };
  const wallDoodlePointerDown = (event: React.PointerEvent) => {
    if (readOnly || mode !== "doodle") return;
    event.preventDefault();
    event.stopPropagation();
    const point = wallPoint(event);
    if (sticker) {
      onChangeWallDoodles?.([...wallDoodles, { id: createPhotoWallId(), kind: "sticker", content: sticker, color: brushColor, width: brushWidth, points: [point], createdAt: new Date().toISOString() }]);
      return;
    }
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    wallStrokeRef.current = { id: createPhotoWallId() };
    wallDraftPointsRef.current = [point];
    setDraftPoints([point]);
  };
  const wallDoodlePointerMove = (event: React.PointerEvent) => {
    if (!wallStrokeRef.current || mode !== "doodle") return;
    const point = wallPoint(event);
    const last = wallDraftPointsRef.current[wallDraftPointsRef.current.length - 1];
    if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.003) return;
    wallDraftPointsRef.current = [...wallDraftPointsRef.current, point];
    setDraftPoints(wallDraftPointsRef.current);
  };
  const wallDoodlePointerUp = (event: React.PointerEvent) => {
    const stroke = wallStrokeRef.current;
    if (!stroke) return;
    event.preventDefault();
    event.stopPropagation();
    wallStrokeRef.current = null;
    const points = wallDraftPointsRef.current;
    wallDraftPointsRef.current = [];
    setDraftPoints([]);
    if (points.length >= 2) onChangeWallDoodles?.([...wallDoodles, { id: stroke.id, kind: "stroke", color: brushColor, width: brushWidth, points, createdAt: new Date().toISOString() }]);
  };
  const clearDoodles = () => {
    if (selectedPhoto) onChangeDoodles(selectedPhoto.id, []);
    onChangeWallDoodles?.([]);
  };

  /* ── 选中照片的小工具条 ──────────────────────── */
  const nudge = (photo: PhotoWallPhoto, index: number, patch: Partial<PhotoWallPlacement>) => {
    const base = placementOf(photo, index);
    // Lock protects position/size/orientation from every control; the explicit
    // locked-field toggle remains allowed so the user can unlock the card.
    if (base.locked && patch.locked === undefined) return;
    commit(photo.id, { ...base, ...patch } as PhotoWallPlacement);
  };

  const bringToFront = (photo: PhotoWallPhoto, index: number) => {
    const maxZ = ordered.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
    nudge(photo, index, { z: maxZ + 1 });
  };

  return <div className={fitHeight ? "relative flex h-full w-full items-center justify-center" : "relative"}>
    <div
      ref={wallRef}
      className={"photo-wall-surface relative select-none overflow-hidden rounded-[2px] border border-[#eee3d8] shadow-[inset_0_1px_0_rgba(255,255,255,.95),0_4px_12px_rgba(88,70,48,.06)] " + (fitHeight ? "h-full w-auto shrink-0" : "w-full")}
      style={{ aspectRatio: "4 / 5", width: fitHeight ? "min(64vh, 80vw)" : "100%", height: fitHeight ? "100%" : "auto", flex: "0 0 auto", touchAction: readOnly ? "auto" : "none", backgroundImage: "repeating-linear-gradient(0deg,rgba(130,98,70,.018) 0,rgba(130,98,70,.018) 1px,transparent 1px,transparent 4px),radial-gradient(ellipse at 24% 15%,rgba(255,255,255,.9),transparent 62%),linear-gradient(145deg,#fffaf2 0%,#faf3ea 48%,#f5ece2 100%)" }}
      onPointerMove={readOnly ? undefined : handlePointerMove}
      onPointerUp={readOnly ? undefined : endDrag}
      onPointerCancel={readOnly ? undefined : endDrag}
      onTouchStart={event => { if (event.touches.length > 1) { multiTouchRef.current = true; dragRef.current = null; } }}
      onTouchEnd={event => { if (event.touches.length < 2) multiTouchRef.current = false; }}
      onClick={event => { if (event.target === event.currentTarget) onSelect(null); }}
    >
      {ordered.length === 0 && !readOnly && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[#a99a86]"><div className="text-center"><ImagePlus size={26} className="mx-auto"/><p className="mt-2 text-xs">这面墙还空着</p></div></div>}

      {ordered.map((photo, index) => {
        const placement = placementOf(photo, index);
        const isSelected = photo.id === selectedId;
        return <WallPhotoFrame
          key={photo.id}
          photo={photo}
          placement={placement}
          selected={isSelected}
          flipped={flippedPhotoIds.has(photo.id)}
          onToggleFlip={() => {
            if (mode !== "view") return;
            if (multiTouchRef.current) { suppressClickRef.current = true; return; }
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            setFlippedPhotoIds(current => { const next = new Set(current); if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id); return next; });
          }}
          doodleMode={mode === "doodle" && isSelected}
          placementMode={mode === "move"}
          draftPoints={isSelected && strokeRef.current?.photoId === photo.id ? draftPoints : []}
          onPointerDownMove={(event) => { if (!readOnly) beginDrag(event, photo, index, "move"); }}
          onPointerDownResize={(event) => { if (!readOnly) beginDrag(event, photo, index, "resize"); }}
          onDoodlePointerDown={(event) => { if (!readOnly) doodlePointerDown(event, photo, index); }}
          onDoodlePointerMove={(event) => { if (!readOnly) doodlePointerMove(event, photo, index); }}
          onDoodlePointerUp={(event) => { if (!readOnly) doodlePointerUp(event, photo); }}
          onOpenDetail={() => onOpenDetail(photo)}
          readOnly={readOnly}
        />;
      })}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="整面照片墙涂鸦画布"
        className={mode === "doodle" && !readOnly ? "absolute inset-0 h-full w-full cursor-crosshair" : "pointer-events-none absolute inset-0 h-full w-full"}
        style={{ zIndex: 9999, pointerEvents: mode === "doodle" && !readOnly ? "auto" : "none", touchAction: "none", overflow: "visible" }}
        onPointerDown={wallDoodlePointerDown} onPointerMove={wallDoodlePointerMove} onPointerUp={wallDoodlePointerUp} onPointerCancel={wallDoodlePointerUp}>
        {wallDoodles.map(doodle => doodle.kind === "stroke"
          ? <polyline key={doodle.id} points={doodle.points.map(point => (point.x * 100) + "," + (point.y * 100)).join(" ")} fill="none" stroke={doodle.color} strokeWidth={Math.max(0.6, doodle.width / 2)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
          : <text key={doodle.id} x={(doodle.points[0]?.x ?? 0.5) * 100} y={(doodle.points[0]?.y ?? 0.5) * 100} fill={doodle.color} fontSize={5} textAnchor="middle" dominantBaseline="middle">{doodle.content}</text>)}
        {mode === "doodle" && draftPoints.length > 1 && <polyline points={draftPoints.map(point => (point.x * 100) + "," + (point.y * 100)).join(" ")} fill="none" stroke={brushColor} strokeWidth={Math.max(0.6, brushWidth / 2)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>}
      </svg>
    </div>

    {/* 画布工具条 */}
    {!readOnly && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-[#e2d2c3] py-2.5">
      <button type="button" onClick={() => setMode(current => current === "move" ? "view" : "move")} className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs transition ${mode === "move" ? "border-[#87565b] bg-[#87565b] text-white" : "border-[#ddd1bd] bg-white/80 text-[#7d6d5a]"}`}><Unlock size={13}/>{mode === "move" ? "完成摆放" : "摆照片"}</button>
      <button type="button" onClick={() => { setMode(current => current === "doodle" ? "view" : "doodle"); if (selectedPhoto) setFlippedPhotoIds(current => { const next = new Set(current); next.delete(selectedPhoto.id); return next; }); }} title="进入涂鸦后可在整面墙任意位置按住并拖动画线或放置贴纸" className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs transition ${mode === "doodle" ? "border-[#a77b77] bg-[#a77b77] text-white" : "border-[#ddd1bd] bg-white/80 text-[#7d6d5a]"}`}><SquarePen size={13}/>{mode === "doodle" ? "退出涂鸦" : "涂鸦"}</button>
      {mode === "doodle" && <>
        <span className="w-full basis-full text-[10px] leading-4 text-[#9a8973]">"在整面墙任意位置按住并划动即可涂鸦，可跨过照片；选贴纸后点画布放置。照片旧涂鸦仍保留。"</span>
        <span className="mx-1 h-4 w-px bg-[#ddd1bd]" />
        <span className="flex items-center gap-1"><Palette size={12} className="text-[#9a8973]"/>{BRUSH_COLORS.map(color => <button key={color} type="button" aria-label={`画笔颜色 ${color}`} onClick={() => { setBrushColor(color); setSticker(null); }} className={`h-5 w-5 rounded-full border ${brushColor === color && !sticker ? "border-[#6b5c4a] ring-2 ring-white" : "border-white/70"}`} style={{ background: color }} />)}</span>
        <span className="flex items-center gap-1"><Droplet size={12} className="text-[#9a8973]"/>{[2, 3, 5, 8].map(width => <button key={width} type="button" onClick={() => setBrushWidth(width)} className={`grid h-6 w-6 place-items-center rounded-full text-[10px] ${brushWidth === width ? "bg-[#6b5c4a] text-white" : "bg-white/70 text-[#7d6d5a]"}`}>{width}</button>)}</span>
        <span className="flex items-center gap-1"><Smile size={12} className="text-[#9a8973]"/>{STICKER_CHOICES.map(item => <button key={item} type="button" onClick={() => setSticker(current => current === item ? null : item)} className={`grid h-6 w-6 place-items-center rounded-full text-[13px] ${sticker === item ? "bg-[#6b5c4a] text-white" : "bg-white/70"}`}>{item}</button>)}</span>
        <button type="button" onClick={clearDoodles} disabled={!selectedPhoto?.doodles?.length && !wallDoodles.length} className="ml-auto flex items-center gap-1 border-b border-[#e0c8bd] px-2 py-1.5 text-[11px] text-[#a06a58] disabled:opacity-40"><Eraser size={12}/>清空涂鸦</button>
      </>}
    </div>}

    {!readOnly && selectedPhoto && mode !== "view" && <div className="mt-2 flex flex-wrap items-center gap-1.5 border-y border-[#e6dccd] bg-white/70 px-2 py-2">
      <span className="px-1 text-[11px] text-[#9a8973]">已选：{selectedPhoto.title || "未命名"}</span>
      <button type="button" onClick={() => nudge(selectedPhoto, ordered.indexOf(selectedPhoto), { scale: Math.max(0.35, (selectedPhoto.placement?.scale ?? 1) - 0.12) })} className="grid h-8 w-8 place-items-center rounded-none border-b border-[#d7c2b1] bg-transparent text-[#7d6d5a]" aria-label="缩小"><Minus size={14}/></button>
      <button type="button" onClick={() => nudge(selectedPhoto, ordered.indexOf(selectedPhoto), { scale: Math.min(3, (selectedPhoto.placement?.scale ?? 1) + 0.12) })} className="grid h-8 w-8 place-items-center rounded-none border-b border-[#d7c2b1] bg-transparent text-[#7d6d5a]" aria-label="放大"><Plus size={14}/></button>
      <button type="button" onClick={() => nudge(selectedPhoto, ordered.indexOf(selectedPhoto), { rotation: Math.max(-45, (selectedPhoto.placement?.rotation ?? 0) - 3) })} className="grid h-8 w-8 place-items-center rounded-none border-b border-[#d7c2b1] bg-transparent text-[#7d6d5a]" aria-label="左转"><RotateCcw size={14}/></button>
      <button type="button" onClick={() => nudge(selectedPhoto, ordered.indexOf(selectedPhoto), { rotation: Math.min(45, (selectedPhoto.placement?.rotation ?? 0) + 3) })} className="grid h-8 w-8 place-items-center rounded-none border-b border-[#d7c2b1] bg-transparent text-[#7d6d5a]" aria-label="右转"><RotateCw size={14}/></button>
      <button type="button" onClick={() => nudge(selectedPhoto, ordered.indexOf(selectedPhoto), { locked: !selectedPhoto.placement?.locked })} title={selectedPhoto.placement?.locked ? "解除锁定后可移动照片" : "锁定后防止误拖动"} className={`flex items-center gap-1 rounded-full border px-2.5 py-1.5 text-[11px] ${selectedPhoto.placement?.locked ? "border-[#87565b] bg-[#87565b] text-white" : "border-[#d7c2b1] bg-white/80 text-[#7d6d5a]"}`}>{selectedPhoto.placement?.locked ? <Lock size={12}/> : <Unlock size={12}/>} {selectedPhoto.placement?.locked ? "已锁定" : "锁定照片"}</button>
      <button type="button" onClick={() => onOpenDetail(selectedPhoto)} className="rounded-full border border-[#87565b] bg-[#87565b] px-3 py-1.5 text-[11px] text-white">查看详情</button>
    </div>}
  </div>;
}

type FrameProps = {
  photo: PhotoWallPhoto;
  placement: PhotoWallPlacement;
  selected: boolean;
  flipped: boolean;
  placementMode: boolean;
  onToggleFlip: () => void;
  doodleMode: boolean;
  draftPoints: { x: number; y: number }[];
  onPointerDownMove: (event: React.PointerEvent) => void;
  onPointerDownResize: (event: React.PointerEvent) => void;
  onDoodlePointerDown: (event: React.PointerEvent) => void;
  onDoodlePointerMove: (event: React.PointerEvent) => void;
  onDoodlePointerUp: (event: React.PointerEvent) => void;
  onOpenDetail: () => void;
  readOnly: boolean;
};

function WallPhotoFrame({ photo, placement, selected, flipped, placementMode, onToggleFlip, doodleMode, draftPoints, onPointerDownMove, onPointerDownResize, onDoodlePointerDown, onDoodlePointerMove, onDoodlePointerUp, onOpenDetail, readOnly }: FrameProps) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let url = "";
    setFailed(false);
    void loadMediaObjectUrl(photo.mediaRef).then(value => {
      if (!active) { if (value) URL.revokeObjectURL(value); return; }
      if (value) { url = value; setSrc(value); } else setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [photo.mediaRef]);

  const frame = placement.frame;
  const pad = FRAME_PADDING[frame];
  const width = `${BASE_PHOTO_RATIO * placement.scale * 100}%`;

  return <div
    data-photo-wall-photo
    className="absolute"
    style={{
      left: `${placement.x * 100}%`,
      top: `${placement.y * 100}%`,
      width,
      transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`,
      zIndex: placement.z,
      touchAction: readOnly ? "auto" : "none",
    }}
  >
    <div
      className={`relative ${selected ? "outline outline-2 outline-offset-2 outline-[#87565b]" : ""}`}
      style={{
        background: FRAME_BG[frame] === "transparent" ? "transparent" : (placement.frameColor || FRAME_BG[frame]),
        padding: `${pad.y * 100}% ${pad.x * 100}% ${pad.bottom * 100}%`,
        borderRadius: frame === "thin" ? 1 : frame === "none" ? 2 : 1,
        boxShadow: frame === "none" ? "0 6px 18px rgba(70,55,38,.22)" : "0 10px 24px rgba(70,55,38,.2)",
      }}
      onPointerDown={(event) => { if (!doodleMode) onPointerDownMove(event); }}
      onClick={event => { event.stopPropagation(); if (!placementMode && !doodleMode) onToggleFlip(); }}
    >
      {flipped ? <div className="relative flex w-full flex-col overflow-y-auto rounded-sm bg-[#fffaf2] p-2.5 text-[#6b5947]" style={{ aspectRatio: "1 / 1", borderRadius: frame === "none" ? 2 : 1 }}>
        <div className="border-b border-[#dfcfbe] pb-1 text-[7px] tracking-[.2em] text-[#a58f77]">THE BACK · 背面</div>
        <div className="mt-1 break-words text-[9px] font-semibold leading-snug">{photo.title || "未命名的瞬间"}</div>
        <p className="mt-1 whitespace-pre-wrap break-words text-[8px] leading-relaxed">{photo.backNote?.trim() || "还没有写下手记。打开详情可编辑背面内容。"}</p>
        {photo.caption?.trim() && <p className="mt-1 break-words border-t border-[#e8dccd] pt-1 text-[7px] leading-snug">照片说明：{photo.caption}</p>}
        {photo.annotations.length > 0 && <div className="mt-auto border-t border-[#e8dccd] pt-1">{photo.annotations.slice(-2).map(note => <p key={note.id} className="mt-0.5 break-words text-[7px] leading-snug"><span className="font-semibold">{note.authorName}：</span>{note.content}</p>)}</div>}
      </div> : <>
      <div className="relative overflow-hidden bg-[#e7dfd2]" style={{ aspectRatio: "1 / 1", borderRadius: frame === "none" ? 2 : 1 }}>
        {src ? <img src={src} alt={photo.title} draggable={false} className="h-full w-full object-contain" /> : failed ? <div className="grid h-full place-items-center text-[9px] text-[#a06050]">图片无法显示</div> : <div className="grid h-full place-items-center text-[#a99a86]"><ImagePlus size={16}/></div>}
        {frame === "tape" && <>
          <span className="pointer-events-none absolute -left-2 -top-2 h-4 w-10 -rotate-12 bg-[#f3e9cf]/85 shadow-sm" />
          <span className="pointer-events-none absolute -right-2 -top-2 h-4 w-10 rotate-12 bg-[#f3e9cf]/85 shadow-sm" />
        </>}
      </div>
      {frame === "polaroid" && <div className="mt-1 truncate text-center font-serif text-[9px] text-[#8d7c66]">{photo.title}</div>}

      {/* 相框级涂鸦层：画在相框之上 */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" style={{ overflow: "visible" }}>
        {(photo.doodles ?? []).map(doodle => doodle.kind === "stroke"
          ? <polyline
              key={doodle.id}
              points={doodle.points.map(point => `${point.x * 100},${point.y * 100}`).join(" ")}
              fill="none"
              stroke={doodle.color}
              strokeWidth={doodle.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          : <text key={doodle.id} x={(doodle.points[0]?.x ?? 0.5) * 100} y={(doodle.points[0]?.y ?? 0.5) * 100} fontSize={12} textAnchor="middle" dominantBaseline="middle">{doodle.content}</text>)}
        {draftPoints.length > 1 && <polyline points={draftPoints.map(point => `${point.x * 100},${point.y * 100}`).join(" ")} fill="none" stroke="#c2705a" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>

      {doodleMode && <div
        className="absolute inset-0 cursor-crosshair"
        style={{ touchAction: "none" }}
        onPointerDown={onDoodlePointerDown}
        onClick={event => event.stopPropagation()}
        onPointerMove={onDoodlePointerMove}
        onPointerUp={onDoodlePointerUp}
        onPointerCancel={onDoodlePointerUp}
      />}

      </>}

      {selected && placementMode && !doodleMode && !placement.locked && <button
        type="button"
        aria-label="拖动调整大小"
        onPointerDown={event => { event.stopPropagation(); onPointerDownResize(event); }}
        onClick={event => event.stopPropagation()}
        className="absolute -bottom-2 -right-2 grid h-6 w-6 place-items-center rounded-full border border-white bg-[#87565b] text-white shadow"
      ><Plus size={12}/></button>}
    </div>
  </div>;
}
