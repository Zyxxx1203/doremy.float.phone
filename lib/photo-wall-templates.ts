import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import type { PhotoWallTemplate } from "@/lib/photo-wall-storage";

/**
 * 摆放模板 = 一组可编辑的坐标骨架。照片按顺序吸附进槽位后仍可自由拖动，
 * 所以这里只负责「给出一组好看的落点」，不锁定照片。坐标一律 0~1 比例。
 *
 * 形状统一在「物理正方形」坐标系里定义：
 *   画布默认 2400×3000，x 单位比 y 单位短，直接用 0~1 画圆会变成椭圆。
 *   所以把 (x,y) 映射到 u,v（±1 对应画面宽度的 84%），所有形状都在同一个
 *   等比空间里描述，换任何屏幕比例都不会被拉长。
 *
 * 落点用「候选网格 + 碰撞面积校验」挑选：
 *   以照片旋转后的包围盒估算交叠面积，交叠面积 / 较小照片面积不得超过 20%。
 */

export const TEMPLATES_STORAGE_KEY = "ai_phone_photo_wall_templates_v1";
export const TEMPLATE_FILL_STORAGE_KEY = "ai_phone_photo_wall_template_fill_v1";
registerKvMigration(TEMPLATES_STORAGE_KEY);
registerKvMigration(TEMPLATE_FILL_STORAGE_KEY);

type Slot = { x: number; y: number; scale: number; rotation: number };

const clamp01 = (n: number) => Math.min(0.94, Math.max(0.06, n));
const round = (n: number) => Math.round(n * 1000) / 1000;

/** 默认画布尺寸：照片是正方形，所以 x 方向 1 个单位 = 1.25 倍 y 方向长度。 */
const CANVAS_W = 2400;
const CANVAS_H = 3000;
/** 形状占画面宽度的比例（留边距）。 */
const SHAPE_SPAN = 0.84;
/** 一张照片在归一化坐标里的宽高（240px 基准）。 */
const PHOTO_W = 240 / CANVAS_W;
const PHOTO_H = 240 / CANVAS_H;

/** 归一化坐标 → 形状用的等比坐标（±1 = 形状外包框）。 */
function toShapeSpace(x: number, y: number): { u: number; v: number } {
  const halfW = SHAPE_SPAN / 2;
  const halfH = (SHAPE_SPAN * (CANVAS_W / CANVAS_H)) / 2;
  return { u: (x - 0.5) / halfW, v: (y - 0.5) / halfH };
}

type Shape = (u: number, v: number) => boolean;

/** 点是否在多边形内（射线法）。 */
function insidePolygon(u: number, v: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ui, vi] = points[i];
    const [uj, vj] = points[j];
    if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / ((vj - vi) || 1e-6) + ui) inside = !inside;
  }
  return inside;
}

/** 经典心形隐式方程；屏幕 y 轴向下，所以取 -v。 */
const heart: Shape = (u, v) => {
  const x = u * 1.05;
  const y = -v * 1.05 + 0.06;
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
};

/** 五角星。 */
const starPoints: Array<[number, number]> = (() => {
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? 0.98 : 0.42;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return points;
})();
const star: Shape = (u, v) => insidePolygon(u, v, starPoints);

/** 六瓣花：极坐标半径随角度起伏。 */
const flower: Shape = (u, v) => {
  const r = Math.hypot(u, v);
  const angle = Math.atan2(v, u);
  const edge = 0.66 + 0.24 * Math.cos(6 * angle);
  return r <= edge;
};

/** 云朵：几个圆的并集。 */
const cloud: Shape = (u, v) => {
  if (v > 0.72) return false;
  const circles: Array<[number, number, number]> = [
    [-0.62, 0.1, 0.34],
    [-0.24, -0.08, 0.42],
    [0.18, -0.14, 0.44],
    [0.55, 0.06, 0.34],
    [0.05, 0.22, 0.36],
  ];
  return circles.some(([cx, cy, r]) => Math.hypot(u - cx, v - cy) <= r);
};

