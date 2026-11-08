// Fixture set v1, opened for a seed (C-155; T-200; build prompt rule 9): every read stays inside the repository's
// fixtures/ folder, and the whole set is checked against its sha256 manifest before anything is loaded.
//
//   const verified = verifyFixtureSet(openFixtureSet());   // fixtures/v1; throws before any load on a mismatch
//   for (const file of filesUnder(verified, "test-kit/shops/")) { ... file.bytes ... }
//
// The manifest is T-002's fixtures/v1/MANIFEST.sha256 ("<sha256>  <path>" lines, as `shasum -a 256 -c` reads them; the
// set's SHA256SUMS). The check is the first one of fixtures/v1/tools/verify.mjs: every listed file has its hash, and
// every file under forms/ and test-kit/, and PROFESSION-MAP.md, is listed. A seed then parses only the bytes that were
// hashed, so no file can change between the check and the load.
//
// What is refused, as FixtureAccessError, before the file is read: a set folder outside fixtures/ (after every symbolic
// link in its path is resolved, so an intact copy elsewhere is refused too); a manifest path that is absolute, holds a
// `..` or `.` step or a backslash; a symbolic link anywhere in the set; a file whose real location is outside the set.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's fixtures/ folder. No seed reads outside it. */
export const FIXTURES_DIR = path.resolve(fileURLToPath(new URL("../../../fixtures/", import.meta.url)));
/** Fixture set v1 (C-027; T-002): the 243 demo shops, test-mixed-A and test-mixed-B, and the owner forms. */
export const FIXTURE_SET_V1_DIR = path.join(FIXTURES_DIR, "v1");
/** The set's sha256 manifest (T-002). */
export const MANIFEST_FILE = "MANIFEST.sha256";

// What the manifest covers (T-002: fixtures/v1/tools/verify.mjs, TRACKED_TOP and TRACKED_FILE).
const TRACKED_DIRS = ["forms", "test-kit"] as const;
const TRACKED_FILES = ["PROFESSION-MAP.md"] as const;
const MANIFEST_LINE = /^([0-9a-f]{64}) {2}(\S.*)$/;
const PROBLEMS_IN_MESSAGE = 10;

/** A read that would leave the fixture set, or leave fixtures/: refused before the file is read. */
export class FixtureAccessError extends Error {
  override readonly name = "FixtureAccessError";
}

/** The set does not match its manifest. `problems` lists every mismatch found, one line each. */
export class FixtureChecksumError extends Error {
  override readonly name = "FixtureChecksumError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const shown = problems.slice(0, PROBLEMS_IN_MESSAGE).join("; ");
    const more =
      problems.length > PROBLEMS_IN_MESSAGE
        ? ` (and ${String(problems.length - PROBLEMS_IN_MESSAGE)} more)`
        : "";
    super(`the fixture set does not match ${MANIFEST_FILE}, so nothing was loaded: ${shown}${more}`);
    this.problems = problems;
  }
}

/** A fixture set opened for reading. Both paths are real paths (every symbolic link resolved). */
export interface FixtureSet {
  /** The set's folder. Every read stays inside it. */
  readonly dir: string;
  /** The folder the set was checked to lie in: the repository's fixtures/, unless a test names a temporary copy's. */
  readonly jail: string;
}

export interface ManifestEntry {
  readonly sha256: string;
  /** Relative to the set's folder, with forward slashes. */
  readonly path: string;
}

/** A file that matched its manifest line, with the bytes that were hashed. */
export interface VerifiedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface VerifiedFixtureSet {
  /** The set's folder (a real path). */
  readonly dir: string;
  /** The sha256 of the manifest itself, which names the whole set. */
  readonly manifestSha256: string;
  /** How many files the manifest lists; every one was checked. */
  readonly filesChecked: number;
  /** Every listed file, by path. */
  readonly files: ReadonlyMap<string, VerifiedFile>;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `child` is `parent` or lies inside it (both absolute). */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Whether `relative` is a plain path inside a folder: forward slashes, no absolute start, no `.`, `..` or empty step. */
export function isPlainRelativePath(relative: string): boolean {
  if (relative === "" || relative.includes("\0") || relative.includes("\\")) {
    return false;
  }
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    return false;
  }
  return relative.split("/").every((step) => step !== "" && step !== "." && step !== "..");
}

function realFolder(folder: string, what: string): string {
  let real: string;
  try {
    real = realpathSync(folder);
  } catch {
    throw new FixtureAccessError(`${what} ${folder} cannot be opened`);
  }
  if (!lstatSync(real).isDirectory()) {
    throw new FixtureAccessError(`${what} ${folder} is not a folder`);
  }
  return real;
}

/**
 * Opens a fixture set for reading. `dir` (default fixtures/v1) must lie inside `jail` (default the repository's
 * fixtures/ folder), both as written and once every symbolic link is resolved; anything else is refused before any file
 * in it is read. Only tests pass `jail`, naming a temporary copy's own folder.
 */
export function openFixtureSet(
  dir: string = FIXTURE_SET_V1_DIR,
  options: { jail?: string } = {},
): FixtureSet {
  const jailAsWritten = path.resolve(options.jail ?? FIXTURES_DIR);
  const jail = realFolder(jailAsWritten, "the fixtures folder");
  const asWritten = path.resolve(dir);
  const outside = (where: string): FixtureAccessError =>
    new FixtureAccessError(
      `refusing to read ${dir}: ${where} outside ${jail} (seeds read fixture set v1 under fixtures/ only, build prompt rule 9)`,
    );
  // First as written, so a path that climbs out with `..` is refused before anything in it is touched.
  if (!isInside(asWritten, jailAsWritten) && !isInside(asWritten, jail)) {
    throw outside("it is");
  }
  const real = realFolder(asWritten, "the fixture set");
  if (!isInside(real, jail)) {
    throw outside("a symbolic link leads");
  }
  return { dir: real, jail };
}

