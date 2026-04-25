const { EventEmitter } = require('events');
const ytdlp = require('yt-dlp-exec');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

class YtDlpEngine extends EventEmitter {
  constructor(downloadUrl, savePath, options = {}) {
    super();
    this.url = downloadUrl;
    this.savePath = savePath;
    this.id = options.id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    this.fileName = options.fileName || 'video';
    
    this.fileSize = 0;
    this.downloadedBytes = 0;
    this.status = 'pending'; // pending, downloading, paused, completed, failed, cancelled
    this.speed = 0;
    this.eta = 0;
    this.progress = 0;
    this.error = null;
    this.mimeType = 'video/*';
    this.supportsRange = true; // yt-dlp auto resumes
    this.formatId = options.formatId || 'bestvideo+bestaudio/best';

    this.subprocess = null;
    
    this._progressInterval = null;
  }

  async getFileInfo() {
    try {
      const info = await ytdlp(this.url, { 
        dumpJson: true, 
        noWarnings: true,
        format: this.formatId,
        ffmpegLocation: ffmpegPath
      });
      this.fileName = `${info.title.replace(/[\\/:*?"<>|]/g, '')}.${info.ext}`;
      
      let totalSize = info.filesize || info.filesize_approx || 0;
      if (!totalSize && info.requested_formats) {
         totalSize = info.requested_formats.reduce((acc, f) => acc + (f.filesize || f.filesize_approx || 0), 0);
      }
      this.fileSize = totalSize;
      
      // If we don't have a savePath or it's a default generic one, update it
      if (!this.savePath || this.savePath.endsWith('download')) {
        const dir = this.savePath ? path.dirname(this.savePath) : require('os').homedir() + '\\Downloads';
        this.savePath = path.join(dir, this.fileName);
      }
      
      return {
        fileSize: this.fileSize,
        supportsRange: true,
        fileName: this.fileName,
        mimeType: this.mimeType,
      };
    } catch (err) {
      throw new Error('Failed to resolve video: ' + err.message.split('\n')[0]);
    }
  }

  async start() {
    if (this.status === 'downloading') return;
    
    try {
      if (this.fileName === 'video' && this.fileSize === 0) {
        await this.getFileInfo();
      }
      
      this.status = 'downloading';
      this.error = null;
      this.emit('start', this.getState());
      
      this._startProgressTimer();
      
      this.subprocess = ytdlp.exec(this.url, {
        output: this.savePath,
        format: this.formatId,
        newline: true, // Output progress on new lines
        noWarnings: true,
        ffmpegLocation: ffmpegPath
      });

      this.subprocess.stdout.on('data', (chunk) => this._parseProgress(chunk.toString()));
      this.subprocess.stderr.on('data', (chunk) => {
        // yt-dlp sometimes writes progress to stderr or warnings
        this._parseProgress(chunk.toString());
      });

      try {
        await this.subprocess;
        if (this.status === 'downloading') {
          this.status = 'completed';
          this.progress = 100;
          this.downloadedBytes = this.fileSize;
          this._stopProgressTimer();
          this.emit('complete', this.getState());
        }
      } catch (err) {
        // If we cancelled or paused it via subprocess.cancel(), don't throw as error
        if (this.status !== 'paused' && this.status !== 'cancelled') {
          this.status = 'failed';
          this.error = err.message.split('\n')[0];
          this._stopProgressTimer();
          this.emit('error', { ...this.getState(), error: this.error });
        }
      }
    } catch (err) {
      if (this.status !== 'paused' && this.status !== 'cancelled') {
        this.status = 'failed';
        this.error = err.message;
        this.emit('error', { ...this.getState(), error: this.error });
      }
    }
  }

  _parseProgress(text) {
    // Example: [download]  15.5% of ~20.00MiB at   5.00MiB/s ETA 00:04
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.includes('[download]')) continue;
      
      // Parse percentage
      const percentMatch = line.match(/([\d.]+)%/);
      if (percentMatch) {
         this.progress = parseFloat(percentMatch[1]);
      }
      
      // Parse speed
      const speedMatch = line.match(/at\s+([\d.]+)(KiB\/s|MiB\/s|GiB\/s|B\/s)/);
      if (speedMatch) {
        let val = parseFloat(speedMatch[1]);
        const unit = speedMatch[2];
        if (unit.includes('KiB')) val *= 1024;
        else if (unit.includes('MiB')) val *= 1024 * 1024;
        else if (unit.includes('GiB')) val *= 1024 * 1024 * 1024;
        this.speed = val;
      }

      // Parse ETA
      const etaMatch = line.match(/ETA\s+([\d:]+)/);
      if (etaMatch) {
        const parts = etaMatch[1].split(':').map(Number);
        if (parts.length === 2) this.eta = parts[0] * 60 + parts[1]; // MM:SS
        else if (parts.length === 3) this.eta = parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
      }

      // Infer downloadedBytes
      if (this.fileSize > 0 && this.progress > 0) {
        this.downloadedBytes = Math.min(this.fileSize, (this.progress / 100) * this.fileSize);
      }
    }
  }

  _startProgressTimer() {
    this._progressInterval = setInterval(() => {
      if (this.status === 'downloading') {
        this.emit('progress', this.getState());
      }
    }, 200);
  }

  _stopProgressTimer() {
    if (this._progressInterval) {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
    }
  }

  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    this._stopProgressTimer();
    if (this.subprocess) {
      this.subprocess.cancel(); // Kills the process natively via execa
      this.subprocess = null;
    }
    this.emit('pause', this.getState());
  }

  async resume() {
    if (this.status !== 'paused' && this.status !== 'failed') return;
    // For yt-dlp, resuming is identical to starting, it detects the .part file and continues
    this.subprocess = null;
    await this.start(); 
  }

  cancel() {
    this.status = 'cancelled';
    this._stopProgressTimer();
    if (this.subprocess) {
      this.subprocess.cancel();
      this.subprocess = null;
    }
    
    // Attempt to manually clean up yt-dlp .part files
    try {
      if (fs.existsSync(this.savePath + '.part')) fs.unlinkSync(this.savePath + '.part');
      if (fs.existsSync(this.savePath + '.ytdl')) fs.unlinkSync(this.savePath + '.ytdl');
    } catch(e) {}

    this.emit('cancel', this.getState());
  }

  getState() {
    return {
      id: this.id,
      url: this.url,
      fileName: this.fileName,
      savePath: this.savePath,
      fileSize: this.fileSize,
      downloadedBytes: this.downloadedBytes,
      progress: this.progress,
      speed: this.speed,
      eta: this.eta,
      status: this.status,
      connections: 1, // yt-dlp usually manages its own connections underneath
      activeConnections: this.status === 'downloading' ? 1 : 0,
      chunks: [], // No explicit UI chunks for streaming sources
      error: this.error,
      mimeType: this.mimeType,
      isStreaming: true,
    };
  }

  getSerializableState() {
    return {
      id: this.id,
      url: this.url,
      savePath: this.savePath,
      fileName: this.fileName,
      fileSize: this.fileSize,
      downloadedBytes: this.downloadedBytes,
      status: this.status,
      connections: 1,
      supportsRange: true,
      mimeType: this.mimeType,
      isStreaming: true,
      progress: this.progress,
    };
  }
}

module.exports = YtDlpEngine;
