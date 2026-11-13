// The phone scan (T-1317): T-1304's number reader, widened from the deploy config and scripts to every tracked
// file. The repository is public (DL-436) and no real phone number goes in it (DL-542, DL-581), so
// phone-scan.test.mjs (`npm run test:ci-scripts`) reads every file `git ls-files` lists and fails on any phone
// number outside the fiction ranges: +1, an area code, then 555-0100 to 555-0199, as adapters/src/shared/samples.ts
// and the Linq double read it, and Ofcom's UK numbers for drama (DL-616). A hit is named by its file and line, never
// by its number. The deliberate inputs a file holds outside the ranges are listed in phone-scan-exceptions.mjs, each
// with its file and why it is no real number, and pass only at that file. Not a test file itself;
// wrangler-env.test.mjs and rosfield-test-route.test.mjs read numbers with it too.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

/** The +1 fiction range, in E.164: +1, an area code, then 555-0100 to 555-0199. */
export const FICTIONAL_PHONE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;

/**
 * Ofcom's UK numbers for drama, which it gives to no line: [area, first, last], in national form as Ofcom's table
 * writes them, each block a thousand numbers. Written with a leading 0, so the scan reads none of them. Northern
 * Ireland has no block here: the one the table gave was reallocated for real use, and Ofcom's current one cannot be
 * confirmed from its own page (DL-632), so a Northern Ireland number fails like any other.
 */
export const OFCOM_DRAMA = [
  ["Leeds", "0113 496 0000", "0113 496 0999"],
  ["Sheffield", "0114 496 0000", "0114 496 0999"],
  ["Nottingham", "0115 496 0000", "0115 496 0999"],
  ["Leicester", "0116 496 0000", "0116 496 0999"],
  ["Bristol", "0117 496 0000", "0117 496 0999"],
  ["Reading", "0118 496 0000", "0118 496 0999"],
  ["Birmingham", "0121 496 0000", "0121 496 0999"],
  ["Edinburgh", "0131 496 0000", "0131 496 0999"],
  ["Glasgow", "0141 496 0000", "0141 496 0999"],
  ["Liverpool", "0151 496 0000", "0151 496 0999"],
  ["Manchester", "0161 496 0000", "0161 496 0999"],
  ["Tyneside, Durham and Wearside", "0191 498 0000", "0191 498 0999"],
  ["London", "020 7946 0000", "020 7946 0999"],
  ["Cardiff", "029 2018 0000", "029 2018 0999"],
  ["no area", "01632 960000", "01632 960999"],
  ["mobile", "07700 900000", "07700 900999"],
  ["UK-wide", "0306 999 0000", "0306 999 0999"],
  ["freephone", "0808 157 0000", "0808 157 0999"],
  ["premium rate", "0909 879 0000", "0909 879 0999"],
];

const DRAMA_BLOCKS = OFCOM_DRAMA.map(([, first, last]) => [first, last].map((n) => n.replace(/[^0-9]/g, "")));

/**
 * Whether a number, in E.164 form, is in a fiction range: the +1 block, or one of Ofcom's drama blocks (+44, then
 * a national number without its 0, ten digits).
 */
export function isFiction(number) {
  if (FICTIONAL_PHONE.test(number)) return true;
  if (!/^\+44[0-9]{10}$/.test(number)) return false;
  const national = `0${number.slice(3)}`;
  return DRAMA_BLOCKS.some(([first, last]) => first <= national && national <= last);
}

// The ways a number is written: a + and 7 to 15 digits, with spaces, dots, dashes or brackets between them; or a
// North American number without the +: an area code (bracketed or not), an exchange and a line, with a 1 or none.
// A URL-encoded plus, %2B (or %2b), is a + (T-1332).
//
// Where a number starts and ends. T-1304 reads no id as a number: a number starts only where no letter or digit
// stands right before it, so never inside a hex id, a base64 blob, a sum or a longer run of digits, and ends only
// where no digit follows; a North American number never starts right after a + (the + form reads that one) and
// never ends right before a letter. T-1332 keeps each of those cases and reads two more (T-1317's security note b):
//   - a number right after an escape or a URL-encoded character, whose last letter or digit ends no word: a
//     backslash and b, f, n, r, t or v (as JSON writes a newline, \n), or % and two hex digits (as %0A, %20 or %3A).
//     An escape that hex digits follow, as \u or \x, starts no number, and a North American number never starts
//     right after %2B, the + form's own plus;
//   - a separated North American number right before a letter: its area code bracketed, or a space, dot or dash
//     between its groups. Ten digits in a row right before a letter stay an id's digits.
const START = String.raw`(?:(?<![0-9A-Za-z])|(?<=\\[bfnrtv])|(?<=%[0-9A-Fa-f]{2}))`;
/** A North American area code or exchange (neither starts with 0 or 1), the separator between groups, a line. */
const CODE = "[2-9][0-9]{2}";
const SEP = "[ .-]";
const LINE = "[0-9]{4}";
const SEPARATED = String.raw`(?:(?:\(${CODE}\)${SEP}?|${CODE}${SEP})${CODE}${SEP}?|${CODE}${CODE}${SEP})${LINE}(?![0-9])`;
const IN_A_ROW = `${CODE}${CODE}${LINE}(?![0-9A-Za-z])`;

