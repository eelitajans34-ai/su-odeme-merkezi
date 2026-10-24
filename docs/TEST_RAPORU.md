# Test raporu

Tarih: 2026-10-24 · Ortam: Node 22, PostgreSQL (yerel), Vitest 5

**Sonuç: 43/43 test geçti.** API tip denetimi ve web tip denetimi temiz, web üretim derlemesi başarılı, `npm audit --omit=dev --audit-level=high`: 0 açık.

Testler gerçek PostgreSQL üzerinde çalışır (bellek içi taklit veritabanı yoktur). Dış sistemler (ödeme kuruluşu, su idaresi) yalnızca geliştirme simülatörüyle temsil edilir; bu nedenle testler **gerçek entegrasyonun çalıştığını kanıtlamaz**, platformun kurallarını (durum makinesi, yetki, idempotency, imza doğrulama, dürüst durum gösterimi) doğrular.

## Talimat 13. bölüm kabul senaryoları ve ek güvenlik testleri

| Dosya | Grup | Test | Sonuç |
|---|---|---|---|
| acceptance.test.ts | 13.1 Yetkisiz kullanıcı süper yönetici paneline erişemez | oturumsuz istek 401, normal kullanıcı 403 alır | Geçti |
| acceptance.test.ts | 13.2 Süper yönetici MFA olmadan hassas işlemleri tamamlayamaz | MFA kurulmamış süper yönetici reddedilir | Geçti |
| acceptance.test.ts | 13.2 Süper yönetici MFA olmadan hassas işlemleri tamamlayamaz | MFA doğrulanmamış oturum ve süresi geçmiş MFA ile hassas işlem reddedilir | Geçti |
| acceptance.test.ts | 13.3 Kullanıcı başka bir kişinin aboneliğini görüntüleyemez | başka kullanıcının aboneliği, kartı ve işlemi 404 döner | Geçti |
| acceptance.test.ts | 13.4 Başarısız ödeme başarılı olarak gösterilmez | başarısız ödeme FAILED olur, makbuz oluşmaz, yükleme emri gönderilmez | Geçti |
| acceptance.test.ts | 13.5 Aynı istek iki kez geldiğinde mükerrer yükleme gerçekleşmez | aynı Idempotency-Key tek işlem üretir (eşzamanlı istekler dahil) | Geçti |
| acceptance.test.ts | 13.5 Aynı istek iki kez geldiğinde mükerrer yükleme gerçekleşmez | aynı webhook iki kez gelse ve işçi tekrar çalışsa bile su idaresine tek emir gider | Geçti |
| acceptance.test.ts | 13.6 Ödeme başarılı fakat su idaresi cevabı belirsizse işlem UNKNOWN/PENDING kalır | zaman aşımı → UNKNOWN; durum sorgusu bekliyor → TOPUP_PENDING; asla COMPLETED olmaz, emir tekrarlanmaz | Geçti |
| acceptance.test.ts | 13.6 Ödeme başarılı fakat su idaresi cevabı belirsizse işlem UNKNOWN/PENDING kalır | su idaresi reddederse iade süreci başlar (otomatik başarılı iade sayılmaz) | Geçti |
| acceptance.test.ts | 13.7 Resmî teyit olmadan fatura ödenmiş olarak gösterilmez | ödeme alındı ama tahsilat teyidi yok → "Fatura ödendi" yazmaz; teyit sonrası yazar | Geçti |
| acceptance.test.ts | 13.8 Webhook imzası geçersizse olay reddedilir | geçersiz imza, eksik imza ve eski zaman damgası reddedilir; işlem değişmez | Geçti |
| acceptance.test.ts | 13.9 Gizli anahtarlar istemciye ve günlük kayıtlarına sızmaz | girilen anahtar hiçbir yanıtta, denetim kaydında veya veritabanında düz metin olarak bulunmaz | Geçti |
| acceptance.test.ts | 13.9 Gizli anahtarlar istemciye ve günlük kayıtlarına sızmaz | günlük yazıcısı gizli alanları maskeler | Geçti |
| acceptance.test.ts | 13.10 İade işlemi yetki kontrolünden geçmeden gerçekleştirilemez | kullanıcı ve destek personeli iade onaylayamaz; yetkili yönetici onaylar, sonuç sağlayıcıdan doğrulanınca REFUNDED olur | Geçti |
| acceptance.test.ts | 13.10 İade işlemi yetki kontrolünden geçmeden gerçekleştirilemez | iade API'si yoksa düğme başarılı sonuç üretmez (MANUAL_ACTION_REQUIRED) | Geçti |
| acceptance.test.ts | 13.11 Yönetici rolü istemci tarafında değiştirilemez | kayıtta rol alanı reddedilir; süper yönetici e-postasıyla kayıt yönetici yetkisi vermez | Geçti |
| acceptance.test.ts | 13.11 Yönetici rolü istemci tarafında değiştirilemez | kullanıcı profil veya rol uçlarıyla kendine yetki veremez | Geçti |
| acceptance.test.ts | 13.11 Yönetici rolü istemci tarafında değiştirilemez | CSRF belirteci olmadan çerezli istek reddedilir | Geçti |
| acceptance.test.ts | 13.12 Veritabanı migrationları mevcut verileri korur | ara sürümde eklenen veri sonraki migrationlardan sonra korunur; değiştirilmiş migration reddedilir | Geçti |
| acceptance.test.ts | 13.13 Yedekten geri yükleme yapılabilir | pg_dump ile alınan yedek yeni veritabanına geri yüklenir ve veriler eşleşir | Geçti |
| acceptance.test.ts | 13.14 Test modundaki işlemler gerçek ödeme veya gerçek yükleme oluşturmaz | işlem ve makbuz TEST olarak etiketlenir; simülatör üretim yapılandırmasında yoktur | Geçti |
| acceptance.test.ts | 13.14 Test modundaki işlemler gerçek ödeme veya gerçek yükleme oluşturmaz | üretim yapılandırması güvensiz değerleri reddeder | Geçti |
| acceptance.test.ts | 13.15 Gerçek entegrasyon ayarları eksikken sistem canlı işlem başlatmaz | canlı modda gerçek adaptör/sözleşme/kontrol listesi yokken işlem başlatılamaz ve eksikler raporlanır | Geçti |
| acceptance.test.ts | 13.15 Gerçek entegrasyon ayarları eksikken sistem canlı işlem başlatmaz | yapılandırılmamış entegrasyonla TEST modunda da işlem başlatılmaz ("Kurulum bekleniyor") | Geçti |
| acceptance.test.ts | 13.15 Gerçek entegrasyon ayarları eksikken sistem canlı işlem başlatmaz | yönetici canlı moda geçmeye çalışırsa engellenir | Geçti |
| security.test.ts | birim testleri | TOTP RFC 6238 test vektörü | Geçti |
| security.test.ts | birim testleri | ücret hesaplama tamsayı kuruşla yapılır ve sınırlara uyar | Geçti |
| security.test.ts | birim testleri | durum makinesi: ödeme onayı doğrudan COMPLETED yapmaz; tahsilat sonrası FAILED olmaz | Geçti |
| security.test.ts | birim testleri | AES-GCM şifreleme ek veriyle bağlıdır | Geçti |
| security.test.ts | birim testleri | maskeleme ve CSV formül enjeksiyonu önlemi | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | bootstrap-super-admin idempotenttir, parola üretmez ve MFA kurulmadan yönetim erişimi vermez | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | mevcut hesaba süper yönetici yetkisi açık onay olmadan verilmez | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | üretimde e-posta kanalı yoksa davet bağlantısı konsola yazılmaz | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | art arda hatalı girişler hesabı geçici kilitler ve kullanıcı bilgilendirilir | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | giriş uç noktası hız sınırlıdır | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | kayıt e-posta doğrulaması olmadan giriş yapılamaz; hesap varlığı ifşa edilmez | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | parola sıfırlama tüm oturumları sonlandırır | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | SMS/push sağlayıcısı yokken bildirim gönderilmiş gibi gösterilmez | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | mutabakat eşleşmeyen tutarı ve eksik makbuzu tespit eder | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | mutabakat kaynak yapılandırılmamışsa bunu açıkça kaydeder | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | yayın kontrol listesi kanıtsız doğrulanamaz; otomatik maddeler gerçek durumu kontrol eder | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | yönetici rol değişikliği denetim kaydına yazılır ve hedefin oturumlarını kapatır | Geçti |
| security.test.ts | entegrasyon: güvenlik ve süreçler | e-posta kanalı: SMTP bilgisi geri gösterilmez, deneme gönderimi gerçek sonucu bildirir | Geçti |

