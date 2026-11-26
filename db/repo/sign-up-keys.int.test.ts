// T-1561: K-05 v1.24's readSignUpKeys (item 85, defaults 226 and 227), S1-10's keys by person, against local PostgreSQL
// (`npm run test:integration -- db/repo/sign-up-keys`). The schema comes from migrating a fresh test schema
// (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The read runs as K-05 v1.24 names it: through a client whose connections run as rosie_job, the runtime side's role,
// with no business scope; the role is the connection's. The tables' owner (the migrations' role) loads K-04's seed a
// fixture's `given` names and writes the rows its note lists (the phone row, the account and the upload beyond K-04's
// seed) and a case's. Every answer is checked against data-access v1.24 with Ajv 2020-12, strict, as contracts:check
// runs it.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its
// parameters, kept in memory for the checks and never printed), so the checks read what the read sent: one read-only
// transaction at repeatable read on one connection, one statement over id_uploads, accounts and phones (one moment), the
// person id bound as a parameter, no number in a statement's text, and no statement naming object_key, content_type,
// email, summary or code_hash.
//
// Names are the master's sample cast as K-04's seed holds them (rule 9). The rows a case adds carry example ids (t1561)
// and numbers in the fiction range 555-0100 to 555-0199; every object key is a stand-in, the sealed bytes of no file.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataAccessDatabaseError } from "./clocks";
import type { Sql } from "./scope";
import { readSignUpKeys, type ReadSignUpKeysRequest } from "./sign-up-keys";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { BrokenRecordError } from "./turn-face-reads";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const SLOW = { timeout: 60_000 };

const SAM = "person-sam";
const SAM_HANDLE = "handle-sam";
const SAM_NUMBER = "+15555550100";
const MAYA = "person-maya";
const MAYA_HANDLE = "handle-maya";
const MAYA_NUMBER = "+15555550104";
const PROVEN_AT = "2026-11-23T14:58:41Z";
const UPLOADED_AT = "2026-11-23T15:02:10Z";
/** The stand-in sealed object key refuse-sign-up-keys-object-key shows, never a real key. */
const OBJECT_KEY = "\\x5ea1ed0b1ec70a1b2c3d";

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string; note?: string };
  request: Row;
  outcome: Row;
}

interface TableRow {
  table: string;
  values: Row;
}

