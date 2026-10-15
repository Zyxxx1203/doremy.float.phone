import type { LifeActorClock, LifeActorState, LifeEvent, LifeInvitation, LifeOwnerType, LifeScheduleSlot, LifeSceneState, VirtualLifeState } from "./life-types";

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
export function generateWeeklyLifePlan(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  ownerName: string,
  weekStart: Date,
  defaultLocation?: { id: string; name: string },
  profile = "",
  includeSpecialEvents = true,
): VirtualLifeState {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const ownerSlots = state.schedules.filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId);
  const weekSlots = ownerSlots.filter(slot => {
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    return Number.isFinite(slotStart) && Number.isFinite(slotEnd)
      && slotStart < end.getTime() && slotEnd > start.getTime();
  });

  // Fast-path a fully covered week. Partial legacy weeks continue through the
  // normal generator, which preserves these slots and fills only the gaps.
  const coverage = weekSlots
    .map(slot => ({
      start: Math.max(start.getTime(), new Date(slot.startAt).getTime()),
      end: Math.min(end.getTime(), new Date(slot.endAt).getTime()),
    }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let coveredUntil = start.getTime();
  for (const range of coverage) {
    if (range.start > coveredUntil) break;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= end.getTime()) return state;
  }

  const now = new Date().toISOString();
  const slots: LifeScheduleSlot[] = [];
  const profileText = profile.toLowerCase();
  const hash = [...ownerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) + start.getDate();
  const specialDay = ownerType === "character" && includeSpecialEvents && hash % 3 !== 0 ? hash % 7 : -1;
  const specialTitle = /摄影|拍照|相机|photo/i.test(profileText) ? "去拍些喜欢的照片" : /音乐|唱歌|乐器|music/i.test(profileText) ? "练习音乐 / 听现场" : /运动|健身|跑步|篮球|足球|sport/i.test(profileText) ? "运动与放松" : /读书|阅读|写作|学习|学生|book|study/i.test(profileText) ? "阅读 / 学习一会儿" : /烹饪|做饭|料理|cook/i.test(profileText) ? "试着做一道新菜" : "个人兴趣与临时安排";
  const specialLocation = /摄影|拍照|相机|运动|健身|跑步|photo|sport/i.test(profileText) ? { id: "park", name: "公园" } : /读书|阅读|写作|学习|学生|book|study/i.test(profileText) ? { id: "library", name: "图书馆" } : /音乐|唱歌|乐器|music/i.test(profileText) ? { id: "cafe", name: "街角咖啡店" } : { id: "home", name: "家" };
  const add = (day: Date, sh: number, sm: number, eh: number, em: number, title: string, kind: LifeScheduleSlot["kind"], location?: { id: string; name: string }) => {
    const from = new Date(day);
    from.setHours(sh, sm, 0, 0);
    const to = new Date(day);
    to.setHours(eh, em, 0, 0);
    if (to <= from) to.setDate(to.getDate() + 1);
    const loc = location ?? defaultLocation;
    slots.push({
      id: makeId("slot"), ownerType, ownerId, startAt: from.toISOString(), endAt: to.toISOString(),
      title, kind, source: "weekly-generation",
      plannedLocationId: loc?.id ?? null, plannedLocationName: loc?.name ?? null, updatedAt: now,
    });
  };

  // Use calendar-day arithmetic rather than adding 24 hours, so daylight-saving
  // transitions cannot shift the generated local schedule by an hour.
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    add(day, 0, 0, 7, 0, "睡眠", "habit", { id: "home", name: "家" });
    add(day, 7, 0, 7, 30, "起床、洗漱", "habit", { id: "home", name: "家" });
    add(day, 7, 30, 8, 0, "早餐", "meal", { id: "home", name: "家" });
    if (!weekend) {
      const daytimeLocation = /学生|大学|学校|study/i.test(profileText) ? { id: "school", name: "学校" } : { id: "work", name: "工作地点" };
      add(day, 8, 0, 9, 0, "通勤 / 前往当天安排", "commute", { id: "transit", name: "通勤途中" });
      const daytime = ownerType === "player" ? "工作 / 学习（可自行修改）" : /学生|大学|学校|study/i.test(profileText) ? ownerName + "上课 / 学习" : /自由职业|艺术家|作家|画家|摄影|音乐|创业|freelance|artist/i.test(profileText) ? ownerName + "的创作 / 项目时间" : ownerName + "的工作 / 学习";
      add(day, 9, 0, 12, 0, daytime, ownerType === "player" ? "free-time" : "work", daytimeLocation);
      add(day, 12, 0, 13, 0, "午餐", "meal", { id: "canteen", name: "食堂 / 附近餐馆" });
      add(day, 13, 0, 18, 0, ownerType === "player" ? "下午安排（可自行修改）" : ownerName + "的下午安排", ownerType === "player" ? "free-time" : "work", daytimeLocation);
    } else {
      add(day, 8, 0, 9, 0, "慢慢开始的一天", "free-time", { id: "home", name: "家" });
      add(day, 9, 0, 12, 0, ownerType === "player" ? "周末自由安排" : ownerName + "的周末安排", "free-time", { id: "home", name: "家" });
      add(day, 12, 0, 13, 0, "午餐", "meal", { id: "home", name: "家" });
      add(day, 13, 0, 18, 0, "休闲 / 个人计划", "free-time", { id: "home", name: "家" });
    }
    add(day, 18, 0, 19, 0, "晚餐", "meal", { id: "home", name: "家" });
    if (offset === specialDay) {
      add(day, 19, 0, 19, 30, "回家 / 稍作休息", "free-time", { id: "home", name: "家" });
      add(day, 19, 30, 20, 30, specialTitle, "special", specialLocation);
      add(day, 20, 30, 22, 0, "晚间自由时间", "free-time", { id: "home", name: "家" });
    } else {
      add(day, 19, 0, 22, 0, ownerType === "player" ? "自由时间" : ownerName + "的私人时间", "free-time", { id: "home", name: "家" });
    }
    add(day, 22, 0, 24, 0, "睡眠", "habit", { id: "home", name: "家" });
  }

  const occupied = weekSlots
    .map(slot => ({ start: new Date(slot.startAt).getTime(), end: new Date(slot.endAt).getTime() }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const generated: LifeScheduleSlot[] = [];
  for (const template of slots) {
    const templateStart = new Date(template.startAt).getTime();
    const templateEnd = new Date(template.endAt).getTime();
    let cursor = templateStart;
    let part = 0;
    for (const range of occupied) {
      if (range.end <= cursor) continue;
      if (range.start >= templateEnd) break;
      if (range.start > cursor) {
        const partEnd = Math.min(range.start, templateEnd);
        if (partEnd > cursor) {
          generated.push({
            ...template,
            id: part === 0 && partEnd === templateEnd ? template.id : template.id + "-part-" + part,
            startAt: new Date(cursor).toISOString(),
            endAt: new Date(partEnd).toISOString(),
          });
          part++;
        }
      }
      cursor = Math.max(cursor, range.end);
      if (cursor >= templateEnd) break;
    }
    if (cursor < templateEnd) {
      generated.push({
        ...template,
        id: part === 0 && cursor === templateStart ? template.id : template.id + "-part-" + part,
        startAt: new Date(cursor).toISOString(),
        endAt: template.endAt,
      });
    }
  }

  if (generated.length === 0) return state;
  return { ...state, schedules: [...state.schedules, ...generated].sort((a, b) => a.startAt.localeCompare(b.startAt)) };
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
    // An event-linked scene remains the canonical scene even if a previous
    // partial save left its status out of sync with the event. Reuse it first
    // to avoid duplicate scene records during recovery.
    let matchingScene = scenes.find(scene => scene.eventId === event.id)
      ?? scenes.find(scene =>
        (scene.status === "active" || scene.status === "paused")
        && !scene.eventId
        && (event.locationId
          ? scene.locationId === event.locationId
          : event.locationName ? scene.locationName === event.locationName : true)
        && event.participantIds.every(participantId => scene.participants.some(participant =>
          participant.ownerId === participantId
          && participant.ownerType === (participantId === "player" ? "player" : "character")
        ))
      );

    // Catch-up must settle the whole virtual interval, even if the app was not
    // opened until after the appointment ended. Otherwise a confirmed event
    // would be incorrectly marked "missed" simply because no page timer ran.
    if (started && (event.status === "confirmed" || event.status === "active") && event.details !== "follow-player") {
      if (matchingScene) {
        // Reuse an already-recorded shared scene at the agreed location rather
        // than losing the event merely because the scene was opened manually.
        const attachedScene: LifeSceneState = {
          ...matchingScene,
          eventId: event.id,
          status: ended ? "completed" : "active",
          updatedAt: nowIso,
        };
        if (matchingScene.eventId !== event.id || matchingScene.status !== attachedScene.status) {
          matchingScene = attachedScene;
          scenes = scenes.map(scene => scene.id === attachedScene.id ? attachedScene : scene);
        }
      } else {
        const playerPresence = findActorState(state, "player", "player");
        const characterPresence = event.participantIds
          .filter(participantId => participantId !== "player")
          .map(participantId => findActorState(state, "character", participantId))
          .find(Boolean);
        const locationId = event.locationId ?? playerPresence?.actualLocationId ?? characterPresence?.actualLocationId ?? "home";
        const locationName = event.locationName
          ?? state.locations.find(location => location.id === locationId)?.name
          ?? playerPresence?.actualLocationName
          ?? characterPresence?.actualLocationName
          ?? "家";
        const participants = event.participantIds.map(participantId => {
          const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
          return {
            ownerType: participantType,
            ownerId: participantId,
            activity: event.title,
            awarenessByActorId: Object.fromEntries(
              event.participantIds.filter(otherId => otherId !== participantId).map(otherId => [otherId, "aware" as const]),
            ),
          };
        });
        matchingScene = {
          id: makeId("scene"),
          locationId,
          locationName,
          startedAt: event.startsAt,
          updatedAt: nowIso,
          status: ended ? "completed" : "active",
          eventId: event.id,
          participants,
          lastSettledEventIds: [],
        };
        scenes = [...scenes, matchingScene];
      }
      // If an already-active appointment is being recovered while it is still
      // underway, its scene takes precedence over any stale active scene. For
      // historical appointments (ended=true), do not disturb today's scene.
      if (!ended && event.status === "active" && matchingScene) {
        scenes = scenes.map(scene => scene.id !== matchingScene!.id && scene.status === "active"
          ? { ...scene, status: "paused" as const, updatedAt: nowIso }
          : scene);
      }
    }

    if (ended) {
      const actuallyOccurred = event.details === "follow-player"
        ? event.status === "active" && !!findActorState(state, "player", "player")?.actualLocationId
        : scenes.some(scene => scene.eventId === event.id);
      const nextStatus = actuallyOccurred ? "completed" as const : "cancelled" as const;
      const updated = { ...event, status: nextStatus, updatedAt: nowIso, ...(actuallyOccurred ? { completedAt: nowIso } : { cancelledAt: nowIso }), settlementKey: "invitation:" + event.id, details: actuallyOccurred ? event.details : "missed:no-shared-scene-before-end" };
      events = events.map(item => item.id === event.id ? updated : item);
      invitations = invitations.map(invite => invite.eventId === event.id ? { ...invite, status: actuallyOccurred ? "completed" as const : "cancelled" as const, updatedAt: nowIso } : invite);
      const memoryId = "memory-" + event.id;
      if (actuallyOccurred && state.settings.saveConfirmedEventsToMemory && !memories.some(memory => memory.id === memoryId)) {
        memories = [{
          id: memoryId, eventId: event.id, occurredAt: event.endsAt, participants: event.participantIds,
          fact: (event.details === "follow-player" ? "角色陪伴并跟随玩家完成了约定时段" : "双方共同完成约定活动") + "「" + event.title + "」" + (event.locationName ? "，地点：" + event.locationName : "") + "。",
        }, ...memories].slice(0, 500);
      }
    } else if (started && event.status === "confirmed") {
      if (event.details === "follow-player") {
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      } else if (matchingScene) {
        scenes = scenes.map(scene => scene.id === matchingScene.id
          ? { ...scene, eventId: event.id, status: "active" as const, updatedAt: nowIso }
          : scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: nowIso } : scene);
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      } else {
        // A confirmed appointment is a real transition, not just a label in the
        // calendar. If the actors have both reached its start time, create the
        // shared scene automatically rather than cancelling it later because
        // the user had not manually opened the destination.
        const playerPresence = findActorState(state, "player", "player");
        const characterPresence = event.participantIds
          .filter(participantId => participantId !== "player")
          .map(participantId => findActorState(state, "character", participantId))
          .find(Boolean);
        const locationId = event.locationId ?? playerPresence?.actualLocationId ?? characterPresence?.actualLocationId ?? "home";
        const locationName = event.locationName
          ?? state.locations.find(location => location.id === locationId)?.name
          ?? playerPresence?.actualLocationName
          ?? characterPresence?.actualLocationName
          ?? "家";
        const participants = event.participantIds.map(participantId => {
          const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
          return {
            ownerType: participantType,
            ownerId: participantId,
            activity: event.title,
            awarenessByActorId: Object.fromEntries(
              event.participantIds.filter(otherId => otherId !== participantId).map(otherId => [otherId, "aware" as const]),
            ),
          };
        });
        const newScene: LifeSceneState = {
          id: makeId("scene"),
          locationId,
          locationName,
          startedAt: event.startsAt,
          updatedAt: nowIso,
          status: "active",
          eventId: event.id,
          participants,
          lastSettledEventIds: [],
        };
        scenes = [
          ...scenes.map(scene => scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: nowIso } : scene),
          newScene,
        ];
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      }
    }
    void characterId;
  }
  const current = getCurrentActorSchedule(state, ownerType, ownerId, virtualNow);
  const previous = findActorState(state, ownerType, ownerId);
  const slotChanged = !!current && previous?.scheduleSlotId !== current.id;
  // A schedule is a plan, not physical movement. A manually chosen location is
  // respected until its expected stay expires; confirmed shared appointments are
  // the exception because reaching their start time begins the agreed activity.
  const stayExpired = !!previous?.actualLocationUntil && new Date(previous.actualLocationUntil).getTime() <= virtualNow.getTime();
  const activeAppointment = current?.kind === "appointment" && current.source === "event"
    ? events.find(event =>
        event.kind === "invitation"
        && event.status === "active"
        && event.details !== "follow-player"
        && event.participantIds.includes(ownerId)
        && !!event.startsAt && !!event.endsAt
        && new Date(event.startsAt).getTime() <= virtualNow.getTime()
        && new Date(event.endsAt).getTime() > virtualNow.getTime()
      )
    : undefined;
  const nextActivity = activeAppointment
    ? current.title
    : stayExpired
      ? current?.title ?? previous?.activity ?? "自由活动"
      : current && slotChanged
        ? current.title
        : !current && previous?.scheduleSlotId
          ? "自由活动"
          : previous?.activity ?? current?.title ?? "自由活动";
  // A missing current slot must clear the old slot reference. Otherwise deleting
  // or editing a schedule can leave an actor permanently attached to stale activity.
  const nextLocationId = activeAppointment
    ? current?.plannedLocationId ?? previous?.actualLocationId ?? null
    : stayExpired
      ? current?.plannedLocationId ?? previous?.actualLocationId ?? null
      : previous?.actualLocationId ?? current?.plannedLocationId ?? null;
  const nextLocationName = activeAppointment
    ? current?.plannedLocationName ?? previous?.actualLocationName ?? null
    : stayExpired
      ? current?.plannedLocationName ?? previous?.actualLocationName ?? null
      : previous?.actualLocationName ?? current?.plannedLocationName ?? null;
  const nextLocationUntil = activeAppointment
    ? current?.endAt ?? previous?.actualLocationUntil ?? null
    : stayExpired ? null : previous?.actualLocationUntil ?? null;
  const nextSlotId = current?.id ?? null;
  const actorChanged = !previous || previous.activity !== nextActivity || (previous.actualLocationId ?? null) !== nextLocationId || (previous.actualLocationName ?? null) !== nextLocationName || (previous.actualLocationUntil ?? null) !== nextLocationUntil || (previous.scheduleSlotId ?? null) !== nextSlotId;
  const actorStates = actorChanged
    ? [...state.actorStates.filter(actor => !(actor.ownerType === ownerType && actor.ownerId === ownerId)), {
        ownerType, ownerId, activity: nextActivity, scheduleSlotId: nextSlotId,
        actualLocationId: nextLocationId, actualLocationName: nextLocationName,
        actualLocationUntil: nextLocationUntil, updatedAt: nowIso,
      }]
    : state.actorStates;
  let timeline = state.timeline;
  if (stayExpired && ownerType === "player" && nextLocationId && nextLocationName && previous?.actualLocationId !== nextLocationId) {
    const activeScene = scenes.find(scene => scene.status === "active");
    if (activeScene) {
      scenes = scenes.map(scene => scene.id === activeScene.id
        ? { ...scene, locationId: nextLocationId, locationName: nextLocationName, updatedAt: nowIso }
        : scene);
    }
    timeline = [...timeline, {
      id: makeId("timeline"),
      category: "location",
      occurredAt: virtualNow.toISOString(),
      recordedAt: nowIso,
      title: "按原计划前往" + nextLocationName,
      details: "临时停留时间已结束，生活行程恢复执行。",
      actorId: ownerId,
      actorName: state.settings.playerDisplayName || "我",
      locationName: nextLocationName,
      sceneId: activeScene?.id,
    }];
  }
  let finalActorStates = actorStates;
  for (const event of events) {
    if (event.kind !== "invitation" || event.status !== "active" || event.details !== "follow-player") continue;
    const characterId = event.participantIds.find(participantId => participantId !== "player");
    const playerState = finalActorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const characterState = finalActorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
    if (!characterId || !playerState?.actualLocationId || !playerState.actualLocationName || !characterState) continue;
    if (characterState.actualLocationId === playerState.actualLocationId
      && characterState.activity === "正在陪伴玩家"
      && characterState.actualLocationUntil === event.endsAt) continue;
    finalActorStates = [
      ...finalActorStates.filter(actor => !(actor.ownerType === "character" && actor.ownerId === characterId)),
      {
        ...characterState,
        activity: "正在陪伴玩家",
        actualLocationId: playerState.actualLocationId,
        actualLocationName: playerState.actualLocationName,
        actualLocationUntil: event.endsAt,
        updatedAt: nowIso,
      },
    ];
  }
  if (events === state.events && memories === state.memories && invitations === state.invitations && scenes === state.scenes && finalActorStates === state.actorStates && timeline === state.timeline) return state;
  return { ...state, events, memories, invitations, scenes, actorStates: finalActorStates, timeline, updatedAt: nowIso };
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
  let week = mondayStartLife(current);
  const targetWeek = mondayStartLife(target);
  let next = state;
  // Always begin at the current virtual week. A single manually authored slot
  // far in the future must not make us skip missing baseline days before it.
  // Existing generated weeks are stable no-ops, so revisiting them is safe.
  for (let guard = 0; week.getTime() <= targetWeek.getTime() && guard < 520; guard++) {
    next = generateWeeklyLifePlan(next, ownerType, ownerId, ownerName, week, { id: "home", name: "家" }, profile, true);
    week.setDate(week.getDate() + 7);
  }
  const advanced = fastForwardActor(next, ownerType, ownerId, minutes, realNow);
  return settleActorTimelineToNow(advanced, ownerType, ownerId, realNow);
}

