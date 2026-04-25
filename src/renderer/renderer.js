// ===== STATE =====
let downloads = [];
let clipboardUrl = null;
let toastTimeout = null;
let currentFilter = 'all';
let searchQuery = '';

// ===== DOM REFS =====
const $downloadList = document.getElementById('download-list');
const $emptyState = document.getElementById('empty-state');
const $modalAdd = document.getElementById('modal-add');
const $modalSettings = document.getElementById('modal-settings');
const $inputUrl = document.getElementById('input-url');
const $inputFilename = document.getElementById('input-filename');
const $inputConnections = document.getElementById('input-connections');
const $fileInfo = document.getElementById('file-info');
const $clipboardToast = document.getElementById('clipboard-toast');
const $toastUrl = document.getElementById('toast-url');

// Status bar
const $statusActive = document.getElementById('status-active');
const $statusTotal = document.getElementById('status-total');
const $statusSpeed = document.getElementById('status-speed');

// ===== FILE TYPE HELPERS =====
const fileTypeMap = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'],
  audio: ['mp3', 'flac', 'aac', 'ogg', 'wav', 'wma'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'psd'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'],
  executable: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk'],
};

function getFileType(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  for (const [type, exts] of Object.entries(fileTypeMap)) {
    if (exts.includes(ext)) return type;
  }
  return 'other';
}

function getFileExt(fileName) {
  return fileName.split('.').pop().toUpperCase().substring(0, 4);
}

// ===== FORMAT HELPERS =====
function formatBytes(bytes) { return window.tdm.formatBytes(bytes); }
function formatTime(seconds) { return window.tdm.formatTime(seconds); }
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s';
  return formatBytes(bytesPerSec) + '/s';
}

