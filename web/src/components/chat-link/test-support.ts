// Test support for the chat-link component (T-513). For tests only: it reads K-09's and K-21's fixture files, so nothing
// the Worker loads may import this module. Every value here is a fixture's own placeholder or made up (rule 9).
//
// It holds the test-only QR decoder, copied from T-1120's spike (web/spikes/chat-link/decode.mjs, a minimal decoder
// for a clean module matrix: versions 1 to 6, level L, byte mode), never imported from the spike. Beside the spike's
// steps it checks what a scanning phone relies on, so a decoded text is the code's whole content: the format bits'
// own check bits, each block's error correction codewords, and the terminator and padding after the text, so no
// second segment can hide behind the first. readQrSvg reads the module matrix back from the SVG the component draws
// (qr-code.ts), so a test decodes the QR code as the page holds it.

import { readFileSync } from "node:fs";
import type { ToolApiV1 } from "../../../../contracts/generated/tool-api/tool-api.v1";
import { chatLinkOf, type ChatLinkFields, type IssueChatLinkResponse } from "./chat-link";

const K09_FIXTURES = new URL("../../../../contracts/tool-api/fixtures/", import.meta.url);

/** One K-09 v1 fixture of issueChatLink: its request paired with its outcome. */
export type IssueChatLinkExchange = Extract<ToolApiV1, { call: "issueChatLink" }>;

/** K-09 v1 issueChatLink's issued answer: the link, its QR text, the ready text and the short code. */
export type IssuedChatLink = Extract<IssueChatLinkResponse, { result: "issued" }>;

/** The K-09 fixture `file`, which must be an exchange of issueChatLink. */
export function issueChatLink(file: string): IssueChatLinkExchange {
  const read = JSON.parse(readFileSync(new URL(file, K09_FIXTURES), "utf8")) as { readonly call?: unknown };
  if (read.call !== "issueChatLink") throw new Error(`${file} is not an exchange of issueChatLink`);
  return read as IssueChatLinkExchange;
}

/** The K-09 fixture `file`'s outcome, which must be a response, not an error. */
export function responseOf(file: string): IssueChatLinkResponse {
  const { outcome } = issueChatLink(file);
  if ("error" in outcome) throw new Error(`${file}'s outcome is an error`);
  return outcome;
}

/** The K-09 fixture `file`'s outcome, which must be an issued chat link. */
export function issuedOf(file: string): IssuedChatLink {
  const response = responseOf(file);
  if (response.result !== "issued") throw new Error(`${file}'s outcome is not an issued chat link`);
  return response;
}

/** The chat-link fields of the K-09 fixture `file`, which must hold an issued chat link (chatLinkOf). */
export function fieldsOf(file: string): ChatLinkFields {
  const fields = chatLinkOf(issuedOf(file));
  if (fields === null) throw new Error(`${file} gives no chat link`);
  return fields;
}

/** The one item of `items`; throws when there is none or more than one. */
export function onlyOne<T>(items: readonly T[]): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined)
    throw new Error(`${String(items.length)} items where one was expected`);
  return item;
}

/** Text or an attribute's value as a browser reads it back from escapeHtml's output. */
export function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** One anchor of a page: its href and its text, each as a browser reads them. */
export interface Anchor {
  readonly href: string;
  readonly text: string;
}

