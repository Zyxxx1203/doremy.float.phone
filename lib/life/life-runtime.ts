import type { LifeActorClock, LifeActorState, LifeEvent, LifeInvitation, LifeOwnerType, LifeScheduleSlot, LifeSceneState, VirtualLifeState } from "./life-types";

const DAY_MS = 86_400_000;
const clampSpeed = (speed: number) => Math.max(0.01, Math.min(Number.isFinite(speed) ? speed : 1, 1000));
const mondayStartLife = (date: Date) => { const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
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
export function generateWeeklyLifePlan(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, ownerName: string, weekStart: Date, defaultLocation?: { id: string; name: string }, profile = "", includeSpecialEvents = true): VirtualLifeState {
  const start = new Date(weekStart); start.setHours(0,0,0,0);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  if (state.schedules.some(slot => slot.ownerType === ownerType && slot.ownerId === ownerId && new Date(slot.startAt) >= start && new Date(slot.startAt) < end)) return state;
  const now = new Date().toISOString(), slots: LifeScheduleSlot[] = [];
  const profileText = profile.toLowerCase();
  const hash = [...ownerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) + start.getDate();
  const specialDay = ownerType === "character" && includeSpecialEvents && hash % 3 !== 0 ? hash % 7 : -1;
  const specialTitle = /摄影|拍照|相机|photo/i.test(profileText) ? "去拍些喜欢的照片" : /音乐|唱歌|乐器|music/i.test(profileText) ? "练习音乐 / 听现场" : /运动|健身|跑步|篮球|足球|sport/i.test(profileText) ? "运动与放松" : /读书|阅读|写作|学习|学生|book|study/i.test(profileText) ? "阅读 / 学习一会儿" : /烹饪|做饭|料理|cook/i.test(profileText) ? "试着做一道新菜" : "个人兴趣与临时安排";
  const specialLocation = /摄影|拍照|相机|运动|健身|跑步|photo|sport/i.test(profileText) ? { id: "park", name: "公园" } : /读书|阅读|写作|学习|学生|book|study/i.test(profileText) ? { id: "library", name: "图书馆" } : /音乐|唱歌|乐器|music/i.test(profileText) ? { id: "cafe", name: "街角咖啡店" } : { id: "home", name: "家" };
  const add = (day: Date, sh: number, sm: number, eh: number, em: number, title: string, kind: LifeScheduleSlot["kind"], location?: {id:string;name:string}) => {
    const from = new Date(day); from.setHours(sh,sm,0,0);
    const to = new Date(day); to.setHours(eh,em,0,0); if (to <= from) to.setDate(to.getDate()+1);
    const loc = location ?? defaultLocation;
    slots.push({ id: makeId("slot"), ownerType, ownerId, startAt: from.toISOString(), endAt: to.toISOString(), title, kind, source: "weekly-generation", plannedLocationId: loc?.id ?? null, plannedLocationName: loc?.name ?? null, updatedAt: now });
  };
  for (let offset=0; offset<7; offset++) {
    const day = new Date(start.getTime()+offset*DAY_MS), weekend = day.getDay()===0 || day.getDay()===6;
    add(day,0,0,7,0,"睡眠","habit",{id:"home",name:"家"});
    add(day,7,0,7,30,"起床、洗漱","habit",{id:"home",name:"家"});
    add(day,7,30,8,0,"早餐","meal",{id:"home",name:"家"});
    if (!weekend) {
      const daytimeLocation = /学生|大学|学校|study/i.test(profileText) ? {id:"school",name:"学校"} : {id:"work",name:"工作地点"};
      add(day,8,0,9,0,"通勤 / 前往当天安排","commute",{id:"transit",name:"通勤途中"});
      const daytime = ownerType === "player" ? "工作 / 学习（可自行修改）" : /学生|大学|学校|study/i.test(profileText) ? ownerName+"上课 / 学习" : /自由职业|艺术家|作家|画家|摄影|音乐|创业|freelance|artist/i.test(profileText) ? ownerName+"的创作 / 项目时间" : ownerName+"的工作 / 学习";
      add(day,9,0,12,0,daytime,ownerType==="player"?"free-time":"work",daytimeLocation);
      add(day,12,0,13,0,"午餐","meal",{id:"canteen",name:"食堂 / 附近餐馆"});
      add(day,13,0,18,0,ownerType==="player"?"下午安排（可自行修改）":ownerName+"的下午安排",ownerType==="player"?"free-time":"work",daytimeLocation);
    } else {
      add(day,8,0,9,0,"慢慢开始的一天","free-time",{id:"home",name:"家"});
      add(day,9,0,12,0,ownerType==="player"?"周末自由安排":ownerName+"的周末安排","free-time",{id:"home",name:"家"});
      add(day,12,0,13,0,"午餐","meal",{id:"home",name:"家"});
      add(day,13,0,18,0,"休闲 / 个人计划","free-time",{id:"home",name:"家"});
    }
    add(day,18,0,19,0,"晚餐","meal",{id:"home",name:"家"});
    if (offset === specialDay) {
      add(day,19,0,19,30,"回家 / 稍作休息","free-time",{id:"home",name:"家"});
      add(day,19,30,20,30,specialTitle,"special",specialLocation);
      add(day,20,30,22,0,"晚间自由时间","free-time",{id:"home",name:"家"});
    } else {
      add(day,19,0,22,0,ownerType==="player"?"自由时间":ownerName+"的私人时间","free-time",{id:"home",name:"家"});
    }
    add(day,22,0,24,0,"睡眠","habit",{id:"home",name:"家"});
  }
  return { ...state, schedules: [...state.schedules,...slots].sort((a,b)=>a.startAt.localeCompare(b.startAt)) };
}

/**
 * Catch up one actor to their own virtual now. Every completed schedule slot is
 * settled idempotently, and the current slot updates their real activity/location.
 * This runs on app resume and after explicit fast-forward; it never advances another actor.
 */
export function settleActorTimelineToNow(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  realNow = new Date(),
): VirtualLifeState {
  const clock = getActorClock(state, ownerType, ownerId);
  const virtualNow = resolveActorLifeNow(clock, realNow);
  const nowIso = realNow.toISOString();
  let events = state.events;
  let memories = state.memories;
  let invitations = state.invitations;
  let scenes = state.scenes;
  const settledKeys = new Set(events.map(event => event.settlementKey).filter(Boolean));
  for (const slot of state.schedules) {
    if (slot.ownerType !== ownerType || slot.ownerId !== ownerId) continue;
    const endMs = new Date(slot.endAt).getTime();
    if (!Number.isFinite(endMs) || endMs > virtualNow.getTime()) continue;
    const settlementKey = "schedule:" + slot.id;
    if (settledKeys.has(settlementKey)) continue;
    const event: LifeEvent = {
      id: "life-slot-" + slot.id,
      kind: "activity",
      status: "completed",
      startsAt: slot.startAt,
      endsAt: slot.endAt,
      locationId: slot.plannedLocationId ?? undefined,
      locationName: slot.plannedLocationName ?? undefined,
      participantIds: [ownerId],
      title: slot.title,
      details: "该时段已按个人时间线经过并结算。",
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: nowIso,
      settlementKey,
    };
    events = [...events, event];
    settledKeys.add(settlementKey);
  }
  for (const event of [...events]) {
    if (event.kind !== "invitation" || (event.status !== "confirmed" && event.status !== "active") || !event.startsAt || !event.endsAt) continue;
    const allAtOrAfter = (iso: string) => event.participantIds.every(participantId => {
      const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
      return resolveActorLifeNow(getActorClock(state, participantType, participantId), realNow).getTime() >= new Date(iso).getTime();
    });
    const started = allAtOrAfter(event.startsAt);
    const ended = allAtOrAfter(event.endsAt);
    const characterId = event.participantIds.find(participantId => participantId !== "player");
    const matchingScene = scenes.find(scene =>
      (scene.status === "active" || scene.status === "paused")
      && (!event.locationId || scene.locationId === event.locationId)
      && event.participantIds.every(participantId => scene.participants.some(participant => participant.ownerId === participantId))
    );
    if (ended) {
      const actuallyOccurred = event.details === "follow-player"
        ? event.status === "active" && !!findActorState(state, "player", "player")?.actualLocationId
        : scenes.some(scene => scene.eventId === event.id);
      const nextStatus = actuallyOccurred ? "completed" as const : "cancelled" as const;
      const updated = { ...event, status: nextStatus, updatedAt: nowIso, ...(actuallyOccurred ? { completedAt: nowIso } : { cancelledAt: nowIso }), settlementKey: "invitation:" + event.id, details: actuallyOccurred ? event.details : "missed:no-shared-scene-before-end" };
      events = events.map(item => item.id === event.id ? updated : item);
      invitations = invitations.map(invite => invite.eventId === event.id ? { ...invite, status: actuallyOccurred ? "completed" as const : "cancelled" as const, updatedAt: nowIso } : invite);
      const memoryId = "memory-" + event.id;
      if (actuallyOccurred && !memories.some(memory => memory.id === memoryId)) {
        memories = [{
          id: memoryId, eventId: event.id, occurredAt: event.endsAt, participants: event.participantIds,
          fact: (event.details === "follow-player" ? "角色陪伴并跟随玩家完成了约定时段" : "双方共同完成约定活动") + "「" + event.title + "」" + (event.locationName ? "，地点：" + event.locationName : "") + "。",
        }, ...memories].slice(0, 500);
      }
    } else if (started && event.status === "confirmed") {
      if (event.details === "follow-player") {
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      } else if (matchingScene) {
        scenes = scenes.map(scene => scene.id === matchingScene.id ? { ...scene, eventId: event.id, updatedAt: nowIso } : scene);
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      }
    }
    void characterId;
  }
  const current = getCurrentActorSchedule(state, ownerType, ownerId, virtualNow);
  const previous = findActorState(state, ownerType, ownerId);
  const slotChanged = !!current && previous?.scheduleSlotId !== current.id;
  const nextActivity = slotChanged ? current.title : previous?.activity ?? current?.title ?? "时间线待补全";
  // A schedule is a plan, not physical movement. Only seed a location from the plan
  // when the actor has no known actual location; explicit travel changes stay in effect
  // until another real location change is recorded.
  const nextLocationId = previous?.actualLocationId ?? current?.plannedLocationId ?? null;
  const nextLocationName = previous?.actualLocationName ?? current?.plannedLocationName ?? null;
  const nextSlotId = current?.id ?? previous?.scheduleSlotId ?? null;
  const actorChanged = !previous || previous.activity !== nextActivity || (previous.actualLocationId ?? null) !== nextLocationId || (previous.actualLocationName ?? null) !== nextLocationName || (previous.scheduleSlotId ?? null) !== nextSlotId;
  const actorStates = actorChanged
    ? [...state.actorStates.filter(actor => !(actor.ownerType === ownerType && actor.ownerId === ownerId)), {
        ownerType, ownerId, activity: nextActivity, scheduleSlotId: nextSlotId,
        actualLocationId: nextLocationId, actualLocationName: nextLocationName, updatedAt: nowIso,
      }]
    : state.actorStates;
  let finalActorStates = actorStates;
  for (const event of events) {
    if (event.kind !== "invitation" || event.status !== "active" || event.details !== "follow-player") continue;
    const characterId = event.participantIds.find(participantId => participantId !== "player");
    const playerState = finalActorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const characterState = finalActorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
    if (!characterId || !playerState?.actualLocationId || !playerState.actualLocationName || !characterState) continue;
    if (characterState.actualLocationId === playerState.actualLocationId && characterState.activity === "正在陪伴玩家") continue;
    finalActorStates = [
      ...finalActorStates.filter(actor => !(actor.ownerType === "character" && actor.ownerId === characterId)),
      { ...characterState, activity: "正在陪伴玩家", actualLocationId: playerState.actualLocationId, actualLocationName: playerState.actualLocationName, updatedAt: nowIso },
    ];
  }
  if (events === state.events && memories === state.memories && invitations === state.invitations && scenes === state.scenes && finalActorStates === state.actorStates) return state;
  return { ...state, events, memories, invitations, scenes, actorStates: finalActorStates, updatedAt: nowIso };
}

/** Explicit fast-forward advances one actor, then settles every crossed schedule segment. */
export function advanceActorTimeline(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  minutes: number,
  ownerName = ownerId,
  profile = "",
  realNow = new Date(),
): VirtualLifeState {
  const current = resolveActorLifeNow(getActorClock(state, ownerType, ownerId), realNow);
  const target = new Date(current.getTime() + Math.max(0, minutes) * 60_000);
  const existing = state.schedules.filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId);
  const latestEnd = existing.reduce((max, slot) => Math.max(max, new Date(slot.endAt).getTime()), Number.NEGATIVE_INFINITY);
  let week = mondayStartLife(Number.isFinite(latestEnd) && latestEnd > current.getTime() ? new Date(latestEnd - 1) : current);
  const targetWeek = mondayStartLife(target);
  let next = state;
  // Fast-forward may cross many days/weeks. Fill every crossed week before settling.
  for (let guard = 0; week.getTime() <= targetWeek.getTime() && guard < 520; guard++, week = new Date(week.getTime() + 7 * DAY_MS)) {
    next = generateWeeklyLifePlan(next, ownerType, ownerId, ownerName, week, { id: "home", name: "家" }, profile, true);
  }
  const advanced = fastForwardActor(next, ownerType, ownerId, minutes, realNow);
  return settleActorTimelineToNow(advanced, ownerType, ownerId, realNow);
}

