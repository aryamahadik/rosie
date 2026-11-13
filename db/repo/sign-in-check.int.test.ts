// T-1284: K-05 v1.13's proveSignIn, endSession, personStanding and signInEntries (items 60 to 63; ADR-016 card R2;
// DL-526, DL-610), with scope.ts's person setter, against local PostgreSQL (`npm run db:up`; `npm run test:integration
// -- db/repo/sign-in-check`). The schema comes from migrating a fresh test schema (db/repo/test-db.ts), which is
// dropped when the file ends; the public schema is never touched. It is made in a pool database of its own
// (`database: "own"`): the file holds an attempt's row lock while a check waits on it and reads pg_stat_activity for
// that wait, and its migration's CREATE INDEX CONCURRENTLY (0033) waits out every older transaction of its database,
// so no other run's long transaction in the shared database holds it up, and none of this file's holds up another's.
//
// The calls run as K-05 v1.13 names them (README "The calls v1.13 adds or changes"): proveSignIn and endSession through
// a client whose connections run as rosie_app, the Tool API's role, and personStanding and signInEntries through one
// that runs as rosie_job, the runtime side's; the role is the connection's, so the grants, the policies and K-22's
// functions are the ones the calls meet. Both clients record every statement they send (postgres.js debug: its
// connection, text and parameters, kept in memory and never printed), so the checks read what the calls sent. The
// tables' owner (the migrations' role) loads K-22's seed-sign-in-attempt.json with its chain (Sam's account, his
// proven email handle, his sessions from his laptop's device and his four live owner roles) and K-04's
// seed-bundle-registry.json, as the v1.13 fixtures' `given` names them, and writes each case's attempt and code with
// times from the database's own clock, since the calls take every time from it (README default 112): an attempt the
// send side would have written (startSignIn), and the code and the attempt's code id sendSignInCode would have
// written, as their fixtures' notes list them. Every answer is checked against its data-access v1.13 definition, and
// every entry against event-trace v1.2's eventLogRow, with Ajv 2020-12, strict, as contracts:check runs it.
//
// Names are the master's sample cast as the seeds hold them (rule 9); the attempts, codes, sessions and people a case
// adds carry example ids (t1284), no name and example.com addresses; every hash is a stand-in, the sha256 of a label,
// of no real device, code or token.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERSON_SETTING, setPersonScope, type Sql, type Tx } from "./scope";
import {
  endSession,
  type EndSessionRequest,
  personStanding,
  type PersonStandingRequest,
  proveSignIn,
  type ProveSignInOutcome,
  type ProveSignInRequest,
  signInEntries,
  type SignInEntriesRequest,
} from "./sign-in-check";
import { createTestDatabase, type TestDatabase } from "./test-db";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;
type Call = "proveSignIn" | "endSession" | "personStanding" | "signInEntries";

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const SCHEMA_DIR = new URL("db-schema/", CONTRACTS);
const APP_ROLE = "rosie_app";
const JOB_ROLE = "rosie_job";
const APP_NAME = "rosie-t1284-app";
const JOB_NAME = "rosie-t1284-job";
const SLOW = { timeout: 60_000 };

const SAM = "person-sam";
const SAM_EMAIL_HANDLE = "handle-sam-email";
/** Sam's laptop: the device his sessions of Oct 20 and Oct 26 came from (K-22 seed-session.json). */
const SAM_DEVICE = "e28c360bbd60fac9cabe9778c941ca8e14aaca204d780bfd44982220825ea15c";
const TESTER = "person-t1284-tester";
const TESTER_HANDLE = "handle-t1284-tester-email";
const KEY_NAME = "PROOF_CODE_HASH_KEY";
/** The columns that hold a hash, which no statement may return (README v1.13, "What the new tasks must hold to"). */
const HASH_COLUMNS = [
  "token_sha256",
  "device_sha256",
  "code_hash",
  "contact_hash",
  "request_sha256",
  "last_check_sha256",
];

/** A stand-in hash: the sha256 of a label, of no real device, code or token. */
const hex = (label: string): string => createHash("sha256").update(label, "utf8").digest("hex");
/** K-22 rule 9's last_check_sha256: sha256 of the attempt's id, the device's sha256 and requestId, a line feed between. */
const checkKey = (id: string, device: string, requestId: string): string =>
  createHash("sha256").update(`${id}\n${device}\n${requestId}`, "utf8").digest("hex");
const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));

// ---- the contracts' own schemas (Ajv 2020-12, strict, as contracts:check runs it) --------------------------------------

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
const idOf = (path: string): string => (readJson(new URL(path, CONTRACTS)) as { $id: string }).$id;
const K05_V113 = idOf("data-access/data-access.v1.13.schema.json");
const K08_V12 = idOf("event-trace/event-trace.v1.2.schema.json");

