import type { LifeScheduleSlot, LifeOwnerType, VirtualLifeState } from "./life-types";

function weekEndFromStart(weekStart: string): string | null {
  const start = new Date(weekStart);
  if (!Number.isFinite(start.getTime())) return null;
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Persist a generated week once. If any slots for that owner/week already exist,
 * this is a no-op: opening the app must not reroll their life or overwrite edits.
 */
export function installGeneratedLifeWeekOnce(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  weekStart: string,
  generatedSlots: LifeScheduleSlot[],
): { state: VirtualLifeState; installed: boolean; reason: "installed" | "already-exists" | "invalid-week" | "empty" } {
  const weekEnd = weekEndFromStart(weekStart);
  if (!weekEnd) return { state, installed: false, reason: "invalid-week" };
  const existing = state.schedules.some(slot =>
    slot.ownerType === ownerType
    && slot.ownerId === ownerId
    && slot.startAt >= weekStart
    && slot.startAt < weekEnd,
  );
  if (existing) return { state, installed: false, reason: "already-exists" };

  const candidates = generatedSlots.filter(slot =>
    slot.ownerType === ownerType
    && slot.ownerId === ownerId
    && slot.startAt >= weekStart
    && slot.startAt < weekEnd
    && Number.isFinite(new Date(slot.startAt).getTime())
    && Number.isFinite(new Date(slot.endAt).getTime())
    && new Date(slot.endAt).getTime() > new Date(slot.startAt).getTime(),
  );
  if (candidates.length === 0) return { state, installed: false, reason: "empty" };

  const unique = candidates.filter((slot, index) => candidates.findIndex(other => other.id === slot.id) === index);
  return {
    state: {
      ...state,
      schedules: [...state.schedules, ...unique].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    },
    installed: true,
    reason: "installed",
  };
}

/**
 * Replace only explicitly identified affected future slots for one person.
 * Unrelated future plans and all historical slots remain untouched.
 */
export function replaceAffectedFutureLifeSlots(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  from: string,
  affectedSlotIds: string[],
  replacements: LifeScheduleSlot[],
): VirtualLifeState {
  const cutoff = new Date(from).getTime();
  if (!Number.isFinite(cutoff) || affectedSlotIds.length === 0) return state;
  const affected = new Set(affectedSlotIds);
  const schedules = state.schedules.filter(slot => {
    if (slot.ownerType !== ownerType || slot.ownerId !== ownerId || !affected.has(slot.id)) return true;
    return new Date(slot.startAt).getTime() < cutoff;
  });
  const valid = replacements.filter(slot =>
    slot.ownerType === ownerType
    && slot.ownerId === ownerId
    && new Date(slot.startAt).getTime() >= cutoff
    && new Date(slot.endAt).getTime() > new Date(slot.startAt).getTime(),
  );
  const byId = new Map<string, LifeScheduleSlot>();
  for (const slot of [...schedules, ...valid]) byId.set(slot.id, slot);
  return { ...state, schedules: [...byId.values()].sort((a, b) => a.startAt.localeCompare(b.startAt)) };
}
