import type { NavHelpEntry } from './helpTypes';

export type { NavHelpEntry };

export const NAV_GROUP_HELP: Record<string, NavHelpEntry> = {
  manufacturing: {
    title: 'Üretim ve Toptan Ticaret',
    description: 'Ürün reçeteleri, iş emirleri, fason takip, atölye operasyonları, hammadde sarfiyatı ve toptan sevkiyat süreçlerini yönetir.',
    example: 'Örnek: Üretim planlama sorumlusu 500 adetlik montaj emri açar; gerekli hammadde stoktan otomatik düşer, üretilen mamul depoya girer.',
  },
  overview: {
    title: 'Genel',
    description: 'Şirketin günlük operasyonel yapılacak işleri, genel performans panosu, belge arşivi ve anlık bildirimlerinin merkezidir.',
    example: 'Örnek: Yönetici sabah panele bakarak vadesi gelen tahsilatları, onay bekleyen satın alma taleplerini ve günlük ciroyu tek ekranda izler.',
  },
  parties: {
    title: 'Cari Hesaplar',
    description: 'Müşteri, tedarikçi ve taşeronların hesap kartlarını, bakiye durumlarını, yaşlandırma raporlarını ve tahsilat takibini yönetir.',
    example: 'Örnek: Müşterinin cari ekstresi taranır; vadesi 45 günü aşan açık alacaklar için otomatik tahsilat hatırlatması ve mutabakat mektubu oluşturulur.',
  },
  invoices: {
    title: 'Fatura ve İrsaliye',
    description: 'Mal ve hizmet satış/alış faturaları, sevk irsaliyeleri, iade süreçleri, fiyat listeleri ve toplu faturalama işlemlerini yürütür.',
    example: 'Örnek: Ay içinde müşteriye yapılan 15 ayrı sevk irsaliyesi ay sonunda tek ekrandan seçilerek toplu faturaya dönüştürülür ve muhasebeye işlenir.',
  },
  treasury: {
    title: 'Kasa ve Banka',
    description: 'Şirketin nakit varlıkları, banka hesapları, çek/senet portföyü, teminat mektupları ve günlük gelir-gider nakit hareketlerini izler.',
    example: 'Örnek: Müşteriden alınan 150.000 TL vadeli çek sisteme girilir; vadesi geldiğinde bankaya takasa verilir ve hesap bakiyesi güncellenir.',
  },
  stock: {
    title: 'Stok ve Depo',
    description: 'Hammadde ve ticari malların depo bazlı miktarları, stok hareketleri, devir hızları, sayımlar, seri numaraları ve ithalat maliyetlerini takip eder.',
    example: 'Örnek: Dönem sonu fiziki depo sayımı yapılır; sistemdeki miktar ile fiziki sayım karşılaştırılarak sayım fark fişi otomatik kesilir.',
  },
  construction: {
    title: 'Şantiye ve Taahhüt',
    description: 'İnşaat projeleri, şantiye malzeme talepleri, taşeron sözleşmeleri, hakedişler, değişiklik emirleri ve gayrimenkul birim satışlarını kapsar.',
    example: 'Örnek: Sahada tamamlanan kalıp ve demir imalatı için taşeron hakedişi düzenlenir; avans ve teminat kesintileri düşülerek net ödeme onaylanır.',
  },
  directory: {
    title: 'Rehber ve Ajanda',
    description: 'Şirketle ilişkili gerçek kişiler, iş ortakları, resmi kurumlar ve operasyonel randevu/toplantı takvimini bir arada tutar.',
    example: 'Örnek: Belediyedeki imar sorumlusunun iletişim bilgileri kaydedilir ve haftaya yapılacak şantiye ruhsat görüşmesi ajandaya işlenir.',
  },
  hr: {
    title: 'İnsan Kaynakları ve Bordro',
    description: 'Personel özlük dosyaları, çalışma puantajları, yasal bordro hesapları, avanslar, SGK bildirgeleri ve yabancı işçi izinlerini yönetir.',
    example: 'Örnek: Ay sonu puantajdan fazla mesailer hesaplanır, brüt ücretten vergiler düşülerek net bordro basılır ve banka maaş listesi hazırlanır.',
  },
  accounting: {
    title: 'Muhasebe',
    description: 'Tekdüzen hesap planı, yevmiye kayıtları, büyük defter (kebir), mizan, sabit kıymet amortismanları ve yıl sonu mali kapanışlarını yönetir.',
    example: 'Örnek: Kesilen bir satış faturası 120 ve 600 hesaplara yevmiye maddesi olarak kaydedilir; ay sonunda genel mizan çekilerek denklik kontrol edilir.',
  },
  reports: {
    title: 'Raporlar ve Analitik',
    description: 'Şirket kârlılığı, satış/satın alma istatistikleri, kur farkı (kambiyo) raporları, bilanço ve yönetici özet analizlerini üretir.',
    example: 'Örnek: Yönetim kurulu için son çeyreğin ciro, brüt kâr marjı, döviz açık pozisyonu ve şantiye maliyet kârlılık raporları PDF olarak alınır.',
  },
  settings: {
    title: 'Ayarlar ve Sistem',
    description: 'Şirket künyesi, şube yetkileri, onay iş akışları, kullanıcı rolleri, para birimleri, KDV oranları ve yedekleme yapılandırmasını içerir.',
    example: 'Örnek: Yeni başlayan finans uzmanına fatura okuma yetkisi verilir; 50.000 TL üzeri ödemeler için genel müdür onay kuralı tanımlanır.',
  },
  procurement: {
    title: 'Satın Alma ve Tedarik',
    description: 'Şirket genelindeki satın alma talepleri, teklif toplama, sipariş ve tedarikçi performans süreçlerini yönetir.',
    example: 'Örnek: İhtiyaç duyulan ofis veya saha malzemesi için 3 farklı satıcıdan teklif toplanıp en uygununa sipariş açılır.',
  },
  leather: {
    title: 'Deri Aksesuar ve Moda',
    description: 'Deri malzeme kabulü, kesim planları, model koleksiyonları, fason imalat ve satış sonrası onarım süreçlerini takip eder.',
    example: 'Örnek: Ham deri partisi kalite kontrolünden geçirilir; model kesim şablonuna göre fire oranı hesaplanarak üretime sevk edilir.',
  },
};

