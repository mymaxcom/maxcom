package my.maxcom.app.live

import android.content.Context
import android.view.TextureView
import android.view.View
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/** The camera preview in the Live tab: a TextureView RootEncoder draws into. */
class PreviewFactory : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView =
        PreviewView(context)
}

class PreviewView(context: Context) : PlatformView {
    private val texture = TextureView(context)
    private val engine = LiveEngine.get(context)

    init {
        engine.attachPreview(texture)
    }

    override fun getView(): View = texture

    override fun dispose() {
        engine.detachPreview(texture)
    }
}
