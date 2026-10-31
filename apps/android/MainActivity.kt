package online.kolaysu.nfc

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * KolaySu web arayüzünü açan kabuk. NFC köprüsü (window.KolaySuNfc) yalnızca kolaysu.online
 * sayfalarına açılır; başka bir siteye gidilirse köprü çağrıları reddedilir.
 * Ödeme, hesap ve yükleme ekranları web sitesindekiyle aynıdır; uygulama yalnızca NFC okumayı ekler.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var reader: NfcCardReader

    /** Köprü çağrıları JS iş parçacığından gelir; açık sayfanın izinli olup olmadığı burada tutulur. */
    @Volatile private var currentPageAllowed = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                currentPageAllowed = url != null && isAllowed(Uri.parse(url))
                if (!currentPageAllowed) reader.stop()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                if (isAllowed(request.url)) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }
        reader = NfcCardReader(this) { ev -> dispatch(ev) }
        web.addJavascriptInterface(Bridge(), "KolaySuNfc")
        web.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        web.loadUrl(startUrl(intent))
    }

    override fun onPause() {
        super.onPause()
        reader.stop()
    }

    private fun dispatch(ev: JSONObject) = runOnUiThread {
        if (!currentPageAllowed) return@runOnUiThread
        val payload = JSONObject.quote(ev.toString())
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('kolaysu-nfc',{detail:$payload}))", null)
    }

    inner class Bridge {
        private fun pageAllowed() = currentPageAllowed

        @JavascriptInterface fun status(): String = if (pageAllowed()) reader.status() else "none"
        @JavascriptInterface fun startCardScan() { if (pageAllowed()) runOnUiThread { reader.start() } }
        @JavascriptInterface fun stopCardScan() { runOnUiThread { reader.stop() } }
    }

    companion object {
        const val HOME = "https://kolaysu.online/nfc/kart-tani"
        private val HOSTS = setOf("kolaysu.online", "www.kolaysu.online")

        fun isAllowed(u: Uri): Boolean = u.scheme == "https" && u.host in HOSTS

        /** Deep link (kolaysu://ac?yol=/...) ya da https bağlantısı; yalnızca kolaysu.online içi yollar açılır. */
        fun startUrl(i: Intent?): String {
            val d = i?.data ?: return HOME
            if (d.scheme == "https" && isAllowed(d)) return d.toString()
            val path = d.getQueryParameter("yol") ?: return HOME
            return if (path.startsWith("/") && !path.startsWith("//")) "https://kolaysu.online$path" else HOME
        }
    }
}