/** 阿基米德螺旋：到曲线的距离落在带宽内。 */
const spiral: Shape = (u, v) => {
  const r = Math.hypot(u, v);
  const angle = Math.atan2(v, u);
  if (r > 1.02) return false;
  let best = Infinity;
  for (let turn = 0; turn < 4; turn += 1) {
    const theta = angle + turn * Math.PI * 2;
    if (theta < 0) continue;
    const expected = 0.12 + 0.085 * theta;
    if (expected > 1.02) break;
    best = Math.min(best, Math.abs(r - expected));
  }
  return best <= 0.13;
};

/** 圆环。 */
const ring: Shape = (u, v) => {
  const r = Math.hypot(u, v);
  return r >= 0.56 && r <= 1.0;
};

/** 满屏。 */
const full: Shape = (u, v) => Math.abs(u) <= 1 && Math.abs(v) <= 1;

const SHAPES: Record<string, Shape> = {
  "builtin-heart": heart,
  "builtin-star": star,
  "builtin-flower": flower,
  "builtin-cloud": cloud,
  "builtin-spiral": spiral,
  "builtin-ring": ring,
};

function shapeOf(templateId: string): Shape {
  return SHAPES[templateId] ?? full;
}

/** 
 * 照片槽位的碰撞判定：按照片矩形包围盒计算交叠面积 / 较小照片面积，
 * 必须 <= 50%。相比中心距椭圆近似，这个判定可解释、可复现。
 * scale 是候选照片比例；已放置槽位使用各自的 scale。
 */
function farEnough(a: { x: number; y: number; rotation?: number }, b: { x: number; y: number; scale?: number; rotation?: number }, scale: number): boolean {
  const bounds = (itemScale: number, rotation = 0) => {
    const radians = Math.abs(rotation) * Math.PI / 180;
    const width = PHOTO_W * itemScale;
    const height = PHOTO_H * itemScale;
    // 旋转矩形的轴对齐包围盒，略偏保守，避免视觉上挤在一起。
    const rotatedExtent = Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians));
    return {
      // Photos are square in pixel space; normalized X/Y units differ because the wall is 4:5.
      width: width * rotatedExtent,
      height: height * rotatedExtent,
    };
  };
  const aa = bounds(scale, a.rotation ?? 0);
  const bb = bounds(b.scale ?? scale, b.rotation ?? 0);
  const overlapW = Math.max(0, (aa.width + bb.width) / 2 - Math.abs(a.x - b.x));
  const overlapH = Math.max(0, (aa.height + bb.height) / 2 - Math.abs(a.y - b.y));
  const overlapArea = overlapW * overlapH;
  const smallerArea = Math.min(aa.width * aa.height, bb.width * bb.height);
  return smallerArea <= 0 || overlapArea / smallerArea <= 0.2;
}

/**
 * 通用落点生成：
 *   fill=false → 只取形状边缘的一圈（轮廓）
 *   fill=true  → 从中心向外一圈圈铺满内部
 * 两种都用最小间距筛选，保证照片重叠不超过较小照片面积的 20%。
 */
