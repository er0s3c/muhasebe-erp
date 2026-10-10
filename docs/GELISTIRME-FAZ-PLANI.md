# Ada Muhasebe — 122 öneri için uygulama fazları

10 Ekim 2026. Önceki 1–22 ve devamındaki 23–122 önerileri bu dosyada tek bir uygulama planına bağlanmıştır. Her önerinin bir ana fazı vardır. Faz sırası bağımlılıkları anlatır; ortak temelden sonra sektör fazları birbirini beklemeden ilerler. Plan, önerilerin tamamının bugün eksik olduğu iddiasını taşımaz: önce mevcut kod/kabul kaydıyla karşılaştırılır, sonra yalnız gerekli genişletme uygulanır.

Bir kişi veya küçük ekiple, aynı anda bir ana teslimat üzerinde ilerleme varsayılmıştır. Takvim taahhüdü verilmemiştir; her teslimat kapsamı netleştirilip ilk işlerden elde edilen gerçek hızla tahmin edilir. Dış hesap, fiziksel cihaz veya mali uzman bekleyen iş **paralel dış hat** olarak izlenir ve bir fazın ilk kapsamını kilitlemez.

## İçindekiler

- [Pilot kapsamı](#pilot-kapsamı)
- [Önce izlenecek yol](#önce-izlenecek-yol)
- [İlk beş teslimat](#ilk-beş-teslimat)
- [Faz envanteri](#faz-envanteri)
- [Her teslimatın çalışma düzeni](#her-teslimatın-çalışma-düzeni)
- [Detaylı uygulama kapsamı](#detaylı-uygulama-kapsamı)
- [Paralel dış hat](#paralel-dış-hat)
- [İş kartı şablonu](#iş-kartı-şablonu)
- [Kapsam kontrolü](#kapsam-kontrolü)
- [Değişiklik kaydı](#değişiklik-kaydı)

## Pilot kapsamı

Pilot dört sektörü birlikte kapsar: **ticaret/muhasebe, üretim, inşaat ve deri**. Bu nedenle:

- F0–F4 sektörden bağımsız ortak temel olarak tutulur; sektöre özgü iş bu fazlara sızdırılmaz.
- F0'da her sektör için bir, ayrıca bir ortak görev seçilir (toplam beş görev):

| Sektör | Pilot görevi | İlgili fazlar |
|---|---|---|
| Ortak | Kullanıcının kayıtlı görünümüyle günlük listesini açıp engellenen bir işlemi çözmesi | F2a, F3 |
| Ticaret/muhasebe | Muhasebecinin banka hareketini bulup mutabakatı tamamlaması | F4, F5, F6 |
| Üretim | Üretim sorumlusunun geciken sipariş için uygulanabilir plan hazırlaması | F7 |
| İnşaat | Şantiye sorumlusunun telefondan saha kaydı gönderip sonucunu takip etmesi | F9, F10 |
| Deri | Kesimcinin bir kalıp için uygun kalan parçayı bulup rezerve etmesi | F8 |

- Sektör fazları (F6, F7, F8, F9) F3/F4'ün ilk teslimlerinden sonra birbirine kilitlenmeden sırayla yürütülür. Sıra, F0 ölçümünde en çok zaman kaybettiren göreve göre belirlenir.

## Önce izlenecek yol

- **Ön koşul:** Teslimat 0 — main CI yeşil, açık PR'lar karara bağlanmış.
- **Ortak başlangıç:** F0 → F1'in ilk teslimi → F2a → F3'ün ilk teslimi → F4'ün ilk teslimi.
- **Ticaret:** ortak başlangıç → F5 / F6 (birbirinden bağımsız) → F2b genişletmeleri.
- **Üretim:** ortak başlangıç → F7. (Yalnız 37 numaralı ürün yapılandırma F7 temelini bekler.)
- **Deri:** ortak başlangıç → F8'in 73–76 işleri; 77–79 için F7'nin ilgili operasyon/kalite teslimatı.
- **İnşaat:** ortak başlangıç → F9; saha mobil görevi için F10.
- **Mobil:** seçilen görev akışı F2a'dan sonra başlatılabilir; puantaj/ücret işleri F4'ü bekler.
- **AI ve bağlantılar:** F1 + F3 sonrası F11; kanal eşleme (108–109) F5'in stok temelini, olağan dışı işlem (105) F4'ü bekler.
- **Büyüme kabulü:** seçilen sektör fazıyla birlikte F12.

Bağımlılıkta belirtilen fazın ilgili ortak temeli yeterlidir; o fazdaki bütün genişletmelerin bitmesi beklenmez. Her ilk kapsam da tek sürümde değil küçük teslimatlarla yürütülür.

F1'deki güvenlik, kurtarma, yetki ve değişmez kural testleri bütün fazlar için geçerlidir; her yeni akış bu testlere senaryo ekler. Mali veya ülkeye özgü yeni hesaplar, doğrulanmış yöntem ve referanslar hazır olduğunda yayına alınır.

## İlk beş teslimat

| Teslimat | Yapılacak iş | Somut çıktı | Bitiş ölçütü |
|---|---|---|---|
| 0 | Ön koşul: main CI ve açık PR'lar | Lint, tip, test, geri yükleme tatbikatı ve E2E işleri main'de yeşil; #12–#22 PR'ları birleştirilmiş veya gerekçeyle kapatılmış; [PR-REVIEW-2026-10-09](PR-REVIEW-2026-10-09.md) P2 bulguları (#16 pencere durumu, #17 atlanan rol erişim testleri, #19 sıra/404/lint) çözülmüş | main üzerindeki son CI çalışması tüm işlerde başarılı; atlanan (`test.skip`) güvenlik testi yok |
| 1 | F0: mevcut durum envanteri, beş pilot görevi, ölçüm protokolü | Öneri tablolarında "Mevcut temel" ve "Durum" sütunları doğrulanmış; dar backlog | Beş görevin başlangıç süresi, hata ve yardım kaydı ile kabul senaryosu yazılı |
| 2 | F1: AI işlem sınırı (19), güvenlik/kurtarma kabulü (21), değişmez kural ve tekrar istek test altyapısı (120, 121) | Yetkiyi koruyan kısa DB işlemleri; mali/stok değişmezleri için ortak test yardımcıları | Yavaş sağlayıcıyla bağlantı havuzu tükenmiyor; değişmez testleri CI'da koşuyor |
| 3 | F2a: sunucu kayıtlı görünüm, engel açıklaması, birim ve temel/ayrıntılı form | Seçilen iki ekranda kullanılabilir küçük sürüm | Başka cihazda görünüm açılıyor; yanlış birim ve işlem engeli açıklanıyor |
| 4 | F3: bir satış belge zinciri, kalıcı e-posta outbox'ı ve gönderim geçmişi | Kaynaklara inen zaman çizgisi; üretim kanalı outbox'ından genelleştirilmiş ortak sözleşme | Tekrarlı olay aynı kayıt/etkiyi çoğaltmıyor; sunucu yeniden başlasa da gönderim kaybolmuyor; belge sürümü ve sonuç görülebiliyor |

Sonraki teslimat F4'ün ilk kapsamıdır (kapanış kontrolü, departman boyutu alanı, cari/banka mutabakatı); ardından F0 ölçümüne göre ilk sektör fazı seçilir.

## Faz envanteri

| Faz | Amaç | Öneri sayısı | Bağımlılık |
|---|---|---|---|
| F0 — Kapsam ve pilot hazırlığı | Mevcut kodun üzerine uygulanacak işleri ve ölçülebilir kabul senaryolarını seçmek. | 2 | Teslimat 0 |
| F1 — Güven, test altyapısı ve temel işletim | Güvenlik, gizlilik ve kurtarma kurallarını korurken erken teknik darboğazları ve tutarlılık testlerini kurmak. | 9 | F0 |
| F2a — Ortak kullanıcı deneyimi: temel | Günlük ekranlarda görünüm, giriş doğrulaması ve engel açıklamasını tamamlamak. | 4 | F1'in ilk teslimi |
| F2b — Başlangıç düzenleri ve gelişmiş giriş | Sektör/rol paketleri, hızlı giriş, hesap açıklaması, taslak sürümü ve geçiş araçları. | 10 | F2a; rol kartları için F3/F4'ün ilgili kaynakları |
| F3 — Kayıt bağlantıları, belge ve ortak iş akışları | Modüller arasındaki izleri ve görev/onay/iletişim süreçlerini ortak temele bağlamak. | 8 | F1, F2a |
| F4 — Finans, ülke doğrulaması ve yönetim muhasebesi | Kapanış, mutabakat, ödeme ve yönetim raporlarını güvenilir çalışma süreçlerine çevirmek. | 14 | F1, F3'ün ilk teslimi |
| F5 — Depo ve satın alma | Fiziksel yerleştirme, toplama, sayım, tedarik ve iade süreçlerini birbirine bağlamak. | 10 | F3, F4'ün ilk teslimi |
| F6 — Satış ve ticari kararlar | Fiyat, maliyet, müşteri riski ve satış sorumluluğunu işlem kararına bağlamak. | 11 | F3, F4'ün ilk teslimi; 37 için F7 |
| F7 — Ortak üretim motorunun derinleştirilmesi | Mevcut MES/kapasite/WIP/kalite altyapısını daha doğru plan ve gerçekleşen analizine taşımak. | 11 | F3, F4'ün ilk teslimi |
| F8 — Deri atölyesi | Parça, kalıp, kusur, ton ve operasyon izini özel ürün maliyetiyle birleştirmek. | 11 | F4'ün ilk teslimi; 77–79 için F7'nin operasyon/kalite teslimatı |
| F9 — İnşaat ve gayrimenkul | Mevcut Proje 360 kayıtlarından daha uygulanabilir saha ve ticari kararlar üretmek. | 11 | F3, F4'ün ilk teslimi |
| F10 — Mobil kullanım ve personel | Telefon, atölye ve personel işlemlerini kısa görev akışlarıyla tamamlamak. | 7 | F1, F2a, F3; puantaj/ücret için F4 |
| F11 — AI, OCR ve dış bağlantılar | Açıklanabilir veri yardımı ve kontrollü bağlantıları gerçek kullanımda doğrulamak. | 9 | F1, F3; 105 için F4, 108–109 için F5 |
| F12 — Büyük veri ve sürüm işletimi | Pilot sonrası büyüyen veri, rapor ve güncellemelerde işletim sınırlarını doğrulamak. | 5 | F1, F3, seçilen sektör fazı |

## Her teslimatın çalışma düzeni

1. Mevcut davranışı ve kabul kanıtını kontrol et; tablodaki "Mevcut temel" sütununu doğrula. Kullanılabilir bir özellik için tekrar motor yazma.
2. Tek kullanıcı görevi ve görünür sonucu seç; öneri numarasıyla takip et.
3. Ortak hesap, stok, yetki ve belge kaynaklarını kullan; gereken migration ve eski veri geçişini aynı kapsamda ele al.
4. Değişikliğe uygun hesap/DB/izin/eşzamanlılık kontrollerini ve F1'deki değişmez kural testlerine yeni senaryoları ekle; ilgili ekranı gerçek API ile kontrol et.
5. Kaynak miktar ve mali tutarlılığı, mobil/masaüstü ve gerekiyorsa açık/koyu görünümü doğrula.
6. main CI'ın yeşil kaldığını doğrula; sürüm/kabul kaydını ve bu dosyadaki "Durum" sütununu güncelle; gözlenen sonuç ile henüz denenmemiş dış kabulü ayır.
7. Pilot görevini F0 protokolüyle tekrar ölç; bir sonraki teslimatın önceliğini eldeki sonuca göre belirle.

**Durum değerleri:** Bekliyor · Devam ediyor · Uygulandı · Yerel kabulden geçti · Pilotta doğrulandı · Canlı bağlantıda doğrulandı.

## Detaylı uygulama kapsamı

"Mevcut temel" sütunu, 10 Ekim 2026 kod incelemesinde doğrulanan başlangıç noktasını gösterir. "F0'da doğrulanacak" yazan satırlar henüz kodla karşılaştırılmamıştır.

### F0 — Kapsam ve pilot hazırlığı

Mevcut kodun üzerine uygulanacak işleri ve ölçülebilir kabul senaryolarını seçmek.

Bağımlılık: Teslimat 0. Göreli büyüklük: Küçük.

İş sırası:

1. "F0'da doğrulanacak" satırlarını kodla karşılaştır; her öneriyi mevcut / genişletilecek / yeni / dış erişim bekleyen olarak işaretle.
2. [Pilot kapsamındaki](#pilot-kapsamı) beş görev için ölçüm protokolünü yaz: görev başlangıç/bitiş zamanı, hata, yardım ihtiyacı, tamamlanamayan adım. `/reports/activity` olay sayısını çalışma süresi olarak kullanmaz; bu yüzden ilk ölçüm gözlemle yapılır, gerekiyorsa görev başlangıç/bitişi için hafif bir ölçüm kaydı eklenir.
3. Başlangıç ölçümünü kaydet; modül sınırları ve güncel kabul belgeleri için tek izleme kaydı oluştur.

Tamamlanma ölçütü: Beş görev için başlangıç kaydı, kabul senaryosu ve ilk teslimat kapsamı hazır; tablolardaki "Mevcut temel" sütunu boş satır içermiyor.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 22 | Kod sınırları, özellik durumları ve dokümantasyon | İlk kapsam | Kabul kayıtları `docs/` altında dağınık; `LeatherPages.tsx` ~3.100 satır | Bekliyor |
| 122 | Geliştirmenin gerçek kullanım etkisi | İlk kapsam | `/reports/activity` olay kaydı var, süre ölçümü yok | Bekliyor |

### F1 — Güven, test altyapısı ve temel işletim

Güvenlik, gizlilik ve kurtarma kurallarını korurken erken teknik darboğazları ve tutarlılık testlerini kurmak.

Bağımlılık: F0. Göreli büyüklük: Orta–büyük; ilk teslim dar kapsamlı.

İş sırası:

1. Mevcut şirket/şube/işlem yetkileri, kritik klavye akışları ve ayrı hedefe geri yükleme davranışını doğrula; bulunan sorunları düzelt.
2. AI sağlayıcı beklemesini uzun DB işleminden ayır: bağlam/yetki kontrolü kısa işlemde yapılır, her araç okuması kendi kısa kiracı işlemini açar ve güncel yetki/şubeyi yeniden doğrular. Yavaş sağlayıcı altında bağlantı havuzu kullanımını ölç.
3. Değişmez kural test yardımcılarını kur (borç–alacak dengesi, tahsis sınırı, kaynak maliyetin tekrar kullanılmaması) ve tekrar istek/kayıp cevap senaryolarını ekle. Sonraki fazlar bu altyapıya senaryo ekler; sektör uçtan uca genişletmesi F12 ile yapılır.
4. Destek verisi önizleme/maskeleme ve kayıt türüne göre saklama politikasını gizlilik kurallarına bağla.
5. Dosya için bekleyen/uygun/reddedildi durumlarını ve içerik doğrulamasını tamamla; anahtar sürümü ve belge paketi bütünlüğünü ayrı küçük teslimatlar halinde genişlet.

Tamamlanma ölçütü: Şirket/şube sınırı, kritik görev erişilebilirliği, dosya erişimi ve kurtarma senaryosu korunuyor; yavaş AI sağlayıcısı günlük işlemleri bloke etmiyor; değişmez ve tekrar istek testleri CI'da koşuyor.

İlk teslimata alınacak öneriler: 19, 21, 120, 121.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 19 | AI dış çağrılarını uzun DB işlemlerinden ayırma | İlk kapsam | `ai/routes.ts` sağlayıcı çağrısına `c.tx` veriyor; işlem cevap boyunca açık | Bekliyor |
| 21 | Güvenlik, kurtarma ve erişilebilirlik kabul koşulları | İlk kapsam | RLS, MFA, denetim izi, CI'da geri yükleme tatbikatı | Bekliyor |
| 120 | İş kuralları için değişmez doğrulama koşulları | İlk kapsam | Mali regresyon testleri var; özellik tabanlı/değişmez test altyapısı yok | Bekliyor |
| 121 | Ağ kesintisi ve eşzamanlılık kabulü | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 101 | Kayıt türüne göre veri saklama politikası | Genişletme | F0'da doğrulanacak | Bekliyor |
| 102 | Destek verisini önizleme ve maskeleme | Genişletme | `system/feedback.ts` geri bildirim ekranı | Bekliyor |
| 116 | Sürümlü şifreleme anahtarı yenileme | Genişletme | Yok; `BACKUP_SIGNING_KEY` tek anahtar | Bekliyor |
| 117 | Dosyayı açmadan içerik/zararlı yazılım kontrolü | Genişletme | Yok | Bekliyor |
| 118 | Onaylı belge paketinde bütünlük kontrolü | Genişletme | `approvals/document-hash.ts` | Bekliyor |

### F2a — Ortak kullanıcı deneyimi: temel

Günlük ekranlarda görünüm, giriş doğrulaması ve engel açıklamasını tamamlamak.

Bağımlılık: F1'in ilk teslimi. Göreli büyüklük: Orta.

İş sırası:

1. Kişisel kayıtlı görünümü mevcut `user_ui_preferences` / `preferences` rotasına yeni bir anahtar olarak ekle; yerel depodaki görünümleri ilk açılışta sunucuya taşı. Ekip görünümleri için ayrı tablo kur; sonuçlar her kullanıcının güncel yetkisiyle hesaplanır.
2. Pasif işlem düğmelerine sebep ve çözüm bağlantısı ekle; önce iki yoğun ekranda uygula.
3. Formlarda temel/ayrıntılı görünüm ve birim/hassasiyet doğrulaması ekle.

Tamamlanma ölçütü: Aynı kullanıcı başka cihazda görünümünü açabiliyor; paylaşılan görünüm yetkisiz kayıt göstermiyor; yanlış birim ve işlem engeli açıklanıyor.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 5 | Sunucuda kayıtlı filtreler ve ortak görünümler | İlk kapsam | `SavedViews.tsx` localStorage; `preferences/routes.ts` favori, pano düzeni ve tablo yoğunluğunu sunucuda tutuyor | Bekliyor |
| 24 | Temel ve ayrıntılı form girişi | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 28 | Kullanılamayan işlemin sebebi ve çözüm bağlantısı | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 31 | Birim ve sayı girişinde tutarlılık kontrolü | İlk kapsam | F0'da doğrulanacak | Bekliyor |

### F2b — Başlangıç düzenleri ve gelişmiş giriş

Sektör/rol paketleri, hızlı giriş, hesap açıklaması, taslak sürümü ve geçiş araçları.

Bağımlılık: F2a. Rol panosu kartları F3/F4'ün ilgili kaynaklarına (bağlantılı liste, banka/kapanış verisi) bağlanır. Göreli büyüklük: Büyük; ekran gruplarıyla teslim.

İş sırası:

1. Dört pilot sektörü için başlangıç paketi tanımla (modül, pano, rol önerisi, kurulum adımları); mevcut kurulum kontrol listesi ve modül açma/kapama üzerine kur.
2. Rol bazlı başlangıç panolarını mevcut `dashboard.layout` tercihi ve iş uyarıları üzerinden sun; kartlar ilgili listeye ve işleme götürür.
3. Hızlı giriş şablonu ve tutar hesaplama açıklamasını ekle.
4. Veri aktarımı sonrası mutabakatı (kaynak dosya toplamı ↔ ERP sonucu) ilk pilot şirketinde uygula.
5. Taslak sürümü ve çakışma çözümünü önce teklif üzerinde tamamla; arama, karşılaştırma ve eğitim senaryolarını ortak bileşenle genişlet.

Tamamlanma ölçütü: Yeni şirket sektör paketiyle kurulduğunda yalnız ilgili menü ve pano görünüyor; açılış aktarım toplamları açıklanabilir; iki kullanıcının değişikliği kaybolmuyor.

İlk teslimata alınacak öneriler: 1, 2, 8, 23, 29.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 1 | Ürünü sektör ve kullanıcı görevine göre paketleme | İlk kapsam | Modül açma/kapama; `workspace/setup.ts` kurulum kontrol listesi | Bekliyor |
| 2 | Rol bazlı başlangıç panoları | İlk kapsam | `dashboard.layout` tercihi; `workspace/alerts.ts` iş uyarıları ve bekleyen onaylar | Bekliyor |
| 8 | Kurulum, veri aktarımı ve mutabakat | İlk kapsam | `imports` modülü: sütun eşleme, önizleme, atomik yazma | Bekliyor |
| 23 | Kullanıcıya özel hızlı giriş şablonları | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 29 | Tutar hesaplama açıklamaları | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 25 | Yazım hatası ve alternatif isimle arama | Genişletme | `workspace/search`; bulanık eşleşme (pg_trgm vb.) yok | Bekliyor |
| 26 | Taslak sürüm geçmişi | Genişletme | Çevrimdışı taslaklar (`workspace/offline-drafts.ts`) | Bekliyor |
| 27 | Eşzamanlı düzenlemede alan bazlı çakışma çözümü | Genişletme | F0'da doğrulanacak | Bekliyor |
| 30 | Kayıtları yan yana karşılaştırma | Genişletme | F0'da doğrulanacak | Bekliyor |
| 32 | İş üstünde eğitim senaryoları | Genişletme | Demo şirketleri ve roller | Bekliyor |

### F3 — Kayıt bağlantıları, belge ve ortak iş akışları

Modüller arasındaki izleri ve görev/onay/iletişim süreçlerini ortak temele bağlamak.

Bağımlılık: F1, F2a. Göreli büyüklük: Büyük; önce tek belge türü.

İş sırası:

1. Teklif → sipariş → sevkiyat → fatura → tahsilat zaman çizgisini ve ortak kayıt görünümünü mevcut kayıt bağlantıları üzerine tamamla.
2. Üretim kanallarındaki outbox'ı ortak sözleşmeye genelleştir; e-postayı bu sözleşmeye taşı. Şu an `queueMail` iletiyi bellekte gönderiyor ve sunucu yeniden başlarsa kaybediyor. Belge paketi/sürümü, alıcı, deneme ve sonuç geçmişi aynı kayıtta tutulur.
3. Mevcut toplu fatura önizlemesini genel toplu işlem bileşenine dönüştür; süreli onay vekâleti ve gecikme yönlendirmesini küçük teslimatlarla ekle.
4. Otomasyon için önce yalnız görev/bildirim/taslak eylemleri, deneme modu ve çalışma geçmişi uygula.

Tamamlanma ölçütü: Tekrarlı gönderim aynı iş kaydını çoğaltmıyor; dış gönderimin sonucu açık; vekâlet bitince erişim bitiyor; deneme otomasyonu mali kayıt üretmiyor.

İlk teslimata alınacak öneriler: 3, 4, 6, 7, 98, 99, 111.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 3 | Uçtan uca işlem geçmişi | İlk kapsam | `workspace/records.ts` kayıt erişimi ve bağlantı görünürlüğü; satın alma/satış temel bağlantıları | Bekliyor |
| 4 | Cari, ürün ve proje ortak kayıt görünümü | İlk kapsam | `workspace/records.ts`; kayıt detay sayfaları | Bekliyor |
| 6 | Önizlemeli toplu işlemler | İlk kapsam | `sales/batch.ts` önizlemeli toplu fatura | Bekliyor |
| 7 | Belge gönderimi ve gönderim geçmişi | İlk kapsam | `mail/` (mailer, şablonlar, bellek içi kuyruk); PDF şablonları ve arşiv | Bekliyor |
| 98 | Süre/kapsam sınırlı onay vekâleti | İlk kapsam | Yok; `approvals` modülü onay akışı | Bekliyor |
| 99 | Onay süreleri ve yönlendirme | İlk kapsam | `approvals` modülü | Bekliyor |
| 111 | Ortak outbox sözleşmesi | İlk kapsam | `manufacturing/channels.ts` outbox (0111/0112 migration'ları) | Bekliyor |
| 100 | Deneme modunda kullanıcı otomasyonları | Genişletme | Yok (WORK-REVIEW kalan yol haritası) | Bekliyor |

### F4 — Finans, ülke doğrulaması ve yönetim muhasebesi

Kapanış, mutabakat, ödeme ve yönetim raporlarını güvenilir çalışma süreçlerine çevirmek.

Bağımlılık: F1, F3'ün ilk teslimi. Göreli büyüklük: Büyük.

İş sırası:

1. Kapanış kontrol listesini ve kaynak raporlarını dönem kilidi/yıl sonu üzerine kur.
2. Defter, fatura, gider ve bordro satırlarına isteğe bağlı departman/maliyet merkezi alanını şimdi ekle; sonraki fazların ürettiği yeni kayıtlar baştan bu boyutu taşır. Raporlar ve dağıtım anahtarları genişletmede gelir.
3. Cari mutabakat ve çoktan bire banka eşleştirmesini mevcut açık kalem/muhasebe servisleriyle tamamla.
4. Banka hesabı değişiklik kontrolü ve toplu ödeme hazırlama ekle; banka sonucu gelmeden başarı kabul etme.
5. Nakit senaryoları, döviz görünümü, demirbaş elden çıkarma, varlık kullanım maliyeti ve grup içi mutabakatı doğrulanmış yöntemlerle ayrı teslim et.

Tamamlanma ölçütü: Fatura–cari–stok–yevmiye tutarlılığı ve geçmiş belge tutarları korunuyor; kapanış farkları kaynağa iniyor; departman alanı geçmiş kayıtlarda "bilinmiyor" olarak kalıyor ve tahmin edilmiyor.

İlk teslimata alınacak öneriler: 9, 11 (yalnız boyut alanı), 53, 55, 59. Öneri 10 [paralel dış hatta](#paralel-dış-hat) yürür.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 9 | Muhasebe kapanış çalışma süreci | İlk kapsam | Dönem kilidi (`settings/periods.ts`), `yearend` modülü | Bekliyor |
| 11 | Departman ve maliyet merkezi boyutu | İlk kapsam (alan) + Genişletme (rapor/dağıtım) | Yok; departman bütçesi hesap/proje süzgeciyle çalışıyor (ENTERPRISE-EXPANSION) | Bekliyor |
| 53 | Tedarikçi banka bilgisi değişiklik kontrolü | İlk kapsam | Yok | Bekliyor |
| 55 | Banka eşleştirmesinde çoktan bire ilişki | İlk kapsam | `bank-statements/matching.ts` birebir öneri puanlaması | Bekliyor |
| 59 | Cari mutabakat mektubu ve cevap takibi | İlk kapsam | Cari açık kalemler (`parties/service.ts`) | Bekliyor |
| 10 | Türkiye/KKTC doğrulanmış ülke kapsamı | Paralel dış hat | Ülke profili, tarihli vergi kuralları; mali pilot bekliyor (COUNTRY-IMPLEMENTATION) | Bekliyor |
| 12 | Karar karşılaştırmalı nakit projeksiyonu | Genişletme | Sözleşme vadesi ve ödeme geçmişine dayalı projeksiyon | Bekliyor |
| 54 | Toplu ödeme hazırlama | Genişletme | F0'da doğrulanacak | Bekliyor |
| 56 | Banka masraflarının hizmet bazında analizi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 57 | Düzenli mali yükümlülük takvimi | Genişletme | `/settings/recurring` takvimli taslaklar | Bekliyor |
| 58 | Kaynakları açıklanan döviz pozisyonu | Genişletme | Kur kaynakları (`settings/` TCMB/KKTCMB) | Bekliyor |
| 60 | Demirbaş satış ve elden çıkarma | Genişletme | Demirbaş kartı ve amortisman var; elden çıkarma yok | Bekliyor |
| 61 | Varlık kullanımının gerçek maliyetle ilişkisi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 62 | Şirketler arası mutabakat ve mahsuplaşma | Genişletme | `consolidation` modülü | Bekliyor |

### F5 — Depo ve satın alma

Fiziksel yerleştirme, toplama, sayım, tedarik ve iade süreçlerini birbirine bağlamak.

Bağımlılık: F3, F4'ün ilk teslimi. Göreli büyüklük: Büyük; depo pilotu gerekir.

İş sırası:

1. Raf kapasitesi/uyumluluğu ve yönlendirmeli yerleştirmeyi pilot depoda uygula.
2. Toplama işi, parti seçimi ve mevcut sayıma kör sayım/bağımsız yeniden sayımı aynı stok kaynaklarıyla ekle.
3. İade kabulü → kalite kararı → kullanılabilirlik zincirini ve alış ek maliyet mutabakatını genişlet.
4. Tedarikçi ağırlıkları, çerçeve sipariş ve teslim randevusu ekle; talep değişkenliği önerilerini yeterli veriyle aç.

Tamamlanma ölçütü: Yerleştirme/toplama ikinci stok hareketi oluşturmuyor; kalite bekleyen miktar satışa açılmıyor; sayım farkı onaylı düzeltmeyle işleniyor.

İlk teslimata alınacak öneriler: 43, 44, 45, 51, 52.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 43 | Yönlendirmeli depo yerleştirme | İlk kapsam | Raf/lokasyon modeli yok (F0'da doğrulanacak) | Bekliyor |
| 44 | Sipariş toplama sırası ve güzergâhı | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 45 | Döngüsel sayım ve bağımsız yeniden sayım | İlk kapsam | `inventory/counts.ts`, `stockCounts` tabloları | Bekliyor |
| 51 | Alış ek maliyetleri ve fark mutabakatı | İlk kapsam | `landed` modülü | Bekliyor |
| 52 | İade kabulünden son karara iş akışı | İlk kapsam | İade akışları (returns testleri) | Bekliyor |
| 46 | Talep değişkenliğine göre stok önerileri | Genişletme | `procurement/replenishment.ts` min–hedef önerisi | Bekliyor |
| 47 | Son kullanma ve raf ömrü riski | Genişletme | F0'da doğrulanacak | Bekliyor |
| 48 | Açık ağırlıklarla tedarikçi değerlendirme | Genişletme | `procurement/performance.ts` | Bekliyor |
| 49 | Çerçeve satın alma anlaşmaları | Genişletme | `procurement/commitments.ts` (F0'da kapsamı doğrulanacak) | Bekliyor |
| 50 | Tedarik teslimat randevuları | Genişletme | F0'da doğrulanacak | Bekliyor |

### F6 — Satış ve ticari kararlar

Fiyat, maliyet, müşteri riski ve satış sorumluluğunu işlem kararına bağlamak.

Bağımlılık: F3, F4'ün ilk teslimi. Öneri 37 için F7 temeli. Göreli büyüklük: Büyük.

İş sırası:

1. Gerçek satış sorumlusu ve teklif revizyon/taviz geçmişini kur; sorumlu değişikliklerini geçmişiyle sakla.
2. Maliyet görüntüsü, katkı sınırı ve mevcut kredi limiti kontrolünü fatura aşamasından teklif/sipariş onayına taşı.
3. İtiraz dosyası ve yenileme fırsatlarını müşteri kaydına bağla.
4. Set/paket ve ürün seçeneklerini stok/malzeme etkisiyle tamamla; prim ve sadakati açık kurallarla daha sonra aç.

Tamamlanma ölçütü: Teklif maliyet kaynağı açıklanıyor; iade/iptal ticari ve prim hesaplarına tutarlı yansıyor; set bileşenleri stokta tekrar tüketilmiyor.

İlk teslimata alınacak öneriler: 13, 33, 34, 35, 38, 39.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 13 | Satış sorumlusu, hedef ve ticari kârlılık | İlk kapsam | Satış raporunda şube ve kaydı oluşturan kullanıcı kırılımı; sorumlu modeli yok | Bekliyor |
| 33 | Teklif geçerliliği ve güncel maliyet farkı | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 34 | Müzakere ve ticari taviz geçmişi | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 35 | Asgari katkı kontrolü | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 38 | Müşteri risk limiti kontrolü | İlk kapsam | `parties.creditLimit`; satış faturası kaydında uyarı (`invoices/posting.ts`) | Bekliyor |
| 39 | Ticari itiraz ve anlaşmazlık dosyası | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 36 | Set, paket ve birleşik ürün yönetimi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 37 | Müşteri seçenekleriyle ürün yapılandırma | Genişletme (F7 temeli) | F0'da doğrulanacak | Bekliyor |
| 40 | Sözleşme ve müşteri yenileme fırsatları | Genişletme | F0'da doğrulanacak | Bekliyor |
| 41 | Açıklanabilir satış primi hesabı | Genişletme | Yok | Bekliyor |
| 42 | Sadakat ve müşteri avantajı geçmişi | Genişletme | `/sales/campaigns` yüzdelik promosyon | Bekliyor |

### F7 — Ortak üretim motorunun derinleştirilmesi

Mevcut MES/kapasite/WIP/kalite altyapısını daha doğru plan ve gerçekleşen analizine taşımak.

Bağımlılık: F3, F4'ün ilk teslimi. Fason ve kalite genişletmeleri F5'in iade–kalite zincirinden yararlanır ama onu beklemez. Göreli büyüklük: Büyük; üretim pilotu gerekir.

İş sırası:

1. Planlanan–gerçekleşen karşılaştırmasını mevcut plan sürümleri üzerine kur.
2. Sıraya bağlı hazırlık süresi, takım/aparat ve operatör becerisini kapasite kısıtına ekle.
3. Yakın dönem plan koruması ve acil sipariş etkisini sürümlü senaryolarla tamamla.
4. Fason kapsam, sayısal kalite ve fiziksel üretim dengesini mevcut batch/rework kaynaklarına bağla.
5. Sayaç esaslı bakım ve malzeme/işçilik/fason/gider sapma analizini gerçek kaynaklarla genişlet.

Tamamlanma ölçütü: Deneme planı gerçek stok/takvimi değiştirmiyor; uygun olmayan kaynakta iş başlamıyor; WIP/mamul/gerçek gider aynı maliyeti tekrar taşımıyor.

İlk teslimata alınacak öneriler: 14, 63, 64, 65, 66, 72.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 14 | Üretim planı ile gerçekleşen sonuçların karşılaştırılması | İlk kapsam | ATP/CTP, sonlu kapasite, plan sürümleri, müdahale listesi (MANUFACTURING-ACCEPTANCE) | Bekliyor |
| 63 | Üretimde sıraya bağlı hazırlık süreleri | İlk kapsam | Yok | Bekliyor |
| 64 | Kalıp, takım ve aparat kapasitesi | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 65 | Operatör becerisi ve iş ataması | İlk kapsam | Yok | Bekliyor |
| 66 | Yakın dönem üretim planını sabitleme | İlk kapsam | Plan sürümleri (F0'da doğrulanacak) | Bekliyor |
| 72 | Üretim maliyet sapmasının bileşenleri | İlk kapsam | Standart malzeme karşılaştırması (F0'da doğrulanacak) | Bekliyor |
| 67 | Acil siparişin diğer işlere etkisi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 68 | Fason kapsam ve sonuç doğrulama | Genişletme | Fason miktar/maliyet izi (`subcontracts`) | Bekliyor |
| 69 | Ağırlık/hacim esaslı üretim dengesi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 70 | Sayısal kalite ölçümlerinin analizi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 71 | Sayaç ve durum bilgisine dayalı bakım | Genişletme | Takvimli bakım | Bekliyor |

### F8 — Deri atölyesi

Parça, kalıp, kusur, ton ve operasyon izini özel ürün maliyetiyle birleştirmek.

Bağımlılık: F4'ün ilk teslimi. 77–79 için F7'nin operasyon/kalite teslimatı. Göreli büyüklük: Büyük; fiziksel ölçüm pilotu gerekir.

İş sırası:

1. `LeatherPages.tsx` dosyasını iş akışı sınırlarına göre böl (öneri 22 ile birlikte); yeni ekranlar bölünmüş yapıya eklenir.
2. Kalıp ölçek/revizyon doğrulaması, kusur kullanım koşulları ve ton gruplarını birlikte ele al.
3. Kalan parça görsel aramasını rezervasyon ve alan hesabıyla tamamla.
4. Yapıştırma/dikiş/aksesuar izini ortak operasyon ve kalite motoruna bağla.
5. Prototip, sezon ve özel ölçü kabulünü ayrı sipariş/üretim durumlarıyla genişlet.

Tamamlanma ölçütü: Alan hesabı tutarlı; kalan parça ikinci stok değeri oluşturmuyor; kabul edilen kalıp/ölçü revizyonu üretimde korunuyor.

İlk teslimata alınacak öneriler: 15, 73, 74, 75, 76, 79.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 15 | Deri malzemesinden ürün maliyetine görünüm | İlk kapsam | Parça alanı, kullanılabilir alan, kusur bölgesi, damar yönü, kesim planı (LEATHER-FASHION) | Bekliyor |
| 73 | Dijital kalıp ölçü ve revizyon doğrulaması | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 74 | Sipariş/set bazında ton uyumu | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 75 | Kusur bölgelerinin kullanım alanına etkisi | İlk kapsam | Kusur bölgesi kaydı var | Bekliyor |
| 76 | Kalan deri parçalarını görsel bulma | İlk kapsam | Kalan parça ve maliyet izi | Bekliyor |
| 79 | Aksesuar partilerinin ürün izi | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 77 | Yapıştırma ve kaplama işlem koşulları | Genişletme | F0'da doğrulanacak | Bekliyor |
| 78 | Dikiş hatası ve neden analizi | Genişletme | Rework akışı | Bekliyor |
| 80 | Numune ve prototip maliyeti | Genişletme | F0'da doğrulanacak | Bekliyor |
| 81 | Sezon ve ürün yaşam döngüsü | Genişletme | F0'da doğrulanacak | Bekliyor |
| 82 | Özel ölçü siparişinde müşteri kabulü | Genişletme | F0'da doğrulanacak | Bekliyor |

### F9 — İnşaat ve gayrimenkul

Mevcut Proje 360 kayıtlarından daha uygulanabilir saha ve ticari kararlar üretmek.

Bağımlılık: F3, F4'ün ilk teslimi. Göreli büyüklük: Büyük; IFC/geometri ayrı teknik teslimat.

İş sırası:

1. İş cephesi hazırlığı, ekip/ekipman kısıtı ve saha koşulu etkisini programla birleştir.
2. Ölçüm/kabul farkını hakedişe, değişikliği maliyet/süre/tahsilat dosyasına bağla.
3. İhale kararı, güvenlik takip ve teslim kontrol süreçlerini kaynak belgelerle genişlet.
4. IFC revizyon farkını önce tamamla; çakışma incelemesini sonraki bağımsız teslimat yap.
5. Taksit yeniden yapılandırmasını eski plan/tahsilat/muhasebe izini koruyarak uygula.

Tamamlanma ölçütü: Onaylanmamış değişiklik kesin gelir sayılmıyor; aynı saha miktarı iki kez hakedişe girmiyor; yeniden yapılandırmada tahsilat geçmişi değişmiyor.

İlk teslimata alınacak öneriler: 16, 84, 87, 88, 91, 92.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 16 | İnşaat değişikliklerinde maliyet/süre/tahsilat etkisi | İlk kapsam | Proje 360: risk, çizim revizyonu, saha değişikliği, süre uzatımı, hakediş bağlantıları (CONSTRUCTION-360) | Bekliyor |
| 84 | Şantiye iş cephesi hazırlığı | İlk kapsam | Hazırlık kontrolleri (F0'da doğrulanacak) | Bekliyor |
| 87 | İnşaat ekip ve ekipman dengeleme | İlk kapsam | İş bağımlılıkları/program | Bekliyor |
| 88 | Taşeron ölçüm ve kabul farkları | İlk kapsam | `subcontracts`, metraj | Bekliyor |
| 91 | Teslim öncesi aşamalı kontrol | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 92 | Gayrimenkul taksit planını yeniden yapılandırma | İlk kapsam | `realestate` modülü taksit planları | Bekliyor |
| 83 | İhalede katılım kararı | Genişletme | F0'da doğrulanacak | Bekliyor |
| 85 | IFC revizyonları arasında eleman/miktar farkı | Genişletme | IFC görünümü (`construction-control`) | Bekliyor |
| 86 | Model çakışmalarını saha aksiyonuna bağlama | Genişletme | RFI kayıtları | Bekliyor |
| 89 | İş güvenliği olayında neden/takip dosyası | Genişletme | Güvenlik aksiyonları | Bekliyor |
| 90 | Hava ve saha koşullarının program etkisi | Genişletme | Günlük rapor | Bekliyor |

### F10 — Mobil kullanım ve personel

Telefon, atölye ve personel işlemlerini kısa görev akışlarıyla tamamlamak.

Bağımlılık: F1, F2a, F3. Puantaj ve ücretle ilgili işler F4'ü bekler. Göreli büyüklük: Orta–büyük.

İş sırası:

1. İnşaat pilot görevi (telefondan saha kaydı) için bir mobil görev akışı ve görünür eşitleme kuyruğu tamamla; ardından depo ve atölye akışlarını aynı kalıpla ekle.
2. Puantaj düzeltme talebi, izin/vardiya ve personel portalını güncel ay/ücret yetkileriyle uygula.
3. İşe giriş/ayrılış kontrol listesi ve açık hedef görüşmelerini ekle.
4. PDKS ham olay → eşleme → inceleme → puantaj akışını ayrı bağlantı pilotuyla tamamla.

Tamamlanma ölçütü: Ağ kesintisi sonrası taslak korunuyor; tekrar eşitleme çift kayıt oluşturmuyor; çalışan yalnız kendi izinli belgesine erişiyor; kapalı ay kuralı korunuyor.

İlk teslimata alınacak öneriler: 17, 93, 94, 97.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 17 | Göreve göre mobil ve çevrimdışı deneyim | İlk kapsam | PWA, kamera barkodu, şifreli çevrimdışı taslak | Bekliyor |
| 93 | Çalışan kişisel belge ve ücret portalı | İlk kapsam | Yok; `workspace/portal.ts` müşteri portalı | Bekliyor |
| 94 | Puantaj düzeltme talepleri | İlk kapsam | `hr/attendance.ts` | Bekliyor |
| 97 | İşe giriş/ayrılış kontrol listeleri | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 95 | İzin/vardiya talebinde ekip kapasitesi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 96 | Çalışan hedefi ve değerlendirme geçmişi | Genişletme | Yok | Bekliyor |
| 112 | PDKS/cihaz aktarım doğrulaması | Genişletme | F0'da doğrulanacak | Bekliyor |

### F11 — AI, OCR ve dış bağlantılar

Açıklanabilir veri yardımı ve kontrollü bağlantıları gerçek kullanımda doğrulamak.

Bağımlılık: F1, F3. Öneri 105 için F4; öneri 108 ve 109 için F5. Göreli büyüklük: Büyük; canlı hesap ve sağlayıcı kabulü gerekir.

İş sırası:

1. AI yanıtlarına kaynak/dönem/kapsam ekle (F1'deki kısa işlem yapısı üzerine); doğal dil filtresini açık seçimlerle uygula.
2. OCR alan kaynakları ve belge tekrar kontrolünü insan doğrulamalı taslak akışına bağla.
3. Onaylı bilgi araması ve olağan dışı işlem önerilerini ayrı değerlendirme setleriyle aç.
4. SKU/lokasyon eşleme, kanal fark çözümü ve hata senaryolarını canlı bağlantı öncesi dene; dış stok gönderimini elle başlatma tercihini koru.

Tamamlanma ölçütü: AI/OCR doğrudan mali kesinleştirme yapmıyor; yetki kaynak ve yanıt aşamasında korunuyor; eski dış olay mali belgeyi değiştirmiyor; canlı sağlayıcı sonucu ayrıca kabul edilmiş.

İlk teslimata alınacak öneriler: 18, 103, 104, 108, 109, 110.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 18 | Kaynak ve kapsam açıklayan AI yanıtları | İlk kapsam | `ai` modülü kontrollü araçlarla veri okuyor (ADA-AI) | Bekliyor |
| 103 | Alan kaynaklı OCR doğrulaması | İlk kapsam | OCR ertelenmiş (COUNTRY-IMPLEMENTATION) | Bekliyor |
| 104 | İçerik üzerinden belge tekrar kontrolü | İlk kapsam | Dosya hash kontrolü | Bekliyor |
| 108 | Kanallar arası stok farkı çözümü | İlk kapsam | `platform-integrations`, elle stok gönderimi | Bekliyor |
| 109 | SKU/lokasyon eşleme yaşam döngüsü | İlk kapsam | Kanal eşlemeleri | Bekliyor |
| 110 | Entegrasyon hata ve yetki senaryoları | İlk kapsam | F0'da doğrulanacak | Bekliyor |
| 105 | Açıklanabilir olağan dışı işlem incelemesi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 106 | Doğal dilden rapor filtresi | Genişletme | F0'da doğrulanacak | Bekliyor |
| 107 | Onaylı işletme içi bilgi araması | Genişletme | Yok | Bekliyor |

### F12 — Büyük veri ve sürüm işletimi

Pilot sonrası büyüyen veri, rapor ve güncellemelerde işletim sınırlarını doğrulamak.

Bağımlılık: F1, F3, seçilen sektör fazı. Göreli büyüklük: Orta–büyük; ölçülen veri hacmine bağlı.

İş sırası:

1. Uçtan uca teknik izleri ve DB eğilimlerini ölç; önce kanıtlanan darboğazı düzelt.
2. Büyük raporu kuyruk, tutarlı veri görünümü, ilerleme, iptal ve süreli indirmeyle tamamla.
3. Dosya/işlem kapasitesi ve güncelleme öncesi deneme kurulumunu gerçek paketle doğrula.
4. F1'de kurulan değişmez kural ve tekrar istek testlerini her pilot sektörün uçtan uca görevine genişlet.

Tamamlanma ölçütü: Tanımlı veri hacminde süre/bellek hedefi sağlanıyor; bozuk/uyumsuz güncelleme canlı veriyi bozmuyor; kayıp cevap ve tekrar istek dört sektör akışında da çift mali/stok etkisi oluşturmuyor.

İlk teslimata alınacak öneriler: 20, 113, 114, 119.

| Öneri | İş | Teslimat | Mevcut temel | Durum |
|---|---|---|---|---|
| 20 | Arka planda büyük rapor hazırlama | İlk kapsam | XLSX akışla yazılıyor; rapor sorguları belleğe alınıyor (ENTERPRISE-EXPANSION) | Bekliyor |
| 113 | Uçtan uca teknik izleme | İlk kapsam | Yok (OpenTelemetry yok) | Bekliyor |
| 114 | Veritabanı performans eğilimleri | İlk kapsam | Yok (pg_stat_statements kullanılmıyor); PERFORMANCE kaydı | Bekliyor |
| 119 | Güncelleme öncesi uyumluluk/deneme kurulumu | İlk kapsam | `system/updates.ts` | Bekliyor |
| 115 | Dosya ve işlem kapasitesi bütçesi | Genişletme | F0'da doğrulanacak | Bekliyor |

## Paralel dış hat

Dış kişi, hesap veya cihaz bekleyen işler bu hatta izlenir. Bağlı oldukları fazın ilk kapsamını kilitlemezler; hazır olduklarında ilgili faza teslimat olarak eklenirler.

| İş | Beklenen dış girdi | Bağlı faz |
|---|---|---|
| 10 — Türkiye/KKTC mali referans senaryoları | Mali uzman incelemesi, referans hesaplar | F4 |
| Canlı Gemini hesabı ile AI kabulü | Sağlayıcı hesabı | F11 |
| Resmî e-belge, e-imza, banka ödeme dosya biçimleri | Servis/banka hesapları | F4, F3 |
| PDKS cihaz bağlantısı (112) | Fiziksel cihaz | F10 |
| Dört sektör pilot şirketi ve kullanıcıları | Pilot müşteriler | F0, tüm sektör fazları |

## İş kartı şablonu

Her uygulama kartı şu bilgileri içerir: faz/öneri numarası, tek kullanıcı görevi, mevcut temel (dosya/modül), mevcut davranış, beklenen davranış, kapsam, kaynak kayıtlar, bağımlılıklar, eski veri etkisi, uygun doğrulama (değişmez testi dahil), pilot kabul sonucu. Faz tamamlanması, yalnız ekranın görünmesiyle değil yukarıdaki kabul ölçütüyle değerlendirilir.

## Kapsam kontrolü

122 öneri, 14 faza (F0, F1, F2a, F2b, F3–F12) birer kez atanmıştır: F0 2, F1 9, F2a 4, F2b 10, F3 8, F4 14, F5 10, F6 11, F7 11, F8 11, F9 11, F10 7, F11 9, F12 5 = 122. Öneri numaraları önceki yanıtlardaki numaralarla aynıdır. Teknik ve mali ortak kabul koşulları, ana fazı farklı olan işlerde de uygulanır.

## Değişiklik kaydı

**11 Ekim 2026 — Teslimat 0 durumu**

- `claude/teslimat-0-ci` dalında CI'ın üç işi de yeşil: denetim ve testler (lint, tip, birim/entegrasyon, geri yükleme tatbikatı, lisans ve bağımlılık denetimi, derlemeler), Docker imajı ve compose duman testi, uçtan uca testler (88 geçti, 1 isteğe bağlı çevrimdışı üretim kontrolü atlandı).
- Bulunan ürün hataları da düzeltildi: sıkıştırılmış `index.html` 5 dk önbellekte kalıyordu; başarılı kayıttan sonra yanlış "kaydedilmemiş değişiklikler" sorusu (bordro, SGK, yabancı işçi, inşaat, kampanya, ülke bordro kuralı); MFA kapatma ve içe aktarma "Geri" adımı kapatma sayılıyordu; 320/390 px üst çubuk taşması; cihazlar sayfasında sonsuz yükleme; lisans sunucusu imajı derlenmiyordu.
- Bordro, SGK ve personel cari E2E senaryoları KKTC ülke motoruna göre yeniden yazıldı (TEST değerleri, resmî oran değildir).
- Kalan: dalın main'e birleştirilmesi ve açık PR'ların (#12–#22) karara bağlanması. Üretim demosunda bir kez görülen "Uygun kaynak kapasitesi bulunamadı" hatası tekrar etmedi; izlenecek.


**10 Ekim 2026 — kod karşılaştırmalı gözden geçirme**

- Teslimat 0 eklendi: main CI son push'ta lint ve E2E işlerinde başarısız. Lint durduğu için tip denetimi, testler ve geri yükleme tatbikatı çalışmadı. #12–#22 PR'ları açık.
- Pilot kapsamı dört sektöre genişletildi; her sektör için bir görev ve bir ortak görev tanımlandı.
- Sektör fazları arasındaki gereksiz bağımlılıklar kaldırıldı: F6, F7 ve F9 artık F5'i, F7 de F6'yı beklemiyor.
- F2 ikiye bölündü: F2a (5, 24, 28, 31) ve F2b (1, 2, 8, 23, 25–27, 29, 30, 32).
- 120 ve 121, F12'den F1'e taşındı; F3'ün tekrar etki ölçütü bu testlerle kanıtlanacak.
- 101 ve 102, F3'ten F1'e taşındı (gizlilik).
- 11'in boyut alanı F4'ün ilk kapsamına alındı; 10 paralel dış hatta yürüyecek.
- Mevcut altyapı tablolara işlendi: sunucu tercihleri (5), üretim outbox'ı (111), kredi limiti uyarısı (38), toplu fatura önizlemesi (6), kurulum listesi (1, 8), iş uyarıları (2), kayıt bağlantıları (3, 4), sayım tabloları (45).
- Başlıklar Markdown başlığına çevrildi; "Mevcut temel" ve "Durum" sütunları eklendi.
