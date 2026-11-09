// T-152 against local PostgreSQL (`npm run db:up`; `npm run test:integration -- compiler/src/publish`): a numbered build
// of fixture set v1's master flows and two trades (the barber shop, a demo shop, and the first other trade), published by
// `compiler publish`'s code and by the command itself into a fresh test schema migrated with every migration
// (db/repo/test-db.ts; the schema is dropped when the file ends). Real here: the publisher, K-05's publishBundleCopy,
// readBundleValue, readActiveBundle and setActiveBundle (db/repo/bundles.ts, T-185), and PostgreSQL. Nothing goes to KV.
// The made-up bundle that is made active has a hash that is the sha256 of a label, never data.
//
// The card's proofs: publishing a bundle, then reading every part back by bundle id (readBundleValue, the read on a KV
// miss), gives byte-identical parts; publishing never changes the active bundle id; publishing the same bundle twice
// writes nothing new; the KV bulk file has one entry per part, every key prefixed by the bundle id.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  publishBundleCopy,
  readActiveBundle,
  readBundleValue,
  setActiveBundle,
  type BundleId,
  type PublishBundleCopyRequest,
} from "../../../db/repo/bundles";
import type { Sql } from "../../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../../db/repo/test-db";
import { buildNumberedBundle, numberBundle, type NumberedBundle } from "../bundle-id";
import { main, type CliIo } from "../cli/index";
import { writeBundle, type BundleFile } from "../emit";
import { listTradeIds } from "../load/trade";
import { publishBundle, readPublishable, type PublishOutcome } from "./index";

const BUILT_AT = "2026-11-09T10:00:00Z";
const OTHER_BUILT_AT = "2026-11-09T11:00:00Z";
const TRADES = [
  "barber",
  ...listTradeIds()
    .filter((id) => id !== "barber")
    .slice(0, 1),
];
const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const encoder = new TextEncoder();

/** True when two byte strings are the same bytes (the test's own comparison, not the publisher's). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, k) => byte === b[k]);
}

const made: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `publish-int-${label}-`));
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

const prefixOf = (id: BundleId): string => `bundle/${id.hash}/${String(id.build)}/`;

/** Each file of a bundle directory under its K-01 key for `id`, with its kind and its bytes on disk. */
function partsOnDisk(dir: string, files: readonly BundleFile[], id: BundleId) {
  return files.map((file) => {
    const part = file.path.slice(0, -".json".length);
    return {
      key: `${prefixOf(id)}${part}`,
      kind: part === "manifest" ? "manifest" : (part.split("/")[0] ?? ""),
      raw: readFileSync(join(dir, ...file.path.split("/"))),
    };
  });
}

/** What PostgreSQL holds of one bundle: its registry row and its values, each with the transaction that wrote it. */
async function stored(sql: Sql, id: BundleId): Promise<{ bundles: unknown[]; values: { key: string }[] }> {
  const bundles = await sql`
    select hash, build, manifest_key, built_at, published_at, active, activated_at, version, xmin::text as xmin
    from bundles where hash = ${id.hash} and build = ${id.build}
  `;
  const values = await sql<{ key: string }[]>`
    select key, kind, bytes, sha256, xmin::text as xmin from bundle_values
    where bundle_hash = ${id.hash} and bundle_build = ${id.build} order by key
  `;
  return { bundles: [...bundles], values: [...values] };
}

/** Every row of the registry and of the copy, counted. */
async function counts(sql: Sql): Promise<unknown> {
  const [row] = await sql`
    select (select count(*)::int from bundles) as bundle_rows, (select count(*)::int from bundle_values) as value_rows
  `;
  return row;
}

/** The active row, with the transaction that last wrote it. */
async function activeRow(sql: Sql): Promise<unknown[]> {
  return [
    ...(await sql`select hash, build, active, activated_at, version, xmin::text as xmin from bundles where active`),
  ];
}

/** A bundle of one manifest value under a made-up id, as bundles.int.test.ts makes one. */
function madeUp(label: string): PublishBundleCopyRequest {
  const hash = sha256(`bundle ${label}`);
  const key = `bundle/${hash}/1/manifest`;
  const text = JSON.stringify({ contract: "bundle.v1", label });
  return {
    bundleId: { hash, build: 1 },
    builtAt: "2026-11-09T08:00:00Z",
    manifestKey: key,
    values: [{ key, kind: "manifest", bytes: encoder.encode(text).length, sha256: sha256(text), text }],
  };
}

function publishedOf(outcome: PublishOutcome): Extract<PublishOutcome, { result: "published" }> {
  if (!("result" in outcome)) throw new Error(`not published: ${JSON.stringify(outcome)}`);
  return outcome;
}

