// The seed of the bundle-backed BundleSafety's test file (T-1397; infra/test-rig/files.mjs, key BUNDLE_SAFETY): the
// bundles its checks need beside the template's bundle v0, written into PostgreSQL's copy (K-04 v1 `bundles` and
// `bundle_values`) as a publish writes them, none of them active. The rig's globalSetup (infra/test-rig/rig.mjs) runs
// `seed` once, in Node, on this file's database, after the migrations and bundle v0, with a client of the connecting
// login; the test file imports `seedBundles` for the same bundles' ids and values.
//
// Each bundle is made from what the repository already holds, with no words of its own (rule 9: test values only, the
// master's sample words as K-01's fixtures and bundle v0 carry them):
//   noEmergencyWords, noCrisisWords, noAskWords
//                 bundle v0 (bundles/v0/bundle: its manifest and its flow A) with that one safety line as K-01 v1 writes a
//                 line that has no words yet (status pendingJay, text null: fixed-lines.json's stopReply).
//   second        bundle v0 with its outage line written that way: a second bundle the check passes, whose lines differ
//                 from v0's in that one line, for the switch.
//   emergencyStep bundle v0's manifest over K-01's bundle-mini-a.json's flow A, which holds the danger check A3-22 and
//                 its emergency step A3-24, and no A3-49: a bundle the check passes that holds an outcome step.
//   harmStep      the same with a step A3-49: bundle-mini-a.json's A3-24, under that id. Its line is K-01's 911 line,
//                 which names no hotline.
// Every bundle id is K-01 v1's: the hash of its stored values' lines (contracts/bundle README, "Storage"), computed here
// with WebCrypto, never with the code under test, and a build number of its own. The v0 variants keep v0's flow A, so
// its hash, under builds no publish of v0 used. Nothing here needs Node or the Workers runtime alone: the test file loads
// it inside workerd, and the rig in Node.
import flowAV0 from "../../../../bundles/v0/bundle/flow/A.json";
import manifestV0 from "../../../../bundles/v0/bundle/manifest.json";
import bundleMiniA from "../../../../contracts/bundle/fixtures/bundle-mini-a.json";
import type { Sql } from "../../../../db/repo/scope";

type Json = Record<string, unknown>;

/** One stored value of a seeded bundle, as PostgreSQL's copy and KV hold it. */
export interface SeedValue {
  readonly key: string;
  readonly kind: "manifest" | "flow";
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The flow graphs a bundle holds, by flow letter. */
export type SeedFlows = Readonly<Partial<Record<"A" | "B", Json>>>;

/** One bundle: its K-01 id, its manifest and flow graphs as objects, and its stored values (the manifest first). */
export interface SeedBundle {
  readonly bundleId: { readonly hash: string; readonly build: number };
  readonly manifest: Json;
  readonly flows: SeedFlows;
  readonly values: readonly SeedValue[];
}

/** The seeded bundles, by name (the top of this file). */
export type SeedBundleName =
  "noEmergencyWords" | "noCrisisWords" | "noAskWords" | "second" | "emergencyStep" | "harmStep";

/** Bundle v0 as bundles/v0 holds it and the rig publishes it, active: its id, manifest and flow A. */
export const V0_MANIFEST = manifestV0 as unknown as Json;
export const V0_FLOW_A = flowAV0 as unknown as Json;
export const V0_ID = (manifestV0 as unknown as { bundleId: { hash: string; build: number } }).bundleId;

/** K-01's bundle-mini-a.json flow A: the danger check A3-22 with its emergency step A3-24. */
export const MINI_FLOW_A = (bundleMiniA as unknown as { flows: { A: Json } }).flows.A;

/** Each seeded bundle's build number: none is a build bundle v0 was published under (1 and 2). */
const BUILDS: Readonly<Record<SeedBundleName, number>> = {
  noEmergencyWords: 11,
  noCrisisWords: 12,
  noAskWords: 13,
  second: 21,
  emergencyStep: 31,
  harmStep: 32,
};

const BUILT_AT = "2026-11-14T12:00:00Z";

const encoder = new TextEncoder();

async function measure(text: string): Promise<{ bytes: number; sha256: string }> {
  const data = encoder.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes: data.byteLength, sha256 };
}

/** One K-01 v1 fixed line, as a manifest's lists hold it. */
export interface FixedLine {
  readonly id: string;
  readonly lang: string;
  readonly [field: string]: unknown;
}

/** Bundle v0's fixed lines with the English line `id` as K-01 v1 writes a line that has no words yet. */
export function withoutWords(id: string): FixedLine[] {
  const lists = V0_MANIFEST.lists as { fixedLines: { lines: FixedLine[] } };
  return lists.fixedLines.lines.map((line) =>
    line.id === id && line.lang === "en" ? { ...line, text: null, status: "pendingJay" } : { ...line },
  );
}

