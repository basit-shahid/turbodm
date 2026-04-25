const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DownloadEngine = require('../src/download-engine');

const TEST_SIZE = 5 * 1024 * 1024; // 5 MB
const TEST_BUFFER = Buffer.alloc(TEST_SIZE, 0x5a);

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

async function run() {
  const server = http.createServer((req, res) => {
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

    // Simulate a server that claims range support but rejects most parallel chunks.
    if (parsed.start > 0) {
      res.writeHead(416, {
        'Content-Range': `bytes */${TEST_SIZE}`,
      });
      res.end();
      return;
    }

    const chunk = TEST_BUFFER.subarray(parsed.start, parsed.end + 1);
    res.writeHead(206, {
      'Content-Length': chunk.length,
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${TEST_SIZE}`,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    });
    res.end(chunk);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const testUrl = `http://127.0.0.1:${port}/file`;
  const outputPath = path.join(os.tmpdir(), `tdm-parallel-fallback-${Date.now()}.bin`);

  console.log('[test] server started at', testUrl);

  const engine = new DownloadEngine(testUrl, outputPath, {
    connections: 8,
    retryAttempts: 1,
    retryDelay: 100,
    minChunkSize: 512 * 1024,
    rangeProbeTimeout: 5000,
  });

  let fallbackSeen = false;

  engine.on('start', (state) => {
    console.log('[event:start]', JSON.stringify({
      supportsRange: state.supportsRange,
      connections: state.connections,
      connectionMode: state.connectionMode,
      notice: state.transportNotice || null,
    }));
  });

  engine.on('progress', (state) => {
    if (state.transportNotice && /switched to single connection/i.test(state.transportNotice)) {
      fallbackSeen = true;
    }
  });

  const completion = new Promise((resolve, reject) => {
    engine.once('complete', (state) => resolve({ ok: true, state }));
    engine.once('error', (state) => reject(new Error(state.error || 'Download failed')));
  });

  await engine.start();
  const result = await completion;

  const fileStat = fs.statSync(outputPath);
  const pass = result.ok
    && result.state.status === 'completed'
    && fileStat.size === TEST_SIZE
    && (fallbackSeen || /single connection/i.test(result.state.transportNotice || ''));

  console.log('[event:complete]', JSON.stringify({
    status: result.state.status,
    size: fileStat.size,
    supportsRange: result.state.supportsRange,
    connections: result.state.connections,
    connectionMode: result.state.connectionMode,
    notice: result.state.transportNotice || null,
  }));

  console.log('[assert]', pass ? 'PASS' : 'FAIL');

  fs.rmSync(outputPath, { force: true });
  await new Promise((resolve) => server.close(resolve));

  if (!pass) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('[fatal]', err.message);
  process.exitCode = 1;
});
