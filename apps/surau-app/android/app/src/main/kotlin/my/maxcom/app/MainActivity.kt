package my.maxcom.app

import android.content.Intent
import android.os.Bundle
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import my.maxcom.app.live.Diag
import my.maxcom.app.live.LiveChannel

// FlutterFragmentActivity: BiometricPrompt needs a FragmentActivity.
// The live engine and its foreground service belong to the process, not to
// this activity: nothing here releases or stops them, so a recording still
// finishes if the activity goes away. The lifecycle lines go to the diag file.
class MainActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        Diag.init(this)
        Diag.log("activity_create")
        super.onCreate(savedInstanceState)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        KeystoreChannel.register(flutterEngine, this)
        SecureScreenChannel.register(flutterEngine, this)
        LiveChannel.register(flutterEngine, this)
        my.maxcom.app.upload.UploadChannel.register(flutterEngine, this)
        FilePickChannel.register(flutterEngine, this)
        ShareChannel.register(flutterEngine, this)
    }

    // The document picker answers through startActivityForResult.
    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!FilePickChannel.onResult(requestCode, resultCode, data)) {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onPause() {
        Diag.log("activity_pause", "finishing=$isFinishing")
        super.onPause()
    }

    override fun onStop() {
        Diag.log("activity_stop", "finishing=$isFinishing")
        super.onStop()
    }

    override fun onDestroy() {
        Diag.log("activity_destroy", "finishing=$isFinishing")
        super.onDestroy()
    }
}
