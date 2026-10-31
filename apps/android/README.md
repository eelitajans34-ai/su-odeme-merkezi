# KolaySu Android (NFC)

| Dosya | Görev |
|---|---|
| `NfcCardReader.kt` | Reader mode ile kart tanıma (NfcA/B/F/V). Yalnızca bağlantısız alanlar; olayı web sayfasına `kolaysu-nfc` olarak iletir. |
| `CardCompatibility.kt` | ISO 14443-A/B, ISO 15693, FeliCa ve kart ailesi tespiti; güvenli kart işareti. Android'e bağımlı değil. |
| `NfcWriteService.kt` | Yalnızca boş/KolaySu'ya ait NTAG'a sayaç bağlantısı yazar. Kredi yazma yolu yoktur. |
| `MainActivity.kt` | kolaysu.online'ı açan WebView kabuğu; `window.KolaySuNfc` köprüsü yalnızca kolaysu.online'a açılır. |
| `AndroidManifest.xml` | NFC izni (zorunlu değil), `kolaysu://ac?yol=/...` derin bağlantısı. |

Bu dosyalar bir Android Studio projesinin `app/src/main/java/online/kolaysu/nfc/` klasörüne konur (`androidx.appcompat` bağımlılığı gerekir).
Mevcut sitede çalışan Java köprüsü `pixel-perfect-render-1376/native/android-nfc` altındadır; bu Kotlin sürümü aynı olay biçimini kullanır.
