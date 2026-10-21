/**
 * Relationship event/execution layer.
 *
 * Decisions are made from the existing relationship state values and recent chat,
 * while execution is responsible for producing a persistent, clickable keepsake card.
 * This module intentionally does not access the device camera or silently capture screens.
 */
import { loadChatMessages, loadChatSessions, pushChatMessage, type ChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";

export type RelationshipArtifactType =
  | "apology" | "reflection" | "reconciliation" | "confession" | "privilege"
  | "jealousy" | "candid_photo" | "couple_photo" | "invitation" | "promise";

export type RelationshipEventKind = "argument" | "reconciliation" | "jealousy" | "affection" | "date" | "spontaneous";

export type RelationshipArtifactDraft = {
  type: RelationshipArtifactType;
  title: string;
  subtitle?: string;
  body: string;
  signature?: string;
  imageUrl?: string;
  accent?: string;
  eventId?: string;
};

const STORAGE_KEY = "momo.relationship-artifacts.v1";
const COOLDOWN_KEY = "momo.relationship-artifact-cooldowns.v1";

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be full */ }
}

export type RelationshipArtifactRecord = RelationshipArtifactDraft & {
  id: string;
  characterId: string;
  sessionId: string;
  createdAt: string;
  acknowledgedAt?: string;
};

