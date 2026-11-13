// T-220: K-05 v1.2's handleSealingKey, the gateway's get or create of a handle's sealing key, against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/handle-keys`). The schema comes from migrating a fresh
// test schema.
//
// Every call runs on the runtime side as K-05 v1.2 states it (README line 153): through a client whose connections run
// as rosie_job (T-191: the only role that reads handles and sealing keys) with no business scope. The tables' owner
// (the migrations' role) writes the seeds. K-04's seed holds stand-in bytes for Alex's wrapped key (seed-sealing-key:
// "not a real key"), so the loader writes a real data key wrapped under this file's test wrapping key in its place, the
// row otherwise as seeded. The test wrapping key is random per run: never a real key, never read from the environment.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "./client";
import { DataAccessDatabaseError } from "./clocks";
import {
  handleSealingKey,
  handleSealingKeyIn,
  type HandleSealingKeyRequest,
  type HandleSealingKeyResponse,
  type HandleSealingKeyResult,
} from "./handle-keys";
import { type Sql, type Tx, withBusiness } from "./scope";
import { erasePerson, seal, unsealText } from "./sealing";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const WRAP_NAME = "SEALING_WRAP_KEY";
const PARALLEL = 50;
const SLOW = { timeout: 60_000 };
const HEAVY = { timeout: 180_000 };

interface Given {
  k04Seeds: string[];
  after: string[];
  now: string;
  note?: string;
  partSeeds?: string[];
}

interface Exchange {
  call: string;
  given: Given;
  request: Record<string, Json>;
  outcome: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const requestOf = (exchange: Exchange): HandleSealingKeyRequest =>
  exchange.request as unknown as HandleSealingKeyRequest;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const KEY_FIXTURES = INDEX.filter((entry) => entry.def === "handleSealingKey.exchange").map(
  (entry) => entry.file,
);

const encoder = new TextEncoder();
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

// ---- the contract's own schema, for every answer (Ajv 2020-12, strict, as contracts:check runs it) -----------------

function schemaFiles(dir: URL): URL[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".schema.json") && !file.endsWith(".meta.schema.json"))
    .filter((file) => !file.startsWith("generated/") && !file.startsWith("scripts/"))
    .filter((file) => !file.includes("node_modules"))
    .map((file) => new URL(file, dir));
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
for (const file of schemaFiles(CONTRACTS)) {
  ajv.addSchema(readJson(file) as object);
}
const V12_ID = (readJson(new URL("data-access/data-access.v1.2.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** Checks `value` against one $defs entry of data-access v1.2, returning Ajv's errors (none when it passes). */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V12_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.2 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// ---- databases, clients and keys ------------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;
const wrappingKey = new Uint8Array(randomBytes(32));
const keys = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? wrappingKey : undefined),
};

function runtimeClient(max: number, name: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max,
    onnotice: () => undefined,
    connection: { application_name: name, search_path: `${db.schema}, public`, role: RUNTIME_ROLE },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "handle_keys" });
  runtime = runtimeClient(10, "rosie-t220-handle-keys");
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 60_000);

afterAll(async () => {
  await runtime.end({ timeout: 5 });
  await db.drop();
});

/** Empties every table (truncating the heads cascades to the rest; this file's schema only). */
async function reset(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/** A real data key for a person, wrapped under the test wrapping key in sealing.ts's v1 form. */
async function realWrappedKey(personId: string): Promise<Uint8Array> {
  const wrapper = await crypto.subtle.importKey("raw", wrappingKey, { name: "AES-GCM" }, false, ["wrapKey"]);
  const dataKey = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
  const iv = new Uint8Array(randomBytes(12));
  const body = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dataKey, wrapper, {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`rosie:wrap:v1:${personId}`),
    }),
  );
  return Uint8Array.from([0x01, ...iv, ...body]);
}

async function insertRow(
  sql: Db,
  table: string,
  row: Record<string, Json>,
  options: { seedKeyBytes?: boolean } = {},
): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      const person = row.person_id;
      converted =
        table === "sealing_keys" &&
        column === "wrapped_key" &&
        typeof person === "string" &&
        !options.seedKeyBytes
          ? await realWrappedKey(person)
          : fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

function seedRows(file: string, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

async function loadSeeds(files: readonly string[], options: { seedKeyBytes?: boolean } = {}): Promise<void> {
  await reset();
  const seen = new Set<string>();
  const rows = files.flatMap((file) => seedRows(file, seen));
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values, options);
    }
  });
}

