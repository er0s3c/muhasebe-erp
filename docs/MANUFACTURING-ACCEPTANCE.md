# Üretim ERP/MES ekleri — uygulama ve kabul kaydı

8 Ekim 2026. Önce [kod karşılaştırması](MANUFACTURING-GAP-REVIEW.md) ve [uygulama planı](MANUFACTURING-IMPLEMENTATION-PLAN.md) hazırlandı; ardından mevcut üretim, stok ve muhasebe servisleri genişletildi. Bu kayıt yerel çalışma ağacına aittir. Uzak sunucu dağıtımı veya canlı mağaza kabulü değildir.

## 29 maddeye karşılık gelen davranış

| # | Alan | Uygulanan davranış / sınır |
|---|---|---|
| 1 | ATP/CTP | Onaylı siparişin açık miktarı, serbest stok, tahsis, bağlı açık üretim ve yeni ihtiyaç birlikte gösterilir. Tedarik/uygun kaynak/yayımlanmış plan/kalite verisi yetersizse tarih boş ve nedeni açıklamalıdır. Bağlı üretimde açık yeniden işleme de termin önerisini engeller; tekrar kalite onayıyla kapanınca bu neden kalkar. CTP bir öneridir. |
| 2 | Tahsis | Kalıcı satış satırı/depo tahsisi, öncelik ve neden; kısmi sevkiyat tüketimi ve iptalde kalan tahsisin bırakılması. Şirket kilidi eşzamanlı tahsisi sıraya koyar. |
| 3 | MRP–satın alma | Mevcut çok seviyeli reçete ve talep/RFQ/teklif/sipariş/kabul zinciri korunur; tarihli açık satın alma arzı, öneri ve minimum stok politikası eklenir. |
| 4 | Tedarikçi | Malzeme bazında ürün kodu, fiyat/para birimi, MOQ, paket katı, termin ve tercih; gerçek kabul geçmişinden örnek sayısı/ortalama süre/fiyat. Sıralama tercih ve tanımlı terminle yapılır; eksik geçmiş başarı oranı olarak sunulmaz. |
| 5 | Yaşam döngüsü | Mali belge durumundan ayrı yürütme aşamaları ve geçiş kontrolleri. Açık çalışma, kalite, rework, fason, WIP veya kullanılmamış teslim varken maliyet kapanışı engellenir. |
| 6 | Malzeme mutabakatı | Aynı depo içinde atölyeye teslim, kullanılmadan iade, gerçek sarf ve kaynak sarfa iade ayrı izlenir. Teslim ikinci stok hareketi/değer yaratmaz; sarf FIFO teslim payını tüketir. Normal fire WIP, onaylı anormal kayıp ayrı kayıttır. |
| 7 | WIP | Mevcut hammadde → WIP → mamul → sevk/satış maliyet akışı yeniden kullanılır. Lot bağımsız maliyet havuzu değildir. |
| 8 | Kuyruk | Transferde kabul edilmiş/yoldaki miktar, gönderim–kabul beklemesi ve kabul–ilk MES başlangıcı ayrı gösterilir. Kısmi kabul FIFO miktar ağırlığıyla ölçülür. MES kanıtı olmayan miktarın süresi boş kalır. |
| 9 | Darboğaz | Vardiya birleşiminden bakım/devamsızlık/tatil düşülerek net kapasite; yayımlanmış yük, oran, aşım ve kaynak sıralaması. |
| 10 | Alternatif kaynak | Onaylı operasyonda uygun kaynak, süre/hız ve öncelik; emir kopyası sabittir. Canlı iş başlangıcında kaynak aktifliği, vardiya, arıza, kapasite ve operatör kontrol edilir. |
| 11 | Takvim | Tekrar eden hafta günleri/vardiya şablonu, tatil istisnaları; mevcut fazla mesai, bakım ve devamsızlık blokeleri kullanılır. |
| 12 | Batch | Emir içinde hedef adetle bölme; sarf, operasyon, süre, kalite, rework ve kısmi mamul lotu bağlantısı. Batch toplamı emir miktarını aşamaz. |
| 13 | Fiziksel deri | m² alan ve ana/kalan parça izi korunur; normalize dış sınır, kusur bölgeleri ve damar açısı eklenir. Bu kayıt ölçüm cihazı entegrasyonu değildir. |
| 14 | Kesim planı | Kalıp/model revizyonu, seçilmiş parça anlık görüntüsü, set, gerekli alan/verim ve gerçek kesim izi. Damar şartı doğrulanır; aktif planın parçası başka sarfta kullanılamaz. Tek plan iptali gerçek kesim belgelerini korur. Otomatik yerleşim kapsam dışıdır. |
| 15 | Rework | Onaylı kaynak kalite kontrolü, hata kodu, kaynak/hedef operasyon, batch, süre, sonuç ve tekrar kalite. Ret sonrası yeni deneme; iyi adet yalnız tekrar kalite onayıyla bir kez geri taşınır. |
| 16 | Fason | Mevcut şirket mülkiyetindeki dış depo/emanet, kısmi dönüş, fire, kalite ve hizmet maliyeti servisleri kullanılır. Malzeme gönderimi satış değildir. |
| 17 | Mal kabul kalitesi | Üretim hammaddeleri pozitif kabul satırı bazında karantinaya alınır. Aynı SKU'nun farklı satırları korunur; fiziksel deriyle ortak kabul blokesi iki kez düşülmez. |
| 18 | Stok statüleri | Ortak fiziksel − kalite − üretim rezervasyonu − satış tahsisi hesabı; lot kısmi serbest/hasarlı/blokeli miktarları, transfer/fason/WIP ayrı sahiplik ve konum kayıtları. |
| 19 | Entegrasyon güvenilirliği | Shopify ham gövde HMAC, konu/mağaza doğrulaması, lisans/üyelik sınırı; olay kimliği/sürüm/yük özeti, backoff, hız sınırı, beş denemede dead-letter ve nedenli manuel tekrar. Yeni dış sipariş sürümü inceleme bekler; kayıtlı mali belge kendiliğinden değiştirilmez. |
| 20 | Stok sahipliği | Ada serbest stok kaynağıdır. Kanal SKU/lokasyon eşlemesi ve stok değişim outbox'ı; Shopify/Ticimax adaptörleri. **Kullanıcı kararı: dış stok gönderimi yalnız elle başlatılır.** Otomatik gönderim işçisi yoktur; demo dış çağrıları reddeder. |
| 21 | Satış iadesi | Kaynak lot ve düzeltilmiş maliyet izi geri taşınır; gelen ürün ayrı karantina lotuyla kalite bekler. Satış iptali kaynak kalite durumunu korur. |
| 22 | Servis | Mevcut satış/seri, müşteri onayı, parça maliyeti ve teslim akışına teknisyen/süre eklenir. Saat ücretinden hesaplanan değer tahmindir; müşteri tamir ürünü şirket stok varlığı olmaz. |
| 23 | Maliyet kapanışı | Açık WIP/kalite/fason/rework/teslim kontrolleri; gerçekleşen malzeme değişmez pay izinin düzeltilmiş kök değerlerinden, diğer kaynaklar mevcut tekil tahsislerden okunur. Emir kuruluşundaki standart malzeme değeriyle sapma gösterilir; eski emirde güncel ortalama kullanıldığı belirtilir. |
| 24 | Revizyon | Mevcut onaylı reçete/rota kopyası ve kilitler korunur; uygun kaynak bilgisi de emir kopyasına girer. |
| 25 | Plan sürümü | Taslak değişikliği yeni parent/sürüm oluşturur, önceki kayıt saklanır; neden, termin farkı ve bağlı sürüm ağacı. Yayımlanmış plan düzenlenmez; yayımlama güncel çakışmaları tekrar denetler. |
| 26 | What-if | Gerçek takvimi değiştirmeden sanal takvim/kapasite/hız/saat ücreti; yük ve termin karşılaştırması. Maliyet yalnız fiyatı tanımlı kaynakların tahminidir, ürünün tam gerçek maliyeti değildir. Varsayımlı plan doğrudan yayımlanamaz. |
| 27 | Shop floor | Atanmış iş koduyla bulma, başlat/duraklat/tamamla, kaynak/batch ve iyi/fire/rework. Duraklama çalışma süresine eklenmez; yeniden başlatma kuyruk ölçümünde ilk başlangıç izini korur. |
| 28 | Müdahale | Gecikme, malzeme, kapasite, arıza, kalite, fason, transfer kaynaklarına bağlı liste; sorumlu/öncelik/neden, çözüm ve yeniden açma. |
| 29 | Değişmezlik | Mevcut stok/maliyet/üretim belgeleri korunur; yeni komut olayları DB tetikleyicisiyle UPDATE/DELETE'e kapalıdır. Durum kayıtları auditlenir; requestKey + içerik özeti tekrar ve farklı içerik denetler. |

