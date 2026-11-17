import Dexie, { type Table } from "dexie";
export type MemoOwner = { type: "user" | "character"; id: string };
export type MemoFolder = { id: string; owner: MemoOwner; name: string; color: string; order: number; createdAt: number; updatedAt: number };
export type MemoTodo = { id: string; text: string; done: boolean; createdAt: number; completedAt?: number };
export type MemoNote = { id: string; owner: MemoOwner; folderId: string|null; title: string; body: string; tags: string[]; todos: MemoTodo[]; pinned: boolean; archived: boolean; deletedAt?: number; sharedWith: string[]; createdAt: number; updatedAt: number; lastReviewedAt?: number; nextReviewAt?: number };
class MemoArchiveDB extends Dexie {
  folders!: Table<MemoFolder,string>; notes!: Table<MemoNote,string>;
  constructor(){ super("floatphone-memo-archive-v1"); this.version(1).stores({folders:"id, owner.id, order, updatedAt",notes:"id, owner.id, folderId, updatedAt, pinned, archived, deletedAt, *tags"}); }
}
let db:MemoArchiveDB|null=null; const database=()=>db??(db=new MemoArchiveDB()); const uid=()=>crypto.randomUUID(); const same=(a:MemoOwner,b:MemoOwner)=>a.type===b.type&&a.id===b.id; const stamp=()=>Date.now();
type MemoTimelineProjection = { id: string; sourceApp: "memo"; memoNoteId: string; timestamp: string; content: string };
const memoTimelineKey = (characterId: string) => "memo-archive-timeline:" + characterId;
function writeMemoTimelineEvent(characterId: string, note: MemoNote, action: "created" | "updated" = "updated"): void {
  try {
    const key = memoTimelineKey(characterId);
    const current: MemoTimelineProjection[] = JSON.parse(localStorage.getItem(key) || "[]");
    const event: MemoTimelineProjection = {
      id: "memo:" + note.id,
      sourceApp: "memo",
      memoNoteId: note.id,
      timestamp: new Date(note.updatedAt).toISOString(),
      content: "备忘录《" + note.title + "》" + (action === "created" ? "已创建" : "已更新") + "。仅记录标题与变更，不包含正文。",
    };
    localStorage.setItem(key, JSON.stringify([event, ...current.filter(item => item.memoNoteId !== note.id)].slice(0, 200)));
  } catch { /* timeline projection is best-effort; source note remains safely stored */ }
}
function removeMemoTimelineEvent(characterId: string, noteId: string): void {
  try {
    const key = memoTimelineKey(characterId);
    const current: MemoTimelineProjection[] = JSON.parse(localStorage.getItem(key) || "[]");
    localStorage.setItem(key, JSON.stringify(current.filter(item => item.memoNoteId !== noteId)));
  } catch { /* ignore malformed projection cache */ }
}
export function loadMemoTimelineProjectionEntries(characterId: string): MemoTimelineProjection[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(memoTimelineKey(characterId)) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is MemoTimelineProjection => Boolean(item && typeof item === "object" && (item as MemoTimelineProjection).sourceApp === "memo" && typeof (item as MemoTimelineProjection).memoNoteId === "string" && typeof (item as MemoTimelineProjection).timestamp === "string" && typeof (item as MemoTimelineProjection).content === "string"));
  } catch { return []; }
}

