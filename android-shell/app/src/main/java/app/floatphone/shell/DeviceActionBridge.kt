package app.floatphone.shell

import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.AlarmClock
import android.provider.Settings
import android.view.KeyEvent
import org.json.JSONObject

/**
 * 设备动作桥：让网页（进而让角色）能在真实手机上做一件小事。
 *
 * 与 PerceptionBridge 的分工：
 *   PerceptionBridge 只「读」——电量、网络、应用名、步数；
 *   DeviceActionBridge 只「写」——手电筒、音量、亮度、勿扰、打开应用。
 *
 * 设计边界（重要，改这个文件前先读）：
 *  - 每个动作都是**一次性、立即可见、可撤销**的。刻意不做任何持续性、
 *    后台性、隐蔽性的行为——角色不该能悄悄改用户手机的状态。
 *  - 每个动作都必须能把结果说清楚（成功/失败原因），绝不静默失败：
 *    角色以为灯开了、其实没开，比拒绝执行更糟。
 *  - 需要特殊权限的动作（改系统亮度、勿扰），先在 canXxx() 里如实回答
 *    「现在能不能做」，不能做时由网页引导用户去授权，而不是在这里弹窗或抛错。
 *  - 绝不执行：发短信、打电话、读通讯录、装应用、改动其他 App 的数据。
 *    这些会与「小手机里仿真聊天」的产品边界打架。
 */
class DeviceActionBridge(private val context: Context) {

    companion object {
        /**
         * 手电筒状态。系统没有「查当前开没开」的接口，只能自己记。
         * 进程被杀后这个值会重置为 false，而灯可能还亮着——所以实际上
         * 每次 setTorch 都用显式开关参数，不依赖这个缓存做判断。
         */
        @Volatile
        private var torchOn = false

        @Volatile
        private var torchCameraId: String? = null
    }

    /** 找一个带闪光灯的摄像头 id。找不到返回 null（设备没有闪光灯）。 */
    private fun findTorchCameraId(): String? {
        torchCameraId?.let { return it }
        return try {
            val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val id = cm.cameraIdList.firstOrNull { cameraId ->
                val chars = cm.getCameraCharacteristics(cameraId)
                chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
            id?.also { torchCameraId = it }
        } catch (e: Throwable) {
            null
        }
    }

    /** 设备有没有可用的手电筒。 */
    fun canTorch(): Boolean = findTorchCameraId() != null

    /**
     * 开关手电筒。
     *
     * 用显式 on/off 而不是「切换」：网页与角色的意图可能因为重试而重复送达，
     * 「切换」语义下重试一次就把灯又关回去了（用户看到灯闪一下）。
     */
    fun setTorch(on: Boolean): JSONObject {
        // 用块函数体而不是 `= try { ... }`：表达式体里禁止 return，
        // 而这里有提前返回的分支（没闪光灯时直接给原因）。
        val cameraId = findTorchCameraId()
            ?: return JSONObject().put("ok", false).put("reason", "这台设备没有可用的闪光灯")
        return try {
            val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            cm.setTorchMode(cameraId, on)
            torchOn = on
            JSONObject().put("ok", true).put("on", on)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "手电筒不可用")
        }
    }

    /** 当前是不是开着（仅本进程内的记忆，见 companion 注释）。 */
    fun isTorchOn(): Boolean = torchOn

    // ── 音量 ──

    /** 可调的音频流。名字与网页侧一一对应。 */
    private fun streamFor(name: String): Int? = when (name) {
        "media" -> AudioManager.STREAM_MUSIC
        "ring" -> AudioManager.STREAM_RING
        "alarm" -> AudioManager.STREAM_ALARM
        "notification" -> AudioManager.STREAM_NOTIFICATION
        else -> null
    }

