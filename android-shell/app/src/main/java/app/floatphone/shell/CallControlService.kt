package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * 通话控制无障碍服务。
 *
 * 除原有浮窗/前台应用事件外，负责 Android 原生连续应用停留计时：
 * - 阈值与开关由网页感知面板同步到 SharedPreferences；
 * - 计时不依赖 WebView 的 setInterval；
 * - 达到阈值后把事件放入持久队列，经站点登录态 API 写入个人云现实桥收件箱；
 * - 云端继续复用既有 push-bridge 规则匹配、冷却、角色回复和推送链路。
 *
 * 本服务只读取前台包名，不读取其他应用界面内容。用户关闭「前台应用」感知或总开关后，
 * 原生计时立即停止。Android/厂商仍可能在强制停止、关闭无障碍权限或杀进程时中断服务。
 */
class CallControlService : AccessibilityService() {

    companion object {
        @Volatile
        var connected: Boolean = false
            private set
        private const val PREFS = "native_background_perception"
        private const val QUEUE_KEY = "pending_events"
        private const val CURRENT_PACKAGE_KEY = "current_package"
        private const val DWELL_START_KEY = "dwell_start_at"
        private const val REPORTED_PACKAGE_KEY = "reported_package"
        private const val CHECK_INTERVAL_MS = 15_000L
        private val pendingLock = Any()

        /** Queue and immediately attempt to persist a native-only system-event reply. */
        fun enqueueNativeFallbackChatSync(context: Context, fallback: JSONObject) {
            if (!fallback.has("chat")) return
            val id = fallback.optString("eventId").trim()
            if (id.isBlank()) return
            val event = JSONObject()
                .put("id", id)
                .put("type", fallback.optString("type"))
                .put("payload", fallback.optString("payload"))
                .put("createdAt", fallback.opt("createdAt") ?: System.currentTimeMillis())
                .put("queuedAt", System.currentTimeMillis())
                .put("cloudAccepted", true)
                .put("cloudAcceptedAt", System.currentTimeMillis())
                .put("fallbackSent", true)
                .put("localOnly", true)
                .put("fallbackChat", fallback)
            synchronized(pendingLock) {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
                if ((0 until queue.length()).any { queue.optJSONObject(it)?.optString("id") == id }) return
                queue.put(event)
                val bounded = JSONArray()
                for (index in (queue.length() - 20).coerceAtLeast(0) until queue.length()) bounded.put(queue.getJSONObject(index))
                prefs.edit().putString(QUEUE_KEY, bounded.toString()).apply()
            }
            Thread({
                if (postNativeFallbackToSite(context, id, fallback)) removeQueuedNativeFallback(context, id)
            }, "native-bridge-chat-sync").start()
        }

        /** Retry durable native fallback records when the app returns to the foreground. */
        fun retryPendingNativeFallbackChatSync(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            val pending = (0 until queue.length()).mapNotNull { queue.optJSONObject(it) }
                .filter { it.has("fallbackChat") && !it.optBoolean("fallbackSynced", false) }
                .map { JSONObject(it.toString()) }
            if (pending.isEmpty()) return
            Thread({
                for (event in pending) {
                    val fallback = event.optJSONObject("fallbackChat") ?: continue
                    val id = event.optString("id")
                    if (postNativeFallbackToSite(context, id, fallback)) removeQueuedNativeFallback(context, id)
                }
            }, "native-bridge-chat-retry").start()
        }

        private fun postNativeFallbackToSite(context: Context, id: String, fallback: JSONObject): Boolean = runCatching {
            val cookie = CookieManager.getInstance().getCookie(MainActivity.SITE_URL).orEmpty()
            val body = JSONObject().put("eventId", id).put("fallback", fallback)
                .toString().toRequestBody("application/json; charset=utf-8".toMediaType())
            val builder = Request.Builder()
                .url("${MainActivity.SITE_URL.trimEnd('/')}/api/push/bridge-native-event/fallback")
                .header("Accept", "application/json")
                .post(body)
            if (cookie.isNotEmpty()) builder.header("Cookie", cookie)
            OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS).build()
                .newCall(builder.build()).execute().use { it.isSuccessful }
        }.getOrDefault(false)

