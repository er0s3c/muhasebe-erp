# Kapsam ve işlev kontrol listesi

Bu liste, KKTC'deki işletmelerin bir muhasebe yazılımından **hangi işlevleri beklediğini** özetler. Mevcut yazılımların menülerine bakılarak beklentiler çıkarılmış, ancak işlevler burada **kendi alan adlandırmamızla ve kendi cümlelerimizle** yazılmıştır; hiçbir üçüncü taraf menü yapısı, ekran düzeni veya başlık listesi kopyalanmamıştır (bkz. [LEGAL-NOTES.md](LEGAL-NOTES.md)).

Durum: ✅ var · 🔜 yol haritasında (kilometre taşı) · ⏳ MVP sonrası · ⚠️ yasal doğrulama bekliyor

## Genel

| İşlev | Durum |
|---|---|
| Çok şirketli çalışma, şirketler arası veri yalıtımı | ✅ |
| Kullanıcılar, roller, yetki; denetim izi | ✅ |
| Sektöre göre menü ve modül açma/kapama | ✅ |
| Genel bakış: kurulum kontrol listesi, özetler | ✅ |
| Rehber: kişi/kurum defteri, ajanda, görüşme ve toplantı notları | ⏳ |
| Özel kodlar (kayıtları kendi ölçütünle grupla) | ✅ |
| Çalışma alanı ve şirket ayarları (unvan, vergi bilgileri) | ✅ |

## Muhasebe

| İşlev | Durum |
|---|---|
| Hesap planı (şablon, alt hesap açma, pasifleştirme) | ✅ ⚠️ şablon doğrulanmadı |
| Yevmiye kaydı: taslak, kaydet, ters kayıt, dövizli satır | ✅ |
| Mizan (dönem aralığı, gruplu/hesap düzeyi, defter ve raporlama para birimi, CSV) | ✅ |
| Hesap ekstresi (yürüyen bakiye, alt hesaplar dahil) | ✅ |
| Mali dönemler, dönem kapatma/açma | ✅ |
| Kebir, yevmiye defteri baskısı | 🔜 M8 |
| Yıl sonu kapanış ve devir | 🔜 M8/M9 |
| Kur farkı kâr/zarar kayıtları | 🔜 M7 |

## Cari (müşteri ve tedarikçi)

| İşlev | Durum |
|---|---|
| Cari kart (kimlik, vergi, iletişim, para birimi, kredi limiti, vade) — müşteri/tedarikçi/her ikisi | ✅ |
| Cari ekstre (yürüyen bakiye, para birimi bazında bakiye), vadeye göre yaşlandırma, açık kalemler (FIFO) | ✅ |
| Cari kontrol hesabı kuralı: 120/320 satırlarında cari zorunlu, diğer hesaplarda yasak (uygulama + veritabanı) | ✅ |
| Tahsilat/ödeme kaydı yevmiye ile girilebilir; fatura ile **elle eşleştirme**, kur farkı | 🔜 M7 |
| Fazla ödeme/avans yaşlandırmada ayrı gösterilir | ✅ |
| Borç/alacak dekontu (mahsup) yevmiye ile; devir işlemleri | 🔜 M8/M9 |
| Cari özel fiyat/iskonto | ⏳ |
| Personel cari ve avans takibi | ⏳ (bordro ile) |

## Stok

| İşlev | Durum |
|---|---|
| Stok kartı (birim, kategori, barkod, KDV, kritik seviye, alış/satış fiyatı ayrı para biriminde) | ✅ |
| Depolar, giriş/çıkış/transfer/devir hareketleri; ters belge | ✅ |
| Sarf, fire, sayım ve sayım farkı | ✅ |
| Hareketli ağırlıklı ortalama maliyet, dövizli alış maliyeti, negatif stok ayarı, stok değerleme | ✅ |
| Stok değeri ↔ muhasebe (150–157) mutabakatı; stok hareketinden otomatik yevmiye | ✅ |
| Stok durumu (tarih anı), kart ekstresi, kritik seviye | ✅ |
| Stok kâr/zarar ve diğer rapor seti | 🔜 M8 |
| Seri no takibi, emanet stok, barkod yazdırma | ⏳ |
| Fiyat listeleri, kampanya | ⏳ |

## Fatura ve irsaliye

