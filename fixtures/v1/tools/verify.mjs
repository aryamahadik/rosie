#!/usr/bin/env node
// T-002: verify fixture set v1 (C-027). Plain Node, no dependencies.
//
//   node fixtures/v1/tools/verify.mjs                      check every committed fixture file against MANIFEST.sha256
//   node fixtures/v1/tools/verify.mjs <fresh copy>         also check the master inputs in a fresh copy against INPUTS.sha256
//   node fixtures/v1/tools/verify.mjs --compare <dir>      also compare a rebuild's output (forms/, test-kit/, PROFESSION-MAP.md)
//                                                          with the committed files, ignoring the three date lines
//   node fixtures/v1/tools/verify.mjs --write <fresh copy> write MANIFEST.sha256 and INPUTS.sha256 from the files now in
//                                                          fixtures/v1 and the copy (used once per rebuild; never edit by hand)
//   --root <dir>                                           use this folder as fixtures/v1 (the tests use a temporary copy)
//
// Exit code: 0 everything checked matched, 1 a check failed, 2 the command line is wrong.
//
// What the manifest covers: every file under forms/ and test-kit/, and PROFESSION-MAP.md. A changed byte, a missing file
// or a file the manifest does not list fails. The only other entries allowed in the folder are MANIFEST.sha256,
// INPUTS.sha256, KNOWN-STALE.md, README.md, patch/ and tools/.
//
// INPUTS.sha256 lines: "<sha256>  <path>". A path starting "./" is inside fixtures/v1 (the patch and the rebuild script)
// and is always checked. Any other path is inside the fresh copy of the master and is checked when a copy is given.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKED_TOP = ["forms", "test-kit"];
const TRACKED_FILE = "PROFESSION-MAP.md";
const OTHER_TOP = ["MANIFEST.sha256", "INPUTS.sha256", "KNOWN-STALE.md", "README.md", "patch", "tools"];
// The three lines the rebuild stamps with the time of day (Q-36). They are line 3 of each file.
const DATE_FILES = ["PROFESSION-MAP.md", "test-kit/COVERAGE.md", "test-kit/SCENARIOS.md"];
const DATE_RE =
  /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}(:\d{2})?/;
// Inputs of the rebuild that live in the fresh copy (paths relative to the copy's top folder).
const COPY_INPUTS = [
  "engine/work/master/master-A.json",
  "engine/work/master/master-B.json",
  "engine/work/phase4/tools/test-kit.js",
  "engine/work/phase4/tools/frontend-map.js",
  "engine/work/phase4/waves.json",
  "FRONTEND-SPEC.md",
];
const PROF_DIR = "engine/work/prof";
const PROF_RE = /^[a-z0-9-]+\.json$/; // the same filter test-kit.js uses
const LOCAL_INPUTS = ["./patch/G1-G3.patch", "./tools/rebuild.sh"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** All regular files under dir, as posix paths relative to base. A symbolic link is an error. */
function walk(base, dir, out, problems) {
  for (const name of readdirSync(path.join(base, dir)).sort(byCodePoint)) {
    const rel = dir === "" ? name : `${dir}/${name}`;
    const st = lstatSync(path.join(base, rel));
    if (st.isSymbolicLink()) problems.push(`symbolic link not allowed: ${rel}`);
    else if (st.isDirectory()) walk(base, rel, out, problems);
    else if (st.isFile()) out.push(rel);
  }
}

function exists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The files the manifest must cover, in the folder: forms/**, test-kit/** and PROFESSION-MAP.md. */
function trackedFiles(root, problems) {
  const out = [];
  for (const top of TRACKED_TOP) {
    if (exists(path.join(root, top))) walk(root, top, out, problems);
    else problems.push(`missing folder: ${top}/`);
  }
  if (exists(path.join(root, TRACKED_FILE))) out.push(TRACKED_FILE);
  else problems.push(`missing file: ${TRACKED_FILE}`);
  return out.sort(byCodePoint);
}

/** Reads a "<sha256>  <path>" file into [[hash, path], ...]. */
function readHashFile(file, problems) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    problems.push(`cannot read ${path.basename(file)}`);
    return [];
  }
  const rows = [];
  const seen = new Set();
  text.split("\n").forEach((line, i) => {
    if (line === "") return;
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!m) return void problems.push(`${path.basename(file)} line ${String(i + 1)} is not "<sha256>  <path>"`);
    const rel = m[2];
    const unsafe = path.isAbsolute(rel) || rel.split("/").includes("..");
    if (unsafe) return void problems.push(`${path.basename(file)} line ${String(i + 1)}: unsafe path ${rel}`);
    if (seen.has(rel)) return void problems.push(`${path.basename(file)} lists ${rel} twice`);
    seen.add(rel);
    rows.push([m[1], rel]);
  });
  if (rows.length === 0) problems.push(`${path.basename(file)} lists no file`);
  return rows;
}

