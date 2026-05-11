// One-time icon generator — run: node make-icons.js
// Uses only Node built-ins; no extra packages needed.
// Produces simple solid-color placeholder PNGs (proper icons can be added later).

const fs = require('fs');
const path = require('path');

function rgbToPng(width, height, pixels) {
  // Minimal PNG encoder (pure JS, no deps)
  function adler32(data) {
    let s1 = 1, s2 = 0;
    for (const b of data) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
    return (s2 << 16) | s1;
  }

  function crc32(data) {
    const table = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    let c = 0xffffffff;
    for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u32be(n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }

  function chunk(type, data) {
    const typeBytes = [...type].map((c) => c.charCodeAt(0));
    const crc = crc32([...typeBytes, ...data]);
    return [...u32be(data.length), ...typeBytes, ...data, ...u32be(crc)];
  }

  // IHDR
  const ihdr = chunk('IHDR', [
    ...u32be(width), ...u32be(height),
    8, 2, 0, 0, 0, // bit depth, color type (RGB), compression, filter, interlace
  ]);

  // IDAT — raw scanlines (filter byte 0 + RGB per pixel), then zlib-compressed
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw.push(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
  }

  // Minimal zlib (uncompressed blocks, BTYPE=00)
  function deflateRaw(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      const blockLen = Math.min(65535, data.length - i);
      const last = i + blockLen >= data.length ? 1 : 0;
      out.push(last, blockLen & 0xff, (blockLen >> 8) & 0xff,
               (~blockLen) & 0xff, ((~blockLen) >> 8) & 0xff,
               ...data.slice(i, i + blockLen));
      i += blockLen;
    }
    return out;
  }

  const a = adler32(raw);
  const zlibData = [
    0x78, 0x01, // zlib header (deflate, no dict, level 1)
    ...deflateRaw(raw),
    ...u32be(a),
  ];

  const idat = chunk('IDAT', zlibData);
  const iend = chunk('IEND', []);

  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  return Buffer.from([...sig, ...ihdr, ...idat, ...iend]);
}

function makeIcon(size) {
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      // Linear gradient: #ff00aa → #aa00ff
      const t = x / size;
      pixels[i]     = Math.round(0xff * (1 - t) + 0xaa * t); // R
      pixels[i + 1] = 0;                                       // G
      pixels[i + 2] = Math.round(0xaa * (1 - t) + 0xff * t); // B
    }
  }
  return rgbToPng(size, size, pixels);
}

const outDir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), makeIcon(192));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), makeIcon(512));
console.log('Icons generated → public/icons/icon-192.png, icon-512.png');