function layoutSlots(templateId: string, count: number, fill: boolean): Slot[] {
  const total = Math.max(1, count);
  const shape = shapeOf(templateId);
  const center = { x: 0.5, y: 0.5 };

  const step = Math.max(0.008, Math.min(0.045, 0.5 / Math.sqrt(total * 14)));
  const candidates: Array<{ x: number; y: number; radius: number; angle: number; boundary: boolean }> = [];
  for (let y = 0.07; y <= 0.93; y += step) {
    for (let x = 0.07; x <= 0.93; x += step) {
      const { u, v } = toShapeSpace(x, y);
      if (!shape(u, v)) continue;
      if (!fill) {
        // 轮廓：把这一点向外放大后落到形状外，说明它贴着边缘
        const scaled = toShapeSpace(0.5 + (x - 0.5) * 1.12, 0.5 + (y - 0.5) * 1.12);
        if (shape(scaled.u, scaled.v)) continue;
      }
      const scaled = toShapeSpace(0.5 + (x - 0.5) * 1.10, 0.5 + (y - 0.5) * 1.10);
      const boundary = !shape(scaled.u, scaled.v);
      const { u, v } = toShapeSpace(x, y);
      candidates.push({
        x: round(x), y: round(y),
        radius: Math.hypot(u, v),
        angle: (Math.atan2(v, u) + Math.PI * 2) % (Math.PI * 2),
        boundary,
      });
    }
  }
  if (!candidates.length) return layoutSlots("builtin-grid", total, true);

  // 不能按角度直接从 0° 开始取前 N 个点，否则照片只会落在轮廓的一小段。
  // 先按整圈角度均匀采样外轮廓，少量照片也尽可能覆盖形状的各个特征部位；
  // 照片更多时再逐层填充内部，始终保留可辨识的整体轮廓。
  const boundaryCandidates = candidates.filter(item => item.boundary).sort((a, b) => a.angle - b.angle);
  const innerCandidates = candidates.filter(item => !item.boundary).sort((a, b) => b.radius - a.radius || a.angle - b.angle);
  const outlineCount = fill
    ? Math.min(total, Math.max(6, Math.min(24, Math.ceil(Math.sqrt(total) * 2.4))))
    : total;
  const picked: Slot[] = [];
  const used = new Set<string>();
  const addCandidate = (candidate: (typeof candidates)[number], scale: number, rotation: number) => {
    const key = String(candidate.x) + "," + String(candidate.y);
    if (used.has(key) || picked.length >= total) return false;
    if (picked.some(slot => !farEnough({ ...candidate, rotation }, slot, scale))) return false;
    picked.push({ x: candidate.x, y: candidate.y, scale: round(scale), rotation });
    used.add(key);
    return true;
  };
  const angularDistance = (a: number, b: number) => {
    const delta = Math.abs(a - b) % (Math.PI * 2);
    return Math.min(delta, Math.PI * 2 - delta);
  };
  for (let i = 0; i < outlineCount; i += 1) {
    const targetAngle = -Math.PI / 2 + (i * Math.PI * 2) / outlineCount;
    const choices = boundaryCandidates.slice().sort((a, b) => angularDistance(a.angle, targetAngle) - angularDistance(b.angle, targetAngle));
    let added = false;
    for (const candidate of choices) {
      const scale = 0.66 + ((picked.length * 3) % 5) * 0.025;
      const rotation = ((picked.length % 5) - 2) * 2;
      if (addCandidate(candidate, scale, rotation)) { added = true; break; }
    }
    if (!added) {
      for (const candidate of boundaryCandidates) {
        if (addCandidate(candidate, 0.58, 0)) { added = true; break; }
      }
    }
  }

  const ordered = [...boundaryCandidates, ...innerCandidates];
  for (const candidate of innerCandidates) {
    if (picked.length >= total) break;
    const scale = 0.66 + ((picked.length * 3) % 5) * 0.025;
    const rotation = ((picked.length % 5) - 2) * 2;
    addCandidate(candidate, scale, rotation);
  }

  let shrink = 0.52;
  while (picked.length < total && shrink >= 0.12) {
    for (const candidate of ordered) {
      if (picked.length >= total) break;
      addCandidate(candidate, shrink, 0);
    }
    shrink -= 0.06;
  }
  return picked.length >= total ? picked.slice(0, total) : gridSlots(total);
}

/** 随手散落：错列、轻微错位与小角度旋转，但仍经过 20% 碰撞校验。 */
function scatterSlots(count: number): Slot[] {
  const total = Math.max(1, count);
  const columns = Math.max(1, Math.ceil(Math.sqrt(total * 1.12)));
  const rows = Math.max(1, Math.ceil(total / columns));
  const cellW = 0.82 / columns;
  const cellH = 0.66 / rows;
  const slots: Slot[] = [];
  for (let index = 0; index < total; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const stagger = row % 2 ? cellW * 0.18 : 0;
    const jitterX = Math.sin((index + 1) * 2.17) * cellW * 0.07;
    const jitterY = Math.cos((index + 1) * 1.71) * cellH * 0.07;
    const x = round(Math.min(0.94, Math.max(0.06, 0.09 + (column + 0.5) * cellW + stagger + jitterX)));
    const y = round(Math.min(0.94, Math.max(0.06, 0.17 + (row + 0.5) * cellH + jitterY)));
    const scale = Math.min(0.72, cellW / PHOTO_W * 0.72, cellH / PHOTO_H * 0.72);
    const rotation = ((index * 7) % 7 - 3) * 3;
    const candidate = { x, y, scale: round(scale), rotation };
    if (slots.some(slot => !farEnough(candidate, slot, candidate.scale))) return gridSlots(total);
    slots.push(candidate);
  }
  return slots;
}

