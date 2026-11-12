package my.maxcom.app

import android.app.Activity
import android.view.WindowManager
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Blocks screenshots, screen recording and the recent-apps thumbnail while a page that shows a secret is open
 * (the recovery code, shown once). Channel `my.maxcom/secure`: `secure/enable` sets FLAG_SECURE on the window,
 * `secure/disable` clears it. Nothing else crosses this channel, and it returns no data.
 */
class SecureScreenChannel(private val activity: Activity) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "my.maxcom/secure"

        fun register(engine: FlutterEngine, activity: Activity) {
            MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL)
                .setMethodCallHandler(SecureScreenChannel(activity))
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "secure/enable" -> {
                activity.window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
                result.success(null)
            }
            "secure/disable" -> {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }
}
