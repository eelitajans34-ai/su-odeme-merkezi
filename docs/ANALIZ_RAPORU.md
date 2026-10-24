# Analiz raporu, eksik bilgiler ve riskler

Bu belge, talimatın 16. bölümündeki çalışma sırasının ilk iki adımını (analiz ve risk listesi) karşılar.

## 1. Kapsam özeti

| Alan | Bu sürümde | Not |
|---|---|---|
| Su kartı bakiye yükleme | Uçtan uca akış, durum makinesi, idempotency, belirsiz sonuç yönetimi | Gerçek su idaresi bağlantısı yok → "Kurulum bekleniyor" |
| Fatura sorgulama ve ödeme | Sorgu anlık görüntüsü (15 dk), tutar sunucuda, resmi teyit olmadan "ödendi" yok | Gerçek su idaresi bağlantısı yok |
| Ödeme | Sağlayıcıdan bağımsız adaptör arayüzü, webhook imza + tekrar koruması, durum sorgusu çift kontrolü | Gerçek ödeme kuruluşu sözleşmesi ve dokümanı yok |
| Web | Kullanıcı arayüzü + yönetim panelleri (Türkçe, mobil uyumlu, koyu mod) | |
| Android / iOS | Expo (React Native) iskeleti: giriş+MFA, abonelik (elle/QR), yükleme, işlemler, makbuz, bildirim | Bu ortamda derlenmedi / cihazda denenmedi |
| Süper yönetici | Ortam değişkeninden e-posta, idempotent `bootstrap-super-admin`, davet bağlantısı, zorunlu TOTP | Varsayılan parola yok |
| Güvenli Ödeme Hizmeti paneli (A–H) | Genel durum, sağlayıcılar, anahtarlar (yalnızca meta), ücretler, işlemler, iadeler, mutabakat, uyum/yayın | |
| Su İdaresi Entegrasyonu paneli | Kurum, yetenekler, kimlik bilgileri, bağlantı testi, durum | |
| Mutabakat, bildirim, denetim | Mutabakat çalıştırma + CSV, bildirim kanalları dürüst durumlu, eklemeli (append-only) denetim kaydı | |
| KVKK hazırlığı | Aydınlatma/rıza kayıtları, saklama, veri işleyen envanteri, ihlal süreci taslağı | Uyum İDDİA EDİLMEZ; uzman incelemesi gerekir |

## 2. Eksik bilgiler (proje sahibinden gerekenler)

1. **Su idaresi**: Hangi kurum(lar)? Resmi API/web servis dokümanı, test ortamı, kimlik bilgisi, IP izin listesi gereksinimi, yazılı onay/protokol. Kart yükleme yöntemi (uzaktan kredi mi, terminalde karta yazma mı?).
2. **Ödeme kuruluşu**: TCMB lisanslı hangi ödeme/e-para kuruluşu? Sözleşme, üye işyeri numarası, test/canlı API anahtarları, webhook imza yöntemi, iade API'si, mutabakat dosyası formatı.
3. **Hukuki model**: Platform, fatura tahsilatı aracılığı için hangi hukuki yapıyla çalışacak (aracı ödeme kuruluşu üzerinden mi, kurum adına tahsilat yetkisi mi)? Hizmet bedeli alınabilir mi, nasıl gösterilmeli?
4. **Hizmet bedeli tarifesi**: Gerçek tarife. Şu an yalnızca "ÖRNEK" etiketli test tarifesi var; canlıya geçiş örnek tarifeyle engellenir.
5. **E-posta / SMS / Push sağlayıcıları**: SMTP hesabı (gönderen alan adı SPF/DKIM/DMARC), SMS sağlayıcısı ve İYS durumu, FCM/APNs hesapları.
6. **Barındırma**: Bulut sağlayıcı ve bölge (veri yerelleştirme), yönetilen PostgreSQL, secret manager/KMS, yedek depolama.
7. **Alan adı ve marka**: Uygulama adı, mağaza hesapları (Apple Developer, Google Play Console), alan adı ve TLS.
8. **Hukuki metinler**: Kullanım koşulları, aydınlatma metni, açık rıza metni (gerekiyorsa), çerez politikası, mesafeli hizmet sözleşmesi. Sistemde yalnızca yer tutucu taslaklar vardır.
9. **Talimatın kesik kısmı**: Mesaj "14. Kurulum, dağıtım," noktasında kesilmiş. Bu bölüm kurulum ve dağıtım belgeleri olarak yorumlandı (bkz. KURULUM.md). Eksik maddeler varsa iletilmesi gerekir.

