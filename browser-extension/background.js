const TURBODM_API = 'http://127.0.0.1:10101/download';
const RECENT_ROUTE_WINDOW_MS = 5000;
const recentRoutedUrls = new Map();

// Hide the browser's native download UI (requires downloads.ui permission)
if (chrome.downloads && chrome.downloads.setUiOptions) {
  chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
} else if (chrome.downloads && chrome.downloads.setShelfEnabled) {
  chrome.downloads.setShelfEnabled(false);
}

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
    if (url) sendToTurboDM(url, tab);
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

  const senderTab = sender && sender.tab ? sender.tab : null;
  sendToTurboDM(requestUrl, senderTab);
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

// Intercept browser downloads and route them to TurboDM
chrome.downloads.onCreated.addListener((downloadItem) => {
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url) return;

  // Skip files initiated by extensions and internal/blob/data URLs. Let Chrome download them.
  if (downloadItem.byExtensionId) return;
  if (SKIP_PATTERNS.some(pattern => pattern.test(url))) return;

  // We explicitly CANCEL Chrome's built-in download for all external URLs.
  chrome.downloads.cancel(downloadItem.id, () => {
    chrome.downloads.erase({ id: downloadItem.id }, () => {
      void chrome.runtime.lastError;
    });
  });

  // If this exact URL was already sent to TurboDM recently (e.g. by content.js picking up the click),
  // we do not want to route it to TurboDM again. 
  const now = Date.now();
  const lastSentAt = recentRoutedUrls.get(url);
  if (lastSentAt && now - lastSentAt < RECENT_ROUTE_WINDOW_MS) {
    return; // Already handled.
  }
  
  recentRoutedUrls.set(url, now);

  // Fetch the active tab so we can capture the Referer/Origin/cookies from the page that triggered the download.
  // This is critical for authenticated downloads from ChatGPT, Claude, Gemini, etc.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0] ? tabs[0] : null;
    sendToTurboDM(url, activeTab);
  });
});

// Function to ping the TurboDM Local Server.
// On failure, ask the content script of the current tab to trigger the protocol
// in-page (no new tab) with auto-retry.
function sendToTurboDM(url, tab) {
  // Grab headers (cookies, user-agent, referer, origin)
  const payload = { url: url, headers: {} };
  
  if (navigator.userAgent) {
    payload.headers['User-Agent'] = navigator.userAgent;
  }
  
  if (tab && tab.url) {
    payload.headers['Referer'] = tab.url;
    // Derive Origin from the tab URL (required by many AI services like Claude, Gemini, ChatGPT)
    try {
      const parsed = new URL(tab.url);
      payload.headers['Origin'] = parsed.origin;
    } catch {}
  }

  // Get all cookies for the target URL
  chrome.cookies.getAll({ url: url }, (cookies) => {
    if (cookies && cookies.length > 0) {
      payload.headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    fetch(TURBODM_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .catch((error) => {
        console.error('TurboDM server not responding. Launching protocol in current tab.', error);
        // Tell the content script to trigger the protocol in the current tab
        launchInCurrentTab(url, tab);
      })
      .finally(() => {
        clearTimeout(timeout);
      });
  });
}

// Send a message to the content script of the active tab to launch the protocol
// in-page (via hidden iframe) + start auto-retry. Falls back to new-tab only for
// pages where content scripts can't run (chrome://, edge://, etc.)
async function launchInCurrentTab(url, tab) {
  try {
    let targetTabId = tab && tab.id ? tab.id : null;

    if (!targetTabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id) {
        targetTabId = activeTab.id;
      }
    }

    if (targetTabId) {
      chrome.tabs.sendMessage(targetTabId, {
        type: 'turbodm-launch-protocol',
        url: url,
      }).catch(() => {
        // Content script not available — fall back to new tab
        fallbackProtocolNewTab(url);
      });
    } else {
      fallbackProtocolNewTab(url);
    }
  } catch {
    fallbackProtocolNewTab(url);
  }
}

// Last-resort fallback for pages where content script can't inject (chrome://, etc.)
function fallbackProtocolNewTab(url) {
  chrome.tabs.create({ url: 'turbodm://?url=' + encodeURIComponent(url), active: false }, (tab) => {
    if (tab && tab.id) {
      setTimeout(() => { chrome.tabs.remove(tab.id).catch(() => {}); }, 3000);
    }
  });
}
