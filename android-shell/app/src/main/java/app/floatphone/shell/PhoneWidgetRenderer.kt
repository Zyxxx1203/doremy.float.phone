package app.floatphone.shell

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import java.io.File
import java.io.FileOutputStream

/**
 * 桌面小组件的渲染器：把网页给来的 HTML 画成一张 PNG。
 *
 * 为什么由原生渲染而不是网页自己转图：
 *   网页侧 canvas.toDataURL 一旦遇到跨域图片就会污染画布直接失败；
 *   交给离屏 WebView 渲染没有这个限制，而且小手机完全关闭时，
 *   原生还能用上次缓存的 HTML 自己重画（系统定时刷新那条路）。
 *
 * 线程：@JavascriptInterface 方法由 WebView 的 JavaBridge 线程调用，
 * **不在主线程**——而 WebView 只能在主线程创建/操作，所以这里统一 post 回主线程。
 *
 * 尺寸：小组件通过 RemoteViews.setImageViewBitmap 更新，走 Binder 传输，
 * 单次上限约 1MB。所以渲染像素被 MAX_DIMEN 夹住，宁可略糊也不能超限
 * （超了会直接抛 TransactionTooLargeException，小组件显示不出来）。
 */
object PhoneWidgetRenderer {

    private const val PREFS = "shell_phone_widget"
    private const val KEY_HTML = "last_html"

    /** 渲染出的图片文件名。 */
    const val PNG_NAME = "phone_widget.png"

    /** 单边最大像素。约 1200×600 的 PNG 通常只有一两百 KB，离 1MB 上限很远。 */
    private const val MAX_DIMEN = 1200

    /** 页面加载完成后再等一小会儿才截图：字体、data URL 图片解码都需要一点时间。 */
    private const val DRAW_DELAY_MS = 160L

    /**
     * 不依赖 onPageFinished 的固定绘制时机（毫秒）。
     *
     * 为什么非要这样一个时机：实测反馈是诊断面板长时间停在「正在渲染」、PNG 永不落盘。
     * 根因是 **onPageFinished 并不保证会来**——模板里若引了 http(s) 图片，
     * 而我们为了不卡住设了 blockNetworkLoads=true，那张图就会一直保持 pending，
     * 浏览器因此认为页面「没加载完」，回调可能拖到资源超时甚至永不触发。
     * 而模板本身是**本地 HTML 字符串**，解析只要几毫秒，真正该等的只有字体与
     * data URL 图片的解码——400ms 足够画出成品。
     * 所以到点就画，不再把「出图」这件事押在那个回调上。
     */
    private const val FALLBACK_PAINT_MS = 400L

    /**
     * 最近一次渲染的结论。
     *
     * 为什么必须记：渲染失败原来一律静默（`runCatching {}` 把异常吞掉），
     * 桌面只会退回成应用图标——用户看到「加了个图标、模板没出来」，
     * 而我们从代码里看不出卡在哪一步，只能反复猜（实测已经来回好几轮）。
     * 把结论留在这里，由 diagnosticsJson 回给网页设置页。
     */
    @Volatile private var lastRenderAt: Long = 0L
    @Volatile private var lastRenderOk: Boolean = false
    @Volatile private var lastRenderError: String = ""
    /** 是否有一次渲染正在进行中：用来区分「还没跑过」和「跑了没结果」。 */
    @Volatile private var renderInFlight: Boolean = false

