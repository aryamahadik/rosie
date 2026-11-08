// The bundle's shared lists, collected from each module's shared-list.ts (T-149; K-01 v1 `sharedLists`, the manifest's
// `lists`: the guard's keywords, the fixed lines, the plug-in key map and the out-of-scope markers).
//
// A module gives a shared list by holding a file `shared-list.ts` in its own folder under compiler/src/ (such as
// compiler/src/scope/shared-list.ts, T-147). The emitter finds every such file and reads its export:
//
//   import type { SharedListPart } from "../emit/shared-lists";
//   export const sharedLists: SharedListPart[] = [
//     { list: "outOfScope", source: "T-147: 01-inventory.md group 11, C-222 to C-228 ...", build: () => ({ markers }) },
//   ];
//
// so a later list joins the bundle without an edit to the emitter. Each part's `build()` returns the list in K-01's
// shape (`$defs/<list>`), and each part is checked against it alone, so a refused part names its file. keywords and
// keyMap are whole lists: exactly one module gives each. fixedLines and outOfScope are joined: their `lines` and
// `markers` are put together in the order of the module folders' names, then each part's own order.
//
// A list no module gives yet is reported missing; the emitter then takes K-01 v1's own accepted fixture of that list as
// its stand-in and says so (standins.ts), so a stand-in drops away by itself once a module gives the list.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBundlePart } from "./validate";

/** The shared lists of K-01 v1 (`sharedLists`), in its order. */
export const SHARED_LIST_NAMES = ["keywords", "fixedLines", "keyMap", "outOfScope"] as const;
export type SharedListName = (typeof SHARED_LIST_NAMES)[number];

/** The lists one module alone gives; the others are joined across modules. */
const WHOLE: readonly SharedListName[] = ["keywords", "keyMap"];

/** The array each joined list holds its entries in. */
const JOINED_FIELD: Readonly<Partial<Record<SharedListName, string>>> = {
  fixedLines: "lines",
  outOfScope: "markers",
};

/** One module's part of a shared list: an entry of the `sharedLists` array its shared-list.ts exports. */
export interface SharedListPart {
  /** The K-01 shared list it gives, or adds to. */
  list: SharedListName;
  /** Where its entries come from, in plain words: the task, and the sources it reads. */
  source: string;
  /** The list in K-01's shape (`$defs/<list>`), built when the bundle is emitted. */
  build(): unknown;
}

/** The file a module gives its shared lists in. */
export const SHARED_LIST_FILE = "shared-list.ts";

/** The compiler's module folders: compiler/src/. */
export const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));

/** A shared-list.ts that does not give lists the emitter can read. */
export class SharedListError extends Error {
  override name = "SharedListError";
}

/** The shared lists collected, with where each came from. */
export interface CollectedLists {
  /** Each list some module gives, in K-01's shape. */
  lists: Partial<Record<SharedListName, unknown>>;
  /** For each list given: the files and sources that gave it, in order. */
  sources: Partial<Record<SharedListName, string[]>>;
  /** The lists no module gives. */
  missing: SharedListName[];
}

/** The shared-list.ts of each module folder under `srcDir` that has one, in folder-name order. */
export function sharedListFiles(srcDir: string = SRC_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => join(srcDir, name, SHARED_LIST_FILE))
    .filter((file) => existsSync(file));
}

function isPart(value: unknown): value is SharedListPart {
  if (typeof value !== "object" || value === null) return false;
  const part = value as Record<string, unknown>;
  return (
    typeof part.list === "string" &&
    (SHARED_LIST_NAMES as readonly string[]).includes(part.list) &&
    typeof part.source === "string" &&
    part.source.trim() !== "" &&
    typeof part.build === "function"
  );
}

/**
 * Each file's parts, in the files' order: its `sharedLists` export, checked for shape. `name` is how a file is named in
 * messages and sources (default: its path).
 */
export async function loadSharedListParts(
  paths: readonly string[],
  name: (path: string) => string = (path) => path,
): Promise<{ file: string; part: SharedListPart }[]> {
  const out: { file: string; part: SharedListPart }[] = [];
  for (const path of paths) {
    const file = name(path);
    const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    const parts = loaded.sharedLists;
    if (!Array.isArray(parts))
      throw new SharedListError(`${file}: expected an export "sharedLists", a list of shared-list parts`);
    parts.forEach((part: unknown, k) => {
      if (!isPart(part))
        throw new SharedListError(
          `${file}: sharedLists[${String(k)}] needs a list (${SHARED_LIST_NAMES.join(", ")}), a source and a build()`,
        );
      out.push({ file, part });
    });
  }
  return out;
}

/** Puts the parts together into the lists (see the top of this file), each part checked against K-01 first. */
export function mergeSharedLists(parts: readonly { file: string; part: SharedListPart }[]): CollectedLists {
  const lists: Partial<Record<SharedListName, unknown>> = {};
  const sources: Partial<Record<SharedListName, string[]>> = {};
  for (const { file, part } of parts) {
    const value: unknown = part.build();
    const problems = checkBundlePart(value, part.list);
    if (problems.length > 0)
      throw new SharedListError(`${file}: its ${part.list} is refused by K-01 v1: ${problems.join("; ")}`);
    const given = sources[part.list] ?? [];
    const field = JOINED_FIELD[part.list];
    if (WHOLE.includes(part.list) || field === undefined) {
      if (given.length > 0)
        throw new SharedListError(
          `${file}: ${part.list} is already given by ${given.join(", ")}; one module gives it`,
        );
      lists[part.list] = value;
    } else {
      const entries = (value as Record<string, unknown[]>)[field] ?? [];
      const held = lists[part.list] as Record<string, unknown[]> | undefined;
      lists[part.list] = { [field]: [...(held?.[field] ?? []), ...entries] };
    }
    sources[part.list] = [...given, `${file}: ${part.source}`];
  }
  const missing = SHARED_LIST_NAMES.filter((name) => lists[name] === undefined);
  return { lists, sources, missing };
}

/**
 * Finds and reads every module's shared-list.ts under `srcDir` (default compiler/src/) and puts the lists together.
 * Files are named by their path from `srcDir`, such as emit/shared-list.ts.
 */
export async function collectSharedLists(srcDir: string = SRC_DIR): Promise<CollectedLists> {
  const parts = await loadSharedListParts(sharedListFiles(srcDir), (path) =>
    relative(srcDir, path).split(sep).join("/"),
  );
  return mergeSharedLists(parts);
}
