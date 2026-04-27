const TURBODM_API = 'http://127.0.0.1:10101/download';
const RECENT_ROUTE_WINDOW_MS = 5000;
const recentRoutedUrls = new Map();

// Create Right-Click Menu Items
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'turbodm-download-link',
      title: 'Download with TurboDM',
      contexts: ['link', 'video', 'audio'],
    });
  });
});

// Handle Right-Click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'turbodm-download-link') {
    const url = info.linkUrl || info.srcUrl;
    if (url) sendToTurboDM(url);
  }
});

// Allow content scripts to route downloads before native browser download begins.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'turbodm-route-download') return;

  const requestUrl = message.url;
  if (!requestUrl || shouldSkipRouting(requestUrl)) {
    sendResponse({ ok: false, skipped: true });
    return;
  }

  sendToTurboDM(requestUrl);
  sendResponse({ ok: true });
});

// URLs to SKIP (internal browser pages, extension pages, data URIs, etc.)
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

function shouldSkipRouting(url) {
  if (!url || SKIP_PATTERNS.some(pattern => pattern.test(url))) return true;

  const now = Date.now();
  const lastSentAt = recentRoutedUrls.get(url);
  if (lastSentAt && now - lastSentAt < RECENT_ROUTE_WINDOW_MS) {
    return true;
  }

  recentRoutedUrls.set(url, now);
  // Keep the de-dup map small.
  if (recentRoutedUrls.size > 200) {
    for (const [key, timestamp] of recentRoutedUrls) {
      if (now - timestamp > RECENT_ROUTE_WINDOW_MS) {
        recentRoutedUrls.delete(key);
      }
    }
  }

  return false;
}

// Intercept ALL browser downloads and route them to TurboDM
chrome.downloads.onCreated.addListener((downloadItem) => {
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url) return;

  // Skip files initiated by extensions and internal/blob/data URLs.
  if (downloadItem.byExtensionId) return;
  if (shouldSkipRouting(url)) return;

  // Cancel Chrome's built-in download immediately
  chrome.downloads.cancel(downloadItem.id, () => {
    // Also remove it from Chrome's download bar/list
    chrome.downloads.erase({ id: downloadItem.id }, () => {
      // Ignore erase failures for already-removed items.
      void chrome.runtime.lastError;
    });
  });

  // Route it to TurboDM
  sendToTurboDM(url);
});

// Function to ping the TurboDM Local Server
function sendToTurboDM(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  fetch(TURBODM_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: url }),
    signal: controller.signal,
  })
    .catch((error) => {
      console.error('TurboDM is not running. Please open TurboDM first.', error);
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}