/** Loads a fixture's seeds and runs the exchanges its `after` names (here only this call's own) first. */
async function given(file: string): Promise<Exchange> {
  const exchange = exchangeOf(file);
  if (exchange.given.partSeeds !== undefined && exchange.given.partSeeds.length > 0) {
    throw new Error(`${file}: partSeeds are not loaded by this test`);
  }
  const befores = exchange.given.after.map(exchangeOf);
  await loadSeeds([...exchange.given.k04Seeds, ...befores.flatMap((before) => before.given.k04Seeds)]);
  for (const before of befores) {
    if (before.call !== "handleSealingKey" || before.given.after.length > 0) {
      throw new Error(`${file}: this test runs only handleSealingKey steps with nothing before them`);
    }
    const result = await handleSealingKey(runtime, keys, requestOf(before), {
      now: new Date(before.given.now),
    });
    expect(result.outcome).toEqual(before.outcome);
  }
  return exchange;
}

/** A key answer, which must have its data key beside it. */
function keyOf(result: HandleSealingKeyResult): { outcome: HandleSealingKeyResponse; dataKey: CryptoKey } {
  if (result.dataKey === null) {
    throw new Error(`expected a key, got ${JSON.stringify(result.outcome)}`);
  }
  return result;
}

/** A value sealed under a data key in sealing.ts's v1 form, as the gateway seals an event (T-243). */
async function sealWith(key: CryptoKey, personId: string, text: string): Promise<Uint8Array> {
  const iv = new Uint8Array(randomBytes(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(`rosie:seal:v1:${personId}`) },
      key,
      encoder.encode(text),
    ),
  );
  return Uint8Array.from([0x01, ...iv, ...body]);
}

/** Opens a value sealed in sealing.ts's v1 form with a data key; rejects when the key is not the one. */
async function openWith(key: CryptoKey, personId: string, sealed: Uint8Array): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.slice(1, 13), additionalData: encoder.encode(`rosie:seal:v1:${personId}`) },
    key,
    sealed.slice(13),
  );
  return new TextDecoder().decode(plain);
}

function request(address: string, suffix: string): HandleSealingKeyRequest {
  return {
    handle: { kind: "phone", address },
    newHandleId: `handle-t220-${suffix}`,
    newPersonId: `person-t220-${suffix}`,
    wrappingKeyName: WRAP_NAME,
  };
}

async function countRows(table: string, where: postgres.PendingQuery<postgres.Row[]>): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from ${db.sql(table)} where ${where}`;
  return row?.n ?? -1;
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("handleSealingKey: each K-05 v1.2 fixture gives its response (K-05 item 29)", () => {
  it("the index lists the gateway's five exchanges, each valid against data-access v1.2", () => {
    expect([...KEY_FIXTURES].sort()).toEqual([
      "handle-key-erased.json",
      "handle-key-existing.json",
      "handle-key-first-sight-repeat.json",
      "handle-key-first-sight.json",
      "handle-key-person-no-key.json",
    ]);
    for (const file of KEY_FIXTURES) {
      expect(schemaErrors("handleSealingKey.exchange", exchangeOf(file)), file).toEqual([]);
    }
  });

  it("the test client runs as rosie_job, with this file's schema first and no business scope", async () => {
    const [row] = await runtime<{ who: string; scope: string | null }[]>`
      select current_user as who, current_setting('rosie.business_id', true) as scope
    `;
    expect(row?.who).toBe(RUNTIME_ROLE);
    expect(row?.scope ?? "").toBe("");
  });

  for (const file of KEY_FIXTURES) {
    it(
      `${file}: as rosie_job, the call answers the fixture's outcome, with a data key beside it that cannot be exported`,
      SLOW,
      async () => {
        const exchange = await given(file);
        const result = keyOf(
          await handleSealingKey(runtime, keys, requestOf(exchange), { now: new Date(exchange.given.now) }),
        );
        expect(result.outcome).toEqual(exchange.outcome);
        expect(schemaErrors("handleSealingKey.response", result.outcome)).toEqual([]);
        expect(result.dataKey.extractable).toBe(false);
        expect(result.dataKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
        expect([...result.dataKey.usages].sort()).toEqual(["decrypt", "encrypt"]);
        await expect(crypto.subtle.exportKey("raw", result.dataKey)).rejects.toThrow();
        // The answer says what the row says, never its bytes, wrapped or not.
        const [stored] = await db.sql<{ wrapped: Uint8Array }[]>`
          select wrapped_key as wrapped from sealing_keys where person_id = ${result.outcome.personId}
        `;
        const answer = JSON.stringify(result.outcome);
        expect(stored?.wrapped.length).toBe(61);
        expect(answer).not.toContain(toHex(stored?.wrapped ?? new Uint8Array()));
        expect(answer).not.toContain(toBase64(stored?.wrapped ?? new Uint8Array()));
      },
    );
  }

  it("refuse-handle-key-with-key-value.json: the schema refuses it, and so does the call, which writes nothing", async () => {
    const refused = readJson(new URL("invalid/refuse-handle-key-with-key-value.json", ACCESS_DIR)) as Record<
      string,
      Json
    >;
    expect(schemaErrors("handleSealingKey.request", refused)).not.toEqual([]);
    await loadSeeds(["seed-sealing-key.json"]);
    await expect(
      handleSealingKey(runtime, keys, refused as unknown as HandleSealingKeyRequest),
    ).rejects.toThrow(
      "handleSealingKey: the request takes only handle, newHandleId, newPersonId, wrappingKeyName",
    );
    expect(await countRows("handles", db.sql`address = '+15555550108'`)).toBe(0);
    // Without its one fault (the secret's value it carries), the request is accepted.
    const { wrappingKey: _value, ...fixed } = refused;
    expect(_value).toBeDefined();
    expect(schemaErrors("handleSealingKey.request", fixed)).toEqual([]);
  });
});