export async function loadMemoArchive(owner:MemoOwner,deleted:boolean|"all"=false){const [folders,notes]=await Promise.all([database().folders.toArray(),database().notes.toArray()]);return{folders:folders.filter(x=>same(x.owner,owner)).sort((a,b)=>a.order-b.order),notes:notes.filter(x=>same(x.owner,owner)&&(deleted==="all"||(deleted?!!x.deletedAt:!x.deletedAt))).sort((a,b)=>b.updatedAt-a.updatedAt)};}
export async function createMemoFolder(owner:MemoOwner,name:string,color="#D8C39B"){const clean=name.trim().slice(0,32);if(!clean)throw Error("档案盒名称不能为空");const all=await database().folders.toArray();const item={id:uid(),owner,name:clean,color,order:all.filter(x=>same(x.owner,owner)).length,createdAt:stamp(),updatedAt:stamp()};await database().folders.add(item);return item;}
export async function updateMemoFolder(id:string,owner:MemoOwner,patch:Partial<Pick<MemoFolder,"name"|"color"|"order">>){const d=database();const f=await d.folders.get(id);if(!f||!same(f.owner,owner))throw Error("无权修改此档案盒");if(patch.order!==undefined){await d.transaction("rw",d.folders,async()=>{const rows=(await d.folders.toArray()).filter(x=>same(x.owner,owner)).sort((x,y)=>x.order-y.order);const from=rows.findIndex(x=>x.id===id);const [moving]=rows.splice(from,1);rows.splice(Math.max(0,Math.min(rows.length,patch.order!)),0,moving);for(let index=0;index<rows.length;index++)await d.folders.update(rows[index].id,{order:index,updatedAt:stamp()});});}else await d.folders.update(id,{...patch,updatedAt:stamp()});}
export async function deleteMemoFolder(id:string,owner:MemoOwner,mode:"loose"|"recycle"="loose"){const f=await database().folders.get(id);if(!f||!same(f.owner,owner))throw Error("无权删除此档案盒");await database().transaction("rw",database().folders,database().notes,async()=>{for(const n of await database().notes.where("folderId").equals(id).toArray())if(same(n.owner,owner))await database().notes.update(n.id,{folderId:null,...(mode==="recycle"?{deletedAt:stamp()}:{}),updatedAt:stamp()});await database().folders.delete(id);});}
export async function saveMemoNote(owner:MemoOwner,input:Partial<MemoNote>&Pick<MemoNote,"title"|"body">){const title=input.title.trim().slice(0,60);if(!title)throw Error("请填写标题");if(input.body.length>20000)throw Error("正文不能超过 20000 字");const old=input.id?await database().notes.get(input.id):undefined;if(old&&!same(old.owner,owner))throw Error("无权修改此备忘录");if(input.folderId){const f=await database().folders.get(input.folderId);if(!f||!same(f.owner,owner))throw Error("档案盒不属于当前空间");}const t=stamp();const note:MemoNote={id:old?.id??uid(),owner,folderId:("folderId" in input ? input.folderId : old?.folderId) ?? null,title,body:input.body,tags:[...new Set((input.tags??old?.tags??[]).map(x=>x.trim()).filter(Boolean))].slice(0,8),todos:(input.todos??old?.todos??[]).slice(0,100),pinned:input.pinned??old?.pinned??false,archived:input.archived??old?.archived??false,sharedWith:old?.sharedWith??[],createdAt:old?.createdAt??t,updatedAt:t,lastReviewedAt:old?.lastReviewedAt,nextReviewAt:old?.nextReviewAt};await database().notes.put(note);
  if (owner.type === "character") writeMemoTimelineEvent(owner.id, note, old ? "updated" : "created");
  else for (const characterId of note.sharedWith) writeMemoTimelineEvent(characterId, note, old ? "updated" : "created");
  return note;}
export async function moveMemoToRecycleBin(id:string,owner:MemoOwner){const n=await database().notes.get(id);if(!n||!same(n.owner,owner))throw Error("无权删除此备忘录");await database().notes.update(id,{deletedAt:stamp(),updatedAt:stamp()});
  if (owner.type === "character") removeMemoTimelineEvent(owner.id, id);
  else for (const characterId of n.sharedWith) removeMemoTimelineEvent(characterId, id);}
export async function restoreMemo(id:string,owner:MemoOwner){const n=await database().notes.get(id);if(!n||!same(n.owner,owner))throw Error("无权恢复此备忘录");await database().notes.update(id,{deletedAt:undefined,updatedAt:stamp()});}
export async function permanentlyDeleteMemo(id:string,owner:MemoOwner){const n=await database().notes.get(id);if(!n||!same(n.owner,owner))throw Error("无权删除此备忘录");await database().notes.delete(id);}
export async function setMemoShare(id:string,owner:MemoOwner,characterId:string,enabled:boolean){const n=await database().notes.get(id);if(!n||!same(n.owner,owner)||owner.type!=="user")throw Error("只有用户自己的备忘录可以分享");await database().notes.update(id,{sharedWith:enabled?[...new Set([...n.sharedWith,characterId])]:n.sharedWith.filter(x=>x!==characterId),updatedAt:stamp()});
  if (enabled) writeMemoTimelineEvent(characterId, { ...n, updatedAt: stamp() }, "updated");
  else removeMemoTimelineEvent(characterId, id);}