    /** 存下这次的 HTML，供系统定时刷新（onUpdate）时重画。 */
    fun saveHtml(context: Context, html: String) {
        runCatching {
            context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_HTML, html).apply()
        }
    }

    fun loadHtml(context: Context): String? = runCatching {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_HTML, null)
    }.getOrNull()

    fun pngFile(context: Context): File = File(context.applicationContext.filesDir, PNG_NAME)

    /**
     * 小组件的当前状态，给网页设置页的「检查状态」按钮用。
     *
     * 只如实回读，不做任何判断——卡在哪一步由用户看着数值判断（或转述给我们）。
     * 包含：有没有缓存 HTML、PNG 有没有落盘、多大、最后一次渲染是成功还是败在哪一句。
     */
    fun diagnosticsJson(context: Context): String = runCatching {
        val appContext = context.applicationContext
        val html = loadHtml(appContext)
        val file = pngFile(appContext)
        org.json.JSONObject()
            .put("hasHtml", html != null)
            .put("htmlChars", html?.length ?: 0)
            .put("pngExists", file.exists())
            .put("pngBytes", if (file.exists()) file.length() else 0L)
            .put("pngAt", if (file.exists()) file.lastModified() else 0L)
            .put("renderAt", lastRenderAt)
            .put("renderOk", lastRenderOk)
            .put("renderError", lastRenderError)
            .put("rendering", renderInFlight)
            .put("placed", PhoneWidgetProvider.isPlaced(appContext))
            .toString()
    }.getOrDefault("{}")

    /** 用当前缓存的 HTML 重画一次（系统定时刷新、或桌面需要重新贴图时）。 */
    fun renderCached(context: Context, widthDp: Int = 300, heightDp: Int = 150, scale: Int = 2) {
        val html = loadHtml(context) ?: return
        renderAndPush(context, html, widthDp, heightDp, scale)
    }

    /**
     * 渲染并刷新桌面。
     *
     * 立即返回：真正的渲染是异步的（要等 WebView 加载完）。
     * 网页把返回值当作「已受理」，不当作「已显示」——这是刻意的，
     * 因为渲染要走主线程 + 网络无关的本地 HTML，通常几十毫秒内完成。
     */
    fun renderAndPush(context: Context, html: String, widthDp: Int, heightDp: Int, scale: Int) {
        val appContext = context.applicationContext
        saveHtml(appContext, html)
        Handler(Looper.getMainLooper()).post {
            renderToFile(appContext, html, widthDp, heightDp, scale) {
                PhoneWidgetProvider.updateAll(appContext)
            }
        }
    }

    /**
     * 真正干活的渲染。必须在主线程调用。
     *
     * 失败时静默返回：小组件显示不出来是「少个装饰」，不该影响任何主流程。
     */
    private fun renderToFile(
        context: Context,
        html: String,
        widthDp: Int,
        heightDp: Int,
        scale: Int,
        onDone: () -> Unit,
    ) {
        val density = context.resources.displayMetrics.density
        // scale 的语义：2 = 按 dp×density 的「标准清晰度」渲染，
        // 1 = 减半（更小的文件），3 = 加 1.5 倍（更清晰，仍受 MAX_DIMEN 夹住）。
        val factor = (scale.coerceIn(1, 3) / 2f)
        val widthPx = (widthDp * density * factor).toInt().coerceIn(widthDp, MAX_DIMEN)
        val heightPx = (heightDp * density * factor).toInt().coerceIn(heightDp, MAX_DIMEN)

        renderInFlight = true
        lastRenderAt = System.currentTimeMillis()
        lastRenderOk = false
        lastRenderError = ""

        var webView: WebView? = null
        // 收尾只能走一次：onPageFinished 与超时兜底谁先到谁负责。
        // 不加这道锁的话两者都会销毁 WebView 并回调 onDone（桌面被重复刷新）。
        var settled = false
        val finish: (Boolean, String) -> Unit = { ok, error ->
            if (!settled) {
                settled = true
                lastRenderOk = ok
                lastRenderError = error
                renderInFlight = false
                runCatching { webView?.destroy() }
                onDone()
            }
        }
        try {
            webView = WebView(context).apply {
                setBackgroundColor(Color.TRANSPARENT)
                settings.javaScriptEnabled = false // 模板里的 <script> 不该运行
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true // 不联网：模板里的 http 图片不会加载，避免卡住
            }
            val view = webView
            // webViewClient 必须在 load 之前挂上。
            // 原来的顺序是先 load 再设回调：本地 HTML 字符串几乎瞬间加载完，
            // onPageFinished 会在回调挂上之前就触发，于是回调永远不来、
            // PNG 永远不落盘，桌面只能显示占位图——
            // 表现就是「加了小组件，显示出来却是个应用大图标」。
            // 绘制动作抽出来，给下面两条触发路径共用。
            // 异常必须**记下来**而不是吞掉：原来这里只有 runCatching，于是「画失败」
            // 与「画成功」在外部完全一样（桌面同样退回图标），从代码里根本看不出
            // 卡在哪一步——这也是这个问题来回好几轮的原因。
            val paint: () -> Unit = {
                val drawn = runCatching { drawToFile(context, view, widthPx, heightPx) }
                finish(
                    drawn.isSuccess,
                    drawn.exceptionOrNull()?.let { "${it.javaClass.simpleName}: ${it.message ?: ""}" } ?: "",
                )
            }
            view.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(v: WebView?, url: String?) {
                    v?.postDelayed({ paint() }, DRAW_DELAY_MS)
                }
            }
            // ── 绘制触发：两条路，谁先到谁画（settled 锁保证只画一次）──
            //   ① onPageFinished + 小延迟 —— 正常情况走这条，最快；
            //   ② 固定延迟兜底 —— **不等 onPageFinished**，理由见 FALLBACK_PAINT_MS。
            Handler(Looper.getMainLooper()).postDelayed({ paint() }, FALLBACK_PAINT_MS)
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        } catch (err: Throwable) {
            finish(false, "创建或加载离屏 WebView 失败：${err.javaClass.simpleName}: ${err.message ?: ""}")
        }
    }

    /** 把已经加载好的 WebView 画进 Bitmap 并落盘。 */
    private fun drawToFile(context: Context, view: WebView, widthPx: Int, heightPx: Int) {
        val bitmap = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, widthPx, heightPx)
        view.draw(canvas)

        FileOutputStream(pngFile(context)).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        bitmap.recycle()
    }
}
