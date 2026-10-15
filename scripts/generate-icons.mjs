// Generates the PNG app icons (no external dependencies) from a simple vector
// description matching public/icons/icon.svg. Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const TEAL = hex('#0a524c'), SUN = hex('#f6b73c'), PAPER = hex('#fffcf3'), MINT = hex('#dff4f0'), BLUE = hex('#1e4fd8');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size * 512, y / size * 512);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function roundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function art(maskable) {
  // Maskable icons keep content inside the central safe zone (80%).
  const s = maskable ? 0.72 : 1;
  return (px, py) => {
    const x = (px - 256) / s + 256, y = (py - 256) / s + 256;
    if (!maskable && !roundedRect(px, py, 112)) return [0, 0, 0, 0];
    if ((x - 380) ** 2 + (y - 132) ** 2 <= 54 * 54) return SUN;
    const lines = [236, 276, 316];
    for (const ly of lines) {
      if (Math.abs(y - ly) <= 7 && ((x >= 136 && x <= (ly === 316 ? 196 : 216)) || (x >= 296 && x <= (ly === 316 ? 356 : 376)))) return BLUE;
    }
    if (Math.abs(x - 256) <= 5 && y >= 180 && y <= 400) return TEAL;
    if (x >= 96 && x < 256 && y >= 172 + (256 - x) * 0.05 && y <= 400 - (256 - x) * 0.05) return PAPER;
    if (x > 256 && x <= 416 && y >= 172 + (x - 256) * 0.05 && y <= 400 - (x - 256) * 0.05) return MINT;
    return TEAL;
  };
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, art(false)));
writeFileSync('public/icons/icon-512.png', png(512, art(false)));
writeFileSync('public/icons/icon-maskable-512.png', png(512, art(true)));
console.log('Icons written to public/icons');
