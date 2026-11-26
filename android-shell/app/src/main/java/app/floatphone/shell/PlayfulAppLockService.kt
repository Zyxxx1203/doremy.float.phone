package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

/**
 * 角色“小手段”：只锁一个指定应用。
 *
 * 与 FocusLockService 的区别：
 *  - 专注锁是白名单取反、带惩罚/查岗；这里是单应用黑名单，不扣信任分；
 *  - 锁页只做密码解锁，不做聊天；
 *  - 密码只由网页侧的角色工具按好感度阈值揭示，原生只在用户输入时校验。
 */
class PlayfulAppLockService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var polling = false
    private var lastShowAt = 0L
    private lateinit var prefs: android.content.SharedPreferences

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (intent?.getStringExtra("action") == "stop") {
            polling = false
            prefs.edit().putBoolean("running", false).apply()
            PlayfulLockActivity.dismissCurrent()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val target = intent?.getStringExtra("target") ?: prefs.getString("target", "") ?: ""
        if (target.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        prefs.edit()
            .putBoolean("running", true)
            .putString("target", target)
            .putString("label", intent?.getStringExtra("label") ?: prefs.getString("label", "") ?: "")
            .putString("password", intent?.getStringExtra("password") ?: prefs.getString("password", "") ?: "")
            .putString("charId", intent?.getStringExtra("charId") ?: prefs.getString("charId", "") ?: "")
            .putString("charName", intent?.getStringExtra("charName") ?: prefs.getString("charName", "") ?: "")
            .putString("avatar", intent?.getStringExtra("avatar") ?: prefs.getString("avatar", "") ?: "")
            .putString("style", intent?.getStringExtra("style") ?: prefs.getString("style", "{}") ?: "{}")
            .apply()
        if (!polling) {
            polling = true
            startForegroundInternal()
            handler.postDelayed(poll, 1200)
        }
        return START_STICKY
    }

    private val poll = object : Runnable {
        override fun run() {
            if (!polling) return
            // 专注锁优先：专注期间不弹“小手段”，避免两套锁页抢焦点。
            val focus = FocusLockService.status(this@PlayfulAppLockService)
            if (focus.optBoolean("running") && focus.optLong("until") > System.currentTimeMillis()) {
                handler.postDelayed(this, 1500)
                return
            }
            val target = prefs.getString("target", "") ?: ""
            val fg = currentForegroundPackage()
            if (target.isNotBlank() && fg == target && System.currentTimeMillis() - lastShowAt > 12_000L) {
                lastShowAt = System.currentTimeMillis()
                runCatching {
                    startActivity(
                        Intent(this@PlayfulAppLockService, PlayfulLockActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            .putExtra(PlayfulLockActivity.EXTRA_TARGET, target)
                            .putExtra(PlayfulLockActivity.EXTRA_LABEL, prefs.getString("label", "") ?: "")
                            .putExtra(PlayfulLockActivity.EXTRA_CHAR_NAME, prefs.getString("charName", "") ?: "")
                            .putExtra(PlayfulLockActivity.EXTRA_AVATAR, prefs.getString("avatar", "") ?: "")
                            .putExtra(PlayfulLockActivity.EXTRA_STYLE, prefs.getString("style", "{}") ?: "{}")
                    )
                }
            }
            handler.postDelayed(this, 1500)
        }
    }

    private fun currentForegroundPackage(): String {
        return try {
            val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            val now = System.currentTimeMillis()
            val events = usm.queryEvents(now - 12_000L, now)
            var last = ""
            val ev = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                if (ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED) last = ev.packageName ?: ""
            }
            // 部分厂商（Honor/华为等）即使给了使用情况访问，queryEvents 也可能在
            // 应用停留一段时间后返回空。无障碍服务已经在维护 current_package，
            // 用它兜底，避免用户停在目标应用里时锁页永远不出现。
            if (last.isBlank()) {
                last = getSharedPreferences("native_background_perception", Context.MODE_PRIVATE)
                    .getString("current_package", "") ?: ""
            }
            last
        } catch (e: Throwable) { "" }
    }

    private fun startForegroundInternal() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "角色小手段", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val open = PendingIntent.getActivity(
            this, 31,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("TA 的小手段生效中")
                .setContentText("指定应用需要密码才能打开")
                .setContentIntent(open).setOngoing(true).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("TA 的小手段生效中")
                .setContentText("指定应用需要密码才能打开")
                .setContentIntent(open).setOngoing(true).build()
        }
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        polling = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        private const val PREFS = "playful_app_lock_v1"
        private const val CHANNEL = "playful_app_lock"
        private const val NOTIFICATION_ID = 4621

        fun start(context: Context, target: String, label: String, charId: String, charName: String, avatar: String, requestedPassword: String, styleJson: String = "{}"): JSONObject {
            if (target.isBlank()) return JSONObject().put("ok", false).put("reason", "没有选择应用")
            // 密码由原生生成，网页不接触明文；网页只在角色工具 gate 通过后调用 reveal。
            val password = requestedPassword.takeIf { it.trim().length >= 4 }
                ?: (100000 + (Math.random() * 900000).toInt()).toString()
            val intent = Intent(context, PlayfulAppLockService::class.java)
                .putExtra("target", target)
                .putExtra("label", label)
                .putExtra("charId", charId)
                .putExtra("charName", charName)
                .putExtra("avatar", avatar)
                .putExtra("password", password)
                .putExtra("style", styleJson)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
            else context.startService(intent)
            return JSONObject().put("ok", true)
        }

        fun stop(context: Context): JSONObject {
            context.startService(Intent(context, PlayfulAppLockService::class.java).putExtra("action", "stop"))
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("running", false).apply()
            return JSONObject().put("ok", true)
        }

        fun status(context: Context): JSONObject {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return JSONObject()
                .put("ok", true)
                .put("running", p.getBoolean("running", false))
                .put("target", p.getString("target", "") ?: "")
                .put("label", p.getString("label", "") ?: "")
                .put("charId", p.getString("charId", "") ?: "")
        }

        /** 只给受信任的网页角色工具调用；真正的“好感度高才告诉”由网页侧 gate。 */
        fun reveal(context: Context): String =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("password", "") ?: ""
    }
}
