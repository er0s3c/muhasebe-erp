# Performans ve yük ölçümü

Bu belge M9b-3'te yapılan ölçümü, bulunan sorunları ve bilinen sınırları içerir. Sayılar **tek makinede** (istemci, API ve PostgreSQL aynı kapsayıcıda, paylaşımlı CPU) alınmıştır; mutlak değerlerden çok **önce/sonra karşılaştırması** ve ölçeklenme eğilimi anlamlıdır. Kendi sunucunuzda aynı betiklerle yeniden ölçün.

## Nasıl ölçülür

```bash
# 1) Ayrı bir veritabanı (tek seferlik)
su postgres -c "psql -c 'CREATE DATABASE erp_load OWNER erp'"
MIGRATION_DATABASE_URL=postgres://erp:erp@localhost:5432/erp_load npm run db:migrate

# 2) Örnek veri (gerçek servisleri çağırır: RLS, tetikleyiciler, numaralama dahil). Varsayılan boyut aşağıdadır.
DATABASE_URL=postgres://erp_app:erp_app@localhost:5432/erp_load JWT_SECRET=$(openssl rand -base64 48) npm run load:gen

# 3) Paketlenmiş API'yi ayağa kaldırıp ölçün (oran sınırı kapalı olmalı)
npm run build
NODE_ENV=production DATABASE_URL=... JWT_SECRET=... RATE_LIMIT_ENABLED=false COOKIE_SECURE=false PORT=3200 node apps/api/dist/server.js &
LOAD_BASE_URL=http://localhost:3200 LOAD_EMAIL=load@example.com LOAD_PASSWORD=Yuk-Testi-Sifre-8842 LOAD_COMPANY_ID=<loadgen çıktısındaki id> npm run load:test
```

`load:gen` değişkenleri: `LOAD_PARTIES`, `LOAD_ITEMS`, `LOAD_INVOICES`, `LOAD_ENTRIES`, `LOAD_TREASURY`, `LOAD_CONCURRENCY`. `load:test` değişkenleri: `LOAD_CONCURRENCY` (varsayılan 8), `LOAD_SECONDS` (8), `LOAD_ONLY=senaryo,senaryo`, `LOAD_JSON=/yol.json`.

**Ölçülen veri boyutu:** 1.500 cari, 400 stok kartı, 2.500 kaydedilmiş fatura, 7.304 yevmiye fişi (20.116 satır), 6.574 stok hareketi, 45.118 denetim kaydı (bir yıllık orta ölçekli bir firma).

## Sonuçlar (eşzamanlılık 8, senaryo başına 8 sn)

| Senaryo | Önce istek/sn | Sonra istek/sn | Önce p50 / p95 | Sonra p50 / p95 |
|---|---:|---:|---:|---:|
| navigation (her sayfa yüklemesi) | 784 | 797 | 9 / 16 ms | 9 / 16 ms |
| cari listesi (50 kayıt) | 271 | 269 | 28 / 44 ms | 29 / 43 ms |
| cari arama | 222 | 222 | 35 / 51 ms | 35 / 51 ms |
| cari yaşlandırma | 38 | 35 | 209 / 306 ms | 226 / 339 ms |
| cari ekstresi | 653 | 709 | 12 / 17 ms | 11 / 16 ms |
| **yevmiye listesi (50 kayıt)** | 102 | **537** | 75 / 109 ms | **14 / 20 ms** |
| mizan | 135 | 135 | 57 / 84 ms | 56 / 87 ms |
| hesap ekstresi (kasa, ~4.000 satır) | 31 | 30 | 263 / 350 ms | 267 / 404 ms |
| fatura listesi | 342 | 345 | 23 / 33 ms | 23 / 33 ms |
| stok durumu (400 kart) | 123 | 118 | 65 / 84 ms | 67 / 89 ms |
| KDV özeti | 316 | 319 | 25 / 37 ms | 24 / 36 ms |
| yevmiye defteri CSV dışa aktarma | 5,1 (p50 1,6 sn) | 4,3 (p50 0,48 sn, eşz. 2) | 1648 / 2362 ms | 478 / 643 ms |

Yorum: günlük kullanım uçları (menü, liste, arama, ekstre, fatura, KDV) 10–60 ms aralığında ve saniyede yüzlerce istek taşır. Tek bir API süreci, bu veri boyutunda, onlarca eşzamanlı kullanıcıyı rahat karşılar. Bir muhasebe ofisi için darboğaz raporlardır (aşağıda).

## Bu turda bulunan ve giderilenler

