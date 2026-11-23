// Telefonu kamera olarak kullan: HTTPS sayfa + WebSocket sinyalleşme.
// Telefon tarayıcıları kamerayı sadece güvenli (HTTPS) sayfalara verir; bu yüzden
// kendinden imzalı sertifika üretilir (telefonda bir kerelik "devam et" uyarısı çıkar).
// Görüntü WebRTC ile doğrudan telefondan uygulamaya gelir (aynı Wi-Fi, düşük gecikme).
const https = require('https');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { WebSocketServer } = require('ws');
const { lanIp } = require('./mobile');

function loadOrCreateCert(dir) {
  const keyFile = path.join(dir, 'telefon-kamera.key');
  const certFile = path.join(dir, 'telefon-kamera.crt');
  try {
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
  } catch {}
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Yayinci Studyo' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: lanIp() }, { type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }
    ]
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

class PhoneCam extends EventEmitter {
  constructor() { super(); this.server = null; this.phone = null; this.port = 0; }

  start(port, certDir) {
    if (this.server) return;
    const { key, cert } = loadOrCreateCert(certDir);
    const page = path.join(__dirname, '../renderer/phonecam.html');
    this.server = https.createServer({ key, cert }, (req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        fs.createReadStream(page).pipe(res);
      } else { res.writeHead(404); res.end(); }
    });
    const wss = new WebSocketServer({ server: this.server });
    wss.on('connection', (ws) => {
      // aynı anda tek telefon: yenisi gelince eskisini kapat
      if (this.phone && this.phone !== ws) { try { this.phone.close(); } catch {} }
      this.phone = ws;
      this.emit('signal', { type: 'phone-connected' });
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m && typeof m.type === 'string') this.emit('signal', m);
      });
      ws.on('close', () => {
        if (this.phone === ws) { this.phone = null; this.emit('signal', { type: 'left' }); }
      });
      ws.on('error', () => {});
    });
    this.wss = wss;
    this.server.on('error', (e) => this.emit('error', e));
    this.server.listen(port, '0.0.0.0');
    this.port = port;
  }

  get connected() { return !!(this.phone && this.phone.readyState === 1); }

  send(msg) {
    if (this.connected) this.phone.send(JSON.stringify(msg));
  }

  url() { return `https://${lanIp()}:${this.port}`; }

  stop() {
    try { this.wss?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.server = null;
  }
}

module.exports = { PhoneCam };
