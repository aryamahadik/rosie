// The master's path functions, loaded as they are (T-136; NQ-PB-2 answered WRAP by T-131, as T-135 did for apply()).
//
// Two vendored scripts hold the path model:
//   - overlay-core.js: lit() (which branches and steps a path lights), resolveVary() (which words a step shows),
//     firstTexts() and applyStops() (the opt-out line once), walkSets() (a path as it reads after a branch's `sets`),
//     and the readers of a trade's own switches, facts and booking values (switchesOf, factsOf, bookingOf);
//   - lib.js: pathsFor() and fixturePaths() (the paths a trade walks, the record's fixtures among them), validCombo(),
//     pathKey() and parsePath() (the text form of a path).
// Both are read-only (rule 1). Nothing here copies a rule from them.
//
// One copy of overlay-core.js must serve everything. Its tables are module-level state: the money ways, the record and
// the D75 mark are set by whoever applied a flow last (syncWays). T-135's applyTrade() runs apply() on the copy that
// overlay/core.ts loaded, so the path functions must use that copy and not a second one. lib.js asks for
// `require("./overlay-core")`; the loader below is given that copy up front, so lib.js gets the very same object.
import type { FlowLetter } from "../graph/types.ts";
import { makeCjsLoader } from "../overlay/cjs-load";
import { BUILD_DIR, loadOverlayCore } from "../overlay/core";

type Obj = Record<string, unknown>;

/**
 * A path as the vendored functions read it: { price, before, after, booking, pf, facts } (overlay-core.js lines 6 to
 * 12) with the fields the record's fixtures and a branch's `sets` add (`svc`, `fix`, `base`, `setBy`, `pin`, `evSet`,
 * `allFacts`). Kept loose on purpose: the vendored script owns this shape.
 */
export interface CorePath {
  price: string;
  before: string;
  after: string;
  booking?: Record<string, string>;
  pf?: Record<string, boolean>;
  facts?: string[] | null;
  svc?: unknown[];
  fix?: string;
  base?: string;
  [extra: string]: unknown;
}

/** What resolveVary() hands back: the step with its words picked, and the keys that picked them. */
export interface CoreVaried<S> {
  step: S;
  key: string | null;
  keys: string[];
  choice: string | null;
  /** Two keys that fit equally well and set the same field (a tie: a lint error in the master), or null. */
  tie: string[] | null;
  lines?: string[];
  timed?: unknown;
  rows?: unknown;
}

/** One text a number gets on a walk (overlay-core.js firstTexts): is it the first, is it a later one, and to whom. */
export interface CoreTextRecord {
  first: boolean;
  later: boolean;
  to: string;
  stop: boolean | "first" | null;
}

/** firstTexts(): by step id, by index of the message in the step's `say`. */
export type CoreFirstTexts = Record<string, Record<number, CoreTextRecord>>;

/** The part of overlay-core.js this build calls for paths. */
export interface PathCore {
  lit(when: unknown, path: CorePath | null): boolean;
  resolveVary<S>(step: S, path: CorePath | null): CoreVaried<S>;
  firstTexts(
    steps: unknown,
    path: CorePath | null,
    opts?: { known?: ((key: string) => boolean) | null; names?: Record<string, string> | null; cap?: number },
  ): CoreFirstTexts;
  applyStops<S>(step: S, rec: Record<number, CoreTextRecord> | undefined): S;
  walkSets(
    steps: unknown,
    path: CorePath,
    fn: (step: unknown, reading: CorePath, trail: string[], branch?: unknown) => void,
    opts?: { off?: boolean },
  ): CorePath[];
  setsScopes(steps: unknown): unknown[];
  syncWays(flow: unknown): void;
  switchesOf(overlay: unknown, flow: FlowLetter): Record<string, true>;
  factsOf(overlay: unknown): string[] | null;
  bookingOf(overlay: unknown, flow: FlowLetter, applied: unknown): Record<string, string[]>;
  pathSig(path: CorePath): string;
  record(flow: FlowLetter): { fixtures?: { id: string; booking?: Record<string, string> }[] } | null;
  /** Is this booking value one only a branch's `sets` puts on a path (the record makes `privacy: private` one)? */
  setsOnly(value: string): boolean;
  recordOn(): boolean;
  /** The booking groups and the group each value belongs to. */
  BOOKING: Record<string, unknown>;
  GROUP_OF: Record<string, string>;
}

/** The part of lib.js this build calls for paths. */
export interface PathLib {
  pathsFor(
    paths: CorePath[],
    steps: unknown,
    allowed: Record<string, string[]> | null,
    fixed: boolean,
    opts?: { mix?: boolean; fl?: FlowLetter; record?: boolean },
  ): CorePath[];
  fixturePaths(
    path: CorePath,
    flow: FlowLetter,
    fixtures: unknown[] | undefined,
    allowed: Record<string, string[]> | null,
  ): CorePath[];
  validCombo(flow: FlowLetter, combo: { price: string; before: string; after: string }): boolean;
  pathName(path: CorePath): string;
  parsePath(text: string, flow?: FlowLetter): CorePath | { problems: string[] };
  CORE: unknown;
}

interface Loaded {
  core: PathCore;
  lib: PathLib;
}

let cached: Loaded | null = null;

const NEEDED_CORE = ["lit", "resolveVary", "firstTexts", "applyStops", "walkSets", "switchesOf", "bookingOf"];
const NEEDED_LIB = ["pathsFor", "fixturePaths", "validCombo", "pathName", "parsePath"];

/** Loads lib.js once per process on top of the copy of overlay-core.js that apply() already uses. */
export function loadPathScripts(): Loaded {
  if (cached) return cached;
  const core = loadOverlayCore() as unknown as PathCore;
  const cache: NonNullable<Parameters<typeof makeCjsLoader>[0]> = new Map();
  const coreFile = `${BUILD_DIR}overlay-core.js`;
  cache.set(coreFile, { exports: core, id: coreFile, filename: coreFile, loaded: true });
  const lib = makeCjsLoader(cache)(`${BUILD_DIR}lib.js`) as PathLib;
  for (const name of NEEDED_CORE) {
    if (typeof (core as unknown as Obj)[name] !== "function")
      throw new Error(`${coreFile} does not export ${name}()`);
  }
  for (const name of NEEDED_LIB) {
    if (typeof (lib as unknown as Obj)[name] !== "function")
      throw new Error(`${BUILD_DIR}lib.js does not export ${name}()`);
  }
  if ((lib as { CORE: unknown }).CORE !== core)
    throw new Error(
      "lib.js loaded its own copy of overlay-core.js: the path functions would read stale tables",
    );
  cached = { core, lib };
  return cached;
}
