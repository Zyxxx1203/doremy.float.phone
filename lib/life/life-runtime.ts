import type { LifeActorClock, LifeActorState, LifeEvent, LifeInvitation, LifeOwnerType, LifeScheduleSlot, LifeSceneState, VirtualLifeState } from "./life-types";

const DAY_MS = 86_400_000;
const clampSpeed = (speed: number) => Math.max(0.01, Math.min(Number.isFinite(speed) ? speed : 1, 1000));
export const lifeActorKey = (ownerType: LifeOwnerType, ownerId: string) => `${ownerType}:${ownerId}`;

export function getActorClock(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string): LifeActorClock {
  const existing = state.actorClocks.find(clock => clock.ownerType === ownerType && clock.ownerId === ownerId);
  if (existing) return existing;
  const now = new Date().toISOString();
  return { ownerType, ownerId, mode: state.settings.defaultClockMode, realAnchorAt: now, virtualAnchorAt: now, speed: clampSpeed(state.settings.defaultSpeed), updatedAt: now };
}

/** Each actor resolves their own clock; changing one clock never changes another. */
export function resolveActorLifeNow(clock: LifeActorClock, realNow = new Date()): Date {
  const virtualAnchor = new Date(clock.virtualAnchorAt), realAnchor = new Date(clock.realAnchorAt);
  if (!Number.isFinite(virtualAnchor.getTime()) || !Number.isFinite(realAnchor.getTime())) return realNow;
  if (clock.mode === "real-time") return realNow;
  if (clock.mode === "review") return virtualAnchor;
  return new Date(virtualAnchor.getTime() + Math.max(0, realNow.getTime() - realAnchor.getTime()) * clampSpeed(clock.speed));
}

export function upsertActorClock(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, patch: Partial<Pick<LifeActorClock, "mode" | "speed">>, realNow = new Date()): VirtualLifeState {
  const previous = getActorClock(state, ownerType, ownerId), virtualNow = resolveActorLifeNow(previous, realNow);
  const next: LifeActorClock = { ...previous, ...patch, realAnchorAt: realNow.toISOString(), virtualAnchorAt: virtualNow.toISOString(), speed: clampSpeed(patch.speed ?? previous.speed), updatedAt: realNow.toISOString() };
  return { ...state, actorClocks: [...state.actorClocks.filter(c => !(c.ownerType === ownerType && c.ownerId === ownerId)), next] };
}

export function fastForwardActor(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, minutes: number, realNow = new Date()): VirtualLifeState {
  const clock = getActorClock(state, ownerType, ownerId), current = resolveActorLifeNow(clock, realNow);
  const next: LifeActorClock = { ...clock, mode: "simulation", realAnchorAt: realNow.toISOString(), virtualAnchorAt: new Date(current.getTime() + Math.max(0, minutes) * 60_000).toISOString(), updatedAt: realNow.toISOString() };
  return { ...state, actorClocks: [...state.actorClocks.filter(c => !(c.ownerType === ownerType && c.ownerId === ownerId)), next] };
}

export function findActorState(state: VirtualLifeState, ownerType: LifeActorState["ownerType"], ownerId: string) {
  return state.actorStates.find(actor => actor.ownerType === ownerType && actor.ownerId === ownerId);
}
export function upsertActorState(state: VirtualLifeState, nextActor: LifeActorState): VirtualLifeState {
  const actorStates = state.actorStates.filter(actor => !(actor.ownerType === nextActor.ownerType && actor.ownerId === nextActor.ownerId));
  actorStates.push({ ...nextActor, updatedAt: new Date().toISOString() });
  return { ...state, actorStates };
}
export function upsertLifeEvent(state: VirtualLifeState, nextEvent: LifeEvent): VirtualLifeState {
  return { ...state, events: [...state.events.filter(event => event.id !== nextEvent.id), nextEvent].sort((a,b) => (a.startsAt || a.createdAt).localeCompare(b.startsAt || b.createdAt)) };
}
export function transitionLifeEvent(state: VirtualLifeState, eventId: string, nextStatus: LifeEvent["status"]): VirtualLifeState {
  const current = state.events.find(event => event.id === eventId);
  const allowed: Record<LifeEvent["status"], LifeEvent["status"][]> = { planned: ["confirmed","active","cancelled"], confirmed: ["active","cancelled"], active: ["completed","cancelled"], completed: [], cancelled: [] };
  if (!current || !allowed[current.status].includes(nextStatus)) return state;
  const now = new Date().toISOString();
  const updated = { ...current, status: nextStatus, updatedAt: now, ...(nextStatus === "completed" ? { completedAt: now } : {}), ...(nextStatus === "cancelled" ? { cancelledAt: now } : {}) };
  return { ...state, events: state.events.map(event => event.id === eventId ? updated : event) };
}
export function transitionInvitation(state: VirtualLifeState, invitationId: string, action: "confirm" | "decline" | "cancel"): VirtualLifeState {
  const current = state.invitations.find(invite => invite.id === invitationId);
  if (!current || current.status !== "proposed") return state;
  const now = new Date().toISOString(), status: LifeInvitation["status"] = action === "confirm" ? "confirmed" : action === "decline" ? "declined" : "cancelled";
  const next = { ...current, status, updatedAt: now, ...(action === "confirm" ? { confirmedAt: now } : {}) };
  return { ...state, invitations: state.invitations.map(invite => invite.id === invitationId ? next : invite) };
}
export function upsertLifeScene(state: VirtualLifeState, scene: LifeSceneState): VirtualLifeState {
  return { ...state, scenes: [...state.scenes.filter(item => item.id !== scene.id), scene] };
}
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

