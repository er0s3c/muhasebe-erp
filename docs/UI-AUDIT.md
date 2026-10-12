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

## 8 Ekim tüm ekranlar, erişim ve bakım düzeltmeleri

İki demo şirketinde 117 farklı menü yolu, şirket bağlamıyla 204 sayfa ziyareti olarak 1440 × 960, 390 × 844 ve 1280 × 720 boyutlarında kontrol edildi. 612 ekran görüntüsü ve kaydırılabilen sayfaların 53 alt bölüm görüntüsü görsel olarak incelendi. Son düzeltmelerden sonra değişen sayfalar aynı üç boyutta yeniden tarandı; birleşik sonuç `.cache/ui-audit/layout-reviewed/report.json` dosyasındadır. Ayrıca 29 kayıt ayrıntısı/yeni belge ekranı iki boyutta, seçili Atölye işi ve alt panelleri, modül erişimi ve bakım akışları tarayıcıda doğrulandı.

- Ana içerikte tek dikey kaydırma alanı kullanılır. Sayfa içindeki ikinci dikey liste kaydırmaları kaldırıldı; geniş tabloların yatay kaydırması korunur. Gizli seçim alanlarının belgeyi uzatması da giderildi.
- Dar ekranlarda başlıklar, işlem düğmeleri, arama alanları ve formlar alanlarına sığar. Uzun düğme metinleri kırpılmaz; gösterge tutarlarının yazı boyutu kart genişliğine uyarlanır. POS sepeti ayrıca 320 ve 390 piksel genişlikte uzun ürün adı ve büyük tutarla kontrol edildi.
- Üretim partisi, işe başlama, ürün kodu ve metraj gibi Türkçe terimler kullanılır. Teknik UUID v7 değerleri de okunabilir, birbirinden farklı kayıt kodlarına dönüşür; aynı kodla arama çalışır. Faaliyet raporunda başlıksız kayıtlar kısa, kararlı kayıt etiketleriyle gösterilir.
- Nakit projeksiyonundaki çubuk, gösterilen haftaların en büyük mutlak kapanış bakiyesine göre bakiye büyüklüğünü karşılaştırır. Açıklama, pozitif/negatif renk göstergesi ve tutar bilgisi eklenmiştir; sıfır bakiye dolu bir çubuk göstermez.
- Modül erişiminde gerçek API işlem hakları ayrı yönetilir. Modül/işlem araması, etkin hak önizlemesi ve değişiklik özeti vardır. Kapalı modül, rol sınırları, sahip koruması ve yöneticinin kendi yetki sınırı sunucuda uygulanır.
- Bakım/arıza kaydı yalnız başlangıçla açılır; gerçekleşen bitiş sonradan girilir. Açık kayıt kaynak kapasitesini kapatır. Gelecekte veya başlangıçtan önce bitiş reddedilir; yedek parça sarfı bir kez yapılır. Saat seçici alanın tamamına tıklanınca açılır; klavyeyle giriş de korunur.

Son doğrulamalarda görünür ham kimlik/durum, belge veya ana içerikte yatay taşma, ikinci dikey kaydırma, kesilen düğme yazısı, iç içe form ve tarayıcı hatası bulunmadı. Bakım API akışında 11, paylaşılan bakım hesaplarında 13, okunabilir kayıt aramasında 5, yeni işlem izinlerinde 6 ve sahip güvenliğinde 3 test geçti; erişimle ilişkili paylaşılan 55 ve mevcut API 38 regresyon testi de geçti. Arayüzün 11 testi, typecheck, lint ve build başarılıdır.

Tekrarlanabilir ek kontroller: `e2e/maintenance-flow.spec.ts`, `e2e/module-access-flow.spec.ts`, `e2e/manufacturing-execution.spec.ts`. Menü taraması oturum yönlendirmesini ve gerçek sayfa başlığını da doğrular; giriş sayfası görüntülerini sayfa kontrolü olarak kabul etmez.

## Koyu tema ve müşteri geri bildirimi

Koyu temada responsive logo gizleme sınıflarının çakışması giderildi. Açık/koyu tema, tam/dar/mobil menü ve giriş ekranı toplam dokuz durumda kontrol edildi; her durumda tek görünür logo vardır.

Müşteri formu açıklama, yalnız ekran görüntüsü ve ikisini birlikte kabul eder. Ekran adını otomatik ekler; sorunun oluştuğu adımlar ve beklenen sonuç isteğe bağlıdır. Dosya önizlemesi, sürükleme/yapıştırma, hata sonrası taslağın korunması, tekrar gönderim ve yalnız gerçek alıcı kabulünden sonra başarı gösterimi doğrulandı. Mobil üst çubuk ve panel 320/390 pikselde, koyu temada da sığar. Satıcı yönetici kutusunun masaüstü/mobil görüntüleri ve filtre, arama, sayfalama, durum/not, CSRF, boş ve hata durumları 11 senaryoda kontrol edildi.