export async function readSharedMemoNotes(characterId:string){return(await database().notes.toArray()).filter(n=>n.owner.type==="user"&&n.sharedWith.includes(characterId)&&!n.deletedAt);}
export async function exportMemoArchive(owner:MemoOwner){return{schema:"floatphone.memo-archive",version:1,exportedAt:stamp(),owner,...await loadMemoArchive(owner,"all"),reviewIntervalHours:owner.type==="character"?getMemoReviewIntervalHours(owner.id):null,reviewState:owner.type==="character"?readMemoReviewState(owner.id):{}};}
export async function importMemoArchive(owner:MemoOwner,payload:unknown,mode:"merge"|"replace"="merge"){
  const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value);
  if(!isRecord(payload)||payload.schema!=="floatphone.memo-archive"||payload.version!==1)throw Error("不支持的备份格式");
  if(!Array.isArray(payload.folders)||!Array.isArray(payload.notes))throw Error("备份结构不完整");
  const folders:MemoFolder[]=[];
  const notes:MemoNote[]=[];
  for(const raw of payload.folders){
    if(!isRecord(raw)||typeof raw.id!=="string"||typeof raw.name!=="string")throw Error("档案盒数据无效");
    folders.push({...raw,owner} as unknown as MemoFolder);
  }
  const folderIds=new Set(folders.map(folder=>folder.id));
  for(const raw of payload.notes){
    if(!isRecord(raw)||typeof raw.id!=="string"||typeof raw.title!=="string"||typeof raw.body!=="string"||raw.title.length>60||raw.body.length>20000)throw Error("备忘录数据无效");
    if(raw.folderId!==null&&raw.folderId!==undefined&&typeof raw.folderId!=="string")throw Error("备忘录所属档案盒无效");
    if(typeof raw.folderId==="string"&&!folderIds.has(raw.folderId))throw Error("备份中存在不存在的档案盒引用");
    if(!Array.isArray(raw.tags)||raw.tags.length>8||!Array.isArray(raw.todos)||raw.todos.length>100)throw Error("备忘录标签或待办数据无效");
    if(typeof raw.pinned!=="boolean"||typeof raw.archived!=="boolean"||!Array.isArray(raw.sharedWith)||raw.sharedWith.some(x=>typeof x!=="string"))throw Error("备忘录状态或分享权限无效");
    if(raw.tags.some(x=>typeof x!=="string")||raw.todos.some(x=>!isRecord(x)||typeof x.id!=="string"||typeof x.text!=="string"||typeof x.done!=="boolean"||typeof x.createdAt!=="number"))throw Error("备忘录标签或待办内容无效");
    notes.push({...raw,owner,sharedWith:owner.type==="user"?raw.sharedWith as string[]:[]} as unknown as MemoNote);
  }
  const d=database();
  await d.transaction("rw",d.folders,d.notes,async()=>{
    if(mode==="replace"){
      const oldFolders=(await d.folders.toArray()).filter(item=>same(item.owner,owner));
      const oldNotes=(await d.notes.toArray()).filter(item=>same(item.owner,owner));
      for(const item of oldNotes)await d.notes.delete(item.id);
      for(const item of oldFolders)await d.folders.delete(item.id);
    }
    for(const folder of folders){
      const existing=await d.folders.get(folder.id);
      if(!existing||same(existing.owner,owner))await d.folders.put(folder);
    }
    for(const note of notes){
      const existing=await d.notes.get(note.id);
      if(!existing||same(existing.owner,owner))await d.notes.put(note);
    }
  });
  if (owner.type === "character") {
    if (typeof payload.reviewIntervalHours === "number" && Number.isFinite(payload.reviewIntervalHours) && payload.reviewIntervalHours >= 0) {
      setMemoReviewIntervalHours(owner.id, payload.reviewIntervalHours);
    }
    if (isRecord(payload.reviewState)) {
      const imported = Object.fromEntries(Object.entries(payload.reviewState).filter(([id, time]) => Boolean(id) && typeof time === "number" && Number.isFinite(time)));
      const next = mode === "replace" ? imported : { ...readMemoReviewState(owner.id), ...imported };
      try { localStorage.setItem(memoReviewKey(owner.id), JSON.stringify(next)); } catch { /* optional review metadata */ }
    }
  }
}

