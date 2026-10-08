# Tasarım sistemi

Arayüz editoryal bir finans yayını gibi davranır: kırık beyaz kâğıt zemin, beyaz kartlar, 1px ince çizgiler ve **tek bir vurgu rengi** (limon sarısı). Tüm belirteçler `apps/web/src/styles.css` içindedir; bileşenler yalnızca anlamsal Tailwind sınıflarını (`bg-surface`, `text-muted`, `bg-brand`…) kullanır, ham renk yazılmaz.

## İlkeler

1. **Tek vurgu, yalnızca eylem yüzeyinde.** Sarı (`--brand`) yalnızca birincil düğme dolgusu, aktif menü/sekme dolgusu, ilerleme çubuğu, başarı bildirimi işareti ve odak halkasının **koyu temadaki** rengi olarak kullanılır. Sarı asla metin rengi, geniş arka plan yıkaması veya süs değildir; üstündeki metin her zaman Ink'tir (≈16:1).
2. **Tek ağırlık (400).** Kalın yazı yoktur; Tailwind `font-medium/semibold/bold` sınıfları `@theme` ile 400'e eşlenmiştir. Hiyerarşi boyuttan (10–64px ölçeği), renkten (Ink / Ash) ve büyük harf mikro etiketlerden gelir. Toplam ve grup satırları kalın yazıyla değil çizgi, Bone zemin ve büyük harfle ayrılır.
3. **Gölge yok, çerçeve var.** Yükseklik 1px hairline (`--border`) ve yüzey tonu (Bone → Beyaz → Obsidian) ile ifade edilir; `--shadow-*` belirteçleri `none`'dır. Tek istisna üst çubuktaki ince beyaz iç vurgudur. Kaplamalar (yan panel, modal, komut paleti) Obsidian/50 + 8px bulanıklık ile ayrılır.
4. **Sınırlı yarıçap:** düğme/etiket 6px, girdi 10px, yıkama kartı 12px, kart 16px. Hap ve daire yok (avatarlar kare).
5. **Sol menü kalır.** Yaklaşık 20 sayfalık bir ERP üst menüye sığmaz; kenar çubuğu beyaz + hairline, aktif öğe sarı dolgu. İçerik en çok 1200px genişliktedir.

## Belirteçler

| Rol                                  | Açık                              | Koyu                  |
| ------------------------------------ | --------------------------------- | --------------------- |
| Zemin `--bg` / yıkama `--surface-2`  | `#f4f2f0` (Bone)                  | `#131211` / `#242322` |
| Kart `--surface`                     | `#ffffff`                         | `#1a1919`             |
| Çizgi `--border` / `--border-strong` | `#e5e7eb` / `#d3d3d3`             | `#2e2c2b` / `#3d3b3a` |
| Metin `--text` / sönük `--muted`     | `#0c0a08` (Ink) / `#6d6c6b` (Ash) | `#f4f2f0` / `#a3a19f` |
| Vurgu `--brand` (yalnızca dolgu)     | `#e4f222`                         | `#e4f222`             |
| Koyu şerit `--inverted`              | `#1a1919` (Obsidian)              | `#262524`             |
| Odak halkası `--focus`               | Ink                               | sarı                  |

**Durum renkleri** (başarı/uyarı/hata) referanstaki "tek vurgu" kuralının bilinçli istisnasıdır: muhasebe uygulamasında hata, kritik stok ve negatif bakiye renkle de okunabilmelidir. Sönük tonlardadır ve yalnızca metin, simge ve küçük rozetlerde kullanılır (geniş alan dolgusu yok); anlam her zaman metin/simgeyle de verilir, yalnızca renge bağlı değildir.

Yazı tipi **Inter** (OFL, kendi sunucumuzdan) `ss01` özelliğiyle. Ölçek: `text-caption` 10px, `text-subheading` 20, `text-heading-sm` 24, `text-heading` 28 (sayfa başlığı, gösterge değeri), `text-heading-lg` 40 (genel bakış selamlaması, giriş paneli), `text-display` 64 (kullanılmıyor, ileride açılış sayfaları için).

## Bileşenler

