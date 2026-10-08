# Üretim ve Toptan Ticaret

`MANUFACTURING_WHOLESALE` ve `LEATHER_FASHION` aynı katalog, reçete, üretim, rezervasyon, kalite, fason ve maliyet servislerini kullanır. Derinin fiziksel alan/parça, kesim, özel sipariş ve servis ekranları `/leather` altında kalır. Muhasebe, cari, stok, satış, finans ve personel mevcut ortak ekranlardır. İnşaat satın almalarında proje/WBS kuralları devam eder; iki üretim sektöründe proje zorunlu değildir.

## Demo girişi

Örnek Holding içindeki **Ada Üretim ve Toptan Ticaret Demo** ayrı şirkettir. **Örnek İnşaat Ltd.** ve mevcut kullanıcıları korunur. Bütün yeni demo kullanıcılarının ilk şifresi **Demo-Sifre-123**. Yeniden yükleme mevcut şifreyi değiştirmez.

| Hesap | Rol / kullanım | Şirket |
|---|---|---|
| demo@ornek.local | Sahip; şirket seçicisinden geçiş | İnşaat ve üretim |
| uretim.planlama@ornek.local | Operasyon yöneticisi; katalog, reçete, MRP, kapasite, üretim ve fason | Yalnız üretim |
| uretim.atolye@ornek.local | Operatör; atanmış üretimde operasyon, süre ve sonuç | Yalnız üretim |
| uretim.depo@ornek.local | Operatör; stok, WMS, satın alma kabulü ve sevkiyat | Yalnız üretim |
| uretim.kalite@ornek.local | Operasyon yöneticisi; kalite ve parti serbest bırakma | Yalnız üretim |
| uretim.satis@ornek.local | Satış; cari, teklif/sipariş, fiyat ve sevkiyat görüntüleme | Yalnız üretim |
| uretim.muhasebe@ornek.local | Muhasebeci; muhasebe, finans, fatura ve üretim maliyeti | Yalnız üretim |
| uretim.bakim@ornek.local | Operatör; makine, bakım, arıza, yedek parça ve kapasite okuma | Yalnız üretim |
| uretim.kasiyer@ornek.local | Operatör; atanmış POS kasası ve kendi açık vardiyası | Yalnız üretim |
| uretim.izleyici@ornek.local | İzleyici; katalog, MRP, üretim ve kapasiteyi salt okunur görme | Yalnız üretim |

Profiller izin listesi uygular; diğer erişim alanları açıkça kapalıdır. API izinleri de aynı kuralları denetler. Operatör yalnız atandığı üretimi yönetir. Kasiyer genel muhasebe/kasa-banka, fiyat istisnası ve iade onayı alamaz.

```powershell
npm run db:migrate
npm run db:seed                  # ilk kurulum veya mevcut demo üstüne ekleme
npm run demo:manufacturing       # mevcut demo hesabına yalnız üretim şirketini ekleme/güncelleme
```

Kurulum şirket kimliği, kuruluş kilidi ve `manufacturing-demo-v1/v2/v3/v4/v5` veri sürümleriyle çalışır. Aynı komutu tekrar çalıştırmak şirket, kullanıcı, stok veya finans hareketi çoğaltmaz. Bir senaryo başarısızsa o şirketin kurulum işlemi geri alınır; sonraki çalıştırma yeniden dener. Mevcut verileri silmek gerekmez. Üretim ortamındaki demo komutları ayrıca mevcut `ALLOW_DEMO` korumasına tabidir. V3, açık üretimin kaynak satış siparişi bağlantısını ve takvimlerini tamamlar. V4, ayrı MES hammadde/mamulü, uygun kaynaklı rota, iki batch, kısmi kabul, rework, tahsis, kalite blokesi, tedarik profili ve minimum stok ekler. V5, sarf edilmemiş atölye teslimi örneğini ekler; bu teslim stok miktarı veya değeri yaratmaz. Demo bağlantısı dış gönderim yapmaz.

