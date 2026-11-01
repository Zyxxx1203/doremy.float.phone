// Cloud-resident life schedule evaluator.
// One durable push_jobs row is reused per scene/character. This function never
// creates an unbounded chain of + suffixed jobs.
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };
type ScheduleSlot = {
  ownerType?: string; ownerId?: string; startAt?: string; endAt?: string;
  title?: string; kind?: string; plannedLocationId?: string; plannedLocationName?: string;
};
type ActorState = {
  ownerType?: string; ownerId?: string; activity?: string;
  actualLocationId?: string; actualLocationName?: string; actualLocationUntil?: string | null;
};
type Snapshot = {
  version?: number; updatedAt?: string; scheduleVersion?: string;
  enabled?: boolean; autonomyEnabled?: boolean; proactiveEnabled?: boolean;
  playerLocationId?: string; scenes?: Array<{ id?: string; locationId?: string; characterIds?: string[] }>;
  characterLocations?: Record<string, string>; scheduleSlots?: ScheduleSlot[]; actorStates?: ActorState[];
  onlineChatCharacterId?: string; onlineChatLeaseUntil?: string;
  proactiveIntervalMin?: number; proactiveIntervalMax?: number;
};
type JobRow = { id: string; trigger_key: string; status: string; execute_at: string; result_note?: string | null };
type RuntimeRow = {
  user_id: string; scene_id: string; character_id: string; state_version: number;
  activity: string; location_id: string; location_name: string; next_transition_at: string | null;
  next_run_at: string | null; last_status: string; last_error: string | null; updated_at: string;
};

const jsonHeaders = (serviceKey: string) => ({
  apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json",
});
const sleepPattern = /睡眠|睡觉|入睡|午休|休息中/;
const isSleep = (value: string) => sleepPattern.test(value || "");
const parseTime = (value?: string | null) => value ? Date.parse(value) : Number.NaN;
const iso = (value: number) => new Date(value).toISOString();

