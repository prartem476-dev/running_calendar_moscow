import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Pure Node PNG encoder (RGBA 8-bit)
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    r
  );
}

function sdCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

function sampleRunIcon(u, v, mode) {
  let r = 0, g = 0, b = 0, a = 0;

  if (mode !== 'foreground') {
    const bgDist =
      mode === 'round'
        ? sdCircle(u, v, 64, 64, 62)
        : mode === 'store'
        ? sdRoundRect(u, v, 64, 64, 64, 64, 0)
        : sdRoundRect(u, v, 64, 64, 60, 60, 24);
    if (bgDist > 0.5) return [0, 0, 0, 0];

    // Deep obsidian background #090b10 with subtle radial volt glow
    const glow = Math.max(0, 1 - Math.hypot(u - 64, v - 58) / 62);
    r = Math.round(0x09 + glow * 18);
    g = Math.round(0x0b + glow * 26);
    b = Math.round(0x10 + glow * 10);
    a = 255;

    // Outer neon volt stadium track ring
    const frameDist =
      mode === 'round'
        ? Math.abs(sdCircle(u, v, 64, 64, 56)) - 2.2
        : Math.abs(sdRoundRect(u, v, 64, 64, 55, 55, 20)) - 2.2;
    if (frameDist < 0) {
      r = 0xd4;
      g = 0xff;
      b = 0x00;
    }
  } else {
    u = (u - 64) / 0.72 + 64;
    v = (v - 64) / 0.72 + 64;
  }

  // Calendar top badge bar in crimson #ff3b5c
  const calTop = sdRoundRect(u, v, 64, 24, 30, 5.5, 3.0);
  if (calTop <= 0) {
    r = 0xff;
    g = 0x3b;
    b = 0x5c;
    a = 255;
  }
  // Calendar rings
  if (sdSegment(u, v, 46, 16, 46, 23, 2.4) <= 0 || sdSegment(u, v, 82, 16, 82, 23, 2.4) <= 0) {
    r = 0xf3;
    g = 0xf5;
    b = 0xf8;
    a = 255;
  }

  // Dynamic sprinter silhouette in Electric Volt (#d4ff00)
  const head = sdCircle(u, v, 76, 39, 7.2);
  const torso = sdSegment(u, v, 70, 48, 56, 70, 5.6);
  const frontArm = sdSegment(u, v, 68, 50, 82, 58, 3.6);
  const frontForearm = sdSegment(u, v, 82, 58, 89, 49, 3.3);
  const backArm = sdSegment(u, v, 67, 49, 51, 46, 3.5);
  const backForearm = sdSegment(u, v, 51, 46, 44, 55, 3.2);
  const frontThigh = sdSegment(u, v, 57, 69, 75, 78, 4.4);
  const frontShin = sdSegment(u, v, 75, 78, 69, 96, 3.8);
  const backThigh = sdSegment(u, v, 55, 70, 42, 83, 4.2);
  const backShin = sdSegment(u, v, 42, 83, 28, 88, 3.6);

  const runnerDist = Math.min(
    head,
    torso,
    frontArm,
    frontForearm,
    backArm,
    backForearm,
    frontThigh,
    frontShin,
    backThigh,
    backShin
  );

  // Speed lines on the left
  const speed1 = sdSegment(u, v, 24, 58, 39, 58, 2.0);
  const speed2 = sdSegment(u, v, 20, 68, 38, 68, 2.0);
  const speed3 = sdSegment(u, v, 26, 78, 35, 78, 2.0);
  const speedDist = Math.min(speed1, speed2, speed3);

  if (speedDist <= 0) {
    r = 0x06;
    g = 0xb6;
    b = 0xd4;
    a = 255;
  }

  // Stadium track curve under runner
  const trackCurve = sdSegment(u, v, 30, 104, 98, 104, 3.2);
  if (trackCurve <= 0) {
    r = 0xf3;
    g = 0xf5;
    b = 0xf8;
    a = 255;
  }

  if (runnerDist <= 0) {
    r = 0xd4;
    g = 0xff;
    b = 0x00;
    a = 255;
  }

  return [r, g, b, a];
}

function renderIconPng(size, mode) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = [0.25, 0.75];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (const sy of samples) {
        for (const sx of samples) {
          const u = ((x + sx) / size) * 128;
          const v = ((y + sy) / size) * 128;
          const [r, g, b, a] = sampleRunIcon(u, v, mode);
          sr += r;
          sg += g;
          sb += b;
          sa += a;
        }
      }
      const idx = (y * size + x) * 4;
      rgba[idx] = sr >> 2;
      rgba[idx + 1] = sg >> 2;
      rgba[idx + 2] = sb >> 2;
      rgba[idx + 3] = sa >> 2;
    }
  }
  return encodePng(size, size, rgba);
}

// 1. RuStore 512x512 icon
fs.mkdirSync('rustore', { recursive: true });
fs.writeFileSync('rustore/icon-512x512.png', renderIconPng(512, 'store'));

// 2. Android mipmap icons (if android folder exists)
const mipmaps = [
  { folder: 'mipmap-mdpi', launcher: 48, fg: 108 },
  { folder: 'mipmap-hdpi', launcher: 72, fg: 162 },
  { folder: 'mipmap-xhdpi', launcher: 96, fg: 216 },
  { folder: 'mipmap-xxhdpi', launcher: 144, fg: 324 },
  { folder: 'mipmap-xxxhdpi', launcher: 192, fg: 432 },
];

if (fs.existsSync('android/app/src/main/res')) {
  for (const m of mipmaps) {
    const dir = path.join('android/app/src/main/res', m.folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderIconPng(m.launcher, 'square'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), renderIconPng(m.launcher, 'round'));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), renderIconPng(m.fg, 'foreground'));
  }
}

console.log('✅ Сгенерирована иконка rustore/icon-512x512.png и адаптивные иконки Android.');