function schemaErrors(schemaId: string, def: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${schemaId}#/$defs/${def}`);
  if (validate === undefined) {
    throw new Error(`${schemaId} has no $defs/${def}`);
  }
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** An answer checked against its own v1.13 definition: an error against <call>.errors, else <call>.response. */
function expectValid(call: Call, outcome: unknown): void {
  const isError = typeof outcome === "object" && outcome !== null && "error" in outcome;
  expect(schemaErrors(K05_V113, isError ? `${call}.errors` : `${call}.response`, outcome)).toEqual([]);
}

/** Every string in a value, nested or not. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

/** No hash leaves a call: no value of the answer reads as a sha256 in hex. */
function expectNoHash(value: unknown): void {
  expect(stringsIn(value).filter((text) => /^[0-9a-fA-F]{64}$/.test(text))).toEqual([]);
}

// ---- databases and clients ------------------------------------------------------------------------------------------

/** One statement a role client sent: its client, connection, text and parameters (in memory only, never printed). */
interface Sent {
  client: string;
  connection: number;
  text: string;
  parameters: readonly unknown[];
}

let db: TestDatabase;
/** The Tool API's side: connections that run as rosie_app, this file's schema first; every statement recorded. */
let app: Sql;
/** The runtime side: connections that run as rosie_job, this file's schema first; every statement recorded. */
let job: Sql;
let typedColumns: Map<string, string>;
const sent: Sent[] = [];

function roleClient(role: string, name: string, max: number): Sql {
  return db.connect({
    max,
    onnotice: () => undefined,
    debug: (connection: number, text: string, parameters: unknown[]) => {
      sent.push({ client: name, connection, text, parameters: [...parameters] });
    },
    connection: { application_name: name, search_path: `${db.schema}, public`, role },
  });
}

/** The statements one client sent since `from`. */
const sentSince = (from: number, client: string): Sent[] =>
  sent.slice(from).filter((one) => one.client === client);

/** What a promise was rejected with, or null when it was not. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** A gate one side opens and the other waits on. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

// ---- seeds ------------------------------------------------------------------------------------------------------------

interface TableRow {
  table: string;
  values: Row;
}

interface SeedFile {
  after: string[];
  rows: TableRow[];
}

const fromHex = (text: string): Uint8Array =>
  Uint8Array.from((text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/**
 * A seed row as the owner, its jsonb and bytea values as K-04's fixture format writes them; with `shiftMs`, every
 * timestamptz value moved that far, so a fixture's world keeps its own times relative to the database's clock.
 */
async function insertRow(sql: Db, table: string, row: Row, shiftMs = 0): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    } else if (type === "timestamp with time zone" && typeof value === "string") {
      converted = new Date(Date.parse(value) + shiftMs);
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

/** A seed's rows after those of the seeds its `after` names, each read from the seed's own folder; each seed once. */
function seedRows(seed: URL, seen: Set<string>): TableRow[] {
  if (seen.has(seed.href)) {
    return [];
  }
  seen.add(seed.href);
  const file = readJson(seed) as SeedFile;
  return [...file.after.flatMap((before) => seedRows(new URL(before, seed), seen)), ...file.rows];
}

/** The tester person this file adds: no name, no role, an email handle at example.com. */
const TESTER_ROWS: TableRow[] = [
  { table: "persons", values: { id: TESTER, name: null, language: null, version: 1 } },
  { table: "handles", values: { id: TESTER_HANDLE, kind: "email", address: "tester-t1284@example.com" } },
  { table: "person_handles", values: { person_id: TESTER, handle_id: TESTER_HANDLE } },
];

/** Staging's check tester (K-05 v1.12 default 105), as person-standing-check-tester's note lists its rows. */
const CHECK_TESTER_ROWS: TableRow[] = [
  { table: "persons", values: { id: "person-check-tester", name: null, language: null, version: 1 } },
  {
    table: "handles",
    values: { id: "handle-check-tester-email", kind: "email", address: "check-tester@example.com" },
  },
  {
    table: "person_handles",
    values: { person_id: "person-check-tester", handle_id: "handle-check-tester-email" },
  },
  {
    table: "team_page_recipients",
    values: {
      id: "team-check-tester",
      person_id: "person-check-tester",
      chat_handle_id: null,
      email_handle_id: "handle-check-tester-email",
      added_at: "2026-11-12T04:00:00Z",
      removed_at: null,
      version: 1,
    },
  },
  {
    table: "proof_codes",
    values: {
      id: "code-check-tester-seed",
      purpose: "sign_in",
      person_id: "person-check-tester",
      business_id: null,
      sent_to_handle_id: "handle-check-tester-email",
      channel: "email",
      code_hash: hex("t1284 the check tester's code, no code"),
      hash_key_name: KEY_NAME,
      sent_at: "2026-11-12T04:00:00Z",
      expires_at: "2026-11-12T04:10:00Z",
      wrong_tries: 0,
      used_at: "2026-11-12T04:00:00Z",
      version: 2,
    },
  },
  {
    table: "sessions",
    values: {
      id: "session-check-tester",
      person_id: "person-check-tester",
      token_sha256: hex("t1284 the check tester's token, no token"),
      device_sha256: null,
      proven_via: "code",
      proof_code_id: "code-check-tester-seed",
      started_at: "2026-11-12T04:00:00Z",
      last_seen_at: "2026-11-12T04:00:00Z",
      expires_at: "2026-12-12T04:00:00Z",
      ended_at: null,
      ended_why: null,
      version: 1,
    },
  },
];

beforeAll(async () => {
  db = await createTestDatabase({ name: "sign_in_check", database: "own" });
  app = roleClient(APP_ROLE, APP_NAME, 4);
  job = roleClient(JOB_ROLE, JOB_NAME, 3);
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea', 'timestamp with time zone')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
  const seen = new Set<string>();
  const rows = [
    ...seedRows(new URL("core/fixtures/seed-bundle-registry.json", SCHEMA_DIR), seen),
    ...seedRows(new URL("people-access/fixtures/seed-sign-in-attempt.json", SCHEMA_DIR), seen),
    ...TESTER_ROWS,
    ...CHECK_TESTER_ROWS,
  ];
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
}, 120_000);

afterAll(async () => {
  await app.end({ timeout: 5 });
  await job.end({ timeout: 5 });
  await db.drop();
});

// ---- the rows the send side would have written (as startSignIn's and sendSignInCode's fixtures list them) ----------

interface AttemptSpec {
  /** The attempt's K-22 id; the page's attempt id is `attempt-<id>`. */
  id: string;
  person: string | null;
  ownerOrAdmin?: boolean;
  device?: string;
  /** How long before the database's now() it started (default 20 s). */
  startedSecondsAgo?: number;
  code?: { id: string; sentSecondsAgo?: number; handle?: string };
}

interface Attempt {
  id: string;
  attemptId: string;
  device: string;
  /** The code's keyed hash, the right typed hash; a stand-in. */
  rightHash: string;
  codeId: string | null;
}

/** The code sendSignInCode writes and the attempt's code id, in one transaction, sent_at by the database's clock. */
async function writeCode(
  attempt: string,
  person: string,
  code: string,
  sentAgo: number,
  handle: string,
): Promise<void> {
  await db.sql.begin(async (tx) => {
    await tx`
      insert into proof_codes (
        id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at, expires_at
      ) values (
        ${code}, 'sign_in', ${person}, null, ${handle}, 'email', ${hex(`code ${code}`)}, ${KEY_NAME},
        now() - ${sentAgo}::integer * interval '1 second',
        now() - ${sentAgo}::integer * interval '1 second' + interval '10 minutes'
      )
    `;
    await tx`update sign_in_attempts set proof_code_id = ${code}, version = version + 1 where id = ${attempt}`;
  });
}

/** An attempt as startSignIn writes it, started by the database's clock, and its code when the spec names one. */
async function writeAttempt(spec: AttemptSpec): Promise<Attempt> {
  const device = spec.device ?? hex(`device ${spec.id}`);
  const ago = spec.startedSecondsAgo ?? 20;
  await db.sql`
    insert into sign_in_attempts (
      id, attempt_id, request_sha256, device_sha256, contact_hash, hash_key_name, way, person_id, owner_or_admin,
      started_at, expires_at
    ) values (
      ${spec.id}, ${`attempt-${spec.id}`}, ${hex(`request ${spec.id}`)}, ${device}, ${hex(`contact ${spec.id}`)},
      ${KEY_NAME}, 'email', ${spec.person}, ${spec.ownerOrAdmin ?? false},
      now() - ${ago}::integer * interval '1 second',
      now() - ${ago}::integer * interval '1 second' + interval '10 minutes'
    )
  `;
  const code = spec.code;
  if (code !== undefined && spec.person !== null) {
    await writeCode(
      spec.id,
      spec.person,
      code.id,
      code.sentSecondsAgo ?? ago - 1,
      code.handle ?? SAM_EMAIL_HANDLE,
    );
  }
  return {
    id: spec.id,
    attemptId: `attempt-${spec.id}`,
    device,
    rightHash: code === undefined ? hex("no code") : hex(`code ${code.id}`),
    codeId: code?.id ?? null,
  };
}

/** A check of the attempt from its own device, with a typed hash and a fresh session for a right code. */
function checkOf(attempt: Attempt, requestId: string, typedHash: string): ProveSignInRequest {
  return {
    attemptId: attempt.attemptId,
    deviceSha256: attempt.device,
    requestId,
    typedHash,
    session: { id: `session-${requestId}`, tokenSha256: hex(`token ${requestId}`) },
  };
}

const wrongHash = (label: string): string => hex(`a wrong code ${label}`);

interface AttemptState {
  wrong_tries: number;
  last_wrong_at: Date | null;
  paused_until: Date | null;
  last_outcome: string | null;
  last_check_sha256: string | null;
  session_id: string | null;
  proof_code_id: string | null;
  version: number;
}

async function attemptState(id: string): Promise<AttemptState> {
  const [row] = await db.sql<AttemptState[]>`
    select wrong_tries, last_wrong_at, paused_until, last_outcome, last_check_sha256, session_id, proof_code_id, version
    from sign_in_attempts where id = ${id}
  `;
  if (row === undefined) {
    throw new Error(`no attempt ${id}`);
  }
  return row;
}

interface CodeState {
  wrong_tries: number;
  paused_until: Date | null;
  used_at: Date | null;
  sent_at: Date;
}

async function codeState(id: string): Promise<CodeState> {
  const [row] = await db.sql<CodeState[]>`
    select wrong_tries, paused_until, used_at, sent_at from proof_codes where id = ${id}
  `;
  if (row === undefined) {
    throw new Error(`no code ${id}`);
  }
  return row;
}

async function sessionsOfCode(code: string): Promise<{ id: string; token_sha256: string }[]> {
  const rows = await db.sql<{ id: string; token_sha256: string }[]>`
    select id, token_sha256 from sessions where proof_code_id = ${code} order by id
  `;
  return [...rows];
}

/** The database's clock now, outside any transaction, to bound a call's own transaction time. */
async function dbClock(): Promise<Date> {
  const [row] = await db.sql<{ at: Date }[]>`select clock_timestamp() as at`;
  if (row === undefined) {
    throw new Error("no clock");
  }
  return row.at;
}

/** A check through proveSignIn, its answer checked against v1.13 and for hashes, with the database clock around it. */
async function check(
  request: ProveSignInRequest,
): Promise<{ outcome: ProveSignInOutcome; before: Date; after: Date }> {
  const before = await dbClock();
  const outcome = await proveSignIn(app, request);
  const after = await dbClock();
  expectValid("proveSignIn", outcome);
  expectNoHash(outcome);
  return { outcome, before, after };
}

/** One field of an answer, whatever its outcome. */
const fieldOf = (outcome: unknown, field: string): Json | undefined =>
  outcome === undefined ? undefined : (outcome as Row)[field];

/** The parts of a check's answer the page sees (K-21 signInCheck): its label, tries left, pause and repeat flag. */
function pageParts(outcome: ProveSignInOutcome): Row {
  const parts: Row = {};
  for (const field of ["outcome", "error", "triesLeft", "repeated"]) {
    const value = (outcome as unknown as Row)[field];
    if (value !== undefined) {
      parts[field] = value;
    }
  }
  return parts;
}

/**
 * What each statement that sets rosie.person_id sets it to, in order: '' for the transaction's opening, which sets
 * it empty in its text, and the person scope.ts's setter binds as its second parameter.
 */
function personSettings(statements: readonly Sent[]): unknown[] {
  return statements
    .filter((one) => one.text.includes("set_config") && one.parameters.includes(PERSON_SETTING))
    .map((one) => (one.parameters[0] === PERSON_SETTING ? one.parameters[1] : ""));
}

const namesSessions = (statements: readonly Sent[]): string[] =>
  statements.map((one) => one.text).filter((text) => /\bsessions\b|device_known/.test(text));

// ---- the cases ------------------------------------------------------------------------------------------------------

describe("proveSignIn: a right code", () => {
  it("starts one session for the attempt's person, and a second is refused (23505)", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-right",
      person: SAM,
      ownerOrAdmin: true,
      device: SAM_DEVICE,
      code: { id: "code-t1284-right" },
    });
    const from = sent.length;
    const first = await check(checkOf(attempt, "req-t1284-right-1", attempt.rightHash));
    expect(first.outcome).toMatchObject({
      outcome: "signedIn",
      signInAttemptId: attempt.id,
      personId: SAM,
      sessionId: "session-req-t1284-right-1",
      proofCodeId: "code-t1284-right",
      repeated: false,
    });
    // The person was set once, for this transaction, after the code was right; the transaction stated READ COMMITTED.
    const statements = sentSince(from, APP_NAME);
    expect(personSettings(statements)).toEqual(["", SAM]);
    expect(statements.some((one) => /^begin isolation level read committed$/i.test(one.text.trim()))).toBe(
      true,
    );

    const sessions = await sessionsOfCode("code-t1284-right");
    expect(sessions.map((one) => one.id)).toEqual(["session-req-t1284-right-1"]);
    expect(sessions[0]?.token_sha256).toBe(hex("token req-t1284-right-1"));
    const [stored] = await db.sql<
      { person_id: string; device_sha256: string; proven_via: string; thirty_days: boolean; same: boolean }[]
    >`
      select person_id, device_sha256, proven_via, expires_at = started_at + interval '30 days' as thirty_days,
             started_at = last_seen_at as same
      from sessions where id = 'session-req-t1284-right-1'
    `;
    expect(stored).toEqual({
      person_id: SAM,
      device_sha256: SAM_DEVICE,
      proven_via: "code",
      thirty_days: true,
      same: true,
    });
    expect((await codeState("code-t1284-right")).used_at).not.toBeNull();
    const state = await attemptState(attempt.id);
    expect(state).toMatchObject({
      session_id: "session-req-t1284-right-1",
      last_outcome: "signedIn",
      wrong_tries: 0,
    });
    expect(state.last_check_sha256).toBe(checkKey(attempt.id, SAM_DEVICE, "req-t1284-right-1"));
    // Its end is 30 days after the check's own transaction time, by the database's clock.
    const expiresAt = Date.parse(fieldOf(first.outcome, "sessionExpiresAt") as string);
    const days = 30 * 86_400_000;
    expect(expiresAt).toBeGreaterThanOrEqual(first.before.getTime() + days - 1);
    expect(expiresAt).toBeLessThanOrEqual(first.after.getTime() + days);

    // The same check sent again (the attempt's last check) answers its first result as alreadySignedIn, repeated, with
    // no token; a later check with a new request answers alreadySignedIn, recorded; neither starts a second session.
    const repeat = await check(checkOf(attempt, "req-t1284-right-1", attempt.rightHash));
    expect(repeat.outcome).toEqual({
      outcome: "alreadySignedIn",
      signInAttemptId: attempt.id,
      repeated: true,
    });
    const again = await check(checkOf(attempt, "req-t1284-right-2", attempt.rightHash));
    expect(again.outcome).toEqual({
      outcome: "alreadySignedIn",
      signInAttemptId: attempt.id,
      repeated: false,
    });
    expect(await attemptState(attempt.id)).toMatchObject({ last_outcome: "alreadySignedIn", wrong_tries: 0 });
    expect((await sessionsOfCode("code-t1284-right")).length).toBe(1);

    // A second session naming the same used code, even in the person's own transaction, is refused (23505).
    const refused = await thrownBy(
      app.begin(async (tx) => {
        await setPersonScope(tx, SAM);
        await tx`
          insert into sessions (
            id, person_id, token_sha256, device_sha256, proven_via, proof_code_id, started_at, last_seen_at, expires_at
          ) values (
            'session-t1284-second', ${SAM}, ${hex("token t1284 second")}, ${SAM_DEVICE}, 'code', 'code-t1284-right',
            now(), now(), now() + interval '30 days'
          )
        `;
      }),
    );
    expect(refused).toMatchObject({ code: "23505", constraint_name: "sessions_proof_code_key" });
    expect((await sessionsOfCode("code-t1284-right")).length).toBe(1);
  });

  it(
    "answers constraint when the session's id or token hash is taken, and writes nothing",
    SLOW,
    async () => {
      const attempt = await writeAttempt({
        id: "t1284-taken",
        person: SAM,
        ownerOrAdmin: true,
        device: SAM_DEVICE,
        code: { id: "code-t1284-taken" },
      });
      const before = await attemptState(attempt.id);
      // The id of the session the right code of the first case started.
      const takenId = { ...checkOf(attempt, "req-t1284-taken-1", attempt.rightHash) };
      takenId.session = { id: "session-req-t1284-right-1", tokenSha256: hex("token t1284 taken 1") };
      const byId = await check(takenId);
      expect(byId.outcome).toEqual({ error: "constraint", sqlstate: "23505", constraint: "sessions_pkey" });
      // Its token hash.
      const takenToken = { ...checkOf(attempt, "req-t1284-taken-2", attempt.rightHash) };
      takenToken.session = { id: "session-t1284-taken-2", tokenSha256: hex("token req-t1284-right-1") };
      const byToken = await check(takenToken);
      expect(byToken.outcome).toEqual({
        error: "constraint",
        sqlstate: "23505",
        constraint: "sessions_token_key",
      });
      // Nothing was written: the code is unused, the attempt as it was, no session names the code.
      expect((await codeState("code-t1284-taken")).used_at).toBeNull();
      expect(await attemptState(attempt.id)).toEqual(before);
      expect(await sessionsOfCode("code-t1284-taken")).toEqual([]);
      // With a session of its own the same code signs in.
      const fresh = await check(checkOf(attempt, "req-t1284-taken-3", attempt.rightHash));
      expect(fresh.outcome).toMatchObject({ outcome: "signedIn", sessionId: "session-req-t1284-taken-3" });
    },
  );

  it("asks a second proof of an owner on a new device, recorded, with no session", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-second",
      person: SAM,
      ownerOrAdmin: true,
      device: hex("t1284 a browser none of Sam's sessions used"),
      code: { id: "code-t1284-second" },
    });
    const first = await check(checkOf(attempt, "req-t1284-second-1", attempt.rightHash));
    expect(first.outcome).toEqual({
      outcome: "secondProofNeeded",
      signInAttemptId: attempt.id,
      personId: SAM,
      proofCodeId: "code-t1284-second",
      repeated: false,
    });
    expect((await codeState("code-t1284-second")).used_at).not.toBeNull();
    expect(await sessionsOfCode("code-t1284-second")).toEqual([]);
    expect(await attemptState(attempt.id)).toMatchObject({
      last_outcome: "secondProofNeeded",
      session_id: null,
    });
    // Its code is used now: a new check answers secondProofNeeded again, recorded; that check sent again, repeated.
    const used = await check(checkOf(attempt, "req-t1284-second-2", attempt.rightHash));
    expect(used.outcome).toMatchObject({ outcome: "secondProofNeeded", repeated: false });
    const repeat = await check(checkOf(attempt, "req-t1284-second-2", attempt.rightHash));
    expect(repeat.outcome).toMatchObject({ outcome: "secondProofNeeded", personId: SAM, repeated: true });
    expect(await sessionsOfCode("code-t1284-second")).toEqual([]);
  });

  it("starts a tester's first session on the code alone, on a device never seen", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-tester",
      person: TESTER,
      code: { id: "code-t1284-tester", handle: TESTER_HANDLE },
    });
    const first = await check(checkOf(attempt, "req-t1284-tester-1", attempt.rightHash));
    expect(first.outcome).toMatchObject({
      outcome: "signedIn",
      personId: TESTER,
      proofCodeId: "code-t1284-tester",
    });
  });
});

