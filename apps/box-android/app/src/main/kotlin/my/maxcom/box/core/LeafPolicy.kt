package my.maxcom.box.core

import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Duration
import java.time.Instant

/** What the service does with the box leaf certificate right now. */
sealed class LeafDecision {
    /** The current leaf is fine; do nothing (the caller logs SKIP). */
    object Skip : LeafDecision()

    /** Make a new leaf; [reason] is a short English line for `cert-renew.log`. */
    data class Issue(val reason: String) : LeafDecision()

    /** The clock is older than the APK itself: issue nothing, tell the user to wait for network time. */
    object WaitForClock : LeafDecision()
}

object LeafPolicy {
    const val DEFAULT_THRESHOLD_DAYS = 60

    /** [wantedName] value meaning "the leaf must carry no box name" (the box has no name now). */
    const val NO_NAME = ""

    /**
     * Decides whether the leaf in [currentLeafDer] (null when there is none) must be replaced.
     *
     * - [now] before [buildTime] (a TV box has no clock battery, so the clock is wrong): a usable existing
     *   leaf is still [LeafDecision.Skip]; whenever a new leaf would be needed the answer is
     *   [LeafDecision.WaitForClock], because a certificate dated from a wrong clock would be refused by phones.
     * - no leaf, an unreadable leaf, a leaf not signed by [rootDer] (when given), a leaf without the two
     *   DNS names, fewer than [thresholdDays] days left (an expired leaf included), or a different set of
     *   IP addresses: [LeafDecision.Issue].
     * - [checkKey] true: [leafKeyPem] (null when the file is missing) must be the private key of the leaf,
     *   otherwise [LeafDecision.Issue]; this heals a torn leaf/key pair at the next certify.
     * - V2 root (new generation, see [BoxCa.rootGeneration]): the leaf must carry `localhost` and, when [wantedName]
     *   is a name, exactly that numbered name (any other `boxN-surau.local` in it means "box name changed");
     *   [wantedName] null leaves the name alone, [NO_NAME] wants none. A legacy root (or none given) keeps the
     *   two legacy names and ignores [wantedName].
     * - [wantedIps] empty (no usable network at the moment) with a good leaf: [LeafDecision.Skip], because
     *   there is nothing to name; the same list in another order is the same list.
     */
    fun decide(
        currentLeafDer: ByteArray?,
        wantedIps: List<String>,
        now: Instant,
        buildTime: Instant,
        thresholdDays: Int = DEFAULT_THRESHOLD_DAYS,
        rootDer: ByteArray? = null,
        leafKeyPem: String? = null,
        checkKey: Boolean = false,
        wantedName: String? = null,
    ): LeafDecision {
        val d = evaluate(currentLeafDer, wantedIps, now, thresholdDays, rootDer, leafKeyPem, checkKey, wantedName)
        return if (d is LeafDecision.Issue && now.isBefore(buildTime)) LeafDecision.WaitForClock else d
    }

    private fun evaluate(
        currentLeafDer: ByteArray?,
        wantedIps: List<String>,
        now: Instant,
        thresholdDays: Int,
        rootDer: ByteArray?,
        leafKeyPem: String?,
        checkKey: Boolean,
        wantedName: String?,
    ): LeafDecision {
        if (currentLeafDer == null) return LeafDecision.Issue("no certificate yet")
        val leaf = parse(currentLeafDer) ?: return LeafDecision.Issue("certificate unreadable")

        if (rootDer != null) {
            val root = parse(rootDer) ?: return LeafDecision.Issue("root unreadable")
            try {
                leaf.verify(root.publicKey)
            } catch (e: java.security.GeneralSecurityException) {
                return LeafDecision.Issue("certificate is not signed by the root")
            }
        }

        if (checkKey && (leafKeyPem == null || !BoxCa.keyMatchesPublic(leafKeyPem, leaf.publicKey))) {
            return LeafDecision.Issue("leaf key missing or does not match the certificate")
        }

        val ips = HashSet<String>()
        val dns = HashSet<String>()
        try {
            for (entry in leaf.subjectAlternativeNames ?: emptyList()) {
                val kind = entry[0] as? Int ?: continue
                val value = entry[1] as? String ?: continue
                if (kind == 7) ips.add(value) else if (kind == 2) dns.add(value.lowercase())
            }
        } catch (e: java.security.cert.CertificateParsingException) {
            return LeafDecision.Issue("certificate names unreadable")
        }
        val v2 = rootDer != null && BoxCa.rootGeneration(rootDer) == RootGeneration.V2
        if (v2) {
            if (!dns.contains("localhost")) return LeafDecision.Issue("certificate names changed")
            if (wantedName != null) {
                val have = dns.filter { BoxName.parse(it) != null }.toSet()
                val want = if (wantedName == NO_NAME) emptySet() else setOf(wantedName)
                if (have != want) return LeafDecision.Issue("box name changed")
            }
        } else if (!dns.containsAll(BoxCa.PERMITTED_DNS)) {
            return LeafDecision.Issue("certificate names changed")
        }

        val limit = leaf.notAfter.toInstant().minus(Duration.ofDays(thresholdDays.toLong()))
        if (!now.isBefore(limit)) {
            val left = Duration.between(now, leaf.notAfter.toInstant()).toDays()
            return LeafDecision.Issue(if (left < 0) "certificate expired" else "certificate expires in $left days")
        }

        if (wantedIps.isNotEmpty() && ips != wantedIps.toSet()) return LeafDecision.Issue("LAN addresses changed")
        return LeafDecision.Skip
    }

    private fun parse(der: ByteArray): X509Certificate? = try {
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as? X509Certificate
    } catch (e: java.security.cert.CertificateException) {
        null
    }
}