export function listRelationshipArtifacts(characterId?: string): RelationshipArtifactRecord[] {
  const all = readJson<RelationshipArtifactRecord[]>(STORAGE_KEY, []);
  return all.filter(item => !characterId || item.characterId === characterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markRelationshipArtifactAcknowledged(id: string): void {
  const all = readJson<RelationshipArtifactRecord[]>(STORAGE_KEY, []);
  writeJson(STORAGE_KEY, all.map(item => item.id === id ? { ...item, acknowledgedAt: new Date().toISOString() } : item));
}

function artifactAccent(type: RelationshipArtifactType): string {
  if (type === "privilege" || type === "invitation") return "#b18b4f";
  if (type === "reflection" || type === "candid_photo") return "#9b7a69";
  if (type === "jealousy" || type === "promise") return "#a87883";
  return "#bd7189";
}

/** Store an artifact and deliver a special chat card. Repeated event IDs are idempotent. */
export function deliverRelationshipArtifact(
  sessionId: string,
  characterId: string,
  draft: RelationshipArtifactDraft,
): RelationshipArtifactRecord | null {
  if (typeof window === "undefined" || !sessionId || !characterId || !draft.body.trim()) return null;
  const eventId = draft.eventId?.trim();
  const existing = listRelationshipArtifacts(characterId).find(item =>
    eventId && item.eventId === eventId && item.sessionId === sessionId
  );
  if (existing) return existing;

  const record: RelationshipArtifactRecord = {
    ...draft,
    id: `keepsake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    sessionId,
    createdAt: new Date().toISOString(),
    accent: draft.accent || artifactAccent(draft.type),
  };
  const all = readJson<RelationshipArtifactRecord[]>(STORAGE_KEY, []);
  writeJson(STORAGE_KEY, [record, ...all].slice(0, 500));

  pushChatMessage({
    sessionId,
    role: "assistant",
    content: record.body,
    mediaType: "relationship_artifact",
    mediaData: {
      relationshipArtifactId: record.id,
      relationshipArtifactType: record.type,
      appCardTitle: record.title,
      relationshipArtifactSubtitle: record.subtitle,
      relationshipArtifactBody: record.body,
      relationshipArtifactSignature: record.signature,
      relationshipArtifactAccent: record.accent,
      relationshipArtifactImageUrl: record.imageUrl,
    },
  });
  return record;
}

export type RelationshipEventDecision = {
  eligible: boolean;
  kind: RelationshipEventKind;
  suggestedArtifact: RelationshipArtifactType;
  reason: string;
};

/**
 * Event-layer recommendation, not an unconditional trigger.
 * The caller should provide a stable event ID and let the character's response/context
 * supply the actual prose. Existing state values are reused; no second emotion scale.
 */
export function evaluateRelationshipEvent(input: {
  event: RelationshipEventKind;
  stateValues?: Array<{ name: string; value: number }>;
  recentMessages?: Array<Pick<ChatMessage, "role" | "content" | "createdAt">>;
  lastArtifactAt?: string;
  now?: number;
}): RelationshipEventDecision {
  const values = input.stateValues || [];
  const find = (terms: string[]) => values.find(v => terms.some(t => v.name.includes(t)))?.value ?? 0;
  const possessiveness = find(["占有欲"]);
  const jealousy = find(["吃醋", "嫉妒"]);
  const trust = find(["信任"]);
  const now = input.now ?? Date.now();
  const last = input.lastArtifactAt ? new Date(input.lastArtifactAt).getTime() : 0;
  const cooldownPassed = !last || !Number.isFinite(last) || now - last >= 6 * 60 * 60 * 1000;
  const recentText = (input.recentMessages || []).slice(-8).map(m => m.content).join("\n");
  const recentArgument = /吵架|生气|误会|冷战|分手|道歉|和好/.test(recentText);

  let suggestedArtifact: RelationshipArtifactType = "confession";
  let reason = "关系氛围适合留下一份小小的心意";
  if (input.event === "argument") {
    suggestedArtifact = trust < 35 ? "reflection" : "apology";
    reason = "发生争执后，用认真回应而不是强行跳过矛盾";
  } else if (input.event === "reconciliation") {
    suggestedArtifact = "reconciliation";
    reason = "和好后把这次关系变化留成纪念";
  } else if (input.event === "jealousy") {
    suggestedArtifact = possessiveness >= 70 || jealousy >= 60 ? "privilege" : "jealousy";
    reason = "占有欲/吃醋状态较强，可用带边界感的表达传递在意";
  } else if (input.event === "date") {
    suggestedArtifact = "invitation";
    reason = "把约会变成可回看的邀请函";
  } else if (input.event === "affection") {
    suggestedArtifact = possessiveness >= 75 ? "promise" : "confession";
    reason = "亲密互动后留下一份专属纪念";
  } else if (input.event === "spontaneous") {
    suggestedArtifact = Math.random() < 0.5 ? "candid_photo" : "couple_photo";
    reason = "偶发的生活瞬间适合成为照片收藏";
  }

  const eligible = cooldownPassed && (
    input.event === "argument" || input.event === "reconciliation" || input.event === "date" ||
    (input.event === "jealousy" && (possessiveness >= 55 || jealousy >= 50)) ||
    (input.event === "affection" && (possessiveness >= 45 || recentArgument)) ||
    (input.event === "spontaneous" && Math.random() < 0.2)
  );
  return { eligible, kind: input.event, suggestedArtifact, reason };
}

/** Used by event dispatchers to avoid repeating popups/cards after re-render or reload. */
export function canFireRelationshipEvent(characterId: string, eventKey: string, cooldownMs = 6 * 60 * 60 * 1000): boolean {
  const key = `${characterId}:${eventKey}`;
  const map = readJson<Record<string, number>>(COOLDOWN_KEY, {});
  const last = map[key] || 0;
  if (Date.now() - last < cooldownMs) return false;
  map[key] = Date.now();
  writeJson(COOLDOWN_KEY, map);
  return true;
}

export function getRelationshipCharacterName(characterId: string): string {
  return loadCharacters().find(item => item.id === characterId)?.name || "TA";
}

export function getRelationshipSession(sessionId: string) {
  return loadChatSessions().find(item => item.id === sessionId) || null;
}

export function getRecentRelationshipMessages(sessionId: string, count = 12): ChatMessage[] {
  return loadChatMessages(sessionId).slice(-Math.max(1, count));
}


/* ─────────────────────────────────────────────────────────────
 * Keepsake inventory: characters may ask for an item, but it only
 * enters their inventory after the user grants it. Owned items are
 * single-use unless the catalog explicitly says otherwise.
 * ───────────────────────────────────────────────────────────── */

export type RelationshipKeepsakeKind = "privilege" | "date_pass" | "reconciliation" | "photo_request" | "promise";
export type RelationshipKeepsakeCatalogItem = {
  id: string;
  kind: RelationshipKeepsakeKind;
  name: string;
  description: string;
  effect: string;
  reusable: boolean;
  icon: string;
};
export type RelationshipKeepsakeRequest = {
  id: string;
  characterId: string;
  sessionId: string;
  keepsakeId: string;
  message: string;
  reason: string;
  status: "pending" | "granted" | "declined";
  createdAt: string;
  resolvedAt?: string;
};
export type OwnedRelationshipKeepsake = {
  id: string;
  catalogId: string;
  characterId: string;
  grantedAt: string;
  source: "user_reward" | "event_reward";
  status: "available" | "used";
  usedAt?: string;
  useResultId?: string;
};
export type RelationshipDatePlan = {
  id: string;
  keepsakeInstanceId: string;
  characterId: string;
  sessionId: string;
  title: string;
  locationId: string;
  locationName: string;
  scene: string;
  plannedActivity: string[];
  openingBeat: string;
  possibleBeats: string[];
  keepsakesOrProps: string[];
  userChoiceRequired: string[];
  status: "draft" | "accepted" | "in_progress" | "completed" | "canceled";
  createdAt: string;
  updatedAt: string;
  outcome?: string;
};

const INVENTORY_KEY = "momo.relationship-keepsake-inventory.v1";
const REQUESTS_KEY = "momo.relationship-keepsake-requests.v1";
const DATE_PLANS_KEY = "momo.relationship-date-plans.v1";

export const RELATIONSHIP_KEEPSAKE_CATALOG: RelationshipKeepsakeCatalogItem[] = [
  { id: "privilege_once", kind: "privilege", name: "专属特权卡", description: "一张只属于你们的特殊通行证。", effect: "使用后可提出一项明确、合理且可拒绝的专属请求；使用结果会被记录。", reusable: false, icon: "✧" },
  { id: "date_pass", kind: "date_pass", name: "约会兑换券", description: "把一次普通邀约升级成完整约会事件。", effect: "兑换后先生成约会计划，确认地点、场景、活动与可选走向，再由你决定是否开始。", reusable: false, icon: "♡" },
  { id: "make_up_pass", kind: "reconciliation", name: "和好券", description: "不是跳过矛盾，而是给认真修复关系一个机会。", effect: "使用后开启和好互动；仍需回应争执原因，不会自动抹掉矛盾。", reusable: false, icon: "✉" },
  { id: "photo_request", kind: "photo_request", name: "私藏视角请求卡", description: "请求角色创作一张从其视角记录的虚构生活照片。", effect: "使用后触发生图请求；不会调用设备摄像头，也不保证每次生成成功。", reusable: false, icon: "⌁" },
  { id: "promise_ticket", kind: "promise", name: "约定存根", description: "把一件具体的小约定记下来，之后可以回看履行情况。", effect: "使用后创建一条可追踪约定，完成或失约都能留下记录。", reusable: false, icon: "✦" },
];

function readCollection<T>(key: string): T[] {
  return readJson<T[]>(key, []);
}
function writeCollection<T>(key: string, values: T[]): void {
  writeJson(key, values);
}
function newRecordId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function listRelationshipKeepsakeRequests(characterId?: string): RelationshipKeepsakeRequest[] {
  return readCollection<RelationshipKeepsakeRequest>(REQUESTS_KEY)
    .filter(item => !characterId || item.characterId === characterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function requestRelationshipKeepsake(input: Omit<RelationshipKeepsakeRequest, "id" | "status" | "createdAt">): RelationshipKeepsakeRequest | null {
  if (!input.characterId || !input.sessionId || !RELATIONSHIP_KEEPSAKE_CATALOG.some(item => item.id === input.keepsakeId)) return null;
  const all = readCollection<RelationshipKeepsakeRequest>(REQUESTS_KEY);
  const pending = all.find(item => item.characterId === input.characterId && item.sessionId === input.sessionId && item.keepsakeId === input.keepsakeId && item.status === "pending");
  if (pending) return pending;
  const request: RelationshipKeepsakeRequest = { ...input, id: newRecordId("keepsake-request"), status: "pending", createdAt: new Date().toISOString() };
  writeCollection(REQUESTS_KEY, [request, ...all].slice(0, 300));
  return request;
}

export function resolveRelationshipKeepsakeRequest(requestId: string, decision: "granted" | "declined"): OwnedRelationshipKeepsake | null {
  const all = readCollection<RelationshipKeepsakeRequest>(REQUESTS_KEY);
  const target = all.find(item => item.id === requestId);
  if (!target || target.status !== "pending") return null;
  writeCollection(REQUESTS_KEY, all.map(item => item.id === requestId ? { ...item, status: decision, resolvedAt: new Date().toISOString() } : item));
  if (decision !== "granted") return null;
  return grantRelationshipKeepsake(target.keepsakeId, target.characterId, "user_reward");
}

export function grantRelationshipKeepsake(
  catalogId: string,
  characterId: string,
  source: OwnedRelationshipKeepsake["source"] = "user_reward",
): OwnedRelationshipKeepsake | null {
  if (!RELATIONSHIP_KEEPSAKE_CATALOG.some(item => item.id === catalogId) || !characterId) return null;
  const owned: OwnedRelationshipKeepsake = {
    id: newRecordId("keepsake"),
    catalogId,
    characterId,
    grantedAt: new Date().toISOString(),
    source,
    status: "available",
  };
  const all = readCollection<OwnedRelationshipKeepsake>(INVENTORY_KEY);
  writeCollection(INVENTORY_KEY, [owned, ...all].slice(0, 500));
  return owned;
}

export function listOwnedRelationshipKeepsakes(characterId?: string, status?: OwnedRelationshipKeepsake["status"]): OwnedRelationshipKeepsake[] {
  return readCollection<OwnedRelationshipKeepsake>(INVENTORY_KEY)
    .filter(item => (!characterId || item.characterId === characterId) && (!status || item.status === status))
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}

export function consumeRelationshipKeepsake(instanceId: string, resultId?: string): OwnedRelationshipKeepsake | null {
  const all = readCollection<OwnedRelationshipKeepsake>(INVENTORY_KEY);
  const target = all.find(item => item.id === instanceId);
  if (!target || target.status !== "available") return null;
  const catalog = RELATIONSHIP_KEEPSAKE_CATALOG.find(item => item.id === target.catalogId);
  if (!catalog || catalog.reusable) return target;
  const updated = { ...target, status: "used" as const, usedAt: new Date().toISOString(), useResultId: resultId };
  writeCollection(INVENTORY_KEY, all.map(item => item.id === instanceId ? updated : item));
  return updated;
}

export function listRelationshipDatePlans(characterId?: string): RelationshipDatePlan[] {
  return readCollection<RelationshipDatePlan>(DATE_PLANS_KEY)
    .filter(item => !characterId || item.characterId === characterId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Save an editable date itinerary. It deliberately does not start the date or move anyone. */
export function createRelationshipDatePlan(input: Omit<RelationshipDatePlan, "id" | "status" | "createdAt" | "updatedAt">): RelationshipDatePlan | null {
  if (!input.characterId || !input.sessionId || !input.locationName.trim() || !input.scene.trim() || input.plannedActivity.length === 0) return null;
  const plan: RelationshipDatePlan = {
    ...input,
    id: newRecordId("date-plan"),
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const all = readCollection<RelationshipDatePlan>(DATE_PLANS_KEY);
  writeCollection(DATE_PLANS_KEY, [plan, ...all].slice(0, 200));
  return plan;
}

export function updateRelationshipDatePlan(
  planId: string,
  patch: Partial<Pick<RelationshipDatePlan, "title" | "locationId" | "locationName" | "scene" | "plannedActivity" | "openingBeat" | "possibleBeats" | "keepsakesOrProps" | "userChoiceRequired" | "status" | "outcome">>,
): RelationshipDatePlan | null {
  const all = readCollection<RelationshipDatePlan>(DATE_PLANS_KEY);
  const target = all.find(item => item.id === planId);
  if (!target) return null;
  const updated = { ...target, ...patch, updatedAt: new Date().toISOString() };
  writeCollection(DATE_PLANS_KEY, all.map(item => item.id === planId ? updated : item));
  return updated;
}

export const RELATIONSHIP_DATE_IDEAS = [
  { id: "rose-garden", title: "玫瑰园散步", locationName: "玫瑰庄园温室", scene: "傍晚的玻璃温室，玫瑰藤绕过铁艺拱门，空气里有一点潮湿的花香。", plannedActivity: ["一起挑一枝想带回家的花", "在长椅上交换最近没说出口的小事", "拍一张只属于这次约会的合影"], openingBeat: "角色提前到了，手里藏着一张写了半句的卡片；看见你时先把卡片收进衣袋。", possibleBeats: ["花瓣落在衣袖上，角色替你轻轻拂去", "你可以决定要不要把卡片看完", "若聊到不开心的事，约会可以暂时停下来认真谈"], keepsakesOrProps: ["手写约会笺", "一枝玫瑰", "拍立得相机"], userChoiceRequired: ["是否接受邀约", "是否拍照", "是否谈起敏感话题"] },
  { id: "rainy-bookshop", title: "雨天旧书店", locationName: "街角旧书店与窗边座位", scene: "雨点敲着玻璃，木书架之间有旧纸张的气味，窗边放着两杯热饮。", plannedActivity: ["各自挑一本想推荐给对方的书", "在书页边写一句留言", "雨停前玩一次互相猜心的小问答"], openingBeat: "角色把挑好的书倒扣在桌上，夹着一张不肯立刻给你看的纸条。", possibleBeats: ["读到某句话时聊起共同记忆", "角色发现你挑的书里夹着旧书签", "可以改成安静陪伴，不强制聊天或肢体互动"], keepsakesOrProps: ["旧书签", "手写便笺", "热饮"], userChoiceRequired: ["是否交换书", "是否读出纸条", "是否延长约会"] },
  { id: "night-market", title: "夜市寻宝", locationName: "灯火热闹的夜市", scene: "暖黄色灯串、摊位叫卖声和刚出锅的小吃香气混在一起。", plannedActivity: ["各自给对方挑一件小礼物", "合作完成一个小游戏", "找一个不拥挤的角落休息聊天"], openingBeat: "角色说今晚不许直接问礼物是什么，要靠你猜；但自己先忍不住露出破绽。", possibleBeats: ["抽到奇怪小物件变成共同笑话", "在人群里自然确认彼此是否走散", "累了可以提前结束，不把行程强行走完"], keepsakesOrProps: ["小礼物袋", "游戏代币", "夜市票根"], userChoiceRequired: ["选择摊位", "是否交换礼物", "是否继续逛"] },
  { id: "museum-date", title: "美术馆慢约会", locationName: "安静的美术馆", scene: "高挑展厅、柔和的侧光与稀疏脚步声，让人不自觉放轻声音。", plannedActivity: ["各自选一件最有感觉的作品", "猜对方为什么喜欢它", "在出口写下今天的三句话"], openingBeat: "角色站在一幅画前等你，准备了两个不同答案，想看看你会猜中哪一个。", possibleBeats: ["作品引出意料之外的往事", "你们发现彼此理解完全不同", "最后可以留下小型展签作为纪念"], keepsakesOrProps: ["展览票根", "迷你展签", "纪念明信片"], userChoiceRequired: ["选择先看哪一厅", "是否分享私人回忆", "是否留下纪念文字"] },
  { id: "home-cooking", title: "一起做晚餐", locationName: "角色家中的厨房", scene: "暖灯照着料理台，砧板、围裙和食材都已经摆好；窗外天色渐暗。", plannedActivity: ["一起决定菜单", "分工准备一道菜", "吃饭时互相评价成果"], openingBeat: "角色把围裙递给你，认真宣布今天的菜单有一道隐藏菜品，但暂时不肯透露。", possibleBeats: ["切菜分工引发轻松斗嘴", "菜做失败后改成外卖或简单料理", "饭后可以收拾厨房或坐下来休息"], keepsakesOrProps: ["两条围裙", "手写菜单", "食谱卡"], userChoiceRequired: ["选择菜单", "分工方式", "饭后做什么"] },
] as const;

/** Build a concrete, editable itinerary from a selected idea and an owned date pass. */
export function draftRelationshipDateFromIdea(
  keepsakeInstanceId: string,
  characterId: string,
  sessionId: string,
  ideaId: string,
): RelationshipDatePlan | null {
  const owned = listOwnedRelationshipKeepsakes(characterId, "available").find(item => item.id === keepsakeInstanceId && item.catalogId === "date_pass");
  const idea = RELATIONSHIP_DATE_IDEAS.find(item => item.id === ideaId);
  if (!owned || !idea) return null;
  const plan = createRelationshipDatePlan({
    keepsakeInstanceId,
    characterId,
    sessionId,
    title: idea.title,
    locationId: idea.id,
    locationName: idea.locationName,
    scene: idea.scene,
    plannedActivity: [...idea.plannedActivity],
    openingBeat: idea.openingBeat,
    possibleBeats: [...idea.possibleBeats],
    keepsakesOrProps: [...idea.keepsakesOrProps],
    userChoiceRequired: [...idea.userChoiceRequired],
  });
  if (plan) consumeRelationshipKeepsake(keepsakeInstanceId, plan.id);
  return plan;
}
