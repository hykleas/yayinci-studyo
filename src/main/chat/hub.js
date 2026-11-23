// Tüm platformların chat/hediye olaylarını tek tip olaya çevirip yayar.
//
// Olay biçimi:
// {
//   id, ts, platform: 'youtube'|'kick'|'tiktok',
//   type: 'chat'|'gift'|'superchat'|'sub'|'follow'|'raid'|'system',
//   user: { name, color, avatar, badges: [string] },
//   parts: [{ t:'text', v } | { t:'img', src, alt }],
//   text,                       // düz metin hali
//   gift?: { name, count, image, value },   // value: TikTok elmas / Kick kicks
//   amount?: string             // Süper Chat tutarı: "₺50,00"
// }
const EventEmitter = require('events');
const { YouTubeChat } = require('./youtube');
const { KickChat } = require('./kick');
const { TikTokChat } = require('./tiktok');

let seq = 0;

class ChatHub extends EventEmitter {
  constructor(helpers) {
    super();
    this.history = [];
    this.statuses = {};
    this.adapters = {
      youtube: new YouTubeChat(this),
      kick: new KickChat(this, helpers),
      tiktok: new TikTokChat(this)
    };
    this.config = {};
  }

  push(evt) {
    evt.id = evt.id || `${evt.platform}-${Date.now()}-${seq++}`;
    evt.ts = evt.ts || Date.now();
    evt.user = evt.user || { name: '?' };
    evt.user.badges = evt.user.badges || [];
    evt.parts = evt.parts || (evt.text ? [{ t: 'text', v: evt.text }] : []);
    if (evt.text === undefined) evt.text = evt.parts.map((p) => (p.t === 'text' ? p.v : p.alt || '')).join('');
    this.history.push(evt);
    if (this.history.length > 300) this.history.shift();
    this.emit('event', evt);
  }

  remove(platform, id) {
    const full = `${platform}-${id}`;
    this.history = this.history.filter((e) => e.id !== full && e.id !== id);
    this.emit('remove', { id: full, raw: id });
  }

  setStatus(platform, state, detail = '') {
    this.statuses[platform] = { state, detail };
    this.emit('status', { ...this.statuses });
  }

  // platforms: settings.platforms — kanal adı doluysa chat'e bağlanır (yayın açık olmasa da)
  configure(platforms, force = false) {
    for (const id of Object.keys(this.adapters)) {
      const p = platforms[id] || {};
      const key = JSON.stringify([p.channel, p.chatroomId]);
      if (!force && this.config[id] === key) continue;
      this.config[id] = key;
      const a = this.adapters[id];
      a.stop();
      if ((p.channel || '').trim()) a.start(p.channel.trim(), p);
      else this.setStatus(id, 'off', 'Kanal girilmedi');
    }
  }

  stopAll() { for (const a of Object.values(this.adapters)) a.stop(); }

  test(kind) {
    const samples = {
      chat: [
        { platform: 'youtube', type: 'chat', user: { name: 'ahmet_yt', color: '#ff6b6b' }, text: 'selam abi yayın çok iyi 🔥' },
        { platform: 'kick', type: 'chat', user: { name: 'kickci42', color: '#53fc18', badges: ['sub'] }, parts: [{ t: 'text', v: 'gg wp ' }, { t: 'img', src: 'https://files.kick.com/emotes/37226/fullsize', alt: 'KEKW' }] },
        { platform: 'tiktok', type: 'chat', user: { name: 'tt.zeynep', color: '#25f4ee' }, text: 'nether’e ne zaman gidiyoruz?' }
      ],
      gift: [{ platform: 'tiktok', type: 'gift', user: { name: 'tt.mert' }, text: '5 x Gül gönderdi', gift: { name: 'Gül', count: 5, value: 5, image: '' } }],
      superchat: [{ platform: 'youtube', type: 'superchat', user: { name: 'Destekçi Can' }, amount: '₺50,00', text: 'Kanala destek, devam!' }],
      sub: [{ platform: 'kick', type: 'sub', user: { name: 'kickfan' }, text: '3 abonelik hediye etti', gift: { name: 'Abonelik', count: 3 } }],
      follow: [{ platform: 'tiktok', type: 'follow', user: { name: 'yeni.takipci' }, text: 'takip etti' }]
    };
    const list = kind === 'all' ? Object.values(samples).flat() : samples[kind] || samples.chat;
    list.forEach((e, i) => setTimeout(() => this.push(JSON.parse(JSON.stringify(e))), i * 400));
  }
}

module.exports = { ChatHub };
