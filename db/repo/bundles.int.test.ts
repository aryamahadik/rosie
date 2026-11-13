// T-185: the bundle registry against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/bundles`).
// The schema comes from migrating a fresh test schema. Fixtures are the frozen ones of contracts/db-schema/core (seeds)
// and contracts/data-access (the calls' requests and outcomes); hashes made up here are sha256 of a label, never data.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, resolvePrimaryUrl } from "./client";
import {
  type BundleId,
  type PublishBundleCopyRequest,
  type StoredText,
  isLostConnection,
  publishBundleCopy,
  readActiveBundle,
  readBundleValue,
  reserveConnection,
  setActiveBundle,
} from "./bundles";
import { DataAccessDatabaseError } from "./clocks";
import type { Sql } from "./scope";
import { handleTargets, type TransientError, transientOrThrow } from "./targets";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
const CALLS_DIR = new URL("../../contracts/data-access/fixtures/", import.meta.url);
const OWN_TABLES = ["bundles", "bundle_values"] as const;
// No earlier table is needed by these seeds: their `after` chains are empty.
type Cell = string | number | boolean | null;

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Cell> }[];
}

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string };
  request: Record<string, unknown>;
  outcome: Record<string, unknown>;
}

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey?: string[];
  checks?: { name: string }[];
  foreignKeys?: { name: string }[];
  unique?: { name: string; columns: string[]; where?: string }[];
  indexes?: { name: string; columns: string[] }[];
  versioned: boolean;
}

const readJson = (base: URL, relative: string): unknown =>
  JSON.parse(readFileSync(new URL(relative, base), "utf8"));
const seed = (file: string): SeedFile => readJson(CORE_DIR, `fixtures/${file}`) as SeedFile;
const exchange = (file: string): Exchange => readJson(CALLS_DIR, file) as Exchange;

function seedRows(file: string, seen = new Set<string>()): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = seed(file);
  return [...fixture.after.flatMap((before) => seedRows(before, seen)), ...fixture.rows];
}

/** Loads a seed fixture and its `after` chain as the fixture has it (bytea values come as "\\x..." hex). */
async function loadSeed(sql: Sql, file: string): Promise<Record<string, number>> {
  const loaded: Record<string, number> = {};
  for (const row of seedRows(file)) {
    const values: Record<string, unknown> = { ...row.values };
    if (typeof values.value === "string" && values.value.startsWith("\\x")) {
      values.value = fromHex(values.value.slice(2));
    }
    await sql`insert into ${sql(row.table)} ${sql(values as never)}`;
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return loaded;
}

// Later migrations add tables that reference these, so the truncate cascades to them. Each test file runs in its own
// schema (createTestDatabase), so nothing else is touched.
async function emptyTables(sql: Sql): Promise<void> {
  await sql`truncate bundle_values, bundles cascade`;
}

async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string };
    return { code: failure.code, constraint: failure.constraint_name };
  }
  throw new Error("the statement was accepted; the database should have refused it");
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A bundle of one manifest value under a made-up id, as the deploy script sends it. */
function bundleOf(label: string, build: number): PublishBundleCopyRequest {
  const hash = sha(`bundle ${label}`);
  const key = `bundle/${hash}/${String(build)}/manifest`;
  const text = JSON.stringify({ contract: "bundle.v1", label, build });
  return {
    bundleId: { hash, build },
    builtAt: "2026-11-08T08:00:00Z",
    manifestKey: key,
    values: [{ key, kind: "manifest", bytes: byteLength(text), sha256: sha(text), text }],
  };
}

const idOf = (request: PublishBundleCopyRequest): BundleId => request.bundleId;

async function activeIds(sql: Sql): Promise<BundleId[]> {
  const rows = await sql<{ hash: string; build: number }[]>`select hash, build from bundles where active`;
  return rows.map((row) => ({ hash: row.hash, build: row.build }));
}

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ name: "bundles" });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core)", () => {
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    boolean: "boolean",
    bytea: "bytea",
    timestamptz: "timestamp with time zone",
  };
  const tables = (readJson(CORE_DIR, "core.v1.tables.json") as { tables: ContractTable[] }).tables.filter(
    (table) => (OWN_TABLES as readonly string[]).includes(table.name),
  );

  it("covers exactly the two tables of the card", () => {
    expect(tables.map((table) => table.name).sort()).toEqual(["bundle_values", "bundles"]);
  });

  for (const table of tables) {
    it(`${table.name}: columns, types, nulls and defaults are the table list's`, async () => {
      const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
        select column_name as name, data_type as type, is_nullable as nullable, column_default as default
        from information_schema.columns
        where table_schema = ${db.schema} and table_name = ${table.name}
        order by ordinal_position
      `;
      expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
      for (const column of table.columns) {
        const actual = found.find((candidate) => candidate.name === column.name);
        expect(actual?.type, `${table.name}.${column.name} type`).toBe(typeNames[column.type]);
        expect(actual?.nullable === "YES", `${table.name}.${column.name} null`).toBe(column.null);
        if (column.default === undefined) {
          expect(actual?.default, `${table.name}.${column.name} default`).toBeNull();
        } else {
          expect((actual?.default ?? "").replace(/::.*$/, ""), `${table.name}.${column.name} default`).toBe(
            column.default,
          );
        }
      }
    });

    it(`${table.name}: primary key, checks, foreign keys, unique rules and indexes are the table list's`, async () => {
      const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
        select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass
      `;
      expect(constraints.find((constraint) => constraint.kind === "p")?.definition).toBe(
        `PRIMARY KEY (${(table.primaryKey ?? []).join(", ")})`,
      );
      const named = (kind: string): string[] =>
        constraints
          .filter((constraint) => constraint.kind === kind)
          .map((constraint) => constraint.name)
          .sort();
      expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
      expect(named("f")).toEqual((table.foreignKeys ?? []).map((key) => key.name).sort());
      // A unique rule with a `where` is a partial index, not a constraint.
      expect(named("u")).toEqual(
        (table.unique ?? [])
          .filter((rule) => rule.where === undefined)
          .map((rule) => rule.name)
          .sort(),
      );

      const indexes = await db.sql<{ name: string; definition: string }[]>`
        select indexname as name, indexdef as definition from pg_indexes
        where schemaname = ${db.schema} and tablename = ${table.name}
      `;
      expect(indexes.map((index) => index.name).sort()).toEqual(
        [
          `${table.name}_pkey`,
          ...(table.unique ?? []).map((rule) => rule.name),
          ...(table.indexes ?? []).map((index) => index.name),
        ].sort(),
      );
      for (const rule of table.unique ?? []) {
        const index = indexes.find((candidate) => candidate.name === rule.name);
        expect(index?.definition).toContain("CREATE UNIQUE INDEX");
        expect(index?.definition).toContain(`(${rule.columns.join(", ")})`);
        if (rule.where !== undefined) {
          expect(index?.definition).toContain(`WHERE ${rule.where}`);
        }
      }
      for (const wanted of table.indexes ?? []) {
        const index = indexes.find((candidate) => candidate.name === wanted.name);
        expect(index?.definition).toContain(`(${wanted.columns.join(", ")})`);
      }
    });

    it(`${table.name}: foreign keys refuse deletes, and the version trigger exists exactly when versioned`, async () => {
      const keysFound = await db.sql<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint where conrelid = ${`${db.schema}.${table.name}`}::regclass and contype = 'f'
      `;
      for (const key of keysFound) {
        expect(key.definition, key.name).toContain("ON DELETE RESTRICT");
      }
      const triggers = await db.sql<{ name: string }[]>`
        select tgname as name from pg_trigger
        where tgrelid = ${`${db.schema}.${table.name}`}::regclass and not tgisinternal
      `;
      expect(triggers.map((trigger) => trigger.name)).toEqual(
        table.versioned ? [`${table.name}_version_raised`] : [],
      );
      expect(table.columns.some((column) => column.name === "version")).toBe(table.versioned);
    });
  }

  it("is expand only: plain tables with no row-level security (scope none)", async () => {
    const rows = await db.sql<{ name: string; kind: string; rls: boolean }[]>`
      select c.relname as name, c.relkind as kind, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname in ('bundles', 'bundle_values')
      order by c.relname
    `;
    expect(rows.map((row) => [row.name, row.kind, row.rls])).toEqual([
      ["bundle_values", "r", false],
      ["bundles", "r", false],
    ]);
  });

  it("is recorded in schema_migrations after 0001 to 0005", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name).slice(0, 6)).toEqual([
      "init",
      "core_business_people",
      "core_sealing_keys",
      "core_handles_phones",
      "core_threads_messages",
      "core_bundle_registry_flags",
    ]);
  });
});

describe("what the database refuses", () => {
  const good = bundleOf("refusals", 1);

  it("refuses a bad hash, a build below 1, a manifest key that is not the id's, and an active row with no time", async () => {
    await emptyTables(db.sql);
    const { hash } = good.bundleId;
    const insert = (values: Record<string, unknown>) =>
      db.sql`insert into bundles ${db.sql({ hash, build: 1, manifest_key: good.manifestKey, built_at: "2026-11-08T08:00:00Z", ...values } as never)}`;
    expect((await refusal(insert({ hash: "ABC", manifest_key: "bundle/ABC/1/manifest" }))).constraint).toBe(
      "bundles_hash_form",
    );
    expect((await refusal(insert({ build: 0, manifest_key: `bundle/${hash}/0/manifest` }))).constraint).toBe(
      "bundles_build_positive",
    );
    expect((await refusal(insert({ manifest_key: `bundle/${hash}/2/manifest` }))).constraint).toBe(
      "bundles_manifest_key_form",
    );
    expect((await refusal(insert({ active: true }))).constraint).toBe("bundles_active_has_time");
  });

  it("refuses a value whose size, sha256, key or kind does not fit, and a value for an unknown bundle", async () => {
    await emptyTables(db.sql);
    await db.sql`insert into bundles (hash, build, manifest_key, built_at)
      values (${good.bundleId.hash}, 1, ${good.manifestKey}, '2026-11-08T08:00:00Z')`;
    const [value] = good.values as [StoredText];
    const insert = (values: Record<string, unknown>) =>
      db.sql`insert into bundle_values ${db.sql({
        key: value.key,
        bundle_hash: good.bundleId.hash,
        bundle_build: 1,
        kind: "manifest",
        bytes: value.bytes,
        sha256: value.sha256,
        value: new TextEncoder().encode(value.text),
        ...values,
      } as never)}`;
    expect((await refusal(insert({ bytes: value.bytes + 1 }))).constraint).toBe("bundle_values_bytes_match");
    expect((await refusal(insert({ sha256: sha("other") }))).constraint).toBe("bundle_values_sha256_match");
    expect((await refusal(insert({ kind: "flow" }))).constraint).toBe("bundle_values_key_of_bundle");
    expect((await refusal(insert({ bytes: 0, value: new Uint8Array(0), sha256: sha("") }))).constraint).toBe(
      "bundle_values_bytes_range",
    );
    expect((await refusal(insert({ key: "bundle/x", kind: "manifest" }))).constraint).toBe(
      "bundle_values_key_form",
    );
    const other = bundleOf("not registered", 1);
    expect(
      (await refusal(insert({ key: other.manifestKey, bundle_hash: other.bundleId.hash, bundle_build: 1 })))
        .constraint,
    ).toBe("bundle_values_bundle_fk");
    const ok = await insert({});
    expect(ok.count).toBe(1);
    // A bundle with values cannot be deleted: every published bundle stays readable for replay.
    expect((await refusal(db.sql`delete from bundles where hash = ${good.bundleId.hash}`)).code).toBe(
      "23503",
    );
  });

  it("refuses a second active bundle and a version that does not rise by one", async () => {
    await emptyTables(db.sql);
    const [a, b] = [bundleOf("one", 1), bundleOf("two", 1)] as [
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
    ];
    for (const request of [a, b]) {
      await db.sql`insert into bundles (hash, build, manifest_key, built_at)
        values (${request.bundleId.hash}, 1, ${request.manifestKey}, '2026-11-08T08:00:00Z')`;
    }
    await db.sql`update bundles set active = true, activated_at = now(), version = 2 where hash = ${a.bundleId.hash}`;
    expect(
      (
        await refusal(
          db.sql`update bundles set active = true, activated_at = now(), version = 2 where hash = ${b.bundleId.hash}`,
        )
      ).constraint,
    ).toBe("bundles_one_active");
    expect(
      (await refusal(db.sql`update bundles set built_at = now() where hash = ${b.bundleId.hash}`)).code,
    ).toBeDefined();
  });
});

