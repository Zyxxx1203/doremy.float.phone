import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import type { PhotoWallTemplate } from "@/lib/photo-wall-storage";

/**
 * 摆放模板 = 一组可编辑的坐标骨架。照片按顺序吸附进槽位后仍可自由拖动，
 * 所以这里只负责「给出一组好看的落点」，不锁定照片。
 * 坐标一律 0~1 比例，换屏幕不会错位。
 */

export const TEMPLATES_STORAGE_KEY = "ai_phone_photo_wall_templates_v1";
registerKvMigration(TEMPLATES_STORAGE_KEY);

type Slot = { x: number; y: number; scale: number; rotation: number };

const clamp01 = (n: number) => Math.min(0.94, Math.max(0.06, n));
const round = (n: number) => Math.round(n * 1000) / 1000;

/** 心形：经典心形参数方程采样，按逆时针一圈均匀落点。 */
function heartSlots(count: number): Slot[] {
  const slots: Slot[] = [];
  const total = Math.max(3, count);
  for (let i = 0; i < total; i += 1) {
    const t = (i / total) * Math.PI * 2;
    const hx = 16 * Math.sin(t) ** 3;
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    // 心形原始范围 x∈[-16,16], y∈[-17,12]，归一化并留出安全边距
    slots.push({
      x: round(clamp01(0.5 + hx / 40)),
      y: round(clamp01(0.46 - hy / 40)),
      scale: round(0.72 + ((i * 7) % 5) * 0.03),
      rotation: round(((i * 13) % 11) - 5),
    });
  }
  return slots;
}

/** 整齐网格：错落的经典相册排布。 */
function gridSlots(count: number): Slot[] {
  const total = Math.max(1, count);
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(1, Math.ceil(total / cols));
  const slots: Slot[] = [];
  for (let i = 0; i < total; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    slots.push({
      x: round(clamp01(0.5 + (col - (cols - 1) / 2) * (0.72 / cols))),
      y: round(clamp01(0.5 + (row - (rows - 1) / 2) * (0.68 / rows))),
      scale: 0.82,
      rotation: round(((i * 17) % 7) - 3),
    });
  }
  return slots;
}

/** 环抱：一圈围着中心，像把某人圈在中间。 */
function ringSlots(count: number): Slot[] {
  const total = Math.max(4, count);
  const slots: Slot[] = [];
  for (let i = 0; i < total; i += 1) {
    const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
    slots.push({
      x: round(clamp01(0.5 + Math.cos(angle) * 0.31)),
      y: round(clamp01(0.5 + Math.sin(angle) * 0.29)),
      scale: round(0.7 + (i % 3) * 0.05),
      rotation: round(Math.cos(angle) * 8),
    });
  }
  return slots;
}

/** 散落：自然随手贴的感觉，带一点随机的错落与倾斜。 */
function scatterSlots(count: number): Slot[] {
  const total = Math.max(1, count);
  const slots: Slot[] = [];
  for (let i = 0; i < total; i += 1) {
    const seed = (i * 9301 + 49297) % 233280;
    const rand = seed / 233280;
    const seed2 = (i * 4177 + 12345) % 233280;
    const rand2 = seed2 / 233280;
    const col = i % 3;
    const row = Math.floor(i / 3);
    slots.push({
      x: round(clamp01(0.2 + col * 0.3 + (rand - 0.5) * 0.1)),
      y: round(clamp01(0.12 + row * 0.26 + (rand2 - 0.5) * 0.08)),
      scale: round(0.68 + rand2 * 0.22),
      rotation: round((rand - 0.5) * 20),
    });
  }
  return slots;
}

