package app.floatphone.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * 查岗预览浮层：角色「想看看你在干嘛」时，截一张屏**先给你过目**，
 * 你点头才发给它，你说不给这张图就当没存在过。
 *
 * 为什么必须是原生浮层，而不是系统通知：
 *   查岗要的就是「你不在小手机里」的时候——你正在别的 App 里忙。
 *   这时弹一条通知，你还得先点开小手机才能处理，等于把场景废掉了。
 *   浮层直接贴在你当前看的屏幕上，看一眼、点一下，不打断手上的事。
 *
 * 隐私设计（改这个文件前先读）：
 *  - **图只在本机内存里过一遍**：位图由 ScreenshotBridge 给出，在这里显示；
 *    你点「不给」→ 直接丢弃，这张图从未被编码成 base64、从未离开过这台设备。
 *    只有你点「给它看」才会编码并经网页交给角色。
 *  - **不做隐蔽截屏**：本服务只在网页明确要求时截一张；没有定时、没有监听，
 *    不响应任何「自动抓屏」。
 *  - **超时当作不给**：浮层晾着没人理（默认 90 秒）就自动关掉并回传「没给」，
 *    不把这张图永远挂在屏幕上等你。
 *
 * 为什么是「预热常驻」服务：
 *   Android 12+ 禁止 App 从后台启动前台服务，而查岗恰恰是后台触发的。
 *   所以由网页在**用户开启查岗时（App 在前台）**把服务暖起来常驻，
 *   真正要弹窗时只是显示一个已存在的窗口，不涉及「后台启动服务」。
 */
class CheckInService : Service() {

