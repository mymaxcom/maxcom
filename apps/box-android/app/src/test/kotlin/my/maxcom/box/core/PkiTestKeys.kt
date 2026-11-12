package my.maxcom.box.core

import java.security.KeyFactory
import java.security.KeyPair
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * Fixed TEST keys (P-256) so the committed Dart fixtures can be remade byte-for-byte in key material.
 * They protect nothing: they exist only in tests and in apps/surau-app/test/fixtures/android-box-pki.
 */
object PkiTestKeys {
    private const val ROOT_A_PKCS8 =
        "3041020100301306072a8648ce3d020106082a8648ce3d0301070427302502010104206e0d72ec926339adbabb00fa2a1bc38903b9d30a73dfcc5a4eb78847f7e572c8"
    private const val ROOT_A_SPKI =
        "3059301306072a8648ce3d020106082a8648ce3d030107034200040e3311b8e46a05e3e1120dd8cef0a80d3358285ac613984180120a86213508db9b947e683004019a9a6cdea02759dba0eff390b11d3ca956f3adb79e16393fc6"
    private const val ROOT_B_PKCS8 =
        "3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420aaa3b894078fc4fe44615b88986382bda24653534f64f418f90de9edd640494b"
    private const val ROOT_B_SPKI =
        "3059301306072a8648ce3d020106082a8648ce3d03010703420004512c0c0597934541e981ecf28d0e2a7ec5f23d1588be47d6565fdd90c2077eb1bd40034ec71d836d4e6e4f5b77a0071ef98ff9c0c4ef25731b6b01f6b81905f0"
    private const val LEAF_PKCS8 =
        "3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420b7da75e74c29e608763fe7ef705b594d60e787126c478054e5848859c467384a"
    private const val LEAF_SPKI =
        "3059301306072a8648ce3d020106082a8648ce3d03010703420004d32e31c9204be16be0293bc82a95d8f8491a3883f6e80cc95682b4af3bfa668e9814a29e84d571d473c57e4ca2fce1ac964a51d7b5beba2449de18ef7d2ee69d"

    val rootA: SoftwareCaSigner get() = signer(ROOT_A_PKCS8, ROOT_A_SPKI)
    val rootB: SoftwareCaSigner get() = signer(ROOT_B_PKCS8, ROOT_B_SPKI)
    val leaf: KeyPair get() = pair(LEAF_PKCS8, LEAF_SPKI)

    private fun signer(pkcs8: String, spki: String) = SoftwareCaSigner(pair(pkcs8, spki))

    private fun pair(pkcs8: String, spki: String): KeyPair {
        val f = KeyFactory.getInstance("EC")
        return KeyPair(
            f.generatePublic(X509EncodedKeySpec(BoxCa.hexToBytes(spki))),
            f.generatePrivate(PKCS8EncodedKeySpec(BoxCa.hexToBytes(pkcs8))),
        )
    }
}
