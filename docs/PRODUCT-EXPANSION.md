# Ada Muhasebe geliştirme programı

Başlangıç: 5 Ekim 2026. Kullanıcı kapsamı: değerlendirmede önerilen geliştirmelerin tamamı.

## Uygulama sırası ve kabul koşulları

| Aşama | Kapsam | Kabul koşulu | Durum |
|---|---|---|---|
| 1 | Bugünkü işlerim, bildirim ve görev takibi | Yetkili kaynaklardan uyarı, sorumlu, vade, tamamlama ve erteleme; şirketler arası veri sızıntısı yok | Geliştiriliyor |
| 2 | Belge arşivi | Kayıt bağlantısı, PDF/görsel yükleme ve indirme, sürüm geçmişi, kaynak kayıtla aynı izin | Planlandı |
| 3 | Genel kayıt araması | Cari, fatura, proje, sözleşme; sunucuda izin/modül kontrolü, sınırlı sonuç | Planlandı |
| 4 | İlk kullanım rehberi | Gerçek kurulum durumundan hesaplanan adımlar ve ilgili ekran bağlantıları | Planlandı |
| 5 | Tahsilat çalışma ekranı | Cariyle bağlantılı görüşme, ödeme sözü, sorumlu ve sonraki takip tarihi | Planlandı |
| 6 | Mobil şantiye | Günlük rapor, puantaj/mal kabul/talep bağlantıları, şirket ve kullanıcıya ayrılmış çevrimdışı taslak | Planlandı |
| 7 | İş programı | Proje ve iş kalemi, tarih, bağımlılık, döngü koruması, gecikmenin teslim tarihine etkisi | Planlandı |
| 8 | Ekipman/araç | Envanter, proje ataması, çalışma/yakıt/bakım/kira kayıtları, muhasebe belgesine bağlantı; çift maliyet yazımı yok | Planlandı |
| 9 | Daire teslim/kusur | Birime bağlı fotoğraflı kusur, sorumlu, termin, kapatma ve yazdırılabilir teslim tutanağı | Planlandı |
| 10 | Müşteri/taşeron portalı | Ayrı dış kullanıcı kimliği, sadece atanan cari/sözleşme kapsamı, iptal edilebilir erişim ve denetim | Planlandı |
| 11 | Nakit senaryoları | Kaynak tahmin korunur; gecikme/maliyet varsayımları ayrı tutulur, dönem dışına kayan tutarlar açıklanır | Planlandı |
| 12 | Performans ve dokümanlar | Ölçülebilir yük senaryosu, çıktı/bellek sınırları, mevcut ve yeni işlevlerle tutarlı dokümanlar | Planlandı |
| 13 | Gerçek kullanıcı pilotu | Muhasebeci, şantiye sorumlusu ve yöneticinin görev süreleri/hataları kaydedilir | Katılımcı gerekiyor |
| 14 | Resmî entegrasyonlar | Doğrulanmış mevzuat, resmî test erişimi ve mükellef yetkilendirmesiyle uçtan uca doğrulama | Dış bağımlılık |

## Ortak uygulama kuralları

- Yeni özellikler mevcut RLS, modül ve izin kapılarından geçer. Belgeye sahip olmak kaynak kayda erişim kazandırmaz.
- İş takip ve saha kayıtları muhasebeleştirme yerine geçmez; mali işlemler mevcut fatura, stok ve kasa/banka akışlarında kalır.
- Çevrimdışı kayıtlar onaylanmış mali belge olmaz. Tekrar gönderim aynı kaydı çoğaltmaz.
- Tamamlandı durumu kod, kullanılabilir ekran ve ilgili doğrulamalar birlikte bittiğinde verilir.
- Canlı müşteri veritabanına taşıma, dış kişiye davet/bildirim gönderme ve mevzuat teyidi geliştirme testinden ayrı kaydedilir.

## Pilot görevleri

1. Muhasebeci: geciken alacağı bul, ödeme sözü kaydet, dekontu iliştir, asıl tahsilat ekranına geç.
2. Şantiye sorumlusu: telefonda günlük rapor gir, bağlantı kesilince taslak sakla, tekrar gönder.
3. Yönetici: bekleyen işleri incele, sorumlu ata, gecikme/nakit senaryosu etkisini değerlendir.

Her görev için başlangıç/bitiş, yanlış işlem sayısı, yardım ihtiyacı ve kullanıcı yorumu kaydedilir. Gerçek katılımcı testi yerine otomasyon sonucu yazılmaz.
