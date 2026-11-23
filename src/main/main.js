const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, screen, shell, dialog, net } = require('electron');
const path = require('path');
const settings = require('./settings');
const { StreamEngine, detectEncoders, ffmpegBin, ENCODER_LABEL } = require('./ffmpeg');
const { ChatHub } = require('./chat/hub');
const { MobileServer } = require('./mobile');

// Arka planda / küçültülmüşken de yayın çizimi yavaşlamasın
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) app.quit();

const RENDERER = path.join(__dirname, '../renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const OWN_TITLES = ['Yayıncı Stüdyo', 'Yayıncı Overlay'];

let mainWin = null;
let overlayWin = null;
let overlayEditing = false;
let pendingCapture = [];
let quitting = false;

const engine = new StreamEngine();
const hub = new ChatHub({ fetchJson: fetchJsonBrowser });
const mobile = new MobileServer(hub);

function send(win, ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function broadcast(ch, data) { send(mainWin, ch, data); send(overlayWin, ch, data); }

// ---- Cloudflare arkasındaki JSON'u Chromium ağıyla, olmazsa gizli pencereyle al (Kick) ----
async function fetchJsonBrowser(url) {
  try {
    const r = await net.fetch(url, { headers: { accept: 'application/json' } });
    if (r.ok) return await r.json();
  } catch {}
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(url);
    for (let i = 0; i < 30; i++) {
      const txt = await win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
      try { return JSON.parse(txt); } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('JSON alınamadı');
  } finally { win.destroy(); }
}

// ---------------- Pencereler ----------------
function createMain() {
  mainWin = new BrowserWindow({
    width: 1520, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0d0e12', title: 'Yayıncı Stüdyo', autoHideMenuBar: true, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('page-title-updated', (e) => e.preventDefault());
  mainWin.on('close', (e) => {
    if (quitting || !engine.running) return;
    const r = dialog.showMessageBoxSync(mainWin, {
      type: 'warning', buttons: ['Yayını kapat ve çık', 'Vazgeç'], defaultId: 1, cancelId: 1,
      title: 'Yayın açık', message: 'Yayın hâlâ açık. Kapatıp çıkmak istiyor musun?'
    });
    if (r === 1) { e.preventDefault(); return; }
    quitting = true;
  });
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
}

function overlayDefaults() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { width: 400, height: 560, x: wa.x + wa.width - 420, y: wa.y + 90 };
}

function createOverlay() {
  const s = settings.get().overlay;
  const b = s.bounds || overlayDefaults();
  overlayWin = new BrowserWindow({
    ...b, title: 'Yayıncı Overlay',
    transparent: true, frame: false, resizable: false, movable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Overlay ekran yakalamada görünmesin (yayına iki kere chat düşmesin)
  overlayWin.setContentProtection(true);
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.once('ready-to-show', () => { if (settings.get().overlay.enabled) overlayWin.showInactive(); });
  overlayWin.on('closed', () => { overlayWin = null; });
}

// Tam ekran oyunlar kendini öne alabiliyor; overlay'i düzenli olarak tekrar en üste it
setInterval(() => {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible() && !overlayEditing) {
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.moveTop();
  }
}, 1500);

function setOverlayVisible(v) {
  if (!overlayWin) return;
  if (v) overlayWin.showInactive(); else overlayWin.hide();
  settings.set({ overlay: { enabled: v } });
  broadcast('settings:changed', settings.get());
}

function setOverlayEdit(on) {
  if (!overlayWin) return;
  overlayEditing = on;
  overlayWin.setFocusable(on);
  overlayWin.setIgnoreMouseEvents(!on);
  overlayWin.setMovable(on);
  if (on) { overlayWin.showInactive(); overlayWin.focus(); }
  else {
    settings.set({ overlay: { bounds: overlayWin.getBounds() } });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
  }
  broadcast('overlay:edit', on);
}

// ---------------- Ekran yakalama ----------------
// Renderer önce capture:prepare ile hangi kaynağı istediğini söyler, sonra getDisplayMedia çağırır.
function setupCapture() {
  // Chat emojileri/hediye görselleri canvas'a çizilince canvas "kirlenmesin" (yoksa yayın akışı durur):
  // görsel yanıtlarına CORS izni ekle.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const h = details.responseHeaders || {};
    if (details.resourceType === 'image' && !Object.keys(h).some((k) => k.toLowerCase() === 'access-control-allow-origin')) {
      h['Access-Control-Allow-Origin'] = ['*'];
    }
    cb({ responseHeaders: h });
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const req = pendingCapture.shift() || { sourceId: null, audio: false };
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      let src = sources.find((s) => s.id === req.sourceId);
      if (!src) src = sources.find((s) => s.id.startsWith('screen:'));
      const res = { video: src };
      if (req.audio) res.audio = 'loopback';
      callback(res);
    } catch (e) {
      console.error('[capture]', e);
      callback({});
    }
  });
}

// ---------------- IPC ----------------
function setupIpc() {
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = settings.set(patch);
    hub.configure(s.platforms);
    broadcast('settings:changed', s);
    return s;
  });

  ipcMain.handle('sources:list', async (_e, opts = {}) => {
    const thumbs = opts.thumbs !== false;
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: thumbs ? { width: 320, height: 180 } : { width: 0, height: 0 },
      fetchWindowIcons: thumbs
    });
    return sources
      .filter((s) => !OWN_TITLES.includes(s.name))
      .map((s) => ({
        id: s.id, name: s.name, type: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
      }));
  });

  ipcMain.handle('capture:prepare', (_e, req) => { pendingCapture.push(req); return true; });

  ipcMain.handle('encoders:detect', async () => {
    const list = await detectEncoders(ffmpegBin(settings.get().video.ffmpegPath));
    return list.map((id) => ({ id, label: ENCODER_LABEL[id] }));
  });

  ipcMain.handle('stream:start', async (_e, opts) => {
    try { return await engine.start(settings.get(), opts || {}); }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.on('stream:chunk', (_e, buf) => engine.write(buf));
  ipcMain.handle('stream:stop', () => engine.stop());

  ipcMain.handle('chat:history', () => hub.history.slice(-150));
  ipcMain.handle('chat:status', () => hub.statuses);
  ipcMain.handle('chat:reconnect', () => { hub.configure(settings.get().platforms, true); return true; });
  ipcMain.handle('chat:test', (_e, kind) => { hub.test(kind); return true; });

  ipcMain.handle('overlay:toggle', () => { setOverlayVisible(!(overlayWin && overlayWin.isVisible())); return overlayWin?.isVisible(); });
  ipcMain.handle('overlay:edit', (_e, on) => { setOverlayEdit(on === undefined ? !overlayEditing : !!on); return overlayEditing; });
  ipcMain.handle('overlay:resize', (_e, { dw, dh }) => {
    if (!overlayWin) return;
    const b = overlayWin.getBounds();
    overlayWin.setBounds({ ...b, width: Math.max(220, b.width + (dw || 0)), height: Math.max(160, b.height + (dh || 0)) });
  });
  ipcMain.handle('overlay:reset', () => {
    if (!overlayWin) return;
    overlayWin.setBounds(overlayDefaults());
    settings.set({ overlay: { bounds: overlayWin.getBounds() } });
  });
  // Ana pencereden overlay'e anlık durum (CANLI, mikrofon kapalı, sahne)
  ipcMain.on('overlay:state', (_e, st) => send(overlayWin, 'overlay:state', st));

  ipcMain.handle('mobile:info', async () => {
    const url = mobile.url();
    let qr = '';
    try { qr = await require('qrcode').toDataURL(url, { margin: 1, width: 240 }); } catch {}
    return { url, qr };
  });

  ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('open:path', (_e, p) => shell.openPath(p));
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  engine.on('status', (s) => broadcast('stream:status', s));
  engine.on('log', (l) => send(mainWin, 'stream:log', l));
  hub.on('event', (e) => broadcast('chat:event', e));
  hub.on('remove', (e) => broadcast('chat:remove', e));
  hub.on('status', (s) => broadcast('chat:status', s));
  hub.on('viewers', (v) => broadcast('chat:viewers', v));
}

// ---------------- Kısayollar (oyun tam ekranken de çalışır) ----------------
function setupShortcuts() {
  const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch (e) { console.error('kısayol', acc, e.message); } };
  reg('CommandOrControl+Shift+H', () => setOverlayVisible(!(overlayWin && overlayWin.isVisible())));
  reg('CommandOrControl+Shift+O', () => setOverlayEdit(!overlayEditing));
  reg('CommandOrControl+Shift+1', () => send(mainWin, 'hotkey', { action: 'scene', scene: 'game' }));
  reg('CommandOrControl+Shift+2', () => send(mainWin, 'hotkey', { action: 'scene', scene: 'starting' }));
  reg('CommandOrControl+Shift+3', () => send(mainWin, 'hotkey', { action: 'scene', scene: 'brb' }));
  reg('CommandOrControl+Shift+M', () => send(mainWin, 'hotkey', { action: 'mic' }));
}

app.whenReady().then(() => {
  const s = settings.load();
  setupCapture();
  setupIpc();
  createMain();
  createOverlay();
  setupShortcuts();
  hub.configure(s.platforms);
  if (s.mobile.enabled) mobile.start(Number(s.mobile.port) || 7788);
});

app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

app.on('before-quit', async (e) => {
  quitting = true;
  if (engine.running) {
    e.preventDefault();
    await engine.stop();
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  hub.stopAll();
  mobile.stop();
});