export const NAV_ITEM_HELP: Record<string, NavHelpEntry> = {
  // ---- Genel Grubu ----
  workspace: {
    title: 'Bugünkü İşlerim',
    description: 'Kullanıcının üzerinde olan görevleri, vadesi gelen tahsilatları ve tamamlanması gereken acil operasyonel adımları listeler.',
    example: 'Örnek: Satış temsilcisi sabah ekrana girdiğinde bugün araması gereken 4 müşteriyi ve teslim edilecek 2 açık siparişi görür.',
  },
  documents: {
    title: 'Belge Arşivi',
    description: 'Şirkete ait sözleşmeler, taranmış faturalar, irsaliyeler, resmi yazışmalar ve dekontların saklandığı dijital arşivdir.',
    example: 'Örnek: Bir müşteri 6 ay önceki irsaliyeye itiraz ettiğinde, imzalı kaşeli teslim tutanağı PDF olarak saniyeler içinde arşivden çıkarılır.',
  },
  dashboard: {
    title: 'Genel Bakış',
    description: 'Şirketin anlık finansal ve operasyonel sağlığını (kasa/banka mevcudu, ciro, açık alacaklar, bekleyen onaylar) özetler.',
    example: 'Örnek: Şirket yöneticisi tek bakışta kasada kaç TL olduğunu, bu ayki toplam fatura cirosunu ve bekleyen 3 onay talebini görür.',
  },
  notifications: {
    title: 'Bildirimler',
    description: 'Sistemdeki onay bekleyen belgeler, limit aşımları, yaklaşan çek vadeleri ve kritik stok uyarılarını anlık iletir.',
    example: 'Örnek: Satın alma uzmanının girdiği 80.000 TL\'lik talep, onay yetkisine sahip direktörün bildirim merkezine anında düşer.',
  },

  // ---- Cari Grubu ----
  'collection-work': {
    title: 'Tahsilat Takibi',
    description: 'Vadesi geçmiş veya yaklaşan müşteri alacaklarını takip edip arama, e-posta ve mutabakat aksiyonu planlamayı sağlar.',
    example: 'Örnek: Vadesi 30 günü aşan 120.000 TL borcu olan müşteriye sistem üzerinden otomatik bakiye hatırlatması ve hesap ekstresi gönderilir.',
  },
  parties: {
    title: 'Cari Hesaplar',
    description: 'Tüm müşteri, tedarikçi, taşeron ve aracıların kimlik, vergi, adres, iletişim ve anlık borç/alacak bakiyelerini tutan ana kütüktür.',
    example: 'Örnek: Yeni bir malzeme tedarikçisi açılır; vergi numarası, banka IBAN bilgisi ve 45 günlük standart ödeme vadesi kartına kaydedilir.',
  },
  'party-aging': {
    title: 'Yaşlandırma Raporu',
    description: 'Müşteri alacakları ve tedarikçi borçlarının vadesine göre (0-30, 31-60, 60+ gün) ne kadar geciktiğini kümeleyerek nakit riskini gösterir.',
    example: 'Örnek: Finans müdürü 90 günü aşan vadesi geçmiş alacakları listeler ve hukuki takip başlatılacak carileri belirler.',
  },

  // ---- Fatura ve İrsaliye Grubu ----
  'sales-invoices': {
    title: 'Satış Faturaları',
    description: 'Müşterilere kesilen satış faturalarını düzenler, KDV\'leri hesaplar ve cariyi borçlandırır.',
    example: 'Örnek: Müşteriye 250.000 TL + KDV tutarında malzeme teslim edildiğinde satış faturası kesilir; carisine borç ve gelir tablosuna ciro işlenir.',
  },
  'purchase-invoices': {
    title: 'Alış ve Gider Faturaları',
    description: 'Tedarikçilerden gelen mal ve hizmet faturalarının sisteme işlendiği, stok maliyet ve borç kayıtlarının oluştuğu ekrandır.',
    example: 'Örnek: Akaryakıt firmasından gelen 60.000 TL\'lik filo yakıt faturası işlenir; genel yönetim giderine yazılıp tedarikçiye borç kaydedilir.',
  },
  'sales-delivery-notes': {
    title: 'Satış İrsaliyeleri',
    description: 'Müşteriye sevk edilen malların miktarını kayıt altına alan ve faturaya bağlanmayı bekleyen resmi sevk irsaliyeleridir.',
    example: 'Örnek: Depodan müşterinin şantiyesine 400 torba çimento sevk edilirken satış irsaliyesi düzenlenir; depodaki stok anında düşer.',
  },
  'purchase-delivery-notes': {
    title: 'Alış İrsaliyeleri',
    description: 'Satıcıdan gelen malzemelerin depo görevlisi tarafından miktar kontrolüyle teslim alınıp stoka giriş yapıldığı irsaliyelerdir.',
    example: 'Örnek: Tedarikçiden gelen 15 ton nervürlü demir tartımdan geçirilip alış irsaliyesiyle ana depoya kabul edilir; fatura gelince eşleştirilir.',
  },
  'sales-return-notes': {
    title: 'Satış İade İrsaliyeleri',
    description: 'Müşterinin hatalı veya kusurlu bularak firmaya geri gönderdiği ürünlerin depoya tekrar sağlam/hasarlı girişini sağlar.',
    example: 'Örnek: Müşterinin fazla sipariş ettiği 25 koli seramik iade irsaliyesiyle depoya geri alınır ve müşteriye iade faturası hakkı doğar.',
  },
  'purchase-return-notes': {
    title: 'Alış İade İrsaliyeleri',
    description: 'Tedarikçiden gelen ayıplı, kırık veya sipariş dışı malzemelerin firmadan satıcıya geri gönderilmesi işlemidir.',
    example: 'Örnek: Boyaları çizik gelen 40 adet radyatör tedarikçiye iade irsaliyesi kesilerek geri yollanır ve satıcı cari borcundan düşülür.',
  },
  'sales-quotes': {
    title: 'Satış Teklifleri',
    description: 'Müşterilere sunulan ürün ve hizmetlerin birim fiyat, iskonto, teslim süresi ve geçerlilik vadesini içeren resmi teklif taslaklarıdır.',
    example: 'Örnek: Müteahhit firmaya 1.200.000 TL\'lik tesisat malzemesi teklifi 15 gün opsiyonlu verilir; müşteri onaylayınca siparişe dönüştürülür.',
  },
  'sales-orders': {
    title: 'Satış Siparişleri',
    description: 'Müşteri tarafından kabul edilen ve depo hazırlığı / tedarik sürecine başlanan kesinleşmiş sipariş kayıtlarıdır.',
    example: 'Örnek: Teklifi onaylanan müşterinin siparişi işlenir; depodaki ilgili mallar rezerve edilerek başka müşteriye satılması önlenir.',
  },
  'price-lists': {
    title: 'Fiyat Listeleri',
    description: 'Farklı müşteri kitleleri için (Bayi, Toptan, Perakende, İhracat) tanımlanan özel birim fiyat katalogları ve para birimleridir.',
    example: 'Örnek: "Toptan Bayi Listesi" oluşturulur; bu gruba bağlı bayiler sipariş girdiğinde liste fiyatı üzerinden otomatik %15 iskonto uygulanır.',
  },
  'party-prices': {
    title: 'Cari Özel Fiyatlar',
    description: 'Belirli bir stratejik müşteri veya satıcıyla sözleşmeyle sabitlenmiş özel ürün birim fiyatları ve ek indirimlerdir.',
    example: 'Örnek: Büyük hacimli alım yapan "Örnek İnşaat" firmasına çimento torba fiyatı genel liste 130 TL iken sözleşmeli 105 TL tanımlanır.',
  },
  'batch-invoicing': {
    title: 'Toplu Faturalama',
    description: 'Dönem içinde kesilen onlarca sevk irsaliyesinin tek ekrandan seçilerek topluca resmi satış faturalarına dönüştürülmesidir.',
    example: 'Örnek: Ay sonu bir zincir markete ait 50 farklı irsaliye tek tıkla seçilir ve faturaya dönüştürülüp muhasebeleştirilir.',
  },
  'vat-summary': {
    title: 'KDV Özeti',
    description: 'Ay içinde hesaplanan KDV, indirilecek KDV, tevkifat kesintileri ve sonraki döneme devreden KDV projeksiyonunu raporlar.',
    example: 'Örnek: KDV beyannamesi verilmeden önce muhasebeci ödenecek net vergi tutarını ve tevkifat mahsuplarını bu ekrandan denetler.',
  },
  campaigns: {
    title: 'Kampanya ve Promosyon',
    description: 'Belli tarih aralıklarında geçerli sepet tutarı indirimleri, "X al Y öde" veya hediye ürün kampanyalarını yönetir.',
    example: 'Örnek: "Yaz Kampanyası" açılarak 100.000 TL üzeri toptan boya alımlarında anında %8 nakit indirim kuralı devreye alınır.',
  },

  // ---- Kasa ve Banka Grubu ----
  'cash-scenarios': {
    title: 'Nakit Senaryoları',
    description: 'Farklı risk senaryolarında (tahsilat gecikmesi, kur şoku, faiz artışı) şirketin nakit akışının nasıl etkileneceğini simüle eder.',
    example: 'Örnek: "En büyük 2 müşterimiz 60 gün ödeme yapmazsa önümüzdeki ay maaş ve tedarikçi ödemelerinde nakit açığı çıkar mı?" simülasyonu yapılır.',
  },
  'treasury-accounts': {
    title: 'Hesaplar (Kasa ve Banka)',
    description: 'Şirketin TL/döviz banka mevduat hesapları, şirket kredi kartları, şantiye kasaları ve merkez kasa tanımlarıdır.',
    example: 'Örnek: Şirketin İş Bankası Ticari TL Hesabı ve Şantiye Harcama Kasası tanımlanır; anlık bakiyeleri ve IBAN bilgileri yönetilir.',
  },
  'cash-forecast': {
    title: 'Nakit Projeksiyonu',
    description: 'Gelecek 30-90 gün içindeki kesinleşmiş tahsilat ve ödeme takvimini gün bazında nakit dengesi olarak modeller.',
    example: 'Örnek: Gelecek haftanın Cuma günü yapılacak 600.000 TL taşeron ödemesi öncesinde banka hesabında yeterli nakit kalıp kalmayacağı izlenir.',
  },
  cheques: {
    title: 'Çek/Senet Portföyü',
    description: 'Müşterilerden alınan ve satıcılara verilen çek/senetlerin vade, keşideci, banka, ciro ve tahsilat takibidir.',
    example: 'Örnek: Portföydeki 300.000 TL\'lik müşteri çeki ciro edilerek ana demir tedarikçisine borç ödemesi olarak devredilir.',
  },
  'expense-entries': {
    title: 'Gider Fişleri',
    description: 'Faturasız yapılan küçük harcamalar, noter, harç, taksi, otopark, personel yemeği gibi kasa harcamalarının kaydedilmesidir.',
    example: 'Örnek: Şantiye şefinin saha için aldığı 1.500 TL\'lik acil hırdavat fişi gider kaydı olarak şantiye kasasından düşülür.',
  },
  'expense-cards': {
    title: 'Gider Kartları',
    description: 'Şirket genelindeki masraf kalemlerinin (Akaryakıt, Ofis Kırtasiye, Şantiye Yemeği, Temsil vb.) muhasebe hesaplarıyla eşleşmesidir.',
    example: 'Örnek: "Şantiye Araç Bakım Gideri" kartı açılarak ilgili 740/770 muhasebe hesabına bağlanır ve tüm harcamalar standartlaşır.',
  },
  'expense-reports': {
    title: 'Gider Raporları',
    description: 'Departman, şantiye veya masraf türü bazında aylık harcama dağılımını, bütçe aşımlarını ve trendleri raporlar.',
    example: 'Örnek: Yönetim kurulu geçen ay hangi şantiyenin ne kadar yakıt ve konaklama harcaması yaptığını karşılaştırmalı grafiklerle inceler.',
  },
  'bank-guarantees': {
    title: 'Teminat Mektupları',
    description: 'Bankalardan alınan veya üçüncü taraflara verilen geçici, kesin ve avans teminat mektuplarının vadelerini ve komisyonlarını takip eder.',
    example: 'Örnek: İhale için bankadan alınan 2.000.000 TL\'lik kesin teminat mektubu sisteme işlenir; vadesi ve komisyon yenilemesi izlenir.',
  },
  'treasury-transactions': {
    title: 'Hareketler (Kasa/Banka)',
    description: 'Kasa ve banka hesaplarına giren/çıkan tüm nakit para transferleri, virmanlar, havale ve banka dekont kayıtlarıdır.',
    example: 'Örnek: Merkez TL Kasasından Şantiye Kasasına 80.000 TL nakit devri (virman) yapılır ve iki kasanın bakiyesi anında güncellenir.',
  },

  // ---- Stok Grubu ----
  'stock-analytics': {
    title: 'ABC, Hareketsiz Stok ve Devir',
    description: 'Stokları değerine göre (A/B/C) sınıflandırır; 90+ gündür satılmayan hareketsiz malları ve stok devir hızını analiz eder.',
    example: 'Örnek: Depoda 180 gündür hiç hareket görmeyen 400.000 TL değerindeki atıl malzemeler tespit edilir ve iskonto ile tasfiye edilir.',
  },
  items: {
    title: 'Stok Kartları',
    description: 'Satılan veya üretimde kullanılan ticari malların, hammaddelerin barkod, birim, marka, kritik seviye ve vergi tanımlarıdır.',
    example: 'Örnek: "Nervürlü Demir 14mm" için stok kartı açılır; birim "Ton", minimum emniyet stoku "5 Ton", KDV "%20" olarak belirlenir.',
  },
  'stock-status': {
    title: 'Stok Durumu',
    description: 'Depolardaki anlık fiili miktarları, siparişe rezerve edilmiş ürünleri, yoldaki malları ve ortalama maliyet değerlerini gösterir.',
    example: 'Örnek: Satış personeli sipariş alırken depoda satılabilir 250 adet hazır ürün olduğunu bu ekrandan anlık teyit eder.',
  },
  'stock-movements': {
    title: 'Stok Hareketleri',
    description: 'Ürünlerin hangi faturayla, irsaliyeyle, sayımla veya üretim fişiyle depoya girip çıktığının ayrıntılı tarihçesidir.',
    example: 'Örnek: Depoda bir ürünün neden 10 adet eksik çıktığı araştırılırken geçmiş 30 günlük giriş ve çıkış belgeleri satır satır taranır.',
  },
  'import-files': {
    title: 'İthalat Dosyaları',
    description: 'Yurt dışından getirilen malların gümrük vergisi, navlun, sigorta ve gümrükçü masraflarını ürünün birim maliyetine paylaştırır.',
    example: 'Örnek: Yurt dışından alınan jeneratörlerin 8.000 USD navlun ve gümrük masrafı ithalat dosyasıyla ürün maliyetine yedirilir.',
  },
  'serial-lookup': {
    title: 'Seri No Sorgula',
    description: 'Garanti, IMEI veya seri numarası takipli ürünlerin hangi faturayla alınıp kime satıldığını tekil olarak sorgular.',
    example: 'Örnek: Arızalanan bir elektrik motorunun gövde seri numarası girilir; hangi tarihte kime satıldığı ve garantisi anında bulunur.',
  },
  'stock-counts': {
    title: 'Sayımlar',
    description: 'Depolardaki fiziki sayım sonuçlarının girildiği, sistem stoğuyla farkların tespit edilip düzeltme fişi kesildiği ekrandır.',
    example: 'Örnek: Ay sonu sayımında depoda 1.050 adet sayılan kablo sistemde 1.000 görünüyorsa 50 adetlik sayım fazlası fişi işlenir.',
  },
  warehouses: {
    title: 'Depolar',
    description: 'Şirketin sahip olduğu merkez depo, şube depoları, şantiye sahaları ve tır konsinye depolarının tanımlandığı yerdir.',
    example: 'Örnek: "Merkez Lojistik Depo" ve "Girne Şantiye Deposu" tanımlanır; depolar arası transfer fişi ile malzeme taşınır.',
  },

  // ---- Şantiye Grubu ----
  'construction-replenishment': {
    title: 'Stok Tamamlama Önerileri',
    description: 'Minimum seviyenin altına düşen şantiye malzemelerini analiz ederek otomatik satın alma talebi üretir.',
    example: 'Örnek: Çimento stoku kritik seviye olan 50 torbanın altına indiğinde sistem otomatik 200 torbalık satın alma sipariş taslağı hazırlar.',
  },
  'construction-supplier-performance': {
    title: 'Tedarikçi Performansı',
    description: 'Şantiyeye malzeme getiren tedarikçilerin teslimat süresi, eksiksiz teslim ve kalite kabul oranlarını puanlar.',
    example: 'Örnek: Hazır beton tedarikçisinin son 10 dökümdeki gecikme ve kalite onayları incelenerek yeni etap için anlaşma yenilenir.',
  },
  'construction-center': {
    title: 'İnşaat Kontrol Merkezi',
    description: 'Tüm şantiyelerin ilerleme yüzdeleri, bütçe gerçekleşmeleri, kritik malzeme açıkları ve maliyet sağlığını tek merkezden gösterir.',
    example: 'Örnek: Proje direktörü ekrana bakar; A etabının %72 tamamlandığını ve malzeme bütçesinin planın %3 altında gittiğini izler.',
  },
  'site-operations': {
    title: 'Saha ve İş Takibi',
    description: 'Şantiye şeflerinin günlük hava durumu, sahada çalışan ekip sayısı, yapılan imalat ve fotoğrafları girdiği günlük saha defteridir.',
    example: 'Örnek: Şantiye şefi cep telefonundan "Bugün 2. kat kolon betonları döküldü, 14 işçi çalıştı" yazarak saha günlüğünü kaydeder.',
  },
  projects: {
    title: 'Projeler',
    description: 'Şirketin yürüttüğü tüm inşaat, taahhüt veya iç projelerin bütçe, başlangıç, bitiş, müşteri ve lokasyon kartlarıdır.',
    example: 'Örnek: "Bellapais Konutları Projesi" açılır; toplam 25.000.000 GBP bütçe tanımlanır ve tüm malzeme/işçilik giderleri buraya bağlanır.',
  },
  'purchase-requests': {
    title: 'Satın Alma Talepleri',
    description: 'Sahadaki mühendis ve ustabaşıların şantiye ihtiyaçlarını satınalma birimine resmi olarak ilettiği onaylı talep formudur.',
    example: 'Örnek: Saha mühendisi 600 m³ hazır beton talebi açar; proje müdürü onaylayınca satınalma sorumlusunun teklif ekranına düşer.',
  },
  rfqs: {
    title: 'Teklif Karşılaştırma',
    description: 'Bir malzeme talebi için farklı tedarikçilerden toplanan fiyat, vade ve nakliye tekliflerini yan yana kıyaslayıp en iyisini seçtirir.',
    example: 'Örnek: Demir alımı için 3 ayrı tüccardan gelen teklifler fiyat, ödeme vadesi ve şantiye teslim şartına göre kıyaslanır.',
  },
  'purchase-orders': {
    title: 'Siparişler (Satın Alma)',
    description: 'En uygun teklifi veren tedarikçiye gönderilen resmi onaylı malzeme veya hizmet satın alma siparişidir.',
    example: 'Örnek: Teklifi kabul edilen kiremit tedarikçisine sistemden onaylı PDF sipariş mektubu e-posta ile otomatik iletilir.',
  },
  'order-matching': {
    title: 'Sipariş Eşleştirme',
    description: 'Şantiyeye gelen irsaliye ve faturaların, verilen orijinal siparişteki miktar ve birim fiyatlarla uyuştuğunu denetler.',
    example: 'Örnek: Faturadaki birim fiyat siparişteki 80 TL yerine 88 TL kesilmişse sistem uyarı verir ve onay almadan kaydetmez.',
  },
  'real-estate-units': {
    title: 'Birimler (Bağımsız Bölümler)',
    description: 'Gayrimenkul projelerindeki satılık konut, villa, dükkan ve ofislerin m², kat, yön ve fiyat katalogudur.',
    example: 'Örnek: "B Blok No: 4" (2+1, 95 m², bahçe katı) bağımsız bölümü sisteme eklenir ve satış listesine 160.000 GBP fiyatla konur.',
  },
  'sales-contracts': {
    title: 'Satış Sözleşmeleri (Gayrimenkul)',
    description: 'Müşterilerle yapılan gayrimenkul satış şartları, ödeme planı, peşinat ve teslim taahhütlerinin resmi sözleşmeleridir.',
    example: 'Örnek: Alıcı ile 180.000 GBP\'lik sözleşme imzalanır; %35 peşinat ve kalanı 24 ay eşit taksit olarak sisteme işlenir.',
  },
  'sales-installments': {
    title: 'Taksitler (Gayrimenkul)',
    description: 'Gayrimenkul satış sözleşmelerine bağlı takvimli müşteri taksitlerinin vadelerini ve tahsilat durumlarını takip eder.',
    example: 'Örnek: Her ayın 1\'inde vadesi gelen 3.000 GBP taksit müşterinin banka havalesiyle eşleştirilip ödendi olarak işaretlenir.',
  },
  subcontracts: {
    title: 'Taşeron Sözleşmeleri',
    description: 'Şantiyede imalat yapan taşeronlarla (Elektrik, Sıva, Alçıpan vb.) yapılan birim fiyat, ceza ve teminat şartnameleridir.',
    example: 'Örnek: Boya taşeronu ile m² başına 90 TL\'den sözleşme yapılır; %5 teminat kesintisi ve 30 gün hakediş vadesi şartı bağlanır.',
  },
  'employer-contracts': {
    title: 'İşveren Sözleşmeleri',
    description: 'Ana işverene veya arsa sahibine taahhüt edilen inşaat işinin kapsamı, birim fiyatları, avans ve gecikme cezası şartlarıdır.',
    example: 'Örnek: Şirketin ana yüklenici olarak üstlendiği 60M TL\'lik okul inşaatı sözleşme şartları ve birim fiyat tarifesi sisteme girilir.',
  },
  'employer-claims': {
    title: 'İşveren Hakedişleri',
    description: 'Ana işverene yapılan imalatlar karşılığında düzenlenen metrajlı resmi tahsilat hakediş belgeleridir.',
    example: 'Örnek: Projede 3. ay tamamlanan kaba inşaat metrajları hazırlanır ve işveren kontrol heyetine 5.500.000 TL hakediş sunulur.',
  },
  'progress-payments': {
    title: 'Hakedişler (Taşeron)',
    description: 'Taşeronların sahada tamamladığı imalatlar için hazırlanan ve kesintiler düşüldükten sonra ödenecek net tutarı belirleyen belgelerdir.',
    example: 'Örnek: Duvar taşeronunun ördüğü 1.500 m² duvar için hakediş hazırlanır; avans kesintisi düşülüp net 120.000 TL onaylanır.',
  },
  'variation-orders': {
    title: 'Değişiklik Emirleri',
    description: 'Proje sürerken sonradan eklenen veya çıkarılan imalatların sözleşme bütçesine ve teslim süresine etkisini resmiyete bağlar.',
    example: 'Örnek: Müşteri projeye kapalı otopark eklenmesini ister; 500.000 TL ek maliyet ve 45 gün ek süre değişiklik emriyle onaylanır.',
  },
  approvals: {
    title: 'Onay Kutusu',
    description: 'Şirket yöneticilerinin onayını bekleyen hakediş, satın alma talebi, sözleşme ve faturaların toplu onay merkezidir.',
    example: 'Örnek: Şirket müdürü onay bekleyen 3 taşeron hakedişini ve 2 satın alma siparişini inceleyip tek ekrandan onaylar.',
  },

  // ---- Rehber Grubu ----
  'directory-contacts': {
    title: 'Kişi Rehberi',
    description: 'Müşteri temsilcileri, taşeron ustabaşıları, mimarlar, mühendisler ve resmi kurum çalışanlarının kartvizit rehberidir.',
    example: 'Örnek: İlgili belediyenin fen işleri müdürünün veya elektrik taşeronu şantiye şefinin telefon ve e-posta bilgisi kaydedilir.',
  },
  'directory-orgs': {
    title: 'Kurum Rehberi',
    description: 'Şirketle çalışan kurumlar, bakanlıklar, belediyeler, banka şubeleri ve meslek odalarının kurumsal profilleridir.',
    example: 'Örnek: Çalışılan yapı denetim kuruluşunun şirket bilgileri, sicil no\'su ve sorumlu denetçi listesi kurumsal kartta tutulur.',
  },
  agenda: {
    title: 'Ajanda',
    description: 'Şirket içi toplantılar, şantiye saha ziyaretleri, resmi denetim günleri ve önemli sözleşme teslim tarihlerinin takvimidir.',
    example: 'Örnek: Perşembe günü saat 10:00\'daki şantiye koordinasyon toplantısı ajandaya eklenip ilgili mühendislere takvim bildirimi gider.',
  },

  // ---- İnsan Kaynakları Grubu ----
  employees: {
    title: 'Personel',
    description: 'Çalışanların kimlik, özlük dosyaları, departman, unvan, işe giriş tarihi, sözleşme türü ve iletişim bilgilerinin ana kütüğüdür.',
    example: 'Örnek: İşe yeni başlayan elektrik mühendisinin kimlik, diploma, ehliyet ve SGK giriş evrakları personel kartına yüklenir.',
  },
  attendance: {
    title: 'Puantaj',
    description: 'Personelin aylık fiili çalışma günleri, yıllık izin, rapor, tatil ve fazla mesai saatlerinin girildiği devam-takip cetvelidir.',
    example: 'Örnek: Ay içinde 22 gün normal mesai ve 12 saat hafta sonu fazla mesaisi yapan formenin puantajı sisteme işlenir.',
  },
  payroll: {
    title: 'Bordro',
    description: 'Puantaj verilerine göre brüt maaş üzerinden SGK primleri, gelir vergisi ve kesintiler düşülerek net maaşların hesaplanmasıdır.',
    example: 'Örnek: Ay sonu tüm şirketin bordrosu tek tıkla hesaplanır; personellere maaş pusulaları şifreli olarak e-posta ile gönderilir.',
  },
  'payroll-settings': {
    title: 'Bordro Ayarları',
    description: 'Asgari ücret tutarı, gelir vergisi dilimleri, damga vergisi, kıdem tavanı ve fazla mesai katsayılarının yönetildiği merkezdir.',
    example: 'Örnek: Hükümet tarafından açıklanan yeni asgari ücret ve vergi muafiyeti tutarları bordro parametrelerine güncellenir.',
  },
  'employee-ledger': {
    title: 'Avans ve Maaş Cari',
    description: 'Personelin ay içinde aldığı nakit avanslar, icra kesintileri ve net maaş ödemelerinin kişisel cari hareketleridir.',
    example: 'Örnek: Personele ayın 15\'inde ödenen 8.000 TL nakit avans işlenir; ay sonu bordro hesaplanırken otomatik maaşından mahsup edilir.',
  },
  'social-security': {
    title: 'Sosyal Güvenlik',
    description: 'Sosyal güvenlik kurumu bildirgeleri, işveren prim payları ve aylık prim-hizmet belgelerinin dökümüdür.',
    example: 'Örnek: Ay başında SGK\'ya iletilecek aylık bildirge dökümü alınır ve bankadan ödeme tahakkuku kontrol edilir.',
  },
  'social-settings': {
    title: 'Sosyal Güvenlik Ayarları',
    description: 'SGK prim oranları, işyeri tehlike sınıfları, devlet istihdam teşvikleri ve şube tescil numaralarının tanımlarıdır.',
    example: 'Örnek: Şantiye işyerleri için geçerli kısa vadeli iş kazası sigorta prim oranı ve %5 işveren teşvik kuralı tanımlanır.',
  },
  'foreign-workers': {
    title: 'Yabancı İşçi Belgeleri',
    description: 'Yabancı personelin çalışma izni, oturma izni, pasaport süresi ve harç ödeme takvimini izleyen takip merkezidir.',
    example: 'Örnek: Çalışma izninin bitmesine 30 gün kalan yabancı mühendis için sistem İK uzmanına otomatik yenileme uyarısı verir.',
  },
  'foreign-settings': {
    title: 'Yabancı İşçi Ayarları',
    description: 'Yabancı personel çalıştırma kotaları, harç ücretleri, bakanlık başvuru koşulları ve yasal süre parametreleridir.',
    example: 'Örnek: Bakanlık tarafından güncellenen yabancı çalışma izni harç bedelleri ve sağlık sigortası şartları sisteme işlenir.',
  },
  privacy: {
    title: 'Veri Koruma (KVKK)',
    description: 'Personelin kimlik, IBAN ve sağlık verilerine kimin ne zaman eriştiğini kaydeden ve maskeleyen güvenlik günlüğüdür.',
    example: 'Örnek: Bir personelin IBAN veya kimlik numarasını görüntüleyen kullanıcının erişim kaydı yasal denetim için otomatik loglanır.',
  },

  // ---- Muhasebe Grubu ----
  'fixed-assets': {
    title: 'Demirbaş ve Amortisman',
    description: 'Şirkete ait binek araçlar, iş makineleri, bilgisayarlar ve binaların dönemsel yıpranma paylarını (amortisman) hesaplar.',
    example: 'Örnek: Satın alınan 900.000 TL\'lik binek aracın yıllık %20 amortisman payı (180.000 TL) giderleştirilerek yevmiyeye aktarılır.',
  },
  'company-budgets': {
    title: 'Bütçe ve Sapma',
    description: 'Yıllık departman ve proje gelir/gider hedefleri ile gerçekleşen muhasebe tutarlarını kıyaslayıp sapmaları gösterir.',
    example: 'Örnek: Pazarlama birimine verilen 600.000 TL yıllık bütçenin ilk yarıda %75\'inin harcandığı görülerek harcama freni kararı alınır.',
  },
  journal: {
    title: 'Yevmiye Kayıtları',
    description: 'Şirketin tüm işlemlerinin çift taraflı kayıt sistemine göre (Borç / Alacak) işlendiği resmi muhasebe yevmiye fişleridir.',
    example: 'Örnek: Bankadan ödenen elektrik faturası için "770 Genel Yönetim Giderleri (Borç) / 102 Bankalar (Alacak)" fişi kaydedilir.',
  },
  openings: {
    title: 'Açılış Bakiyeleri',
    description: 'Sisteme ilk başlarken veya yeni mali yıla devirde önceki dönemden aktarılan hesap bakiyelerinin girildiği ekrandır.',
    example: 'Örnek: Ada ERP\'ye geçişte şirketin önceki programındaki 100 Kasa, 120 Müşteriler ve 320 Satıcılar devir bakiyeleri yüklenir.',
  },
  accounts: {
    title: 'Hesap Planı',
    description: 'Tekdüzen hesap planı standartlarında 100\'den 999\'a kadar tüm ana ve alt muavin hesapların hiyerarşik ağacıdır.',
    example: 'Örnek: Yeni açılan banka hesabı için "102.01.006 Garanti Bankası Lefkoşa Şubesi" şeklinde yeni bir muavin alt hesap açılır.',
  },
  'trial-balance': {
    title: 'Mizan',
    description: 'Tüm muhasebe hesaplarının dönem içindeki borç, alacak toplamları ile kalan bakiyelerini topluca denetleten kontrol cetvelidir.',
    example: 'Örnek: Ay sonu genel mizan çekilir; borç ve alacak toplamlarının eşitliği teyit edilerek hesap mutabakatı tamamlanır.',
  },
  'account-ledger': {
    title: 'Hesap Ekstresi (Muavin)',
    description: 'Seçilen tek bir muhasebe hesabının belirli tarih aralığındaki tüm borç ve alacak fiş satırlarını ayrıntılı döker.',
    example: 'Örnek: 320.01.004 kodlu çimento tedarikçisi muavin hesabı taranarak tedarikçinin gönderdiği ekstreyle satır satır mutabakat yapılır.',
  },
  'year-end': {
    title: 'Yıl Sonu Kapanışı',
    description: 'Mali yıl bitiminde 6\'lı gelir tablosu hesaplarının 690\'a devri, net kâr/zarar tespiti ve resmi kapanış/açılış fişleridir.',
    example: 'Örnek: 31 Aralık gecesi gelir ve gider hesapları kapatılarak net kâr bilançoya devredilir ve yeni yıl defterleri hazırlanır.',
  },

  // ---- Raporlar Grubu ----
  'project-profitability': {
    title: 'Proje Kârlılığı',
    description: 'Şantiyelerin hakediş gelirleri ile taşeron, malzeme, işçilik ve genel giderlerini kıyaslayarak net kâr/zararını gösterir.',
    example: 'Örnek: "Gönyeli Konut Projesi" taranır; 30M TL gelire karşılık 24M TL harcandığı ve projenin %20 net kârla ilerlediği görülür.',
  },
  'report-journal-book': {
    title: 'Yevmiye Defteri Raporu',
    description: 'Yasal mevzuata uygun tarih ve yevmiye madde numarası sırasına dizilmiş resmi yevmiye defteri dökümüdür.',
    example: 'Örnek: Yeminli mali müşavir veya vergi denetiminde ilgili dönemin yevmiye defteri resmi formatta PDF olarak dışa aktarılır.',
  },
  'report-general-ledger': {
    title: 'Kebir (Büyük Defter)',
    description: 'Yevmiye kayıtlarının hesap bazında toplanarak her muhasebe hesabının borç ve alacak hareketlerini gösteren ana defterdir.',
    example: 'Örnek: Denetim uzmanı kasa veya banka hareketlerinin seyrini incelemek istediğinde 100/102 hesaplarının kebir sayfası sunulur.',
  },
  'report-sales': {
    title: 'Satış Raporu',
    description: 'Ürün, müşteri, bölge, şube ve dönem bazında satış cirolarını, miktarlarını ve iade oranlarını raporlar.',
    example: 'Örnek: Satış direktörü bu yıl en çok ciro getiren ilk 10 müşteriyi ve en çok satan ilk 5 ürün grubunu grafiklerle inceler.',
  },
  'report-purchases': {
    title: 'Alış Raporu',
    description: 'Tedarikçilerden yapılan satın almaların malzeme türü, birim fiyat seyri ve tedarikçi bazında dökümüdür.',
    example: 'Örnek: Son 6 ayda hazır beton alımlarının hangi tedarikçilerden ne ortalama birim fiyatla yapıldığı analiz edilir.',
  },
  'report-item-profit': {
    title: 'Stok Kârlılığı',
    description: 'Hangi ürünün satışından ne kadar brüt kâr elde edildiğini maliyet-satış fiyatı farkıyla kalem kalem analiz eder.',
    example: 'Örnek: Alçıpan satışının %30 kâr marjı bıraktığı, profil demir satışının ise %6 kâr bıraktığı görülerek fiyatlama güncellenir.',
  },
  'report-fx': {
    title: 'Kambiyo Raporu',
    description: 'Dövizli işlemlerden (USD, EUR, GBP) kaynaklanan kur farkı kâr ve zararlarını fatura ve cari bazında dökümler.',
    example: 'Örnek: Döviz kuru yükseldiğinde dövizli alacaklardan doğan kur farkı kârı hesaplanır ve muhasebeye otomatik kur farkı fişi işlenir.',
  },
  'executive-summary': {
    title: 'Yönetici Özeti',
    description: 'Şirket üst yönetimi için nakit durumu, ciro, kârlılık, stok değeri ve açık riskleri tek sayfalık özet kartta birleştirir.',
    example: 'Örnek: Şirket sahibi haftalık yönetim toplantısında tek sayfalık yönetici özetine bakarak şirketin finansal sağlığını kavrar.',
  },
  'report-fx-position': {
    title: 'Döviz Pozisyonu',
    description: 'Şirketin döviz varlıkları (banka, alacak) ile döviz borçlarını karşılaştırarak net döviz açığı/fazlası riskini raporlar.',
    example: 'Örnek: Şirketin 600.000 USD borcuna karşılık 150.000 USD varlığı olduğu ve 450.000 USD kur riski taşıdığı tespit edilir.',
  },
  consolidation: {
    title: 'Konsolidasyon',
    description: 'Holding veya grup bünyesindeki birden fazla şirketin hesaplarını tek bir konsolide mali tabloda birleştirir.',
    example: 'Örnek: Grup bünyesindeki inşaat şirketi ile ticaret şirketinin mali tabloları şirketler arası işlemler elenerek tek bilançoda toplanır.',
  },
  'data-export': {
    title: 'Veri Dışa Aktarma',
    description: 'Sistemdeki cari, fatura, stok, yevmiye ve personel verilerini Excel, CSV veya JSON olarak güvenli dışa aktarır.',
    example: 'Örnek: Dış denetim firmasına iletilmek üzere tüm cari borç/alacak listesi tek tıkla Excel formatında indirilir.',
  },
  'file-exchange': {
    title: 'İçe ve Dışa Aktarma',
    description: 'Excel şablonlarıyla topluca yüzlerce stok kartı, cari hesap veya açılış faturasını sisteme yüklemeyi sağlar.',
    example: 'Örnek: Tedarikçinin gönderdiği 3.000 kalemlik yeni fiyat listesi Excel şablonuyla sisteme 15 saniyede topluca aktarılır.',
  },
  'activity-report': {
    title: 'Faaliyet Raporu (Denetim İzi)',
    description: 'Kullanıcıların sistemdeki işlem kayıtlarını, silme/düzenleme hareketlerini ve oturum açma güvenliğini denetler.',
    example: 'Örnek: Silinen bir irsaliyenin hangi kullanıcı tarafından hangi gün ve saatte silindiği denetim günlüğünden anında bulunur.',
  },
  insights: {
    title: 'Rapor Panom (İçgörüler)',
    description: 'Kullanıcının kendi tercihine göre özelleştirdiği favori KPI kartları, trend grafikleri ve analitik panosudur.',
    example: 'Örnek: Finans müdürü kendi panosuna "Günlük Kasa", "Bu Ayki Tahsilat" ve "Kritik Stoklar" kartlarını ekleyip canlı takip eder.',
  },

  // ---- Ayarlar Grubu ----
  'portal-access': {
    title: 'Portal Erişimleri',
    description: 'Müşteri ve taşeronların kendilerine ait ekstre, fatura ve hakedişleri görmeleri için dış kullanıcı erişimlerini yönetir.',
    example: 'Örnek: Taşerona portal şifresi verilir; taşeron kendi ofisinden sisteme girip sadece kendi hakediş onay durumunu izler.',
  },
  'offline-drafts': {
    title: 'Çevrimdışı Depo ve Saha',
    description: 'İnternet bağlantısının olmadığı depolarda veya şantiyelerde işlem yapıp internet gelince buluta senkronize eder.',
    example: 'Örnek: Bodrum kattaki depoda internet çekmezken depo sorumlusu sayımı tamamlar; WiFi\'a bağlanınca kayıtlar sisteme akar.',
  },
  company: {
    title: 'Şirket Bilgileri',
    description: 'Şirketin resmi unvanı, vergi dairesi ve numarası, şirket logosu, resmi adresi ve defter para birimi ayarlarıdır.',
    example: 'Örnek: Faturalarda ve resmi tekliflerde çıkacak şirket logosu, banka hesap bilgileri ve resmi antet detayları buraya girilir.',
  },
  branches: {
    title: 'Şubeler ve Kapsam',
    description: 'Şirketin merkez ve şube yapılarını tanımlayarak kullanıcıların sadece kendi şube verilerine erişmesini sağlar.',
    example: 'Örnek: "Girne Şubesi" kasiyerinin "Lefkoşa Merkez" kasa ve fatura kayıtlarına erişimi sınırlandırılır.',
  },
  'document-approvals': {
    title: 'Belge Onayları (İş Akışı)',
    description: 'Fatura, hakediş ve satın alma emirlerinde tutar limitlerine göre hiyerarşik onay kuralları (Workflow) tanımlar.',
    example: 'Örnek: 100.000 TL altı alımlar proje müdürü onayıyla geçerken, 100.000 TL üzeri alımlar genel müdür onayına tabi tutulur.',
  },
  'platform-integrations': {
    title: 'API ve Bildirim Bağlantıları',
    description: 'Dış sistemlerin Ada ERP verisine güvenli erişmesi için API anahtarlarını ve olay bildirimlerini (webhook) yönetir.',
    example: 'Örnek: Raporlama aracına yalnız okuma yetkili bir API anahtarı verilir; yeni fatura kesildiğinde webhook ile dış sisteme bildirim gönderilir.',
  },
  'operations-settings': {
    title: 'İşletim ve Güvenlik',
    description: 'Şifre politikaları, iki adımlı doğrulama (2FA), oturum zaman aşımı ve IP kısıtlamalarını yönetir.',
    example: 'Örnek: Muhasebe personeli için sisteme girişte Google Authenticator 2FA zorunlu hale getirilir.',
  },
  backups: {
    title: 'Yedekleme',
    description: 'Veritabanı ve dosya arşivlerinin otomatik veya manuel tam yedeklerini alır ve geri yükleme imkanı sağlar.',
    example: 'Örnek: Her gece saat 03:00\'te otomatik şifreli veritabanı yedeği alınarak harici güvenli sunucuya arşivlenir.',
  },
  recurring: {
    title: 'Tekrarlayan İşler',
    description: 'Otomatik döviz kuru çekme, gecikmiş alacak taraması ve e-posta bildirim zamanlayıcılarının durumudur.',
    example: 'Örnek: Merkez Bankası\'ndan her iş günü saat 15:30\'da güncel kurları otomatik çeken zamanlanmış görev denetlenir.',
  },
  members: {
    title: 'Kullanıcılar',
    description: 'Sisteme giriş yapabilecek personellerin e-posta hesapları, şifreleri ve yetki rolleri (Yönetici, Satış, Muhasebe vb.) tanımlanır.',
    example: 'Örnek: Şirkete yeni başlayan satın alma personeline "procurement" rolü verilerek sisteme davet bağlantısı gönderilir.',
  },
  currencies: {
    title: 'Para Birimi ve Kurlar',
    description: 'Sistemde kullanılan TL, USD, EUR, GBP para birimleri ve günlük döviz alış/satış kurlarının tablosudur.',
    example: 'Örnek: Dövizli fatura kesilirken sistem otomatik olarak o günkü Merkez Bankası döviz satış kurunu faturaya işler.',
  },
  'tax-rates': {
    title: 'KDV Oranları',
    description: 'Ülke mevzuatına uygun standart (%20), indirimli (%10, %1) ve muafiyetli KDV oranlarının yönetimidir.',
    example: 'Örnek: İnşaat demirinde %20, temel gıda maddelerinde %1 KDV oranı seçilebilmesi için oran tabloları tanımlanır.',
  },
  periods: {
    title: 'Mali Dönemler',
    description: 'Şirketin mali yılları (2025, 2026 vb.) ve geçmiş ayların muhasebe kayıtlarına kilitlenmesidir.',
    example: 'Örnek: Geçmiş ay kilitlenir; böylece personeller sehven geçmiş aya fatura veya fiş girip beyannameyi bozamaz.',
  },
  modules: {
    title: 'Modüller',
    description: 'Şirketin faaliyet alanına göre kullanılan İK, Şantiye, Üretim veya Dış Ticaret gibi modüllerin açılıp kapatılmasıdır.',
    example: 'Örnek: Sadece toptan ticaret yapan şirkette şantiye modülleri kapatılarak menü karmaşası ortadan kaldırılır.',
  },
  license: {
    title: 'Lisans',
    description: 'Ada ERP lisans anahtarı, lisans süresi, aktif modüller ve lisanslı kullanıcı koltuk sayısının durumudur.',
    example: 'Örnek: Yıllık kurumsal lisansın kalan gün sayısı ve lisans geçerlilik sertifikası bu ekrandan kontrol edilir.',
  },
  devices: {
    title: 'Cihazlar',
    description: 'Şirket hesabına giriş yapılan tarayıcılar, ofis bilgisayarları ve mobil cihazların güvenlik listesidir.',
    example: 'Örnek: Şirket bilgisayarını kaybeden personelin cihaz erişim yetkisi tek tıkla iptal edilerek veri sızıntısı önlenir.',
  },
  'account-mapping': {
    title: 'Hesap Eşlemesi',
    description: 'Fatura, kasa, stok ve bordro işlemlerinin arka planda hangi Tekdüzen Muhasebe hesaplarına otomatik fiş atacağını belirler.',
    example: 'Örnek: "Kredi Kartı ile Tahsilat" yapıldığında otomatik olarak 108 Diğer Hazır Değerler hesabına fiş atılması kuralı bağlanır.',
  },
  'construction-settings': {
    title: 'İnşaat Ayarları',
    description: 'Hakediş kesinti oranları (teminat stopajı, avans mahsubu, KDV tevkifatı) ve varsayılan şantiye parametreleridir.',
    example: 'Örnek: Taşeron hakedişlerinde standart olarak uygulanacak %5 nakit teminat kesintisi varsayılan kural olarak atanır.',
  },
  'custom-codes': {
    title: 'Özel Kodlar',
    description: 'Cari, stok ve faturalara şirket içi özel raporlama için eklenen serbest etiket ve analitik grup kodlarıdır.',
    example: 'Örnek: Stok kartlarına "Proje-A-Özel" etiketi eklenerek projeye özel malzeme tüketim raporları alınır.',
  },

  // ---- Üretim & Entegrasyonlar ----
  'core.integrations': {
    title: 'Entegrasyonlar',
    description: 'Dış e-ticaret, pazar yeri, muhasebe veya lojistik servisleri ile veri aktarım kanallarını yönetir.',
    example: 'Örnek: B2B sipariş portalı veya e-ticaret sitesinden gelen siparişler Ada ERP satış siparişlerine otomatik akar.',
  },
  'manufacturing.promise': {
    title: 'Sipariş Taahhüdü',
    description: 'Gelen siparişlerin mevcut hammadde ve üretim kapasitesine göre ne zaman teslim edilebileceğini hesaplar.',
    example: 'Örnek: Müşteri 1.000 adet ürün istediğinde stok ve atölye doluluğuna bakılarak "18 iş günü sonra teslim" taahhüdü verilir.',
  },
  'manufacturing.shop-floor': {
    title: 'Atölye İş Ekranı',
    description: 'Üretim sahasındaki ustaların iş emirlerini gördüğü, başlattığı ve tamamladığı dokunmatik operasyon ekranıdır.',
    example: 'Örnek: Kesim tezgahındaki usta ekrandan sıradaki iş emrini seçer, "Başla" der ve bitirince üretilen miktarı onaylar.',
  },
  'manufacturing.exceptions': {
    title: 'Müdahale Bekleyen İşler',
    description: 'Hammadde gecikmesi, makine arızası veya kalite reddi nedeniyle duran acil üretim darboğazlarını listeler.',
    example: 'Örnek: Boya hattında hammadde bittiği için duran 3 iş emri kırmızı uyarıyla üretim şefinin önüne gelir.',
  },
  'manufacturing.supply': {
    title: 'Tedarik ve Stok Politikaları',
    description: 'Üretimde kullanılan kritik hammaddelerin emniyet stok seviyeleri ve sipariş verme periyotlarını düzenler.',
    example: 'Örnek: Ambalaj kutusu için 500 adet altına inildiğinde otomatik 2.000 adetlik tedarik siparişi açılması kuralı konur.',
  },
  'manufacturing.catalog': {
    title: 'Ürün ve Reçete Kataloğu',
    description: 'Üretilen mamullerin parça listeleri (BOM), operasyon adımları ve standart işçilik sürelerini tanımlar.',
    example: 'Örnek: Bir deri çantanın reçetesine 0.8 m² deri, 1 adet fermuar, 2 toka ve 45 dakika dikim işçiliği tanımlanır.',
  },
  'manufacturing.mrp': {
    title: 'Malzeme İhtiyaç Planlaması (MRP)',
    description: 'Kesinleşen üretim siparişleri için hangi hammadde ve yarı mamulden ne kadar gerektiğini hesaplar.',
    example: 'Örnek: 100 adet sandalye üretimi için depoda yeterli vida ve kumaş olmadığı tespit edilip satınalma listesi çıkarılır.',
  },
  'manufacturing.production': {
    title: 'Üretim Emirleri',
    description: 'Hammaddeyi mamule dönüştüren, işçilik ve elektrik giderlerini maliyete katan üretim iş emirleridir.',
    example: 'Örnek: 200 adetlik ayakkabı üretim emri açılır; hammadde depodan çıkar, bitince 200 adet mamul depoya girer.',
  },
  'manufacturing.planning': {
    title: 'Kapasite ve termin planlama',
    description: 'Planlar sekmesinde emirleri ve tarihi seçerek taslak hazırlayın, kontrol edip yayımlayın. Kapasite sekmesinde doluluğu, Takvim ve kaynaklar sekmesinde çalışma düzenini yönetin.',
    example: 'Örnek: İki üretim emrini yeni plana ekleyin, başlangıç tarihini seçin ve hesaplanan bitişleri kontrol edin. Yayımladığınızda işler kaynak takviminde yer ayırır.',
  },
  'manufacturing.quality': {
    title: 'Kalite Kontrol',
    description: 'Hammadde girişinde ve üretim çıkışında yapılan standart kontroller, tolerans testleri ve hurda/red kayıtlarıdır.',
    example: 'Örnek: Dokuma kumaş partisinden alınan numunede renk sapması tespit edilerek parti karantinaya alınır.',
  },
  'manufacturing.subcontracting': {
    title: 'Fason Üretim',
    description: 'Şirket dışındaki atölyelere gönderilen yarı mamullerin (kaplama, boya vb.) takibi ve fason fatura mutabakatıdır.',
    example: 'Örnek: 500 parça metal kumlama ve elektrostatik toz boya için dış atölyeye sevk edilir, bitince kaliteyle teslim alınır.',
  },
  'manufacturing.maintenance': {
    title: 'Bakım ve Onarım',
    description: 'Üretim makinelerinin periyodik yağlama, revizyon ve arıza bakım takvimlerini ve yedek parça sarfiyatını izler.',
    example: 'Örnek: Hidrolik presin 1.000 saatlik periyodik bakımı geldiğinde sistem bakım teknisyenine iş emri açar.',
  },
  'manufacturing.costs': {
    title: 'Maliyet Muhasebesi (Üretim)',
    description: 'Direkt hammadde, direkt işçilik ve genel üretim giderlerini (elektrik, amortisman) mamul birim maliyetine dağıtır.',
    example: 'Örnek: Üretilen bir birim ürünün net fabrika çıkış maliyeti 42.50 TL olarak hesaplanıp satış kâr marjı belirlenir.',
  },
  'inventory.wms': {
    title: 'Depo Yönetim Sistemi (WMS)',
    description: 'Depo raf adresleme, barkodlu toplama (picking), palet barkodu ve depo içi yerleşim optimizasyonudur.',
    example: 'Örnek: Depo görevlisi el terminalinden "A-12-3 rafındaki üründen 10 koli al" komutunu görerek hatasız toplama yapar.',
  },
  'sales.logistics': {
    title: 'Lojistik ve Sevkiyat',
    description: 'Kamyon/tır yükleme planları, sevk rotaları, araç dolulukları ve müşteri teslimat çizelgelerini yönetir.',
    example: 'Örnek: Yarın Lefkoşa bölgesine gidecek 8 müşterinin siparişleri tek kamyona optimize edilerek sevk listesi basılır.',
  },

  // ---- Deri, POS ve satın alma raporları ----
  'leather-center': {
    title: 'Deri İş Merkezi',
    description: 'Deri üretiminin günlük özetidir: açık kesim emirleri, fasondaki işler, kalite bekleyen partiler ve gecikme riskleri tek ekranda toplanır.',
    example: 'Örnek: Atölye sorumlusu sabah ekrana bakar; fasondan dönmesi geciken 2 iş emrini ve kalite onayı bekleyen 1 deri partisini görüp önceliklendirir.',
  },
  'leather-models': {
    title: 'Modeller ve Koleksiyonlar',
    description: 'Çanta, cüzdan, kemer gibi modellerin reçetesini (deri, astar, aksesuar), varyantlarını ve sezon koleksiyonlarını tanımlar.',
    example: 'Örnek: Yeni sezon için "Kroko Omuz Çantası" modeli 3 renk varyantıyla açılır; her varyant için deri ve aksesuar sarfiyatı reçeteye yazılır.',
  },
  'leather-materials': {
    title: 'Deri Parti ve Parçalar',
    description: 'Gelen ham deri partilerini, desimetrekare ölçülerini, kalite sınıflarını ve kesimden artan parçaları izlenebilir şekilde stoklar.',
    example: 'Örnek: Tedarikçiden gelen 120 dm² dana derisi partisi A/B kalite olarak ayrılır; kesimden kalan büyük parçalar küçük ürünlerde kullanılmak üzere ayrılır.',
  },
  'leather-production': {
    title: 'Kesim ve Üretim',
    description: 'Kesim planlarını, iş emirlerini, operasyon adımlarını ve fire oranlarını yönetir; hangi partiden hangi ürünün kesildiği kayıt altına alınır.',
    example: 'Örnek: 200 adetlik cüzdan emri için kesim planı hazırlanır; gerçek fire %8 çıkınca maliyet ve sonraki planlar buna göre güncellenir.',
  },
  'leather-subcontracts': {
    title: 'Fason Operasyonlar',
    description: 'Dikiş, boya, baskı gibi dış atölyeye verilen işlerin gönderim, teslim alma, miktar farkı ve fason bedelini takip eder.',
    example: 'Örnek: 300 adet kesilmiş parça dikim için fasoncuya gönderilir; 296 adet döner, 4 adet fark ve fason faturası aynı kayıtta eşleştirilir.',
  },
  'leather-quality': {
    title: 'Kalite ve İzlenebilirlik',
    description: 'Parti ve ürün bazında kalite kontrol sonuçlarını, hata türlerini ve satılan bir ürünün hangi deri partisinden geldiğini izler.',
    example: 'Örnek: Müşteriden renk atması şikâyeti gelir; ürünün seri numarasından deri partisi bulunur ve aynı partiden üretilen diğer ürünler kontrole alınır.',
  },
  'leather-service': {
    title: 'Garanti ve Onarım',
    description: 'Satış sonrası garanti başvurularını, onarım iş emirlerini, kullanılan malzemeyi ve müşteriye teslim durumunu yönetir.',
    example: 'Örnek: Fermuarı bozulan çanta garanti kapsamında kabul edilir; onarım emri açılır, değişen fermuar stoktan düşer ve teslimde müşteriye bilgi verilir.',
  },
  'sales-pos': {
    title: 'Mağaza Kasası (POS)',
    description: 'Perakende satışların barkodla hızlıca yapıldığı kasa ekranıdır; nakit/kart tahsilatı, iade ve gün sonu kasa kapanışı buradan yürür.',
    example: 'Örnek: Kasiyer ürünleri barkodla okutur, müşteri kısmen nakit kısmen kartla öder; gün sonunda kasa sayımı ile sistem toplamı karşılaştırılır.',
  },
  'supplier-performance': {
    title: 'Tedarikçi Performansı',
    description: 'Tedarikçilerin zamanında teslim oranını, fiyat değişimini ve miktar sapmalarını ölçerek hangi tedarikçiyle çalışmaya devam edileceğine yardımcı olur.',
    example: 'Örnek: Son 6 ayda siparişlerinin %30\'unu geç teslim eden tedarikçi listenin altına düşer; yeni teklif toplamada alternatif tedarikçiler öne alınır.',
  },
  replenishment: {
    title: 'Stok Tamamlama Önerileri',
    description: 'Minimum stok, açık siparişler ve tüketim hızına göre hangi malzemenin ne kadar sipariş edilmesi gerektiğini önerir; öneriden talep oluşturulur.',
    example: 'Örnek: Kritik seviyenin altına düşen 6 malzeme listelenir; satın alma uzmanı önerilen miktarları kontrol edip satın alma talebine çevirir.',
  },

  // ---- Detay ve editör ekranları (menüde yok; route deseniyle eşlenir) ----
  'party-detail': {
    title: 'Cari Kartı',
    description: 'Bir müşteri veya tedarikçinin bakiyesini, ekstresini, açık belgelerini, iletişim bilgilerini ve geçmiş hareketlerini tek yerde gösterir.',
    example: 'Örnek: Müşteri aradığında cari kartı açılır; vadesi geçen 2 fatura, son tahsilat tarihi ve kalan bakiye görüşme sırasında önünüzdedir.',
  },
  'invoice-editor': {
    title: 'Fatura Düzenleme',
    description: 'Fatura satırlarını, KDV/tevkifat ve iskontoları girip taslak olarak saklar; kesinleştirildiğinde cari, stok ve muhasebe kayıtları oluşur.',
    example: 'Örnek: Taslak fatura hazırlanıp onaya gönderilir; onaylandıktan sonra kesinleştirilir ve yazdırma/paylaşma açılır. PDF çıktısı resmî e-Fatura gönderimi değildir.',
  },
  'delivery-note-editor': {
    title: 'İrsaliye Düzenleme',
    description: 'Sevk veya kabul edilen malların miktarını, deposunu ve teslim bilgisini kaydeder; irsaliye daha sonra faturaya bağlanabilir.',
    example: 'Örnek: Şantiyeye 40 torba çimento sevk edilir; irsaliye kesinleşince stok düşer ve ay sonunda toplu faturalamada listelenir.',
  },
  'sales-doc': {
    title: 'Teklif / Sipariş',
    description: 'Müşteriye verilen teklifi veya alınan siparişi satır, fiyat ve teslim tarihiyle tutar; kabul edilen teklif siparişe, sipariş faturaya dönüştürülür.',
    example: 'Örnek: Müşteriye 3 kalem ürün için teklif hazırlanır; müşteri kabul edince siparişe, sevkten sonra faturaya çevrilir.',
  },
  'price-list-detail': {
    title: 'Fiyat Listesi Ayrıntısı',
    description: 'Listedeki ürün fiyatlarını, geçerlilik tarihlerini ve para birimini düzenler; satış belgelerinde bu liste fiyat kaynağı olur.',
    example: 'Örnek: Bayi fiyat listesinde 50 ürünün fiyatı güncellenir ve yeni fiyatlar ayın 1\'inden geçerli olacak şekilde kaydedilir.',
  },
  'item-detail': {
    title: 'Stok Kartı Ayrıntısı',
    description: 'Ürünün depo bazlı miktarını, hareket geçmişini, maliyetini, fiyatlarını ve bağlı belgelerini gösterir.',
    example: 'Örnek: Bir üründe stok farkı şüphesi olduğunda kartın hareket geçmişinden son giriş/çıkışlar ve sayım düzeltmeleri incelenir.',
  },
  'count-editor': {
    title: 'Sayım Fişi',
    description: 'Fiziki sayım sonuçlarının girildiği fiştir; sistem miktarıyla fark hesaplanır ve onaylanınca fark kadar stok düzeltmesi oluşur.',
    example: 'Örnek: Ana depoda 120 kalem sayılır; 4 kalemde fark çıkar, sorumlu onayıyla sayım farkı stok hareketi olarak işlenir.',
  },
  'purchase-request-editor': {
    title: 'Satın Alma Talebi',
    description: 'İhtiyaç duyulan malzeme veya hizmetin miktar, tarih ve gerekçesiyle kaydedildiği taleptir; onaydan sonra teklif veya siparişe dönüşür.',
    example: 'Örnek: Saha şefi 2 ton demir talep eder; talep onaylanınca satın alma ekibi 3 tedarikçiden teklif ister.',
  },
  'rfq-detail': {
    title: 'Teklif Karşılaştırma',
    description: 'Aynı talep için tedarikçilerden gelen fiyat, vade ve teslim sürelerini yan yana karşılaştırır; kazanan teklif siparişe dönüştürülür.',
    example: 'Örnek: 3 tedarikçinin fiyatı ve teslim süresi karşılaştırılır; en uygun toplam maliyetli teklif seçilip sipariş açılır.',
  },
  'purchase-order-editor': {
    title: 'Satın Alma Siparişi',
    description: 'Tedarikçiye verilen siparişin satırlarını, fiyatlarını ve teslim planını tutar; teslim alınan miktar ve faturayla eşleştirilir.',
    example: 'Örnek: 500 adet malzeme siparişi verilir; iki parti halinde teslim alınır ve fatura geldiğinde sipariş-irsaliye-fatura eşleşmesi kontrol edilir.',
  },
  'project-detail': {
    title: 'Proje Ayrıntısı',
    description: 'Projenin bütçesini, iş kırılımını, maliyet ve gelir hareketlerini, işveren hakedişlerini ve kârlılığını sekmeler halinde gösterir.',
    example: 'Örnek: Proje müdürü bütçe sekmesinde betonarme kaleminin %12 aştığını görür ve değişiklik emri sürecini başlatır.',
  },
  'sales-contract-detail': {
    title: 'Satış Sözleşmesi',
    description: 'Gayrimenkul biriminin satış sözleşmesini, ödeme planını, taksitlerini ve tahsilat durumunu yönetir.',
    example: 'Örnek: Daire satışı 24 taksitle yapılır; vadesi geçen taksit sözleşme ekranında öne çıkar ve tahsilat kaydı buradan girilir.',
  },
  'subcontract-detail': {
    title: 'Taşeron Sözleşmesi',
    description: 'Taşeronla yapılan sözleşmenin kalemlerini, birim fiyatlarını, avans ve teminat kesintilerini ve hakediş geçmişini gösterir.',
    example: 'Örnek: Kaba inşaat taşeronunun sözleşme bedeli, ödenen hakedişler ve kalan iş miktarı tek ekranda izlenir.',
  },
  'progress-editor': {
    title: 'Hakediş Düzenleme',
    description: 'Dönem içinde yapılan imalat miktarlarının girildiği hakediştir; kümülatif miktar, kesintiler ve net ödenecek tutar hesaplanır.',
    example: 'Örnek: Ay sonunda taşeronun yaptığı 320 m² sıva girilir; avans mahsubu ve teminat kesintisi düşülerek net hakediş onaya gönderilir.',
  },
  'variation-detail': {
    title: 'Değişiklik Emri',
    description: 'Sözleşme dışı ek iş veya miktar değişikliğinin gerekçesini, fiyatını ve onay durumunu kaydeder; onaylanınca sözleşme bedeline eklenir.',
    example: 'Örnek: İşveren ek bir bodrum katı ister; değişiklik emri fiyatlandırılıp onaylanır ve sonraki hakedişlerde kullanılabilir hale gelir.',
  },
  'treasury-account-detail': {
    title: 'Kasa / Banka Hesabı',
    description: 'Seçili kasa veya banka hesabının bakiyesini, hareketlerini ve mutabakat durumunu gösterir.',
    example: 'Örnek: Banka ekstresi içe aktarılır; sistemdeki hareketlerle eşleşmeyen 2 kayıt işaretlenip açıklaması bulunur.',
  },
  'employee-detail': {
    title: 'Personel Kartı',
    description: 'Çalışanın özlük bilgilerini, ücretini, izinlerini, puantajını ve belgelerini tutar; bordro bu karttaki bilgilere göre hesaplanır.',
    example: 'Örnek: Personelin maaş artışı yeni geçerlilik tarihiyle karta girilir; sonraki bordro yeni ücretle hesaplanır.',
  },
  'employee-statement': {
    title: 'Personel Cari Ekstresi',
    description: 'Çalışana verilen avansları, maaş ödemelerini ve kesintileri tarih sırasıyla gösterir; kalan avans bakiyesi buradan izlenir.',
    example: 'Örnek: Personele verilen 10.000 TL avansın 3 ay boyunca maaştan nasıl mahsup edildiği ekstrede görülür.',
  },
  'payroll-run': {
    title: 'Bordro Dönemi',
    description: 'Seçilen ayın tüm çalışanları için brüt-net hesabını, vergi ve SGK kesintilerini ve işveren maliyetini gösterir; onaylanınca muhasebeye işlenir.',
    example: 'Örnek: Ekim bordrosu hesaplanır, fazla mesailer kontrol edilir, onaylanır ve banka maaş listesi hazırlanır.',
  },
  'payroll-slip': {
    title: 'Ücret Pusulası',
    description: 'Tek bir çalışanın o aya ait kazanç, kesinti ve net ödeme ayrıntısını gösteren, yazdırılabilir bordro pusulasıdır.',
    example: 'Örnek: Çalışan net maaşını sorduğunda pusula açılır; brütten vergi ve SGK kesintilerine kadar her kalem tek tek gösterilir.',
  },
  'social-declaration': {
    title: 'SGK Bildirgesi',
    description: 'Seçili ayın sigortalı listesini, prim gün sayılarını, prime esas kazançları ve işçi/işveren prim tutarlarını gösterir.',
    example: 'Örnek: Ay sonunda bildirge kontrol edilir; eksik gün nedeni girilmemiş çalışan düzeltilir ve bildirge hazır olarak işaretlenir.',
  },

  // ---- Birleşik merkez sayfalar ----
  'hr-settings': {
    title: 'İK ve Bordro Ayarları',
    description: 'Bordro parametreleri, SGK prim oranları ve yabancı işçi belge kuralları tek ekranda sekmeler halinde toplanır. Tarihli parametreler yalnız doğrulandıktan sonra kullanılır.',
    example: 'Örnek: Yeni yılın vergi dilimleri "Bordro" sekmesine geçerlilik tarihiyle girilir; SGK tavanı "SGK" sekmesinde güncellenir.',
  },
  'cash-planning': {
    title: 'Nakit Planlama',
    description: 'Vadeli alacak, borç, çek ve taksitlerden üretilen nakit projeksiyonunu ve "ya şöyle olursa" senaryolarını aynı yerde gösterir.',
    example: 'Örnek: Projeksiyon 6 hafta sonra nakit açığı gösterir; senaryo sekmesinde büyük bir tahsilatın 30 gün gecikmesi denenerek risk ölçülür.',
  },
  'data-transfer': {
    title: 'Veri Aktarımı',
    description: 'Excel/CSV ile toplu veri içe aktarma ve kayıtları dışa aktarma işlemleri tek merkezde toplanır.',
    example: 'Örnek: Eski programdan alınan 800 cari Excel ile içe aktarılır; ay sonunda fatura listesi muhasebeciye CSV olarak dışa aktarılır.',
  },
  integrations: {
    title: 'Entegrasyonlar',
    description: 'Pazaryeri/kanal bağlantıları ile API anahtarları ve webhook tanımları aynı ekranda sekmeler halinde yönetilir.',
    example: 'Örnek: E-ticaret kanalı bağlanıp sipariş aktarımı açılır; muhasebe yazılımı için ayrı bir API anahtarı ve webhook adresi tanımlanır.',
  },
};

// Genel (inşaat dışı) satın alma menüsü, inşaat ikizleriyle aynı ekranı açar.
for (const [alias, source] of [
  ['general-purchase-requests', 'purchase-requests'],
  ['general-rfqs', 'rfqs'],
  ['general-purchase-orders', 'purchase-orders'],
  ['general-order-matching', 'order-matching'],
] as const) {
  NAV_ITEM_HELP[alias] = NAV_ITEM_HELP[source]!;
}
