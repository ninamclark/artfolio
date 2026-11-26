'use strict';
// Byte-level image cleaning, with no dependencies and no pixel decoding.
//
// Every upload is parsed as a real image container and REWRITTEN from an allowlist: only the parts a
// viewer needs to draw the picture are copied (plus the color profile, and the EXIF orientation as a
// tiny block holding that one number). Everything else is dropped: EXIF (including GPS), XMP, IPTC,
// text chunks, comments, embedded thumbnails (which can show the uncropped original), unknown or
// vendor chunks, and anything after the end of the image.
// Malformed files and "polyglots" (an image header followed by HTML or other payloads) fail to parse.
// Sizes are checked for the canvas AND for every frame/bitstream, and animations are capped,
// so a small file can't expand into gigabytes of pixels in a visitor's browser.
const { HttpError } = require('./errors');

const MAX_SIDE = 20000;
const MAX_PIXELS = 40e6; // per frame; the editor resizes to 2400px anyway
const MAX_FRAMES = 500;
const MAX_TOTAL_PIXELS = 400e6; // summed over all animation frames

const bad = (msg = 'That file is not a valid image. Please upload a JPG, PNG, WebP or GIF.') => new HttpError(415, msg);
function checkDims(w, h) {
  if (!w || !h) throw bad();
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new HttpError(413, `That image has too many pixels (max ${MAX_PIXELS / 1e6} megapixels)`);
}
function checkFrames(frames, totalPixels) {
  if (frames > MAX_FRAMES) throw new HttpError(413, `That animation has too many frames (max ${MAX_FRAMES})`);
  if (totalPixels > MAX_TOTAL_PIXELS) throw new HttpError(413, 'That animation is too large to show safely. Try fewer frames or a smaller size.');
}
// a frame at (x, y) of size w x h must lie inside the W x H canvas
function checkInside(x, y, w, h, W, H) {
  if (!w || !h || x + w > W || y + h > H) throw bad();
}

// ---------------- JPEG ----------------
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdd]); // DHT, DAC, DQT, DRI: needed to decode

function exifOrientation(data) {
  // data = APP1 payload: "Exif\0\0" + TIFF
  if (data.length < 14 || data.toString('latin1', 0, 6) !== 'Exif\0\0') return 1;
  const t = data.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return 1;
  const u16 = (o) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : null);
  const u32 = (o) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : null);
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd === null) return 1;
  const n = u16(ifd);
  if (n === null || n > 512) return 1;
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function orientationSegment(o) {
  // APP1 with a big-endian TIFF holding exactly one tag: Orientation
  return Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // marker, length 34, "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, //             TIFF header, IFD0 at offset 8
    0x00, 0x01, //                                                 one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00, // Orientation, SHORT, count 1
    0x00, 0x00, 0x00, 0x00, //                                     no next IFD
  ]);
}
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);