function hashOf(file) {
  try {
    return sha256(readFileSync(file));
  } catch {
    return null;
  }
}

/** Check 1: the committed files against MANIFEST.sha256. Returns the number of files checked. */
function checkManifest(root, problems) {
  const rows = readHashFile(path.join(root, "MANIFEST.sha256"), problems);
  const listed = new Set(rows.map(([, rel]) => rel));
  for (const [hash, rel] of rows) {
    const got = hashOf(path.join(root, rel));
    if (got === null) problems.push(`listed but missing: ${rel}`);
    else if (got !== hash) problems.push(`changed: ${rel}`);
  }
  for (const rel of trackedFiles(root, problems)) if (!listed.has(rel)) problems.push(`not in the manifest: ${rel}`);
  const sorted = rows.map(([, rel]) => rel);
  if (sorted.some((rel, i) => i > 0 && byCodePoint(sorted[i - 1], rel) >= 0)) {
    problems.push("MANIFEST.sha256 is not sorted by path");
  }
  for (const rel of listed) {
    const top = rel.split("/")[0];
    if (!TRACKED_TOP.includes(top) && rel !== TRACKED_FILE) problems.push(`manifest lists a path outside the set: ${rel}`);
  }
  // Nothing else may sit in the folder.
  for (const name of readdirSync(root)) {
    if (!TRACKED_TOP.includes(name) && name !== TRACKED_FILE && !OTHER_TOP.includes(name)) {
      problems.push(`unexpected entry in the folder: ${name}`);
    }
  }
  return rows.length;
}

/** Check 2: line 3 of the three date-stamped files still looks like a date line. */
function checkDateLines(root, problems) {
  const lines = [];
  for (const rel of DATE_FILES) {
    const line = (hashOf(path.join(root, rel)) === null ? "" : readFileSync(path.join(root, rel), "utf8").split("\n")[2]) ?? "";
    if (DATE_RE.test(line)) lines.push(`${rel} line 3: ${line.match(DATE_RE)[0]}`);
    else problems.push(`${rel} line 3 has no date`);
  }
  return lines;
}

function profFiles(copy) {
  return readdirSync(path.join(copy, PROF_DIR)).filter((f) => PROF_RE.test(f)).sort(byCodePoint);
}

/** The inputs that are hashed: copy-relative paths, and "./" paths inside fixtures/v1. */
function inputPaths(copy) {
  return [...COPY_INPUTS, ...profFiles(copy).map((f) => `${PROF_DIR}/${f}`)].concat(LOCAL_INPUTS);
}

/** Check 3: INPUTS.sha256. The "./" lines always; the copy's lines when a copy is given. */
function checkInputs(root, copy, problems) {
  const rows = readHashFile(path.join(root, "INPUTS.sha256"), problems);
  let local = 0;
  let inCopy = 0;
  for (const [hash, rel] of rows) {
    if (rel.startsWith("./")) {
      local++;
      const got = hashOf(path.join(root, rel));
      if (got === null) problems.push(`input missing: ${rel}`);
      else if (got !== hash) problems.push(`input changed: ${rel}`);
    } else if (copy !== undefined) {
      inCopy++;
      const got = hashOf(path.join(copy, rel));
      if (got === null) problems.push(`input missing in the copy: ${rel}`);
      else if (got !== hash) problems.push(`input differs in the copy: ${rel}`);
    }
  }
  if (copy !== undefined) {
    const listed = new Set(rows.map(([, rel]) => rel));
    for (const f of profFiles(copy)) {
      if (!listed.has(`${PROF_DIR}/${f}`)) problems.push(`trade file in the copy not in INPUTS.sha256: ${f}`);
    }
    for (const rel of COPY_INPUTS) if (!listed.has(rel)) problems.push(`INPUTS.sha256 lacks ${rel}`);
  }
  return { local, inCopy };
}

