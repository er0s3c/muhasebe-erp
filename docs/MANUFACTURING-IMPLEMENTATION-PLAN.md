# Üretim ERP/MES ekleri — uygulama planı

Bu plan 7 Ekim 2026 tarihli kod karşılaştırmasındaki açıkları kapatır. WIP, SKU ortalama maliyet, muhasebe, cari, stok, satın alma, satış, fason ve servis çekirdekleri yeniden yazılmaz. Aynı ekler genel üretim ve deri şirketlerinde ortak motoru kullanır. İnşaatın proje/WBS kuralları korunur.

## 1. Sipariş taahhüdü ve talep/arz

- Şirket/depo/SKU bazında fiziksel stok, kalite miktarı, üretim rezervasyonu ve satış tahsisini tek kullanılabilirlik hesabında birleştir.
- Onaylı satış satırlarında kalıcı tahsis, kısmi karşılama, üretim bağlantısı, backorder, öncelik ve değişiklik nedeni tut. Kaynak sevkiyat tahsisi çözer; iptal kalan tahsisi bırakır. Eşzamanlı talepleri şirket maliyet kilidi ve ürün kilitleriyle sırala.
- ATP stoktan verilebilen miktarı; CTP kalan ihtiyacın malzeme tedariki ve uygun kaynak/kapasiteyle beklenen teslim tarihini gösterir. Veri yetersizse tarih uydurulmaz, eksik neden gösterilir. Öneri tahsis değildir; kullanıcı komutu kaydeder.
- MRP'ye açık satın alma arzı, tedarik tarihi, MOQ, tedarikçi ürün kodu/fiyatı/termini, minimum stok ve tedarik performansı ekle. Mevcut talep → RFQ → teklif → sipariş → kabul zincirine bağlan.

## 2. Üretim yürütme

- Emirde malzeme bekliyor, hazır, çalışıyor, duraklatıldı, kalite bekliyor, yeniden işleme, fiziksel tamamlandı, maliyet kapandı ve bekletildi aşamalarını mevcut mali belge durumundan ayrı izleyerek uyumluluğu koru.
- Atanmış işler için başlat/duraklat/tamamla komutları, aktif süre oturumları, kaynak, batch, iyi adet/fire/rework ve barkod/kod araması ekle. Operatörün başka işi veya maliyeti görmesini engelle.
- Batch bölme ve batch bazlı malzeme/operasyon/kalite/mamul lot bağlantısı kur. Rework kaynağı, hedef operasyon, hata nedeni ve tekrar kalite kaydı tut.
- Sarf/iade/fire/WIP mutabakatı ve operasyon kuyruk/ara stok görünümü ekle. Müşteri tamir ürünü şirket stok miktarı yaratmaz; servis teknisyeni/süre kaydı mevcut servis maliyetine bağlanır.

## 3. Kaynak ve planlama

- Onaylı rota revizyonunda uygun kaynaklar ve standart hızlar tanımla; mevcut emir kopyası değişmez.
- Tekrar eden vardiya şablonları, tatil/izin/bakım istisnaları ekle. Yük/net kapasite oranı ve darboğaz listesi çıkar.
- Plan parent/sürüm/değişiklik nedeni ve tarih farkını sakla. What-if takvim/kaynak varsayımlarını yalnız senaryoda uygula; gerçek kaynak takvimi değişmez. Yayımlarken güncel kapasite ve uygunluk kontrol edilir.

## 4. Deri ve kalite

- Deri kusur bölgeleri, damar yönü ve kalıp kaydı; elle kesim planı, seçilen parçalar, hedef set, tahmini verim ve gerçek kesim bağlantısı ekle. Otomatik nesting bu sürümün kabul ölçütü değildir.
- Mal kabul ve satış iadelerini üretim şirketlerinde kalite beklemeye al; parti içinde serbest/blokeli/karantina/hasarlı miktarı ayrı tut. Kısmi kabulün yalnız kabul edilen miktarı ATP/MRP'ye girer.
- Kaynak iade, fason kısmi dönüş ve yeniden kalite kontrolünü ortak stok/maliyet iziyle sürdür. Kalan parçada ikinci değer oluşmaz.

## 5. Yönetim ve entegrasyon

- Geciken sipariş, malzeme eksiği, kapasite aşımı, arıza, kalite, fason ve transfer için bağlantılı müdahale listesi; sahip/öncelik/çözüm kaydı ekle.
- Üretim maliyet kapanış kontrolü, açık WIP/malzeme/kalite/fason kontrolü ve standart–gerçekleşen sapmayı göster. Kapalı muhasebe dönemini değiştirme; yeni farklar açık dönem belgesidir.
- Ada ana stok kaynağıdır. Kanal SKU/lokasyon eşlemesi ve stok değişimi outbox'ı ekle. Shopify/Ticimax sipariş kimliği + sürüm + olay tekilliği; webhook doğrulama, backoff, rate limit, dead-letter, manuel tekrar ve sync geçmişini tamamla. Kullanıcının 8 Ekim kararıyla dış stok gönderimi yalnız elle başlatılır; otomatik gönderim işçisi eklenmez. Demo dış sisteme göndermez.

## Teknik sözleşme

Yeni operasyon nesneleri şirket RLS ve audit kapsamındaki kayıt altyapısına eklenir; ilişkilendirilen kimlikler aynı şirket içinde doğrulanır. Değişmez komut olayları kaynak durum kayıtlarından ayrılır. Her yazma komutunda requestKey ve içerik özeti bulunur; aynı anahtar farklı içerikle kullanılamaz. Stok ve muhasebe değiştiren işlemler mevcut transactional servisleri çağırır.

API'ler `/api/manufacturing/*`, `/api/wms/*`, `/api/leather/*`, `/api/integrations/*` altında; şemalar ortak pakette, arayüzler mevcut tasarım bileşenleriyle oluşturulur. Mevcut modüllerin izinleri kullanılır; yeni modül/lisans ürünü yaratılmaz. Menü ve doğrudan API denetimi aynı yetki sözleşmesine uyar.

## Kabul

1. 500 − 300 tahsis − 50 kalite = 150 ATP; 200 sipariş için 50 üretim. Eşzamanlı tahsis aynı stoğu kullanamaz; sevk/iade/iptal bakiye doğrulanır.
2. MOQ/termin/açık sipariş arzı MRP ve CTP'de görünür; üretim ve satın alma tekrar komutları hareket çoğaltmaz.
3. Operatör sadece atanmış işte süre kaydeder; duraklama üretim süresine eklenmez. Batch ve rework kalite izi korunur.
4. 1.000 malzeme = 850 tüketim + 100 fire + 50 iade; WIP/mamul/kayıp değerleri ortak muhasebeyle mutabıktır.
5. Simülasyon gerçek takvimi/stok defterini değiştirmez; plan sürümü sebep ve fark gösterir. Kuyruk ile işlem süresi ayrı raporlanır.
6. Deri alan mutabakatı, kısmi kalite, iade karantinası, fason emanet ve servis müşteri varlığı doğrulanır.
7. Aynı dış olay tek sipariş oluşturur; yanlış imza reddedilir, retry zamanı uygulanır, kalıcı hata dead-letter'a gider; demo dış çağrı yapmaz.
8. Yeni şirket/rol izolasyonu, mevcut inşaat ve maliyet regresyonları, typecheck/lint/build ve masaüstü/mobil tarayıcı kontrolleri geçer.

Uygulama durumu ayrı kabul kaydında tutulur; planın yazılması özelliklerin tamamlandığı anlamına gelmez.