describe("proveSignIn: codes that are not right, with and without an account", () => {
  it(
    "counts five wrong checks alike with a code and with none, and the sixth answers paused",
    SLOW,
    async () => {
      const withCode = await writeAttempt({
        id: "t1284-five-code",
        person: SAM,
        ownerOrAdmin: true,
        code: { id: "code-t1284-five" },
      });
      const noAccount = await writeAttempt({ id: "t1284-five-none", person: null });
      const answers: { code: ProveSignInOutcome; none: ProveSignInOutcome }[] = [];
      for (let try_ = 1; try_ <= 5; try_ += 1) {
        const withIt = await check(
          checkOf(withCode, `req-t1284-five-code-${String(try_)}`, wrongHash(String(try_))),
        );
        const without = await check(
          checkOf(noAccount, `req-t1284-five-none-${String(try_)}`, wrongHash(String(try_))),
        );
        answers.push({ code: withIt.outcome, none: without.outcome });
        for (const [attempt, done] of [
          [withCode, withIt],
          [noAccount, without],
        ] as const) {
          // Each try is the check's own transaction time, by the database's clock.
          const state = await attemptState(attempt.id);
          expect(state.wrong_tries).toBe(try_);
          expect(state.last_wrong_at?.getTime()).toBeGreaterThanOrEqual(done.before.getTime() - 1);
          expect(state.last_wrong_at?.getTime()).toBeLessThanOrEqual(done.after.getTime());
        }
      }
      // The same answers on both paths: wrong with 4, 3, 2 and 1 tries left, then paused.
      expect(answers.map((pair) => pageParts(pair.code))).toEqual(
        answers.map((pair) => pageParts(pair.none)),
      );
      expect(answers.map((pair) => pageParts(pair.code))).toEqual([
        { outcome: "wrong", triesLeft: 4, repeated: false },
        { outcome: "wrong", triesLeft: 3, repeated: false },
        { outcome: "wrong", triesLeft: 2, repeated: false },
        { outcome: "wrong", triesLeft: 1, repeated: false },
        { outcome: "paused", repeated: false },
      ]);
      expect(answers[0]?.code).toMatchObject({ proofCodeId: "code-t1284-five" });
      expect(answers[0]?.none).toMatchObject({ proofCodeId: null });
      // Equal attempts: five tries, paused 15 minutes after the fifth, the last answer paused, and the pause answered.
      const coded = await attemptState(withCode.id);
      const bare = await attemptState(noAccount.id);
      for (const [state, answer] of [
        [coded, answers[4]?.code],
        [bare, answers[4]?.none],
      ] as const) {
        expect(state).toMatchObject({ wrong_tries: 5, last_outcome: "paused" });
        expect((state.paused_until?.getTime() ?? 0) - (state.last_wrong_at?.getTime() ?? 0)).toBe(
          15 * 60_000,
        );
        expect(answer).toMatchObject({
          outcome: "paused",
          until: state.paused_until?.toISOString().replace(".000Z", "Z"),
        });
      }
      // The code counted its own five (check_proof_code) and is paused too; it was never used.
      expect(await codeState("code-t1284-five")).toMatchObject({ wrong_tries: 5, used_at: null });

      // The sixth check, a new request (no cookie, a new browser's request id), answers paused on both, counting nothing,
      // even with the right code: the code is never reached.
      const sixth = await check(checkOf(withCode, "req-t1284-five-code-6", withCode.rightHash));
      const sixthNone = await check(checkOf(noAccount, "req-t1284-five-none-6", wrongHash("6")));
      expect(pageParts(sixth.outcome)).toEqual({ outcome: "paused", repeated: false });
      expect(pageParts(sixthNone.outcome)).toEqual(pageParts(sixth.outcome));
      const fifth = answers[4];
      expect(fieldOf(sixth.outcome, "until")).toBe(fieldOf(fifth?.code, "until"));
      expect(fieldOf(sixthNone.outcome, "until")).toBe(fieldOf(fifth?.none, "until"));
      expect(await attemptState(withCode.id)).toMatchObject({ wrong_tries: 5, last_outcome: "paused" });
      expect(await attemptState(noAccount.id)).toMatchObject({ wrong_tries: 5, last_outcome: "paused" });
      expect(await codeState("code-t1284-five")).toMatchObject({ wrong_tries: 5, used_at: null });
      expect(await sessionsOfCode("code-t1284-five")).toEqual([]);
    },
  );

  it(
    "answers expired past the attempt's 10 minutes, recorded with no try, the code unused",
    SLOW,
    async () => {
      const attempt = await writeAttempt({
        id: "t1284-late",
        person: SAM,
        ownerOrAdmin: true,
        device: SAM_DEVICE,
        startedSecondsAgo: 601,
        code: { id: "code-t1284-late", sentSecondsAgo: 600 },
      });
      const late = await check(checkOf(attempt, "req-t1284-late-1", attempt.rightHash));
      expect(late.outcome).toEqual({
        outcome: "expired",
        signInAttemptId: attempt.id,
        proofCodeId: "code-t1284-late",
        repeated: false,
      });
      expect(await attemptState(attempt.id)).toMatchObject({ wrong_tries: 0, last_outcome: "expired" });
      expect(await codeState("code-t1284-late")).toMatchObject({ wrong_tries: 0, used_at: null });
    },
  );

  it(
    "answers attemptNotFound alone for an unknown attempt and for another device, writing nothing",
    SLOW,
    async () => {
      const attempt = await writeAttempt({
        id: "t1284-other-device",
        person: SAM,
        ownerOrAdmin: true,
        device: SAM_DEVICE,
        code: { id: "code-t1284-other-device" },
      });
      const before = await attemptState(attempt.id);
      const other = {
        ...checkOf(attempt, "req-t1284-other-1", attempt.rightHash),
        deviceSha256: hex("t1284 other"),
      };
      expect((await check(other)).outcome).toEqual({ error: "attemptNotFound" });
      const unknown = {
        ...checkOf(attempt, "req-t1284-other-2", attempt.rightHash),
        attemptId: "attempt-t1284-none",
      };
      expect((await check(unknown)).outcome).toEqual({ error: "attemptNotFound" });
      expect(await attemptState(attempt.id)).toEqual(before);
      expect(await codeState("code-t1284-other-device")).toMatchObject({ wrong_tries: 0, used_at: null });
    },
  );

  it("counts a wrong try when the call then fails, and a repeat of it counts nothing", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-fails-after",
      person: SAM,
      ownerOrAdmin: true,
      code: { id: "code-t1284-fails-after" },
    });
    const wrong = await check(checkOf(attempt, "req-t1284-fails-1", wrongHash("fails")));
    expect(wrong.outcome).toMatchObject({ outcome: "wrong", triesLeft: 4 });
    // What follows the check fails: its entries on a client whose connection is gone (transient), and entries naming a
    // session that does not exist (notFound, nothing written).
    const gone = roleClient(JOB_ROLE, `${JOB_NAME}-gone`, 1);
    await gone.end({ timeout: 5 });
    const entries: SignInEntriesRequest = {
      jobId: attempt.id,
      traceId: "trace-t1284-fails",
      entries: [{ kind: "proof_code.checked", proofCodeId: "code-t1284-fails-after" }],
    };
    expect(await signInEntries(gone, entries)).toMatchObject({ error: "transient" });
    const missing = await signInEntries(job, {
      ...entries,
      entries: [
        { kind: "proof_code.checked", proofCodeId: "code-t1284-fails-after" },
        { kind: "session.started", sessionId: "session-t1284-never" },
      ],
    });
    expect(missing).toEqual({ error: "notFound", table: "sessions", rowId: "session-t1284-never" });
    expect(await db.sql`select id from event_log where row_id = 'code-t1284-fails-after'`).toHaveLength(0);
    // The try counted all the same, on the attempt and on its code.
    expect(await attemptState(attempt.id)).toMatchObject({ wrong_tries: 1, last_outcome: "wrong" });
    expect(await codeState("code-t1284-fails-after")).toMatchObject({ wrong_tries: 1 });
    // The page call sends the lost check again: its first result, counting nothing more.
    const repeat = await check(checkOf(attempt, "req-t1284-fails-1", wrongHash("fails")));
    expect(repeat.outcome).toMatchObject({ outcome: "wrong", triesLeft: 4, repeated: true });
    expect(await attemptState(attempt.id)).toMatchObject({ wrong_tries: 1 });
    const next = await check(checkOf(attempt, "req-t1284-fails-2", wrongHash("fails again")));
    expect(next.outcome).toMatchObject({ outcome: "wrong", triesLeft: 3, repeated: false });
  });
});

