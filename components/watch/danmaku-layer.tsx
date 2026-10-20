"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export type DanmakuEntry = {
  id: string;
  text: string;
  kind: "character" | "user";
  /** 角色名，仅用于调试与无障碍文本 */
  name?: string;
};

type Props = {
  items: DanmakuEntry[];
  enabled: boolean;
  /** 视频暂停时冻结弹幕 */
  paused?: boolean;
  maxLanes?: number;
};

type ActiveItem = {
  key: string;
  text: string;
  kind: "character" | "user";
  lane: number;
  width: number;
  duration: number;
};

const LANE_HEIGHT = 30;
const MIN_DURATION = 8000;
const MAX_DURATION = 16000;
/**
 * 新弹幕与同轨道上一条最多允许重叠一半。
 * 同速运动时重叠量不会随时间增长，所以只在「入场那一刻」判定就够。
 */
const MAX_OVERLAP = 0.5;
/** 队列积压上限，避免刷屏时无限排队 */
const MAX_QUEUE = 12;

export function DanmakuLayer({ items, enabled, paused = false, maxLanes = 9 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<DanmakuEntry[]>([]);
  const laneRef = useRef<Array<{ at: number; width: number; duration: number } | null>>([]);
  const timersRef = useRef<number[]>([]);
  const firstRunRef = useRef(true);
  const [active, setActive] = useState<ActiveItem[]>([]);
  const [laneCount, setLaneCount] = useState(5);
  const [hostWidth, setHostWidth] = useState(0);

  // 容器尺寸决定轨道数与飞行距离
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      setLaneCount(Math.max(2, Math.min(maxLanes, Math.floor(host.clientHeight / LANE_HEIGHT))));
      setHostWidth(host.clientWidth || 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [maxLanes]);

  // 新评论入队；首次挂载只登记不播放，避免一进房间就把历史弹幕全刷一遍
  useEffect(() => {
    if (!enabled) return;
    if (firstRunRef.current) {
      firstRunRef.current = false;
      for (const item of items) seenRef.current.add(item.id);
      return;
    }
    for (const item of items) {
      if (seenRef.current.has(item.id)) continue;
      seenRef.current.add(item.id);
      queueRef.current.push(item);
    }
    if (queueRef.current.length > MAX_QUEUE) queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE);
  }, [items, enabled]);

  const spawn = useCallback((item: DanmakuEntry): boolean => {
    const host = hostRef.current;
    if (!host) return false;
    const width = Math.max(90, Math.min(560, item.text.length * 15 + 56));
    const duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, 6000 + width * 12));
    const now = performance.now();
    const hostW = Math.max(1, host.clientWidth);
    let lane = -1;
    for (let index = 0; index < laneCount; index += 1) {
      const state = laneRef.current[index];
      if (!state) { lane = index; break; }
      const speed = (hostW + state.width) / state.duration; // px / ms
      const gap = speed * (now - state.at) - state.width;
      if (gap >= -MAX_OVERLAP * width) { lane = index; break; }
    }
    if (lane < 0) return false;
    laneRef.current[lane] = { at: now, width, duration };
    const key = item.id + ":" + Math.round(now);
    setActive(current => [...current, { key, text: item.text, kind: item.kind, lane, width, duration }]);
    const timer = window.setTimeout(() => {
      setActive(current => current.filter(entry => entry.key !== key));
    }, duration + 300);
    timersRef.current.push(timer);
    return true;
  }, [laneCount]);

  // 队列泵：有空轨就放，没有就等下一拍重试
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      const queue = queueRef.current;
      if (!queue.length) return;
      if (spawn(queue[0])) queue.shift();
    }, 200);
    return () => window.clearInterval(timer);
  }, [enabled, spawn]);

  useEffect(() => () => { timersRef.current.forEach(window.clearTimeout); }, []);

  if (!enabled) return null;
  const shift = hostWidth || 1200;

  return (
    <div ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <style>{`
        .watch-danmaku-fly{position:absolute;left:100%;white-space:nowrap;animation-name:watchDanmakuFly;animation-timing-function:linear;animation-fill-mode:forwards;will-change:transform;}
        .watch-danmaku-fly > span{display:inline-block;border-radius:999px;background:rgba(0,0,0,.45);padding:3px 10px;color:#fff;font-size:13px;line-height:20px;text-shadow:0 1px 3px rgba(0,0,0,.85);}
        .watch-danmaku-fly[data-kind="user"] > span{background:rgba(54,101,144,.85);}
        @keyframes watchDanmakuFly{from{transform:translateX(0)}to{transform:translateX(var(--dm-shift))}}
      `}</style>
      {active.map(item => (
        <div
          key={item.key}
          data-kind={item.kind}
          className="watch-danmaku-fly"
          style={{
            top: `${8 + item.lane * LANE_HEIGHT}px`,
            animationDuration: `${item.duration}ms`,
            animationPlayState: paused ? "paused" : "running",
            ["--dm-shift" as string]: `-${shift + item.width}px`,
          } as CSSProperties}
        >
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
