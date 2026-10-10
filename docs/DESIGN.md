# Ada ERP V2 — Tasarım sistemi

Ada ERP, gerçek işletmelerin muhasebe ve operasyonlarını yönettiği bir iş uygulamasıdır. V2 kimliği mevcut sarı A simgesini, limon sarısı eylem rengini ve sıcak nötr yüzeyleri korur. Düzen ve metinler, yeni kullanıcıya işlemin amacını; uzman kullanıcıya belge durumunu, parasal doğruluğu ve bir sonraki adımı açıkça göstermelidir.

## Ortak kaynak ve değişmezler

- ERP ve satıcı/lisans paneli `apps/web/src/styles/tokens.css` ile `base.css` dosyalarını kullanır. Uygulamaların `styles.css` dosyaları font/Tailwind girişini ve kendi baskı kurallarını taşır. Panel mevcut `@ui` alias'ıyla aynı primitive bileşenleri kullanır; ikinci UI paketi veya yeni UI bağımlılığı yoktur.
- Ham ekran renkleri yerine `bg-surface`, `text-muted`, `border-border`, `text-danger` gibi anlamsal sınıflar kullanılır. Marka rengi dekoratif büyük yüzeylere veya okunması zor sarı metne dönüştürülmez.
- İş kuralları, API sözleşmeleri, yetki/tenant/şube kapıları ve para hesapları görünüm değişikliğinden bağımsızdır. Gerçek verinin bulunmadığı yere örnek metrik konulmaz; desteklenmeyen işlem için düğme çizilmez.
- Ürün adı **Ada ERP**'dir. `components/ui/Brand.tsx` mevcut raster A simgesini bundler import yoluyla kullanır; ERP wrapper ve panel aynı işareti kullanır. `mark` dar menü, `onDark` her zaman koyu yüzey içindir. Müşteri şirketinin fatura/çıktı logosu ürün markasından ayrı kalır.

## Belirteçler ve görsel hiyerarşi

| Rol | Açık tema | Koyu tema |
| --- | --- | --- |
| Sayfa `--bg` | `#f4f2f0` | `#131211` |
| Kart `--surface` | `#ffffff` | `#1a1919` |
| İkinci yüzey `--surface-2` | `#f4f2f0` | `#242322` |
| Çizgi `--border` / güçlü çizgi | `#e5e7eb` / `#d3d3d3` | `#2e2c2b` / `#3d3b3a` |
| Ana metin / sönük metin | `#0c0a08` / `#6d6c6b` | `#f4f2f0` / `#a3a19f` |
| Vurgu `--brand` / üstündeki metin | `#e4f222` / `#0c0a08` | Aynı |
| Koyu şerit / üstündeki metin | `#1a1919` / `#ffffff` | `#262524` / `#f4f2f0` |
| Odak `--focus` | `#0c0a08` | `#e4f222` |
| Başarı / uyarı / hata | `#2e6b3c` / `#8a5a12` / `#a3312b` | `#8fce9c` / `#e2b866` / `#ef8f86` |
| Bilgi `--info` | `#315d86` | `#a2c4e6` |

- Yerel **Inter Variable**, `ss01`; gövde 14px/1.5 ve ağırlık 400. Yardım, hata ve tablo ikincil bilgisi 12px; eylem/etiket 500, sayfa başlığı/toplam 600. `font-bold` de 600'e eşlenir; rutin gövdede ağır yazı kullanılmaz.
- Başlık ölçeği: 20px alt başlık, 24px küçük başlık, 28px sayfa başlığı, 40px sınırlı karşılama. 64px display token'ı bulunması ERP içerik ekranında büyük başlık kullanma gerekçesi değildir.
- Boşluk temeli 4px. Bölüm içinde 12–20px, ana bloklar arasında 24px civarında boşluk; geniş finans tablolarında gereksiz kart dolgusu azaltılır.
- Köşeler: düğme/rozet 6px, girdi 10px, küçük blok 12px, kart 16px. Kartlar ince çizgi ve yüzey tonuyla ayrılır; `shadow-card`/`shadow-pop` yoktur. Yoğun dekorasyon, gradient ve glassmorphism kullanılmaz.
- Kontroller masaüstünde en az 40px, 768px altında 44px yüksekliğindedir. Küçük masaüstü düğmesi 32px olabilir; mobilde küçük eylem de 44px hedefi alır. Uzun etiket kırpılmaz ve yüksekliği büyütebilir.
- Breakpoint'ler: 640/768/1024/1280px. Normal içerik en çok 1200px, form düzeni 960px, geniş tablo/rapor düzeni 1600px hedefler; POS görev düzeni mevcut işlevlerine göre geniş alan kullanır.
- Katman rolleri: sticky 10, gezinme 30, overlay 40, popover 50, toast 60, erişilebilirlik 70. İç içe onay, alttaki panelin üzerinde kalmalı; modal içindeki popup da kendi tıklama/odak bağlamında sınanmalıdır.
- Normal renk geçişi 180ms ease-out; kısa geçiş 120ms. `prefers-reduced-motion` tüm geçiş/animasyon sürelerini azaltır. Açık/koyu tema ilk boyamadan önce uygulanır; mevcut tema tercihi anahtarı korunur.

