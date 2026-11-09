// T-152 without a database: a bundle directory read for publishing (its parts under their K-01 keys, byte for byte), the
// KV bulk file (one entry per part, every key prefixed by the bundle id), the file's place, and the refusals that come
// before anything is written or the database is opened. PostgreSQL's copy is publish.int.test.ts's. One trade only:
// the all-trades build is the CLI's, not a unit test (DL-099).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNumberedBundle, withBundleId, type NumberedBundle } from "../bundle-id";
import { main, type CliIo } from "../cli/index";
import { writeBundle, type BundleFile } from "../emit";
import {
  PublishError,
  checkKvFile,
  defaultKvFile,
  kvBulkEntries,
  kvBulkText,
  readPublishable,
  type PublishableBundle,
} from "./index";

const BUILD = 4;
const BUILT_AT = "2026-11-09T10:00:00Z";
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

const encoder = new TextEncoder();

/** True when two byte strings are the same bytes (the test's own comparison, not the publisher's). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, k) => byte === b[k]);
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `publish-${label}-`));
  made.push(dir);
  return dir;
}

/** The files written into a new folder `bundle` of a temporary folder: that folder. */
function written(files: BundleFile[], label: string): string {
  const dir = join(tempDir(label), "bundle");
  writeBundle(dir, files);
  return dir;
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

let built: NumberedBundle;
let dir: string;
let bundle: PublishableBundle;
let prefix: string;

beforeAll(async () => {
  built = await buildNumberedBundle({ trades: ["barber"], build: BUILD, builtAt: BUILT_AT });
  dir = written(built.files, "numbered");
  bundle = readPublishable(dir);
  prefix = `bundle/${built.bundleId.hash}/${String(BUILD)}/`;
});

describe("a bundle directory read for publishing", () => {
  it("names the bundle's own id, build time and manifest key", () => {
    expect(bundle.bundleId).toEqual(built.bundleId);
    expect(bundle.builtAt).toBe(BUILT_AT);
    expect(bundle.manifestKey).toBe(`${prefix}manifest`);
    expect(bundle.dir).toBe(dir);
  });

  it("holds every file as one part under its K-01 key, the manifest first, then the values its storage lists", () => {
    expect(bundle.parts.map((part) => [part.key, part.kind, part.path])).toEqual([
      [`${prefix}manifest`, "manifest", "manifest.json"],
      [`${prefix}flow/A`, "flow", "flow/A.json"],
      [`${prefix}flow/B`, "flow", "flow/B.json"],
      [`${prefix}trade/barber`, "trade", "trade/barber.json"],
    ]);
    expect(bundle.parts).toHaveLength(built.files.length);
  });

  it("gives each part the file's bytes exactly, with their size and sha256", () => {
    for (const part of bundle.parts) {
      const raw = readFileSync(join(dir, ...part.path.split("/")));
      expect(sameBytes(encoder.encode(part.text), raw), part.path).toBe(true);
      expect(part.bytes, part.path).toBe(raw.length);
      expect(part.sha256, part.path).toBe(sha256(raw));
    }
  });

  it("refuses a bundle whose id is not the content hash of its stored values (a stand-in id)", () => {
    const standIn = written(withBundleId(built, { hash: "0".repeat(64), build: 1 }).files, "standin");
    expect(() => readPublishable(standIn)).toThrow(PublishError);
    expect(() => readPublishable(standIn)).toThrow(/bundle id does not hold.*compiler build --build <n>/);
  });

  it("refuses a bundle whose file is not the value its manifest lists", () => {
    const files = built.files.map((file) =>
      file.path === "trade/barber.json" ? { path: file.path, text: `${file.text} ` } : file,
    );
    const tampered = written(files, "tampered");
    expect(() => readPublishable(tampered)).toThrow(PublishError);
    expect(() => readPublishable(tampered)).toThrow(/is not a sound bundle: .*trade\/barber\.json/);
  });

  it("refuses a folder that holds no bundle, and one that does not exist", () => {
    const empty = tempDir("empty");
    expect(() => readPublishable(empty)).toThrow(/is not a bundle directory: .*no manifest\.json/);
    expect(() => readPublishable(join(empty, "missing"))).toThrow(PublishError);
  });
});

describe("the KV bulk file", () => {
  it("has one entry per part, every key prefixed by the bundle id, each value the part's text", () => {
    const entries = kvBulkEntries(bundle);
    expect(entries).toHaveLength(bundle.parts.length);
    for (const [k, entry] of entries.entries()) {
      expect(Object.keys(entry)).toEqual(["key", "value"]);
      expect(entry.key.startsWith(prefix), entry.key).toBe(true);
      expect(entry).toEqual({ key: bundle.parts[k]?.key, value: bundle.parts[k]?.text });
    }
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  it("is those entries as one JSON array, the form `wrangler kv bulk put` reads", () => {
    const parsed = JSON.parse(kvBulkText(bundle)) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(kvBulkEntries(bundle));
  });

  it("goes beside the bundle directory by default", () => {
    expect(defaultKvFile(dir)).toBe(`${dir}.kv.json`);
    expect(defaultKvFile(`${dir}/`)).toBe(`${dir}.kv.json`);
  });

  it("takes a new place, or one that holds these entries already; never other entries, a folder or the bundle's own", () => {
    const text = kvBulkText(bundle);
    const place = join(tempDir("kv"), "bundle.kv.json");
    expect(checkKvFile(place, text, dir)).toBe(false);
    writeFileSync(place, text);
    expect(checkKvFile(place, text, dir)).toBe(true);
    writeFileSync(place, "[]");
    expect(() => checkKvFile(place, text, dir)).toThrow(/already holds other entries/);
    expect(readFileSync(place, "utf8")).toBe("[]");
    expect(() => checkKvFile(tempDir("folder"), text, dir)).toThrow(/is not a file/);
    expect(() => checkKvFile(join(dir, "bundle.kv.json"), text, dir)).toThrow(/inside the bundle directory/);
    expect(() => checkKvFile(dir, text, dir)).toThrow(/inside the bundle directory/);
  });
});

describe("compiler publish, before it opens the database", () => {
  it.each([
    [[], /<bundle dir> is required/],
    [["--kv"], /--kv needs a value/],
    [["a", "b"], /one bundle directory only: "b" is a second/],
    [["a", "--out", "x"], /unknown argument "--out"/],
    [["a", "--kv", "x", "--kv", "y"], /--kv is given twice/],
  ] as const)("refuses %j as misuse (exit 2)", async (args, message) => {
    const run = capture();
    expect(await main(["publish", ...args], run.io)).toBe(2);
    expect(run.err.join("\n")).toMatch(message);
    expect(run.err).toContain("usage: publish <bundle dir> [--kv <file>]");
  });

  it("refuses a bundle with a stand-in id (exit 1), writing nothing", async () => {
    const standIn = written(withBundleId(built, { hash: "0".repeat(64), build: 1 }).files, "standin-cli");
    const run = capture();
    expect(await main(["publish", standIn], run.io)).toBe(1);
    expect(run.err[0]).toMatch(/^refused: .*bundle id does not hold/);
    expect(run.err).toContain("nothing was written");
    expect(existsSync(defaultKvFile(standIn))).toBe(false);
  });

  it("refuses a KV bulk file inside the bundle directory (exit 1), writing nothing", async () => {
    const run = capture();
    expect(await main(["publish", dir, "--kv", join(dir, "bundle.kv.json")], run.io)).toBe(1);
    expect(run.err[0]).toMatch(/^refused: .*inside the bundle directory/);
    expect(existsSync(join(dir, "bundle.kv.json"))).toBe(false);
    expect(readPublishable(dir).parts).toEqual(bundle.parts);
  });
});
