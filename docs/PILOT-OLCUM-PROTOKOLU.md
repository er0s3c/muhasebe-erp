# Pilot ölçüm protokolü (F0, öneri 122)

11 Ekim 2026. Bu protokol, [faz planındaki](GELISTIRME-FAZ-PLANI.md#pilot-kapsamı) beş pilot görevinin bugünkü hâlini ölçmek ve her teslimattan sonra aynı yöntemle tekrar ölçmek için kullanılır. Amaç kullanıcıyı değil, ürünün o işi ne kadar kolay tamamlattığını ölçmektir.

İlk ölçüm gözlemle yapılır. Mevcut `/reports/activity` olay sayısını kaydeder; olay adedi çalışma süresi değildir ve bu protokolde süre kaynağı olarak kullanılmaz. Görev süresini ürün içinde ölçen hafif bir kayıt, F2a teslimatından sonra ihtiyaç görülürse ayrıca değerlendirilir.

## Ölçüm tanımları

| Ölçü | Tanım |
|---|---|
| Başlangıç | Kullanıcı görevi okuyup "başladım" dediği an. Görev tanımındaki başlangıç ekranı açıktır. |
| Bitiş | Görev kartındaki **başarı ölçütü** ekranda görüldüğü an. Kullanıcı kendisi bitirdiğini söylese de ölçüt görülmediyse görev tamamlanmamıştır. |
| Süre | Bitiş − başlangıç, saniye. Gözlemcinin yardım için harcadığı süre dahildir. |
| Hata | Kullanıcının geri almak, düzeltmek veya yeniden girmek zorunda kaldığı her işlem; ürünün verdiği doğrulama hatası; yanlış ekrana gidip geri dönme. Her biri ayrı sayılır. |
| Yardım | Gözlemcinin ipucu, yönlendirme veya cevabı; kullanıcının belgeye ya da başka birine başvurması. Ürün içindeki rehber düğmesi yardım sayılmaz, ayrıca not edilir. |
| Tamamlanamayan adım | Kullanıcının 3 dakika içinde ilerleyemediği ya da vazgeçtiği adım. Gözlemci kısa yönlendirme yapar, adım "yardımla geçildi" olarak işaretlenir. |
| Güven | Görev sonunda 1–5: "Sonucun doğru olduğundan ne kadar eminsiniz?" |

## Oturum düzeni

- Her sektörde en az iki gerçek kullanıcı. Görevi yapan kişinin rolü görev kartındaki rolle uyuşmalı.
- Ölçüm pilot şirketin kopyası olan ayrı bir eğitim ortamında yapılır; gerçek mali kayıt oluşturulmaz. Hazırlık verisi her oturumdan önce görev kartındaki duruma getirilir.
- Her kullanıcı görevi bir kez yapar; aynı kullanıcıyla ikinci deneme öğrenmeyi ölçer ve ayrı işaretlenir.
- Kullanıcı düşündüğünü sesli söyler; gözlemci yönlendirmez, yalnız yazar.
- Ekran kaydı yalnız kullanıcının açık onayıyla alınır. Kayıtta kişi adı yerine kullanıcı kodu (ör. TİC-1) kullanılır; müşteri, personel ve tutar bilgisi not edilmez.

## Görev kartları

### G1 — Ortak: kayıtlı görünümle günlük listeyi açıp engellenen işlemi çözmek

- **Rol / şirket:** Muhasebeci, herhangi bir sektör şirketi.
- **Hazırlık:** Satış faturaları listesinde en az 30 kayıt; biri vade tarihi eksik veya dönem kilidi nedeniyle kesinleştirilemeyen taslak fatura. Kullanıcının daha önce kaydettiği bir "Bu ayın taslakları" görünümü.
- **Başlangıç:** Genel bakış ekranı (`/`).
- **Görev:** "Bu ayın taslak satış faturalarını açın ve kesinleştirilemeyen faturayı kesinleştirin."
- **Başarı ölçütü:** Fatura numarası almış ve kayıtlı duruma geçmiş fatura ekranda görülür.
- **Gözlenecek noktalar:** Kayıtlı görünümü bulma; işlemin neden kapalı olduğunu anlama; çözüm ekranına geçiş.
- **İlgili fazlar:** F2a (5, 24, 28, 31), F3 (3).

### G2 — Ticaret/muhasebe: banka hareketini bulup mutabakatı tamamlamak

- **Rol / şirket:** Muhasebeci, ticaret şirketi.
- **Hazırlık:** Banka hesabına içe aktarılmış ekstrede üç eşleşmemiş satır: biri tek faturanın birebir tahsilatı, biri iki faturayı birlikte kapatan tahsilat, biri banka masrafı.
- **Başlangıç:** Banka hesabı ekranı, mutabakat sekmesi (`/treasury/accounts/:id`).
- **Görev:** "Eşleşmeyen üç banka hareketini doğru kayıtlarla eşleştirin; fark kalmasın."
- **Başarı ölçütü:** Açık satır sayısı 0, mutabakat farkı 0 görünür.
- **Gözlenecek noktalar:** Birden çok faturayı kapatan tahsilat (bugün birebir öneri var); masrafı kaydetme yolu; sonucu doğrulama.
- **İlgili fazlar:** F4 (55, 56, 59).

### G3 — Üretim: geciken sipariş için uygulanabilir plan hazırlamak

- **Rol / şirket:** Üretim planlayıcısı, üretim ve toptan ticaret şirketi.
- **Hazırlık:** Termini yaklaşan, malzemesi hazır, bir operasyonunun kaynağı bakımda olan onaylı sipariş; müdahale listesinde gecikme kaydı.
- **Başlangıç:** Müdahale listesi (`/manufacturing/exceptions`).
- **Görev:** "Gecikme riski olan sipariş için uygulanabilir bir plan hazırlayıp yayımlayın."
- **Başarı ölçütü:** Yayımlanmış plan sürümü ve siparişin yeni tahmini teslim tarihi görülür.
- **Gözlenecek noktalar:** Gecikmenin nedenini bulma; alternatif kaynak seçimi; kapasite hatasını anlama; diğer işlere etkisini görme.
- **İlgili fazlar:** F7 (14, 63, 65, 66, 67).

### G4 — İnşaat: telefondan saha kaydı gönderip sonucunu takip etmek

- **Rol / şirket:** Şantiye sorumlusu, inşaat şirketi. 390 px telefon görünümü.
- **Hazırlık:** Onaylı çizimi ve konumları olan proje; kullanıcının telefonunda indirilmiş saha paketi yok.
- **Başlangıç:** Proje 360 (`/workspace/project-control`).
- **Görev:** "Bağlantı yokken bir mahaldeki sorunu fotoğraflı olarak kaydedin; bağlantı gelince gönderin ve kaydın kime düştüğünü bulun."
- **Başarı ölçütü:** Kayıt sunucuda görülür; sorumlusu ve durumu kayıt ayrıntısında okunur.
- **Gözlenecek noktalar:** Saha paketini indirme ve cihaz kodu; çevrimdışı açılış; fotoğraf ve konum; eşitleme kuyruğunun anlaşılması.
- **İlgili fazlar:** F10 (17), F9 (84).

### G5 — Deri: bir kalıp için uygun kalan parçayı bulup ayırmak

- **Rol / şirket:** Kesimci veya atölye sorumlusu, deri şirketi.
- **Hazırlık:** Serbest bırakılmış üretim emri; aynı renk/tonda üç kalan parça, biri kusur bölgesi kalıpla çakışan, biri alanı yetersiz, biri uygun.
- **Başlangıç:** Deri üretim emri (`/leather/production`).
- **Görev:** "Bu emir için yeni tam deri açmadan uygun kalan parçayı bulun ve kesim planına ayırın."
- **Başarı ölçütü:** Kesim planında seçilen parça ve gerekli alan/verim görülür; parça başka sarfa kapanmıştır.
- **Gözlenecek noktalar:** Kalan parçaları süzme; kusur ve damar yönünü değerlendirme; uygun olmayan parçanın nedenini anlama.
- **İlgili fazlar:** F8 (15, 74, 75, 76).

## Kayıt formu

Her görev denemesi için bir satır. Boş form [aşağıda](#boş-kayıt-tablosu).

| Alan | Açıklama |
|---|---|
| Tarih / ölçüm turu | ör. 2026-10-15 / Başlangıç |
| Görev | G1–G5 |
| Kullanıcı kodu | ör. TİC-1 (ad yazılmaz) |
| Deneme | İlk / tekrar |
| Süre (sn) | |
| Tamamlandı | Evet / Hayır / Yardımla |
| Hata sayısı | |
| Yardım sayısı | |
| Tamamlanamayan adımlar | Adım adı ve kısa neden |
| Güven (1–5) | |
| Gözlem notu | Kullanıcının takıldığı yer, sesli düşünce özeti |
| İlgili öneri | Gözlenen soruna karşılık gelen öneri numarası |

### Boş kayıt tablosu

| Tarih / tur | Görev | Kullanıcı | Deneme | Süre (sn) | Tamamlandı | Hata | Yardım | Tamamlanamayan adımlar | Güven | Not | Öneri |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

## Sonuçların kullanımı

- Her görev için ortanca süre, tamamlanma oranı ve toplam hata/yardım sayısı hesaplanır. Ortalama yerine ortanca kullanılır; tek uzun deneme sonucu bozmasın.
- Sonraki teslimat sırası şu ölçütle seçilir: **(kaybedilen süre × işin sıklığı) + hata ağırlığı**. Mali sonucu yanlış bırakabilecek hata, süre kaybından önce gelir.
- Teslimat sonrası ölçüm aynı görev kartı ve aynı hazırlık verisiyle yapılır. Kart değişirse önceki sonuçla karşılaştırılmaz, yeni başlangıç sayılır.
- Sonuçlar [faz planındaki](GELISTIRME-FAZ-PLANI.md) ilgili önerinin "Durum" sütununa ve teslimat kaydına bağlanır.
