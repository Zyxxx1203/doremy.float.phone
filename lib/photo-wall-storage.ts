import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";

export type PhotoWallAnnotation = {
  id: string;
  authorType: "user" | "character";
  authorId?: string;
  authorName: string;
  content: string;
  createdAt: string;
};

export type PhotoWallPhoto = {
  id: string;
  mediaRef: string;
  createdAt: string;
  capturedAt?: string;
  ownerType: "user" | "character";
  ownerId?: string;
  ownerName: string;
  kind: "favorite" | "selfie" | "candid" | "scenery" | "object" | "moment";
  title: string;
  caption: string;
  backNote: string;
  tags: string[];
  annotations: PhotoWallAnnotation[];
  shareWithCharacters: boolean;
  referencePhotoId?: string;
  generationPrompt?: string;
  source: "upload" | "generated" | "chat-favorite" | "life-event";
  /**
   * 贴墙布局。缺省时照片仍按旧版网格流式排布，保证老数据无损；
   * 一旦用户拖动/套用模板，就写入绝对坐标（画布百分比 0~1），
   * 这样不同屏宽下相对位置保持一致。
   */
  placement?: PhotoWallPlacement;
  /** 相框级涂鸦层：笔迹与贴纸都画在相框之上、照片之下，随照片一起保存。 */
  doodles?: PhotoWallDoodle[];
};

/** 一张照片在墙上的摆放。坐标用画布比例，避免换屏幕后错位。 */
export type PhotoWallPlacement = {
  /** 中心点横坐标，0~1（画布宽度的比例） */
  x: number;
  /** 中心点纵坐标，0~1 */
  y: number;
  /** 相对基准宽度的缩放，1 = 默认尺寸 */
  scale: number;
  /** 旋转角度，单位度 */
  rotation: number;
  /** 层叠顺序，越大越靠上 */
  z: number;
  frame: PhotoWallFrameStyle;
  /** 锁定后禁止拖动与缩放，翻面和涂鸦仍可用。 */
  locked?: boolean;
  /** 木框/纸张的底色 */
  frameColor: string;
};

export type PhotoWallFrameStyle = "polaroid" | "thin" | "wood" | "tape" | "none";

/** 相框级涂鸦：笔迹与贴纸都画在相框之上、照片之下。 */
export type PhotoWallDoodle = {
  id: string;
  kind: "stroke" | "sticker";
  /** 贴纸用的 emoji 或短字符 */
  content?: string;
  color: string;
  width: number;
  /** 归一化到相框内的坐标点，0~1 */
  points: { x: number; y: number }[];
  createdAt: string;
};

/** 一个「摆放模板」= 一组可编辑的坐标骨架，照片按顺序吸附进去。 */
export type PhotoWallTemplate = {
  id: string;
  name: string;
  /** builtin 模板随代码内置，用户自建的可删改 */
  builtin?: boolean;
  /** 骨架槽位，坐标同样是 0~1 比例 */
  slots: { x: number; y: number; scale: number; rotation: number }[];
};

export type PhotoWallSettings = {
  dailyGenerationEnabled: boolean;
  dailyPhotoCount: 1 | 2 | 3;
  lastDailyGenerationDay?: string;
  lastDailyGenerationAt?: string;
  lastDailyGenerationError?: string;
};

/**
 * 画布世界：无界墙当前的实际尺寸，单位 CSS 像素。
 *
 * 摆放坐标仍是「占世界的比例」，所以扩容时只要按比例重映射，
 * 老照片、摆放模板、涂鸦一个都不用迁移数据。
 */
export type PhotoWallWorld = { width: number; height: number };

/**
 * 初始世界尺寸：约等于旧版「3 屏宽 × 4:5」的画布。
 * 老数据第一次加载时落在这里，看起来和升级前完全一样。
 */
export const DEFAULT_PHOTO_WALL_WORLD: PhotoWallWorld = { width: 2400, height: 3000 };

/** 世界下限：再小就放不下默认落点的照片；上限防脏数据把画布撑到浏览器卡死。 */
const WALL_WORLD_MIN = 1200;
const WALL_WORLD_MAX = 12000;

