# Kapsam ve işlev kontrol listesi

Bu liste, KKTC'deki işletmelerin bir muhasebe yazılımından **hangi işlevleri beklediğini** özetler. Mevcut yazılımların menülerine bakılarak beklentiler çıkarılmış, ancak işlevler burada **kendi alan adlandırmamızla ve kendi cümlelerimizle** yazılmıştır; hiçbir üçüncü taraf menü yapısı, ekran düzeni veya başlık listesi kopyalanmamıştır (bkz. [LEGAL-NOTES.md](LEGAL-NOTES.md)).

Durum: ✅ var · 🔜 yol haritasında (kilometre taşı) · ⏳ MVP sonrası · ⚠️ yasal doğrulama bekliyor

## Genel

| İşlev | Durum |
|---|---|
| Çok şirketli çalışma, şirketler arası veri yalıtımı | ✅ |
| Kullanıcılar, roller, yetki; denetim izi | ✅ |
| Sektöre göre menü ve modül açma/kapama (Ayarlar > Modüller: bağımlılık korumalı, veri silinmez) | ✅ |
| Genel bakış: kurulum kontrol listesi, özetler | ✅ |
| Rehber: kişi/kurum defteri, ajanda, görüşme ve toplantı notları | ⏳ |
| Özel kodlar (kayıtları kendi ölçütünle grupla) | ✅ |
| Çalışma alanı ve şirket ayarları (unvan, vergi bilgileri) | ✅ |

## Muhasebe

| İşlev | Durum |
|---|---|
| Hesap planı (şablon, alt hesap açma, pasifleştirme) | ✅ ⚠️ şablon doğrulanmadı |
| Yevmiye kaydı: taslak, kaydet, ters kayıt, dövizli satır | ✅ |
| Mizan (dönem aralığı, gruplu/hesap düzeyi, defter ve raporlama para birimi; Excel/CSV/baskı) | ✅ |
| Hesap ekstresi (yürüyen bakiye, alt hesaplar dahil) | ✅ |
| Mali dönemler, dönem kapatma/açma | ✅ |
| Kebir ve yevmiye defteri (ekran, Excel/CSV, baskı) | ✅ ⚠️ iç belge, yasal onaylı defter yerine geçmez |
| Yıl sonu kapanış ve devir | ⏳ ⚠️ mali müşavir teyidine bağlı (M9 kapsamında değil) |
| Gerçekleşen kur farkı kâr/zarar kayıtları (tahsilat, ödeme, döviz satışı) | ✅ |
| Dönem sonu kur değerlemesi (gerçekleşmemiş kur farkı) | 🔜 M7b ⚠️ |

## Cari (müşteri ve tedarikçi)

| İşlev | Durum |
|---|---|
| Cari kart (kimlik, vergi, iletişim, para birimi, kredi limiti, vade) — müşteri/tedarikçi/her ikisi | ✅ |
| Cari ekstre (yürüyen bakiye, para birimi bazında bakiye), vadeye göre yaşlandırma, açık kalemler (FIFO) | ✅ |
| Cari kontrol hesabı kuralı: 120/320 satırlarında cari zorunlu, diğer hesaplarda yasak (uygulama + veritabanı) | ✅ |
| Tahsilat/ödeme fatura kalemiyle **elle eşleştirilerek** girilir (kısmi, çoklu kalem, farklı para birimi, avans); kur farkı otomatik | ✅ |
| Sonradan avans mahsubu (avansı sonraki faturaya elle bağlama) | 🔜 M7b |
| Fazla ödeme/avans yaşlandırmada ayrı gösterilir | ✅ |
| Borç/alacak dekontu (mahsup) elle yevmiye ile | ✅ |
| Devir işlemleri (yıl sonu ile birlikte) | ⏳ ⚠️ |
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
| Stok kâr/zarar, satış ve alış raporu (cari/stok kartı/ay/fatura kırılımı), kambiyo raporu; hepsinde Excel/CSV/baskı | ✅ |
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
| Satış (sevk) ve alış (mal kabul) irsaliyesi; stok hemen hareket eder, yevmiye faturada oluşur | ✅ ⚠️ yasal irsaliye biçimi doğrulanmadı |
| Faturanın irsaliyeye bağlanması: kısmi ve çoklu faturalama, tekrar stok hareketi yok, alışta fiyat farkı düzeltmesi | ✅ |
| Faturalanmamış irsaliye listesi, özeti ve stok mutabakatında açıklanan fark | ✅ |
| İade irsaliyesi, sipariş/teklif, toplu faturalama sihirbazı | ⏳ |
| Excel ile fatura/irsaliye içe aktarma | ⏳ |
| Gider kartları ve gider raporları | ⏳ |
| İthalat maliyet dağıtımı (navlun, gümrük, liman) | ⏳ Faz B |
| e-Fatura entegrasyonu | ⏳ Faz C ⚠️ |

## Kasa ve banka

| İşlev | Durum |
|---|---|
| Kasa ve banka hesapları, çoklu para birimi, hesap ekstresi (hesap + defter para birimi bakiyesi) | ✅ |
| Tahsilat/ödeme (fatura eşleştirmeli), virman, döviz alım-satım (ortalama maliyet), diğer tahsilat/ödeme (masraf, faiz), iptal (ters kayıt) | ✅ |
| Kasa eksi bakiyeye düşmez (banka düşebilir) | ✅ ⚠️ kural doğrulanmadı |
| Banka ekstresi içe aktarma (genel sütun eşleme), defter kayıtlarıyla eşleştirme (kesin/olası öneri, elle, otomatik), eşleşmeyen satırdan hareket oluşturma, mutabakat farkı | ✅ ⚠️ bankaya özgü biçimler doğrulanmadı |
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
| Excel/CSV ile cari ve stok kartı aktarımı (sütun eşleme, ön izleme, atomik) | ✅ |
| Excel/CSV ile cari açılış bakiyesi, stok açılışı ve mizan açılışı aktarımı | ✅ ⚠️ açılış karşı hesabı doğrulanmadı |
| Müşterinin verisini eksiksiz dışa aktarabilmesi (tüm tablolar tek Excel dosyasında) | ✅ |
| Yedekleme ve geri yükleme betikleri, geri yükleme tatbikatı (CI'da) | ✅ ⚠️ saklama süresi doğrulanmadı |
| Parola sıfırlama, e-posta doğrulama (SMTP ile), geçici parola, operatör parola kurtarma | ✅ |
| Güvenlik olayı kaydı (giriş, sıfırlama, yetki değişikliği) | ✅ |
| Docker imajı, compose dağıtımı, ayrı demo örneği, üçüncü taraf lisans bildirimi | ✅ |
| Lisanslama: sektör/cihaz/şirket sınırlı, imzalı kiralı lisans; satıcı lisans sunucusu ve web paneli (parola + zorunlu TOTP); salt-okunur mod | ✅ ⚠️ EULA/sözleşme ve veri işleme doğrulanmadı |
| Cihaz koltukları (kayıtlı tarayıcı/bilgisayar, yönetici kaldırır, boşta cihaz düşer) | ✅ |
| Uygulama kullanıcıları için iki adımlı doğrulama (TOTP/MFA) | ⏳ |
| Kişisel veri silme/dışa aktarma talebi süreci | ⏳ ⚠️ |