## Bileşen sözleşmeleri

| Desen | Kullanılacak bileşen ve davranış |
| --- | --- |
| Sayfa/kart başlığı | `PageHeader`, `CardHeader`; tek h1, görünür ana işlem, isteğe bağlı açıklama/rehber ve breadcrumb. Eylemler dar ekranda satıra bölünür. |
| Eylem | `Button` primary/secondary/ghost/danger; loading gerçek düğmeyi devre dışı bırakır ve `aria-busy` verir. `IconButton` görünür açıklama yerine erişilebilir `label` ister. Navigasyon için `Button asChild` içinde gerçek Link/anchor kullanılır; Link içine button yerleştirilmez. |
| Alan | `Field`; `children(id, metadata)` eski tek id callback'iyle uyumludur. Aynı id'li kontrolün hint/error bağlantısını otomatik kurar; mevcut `aria-invalid` değerini ezmez. `required` işaretine anlam veren gerçek iş doğrulaması ayrıca korunur. |
| Metin/tarih/seçim | `Input`, `Textarea`, `Select`, `DateInput`, `Combobox`; native değer/ref/onChange ve mevcut form entegrasyonları korunur. Büyük seçenek listelerinde Combobox kullanılır; popup portal/collision ile alan dışına kesilmez. |
| Parasal/sayısal alan | `MoneyInput`; dış değer kanonik ondalık string'dir. Geçersiz yazı alanda kalır; hatayı düzeltmeden geçerli finansal değer kabul edilmez. Hassasiyet yalnız görünüm refactor'u nedeniyle değiştirilmez. |
| Arama/filtre | `SearchInput`, `ListToolbar`; filtreler kayıt taslağı değildir. Sonuç yoksa filtre temizleme yolu gösterilir. `SavedViews` yalnız açıkça verilen filtre tercihlerini, kullanıcı/şirket/şube/sayfa kapsamıyla bu tarayıcıda saklar; arama metni, müşteri kayıtları ve kimlik bilgileri saklanmaz. |
| Liste sonuçları | `TableWrap`, `Table`, `Th`, `Td`, `Tr`, `ResultFooter`; para/sayı `num` ile sağa hizalanır. Mevcut total/limit/truncated/offset sözleşmesine göre gerçek sayı ve daha fazla/önceki-sonraki davranışı gösterilir. Server desteği olmayan sıralama veya bulk işlem eklenmez. |
| Form bölümü | `FormSection`; anlamlı başlık, kısa açıklama, gruplanmış kontroller. İleri seçenekler erişilebilir kalır; başlangıç alanlarını gölgelemez. |
| Sekme/seçici | `SegmentedTabs`; gerçek içerikte tabs + roving focus + ok/Home/End, filtrede `variant="filter"` + `aria-pressed`. İçerik ilişkisi gerektiğinde `panelId` ve `TabPanel` ile bağlanır. |
| Durum/özet | `Badge`, `Callout`, `Stat`; durum hem metin/simgeyle hem sınırlı renkle açıklanır. Sıfır, veri eksikliği, tahmin ve gerçek bakiye farklı anlamlardır. |
| Yüklenme/boş/hata | `PageLoading`, `ListSkeleton`, `FormSkeleton`, `EmptyState`, `ErrorState`; başlangıç yüklenmesi, API hatası, yetki hatası, gerçek boş liste ve filtre sonucu ayrıdır. Tekrar dene mevcut sorguyu yeniden çalıştırır. |
| Panel/onay | `Sheet`, `Modal`, `ConfirmDialog`; uzun form yan panel, kısa geri dönüşsüz işlem alertdialog. Onayda başlangıç odağı Vazgeç'e gelir; pending sırasında yinelenen işlem/kapatma engellenir, hata aynı bağlamda gösterilir. |
| Taslak | `UnsavedChangesProvider`, `useUnsavedForm`, `FormGuard`; anlamlı düzenlemeden sonra ayrılma, şirket/şube değişimi ve panel kapatma açık bırakma onayı ister. Başarı taslağı temizler; hata korur. `data-form-guard="off"` yalnız arama/filtre gibi iş taslağı olmayan alanlar içindir. |
| Bildirim | `Toast`; kısa tamamlanma bilgisi. Alan doğrulamasının ve kalıcı hata açıklamasının yerine geçmez. |

