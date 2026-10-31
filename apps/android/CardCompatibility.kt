package online.kolaysu.nfc

/**
 * Kart uyumluluk sınıflandırması. Android'e bağımlı değildir (JVM'de test edilebilir).
 * Yalnızca kimlik doğrulama gerektirmeyen tanıma verilerini kullanır: teknoloji listesi, ATQA, SAK, DSFID.
 * Kartın güvenli alanlarına (MIFARE sektörleri, DESFire uygulamaları, SAM korumalı bloklar) erişmez.
 */
enum class NfcStandard(val label: String) {
    ISO14443A("ISO/IEC 14443-A"),
    ISO14443B("ISO/IEC 14443-B"),
    ISO15693("ISO/IEC 15693 (NFC-V)"),
    FELICA("JIS X 6319-4 (FeliCa)"),
    UNKNOWN("Bilinmiyor"),
}

enum class CardFamily(val label: String) {
    MIFARE_CLASSIC("MIFARE Classic"),
    MIFARE_ULTRALIGHT("MIFARE Ultralight / NTAG"),
    MIFARE_DESFIRE("MIFARE DESFire / ISO-DEP"),
    ISO_DEP("ISO-DEP akıllı kart"),
    ICODE("ICODE / ISO 15693 etiket"),
    FELICA("FeliCa"),
    UNKNOWN("Tanınmayan kart"),
}

data class CardFacts(
    val techList: List<String>,
    val atqaHex: String? = null,
    val sak: Int? = null,
    val dsfid: Int? = null,
    val ndefWritable: Boolean? = null,
    val ndefEmpty: Boolean? = null,
    val ndefIsKolaySu: Boolean? = null,
)

data class Compatibility(
    val standard: NfcStandard,
    val family: CardFamily,
    /** Kart kriptografik olarak korunuyor: kredi alanları yalnızca idare/üretici anahtarıyla erişilebilir. */
    val secure: Boolean,
    /** Uygulama kartı tanıyıp UID ile aboneliğe eşleştirebilir mi. */
    val canIdentify: Boolean,
    /** Uygulama bu karta KolaySu NDEF etiketi yazabilir mi (yalnızca boş/KolaySu'ya ait Ultralight/NTAG). */
    val canWriteKolaySuTag: Boolean,
    val notes: List<String>,
)

object CardCompatibility {
    private const val P = "android.nfc.tech."

    fun classify(f: CardFacts): Compatibility {
        val t = f.techList.filter { it.startsWith(P) }.map { it.removePrefix(P) }.toSet()
        val standard = when {
            "NfcA" in t -> NfcStandard.ISO14443A
            "NfcB" in t -> NfcStandard.ISO14443B
            "NfcV" in t -> NfcStandard.ISO15693
            "NfcF" in t -> NfcStandard.FELICA
            else -> NfcStandard.UNKNOWN
        }
        val sak = f.sak
        val family = when {
            "MifareClassic" in t || sak in setOf(0x08, 0x09, 0x18, 0x88) -> CardFamily.MIFARE_CLASSIC
            "MifareUltralight" in t || (sak == 0x00 && standard == NfcStandard.ISO14443A) -> CardFamily.MIFARE_ULTRALIGHT
            "IsoDep" in t && sak == 0x20 && f.atqaHex?.uppercase() in setOf("4403", "0344", "4400") -> CardFamily.MIFARE_DESFIRE
            "IsoDep" in t -> CardFamily.ISO_DEP
            standard == NfcStandard.ISO15693 -> CardFamily.ICODE
            standard == NfcStandard.FELICA -> CardFamily.FELICA
            else -> CardFamily.UNKNOWN
        }
        val secure = family in setOf(CardFamily.MIFARE_CLASSIC, CardFamily.MIFARE_DESFIRE, CardFamily.ISO_DEP, CardFamily.FELICA)
        val notes = mutableListOf<String>()
        if (secure) notes += "Kredi alanları idare/üretici anahtarlarıyla korunur; uygulama bu alanlara erişmez."
        if (family == CardFamily.MIFARE_CLASSIC && "MifareClassic" !in t) notes += "Telefon MIFARE Classic'i tam desteklemiyor; yalnızca seri numarası okunabilir."
        val writable = !secure &&
            family == CardFamily.MIFARE_ULTRALIGHT &&
            f.ndefWritable == true &&
            (f.ndefEmpty == true || f.ndefIsKolaySu == true)
        if (family == CardFamily.MIFARE_ULTRALIGHT && !writable) notes += "Etiket kilitli ya da başka bir uygulamaya ait; üzerine yazılmaz."
        return Compatibility(standard, family, secure, canIdentify = standard != NfcStandard.UNKNOWN, canWriteKolaySuTag = writable, notes = notes)
    }
}
