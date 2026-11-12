package my.maxcom.box

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.NodeList

/** Scans the manifest and resources in the source tree (JVM, no Android runtime). */
class ManifestTest {
    private val ns = "http://schemas.android.com/apk/res/android"
    private val mainDir = File("src/main")

    private fun parse(file: File): Document {
        assertTrue("missing ${file.path}", file.isFile)
        val factory = DocumentBuilderFactory.newInstance()
        factory.isNamespaceAware = true
        return factory.newDocumentBuilder().parse(file)
    }

    private val manifest: Document by lazy { parse(File(mainDir, "AndroidManifest.xml")) }

    private fun List<Element>.names() = map { it.getAttributeNS(ns, "name") }

    private fun NodeList.elements(): List<Element> =
        (0 until length).mapNotNull { item(it) as? Element }

    private fun components(): List<Element> {
        val app = manifest.getElementsByTagName("application").item(0) as Element
        val tags = listOf("activity", "activity-alias", "service", "receiver", "provider")
        return tags.flatMap { app.getElementsByTagName(it).elements() }
    }

    @Test
    fun onlyKioskActivityIsExported() {
        val exported = components().filter { it.getAttributeNS(ns, "exported") == "true" }
        assertEquals(listOf(".KioskActivity"), exported.names())
    }

    @Test
    fun everyComponentStatesExportedExplicitly() {
        for (c in components()) {
            assertTrue(
                "${c.getAttributeNS(ns, "name")} must set android:exported",
                c.hasAttributeNS(ns, "exported"),
            )
        }
    }

    @Test
    fun exactComponentSetDeclaredOnce() {
        assertEquals(
            listOf(".BootReceiver", ".BoxService", ".KioskActivity", ".MaintenanceActivity"),
            components().names().sorted(),
        )
    }

    @Test
    fun noProviderAndNoCustomPermission() {
        assertEquals(0, manifest.getElementsByTagName("provider").length)
        assertEquals(0, manifest.getElementsByTagName("permission").length)
    }

    @Test
    fun permissionListIsExact() {
        val declared = manifest.getElementsByTagName("uses-permission").elements().names().sorted()
        val expected = listOf(
            "ACCESS_NETWORK_STATE",
            "ACCESS_WIFI_STATE",
            "FOREGROUND_SERVICE",
            "FOREGROUND_SERVICE_SPECIAL_USE",
            "INTERNET",
            "POST_NOTIFICATIONS",
            "RECEIVE_BOOT_COMPLETED",
            "WAKE_LOCK",
        ).map { "android.permission.$it" }.sorted()
        assertEquals(expected, declared)
    }

    @Test
    fun applicationFlagsAreHardened() {
        val app = manifest.getElementsByTagName("application").item(0) as Element
        assertEquals("false", app.getAttributeNS(ns, "allowBackup"))
        assertEquals("false", app.getAttributeNS(ns, "usesCleartextTraffic"))
        assertEquals("true", app.getAttributeNS(ns, "extractNativeLibs"))
        assertFalse("debuggable must not be set", app.hasAttributeNS(ns, "debuggable"))
        assertEquals("@xml/network_security_config", app.getAttributeNS(ns, "networkSecurityConfig"))
        assertEquals("@xml/data_extraction_rules", app.getAttributeNS(ns, "dataExtractionRules"))
    }

    @Test
    fun noDebuggableAnywhere() {
        val text = File(mainDir, "AndroidManifest.xml").readText()
        assertFalse(text.contains("debuggable"))
    }

    @Test
    fun leanbackAndTouchscreenNotRequired() {
        val features = manifest.getElementsByTagName("uses-feature").elements()
            .associate { it.getAttributeNS(ns, "name") to it.getAttributeNS(ns, "required") }
        assertEquals("false", features["android.software.leanback"])
        assertEquals("false", features["android.hardware.touchscreen"])
    }

    @Test
    fun kioskActivityIsHomeAndLauncher() {
        val kiosk = components().first { it.getAttributeNS(ns, "name") == ".KioskActivity" }
        assertEquals("singleTask", kiosk.getAttributeNS(ns, "launchMode"))
        assertEquals("landscape", kiosk.getAttributeNS(ns, "screenOrientation"))
        val filters = kiosk.getElementsByTagName("intent-filter").elements()
        assertEquals(1, filters.size)
        val categories = filters[0].getElementsByTagName("category").elements().names().toSet()
        assertEquals(
            setOf(
                "android.intent.category.HOME",
                "android.intent.category.DEFAULT",
                "android.intent.category.LAUNCHER",
                "android.intent.category.LEANBACK_LAUNCHER",
            ),
            categories,
        )
        val actions = filters[0].getElementsByTagName("action").elements().names()
        assertEquals(listOf("android.intent.action.MAIN"), actions)
        // No data element: the activity takes no deep link.
        assertEquals(0, filters[0].getElementsByTagName("data").length)
    }

