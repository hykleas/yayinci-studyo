// Yayın motoru: renderer'dan gelen (MediaRecorder) akışı stdin'den alır,
// donanım kodlayıcısıyla (NVENC/QSV/AMF, yoksa x264) TEK kez kodlar
// ve tee ile aynı anda tüm platformlara (+ isteğe bağlı kayda) gönderir.
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const PLATFORM_NAMES = { youtube: 'YouTube', kick: 'Kick', tiktok: 'TikTok', record: 'Kayıt' };

function ffmpegBin(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  try {
    const p = require('ffmpeg-static');
    if (p) return p.replace('app.asar', 'app.asar.unpacked');
  } catch {}
  return 'ffmpeg'; // PATH'te varsa
}

// Her kodlayıcı için CBR (platformların istediği sabit bit hızı) ayarları
const ENCODERS = {
  h264_nvenc: (br) => ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'cbr',
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`, '-profile:v', 'high', '-bf', '2', '-spatial-aq', '1'],
  h264_qsv: (br) => ['-c:v', 'h264_qsv', '-preset', 'faster',
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`, '-profile:v', 'high'],
  h264_amf: (br) => ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cbr',
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`, '-profile:v', 'high'],
  libx264: (br) => ['-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${br}k`, '-maxrate', `${br}k`, '-bufsize', `${br * 2}k`, '-profile:v', 'high', '-x264-params', 'nal-hrd=cbr']
};
const ENCODER_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
const ENCODER_LABEL = { h264_nvenc: 'NVIDIA NVENC', h264_qsv: 'Intel QuickSync', h264_amf: 'AMD AMF', libx264: 'x264 (işlemci)' };

function testEncoder(bin, name) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let p;
    try {
      p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=30:d=0.5',
        '-c:v', name, '-f', 'null', '-'], { windowsHide: true });
    } catch { return finish(false); }
    const t = setTimeout(() => { try { p.kill(); } catch {} finish(false); }, 10000);
    p.on('error', () => { clearTimeout(t); finish(false); });
    p.on('close', (code) => { clearTimeout(t); finish(code === 0); });
  });
}

let encoderCache = null;
async function detectEncoders(bin) {
  if (encoderCache) return encoderCache;
  const found = [];
  for (const n of ENCODER_ORDER) if (await testEncoder(bin, n)) found.push(n);
  encoderCache = found;
  return found;
}

function joinUrl(server, key) {
  server = (server || '').trim().replace(/\/+$/, '');
  key = (key || '').trim().replace(/^\/+/, '');
  if (!server || !key) return '';
  return `${server}/${key}`;
}

