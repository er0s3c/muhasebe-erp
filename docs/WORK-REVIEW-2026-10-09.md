# 9 Ekim kullanıcı değişiklikleri ve geliştirme kaydı

Kullanıcının yerel değişiklikleri ve dokuz açık PR incelendi. Kirli çalışma ağacı korunarak düzeltmeler yapıldı; geliştirme veritabanı sıfırlanmadı, uzak PR'ler birleştirilmedi veya güncellenmedi. PR head/CI değerlendirmesi [ayrı inceleme kaydındadır](PR-REVIEW-2026-10-09.md).

## Düzeltilen davranışlar

- Paylaşılan `npm run dev` günlüğündeki `57P03`, PostgreSQL açılışı sırasında API'nin kapanmasına ve Vite vekil bağlantılarının reddedilmesine yol açıyordu. API geçici bağlantı hatalarını sınırlı sayıda yeniden dener; yanlış kimlik bilgisi ve kalıcı hatalar bekletilmez. Yerel API sağlık/hazır olma ve Vite uçları 200 döndü.
- Kullanıcının eklediği AI araçlarına güncel modül, okuma ve dışa aktarma kapıları uygulandı. Kalan vadesi geçmiş alacak, mevcut açık kalem motorundan okunur. Aynı DB bağlantısında araçlar sırayla çalışır; bir istekte sekiz araç sınırı vardır. Ham sağlayıcı/SQL hataları aktarılmaz. Sohbet kapsam değişiminde temizlenir; mobil/koyu tema ve tek kaydırma düzeltildi. [Gerçek kapsam ve sınırlar](ADA-AI.md).
- Zengin deri demosunda yutulan aşama hataları artık üst işleme iletilir; başarısız tohumlama geri alınır. Önceden bulunan demo tekrar oluşturulmuş gibi bildirilmez. Genel demo varsayılanı üretim demosu olarak kaldı; deri demosu ayrı komutla kullanılabilir.
- Rol şablonu, işlem erişimi, kişisel ajanda, mali belge onayı, portal, eski bordro ve tarihli vergi testlerindeki uyumsuzluklar giderildi. Test fikstürleri gerçek kullanıcı/şube bağlamını kurar; RLS koruması gevşetilmedi.
- Deri üretim listesi, sıra ve tekil 404 davranışı korunarak toplu sorgulara geçirildi. 300 kayıt aynı bağlantıda yüzlerce sorgu kuyruğu oluşturmaz.
- Satış/alış raporuna şube ve özgün kaydı oluşturan kullanıcı kırılımı eklendi. İade özgün kullanıcıdan düşülür; iptal kendi olay döneminde düşer. Şube kapsamı ve dışa aktarma engeli dosya çıktısında da uygulanır. Geçmiş şubesiz kayıtlar tahminle atanmaz. Bu kırılım gerçek satış temsilcisi veya prim modeli değildir.
- Sayfa rehberi tıklama/dokunmayla açılır. Raporda uzun etiketler okunur; fatura toplam satırını kaydıran boş hücre kaldırıldı.

## Doğrulama

| Kontrol | Sonuç |
|---|---|
| API tam regresyonu | 1.094 başarılı; bir rapor testi koşu sırasında eklenen seçenekleri eski dönüştürülmüş şemayla okuyup 400 aldı; 31 isteğe bağlı test atlandı |
| Güncel kodla temiz hedefli API koşusu | 11 dosya, 81 başarılı; yukarıdaki rapor testi ve yeni şube/deri/asistan/oturum kontrolleri dahil |
| Dolu 0104 yükseltmesi ve son asistan regresyonu | 3 dosya, 18 başarılı; kesinleşmiş fatura/yevmiye, manuel kur/KDV, mevcut eşleme ve ikinci migration çalıştırması dahil |
| Shared | 44 dosya, 832 başarılı |
| Web birim testleri | 8 dosya, 41 başarılı |
| Lisans sunucusu / çekirdeği | 84 / 41 başarılı |
| Tarayıcı | 5 başarılı; mobil/masaüstü, açık/koyu tema, rapor/CSV, asistan kapsamı, şifreli kuyruk ve gerçek çevrimdışı yeniden yükleme |
| Tüm çalışma alanlarında tip kontrolü ve lint | Başarılı |
| ERP web/API ve lisans paneli/sunucusu derlemeleri | Başarılı |

Tam API koşusu devam ederken şema değiştirilmesi test önbelleğini karıştırdı. Sonrasında güncel dosyalarla ayrı bir temiz koşu yapıldı; bir finansal toplam farkı olarak raporlanmadı. Bu tablo son değişikliklerden sonra tüm API testlerinin ikinci kez tek koşuda çalıştığını iddia etmez. Detaylı çıktılar `.cache/review-*.log` dosyalarındadır.

## Bağımlılıklar ve geçiş

`fast-jwt` 6.3.4, `concurrently` 10.0.6 / `shell-quote` 1.12.0 ve `source-map-js` 1.2.2 yamalarına dar güncellemeler uygulandı. Üretim bağımlılığı denetimi sıfır bilinen açık; tüm bağımlılıklarda sıfır yüksek/kritik ve Drizzle geliştirme araç zincirinde dört orta bulgu gösterir. Kapsamı genişleten zorunlu bir ana sürüm değişimi yapılmadı.

Kullanıcının 0105 kimlik üretimi onarımı korunmuştur. Gerçek, dolu 0104 örneğinden güncel zincire yükseltme ve tekrar çalıştırma testi geçti. Eski kilit değişikliğinin gerekçesi ve doğrulanan kapsam [onarım kaydında](MIGRATION-0105-REPAIR.md) açıklanır.

## Kalan yol haritası

Şube/kullanıcı raporu ile rapor aşaması ilerletildi. Ülke paketlerinin mali pilotu, tüm çalışan rejimleri ve resmî dönem raporları; genel servis/varyant/garanti; e-posta/arşiv/süzgeçler; gerçek satış sorumlusu modeli, sağlık puanı ve kâr senaryoları; kullanıcı tanımlı otomasyonlar, QR doğrulama ve ticari paketler henüz tamamlanmış sayılmaz. Güncel aşama karşılıkları [ülke uygulama kaydında](COUNTRY-IMPLEMENTATION.md) izlenir. Gerçek Gemini hesabı ve resmî e-belge bağlantıları bu doğrulamanın parçası değildir.