describe("what the fixtures write (K-05 item 29)", () => {
  it(
    "first sight writes one handle, one person with no name, their link and one key; the repeat writes nothing",
    SLOW,
    async () => {
      const first = exchangeOf("handle-key-first-sight.json");
      await given("handle-key-first-sight.json");
      const before = keyOf(
        await handleSealingKey(runtime, keys, requestOf(first), { now: new Date(first.given.now) }),
      );
      expect(before.outcome.created).toEqual({ handle: true, person: true, key: true });
      const rows = async (): Promise<unknown> => ({
        handles: await db.sql`select id, kind, address from handles where address = '+15555550108'`,
        persons:
          await db.sql`select id, name, language, version from persons where id like 'person-gw-0108%'`,
        links:
          await db.sql`select person_id, handle_id from person_handles where handle_id = 'handle-gw-0108'`,
        keys: await db.sql`
        select person_id, wrapping_key_name, created_at, erased_at, version, octet_length(wrapped_key) as bytes
        from sealing_keys where person_id like 'person-gw-0108%'
      `,
      });
      expect(await rows()).toEqual({
        handles: [{ id: "handle-gw-0108", kind: "phone", address: "+15555550108" }],
        persons: [{ id: "person-gw-0108", name: null, language: null, version: 1 }],
        links: [{ person_id: "person-gw-0108", handle_id: "handle-gw-0108" }],
        keys: [
          {
            person_id: "person-gw-0108",
            wrapping_key_name: WRAP_NAME,
            created_at: new Date("2026-11-08T14:00:00Z"),
            erased_at: null,
            version: 1,
            bytes: 61,
          },
        ],
      });
      const snapshot = await rows();
      const repeat = exchangeOf("handle-key-first-sight-repeat.json");
      const again = keyOf(
        await handleSealingKey(runtime, keys, requestOf(repeat), { now: new Date(repeat.given.now) }),
      );
      expect(again.outcome).toEqual(repeat.outcome);
      expect(await rows()).toEqual(snapshot);
      // Both calls hand out the same key: what one seals, the other opens.
      const sealed = await sealWith(before.dataKey, "person-gw-0108", "Hi, I'd like to set up my shop");
      expect(await openWith(again.dataKey, "person-gw-0108", sealed)).toBe("Hi, I'd like to set up my shop");
    },
  );

  it(
    "Ben's erased number: a new person with no name and a key; his erased key stays erased and his link stays",
    SLOW,
    async () => {
      const exchange = await given("handle-key-erased.json");
      const ben = async (): Promise<unknown> =>
        db.sql`select person_id, wrapped_key, erased_at, version from sealing_keys where person_id = 'person-ben'`;
      const benBefore = await ben();
      const result = keyOf(
        await handleSealingKey(runtime, keys, requestOf(exchange), { now: new Date(exchange.given.now) }),
      );
      expect(result.outcome).toEqual(exchange.outcome);
      expect(await ben()).toEqual(benBefore);
      expect(
        await db.sql`select person_id from person_handles where handle_id = 'handle-ben' order by person_id`,
      ).toEqual([{ person_id: "person-ben" }, { person_id: "person-gw-0106" }]);
      expect(await db.sql`select name from persons where id = 'person-gw-0106'`).toEqual([{ name: null }]);
      // A second text finds the new person's key and writes nothing more.
      const next = keyOf(await handleSealingKey(runtime, keys, request("+15555550106", "ben-next")));
      expect(next.outcome).toMatchObject({
        handleId: "handle-ben",
        personId: "person-gw-0106",
        created: { handle: false, person: false, key: false },
      });
    },
  );

  it(
    "the data key is the person's sealing key in sealing.ts's form: seal() and unseal() use the same key",
    SLOW,
    async () => {
      const exchange = await given("handle-key-existing.json");
      const result = keyOf(await handleSealingKey(runtime, keys, requestOf(exchange)));
      const viaGateway = await sealWith(result.dataKey, "person-alex", "Can I move my haircut to 3?");
      expect(await unsealText(runtime, keys, "person-alex", viaGateway)).toBe("Can I move my haircut to 3?");
      const viaSealing = await seal(runtime, keys, "person-alex", "Sat 2:00pm works");
      expect(await openWith(result.dataKey, "person-alex", viaSealing)).toBe("Sat 2:00pm works");
    },
  );
});

