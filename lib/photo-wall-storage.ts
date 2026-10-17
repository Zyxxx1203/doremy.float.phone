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
};

export type PhotoWallSettings = {
  dailyGenerationEnabled: boolean;
  dailyPhotoCount: 1 | 2 | 3;
  lastDailyGenerationDay?: string;
  lastDailyGenerationAt?: string;
  lastDailyGenerationError?: string;
};

export type PhotoWallState = {
  version: 1;
  photos: PhotoWallPhoto[];
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
  };
}

export function loadPhotoWallState(): PhotoWallState {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { version: 1, photos: [], settings: { ...DEFAULT_PHOTO_WALL_SETTINGS } };
    const parsed = JSON.parse(raw) as Partial<PhotoWallState>;
    const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {};
    return {
      version: 1,
      photos: Array.isArray(parsed.photos) ? parsed.photos.map(normalizePhoto).filter((photo): photo is PhotoWallPhoto => photo !== null) : [],
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
