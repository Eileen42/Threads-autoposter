// 보라색 솔리드 256x256 PNG 생성 — Electron 빌드/실행 전에 한 번만 실행
// (외부 이미지 파일 대신 코드로 아이콘 생성. zlib 외 의존성 없음.)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'tray-icon.png');
if (fs.existsSync(OUT)) {
  process.exit(0);
}

const W = 256, H = 256;
const COLOR = [0x7c, 0x3a, 0xed, 0xff]; // #7c3aed

// 스캔라인당 filter byte(0=None) + RGBA 픽셀
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4);
  raw[row] = 0;
  for (let x = 0; x < W; x++) {
    const o = row + 1 + x * 4;
    raw[o] = COLOR[0]; raw[o + 1] = COLOR[1]; raw[o + 2] = COLOR[2]; raw[o + 3] = COLOR[3];
  }
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
const idat = zlib.deflateSync(raw);

const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(OUT, png);
console.log(`✓ tray-icon.png 생성: ${OUT} (${png.length} bytes)`);
