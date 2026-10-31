package online.kolaysu.nfc

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.nfc.tech.NfcA
import android.nfc.tech.NfcV
import android.nfc.tech.Ndef
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject

/**
 * Android NFC okuyucu (reader mode). Yalnızca kartın kimlik doğrulamasız tanıma verilerini okur:
 * UID, teknoloji listesi, ATQA/SAK, ISO-DEP tarihsel baytları, NFC-V DSFID ve önbellekteki NDEF.
 * connect()/transceive() ÇAĞRILMAZ; hiçbir anahtar denemesi veya sektör okuması yapılmaz.
 * Sonuç, web sayfasının beklediği biçimde ({type:"card", card:{...}}) JSON olarak verilir.
 */
class NfcCardReader(
    private val activity: Activity,
    private val onEvent: (JSONObject) -> Unit,
) : NfcAdapter.ReaderCallback {

    private val adapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)

    fun status(): String = when {
        adapter == null -> "none"
        !adapter.isEnabled -> "off"
        else -> "on"
    }

    fun start() {
        val a = adapter ?: return onEvent(error("no_nfc"))
        if (!a.isEnabled) return onEvent(error("nfc_off"))
        val flags = NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
            NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
        a.enableReaderMode(activity, this, flags, Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250) })
    }

    fun stop() {
        adapter?.disableReaderMode(activity)
    }

    override fun onTagDiscovered(tag: Tag) {
        try {
            onEvent(JSONObject().put("type", "card").put("card", describe(tag)))
        } catch (e: Exception) {
            onEvent(error("io"))
        }
    }

    companion object {
        fun hex(b: ByteArray?): String? = b?.joinToString("") { "%02X".format(it) }

        fun error(code: String): JSONObject = JSONObject().put("type", "error").put("code", code)

        /** Tag nesnesinden yalnızca bağlantı gerektirmeyen alanları toplar. */
        fun describe(tag: Tag): JSONObject {
            val techs = tag.techList.toList()
            val o = JSONObject().put("uid", hex(tag.id)).put("techList", JSONArray(techs))
            NfcA.get(tag)?.let { o.put("atqa", hex(it.atqa)).put("sak", it.sak.toInt() and 0xFF).put("maxTransceive", it.maxTransceiveLength) }
            IsoDep.get(tag)?.let { o.put("historicalBytes", hex(it.historicalBytes ?: it.hiLayerResponse)) }
            NfcV.get(tag)?.let { o.put("dsfid", it.dsfId.toInt() and 0xFF) }
            val records = JSONArray()
            Ndef.get(tag)?.let { ndef ->
                o.put("ndefWritable", ndef.isWritable)
                ndef.cachedNdefMessage?.records?.take(8)?.forEach { r ->
                    val text = r.toUri()?.toString() ?: runCatching { String(r.payload, Charsets.UTF_8) }.getOrNull()
                    records.put(JSONObject().put("type", String(r.type, Charsets.US_ASCII)).put("text", text?.take(300)))
                }
            }
            o.put("ndefRecords", records)
            val c = CardCompatibility.classify(
                CardFacts(techs, o.optString("atqa", null), if (o.has("sak")) o.getInt("sak") else null, if (o.has("dsfid")) o.getInt("dsfid") else null),
            )
            o.put("standard", c.standard.label).put("family", c.family.label).put("secure", c.secure)
            return o
        }
    }
}
