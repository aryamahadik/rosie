// The bundle a turn runs on (T-249; C-050, C-033): the shapes the pin reads, written by hand from the frozen contracts,
// because the generated types are git-ignored (ADR-005) and the Worker must not depend on them.
//
//   - K-05 v1 item 7 (contracts/data-access): `readActiveBundle` and `readBundleValue`, each a read of PostgreSQL's
//     primary, uncached. The actor reaches them only through a port (`BundleRegistry`), joined at D-017; tests use a fake.
//   - K-01 v1 (contracts/bundle): the bundle id (CQ-09), the KV keys, the manifest and its stored values.
//
// Never logged or put in a span: a value's text. The ids, keys and codes here are labels.

import type { BundleId } from "../trace";

export type { BundleId };

/** K-05 v1 `transientError`: the database could not answer now; nothing was read, and the same read may be sent again. */
export interface TransientError {
  error: "transient";
  sqlstate: string;
}

/** K-05 v1 `readActiveBundle.response`: the active bundle id, read at turn start (arch 10 line 536). */
export interface ActiveBundle {
  result: "active";
  bundleId: BundleId;
  /** K-01 v1 `kvKey` of the bundle's manifest. */
  manifestKey: string;
  activatedAt: string;
}

/** K-05 v1 `readActiveBundle`: the active id; `noActiveBundle` before the first deploy's step 3 (BP 5.4); or transient. */
export type ReadActiveBundleAnswer = ActiveBundle | { error: "noActiveBundle" } | TransientError;

/** The kinds of value a bundle stores (K-01 v1 storage; K-05 v1 `storedText.kind`). */
export type ValueKind = "manifest" | "flow" | "trade";

/** K-05 v1 `storedText`: one value as PostgreSQL's copy holds it. The reader checks `bytes` and `sha256` against `text`. */
export interface StoredText {
  key: string;
  kind: ValueKind;
  bytes: number;
  sha256: string;
  text: string;
}

/** K-05 v1 `readBundleValue`: the value, `notFound` (no such key in PostgreSQL's copy), or transient. */
export type ReadBundleValueAnswer =
  | { result: "value"; value: StoredText }
  | { error: "notFound"; table: string; rowId: string }
  | TransientError;

/**
 * K-05 v1's two bundle reads (item 7), primary and uncached (arch 10 lines 504, 536). The actor's adapter (db/repo/bundles.ts
 * through Hyperdrive, or the Tool API) joins at D-017.
 */
export interface BundleRegistry {
  readActiveBundle(request: Record<string, never>): Promise<ReadActiveBundleAnswer>;
  readBundleValue(request: { key: string }): Promise<ReadBundleValueAnswer>;
}

/** The bundle KV namespace (the BUNDLES binding, T-277), as the pin reads it: a value's text by its key, or null on a miss. */
export interface BundleKv {
  get(key: string): Promise<string | null>;
}

/** What the pin needs from outside, set once per Worker isolate (`setBundleDeps`); joins at D-017. */
export interface BundleDeps {
  registry: BundleRegistry;
  /** Left out: the actor's own BUNDLES binding; where the environment has none, every value is read from PostgreSQL's copy. */
  kv?: BundleKv;
}

/** A flow: A, the customer comes to the business; B, the business goes to the customer (K-01 v1 `flowLetter`). */
export type FlowLetter = "A" | "B";

/** K-01 v1 `storedValue`: one value of the bundle besides the manifest, with its size and sha256 as stored. */
export interface StoredValue {
  key: string;
  kind: "flow" | "trade";
  flow?: FlowLetter;
  trade?: string;
  bytes: number;
  sha256: string;
}

/**
 * K-01 v1 `manifest`, read first at turn start. The pin checks the fields typed here; the rest (prompts, models, policy,
 * lint, journeys, the shared lists) is the turn's to read, as K-01 v1 states it.
 */
export interface Manifest {
  readonly contract: "bundle.v1";
  readonly bundleId: BundleId;
  readonly storage: { readonly manifestKey: string; readonly values: readonly StoredValue[] };
  readonly [field: string]: unknown;
}

/** K-01 v1 `flowGraph`: one flow's master graph, parsed; its contract and flow letter are checked. */
export type FlowGraph = Readonly<Record<string, unknown>>;

/** K-01 v1 `tradeOverlay`: one trade's compiled overlay, parsed; its contract and trade id are checked. */
export type TradeOverlay = Readonly<Record<string, unknown>>;

/** One value a turn read, and where it came from: KV, or PostgreSQL's copy on a miss. */
export interface PartRead {
  key: string;
  kind: ValueKind;
  from: "kv" | "postgres";
}

/**
 * The bundle a turn runs on: its id, pinned at the turn's start and kept for the whole turn and its reruns (arch 10 line
 * 518), and its values, every one read under that id. A bundle's keys are written once and never overwritten (K-01 v1
 * storage), so a value read later in the turn is still the pinned bundle's, whatever the active id is by then.
 */
export interface PinnedBundle {
  readonly bundleId: BundleId;
  /** The manifest, read at the pin and checked against the id (its stored values hash to it). */
  readonly manifest: Manifest;
  /** A flow's master graph, read once per turn: KV, or PostgreSQL's copy on a miss; checked against the manifest. */
  flow(flow: FlowLetter): Promise<FlowGraph>;
  /** A trade's compiled overlay, read once per turn, the same way. */
  trade(tradeId: string): Promise<TradeOverlay>;
  /** Every value read so far, in order. */
  reads(): PartRead[];
}

/**
 * Why a pin or a value read failed, as a label (a span's `error_code`):
 * - `unwired`: no K-05 port is set yet (D-017);
 * - `noActiveBundle`, `transient`, `notFound`: K-05's own answers;
 * - `noAnswer`: the K-05 call failed with no answer;
 * - `badAnswer`: an answer that is not K-05's shape;
 * - `notInBundle`: the manifest lists no such value;
 * - `unreadable`: no copy is the bundle's own (its bytes, sha256 or content do not match).
 */
export type BundleErrorCode =
  | "unwired"
  | "noActiveBundle"
  | "transient"
  | "noAnswer"
  | "badAnswer"
  | "notInBundle"
  | "notFound"
  | "unreadable";

/** A failed pin or value read; the message is its code and never holds a value's text. */
export class BundleError extends Error {
  readonly code: BundleErrorCode;

  constructor(code: BundleErrorCode) {
    super(code);
    this.name = "BundleError";
    this.code = code;
  }
}