/** 网格：等距排列，天然满足间距约束。 */
function gridSlots(count: number): Slot[] {
  const total = Math.max(1, count);
  const columns = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(1, Math.ceil(total / columns));
  const slots: Slot[] = [];
  for (let index = 0; index < total; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    slots.push({
      x: round(0.5 + ((column + 0.5) / columns - 0.5) * 0.82),
      y: round(0.5 + ((row + 0.5) / rows - 0.5) * 0.66),
      // 随照片数量自动缩放，避免网格照片挤压重叠。
      scale: Math.min(0.72, 10 / Math.max(columns, rows)),
      rotation: 0,
    });
  }
  return slots;
}

/** 文字骨架：离屏 canvas 采样笔画，再用同一套间距筛选。 */
function textSlots(text: string, count: number, fill: boolean): Slot[] {
  const clean = text.trim().slice(0, 12) || "LOVE";
  const width = 480;
  const height = 220;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return layoutSlots("builtin-grid", count, true);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return layoutSlots("builtin-grid", count, true);
  context.fillStyle = "#000";
  let fontSize = 150;
  context.font = `700 ${fontSize}px sans-serif`;
  while (context.measureText(clean).width > width - 24 && fontSize > 24) {
    fontSize -= 6;
    context.font = `700 ${fontSize}px sans-serif`;
  }
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(clean, width / 2, height / 2);
  const data = context.getImageData(0, 0, width, height).data;
  const hits: Array<{ x: number; y: number }> = [];
  const step = 6;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (data[(y * width + x) * 4 + 3] > 128) hits.push({ x: 0.1 + (x / width) * 0.8, y: 0.24 + (y / height) * 0.52 });
    }
  }
  if (!hits.length) return layoutSlots("builtin-grid", count, true);

  const total = Math.max(1, count);
  const center = { x: 0.5, y: 0.5 };
  // Farthest-point sampling distributes a small number of photos across all glyphs and
  // across the full height of letters. Sorting by y/x made "LOVE" collapse into its top row.
  const remaining = hits.map(hit => ({ ...hit, radius: Math.hypot(hit.x - center.x, (hit.y - center.y) * (CANVAS_H / CANVAS_W)) }));
  const ordered: typeof remaining = [];
  if (remaining.length) {
    const seedIndex = remaining.reduce((best, hit, index) =>
      hit.x + hit.y * 0.25 < remaining[best].x + remaining[best].y * 0.25 ? index : best, 0);
    ordered.push(remaining.splice(seedIndex, 1)[0]);
    while (remaining.length) {
      let bestIndex = 0, bestDistance = -1;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const nearest = ordered.reduce((min, chosen) => Math.min(min,
          Math.hypot((candidate.x - chosen.x) * (CANVAS_W / CANVAS_H), candidate.y - chosen.y)), Infinity);
        if (nearest > bestDistance) { bestDistance = nearest; bestIndex = index; }
      }
      ordered.push(remaining.splice(bestIndex, 1)[0]);
    }
  }

  const picked: Slot[] = [];
  for (const hit of ordered) {
    if (picked.length >= total) break;
    const rotation = round(((picked.length * 19) % 9) - 4);
    if (picked.some(slot => !farEnough({ ...hit, rotation }, slot, 0.5))) continue;
    picked.push({ x: round(clamp01(hit.x)), y: round(clamp01(hit.y)), scale: 0.5, rotation });
  }
  // 文字采样点不足时也不重复叠放：遍历唯一点位并缩小到安全尺寸补齐。
  const used = new Set(picked.map(slot => `${slot.x},${slot.y}`));
  for (const hit of ordered) {
    if (picked.length >= total) break;
    const x = round(clamp01(hit.x)), y = round(clamp01(hit.y));
    const key = `${x},${y}`;
    if (used.has(key) || picked.some(slot => !farEnough({ x, y }, slot, 0.12))) continue;
    picked.push({ x, y, scale: 0.12, rotation: 0 });
    used.add(key);
  }
  return picked.slice(0, total);
}

