// A gold set's manifest (T-470): every item file with its sha256, and what the set holds for each section 08 measure,
// over the whole set and per journey (counts.ts).
//
// It is a function of the set's files alone: the entries in path order, the journeys in number order, the measures in
// K-10 v1's order, and no clock, path outside the set or random value. So the same items give the same manifest, byte
// for byte, whatever order they were written in or how many writes it took. Its own sha256, which a reader keeps to name
// the set's exact content, is that of its file (json.ts).
import type { GoldItem } from "../../../../contracts/generated/eval-set/eval-set.v1";
import { countItems, type FlowCounts, type MeasureCounts } from "./counts";
import { compareText } from "./layout";

/** What the manifest says its items are checked against: K-10 v1's goldItem. */
export const MANIFEST_CONTRACT = "eval-set.v1#goldItem";

/** One item file of the set. */
export interface ManifestFile {
  /** Its path inside the set's folder (posix): journey-<NN>/flow-<A|B>/<item id>.json. */
  path: string;
  itemId: string;
  journey: number;
  flow: "A" | "B";
  kind: "turn" | "wholeChat";
  /** The sha256 of the file's bytes, in lowercase hex. */
  sha256: string;
}

/** What one journey's items hold. */
export interface JourneyCounts {
  journey: number;
  items: number;
  turns: number;
  texts: number;
  flows: FlowCounts;
  measures: MeasureCounts;
}

/** A gold set's manifest.json. */
export interface GoldManifest {
  contract: typeof MANIFEST_CONTRACT;
  setVersion: string;
  items: number;
  turns: number;
  texts: number;
  flows: FlowCounts;
  /** Each section 08 measure's units over the whole set (counts.ts). */
  measures: MeasureCounts;
  /** The same per journey, one entry per journey the set holds, in journey order. */
  byJourney: JourneyCounts[];
  /** Every item file, in path order. */
  files: ManifestFile[];
}

/** An item file of a set: where it is, the sha256 of its bytes, and the item it holds. */
export interface SetEntry {
  path: string;
  sha256: string;
  item: GoldItem;
}

/** The manifest of a set made of `entries` (see the top of this file). */
export function buildManifest(setVersion: string, entries: readonly SetEntry[]): GoldManifest {
  const sorted = [...entries].sort((a, b) => compareText(a.path, b.path));
  const items = sorted.map((entry) => entry.item);
  const whole = countItems(items);
  const journeys = [...new Set(items.map((item) => item.journey))].sort((a, b) => a - b);
  return {
    contract: MANIFEST_CONTRACT,
    setVersion,
    items: whole.items,
    turns: whole.turns,
    texts: whole.texts,
    flows: whole.flows,
    measures: whole.measures,
    byJourney: journeys.map((journey) => ({
      journey,
      ...countItems(items.filter((item) => item.journey === journey)),
    })),
    files: sorted.map((entry) => ({
      path: entry.path,
      itemId: entry.item.itemId,
      journey: entry.item.journey,
      flow: entry.item.path.flow,
      kind: entry.item.kind,
      sha256: entry.sha256,
    })),
  };
}

const SHA256 = /^[0-9a-f]{64}$/;

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What is wrong with a parsed manifest.json as the manifest of set `setVersion`, as far as the store needs to read its
 * file list: its contract, its set version, and a path and a sha256 for each file. One line each; empty: readable.
 * Whether the rest is right is a comparison with buildManifest() over the set's checked items (store.ts).
 */
export function manifestShapeProblems(value: unknown, setVersion: string): string[] {
  if (!isObj(value)) return ["it is not a JSON object"];
  const problems: string[] = [];
  if (value.contract !== MANIFEST_CONTRACT)
    problems.push(`/contract is ${JSON.stringify(value.contract)}, not "${MANIFEST_CONTRACT}"`);
  if (value.setVersion !== setVersion)
    problems.push(`/setVersion is ${JSON.stringify(value.setVersion)}, not the set's own "${setVersion}"`);
  if (!Array.isArray(value.files)) {
    problems.push("/files is not a list");
    return problems;
  }
  (value.files as unknown[]).forEach((file, k) => {
    if (
      !isObj(file) ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    )
      problems.push(`/files/${String(k)} has no path and sha256 (64 lowercase hex characters)`);
  });
  return problems;
}
