# 0105 ilk kurulum ve yükseltme onarımı

9 Ekim 2026 incelemesinde, kullanıcının `0105_leather_foundation.sql` dosyasına yaptığı kimlik üretme düzeltmesi korundu. Bu, daha önce kilitlenmiş bir migration için tek seferlik uyumluluk istisnasıdır; yeni düzeltmeler için mevcut migration dosyalarını veya kilit özetlerini değiştirme izni vermez. Genel kural [ARCHITECTURE.md](ARCHITECTURE.md) içindeki DB-6 maddesidir.

## Sorun ve düzeltme

`account_mappings.id`, `0006_invoices.sql` içinde `uuid PRIMARY KEY NOT NULL` olarak tanımlanmıştır ve SQL varsayılan değeri yoktur. TypeScript şemasındaki `$defaultFn(() => uuidv7())` yalnız Drizzle üzerinden yapılan eklemelerde çalışır; migration içindeki ham SQL için kimlik üretmez.

0105'in önceki `INSERT INTO account_mappings(company_id,key,account_id)` ifadesi kimlik vermiyordu. Yükseltilecek şirkette eşleşen `150`, `151`, `152`, `620` veya `381` hesapları varsa INSERT satır üretir ve `id` boş kaldığı için işlem başarısız olur. Boş veritabanında eşleşen hesap bulunmadığından bu hata görünmeyebilir.

Korunan düzeltme, sütun listesine `id`, SELECT ifadesine `gen_random_uuid()` ekler. Var olan `ON CONFLICT(company_id,key) DO NOTHING` korunmuştur: mevcut hesap eşlemeleri değiştirilmez, yalnız eksik eşlemeler eklenir. PostgreSQL 16 kurulumunda `gen_random_uuid()` yerleşik olarak kullanılabilir. Daha sonraki bir migration eklemek, henüz 0105'i geçemeyen yükseltmedeki bu hatayı gidermez.

## Kayıtlı içerik özetleri

Kilit dosyası SHA-256 hesaplamadan önce CRLF satır sonlarını LF biçimine dönüştürür.

| İçerik | SHA-256 |
| --- | --- |
| Önceki 0105 | `e14cf2ed4bba3808038a4eb96d47713eb5bc97b20feb169d7fdaa1599d0f6408` |
| Kimlik üretimi düzeltilmiş 0105 | `c4a36bd8355e56189b43aa37fa2cde75c648302ea6619b298ca79eb0e4289a7d` |

Kullanıcının düzelttiği özet `apps/api/test/fixtures/migration-lock.json` içinde korunmuştur. Günlükteki `tag`, sıra ve `when` değeri değiştirilmemiştir. Sadece mevcut kilidin geçmesi, eski içerikten yükseltme davranışının doğrulandığı anlamına gelmez.

## Daha önce uygulanmış veritabanları

Mevcut Drizzle migrator son uygulanmış migration'ın `created_at` değerine bakar ve daha eski migration'ları tekrar yürütmez; kayıtlı hash ile disk içeriğini çalışma zamanında karşılaştırmaz. 0105'i daha önce başarıyla uygulamış veritabanlarında bu dosya değişikliği geçmiş kayıtları yeniden hesaplamaz veya 0105'i tekrar çalıştırmaz. Bu onarımın uygulanması için migration geçmişini silmek, hash kayıtlarını değiştirmek ya da veritabanını sıfırlamak gerekmez.

## Yayın öncesi doğrulama

- Temiz, geçici bir PostgreSQL veritabanında tüm migration zinciri çalıştırılmalı; 0105 ve sonraki migration'lar başarıyla tamamlanmalıdır.
- Ayrı bir geçici veritabanı önce 0104'e kadar kurulmalı. Şirket ve yukarıdaki hesap kodları bulunan gerçek bir yükseltme örneği hazırlanmalı; mevcut eşlemeler ve mali kayıtlar varsa başlangıç değerleri saklanmalıdır.
- Güncel zincir bu dolu örneğe uygulanmalı. Eklenen eşlemelerin kimlikleri dolu ve benzersiz olmalı; şirket/anahtar başına tek eşleme bulunmalı; mevcut eşlemeler ve geçmiş mali tutarlar değişmemelidir.
- Migration işlemi ikinci kez çalıştırıldığında yeni eşleme veya ikinci 0105 geçmiş kaydı oluşmamalıdır.
- Yükseltme testi geliştirme ya da müşteri veritabanını sıfırlamadan, yalnız kendi geçici veritabanları üzerinde yapılmalıdır.

9 Ekim'de `apps/api/test/migration-upgrade-0105.test.ts` gerçek 0104 SQL/günlük zinciriyle ayrı geçici veritabanı kurdu. Mevcut hesaplar, özelleştirilmiş stok eşlemesi, kesinleşmiş GBP faturası, dengeli yevmiye, manuel kur ve KDV kaydı oluşturuldu. Güncel zincire yükseltme; altı yeni eşlemenin kimliklerini, mevcut eşlemenin aynen kalmasını, geçmiş tutarların değişmemesini ve tekrar çalıştırmada mükerrer migration/eşleme oluşmamasını doğruladı. Ülke `legacy_manual`, eski belgelerin şubesi ve mevzuat görüntüsü boş kaldı. Test geçici veritabanı ve klasörünü temizledi; geliştirme veritabanına uygulanmadı.
