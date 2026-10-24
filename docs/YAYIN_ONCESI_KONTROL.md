# Yayın öncesi (canlıya geçiş) kontrol listesi

Canlı mod, aşağıdaki maddelerin tamamı **doğrulanmadan** sistem tarafından açılamaz (`LIVE_BLOCKED`). Bir maddenin "doğrulandı" sayılması için kanıt referansı (belge no, test raporu, sözleşme tarihi vb.) ve doğrulayan yöneticinin taze MFA'sı zorunludur. **Yalnızca bir kutunun işaretlenmesi gerçek izin veya entegrasyonun kanıtı değildir**; kanıtın kendisi ilgili kişilerce ayrıca incelenmelidir.

| # | Madde | Otomatik denetim | Kanıt örneği |
|---|---|---|---|
| 1 | Su idaresinin yazılı onayı ve teknik erişim | — | Protokol / yazı sayısı |
| 2 | Ödeme hizmeti için sözleşme ve hukuki model doğrulandı | Onaylı sözleşme kaydı var mı | Sözleşme no, hukuk görüşü |
| 3 | Test ve üretim anahtarları ayrı | Canlı referanslar `live/` önekli ve tanımlı mı | Kasa meta bilgisi |
| 4 | Gerçek entegrasyon testleri tamam | Başarılı canlı-dışı bağlantı testi var mı | Test raporu |
| 5 | Süper yönetici güvenli oluşturuldu, MFA etkin | Her süper yöneticide TOTP var mı | — |
| 6 | Güvenlik testleri (sızma testi dahil) | — | Bağımsız rapor |
| 7 | Yedekleme ve geri yükleme doğrulandı | Başarılı RESTORE_TEST kaydı var mı | `backup_runs` kaydı |
| 8 | Hata, iade ve mutabakat süreçleri test edildi | — | Test senaryo kayıtları |
| 9 | Kullanıcı belgeleri ve veri koruma süreçleri gözden geçirildi | Yayınlanmış hukuki metinler var mı | Hukuk incelemesi |
| 10 | İzleme ve destek prosedürü hazır | — | Nöbet çizelgesi, runbook |

Ek canlı mod engelleri: `APP_ENV=production` olmalı, etkin sağlayıcı simülatör olmamalı, ücret tarifesi "örnek" olmamalı.

## Teknik kontrol (dağıtım günü)
- [ ] `npm test`, `npm run typecheck`, `npm run audit:deps` temiz
- [ ] Migrasyonlar üretim kopyasında denendi
- [ ] Webhook adresi sağlayıcıda tanımlı, imza testi geçti
- [ ] Bakım modu aç/kapa denendi
- [ ] Yedek alındı ve geri yükleme testi yapıldı
- [ ] İzleme alarmları (5xx, webhook hataları, REQUIRES_REVIEW kuyruğu, işçi çalışıyor mu) etkin
