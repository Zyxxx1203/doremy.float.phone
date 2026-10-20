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
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
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
        const val ACTION_SHOW_COMMENT = "app.floatphone.shell.GLOBAL_WATCH_SHOW_COMMENT"
        const val ACTION_FRAME = "app.floatphone.shell.GLOBAL_WATCH_FRAME"
        const val ACTION_REPLY = "app.floatphone.shell.GLOBAL_WATCH_REPLY"
        const val ACTION_STATE = "app.floatphone.shell.GLOBAL_WATCH_STATE"
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
                if (text != null) putExtra("reply_text", text)
            })
        }

        fun isRunning(context: Context): Boolean =
            context.getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).getBoolean("running", false)
    }

    private val mainHandler = Handler(android.os.Looper.getMainLooper())
    private var workerThread: HandlerThread? = null
    private var worker: Handler? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var overlay: LinearLayout? = null
    private var windowManager: WindowManager? = null
    private var paused = false
    private var capturePending = false
    private var config = JSONObject()
    private var minIntervalSeconds = 35
    private var maxIntervalSeconds = 95
    private var characterName = "陪看角色"
    private var statusText: TextView? = null
    private var pauseButton: Button? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> beginCapture(intent)
            ACTION_STOP -> stopSelf()
            ACTION_PAUSE -> setPaused(true)
            ACTION_RESUME -> setPaused(false)
            ACTION_CAPTURE_NOW -> requestCapture()
            ACTION_SHOW_COMMENT -> {
                val comment = intent.getStringExtra("comment").orEmpty().trim()
                if (comment.isNotEmpty()) emitState(characterName + "：" + comment.take(240))
            }
            ACTION_REPLY -> {
                val text = intent.getStringExtra("reply_text").orEmpty().trim()
                if (text.isNotEmpty()) sendBroadcast(Intent(ACTION_REPLY).setPackage(packageName).putExtra("text", text))
            }
        }
        return START_NOT_STICKY
    }

    private fun beginCapture(intent: Intent) {
        if (projection != null) return
        config = runCatching { JSONObject(intent.getStringExtra(EXTRA_CONFIG).orEmpty()) }.getOrDefault(JSONObject())
        characterName = config.optString("characterName", "陪看角色").take(40)
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
        if (resultData == null) { stopSelf(); return }
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = runCatching { manager.getMediaProjection(resultCode, resultData) }.getOrNull()
        if (projection == null) { stopSelf(); return }

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
        if (display == null) { stopSelf(); return }
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
        val bytes = ByteArrayOutputStream()
        output.compress(Bitmap.CompressFormat.JPEG, 48, bytes)
        if (output !== cropped) output.recycle()
        cropped.recycle()
        val data = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
        sendBroadcast(Intent(ACTION_FRAME).setPackage(packageName)
            .putExtra("dataUrl", "data:image/jpeg;base64," + data)
            .putExtra("capturedAt", System.currentTimeMillis()))
        bytes.close()
        emitState("已捕获一帧；等待陪看模型分析")
    }

    private fun scheduleNextCapture() {
        worker?.removeCallbacks(captureRunnable)
        if (paused || projection == null) return
        val delay = Random.nextInt(minIntervalSeconds, maxIntervalSeconds + 1) * 1000L
        worker?.postDelayed(captureRunnable, delay)
    }

    private val captureRunnable = Runnable { requestCapture() }

    private fun requestCapture() {
        if (paused || projection == null) return
        capturePending = true
        worker?.postDelayed({
            if (capturePending) {
                capturePending = false
                emitState("未取得屏幕帧；将于下个随机间隔重试")
            }
            scheduleNextCapture()
        }, 2200L)
    }

    private fun setPaused(value: Boolean) {
        paused = value
        getSharedPreferences("global_watch_state", Context.MODE_PRIVATE).edit().putBoolean("paused", value).apply()
        if (value) worker?.removeCallbacks(captureRunnable) else scheduleNextCapture()
        pauseButton?.text = if (value) "继续" else "暂停"
        emitState(if (value) "全局陪看已暂停；不会继续捕获屏幕" else "全局陪看已恢复")
    }

    private fun showOverlay() {
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
            setTextColor(0xFF5A3B2D.toInt())
            setPadding(0, 0, 0, dp(5))
        }
        statusText = TextView(this).apply {
            text = "屏幕捕获已开启（点击暂停可立即停止捕获）"
            textSize = 10f
            setTextColor(0xFF806C5C.toInt())
        }
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
        val replyRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val input = EditText(this).apply {
            hint = "直接回复角色…"
            textSize = 12f
            singleLine = true
            setTextColor(0xFF49372D.toInt())
            setHintTextColor(0xFF9A8779.toInt())
            setPadding(dp(8), 0, dp(8), 0)
        }
        val send = Button(this).apply {
            text = "发送"
            setOnClickListener {
                val message = input.text?.toString().orEmpty().trim()
                if (message.isNotEmpty()) {
                    sendBroadcast(Intent(ACTION_REPLY).setPackage(packageName).putExtra("text", message))
                    input.setText("")
                    emitState("回复已发送给陪看模块")
                }
            }
        }
        replyRow.addView(input, LinearLayout.LayoutParams(0, dp(44), 1f))
        replyRow.addView(send, LinearLayout.LayoutParams(dp(72), dp(44)))
        root.addView(replyRow)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = dp(32); softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE }
        try {
            windowManager?.addView(root, params)
            overlay = root
        } catch (_: Throwable) { stopSelf() }
    }

    private fun emitState(message: String) {
        mainHandler.post { statusText?.text = message }
        sendBroadcast(Intent(ACTION_STATE).setPackage(packageName).putExtra("message", message).putExtra("paused", paused))
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