/**
 * A bundle of these flow graphs under bundle v0's manifest, with these fixed lines when given: its K-01 id under `build`
 * and its stored values. The test file makes its own small bundles with it too.
 */
export async function bundleOf(
  build: number,
  flows: SeedFlows,
  fixedLines?: FixedLine[],
): Promise<SeedBundle> {
  const stored: { letter: "A" | "B"; text: string; bytes: number; sha256: string }[] = [];
  for (const letter of ["A", "B"] as const) {
    const flow = flows[letter];
    if (flow === undefined) continue;
    const text = JSON.stringify(flow);
    stored.push({ letter, text, ...(await measure(text)) });
  }
  // K-01 v1 "Storage": one line "<sha256>  <key part>" per stored value, sorted by key part, each ending in a newline.
  const { sha256: hash } = await measure(
    stored.map((flow) => `${flow.sha256}  flow/${flow.letter}\n`).join(""),
  );
  const prefix = `bundle/${hash}/${String(build)}/`;
  const manifest: Json = {
    ...structuredClone(V0_MANIFEST),
    bundleId: { hash, build },
    builtAt: BUILT_AT,
    storage: {
      manifestKey: `${prefix}manifest`,
      values: stored.map((flow) => ({
        key: `${prefix}flow/${flow.letter}`,
        kind: "flow",
        flow: flow.letter,
        bytes: flow.bytes,
        sha256: flow.sha256,
      })),
    },
  };
  if (fixedLines !== undefined) {
    manifest.lists = { ...(manifest.lists as Json), fixedLines: { lines: fixedLines } };
  }
  const manifestText = JSON.stringify(manifest);
  return {
    bundleId: { hash, build },
    manifest,
    flows,
    values: [
      { key: `${prefix}manifest`, kind: "manifest", text: manifestText, ...(await measure(manifestText)) },
      ...stored.map((flow): SeedValue => ({
        key: `${prefix}flow/${flow.letter}`,
        kind: "flow",
        text: flow.text,
        bytes: flow.bytes,
        sha256: flow.sha256,
      })),
    ],
  };
}

/** K-01's bundle-mini-a.json flow A with a step A3-49: its A3-24, under that id. */
function miniFlowWithHarmStep(): Json {
  const flow = structuredClone(MINI_FLOW_A);
  const steps = flow.steps as Record<string, Json>;
  const emergency = steps["A3-24"];
  if (emergency === undefined) throw new Error("K-01's bundle-mini-a.json flow A holds no A3-24");
  steps["A3-49"] = { ...structuredClone(emergency), id: "A3-49", text: "A3-49" };
  return flow;
}

/** Every seeded bundle, by name: the same ids and bytes at each call. */
export async function seedBundles(): Promise<Readonly<Record<SeedBundleName, SeedBundle>>> {
  const v0 = { A: V0_FLOW_A };
  return {
    noEmergencyWords: await bundleOf(BUILDS.noEmergencyWords, v0, withoutWords("safetyEmergency")),
    noCrisisWords: await bundleOf(BUILDS.noCrisisWords, v0, withoutWords("safetyCrisis")),
    noAskWords: await bundleOf(BUILDS.noAskWords, v0, withoutWords("safetyAsk")),
    second: await bundleOf(BUILDS.second, v0, withoutWords("outage")),
    emergencyStep: await bundleOf(BUILDS.emergencyStep, { A: structuredClone(MINI_FLOW_A) }),
    harmStep: await bundleOf(BUILDS.harmStep, { A: miniFlowWithHarmStep() }),
  };
}

/** Seeds this file's database (see the top of this file): each bundle's registry row, not active, and its values. */
export async function seed(sql: Sql): Promise<void> {
  for (const bundle of Object.values(await seedBundles())) {
    const { hash, build } = bundle.bundleId;
    const [manifest] = bundle.values;
    if (manifest === undefined) throw new Error("a seeded bundle has no manifest");
    await sql`
      insert into bundles (hash, build, manifest_key, built_at)
      values (${hash}, ${build}, ${manifest.key}, ${BUILT_AT}::timestamptz)
    `;
    for (const value of bundle.values) {
      await sql`
        insert into bundle_values (key, bundle_hash, bundle_build, kind, bytes, sha256, value)
        values (
          ${value.key}, ${hash}, ${build}, ${value.kind}, ${value.bytes}, ${value.sha256},
          ${encoder.encode(value.text)}::bytea
        )
      `;
    }
  }
}
