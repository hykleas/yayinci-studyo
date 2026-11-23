// Ayarlar: userData/ayarlar.json. Yayın anahtarları Windows DPAPI (safeStorage) ile şifrelenir.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  video: { width: 1920, height: 1080, fps: 60, bitrate: 6000, audioBitrate: 160, encoder: 'auto', ffmpegPath: '' },
  record: { enabled: false, dir: '' },
  platforms: {
    youtube: { enabled: false, server: 'rtmp://a.rtmp.youtube.com/live2', key: '', channel: '' },
    kick: { enabled: false, server: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app', key: '', channel: '', chatroomId: '' },
    tiktok: { enabled: false, server: '', key: '', channel: '' }
  },
  sources: {
    gameId: '', gameName: '',
    camEnabled: false, camId: '', camCorner: 'br', camSize: 22,
    micEnabled: true, micId: 'default', micGain: 1, micNoise: true,
    deskEnabled: true, deskGain: 1
  },
  scenes: { startingText: 'Yayın birazdan başlıyor', brbText: 'Hemen dönüyorum', subtitle: '' },
  viewerChat: { enabled: true, side: 'left', width: 26, fontSize: 26, max: 8, fade: 60 },
  alerts: { enabled: true, sound: true, volume: 0.5, follows: true, duration: 6 },
  overlay: { enabled: true, bounds: null, fontSize: 17, opacity: 0.55, fade: 45, max: 14 },
  mobile: { enabled: true, port: 7788 },
  phoneCam: { port: 7789 }
};

const SECRET_PATHS = ['youtube', 'kick', 'tiktok'];
let file = null;
let data = null;

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    if (isObj(patch[k]) && isObj(base?.[k])) out[k] = merge(base[k], patch[k]);
    else out[k] = patch[k];
  }
  return out;
}

function enc(str) {
  if (!str) return '';
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(str).toString('base64'); } catch {}
  return 'raw:' + Buffer.from(str, 'utf8').toString('base64');
}
function dec(str) {
  if (!str) return '';
  try {
    if (str.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(str.slice(4), 'base64'));
    if (str.startsWith('raw:')) return Buffer.from(str.slice(4), 'base64').toString('utf8');
  } catch {}
  return '';
}

function load() {
  file = path.join(app.getPath('userData'), 'ayarlar.json');
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  for (const p of SECRET_PATHS) {
    const pl = disk.platforms?.[p];
    if (pl && pl.keyEnc !== undefined) { pl.key = dec(pl.keyEnc); delete pl.keyEnc; }
  }
  data = merge(DEFAULTS, disk);
  if (!data.record.dir) data.record.dir = app.getPath('videos');
  return data;
}

function save() {
  const copy = JSON.parse(JSON.stringify(data));
  for (const p of SECRET_PATHS) {
    copy.platforms[p].keyEnc = enc(copy.platforms[p].key);
    delete copy.platforms[p].key;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(copy, null, 2));
  fs.renameSync(file + '.tmp', file);
}

function get() { return data || load(); }

function set(patch) {
  data = merge(get(), patch);
  save();
  return data;
}

module.exports = { get, set, load, DEFAULTS };
