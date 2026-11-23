// YouTube canlı chat — API anahtarı/kota gerektirmeyen youtube-chat paketi (iç API).
// Kanal girişi: @handle, UC... kanal kimliği, ya da yayın linki (watch?v= / youtu.be / /live/).
let LiveChat = null;
try { ({ LiveChat } = require('youtube-chat')); } catch {}

const RETRY_MS = 30000;

function parseTarget(input) {
  const s = input.trim();
  const vid = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/);
  if (vid) return { liveId: vid[1] };
  if (/^UC[\w-]{22}$/.test(s)) return { channelId: s };
  const ch = s.match(/\/channel\/(UC[\w-]{22})/);
  if (ch) return { channelId: ch[1] };
  const h = s.match(/@([\w.\-]+)/);
  if (h) return { handle: '@' + h[1] };
  if (/^[\w-]{11}$/.test(s)) return { liveId: s };
  return { handle: '@' + s.replace(/^@/, '') };
}

class YouTubeChat {
  constructor(hub) { this.hub = hub; this.lc = null; this.timer = null; this.alive = false; }

  start(channel) {
    this.alive = true;
    this.channel = channel;
    if (!LiveChat) return this.hub.setStatus('youtube', 'error', 'youtube-chat paketi yüklenemedi (npm install)');
    this.connect();
  }

  async connect() {
    if (!this.alive) return;
    clearTimeout(this.timer);
    this.hub.setStatus('youtube', 'connecting', 'Bağlanıyor…');
    let lc;
    try {
      lc = new LiveChat(parseTarget(this.channel), 1500);
    } catch (e) {
      return this.retry('Hatalı kanal: ' + e.message);
    }
    this.lc = lc;
    lc.on('chat', (item) => { if (this.lc === lc) this.hub.push(this.map(item)); });
    lc.on('end', () => { if (this.lc === lc) this.retry('Yayın bitti, yeni yayın bekleniyor'); });
    lc.on('error', (err) => {
      if (this.lc !== lc) return;
      const msg = String(err?.message || err);
      // Tekil hata: yayın kapalıysa start() false döner, orada yeniden deneriz.
      this.hub.setStatus('youtube', 'error', msg.slice(0, 160));
    });
    let ok = false;
    try { ok = await lc.start(); } catch { ok = false; }
    if (this.lc !== lc) return;
    if (ok) this.hub.setStatus('youtube', 'connected', 'Bağlı');
    else this.retry('Canlı yayın bulunamadı, 30 sn sonra tekrar denenecek');
  }

  retry(detail) {
    try { this.lc?.stop(); } catch {}
    this.lc = null;
    if (!this.alive) return;
    this.hub.setStatus('youtube', 'waiting', detail);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), RETRY_MS);
  }

  stop() {
    this.alive = false;
    clearTimeout(this.timer);
    try { this.lc?.stop(); } catch {}
    this.lc = null;
  }

  map(item) {
    const parts = (item.message || []).map((m) => {
      if (m.url) return { t: 'img', src: m.url, alt: m.emojiText || m.alt || '' };
      return { t: 'text', v: m.text || '' };
    });
    const a = item.author || {};
    const badges = [];
    if (item.isOwner) badges.push('owner');
    if (item.isModerator) badges.push('mod');
    if (item.isMembership) badges.push('member');
    if (item.isVerified) badges.push('verified');
    const evt = {
      id: item.id ? 'youtube-' + item.id : undefined,
      platform: 'youtube',
      type: 'chat',
      user: { name: a.name || '?', avatar: a.thumbnail?.url, badges, color: item.isModerator ? '#5e84f1' : item.isMembership ? '#2ba640' : undefined },
      parts
    };
    if (item.superchat) {
      evt.type = 'superchat';
      evt.amount = item.superchat.amount;
      evt.color = item.superchat.color;
      if (item.superchat.sticker?.url) evt.parts = [{ t: 'img', src: item.superchat.sticker.url, alt: 'sticker' }, ...parts];
    } else if (item.isMembership && !parts.length) {
      evt.type = 'sub';
      evt.text = 'kanala üye oldu';
    }
    return evt;
  }
}

module.exports = { YouTubeChat, parseTarget };
