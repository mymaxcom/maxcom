package my.maxcom.app.live

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression guard for the live preview EGL_BAD_ACCESS fix.
 *
 * The camera preview must be a [TextureView] so Flutter can use Texture Layer
 * Hybrid Composition instead of falling back to Hybrid Composition with a
 * SurfaceView overlay, which is fragile with Impeller on OpenGL ES.
 */
class PreviewViewRegressionTest {

    private val livePackageDir = File(
        "src/main/kotlin/my/maxcom/app/live",
    )

    private val previewViewFile = File(
        "src/main/kotlin/my/maxcom/app/live/PreviewView.kt",
    )

    @Test
    fun previewViewUsesTextureView() {
        val source = previewViewFile.readText()
        assertTrue("PreviewView must host a TextureView", source.contains("TextureView"))
        assertFalse("PreviewView must no longer use SurfaceView", source.contains("SurfaceView"))
    }

    @Test
    fun livePackageDoesNotReferenceSurfaceView() {
        val files = livePackageDir.listFiles { _, name -> name.endsWith(".kt") } ?: emptyArray()
        val offenders = files.filter { it.readText().contains("SurfaceView") }.map { it.name }
        assertTrue(
            "No file in the live package may reference SurfaceView: $offenders",
            offenders.isEmpty(),
        )
    }
}
