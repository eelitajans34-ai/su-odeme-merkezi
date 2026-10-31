# Güvenlik planı

## Temel kurallar

1. **Gerçek para ve gerçek su kredisi izinsiz hareket etmez.** Canlı ödeme sağlayıcısı (`liveProvider()`) ve canlı kart yazıcı (`LIVE_CARD_WRITER`) `null`'dır. Ortam değişkeni ya da ayarla açılamaz; kod değişikliği + onay gerekir.
2. **Kartın güvenli alanlarına erişilmez.** Android uygulaması `connect()`/`transceive()` çağırmaz, anahtar denemez, sektör okumaz. Yalnızca UID, teknoloji listesi, ATQA/SAK, tarihsel baytlar, DSFID ve önbellekteki NDEF okunur.
3. **Tek yazma işlemi:** boş ya da zaten KolaySu'ya ait, kilitsiz Ultralight/NTAG etikete sayaç bağlantısı (NDEF URL). Kullanıcı onayı şart, `makeReadOnly` yok. Güvenli kartlarda (Classic, DESFire, ISO-DEP, FeliCa) reddedilir.
4. **Gizli anahtarlar uygulamada yok.** Ödeme, BUSKİ ve UID karma anahtarları yalnızca sunucu ortamında/kasada.
5. **Açık kart UID'i saklanmaz.** `HMAC-SHA256(pepper, "nfc-uid:v1:" + UID)`; pepper ≥ 32 karakter.
6. **Mevcut site ve veritabanına dokunulmaz.** Yeni tablolar ayrı `water_topup` şemasında. Hiçbir `drop`/`alter` mevcut tabloya uygulanmaz.

## Mükerrer işlem koruması (iki katman)

| Risk | Servis | Veritabanı |
|---|---|---|
| Aynı ödeme bildirimi tekrar gelir | `applyPayment` ikinci kez teslim etmez | `payment_events (provider, provider_ref, status)` UNIQUE |
| Çift tıklama ile iki sipariş | — | `topup_orders_one_open_uq` |
| Aynı sipariş idareye iki kez | `idempotency-key = orderNo` | `order_no` UNIQUE |
| Aynı siparişe iki kart işlemi | `startCardOperation` → `duplicate` | `card_operations_one_per_order_uq` |
| Geçersiz durum geçişi / tutar değiştirme | `transition` | `guard_order_transition` tetikleyicisi |
| Canlı kart işlemi | `live_disabled` | `block_live_card_ops` tetikleyicisi |

## Web NFC olmayan cihazlar

iPhone ve masaüstü tarayıcılar Web NFC desteklemez. Bu cihazlarda web arayüzü KolaySu Android uygulamasına yönlendirir (`kolaysu://ac?yol=/nfc/kart-tani`); iPhone'da kart numarasını elle girme seçeneği sunulur. Uygulamanın NFC köprüsü (`window.KolaySuNfc`) yalnızca `https://kolaysu.online` sayfalarına açılır.

## Testler

```bash
npm install
npm run typecheck
npm test            # nfc-simulator, payment-sandbox, topup-workflow
```

### Veritabanı göçü kontrolü (yerel, geçici Postgres)

```bash
initdb -D /tmp/pg -A trust && pg_ctl -D /tmp/pg -o "-p 5499" start
psql -p 5499 -d postgres -v ON_ERROR_STOP=1 -f database/migrations/0001_water_topup.sql   # iki kez çalıştırılabilir
```

### Android derleme kontrolü

Android SDK olmadan, Kotlin derleyicisi ve Android API taslaklarıyla tür denetimi yapılabilir; tam APK için Android Studio / Gradle (Android Gradle Plugin) gerekir.
`tests/nfc-simulator/CardCompatibilityCheck.kt`, `CardCompatibility.kt` kurallarını JVM üzerinde dener:

```bash
kotlinc apps/android/CardCompatibility.kt tests/nfc-simulator/CardCompatibilityCheck.kt -include-runtime -d chk.jar && java -jar chk.jar
```

## Canlıya geçiş onayı

Üretime (kolaysu.online, canlı Supabase, Play Store) hiçbir değişiklik proje sahibinin yazılı onayı olmadan gönderilmez. Sırası: test veritabanı → sandbox uçtan uca → onay → canlı göç → canlı yayın.
