// The bundle pin at turn start (T-249; C-050, C-033; arch 10 'Caching', line 536; 'Playbook', line 518: "bundle id pinned
// per turn; KV takes about 60 s to propagate").
//
// When the lease starts a run of a turn (T-248, ../actor/lease.ts), the pin:
//
//   1. takes the bundle id stored for this turn id, when there is one: a rerun after a lapsed lease keeps its bundle, even
//      after the active id changed and the actor restarted;
//   2. else reads the active bundle id from PostgreSQL (K-05 v1 `readActiveBundle`) and stores it for the turn id at once,
//      in one synchronous step that keeps the first id stored (so every run of one turn id runs on one bundle);
//   3. reads that bundle's manifest under its id, from KV or from PostgreSQL's copy on a miss (values.ts), checked against
//      the id;
//   4. opens the turn's trace (the first text's trace id, CQ-06) under the pinned bundle id, so every span of the turn
//      carries it (K-08), and records the `lease` hop: "the turn lease, 60 s; the bundle is pinned".
//
// The turn's work then reads the step graph (a flow's graph, a trade's overlay) through the pinned bundle, under the pinned
// id's keys, which are written once and never overwritten (K-01 v1 storage). The next turn reads the active id again.
//
// A pin that fails (unwired, no active bundle, K-05 not answering, a manifest no copy holds as the bundle's own) starts no
// work: like a crash, nothing is written, and the lease lapses into a rerun, which pins again. Its `lease` span says why.
// Never logged or put in a span: a text's words or a value's text (K-08: labels and counts only).

import { openTrace, type BundleId, type SpanSink, type TraceContext } from "../trace";
import {
  BundleError,
  type BundleDeps,
  type BundleErrorCode,
  type BundleKv,
  type FlowGraph,
  type FlowLetter,
  type Manifest,
  type PartRead,
  type PinnedBundle,
  type TradeOverlay,
} from "./types";
import { asListed, BundleReader, bundleIdOf, flowOf, keyOf, readManifest, tradeOf } from "./values";

let deps: BundleDeps | null = null;

