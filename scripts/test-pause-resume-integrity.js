const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const DownloadEngine = require('../src/download-engine');

const TEST_SIZE = 32 * 1024 * 1024; // 32 MB
const STREAM_CHUNK_SIZE = 64 * 1024; // 64 KB per streamed packet
const STREAM_DELAY_MS = 2;

const TEST_BUFFER = Buffer.allocUnsafe(TEST_SIZE);
for (let i = 0; i < TEST_SIZE; i++) {
  TEST_BUFFER[i] = (i * 17 + 13) % 251;
}

function parseRangeHeader(rangeHeader, totalSize) {
  const match = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader || '');
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
    return null;
  }

  return { start, end: Math.min(end, totalSize - 1) };
}

function sha256(bufferOrPath, isFile = false) {
  const hash = crypto.createHash('sha256');
  if (isFile) {
    hash.update(fs.readFileSync(bufferOrPath));
  } else {
    hash.update(bufferOrPath);
  }
  return hash.digest('hex');
}

function streamPayloadWithDelay(res, payload) {
  let offset = 0;

  const pump = () => {
    if (offset >= payload.length) {
      res.end();
      return;
    }

    const nextOffset = Math.min(offset + STREAM_CHUNK_SIZE, payload.length);
    const part = payload.subarray(offset, nextOffset);
    offset = nextOffset;

    const canContinue = res.write(part);
    if (!canContinue) {
      res.once('drain', () => setTimeout(pump, STREAM_DELAY_MS));
      return;
    }

    setTimeout(pump, STREAM_DELAY_MS);
  };

  pump();
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.url !== '/file') {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': TEST_SIZE,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
      return;
    }

    const rangeHeader = req.headers.range;
    if (!rangeHeader) {
      res.writeHead(200, {
        'Content-Length': TEST_SIZE,
        'Content-Type': 'application/octet-stream',
      });
      streamPayloadWithDelay(res, TEST_BUFFER);
      return;
    }

    const parsed = parseRangeHeader(rangeHeader, TEST_SIZE);
    if (!parsed) {
      res.writeHead(416, {
        'Content-Range': `bytes */${TEST_SIZE}`,
      });
      res.end();
      return;
    }

    const payload = TEST_BUFFER.subarray(parsed.start, parsed.end + 1);
    res.writeHead(206, {
      'Content-Length': payload.length,
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${TEST_SIZE}`,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    });
    streamPayloadWithDelay(res, payload);
  });
}

async function run() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/file`;
  const outputPath = path.join(os.tmpdir(), `tdm-pause-resume-${Date.now()}.bin`);

  const expectedHash = sha256(TEST_BUFFER);
  const engine = new DownloadEngine(testUrl, outputPath, {
    connections: 12,
    retryAttempts: 2,
    retryDelay: 100,
    minChunkSize: 512 * 1024,
    rangeProbeTimeout: 5000,
    modePreference: 'auto',
  });

  let pauseRequested = false;
  let pauseConfirmed = false;

  engine.on('progress', (state) => {
    if (!pauseRequested && state.progress >= 12) {
      pauseRequested = true;
      engine.pause();
      setTimeout(() => {
        engine.resume();
      }, 100);
    }
  });

  engine.on('pause', () => {
    pauseConfirmed = true;
  });

  const completion = new Promise((resolve, reject) => {
    engine.once('complete', (state) => resolve(state));
    engine.once('error', (state) => reject(new Error(state.error || 'download failed')));
  });

  engine.start().catch((err) => {
    // Completion path is asserted via complete/error events.
    if (!/pause|cancel/i.test(err.message || '')) {
      console.error('[start-error]', err.message);
    }
  });
  const state = await completion;

  const finalSize = fs.statSync(outputPath).size;
  const actualHash = sha256(outputPath, true);

  const pass = state.status === 'completed'
    && pauseRequested
    && pauseConfirmed
    && finalSize === TEST_SIZE
    && actualHash === expectedHash;

  console.log('[scenario:pause-resume-large-file]', JSON.stringify({
    status: state.status,
    pauseRequested,
    pauseConfirmed,
    finalSize,
    expectedSize: TEST_SIZE,
    hashMatch: actualHash === expectedHash,
    connectionMode: state.connectionMode,
    notice: state.transportNotice || null,
    pass,
  }));

  fs.rmSync(outputPath, { force: true });
  await new Promise((resolve) => server.close(resolve));

  console.log('[assert]', pass ? 'PASS' : 'FAIL');
  if (!pass) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
});