/** 心形填充：使用带最小间距的网格采样，避免照片挤成一团。 */
function fillSlots(count: number): Slot[] {
  const total = Math.max(1, count);
  const boundary = heartSlots(720).map(slot => ({ x: slot.x, y: slot.y }));
  const center = { x: 0.5, y: 0.55 };
  const contains = (point: { x: number; y: number }) => {
    let inside = false;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
      const a = boundary[i], b = boundary[j];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/((b.y-a.y)||0.000001)+a.x) inside = !inside;
    }
    return inside;
  };
  const candidates: Array<{x:number;y:number;radius:number;angle:number}> = [];
  const step = Math.max(0.045, Math.min(0.105, 0.62 / Math.sqrt(total)));
  for (let row=0, y=0.13; y<=0.91; row++, y+=step*0.866) {
    for (let col=0, x=0.08+(row%2)*step/2; x<=0.92; col++, x+=step) {
      const point={x:round(x),y:round(y)};
      if (!contains(point)) continue;
      candidates.push({...point,radius:Math.hypot(point.x-center.x,point.y-center.y),angle:Math.atan2(point.y-center.y,point.x-center.x)});
    }
  }
  // 由中心向外挑选，但同一圈交错采样；照片中心之间保持间距。
  candidates.sort((a,b)=>a.radius-b.radius || a.angle-b.angle);
  const minDistance=Math.max(0.055,Math.min(0.105,0.42/Math.sqrt(total)));
  const chosen:Array<{x:number;y:number;radius:number;angle:number}>=[];
  const stride=Math.max(1,Math.floor(candidates.length/Math.max(total*3,total)));
  const ordered=candidates.filter((_,i)=>i%stride===0).concat(candidates.filter((_,i)=>i%stride!==0));
  for(const point of ordered){
    if(chosen.every(other=>Math.hypot(other.x-point.x,other.y-point.y)>=minDistance)){
      chosen.push(point);
      if(chosen.length>=total) break;
    }
  }
  // Very large photo counts gradually relax spacing instead of stacking identical slots.
  if(chosen.length<total){
    for(const point of candidates){
      if(chosen.some(other=>other.x===point.x&&other.y===point.y)) continue;
      chosen.push(point);
      if(chosen.length>=total) break;
    }
  }
  if(!chosen.length) return gridSlots(total);
  return chosen.slice(0,total).map((point,index)=>({
    x:point.x,y:point.y,
    scale:round(Math.max(0.48,Math.min(0.76,0.76-(point.radius*0.18)))),
    rotation:round(Math.sin(point.angle*2.2+index*0.035)*3),
  }));
}

function starSlots(count:number): Slot[] {
  const total=Math.max(1,count), outline:Array<{x:number;y:number}>=[];
  for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2===0?0.39:0.18;outline.push({x:0.5+Math.cos(a)*r,y:0.5+Math.sin(a)*r});}
  const slots:Slot[]=[];
  for(let i=0;i<total;i++){
    const ring=Math.floor(Math.sqrt(i)), angle=i*2.399963229728653;
    const radius=0.025+ring*0.052;
    let x=0.5+Math.cos(angle)*radius, y=0.5+Math.sin(angle)*radius;
    // Pull candidates back toward the star's centre if they leave the star silhouette.
    const point={x,y}; let inside=false;
    for(let j=0,k=outline.length-1;j<outline.length;k=j++){
      const a=outline[j],b=outline[k];
      if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/((b.y-a.y)||1e-6)+a.x)inside=!inside;
    }
    if(!inside){x=0.5+(x-0.5)*0.58;y=0.5+(y-0.5)*0.58;}
    slots.push({x:round(clamp01(x)),y:round(clamp01(y)),scale:0.64,rotation:round(Math.sin(i*1.7)*4)});
  }
  return slots;
}
function flowerSlots(count:number): Slot[] {
  const total=Math.max(1,count),slots:Slot[]=[];
  for(let i=0;i<total;i++){const angle=i*2.399963229728653,ring=Math.floor(Math.sqrt(i));const radius=ring===0?0:ring*0.064;slots.push({x:round(clamp01(0.5+Math.cos(angle)*radius)),y:round(clamp01(0.5+Math.sin(angle)*radius)),scale:0.66,rotation:round((i%6-2.5)*3)});}
  return slots;
}
function cloudSlots(count:number): Slot[] {
  const total=Math.max(1,count),slots:Slot[]=[];
  const lobes=[{x:-.22,y:.02,r:.14},{x:-.1,y:-.09,r:.17},{x:.08,y:-.08,r:.19},{x:.23,y:.01,r:.13},{x:.08,y:.1,r:.17},{x:-.12,y:.1,r:.17}];
  for(let i=0;i<total;i++){const l=lobes[i%lobes.length],ring=Math.floor(i/lobes.length);const a=i*2.399963229728653;const rr=ring*0.045;slots.push({x:round(clamp01(0.5+l.x+Math.cos(a)*rr)),y:round(clamp01(0.5+l.y+Math.sin(a)*rr)),scale:0.62,rotation:round(Math.sin(i)*4)});}
  return slots;
}
function spiralSlots(count:number):Slot[]{
  const total=Math.max(1,count),slots:Slot[]=[];
  for(let i=0;i<total;i++){const a=i*2.399963229728653,r=0.025+0.024*Math.sqrt(i);slots.push({x:round(clamp01(.5+Math.cos(a)*r)),y:round(clamp01(.5+Math.sin(a)*r)),scale:.66,rotation:round(Math.sin(a)*6)});}
  return slots;
}

/**
 * 文字骨架：用离屏 canvas 画一遍文字，采样像素点作为落点。
 * 这样「LOVE」「家」「2024.6.1」这类都能排出来，不需要为每个字硬编码。
 */
