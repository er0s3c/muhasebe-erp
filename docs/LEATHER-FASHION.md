# Deri aksesuar ve moda

Sektör kodu `LEATHER_FASHION`. Paket satın alınmış tabaklanmış deriyle cüzdan, çanta, valiz, kemer ve aksesuar üretimini; kendi atölyesini, fasonu, toptan/mağaza satışını, kişiselleştirmeyi ve kendi satılan ürünlerine servisi kapsar. E-ticaret, tabakhane işletmesi, otomatik kalıp yerleşimi, kesim makinesi, ödeme cihazı ve çevrimdışı mali işlem entegrasyonu kapsam dışıdır.

## Kurulum ve dağıtım

1. Veritabanı ve belge arşivinin yedeğini alın. Mevcut şirketlerin sektörünü değiştirmeyin.
2. Önce lisans sunucusu/panelini ve kendi migration'larını güncelleyin. Yeni sektör lisansını yalnız sektör yeteneğini bildiren güncel ERP kurulumunda etkinleştirin.
3. ERP migration'larını `npm run db:migrate` ile uygulayın. Yayımlanmış migration dosyaları değiştirilmez; yeni tablolar mevcut yedekleme/geri yükleme akışına dahildir.
4. Yeni şirket açarken **Deri aksesuar ve moda** seçin. Çekirdek muhasebe, cari, stok, finans, insan kaynakları ve satın alma ekranları kullanılır. İnşaat şirketlerinin proje/WBS satın alma kuralları devam eder.
5. Hesap eşlemelerini kontrol edin: hammadde 150, yarı mamul 151, mamul 152, üretim WIP 151, üretilen ürün maliyeti 620 ve faturasız kabul tahakkuku 381 başlangıç eşlemeleridir. Şirket hesap planına göre ayrı alt hesaplarla değiştirilebilir.
6. Kullanıcılara mevcut modül erişim ekranından tasarım, depo, atölye, kalite, kasiyer veya servis profili uygulayın. Onay ve maliyet yetkileri role bağlıdır. Operatörü iş rotasına; kasiyeri kasaya atayın.

## Günlük kullanım

### Model, reçete ve numune

`/leather/models` üzerinden model, ürün ailesi ve koleksiyon bilgilerini; reçete malzemelerini, operasyon rotasını ve numune sonucunu kaydedin. Çizim, kalıp ve kontrol dosyalarını belge arşivine ekleyin. Numune kabulünden sonra revizyon onaylanır. Onaylı revizyon değiştirilemez; değişiklik yeni revizyondur. Her satılabilir renk/ölçü/metal rengi varyantını ayrı **mamul** stok kartı ve barkoduyla bağlayın. Müşterinin adı ayrı SKU oluşturmaz.

### Malzeme kabulü ve kesim

Deri kartı **hammadde**, ana birimi **m²** olmalıdır. dm² ve ft² ölçüleri sabit alan dönüşümüyle m²'ye çevrilir; adet ile alan arasında sabit dönüşüm kurulmaz. `/leather/materials` ekranında tedarikçi, tabaklama, ülke, parti, renk/ton, kalınlık, kusur ve fiziksel parça barkodlarını kaydedin. Fatura beklemeden pozitif geçici maliyetle kabul yapılabilir; mal kabulü stok girişi ve tahakkuk üretir. Parçalar kalite kabulüne kadar karantinadadır.

Kesim, üretim emri ve fiziksel parçaya bağlanır. Kullanılan alan + fire + yeni kalan parçaların alanı başlangıç alanına eşit olmalıdır. Kalan parçalar ana parçaya bağlı yeni kimlik alır; yeni stok değeri yaratılmaz. İzlenen deri çıkışlarını kesim/üretim/fason komutlarıyla yapın; genel stok ekranından fiziksel parça kaydını atlayarak tüketmeyin.

### Üretim, fason ve kalite

`/leather/production` ekranında onaylı varyant/revizyonla stok veya sipariş için emir açın. İhtiyaçlar reçeteden hesaplanır; stok, kalite blokesi ve rezervasyon dikkate alınır. Emir serbest bırakıldığında malzeme ayrılır. Atölye operasyonlarında sorumlu, süre, iyi adet ve işlem sonucu kaydedilir. Sarf hammadde değerini WIP'ye taşır; onaylı son kalite kontrolüyle kısmi mamul kabulü WIP'yi mamule taşır.

