package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * 原生现实桥捕获器：系统事件、离线回复和聊天室消息均在本机处理，不依赖云端等待。
 * Android 强制停止应用后会阻止广播/任务重启应用，不能绕过系统限制。
 */
object NativeRealityBridge {
    private const val PREFS = "native_reality_bridge"
    private const val KEY_EVENTS = "local_events"
    private const val KEY_LOG = "execution_log"
    private const val KEY_RULES = "rules_json"
    private const val KEY_CHAT_QUEUE = "pending_chat_messages"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_DEVICE_ACTIONS_ENABLED = "device_actions_enabled"
    private const val KEY_ALLOWED_DEVICE_ACTIONS = "allowed_device_actions"
    private const val CHANNEL = "reality_bridge_local_chat"
    private const val MAX_ITEMS = 100

    fun configure(context: Context, json: String): Boolean = try {
        val config = JSONObject(json)
        val app = context.applicationContext
        val enabled = config.optBoolean("enabled", false)
        val watchAmbientLight = enabled && config.optBoolean("watchAmbientLight", false)
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putBoolean(KEY_DEVICE_ACTIONS_ENABLED, config.optBoolean("deviceActionsEnabled", false))
            .putString(KEY_ALLOWED_DEVICE_ACTIONS, config.optJSONArray("allowedDeviceActions")?.toString() ?: "[]")
            .putString(KEY_RULES, config.optJSONArray("rules")?.toString() ?: "[]")
            .apply()
        val monitorIntent = Intent(app, AmbientLightMonitorService::class.java)
        runCatching {
            if (watchAmbientLight) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(monitorIntent)
                else app.startService(monitorIntent)
            } else app.stopService(monitorIntent)
        }
        true
    } catch (_: Throwable) { false }

    fun capture(context: Context, type: String, payload: String): Boolean {
        val now = System.currentTimeMillis()
        val event = JSONObject().put("id", "local_$now").put("type", type)
            .put("payload", payload.take(1200)).put("createdAt", now)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(this) {
            val queue = readArray(prefs.getString(KEY_EVENTS, "[]"))
            queue.put(event)
            trim(queue, MAX_ITEMS)
            prefs.edit().putString(KEY_EVENTS, queue.toString()).commit()
        }
        if (!prefs.getBoolean(KEY_ENABLED, false)) {
            record(context, event, null, "未执行：现实桥总开关关闭")
            return false
        }
        val rules = readArray(prefs.getString(KEY_RULES, "[]"))
        var matched = false
        var notifiedAny = false
        for (i in 0 until rules.length()) {
            val rule = rules.optJSONObject(i) ?: continue
            if (!rule.optBoolean("enabled", false)) continue
            val matchType = rule.optString("matchType", "").trim()
            if (matchType != "*" && !matchType.equals(type, ignoreCase = true)) continue
            val filter = rule.optString("payloadFilter", "").trim()
            if (filter.isNotEmpty() && filter.split('|', ',').none {
                it.trim().isNotEmpty() && payload.contains(it.trim(), ignoreCase = true)
            }) continue
            val ruleId = rule.optString("id", rule.optString("name", "rule_$i"))
            val cooldown = rule.optLong("cooldownMinutes", 0L).coerceIn(0L, 10080L)
            val lastRun = prefs.getLong("last_run_$ruleId", 0L)
            if (cooldown > 0 && now - lastRun < cooldown * 60_000L) {
                record(context, event, rule.optString("name", ruleId), "未执行：仍在冷却期")
                continue
            }
            matched = true
            // 优先从预先写好的角色回复库抽取，确保断网时不临时请求模型。
            // 回复允许使用 {payload}/{type} 占位；未配置回复库时再尝试模板/通用兜底。
            val replies = rule.optJSONArray("offlineReplies") ?: JSONArray()
            val candidates = (0 until replies.length())
                .mapNotNull { replies.optString(it).trim().takeIf(String::isNotBlank) }
            val template = rule.optJSONObject("process")?.optString("template", "").orEmpty()
            val configuredAction = rule.optJSONObject("deviceAction")
            val selected = if (candidates.isNotEmpty()) candidates[(System.currentTimeMillis() % candidates.size).toInt()]
                else template
            val replyMessage = selected.replace("{payload}", payload).replace("{type}", type).take(360)
            val actionResult = configuredAction?.let { executeBackgroundDeviceAction(context, prefs, it) }.orEmpty()
            val visibleParts = listOf(actionResult, replyMessage).filter { it.isNotBlank() }
            val message = visibleParts.joinToString("\n").take(500)
            val title = rule.optString("characterName").ifBlank { rule.optString("name", "现实桥") }
            val shouldNotify = rule.optBoolean("notificationEnabled", true) && message.isNotBlank()
            val characterId = rule.optString("characterId").trim()
            val queuedChat = characterId.isNotBlank() && replyMessage.isNotBlank() && enqueueChatMessage(context,
                JSONObject().put("id", "native_bridge_" + event.optString("id") + "_" + ruleId)
                    .put("eventId", event.optString("id")).put("ruleId", ruleId)
                    .put("characterId", characterId).put("characterName", title)
                    .put("body", replyMessage).put("createdAt", now))
            val notified = shouldNotify && postNotification(context, title, message, now)
            if (notified) notifiedAny = true
            prefs.edit().putLong("last_run_$ruleId", now).apply()
            val result = when {
                !shouldNotify -> "已匹配；未配置可显示的离线回复，跳过原始事件通知"
                notified -> "已匹配；本机离线回复：$message；系统已接受通知提交"
                else -> "已匹配；本机回复：$message；通知未显示（请检查通知权限/系统渠道）"
            }
            record(context, event, rule.optString("name", ruleId), result)
        }
        if (!matched) record(context, event, null, "未执行：没有启用且匹配的本机规则")
        return notifiedAny
    }

    /** 本机事件离线回复：持久化聊天室消息并显示系统提醒，不重复执行设备动作。 */
    fun postOfflineNotificationFallback(context: Context, eventId: String, type: String, payload: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_ENABLED, false)) return false
        val rules = readArray(prefs.getString(KEY_RULES, "[]"))
        var matchedRule = false
        for (i in 0 until rules.length()) {
            val rule = rules.optJSONObject(i) ?: continue
            if (!rule.optBoolean("enabled", false)) continue
            val matchType = rule.optString("matchType", "").trim()
            if (matchType != "*" && !matchType.equals(type, ignoreCase = true)) continue
            val filter = rule.optString("payloadFilter", "").trim()
            if (filter.isNotEmpty() && filter.split("|", ",").none { it.trim().isNotEmpty() && payload.contains(it.trim(), ignoreCase = true) }) continue
            matchedRule = true
            val ruleId = rule.optString("id", rule.optString("name", "rule_$i"))
            val now = System.currentTimeMillis()
            val cooldown = rule.optLong("cooldownMinutes", 0L).coerceIn(0L, 10080L)
            val lastRun = prefs.getLong("last_run_$ruleId", 0L)
            if (cooldown > 0 && now - lastRun < cooldown * 60_000L) {
                record(context, JSONObject().put("id", eventId).put("type", type).put("payload", payload),
                    rule.optString("name", ruleId), "本机规则仍在冷却期；本次仅去重归档")
                return true
            }
            val replies = rule.optJSONArray("offlineReplies") ?: JSONArray()
            val candidates = (0 until replies.length()).mapNotNull { replies.optString(it).trim().takeIf(String::isNotBlank) }
            val template = rule.optJSONObject("process")?.optString("template", "").orEmpty()
            val body = (candidates.firstOrNull() ?: template).replace("{payload}", payload).replace("{type}", type).take(360)
            if (body.isBlank() || !rule.optBoolean("notificationEnabled", true)) continue
            val title = rule.optString("characterName").ifBlank { rule.optString("name", "现实桥") }
            val characterId = rule.optString("characterId").trim()
            val queued = characterId.isNotBlank() && enqueueChatMessage(context,
                JSONObject().put("id", "native_bridge_" + eventId + "_" + rule.optString("id"))
                    .put("eventId", eventId).put("ruleId", rule.optString("id"))
                    .put("characterId", characterId).put("characterName", title)
                    .put("body", body).put("createdAt", System.currentTimeMillis()))
            val shown = postNotification(context, title, body, eventId.hashCode().toLong())
            if (shown || queued) {
                prefs.edit().putLong("last_run_$ruleId", now).apply()
                record(context, JSONObject().put("id", eventId).put("type", type).put("payload", payload),
                    rule.optString("name"), "本机离线回复；已写入聊天室待处理队列")
            }
            return shown || queued
        }
        return matchedRule
    }
    private fun enqueueChatMessage(context: Context, message: JSONObject): Boolean {
        val id = message.optString("id")
        if (id.isBlank()) return false
        synchronized(this) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = readArray(prefs.getString(KEY_CHAT_QUEUE, "[]"))
            for (i in 0 until queue.length()) {
                if (queue.optJSONObject(i)?.optString("id") == id) return true
            }
            queue.put(message)
            trim(queue, MAX_ITEMS)
            return prefs.edit().putString(KEY_CHAT_QUEUE, queue.toString()).commit()
        }
    }

    fun pendingChatMessages(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CHAT_QUEUE, "[]") ?: "[]"

    fun acknowledgeChatMessages(context: Context, idsJson: String): Boolean = try {
        val ids = readArray(idsJson).let { array ->
            (0 until array.length()).map { array.optString(it) }.toSet()
        }
        synchronized(this) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val old = readArray(prefs.getString(KEY_CHAT_QUEUE, "[]"))
            val next = JSONArray()
            for (i in 0 until old.length()) {
                val item = old.optJSONObject(i) ?: continue
                if (item.optString("id") !in ids) next.put(item)
            }
            prefs.edit().putString(KEY_CHAT_QUEUE, next.toString()).commit()
        }
    } catch (_: Throwable) { false }

    /** Background rules use an explicit user-controlled allow-list and only native-supported actions. */
    private fun executeBackgroundDeviceAction(context: Context, prefs: android.content.SharedPreferences, action: JSONObject): String {
        if (!prefs.getBoolean(KEY_DEVICE_ACTIONS_ENABLED, false)) return "未执行设备动作：设置中的「操作设备」总开关未开启"
        val name = action.optString("action", "").trim()
        val allowed = readArray(prefs.getString(KEY_ALLOWED_DEVICE_ACTIONS, "[]"))
        if ((0 until allowed.length()).none { allowed.optString(it) == name }) return "未执行设备动作：该动作未在设置中明确授权"
        if (name != "torch") return "未执行设备动作：该动作暂不支持原生后台自动执行，请保持小手机运行中"
        val args = action.optJSONObject("args") ?: JSONObject()
        val rawOn = args.opt("on")
        val on = rawOn == true || rawOn?.toString().equals("true", ignoreCase = true) || rawOn?.toString() == "1"
        val result = DeviceActionBridge(context.applicationContext).setTorch(on)
        return if (result.optBoolean("ok", false)) {
            if (on) "设备动作已执行：已自动打开手电筒" else "设备动作已执行：已自动关闭手电筒"
        } else "设备动作失败：" + result.optString("reason", "设备未能执行该动作")
    }

    fun recentLog(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LOG, "[]") ?: "[]"

    private fun postNotification(context: Context, title: String, body: String, id: Long): Boolean = try {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL, "现实桥 · 角色消息", NotificationManager.IMPORTANCE_HIGH))
        }
        val channelDisabled = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && manager.getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE
        if (channelDisabled || !NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            false
        } else {
            val openApp = PendingIntent.getActivity(context, 7101,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title.take(80)).setContentText(body.take(180))
                .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(500)))
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openApp).setAutoCancel(true).build()
            manager.notify((id % Int.MAX_VALUE).toInt(), notification)
            true
        }
    } catch (_: Throwable) { false }

    private fun record(context: Context, event: JSONObject, rule: String?, result: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(this) {
            val log = readArray(prefs.getString(KEY_LOG, "[]"))
            log.put(JSONObject().put("eventId", event.optString("id"))
                .put("type", event.optString("type")).put("payload", event.optString("payload"))
                .put("rule", rule ?: "").put("result", result).put("at", System.currentTimeMillis()))
            trim(log, MAX_ITEMS)
            prefs.edit().putString(KEY_LOG, log.toString()).apply()
        }
    }

    private fun readArray(raw: String?): JSONArray = try { JSONArray(raw ?: "[]") }
        catch (_: Throwable) { JSONArray() }

    private fun trim(array: JSONArray, max: Int) {
        while (array.length() > max) array.remove(0)
    }
}

/** 捕获无需用户内容权限的系统电源事件。 */
class NativeRealityBridgeReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_POWER_CONNECTED ->
                NativeRealityBridge.capture(context, "充电开始", "手机开始充电")
            Intent.ACTION_POWER_DISCONNECTED ->
                NativeRealityBridge.capture(context, "充电结束", "手机停止充电")
            Intent.ACTION_BATTERY_LOW ->
                NativeRealityBridge.capture(context, "电量偏低", "手机电量偏低")
        }
    }
}