function fromBase64(value: string): Uint8Array {
  const raw = atob(value); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
function toBase64(value: Uint8Array): string {
  let raw = ""; for (const byte of value) raw += String.fromCharCode(byte); return btoa(raw);
}
async function decryptPayload(payload: EncryptedPayload, secret: string): Promise<string> {
  if (!payload || payload.v !== 1) throw new Error("unsupported encrypted schedule snapshot");
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = fromBase64(payload.ct), tag = fromBase64(payload.tag), combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct); combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(payload.iv) }, key, combined);
  return new TextDecoder().decode(plain);
}
async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return { v: 1, iv: toBase64(iv), tag: toBase64(combined.slice(-16)), ct: toBase64(combined.slice(0, -16)) };
}
function activeSlot(snapshot: Snapshot, ownerType: string, ownerId: string, at: number): ScheduleSlot | null {
  return (snapshot.scheduleSlots || []).find(slot => slot.ownerType === ownerType && slot.ownerId === ownerId
    && Number.isFinite(parseTime(slot.startAt)) && Number.isFinite(parseTime(slot.endAt))
    && parseTime(slot.startAt) <= at && at < parseTime(slot.endAt)) || null;
}
function actor(snapshot: Snapshot, ownerType: string, ownerId: string): ActorState | null {
  return (snapshot.actorStates || []).find(item => item.ownerType === ownerType && item.ownerId === ownerId) || null;
}
function locationAt(snapshot: Snapshot, ownerType: string, ownerId: string, at: number) {
  const current = actor(snapshot, ownerType, ownerId);
  const slot = activeSlot(snapshot, ownerType, ownerId, at);
  const until = parseTime(current?.actualLocationUntil);
  const temporary = Boolean(current?.actualLocationId && Number.isFinite(until) && until > at);
  const manual = Boolean(current?.actualLocationId && current.actualLocationUntil == null
    && current.actualLocationId !== (slot?.plannedLocationId || ""));
  const useActual = temporary || manual;
  const id = (useActual ? current?.actualLocationId : slot?.plannedLocationId) || current?.actualLocationId || "";
  const name = (useActual ? current?.actualLocationName : slot?.plannedLocationName)
    || current?.actualLocationName || "";
  return { id, name, activity: slot?.title || current?.activity || "自由活动", slot };
}
function nextTransition(snapshot: Snapshot, ownerType: string, ownerId: string, now: number): number | null {
  const boundaries = (snapshot.scheduleSlots || [])
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
    .flatMap(slot => [parseTime(slot.startAt), parseTime(slot.endAt)])
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => a - b);
  return boundaries[0] ?? null;
}
function nextOverlap(snapshot: Snapshot, characterId: string, now: number): number {
  const boundaries = (snapshot.scheduleSlots || [])
    .filter(slot => (slot.ownerType === "player" && slot.ownerId === "player")
      || (slot.ownerType === "character" && slot.ownerId === characterId))
    .flatMap(slot => [parseTime(slot.startAt), parseTime(slot.endAt)])
    .filter(value => Number.isFinite(value) && value > now)
    .sort((a, b) => a - b);
  for (const boundary of boundaries) {
    const at = boundary + 1000;
    const player = locationAt(snapshot, "player", "player", at);
    const character = locationAt(snapshot, "character", characterId, at);
    if (player.id && player.id === character.id) return at;
  }
  return now + 24 * 60 * 60_000;
}
function jitterInterval(snapshot: Snapshot): number {
  const min = Math.max(3, Math.min(120, Number(snapshot.proactiveIntervalMin) || 5));
  const max = Math.max(min, Math.min(180, Number(snapshot.proactiveIntervalMax) || 15));
  return Math.round((min + Math.random() * (max - min)) * 60_000);
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 503 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({})) as { token?: string };
  const headers = jsonHeaders(serviceKey);
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init, headers: { ...headers, ...(init?.headers || {}) },
  });
  const configResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key&limit=1");
  if (!configResponse.ok) return new Response("config lookup failed", { status: 502 });
  const configs = await configResponse.json() as Array<{ cron_secret?: string; payload_key?: string }>;
  const cronSecret = configs[0]?.cron_secret || "", payloadKey = configs[0]?.payload_key || "";
  if (!cronSecret || body.token !== cronSecret) return new Response("forbidden", { status: 403 });
  if (!payloadKey) return new Response("payload_key missing", { status: 503 });

  const snapshotsResponse = await rest("push_bridge_snapshots?rule_id=eq.life-schedule&select=user_id,payload,updated_at&limit=100");
  if (!snapshotsResponse.ok) return new Response("schedule snapshot lookup failed", { status: 502 });
  const rows = await snapshotsResponse.json() as Array<{ user_id: string; payload: EncryptedPayload; updated_at: string }>;
  const now = Date.now();
  const summary = { users: rows.length, evaluated: 0, armed: 0, cancelled: 0, errors: 0 };

  for (const row of rows) {
    try {
      const snapshot = JSON.parse(await decryptPayload(row.payload, payloadKey)) as Snapshot;
      if (!snapshot || !Array.isArray(snapshot.scheduleSlots) || !Array.isArray(snapshot.scenes)) {
        throw new Error("schedule snapshot missing scheduleSlots/scenes");
      }
      const enabled = snapshot.enabled !== false && snapshot.autonomyEnabled !== false && snapshot.proactiveEnabled !== false;
      const activePairs = new Set<string>();
      const runtimeUpdates: RuntimeRow[] = [];
      const scenes = snapshot.scenes.filter(scene => Boolean(scene.id));
      for (const scene of scenes) {
        for (const characterId of scene.characterIds || []) {
          const key = `${scene.id}:${characterId}`;
          activePairs.add(key);
          const player = locationAt(snapshot, "player", "player", now);
          const character = locationAt(snapshot, "character", characterId, now);
          const samePlace = Boolean(player.id && character.id && player.id === character.id);
          const characterSleeping = isSleep(character.activity);
          const playerSleeping = isSleep(player.activity);
          const chatUntil = snapshot.onlineChatCharacterId === characterId ? parseTime(snapshot.onlineChatLeaseUntil) : Number.NaN;
          const chatActive = Number.isFinite(chatUntil) && chatUntil > now;
          const activity = character.activity || "自由活动";
          const currentLocationId = character.id || "";
          const currentLocationName = character.name || "";
          const previousResponse = await rest(
            `life_schedule_runtime?user_id=eq.${encodeURIComponent(row.user_id)}&scene_id=eq.${encodeURIComponent(scene.id!)}&character_id=eq.${encodeURIComponent(characterId)}&select=state_version,next_run_at,activity,location_id,last_status&limit=1`,
          );
          const previousRows = previousResponse.ok ? await previousResponse.json() as Array<Partial<RuntimeRow>> : [];
          const previous = previousRows[0];
          const changed = previous?.activity !== activity || previous?.location_id !== currentLocationId;
          const stateVersion = (Number(previous?.state_version) || 0) + (changed ? 1 : 0);
          const awakeAt = Math.max(
            playerSleeping ? nextAwake(snapshot, "player", "player", now) : now,
            characterSleeping ? nextAwake(snapshot, "character", characterId, now) : now,
          );
          const nextRun = !enabled ? null
            : playerSleeping || characterSleeping ? iso(awakeAt)
            : chatActive ? iso(chatUntil + 15_000)
            : !samePlace ? iso(nextOverlap(snapshot, characterId, now))
            : previous?.next_run_at || null;
          const transition = Math.min(
            nextTransition(snapshot, "player", "player", now) ?? Number.POSITIVE_INFINITY,
            nextTransition(snapshot, "character", characterId, now) ?? Number.POSITIVE_INFINITY,
          );
          runtimeUpdates.push({
            user_id: row.user_id, scene_id: scene.id!, character_id: characterId,
            state_version: stateVersion, activity, location_id: currentLocationId, location_name: currentLocationName,
            next_transition_at: Number.isFinite(transition) ? iso(transition) : null,
            next_run_at: nextRun, last_status: !enabled ? "disabled" : !samePlace ? "not_co_located" : characterSleeping || playerSleeping ? "sleeping" : chatActive ? "chat_active" : "ready",
            last_error: null, updated_at: new Date().toISOString(),
          });
          summary.evaluated += 1;

          const triggerKey = `life-scene:${scene.id}:${characterId}:schedule`;
          const jobResponse = await rest(
            `push_jobs?user_id=eq.${encodeURIComponent(row.user_id)}&trigger_key=eq.${encodeURIComponent(triggerKey)}&select=id,status,execute_at,result_note&limit=1`,
          );
          if (!jobResponse.ok) throw new Error("push_jobs lookup failed: " + jobResponse.status);
          const jobs = await jobResponse.json() as JobRow[];
          const job = jobs[0];
          if (!job) continue; // Client creates the first prompt/request template while the scene is open.
          if (!enabled) {
            if (job.status === "pending" || job.status === "running") {
              await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
                method: "PATCH", body: JSON.stringify({ status: "cancelled", result_note: "life schedule disabled by user", updated_at: new Date().toISOString() }),
              });
              summary.cancelled += 1;
            }
            continue;
          }
          if (job.status === "cancelled" || job.status === "pending" || job.status === "running") continue;
          if (!samePlace || characterSleeping || playerSleeping || chatActive) continue;
          const nextRunAt = parseTime(previous?.next_run_at);
          if (Number.isFinite(nextRunAt) && nextRunAt > now) continue;
          const executeAt = now + jitterInterval(snapshot);
          const patch = await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=in.(done,failed)`, {
            method: "PATCH", headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              status: "pending", execute_at: iso(executeAt),
              result_note: "life schedule: durable task re-armed by cloud scheduler",
              updated_at: new Date().toISOString(),
            }),
          });
          if (!patch.ok) throw new Error("life job re-arm failed: " + patch.status);
          const patched = await patch.json().catch(() => []) as unknown[];
          if (patched.length) summary.armed += 1;
          runtimeUpdates[runtimeUpdates.length - 1].next_run_at = iso(executeAt + 60_000);
        }
      }

      // Cancel orphaned schedule tasks when a scene/participant disappears from the latest snapshot.
      const jobsResponse = await rest(
        `push_jobs?user_id=eq.${encodeURIComponent(row.user_id)}&trigger_key=like.life-scene:*:schedule&status=in.(pending,running)&select=id,trigger_key`,
      );
      if (jobsResponse.ok) {
        const jobs = await jobsResponse.json() as Array<{ id: string; trigger_key: string }>;
        for (const job of jobs) {
          const match = job.trigger_key.match(/^life-scene:(.+):([^:]+):schedule$/);
          if (!match || !activePairs.has(`${match[1]}:${match[2]}`) || !enabled) {
            await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
              method: "PATCH", body: JSON.stringify({ status: "cancelled", result_note: "life schedule: scene/participant removed or autonomy disabled", updated_at: new Date().toISOString() }),
            });
            summary.cancelled += 1;
          }
        }
      }
      for (const runtime of runtimeUpdates) {
        const response = await rest("life_schedule_runtime?on_conflict=user_id,scene_id,character_id", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([runtime]),
        });
        if (!response.ok) throw new Error("life runtime upsert failed: " + response.status);
      }

      // Refresh the encrypted snapshot's computed location/activity. The generator reads
      // this immediately before every LLM call, so a stale scene-location snapshot cannot
      // make a character keep acting in yesterday's room.
      const playerNow = locationAt(snapshot, "player", "player", now);
      snapshot.playerLocationId = playerNow.id;
      snapshot.characterLocations = { ...(snapshot.characterLocations || {}) };
      const allCharacterIds = new Set([
        ...Object.keys(snapshot.characterLocations || {}),
        ...(snapshot.scheduleSlots || []).filter(slot => slot.ownerType === "character" && slot.ownerId).map(slot => slot.ownerId!),
        ...(snapshot.scenes || []).flatMap(scene => scene.characterIds || []),
      ]);
      for (const characterId of allCharacterIds) {
        snapshot.characterLocations[characterId] = locationAt(snapshot, "character", characterId, now).id;
      }
      snapshot.actorStates = (snapshot.actorStates || []).map(item => {
        const current = item.ownerType === "player"
          ? playerNow
          : item.ownerType === "character" && item.ownerId
            ? locationAt(snapshot, "character", item.ownerId, now)
            : null;
        // Keep manual override metadata intact; only refresh the derived activity.
        return current ? { ...item, activity: current.activity } : item;
      });
      snapshot.scenes = (snapshot.scenes || []).map(scene => {
        const participantLocations = (scene.characterIds || []).map(id => locationAt(snapshot, "character", id, now).id);
        return scene.characterIds?.length && participantLocations.every(id => id && id === playerNow.id)
          ? { ...scene, locationId: playerNow.id }
          : scene;
      });
      const updatedPayload = await encryptPayload(JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }), payloadKey);
      await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(row.user_id)}&rule_id=eq.life-schedule`,
        { method: "PATCH", body: JSON.stringify({ payload: updatedPayload, updated_at: new Date().toISOString() }) },
      );
    } catch (error) {
      summary.errors += 1;
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const diagnosticId = `life-scheduler:${row.user_id}`;
      await rest("life_schedule_diagnostics?on_conflict=id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{
          id: diagnosticId, user_id: row.user_id, severity: "error", code: "cloud_schedule_evaluation_failed",
          detail, repair_hint: "检查个人云部署、life-schedule 快照和 life_schedule_runtime 表；重新打开生活系统同步日程后再运行云服务自检。",
          updated_at: new Date().toISOString(), resolved_at: null,
        }]),
      }).catch(() => undefined);
    }
  }
  return Response.json({ ok: true, ...summary });
});

function nextAwake(snapshot: Snapshot, ownerType: string, ownerId: string, now: number): number {
  const future = (snapshot.scheduleSlots || [])
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId
      && parseTime(slot.startAt) > now && !isSleep(slot.title || ""))
    .sort((a, b) => parseTime(a.startAt) - parseTime(b.startAt));
  return future.length ? parseTime(future[0].startAt) : now + 30 * 60_000;
}