export function getCurrentActorSchedule(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, at: Date) {
  const time = at.getTime();
  return state.schedules
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
    .filter(slot => {
      const start = new Date(slot.startAt).getTime();
      const end = new Date(slot.endAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && start <= time && end > time;
    })
    // If legacy data contains overlaps, the most recently started slot wins
    // deterministically instead of whichever item happened to be stored first.
    .sort((a, b) =>
      new Date(b.startAt).getTime() - new Date(a.startAt).getTime()
      || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      || a.id.localeCompare(b.id)
    )[0];
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
    if (!sameOwner || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
      nextSlots.push(existing);
      continue;
    }
    // Preserve unaffected time before and after the appointment instead of creating gaps.
    if (a < start) nextSlots.push({ ...existing, id: existing.id + "-before-" + slot.id, endAt: slot.startAt, updatedAt: new Date().toISOString() });
    if (b > end) nextSlots.push({ ...existing, id: existing.id + "-after-" + slot.id, startAt: slot.endAt, updatedAt: new Date().toISOString() });
  }
  nextSlots.push(slot);
  nextSlots.sort((a,b)=>a.startAt.localeCompare(b.startAt));
  return { ...state, schedules: nextSlots };
}

/**
 * Insert a user-authored schedule item without silently overwriting another
 * manual plan or a confirmed appointment. Generated baseline slots may be
 * split around it so the person's day remains continuous.
 */