// ===== RENDER DOWNLOAD ITEM =====
function renderDownloadItem(dl) {
  const type = getFileType(dl.fileName);
  const ext = dl.isStreaming ? 'VID' : getFileExt(dl.fileName);
  const progress = dl.progress || 0;
  const isActive = dl.status === 'downloading';
  const isPaused = dl.status === 'paused';
  const isCompleted = dl.status === 'completed';
  const isFailed = dl.status === 'failed';

  let sizeText = '';
  if (dl.fileSize > 0) {
    sizeText = `${formatBytes(dl.downloadedBytes)} / ${formatBytes(dl.fileSize)}`;
  } else {
    sizeText = formatBytes(dl.downloadedBytes);
  }

  let actionsHtml = '';
  if (isActive) {
    actionsHtml = `
      <button class="btn btn-ghost" onclick="pauseDownload('${dl.id}')" title="Pause">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>
      </button>
      <button class="btn btn-danger-ghost" onclick="cancelDownload('${dl.id}')" title="Cancel">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>`;
  } else if (isPaused) {
    actionsHtml = `
      <button class="btn btn-ghost" onclick="resumeDownload('${dl.id}')" title="Resume" style="color:var(--accent)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 3L19 12L5 21V3Z" fill="currentColor"/></svg>
      </button>
      <button class="btn btn-danger-ghost" onclick="cancelDownload('${dl.id}')" title="Cancel">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>`;
  } else if (isCompleted) {
    actionsHtml = `
      <button class="btn btn-ghost" onclick="openFile('${dl.savePath.replace(/\\/g, '\\\\')}')" title="Open File" style="color:var(--success)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 13V19C18 20.1 17.1 21 16 21H5C3.9 21 3 20.1 3 19V8C3 6.9 3.9 6 5 6H11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15 3H21V9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button class="btn btn-ghost" onclick="openFolder('${dl.savePath.replace(/\\/g, '\\\\')}')" title="Open Folder">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M22 19C22 20.1 21.1 21 20 21H4C2.9 21 2 20.1 2 19V5C2 3.9 2.9 3 4 3H9L11 6H20C21.1 6 22 6.9 22 8V19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button class="btn btn-danger-ghost" onclick="cancelDownload('${dl.id}')" title="Remove">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>`;
  } else if (isFailed) {
    actionsHtml = `
      <button class="btn btn-ghost" onclick="retryDownload('${dl.id}', '${dl.url}')" title="Retry" style="color:var(--warning)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M1 4V10H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.51 15C4.16 17.06 5.49 18.83 7.29 19.97C9.09 21.11 11.22 21.56 13.31 21.23C15.4 20.9 17.29 19.82 18.62 18.17C19.95 16.52 20.63 14.42 20.53 12.29C20.43 10.15 19.56 8.12 18.08 6.58C16.6 5.05 14.61 4.1 12.48 3.93C10.35 3.76 8.23 4.37 6.52 5.64L1 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="btn btn-danger-ghost" onclick="cancelDownload('${dl.id}')" title="Remove">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>`;
  }

  // Chunk visualization
  let chunksHtml = '';
  if (dl.chunks && dl.chunks.length > 1 && (isActive || isPaused)) {
    chunksHtml = `<div class="chunks-bar">${dl.chunks.map(c => `
      <div class="chunk-segment">
        <div class="chunk-fill ${c.status}" style="width:${Math.min(c.progress || 0, 100)}%"></div>
      </div>`).join('')}</div>`;
  }

  let statusExtra = '';
  if (isActive) {
    statusExtra = `
      <span class="speed-indicator">${formatSpeed(dl.speed)}</span>
      <span class="connections-badge">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M12 2L12 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
        ${dl.activeConnections || 0}/${dl.connections || 16}
      </span>`;
  }
  if (isFailed && dl.error) {
    statusExtra = `<span style="color:var(--error);font-size:10px">${dl.error}</span>`;
  }

  return `
    <div class="download-item ${dl.status}" data-id="${dl.id}">
      <div class="download-header">
        <div class="download-info">
          <div class="file-icon ${type}">${ext}</div>
          <div class="file-details">
            <div class="file-name" title="${dl.fileName}">${dl.fileName}</div>
            <div class="file-meta">
              <span class="status-badge ${dl.status}">
                <span class="status-dot-indicator"></span>
                ${dl.status}
              </span>
              <span class="dot">•</span>
              <span class="text-size">${sizeText}</span>
              <span class="text-eta-wrapper" style="display:${dl.eta > 0 ? 'inline' : 'none'}">
                <span class="dot">•</span><span class="text-eta">ETA ${formatTime(dl.eta)}</span>
              </span>
            </div>
          </div>
        </div>
        <div class="download-actions">${actionsHtml}</div>
      </div>
      <div class="progress-container">
        <div class="progress-bar">
          <div class="progress-fill ${dl.status}" style="width:${progress}%"></div>
        </div>
        ${chunksHtml}
        <div class="progress-stats">
          <div class="progress-left">${statusExtra}</div>
          <div class="progress-right text-perc">${dl.fileSize > 0 ? progress.toFixed(1) + '%' : ''}</div>
        </div>
      </div>
    </div>`;
}

// ===== RENDER ALL =====
function renderDownloads() {
  const filtered = downloads.filter(d => {
    // Search query filter
    if (searchQuery && !d.fileName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }

    // Category filter
    if (currentFilter === 'all') return true;
    if (currentFilter === 'downloading') return d.status === 'downloading' || d.status === 'pending';
    if (currentFilter === 'completed') return d.status === 'completed';
    if (currentFilter === 'paused') return d.status === 'paused' || d.status === 'failed';
    return true;
  });

  if (filtered.length === 0) {
    if (downloads.length === 0) {
      $emptyState.querySelector('h3').textContent = 'No Downloads Yet';
      $emptyState.querySelector('p').innerHTML = 'Click <strong>Add URL</strong> or copy a download link to get started';
    } else {
      $emptyState.querySelector('h3').textContent = 'No Downloads Found';
      $emptyState.querySelector('p').textContent = 'Try changing your filter or search criteria';
    }
    $emptyState.style.display = '';
    $downloadList.querySelectorAll('.download-item').forEach(el => el.remove());
    updateStatusBar();
    return;
  }

  $emptyState.style.display = 'none';

  // Sort: active first, then paused, pending, failed, completed
  const statusOrder = { downloading: 0, paused: 1, pending: 2, failed: 3, completed: 4, cancelled: 5 };
  const sorted = [...filtered].sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9));

  $downloadList.innerHTML = sorted.map(renderDownloadItem).join('');
  updateStatusBar();
}

