# Yol haritası

## Tamamlanan

| # | Kilometre taşı | İçerik |
|---|---|---|
| M0 | Temel | Monorepo, lint/tip denetimi, Vitest, Playwright, CI, dokümanlar |
| M1 | Kiracılık ve kimlik | Kayıt/giriş, şirket kurulumu, RBAC, RLS, denetim izi, uygulama kabuğu, i18n, sektöre göre menü |
| M2 | Ayarlar | Para birimi ve kur, KDV oranları (doğrulama alanlı), mali dönemler, özel kodlar, boşluksuz numaralama |
| M3 | Genel muhasebe | Hesap planı, yevmiye (taslak/kaydet/ters kayıt/dövizli), dönem kilidi, mizan, hesap ekstresi |
| M4 | Cari | Müşteri/tedarikçi kartı, cari kontrol hesabı kuralı, ekstre, vadeye göre yaşlandırma, açık kalemler (FIFO); Merkez Bankası XML kur içe aktarma; Türkçe sıralama/arama |
| M5 | Stok | Stok kartı (mal/hizmet, çok para birimli fiyat, kritik seviye), çoklu depo, giriş/çıkış/fire/transfer/devir, ters belge, sayım, hareketli ağırlıklı ortalama maliyet, negatif stok ayarı, stok durumu/değerleme ve muhasebe mutabakatı |
| M6 | Fatura | Satış/alış/gider/satış iadesi/alış iadesi faturası → stok + cari + yevmiye tek işlemde; boşluksuz numara, iptal (ters kayıt), KDV hariç/dahil, iskonto, dövizli fatura, KDV özeti; **hesap eşlemesi** ve elle girilen stok belgelerinin/sayımın otomatik yevmiyesi; `cost_adjust` → 621; yazdırılabilir iç belge görünümü |
| M6b | İrsaliye | Satış (sevk) ve alış (mal kabul) irsaliyesi → stok defteri (yevmiye fatura kesilince); faturanın irsaliyeye bağlanması (tekrar stok hareketi yok, kısmi ve çoklu faturalama, kilit altında kalan miktar), alışta fiyat farkı (elde kalan → stok maliyeti, satılan → 621), **faturalanmamış irsaliye** listesi/özeti ve stok mutabakatında açıklanan fark; iade irsaliyesi ve sipariş/teklif sonraya |
| M7 | Kasa ve banka | Kasa/banka hesapları (muhasebe hesabına bağlı, çoklu para birimi), tahsilat/ödeme (kalem eşleştirmeli: kısmi, çoklu kalem, farklı para birimi, avans), **gerçekleşen kur farkı** (646/656), virman, döviz alım-satım (ortalama maliyet), diğer tahsilat/ödeme, iptal (ters kayıt), kasa eksi bakiye denetimi; açık kalem motoru eşleştirme ve ters çift nötrlüğü kazandı |
| M8a | Raporlar ve dışa aktarma | Tüm raporlarda Excel/CSV/baskı (PDF olarak kaydet); yevmiye defteri, kebir, satış/alış raporu, stok kârlılığı, kambiyo raporu, tam veri dışa aktarma (`data.export`); kendi xlsx yazıcı/okuyucumuz (`fflate`) |
| M8b | İçe aktarma | Excel/CSV sihirbazı (sütun eşleme, ön izleme, atomik yazma): cari kartları, stok kartları, cari açılış bakiyeleri, stok açılışı, genel mizan açılışı; Açılış bakiyeleri sayfası |
| M8c | Banka ekstresi | Ekstre içe aktarma (genel sütun eşleme, tekrar dosya/satır koruması), defter satırlarıyla eşleştirme (kesin/olası öneri, ±3 gün), eşleşmeyen satırdan hareket oluşturma, mutabakat farkı, ERP06 koruma tetikleyicileri |
| M9a | Çalışma zamanı ve dağıtım | CI onarıldı (e2e üretim paketine karşı); yapılandırma/başlangıç korumaları, sağlık uçları, üretim derlemesi (esbuild), statik sunum, Docker imajı, compose (+Caddy TLS), dependabot |
| M9b | Güvenlik | Yetki yükseltme kapatıldı; atomik refresh; oran sınırları; `audit_log` sahibe karşı salt-eklenir; rota–izin ve RLS sözleşme testleri; parola sıfırlama, e-posta doğrulama, geçici parola, parola politikası, güvenlik olayları; yük ölçümü ve düzeltmeleri (kilitlenme, yevmiye listesi, dışa aktarma kapısı, dizinler) |
| M9c | Modül istisnaları | Ayarlar > Modüller: bağımlılık korumalı kapatma/açma (`requires`/`locked`), panel ve bağlantı kapıları |
| M9d | Demo, yedek, operasyon | Demo aracı + ayrı demo örneği, yedek/geri yükleme betikleri ve CI'da geri yükleme tatbikatı, operatör parola kurtarma, `OPERATIONS.md`, üçüncü taraf lisans bildirimi |
| L1–L5 | Lisanslama | Ed25519 imzalı kiralı lisans (sektör, cihaz kotası, şirket sınırı, bitiş), satıcı **lisans sunucusu** (`apps/license-server`: etkinleştirme, kalp atışı, çevrimdışı etkinleştirme, klon şüphesi) ve **yönetim paneli** (`apps/license-admin`, parola + zorunlu TOTP) + CLI; uygulama tarafı durum makinesi (etkin/tolerans/salt-okunur), dağınık bağımsız kapılar, **cihaz koltukları**, etkinleştirme/lisans/cihaz ekranları; `LICENSING.md` |
| B4 | Fonlar, kârlılık, nakit | Altyapı fonu/harç tarifeleri (tarihli, kaynak notlu, doğrulama alanlı; alıcı ve proje tarafı), satış sözleşmesine fon satırı (bedele sayılmaz, 329), fesihte fon iadesi, projenin fon tahmini + "Fon ve harç" maliyet kodu; **proje kârlılığı** (sözleşmeli gelir − EAC, tanınmış gelir/maliyet; defter ve GBP raporlama); **13 haftalık nakit projeksiyonu** (açık alacak/borç vadeleri + elle kalemler, haftalık kapanış); Excel çıktıları |
| B3 | Gayrimenkul satışı | `construction.realestate` modülü: birim envanteri (toplu üretim, kat planı), satış sözleşmesi + dövizli taksit planı (peşinat/eşit taksit/elle düzenleme), etkinleşmede taksit başına vadeli 120 + ertelenmiş gelir 380, tahsilat mahsubu ve kur farkı mevcut kasa/banka akışıyla, teslimde 380 → 600 (proje etiketli), teslim öncesi fesih + kesinti + iade (kasasız kalem kapatma), taksit/geciken listesi, proje satış özeti; ERP12 korumaları |
| B2p | Satın alma zinciri | `construction.procurement` modülü: satın alma talebi + `purchase_request` onay türü, RFQ ve teklif karşılaştırma (kurla defter para birimine, en ucuz/en hızlı), sipariş (verilince iş kalemine taahhüt, KDV oranı donar), mal kabul (alış irsaliyesi ile stoğa giriş, kısmi teslim), proje maliyet raporunda sipariş taahhüdü; ERP11 koruma tetikleyicileri |
| B2e | İşveren hakedişi | `direction` boyutu (payable/receivable) ile taşeron altyapısının ayna kullanımı: işveren sözleşmesi (contract projesi + işveren cari, projede tek), revizyonlu BOQ, kümülatif **alınan hakediş** (B 120 / A 600 + 391; teminat 126, avans 340, stopaj 193), `employer_claim` onay türü, avans alma, teminat iadesi (B 120 / A 126), tahsilat mevcut kasa/banka akışıyla, proje işveren özeti; yönlü ERP10 korumaları |
| B2 | Taşeron ve hakediş | Maliyet kodu boyutu (`cost_codes`, `journal_lines.cost_code_id`); tarihli inşaat parametreleri (teminat/stopaj/avans %, doğrulama alanlı); **genel onay motoru** (belge türü + proje + tutar aralığı → sıralı rol/kullanıcı adımları, kararlar değişmez); taşeron sözleşmesi + revizyonlu BOQ; kümülatif hakediş (kesintiler, onay → yevmiye), iptal (ters kayıt), avans, teminat iadesi; maliyet raporunda kalan taahhüt ve maliyet koduna göre kırılım; sözleşme/hakediş dışa aktarmaları; ERP10 koruma tetikleyicileri |
| B1 | Şantiye projeleri | Proje (kendi / işverene yapılan iş), iş kırılımı (WBS), revizyonlu değişmez bütçe, tarihli ilerleme; gerçekleşen maliyet defterden türer (yevmiye, fatura kalemi, stok sarfı, kasa/banka ödemesi → proje + iş kalemi etiketi); tamamlanma %, tahmini toplam maliyet (EAC), sapma, CPI; projesiz maliyet mutabakatı; Excel/CSV/baskı; ERP09 koruma tetikleyicileri |

