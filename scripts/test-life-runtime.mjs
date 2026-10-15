import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-runtime.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
const sandbox = { module: moduleBox, exports: moduleBox.exports, Date, Math, console };
vm.runInNewContext(compiled, sandbox, { filename: "life-runtime.cjs" });
const { advanceActorTimeline, generateWeeklyLifePlan, getCurrentActorSchedule, insertManualLifeScheduleSlot, settleActorTimelineToNow } = moduleBox.exports;
assert.equal(typeof advanceActorTimeline, "function", "timeline fast-forward should be exported");
assert.equal(typeof generateWeeklyLifePlan, "function", "weekly planner should be exported");
assert.equal(typeof getCurrentActorSchedule, "function", "current schedule selector should be exported");
assert.equal(typeof insertManualLifeScheduleSlot, "function", "manual schedule insertion should be exported");
assert.equal(typeof settleActorTimelineToNow, "function", "timeline settlement should be exported");

function makeState(schedules = []) {
  return {
    schedules,
    settings: { defaultClockMode: "real-time", defaultSpeed: 1 },
  };
}

function localIso(dayOffset, hour, minute = 0) {
  const date = new Date(2026, 9, 12, 0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function assertWeekHasNoGapsOrOverlaps(schedules, ownerType, ownerId, weekStart) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < 7; offset++) {
    const dayStart = new Date(start);
    dayStart.setDate(start.getDate() + offset);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const daySlots = schedules
      .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
      .filter(slot => new Date(slot.startAt) < dayEnd && new Date(slot.endAt) > dayStart)
      .map(slot => ({ ...slot, start: new Date(slot.startAt).getTime(), end: new Date(slot.endAt).getTime() }))
      .sort((a, b) => a.start - b.start);
    let cursor = dayStart.getTime();
    for (const slot of daySlots) {
      assert.equal(slot.start, cursor, `gap or overlap on day ${offset}: ${slot.title}`);
      assert.ok(slot.end > slot.start, "every schedule slot must have positive duration");
      cursor = slot.end;
    }
    assert.equal(cursor, dayEnd.getTime(), `day ${offset} must be fully covered`);
  }
}