describe("50 parallel get-or-create calls for one handle create exactly one key (concurrency)", () => {
  async function race(address: string, label: string): Promise<HandleSealingKeyResult[]> {
    const racer = runtimeClient(25, `rosie-t220-race-${label}`);
    try {
      return await Promise.all(
        Array.from({ length: PARALLEL }, (_, n) =>
          handleSealingKey(racer, keys, request(address, `${label}-${String(n)}`)),
        ),
      );
    } finally {
      await racer.end({ timeout: 5 });
    }
  }

  /** Every answer is a key, the same handle, person and key; `wrote` of them say they wrote it; the keys are one. */
  async function expectOneKey(
    results: HandleSealingKeyResult[],
    written: { handle: boolean; person: boolean },
  ) {
    const answers = results.map(keyOf);
    expect(answers).toHaveLength(PARALLEL);
    const [first] = answers;
    if (first === undefined) {
      throw new Error("no answer");
    }
    for (const answer of answers) {
      expect(answer.outcome.handleId).toBe(first.outcome.handleId);
      expect(answer.outcome.personId).toBe(first.outcome.personId);
      expect(answer.outcome.key).toEqual(first.outcome.key);
      expect(schemaErrors("handleSealingKey.response", answer.outcome)).toEqual([]);
    }
    const creators = answers.filter((answer) => answer.outcome.created.key);
    expect(creators.map((answer) => answer.outcome.created)).toEqual([
      { handle: written.handle, person: written.person, key: true },
    ]);
    expect(
      answers.filter((answer) => answer.outcome.created.handle || answer.outcome.created.person),
    ).toHaveLength(written.handle || written.person ? 1 : 0);
    // One key: what the first answer's key seals, every other answer's key opens.
    const sealed = await sealWith(first.dataKey, first.outcome.personId, "STOP texting me pls");
    for (const answer of answers) {
      expect(await openWith(answer.dataKey, first.outcome.personId, sealed)).toBe("STOP texting me pls");
    }
    return first.outcome;
  }

  it(
    "a number never seen: one handle, one person, one link and one key, whichever call writes them",
    HEAVY,
    async () => {
      await loadSeeds(["seed-sealing-key.json"]);
      const address = "+15555550170";
      const outcome = await expectOneKey(await race(address, "new"), { handle: true, person: true });
      expect(await countRows("handles", db.sql`address = ${address}`)).toBe(1);
      expect(await countRows("person_handles", db.sql`handle_id = ${outcome.handleId}`)).toBe(1);
      expect(await countRows("persons", db.sql`id like 'person-t220-new-%'`)).toBe(1);
      expect(await countRows("sealing_keys", db.sql`person_id like 'person-t220-new-%'`)).toBe(1);
    },
  );

  it("Sam's number, his person with no key yet: one key, no new person", HEAVY, async () => {
    await loadSeeds(["seed-sealing-key.json"]);
    const outcome = await expectOneKey(await race("+15555550100", "sam"), { handle: false, person: false });
    expect(outcome).toMatchObject({ handleId: "handle-sam", personId: "person-sam" });
    expect(await countRows("sealing_keys", db.sql`person_id = 'person-sam'`)).toBe(1);
    expect(await countRows("persons", db.sql`id like 'person-t220-sam-%'`)).toBe(0);
  });

  it("Ben's number, every key on it erased: one new person and one key", HEAVY, async () => {
    await loadSeeds(["seed-sealing-key.json"]);
    const outcome = await expectOneKey(await race("+15555550106", "ben"), { handle: false, person: true });
    expect(outcome.handleId).toBe("handle-ben");
    expect(await countRows("persons", db.sql`id like 'person-t220-ben-%'`)).toBe(1);
    expect(await countRows("person_handles", db.sql`handle_id = 'handle-ben'`)).toBe(2);
    expect(await countRows("sealing_keys", db.sql`person_id like 'person-t220-ben-%'`)).toBe(1);
  });
});

