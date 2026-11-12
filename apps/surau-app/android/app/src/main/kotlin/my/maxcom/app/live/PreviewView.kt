package my.maxcom.app.live

import android.content.Context
import android.view.SurfaceView
import android.view.View
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/** The camera preview in the Live tab: a SurfaceView RootEncoder draws into. */
class PreviewFactory : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView =
        PreviewView(context)
}

class PreviewView(context: Context) : PlatformView {
    private val surface = SurfaceView(context)
    private val engine = LiveEngine.get(context)

    init {
        engine.attachPreview(surface)
    }

    override fun getView(): View = surface

    override fun dispose() {
        engine.detachPreview(surface)
    }
}