        private fun removeQueuedNativeFallback(context: Context, id: String) {
            synchronized(pendingLock) {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
                val next = JSONArray()
                for (index in 0 until queue.length()) {
                    val item = queue.optJSONObject(index) ?: continue
                    if (item.optString("id") != id) next.put(item)
                }
                prefs.edit().putString(QUEUE_KEY, next.toString()).apply()
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var delivering = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(12, TimeUnit.SECONDS)
        .build()

    private val dwellTicker = object : Runnable {
        override fun run() {
            checkDwellThreshold()
            checkUsageThresholds()
            deliverPendingEvents()
            handler.postDelayed(this, CHECK_INTERVAL_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        connected = true
        ScreenshotBridge.attach(this)
        ShellBus.dispatchOverlayEvent("accessibility", JSONObject().put("connected", true))

        // 恢复上次计时基准。若进程中断期间系统也重启了服务，仍能继续判断；
        // 下次收到应用切换事件会重新建立准确基准。
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        currentPackage = prefs.getString(CURRENT_PACKAGE_KEY, "").orEmpty()
        dwellStartAt = prefs.getLong(DWELL_START_KEY, 0L)
        reportedPackage = prefs.getString(REPORTED_PACKAGE_KEY, "").orEmpty()
        handler.removeCallbacks(dwellTicker)
        handler.post(dwellTicker)
    }

    @Volatile private var currentPackage: String = ""
    @Volatile private var dwellStartAt: Long = 0L
    @Volatile private var reportedPackage: String = ""

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val ev = event ?: return
        if (ev.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = ev.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return

        updateForegroundPackage(pkg)
        // 原有网页感知与其他壳功能继续收到前台应用变化事件。
        ShellBus.dispatchOverlayEvent("foregroundApp", JSONObject().put("package", pkg))
    }

    private fun updateForegroundPackage(pkg: String) {
        if (pkg == currentPackage) return
        currentPackage = pkg
        dwellStartAt = System.currentTimeMillis()
        reportedPackage = ""
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(CURRENT_PACKAGE_KEY, currentPackage)
            .putLong(DWELL_START_KEY, dwellStartAt)
            .putString(REPORTED_PACKAGE_KEY, "")
            .apply()
    }

    private fun checkDwellThreshold() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("enabled", false) || !prefs.getBoolean("foregroundAppEnabled", false)) return
        val pkg = currentPackage
        val startedAt = dwellStartAt
        if (pkg.isBlank() || pkg == packageName || startedAt <= 0L || reportedPackage == pkg) return

        val thresholdMinutes = prefs.getInt("thresholdMinutes", 20).coerceIn(2, 180)
        val dueAt = startedAt + thresholdMinutes * 60_000L
        if (System.currentTimeMillis() < dueAt) return

        val label = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Throwable) {
            pkg
        }
        if (!hasMatchingRule(prefs, "长时间使用", label)) return
        val event = JSONObject()
            .put("id", "dwell_${Integer.toHexString(pkg.hashCode())}_${startedAt}")
            .put("type", "长时间使用")
            .put("payload", "${label} 已连续使用 ${thresholdMinutes} 分钟")
            .put("createdAt", java.time.Instant.ofEpochMilli(dueAt).toString())

        // 先标记再排队：即使网络重试，也不会为同一段停留不断造新事件。
        reportedPackage = pkg
        prefs.edit().putString(REPORTED_PACKAGE_KEY, pkg).apply()
        enqueueEvent(event)
        showReturnToStudyNotification(label, "已连续使用 ${thresholdMinutes} 分钟", prefs)
    }

    /** 每分钟检查系统当天累计使用时长，处理「抖音今天累计超过 N 分钟」规则。 */
    private fun checkUsageThresholds() {
        val now = System.currentTimeMillis()
        if (now - lastUsageCheckAt < 60_000L) return
        lastUsageCheckAt = now

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("enabled", false) || !prefs.getBoolean("usageStatsEnabled", false)) return

        val raw = try { PerceptionBridge(this).usageStatsJson(50) } catch (_: Throwable) { "[]" }
        val entries = try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
        if (entries.length() == 0) return

        val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(now))
        val savedDate = prefs.getString("usageSignalDate", "").orEmpty()
        val tiers = try {
            JSONObject(if (savedDate == today) prefs.getString("usageSignalTiers", "{}") ?: "{}" else "{}")
        } catch (_: Throwable) { JSONObject() }
        val overrides = try { JSONArray(prefs.getString("usageOverrides", "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
        val defaultThreshold = prefs.getInt("usageSignalMinutes", 60).coerceIn(0, 720)

        for (i in 0 until entries.length()) {
            val entry = entries.optJSONObject(i) ?: continue
            val pkg = entry.optString("package")
            val label = entry.optString("label").ifBlank { pkg }
            val minutes = entry.optInt("minutes", 0)
            if (pkg.isBlank() || minutes <= 0) continue

            var threshold = defaultThreshold
            for (j in 0 until overrides.length()) {
                val override = overrides.optJSONObject(j) ?: continue
                val pattern = override.optString("pattern").trim()
                if (pattern.isBlank()) continue
                if (label.contains(pattern, ignoreCase = true) || pkg.contains(pattern, ignoreCase = true)) {
                    threshold = override.optInt("minutes", defaultThreshold).coerceIn(0, 720)
                    break
                }
            }
            if (threshold <= 0) continue
            val tier = minutes / threshold
            if (tier <= 0 || tier <= tiers.optInt(pkg, 0)) continue

            if (!hasMatchingRule(prefs, "应用用太久", label)) continue
            val event = JSONObject()
                .put("id", "usage_${Integer.toHexString(pkg.hashCode())}_${today.replace("-", "")}_${tier}")
                .put("type", "应用用太久")
                .put("payload", "${label} 今天已累计使用 ${minutes} 分钟")
                .put("createdAt", java.time.Instant.ofEpochMilli(now).toString())
            enqueueEvent(event)
            tiers.put(pkg, tier)
            showReturnToStudyNotification(label, "今天已累计使用 ${minutes} 分钟", prefs)
        }

        prefs.edit()
            .putString("usageSignalDate", today)
            .putString("usageSignalTiers", tiers.toString())
            .apply()
    }

    @Volatile private var lastUsageCheckAt: Long = 0L

    /** 仅上传能命中用户已启用现实桥规则的应用事件，避免把无关应用名送上云。 */
    private fun hasMatchingRule(
        prefs: android.content.SharedPreferences,
        eventType: String,
        label: String,
    ): Boolean {
        val rules = try { JSONArray(prefs.getString("ruleFilters", "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
        for (i in 0 until rules.length()) {
            val rule = rules.optJSONObject(i) ?: continue
            val type = rule.optString("matchType")
            if (type != "*" && type != eventType) continue
            val filter = rule.optString("payloadFilter").trim()
            val terms = filter.split("|", ",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            if (terms.isEmpty() || terms.any { label.lowercase().contains(it) }) return true
        }
        return false
    }

    /**
     * Android 不保证允许后台服务直接抢前台打开另一个 App。
     * 因此提供本地通知的一键返回操作；用户点击后由 PendingIntent 正常启动目标学习软件。
     */
    private fun showReturnToStudyNotification(label: String, detail: String, prefs: android.content.SharedPreferences) {
        val targetPackage = prefs.getString("targetPackage", "").orEmpty()
        if (targetPackage.isBlank()) return
        val filter = prefs.getString("targetFilter", "").orEmpty()
        val terms = filter.split("|", ",").map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        if (terms.isNotEmpty() && terms.none { label.lowercase().contains(it) }) return

        val launchIntent = packageManager.getLaunchIntentForPackage(targetPackage) ?: return
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingIntent = PendingIntent.getActivity(
            this,
            targetPackage.hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel("native_focus_reminder", "专注提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "应用连续使用达到设定时长时，提供返回学习软件的快捷操作"
                    setShowBadge(false)
                },
            )
        }
        val notification = NotificationCompat.Builder(this, "native_focus_reminder")
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机 · 专注提醒")
            .setContentText("${label} ${detail}，点此返回学习软件")
            .setContentIntent(pendingIntent)
            .addAction(NotificationCompat.Action(0, "返回学习软件", pendingIntent))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        runCatching { manager.notify(42_013, notification) }
    }

    private fun enqueueEvent(event: JSONObject) {
        val id = event.optString("id")
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            for (i in 0 until queue.length()) {
                if (queue.optJSONObject(i)?.optString("id") == id) return
            }
        }
        // 云端优先：上传前不在本机执行规则、设备动作或通知。
        event.put("notifyAlreadyShown", false)
        event.put("queuedAt", System.currentTimeMillis())
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            for (i in 0 until queue.length()) {
                if (queue.optJSONObject(i)?.optString("id") == id) return
            }
            queue.put(event)
            val bounded = JSONArray()
            for (i in (queue.length() - 20).coerceAtLeast(0) until queue.length()) bounded.put(queue.getJSONObject(i))
            prefs.edit().putString(QUEUE_KEY, bounded.toString()).apply()
        }
    }

    private fun updatePendingEvent(id: String, updates: JSONObject) {
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            for (i in 0 until queue.length()) {
                val item = queue.optJSONObject(i) ?: continue
                if (item.optString("id") != id) continue
                val keys = updates.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    item.put(key, updates.opt(key))
                }
                break
            }
            prefs.edit().putString(QUEUE_KEY, queue.toString()).apply()
        }
    }

    /** Persist a native fallback reply before acknowledging/removing its event. */
    private fun syncOfflineFallback(event: JSONObject, cookie: String): Boolean {
        val fallback = event.optJSONObject("fallbackChat") ?: return true
        if (!fallback.has("chat")) {
            updatePendingEvent(event.optString("id"), JSONObject().put("fallbackSynced", true))
            return true
        }
        if (event.optBoolean("fallbackSynced", false)) return true
        return runCatching {
            val body = JSONObject()
                .put("eventId", event.optString("id"))
                .put("fallback", fallback)
                .toString()
                .toRequestBody("application/json; charset=utf-8".toMediaType())
            val builder = Request.Builder()
                .url("${MainActivity.SITE_URL.trimEnd('/')}/api/push/bridge-native-event/fallback")
                .header("Accept", "application/json")
                .post(body)
            if (cookie.isNotEmpty()) builder.header("Cookie", cookie)
            client.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) return@runCatching false
                updatePendingEvent(event.optString("id"), JSONObject().put("fallbackSynced", true))
                true
            }
        }.getOrDefault(false)
    }

    private fun deliverPendingEvents() {
        if (delivering) return
        val events = synchronized(pendingLock) {
            val raw = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(QUEUE_KEY, "[]") ?: "[]"
            try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
        }
        if (events.length() == 0) return

        // Self-hosted local_user 不需要登录 Cookie；普通账号仍由服务端 Cookie 校验。
        val cookie = runCatching { CookieManager.getInstance().getCookie(MainActivity.SITE_URL).orEmpty() }.getOrDefault("")
        delivering = true
        Thread({
            try {
                for (i in 0 until events.length()) {
                    val event = events.optJSONObject(i) ?: continue
                    val id = event.optString("id").trim()
                    if (id.isBlank()) continue
                    val cloudAccepted = event.optBoolean("cloudAccepted", false)
                    val fallbackSent = event.optBoolean("fallbackSent", false)
                    var fallbackSynced = event.optBoolean("fallbackSynced", false) || !event.has("fallbackChat")
                    if (fallbackSent && !fallbackSynced) {
                        fallbackSynced = syncOfflineFallback(event, cookie)
                    }

                    if (cloudAccepted) {
                        // Shell Realtime 通知在原生 NotificationManager 接受提交后回执；
                        // 不再把 Service Worker 回执误当作 Android 壳的唯一确认来源。
                        if (fallbackSent) {
                            if (!fallbackSynced) continue
                            if (event.optBoolean("localOnly", false)) {
                                removePendingEvent(id)
                                continue
                            }
                            val fallbackBody = JSONObject().put("eventId", id).put("status", "fallback")
                                .toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                            val fallbackBuilder = Request.Builder()
                                .url(MainActivity.SITE_URL.trimEnd('/') + "/api/push/bridge-native-event/receipt")
                                .post(fallbackBody)
                            if (cookie.isNotEmpty()) fallbackBuilder.header("Cookie", cookie)
                            val saved = runCatching {
                                client.newCall(fallbackBuilder.build()).execute().use { it.isSuccessful }
                            }.getOrDefault(false)
                            if (saved) removePendingEvent(id)
                            continue
                        }

                        val receiptBuilder = Request.Builder()
                            .url("${MainActivity.SITE_URL.trimEnd('/')}/api/push/bridge-native-event/receipt?id=${java.net.URLEncoder.encode(id, "UTF-8")}")
                            .header("Accept", "application/json")
                            .get()
                        if (cookie.isNotEmpty()) receiptBuilder.header("Cookie", cookie)
                        val receipt = runCatching {
                            client.newCall(receiptBuilder.build()).execute().use { response ->
                                if (!response.isSuccessful) null
                                else JSONObject(response.body?.string().orEmpty())
                            }
                        }.getOrNull()
                        if (receipt?.optBoolean("displayed", false) == true || receipt?.optBoolean("fallback", false) == true) {
                            removePendingEvent(id)
                            continue
                        }

                        // 等待窗口覆盖 bridge_scan 的分钟级调度与 AI 回复最长 5 分钟执行时间。
                        // 超时才使用本机离线回复；只有原生通知确实提交成功才写 fallback 回执。
                        val acceptedAt = event.optLong("cloudAcceptedAt", 0L)
                        if (acceptedAt > 0L && System.currentTimeMillis() - acceptedAt >= 6 * 60_000L) {
                            val fallback = runCatching {
                                NativeRealityBridge.postOfflineNotificationFallback(
                                    applicationContext, id, event.optString("type"), event.optString("payload"),
                                    event.opt("createdAt")?.toString().orEmpty(),
                                )
                            }.getOrNull()
                            if (fallback != null) updatePendingEvent(
                                id,
                                JSONObject().put("fallbackSent", true).put("fallbackChat", fallback),
                            )
                        }
                        continue
                    }

                    val body = JSONObject()
                        .put("id", id)
                        .put("type", event.optString("type"))
                        .put("payload", event.optString("payload"))
                        .put("createdAt", event.optString("createdAt"))
                        .put("notifyAlreadyShown", fallbackSent || event.optBoolean("notifyAlreadyShown", false))
                        .toString()
                        .toRequestBody("application/json; charset=utf-8".toMediaType())
                    val uploadBuilder = Request.Builder()
                        .url("${MainActivity.SITE_URL.trimEnd('/')}/api/push/bridge-native-event")
                        .header("Accept", "application/json")
                        .post(body)
                    if (cookie.isNotEmpty()) uploadBuilder.header("Cookie", cookie)

                    val uploadCode = runCatching {
                        client.newCall(uploadBuilder.build()).execute().use { it.code }
                    }.getOrNull()
                    when {
                        uploadCode == 410 -> {
                            if (fallbackSent && !fallbackSynced) {
                                updatePendingEvent(id, JSONObject().put("cloudAccepted", true).put("cloudAcceptedAt", System.currentTimeMillis()))
                            } else {
                                removePendingEvent(id)
                            }
                        }
                        uploadCode != null && uploadCode in 200..299 -> {
                            if (fallbackSent || event.optBoolean("notifyAlreadyShown", false)) {
                                // 本机已经提交过通知；先确保离线回复已进入聊天回传箱，再结束事件。
                                if (fallbackSynced) removePendingEvent(id)
                                else updatePendingEvent(
                                    id,
                                    JSONObject().put("cloudAccepted", true).put("cloudAcceptedAt", System.currentTimeMillis())
                                )
                            } else {
                                updatePendingEvent(
                                    id,
                                    JSONObject().put("cloudAccepted", true).put("cloudAcceptedAt", System.currentTimeMillis())
                                )
                            }
                        }
                        else -> {
                            // 云端不可达时才走本机离线兜底。若失败，不伪造回执、不删除队列。
                            val queuedAt = event.optLong("queuedAt", 0L)
                            if (!fallbackSent && queuedAt > 0L && System.currentTimeMillis() - queuedAt >= 45_000L) {
                                val fallback = runCatching {
                                    NativeRealityBridge.postOfflineNotificationFallback(
                                        applicationContext, id, event.optString("type"), event.optString("payload"),
                                        event.opt("createdAt")?.toString().orEmpty(),
                                    )
                                }.getOrNull()
                                if (fallback != null) updatePendingEvent(
                                    id,
                                    JSONObject().put("fallbackSent", true).put("fallbackChat", fallback),
                                )
                            }
                        }
                    }
                }
            } finally {
                delivering = false
            }
        }, "native-perception-upload").start()
    }

    private fun removePendingEvent(id: String) {
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val old = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            val next = JSONArray()
            for (i in 0 until old.length()) {
                val item = old.optJSONObject(i) ?: continue
                if (item.optString("id") != id) next.put(item)
            }
            prefs.edit().putString(QUEUE_KEY, next.toString()).apply()
        }
    }

    override fun onInterrupt() {
        // 无需处理：本服务不阻塞任何交互
    }

    override fun onDestroy() {
        connected = false
        handler.removeCallbacks(dwellTicker)
        ScreenshotBridge.attach(null)
        super.onDestroy()
    }
}
