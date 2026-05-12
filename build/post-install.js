const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Get the installation directory
const appPath = path.resolve(__dirname, '..');
const extensionPath = path.join(appPath, 'resources', 'app', 'browser-extension');

console.log('Post-install: Setting up browser extension...');

// Detect browser and open extension installation page
const isWindows = os.platform() === 'win32';
const isChrome = process.env.BROWSER === 'chrome';

if (isWindows) {
  // Try Chrome first
  const chromeInstallPage = 'chrome://extensions/?id=YOUR_EXTENSION_ID';
  const edgeInstallPage = 'edge://extensions/?id=YOUR_EXTENSION_ID';
  
  // For Chrome/Edge, we need to load the extension from the installed path
  const extensionLoadPage = `chrome://extensions/?id=${Buffer.from(extensionPath).toString('hex')}`;
  
  // Open Chrome with the extensions page
  exec(`start chrome`, (error) => {
    if (error) {
      console.log('Chrome not found, trying Edge...');
      // Fallback to Edge
      exec(`start msedge`, (error2) => {
        if (error2) {
          console.log('Neither Chrome nor Edge found');
        } else {
          console.log('Opening Edge to enable extension...');
          setTimeout(() => {
            exec(`start msedge chrome://extensions`, () => {});
          }, 2000);
        }
      });
    } else {
      console.log('Opening Chrome to enable extension...');
      setTimeout(() => {
        exec(`start chrome chrome://extensions`, () => {});
      }, 2000);
    }
  });
  
  // Create a helper file with extension info
  const infoFile = path.join(os.homedir(), 'AppData', 'Local', 'TurboDM', 'extension-info.json');
  const infoDir = path.dirname(infoFile);
  
  if (!fs.existsSync(infoDir)) {
    fs.mkdirSync(infoDir, { recursive: true });
  }
  
  fs.writeFileSync(infoFile, JSON.stringify({
    name: 'TurboDM Browser Extension',
    path: extensionPath,
    description: 'Download files using TurboDM directly from your browser',
    installDate: new Date().toISOString()
  }, null, 2));
  
  console.log('Extension info saved:', infoFile);
}

console.log('Post-install completed!');
