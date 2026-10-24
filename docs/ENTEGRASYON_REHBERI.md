# Gerçek entegrasyon ekleme rehberi

Gerçek bir ödeme kuruluşu veya su idaresi adaptörü **yalnızca** şu koşullarda yazılır:
1. Kurumun resmî teknik dokümanı (uç noktalar, istek/yanıt şemaları, hata kodları, imza yöntemi),
2. Test ortamı erişimi ve test kimlik bilgileri,
3. Yazılı izin / sözleşme.

Doküman olmadan tahmine dayalı kod yazılmaz; web sayfası kazıma veya yetkisiz erişim kullanılmaz.

## Ödeme kuruluşu adaptörü

`apps/api/src/integrations/payment/types.ts` içindeki `PaymentProviderAdapter` arayüzünü uygulayın:

| Metot | Beklenen davranış |
|---|---|
| `createPayment` | Barındırılan ödeme sayfası oluştur; `checkoutUrl` dön. `orderRef` sağlayıcıya sipariş no olarak gönderilmeli |
| `verifyWebhook` | Ham gövde ve başlıklardan imzayı sağlayıcının belgelediği yöntemle doğrula; zaman damgası toleransı uygula; normalize edilmiş olay dön |
| `getPaymentStatus` | Webhook çift kontrolü ve belirsiz durumlar için zorunlu |
| `refund` | Sağlayıcının iade API'si; sonuç SUBMITTED ise tamamlanma webhook veya durum sorgusuyla gelir |
| `listTransactions` | Mutabakat için |
| `testConnection` | Yan etkisiz bir doğrulama çağrısı |

Kurallar: anahtarlar yalnızca `ctx` üzerinden gelir, asla günlüğe yazılmaz; ağ hataları ve zaman aşımları **belirsiz** kabul edilir, başarısız değil; tutarlar kuruş (tamsayı).

Kayıt: `registry.ts` içinde `registerPayment(new XyzAdapter())`. Ardından Yönetim → Güvenli Ödeme Hizmeti → B'de sağlayıcının `adapter_code` alanı bu kodla eşleştirilir.

## Su idaresi adaptörü

`apps/api/src/integrations/utility/types.ts` içindeki `WaterUtilityAdapter`:

- `submitTopup` / `submitBillPayment`: `utilityRequestId` her denemede **aynıdır**; kurum idempotency destekliyorsa bu değer gönderilmelidir. Zaman aşımı → `AMBIGUOUS` (asla `REJECTED` değil).
- `getTopupStatus` / `getCollectionStatus`: işçi belirsiz işlemler için bunu çağırır. `NOT_FOUND` dönerse işçi aynı `utilityRequestId` ile yeniden gönderir.
- `CONFIRMED` yalnızca kurumun resmî teyidiyle dönülmelidir; "Fatura ödendi" ve "Yükleme tamamlandı" bu sonuca dayanır.
- `parseQr`: kurumun QR biçimi belgelenmişse.

## Test

Simülatörler (`sandbox.ts`) arayüz davranışının örneğidir. Yeni adaptör için:
1. Kurumun test ortamına karşı entegrasyon testleri (CI dışında, gizli bilgiler secret manager'dan),
2. Kabul testlerindeki senaryoların (13.x) gerçek test ortamında tekrarı,
3. Sonuçların yayın öncesi kontrol listesine kanıt olarak eklenmesi.