    companion object {
        private const val CH = "shell_check_in"
        private const val NOTIF_ID = 4

        private const val ACTION_PREPARE = "app.floatphone.shell.CHECKIN_PREPARE"
        private const val ACTION_SHOW = "app.floatphone.shell.CHECKIN_SHOW"
        private const val ACTION_STOP = "app.floatphone.shell.CHECKIN_STOP"

        private const val EXTRA_CHARACTER_ID = "character_id"
        private const val EXTRA_NAME = "name"
        private const val EXTRA_AVATAR = "avatar"
        private const val EXTRA_SOURCE = "source"

        /** 分享目标清单的落盘位置（网页推过来的，服务被系统重启也要还在）。 */
        private const val PREFS_SHARE = "screenshot_share_prefs"
        private const val KEY_SHARE_TARGETS = "targets"
        private const val KEY_SHARE_DEFAULT = "default_id"

        /** 角色发起：到点它想看看你在干嘛。 */
        const val SOURCE_CHECK_IN = "checkIn"
        /** 用户发起：你自己点悬浮球截的。 */
        const val SOURCE_USER = "user"

        /** 浮层晾着多久没处理就算「不给」。 */
        private const val AUTO_DISMISS_MS = 90_000L

        @Volatile
        private var running = false

        /**
         * 宿主 Activity 是否在前台。
         *
         * 查岗时用户多半正在别的 App 里，浮层应当直接可见；
         * 但若用户恰好在小手机里（前台），也照样弹——他刚点过测试按钮之类。
         * 这个标记留给需要区分的场景（例如后台启动服务的判断）。
         */
        @Volatile
        private var hostInForeground = true

        /** 正在运行的实例。同进程直改，绕开 Intent 时序竞态。 */
        @Volatile
        private var liveInstance: CheckInService? = null

        /** 浮窗权限是否已授予（与通话浮窗共用同一个系统权限）。 */
        fun canDraw(context: Context): Boolean =
            Build.VERSION.SDK_INT < 23 || android.provider.Settings.canDrawOverlays(context)

        /**
         * 预热服务。网页在用户开启查岗时（App 在前台）调用，把服务常驻起来。
         * 返回是否成功发起；失败原因与通话浮窗同源（多半是没给浮窗权限）。
         */
        fun prepare(context: Context): Boolean {
            if (!canDraw(context)) return false
            return runCatching {
                val intent = Intent(context, CheckInService::class.java).apply { action = ACTION_PREPARE }
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
                true
            }.getOrDefault(false)
        }

        /** 收掉服务（网页关闭全部查岗时调用）。 */
        fun stop(context: Context) {
            runCatching {
                context.startService(
                    Intent(context, CheckInService::class.java).apply { action = ACTION_STOP },
                )
            }
        }

        /**
         * 弹一次查岗预览：截当前屏 → 显示浮层 → 等用户决定。
         *
         * 结果经 ShellBus 的 'checkIn' 事件回推网页：
         *   {characterId, accepted:true, base64, width, height} 或 {characterId, accepted:false}
         */
        fun show(
            context: Context,
            characterId: String,
            name: String,
            avatar: String,
            source: String = SOURCE_CHECK_IN,
        ) {
            // 优先同进程直改：绕开 Android 12+ 对后台启动服务的限制，
            // 也免掉 Intent 投递的时序竞态。
            val instance = liveInstance
            if (instance != null) {
                instance.main.post { instance.showCheckIn(characterId, name, avatar, source) }
                return
            }
            if (!running) return
            runCatching {
                context.startService(
                    Intent(context, CheckInService::class.java).apply {
                        action = ACTION_SHOW
                        putExtra(EXTRA_CHARACTER_ID, characterId)
                        putExtra(EXTRA_NAME, name)
                        putExtra(EXTRA_AVATAR, avatar)
                        putExtra(EXTRA_SOURCE, source)
                    },
                )
            }
        }

        /** 宿主 Activity 进后台。 */
        fun onHostBackground() {
            hostInForeground = false
        }

        /** 宿主 Activity 回前台。 */
        fun onHostForeground() {
            hostInForeground = true
        }

        /** 服务是否在运行（设置面板显示「查岗待命中」用）。 */
        fun isRunning(): Boolean = running

        /**
         * 用户主动截屏（悬浮球发起）待取走的结果。
         *
         * 为什么不像查岗那样直接推事件：点球那一刻网页可能已被系统回收。
         * 查岗是网页自己发起的（它当然活着），而点球是原生侧发起的，
         * 网页在不在完全不确定。若只发事件，用户点了「发给它」却什么都没发生，
         * 那张图就白截了。所以先落这里，网页活着就立刻拉走，没活着等它下次挂载。
         *
         * 只存最近一条、只在本进程内存里：它是「刚才那张」，不是相册。
         */
        @Volatile
        private var pendingUserShot: String = ""

        /** 读走并清空用户主动截屏的结果（空串 = 没有待取）。 */
        fun consumePendingUserShot(): String {
            val value = pendingUserShot
            pendingUserShot = ""
            return value
        }

        /** 是否有待取的用户截屏结果（诊断面板用）。 */
        fun hasPendingUserShot(): Boolean = pendingUserShot.isNotEmpty()

        // ── 分享目标（用户主动截屏时「发给谁」）────────────────
        //
        // 由网页提前推过来存着，浮层直接读本地的：点球那一刻网页很可能
        // 已被系统回收，回网页现取只会拿到空清单，用户点开一片空白。
        // 清单只含角色 id 与名字——不含聊天内容、不含任何屏幕信息。
        //
        // 落 SharedPreferences 而不是只放内存：查岗服务可能被系统重启
        // （START_STICKY），重启后清单还得在，否则下次点球又没得选。

        /** 最近一次主动截屏实际发给了谁（诊断留痕用）。 */
        @Volatile
        private var lastShareTarget: String = ""

        /** 最近一次没能定下目标的原因（诊断留痕用，空 = 没出错）。 */
        @Volatile
        private var lastTargetReason: String = ""

        /** 网页推来的分享目标清单：{targets:[{id,name}], defaultId}。 */
        fun setShareTargets(context: Context, json: String): Boolean = runCatching {
            val parsed = JSONObject(json)
            // 存原文而不是解析后的对象：浮层与诊断读的是同一份，避免两处解析
            // 出现不一致。合法性在读取端按字段校验。
            context.getSharedPreferences(PREFS_SHARE, Context.MODE_PRIVATE).edit()
                .putString(KEY_SHARE_TARGETS, json)
                .putString(KEY_SHARE_DEFAULT, parsed.optString("defaultId", ""))
                .apply()
            true
        }.getOrDefault(false)

        /** 读分享目标原文（没推过时为空串）。 */
        private fun shareTargetsRaw(context: Context): String =
            context.getSharedPreferences(PREFS_SHARE, Context.MODE_PRIVATE)
                .getString(KEY_SHARE_TARGETS, "").orEmpty()

        /** 默认接收角色 id（空 = 每次都在浮层里选）。 */
        private fun shareDefaultId(context: Context): String =
            context.getSharedPreferences(PREFS_SHARE, Context.MODE_PRIVATE)
                .getString(KEY_SHARE_DEFAULT, "").orEmpty()

        /**
         * 解析目标清单。返回 (id → 名字) 的有序列表与默认 id。
         *
         * 刻意按「网页给什么就是什么」处理：id 或名字为空的项直接丢掉，
         * 不猜、不补默认名——浮层里出现一个点不动的空名字，只会让人困惑。
         */
        private fun parseShareTargets(context: Context): Pair<List<Pair<String, String>>, String> {
            val raw = shareTargetsRaw(context)
            if (raw.isBlank()) return Pair(emptyList(), "")
            return runCatching {
                val root = JSONObject(raw)
                val array = root.optJSONArray("targets") ?: JSONArray()
                val list = ArrayList<Pair<String, String>>()
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val id = item.optString("id", "").trim()
                    val name = item.optString("name", "").trim()
                    if (id.isEmpty() || name.isEmpty()) continue
                    list.add(Pair(id, name))
                }
                Pair(list, root.optString("defaultId", "").trim())
            }.getOrDefault(Pair(emptyList(), ""))
        }

