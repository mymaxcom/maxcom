package my.maxcom.box

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** What the start screen says for one state. All text is Bahasa Malaysia and never carries a secret. */
class StartText(val title: String, val detail: List<String>, val hint: String?)

object StartTexts {
    private const val MAX_LINES = 5

    fun forStatus(status: BoxStatus, healthPending: Boolean = false): StartText = when (status) {
        BoxStatus.Idle -> StartText("Menyediakan MAXCOM", emptyList(), null)
        is BoxStatus.Preparing ->
            if (status.total > 0) StartText("Menyediakan MAXCOM (${status.done} daripada ${status.total})", emptyList(), null)
            else StartText("Menyediakan MAXCOM", emptyList(), null)
        BoxStatus.WaitingClock -> StartText("Menunggu jam Internet", emptyList(), null)
        BoxStatus.Starting -> StartText("Memulakan pelayan MAXCOM", emptyList(), null)
        BoxStatus.Running ->
            if (healthPending) StartText("Memulakan pelayan MAXCOM", emptyList(), null)
            else StartText("Memuatkan skrin MAXCOM", emptyList(), null)
        is BoxStatus.Failing -> StartText("MAXCOM tidak dapat dimulakan", status.lines.takeLast(MAX_LINES), "Tekan OK untuk cuba lagi")
    }
}

/** Native start screen: the MAXCOM mark, the state text, and the last lines when the start failed. */
class StartScreen(context: Context) : LinearLayout(context) {
    private val mark = TextView(context)
    private val title = TextView(context)
    private val detail = TextView(context)
    private val hint = TextView(context)

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(context.getColor(R.color.maxcom_bg))
        val fg = context.getColor(R.color.maxcom_fg)
        mark.apply {
            text = "MAXCOM"
            textSize = 64f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(context.getColor(R.color.maxcom_accent))
            gravity = Gravity.CENTER
        }
        title.apply { textSize = 36f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, 48, 0, 0) }
        detail.apply { textSize = 22f; setTextColor(Color.argb(200, 244, 241, 232)); gravity = Gravity.CENTER; setPadding(96, 24, 96, 0) }
        hint.apply { textSize = 28f; setTextColor(context.getColor(R.color.maxcom_accent)); gravity = Gravity.CENTER; setPadding(0, 48, 0, 0) }
        addView(mark)
        addView(title)
        addView(detail)
        addView(hint)
    }

    fun show(text: StartText) {
        title.text = text.title
        detail.text = text.detail.joinToString("\n")
        detail.visibility = if (text.detail.isEmpty()) View.GONE else View.VISIBLE
        hint.text = text.hint ?: ""
        hint.visibility = if (text.hint == null) View.GONE else View.VISIBLE
    }
}