export function normalizeWorld(value: unknown): PhotoWallWorld {
  const raw = value && typeof value === "object" ? value as Partial<PhotoWallWorld> : {};
  const width = typeof raw.width === "number" && Number.isFinite(raw.width) ? raw.width : DEFAULT_PHOTO_WALL_WORLD.width;
  const height = typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : DEFAULT_PHOTO_WALL_WORLD.height;
  return {
    width: Math.round(Math.min(WALL_WORLD_MAX, Math.max(WALL_WORLD_MIN, width))),
    height: Math.round(Math.min(WALL_WORLD_MAX, Math.max(WALL_WORLD_MIN, height))),
  };
}

export type PhotoWallState = {
  version: 1;
  photos: PhotoWallPhoto[];
  wallDoodles?: PhotoWallDoodle[];
  wallBackgroundRef?: string;
  /** 无界画布的世界尺寸；缺省按 DEFAULT_PHOTO_WALL_WORLD 处理。 */
  world?: PhotoWallWorld;
  settings: PhotoWallSettings;
};

const STORAGE_KEY = "ai_phone_photo_wall_v1";
registerKvMigration(STORAGE_KEY);

export const DEFAULT_PHOTO_WALL_SETTINGS: PhotoWallSettings = {
  // Daily generation is opt-in because the configured image provider may charge per image.
  dailyGenerationEnabled: false,
  dailyPhotoCount: 2,
};

function normalizePhoto(value: unknown): PhotoWallPhoto | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PhotoWallPhoto>;
  if (typeof raw.id !== "string" || typeof raw.mediaRef !== "string" || !raw.mediaRef.startsWith("media-store://")) return null;
  if (raw.ownerType !== "user" && raw.ownerType !== "character") return null;
  const kind = ["favorite", "selfie", "candid", "scenery", "object", "moment"].includes(String(raw.kind))
    ? raw.kind as PhotoWallPhoto["kind"] : "favorite";
  return {
    id: raw.id,
    mediaRef: raw.mediaRef,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : undefined,
    ownerType: raw.ownerType,
    ownerId: typeof raw.ownerId === "string" ? raw.ownerId : undefined,
    ownerName: typeof raw.ownerName === "string" ? raw.ownerName : (raw.ownerType === "user" ? "我" : "角色"),
    kind,
    title: typeof raw.title === "string" ? raw.title.slice(0, 100) : "未命名的瞬间",
    caption: typeof raw.caption === "string" ? raw.caption.slice(0, 500) : "",
    backNote: typeof raw.backNote === "string" ? raw.backNote.slice(0, 3000) : "",
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [],
    annotations: Array.isArray(raw.annotations) ? raw.annotations.filter((item): item is PhotoWallAnnotation =>
      Boolean(item && typeof item === "object" && typeof (item as PhotoWallAnnotation).id === "string" && typeof (item as PhotoWallAnnotation).content === "string"),
    ).slice(-100) : [],
    shareWithCharacters: raw.shareWithCharacters !== false,
    referencePhotoId: typeof raw.referencePhotoId === "string" ? raw.referencePhotoId : undefined,
    generationPrompt: typeof raw.generationPrompt === "string" ? raw.generationPrompt.slice(0, 4000) : undefined,
    source: raw.source === "generated" || raw.source === "chat-favorite" || raw.source === "life-event" ? raw.source : "upload",
    placement: normalizePlacement(raw.placement),
    doodles: normalizeDoodles(raw.doodles),
  };
}

/** 涂鸦归一化：坐标压进 0~1，超长笔迹截断，避免脏数据把画布拖垮。 */
export function normalizeDoodles(value: unknown): PhotoWallDoodle[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: PhotoWallDoodle[] = [];
  for (const item of value.slice(-200)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<PhotoWallDoodle>;
    if (raw.kind !== "stroke" && raw.kind !== "sticker") continue;
    if (typeof raw.id !== "string") continue;
    const points = Array.isArray(raw.points)
      ? raw.points
          .filter(point => point && typeof point === "object")
          .slice(0, 600)
          .map(point => ({ x: clamp01((point as { x?: number }).x, 0), y: clamp01((point as { y?: number }).y, 0) }))
      : [];
    if (raw.kind === "stroke" && points.length < 2) continue;
    if (raw.kind === "sticker" && !points.length) continue;
    result.push({
      id: raw.id,
      kind: raw.kind,
      content: typeof raw.content === "string" ? raw.content.slice(0, 8) : undefined,
      color: typeof raw.color === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.color) ? raw.color : "#c2705a",
      width: typeof raw.width === "number" && Number.isFinite(raw.width) ? Math.min(24, Math.max(1, raw.width)) : 3,
      points,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    });
  }
  return result.length ? result : undefined;
}

