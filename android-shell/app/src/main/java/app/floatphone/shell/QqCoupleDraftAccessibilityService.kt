package app.floatphone.shell

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * 第一阶段 QQ 情侣空间草稿助手。
 *
 * 只在用户已手动进入 QQ 的动态编辑页面时填入待发布文字；不会点击发布按钮，
 * 不读取/上传页面内容，也不会自动处理验证码、登录或其他账号操作。
 */
class QqCoupleDraftAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.packageName?.toString() != QQ_PACKAGE) return
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val draft = prefs.getString(KEY_PENDING_DRAFT, null)?.trim().orEmpty()
        if (draft.isEmpty()) return

        val root = rootInActiveWindow ?: return
        try {
            if (root.packageName?.toString() != QQ_PACKAGE) return
            val labels = collectVisibleText(root).joinToString(" ")
            // 必须能确认用户已进入情侣空间的发布/编辑页面，避免把正文填进 QQ 搜索框或聊天框。
            val coupleContext = labels.contains("情侣空间") || labels.contains("情侣主页")
            val composeContext = COMPOSE_HINTS.any(labels::contains)
            if (!coupleContext || !composeContext) return

            val editor = findEditable(root) ?: return
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, draft)
            }
            val filled = editor.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            if (filled) {
                // 单次草稿：避免页面每次刷新都覆盖用户后续编辑。
                prefs.edit().remove(KEY_PENDING_DRAFT).apply()
                ShellBus.dispatchQqCoupleDraftEvent("filled")
            }
        } catch (_: Throwable) {
            // 页面结构随 QQ 版本变化时安全失败，不进行坐标盲点。
        } finally {
            root.recycle()
        }
    }

    override fun onInterrupt() = Unit

    private fun collectVisibleText(node: AccessibilityNodeInfo): List<String> {
        val result = mutableListOf<String>()
        fun walk(current: AccessibilityNodeInfo, depth: Int) {
            if (depth > 18) return
            current.text?.toString()?.takeIf(String::isNotBlank)?.let(result::add)
            current.contentDescription?.toString()?.takeIf(String::isNotBlank)?.let(result::add)
            for (i in 0 until current.childCount) {
                val child = current.getChild(i) ?: continue
                try { walk(child, depth + 1) } finally { child.recycle() }
            }
        }
        walk(node, 0)
        return result
    }

    private fun findEditable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable && node.isEnabled) return AccessibilityNodeInfo.obtain(node)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = try { findEditable(child) } finally { child.recycle() }
            if (found != null) return found
        }
        return null
    }

    companion object {
        const val QQ_PACKAGE = "com.tencent.mobileqq"
        const val PREFS = "qq_couple_draft"
        const val KEY_PENDING_DRAFT = "pending_draft"
        private val COMPOSE_HINTS = listOf("发布动态", "发表动态", "写动态", "说点什么", "这一刻", "发布", "发表")
    }
}
