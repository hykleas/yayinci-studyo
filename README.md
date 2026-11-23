# Yayıncı Stüdyo

OBS + chat uygulaması + çoklu yayın servisini tek uygulamada birleştirir (Windows).

- **Yayın motoru:** Oyun penceresini ya da ekranı, kamerayı, mikrofonu ve masaüstü sesini yakalar. Görüntü NVENC ile **tek kez** kodlanır.
- **Çoklu yayın:** Aynı görüntü aynı anda **YouTube + Kick + TikTok**'a gider. İstersen bilgisayara da kaydeder (.mkv).
- **Birleşik chat:** YouTube, Kick ve TikTok chat'i tek listede görünür. Hediyeler de gelir: TikTok hediyeleri, Kick abonelik/KICKs, YouTube Süper Chat ve üyelik.
- **İzleyicinin gördüğü chat ve uyarılar:** Chat ve hediye/abone uyarıları (sesli, animasyonlu) yayın görüntüsünün içine çizilir. Ayrıca bir "browser source" kurmaya gerek yoktur.
- **Oyun üstü chat:** Tam ekran oyunun (Minecraft) üstünde şeffaf ve tıklanamaz bir chat penceresi açılır. **Sadece sen görürsün**, yayına girmez. İkinci monitöre gerek kalmaz.
- **Telefonda chat:** QR kodu okutunca telefonda chat açılır (aynı Wi-Fi'de olmalı).
- **Sahneler:** Oyun / Başlıyoruz / Mola arasında yumuşak geçiş yapılır.

## Kurulum (ev bilgisayarı)

Gerekenler: [Node.js 20+](https://nodejs.org) ve [Git](https://git-scm.com).

```bash
git clone https://github.com/hykleas/yayinci-studyo.git
cd yayinci-studyo
npm install
npm start
```

FFmpeg ayrıca kurulmaz, `ffmpeg-static` paketiyle birlikte gelir. NVIDIA sürücüsü **güncel** olmalı (NVENC için).

## İlk ayar

1. **Ayarlar → Platformlar**
   - **YouTube:** Kanal (`@kanalin`) + akış anahtarı (YouTube Studio → Canlı yayın).
   - **Kick:** Kullanıcı adı + Stream URL + Key (Creator Dashboard → Settings → Stream URL & Key).
   - **TikTok:** Kullanıcı adı + sunucu URL + anahtar (LIVE Producer / LIVE Studio; sadece uygun hesaplarda). Anahtar yoksa yalnızca kullanıcı adını yaz, chat ve hediyeler yine gelir.
2. **Kaynak seç → Pencereler → Minecraft.** Oyunu *pencere* olarak seçmek en iyisidir; o zaman bu uygulama ve overlay yayına girmez.
3. Chat panelindeki **Test olayı** ile chat'i, uyarıları ve overlay'i yayın açmadan dene.
4. **Yayını Başlat.**

## Kısayollar (oyun tam ekranken de çalışır)

| Kısayol | İş |
|---|---|
| Ctrl+Shift+1 / 2 / 3 | Sahne: Oyun / Başlıyoruz / Mola |
| Ctrl+Shift+M | Mikrofonu aç/kapat (overlay'de "MİKROFON KAPALI" uyarısı çıkar) |
| Ctrl+Shift+H | Oyun üstü chat'i gizle/göster |
| Ctrl+Shift+O | Oyun üstü chat'i taşı/boyutlandır |

## Nasıl çalışıyor

```
[oyun penceresi] ─┐
[kamera]  ────────┤→ canvas (sahne + chat + uyarılar) ─┐
[mikrofon] ───────┤                                    ├→ MediaRecorder (ara akış) → FFmpeg (NVENC, tek kodlama)
[masaüstü sesi] ──┘→ WebAudio mikseri ─────────────────┘        └→ tee → YouTube / Kick / TikTok / kayıt
YouTube chat (youtube-chat) ┐
Kick chat (Pusher websocket) ├→ ChatHub → ana pencere + oyun üstü overlay + yayın canvas'ı + telefon
TikTok (tiktok-live-connector) ┘
```

- `src/main/main.js`: pencereler, overlay, kısayollar, IPC
- `src/main/ffmpeg.js`: kodlayıcı tespiti (NVENC → QSV → AMF → x264) ve çoklu çıkış
- `src/main/chat/*`: platform bağlantıları
- `src/renderer/compositor.js`: sahne çizimi, izleyici chat'i, uyarılar, ses mikseri
- `src/renderer/app.js`: ana arayüz
- `src/renderer/overlay.*`: oyun üstü chat

## Bilinen sınırlar / yapılacaklar

- TikTok ve YouTube chat'i resmi olmayan yollarla okunur. Platformlar bir şeyi değiştirirse bu paketlerin güncellenmesi gerekebilir.
- Kick kanal bilgisi Cloudflare arkasında. Alınamazsa **Ayarlar → Gelişmiş → Kick chatroom ID** elle girilebilir.
- TikTok için dikey (9:16) ayrı çıkış henüz yok. Şu an tüm platformlara aynı yatay görüntü gider.
- Chat'e uygulamadan mesaj yazma henüz yok.
- Overlay, "özel tam ekran" (exclusive fullscreen) kullanan bazı oyunlarda görünmeyebilir. Bu durumda oyunu kenarlıksız/pencereli moda al.
