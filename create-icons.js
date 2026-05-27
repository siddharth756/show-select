/**
 * Simple PNG icon generator using Canvas.
 * Run: node create-icons.js
 * 
 * This requires no dependencies — it creates minimal valid 
 * data-URL based PNG files by using an inline HTML approach.
 * 
 * ALTERNATIVE (easier): Open icons/generate-icons.html in Chrome 
 * and click the download links.
 */

const fs = require('fs');
const { createCanvas } = require('canvas');

function drawIcon(size) {
  let canvas, ctx;
  
  try {
    // Try node-canvas if available
    canvas = createCanvas(size, size);
    ctx = canvas.getContext('2d');
  } catch {
    console.log('node-canvas not installed. Use the browser method instead:');
    console.log('  1. Open icons/generate-icons.html in Chrome');
    console.log('  2. Click the download links to save PNG files');
    console.log('  3. Save them into the icons/ folder');
    process.exit(0);
  }
  
  const p = size / 128;
  
  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#7c3aed');
  grad.addColorStop(1, '#4f46e5');
  
  // Rounded rect
  const r = 24 * p;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  
  // Selection bar
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillRect(16*p, 48*p, 96*p, 24*p);
  
  // "S"
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(54*p)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', size*0.42, size*0.56);
  
  return canvas.toBuffer('image/png');
}

[16, 48, 128].forEach(size => {
  const buf = drawIcon(size);
  fs.writeFileSync(`icons/icon${size}.png`, buf);
  console.log(`✓ Created icons/icon${size}.png (${buf.length} bytes)`);
});