let db: TestDatabase;
let first: NumberedBundle;
/** Build 1 of the bundle; build 2 and build 3 of the same values; build 1's id with a manifest built at another time. */
let dirOne: string;
let dirTwo: string;
let dirThree: string;
let dirOther: string;
let kvOne: string;
let firstPublish: Extract<PublishOutcome, { result: "published" }>;
const savedSchema = process.env.DB_SCHEMA;

beforeAll(async () => {
  db = await createTestDatabase({ name: "publish" });
  first = await buildNumberedBundle({ trades: TRADES, build: 1, builtAt: BUILT_AT });
  dirOne = written(first.files, "one");
  dirTwo = written(numberBundle(first, 2).files, "two");
  dirThree = written(numberBundle(first, 3).files, "three");
  const otherManifest = (file: BundleFile): BundleFile =>
    file.path === "manifest.json"
      ? {
          path: file.path,
          text: JSON.stringify({
            ...(JSON.parse(file.text) as Record<string, unknown>),
            builtAt: OTHER_BUILT_AT,
          }),
        }
      : file;
  dirOther = written(first.files.map(otherManifest), "other");
  kvOne = join(tempDir("kv-one"), "bundle.kv.json");
  // The command opens its own client, on the test schema.
  process.env.DB_SCHEMA = db.schema;
}, 180_000);

afterAll(async () => {
  if (savedSchema === undefined) delete process.env.DB_SCHEMA;
  else process.env.DB_SCHEMA = savedSchema;
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  await db.drop();
});

describe("publishing a bundle directory", () => {
  it("with no bundle active: publishes the copy, writes the KV bulk file, and no bundle becomes active", async () => {
    expect(await readActiveBundle(db.sql)).toEqual({ error: "noActiveBundle" });
    firstPublish = publishedOf(await publishBundle(db.sql, readPublishable(dirOne), kvOne));
    expect(firstPublish).toMatchObject({
      bundleId: first.bundleId,
      repeated: false,
      values: first.files.length,
      kvFile: kvOne,
      kvFileWritten: true,
      activeBefore: "none",
      activeAfter: "none",
    });
    expect(await readActiveBundle(db.sql)).toEqual({ error: "noActiveBundle" });
    expect((await stored(db.sql, first.bundleId)).bundles).toMatchObject([
      { active: false, activated_at: null, version: 1 },
    ]);
  });

  it("every part read back by bundle id (readBundleValue, the read on a KV miss) is byte-identical to its file", async () => {
    const parts = partsOnDisk(dirOne, first.files, first.bundleId);
    expect(parts).toHaveLength(3 + TRADES.length);
    for (const part of parts) {
      const answer = await readBundleValue(db.sql, { key: part.key });
      if (!("result" in answer)) throw new Error(`${part.key}: ${answer.error}`);
      expect(sameBytes(encoder.encode(answer.value.text), part.raw), part.key).toBe(true);
      expect(answer.value).toMatchObject({
        key: part.key,
        kind: part.kind,
        bytes: part.raw.length,
        sha256: sha256(part.raw),
      });
    }
    const keys = (await stored(db.sql, first.bundleId)).values.map((row) => row.key);
    expect(keys.sort()).toEqual(parts.map((part) => part.key).sort());
  });

  it("the KV bulk file has one entry per part, every key prefixed by the bundle id, each value the part's bytes", () => {
    const parts = partsOnDisk(dirOne, first.files, first.bundleId);
    const entries = JSON.parse(readFileSync(kvOne, "utf8")) as { key: string; value: string }[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(parts.length);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["key", "value"]);
      expect(entry.key.startsWith(prefixOf(first.bundleId)), entry.key).toBe(true);
    }
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
    const values = new Map(entries.map((entry) => [entry.key, entry.value]));
    for (const part of parts) {
      expect(values.has(part.key), part.key).toBe(true);
      expect(sameBytes(encoder.encode(values.get(part.key) ?? ""), part.raw), part.key).toBe(true);
    }
  });

  it("publishing the same bundle again writes nothing new: no row written or rewritten, the KV bulk file as it was", async () => {
    const rows = await stored(db.sql, first.bundleId);
    const before = await counts(db.sql);
    const file = statSync(kvOne);
    const bytes = readFileSync(kvOne);
    const again = publishedOf(await publishBundle(db.sql, readPublishable(dirOne), kvOne));
    expect(again).toMatchObject({
      bundleId: first.bundleId,
      publishedAt: firstPublish.publishedAt,
      repeated: true,
      values: first.files.length,
      kvFileWritten: false,
    });
    expect(await stored(db.sql, first.bundleId)).toEqual(rows);
    expect(await counts(db.sql)).toEqual(before);
    expect(statSync(kvOne).mtimeMs).toBe(file.mtimeMs);
    expect(readFileSync(kvOne).equals(bytes)).toBe(true);
  });

  it("with another bundle active, publishing never changes the active id; the bundle published stays inactive", async () => {
    const other = madeUp("active");
    expect(await publishBundleCopy(db.sql, other)).toMatchObject({ result: "published", repeated: false });
    expect(
      await setActiveBundle(db.sql, {
        bundleId: other.bundleId,
        expectActive: null,
        at: "2026-11-09T09:00:00Z",
      }),
    ).toMatchObject({ result: "activated" });
    const active = await readActiveBundle(db.sql);
    const row = await activeRow(db.sql);
    expect(row).toHaveLength(1);

    const second = publishedOf(
      await publishBundle(db.sql, readPublishable(dirTwo), join(tempDir("kv-two"), "bundle.kv.json")),
    );
    expect(second).toMatchObject({ bundleId: { hash: first.bundleId.hash, build: 2 }, repeated: false });
    expect(second.activeBefore).toBe(`${other.bundleId.hash}/1 (active since 2026-11-09T09:00:00Z)`);
    expect(second.activeAfter).toBe(second.activeBefore);
    expect(await readActiveBundle(db.sql)).toEqual(active);
    expect(await activeRow(db.sql)).toEqual(row);
    expect((await stored(db.sql, second.bundleId)).bundles).toMatchObject([
      { active: false, activated_at: null },
    ]);

    // The first bundle published again, a repeat, leaves the active id as it is too.
    expect(publishedOf(await publishBundle(db.sql, readPublishable(dirOne), kvOne)).repeated).toBe(true);
    expect(await activeRow(db.sql)).toEqual(row);
  });
});