// tee içindeki özel karakterleri kaçır
function teeEscape(s) { return s.replace(/([\\|'[\]])/g, '\\$1'); }

function stamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
}

class StreamEngine extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.outputs = [];
    this.state = 'idle';
    this.lastErrors = [];
    this.startedAt = 0;
    this.backlogWarned = false;
  }

  get running() { return !!this.proc; }

  status(extra = {}) {
    const s = {
      state: this.state,
      startedAt: this.startedAt,
      encoder: this.encoder,
      encoderLabel: ENCODER_LABEL[this.encoder] || this.encoder,
      outputs: this.outputs.map((o) => ({ id: o.id, name: o.name, state: o.state })),
      ...extra
    };
    this.emit('status', s);
    return s;
  }

  buildOutputs(settings) {
    const outs = [];
    for (const id of ['youtube', 'kick', 'tiktok']) {
      const p = settings.platforms[id];
      if (!p.enabled) continue;
      const url = joinUrl(p.server, p.key);
      if (!url) throw new Error(`${PLATFORM_NAMES[id]}: sunucu adresi veya yayın anahtarı boş`);
      outs.push({ id, name: PLATFORM_NAMES[id], url, fmt: 'flv', state: 'connecting' });
    }
    if (settings.record.enabled) {
      const dir = settings.record.dir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `yayin_${stamp()}.mkv`).replace(/\\/g, '/');
      outs.push({ id: 'record', name: 'Kayıt', url: file, fmt: 'matroska', state: 'connecting' });
    }
    return outs;
  }

  async start(settings, opts) {
    if (this.proc) throw new Error('Yayın zaten açık');
    const v = settings.video;
    const bin = ffmpegBin(v.ffmpegPath);
    const outputs = this.buildOutputs(settings);
    if (!outputs.length) throw new Error('Hiç platform seçili değil. Ayarlar > Platformlar kısmından en az birini aç (ya da Kayıt).');

    let encoder = v.encoder;
    if (!encoder || encoder === 'auto' || !ENCODERS[encoder]) {
      const found = await detectEncoders(bin);
      if (!found.length) throw new Error('FFmpeg çalışmadı ya da hiçbir kodlayıcı bulunamadı. (ffmpeg yolu: ' + bin + ')');
      encoder = found[0];
    }
    this.encoder = encoder;
    this.outputs = outputs;
    this.lastErrors = [];

    const fps = Number(opts.fps || v.fps) || 60;
    const W = Number(opts.width || v.width);
    const H = Number(opts.height || v.height);
    const gop = fps * 2; // platformlar 2 sn anahtar kare ister

    const tee = outputs.map((o) => {
      const opt = o.fmt === 'flv' ? 'f=flv:onfail=ignore:flvflags=no_duration_filesize' : 'f=matroska:onfail=ignore';
      return `[${opt}]${teeEscape(o.url)}`;
    }).join('|');

    const args = [
      '-hide_banner', '-loglevel', 'warning', '-stats', '-stats_period', '1',
      '-fflags', '+genpts', '-thread_queue_size', '4096',
      '-f', 'matroska', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=${W}:${H}:flags=bicubic,format=yuv420p`,
      '-fps_mode', 'cfr', '-r', String(fps),
      ...ENCODERS[encoder](Number(v.bitrate) || 6000),
      '-g', String(gop), '-keyint_min', String(gop),
      '-c:a', 'aac', '-b:a', `${Number(v.audioBitrate) || 160}k`, '-ar', '48000', '-ac', '2',
      '-flags', '+global_header',
      '-f', 'tee', tee
    ];

    const proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.state = 'starting';
    this.startedAt = Date.now();
    this.backlogWarned = false;
    this.status();

    proc.stdin.on('error', () => {});
    let buf = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split(/\r|\n/);
      buf = parts.pop();
      for (const line of parts) this.onLine(line.trim());
    });
    proc.on('error', (err) => {
      this.lastErrors.push(String(err.message || err));
      this.emit('log', { level: 'error', text: 'FFmpeg başlatılamadı: ' + err.message });
    });
    proc.on('close', (code) => {
      const wasStopping = this.state === 'stopping';
      this.proc = null;
      this.state = 'idle';
      this.status({ ended: true, code, error: !wasStopping && code !== 0 ? (this.lastErrors.slice(-3).join('\n') || `FFmpeg kapandı (kod ${code})`) : null });
      if (this.stopResolve) { this.stopResolve(); this.stopResolve = null; }
    });

    return { ok: true, encoder, encoderLabel: ENCODER_LABEL[encoder], outputs: outputs.map((o) => o.id) };
  }

  onLine(line) {
    if (!line) return;
    const m = line.match(/frame=\s*(\d+).*?fps=\s*([\d.]+).*?bitrate=\s*([\d.]+|N\/A)\s*kbits\/s.*?(?:drop=\s*(\d+))?.*?speed=\s*([\d.]+|N\/A)x?/);
    if (m) {
      if (this.state === 'starting') {
        this.state = 'live';
        for (const o of this.outputs) if (o.state === 'connecting') o.state = 'ok';
      }
      const drop = (line.match(/drop=\s*(\d+)/) || [])[1];
      this.status({ fps: Number(m[2]), kbps: Number(m[3]) || 0, speed: Number(m[5]) || 0, drop: Number(drop || 0) });
      return;
    }
    // tee: "Slave muxer #1 failed: ..., continuing with 2/3 slaves."
    const slave = line.match(/[Ss]lave muxer #(\d+) failed/);
    if (slave) {
      const o = this.outputs[Number(slave[1])];
      if (o) { o.state = 'error'; this.emit('log', { level: 'error', text: `${o.name} bağlantısı koptu: ${line}` }); this.status(); }
      return;
    }
    for (const o of this.outputs) {
      if (o.fmt === 'flv') {
        try {
          const host = new URL(o.url).host;
          if (host && line.includes(host)) { o.state = 'error'; this.status(); }
        } catch {}
      }
    }
    this.lastErrors.push(line);
    if (this.lastErrors.length > 30) this.lastErrors.shift();
    this.emit('log', { level: 'warn', text: line });
  }

  write(chunk) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return;
    p.stdin.write(Buffer.from(chunk));
    if (p.stdin.writableLength > 64 * 1024 * 1024 && !this.backlogWarned) {
      this.backlogWarned = true;
      this.emit('log', { level: 'error', text: 'Kodlayıcı yetişemiyor (64 MB birikti). Çözünürlüğü/FPS’i düşür ya da bit hızını azalt.' });
    }
  }

  stop() {
    const p = this.proc;
    if (!p) return Promise.resolve();
    this.state = 'stopping';
    this.status();
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      try { p.stdin.end(); } catch {}
      setTimeout(() => { if (this.proc === p) { try { p.kill('SIGKILL'); } catch {} } }, 6000);
    });
  }
}

module.exports = { StreamEngine, detectEncoders, ffmpegBin, ENCODER_LABEL };
