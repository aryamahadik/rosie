// T-1573: K-05 v1.24's readPendingUpload (item 86) and v1.25's readUploadFinishedAt (item 94), the pending upload by its
// upload id, read from K-22 v1.4's pending_uploads (migration 0041), against local PostgreSQL
// (`npm run test:integration -- db/repo/pending-uploads`). The schema comes from migrating a fresh test schema
// (db/repo/test-db.ts), which is dropped when the file ends; the public schema is never touched.
//
// The reads run as K-05 names them: through a client whose connections run as rosie_job, the runtime side's role, with
// no business scope; the role is the connection's. The tables' owner (the migrations' role) loads K-04's seed a
// fixture's `given` names and writes the rows its note lists (the pending upload, and the demo owner's person row,
// which no seed holds) and a case's. Every answer is checked against data-access v1.25 with Ajv 2020-12, strict, as
// contracts:check runs it.
//
// The rosie_job client records every statement it sends (postgres.js debug: its connection, its text and its
// parameters, kept in memory for the checks and never printed), so the checks read what each read sent: one read-only
// transaction at repeatable read on one connection, one statement over pending_uploads, the upload id bound as a
// parameter, item 94's naming finished_at alone, and neither naming created_at or expires_at.
//
// Names are the master's sample cast as K-04's seed holds them (rule 9), and the demo owner of K-05 v1.25's fixtures.
// The rows a case adds carry example ids (t1573) and times; every object key is a stand-in, the sealed bytes of no file.
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DataAccessDatabaseError } from "./clocks";
import { readPendingUpload, readUploadFinishedAt } from "./pending-uploads";
import type { Sql } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { BrokenRecordError } from "./turn-face-reads";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const SLOW = { timeout: 60_000 };

const SAM = "person-sam";
const DEMO_OWNER = "person-demo-owner";
const BARBERSHOP = "biz-lees-barbershop";
/** The stand-in sealed object key read-pending-upload-sam-id answers, never a real key. */
const SAM_KEY = "\\x5ea1ed0b1ec70a1b2c3d";
/** A stand-in sealed key for the demo owner's upload (refuse-upload-finished-object-key's), never a real key. */
const DEMO_KEY = "\\x0a1b2c3d4e5f60718293a4b5c6d7e8f9";

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
const ownOf = (call: string): IndexEntry[] =>
  INDEX.filter((entry) => (entry.def ?? "").startsWith(`${call}.`));
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
const V125_ID = (readJson(new URL("data-access/data-access.v1.25.schema.json", CONTRACTS)) as { $id: string })
  .$id;

/** `value` checked against one $defs entry of data-access v1.25: Ajv's errors, none when it passes. */
function schemaErrors(def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${V125_ID}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`data-access v1.25 has no $defs/${def}`);
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
  db = await createTestDatabase({ name: "pending_uploads" });
  job = roleClient("rosie_job", "rosie-t1573-uploads-job", true);
  app = roleClient("rosie_app", "rosie-t1573-uploads-app", false);
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

/** A pending upload as signedUpload writes it and finishUpload finishes it (finished null: its file never came). */
function upload(
  id: string,
  values: {
    personId?: string;
    businessId?: string | null;
    purpose?: string;
    contentType?: string;
    objectKey?: string;
    createdAt: string;
    expiresAt: string;
    finishedAt: string | null;
  },
): TableRow {
  return {
    table: "pending_uploads",
    values: {
      id,
      person_id: values.personId ?? SAM,
      business_id: values.businessId ?? null,
      purpose: values.purpose ?? "sign_up",
      object_key: values.objectKey ?? SAM_KEY,
      content_type: values.contentType ?? "image/jpeg",
      created_at: values.createdAt,
      expires_at: values.expiresAt,
      finished_at: values.finishedAt,
    },
  };
}

