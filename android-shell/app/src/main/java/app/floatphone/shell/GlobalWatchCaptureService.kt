package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.view.Gravity
import android.view.WindowManager
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/**
 * User-started global watch companion.
 * Captures are only emitted after an explicit MediaProjection consent and while this visible
 * foreground service is running. No raw frames are written to disk.
 */
class GlobalWatchCaptureService : Service() {
    companion object {
        const val ACTION_START = "app.floatphone.shell.GLOBAL_WATCH_START"
        const val ACTION_STOP = "app.floatphone.shell.GLOBAL_WATCH_STOP"
        const val ACTION_PAUSE = "app.floatphone.shell.GLOBAL_WATCH_PAUSE"
        const val ACTION_RESUME = "app.floatphone.shell.GLOBAL_WATCH_RESUME"
        const val ACTION_CAPTURE_NOW = "app.floatphone.shell.GLOBAL_WATCH_CAPTURE_NOW"
        const val ACTION_SET_SPEECH = "app.floatphone.shell.GLOBAL_WATCH_SET_SPEECH"
        const val ACTION_SHOW_COMMENT = "app.floatphone.shell.GLOBAL_WATCH_SHOW_COMMENT"
        const val ACTION_FRAME = "app.floatphone.shell.GLOBAL_WATCH_FRAME"
        const val ACTION_REPLY = "app.floatphone.shell.GLOBAL_WATCH_REPLY"
        const val ACTION_STATE = "app.floatphone.shell.GLOBAL_WATCH_STATE"
        const val ACTION_RECORD = "app.floatphone.shell.GLOBAL_WATCH_RECORD"
        const val EXTRA_RESULT_CODE = "projection_result_code"
        const val EXTRA_RESULT_DATA = "projection_result_data"
        const val EXTRA_CONFIG = "global_watch_config"
        private const val CHANNEL_ID = "global_watch_capture"
        private const val NOTIFICATION_ID = 47

        fun start(context: Context, resultCode: Int, resultData: Intent, config: String) {
            val intent = Intent(context, GlobalWatchCaptureService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, resultData)
                putExtra(EXTRA_CONFIG, config)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        fun command(context: Context, action: String, text: String? = null) {
            context.startService(Intent(context, GlobalWatchCaptureService::class.java).apply {
                this.action = action
                if (text != null) { putExtra("reply_text", text); putExtra("comment", text) }
            })
        }

        fun setSpeechEnabled(context: Context, enabled: Boolean) {
            context.startService(Intent(context, GlobalWatchCaptureService::class.java).apply {
                action = ACTION_SET_SPEECH
                putExtra("speech_enabled", enabled)
            })
        }

        fun isRunning(context: Context): Boolean =
            context.getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).getBoolean("running", false)
        fun recordsJson(context: Context): String =
            context.getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).getString("records", "[]") ?: "[]"
    }

    private val mainHandler = Handler(android.os.Looper.getMainLooper())
    private var workerThread: HandlerThread? = null
    private var worker: Handler? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var overlay: LinearLayout? = null
    private var overlayControls: LinearLayout? = null
    private var overlayReply: LinearLayout? = null
    private var overlayStatus: TextView? = null
    private var bannerWebView: WebView? = null
    private var bannerExpanded = false
    private var bannerStatus = "屏幕捕获已开启（点击暂停可立即停止捕获）"
    private var bannerMessage = ""
    private var overlayExpanded = false
    private var windowManager: WindowManager? = null
    @Volatile private var paused = false
    @Volatile private var capturePending = false
    private var config = JSONObject()
    private var minIntervalSeconds = 35
    private var maxIntervalSeconds = 95
    private var characterName = "陪看角色"
    private var statusText: TextView? = null
    private var pauseButton: Button? = null
    @Volatile private var latestFrameDataUrl = ""
    @Volatile private var aiBusy = false
    @Volatile private var pendingUserReply = ""
    private var sessionId = UUID.randomUUID().toString()
    private var speechIntervalMinMinutes = 2
    private var speechIntervalMaxMinutes = 5
    private var randomSpeechEnabled = true
    @Volatile private var forceNextAnalysis = false
    private var nextAiAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> beginCapture(intent)
            ACTION_STOP -> stopSelf()
            ACTION_PAUSE -> setPaused(true)
            ACTION_RESUME -> setPaused(false)
            ACTION_CAPTURE_NOW -> { forceNextAnalysis = true; requestCapture() }
            ACTION_SET_SPEECH -> {
                randomSpeechEnabled = intent.getBooleanExtra("speech_enabled", true)
                nextAiAt = if (randomSpeechEnabled) System.currentTimeMillis() else Long.MAX_VALUE
                emitState(if (randomSpeechEnabled) "随机主动发言已开启" else "随机主动发言已关闭；仍可手动捕获分析和回复角色")
            }
            ACTION_SHOW_COMMENT -> {
                val comment = intent.getStringExtra("comment").orEmpty().trim()
                if (comment.isNotEmpty()) {
                    bannerMessage = comment.take(1000)
                    setOverlayExpanded(true)
                    emitState(characterName + "：" + comment.take(240))
                }
            }
            ACTION_REPLY -> {
                val text = intent.getStringExtra("reply_text").orEmpty().trim()
                if (text.isNotEmpty()) {
                    // 用户回复由网页保存并调用模型；原生只转发，避免重复记录/重复请求。
                    sendBroadcast(Intent(ACTION_REPLY).setPackage(packageName).putExtra("text", text))
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun beginCapture(intent: Intent) {
        if (projection != null) return
        config = runCatching { JSONObject(intent.getStringExtra(EXTRA_CONFIG).orEmpty()) }.getOrDefault(JSONObject())
        characterName = config.optString("characterName", "陪看角色").take(40)
        sessionId = UUID.randomUUID().toString()
        speechIntervalMinMinutes = config.optInt("speechIntervalMinMinutes", 2).coerceIn(1, 60)
        speechIntervalMaxMinutes = config.optInt("speechIntervalMaxMinutes", 5).coerceIn(speechIntervalMinMinutes, 120)
        randomSpeechEnabled = config.optBoolean("randomSpeechEnabled", true)
        nextAiAt = if (randomSpeechEnabled) System.currentTimeMillis() else Long.MAX_VALUE
        saveRecord("system", "全局陪看会话开始", System.currentTimeMillis())
        minIntervalSeconds = config.optInt("captureIntervalMinSeconds", 35).coerceIn(15, 600)
        maxIntervalSeconds = config.optInt("captureIntervalMaxSeconds", 95).coerceIn(minIntervalSeconds, 900)
        createNotificationChannel()
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("全局陪看正在运行")
            .setContentText("屏幕捕获已开启；点击悬浮横幅可暂停或停止")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else startForeground(NOTIFICATION_ID, notification)

        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val resultData = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
            else @Suppress("DEPRECATION") (intent.getParcelableExtra(EXTRA_RESULT_DATA) as? Intent)
        if (resultData == null) {
            saveRecord("error", "系统未返回屏幕捕获授权数据。", System.currentTimeMillis())
            emitState("启动失败：系统未返回屏幕捕获授权数据")
            stopSelf()
            return
        }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = runCatching { manager.getMediaProjection(resultCode, resultData) }.getOrNull()
        if (projection == null) {
            saveRecord("error", "Android 未能创建 MediaProjection；请重新授权屏幕捕获。", System.currentTimeMillis())
            emitState("启动失败：Android 未能创建屏幕捕获会话，请重新授权")
            stopSelf()
            return
        }

        workerThread = HandlerThread("GlobalWatchCapture").also { it.start() }
        worker = Handler(workerThread!!.looper)
        val metrics = Resources.getSystem().displayMetrics
        val width = max(1, metrics.widthPixels)
        val height = max(1, metrics.heightPixels)
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader?.setOnImageAvailableListener({ reader ->
            val image = runCatching { reader.acquireLatestImage() }.getOrNull() ?: return@setOnImageAvailableListener
            if (!capturePending || paused) { image.close(); return@setOnImageAvailableListener }
            capturePending = false
            try { emitFrame(image, width, height) } catch (_: Throwable) { emitState("截图失败；请检查系统是否允许屏幕捕获") } finally { image.close() }
        }, worker)
        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                emitState("屏幕捕获已由系统停止")
                stopSelf()
            }
        }, mainHandler)
        display = projection?.createVirtualDisplay(
            "FloatPhoneGlobalWatch", width, height, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface, null, worker
        )
        if (display == null) {
            saveRecord("error", "无法创建屏幕虚拟显示。", System.currentTimeMillis())
            emitState("启动失败：无法创建屏幕虚拟显示")
            stopSelf()
            return
        }
        getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).edit().putBoolean("running", true).putBoolean("paused", false).apply()
        showOverlay()
        emitState("正在捕获屏幕；仅在本横幅可见且服务运行时工作")
        scheduleNextCapture()
    }

    private fun emitFrame(image: Image, screenWidth: Int, screenHeight: Int) {
        val plane = image.planes[0]
        val buffer: ByteBuffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * screenWidth
        val paddedWidth = screenWidth + max(0, rowPadding / max(1, pixelStride))
        val padded = Bitmap.createBitmap(paddedWidth, screenHeight, Bitmap.Config.ARGB_8888)
        padded.copyPixelsFromBuffer(buffer)
        val cropped = Bitmap.createBitmap(padded, 0, 0, min(screenWidth, padded.width), min(screenHeight, padded.height))
        padded.recycle()
        val maxSide = 900
        val scale = min(1f, maxSide.toFloat() / max(cropped.width, cropped.height).toFloat())
        val output = if (scale < 1f) Bitmap.createScaledBitmap(cropped, max(1, (cropped.width * scale).toInt()), max(1, (cropped.height * scale).toInt()), true) else cropped
        if (isLikelyBlack(output)) {
            if (output !== cropped) output.recycle()
            cropped.recycle()
            saveRecord("error", "屏幕画面几乎全黑，可能是目标应用禁止截屏（FLAG_SECURE）。", System.currentTimeMillis())
            emitState("该应用禁止截屏/画面全黑；跳过本次分析")
            return
        }
        val bytes = ByteArrayOutputStream()
        output.compress(Bitmap.CompressFormat.JPEG, 48, bytes)
        if (output !== cropped) output.recycle()
        cropped.recycle()
        val data = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        val dataUrl = "data:image/jpeg;base64," + data
        val capturedAt = System.currentTimeMillis()
        latestFrameDataUrl = dataUrl
        // Keep raw screen pixels inside the native service; the WebView only receives a timestamp.
        sendBroadcast(Intent(ACTION_FRAME).setPackage(packageName)
            .putExtra("capturedAt", capturedAt)
            .putExtra("dataUrl", dataUrl)
            .putExtra("force", forceNextAnalysis))
        bytes.close()
        // 分析统一交给网页侧（和查岗/语音通话同一条 API 配置链路）。
        // 原生只负责捕获、折叠横幅和显示回复，避免在 Service 里二次解析 API Key。
        forceNextAnalysis = false
        emitState("已捕获屏幕帧，等待网页分析")
    }


    /** 近似黑帧检测：全黑/全透明通常是 FLAG_SECURE，别把黑图送给模型。 */
    private fun isLikelyBlack(bitmap: Bitmap): Boolean {
        val stepX = max(1, bitmap.width / 32)
        val stepY = max(1, bitmap.height / 32)
        var sum = 0L
        var count = 0
        var maxLum = 0
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val color = bitmap.getPixel(x, y)
                val lum = ((color shr 16 and 0xFF) * 299 + (color shr 8 and 0xFF) * 587 + (color and 0xFF) * 114) / 1000
                sum += lum
                count += 1
                if (lum > maxLum) maxLum = lum
                x += stepX
            }
            y += stepY
        }
        return count > 0 && sum / count < 5 && maxLum < 20
    }

    private fun requestNativeAnalysis(dataUrl: String, capturedAt: Long, userReply: String) {
        if (aiBusy) {
            if (userReply.isNotBlank()) {
                pendingUserReply = listOf(pendingUserReply, userReply).filter { it.isNotBlank() }.joinToString("\n").takeLast(1000)
                emitState("上一轮模型请求仍在进行；你的回复已排队，完成后会继续回应")
            }
            return
        }
        aiBusy = true
        nextAiAt = System.currentTimeMillis() +
            (speechIntervalMinMinutes + kotlin.random.Random.nextInt(speechIntervalMaxMinutes - speechIntervalMinMinutes + 1)) * 60000L
        worker?.post {
            try { analyzeFrameNative(dataUrl, capturedAt, userReply) }
            finally {
                aiBusy = false
                val queuedReply = pendingUserReply
                if (queuedReply.isNotBlank()) {
                    pendingUserReply = ""
                    val latest = latestFrameDataUrl
                    if (latest.isNotBlank()) requestNativeAnalysis(latest, System.currentTimeMillis(), queuedReply)
                }
            }
        }
    }

    private fun analyzeFrameNative(dataUrl: String, capturedAt: Long, userReply: String) {
        val video = config.optJSONObject("imageModel") ?: JSONObject()
        val provider = video.optString("provider", "")
        val apiKey = video.optString("apiKey", "").trim()
        val model = video.optString("model", "").trim()
        val baseUrl = video.optString("baseUrl", "").trim().trimEnd('/')
        val rolePrompt = config.optString("rolePrompt", "保持角色口吻，简短自然回应。").take(3500)
        val prompt = "你正在通过 Android 原生全局陪看悬浮横幅陪伴用户。请以角色身份自然回应屏幕，不要输出通用图像识别报告。角色名：" +
            characterName + "\n" + rolePrompt +
            (if (userReply.isNotBlank()) "\n用户刚刚回复你：" + userReply.take(1000) else "\n请结合画面分享一个简短观察或感受。") +
            "\n忽略密码、验证码、支付信息和私人聊天，不要复述敏感内容。回复1-3句话。"
        if (model.isBlank() || provider.isBlank()) {
            saveRecord("error", "未找到可用的主聊天视觉模型配置。", capturedAt)
            emitState("未找到可用的主聊天视觉模型配置，请在 API 设置中启用图片识别并配置模型")
            return
        }
        val localEndpoint = baseUrl.contains("localhost") || baseUrl.contains("127.0.0.1") ||
            baseUrl.contains("10.0.2.2") || baseUrl.contains("192.168.")
        if (apiKey.isBlank() && !(provider == "openai-compatible" && localEndpoint)) {
            saveRecord("error", "未配置 API Key。", capturedAt)
            emitState("未配置 API Key，请检查视频分析模型设置")
            return
        }
        try {
            val match = Regex("^data:(image/[A-Za-z0-9.+-]+);base64,([\\s\\S]+)$").find(dataUrl)
                ?: throw IllegalArgumentException("截屏图片数据无效")
            val mime = match.groupValues[1]
            val base64 = match.groupValues[2]
            val root = if (baseUrl.isNotBlank()) baseUrl else when (provider) {
                "gemini" -> "https://generativelanguage.googleapis.com"
                "anthropic" -> "https://api.anthropic.com"
                "ark" -> "https://ark.cn-beijing.volces.com/api/v3"
                else -> "https://api.openai.com/v1"
            }
            val endpoint: String
            val body: JSONObject
            val headers = mutableMapOf("Content-Type" to "application/json")
            when (provider) {
                "gemini" -> {
                    endpoint = root.removeSuffix("/v1beta") + "/v1beta/models/" +
                        java.net.URLEncoder.encode(model.removePrefix("models/"), "UTF-8") + ":generateContent"
                    headers["x-goog-api-key"] = apiKey
                    val parts = JSONArray()
                        .put(JSONObject().put("inlineData", JSONObject().put("mimeType", mime).put("data", base64)))
                        .put(JSONObject().put("text", prompt))
                    body = JSONObject().put("contents", JSONArray().put(JSONObject().put("role", "user").put("parts", parts)))
                        .put("generationConfig", JSONObject().put("temperature", 0.8).put("maxOutputTokens", 1200))
                }
                "anthropic" -> {
                    endpoint = root.removeSuffix("/v1") + "/v1/messages"
                    headers["x-api-key"] = apiKey
                    headers["anthropic-version"] = "2023-06-01"
                    val content = JSONArray()
                        .put(JSONObject().put("type", "text").put("text", prompt))
                        .put(JSONObject().put("type", "image").put("source", JSONObject().put("type", "base64")
                            .put("media_type", mime).put("data", base64)))
                    body = JSONObject().put("model", model).put("max_tokens", 1200)
                        .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
                }
                else -> {
                    val normalized = if (provider == "ark") root.removeSuffix("/chat/completions") else root
                    endpoint = if (normalized.endsWith("/chat/completions")) normalized else normalized + "/chat/completions"
                    if (apiKey.isNotBlank()) headers["Authorization"] = "Bearer " + apiKey
                    val content = JSONArray()
                        .put(JSONObject().put("type", "text").put("text", prompt))
                        .put(JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", dataUrl).put("detail", "high")))
                    body = JSONObject().put("model", model).put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
                        .put("max_tokens", 1200).put("temperature", 0.7)
                }
            }
            val conn = URL(endpoint).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 20000
            conn.readTimeout = 45000
            conn.doOutput = true
            headers.forEach { (key, value) -> conn.setRequestProperty(key, value) }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val raw = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            conn.disconnect()
            if (code !in 200..299) {
                val detail = runCatching { JSONObject(raw).optJSONObject("error")?.optString("message") }
                    .getOrNull().orEmpty().take(240)
                throw IllegalStateException("模型请求失败 HTTP " + code + if (detail.isNotBlank()) "：" + detail else "")
            }
            val json = JSONObject(raw)
            val result = when (provider) {
                "gemini" -> json.optJSONArray("candidates")?.optJSONObject(0)?.optJSONObject("content")
                    ?.optJSONArray("parts")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("text") }.joinToString("\n") }.orEmpty()
                "anthropic" -> json.optJSONArray("content")?.let { a ->
                    (0 until a.length()).mapNotNull { a.optJSONObject(it)?.takeIf { p -> p.optString("type") == "text" }?.optString("text") }.joinToString("\n")
                }.orEmpty()
                else -> json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.opt("content")?.let { value ->
                    if (value is String) value else if (value is JSONArray)
                        (0 until value.length()).mapNotNull { value.optJSONObject(it)?.optString("text") }.joinToString("\n")
                    else value.toString()
                }.orEmpty()
            }.trim()
            if (result.isBlank()) throw IllegalStateException("模型返回了空结果")
            saveRecord("character", result, System.currentTimeMillis())
            command(this, ACTION_SHOW_COMMENT, result)
            emitState("原生模型分析完成，结果已保存")
        } catch (error: Exception) {
            val message = (error.message ?: "未知错误").take(300)
            saveRecord("error", "模型分析失败：" + message, System.currentTimeMillis())
            emitState("模型分析失败：" + message)
        }
    }

    private fun saveRecord(kind: String, text: String, createdAt: Long) {
        val prefs = getSharedPreferences("global_watch_state", Context.MODE_PRIVATE)
        val old = runCatching { JSONArray(prefs.getString("records", "[]")) }.getOrDefault(JSONArray())
        val arr = JSONArray()
        for (i in max(0, old.length() - 299) until old.length()) arr.put(old.get(i))
        val item = JSONObject().put("id", "native-watch-" + UUID.randomUUID()).put("sessionId", sessionId)
            .put("kind", kind).put("text", text.take(2000)).put("createdAt", createdAt)
            .put("characterName", characterName).put("characterId", config.optString("characterId", ""))
        arr.put(item)
        prefs.edit().putString("records", arr.toString()).putLong("lastRecordAt", createdAt)
            .putString("lastError", if (kind == "error") text else prefs.getString("lastError", "")).apply()
        sendBroadcast(Intent(ACTION_RECORD).setPackage(packageName).putExtra("record", item.toString()))
    }

    private fun scheduleNextCapture() {
        worker?.removeCallbacks(captureRunnable)
        if (paused || projection == null) return
        val delay = Random.nextInt(minIntervalSeconds, maxIntervalSeconds + 1) * 1000L
        worker?.postDelayed(captureRunnable, delay)
    }

    private val captureRunnable = Runnable { requestCapture() }

    private fun requestCapture() {
        if (paused) return
        // 优先复用查岗的 AccessibilityService.takeScreenshot：不需要每次让用户
        // 重新确认 MediaProjection，也没有虚拟显示；失败再退回当前投影。
        if (ScreenshotBridge.canCapture()) {
            worker?.post {
                ScreenshotBridge.captureBitmap { bitmap, error ->
                    if (bitmap == null) {
                        emitState("无障碍截屏失败：" + (error ?: "未知原因") + "；下个间隔重试")
                    } else {
                        try { emitBitmapFrame(bitmap) } finally { bitmap.recycle() }
                    }
                    scheduleNextCapture()
                }
            }
            return
        }
        if (projection == null) return
        capturePending = true
        worker?.postDelayed({
            if (capturePending) {
                capturePending = false
                emitState("未取得屏幕帧；将于下个随机间隔重试")
            }
            scheduleNextCapture()
        }, 2200L)
    }

    /** 无障碍截屏和投影共用：编码并通过广播交给 WebView 分析。 */
    private fun emitBitmapFrame(bitmap: Bitmap) {
        if (isLikelyBlack(bitmap)) {
            saveRecord("error", "屏幕画面几乎全黑，可能是目标应用禁止截屏（FLAG_SECURE）。", System.currentTimeMillis())
            emitState("该应用禁止截屏/画面全黑；跳过本次分析")
            return
        }
        val bytes = ByteArrayOutputStream()
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 48, bytes)) {
            emitState("截图编码失败；下个间隔重试")
            return
        }
        val dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        bytes.close()
        val capturedAt = System.currentTimeMillis()
        latestFrameDataUrl = dataUrl
        sendBroadcast(Intent(ACTION_FRAME).setPackage(packageName)
            .putExtra("capturedAt", capturedAt)
            .putExtra("dataUrl", dataUrl)
            .putExtra("force", forceNextAnalysis))
        forceNextAnalysis = false
        emitState("已捕获屏幕帧，等待网页分析")
    }

    private fun setPaused(value: Boolean) {
        paused = value
        getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).edit().putBoolean("paused", value).apply()
        if (value) worker?.removeCallbacks(captureRunnable) else scheduleNextCapture()
        pauseButton?.text = if (value) "继续" else "暂停"
        emitState(if (value) "全局陪看已暂停；不会继续捕获屏幕" else "全局陪看已恢复")
    }

    /** 悬浮横幅：WebView 渲染，用户 CSS 才会生效；失败时退回原生布局。 */
    private fun showOverlay() {
        if (bannerWebView != null || overlay != null) return
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val web = WebView(this)
        web.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = false
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.webViewClient = WebViewClient()
        web.addJavascriptInterface(BannerBridge(), "AndroidBanner")
        val css = config.optString("bannerCss", "").replace("</style", "<\\/style").take(20000)
        web.loadDataWithBaseURL("https://banner.local/", buildBannerHtml(css), "text/html", "utf-8", null)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            dp(if (bannerExpanded) 260 else 64),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            y = 0
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        try {
            windowManager?.addView(web, params)
            bannerWebView = web
        } catch (error: Throwable) {
            val message = (error.message ?: "系统拒绝添加悬浮窗").take(200)
            saveRecord("error", "WebView 横幅创建失败，退回原生横幅：" + message, System.currentTimeMillis())
            showNativeOverlay()
        }
    }

    private fun buildBannerHtml(userCss: String): String {
        val defaultCss = """
            *{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans SC',sans-serif;color:#5a3b2d}
            .gw-banner{margin:6px 10px;padding:10px 12px;border-radius:18px;background:#fff8f1;border:1px solid #d4ac8e;box-shadow:0 8px 24px rgba(50,30,15,.18);overflow:hidden}
            .gw-head{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;white-space:nowrap}
            .gw-dot{color:#b88768}.gw-title{min-width:0;overflow:hidden;text-overflow:ellipsis;flex:1}
            .gw-toggle{border:0;background:transparent;color:#8a6c58;font-size:13px;padding:4px 2px}
            .gw-body{display:none;margin-top:8px}.gw-banner.gw-open .gw-body{display:block}
            .gw-status{font-size:10px;line-height:1.5;color:#806c5c;margin-bottom:7px;word-break:break-word}
            .gw-controls{display:flex;gap:6px}.gw-controls button{flex:1;height:34px;border:1px solid #d8c2b1;border-radius:10px;background:#fffdf9;color:#6b5243;font-size:12px}
            .gw-controls button.gw-primary{background:#b88768;border-color:#b88768;color:#fff}
            .gw-reply{display:flex;gap:6px;margin-top:7px}.gw-reply input{min-width:0;flex:1;height:36px;border:1px solid #d8c2b1;border-radius:10px;background:#fff;padding:0 9px;font-size:12px;color:#4a352b}
            .gw-reply button{width:62px;height:36px;border:0;border-radius:10px;background:#b88768;color:#fff;font-size:12px}
        """.trimIndent()
        val safeName = characterName.replace("<", "&lt;").replace(">", "&gt;")
        return """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>$defaultCss
$userCss
</style></head><body>
<div id="banner" class="gw-banner${if (bannerExpanded) " gw-open" else ""}">
  <div class="gw-head"><span class="gw-dot">◉</span><span class="gw-title">全局陪看 · $safeName</span><button class="gw-toggle" onclick="toggle()">${if (bannerExpanded) "收起" else "展开"}</button></div>
  <div class="gw-body">
    <div id="status" class="gw-status">${escapeHtml(bannerStatus)}</div>
    <div class="gw-controls"><button id="pause" onclick="cmd('pause','')">暂停</button><button onclick="cmd('capture','')">看一帧</button><button onclick="cmd('stop','')">停止</button></div>
    <div class="gw-reply"><input id="reply" placeholder="直接回复角色…"><button onclick="send()">发送</button></div>
  </div>
</div>
<script>
function setStatus(t){document.getElementById('status').textContent=t;}
function setExpanded(v){document.getElementById('banner').classList.toggle('gw-open',!!v);document.querySelector('.gw-toggle').textContent=v?'收起':'展开';AndroidBanner.resize(!!v);}
function toggle(){setExpanded(!document.getElementById('banner').classList.contains('gw-open'));}
function cmd(a,t){AndroidBanner.command(a,t||'');}
function send(){var i=document.getElementById('reply');var t=(i.value||'').trim();if(!t)return;i.value='';AndroidBanner.command('reply',t);}
</script></body></html>"""
    }

    private fun escapeHtml(value: String): String =
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private inner class BannerBridge {
        @JavascriptInterface fun command(action: String, text: String) {
            when (action) {
                "pause" -> setPaused(!paused)
                "capture" -> { forceNextAnalysis = true; requestCapture() }
                "stop" -> stopSelf()
                "reply" -> if (text.isNotBlank()) GlobalWatchCaptureService.command(this@GlobalWatchCaptureService, ACTION_REPLY, text.take(1000))
            }
        }
        @JavascriptInterface fun resize(expanded: Boolean) {
            bannerExpanded = expanded
            bannerWebView?.let { web ->
                val params = web.layoutParams as WindowManager.LayoutParams
                params.height = dp(if (expanded) 260 else 64)
                windowManager?.updateViewLayout(web, params)
            }
        }
    }

    private fun updateBannerState() {
        val web = bannerWebView ?: return
        val status = org.json.JSONObject.quote(bannerStatus)
        val message = org.json.JSONObject.quote(bannerMessage)
        web.evaluateJavascript("setStatus($status);", null)
    }

    private fun showNativeOverlay() {
        if (overlay != null) return
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(9), dp(12), dp(9))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(0xF5FFF8F1.toInt())
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFFD4AC8E.toInt())
            }
            elevation = dp(10).toFloat()
        }
        val title = TextView(this).apply {
            text = "◉ 全局陪看 · " + characterName
            textSize = 13f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setTextColor(0xFF5A3B2D.toInt())
            setPadding(0, 0, 0, dp(5))
        }
        statusText = TextView(this).apply {
            text = "屏幕捕获已开启（点击暂停可立即停止捕获）"
            textSize = 10f
            setTextColor(0xFF806C5C.toInt())
        }
        overlayStatus = statusText
        title.setOnClickListener { setOverlayExpanded(!overlayExpanded) }
        root.addView(title)
        root.addView(statusText)
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        pauseButton = Button(this).apply { text = "暂停"; setOnClickListener { setPaused(!paused) } }
        val capture = Button(this).apply { text = "看一帧"; setOnClickListener { requestCapture() } }
        val stop = Button(this).apply { text = "停止"; setOnClickListener { stopSelf() } }
        controls.addView(pauseButton, LinearLayout.LayoutParams(0, dp(40), 1f))
        controls.addView(capture, LinearLayout.LayoutParams(0, dp(40), 1f))
        controls.addView(stop, LinearLayout.LayoutParams(0, dp(40), 1f))
        root.addView(controls)
        overlayControls = controls
        val replyRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val input = EditText(this).apply {
            hint = "直接回复角色…"
            textSize = 12f
            setSingleLine(true)
            setTextColor(0xFF49372D.toInt())
            setHintTextColor(0xFF9A8779.toInt())
            setPadding(dp(8), 0, dp(8), 0)
        }
        val send = Button(this).apply {
            text = "发送"
            setOnClickListener {
                val message = input.text?.toString().orEmpty().trim()
                if (message.isNotEmpty()) {
                    command(this@GlobalWatchCaptureService, ACTION_REPLY, message)
                    input.setText("")
                    emitState("回复已发送给陪看模块")
                }
            }
        }
        replyRow.addView(input, LinearLayout.LayoutParams(0, dp(44), 1f))
        replyRow.addView(send, LinearLayout.LayoutParams(dp(72), dp(44)))
        root.addView(replyRow)
        overlayReply = replyRow
        setOverlayExpanded(false)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            y = 0
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        try {
            windowManager?.addView(root, params)
            overlay = root
        } catch (error: Throwable) {
            val message = (error.message ?: "系统拒绝添加悬浮窗").take(200)
            saveRecord("error", "悬浮横幅创建失败：" + message, System.currentTimeMillis())
            emitState("启动失败：悬浮横幅创建失败：" + message)
            stopSelf()
        }
    }

    private fun setOverlayExpanded(expanded: Boolean) {
        overlayExpanded = expanded
        bannerExpanded = expanded
        bannerWebView?.let { web ->
            web.evaluateJavascript("setExpanded(${if (expanded) "true" else "false"});", null)
            val params = web.layoutParams as WindowManager.LayoutParams
            params.height = dp(if (expanded) 260 else 64)
            windowManager?.updateViewLayout(web, params)
        }
        overlayStatus?.visibility = if (expanded) View.VISIBLE else View.GONE
        overlayControls?.visibility = if (expanded) View.VISIBLE else View.GONE
        overlayReply?.visibility = if (expanded) View.VISIBLE else View.GONE
    }

    private fun emitState(message: String) {
        bannerStatus = message
        mainHandler.post { statusText?.text = message; updateBannerState() }
        sendBroadcast(Intent(ACTION_STATE).setPackage(packageName).putExtra("message", message).putExtra("running", projection != null).putExtra("paused", paused))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "全局陪看", NotificationManager.IMPORTANCE_LOW).apply {
                description = "全局陪看屏幕捕获状态与停止入口"
            })
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        worker?.removeCallbacksAndMessages(null)
        if (projection != null) saveRecord("system", "全局陪看会话结束", System.currentTimeMillis())
        try { overlay?.let { windowManager?.removeView(it) } } catch (_: Throwable) { }
        overlay = null
        display?.release()
        display = null
        imageReader?.close()
        imageReader = null
        projection?.stop()
        projection = null
        workerThread?.quitSafely()
        workerThread = null
        getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).edit().putBoolean("running", false).putBoolean("paused", false).apply()
        sendBroadcast(Intent(ACTION_STATE).setPackage(packageName).putExtra("message", "全局陪看已停止").putExtra("running", false))
        super.onDestroy()
    }
}