// TikTok LIVE chat + hediyeler — tiktok-live-connector (resmi olmayan; TikTok değişirse kırılabilir).
// Paketin v1 (WebcastPushConnection) ve v2 (TikTokLiveConnection) sürümlerini destekler.
let TT = null;
try { TT = require('tiktok-live-connector'); } catch {}

const RETRY_MS = 30000;

// Birden fazla olası alan yolundan ilk dolu olanı döndür
function pick(obj, ...paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p.split('.')) { if (v == null) break; v = v[k]; }
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function userOf(d) {
  return {
    name: pick(d, 'user.nickname', 'nickname', 'user.uniqueId', 'uniqueId') || '?',
    handle: pick(d, 'user.uniqueId', 'uniqueId'),
    avatar: pick(d, 'user.profilePicture.url.0', 'user.profilePicture.urls.0', 'profilePictureUrl'),
    badges: []
  };
}

class TikTokChat {
  constructor(hub) { this.hub = hub; this.conn = null; this.alive = false; }

  start(channel) {
    this.alive = true;
    this.username = channel.replace(/^@/, '').replace(/.*tiktok\.com\/@?/, '').split(/[/?]/)[0];
    if (!TT) return this.hub.setStatus('tiktok', 'error', 'tiktok-live-connector paketi yüklenemedi (npm install)');
    this.connect();
  }

  async connect() {
    if (!this.alive) return;
    clearTimeout(this.timer);
    this.hub.setStatus('tiktok', 'connecting', `@${this.username} bağlanıyor…`);
    const Conn = TT.TikTokLiveConnection || TT.WebcastPushConnection;
    const conn = new Conn(this.username, { processInitialData: false, enableExtendedGiftInfo: true });
    this.conn = conn;
    const mine = (fn) => (d) => { if (this.conn === conn) { try { fn(d || {}); } catch (e) { console.error('[tiktok]', e); } } };

    conn.on('chat', mine((d) => this.hub.push({
      platform: 'tiktok', type: 'chat', user: userOf(d),
      text: pick(d, 'comment') || ''
    })));

    conn.on('gift', mine((d) => {
      const giftType = pick(d, 'giftDetails.giftType', 'giftType', 'gift.gift_type');
      const repeatEnd = pick(d, 'repeatEnd');
      // Seri (combo) hediyelerde sadece seri bitince tek olay göster
      if (giftType === 1 && !repeatEnd) return;
      const count = Number(pick(d, 'repeatCount', 'gift.repeat_count')) || 1;
      const name = pick(d, 'giftDetails.giftName', 'extendedGiftInfo.name', 'giftName') || 'Hediye';
      const diamonds = Number(pick(d, 'giftDetails.diamondCount', 'extendedGiftInfo.diamond_count', 'diamondCount')) || 0;
      const image = pick(d, 'giftDetails.giftImage.giftPictureUrl', 'giftPictureUrl', 'extendedGiftInfo.image.url_list.0', 'giftDetails.icon.url.0');
      this.hub.push({
        platform: 'tiktok', type: 'gift', user: userOf(d),
        text: `${count} x ${name} gönderdi`,
        gift: { name, count, value: diamonds * count, image }
      });
    }));

    conn.on('follow', mine((d) => this.hub.push({ platform: 'tiktok', type: 'follow', user: userOf(d), text: 'takip etti' })));
    conn.on('subscribe', mine((d) => this.hub.push({ platform: 'tiktok', type: 'sub', user: userOf(d), text: 'abone oldu!' })));
    conn.on('roomUser', mine((d) => {
      const n = pick(d, 'viewerCount', 'totalUser');
      if (n !== undefined) this.hub.emit('viewers', { platform: 'tiktok', count: Number(n) });
    }));
    conn.on('streamEnd', mine(() => this.retry('Yayın bitti, yeni yayın bekleniyor')));
    conn.on('disconnected', mine(() => this.retry('Bağlantı koptu, yeniden denenecek')));
    conn.on('error', () => {});

    try {
      await conn.connect();
      if (this.conn === conn) this.hub.setStatus('tiktok', 'connected', `Bağlı (@${this.username})`);
    } catch (e) {
      if (this.conn !== conn) return;
      const msg = String(e?.message || e);
      const offline = /offline|not.*live|LIVE has ended|isn't online/i.test(msg);
      this.retry(offline ? 'Yayın kapalı, 30 sn sonra tekrar denenecek' : 'Bağlanamadı: ' + msg.slice(0, 140));
    }
  }

  retry(detail) {
    const c = this.conn;
    this.conn = null;
    try { c?.disconnect(); } catch {}
    if (!this.alive) return;
    this.hub.setStatus('tiktok', 'waiting', detail);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), RETRY_MS);
  }

  stop() {
    this.alive = false;
    clearTimeout(this.timer);
    const c = this.conn;
    this.conn = null;
    try { c?.disconnect(); } catch {}
  }
}

module.exports = { TikTokChat, pick };
