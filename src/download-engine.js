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
    this.minChunkSize = options.minChunkSize || (1 * 1024 * 1024); // 1 MB per chunk minimum
    this.rangeProbeTimeout = options.rangeProbeTimeout || 10000;
    this.modePreference = options.modePreference || 'auto'; // auto, parallel, single

    this.id = options.id || Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    this.headers = options.headers || {};
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
    this.transportNotice = '';
    this.connectionMode = 'single';
    this.httpAgent = null;
    this.httpsAgent = null;
  }

  _getAgent(protocol) {
    const maxSockets = Math.max(4, this.connections || 4);

    if (protocol === 'https:') {
      if (!this.httpsAgent) {
        this.httpsAgent = new https.Agent({
          keepAlive: true,
          maxSockets,
          maxFreeSockets: 2,
          keepAliveMsecs: 1000,
        });
      } else {
        this.httpsAgent.maxSockets = maxSockets;
      }

      return this.httpsAgent;
    }

    if (!this.httpAgent) {
      this.httpAgent = new http.Agent({
        keepAlive: true,
        maxSockets,
        maxFreeSockets: 2,
        keepAliveMsecs: 1000,
      });
    } else {
      this.httpAgent.maxSockets = maxSockets;
    }

    return this.httpAgent;
  }

  _getDefaultHeaders(useBrowserUA = false) {
    const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
    const customUA = this.headers && this.headers['User-Agent'];
    const userAgent = (useBrowserUA || customUA) ? (customUA || BROWSER_UA) : 'TurboDM/1.0';

    // Derive Origin from Referer if not explicitly set
    let origin = this.headers && this.headers['Origin'];
    if (!origin && this.headers && this.headers['Referer']) {
      try {
        const r = new URL(this.headers['Referer']);
        origin = r.origin;
      } catch {}
    }

    const base = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    };

    if (origin) base['Origin'] = origin;

    // Custom headers from browser go last so they take full precedence
    return { ...base, ...this.headers, 'User-Agent': userAgent };
  }

  _destroyAgents() {
    if (this.httpAgent) {
      this.httpAgent.destroy();
      this.httpAgent = null;
    }

    if (this.httpsAgent) {
      this.httpsAgent.destroy();
      this.httpsAgent = null;
    }
  }

  _setTransportNotice(message) {
    this.transportNotice = message || '';
  }

  _normalizeMode(mode) {
    if (mode === 'series') return 'single';
    if (mode === 'parallel' || mode === 'single' || mode === 'auto') return mode;
    return 'auto';
  }

  async getFileInfo() {
    return new Promise((resolve, reject) => {
      const makeRequest = (requestUrl, redirectCount = 0, overrideMethod = 'HEAD') => {
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
          method: overrideMethod,
          headers: this._getDefaultHeaders(),
          agent: this._getAgent(parsedUrl.protocol),
          timeout: this.rangeProbeTimeout,
        };
        
        if (overrideMethod === 'GET') {
          reqOptions.headers['Range'] = 'bytes=0-0';
        }

        const req = client.request(reqOptions, async (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, requestUrl).href;
            this.redirectedUrl = redirectUrl;
            makeRequest(redirectUrl, redirectCount + 1, overrideMethod);
            return;
          }

          if ([403, 405, 501].includes(res.statusCode) && overrideMethod === 'HEAD' && redirectCount === 0) {
            // HEAD is not allowed on this URL — try GET with a tiny range instead.
            res.destroy();
            makeRequest(requestUrl, redirectCount, 'GET');
            return;
          }

          // 403 on GET with no cookies: upgrade to full browser headers (with cookies/UA) and retry once.
          if (res.statusCode === 403 && overrideMethod === 'GET' && redirectCount === 0) {
            res.destroy();
            // Build a fresh options object with full browser headers so we do not mutate the closed request's options.
            const retryOptions = {
              hostname: parsedUrl.hostname,
              port: parsedUrl.port,
              path: parsedUrl.pathname + parsedUrl.search,
              method: 'GET',
              headers: { ...this._getDefaultHeaders(true), Range: 'bytes=0-0' },
              agent: this._getAgent(parsedUrl.protocol),
              timeout: this.rangeProbeTimeout,
            };
            const retryReq = client.request(retryOptions, (retryRes) => {
              if (retryRes.statusCode >= 200 && retryRes.statusCode < 300) {
                // Success — continue parsing with the response we have
                req.emit('retry-success', retryRes);
                return;
              }
              retryRes.destroy();
              reject(new Error(`HTTP ${retryRes.statusCode}: Server denied access even with browser credentials`));
            });
            retryReq.on('error', (err) => reject(err));
            retryReq.end();
            return;
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.destroy();
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }

          const contentLength = parseInt(res.headers['content-length'], 10);
          const acceptRanges = res.headers['accept-ranges'];
          this.mimeType = res.headers['content-type'] || '';

          this.fileSize = isNaN(contentLength) ? 0 : contentLength;
          const declaredRangeSupport = acceptRanges === 'bytes' && this.fileSize > 0;

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

          let verifiedRangeSupport = false;
          if (declaredRangeSupport) {
            const rangeCheckUrl = this.redirectedUrl || requestUrl;
            verifiedRangeSupport = await this._verifyRangeSupport(rangeCheckUrl);
          }

          this.modePreference = this._normalizeMode(this.modePreference);
          if (this.modePreference === 'single') {
            this.supportsRange = false;
            this.connectionMode = 'single';
            this._setTransportNotice('Series mode selected by user. Using single connection.');
          } else if (this.modePreference === 'parallel') {
            this.supportsRange = declaredRangeSupport;
            this.connectionMode = this.supportsRange ? 'parallel' : 'single';
            if (!declaredRangeSupport) {
              this._setTransportNotice('Server does not declare byte ranges. Parallel mode cannot be applied.');
            } else if (!verifiedRangeSupport) {
              this._setTransportNotice('Parallel mode forced by user. Server range behavior may be unstable.');
            } else {
              this._setTransportNotice('');
            }
          } else {
            this.supportsRange = declaredRangeSupport && verifiedRangeSupport;
            if (!this.supportsRange) {
              this.connectionMode = 'single';
              this._setTransportNotice('Server does not support stable parallel ranges. Using single connection.');
            } else {
              this.connectionMode = 'parallel';
              this._setTransportNotice('');
            }
          }

          res.destroy(); // Safely terminate the stream to prevent downloading the payload during metadata check!
          
          resolve({
            fileSize: this.fileSize,
            supportsRange: this.supportsRange,
            fileName: this.fileName,
            mimeType: this.mimeType,
            modePreference: this.modePreference,
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

  async _verifyRangeSupport(requestUrl) {
    return new Promise((resolve) => {
      const makeRequest = (rangeUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
          resolve(false);
          return;
        }

        const parsedUrl = new URL(rangeUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const rangeHeaders = this._getDefaultHeaders();
        rangeHeaders['Range'] = 'bytes=0-0';
        const reqOptions = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'GET',
          headers: rangeHeaders,
          agent: this._getAgent(parsedUrl.protocol),
          timeout: this.rangeProbeTimeout,
        };

        const req = client.request(reqOptions, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, rangeUrl).href;
            this.redirectedUrl = redirectUrl;
            makeRequest(redirectUrl, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 206) {
            res.resume();
            resolve(false);
            return;
          }

          const contentRange = res.headers['content-range'] || '';
          const match = /bytes\s+0-0\/(\d+|\*)/i.exec(contentRange);
          if (!match) {
            res.resume();
            resolve(false);
            return;
          }

          if (match[1] !== '*') {
            const totalSize = parseInt(match[1], 10);
            if (!isNaN(totalSize) && totalSize > 0) {
              this.fileSize = totalSize;
            }
          }

          res.resume();
          resolve(true);
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      };

      makeRequest(requestUrl);
    });
  }

  async start(existingChunks = null) {
    try {
      if (!existingChunks) {
        await this.getFileInfo();
      }

      // Ensure the save directory exists
      const saveDir = path.dirname(this.savePath);
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }

      this.status = 'downloading';
      this.error = null;
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
        this.connectionMode = this.supportsRange ? 'parallel' : 'single';
      } else if (this.supportsRange && this.fileSize > 0) {
        this.chunks = this._createChunks();
        this.connectionMode = this.connections > 1 ? 'parallel' : 'single';
      } else {
        this.chunks = [{
          index: 0,
          start: 0,
          end: this.fileSize > 0 ? this.fileSize - 1 : Infinity,
          downloaded: 0,
          status: 'pending',
          tempFile: path.join(this.tempDir, 'chunk_0'),
        }];
        this.connections = 1;
        this.connectionMode = 'single';
      }

      this.emit('start', this.getState());
      this._startSpeedCalculation();
      try {
        await this._downloadAllChunks();
      } catch (err) {
        if (this._isRangeFallbackError(err) && this.status === 'downloading') {
          await this._fallbackToSingleConnection();
        } else {
          throw err;
        }
      }

      if (this.status === 'downloading') {
        await this._mergeChunks();
        this._validateCompletedOutput();
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
    const maxReasonableConnections = Math.max(1, Math.ceil(this.fileSize / this.minChunkSize));
    const effectiveConnections = Math.max(1, Math.min(this.connections, maxReasonableConnections));
    if (effectiveConnections < this.connections) {
      this._setTransportNotice(`Adjusted parallel connections to ${effectiveConnections} for stable chunk sizing.`);
    }
    this.connections = effectiveConnections;

    const chunkSize = Math.ceil(this.fileSize / effectiveConnections);
    const chunks = [];
    for (let i = 0; i < effectiveConnections; i++) {
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

  _isRangeFallbackError(err) {
    return !!(err && err.code === 'RANGE_NOT_RELIABLE');
  }

  _parseContentRangeHeader(contentRange) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange || '');
    if (!match) return null;

    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const total = match[3] === '*' ? '*' : parseInt(match[3], 10);

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return null;
    }

    if (total !== '*' && (Number.isNaN(total) || total <= 0 || end >= total)) {
      return null;
    }

    return { start, end, total };
  }

  async _fallbackToSingleConnection() {
    this.activeRequests.forEach(({ req, res }) => {
      try {
        if (res) res.destroy();
        if (req) req.destroy();
      } catch (e) { /* ignore */ }
    });
    this.activeRequests = [];

    try {
      if (this.tempDir && fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.tempDir, { recursive: true });
    } catch (e) { /* ignore */ }

    this.supportsRange = false;
    this.connections = 1;
    this.connectionMode = 'single';
    this.modePreference = 'single';
    this._setTransportNotice('Parallel range mode was unstable on this server. Switched to single connection automatically.');
    this.chunks = [{
      index: 0,
      start: 0,
      end: this.fileSize > 0 ? this.fileSize - 1 : Infinity,
      downloaded: 0,
      status: 'pending',
      tempFile: path.join(this.tempDir, 'chunk_0'),
    }];

    await this._downloadAllChunks();
  }

  async setMode(mode) {
    const normalizedMode = this._normalizeMode(mode);
    this.modePreference = normalizedMode;

    if (this.status === 'completed' || this.status === 'cancelled') {
      return this.getState();
    }

    if (this.status === 'downloading') {
      this.pause();
    }

    this.activeRequests.forEach(({ req, res }) => {
      try {
        if (res) res.destroy();
        if (req) req.destroy();
      } catch (e) { /* ignore cleanup errors */ }
    });
    this.activeRequests = [];

    this._stopSpeedCalculation();
    this._cleanup();

    this.chunks = [];
    this.downloadedBytes = 0;
    this.speed = 0;
    this.eta = 0;
    this.error = null;
    this.status = 'pending';

    await this.start();
    return this.getState();
  }

  _validateCompletedOutput() {
    if (!fs.existsSync(this.savePath)) {
      throw new Error('Final output file is missing after merge');
    }

    if (this.fileSize > 0) {
      const finalSize = fs.statSync(this.savePath).size;
      if (finalSize !== this.fileSize) {
        throw new Error(`Final file size mismatch (${finalSize}/${this.fileSize})`);
      }
    }
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

      if (!this.supportsRange && chunk.downloaded > 0) {
        chunk.downloaded = 0;
        try {
          if (fs.existsSync(chunk.tempFile)) {
            fs.rmSync(chunk.tempFile, { force: true });
          }
        } catch (e) { /* ignore cleanup errors */ }
      }

      const downloadUrl = this.redirectedUrl || this.url;
      const parsedUrl = new URL(downloadUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const headers = this._getDefaultHeaders(attempt > 0);
      const expectedChunkSize = Number.isFinite(chunk.end) ? (chunk.end - chunk.start + 1) : Infinity;
      let requestedStartByte = chunk.start;
      let intentionallyStoppedAtLimit = false;
      let streamFinalized = false;
      let finalizeChunk = null;
      let writeStream = null;
      let handleError = (err) => {
        if (intentionallyStoppedAtLimit) {
          if (finalizeChunk) finalizeChunk();
          return;
        }
        if (streamFinalized) return;
        streamFinalized = true;

        const invokeRetryOrReject = () => {
          if (this.status === 'paused' || this.status === 'cancelled') {
            resolve();
            return;
          }
          if (attempt < this.retryAttempts && this.status === 'downloading') {
            if (!this.supportsRange) {
              chunk.downloaded = 0;
              try { if (fs.existsSync(chunk.tempFile)) fs.rmSync(chunk.tempFile, { force: true }); } catch (e) {}
            }
            setTimeout(() => {
              this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
            }, this.retryDelay * (attempt + 1));
          } else {
            chunk.status = 'failed';
            reject(err);
          }
        };

        if (writeStream) {
          writeStream.end(() => {
            if (this.supportsRange && fs.existsSync(chunk.tempFile)) {
              const diskSize = fs.statSync(chunk.tempFile).size;
              if (chunk.downloaded > diskSize) {
                chunk.downloaded = diskSize;
              } else if (chunk.downloaded < diskSize) {
                try { fs.truncateSync(chunk.tempFile, chunk.downloaded); } catch (e) {}
              }
            }
            invokeRetryOrReject();
          });
        } else {
          invokeRetryOrReject();
        }
      };

      if (this.supportsRange) {
        this.connectionMode = 'parallel';
        if (Number.isFinite(expectedChunkSize) && chunk.downloaded >= expectedChunkSize) {
          chunk.downloaded = expectedChunkSize;
          chunk.status = 'completed';
          resolve();
          return;
        }

        requestedStartByte = chunk.start + chunk.downloaded;
        if (requestedStartByte > chunk.end) {
          chunk.downloaded = expectedChunkSize;
          chunk.status = 'completed';
          resolve();
          return;
        }

        headers['Range'] = `bytes=${requestedStartByte}-${chunk.end}`;
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        agent: this._getAgent(parsedUrl.protocol),
        timeout: 30000,
      };

      const req = client.request(reqOptions, (res) => {
        // Optimize socket for maximum throughput in all modes
        if (res.socket) {
          res.socket.setNoDelay(true);
          if (res.socket.setReceiveBufferSize) {
            res.socket.setReceiveBufferSize(2 * 1024 * 1024); // 2 MB receive buffer
          }
        }

        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          this.redirectedUrl = new URL(res.headers.location, downloadUrl).href;
          this._downloadChunk(chunk, attempt).then(resolve).catch(reject);
          return;
        }

        if (this.supportsRange && res.statusCode === 416) {
          if (Number.isFinite(expectedChunkSize) && chunk.downloaded >= expectedChunkSize) {
            chunk.downloaded = expectedChunkSize;
            chunk.status = 'completed';
            resolve();
            return;
          }

          reject(Object.assign(new Error(`HTTP 416 for chunk ${chunk.index}`), { code: 'RANGE_NOT_RELIABLE' }));
          return;
        }

        if (this.supportsRange && Number.isFinite(chunk.end) && res.statusCode !== 206) {
          res.resume();
          reject(Object.assign(new Error(`Server ignored range request for chunk ${chunk.index}`), { code: 'RANGE_NOT_RELIABLE' }));
          return;
        }

        if (this.supportsRange && Number.isFinite(chunk.end)) {
          const parsedContentRange = this._parseContentRangeHeader(res.headers['content-range']);
          if (!parsedContentRange) {
            res.resume();
            reject(Object.assign(new Error(`Invalid Content-Range for chunk ${chunk.index}`), { code: 'RANGE_NOT_RELIABLE' }));
            return;
          }

          const expectedEnd = chunk.end;
          if (parsedContentRange.start !== requestedStartByte || parsedContentRange.end > expectedEnd) {
            res.resume();
            reject(Object.assign(new Error(`Unexpected Content-Range for chunk ${chunk.index}`), { code: 'RANGE_NOT_RELIABLE' }));
            return;
          }
        }

        if (res.statusCode >= 400) {
          if (res.statusCode === 403 && attempt === 0) {
            // Retry with full browser UA — the next call to _getDefaultHeaders(attempt>0) will use browser UA
            res.resume();
            setTimeout(() => {
              this._downloadChunk(chunk, 1).then(resolve).catch(reject);
            }, 500);
            return;
          }
          
          if (attempt < this.retryAttempts) {
            if (!this.supportsRange) {
               chunk.downloaded = 0;
            }
            res.resume();
            setTimeout(() => {
              this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
            }, this.retryDelay * (attempt + 1));
            return;
          }
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for chunk ${chunk.index}`));
          return;
        }

        const flags = (this.supportsRange && chunk.downloaded > 0) ? 'a' : 'w';
        writeStream = fs.createWriteStream(chunk.tempFile, {
          flags,
          highWaterMark: 4 * 1024 * 1024,
        });
        writeStream.on('error', handleError);

        finalizeChunk = (err = null) => {
          if (streamFinalized) return;
          streamFinalized = true;

          writeStream.end(() => {
            // Reconcile saved progress with actual on-disk file size to prevent size mismatch, after flush
            if (this.supportsRange && fs.existsSync(chunk.tempFile)) {
              const diskSize = fs.statSync(chunk.tempFile).size;
              if (chunk.downloaded > diskSize) {
                chunk.downloaded = diskSize; // Reverse any buffered writes not in disk
              } else if (chunk.downloaded < diskSize) {
                try { fs.truncateSync(chunk.tempFile, chunk.downloaded); } catch (e) {}
              }
            }

            if (err) {
              chunk.status = 'failed';
              reject(err);
              return;
            }

            if (Number.isFinite(expectedChunkSize) && chunk.downloaded < expectedChunkSize) {
              if (attempt < this.retryAttempts && this.status === 'downloading') {
                if (!this.supportsRange) {
                  chunk.downloaded = 0;
                  try {
                    if (fs.existsSync(chunk.tempFile)) {
                      fs.rmSync(chunk.tempFile, { force: true });
                    }
                  } catch (e) { /* ignore cleanup errors */ }
                }
                setTimeout(() => {
                  this._downloadChunk(chunk, attempt + 1).then(resolve).catch(reject);
                }, this.retryDelay * (attempt + 1));
                return;
              }

              chunk.status = 'failed';
              reject(new Error(`Incomplete chunk ${chunk.index}`));
              return;
            }

            if (Number.isFinite(expectedChunkSize)) {
              chunk.downloaded = Math.min(chunk.downloaded, expectedChunkSize);
            }

            if (this.status !== 'paused' && this.status !== 'cancelled') {
              chunk.status = 'completed';
            }
            resolve();
          });
        };

        res.on('data', (data) => {
          if (this.status === 'paused' || this.status === 'cancelled') {
            res.destroy();
            return;
          }

          let payload = data;
          if (Number.isFinite(expectedChunkSize)) {
            const remaining = expectedChunkSize - chunk.downloaded;
            if (remaining <= 0) {
              intentionallyStoppedAtLimit = true;
              req.destroy();
              finalizeChunk();
              return;
            }

            if (data.length > remaining) {
              payload = data.subarray(0, remaining);
              intentionallyStoppedAtLimit = true;
            }
          }

          if (payload.length > 0) {
            const canContinue = writeStream.write(payload);
            chunk.downloaded += payload.length;

            // Respect backpressure so large transfers do not overflow buffers
            // and silently lose buffered data under heavy I/O pressure.
            if (!canContinue) {
              res.pause();
              writeStream.once('drain', () => {
                if (this.status === 'downloading') {
                  res.resume();
                }
              });
            }
          }

          if (intentionallyStoppedAtLimit && Number.isFinite(expectedChunkSize) && chunk.downloaded >= expectedChunkSize) {
            req.destroy();
            finalizeChunk();
          }
        });

        res.on('end', () => {
          if (finalizeChunk) finalizeChunk();
        });

        res.on('error', handleError);

        this.activeRequests.push({ req, res, chunk });
      });

      req.on('error', handleError);

      req.on('timeout', () => {
        req.destroy();
        handleError(new Error('Connection timed out'));
      });

      // Tune socket for extreme throughput in all connection modes
      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        if (socket.setReceiveBufferSize) {
          socket.setReceiveBufferSize(2 * 1024 * 1024);
        }
        if (socket.setSendBufferSize) {
          socket.setSendBufferSize(2 * 1024 * 1024);
        }
      });

      req.end();
    });
  }

  async _mergeChunks() {
    return new Promise((resolve, reject) => {
      // Ensure the save directory exists
      const saveDir = path.dirname(this.savePath);
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }

      const orderedChunks = [...this.chunks].sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        return a.index - b.index;
      });

      for (let i = 0; i < orderedChunks.length; i++) {
        const chunk = orderedChunks[i];
        if (!fs.existsSync(chunk.tempFile)) {
          reject(new Error(`Missing chunk file ${chunk.index}`));
          return;
        }

        if (Number.isFinite(chunk.end)) {
          const expectedSize = chunk.end - chunk.start + 1;
          const actualSize = fs.statSync(chunk.tempFile).size;
          if (actualSize !== expectedSize) {
            reject(new Error(`Chunk ${chunk.index} size mismatch (${actualSize}/${expectedSize})`));
            return;
          }
        }

        if (i > 0) {
          const prev = orderedChunks[i - 1];
          if (Number.isFinite(prev.end) && chunk.start !== prev.end + 1) {
            reject(new Error(`Chunk sequence gap/overlap between ${prev.index} and ${chunk.index}`));
            return;
          }
        }
      }

      const writeStream = fs.createWriteStream(this.savePath);
      writeStream.on('error', reject);

      const mergeNext = (index) => {
        if (index >= orderedChunks.length) {
          writeStream.end(resolve);
          return;
        }

        const chunk = orderedChunks[index];

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
    this.activeRequests.forEach(({ req, res }) => {
      try {
        if (res) res.destroy();
        if (req) req.destroy();
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
      try {
        await this._downloadAllChunks();
      } catch (err) {
        if (this._isRangeFallbackError(err) && this.status === 'downloading') {
          await this._fallbackToSingleConnection();
        } else {
          throw err;
        }
      }

      if (this.status === 'downloading') {
        await this._mergeChunks();
        this._validateCompletedOutput();
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
    this.activeRequests.forEach(({ req, res }) => {
      try {
        if (res) res.destroy();
        if (req) req.destroy();
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
    this._destroyAgents();
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
      modePreference: this.modePreference,
      connectionMode: this.connectionMode,
      transportNotice: this.transportNotice,
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
      modePreference: this.modePreference,
      connectionMode: this.connectionMode,
      transportNotice: this.transportNotice,
      headers: this.headers,
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