export const BUILTIN_TEMPLATES: PhotoWallTemplate[] = [
  { id: "builtin-heart", name: "心形", builtin: true, slots: [] },
  { id: "builtin-star", name: "星星", builtin: true, slots: [] },
  { id: "builtin-flower", name: "花朵", builtin: true, slots: [] },
  { id: "builtin-cloud", name: "云朵", builtin: true, slots: [] },
  { id: "builtin-spiral", name: "星河螺旋", builtin: true, slots: [] },
  { id: "builtin-ring", name: "环抱", builtin: true, slots: [] },
  { id: "builtin-grid", name: "整齐网格", builtin: true, slots: [] },
  { id: "builtin-scatter", name: "随手散落", builtin: true, slots: [] },
  { id: "builtin-text", name: "文字骨架", builtin: true, slots: [] },
];

export function loadTemplateFill(): boolean {
  // 新安装默认使用“轮廓 + 内部填充”；显式保存为 0 的用户设置仍然尊重。
  try { return kvGet(TEMPLATE_FILL_STORAGE_KEY) !== "0"; } catch { return true; }
}

export function saveTemplateFill(fill: boolean): void {
  try { kvSet(TEMPLATE_FILL_STORAGE_KEY, fill ? "1" : "0"); } catch { /* 忽略配额错误 */ }
}

/** 按模板 id 现算骨架：数量随当前照片数变化，所以不预先固化 slots。 */
export function buildTemplateSlots(templateId: string, count: number, customText?: string, fill = false): Slot[] {
  const total = Math.max(1, count);
  // 每个分支都必须返回与照片数量相同的唯一槽位；否则上层不能循环复用槽位，
  // 否则会把多张照片精确叠在一起。形状放不下时，安全退回间距合格的网格。
  const safeShapeSlots = (slots: Slot[]) => slots.length >= total ? slots.slice(0, total) : gridSlots(total);
  if (templateId === "builtin-fill") return safeShapeSlots(layoutSlots("builtin-heart", total, true));
  if (templateId === "builtin-grid") return gridSlots(total);
  if (templateId === "builtin-scatter") return scatterSlots(total);
  if (templateId === "builtin-text") return safeShapeSlots(textSlots(customText || "LOVE", total, fill));
  if (SHAPES[templateId]) return safeShapeSlots(layoutSlots(templateId, total, fill));

  // 自定义模板：保留用户骨架，但如果其位置互相重叠，就退回安全网格；
  // 补位时同样做碰撞检测，不允许槽位不足时在上层重复套用。
  const template = loadCustomTemplates().find(item => item.id === templateId);
  if (template?.slots?.length) {
    const slots: Slot[] = template.slots.slice(0, total).map(slot => ({
      x: round(clamp01(Number(slot.x) || 0.5)),
      y: round(clamp01(Number(slot.y) || 0.5)),
      scale: Math.min(3, Math.max(0.12, Number(slot.scale) || 0.82)),
      rotation: Math.min(45, Math.max(-45, Number(slot.rotation) || 0)),
    }));
    for (let i = 0; i < slots.length; i += 1) {
      if (slots.slice(0, i).some(previous => !farEnough(slots[i], previous, slots[i].scale))) return gridSlots(total);
    }
    const pool = gridSlots(Math.max(total * 3, slots.length + total));
    let index = 0;
    while (slots.length < total && index < pool.length) {
      const candidate = pool[index++];
      if (!slots.some(slot => !farEnough(candidate, slot, candidate.scale))) slots.push(candidate);
    }
    return slots.length === total ? slots : gridSlots(total);
  }

  return gridSlots(total);
}

export function templateSlotCount(templateId: string, customText?: string): number {
  return buildTemplateSlots(templateId, 12, customText).length;
}

export function loadCustomTemplates(): PhotoWallTemplate[] {
  try {
    const raw = kvGet(TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PhotoWallTemplate =>
      Boolean(item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.slots)),
    ).slice(-40);
  } catch { return []; }
}

export function saveCustomTemplates(templates: PhotoWallTemplate[]): void {
  try { kvSet(TEMPLATES_STORAGE_KEY, JSON.stringify(templates.slice(-40))); } catch { /* 配额满等，忽略 */ }
}

export function listAllTemplates(): PhotoWallTemplate[] {
  return [...BUILTIN_TEMPLATES, ...loadCustomTemplates()];
}