| İşlev | Durum |
|---|---|
| Satış, alış ve gider faturası; satış ve alış iadesi (orijinal faturaya bağlı, kalan miktar denetimli) | ✅ |
| Faturadan stok, cari ve yevmiye kaydının otomatik oluşması; iptal (ters kayıt) | ✅ |
| Hesap eşlemesi (gelir, maliyet, stok, KDV, gider, fire, sarf hesapları) | ✅ ⚠️ varsayılanlar doğrulanmadı |
| KDV hariç/dahil fiyat, iskonto, dövizli fatura, KDV özeti | ✅ ⚠️ oranlar doğrulanmadı |
| Elle girilen stok belgelerinin ve sayımın otomatik yevmiyesi | ✅ |
| Faturanın yazdırılabilir görünümü (iç belge) | ✅ ⚠️ yasal fatura biçimi doğrulanmadı |
| İrsaliye ve faturaya dönüştürme; toplu fatura | 🔜 M6b |
| Excel ile fatura/irsaliye içe aktarma | 🔜 M8 |
| Gider kartları ve gider raporları | ⏳ |
| İthalat maliyet dağıtımı (navlun, gümrük, liman) | ⏳ Faz B |
| e-Fatura entegrasyonu | ⏳ Faz C ⚠️ |

## Kasa ve banka

| İşlev | Durum |
|---|---|
| Kasa ve banka hesapları, çoklu para birimi | 🔜 M7 |
| Tahsilat/ödeme, virman, döviz alım-satım | 🔜 M7 |
| Banka ekstresi içe aktarma ve eşleştirme | 🔜 M7/M8 |
| Çek/senet portföyü ve takas | ⏳ |
| Banka teminat mektupları | ⏳ Faz B |

## Kur ve vergi

| İşlev | Durum |
|---|---|
| Elle kur girişi (alış/satış), tarihe göre arama, üçgenleme | ✅ |
| Kurdan eksik raporlama tutarlarını sonradan doldurma | ✅ |
| Merkez Bankası kurlarını resmî adresten getir veya XML dosyası yükle (elle tetiklenir) | ✅ ⚠️ kullanım şartı doğrulanmadı |
| Kurların zamanlanmış otomatik çekimi | ⏳ ⚠️ |
| Tarih aralıklı KDV oranları, doğrulama işareti | ✅ ⚠️ oranlar doğrulanmadı |
| KDV/stopaj/BSİV beyannameleri | ⏳ Faz C ⚠️ |

## Sektör paketleri

| İşlev | Durum |
|---|---|
| **İnşaat:** şantiye/proje maliyeti, bütçe ve gerçekleşen | ⏳ Faz B |
| **İnşaat:** gayrimenkul envanteri, dövizli taksit planı, tahsilat mahsubu | ⏳ Faz B |
| **İnşaat:** taşeron sözleşmesi, kümülatif hakediş, teminat kesintisi | ⏳ Faz B |
| **İnşaat:** yabancılara satış kotaları ve yasal süre takibi | ⏳ Faz C ⚠️ |
| **İnşaat:** altyapı fonları (elektrik/belediye) | ⏳ Faz B ⚠️ |
| **İnşaat:** yabancı işçi belge/teminat takibi, bordro | ⏳ Faz D ⚠️ |
| **İnşaat:** müteahhitlik sınıf karnesi ve kapasite kontrolü | ⏳ Faz C ⚠️ |
| **Market:** hızlı satış (POS), barkod, gün sonu | ⏳ Faz E |
| **Market:** terazi entegrasyonu, reyon/raf envanteri | ⏳ Faz E |
| Şirket evrakları: yıllık kurul raporu, resmî yazışma arşivi | ⏳ ⚠️ |

## Yönetim raporları

| İşlev | Durum |
|---|---|
| 13 haftalık nakit projeksiyonu | ⏳ |
| Döviz pozisyon raporu | ⏳ |
| Proje kârlılığı, sapma analizi | ⏳ Faz B |
| Yönetici özet raporu | ⏳ |

## Veri güvencesi

| İşlev | Durum |
|---|---|
| Her işlemin kullanıcı/zaman/IP ile kaydı | ✅ |
| Excel/CSV ile cari, stok, açılış bakiyesi aktarımı | 🔜 M8 |
| Müşterinin verisini eksiksiz dışa aktarabilmesi | 🔜 M8 |
