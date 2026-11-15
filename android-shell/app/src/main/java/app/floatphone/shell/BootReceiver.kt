package app.floatphone.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restore persisted native alarms after reboot; OEM autostart settings may still block delivery. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            // Restore one-shot reminders first. Background-only intervals restart from boot;
            // powered-off time is not counted as active background time.
            runCatching { BackgroundEnhancementManager.restore(context) }
            // Keep the existing push behavior unchanged for compatibility.
            runCatching { NativeRealityBridge.capture(context, "设备启动", "手机已重新启动") }
            runCatching { PushService.start(context) }
        }
    }
}