/** Create an editable weekly skeleton only when the owner has no plan for that week. */
export function generateWeeklyLifePlan(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, ownerName: string, weekStart: Date, defaultLocation?: { id: string; name: string }): VirtualLifeState {
  const start = new Date(weekStart); start.setHours(0,0,0,0);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  if (state.schedules.some(slot => slot.ownerType === ownerType && slot.ownerId === ownerId && new Date(slot.startAt) >= start && new Date(slot.startAt) < end)) return state;
  const now = new Date().toISOString(), slots: LifeScheduleSlot[] = [];
  const add = (day: Date, sh: number, sm: number, eh: number, em: number, title: string, kind: LifeScheduleSlot["kind"], location?: {id:string;name:string}) => {
    const from = new Date(day); from.setHours(sh,sm,0,0);
    const to = new Date(day); to.setHours(eh,em,0,0); if (to <= from) to.setDate(to.getDate()+1);
    const loc = location ?? defaultLocation;
    slots.push({ id: makeId("slot"), ownerType, ownerId, startAt: from.toISOString(), endAt: to.toISOString(), title, kind, source: "weekly-generation", plannedLocationId: loc?.id ?? null, plannedLocationName: loc?.name ?? null, updatedAt: now });
  };
  for (let offset=0; offset<7; offset++) {
    const day = new Date(start.getTime()+offset*DAY_MS), weekend = day.getDay()===0 || day.getDay()===6;
    add(day,7,0,7,30,"起床、洗漱","habit",{id:"home",name:"家"});
    add(day,7,30,8,0,"早餐","meal",{id:"home",name:"家"});
    if (!weekend) {
      add(day,8,0,9,0,"通勤 / 前往当天安排","commute");
      add(day,9,0,12,0,ownerType==="player"?"工作 / 学习（可自行修改）":`${ownerName}的工作 / 学习`,ownerType==="player"?"free-time":"work");
      add(day,12,0,13,0,"午餐","meal");
      add(day,13,0,18,0,ownerType==="player"?"下午安排（可自行修改）":`${ownerName}的下午安排`,ownerType==="player"?"free-time":"work");
    } else {
      add(day,8,0,9,0,"慢慢开始的一天","free-time",{id:"home",name:"家"});
      add(day,9,0,12,0,ownerType==="player"?"周末自由安排":`${ownerName}的周末安排`,"free-time");
      add(day,12,0,13,0,"午餐","meal");
      add(day,13,0,18,0,"休闲 / 个人计划","free-time");
    }
    add(day,18,0,19,0,"晚餐","meal");
    add(day,19,0,22,0,ownerType==="player"?"自由时间":`${ownerName}的私人时间`,"free-time",{id:"home",name:"家"});
    add(day,22,0,7,0,"睡眠","habit",{id:"home",name:"家"});
  }
  return { ...state, schedules: [...state.schedules,...slots].sort((a,b)=>a.startAt.localeCompare(b.startAt)) };
}

export function getCurrentActorSchedule(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, at: Date) {
  const time = at.getTime();
  return state.schedules.find(slot => slot.ownerType===ownerType && slot.ownerId===ownerId && new Date(slot.startAt).getTime()<=time && new Date(slot.endAt).getTime()>time);
}
export function makeLifeInvitation(state: VirtualLifeState, input: Omit<LifeInvitation,"id"|"status"|"updatedAt">): VirtualLifeState {
  const now = new Date().toISOString(), invitation: LifeInvitation = { ...input, id: makeId("invite"), status: "proposed", updatedAt: now };
  return { ...state, invitations: [invitation,...state.invitations] };
}
export function confirmLifeInvitation(state: VirtualLifeState, invitationId: string): VirtualLifeState {
  const invitation = state.invitations.find(item => item.id===invitationId && item.status==="proposed");
  if (!invitation) return state;
  const now = new Date().toISOString(), eventId = makeId("event");
  const event: LifeEvent = { id:eventId, kind:"invitation", status:"confirmed", startsAt:invitation.proposedAt, locationId:invitation.locationId, locationName:invitation.locationName, participantIds:["player",invitation.characterId], title:invitation.activity, details:"双方已确认的邀约；到时间后才开始，不会自动传送或跳过时间。", createdAt:now, updatedAt:now };
  const next = { ...invitation, status:"confirmed" as const, confirmedAt:now, updatedAt:now, eventId };
  return { ...state, invitations:state.invitations.map(item=>item.id===invitationId?next:item), events:[event,...state.events] };
}
export function currentVirtualDateForActor(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string): Date {
  return resolveActorLifeNow(getActorClock(state,ownerType,ownerId));
}