export function getCurrentActorSchedule(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, at: Date) {
  const time = at.getTime();
  return state.schedules.find(slot => slot.ownerType===ownerType && slot.ownerId===ownerId && new Date(slot.startAt).getTime()<=time && new Date(slot.endAt).getTime()>time);
}
export function makeLifeInvitation(state: VirtualLifeState, input: Omit<LifeInvitation,"id"|"status"|"updatedAt">): VirtualLifeState {
  const now = new Date().toISOString(), invitation: LifeInvitation = { ...input, id: makeId("invite"), status: "proposed", updatedAt: now };
  return { ...state, invitations: [invitation,...state.invitations] };
}
export function placeAppointmentInActorSchedule(state: VirtualLifeState, slot: LifeScheduleSlot): VirtualLifeState {
  const start = new Date(slot.startAt).getTime(), end = new Date(slot.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return state;
  const nextSlots: LifeScheduleSlot[] = [];
  for (const existing of state.schedules) {
    const sameOwner = existing.ownerType === slot.ownerType && existing.ownerId === slot.ownerId;
    const a = new Date(existing.startAt).getTime(), b = new Date(existing.endAt).getTime();
    if (!sameOwner || b <= start || a >= end) { nextSlots.push(existing); continue; }
    // Preserve unaffected time before and after the appointment instead of creating gaps.
    if (a < start) nextSlots.push({ ...existing, id: existing.id + "-before-" + slot.id, endAt: slot.startAt, updatedAt: new Date().toISOString() });
    if (b > end) nextSlots.push({ ...existing, id: existing.id + "-after-" + slot.id, startAt: slot.endAt, updatedAt: new Date().toISOString() });
  }
  nextSlots.push(slot);
  nextSlots.sort((a,b)=>a.startAt.localeCompare(b.startAt));
  return { ...state, schedules: nextSlots };
}

export function confirmLifeInvitation(state: VirtualLifeState, invitationId: string): VirtualLifeState {
  const invitation = state.invitations.find(item => item.id===invitationId && item.status==="proposed");
  if (!invitation) return state;
  const now = new Date().toISOString(), eventId = makeId("event");
  const startAt = new Date(invitation.proposedAt);
  const durationMinutes = Math.max(15, Math.min(invitation.durationMinutes ?? 60, 24 * 60));
  const endsAt = new Date(startAt.getTime() + durationMinutes * 60_000).toISOString();
  const event: LifeEvent = { id:eventId, kind:"invitation", status:"confirmed", startsAt:invitation.proposedAt, endsAt, locationId:invitation.locationId, locationName:invitation.locationName, participantIds:["player",invitation.characterId], title:invitation.activity, details:invitation.kind === "follow-request" ? "follow-player" : "confirmed-appointment", createdAt:now, updatedAt:now };
  const next = { ...invitation, status:"confirmed" as const, confirmedAt:now, updatedAt:now, eventId };
  return { ...state, invitations:state.invitations.map(item=>item.id===invitationId?next:item), events:[event,...state.events] };
}
export function currentVirtualDateForActor(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string): Date {
  return resolveActorLifeNow(getActorClock(state,ownerType,ownerId));
}
