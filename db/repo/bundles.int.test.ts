// T-185: the bundle registry against local PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/bundles`).
// The schema comes from migrating a fresh test schema. Fixtures are the frozen ones of contracts/db-schema/core (seeds)
// and contracts/data-access (the calls' requests and outcomes); hashes made up here are sha256 of a label, never data.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, resolvePrimaryUrl } from "./client";
import {
  type BundleId,
  type PublishBundleCopyRequest,
  type StoredText,
  publishBundleCopy,
  readActiveBundle,
  readBundleValue,
  setActiveBundle,
} from "./bundles";
import type { Sql } from "./scope";
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

  /**
   * Runs `call` on its own one-connection client while a second connection holds a lock the call waits on, then
   * terminates the call's backend (pg_terminate_backend) from a third connection, and returns the call's answer.
   */
  async function answerAfterKill<T>(
    take: (tx: postgres.TransactionSql) => Promise<unknown>,
    call: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    const url = resolvePrimaryUrl();
    const holder = postgres(url, { max: 1, onnotice: () => undefined });
    const killer = postgres(url, { max: 1, onnotice: () => undefined });
    const victim = createClient({ primaryUrl: url, schema: db.schema, max: 1 });
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
      await killer`select pg_terminate_backend(${pid})`;

      const answer = await answering;
      letGo();
      await holding;
      return answer;
    } finally {
      await victim.close();
      await killer.end({ timeout: 5 });
      await holder.end({ timeout: 5 });
    }
  }

  const lostConnection = /^(08[0-9A-Z]{3}|57P0[123])$/;
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
    const answer = await answerAfterKill(
      (tx) => tx`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`,
      (sql) => setActiveBundle(sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
    );
    expect(answer).toMatchObject({ error: "transient" });
    expect((answer as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    // Nothing was written: a is still the one active bundle, and a switch still works.
    expect(await activeIds(db.sql)).toEqual([idOf(a)]);
    expect(
      await setActiveBundle(db.sql, { bundleId: idOf(b), expectActive: idOf(a), at: "2026-11-08T11:00:00Z" }),
    ).toMatchObject({ result: "activated", repeated: false });
  }, 30_000);

  it("publishBundleCopy, readActiveBundle and readBundleValue waiting on a table lock, their backends terminated, answer transient", async () => {
    await emptyTables(db.sql);
    const published = bundleOf("kill published", 1);
    await publishBundleCopy(db.sql, bundleOf("kill read", 2));
    const publish = await answerAfterKill(lockTables, (sql) => publishBundleCopy(sql, published));
    expect(publish).toMatchObject({ error: "transient" });
    expect((publish as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    const active = await answerAfterKill(lockTables, (sql) => readActiveBundle(sql));
    expect(active).toMatchObject({ error: "transient" });
    expect((active as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    const value = await answerAfterKill(lockTables, (sql) =>
      readBundleValue(sql, { key: bundleOf("kill read", 2).manifestKey }),
    );
    expect(value).toMatchObject({ error: "transient" });
    expect((value as { sqlstate: string }).sqlstate).toMatch(lostConnection);
    // The killed publish wrote nothing, and the same request can be sent again.
    expect(await publishBundleCopy(db.sql, published)).toMatchObject({
      result: "published",
      repeated: false,
    });
  }, 60_000);
});
