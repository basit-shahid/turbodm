# TurboDM Installer - Browser Extension Integration

## Build Complete! ✅

**Installer Location:** `dist/TurboDM Setup 1.0.1.exe`

## What's New

### 1. **Browser Extension Included**
- The browser extension is now bundled with the installer
- Located in: `resources/app/browser-extension`
- Compatible with Chrome and Edge browsers

### 2. **Automatic Extension Setup**
After installation completes, users will:
1. See the TurboDM application launch
2. Find `extension-setup.bat` in their AppData folder
3. The setup helper will guide them to enable the extension

### 3. **Browser Detection**
The setup script automatically:
- Detects if Chrome or Edge is installed
- Opens the extensions page in the detected browser
- Provides manual instructions if no browser is found

## Installation Flow

```
1. User runs: TurboDM Setup 1.0.1.exe
2. Select installation directory
3. Application installs with extension files
4. Installation complete dialog appears
5. Application launches automatically (runAfterFinish: true)
6. Users can manually enable the extension via:
   - Chrome: chrome://extensions
   - Edge: edge://extensions
```

## Included Files

### Core Installer
- `TurboDM Setup 1.0.1.exe` - Main installer (Windows x64)
- `TurboDM Setup 1.0.1.exe.blockmap` - Binary diff for updates
- `latest.yml` - Update manifest

### Installation Includes
- ✅ TurboDM application
- ✅ Browser extension files
- ✅ Extension setup helper (extension-setup.bat)
- ✅ Extension setup guide (EXTENSION_SETUP.md)
- ✅ All dependencies (yt-dlp, ffmpeg, etc)

## How to Use

### For End Users:

1. **Run the Installer**
   ```
   TurboDM Setup 1.0.1.exe
   ```

2. **Follow Installation Wizard**
   - Choose installation directory
   - Click Install
   - Application launches automatically

3. **Enable Browser Extension**
   - For **Chrome**:
     - Open Chrome menu (⋮)
     - Settings → Extensions → Manage extensions
     - Or go to: `chrome://extensions`
     - Look for TurboDM and click Enable
   
   - For **Edge**:
     - Open Edge menu (•••)
     - Extensions → Manage extensions
     - Or go to: `edge://extensions`
     - Look for TurboDM and click Enable

### First Time Setup:

After installation, follow these steps to enable the extension:

1. Open Chrome/Edge Extensions page
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Navigate to:
   ```
   C:\Program Files\TurboDM\resources\app\browser-extension
   ```
5. Select the folder and click Open
6. Extension is now active!

## Features After Installation

Once the extension is enabled:

✅ **Video Downloads** - YouTube, Twitch, Vimeo, TikTok, etc.  
✅ **Direct Downloads** - Route file downloads through TurboDM  
✅ **Multi-connection** - Leverage 16-connection parallel downloads  
✅ **Hover Buttons** - Quick download overlay on video players  
✅ **Browser Integration** - Shift+Click to use TurboDM  

## Technical Details

### Installer Configuration
- **Target**: Windows x64
- **NSIS Installer**: Single-file executable
- **Size**: ~375MB unpacked (includes dependencies)
- **Installation Mode**: Per-user (current user) or per-machine
- **Auto-run**: Application starts after installation

### Extension Integration
- **Type**: Chrome/Edge compatible
- **Method**: Unpacked extension (Developer Mode required)
- **Location**: `Program Files\TurboDM\resources\app\browser-extension`
- **Files Included**:
  - `manifest.json` - Extension configuration
  - `background.js` - Event handler
  - `content.js` - Page injection script
  - `content.css` - Styling

### Post-Install Features
- Installer runs with `runAfterFinish: true`
- Desktop shortcut created automatically
- Start Menu folder created with shortcuts
- Extension setup guide provided

## Troubleshooting

### Extension not showing after installation?

1. **Check Developer Mode is ON:**
   - Chrome: `chrome://extensions` → Toggle "Developer mode"
   - Edge: `edge://extensions` → Toggle "Developer mode"

2. **Reload the extension:**
   - In extensions page, click the refresh icon for TurboDM

3. **Restart browser:**
   - Close and reopen Chrome/Edge completely

### Can't find the extension folder?

Default path after installation:
```
C:\Program Files\TurboDM\resources\app\browser-extension
```

If installed in custom directory:
```
[Custom Path]\TurboDM\resources\app\browser-extension
```

### Still not working?

1. Check if TurboDM application is running (listen on port 10101)
2. Try restarting TurboDM application
3. Verify extension files exist in installation folder
4. Check browser console for errors (F12)

## Next Steps

1. **Share the installer** - `TurboDM Setup 1.0.1.exe`
2. **Create installation guide** for users
3. **Publish to app store** (optional)
4. **Monitor feedback** for issues

## Version Info

- **Version**: 1.0.1
- **Platform**: Windows x64
- **Included**:
  - Electron 28.3.3
  - Node.js dependencies
  - yt-dlp for streaming
  - FFmpeg for transcoding
  - Browser extension v1.0

---

**Installation ready!** 🚀

Share `TurboDM Setup 1.0.1.exe` with users for easy one-click installation with integrated browser extension support.
