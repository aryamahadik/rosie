// The confirmation's QR code as a PNG (T-419; K-12 v1 README default 5: "The QR is drawn by the adapter from qrText as a
// PNG attached as chat-link-qr.png, since a plain-text email shows no image inline and v1 has no HTML part"; MC C9).
//
// The code's modules come from uqr (the root's pinned dependency, 0.1.3) at error correction M, and are drawn here as a
// black-and-white PNG (one bit a pixel, ISO/IEC 18004's quiet zone of 4 modules around it, 6 pixels a module). The image
// data is wrapped in zlib's stored blocks, not compressed, so the same qrText gives the same bytes on every runtime and
// every try: the email's body, and so its Resend idempotency key's request, never changes between tries (README 'Spike
// findings' row 2: the same key with another body is refused 409). About 11 kB for a chat link (294 pixels square).

import { encode } from "uqr";

/** Error correction M: up to 15% of the code can be lost, ample for a phone camera or a screen. */
export const QR_ECC = "M";
/** Pixels a module is drawn with. */
export const QR_SCALE = 6;
/** The quiet zone around the code, in modules (ISO/IEC 18004 asks for 4). */
export const QR_QUIET = 4;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most a stored deflate block holds (RFC 1951 section 3.2.4). */
const STORED_BLOCK = 0xffff;

let crcTable: Uint32Array | undefined;

/** CRC-32 as PNG's chunks use it (ISO 3309; PNG section 5.5). */
function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32, the checksum ending a zlib stream (RFC 1950). */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream (RFC 1950) of stored deflate blocks (RFC 1951): the bytes as they are, with their checksum. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / STORED_BLOCK));
  const out = new Uint8Array(2 + data.length + 5 * blocks + 4);
  const view = new DataView(out.buffer);
  // CMF 0x78 (deflate, a 32 kB window) and FLG 0x01 (no dictionary, level 0), whose 16 bits are a multiple of 31.
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let block = 0; block < blocks; block += 1) {
    const start = block * STORED_BLOCK;
    const length = Math.min(STORED_BLOCK, data.length - start);
    out[at] = block === blocks - 1 ? 1 : 0; // BFINAL on the last block; BTYPE 00, stored
    view.setUint16(at + 1, length, true);
    view.setUint16(at + 3, STORED_BLOCK - length, true);
    out.set(data.subarray(start, start + length), at + 5);
    at += 5 + length;
  }
  view.setUint32(at, adler32(data));
  return out;
}

/** One PNG chunk: its length, its type, its data and the CRC of type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The QR code of `text` as PNG bytes: dark modules black, the rest and the quiet zone white. Throws when uqr cannot encode it. */
export function qrPng(text: string): Uint8Array {
  const { data, size } = encode(text, { ecc: QR_ECC, border: 0 });
  const side = (size + 2 * QR_QUIET) * QR_SCALE;
  const rowBytes = Math.ceil(side / 8);
  // Each row: filter type 0 (none), then one bit a pixel, the leftmost in the high bit; 1 is white (colour type 0).
  const pixels = new Uint8Array((rowBytes + 1) * side);
  for (let y = 0; y < side; y += 1) {
    const row = data[Math.floor(y / QR_SCALE) - QR_QUIET];
    let at = y * (rowBytes + 1) + 1;
    for (let x0 = 0; x0 < side; x0 += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8 && x0 + bit < side; bit += 1) {
        const dark = row?.[Math.floor((x0 + bit) / QR_SCALE) - QR_QUIET] === true;
        if (!dark) byte |= 0x80 >>> bit;
      }
      pixels[at] = byte;
      at += 1;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  header[8] = 1; // bit depth
  header[9] = 0; // colour type: greyscale
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method 0
  header[12] = 0; // no interlace
  return concat([
    Uint8Array.from(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(pixels)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Bytes as base64, as Resend's attachment `content` takes them (README 'Spike findings' row 1). */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}
