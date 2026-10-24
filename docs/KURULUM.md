# Kurulum, çalıştırma ve dağıtım

## 1. Gereksinimler

- Node.js 22 veya üzeri, npm 10+
- PostgreSQL 14+ (yerelde `docker compose up -d db` ile)
- `openssl` (anahtar üretimi), `pg_dump` / `pg_restore` (yedekleme betikleri)
- Mobil için: Expo CLI (`npx expo`), Android Studio ve/veya Xcode

## 2. Yerel geliştirme

```bash
npm ci                                  # bağımlılıklar (api + web)
docker compose up -d db                 # yerel PostgreSQL (yalnızca geliştirme parolası)
cp .env.example .env
# .env içinde doldurun:
#   DATABASE_URL=postgres://su_dev:su_dev_local_only@localhost:5432/su_dev
#   AUTH_SECRET=$(openssl rand -hex 32)
#   SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
#   SUPER_ADMIN_EMAIL=<yonetici e-postası>
npm run migrate                         # migrasyonlar
npm run seed:dev -w apps/api            # TEST_SIM su idaresi + sandbox ödeme (üretimde çalışmaz)
npm run dev:api                         # API: http://127.0.0.1:3000
npm run dev:web                         # Web: http://localhost:5173 (/api isteklerini API'ye yönlendirir)
npm run worker -w apps/api              # İşçi: yükleme/tahsilat ve belirsiz durum sorguları
```

Geliştirmede e-posta gönderilmez; doğrulama/davet bağlantıları API günlüğüne `[dev-outbox]` olarak yazılır.

### Simülatör senaryoları (yalnızca geliştirme/test)

Abone numarası `TEST-` ile başlamalıdır. Son hane senaryoyu belirler:

| Son hane | Sonuç |
|---|---|
| 0 | Borç yok |
| 6 | Su idaresi kabul eder, ikinci durum sorgusunda onaylar |
| 7 | Belirsiz sonuç (zaman aşımı) → UNKNOWN → durum sorgusu |
| 8 | Su idaresi reddeder → para alındıysa REFUND_PENDING |
| 9 | Abone bulunamadı |
| diğer | Başarılı |

Simülatör ödeme sayfası `/api/sandbox/checkout/...` adresindedir ve `APP_ENV=production` iken kayıtlı değildir.

## 3. Süper yöneticinin güvenli oluşturulması

1. `SUPER_ADMIN_EMAIL` değerini ortam değişkeni olarak verin (koda yazılmaz).
2. Üretimde önce e-posta kanalını yapılandırın (bkz. 6); yapılandırılmamışsa komut davet bağlantısını ekrana yazmaz, hata verir.
3. Çalıştırın:
   ```bash
   npm run bootstrap-super-admin              # geliştirme
   npm run bootstrap-super-admin:prod -w apps/api   # derlenmiş sürüm
   ```
4. Komut bu e-postaya **24 saat geçerli, tek kullanımlık** bir davet gönderir. Varsayılan parola yoktur.
5. Davet bağlantısında parola belirlenir; ardından **TOTP (doğrulayıcı uygulama) kurulumu zorunludur**. 10 kurtarma kodu bir kez gösterilir; güvenli yerde saklayın.
6. Komut idempotenttir: bir süper yönetici zaten varsa yeni hesap oluşturmaz (`ALREADY_EXISTS`).
   - Davet süresi dolduysa: `--reissue-invite`
   - Bu e-postayla zaten normal bir kullanıcı hesabı varsa komut reddeder; bilinçli olarak yükseltmek için `--confirm-existing-account` gerekir (işlem denetim kaydına yazılır).
7. Aynı e-postayla web'den kayıt olmak hiçbir yönetici yetkisi vermez.

Hesap kurtarma: TOTP cihazı kaybolursa kurtarma kodlarından biri kullanılır ve hemen yeni TOTP kurulur. Parola unutulursa e-postayla parola sıfırlama yapılır (tüm oturumlar kapanır). Davet kabul edilmeden süresi dolduysa `--reissue-invite` kullanılır. Kurtarma kodları da kaybolmuşsa **bu sürümde panelden MFA sıfırlama yoktur**; bu durum için kimlik doğrulamalı, iki kişi onaylı bir prosedür yazılması ve ikinci bir süper yönetici tanımlanması önerilir. Yönetici, başka bir yöneticinin tüm oturumlarını panelden sonlandırabilir.