/** Every anchor in `html`. */
export function anchorsOf(html: string): Anchor[] {
  return [...html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((match) => ({
    href: unescapeHtml(match[1] ?? ""),
    text: unescapeHtml(match[2] ?? ""),
  }));
}

/** Every inline SVG in `html`, whole. */
export function svgsOf(html: string): string[] {
  return [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((match) => match[0]);
}

/** The text a reader sees in `html`: its tags and their attributes taken out, each entity read back. */
export function visibleText(html: string): string {
  return unescapeHtml(html.replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<[^>]*>/g, " "));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the SVG back.

/** What readQrSvg reads from one SVG of qr-code.ts. */
export interface SvgQr {
  /** The modules, row by row, quiet zone off: true for a dark module. */
  readonly matrix: boolean[][];
  /** The light modules around the code on each side. */
  readonly quietZone: number;
  /** The modules on each side, quiet zone included: the viewBox's width and height. */
  readonly box: number;
  /** The width and height attributes, in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** The aria-label and the title, as a browser reads them. */
  readonly label: string;
  readonly title: string;
}

function attribute(svg: string, name: string): string {
  const value = new RegExp(`<svg [^>]*\\b${name}="([^"]*)"`).exec(svg)?.[1];
  if (value === undefined) throw new Error(`the SVG has no ${name}`);
  return unescapeHtml(value);
}

/**
 * The module matrix one SVG of qr-code.ts draws: a white square the size of its viewBox, then one black path made of
 * runs of dark modules, each "M<x>,<y>h<n>v1h-<n>z". Throws for an SVG drawn any other way, for a dark module outside
 * the viewBox, and for a quiet zone that is not light all round.
 */
export function readQrSvg(svg: string): SvgQr {
  const box = /^0 0 (\d+) (\d+)$/.exec(attribute(svg, "viewBox"));
  const size = Number(box?.[1]);
  if (box === null || box[1] !== box[2] || !(size > 0)) throw new Error("the SVG's viewBox is not a square");
  if (!svg.includes(`<rect width="${String(size)}" height="${String(size)}" fill="#fff"/>`))
    throw new Error("the SVG has no white square under the code");
  const paths = [...svg.matchAll(/<path fill="#000" d="([^"]*)"\/>/g)];
  const d = paths[0]?.[1];
  if (paths.length !== 1 || d === undefined) throw new Error("the SVG has not one black path");
  const runs = [...d.matchAll(/M(\d+),(\d+)h(\d+)v1h-(\d+)z/g)];
  if (runs.map((run) => run[0]).join("") !== d) throw new Error("the path holds more than runs of modules");

  const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (const run of runs) {
    const [x, y, length, back] = [run[1], run[2], run[3], run[4]].map(Number);
    const row = grid[y ?? -1];
    if (x === undefined || row === undefined || length === undefined || length < 1 || back !== length)
      throw new Error(`the run ${run[0]} is not one row's run`);
    if (x + length > size) throw new Error(`the run ${run[0]} leaves the viewBox`);
    row.fill(true, x, x + length);
  }

  // The quiet zone. Three finders put dark modules in the code's top-left, top-right and bottom-left corners, so the
  // dark modules span exactly the code: the same light margin on every side, and nothing dark in it.
  const dark = grid.flatMap((row, y) => row.flatMap((on, x) => (on ? [{ x, y }] : [])));
  if (dark.length === 0) throw new Error("the SVG draws no dark module");
  const xs = dark.map((cell) => cell.x);
  const ys = dark.map((cell) => cell.y);
  const quietZone = Math.min(...xs);
  const far = Math.max(...xs);
  if (Math.min(...ys) !== quietZone || Math.max(...ys) !== far || quietZone + far !== size - 1)
    throw new Error("the code does not sit square in its quiet zone");
  const inner = far - quietZone + 1;

  return {
    matrix: grid.slice(quietZone, quietZone + inner).map((row) => row.slice(quietZone, quietZone + inner)),
    quietZone,
    box: size,
    width: Number(attribute(svg, "width")),
    height: Number(attribute(svg, "height")),
    label: attribute(svg, "aria-label"),
    title: unescapeHtml(/<title>([^<]*)<\/title>/.exec(svg)?.[1] ?? ""),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The decoder (from web/spikes/chat-link/decode.mjs, T-1120).

/** A QR code's modules, row by row, quiet zone off: true for a dark module. */
export type Matrix = readonly (readonly boolean[])[];

/** The QR code version of a matrix: 1 for 21 by 21 modules, 4 more modules a side for each version up. */
export function versionOf(matrix: Matrix): number {
  return (matrix.length - 17) / 4;
}

/** Blocks and error correction codewords per block at level L, versions 1 to 6 (the spike's tables). */
const LEVEL_L: Readonly<Record<number, { readonly blocks: number; readonly ecc: number }>> = {
  1: { blocks: 1, ecc: 7 },
  2: { blocks: 1, ecc: 10 },
  3: { blocks: 1, ecc: 15 },
  4: { blocks: 1, ecc: 20 },
  5: { blocks: 1, ecc: 26 },
  6: { blocks: 2, ecc: 18 },
};

/** The eight mask patterns, by row and column: true where the mask flips a data module. */
const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The module at row r, column c; throws off the matrix. */
function moduleAt(matrix: Matrix, r: number, c: number): boolean {
  const dark = matrix[r]?.[c];
  if (dark === undefined) throw new Error(`no module at row ${String(r)}, column ${String(c)}`);
  return dark;
}

/** The fifteen format bits for five bits of level and mask: BCH(15,5), then the mask 0x5412. */
function formatBits(data: number): number {
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The centres of the alignment patterns on each axis (none in version 1). */
function alignmentCentres(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const centres = [6];
  for (let at = size - 7; centres.length < count; at -= step) centres.splice(1, 0, at);
  return centres;
}

/** Which modules are function patterns (finders, separators, format, timing, alignment) rather than data. */
function functionModules(version: number, size: number): boolean[][] {
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fill = (r0: number, c0: number, height: number, width: number): void => {
    for (let r = r0; r < r0 + height; r += 1) map[r]?.fill(true, c0, c0 + width);
  };
  fill(0, 0, 9, 9);
  fill(0, size - 8, 9, 8);
  fill(size - 8, 0, 8, 9);
  fill(6, 0, 1, size);
  fill(0, 6, size, 1);
  const centres = alignmentCentres(version, size);
  const last = centres.at(-1);
  for (const r of centres) {
    for (const c of centres) {
      const finder = (r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6);
      if (!finder) fill(r - 2, c - 2, 5, 5);
    }
  }
  return map;
}

/** x times y in GF(256) under the QR code's polynomial 0x11D. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The Reed-Solomon error correction codewords of `data`, `degree` of them, as the QR code makes them. */
function errorCorrection(data: readonly number[], degree: number): number[] {
  let divisor = [...new Array<number>(degree - 1).fill(0), 1];
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    const before = divisor;
    divisor = before.map((coefficient, j) => gfMultiply(coefficient, root) ^ (before[j + 1] ?? 0));
    root = gfMultiply(root, 2);
  }
  let remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder = [...remainder.slice(1), 0].map((value, j) => value ^ gfMultiply(divisor[j] ?? 0, factor));
  }
  return remainder;
}

/**
 * The text a clean QR code matrix holds (versions 1 to 6, level L, one byte-mode segment). Throws for anything else,
 * and for a code whose format bits, error correction codewords, terminator or padding do not check.
 */
export function decodeMatrix(matrix: Matrix): string {
  const size = matrix.length;
  const version = versionOf(matrix);
  const level = LEVEL_L[version];
  if (!Number.isInteger(version) || level === undefined || matrix.some((row) => row.length !== size))
    throw new Error(`unsupported size ${String(size)}`);

  // The format bits: 0 to 7 down column 8 beside the top-left finder, 8 to 14 up column 8 beside the bottom-left one.
  let bits = 0;
  for (let i = 0; i < 15; i += 1) {
    const r = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    if (moduleAt(matrix, r, 8)) bits |= 1 << i;
  }
  const data = (bits ^ 0x5412) >> 10;
  if (formatBits(data) !== bits) throw new Error("the format bits do not check");
  if (data >> 3 !== 1) throw new Error("the error correction level is not L");
  const mask = MASKS[data & 7];
  if (mask === undefined) throw new Error("no such mask");

  // The data modules in their zigzag order, two columns at a time from the right, unmasked.
  const isFunction = functionModules(version, size);
  const stream: boolean[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k += 1) {
      const r = upward ? size - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (isFunction[r]?.[c] === true) continue;
        stream.push(moduleAt(matrix, r, c) !== mask(r, c));
      }
    }
    upward = !upward;
  }
  const codewords = Array.from({ length: Math.floor(stream.length / 8) }, (_, i) =>
    stream.slice(i * 8, i * 8 + 8).reduce((byte, bit) => (byte << 1) | (bit ? 1 : 0), 0),
  );

  // The blocks: the data codewords interleaved, then the error correction codewords interleaved.
  const total = codewords.length;
  const shortCount = level.blocks - (total % level.blocks);
  const shortData = Math.floor(total / level.blocks) - level.ecc;
  const blocks = Array.from({ length: level.blocks }, (_, b) => ({
    data: new Array<number>(shortData + (b < shortCount ? 0 : 1)).fill(0),
    ecc: new Array<number>(level.ecc).fill(0),
  }));
  let next = 0;
  const take = (): number => {
    const codeword = codewords[next];
    if (codeword === undefined) throw new Error("the code ends early");
    next += 1;
    return codeword;
  };
  for (let i = 0; i <= shortData; i += 1)
    for (const block of blocks) if (i < block.data.length) block.data[i] = take();
  for (let i = 0; i < level.ecc; i += 1) for (const block of blocks) block.ecc[i] = take();
  for (const block of blocks) {
    if (errorCorrection(block.data, level.ecc).join(",") !== block.ecc.join(","))
      throw new Error("a block's error correction codewords do not check");
  }

  // One byte-mode segment, then the terminator, then the padding to the code's capacity.
  const bytes = blocks.flatMap((block) => block.data);
  const capacity = bytes.length * 8;
  const read = (from: number, count: number): number => {
    if (from + count > capacity) throw new Error("the segment runs past the code's capacity");
    let value = 0;
    for (let i = from; i < from + count; i += 1)
      value = (value << 1) | (((bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1);
    return value;
  };
  if (read(0, 4) !== 0b0100) throw new Error("not byte mode");
  const length = read(4, 8);
  const text = Array.from({ length }, (_, i) => read(12 + 8 * i, 8));
  let at = 12 + 8 * length;
  const terminator = Math.min(4, capacity - at);
  if (read(at, terminator) !== 0) throw new Error("another segment follows the text");
  at += terminator;
  const toByte = (8 - (at % 8)) % 8;
  if (read(at, toByte) !== 0) throw new Error("the bits after the terminator are not zero");
  at += toByte;
  for (let pad = 0xec; at < capacity; at += 8, pad ^= 0xec ^ 0x11)
    if (read(at, 8) !== pad) throw new Error("the padding is not the standard's");
  // Every byte as it is: a byte that is not UTF-8 fails, and a byte order mark is kept, never dropped.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(text));
}

/** The text the QR code of one SVG of qr-code.ts holds. */
export function decodeSvg(svg: string): string {
  return decodeMatrix(readQrSvg(svg).matrix);
}
