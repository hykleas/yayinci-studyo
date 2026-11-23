// Telefondan chat: aynı Wi-Fi'deki telefon QR'ı okutup chat'i büyük yazıyla görür.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

function lanIp() {
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) all.push(n.address);
  }
  return all.find((a) => a.startsWith('192.168.')) || all.find((a) => a.startsWith('10.')) || all[0] || '127.0.0.1';
}

class MobileServer {
  constructor(hub) { this.hub = hub; this.server = null; this.wss = null; this.port = 0; }

  start(port) {
    if (this.server) return;
    const page = path.join(__dirname, '../renderer/mobile.html');
    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        fs.createReadStream(page).pipe(res);
      } else if (req.url === '/history') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.hub.history.slice(-80)));
      } else { res.writeHead(404); res.end(); }
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.server.on('error', (e) => console.error('[mobil]', e.message));
    this.server.listen(port, '0.0.0.0');
    this.port = port;
    this.hub.on('event', (e) => this.broadcast({ kind: 'event', data: e }));
    this.hub.on('remove', (e) => this.broadcast({ kind: 'remove', data: e }));
  }

  broadcast(obj) {
    if (!this.wss) return;
    const s = JSON.stringify(obj);
    for (const c of this.wss.clients) if (c.readyState === 1) c.send(s);
  }

  url() { return `http://${lanIp()}:${this.port}`; }

  stop() {
    try { this.wss?.close(); } catch {}
    try { this.server?.close(); } catch {}
    this.server = null;
  }
}

module.exports = { MobileServer, lanIp };