export function insertManualLifeScheduleSlot(
  state: VirtualLifeState,
  slot: LifeScheduleSlot,
): { state: VirtualLifeState; conflict?: LifeScheduleSlot; error?: string } {
  const start = new Date(slot.startAt).getTime();
  const end = new Date(slot.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { state, error: "日程时间无效，结束时间必须晚于开始时间。" };
  }

  const overlapping = state.schedules.filter(existing => {
    if (existing.ownerType !== slot.ownerType || existing.ownerId !== slot.ownerId) return false;
    const a = new Date(existing.startAt).getTime();
    const b = new Date(existing.endAt).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && a < end && b > start;
  });
  const conflict = overlapping.find(existing =>
    existing.kind === "appointment" || existing.source === "manual" || existing.source === "event" || existing.source === "character-tool"
  );
  if (conflict) return { state, conflict };

  const now = new Date().toISOString();
  const nextSlots: LifeScheduleSlot[] = [];
  for (const existing of state.schedules) {
    const sameOwner = existing.ownerType === slot.ownerType && existing.ownerId === slot.ownerId;
    const a = new Date(existing.startAt).getTime();
    const b = new Date(existing.endAt).getTime();
    if (!sameOwner || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
      nextSlots.push(existing);
      continue;
    }
    if (a < start) {
      nextSlots.push({
        ...existing,
        id: existing.id + "-before-" + slot.id,
        endAt: slot.startAt,
        updatedAt: now,
      });
    }
    if (b > end) {
      nextSlots.push({
        ...existing,
        id: existing.id + "-after-" + slot.id,
        startAt: slot.endAt,
        updatedAt: now,
      });
    }
  }
  nextSlots.push({ ...slot, updatedAt: now });
  return { state: { ...state, schedules: nextSlots.sort((a, b) => a.startAt.localeCompare(b.startAt)) } };
}

