const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const DownloadManager = require('./src/download-manager');
const DownloadEngine = require('./src/download-engine');

let mainWindow;
let tray;
let downloadManager;
let clipboardWatcher;
let lastClipboardText = '';
let pendingProtocolUrls = [];

function forceFocusWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
  }
}

function handleProtocolUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'turbodm:') {
      const targetUrl = parsed.searchParams.get('url');
      if (targetUrl) {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          mainWindow.webContents.send('clipboard-url', { url: targetUrl, headers: {} });
          forceFocusWindow();
        } else {
          // Window not ready yet — queue for later
          pendingProtocolUrls.push(targetUrl);
        }
      }
    }
  } catch (e) {}
}

// Downloadable URL patterns
const DOWNLOADABLE_EXTENSIONS = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|dmg|pkg|deb|rpm|apk|pdf|doc|docx|xls|xlsx|ppt|pptx|mp4|mkv|avi|mov|wmv|flv|webm|mp3|flac|aac|ogg|wav|wma|jpg|jpeg|png|gif|bmp|svg|webp|tiff|psd|ai|eps|torrent|bin|img|vhd|vmdk)$/i;

const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function isDownloadableUrl(text) {
  if (!URL_PATTERN.test(text)) return false;
  try {
    const parsed = new URL(text);
    const pathname = parsed.pathname;
    
    // Check for streaming URLs (YouTube, Twitter, Twitch, etc)
    const domain = parsed.hostname.replace('www.', '');
    if (['youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'twitch.tv', 'vimeo.com', 'facebook.com', 'instagram.com', 'tiktok.com'].includes(domain)) return true;

    // Check for file extension
    if (DOWNLOADABLE_EXTENSIONS.test(pathname)) return true;
    // Check for common download indicators
    if (parsed.searchParams.has('download')) return true;
    if (pathname.includes('/download')) return true;
    return false;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 800,
    minHeight: 500,
    frame: false,
    transparent: false,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'src', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Flush any protocol URLs that arrived before the window was ready
    if (pendingProtocolUrls.length > 0) {
      pendingProtocolUrls.forEach((url) => {
        mainWindow.webContents.send('clipboard-url', { url: url, headers: {} });
      });
      pendingProtocolUrls = [];
      forceFocusWindow();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Create a simple 16x16 icon
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromBuffer(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAEkSURBVDiNpZMxTsNAEEX/rO0gUVBQIHEAOiQuQMEFuAIHoOMA0HMBJA5AxQWgQkJCQqJAcQqbsNl4Z0yBvY63cjLSlN+a+T/zR7KqxKNx4oLOQQ1ALXCkqlpEHOYvVcuBBwBbAHYB9ADcATgAcAzgTFW1+Cvj7Ql4BmBaQzW4VFMnAJaq+hERy8ATABcArlX1Z/5IRPy7HEMAfwCu7PtuqnpWxNkAoKreOOcOiegFwJ2qXsz/H4LI03k+A3BKRCcAjojoBsAhER0R0TMRnRTxPYBjInoF8AEA7pyLiOgJwKmqjuu20ADYs/8FBl1VPSEAEJ/jqup5H8BxbSxCdwtcqjkBwSoBwJ79FhZ4y2H/NWuoiYKk9g/pF9y/C31/2d/gfwMq+WvxB38KbAAAAABJRU5ErkJggg==', 'base64')
  ) : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show TurboDM',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('TurboDM - Download Manager');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function startClipboardWatcher() {
  lastClipboardText = clipboard.readText();

  clipboardWatcher = setInterval(() => {
    const text = clipboard.readText().trim();
    if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      if (isDownloadableUrl(text)) {
        if (mainWindow) {
          mainWindow.webContents.send('clipboard-url', { url: text, headers: {} });
          forceFocusWindow();
        }
      }
    }
  }, 1000);
}

function setupIPC() {
  ipcMain.handle('add-download', async (_event, url, options = {}) => {
    const settings = downloadManager.getSettings();
    const downloadDir = options.downloadDir || settings.downloadDir;
    return await downloadManager.addDownload(url, {
      ...options,
      downloadDir,
    });
  });

  ipcMain.handle('pause-download', (_event, id) => {
    return downloadManager.pauseDownload(id);
  });

  ipcMain.handle('resume-download', async (_event, id) => {
    return await downloadManager.resumeDownload(id);
  });

  ipcMain.handle('cancel-download', (_event, id) => {
    return downloadManager.cancelDownload(id);
  });

  ipcMain.handle('set-download-mode', async (_event, id, mode) => {
    return await downloadManager.setDownloadMode(id, mode);
  });

  ipcMain.handle('clear-completed', () => {
    return downloadManager.clearCompleted();
  });

  ipcMain.handle('get-all-downloads', () => {
    return downloadManager.getAllDownloads();
  });

  ipcMain.handle('get-file-info', async (_event, url, formatId, headers) => {
    let isStreaming = false;
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace('www.', '');
      isStreaming = ['youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'twitch.tv', 'vimeo.com', 'facebook.com', 'instagram.com', 'tiktok.com'].includes(domain);
    } catch {}

    const EngineClass = isStreaming ? require('./src/ytdlp-engine') : require('./src/download-engine');
    const engine = new EngineClass(url, '', { formatId, headers });
    try {
      const info = await engine.getFileInfo();
      info.isStreaming = isStreaming;
      return info;
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('get-settings', () => {
    return downloadManager.getSettings();
  });

  ipcMain.handle('update-settings', (_event, settings) => {
    downloadManager.updateSettings(settings);
    return downloadManager.getSettings();
  });

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('open-file', async (_event, filePath) => {
    return await shell.openPath(filePath);
  });

  ipcMain.handle('open-folder', async (_event, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  // Window controls
  ipcMain.on('minimize-window', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('close-window', () => {
    if (mainWindow) mainWindow.hide();
  });

  // Forward download events to renderer
  downloadManager.on('download-update', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-update', state);
    }
  });
}

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('turbodm', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('turbodm');
}

// Force Windows/Browsers to use the exact name "TurboDM" in permission dialogs
if (process.platform === 'win32') {
  const { exec } = require('child_process');
  exec('REG ADD "HKCU\\Software\\Classes\\turbodm\\Application" /v "ApplicationName" /t REG_SZ /d "TurboDM" /f', (err) => {
    if (err) console.error('Failed to set ApplicationName registry key:', err);
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    forceFocusWindow();
    const urlArg = commandLine.find(arg => arg.startsWith('turbodm://'));
    if (urlArg) handleProtocolUrl(urlArg);
  });

  app.whenReady().then(() => {
    downloadManager = new DownloadManager();

    const Store = require('./src/store');
    const store = new Store();
    const savedSettings = store.get('settings', {});
    if (savedSettings.downloadDir) downloadManager.defaultDownloadDir = savedSettings.downloadDir;
    if (savedSettings.maxConcurrent) downloadManager.maxConcurrent = savedSettings.maxConcurrent;
    if (savedSettings.defaultConnections) downloadManager.defaultConnections = savedSettings.defaultConnections;

    // Check for protocol URL in initial launch args (cold-start)
    const protocolArg = process.argv.find(arg => arg.startsWith('turbodm://'));
    if (protocolArg) handleProtocolUrl(protocolArg);

    createWindow();
    createTray();
    startClipboardWatcher();
    setupIPC();
    createLocalServer();
  });
}

function createLocalServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/download') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (data.url) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));

            // Auto-start the download immediately using headers from the browser.
            // This is critical for short-lived pre-signed URLs (Claude, Gemini, ChatGPT)
            // which expire within seconds — we cannot wait for the user to click through the toast.
            try {
              const settings = downloadManager.getSettings();
              const result = await downloadManager.addDownload(data.url, {
                downloadDir: settings.downloadDir,
                headers: data.headers || {},
              });
              // Notify UI that download has been queued automatically
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-update', result);
                mainWindow.webContents.send('extension-download-started', {
                  url: data.url,
                  fileName: result.fileName || data.url,
                });
              }
            } catch (e) {
              // If auto-start fails (e.g. 404, network error), fall back to manual toast
              // so the user has a chance to review and try manually.
              console.error('[TurboDM] Auto-start failed, falling back to toast:', e.message);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('clipboard-url', { url: data.url, headers: data.headers || {} });
                forceFocusWindow();
              }
            }
            return;
          }
        } catch (e) {}
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid payload expected {"url": "..."}' }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on('error', (err) => {
    console.error('Local server failed to start:', err);
  });

  server.listen(10101, '127.0.0.1');
}

app.on('window-all-closed', () => {
  // Don't quit on window close (stays in tray)
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  if (downloadManager) downloadManager.destroy();
});