describe("DL-526: a check whose time is before its code's sent_at", () => {
  it(
    "counts the same try, with the same answer, as its twin with no account (READ COMMITTED: DL-610)",
    SLOW,
    async () => {
      const raced = await writeAttempt({ id: "t1284-race", person: SAM, ownerOrAdmin: true });
      const twin = await writeAttempt({ id: "t1284-race-twin", person: null });
      // The send holds the attempt's lock (sendSignInCode locks it FOR UPDATE) while the check begins.
      const locked = gate();
      const released = gate();
      const send = db.sql.begin(async (tx) => {
        await tx`select id from sign_in_attempts where id = ${raced.id} for update`;
        locked.open();
        await released.opened;
        // Its code, sent by the clock after the check's transaction began: clock_timestamp(), later than the check's now().
        await tx`
        insert into proof_codes (
          id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at, expires_at
        )
        select 'code-t1284-race', 'sign_in', ${SAM}, null, ${SAM_EMAIL_HANDLE}, 'email', ${hex("code code-t1284-race")},
               ${KEY_NAME}, at, at + interval '10 minutes'
        from (select clock_timestamp() as at) as sent
      `;
        await tx`
        update sign_in_attempts set proof_code_id = 'code-t1284-race', version = version + 1 where id = ${raced.id}
      `;
      });
      await locked.opened;
      const checking = check(checkOf(raced, "req-t1284-race-1", wrongHash("race")));
      // The check waits on the attempt's lock: its transaction (and its now()) began before the code was sent.
      await waitForLockWait();
      released.open();
      await send;
      const { outcome } = await checking;
      const twinCheck = await check(checkOf(twin, "req-t1284-race-twin-1", wrongHash("race")));

      expect(outcome).toEqual({
        outcome: "wrong",
        signInAttemptId: raced.id,
        triesLeft: 4,
        proofCodeId: "code-t1284-race",
        repeated: false,
      });
      expect(pageParts(twinCheck.outcome)).toEqual(pageParts(outcome));
      // check_proof_code read the code (each statement its own snapshot) and answered expired before any write: the
      // code counted nothing, while the attempt counted one wrong try, at a time before the code's sent_at.
      const code = await codeState("code-t1284-race");
      expect(code).toMatchObject({ wrong_tries: 0, used_at: null, paused_until: null });
      const state = await attemptState(raced.id);
      const twinState = await attemptState(twin.id);
      expect(state.last_wrong_at?.getTime()).toBeLessThan(code.sent_at.getTime());
      for (const one of [state, twinState]) {
        expect(one).toMatchObject({ wrong_tries: 1, paused_until: null, last_outcome: "wrong" });
        expect(one.last_wrong_at).not.toBeNull();
      }
      expect(state.last_wrong_at?.getTime()).toBeLessThanOrEqual(twinState.last_wrong_at?.getTime() ?? 0);
    },
  );

  it("would be refused at REPEATABLE READ, the level proveSignIn never takes (DL-610)", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-rr",
      person: SAM,
      ownerOrAdmin: true,
      code: { id: "code-t1284-rr" },
    });
    const locked = gate();
    const released = gate();
    const send = db.sql.begin(async (tx) => {
      await tx`select id from sign_in_attempts where id = ${attempt.id} for update`;
      locked.open();
      await released.opened;
      await tx`update sign_in_attempts set version = version + 1 where id = ${attempt.id}`;
    });
    await locked.opened;
    // The same lock-then-read at REPEATABLE READ: the snapshot is taken by the first statement, before the lock.
    const repeatable = thrownBy(
      app.begin("isolation level repeatable read", async (tx) => {
        await tx`select set_config('rosie.business_id', '', true)`;
        await tx`select id from sign_in_attempt(${attempt.attemptId}, ${attempt.device}, now())`;
      }),
    );
    await waitForLockWait();
    released.open();
    await send;
    expect(await repeatable).toMatchObject({ code: "40001" });
    // proveSignIn, READ COMMITTED, reads the attempt as the send left it.
    const checked = await check(checkOf(attempt, "req-t1284-rr-1", wrongHash("rr")));
    expect(checked.outcome).toMatchObject({ outcome: "wrong", triesLeft: 4 });
  });

  it("counts two checks sent at once one after the other, neither transient", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-parallel",
      person: SAM,
      code: { id: "code-t1284-parallel" },
    });
    const [one, two] = await Promise.all([
      proveSignIn(app, checkOf(attempt, "req-t1284-parallel-1", wrongHash("p1"))),
      proveSignIn(app, checkOf(attempt, "req-t1284-parallel-2", wrongHash("p2"))),
    ]);
    expect([one, two].map((answer) => Number(fieldOf(answer, "triesLeft"))).sort()).toEqual([3, 4]);
    expect(await attemptState(attempt.id)).toMatchObject({ wrong_tries: 2 });
    expect(await codeState("code-t1284-parallel")).toMatchObject({ wrong_tries: 2 });
  });
});

