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
const { generateWeeklyLifePlan } = moduleBox.exports;
assert.equal(typeof generateWeeklyLifePlan, "function", "weekly planner should be exported");

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
console.log("Life schedule regression tests passed.");
