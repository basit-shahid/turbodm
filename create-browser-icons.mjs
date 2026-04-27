import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputPath = path.join(__dirname, 'build', 'icon.png');
const outputDir = path.join(__dirname, 'browser-extension');

const sizes = [16, 32, 48, 128];

async function createIcons() {
  try {
    // Read the original image
    const image = await Jimp.read(inputPath);
    
    // Generate resized versions
    for (const size of sizes) {
      const resized = image.clone().resize({ w: size, h: size });
      const outputPath = path.join(outputDir, `icon-${size}.png`);
      await resized.write(outputPath);
      console.log(`Created icon-${size}.png`);
    }
    
    console.log('All browser extension icons created successfully!');
  } catch (err) {
    console.error('Error creating icons:', err);
    process.exit(1);
  }
}

createIcons();
