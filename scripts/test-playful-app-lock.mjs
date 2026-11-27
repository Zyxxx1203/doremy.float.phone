#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const service = read("android-shell/app/src/main/java/app/floatphone/shell/PlayfulAppLockService.kt");
const activity = read("android-shell/app/src/main/java/app/floatphone/shell/PlayfulLockActivity.kt");
const main = read("android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt");
const executor = read("lib/tool-executor.ts");
const host = read("lib/custom-app-host-api.ts");
const runner = read("components/app-market/custom-app-runner.tsx");
const internal = read("lib/internal-capability-storage.ts");
const builtin = read("lib/builtin-apps/focus-companion-meta.ts");
const manifest = read("custom-apps/focus-companion/manifest.json");

assert.match(service, /SecureRandom\(\)/, "app-lock password must use SecureRandom");
assert.match(service, /durationMinutes\.coerceIn\(1, 360\)/, "lock duration must be capped at six hours");
assert.match(service, /expiresAt/, "native lock must persist and enforce expiry");
assert.match(service, /passUntil/, "temporary pass must be tracked natively");
assert.match(service, /isProtectedTarget\(context, target\)/, "protected targets must be rejected in native code");
assert.match(service, /com\.android\.settings/, "Android Settings must be protected");
assert.match(service, /monitoringAvailable/, "status must report whether foreground monitoring has a source");
assert.match(service, /current_package_updated_at/, "accessibility fallback must reject stale foreground state");
assert.match(read("android-shell/app/src/main/java/app/floatphone/shell/CallControlService.kt"), /current_package_updated_at/, "accessibility service must publish a foreground heartbeat");
assert.match(service, /now - lastShowAt > 2500L/, "returning to a blocked app must be re-intercepted promptly");
assert.match(activity, /EXTRA_OPEN_URL/, "the lock screen must deep-link back to the originating chat");
assert.match(activity, /#open-chat=/, "the lock screen must route to the original chat session");
assert.match(activity, /temporaryPass\(this@PlayfulLockActivity, 1\)/, "the user must have a short temporary pass");
assert.match(activity, /紧急解除这次锁定/, "the user must always have an explicit emergency exit");
assert.match(activity, /updateCountdown\(\)/, "the lock screen must show remaining lock time");
assert.match(main, /o\.optString\("sessionId"\)/, "the native bridge must receive the originating session id");
assert.match(executor, /sessionId: context\?\.sessionId/, "the role tool must pass its chat session to native");
assert.match(executor, /durationMinutes: Math\.max\(1, Math\.min\(360/, "the role tool must clamp requested duration");
assert.doesNotMatch(host, /device\.appLock\.reveal/, "custom-app host must not expose the password reveal action");
assert.doesNotMatch(runner, /appLockReveal: function/, "custom-app SDK must not expose native password reveal");
assert.match(internal, /durationMinutes: \{ type: "number"/, "internal role tool schema must expose bounded duration");
assert.match(builtin, /durationMinutes/, "built-in companion manifest must document bounded duration");
assert.match(manifest, /durationMinutes/, "exported companion manifest must document bounded duration");

console.log("Playful app-lock interaction and safety contract tests passed.");
