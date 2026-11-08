// Reading a bundle's values under its id (T-249; arch 10 line 536: "then that bundle's step graph from KV, or from
// PostgreSQL on a miss"; K-01 v1 storage; K-05 v1 item 7). Every value is checked before a turn may use it:
//
//   - the manifest names the pinned bundle id and its own key, and its stored values hash to the id (K-01 v1: the id's
//     hash is the sha256 of one line "<sha256>  <key part>" per stored value, sorted by key part, each ending in a newline);
//   - a flow graph or trade overlay has the size and sha256 the manifest lists, and is the flow or trade asked for;
//   - a value from PostgreSQL's copy also matches its own stored size and sha256 (K-05 v1 `storedText`: the reader checks).
//
// KV first. A miss (KV takes about 60 s to propagate, arch 10 line 518), a KV failure, or bytes that are not the bundle's
// own all read PostgreSQL's copy through K-05; a value no copy holds as the bundle's own is refused. Never logged: a value.

import { bundleIdProblems, type BundleId } from "../trace";
import {
  BundleError,
  type BundleKv,
  type BundleRegistry,
  type FlowGraph,
  type FlowLetter,
  type Manifest,
  type PartRead,
  type StoredValue,
  type TradeOverlay,
  type ValueKind,
} from "./types";

/** Cloudflare KV's value size limit, which K-01 v1 holds every stored value to (`storedValue.bytes`). */
const MAX_VALUE_BYTES = 26_214_400;
const SHA256 = /^[0-9a-f]{64}$/u;
const TRADE_ID = /^[a-z0-9][a-z0-9-]*$/u;

const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The K-01 v1 key of one of a bundle's values: bundle/<hash>/<build>/manifest, .../flow/<A or B>, .../trade/<trade id>. */
export function keyOf(bundleId: BundleId, part: string): string {
  return `bundle/${bundleId.hash}/${String(bundleId.build)}/${part}`;
}

export function sameBundle(a: BundleId, b: BundleId): boolean {
  return a.hash === b.hash && a.build === b.build;
}

/** A K-01 bundle id from an untrusted value, or null when it is not one (a 64-hex hash and a build from 1). */
export function bundleIdOf(value: unknown): BundleId | null {
  if (!isRecord(value) || bundleIdProblems(value).length > 0) return null;
  return { hash: value.hash as string, build: value.build as number };
}

/** A value's size in UTF-8 bytes and its sha256 in lowercase hex. */
export async function measure(text: string): Promise<{ bytes: number; sha256: string }> {
  const data = encoder.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes: data.byteLength, sha256 };
}

/** The bundle id's hash, as K-01 v1 spells it, from the stored values a manifest lists. */
export async function bundleHashOf(bundleId: BundleId, values: readonly StoredValue[]): Promise<string> {
  const prefix = keyOf(bundleId, "");
  const lines = values
    .map((value) => ({ part: value.key.slice(prefix.length), sha256: value.sha256 }))
    .sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : 0))
    .map((line) => `${line.sha256}  ${line.part}\n`)
    .join("");
  return (await measure(lines)).sha256;
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** One of a manifest's stored values, when it is K-01's shape and under this bundle's own keys. */
function storedValueOf(entry: unknown, bundleId: BundleId): StoredValue | null {
  if (!isRecord(entry)) return null;
  const { key, kind, flow, trade, bytes, sha256 } = entry;
  if (typeof key !== "string" || typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_VALUE_BYTES)
    return null;
  if (kind === "flow" && (flow === "A" || flow === "B") && key === keyOf(bundleId, `flow/${flow}`)) {
    return { key, kind, flow, bytes, sha256 };
  }
  if (
    kind === "trade" &&
    typeof trade === "string" &&
    TRADE_ID.test(trade) &&
    key === keyOf(bundleId, `trade/${trade}`)
  ) {
    return { key, kind, trade, bytes, sha256 };
  }
  return null;
}

/**
 * The manifest in `text`, when it is the manifest of `bundleId`: K-01 v1's contract, the same bundle id, its own key, and
 * stored values under this bundle's keys, each once, that hash to the id. Otherwise null.
 */
