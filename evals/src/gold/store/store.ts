// The gold-set item store (T-470; C-139): writes and reads K-10 v1 gold-set items by set version, journey and flow under
// evals/gold/ (layout.ts), refuses an item the store must not keep, and keeps each set's manifest (manifest.ts) with
// every file's sha256 and what the set holds for each section 08 measure, over the set and per journey (counts.ts).
//
//   writeGoldItems()    checks every item given, then writes the new ones and the set's manifest. All or nothing: one
//                       refused item and nothing is written (GoldItemRefused, every problem listed). An item is refused
//                       when K-10 v1 refuses it (validate.ts, naming each fault, a field's name among them), when it is a
//                       human-labelled live turn (BP rule 9), when its setVersion is not the set written, or when its id
//                       is already in the set with other content: items are written once and never rewritten (K-10
//                       README "The gold-set item"; QUESTIONS.md M2-qa-frontend.2). The same item again is left as it is,
//                       so writing the same items twice gives the same files and the same manifest, byte for byte. A
//                       write of no items to an existing set rebuilds its manifest from its checked files.
//   readGoldItems()     a set's items, by journey and flow when asked, in path order, each exactly as written.
//   readGoldItem()      one item by its id.
//   readGoldManifest()  a set's manifest and its sha256.
//   goldSetVersions()   the sets under a root.
//
// Every read, and every write before it adds a file, checks the whole set on disk first (GoldSetError, every problem
// listed): each file is an item K-10 v1 and the store accept, in the folder its set version, journey, flow and id name,
// with its id once in the set; the manifest lists every file, each with its sha256, and no other. A read also checks that
// the manifest's counts are those of its items. The store reads and writes nothing else: no clock, no network.
//
// A set's folder holds the items its set version added (each item's setVersion). How a run combines set versions is the
// eval runs' (C-141), not the store's. One writer at a time: the store takes no lock.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { GoldItem } from "../../../../contracts/generated/eval-set/eval-set.v1";
import { jsonFileText, sha256Hex } from "./json";
import {
  GOLD_ROOT,
  MANIFEST_FILE,
  compareText,
  filesUnder,
  isItemPath,
  isSetVersion,
  itemPathOf,
  setDirOf,
} from "./layout";
import { buildManifest, manifestShapeProblems, type GoldManifest, type SetEntry } from "./manifest";
import { checkGoldItem } from "./validate";

/** Which set: its version, and the store's root (evals/gold/ unless another is given). */
export interface SetOptions {
  setVersion: string;
  root?: string | undefined;
}

/** Which items of a set: those of one journey, of one flow, or both. */
export interface ReadOptions extends SetOptions {
  journey?: number | undefined;
  flow?: "A" | "B" | undefined;
}

/** What a write did. */
export interface WriteResult {
  setVersion: string;
  /** The set's folder. */
  dir: string;
  /** The item files it wrote, by their paths inside the set's folder, in order. */
  written: string[];
  /** The items given that the set already held as they are, left untouched. */
  unchanged: string[];
  /** The set's manifest after the write. */
  manifest: GoldManifest;
  /** The sha256 of manifest.json's bytes. */
  manifestSha256: string;
}

/** Items the store will not keep; nothing was written. `problems` holds one line per fault, each naming its item. */
export class GoldItemRefused extends Error {
  override name = "GoldItemRefused";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `gold items refused (${plural(problems.length, "problem")}); nothing was written:\n  ${problems.join("\n  ")}`,
    );
    this.problems = problems;
  }
}

/** A set on disk that is missing, or that does not hold what its manifest says. `problems` holds one line per fault. */
export class GoldSetError extends Error {
  override name = "GoldSetError";
  readonly problems: readonly string[];

