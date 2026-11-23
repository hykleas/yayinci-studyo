// Ana pencere: kaynaklar, ses, sahneler, yayın başlat/bitir, chat paneli, ayarlar.
(async function () {
  const api = window.api;
  const { PLATFORMS, renderEvent } = window.ChatRender;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let S = await api.getSettings();
  const comp = new window.Compositor($('#out'));
  comp.configure(S);
  comp.setSize(S.video.width, S.video.height, S.video.fps);

  let live = false;
  let starting = false;
  let liveStart = 0;
  let micMuted = !S.sources.micEnabled;
  let deskMuted = !S.sources.deskEnabled;
  let gameThumb = '';
  const viewers = {};

  // ------------------------------------------------------------ yardımcılar
  function toast(msg, kind = 'info', ms = 5000) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  const logLines = [];
  function log(line) {
    const t = new Date().toLocaleTimeString('tr-TR');
    logLines.push(`[${t}] ${line}`);
    if (logLines.length > 300) logLines.shift();
    const box = $('#logBox');
    if (box) { box.textContent = logLines.join('\n'); box.scrollTop = box.scrollHeight; }
  }

  const getK = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setK(o, p, v) {
    const ks = p.split('.');
    let c = o;
    for (let i = 0; i < ks.length - 1; i++) c = c[ks[i]] = c[ks[i]] || {};
    c[ks[ks.length - 1]] = v;
  }

  async function save(patch) {
    S = await api.setSettings(patch);
    comp.configure(S);
    return S;
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  api.onSettings((s) => { S = s; comp.configure(S); $('#ovEnabled').checked = !!S.overlay.enabled; });

  // ------------------------------------------------------------ yakalama
  let capLock = Promise.resolve();
  function displayMedia(sourceId, audio, fps) {
    const p = capLock.then(async () => {
      await api.prepareCapture(sourceId, audio);
      return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio: !!audio });
    });
    capLock = p.catch(() => {});
    return p;
  }

  function setGameUi(name, state) {
    $('#gameName').textContent = name || 'Seçilmedi';
    $('#gameName').title = name || '';
    $('#gameState').textContent = state || '';
    $('#gameThumb').src = gameThumb || '';
  }

  let gameRetry = null;
  async function captureGame() {
    clearTimeout(gameRetry);
    const s = S.sources;
    if (!s.gameId && !s.gameName) { comp.setGameStream(null); setGameUi('', 'Yayına gidecek oyunu/ekranı seç'); return; }
    let list = [];
    try { list = await api.listSources({ thumbs: false }); } catch {}
    const src = list.find((x) => x.id === s.gameId) || list.find((x) => x.name === s.gameName);
    if (!src) {
      comp.setGameStream(null);
      setGameUi(s.gameName, 'Pencere bekleniyor… (oyun açık mı?)');
      gameRetry = setTimeout(captureGame, 5000);
      return;
    }
    try {
      const stream = await displayMedia(src.id, false, S.video.fps);
      comp.setGameStream(stream);
      setGameUi(src.name, src.type === 'screen' ? '● Ekran yakalanıyor' : '● Pencere yakalanıyor');
      const tr = stream.getVideoTracks()[0];
      tr.onended = () => {
        if (comp.gameVideo.srcObject !== stream) return;
        comp.setGameStream(null);
        setGameUi(src.name, 'Pencere kapandı, bekleniyor…');
        gameRetry = setTimeout(captureGame, 3000);
      };
      if (src.id !== s.gameId || src.name !== s.gameName) save({ sources: { gameId: src.id, gameName: src.name } });
    } catch (e) {
      setGameUi(s.gameName, 'Yakalanamadı: ' + e.message);
      gameRetry = setTimeout(captureGame, 5000);
    }
  }

  let deskStream = null;
  async function captureDesk() {
    if (deskStream) { deskStream.getTracks().forEach((t) => t.stop()); deskStream = null; }
    comp.mixer.remove('desk');
    try {
      const st = await displayMedia(null, true, 1);
      deskStream = st;
      if (!st.getAudioTracks().length) { toast('Masaüstü sesi alınamadı (ses izi yok).', 'error'); return; }
      comp.mixer.set('desk', st);
    } catch (e) {
      toast('Masaüstü sesi alınamadı: ' + e.message, 'error');
    }
  }

  let micStream = null;
  async function captureMic() {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
    comp.mixer.remove('mic');
    const id = S.sources.micId;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id && id !== 'default' ? { exact: id } : undefined,
          echoCancellation: false, autoGainControl: false, noiseSuppression: !!S.sources.micNoise
        },
        video: false
      });
      comp.mixer.set('mic', micStream);
    } catch (e) {
      toast('Mikrofon açılamadı: ' + e.message, 'error');
    }
  }

  // ---- telefon kamerası (WebRTC alıcı; sinyalleşme ana süreç üzerinden) ----
  let phonePc = null;
  let phoneStream = null;
  let phoneState = 'none';

  function gatherDone(pc, ms) {
    return new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }

  function setPhoneState(st) {
    phoneState = st;
    const map = { none: ['', 'Telefon bekleniyor'], waiting: ['connecting', 'Telefon sayfası açık, kamera bekleniyor'], connecting: ['connecting', 'Bağlanıyor…'], connected: ['connected', 'Telefon bağlı ✓'], lost: ['error', 'Telefon bağlantısı koptu'] };
    const [cls, txt] = map[st] || map.none;
    const el = $('#pcState');
    if (el) { el.className = 'st-pill ' + cls; el.innerHTML = '<i></i>'; el.append(txt); }
  }

  function phoneLost() {
    phoneStream = null;
    if (S.sources.camId === 'phone') comp.setCamStream(null, false);
  }

  api.onPhoneCamSignal(async (m) => {
    if (m.type === 'phone-connected') { setPhoneState('waiting'); return; }
    if (m.type === 'left') {
      try { phonePc?.close(); } catch {}
      phonePc = null;
      phoneLost();
      setPhoneState('lost');
      if (S.sources.camId === 'phone' && S.sources.camEnabled) toast('Telefon kamerası bağlantısı koptu.', 'error');
      return;
    }
    if (m.type !== 'offer') return;
    try { phonePc?.close(); } catch {}
    const pc = new RTCPeerConnection({ iceServers: [] });
    phonePc = pc;
    setPhoneState('connecting');
    pc.ontrack = (e) => {
      phoneStream = e.streams[0] || new MediaStream([e.track]);
      if (S.sources.camId === 'phone' && S.sources.camEnabled) comp.setCamStream(phoneStream, false);
    };
    pc.onconnectionstatechange = () => {
      if (phonePc !== pc) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        setPhoneState('connected');
        toast('📱 Telefon kamerası bağlandı', 'ok', 2500);
        if (S.sources.camId !== 'phone' || !S.sources.camEnabled) {
          save({ sources: { camId: 'phone', camEnabled: true } }).then(() => { syncQuick(); fillDevices(); captureCam(); });
        }
      } else if (s === 'failed' || s === 'closed') { phoneLost(); setPhoneState('lost'); }
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gatherDone(pc, 2500);
      api.phoneCamSend({ type: 'answer', sdp: pc.localDescription.sdp });
    } catch (e) {
      log('Telefon kamera WebRTC hatası: ' + e.message);
      setPhoneState('lost');
    }
  });

  async function openPhoneCam() {
    const info = await api.phoneCamInfo();
    if (info.error) { toast(info.error, 'error', 8000); return; }
    $('#pcQr').src = info.qr;
    $('#pcUrl').textContent = info.url;
    setPhoneState(phoneStream ? 'connected' : info.connected ? 'waiting' : phoneState === 'lost' ? 'lost' : 'none');
    $('#dlgPhoneCam').showModal();
    // telefon sayfası zaten açıksa yeniden bağlansın
    if (info.connected && !phoneStream) api.phoneCamSend({ type: 'renegotiate' });
  }
  $('#btnPhoneCam').onclick = openPhoneCam;

  async function captureCam() {
    if (!S.sources.camEnabled) { comp.setCamStream(null); return; }
    const id = S.sources.camId;
    if (id === 'phone') {
      if (phoneStream) comp.setCamStream(phoneStream, false);
      else {
        comp.setCamStream(null);
        const info = await api.phoneCamInfo();
        if (info.connected) api.phoneCamSend({ type: 'renegotiate' });
      }
      return;
    }
    comp.setCamStream(null);
    try {
      const st = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false
      });
      comp.setCamStream(st);
    } catch (e) {
      toast('Kamera açılamadı: ' + e.message, 'error');
    }
  }

  async function fillDevices() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const mics = devs.filter((d) => d.kind === 'audioinput');
    const cams = devs.filter((d) => d.kind === 'videoinput');
    const micSel = $('#micId');
    micSel.innerHTML = '';
    for (const d of mics) micSel.add(new Option(d.label || 'Mikrofon', d.deviceId));
    micSel.value = S.sources.micId;
    if (micSel.value !== S.sources.micId && mics.length) micSel.value = mics[0].deviceId;
    const camSel = $('#camId');
    camSel.innerHTML = '';
    for (const d of cams) camSel.add(new Option(d.label || 'Kamera', d.deviceId));
    camSel.add(new Option('📱 Telefon kamerası', 'phone'));
    if (S.sources.camId) camSel.value = S.sources.camId;
    if (!S.sources.camId) await save({ sources: { camId: cams.length ? cams[0].deviceId : 'phone' } });
    camSel.value = S.sources.camId;
  }
  navigator.mediaDevices.addEventListener('devicechange', debounce(fillDevices, 500));

  // ------------------------------------------------------------ hızlı kontroller
  function syncQuick() {
    $('#camEnabled').checked = !!S.sources.camEnabled;
    $('#camCorner').value = S.sources.camCorner;
    $('#camFilter').value = S.sources.camFilter;
    $('#camSize').value = S.sources.camSize;
    $('#micGain').value = S.sources.micGain;
    $('#deskGain').value = S.sources.deskGain;
    $('#ovEnabled').checked = !!S.overlay.enabled;
    $('#recToggle').checked = !!S.record.enabled;
    $('#micMute').classList.toggle('off', micMuted);
    $('#deskMute').classList.toggle('off', deskMuted);
    comp.mixer.setVolume('mic', Number(S.sources.micGain));
    comp.mixer.setVolume('desk', Number(S.sources.deskGain));
    comp.mixer.setMuted('mic', micMuted);
    comp.mixer.setMuted('desk', deskMuted);
  }

  $('#camEnabled').onchange = async (e) => { await save({ sources: { camEnabled: e.target.checked } }); captureCam(); };
  $('#camId').onchange = async (e) => {
    await save({ sources: { camId: e.target.value } });
    captureCam();
    if (e.target.value === 'phone' && !phoneStream) openPhoneCam();
  };
  $('#camCorner').onchange = (e) => save({ sources: { camCorner: e.target.value } });
  $('#camFilter').onchange = (e) => { S.sources.camFilter = e.target.value; comp.configure(S); save({ sources: { camFilter: e.target.value } }); };
  const saveCamSize = debounce((v) => save({ sources: { camSize: v } }), 300);
  $('#camSize').oninput = (e) => { S.sources.camSize = Number(e.target.value); comp.configure(S); saveCamSize(S.sources.camSize); };
  $('#micId').onchange = async (e) => { await save({ sources: { micId: e.target.value } }); captureMic(); };
  const saveGain = debounce((k, v) => save({ sources: { [k]: v } }), 400);
  $('#micGain').oninput = (e) => { const v = Number(e.target.value); comp.mixer.setVolume('mic', v); saveGain('micGain', v); };
  $('#deskGain').oninput = (e) => { const v = Number(e.target.value); comp.mixer.setVolume('desk', v); saveGain('deskGain', v); };

  function toggleMic() {
    micMuted = !micMuted;
    comp.mixer.setMuted('mic', micMuted);
    $('#micMute').classList.toggle('off', micMuted);
    save({ sources: { micEnabled: !micMuted } });
    toast(micMuted ? 'Mikrofon KAPALI' : 'Mikrofon açık', micMuted ? 'error' : 'ok', 1800);
    pushOverlayState();
  }
  $('#micMute').onclick = toggleMic;
  $('#deskMute').onclick = () => {
    deskMuted = !deskMuted;
    comp.mixer.setMuted('desk', deskMuted);
    $('#deskMute').classList.toggle('off', deskMuted);
    save({ sources: { deskEnabled: !deskMuted } });
  };

  $('#ovEnabled').onchange = (e) => { if (e.target.checked !== !!S.overlay.enabled) api.overlayToggle(); };
  $('#btnOvEdit').onclick = () => api.overlayEdit();
  $('#recToggle').onchange = (e) => save({ record: { enabled: e.target.checked } });

  // ses göstergeleri
  function meters() {
    $('#micMeter').style.width = (comp.mixer.level('mic') * 100).toFixed(1) + '%';
    $('#deskMeter').style.width = (comp.mixer.level('desk') * 100).toFixed(1) + '%';
    requestAnimationFrame(meters);
  }
  requestAnimationFrame(meters);
  document.addEventListener('pointerdown', () => comp.mixer.resume());

  // ------------------------------------------------------------ sahneler
  const SCENE_TAG = { game: '', starting: 'Başlıyoruz sahnesi', brb: 'Mola sahnesi' };
  function setScene(name) {
    comp.setScene(name);
    $$('.scene').forEach((b) => b.classList.toggle('active', b.dataset.scene === name));
    $('#sceneTag').textContent = SCENE_TAG[name] || '';
    pushOverlayState();
  }
  $$('.scene').forEach((b) => (b.onclick = () => setScene(b.dataset.scene)));

  api.onHotkey((h) => {
    if (h.action === 'scene') setScene(h.scene);
    if (h.action === 'mic') toggleMic();
  });

  function pushOverlayState() {
    api.overlayState({ live, startedAt: liveStart, micMuted, scene: comp.scene });
  }
  setInterval(pushOverlayState, 2000);

  // ------------------------------------------------------------ yayın
  const BADGE = { idle: ['off', 'ÇEVRİMDIŞI'], starting: ['starting', 'BAĞLANIYOR'], live: ['live', 'CANLI'], stopping: ['starting', 'KAPANIYOR'] };

  function resetLiveUi() {
    const btn = $('#btnLive');
    btn.disabled = false;
    btn.textContent = 'Yayını Başlat';
    btn.classList.remove('on');
    $('#recToggle').disabled = false;
    $('#liveStats').textContent = '';
    $('#outputs').innerHTML = '';
  }

  async function startLive() {
    const btn = $('#btnLive');
    starting = true;
    btn.disabled = true;
    btn.textContent = 'Başlatılıyor…';
    comp.mixer.resume();
    const res = await api.startStream({ width: comp.W, height: comp.H, fps: comp.fps });
    if (!res || !res.ok) {
      starting = false;
      resetLiveUi();
      toast((res && res.error) || 'Yayın başlatılamadı', 'error', 10000);
      return;
    }
    try {
      const mime = comp.startRecording(Number(S.video.bitrate), (buf) => api.sendChunk(buf));
      log(`Yayın başladı. Ara akış: ${mime} · Kodlayıcı: ${res.encoderLabel} · Çıkışlar: ${res.outputs.join(', ')}`);
      if (!/avc1|h264/.test(mime)) toast('Not: Donanım H.264 ara kodlaması yok, VP8/VP9 kullanılıyor. İşlemci yükü artabilir.', 'info', 8000);
    } catch (e) {
      toast(e.message, 'error', 10000);
      await api.stopStream();
      starting = false;
      resetLiveUi();
      return;
    }
    starting = false;
    live = true;
    liveStart = Date.now();
    btn.disabled = false;
    btn.textContent = 'Yayını Bitir';
    btn.classList.add('on');
    $('#recToggle').disabled = true;
    pushOverlayState();
  }

  async function stopLive() {
    const btn = $('#btnLive');
    btn.disabled = true;
    btn.textContent = 'Kapatılıyor…';
    await comp.stopRecording();
    await api.stopStream();
  }

  $('#btnLive').onclick = () => {
    if (starting) return;
    if (live) {
      if (confirm('Yayını bitirmek istediğine emin misin?')) stopLive();
    } else startLive();
  };

  api.onStreamStatus(async (s) => {
    const [cls, txt] = BADGE[s.state] || BADGE.idle;
    const b = $('#liveBadge');
    b.className = 'badge ' + cls;
    b.textContent = txt;
    if (s.outputs && !s.ended) {
      $('#outputs').innerHTML = '';
      for (const o of s.outputs) {
        const el = document.createElement('span');
        el.className = 'out-pill ' + o.state;
        el.innerHTML = '<i></i>';
        el.append(o.name);
        el.title = o.state === 'error' ? 'Bağlantı hatası — günlüğe bak (Ayarlar > Gelişmiş)' : o.state === 'ok' ? 'Gönderiliyor' : 'Bağlanıyor';
        $('#outputs').appendChild(el);
      }
    }
    if (s.fps !== undefined) {
      const warn = s.speed && s.speed < 0.95 ? ' · ⚠ kodlayıcı yetişemiyor' : '';
      $('#liveStats').textContent = `${Math.round(s.kbps)} kbps · ${Math.round(s.fps)} fps · ${s.encoderLabel || ''}${s.drop ? ` · ${s.drop} kare atlandı` : ''}${warn}`;
    }
    if (s.ended) {
      if (comp.rec) await comp.stopRecording();
      live = false;
      starting = false;
      resetLiveUi();
      pushOverlayState();
      if (s.error) { toast('Yayın durdu:\n' + s.error, 'error', 15000); log('HATA: ' + s.error); }
      else { toast('Yayın bitti.', 'ok'); log('Yayın bitti.'); }
    }
  });
  api.onStreamLog((l) => { log(l.text); if (l.level === 'error') toast(l.text, 'error', 9000); });

  const pad = (n) => String(n).padStart(2, '0');
  setInterval(() => {
    if (!live) { $('#liveTimer').textContent = '00:00:00'; return; }
    const t = Math.floor((Date.now() - liveStart) / 1000);
    $('#liveTimer').textContent = `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
  }, 500);

  // ------------------------------------------------------------ chat
  const list = $('#chatList');
  let stick = true;
  list.addEventListener('scroll', () => {
    stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    if (stick) $('#chatJump').hidden = true;
  });
  $('#chatJump').onclick = () => { list.scrollTop = list.scrollHeight; $('#chatJump').hidden = true; };

  function addChatEl(evt) {
    list.appendChild(renderEvent(evt));
    while (list.children.length > 400) list.firstChild.remove();
    if (stick) list.scrollTop = list.scrollHeight;
    else $('#chatJump').hidden = false;
  }

  for (const e of await api.chatHistory()) addChatEl(e);
  api.onChat((evt) => { addChatEl(evt); comp.addChat(evt); });
  api.onChatRemove(({ id, raw }) => {
    $$('.msg', list).forEach((el) => { if (el.dataset.id === id || el.dataset.id === raw) el.remove(); });
    comp.removeChat([id, raw]);
  });

  let lastStatus = {};
  function renderStatus(st) {
    if (st) lastStatus = st;
    const box = $('#chatStatus');
    box.innerHTML = '';
    for (const id of ['youtube', 'kick', 'tiktok']) {
      const s = lastStatus[id] || { state: 'off', detail: 'Kanal girilmedi (Ayarlar > Platformlar)' };
      const el = document.createElement('span');
      el.className = 'st-pill ' + s.state;
      el.innerHTML = '<i></i>';
      el.append(PLATFORMS[id].name + (viewers[id] !== undefined && s.state === 'connected' ? ` · 👁 ${viewers[id]}` : ''));
      el.title = s.detail || s.state;
      box.appendChild(el);
    }
  }
  renderStatus(await api.chatStatus());
  api.onChatStatus(renderStatus);
  api.onViewers((v) => { viewers[v.platform] = v.count; renderStatus(); });

  $('#btnTest').onclick = () => api.chatTest($('#testKind').value);
  $('#btnReconnect').onclick = () => { api.chatReconnect(); toast('Chat bağlantıları yenileniyor…', 'info', 2000); };

  comp.onAlert = () => {
    if (!S.alerts.sound) return;
    comp.mixer.chime(Number(S.alerts.volume) || 0.5, deskMuted || !deskStream);
  };

  // ------------------------------------------------------------ kaynak seçici
  const dlgSrc = $('#dlgSources');
  let srcType = 'window';
  let srcCache = [];
  async function loadSources() {
    $('#srcGrid').innerHTML = '<p class="muted">Yükleniyor…</p>';
    try { srcCache = await api.listSources({ thumbs: true }); } catch { srcCache = []; }
    renderSources();
  }
  function renderSources() {
    const grid = $('#srcGrid');
    grid.innerHTML = '';
    const items = srcCache.filter((x) => x.type === srcType);
    if (!items.length) { grid.innerHTML = '<p class="muted">Bulunamadı.</p>'; return; }
    for (const s of items) {
      const b = document.createElement('button');
      b.className = 'src-item' + (s.id === S.sources.gameId ? ' sel' : '');
      const im = document.createElement('div');
      im.className = 'im';
      if (s.thumb) { const i = document.createElement('img'); i.src = s.thumb; im.appendChild(i); }
      const nm = document.createElement('div');
      nm.className = 'nm';
      if (s.icon) { const i = document.createElement('img'); i.src = s.icon; nm.appendChild(i); }
      const sp = document.createElement('span');
      sp.textContent = s.name;
      sp.title = s.name;
      nm.appendChild(sp);
      b.append(im, nm);
      b.onclick = async () => {
        dlgSrc.close();
        gameThumb = s.thumb;
        await save({ sources: { gameId: s.id, gameName: s.name } });
        captureGame();
      };
      grid.appendChild(b);
    }
  }
  $('#btnPickGame').onclick = () => { dlgSrc.showModal(); loadSources(); };
  $('#btnSrcRefresh').onclick = loadSources;
  $$('[data-st]', dlgSrc).forEach((b) => (b.onclick = () => {
    srcType = b.dataset.st;
    $$('[data-st]', dlgSrc).forEach((x) => x.classList.toggle('on', x === b));
    renderSources();
  }));

  // ------------------------------------------------------------ telefon
  $('#btnMobile').onclick = async () => {
    if (!S.mobile.enabled) { toast('Telefon sunucusu kapalı (Ayarlar > Gelişmiş).', 'error'); return; }
    const info = await api.mobileInfo();
    $('#qrImg').src = info.qr;
    $('#qrUrl').textContent = info.url;
    $('#dlgMobile').showModal();
  };

  // ------------------------------------------------------------ ayarlar
  const dlgSet = $('#dlgSettings');
  $$('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
  $$('.stabs button', dlgSet).forEach((b) => (b.onclick = () => {
    $$('.stabs button', dlgSet).forEach((x) => x.classList.toggle('on', x === b));
    $$('.stab', dlgSet).forEach((x) => x.classList.toggle('on', x.dataset.tab === b.dataset.tab));
    if (b.dataset.tab === 'adv') { const box = $('#logBox'); box.textContent = logLines.join('\n'); box.scrollTop = box.scrollHeight; }
  }));
  $$('.eye', dlgSet).forEach((b) => (b.onclick = () => {
    const i = b.previousElementSibling;
    i.type = i.type === 'password' ? 'text' : 'password';
    b.textContent = i.type === 'password' ? 'göster' : 'gizle';
  }));

  function ensureOption(sel, value, label) {
    if (![...sel.options].some((o) => o.value === String(value))) sel.add(new Option(label || String(value), value));
  }

  function fillSettingsForm() {
    for (const el of $$('[data-k]', dlgSet)) {
      const v = getK(S, el.dataset.k);
      if (el.type === 'checkbox') el.checked = !!v;
      else {
        if (el.tagName === 'SELECT') ensureOption(el, v ?? '', v);
        el.value = v ?? '';
      }
    }
    const res = `${S.video.width}x${S.video.height}`;
    ensureOption($('#vRes'), res, res.replace('x', ' × '));
    $('#vRes').value = res;
    updateUploadNote();
  }

  function updateUploadNote() {
    const n = ['youtube', 'kick', 'tiktok'].filter((id) => $(`[data-k="platforms.${id}.enabled"]`, dlgSet).checked).length;
    const br = Number($('[data-k="video.bitrate"]', dlgSet).value) || 0;
    const need = ((br + 160) * n * 1.3) / 1000;
    $('#uploadNote').textContent = n
      ? `${n} platforma aynı anda yayın: internet yükleme hızın en az ~${need.toFixed(1)} Mbps olmalı (speedtest.net “Upload”).`
      : 'Hiçbir platform açık değil. Yayın yapmak için en az birini aç. (Chat için sadece kanal adı yeterli.)';
  }
  dlgSet.addEventListener('input', updateUploadNote);

  $('#btnSettings').onclick = () => { fillSettingsForm(); dlgSet.showModal(); };

  $('#btnDetect').onclick = async () => {
    const b = $('#btnDetect');
    b.disabled = true;
    b.textContent = 'Bakılıyor…';
    try {
      const found = await api.detectEncoders();
      const sel = $('#encSel');
      const cur = sel.value;
      sel.innerHTML = '';
      sel.add(new Option('Otomatik (en iyisi)', 'auto'));
      for (const f of found) sel.add(new Option(f.label, f.id));
      sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'auto';
      toast(found.length ? 'Bulunan kodlayıcılar: ' + found.map((f) => f.label).join(', ') : 'Hiç kodlayıcı bulunamadı. FFmpeg kurulu mu?', found.length ? 'ok' : 'error', 7000);
    } finally {
      b.disabled = false;
      b.textContent = 'Tespit et';
    }
  };

  $('#btnRecDir').onclick = async () => {
    const d = await api.pickFolder();
    if (d) $('[data-k="record.dir"]', dlgSet).value = d;
  };
  $('#btnOvReset').onclick = () => api.overlayReset();

  $('#btnSaveSettings').onclick = async () => {
    const patch = {};
    for (const el of $$('[data-k]', dlgSet)) {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') v = Number(v);
      setK(patch, el.dataset.k, v);
    }
    const [w, h] = $('#vRes').value.split('x').map(Number);
    setK(patch, 'video.width', w);
    setK(patch, 'video.height', h);
    const before = { w: S.video.width, h: S.video.height, fps: S.video.fps, noise: S.sources.micNoise, ov: S.overlay.enabled };
    await save(patch);
    if (before.ov !== S.overlay.enabled) api.overlayToggle();
    if (before.w !== w || before.h !== h || before.fps !== S.video.fps) {
      if (live) toast('Çözünürlük/FPS değişikliği yayın bitince uygulanacak.', 'info', 6000);
      else { comp.setSize(w, h, S.video.fps); captureGame(); }
    }
    if (before.noise !== S.sources.micNoise) captureMic();
    dlgSet.close();
    syncQuick();
    toast('Ayarlar kaydedildi.', 'ok', 1800);
  };

  // ------------------------------------------------------------ başlangıç
  syncQuick();
  setGameUi(S.sources.gameName, '');
  await captureMic();
  await fillDevices();
  syncQuick();
  captureCam();
  await captureDesk();
  syncQuick();
  captureGame();
  pushOverlayState();

  const anyPlatform = ['youtube', 'kick', 'tiktok'].some((id) => S.platforms[id].enabled || S.platforms[id].channel);
  if (!anyPlatform) toast('Hoş geldin! Başlamak için Ayarlar > Platformlar kısmına kanal adlarını ve yayın anahtarlarını gir.', 'info', 12000);
})();
