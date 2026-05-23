const { Jimp } = require('jimp');

async function main() {
    try {
        const img = await Jimp.read('assets/newlogo.jpg');
        
        // Auto-crop to remove excess whitespace around the logo
        img.autocrop();
        
        // Resize to 512x512 using contain/cover based on autocropped result.
        // We pad it slightly to look pleasant as an icon (e.g. 10% padding).
        // Best approach: resize bounding box to 440x440 and place in 512x512 center.
        img.contain({ w: 460, h: 460 });
        
        // Create an empty 512x512 transparent background, but wait! Since it's a JPG, it's white. 
        // For an .ico, we want it to be pleasantly sized. contain({ w: 512, h: 512 }) works, 
        // but let's just do a cover to zoom in, or just resize to 512x512.
        
        // Let's do a direct cover of the autocropped image to 512x512 so it fills the icon nicely
        img.cover({ w: 512, h: 512 });
        
        await img.write('build/icon.png');
        console.log('Created build/icon.png successfully.');
    } catch (err) {
        console.error('Failed to create icon:', err);
        process.exit(1);
    }
}
main();
