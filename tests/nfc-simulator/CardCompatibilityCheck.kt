// apps/android/CardCompatibility.kt için JVM kontrolü (Android cihaz gerekmez).
// Çalıştırma: docs/security-plan.md → "Android derleme kontrolü".
import online.kolaysu.nfc.*

private fun t(vararg x: String) = x.map { "android.nfc.tech.$it" }
private var failed = 0
private fun check(name: String, ok: Boolean) { println((if (ok) "✓ " else "✗ ") + name); if (!ok) failed++ }

fun main() {
    val classic = CardCompatibility.classify(CardFacts(t("NfcA", "MifareClassic", "NdefFormatable"), "0400", 0x08))
    check("MIFARE Classic → ISO 14443-A, güvenli, yazılmaz", classic.standard == NfcStandard.ISO14443A && classic.family == CardFamily.MIFARE_CLASSIC && classic.secure && !classic.canWriteKolaySuTag)
    val classicNoSupport = CardCompatibility.classify(CardFacts(t("NfcA"), "0400", 0x08))
    check("Classic desteklemeyen telefon uyarısı", classicNoSupport.family == CardFamily.MIFARE_CLASSIC && classicNoSupport.notes.any { "tam desteklemiyor" in it })
    val desfire = CardCompatibility.classify(CardFacts(t("NfcA", "IsoDep"), "4403", 0x20))
    check("DESFire → güvenli", desfire.family == CardFamily.MIFARE_DESFIRE && desfire.secure)
    val iso15693 = CardCompatibility.classify(CardFacts(t("NfcV"), dsfid = 0))
    check("ISO 15693 → ICODE, tanınır", iso15693.standard == NfcStandard.ISO15693 && iso15693.family == CardFamily.ICODE && iso15693.canIdentify)
    val typeB = CardCompatibility.classify(CardFacts(t("NfcB", "IsoDep")))
    check("ISO 14443-B → güvenli ISO-DEP", typeB.standard == NfcStandard.ISO14443B && typeB.secure)
    val emptyNtag = CardCompatibility.classify(CardFacts(t("NfcA", "MifareUltralight", "Ndef"), "4400", 0x00, ndefWritable = true, ndefEmpty = true))
    check("Boş NTAG → KolaySu etiketi yazılabilir", emptyNtag.canWriteKolaySuTag && !emptyNtag.secure)
    val foreignNtag = CardCompatibility.classify(CardFacts(t("NfcA", "MifareUltralight", "Ndef"), "4400", 0x00, ndefWritable = true, ndefEmpty = false, ndefIsKolaySu = false))
    check("Başka uygulamaya ait NTAG → yazılmaz", !foreignNtag.canWriteKolaySuTag)
    val locked = CardCompatibility.classify(CardFacts(t("NfcA", "MifareUltralight", "Ndef"), "4400", 0x00, ndefWritable = false, ndefEmpty = true))
    check("Kilitli NTAG → yazılmaz", !locked.canWriteKolaySuTag)
    val unknown = CardCompatibility.classify(CardFacts(listOf("x.y.Z")))
    check("Bilinmeyen → tanınmaz", unknown.standard == NfcStandard.UNKNOWN && !unknown.canIdentify)
    if (failed > 0) { println("$failed kontrol başarısız"); kotlin.system.exitProcess(1) }
    println("Tüm Android uyumluluk kontrolleri geçti.")
}
