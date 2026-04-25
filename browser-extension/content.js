// Set up a mutation observer to seamlessly catch new video players
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.addedNodes.length) {
      scanForVideos();
    }
  }
});

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
    const urlToSend = (window.location.hostname.includes('youtube') || window.location.hostname.includes('twitter')) 
      ? window.location.href 
      : (videoElement.src || window.location.href);

    fetch('http://127.0.0.1:10101/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlToSend })
    }).catch(e => console.error('TurboDM server missing.'));
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
