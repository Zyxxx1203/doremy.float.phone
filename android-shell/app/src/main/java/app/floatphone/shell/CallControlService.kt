package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.webkit.CookieManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
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
    }

    private val handler = Handler(Looper.getMainLooper())
    private val pendingLock = Any()
    @Volatile private var delivering = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(12, TimeUnit.SECONDS)
        .build()

    private val dwellTicker = object : Runnable {
        override fun run() {
            checkDwellThreshold()
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
        val event = JSONObject()
            .put("id", "dwell_${Integer.toHexString(pkg.hashCode())}_${startedAt}")
            .put("type", "长时间使用")
            .put("payload", "${label} 已连续使用 ${thresholdMinutes} 分钟")
            .put("createdAt", java.time.Instant.ofEpochMilli(dueAt).toString())

        // 先标记再排队：即使网络重试，也不会为同一段停留不断造新事件。
        reportedPackage = pkg
        prefs.edit().putString(REPORTED_PACKAGE_KEY, pkg).apply()
        enqueueEvent(event)
    }

    private fun enqueueEvent(event: JSONObject) {
        synchronized(pendingLock) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val queue = try { JSONArray(prefs.getString(QUEUE_KEY, "[]") ?: "[]") } catch (_: Throwable) { JSONArray() }
            val id = event.optString("id")
            for (i in 0 until queue.length()) {
                if (queue.optJSONObject(i)?.optString("id") == id) return
            }
            queue.put(event)
            // 网络长期不可用时限制队列长度，避免无限占用本机存储。
            val bounded = JSONArray()
            for (i in (queue.length() - 20).coerceAtLeast(0) until queue.length()) bounded.put(queue.getJSONObject(i))
            prefs.edit().putString(QUEUE_KEY, bounded.toString()).apply()
        }
    }

    private fun deliverPendingEvents() {
        if (delivering) return
        val events = synchronized(pendingLock) {
            val raw = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(QUEUE_KEY, "[]") ?: "[]"
            try { JSONArray(raw) } catch (_: Throwable) { JSONArray() }
        }
        if (events.length() == 0) return
        val cookie = runCatching { CookieManager.getInstance().getCookie(MainActivity.SITE_URL).orEmpty() }.getOrDefault("")
        if (cookie.isBlank()) return

        delivering = true
        Thread({
            try {
                for (i in 0 until events.length()) {
                    val event = events.optJSONObject(i) ?: continue
                    val id = event.optString("id")
                    if (id.isBlank()) continue
                    val body = JSONObject()
                        .put("id", id)
                        .put("type", event.optString("type"))
                        .put("payload", event.optString("payload"))
                        .put("createdAt", event.optString("createdAt"))
                        .toString()
                        .toRequestBody("application/json; charset=utf-8".toMediaType())
                    val request = Request.Builder()
                        .url("${MainActivity.SITE_URL.trimEnd('/')}/api/push/bridge-native-event")
                        .header("Cookie", cookie)
                        .header("Accept", "application/json")
                        .post(body)
                        .build()
                    val accepted = runCatching {
                        client.newCall(request).execute().use { response ->
                            // 410 表示事件过期，确认丢弃；其余失败留在本地待重试。
                            response.isSuccessful || response.code == 410
                        }
                    }.getOrDefault(false)
                    if (accepted) removePendingEvent(id)
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
