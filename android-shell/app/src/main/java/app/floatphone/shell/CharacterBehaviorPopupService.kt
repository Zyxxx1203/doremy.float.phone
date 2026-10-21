package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Blocking character event popup. It intentionally has no close affordance:
 * the only in-UI exit is the explicit "return to phone" action.
 */
class CharacterBehaviorPopupService : Service() {
    private var windowManager: WindowManager? = null
    private var overlay: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForegroundNotification()
        if (intent?.getBooleanExtra(EXTRA_OPEN, false) == true) {
            openPhone()
            return START_NOT_STICKY
        }
        if (!android.provider.Settings.canDrawOverlays(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        showPopup(
            intent?.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { "TA" },
            intent?.getStringExtra(EXTRA_MESSAGE).orEmpty().ifBlank { "有件事想和你说。" },
        )
        return START_NOT_STICKY
    }

    private fun ensureForegroundNotification() {
        val channelId = "character_behavior_popup"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channelId, "角色主动消息", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "角色主动来找你时用于维持弹窗服务"
                    setShowBadge(false)
                },
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder.setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机")
            .setContentText("角色有话想对你说")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(9137, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(9137, notification)
        }
    }

    private fun showPopup(name: String, message: String) {
        if (overlay != null) return
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        windowManager = wm
        val root = FrameLayout(this).apply {
            setBackgroundColor(0x99000000.toInt())
            isFocusable = true
            isFocusableInTouchMode = true
            setOnKeyListener { _, keyCode, event ->
                keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP
            }
        }
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(26), dp(24), dp(22))
            background = GradientDrawable().apply {
                setColor(Color.rgb(255, 250, 246))
                cornerRadius = dp(24).toFloat()
                setStroke(dp(1), Color.rgb(222, 184, 173))
            }
        }
        val eyebrow = TextView(this).apply {
            text = "小手机 · 有话想对你说"
            textSize = 12f
            setTextColor(Color.rgb(155, 105, 100))
            gravity = Gravity.CENTER
        }
        val title = TextView(this).apply {
            text = name
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(76, 51, 48))
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, dp(12))
        }
        val body = TextView(this).apply {
            text = message.take(700)
            textSize = 16f
            setTextColor(Color.rgb(67, 57, 55))
            gravity = Gravity.CENTER
            setLineSpacing(dp(4).toFloat(), 1f)
        }
        val action = TextView(this).apply {
            text = "回到小手机"
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                setColor(Color.rgb(174, 105, 112))
                cornerRadius = dp(16).toFloat()
            }
            setPadding(dp(18), dp(14), dp(18), dp(14))
            setOnClickListener { openPhone() }
        }
        card.addView(eyebrow, LinearLayout.LayoutParams(-1, -2))
        card.addView(title, LinearLayout.LayoutParams(-1, -2))
        card.addView(body, LinearLayout.LayoutParams(-1, -2))
        card.addView(action, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(24) })
        root.addView(card, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER).apply {
            leftMargin = dp(26); rightMargin = dp(26)
        })
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            type,
            WindowManager.LayoutParams.FLAG_DIM_BEHIND,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.CENTER
            dimAmount = 0.58f
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
        }
        try {
            wm.addView(root, params)
            overlay = root
            root.requestFocus()
        } catch (_: Throwable) {
            stopSelf()
        }
    }

    private fun openPhone() {
        removeOverlay()
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(intent)
        stopSelf()
    }

    private fun removeOverlay() {
        val current = overlay
        overlay = null
        if (current != null) runCatching { windowManager?.removeView(current) }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        removeOverlay()
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_NAME = "behavior_name"
        private const val EXTRA_MESSAGE = "behavior_message"
        private const val EXTRA_OPEN = "behavior_open_phone"

        fun show(context: Context, name: String, message: String) {
            val intent = Intent(context, CharacterBehaviorPopupService::class.java).apply {
                putExtra(EXTRA_NAME, name.take(80))
                putExtra(EXTRA_MESSAGE, message.take(700))
            }
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
            }.onFailure {
                // A denied background-service start is surfaced by the caller's diagnostics.
            }
        }
    }
}
