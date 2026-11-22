const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onShow: (callback) => ipcRenderer.on('overlay:show', (_event, payload) => callback(payload)),
  resize: (height) => ipcRenderer.send('overlay:resize', height),
  hide: () => ipcRenderer.send('overlay:hide'),
});
