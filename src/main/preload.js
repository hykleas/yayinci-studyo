const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  getSettings: inv('settings:get'),
  setSettings: inv('settings:set'),
  onSettings: on('settings:changed'),

  listSources: inv('sources:list'),
  prepareCapture: (sourceId, audio) => ipcRenderer.invoke('capture:prepare', { sourceId, audio }),
  detectEncoders: inv('encoders:detect'),

  startStream: inv('stream:start'),
  sendChunk: (buf) => ipcRenderer.send('stream:chunk', buf),
  stopStream: inv('stream:stop'),
  onStreamStatus: on('stream:status'),
  onStreamLog: on('stream:log'),

  chatHistory: inv('chat:history'),
  chatStatus: inv('chat:status'),
  chatReconnect: inv('chat:reconnect'),
  chatTest: inv('chat:test'),
  onChat: on('chat:event'),
  onChatRemove: on('chat:remove'),
  onChatStatus: on('chat:status'),
  onViewers: on('chat:viewers'),

  overlayToggle: inv('overlay:toggle'),
  overlayEdit: inv('overlay:edit'),
  overlayResize: (dw, dh) => ipcRenderer.invoke('overlay:resize', { dw, dh }),
  overlayReset: inv('overlay:reset'),
  overlayState: (st) => ipcRenderer.send('overlay:state', st),
  onOverlayEdit: on('overlay:edit'),
  onOverlayState: on('overlay:state'),

  onHotkey: on('hotkey'),
  mobileInfo: inv('mobile:info'),
  phoneCamInfo: inv('phonecam:info'),
  phoneCamSend: (msg) => ipcRenderer.send('phonecam:send', msg),
  onPhoneCamSignal: on('phonecam:signal'),
  openExternal: inv('open:external'),
  openPath: inv('open:path'),
  pickFolder: inv('dialog:folder')
});