## 4. Ödeme sağlayıcısının yapılandırılması

> Bu sürümde gerçek ödeme kuruluşu adaptörü yoktur. Sözleşme ve resmî API dokümanı geldikten sonra ENTEGRASYON_REHBERI.md'ye göre adaptör yazılır.

Yönetim → Güvenli Ödeme Hizmeti:
1. **B. Sağlayıcılar**: sağlayıcıyı ekleyin, test ve canlı ortamı ayrı ayrı yapılandırın (taban URL, üye işyeri no).
2. **C. Anahtarlar**: API anahtarı ve webhook sırrını girin. Değerler şifreli kasaya yazılır, bir daha gösterilmez; yalnızca `••••son4` ve parmak izi görünür. Test (`payment/test/...`) ve canlı (`payment/live/...`) referansları ayrıdır.
3. Webhook adresini sağlayıcı paneline girin: `https://<API_PUBLIC_URL>/api/webhooks/payment/<sağlayıcı-kodu>`
4. Bağlantı testini çalıştırın.
5. **D. Ücretler**: gerçek tarifeyi girin. "Örnek" tarifeyle canlıya geçilemez.
6. Sözleşme kaydını ekleyip onaylatın. Canlı mod, yayın öncesi kontrol listesi tamamlanmadan açılmaz.

## 5. Su idaresi entegrasyonu

Yönetim → Su İdaresi Entegrasyonu: kurumu ekleyin, yetenekleri (sorgu, kart yükleme, fatura ödeme, durum sorgusu) ve kimlik bilgilerini (`utility/test/...`, `utility/live/...`) tanımlayın, bağlantı testini çalıştırın. Adaptör yoksa durum "Kurulum bekleniyor" olarak kalır ve kullanıcıya işlem açılmaz.

## 6. E-posta (SMTP)

İlk kurulumda (süper yönetici davetinden önce) sunucuda:

```bash
# EMAIL_FROM ve EMAIL_PROVIDER_SECRET_REF ortam değişkenleri tanımlı olmalı
printf '%s' "$SMTP_URL" | npm run configure-email:prod -w apps/api -- --provider "Sağlayıcı adı" --status ACTIVE
```

SMTP adresi (`smtps://kullanici:parola@sunucu:465`) argüman olarak değil standart girdiden okunur, şifreli kasaya yazılır ve bir daha gösterilmez. Sonradan Yönetim → Uyarılar → "E-posta (SMTP)" formundan güncellenebilir ve "Kendime deneme e-postası gönder" ile gerçek gönderim denenebilir (sonuç olduğu gibi gösterilir). Gönderen alan adı için SPF, DKIM ve DMARC kayıtlarını yapın. SMS ve push sağlayıcısı tanımlı değilse gönderim yapılmaz ve "gönderilmedi" olarak kaydedilir.

## 7. Testler

```bash
docker compose up -d db
createdb -h localhost -U su_dev su_test     # bir kez (veya docker compose ile otomatik)
npm test                                    # API kabul + güvenlik testleri (gerçek PostgreSQL)
npm run typecheck
npm run build -w apps/web
npm run audit:deps
```

Test veritabanının adı `_test` ile bitmelidir; test kurulumu başka adlı bir veritabanında şemayı silmeyi reddeder. `TEST_DATABASE_URL` ile değiştirilebilir.

## 8. Üretim dağıtımı

Önerilen yapı: TLS sonlandıran ters vekil (ör. yönetilen yük dengeleyici) → API (2+ kopya) + ayrı işçi süreci → yönetilen PostgreSQL (otomatik yedek, şifreli disk). Web statik dosyaları CDN veya aynı ters vekil üzerinden sunulur.

```bash
npm ci
npm run build                                  # apps/api/dist + apps/web/dist
APP_ENV=production npm run migrate:prod -w apps/api
APP_ENV=production npm start -w apps/api       # API
APP_ENV=production npm run worker:prod -w apps/api   # İşçi (ayrı süreç)
```