`/leather/subcontracts` fason işini, gönderilen şirkete ait malzemeyi, dış atölye deposunu ve kısmi teslimi izler. Gönderim satış değildir. Tüketim ve kayıp sonrasında kalite kararı ve hizmet faturası ilişkilendirilir. `/leather/quality` deri, ara işlem ve mamul uygunsuzluklarını yeniden işleme, ikinci kalite, iade veya hurda kararıyla izler.

### Maliyet

SKU bazlı şirket genelinde hareketli ağırlıklı ortalama devam eder. Fiziksel parti/parça ayrı bir maliyet havuzu değildir. Her kaynak için pay izi tutulur; sarf, kısmi kabul, sevk, satış ve iadelerde paylar ilerler. İşçilik, fason ve genel giderler yalnız kayıtlı kaynak yevmiye satırından, kullanılmamış tutarı aşmadan tahsis edilir.

Geç alış fiyatı ve ithalat/gider farkları güncel hammadde, WIP, mamul, faturalanmamış sevk, satılmış ürün ve kayıp paylarına dağıtılır. Örneğin 1.000 TL farkın %20/%30/%25/%25 payı sırasıyla 200/300/250/250 TL'dir. Geç fark veya iptal geçmiş kapalı dönemleri değiştirmez; açık dönemde yeni belge üretir. Satış iadesi düzeltilmiş maliyeti ve payı geri taşır. Kur farkları çekirdek kambiyo akışından yürür.

### Özel sipariş, mağaza ve servis

`/leather/custom-orders` özel ölçü/renk/monogram, müşteri onayı, fiyat ve termini mevcut satış siparişine bağlar. Kapora, çekirdek cari/tahsilat kayıtlarından siparişe bağlanır; faturada kapatma/mahsup akışı kullanılır.

`/pos/settings` ekranında mağaza deposu, nakit kasa, kart banka hesabı ve kasiyer atamasını tanımlayın. `/pos` üzerinde açılış sayımını girerek vardiya açın, barkodla veya ürün aramasıyla satış yapın. Nakit ve kart toplamı KDV dahil satış toplamına eşit olmalıdır. Satış, fatura ve tahsilat aynı transaction'dadır. Tek işlem kimliğiyle tekrar gönderim yeni satış üretmez. Fiyat/iskonto istisnası ve iade ayrı izin gerektirir. İade ilk satış satırı ve kalan miktarla sınırlıdır; değişim iade ve yeni satış kayıtlarıyla izlenir. Kapanışta sayılan nakit beklenen nakitle karşılaştırılır; fark için gerekçe zorunludur. Satış belgesi `/pos/sales/:id` üzerinden görüntülenip yazdırılabilir.

`/leather/service` satılmış ürüne bağlı tamir kabulü, fotoğraflar, garanti, teklif, müşteri onayı, kullanılan parça/işçilik ve geri teslimi izler. Müşterinin bıraktığı ürün şirketin stok varlığına alınmaz. Tamirde kullanılan şirket malzemesi normal stok ve maliyet kaydı oluşturur.

## Kabul ve doğrulama

Yeni şirket → hammadde ve mamul kartları → model/reçete/numune onayı → varyant → faturasız deri kabulü → parça kalite kabulü → üretim emri/rezervasyon → kesim/sarf → iç/fason operasyon → son kalite → kısmi mamul → satış/tahsilat → geç alış faturası → maliyet mutabakatı → müşteri iadesi/servis akışını çalıştırın.

`packages/shared/src/leather*.test.ts`, `packages/shared/src/pos.test.ts`, `apps/api/test/leather*.test.ts`, `apps/api/test/pos.test.ts` ve tarayıcı sektör senaryoları doğrulama kaynaklarıdır. API testlerini ayrı `erp_test` veritabanında çalıştırın; global setup bu test şemasını sıfırlar. API ve tarayıcı veritabanı testlerini eşzamanlı başlatmayın. Shared/web testleri ve typecheck/lint/build ayrıca çalıştırılır. Yedek geri yüklemede modeller, parça olayları, değişmez maliyet izi, kasa vardiyaları ve belge dosyalarının birlikte korunmasını kontrol edin.