interface IndexEntry {
  file: string;
  version: string;
  def?: string;
  expect: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const INDEX = (readJson(new URL("index.json", ACCESS_DIR)) as { fixtures: IndexEntry[] }).fixtures;
const OWN = INDEX.filter((entry) => (entry.def ?? "").startsWith("readSignUpKeys."));
const ACCEPTED = OWN.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
const REFUSED = OWN.filter((entry) => entry.expect === "refuse");
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

// ---- the contract's own schema (Ajv 2020-12, strict, as contracts:check runs it) ---------------------------------------

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
const V124_ID = (readJson(new URL("data-access/data-access.v1.24.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** `value` checked against one $defs entry of data-access v1.24: Ajv's errors, none when it passes. */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V124_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.24 has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

/** One statement the rosie_job client sent (in memory only, never printed). */
interface Sent {
  connection: number;
  text: string;
  parameters: readonly unknown[];
}

let db: TestDatabase;
let job: Sql;
let app: Sql;
let typedColumns: Map<string, string>;
const sent: Sent[] = [];

function roleClient(role: string, name: string, record: boolean): Sql {
  return db.connect({
    // One connection for a client that records nothing, so a setting a case makes on it holds for its next read.
    max: record ? 2 : 1,
    onnotice: () => undefined,
    ...(record
      ? {
          debug: (connection: number, text: string, parameters: unknown[]) => {
            sent.push({ connection, text, parameters: [...parameters] });
          },
        }
      : {}),
    connection: { application_name: name, search_path: `${db.schema}, public`, role },
  });
}

beforeAll(async () => {
  db = await createTestDatabase({ name: "sign_up_keys" });
  job = roleClient("rosie_job", "rosie-t1561-keys-job", true);
  app = roleClient("rosie_app", "rosie-t1561-keys-app", false);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 60_000);

afterAll(async () => {
  await job.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  await db.drop();
});

/** A seed's rows after those of the seeds its `after` names, each once. */
function seedRows(seed: URL, seen: Set<string>): TableRow[] {
  if (seen.has(seed.href)) {
    return [];
  }
  seen.add(seed.href);
  const file = readJson(seed) as { after: string[]; rows: TableRow[] };
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** Empties the tables, then writes K-04's seeds and `rows` as the owner, in one transaction. */
async function given(k04Seeds: readonly string[], rows: readonly TableRow[]): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const seen = new Set<string>();
  const all = [...k04Seeds.flatMap((seed) => seedRows(new URL(seed, CORE_DIR), seen)), ...rows];
  await db.sql.begin(async (tx) => {
    for (const row of all) {
      const values: Record<string, never> = {};
      for (const [column, value] of Object.entries(row.values)) {
        const type = typedColumns.get(`${row.table}.${column}`);
        values[column] = (
          type === "jsonb" && value !== null
            ? tx.json(value)
            : type === "bytea" && typeof value === "string"
              ? fromHex(value.replace(/^\\x/, ""))
              : value
        ) as never;
      }
      await tx`insert into ${tx(row.table)} ${tx(values)}`;
    }
  });
}

const phone = (number: string, handleId: string): TableRow => ({
  table: "phones",
  values: { number, handle_id: handleId },
});
const account = (personId: string, mobile: string | null, provenAt: string | null): TableRow => ({
  table: "accounts",
  values: { person_id: personId, mobile, mobile_proven_at: provenAt },
});
const upload = (id: string, personId: string, purpose: "sign_up" | "re_check", at: string): TableRow => ({
  table: "id_uploads",
  values: {
    id,
    person_id: personId,
    purpose,
    object_key: OBJECT_KEY,
    content_type: "image/jpeg",
    uploaded_at: at,
  },
});

/** The rows read-sign-up-keys-sam's note lists beyond K-04's seed: Sam's phone, his proven account, his upload. */
const SAM_ROWS: readonly TableRow[] = [
  phone(SAM_NUMBER, SAM_HANDLE),
  account(SAM, SAM_NUMBER, PROVEN_AT),
  upload("upload-sam-id", SAM, "sign_up", UPLOADED_AT),
];
/** read-sign-up-keys-before-upload's: the same, before the upload. */
const NOTE_ROWS: Readonly<Record<string, readonly TableRow[]>> = {
  "read-sign-up-keys-sam.json": SAM_ROWS,
  "read-sign-up-keys-before-upload.json": SAM_ROWS.slice(0, 2),
};

/** Runs the read on the rosie_job client with every console method watched: its outcome, statements and log count. */
async function watched(request: unknown): Promise<{ outcome: unknown; statements: Sent[]; logged: number }> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  sent.length = 0;
  try {
    let outcome: unknown;
    try {
      outcome = await readSignUpKeys(job, request as ReadSignUpKeysRequest);
    } catch (error) {
      outcome = error;
    }
    return {
      outcome,
      statements: [...sent],
      logged: spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
}

/**
 * The transaction's own statements, which carry no read (its probe, begin, the scope's reset, commit, rollback), and
 * postgres.js's own lookup of the server's array types on a new connection.
 */
const FRAME =
  /^(select 1|begin isolation level repeatable read read only|select set_config\(\$1, '', true\)|commit|rollback|select b\.oid, b\.typarray\s[^;]*)$/;
const isFrame = (statement: Sent): boolean => FRAME.test(statement.text.trim());
const NEVER_NAMED = ["object_key", "content_type", "email", "summary", "code_hash", "person_roles"];

/** What every run must hold of what it sent (README item 85; card A10). */
function expectStatements(statements: readonly Sent[], personId: string, numbers: readonly string[]): void {
  const begin = statements.findIndex((statement) => statement.text.trim().startsWith("begin"));
  expect(statements[begin]?.text.trim()).toBe("begin isolation level repeatable read read only");
  const inside = statements.slice(begin);
  expect(new Set(inside.map((statement) => statement.connection)).size).toBe(1);
  expect(inside.at(-1)?.text.trim()).toMatch(/^(commit|rollback)$/);
  const reads = statements.filter((statement) => !isFrame(statement));
  expect(reads).toHaveLength(1);
  const [read] = reads;
  for (const table of ["id_uploads", "accounts", "phones"]) {
    expect(read?.text.includes(table), table).toBe(true);
  }
  expect(read?.parameters).toContain(personId);
  for (const statement of statements) {
    for (const word of NEVER_NAMED) {
      expect(statement.text.includes(word), word).toBe(false);
    }
    for (const number of numbers) {
      expect(statement.text.includes(number)).toBe(false);
    }
  }
}

// ---- the tests ------------------------------------------------------------------------------------------------------

describe("readSignUpKeys's fixtures (K-05 v1.24 item 85)", () => {
  it("the index lists item 85's two exchanges and its one refused twin, each as its definition takes it", () => {
    expect([...ACCEPTED].sort()).toEqual([
      "read-sign-up-keys-before-upload.json",
      "read-sign-up-keys-sam.json",
    ]);
    expect(REFUSED.map((entry) => entry.file)).toEqual(["invalid/refuse-sign-up-keys-object-key.json"]);
    for (const file of ACCEPTED) {
      expect(schemaErrors("readSignUpKeys.exchange", exchangeOf(file)), file).toEqual([]);
    }
    for (const entry of REFUSED) {
      expect(schemaErrors(entry.def ?? "", exchangeOf(entry.file)), entry.file).not.toEqual([]);
    }
  });

  for (const file of ["read-sign-up-keys-sam.json", "read-sign-up-keys-before-upload.json"]) {
    it(
      `${file}: as rosie_job, the fixture's outcome, as one statement in one read-only transaction`,
      SLOW,
      async () => {
        const exchange = exchangeOf(file);
        await given(exchange.given.k04Seeds, NOTE_ROWS[file] ?? []);
        const run = await watched(exchange.request);
        expect(run.outcome).toEqual(exchange.outcome);
        expect(schemaErrors("readSignUpKeys.response", run.outcome)).toEqual([]);
        expect(schemaErrors("readSignUpKeys.exchange", { ...exchange, outcome: run.outcome })).toEqual([]);
        expectStatements(run.statements, SAM, [SAM_NUMBER]);
        expect(run.logged).toBe(0);
      },
    );
  }

  it(
    "refuse-sign-up-keys-object-key: the read answers read-sign-up-keys-sam's outcome, never the object key; put right, the twin is that outcome",
    SLOW,
    async () => {
      const twin = exchangeOf("read-sign-up-keys-sam.json");
      const refused = exchangeOf("invalid/refuse-sign-up-keys-object-key.json");
      await given(twin.given.k04Seeds, SAM_ROWS);
      const outcome = await readSignUpKeys(job, twin.request as unknown as ReadSignUpKeysRequest);
      expect(outcome).toEqual(twin.outcome);
      expect(outcome).not.toEqual(refused.outcome);
      expect(JSON.stringify(outcome).includes("objectKey")).toBe(false);
      const { objectKey, ...idUpload } = refused.outcome.idUpload as Row;
      expect(objectKey).toBe(OBJECT_KEY);
      expect({ ...refused.outcome, idUpload }).toEqual(twin.outcome);
      expect(refused.request).toEqual(twin.request);
    },
  );
});

describe("readSignUpKeys beyond the fixtures (README item 85, default 227)", () => {
  const cases: {
    shows: string;
    rows: TableRow[];
    personId: string;
    idUpload: Row | null;
    mobile: Row | null;
  }[] = [
    {
      shows: "a re_check upload alone is no S1-10 key: idUpload null",
      rows: [
        phone(SAM_NUMBER, SAM_HANDLE),
        account(SAM, SAM_NUMBER, PROVEN_AT),
        upload("upload-t1561-sam-recheck", SAM, "re_check", UPLOADED_AT),
      ],
      personId: SAM,
      idUpload: null,
      mobile: { number: SAM_NUMBER, provenAt: PROVEN_AT, handleId: SAM_HANDLE },
    },
    {
      shows: "a sign_up upload beside a later re_check one: the sign_up one alone",
      rows: [
        phone(SAM_NUMBER, SAM_HANDLE),
        account(SAM, SAM_NUMBER, PROVEN_AT),
        upload("upload-sam-id", SAM, "sign_up", UPLOADED_AT),
        upload("upload-t1561-sam-recheck", SAM, "re_check", "2026-11-24T09:00:00Z"),
      ],
      personId: SAM,
      idUpload: { uploadId: "upload-sam-id", uploadedAt: UPLOADED_AT },
      mobile: { number: SAM_NUMBER, provenAt: PROVEN_AT, handleId: SAM_HANDLE },
    },
    {
      shows: "a mobile not proven yet is no key: mobile null, the upload still given",
      rows: [
        phone(SAM_NUMBER, SAM_HANDLE),
        account(SAM, SAM_NUMBER, null),
        upload("upload-sam-id", SAM, "sign_up", UPLOADED_AT),
      ],
      personId: SAM,
      idUpload: { uploadId: "upload-sam-id", uploadedAt: UPLOADED_AT },
      mobile: null,
    },
    {
      shows: "an account with no mobile: mobile null",
      rows: [account(SAM, null, null)],
      personId: SAM,
      idUpload: null,
      mobile: null,
    },
    {
      shows: "a person with no row of any of the three: both null, never notFound",
      rows: [],
      personId: SAM,
      idUpload: null,
      mobile: null,
    },
    {
      shows: "a person id no row names: both null, so the read never tells whether a person exists",
      rows: [],
      personId: "person-t1561-nobody",
      idUpload: null,
      mobile: null,
    },
    {
      shows: "another person's upload and proven mobile are never answered for Sam: both null",
      rows: [
        phone(MAYA_NUMBER, MAYA_HANDLE),
        account(MAYA, MAYA_NUMBER, PROVEN_AT),
        upload("upload-t1561-maya-id", MAYA, "sign_up", UPLOADED_AT),
      ],
      personId: SAM,
      idUpload: null,
      mobile: null,
    },
    {
      shows: "beside another person's rows, Maya's own keys, her handle from her own number",
      rows: [
        ...SAM_ROWS,
        phone(MAYA_NUMBER, MAYA_HANDLE),
        account(MAYA, MAYA_NUMBER, "2026-11-23T16:00:00Z"),
        upload("upload-t1561-maya-id", MAYA, "sign_up", "2026-11-23T16:05:00Z"),
      ],
      personId: MAYA,
      idUpload: { uploadId: "upload-t1561-maya-id", uploadedAt: "2026-11-23T16:05:00Z" },
      mobile: { number: MAYA_NUMBER, provenAt: "2026-11-23T16:00:00Z", handleId: MAYA_HANDLE },
    },
  ];

  for (const spec of cases) {
    it(spec.shows, SLOW, async () => {
      await given(["seed-person-roles.json"], spec.rows);
      const run = await watched({ personId: spec.personId });
      expect(run.outcome).toEqual({
        result: "signUpKeys",
        personId: spec.personId,
        idUpload: spec.idUpload,
        mobile: spec.mobile,
      });
      expect(schemaErrors("readSignUpKeys.response", run.outcome)).toEqual([]);
      expectStatements(run.statements, spec.personId, [SAM_NUMBER, MAYA_NUMBER]);
      expect(run.logged).toBe(0);
    });
  }

  it(
    "a proven mobile with no phone row (accounts_mobile_fk dropped in this file's schema for this test alone) throws BrokenRecordError, naming no value, and rolls back (default 1)",
    SLOW,
    async () => {
      const schema = `"${db.schema}"`;
      try {
        await db.sql.unsafe(`alter table ${schema}.accounts drop constraint accounts_mobile_fk`);
        await given(["seed-person-roles.json"], [account(SAM, "+15555550170", PROVEN_AT)]);
        const run = await watched({ personId: SAM });
        expect(run.outcome).toBeInstanceOf(BrokenRecordError);
        expect((run.outcome as Error).message).toBe(
          "readSignUpKeys: a proven account mobile has no phone row",
        );
        expect(run.statements.at(-1)?.text.trim()).toBe("rollback");
        expect(run.logged).toBe(0);
      } finally {
        await given([], []);
        await db.sql.unsafe(
          `alter table ${schema}.accounts add constraint accounts_mobile_fk foreign key (mobile) references ${schema}.phones (number) on delete restrict`,
        );
      }
    },
  );

  it("a request of the wrong shape is refused before any statement, naming the field, never a value", async () => {
    const refused: [unknown, string][] = [
      [null, "readSignUpKeys: the request is an object"],
      [[], "readSignUpKeys: the request is an object"],
      [{}, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: "" }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: 7 }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: "person-\u0000sam" }, "readSignUpKeys: personId is a K-04 person id, a non-empty text"],
      [{ personId: SAM, mobile: SAM_NUMBER }, "readSignUpKeys: the request takes only personId"],
    ];
    for (const [request, message] of refused) {
      const run = await watched(request);
      expect(run.outcome, message).toBeInstanceOf(TypeError);
      expect((run.outcome as Error).message).toBe(message);
      expect(run.statements).toEqual([]);
    }
  });
});

describe("the side the read runs on (default 226)", () => {
  it("the clients run as rosie_job and rosie_app, with this file's schema first and no business scope", async () => {
    for (const [client, role] of [
      [job, "rosie_job"],
      [app, "rosie_app"],
    ] as const) {
      const [row] = await client<{ who: string; scope: string | null }[]>`
        select current_user as who, current_setting('rosie.business_id', true) as scope
      `;
      expect(row?.who).toBe(role);
      expect(row?.scope ?? "").toBe("");
    }
  });

  it(
    "the Tool API's role is refused by PostgreSQL's privilege check (no grant on id_uploads or accounts), scrubbed, naming no person or number",
    SLOW,
    async () => {
      await given(["seed-person-roles.json"], SAM_ROWS);
      let error: unknown = null;
      try {
        await readSignUpKeys(app, { personId: SAM });
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect((error as DataAccessDatabaseError).code).toBe("42501");
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const value of [SAM, SAM_NUMBER, "upload-sam-id"]) {
        expect(text.includes(value), value).toBe(false);
      }
    },
  );

  it(
    "a business scope a connection kept is emptied for the read's transaction: Sam's keys through a connection scoped to the barbershop",
    SLOW,
    async () => {
      await given(["seed-person-roles.json"], SAM_ROWS);
      const scoped = roleClient("rosie_job", "rosie-t1561-keys-scoped", false);
      try {
        await scoped`select set_config('rosie.business_id', 'biz-lees-barbershop', false)`;
        expect(await readSignUpKeys(scoped, { personId: SAM })).toEqual(
          exchangeOf("read-sign-up-keys-sam.json").outcome,
        );
      } finally {
        await scoped.end({ timeout: 5 });
      }
    },
  );
});
