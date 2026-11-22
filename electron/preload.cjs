const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  status: () => ipcRenderer.invoke('vlc:status'),
  startVlc: () => ipcRenderer.invoke('vlc:start'),
  chooseMovie: () => ipcRenderer.invoke('vlc:pick-media'),
  control: (action, seconds) => ipcRenderer.invoke('vlc:control', { action, seconds }),
  readPlayback: () => ipcRenderer.invoke('vlc:read'),
  onBeforeClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:before-close', listener);
    return () => ipcRenderer.removeListener('app:before-close', listener);
  },
  closeCleanupDone: () => ipcRenderer.send('app:close-cleanup-done'),
  configureOverlay: (config) => ipcRenderer.send('overlay:config', config),
  showPlaybackOverlay: (payload) => ipcRenderer.send('overlay:show', payload),
});