describe("erasing the person's key leaves the handle's sealed fields unreadable (NQ-DB-1 default; RULES 4.10)", () => {
  it(
    "after erasePerson, nothing opens the sealed field: not the wrapping key, not the number's next key",
    SLOW,
    async () => {
      await loadSeeds(["seed-sealing-key.json"]);
      const address = "+15555550171";
      const first = keyOf(await handleSealingKey(runtime, keys, request(address, "erase-1")));
      const { handleId, personId } = first.outcome;
      const text = "My new address is 12 Example Lane, flat 3";
      // The gateway seals the event under the handle's key; the sealed field is stored for that person (K-04 rule 6).
      const sealed = await sealWith(first.dataKey, personId, text);
      await db.sql`
        insert into event_log (id, trace_id, job_id, actor_kind, kind, sealed_values, sealed_for_person_id)
        values ('evlog-t220-sealed', 'trace-t220-0002', 'job-t220-gateway', 'job', 'message.received', ${sealed},
                ${personId})
      `;
      const stored = async (): Promise<Uint8Array> => {
        const [row] = await db.sql<{ sealed: Uint8Array }[]>`
          select sealed_values as sealed from event_log where id = 'evlog-t220-sealed'
        `;
        return new Uint8Array(row?.sealed ?? new Uint8Array());
      };
      expect(await unsealText(runtime, keys, personId, await stored())).toBe(text);

      const erased = await erasePerson(runtime, personId);
      expect(erased).toMatchObject({ ok: true, row: { personId, version: 2 } });
      expect(
        await db.sql`select wrapped_key, erased_at is not null as erased from sealing_keys where person_id = ${personId}`,
      ).toEqual([{ wrapped_key: null, erased: true }]);

      // The stored field can no longer be opened by the person's key, which is gone.
      await expect(unsealText(runtime, keys, personId, await stored())).rejects.toMatchObject({
        code: "erased",
      });
      // The number's next text gets a new person and a new key, which open nothing of the old one's.
      const next = keyOf(await handleSealingKey(runtime, keys, request(address, "erase-2")));
      expect(next.outcome).toMatchObject({ handleId, created: { handle: false, person: true, key: true } });
      expect(next.outcome.personId).not.toBe(personId);
      await expect(openWith(next.dataKey, personId, await stored())).rejects.toThrow();
      await expect(unsealText(runtime, keys, next.outcome.personId, await stored())).rejects.toMatchObject({
        code: "cannot_open",
      });
      // The erased key stays erased, with its row and link (nothing is removed: K-05 open gap 28).
      expect(await countRows("sealing_keys", db.sql`person_id = ${personId} and wrapped_key is null`)).toBe(
        1,
      );
      expect(await countRows("person_handles", db.sql`handle_id = ${handleId}`)).toBe(2);
    },
  );
});

