// Minimal QR decoder for a clean module matrix: versions 1-6, ECC level L, byte mode.
// No error correction (the matrix is clean).

const ECC_PER_BLOCK_L = [0, 7, 10, 15, 20, 26, 18];
const BLOCKS_L = [0, 1, 1, 1, 1, 1, 2];

/** Reads <path d="M x,y h1v1h-1z ..."> of an SVG made with pixelSize 1 into a boolean matrix. */
export function matrixFromSvg(svg) {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vb) throw new Error("no viewBox");
  const total = Number(vb[1]);
  const d = /<path[^>]* d="([^"]*)"/.exec(svg)?.[1] ?? "";
  const cells = [...d.matchAll(/M(\d+),(\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (cells.length === 0) throw new Error("no dark modules");
  const border = Math.min(...cells.map(([x]) => x));
  const size = total - 2 * border;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  for (const [x, y] of cells) grid[y - border][x - border] = true;
  return grid;
}

function alignmentCentres(version, size) {
  if (version === 1) return [];
  const num = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + num * 3 + 5) / (num * 4 - 4)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < num; p -= step) pos.splice(1, 0, p);
  return pos;
}

function functionMap(version, size) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const fill = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) f[r][c] = true;
  };
  fill(0, 0, 9, 9);
  fill(0, size - 8, 9, 8);
  fill(size - 8, 0, 8, 9);
  fill(6, 0, 1, size);
  fill(0, 6, size, 1);
  const pos = alignmentCentres(version, size);
  for (const r of pos) {
    for (const c of pos) {
      const corner = (r === 6 && c === 6) || (r === 6 && c === pos.at(-1)) || (r === pos.at(-1) && c === 6);
      if (!corner) fill(r - 2, c - 2, 5, 5);
    }
  }
  return f;
}

export function decodeMatrix(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 6) {
    throw new Error(`unsupported size ${size}`);
  }
  // Format information (first copy): row/col 8 next to the top-left finder.
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const r = i < 6 ? i : i < 8 ? i + 1 : size - 15 + i;
    if (m[r][8]) bits |= 1 << i;
  }
  const format = bits ^ 0x5412;
  if (format >> 13 !== 1) throw new Error("ECC level is not L");
  const mask = (format >> 10) & 7;
  const maskFn = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][mask];
  const isFn = functionMap(version, size);

  // Walk the data modules in zigzag order, unmasking.
  const stream = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k++) {
      const r = upward ? size - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (isFn[r][c]) continue;
        stream.push(m[r][c] !== maskFn(r, c));
      }
    }
    upward = !upward;
  }
  const total = Math.floor(stream.length / 8);
  const cw = [];
  for (let i = 0; i < total; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (stream[i * 8 + j] ? 1 : 0);
    cw.push(b);
  }

  // De-interleave blocks.
  const nb = BLOCKS_L[version];
  const ecc = ECC_PER_BLOCK_L[version];
  const shortCount = nb - (total % nb);
  const shortData = Math.floor(total / nb) - ecc;
  const blocks = Array.from({ length: nb }, (_, i) => new Array(shortData + (i < shortCount ? 0 : 1)));
  let k = 0;
  for (let i = 0; i <= shortData; i++) {
    for (let b = 0; b < nb; b++) {
      if (i < blocks[b].length) blocks[b][i] = cw[k++];
    }
  }
  const data = blocks.flat();

  // Byte mode.
  const bitAt = (i) => (data[i >> 3] >> (7 - (i & 7))) & 1;
  const read = (pos, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bitAt(pos + i);
    return v;
  };
  if (read(0, 4) !== 0b0100) throw new Error("not byte mode");
  const len = read(4, 8);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = read(12 + 8 * i, 8);
  return new TextDecoder().decode(out);
}

export const decodeSvg = (svg) => decodeMatrix(matrixFromSvg(svg));
