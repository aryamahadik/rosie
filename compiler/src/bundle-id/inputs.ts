// The manifest's inputs, each with its sha256 (T-150; K-01 v1 manifest.inputs and inputFile; Q-36; T-130; T-002).
//
// K-01 lists every input a bundle is built from with its hash (02-contracts K-01: "the hashes of every input
// (master-A.json, master-B.json, the 243 trade files, the Master Corrections version, engine/design/LINES.md, the
// overlays Jay approved, and fixture set v1's manifest, Q-36)"), and the reference scripts parity runs against
// (inputFile kind referenceCode: overlay-core.js, lib.js and msgtext.js; MC 1; Q-35). bundleInputs() lists them:
//
//   masterFlow, trade, lines, referenceCode
//       the master's files vendored under fixtures/master/ (T-130), at the master's own path (MC 1's path rule). Each
//       sha256 is fixtures/master/SHA256SUMS's, the hashes T-130 recorded from the handover copy, checked against the
//       file's own bytes: a file that is not the one SHA256SUMS records stops the build (InputHashError), so the
//       manifest names only the bytes the compiler read. A trade is listed when the bundle holds it: 243 in a full build.
//   masterCorrections
//       the version of Master Corrections this compiler applies (MASTER_CORRECTIONS below). The file sits in the handover
//       folder, outside the repository, so neither CI nor a builder's worktree can read it; its sha256 was taken from
//       it, read only, and is committed here, as fixtures/master/manifest.test.ts does for LINES.md and the scripts.
//   approvedOverlay
//       each overlay Jay approved that the build is given (arch 12 line 592: "fixes go in an overlay Jay approves"), by
//       its repository path, with its approval date as written. None exists yet (Q-17, J-18), so none is listed today.
//   fixtureSetManifest
//       fixture set v1's committed manifest, fixtures/v1/MANIFEST.sha256 (Q-36; T-002): the file's own sha256.
//
// The list is in the order of K-01's inputFile.kind (which K-01 v1's manifest.json fixture keeps) and by path within a
// kind, so the same inputs give the same list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InputFile } from "../emit";
import type { TradeId } from "../load/trade";
import { sha256Hex } from "./content-hash";

/** The kinds of input K-01 names, in its inputFile.kind order: the order bundleInputs() lists them in. */
export const INPUT_KINDS = [
  "masterFlow",
  "trade",
  "masterCorrections",
  "lines",
  "approvedOverlay",
  "fixtureSetManifest",
  "referenceCode",
] as const satisfies readonly InputFile["kind"][];

/** This repository's root, which the inputs' repository paths are read from. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where the master's files are vendored (T-130), and the file of their hashes, from the repository root. */
export const MASTER_DIR = "fixtures/master";
export const SHA256SUMS = `${MASTER_DIR}/SHA256SUMS`;

/** Fixture set v1's committed manifest, from the repository root (Q-36; T-002). */
export const FIXTURE_SET_MANIFEST = "fixtures/v1/MANIFEST.sha256";

/** The master's own paths of the two flows, LINES.md and the reference scripts (MC 1). */
export const MASTER_FLOW_PATHS = ["engine/work/master/master-A.json", "engine/work/master/master-B.json"];
export const LINES_PATH = "engine/design/LINES.md";
export const REFERENCE_CODE_PATHS = [
  "engine/work/build/lib.js",
  "engine/work/build/msgtext.js",
  "engine/work/build/overlay-core.js",
];

/** The master's own path of a trade file (MC 1; SPEC-prof 3). */
export function tradePath(trade: TradeId): string {
  return `engine/work/prof/${trade}.json`;
}

/**
 * The Master Corrections this compiler applies (MC; the corrections in compiler/src/corrections). The path as K-01 v1's
 * manifest.json fixture writes it, from the handover folder. The sha256 is `shasum -a 256` of
 * "Rosfield Main Handover/2 Technical Architecture/3 Master Corrections.md", run read only on 2026-11-08 (T-150); it is
 * the one K-01 v1's fixture records for the same file. The version as that fixture writes it: the file was last changed
 * on Nov 5 2026, and its newest rules are "the decisions of Nov 5 2026" (MC 2, item 4). A new version of the file is
 * a new record here, made with the corrections it brings.
 */
export const MASTER_CORRECTIONS: Readonly<InputFile> = {
  kind: "masterCorrections",
  path: "2 Technical Architecture/3 Master Corrections.md",
  sha256: "11e692ec7af29de388815a2327b588508d936a2725702d49f83be25b64615c4b",
  version: "as of Nov 5 2026",
};

/** An overlay Jay approved, as the build is given it (K-01 inputFile, kind approvedOverlay). */
export interface ApprovedOverlay {
  /** Its path from the repository root, as the manifest records it; the file is hashed from there. */
  path: string;
  /** Its approval date, as written (K-01 inputFile.version). */
  version: string;
}

