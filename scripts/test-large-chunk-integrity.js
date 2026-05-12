const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const DownloadEngine = require('../src/download-engine');

const TEST_SIZE = 24 * 1024 * 1024; // 24 MB
const TEST_BUFFER = Buffer.allocUnsafe(TEST_SIZE);
for (let i = 0; i < TEST_SIZE; i++) {
  TEST_BUFFER[i] = i % 251;
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

function createServer(mode) {
  return http.createServer((req, res) => {
    if (req.url !== '/file') {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.method === 'HEAD') {
      const isTruncatedSingle = mode === 'truncated-single';
      res.writeHead(200, {
        'Content-Length': TEST_SIZE,
        'Accept-Ranges': isTruncatedSingle ? 'none' : 'bytes',
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
    if (mode === 'truncated-single') {
      const truncatedSize = Math.floor(TEST_SIZE / 2);
      const payload = TEST_BUFFER.subarray(0, truncatedSize);
      res.writeHead(200, {
        'Content-Length': payload.length,
        'Content-Type': 'application/octet-stream',
      });
      res.end(payload);
      return;
    }

    if (!rangeHeader) {
      res.writeHead(200, {
        'Content-Length': TEST_SIZE,
        'Content-Type': 'application/octet-stream',
      });
      res.end(TEST_BUFFER);
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

    let responseStart = parsed.start;
    let responseEnd = parsed.end;

    if (mode === 'misaligned-range' && parsed.start > 0) {
      // Simulate a flaky server returning a shifted range for non-zero chunks.
      responseStart = Math.min(parsed.start + 1, TEST_SIZE - 1);
      responseEnd = Math.min(responseStart + (parsed.end - parsed.start), TEST_SIZE - 1);
    }

    const payload = TEST_BUFFER.subarray(responseStart, responseEnd + 1);
    res.writeHead(206, {
      'Content-Length': payload.length,
      'Content-Range': `bytes ${responseStart}-${responseEnd}/${TEST_SIZE}`,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    });
    res.end(payload);
  });
}

async function runScenario(mode, label) {
  const server = createServer(mode);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/file`;
  const outputPath = path.join(os.tmpdir(), `tdm-integrity-${mode}-${Date.now()}.bin`);

  const expectedHash = sha256(TEST_BUFFER);
  const engine = new DownloadEngine(testUrl, outputPath, {
    connections: 16,
    retryAttempts: 1,
    retryDelay: 100,
    minChunkSize: 512 * 1024,
    rangeProbeTimeout: 5000,
    modePreference: 'auto',
  });

  let finalState = null;

  engine.on('complete', (state) => {
    finalState = state;
  });

  const completion = new Promise((resolve, reject) => {
    engine.once('complete', (state) => resolve(state));
    engine.once('error', (state) => reject(new Error(state.error || 'download failed')));
  });

  await engine.start();
  const state = await completion;

  const actualHash = sha256(outputPath, true);
  const size = fs.statSync(outputPath).size;

  const integrityOk = size === TEST_SIZE && actualHash === expectedHash;
  const fallbackExpected = mode === 'misaligned-range';
  const fallbackObserved = /single connection/i.test(state.transportNotice || '');
  const fallbackOk = fallbackExpected ? fallbackObserved : true;

  const pass = state.status === 'completed' && integrityOk && fallbackOk;

  console.log(`[scenario:${label}]`, JSON.stringify({
    status: state.status,
    size,
    expectedSize: TEST_SIZE,
    hashMatch: actualHash === expectedHash,
    connectionMode: state.connectionMode,
    notice: state.transportNotice || null,
    fallbackObserved,
    pass,
  }));

  fs.rmSync(outputPath, { force: true });
  await new Promise((resolve) => server.close(resolve));

  return pass;
}

async function runExpectedFailureScenario(mode, label) {
  const server = createServer(mode);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/file`;
  const outputPath = path.join(os.tmpdir(), `tdm-integrity-${mode}-${Date.now()}.bin`);

  const engine = new DownloadEngine(testUrl, outputPath, {
    connections: 16,
    retryAttempts: 1,
    retryDelay: 100,
    minChunkSize: 512 * 1024,
    rangeProbeTimeout: 5000,
    modePreference: 'auto',
  });

  const outcome = new Promise((resolve) => {
    engine.once('complete', (state) => resolve({ type: 'complete', state }));
    engine.once('error', (state) => resolve({ type: 'error', state }));
  });

  await engine.start();
  const result = await outcome;

  const pass = result.type === 'error' && /incomplete chunk|size mismatch/i.test(result.state.error || '');

  console.log(`[scenario:${label}]`, JSON.stringify({
    resultType: result.type,
    error: result.state.error || null,
    pass,
  }));

  fs.rmSync(outputPath, { force: true });
  await new Promise((resolve) => server.close(resolve));

  return pass;
}

async function run() {
  const results = [];
  results.push(await runScenario('good', 'good-parallel-large-file'));
  results.push(await runScenario('misaligned-range', 'misaligned-range-auto-fallback'));
  results.push(await runExpectedFailureScenario('truncated-single', 'truncated-single-must-fail'));

  const pass = results.every(Boolean);
  console.log('[assert]', pass ? 'PASS' : 'FAIL');
  if (!pass) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
});
