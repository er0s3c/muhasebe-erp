# Yol haritası

## Tamamlanan

| # | Kilometre taşı | İçerik |
|---|---|---|
| M0 | Temel | Monorepo, lint/tip denetimi, Vitest, Playwright, CI, dokümanlar |
| M1 | Kiracılık ve kimlik | Kayıt/giriş, şirket kurulumu, RBAC, RLS, denetim izi, uygulama kabuğu, i18n, sektöre göre menü |
| M2 | Ayarlar | Para birimi ve kur, KDV oranları (doğrulama alanlı), mali dönemler, özel kodlar, boşluksuz numaralama |
| M3 | Genel muhasebe | Hesap planı, yevmiye (taslak/kaydet/ters kayıt/dövizli), dönem kilidi, mizan, hesap ekstresi |

## MVP'ye kalan (Çekirdek ERP)

| # | Kilometre taşı | İçerik |
|---|---|---|
| M4 | Cari | Müşteri/tedarikçi kartı, ekstre, açık kalemler, yaşlandırma |
| M5 | Stok | Stok kartı, depo, hareketler, ağırlıklı ortalama maliyet, sayım |
| M6 | Fatura ve irsaliye | Satış/alış/gider/iade → stok + cari + yevmiyeye otomatik kayıt |
| M7 | Kasa ve banka | Tahsilat/ödeme, virman, döviz alım-satım, kur farkı kâr/zararı, eşleştirme |
| M8 | Raporlar ve aktarım | Rapor seti, xlsx/csv/PDF, Excel içe aktarma (cari, stok, açılış bakiyesi), yönetim ekranı: modül istisnaları |
| M9 | Sağlamlaştırma | Demo şirket, yedekleme ve geri yükleme notları, üretim derlemesi ve dağıtım hattı, yük ve güvenlik gözden geçirmesi |

## MVP sonrası

Her faz, ilgili yasal parametrelerin resmi kaynaktan doğrulanmasına bağlıdır (bkz. [LEGAL-NOTES.md](LEGAL-NOTES.md)).

- **Faz B: İnşaat.** Şantiye/proje maliyeti (iş kırılımı, bütçe ve gerçekleşen, tamamlanma maliyeti tahmini), gayrimenkul envanteri ve dövizli taksit planı, taşeron sözleşmeleri ve kümülatif hakediş (stopaj, teminat, malzeme mahsubu), altyapı fonları.
- **Faz C: Resmî uyum.** Yabancılara satış kotası ve süre motoru, e-Fatura entegrasyonu, KDV/stopaj/BSİV beyannameleri, kur otomatik çekme.
- **Faz D: İnsan kaynakları.** Personel, puantaj, bordro ve sosyal güvenlik çıktıları, yabancı işçi belge ve teminat takibi.
- **Faz E: Market ve perakende.** Hızlı satış (POS), barkod ve terazi, reyon/raf envanteri, gün sonu raporu.
- **Diğer:** çek/senet takas odası, banka teminat mektubu portföyü, 13 haftalık nakit projeksiyonu, çoklu şirket konsolidasyonu.

## Teknik borç ve iyileştirmeler

- Ana JS paketini `manualChunks` ile bölmek.
- Sunucu için üretim derlemesi.
- Özel rol tablosu (gerçek ihtiyaç doğunca).
- İngilizce çeviri dosyası.