function updateDownloadInPlace(state) {
  const idx = downloads.findIndex(d => d.id === state.id);
  if (idx >= 0) {
    downloads[idx] = state;
  } else {
    downloads.push(state);
  }

  // Try to update in place for performance
  const existing = $downloadList.querySelector(`[data-id="${state.id}"]`);
  if (existing) {
    const oldStatus = existing.className.split(' ').find(c => ['downloading', 'paused', 'completed', 'failed', 'cancelled', 'pending'].includes(c));
    
    // Only do targeted in-place updates if retaining the "downloading" status
    if (state.status === 'downloading' && oldStatus === 'downloading') {
      // Bar updates
      const progressFill = existing.querySelector('.progress-fill');
      if (progressFill) progressFill.style.width = `${state.progress || 0}%`;

      const chunks = existing.querySelectorAll('.chunk-fill');
      if (chunks.length > 0 && state.chunks) {
        state.chunks.forEach((c, i) => {
          if (chunks[i]) chunks[i].style.width = `${Math.min(c.progress || 0, 100)}%`;
        });
      }

      // Text updates
      const sizeTextEl = existing.querySelector('.text-size');
      if (sizeTextEl) {
        const p = state.progress || 0;
        const total = state.fileSize > 0 ? formatBytes(state.fileSize) : '?';
        sizeTextEl.textContent = state.fileSize > 0 ? `${formatBytes(state.downloadedBytes)} / ${total}` : formatBytes(state.downloadedBytes);
      }

      const etaWrapEl = existing.querySelector('.text-eta-wrapper');
      const etaEl = existing.querySelector('.text-eta');
      if (etaWrapEl && etaEl) {
        if (state.eta > 0) {
          etaWrapEl.style.display = 'inline';
          etaEl.textContent = `ETA ${formatTime(state.eta)}`;
        } else {
          etaWrapEl.style.display = 'none';
        }
      }

      const percEl = existing.querySelector('.text-perc');
      if (percEl && state.fileSize > 0) percEl.textContent = (state.progress || 0).toFixed(1) + '%';

      const speedEl = existing.querySelector('.speed-indicator');
      if (speedEl) speedEl.textContent = formatSpeed(state.speed);

      // We rely on the rest largely staying identical while actively downloading
    } else {
      // If status changed (e.g. newly completed, paused), rewrite node completely
      const temp = document.createElement('div');
      temp.innerHTML = renderDownloadItem(state);
      existing.replaceWith(temp.firstElementChild);
    }
  } else {
    // New item - re-render the whole list to respect filters/sorting
    renderDownloads();
  }
  updateStatusBar();
}

function updateStatusBar() {
  const active = downloads.filter(d => d.status === 'downloading').length;
  const totalSpeed = downloads.reduce((sum, d) => d.status === 'downloading' ? sum + (d.speed || 0) : sum, 0);

  $statusActive.textContent = `${active} active`;
  $statusTotal.textContent = `${downloads.length} download${downloads.length !== 1 ? 's' : ''}`;
  $statusSpeed.innerHTML = `
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 2L12 18M12 18L7 13M12 18L17 13" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
    ${formatSpeed(totalSpeed)}`;
}

// ===== DOWNLOAD ACTIONS =====
async function pauseDownload(id) {
  await window.tdm.pauseDownload(id);
}

async function resumeDownload(id) {
  await window.tdm.resumeDownload(id);
}

async function cancelDownload(id) {
  await window.tdm.cancelDownload(id);
  downloads = downloads.filter(d => d.id !== id);
  renderDownloads();
}

async function retryDownload(id, url) {
  const dl = downloads.find(d => d.id === id);
  if (!dl) return;

  // Optimistically set to pending to show we are trying
  dl.status = 'pending';
  dl.error = null;
  updateDownloadInPlace(dl);

  const result = await window.tdm.resumeDownload(id);
  if (result && !result.error) {
    updateDownloadInPlace(result);
  } else {
    // If it still fails, keep it in the list with the new error
    const errorMsg = (result && result.error) ? result.error : 'Retry failed. Check your connection.';
    dl.status = 'failed';
    dl.error = errorMsg;
    updateDownloadInPlace(dl);
  }
}

