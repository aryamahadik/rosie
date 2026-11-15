// T-513's QR code (qr-code.ts) and the test-only decoder that proves it (test-support.ts, copied from T-1120's
// web/spikes/chat-link/decode.mjs): the decoder reads both K-09 v1 chat links exactly, from uqr's own module matrix and
// from the SVG the component draws; the QR's options, named in qr-code.ts, hold (level L, versions 5 and 4 for those
// two links, a quiet zone of 4 modules, 4 CSS pixels a module); and the decoder refuses a code it cannot vouch for, so
// a decoded text is the code's whole content.
//
// Every value is a K-09 fixture's own placeholder or made up, and the one phone number is the fixtures' fiction-range
// placeholder for Rosie's line (Q-51), written whole (rule 9).
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { QR_MODULE_PIXELS, QR_OPTIONS, qrSvg } from "./qr-code";
import { decodeMatrix, decodeSvg, issuedOf, readQrSvg, versionOf } from "./test-support";

/** K-09 v1's two issued chat links: Ben's booking link and Riley's staff join link. */
const BOOKING = issuedOf("chat-link-after-contact-add.json");
const STAFF = issuedOf("staff-join-link.json");

/** uqr's own module matrix for `text` under QR_OPTIONS at error correction level `ecc`, its quiet zone taken off. */
function uqrMatrix(text: string, ecc: "L" | "M" = "L"): boolean[][] {
  const zone = QR_OPTIONS.border;
  return encode(text, { ...QR_OPTIONS, ecc })
    .data.slice(zone, -zone)
    .map((row) => row.slice(zone, -zone));
}

describe("the test-only decoder reads both K-09 v1 chat links exactly", () => {
  it.each([
    ["chat-link-after-contact-add.json", BOOKING.qrText],
    ["staff-join-link.json", STAFF.qrText],
  ])("%s: from uqr's own matrix and from the SVG the component draws", (_file, qrText) => {
    expect(decodeMatrix(uqrMatrix(qrText))).toBe(qrText);
    expect(decodeSvg(qrSvg(qrText, "A made-up label"))).toBe(qrText);
  });
});

describe("the QR's options, as qr-code.ts names them", () => {
  it("level L, never raised, and the smallest version that holds the text", () => {
    expect(QR_OPTIONS).toEqual({ ecc: "L", boostEcc: false, minVersion: 1, maxVersion: 40, border: 4 });
  });

  it("K-09's two chat links come out at versions 5 and 4, inside the decoder's versions 1 to 6", () => {
    expect([BOOKING.qrText.length, STAFF.qrText.length]).toEqual([92, 71]);
    expect(encode(BOOKING.qrText, QR_OPTIONS).version).toBe(5);
    expect(encode(STAFF.qrText, QR_OPTIONS).version).toBe(4);
    expect(versionOf(readQrSvg(qrSvg(BOOKING.qrText, "A made-up label")).matrix)).toBe(5);
    expect(versionOf(readQrSvg(qrSvg(STAFF.qrText, "A made-up label")).matrix)).toBe(4);
  });

  it("a quiet zone of 4 light modules on every side, drawn at 4 CSS pixels a module", () => {
    const qr = readQrSvg(qrSvg(BOOKING.qrText, "A made-up label"));
    expect(qr.quietZone).toBe(4);
    expect(qr.matrix).toHaveLength(37);
    expect(qr.box).toBe(37 + 2 * 4);
    expect(QR_MODULE_PIXELS).toBe(4);
    expect([qr.width, qr.height]).toEqual([45 * 4, 45 * 4]);
  });

  it("a longer link still gets its code, at a higher version this decoder does not read", () => {
    // Made up: a link of 222 bytes, past version 6's 134 at level L.
    const long = `sms:+15555550188&body=${"x".repeat(200)}`;
    const qr = readQrSvg(qrSvg(long, "A made-up label"));
    expect(versionOf(qr.matrix)).toBe(9);
    expect(() => decodeMatrix(qr.matrix)).toThrow("unsupported size 53");
  });
});

describe("the decoder refuses a code it cannot vouch for", () => {
  it("another error correction level", () => {
    expect(() => decodeMatrix(uqrMatrix(BOOKING.qrText, "M"))).toThrow("the error correction level is not L");
  });

  it("a data module flipped: the block's error correction codewords no longer check", () => {
    const matrix = uqrMatrix(BOOKING.qrText);
    const last = matrix.length - 1;
    // The bottom-right module is always data: the first bit of the first codeword.
    const flipped = matrix.map((row, r) => row.map((dark, c) => (r === last && c === last ? !dark : dark)));
    expect(() => decodeMatrix(flipped)).toThrow("a block's error correction codewords do not check");
  });

  it("a format bit flipped: the format bits no longer check", () => {
    const flipped = uqrMatrix(BOOKING.qrText).map((row, r) =>
      row.map((dark, c) => (r === 0 && c === 8 ? !dark : dark)),
    );
    expect(() => decodeMatrix(flipped)).toThrow("the format bits do not check");
  });

  it("an SVG with a dark module in its quiet zone", () => {
    const svg = qrSvg(BOOKING.qrText, "A made-up label").replace('d="', 'd="M0,0h1v1h-1z');
    expect(() => readQrSvg(svg)).toThrow("the code does not sit square in its quiet zone");
  });
});
