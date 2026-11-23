// Yayın görüntüsünü canvas'ta birleştirir (oyun + kamera + izleyici chat'i + hediye uyarıları + sahneler),
// sesi WebAudio ile karıştırır ve MediaRecorder ile ana sürece (FFmpeg) akıtır.
(function () {
  const { PLATFORMS, TYPE_ICON, nameColor } = window.ChatRender;
  const FONT = '"Segoe UI", "Segoe UI Emoji", system-ui, sans-serif';
  // Kamera filtreleri (WebGL). smooth: cilt yumuşatma gücü, sharp: ten dışı detay keskinliği, rad: yumuşatma yarıçapı (px)
  const CAM_FILTERS = {
    guzel: { smooth: 0.85, sharp: 0.5, rad: 5, bright: 1.05, contrast: 1.06, sat: 1.08, warm: 0.01, glow: 0.03 },
    sicak: { smooth: 0.5, sharp: 0.35, rad: 4, bright: 1.04, contrast: 1.05, sat: 1.2, warm: 0.03, glow: 0.02 },
    sinema: { smooth: 0, sharp: 0.3, rad: 4, bright: 0.98, contrast: 1.18, sat: 0.85, warm: 0.015, glow: 0 }
  };

  // Kenar koruyan (bilateral) cilt yumuşatma: sadece ten rengindeki pikseller yumuşar, göz/saç/arka plan keskin kalır.
  const FX_VS = 'attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
  const FX_FS = `precision mediump float;varying vec2 v;uniform sampler2D t;uniform vec4 rect;uniform vec2 px;
uniform float smoothAmt,sharp,rad,bright,contrast,sat,warm,glow;
vec3 tx(vec2 u){return texture2D(t,rect.xy+u*rect.zw).rgb;}
float skin(vec3 c){float y=dot(c,vec3(.299,.587,.114));float cb=(c.b-y)*.564+.5,cr=(c.r-y)*.713+.5;
 return smoothstep(.27,.31,cb)*(1.-smoothstep(.49,.53,cb))*smoothstep(.49,.53,cr)*(1.-smoothstep(.68,.72,cr))*smoothstep(.12,.25,y);}
void main(){
 vec3 c=tx(v),acc=c;float ws=1.;
 for(int i=0;i<16;i++){float a=float(i)*2.39996,r=sqrt((float(i)+.5)/16.)*rad;
  vec3 s=tx(v+vec2(cos(a),sin(a))*r*px),d=s-c;float w=exp(-dot(d,d)/.02);acc+=s*w;ws+=w;}
 vec3 sm=acc/ws;float m=skin(c)*smoothAmt;
 vec3 o=mix(c,sm,m)+(c-sm)*sharp*(1.-m)+m*glow;
 o=(o-.5)*contrast+.5;o*=bright;float l=dot(o,vec3(.299,.587,.114));o=mix(vec3(l),o,sat);o.r+=warm;o.b-=warm;
 gl_FragColor=vec4(clamp(o,0.,1.),1.);}`;

  class CamFx {
    constructor() {
      const cv = (this.cv = document.createElement('canvas'));
      const gl = (this.gl = cv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }));
      this.ok = false;
      if (!gl) return;
      const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
      const pr = (this.pr = gl.createProgram());
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, FX_VS));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FX_FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn('CamFx: shader derlenemedi', gl.getProgramInfoLog(pr)); return; }
      gl.useProgram(pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      this.u = (n) => gl.getUniformLocation(pr, n);
      this.ok = true;
    }

    // r: camRect() (kaynak kırpması sx,sy,sw,sh + hedef w,h). Dönen canvas hedefe çizilmeye hazır.
    render(video, r, p) {
      const { gl, cv, u } = this;
      const vw = video.videoWidth, vh = video.videoHeight;
      const ow = Math.max(2, Math.min(Math.round(r.sw), Math.round(r.w * 2)));
      const oh = Math.max(2, Math.round(ow * r.sh / r.sw));
      if (cv.width !== ow || cv.height !== oh) { cv.width = ow; cv.height = oh; }
      gl.viewport(0, 0, ow, oh);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video); } catch { return null; }
      gl.uniform4f(u('rect'), r.sx / vw, 1 - (r.sy + r.sh) / vh, r.sw / vw, r.sh / vh);
      gl.uniform2f(u('px'), 1 / ow, 1 / oh);
      gl.uniform1f(u('smoothAmt'), p.smooth); gl.uniform1f(u('sharp'), p.sharp); gl.uniform1f(u('rad'), p.rad);
      gl.uniform1f(u('bright'), p.bright); gl.uniform1f(u('contrast'), p.contrast); gl.uniform1f(u('sat'), p.sat);
      gl.uniform1f(u('warm'), p.warm); gl.uniform1f(u('glow'), p.glow);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return cv;
    }
  }

  // ---------------------------------------------------------------- Ses
  class AudioMixer {
    constructor() {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.dest = this.ctx.createMediaStreamDestination();
      // Hiç kaynak yokken de ses izi canlı kalsın (platformlar sessiz de olsa ses ister)
      const cs = this.ctx.createConstantSource();
      const z = this.ctx.createGain();
      z.gain.value = 0;
      cs.connect(z); z.connect(this.dest); cs.start();
      this.ch = {};
      this.vol = {};
      this.muted = {};
    }

    resume() { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }

    set(name, stream) {
      this.remove(name);
      if (!stream || !stream.getAudioTracks().length) return;
      const src = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(gain); gain.connect(this.dest); gain.connect(an);
      this.ch[name] = { src, gain, an, buf: new Float32Array(an.fftSize), stream };
      this.apply(name);
    }

    remove(name) {
      const c = this.ch[name];
      if (!c) return;
      try { c.src.disconnect(); c.gain.disconnect(); } catch {}
      delete this.ch[name];
    }

    apply(name) {
      const c = this.ch[name];
      if (!c) return;
      const v = this.muted[name] ? 0 : (this.vol[name] ?? 1);
      c.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }

    setVolume(name, v) { this.vol[name] = v; this.apply(name); }
    setMuted(name, m) { this.muted[name] = m; this.apply(name); }

    // 0..1 arası seviye (-60 dB .. 0 dB), kazanç sonrası
    level(name) {
      const c = this.ch[name];
      if (!c) return 0;
      c.an.getFloatTimeDomainData(c.buf);
      let peak = 0;
      for (let i = 0; i < c.buf.length; i++) { const a = Math.abs(c.buf[i]); if (a > peak) peak = a; }
      if (peak <= 0.000001) return 0;
      const db = 20 * Math.log10(peak);
      return Math.max(0, Math.min(1, (db + 60) / 60));
    }

    // Uyarı sesi. Masaüstü sesi yakalanıyorsa hoparlöre çalmak yeterli (zaten yayına girer);
    // değilse ayrıca doğrudan yayın sesine de eklenir.
    chime(volume, toStream) {
      const t = this.ctx.currentTime;
      const out = this.ctx.createGain();
      out.gain.value = volume;
      out.connect(this.ctx.destination);
      if (toStream) out.connect(this.dest);
      [880, 1318.5, 1760].forEach((f, i) => {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const s = t + i * 0.11;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6);
        o.connect(g); g.connect(out);
        o.start(s); o.stop(s + 0.65);
      });
      setTimeout(() => { try { out.disconnect(); } catch {} }, 1500);
    }
  }

  // ---------------------------------------------------------------- yardımcılar
  function mkVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    return v;
  }

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
  const easeInCubic = (t) => t * t * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------- Compositor
  class Compositor {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.mixer = new AudioMixer();
      this.scene = 'game';
      this.prevScene = null;
      this.transAt = 0;
      this.gameVideo = mkVideo();
      this.camVideo = mkVideo();
      this.chat = [];
      this.alertQueue = [];
      this.alert = null;
      this.images = new Map();
      this.cfg = null;
      this.rec = null;
      this.onAlert = null;
      this.drawCost = 0;
      this.setSize(1920, 1080, 60);
    }

    configure(cfg) {
      this.cfg = cfg;
      for (const m of this.chat) m.layoutKey = null;
    }

    setSize(W, H, fps) {
      if (this.rec) return false; // yayın sırasında değişmez
      this.W = W; this.H = H; this.fps = fps;
      this.s = H / 1080;
      this.canvas.width = W;
      this.canvas.height = H;
      for (const m of this.chat) m.layoutKey = null;
      this.startTicker();
      return true;
    }

    // Worker zamanlayıcısı: pencere küçültülse/arka planda olsa da çizim sürer
    startTicker() {
      if (!this.worker) {
        const src = 'let t;onmessage=e=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}';
        this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        this.worker.onmessage = () => {
          const a = performance.now();
          try { this.draw(a); } catch (e) { console.error(e); }
          this.drawCost = this.drawCost * 0.95 + (performance.now() - a) * 0.05;
        };
      }
      this.worker.postMessage(1000 / this.fps);
    }

    // own=false: akış başkasına ait (ör. telefon kamerası), değiştirilince kapatılmaz
    attach(video, stream, own = true) {
      const old = video.srcObject;
      if (old && old !== stream && video._own !== false) old.getTracks().forEach((t) => t.stop());
      video._own = own;
      video.srcObject = stream || null;
      if (stream) video.play().catch(() => {});
    }
    setGameStream(stream) { this.attach(this.gameVideo, stream); }
    setCamStream(stream, own = true) { this.attach(this.camVideo, stream, own); }

    setScene(name) {
      if (name === this.scene) return;
      this.prevScene = this.scene;
      this.scene = name;
      this.transAt = performance.now();
    }

    addChat(evt) {
      this.chat.push({ evt, at: performance.now(), layoutKey: null, layout: null });
      if (this.chat.length > 60) this.chat.shift();
      for (const p of evt.parts || []) if (p.t === 'img') this.image(p.src);
      const al = this.cfg && this.cfg.alerts;
      const alertable = ['gift', 'superchat', 'sub', 'raid'].includes(evt.type) || (evt.type === 'follow' && al && al.follows);
      if (al && al.enabled && alertable) {
        if (evt.gift && evt.gift.image) this.image(evt.gift.image);
        this.alertQueue.push(evt);
        if (this.alertQueue.length > 30) this.alertQueue.shift();
      }
    }

    removeChat(ids) { this.chat = this.chat.filter((m) => !ids.includes(m.evt.id)); }

    image(src) {
      if (!src) return null;
      let e = this.images.get(src);
      if (!e) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        e = { img, ok: false };
        img.onload = () => { e.ok = true; for (const m of this.chat) m.layoutKey = null; };
        img.onerror = () => { e.failed = true; };
        img.src = src;
        this.images.set(src, e);
        if (this.images.size > 400) this.images.delete(this.images.keys().next().value);
      }
      return e.ok ? e.img : null;
    }

    // ------------------------------------------------------------ çizim
    draw(now) {
      if (!this.cfg) return;
      const { ctx } = this;
      const T = 400;
      const k = this.prevScene ? clamp((now - this.transAt) / T, 0, 1) : 1;
      if (k < 1) {
        this.drawScene(this.prevScene, now);
        ctx.globalAlpha = k;
        this.drawScene(this.scene, now);
        ctx.globalAlpha = 1;
      } else {
        this.prevScene = null;
        this.drawScene(this.scene, now);
      }
      if (this.cfg.viewerChat.enabled) this.drawChat(now);
      if (this.cfg.alerts.enabled) this.drawAlert(now);
    }

    drawScene(name, now) {
      if (name === 'game') return this.drawGame(now);
      return this.drawCard(name, now);
    }

    videoReady(v) { return v.srcObject && v.readyState >= 2 && v.videoWidth > 0; }

    drawGame(now) {
      const { ctx, W, H, s } = this;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const v = this.gameVideo;
      if (this.videoReady(v)) {
        const r = Math.min(W / v.videoWidth, H / v.videoHeight);
        const w = v.videoWidth * r, h = v.videoHeight * r;
        ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
      } else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#15161d'); g.addColorStop(1, '#0b0c10');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        ctx.font = `600 ${40 * s}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('Oyun kaynağı bekleniyor…', W / 2, H / 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
      this.drawCam();
    }

    camRect() {
      const c = this.cfg.sources;
      if (!c.camEnabled || !this.videoReady(this.camVideo)) return null;
      const { W, H, s } = this;
      const v = this.camVideo;
      const w = W * (c.camSize || 22) / 100;
      // Dikey görüntü (telefon dik tutulmuş) uzun şerit olmasın: en fazla kare, ortadan kırp
      const aspect = Math.min(v.videoHeight / v.videoWidth, 1);
      const h = w * aspect;
      const m = 28 * s;
      const x = c.camCorner.endsWith('l') ? m : W - w - m;
      const y = c.camCorner.startsWith('t') ? m : H - h - m;
      const sh = v.videoWidth * aspect;
      return { x, y, w, h, sx: 0, sy: (v.videoHeight - sh) / 2, sw: v.videoWidth, sh };
    }

    drawCam() {
      const r = this.camRect();
      if (!r) return;
      const { ctx, s } = this;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 24 * s;
      rr(ctx, r.x, r.y, r.w, r.h, 18 * s);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.clip();
      const p = CAM_FILTERS[this.cfg.sources.camFilter];
      const fx = p && (this.camFx || (this.camFx = new CamFx()));
      const src = fx && fx.ok ? fx.render(this.camVideo, r, p) : null;
      if (src) ctx.drawImage(src, 0, 0, src.width, src.height, r.x, r.y, r.w, r.h);
      else ctx.drawImage(this.camVideo, r.sx, r.sy, r.sw, r.sh, r.x, r.y, r.w, r.h);
      ctx.restore();
      ctx.save();
      rr(ctx, r.x, r.y, r.w, r.h, 18 * s);
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.stroke();
      ctx.restore();
    }

    drawCard(name, now) {
      const { ctx, W, H, s } = this;
      const t = now / 1000;
      ctx.fillStyle = '#0b0b12';
      ctx.fillRect(0, 0, W, H);
      // hareketli renk lekeleri
      const blobs = [
        [0.25 + 0.08 * Math.sin(t * 0.5), 0.35 + 0.1 * Math.cos(t * 0.4), '124,92,255'],
        [0.75 + 0.07 * Math.cos(t * 0.45), 0.6 + 0.1 * Math.sin(t * 0.35), '254,44,85'],
        [0.5 + 0.1 * Math.sin(t * 0.3), 0.85 + 0.05 * Math.cos(t * 0.5), '37,244,238']
      ];
      for (const [bx, by, col] of blobs) {
        const g = ctx.createRadialGradient(bx * W, by * H, 0, bx * W, by * H, 0.55 * W);
        g.addColorStop(0, `rgba(${col},.38)`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      const sc = this.cfg.scenes;
      const title = name === 'starting' ? sc.startingText : sc.brbText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,.5)';
      ctx.shadowBlur = 30 * s;
      ctx.font = `800 ${92 * s}px ${FONT}`;
      ctx.fillText(title || '', W / 2, H * 0.44);
      ctx.shadowBlur = 0;
      // nokta animasyonu
      for (let i = 0; i < 3; i++) {
        const a = 0.3 + 0.7 * Math.max(0, Math.sin(t * 3 - i * 0.6));
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath();
        ctx.arc(W / 2 + (i - 1) * 34 * s, H * 0.44 + 84 * s, 9 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sc.subtitle) {
        ctx.font = `500 ${38 * s}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.fillText(sc.subtitle, W / 2, H * 0.44 + 160 * s);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // ------------------------------------------------------------ izleyici chat'i
    layoutMsg(m, maxW, fs) {
      const key = maxW + '|' + fs;
      if (m.layoutKey === key) return m.layout;
      const { ctx } = this;
      const evt = m.evt;
      const tokens = [];
      tokens.push({ k: 'badge', w: fs * 1.55 + fs * 0.35 });
      if (evt.type !== 'chat') tokens.push({ k: 'text', v: (TYPE_ICON[evt.type] || '') + ' ', bold: false });
      ctx.font = `700 ${fs}px ${FONT}`;
      const name = (evt.user && evt.user.name) || '?';
      tokens.push({ k: 'name', v: name, w: ctx.measureText(name).width, color: nameColor(evt) });
      tokens.push({ k: 'text', v: evt.amount ? `  ${evt.amount}  ` : '  ', bold: !!evt.amount, color: evt.amount ? '#ffd43b' : null });
      for (const p of evt.parts || []) {
        if (p.t === 'img') tokens.push({ k: 'img', src: p.src, alt: p.alt, w: fs * 1.45 });
        else for (const w of String(p.v || '').split(/(\s+)/)) if (w) tokens.push({ k: 'text', v: w });
      }
      // genişlik ölçümü
      for (const t of tokens) {
        if (t.k === 'text') { ctx.font = `${t.bold ? 700 : 500} ${fs}px ${FONT}`; t.w = ctx.measureText(t.v).width; }
      }
      // satırlara böl
      const lines = [[]];
      let x = 0;
      const pushTok = (t) => { lines[lines.length - 1].push({ ...t, x }); x += t.w; };
      for (const t of tokens) {
        if (x > 0 && x + t.w > maxW) {
          if (t.k === 'text' && /^\s+$/.test(t.v)) continue;
          lines.push([]); x = 0;
        }
        if (t.k === 'text' && t.w > maxW) {
          // çok uzun kelimeyi harf harf böl
          ctx.font = `500 ${fs}px ${FONT}`;
          let buf = '';
          for (const ch of t.v) {
            const w = ctx.measureText(buf + ch).width;
            if (x + w > maxW && buf) {
              pushTok({ k: 'text', v: buf, w: ctx.measureText(buf).width });
              lines.push([]); x = 0; buf = ch;
            } else buf += ch;
          }
          if (buf) pushTok({ k: 'text', v: buf, w: ctx.measureText(buf).width });
          continue;
        }
        pushTok(t);
      }
      const lineH = fs * 1.42;
      const width = Math.max(...lines.map((l) => (l.length ? l[l.length - 1].x + l[l.length - 1].w : 0)));
      m.layout = { lines, lineH, width, height: lines.length * lineH };
      m.layoutKey = key;
      return m.layout;
    }

    drawChat(now) {
      const vc = this.cfg.viewerChat;
      const { ctx, W, H, s } = this;
      const fs = (vc.fontSize || 26) * s;
      const pad = fs * 0.5;
      const areaW = W * (vc.width || 26) / 100;
      const maxW = areaW - pad * 2;
      const left = vc.side !== 'right';
      const x0 = left ? 28 * s : W - areaW - 28 * s;
      let bottom = H - 28 * s;
      // kamera aynı alt köşedeyse chat'i kameranın üstüne al
      const cam = this.scene === 'game' ? this.camRect() : null;
      if (cam && cam.y > H / 2 && ((left && cam.x < W / 2) || (!left && cam.x > W / 2))) bottom = cam.y - 18 * s;
      const top = H * 0.18;
      const fadeMs = (Number(vc.fade) || 0) * 1000;
      const gap = 10 * s;
      let y = bottom;
      let shown = 0;
      for (let i = this.chat.length - 1; i >= 0 && shown < (vc.max || 8); i--) {
        const m = this.chat[i];
        const age = now - m.at;
        let alpha = 1;
        if (fadeMs > 0) {
          if (age > fadeMs + 800) continue;
          if (age > fadeMs) alpha = 1 - (age - fadeMs) / 800;
        }
        const L = this.layoutMsg(m, maxW, fs);
        const h = L.height + pad * 1.2;
        if (y - h < top) break;
        y -= h;
        const enter = clamp(age / 220, 0, 1);
        const slide = (1 - easeOutBack(enter)) * 40 * s * (left ? -1 : 1);
        ctx.globalAlpha = alpha * enter;
        this.drawMsg(m, L, x0 + slide, y, L.width + pad * 2, h, fs, pad);
        y -= gap;
        shown++;
      }
      ctx.globalAlpha = 1;
    }

    drawMsg(m, L, x, y, w, h, fs, pad) {
      const { ctx, s } = this;
      const evt = m.evt;
      const pc = (PLATFORMS[evt.platform] || {}).color || '#888';
      const hl = evt.type !== 'chat';
      ctx.save();
      rr(ctx, x, y, w, h, 12 * s);
      ctx.fillStyle = hl ? 'rgba(28,20,48,.86)' : 'rgba(8,9,14,.72)';
      ctx.fill();
      if (hl) { ctx.lineWidth = 2.5 * s; ctx.strokeStyle = pc; ctx.stroke(); }
      ctx.restore();
      const baseY = y + pad * 0.6;
      L.lines.forEach((line, li) => {
        const ly = baseY + li * L.lineH;
        const mid = ly + L.lineH / 2;
        for (const t of line) {
          const tx = x + pad + t.x;
          if (t.k === 'badge') {
            const p = PLATFORMS[evt.platform] || { short: '?', color: '#666', fg: '#fff' };
            const bw = fs * 1.55, bh = fs * 1.05;
            rr(ctx, tx, mid - bh / 2, bw, bh, 5 * s);
            ctx.fillStyle = p.color; ctx.fill();
            ctx.fillStyle = p.fg;
            ctx.font = `800 ${fs * 0.6}px ${FONT}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(p.short, tx + bw / 2, mid + 1);
            ctx.textAlign = 'left';
          } else if (t.k === 'img') {
            const img = this.image(t.src);
            if (img) {
              const ih = fs * 1.3;
              const iw = Math.min(t.w, ih * (img.naturalWidth / img.naturalHeight || 1));
              ctx.drawImage(img, tx, mid - ih / 2, iw, ih);
            } else {
              ctx.font = `500 ${fs * 0.8}px ${FONT}`;
              ctx.fillStyle = 'rgba(255,255,255,.6)';
              ctx.textBaseline = 'middle';
              ctx.fillText(t.alt || '▢', tx, mid);
            }
          } else {
            ctx.font = `${t.k === 'name' || t.bold ? 700 : 500} ${fs}px ${FONT}`;
            ctx.fillStyle = t.color || (t.k === 'name' ? '#fff' : '#f1f3f5');
            ctx.textBaseline = 'middle';
            ctx.fillText(t.v, tx, mid);
          }
        }
      });
      ctx.textBaseline = 'alphabetic';
    }

    // ------------------------------------------------------------ hediye / abone uyarısı
    drawAlert(now) {
      const al = this.cfg.alerts;
      if (!this.alert && this.alertQueue.length) {
        const evt = this.alertQueue.shift();
        this.alert = { evt, at: now };
        if (this.onAlert) this.onAlert(evt);
      }
      if (!this.alert) return;
      const dur = (Number(al.duration) || 6) * 1000;
      const t = now - this.alert.at;
      if (t > dur) { this.alert = null; return; }
      const { ctx, W, s } = this;
      const evt = this.alert.evt;
      const pc = (PLATFORMS[evt.platform] || {}).color || '#7c5cff';
      const inT = clamp(t / 550, 0, 1);
      const outT = clamp((t - (dur - 400)) / 400, 0, 1);

      const cw = Math.min(W * 0.52, 980 * s);
      const ch = 170 * s;
      const cx = (W - cw) / 2;
      const ty = 46 * s;
      const y = -ch + (ty + ch) * easeOutBack(inT) - (ty + ch) * easeInCubic(outT);
      ctx.save();
      ctx.globalAlpha = 1 - outT;
      ctx.shadowColor = pc;
      ctx.shadowBlur = 36 * s;
      rr(ctx, cx, y, cw, ch, 26 * s);
      const g = ctx.createLinearGradient(cx, y, cx + cw, y + ch);
      g.addColorStop(0, 'rgba(22,18,40,.96)');
      g.addColorStop(1, 'rgba(40,16,48,.96)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 4 * s;
      ctx.strokeStyle = pc;
      ctx.stroke();

      // sol: hediye görseli ya da büyük ikon
      const isz = 118 * s;
      const ix = cx + 26 * s, iy = y + (ch - isz) / 2;
      const img = evt.gift && evt.gift.image ? this.image(evt.gift.image) : null;
      const bounce = 1 + 0.06 * Math.sin(t / 140);
      if (img) {
        ctx.drawImage(img, ix + isz * (1 - bounce) / 2, iy + isz * (1 - bounce) / 2, isz * bounce, isz * bounce);
      } else {
        ctx.font = `${isz * 0.72 * bounce}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(TYPE_ICON[evt.type] || '🎉', ix + isz / 2, iy + isz / 2 + 4 * s);
        ctx.textAlign = 'left';
      }
      // sağ: yazılar
      const tx = ix + isz + 26 * s;
      const tw = cx + cw - tx - 28 * s;
      ctx.textBaseline = 'alphabetic';
      ctx.font = `800 ${46 * s}px ${FONT}`;
      ctx.fillStyle = pc;
      ctx.fillText(this.fit((evt.user && evt.user.name) || '?', tw), tx, y + 66 * s);
      ctx.font = `700 ${36 * s}px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.fillText(this.fit(this.alertLine(evt), tw), tx, y + 112 * s);
      if (evt.type === 'superchat' && evt.text) {
        ctx.font = `500 ${28 * s}px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,.8)';
        ctx.fillText(this.fit(evt.text, tw), tx, y + 150 * s);
      }
      ctx.restore();
    }

    alertLine(evt) {
      switch (evt.type) {
        case 'superchat': return `${evt.amount || ''} Süper Chat gönderdi!`;
        case 'follow': return 'takip etti!';
        case 'raid': return evt.text || 'host attı!';
        case 'sub': return evt.text || 'abone oldu!';
        default: return evt.text || 'hediye gönderdi!';
      }
    }

    fit(text, maxW) {
      const ctx = this.ctx;
      if (ctx.measureText(text).width <= maxW) return text;
      let t = text;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
      return t + '…';
    }

    // ------------------------------------------------------------ kayıt / yayın akışı
    pickMime() {
      const list = [
        'video/x-matroska;codecs=avc1,opus',
        'video/webm;codecs=h264,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
      return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    }

    startRecording(bitrateKbps, onChunk) {
      if (this.rec) return this.rec.mimeType;
      this.mixer.resume();
      const mime = this.pickMime();
      if (!mime) throw new Error('Bu sistemde MediaRecorder video kodlaması desteklenmiyor');
      const cs = this.canvas.captureStream(this.fps);
      const stream = new MediaStream([...cs.getVideoTracks(), ...this.mixer.dest.stream.getAudioTracks()]);
      // Ara akış: yüksek bit hızlı (kalite kaybı olmasın). Asıl platform kodlaması FFmpeg'de yapılır.
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: Math.max(20000, (bitrateKbps || 6000) * 3) * 1000,
        audioBitsPerSecond: 256000
      });
      let chain = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const blob = e.data;
        chain = chain.then(() => blob.arrayBuffer()).then((b) => onChunk(b)).catch((err) => console.error(err));
      };
      this.recDone = new Promise((res) => { rec.onstop = () => chain.then(res); });
      this.capStream = cs;
      rec.start(200);
      this.rec = rec;
      return mime;
    }

    async stopRecording() {
      const rec = this.rec;
      if (!rec) return;
      if (rec.state !== 'inactive') rec.stop();
      await this.recDone;
      this.capStream.getVideoTracks().forEach((t) => t.stop());
      this.rec = null;
    }
  }

  window.Compositor = Compositor;
})();