export async function manifestOf(text: string, bundleId: BundleId): Promise<Manifest | null> {
  const manifest = parsed(text);
  if (manifest?.contract !== "bundle.v1") return null;
  const named = bundleIdOf(manifest.bundleId);
  if (named === null || !sameBundle(named, bundleId)) return null;
  const storage = manifest.storage;
  if (!isRecord(storage) || storage.manifestKey !== keyOf(bundleId, "manifest")) return null;
  if (!Array.isArray(storage.values) || storage.values.length === 0) return null;
  const values: StoredValue[] = [];
  for (const entry of storage.values) {
    const value = storedValueOf(entry, bundleId);
    if (value === null || values.some((seen) => seen.key === value.key)) return null;
    values.push(value);
  }
  if ((await bundleHashOf(bundleId, values)) !== bundleId.hash) return null;
  return {
    ...manifest,
    contract: "bundle.v1",
    bundleId: { hash: bundleId.hash, build: bundleId.build },
    storage: { manifestKey: keyOf(bundleId, "manifest"), values },
  };
}

/** The flow graph in `text`, when it is K-01's flow `flow`. */
export function flowOf(text: string, flow: FlowLetter): FlowGraph | null {
  const graph = parsed(text);
  return graph?.contract === "bundle.v1" && graph.flow === flow ? graph : null;
}

/** The trade overlay in `text`, when it is K-01's overlay of trade `tradeId`. */
export function tradeOf(text: string, tradeId: string): TradeOverlay | null {
  const overlay = parsed(text);
  if (overlay?.contract !== "bundle.v1") return null;
  const trade = overlay.trade;
  return isRecord(trade) && trade.id === tradeId ? overlay : null;
}

/** What a value's text measured: its size and sha256, beside the text. */
export interface Measured {
  text: string;
  bytes: number;
  sha256: string;
}

/** Reads one bundle's values: KV first, then PostgreSQL's copy through K-05, each value checked before it is used. */
export class BundleReader {
  private readonly log: PartRead[] = [];

  constructor(
    private readonly registry: BundleRegistry,
    private readonly kv: BundleKv | null,
  ) {}

  /** Every value read so far, in order, with where it came from. */
  reads(): PartRead[] {
    return this.log.map((read) => ({ ...read }));
  }

  /**
   * The value under `key`, as `accept` makes it from the text: KV's copy when `accept` takes it, else PostgreSQL's (after
   * K-05's own size and sha256 check). Throws a BundleError when PostgreSQL's copy is missing, unreachable or refused too.
   */
  async read<T>(key: string, kind: ValueKind, accept: (value: Measured) => Promise<T | null>): Promise<T> {
    const cached = await this.fromKv(key);
    if (cached !== null) {
      const value = await accept(await measured(cached));
      if (value !== null) {
        this.log.push({ key, kind, from: "kv" });
        return value;
      }
    }
    const stored = await this.fromPostgres(key, kind);
    const value = await accept(stored);
    if (value === null) throw new BundleError("unreadable");
    this.log.push({ key, kind, from: "postgres" });
    return value;
  }

  /** KV's text, or null: a miss, no KV in this environment, or a KV call that failed (PostgreSQL's copy is read instead). */
  private async fromKv(key: string): Promise<string | null> {
    if (this.kv === null) return null;
    try {
      const text: unknown = await this.kv.get(key);
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  }

  /** K-05 v1 `readBundleValue`, checked: the key and kind asked for, and the text's size and sha256 as stored. */
  private async fromPostgres(key: string, kind: ValueKind): Promise<Measured> {
    let answer: unknown;
    try {
      answer = await this.registry.readBundleValue({ key });
    } catch {
      throw new BundleError("noAnswer");
    }
    if (!isRecord(answer)) throw new BundleError("badAnswer");
    if (answer.error === "notFound") throw new BundleError("notFound");
    if (answer.error === "transient") throw new BundleError("transient");
    const value = answer.value;
    if (answer.result !== "value" || !isRecord(value) || typeof value.text !== "string") {
      throw new BundleError("badAnswer");
    }
    const text = await measured(value.text);
    const own = value.key === key && value.kind === kind;
    if (!own || value.bytes !== text.bytes || value.sha256 !== text.sha256)
      throw new BundleError("unreadable");
    return text;
  }
}

async function measured(text: string): Promise<Measured> {
  return { text, ...(await measure(text)) };
}

/** The bundle's manifest, read under its id and checked against it. */
export function readManifest(reader: BundleReader, bundleId: BundleId): Promise<Manifest> {
  return reader.read(keyOf(bundleId, "manifest"), "manifest", (value) => manifestOf(value.text, bundleId));
}

/** True when a value has the size and sha256 its manifest lists. */
export function asListed(value: Measured, listed: StoredValue): boolean {
  return value.bytes === listed.bytes && value.sha256 === listed.sha256;
}