/** What bundleInputs() lists the inputs of. */
export interface InputOptions {
  /** The trades the bundle holds, by id. */
  trades: readonly TradeId[];
  /** The overlays Jay approved that the build is given (default: none). */
  approvedOverlays?: readonly ApprovedOverlay[];
  /** The folder the repository's files are read from (default: this repository's root). */
  root?: string;
}

/** An input the build cannot hash truthfully: missing, unreadable, or not the file its recorded hash names. */
export class InputHashError extends Error {
  override name = "InputHashError";
}

/** K-01 tradeId: the base name of a trade file. */
const TRADE_ID = /^[a-z0-9][a-z0-9-]*$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The sha256 of a file's bytes. */
function fileSha256(file: string, what: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new InputHashError(`${what}: cannot read ${file} (${message(error)})`);
  }
  return sha256Hex(bytes);
}

/** `path` read as a path from the repository root: relative, with / between its parts and no . or .. part. */
function repositoryPath(path: string, what: string): string[] {
  const parts = path.split("/");
  if (path.includes("\\") || parts.some((part) => part === "" || part === "." || part === ".."))
    throw new InputHashError(
      `${what} "${path}" is not a path from the repository root (relative, / between its parts)`,
    );
  return parts;
}

/**
 * The lines of a sha256 file, each `<sha256>  <path>` as `shasum -a 256` writes them, by path. Throws InputHashError on
 * any other line, or on a path listed twice.
 */
export function readSha256Sums(file: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new InputHashError(`cannot read ${file} (${message(error)})`);
  }
  const sums = new Map<string, string>();
  text.split("\n").forEach((line, k) => {
    if (line === "") return;
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (match === null) throw new InputHashError(`${file} line ${String(k + 1)} is not "<sha256>  <path>"`);
    const [, sha256 = "", path = ""] = match;
    if (sums.has(path)) throw new InputHashError(`${file} lists ${path} twice`);
    sums.set(path, sha256);
  });
  return sums;
}

const byPath = (a: InputFile, b: InputFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Every input K-01 names for a bundle holding `trades`, each with its sha256 (see the top of this file). */
export function bundleInputs(options: InputOptions): InputFile[] {
  const root = options.root ?? REPO_ROOT;
  const sums = readSha256Sums(join(root, ...SHA256SUMS.split("/")));

  /** A vendored master file: SHA256SUMS's hash, checked against the file's bytes. */
  const vendored = (kind: InputFile["kind"], path: string): InputFile => {
    const recorded = sums.get(path);
    if (recorded === undefined) throw new InputHashError(`${SHA256SUMS} has no line for ${path}`);
    const actual = fileSha256(join(root, ...MASTER_DIR.split("/"), ...path.split("/")), path);
    if (actual !== recorded)
      throw new InputHashError(
        `${MASTER_DIR}/${path} is not the file ${SHA256SUMS} records: its sha256 is ${actual}, the line says ${recorded}`,
      );
    return { kind, path, sha256: recorded };
  };

  const seen = new Set<TradeId>();
  const trades: InputFile[] = [];
  for (const trade of options.trades) {
    if (!TRADE_ID.test(trade)) throw new InputHashError(`"${trade}" is not a trade id`);
    if (seen.has(trade)) throw new InputHashError(`the trade ${trade} is given twice`);
    seen.add(trade);
    trades.push({ ...vendored("trade", tradePath(trade)), trade });
  }

  const overlays: InputFile[] = [];
  for (const overlay of options.approvedOverlays ?? []) {
    const parts = repositoryPath(overlay.path, "an approved overlay's path");
    if (overlay.version.trim() === "")
      throw new InputHashError(`the approved overlay ${overlay.path} has no approval date (its version)`);
    if (overlays.some((listed) => listed.path === overlay.path))
      throw new InputHashError(`the approved overlay ${overlay.path} is given twice`);
    const sha256 = fileSha256(join(root, ...parts), `the approved overlay ${overlay.path}`);
    overlays.push({ kind: "approvedOverlay", path: overlay.path, sha256, version: overlay.version });
  }

  const fixtureSet: InputFile = {
    kind: "fixtureSetManifest",
    path: FIXTURE_SET_MANIFEST,
    sha256: fileSha256(join(root, ...FIXTURE_SET_MANIFEST.split("/")), "fixture set v1's manifest"),
  };

  return [
    ...MASTER_FLOW_PATHS.map((path) => vendored("masterFlow", path)).sort(byPath),
    ...trades.sort(byPath),
    { ...MASTER_CORRECTIONS },
    vendored("lines", LINES_PATH),
    ...overlays.sort(byPath),
    fixtureSet,
    ...REFERENCE_CODE_PATHS.map((path) => vendored("referenceCode", path)).sort(byPath),
  ];
}