/** read-pending-upload-sam-id's note: Sam's sign_up upload, no business, a JPEG, finished a second before the read. */
const SAM_UPLOAD = upload("upload-sam-id", {
  createdAt: "2026-11-23T15:01:00Z",
  expiresAt: "2026-11-23T15:16:00Z",
  finishedAt: "2026-11-23T15:02:10Z",
});
/** An upload of Sam's whose file never came (finished_at null). */
const UNFINISHED = upload("upload-t1573-never-came", {
  createdAt: "2026-11-24T10:00:00Z",
  expiresAt: "2026-11-24T10:15:00Z",
  finishedAt: null,
});
/** read-upload-finished-demo-owner's note: the demo owner (no seed holds the person) and his upload finished 14:31:02. */
const DEMO_ROWS: readonly TableRow[] = [
  { table: "persons", values: { id: DEMO_OWNER, name: "Demo Owner", language: "en" } },
  upload("upload-demo-owner-1", {
    personId: DEMO_OWNER,
    objectKey: DEMO_KEY,
    createdAt: "2026-10-19T14:29:40Z",
    expiresAt: "2026-10-19T14:44:40Z",
    finishedAt: "2026-10-19T14:31:02Z",
  }),
];
/** The rows each fixture's note lists beyond K-04's seeds. */
const NOTE_ROWS: Readonly<Record<string, readonly TableRow[]>> = {
  "read-pending-upload-sam-id.json": [SAM_UPLOAD],
  "read-pending-upload-unknown.json": [SAM_UPLOAD],
  "read-upload-finished-demo-owner.json": DEMO_ROWS,
  "read-upload-finished-unknown.json": DEMO_ROWS,
};

type Read = (sql: Sql, request: unknown) => Promise<unknown>;
const READS: Readonly<Record<string, Read>> = {
  readPendingUpload: (sql, request) => readPendingUpload(sql, request as never),
  readUploadFinishedAt: (sql, request) => readUploadFinishedAt(sql, request as never),
};

function readOf(call: string): Read {
  const read = READS[call];
  if (read === undefined) {
    throw new Error(`no read ${call}`);
  }
  return read;
}

