# Muhasebe ERP tanıtım videosu (Remotion)

Yaklaşık 1 dakikalık, 1080p, Türkçe seslendirmeli ve alt yazılı tanıtım videosu. Ana uygulamadan bağımsızdır (kök npm çalışma alanlarına dahil değildir); video kodu, seslendirme metni ve ekran görüntüleri bu klasördedir. Tamamen ücretsiz araçlarla üretilir.

**Yapı (toplam ≈ 61 sn, 7 sahne, her bölümün başlık kartı var):**

| # | Sahne | Süre* | Ekranlar |
|---|---|---|---|
| – | Açılış | ≈ 8 sn | Genel bakış, para birimi simgeleri |
| 01 | Muhasebe çekirdeği | ≈ 11 sn | Yevmiye kayıtları, para birimi ve kurlar |
| 02 | Cari, stok ve fatura | ≈ 8 sn | Satış faturası, "tek işlemde" akışı |
| 03 | Kasa ve banka | ≈ 8 sn | Hesaplar, hareketler |
| 04 | İnşaat modülü | ≈ 11 sn | Proje özeti, taşeron sözleşmeleri, satış sözleşmeleri |
| 05 | Güvenlik ve yetki | ≈ 9 sn | Kullanıcılar ve yetkiler, güvenlik kartları |
| – | Kapanış | ≈ 7 sn | "Sade. Güçlü. Güvenilir." |

\* Sahne süreleri seslendirmenin gerçek süresinden hesaplanır (`src/timing.ts`); metni değiştirip sesi yeniden üretirseniz video süresi de buna uyar.

## Hızlı kullanım

```bash
cd video
npm install

# Seslendirme + müzik + video (out/muhasebe-erp-tanitim.mp4)
npm run build

# ya da adım adım
npm run voice      # content/script.json → public/audio/*.mp3 + src/timeline.json
npm run music      # arka plan müziği (ffmpeg ile üretilir)
npm run render     # 1080p MP4
npm run studio     # Remotion Studio'da canlı önizleme
```

Gereksinimler: Node.js 22+, `ffmpeg` ve (varsayılan ses motoru için) `espeak-ng` + `mbrola` + `mbrola-tr1`:

```bash
sudo apt-get install -y ffmpeg espeak-ng mbrola mbrola-tr1 mbrola-tr2    # Debian/Ubuntu
```

Remotion ilk çalıştırmada Chrome Headless Shell indirir. İndirme engelliyse sistemdeki bir Chrome/Chromium gösterilebilir: `REMOTION_BROWSER_EXECUTABLE=/yol/chrome-headless-shell npm run render` (eski "headless" kipi olan, `headless_shell` adlı ikili gerekir).

## İçeriği değiştirmek

- **Seslendirme ve alt yazı:** `content/script.json`. Her `cue` bir alt yazı satırıdır; `text` ekranda görünen, `say` seslendirilen metindir (kısaltmaları ve sayıları okunuşuyla yazın: "E R P"). Değiştirince `npm run voice` çalıştırın; alt yazı süreleri ve vurguların zamanlaması otomatik güncellenir.
- **Görsel kurgu** (hangi ekran, nerede yakınlaşma, hangi vurgu): `src/specs.ts`. Vurgu dikdörtgenleri ekran görüntüsünün kesirli koordinatlarıdır.
- **Ekran görüntüleri:** `public/shots/`. Uygulama demo verisiyle çalışırken `npm run shots` ile yeniden alınır (kök dizinde `npm run db:seed` ve `npm run dev` gerekir).
- **Renkler, yazı tipi:** `src/theme.ts` (uygulamanın tasarım belirteçleriyle aynı; bkz. `docs/DESIGN.md`). Yazı tipi Inter (OFL), `public/fonts/`.

## Ses motorları

`VOICE_ENGINE` ile seçilir:

| Motor | Kurulum | Kalite |
|---|---|---|
| `mbrola` (varsayılan) | çevrimdışı, ücretsiz (`espeak-ng` + MBROLA Türkçe ses) | anlaşılır ama belirgin biçimde sentetik/robotik |
| `espeak` | yalnızca `espeak-ng` | daha da robotik |
| `edge` | `pip install edge-tts`, internet gerekir; ücretsiz | çok daha doğal (`tr-TR-AhmetNeural`, kadın sesi için `VOICE_NAME=tr-TR-EmelNeural`) |

Daha doğal bir sonuç için: `VOICE_ENGINE=edge npm run voice && npm run render`. (Bu depoyu hazırlarken kullanılan ortamda Microsoft sesine erişim yoktu; `edge` motoru bu yüzden denenmemiştir.)

MBROLA'nın Türkçe sesinde `&` (ünsüz arası kısa ünlü) ve `l/` (koyu l) birimleri bulunmaz; `scripts/make-voice.mjs` bunları bilinen karşılıklarıyla değiştirir, aksi halde konuşmada sessiz boşluklar oluşur.

## Notlar

- Videodaki tüm ekranlar **örnek (demo) veridir**; videoda da bu belirtilir. Gerçek müşteri verisi kullanılmaz.
- Anlatılan her özellik `README.md`'deki özellik listesine dayanır; hukuki/mali doğrulama gerektiren konulara (KDV oranları, bordro, sosyal güvenlik vb.) video girmez.
- Remotion, bireyler ve 3 kişiden küçük şirketler için ücretsizdir; daha büyük şirketler için lisans gerekir (<https://www.remotion.dev/license>). Müzik ffmpeg ile üretildiğinden telif sorunu yoktur.
- Arka plan müziği ve ses ffmpeg ile üretilen basit sentezdir; profesyonel yayın için gerçek bir spiker kaydı ve telifsiz müzik parçası kolayca değiştirilebilir (`public/audio/`, `src/Root.tsx`).
