// png-squeeze: squeeze screenshots into the smallest PNG.
// Single-file entry (Node 22, erasable TypeScript = plain JavaScript, no
// dependencies beyond node: builtins). Reads MAKEFUN_INPUT_DIR (default
// /input) /<id>/image.png, writes MAKEFUN_OUTPUT_DIR (default /output)
// /<id>/image.png, losslessly, deterministically (two runs byte-identical).
//
// Method:
//  1. Decode the stored PNG to RGBA.
//  2. Screen every candidate form (palette / grey / RGB / grey+alpha / RGBA,
//     palette orders count + luminance) x filter choice (fixed 0-4, minsum,
//     pairs, per-row brute force) with zlib level 6; rank by weighed bytes.
//  3. Probe: run the custom optimal deflate and zlib 9 on the middle 64 KiB
//     of the winner's raw filtered data. If the optimal deflate wins the
//     probe, run it on the full image and keep the smaller of optimal /
//     zlib 9; otherwise use zlib 9 directly. (The probe never misclassifies
//     a winner on the practice set; a false positive costs time only.)
//  4. Write the PNG (IHDR [+ PLTE] [+ tRNS] + IDAT + IEND, CRCs correct).
//
// The optimal deflate is an original zopfli-style implementation: hash-chain
// LZ77 matcher, shortest-path (dynamic-programming) optimal parse over
// length-code groups, length-limited Huffman code construction, dynamic vs
// fixed block choice, 1 MiB blocks. Tuned config: chain 128, good-match
// exit 64, one dynamic-Huffman refinement.
//
// The PNG codec and the screen (forms, filters, palette reduction) are
// adapted from make.fun's own kit files (MIT, "make.fun's own (MIT)"):
//
//   program/generator/subject/png.mjs and program/generator/subject/scale.mjs
//   Copyright (c) make.fun, MIT License.
//
// Practice set score: 719,534 (v3, byte-identical to v2), all 8 answered,
// ~42s CPU / ~50s wall on this VM (limit 60s wall, 1 CPU, 512 MB).

