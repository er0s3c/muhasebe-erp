# Türkiye / KKTC uygulama ve geçiş kaydı

Bu kayıt, AI ve OCR dışındaki onaylı geliştirme planının kod karşılığını ve kalan yayın koşullarını izler. Bir özelliğin arayüzde bulunması mali mevzuat paketinin doğrulandığı anlamına gelmez. Eksik kaynak ve inceleme bilgisi kullanıcıya gösterilir.

## Ülke profili ve eski kayıtlar

- Yeni şirket oluştururken `jurisdiction: TR | KKTC` zorunludur. Ülke, şirket türü, KDV mükellefiyeti ve faaliyet bilgisi birlikte alınır.
- Mevcut şirketler `legacy_manual` olarak kalır. Eski fatura, yevmiye, kur ve bordro tutarları yeniden hesaplanmaz. İlk ülke kurulumu önizleme ve sürüm kontrolüyle kaydedilir.
- Kesinleşmiş mali geçmiş bulunan şirketin ülkesini değiştirme, API ve veritabanında engellenir. Aynı ülkenin tarihli profil sürümü geçmiş belge görüntülerini değiştirmez.
- Şirket saat dilimi istek başına ayrı tutulur. Türkiye ve KKTC'nin kışın farklı yerel günleri olabileceği test edilir. Dil ve defter para birimi ülke seçiminden ayrıdır.
- Profilin ve kuralların kaynak/sürüm bilgisi kesinleşmiş belgeye kaydedilir. İade ve iptal özgün belgenin görüntüsünü izler.

## Kur kaynağı

Türkiye şirketi TCMB, KKTC şirketi KKTC Merkez Bankası kaynağını kullanır. Kaynak hatası başka ülkenin kaynağına geçiş yapmaz. Döviz alış/satış ve efektif alış/satış ayrı tutulur; bulunmayan efektif kur uydurulmaz. Birim dönüşümü, ters kur ve TRY üzerinden çapraz kur desteklenir. Kullanılan kurun tarihi, kaynağı ve önceki iş gününden geldiği görünür.

TCMB otomatik aktarımı şirketin yerel saatiyle yayın sonrası çalışır. Önceki tarihli yayın döndüğünde o gün tamamlanmış sayılmaz. Manuel ve yüklenmiş XML kayıtları otomatik aktarımda korunur.

