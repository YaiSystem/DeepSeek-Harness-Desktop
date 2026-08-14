'use strict';

/**
 * Generates the black DeepSeek whale icon set:
 *   build/icon.svg   – black whale vector master (with padding)
 *   build/icon.png   – 512x512 PNG (app/runtime icon)
 *   build/icon.ico   – multi-size Windows icon (16..256)
 *
 * Source: simple-icons "deepseek" SVG (official whale mark, MIT/CC0 licensed).
 * Cross-checks the silhouette against deepseek.com's official favicon and
 * cdn icon, and fails loudly if the shapes don't match.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SRC_SVG = path.join(ROOT, 'assets', 'source', 'deepseek.svg');
const SRC_FAVICON = path.join(ROOT, 'assets', 'source', 'deepseek-favicon.ico');
const SRC_CDN_PNG = path.join(ROOT, 'assets', 'source', 'deepseek-icon.png');
const BUILD = path.join(ROOT, 'build');

const BLACK = '#000000';
const PADDING_SCALE = 0.84; // whale occupies 84% of the canvas
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;

function loadPngToIco() {
  const mod = require('png-to-ico');
  return typeof mod === 'function' ? mod : mod.default;
}

function fail(msg) {
  console.error('[make-icon] ERROR: ' + msg);
  process.exit(1);
}

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });

  const src = fs.readFileSync(SRC_SVG, 'utf8');
  const pathData = src.match(/<path[^>]*d="([^"]+)"/);
  if (!pathData) fail('could not extract path from simple-icons deepseek.svg');
  const d = pathData[1];

  const offset = (24 * (1 - PADDING_SCALE)) / 2;
  const paddedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<g transform="translate(${offset.toFixed(4)} ${offset.toFixed(4)}) scale(${PADDING_SCALE})">
<path fill="${BLACK}" d="${d}"/>
</g>
</svg>`;

  const unpaddedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000000" d="${d}"/></svg>`;

  fs.writeFileSync(path.join(BUILD, 'icon.svg'), paddedSvg + '\n');
  console.log('[make-icon] wrote build/icon.svg');

  // ---- silhouette cross-check against the official favicon (ICO frame) ----
  const favPng = await decodeLargestIcoFrame(SRC_FAVICON);
  fs.writeFileSync(path.join(BUILD, '_favicon-check.png'), favPng);
  const favInfo = await sharp(favPng).metadata();
  console.log(`[make-icon] favicon frame decoded: ${favInfo.width}x${favInfo.height}`);

  const cdnInfo = await sharp(SRC_CDN_PNG).metadata();
  console.log(`[make-icon] cdn icon: ${cdnInfo.width}x${cdnInfo.height}`);

  Promise.all([
    compareSilhouette(sharp(Buffer.from(unpaddedSvg)), sharp(favPng)),
    compareSilhouette(sharp(Buffer.from(unpaddedSvg)), sharp(SRC_CDN_PNG)),
  ]).then(([favIoU, cdnIoU]) => {
    console.log(`[make-icon] silhouette IoU vs favicon: ${(favIoU * 100).toFixed(1)}%`);
    console.log(`[make-icon] silhouette IoU vs cdn icon: ${(cdnIoU * 100).toFixed(1)}%`);
    if (favIoU < 0.6 && cdnIoU < 0.6) {
      fail(`silhouette mismatch (favicon ${(favIoU * 100).toFixed(1)}%, cdn ${(cdnIoU * 100).toFixed(1)}%) – source may not be the whale`);
    }

    return renderAll(paddedSvg);
  }).then(() => {
    console.log('[make-icon] DONE: build/icon.svg, build/icon.png, build/icon.ico');
  }).catch((err) => {
    fail(err && err.stack ? err.stack : String(err));
  });
}

async function renderAll(paddedSvg) {
  const master = await sharp(Buffer.from(paddedSvg)).resize(PNG_SIZE, PNG_SIZE).png().toBuffer();
  fs.writeFileSync(path.join(BUILD, 'icon.png'), master);
  console.log('[make-icon] wrote build/icon.png (512x512)');

  const pngs = [];
  for (const size of ICO_SIZES) {
    const buf = await sharp(master).resize(size, size).png().toBuffer();
    pngs.push(buf);
  }
  const pngToIco = loadPngToIco();
  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);
  console.log(`[make-icon] wrote build/icon.ico (${ICO_SIZES.join(',')})`);

  // tidy check file
  try { fs.unlinkSync(path.join(BUILD, '_favicon-check.png')); } catch {}
}

/** Render both inputs to the same 128x128 grayscale alpha mask and compute IoU. */
async function compareSilhouette(aSharp, bSharp) {
  const a = await aSharp.resize(128, 128).ensureAlpha().raw().toBuffer();
  const b = await bSharp.resize(128, 128).ensureAlpha().raw().toBuffer();
  const mask = (buf) => {
    const out = new Uint8Array(buf.length / 4);
    for (let i = 0; i < out.length; i++) {
      const alpha = buf[i * 4 + 3];
      const lum = (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2]) / 3;
      out[i] = alpha > 10 || lum < 245 ? 1 : 0; // opaque OR non-white
    }
    return out;
  };
  const ma = mask(a);
  const mb = mask(b);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < ma.length; i++) {
    if (ma[i] && mb[i]) inter++;
    if (ma[i] || mb[i]) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * Extract the largest PNG-compressed or BMP frame from a .ico file.
 * The ICO directory has 6-byte header + 16-byte entries; frame data may be
 * PNG (starts with \x89PNG) or DIB. We convert DIB frames to PNG via sharp
 * raw input, handling bottom-up rows and the AND mask.
 */
async function decodeLargestIcoFrame(icoPath) {
  const bytes = fs.readFileSync(icoPath);
  if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) fail('not an ICO file');
  const count = bytes.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    let w = bytes[off] || 256;
    let h = bytes[off + 1] || 256;
    const bpp = bytes.readUInt16LE(off + 6);
    const size = bytes.readUInt32LE(off + 8);
    const dataOff = bytes.readUInt32LE(off + 12);
    if (!best || w * h > best.w * best.h) best = { w, h, bpp, size, dataOff };
  }
  if (!best) fail('no frames in ICO');
  const frame = bytes.subarray(best.dataOff, best.dataOff + best.size);
  if (frame.length >= 8 && frame[0] === 0x89 && frame[1] === 0x50) {
    return frame; // PNG-compressed frame
  }
  // DIB frames need conversion; sharp's raw output is computed lazily.
  return dibToPng(frame, best);
}