const maskDate = (rel, buf) => {
  if (!DATE_FILES.includes(rel)) return sha256(buf);
  const lines = buf.toString("utf8").split("\n");
  lines[2] = (lines[2] ?? "").replace(DATE_RE, "<DATE>");
  return sha256(Buffer.from(lines.join("\n"), "utf8"));
};

/** Check 4: a rebuild's output against the committed files, apart from the three date lines. */
function compareRebuild(root, other, problems) {
  const mine = trackedFiles(root, problems);
  const theirs = trackedFiles(other, problems);
  const mineSet = new Set(mine);
  const theirSet = new Set(theirs);
  for (const rel of mine) if (!theirSet.has(rel)) problems.push(`in the commit, not in the rebuild: ${rel}`);
  for (const rel of theirs) if (!mineSet.has(rel)) problems.push(`in the rebuild, not in the commit: ${rel}`);
  for (const rel of mine) {
    if (!theirSet.has(rel)) continue;
    const a = maskDate(rel, readFileSync(path.join(root, rel)));
    const b = maskDate(rel, readFileSync(path.join(other, rel)));
    if (a !== b) problems.push(`rebuild differs: ${rel}`);
  }
  return mine.length;
}

function writeHashes(root, copy, problems) {
  const files = trackedFiles(root, problems);
  const manifest = files.map((rel) => `${sha256(readFileSync(path.join(root, rel)))}  ${rel}\n`).join("");
  const inputs = inputPaths(copy)
    .map((rel) => {
      const base = rel.startsWith("./") ? root : copy;
      return `${sha256(readFileSync(path.join(base, rel)))}  ${rel}\n`;
    })
    .join("");
  if (problems.length === 0) {
    writeFileSync(path.join(root, "MANIFEST.sha256"), manifest);
    writeFileSync(path.join(root, "INPUTS.sha256"), inputs);
  }
  return files.length;
}

function main(argv) {
  let root = path.resolve(HERE, "..");
  let copy;
  let compare;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" || a === "--compare") {
      const value = argv[++i];
      if (value === undefined) return usage(`${a} needs a folder`);
      if (a === "--root") root = path.resolve(value);
      else compare = path.resolve(value);
    } else if (a === "--write") write = true;
    else if (a.startsWith("--")) return usage(`unknown option ${a}`);
    else if (copy === undefined) copy = path.resolve(a);
    else return usage("more than one fresh copy given");
  }
  if (write && copy === undefined) return usage("--write needs the fresh copy");
  if (copy !== undefined && !exists(path.join(copy, PROF_DIR))) return usage(`not a master copy: ${copy}`);

  const problems = [];
  if (write) {
    const n = writeHashes(root, copy, problems);
    if (problems.length === 0) console.log(`wrote MANIFEST.sha256 (${String(n)} files) and INPUTS.sha256`);
  }
  const files = checkManifest(root, problems);
  console.log(`manifest: ${String(files)} files listed`);
  for (const line of checkDateLines(root, problems)) console.log(`date line: ${line}`);
  const inputs = checkInputs(root, copy, problems);
  console.log(`inputs: ${String(inputs.local)} in this folder checked`);
  if (copy === undefined) console.log("inputs: no fresh copy given, so the master files were not checked");
  else console.log(`inputs: ${String(inputs.inCopy)} in the fresh copy checked`);
  if (compare !== undefined) {
    const n = compareRebuild(root, compare, problems);
    console.log(`rebuild: ${String(n)} files compared, apart from the three date lines`);
  }
  if (problems.length > 0) {
    console.error(`FAIL: ${String(problems.length)} problem(s)`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    if (problems.length > 40) console.error(`  ... and ${String(problems.length - 40)} more`);
    return 1;
  }
  console.log("OK");
  return 0;
}

function usage(message) {
  console.error(`verify: ${message}`);
  console.error("usage: node fixtures/v1/tools/verify.mjs [<fresh copy>] [--compare <rebuilt dir>] [--root <dir>] | --write <fresh copy>");
  return 2;
}

process.exitCode = main(process.argv.slice(2));
