# Müşteri geri bildirimi

ERP'nin üst çubuğundaki **Geri bildirim** düğmesi, bulunduğunuz sayfadan bir yan panel açar. Mobilde aynı düğme mesaj simgesiyle görünür.

Müşteri sorunun görüldüğü ekranı ve açıklamasını yazabilir, ekran görüntüsü ekleyebilir veya ikisini birlikte gönderebilir. Açıklama ya da görselden en az biri yeterlidir. Ekran adı otomatik doldurulur; isteğe bağlı ayrıntılarda “Sorundan hemen önce ne yapıyordunuz?” ve “Ne olmasını bekliyordunuz?” soruları vardır. PNG/JPG görselleri en fazla 5 MB olabilir; dosya seçme, sürükleme ve panoya kopyalanan görseli yapıştırma desteklenir. Önizlemeden görsel kaldırılabilir.

Gönderim başarısız olduğunda yazılar ve görsel aynı formda korunur. Paneli kapatıp tekrar açmak da taslağı korur; taslak tarayıcı belleğindedir, sayfa yenilenince veya şirket değişince korunmaz. Başarı yalnız satıcı sunucusu bildirimi kaydettiğinde gösterilir; kullanıcıya bildirim numarası verilir. Aynı gönderimi yeniden denemek ikinci bir kayıt üretmez. Kabul edilmiş bir bildirimin içeriği değiştirilerek tekrar gönderilirse arayüz bunu açıklar ve yeni bildirim için yeni kimlik kullanır.

## Yönetici kutusu

Satıcı lisans yönetimi panelindeki **Geri bildirimler** menüsü tüm müşterilerden gelen bildirimleri gösterir. Müşteri/şirket, gönderen, sayfa ve açıklama ile arama yapılabilir. Yeni, İncelemede ve Çözüldü filtreleri, durum sayaçları ve sayfalama vardır.

Ayrıntıda müşteri açıklaması, izlediği adımlar, beklediği sonuç, uygulama sürümü ve isteğe bağlı görsel görülebilir. Durum ve yalnız yöneticinin gördüğü inceleme notu güncellenebilir. Görseller yönetici oturumu gerektirir; değişiklikler mevcut CSRF ve denetim kaydı kurallarını kullanır. Gönderenden gelen özel alanlar HTML olarak çalıştırılmaz.

## Kurulum ve veri

Bu özellik merkezi satıcı lisans sunucusuna bağlı, doğrulanmış bir ERP kurulumu kullanır. Satıcı sunucusu ve ERP aynı özelliği destekleyen sürüme güncellenmelidir. Lisans sunucusunda `lisans-server/server/drizzle/0011_feedback.sql` migration'ı normal `db:migrate` süreciyle uygulanır; ERP veritabanında ek migration gerekmez. Görseller merkezi PostgreSQL'de saklanır ve veritabanı yedeğine dahildir. E-posta veya ayrı bir görsel dosya deposu gerekmez.

Alıcısı veya doğrulanmış lisans bağlantısı olmayan geliştirme/çevrimdışı kurulumlarda form durumu açıklar ve gönderme düğmesi kapalıdır. Bağlantı hatası gönderilmiş gibi gösterilmez. Doğrulanmış kurulum salt okunur lisans durumundayken destek bildirimi gönderebilir; bu istisna muhasebe ve diğer şirket kayıtlarını düzenleme hakkı vermez.

ERP sunucusu göndereni ve şirket bilgisini oturum/üyelik üzerinden ekler; müşteri istemcisinden gelen kimlik beyanlarını kabul etmez. Kurulum imzası, zaman kanıtı, tekrar gönderim kimliği ve içerik özeti merkezi sunucuda doğrulanır. Sayfa bilgisi yalnız yolu içerir; sorgu parametreleri ve erişim belirteçleri aktarılmaz. Görsellerin dosya türü, gerçek içeriği, boyutu ve piksel ölçüleri sunucuda denetlenir.

## Doğrulama

- `e2e/feedback-flow.spec.ts`: açıklama, görsel, ikisi birlikte, hata sonrası taslak ve tekrar gönderim, değişen içerik, kapalı destek bağlantısı; açık/koyu tema ve 320/390 piksel düzeni.
- ERP–satıcı entegrasyon testleri: gerçek iki uygulama ve iki test veritabanı üzerinden imzalı gönderim, merkezi kayıt, görsel, kullanıcı/şirket bilgisi, tekrar gönderim, erişim ve CSRF, ağ hatası ve salt okunur lisans desteği.
- Yönetici ekranının masaüstü/mobil ve koyu tema görüntüleri `.cache/feedback-review` ile ilgili panel inceleme klasöründe tutulur; bunlar sürüm paketine girmez.