Demo; 120 başlangıç mamulü, 500 adet sipariş, 380 adet açık üretim, çok seviyeli reçete, 100 adet kısmi kabul, kalite karantinası, makine takvimi/bakımı, operasyon transferinin kısmi kabulü, fason dış depo ve kısmi dönüşü, paketlenmiş irsaliye, satış/tahsilat ve atanmış POS kasasını içerir. Kısmi üretim ve satış sonrasında güncel net ihtiyaç başlangıçtaki 380’den farklıdır; MRP gerçek güncel stoğu hesaplar.

## Kullanım

1. `/manufacturing/catalog`: ürün ailesi, onaylı revizyon, malzeme/alternatif, yan ürün payı ve serbest operasyon rotası. Mamul ve yarı mamul SKU mevcut stok kartına bağlanır. Yeni üretim onaylı reçeteyi kopyalar; sonraki revizyon değişikliği eski emri etkilemez.
2. `/manufacturing/mrp`: brüt talep eksi kullanılabilir stok; çok seviyeli üretim/satın alma ihtiyacı. 500 talep ve 120 serbest stok için 380 üretim. Stok farklı reçete dallarında birden fazla kullanılmaz; döngüler reddedilir. Alt emirler ana emre bağlıdır.
3. `/manufacturing/production`: serbest bırakma, rezervasyon, gerçek sarf/iade, süre, iyi adet, fire ve yeniden işleme; son kalite onayıyla kısmi mamul kabulü. Normal fire WIP içinde, kalite onaylı anormal kayıp ayrı hesapta izlenir.
4. `/manufacturing/planning`: iş merkezi/makine/personel kaynağı, vardiya/fazla mesai/devamsızlık, ileri/geri kapasite senaryosu. Birden fazla emrin rota operasyonları birlikte planlanabilir; önceki operasyon bağı korunur. Süre önerisi gerçek üretim sürelerinden veya onaylı rotanın standart süresinden gelir; elle değişiklik ayrıca gösterilir. Çalışma aralıkları bakım ve yayımlanmış işler düşülerek bulunur. Uzun iş vardiyalar arasında bölünür; boş saatlerde kapasite yaratılmaz. Taslak tarih değişikliği yeni sürüm oluşturur; yayımlarken takvim ve kaynak uygunluğu yeniden kontrol edilir. Tekrar eden vardiya/tatil şablonu, net kapasite/darboğaz, parent/sürüm/termin farkı ve sanal kaynak varsayımları burada bulunur. Varsayımlı plan doğrudan yayımlanamaz.
5. `/manufacturing/maintenance`: arıza/bakım kapasiteyi bloke eder; tamamlamada parça sarfı stok ve muhasebeye bir kez kaydolur. MTTR/MTBF ve OEE kaynağı belirtilir; gerçek süre olmadan OEE üretilmez.
6. `/wms`: kaynak stok kabul belgesine bağlı parti, seri ve raf; karantina/bloke miktarı kullanılabilir stoktan düşer. Serbest bırakma kalite onayı ister. Mamul kabulü otomatik parti oluşturur. Üretim sarfı, depo transferi, satış ve kaynak iadesi parti izini sürdürür; çıkışlarda raftaki kalan miktar da azalır. İade edilen miktar yeniden yerleştirilene kadar rafta sayılmaz. Parti ayrı maliyet havuzu değildir.
7. `/logistics`: mevcut kayıtlı satış irsaliyesindeki miktarlarla eşleşen koli/palet, taşıyıcı, takip numarası ve teslim durumu. Paketleme ikinci stok çıkışı üretmez.
8. `/manufacturing/subcontracting`, `/manufacturing/costs`, `/pos`: ortak fason, maliyet ve mağaza servisleri. Fason dış depo şirket mülkiyetindedir; malzeme gönderimi satış değildir. POS fatura ve tahsilatı aynı işlemde kaydeder; tekrar isteği ikinci satış yaratmaz.
9. `/manufacturing/promise`: onaylı sipariş için ATP/CTP önerisi; stoktan karşılanan, bağlı açık üretim ve yeni ihtiyaç ayrı gösterilir. Plan, tedarik süresi veya kalite verisi eksikse tarih boş kalır. Tahsis miktarı/önceliği nedenli komutla kaydedilir; öneri kendiliğinden stok ayırmaz.
10. `/manufacturing/shop-floor`: atanmış iş koduyla bulma, kaynak/batch seçimi ve başlat/duraklat/tamamla. Canlı başlangıç gerçek vardiyayı kullanır. Atölyeye teslim, kullanılmadan iade ve gerçek sarf ayrı gösterilir; transfer ve işe başlama beklemesi gerçek zaman damgalarından ölçülür. Rework tekrar kalite onayı ister. Üretim ayrıntısında maliyet kapanış kontrolü ve standart malzeme/gerçekleşen maliyet kaynağı bulunur.
11. `/manufacturing/supply`: malzeme/tedarikçi ürün kodu, fiyat, termin, MOQ/paket ve minimum/hedef stok. Öneriler mevcut satın alma talebi zincirine bağlanır.
12. `/manufacturing/exceptions`: kaynak kayda bağlı gecikme, kalite, malzeme, kapasite, bakım, fason ve transfer müdahaleleri; sorumlu, öncelik, çözüm ve yeniden açma.

