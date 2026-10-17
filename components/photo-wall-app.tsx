"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, Feather, Heart, ImagePlus, LoaderCircle, MessageCircle, MoreHorizontal, PenLine, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
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
  type PhotoWallAnnotation, type PhotoWallPhoto, type PhotoWallState,
} from "@/lib/photo-wall-storage";

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Filter = "all" | "mine" | "characters" | "favorites";

const KIND_LABEL: Record<PhotoWallPhoto["kind"], string> = {
  favorite: "珍藏", selfie: "自拍", candid: "不经意的你", scenery: "沿途风景", object: "喜欢的小物", moment: "共同瞬间",
};
const KIND_OPTIONS: PhotoWallPhoto["kind"][] = ["favorite", "selfie", "candid", "scenery", "object", "moment"];
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "某个日子";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function makeAnnotation(authorType: "user" | "character", authorName: string, content: string, authorId?: string): PhotoWallAnnotation {
  return { id: createPhotoWallId(), authorType, authorName, authorId, content: content.trim(), createdAt: new Date().toISOString() };
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
  return <button onClick={onOpen} className="group relative block w-full overflow-hidden rounded-[20px] border border-white/80 bg-[#fffdf8] text-left shadow-[0_8px_24px_rgba(75,60,43,.08)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_12px_26px_rgba(75,60,43,.15)]">
    <div className="aspect-[4/5] overflow-hidden rounded-t-[19px] bg-[#e9e3d8]">
      {src ? <img src={src} alt={photo.title} loading="lazy" className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.025]" /> : <div className="grid h-full place-items-center text-[#9c907f]"><ImagePlus size={25}/></div>}
    </div>
    <div className="px-3.5 pb-3.5 pt-3">
      <div className="flex items-center justify-between gap-2"><span className="truncate font-serif text-[15px] text-[#54483d]">{photo.title || "未命名的瞬间"}</span>{photo.annotations.length > 0 && <MessageCircle size={13} className="shrink-0 text-[#a17b64]"/>}</div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] tracking-[.12em] text-[#9b8d7b]"><span className="truncate">{photo.ownerName}</span><span>{new Date(photo.createdAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</span></div>
    </div>
    <span className="absolute left-2 top-2 rounded-full border border-white/75 bg-[#fffaf0]/90 px-2.5 py-1.5 text-[10px] tracking-wider shadow-sm backdrop-blur text-[#7f6b58]">{KIND_LABEL[photo.kind]}</span>
  </button>;
}

export function PhotoWallApp({ onClose, onNotice }: Props) {
  const [state, setState] = useState<PhotoWallState>(() => loadPhotoWallState());
  const [characters, setCharacters] = useState<Character[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editTags, setEditTags] = useState("");
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [newKind, setNewKind] = useState<PhotoWallPhoto["kind"]>("favorite");
  const [referencePhotoId, setReferencePhotoId] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showChatPicker, setShowChatPicker] = useState(false);
  const [chatCandidates, setChatCandidates] = useState<Array<{ key: string; ref: string; title: string; sessionName: string; createdAt: string }>>([]);
  const [characterCommenterId, setCharacterCommenterId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const autoRunRef = useRef(false);

  const persist = useCallback((next: PhotoWallState) => {
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
    const refresh = () => setState(loadPhotoWallState());
    window.addEventListener("photo-wall-updated", refresh);
    window.addEventListener("characters-updated", refreshCharacters);
    return () => { window.removeEventListener("photo-wall-updated", refresh); window.removeEventListener("characters-updated", refreshCharacters); };
  }, [refreshCharacters]);

  const photos = useMemo(() => state.photos.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.photos]);
  const visiblePhotos = useMemo(() => photos.filter(photo => {
    if (filter === "mine") return photo.ownerType === "user";
    if (filter === "characters") return photo.ownerType === "character";
    if (filter === "favorites") return photo.kind === "favorite" || photo.kind === "moment";
    return true;
  }), [photos, filter]);
  const selectedPhoto = photos.find(photo => photo.id === selectedPhotoId) ?? null;
  const selectedCharacter = characters.find(char => char.id === selectedCharacterId) ?? characters[0] ?? null;
  const commenter = characters.find(char => char.id === characterCommenterId) ?? characters[0] ?? null;

  const addPhoto = useCallback((photo: PhotoWallPhoto) => {
    const current = loadPhotoWallState();
    persist({ ...current, photos: [photo, ...current.photos.filter(item => item.id !== photo.id)] });
    setSelectedPhotoId(photo.id);
  }, [persist]);

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
      persist({ ...current, photos: [...created, ...current.photos] });
      setSelectedPhotoId(created[0]?.id ?? null);
      onNotice?.(`已收藏 ${created.length} 张照片。`);
    } catch (error) { onNotice?.("收藏失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
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
      const description = [
        "为私人生活照片墙生成一张有真实相机质感的照片，而不是插画、海报、拼贴或文字卡片。",
        `照片拍摄者/角色：${owner.name}。角色设定：${(owner.persona || owner.personality || "").slice(0, 700)}。`,
        `照片类型：${kindPrompt[kind]}`, eventText, referenceText,
        "审美：温柔、文艺、自然光、低饱和胶片色彩、细微颗粒、构图克制、真实生活细节；不要出现文字、水印、拼接边框或不自然的手指。",
      ].filter(Boolean).join("\n");
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
    const nextPhoto = { ...selectedPhoto, title: editTitle.trim() || "未命名的瞬间", backNote: editNote, tags: editTags.split(/[,，#\n]/).map(tag => tag.trim()).filter(Boolean).slice(0, 20) };
    persist({ ...state, photos: state.photos.map(photo => photo.id === nextPhoto.id ? nextPhoto : photo) });
    onNotice?.("照片背面的手记已保存。");
  };

  const addUserAnnotation = () => {
    if (!selectedPhoto || !annotationDraft.trim()) return;
    const annotation = makeAnnotation("user", "我", annotationDraft);
    persist({ ...state, photos: state.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, annotations: [...photo.annotations, annotation] } : photo) });
    setAnnotationDraft("");
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
        `照片背面记录：${selectedPhoto.backNote || selectedPhoto.caption || "还没有写下记录"}。`,
        `标签：${selectedPhoto.tags.join("、") || "没有标签"}。`,
        `已有批注：${selectedPhoto.annotations.map(note => `${note.authorName}：${note.content}`).join("；") || "还没有批注"}。`,
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
      const annotation = makeAnnotation("character", commenter.name, content, commenter.id);
      const fresh = loadPhotoWallState();
      persist({ ...fresh, photos: fresh.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, annotations: [...photo.annotations, annotation] } : photo) });
      onNotice?.(`${commenter.name}在照片背面留了一句话。`);
    } catch (error) { onNotice?.("请角色写批注失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const deleteSelectedPhoto = async () => {
    if (!selectedPhoto || !window.confirm("确定把这张照片从照片墙移除吗？这会删除图片文件，但不会删除其他照片或聊天记录。")) return;
    try {
      const ref = selectedPhoto.mediaRef;
      const sharedByAnotherPhoto = state.photos.some(photo => photo.id !== selectedPhoto.id && photo.mediaRef === ref);
      persist({ ...state, photos: state.photos.filter(photo => photo.id !== selectedPhoto.id) });
      // Chat favorites intentionally share the original media ref with the chat.
      // Never delete a shared blob when removing only its photo-wall card.
      if (!sharedByAnotherPhoto && selectedPhoto.source !== "chat-favorite") await deleteMediaRef(ref);
      setSelectedPhotoId(null);
      onNotice?.("照片已移除。");
    } catch (error) { onNotice?.("移除失败：" + (error instanceof Error ? error.message : String(error))); }
  };

  const openPhoto = (photo: PhotoWallPhoto) => {
    setSelectedPhotoId(photo.id); setEditTitle(photo.title); setEditNote(photo.backNote); setEditTags(photo.tags.join("、"));
  };

  return <div className="photo-wall-app pointer-events-auto isolate absolute inset-0 z-[1000] flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,#fffdf8_0%,#f4f0e7_58%,#e9e1d4_100%)] text-[#51483d]" style={{ fontFamily: '"Noto Serif SC", "Songti SC", serif' }}>
    <header className="relative z-[1001] flex shrink-0 items-center gap-3 border-b border-[#ded5c7]/80 bg-white/75 px-4 py-3 shadow-[0_8px_28px_rgba(94,76,53,.06)] backdrop-blur-xl">
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#ded5c7] bg-white/80 text-[#7b6a58] shadow-sm transition hover:-translate-y-0.5 hover:bg-white active:scale-95" aria-label="返回"><ArrowLeft size={17}/></button>
      <div className="min-w-0 flex-1"><div className="font-serif text-xl tracking-[.12em]">照片墙</div><div className="mt-0.5 text-[10px] tracking-[.2em] text-[#a09380]">A LITTLE ARCHIVE OF US · {photos.length} PHOTOS</div></div>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowSettings(value => !value); }} className="relative z-[1002] pointer-events-auto min-h-11 cursor-pointer touch-manipulation rounded-2xl border border-[#ded5c7] bg-white/75 px-4 py-2 text-xs tracking-wider text-[#85735f] shadow-sm transition hover:bg-white active:scale-95">设置</button>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowAddMenu(value => !value); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 cursor-pointer touch-manipulation place-items-center rounded-2xl bg-gradient-to-br from-[#9ba68e] to-[#6f7d65] text-white shadow-[0_8px_18px_rgba(92,109,81,.25)] transition hover:-translate-y-0.5 active:scale-95" aria-label="添加照片"><Plus size={18}/></button>
    </header>

    {showAddMenu && <div className="absolute right-4 top-[62px] z-30 w-56 rounded-2xl border border-[#e4d9c9] bg-[#fffdf8] p-2 shadow-xl">
      <button onClick={() => { setShowAddMenu(false); fileRef.current?.click(); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-[#f3ede2]"><ImagePlus size={17}/>收藏我的照片</button>
      <button onClick={() => void openChatPicker()} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-[#f3ede2]"><Heart size={17}/>从聊天收藏照片</button>
      <button onClick={() => { setShowAddMenu(false); void generatePhoto(selectedCharacter, "moment"); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-[#f3ede2]"><Sparkles size={17}/>请角色生成一张</button>
      <button onClick={() => { setShowAddMenu(false); setShowSettings(true); }} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm hover:bg-[#f3ede2]"><Camera size={17}/>今日照片与生成设置</button>
    </div>}
    <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={event => { if (event.target.files) void uploadFiles(event.target.files); event.currentTarget.value = ""; }}/>

    <main className="min-h-0 flex-1 overflow-y-auto">
      <section className="relative overflow-hidden border-b border-[#e1d7c8] px-5 pb-6 pt-7 sm:px-8">
        <div className="pointer-events-none absolute -right-6 -top-10 h-48 w-48 rounded-full border border-[#d6cbb9]/70"/><div className="pointer-events-none absolute -right-1 top-0 h-36 w-36 rounded-full border border-[#d6cbb9]/50"/>
        <div className="relative max-w-2xl"><div className="text-[10px] tracking-[.32em] text-[#a0927e]">THE THINGS WE KEEP</div><h1 className="mt-3 font-serif text-[30px] font-normal leading-tight tracking-[.08em] sm:text-[38px]">把日子，慢慢收好。</h1><p className="mt-3 max-w-md text-xs leading-6 tracking-wide text-[#887a68]">有些照片不是为了证明发生过什么，只是因为那一刻，心里很柔软。</p><div className="mt-5 flex items-center gap-3 text-[10px] tracking-[.15em] text-[#9d8d78]"><span className="h-px w-8 bg-[#b9a68e]"/><span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</span><span>·</span><span>{characters.length} 位角色在这里留下痕迹</span></div></div>
      </section>

      {showSettings && <section className="border-b border-[#e2d8ca] bg-[#eee8dc] px-5 py-4 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between"><h2 className="font-serif text-lg">日常显影</h2><button onClick={() => setShowSettings(false)} aria-label="关闭设置"><X size={17}/></button></div>
          <p className="mt-1 text-xs leading-5 text-[#897a67]">开启后，每天首次打开照片墙时，角色会依据最近的生活记录生成照片。仅在应用运行时触发；图片由你配置的生图服务生成，可能产生 API 费用。</p>
          <label className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-[#f8f4ed] p-3 text-sm"><span>每日自动生成</span><input type="checkbox" checked={state.settings.dailyGenerationEnabled} onChange={event => persist({ ...state, settings: { ...state.settings, dailyGenerationEnabled: event.target.checked } })} className="h-4 w-4 accent-[#78876b]"/></label>
          <div className="mt-2 flex items-center justify-between gap-4 rounded-xl bg-[#f8f4ed] p-3 text-sm"><span>每天最多生成</span><select value={state.settings.dailyPhotoCount} onChange={event => persist({ ...state, settings: { ...state.settings, dailyPhotoCount: Number(event.target.value) as 1 | 2 | 3 } })} className="rounded-lg border border-[#e1d7c8] bg-white px-2 py-1"><option value={1}>1 张</option><option value={2}>2 张</option><option value={3}>3 张</option></select></div>
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-[#f8f4ed] p-3 text-xs"><span className="text-[#897a67]">生成参考图（可选）</span><select value={referencePhotoId} onChange={event => setReferencePhotoId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[#e1d7c8] bg-white px-2 py-2"><option value="">不指定照片，使用角色外观参考设置</option>{photos.map(photo => <option key={photo.id} value={photo.id}>{photo.title}</option>)}</select></div>
          {state.settings.lastDailyGenerationAt && <p className="mt-2 text-[11px] text-[#93836e]">上次显影：{formatDate(state.settings.lastDailyGenerationAt)}{state.settings.lastDailyGenerationError ? ` · 上次有错误：${state.settings.lastDailyGenerationError}` : ""}</p>}
          <button disabled={busy || !selectedCharacter} onClick={() => void generatePhoto(selectedCharacter, "moment")} className="mt-3 rounded-full bg-[#78866d] px-4 py-2 text-xs tracking-wider text-white disabled:opacity-50"><Sparkles size={13} className="mr-1 inline"/>现在生成一张</button>
        </div>
      </section>}

      <nav className="sticky top-0 z-10 flex items-center gap-2 overflow-x-auto border-b border-[#e4dbce]/80 bg-[#fffaf1]/90 px-4 py-3 backdrop-blur-xl sm:px-8">
        {([{id:"all",label:"全部记忆"},{id:"mine",label:"我收藏的"},{id:"characters",label:"角色留下的"},{id:"favorites",label:"值得珍藏"}] as {id:Filter;label:string}[]).map(item => <button key={item.id} onClick={() => setFilter(item.id)} className={`shrink-0 rounded-full px-4 py-2.5 text-xs font-medium tracking-wide transition duration-200 ${filter===item.id?"bg-[#7e8a72] text-white":"text-[#8d7e6b] border border-transparent hover:border-[#ddd1bd] hover:bg-white"}`}>{item.label}</button>)}
        <span className="ml-auto hidden shrink-0 text-[10px] tracking-wider text-[#aa9a86] sm:block">点开照片 · 翻到背面</span>
      </nav>

      <section className="px-4 pb-24 pt-5 sm:px-7">
        {busy && <div className="mb-4 flex items-center gap-2 rounded-xl border border-[#e4d8c6] bg-[#faf7f0] px-3 py-3 text-xs text-[#83725d]"><LoaderCircle size={15} className="animate-spin"/>{busyLabel || "请稍候…"}</div>}
        {visiblePhotos.length ? <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3.5 sm:grid-cols-3 sm:gap-5 lg:grid-cols-3">{visiblePhotos.map(photo => <PhotoThumbnail key={photo.id} photo={photo} onOpen={() => openPhoto(photo)}/>)}</div> : <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center"><div className="grid h-16 w-16 place-items-center rounded-full border border-[#ddd0bd] text-[#a0917d]"><Feather size={24}/></div><h2 className="mt-5 font-serif text-xl font-normal">这里还留着空白</h2><p className="mt-2 text-xs leading-6 text-[#968674]">先收藏一张你喜欢的照片。之后，角色也会把自己想珍藏的风景、自拍和生活片段慢慢放进来。</p><button onClick={() => fileRef.current?.click()} className="mt-5 rounded-full border border-[#b7a48c] px-5 py-2.5 text-xs tracking-wider text-[#786953]">收藏第一张照片</button></div>}
      </section>
    </main>

    {showChatPicker && <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#332c24]/40 p-4 backdrop-blur-sm" onClick={() => setShowChatPicker(false)}>
      <section className="flex max-h-[82%] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-[#e3d7c6] bg-[#fffaf1] shadow-xl" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-[#e3d7c6] px-4 py-3"><div><h2 className="font-serif text-lg">从聊天里挑一张</h2><p className="mt-1 text-[10px] text-[#9b8a75]">收藏会保留原图，不会把同一张媒体重复复制</p></div><button onClick={() => setShowChatPicker(false)} aria-label="关闭"><X size={17}/></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {chatCandidates.length ? <div className="space-y-2">{chatCandidates.map(candidate => <button key={candidate.key} onClick={() => void importChatPhoto(candidate)} className="flex w-full items-center gap-3 rounded-xl border border-[#e6dccd] bg-[#fcf9f2] p-3 text-left hover:bg-white"><ChatCandidateThumb refId={candidate.ref}/><span className="min-w-0 flex-1"><span className="block truncate text-sm text-[#655647]">{candidate.title}</span><span className="mt-1 block truncate text-[10px] text-[#9a8973]">{candidate.sessionName} · {new Date(candidate.createdAt).toLocaleDateString("zh-CN")}</span></span><Plus size={15} className="shrink-0 text-[#849174]"/></button>)}</div> : <p className="py-10 text-center text-xs text-[#9a8973]">没有找到可收藏的照片。</p>}
        </div>
      </section>
    </div>}

    {selectedPhoto && <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#332c24]/48 p-3 backdrop-blur-md" onClick={() => setSelectedPhotoId(null)}>
      <div className="relative flex max-h-[94%] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-[#e3d7c6] bg-[#fffaf1] shadow-[0_24px_80px_rgba(20,15,10,.28)] sm:flex-row" onClick={event => event.stopPropagation()}>
        <button onClick={() => setSelectedPhotoId(null)} className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-[#f7f2e8]/90 text-[#7c6b58]" aria-label="关闭"><X size={16}/></button>
        <div className="flex max-h-[46vh] min-h-[220px] items-center justify-center bg-[#e7dfd2] sm:max-h-none sm:min-h-0 sm:w-1/2">
          <PhotoLarge refId={selectedPhoto.mediaRef} title={selectedPhoto.title}/>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-6 sm:px-6 sm:pt-8">
          <div className="text-[10px] tracking-[.25em] text-[#aa987f]">{selectedPhoto.ownerName.toUpperCase()} · {KIND_LABEL[selectedPhoto.kind]}</div>
          <input value={editTitle} onChange={event => setEditTitle(event.target.value)} className="mt-3 w-full border-b border-[#dfd3c1] bg-transparent pb-2 font-serif text-xl text-[#5b4d3e] outline-none focus:border-[#9e8b70]" placeholder="给这张照片起个名字"/>
          <p className="mt-2 text-[10px] tracking-wider text-[#a39583]">{formatDate(selectedPhoto.createdAt)}</p>
          <label className="mt-5 block text-[10px] tracking-[.2em] text-[#9a8973]">背面手记 / THE BACK OF THE PHOTO</label>
          <textarea value={editNote} onChange={event => setEditNote(event.target.value)} rows={4} placeholder="写下当时的天气、心情，或一个只有你们懂的细节……" className="mt-2 w-full resize-y rounded-sm border border-[#e6dccd] bg-[#fcf9f2] p-3 font-serif text-sm leading-6 text-[#655647] outline-none placeholder:text-[#c1b5a4] focus:border-[#b5a18a]"/>
          <label className="mt-3 block text-[10px] tracking-[.2em] text-[#9a8973]">标签 · TAGS</label>
          <input value={editTags} onChange={event => setEditTags(event.target.value)} placeholder="用逗号分隔，比如：雨天、回家、幸福" className="mt-2 w-full rounded-sm border border-[#e6dccd] bg-[#fcf9f2] px-3 py-2 text-xs outline-none focus:border-[#b5a18a]"/>
          <label className="mt-3 flex items-center gap-2 text-xs text-[#857460]"><input type="checkbox" checked={selectedPhoto.shareWithCharacters} onChange={event => persist({ ...state, photos: state.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, shareWithCharacters: event.target.checked } : photo) })} className="accent-[#78866d]"/>允许角色看到这张照片及背面记录</label>
          <div className="mt-4 flex gap-2"><button onClick={saveBack} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#78866d] px-3 py-2.5 text-xs tracking-wider text-white"><Check size={14}/>保存背面</button><button onClick={() => void deleteSelectedPhoto()} className="grid h-10 w-10 place-items-center rounded-full border border-[#e3d7c6] text-[#9c7566]" aria-label="删除照片"><Trash2 size={15}/></button></div>
          <div className="mt-6 border-t border-[#e3d7c6] pt-4">
            <div className="flex items-center justify-between"><div className="font-serif text-base">留在照片背面的字</div><span className="text-[10px] text-[#aa9a86]">{selectedPhoto.annotations.length} 条批注</span></div>
            {selectedPhoto.annotations.length > 0 ? <div className="mt-3 space-y-3">{selectedPhoto.annotations.map(note => <div key={note.id} className={`border-l-2 pl-3 py-1 ${note.authorType==="character"?"border-[#9aab8b]":"border-[#c7a58b]"}`}><div className="flex items-baseline justify-between gap-2"><span className="text-xs text-[#786954]">{note.authorName}</span><span className="text-[9px] text-[#b0a18e]">{new Date(note.createdAt).toLocaleDateString("zh-CN")}</span></div><p className="mt-1 whitespace-pre-wrap font-serif text-sm leading-6 text-[#655647]">{note.content}</p></div>)}</div> : <p className="mt-2 text-xs leading-5 text-[#a19380]">还没有人写下批注。可以先写一句，也可以请角色来看看。</p>}
            <textarea value={annotationDraft} onChange={event => setAnnotationDraft(event.target.value)} rows={2} placeholder="给这张照片留一句话…" className="mt-4 w-full resize-none rounded-sm border border-[#e6dccd] bg-[#fcf9f2] p-3 text-xs leading-5 outline-none placeholder:text-[#c1b5a4]"/>
            <button onClick={addUserAnnotation} disabled={!annotationDraft.trim()} className="mt-2 rounded-full border border-[#cbbba6] px-3 py-2 text-xs text-[#796952] disabled:opacity-40"><PenLine size={12} className="mr-1 inline"/>写下我的批注</button>
            <div className="mt-4 rounded-xl bg-[#eee7db] p-3">
              <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-[#85745f]">请角色也来看看</span><select value={characterCommenterId} onChange={event => setCharacterCommenterId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[#ded1bf] bg-[#faf6ee] px-2 py-2 text-xs">{characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}</select></div>
              <button onClick={() => void askCharacterToWrite()} disabled={busy || !commenter || !selectedPhoto.shareWithCharacters} className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-[#8b9a7e] px-3 py-2.5 text-xs tracking-wider text-white disabled:opacity-40"><Heart size={13}/>请TA在照片背面写一句话</button>
              {!selectedPhoto.shareWithCharacters && <p className="mt-2 text-[10px] text-[#9a7967]">这张照片目前不对角色开放。打开上方分享开关后，角色才可以回应。</p>}
            </div>
          </div>
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