## 3. Riskler

| # | Risk | Etki | Bu sürümdeki önlem | Kalan iş |
|---|---|---|---|---|
| R1 | Ödeme alınıp su idaresine yükleme yapılamaması | Kullanıcı mağduriyeti, finansal kayıp | Ödeme onayı ≠ yükleme başarısı; para alındıktan sonra hata → REFUND_PENDING; yönetici uyarısı | Gerçek iade API'si entegrasyonu |
| R2 | Zaman aşımında çift yükleme | Çift bakiye / çift tahsilat | UNKNOWN durumu; yeniden göndermeden önce durum sorgusu; aynı `utility_request_id` ile tekrar; kilit + idempotency | Su idaresinin idempotency desteği teyit edilmeli |
| R3 | Sahte veya tekrar oynatılan webhook | Ödenmemiş işlemin "ödendi" sayılması | Ham gövde HMAC, zaman damgası penceresi, `event_id` tekilliği, sağlayıcıdan durum sorgusu ile çift kontrol, tutar uyuşmazlığı → REQUIRES_REVIEW | Sağlayıcının gerçek imza şeması |
| R4 | Gizli anahtar sızıntısı | Hesap ele geçirme | AES-256-GCM kasa veya harici secret manager referansı; istemciye/loga/hataya yalnızca meta; log redaksiyonu | Üretimde KMS ve anahtar döndürme |
| R5 | Yönetici hesabının ele geçirilmesi | Tüm sistemin kontrolü | Zorunlu TOTP, hassas işlemde taze MFA (15 dk), 8 saat oturum + 30 dk boşta kalma, kilitleme, şüpheli giriş uyarısı, kayıtla rol alınamaz | Donanım anahtarı (WebAuthn) eklenmesi önerilir |
| R6 | Mevzuat (6493, 5549, 6698 KVKK, 7201 vb.) | Yaptırım, faaliyet durdurma | Canlı mod engelleyici kontrol listesi; sözleşme onayı olmadan canlı yok; uyum iddiası yok | Hukuk ve uyum uzmanı incelemesi |
| R7 | Test verisinin üretime karışması | Yanlış raporlama | Test kayıtları `is_test` / `environment` ile etiketli; simülatörler üretimde kayıtlı bile değil | |
| R8 | Kart yükleme yönteminin "karta yazma" olması | Uzaktan yükleme mümkün olmayabilir | Kart başına yöntem alanı (REMOTE_CREDIT / CARD_WRITE_AT_TERMINAL / NOT_SUPPORTED) | Kurumla teyit |
| R9 | Mobil uygulamanın derlenmemiş olması | Mağaza yayını gecikir | İskelet hazır, yalnızca sunucu API'sini kullanır | Cihaz testleri, mağaza süreçleri |
| R10 | Tek sunucu / tek veritabanı | Kesinti | İşçi (worker) ayrı süreç, sağlık kontrolü | Yüksek erişilebilirlik ve izleme altyapısı |

## 4. Yapılmayanlar ve nedenleri

- **Sağlayıcıya özel entegrasyon kodu yazılmadı.** Resmi doküman olmadan uydurulmuş kod gerçekte çalışmaz ve güvenlik riski yaratır. Bunun yerine adaptör arayüzü ve geliştirme simülatörü (yalnızca üretim dışı) yazıldı. Bkz. ENTEGRASYON_REHBERI.md.
- **Gerçek SMS/push gönderimi yok.** Sağlayıcı tanımlı değilse gönderim "Sağlayıcı yapılandırılmadı — gönderilmedi" olarak kaydedilir, başarılı gösterilmez.
- **Kazıma (scraping) veya yetkisiz erişim yok.**
