const { Jimp } = require('jimp');
const path = require('path');

const sizes = [16, 32, 48, 128];

async function main() {
  for (const size of sizes) {
    const img = await Jimp.read('build/icon.png');
    img.cover({ w: size, h: size });
    await img.write(`browser-extension/icon-${size}.png`);
    console.log(`✓ icon-${size}.png`);
  }
}
main().catch(err => { console.error(err); process.exit(1); });