    /**
     * 改音量。action: up / down / set / mute；set 用 level（0-100 百分比）。
     * 零权限，任何时候都能做。
     */
    fun setVolume(streamName: String, action: String, level: Int): JSONObject {
        val stream = streamFor(streamName)
            ?: return JSONObject().put("ok", false).put("reason", "未知的音量类型：$streamName")
        return try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val max = am.getStreamMaxVolume(stream)
            when (action) {
                "up" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
                "down" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
                "mute" -> am.adjustStreamVolume(stream, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
                "set" -> {
                    val target = (max * level.coerceIn(0, 100) / 100.0).toInt().coerceIn(0, max)
                    am.setStreamVolume(stream, target, AudioManager.FLAG_SHOW_UI)
                }
                else -> return JSONObject().put("ok", false).put("reason", "未知的操作：$action")
            }
            JSONObject()
                .put("ok", true)
                .put("current", am.getStreamVolume(stream))
                .put("max", max)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "音量不可用")
        }
    }

    // ── 屏幕亮度 ──

    /**
     * 改屏幕亮度需要 WRITE_SETTINGS（特殊权限，必须用户手动在系统设置里授予）。
     * 这里只如实回答能不能做，不做任何引导弹窗。
     */
    fun canSetBrightness(): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) Settings.System.canWrite(context)
        else true
    } catch (e: Throwable) {
        false
    }

    /**
     * 设屏幕亮度，level 为 0-100 百分比。
     *
     * 三道检查，缺一不可——早期版本只写了第一行的 putInt 就无条件回 ok:true，
     * 结果国产 ROM 拦下写入时角色照样报「调好了」，用户屏幕却毫无变化（实测反馈）：
     *   ① putInt **写失败时返回 false 而不抛异常**，必须接这个返回值；
     *   ② 写完读回核对，对不上就是没生效，不能报成功；
     *   ③ 自动亮度会让系统立刻把值覆盖回去，如实告知而不是假装成功。
     *
     * 仍然刻意不碰 SCREEN_BRIGHTNESS_MODE（自动亮度）：改模式会让用户
     * 「明明没动过自动亮度却关了」而困惑。检测到开着只转告，不替他改设置。
     */
    fun setBrightness(level: Int): JSONObject {
        if (!canSetBrightness()) {
            return JSONObject().put("ok", false)
                .put("reason", "还没有「修改系统设置」权限")
                .put("needPermission", "write_settings")
        }
        val autoBrightness = isAutoBrightnessOn()
        return try {
            // 系统的亮度值是 0-255。Android 没有公开接口能查「真实上限」，
            // 所以按标准量程换算，不猜一个厂商私有的设置键。
            val value = (255 * level.coerceIn(1, 100) / 100.0).toInt().coerceIn(1, 255)
            val written = Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS,
                value,
            )
            if (!written) {
                return JSONObject().put("ok", false)
                    .put("autoBrightness", autoBrightness)
                    .put("reason", "系统拒绝了这次亮度写入（厂商可能限制了修改系统设置）")
            }
            // 写完读回核对：putInt 不抛错，不等于真的生效了。
            // 容差 2 是为了容忍系统对值的整数夹取，再大就是真的没写进去。
            val readBack = readCurrentBrightness()
            if (readBack < 0 || Math.abs(readBack - value) > 2) {
                return JSONObject().put("ok", false)
                    .put("level", level)
                    .put("autoBrightness", autoBrightness)
                    .put(
                        "reason",
                        if (autoBrightness) "当前是自动亮度，系统立刻把亮度改了回去；关掉自动亮度后才能由角色控制"
                        else "亮度写进去了，但系统没有采用（厂商可能限制了修改系统设置）",
                    )
            }
            JSONObject().put("ok", true).put("level", level)
                .put("applied", true)
                .put("autoBrightness", autoBrightness)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "亮度不可用")
        }
    }

    /**
     * 有没有 App 能响应某类闹钟意图。给 capabilitiesJson 用。
     *
     * 这里只回答「有没有这个能力」，不代替用户做选择：
     * 用 queryIntentActivities 而不是 resolveActivity——后者在有多个时钟
     * 应用时返回 null，会把「有得选」误报成「不支持」。
     */
    private fun canHandleAlarmIntent(action: String): Boolean = try {
        val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.packageManager.queryIntentActivities(intent, 0).isNotEmpty()
    } catch (e: Throwable) {
        false
    }

    /** 当前是不是自动亮度。读不到时按「不是」处理——不因为这个拦住正常调节。 */
    private fun isAutoBrightnessOn(): Boolean = try {
        Settings.System.getInt(
            context.contentResolver,
            Settings.System.SCREEN_BRIGHTNESS_MODE,
            Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
        ) == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC
    } catch (e: Throwable) {
        false
    }

    /** 读当前屏幕亮度值。读不到返回 -1（调用方据此判失败，不假装读到）。 */
    private fun readCurrentBrightness(): Int = try {
        Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1)
    } catch (e: Throwable) {
        -1
    }

    // ── 勿扰模式 ──

    /** 改勿扰需要 ACCESS_NOTIFICATION_POLICY（系统设置页手动授予）。 */
    fun canSetDnd(): Boolean = try {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.isNotificationPolicyAccessGranted
    } catch (e: Throwable) {
        false
    }

    /**
     * 开关勿扰。on=true → 全部静音（INTERRUPTION_FILTER_NONE 之外的最严档），
     * on=false → 恢复正常（INTERRUPTION_FILTER_ALL）。
     *
     * 用 NONE/ALL 这两个最明确的档位，不用 PRIORITY（它依赖用户自己配的
     * 允许名单，行为不可预测，角色说不清到底静音了什么）。
     */
    fun setDnd(on: Boolean): JSONObject {
        if (!canSetDnd()) {
            return JSONObject().put("ok", false)
                .put("reason", "还没有「勿扰模式」访问权限")
                .put("needPermission", "dnd")
        }
        return try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.setInterruptionFilter(
                if (on) NotificationManager.INTERRUPTION_FILTER_NONE
                else NotificationManager.INTERRUPTION_FILTER_ALL,
            )
            JSONObject().put("ok", true).put("on", on)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "勿扰模式不可用")
        }
    }

    // ── 打开应用 ──

    /**
     * 用包名打开另一个 App。需 QUERY_ALL_PACKAGES（已声明）。
     *
     * 从后端栈启动（NEW_TASK）：本桥被 WebView 里的 JS 调用时没有 Activity 栈，
     * 不带这个 flag 会直接抛 ActivityNotFoundException。
     */
    fun openApp(packageName: String): JSONObject {
        if (packageName.isBlank()) {
            return JSONObject().put("ok", false).put("reason", "包名不能为空")
        }
        val pm = context.packageManager
        val intent = pm.getLaunchIntentForPackage(packageName)
            ?: return JSONObject().put("ok", false)
                .put("reason", "这个应用没有可以打开的界面（可能是插件或系统组件）")
        return try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            // 一并回传显示名：角色/用户说的可能是简称，回一句真实名字才看得出开了哪个
            val label = runCatching {
                pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
            }.getOrDefault("")
            JSONObject().put("ok", true).put("package", packageName).put("label", label)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "无法打开应用")
        }
    }

    /**
     * 包名 → 应用显示名。给「用名字找应用」的兜底路径用：
     * 角色多半说「打开微信」，而不知道 com.tencent.mm。
     * 返回空串表示没找到（调用方如实说找不到，不要猜一个包名去启动）。
     */
    fun findPackageByLabel(label: String): String {
        if (label.isBlank()) return ""
        return try {
            val pm = context.packageManager
            val target = label.trim()
            // 只在「能从桌面启动的应用」里找。
            //
            // 原来用 getInstalledApplications() 会连没有界面的包一起返回
            // （插件、输入法、壁纸、服务组件），名字撞上了就选中它，
            // 再由 openApp 报「找不到可启动的应用」——用户看到这句会以为是
            // 包名写错，其实是那个 App 根本没有界面。
            //
            // 用 queryIntentActivities 取 MAIN/LAUNCHER，拿到的必然是可启动的，
            // 而且天然绕开「有同名的无界面组件」这种坑。
            val launchable = pm.queryIntentActivities(
                Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),
                0,
            )
            val candidates = ArrayList<Pair<String, String>>()
            for (info in launchable) {
                val pkg = info.activityInfo?.packageName ?: continue
                if (pkg == context.packageName) continue
                val name = runCatching {
                    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
                }.getOrDefault("")
                if (name.isNotEmpty()) candidates.add(Pair(pkg, name))
            }
            // 先精确匹配，再退化到包含匹配——避免「微信」误命中「微信读书」。
            // 包含匹配时优先取名字最短的那个：越短越可能是用户说的本尊。
            val exact = candidates.firstOrNull { it.second == target }
            if (exact != null) return exact.first
            val fuzzy = candidates
                .filter { it.second.contains(target, ignoreCase = true) }
                .minByOrNull { it.second.length }
            fuzzy?.first ?: ""
        } catch (e: Throwable) {
            ""
        }
    }

    // ── 闹钟与计时器 ──

    /**
     * 设一个闹钟。到点由系统的「时钟」App 响铃。
     *
     * 刻意**带界面**（EXTRA_SKIP_UI=false）：会打开时钟 App 让用户看到并确认。
     * 静默设闹钟听起来方便，但用户第二天早上被一个「不知道谁设的」闹钟吵醒，
     * 比根本没设更糟。让系统界面替我们做最终确认，也符合「不神戳戳」。
     *
     * @param hour 0-23
     * @param minute 0-59
     */
    fun setAlarm(hour: Int, minute: Int, message: String): JSONObject {
        if (hour !in 0..23 || minute !in 0..59) {
            return JSONObject().put("ok", false).put("reason", "时间不合法（小时 0-23，分钟 0-59）")
        }
        return try {
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, hour)
                putExtra(AlarmClock.EXTRA_MINUTES, minute)
                if (message.isNotBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, message.take(80))
                putExtra(AlarmClock.EXTRA_SKIP_UI, false)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            JSONObject()
                .put("ok", true)
                .put("hour", hour)
                .put("minute", minute)
                .put("needsConfirm", true)
        } catch (e: Throwable) {
            // 原来无论什么异常都说「没有可用的时钟应用」，把 Android 11+ 的包可见性
            // 限制（manifest 缺 queries 声明）误报成了「手机没时钟」——绝大多数手机
            // 都有时钟，用户看到这句只会一头雾水。现在如实区分。
            if (e is android.content.ActivityNotFoundException) {
                JSONObject().put("ok", false).put("reason", "系统里没有能响应「设闹钟」的应用（可能被厂商精简掉了）")
            } else {
                JSONObject().put("ok", false).put("reason", "闹钟设置失败：${e.javaClass.simpleName} ${e.message ?: ""}".trim())
            }
        }
    }

    /**
     * 设一个倒计时。到点由「时钟」App 提醒。
     *
     * 与闹钟不同，计时器**直接启动**（EXTRA_SKIP_UI=true）：它的语义就是
     * 「从现在开始数 N 分钟」，多一次确认反而打断节奏；而且时长有限，
     * 即使设错了也不会像闹钟那样在半夜响。
     */
    fun setTimer(seconds: Int, message: String): JSONObject {
        if (seconds !in 1..86_400) {
            return JSONObject().put("ok", false).put("reason", "时长需在 1 秒到 24 小时之间")
        }
        return try {
            val intent = Intent(AlarmClock.ACTION_SET_TIMER).apply {
                putExtra(AlarmClock.EXTRA_LENGTH, seconds)
                if (message.isNotBlank()) putExtra(AlarmClock.EXTRA_MESSAGE, message.take(80))
                putExtra(AlarmClock.EXTRA_SKIP_UI, true)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            JSONObject().put("ok", true).put("seconds", seconds)
        } catch (e: Throwable) {
            if (e is android.content.ActivityNotFoundException) {
                JSONObject().put("ok", false).put("reason", "系统里没有能响应「倒计时」的应用（可能被厂商精简掉了）")
            } else {
                JSONObject().put("ok", false).put("reason", "倒计时设置失败：${e.javaClass.simpleName} ${e.message ?: ""}".trim())
            }
        }
    }

    // ── 媒体播放控制 ──

    /** 现在有哪些活跃媒体会话。没授权时抛 SecurityException，一并吞成空列表。 */
    private fun activeMediaControllers(): List<MediaController> = try {
        val msm = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        msm.getActiveSessions(MediaControlListenerService.tokenFor(context))
    } catch (e: Throwable) {
        emptyList()
    }

    /**
     * 有没有资格读活跃媒体会话（即用户授了「通知使用权」）。
     *
     * 只能靠试着调一次来判断：系统没给 isNotificationListenerAccessGranted
     * 这类公开接口，getActiveSessions 抛 SecurityException 就是没授权。
     */
    fun canReadActiveSessions(): Boolean = try {
        val msm = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        msm.getActiveSessions(MediaControlListenerService.tokenFor(context))
        true
    } catch (e: Throwable) {
        false
    }

    /** 取「当前在播的那个」会话；没有在播的就取第一个（便于对暂停中的下发 play）。 */
    private fun pickController(controllers: List<MediaController>): MediaController? =
        controllers.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            ?: controllers.firstOrNull()

    /** 曲目标识（标题|歌手）。用来判断上一首/下一首有没有真的换歌。 */
    private fun mediaTitle(controller: MediaController): String {
        val md: MediaMetadata = controller.metadata ?: return ""
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""
        val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: ""
        return if (title.isEmpty() && artist.isEmpty()) "" else "$title|$artist"
    }

    /**
     * 控制正在播放的音乐（暂停/继续/上一首/下一首）。
     *
     * 曾只用 dispatchMediaKeyEvent 盲发媒体按键，然后无条件回 ok:true——
     * 后台没有播放器时按键会被系统直接丢掉，角色却照样报「已继续播放」，
     * 用户等半天没动静（实测反馈）。根因是「指令发出去了」被当成了「事情做成了」。
     *
     * 现在两条路：
     *   ① 有「通知使用权」→ 经 MediaSessionManager 拿活跃会话，用 MediaController
     *      直接下发，并**读回播放状态核对**是否真的生效，把 confirmed 如实报出去；
     *   ② 没有该权限 → 退回盲发媒体按键，confirmed=false 并说明无法确认。
     * 确实没有活跃会话时明确报失败，不再假装成功。
     */
    fun mediaControl(action: String): JSONObject {
        val controllers = activeMediaControllers()
        if (controllers.isEmpty()) {
            // 分不清「没授权」和「真没在播」时不能乱猜：先看有没有授权。
            if (!canReadActiveSessions()) return dispatchMediaKeyFallback(action)
            return JSONObject().put("ok", false)
                .put("reason", "现在没有正在播放的媒体，没有可控制的对象")
        }
        val controller = pickController(controllers)
            ?: return JSONObject().put("ok", false).put("reason", "没有可控制的播放器")
        val beforeState = controller.playbackState
        val beforeTitle = mediaTitle(controller)
        return try {
            when (action) {
                "play" -> controller.transportControls.play()
                "pause" -> controller.transportControls.pause()
                "toggle" -> if (beforeState?.state == PlaybackState.STATE_PLAYING) {
                    controller.transportControls.pause()
                } else {
                    controller.transportControls.play()
                }
                "next" -> controller.transportControls.skipToNext()
                "prev" -> controller.transportControls.skipToPrevious()
                "stop" -> controller.transportControls.stop()
                else -> return JSONObject().put("ok", false).put("reason", "未知的播放操作：$action")
            }
            // 状态回灌不是同步的：不给系统一点时间，读回来的还是操作前的旧值，
            // 会把成功误判成失败。180ms 是实测够用又不至于卡手感的折中。
            Thread.sleep(180)
            val afterState = controller.playbackState
            val readable = afterState != null
            val afterTitle = mediaTitle(controller)
            // play/pause 的预期很明确，能直接核对；next/prev 靠曲目是否变化判断，
            // 单曲循环下不变并不代表失败，所以只标记「没能确认」而不是判失败。
            val confirmed = when (action) {
                "play" -> readable && afterState?.state == PlaybackState.STATE_PLAYING
                "pause" -> readable && afterState?.state == PlaybackState.STATE_PAUSED
                "toggle" -> readable && afterState?.state != beforeState?.state
                "next", "prev" -> readable && afterTitle.isNotEmpty() && afterTitle != beforeTitle
                "stop" -> readable && (afterState?.state == PlaybackState.STATE_STOPPED || afterState?.state == PlaybackState.STATE_NONE)
                else -> false
            }
            val label = runCatching {
                val pm = context.packageManager
                pm.getApplicationLabel(pm.getApplicationInfo(controller.packageName, 0)).toString()
            }.getOrDefault(controller.packageName)
            JSONObject().put("ok", true).put("action", action)
                .put("confirmed", confirmed)
                .put("readable", readable)
                .put("viaSession", true)
                .put("player", label)
                .put("playing", afterState?.state == PlaybackState.STATE_PLAYING)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "媒体控制不可用")
        }
    }

    /**
     * 没有「通知使用权」时的退路：盲发媒体按键。
     *
     * 这条路没有任何回读手段，所以只能说「指令发出去了」，confirmed 一律 false。
     * 绝不报成「已播放」——那正是用户看到「提示成功、却没声音」的原因。
     */
    private fun dispatchMediaKeyFallback(action: String): JSONObject {
        val keyCode = when (action) {
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "toggle" -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "prev" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "stop" -> KeyEvent.KEYCODE_MEDIA_STOP
            else -> return JSONObject().put("ok", false).put("reason", "未知的播放操作：$action")
        }
        return try {
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            // 必须成对下发 DOWN/UP：只发 DOWN 会让播放器一直处于「按键按住」状态。
            am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
            am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
            JSONObject().put("ok", true).put("action", action)
                .put("confirmed", false)
                .put("viaSession", false)
                .put("needPermission", "notification_listener")
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", e.message ?: "媒体控制不可用")
        }
    }

    // ── 打开网页 ──

    /**
     * 用系统浏览器打开一个链接。
     *
     * 安全校验（必须保留）：只放行 http/https，且必须是合法 URL。
     * 不校验的话，模型可以传 `intent://` 之类的 scheme 去触发任意组件，
     * `file://` 也可能被用来读取本地文件——这是把「让角色分享链接」
     * 变成「开了一个任意 Intent 后门」。
     */
    fun openUrl(url: String): JSONObject {
        val trimmed = url.trim()
        if (trimmed.isBlank()) {
            return JSONObject().put("ok", false).put("reason", "链接不能为空")
        }
        val lower = trimmed.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return JSONObject().put("ok", false).put("reason", "只支持 http/https 链接")
        }
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(trimmed)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            JSONObject().put("ok", true).put("url", trimmed)
        } catch (e: Throwable) {
            JSONObject().put("ok", false).put("reason", "没有能打开这个链接的应用")
        }
    }

    // ── 使用情况访问（屏幕使用时间）──

    /**
     * 是否已授予「使用情况访问」权限。
     *
     * 这是**特殊权限**（AppOps），不能用 requestPermissions 弹窗申请，
     * 只能跳系统设置页让用户手动开。所以这里只如实回答状态，
     * 由网页显示「去授权」并跳转。
     */
    fun hasUsageStatsAccess(): Boolean {
        return try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                appOps.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName,
                )
            } else {
                @Suppress("DEPRECATION")
                appOps.checkOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(),
                    context.packageName,
                )
            }
            mode == AppOpsManager.MODE_ALLOWED
        } catch (e: Throwable) {
            false
        }
    }

    // ── 打开系统设置页（引导用户授权用）──

    /**
     * 跳系统的授权页。由网页在用户点「去授权」时调用，壳不主动跳。
     * 返回是否成功跳转（跳不动时网页可给一句手动路径提示）。
     */
    fun openSystemSettings(which: String): Boolean {
        val intent = when (which) {
            "write_settings" -> Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
            "dnd" -> Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
            "usage_stats" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            "notification_listener" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            "location" -> Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "app_details" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:${context.packageName}"))
            else -> return false
        }
        return try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (e: Throwable) {
            false
        }
    }

    /**
     * 本机支持哪些设备动作 —— 给设置面板与角色工具用。
     *
     * 注意区分两种「不支持」：
     *   · 硬件/系统层面根本没这能力（没有闪光灯）→ 这里报 false；
     *   · 有能力但用户还没授权（亮度、勿扰）→ 这里照实报 true，
     *     由网页显示「需要授权」并提供跳转。混为一谈会让用户以为
     *     自己的手机不支持，从而放弃。
     */
    fun capabilitiesJson(): String = JSONObject()
        .put("torch", canTorch())
        .put("volume", true)
        .put("brightness", true)
        .put("brightnessGranted", canSetBrightness())
        // 自动亮度开着时，写进去的值会被系统很快改回去——网页据此提前提醒用户，
        // 而不是等角色报「调好了」、用户却发现没反应。
        .put("brightnessAuto", isAutoBrightnessOn())
        .put("dnd", true)
        .put("dndGranted", canSetDnd())
        .put("openApp", true)
        // 闹钟/倒计时原来写死 true，不管手机有没有时钟都应「支持」——检测里那行
        // 「App 已支持」因此是空的。现在真去查能不能拉起，查不到就如实报 false。
        .put("alarm", canHandleAlarmIntent(AlarmClock.ACTION_SET_ALARM))
        .put("timer", canHandleAlarmIntent(AlarmClock.ACTION_SET_TIMER))
        .put("media", true)
        // 有没有「通知使用权」——有它才能读活跃媒体会话、确认播放指令是否生效。
        // 与 media=true 分开报：媒体控制本身随时能用（盲发按键），
        // 缺的只是「确认能力」，混为一谈会让用户以为整个功能不能用。
        .put("mediaSessionGranted", canReadActiveSessions())
        .put("openUrl", true)
        .put("usageStats", true)
        .put("usageStatsGranted", hasUsageStatsAccess())
        .toString()
}