/**
 * Reads one file of the set: null when it does not exist. A path that is not plain, a symbolic link, anything but a
 * regular file, or a file whose real location is outside the set is refused before it is read.
 */
function readInside(set: FixtureSet, relative: string): Uint8Array | null {
  if (!isPlainRelativePath(relative)) {
    throw new FixtureAccessError(
      `refusing to read ${JSON.stringify(relative)}: not a plain path inside the fixture set`,
    );
  }
  const file = path.join(set.dir, ...relative.split("/"));
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw new FixtureAccessError(
      `refusing to read ${relative}: a symbolic link is not allowed in the fixture set`,
    );
  }
  if (!stat.isFile()) {
    throw new FixtureAccessError(`refusing to read ${relative}: not a regular file`);
  }
  // A folder on the way may itself be a link; the file's real place must still be inside the set.
  if (!isInside(realpathSync(file), set.dir)) {
    throw new FixtureAccessError(
      `refusing to read ${relative}: its real location is outside the fixture set`,
    );
  }
  return readFileSync(file);
}

/** Every regular file under `relativeDir` (none when it is missing), in code-point order. A symbolic link is refused. */
function walk(set: FixtureSet, relativeDir: string, out: string[]): void {
  const folder = path.join(set.dir, ...relativeDir.split("/"));
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new FixtureAccessError(
      `refusing to read ${relativeDir}: a symbolic link is not allowed in the fixture set`,
    );
  }
  if (!stat.isDirectory()) {
    out.push(relativeDir);
    return;
  }
  const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name));
  for (const entry of entries) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new FixtureAccessError(
        `refusing to read ${relative}: a symbolic link is not allowed in the fixture set`,
      );
    }
    if (entry.isDirectory()) {
      walk(set, relative, out);
    } else if (entry.isFile()) {
      out.push(relative);
    } else {
      throw new FixtureAccessError(`refusing to read ${relative}: not a regular file`);
    }
  }
}

/** The files the manifest must list: everything under forms/ and test-kit/, and PROFESSION-MAP.md. */
function trackedFiles(set: FixtureSet): string[] {
  const out: string[] = [];
  for (const dir of TRACKED_DIRS) {
    walk(set, dir, out);
  }
  for (const file of TRACKED_FILES) {
    walk(set, file, out);
  }
  return out.sort(byCodePoint);
}

/**
 * Parses a manifest. A path that is not plain (absolute, `..`, `.`, a backslash) is a FixtureAccessError, thrown before
 * any listed file is read; a malformed or repeated line, or an empty manifest, is a FixtureChecksumError.
 */
export function parseManifest(text: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line === "") {
      return;
    }
    const match = MANIFEST_LINE.exec(line);
    const sha256 = match?.[1];
    const listed = match?.[2];
    if (sha256 === undefined || listed === undefined) {
      problems.push(`${MANIFEST_FILE} line ${String(index + 1)} is not "<sha256>  <path>"`);
      return;
    }
    if (!isPlainRelativePath(listed)) {
      throw new FixtureAccessError(
        `refusing ${MANIFEST_FILE} line ${String(index + 1)}: ${JSON.stringify(listed)} is not a plain path inside the fixture set`,
      );
    }
    if (seen.has(listed)) {
      problems.push(`${MANIFEST_FILE} lists ${listed} twice`);
      return;
    }
    seen.add(listed);
    entries.push({ sha256, path: listed });
  });
  if (entries.length === 0 && problems.length === 0) {
    problems.push(`${MANIFEST_FILE} lists no file`);
  }
  if (problems.length > 0) {
    throw new FixtureChecksumError(problems);
  }
  return entries;
}

/**
 * Checks the whole set against its manifest and returns every file with the bytes that were hashed. Throws
 * FixtureChecksumError listing every changed, missing or unlisted file, so a caller that loads only after this returns
 * never loads from a set that does not match.
 */
export function verifyFixtureSet(set: FixtureSet): VerifiedFixtureSet {
  const manifest = readInside(set, MANIFEST_FILE);
  if (manifest === null) {
    throw new FixtureChecksumError([`${MANIFEST_FILE} is missing from ${set.dir}`]);
  }
  const entries = parseManifest(new TextDecoder().decode(manifest));
  const problems: string[] = [];
  const files = new Map<string, VerifiedFile>();
  for (const entry of entries) {
    const bytes = readInside(set, entry.path);
    if (bytes === null) {
      problems.push(`listed but missing: ${entry.path}`);
      continue;
    }
    const sha256 = sha256Of(bytes);
    if (sha256 !== entry.sha256) {
      problems.push(`changed: ${entry.path}`);
      continue;
    }
    files.set(entry.path, { path: entry.path, sha256, bytes });
  }
  const listed = new Set(entries.map((entry) => entry.path));
  for (const file of trackedFiles(set)) {
    if (!listed.has(file)) {
      problems.push(`not in the manifest: ${file}`);
    }
  }
  if (problems.length > 0) {
    throw new FixtureChecksumError(problems);
  }
  return { dir: set.dir, manifestSha256: sha256Of(manifest), filesChecked: entries.length, files };
}

/** The verified files whose path starts with `prefix` (such as "test-kit/shops/"), in code-point order of path. */
export function filesUnder(verified: VerifiedFixtureSet, prefix: string): VerifiedFile[] {
  return [...verified.files.values()]
    .filter((file) => file.path.startsWith(prefix))
    .sort((a, b) => byCodePoint(a.path, b.path));
}