/** Waits until the rosie_app client's check waits on a row lock (pg_stat_activity), for at most 20 s. */
async function waitForLockWait(): Promise<void> {
  const giveUpAt = Date.now() + 20_000;
  for (;;) {
    const [row] = await db.sql<{ waiting: number }[]>`
      select count(*)::integer as waiting from pg_stat_activity
      where application_name = ${APP_NAME} and wait_event_type = 'Lock' and state = 'active'
    `;
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > giveUpAt) {
      throw new Error("the check never waited on the attempt's lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("no person, no session", () => {
  it("reads and starts no session, and sets no person, on every path but a right code", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-no-person",
      person: SAM,
      ownerOrAdmin: true,
      device: SAM_DEVICE,
      code: { id: "code-t1284-no-person" },
    });
    const paths: ProveSignInRequest[] = [
      checkOf(attempt, "req-t1284-np-1", wrongHash("np")),
      checkOf(attempt, "req-t1284-np-1", wrongHash("np")),
      { ...checkOf(attempt, "req-t1284-np-2", wrongHash("np")), deviceSha256: hex("t1284 np other") },
    ];
    for (const request of paths) {
      const from = sent.length;
      await check(request);
      const statements = sentSince(from, APP_NAME);
      expect(personSettings(statements)).toEqual([""]);
      expect(namesSessions(statements)).toEqual([]);
    }
    const allSessions = async (): Promise<string[]> =>
      (await db.sql<{ id: string }[]>`select id from sessions order by id`).map((row) => row.id);
    const sessionsBefore = await allSessions();
    // At the database: a Tool API transaction with no person reads none of Sam's sessions and starts none, even with a
    // used sign-in code of his (K-22 rule 5); once the setter sets him, his own are read; the setting ends with it.
    const one = roleClient(APP_ROLE, `${APP_NAME}-one`, 1);
    try {
      const unset = await one.begin(async (tx) => {
        await tx`select set_config('rosie.person_id', '', true)`;
        return tx<{ id: string }[]>`select id from sessions where person_id = ${SAM}`;
      });
      expect(unset).toHaveLength(0);
      const started = await thrownBy(
        one.begin(async (tx) => {
          await tx`
            insert into sessions (
              id, person_id, token_sha256, device_sha256, proven_via, proof_code_id, started_at, last_seen_at,
              expires_at
            ) values (
              'session-t1284-no-person', ${SAM}, ${hex("token t1284 no person")}, ${SAM_DEVICE}, 'code',
              'code-sam-sign-in-oct26-email', now(), now(), now() + interval '30 days'
            )
          `;
        }),
      );
      expect(started).toMatchObject({ code: "42501" });
      const own = await one.begin(async (tx) => {
        await setPersonScope(tx, SAM);
        return tx<{ id: string }[]>`select id from sessions where person_id = ${SAM} order by id`;
      });
      expect(own.length).toBeGreaterThan(0);
      const after = await one<{ id: string }[]>`select id from sessions where person_id = ${SAM}`;
      expect(after).toHaveLength(0);
      const [setting] = await one<{ value: string | null }[]>`
        select current_setting('rosie.person_id', true) as value
      `;
      expect(setting?.value ?? "").toBe("");
    } finally {
      await one.end({ timeout: 5 });
    }
    expect(await allSessions()).toEqual(sessionsBefore);
  });

  it("refuses a person id that would read as no person, before any statement", async () => {
    const from = sent.length;
    for (const bad of ["", "   ", "person\u0000sam", "p".repeat(129)]) {
      const refused = await thrownBy(app.begin((tx) => setPersonScope(tx, bad)));
      expect(refused).toBeInstanceOf(TypeError);
    }
    expect(sentSince(from, APP_NAME).filter((one) => one.text.includes("set_config"))).toEqual([]);
  });
});