        /**
         * 分享目标状态快照，给设置页的诊断面板读。
         *
         * 「点球没发出去」最常见的两种原因是「网页一次都没推过清单」和
         * 「设了默认角色但那个角色被删了」，这里把两者都摊开，省得用户
         * 只能描述成「点了没反应」。
         */
        fun shareTargetsJson(context: Context): String {
            val (list, defaultId) = parseShareTargets(context)
            val defaultName = list.firstOrNull { it.first == defaultId }?.second ?: ""
            return JSONObject()
                .put("count", list.size)
                .put("defaultId", defaultId)
                .put("defaultName", defaultName)
                .put("lastTargetName", lastShareTarget)
                .put("lastTargetReason", lastTargetReason)
                .toString()
        }

        /** 能力与状态快照，给设置面板显示三态。 */
        fun capabilitiesJson(): String = JSONObject()
            .put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            .put("accessibilityOn", ScreenshotBridge.isAccessibilityOn())
            .put("canDraw", liveInstance != null || running)
            .toString()

        // ── 诊断留痕 ────────────────────────────────────────
        //
        // 「该弹没弹」是浮层类功能最难查的故障。它可能卡在四道关：权限没给 →
        // 服务没起来 → 窗口没挂上 → 截图失败。没有留痕，用户只能描述成
        // 「没反应」，排查全靠猜。这里把每一道关的结果记下来。
        //
        // 只记状态与原因，**绝不记画面内容**。

        /** 最近一次失败描述（空串 = 没记到失败）。 */
        @Volatile
        private var lastError: String = ""

        /** 最近一次弹出浮层的时刻；0 = 从未弹过。 */
        @Volatile
        private var lastShowAt: Long = 0L

        /** 累计弹出次数。 */
        @Volatile
        private var showCount: Int = 0

        private fun recordError(where: String, error: Throwable) {
            lastError = "$where: ${error.javaClass.simpleName}: ${error.message}"
        }

        private fun recordError(where: String, reason: String) {
            lastError = "$where: $reason"
        }

