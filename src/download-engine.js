const { EventEmitter } = require('events');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const url = require('url');

class DownloadEngine extends EventEmitter {
  constructor(downloadUrl, savePath, options = {}) {
    super();
    this.url = downloadUrl;
    this.savePath = savePath;
    this.connections = options.connections || 16;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 2000;

    this.id = options.id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    // Extract filename from URL, properly decode %20 etc.
    let urlFileName = '';
    try {
      const urlPath = new URL(downloadUrl).pathname;
      urlFileName = decodeURIComponent(path.basename(urlPath));
    } catch(e) {}
    this.fileName = options.fileName || urlFileName || 'download';
    this.fileSize = 0;
    this.downloadedBytes = 0;
    this.supportsRange = false;
    this.status = 'pending'; // pending, downloading, paused, completed, failed, cancelled
    this.speed = 0;
    this.eta = 0;
    this.chunks = [];
    this.activeRequests = [];
    this.tempDir = '';
    this.startTime = 0;
    this.lastSpeedCalcTime = 0;
    this.lastSpeedCalcBytes = 0;
    this.speedHistory = [];
    this.error = null;
    this.mimeType = '';
    this.redirectedUrl = null;
  }

  async getFileInfo() {
    return new Promise((resolve, reject) => {
      const makeRequest = (requestUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const parsedUrl = new URL(requestUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'HEAD',
          headers: {
            'User-Agent': 'TurboDM/1.0',
          },
          timeout: 15000,
        };

        const req = client.request(reqOptions, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, requestUrl).href;
            this.redirectedUrl = redirectUrl;
            makeRequest(redirectUrl, redirectCount + 1);
            return;
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }

          const contentLength = parseInt(res.headers['content-length'], 10);
          const acceptRanges = res.headers['accept-ranges'];
          this.mimeType = res.headers['content-type'] || '';

          this.fileSize = isNaN(contentLength) ? 0 : contentLength;
          this.supportsRange = acceptRanges === 'bytes' && this.fileSize > 0;

          // 1. Always prefer Content-Disposition header (server's explicit filename)
          const disposition = res.headers['content-disposition'];
          if (disposition) {
            const match = disposition.match(/filename\*?=['"]?(?:UTF-8'')?([^;'"\n]*)/i);
            if (match) {
              this.fileName = decodeURIComponent(match[1].replace(/['"]/g, '').trim());
            }
          }

          // 2. If redirected, try extracting a better filename from the final URL
          if ((!this.fileName || this.fileName === 'download') && this.redirectedUrl) {
            try {
              const rPath = new URL(this.redirectedUrl).pathname;
              const rName = decodeURIComponent(path.basename(rPath));
              if (rName && rName !== '/' && rName.includes('.')) {
                this.fileName = rName;
              }
            } catch(e) {}
          }
          
          // 3. ONLY use mime-types when filename has absolutely no extension
          if (this.fileName && !this.fileName.includes('.') && this.mimeType) {
             const ext = mime.extension(this.mimeType.split(';')[0].trim());
             if (ext) {
               this.fileName = `${this.fileName}.${ext}`;
             }
          }

          resolve({
            fileSize: this.fileSize,
            supportsRange: this.supportsRange,
            fileName: this.fileName,
            mimeType: this.mimeType,
          });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Connection timed out'));
        });
        req.end();
      };

      makeRequest(this.url);
    });
  }

  async start(existingChunks = null) {
    try {
      if (!existingChunks) {
        await this.getFileInfo();
      }

      this.status = 'downloading';
      this.startTime = Date.now();
      this.lastSpeedCalcTime = Date.now();
      this.lastSpeedCalcBytes = 0;

      this.tempDir = path.join(path.dirname(this.savePath), '.tdm_temp', this.id);
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }

      if (existingChunks) {
        this.chunks = existingChunks;
        this.downloadedBytes = this.chunks.reduce((sum, c) => sum + c.downloaded, 0);
      } else if (this.supportsRange && this.fileSize > 0) {
        this.chunks = this._createChunks();
      } else {
        this.chunks = [{
          index: 0,
          start: 0,
          end: this.fileSize || Infinity,
          downloaded: 0,
          status: 'pending',
          tempFile: path.join(this.tempDir, 'chunk_0'),
        }];
        this.connections = 1;
      }

      this.emit('start', this.getState());
      this._startSpeedCalculation();
      await this._downloadAllChunks();

      if (this.status === 'downloading') {
        await this._mergeChunks();
        this.status = 'completed';
        this._stopSpeedCalculation();
        this.emit('complete', this.getState());
        this._cleanup();
      }
    } catch (err) {
      if (this.status !== 'paused' && this.status !== 'cancelled') {
        this.status = 'failed';
        this.error = err.message;
        this._stopSpeedCalculation();
        this.emit('error', { ...this.getState(), error: err.message });
      }
    }
  }

  _createChunks() {
    const chunkSize = Math.ceil(this.fileSize / this.connections);
    const chunks = [];
    for (let i = 0; i < this.connections; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, this.fileSize - 1);
      if (start > this.fileSize - 1) break;
      chunks.push({
        index: i,
        start,
        end,
        downloaded: 0,
        status: 'pending',
        tempFile: path.join(this.tempDir, `chunk_${i}`),
      });
    }
    return chunks;
  }