async function openFile(filePath) {
  await window.tdm.openFile(filePath);
}

async function openFolder(filePath) {
  await window.tdm.openFolder(filePath);
}

// ===== ADD DOWNLOAD MODAL =====
function showAddModal(url = '') {
  $modalAdd.style.display = '';
  $inputUrl.value = url;
  $inputFilename.value = '';
  $fileInfo.style.display = 'none';
  $inputUrl.focus();

  if (url) {
    analyzeUrl(url);
  }
}

function hideAddModal() {
  $modalAdd.style.display = 'none';
  $inputUrl.value = '';
  $inputFilename.value = '';
  $fileInfo.style.display = 'none';
}

async function analyzeUrl(url, formatId) {
  if (!url) return;

  const $btn = document.getElementById('btn-analyze');
  $btn.innerHTML = '<div class="analyzing-spinner"><span></span><span></span><span></span></div>';
  $btn.disabled = true;

  try {
    const info = await window.tdm.getFileInfo(url, formatId);
    if (info.error) {
      $fileInfo.style.display = 'block';
      document.getElementById('info-filename').textContent = 'Error: ' + info.error;
      document.getElementById('info-filesize').textContent = '—';
      document.getElementById('info-resumable').textContent = '—';
      document.getElementById('info-connections').textContent = '—';
    } else {
      $fileInfo.style.display = 'block';
      document.getElementById('info-filename').textContent = info.fileName || 'Unknown';
      document.getElementById('info-filesize').textContent = info.fileSize ? formatBytes(info.fileSize) : 'Unknown';
      document.getElementById('info-resumable').textContent = info.supportsRange ? '✓ Yes' : '✗ No';
      document.getElementById('info-connections').textContent = info.supportsRange ? ($inputConnections.value || '16') : '1 (no range support)';
      $inputFilename.value = info.fileName || '';
      
      const $groupQuality = document.getElementById('group-quality');
      const $groupConnections = document.getElementById('group-connections');
      const $inputQuality = document.getElementById('input-quality');
      
      if (info.isStreaming) {
        $groupQuality.style.display = 'block';
        $groupConnections.style.display = 'none';
        $inputQuality.innerHTML = `
          <option value="bestvideo+bestaudio/best">Best Quality (Auto)</option>
          <option value="bestvideo[height<=2160]+bestaudio/best">4K (2160p)</option>
          <option value="bestvideo[height<=1440]+bestaudio/best">2K (1440p)</option>
          <option value="bestvideo[height<=1080]+bestaudio/best" selected>1080p</option>
          <option value="bestvideo[height<=720]+bestaudio/best">720p</option>
          <option value="bestvideo[height<=480]+bestaudio/best">480p</option>
          <option value="bestaudio/best">Audio Only</option>
        `;
      } else {
        $groupQuality.style.display = 'none';
        $groupConnections.style.display = 'block';
      }
    }
  } catch (err) {
    $fileInfo.style.display = 'block';
    document.getElementById('info-filename').textContent = 'Error: ' + err.message;
  }

  $btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><path d="M21 21L16.65 16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  $btn.disabled = false;
}

async function startDownload() {
  const url = $inputUrl.value.trim();
  if (!url) return;

  const options = {
    fileName: $inputFilename.value.trim() || undefined,
    connections: parseInt($inputConnections.value, 10) || 16,
    formatId: document.getElementById('group-quality').style.display !== 'none' 
              ? document.getElementById('input-quality').value 
              : undefined,
  };

  hideAddModal();

  const result = await window.tdm.addDownload(url, options);
  if (result && result.error) {
    alert('Download failed: ' + result.error);
  } else if (result) {
    updateDownloadInPlace(result);
  }
}

// ===== SETTINGS MODAL =====
async function showSettings() {
  const settings = await window.tdm.getSettings();
  document.getElementById('settings-dir').value = settings.downloadDir || '';
  document.getElementById('settings-concurrent').value = settings.maxConcurrent || 3;
  document.getElementById('settings-connections').value = settings.defaultConnections || 16;
  $modalSettings.style.display = '';
}