function textSlots(text: string, count: number): Slot[] {
  const clean = text.trim().slice(0, 12) || "LOVE";
  const width = 480;
  const height = 220;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) return gridSlots(count);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return gridSlots(count);
  context.fillStyle = "#000";
  // 文字撑满画布高度，超出则缩字号
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
  const hits: { x: number; y: number }[] = [];
  const step = 6;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (data[(y * width + x) * 4 + 3] > 128) hits.push({ x: x / width, y: y / height });
    }
  }
  if (!hits.length) return gridSlots(count);
  // 在笔画点集里均匀抽 count 个落点，保证铺满整个字形而不是挤在一角
  const total = Math.max(1, count);
  const slots: Slot[] = [];
  const stride = hits.length / total;
  for (let i = 0; i < total; i += 1) {
    const hit = hits[Math.min(hits.length - 1, Math.floor(i * stride + stride / 2))];
    // 文字骨架落在画布 0.1~0.9 的视觉居中区域
    slots.push({
      x: round(clamp01(0.1 + hit.x * 0.8)),
      y: round(clamp01(0.22 + hit.y * 0.56)),
      scale: 0.46,
      rotation: round(((i * 19) % 9) - 4),
    });
  }
  return slots;
}

export const BUILTIN_TEMPLATES: PhotoWallTemplate[] = [
  { id: "builtin-heart", name: "心形", builtin: true, slots: [] },
  { id: "builtin-grid", name: "整齐网格", builtin: true, slots: [] },
  { id: "builtin-ring", name: "环抱", builtin: true, slots: [] },
  { id: "builtin-scatter", name: "随手散落", builtin: true, slots: [] },
  { id: "builtin-fill", name: "心形填充·疏朗", builtin: true, slots: [] },
  { id: "builtin-star", name: "星星", builtin: true, slots: [] },
  { id: "builtin-flower", name: "花朵", builtin: true, slots: [] },
  { id: "builtin-cloud", name: "云朵", builtin: true, slots: [] },
  { id: "builtin-spiral", name: "星河螺旋", builtin: true, slots: [] },
];

/** 按模板 id 现算骨架：数量随当前照片数变化，所以不预先固化 slots。 */
export function buildTemplateSlots(templateId: string, count: number, customText?: string): Slot[] {
  let slots: Slot[];
  switch (templateId) {
    case "builtin-heart": slots = heartSlots(count); break;
    case "builtin-grid": slots = gridSlots(count); break;
    case "builtin-ring": slots = ringSlots(count); break;
    case "builtin-scatter": slots = scatterSlots(count); break;
    case "builtin-fill": slots = fillSlots(count); break;
    case "builtin-star": slots = starSlots(count); break;
    case "builtin-flower": slots = flowerSlots(count); break;
    case "builtin-cloud": slots = cloudSlots(count); break;
    case "builtin-spiral": slots = spiralSlots(count); break;
    case "builtin-text": slots = textSlots(customText || "LOVE", count); break;
    default: {
      // 自定义模板同样使用持久化的坐标骨架；此前这里只会退回网格，
      // 导致用户保存的模板虽然出现在列表中，套用时却不会生效。
      const template = loadCustomTemplates().find(item => item.id === templateId);
      slots = template?.slots?.length
        ? template.slots.map(slot => ({
            x: round(clamp01(Number(slot.x) || 0.5)),
            y: round(clamp01(Number(slot.y) || 0.5)),
            scale: Math.min(3, Math.max(0.35, Number(slot.scale) || 0.82)),
            rotation: Math.min(45, Math.max(-45, Number(slot.rotation) || 0)),
          }))
        : gridSlots(count);
      break;
    }
  }
  if (!slots.length) return gridSlots(count);
  // Built-ins calculate the requested count. Custom templates must not recycle slots,
  // or newly added photos land exactly on top of the saved cards.
  if (!templateId.startsWith("builtin-") && slots.length < count) {
    const originalSlots = slots.slice();
    const candidates = gridSlots(Math.max(40, count * 4));
    for (const candidate of candidates) {
      if (slots.length >= count) break;
      const nearest = Math.min(...slots.map(slot => Math.hypot(slot.x - candidate.x, slot.y - candidate.y)));
      if (nearest > 0.06) slots.push({ ...candidate, scale: Math.min(candidate.scale, 0.72) });
    }
    while (slots.length < count) {
      const index = slots.length - originalSlots.length;
      const base = originalSlots[index % originalSlots.length];
      const angle = index * 2.399963229728653;
      const radius = 0.08 + (index % 4) * 0.025;
      slots.push({
        x: round(clamp01(base.x + Math.cos(angle) * radius)),
        y: round(clamp01(base.y + Math.sin(angle) * radius)),
        scale: Math.max(0.45, Math.min(0.68, base.scale * 0.72)),
        rotation: Math.max(-20, Math.min(20, base.rotation + (index % 2 ? -5 : 5))),
      });
    }
  }
  return Array.from({ length: Math.max(1, count) }, (_, index) => slots[index] ?? slots[index % slots.length]);
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