Kalite görev profili üretim düzenleme izni olmadan rework kaynağını görebilir ve kalite onayıyla iş açabilir; gerçek operasyon sonucunu atölye kaydeder. Üye erişimi düzenlenirken taslak önizleme de sunucunun merkezi etkin izin motorunu kullanır.

SKU bazlı hareketli ağırlıklı ortalama korunur. Faturasız kabul geçici değer ve tahakkuk yaratır; bağlı fatura ikinci stok girişi yapmaz. Kaynak bordro/fatura/gider satırları yalnız kullanılmamış tutarları kadar bir kez tahsis edilir. Geç farkın maliyet pay izi hammadde, WIP, mamul, faturalanmamış sevk, satış ve kayba ilerler. 1.000 TL / %20–%30–%25–%25 örneği 200/300/250/250 TL’dir. Kapalı dönem değiştirilmez; düzeltme açık dönemde yeni belge olur.

Planlama ekranında şube/departman bağlantıları ve özel alan tanımları yönetilir. Stok kartı, model, üretim emri ve kaynakta metin, sayı, tarih veya seçim alanları kullanılabilir. Personele bağlı kaynakların gerçekleşen iyi adedi veya çalışma saati, tanımlanan birim ücretle mevcut taslak bordroya prim olarak aktarılabilir. Bu işlem üretim maliyeti yetkisine ek olarak bordro yönetim yetkisi ister; demo muhasebecisine kendiliğinden İK erişimi verilmez.

## Entegrasyon sözleşmeleri

`/integrations` bağlantı ve hata kuyruğunu gösterir. Kimlik bilgisi yokken kanal **disconnected**, bilgiler kaydedilince **configured** durumundadır; bu durum canlı doğrulama yapıldığı anlamına gelmez. Demo şirketi dış servis çağrılarını reddeder.

**Stok gönderimi yalnız elle başlatılır.** Bağlantı tanımlamak otomatik gönderimi açmaz. Ada'daki serbest stok değişimleri eşlenmiş SKU/lokasyon için outbox kaydı oluşturur; ekrandan gönderim komutu verilince sağlayıcıya iletilir. Yeni miktar eski bekleyen kaydı geçersiz kılar. Hatalarda tekrar zamanı ve deneme sayısı saklanır; beş hatadan sonra dead-letter, nedenli manuel tekrar gerekir. Shopify cevabı kaybolursa aynı stok komutu/idempotency ve ilk karşılaştırma miktarı korunur.