describe("endSession", () => {
  it("ends the person's own live session, and session_for_token answers none after", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-sign-out",
      person: SAM,
      ownerOrAdmin: true,
      device: SAM_DEVICE,
      code: { id: "code-t1284-sign-out" },
    });
    const signedIn = await check(checkOf(attempt, "req-t1284-sign-out-1", attempt.rightHash));
    expect(signedIn.outcome).toMatchObject({ outcome: "signedIn" });
    const token = hex("token req-t1284-sign-out-1");
    const live = await app<
      { session_id: string }[]
    >`select session_id from session_for_token(${token}, now())`;
    expect(live.map((row) => row.session_id)).toEqual(["session-req-t1284-sign-out-1"]);

    const from = sent.length;
    const ended = await endSession(app, { tokenSha256: token });
    expect(ended).toEqual({
      result: "signedOut",
      repeated: false,
      sessionId: "session-req-t1284-sign-out-1",
      personId: SAM,
    });
    expectValid("endSession", ended);
    const statements = sentSince(from, APP_NAME);
    expect(personSettings(statements)).toEqual(["", SAM]);
    expect(statements.some((one) => /^begin isolation level read committed$/i.test(one.text.trim()))).toBe(
      true,
    );
    expect(await app`select session_id from session_for_token(${token}, now())`).toHaveLength(0);
    const [row] = await db.sql<{ ended_why: string | null; ended: boolean; version: number }[]>`
      select ended_why, ended_at is not null as ended, version from sessions where id = 'session-req-t1284-sign-out-1'
    `;
    expect(row).toEqual({ ended_why: "signed_out", ended: true, version: 2 });

    // Sent again, or with a hash no session holds: signedOut, repeated, naming nothing and changing nothing.
    const again = await endSession(app, { tokenSha256: token });
    expect(again).toEqual({ result: "signedOut", repeated: true });
    expect(await endSession(app, { tokenSha256: hex("t1284 no token") })).toEqual({
      result: "signedOut",
      repeated: true,
    });
    expectValid("endSession", again);
    // The token itself, or a hash in capitals, is refused before any statement, naming no value.
    for (const bad of ["a-session-token-as-the-page-holds-it", token.toUpperCase()]) {
      const refused = await thrownBy(endSession(app, { tokenSha256: bad }));
      expect(refused).toBeInstanceOf(TypeError);
      expect(String(refused)).not.toContain(bad);
    }
  });
});

describe("personStanding", () => {
  it("answers the v1.13 fixtures' standings", SLOW, async () => {
    for (const file of [
      "person-standing-sam.json",
      "person-standing-alex.json",
      "person-standing-check-tester.json",
    ]) {
      const exchange = readJson(new URL(file, ACCESS_DIR)) as {
        request: PersonStandingRequest;
        outcome: Row;
      };
      const outcome = await personStanding(job, exchange.request);
      expect(outcome, file).toEqual(exchange.outcome);
      expectValid("personStanding", outcome);
    }
  });

  it(
    "lists live roles in role id order in K-21's names, never a customer's or an ended one",
    SLOW,
    async () => {
      await db.sql`
      insert into person_roles (id, person_id, business_id, role, version) values
        ('role-t1284-b-own', ${TESTER}, 'biz-yoga-studio', 'own_business', 1),
        ('role-t1284-a-staff', ${TESTER}, 'biz-lees-barbershop', 'staff', 1),
        ('role-t1284-c-customer', ${TESTER}, 'biz-movers', 'customer', 1),
        ('role-t1284-d-ended', ${TESTER}, 'biz-movers', 'admin', 1)
    `;
      await db.sql`update person_roles set ended_at = now(), version = 2 where id = 'role-t1284-d-ended'`;
      await db.sql`
      insert into team_page_recipients (id, person_id, chat_handle_id, email_handle_id, added_at, removed_at, version)
      values ('team-t1284-tester', ${TESTER}, null, ${TESTER_HANDLE}, now() - interval '1 day', now(), 1)
    `;
      const outcome = await personStanding(job, { personId: TESTER });
      expect(outcome).toEqual({
        personId: TESTER,
        roles: [
          { role: "staff", businessId: "biz-lees-barbershop" },
          { role: "ownBusiness", businessId: "biz-yoga-studio" },
        ],
        team: false,
        tester: false,
      });
      expectValid("personStanding", outcome);
      expect(await personStanding(job, { personId: "person-t1284-nobody" })).toEqual({
        personId: "person-t1284-nobody",
        roles: [],
        team: false,
        tester: false,
      });
    },
  );
});

