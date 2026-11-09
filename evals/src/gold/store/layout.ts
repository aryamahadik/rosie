// Where the gold store keeps a set's files (T-470): by set version, journey and flow, under evals/gold/.
//
//   evals/gold/<set version>/manifest.json
//   evals/gold/<set version>/journey-<NN>/flow-<A|B>/<item id>.json
//
// The set version is the item's setVersion (K-10 v1: "the gold-set version that added it"), the journey its journey
// (K-01 v1's 1 to 12, two digits so the folders sort in order), the flow its path.flow, and the file its itemId. K-10
// v1's patterns keep each a plain folder or file name: a set version of letters, digits, dots, dashes and underscores,
// never a slash; an item id of lowercase letters, digits, dots, dashes and underscores (QUESTIONS.md M2-qa-frontend.8).
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { GoldItem } from "../../../../contracts/generated/eval-set/eval-set.v1";

/** The repository root: this file is evals/src/gold/store/layout.ts. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The store's default root, evals/gold/. */
export const GOLD_ROOT = path.join(REPO_ROOT, "evals", "gold");

/** Each set's manifest, at the top of its folder. */
export const MANIFEST_FILE = "manifest.json";

/** K-10 v1's goldSetVersion: letters, digits, dots, dashes and underscores, at most 60 characters, never a slash. */
const SET_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

/** A path of an item file inside a set's folder, as itemPathOf() writes one. */
const ITEM_PATH = /^journey-\d{2}\/flow-[AB]\/[^/]+\.json$/;

/** Whether `value` is a set version K-10 v1 accepts (so it names a plain folder). */
export function isSetVersion(value: string): boolean {
  return SET_VERSION.test(value);
}

/** A set's folder under `root`. */
export function setDirOf(root: string, setVersion: string): string {
  return path.join(root, setVersion);
}

/** An item's file inside its set's folder (posix): journey-<NN>/flow-<A|B>/<item id>.json. */
export function itemPathOf(item: GoldItem): string {
  return `journey-${String(item.journey).padStart(2, "0")}/flow-${item.path.flow}/${item.itemId}.json`;
}

/** Whether a path inside a set's folder is shaped like an item file. */
export function isItemPath(relative: string): boolean {
  return ITEM_PATH.test(relative);
}

/**
 * Every file under `dir`, by its posix path from `dir`, sorted. Names starting with a dot (.DS_Store, an editor's swap
 * file) are passed over: they are never a set's own.
 */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(dir, ...relative.split("/").filter(Boolean)), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".")) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk("");
  return out.sort(compareText);
}

/** Text in code-unit order, the same on every machine (no locale). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