- **Düğme:** birincil = sarı dolgu + Ink; ikincil = Ink çerçeveli şeffaf; hayalet (hover Bone); tehlikeli = kırmızı çerçeve/metin (dolgu yok). Yükseklik 40px (küçük 32px).
- **Girdi (`Field`):** 10px, hairline; odakta çerçeve Ink olur (halka yok).
- **Kart / `Stat`:** 16px, beyaz, hairline. `Stat` etiket + 28px değer.
- **Sayaç şeridi (genel bakış):** tek Obsidian şerit; 10px büyük harf etiket, 28px değer, bağlantılı göstergelerde sarı odak halkası.
- **Tablo:** başlık 11px büyük harf Ash, hairline satırlar, toplam satırı Bone.
- **`SegmentedTabs`:** sekme/seçici; aktif = sarı dolgu (`role=tab`, `aria-selected`).
- **Rozet:** 6px; `brand` tonu çerçeveli nötrdür; durum tonları sönük dolgulu.
- **Bildirim:** Obsidian zemin; başarıda sarı sol çizgi, hatada açık kırmızı çizgi + simge.
- **Bağlantı `.link`:** Ink + alt çizgi. Sarı metin yoktur.
- **Para birimi:** kod değil simge, tutarın önünde: `₺1.234,56`, negatifte `-₺1.234,56`; başlıkta `(₺)`; kurda `1 £ = ₺64,7268`. Tek kaynak `moneyIn`/`currencySymbol` (`lib/format`), seçiciler `CurrencyOptions` (dar satır içinde yalnızca simge, geniş formda "₺ Türk lirası"); seçenek `value`'su daima koddur.

## Erişilebilirlik

Tüm metin/zemin belirteç çiftleri WCAG AA (≥ 4.5:1) sağlar, odak halkası ≥ 3:1'dir (açık ve koyu tema; ölçüm betiği geliştirme sırasında çalıştırıldı). Koyu şeritteki etiketlerde referanstaki Ash (`#6d6c6b`, 3.4:1) yerine daha açık `--inverted-muted` (`#a3a19f`, ≥ 5.9:1) kullanılır. Odak halkası sarı yerine Ink'tir (sarı beyazda görünmez); koyu zeminlerde sarıdır. `prefers-reduced-motion` desteklenir; geçişler 0.3 sn ease-out ve yalnızca renk.

## Yeni ekran eklerken

`Card`, `Stat`, `Table*`, `SegmentedTabs`, `Badge`, `Callout`, `Button`, `Field` bileşenlerini kullanın; ham renk, gölge, `font-bold` ya da pill şekli eklemeyin. Vurguyu yalnızca eylem/aktif durum için kullanın. Kalın yerine boyut, renk ve büyük harf mikro etiketi (`.micro`) kullanın.

Tabloda UUID yerine okunabilir belge/kayıt kodu ve bağlantılı ürün, depo veya operasyon adı gösterin. Durum ve tahmin kaynaklarını Türkçe etiketleyin; tarihler ve miktarlar ortak biçimleyicilerden gelsin. Satır işlemleri küçük düğmeyle `Sheet` açsın; tablo hücresine büyük form yerleştirmeyin. Depo sekmesinde yalnız o sekmenin oluşturma formunu gösterin. Menüde görünen bir rota, aynı modül ve izin kapısından geçmelidir.

Ana içerikte tek dikey kaydırma alanı `AppShell` içindeki `main` olmalıdır. Sayfa tablolarına/listelerine `max-height` ile ikinci dikey kaydırma eklemeyin; geniş tablolar kendi yatay kaydırmasını korur. İçerik ve form alanlarında `min-w-0` kullanın. Dar ekranda araç çubukları ve eylemler satır atsın, arama alanı tam satır alsın. Düğmelerin yüksekliği en az 40px (küçükte 32px) olsun; uzun metinler yüksekliği artırabilsin. Para değerleri kesilmeden tam gösterilsin. Teknik kimlik denetimi UUIDv7 kayıtlarını da kapsar; görünen otomatik kodlar listede, ayrıntıda ve aramada aynı olmalıdır.