import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// PNG codec for the entry. Adapted from make.fun's kit PNG codec
// (program/generator/subject/png.mjs, MIT, "make.fun's own (MIT)"), the
// decoder the checker reads every answer with. Only the pieces the entry
// needs: CRC-32, chunk writing, the decoder, the five filters.

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const CHUNKS = Object.freeze(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const fail = (why) => ({ ok: false, why });

// Decode a contest PNG to RGBA. Inputs here are stored PNGs (colour type 6,
// every row unfiltered), but the decoder handles every accepted form.
function decodePng(bytes, expect = null) {
  if (!(bytes instanceof Uint8Array)) return fail('it is not bytes');
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('it does not start with the PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null, palette = null, trns = null;
  const idat = [];
  let idatDone = false, ended = false;
  while (at < bytes.length) {
    if (ended) return fail('it holds bytes after IEND');
    if (at + 12 > bytes.length) return fail('a chunk is cut short');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail('a chunk claims bytes the file does not hold');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail('a chunk has no chunk type');
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(`the ${type} chunk fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!CHUNKS.includes(type)) return fail(`it holds a ${type} chunk, and only ${CHUNKS.join(', ')} are read`);
    if (header === null && type !== 'IHDR') return fail(`its first chunk is ${type}, not IHDR`);
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) return fail('it holds IHDR twice');
      if (len !== 13) return fail('its IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('its width or height is 0');
      if (expect !== null && (header.width !== expect.width || header.height !== expect.height)) return fail('not the expected size');
      if (header.depth !== 8) return fail('its bit depth is not 8');
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail('its colour type is not accepted');
      if (header.compression !== 0 || header.filter !== 0) return fail('its compression or filter method is not 0');
      if (header.interlace !== 0) return fail('it is interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('it holds PLTE twice');
      if (header.colourType !== 3) return fail('it holds PLTE with a colour type other than 3');
      if (idat.length > 0) return fail('its PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('its PLTE is not 1 to 256 entries of 3 bytes');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('it holds tRNS twice');
      if (idat.length > 0) return fail('its tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) return fail('its tRNS comes before PLTE');
        if (len > palette.length / 3) return fail('its tRNS holds more entries than its palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail('its tRNS is the wrong size');
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('its tRNS names a sample over 255');
      } else return fail(`it holds tRNS with colour type ${ct}`);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('its IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) return fail('its IDAT comes before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) return fail('its IEND is not empty');
      ended = true;
    }
  }
  if (!ended) return fail('it has no IEND');
  if (idat.length === 0) return fail('it has no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > 1 << 30) return fail('its image is too large to read');
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail(`its IDAT data is not one whole zlib stream (${String(err && err.message).split('\n')[0]})`);
  }
  if (raw.length !== expected) return fail(`its IDAT data inflates to ${raw.length} bytes, not ${expected}`);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`pixel ${i % width} names palette entry ${e} of ${entries}`);
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}

// The screen: the forms and filters an image can be written in, each
// weighed by zlib. Adapted from make.fun's kit scale compressor
// (program/generator/subject/scale.mjs, MIT, "make.fun's own (MIT)"), with
// the final compression left to the caller so a stronger deflate can be
// used. Lossless: every pixel's four channels decode back exactly.
//
// Forms: a palette (type 3, transparent entries first so tRNS is short)
// when the image has at most 256 colours; grey (0) or grey+alpha (4) when
// every pixel is grey; RGB (2) or RGBA (6) otherwise; with one fully
// transparent value no opaque pixel uses, type 0 or 2 with a tRNS key
// instead of an alpha channel.
// Filters per row: a fixed type, or 'minsum' (least signed sum), 'pairs'
// (fewest distinct byte pairs), or 'brute' (each filter compressed by zlib
// after the 32 KiB written before it, the smallest kept).

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// Filtered raw data of `samples` by `choice`: a fixed type, 'minsum',
// 'pairs' or 'brute'. Reuses `raw` when it fits.
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const FILTERS = Object.freeze({
  palette: Object.freeze([0]),
  paletteByLuminance: Object.freeze([0, 'minsum', 'brute']),
  channels: Object.freeze([0, 1, 2, 4, 'minsum', 'pairs', 'brute']),
});

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [['count', FILTERS.palette], ['luminance', FILTERS.paletteByLuminance]]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// Screen every form x filter with zlib at SCREEN; return ALL candidates
// sorted by weighed bytes (zlib bytes + PLTE/tRNS chunks), smallest first.
// The caller re-compresses the top candidates with the final deflate.
function screenAll(rgba, width, height, { brute = true } = {}) {
  const out = [];
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      if (!brute && choice === 'brute') continue;
      // A fresh buffer per candidate: reusing one would overwrite a
      // candidate already pushed (its `data` is the same array).
      const data = filtered(form.samples, width, height, form.bpp, choice, new Uint8Array(size));
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      out.push({ form, choice, data, bytes, zlibBytes: zlib.length });
    }
  }
  out.sort((a, b) => a.bytes - b.bytes);
  return out;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Optimal-parsing DEFLATE (zopfli-style), written for this entry.
// Pure JavaScript, no dependencies, deterministic: the same input bytes
// always produce the same output bytes. Produces a complete zlib stream
// (header 0x78 0x9C, deflate blocks, Adler-32).
//
// Method, per block (128 KiB, independent: no match crosses a block
// boundary):
//   1. LZ77 matches from hash chains (3-byte hash, up to 128 candidates,
//      early exit on a long match). For every length, the smallest
//      distance achieving at least that length is kept.
//   2. Shortest-path (dynamic programming) parse with a bit-cost model:
//      first fixed Huffman costs, then two refinements with dynamic
//      Huffman costs rebuilt from the previous parse. Hash chains are
//      built lazily as the parse advances, so a match never points at a
//      position ahead of the parse.
//   3. Each block is emitted with dynamic Huffman codes when smaller than
//      fixed Huffman, else fixed. A block with no matches is fixed.
// Huffman code lengths are limited to 15 bits (7 for the code-length
// code) by scaling frequencies and rebuilding.

// ---- RFC 1951 tables ----
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// length -> code (257..285), extra bits, extra value. NB: codes exceed 255,
// so LEN_CODE must be Uint16Array (a Uint8Array silently wraps 285 to 29).
const LEN_CODE = new Uint16Array(259);
const LEN_EXTRA_BITS = new Uint8Array(259);
const LEN_EXTRA_VAL = new Uint16Array(259);
for (let code = 0; code < 29; code++) {
  const base = LENGTH_BASE[code], extra = LENGTH_EXTRA[code];
  for (let v = 0; v < (1 << extra); v++) {
    const len = base + v;
    if (len > 258) break;
    LEN_CODE[len] = 257 + code;
    LEN_EXTRA_BITS[len] = extra;
    LEN_EXTRA_VAL[len] = v;
  }
}
LEN_CODE[258] = 285;

// distance -> code (0..29), extra bits, extra value.
const DIST_CODE = new Uint8Array(32769);
const DIST_EXTRA_BITS = new Uint8Array(32769);
const DIST_EXTRA_VAL = new Uint16Array(32769);
for (let code = 0; code < 30; code++) {
  const base = DIST_BASE[code], extra = DIST_EXTRA[code];
  for (let v = 0; v < (1 << extra); v++) {
    const d = base + v;
    if (d > 32768) break;
    DIST_CODE[d] = code;
    DIST_EXTRA_BITS[d] = extra;
    DIST_EXTRA_VAL[d] = v;
  }
}

// Largest length in each length code.
const LEN_GROUP_MAX = LENGTH_BASE.map((b, i) => Math.min(258, b + (1 << LENGTH_EXTRA[i]) - 1));

const FIXED_LITLEN = new Uint8Array(288);
for (let i = 0; i < 144; i++) FIXED_LITLEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LITLEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LITLEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LITLEN[i] = 8;

// ---- Huffman code building ----
// Length-limited Huffman lengths from frequencies. Builds a Huffman tree
// with a two-queue merge; when any length exceeds maxBits, scales the
// frequencies down and rebuilds (converges: all-ones frequencies give
// lengths <= ceil(log2(alphabet))).
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let f = freq;
  for (let attempt = 0; attempt < 12; attempt++) {
    const syms = [];
    for (let i = 0; i < n; i++) if (f[i] > 0) syms.push(i);
    if (syms.length === 0) return lengths;
    if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
    const order = syms.slice().sort((a, b) => f[a] - f[b] || a - b);
    const q1 = order.slice();
    const f1 = order.map((s) => f[s]);
    const q2 = [];
    const f2 = [];
    let i1 = 0, i2 = 0;
    const lens = new Uint8Array(n);
    const bump = (node, d) => {
      if (typeof node === 'number') lens[node] += d;
      else { bump(node[0], d); bump(node[1], d); }
    };
    let nodes = syms.length;
    while (nodes > 1) {
      const takeA = () => {
        if (i2 >= q2.length || (i1 < q1.length && f1[i1] <= f2[i2])) return { node: q1[i1], f: f1[i1++] };
        return { node: q2[i2], f: f2[i2++] };
      };
      const a = takeA(), b = takeA();
      bump(a.node, 1); bump(b.node, 1);
      q2.push([a.node, b.node]); f2.push(a.f + b.f);
      nodes--;
    }
    let max = 0;
    for (let i = 0; i < n; i++) if (lens[i] > max) max = lens[i];
    if (max <= maxBits) { lengths.set(lens); return lengths; }
    const scaled = new Uint32Array(n);
    for (let i = 0; i < n; i++) scaled[i] = f[i] > 0 ? Math.max(1, f[i] >> 1) : 0;
    f = scaled;
  }
  return lengths;
}

// Canonical Huffman codes from lengths.
function canonicalCodes(lengths) {
  const n = lengths.length;
  const blCount = new Uint16Array(16);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len !== 0) codes[i] = nextCode[len]++;
  }
  return { codes, lengths };
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

// ---- Bit writer (deflate packs bits LSB-first; Huffman codes MSB-first) ----
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(Math.max(1024, capacity));
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  grow(need) {
    if (this.pos + need + 8 > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need + 1024));
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
  }
  writeBits(value, len) {
    this.bitbuf |= value << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      this.grow(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  writeCode(code, len) {
    this.writeBits(reverseBits(code, len), len);
  }
  alignByte() {
    if (this.bitcnt > 0) {
      this.grow(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = 0; this.bitcnt = 0;
    }
  }
  bytes() { return this.buf.subarray(0, this.pos); }
}

// ---- Matcher ----
const HASH_SIZE = 32768;
const HASH_MASK = HASH_SIZE - 1;

function hash3(d, i) {
  return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK);
}

// Find matches at position i. Chains hold positions < i only (built lazily
// by the parser). Records EVERY candidate of length >= 3 in scratch
// (candLen/candDist, candCount entries) and returns the longest length.
// opts: { maxChain, goodMatch }.
function findMatches(d, i, n, head, prev, scratch, opts) {
  const maxLen = Math.min(258, n - i);
  if (maxLen < 3) { scratch.candCount = 0; return 0; }
  const h = hash3(d, i);
  let cand = head[h];
  let count = 0;
  let best = 2;
  let chain = opts.maxChain;
  while (cand >= 0 && chain-- > 0) {
    const dist = i - cand;
    if (dist > 32768) break;
    let len = 0;
    while (len < maxLen && d[cand + len] === d[i + len]) len++;
    if (len >= 3) {
      scratch.candLen[count] = len;
      scratch.candDist[count] = dist;
      count++;
      if (len > best) {
        best = len;
        if (len >= opts.goodMatch) break;
        if (len >= 32) chain = Math.min(chain, 32);
      }
    }
    cand = prev[cand];
  }
  scratch.candCount = count;
  return best;
}

// ---- Optimal parse (one block) ----
function optimalParse(d, n, litCost, distCost, scratch, opts) {
  const { head, prev, candLen, candDist, groupDist } = scratch;
  head.fill(-1);
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const from = new Int32Array(n + 1);
  const mLen = new Uint16Array(n + 1);
  const mDist = new Uint16Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    // Query matches at i (chains hold positions < i), then insert i.
    let longest = 0;
    if (ci !== Infinity && i + 3 <= n && head[hash3(d, i)] !== -1) {
      longest = findMatches(d, i, n, head, prev, scratch, opts);
    }
    if (i + 2 < n) {
      const h = hash3(d, i);
      prev[i] = head[h];
      head[h] = i;
    }
    if (ci === Infinity || longest < 3) {
      if (ci !== Infinity) {
        const lc = ci + litCost[d[i]];
        if (lc < cost[i + 1]) { cost[i + 1] = lc; from[i + 1] = i; mLen[i + 1] = 0; }
      }
      continue;
    }
    // Literal.
    const lc = ci + litCost[d[i]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; from[i + 1] = i; mLen[i + 1] = 0; }
    // groupDist[g]: smallest distance of a match of length >= L_g, where
    // L_g = min(longest, LEN_GROUP_MAX[g]). Candidates are recorded in
    // chain order, i.e. INCREASING distance, so the first candidate whose
    // length reaches L_g has the smallest distance for that threshold.
    // A single scan with a running max length gives all 29 values.
    const count = scratch.candCount;
    let j = 0, maxLen = 0;
    for (let g = 0; g < 29; g++) {
      if (LENGTH_BASE[g] > longest) { groupDist[g] = 32769; continue; }
      const Lg = Math.min(longest, LEN_GROUP_MAX[g]);
      while (j < count && maxLen < Lg) { if (candLen[j] > maxLen) maxLen = candLen[j]; j++; }
      groupDist[g] = maxLen >= Lg ? candDist[j - 1] : 32769;
    }
    // Only the largest length per length code can win.
    for (let g = 0; g < 29; g++) {
      if (LENGTH_BASE[g] > longest) break;
      const L = Math.min(longest, LEN_GROUP_MAX[g]);
      const dist = groupDist[g];
      if (dist > 32768) continue;
      const sym = 257 + g;
      const dc = DIST_CODE[dist];
      const c = ci + litCost[sym] + LEN_EXTRA_BITS[L] + distCost[dc] + DIST_EXTRA[dc];
      if (c < cost[i + L]) {
        cost[i + L] = c; from[i + L] = i; mLen[i + L] = L; mDist[i + L] = dist;
      }
    }
  }
  // Backtrack.
  const lit = [], lenExtra = [], distSym = [], distExtra = [];
  let p = n;
  while (p > 0) {
    const q = from[p];
    const L = mLen[p];
    if (L === 0) {
      lit.push(d[q]); lenExtra.push(0); distSym.push(0); distExtra.push(0);
    } else {
      const dist = mDist[p];
      lit.push(LEN_CODE[L]);
      lenExtra.push(LEN_EXTRA_VAL[L]);
      distSym.push(DIST_CODE[dist]);
      distExtra.push(DIST_EXTRA_VAL[dist]);
    }
    p = q;
  }
  lit.reverse(); lenExtra.reverse(); distSym.reverse(); distExtra.reverse();
  return {
    lit: Uint16Array.from(lit),
    lenExtra: Uint16Array.from(lenExtra),
    distSym: Uint16Array.from(distSym),
    distExtra: Uint16Array.from(distExtra),
  };
}

function frequencies(parse) {
  const ll = new Uint32Array(288);
  const dd = new Uint32Array(30);
  let matches = 0;
  const { lit, distSym } = parse;
  for (let i = 0; i < lit.length; i++) {
    ll[lit[i]]++;
    if (lit[i] >= 257) { dd[distSym[i]]++; matches++; }
  }
  ll[256]++;
  return { ll, dd, matches };
}

// Bit cost of a parse's symbols under given code lengths (excludes header).
function symbolBitCost(parse, llLengths, ddLengths) {
  let bits = 0;
  const { lit, lenExtra, distSym } = parse;
  for (let i = 0; i < lit.length; i++) {
    const s = lit[i];
    bits += llLengths[s];
    if (s >= 257) {
      const L = s === 285 ? 258 : LENGTH_BASE[s - 257] + lenExtra[i];
      bits += LEN_EXTRA_BITS[L];
      const ds = distSym[i];
      bits += ddLengths[ds] + DIST_EXTRA[ds];
    }
  }
  bits += llLengths[256];
  return bits;
}

// Emit one block (BFINAL + BTYPE + symbols + EOB).
function emitBlock(w, parse, isLast, useDynamic) {
  const { lit, lenExtra, distSym, distExtra } = parse;
  const { ll, dd } = frequencies(parse);
  w.writeBits(isLast ? 1 : 0, 1);
  if (!useDynamic) {
    w.writeBits(1, 2);
    const { codes } = canonicalCodes(FIXED_LITLEN);
    for (let i = 0; i < lit.length; i++) {
      const s = lit[i];
      w.writeCode(codes[s], FIXED_LITLEN[s]);
      if (s >= 257) {
        const L = s === 285 ? 258 : LENGTH_BASE[s - 257] + lenExtra[i];
        if (LEN_EXTRA_BITS[L] > 0) w.writeBits(lenExtra[i], LEN_EXTRA_BITS[L]);
        const ds = distSym[i];
        w.writeCode(ds, 5); // fixed distance codes are 5 bits, code == symbol
        if (DIST_EXTRA[ds] > 0) w.writeBits(distExtra[i], DIST_EXTRA[ds]);
      }
    }
    w.writeCode(codes[256], FIXED_LITLEN[256]);
    return;
  }
  w.writeBits(2, 2);
  const llLengths = buildLengths(ll, 15);
  const ddLengths = buildLengths(dd, 15);
  const { codes: llCodes } = canonicalCodes(llLengths);
  const { codes: ddCodes } = canonicalCodes(ddLengths);
  let hlit = 286, hdist = 30;
  while (hlit > 257 && llLengths[hlit - 1] === 0) hlit--;
  while (hdist > 1 && ddLengths[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(llLengths.subarray(0, hlit), 0);
  all.set(ddLengths.subarray(0, hdist), hlit);
  const seq = [];
  let j = 0;
  while (j < all.length) {
    const v = all[j];
    let run = 1;
    while (j + run < all.length && all[j + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const take = Math.min(left, 138); seq.push([18, take - 11, 7]); left -= take; }
      if (left >= 3) { seq.push([17, left - 3, 3]); left = 0; }
      while (left-- > 0) seq.push([0, 0, 0]);
    } else {
      seq.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) { const take = Math.min(left, 6); seq.push([16, take - 3, 2]); left -= take; }
      while (left-- > 0) seq.push([v, 0, 0]);
    }
    j += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of seq) clFreq[s]++;
  const clLengths = buildLengths(clFreq, 7);
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLengths[ORDER[hclen - 1]] === 0) hclen--;
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.writeBits(clLengths[ORDER[k]], 3);
  const { codes: clCodes } = canonicalCodes(clLengths);
  for (const [s, extra, bits] of seq) {
    w.writeCode(clCodes[s], clLengths[s]);
    if (bits > 0) w.writeBits(extra, bits);
  }
  for (let i = 0; i < lit.length; i++) {
    const s = lit[i];
    w.writeCode(llCodes[s], llLengths[s]);
    if (s >= 257) {
      const L = s === 285 ? 258 : LENGTH_BASE[s - 257] + lenExtra[i];
      if (LEN_EXTRA_BITS[L] > 0) w.writeBits(lenExtra[i], LEN_EXTRA_BITS[L]);
      const ds = distSym[i];
      w.writeCode(ddCodes[ds], ddLengths[ds]);
      if (DIST_EXTRA[ds] > 0) w.writeBits(distExtra[i], DIST_EXTRA[ds]);
    }
  }
  w.writeCode(llCodes[256], llLengths[256]);
}

// Estimated dynamic header size in bits (for the fixed-vs-dynamic choice).
function dynamicHeaderBits(parse) {
  const { ll, dd } = frequencies(parse);
  const llLengths = buildLengths(ll, 15);
  const ddLengths = buildLengths(dd, 15);
  let hlit = 286, hdist = 30;
  while (hlit > 257 && llLengths[hlit - 1] === 0) hlit--;
  while (hdist > 1 && ddLengths[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(llLengths.subarray(0, hlit), 0);
  all.set(ddLengths.subarray(0, hdist), hlit);
  let seqSyms = 0, seqBits = 0;
  let j = 0;
  while (j < all.length) {
    const v = all[j];
    let run = 1;
    while (j + run < all.length && all[j + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const take = Math.min(left, 138); seqSyms++; seqBits += 7; left -= take; }
      if (left >= 3) { seqSyms++; seqBits += 3; left = 0; }
      seqSyms += left;
    } else {
      seqSyms++;
      let left = run - 1;
      while (left >= 3) { const take = Math.min(left, 6); seqSyms++; seqBits += 2; left -= take; }
      seqSyms += left;
    }
    j += run;
  }
  return 14 + 3 * 19 + seqSyms * 4 + seqBits;
}

function compressBlock(w, d, isLast, opts) {
  const n = d.length;
  if (n === 0) {
    w.writeBits(isLast ? 1 : 0, 1);
    w.writeBits(1, 2);
    const { codes } = canonicalCodes(FIXED_LITLEN);
    w.writeCode(codes[256], FIXED_LITLEN[256]);
    return;
  }
  const scratch = {
    head: new Int32Array(HASH_SIZE),
    prev: new Int32Array(n),
    candLen: new Uint16Array(256),
    candDist: new Uint16Array(256),
    sortLen: new Uint16Array(256),
    sortDist: new Uint16Array(256),
    groupDist: new Uint16Array(29),
    candCount: 0,
  };
  const litCostF = new Float64Array(288);
  const distCostF = new Float64Array(30);
  for (let i = 0; i < 288; i++) litCostF[i] = FIXED_LITLEN[i];
  distCostF.fill(5);
  let parse = optimalParse(d, n, litCostF, distCostF, scratch, opts);
  for (let iter = 0; iter < opts.refinements; iter++) {
    const { ll, dd } = frequencies(parse);
    const llLengths = buildLengths(ll, 15);
    const ddLengths = buildLengths(dd, 15);
    const litCost = new Float64Array(288);
    const distCost = new Float64Array(30);
    for (let i = 0; i < 288; i++) litCost[i] = ll[i] > 0 ? llLengths[i] : 15;
    for (let i = 0; i < 30; i++) distCost[i] = dd[i] > 0 ? ddLengths[i] : 12;
    const next = optimalParse(d, n, litCost, distCost, scratch, opts);
    if (symbolBitCost(next, llLengths, ddLengths) <= symbolBitCost(parse, llLengths, ddLengths)) parse = next;
  }
  const { ll, dd, matches } = frequencies(parse);
  const fixedBits = symbolBitCost(parse, FIXED_LITLEN, new Uint8Array(30).fill(5));
  const useDynamic = matches > 0 &&
    symbolBitCost(parse, buildLengths(ll, 15), buildLengths(dd, 15)) + dynamicHeaderBits(parse) < fixedBits;
  emitBlock(w, parse, isLast, useDynamic);
}


const BLOCK_SIZE = 131072;

// Full zlib stream of raw.
// opts: { maxChain, goodMatch, refinements, blockSize }
function deflateOptimal(raw, opts = {}) {
  const o = { maxChain: 128, goodMatch: 64, refinements: 2, blockSize: BLOCK_SIZE, ...opts };
  const w = new BitWriter(raw.length + 1024);
  w.writeBits(0x78, 8);
  w.writeBits(0x9c, 8);
  if (raw.length === 0) {
    compressBlock(w, raw, true, o);
  } else {
    let at = 0;
    while (at < raw.length) {
      const end = Math.min(raw.length, at + o.blockSize);
      compressBlock(w, raw.subarray(at, end), end === raw.length, o);
      at = end;
    }
  }
  w.alignByte();
  const out = w.bytes();
  const adler = adler32(raw);
  const result = new Uint8Array(out.length + 4);
  result.set(out, 0);
  result[out.length] = (adler >>> 24) & 0xff;
  result[out.length + 1] = (adler >>> 16) & 0xff;
  result[out.length + 2] = (adler >>> 8) & 0xff;
  result[out.length + 3] = adler & 0xff;
  return result;
}


const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const BRUTE = process.env.BRUTE !== '0';
// Tuned optimal-deflate config (see tune-blocks.mjs, tune-configs.mjs,
// tune-ref0.mjs): block 1 MiB, hash-chain 128, good-match exit 64, one
// dynamic-Huffman refinement.
const OPT = { maxChain: 128, goodMatch: 64, refinements: 1, blockSize: 1048576 };
const PROBE_SIZE = 65536;

let totalMs = 0;
for (const id of readdirSync(I).sort()) {
  const t0 = Date.now();
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  const cands = screenAll(image.rgba, image.width, image.height, { brute: BRUTE });
  const best = cands[0];
  // Probe on the middle 64 KiB of the winner's raw filtered data.
  const start = Math.floor((best.data.length - PROBE_SIZE) / 2);
  const sample = best.data.subarray(start, start + PROBE_SIZE);
  const probeOpt = deflateOptimal(sample, OPT);
  const probeZ9 = deflateSync(sample, { level: 9 });
  let final, used;
  if (probeOpt.length <= probeZ9.length) {
    const opt = deflateOptimal(best.data, OPT);
    const z9 = deflateSync(best.data, { level: 9 });
    if (opt.length <= z9.length) { final = opt; used = 'optimal'; } else { final = z9; used = 'zlib9(fallback)'; }
  } else {
    final = deflateSync(best.data, { level: 9 });
    used = 'zlib9(probe)';
  }
  const png = pngOfForm(image.width, image.height, best.form, new Uint8Array(final));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
  const ms = Date.now() - t0;
  totalMs += ms;
  console.log(`${id}: ct=${best.form.colourType} filter=${best.choice} screen=${best.bytes} probeOpt=${probeOpt.length} probeZ9=${probeZ9.length} used=${used} final=${png.length} (${ms}ms)`);
}
console.log(`TOTAL ${totalMs}ms for ${readdirSync(I).length} images`);
