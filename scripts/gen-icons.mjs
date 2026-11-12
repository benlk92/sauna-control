// Writes PNG app icons (a warm gradient tile with three heat waves) without dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const pixel = (u, v) => {
  // background gradient: deep ember to amber
  const t = v;
  let r = 60 + 150 * (1 - t), g = 22 + 40 * (1 - t), b = 14;
  // three wavy heat lines
  for (const cx of [0.32, 0.5, 0.68]) {
    const wx = cx + 0.035 * Math.sin((v - 0.2) * 14);
    if (v > 0.22 && v < 0.78 && Math.abs(u - wx) < 0.03) { r = 255; g = 214; b = 160; }
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
};
for (const s of [180, 192, 512]) writeFileSync(`public/icon-${s}.png`, png(s, pixel));
console.log('icons written');