/** Runs a read on the rosie_job client with every console method watched: its outcome, statements and log count. */
async function watched(
  call: string,
  request: unknown,
): Promise<{ outcome: unknown; statements: Sent[]; logged: number }> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  sent.length = 0;
  try {
    let outcome: unknown;
    try {
      outcome = await readOf(call)(job, request);
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
/** Columns each read never names: item 94 its time alone (README item 94), and neither the row's made or lapse time. */
const NEVER_NAMED: Readonly<Record<string, readonly string[]>> = {
  readPendingUpload: ["created_at", "expires_at", "id_uploads"],
  readUploadFinishedAt: [
    "object_key",
    "person_id",
    "business_id",
    "content_type",
    "purpose",
    "created_at",
    "expires_at",
  ],
};

/** What every run must hold of what it sent (README items 86 and 94). */
function expectStatements(call: string, statements: readonly Sent[], uploadId: string): void {
  const begin = statements.findIndex((statement) => statement.text.trim().startsWith("begin"));
  expect(statements[begin]?.text.trim()).toBe("begin isolation level repeatable read read only");
  const inside = statements.slice(begin);
  expect(new Set(inside.map((statement) => statement.connection)).size).toBe(1);
  expect(inside.at(-1)?.text.trim()).toMatch(/^(commit|rollback)$/);
  const reads = statements.filter((statement) => !isFrame(statement));
  expect(reads).toHaveLength(1);
  const [read] = reads;
  expect(read?.text).toContain("from pending_uploads");
  expect(read?.text).toContain("finished_at is not null");
  expect(read?.text.includes("*")).toBe(false);
  expect(read?.parameters).toEqual([uploadId]);
  for (const statement of statements) {
    expect(statement.text.includes(uploadId), "the upload id is a parameter").toBe(false);
    for (const word of NEVER_NAMED[call] ?? []) {
      expect(statement.text.includes(word), word).toBe(false);
    }
  }
}

// ---- the tests ------------------------------------------------------------------------------------------------------

for (const call of ["readPendingUpload", "readUploadFinishedAt"]) {
  const own = ownOf(call);
  const accepted = own.filter((entry) => entry.expect === "accept").map((entry) => entry.file);

  describe(`${call}'s fixtures (K-05 ${call === "readPendingUpload" ? "v1.24 item 86" : "v1.25 item 94"})`, () => {
    it("the index lists the item's two exchanges and its one refused twin, each as its definition takes it", () => {
      expect(accepted).toHaveLength(2);
      expect(own.filter((entry) => entry.expect === "refuse")).toHaveLength(1);
      for (const entry of own) {
        const errors = schemaErrors(`${call}.exchange`, exchangeOf(entry.file));
        if (entry.expect === "accept") {
          expect(errors, entry.file).toEqual([]);
        } else {
          expect(errors, entry.file).not.toEqual([]);
        }
      }
    });

    for (const file of accepted) {
      it(
        `${file}: as rosie_job, the fixture's outcome, as one statement in one read-only transaction`,
        SLOW,
        async () => {
          const exchange = exchangeOf(file);
          await given(exchange.given.k04Seeds, NOTE_ROWS[file] ?? []);
          const run = await watched(call, exchange.request);
          expect(run.outcome).toEqual(exchange.outcome);
          expect(schemaErrors(`${call}.response`, run.outcome)).toEqual([]);
          expect(schemaErrors(`${call}.exchange`, { ...exchange, outcome: run.outcome })).toEqual([]);
          const { uploadId } = exchange.request;
          if (typeof uploadId !== "string") {
            throw new Error(`${file}: its request names no upload id`);
          }
          expectStatements(call, run.statements, uploadId);
          expect(run.logged).toBe(0);
        },
      );
    }
  });
}

describe("the refused twins: the object key only sealed, and never in item 94's answer", () => {
  it(
    "refuse-pending-upload-plain-object-key: the read answers read-pending-upload-sam-id's outcome, the key as its sealed bytes; put right, the twin is that outcome",
    SLOW,
    async () => {
      const twin = exchangeOf("read-pending-upload-sam-id.json");
      const refused = exchangeOf("invalid/refuse-pending-upload-plain-object-key.json");
      await given(twin.given.k04Seeds, [SAM_UPLOAD]);
      const outcome = await readPendingUpload(job, { uploadId: "upload-sam-id" });
      expect(outcome).toEqual(twin.outcome);
      expect(outcome).not.toEqual(refused.outcome);
      const upload = refused.outcome.upload as Row;
      expect({ ...refused.outcome, upload: { ...upload, objectKey: SAM_KEY } }).toEqual(twin.outcome);
      expect(refused.request).toEqual(twin.request);
    },
  );

  it(
    "refuse-upload-finished-object-key: the read answers read-upload-finished-demo-owner's outcome, no object key; put right, the twin is that outcome",
    SLOW,
    async () => {
      const twin = exchangeOf("read-upload-finished-demo-owner.json");
      const refused = exchangeOf("invalid/refuse-upload-finished-object-key.json");
      await given([], DEMO_ROWS);
      const outcome = await readUploadFinishedAt(job, { uploadId: "upload-demo-owner-1" });
      expect(outcome).toEqual(twin.outcome);
      expect(JSON.stringify(outcome).includes("objectKey")).toBe(false);
      expect(JSON.stringify(outcome).includes(DEMO_KEY.slice(2))).toBe(false);
      const { objectKey, ...rest } = refused.outcome;
      expect(objectKey).toBe(DEMO_KEY);
      expect(rest).toEqual(twin.outcome);
      expect(refused.request).toEqual(twin.request);
    },
  );
});

describe("both reads beyond the fixtures (README items 86 and 94; K-22 v1.4 rule 11)", () => {
  const RE_CHECK = upload("upload-t1573-sam-re-check", {
    businessId: BARBERSHOP,
    purpose: "re_check",
    contentType: "application/pdf",
    objectKey: "\\x7e3c00ff",
    createdAt: "2026-11-24T09:00:00Z",
    expiresAt: "2026-11-24T09:15:00Z",
    finishedAt: "2026-11-24T09:02:30Z",
  });
  const LAPSED_FINISHED = upload("upload-t1573-finished-then-lapsed", {
    createdAt: "2026-11-01T08:00:00Z",
    expiresAt: "2026-11-01T08:15:00Z",
    finishedAt: "2026-11-01T08:14:59Z",
  });

  const cases: {
    shows: string;
    rows: TableRow[];
    uploadId: string;
    pending: Row;
    finished: Row;
  }[] = [
    {
      shows:
        "an upload whose file never came (finished_at null) answers none to both, as an id with nothing kept",
      rows: [SAM_UPLOAD, UNFINISHED],
      uploadId: "upload-t1573-never-came",
      pending: { result: "none", uploadId: "upload-t1573-never-came" },
      finished: { result: "none", uploadId: "upload-t1573-never-came" },
    },
    {
      shows:
        "a re_check upload on Sam's page at the barbershop: its business, purpose, PDF type and sealed key; its time",
      rows: [SAM_UPLOAD, RE_CHECK],
      uploadId: "upload-t1573-sam-re-check",
      pending: {
        result: "pendingUpload",
        upload: {
          uploadId: "upload-t1573-sam-re-check",
          personId: SAM,
          businessId: BARBERSHOP,
          purpose: "re_check",
          contentType: "application/pdf",
          objectKey: "\\x7e3c00ff",
        },
      },
      finished: {
        result: "finished",
        uploadId: "upload-t1573-sam-re-check",
        finishedAt: "2026-11-24T09:02:30Z",
      },
    },
    {
      shows:
        "a finished upload whose signed address lapsed since is still answered: the lapse bounds the address, not the file",
      rows: [LAPSED_FINISHED],
      uploadId: "upload-t1573-finished-then-lapsed",
      pending: {
        result: "pendingUpload",
        upload: {
          uploadId: "upload-t1573-finished-then-lapsed",
          personId: SAM,
          businessId: null,
          purpose: "sign_up",
          contentType: "image/jpeg",
          objectKey: SAM_KEY,
        },
      },
      finished: {
        result: "finished",
        uploadId: "upload-t1573-finished-then-lapsed",
        finishedAt: "2026-11-01T08:14:59Z",
      },
    },
    {
      shows: "another upload's row is never answered for an id: none",
      rows: [SAM_UPLOAD, RE_CHECK],
      uploadId: "upload-sam-id-2",
      pending: { result: "none", uploadId: "upload-sam-id-2" },
      finished: { result: "none", uploadId: "upload-sam-id-2" },
    },
  ];

  for (const spec of cases) {
    it(spec.shows, SLOW, async () => {
      await given(["seed-person-roles.json"], spec.rows);
      for (const [call, want] of [
        ["readPendingUpload", spec.pending],
        ["readUploadFinishedAt", spec.finished],
      ] as const) {
        const run = await watched(call, { uploadId: spec.uploadId });
        expect(run.outcome, call).toEqual(want);
        expect(schemaErrors(`${call}.response`, run.outcome), call).toEqual([]);
        expectStatements(call, run.statements, spec.uploadId);
        expect(run.logged).toBe(0);
      }
    });
  }

  it(
    "the object key comes back as the stored bytes, byte for byte: the \\x form of the bytes the row holds",
    SLOW,
    async () => {
      await given(["seed-person-roles.json"], [RE_CHECK]);
      const outcome = (await readPendingUpload(job, { uploadId: "upload-t1573-sam-re-check" })) as {
        upload: { objectKey: string };
      };
      const [stored] = await db.sql<{ key: Uint8Array }[]>`
        select object_key as key from pending_uploads where id = 'upload-t1573-sam-re-check'
      `;
      expect(fromHex(outcome.upload.objectKey.slice(2))).toEqual(new Uint8Array(stored?.key ?? []));
    },
  );

  const broken: { shows: string; row: TableRow; message: string }[] = [
    {
      shows: "a finished row whose media type is outside K-05's form (no CHECK holds it on pending_uploads)",
      row: upload("upload-t1573-broken-type", {
        contentType: "text/plain",
        createdAt: "2026-11-24T11:00:00Z",
        expiresAt: "2026-11-24T11:15:00Z",
        finishedAt: "2026-11-24T11:01:00Z",
      }),
      message: "readPendingUpload: a pending upload's media type is outside K-05's form",
    },
    {
      shows: "a finished row whose sealed object key holds no bytes",
      row: upload("upload-t1573-broken-type", {
        objectKey: "\\x",
        createdAt: "2026-11-24T11:00:00Z",
        expiresAt: "2026-11-24T11:15:00Z",
        finishedAt: "2026-11-24T11:01:00Z",
      }),
      message: "readPendingUpload: a pending upload's sealed object key holds no bytes",
    },
  ];

  for (const spec of broken) {
    it(
      `${spec.shows}: readPendingUpload throws BrokenRecordError naming no value and rolls back (default 2); item 94 still answers the time`,
      SLOW,
      async () => {
        await given(["seed-person-roles.json"], [spec.row]);
        const run = await watched("readPendingUpload", { uploadId: "upload-t1573-broken-type" });
        expect(run.outcome).toBeInstanceOf(BrokenRecordError);
        expect((run.outcome as Error).message).toBe(spec.message);
        expect((run.outcome as Error).message.includes("upload-t1573")).toBe(false);
        expect(run.statements.at(-1)?.text.trim()).toBe("rollback");
        expect(run.logged).toBe(0);
        expect(await readUploadFinishedAt(job, { uploadId: "upload-t1573-broken-type" })).toEqual({
          result: "finished",
          uploadId: "upload-t1573-broken-type",
          finishedAt: "2026-11-24T11:01:00Z",
        });
      },
    );
  }

  it("a request of the wrong shape is refused before any statement, naming the field, never a value", async () => {
    for (const call of ["readPendingUpload", "readUploadFinishedAt"]) {
      const refused: [unknown, string][] = [
        [null, `${call}: the request is an object`],
        [[], `${call}: the request is an object`],
        [{}, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: "" }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: 7 }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: "upload-\u0000sam" }, `${call}: uploadId is an upload id, a non-empty text`],
        [{ uploadId: "upload-sam-id", personId: SAM }, `${call}: the request takes only uploadId`],
      ];
      for (const [request, message] of refused) {
        const run = await watched(call, request);
        expect(run.outcome, message).toBeInstanceOf(TypeError);
        expect((run.outcome as Error).message).toBe(message);
        expect(run.statements).toEqual([]);
      }
    }
  });
});

