const TURBODM_API = 'http://127.0.0.1:10101/download';
const RETRY_INTERVAL_MS = 1500;
const RETRY_MAX_DURATION_MS = 15000;

const SKIP_PATTERNS = [
  /^blob:/i,
  /^data:/i,
  /^file:/i,
  /^chrome/i,
  /^edge/i,
  /^about:/i,
  /^chrome-extension:/i,
  /^moz-extension:/i,
];

const DOWNLOADABLE_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
  'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk',
  'iso', 'img',
  'pdf', 'epub',
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v',
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv',
]);

function isSkippableUrl(url) {
  return !url || SKIP_PATTERNS.some((pattern) => pattern.test(url));
}

function isLikelyDirectDownloadLink(anchor) {
  if (!anchor || !anchor.href) return false;
  if (anchor.hasAttribute('download')) return true;
  if (isSkippableUrl(anchor.href)) return false;

  try {
    const parsed = new URL(anchor.href, window.location.href);
    const pathname = decodeURIComponent(parsed.pathname || '').toLowerCase();
    const base = pathname.split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot === -1) return false;

    const ext = base.slice(dot + 1);
    return DOWNLOADABLE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function routeUrlViaBackground(url) {
  if (isSkippableUrl(url)) return;
  try {
    chrome.runtime.sendMessage({ type: 'turbodm-route-download', url });
  } catch {
    sendToTurboDM(url);
  }
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;

  const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!anchor) return;
  if (!isLikelyDirectDownloadLink(anchor)) return;

  event.preventDefault();
  event.stopPropagation();
  routeUrlViaBackground(anchor.href);
}, true);

// ── Protocol launch + auto-retry ────────────────────────────
// When TurboDM's local server is unreachable, trigger the turbodm:// protocol
// in the CURRENT tab (via a hidden iframe — no new tab opened) and then
// automatically retry sending the URL every 1.5 s for up to 15 s so the
// download is captured the moment TurboDM finishes starting.

let retryTimer = null;

function launchProtocolAndRetry(url) {
  // Trigger protocol in the current tab via hidden iframe (no new tab)
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = 'turbodm://?url=' + encodeURIComponent(url);
  document.body.appendChild(iframe);
  setTimeout(() => iframe.remove(), 2000);

  // Clear any previous retry loop
  if (retryTimer) clearInterval(retryTimer);

  // Auto-retry: poll the local server until TurboDM comes up
  const startTime = Date.now();
  retryTimer = setInterval(async () => {
    if (Date.now() - startTime > RETRY_MAX_DURATION_MS) {
      clearInterval(retryTimer);
      retryTimer = null;
      return;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(TURBODM_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (resp.ok) {
        // Success — TurboDM received the URL, stop retrying
        clearInterval(retryTimer);
        retryTimer = null;
      }
    } catch {
      // Server still not up — keep retrying
    }
  }, RETRY_INTERVAL_MS);
}

// ── Send to TurboDM ─────────────────────────────────────────

function sendToTurboDM(url) {
  if (isSkippableUrl(url)) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  fetch(TURBODM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: controller.signal,
  })
    .then((resp) => {
      if (!resp.ok) throw new Error('Server error');
    })
    .catch(() => {
      // Server not running — launch protocol in current tab + auto-retry
      launchProtocolAndRetry(url);
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}

// Listen for background script asking us to trigger protocol in current tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'turbodm-launch-protocol' && message.url) {
    launchProtocolAndRetry(message.url);
    sendResponse({ ok: true });
  }
});

// ── Video Overlay Scanner ───────────────────────────────────

let scanScheduled = false;
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.addedNodes.length) {
      scheduleScan();
      break;
    }
  }
});

function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scanForVideos();
  });
}

function scanForVideos() {
  const videos = document.querySelectorAll('video');
  videos.forEach(video => {
    if (video.dataset.turbodmInjected) return;
    if (video.clientWidth < 300) return;
    video.dataset.turbodmInjected = "true";
    createOverlayButton(video);
  });
}

function createOverlayButton(videoElement) {
  let container = videoElement.parentElement;
  if (!container) return;

  const btn = document.createElement('button');
  btn.className = 'turbodm-video-overlay-btn';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none"><path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    Download
  `;

  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const host = window.location.hostname.toLowerCase();
    const preferPageUrl = ['youtube', 'twitter', 'x.com', 'tiktok', 'vimeo', 'twitch'].some(domain => host.includes(domain));
    const urlToSend = preferPageUrl
      ? window.location.href
      : (videoElement.src || window.location.href);

    sendToTurboDM(urlToSend);
  };

  let hideTimer = null;
  let isHoveringContainer = false;
  let isHoveringButton = false;

  const setVisible = (isVisible) => {
    btn.style.opacity = isVisible ? '1' : '0';
    btn.style.pointerEvents = 'auto';
  };

  const showButton = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    setVisible(true);
  };

  const hideButton = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!isHoveringContainer && !isHoveringButton) setVisible(false);
      hideTimer = null;
    }, 800);
  };

  container.addEventListener('pointerenter', () => { isHoveringContainer = true; showButton(); });
  container.addEventListener('pointerleave', () => { isHoveringContainer = false; hideButton(); });
  btn.addEventListener('pointerenter', () => { isHoveringButton = true; showButton(); });
  btn.addEventListener('pointerleave', () => { isHoveringButton = false; hideButton(); });

  if (window.getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  setVisible(false);
  container.appendChild(btn);
}

// Initial scan and observer
scanForVideos();
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('pagehide', () => {
  observer.disconnect();
});
