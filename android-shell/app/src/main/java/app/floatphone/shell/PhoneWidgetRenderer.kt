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

        var webView: WebView? = null
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
            view.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    view?.postDelayed({
                        runCatching { drawToFile(context, view, widthPx, heightPx) }
                        runCatching { view?.destroy() }
                        onDone()
                    }, DRAW_DELAY_MS)
                }
            }
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        } catch (err: Throwable) {
            runCatching { webView?.destroy() }
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
