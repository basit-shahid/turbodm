// Create Right-Click Menu Items
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "turbodm-download-link",
    title: "Download with TurboDM",
    contexts: ["link", "video", "audio"]
  });
});

// Handle Right-Click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "turbodm-download-link") {
    const url = info.linkUrl || info.srcUrl;
    if (url) sendToTurboDM(url);
  }
});

// URLs to SKIP (internal browser pages, extension pages, data URIs, etc.)
const SKIP_PATTERNS = [
  /^blob:/i,
  /^data:/i,
  /^chrome/i,
  /^edge/i,
  /^about:/i,
  /^chrome-extension:/i
];

// Intercept ALL browser downloads and route them to TurboDM
chrome.downloads.onCreated.addListener((downloadItem) => {
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!url) return;

  // Skip internal/blob/data URLs that can't be re-downloaded externally
  if (SKIP_PATTERNS.some(pattern => pattern.test(url))) return;

  // Cancel Chrome's built-in download immediately
  chrome.downloads.cancel(downloadItem.id, () => {
    // Also remove it from Chrome's download bar/list
    chrome.downloads.erase({ id: downloadItem.id });
  });

  // Route it to TurboDM
  sendToTurboDM(url);
});

// Function to ping the TurboDM Local Server
function sendToTurboDM(url) {
  fetch('http://127.0.0.1:10101/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: url })
  }).catch(error => {
    console.error('TurboDM is not running. Please open TurboDM first.', error);
  });
}
