# Güvenlik tasarımı

## Kimlik doğrulama
- Parolalar scrypt ile özetlenir; en az 12 karakter, büyük/küçük harf ve rakam içermeli. Kayıt ve parola sıfırlama hesap varlığını ele vermez.
- E-posta doğrulaması zorunludur. Doğrulama/sıfırlama/davet belirteçleri tek kullanımlıktır ve veritabanında yalnızca SHA-256 özeti tutulur.
- Oturum belirteçleri rastgele 32 bayttır ve özet olarak saklanır. Web: `httpOnly`, `Secure` (üretim), `SameSite=Strict` çerez + CSRF çift gönderim. Mobil: Bearer, cihaz güvenli deposunda.
- 5 hatalı girişte 15 dakika kilit; IP başına hız sınırı.
- Yeni IP + tarayıcı birleşimiyle girişte kullanıcıya "şüpheli giriş" bildirimi ve e-postası.
- Parola sıfırlama/değiştirme diğer tüm oturumları sonlandırır; kullanıcı oturumlarını görüp kapatabilir.

## MFA
- TOTP (RFC 6238, 30 sn, ±1 adım), aynı adımın tekrar kullanımı engellenir. 10 tek kullanımlık kurtarma kodu.
- Personel (SUPPORT, FINANCE, SUPER_ADMIN) için MFA zorunlu; MFA kurmadan yönetim izinleri çalışmaz ve personel MFA'yı kapatamaz.
- Hassas işlemler (anahtar girme, canlıya geçiş, iade onayı, rol değişikliği) son 15 dakika içinde MFA doğrulaması ister.
- Yalnızca SMS ile MFA desteklenmez.

## Yetkilendirme
- Rol tabanlı; izinler her istekte veritabanından okunur (rol geri alındığında anında etkili).
- Kullanıcı yalnızca kendi kayıtlarına erişir (her sorguda `user_id` eşleşmesi).
- İstemciden durum, ücret, rol gibi alanlar kabul edilmez (`.strict()` şemalar).

## Gizli bilgiler
- Kaynak kodda, istemcide, Git'te gizli bilgi yoktur. `.env` Git dışıdır; `.env.example` yalnızca yer tutucu içerir.
- Sağlayıcı anahtarları AES-256-GCM ile şifreli tutulur (AAD = referans; başka referansa taşınan şifreli metin çözülemez) veya harici secret manager referansı olarak kaydedilir. **Not:** Harici secret manager'dan değer okuma bu sürümde uygulanmadı (dağıtım ortamına göre eklenmeli); şu an yalnızca yerel şifreli kasa çalışır.
- API anahtarları istemciye, günlüğe veya hata mesajına yazılmaz; günlüklerde redaksiyon yolları tanımlıdır.
- Test ve canlı referansları biçim olarak ayrıdır (`payment/test/...`, `payment/live/...`) ve çapraz kullanım reddedilir.

## Ödeme güvenliği
- Kart verisi platforma hiç gelmez; ödeme sağlayıcının barındırılan sayfasında alınır (PCI DSS kapsamı daraltılır).
- Webhook: ham gövde üzerinden HMAC, zaman damgası penceresi, `event_id` tekilliği (tekrar oynatma), tutar/para birimi eşleşmesi ve sağlayıcıdan durum sorgusu ile çift kontrol.
- Idempotency anahtarı (kullanıcı + anahtar tekil) ve satır kilitleri; zaman aşımında körlemesine yeniden gönderim yok.

## Web güvenliği
- Helmet ile katı CSP, HSTS (üretim), `X-Frame-Options`, `Referrer-Policy`.
- CORS izin listesi; üretimde https dışı istek reddi.
- CSV dışa aktarımlarında formül enjeksiyonu kaçışı.

## Denetim
- `audit_logs` eklemeli (append-only): UPDATE/DELETE tetikleyiciyle engellenir. Kim, ne zaman, hangi IP'den, hangi kayıtta, önce/sonra (redakte edilmiş) bilgisi.
- Rol verme/alma, anahtar değişikliği, canlı mod denemeleri (engellenenler dahil), iade onayları, yayın öncesi kontrol doğrulamaları kaydedilir.

## Bilinen sınırlamalar ve öneriler
- Bağımsız sızma testi yapılmadı (yayın öncesi zorunlu).
- WebAuthn/donanım anahtarı desteği önerilir.
- Üretimde KMS ile anahtar şifreleme ve düzenli anahtar döndürme önerilir.
- WAF ve DDoS koruması altyapı katmanında sağlanmalıdır.
