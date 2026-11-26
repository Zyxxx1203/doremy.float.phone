package app.floatphone.shell

import android.app.Activity
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.text.InputType
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/** 角色小手段的锁页：只做密码输入，不做聊天。 */
class PlayfulLockActivity : Activity() {
    private var input: EditText? = null
    private var errorText: TextView? = null
    private var target = ""
    private lateinit var prefs: android.content.SharedPreferences
    private var styleObj = JSONObject()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        prefs = getSharedPreferences("playful_app_lock_v1", MODE_PRIVATE)
        target = intent.getStringExtra(EXTRA_TARGET) ?: prefs.getString("target", "") ?: ""
        val label = intent.getStringExtra(EXTRA_LABEL) ?: prefs.getString("label", "") ?: target
        val charName = intent.getStringExtra(EXTRA_CHAR_NAME) ?: prefs.getString("charName", "") ?: "TA"
        styleObj = runCatching {
            JSONObject(intent.getStringExtra(EXTRA_STYLE) ?: prefs.getString("style", "{}") ?: "{}")
        }.getOrElse { JSONObject() }
        buildUi(label, charName)
    }

    private fun buildUi(label: String, charName: String) {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(36), dp(24), dp(36))
            val backgroundBitmap = decodeImage(styleObj.optString("background", ""))
            if (backgroundBitmap != null) {
                background = android.graphics.drawable.LayerDrawable(
                    arrayOf(
                        BitmapDrawable(resources, backgroundBitmap).apply { gravity = Gravity.FILL },
                        android.graphics.drawable.ColorDrawable(0x99000000.toInt()),
                    ),
                )
            } else {
                background = GradientDrawable().apply {
                    colors = intArrayOf(0xFF0F1220.toInt(), 0xFF1D2438.toInt())
                    orientation = GradientDrawable.Orientation.TL_BR
                }
            }
        }
        val showAvatar = styleObj.optBoolean("showAvatar", true)
        val avatarRaw = styleObj.optString("avatar", "").ifBlank {
            intent.getStringExtra(EXTRA_AVATAR) ?: ""
        }
        val avatarBitmap = if (showAvatar) decodeImage(avatarRaw) else null
        if (avatarBitmap != null) {
            root.addView(ImageView(this).apply {
                setImageBitmap(avatarBitmap)
                scaleType = ImageView.ScaleType.CENTER_CROP
                outlineProvider = object : android.view.ViewOutlineProvider() {
                    override fun getOutline(view: android.view.View, outline: android.graphics.Outline) {
                        outline.setOval(0, 0, view.width, view.height)
                    }
                }
                clipToOutline = true
            }, LinearLayout.LayoutParams(dp(84), dp(84)))
        } else if (showAvatar) {
            root.addView(TextView(this).apply {
                text = "🔒"
                textSize = 42f
                gravity = Gravity.CENTER
            })
        }
        if (styleObj.optBoolean("showTitle", true)) {
            root.addView(TextView(this).apply {
                text = styleObj.optString("title", "").trim().ifBlank { "$charName 把门锁上了" }
                setTextColor(Color.WHITE)
                textSize = 24f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, dp(6))
            })
        }
        if (styleObj.optBoolean("showSubtitle", true)) {
            root.addView(TextView(this).apply {
                text = styleObj.optString("subtitle", "").trim().ifBlank {
                    "「$label」现在需要 TA 才知道的密码。\n想打开，就去 Float 找 TA 聊聊。"
                }
                setTextColor(0xFFAAB6CF.toInt())
                textSize = 13f
                gravity = Gravity.CENTER
                setLineSpacing(dp(3).toFloat(), 1f)
                setPadding(0, 0, 0, dp(24))
            })
        }
        input = EditText(this).apply {
            hint = "输入密码"
            setTextColor(Color.WHITE)
            setHintTextColor(0xFF77839A.toInt())
            textSize = 20f
            gravity = Gravity.CENTER
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(0xCC20283A.toInt())
                setStroke(dp(1), 0x55FFFFFF)
            }
            setPadding(dp(16), dp(14), dp(16), dp(14))
        }
        root.addView(
            input,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )
        errorText = TextView(this).apply {
            text = ""
            setTextColor(0xFFFF8A9A.toInt())
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, 0)
        }
        root.addView(errorText)
        root.addView(Button(this).apply {
            text = "解锁"
            setTextColor(Color.WHITE)
            textSize = 15f
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(0xFF6D7CFF.toInt())
            }
            setOnClickListener { tryUnlock() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)).apply { topMargin = dp(12) })
        if (styleObj.optBoolean("showFloatButton", true)) root.addView(Button(this).apply {
            text = "去 Float 找 TA"
            setTextColor(0xFFD8DFF2.toInt())
            textSize = 14f
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(0x222C3650)
                setStroke(dp(1), 0x55FFFFFF)
            }
            setOnClickListener {
                startActivity(
                    Intent(this@PlayfulLockActivity, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                )
                finish()
            }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(10) })
        setContentView(root)
        input?.requestFocus()
    }

    private fun tryUnlock() {
        val expected = prefs.getString("password", "") ?: ""
        val entered = input?.text?.toString()?.trim().orEmpty()
        if (entered.isNotEmpty() && entered == expected) {
            PlayfulAppLockService.stop(this)
            Toast.makeText(this, "门开了。", Toast.LENGTH_SHORT).show()
            finish()
        } else {
            input?.setText("")
            errorText?.text = "密码不对。再去 Float 问问 TA。"
            input?.animate()?.translationX(18f)?.setDuration(60)?.withEndAction {
                input?.animate()?.translationX(-18f)?.setDuration(60)?.withEndAction {
                    input?.animate()?.translationX(0f)?.setDuration(60)?.start()
                }?.start()
            }?.start()
            Toast.makeText(this, "密码不对", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onBackPressed() {
        // 允许离开锁页；目标应用再次回到前台时还会被拦。
        finish()
    }

    private fun decodeImage(raw: String): android.graphics.Bitmap? {
        val value = raw.trim()
        if (value.isBlank()) return null
        return runCatching {
            if (value.startsWith("data:image") && value.contains(",")) {
                val bytes = Base64.decode(value.substringAfter(","), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            } else if (value.startsWith("/")) {
                BitmapFactory.decodeFile(value)
            } else null
        }.getOrNull()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_TARGET = "target"
        const val EXTRA_LABEL = "label"
        const val EXTRA_CHAR_NAME = "char_name"
        const val EXTRA_AVATAR = "avatar"
        const val EXTRA_STYLE = "style"
        @Volatile private var current: PlayfulLockActivity? = null
        fun dismissCurrent() { current?.finish() }
    }

    override fun onResume() {
        super.onResume()
        current = this
    }

    override fun onDestroy() {
        if (current === this) current = null
        super.onDestroy()
    }
}
