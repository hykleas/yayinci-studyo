// Kick chat — Kick'in kendi sitesinin kullandığı Pusher websocket'i.
// Kanal kimliği kick.com/api/v2/channels/<kullanıcı> adresinden alınır (Cloudflare yüzünden
// Electron'un tarayıcı ağı kullanılır; olmazsa Ayarlar'a chatroom ID elle girilebilir).
const WebSocket = require('ws');

const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';
const EMOTE_RE = /\[emote:(\d+):([^\]]+)\]/g;

function parseContent(content) {
  const parts = [];
  let last = 0;
  let m;
  EMOTE_RE.lastIndex = 0;
  while ((m = EMOTE_RE.exec(content))) {
    if (m.index > last) parts.push({ t: 'text', v: content.slice(last, m.index) });
    parts.push({ t: 'img', src: `https://files.kick.com/emotes/${m[1]}/fullsize`, alt: m[2] });
    last = m.index + m[0].length;
  }
  if (last < content.length) parts.push({ t: 'text', v: content.slice(last) });
  return parts;
}

function slugOf(input) {
  const s = input.trim();
  const m = s.match(/kick\.com\/([\w-]+)/i);
  return (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
}

class KickChat {
  constructor(hub, helpers = {}) {
    this.hub = hub;
    this.fetchJson = helpers.fetchJson;
    this.ws = null;
    this.alive = false;
    this.backoff = 2000;
  }

  async start(channel, cfg = {}) {
    this.alive = true;
    this.slug = slugOf(channel);
    this.chatroomId = String(cfg.chatroomId || '').trim();
    this.channelId = '';
    this.hub.setStatus('kick', 'connecting', 'Kanal bilgisi alınıyor…');
    if (!this.chatroomId) {
      try {
        const info = await this.fetchJson(`https://kick.com/api/v2/channels/${this.slug}`);
        this.chatroomId = String(info?.chatroom?.id || '');
        this.channelId = String(info?.id || '');
      } catch (e) {
        if (!this.alive) return;
        this.hub.setStatus('kick', 'error', 'Kanal bulunamadı/erişilemedi. Ayarlar > Kick > Chatroom ID elle girilebilir. (' + (e.message || e) + ')');
        this.timer = setTimeout(() => this.alive && this.start(channel, cfg), 60000);
        return;
      }
    }
    if (!this.alive) return;
    if (!this.chatroomId) return this.hub.setStatus('kick', 'error', 'Chatroom ID alınamadı');
    this.connect();
  }

  connect() {
    if (!this.alive) return;
    const ws = new WebSocket(PUSHER_URL);
    this.ws = ws;
    ws.on('open', () => { this.backoff = 2000; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.onMessage(ws, msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws || !this.alive) return;
      this.hub.setStatus('kick', 'connecting', 'Bağlantı koptu, yeniden bağlanıyor…');
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
    ws.on('error', () => {});
  }

  sub(ws, channel) {
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel } }));
  }

  onMessage(ws, msg) {
    const ev = msg.event;
    if (ev === 'pusher:connection_established') {
      this.sub(ws, `chatrooms.${this.chatroomId}.v2`);
      this.sub(ws, `chatroom_${this.chatroomId}`);
      if (this.channelId) { this.sub(ws, `channel.${this.channelId}`); this.sub(ws, `channel_${this.channelId}`); }
      this.hub.setStatus('kick', 'connected', `Bağlı (#${this.slug})`);
      return;
    }
    if (ev === 'pusher:ping') { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); return; }
    if (!ev || ev.startsWith('pusher')) return;

    let d = msg.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d) return;
    const name = ev.replace(/^App\\Events\\/, '');

    switch (name) {
      case 'ChatMessageEvent': {
        const s = d.sender || {};
        const badges = (s.identity?.badges || []).map((b) => b.type).filter(Boolean);
        this.hub.push({
          id: 'kick-' + d.id,
          platform: 'kick',
          type: 'chat',
          user: { name: s.username || '?', color: s.identity?.color, badges },
          parts: parseContent(d.content || '')
        });
        break;
      }
      case 'ChatMessageDeletedEvent':
        if (d.message?.id) this.hub.remove('kick', 'kick-' + d.message.id);
        break;
      case 'SubscriptionEvent':
        this.hub.push({ platform: 'kick', type: 'sub', user: { name: d.username || '?' }, text: d.months > 1 ? `${d.months} aydır abone!` : 'abone oldu!' });
        break;
      case 'GiftedSubscriptionsEvent': {
        const n = (d.gifted_usernames || []).length || 1;
        this.hub.push({ platform: 'kick', type: 'gift', user: { name: d.gifter_username || 'Anonim' }, text: `${n} abonelik hediye etti`, gift: { name: 'Abonelik', count: n } });
        break;
      }
      case 'StreamHostEvent':
        this.hub.push({ platform: 'kick', type: 'raid', user: { name: d.host_username || '?' }, text: `${d.number_viewers || 0} izleyiciyle host attı` });
        break;
      case 'FollowersUpdated':
        if (d.followed && d.username) this.hub.push({ platform: 'kick', type: 'follow', user: { name: d.username }, text: 'takip etti' });
        break;
      default:
        if (/kicks?gift/i.test(name)) {
          const g = d.gift || {};
          const sender = d.sender?.username || d.username || '?';
          this.hub.push({
            platform: 'kick', type: 'gift', user: { name: sender },
            text: `${g.amount || ''} KICKs gönderdi${d.message ? ': ' + d.message : ''}`.trim(),
            gift: { name: g.name || 'KICKs', count: 1, value: g.amount || 0 }
          });
        }
    }
  }

  stop() {
    this.alive = false;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

module.exports = { KickChat, parseContent, slugOf };
