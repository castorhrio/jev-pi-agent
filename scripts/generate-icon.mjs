/**
 * Generates the UCAD app icon deterministically — no image tools, no network,
 * no binary assets in git beyond the outputs this script writes.
 *
 * The artwork is the UI's own brand rendered at icon scale: the dark tile and
 * the `--accent → #9d6dff` gradient from `styles.css` (.brand-mark), with a
 * rounded-cap checkmark as the glyph — the product's promise is that what the
 * agent received can be *verified*, and a check is the one shape that still
 * reads at 16px.
 *
 * Everything is signed-distance-field rendering into a hand-rolled PNG/ICO
 * container, so the whole pipeline is stdlib Node:
 *
 *   node scripts/generate-icon.mjs
 *
 * Writes:
 *   apps/desktop/resources/icon.ico  (16/24/32/48/64/128/256, PNG-compressed)
 *   apps/desktop/resources/icon.png  (1024, rounded tile on transparency)
 *
 * Re-run it whenever the brand colors change — the ICO must not drift from the
 * UI any more than the context pack may drift from its hash.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// -- brand ------------------------------------------------------------------
// Kept in one place: styles.css carries the same pair for .brand-mark. If you
// change one, change both (the contract test on copy does not reach here, so
// this comment is the reminder — the re-run command above is the mechanism).
const TILE_DARK = [0x15, 0x15, 0x1d];
const TILE_LIGHT = [0x20, 0x20, 0x2e];
const ACCENT_A = [0x6d, 0x7c, 0xff]; // --accent
const ACCENT_B = [0x9d, 0x6d, 0xff]; // gradient tail used by .brand-mark

// -- signed distance fields --------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;

/** Rounded rectangle SDF, p in [0,1], half-size/b radius in units of 1. */
function roundedBoxSdf(px, py, center, half, radius) {
  const qx = Math.abs(px - center[0]) - (half[0] - radius);
  const qy = Math.abs(py - center[1]) - (half[1] - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Capsule (round-capped segment) SDF. a/b endpoints, in units of 1. */
function capsuleSdf(px, py, a, b) {
  const pax = px - a[0];
  const pay = py - a[1];
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * The mark: a checkmark as two capsules. Endpoints in unit space; the long arm
 * overshoots slightly upward on purpose so the mark leans forward — same
 * visual verb as a terminal prompt, without literally drawing one.
 */
const CHECK_A = [0.27, 0.52];
const CHECK_B = [0.435, 0.685];
const CHECK_C = [0.745, 0.33];

/**
 * Render one size. Colors come back premultiplied-against-nothing RGBA with
 * straight alpha; 4×4 rotated-grid-ish supersampling is enough at these sizes.
 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  // Optical compensation: below 32px the AA eats the stroke, so thicken it.
  const stroke = (size <= 32 ? 0.098 : 0.083) / 2;
  const tileInset = 0.0625;
  const tileRadius = 0.205;
  const SS = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // unit-space sample
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;

          const tileD = roundedBoxSdf(u, v, [0.5, 0.5], [0.5 - tileInset, 0.5 - tileInset], tileRadius);
          // 1-texel analytic AA: the SDF is in unit space, so `size` texels per unit.
          const tileAlpha = clamp(0.5 - tileD * size, 0, 1);
          if (tileAlpha <= 0) continue;

          const t = (u + v) / 2; // 135° gradient axis, top-left → bottom-right
          const tr = mix(TILE_DARK[0], TILE_LIGHT[0], t);
          const tg = mix(TILE_DARK[1], TILE_LIGHT[1], t);
          const tb = mix(TILE_DARK[2], TILE_LIGHT[2], t);

          // Inner hairline near the tile edge (~1.5px at any size), purely for
          // definition at dark taskbar sizes.
          const edgeBand = clamp(1 - Math.abs(tileD + 1.5 / size) / (1.2 / size), 0, 1) * 0.055;

          const dArm1 = capsuleSdf(u, v, CHECK_A, CHECK_B);
          const dArm2 = capsuleSdf(u, v, CHECK_B, CHECK_C);
          const glyphD = Math.min(dArm1, dArm2) - stroke;
          const glyphAlpha = clamp(0.5 - glyphD * size, 0, 1);

          const gr = mix(ACCENT_A[0], ACCENT_B[0], t);
          const gg = mix(ACCENT_A[1], ACCENT_B[1], t);
          const gb = mix(ACCENT_A[2], ACCENT_B[2], t);

          const sr = mix(tr, gr, glyphAlpha);
          const sg = mix(tg, gg, glyphAlpha);
          const sb = mix(tb, gb, glyphAlpha);
          const alpha = clamp(tileAlpha * (1 + edgeBand), 0, 1);

          r += sr * alpha;
          g += sg * alpha;
          b += sb * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const coverage = a / n;
      if (coverage <= 0.0001) continue; // fully transparent stays 0,0,0,0
      rgba[i] = Math.round(r / a);
      rgba[i + 1] = Math.round(g / a);
      rgba[i + 2] = Math.round(b / a);
      rgba[i + 3] = Math.round(coverage * 255);
    }
  }
  return rgba;
}

// -- PNG container ------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// -- ICO container --------------------------------------------------------------
// Sizes ride as PNG entries (Vista+); 256 is the floor electron-builder wants.
function packIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  const blobs = [];
  pngs.forEach(([size, png], i) => {
    const e = entries.subarray(i * 16, i * 16 + 16);
    e[0] = size % 256;
    e[1] = size % 256;
    e[4] = 1; // planes
    e[6] = 32; // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, entries, ...blobs]);
}

// -- main ---------------------------------------------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const outDir = join(root, 'apps', 'desktop', 'resources');
mkdirSync(outDir, { recursive: true });

const pngs = ICO_SIZES.map((size) => [size, encodePng(renderIcon(size), size)]);
writeFileSync(join(outDir, 'icon.ico'), packIco(pngs));
writeFileSync(join(outDir, 'icon.png'), encodePng(renderIcon(1024), 1024));
console.log(`icon.ico (${ICO_SIZES.join('/')}), icon.png (1024) written to ${outDir}`);