  _calculateDownloadedBytes() {
    return this.chunks.reduce((sum, c) => sum + c.downloaded, 0);
  }

  async _downloadAllChunks() {
    const promises = this.chunks
      .filter(c => c.status !== 'completed')
      .map(chunk => this._downloadChunk(chunk));
    await Promise.all(promises);
  }

  _downloadChunk(chunk, attempt = 0) {
    return new Promise((resolve, reject) => {
      if (this.status === 'paused' || this.status === 'cancelled') {
        resolve();
        return;
      }

      chunk.status = 'downloading';
      const downloadUrl = this.redirectedUrl || this.url;
      const parsedUrl = new URL(downloadUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const headers = { 'User-Agent': 'TurboDM/1.0' };

      if (this.supportsRange) {
        const startByte = chunk.start + chunk.downloaded;
        headers['Range'] = `bytes=${startByte}-${chunk.end}`;
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        timeout: 30000,
      };

      const req = client.request(reqOptions, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          this.redirectedUrl = new URL(res.headers.location, downloadUrl).href;
          this._downloadChunk(chunk, attempt).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode >= 400) {
          if (attempt < this.retryAttempts) {
            // Reset progress for this chunk if server doesn't support resuming
            if (!this.supportsRange) {
               chunk.downloaded = 0;
            }
            setTimeout(() => {
              this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
            }, this.retryDelay * (attempt + 1));
            return;
          }
          reject(new Error(`HTTP ${res.statusCode} for chunk ${chunk.index}`));
          return;
        }

        const flags = chunk.downloaded > 0 ? 'a' : 'w';
        const writeStream = fs.createWriteStream(chunk.tempFile, { flags });

        res.on('data', (data) => {
          if (this.status === 'paused' || this.status === 'cancelled') {
            res.destroy();
            writeStream.end();
            return;
          }
          writeStream.write(data);
          chunk.downloaded += data.length;
        });

        res.on('end', () => {
          writeStream.end(() => {
            if (this.status !== 'paused' && this.status !== 'cancelled') {
              chunk.status = 'completed';
            }
            resolve();
          });
        });

        res.on('error', (err) => {
          writeStream.end();
          if (attempt < this.retryAttempts && this.status === 'downloading') {
            setTimeout(() => {
              this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
            }, this.retryDelay * (attempt + 1));
          } else {
            chunk.status = 'failed';
            reject(err);
          }
        });

        this.activeRequests.push({ req, res, writeStream, chunk });
      });

      req.on('error', (err) => {
        if (attempt < this.retryAttempts && this.status === 'downloading') {
          setTimeout(() => {
            this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
          }, this.retryDelay * (attempt + 1));
        } else {
          chunk.status = 'failed';
          reject(err);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (attempt < this.retryAttempts && this.status === 'downloading') {
          setTimeout(() => {
            this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
          }, this.retryDelay * (attempt + 1));
        } else {
          chunk.status = 'failed';
          reject(new Error('Connection timed out'));
        }
      });

      req.end();
    });
  }