/** Compact, ACL-filtered memo context for the owning character's 1:1 chat only. */
const pendingMemoReviewIds = new Map<string, Set<string>>();
const memoReviewKey = (characterId: string) => "memo-archive-review:" + characterId;
const memoReviewIntervalKey = (characterId: string) => "memo-archive-review-hours:" + characterId;

export function getMemoReviewIntervalHours(characterId: string): number {
  try {
    const value = Number(localStorage.getItem(memoReviewIntervalKey(characterId)));
    return Number.isFinite(value) && value >= 0 ? Math.min(720, value) : 24;
  } catch { return 24; }
}

export function setMemoReviewIntervalHours(characterId: string, hours: number): void {
  const value = Number.isFinite(hours) && hours >= 0 ? Math.min(720, Math.round(hours)) : 24;
  try { localStorage.setItem(memoReviewIntervalKey(characterId), String(value)); } catch { /* storage unavailable */ }
}

function readMemoReviewState(characterId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(memoReviewKey(characterId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, time]) => Boolean(id) && typeof time === "number" && Number.isFinite(time)));
  } catch { return {}; }
}

export async function markMemoReviewCompleted(characterId: string): Promise<void> {
  const ids = pendingMemoReviewIds.get(characterId);
  if (!ids?.size) return;
  const state = readMemoReviewState(characterId);
  const reviewedAt = Date.now();
  for (const id of ids) state[id] = reviewedAt;
  try {
    localStorage.setItem(memoReviewKey(characterId), JSON.stringify(state));
    const timelineKey = memoTimelineKey(characterId);
    const timeline: MemoTimelineProjection[] = JSON.parse(localStorage.getItem(timelineKey) || "[]");
    const eventId = "memo-review:" + reviewedAt;
    timeline.unshift({
      id: eventId,
      sourceApp: "memo",
      memoNoteId: eventId,
      timestamp: new Date(reviewedAt).toISOString(),
      content: "完成了 " + ids.size + " 条私人备忘录的定期回顾；未将正文写入时间线。",
    });
    localStorage.setItem(timelineKey, JSON.stringify(timeline.slice(0, 200)));
  } catch { /* storage unavailable */ }
  pendingMemoReviewIds.delete(characterId);
}

export async function buildMemoPromptDigest(characterId: string, maxChars = 850): Promise<string> {
  const intervalHours = getMemoReviewIntervalHours(characterId);
  if (intervalHours === 0) {
    pendingMemoReviewIds.delete(characterId);
    return "";
  }
  const own = await loadMemoArchive({ type: "character", id: characterId });
  const shared = await readSharedMemoNotes(characterId);
  const candidates = [...own.notes.filter(note => !note.archived && !note.deletedAt), ...shared.filter(note => !note.archived && !note.deletedAt)];
  const reviewState = readMemoReviewState(characterId);
  const dueBefore = Date.now() - intervalHours * 60 * 60 * 1000;
  const due = candidates.filter(note => !reviewState[note.id] || reviewState[note.id] <= dueBefore);
  const ranked = due.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.todos.some(todo => !todo.done)) - Number(a.todos.some(todo => !todo.done)) || b.updatedAt - a.updatedAt).slice(0, 5);
  if (!ranked.length) {
    pendingMemoReviewIds.delete(characterId);
    return "";
  }
  pendingMemoReviewIds.set(characterId, new Set(ranked.map(note => note.id)));
  let digest = ranked.map(note => {
    const source = note.owner.type === "user" ? "用户明确分享（只读）" : "我的私人档案";
    const todos = note.todos.filter(todo => !todo.done).slice(0, 3).map(todo => "待办：" + todo.text).join("；");
    return "- [" + source + "] " + note.title + "：" + note.body.replace(/\\s+/g, " ").slice(0, 180) + (todos ? "；" + todos : "");
  }).join("\\n");
  if (digest.length > maxChars) digest = digest.slice(0, Math.max(0, maxChars - 1)) + "…";
  return "### 私人档案定期回顾（仅供当前角色参考）\\n" + digest;
}