function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad();
  const out = [];
  let jfif = null;
  let i = 2, w = 0, h = 0, orientation = 1, sawSOF = false, sawSOS = false, done = false;
  while (i < buf.length && !done) {
    if (buf[i] !== 0xff) throw bad();
    while (buf[i + 1] === 0xff) i++; // fill bytes
    if (i + 2 > buf.length) throw bad();
    const m = buf[i + 1];
    if (m === 0x00) throw bad();
    if (m === 0xd9) { // EOI: anything after it is discarded
      if (!sawSOS) throw bad();
      out.push(buf.subarray(i, i + 2));
      done = true;
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { // markers with no payload
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) throw bad();
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw bad();
    const seg = buf.subarray(i, i + 2 + len);
    const data = buf.subarray(i + 4, i + 2 + len);
    if (SOF.has(m)) {
      if (data.length < 6 || sawSOF) throw bad();
      h = data.readUInt16BE(1);
      w = data.readUInt16BE(3);
      sawSOF = true;
      out.push(seg);
    } else if (m === 0xda || JPEG_TABLES.has(m)) {
      out.push(seg);
    } else if (m === 0xe0) {
      // JFIF header only, rebuilt with its thumbnail removed. JFXX (thumbnail extension) and others are dropped.
      if (!jfif && data.length >= 14 && data.toString('latin1', 0, 5) === 'JFIF\0') jfif = segment(0xe0, Buffer.concat([data.subarray(0, 12), Buffer.from([0, 0])]));
    } else if (m === 0xe1) { // EXIF/XMP: read orientation, then drop
      if (!sawSOF && orientation === 1) orientation = exifOrientation(data);
    } else if (m === 0xe2) {
      if (data.toString('latin1', 0, 12) === 'ICC_PROFILE\0') out.push(seg); // color profile: needed for correct colors
    } else if (m === 0xee) {
      // Adobe APP14 tells decoders how CMYK/YCCK data is stored. Its fixed part is 12 bytes; anything after is dropped.
      if (data.length >= 12 && data.toString('latin1', 0, 5) === 'Adobe') out.push(segment(0xee, data.subarray(0, 12)));
    }
    // everything else (other APPn, COM, JPG extensions 0xF0-0xFD, reserved markers) is dropped
    i += 2 + len;
    if (m === 0xda) { // start of scan: copy entropy-coded data up to the next real marker
      if (!sawSOF) throw bad();
      sawSOS = true;
      let j = i;
      for (;;) {
        j = buf.indexOf(0xff, j);
        if (j < 0 || j + 1 >= buf.length) throw bad(); // truncated: no EOI
        const n = buf[j + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { j += 2; continue; } // stuffed byte or restart marker
        if (n === 0xff) { j += 1; continue; }
        break;
      }
      out.push(buf.subarray(i, j));
      i = j;
    }
  }
  if (!done || !sawSOF) throw bad();
  checkDims(w, h);
  // JFIF requires its APP0 right after SOI, so the orientation block goes after it
  const parts = [Buffer.from([0xff, 0xd8])];
  if (jfif) parts.push(jfif);
  if (orientation !== 1) parts.push(orientationSegment(orientation));
  return { ext: '.jpg', buf: Buffer.concat([...parts, ...out]), width: w, height: h };
}

// ---------------- PNG ----------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

function png(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) throw bad();
  const out = [PNG_SIG];
  let pos = 8, w = 0, h = 0, sawIDAT = false, sawIEND = false, first = true;
  let frames = 0, totalPixels = 0;
  while (pos + 12 <= buf.length && !sawIEND) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > buf.length || !/^[A-Za-z]{4}$/.test(type)) throw bad();
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw bad();
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      checkDims(w, h);
      first = false;
    }
    if (type === 'IDAT') sawIDAT = true;
    if (type === 'IEND') sawIEND = true;
    if (type === 'acTL') {
      if (len !== 8) throw bad();
      checkFrames(data.readUInt32BE(0), 0);
    }
    if (type === 'fcTL') { // APNG frame: must fit inside the canvas
      if (len !== 26) throw bad();
      const fw = data.readUInt32BE(4), fh = data.readUInt32BE(8), fx = data.readUInt32BE(12), fy = data.readUInt32BE(16);
      checkInside(fx, fy, fw, fh, w, h);
      frames++;
      totalPixels += fw * fh;
      checkFrames(frames, totalPixels);
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
  }
  if (!sawIEND || !sawIDAT) throw bad();
  return { ext: '.png', buf: Buffer.concat(out), width: w, height: h };
}