  constructor(where: string, problems: readonly string[]) {
    super(`${where}:\n  ${problems.join("\n  ")}`);
    this.problems = problems;
  }
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** An error's message, its first line only, so each problem stays one line. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/** The root and folder of a set, its version checked (K-10 v1 goldSetVersion). */
function setPlace(options: SetOptions): { dir: string; where: string } {
  if (!isSetVersion(options.setVersion))
    throw new GoldSetError(`gold set ${JSON.stringify(options.setVersion)}`, [
      "a set version is letters, digits, dots, dashes and underscores, at most 60, never a slash (K-10 v1 goldSetVersion)",
    ]);
  const dir = setDirOf(options.root ?? GOLD_ROOT, options.setVersion);
  const where = `gold set ${options.setVersion} (${dir})`;
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new GoldSetError(where, ["it is not a folder"]);
  return { dir, where };
}

/** A set read from disk and checked. */
interface OpenSet {
  entries: SetEntry[];
  byId: Map<string, SetEntry>;
  manifest: GoldManifest;
  manifestText: string;
}

/**
 * Reads the set in `dir` and checks it (see the top of this file), throwing GoldSetError with every problem found.
 * `counts`: also check that the manifest is the one buildManifest() gives for its items.
 */
function openSet(dir: string, setVersion: string, where: string, counts: boolean): OpenSet {
  if (!existsSync(dir)) throw new GoldSetError(where, ["no such set"]);
  const problems: string[] = [];
  const files = filesUnder(dir);
  const entries: SetEntry[] = [];
  const byId = new Map<string, SetEntry>();
  for (const file of files) {
    if (file === MANIFEST_FILE) continue;
    if (!isItemPath(file)) {
      problems.push(`${file} is not an item file of the store (journey-<NN>/flow-<A|B>/<item id>.json)`);
      continue;
    }
    const text = readFileSync(path.join(dir, ...file.split("/")), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      problems.push(`${file} is not valid JSON: ${errorText(error)}`);
      continue;
    }
    const itemProblems = checkGoldItem(value);
    if (itemProblems.length > 0) {
      for (const problem of itemProblems) problems.push(`${file}: ${problem}`);
      continue;
    }
    const item = value as GoldItem;
    if (item.setVersion !== setVersion)
      problems.push(`${file}: /setVersion is ${item.setVersion}, so it is not an item of set ${setVersion}`);
    const home = itemPathOf(item);
    if (home !== file) problems.push(`${file}: its journey, flow and id put it at ${home}`);
    const other = byId.get(item.itemId);
    if (other !== undefined) problems.push(`${file}: item id ${item.itemId} is also at ${other.path}`);
    const entry: SetEntry = { path: file, sha256: sha256Hex(text), item };
    entries.push(entry);
    byId.set(item.itemId, entry);
  }

  let manifest: GoldManifest | null = null;
  let manifestText = "";
  if (!files.includes(MANIFEST_FILE)) {
    problems.push(`${MANIFEST_FILE} is missing`);
  } else {
    manifestText = readFileSync(path.join(dir, MANIFEST_FILE), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(manifestText);
    } catch (error) {
      problems.push(`${MANIFEST_FILE} is not valid JSON: ${errorText(error)}`);
    }
    if (value !== undefined) {
      const shape = manifestShapeProblems(value, setVersion);
      for (const problem of shape) problems.push(`${MANIFEST_FILE}: ${problem}`);
      if (shape.length === 0) manifest = value as GoldManifest;
    }
  }

  if (manifest !== null) {
    const listed = new Map(manifest.files.map((file) => [file.path, file.sha256]));
    for (const entry of entries) {
      const sha256 = listed.get(entry.path);
      if (sha256 === undefined) problems.push(`${entry.path} is not listed in ${MANIFEST_FILE}`);
      else if (sha256 !== entry.sha256)
        problems.push(
          `${entry.path}: its sha256 is not the one ${MANIFEST_FILE} lists; an item is never rewritten`,
        );
    }
    const present = new Set(files);
    for (const file of manifest.files) {
      if (!present.has(file.path)) problems.push(`${file.path} is listed in ${MANIFEST_FILE} but missing`);
    }
    if (counts && problems.length === 0 && !isDeepStrictEqual(manifest, buildManifest(setVersion, entries)))
      problems.push(
        `${MANIFEST_FILE} is not the manifest of its items (an entry or a count differs); a write of no items rebuilds it`,
      );
  }

  if (problems.length > 0 || manifest === null) throw new GoldSetError(where, problems);
  return { entries, byId, manifest, manifestText };
}

/**
 * `value` as JSON text, or why it has none: undefined or a function gives no JSON (why is empty), and a BigInt or a
 * cycle cannot be written (why gives JSON.stringify's reason).
 */
function jsonOf(value: unknown): { json: string } | { why: string } {
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined ? { why: "" } : { json };
  } catch (error) {
    return { why: ` (${errorText(error)})` };
  }
}

/** ` (<item id>)` for a value with a string itemId, else nothing: how a problem names the item it is about. */
function idOf(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { itemId?: unknown }).itemId === "string"
    ? ` (${(value as { itemId: string }).itemId})`
    : "";
}