1. **Kilitlenme (gerçek hata).** Yük üretici altı eşzamanlı fatura kaydettiğinde PostgreSQL `deadlock detected` verdi (API `500` döndürüyordu). Neden: oluştur+kaydet tek istekte satırlar yazılırken yabancı anahtar denetimi stok kartında `FOR KEY SHARE` kilidi alıyor, kayıt aşamasında aynı kart `FOR UPDATE`'e yükseltiliyordu; aynı kartı kullanan iki istek birbirini bekledi. Düzeltme: kartlar ve bağlı irsaliye satırları satırlar yazılmadan **önce**, kayıt sırasıyla kilitlenir (fatura ve irsaliye oluştur/güncelle+kaydet uçları). İki regresyon testi (12 eşzamanlı istek); ön kilit kaldırılınca ikisi de kırılır. Kalan kilitlenme ihtimaline karşı `40001/40P01` artık `409 RETRY` döner (istemci yeniden deneyebilir).
2. **Yevmiye listesi.** Sayfalamadan önce tüm süzülmüş fişler satırlarıyla birleştirilip gruplanıyordu; şimdi önce sayfa seçiliyor, satır toplamı yalnızca o fişler için hesaplanıyor (bağıntılı alt sorgu): **5,3 kat hızlanma**, veri büyüdükçe fark açılır.
3. **Eksik dizinler** (`0018`): kaydedilmiş fişler için kısmi `(şirket, tarih)`, `reversed_by_id`/`reversal_of_id`, `treasury_transactions.journal_entry_id`/`cancel_journal_entry_id`, `party_allocations.transaction_id`, `refresh_tokens.expires_at`. Bu veri boyutunda PostgreSQL sıralı taramayı zaten ucuz bulduğundan ölçülebilir fark yoktur; büyük veri ve silme/güncelleme yollarında etkilidir.
4. **Sınırsız yanıtlar.** Hesap ekstresi, cari ekstresi, kasa/banka ekstresi ve stok kartı hareketleri 20.000 satırı aşarsa sessizce dev bir yanıt üretmek yerine `422 REPORT_TOO_LARGE` verir ("tarih aralığını daraltın").
5. **Dışa aktarma kapısı.** Bellek içi üretilen dışa aktarmalar süreç başına en çok `EXPORT_CONCURRENCY` (varsayılan 2) eşzamanlı çalışır; fazlası beklemeden `429 EXPORT_BUSY` alır. Eşzamanlılık 8'de istekler birbirini ezmek yerine hızlı reddedilir (yukarıdaki satırın "sonra" değeri yalnızca 2 eşzamanlı istekle ölçüldü).
6. **Sorgu süre sınırı.** `DB_STATEMENT_TIMEOUT_MS` varsayılanı 60.000 ms (tek bir SQL ifadesi için); ölçülen en ağır istek ~2 sn olduğundan bol pay bırakır. `0` ile kapatılır.
7. **xlsx içe aktarma sınırları** düşürüldü (giriş başına 10 MB, toplam 24 MB açılmış boyut); 5.000 satırlık bir dosya için fazlasıyla yeterli.

## Bilinen ölçek sınırları (yapılmadı, bilinçli)

- **Cari yaşlandırma** şirketin tüm cari satırlarını belleğe alıp FIFO'yu uygulamada hesaplar: maliyet **toplam satır sayısıyla doğrusal** (20 bin satırda ~0,2 sn; 200 bin satırda ~2 sn beklenir). Çözüm yönü: dönem kapanış özet tablosu ya da SQL pencere fonksiyonlarıyla FIFO.
- **Hesap ekstresi / mizan** her çağrıda defteri tarar (mizan 7 bin fişte 56 ms). Çok büyük defterlerde dönem bakiye özeti tablosu gerekir.
- **Stok bakiyesi** her belge işlenirken kartın hareket geçmişinden hesaplanır (çalışan bakiye tablosu yok); tek bir kartta yüz binlerce hareket olduğunda kayıt süresi uzar.
- **Tam veri dışa aktarma** ve defter dışa aktarmaları bellek içi üretilir (kapı ve tavanlarla sınırlı); akışlı xlsx yazımı yapılmadı.
- **Oran sınırı deposu bellektedir:** tek uygulama örneği varsayılır (docs/OPERATIONS.md).
- Yazma (fatura kaydı) veri hacminden çok **numara sayacı satırındaki kilitle** sınırlıdır: boşluksuz numara tasarım gereği aynı (şirket, seri, yıl) satırını işlem sonuna dek kilitler; aynı şirkette saniyede birkaç onlarca kayıt mertebesinde tavan beklenir (yük üreticisi 6 eşzamanlı kullanıcıyla ~40 fatura/sn kaydetti).