// ---------------- WebP ----------------
const u24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
function vp8Dims(data) {
  if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw bad();
  return [data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff];
}
function vp8lDims(data) {
  if (data.length < 5 || data[0] !== 0x2f) throw bad();
  const bits = data.readUInt32LE(1);
  return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
}
// Walk RIFF chunks in buf[start, end): returns [{ id, data }]
function riffChunks(buf, start, end) {
  const list = [];
  let pos = start;
  while (pos + 8 <= end) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (pos + 8 + size > end) throw bad();
    list.push({ id, data: buf.subarray(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size & 1);
  }
  return list;
}
const riffChunk = (id, data) => {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

function webp(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw bad();
  const chunks = riffChunks(buf, 12, Math.min(buf.length, buf.readUInt32LE(4) + 8));
  const out = [];
  let W = 0, H = 0, animated = false, stills = 0, frames = 0, totalPixels = 0;
  chunks.forEach(({ id, data }, k) => {
    if (id === 'VP8X') {
      if (k !== 0 || data.length < 10) throw bad();
      W = 1 + u24(data, 4);
      H = 1 + u24(data, 7);
      checkDims(W, H);
      animated = !!(data[0] & 0x02);
      const copy = Buffer.from(data.subarray(0, 10));
      copy[0] &= ~(0x08 | 0x04); // clear the "has EXIF" and "has XMP" flags
      out.push(riffChunk('VP8X', copy));
    } else if (id === 'VP8 ' || id === 'VP8L') {
      const [w, h] = id === 'VP8 ' ? vp8Dims(data) : vp8lDims(data);
      if (!W) { W = w; H = h; checkDims(W, H); }
      else if (w !== W || h !== H) throw bad(); // the real picture must be exactly the size the header claims
      stills++;
      out.push(riffChunk(id, data));
    } else if (id === 'ALPH' || id === 'ICCP' || id === 'ANIM') {
      out.push(riffChunk(id, data));
    } else if (id === 'ANMF') {
      if (!W || !animated || data.length < 16) throw bad();
      const fx = 2 * u24(data, 0), fy = 2 * u24(data, 3), fw = 1 + u24(data, 6), fh = 1 + u24(data, 9);
      checkInside(fx, fy, fw, fh, W, H);
      const keep = [data.subarray(0, 16)];
      let image = 0;
      for (const sub of riffChunks(data, 16, data.length)) {
        if (sub.id === 'VP8 ' || sub.id === 'VP8L') {
          const [w, h] = sub.id === 'VP8 ' ? vp8Dims(sub.data) : vp8lDims(sub.data);
          if (w !== fw || h !== fh) throw bad();
          image++;
          keep.push(riffChunk(sub.id, sub.data));
        } else if (sub.id === 'ALPH') keep.push(riffChunk(sub.id, sub.data));
      }
      if (image !== 1) throw bad();
      frames++;
      totalPixels += fw * fh;
      checkFrames(frames, totalPixels);
      out.push(riffChunk('ANMF', Buffer.concat(keep)));
    }
    // any other chunk (EXIF, XMP, unknown/vendor) is dropped
  });
  if (stills + frames === 0 || (frames && stills)) throw bad();
  const body = Buffer.concat(out);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { ext: '.webp', buf: Buffer.concat([header, body]), width: W, height: H };
}

// ---------------- GIF ----------------
function gif(buf) {
  const head = buf.toString('latin1', 0, 6);
  if (buf.length < 14 || (head !== 'GIF87a' && head !== 'GIF89a')) throw bad();
  const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  const gct = buf[10] & 0x80 ? 3 * (1 << ((buf[10] & 7) + 1)) : 0;
  let pos = 13 + gct;
  if (pos > buf.length) throw bad();
  const out = [buf.subarray(0, pos)];
  const subBlocks = (p) => { // returns the position after the block terminator
    for (;;) {
      if (p >= buf.length) throw bad();
      const n = buf[p];
      p += 1 + n;
      if (n === 0) return p;
    }
  };
  let frames = 0, totalPixels = 0, done = false;
  while (pos < buf.length && !done) {
    const b = buf[pos];
    if (b === 0x3b) { out.push(buf.subarray(pos, pos + 1)); done = true; break; }
    if (b === 0x21) {
      if (pos + 2 > buf.length) throw bad();
      const label = buf[pos + 1];
      const end = subBlocks(pos + 2);
      let keep = label === 0xf9; // graphic control (frame timing/transparency)
      if (label === 0xff && buf[pos + 2] === 11 && /^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(buf.toString('latin1', pos + 3, pos + 14))) keep = true; // loop count
      if (keep) out.push(buf.subarray(pos, end));
      pos = end;
    } else if (b === 0x2c) {
      if (pos + 10 > buf.length) throw bad();
      const fx = buf.readUInt16LE(pos + 1), fy = buf.readUInt16LE(pos + 3), fw = buf.readUInt16LE(pos + 5), fh = buf.readUInt16LE(pos + 7);
      checkInside(fx, fy, fw, fh, w, h);
      frames++;
      totalPixels += fw * fh;
      checkFrames(frames, totalPixels);
      const lct = buf[pos + 9] & 0x80 ? 3 * (1 << ((buf[pos + 9] & 7) + 1)) : 0;
      const end = subBlocks(pos + 10 + lct + 1);
      out.push(buf.subarray(pos, end));
      pos = end;
    } else throw bad();
  }
  if (!done || !frames) throw bad();
  checkDims(w, h); // after the structure checks, so garbage gets "not a valid image", not "too many pixels"
  return { ext: '.gif', buf: Buffer.concat(out), width: w, height: h };
}

function sanitizeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw bad();
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf);
  if (buf[0] === 0x89 && buf[1] === 0x50) return png(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF') return webp(buf);
  if (buf.toString('latin1', 0, 3) === 'GIF') return gif(buf);
  throw bad();
}

module.exports = { sanitizeImage, MAX_SIDE, MAX_PIXELS, MAX_FRAMES };