/**
 * Apply a character-authored schedule change through one shared business rule.
 * It may reshape generated or previous character-tool slots, but never silently
 * overwrites user-authored plans or confirmed events.
 */
export function applyCharacterLifeScheduleChange(
  state: VirtualLifeState,
  characterId: string,
  input: { startAt: string; endAt: string; title: string; locationId?: string },
  realNow = new Date(),
): { state: VirtualLifeState; error?: string } {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  const title = input.title.trim().slice(0, 120);
  if (!title || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
    return { state, error: "需要有效的活动内容和开始/结束时间，且结束时间必须晚于开始时间。" };
  }
  const characterNow = resolveActorLifeNow(getActorClock(state, "character", characterId), realNow);
  const sameDay = startAt.getFullYear() === characterNow.getFullYear()
    && startAt.getMonth() === characterNow.getMonth()
    && startAt.getDate() === characterNow.getDate()
    && endAt.getFullYear() === characterNow.getFullYear()
    && endAt.getMonth() === characterNow.getMonth()
    && endAt.getDate() === characterNow.getDate();
  if (!sameDay || startAt <= characterNow) {
    return { state, error: "只能调整角色当前虚拟日中尚未开始的时段。" };
  }

  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  const conflict = state.schedules.find(slot => {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId) return false;
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) return false;
    return (slot.kind === "appointment" || slot.source === "manual" || slot.source === "event")
      && slotStart < endMs
      && slotEnd > startMs;
  });
  if (conflict) return { state, error: "该时段与「" + conflict.title + "」冲突；没有覆盖用户安排或已确认约会。" };

  const locationId = input.locationId?.trim();
  const location = state.locations.find(item => item.id === locationId) ?? state.locations.find(item => item.id === "home");
  const schedules: LifeScheduleSlot[] = [];
  const updatedAt = realNow.toISOString();
  for (const slot of state.schedules) {
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (
      slot.ownerType !== "character"
      || slot.ownerId !== characterId
      || slot.kind === "appointment"
      || !Number.isFinite(slotStart)
      || !Number.isFinite(slotEnd)
      || slotEnd <= startMs
      || slotStart >= endMs
    ) {
      schedules.push(slot);
      continue;
    }
    if (slotStart < startMs) {
      schedules.push({ ...slot, id: slot.id + "-before-life-tool-" + startMs, endAt: startAt.toISOString(), updatedAt });
    }
    if (slotEnd > endMs) {
      schedules.push({ ...slot, id: slot.id + "-after-life-tool-" + endMs, startAt: endAt.toISOString(), updatedAt });
    }
  }
  schedules.push({
    id: "life-tool-plan-" + characterId + "-" + startMs,
    ownerType: "character",
    ownerId: characterId,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    title,
    plannedLocationId: location?.id ?? null,
    plannedLocationName: location?.name ?? null,
    kind: "free-time",
    source: "character-tool",
    updatedAt,
  });
  return { state: { ...state, schedules: schedules.sort((a, b) => a.startAt.localeCompare(b.startAt)) } };
}

