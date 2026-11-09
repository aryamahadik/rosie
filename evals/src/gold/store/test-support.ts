// What the gold store's tests share (T-470): K-10 v1's item fixtures, listed and checked by T-003's shared harness
// (tests/contract/_harness), and scratch folders to hold a store, so no test writes under evals/gold/. Imported by the
// tests only: the harness imports Vitest.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GoldItem } from "../../../../contracts/generated/eval-set/eval-set.v1";
import { CONTRACTS_ROOT, checkContractFixtures, type EntryResult } from "../../../../tests/contract/_harness";
import { goldItemSchemaFiles } from "./validate";

/** contracts/eval-set/, K-10's folder. */
export const EVAL_SET_DIR = path.join(CONTRACTS_ROOT, "eval-set");

/** The folders of contracts/ whose schemas K-10 v1 refers to, which the harness loads beside eval-set/. */
export const SHARED_FOLDERS: readonly string[] = [
  ...new Set(goldItemSchemaFiles().map((file) => file.split("/")[0] ?? "")),
].filter((folder) => folder !== "eval-set");

/** K-10 v1's fixtures as the T-003 harness checks them against the schema. */
export const HARNESS_REPORT = checkContractFixtures("eval-set", { sharedFolders: SHARED_FOLDERS });

/** Every K-10 v1 item fixture: the index entries checked against $defs goldItem, accepted and refused. */
export const ITEM_FIXTURES: readonly EntryResult[] = HARNESS_REPORT.entries.filter(
  (entry) => entry.def === "goldItem",
);

/** The item fixtures K-10 v1 accepts. */
export const ACCEPTED_ITEMS: readonly EntryResult[] = ITEM_FIXTURES.filter(
  (entry) => entry.expect === "accept",
);

/** The refused item fixture of the card (K-10 README: "A field without its value is refused"). */
export const REFUSED_ITEM_FILE = "invalid/refuse-item-without-field-values.json";

/** A file of contracts/, by its path there, parsed afresh on each call. */
export function contractJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_ROOT, ...file.split("/")), "utf8")) as unknown;
}

/** A file of contracts/eval-set/, parsed afresh on each call. */
export function evalSetJson(file: string): unknown {
  return contractJson(`eval-set/${file}`);
}

/** A fixture of contracts/eval-set/fixtures/, parsed afresh on each call. */
export function fixtureValue(file: string): unknown {
  return evalSetJson(`fixtures/${file}`);
}

/** Every accepted item fixture, parsed afresh, in the index's order. */
export function acceptedItems(): GoldItem[] {
  return ACCEPTED_ITEMS.map((entry) => fixtureValue(entry.file) as GoldItem);
}

/** The accepted item fixture with this id, parsed afresh. */
export function acceptedItem(itemId: string): GoldItem {
  const found = acceptedItems().find((item) => item.itemId === itemId);
  if (found === undefined) throw new Error(`no accepted K-10 item fixture has the id ${itemId}`);
  return found;
}

/** The set version the item fixtures carry (each the same: "the gold-set version that added it"). */
export function fixtureSetVersion(): string {
  const versions = new Set(acceptedItems().map((item) => item.setVersion));
  const [only] = versions;
  if (versions.size !== 1 || only === undefined)
    throw new Error(`the item fixtures carry ${String(versions.size)} set versions`);
  return only;
}

const scratch: string[] = [];

/** A new empty folder to be a store's root; removeScratch() deletes it. */
export function scratchRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rosie-gold-"));
  scratch.push(dir);
  return dir;
}

/** Deletes every folder scratchRoot() made. */
export function removeScratch(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}
