# BUSKİ entegrasyonu

Durum: **kapalı**. Gerçek bağlantı için aşağıdaki belgeler BUSKİ'den yazılı olarak alınmalıdır.
Bunlar gelene kadar `createBuskiAdapter()` `{ disabled: true }` döner ve hiçbir istek BUSKİ'ye gitmez.

## Gerekenler

| Gereken | Neden | Nereye konur |
|---|---|---|
| Yazılı entegrasyon izni / sözleşme no | Abone adına yükleme yetkisi | `BUSKI_AUTHORIZATION_REF` (sunucu ortam değişkeni) |
| API adresi (https) | Abone doğrulama ve yükleme | `BUSKI_BASE_URL` |
| API anahtarı | Kimlik doğrulama | `BUSKI_API_KEY` (gizli kasa) |
| İmza anahtarı | İstek bütünlüğü (HMAC-SHA256) | `BUSKI_SIGNING_SECRET` (gizli kasa) |
| Test ortamı | Canlıdan önce uçtan uca deneme | Ayrı adres ve anahtar |
| Kartlı sayaç SDK'sı (üretici) | Krediyi karta yazmak | Yalnızca üreticinin güvenli ortamında |

Anahtarlar koda, Android uygulamasına veya web istemcisine **konmaz**.

## Önerilen protokol (BUSKİ'ye sunulacak taslak)

Tüm istekler `POST`, gövde JSON, başlıklar:

- `authorization: Bearer <API anahtarı>`
- `x-kolaysu-timestamp: <unix saniye>`
- `x-kolaysu-signature: hex(HMAC_SHA256(imza_anahtarı, timestamp + "." + gövde))`
- `idempotency-key: <sipariş no>` (yalnızca yükleme)

### `POST /abone-dogrula`
İstek: `{ subscriberNo, meterNo, cardNo, meterType }` → Yanıt: `{ valid: boolean, message? }`

### `POST /yukleme`
İstek: `{ subscriberNo, meterNo, cardNo, meterType, orderNo, m3, amountKurus, paidAt }`
Yanıt: `{ success: boolean, reference: string }`

Aynı `orderNo` ikinci kez gelirse BUSKİ yeni yükleme yapmamalı, ilk `reference` değerini döndürmelidir (HTTP 200 ya da 409).
`reference` olmadan gelen "başarılı" yanıt KolaySu tarafından tamamlanmış sayılmaz.

## Akış

1. Kullanıcı aboneliğini ekler → `/abone-dogrula` → abonelik `verified`.
2. Sunucu fiyatı hesaplar (`pricing.ts`), sipariş açar (`SK…` no).
3. Ödeme kuruluşunun imzalı bildirimi doğrulanır (`payments.ts`). Tutar uyuşmazsa iade sürecine alınır.
4. `/yukleme` çağrılır. Hata olursa 2, 4, 8, 16, 32 dk sonra tekrar; 6. denemeden sonra iade.
5. Kartlı sayaçta kredi karta **yalnızca yetkili SDK** ile aktarılır. SDK yokken kart adımı simülasyondur.

## Canlıya geçiş kontrol listesi

- [ ] BUSKİ yazılı izni ve test ortamı alındı
- [ ] Test ortamında uçtan uca 20+ işlem, mükerrer bildirim ve zaman aşımı senaryoları denendi
- [ ] Ödeme kuruluşu canlı sözleşmesi ve tahsilat/emanet hesabı hazır
- [ ] Veritabanı göçü önce test veritabanında, sonra onayla canlıda çalıştırıldı
- [ ] Proje sahibinin yazılı onayı alındı