async function dibToPng(dib, info) {
  const headerSize = dib.readUInt32LE(0);
  let w = dib.readInt32LE(4);
  const hRaw = dib.readInt32LE(8);
  const topDown = hRaw < 0;
  const h = Math.abs(hRaw);
  const bpp = dib.readUInt16LE(14);
  if (bpp !== 32) fail(`unsupported ICO frame bpp ${bpp}`);
  const pixelOff = headerSize;
  const rowBytes = w * 4;
  const andStride = Math.ceil(w / 32) * 4;
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = topDown ? y : h - 1 - y;
    const src = dib.subarray(pixelOff + srcRow * rowBytes, pixelOff + (srcRow + 1) * rowBytes);
    src.copy(pixels, y * rowBytes);
  }
  // AND mask (alpha) if present
  const andOff = pixelOff + h * rowBytes;
  if (andOff + h * andStride <= dib.length) {
    for (let y = 0; y < h; y++) {
      const srcRow = topDown ? y : h - 1 - y;
      for (let x = 0; x < w; x++) {
        const byte = dib[andOff + srcRow * andStride + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        const px = (y * w + x) * 4;
        if (bit) pixels[px + 3] = 0; // masked out
        else if (pixels[px + 3] === 0 && (pixels[px] || pixels[px + 1] || pixels[px + 2])) pixels[px + 3] = 255;
      }
    }
  }
  return sharp(pixels, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