const weekStart = new Date(2026, 9, 12, 0, 0, 0, 0);
const emptyPlan = generateWeeklyLifePlan(makeState(), "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false);
assert.ok(emptyPlan.schedules.length >= 60, "a new week should receive a complete schedule skeleton");
assertWeekHasNoGapsOrOverlaps(emptyPlan.schedules, "player", "player", weekStart);

// A single manually added appointment must not block generation of the rest of the week.
const appointment = {
  id: "manual-appointment",
  ownerType: "player",
  ownerId: "player",
  startAt: localIso(1, 10),
  endAt: localIso(1, 11),
  title: "重要约定",
  kind: "appointment",
  source: "event",
  plannedLocationId: "cafe",
  plannedLocationName: "街角咖啡店",
  updatedAt: new Date().toISOString(),
};
const partial = generateWeeklyLifePlan(makeState([appointment]), "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false);
assert.ok(partial.schedules.some(slot => slot.id === appointment.id), "existing appointment must be preserved");
assertWeekHasNoGapsOrOverlaps(partial.schedules, "player", "player", weekStart);

// Re-opening or re-running generation must not reroll a week already generated.
const rerun = generateWeeklyLifePlan(partial, "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false);
assert.equal(rerun, partial, "an already generated week must remain stable");
 
// A future manual slot must not make fast-forward skip the current virtual week.
const advanceNow = new Date("2026-10-15T15:00:00.000Z");
const futureOnlyState = {
  ...makeState([{
    id: "future-manual-slot",
    ownerType: "player",
    ownerId: "player",
    startAt: "2026-10-20T10:00:00.000Z",
    endAt: "2026-10-20T11:00:00.000Z",
    title: "下周的手动安排",
    kind: "free-time",
    source: "manual",
    updatedAt: advanceNow.toISOString(),
  }]),
  actorClocks: [{
    ownerType: "player",
    ownerId: "player",
    mode: "simulation",
    realAnchorAt: advanceNow.toISOString(),
    virtualAnchorAt: advanceNow.toISOString(),
    speed: 1,
    updatedAt: advanceNow.toISOString(),
  }],
  actorStates: [],
  events: [],
  memories: [],
  invitations: [],
  scenes: [],
  timeline: [],
  locations: [{ id: "home", name: "家", visibility: "private" }],
  settings: { defaultClockMode: "simulation", defaultSpeed: 1, playerDisplayName: "我", saveConfirmedEventsToMemory: true },
};
const advancedFutureOnly = advanceActorTimeline(futureOnlyState, "player", "player", 15, "我", "", advanceNow);
assert.ok(
  advancedFutureOnly.schedules.some(slot => slot.source === "weekly-generation" && new Date(slot.startAt) < new Date("2026-10-19T00:00:00.000Z")),
  "fast-forward should fill the current week even when a manual slot exists in a future week",
);

 
// Inserting a manual activity should carve the generated baseline around it,
// keeping the rest of the day covered without overlapping slots.
const manualActivity = {
  id: "new-manual-activity",
  ownerType: "player",
  ownerId: "player",
  startAt: localIso(1, 10),
  endAt: localIso(1, 11),
  title: "临时安排",
  kind: "free-time",
  source: "manual",
  plannedLocationName: "街角咖啡店",
  updatedAt: new Date().toISOString(),
};
const inserted = insertManualLifeScheduleSlot(emptyPlan, manualActivity);
assert.equal(inserted.conflict, undefined, "ordinary generated slots should be safely split");
assert.ok(inserted.state.schedules.some(slot => slot.id === manualActivity.id), "manual activity should be inserted");
assertWeekHasNoGapsOrOverlaps(inserted.state.schedules, "player", "player", weekStart);
 
// Moving a manual plan must restore its old interval as free time before the
// new interval is inserted; deleting a manual plan follows the same invariant.
const restoredOldInterval = {
  ...manualActivity,
  id: "restored-old-interval",
  title: "自由活动",
  kind: "free-time",
  source: "weekly-generation",
};
const planWithoutOriginal = {
  ...inserted.state,
  schedules: [
    ...inserted.state.schedules.filter(slot => slot.id !== manualActivity.id),
    restoredOldInterval,
  ],
};
const movedManualActivity = insertManualLifeScheduleSlot(planWithoutOriginal, {
  ...manualActivity,
  startAt: localIso(1, 12),
  endAt: localIso(1, 13),
});
assert.equal(movedManualActivity.conflict, undefined);
assertWeekHasNoGapsOrOverlaps(movedManualActivity.state.schedules, "player", "player", weekStart);
const deletedPlanRestored = {
  ...inserted.state,
  schedules: [
    ...inserted.state.schedules.filter(slot => slot.id !== manualActivity.id),
    restoredOldInterval,
  ],
};
assertWeekHasNoGapsOrOverlaps(deletedPlanRestored.schedules, "player", "player", weekStart);


// Confirmed appointments and other user-authored slots are protected from silent overwrite.
const protectedAppointment = {
  ...manualActivity,
  id: "confirmed-appointment",
  title: "已确认约会",
  kind: "appointment",
  source: "event",
};
const withAppointment = { ...emptyPlan, schedules: [...emptyPlan.schedules, protectedAppointment] };
const blocked = insertManualLifeScheduleSlot(withAppointment, manualActivity);
assert.equal(blocked.conflict?.id, protectedAppointment.id, "manual insertion must report confirmed appointment conflicts");
assert.equal(blocked.state, withAppointment, "a conflicting insert must leave the schedule unchanged");


const overlapState = makeState([
  { id: "earlier", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z", title: "旧安排" },
  { id: "later", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "新安排" },
]);
assert.equal(
  getCurrentActorSchedule(overlapState, "character", "c1", new Date("2026-10-15T10:30:00.000Z"))?.id,
  "later",
  "legacy overlapping slots should resolve deterministically to the most recently started slot",
);

assert.equal(
  getCurrentActorSchedule(makeState([
    { id: "same-start-old", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z", title: "较早修改", updatedAt: "2026-10-14T00:00:00.000Z" },
    { id: "same-start-new", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "较新修改", updatedAt: "2026-10-15T09:00:00.000Z" },
  ]), "character", "c1", new Date("2026-10-15T10:30:00.000Z"))?.id,
  "same-start-new",
  "same-start legacy overlaps should use updatedAt as a deterministic tie-breaker",
);


// If a schedule was removed or ended and no replacement covers the current time,
// the actor must not retain a stale slot id or claim to still be doing the old activity.
const now = new Date("2026-10-15T15:00:00.000Z");
const staleState = {
  ...makeState([{
    id: "old-slot", ownerType: "character", ownerId: "c1",
    startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T10:00:00.000Z",
    title: "已结束的旧安排", kind: "work", source: "manual",
    plannedLocationId: "office", plannedLocationName: "办公室", updatedAt: now.toISOString(),
  }]),
  actorClocks: [{
    ownerType: "character", ownerId: "c1", mode: "real-time",
    realAnchorAt: now.toISOString(), virtualAnchorAt: now.toISOString(), speed: 1, updatedAt: now.toISOString(),
  }],
  actorStates: [{
    ownerType: "character", ownerId: "c1", activity: "已结束的旧安排",
    scheduleSlotId: "old-slot", actualLocationId: "office", actualLocationName: "办公室",
    updatedAt: now.toISOString(),
  }],
  events: [], memories: [], invitations: [], scenes: [], timeline: [],
  settings: { defaultClockMode: "real-time", defaultSpeed: 1, playerDisplayName: "我" },
  updatedAt: now.toISOString(),
};
const settled = settleActorTimelineToNow(staleState, "character", "c1", now);
const settledActor = settled.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c1");
assert.equal(settledActor?.scheduleSlotId, null, "stale schedule references must be cleared");
assert.equal(settledActor?.activity, "自由活动", "actor should leave an ended activity when no current slot exists");
const eventTime = "2026-10-15T13:00:00.000Z";
const nowTime = new Date("2026-10-15T15:00:00.000Z");
function stateWithCompletedSharedEvent(allowMemory) {
  return {
    ...makeState(),
    actorClocks: [
      { ownerType: "player", ownerId: "player", mode: "real-time", realAnchorAt: nowTime.toISOString(), virtualAnchorAt: nowTime.toISOString(), speed: 1, updatedAt: nowTime.toISOString() },
      { ownerType: "character", ownerId: "c1", mode: "real-time", realAnchorAt: nowTime.toISOString(), virtualAnchorAt: nowTime.toISOString(), speed: 1, updatedAt: nowTime.toISOString() },
    ],
    actorStates: [],
    events: [{ id: "event-1", kind: "invitation", status: "active", startsAt: eventTime, endsAt: "2026-10-15T14:00:00.000Z", participantIds: ["player", "c1"], title: "一起喝咖啡", details: "confirmed-appointment", createdAt: eventTime, updatedAt: eventTime }],
    memories: [],
    invitations: [],
    scenes: [{ id: "scene-1", locationId: "cafe", locationName: "咖啡店", startedAt: eventTime, updatedAt: "2026-10-15T14:00:00.000Z", status: "completed", eventId: "event-1", participants: [], lastSettledEventIds: [] }],
    timeline: [],
    settings: { defaultClockMode: "real-time", defaultSpeed: 1, playerDisplayName: "我", saveConfirmedEventsToMemory: allowMemory },
  };
}
assert.equal(settleActorTimelineToNow(stateWithCompletedSharedEvent(false), "character", "c1", nowTime).memories.length, 0);
assert.equal(settleActorTimelineToNow(stateWithCompletedSharedEvent(true), "character", "c1", nowTime).memories.length, 1);
const apNow = new Date("2026-10-15T13:30:00.000Z");
const apStart = "2026-10-15T13:00:00.000Z";
const apEnd = "2026-10-15T14:00:00.000Z";
const apSlots = ["player", "c1"].map(ownerId => ({
  id: "ap-" + ownerId,
  ownerType: ownerId === "player" ? "player" : "character",
  ownerId,
  startAt: apStart,
  endAt: apEnd,
  title: "一起喝咖啡",
  kind: "appointment",
  source: "event",
  plannedLocationId: "cafe",
  plannedLocationName: "街角咖啡店",
  updatedAt: apNow.toISOString(),
}));
const apState = {
  ...makeState(apSlots),
  actorClocks: ["player", "c1"].map(ownerId => ({ ownerType: ownerId === "player" ? "player" : "character", ownerId, mode: "real-time", realAnchorAt: apNow.toISOString(), virtualAnchorAt: apNow.toISOString(), speed: 1, updatedAt: apNow.toISOString() })),
  actorStates: [{ ownerType: "player", ownerId: "player", activity: "在家", actualLocationId: "home", actualLocationName: "家", updatedAt: apNow.toISOString() }, { ownerType: "character", ownerId: "c1", activity: "在家", actualLocationId: "home", actualLocationName: "家", updatedAt: apNow.toISOString() }],
  events: [{ id: "ap-event", kind: "invitation", status: "confirmed", startsAt: apStart, endsAt: apEnd, locationId: "cafe", locationName: "街角咖啡店", participantIds: ["player", "c1"], title: "一起喝咖啡", details: "confirmed-appointment", createdAt: apStart, updatedAt: apStart }],
  invitations: [], scenes: [], memories: [], timeline: [],
  locations: [{ id: "home", name: "家", visibility: "private" }, { id: "cafe", name: "街角咖啡店", visibility: "public" }],
  settings: { defaultClockMode: "real-time", defaultSpeed: 1, playerDisplayName: "我", saveConfirmedEventsToMemory: true },
};
const apStarted = settleActorTimelineToNow(apState, "player", "player", apNow);
assert.equal(apStarted.events[0].status, "active");
assert.ok(apStarted.scenes.some(scene => scene.eventId === "ap-event" && scene.status === "active"));
assert.equal(apStarted.actorStates.find(actor => actor.ownerType === "player").actualLocationId, "cafe");
const apCharacterSettled = settleActorTimelineToNow(apStarted, "character", "c1", apNow);
assert.equal(apCharacterSettled.actorStates.find(actor => actor.ownerType === "character").actualLocationId, "cafe");

const caughtUpAfterAppointment = settleActorTimelineToNow(
  apState,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(
  caughtUpAfterAppointment.events.find(event => event.id === "ap-event")?.status,
  "completed",
  "a confirmed appointment crossed entirely during catch-up should be completed, not marked missed",
);
assert.ok(
  caughtUpAfterAppointment.scenes.some(scene => scene.eventId === "ap-event" && scene.status === "completed"),
  "catch-up should retain a completed shared scene for the elapsed appointment",
);
assert.equal(
  caughtUpAfterAppointment.memories.length,
  1,
  "an elapsed confirmed shared appointment should be eligible for life-memory persistence",
);

const existingSharedSceneState = {
  ...apState,
  scenes: [{
    id: "scene-opened-manually",
    locationId: "cafe",
    locationName: "街角咖啡店",
    startedAt: apStart,
    updatedAt: apStart,
    status: "active",
    participants: [
      { ownerType: "player", ownerId: "player", activity: "喝咖啡", awarenessByActorId: {} },
      { ownerType: "character", ownerId: "c1", activity: "喝咖啡", awarenessByActorId: {} },
    ],
    lastSettledEventIds: [],
  }],
};
const attachedExistingScene = settleActorTimelineToNow(
  existingSharedSceneState,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(attachedExistingScene.scenes.length, 1, "catch-up should reuse an existing matching shared scene");
assert.equal(attachedExistingScene.scenes[0].eventId, "ap-event", "the elapsed appointment should attach to the existing shared scene");
assert.equal(attachedExistingScene.events.find(event => event.id === "ap-event")?.status, "completed");





console.log("Life schedule regression tests passed.");