describe("handleSealingKey: what the fixtures leave out", () => {
  it("a new id already taken answers constraint (23505) and writes nothing", SLOW, async () => {
    await loadSeeds(["seed-sealing-key.json"]);
    const takenHandle = await handleSealingKey(runtime, keys, {
      ...request("+15555550172", "taken"),
      newHandleId: "handle-alex",
    });
    expect(takenHandle).toEqual({
      outcome: { error: "constraint", sqlstate: "23505", constraint: "handles_pkey" },
      dataKey: null,
    });
    expect(schemaErrors("handleSealingKey.errors", takenHandle.outcome)).toEqual([]);
    const takenPerson = await handleSealingKey(runtime, keys, {
      ...request("+15555550172", "taken"),
      newPersonId: "person-alex",
    });
    expect(takenPerson.outcome).toEqual({
      error: "constraint",
      sqlstate: "23505",
      constraint: "persons_pkey",
    });
    expect(await countRows("handles", db.sql`address = '+15555550172'`)).toBe(0);
    expect(await countRows("handles", db.sql`id = 'handle-t220-taken'`)).toBe(0);
  });

  it(
    "a missing wrapping key throws and writes nothing; a stored key that is not a wrapped key never opens",
    SLOW,
    async () => {
      await loadSeeds(["seed-sealing-key.json"]);
      const none = { resolve: (): undefined => undefined };
      await expect(handleSealingKey(runtime, none, request("+15555550173", "nokey"))).rejects.toMatchObject({
        code: "wrapping_key_missing",
      });
      expect(await countRows("handles", db.sql`address = '+15555550173'`)).toBe(0);
      const short = { resolve: (): string => btoa("too short") };
      await expect(handleSealingKey(runtime, short, request("+15555550173", "short"))).rejects.toMatchObject({
        code: "wrapping_key_invalid",
      });
      // K-04's seed bytes for Alex are a stand-in, not a wrapped key: the call refuses them rather than hand out a key.
      await loadSeeds(["seed-sealing-key.json"], { seedKeyBytes: true });
      await expect(handleSealingKey(runtime, keys, request("+15555550101", "alex"))).rejects.toMatchObject({
        code: "bad_format",
      });
      // A key wrapped for another person does not open as Alex's (the wrap's additional data names the person).
      await db.sql`
      update sealing_keys set wrapped_key = ${await realWrappedKey("person-sam")}, version = version + 1
      where person_id = 'person-alex'
    `;
      await expect(handleSealingKey(runtime, keys, request("+15555550101", "alex"))).rejects.toMatchObject({
        code: "cannot_open",
      });
    },
  );

  it("under a business scope the call refuses to run, before it locks or writes anything", async () => {
    await loadSeeds(["seed-sealing-key.json"]);
    await expect(
      withBusiness(runtime, "biz-lees-barbershop", (tx) =>
        handleSealingKeyIn(tx, keys, request("+15555550174", "scoped")),
      ),
    ).rejects.toThrow("handleSealingKey runs on the runtime side, with no business scope");
    expect(await countRows("handles", db.sql`address = '+15555550174'`)).toBe(0);
  });

  it("an email handle at first sight, and a malformed request refused before any write", SLOW, async () => {
    await loadSeeds(["seed-sealing-key.json"]);
    const email = keyOf(
      await handleSealingKey(runtime, keys, {
        handle: { kind: "email", address: "dee@example.com" },
        newHandleId: "handle-t220-dee-email",
        newPersonId: "person-t220-dee-email",
        wrappingKeyName: WRAP_NAME,
      }),
    );
    expect(email.outcome).toMatchObject({
      handleId: "handle-t220-dee-email",
      personId: "person-t220-dee-email",
      created: { handle: true, person: true, key: true },
    });
    for (const bad of [
      { ...request("+15555550175", "bad"), wrappingKeyName: "sealing_wrap_key" },
      { ...request("5555550175", "bad") },
      { ...request("+15555550175", "bad"), newPersonId: "" },
      { ...request("+15555550175", "bad"), handle: { kind: "sms", address: "+15555550175" } },
    ]) {
      await expect(handleSealingKey(runtime, keys, bad as HandleSealingKeyRequest)).rejects.toThrow(
        TypeError,
      );
    }
    expect(await countRows("handles", db.sql`address = '+15555550175'`)).toBe(0);
  });

  it(
    "a handle two people write from: the oldest held key, a tie to the lower person id; else the first person with none",
    SLOW,
    async () => {
      await loadSeeds(["seed-sealing-key.json"]);
      await db.sql.begin(async (tx) => {
        await tx`insert into handles (id, kind, address) values ('handle-t220-shared', 'phone', '+15555550176')`;
        await tx`insert into persons (id) values ('person-t220-b'), ('person-t220-a'), ('person-t220-c')`;
        await tx`insert into person_handles (person_id, handle_id)
                 values ('person-t220-b', 'handle-t220-shared'), ('person-t220-a', 'handle-t220-shared'),
                        ('person-t220-c', 'handle-t220-shared')`;
        for (const person of ["person-t220-a", "person-t220-b"]) {
          await tx`insert into sealing_keys (person_id, wrapped_key, wrapping_key_name, created_at)
                   values (${person}, ${await realWrappedKey(person)}, ${WRAP_NAME}, '2026-11-01T10:00:00Z')`;
        }
      });
      const shared = request("+15555550176", "shared");
      // Two keys made at the same moment: the lower person id's.
      expect(keyOf(await handleSealingKey(runtime, keys, shared)).outcome).toMatchObject({
        personId: "person-t220-a",
        created: { handle: false, person: false, key: false },
      });
      // An older key wins over a lower id.
      await db.sql`update sealing_keys set created_at = '2026-10-01T10:00:00Z', version = version + 1
                   where person_id = 'person-t220-b'`;
      expect(keyOf(await handleSealingKey(runtime, keys, shared)).outcome.personId).toBe("person-t220-b");
      // Both erased: the first person with no key at all gets one; no new person.
      await erasePerson(runtime, "person-t220-a");
      await erasePerson(runtime, "person-t220-b");
      expect(keyOf(await handleSealingKey(runtime, keys, shared)).outcome).toMatchObject({
        personId: "person-t220-c",
        created: { handle: false, person: false, key: true },
      });
    },
  );
});