describe("signInEntries", () => {
  /** An entry as K-08 v1.2's eventLogRow has it, from the row as stored. */
  async function entryRow(id: string): Promise<Row | undefined> {
    const [row] = await db.sql<Row[]>`
      select id, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, zone, turn_id, job_id, trace_id,
             bundle_hash, bundle_build, business_id, actor_kind, actor_person_id, actor_role, kind, table_name, row_id,
             old_values, new_values, sealed_values, sealed_for_person_id, why, approved_by, proofs
      from event_log where id = ${id}
    `;
    return row;
  }

  it("logs a check's wrong tries, a code's use and a session's start from the rows, once", SLOW, async () => {
    const attempt = await writeAttempt({
      id: "t1284-entries",
      person: SAM,
      ownerOrAdmin: true,
      device: SAM_DEVICE,
      code: { id: "code-t1284-entries" },
    });
    await check(checkOf(attempt, "req-t1284-entries-1", wrongHash("e1")));
    await check(checkOf(attempt, "req-t1284-entries-2", wrongHash("e2")));
    await check(checkOf(attempt, "req-t1284-entries-3", attempt.rightHash));
    const request: SignInEntriesRequest = {
      jobId: attempt.id,
      traceId: "trace-t1284-entries",
      entries: [
        { kind: "proof_code.checked", proofCodeId: "code-t1284-entries" },
        { kind: "session.started", sessionId: "session-req-t1284-entries-3" },
      ],
    };
    const from = sent.length;
    const logged = await signInEntries(job, request);
    expectValid("signInEntries", logged);
    const ids = [
      "log-code-t1284-entries-wrong-1",
      "log-code-t1284-entries-wrong-2",
      "log-code-t1284-entries-used",
      "log-session-req-t1284-entries-3-started",
    ];
    expect(logged).toEqual({
      result: "logged",
      entries: ids.map((id, index) => ({
        id,
        kind: index < 3 ? "proof_code.checked" : "session.started",
        written: true,
      })),
    });
    // No statement read a hash column.
    for (const one of sentSince(from, JOB_NAME)) {
      for (const column of HASH_COLUMNS) {
        expect(one.text).not.toContain(column);
      }
    }
    const rows = await Promise.all(ids.map(entryRow));
    for (const row of rows) {
      expect(schemaErrors(K08_V12, "eventLogRow", row)).toEqual([]);
      expectNoHash(row?.old_values);
      expectNoHash(row?.new_values);
      expect(row).toMatchObject({
        job_id: attempt.id,
        trace_id: "trace-t1284-entries",
        turn_id: null,
        bundle_hash: null,
        business_id: null,
        zone: null,
        sealed_values: null,
      });
    }
    const code = await codeState("code-t1284-entries");
    expect(rows[0]).toMatchObject({
      actor_kind: "rosie",
      actor_person_id: null,
      table_name: "proof_codes",
      row_id: "code-t1284-entries",
      old_values: { wrong_tries: 0 },
      new_values: { wrong_tries: 1 },
      why: { step: "S11-52" },
    });
    expect(rows[2]).toMatchObject({
      actor_kind: "person",
      actor_person_id: SAM,
      old_values: { used_at: null },
      new_values: { used_at: code.used_at?.toISOString().replace(".000Z", "Z") },
    });
    expect(rows[3]).toMatchObject({
      actor_kind: "person",
      actor_person_id: SAM,
      table_name: "sessions",
      old_values: null,
      new_values: { person_id: SAM, proven_via: "code", proof_code_id: "code-t1284-entries" },
      why: { step: "S11-52" },
    });
    // Sent again: every entry found written, nothing written twice.
    const again = await signInEntries(job, request);
    expect(again).toEqual({
      result: "logged",
      entries: ids.map((id, index) => ({
        id,
        kind: index < 3 ? "proof_code.checked" : "session.started",
        written: false,
      })),
    });
    expect(await db.sql`select id from event_log where job_id = ${attempt.id}`).toHaveLength(4);
  });

  it(
    "logs the fifth wrong try with its pause, and a sign-out's end under its own request id",
    SLOW,
    async () => {
      const attempt = await writeAttempt({
        id: "t1284-entries-five",
        person: SAM,
        code: { id: "code-t1284-entries-five" },
      });
      for (let try_ = 1; try_ <= 5; try_ += 1) {
        await check(
          checkOf(attempt, `req-t1284-entries-five-${String(try_)}`, wrongHash(`f${String(try_)}`)),
        );
      }
      const logged = await signInEntries(job, {
        jobId: attempt.id,
        traceId: "trace-t1284-entries-five",
        entries: [{ kind: "proof_code.checked", proofCodeId: "code-t1284-entries-five" }],
      });
      expect(logged).toMatchObject({ result: "logged" });
      expect((logged as { entries: unknown[] }).entries).toHaveLength(5);
      const code = await codeState("code-t1284-entries-five");
      const fifth = await entryRow("log-code-t1284-entries-five-wrong-5");
      expect(fifth).toMatchObject({
        old_values: { wrong_tries: 4, paused_until: null },
        new_values: { wrong_tries: 5, paused_until: code.paused_until?.toISOString().replace(".000Z", "Z") },
      });
      expect(schemaErrors(K08_V12, "eventLogRow", fifth)).toEqual([]);

      // A session asked to log its end before it has one gives no entry; after the sign-out, one, the person's own act.
      const signedOut = await writeAttempt({
        id: "t1284-entries-out",
        person: SAM,
        ownerOrAdmin: true,
        device: SAM_DEVICE,
        code: { id: "code-t1284-entries-out" },
      });
      await check(checkOf(signedOut, "req-t1284-entries-out-1", signedOut.rightHash));
      const ask: SignInEntriesRequest = {
        jobId: "req-t1284-sign-out-page",
        traceId: "trace-t1284-sign-out",
        entries: [{ kind: "session.ended", sessionId: "session-req-t1284-entries-out-1" }],
      };
      expect(await signInEntries(job, ask)).toEqual({ result: "logged", entries: [] });
      await endSession(app, { tokenSha256: hex("token req-t1284-entries-out-1") });
      const ended = await signInEntries(job, ask);
      expect(ended).toEqual({
        result: "logged",
        entries: [{ id: "log-session-req-t1284-entries-out-1-ended", kind: "session.ended", written: true }],
      });
      const row = await entryRow("log-session-req-t1284-entries-out-1-ended");
      expect(row).toMatchObject({
        job_id: "req-t1284-sign-out-page",
        actor_kind: "person",
        actor_person_id: SAM,
        old_values: { ended_at: null, ended_why: null },
        new_values: { ended_why: "signed_out" },
        why: null,
      });
      expect(schemaErrors(K08_V12, "eventLogRow", row)).toEqual([]);
    },
  );

  it(
    "answers notFound for a row that does not exist, writing nothing, and refuses a caller's values",
    SLOW,
    async () => {
      const missing = await signInEntries(job, {
        jobId: "sign-in-t1284-missing",
        traceId: "trace-t1284-missing",
        entries: [{ kind: "proof_code.checked", proofCodeId: "code-t1284-missing" }],
      });
      expect(missing).toEqual({ error: "notFound", table: "proof_codes", rowId: "code-t1284-missing" });
      expectValid("signInEntries", missing);
      expect(await db.sql`select id from event_log where job_id = 'sign-in-t1284-missing'`).toEqual([]);
      const refusedShapes: unknown[] = [
        { jobId: "j", traceId: "t", entries: [] },
        {
          jobId: "j",
          traceId: "t",
          entries: [
            { kind: "proof_code.checked", proofCodeId: "a" },
            { kind: "proof_code.checked", proofCodeId: "b" },
            { kind: "proof_code.checked", proofCodeId: "c" },
          ],
        },
        {
          jobId: "j",
          traceId: "t",
          entries: [
            { kind: "proof_code.checked", proofCodeId: "a", newValues: { used_at: "2026-11-02T13:01:30Z" } },
          ],
        },
        {
          jobId: "j",
          traceId: "t",
          entries: [{ kind: "session.started", sessionId: "s", values: { token: "x" } }],
        },
        { jobId: "j", traceId: "t", entries: [{ kind: "session.touched", sessionId: "s" }] },
      ];
      for (const request of refusedShapes) {
        expect(await thrownBy(signInEntries(job, request as SignInEntriesRequest))).toBeInstanceOf(TypeError);
      }
    },
  );
});

// ---- the v1.13 fixtures, each in its own world on the database's clock ------------------------------------------------

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; partSeeds?: string[]; after: string[]; now: string; note?: string };
  request: Row;
  outcome: Row;
}

const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const exchangeIn = (folder: string, file: string): Exchange =>
  readJson(new URL(`${folder}/${file}`, ACCESS_DIR)) as Exchange;

/** Each call through its db/repo function on its own side's client, the request handed on as given. */
const CALLS: Readonly<Record<Call, (request: unknown) => Promise<unknown>>> = {
  proveSignIn: (request) => proveSignIn(app, request as ProveSignInRequest),
  endSession: (request) => endSession(app, request as EndSessionRequest),
  personStanding: (request) => personStanding(job, request as PersonStandingRequest),
  signInEntries: (request) => signInEntries(job, request as SignInEntriesRequest),
};
const isCall = (call: string): call is Call => Object.hasOwn(CALLS, call);

/** The exchanges an exchange's `after` runs first, in order, each once, its own chain first. */
function stepsOf(file: string, seen = new Set<string>()): string[] {
  const steps: string[] = [];
  for (const before of exchangeOf(file).given.after) {
    if (!seen.has(before)) {
      seen.add(before);
      steps.push(...stepsOf(before, seen), before);
    }
  }
  return steps;
}

/**
 * The fixture's world: every table emptied (the heads' truncate cascades; this file's schema only), then its seeds as
 * the owner with every time moved by `shiftMs`, the fake clock's `given.now` becoming the database's now.
 */
async function loadWorld(given: Exchange["given"], shiftMs: number): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const seen = new Set<string>();
  const rows = [
    ...given.k04Seeds.flatMap((seed) => seedRows(new URL(`core/fixtures/${seed}`, SCHEMA_DIR), seen)),
    ...(given.partSeeds ?? []).flatMap((seed) => {
      const [part, file] = seed.split("/");
      return seedRows(new URL(`${part ?? ""}/fixtures/${file ?? ""}`, SCHEMA_DIR), seen);
    }),
  ];
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values, shiftMs);
    }
  });
}

/** startSignIn's attempt, as start-sign-in-*'s request and outcome give it (README item 58, rule 5). */
async function writeStart(step: Exchange, shiftMs: number): Promise<void> {
  const request = step.request as Record<string, string>;
  const personId = (step.outcome.personId ?? null) as string | null;
  const startedAt = new Date(Date.parse(step.given.now) + shiftMs);
  await db.sql`
    insert into sign_in_attempts (
      id, attempt_id, request_sha256, device_sha256, contact_hash, hash_key_name, way, person_id, owner_or_admin,
      started_at, expires_at
    ) values (
      ${request.id ?? ""}, ${request.attemptId ?? ""}, ${request.requestSha256 ?? ""}, ${request.deviceSha256 ?? ""},
      ${request.contactHash ?? ""}, ${request.hashKeyName ?? ""}, ${request.way ?? ""}, ${personId},
      exists (
        select 1 from person_roles
        where person_id = ${personId} and role in ('owner', 'admin') and ended_at is null
      ),
      ${startedAt}, ${startedAt}::timestamptz + interval '10 minutes'
    )
  `;
}