function hideSettings() {
  $modalSettings.style.display = 'none';
}

async function saveSettings() {
  const settings = {
    downloadDir: document.getElementById('settings-dir').value,
    maxConcurrent: parseInt(document.getElementById('settings-concurrent').value, 10),
    defaultConnections: parseInt(document.getElementById('settings-connections').value, 10),
  };
  await window.tdm.updateSettings(settings);
  hideSettings();
}

// ===== CLIPBOARD TOAST =====
function showClipboardToast(url) {
  clipboardUrl = url;
  $toastUrl.textContent = url;
  $clipboardToast.style.display = '';

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    $clipboardToast.style.display = 'none';
  }, 8000);
}

function hideClipboardToast() {
  $clipboardToast.style.display = 'none';
  if (toastTimeout) clearTimeout(toastTimeout);
}

// ===== EVENT LISTENERS =====
// Toolbar
document.getElementById('btn-add').addEventListener('click', () => showAddModal());
document.getElementById('btn-resume-all').addEventListener('click', () => {
  downloads.filter(d => d.status === 'paused').forEach(d => resumeDownload(d.id));
});
document.getElementById('btn-pause-all').addEventListener('click', () => {
  downloads.filter(d => d.status === 'downloading').forEach(d => pauseDownload(d.id));
});
document.getElementById('btn-retry-all').addEventListener('click', () => {
  downloads.filter(d => d.status === 'failed').forEach(d => retryDownload(d.id, d.url));
});
document.getElementById('btn-clear').addEventListener('click', async () => {
  await window.tdm.clearCompleted();
  // We only filter out completed and cancelled. We KEEP 'failed' to avoid accidental data loss.
  downloads = downloads.filter(d => d.status !== 'completed' && d.status !== 'cancelled');
  renderDownloads();
});
document.getElementById('btn-settings').addEventListener('click', showSettings);

// Add modal
document.getElementById('modal-add-close').addEventListener('click', hideAddModal);
document.getElementById('btn-cancel-add').addEventListener('click', hideAddModal);
document.getElementById('btn-analyze').addEventListener('click', () => analyzeUrl($inputUrl.value.trim()));
document.getElementById('input-quality').addEventListener('change', (e) => {
  analyzeUrl($inputUrl.value.trim(), e.target.value);
});
document.getElementById('btn-start-download').addEventListener('click', startDownload);
$inputUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      analyzeUrl($inputUrl.value.trim());
    } else {
      startDownload();
    }
  }
});

// Settings modal
document.getElementById('modal-settings-close').addEventListener('click', hideSettings);
document.getElementById('btn-cancel-settings').addEventListener('click', hideSettings);
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-browse-dir').addEventListener('click', async () => {
  const dir = await window.tdm.selectDirectory();
  if (dir) {
    document.getElementById('settings-dir').value = dir;
  }
});

// Toast
document.getElementById('toast-download').addEventListener('click', () => {
  hideClipboardToast();
  showAddModal(clipboardUrl);
});
// Sidebar Filters
document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    currentFilter = item.dataset.filter;
    renderDownloads();
  });
});

// Search
document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderDownloads();
});

document.getElementById('toast-dismiss').addEventListener('click', hideClipboardToast);

// Title bar
document.getElementById('btn-minimize').addEventListener('click', () => window.tdm.minimizeWindow());
document.getElementById('btn-close').addEventListener('click', () => window.tdm.closeWindow());

// Close modals on overlay click
$modalAdd.addEventListener('click', (e) => { if (e.target === $modalAdd) hideAddModal(); });
$modalSettings.addEventListener('click', (e) => { if (e.target === $modalSettings) hideSettings(); });

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAddModal();
    hideSettings();
    hideClipboardToast();
  }
});

// ===== IPC EVENTS =====
const unsubUpdate = window.tdm.onDownloadUpdate((state) => {
  updateDownloadInPlace(state);
});

const unsubClipboard = window.tdm.onClipboardUrl((url) => {
  showClipboardToast(url);
});

// ===== INIT =====
(async () => {
  downloads = await window.tdm.getAllDownloads();
  renderDownloads();
})();