## Yerel doğrulama

- Ortak paket: 748 test geçti; kısmi kabul kuyruğu, kapasite ve tahmin sınırları dahil.
- API tam regresyonu: 100 dosyada 965 test geçti; 31 test atlandı. Bunların biri ayrı etkinleştirilen gerçek yedek testi, kalanları ortamda bulunmayan kurulum araçlarına bağlı kontrollerdir. Dosyalar bir işçiyle çalışır; eşzamanlı komut testleri kendi dosyalarında paralel istekleri sınar.
- Son yeniden işleme/termin düzeltmesinden sonra üretim yürütme ve iş akışı dosyalarının 22 testi yeniden geçti. Açık rework nedeni ve tekrar kalite onayından sonra nedenin kaldırılması gerçek API akışında doğrulandı.
- Web: 11 test; lisans ortak paketi: 38 test geçti.
- Tarayıcı: beş senaryo aynı son çalışmada geçti (demo şirketi, dokuz profil/API izinleri, katalog, deri/POS, ATP/yürütme ekranları). Yeni ekranda gerçek taahhüt hesabı, açık üretim ve eksik plan nedeni; alt ekran bölümleri masaüstü/mobil kaydırılarak kontrol edildi.
- Demo v5: mevcut demo üstüne kurulup ikinci yüklemede `changed=false`; kullanıcı şifreleri, kayıt sayıları ve stok miktar/değerleri korundu. İnşaat şirketi korunur.
- Gerçek yedek testi ayrıca etkinleştirildi ve geçti: pg_dump → imzalı paket → ayrı kurtarma veritabanına pg_restore; ek dosya, üretim makinesi, yeni tahsis tablosu ve değişmez komut olayının UPDATE engeli korundu. Bozuk paket ve farklı kuruluş erişimi reddedildi. Demo veritabanının üzerine geri yükleme yapılmadı.
- Tüm çalışma alanında typecheck, lint ve build geçti; son termin düzeltmesi için API typecheck/build ve lint tekrar geçti. 0111–0113 migration'ları ve migration kilit dosyası doğrulandı; geliştirme veritabanı sıfırlanmadı.
- İlk tam deneme PostgreSQL bağlantı/kilit sınırına, sonraki deneme test izolasyonu ve birkaç doğrulama hatasına takıldı; bu denemeler başarı olarak sayılmaz. Yukarıdaki sayılar düzeltmeler sonrası başarılı çalışmalardır.

## Kabul sınırları

Canlı Shopify/Ticimax erişim bilgisi veya ödeme/kesim makinesi bağlantısı kullanılmadı. Ağ adaptörleri kontrollü HTTP cevaplarıyla sınandı; gerçek mağazanın yetkisi, SKU/lokasyonu ve servis sürümü kurulumda doğrulanmalıdır. Banka/PDKS/e-belge için mevcut dosya/API sözleşmesi kullanılır. Uzak lisans/ERP dağıtımı bu yerel kabulden ayrıdır.

Standart–gerçekleşen raporu standart **malzeme** değerini ayrı verir. What-if saat maliyeti ve servis saat maliyeti muhasebeye gerçekleşen gider diye yazılmaz; gerçek işçilik/fason/gider mevcut bordro/fatura/gider kaynağıyla tahsis edilir. Veri olmayan eski kayıt için gerçek süre veya başarı göstergesi üretilmez.