/** The + form: its digits, from the first after the plus, are the match's group 1. */
export const PLUS_FORM = new RegExp(
  String.raw`${START}(?:\+|%2[Bb])([1-9](?:[ ().-]{0,2}[0-9]){6,14})(?![0-9])`,
  "g",
);
export const NANP_FORM = new RegExp(
  String.raw`${START}(?<!\+|%2[Bb])(?:1${SEP}?)?(?:${SEPARATED}|${IN_A_ROW})`,
  "g",
);

/** Each number a text holds, in E.164 form, with the index it starts at: the + forms first, then the others. */
function readings(text) {
  const found = [];
  for (const match of text.matchAll(PLUS_FORM)) {
    found.push({ index: match.index, number: `+${match[1].replace(/[^0-9]/g, "")}` });
  }
  for (const match of text.matchAll(NANP_FORM)) {
    found.push({ index: match.index, number: `+1${match[0].replace(/[^0-9]/g, "").slice(-10)}` });
  }
  return found;
}

/** Every phone number a line holds, each once, in E.164 form. */
export function phoneNumbersIn(line) {
  return [...new Set(readings(line).map((reading) => reading.number))];
}

/** A listed number ("+1_055_555_0142") in E.164 form. */
export function listedNumber(listed) {
  return `+${listed.replace(/[^0-9]/g, "")}`;
}

/** The 1-based lines of the indexes in text, each once, in order. */
function linesOf(text, indexes) {
  if (indexes.length === 0) return [];
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lines = new Set();
  for (const index of indexes) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    lines.add(low + 1);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Scans [name, text] entries against the exceptions ({ file, kind, numbers, why }: each listed number passes at
 * that file only). Returns `hits`, "<file>:<line>" for each line holding a number outside the fiction ranges that
 * its file does not list (in entry order, then line order), and `stale`, "<file>: <listed number>" for each listed
 * number its file no longer holds.
 */
export function scanTexts(entries, exceptions = []) {
  const allowed = new Map();
  const listed = [];
  for (const { file, numbers } of exceptions) {
    const own = allowed.get(file) ?? new Map();
    for (const number of numbers) {
      const key = `${file}: ${number}`;
      own.set(listedNumber(number), key);
      listed.push(key);
    }
    allowed.set(file, own);
  }
  const used = new Set();
  const hits = [];
  for (const [name, text] of entries) {
    const own = allowed.get(name);
    const outside = [];
    for (const { index, number } of readings(text)) {
      if (isFiction(number)) continue;
      const key = own?.get(number);
      if (key === undefined) outside.push(index);
      else used.add(key);
    }
    for (const line of linesOf(text, outside)) hits.push(`${name}:${line}`);
  }
  return { hits, stale: listed.filter((key) => !used.has(key)) };
}

/** "<file>:<line>" for each line of the files (name to text) that holds a number outside the fiction ranges. */
export function outsideFiction(files, exceptions = []) {
  return scanTexts(Object.entries(files), exceptions).hits;
}

/** The paths `git ls-files` lists in repo, as git keeps them (no quoting). */
export function trackedFiles(repo) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 1024 ** 3 });
  if (result.error) throw new Error(`could not run git ls-files: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${String(result.stderr).trim() || `exit code ${result.status}`}`);
  }
  return result.stdout.split("\0").filter((file) => file !== "");
}

/**
 * A tracked file's text as git keeps it: a symbolic link's own target path (never the file it points to), and
 * null for a folder (a submodule) or a file gone from the working tree.
 */
export function trackedText(repo, file) {
  const full = path.join(repo, file);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return readlinkSync(full, "utf8");
  if (!stat.isFile()) return null;
  return readFileSync(full, "utf8");
}

/** Scans every file `git ls-files` lists in repo: { hits, stale } as scanTexts gives them, and how many files. */
export function scanRepository(repo, exceptions = []) {
  const files = trackedFiles(repo);
  function* entries() {
    for (const file of files) {
      const text = trackedText(repo, file);
      if (text !== null) yield [file, text];
    }
  }
  return { ...scanTexts(entries(), exceptions), files: files.length };
}