        /**
         * 浮层内部状态快照，给设置页的「诊断」面板读。
         *
         * 排查顺序与状态一一对应：
         *   canDraw false      → 权限没给，系统不允许画浮层（最先要看的）
         *   running false      → 服务没起来（多半是开启时 App 不在前台，被系统拒了）
         *   hasInstance false  → 服务在跑但没有实例
         *   windowAdded false  → 窗口没挂上（见 lastError）
         */
        fun diagnosticsJson(context: Context): String {
            val instance = liveInstance
            return runCatching {
                JSONObject()
                    .put("canDraw", canDraw(context))
                    .put("running", running)
                    .put("hostInForeground", hostInForeground)
                    .put("hasInstance", instance != null)
                    .put("windowAdded", instance?.rootView != null)
                    .put("windowVisible", instance?.rootView?.visibility == View.VISIBLE)
                    .put("awaitingDecision", instance?.pendingBitmap != null)
                    .put("lastError", lastError)
                    .put("lastShowAt", lastShowAt)
                    .put("showCount", showCount)
                    // 分享目标几项：点球之后「什么都没发生」多半卡在这里
                    .put("shareTargetCount", parseShareTargets(context).first.size)
                    .put("shareDefaultName", parseShareTargets(context).let { (list, id) ->
                        list.firstOrNull { it.first == id }?.second ?: ""
                    })
                    .put("lastShareTarget", lastShareTarget)
                    .put("screenshot", JSONObject(ScreenshotBridge.diagnosticsJson()))
                    .toString()
            }.getOrDefault("{}")
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var windowManager: WindowManager

    private var rootView: View? = null
    private var previewView: ImageView? = null
    private var titleView: TextView? = null
    /** 浮层里的回复框：用户可以在决定给不给看的同时说一句话。 */
    private var replyInput: EditText? = null
    /** 两个决策按钮。文案随来源变（角色查岗 vs 你主动截），所以要留引用。 */
    private var acceptButton: Button? = null
    private var rejectButton: Button? = null

    /**
     * 这一张是谁要的。
     *
     * checkIn = 角色发起（「TA 想看看你在干嘛」）；
     * user    = 你主动点悬浮球截的（「发给 TA 看看」）。
     * 两者走同一套预览与审批，只有措辞不同——用户看到的操作是一样的，
     * 没必要写两套窗口代码。
     */
    private var captureSource: String = SOURCE_CHECK_IN

    /**
     * 用户主动截屏时的收件人选择：一行胶囊，选中的那个高亮。
     *
     * 只在这一种情况下显示：来源是「用户点的」且没设默认角色。
     * 设了默认角色就直接锁定它——那正是用户要求「不用弹选择窗口」的场景。
     */
    private var targetRow: android.widget.HorizontalScrollView? = null
    private var targetList: LinearLayout? = null
    /** 当前选中的角色 id；空 = 还没选（此时不能发）。 */
    private var selectedTargetId = ""
    /** 窗口参数。要在「可输入 / 不可输入」之间切换，所以留一份引用。 */
    private var layoutParams: WindowManager.LayoutParams? = null

    /** 当前这一张的上下文；用户点按钮时要用它回传与关窗。 */
    private var pendingCharacterId = ""
    private var pendingBitmap: Bitmap? = null
    private var dismissRunnable: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createChannel()
        startForeground(NOTIF_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREPARE -> {
                // 只把服务暖起来常驻，不建窗口。窗口留到真要查岗时再建，
                // 免得用户开一次查岗就凭空多出一个空浮层。
                running = true
                liveInstance = this
            }
            ACTION_SHOW -> {
                running = true
                liveInstance = this
                val characterId = intent.getStringExtra(EXTRA_CHARACTER_ID).orEmpty()
                val name = intent.getStringExtra(EXTRA_NAME).orEmpty()
                val avatar = intent.getStringExtra(EXTRA_AVATAR).orEmpty()
                val source = intent.getStringExtra(EXTRA_SOURCE).orEmpty().ifBlank { SOURCE_CHECK_IN }
                main.post { showCheckIn(characterId, name, avatar, source) }
            }
            ACTION_STOP -> {
                teardown()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    /**
     * 截一张屏并弹浮层给用户过目。
     *
     * 关键：**先把窗口建出来（显示「正在看…」），再异步等截图**——
     * takeScreenshot 是回调式的，几毫秒到几百毫秒不等；这段时间里用户
     * 完全不知道发生了什么。先给个「正在截屏」的即时反馈，体感才不突兀。
     */
    private fun showCheckIn(
        characterId: String,
        name: String,
        avatar: String,
        source: String = SOURCE_CHECK_IN,
    ) {
        lastShowAt = System.currentTimeMillis()
        showCount += 1
        captureSource = source
        pendingCharacterId = characterId
        pendingBitmap?.recycle()
        pendingBitmap = null

        // 先把浮层立起来（预览位置显示占位文字），再等图
        ensureWindow()
        val userInitiated = source == SOURCE_USER
        // 收件人只在「你自己点的」这条路上有意义：角色查岗的收件人就是它本人，
        // 传进来的 name/characterId 已经是答案。
        val shareName = if (userInitiated) prepareShareTargets() else ""
        val who = if (userInitiated) (shareName.ifBlank { "选一个" }) else name.ifBlank { "TA" }
        titleView?.text = if (userInitiated) "发给 $who 看看" else "$who 想看看你在干嘛…"
        // 文案随来源变，但两条路走的是同一套预览与审批——用户看到的行为完全一致。
        acceptButton?.text = if (userInitiated) "发给它" else "给它看"
        rejectButton?.text = if (userInitiated) "算了" else "不给"
        replyInput?.hint = "顺便说一句（可选）"
        previewView?.setImageDrawable(null)
        previewView?.scaleType = ImageView.ScaleType.CENTER
        showWindow(true)
        cancelAutoDismiss()

        ScreenshotBridge.captureBitmap { bitmap, error ->
            main.post {
                if (bitmap == null) {
                    // 截不到图就直接如实收场：不弹一张没有内容的浮层让用户干等
                    val reason = error ?: "截屏失败"
                    recordError("capture", reason)
                    publishResult(accepted = false, reason = reason, reply = consumeReplyText())
                    hideWindow()
                    return@post
                }
                pendingBitmap = bitmap
                renderPreview(bitmap)
                scheduleAutoDismiss()
            }
        }
    }

    /**
     * 准备「发给谁」这一行，并把选定结果记进 selectedTargetId。
     *
     * 三种情况：
     *   ① 设了默认角色且它还在清单里 → 不显示选择行，直接锁定它（用户要的就是不弹窗）；
     *   ② 没设默认、清单里有人 → 显示一行胶囊，**不预选**。刻意不代选第一个：
     *      手滑一下就把屏幕发给不相干的人，比多点一下难受得多；
     *   ③ 清单空（网页从没推过）→ 不显示行，也不静默失败，如实记下原因，
     *      由网页侧在补发时给出「还没有可选角色」的提示。
     *
     * @return 锁定的收件人名（空 = 还没定，需要用户点一下）
     */
    private fun prepareShareTargets(): String {
        val (list, defaultId) = parseShareTargets(this)
        selectedTargetId = ""
        lastTargetReason = ""

        val row = targetRow ?: return "".also { replyInput?.hint = "顺便说一句（可选）" }
        targetList?.removeAllViews()

        if (list.isEmpty()) {
            row.visibility = View.GONE
            lastTargetReason = "没有可选的收件人（网页还没推送角色清单）"
            return ""
        }

        val defaultName = list.firstOrNull { it.first == defaultId }?.second.orEmpty()
        if (defaultName.isNotEmpty()) {
            // ① 有默认角色：直接锁定，不显示选择行
            selectedTargetId = defaultId
            row.visibility = View.GONE
            return defaultName
        }

        // ② 让用户点一个
        row.visibility = View.VISIBLE
        for ((id, itemName) in list) {
            val chip = TextView(this).apply {
                tag = id
                text = itemName
                setTextColor(0xFFC9D1E0.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(6), dp(12), dp(6))
                background = GradientDrawable().apply {
                    cornerRadius = dp(14).toFloat()
                    setColor(0xFF2A2A33.toInt())
                }
                isClickable = true
                setOnClickListener { selectTarget(id) }
            }
            targetList?.addView(
                chip,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { rightMargin = dp(6) },
            )
        }
        return ""
    }

    /** 用户点了一个收件人：高亮它，并把标题改成「发给 XX 看看」。 */
    private fun selectTarget(id: String) {
        selectedTargetId = id
        val list = targetList ?: return
        for (i in 0 until list.childCount) {
            val child = list.getChildAt(i)
            val selected = child.tag == id
            (child.background as? GradientDrawable)?.setColor(
                if (selected) 0xFF5B7CFA.toInt() else 0xFF2A2A33.toInt(),
            )
            (child as? TextView)?.setTextColor(
                if (selected) Color.WHITE else 0xFFC9D1E0.toInt(),
            )
        }
        val name = (0 until list.childCount)
            .mapNotNull { list.getChildAt(it) as? TextView }
            .firstOrNull { it.tag == id }?.text?.toString().orEmpty()
        if (name.isNotEmpty()) titleView?.text = "发给 $name 看看"
    }

    /** 把位图画进预览位。 */
    private fun renderPreview(bitmap: Bitmap) {
        val view = previewView ?: return
        view.scaleType = ImageView.ScaleType.FIT_CENTER
        view.setImageBitmap(bitmap)
    }

    // ── 用户决定 ──

    /**
     * 用户点了「给它看」：把图编码成 base64 回传网页。
     *
     * 只有走到这里，这张图才会变成 base64 —— 那条「不给」的路径上，
     * 位图从头到尾没离开过内存，也就无所谓「删不删」。
     */
    private fun acceptCheckIn() {
        val bitmap = pendingBitmap
        val reply = consumeReplyText()
        // 用户主动截屏这条路上，收件人是**刚才选的**，不是进 showCheckIn 时传的
        // （那时传的本来就是空串）。没选就不发——静默发错人比多发一次选择难受得多。
        val userInitiated = captureSource == SOURCE_USER
        if (userInitiated && selectedTargetId.isEmpty()) {
            lastTargetReason = "还没有选择发给谁"
            android.widget.Toast.makeText(this, "先点一下发给谁", android.widget.Toast.LENGTH_SHORT).show()
            // 回复框里的话已经被 consume 掉了，放回去，别让用户白打一遍
            if (reply.isNotEmpty()) replyInput?.setText(reply)
            return
        }
        val characterId = if (userInitiated) selectedTargetId else pendingCharacterId
        lastShareTarget = resolveTargetName(characterId)
        if (bitmap == null) {
            publishResult(accepted = false, reason = "还没有截到画面", reply = reply)
            discardPending()
            hideWindow()
            return
        }
        val payload = runCatching {
            val png = ByteArrayOutputStream()
            val bytes = try {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)
                png.toByteArray()
            } finally {
                runCatching { png.close() }
            }
            JSONObject()
                .put("characterId", characterId)
                .put("accepted", true)
                .put("width", bitmap.width)
                .put("height", bitmap.height)
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .also { if (reply.isNotEmpty()) it.put("reply", reply) }
        }.getOrElse {
            JSONObject()
                .put("characterId", characterId)
                .put("accepted", false)
                .put("reason", "这张图没能处理成功")
                .also { if (reply.isNotEmpty()) it.put("reply", reply) }
        }
        // 用户主动截的（悬浮球）另存一份再推事件：
        // 此刻网页可能已被回收，事件会落空，图就丢了。查岗不需要这一步——
        // 那次请求本来就是网页发起的，它必然活着。
        if (captureSource == SOURCE_USER && payload.optBoolean("accepted")) {
            pendingUserShot = payload.toString()
            lastTargetReason = ""
        } else if (captureSource == SOURCE_USER) {
            // 用户主动截屏但没成：把原因留痕，诊断面板能看出是「没选收件人」
            // 还是「图没处理成功」，而不是笼统一句「点了没反应」。
            lastTargetReason = payload.optString("reason", "")
        }
        ShellBus.dispatchOverlayEvent("checkIn", payload)
        discardPending()
        hideWindow()
    }

    /**
     * 用户点了「不给」（或浮层超时没人理）：直接丢弃这张图。
     *
     * 这里是「拒绝即删除」的落点：recycle 掉位图、清掉引用，
     * 然后才回传「没给」。用户得到的保证是机制性的，不是口头承诺。
     */
    private fun rejectCheckIn() {
        // 即使选「不给看」，用户在回复框里打下的话也不该被吞掉——
        // 那句话是他主动说的，和屏幕内容无关，照常带回去。
        publishResult(accepted = false, reply = consumeReplyText())
        // 用户主动截屏但点「算了」：这是明确的选择，不是故障，记一句话即可。
        // 若不记，诊断面板里「算了」和「点球没反应」会长得一模一样。
        if (captureSource == SOURCE_USER) lastTargetReason = "这次选了不发给它"
        discardPending()
        hideWindow()
    }

    /** 收件人 id → 名字（诊断留痕里给人看；已经不在清单里就报 id）。 */
    private fun resolveTargetName(characterId: String): String {
        if (characterId.isEmpty()) return ""
        val (list, _) = parseShareTargets(this)
        return list.firstOrNull { it.first == characterId }?.second ?: characterId
    }

    /** 取走回复框里的文字并清空（同意/拒绝各取一次，不重复带）。 */
    private fun consumeReplyText(): String {
        val text = replyInput?.text?.toString()?.trim().orEmpty()
        replyInput?.setText("")
        return text
    }

    /** 丢弃待处理位图（同意/拒绝/超时都走它）。 */
    private fun discardPending() {
        cancelAutoDismiss()
        pendingBitmap?.let { runCatching { it.recycle() } }
        pendingBitmap = null
        pendingCharacterId = ""
        selectedTargetId = ""
        targetRow?.visibility = View.GONE
        targetList?.removeAllViews()
        previewView?.setImageDrawable(null)
    }

    private fun publishResult(accepted: Boolean, reason: String? = null, reply: String = "") {
        // 收件人：用户主动截屏那条路上 pendingCharacterId 是空的，实际收件人
        // 记在 selectedTargetId 里（浮层当场选的或默认角色），这里一并带上，
        // 网页据此决定发给谁——老壳不带这个字段，网页会退回「最近会话」。
        val target = if (captureSource == SOURCE_USER) selectedTargetId else pendingCharacterId
        val payload = JSONObject()
            .put("characterId", target)
            .put("accepted", accepted)
        if (!accepted && !reason.isNullOrBlank()) payload.put("reason", reason)
        if (reply.isNotEmpty()) payload.put("reply", reply)
        ShellBus.dispatchOverlayEvent("checkIn", payload)
    }

    private fun scheduleAutoDismiss() {
        cancelAutoDismiss()
        val runnable = Runnable {
            // 晾着没人理 → 当作「不给」，但带一句原因，网页侧可区分。
            // 超时这条路上回复框里可能有半句话（用户打了没发就锁屏了），
            // 一并带回去——总比默默丢掉强。
            publishResult(accepted = false, reason = "timeout", reply = consumeReplyText())
            discardPending()
            hideWindow()
        }
        dismissRunnable = runnable
        main.postDelayed(runnable, AUTO_DISMISS_MS)
    }

    private fun cancelAutoDismiss() {
        dismissRunnable?.let { main.removeCallbacks(it) }
        dismissRunnable = null
    }

    // ── 浮层窗口 ──

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /** 建窗口（只建一次，之后复用）。 */
    private fun ensureWindow() {
        if (rootView != null) return
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(12))
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(0xF21B1B22.toInt())
            }
        }

