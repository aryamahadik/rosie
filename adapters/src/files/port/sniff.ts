// What a file's leading bytes show (T-437; K-13 v1 README "What checkUpload reads", default 8): checkUpload reads the
// stored object's type from its bytes, never from the browser's word or the Content-Type alone. The signatures are
// JPEG's, PNG's, WebP's, HEIC's and HEIF's (an ISO base media file's ftyp box and its brands) and PDF's. Nothing a
// browser runs as a page (SVG, HTML, XHTML) has a signature here, so none is ever taken.
//
// The double reads a stored object's first bytes with it; the R2 adapter (T-438) reads the first SNIFF_BYTES of the
// object with a ranged get and calls the same function, so both refuse the same files.

import type { UploadMediaType } from "./types";

/** How many leading bytes the check reads: enough for every signature and an ftyp box's first brands. */
export const SNIFF_BYTES = 64;

/** HEIC brands: HEVC-coded images and sequences (ISO/IEC 23008-12). */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
/** The generic HEIF brands, which name no coding. */
const HEIF_BRANDS = new Set(["mif1", "mif2", "msf1"]);
/** AVIF's brands, which also carry mif1: an AVIF is not a type K-13 takes. */
const AVIF_BRANDS = new Set(["avif", "avis"]);

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** An ISO base media file's brands, the major first, from its leading ftyp box; empty when it has none. */
function ftypBrands(bytes: Uint8Array): string[] {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return [];
  // The box's size, a big-endian 32-bit count that takes the box's own eight header bytes.
  const boxSize =
    (bytes[0] ?? 0) * 0x1000000 + (bytes[1] ?? 0) * 0x10000 + (bytes[2] ?? 0) * 0x100 + (bytes[3] ?? 0);
  if (boxSize < 16) return [];
  const end = Math.min(boxSize, bytes.length);
  // The major brand at 8, its version at 12, then the compatible brands, four bytes each.
  const brands = [ascii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, 4));
  return brands;
}

function heifFamily(bytes: Uint8Array): "image/heic" | "image/heif" | null {
  const brands = ftypBrands(bytes);
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "image/heic";
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return null;
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "image/heif";
  return null;
}

/** The upload type a file's leading bytes show, or null when they show none K-13 takes. */
export function sniffMediaType(leading: Uint8Array): UploadMediaType | null {
  if (startsWith(leading, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(leading, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // "RIFF", four bytes of size, then "WEBP".
  if (startsWith(leading, [0x52, 0x49, 0x46, 0x46]) && startsWith(leading, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  // "%PDF-".
  if (startsWith(leading, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return heifFamily(leading);
}

/**
 * True when the leading bytes show the type asked. HEIC and HEIF are one family here: a phone's HEIC photo often
 * carries the generic mif1 brand first, and a browser names either type for it, so either asked type takes either.
 */
export function bytesShowType(leading: Uint8Array, asked: UploadMediaType): boolean {
  const shown = sniffMediaType(leading);
  if (shown === null) return false;
  const heif = (type: UploadMediaType): boolean => type === "image/heic" || type === "image/heif";
  return heif(asked) ? heif(shown) : shown === asked;
}
