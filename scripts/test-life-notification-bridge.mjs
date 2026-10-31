import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [receiver, activity, bridge] = await Promise.all([
  read("../android-shell/app/src/main/java/app/floatphone/shell/NotificationReplyReceiver.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt"),
  read("../lib/notification-reply.ts"),
]);

assert.match(receiver, /fun peekPendingReplies\(context: Context\): String/);
assert.match(receiver, /fun acknowledgePendingReplies\(context: Context, idsJson: String\): Boolean/);
assert.match(receiver, /synchronized\(queueLock\)/);
assert.match(receiver, /prefs\.edit\(\)\.putString\(KEY_QUEUE, remaining\.toString\(\)\)\.commit\(\)/);
assert.match(receiver, /fun consumePendingReplies\(context: Context\): String/);

assert.match(activity, /fun peekPendingReplies\(\): String = NotificationReplyReceiver\.peekPendingReplies/);
assert.match(activity, /fun acknowledgePendingReplies\(idsJson: String\): Boolean/);
assert.match(activity, /fun consumePendingReplies\(\): String = NotificationReplyReceiver\.consumePendingReplies/);

assert.match(bridge, /api\.peekPendingReplies\(\)/);
assert.match(bridge, /api\?\.acknowledgePendingReplies\?\.\(JSON\.stringify\(\[replyId\]\)\)/);
assert.match(bridge, /const stableMessageId = "notification-reply-" \+ item\.id/);
assert.match(bridge, /enqueuePendingLifeSceneReply/);
const persistIndex = bridge.indexOf("const result = mirrorNotificationReplyToLifeScene(item, text)");
const ackIndex = bridge.indexOf("if (!acknowledge(item.id))", persistIndex);
assert.ok(persistIndex >= 0 && ackIndex > persistIndex, "native reply must be acknowledged only after web persistence");
assert.match(bridge, /result === "failed"/);
assert.match(bridge, /notificationReplyFlushPromise/);
assert.match(bridge, /flushPendingNotificationRepliesInternal/);
assert.match(bridge, /Keep the native item/);

console.log("Life notification bridge durability checks passed.");