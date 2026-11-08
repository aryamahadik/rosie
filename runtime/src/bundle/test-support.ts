// Doubles for the bundle pin's tests (T-249). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - K-05 v1 `readActiveBundle` answers active-bundle.json's outcome while bundle A is active (K-01's bundle v0, whose id
//     that fixture names), the same shape for bundle B (K-01's bundle-mini-a.json), and `noActiveBundle` with none;
//   - K-05 v1 `readBundleValue` answers in bundle-value-on-miss.json's shape, from PostgreSQL's copy of both bundles;
//   - the KV namespace holds the same values under the same K-01 keys.
//
// Each value is its part of the sample bundle as the compiler stores it, JSON text (`JSON.stringify`): the sizes and
// sha256 the sample manifests list, whose hash is the bundle id. The sizes and hashes here are computed with WebCrypto
// directly, not with the code under test. Test values only (rule 9).

import activeBundle from "../../../contracts/data-access/fixtures/active-bundle.json";
import bundleMiniA from "../../../contracts/bundle/fixtures/bundle-mini-a.json";
import bundleV0 from "../../../contracts/bundle/fixtures/bundle-v0-skeleton.json";
import type { BundleId } from "../trace";
import type {
  ActiveBundle,
  BundleDeps,
  ReadActiveBundleAnswer,
  ReadBundleValueAnswer,
  StoredText,
  ValueKind,
} from "./types";

/** A whole K-01 v1 bundle (the schema's root): its manifest, flow graphs and trade overlays. */
export interface WholeBundle {
  manifest: {
    bundleId: BundleId;
    storage: { values: { key: string; kind: "flow" | "trade"; flow?: string; trade?: string }[] };
  };
  flows: Record<string, unknown>;
  trades: Record<string, unknown>;
}

/** Bundle A's whole document: K-01's bundle v0 (flow A holding S1-01 and S1-02), the one active-bundle.json names. */
export const WHOLE_A = bundleV0 as unknown as WholeBundle;
/** Bundle B's whole document: K-01's bundle-mini-a.json (flow A and the barber trade), the next build to switch to. */
export const WHOLE_B = bundleMiniA as unknown as WholeBundle;

export const BUNDLE_A: BundleId = {
  hash: WHOLE_A.manifest.bundleId.hash,
  build: WHOLE_A.manifest.bundleId.build,
};
export const BUNDLE_B: BundleId = {
  hash: WHOLE_B.manifest.bundleId.hash,
  build: WHOLE_B.manifest.bundleId.build,
};

/** K-05's active-bundle.json outcome, as it states it. */
export const ACTIVE_A = activeBundle.outcome as ActiveBundle;

/** A K-01 v1 key, spelled out here for the doubles: bundle/<hash>/<build>/<part>. */
export function keyIn(bundleId: BundleId, part: string): string {
  return `bundle/${bundleId.hash}/${String(bundleId.build)}/${part}`;
}

/** Each value of a whole bundle under its K-01 key, as the deploy writes it to KV and to PostgreSQL's copy. */
function valuesOf(bundle: WholeBundle): [string, { kind: ValueKind; text: string }][] {
  const values: [string, { kind: ValueKind; text: string }][] = [
    [
      keyIn(bundle.manifest.bundleId, "manifest"),
      { kind: "manifest", text: JSON.stringify(bundle.manifest) },
    ],
  ];
  for (const value of bundle.manifest.storage.values) {
    const part = value.kind === "flow" ? bundle.flows[value.flow ?? ""] : bundle.trades[value.trade ?? ""];
    values.push([value.key, { kind: value.kind, text: JSON.stringify(part) }]);
  }
  return values;
}

/** Every stored value of bundles A and B, by key. */
export const STORED: ReadonlyMap<string, { kind: ValueKind; text: string }> = new Map([
  ...valuesOf(WHOLE_A),
  ...valuesOf(WHOLE_B),
]);

/** The stored text under a key (a test's own lookup). */
export function textAt(key: string): string {
  const value = STORED.get(key);
  if (value === undefined) throw new Error(`no stored value under ${key}`);
  return value.text;
}

async function storedText(key: string, kind: ValueKind, text: string): Promise<StoredText> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { key, kind, bytes: data.byteLength, sha256, text };
}

export interface FakeBundles {
  /** What `setBundleDeps` takes. */
  readonly deps: BundleDeps;
  /** Which bundle K-05 answers as active; null: none yet (before the first deploy's step 3). */
  active: "A" | "B" | null;
  /** Every K-05 call, in order, with the key it asked for. */
  readonly calls: { call: "readActiveBundle" | "readBundleValue"; key: string | null }[];
  /** Every KV read, in order. */
  readonly kvReads: string[];
  /** Keys KV has no value for yet: a new bundle's keys take about 60 s to reach every KV location (arch 10 line 518). */
  readonly kvMissing: Set<string>;
  /** Text KV holds under a key instead of the stored value. */
  readonly kvHolds: Map<string, string>;
  /** What PostgreSQL's copy answers for a key instead of the stored value. */
  readonly postgres: Map<string, ReadBundleValueAnswer>;
}

function activeAnswer(active: FakeBundles["active"]): ReadActiveBundleAnswer {
  if (active === null) return { error: "noActiveBundle" };
  if (active === "A") return { ...ACTIVE_A, bundleId: { ...ACTIVE_A.bundleId } };
  return {
    result: "active",
    bundleId: { ...BUNDLE_B },
    manifestKey: keyIn(BUNDLE_B, "manifest"),
    activatedAt: "2026-11-07T15:10:00Z",
  };
}

/**
 * K-05's two bundle reads and the KV namespace, over bundles A and B. Bundle A is active at first. `kv: false` leaves the
 * KV double out of the deps, so the actor falls back to its own BUNDLES binding (none in the test pool).
 */
export function fakeBundles(options: { kv?: boolean } = {}): FakeBundles {
  const fake: FakeBundles = {
    active: "A",
    calls: [],
    kvReads: [],
    kvMissing: new Set(),
    kvHolds: new Map(),
    postgres: new Map(),
    deps: {
      registry: {
        readActiveBundle() {
          fake.calls.push({ call: "readActiveBundle", key: null });
          return Promise.resolve(activeAnswer(fake.active));
        },
        readBundleValue({ key }): Promise<ReadBundleValueAnswer> {
          fake.calls.push({ call: "readBundleValue", key });
          const instead = fake.postgres.get(key);
          if (instead !== undefined) return Promise.resolve(instead);
          const value = STORED.get(key);
          if (value === undefined) {
            return Promise.resolve({ error: "notFound", table: "bundle_values", rowId: key });
          }
          return storedText(key, value.kind, value.text).then((stored): ReadBundleValueAnswer => ({
            result: "value",
            value: stored,
          }));
        },
      },
      ...(options.kv === false
        ? {}
        : {
            kv: {
              get(key: string): Promise<string | null> {
                fake.kvReads.push(key);
                const held = fake.kvHolds.get(key);
                if (held !== undefined) return Promise.resolve(held);
                const value = STORED.get(key);
                return Promise.resolve(value === undefined || fake.kvMissing.has(key) ? null : value.text);
              },
            },
          }),
    },
  };
  return fake;
}