/** sendSignInCode's code and the attempt's code id, as send-sign-in-code-*'s request gives them (README item 59). */
async function writeSend(step: Exchange, shiftMs: number): Promise<void> {
  const request = step.request as {
    signInAttemptId: string;
    code: { id: string; codeHash: string; hashKeyName: string };
  };
  const sentAt = new Date(Date.parse(step.given.now) + shiftMs);
  await db.sql.begin(async (tx) => {
    // The attempt's person and their account's proven email's handle, read from the rows (item 59, steps 2 and 3).
    const written = await tx`
      insert into proof_codes (
        id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at, expires_at
      )
      select ${request.code.id}, 'sign_in', a.person_id, null, h.id, 'email', ${request.code.codeHash},
             ${request.code.hashKeyName}, ${sentAt}, ${sentAt}::timestamptz + interval '10 minutes'
      from sign_in_attempts a
      join accounts c on c.person_id = a.person_id and c.email_proven_at is not null
      join handles h on h.address = c.email and h.kind = 'email'
      where a.id = ${request.signInAttemptId}
      returning id
    `;
    expect(written).toHaveLength(1);
    await tx`
      update sign_in_attempts set proof_code_id = ${request.code.id}, version = version + 1
      where id = ${request.signInAttemptId}
    `;
  });
}

/** An answer against a fixture's outcome: every field equal, each time within 5 s of the fixture's, moved. */
function expectOutcome(file: string, actual: unknown, expected: Row, shiftMs: number): void {
  const times = ["sessionExpiresAt", "until"];
  const plain = (outcome: Row): Row =>
    Object.fromEntries(Object.entries(outcome).filter(([field]) => !times.includes(field)));
  expect(plain(actual as Row), file).toEqual(plain(expected));
  for (const field of times) {
    const want = expected[field];
    if (typeof want === "string") {
      const got = Date.parse(fieldOf(actual, field) as string);
      expect(Math.abs(got - (Date.parse(want) + shiftMs)), `${file}: ${field}`).toBeLessThan(5000);
    } else {
      expect(fieldOf(actual, field), `${file}: ${field}`).toBeUndefined();
    }
  }
}

/**
 * Replays an exchange: its world with every time moved so the fake clock of the first step this file's calls answer
 * reads as the database's now; its chain's start and send as the rows those calls write, and its other steps through
 * this file's calls, each answer checked against its own fixture; then the exchange itself.
 */
async function replay(file: string): Promise<{ outcome: unknown; shiftMs: number }> {
  const exchange = exchangeOf(file);
  const steps = stepsOf(file);
  const anchor = [...steps, file].find((step) => isCall(exchangeOf(step).call)) ?? file;
  const shiftMs = (await dbClock()).getTime() - Date.parse(exchangeOf(anchor).given.now);
  await loadWorld(exchange.given, shiftMs);
  for (const step of steps) {
    const before = exchangeOf(step);
    if (before.call === "startSignIn") {
      await writeStart(before, shiftMs);
    } else if (before.call === "sendSignInCode") {
      await writeSend(before, shiftMs);
    } else if (isCall(before.call)) {
      const answer = await CALLS[before.call](before.request);
      expectOutcome(step, answer, before.outcome, shiftMs);
    } else {
      throw new Error(`${file}: this file runs no ${before.call} step`);
    }
  }
  if (!isCall(exchange.call)) {
    throw new Error(`${file}: not one of this file's calls`);
  }
  const outcome = await CALLS[exchange.call](exchange.request);
  expectValid(exchange.call, outcome);
  expectNoHash(outcome);
  return { outcome, shiftMs };
}

describe("the v1.13 fixtures", () => {
  const files = [
    "prove-sign-in-sam-right.json",
    "prove-sign-in-repeat.json",
    "prove-sign-in-other-device.json",
    "prove-sign-in-wrong.json",
    "prove-sign-in-sixth-check.json",
    "prove-sign-in-sixth-check-no-account.json",
    "prove-sign-in-expired.json",
    "prove-sign-in-second-proof.json",
    "end-session-sam.json",
    "end-session-repeat.json",
    "sign-in-entries-signed-in.json",
    "sign-in-entries-wrong-try.json",
    "sign-in-entries-sign-out.json",
  ];

  it("answers each accepted exchange's outcome on the database's clock", SLOW, async () => {
    for (const file of files) {
      const { outcome, shiftMs } = await replay(file);
      expectOutcome(file, outcome, exchangeOf(file).outcome, shiftMs);
    }
  });

  it("answers the sixth check alike with and without an account, as the two fixtures do", SLOW, async () => {
    const withAccount = await replay("prove-sign-in-sixth-check.json");
    const noAccount = await replay("prove-sign-in-sixth-check-no-account.json");
    expect(pageParts(withAccount.outcome as ProveSignInOutcome)).toEqual(
      pageParts(noAccount.outcome as ProveSignInOutcome),
    );
    // Both seed attempts were paused at the same moment (15:22:10Z), each now moved by its own replay's clock.
    expect(Date.parse(fieldOf(withAccount.outcome, "until") as string) - withAccount.shiftMs).toBe(
      Date.parse(fieldOf(noAccount.outcome, "until") as string) - noAccount.shiftMs,
    );
  });

  it("refuses the refused exchanges' requests before any statement", SLOW, async () => {
    await replay("sign-in-entries-signed-in.json");
    for (const file of [
      "refuse-end-session-token-not-hash.json",
      "refuse-sign-in-entries-caller-values.json",
    ]) {
      const refused = exchangeIn("invalid", file);
      expect(isCall(refused.call)).toBe(true);
      const from = sent.length;
      const thrown = await thrownBy(CALLS[refused.call as Call](refused.request));
      expect(thrown, file).toBeInstanceOf(TypeError);
      expect(sent.slice(from)).toEqual([]);
      expect(String(thrown)).not.toContain("placeholder-session-token");
    }
  });
});

describe("no hash leaves a call", () => {
  it("returns no hash column from any statement, and names the session's hashes only in its insert", () => {
    const mine = sent.filter((one) => one.client === APP_NAME || one.client === JOB_NAME);
    expect(mine.length).toBeGreaterThan(0);
    for (const one of mine) {
      const text = one.text.toLowerCase();
      const returning = text.split("returning")[1] ?? "";
      for (const column of HASH_COLUMNS) {
        expect(returning).not.toContain(column);
      }
      for (const column of ["code_hash", "contact_hash", "request_sha256", "last_check_sha256"]) {
        expect(text).not.toContain(column);
      }
      if (text.includes("token_sha256") || text.includes("device_sha256")) {
        // The test's own reads of the tables go through the owner's client, never these two.
        expect(text).toMatch(/^\s*insert into sessions/);
      }
    }
  });

  it("refuses a request's values in a TypeError that names the field, never the value", async () => {
    const attempt: ProveSignInRequest = {
      attemptId: "attempt-t1284-shape",
      deviceSha256: "a-device-cookie-as-the-browser-sends-it",
      requestId: "req-t1284-shape",
      typedHash: "482913",
      session: { id: "session-t1284-shape", tokenSha256: "a-session-token" },
    };
    const from = sent.length;
    const requests: unknown[] = [
      attempt,
      { ...attempt, deviceSha256: hex("ok"), typedHash: "482913" },
      {
        ...attempt,
        deviceSha256: hex("ok"),
        typedHash: hex("ok"),
        session: { id: "s", tokenSha256: "a-token" },
      },
      { ...attempt, deviceSha256: hex("ok"), typedHash: hex("ok"), code: "482913" },
    ];
    for (const request of requests) {
      const refused = await thrownBy(proveSignIn(app, request as ProveSignInRequest));
      expect(refused).toBeInstanceOf(TypeError);
      for (const value of stringsIn(request)) {
        if (value.length > 8) {
          expect(String(refused)).not.toContain(value);
        }
      }
      expect(String(refused)).not.toContain("482913");
    }
    expect(sentSince(from, APP_NAME)).toEqual([]);
    expect(await thrownBy(personStanding(job, { personId: "" }))).toBeInstanceOf(TypeError);
  });
});
