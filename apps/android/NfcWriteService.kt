package online.kolaysu.nfc

import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.Tag
import android.nfc.tech.Ndef

/**
 * Yazma servisi. TEK izin verilen işlem: boş ya da zaten KolaySu'ya ait, kilitsiz bir
 * MIFARE Ultralight/NTAG etikete KolaySu sayaç bağlantısı (NDEF URL kaydı) yazmak.
 *
 * Yapılmayanlar (kod yolu yoktur):
 *  - Su kartına kredi/bakiye yazma. Bu yalnızca idare/üretici SDK'sıyla, onların anahtarlarıyla yapılır.
 *  - MIFARE Classic sektörlerine, DESFire uygulamalarına, ISO-DEP APDU'larına erişim.
 *  - Etiketi kalıcı salt-okunur yapma (makeReadOnly) ya da başka uygulamaya ait içeriği silme.
 */
class NfcWriteService(private val enabled: Boolean) {

    sealed class Result {
        data class Written(val url: String) : Result()
        data class Refused(val code: String, val message: String) : Result()
    }

    fun writeMeterTag(tag: Tag, token: String, userConfirmed: Boolean): Result {
        if (!enabled) return Result.Refused("disabled", "Etiket yazma bu sürümde kapalı.")
        if (!userConfirmed) return Result.Refused("not_confirmed", "Kullanıcı onayı olmadan yazılmaz.")
        if (!TOKEN.matches(token)) return Result.Refused("bad_token", "Geçersiz sayaç kodu.")
        val ndef = Ndef.get(tag) ?: return Result.Refused("not_ndef", "Bu kart NDEF etiketi değil; yazılmaz.")
        val cached = ndef.cachedNdefMessage
        val facts = CardFacts(
            techList = tag.techList.toList(),
            ndefWritable = ndef.isWritable,
            ndefEmpty = cached == null || cached.records.all { it.tnf == NdefRecord.TNF_EMPTY },
            ndefIsKolaySu = cached?.records?.any { isKolaySu(it.toUri()?.toString()) } == true,
        )
        val c = CardCompatibility.classify(facts)
        if (c.secure) return Result.Refused("secure_card", "Güvenli su kartlarına yazılmaz.")
        if (!c.canWriteKolaySuTag) return Result.Refused("not_allowed", c.notes.firstOrNull() ?: "Bu etikete yazılamaz.")
        val url = "$BASE$token"
        val msg = NdefMessage(arrayOf(NdefRecord.createUri(url)))
        if (msg.byteArrayLength > ndef.maxSize) return Result.Refused("too_small", "Etiket kapasitesi yetersiz.")
        return try {
            ndef.connect()
            ndef.writeNdefMessage(msg)
            Result.Written(url)
        } catch (e: Exception) {
            Result.Refused("io", "Yazma tamamlanamadı; kartı sabit tutup tekrar deneyin.")
        } finally {
            runCatching { ndef.close() }
        }
    }

    companion object {
        const val BASE = "https://kolaysu.online/nfc/etiket?t="
        val TOKEN = Regex("^[A-Za-z0-9_-]{16,64}$")
        fun isKolaySu(url: String?) = url != null && url.startsWith(BASE)
    }
}