describe("fixtures: seed-bundle-registry and the read calls", () => {
  it("seed-bundle-registry loads as the fixture has it", async () => {
    await emptyTables(db.sql);
    expect(await loadSeed(db.sql, "seed-bundle-registry.json")).toEqual({ bundles: 1, bundle_values: 1 });
  });

  it("readActiveBundle answers as active-bundle.json says", async () => {
    await emptyTables(db.sql);
    const [seedFile] = exchange("active-bundle.json").given.k04Seeds;
    expect(seedFile).toBe("seed-bundle-registry.json");
    await loadSeed(db.sql, seedFile ?? "seed-bundle-registry.json");
    expect(await readActiveBundle(db.sql)).toEqual(exchange("active-bundle.json").outcome);
  });

  it("readBundleValue answers as bundle-value-on-miss.json says, bytes and sha256 matching the text", async () => {
    await emptyTables(db.sql);
    await loadSeed(db.sql, "seed-bundle-registry.json");
    const fixture = exchange("bundle-value-on-miss.json");
    const answer = await readBundleValue(db.sql, fixture.request as { key: string });
    expect(answer).toEqual(fixture.outcome);
    if ("value" in answer) {
      expect(byteLength(answer.value.text)).toBe(answer.value.bytes);
      expect(sha(answer.value.text)).toBe(answer.value.sha256);
    }
  });

  it("readBundleValue says notFound for a key the copy does not hold; readActiveBundle says noActiveBundle on an empty registry", async () => {
    await emptyTables(db.sql);
    expect(await readActiveBundle(db.sql)).toEqual({ error: "noActiveBundle" });
    const key = `bundle/${sha("none")}/1/manifest`;
    expect(await readBundleValue(db.sql, { key })).toEqual({
      error: "notFound",
      table: "bundle_values",
      rowId: key,
    });
  });
});