        titleView = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 2
            text = "想看看你在干嘛…"
        }
        container.addView(
            titleView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) },
        )

        val previewWrap = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat()
                setColor(0xFF2A2A33.toInt())
            }
        }
        previewView = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        previewWrap.addView(
            previewView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        container.addView(
            previewWrap,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(280),
            ).apply { bottomMargin = dp(12) },
        )

        // 收件人选择行：只有「你自己点的球」且没设默认角色时才显示。
        // 放在预览与回复框之间——先看截到了什么，再决定给谁。
        targetRow = android.widget.HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            visibility = View.GONE
        }
        targetList = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        (targetRow as android.widget.HorizontalScrollView).addView(targetList)
        container.addView(
            targetRow,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(8) },
        )

        // 回复框。用户在别的 App 里多半正忙着，所以这一栏刻意标成「可选」：
        // 想说话就打一句，不想说直接点下面的按钮。
        replyInput = EditText(this).apply {
            hint = "顺便说一句（可选）"
            setHintTextColor(0xFF8A93A6.toInt())
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            maxLines = 3
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF2A2A33.toInt())
            }
            setPadding(dp(10), dp(8), dp(10), dp(8))
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, _ ->
                // 输入框里按回车 = 看图并发送（与「给它看」同一动作，顺手而已）
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    acceptCheckIn()
                    true
                } else false
            }
            // 点一下才把窗口切成可输入：浮层默认不抢焦点，
            // 免得用户正在别的 App 里打字时被我们半路截走键盘。
            setOnClickListener { enableTyping() }
            setOnFocusChangeListener { _, hasFocus -> if (hasFocus) enableTyping() }
        }
        container.addView(
            replyInput,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) },
        )

        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        val rejectBtn = Button(this).apply {
            text = "不给"
            setTextColor(0xFFC9D1E0.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF33333D.toInt())
            }
            setOnClickListener { rejectCheckIn() }
        }
        rejectButton = rejectBtn
        val acceptBtn = Button(this).apply {
            text = "给它看"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF5B7CFA.toInt())
            }
            setOnClickListener { acceptCheckIn() }
        }
        acceptButton = acceptBtn
        buttonRow.addView(
            rejectBtn,
            LinearLayout.LayoutParams(dp(88), LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(8) },
        )
        buttonRow.addView(
            acceptBtn,
            LinearLayout.LayoutParams(dp(96), LinearLayout.LayoutParams.WRAP_CONTENT),
        )
        container.addView(
            buttonRow,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        rootView = container
    }

    /** 把窗口挂上/取下。首次 addView，之后只改可见性。 */
    private fun showWindow(visible: Boolean) {
        val view = rootView ?: return
        if (visible) {
            if (view.parent == null) {
                val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                } else {
                    @Suppress("DEPRECATION")
                    WindowManager.LayoutParams.TYPE_PHONE
                }
                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    type,
                    // NOT_FOCUSABLE：默认不抢你正在用的 App 的输入焦点（你还能继续打字）；
                    // FLAG_LAYOUT_IN_SCREEN 让它能盖到状态栏区域，居中显示。
                    // 用户点了回复框之后会临时去掉 NOT_FOCUSABLE，见 enableTyping()。
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    android.graphics.PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.CENTER
                    val edge = dp(20)
                    width = resources.displayMetrics.widthPixels - edge * 2
                }
                layoutParams = params
                runCatching { windowManager.addView(view, params) }
                    .onFailure { recordError("addView", it) }
            } else {
                view.visibility = View.VISIBLE
            }
        } else {
            view.visibility = View.GONE
        }
    }

    /**
     * 把浮层切成「可输入」：去掉 NOT_FOCUSABLE 并唤起键盘。
     *
     * 为什么不在建窗口时就允许输入：那会让浮层一出现就抢走键盘焦点——
     * 用户可能正在别的 App 里打一句话，被我们半路截走，非常讨厌。
     * 只有他主动点了回复框，才把焦点切过来。
     */
    private fun enableTyping() {
        val view = rootView ?: return
        val params = layoutParams ?: return
        if (params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE == 0) {
            // 已经是可输入状态，只需把键盘叫出来
            main.post { showIme() }
            return
        }
        params.flags = params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
        params.flags = params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
            WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE
        main.post {
            runCatching { windowManager.updateViewLayout(view, params) }
            replyInput?.requestFocus()
            showIme()
        }
    }

    private fun showIme() {
        val target = replyInput ?: return
        runCatching {
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.showSoftInput(target, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun hideWindow() {
        rootView?.let { view ->
            if (view.parent != null) runCatching { windowManager.removeView(view) }
        }
        // 窗口连同视图一起丢掉：下次查岗重建，避免残留上一张的预览
        previewView = null
        titleView = null
        replyInput = null
        layoutParams = null
        rootView = null
    }

    // ── 通知与清理 ──

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        runCatching {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CH, "查岗待命", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "角色查岗时在其他应用上层显示确认浮层"
                    setShowBadge(false)
                },
            )
        }
    }

    /**
     * 常驻通知。刻意做成 IMPORTANCE_MIN 的静默通知：
     * 它只是前台服务的「载体」，查岗这件事本身用浮层告知，
     * 不该再在通知栏刷存在感（那正是我们要避开的打扰）。
     */
    private fun buildNotification(): android.app.Notification {
        val open = PendingIntent.getActivity(
            this, 81,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("小手机")
            .setContentText("查岗待命：角色想看你时会先弹窗让你决定")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    private fun teardown() {
        running = false
        if (liveInstance === this) liveInstance = null
        discardPending()
        hideWindow()
        stopForeground(true)
        stopSelf()
    }
}
