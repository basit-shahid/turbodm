# TurboDM 🚀

**TurboDM** is a high-performance, professional-grade Download Manager built for Windows. It features a sleek, neon-inspired UI and a powerful multi-threaded core capable of accelerating downloads with up to 16 parallel connections.

![App Icon](build/icon.png)

## ✨ Key Features

- **16-Connection Parallel Engine**: Segmented file downloading for maximum speed.
- **Universal Browser Interception**: Intercepts all browser downloads via a dedicated Chrome extension.
- **Smart Media Capture**: Automatically detects streaming videos (YouTube, Twitter, TikTok, etc.) and offers resolution selection.
- **Automatic Muxing**: Seamlessly merges high-quality video and audio streams using FFmpeg.
- **Universal Extension Interceptor**: The browser extension routes supported downloads into TurboDM for integrated handling.
- **Smart Filename Extraction**: Prioritizes `Content-Disposition` headers and URL decoding to ensure files retain their original names.

## Legal & Responsible Use

- Use TurboDM only for content you own or are authorized to download.
- Users are responsible for compliance with applicable copyright law and platform terms.
- TurboDM is a general-purpose download tool and is not intended for unlawful use.

## 🛠️ Built With

- **Electron**: Main application framework.
- **Vanilla CSS**: Premium UI with glassmorphism and custom animations.
- **yt-dlp**: Powerful streaming media resolution engine.
- **FFmpeg**: Industry-standard audio/video multiplexing.
- **Node.js**: Asynchronous multi-threaded download logic.

## 📦 Installation

To install TurboDM on your device:

1. Download the latest installer from the [Releases](https://github.com/yourusername/turbodm/releases) page (if hosted).
2. Run `TurboDM Setup 1.0.1.exe`.
3. Follow the setup wizard to create a desktop shortcut.

### Browser Integration

To enable universal download capture:
1. Copy the `browser-extension` folder to your local machine.
2. Go to `chrome://extensions/` in Chrome.
3. Enable **Developer Mode**.
4. Click **Load Unpacked** and select the `browser-extension` folder.

## 🚀 For Developers

To run the project locally or build from source:

### Prerequisites
- [Node.js](https://nodejs.org/) (v16+)
- Git

### Setup
```bash
# Clone the repository
git clone https://github.com/yourusername/turbodm.git

# Install dependencies
npm install
```

### Development
```bash
# Start the application in dev mode
npm start
```

### Packaging
```bash
# Build the standalone Windows installer
npm run build
```

## 📜 License

This project is licensed under the MIT License - see [LICENSE](LICENSE).

Third-party dependencies are subject to their own terms - see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---
*Created with ❤️ by TurboDM*
