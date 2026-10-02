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
| Personel cari ve avans takibi | ⏳ (X5; bordro D3'te kesinti kalemi olarak elle girilir) |

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
| İade irsaliyesi (satış/alış, orijinale bağlı miktar sınırı, iade faturasına bağlanır), satış teklifi ve siparişi (durum geçişleri veritabanında, teslim/fatura türetilir, irsaliye ve faturaya dönüşüm, yazdırma), toplu faturalama (önizleme, cari/irsaliye başına, kısmi hata raporu, çift faturalama koruması) | ✅ (X2) ⚠️ **sipariş/teklif çıktısı ve iade/toplu fatura mevzuat biçimi doğrulanmadı; cari özel fiyat X3** |
| Excel ile fatura içe aktarma (taslak, cari/stok eşleme, mükerrer denetimi, şablon) | ✅ (X2) irsaliye içe aktarma ⏳ |
| Gider kartları ve gider raporları | ⏳ |
| İthalat maliyet dağıtımı (navlun, gümrük, liman) | ⏳ Faz B |
| e-Fatura entegrasyonu (resmî REST API v1.2.3; iç faturadan ayrı gönderim durumu) | ⏳ Faz C ⚠️ yetkilendirme/test erişimi gerekir |

## Kasa ve banka

| İşlev | Durum |
|---|---|
| Kasa ve banka hesapları, çoklu para birimi, hesap ekstresi (hesap + defter para birimi bakiyesi) | ✅ |
| Tahsilat/ödeme (fatura eşleştirmeli), virman, döviz alım-satım (ortalama maliyet), diğer tahsilat/ödeme (masraf, faiz), iptal (ters kayıt) | ✅ |
| Kasa eksi bakiyeye düşmez (banka düşebilir) | ✅ ⚠️ kural doğrulanmadı |
| Banka ekstresi içe aktarma (genel sütun eşleme), defter kayıtlarıyla eşleştirme (kesin/olası öneri, elle, otomatik), eşleşmeyen satırdan hareket oluşturma, mutabakat farkı | ✅ ⚠️ bankaya özgü biçimler doğrulanmadı |
| Çek/senet portföyü ve takas: alınan/verilen çek ve senet, durum geçişleri (portföy/tahsil/ciro/karşılıksız/iade; verilen: ödeme/karşılıksız/iptal) veritabanında korunur ve salt-eklenir geçmişle izlenir, her değişiklik yevmiye yazar, cari kalemi kapatma/yeniden açma, toplu takas (tek yevmiye, tek banka satırı), vade analizi, vadesi gelenler, karşılıksız listesi, nakit projeksiyonu, xlsx/csv | ✅ (X1) ⚠️ **hesap eşlemeleri (101/121/108/103/321) ve çek/senedin yasal geçerliliği doğrulanmadı; yalnızca defter para birimi; reeskont, kısmi tahsil, protesto yok** |
| Banka teminat mektupları: verilen/alınan, proje ve sözleşme bağlantısı, kullanıcı girişli komisyon (kodda oran yok), kullanıcı ayarlı süre uyarısı, iade/nakde çevrildi/süresi doldu, banka ve projeye göre rapor, xlsx/csv | ✅ (X1) ⚠️ **nazım takip: yevmiye/komisyon gideri yazmaz; süre, tutar ve komisyon doğrulanmadı** |

## Kur ve vergi

| İşlev | Durum |
|---|---|
| Elle kur girişi (alış/satış), tarihe göre arama, üçgenleme | ✅ |
| Kurdan eksik raporlama tutarlarını sonradan doldurma | ✅ |
| Merkez Bankası kurlarını resmî adresten getir veya XML dosyası yükle (elle tetiklenir) | ✅ ⚠️ kullanım şartı doğrulanmadı |
| Kurların zamanlanmış otomatik çekimi | ⏳ ⚠️ |
| Tarih aralıklı KDV oranları (%0/5/10/16/20 tohumu), doğrulama işareti | ✅ ⚠️ oranlar doğrulanmadı; vergi kategorisi modeli ⏳ |
| KDV/stopaj/BSİV beyannameleri | ⏳ Faz C ⚠️ |

## Sektör paketleri

| İşlev | Durum |
|---|---|
| **İnşaat:** proje, iş kırılımı (WBS, en çok 6 seviye), bütçe revizyonları (değişmez, yürürlükteki revizyon) | ✅ (B1) |
| **İnşaat:** gerçekleşen maliyet (yevmiye, fatura kalemi, stok sarfı, kasa/banka ödemesi proje + iş kalemine etiketli), tamamlanma %, tahmini toplam maliyet (EAC), sapma ve CPI, projesiz maliyet mutabakatı | ✅ (B1) ⚠️ hesap sınıflandırması doğrulanmadı |
| **İnşaat:** işverene yapılan iş (`contract` proje, işveren cari) | ✅ (B1; hakediş B2) |
| **İnşaat:** gayrimenkul envanteri, satış sözleşmesi, dövizli taksit planı, tahsilat mahsubu, teslimde gelir tanıma, fesih ve iade | ✅ (B3) ⚠️ gelir tanıma yöntemi, hesap kodları (380/600/679), KDV ve tapu harcı doğrulanmadı |
| **İnşaat:** taşeron sözleşmesi, revizyonlu BOQ, kümülatif hakediş (verilen), teminat/avans/stopaj/diğer kesinti, onay kuralları, avans ve teminat iadesi, maliyet kodu, kalan taahhüt | ✅ (B2) ⚠️ yüzdeler ve yevmiye hesapları doğrulanmadı |
| **İnşaat:** işveren sözleşmesi, revizyonlu BOQ, alınan hakediş (kümülatif), teminat/avans/stopaj, tahsilat, işveren özeti | ✅ (B2e) ⚠️ hesap kodları ve gelir tanıma doğrulanmadı |
| **İnşaat:** satın alma talebi, onay, RFQ/teklif karşılaştırma, sipariş (taahhüt), mal kabul (stoğa giriş) | ✅ (B2p) ⚠️ hesap kodu eklenmedi: mal kabul mevcut alış irsaliyesi muhasebesini kullanır |
| **İnşaat:** faturanın siparişe bağlanması (3'lü eşleştirme: sipariş – mal kabul – fatura, tolerans, yetkili gerekçeli geçiş, faturasız kabul raporu) | ✅ |
| **İnşaat:** değişiklik emri (variation order; taşeron ve işveren, süre uzatımı, işveren kabulü) | ✅ |
| **İnşaat:** malzeme mahsubu (taşerona malzeme verme + hakedişte bakiyeli mahsup), KDV tevkifatı (iki yön, parametreli) | ✅ ⚠️ tevkifat oranı/hesapları ve malzemenin KDV'si doğrulanmadı |
| **İnşaat:** damga/pul vergisi | ⏳ ⚠️ |
| **İnşaat:** yabancılara satış sınırları ve yasal süre takibi (89/2026 YGK ve sonrası) | ⏳ Faz C ⚠️ |
| **İnşaat:** altyapı fonları ve harçlar (elektrik/su/belediye): tarihli, doğrulama alanlı tarifeler; alıcıdan tahsil edilen fon (satış sözleşmesine ek satır, 329 yükümlülük, fesihte iade); projenin ödediği fon tahmini | ✅ (B4) ⚠️ tutar/oranlar, 329 hesabı ve fonların vergi/hukuki niteliği doğrulanmadı |
| **İK:** personel kartı, şifreli hassas alanlar (maskeli gösterim, gerekçeli açma, erişim günlüğü), kişisel veri envanteri/talepler/dışa aktarma | ✅ (D1) ⚠️ envanterdeki dayanak ve saklama süreleri doğrulanmadı |
| **İK:** puantaj: günlük devam/izin/mesai (gün türü + normal/fazla mesai saati), proje + iş kalemi + maliyet kodu etiketi, aylık çizelge ve günlük giriş, aylık kapanış (kapalı ay kilitli, gerekçeyle açılır), aylık özet, proje/iş kalemi başına işçilik saatleri | ✅ (D2) ⚠️ yasal çalışma süresi, fazla mesai, izin hakları ve resmî tatil takvimi **kodda yok / doğrulanmadı** (kullanıcı girer) |
| **İK:** bordro motoru: tarihli, doğrulama alanlı, varsayılan KAPALI bordro parametreleri (kodda yasal oran yok), personel ücret şartı, ek ödeme/kesinti kalemleri, puantajdan brüt → kesinti → net ve işveren yükü, onayda proje/iş kalemi/maliyet koduna etiketli yevmiye, ödeme takibi, gerekçeli iptal, puantaj ay kilidiyle bağ, bordro pusulası (iç belge), bordro kaydı ve proje bazında bordro maliyeti | ✅ (D3) ⚠️ **tüm oranlar/çarpanlar/bölenler doğrulanmadı ve varsayılan kapalı; bordro resmî belge değildir**; gelir vergisi düz oran (dilimli yok); hesap eşlemeleri doğrulanmadı |
| **İK:** sosyal güvenlik çıktıları: tarihli sosyal güvenlik profili (bordro tipi kodu serbest veri, sigorta dönemi, şifreli + maskeli numara), tarihli/doğrulama alanlı/varsayılan KAPALI prim desteği kuralları ve uygunluk beyanı, onaylı/ödenmiş bordrodan aylık bildirim (taslak → kesinleşmiş, bordro iptali ve puantaj ayı açma kilidi), xlsx/csv/yazdır çıktısı, aya/projeye göre prim özeti | ✅ (D4) ⚠️ **çıktı GENEL düzendir, resmî bildirim formatı değildir ve doğrulanmadı; bordro tipi, prim desteği oranı/koşulu ve gün/prim esası kuralları doğrulanmadı; sütunlar yapılandırılamaz** |
| **İK:** yabancı işçi belge ve teminat takibi: kullanıcı yönetimli belge türleri, şifreli + maskeli belge numarası (gerekçeli açık okuma), son kullanma durumu (tarihli, doğrulanmamış uyarı günü), salt-eklenir yenileme geçmişi, tarihli kullanıcı parametresinden teminat kaydı ve tutulan teminat raporu, xlsx/csv dışa aktarma, kişi verisi dışa aktarma ve envanter tohumu. | ✅ (D5) | ⚠️ **teminat tutarı, geçerlilik/uyarı süreleri ve makam bilgisi doğrulanmadı ve kodda yok (tarihli kullanıcı parametresi); dosya yükleme, bildirim hatırlatması ve muhasebe bağlantısı yok** |
| **İnşaat:** yabancı işçi belge/teminat takibi (D5) | ⏳ Faz D (D5) ⚠️ |
| **İnşaat:** müteahhitlik sınıf karnesi ve kapasite kontrolü | ⏳ Faz C ⚠️ |
| **Market:** hızlı satış (POS), barkod, gün sonu | ⏳ Faz E |
| **Market:** terazi entegrasyonu, reyon/raf envanteri | ⏳ Faz E |
| Şirket evrakları: yıllık kurul raporu, resmî yazışma arşivi | ⏳ ⚠️ |

## Yönetim raporları

| İşlev | Durum |
|---|---|
| 13 haftalık nakit projeksiyonu (açık alacak/borç vadeleri + elle kalemler, haftalık kapanış bakiyesi) | ✅ (B4) |
| Döviz pozisyon raporu | ⏳ |
| Proje bütçe / gerçekleşen / tahmini toplam sapma analizi (EAC, CPI), Excel | ✅ (B1) |
| Proje kârlılığı (sözleşmeli gelir, tanınmış gelir/maliyet, EAC, tahmini kâr; defter ve GBP raporlama) | ✅ (B4) |
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
| Kurulum sihirbazı (uyumluluk kontrolü → yol seçimi → paketler → sistem): Linux/WSL ve Windows, Docker'lı ve Docker'sız (systemd / Windows hizmeti), geliştirme ve müşteri kipi; platform başına sürüm kiti | ✅ ⚠️ Windows yolu gerçek makinede ilk kurulumla doğrulanmalı |
| Uzaktan tek tıkla güncelleme (satıcı panelden gönderir, müşteride sahip onaylar; imzalı manifesto + SHA-256, otomatik yedek, başarısızlıkta önceki sürüme ve yedeğe dönüş; Docker'lı ve Docker'sız) | ✅ ⚠️ Windows güncelleyicisi gerçek makinede doğrulanmalı |
| Lisanslama: sektör/cihaz/şirket sınırlı, imzalı kiralı lisans; satıcı lisans sunucusu ve web paneli (parola + zorunlu TOTP); salt-okunur mod | ✅ ⚠️ EULA/sözleşme ve veri işleme doğrulanmadı |
| Cihaz koltukları (kayıtlı tarayıcı/bilgisayar, yönetici kaldırır, boşta cihaz düşer) | ✅ |
| Uygulama kullanıcıları için iki adımlı doğrulama (TOTP, kurtarma kodları, yönetici sıfırlaması) | ✅ (şirket düzeyinde zorunlu kılma ⏳) |
| Kişisel veri envanteri, saklama/imha, ilgili kişi dışa aktarma/düzeltme/anonimleştirme, aktarım kaydı (89/2007) | ⏳ ⚠️ |
