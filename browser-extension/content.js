const TURBODM_API = 'http://127.0.0.1:10101/download';
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
    // Fallback to direct local API call if background worker is unavailable.
    sendToTurboDM(url);
  }
}

document.addEventListener('click', (event) => {
  // Respect modified clicks and non-primary buttons.
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!anchor) return;
  if (!isLikelyDirectDownloadLink(anchor)) return;

  event.preventDefault();
  event.stopPropagation();
  routeUrlViaBackground(anchor.href);
}, true);

// Set up a mutation observer to catch newly added video players without rescanning too aggressively.
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
    .catch(() => {
      console.error('TurboDM server missing.');
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}

function scanForVideos() {
  const videos = document.querySelectorAll('video');
  videos.forEach(video => {
    // Avoid double injecting
    if (video.dataset.turbodmInjected) return;
    
    // Only inject on decently sized videos to ignore tiny backgrounds
    if (video.clientWidth < 300) return;

    video.dataset.turbodmInjected = "true";
    createOverlayButton(video);
  });
}

function createOverlayButton(videoElement) {
  // Try to find a relative container to position the button on top of the video
  // Some sites use wrappers, some just plop a video down. We append to parent.
  let container = videoElement.parentElement;
  if (!container) return;
  
  // If the container is static, we must make sure positioning works (or overlay directly on body)
  // Usually appending to the direct parent works for standard players
  
  const btn = document.createElement('button');
  btn.className = 'turbodm-video-overlay-btn';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none"><path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    Download
  `;
  
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Default to the page URL for streaming sites (YT, Twitch), as yt-dlp prefers page URL
    // If it's a raw video tag on a random site without yt-dlp support, use its src.
    const host = window.location.hostname.toLowerCase();
    const preferPageUrl = ['youtube', 'twitter', 'x.com', 'tiktok', 'vimeo', 'twitch'].some(domain => host.includes(domain));
    const urlToSend = preferPageUrl
      ? window.location.href 
      : (videoElement.src || window.location.href);

    sendToTurboDM(urlToSend);
  };

  let hideTimer = null;

  const setVisible = (isVisible) => {
    btn.style.opacity = isVisible ? '1' : '0';
    btn.style.pointerEvents = isVisible ? 'auto' : 'none';
  };

  const showButton = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    setVisible(true);
  };

  const hideButton = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
    }

    hideTimer = setTimeout(() => {
      if (!container.matches(':hover') && !btn.matches(':hover')) {
        setVisible(false);
      }
      hideTimer = null;
    }, 80);
  };

  // Keep the button visible while the pointer moves between the wrapper and the button itself.
  container.addEventListener('pointerenter', showButton);
  container.addEventListener('pointerleave', hideButton);
  btn.addEventListener('pointerenter', showButton);
  btn.addEventListener('pointerleave', hideButton);
  
  // Ensure the parent is positioned so absolute positioning works
  if (window.getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  setVisible(false);

  container.appendChild(btn);
}

// Initial scan and observer kick off
scanForVideos();
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('pagehide', () => {
  observer.disconnect();
});
