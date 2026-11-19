// Builds app.ico (used by the desktop shortcut) from an SVG, using PNG-in-ICO.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="14" fill="#c2410c"/>
  <rect x="12" y="16" width="40" height="32" rx="5" fill="#fff"/>
  <circle cx="24" cy="27" r="4.5" fill="#f59e0b"/>
  <path d="M15 45l11-11 7 7 6-8 10 12z" fill="#15803d"/>
</svg>`;

const out = process.argv[2] || 'app.ico';
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const b = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, b);
  dir.writeUInt8(s >= 256 ? 0 : s, b + 1);
  dir.writeUInt8(0, b + 2);
  dir.writeUInt8(0, b + 3);
  dir.writeUInt16LE(1, b + 4);
  dir.writeUInt16LE(32, b + 6);
  dir.writeUInt32LE(pngs[i].length, b + 8);
  dir.writeUInt32LE(offset, b + 12);
  offset += pngs[i].length;
});
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, dir, ...pngs]));
console.log('Icon written to', out);