describe("publishBundleCopy and setActiveBundle: the deploy's steps (fixtures)", () => {
  it("publish-bundle-copy then set-active-bundle give the fixtures' outcomes, and the active id reads back", async () => {
    await emptyTables(db.sql);
    const publish = exchange("publish-bundle-copy.json");
    const published = await publishBundleCopy(
      db.sql,
      publish.request as unknown as PublishBundleCopyRequest,
      {
        now: new Date(publish.given.now),
      },
    );
    expect(published).toEqual(publish.outcome);
    // Publishing never makes a bundle active.
    expect(await readActiveBundle(db.sql)).toEqual({ error: "noActiveBundle" });

    const activate = exchange("set-active-bundle.json");
    expect(activate.given.after).toEqual(["publish-bundle-copy.json"]);
    expect(await setActiveBundle(db.sql, activate.request as never)).toEqual(activate.outcome);

    // The stored copy equals what seed-bundle-registry holds (bytes and sha256 of the same stand-in manifest).
    const seeded = seed("seed-bundle-registry.json").rows.find(
      (row) => row.table === "bundle_values",
    )?.values;
    const stored = await readBundleValue(db.sql, { key: publish.request.manifestKey as string });
    expect(stored).toMatchObject({
      result: "value",
      value: { bytes: seeded?.bytes, sha256: seeded?.sha256 },
    });
    const active = await readActiveBundle(db.sql);
    expect(active).toEqual(exchange("active-bundle.json").outcome);
    // And the rows are the seed's rows, version included (published, then activated: version 2).
    const [row] = await db.sql<
      { version: number; published_at: Date }[]
    >`select version, published_at from bundles`;
    expect(row?.version).toBe(
      seeded === undefined ? 0 : seed("seed-bundle-registry.json").rows[0]?.values.version,
    );
    expect(row?.published_at.toISOString()).toBe("2026-11-07T08:05:00.000Z");
  });

  it("the same bundle again says repeated with the first publishing time and writes nothing", async () => {
    await emptyTables(db.sql);
    const request = bundleOf("repeat", 1);
    const first = await publishBundleCopy(db.sql, request, { now: new Date("2026-11-08T09:00:00Z") });
    const again = await publishBundleCopy(db.sql, request, { now: new Date("2026-11-08T10:00:00Z") });
    expect(first).toMatchObject({
      result: "published",
      repeated: false,
      values: 1,
      publishedAt: "2026-11-08T09:00:00Z",
    });
    expect(again).toMatchObject({
      result: "published",
      repeated: true,
      values: 1,
      publishedAt: "2026-11-08T09:00:00Z",
    });
    const [counts] = await db.sql<{ bundles: number; values: number }[]>`
      select (select count(*)::int from bundles) as bundles, (select count(*)::int from bundle_values) as values
    `;
    expect(counts).toEqual({ bundles: 1, values: 1 });
  });

  it("answers valueMismatch and writes nothing for bytes or sha256 that do not match the text, or a key of another bundle", async () => {
    await emptyTables(db.sql);
    const request = bundleOf("mismatch", 1);
    const [value] = request.values as [StoredText];
    for (const bad of [
      { ...value, bytes: value.bytes + 1 },
      { ...value, sha256: sha("something else") },
      { ...value, key: `bundle/${sha("elsewhere")}/1/manifest` },
    ]) {
      expect(await publishBundleCopy(db.sql, { ...request, values: [bad] })).toEqual({
        error: "valueMismatch",
        key: bad.key,
      });
    }
    const [counts] = await db.sql<{ n: number }[]>`select count(*)::int as n from bundles`;
    expect(counts?.n).toBe(0);
  });

  it("answers valueMismatch when a repeat's key holds other bytes, and when a second value was never stored", async () => {
    await emptyTables(db.sql);
    const request = bundleOf("changed", 1);
    const [value] = request.values as [StoredText];
    await publishBundleCopy(db.sql, request);
    const changedText = value.text.replace("changed", "chang3d");
    const changed: StoredText = {
      ...value,
      bytes: byteLength(changedText),
      sha256: sha(changedText),
      text: changedText,
    };
    expect(await publishBundleCopy(db.sql, { ...request, values: [changed] })).toEqual({
      error: "valueMismatch",
      key: value.key,
    });
    const flowText = JSON.stringify({ flow: "A" });
    const flow: StoredText = {
      key: `bundle/${request.bundleId.hash}/1/flow/A`,
      kind: "flow",
      bytes: byteLength(flowText),
      sha256: sha(flowText),
      text: flowText,
    };
    expect(await publishBundleCopy(db.sql, { ...request, values: [value, flow] })).toEqual({
      error: "valueMismatch",
      key: flow.key,
    });
    // The stored manifest is untouched.
    expect(await readBundleValue(db.sql, { key: value.key })).toMatchObject({ value: { text: value.text } });
  });

  it("stores flow and trade values beside the manifest and reads each back by its key, multi-byte text included", async () => {
    await emptyTables(db.sql);
    const request = bundleOf("parts", 1);
    const mk = (suffix: string, kind: StoredText["kind"], text: string): StoredText => ({
      key: `bundle/${request.bundleId.hash}/1/${suffix}`,
      kind,
      bytes: byteLength(text),
      sha256: sha(text),
      text,
    });
    const flow = mk("flow/B", "flow", JSON.stringify({ say: "café, naïve – ok" }));
    const trade = mk("trade/barber", "trade", JSON.stringify({ trade: "barber" }));
    const result = await publishBundleCopy(db.sql, { ...request, values: [...request.values, flow, trade] });
    expect(result).toMatchObject({ result: "published", values: 3 });
    for (const value of [flow, trade]) {
      expect(await readBundleValue(db.sql, { key: value.key })).toEqual({ result: "value", value });
    }
  });

  it("publishing never changes the active id, and a published bundle stays readable after another is active", async () => {
    await emptyTables(db.sql);
    const [a, b] = [bundleOf("keep a", 1), bundleOf("keep b", 2)] as [
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
    ];
    await publishBundleCopy(db.sql, a);
    await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
    await publishBundleCopy(db.sql, b);
    expect(await activeIds(db.sql)).toEqual([idOf(a)]);
    expect(await readActiveBundle(db.sql)).toMatchObject({ bundleId: idOf(a) });
    await setActiveBundle(db.sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" });
    expect(await readBundleValue(db.sql, { key: a.manifestKey })).toMatchObject({ result: "value" });
  });

  it("setActiveBundle refuses an unpublished id and leaves the active id alone", async () => {
    await emptyTables(db.sql);
    const a = bundleOf("live", 1);
    await publishBundleCopy(db.sql, a);
    await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
    const ghost: BundleId = { hash: sha("never published"), build: 7 };
    expect(
      await setActiveBundle(db.sql, { bundleId: ghost, expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
    ).toEqual({
      error: "notPublished",
      bundleId: ghost,
    });
    expect(await activeIds(db.sql)).toEqual([idOf(a)]);
  });

  it("setActiveBundle says activeChanged when the active id is not the one the script read, and changes nothing", async () => {
    await emptyTables(db.sql);
    const [a, b, c] = [bundleOf("ac a", 1), bundleOf("ac b", 2), bundleOf("ac c", 3)] as [
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
    ];
    for (const request of [a, b, c]) {
      await publishBundleCopy(db.sql, request);
    }
    // The script read "none", but a is active by now.
    await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
    expect(
      await setActiveBundle(db.sql, { bundleId: idOf(b), expectActive: null, at: "2026-11-08T11:00:00Z" }),
    ).toEqual({
      error: "activeChanged",
      active: idOf(a),
    });
    // The script read c, but a is active.
    expect(
      await setActiveBundle(db.sql, { bundleId: idOf(b), expectActive: idOf(c), at: "2026-11-08T11:00:00Z" }),
    ).toEqual({
      error: "activeChanged",
      active: idOf(a),
    });
    expect(await activeIds(db.sql)).toEqual([idOf(a)]);
  });

  it("an id already active says repeated and changes nothing; rolling back is the same call with the earlier id", async () => {
    await emptyTables(db.sql);
    const [a, b] = [bundleOf("rb a", 1), bundleOf("rb b", 2)] as [
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
    ];
    await publishBundleCopy(db.sql, a);
    await publishBundleCopy(db.sql, b);
    const first = await setActiveBundle(db.sql, {
      bundleId: idOf(a),
      expectActive: null,
      at: "2026-11-08T10:00:00Z",
    });
    expect(first).toEqual({
      result: "activated",
      bundleId: idOf(a),
      previous: null,
      activatedAt: "2026-11-08T10:00:00Z",
      repeated: false,
    });
    const [before] = await db.sql<{ version: number }[]>`select version from bundles where active`;
    // The same call again (its expectActive is stale now) is a repeat, not a conflict.
    expect(
      await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:05:00Z" }),
    ).toEqual({
      ...first,
      previous: null,
      activatedAt: "2026-11-08T10:00:00Z",
      repeated: true,
    });
    const [after] = await db.sql<{ version: number }[]>`select version from bundles where active`;
    expect(after?.version).toBe(before?.version);

    expect(
      await setActiveBundle(db.sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
    ).toEqual({
      result: "activated",
      bundleId: idOf(b),
      previous: idOf(a),
      activatedAt: "2026-11-08T11:00:00Z",
      repeated: false,
    });
    // Rolling back.
    expect(
      await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: idOf(b), at: "2026-11-08T12:00:00Z" }),
    ).toMatchObject({
      result: "activated",
      bundleId: idOf(a),
      previous: idOf(b),
      repeated: false,
    });
    expect(await readActiveBundle(db.sql)).toEqual({
      result: "active",
      bundleId: idOf(a),
      manifestKey: a.manifestKey,
      activatedAt: "2026-11-08T12:00:00Z",
    });
    expect(await activeIds(db.sql)).toEqual([idOf(a)]);
  });
});

describe("20 parallel switches", () => {
  const COUNT = 20;

  /** Counts the active rows over and over while the switches run: never more than one, and never none after the first. */
  async function watchActive(stop: { done: boolean }, minimum: number): Promise<number[]> {
    const seen: number[] = [];
    while (!stop.done) {
      const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from bundles where active`;
      seen.push(row?.n ?? -1);
    }
    expect(seen.every((n) => n >= minimum && n <= 1)).toBe(true);
    return seen;
  }

  async function publishMany(
    label: string,
  ): Promise<{ start: PublishBundleCopyRequest; targets: PublishBundleCopyRequest[] }> {
    await emptyTables(db.sql);
    // One to start from, and COUNT to switch to.
    const requests = Array.from({ length: COUNT + 1 }, (_, index) =>
      bundleOf(`${label} ${String(index)}`, index + 1),
    );
    for (const request of requests) {
      await publishBundleCopy(db.sql, request);
    }
    const [start, ...targets] = requests;
    if (start === undefined) {
      throw new Error("no bundle was made");
    }
    return { start, targets };
  }

  it("all read the same active id: exactly one wins, the others say activeChanged, and one id is active", async () => {
    const { start, targets } = await publishMany("same read");
    expect(targets).toHaveLength(COUNT);
    await setActiveBundle(db.sql, { bundleId: idOf(start), expectActive: null, at: "2026-11-08T10:00:00Z" });
    const stop = { done: false };
    const watcher = watchActive(stop, 1);
    const answers = await Promise.all(
      targets.map((request, index) =>
        setActiveBundle(db.sql, {
          bundleId: idOf(request),
          expectActive: idOf(start),
          at: `2026-11-08T11:00:${String(index).padStart(2, "0")}Z`,
        }),
      ),
    );
    stop.done = true;
    await watcher;
    const wins = answers.filter((answer) => "result" in answer && !answer.repeated);
    expect(wins).toHaveLength(1);
    const winner = wins[0];
    expect(answers.filter((answer) => "error" in answer && answer.error === "activeChanged")).toHaveLength(
      COUNT - 1,
    );
    expect(await activeIds(db.sql)).toEqual([(winner as { bundleId: BundleId }).bundleId]);
  });

  it("each reads the active id just before switching: every answer is a clean switch or activeChanged, and one id is active", async () => {
    const { start, targets } = await publishMany("fresh read");
    await setActiveBundle(db.sql, { bundleId: idOf(start), expectActive: null, at: "2026-11-08T10:00:00Z" });
    const stop = { done: false };
    const watcher = watchActive(stop, 1);
    const answers = await Promise.all(
      targets.map(async (request, index) => {
        const current = await readActiveBundle(db.sql);
        return setActiveBundle(db.sql, {
          bundleId: idOf(request),
          expectActive: "bundleId" in current ? current.bundleId : null,
          at: `2026-11-08T11:00:${String(index).padStart(2, "0")}Z`,
        });
      }),
    );
    stop.done = true;
    await watcher;
    for (const answer of answers) {
      expect("error" in answer ? answer.error : "ok").toMatch(/^(ok|activeChanged)$/);
    }
    expect(answers.some((answer) => "result" in answer && !answer.repeated)).toBe(true);
    expect(await activeIds(db.sql)).toHaveLength(1);
  });

  it("a request K-05's schema refuses (no values, or no manifest among them) answers valueMismatch naming the manifest key and writes nothing", async () => {
    await emptyTables(db.sql);
    const request = bundleOf("refused", 1);
    const [manifest] = request.values as [StoredText];
    const flowText = JSON.stringify({ flow: "A" });
    const flow: StoredText = {
      key: `bundle/${request.bundleId.hash}/1/flow/A`,
      kind: "flow",
      bytes: byteLength(flowText),
      sha256: sha(flowText),
      text: flowText,
    };
    for (const values of [[], [flow]]) {
      expect(await publishBundleCopy(db.sql, { ...request, values })).toEqual({
        error: "valueMismatch",
        key: manifest.key,
      });
    }
    const [counts] = await db.sql<{ n: number }[]>`select count(*)::int as n from bundles`;
    expect(counts?.n).toBe(0);
  });

  it("20 parallel publishes of one bundle write it once: one published, the rest repeated", async () => {
    await emptyTables(db.sql);
    const request = bundleOf("parallel publish", 1);
    const answers = await Promise.all(
      Array.from({ length: COUNT }, () => publishBundleCopy(db.sql, request)),
    );
    expect(answers.filter((answer) => "result" in answer && !answer.repeated)).toHaveLength(1);
    expect(answers.filter((answer) => "result" in answer && answer.repeated)).toHaveLength(COUNT - 1);
    const [counts] = await db.sql<{ bundles: number; values: number }[]>`
      select (select count(*)::int from bundles) as bundles, (select count(*)::int from bundle_values) as values
    `;
    expect(counts).toEqual({ bundles: 1, values: 1 });
  });
});

describe("a lost connection answers transient (K-05 README: every call)", () => {
  const LOCK_NAME = "rosie.bundles.active";
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** A TCP relay to the database whose client-side sockets can be reset (an RST, which the client reads as ECONNRESET). */
  async function startRelay(
    target: URL,
  ): Promise<{ port: number; reset: () => void; stop: () => Promise<void> }> {
    const pairs: { client: net.Socket; upstream: net.Socket }[] = [];
    const server = net.createServer((client) => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      pairs.push({ client, upstream });
      client.on("error", () => undefined);
      upstream.on("error", () => undefined);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return {
      port: typeof address === "object" && address !== null ? address.port : 0,
      reset: () => {
        for (const pair of pairs) {
          pair.client.resetAndDestroy();
          pair.upstream.destroy();
        }
      },
      stop: () =>
        new Promise<void>((resolve) => {
          for (const pair of pairs) {
            pair.client.destroy();
            pair.upstream.destroy();
          }
          server.close(() => {
            resolve();
          });
        }),
    };
  }

  interface Killed<T> {
    /** The answer of the killed call. */
    answer: T;
    /** The same request sent again on the killed client itself, until one answers without transient (at most 4). */
    resends: T[];
  }

  /**
   * Runs `call` on its own one-connection client while a second connection holds a lock the call waits on, then cuts the
   * call's connection from outside (`terminate`: pg_terminate_backend from a third connection; `reset`: the client's
   * socket, behind a relay, is reset), and returns the call's answer and the same request sent again on that client.
   */
  async function answerAfterKill<T>(
    take: (tx: postgres.TransactionSql) => Promise<unknown>,
    call: (sql: Sql) => Promise<T>,
    cut: "terminate" | "reset" = "terminate",
  ): Promise<Killed<T>> {
    const url = resolvePrimaryUrl();
    const holder = postgres(url, { max: 1, onnotice: () => undefined });
    const killer = postgres(url, { max: 1, onnotice: () => undefined });
    const relay = cut === "reset" ? await startRelay(new URL(url)) : null;
    const victimUrl = (() => {
      if (relay === null) {
        return url;
      }
      const through = new URL(url);
      through.hostname = "127.0.0.1";
      through.port = String(relay.port);
      return through.toString();
    })();
    const victim = createClient({ primaryUrl: victimUrl, schema: db.schema, max: 1 });
    try {
      // The holder keeps its lock until told to let go.
      let letGo: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      let locked: () => void = () => undefined;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = holder.begin(async (tx) => {
        await take(tx);
        locked();
        await hold;
      });
      await isLocked;

      const [backend] = await victim.primary<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const pid = backend?.pid ?? 0;
      const answering = call(victim.primary);
      // Wait until the victim's backend is waiting on the lock, then terminate it.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const [state] = await killer<{ waiting: boolean }[]>`
          select (wait_event_type = 'Lock') as waiting from pg_stat_activity where pid = ${pid}
        `;
        waiting = state?.waiting === true;
        if (!waiting) {
          await sleep(50);
        }
      }
      expect(waiting).toBe(true);
      if (relay === null) {
        await killer`select pg_terminate_backend(${pid})`;
      } else {
        relay.reset();
      }

      const answer = await answering;
      letGo();
      await holding;
      // The same request again on the killed client. closed() in postgres.js keeps the killed query's FATAL, so the
      // first query after the reconnect may answer transient once more; a later one must succeed. A hung call fails
      // the test by its timeout; a null-socket write would end the process.
      const resends: T[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const again = await call(victim.primary);
        resends.push(again);
        if (!(
          typeof again === "object" &&
          again !== null &&
          (again as { error?: string }).error === "transient"
        )) {
          break;
        }
      }
      return { answer, resends };
    } finally {
      await victim.close();
      await relay?.stop();
      await killer.end({ timeout: 5 });
      await holder.end({ timeout: 5 });
    }
  }

  const lostConnection = /^(08[0-9A-Z]{3}|57P0[123])$/;
  /** At most one stale transient (closed() keeps the killed query's FATAL), then the answer the card's call gives. */
  function expectResentOnTheKilledClient(resends: unknown[], expected: Record<string, unknown>): void {
    expect(resends.length).toBeGreaterThanOrEqual(1);
    expect(resends.length).toBeLessThanOrEqual(2);
    for (const stale of resends.slice(0, -1)) {
      expect(stale).toMatchObject({ error: "transient" });
    }
    expect(resends.at(-1)).toMatchObject(expected);
  }
  const lockTables = (tx: postgres.TransactionSql): Promise<unknown> =>
    tx`lock table ${tx(db.schema)}.bundles, ${tx(db.schema)}.bundle_values in access exclusive mode`;

  it("setActiveBundle waiting on the switch lock, its backend terminated from another connection, answers transient and writes nothing", async () => {
    await emptyTables(db.sql);
    const [a, b] = [bundleOf("kill a", 1), bundleOf("kill b", 2)] as [
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
    ];
    await publishBundleCopy(db.sql, a);
    await publishBundleCopy(db.sql, b);
    await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
    const { answer, resends } = await answerAfterKill(
      (tx) => tx`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`,
      (sql) => setActiveBundle(sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
    );
    expect(answer).toMatchObject({ error: "transient" });
    expect((answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    // The same request on the killed client: transient at most once more, then it switches (nothing was written before).
    expectResentOnTheKilledClient(resends, { result: "activated", repeated: false });
    expect(await activeIds(db.sql)).toEqual([idOf(b)]);
  }, 30_000);

  it("setActiveBundle on a socket that is reset answers transient (08006), skips the rollback, and the same client then switches", async () => {
    await emptyTables(db.sql);
    const [a, b] = [bundleOf("reset a", 1), bundleOf("reset b", 2)] as [
      PublishBundleCopyRequest,
      PublishBundleCopyRequest,
    ];
    await publishBundleCopy(db.sql, a);
    await publishBundleCopy(db.sql, b);
    await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
    const { answer, resends } = await answerAfterKill(
      (tx) => tx`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`,
      (sql) => setActiveBundle(sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
      "reset",
    );
    expect(answer).toEqual({ error: "transient", sqlstate: "08006" });
    expectResentOnTheKilledClient(resends, { result: "activated", repeated: false });
    expect(await activeIds(db.sql)).toEqual([idOf(b)]);
  }, 30_000);

  it("publishBundleCopy, readActiveBundle and readBundleValue on a socket that is reset answer transient (08006), and the same client then answers", async () => {
    await emptyTables(db.sql);
    const published = bundleOf("reset published", 1);
    const stored = bundleOf("reset read", 2);
    await publishBundleCopy(db.sql, stored);
    const publish = await answerAfterKill(lockTables, (sql) => publishBundleCopy(sql, published), "reset");
    expect(publish.answer).toEqual({ error: "transient", sqlstate: "08006" });
    expectResentOnTheKilledClient(publish.resends, { result: "published", repeated: false });
    const active = await answerAfterKill(lockTables, (sql) => readActiveBundle(sql), "reset");
    expect(active.answer).toEqual({ error: "transient", sqlstate: "08006" });
    expectResentOnTheKilledClient(active.resends, { error: "noActiveBundle" });
    const value = await answerAfterKill(
      lockTables,
      (sql) => readBundleValue(sql, { key: stored.manifestKey }),
      "reset",
    );
    expect(value.answer).toEqual({ error: "transient", sqlstate: "08006" });
    expectResentOnTheKilledClient(value.resends, { result: "value" });
  }, 60_000);

  it("isLostConnection and the answers: ECONNRESET, EPIPE and ETIMEDOUT are lost connections; a constraint refusal is not", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "CONNECTION_CLOSED", "08006", "57P01"]) {
      expect(isLostConnection(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    for (const code of ["23505", "40001", "ECONNREFUSED", "CONNECT_TIMEOUT"]) {
      expect(isLostConnection(Object.assign(new Error("x"), { code }))).toBe(false);
    }
  });

  it("publishBundleCopy, readActiveBundle and readBundleValue waiting on a table lock, their backends terminated, answer transient", async () => {
    await emptyTables(db.sql);
    const published = bundleOf("kill published", 1);
    await publishBundleCopy(db.sql, bundleOf("kill read", 2));
    const publish = await answerAfterKill(lockTables, (sql) => publishBundleCopy(sql, published));
    expect(publish.answer).toMatchObject({ error: "transient" });
    expect((publish.answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    // The killed publish wrote nothing: the same request on the killed client publishes it for the first time.
    expectResentOnTheKilledClient(publish.resends, { result: "published", repeated: false });
    const active = await answerAfterKill(lockTables, (sql) => readActiveBundle(sql));
    expect(active.answer).toMatchObject({ error: "transient" });
    expect((active.answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    expectResentOnTheKilledClient(active.resends, { error: "noActiveBundle" });
    const value = await answerAfterKill(lockTables, (sql) =>
      readBundleValue(sql, { key: bundleOf("kill read", 2).manifestKey }),
    );
    expect(value.answer).toMatchObject({ error: "transient" });
    expect((value.answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    expectResentOnTheKilledClient(value.resends, { result: "value" });
  }, 60_000);
});

// ---- T-1314: no failure to reach the database leaves raw --------------------------------------------------------------
//
// The four calls answer a failure exactly as targets.ts's transientOrThrow does, under their K-05 names (Gives 1 and 5);
// isLostConnection knows a socket's failure with no code, so no rollback is written to a dead connection (Gives 2); a
// reserve() that never connects answers 08001 (Gives 3). Each failure that can be made locally is raised for real: a
// closed port, a .invalid host, a login the local database refuses, a socket cut under a statement. The rest are built
// in postgres.js's and Node's shapes (node_modules/postgres/src/errors.js; cf/polyfills.js, whose socket errors carry no
// code) and raised through postgres.js's own socket option, so postgres.js passes each up as it does a socket's error.
// Each raw error is checked to hold what it names, and each outcome to hold none of it. Rule 9: the probe's user,
// password, database and hosts are made up here (.invalid names). A check names what leaked, never its value.

describe("T-1314: a failure to reach the database answers as targets.ts's transientOrThrow does, never raw", () => {
  const PROBE_USER = "t1314_probe_user";
  const PROBE_PASSWORD = "t1314-probe-password";
  const PROBE_DATABASE = "t1314_probe_db";
  /** RFC 6761: no name under .invalid ever resolves. */
  const UNRESOLVABLE_HOST = "rosie-t1314.invalid";
  /** The shapes' made-up host and port. */
  const SHAPE_HOST = "db-t1314.example.invalid";
  const SHAPE_PORT = 65124;
  const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
  const LOST: TransientError = { error: "transient", sqlstate: "08006" };
  const SWITCH_LOCK = "rosie.bundles.active";
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** postgres.js's own PostgresError, which its type file gives no constructor of fields. */
  const { PostgresError } = postgres as unknown as {
    PostgresError: new (fields: Record<string, unknown>) => Error;
  };

  const probeUrl = (host: string, port: number): string =>
    `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;

  type Secrets = Readonly<Record<string, RegExp>>;

  /** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
  function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
    const secrets: Record<string, RegExp> = {};
    for (const [name, value] of Object.entries(values)) {
      secrets[name] =
        typeof value === "number"
          ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
          : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    return secrets;
  }

  /** A connection's own: its host, its port, the probe's user and its password. */
  const connectionSecrets = (host: string, port: number): Secrets =>
    secretsOf({ host, port, user: PROBE_USER, password: PROBE_PASSWORD });
  const SHAPE_SECRETS = connectionSecrets(SHAPE_HOST, SHAPE_PORT);

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
  function textsOf(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    const texts: string[] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      texts.push(key, ...textsOf((value as Record<string, unknown>)[key], seen));
    }
    return texts;
  }

  /** The names of the secrets `value` holds anywhere, never their values. */
  function leaksOf(value: unknown, secrets: Secrets): string[] {
    const texts = textsOf(value);
    return Object.entries(secrets)
      .filter(([, secret]) => texts.some((text) => secret.test(text)))
      .map(([name]) => name);
  }

  /** A local port nothing listens on: one the system just handed out and took back. */
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return port;
  }

  type Outcome = { answer: unknown } | { thrown: unknown };

  async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
    try {
      return { answer: await run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  function syncOutcomeOf(run: () => unknown): Outcome {
    try {
      return { answer: run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  /** What `promise` rejects with (it must reject). */
  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    const outcome = await outcomeOf(() => promise);
    if (!("thrown" in outcome)) {
      throw new Error("the promise was fulfilled");
    }
    return outcome.thrown;
  }

  /** An error's own fields but its stack, which says where it was made. */
  function fieldsOf(error: unknown): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key !== "stack") {
        fields[key] = (error as Record<string, unknown>)[key];
      }
    }
    return fields;
  }

  /**
   * `outcome` is what targets.ts's transientOrThrow makes of `raw` under `call`: the same answer, the same error thrown
   * as it is, or a scrubbed error of the same class with the same fields, the call's name among them.
   */
  function expectAsTargets(outcome: Outcome, raw: Error, call: string): void {
    const expected = syncOutcomeOf(() => transientOrThrow(raw, call));
    if ("answer" in expected) {
      expect(outcome, call).toEqual(expected);
      return;
    }
    const thrown = "thrown" in outcome ? outcome.thrown : undefined;
    if (expected.thrown === raw) {
      expect(thrown === raw, call).toBe(true);
      return;
    }
    expect(thrown instanceof Error && thrown !== raw, call).toBe(true);
    expect((thrown as Error).constructor, call).toBe((expected.thrown as Error).constructor);
    expect(fieldsOf(thrown), call).toEqual(fieldsOf(expected.thrown));
    expect(fieldsOf(thrown), call).toMatchObject({ call });
  }

  /**
   * A client on the made-up connection whose socket fails with `raw` before it opens, as Node's socket or TLS would fail
   * it (postgres.js's own socket option): postgres.js passes `raw` up as it does a socket's error.
   */
  function failingSocketClient(raw: Error): Sql {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    return postgres(probeUrl(SHAPE_HOST, SHAPE_PORT), options);
  }

  /**
   * A client whose statements run on `statements` and whose reserve() is `reserving`'s: the pre-probe answers, and only
   * reserve() opens a connection, as when the probe's connection was taken meanwhile and the one reserve() opens never
   * connects.
   */
  function reserveFrom(statements: Sql, reserving: Sql): Sql {
    return new Proxy(statements, {
      get: (target, key, receiver): unknown =>
        key === "reserve" ? () => reserving.reserve() : (Reflect.get(target, key, receiver) as unknown),
    });
  }

  // The shapes, as postgres.js and Node give them.
  /** postgres.js's own connection error (errors.js connection): "write <code> <host>:<port>". */
  const clientError = (code: string): Error =>
    Object.assign(new Error(`write ${code} ${SHAPE_HOST}:${String(SHAPE_PORT)}`), {
      code,
      errno: code,
      address: SHAPE_HOST,
      port: SHAPE_PORT,
    });
  /** Node's error for a connect its socket could not make: syscall connect, the address and the port. */
  const connectError = (code: string, errno: number): Error =>
    Object.assign(new Error(`connect ${code} ${SHAPE_HOST}:${String(SHAPE_PORT)}`), {
      errno,
      code,
      syscall: "connect",
      address: SHAPE_HOST,
      port: SHAPE_PORT,
    });
  /** Node's error for a name its lookup could not resolve. */
  const lookupError = (code: string, errno: number): Error =>
    Object.assign(new Error(`getaddrinfo ${code} ${SHAPE_HOST}`), {
      errno,
      code,
      syscall: "getaddrinfo",
      hostname: SHAPE_HOST,
    });
  /** The Workers build's socket error (cf/polyfills.js passes the socket's own failure up): no code. */
  const workersSocketError = (): Error =>
    new Error(`Network connection lost to ${SHAPE_HOST}:${String(SHAPE_PORT)}`);
  /** A socket's error whose code is a number, not a name (as a DOMException's is). */
  const numberCodedError = (): Error =>
    Object.assign(new Error(`connect to ${SHAPE_HOST} failed`), { name: "NetworkError", code: 19 });
  /** Node's TLS name check: the host and the certificate on the error. */
  const tlsNameError = (): Error =>
    Object.assign(new Error(`Hostname/IP does not match certificate's altnames: Host: ${SHAPE_HOST}.`), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      host: SHAPE_HOST,
      cert: { subject: { CN: "other.example.invalid" } },
    });
  /** postgres.js's generic error (errors.js generic): "<code>: <text>". */
  const genericError = (code: string, text: string): Error =>
    Object.assign(new Error(`${code}: ${text}`), { code });
  const refusedPassword = `password authentication failed for user "${PROBE_USER}"`;

  const SHAPES: { name: string; make: () => Error; holds: readonly string[] }[] = [
    {
      name: "postgres.js's CONNECT_TIMEOUT",
      make: () => clientError("CONNECT_TIMEOUT"),
      holds: ["host", "port"],
    },
    { name: "Node's ECONNREFUSED", make: () => connectError("ECONNREFUSED", -61), holds: ["host", "port"] },
    { name: "Node's ENOTFOUND", make: () => lookupError("ENOTFOUND", -3008), holds: ["host"] },
    { name: "Node's EAI_AGAIN", make: () => lookupError("EAI_AGAIN", -3001), holds: ["host"] },
    { name: "Node's ECONNRESET", make: () => connectError("ECONNRESET", -54), holds: ["host", "port"] },
    {
      name: "postgres.js's CONNECTION_CLOSED",
      make: () => clientError("CONNECTION_CLOSED"),
      holds: ["host", "port"],
    },
    {
      name: "a socket's failure with no code (the Workers build's)",
      make: workersSocketError,
      holds: ["host", "port"],
    },
    { name: "a socket's failure whose code is a number", make: numberCodedError, holds: ["host"] },
    {
      name: "PostgreSQL's 57P01",
      make: () => new PostgresError({ severity: "FATAL", code: "57P01", message: "terminating connection" }),
      holds: [],
    },
    { name: "Node's TLS name check", make: tlsNameError, holds: ["host"] },
    { name: "Node's EACCES", make: () => connectError("EACCES", -13), holds: ["host", "port"] },
    {
      name: "postgres.js's SASL_SIGNATURE_MISMATCH",
      make: () => genericError("SASL_SIGNATURE_MISMATCH", "The server did not return the correct signature"),
      holds: [],
    },
    {
      name: "PostgreSQL's 28P01, naming the user",
      make: () => new PostgresError({ severity: "FATAL", code: "28P01", message: refusedPassword }),
      holds: ["user"],
    },
    {
      name: "a PostgresError with no SQLSTATE, naming the user",
      make: () => new PostgresError({ severity: "FATAL", message: refusedPassword }),
      holds: ["user"],
    },
    {
      name: "a statement's own refusal (23505), thrown as it is",
      make: () => new PostgresError({ severity: "ERROR", code: "23505", message: "duplicate key value" }),
      holds: [],
    },
    {
      name: "a TypeError for a value postgres.js cannot send, thrown as it is",
      make: () => new TypeError("Do not know how to serialize a BigInt"),
      holds: [],
    },
  ];

  const CALLS: [string, (sql: Sql) => Promise<unknown>][] = [
    ["readActiveBundle", (sql) => readActiveBundle(sql)],
    [
      "readBundleValue",
      (sql) => readBundleValue(sql, exchange("bundle-value-on-miss.json").request as never),
    ],
    [
      "publishBundleCopy",
      (sql) => publishBundleCopy(sql, exchange("publish-bundle-copy.json").request as never),
    ],
    ["setActiveBundle", (sql) => setActiveBundle(sql, exchange("set-active-bundle.json").request as never)],
  ];
  /** The two calls that reserve a connection for their transaction (inTransaction). */
  const RESERVING_CALLS = CALLS.filter(
    ([call]) => call === "publishBundleCopy" || call === "setActiveBundle",
  );

  describe("Gives 1 and 5: each call answers as targets.ts's transientOrThrow does, under its own name", () => {
    it.each(SHAPES)("$name", async ({ make, holds }) => {
      for (const [call, run] of CALLS) {
        const raw = make();
        expect(leaksOf(raw, SHAPE_SECRETS), call).toEqual(expect.arrayContaining([...holds]));
        const sql = failingSocketClient(raw);
        let outcome: Outcome;
        try {
          outcome = await outcomeOf(() => run(sql));
        } finally {
          await sql.end({ timeout: 0 });
        }
        // postgres.js rejected the call's first statement with the socket's error, the statement put on it.
        expect(Object.hasOwn(raw, "query"), call).toBe(true);
        expectAsTargets(outcome, raw, call);
        if (!("thrown" in outcome && outcome.thrown === raw)) {
          expect(leaksOf(outcome, SHAPE_SECRETS), call).toEqual([]);
        }
      }
    });

    it("readActiveBundle on a closed port (ECONNREFUSED, the case found) and the others answer 08001, holding none of it", async () => {
      const port = await closedPort();
      for (const [call, run] of CALLS) {
        const client = createClient({ primaryUrl: probeUrl("127.0.0.1", port), max: 1, env: {} });
        try {
          const outcome = await run(client.primary);
          expect(outcome, call).toEqual(NEVER_OPENED);
          expect(leaksOf(outcome, connectionSecrets("127.0.0.1", port)), call).toEqual([]);
        } finally {
          await client.close();
        }
      }
    });

    it("an unresolvable .invalid host (ENOTFOUND, or EAI_AGAIN with no resolver) answers 08001 from each call", async () => {
      for (const [call, run] of CALLS) {
        const client = createClient({ primaryUrl: probeUrl(UNRESOLVABLE_HOST, SHAPE_PORT), max: 1, env: {} });
        try {
          const outcome = await run(client.primary);
          expect(outcome, call).toEqual(NEVER_OPENED);
          expect(leaksOf(outcome, connectionSecrets(UNRESOLVABLE_HOST, SHAPE_PORT)), call).toEqual([]);
        } finally {
          await client.close();
        }
      }
    });

    it("a login the local database refuses (class 28, naming the user) is thrown as DataAccessDatabaseError under each call's name", async () => {
      const url = new URL(resolvePrimaryUrl());
      url.username = PROBE_USER;
      url.password = PROBE_PASSWORD;
      const secrets = connectionSecrets(url.hostname, url.port === "" ? 5432 : Number(url.port));
      for (const [call, run] of CALLS) {
        const client = createClient({ primaryUrl: url.toString(), max: 1, env: {} });
        try {
          const thrown = await rejectionOf(run(client.primary));
          expect(thrown, call).toBeInstanceOf(DataAccessDatabaseError);
          expect(thrown, call).toMatchObject({ call, table: null, constraint: null });
          expect(["28P01", "28000"], call).toContain((thrown as { code: string }).code);
          expect(leaksOf(thrown, secrets), call).toEqual([]);
        } finally {
          await client.close();
        }
      }
    });
  });

  describe("Gives 3: a reserve() that never connects answers 08001", () => {
    it("as the Workers build passes it up (no code, no statement): publishBundleCopy and setActiveBundle answer 08001", async () => {
      for (const [call, run] of RESERVING_CALLS) {
        const raw = workersSocketError();
        const reserving = failingSocketClient(raw);
        try {
          const outcome = await run(reserveFrom(db.sql, reserving));
          expect(outcome, call).toEqual(NEVER_OPENED);
          expect(leaksOf(outcome, SHAPE_SECRETS), call).toEqual([]);
        } finally {
          await reserving.end({ timeout: 0 });
        }
        // postgres.js passed the socket's error up as it is (connection.js queryError: no statement on a reserve()'s
        // error), with no code and its host and port in its message: targets.ts's transientOrThrow alone would throw it
        // as it is.
        expect((raw as { code?: unknown }).code, call).toBeUndefined();
        expect(Object.hasOwn(raw, "query") || Object.hasOwn(raw, "parameters"), call).toBe(false);
        expect(leaksOf(raw, SHAPE_SECRETS), call).toEqual(expect.arrayContaining(["host", "port"]));
        expect(
          syncOutcomeOf(() => transientOrThrow(raw, call)),
          call,
        ).toEqual({ thrown: raw });
      }
    });

    it("for real on a closed port (Node's ECONNREFUSED, on no statement): publishBundleCopy and setActiveBundle answer 08001", async () => {
      const port = await closedPort();
      for (const [call, run] of RESERVING_CALLS) {
        const reserving = postgres(probeUrl("127.0.0.1", port), { max: 1, onnotice: () => undefined });
        try {
          const outcome = await run(reserveFrom(db.sql, reserving));
          expect(outcome, call).toEqual(NEVER_OPENED);
          expect(leaksOf(outcome, connectionSecrets("127.0.0.1", port)), call).toEqual([]);
        } finally {
          await reserving.end({ timeout: 0 });
        }
      }
    });

    it("reserveConnection passes a failure with no code on as the code 08001 alone, and any other as it is", async () => {
      const raw = workersSocketError();
      const workers = failingSocketClient(raw);
      try {
        const thrown = await rejectionOf(reserveConnection(workers));
        expect(thrown).not.toBe(raw);
        expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["code", "message", "stack"]);
        expect(thrown).toMatchObject({
          code: "08001",
          message: "the database connection never opened (SQLSTATE 08001)",
        });
        expect(leaksOf(thrown, SHAPE_SECRETS)).toEqual([]);
        expect(transientOrThrow(thrown, "probeCall")).toEqual(NEVER_OPENED);
      } finally {
        await workers.end({ timeout: 0 });
      }
      // A failure with a code, or PostgreSQL's own, goes on as it is, for transientOrThrow's lists to answer.
      for (const make of [
        () => connectError("ECONNREFUSED", -61),
        tlsNameError,
        () => new PostgresError({ severity: "FATAL", message: refusedPassword }),
      ]) {
        const coded = make();
        const client = failingSocketClient(coded);
        try {
          expect(await rejectionOf(reserveConnection(client))).toBe(coded);
        } finally {
          await client.end({ timeout: 0 });
        }
      }
    });
  });

  describe("Gives 2: a socket's failure with no code is a lost connection, and no rollback is written to it", () => {
    /** As postgres.js's queryError puts the statement it rejects on its error: unenumerable, unless its debug is on. */
    function onStatement<T extends Error>(error: T, debug = false): T {
      return Object.defineProperties(error, {
        query: { value: "select * from bundles where active", enumerable: debug },
        parameters: { value: [], enumerable: debug },
        args: { value: [], enumerable: debug },
        types: { value: [], enumerable: debug },
      });
    }

    it("isLostConnection is true exactly where targets.ts's transientOrThrow answers an error with no code 08006", () => {
      const cases: [string, Error, boolean][] = [
        ["a socket's failure with no code (the Workers build's)", onStatement(workersSocketError()), true],
        ["the same under postgres.js's debug", onStatement(workersSocketError(), true), true],
        ["a socket's failure whose code is a number", onStatement(numberCodedError()), true],
        [
          "a TypeError for a value it cannot send",
          onStatement(new TypeError("Do not know how to serialize")),
          false,
        ],
        [
          "a PostgresError with no SQLSTATE",
          onStatement(new PostgresError({ message: refusedPassword })),
          false,
        ],
        ["a reserve()'s socket failure, on no statement", workersSocketError(), false],
        ["db/repo's own error", new Error("the bundle row is missing after a conflict"), false],
      ];
      for (const [name, error, lost] of cases) {
        expect(isLostConnection(error), name).toBe(lost);
        const answered = syncOutcomeOf(() => transientOrThrow(error, "probeCall"));
        if (lost) {
          expect(answered, name).toEqual({ answer: LOST });
        } else {
          expect(answered, name).not.toEqual({ answer: LOST });
        }
      }
    });

    /**
     * A one-connection client of the test schema whose sockets the test holds, so it can fail the live one as the Workers
     * build's socket fails: an error with no code (cf/polyfills.js), which postgres.js puts the statement in flight on.
     */
    function cuttableClient(): { sql: Sql; cut: () => void } {
      const url = new URL(resolvePrimaryUrl());
      const sockets: net.Socket[] = [];
      const options = {
        max: 1,
        onnotice: () => undefined,
        connection: { search_path: `${db.schema}, public` },
        socket: () => {
          const socket = net.connect(Number(url.port === "" ? "5432" : url.port), url.hostname);
          sockets.push(socket);
          return socket;
        },
      };
      return {
        sql: postgres(url.toString(), options),
        cut: () => {
          sockets.at(-1)?.destroy(workersSocketError());
        },
      };
    }

    /**
     * Runs `call` on a cuttable client while another connection holds what the call waits on (`take`, in its own
     * transaction), cuts the call's socket once its backend waits on that lock, and returns the call's answer and the
     * same request sent again on that client once the lock is let go (after `beforeResend`, which reads what the cut call
     * left), until one answers without transient (at most 4). Were a rollback written to the dead connection, the call
     * would never answer (postgres.js keeps a write to a destroyed socket queued) and the test would time out.
     */
    async function answerAfterCut<T>(
      take: (tx: postgres.TransactionSql) => Promise<unknown>,
      call: (sql: Sql) => Promise<T>,
      beforeResend: () => Promise<void>,
    ): Promise<{ answer: T; resends: T[] }> {
      const holder = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
      const victim = cuttableClient();
      try {
        let letGo: () => void = () => undefined;
        const hold = new Promise<void>((resolve) => {
          letGo = resolve;
        });
        let locked: () => void = () => undefined;
        const isLocked = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const holding = holder.begin(async (tx) => {
          await take(tx);
          locked();
          await hold;
        });
        await isLocked;
        const [backend] = await victim.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const pid = backend?.pid ?? 0;
        const answering = call(victim.sql);
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const [state] = await db.sql<{ waiting: boolean }[]>`
            select (wait_event_type = 'Lock') as waiting from pg_stat_activity where pid = ${pid}
          `;
          waiting = state?.waiting === true;
          if (!waiting) {
            await sleep(50);
          }
        }
        expect(waiting).toBe(true);
        victim.cut();
        const answer = await answering;
        letGo();
        await holding;
        await beforeResend();
        const resends: T[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const again = await call(victim.sql);
          resends.push(again);
          if ((again as { error?: string }).error !== "transient") {
            break;
          }
        }
        return { answer, resends };
      } finally {
        await victim.sql.end({ timeout: 0 });
        await holder.end({ timeout: 5 });
      }
    }

    /** At most one stale transient, then the answer the call gives on a working connection. */
    function expectResent(resends: unknown[], expected: Record<string, unknown>): void {
      expect(resends.length).toBeGreaterThanOrEqual(1);
      expect(resends.length).toBeLessThanOrEqual(2);
      for (const stale of resends.slice(0, -1)) {
        expect(stale).toMatchObject({ error: "transient" });
      }
      expect(resends.at(-1)).toMatchObject(expected);
    }

    it("setActiveBundle (inTransaction) waiting on the switch lock, its socket failing with no code, answers 08006 and writes no rollback; the same client then switches", async () => {
      await emptyTables(db.sql);
      const [a, b] = [bundleOf("cut a", 1), bundleOf("cut b", 2)] as [
        PublishBundleCopyRequest,
        PublishBundleCopyRequest,
      ];
      await publishBundleCopy(db.sql, a);
      await publishBundleCopy(db.sql, b);
      await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
      const { answer, resends } = await answerAfterCut(
        (tx) => tx`select pg_advisory_xact_lock(hashtext(${SWITCH_LOCK}))`,
        (sql) =>
          setActiveBundle(sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
        async () => {
          // The cut switch wrote nothing: a is still the one active id.
          expect(await activeIds(db.sql)).toEqual([idOf(a)]);
        },
      );
      expect(answer).toEqual(LOST);
      expectResent(resends, { result: "activated", repeated: false });
      expect(await activeIds(db.sql)).toEqual([idOf(b)]);
    }, 30_000);

    it("handleTargets (targets.ts inRuntimeTransaction) waiting on a table lock, its socket failing with no code, answers 08006 and writes no rollback; the same client then answers", async () => {
      const request = exchange("targets-alex.json").request as { handleId: string };
      const { answer, resends } = await answerAfterCut(
        (tx) => tx`lock table ${tx(db.schema)}.handles in access exclusive mode`,
        (sql) => handleTargets(sql, request),
        () => Promise.resolve(),
      );
      expect(answer).toEqual(LOST);
      expectResent(resends, { error: "notFound", table: "handles", rowId: request.handleId });
    }, 30_000);

    // ---- round 2 (DL-649, T-1330's finding b): ECONNABORTED, and a lost connection at the commit or the rollback ----
    //
    // isLostConnection knows Node's ECONNABORTED, and a socket's failure with no code at a commit or a rollback as at any
    // other statement (postgres.js puts the commit or the rollback in flight on it), so the dead connection is never sent
    // a rollback nor released to the pool. Each cut is raised for real: the client's socket fails with the shape the
    // moment the client writes the commit or the rollback, which never reaches the server.

    /** Node's error for a connection its own side gave up, as a socket's write gives it, the made-up host and port on it. */
    const abortedError = (): Error =>
      Object.assign(new Error(`write ECONNABORTED ${SHAPE_HOST}:${String(SHAPE_PORT)}`), {
        errno: -53,
        code: "ECONNABORTED",
        syscall: "write",
        address: SHAPE_HOST,
        port: SHAPE_PORT,
      });

    it("isLostConnection is true for Node's ECONNABORTED, on a statement or not; targets.ts's transientOrThrow still throws it scrubbed", () => {
      for (const [name, error] of [
        ["on no statement", abortedError()],
        ["on a statement", onStatement(abortedError())],
      ] as const) {
        expect(isLostConnection(error), name).toBe(true);
        const answered = syncOutcomeOf(() => transientOrThrow(error, "probeCall"));
        expect("thrown" in answered && answered.thrown !== error, name).toBe(true);
        expect("thrown" in answered ? fieldsOf(answered.thrown) : {}, name).toMatchObject({
          call: "probeCall",
          code: "ECONNABORTED",
        });
        expect(leaksOf(answered, SHAPE_SECRETS), name).toEqual([]);
      }
    });

    /**
     * A one-connection client of the test schema whose socket fails with `make()` the moment the client writes
     * `statement` (its text, as postgres.js's Parse message holds it on a connection that has not prepared it), instead
     * of writing it: the statement never reaches the server, which rolls the transaction back when the socket closes.
     * `failed()` is the error the socket failed with, once it has.
     */
    function failingAtClient(
      statement: string,
      make: () => Error,
    ): { sql: Sql; failed: () => Error | undefined } {
      const url = new URL(resolvePrimaryUrl());
      const marker = `\0${statement}\0`;
      let failed: Error | undefined;
      const options = {
        max: 1,
        onnotice: () => undefined,
        connection: { search_path: `${db.schema}, public` },
        socket: () => {
          const socket = net.connect(Number(url.port === "" ? "5432" : url.port), url.hostname);
          const write = socket.write.bind(socket) as (chunk: Uint8Array, ...rest: unknown[]) => boolean;
          socket.write = (chunk: Uint8Array, ...rest: unknown[]): boolean => {
            if (failed === undefined && new TextDecoder().decode(chunk).includes(marker)) {
              failed = make();
              socket.destroy(failed);
              return false;
            }
            return write(chunk, ...rest);
          };
          return socket;
        },
      };
      return { sql: postgres(url.toString(), options), failed: () => failed };
    }

    /**
     * Runs `call` on a client whose socket fails with `make()` at `statement`, then `resend` on that same client: what the
     * call answered or threw, the error the socket failed with, and the resend's answer. Were the dead connection released
     * to the pool, the resend would be written to its null socket (postgres.js 3.4.9 connection.js nextWrite), throw
     * outside any promise and never answer, and the test would fail by its timeout.
     */
    async function cutAt<T>(
      statement: "commit" | "rollback",
      make: () => Error,
      call: (sql: Sql) => Promise<unknown>,
      resend: (sql: Sql) => Promise<T>,
    ): Promise<{ outcome: Outcome; failed: Error; resent: T }> {
      const client = failingAtClient(statement, make);
      try {
        const outcome = await outcomeOf(() => call(client.sql));
        const failed = client.failed();
        if (failed === undefined) {
          throw new Error(`the client never wrote ${statement}`);
        }
        return { outcome, failed, resent: await resend(client.sql) };
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    }

    /**
     * The cut was at `statement` (postgres.js put it on the socket's error), the error is a lost connection and holds the
     * made-up host and port, and the call's outcome is what targets.ts's transientOrThrow makes of it under `call`,
     * holding none of them.
     */
    function expectCutAnswered(
      cut: { outcome: Outcome; failed: Error },
      statement: string,
      call: string,
    ): void {
      expect(Object.getOwnPropertyDescriptor(cut.failed, "query")?.value, call).toBe(statement);
      expect(isLostConnection(cut.failed), call).toBe(true);
      expect(leaksOf(cut.failed, SHAPE_SECRETS), call).toEqual(expect.arrayContaining(["host", "port"]));
      expectAsTargets(cut.outcome, cut.failed, call);
      expect(leaksOf(cut.outcome, SHAPE_SECRETS), call).toEqual([]);
    }

    const CUTS: { name: string; make: () => Error; outcome: (call: string) => unknown }[] = [
      {
        name: "a socket's failure with no code (the Workers build's)",
        make: workersSocketError,
        outcome: () => ({ answer: LOST }),
      },
      {
        name: "Node's ECONNABORTED",
        make: abortedError,
        outcome: (call) => ({ thrown: expect.objectContaining({ call, code: "ECONNABORTED" }) as unknown }),
      },
    ];

    it.each(CUTS)(
      "setActiveBundle (inTransaction), its socket failing at the commit with $name: lost, never released; the same client then switches",
      async ({ make, outcome }) => {
        await emptyTables(db.sql);
        const [a, b] = [bundleOf("commit cut a", 1), bundleOf("commit cut b", 2)] as [
          PublishBundleCopyRequest,
          PublishBundleCopyRequest,
        ];
        await publishBundleCopy(db.sql, a);
        await publishBundleCopy(db.sql, b);
        await setActiveBundle(db.sql, { bundleId: idOf(a), expectActive: null, at: "2026-11-08T10:00:00Z" });
        const request = { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" };
        const cut = await cutAt(
          "commit",
          make,
          (sql) => setActiveBundle(sql, request),
          async (sql) => {
            // The commit never reached the server: a is still the one active id.
            expect(await activeIds(db.sql)).toEqual([idOf(a)]);
            return setActiveBundle(sql, request);
          },
        );
        expectCutAnswered(cut, "commit", "setActiveBundle");
        expect(cut.outcome).toEqual(outcome("setActiveBundle"));
        expect(cut.resent).toMatchObject({ result: "activated", repeated: false });
        expect(await activeIds(db.sql)).toEqual([idOf(b)]);
      },
      30_000,
    );

    it.each(CUTS)(
      "publishBundleCopy (inTransaction), its socket failing at the rollback of a refused insert with $name: lost, never released; the same client then publishes",
      async ({ make, outcome }) => {
        await emptyTables(db.sql);
        const bundle = bundleOf("rollback cut", 3);
        const cut = await cutAt(
          "rollback",
          make,
          // A builtAt PostgreSQL cannot read refuses the insert (22007), so the transaction is rolled back.
          (sql) => publishBundleCopy(sql, { ...bundle, builtAt: "not a time" }),
          (sql) => publishBundleCopy(sql, bundle),
        );
        expectCutAnswered(cut, "rollback", "publishBundleCopy");
        expect(cut.outcome).toEqual(outcome("publishBundleCopy"));
        // Nothing was written before the cut: the same client publishes it for the first time.
        expect(cut.resent).toMatchObject({ result: "published", repeated: false });
      },
      30_000,
    );

    it.each(CUTS)(
      "handleTargets (targets.ts inRuntimeTransaction), its socket failing at the commit with $name: lost, never released; the same client then answers",
      async ({ make, outcome }) => {
        const request = exchange("targets-alex.json").request as { handleId: string };
        const cut = await cutAt(
          "commit",
          make,
          (sql) => handleTargets(sql, request),
          (sql) => handleTargets(sql, request),
        );
        expectCutAnswered(cut, "commit", "handleTargets");
        expect(cut.outcome).toEqual(outcome("handleTargets"));
        expect(cut.resent).toMatchObject({ error: "notFound", table: "handles", rowId: request.handleId });
      },
      30_000,
    );
  });
});

// ---- T-1350: inTransaction decides its rollback and its release by targets.ts's foundGone (T-1334's handoff a) --------
//
// publishBundleCopy and setActiveBundle run inTransaction, which decides as inRuntimeTransaction does (T-1334, DL-649):
// a connection fn found gone (a lost connection, or a statement's failure that is a session's failure or that
// transientOrThrow answers 08001) is sent no rollback and is never released. A rosie_job client of this file's schema
// (one connection; the runtime side's role holds the grants on bundles and bundle_values both calls use) has its socket
// cut the 8 ways T-1334 cut inRuntimeTransaction's: as fn's first statement is written, which is then never written; and
// (T-1330's note d) at the first turn of the event loop after fn's first statement is answered, the connection idle in
// its transaction, by which time fn's next statement is already in flight, so postgres.js rejects it with the socket's
// error, or with its own CONNECTION_CLOSED. The socket is destroyed with an error built in the shape Node, OpenSSL or
// postgres.js gives it, or with none. A probe cut the same way shows each raw error holds what it names and the value of
// the statement it rejected, so the checks mean something; each outcome holds none of it, nor any value fn's statements
// carried; nothing is sent after the cut, no rollback and no commit; nothing is thrown outside a promise; a statement
// sent on the same client at once is answered on a new connection, so the dead connection was never released to the
// pool; and the call then answers on the same client. An error fn makes itself, on no statement (a value of the request
// fn reads after its first statement, which then throws in the shape of Node's EACCES, an address and a port on it),
// found no connection gone, whatever its code: it is rolled back, and the connection is released.
//
// Rule 9: the probe's user, password, database, host, address and value are made up here (a .invalid name, RFC 5737's
// documentation address). A check names what leaked, never its value.

describe("T-1350: inTransaction writes no rollback to a connection fn found gone, and never releases it (targets.ts foundGone)", () => {
  const PROBE_USER = "t1350_probe_user";
  const PROBE_PASSWORD = "t1350-probe-password";
  const PROBE_DATABASE = "t1350_probe_db";
  const HOST = "db-t1350.example.invalid";
  const ADDRESS = "203.0.113.50";
  const PORT = 65150;
  /** The runtime side's role (T-191). */
  const RUNTIME_ROLE = "rosie_job";
  const NEVER_OPENED: TransientError = { error: "transient", sqlstate: "08001" };
  const LOST: TransientError = { error: "transient", sqlstate: "08006" };
  /** The transaction's start: fn's first statement is the one built right after it. */
  const BEGIN = "begin";
  /** The probe's statement as postgres.js builds it, and the value it carries. */
  const PROBE_STATEMENT = "select $1::text as t1350_cut";
  const PROBE_VALUE = "t1350-probe-value";
  /** How long a call may take before it counts as never settled (a statement written to no socket never settles). */
  const SETTLES_WITHIN = 10_000;
  const CUT_TIMEOUT = 60_000;

  type Secrets = Readonly<Record<string, RegExp>>;
  type Outcome = { answer: unknown } | { thrown: unknown };
  /** What a call gives: K-05's answer, or an error thrown scrubbed to the call's name and this code alone. */
  type Expected = { answer: unknown } | { code: string };

  const probeUrl = (host: string, port: number): string =>
    `postgres://${PROBE_USER}:${PROBE_PASSWORD}@${host}:${String(port)}/${PROBE_DATABASE}`;

  /** The secrets by name: a text wherever it appears, a number (a port) as a whole number. */
  function secretsOf(values: Readonly<Record<string, string | number>>): Secrets {
    const secrets: Record<string, RegExp> = {};
    for (const [name, value] of Object.entries(values)) {
      secrets[name] =
        typeof value === "number"
          ? new RegExp(`(^|[^0-9])${String(value)}([^0-9]|$)`)
          : new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    return secrets;
  }

  /** The made-up connection the built errors name. */
  const SHAPE_SECRETS = secretsOf({
    host: HOST,
    address: ADDRESS,
    port: PORT,
    user: PROBE_USER,
    password: PROBE_PASSWORD,
    database: PROBE_DATABASE,
  });

  /**
   * What an outcome must never hold: the made-up connection, and the local server's host and port, which postgres.js's
   * own CONNECTION_CLOSED names. The local login, password and database are `rosie`, this repository's own folder, which
   * every stack's file paths name, so they are not listed: postgres.js's connection errors never carry them.
   */
  function cutSecrets(): Secrets {
    const url = new URL(resolvePrimaryUrl());
    const port = url.port === "" ? 5432 : Number(url.port);
    return { ...SHAPE_SECRETS, ...secretsOf({ "server host": url.hostname, "server port": port }) };
  }

  /** The texts of 8 characters or more among statements' values (their parameters), each named by its place alone. */
  function valueSecrets(values: readonly (readonly unknown[])[]): Secrets {
    const texts = values
      .flat()
      .filter((value): value is string => typeof value === "string" && value.length >= 8);
    return secretsOf(Object.fromEntries(texts.map((text, index) => [`value ${String(index + 1)}`, text])));
  }

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not (an error's stack too). */
  function textsOf(value: unknown, seen = new Set<object>()): string[] {
    if (typeof value === "string") {
      return [value];
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return [String(value)];
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return [];
    }
    seen.add(value);
    return Object.getOwnPropertyNames(value).flatMap((key) => [
      key,
      ...textsOf((value as Record<string, unknown>)[key], seen),
    ]);
  }

  /** The names of the secrets `value` holds anywhere, never their values. */
  function leaksOf(value: unknown, secrets: Secrets): string[] {
    const texts = textsOf(value);
    return Object.entries(secrets)
      .filter(([, secret]) => texts.some((text) => secret.test(text)))
      .map(([name]) => name);
  }

  async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
    try {
      return { answer: await run() };
    } catch (error) {
      return { thrown: error };
    }
  }

  /**
   * What `run` gives, or "never settled" after SETTLES_WITHIN, and every error thrown outside any promise meanwhile:
   * postgres.js writes a statement from a timer, so a write to a connection with no socket throws there.
   */
  async function watched(
    run: () => Promise<unknown>,
  ): Promise<{ outcome: Outcome | "never settled"; uncaught: unknown[] }> {
    const uncaught: unknown[] = [];
    const note = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", note);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        outcomeOf(run),
        new Promise<"never settled">((resolve) => {
          timer = setTimeout(() => {
            resolve("never settled");
          }, SETTLES_WITHIN);
        }),
      ]);
      // A write postgres.js put on a timer has run by the next turn of the event loop.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return { outcome, uncaught };
    } finally {
      clearTimeout(timer);
      process.off("uncaughtException", note);
    }
  }

  /** `outcome` is `expected`: the answer, or an error with the call's name and the code alone, nothing of the original. */
  function expectOutcome(outcome: Outcome | "never settled", expected: Expected, call: string): void {
    if ("answer" in expected) {
      expect(outcome, call).toEqual({ answer: expected.answer });
      return;
    }
    if (outcome === "never settled" || !("thrown" in outcome)) {
      throw new Error(`${call} did not throw`);
    }
    const { thrown } = outcome;
    expect(thrown, call).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(thrown).sort(), call).toEqual(["call", "code", "message", "stack"]);
    expect(thrown, call).toMatchObject({
      call,
      code: expected.code,
      message: `${call}: the database call failed (code ${expected.code})`,
    });
  }

  // The errors, in the shapes Node, OpenSSL and postgres.js give them, each naming the made-up connection.

  /** postgres.js's own connection error (errors.js connection): "write <code> <host>:<port>". */
  const connectionError = (code: string): Error =>
    Object.assign(new Error(`write ${code} ${HOST}:${String(PORT)}`), {
      code,
      errno: code,
      address: HOST,
      port: PORT,
    });
  /** Node's error for a connection the other end reset under a read: syscall read, and no address on it. */
  const resetError = (): Error =>
    Object.assign(new Error("read ECONNRESET"), { errno: -54, code: "ECONNRESET", syscall: "read" });
  /** A socket's failure with no code (the Workers build's), naming the made-up connection string. */
  const codelessError = (): Error => new Error(`the socket closed: ${probeUrl(HOST, PORT)}`);
  /** Node's error on a connected socket's read or write: the syscall, the address and the port. */
  const socketError = (syscall: string, code: string, errno: number): Error =>
    Object.assign(new Error(`${syscall} ${code} ${ADDRESS}:${String(PORT)}`), {
      errno,
      code,
      syscall,
      address: ADDRESS,
      port: PORT,
    });
  /** OpenSSL's error for a record it could not decrypt, as Node's TLS socket gives it, the made-up host and port in it. */
  const tlsRecordError = (): Error =>
    Object.assign(
      new Error(`error:0A000119:SSL routines::decryption failed or bad record mac (${HOST}:${String(PORT)})`),
      {
        library: "SSL routines",
        reason: "decryption failed or bad record mac",
        code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
      },
    );
  /** A socket's error that no list names, known only by a connection's marks (syscall, errno), the made-up host on it. */
  const ioError = (): Error =>
    Object.assign(new Error(`read EIO ${HOST}`), { errno: -5, code: "EIO", syscall: "read", hostname: HOST });

  /** T-1334's 8 ways: isLostConnection's own 4 (T-1330's), then DL-649's 4, which only foundGone knows. */
  const CUTS: { name: string; raw: () => Error | null; holds: readonly string[]; expected: Expected }[] = [
    {
      name: "the socket closes: postgres.js's own CONNECTION_CLOSED, the server's host and port in it",
      raw: () => null,
      holds: ["server host", "server port"],
      expected: { answer: LOST },
    },
    {
      name: "postgres.js's CONNECTION_CLOSED, the made-up host and port on it",
      raw: () => connectionError("CONNECTION_CLOSED"),
      holds: ["host", "port"],
      expected: { answer: LOST },
    },
    { name: "Node's ECONNRESET under a read", raw: resetError, holds: [], expected: { answer: LOST } },
    {
      name: "a socket's failure with no code (the Workers build's), the made-up connection string in it",
      raw: codelessError,
      holds: ["host", "port", "user", "password", "database"],
      expected: { answer: LOST },
    },
    {
      name: "Node's EHOSTUNREACH under a read, the made-up address and port on it (answered 08001)",
      raw: () => socketError("read", "EHOSTUNREACH", -65),
      holds: ["address", "port"],
      expected: { answer: NEVER_OPENED },
    },
    {
      name: "Node's EPERM on a write, the made-up address and port on it (a session's failure)",
      raw: () => socketError("write", "EPERM", -1),
      holds: ["address", "port"],
      expected: { code: "EPERM" },
    },
    {
      name: "OpenSSL's bad record MAC under a read, the made-up host and port in it (a TLS error)",
      raw: tlsRecordError,
      holds: ["host", "port"],
      expected: { code: "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC" },
    },
    {
      name: "Node's EIO under a read, known by a connection's marks alone, the made-up host on it",
      raw: ioError,
      holds: ["host"],
      expected: { code: "EIO" },
    },
  ];

  /**
   * Where a client's socket is cut, with `raw` or none (it closes): `write`, as the statement `on` picks (the last built)
   * is written, which is then never written; `answered`, at the first turn of the event loop after that statement's
   * answer has come (its ReadyForQuery), the connection idle in its transaction.
   */
  interface Cut {
    on: (sent: readonly string[]) => boolean;
    when: "write" | "answered";
    raw: Error | null;
  }

  /** A chunk the server sent that ends with ReadyForQuery ('Z', length 5, the transaction's status): an answer's end. */
  function endsAnswer(chunk: unknown): boolean {
    if (!(chunk instanceof Uint8Array) || chunk.length < 6) {
      return false;
    }
    const at = chunk.length - 6;
    return [0x5a, 0, 0, 0, 5].every((byte, index) => chunk[at + index] === byte);
  }

  /**
   * A client of this file's schema as rosie_job (the schema first), one connection, through a socket to the same server
   * that is cut once, as `cut` says (postgres.js's own socket option, as targets.int.test.ts cuts one for T-1334). `sent`
   * holds each statement's text as postgres.js built it (its debug hook), in order, and `values` its parameters: a
   * statement written to a connection with no socket is built, so it is listed too. `builtAtCut` is how many statements
   * were built when the socket was cut.
   */
  function cutClient(cut: Cut | null): {
    sql: Sql;
    sent: string[];
    values: unknown[][];
    builtAtCut: () => number | undefined;
  } {
    const url = new URL(resolvePrimaryUrl());
    const sent: string[] = [];
    const values: unknown[][] = [];
    let armed = false;
    let builtAtCut: number | undefined;
    const destroy = (socket: net.Socket): void => {
      builtAtCut = sent.length;
      socket.destroy(cut?.raw ?? undefined);
    };
    const options = {
      max: 1,
      onnotice: () => undefined,
      connection: {
        application_name: "rosie-t1350-bundles-cut",
        search_path: `${db.schema}, public`,
        role: RUNTIME_ROLE,
      },
      debug: (_connection: number, text: string, parameters: unknown[]) => {
        sent.push(text.trim());
        values.push([...parameters]);
        if (cut !== null && builtAtCut === undefined && !armed && cut.on(sent)) {
          armed = true;
        }
      },
      socket: () => {
        const socket = net.connect(Number(url.port === "" ? "5432" : url.port), url.hostname);
        const write = socket.write.bind(socket);
        socket.write = ((...args: Parameters<typeof write>) => {
          if (!armed || cut?.when !== "write") return write(...args);
          armed = false;
          destroy(socket);
          return true;
        }) as typeof socket.write;
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string | symbol, ...args: unknown[]) => {
          const emitted = emit(event, ...args);
          if (armed && cut?.when === "answered" && event === "data" && endsAnswer(args[0])) {
            armed = false;
            setImmediate(() => {
              destroy(socket);
            });
          }
          return emitted;
        }) as typeof socket.emit;
        return socket;
      },
    };
    return { sql: postgres(resolvePrimaryUrl(), options), sent, values, builtAtCut: () => builtAtCut };
  }

  /** fn's first statement: the one built right after the transaction's begin. */
  const fnsFirst = (sent: readonly string[]): boolean => sent.at(-2) === BEGIN;

  // The two calls on inTransaction, each on a bundle no other test publishes.
  const cutBundle = bundleOf("t1350 cut", 50);
  const neverPublished = bundleOf("t1350 never published", 99);
  const CALLS: { call: string; run: (sql: Sql) => Promise<unknown>; answers: Record<string, unknown> }[] = [
    {
      call: "publishBundleCopy",
      run: (sql) => publishBundleCopy(sql, cutBundle),
      answers: { result: "published", bundleId: idOf(cutBundle) },
    },
    {
      call: "setActiveBundle",
      run: (sql) =>
        setActiveBundle(sql, {
          bundleId: idOf(neverPublished),
          expectActive: null,
          at: "2026-11-13T10:00:00Z",
        }),
      answers: { error: "notPublished", bundleId: idOf(neverPublished) },
    },
  ];

  /**
   * The probe: a statement cut as `raw` makes it, as it is written, is rejected with an error that holds what the shape
   * names and the statement's value, the statement put on it.
   */
  async function expectProbeHolds(raw: Error | null, holds: readonly string[]): Promise<void> {
    const probe = cutClient({ on: (sent) => sent.at(-1) === PROBE_STATEMENT, when: "write", raw });
    let rejected: Outcome;
    try {
      rejected = await outcomeOf(() => probe.sql`select ${PROBE_VALUE}::text as t1350_cut`);
    } finally {
      await probe.sql.end({ timeout: 0 });
    }
    if (!("thrown" in rejected)) {
      throw new Error("the cut statement answered");
    }
    const secrets = { ...cutSecrets(), ...secretsOf({ value: PROBE_VALUE }) };
    expect(leaksOf(rejected.thrown, secrets)).toEqual(expect.arrayContaining([...holds, "value"]));
    expect(Object.hasOwn(rejected.thrown as object, "query")).toBe(true);
  }

  /** Each call on a client cut as the shape and `when` say: see the top of this block. */
  async function expectCut(shape: (typeof CUTS)[number], when: Cut["when"]): Promise<void> {
    await expectProbeHolds(shape.raw(), shape.holds);
    for (const { call, run, answers } of CALLS) {
      const raw = shape.raw();
      const client = cutClient({ on: fnsFirst, when, raw });
      try {
        const watchedRun = await watched(async () => {
          const called = await outcomeOf(() => run(client.sql));
          const builtBefore = client.sent.length;
          // At once: a statement that a dead connection released to the pool would take and never answer (postgres.js
          // 3.4.9 queues its write on that connection, and the close then drops it). Not released, it waits for the
          // pool to reconnect.
          const followed = await outcomeOf(async () => [
            ...(await client.sql<{ n: number }[]>`select 2 as n`),
          ]);
          return { called, builtBefore, followed };
        });
        expect(watchedRun.outcome, call).not.toBe("never settled");
        expect(watchedRun.uncaught, call).toEqual([]);
        const { called, builtBefore, followed } = (
          watchedRun.outcome as { answer: { called: Outcome; builtBefore: number; followed: Outcome } }
        ).answer;
        // The statement in flight at the cut: fn's first (write), or fn's second, already built when the connection,
        // idle after fn's first was answered, closed (answered). It is the last one built: no rollback, no commit.
        const first = client.sent.lastIndexOf(BEGIN) + 1;
        const inFlight = when === "write" ? first : first + 1;
        expect(client.builtAtCut(), call).toBe(inFlight + 1);
        expect(builtBefore, call).toBe(inFlight + 1);
        // Neither the connection's details nor any value fn's statements carried leaves.
        const carried = valueSecrets(client.values.slice(first, inFlight + 1));
        expect(Object.keys(carried).length, call).toBeGreaterThan(0);
        expect(leaksOf(called, { ...cutSecrets(), ...carried }), call).toEqual([]);
        expectOutcome(called, shape.expected, call);
        if (raw !== null) {
          // postgres.js rejected the statement in flight with the raw error, that statement and its values put on it.
          expect(Object.hasOwn(raw, "query"), call).toBe(true);
          const inFlightValues = valueSecrets(client.values.slice(inFlight, inFlight + 1));
          expect(leaksOf(raw, inFlightValues), call).toEqual(Object.keys(inFlightValues));
        }
        // The dead connection was never released: the next statement waited for a new one, which answered it.
        expect(followed, call).toEqual({ answer: [{ n: 2 }] });
        // And the call itself answers on the same client.
        const again = await watched(() => run(client.sql));
        expect(again.uncaught, call).toEqual([]);
        expect(again.outcome, call).toMatchObject({ answer: answers });
      } finally {
        await client.sql.end({ timeout: 0 });
      }
    }
  }

  it.each(CUTS)(
    "fn's first statement cut as it is written ($name): no rollback, nothing thrown outside a promise, the error that leaves scrubbed; the same client then answers",
    async (shape) => {
      await expectCut(shape, "write");
    },
    CUT_TIMEOUT,
  );

  it.each(CUTS)(
    "the connection closing while idle after fn's first statement is answered ($name): fn's next statement is in flight, so the same holds",
    async (shape) => {
      await expectCut(shape, "answered");
    },
    CUT_TIMEOUT,
  );

  it("an error fn makes itself, on no statement, found no connection gone, whatever its code: rolled back and released", async () => {
    const own = socketError("connect", "EACCES", -13);
    expect(leaksOf(own, SHAPE_SECRETS)).toEqual(expect.arrayContaining(["address", "port"]));
    const client = cutClient(null);
    const bundle = bundleOf("t1350 own error", 51);
    // fn reads the request's values after its first statement (the bundle's row) has been built, and that read throws.
    const fnStarted = (): boolean => {
      const begin = client.sent.lastIndexOf(BEGIN);
      return begin !== -1 && begin < client.sent.length - 1;
    };
    const request: PublishBundleCopyRequest = {
      ...bundle,
      get values(): StoredText[] {
        if (fnStarted()) {
          throw own;
        }
        return bundle.values;
      },
    };
    try {
      const [before] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const { outcome, uncaught } = await watched(() => publishBundleCopy(client.sql, request));
      expect(uncaught).toEqual([]);
      // Rolled back: the rollback is the last statement built, and the bundle's row is not there.
      expect(client.sent.at(-1)).toBe("rollback");
      expect(await db.sql`select 1 from bundles where hash = ${bundle.bundleId.hash}`).toHaveLength(0);
      // publishBundleCopy answers it as targets.ts's transientOrThrow does: a session's failure, thrown scrubbed.
      expect(leaksOf(outcome, cutSecrets())).toEqual([]);
      expectOutcome(outcome, { code: "EACCES" }, "publishBundleCopy");
      // Released: the client's one connection, the same backend, answers the next statement.
      const next = await watched(async () => [
        ...(await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`),
      ]);
      expect(next.outcome).toEqual({ answer: [{ pid: before?.pid }] });
    } finally {
      await client.sql.end({ timeout: 0 });
    }
  });
});