/** Writes `items` into set `options.setVersion` (see the top of this file). */
export async function writeGoldItems(items: readonly unknown[], options: SetOptions): Promise<WriteResult> {
  const { dir, where } = setPlace(options);
  const { setVersion } = options;

  // Each item as JSON, checked on its own and against the others given.
  const problems: string[] = [];
  const given = new Map<string, { item: GoldItem; index: number }>();
  items.forEach((input, index) => {
    const text = jsonOf(input);
    if (!("json" in text)) {
      problems.push(`item ${String(index)}: is not a JSON value${text.why}`);
      return;
    }
    const value: unknown = JSON.parse(text.json);
    const label = `item ${String(index)}${idOf(value)}`;
    const found = checkGoldItem(value);
    if (found.length > 0) {
      for (const problem of found) problems.push(`${label}: ${problem}`);
      return;
    }
    const item = value as GoldItem;
    if (item.setVersion !== setVersion) {
      problems.push(
        `${label}: /setVersion is ${item.setVersion}, but it is written to set ${setVersion}; an item is kept under the set version that added it`,
      );
      return;
    }
    const before = given.get(item.itemId);
    if (before === undefined) given.set(item.itemId, { item, index });
    else if (!isDeepStrictEqual(before.item, item))
      problems.push(`${label}: item ${String(before.index)} has the same id with other content`);
  });
  if (problems.length > 0) throw new GoldItemRefused(problems);

  // The set as it is on disk, checked; then written once, never rewritten.
  const exists = existsSync(dir);
  if (!exists && given.size === 0)
    throw new GoldItemRefused([`no items given, and there is no set ${setVersion} to rebuild (${dir})`]);
  const set: Pick<OpenSet, "entries" | "byId"> = exists
    ? openSet(dir, setVersion, where, false)
    : { entries: [], byId: new Map() };
  const fresh: GoldItem[] = [];
  const unchanged: string[] = [];
  for (const { item, index } of given.values()) {
    const held = set.byId.get(item.itemId);
    if (held === undefined) fresh.push(item);
    else if (isDeepStrictEqual(held.item, item)) unchanged.push(held.path);
    else
      problems.push(
        `item ${String(index)} (${item.itemId}): set ${setVersion} already holds this id at ${held.path} with other content; an item is written once and never rewritten`,
      );
  }
  if (problems.length > 0) throw new GoldItemRefused(problems);

  // The new items, then the manifest.
  const entries = [...set.entries];
  const written: string[] = [];
  for (const item of fresh) {
    const relative = itemPathOf(item);
    const file = path.join(dir, ...relative.split("/"));
    const text = await jsonFileText(item, file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
    entries.push({ path: relative, sha256: sha256Hex(text), item });
    written.push(relative);
  }
  const manifest = buildManifest(setVersion, entries);
  const manifestFile = path.join(dir, MANIFEST_FILE);
  const manifestText = await jsonFileText(manifest, manifestFile);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(manifestFile) || readFileSync(manifestFile, "utf8") !== manifestText)
    writeFileSync(manifestFile, manifestText, "utf8");
  return {
    setVersion,
    dir,
    written: written.sort(compareText),
    unchanged: unchanged.sort(compareText),
    manifest,
    manifestSha256: sha256Hex(manifestText),
  };
}

/** The items of a set, those of `journey` and of `flow` when given, in path order, each exactly as written. */
export function readGoldItems(options: ReadOptions): GoldItem[] {
  const { dir, where } = setPlace(options);
  const { entries } = openSet(dir, options.setVersion, where, true);
  return [...entries]
    .sort((a, b) => compareText(a.path, b.path))
    .filter((entry) => options.journey === undefined || entry.item.journey === options.journey)
    .filter((entry) => options.flow === undefined || entry.item.path.flow === options.flow)
    .map((entry) => entry.item);
}

/** One item of a set, by its id. */
export function readGoldItem(options: SetOptions & { itemId: string }): GoldItem {
  const { dir, where } = setPlace(options);
  const entry = openSet(dir, options.setVersion, where, true).byId.get(options.itemId);
  if (entry === undefined) throw new GoldSetError(where, [`no item ${options.itemId}`]);
  return entry.item;
}

/** A set's manifest, checked against its files, and the sha256 of manifest.json's bytes. */
export function readGoldManifest(options: SetOptions): { manifest: GoldManifest; sha256: string } {
  const { dir, where } = setPlace(options);
  const set = openSet(dir, options.setVersion, where, true);
  return { manifest: set.manifest, sha256: sha256Hex(set.manifestText) };
}

/** The set versions under `root` (evals/gold/ unless another is given): its folders named as one, in order. */
export function goldSetVersions(root: string = GOLD_ROOT): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSetVersion(entry.name))
    .map((entry) => entry.name)
    .sort(compareText);
}