## Mali müşavir/hukuki teyit bekleyenler (teyit gelmeden başlanmaz)

| # | Kilometre taşı | İçerik |
|---|---|---|
| M7b | Kur değerlemesi ve avans mahsubu | Dönem sonu dövizli hesap/cari değerlemesi (gerçekleşmemiş kur farkı) ve sonradan avans mahsubu: yalnızca-defter-tutarı düzeltme satırı gerektirir; yasal kural doğrulanmadan yazılmaz |
| — | Yıl sonu kapanış ve devir | Gelir/gider hesaplarının kapanışı, bilanço hesaplarının devri, açılış kaydı; KKTC uygulaması doğrulanmadan yazılmaz |

## MVP sonrası

Her faz, ilgili yasal parametrelerin resmi kaynaktan doğrulanmasına bağlıdır (bkz. [LEGAL-NOTES.md](LEGAL-NOTES.md)).

- **Faz B: İnşaat.** **B1 (şantiye projesi, bütçe, gerçekleşen, tahmin), B2 (taşeron sözleşmesi, BOQ, verilen hakediş, onay motoru, taahhüt), B2e (işveren hakedişi), B2p (satın alma zinciri), B3 (gayrimenkul satışı) ve B4 (fonlar, kârlılık, nakit) tamamlandı.** Kalan alt fazlar (her biri ayrı plan ve onayla):
  - **Variation order** sözleşme revizyonuna bağlanır; malzeme mahsubu, KDV tevkifatı ve faturanın siparişe bağlanması (3'lü eşleştirme).
- **Ön koşul: mevzuat motoru.** `tax_rates` deseninin genel `legal_parameters` tablosuna genişletilmesi (kategori, kaynak adresi, doğrulama durumu, `supersedes_id`); KDV'nin vergi kategorisine bağlanması ([LEGAL-NOTES.md](LEGAL-NOTES.md) §3 “Hedef model”). B2–B4 tarihli parametre tablolarıyla (`construction_params`, `fee_schedules`, `tax_rates`) uygulandı; C ve D bunun üstüne kurulur.
- **Faz C: Resmî uyum.** e-Fatura entegrasyonu (resmî REST API v1.2.3, UBL 2.1, UUIDv7; iç faturadan ayrı gönderim durumu, LEGAL-NOTES §7; mükellef yetkilendirmesi ve test erişimi gerekir); yabancılara satış sınırı ve süre motoru (89/2026 YGK ve sonrası; pul, tapu harcı, alım izni ve sözleşme kayıt süreleri ayrı parametre aileleri); KDV/stopaj/BSİV beyannameleri; kur otomatik çekme (yeniden yayın şartı teyit edilince, sabit saate bağlanmadan).
- **Faz D: İnsan kaynakları.** Personel, puantaj, bordro ve sosyal güvenlik çıktıları (bordro tipi, ör. D3, + tarihli temel oranlar + ayrı ve tarihli prim desteği kuralı), yabancı işçi belge ve teminat takibi (250 € teminat tarihli parametre olarak). Bordro verisi için kişisel veri modülü (LEGAL-NOTES §5) önce gelir.
- **Faz E: Market ve perakende.** Hızlı satış (POS), barkod ve terazi, reyon/raf envanteri, gün sonu raporu.
- **Diğer:** çek/senet takas odası, banka teminat mektubu portföyü, çoklu şirket konsolidasyonu, döviz pozisyon raporu, yönetici özet raporu.

## Teknik borç ve iyileştirmeler

- Ana JS paketini bölmek (Vite 8/Rolldown `advancedChunks`).
- Oran sınırı için paylaşılan depo (çok örnekli barındırma; lisans sunucusunun oran sınırı da bellek içidir), uygulama kullanıcıları için MFA/TOTP, akışlı xlsx yazımı.
- Lisans: modül bazlı (eklenti) lisans alanı (`features`), ödeme/fatura entegrasyonu, lisans sunucusu yönetici çoklu-rol modeli, barındırmalı (kiracı başına lisans) kip.
- İmajın kayıt defterine yayını ve sürüm/sürüm notu akışı; Caddy TLS profilinin otomatik sınanması.
- Özel rol tablosu (gerçek ihtiyaç doğunca).
- İngilizce çeviri dosyası.