const FRAME_STYLES: PhotoWallFrameStyle[] = ["polaroid", "thin", "wood", "tape", "none"];

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, n));
}

/** 布局归一化：任何越界/非数值都回收成安全值，避免渲染出屏幕外救不回来。 */
export function normalizePlacement(value: unknown): PhotoWallPlacement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<PhotoWallPlacement>;
  const frame = FRAME_STYLES.includes(raw.frame as PhotoWallFrameStyle) ? raw.frame as PhotoWallFrameStyle : "polaroid";
  const scale = typeof raw.scale === "number" && Number.isFinite(raw.scale) ? Math.min(3, Math.max(0.35, raw.scale)) : 1;
  const rotation = typeof raw.rotation === "number" && Number.isFinite(raw.rotation) ? Math.min(45, Math.max(-45, raw.rotation)) : 0;
  const z = typeof raw.z === "number" && Number.isFinite(raw.z) ? Math.round(raw.z) : 1;
  return {
    x: clamp01(raw.x, 0.5),
    y: clamp01(raw.y, 0.5),
    scale,
    rotation,
    z,
    frame,
    locked: raw.locked === true,
    frameColor: typeof raw.frameColor === "string" && /^#[0-9a-f]{3,8}$/i.test(raw.frameColor) ? raw.frameColor : "#fffdf8",
  };
}

export function loadPhotoWallState(): PhotoWallState {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { version: 1, photos: [], settings: { ...DEFAULT_PHOTO_WALL_SETTINGS } };
    const parsed = JSON.parse(raw) as Partial<PhotoWallState>;
    const settings: Partial<PhotoWallSettings> = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    return {
      version: 1,
      photos: Array.isArray(parsed.photos) ? parsed.photos.map(normalizePhoto).filter((photo): photo is PhotoWallPhoto => photo !== null) : [],
      wallDoodles: normalizeDoodles(parsed.wallDoodles),
      wallBackgroundRef: typeof parsed.wallBackgroundRef === "string" && parsed.wallBackgroundRef.startsWith("media-store://") ? parsed.wallBackgroundRef : undefined,
      world: normalizeWorld(parsed.world),
      settings: {
        dailyGenerationEnabled: settings.dailyGenerationEnabled === true,
        dailyPhotoCount: settings.dailyPhotoCount === 1 || settings.dailyPhotoCount === 3 ? settings.dailyPhotoCount : 2,
        lastDailyGenerationDay: typeof settings.lastDailyGenerationDay === "string" ? settings.lastDailyGenerationDay : undefined,
        lastDailyGenerationAt: typeof settings.lastDailyGenerationAt === "string" ? settings.lastDailyGenerationAt : undefined,
        lastDailyGenerationError: typeof settings.lastDailyGenerationError === "string" ? settings.lastDailyGenerationError : undefined,
      },
    };
  } catch {
    return { version: 1, photos: [], settings: { ...DEFAULT_PHOTO_WALL_SETTINGS } };
  }
}

export function savePhotoWallState(state: PhotoWallState): void {
  const next: PhotoWallState = {
    version: 1,
    photos: state.photos.map(normalizePhoto).filter((photo): photo is PhotoWallPhoto => photo !== null),
    wallDoodles: normalizeDoodles(state.wallDoodles),
    wallBackgroundRef: typeof state.wallBackgroundRef === "string" && state.wallBackgroundRef.startsWith("media-store://") ? state.wallBackgroundRef : undefined,
    world: normalizeWorld(state.world),
    settings: {
      ...DEFAULT_PHOTO_WALL_SETTINGS,
      ...state.settings,
      dailyGenerationEnabled: state.settings.dailyGenerationEnabled === true,
      dailyPhotoCount: state.settings.dailyPhotoCount === 1 || state.settings.dailyPhotoCount === 3 ? state.settings.dailyPhotoCount : 2,
    },
  };
  kvSet(STORAGE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("photo-wall-updated"));
}

export function createPhotoWallId(): string {
  return `photo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
