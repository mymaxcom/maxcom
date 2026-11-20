package my.maxcom.box

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/**
 * What the start screen says for one state. Nobody can act on it and the person's language is not known, so the
 * title and the hint are Bahasa Malaysia with a small English and a small Arabic line under them. Never a secret.
 */
class StartText(
    val title: String,
    val detail: List<String>,
    val hint: String?,
    val titleEn: String = "",
    val titleAr: String = "",
    val hintEn: String? = null,
    val hintAr: String? = null,
)

object StartTexts {
    private const val MAX_LINES = 5

    private val PREPARING = Triple("Menyediakan MAXCOM", "Preparing MAXCOM", "جارٍ تجهيز MAXCOM")
    private val CLOCK = Triple("Menunggu jam Internet", "Waiting for the Internet clock", "في انتظار ساعة الإنترنت")
    private val STARTING = Triple("Memulakan pelayan MAXCOM", "Starting the MAXCOM server", "جارٍ تشغيل خادم MAXCOM")
    private val LOADING = Triple("Memuatkan skrin MAXCOM", "Loading the MAXCOM screen", "جارٍ تحميل شاشة MAXCOM")
    private val FAILED = Triple("MAXCOM tidak dapat dimulakan", "MAXCOM could not start", "تعذّر تشغيل MAXCOM")
    private val RETRY = Triple("Tekan OK untuk cuba lagi", "Press OK to try again", "اضغط OK للمحاولة مجددًا")

    private fun of(t: Triple<String, String, String>, detail: List<String> = emptyList(), hint: Triple<String, String, String>? = null) =
        StartText(t.first, detail, hint?.first, t.second, t.third, hint?.second, hint?.third)

    // Shown when the service has not reported anything for about a minute (the system ignored the start request).
    private val NO_SERVICE = Triple(
        "Perkhidmatan MAXCOM belum dapat dimulakan.",
        "The MAXCOM service could not be started.",
        "تعذّر تشغيل خدمة MAXCOM.",
    )
    private val NO_SERVICE_HINT = Triple(
        "Peranti ini mungkin menyekat aplikasi latar belakang. Sila jalankan semula skrip pemasangan dari komputer riba.",
        "This device may be blocking background apps. Please run the install script again from the laptop.",
        "قد يمنع هذا الجهاز تطبيقات الخلفية. يرجى تشغيل سكربت التثبيت مرة أخرى من الحاسوب المحمول.",
    )

    fun serviceNotStarted(): StartText = of(NO_SERVICE, hint = NO_SERVICE_HINT)

    fun forStatus(status: BoxStatus, healthPending: Boolean = false): StartText = when (status) {
        BoxStatus.Idle -> of(PREPARING)
        is BoxStatus.Preparing ->
            if (status.total > 0) StartText(
                "${PREPARING.first} (${status.done} daripada ${status.total})", emptyList(), null,
                "${PREPARING.second} (${status.done} of ${status.total})",
                "${PREPARING.third} (${status.done} من ${status.total})",
            )
            else of(PREPARING)
        BoxStatus.WaitingClock -> of(CLOCK)
        BoxStatus.Starting -> of(STARTING)
        BoxStatus.Running -> if (healthPending) of(STARTING) else of(LOADING)
        is BoxStatus.Failing -> of(FAILED, status.lines.takeLast(MAX_LINES), RETRY)
    }
}

/** Native start screen: the MAXCOM mark, the state text, and the last lines when the start failed. */
class StartScreen(context: Context) : LinearLayout(context) {
    private val mark = TextView(context)
    private val title = TextView(context)
    private val detail = TextView(context)
    private val hint = TextView(context)
    private val titleEn = TextView(context)
    private val titleAr = TextView(context)
    private val hintEn = TextView(context)
    private val hintAr = TextView(context)

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
        val muted = Color.argb(160, 244, 241, 232)
        title.apply { textSize = 36f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, 48, 0, 0) }
        // About 70 percent of the BM size, muted; the Arabic line reads right to left.
        listOf(titleEn, titleAr).forEach { it.apply { textSize = 25f; setTextColor(muted); gravity = Gravity.CENTER; setPadding(0, 6, 0, 0) } }
        titleAr.textDirection = View.TEXT_DIRECTION_RTL
        detail.apply { textSize = 22f; setTextColor(Color.argb(200, 244, 241, 232)); gravity = Gravity.CENTER; setPadding(96, 24, 96, 0) }
        hint.apply { textSize = 28f; setTextColor(context.getColor(R.color.maxcom_accent)); gravity = Gravity.CENTER; setPadding(0, 48, 0, 0) }
        listOf(hintEn, hintAr).forEach { it.apply { textSize = 20f; setTextColor(muted); gravity = Gravity.CENTER; setPadding(0, 6, 0, 0) } }
        hintAr.textDirection = View.TEXT_DIRECTION_RTL
        addView(mark)
        addView(title)
        addView(titleEn)
        addView(titleAr)
        addView(detail)
        addView(hint)
        addView(hintEn)
        addView(hintAr)
    }

    fun show(text: StartText) {
        title.text = text.title
        titleEn.text = text.titleEn
        titleAr.text = text.titleAr
        detail.text = text.detail.joinToString("\n")
        detail.visibility = if (text.detail.isEmpty()) View.GONE else View.VISIBLE
        hint.text = text.hint ?: ""
        hint.visibility = if (text.hint == null) View.GONE else View.VISIBLE
        hintEn.text = text.hintEn ?: ""
        hintEn.visibility = if (text.hintEn == null) View.GONE else View.VISIBLE
        hintAr.text = text.hintAr ?: ""
        hintAr.visibility = if (text.hintAr == null) View.GONE else View.VISIBLE
    }
}
