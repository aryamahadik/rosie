// A numbered build (T-150; CQ-09; K-01 v1 manifest.bundleId and manifest.inputs), from fixture set v1's master flows
// and the barber shop (fixture set v1's demo shop): the bundle's id is the content hash of its stored values with the
// build number given, the same inputs give the same id and the same bytes, a changed trade file gives another id, and
// the manifest lists every input K-01 names. The all-trades build runs only through the CLI, never here (DL-099).
//
// Where a trade file must change, the test copies barber.json to a temporary folder, changes one word there, loads it
// with the trade loader and emits it with buildBundle()'s other inputs, assembled as buildBundle() assembles them;
// that the assembly matches is itself checked (the one-pass emit below gives buildBundle()'s bytes).
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SHARED_LIST_NAMES,
  checkBundlePart,
  collectSharedLists,
  compilerVersion,
  emitBundle,
  standInJudgmentRules,
  standInList,
  standInModelRouting,
  standInPrompts,
  type BundleFile,
  type BundleId,
  type EmitInputs,
  type SharedListName,
} from "../emit";
import { loadMaster } from "../load/flow";
import { TRADE_DIR, loadTrade, type LoadedTrade } from "../load/trade";
import {
  BundleIdError,
  PROVISIONAL_BUNDLE_ID,
  buildNumberedBundle,
  bundleIdProblems,
  bundleInputs,
  numberBundle,
  storedDigestsOfFiles,
  withBundleId,
  type NumberedBundle,
} from "./index";

const BUILT_AT = "2026-11-08T12:00:00Z";
const BUILD = 3;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface Manifest {
  bundleId: BundleId;
  builtAt: string;
  inputs: { kind: string; path: string; sha256: string }[];
  storage: { manifestKey: string; values: { key: string; sha256: string }[] };
}
const manifestOf = (bundle: { bundle: { manifest: unknown } }): Manifest =>
  bundle.bundle.manifest as Manifest;

