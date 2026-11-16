import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type MemoOwner = { type: "user" } | { type: "character"; id: string };
export type MemoFolder = { id: string; name: string; color: string; createdAt: number };
export type MemoTodo = { id: string; text: string; done: boolean; dueAt?: number; createdAt: number };
export type MemoNote = {
  id: string; owner: MemoOwner; folderId: string | null; title: string; content: string;
  tags: string[]; archived: boolean; todos: MemoTodo[]; shareWithCharacterIds: string[];
  createdAt: number; updatedAt: number;
};
export type MemoTheme = {
  accent: string; paper: string; ink: string; muted: string; font: string;
  texture: "plain" | "linen" | "dots" | "grid"; radius: number;
};
export type MemoState = { version: 1; notes: MemoNote[]; folders: Array<MemoFolder & { owner: MemoOwner }>; themes: Record<string, MemoTheme> };
const KEY = "ai_phone_private_memo_v1";
registerKvMigration(KEY);
const DEFAULT_THEME: MemoTheme = { accent: "#927b68", paper: "#f4efe6", ink: "#493f37", muted: "#988b7d", font: "inherit", texture: "linen", radius: 18 };
const uid = (prefix: string) => `${prefix}_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
const ownerKey = (owner: MemoOwner) => owner.type === "user" ? "user" : `character:${owner.id}`;
const sameOwner = (a: MemoOwner, b: MemoOwner) => ownerKey(a) === ownerKey(b);
function emptyState(): MemoState { return { version: 1, notes: [], folders: [], themes: { user: { ...DEFAULT_THEME } } }; }
export function loadMemoState(): MemoState {
  try {
    const raw = kvGet(KEY); if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as MemoState;
    if (parsed.version !== 1 || !Array.isArray(parsed.notes) || !Array.isArray(parsed.folders)) return emptyState();
    return { ...emptyState(), ...parsed, themes: { user: { ...DEFAULT_THEME }, ...(parsed.themes || {}) } };
  } catch { return emptyState(); }
}
export function saveMemoState(state: MemoState): void { kvSet(KEY, JSON.stringify(state)); }
export function listMemoNotes(owner: MemoOwner, includeArchived = false): MemoNote[] {
  return loadMemoState().notes.filter(n => sameOwner(n.owner, owner) && (includeArchived || !n.archived)).sort((a,b)=>b.updatedAt-a.updatedAt);
}
export function listMemoFolders(owner: MemoOwner): MemoFolder[] {
  return loadMemoState().folders.filter(f => sameOwner(f.owner, owner)).sort((a,b)=>a.createdAt-b.createdAt);
}
export function createMemoFolder(owner: MemoOwner, name: string, color = "#b69b7d"): MemoFolder {
  const state=loadMemoState(); const folder={id:uid("folder"),owner,name:name.trim().slice(0,40)||"新文件夹",color,createdAt:Date.now()};
  state.folders.push(folder); saveMemoState(state); return folder;
}
export function upsertMemoNote(owner: MemoOwner, input: Partial<MemoNote> & { title?: string; content?: string }): MemoNote {
  const state=loadMemoState(); const now=Date.now(); const existing=input.id ? state.notes.find(n=>n.id===input.id && sameOwner(n.owner,owner)) : undefined;
  const note: MemoNote = existing ? { ...existing, ...input, owner, updatedAt: now } : {
    id:uid("memo"),owner,folderId:input.folderId??null,title:(input.title||"未命名笔记").trim().slice(0,100),
    content:(input.content||"").slice(0,30000),tags:Array.isArray(input.tags)?input.tags.slice(0,12):[],
    archived:false,todos:Array.isArray(input.todos)?input.todos:[],shareWithCharacterIds:[],createdAt:now,updatedAt:now
  };
  note.title=(note.title||"未命名笔记").trim().slice(0,100); note.content=(note.content||"").slice(0,30000);
  note.tags=Array.isArray(note.tags)?note.tags.map(tag=>String(tag).trim().slice(0,60)).filter(Boolean).slice(0,12):[];
  note.todos=Array.isArray(note.todos)?note.todos.slice(0,200).map(todo=>({...todo,text:String(todo.text||"").trim().slice(0,500)})):[];
  note.shareWithCharacterIds=Array.isArray(note.shareWithCharacterIds)?[...new Set(note.shareWithCharacterIds.filter(id=>typeof id==="string"&&id.length>0))]:[];
  state.notes=existing?state.notes.map(n=>n.id===note.id?note:n):[note,...state.notes]; saveMemoState(state); return note;
}
export function deleteMemoNote(owner: MemoOwner, id: string): boolean {
  const state=loadMemoState(), next=state.notes.filter(n=>!(n.id===id&&sameOwner(n.owner,owner)));
  if(next.length===state.notes.length)return false; state.notes=next;saveMemoState(state);return true;
}
export function setMemoNoteShare(id: string, characterId: string, allowed: boolean): boolean {
  const state=loadMemoState(), note=state.notes.find(n=>n.id===id&&n.owner.type==="user"); if(!note)return false;
  const set=new Set(note.shareWithCharacterIds||[]); if(allowed){set.add(characterId);}else{set.delete(characterId);}
  note.shareWithCharacterIds=[...set];note.updatedAt=Date.now();saveMemoState(state);return true;
}
export function getMemoNoteForCharacter(noteId: string, characterId: string): MemoNote | null {
  const state=loadMemoState();
  const note=state.notes.find(n=>n.id===noteId && (n.owner.type==="character"&&n.owner.id===characterId || n.owner.type==="user"&&n.shareWithCharacterIds.includes(characterId)));
  return note||null;
}
export function searchMemoForCharacter(characterId: string, query = "", limit = 12): MemoNote[] {
  const q=query.trim().toLocaleLowerCase(); const state=loadMemoState();
  return state.notes.filter(n=>n.owner.type==="character"&&n.owner.id===characterId || n.owner.type==="user"&&n.shareWithCharacterIds.includes(characterId))
    .filter(n=>!n.archived && (!q || `${n.title}\n${n.content}\n${n.tags.join(" ")}`.toLocaleLowerCase().includes(q)))
    .sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,Math.max(1,Math.min(30,limit)));
}
export function getMemoTheme(owner: MemoOwner): MemoTheme { const state=loadMemoState(); return { ...DEFAULT_THEME, ...(state.themes[ownerKey(owner)]||{}) }; }
export function setMemoTheme(owner: MemoOwner, theme: Partial<MemoTheme>): void { const state=loadMemoState(); state.themes[ownerKey(owner)]={...DEFAULT_THEME,...(state.themes[ownerKey(owner)]||{}),...theme}; saveMemoState(state); }
export function exportMemoData(owner?: MemoOwner, folderId?: string): string {
  const state=loadMemoState(); const notes=state.notes.filter(n=>(!owner||sameOwner(n.owner,owner))&&(!folderId||n.folderId===folderId));
  const folders=state.folders.filter(f=>(!owner||sameOwner(f.owner,owner))&&(!folderId||f.id===folderId));
  const themes=Object.fromEntries(Object.entries(state.themes).filter(([key])=>!owner||key===ownerKey(owner)));
  return JSON.stringify({format:"floatphone.memo",version:1,exportedAt:new Date().toISOString(),notes,folders,themes},null,2);
}
export function importMemoData(raw: string, mode: "merge"|"replace", owner?: MemoOwner): { imported:number; skipped:number } {
  const data=JSON.parse(raw); if(data?.format!=="floatphone.memo"||data.version!==1||!Array.isArray(data.notes)||!Array.isArray(data.folders)) throw new Error("备忘录文件格式不正确");
  if(data.notes.length>10000||data.folders.length>1000) throw new Error("文件数量超出安全限制");
  const validOwner=(value:unknown): value is MemoOwner => {
    if(!value||typeof value!=="object")return false;
    const owner=value as Record<string,unknown>;
    return owner.type==="user"||(owner.type==="character"&&typeof owner.id==="string"&&owner.id.length>0);
  };
  const valid=(value:unknown): value is MemoNote => {
    if(!value||typeof value!=="object")return false;
    const n=value as Record<string,unknown>;
    if(typeof n.id!=="string"||!n.id||!validOwner(n.owner)||typeof n.title!=="string"||n.title.length>100||typeof n.content!=="string"||n.content.length>30000)return false;
    if(n.tags!==undefined&&(!Array.isArray(n.tags)||n.tags.length>12||!n.tags.every(x=>typeof x==="string"&&x.length<=60)))return false;
    if(n.todos!==undefined&&(!Array.isArray(n.todos)||n.todos.length>200||!n.todos.every(t=>t&&typeof t==="object"&&typeof t.id==="string"&&typeof t.text==="string"&&typeof t.done==="boolean")))return false;
    if(n.shareWithCharacterIds!==undefined&&(!Array.isArray(n.shareWithCharacterIds)||!n.shareWithCharacterIds.every(x=>typeof x==="string"&&x.length>0)))return false;
    if(n.folderId!==undefined&&n.folderId!==null&&typeof n.folderId!=="string")return false;
    return true;
  };
  const validFolder=(value:unknown): value is MemoState["folders"][number] => {
    if(!value||typeof value!=="object")return false;
    const f=value as Record<string,unknown>;
    return typeof f.id==="string"&&!!f.id&&validOwner(f.owner)&&typeof f.name==="string"&&f.name.length<=40&&typeof f.color==="string"&&typeof f.createdAt==="number";
  };
  if(!data.notes.every(valid))throw new Error("文件中存在无效笔记，未导入任何数据");
  if(!data.folders.every(validFolder))throw new Error("文件夹数据无效，未导入任何数据");
  const state=loadMemoState(); let imported=0,skipped=0;
  if(mode==="replace"){ state.notes=owner?state.notes.filter(n=>!sameOwner(n.owner,owner)):[]; state.folders=owner?state.folders.filter(f=>!sameOwner(f.owner,owner)):[]; if(!owner)state.themes={}; }
  const incoming=(data.notes as MemoNote[]).filter(n=>!owner||sameOwner(n.owner,owner));

  for(const n of incoming){ if(state.notes.some(x=>x.id===n.id)){ if(mode==="merge"){skipped++;continue;} state.notes=state.notes.filter(x=>x.id!==n.id); } state.notes.push({...n,tags:Array.isArray(n.tags)?n.tags:[],shareWithCharacterIds:Array.isArray(n.shareWithCharacterIds)?n.shareWithCharacterIds:[],todos:Array.isArray(n.todos)?n.todos:[],archived:!!n.archived,folderId:n.folderId??null,createdAt:Number(n.createdAt)||Date.now(),updatedAt:Number(n.updatedAt)||Date.now()}); imported++; }
  const incomingFolders=(data.folders as MemoState["folders"]).filter(f=>!owner||sameOwner(f.owner,owner));

  for(const f of incomingFolders)if(!state.folders.some(x=>x.id===f.id))state.folders.push(f);
  if(data.themes&&typeof data.themes==="object") for(const [k,v] of Object.entries(data.themes))if(!owner||k===ownerKey(owner))state.themes[k]={...DEFAULT_THEME,...(v as object)};
  saveMemoState(state);return {imported,skipped};
}
