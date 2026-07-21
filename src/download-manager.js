const { EventEmitter } = require('events');
const DownloadEngine = require('./download-engine');
const YtDlpEngine = require('./ytdlp-engine');
const Store = require('./store');
const path = require('path');

const CATEGORY_EXTENSION_MAP = {
  compressed: new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'tbz2', 'txz', 'cab', 'lz', 'lzma', 'zst']),
  video: new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp', '3g2', 'ogv', 'f4v', 'm2ts']),
  music: new Set(['mp3', 'flac', 'aac', 'ogg', 'wav', 'wma', 'm4a', 'opus', 'alac', 'aif', 'aiff', 'mid', 'midi']),
  pictures: new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'psd', 'ai', 'eps', 'heic', 'heif', 'raw', 'ico']),
  documents: new Set(['pdf', 'doc', 'docx', 'docm', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'pptm', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'tsv', 'md', 'markdown', 'epub', 'mobi', 'azw', 'azw3', 'html', 'htm', 'xml', 'json', 'yaml', 'yml', 'log']),
  program: new Set(['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'bin', 'appimage', 'jar', 'bat', 'sh', 'cmd', 'ps1', 'ipa', 'xpi', 'crx']),
};

function getDownloadCategory(fileName) {
  const normalizedName = (fileName || '').toLowerCase();

  if (normalizedName.endsWith('.tar.gz') || normalizedName.endsWith('.tar.bz2') || normalizedName.endsWith('.tar.xz')) {
    return 'compressed';
  }

  const extension = path.extname(normalizedName).slice(1);
  if (!extension) return 'others';

  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSION_MAP)) {
    if (extensions.has(extension)) {
      return category;
    }
  }

  return 'others';
}

function buildDownloadSavePath(downloadDir, fileName) {
  const category = getDownloadCategory(fileName);
  return path.join(downloadDir, category, fileName);
}

class DownloadManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.store = new Store();
    this.maxConcurrent = options.maxConcurrent || 5;
    this.defaultConnections = options.defaultConnections || 64;
    this.defaultDownloadDir = options.downloadDir || path.join(require('os').homedir(), 'Downloads');
    this.downloads = new Map();
    this.queue = [];

    this._loadSavedState();
  }

  _loadSavedState() {
    const savedDownloads = this.store.get('downloads', []);
    savedDownloads.forEach(d => {
      if (d.status === 'completed' || d.status === 'cancelled') {
        this.downloads.set(d.id, { engine: null, state: d });
      } else {
        const EngineClass = d.isStreaming ? YtDlpEngine : DownloadEngine;
        const engine = new EngineClass(d.url, d.savePath, {
          connections: d.connections,
          fileName: d.fileName,
          id: d.id,
          modePreference: d.modePreference,
          headers: d.headers,
        });
        
        engine.fileSize = d.fileSize;
        engine.downloadedBytes = d.downloadedBytes;
        engine.supportsRange = d.supportsRange;
        engine.mimeType = d.mimeType;
        engine.redirectedUrl = d.redirectedUrl;
        engine.connectionMode = d.connectionMode || (d.supportsRange ? 'parallel' : 'single');
        engine.transportNotice = d.transportNotice || '';
        engine.modePreference = d.modePreference || 'auto';
        engine.status = (d.status === 'downloading' || d.status === 'pending') ? 'paused' : d.status;
        engine.chunks = d.chunks || [];
        
        this._bindEngineEvents(engine);
        this.downloads.set(d.id, { engine, state: null });
      }
    });
  }

  _saveState() {
    const states = [];
    this.downloads.forEach((entry) => {
      if (entry.engine) {
        states.push(entry.engine.getSerializableState());
      } else if (entry.state) {
        states.push(entry.state);
      }
    });
    this.store.set('downloads', states);
  }

  _getActiveCount() {
    let count = 0;
    this.downloads.forEach(entry => {
      if (entry.engine && entry.engine.status === 'downloading') count++;
    });
    return count;
  }

  _processQueue() {
    while (this._getActiveCount() < this.maxConcurrent && this.queue.length > 0) {
      const downloadId = this.queue.shift();
      const entry = this.downloads.get(downloadId);
      if (entry && entry.engine && entry.engine.status === 'pending') {
        this._startEngine(entry.engine);
      }
    }
  }

  _startEngine(engine) {
    engine.start();
  }

  _bindEngineEvents(engine) {
    const events = ['start', 'progress', 'complete', 'error', 'pause', 'cancel'];
    events.forEach(event => {
      engine.on(event, (state) => {
        this.emit('download-update', state);
        if (event === 'complete' || event === 'error' || event === 'cancel') {
          this._saveState();
          this._processQueue();
        }
        if (event === 'progress') {
          // Throttle state saves
          if (!this._saveThrottle) {
            this._saveThrottle = setTimeout(() => {
              this._saveState();
              this._saveThrottle = null;
            }, 5000);
          }
        }
      });
    });
  }

  _isStreamingUrl(urlStr) {
    try {
      const parsed = new URL(urlStr);
      const domain = parsed.hostname.replace('www.', '');
      const streamingDomains = ['youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'twitch.tv', 'vimeo.com', 'facebook.com', 'instagram.com', 'tiktok.com'];
      return streamingDomains.includes(domain);
    } catch { return false; }
  }

  async addDownload(url, options = {}) {
    const baseDownloadDir = options.downloadDir || this.defaultDownloadDir;
    const requestedFileName = options.fileName || 'download';
    let savePath = options.savePath || buildDownloadSavePath(baseDownloadDir, requestedFileName);

    const isStreaming = this._isStreamingUrl(url);
    const EngineClass = isStreaming ? YtDlpEngine : DownloadEngine;

    const engine = new EngineClass(url, savePath, {
      connections: options.connections || this.defaultConnections,
      fileName: options.fileName,
      id: options.id,
      formatId: options.formatId,
      modePreference: options.modePreference || 'auto',
      headers: options.headers,
    });

    // Get file info first
    try {
      const info = await engine.getFileInfo();
      // Use engine's updated savePath and fileName (which might have extensions now)
      engine.fileName = engine.fileName || info.fileName;
      engine.savePath = engine.savePath; // Sync if engine modified it internally (like YtDlpEngine does)

      const finalFileName = path.basename(engine.fileName || engine.savePath || requestedFileName);
      savePath = buildDownloadSavePath(baseDownloadDir, finalFileName);
      engine.savePath = savePath;
    } catch (err) {
      return { error: err.message };
    }

    this._bindEngineEvents(engine);
    this.downloads.set(engine.id, { engine, state: null });

    if (this._getActiveCount() < this.maxConcurrent) {
      this._startEngine(engine);
    } else {
      this.queue.push(engine.id);
    }

    this._saveState();
    return engine.getState();
  }

  pauseDownload(id) {
    const entry = this.downloads.get(id);
    if (entry && entry.engine) {
      entry.engine.pause();
      this._saveState();
      return entry.engine.getState();
    }
    return null;
  }

  async resumeDownload(id) {
    const entry = this.downloads.get(id);
    if (entry && entry.engine) {
      entry.engine.resume();
      return entry.engine.getState();
    }
    return null;
  }

  cancelDownload(id) {
    const entry = this.downloads.get(id);
    if (entry && entry.engine) {
      entry.engine.cancel();
      this.downloads.delete(id);
      this._saveState();
      return true;
    }
    // Remove from completed list too
    if (entry) {
      this.downloads.delete(id);
      this._saveState();
      return true;
    }
    return false;
  }

  async setDownloadMode(id, mode) {
    const entry = this.downloads.get(id);
    if (!entry || !entry.engine) {
      return { error: 'Download not found' };
    }

    if (entry.engine instanceof YtDlpEngine) {
      return { error: 'Mode switching is not supported for streaming downloads.' };
    }

    if (typeof entry.engine.setMode !== 'function') {
      return { error: 'Mode switching is unavailable for this download.' };
    }

    try {
      const state = await entry.engine.setMode(mode);
      this._saveState();
      return state;
    } catch (err) {
      return { error: err.message || 'Failed to switch download mode.' };
    }
  }

  clearCompleted() {
    const toRemove = [];
    this.downloads.forEach((entry, id) => {
      const status = entry.engine ? entry.engine.status : (entry.state ? entry.state.status : null);
      if (status === 'completed' || status === 'cancelled') {
        toRemove.push(id);
      }
    });
    toRemove.forEach(id => this.downloads.delete(id));
    this._saveState();
    return toRemove.length;
  }

  getAllDownloads() {
    const downloads = [];
    this.downloads.forEach((entry) => {
      if (entry.engine) {
        downloads.push(entry.engine.getState());
      } else if (entry.state) {
        downloads.push(entry.state);
      }
    });
    return downloads;
  }

  getSettings() {
    return {
      downloadDir: this.defaultDownloadDir,
      maxConcurrent: this.maxConcurrent,
      defaultConnections: this.defaultConnections,
    };
  }

  updateSettings(settings) {
    if (settings.downloadDir) this.defaultDownloadDir = settings.downloadDir;
    if (settings.maxConcurrent) this.maxConcurrent = settings.maxConcurrent;
    if (settings.defaultConnections) this.defaultConnections = settings.defaultConnections;

    this.store.set('settings', {
      downloadDir: this.defaultDownloadDir,
      maxConcurrent: this.maxConcurrent,
      defaultConnections: this.defaultConnections,
    });
  }

  destroy() {
    this._saveState();
    this.downloads.forEach(entry => {
      if (entry.engine && entry.engine.status === 'downloading') {
        entry.engine.pause();
      }
    });
  }
}

module.exports = DownloadManager;