export function confirmLifeInvitation(state: VirtualLifeState, invitationId: string): VirtualLifeState {
  const invitation = state.invitations.find(item => item.id===invitationId && item.status==="proposed");
  if (!invitation) return state;
  const startAt = new Date(invitation.proposedAt);
  if (!Number.isFinite(startAt.getTime())) return state;
  const rawDuration = invitation.durationMinutes;
  const durationMinutes = typeof rawDuration === "number" && Number.isFinite(rawDuration)
    ? Math.max(15, Math.min(rawDuration, 24 * 60))
    : 60;
  const endsAt = new Date(startAt.getTime() + durationMinutes * 60_000).toISOString();
  const now = new Date().toISOString(), eventId = makeId("event");
  const event: LifeEvent = { id:eventId, kind:"invitation", status:"confirmed", startsAt:invitation.proposedAt, endsAt, locationId:invitation.locationId, locationName:invitation.locationName, participantIds:["player",invitation.characterId], title:invitation.activity, details:invitation.kind === "follow-request" ? "follow-player" : "confirmed-appointment", createdAt:now, updatedAt:now };
  const next = { ...invitation, status:"confirmed" as const, confirmedAt:now, updatedAt:now, eventId };
  return { ...state, invitations:state.invitations.map(item=>item.id===invitationId?next:item), events:[event,...state.events] };
}
export function currentVirtualDateForActor(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string): Date {
  return resolveActorLifeNow(getActorClock(state,ownerType,ownerId));
}
