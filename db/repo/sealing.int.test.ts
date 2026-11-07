// T-182: per-person sealing keys against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/repo/sealing`). The schema comes from migrating a fresh test schema.
// The wrapping key of every run is made here, from random bytes, and is never written to a file. Assertions on key
// material compare to true or false, so a failing run prints no key bytes either.
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPerson } from "./people";
import {
  DEFAULT_WRAPPING_KEY_NAME,
  SEAL_FORMAT_V1,
  SEAL_OVERHEAD_BYTES,
  SealingError,
  type SealingErrorCode,
  WRAPPED_KEY_BYTES,
  type WrappingKeys,
  erasePerson,
  getSealingKeyInfo,
  seal,
  unseal,
  unsealText,
} from "./sealing";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";

const CORE_DIR = new URL("../../contracts/db-schema/core/", import.meta.url);
// The tables the migrations so far make. Fixture rows for any other table wait for the migration that makes it.
const LOADED_TABLES = ["businesses", "persons", "person_roles", "sealing_keys"];

interface FixtureFile {
  after: string[];
  rows: { table: string; values: Record<string, string | number | boolean | null> }[];
}

interface ContractTable {
  name: string;
  columns: { name: string; type: string; null: boolean; default?: string }[];
  primaryKey?: string[];
  checks?: { name: string }[];
  foreignKeys?: { name: string }[];
  rowLevelSecurity?: { scope: string };
  versioned: boolean;
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, CORE_DIR), "utf8"));
}

function fixtureRows(file: string, seen = new Set<string>()): FixtureFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const fixture = readJson(`fixtures/${file}`) as FixtureFile;
  return [...fixture.after.flatMap((before) => fixtureRows(before, seen)), ...fixture.rows];
}

async function loadFixture(
  sql: Sql,
  file: string,
): Promise<{ loaded: Record<string, number>; skipped: string[] }> {
  const loaded: Record<string, number> = {};
  const skipped = new Set<string>();
  for (const row of fixtureRows(file)) {
    if (!LOADED_TABLES.includes(row.table)) {
      skipped.add(row.table);
      continue;
    }
    await sql`insert into ${sql(row.table)} ${sql(row.values)}`;
    loaded[row.table] = (loaded[row.table] ?? 0) + 1;
  }
  return { loaded, skipped: [...skipped].sort() };
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

/** The SealingError code a promise fails with. Any other outcome is a failed test. */
async function sealingFailure(promise: Promise<unknown>): Promise<SealingErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SealingError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("the call succeeded; it should have failed with a SealingError");
}

const text = new TextEncoder();
const subtle = crypto.subtle;

function randomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Whether `needle` appears anywhere inside `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (same(haystack.subarray(start, start + needle.length), needle)) {
      return true;
    }
  }
  return false;
}

/** One wrapping key per run: random, in memory only. Named like the Workers secret that will hold the real one. */
const WRAP_BYTES = randomKeyBytes();
const KEYS: WrappingKeys = {
  resolve: (name) => (name === DEFAULT_WRAPPING_KEY_NAME ? toBase64(WRAP_BYTES) : undefined),
};

/**
 * The raw data key of a person, recovered the way the format says (independent of sealing.ts): used only to check the
 * stored bytes against it. It is never printed.
 */
async function rawDataKey(db: TestDatabase, personId: string): Promise<Uint8Array> {
  const [row] = await db.sql<{ wrapped: Uint8Array }[]>`
    select wrapped_key as wrapped from sealing_keys where person_id = ${personId}
  `;
  const wrapped = new Uint8Array(row?.wrapped ?? []);
  const wrappingKey = await subtle.importKey("raw", WRAP_BYTES, "AES-GCM", false, ["unwrapKey"]);
  const dataKey = await subtle.unwrapKey(
    "raw",
    wrapped.slice(13),
    wrappingKey,
    { name: "AES-GCM", iv: wrapped.slice(1, 13), additionalData: text.encode(`rosie:wrap:v1:${personId}`) },
    "AES-GCM",
    true,
    ["decrypt"],
  );
  return new Uint8Array((await subtle.exportKey("raw", dataKey)) as ArrayBuffer);
}

const logs = {
  log: vi.spyOn(console, "log").mockImplementation(() => undefined),
  info: vi.spyOn(console, "info").mockImplementation(() => undefined),
  warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  debug: vi.spyOn(console, "debug").mockImplementation(() => undefined),
};

afterEach(() => {
  // No call of this file writes a log line at all, so none can hold a key or a value.
  for (const spy of Object.values(logs)) {
    expect(spy).not.toHaveBeenCalled();
  }
});

let db: TestDatabase;
let personCount = 0;

async function newPerson(): Promise<string> {
  personCount += 1;
  const id = `person-seal-${String(personCount)}`;
  await createPerson(db.sql, { id, name: "Demo" });
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "sealing" });
  // Where a caller keeps a sealed value: any bytea column. Made here, in the test schema, and dropped with it.
  await db.sql`create table sealed_probe (id text primary key, person_id text not null, value bytea not null)`;
}, 30_000);

afterAll(async () => {
  await db.drop();
});

describe("the migration against the frozen table list (K-04 v1 core: sealing_keys)", () => {
  const listed = (readJson("core.v1.tables.json") as { tables: ContractTable[] }).tables.find(
    (candidate) => candidate.name === "sealing_keys",
  );
  if (listed === undefined) {
    throw new Error("sealing_keys is not in the frozen table list");
  }
  const table: ContractTable = listed;
  const typeNames: Record<string, string> = {
    text: "text",
    integer: "integer",
    bytea: "bytea",
    timestamptz: "timestamp with time zone",
  };

  it("columns, types, nulls and defaults are the table list's", async () => {
    const found = await db.sql<{ name: string; type: string; nullable: string; default: string | null }[]>`
      select column_name as name, data_type as type, is_nullable as nullable, column_default as default
      from information_schema.columns
      where table_schema = ${db.schema} and table_name = 'sealing_keys'
      order by ordinal_position
    `;
    expect(found.map((column) => column.name)).toEqual(table.columns.map((column) => column.name));
    for (const column of table.columns) {
      const actual = found.find((candidate) => candidate.name === column.name);
      expect(actual?.type, `${column.name} type`).toBe(typeNames[column.type]);
      expect(actual?.nullable === "YES", `${column.name} null`).toBe(column.null);
      if (column.default === undefined) {
        expect(actual?.default, `${column.name} default`).toBeNull();
      } else {
        expect(actual?.default, `${column.name} default`).toBe(column.default);
      }
    }
  });

  it("primary key, checks and foreign key are the table list's, and the version trigger is on", async () => {
    const constraints = await db.sql<{ name: string; kind: string; definition: string }[]>`
      select conname as name, contype as kind, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = ${`${db.schema}.sealing_keys`}::regclass
    `;
    expect(constraints.find((constraint) => constraint.kind === "p")?.definition).toBe(
      "PRIMARY KEY (person_id)",
    );
    const named = (kind: string): string[] =>
      constraints
        .filter((constraint) => constraint.kind === kind)
        .map((constraint) => constraint.name)
        .sort();
    expect(named("c")).toEqual((table.checks ?? []).map((check) => check.name).sort());
    expect(named("f")).toEqual((table.foreignKeys ?? []).map((key) => key.name).sort());
    expect(constraints.find((constraint) => constraint.kind === "f")?.definition).toContain(
      "ON DELETE RESTRICT",
    );

    const triggers = await db.sql<{ name: string }[]>`
      select tgname as name from pg_trigger
      where tgrelid = ${`${db.schema}.sealing_keys`}::regclass and not tgisinternal
    `;
    expect(triggers.map((trigger) => trigger.name)).toEqual(["sealing_keys_version_raised"]);
  });

  it("has row-level security scope none: no policy and none switched on", async () => {
    expect(table.rowLevelSecurity?.scope).toBe("none");
    const [flags] = await db.sql<{ on: boolean; policies: string }[]>`
      select c.relrowsecurity as on,
             (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${db.schema} and c.relname = 'sealing_keys'
    `;
    expect(flags).toEqual({ on: false, policies: "0" });
  });

  it("is recorded in schema_migrations after 0002", async () => {
    const rows = await db.sql<{ name: string }[]>`select name from schema_migrations order by version`;
    expect(rows.map((row) => row.name).slice(0, 3)).toEqual([
      "init",
      "core_business_people",
      "core_sealing_keys",
    ]);
  });
});

describe("fixture seed-sealing-key", () => {
  let seeded: TestDatabase;

  beforeAll(async () => {
    seeded = await createTestDatabase({ name: "sealing_seed" });
  }, 30_000);

  afterAll(async () => {
    await seeded.drop();
  });

  it("loads what the migrations so far can hold; the handle and phone rows of its chain wait for their migration", async () => {
    const result = await loadFixture(seeded.sql, "seed-sealing-key.json");
    // seed-person-roles (3 businesses, 6 persons, 9 roles), then seed-phone-stopped (1 more person and role), then ours.
    expect(result.loaded).toEqual({ businesses: 3, persons: 7, person_roles: 10, sealing_keys: 2 });
    expect(result.skipped).toEqual(["handles", "person_handles", "phones"]);

    expect(await getSealingKeyInfo(seeded.sql, "person-alex")).toEqual({
      personId: "person-alex",
      wrappingKeyName: "SEALING_WRAP_KEY",
      createdAt: new Date("2026-10-12T16:20:00Z"),
      erasedAt: null,
      version: 1,
    });
    expect(await getSealingKeyInfo(seeded.sql, "person-ben")).toEqual({
      personId: "person-ben",
      wrappingKeyName: "SEALING_WRAP_KEY",
      createdAt: new Date("2026-10-05T17:00:00Z"),
      erasedAt: new Date("2026-11-02T15:00:00Z"),
      version: 2,
    });
  });

  it("the seeded erased person cannot be opened or sealed for; the seeded held key is placeholder bytes, not a real key", async () => {
    const [ben] = await seeded.sql<{ wrapped: Uint8Array | null }[]>`
      select wrapped_key as wrapped from sealing_keys where person_id = 'person-ben'
    `;
    expect(ben?.wrapped).toBeNull();
    const someSealed = new Uint8Array(SEAL_OVERHEAD_BYTES + 4);
    someSealed[0] = SEAL_FORMAT_V1;
    expect(await sealingFailure(unseal(seeded.sql, KEYS, "person-ben", someSealed))).toBe("erased");
    expect(await sealingFailure(seal(seeded.sql, KEYS, "person-ben", "x"))).toBe("erased");
    // The seeded bytes for Alex are not the stored form of a wrapped key, so they open nothing.
    expect(await sealingFailure(unseal(seeded.sql, KEYS, "person-alex", someSealed))).toBe("bad_format");
  });
});

describe("the table's own rules", () => {
  it("a key is held (bytes, no erase time) or erased (no bytes, an erase time), never both or neither", async () => {
    const id = await newPerson();
    const bytes = text.encode("not a key");
    const rule = { code: "23514", constraint: "sealing_keys_erased_or_held" };
    expect(
      await refusal(db.sql`insert into sealing_keys (person_id, wrapping_key_name) values (${id}, 'K')`),
    ).toEqual(rule);
    expect(
      await refusal(
        db.sql`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name, erased_at)
               values (${id}, ${bytes}, 'K', now())`,
      ),
    ).toEqual(rule);
    // Held, then erased by hand: both together are accepted, one without the other is not.
    await db.sql`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name) values (${id}, ${bytes}, 'K')`;
    expect(
      await refusal(db.sql`update sealing_keys set wrapped_key = null, version = 2 where person_id = ${id}`),
    ).toEqual(rule);
    expect(
      await refusal(db.sql`update sealing_keys set erased_at = now(), version = 2 where person_id = ${id}`),
    ).toEqual(rule);
    await db.sql`update sealing_keys set wrapped_key = null, erased_at = now(), version = 2 where person_id = ${id}`;
  });

  it("the wrapping key's name is a secret's name: upper case, digits and underscores, never a value", async () => {
    const bytes = text.encode("x");
    for (const name of ["", "sealing_wrap_key", "1KEY", "KEY-1", "KEY NAME", "Key", "_KEY"]) {
      const id = await newPerson();
      expect(
        await refusal(
          db.sql`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name) values (${id}, ${bytes}, ${name})`,
        ),
      ).toEqual({ code: "23514", constraint: "sealing_keys_name_form" });
    }
    const id = await newPerson();
    await db.sql`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name) values (${id}, ${bytes}, 'K2_WRAP')`;
  });

  it("a key needs a person, and a person with a key row cannot be deleted", async () => {
    expect(
      await refusal(
        db.sql`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name) values ('person-nobody', ${text.encode("x")}, 'K')`,
      ),
    ).toEqual({ code: "23503", constraint: "sealing_keys_person_fk" });
    const id = await newPerson();
    await seal(db.sql, KEYS, id, "x");
    expect(await refusal(db.sql`delete from persons where id = ${id}`)).toEqual({
      code: "23503",
      constraint: "sealing_keys_person_fk",
    });
  });

  it("one key row per person, and an update must raise the version by one", async () => {
    const id = await newPerson();
    await seal(db.sql, KEYS, id, "x");
    expect(
      await refusal(
        db.sql`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name) values (${id}, ${text.encode("y")}, 'K')`,
      ),
    ).toEqual({ code: "23505", constraint: "sealing_keys_pkey" });
    expect(
      await refusal(db.sql`update sealing_keys set wrapping_key_name = 'OTHER' where person_id = ${id}`),
    ).toEqual({ code: "23514", constraint: "sealing_keys_version_raised" });
    expect(
      await refusal(
        db.sql`update sealing_keys set wrapping_key_name = 'OTHER', version = 3 where person_id = ${id}`,
      ),
    ).toEqual({ code: "23514", constraint: "sealing_keys_version_raised" });
    expect((await getSealingKeyInfo(db.sql, id))?.version).toBe(1);
  });
});

describe("seal and unseal", () => {
  it("round-trips text, bytes, an empty value and a large one", async () => {
    const id = await newPerson();
    const secret = "Alex Demo, 12 Example Street, allergic to nothing";
    const sealed = await seal(db.sql, KEYS, id, secret);
    expect(await unsealText(db.sql, KEYS, id, sealed)).toBe(secret);

    const raw = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    expect(same(await unseal(db.sql, KEYS, id, await seal(db.sql, KEYS, id, raw)), raw)).toBe(true);

    const empty = await seal(db.sql, KEYS, id, "");
    expect(empty).toHaveLength(SEAL_OVERHEAD_BYTES);
    expect((await unseal(db.sql, KEYS, id, empty)).length).toBe(0);

    const big = crypto.getRandomValues(new Uint8Array(60_000));
    expect(same(await unseal(db.sql, KEYS, id, await seal(db.sql, KEYS, id, big)), big)).toBe(true);
  });

  it("the sealed form is: format byte 1, a 12-byte IV, then the ciphertext and a 16-byte tag; the plaintext is not in it", async () => {
    const id = await newPerson();
    const secret = "plain-needle-9d41";
    const sealed = await seal(db.sql, KEYS, id, secret);
    expect(sealed[0]).toBe(SEAL_FORMAT_V1);
    expect(sealed.length).toBe(1 + 12 + secret.length + 16);
    expect(contains(sealed, text.encode(secret))).toBe(false);
    // The same value twice gives different bytes: a fresh IV each time.
    const again = await seal(db.sql, KEYS, id, secret);
    expect(same(sealed, again)).toBe(false);
    expect(same(sealed.slice(1, 13), again.slice(1, 13))).toBe(false);
  });

  it("the first seal makes the key; later seals reuse it, and the table says which secret wraps it", async () => {
    const id = await newPerson();
    expect(await getSealingKeyInfo(db.sql, id)).toBeNull();
    await seal(db.sql, KEYS, id, "one");
    const first = await getSealingKeyInfo(db.sql, id);
    expect(first).toMatchObject({
      personId: id,
      wrappingKeyName: "SEALING_WRAP_KEY",
      erasedAt: null,
      version: 1,
    });
    const rawBefore = await rawDataKey(db, id);
    await seal(db.sql, KEYS, id, "two");
    expect(await getSealingKeyInfo(db.sql, id)).toEqual(first);
    expect(same(await rawDataKey(db, id), rawBefore)).toBe(true);
  });

  it("each person has a key of their own, and one person's value does not open for another", async () => {
    const a = await newPerson();
    const b = await newPerson();
    const sealedA = await seal(db.sql, KEYS, a, "for a only");
    await seal(db.sql, KEYS, b, "for b only");
    expect(same(await rawDataKey(db, a), await rawDataKey(db, b))).toBe(false);
    expect(await sealingFailure(unseal(db.sql, KEYS, b, sealedA))).toBe("cannot_open");
    expect(await unsealText(db.sql, KEYS, a, sealedA)).toBe("for a only");
  });

  it("the stored wrapped key is 61 bytes, in format 1, and neither equals nor contains the raw key; the raw key opens the sealed value", async () => {
    const id = await newPerson();
    const secret = "check against the raw key";
    const sealed = await seal(db.sql, KEYS, id, secret);
    const [row] = await db.sql<{ wrapped: Uint8Array }[]>`
      select wrapped_key as wrapped from sealing_keys where person_id = ${id}
    `;
    const wrapped = new Uint8Array(row?.wrapped ?? []);
    expect(wrapped).toHaveLength(WRAPPED_KEY_BYTES);
    expect(wrapped[0]).toBe(SEAL_FORMAT_V1);

    const raw = await rawDataKey(db, id);
    expect(raw).toHaveLength(32);
    expect(same(wrapped, raw)).toBe(false);
    expect(contains(wrapped, raw)).toBe(false);
    expect(contains(sealed, raw)).toBe(false);
    // The wrapping key's bytes are in no stored row either.
    expect(contains(wrapped, WRAP_BYTES)).toBe(false);

    // The format as documented opens the value with the recovered key: AES-256-GCM, IV, tag, bound to the person.
    const dataKey = await subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const opened = await subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(1, 13), additionalData: text.encode(`rosie:seal:v1:${id}`) },
      dataKey,
      sealed.slice(13),
    );
    expect(new TextDecoder().decode(opened)).toBe(secret);
  });

  it("works inside a transaction, and a rolled-back first seal leaves no key row", async () => {
    const id = await newPerson();
    await expect(
      db.sql.begin(async (tx) => {
        await seal(tx, KEYS, id, "kept?");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await getSealingKeyInfo(db.sql, id)).toBeNull();
    const sealed = await db.sql.begin(async (tx) => {
      const made = await seal(tx, KEYS, id, "kept");
      expect(await unsealText(tx, KEYS, id, made)).toBe("kept");
      return made;
    });
    expect(await unsealText(db.sql, KEYS, id, sealed)).toBe("kept");
  });

  it("eight first seals at once make exactly one key, and every value opens under it", async () => {
    const id = await newPerson();
    const values = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const sealed = await Promise.all(values.map((value) => seal(db.sql, KEYS, id, value)));
    const [count] = await db.sql<
      { n: string }[]
    >`select count(*) as n from sealing_keys where person_id = ${id}`;
    expect(Number(count?.n)).toBe(1);
    for (const [index, bytes] of sealed.entries()) {
      expect(await unsealText(db.sql, KEYS, id, bytes)).toBe(values[index]);
    }
  });
});

describe("refusals", () => {
  it("a person who never sealed anything has no key to open with", async () => {
    const id = await newPerson();
    const other = await newPerson();
    const sealed = await seal(db.sql, KEYS, other, "x");
    expect(await sealingFailure(unseal(db.sql, KEYS, id, sealed))).toBe("no_key");
    expect(await getSealingKeyInfo(db.sql, id)).toBeNull();
  });

  it("bytes that are not a sealed value, and a sealed value that was changed, do not open", async () => {
    const id = await newPerson();
    const sealed = await seal(db.sql, KEYS, id, "do not change me");
    expect(await sealingFailure(unseal(db.sql, KEYS, id, new Uint8Array(0)))).toBe("bad_format");
    expect(await sealingFailure(unseal(db.sql, KEYS, id, sealed.slice(0, 20)))).toBe("bad_format");
    const otherFormat = Uint8Array.from(sealed);
    otherFormat[0] = 2;
    expect(await sealingFailure(unseal(db.sql, KEYS, id, otherFormat))).toBe("bad_format");
    for (const position of [1, 14, sealed.length - 1]) {
      const changed = Uint8Array.from(sealed);
      changed[position] = (changed[position] ?? 0) ^ 1;
      expect(await sealingFailure(unseal(db.sql, KEYS, id, changed))).toBe("cannot_open");
    }
    expect(await unsealText(db.sql, KEYS, id, sealed)).toBe("do not change me");
  });

  it("a wrapped key moved to another person does not open (it is bound to its person)", async () => {
    const a = await newPerson();
    const b = await newPerson();
    const sealedB = await seal(db.sql, KEYS, b, "b's value");
    await seal(db.sql, KEYS, a, "a's value");
    const [row] = await db.sql<
      { wrapped: Uint8Array }[]
    >`select wrapped_key as wrapped from sealing_keys where person_id = ${a}`;
    await db.sql`update sealing_keys set wrapped_key = ${new Uint8Array(row?.wrapped ?? [])}, version = version + 1 where person_id = ${b}`;
    expect(await sealingFailure(unseal(db.sql, KEYS, b, sealedB))).toBe("cannot_open");
  });

  it("a missing, malformed or different wrapping key is refused, with a message that names no key", async () => {
    const id = await newPerson();
    const sealed = await seal(db.sql, KEYS, id, "x");

    const missing: WrappingKeys = { resolve: () => undefined };
    expect(await sealingFailure(unseal(db.sql, missing, id, sealed))).toBe("wrapping_key_missing");
    expect(await sealingFailure(seal(db.sql, missing, await newPerson(), "x"))).toBe("wrapping_key_missing");

    const shortBytes = randomKeyBytes().slice(0, 16);
    const invalid: WrappingKeys[] = [
      { resolve: () => shortBytes },
      { resolve: () => toBase64(shortBytes) },
      { resolve: () => "this is %% not base64" },
    ];
    for (const keys of invalid) {
      expect(await sealingFailure(unseal(db.sql, keys, id, sealed))).toBe("wrapping_key_invalid");
    }

    // Another 256-bit key unwraps nothing.
    const other: WrappingKeys = { resolve: () => randomKeyBytes() };
    expect(await sealingFailure(unseal(db.sql, other, id, sealed))).toBe("cannot_open");

    const error = await seal(db.sql, missing, await newPerson(), "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealingError);
    expect((error as Error).message).toBe("the wrapping key named by the sealing key is not available");
  });

  it("the wrapping key may be raw bytes or base64; a new key is made under the name asked for, and unseal reads the row's name", async () => {
    const id = await newPerson();
    const asked: string[] = [];
    const named: WrappingKeys = {
      name: "TENANT_SEAL_KEY_2",
      resolve: (name) => {
        asked.push(name);
        return name === "TENANT_SEAL_KEY_2" ? WRAP_BYTES : undefined;
      },
    };
    const sealed = await seal(db.sql, named, id, "named");
    expect((await getSealingKeyInfo(db.sql, id))?.wrappingKeyName).toBe("TENANT_SEAL_KEY_2");
    // Unseal does not use `name` (what new keys use) but the name the row holds.
    const later: WrappingKeys = { name: "SOMETHING_ELSE", resolve: (name) => named.resolve(name) };
    expect(await unsealText(db.sql, later, id, sealed)).toBe("named");
    expect(asked.every((name) => name === "TENANT_SEAL_KEY_2")).toBe(true);
    // The default name's secret is not set here, so this person's value is not readable through KEYS.
    expect(await sealingFailure(unseal(db.sql, KEYS, id, sealed))).toBe("wrapping_key_missing");
  });
});

describe("erasePerson", () => {
  it("deletes the wrapped key, sets the erase time, raises the version by one, and keeps the row", async () => {
    const id = await newPerson();
    await seal(db.sql, KEYS, id, "gone soon");
    const erased = await erasePerson(db.sql, id);
    expect(erased.ok).toBe(true);
    const row = erased.ok ? erased.row : null;
    expect(row).toMatchObject({ personId: id, wrappingKeyName: "SEALING_WRAP_KEY", version: 2 });
    expect(row?.erasedAt).toBeInstanceOf(Date);
    expect(await getSealingKeyInfo(db.sql, id)).toEqual(row);

    const [stored] = await db.sql<{ wrapped: Uint8Array | null; erased: Date | null }[]>`
      select wrapped_key as wrapped, erased_at as erased from sealing_keys where person_id = ${id}
    `;
    expect(stored?.wrapped).toBeNull();
    expect(stored?.erased).toBeInstanceOf(Date);
  });

  it("after it unseal fails with a typed error and the stored sealed bytes stay unreadable", async () => {
    const id = await newPerson();
    const secret = "lives only while the key does";
    const sealed = await seal(db.sql, KEYS, id, secret);
    await db.sql`insert into sealed_probe (id, person_id, value) values (${`probe-${id}`}, ${id}, ${sealed})`;
    expect(await unsealText(db.sql, KEYS, id, sealed)).toBe(secret);

    expect((await erasePerson(db.sql, id)).ok).toBe(true);

    // The value as it sits in the database, read back fresh.
    const [probe] = await db.sql<
      { value: Uint8Array }[]
    >`select value from sealed_probe where person_id = ${id}`;
    const stored = new Uint8Array(probe?.value ?? []);
    expect(same(stored, sealed)).toBe(true);
    expect(contains(stored, text.encode(secret))).toBe(false);

    for (const bytes of [sealed, stored]) {
      const failure = await unseal(db.sql, KEYS, id, bytes).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(SealingError);
      expect((failure as SealingError).code).toBe("erased");
      expect((failure as SealingError).message).not.toContain(secret);
    }
    expect(await sealingFailure(unsealText(db.sql, KEYS, id, stored))).toBe("erased");
    // Nothing new can be sealed for them either, and no key row comes back.
    expect(await sealingFailure(seal(db.sql, KEYS, id, "again"))).toBe("erased");
    expect((await getSealingKeyInfo(db.sql, id))?.erasedAt).toBeInstanceOf(Date);
    // The wrapping key still exists, and still opens nothing: no wrapped key is left in the row.
    const [left] = await db.sql<{ n: string }[]>`
      select count(*) as n from sealing_keys where person_id = ${id} and wrapped_key is not null
    `;
    expect(Number(left?.n)).toBe(0);
  });

  it("erasing one person leaves another's values readable", async () => {
    const a = await newPerson();
    const b = await newPerson();
    const sealedB = await seal(db.sql, KEYS, b, "b stays");
    await seal(db.sql, KEYS, a, "a goes");
    await erasePerson(db.sql, a);
    expect(await unsealText(db.sql, KEYS, b, sealedB)).toBe("b stays");
  });

  it("a stale version is refused with the row as it is, and nothing is erased", async () => {
    const id = await newPerson();
    const sealed = await seal(db.sql, KEYS, id, "still held");
    const info = await getSealingKeyInfo(db.sql, id);

    expect(await erasePerson(db.sql, id, 7)).toEqual({ ok: false, current: info });
    expect(await getSealingKeyInfo(db.sql, id)).toEqual(info);
    expect(await unsealText(db.sql, KEYS, id, sealed)).toBe("still held");
  });

  it("with the version the caller read, it writes once; a second erase and a person with no key row are refused", async () => {
    const id = await newPerson();
    await seal(db.sql, KEYS, id, "x");
    const info = await getSealingKeyInfo(db.sql, id);
    const done = await erasePerson(db.sql, id, info?.version);
    expect(done).toMatchObject({ ok: true, row: { personId: id, version: 2 } });
    const again = await erasePerson(db.sql, id);
    expect(again).toEqual({ ok: false, current: done.ok ? done.row : null });
    expect(await erasePerson(db.sql, id, 2)).toEqual({ ok: false, current: done.ok ? done.row : null });
    expect(await erasePerson(db.sql, "person-no-key-row")).toEqual({ ok: false, current: null });
    await expect(erasePerson(db.sql, id, 0)).rejects.toThrow(TypeError);
    await expect(erasePerson(db.sql, id, 1.5)).rejects.toThrow(TypeError);
  });

  it("eight erases at once: one writes, the rest are refused, and the version went up by one", async () => {
    const id = await newPerson();
    await seal(db.sql, KEYS, id, "x");
    const results = await Promise.all(Array.from({ length: 8 }, () => erasePerson(db.sql, id)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const final = await getSealingKeyInfo(db.sql, id);
    expect(final?.version).toBe(2);
    for (const result of results) {
      if (!result.ok) {
        expect(result.current).toEqual(final);
      }
    }
  });
});
