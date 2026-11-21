package app.floatphone.shell

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.widget.RemoteViews

/**
 * FocusWidgetProvider — 专注倒计时桌面小组件（原生 RemoteViews，v1）。
 *
 * 与 PhoneWidgetProvider（HTML→离屏 WebView→Bitmap→ImageView）不同：
 * 本组件用 **原生 RemoteViews 布局**，核心是 Chronometer 的
 * setChronometerCountDown（API 24+）—— 系统自己每秒走表，**不需要网页每秒推送**。
 * 网页只在「会话事件」时推一次状态（开始/换阶段/完成任务/暂停/结束），
 * 组件即持续动态倒计时 —— 这就是「动态 widget」的正确实现。
 *
 * 多实例：与 PhoneWidgetProvider 同一套 widgetId→state 的映射思路。
 * 专注会话同一时刻只有一场，多个桌面实例是同一份状态的镜像（互相一致）。
 */
class FocusWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) push(context, manager, id)
    }

    override fun onDeleted(context: Context, ids: IntArray) { /* 状态是全局一份，无需按 id 清理 */ }

    companion object {
        private const val PREFS = "focus_widget_v1"

        private fun prefs(context: Context) =
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /** 网页推送一份会话状态并刷新所有专注小组件实例。
         *  json: {running:boolean, remainingMs:long, progress:int, task:String, ta:String, charName:String} */
        fun update(context: Context, json: String): Boolean = runCatching {
            val p = prefs(context)
            val obj = org.json.JSONObject(json)
            p.edit()
                .putBoolean("running", obj.optBoolean("running", false))
                .putLong("remainingMs", obj.optLong("remainingMs", 0))
                .putLong("updateElapsed", SystemClock.elapsedRealtime())
                .putInt("progress", obj.optInt("progress", 0).coerceIn(0, 100))
                .putString("task", obj.optString("task", ""))
                .putString("ta", obj.optString("ta", ""))
                .putString("charName", obj.optString("charName", ""))
                .apply()
            pushAll(context)
            true
        }.getOrDefault(false)

        /** 移除小组件（清状态即可，实例由桌面管理）。 */
        fun remove(context: Context): Boolean {
            prefs(context).edit().clear().apply()
            pushAll(context)
            return true
        }

        /** 拉起系统的「添加到桌面」引导（Android 8+）。 */
        fun requestPin(context: Context): Boolean = runCatching {
            val manager = AppWidgetManager.getInstance(context)
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O || !manager.isRequestPinAppWidgetSupported) return false
            manager.requestPinAppWidget(ComponentName(context, FocusWidgetProvider::class.java), null, null)
        }.getOrDefault(false)

        /** 重算剩余毫秒：以 elapsedRealtime 为基准 —— 用户改系统时间不影响倒计时。 */
        private fun remainingNow(context: Context): Long {
            val p = prefs(context)
            if (!p.getBoolean("running", false)) return 0
            val elapsed = SystemClock.elapsedRealtime()
            val left = p.getLong("remainingMs", 0) - (elapsed - p.getLong("updateElapsed", elapsed))
            return if (left > 0) left else 0
        }

        private fun fmt(ms: Long): String {
            val total = (ms / 1000L).toInt()
            val h = total / 3600
            val m = (total % 3600) / 60
            val sec = total % 60
            return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%02d:%02d".format(m, sec)
        }

        /** 构建 RemoteViews 并推给指定实例。 */
        private fun push(context: Context, manager: AppWidgetManager, id: Int) {
            val p = prefs(context)
            val running = p.getBoolean("running", false)
            val remaining = remainingNow(context)
            val views = RemoteViews(context.packageName, R.layout.focus_widget)
            views.setTextViewText(R.id.focus_widget_title, "专注 · FOCUS")
            if (running && remaining > 0) {
                views.setViewVisibility(R.id.focus_widget_chrono, android.view.View.VISIBLE)
                views.setViewVisibility(R.id.focus_widget_paused, android.view.View.GONE)
                views.setChronometer(R.id.focus_widget_chrono, SystemClock.elapsedRealtime() + remaining, null, false)
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                    views.setChronometerCountDown(R.id.focus_widget_chrono, true)
                }
            } else {
                views.setViewVisibility(R.id.focus_widget_chrono, android.view.View.GONE)
                views.setViewVisibility(R.id.focus_widget_paused, android.view.View.VISIBLE)
                views.setTextViewText(R.id.focus_widget_paused, if (running) fmt(remaining) else "未在专注")
            }
            views.setProgressBar(R.id.focus_widget_progress, 100, p.getInt("progress", 0), false)
            views.setTextViewText(R.id.focus_widget_task, p.getString("task", "")?.ifBlank { "今天能做的那件事" })
            val charName = p.getString("charName", "") ?: ""
            val ta = p.getString("ta", "") ?: ""
            views.setTextViewText(R.id.focus_widget_ta, if (ta.isBlank()) (if (charName.isBlank()) "" else "$charName · 陪你把这段时间走完") else ta)
            val open = PendingIntent.getActivity(
                context, 21,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            views.setOnClickPendingIntent(R.id.focus_widget_root, open)
            manager.updateAppWidget(id, views)
        }

        fun pushAll(context: Context) {
            runCatching {
                val manager = AppWidgetManager.getInstance(context)
                val ids = manager.getAppWidgetIds(ComponentName(context, FocusWidgetProvider::class.java))
                for (id in ids) push(context, manager, id)
            }
        }
    }
}