Kaynaklar: [TCMB yayın düzeni](https://www.tcmb.gov.tr/wps/wcm/connect/TR/TCMB%2BTR/Main%2BMenu/Temel%2BFaaliyetler/Doviz%2BEfektif/Doviz%2Bve%2BEfektif%2BPiyasalari/Gosterge%2BNiteligindeki%2BKurlar), [KKTC kur tablosu](https://www.kktcmerkezbankasi.org/veriler/doviz_kurlari/kur_sorgulama).

## İşlem vergileri ve bordro

Standart KDV oranları ülke ve belge tarihinden seçilir. Özel işlem kuralları ayrıca belge türü, ürün/hizmet sınıfı, işlem türü ve carinin vergi durumunu denetler. Sıfır oran ve istisna ayrı saklanır; istisna kodu zorunludur. Tevkifat, stopaj ve damga/pul tanımı kaynak ve mali inceleme gerektirir. Bu parametreler ürün açıklamasından tahmin edilmez.

Fatura satırlarının vergi görüntüleri, cari net ödenecek tutarı ve ayrı yükümlülükleri yevmiyeye aktarılır. Belge kapsamındaki damga/pul istisnası ve tavanı her satırda yeniden uygulanmaz. Kısmi iade özgün satırın hesabını kullanır; son iade kuruş farkını kapatır. Kesinleşmiş görüntüler değiştirilemez.

Türkiye ücret bordrosu tarihli dilimler, kümülatif matrah, asgari ücret istisnası, prim tabanı/tavanı ve işsizlik primini kullanır. İlk paket standart 4/a ücret bordrosuyla sınırlıdır; emekli, teşvik veya farklı çalışan rejimi otomatik tahmin edilmez. KKTC bordrosu 12/13 dönemli tarifeyi, kişisel indirimleri, sigorta ve İhtiyat Sandığını ayrı tutar. Doğrulanmış tarihli prim yapılandırması olmadan yeni ülke bordrosu eski düz oran hesabına düşmez.

Kaynaklar: [GİB KDV Genel Uygulama Tebliği](https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Ffileadmin%2Fuser_upload%2FTebligler%2FKDV%2Fkdv_genteb.htm), [KKTC Gelir ve Vergi Dairesi](https://www.vergi.gov.ct.tr/), [SGK](https://www.sgk.gov.tr/). Kaynakların yürürlük ve kapsam incelemesi ayrı ülke pilotunun yayın koşuludur.

## Plan aşamalarının kod karşılığı

| Aşama | Mevcut temel / bu çalışma | Tamamlanması gereken kapsam |
|---|---|---|
| 0 — Sağlamlaştırma | Ekran taşması, koyu logo, Türkçe metinler, bakım akışı ve yönetici geri bildirim kutusu; dokuz güncel PR incelemesi; dokunarak açılan rehber ve veritabanı hazır olmasını bekleme | Son değişikliklerin ortak regresyonu ve uzak PR başlarındaki düzeltmeler |
| 1 — Ülkeler | Önizlemeli ülke profili, dört kur, tarihli işlem vergisi, ülke bordrosu, değişmez belge görüntüleri | Mali referanslarla ayrı pilot; tüm çalışan rejimleri, ülkeye özgü amortisman/harç ve resmî dönem raporlarının kapsamı |
| 2 — Yetki ve şube | Ayrı CRUD/dışa aktarma kapıları, özel roller, gerçek şube kapsamı, oturum yönetimi, güvenlik ve denetim kayıtları; şifreli yedek temeli | Şube sınırının ve rol yükseltme engellerinin ortak güvenlik regresyonu |
| 3 — Operasyon | Satın alma/POS/lojistik ticaret ve perakendeye açıldı; minimum-hedef stoktan satın alma önerisi ve mevcut üretim/deri/inşaat motorları | Genel varyant/lot/garanti, teklif revizyonları, genel servis/teknisyen akışı |
| 4 — Kullanım / belge | Belge seri ayarları, sade/ayrıntılı fatura PDF şablonları, ortak CSV/Excel aktarım merkezi, manuel WhatsApp paylaşım bağlantısı | Müşteriye belge e-postası ve geçmişi, arşiv sürümleri, kayıtlı filtre/toplu işlem ve sektör kurulum şablonları |
| 5 — Mobil | PWA, kamera barkodu, şifreli depo/saha taslak kuyruğu; güncel yetki/şube kontrolleri ve tekrar güvenli eşitleme | Etiket çıktısı kapsamı ve saha pilotu; mali kesinleştirme sunucuda kalır |
| 6 — Rapor | ABC, hareketsiz stok, devir, tedarikçi raporları; satış/alışta şube ve kaydı oluşturan kullanıcı kırılımı, CSV/Excel bağlantısı | Gerçek satış sorumlusu/personel modeli, açık hedef/ağırlıklı sağlık puanı ve kapsamlı kâr senaryoları |
| 7 — İş akışı / bağlantı | Fatura/teklif/ödeme/gider onay kuralları; kapsamı ve süresi sınırlı API anahtarları, tekrar güvenli taslak API'si, imzalı webhook teslimi | Kullanıcı tanımlı olay/koşul/eylem otomasyonları ve tekrarlayan taslakların kapsamı |
| 8 — Portal / paket | İzin kapsamlı müşteri fatura/teklif/sipariş/bakiye portalı; mevcut lisans ve modül temeli | QR belge doğrulaması, ticari abonelik ve kullanım sınırları |

Resmî e-belge servisleri, hukuki e-imza, WhatsApp Business ve online ödeme bağlantıları sonraki bağlantı aşamasındadır. OCR ertelenmiştir. Kullanıcının ayrıca eklediği AI modülünün inceleme kapsamı ve sınırları [Ada AI kaydında](ADA-AI.md) açıklanır.

## Doğrulama ve yayın

Test veritabanı yalnız `erp_test` üzerinde sıfırlanır. Geliştirme veritabanına yalnız artımlı migration uygulanır; demo sıfırlaması bu çalışmanın yayın adımı değildir. Eski mali kayıtlar ve şubesi bilinmeyen kayıtlar tahminle doldurulmaz. Sentetik demo/test geçmiş oranları resmî mevzuat paketinden ayrı işaretlenir.

Ortak kontroller: shared/API/web/lisans tip kontrolü ve lint; gerçek RLS/DB entegrasyonu; kur, vergi, bordro, iade, eski tutar ve eşzamanlılık regresyonları; açık/koyu tema ve mobil/masaüstü arayüz; üretim derlemesi. Sonuçlar ilgili test dosyaları ve çalışma raporuyla birlikte güncellenir. Ülke paketi mali doğrulama tamamlanmadan tam mevzuat uyumlu olarak sunulmaz.
