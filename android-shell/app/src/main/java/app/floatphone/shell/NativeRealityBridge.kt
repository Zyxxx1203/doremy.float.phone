package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * 本机优先的现实桥执行器：先把系统事件写入应用私有存储，再匹配本机规则。
 * 不依赖 WebView、Cookie 或云端登录态。云端同步是可选的另一条链路。
 * Android 强制停止应用后会阻止广播/任务重启应用，不能绕过系统限制。
 */
object NativeRealityBridge {
    private const val PREFS = "native_reality_bridge"
    private const val KEY_EVENTS = "local_events"
    private const val KEY_LOG = "execution_log"
    private const val KEY_RULES = "rules_json"
    private const val KEY_ENABLED = "enabled"
    private const val CHANNEL = "reality_bridge_local"
    private const val MAX_ITEMS = 100

    fun configure(context: Context, json: String): Boolean = try {
        val config = JSONObject(json)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, config.optBoolean("enabled", false))
            .putString(KEY_RULES, config.optJSONArray("rules")?.toString() ?: "[]")
            .apply()
        true
    } catch (_: Throwable) { false }

    fun capture(context: Context, type: String, payload: String) {
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
            return
        }
        val rules = readArray(prefs.getString(KEY_RULES, "[]"))
        var matched = false
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
            val template = rule.optJSONObject("process")?.optString("template", "").orEmpty()
            val message = template.replace("{payload}", payload).replace("{type}", type)
                .ifBlank { "现实桥感知到：$payload" }.take(500)
            val notified = postNotification(context, rule.optString("name", "现实桥"), message, now)
            prefs.edit().putLong("last_run_$ruleId", now).apply()
            record(context, event, rule.optString("name", ruleId),
                if (notified) "已匹配并提交本机通知" else "规则已匹配，但通知未显示（请检查通知权限/系统渠道）")
        }
        if (!matched) record(context, event, null, "未执行：没有启用且匹配的本机规则")
    }

    fun recentLog(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LOG, "[]") ?: "[]"

    private fun postNotification(context: Context, title: String, body: String, id: Long): Boolean = try {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL, "现实桥 · 本机触发", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val openApp = PendingIntent.getActivity(context, 7101,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title.take(80)).setContentText(body.take(180))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(500)))
            .setContentIntent(openApp).setAutoCancel(true).build()
        manager.notify((id % Int.MAX_VALUE).toInt(), notification)
        true
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
                NativeRealityBridge.capture(context, "电量低", "手机电量偏低")
        }
    }
}