`QueryStateBoundary` veri dönmemiş aktif sorgu hatalarında ortak geri bildirim sağlar; 401/403 özel oturum/yetki davranışları korunur. Yeni veya düzenlenen ekran kendi ana sorgusu için açık loading/error/empty/content ayrımı yapmalıdır; opsiyonel yan sorgu hatası ana kaydın yok olduğu anlamına gelmez.

## Ekran düzeni ve finansal doğruluk

- Sol menü gerçek API'den yetkili/modülü açık öğeleri alır; görsel gruplama direct URL'leri değiştirmez. Açılabilen grup, dar menü, mobil dialog, klavye ve arama aynı menü kaynağını kullanır.
- Ana ERP içerikte tek dikey kaydırma `AppShell/main` içindedir. Sayfa listelerine ikinci dikey max-height kaydırması eklenmez; geniş tablo kendi yatay kaydırmasını korur. Modal/panel ve popup'un sınırlı kaydırması ayrı bağlamdır.
- İçerik, toolbar ve form grid'lerinde `min-w-0`; mobil arama tam satır, işlemler wrap. Toplam/tutar son hanesi kesilmez; ikincil sütunlar ancak mevcut detay yoluna erişim korunarak azaltılır.
- UUID yerine kararlı, okunabilir belge/kayıt kodu; ürün/depo/operasyon adı ve Türkçe durum. Aynı görünen kod listede, detayda ve aramada bulunur. Teknik UUIDv7 denetiminde de gizlilik/okunabilirlik korunur.
- Para `moneyIn`/`currencySymbol`/`CurrencyOptions` kaynağından gelir: `₺1.234,56`, `-₺1.234,56`; kur örneği `1 £ = ₺64,7268`. Selector value her zaman para birimi kodudur. Decimal/rounding, borç/alacak/bakiye/vergi/iskonto/tutar hesapları değiştirilmez.
- Taslak, onay bekleyen, kesinleşmiş, iptal ve gerçek entegrasyon gönderimi ayrı etiketlenir. PDF üretimi e-Fatura'nın resmen gönderildiği anlamına gelmez. Tahmin dayanağı ve eksik veri açıkça anlatılır.
- Baskı/çıktı kuralları uygulama girişlerinde korunur: antet şirket bilgisine aittir, mali sütun ve toplamlar bozulmaz. Baskı bağlamında kullanılan sabit renkler ekran rengi olarak çoğaltılmaz.

## Erişilebilirlik ve kabul

Etiket-kontrol, açıklama-hata ve tab-panel ilişkileri kurulmalıdır. Anlam yalnız renge bağlı olamaz. Odak görünür, ikonların erişilebilir adı mevcut, popup/dialog klavyeyle kullanılabilir ve kapanışta odak uygun tetikleyiciye döner. Para ve negatif değerler ekran okuyucuda anlaşılır olmalıdır.

Hedef WCAG AA metin kontrastı 4.5:1, kontrol/odak kontrastı 3:1'dir. Mevcut renklerin önceki ölçümü yeni birleşik ekranların kabulü yerine geçmez; yeni token çiftleri ve light/dark kombinasyonları tekrar kontrol edilir. Reduced motion ve 320px dar ekran kontrolü ayrıca yapılır.

Bir ekran yalnız derlendiği için tamamlanmış sayılmaz. Son değişikliklerde typecheck, lint, ilgili unit/regresyon testleri ve üretim build; ardından gerçek iş akışları, yetki profilleri, light/dark, 1440/1280/390px ve gerekli 320px görsel kontrolü yapılır. Sonuçlar gerçek çalıştırma ve ekran görüntüsü incelemesine dayanmalıdır.

Mevcut tarihsel kontroller `UI-AUDIT.md`, V2 route ve yapılmış/bekleyen kabul ayrımı `UI-V2-INVENTORY.md` içindedir. Yeni revizyonda tüm route'lar gözden geçirilmediyse geçmiş sonuçlar tekrar geçmiş olarak işaretlenmez.