    @Test
    fun serviceIsSpecialUseWithSubtype() {
        val service = components().first { it.getAttributeNS(ns, "name") == ".BoxService" }
        assertEquals("specialUse", service.getAttributeNS(ns, "foregroundServiceType"))
        val props = service.getElementsByTagName("property").elements()
        val subtype = props.first { it.getAttributeNS(ns, "name") == "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" }
        assertTrue(subtype.getAttributeNS(ns, "value").isNotBlank())
        assertEquals(0, service.getElementsByTagName("intent-filter").length)
    }

    @Test
    fun receiverTakesBootCompletedOnly() {
        val receiver = components().first { it.getAttributeNS(ns, "name") == ".BootReceiver" }
        val actions = receiver.getElementsByTagName("action").elements().names()
        assertEquals(listOf("android.intent.action.BOOT_COMPLETED"), actions)
    }

    @Test
    fun networkSecurityConfigNamesOnlyLoopback() {
        val doc = parse(File(mainDir, "res/xml/network_security_config.xml"))
        val domains = doc.getElementsByTagName("domain").elements().map { it.textContent.trim() }
        assertEquals(listOf("127.0.0.1"), domains)
        val base = doc.getElementsByTagName("base-config").elements().single()
        assertEquals("false", base.getAttribute("cleartextTrafficPermitted"))
        val domainConfigs = doc.getElementsByTagName("domain-config").elements()
        assertEquals(1, domainConfigs.size)
        assertEquals("true", domainConfigs[0].getAttribute("cleartextTrafficPermitted"))
        // No trust anchors beyond the platform default, no pinning of user certificates.
        assertEquals(0, doc.getElementsByTagName("trust-anchors").length)
    }

    @Test
    fun dataExtractionRulesBackUpNothing() {
        val doc = parse(File(mainDir, "res/xml/data_extraction_rules.xml"))
        assertEquals(0, doc.getElementsByTagName("include").length)
        // both channels exclude the file, sharedpref and database domains, as the whole domain and as "."
        for (channel in listOf("cloud-backup", "device-transfer")) {
            val ch = doc.getElementsByTagName(channel).item(0) as Element
            val ex = ch.getElementsByTagName("exclude").elements()
                .map { it.getAttribute("domain") to it.getAttribute("path") }.toSet()
            for (domain in listOf("file", "sharedpref", "database")) {
                assertTrue("$channel excludes $domain (root)", ex.contains(domain to ""))
                assertTrue("$channel excludes $domain (.)", ex.contains(domain to "."))
            }
        }
    }

    // ---- strings.xml (BM Malaysia, no AI punctuation) ----

    private fun stringsText(): String {
        val file = File(mainDir, "res/values/strings.xml")
        assertTrue(file.isFile)
        return file.readText(Charsets.UTF_8)
    }

    @Test
    fun stringsHaveNoDashesArrowsOrApproximationSigns() {
        // XML comment delimiters hold "-->", so scan the text without comments.
        val text = stringsText().replace(Regex("(?s)<!--.*?-->"), "")
        // Escapes written as code points so this file itself holds none of the characters.
        val banned = listOf(
            0x2014, 0x2013, 0x2012, 0x2015, // dashes
            0x2192, 0x2190, 0x21D2, 0x2794, 0x279C, // arrows
            0x2248, 0x2245, 0x223C, // approximation signs
        )
        for (cp in banned) {
            assertFalse("strings.xml holds U+%04X".format(cp), text.contains(String(Character.toChars(cp))))
        }
        assertFalse(text.contains("->"))
        assertFalse(text.contains("=>"))
    }

    @Test
    fun stringsAvoidIndonesianWords() {
        val words = Regex("""[\p{L}]+""").findAll(stringsText().lowercase()).map { it.value }.toList()
        val text = stringsText().lowercase()
        assertFalse(text.contains("dapat diunduh"))
        for (bad in listOf("unduh", "bisa", "diunduh", "mengunduh")) {
            assertFalse("word '$bad' is Indonesian, use Malaysian BM", words.contains(bad))
        }
    }

    @Test
    fun stringsKeyedAndNonEmpty() {
        val doc = parse(File(mainDir, "res/values/strings.xml"))
        val items = doc.getElementsByTagName("string").elements()
        assertTrue(items.isNotEmpty())
        val names = items.map { it.getAttribute("name") }
        assertEquals("duplicate string names", names.size, names.toSet().size)
        for (item in items) assertTrue(item.getAttribute("name"), item.textContent.isNotBlank())
        assertNotNull(items.firstOrNull { it.getAttribute("name") == "app_name" })
        assertEquals("MAX Kiosk Server", items.first { it.getAttribute("name") == "app_name" }.textContent)
    }
}
