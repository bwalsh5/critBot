/**
 * Renders the home-screen icons into public/icons/.
 *
 * Run with `npm run icons`. Committing the PNGs is what matters — this script
 * exists so the mark can be adjusted and regenerated rather than redrawn by
 * hand, and so the repo needs no image toolchain to build.
 *
 * The mark: a pale canvas standing in for the artwork, with a coral ring drawn
 * over it — the gesture of circling something on a student's work.
 */

import zlib from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const FIELD = [0x17, 0x17, 0x1b];  // near-black, a touch lighter than the app bg
const CANVAS = [0xf5, 0xf5, 0xf7]; // --text-main, standing in for the artwork
const ACCENT = [0xff, 0x47, 0x57]; // --accent

/** 4x supersampling, box-filtered down. Cheap, and the edges come out clean. */
const SS = 4;

/** Signed distance to a rounded rectangle centred at the origin. */
function sdRoundRect(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - halfW + r;
  const qy = Math.abs(y) - halfH + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function blend(dst, src, alpha) {
  for (let i = 0; i < 3; i++) dst[i] = Math.round(dst[i] * (1 - alpha) + src[i] * alpha);
}

/**
 * @param size    output edge length in pixels
 * @param inset   fraction of the canvas to keep the mark inside. Maskable
 *                icons get cropped to a circle by the launcher, so the mark
 *                has to sit within the inner 80%.
 * @param rounded whether to round the field's corners. iOS and Android mask
 *                the shape themselves, so only a bare favicon wants this.
 */
function render(size, { inset = 1, rounded = false } = {}) {
  const n = size * SS;
  const pixels = Buffer.alloc(n * n * 3);
  const c = n / 2;

  const fieldRadius = rounded ? n * 0.22 : 0;
  const canvasHalfW = n * 0.26 * inset;
  const canvasHalfH = n * 0.32 * inset;
  const canvasRadius = n * 0.03 * inset;

  // The ring circles a detail rather than the whole sheet, and breaks the
  // right edge — an annotation sits on top of the work, not inside a frame.
  const ringCx = c + n * 0.10 * inset;
  const ringCy = c - n * 0.085 * inset;
  const ringR = n * 0.135 * inset;
  const ringHalfStroke = n * 0.026 * inset;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const rgb = [0, 0, 0];

      // Field. Outside a rounded field the pixel stays black; nothing reads it
      // because both masks crop well inside that boundary.
      if (!rounded || sdRoundRect(px - c, py - c, c, c, fieldRadius) <= 0) {
        blend(rgb, FIELD, 1);
      }

      // The artwork.
      if (sdRoundRect(px - c, py - c, canvasHalfW, canvasHalfH, canvasRadius) <= 0) {
        blend(rgb, CANVAS, 1);
      }

      // The critique ring, drawn last so it reads on top of both.
      const ringDist = Math.abs(Math.hypot(px - ringCx, py - ringCy) - ringR);
      if (ringDist <= ringHalfStroke) {
        blend(rgb, ACCENT, 1);
      }

      const o = (y * n + x) * 3;
      pixels[o] = rgb[0];
      pixels[o + 1] = rgb[1];
      pixels[o + 2] = rgb[2];
    }
  }

  return downsample(pixels, n, size);
}

/** Averages each SS x SS block into one output pixel. */
function downsample(pixels, n, size) {
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const o = ((y * SS + dy) * n + (x * SS + dx)) * 3;
          sum[0] += pixels[o];
          sum[1] += pixels[o + 1];
          sum[2] += pixels[o + 2];
        }
      }
      const o = (y * size + x) * 3;
      const count = SS * SS;
      out[o] = Math.round(sum[0] / count);
      out[o + 1] = Math.round(sum[1] / count);
      out[o + 2] = Math.round(sum[2] / count);
    }
  }
  return out;
}

/** Minimal opaque-RGB PNG writer. Every scanline uses filter type 0. */
function encodePng(rgb, size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  // 10-12 are compression, filter and interlace methods; 0 is the only legal
  // value for each.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Fallback for Node versions without zlib.crc32 (added in 20.15). */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  // Launchers crop maskable icons to a circle, so the mark is pulled in.
  { file: 'icon-maskable-512.png', size: 512, opts: { inset: 0.72 } },
  // iOS composites this on the home screen without any rounding of its own
  // beyond the system mask, and never respects transparency.
  { file: 'apple-touch-icon.png', size: 180, opts: {} },
  { file: 'favicon-64.png', size: 64, opts: { rounded: true } }
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, opts } of TARGETS) {
  const png = encodePng(render(size, opts), size);
  writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)}KB`);
}