Shopify webhook'u bağlantı sırrıyla ham gövde imzasını, mağaza ve konuyu doğrular. Aynı dış sipariş sürümü/yükü tekrar satış oluşturmaz; değişen yeni sürüm inceleme bekler. Bu kayıt, kayıtlı sipariş/fatura üzerinde otomatik mali değişiklik yapıldığı anlamına gelmez.

- Shopify: özel erişim belirteciyle Admin GraphQL, sayfalı sipariş alma ve SKU/müşteri/depo eşleştirme; stok güncellemesinde sağlayıcının idempotency anahtarı ve mevcut miktar kontrolü. Satır fiyatı indirimlerden sonra vergi hariç tutardan türetilir.
- Ticimax: resmî SOAP sipariş servisi; alan ve birim/satır fiyatı bazının servis sözleşmesine göre açıkça eşlenmesi gerekir. Kaynak sipariş kimliği tekildir. Mağazanın servis sürümü ve yetkileri canlı kurulumda doğrulanmalıdır.
- PDKS: `POST /api/integrations/connections/:id/attendance-file` mevcut `upsertAttendanceSchema` puantaj servisini kullanır. Personele bağlı kaynaklarda devamsızlık takvim blokesi oluşur. Kapalı puantaj ayı açılamaz. Normalleştirilmiş çalışma günü bu adaptörde UTC gün aralığıdır.
- Banka: `POST .../bank-file`, mevcut ekstre içe aktarma planlama/uygulama servisini kullanır; alan eşlemeli satırlar ve `bankStatementOptionsSchema` kabul eder. Tahsilat veya muhasebe fişi kendiliğinden uydurulmaz.
- E-belge: `POST .../invoice-outbox`, kayıtlı faturayı kuyruğa bağlar. Sağlayıcı ve canlı bağlantı tanımlanmadan gönderim yapılmaz.

API/dosya sözleşmeleri `/api/integrations/adapters` altında bulunur. Aktarım yetkisi ilgili İK/finans iznini de gerektirir. Sipariş aktarımı ödeme bildiriminden bağımsızdır; dış kanalda “paid” görülmesi banka tahsilatı oluşturmaz. Canlı mağaza, banka, PDKS veya e-belge kimlik bilgileri bu geliştirmede kullanılmadı.

## Dağıtım ve doğrulama

Önce lisans sunucusu/panelini ve sektör migration’larını, sonra ERP migration’ları ile uyumlu paketi dağıtın. İmzalı istemci sektör yetenekleri bulunmayan eski ERP’ye yeni sektör lisansı verilmez. Mevcut şirketlerin sektörleri otomatik değiştirilmez.

```powershell
npm run typecheck
npm run lint
npm test -w @erp/shared
npm test -w @erp/api
npm test -w @erp/license-server -- test/leather-license.test.ts
npm run build
npm run build:license
# Demo kurulmuş yerel uygulama ve Chromium/Edge ile:
npm run e2e -- e2e/manufacturing-demo.spec.ts e2e/leather-flow.spec.ts
```

Yedekleme PostgreSQL şemasını ve bağlı dosyaları kapsar; yeni üretim tablosu dahildir. Geri yükleme kabul testi ayrı kurtarma veritabanı kullanır; mevcut demo/çalışma veritabanının üstüne yazmaz.

İlk sektör dağıtımının önceki kabulünde 935 API, 709 ortak paket, 38 lisans çekirdeği ve 5 lisans sektör testi; dört tarayıcı senaryosu ve ayrı PostgreSQL yedek/geri yükleme akışı geçmişti. Bunlar sonraki ERP/MES eklerinin güncel sonucu değildir. 29 maddelik değerlendirmeye karşı son uygulama, test sonuçları ve kalan canlı ortam sınırları [ERP/MES kabul kaydında](MANUFACTURING-ACCEPTANCE.md) tutulur.