Üretim zorunlulukları (`config.ts` başlatmada denetler): `APP_BASE_URL` ve `API_PUBLIC_URL` https, `AUTH_SECRET` en az 32 karakter ve örnek değer değil, süper yönetici MFA açık. Ek olarak:
- Gizli bilgileri platformun secret manager'ından ortam değişkeni olarak verin; `.env` dosyası kullanmayın.
- `TRUST_PROXY=true` yalnızca güvenilir ters vekil arkasında.
- `CORS_ALLOWED_ORIGINS` yalnızca kendi alan adlarınız.
- Veritabanı kullanıcısı yalnızca uygulama şemasında yetkili olmalı; `audit_logs` için UPDATE/DELETE yetkisi verilmemeli (tetikleyici zaten engeller).
- Webhook IP izin listesi (sağlayıcı yayımlıyorsa) Yönetim → Güvenli Ödeme Hizmeti → B'den girilir.

Dockerfile ile: `docker build -t su-odeme-merkezi .` (bkz. kök dizindeki Dockerfile).

## 9. Yedekleme ve geri yükleme

```bash
DATABASE_URL=... BACKUP_DIR=/guvenli/yedek scripts/backup.sh          # pg_dump -Fc + sonuç kaydı
DATABASE_URL=... RESTORE_TEST_URL=postgres://.../su_restore_test scripts/restore-test.sh <dosya>
```

`restore-test.sh` yedeği ayrı bir veritabanına geri yükler, tablo sayısını ve son migrasyonu kontrol eder ve sonucu `backup_runs` tablosuna yazar. Yayın öncesi kontrol listesindeki "Yedekleme ve geri yükleme doğrulandı" maddesi başarılı bir geri yükleme testi kaydı olmadan doğrulanamaz. Yedekler şifreli depolamada tutulmalı ve gerçek kişisel veri test ortamına kopyalanmamalıdır.

## 10. Geri alma (rollback) planı

1. Uygulama: önceki sürümün imajına/derlemesine dönün (API ve işçi birlikte).
2. Migrasyonlar yalnızca ileriye doğrudur. Bu nedenle her migrasyon geriye uyumlu yazılmalıdır (önce sütun ekle, sonra kullan; silme işlemleri sonraki sürüme). Geri alma gerekiyorsa son doğrulanmış yedekten geri yükleme yapılır.
3. Canlı moddaysanız önce Yönetim → Sistem ve yedekleme sayfasından **bakım modunu** açın; yeni işlemler durur, süren işlemler işçi tarafından tamamlanır veya incelemeye alınır.
4. Geri dönüşten sonra mutabakat çalıştırın ve REQUIRES_REVIEW kuyruğunu kontrol edin.

## 11. Sorun giderme

| Belirti | Olası neden / çözüm |
|---|---|
| `NOT_READY` (503) ve gerekçeler | Sağlayıcı/kurum yapılandırılmamış; panelde gösterilen eksikleri tamamlayın |
| `LIVE_BLOCKED` | Yayın öncesi kontrol listesi, sözleşme onayı veya gerçek tarife eksik |
| `MFA_STEP_UP_REQUIRED` | Hassas işlem için son 15 dakikada MFA doğrulaması gerekir; panelde kodu girin |
| Webhook 401 | İmza sırrı yanlış, saat farkı (NTP) veya IP izin listesi |
| İşlem UNKNOWN'da kalıyor | İşçi çalışmıyor olabilir; `npm run worker -w apps/api -- --once` ile tek tur deneyin |
| 429 | Giriş hız sınırı (`AUTH_RATE_LIMIT_PER_MINUTE`) |
| Davet bağlantısı geçersiz | 24 saat dolmuş; `bootstrap-super-admin --reissue-invite` |

## 12. Mobil uygulama

```bash
cd apps/mobile
npm install
# app.json → expo.extra.apiBaseUrl değerini https API adresinizle değiştirin
npx expo start
```

Mobil uygulama bu ortamda derlenmedi ve cihazda denenmedi; mağaza yayını öncesinde gerçek cihaz testleri, uygulama imzalama ve mağaza gizlilik beyanları gerekir. Uygulamada hiçbir gizli anahtar yoktur; oturum belirteci Keychain/Keystore'da tutulur.
