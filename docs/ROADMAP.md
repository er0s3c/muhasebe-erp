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

## Mali müşavir/hukuki teyit bekleyenler (teyit gelmeden başlanmaz)

| # | Kilometre taşı | İçerik |
|---|---|---|
| M7b | Kur değerlemesi ve avans mahsubu | Dönem sonu dövizli hesap/cari değerlemesi (gerçekleşmemiş kur farkı) ve sonradan avans mahsubu: yalnızca-defter-tutarı düzeltme satırı gerektirir; yasal kural doğrulanmadan yazılmaz |
| — | Yıl sonu kapanış ve devir | Gelir/gider hesaplarının kapanışı, bilanço hesaplarının devri, açılış kaydı; KKTC uygulaması doğrulanmadan yazılmaz |

## MVP sonrası

Her faz, ilgili yasal parametrelerin resmi kaynaktan doğrulanmasına bağlıdır (bkz. [LEGAL-NOTES.md](LEGAL-NOTES.md)).

- **Faz B: İnşaat.** Şantiye/proje maliyeti (iş kırılımı, bütçe ve gerçekleşen, tamamlanma maliyeti tahmini), gayrimenkul envanteri ve dövizli taksit planı, taşeron sözleşmeleri ve kümülatif hakediş (stopaj, teminat, malzeme mahsubu), altyapı fonları.
- **Faz C: Resmî uyum.** Yabancılara satış kotası ve süre motoru, e-Fatura entegrasyonu, KDV/stopaj/BSİV beyannameleri, kur otomatik çekme.
- **Faz D: İnsan kaynakları.** Personel, puantaj, bordro ve sosyal güvenlik çıktıları, yabancı işçi belge ve teminat takibi.
- **Faz E: Market ve perakende.** Hızlı satış (POS), barkod ve terazi, reyon/raf envanteri, gün sonu raporu.
- **Diğer:** çek/senet takas odası, banka teminat mektubu portföyü, 13 haftalık nakit projeksiyonu, çoklu şirket konsolidasyonu.

## Teknik borç ve iyileştirmeler

- Ana JS paketini bölmek (Vite 8/Rolldown `advancedChunks`).
- Oran sınırı için paylaşılan depo (çok örnekli barındırma; lisans sunucusunun oran sınırı da bellek içidir), uygulama kullanıcıları için MFA/TOTP, akışlı xlsx yazımı.
- Lisans: modül bazlı (eklenti) lisans alanı (`features`), ödeme/fatura entegrasyonu, lisans sunucusu yönetici çoklu-rol modeli, barındırmalı (kiracı başına lisans) kip.
- İmajın kayıt defterine yayını ve sürüm/sürüm notu akışı; Caddy TLS profilinin otomatik sınanması.
- Özel rol tablosu (gerçek ihtiyaç doğunca).
- İngilizce çeviri dosyası.
