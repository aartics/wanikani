// Run once: node public/icons/generate-icons.js
// Requires: npm install canvas
// Or just use any 192x192 and 512x512 PNG files named icon-192.png and icon-512.png

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function makeIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#ff00aa');
  grad.addColorStop(1, '#aa00ff');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fill();

  // Character
  ctx.fillStyle = 'white';
  ctx.font = `bold ${size * 0.52}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('和', size / 2, size / 2);

  return canvas.toBuffer('image/png');
}

const outDir = path.join(__dirname);
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makeIcon(192));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makeIcon(512));
console.log('Icons generated.');