Ek kontroller: `e2e/feedback-flow.spec.ts` dört tarayıcı testi; gerçek ERP ve satıcı uygulaması üzerinden imzalı gönderimin altı entegrasyon testi; ilişkili güvenlik ve lisans kapılarıyla birlikte API 41, lisans sunucusu 44 ve lisans çekirdeği 41 test geçti. Yerel demo kurulumu merkezi alıcıya bağlı değildir; bu durum gönderim kapalı olarak açıkça gösterilir. Kurulum ve veri akışı: [FEEDBACK.md](FEEDBACK.md).

Son birleşik tarayıcı koşusunda geri bildirim, bakım, ayrıntılı modül erişimi, seçili Atölye işi, değişen menü sayfaları, kayıt ayrıntıları, deri/POS ve WMS kontrolleri toplam 12 test olarak geçti. Tüm çalışma alanlarının typecheck ve lint kontrolleri, ERP/API ile satıcı paneli/sunucusu derlemeleri başarılıdır.

## 9 Ekim kullanıcı değişiklikleri ve rapor devamı

Sayfa rehberi dokunma/tıklama ve Escape ile kullanılabilen açılır pencereye taşındı; ortak başlık ve kartlarda uzun metinlerin alanı genişletmesi engellendi. Asistanın şirket/kullanıcı/şube kapsamı, temizleme ve açık isteği iptal etme davranışları kontrol edildi. 390 × 844 açık/koyu temada uzun cevap tek dikey kaydırma alanında kalır; şirket değişince önceki mesajlar yeni isteğe eklenmez. Gerçek Gemini çağrısı yerine kontrollü API cevapları kullanıldı.

Satış ve alış raporlarında şube ve kaydı oluşturan kullanıcı kırılımı eklendi. Şubesiz eski kayıtlar açık etiket taşır. Uzun şube/kullanıcı adları satıra bölünür; geniş mali tablo kendi yatay kaydırma alanını kullanır. Fatura kırılımındaki fazladan toplam hücresi kaldırıldı. Başlık/gövde/toplam sütun uyumu, 390 ve 1280 px açık/koyu temada düğme/sekme görünürlüğü ve seçili kırılımı kullanan altı CSV indirmesi tarayıcıda geçti.

`e2e/review-ui.spec.ts`, `branch-report-ui.spec.ts` ve `offline-drafts.spec.ts` birlikte beş başarılı senaryo olarak çalıştı. Üretim paketinin gerçekten internet kesikken yeniden yüklenmesi `OFFLINE_PRODUCTION_QA=1` ile dahil edildi. Görseller `test-results/review-ai-*.png` ve `review-report-*.png` dosyalarındadır; tema geçişi animasyonları bitirilmiş görüntüler görsel olarak incelendi.

## 10 Ekim kapasite ve termin ekranının sadeleştirilmesi

Günlük planlar, kapasite ve takvim/kaynak ayarları üç sekmeye ayrıldı. Yeni plan oluşturma düğmesi sayfanın üstündedir; üretim emirleri, tarih/yön ve kontrol adımlarından oluşan yan panel açar. Tamamlanan işlemler ve daha önce seçilen emirler tekrar eklenmez. Uygun aktif kaynak ve tam dakika kontrolleri, operasyon sırası ve önceki işlem bağımlılıkları korunur. Mobil özet kartları tek kısa satırdadır.

Taslak ve yayımlanmış planlar başlangıç/bitiş kartlarıyla gösterilir; işlem tarihleri, sürüm/maliyet karşılaştırmaları ve diğer ayarlar gerektiğinde açılır. Deneme koşulları içeren planlar yayımlanamaz. Kapasite kartları süreleri saat/dakika ve doluluk olarak gösterir; sıfır kullanılabilir süre yalnızca eksik takvim olarak yorumlanmaz. Vardiya günleri hafta adlarıyla seçilir; tanımlı çalışma aralıkları kaynağa göre süzülebilir. Eski planlama dalları temizlendi, bakım akışı korundu.

`e2e/planning-ui.spec.ts` içindeki beş kontrollü API senaryosu; 390/1280 px açık/koyu tema, sekmeler, üç adımlı plan, yinelenen emir engeli, uygun kaynak, süre doğrulaması, teslimden geriye hesaplama girdileri, yayımlama hatası/tekrar deneme/iptal, görüntüleme yetkisi ve haftalık takvim kontrollerini geçti. Ekran görüntüleri `test-results/planning-ui-*/planning-*.png` altındadır; yeni mobil yerleşim görsel olarak incelendi. Web paketindeki 41 test, ilgili dosyaların ESLint kontrolü, web tip kontrolü ve üretim derlemesi geçti.

Mevcut `demo@ornek.local` hesabında eski genel üretim demo şirketi bulunmadığı için ona bağlı `manufacturing-demo.spec.ts` senaryosu şirket seçiminde tamamlanamadı. Mevcut deri demo şirketinde ayrı, kayıt oluşturmayan gerçek API tarayıcı kontrolü geçti: üç sekme, kayıtlı çalışma aralıkları ve açık üretim emrinin süre tahminlerini kullanan yeni plan kontrol adımı açıldı. Bu kontrolün yerel dosyası `.cache/planning-live-check.spec.ts`; mevcut veriler sıfırlanmadı.