describe("the side the reads run on (README items 86 and 94, default 226; K-22 v1.4 rule 11)", () => {
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
    "the Tool API's role is refused by PostgreSQL's privilege check (no grant on pending_uploads), scrubbed, naming no upload, person or key",
    SLOW,
    async () => {
      await given(["seed-person-roles.json"], [SAM_UPLOAD]);
      for (const call of ["readPendingUpload", "readUploadFinishedAt"]) {
        let error: unknown = null;
        try {
          await readOf(call)(app, { uploadId: "upload-sam-id" });
        } catch (thrown) {
          error = thrown;
        }
        expect(error, call).toBeInstanceOf(DataAccessDatabaseError);
        expect((error as DataAccessDatabaseError).code, call).toBe("42501");
        const text = `${(error as Error).message} ${JSON.stringify(error)}`;
        for (const value of [SAM, "upload-sam-id", SAM_KEY.slice(2)]) {
          expect(text.includes(value), `${call} ${value}`).toBe(false);
        }
      }
    },
  );

  it(
    "a business scope a connection kept is emptied for the read's transaction: Sam's sign_up upload, which has no business, through a connection scoped to the barbershop",
    SLOW,
    async () => {
      await given(["seed-person-roles.json"], [SAM_UPLOAD]);
      const scoped = roleClient("rosie_job", "rosie-t1573-uploads-scoped", false);
      try {
        await scoped`select set_config('rosie.business_id', ${BARBERSHOP}, false)`;
        const [seen] = await scoped<{ n: number }[]>`select count(*)::int as n from pending_uploads`;
        expect(seen?.n).toBe(0);
        expect(await readPendingUpload(scoped, { uploadId: "upload-sam-id" })).toEqual(
          exchangeOf("read-pending-upload-sam-id.json").outcome,
        );
        expect(await readUploadFinishedAt(scoped, { uploadId: "upload-sam-id" })).toEqual({
          result: "finished",
          uploadId: "upload-sam-id",
          finishedAt: "2026-11-23T15:02:10Z",
        });
      } finally {
        await scoped.end({ timeout: 5 });
      }
    },
  );

  it(
    "the reads write nothing: the table's rows are as given after both, and each transaction is read only",
    SLOW,
    async () => {
      await given(["seed-person-roles.json"], [SAM_UPLOAD, UNFINISHED]);
      const before = await db.sql`select * from pending_uploads order by id`;
      await readPendingUpload(job, { uploadId: "upload-sam-id" });
      await readUploadFinishedAt(job, { uploadId: "upload-t1573-never-came" });
      const after = await db.sql`select * from pending_uploads order by id`;
      expect([...after]).toEqual([...before]);
    },
  );
});