// ---- T-1322: a statement's own refusal and postgres.js's statement errors leave scrubbed ------------------------------
//
// Five errors are made for real on local PostgreSQL by postgres.js as installed, four of them holding a made-up number
// (rule 9: a 555-01xx number): PostgreSQL's refusal of a statement (22P02, the number in its message) and of a row (a
// CHECK's 23514, the number in its detail, with its table's and constraint's names); postgres.js's UNDEFINED_VALUE (the
// number among the statement's args) and the TypeError its bytea serializer throws (the number in its message); and a
// serialization failure PostgreSQL raises (40001). postgres.js puts the statement on each, its values in args. Each
// reaches the call as postgres.js rejects the call's first statement with it, on a client whose socket fails with it
// (as connect-failures.int.test.ts delivers a socket's error). 22P02, UNDEFINED_VALUE and the TypeError leave scrubbed:
// the call's name and the code alone, PostgreSQL's as DataAccessDatabaseError, with the number in no message, stack or
// other own property. The call's own answers are as before, no data key beside them: the rule's refusal answers
// constraint with its SQLSTATE and the constraint's name alone, and 40001 transient with its SQLSTATE.

describe("handleSealingKey: a statement's own refusal and postgres.js's statement errors leave scrubbed (T-1322)", () => {
  type Kind = "refusal" | "rule" | "undefinedValue" | "serialization" | "serialize";
  /** Thrown as DataAccessDatabaseError (its message's SQLSTATE and names: `shown`), as a client's code, or answered. */
  type Expected =
    | { database: { code: string; table: string | null; constraint: string | null; shown: string } }
    | { client: string }
    | { answer: unknown };
  const NUMBER = "+15555550147";
  const KINDS: { kind: Kind; name: string; expected: Expected }[] = [
    {
      kind: "refusal",
      name: "PostgreSQL's 22P02, the number in its message, leaves as DataAccessDatabaseError",
      expected: { database: { code: "22P02", table: null, constraint: null, shown: "22P02" } },
    },
    {
      kind: "rule",
      name: "a CHECK's 23514, the number in its detail, still answers constraint with its SQLSTATE and name alone",
      expected: {
        answer: {
          outcome: { error: "constraint", sqlstate: "23514", constraint: "t1322_numbers_short" },
          dataKey: null,
        },
      },
    },
    {
      kind: "undefinedValue",
      name: "postgres.js's UNDEFINED_VALUE, the number in its args, leaves with its code alone",
      expected: { client: "UNDEFINED_VALUE" },
    },
    {
      kind: "serialize",
      name: "the TypeError of postgres.js's bytea serializer, the number in its message, leaves with its code alone",
      expected: { client: "ERR_INVALID_ARG_TYPE" },
    },
    {
      kind: "serialization",
      name: "PostgreSQL's 40001 still answers transient with its SQLSTATE",
      expected: { answer: { outcome: { error: "transient", sqlstate: "40001" }, dataKey: null } },
    },
  ];
  /** The wrapping key's resolver, never reached: the call fails at its transaction's first statement. */
  const NO_KEYS = { resolve: (): undefined => undefined };
  const CALLS: { call: string; run: (sql: Sql) => Promise<unknown> }[] = [
    {
      call: "handleSealingKey",
      run: (sql) =>
        handleSealingKey(sql, NO_KEYS, {
          handle: { kind: "phone", address: NUMBER },
          newHandleId: "handle-t1322",
          newPersonId: "person-t1322",
          wrappingKeyName: WRAP_NAME,
        }),
    },
  ];
  const CASES = CALLS.flatMap(({ call, run }) =>
    KINDS.map(({ kind, name, expected }) => ({ call, run, kind, expected, name: `${call}: ${name}` })),
  );
  let made: Record<Kind, Error>;

  /** Every text `value` holds, deeply: its own property names and values, enumerable or not, its stack among them. */
  const textsOf = (value: unknown, seen = new Set<object>()): string[] => {
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
  };
  const holdsNumber = (value: unknown): boolean =>
    textsOf(value).some((text) => text.includes(NUMBER.slice(1)));

  /** The error `statement` is refused with. */
  const refusalOf = async (statement: Promise<unknown>): Promise<Error> => {
    try {
      await statement;
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
    }
    throw new Error("the statement was not refused with an error");
  };

  /** What `run` gives on a client whose socket fails with `raw`: postgres.js rejects its first statement with it. */
  const outcomeOn = async (
    raw: Error,
    run: (sql: Sql) => Promise<unknown>,
  ): Promise<{ answer: unknown } | { thrown: unknown }> => {
    const options = { max: 1, onnotice: () => undefined, socket: () => Promise.reject(raw) };
    const sql = postgres("postgres://t1322@db-t1322.example.invalid:65123/t1322", options);
    try {
      return { answer: await run(sql) };
    } catch (error) {
      return { thrown: error };
    } finally {
      await sql.end({ timeout: 0 });
    }
  };

  beforeAll(async () => {
    const sql = postgres(resolvePrimaryUrl(), { max: 1, onnotice: () => undefined });
    try {
      await sql`create temp table t1322_numbers (number text constraint t1322_numbers_short check (length(number) < 5))`;
      made = {
        refusal: await refusalOf(sql`select ${NUMBER}::uuid as id`),
        rule: await refusalOf(sql`insert into t1322_numbers (number) values (${NUMBER})`),
        undefinedValue: await refusalOf(
          sql`select ${NUMBER}::text as number, ${undefined as never}::text as gone`,
        ),
        serialization: await refusalOf(
          sql.unsafe(
            "do $$ begin raise exception using errcode = '40001', message = 'could not serialize'; end $$",
          ),
        ),
        serialize: await refusalOf(sql`select ${sql.typed(Number(NUMBER.slice(1)), 17)} as bytes`),
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it.each(CASES)("$name", async ({ call, run, kind, expected }) => {
    const raw = made[kind];
    const outcome = await outcomeOn(raw, run);
    if ("answer" in expected) {
      expect(outcome).toEqual({ answer: expected.answer });
      return;
    }
    // The error holds the number, so the check means something; postgres.js put the statement on it.
    expect(holdsNumber(raw)).toBe(true);
    expect(Object.hasOwn(raw, "args")).toBe(true);
    if (!("thrown" in outcome)) {
      throw new Error(`${call} answered`);
    }
    // Booleans first, so a failing run prints neither error's text.
    const { thrown } = outcome;
    expect(thrown === raw).toBe(false);
    expect(holdsNumber(thrown)).toBe(false);
    if ("database" in expected) {
      const { code, table, constraint, shown } = expected.database;
      expect(thrown).toBeInstanceOf(DataAccessDatabaseError);
      expect(Object.getOwnPropertyNames(thrown).sort()).toEqual([
        "call",
        "code",
        "constraint",
        "message",
        "name",
        "stack",
        "table",
      ]);
      expect(thrown).toMatchObject({
        call,
        code,
        table,
        constraint,
        message: `${call}: the database refused the call (SQLSTATE ${shown})`,
      });
      return;
    }
    expect(Object.getOwnPropertyNames(thrown).sort()).toEqual(["call", "code", "message", "stack"]);
    expect(thrown).toMatchObject({
      call,
      code: expected.client,
      message: `${call}: the database call failed (code ${expected.client})`,
    });
  });
});
