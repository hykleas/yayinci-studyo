// Oyun üstü chat (sadece yayıncı görür; ekran yakalamaya girmez)
(async function () {
  const api = window.api;
  const list = document.getElementById('list');
  let cfg = (await api.getSettings()).overlay;
  let state = { live: false, startedAt: 0, micMuted: false, scene: 'game' };

  function applyCfg() {
    document.documentElement.style.setProperty('--fs', (cfg.fontSize || 17) + 'px');
    document.documentElement.style.setProperty('--bg', String(cfg.opacity ?? 0.55));
  }
  applyCfg();
  api.onSettings((s) => { cfg = s.overlay; applyCfg(); trim(); });

  function trim() {
    const max = Number(cfg.max) || 14;
    while (list.children.length > max) list.firstChild.remove();
  }

  function add(evt, animate = true) {
    const el = window.ChatRender.renderEvent(evt);
    if (!animate) el.style.animation = 'none';
    list.appendChild(el);
    trim();
    const fade = Number(cfg.fade) || 0;
    if (fade > 0) {
      // hediyeler biraz daha uzun kalsın
      const ms = (evt.type === 'chat' ? fade : fade * 2) * 1000;
      setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 900); }, ms);
    }
  }

  for (const e of (await api.chatHistory()).slice(-6)) add(e, false);
  api.onChat((e) => add(e));
  api.onChatRemove(({ id, raw }) => {
    for (const el of [...list.children]) if (el.dataset.id === id || el.dataset.id === raw) el.remove();
  });

  // durum çubuğu
  const pad = (n) => String(n).padStart(2, '0');
  const SCENE = { starting: 'BAŞLIYORUZ SAHNESİ AÇIK', brb: 'MOLA SAHNESİ AÇIK' };
  function renderBar() {
    document.getElementById('liveDot').classList.toggle('on', !!state.live);
    let txt = 'ÇEVRİMDIŞI';
    if (state.live) {
      const t = Math.floor((Date.now() - state.startedAt) / 1000);
      txt = `CANLI ${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
    }
    document.getElementById('liveText').textContent = txt;
    document.getElementById('micWarn').hidden = !state.micMuted;
    const sw = document.getElementById('sceneWarn');
    sw.hidden = !SCENE[state.scene];
    sw.textContent = SCENE[state.scene] || '';
  }
  api.onOverlayState((s) => { state = s; renderBar(); });
  setInterval(renderBar, 1000);
  renderBar();

  // düzenleme modu
  api.onOverlayEdit((on) => document.body.classList.toggle('editing', on));
  for (const b of document.querySelectorAll('[data-r]')) {
    b.onclick = () => { const [dw, dh] = b.dataset.r.split(',').map(Number); api.overlayResize(dw, dh); };
  }
  document.getElementById('done').onclick = () => api.overlayEdit(false);
})();