## Elle yapılan uçtan uca deneme (gerçek tarayıcı, Playwright/Chromium)

Kayıt → geliştirme e-posta kutusundan doğrulama → giriş → `TEST-10001` aboneliği ekleme (kart otomatik geldi) → 200 TL yükleme teklifi (1,50 TL örnek hizmet bedeli) → simülatör ödeme sayfası → işlem **Tamamlandı**, makbuz görüntülendi → fatura sorgusu → işlem geçmişi → mobil genişlik görünümü. Yönetici: bootstrap daveti → parola → zorunlu TOTP kurulumu → yönetim paneli, Güvenli Ödeme Hizmeti sekmeleri, Su İdaresi, yayın öncesi kontrol, denetim kayıtları. Ayrıca `scripts/backup.sh` ve `scripts/restore-test.sh` yerel veritabanında çalıştırıldı (yedek alındı, ayrı veritabanına geri yüklendi, sonuçlar `backup_runs` tablosuna yazıldı; `_restore_test` ile bitmeyen hedef reddedildi).

## Denenmemiş olanlar

- **Mobil uygulama** (Expo): bağımlılıklar kurulmadı, derlenmedi, cihazda/emülatörde çalıştırılmadı.
- **Dockerfile**: bu ortamda Docker servisi olmadığı için imaj derlenmedi.
- **GitHub Actions CI**: ilk çalıştırma PR açıldığında görülecek.
- Gerçek SMTP ile gönderim (yalnızca erişilemeyen sunucuya karşı "FAILED" sonucunun dürüst gösterimi test edildi).
- Yük/performans testi ve bağımsız sızma testi.

## Çalıştırma

```bash
docker compose up -d db
npm ci
npm test
```