  async _mergeChunks() {
    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(this.savePath);

      const mergeNext = (index) => {
        if (index >= this.chunks.length) {
          writeStream.end(resolve);
          return;
        }

        const chunk = this.chunks[index];
        if (!fs.existsSync(chunk.tempFile)) {
          mergeNext(index + 1);
          return;
        }

        const readStream = fs.createReadStream(chunk.tempFile);
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', () => mergeNext(index + 1));
        readStream.on('error', reject);
      };

      mergeNext(0);
    });
  }

  pause() {
    if (this.status !== 'downloading') return;
    this.status = 'paused';
    this._stopSpeedCalculation();
    this.activeRequests.forEach(({ req, res, writeStream }) => {
      try {
        if (res) res.destroy();
        if (req) req.destroy();
        if (writeStream) writeStream.end();
      } catch (e) { /* ignore cleanup errors */ }
    });
    this.activeRequests = [];
    this.emit('pause', this.getState());
  }

  async resume() {
    if (this.status !== 'paused' && this.status !== 'failed') return;
    this.status = 'downloading';
    this.activeRequests = [];
    this.startTime = Date.now();
    this.lastSpeedCalcTime = Date.now();
    this.lastSpeedCalcBytes = this.downloadedBytes;
    this._startSpeedCalculation();

    try {
      await this._downloadAllChunks();
      if (this.status === 'downloading') {
        await this._mergeChunks();
        this.status = 'completed';
        this._stopSpeedCalculation();
        this.emit('complete', this.getState());
        this._cleanup();
      }
    } catch (err) {
      if (this.status !== 'paused' && this.status !== 'cancelled') {
        this.status = 'failed';
        this.error = err.message;
        this._stopSpeedCalculation();
        this.emit('error', { ...this.getState(), error: err.message });
      }
    }
  }

  cancel() {
    this.status = 'cancelled';
    this._stopSpeedCalculation();
    this.activeRequests.forEach(({ req, res, writeStream }) => {
      try {
        if (res) res.destroy();
        if (req) req.destroy();
        if (writeStream) writeStream.end();
      } catch (e) { /* ignore */ }
    });
    this.activeRequests = [];
    this._cleanup();
    this.emit('cancel', this.getState());
  }

  _startSpeedCalculation() {
    this._speedInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - this.lastSpeedCalcTime) / 1000;
      if (elapsed > 0) {
        const currentBytes = this._calculateDownloadedBytes();
        const bytesDiff = currentBytes - this.lastSpeedCalcBytes;
        const currentSpeed = Math.max(0, bytesDiff / elapsed);
        this.speedHistory.push(currentSpeed);
        if (this.speedHistory.length > 5) this.speedHistory.shift();
        this.speed = this.speedHistory.reduce((a, b) => a + b, 0) / this.speedHistory.length;

        if (this.speed > 0 && this.fileSize > 0) {
          this.eta = Math.ceil((this.fileSize - currentBytes) / this.speed);
        } else {
          this.eta = 0;
        }

        this.lastSpeedCalcTime = now;
        this.lastSpeedCalcBytes = currentBytes;
      }
    }, 500);

    this._progressInterval = setInterval(() => {
      if (this.status === 'downloading') {
        this.emit('progress', this.getState());
      }
    }, 200); // 5 FPS UI update rate is smooth and efficient
  }

  _stopSpeedCalculation() {
    if (this._speedInterval) {
      clearInterval(this._speedInterval);
      this._speedInterval = null;
    }
    if (this._progressInterval) {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
    }
  }

  _cleanup() {
    try {
      if (this.tempDir && fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (e) { /* ignore */ }
  }

  getState() {
    const currentBytes = this._calculateDownloadedBytes();
    const progress = this.fileSize > 0 ? (currentBytes / this.fileSize) * 100 : 0;
    return {
      id: this.id,
      url: this.url,
      fileName: this.fileName,
      savePath: this.savePath,
      fileSize: this.fileSize,
      downloadedBytes: currentBytes,
      progress: Math.min(progress, 100),
      speed: this.speed,
      eta: this.eta,
      status: this.status,
      connections: this.connections,
      activeConnections: this.chunks.filter(c => c.status === 'downloading').length,
      chunks: this.chunks.map(c => ({
        index: c.index,
        start: c.start,
        end: c.end,
        downloaded: c.downloaded,
        size: c.end - c.start + 1,
        status: c.status,
        progress: (c.end - c.start + 1) > 0 ? (c.downloaded / (c.end - c.start + 1)) * 100 : 0,
      })),
      error: this.error,
      mimeType: this.mimeType,
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
      connections: this.connections,
      supportsRange: this.supportsRange,
      mimeType: this.mimeType,
      redirectedUrl: this.redirectedUrl,
      chunks: this.chunks.map(c => ({
        index: c.index,
        start: c.start,
        end: c.end,
        downloaded: c.downloaded,
        status: c.status,
        tempFile: c.tempFile,
      })),
    };
  }
}

module.exports = DownloadEngine;