/** Sets what the pin needs for this Worker isolate; returns the function that puts the earlier one back. */
export function setBundleDeps(next: BundleDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

/** One bundle, pinned: its manifest, and each value read once, under its id. */
class Pinned implements PinnedBundle {
  private readonly flows = new Map<FlowLetter, Promise<FlowGraph>>();
  private readonly trades = new Map<string, Promise<TradeOverlay>>();

  constructor(
    readonly bundleId: BundleId,
    readonly manifest: Manifest,
    private readonly reader: BundleReader,
  ) {}

  flow(flow: FlowLetter): Promise<FlowGraph> {
    return once(this.flows, flow, () => this.load(`flow/${flow}`, "flow", (text) => flowOf(text, flow)));
  }

  trade(tradeId: string): Promise<TradeOverlay> {
    return once(this.trades, tradeId, () =>
      this.load(`trade/${tradeId}`, "trade", (text) => tradeOf(text, tradeId)),
    );
  }

  reads(): PartRead[] {
    return this.reader.reads();
  }

  /** A value the manifest lists, with the size and sha256 it lists; a value it does not list is never read. */
  private async load<T>(part: string, kind: "flow" | "trade", make: (text: string) => T | null): Promise<T> {
    const key = keyOf(this.bundleId, part);
    const listed = this.manifest.storage.values.find((value) => value.key === key && value.kind === kind);
    if (listed === undefined) throw new BundleError("notInBundle");
    return this.reader.read(key, kind, (value) =>
      Promise.resolve(asListed(value, listed) ? make(value.text) : null),
    );
  }
}

/** The value loading under `id`, started once; a load that fails is forgotten, so the turn may ask again. */
function once<K, T>(loads: Map<K, Promise<T>>, id: K, load: () => Promise<T>): Promise<T> {
  const known = loads.get(id);
  if (known !== undefined) return known;
  const loading = load();
  loads.set(id, loading);
  void loading.catch(() => {
    loads.delete(id);
  });
  return loading;
}

/** What the lease hands the pin when it starts a run of a turn. */
export interface PinRequest {
  turnId: string;
  /** The turn's trace id (the first text's) and the other texts' (CQ-06). */
  traceId: string;
  joinedTraceIds: readonly string[];
  /** How many texts the turn holds. */
  texts: number;
  /**
   * This run's try (1, then 2 and 3 after a lapse) and whether the turn is a restart: the one restart, or the second, for
   * a batch that may hold a stop word (ADR-018 section 1).
   */
  tries: number;
  restart: boolean;
  /** The lease's length. */
  leaseMs: number;
  /**
   * The bundle id the turn's first text arrived under (the gateway's active id at receipt), which a failed pin's span
   * carries when no id was pinned (K-08 v1 README default 1).
   */
  arrivedUnder: BundleId | null;
}

/** The pin a run's work is handed. */
export interface TurnPin {
  /** The bundle id pinned for the turn (K-05 `turn.bundleId`; K-04 turns.bundle_hash and bundle_build). */
  bundleId: BundleId;
  bundle: PinnedBundle;
  /** The turn's trace, under the pinned bundle id: every span the turn records on it carries that id (K-08). */
  trace: TraceContext;
}

/** One turn's pin, as a reader sees it. */
export interface PinEntry {
  turnId: string;
  bundleId: BundleId;
  /** When the pin was first taken, on the actor's clock. */
  pinnedAt: number;
}

export interface PinHost {
  storage: DurableObjectStorage;
  /** The actor's clock (the stored schedule's). */
  now(): number;
  /** The actor's BUNDLES binding, or null where its environment has none (env.staging until T-566). */
  kv(): BundleKv | null;
  /** Where spans go: one JSON log line each. */
  spanSink(): SpanSink;
}

interface PinRow extends Record<string, SqlStorageValue> {
  turn_id: string;
  bundle_hash: string;
  bundle_build: number;
  pinned_ms: number;
}

export function createPinTable(sql: SqlStorage): void {
  // One row per turn id, written once: the first bundle id pinned for it.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS turn_bundles (
       turn_id TEXT PRIMARY KEY,
       bundle_hash TEXT NOT NULL,
       bundle_build INTEGER NOT NULL,
       pinned_ms INTEGER NOT NULL
     )`,
  );
}

const codeOf = (error: unknown): BundleErrorCode => (error instanceof BundleError ? error.code : "noAnswer");

export class BundlePins {
  constructor(private readonly host: PinHost) {
    createPinTable(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  /**
   * Pins the turn's bundle for this run (the steps above). Null: no pin, so the run's work must not start; null too, with
   * no span, when `signal` says this run is no longer the turn's.
   */
  async pin(request: PinRequest, signal: AbortSignal): Promise<TurnPin | null> {
    const startedAt = this.host.now();
    let bundleId = this.stored(request.turnId);
    const kept = bundleId !== null;
    try {
      const set = deps;
      if (set === null) throw new BundleError("unwired");
      if (bundleId === null) {
        const active = await readActive(set);
        if (signal.aborted) return null;
        bundleId = this.store(request.turnId, active, startedAt);
      }
      const reader = new BundleReader(set.registry, set.kv ?? this.host.kv());
      const manifest = await readManifest(reader, bundleId);
      if (signal.aborted) return null;
      const trace = this.traceOf(request, bundleId);
      this.recordPinned(trace, request, startedAt, kept, reader);
      return { bundleId, bundle: new Pinned(bundleId, manifest, reader), trace };
    } catch (error) {
      if (!signal.aborted) this.recordFailed(request, bundleId, startedAt, codeOf(error));
      return null;
    }
  }

  /** Every turn's pin, in the order the pins were taken. */
  read(): PinEntry[] {
    return this.sql
      .exec<PinRow>("SELECT turn_id, bundle_hash, bundle_build, pinned_ms FROM turn_bundles ORDER BY rowid")
      .toArray()
      .map((row) => ({
        turnId: row.turn_id,
        bundleId: { hash: row.bundle_hash, build: row.bundle_build },
        pinnedAt: row.pinned_ms,
      }));
  }

  private stored(turnId: string): BundleId | null {
    const row = this.sql
      .exec<PinRow>(
        "SELECT turn_id, bundle_hash, bundle_build, pinned_ms FROM turn_bundles WHERE turn_id = ?",
        turnId,
      )
      .toArray()[0];
    return row === undefined ? null : { hash: row.bundle_hash, build: row.bundle_build };
  }

  /** Stores the pin unless one is stored already, and answers the stored one: the first pin of a turn id wins. */
  private store(turnId: string, bundleId: BundleId, at: number): BundleId {
    this.sql.exec(
      "INSERT OR IGNORE INTO turn_bundles (turn_id, bundle_hash, bundle_build, pinned_ms) VALUES (?, ?, ?, ?)",
      turnId,
      bundleId.hash,
      bundleId.build,
      at,
    );
    return this.stored(turnId) ?? bundleId;
  }

  private traceOf(request: PinRequest, bundleId: BundleId): TraceContext {
    const trace = openTrace({
      openedBy: "textWebhook",
      bundleId,
      incomingTraceId: request.traceId,
      sink: this.host.spanSink(),
      now: () => this.host.now(),
    });
    trace.setTurn(request.turnId);
    trace.listJoined(request.joinedTraceIds);
    return trace;
  }

  private recordPinned(
    trace: TraceContext,
    request: PinRequest,
    startedAt: number,
    kept: boolean,
    reader: BundleReader,
  ): void {
    try {
      trace.record({
        hop: "lease",
        at: new Date(startedAt).toISOString(),
        ms: Math.max(0, this.host.now() - startedAt),
        outcome: "ok",
        got: { texts: request.texts, manifestFrom: reader.reads()[0]?.from ?? null },
        decided: {
          leaseSeconds: Math.round(request.leaseMs / 1000),
          bundlePinned: true,
          bundleKept: kept,
          tries: request.tries,
          restart: request.restart,
        },
      });
    } catch {
      // No span for this pin; the pin stands.
    }
  }

  private recordFailed(
    request: PinRequest,
    pinned: BundleId | null,
    startedAt: number,
    code: BundleErrorCode,
  ): void {
    const bundleId = pinned ?? request.arrivedUnder;
    if (bundleId === null) return;
    try {
      this.traceOf(request, bundleId).record({
        hop: "lease",
        at: new Date(startedAt).toISOString(),
        ms: Math.max(0, this.host.now() - startedAt),
        outcome: "failed",
        errorCode: code,
        got: { texts: request.texts },
        decided: { bundlePinned: false, tries: request.tries, restart: request.restart },
      });
    } catch {
      // No span; the run still does not start.
    }
  }
}

/** K-05 v1 `readActiveBundle`, checked: an active id of K-01's form, with its manifest under K-01's key. */
async function readActive(set: BundleDeps): Promise<BundleId> {
  let answer: unknown;
  try {
    answer = await set.registry.readActiveBundle({});
  } catch {
    throw new BundleError("noAnswer");
  }
  if (typeof answer !== "object" || answer === null) throw new BundleError("badAnswer");
  const fields = answer as Record<string, unknown>;
  if (fields.error === "noActiveBundle") throw new BundleError("noActiveBundle");
  if (fields.error === "transient") throw new BundleError("transient");
  const bundleId = bundleIdOf(fields.bundleId);
  if (fields.result !== "active" || bundleId === null) throw new BundleError("badAnswer");
  if (fields.manifestKey !== keyOf(bundleId, "manifest")) throw new BundleError("badAnswer");
  return bundleId;
}
