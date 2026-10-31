# Veritabanı göçleri

- `0001_water_topup.sql`: yalnızca yeni `water_topup` şemasını ve tablolarını oluşturur. Mevcut sitenin (`public`) tablolarına dokunmaz, hiçbir şey silmez.
- Canlı Supabase'e uygulanmadan önce onay gerekir. Önce bir test/branch veritabanında çalıştırın.
- Geri alma (yalnızca test veritabanında): `drop schema water_topup cascade;`