/** K-01's hash, restated: one `<sha256>  <part>` line per file but the manifest, sorted by part. */
function restatedHash(files: readonly BundleFile[]): string {
  const values = files
    .filter((file) => file.path !== "manifest.json")
    .map((file) => [file.path.replace(/\.json$/, ""), sha256(file.text)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(values.map(([part, hash]) => `${hash}  ${part}\n`).join(""));
}

/** buildBundle()'s inputs for one loaded trade, assembled as buildBundle() assembles them (emit.ts), under `bundleId`. */
async function emitInputs(trade: LoadedTrade, bundleId: BundleId): Promise<EmitInputs> {
  const collected = await collectSharedLists();
  const lists = {} as Record<SharedListName, unknown>;
  for (const name of SHARED_LIST_NAMES) lists[name] = collected.lists[name] ?? standInList(name).value;
  return {
    master: loadMaster(),
    trades: [trade],
    bundleId,
    builtAt: BUILT_AT,
    compilerVersion: compilerVersion(),
    inputs: bundleInputs({ trades: [trade.id] }),
    prompts: standInPrompts().value,
    routing: standInModelRouting().value,
    judgmentRules: standInJudgmentRules().value,
    lists,
  };
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

let first: NumberedBundle;
let again: NumberedBundle;

beforeAll(async () => {
  first = await buildNumberedBundle({ trades: ["barber"], build: BUILD, builtAt: BUILT_AT });
  again = await buildNumberedBundle({ trades: ["barber"], build: BUILD, builtAt: BUILT_AT });
});

describe("a numbered build's bundle id", () => {
  it("is the content hash of its stored values, with the build number given", () => {
    expect(first.bundleId).toEqual({ hash: restatedHash(first.files), build: BUILD });
    expect(manifestOf(first).bundleId).toEqual(first.bundleId);
    expect(bundleIdProblems(manifestOf(first))).toEqual([]);
  });

  it("names every key: the manifest's own and each stored value's are under bundle/<hash>/<build>/", () => {
    const prefix = `bundle/${first.bundleId.hash}/${String(BUILD)}/`;
    const { storage } = manifestOf(first);
    expect(storage.manifestKey).toBe(`${prefix}manifest`);
    expect(storage.values.map((value) => value.key)).toEqual([
      `${prefix}flow/A`,
      `${prefix}flow/B`,
      `${prefix}trade/barber`,
    ]);
  });

  it("takes no stand-in for the bundle id or the inputs", () => {
    const named = first.standIns.map((standIn) => standIn.what);
    expect(named).not.toContain("bundle id");
    expect(named).not.toContain("inputs");
  });

  it("the bundle validates against K-01 v1: as one document, and its manifest alone", () => {
    expect(checkBundlePart(first.bundle)).toEqual([]);
    expect(checkBundlePart(JSON.parse(first.files[2]?.text ?? "null"), "manifest")).toEqual([]);
    expect(first.files.map((file) => file.path)).toEqual([
      "flow/A.json",
      "flow/B.json",
      "manifest.json",
      "trade/barber.json",
    ]);
  });

  it("the manifest lists every input K-01 names for the trades it holds, fixture set v1's manifest among them", () => {
    const { inputs } = manifestOf(first);
    expect(inputs).toEqual(bundleInputs({ trades: ["barber"] }));
    expect(inputs.map((input) => input.kind)).toEqual([
      "masterFlow",
      "masterFlow",
      "trade",
      "masterCorrections",
      "lines",
      "fixtureSetManifest",
      "referenceCode",
      "referenceCode",
      "referenceCode",
    ]);
    expect(inputs.find((input) => input.kind === "fixtureSetManifest")).toEqual({
      kind: "fixtureSetManifest",
      path: "fixtures/v1/MANIFEST.sha256",
      sha256: sha256(readFileSync(new URL("../../../fixtures/v1/MANIFEST.sha256", import.meta.url), "utf8")),
    });
  });
});

describe("the same inputs give the same id; a changed trade file gives another", () => {
  it("two builds from the same inputs: the same id and the same files, byte for byte", () => {
    expect(again.bundleId).toEqual(first.bundleId);
    expect(again.files).toEqual(first.files);
  });

  it("the id stands where emitBundle() puts an id it is given: a one-pass emit under it writes the same bytes", async () => {
    const direct = emitBundle(await emitInputs(loadTrade("barber"), first.bundleId));
    expect(direct.files).toEqual(first.files);
  });

  it("changing one word of barber.json changes the id; only barber's stored value differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-id-trade-"));
    made.push(dir);
    const file = join(dir, "barber.json");
    cpSync(join(TRADE_DIR, "barber.json"), file);
    const text = readFileSync(file, "utf8");
    expect(text).toContain('"name": "Barber",');
    writeFileSync(file, text.replace('"name": "Barber",', '"name": "Barbers",'));

    const changed = numberBundle(
      emitBundle(await emitInputs(loadTrade("barber", dir), { ...PROVISIONAL_BUNDLE_ID })),
      BUILD,
    );
    expect(changed.bundleId.hash).not.toBe(first.bundleId.hash);
    expect(changed.bundleId).toEqual({ hash: restatedHash(changed.files), build: BUILD });
    const before = new Map(storedDigestsOfFiles(first.files).map((value) => [value.part, value.sha256]));
    const differ = storedDigestsOfFiles(changed.files)
      .filter((value) => before.get(value.part) !== value.sha256)
      .map((value) => value.part);
    expect(differ).toEqual(["trade/barber"]);
    expect(bundleIdProblems(manifestOf(changed))).toEqual([]);
    // Different content, different keys: the changed bundle writes nowhere the first one is stored.
    expect(manifestOf(changed).storage.values.map((value) => value.key)).not.toContain(
      manifestOf(first).storage.values[0]?.key,
    );
  });
});

describe("the build number", () => {
  it("another build number keeps the hash and the stored values and moves every key, so no key is written twice", () => {
    const next = numberBundle(first, BUILD + 1);
    expect(next.bundleId).toEqual({ hash: first.bundleId.hash, build: BUILD + 1 });
    expect(bundleIdProblems(manifestOf(next))).toEqual([]);
    const values = (files: readonly BundleFile[]): BundleFile[] =>
      files.filter((file) => file.path !== "manifest.json");
    expect(values(next.files)).toEqual(values(first.files));
    const keys = new Set(manifestOf(first).storage.values.map((value) => value.key));
    for (const value of manifestOf(next).storage.values) expect(keys.has(value.key), value.key).toBe(false);
    expect(manifestOf(next).storage.manifestKey).not.toBe(manifestOf(first).storage.manifestKey);
  });

  it("withBundleId changes only the id and the keys: the manifest under the first id again is the first's bytes", () => {
    const back = withBundleId(numberBundle(first, 9), first.bundleId);
    expect(back.files).toEqual(first.files);
  });

  it("refuses a build number that does not count from 1, before it builds anything", async () => {
    expect(() => numberBundle(first, 0)).toThrow(BundleIdError);
    expect(() => numberBundle(first, 1.5)).toThrow(BundleIdError);
    await expect(buildNumberedBundle({ trades: ["barber"], build: 0 })).rejects.toThrow(
      /0 is not a build number/,
    );
  });

  it("refuses an id whose hash is not a sha256 in lowercase hex", () => {
    expect(() => withBundleId(first, { hash: "AB".repeat(32), build: 1 })).toThrow(BundleIdError);
    expect(() => withBundleId(first, { hash: "ab", build: 1 })).toThrow(/is not a sha256 in lowercase hex/);
  });
});