describe("compiler publish <bundle dir>", () => {
  it("publishes, says what it wrote, puts the KV bulk file beside the folder; run again, it writes nothing new", async () => {
    const row = await activeRow(db.sql);
    const id = { hash: first.bundleId.hash, build: 3 };
    const label = `${id.hash}/3`;
    const kv = `${dirThree}.kv.json`;
    const n = String(first.files.length);

    const run = capture();
    expect(await main(["publish", dirThree], run.io)).toBe(0);
    expect(run.err).toEqual([]);
    expect(
      run.out[0]?.startsWith(
        `bundle ${label}: ${n} parts (the manifest, 2 flow graphs, ${String(TRADES.length)} trade overlays)`,
      ),
    ).toBe(true);
    expect(run.out[1]).toMatch(
      /^PostgreSQL's copy: published at \S+Z, \d+ values written \(K-05 publishBundleCopy\)$/,
    );
    expect(run.out).toContain(
      `read back by bundle id (K-05 readBundleValue, the actor's read on a KV miss): ${n} of ${n} parts byte-identical`,
    );
    expect(run.out).toContain(
      `KV bulk file ${kv}: ${n} entries, one per part, every key under bundle/${label}/ (written)`,
    );
    expect(run.out.at(-1)).toMatch(
      /^active bundle id: [0-9a-f]{64}\/1 \(active since .+\), unchanged: publishing never switches it/,
    );
    expect(existsSync(kv)).toBe(true);
    expect((await stored(db.sql, id)).values).toHaveLength(first.files.length);
    expect(await activeRow(db.sql)).toEqual(row);

    const rows = await stored(db.sql, id);
    const mtime = statSync(kv).mtimeMs;
    const again = capture();
    expect(await main(["publish", dirThree], again.io)).toBe(0);
    expect(again.err).toEqual([]);
    expect(again.out[1]).toMatch(
      /^PostgreSQL's copy: already published at \S+Z with these bytes, so nothing new was written/,
    );
    expect(again.out).toContain(
      `KV bulk file ${kv}: ${n} entries, one per part, every key under bundle/${label}/ (unchanged: it held these entries already)`,
    );
    expect(await stored(db.sql, id)).toEqual(rows);
    expect(statSync(kv).mtimeMs).toBe(mtime);
    expect(await activeRow(db.sql)).toEqual(row);
  });

  it("refuses a bundle id already published with other bytes, writing nothing: no row, no KV bulk file", async () => {
    const rows = await stored(db.sql, first.bundleId);
    const before = await counts(db.sql);
    const row = await activeRow(db.sql);
    const kv = join(tempDir("kv-other"), "bundle.kv.json");

    const run = capture();
    expect(await main(["publish", dirOther, "--kv", kv], run.io)).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err[0]).toContain(`refused: ${prefixOf(first.bundleId)}manifest already holds other bytes`);
    expect(run.err[0]).toContain("valueMismatch");
    expect(run.err).toContain("nothing was written: no value, and no KV bulk file");
    expect(existsSync(kv)).toBe(false);

    expect(await publishBundle(db.sql, readPublishable(dirOther), kv)).toEqual({
      error: "valueMismatch",
      key: `${prefixOf(first.bundleId)}manifest`,
    });
    expect(existsSync(kv)).toBe(false);
    expect(await stored(db.sql, first.bundleId)).toEqual(rows);
    expect(await counts(db.sql)).toEqual(before);
    expect(await activeRow(db.sql)).toEqual(row);
  });
});
