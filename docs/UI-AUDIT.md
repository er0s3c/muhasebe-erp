# Arayüz ve tahmin doğrulaması

7 Ekim 2026 tarihinde Örnek İnşaat Ltd. ve Ada Üretim ve Toptan Ticaret Demo şirketlerindeki menüler incelendi. Toplam 113 farklı menü yolu, şirket bağlamıyla 200 sayfa ziyareti olarak masaüstünde (1440 × 960) ve mobilde (390 × 844) tarandı. Ekran görüntüleri görsel olarak incelendi; değiştirilen bölümler için 81 sayfa ziyareti tekrar doğrulandı. Ayrıca 29 kayıt ayrıntısı, yeni belge ve deri/POS alt ekranı iki ekran boyutunda kontrol edildi.

## Düzeltilen alanlar

- Üretim, planlama, WMS ve sevkiyat tablolarında okunabilir kodlar, Türkçe durumlar, tarih ve miktar biçimleri kullanılır. Eski UUID kodları da aynı kayıt için kararlı bir görünen koda dönüşür; aramada bu kod bulunabilir.
- Üretim menülerindeki 11 işlev farklı ikonlarla gösterilir; tanımlı bütün menü ikonlarının karşılığı vardır.
- Satır işlemleri ortak yan panelde açılır. Başarılı işlem paneli kapatır, hata durumunda girilen değerler korunur. Panel kapanınca odak işlem düğmesine döner.
- WMS sekmeleri yalnız ilgili ekleme formunu gösterir. Yerleştirme miktarı ile partinin kalan miktarı ayrı anlamlarla sunulur.
- Modül adları ve açıklamaları, para birimi gösterimi, gölge ve ilerleme göstergeleri mevcut tasarım kurallarına uyar.
- İnşaat satın alma sayfalarındaki modül koruması, inşaat satın alma modülünü de kabul eder. Sunucudaki proje ve yetki kuralları korunur.
- Üretim süresi ve nakit projeksiyonu geçmiş veriye dayalı tahmin sağlar. Hesaplama, örnek sayısı, veri eksikliği ve elle değişiklik davranışları [FORECASTING.md](FORECASTING.md) içinde açıklanır.

## Kontroller

Menü taramasında görünür ham UUID, İngilizce durum, başlıksız veya yetkisiz sayfa, iç içe form, sayfa düzeyinde yatay taşma ve tarayıcı hataları kontrol edilir. Geniş tablolar kendi yatay kaydırma alanını kullanabilir.

- Paylaşılan paket: 716 test geçti.
- Arayüz: 11 test geçti.
- Son API doğrulaması: çalışma alanı, okunabilir kayıt araması, nakit tahmini ve üretim akışında 22 test geçti.
- Tarayıcı: menü taraması, detay/alt ekranlar, WMS sekmeleri ve kalite paneli geçti. Üretim senaryosu oluşturma/yayımlama/iptal, dokuz demo profilinin erişimi, deri/POS akışları ve inşaat satın alma regresyonları da geçti.
- Typecheck, lint, build ve diff boşluk kontrolü geçti.

Tekrarlanabilir tarayıcı kontrolleri: `e2e/ui-audit.spec.ts`, `e2e/ui-details.spec.ts`, `e2e/manufacturing-demo.spec.ts`. `UI_AUDIT_FILTER` ile değişen menü yolları seçilebilir. Ekran görüntüleri ve JSON sonuçları yok sayılan `.cache/ui-audit` dizininde tutulur.

## 8 Ekim ERP/MES ekranları

`e2e/manufacturing-execution.spec.ts`; taahhüt/tahsis, atölye, tedarik, müdahale, kapasite ve entegrasyon ekranlarını 1440 ve 390 piksel genişlikte denetler. Gerçek ATP hesabında açık üretim ve eksik plan açıklaması; atölyede henüz sarf edilmemiş teslim gösterilir. Sayfa içindeki kaydırma alanı ayrıca ilerletilerek alt tablolar ve maliyet kapanış bölümü görüntülenir. Tam sayfa fotoğrafının iç kaydırmayı kırpması, ürün düzeni hatası olarak sayılmaz.

Yeni ekranlar ortak kart, tablo, alan ve yan panel bileşenlerini kullanır. Ham UUID/durum, sayfa düzeyinde yatay taşma ve tarayıcı hatası kontrolleri geçti. ATP dayanağındaki satış tahsisi diğer siparişlere ait miktar olarak adlandırılır; aynı siparişin tahsisi ATP'ye dahildir. Hesaplama bildirimi kayıt oluşturulduğunu söylemez. Güncel test/kabul kaydı: [MANUFACTURING-ACCEPTANCE.md](MANUFACTURING-ACCEPTANCE.md).
