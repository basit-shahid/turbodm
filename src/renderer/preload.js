const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tdm', {
  // Download actions
  addDownload: (url, options) => ipcRenderer.invoke('add-download', url, options),
  pauseDownload: (id) => ipcRenderer.invoke('pause-download', id),
  resumeDownload: (id) => ipcRenderer.invoke('resume-download', id),
  cancelDownload: (id) => ipcRenderer.invoke('cancel-download', id),
  setDownloadMode: (id, mode) => ipcRenderer.invoke('set-download-mode', id, mode),
  clearCompleted: () => ipcRenderer.invoke('clear-completed'),
  getAllDownloads: () => ipcRenderer.invoke('get-all-downloads'),

  // File info
  getFileInfo: (url, formatId) => ipcRenderer.invoke('get-file-info', url, formatId),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // Events from main
  onDownloadUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-update', handler);
    return () => ipcRenderer.removeListener('download-update', handler);
  },

  onClipboardUrl: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('clipboard-url', handler);
    return () => ipcRenderer.removeListener('clipboard-url', handler);
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),

  // Utility
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  openFolder: (filePath) => ipcRenderer.invoke('open-folder', filePath),
  formatBytes: (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },
  formatTime: (seconds) => {
    if (!seconds || seconds === Infinity) return '--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  },
});
