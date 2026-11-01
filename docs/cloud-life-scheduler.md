# Cloud-resident life scheduler

The life system's background schedule is owned by the user's personal Supabase project, not by a WebView timer.

## Data model

- `push_bridge_snapshots` keeps the encrypted `life-schedule` snapshot: the rolling seven-day itinerary, scene membership, actor overrides, autonomy switches and foreground/chat leases. Server writes use an `updated_at` compare-and-swap filter so a concurrent client schedule edit cannot be overwritten by an older evaluator read.
- `life_schedule_runtime` stores the latest server-derived activity/location for each `user_id + scene_id + character_id`, together with `schedule_version`, `state_version`, the next schedule transition and the next proactive run.
- `life_schedule_diagnostics` stores the latest unresolved fault per diagnostic key. The table is service-role-only.

Weekly-generated routine slots (`source = weekly-generation`) are projected forward by seven days after the stored seven-day window. One-off/manual/special/appointment slots are not repeated. When the client publishes a new weekly plan, its schedule fingerprint changes and the cloud runtime advances to that version.

## Execution

1. The client synchronizes the encrypted schedule snapshot and creates one initial life-scene prompt row when an active scene has co-located participants and autonomy is enabled.
2. The `ai-phone-life-schedule-evaluate` Cron runs once per minute. `life-scheduler` derives the current player/character activity and locations, checks sleep/chat/scene/autonomy gates, updates runtime state, and re-arms the existing unsuffixed `push_jobs` row in place.
3. The normal personal-cloud job scanner dispatches that row to `push-generate`. Life-scene payloads bypass `idleRepeat`; no `+`-suffixed child chain is created. The schema migration and scheduler retire legacy finite-repeat children.
4. Immediately before generation, `push-generate` reads the latest encrypted snapshot and a version-matched `life_schedule_runtime` row. It defers if the snapshot is older than three minutes, rejects disabled autonomy or a stale scene/location, and injects the current activity/location into the prompt.
5. Active direct chat and the visible foreground life scene take priority. Background life actions defer rather than block chat.

A scene/participant removal or autonomy-off update cancels the row. The same row is reused if that scene/character becomes active again; each scene/character has at most one durable task row, rather than an unbounded chain of child jobs.

## Diagnostics and notifications

Cloud failures are written to `life_schedule_diagnostics` and surfaced in the Life System diagnostics panel through `/api/life/schedule-diagnostics`. New unresolved faults send a notification to Android shell Realtime subscribers and Web Push subscribers. The diagnostics include repair hints for missing subscriptions, stale schedule snapshots, generation/message-write failures, stalled dispatch/execution, daily generation caps and notification delivery failures.

## Deployment

The personal-cloud schema is version 4. The Netlify build script generates:

- `public/ai-phone-push/life-scheduler.mjs`
- `public/ai-phone-push/push-generate.mjs`
- `public/ai-phone-push/schema.sql`

The personal-cloud one-click deployment installs the `life-scheduler` Edge Function and its Cron job together with the existing push functions and schema. After the site update is deployed, an existing personal Supabase project must be upgraded once through the app's personal-cloud deployment flow; a Netlify site deploy cannot silently change a user's separate Supabase project.
