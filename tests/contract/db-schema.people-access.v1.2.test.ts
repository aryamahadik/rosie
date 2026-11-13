// Contract test for K-22 v1.2, the database schema's people and access part: the table sign_in_attempts and its three
// calls (T-1291; ops/plan/02-contracts.md K-22 and section 2 item 12; contracts/db-schema/people-access/README.md
// section "v1.2" (lines 174 to 227) with rule 9 (lines 189 to 223), "Seed and refused-row fixtures" (lines 129 to 135),
// and the v1.2 freeze record's QA line (line 17): "the seeds and refused rows (each refused for its one reason) and
// that every earlier fixture still holds"; ADR-016 section 4; DL-526). README line 225 names this file.
//
// K-22 had no contract test in tests/contract before this file: README line 19 names db-schema.people-access.v1.test.ts
// (T-099) and line 170 db-schema.people-access.v1.1.test.ts, and neither exists, so no earlier K-22 case could change.
// Section 7 below is the second half of line 17: every v1 and v1.1 entry, selected by its version, still loads or is
// refused as its `expect` says with v1.2's migration applied. Putting each of those right stays with their own QA tasks.
//
// What it proves:
//   1. The files, with no database: the index lists every fixture file and only those; v1.2's entries, selected by
//      their version and never by a pinned list or count (DL-124, DL-125), are a seed and refused rows of the table v1.2
//      adds, each file in the README's format with K-22's additions (line 131: a scope's personId, a select's columns,
//      `{}` for no setting); each refused one names one reason, the one its index entry shows, and has one way to be put
//      right, as README line 225 puts it, that changes nothing else; the seed's two attempts of Oct 28 leave the same
//      tries, pause and last answer on the fixture's own clock (line 222).
//   2. T-1278's migrated table and calls against v1.2's table list and rule 9: columns, keys, CHECKs, indexes, row-level
//      security and its one policy, grants (none to the Tool API, not even a column), 0002's version trigger, and the
//      three calls (security definer, volatile, owned by the table's owner, search_path pinned, EXECUTE only to the two
//      roles, the README's signatures).
//   3. v1.2's seed loads with its after chain and stores every value as given.
//   4. Each refused v1.2 fixture is refused as its `expect` says; put right as README line 225 puts it, the same action
//      passes; of every CHECK on the table its row breaks the one its `expect` names and no other, and its twin none;
//      the Tool API's refusal is its missing grant, whoever the call acts for.
//   5. Each CHECK a refused fixture names, pinned at its edges (T-1290's lesson, DL-618), and sign_in_attempts_outcome_known
//      holding exactly K-21 v1's signInCheck labels, in the table list and as PostgreSQL holds it.
//   6. The three calls of rule 9 as the Tool API calls them, and DL-526's race: an attempt with a code and its twin
//      with none count the same tries (line 222; see the note above that describe block on last_wrong_at).
//   7. Every v1 and v1.1 fixture still holds, and every K-22 seed of every version loads together.
//
// It needs PostgreSQL: `npm run db:up` locally (DATABASE_URL, else the local Docker database when CI is unset), and the
// merge check's service database in CI. Its schema is made in a pool database of its own (createTestDatabase with
// database "own", as db-schema.core.v1.db-side.test.ts does), since DROP DATABASE calls of other runs held up a shared
// database's migration in T-1284's first run. Every fixture runs in one transaction that is always rolled back and every
// action in a savepoint rolled back after it, so nothing is committed, except the one row the lock probe of section 6
// commits and deletes. Rows come only from the fixtures (rule 9): new rows here are a fixture's rows under new ids, with
// stand-in hashes (the sha256 of a label, never of a real code, token, cookie or contact).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "../../db/repo/scope";
import { createTestDatabase, type TestDatabase } from "../../db/repo/test-db";
import { CONTRACTS_ROOT, checkContractFixtures, formatErrors, type FixtureEntry } from "./_harness";

// ---------------------------------------------------------------------------------------------------------------
// The contract's files

const PART = "people-access";
const PART_DIR = path.join(CONTRACTS_ROOT, "db-schema", PART);
const FIXTURES_DIR = path.join(PART_DIR, "fixtures");
const VERSION = "v1.2";
/** The one table v1.2 adds (people-access.v1.2.tables.json). */
const TABLE = "sign_in_attempts";
/** README rule 9's three calls. */
const CALLS = ["sign_in_attempt", "sign_in_attempt_signed_in", "sign_in_attempt_tried"];
/** check_proof_code's answers (README rule 5, line 98). */
const CODE_ANSWERS = ["unknown", "used", "paused", "expired", "right", "wrong"];
const SLOW = { timeout: 60_000 };
const MINUTE = 60_000;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

/** A call's settings (README rule 4 and line 131): rosie.business_id and rosie.person_id; left out, unset. */
interface Scope {
  businessId?: string;
  personId?: string;
}

/** What a refused action must meet (README "Seed and refused-row fixtures"). */
interface Expect {
  sqlstate?: string;
  constraintOneOf?: string[];
  rows?: number;
}

/** A refused fixture's one action, run as `role` with `scope`'s settings. */
interface Action {
  role: "runtime" | "toolApi";
  scope: Scope | null;
  action: "insert" | "update" | "select";
  table: string;
  columns?: string[];
  values?: Values;
  set?: Values;
  where?: Values;
  expect: Expect;
}

interface FixtureRow {
  table: string;
  values: Values;
}

/** A fixture file (README "Seed and refused-row fixtures"): rows loaded after the fixtures `after` names. */
interface FixtureFile {
  after: string[];
  rows: FixtureRow[];
  refused?: Action;
}

interface Column {
  name: string;
  type: string;
  null: boolean;
  default?: string;
}

interface Table {
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys?: {
    name?: string;
    columns: string[];
    references: { table: string; columns: string[] };
    onDelete?: string;
  }[];
  unique?: { name?: string; columns: string[]; where?: string }[];
  checks?: { name: string; expression: string }[];
  indexes?: { name: string; columns: string[]; using?: string; where?: string }[];
  rowLevelSecurity: { scope: string };
  versioned: boolean;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** A value a file must hold; a miss is a broken test, never a refusal. */
function must<T>(value: T | null | undefined, what = "a value this test reads"): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

/** A fixture value that must be text. */
function textOf(value: Json | undefined, what = "a text value"): string {
  if (typeof value !== "string") throw new Error(`${what} must be text, found ${JSON.stringify(value)}`);
  return value;
}

const sorted = (items: readonly string[]): string[] => [...items].sort();

/** A version's major and minor number: v1 is [1, 0], v1.2 is [1, 2]. */
function placeOf(version: string): [number, number] {
  const match = /^v(\d+)(?:\.(\d+))?$/.exec(version);
  if (match === null) throw new Error(`the index names a version this test cannot place: ${version}`);
  return [Number(match[1]), Number(match[2] ?? "0")];
}

const entries = (readJson(path.join(FIXTURES_DIR, "index.json")) as { fixtures: FixtureEntry[] }).fixtures;
const [MAJOR, MINOR] = placeOf(VERSION);
/** v1.2's entries, in the index's order. */
const versionEntries = entries.filter((entry) => entry.version === VERSION);
const versionRefused = versionEntries.filter((entry) => entry.expect === "refuse");
const versionAccepted = versionEntries.filter((entry) => entry.expect === "accept");
/** The entries of every earlier version within v1.2's major version (v1 and v1.1). */
const earlierEntries = entries.filter((entry) => {
  const [major, minor] = placeOf(entry.version);
  return major === MAJOR && minor < MINOR;
});

const listOf = (version: string): { part: string; version: string; tables: Table[] } =>
  readJson(path.join(PART_DIR, `${PART}.${version}.tables.json`)) as {
    part: string;
    version: string;
    tables: Table[];
  };
const versionList = listOf(VERSION);
const attemptsTable = must(
  versionList.tables.find((table) => table.name === TABLE),
  `${TABLE} in v1.2's table list`,
);
const listedChecks = attemptsTable.checks ?? [];
/** Every table of the part at v1.2: the lists of every version in the index, together (README line 176). */
const partTables = [...new Set(entries.map((entry) => entry.version))]
  .flatMap((version) => listOf(version).tables)
  .map((table) => table.name);

/** A fixture of this part's index, as an absolute path. */
const fixturePath = (file: string): string => path.join(FIXTURES_DIR, ...file.split("/"));
const fixtureAt = (absolute: string): FixtureFile => readJson(absolute) as FixtureFile;
const fixtureOf = (file: string): FixtureFile => fixtureAt(fixturePath(file));

/** The fixtures/ folder of a fixture file: a refused fixture sits in fixtures/invalid/ (README line 131). */
function fixturesFolderOf(absolute: string): string {
  const folder = path.dirname(absolute);
  return path.basename(folder) === "invalid" ? path.dirname(folder) : folder;
}

/**
 * A fixture's rows after those of every fixture its `after` names, each file once, in order. Each `after` path is
 * relative to the fixtures/ folder of the file that names it, so K-22's seeds name K-04's as ../../core/fixtures/<file>,
 * and K-23's and K-29's seeds name theirs the same way (README line 131).
 */
function chainRows(absolute: string, loaded: Set<string>, chain: readonly string[] = []): FixtureRow[] {
  if (loaded.has(absolute)) return [];
  if (chain.includes(absolute))
    throw new Error(`the after chain loops: ${[...chain, absolute].join(" -> ")}`);
  const content = fixtureAt(absolute);
  const folder = fixturesFolderOf(absolute);
  const before = content.after.flatMap((first) =>
    chainRows(path.resolve(folder, ...first.split("/")), loaded, [...chain, absolute]),
  );
  loaded.add(absolute);
  return [...before, ...content.rows];
}

/** The rows of `table` among a fixture's own rows. */
const ownRowsOf = (file: string, table: string): Values[] =>
  fixtureOf(file)
    .rows.filter((row) => row.table === table)
    .map((row) => row.values);

// ---------------------------------------------------------------------------------------------------------------
// Hashes and times

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** A stand-in hash: the sha256 of a label, hex in hash form, never the hash of a real code, token, cookie or contact. */
const standIn = (label: string): string => sha256(`T-1291 stand-in: ${label}`);
/** README rule 9's last_check_sha256 (line 204): sha256(id LF device_sha256 LF requestId), never over a typed code. */
const checkKeyOf = (id: string, device: string, requestId: string): string =>
  sha256(`${id}\n${device}\n${requestId}`);

/** The instant `ms` milliseconds after `iso`, as ISO text. */
const later = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();
/** One microsecond after `iso`: PostgreSQL's resolution, finer than a JavaScript Date, so it goes as text. */
const microAfter = (iso: string): string => new Date(iso).toISOString().replace(/Z$/, "001Z");
/** One microsecond before `iso`. */
const microBefore = (iso: string): string => later(iso, -1).replace(/Z$/, "999Z");

// ---------------------------------------------------------------------------------------------------------------
// The seed's attempts, read from the file (v1.2's accepted entries), never pinned by id

const seedFiles = versionAccepted.map((entry) => entry.file);
const seedAttempts = seedFiles.flatMap((file) => ownRowsOf(file, TABLE));
const seedCodes = seedFiles.flatMap((file) => ownRowsOf(file, "proof_codes"));
const seedSessions = seedFiles.flatMap((file) => ownRowsOf(file, "sessions"));
/** Sam's attempt that started a session (K-21 sign-in-request.json: signedIn). */
const signedInAttempt = must(
  seedAttempts.find((values) => values.session_id !== null),
  "a seed attempt that names a session",
);
/** Sam's attempt paused after five wrong codes (K-21 sign-in-wrong-five.json). */
const pausedAttempt = must(
  seedAttempts.find((values) => values.person_id !== null && values.paused_until !== null),
  "a seed attempt of an account, paused",
);
/** Its twin for a contact no account holds: no person, no code. */
const noAccountAttempt = must(
  seedAttempts.find((values) => values.person_id === null),
  "a seed attempt of no account",
);

/** The contact's keyed hash the seed keeps for a person's attempts by one way (Sam's email: README line 225). */
function seedContactHashOf(personId: Json | undefined, way: Json | undefined): string {
  const hashes = [
    ...new Set(
      seedAttempts
        .filter((values) => values.person_id === personId && values.way === way)
        .map((values) => values.contact_hash),
    ),
  ];
  if (hashes.length !== 1)
    throw new Error(`the seed keeps ${String(hashes.length)} contact hashes for that contact`);
  return textOf(hashes[0], "the seed's contact hash");
}

/** A fresh attempt like `from` before any check: new ids and keys, no try, no pause, no answer, version 1. */
function freshAttempt(label: string, from: Values = noAccountAttempt): Values {
  return {
    ...from,
    id: `sign-in-probe-${label}`,
    attempt_id: `attempt-probe-${label}`,
    request_sha256: standIn(`request ${label}`),
    device_sha256: standIn(`device ${label}`),
    wrong_tries: 0,
    last_wrong_at: null,
    paused_until: null,
    last_check_sha256: null,
    last_outcome: null,
    session_id: null,
    version: 1,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Each refused v1.2 fixture's one way to be put right (README line 225: "the same row with the cookie's sha256, with the
// contact's keyed hash, at five, paused 15 minutes after the fifth and with `wrong` each passes, and the same read on
// the runtime side returns the row")

interface PutRight {
  /** The one reason it is refused, as its index entry shows it. */
  reason: string;
  /** How README line 225 puts it right. */
  putRight: string;
  /** The parts of the action the twin changes, and no other: role, scope, or values.<column>. */
  changes: readonly string[];
  mend: (action: Action) => Action;
}

const withValue = (action: Action, column: string, value: Json): Action => ({
  ...action,
  values: { ...must(action.values, "an insert's values"), [column]: value },
});

const PUT_RIGHT: Readonly<Record<string, PutRight>> = {
  "invalid/refuse-sign-in-attempt-raw-device.json": {
    reason: "it keeps the device cookie as sent, not its sha256 (CHECK sign_in_attempts_device_hash_form)",
    putRight: "the same row with the cookie's sha256",
    changes: ["values.device_sha256"],
    mend: (action) =>
      withValue(action, "device_sha256", sha256(textOf(action.values?.device_sha256, "the device"))),
  },
  "invalid/refuse-sign-in-attempt-raw-contact.json": {
    reason: "it keeps Sam's email as typed, not its keyed hash (CHECK sign_in_attempts_contact_hash_form)",
    putRight: "the same row with the contact's keyed hash, as the seed keeps it for Sam's email",
    changes: ["values.contact_hash"],
    mend: (action) =>
      withValue(action, "contact_hash", seedContactHashOf(action.values?.person_id, action.values?.way)),
  },
  "invalid/refuse-sign-in-attempt-sixth-wrong-try.json": {
    reason: "it counts a sixth wrong try (CHECK sign_in_attempts_wrong_tries_range alone)",
    putRight: "the same row at five",
    changes: ["values.wrong_tries"],
    mend: (action) => withValue(action, "wrong_tries", 5),
  },
  "invalid/refuse-sign-in-attempt-pause-not-fifteen-minutes.json": {
    reason: "its pause ends 10 minutes after the fifth wrong try (CHECK sign_in_attempts_pause_after_five)",
    putRight: "the same row paused until 15 minutes after the fifth",
    changes: ["values.paused_until"],
    mend: (action) =>
      withValue(
        action,
        "paused_until",
        later(textOf(action.values?.last_wrong_at, "the last wrong try"), 15 * MINUTE),
      ),
  },
  "invalid/refuse-sign-in-attempt-outcome-not-k21.json": {
    reason: "it keeps a session token as the last answer (CHECK sign_in_attempts_outcome_known)",
    putRight: "the same row with wrong",
    changes: ["values.last_outcome"],
    mend: (action) => withValue(action, "last_outcome", "wrong"),
  },
  "invalid/refuse-sign-in-attempt-tool-api-read.json": {
    reason: "the Tool API holds no grant on sign_in_attempts (42501)",
    putRight: "the same read on the runtime side",
    changes: ["role", "scope"],
    mend: (action) => ({ ...action, role: "runtime", scope: {} }),
  },
};

const putRightOf = (entry: FixtureEntry): PutRight | undefined => PUT_RIGHT[entry.file];
const refusedActionOf = (file: string): Action => must(fixtureOf(file).refused, `${file}'s refused action`);
const twinOf = (entry: FixtureEntry): Action =>
  must(putRightOf(entry), `a way to put ${entry.file} right`).mend(refusedActionOf(entry.file));

/** The parts in which two actions differ: role, scope, ... and values.<column>, set.<column>, where.<column>. */
function differences(a: Action, b: Action): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Action>;
  for (const key of keys) {
    if (key === "values" || key === "set" || key === "where") {
      const left = a[key] ?? {};
      const right = b[key] ?? {};
      for (const column of new Set([...Object.keys(left), ...Object.keys(right)]))
        if (!isDeepStrictEqual(left[column], right[column])) out.push(`${key}.${column}`);
    } else if (!isDeepStrictEqual(a[key], b[key])) {
      out.push(key);
    }
  }
  return sorted(out);
}

/** The refused v1.2 entry whose `expect` names `constraint`. */
const refusedByConstraint = (constraint: string): FixtureEntry =>
  must(
    versionRefused.find((entry) =>
      (refusedActionOf(entry.file).expect.constraintOneOf ?? []).includes(constraint),
    ),
    `a refused v1.2 fixture of ${constraint}`,
  );

// ---------------------------------------------------------------------------------------------------------------
// The README's file format, with K-22's additions (line 131), as a schema: K-04's (db-schema.core.v1.test.ts) with a
// scope that may carry personId and may be `{}` (no setting), and a select that may name its columns.

const IDENTIFIER = "^[a-z_][a-z0-9_]*$";
const columnValues = { type: "object", propertyNames: { type: "string", pattern: IDENTIFIER } };
const FIXTURE_FILE_SCHEMA = {
  type: "object",
  properties: {
    after: {
      type: "array",
      items: { type: "string", pattern: "^[A-Za-z0-9_.-]+([/][A-Za-z0-9_.-]+)*[.]json$" },
      uniqueItems: true,
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { table: { type: "string", pattern: IDENTIFIER }, values: columnValues },
        required: ["table", "values"],
        additionalProperties: false,
      },
    },
    refused: {
      type: "object",
      properties: {
        role: { enum: ["toolApi", "runtime"] },
        scope: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                businessId: { type: "string", minLength: 1 },
                personId: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
          ],
        },
        action: { enum: ["insert", "update", "select"] },
        table: { type: "string", pattern: IDENTIFIER },
        columns: {
          type: "array",
          items: { type: "string", pattern: IDENTIFIER },
          minItems: 1,
          uniqueItems: true,
        },
        values: columnValues,
        set: { ...columnValues, minProperties: 1 },
        where: { ...columnValues, minProperties: 1 },
        expect: {
          oneOf: [
            {
              type: "object",
              properties: {
                sqlstate: { type: "string", pattern: "^[0-9A-Z]{5}$" },
                constraintOneOf: {
                  type: "array",
                  items: { type: "string", pattern: IDENTIFIER },
                  minItems: 1,
                  uniqueItems: true,
                },
              },
              required: ["sqlstate"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { rows: { type: "integer", minimum: 0 } },
              required: ["rows"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["role", "scope", "action", "table", "expect"],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { action: { const: "insert" } } },
          then: {
            required: ["values"],
            not: { anyOf: [{ required: ["set"] }, { required: ["where"] }, { required: ["columns"] }] },
          },
        },
        {
          if: { properties: { action: { const: "update" } } },
          then: {
            required: ["set", "where"],
            not: { anyOf: [{ required: ["values"] }, { required: ["columns"] }] },
          },
        },
        {
          if: { properties: { action: { const: "select" } } },
          then: { required: ["where"], not: { anyOf: [{ required: ["values"] }, { required: ["set"] }] } },
        },
        {
          if: { properties: { role: { const: "toolApi" } } },
          then: { properties: { scope: { type: "object" } } },
          else: {
            properties: { scope: { anyOf: [{ type: "null" }, { type: "object", maxProperties: 0 }] } },
          },
        },
      ],
    },
  },
  required: ["after", "rows"],
  additionalProperties: false,
};
const checkFileFormat = new Ajv2020({ strict: true, strictRequired: false, allErrors: true }).compile(
  FIXTURE_FILE_SCHEMA,
);

/** The file-format problems of a fixture file, one line each; empty when it is in the README's format. */
function formatProblems(file: unknown): string[] {
  return checkFileFormat(file) ? [] : formatErrors(checkFileFormat.errors);
}

// ---------------------------------------------------------------------------------------------------------------
// K-21 v1's signInCheck labels (schema lines 813 to 945): each answer's `result`, and the errors' own `error`

const PAGE_API_V1 = path.join(CONTRACTS_ROOT, "page-api", "page-api.v1.schema.json");

interface Labelled {
  $ref?: string;
  properties?: { result?: { const?: unknown }; error?: { const?: unknown } };
}

function k21CheckLabels(): string[] {
  const schema = readJson(PAGE_API_V1) as {
    $defs: Record<string, { oneOf?: Labelled[]; anyOf?: Labelled[] } | undefined>;
  };
  const answers = must(schema.$defs["signInCheck.response"]?.oneOf, "K-21 v1 signInCheck.response");
  const errors = must(schema.$defs["signInCheck.errors"]?.anyOf, "K-21 v1 signInCheck.errors");
  const labels = [
    ...answers.map((answer) => answer.properties?.result?.const),
    // The errors' own: a shared error ($ref: bookingPaused, transient) is no answer to a check of the attempt.
    ...errors.filter((error) => error.$ref === undefined).map((error) => error.properties?.error?.const),
  ];
  return labels.map((label) => {
    if (typeof label !== "string")
      throw new Error(`a K-21 signInCheck label that is not text: ${String(label)}`);
    return label;
  });
}

/** The quoted labels of a CHECK's SQL, as the table list writes it ('a') or PostgreSQL prints it ('a'::text). */
const quotedIn = (sql: string): string[] =>
  [...sql.matchAll(/'((?:[^']|'')*)'(?:::text)?/g)].map((match) => must(match[1]).replace(/''/g, "'"));

// ---------------------------------------------------------------------------------------------------------------
// The database: one fresh schema with every migration, in a database of this file's own, every statement inside a
// transaction that is rolled back

let db: TestDatabase;
/**
 * The jsonb, bytea and timestamptz columns of the migrated schema, `<table>.<column>`: the fixtures' JSON, `\x` hex and
 * time forms.
 */
let typedColumns = new Map<string, string>();
/** The CHECKs of the migrated sign_in_attempts, with PostgreSQL's own expression of each. */
let migratedChecks: { name: string; expression: string }[] = [];
/** `<schema>.sign_in_attempts`, for the catalog's reads. */
let qualified = "";

/** The bytes a bytea's hex names, two digits a byte. */
const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/[0-9a-fA-F]{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));

/**
 * A fixture value as one parameter, as PostgreSQL takes it (README: jsonb as JSON, bytea as \x and hex, the rest as
 * text input). A time goes as text cast on the server: postgres.js would make a timestamptz parameter a JavaScript Date
 * first, which keeps no microseconds, so an edge a microsecond from a CHECK's instant would reach it rounded.
 */
function parameterOf(sql: Tx, table: string, column: string, value: Json | undefined) {
  const type = typedColumns.get(`${table}.${column}`);
  if (value === undefined || value === null) return sql`${null}`;
  if (type === "jsonb") return sql`${sql.json(value)}`;
  if (type === "bytea" && typeof value === "string") return sql`${bytesOfHex(value.replace(/^\\x/, ""))}`;
  if (type === "timestamp with time zone" && typeof value === "string")
    return sql`${value}::text::timestamptz`;
  return sql`${value as never}`;
}

/** `insert into <into> (<columns>) values (<parameters>)`: a row of `table`'s columns, into `table` or a copy of it. */
function insertOf(sql: Tx, into: string, table: string, values: Values) {
  const columns = Object.keys(values);
  if (columns.length === 0) throw new Error(`an insert into ${table} that names no column`);
  const parameters = columns.map((column) => parameterOf(sql, table, column, values[column]));
  return sql`
    insert into ${sql(into)} (${sql(columns)}) values (${parameters.reduce((all, one) => sql`${all}, ${one}`)})
  `;
}

/** `<column> = <value>, ...`: an update's `set`. */
function setOf(sql: Tx, table: string, set: Values) {
  const assignments = Object.entries(set).map(
    ([column, value]) => sql`${sql(column)} = ${parameterOf(sql, table, column, value)}`,
  );
  if (assignments.length === 0) throw new Error(`a set on ${table} that names no column`);
  return assignments.reduce((all, one) => sql`${all}, ${one}`);
}

/** `<column> = <value> and ...`: the rows a fixture's `where` names. */
function whereOf(sql: Tx, table: string, where: Values) {
  const conditions = Object.entries(where).map(
    ([column, value]) => sql`${sql(column)} = ${parameterOf(sql, table, column, value)}`,
  );
  if (conditions.length === 0) throw new Error(`a where on ${table} that names no column`);
  return conditions.reduce((all, condition) => sql`${all} and ${condition}`);
}

/**
 * Loads fixtures with their `after` chains, each file once, their rows inserted in order as the runtime side with no
 * setting (README line 131: K-04's fixture format), the role ending with the load.
 */
async function load(tx: Tx, files: readonly string[]): Promise<void> {
  const loaded = new Set<string>();
  await tx`set local role rosie_job`;
  for (const file of files) {
    for (const row of chainRows(file, loaded)) await insertOf(tx, row.table, row.table, row.values);
  }
  await tx`reset role`;
}

/** Runs an action's one statement: the rows it wrote, changed or read. */
async function statementOf(sql: Tx, action: Action): Promise<number> {
  const { table } = action;
  if (action.action === "insert") {
    const result = await insertOf(sql, table, table, must(action.values, "values"));
    return result.count;
  }
  if (action.action === "update") {
    const result = await sql`
      update ${sql(table)} set ${setOf(sql, table, must(action.set, "set"))}
      where ${whereOf(sql, table, must(action.where, "where"))}
    `;
    return result.count;
  }
  const where = whereOf(sql, table, must(action.where, "where"));
  const rows =
    action.columns === undefined
      ? await sql`select * from ${sql(table)} where ${where}`
      : await sql`select ${sql(action.columns)} from ${sql(table)} where ${where}`;
  return rows.length;
}

/** What an action did: the rows it wrote, changed or read, or PostgreSQL's refusal (its SQLSTATE and constraint). */
type Outcome =
  | { rows: number; refusal: null }
  | { rows: null; refusal: { sqlstate: string; constraint: string | null; message: string } };

/** Thrown to roll a savepoint back once its action has passed, carrying the rows the action touched. */
class Undone extends Error {
  readonly rows: number;
  constructor(rows: number) {
    super("the action's savepoint is rolled back");
    this.rows = rows;
  }
}

/** Thrown to roll a transaction or savepoint back once its checks have run, carrying what they found. */
class RolledBack extends Error {
  readonly found: unknown;
  constructor(found: unknown) {
    super("rolled back on purpose");
    this.found = found;
  }
}

/** Runs `fn` in one transaction that is always rolled back: nothing a fixture loads or an action writes is kept. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.sql.begin(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.found as T;
    throw error;
  }
  throw new Error("a transaction ended without being rolled back");
}

/** PostgreSQL's refusal of a statement, or a broken test when the failure is anything else. */
function refusalOf(error: unknown): { sqlstate: string; constraint: string | null; message: string } {
  const failure = error as { code?: unknown; constraint_name?: unknown; message?: unknown };
  if (typeof failure.code !== "string" || !/^[0-9A-Z]{5}$/.test(failure.code)) throw error;
  return {
    sqlstate: failure.code,
    constraint: typeof failure.constraint_name === "string" ? failure.constraint_name : null,
    message: typeof failure.message === "string" ? failure.message : "",
  };
}

/**
 * Runs an action as its side (README rule 4 and line 131): the runtime side as rosie_job, a Tool API call as rosie_app,
 * each with its scope's settings for the transaction. It runs in a savepoint rolled back after it, so it leaves nothing:
 * no row, no role, no setting.
 */
async function attempt(tx: Tx, action: Action): Promise<Outcome> {
  try {
    await tx.savepoint(async (sql) => {
      if (action.role === "runtime") await sql`set local role rosie_job`;
      else await sql`set local role rosie_app`;
      if (action.scope?.businessId !== undefined)
        await sql`select set_config('rosie.business_id', ${action.scope.businessId}, true)`;
      if (action.scope?.personId !== undefined)
        await sql`select set_config('rosie.person_id', ${action.scope.personId}, true)`;
      throw new Undone(await statementOf(sql, action));
    });
  } catch (error) {
    if (error instanceof Undone) return { rows: error.rows, refusal: null };
    return { rows: null, refusal: refusalOf(error) };
  }
  throw new Error("an action's savepoint ended without being rolled back");
}

/** One line per way an outcome misses what a refused fixture expects; none when it meets it. */
function expectProblems(outcome: Outcome, wanted: Expect): string[] {
  if (wanted.sqlstate !== undefined) {
    if (outcome.refusal === null) return [`must be refused with ${wanted.sqlstate}, but passes`];
    const { sqlstate, constraint, message } = outcome.refusal;
    const problems: string[] = [];
    if (sqlstate !== wanted.sqlstate)
      problems.push(`must be refused with ${wanted.sqlstate}, but is refused with ${sqlstate} ${message}`);
    if (wanted.constraintOneOf !== undefined && !wanted.constraintOneOf.includes(constraint ?? ""))
      problems.push(
        `must be refused by one of ${wanted.constraintOneOf.join(", ")}, but by ${constraint ?? "no constraint"}`,
      );
    return problems;
  }
  if (outcome.refusal !== null)
    return [`must touch ${String(wanted.rows)} rows, but is refused: ${outcome.refusal.message}`];
  return outcome.rows === wanted.rows
    ? []
    : [`must touch ${String(wanted.rows)} rows, but touches ${String(outcome.rows)}`];
}

/**
 * The CHECKs of the migrated sign_in_attempts a row breaks (its expression false), as an insert would meet them: the
 * row goes into a temporary copy of the table with its columns, not-nulls and defaults but no constraint, and each CHECK's
 * own expression, as PostgreSQL holds it, is read against it. A savepoint rolled back after it drops the copy.
 */
async function brokenChecks(tx: Tx, values: Values): Promise<string[]> {
  try {
    await tx.savepoint(async (sql) => {
      await sql`create temporary table check_probe (like sign_in_attempts including defaults)`;
      await insertOf(sql, "check_probe", TABLE, values);
      const columns = migratedChecks.map((check, n) => `(${check.expression}) as c${String(n)}`).join(", ");
      const [row] = await sql.unsafe<Record<string, boolean | null>[]>(`select ${columns} from check_probe`);
      const found = must(row, "the probe row");
      throw new RolledBack(
        migratedChecks.filter((_, n) => found[`c${String(n)}`] === false).map((check) => check.name),
      );
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.found as string[];
    throw error;
  }
  throw new Error("the probe's savepoint ended without being rolled back");
}

/** Inserts rows as the runtime side, the role ending with the inserts. */
async function insertAsRuntime(tx: Tx, table: string, rows: readonly Values[]): Promise<void> {
  await tx`set local role rosie_job`;
  for (const values of rows) await insertOf(tx, table, table, values);
  await tx`reset role`;
}

// ---------------------------------------------------------------------------------------------------------------
// README rule 9's three calls, as the Tool API (rosie_app) calls them

/** What sign_in_attempt answers (README line 192). */
interface Binding {
  id: string;
  person_id: string | null;
  owner_or_admin: boolean;
  proof_code_id: string | null;
  way: string;
  expires_at: Date;
  expired: boolean;
  wrong_tries: number;
  paused_until: Date | null;
  paused: boolean;
  signed_in: boolean;
  last_outcome: string | null;
}

/** What sign_in_attempt_tried answers (README line 193). */
interface Tried {
  repeated: boolean;
  wrong_tries: number;
  paused_until: Date | null;
  last_outcome: string | null;
}

/** An attempt's row as it stands, read as the tables' owner. */
interface AttemptState {
  wrong_tries: number;
  last_wrong_at: Date | null;
  paused_until: Date | null;
  last_check_sha256: string | null;
  last_outcome: string | null;
  session_id: string | null;
  version: number;
}

async function binding(
  tx: Tx,
  attemptId: string | null,
  device: string | null,
  at: string | null,
): Promise<Binding[]> {
  await tx`set local role rosie_app`;
  const rows = await tx<
    Binding[]
  >`select * from sign_in_attempt(${attemptId}, ${device}, ${at}::text::timestamptz)`;
  await tx`reset role`;
  return [...rows];
}

async function tried(
  tx: Tx,
  id: string | null,
  key: string | null,
  outcome: string | null,
  at: string | null,
): Promise<Tried[]> {
  await tx`set local role rosie_app`;
  const rows = await tx<Tried[]>`
    select * from sign_in_attempt_tried(${id}, ${key}, ${outcome}, ${at}::text::timestamptz)
  `;
  await tx`reset role`;
  return [...rows];
}

async function signedIn(tx: Tx, id: string | null, sessionId: string | null): Promise<boolean> {
  await tx`set local role rosie_app`;
  const [row] = await tx<{ done: boolean }[]>`select sign_in_attempt_signed_in(${id}, ${sessionId}) as done`;
  await tx`reset role`;
  return must(row, "sign_in_attempt_signed_in's answer").done;
}

async function checkCode(tx: Tx, codeId: string | null, typedHash: string, at: string): Promise<string> {
  await tx`set local role rosie_app`;
  const [row] = await tx<{ answer: string }[]>`
    select check_proof_code(${codeId}, ${typedHash}, ${at}::text::timestamptz) as answer
  `;
  await tx`reset role`;
  return must(row, "check_proof_code's answer").answer;
}

async function stateOf(tx: Tx, id: string): Promise<AttemptState> {
  const [row] = await tx<AttemptState[]>`
    select wrong_tries, last_wrong_at, paused_until, last_check_sha256, last_outcome, session_id, version
    from sign_in_attempts where id = ${id}
  `;
  return { ...must(row, `attempt ${id}`) };
}

/** The database's clock now, as ISO text to the microsecond: one check's own `at`. */
async function clockNow(tx: Tx): Promise<string> {
  const [row] = await tx<{ at: string }[]>`
    select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
  `;
  return must(row, "the clock").at;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The files

describe("K-22 v1.2 fixtures, read from the files (README section v1.2 and line 131)", () => {
  it("has an index that lists every fixture file and only those, each entry a seed or refused row of the part", () => {
    const report = checkContractFixtures(path.join("db-schema", PART));
    expect(report.problems).toEqual([]);
    expect(report.entries.filter((entry) => !entry.ok).map((entry) => entry.problems)).toEqual([]);
    expect(report.seedRows).toBe(entries.length);
  });

  it("selects v1.2's entries by their version: a seed and refused rows of the table v1.2 adds, each refused one with its one way to be put right and no other", () => {
    expect(versionAccepted.length).toBeGreaterThan(0);
    expect(versionRefused.length).toBeGreaterThan(0);
    expect(versionList.version).toBe(VERSION);
    expect(versionList.tables.map((table) => table.name)).toEqual([TABLE]);
    for (const entry of versionEntries) expect(entry.table, entry.file).toBe(TABLE);
    expect(sorted(Object.keys(PUT_RIGHT))).toEqual(sorted(versionRefused.map((entry) => entry.file)));
  });

  for (const entry of versionEntries) {
    it(`${entry.file} (${entry.version}) is in the README's file format, with K-22's additions`, () => {
      const content = readJson(fixturePath(entry.file));
      expect(formatProblems(content)).toEqual([]);
      const file = content as FixtureFile;
      if (entry.expect === "accept") {
        expect(file.refused, "an accepted fixture has no refused action").toBeUndefined();
        expect(file.rows.some((row) => row.table === entry.table)).toBe(true);
      } else {
        expect(file.refused?.table, "the table its entry names").toBe(entry.table);
      }
    });
  }

  for (const entry of versionRefused) {
    const fix = putRightOf(entry);
    it(`${entry.file}: refused for one reason, the one its entry shows (${fix?.reason ?? "no way to put it right"}); put right (${fix?.putRight ?? ""}), it changes nothing else`, () => {
      const action = refusedActionOf(entry.file);
      const { sqlstate, constraintOneOf } = action.expect;
      expect(sqlstate, "a refused v1.2 fixture names its SQLSTATE").toMatch(/^[0-9A-Z]{5}$/);
      expect(entry.shows).toContain(`SQLSTATE ${must(sqlstate)}`);
      if (sqlstate === "23514") {
        // A CHECK's refusal names exactly one constraint, a CHECK of v1.2's list, and the entry shows it.
        const [constraint, ...others] = must(constraintOneOf, "the CHECK it names");
        expect(others).toEqual([]);
        expect(listedChecks.map((check) => check.name)).toContain(constraint);
        expect(entry.shows).toContain(`CHECK ${must(constraint)}`);
        expect(must(fix).reason).toContain(`CHECK ${must(constraint)}`);
      } else {
        expect(constraintOneOf, "a grant's refusal names no constraint").toBeUndefined();
      }
      expect(differences(action, twinOf(entry))).toEqual(sorted(must(fix).changes));
    });
  }

  it("its refusal check fires on an outcome that misses its fixture: one that passes, one refused by another constraint or code, one that touches other rows", () => {
    const passes: Outcome = { rows: 1, refusal: null };
    const byOther: Outcome = {
      rows: null,
      refusal: { sqlstate: "23514", constraint: "sign_in_attempts_wrong_tries_range", message: "" },
    };
    const byGrant: Outcome = { rows: null, refusal: { sqlstate: "42501", constraint: null, message: "" } };
    const pause = { sqlstate: "23514", constraintOneOf: ["sign_in_attempts_pause_after_five"] };
    expect(expectProblems(passes, pause)).toEqual(["must be refused with 23514, but passes"]);
    expect(expectProblems(byOther, pause)).toEqual([
      "must be refused by one of sign_in_attempts_pause_after_five, but by sign_in_attempts_wrong_tries_range",
    ]);
    expect(expectProblems(byGrant, pause)[0]).toMatch(
      /^must be refused with 23514, but is refused with 42501/,
    );
    expect(expectProblems(passes, { rows: 0 })).toEqual(["must touch 0 rows, but touches 1"]);
    expect(expectProblems(byGrant, { sqlstate: "42501" })).toEqual([]);
  });

  it("put right, each hash the README keeps is in its CHECK's form, as the table list writes the form", () => {
    for (const constraint of ["sign_in_attempts_device_hash_form", "sign_in_attempts_contact_hash_form"]) {
      const check = must(listedChecks.find((each) => each.name === constraint));
      const match = must(/^(\w+) ~ '([^']+)'$/.exec(check.expression), `${constraint}'s form`);
      const [, column, pattern] = match;
      const twin = twinOf(refusedByConstraint(constraint));
      const refused = refusedActionOf(refusedByConstraint(constraint).file);
      expect(textOf(twin.values?.[must(column)])).toMatch(new RegExp(must(pattern)));
      expect(textOf(refused.values?.[must(column)])).not.toMatch(new RegExp(must(pattern)));
    }
  });

  it("the seed's attempt of Oct 28 and its twin with no account leave the same tries, pause and last answer on the fixture's own clock (README line 222)", () => {
    expect(noAccountAttempt.proof_code_id).toBeNull();
    expect(noAccountAttempt.owner_or_admin).toBe(false);
    expect(pausedAttempt.proof_code_id).not.toBeNull();
    expect(noAccountAttempt.started_at).toBe(pausedAttempt.started_at);
    for (const field of ["wrong_tries", "last_wrong_at", "paused_until", "last_outcome"])
      expect(noAccountAttempt[field], field).toEqual(pausedAttempt[field]);
    expect(pausedAttempt.wrong_tries).toBe(5);
    expect(new Date(textOf(pausedAttempt.paused_until)).toISOString()).toBe(
      later(textOf(pausedAttempt.last_wrong_at), 15 * MINUTE),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2 to 7. On PostgreSQL with every migration applied, 0034 among them

describe("K-22 v1.2 on PostgreSQL with every migration applied (T-1278's 0034 among them)", () => {
  beforeAll(async () => {
    db = await createTestDatabase({ name: "people_access_v1_2", client: { max: 1 }, database: "own" });
    qualified = `${db.schema}.${TABLE}`;
    const typed = await db.sql<{ key: string; type: string }[]>`
      select table_name || '.' || column_name as key, data_type as type from information_schema.columns
      where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea', 'timestamp with time zone')
    `;
    typedColumns = new Map(typed.map((column) => [column.key, column.type]));
    migratedChecks = [
      ...(await db.sql<{ name: string; expression: string }[]>`
        select c.conname::text as name, pg_get_expr(c.conbin, c.conrelid) as expression
        from pg_constraint c
        where c.conrelid = to_regclass(${qualified}) and c.contype = 'c'
        order by c.conname
      `),
    ];
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("2. the table and calls T-1278 migrated, against v1.2's table list and README rule 9", () => {
    const TYPE_NAMES: Readonly<Record<string, string>> = {
      text: "text",
      boolean: "boolean",
      integer: "integer",
      timestamptz: "timestamp with time zone",
    };
    const ON_DELETE: Readonly<Record<string, string>> = {
      restrict: "r",
      cascade: "c",
      "set null": "n",
      "no action": "a",
    };

    it(
      "holds the list's columns in its order, with their types, nulls and defaults, and no other",
      SLOW,
      async () => {
        const found = await db.sql<
          { name: string; type: string; notNull: boolean; defaultValue: string | null }[]
        >`
        select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as "notNull",
               pg_get_expr(d.adbin, d.adrelid) as "defaultValue"
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = to_regclass(${qualified}) and a.attnum > 0 and not a.attisdropped
        order by a.attnum
      `;
        expect([...found]).toEqual(
          attemptsTable.columns.map((column) => ({
            name: column.name,
            type: must(TYPE_NAMES[column.type], `a PostgreSQL name for ${column.type}`),
            notNull: !column.null,
            defaultValue: column.default ?? null,
          })),
        );
      },
    );

    it(
      "holds the list's primary key, foreign keys (on delete restrict), unique rules and CHECKs, by name, and no other",
      SLOW,
      async () => {
        const found = await db.sql<
          {
            name: string;
            kind: string;
            columns: string[];
            refTable: string | null;
            refColumns: string[] | null;
            onDelete: string;
          }[]
        >`
        select c.conname::text as name, c.contype::text as kind,
               array(
                 select a.attname::text from unnest(c.conkey) with ordinality k(num, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.num order by k.ord
               ) as columns,
               f.relname::text as "refTable",
               case when c.contype = 'f' then array(
                 select a.attname::text from unnest(c.confkey) with ordinality k(num, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.num order by k.ord
               ) end as "refColumns",
               c.confdeltype::text as "onDelete"
        from pg_constraint c
        left join pg_class f on f.oid = c.confrelid
        where c.conrelid = to_regclass(${qualified}) and c.contype <> 'n'
        order by c.conname
      `;
        const ofKind = (kind: string) => found.filter((constraint) => constraint.kind === kind);
        expect(ofKind("p").map((key) => key.columns)).toEqual([attemptsTable.primaryKey]);
        expect(
          ofKind("f").map(({ name, columns, refTable, refColumns, onDelete }) => ({
            name,
            columns,
            refTable,
            refColumns,
            onDelete,
          })),
        ).toEqual(
          sortedByName(
            (attemptsTable.foreignKeys ?? []).map((key) => ({
              name: must(key.name),
              columns: key.columns,
              refTable: key.references.table,
              refColumns: key.references.columns,
              onDelete: must(ON_DELETE[key.onDelete ?? "no action"]),
            })),
          ),
        );
        expect(ofKind("u").map(({ name, columns }) => ({ name, columns }))).toEqual(
          sortedByName(
            (attemptsTable.unique ?? []).map((key) => ({ name: must(key.name), columns: key.columns })),
          ),
        );
        expect(ofKind("c").map((check) => check.name)).toEqual(
          sorted(listedChecks.map((check) => check.name)),
        );
        expect(found.filter((constraint) => !["p", "f", "u", "c"].includes(constraint.kind))).toEqual([]);
      },
    );

    it("holds the list's two indexes, by name and columns, beside its keys' own", SLOW, async () => {
      const found = await db.sql<
        { name: string; columns: string[]; method: string; predicate: string | null }[]
      >`
        select i.relname::text as name,
               array(
                 select a.attname::text from unnest(x.indkey::int2[]) with ordinality k(num, ord)
                 join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.num order by k.ord
               ) as columns,
               am.amname::text as method, pg_get_expr(x.indpred, x.indrelid) as predicate
        from pg_index x
        join pg_class i on i.oid = x.indexrelid
        join pg_am am on am.oid = i.relam
        where x.indrelid = to_regclass(${qualified})
          and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.conrelid = x.indrelid)
        order by i.relname
      `;
      expect([...found]).toEqual(
        sortedByName(
          (attemptsTable.indexes ?? []).map((index) => ({
            name: index.name,
            columns: index.columns,
            method: index.using ?? "btree",
            predicate: index.where ?? null,
          })),
        ),
      );
    });

    it(
      "has row-level security on and not forced, with one policy, the runtime side's, on every row (rule 9)",
      SLOW,
      async () => {
        const [table] = await db.sql<{ enabled: boolean; forced: boolean }[]>`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
        from pg_class c where c.oid = to_regclass(${qualified})
      `;
        expect({ ...must(table) }).toEqual({ enabled: true, forced: false });
        expect(attemptsTable.rowLevelSecurity.scope).toBe("none");
        const policies = await db.sql<
          {
            name: string;
            permissive: string;
            roles: string[];
            cmd: string;
            qual: string;
            withCheck: string;
          }[]
        >`
        select p.policyname::text as name, p.permissive, p.roles::text[] as roles, p.cmd, p.qual,
               p.with_check as "withCheck"
        from pg_policies p where p.schemaname = ${db.schema} and p.tablename = ${TABLE}
      `;
        expect([...policies]).toEqual([
          {
            name: "sign_in_attempts_runtime",
            permissive: "PERMISSIVE",
            roles: ["rosie_job"],
            cmd: "ALL",
            qual: "true",
            withCheck: "true",
          },
        ]);
      },
    );

    it(
      "grants the runtime side SELECT, INSERT and UPDATE only, the Tool API nothing (not even a column), PUBLIC nothing, and neither role owns it (rule 9)",
      SLOW,
      async () => {
        const grants = await db.sql<{ grantee: string; privilege: string }[]>`
        select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee,
               a.privilege_type as privilege
        from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass(${qualified}) and a.grantee <> c.relowner
        order by 1, 2
      `;
        expect([...grants]).toEqual([
          { grantee: "rosie_job", privilege: "INSERT" },
          { grantee: "rosie_job", privilege: "SELECT" },
          { grantee: "rosie_job", privilege: "UPDATE" },
        ]);
        const [rights] = await db.sql<
          { columnGrants: number; appTable: boolean; appColumns: boolean; owner: string }[]
        >`
        select (select count(*)::int from pg_attribute a
                where a.attrelid = to_regclass(${qualified}) and a.attnum > 0 and a.attacl is not null) as "columnGrants",
               has_table_privilege('rosie_app', to_regclass(${qualified}),
                 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as "appTable",
               has_any_column_privilege('rosie_app', to_regclass(${qualified}), 'SELECT, INSERT, UPDATE, REFERENCES')
                 as "appColumns",
               pg_get_userbyid(c.relowner)::text as owner
        from pg_class c where c.oid = to_regclass(${qualified})
      `;
        const found = must(rights);
        expect({
          columnGrants: found.columnGrants,
          appTable: found.appTable,
          appColumns: found.appColumns,
        }).toEqual({
          columnGrants: 0,
          appTable: false,
          appColumns: false,
        });
        expect(["rosie_app", "rosie_job"]).not.toContain(found.owner);
      },
    );

    it(
      "carries 0002's version trigger: an update that does not raise the version is refused, one that does passes (rule 2)",
      SLOW,
      async () => {
        const [trigger, ...others] = await db.sql<{ name: string; definition: string }[]>`
        select t.tgname::text as name, pg_get_triggerdef(t.oid) as definition
        from pg_trigger t where t.tgrelid = to_regclass(${qualified}) and not t.tgisinternal
      `;
        expect(others).toEqual([]);
        expect(must(trigger).name).toBe("sign_in_attempts_version_raised");
        expect(must(trigger).definition).toMatch(
          /^CREATE TRIGGER sign_in_attempts_version_raised BEFORE UPDATE ON \S+ FOR EACH ROW EXECUTE FUNCTION \S*enforce_version_raise\(\)$/,
        );
        const id = textOf(pausedAttempt.id);
        const update = (version: number): Action => ({
          role: "runtime",
          scope: {},
          action: "update",
          table: TABLE,
          set: { last_outcome: "paused", version },
          where: { id },
          expect: {},
        });
        const version = pausedAttempt.version as number;
        const [kept, raised] = await rolledBack(async (tx) => {
          await load(tx, seedFiles.map(fixturePath));
          return [await attempt(tx, update(version)), await attempt(tx, update(version + 1))] as const;
        });
        expect(
          expectProblems(kept, { sqlstate: "23514", constraintOneOf: ["sign_in_attempts_version_raised"] }),
        ).toEqual([]);
        expect(raised).toEqual({ rows: 1, refusal: null });
      },
    );

    it(
      "makes the three calls as rule 9 states them: security definer, volatile, owned by the table's owner, search_path pinned to its schema then pg_temp, EXECUTE only to the two roles, the README's signatures",
      SLOW,
      async () => {
        const [{ owner } = { owner: "" }] = await db.sql<{ owner: string }[]>`
        select pg_get_userbyid(c.relowner)::text as owner from pg_class c where c.oid = to_regclass(${qualified})
      `;
        const calls = await db.sql<
          {
            name: string;
            arguments: string;
            result: string;
            language: string;
            volatility: string;
            securityDefiner: boolean;
            owner: string;
            config: string[];
            acl: string[];
          }[]
        >`
        select p.proname::text as name, pg_get_function_identity_arguments(p.oid) as arguments,
               pg_get_function_result(p.oid) as result, l.lanname::text as language,
               p.provolatile::text as volatility, p.prosecdef as "securityDefiner",
               pg_get_userbyid(p.proowner)::text as owner, coalesce(p.proconfig, '{}')::text[] as config,
               array(
                 select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end
                        || ' ' || a.privilege_type
                 from aclexplode(p.proacl) a order by 1
               ) as acl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
        where n.nspname = ${db.schema} and p.proname = any(${CALLS})
        order by p.proname
      `;
        // README rule 9, lines 192 to 201, in PostgreSQL's own words for each signature.
        const signatures: Record<string, { arguments: string; result: string; language: string }> = {
          sign_in_attempt: {
            arguments: "attempt_id text, device_sha256 text, at timestamp with time zone",
            result:
              "TABLE(id text, person_id text, owner_or_admin boolean, proof_code_id text, way text, expires_at timestamp with time zone, expired boolean, wrong_tries integer, paused_until timestamp with time zone, paused boolean, signed_in boolean, last_outcome text)",
            language: "sql",
          },
          sign_in_attempt_signed_in: {
            arguments: "id text, session_id text",
            result: "boolean",
            language: "plpgsql",
          },
          sign_in_attempt_tried: {
            arguments: "id text, check_sha256 text, outcome text, at timestamp with time zone",
            result:
              "TABLE(repeated boolean, wrong_tries integer, paused_until timestamp with time zone, last_outcome text)",
            language: "plpgsql",
          },
        };
        expect(calls.map((call) => call.name)).toEqual(sorted(CALLS));
        for (const call of calls) {
          expect({ ...call, acl: sorted(call.acl) }, call.name).toEqual({
            name: call.name,
            ...must(signatures[call.name]),
            volatility: "v",
            securityDefiner: true,
            owner,
            config: [`search_path=${db.schema}, pg_temp`],
            acl: sorted([`${owner} EXECUTE`, "rosie_app EXECUTE", "rosie_job EXECUTE"]),
          });
        }
      },
    );
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("3. v1.2's seed loads with its after chain and stores every value as given", () => {
    for (const entry of versionAccepted) {
      it(
        `loads ${entry.file} (${entry.version}); each of its own rows is stored as the file gives it`,
        SLOW,
        async () => {
          const rows = fixtureOf(entry.file).rows;
          const stored = await rolledBack(async (tx) => {
            await load(tx, [fixturePath(entry.file)]);
            const found: Record<string, unknown>[] = [];
            for (const row of rows) {
              const [one] = await tx<Record<string, unknown>[]>`
              select * from ${tx(row.table)} where id = ${textOf(row.values.id, "a row's id")}
            `;
              found.push({ ...must(one, `${row.table} ${textOf(row.values.id, "a row's id")}`) });
            }
            const [count] = await tx<{ count: number }[]>`select count(*)::int as count from ${tx(TABLE)}`;
            return { found, count: must(count).count };
          });
          expect(stored.count).toBe(ownRowsOf(entry.file, TABLE).length);
          rows.forEach((row, n) => {
            const kept = must(stored.found[n]);
            for (const [column, given] of Object.entries(row.values)) {
              const value = kept[column];
              const asStored = value instanceof Date ? value.toISOString() : value;
              const asGiven =
                value instanceof Date && typeof given === "string" ? new Date(given).toISOString() : given;
              expect(asStored, `${row.table} ${textOf(row.values.id, "a row's id")} ${column}`).toEqual(
                asGiven,
              );
            }
          });
        },
      );
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("4. each refused v1.2 fixture is refused for its one reason and, put right, passes", () => {
    for (const entry of versionRefused) {
      const fix = putRightOf(entry);
      it(
        `refuses ${entry.file} (${entry.version}) because ${fix?.reason ?? "(no way to put it right)"}; put right (${fix?.putRight ?? ""}), the same action passes on one row`,
        SLOW,
        async () => {
          const action = refusedActionOf(entry.file);
          const twin = twinOf(entry);
          const [refused, passed] = await rolledBack(async (tx) => {
            await load(tx, [fixturePath(entry.file)]);
            return [await attempt(tx, action), await attempt(tx, twin)] as const;
          });
          expect(expectProblems(refused, action.expect)).toEqual([]);
          expect(passed).toEqual({ rows: 1, refusal: null });
        },
      );
    }

    for (const entry of versionRefused.filter(
      (each) => refusedActionOf(each.file).expect.sqlstate === "23514",
    )) {
      const constraint = must(refusedActionOf(entry.file).expect.constraintOneOf?.[0]);
      it(
        `${entry.file}: of every CHECK on the migrated table, its row breaks ${constraint} and no other, and its twin none`,
        SLOW,
        async () => {
          const action = refusedActionOf(entry.file);
          expect(action.action).toBe("insert");
          const [ofRefused, ofTwin] = await rolledBack(
            async (tx) =>
              [
                await brokenChecks(tx, must(action.values)),
                await brokenChecks(tx, must(twinOf(entry).values)),
              ] as const,
          );
          expect(ofRefused).toEqual([constraint]);
          expect(ofTwin).toEqual([]);
        },
      );
    }

    for (const entry of versionRefused.filter((each) => refusedActionOf(each.file).role === "toolApi")) {
      it(
        `${entry.file}: the grant is its one reason: every Tool API read or write of the table is refused, with or without a person or a business, any one column, hash or not, while the runtime side reads the row`,
        SLOW,
        async () => {
          const action = refusedActionOf(entry.file);
          const personId = action.scope?.personId;
          const businessId = textOf(
            chainRows(fixturePath(entry.file), new Set()).find(
              (row) => row.table === "person_roles" && row.values.person_id === personId,
            )?.values.business_id,
            "a business of the call's person",
          );
          const scopes: Scope[] = [{}, { businessId }, { businessId, personId: must(personId) }];
          const columns = attemptsTable.columns.map((column) => column.name);
          const everyColumn: Action = { ...action };
          delete everyColumn.columns;
          const outcomes = await rolledBack(async (tx) => {
            await load(tx, [fixturePath(entry.file)]);
            const found: { what: string; outcome: Outcome }[] = [];
            for (const scope of scopes) {
              found.push({
                what: `select * with ${JSON.stringify(scope)}`,
                outcome: await attempt(tx, { ...everyColumn, scope }),
              });
            }
            for (const column of columns) {
              found.push({
                what: `select ${column}`,
                outcome: await attempt(tx, { ...action, columns: [column] }),
              });
            }
            found.push({
              what: "insert a fresh attempt",
              outcome: await attempt(tx, {
                ...everyColumn,
                action: "insert",
                values: freshAttempt("tool-api-insert"),
              }),
            });
            found.push({
              what: "update its last answer",
              outcome: await attempt(tx, {
                ...everyColumn,
                action: "update",
                set: { last_outcome: "paused", version: 99 },
              }),
            });
            found.push({ what: "the runtime side's read", outcome: await attempt(tx, twinOf(entry)) });
            return found;
          });
          const runtime = must(outcomes.pop());
          expect(runtime.outcome).toEqual({ rows: 1, refusal: null });
          expect(
            outcomes
              .filter(({ outcome }) => outcome.refusal?.sqlstate !== "42501")
              .map(({ what, outcome }) => `${what}: ${JSON.stringify(outcome)}`),
          ).toEqual([]);
        },
      );
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("5. each CHECK a refused v1.2 fixture names, pinned at its edges, and K-21's labels", () => {
    interface Edge {
      constraint: string;
      case: string;
      /** The values changed on the twin of the refused fixture that names the constraint. */
      change: Values;
      /** True when the edge is refused by the constraint, and by no other CHECK. */
      refused: boolean;
    }
    const hex64 = standIn("an edge's hash");
    const hashEdges = (constraint: string, column: string): Edge[] => [
      { constraint, case: "64 hex digits in lower case", change: { [column]: hex64 }, refused: false },
      {
        constraint,
        case: "64 hex digits in upper case",
        change: { [column]: hex64.toUpperCase() },
        refused: true,
      },
      { constraint, case: "63 hex digits", change: { [column]: hex64.slice(1) }, refused: true },
      { constraint, case: "65 hex digits", change: { [column]: `${hex64}0` }, refused: true },
      {
        constraint,
        case: "64 characters, one not hex",
        change: { [column]: `g${hex64.slice(1)}` },
        refused: true,
      },
      { constraint, case: "the empty text", change: { [column]: "" }, refused: true },
    ];
    const RANGE = "sign_in_attempts_wrong_tries_range";
    const PAUSE = "sign_in_attempts_pause_after_five";
    const OUTCOME = "sign_in_attempts_outcome_known";
    const labels = k21CheckLabels();
    /** The fifth wrong try of the pause fixture's twin: each pause edge is an instant after it. */
    const fifth = textOf(
      twinOf(refusedByConstraint(PAUSE)).values?.last_wrong_at,
      "the twin's fifth wrong try",
    );
    const EDGES: Edge[] = [
      ...hashEdges("sign_in_attempts_device_hash_form", "device_sha256"),
      ...hashEdges("sign_in_attempts_contact_hash_form", "contact_hash"),
      { constraint: RANGE, case: "five, paused 15 minutes after the fifth", change: {}, refused: false },
      {
        constraint: RANGE,
        case: "none, with no last wrong try and no pause",
        change: { wrong_tries: 0, last_wrong_at: null, paused_until: null },
        refused: false,
      },
      {
        constraint: RANGE,
        case: "four, with its last wrong try and no pause",
        change: { wrong_tries: 4, paused_until: null },
        refused: false,
      },
      { constraint: RANGE, case: "six (the fixture's count)", change: { wrong_tries: 6 }, refused: true },
      {
        constraint: RANGE,
        case: "minus one, with no last wrong try and no pause",
        change: { wrong_tries: -1, last_wrong_at: null, paused_until: null },
        refused: true,
      },
      {
        constraint: RANGE,
        case: "one, with no last wrong try",
        change: { wrong_tries: 1, last_wrong_at: null, paused_until: null },
        refused: true,
      },
      {
        constraint: RANGE,
        case: "none, with a last wrong try",
        change: { wrong_tries: 0, paused_until: null },
        refused: true,
      },
      { constraint: PAUSE, case: "five, paused 15 minutes after the fifth", change: {}, refused: false },
      {
        constraint: PAUSE,
        case: "four, with no pause",
        change: { wrong_tries: 4, paused_until: null },
        refused: false,
      },
      {
        constraint: PAUSE,
        case: "five, paused 10 minutes after the fifth (the fixture's pause)",
        change: { paused_until: later(fifth, 10 * MINUTE) },
        refused: true,
      },
      {
        constraint: PAUSE,
        case: "five, paused 15 minutes less a microsecond after the fifth",
        change: { paused_until: microBefore(later(fifth, 15 * MINUTE)) },
        refused: true,
      },
      {
        constraint: PAUSE,
        case: "five, paused 15 minutes and a microsecond after the fifth",
        change: { paused_until: microAfter(later(fifth, 15 * MINUTE)) },
        refused: true,
      },
      {
        constraint: PAUSE,
        case: "five, paused 16 minutes after the fifth",
        change: { paused_until: later(fifth, 16 * MINUTE) },
        refused: true,
      },
      { constraint: PAUSE, case: "five, with no pause", change: { paused_until: null }, refused: true },
      {
        constraint: PAUSE,
        case: "four, paused 15 minutes after the last",
        change: { wrong_tries: 4 },
        refused: true,
      },
      ...labels.map((label) => ({
        constraint: OUTCOME,
        case: `K-21's ${label}`,
        change: { last_outcome: label },
        refused: false,
      })),
      {
        constraint: OUTCOME,
        case: "no answer, with no check's key",
        change: { last_outcome: null, last_check_sha256: null },
        refused: false,
      },
      ...CODE_ANSWERS.filter((answer) => !labels.includes(answer)).map((answer) => ({
        constraint: OUTCOME,
        case: `check_proof_code's ${answer}, which is no K-21 label`,
        change: { last_outcome: answer },
        refused: true,
      })),
      {
        constraint: OUTCOME,
        case: "Wrong, in another case",
        change: { last_outcome: "Wrong" },
        refused: true,
      },
      {
        constraint: OUTCOME,
        case: "a session token (the fixture's)",
        change: { last_outcome: "placeholder-session-token-sam-0002" },
        refused: true,
      },
    ];

    it(
      "sends a time to the microsecond, so an edge a microsecond from a CHECK's instant reaches PostgreSQL unrounded",
      SLOW,
      async () => {
        const exact = microAfter(later(fifth, 15 * MINUTE));
        const kept = await rolledBack(async (tx) => {
          await tx`create temporary table check_probe (like sign_in_attempts including defaults)`;
          await insertOf(tx, "check_probe", TABLE, {
            ...must(twinOf(refusedByConstraint(PAUSE)).values),
            paused_until: exact,
          });
          const [row] = await tx<{ at: string }[]>`
          select to_char(paused_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from check_probe
        `;
          return must(row).at;
        });
        expect(kept).toBe(exact);
      },
    );

    it("pins every CHECK a refused v1.2 fixture names, and only those, on both sides of its edge", () => {
      const named = versionRefused.flatMap(
        (entry) => refusedActionOf(entry.file).expect.constraintOneOf ?? [],
      );
      for (const constraint of named) {
        expect(
          EDGES.some((edge) => edge.constraint === constraint && edge.refused),
          constraint,
        ).toBe(true);
        expect(
          EDGES.some((edge) => edge.constraint === constraint && !edge.refused),
          constraint,
        ).toBe(true);
      }
      expect(sorted([...new Set(EDGES.map((edge) => edge.constraint))])).toEqual(sorted(named));
      // The pause fixture's own pause is the 10-minute edge: the edges sit on the twin's own fifth try.
      const fixturePause = refusedActionOf(refusedByConstraint(PAUSE).file).values?.paused_until;
      expect(new Date(textOf(fixturePause)).toISOString()).toBe(later(fifth, 10 * MINUTE));
    });

    for (const edge of EDGES) {
      it(
        `${edge.constraint}: ${edge.case} ${edge.refused ? "is refused with 23514 by it, and by no other CHECK" : "passes and writes one row"}`,
        SLOW,
        async () => {
          const entry = refusedByConstraint(edge.constraint);
          const twin = twinOf(entry);
          const action: Action = { ...twin, values: { ...must(twin.values), ...edge.change } };
          const [outcome, broken] = await rolledBack(async (tx) => {
            await load(tx, [fixturePath(entry.file)]);
            return [await attempt(tx, action), await brokenChecks(tx, must(action.values))] as const;
          });
          if (edge.refused) {
            expect(
              expectProblems(outcome, { sqlstate: "23514", constraintOneOf: [edge.constraint] }),
            ).toEqual([]);
            expect(broken).toEqual([edge.constraint]);
          } else {
            expect(outcome).toEqual({ rows: 1, refusal: null });
            expect(broken).toEqual([]);
          }
        },
      );
    }

    it(
      "holds sign_in_attempts_outcome_known as K-21 v1's eight signInCheck labels, no more and no less, in the table list and as PostgreSQL holds it",
      SLOW,
      async () => {
        expect(labels.length).toBe(8);
        expect(new Set(labels).size).toBe(labels.length);
        const listed = must(listedChecks.find((check) => check.name === OUTCOME)).expression;
        expect(listed).toMatch(/^last_outcome in \(('[A-Za-z]+'(, )?)+\)$/);
        expect(sorted(quotedIn(listed))).toEqual(sorted(labels));
        const [found] = await db.sql<{ definition: string }[]>`
        select pg_get_constraintdef(c.oid) as definition from pg_constraint c
        where c.conrelid = to_regclass(${qualified}) and c.conname = ${OUTCOME}
      `;
        const definition = must(found, `${OUTCOME} on ${TABLE}`).definition;
        expect(definition).toMatch(/^CHECK \(\(last_outcome = ANY \(ARRAY\[[^\]]*\]\)\)\)$/);
        expect(sorted(quotedIn(definition))).toEqual(sorted(labels));
      },
    );
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("6. the three calls of rule 9, as the Tool API calls them", () => {
    const seed = (): string[] => seedFiles.map(fixturePath);

    it(
      "sign_in_attempt answers the attempt from its own device, with its state at `at` and no hash",
      SLOW,
      async () => {
        const at = later(textOf(pausedAttempt.started_at), 5 * MINUTE);
        const answers = await rolledBack(async (tx) => {
          await load(tx, seed());
          return binding(tx, textOf(pausedAttempt.attempt_id), textOf(pausedAttempt.device_sha256), at);
        });
        expect(answers).toEqual([
          {
            id: pausedAttempt.id,
            person_id: pausedAttempt.person_id,
            owner_or_admin: pausedAttempt.owner_or_admin,
            proof_code_id: pausedAttempt.proof_code_id,
            way: pausedAttempt.way,
            expires_at: new Date(textOf(pausedAttempt.expires_at)),
            expired: false,
            wrong_tries: pausedAttempt.wrong_tries,
            paused_until: new Date(textOf(pausedAttempt.paused_until)),
            paused: true,
            signed_in: false,
            last_outcome: pausedAttempt.last_outcome,
          },
        ]);
      },
    );

    it(
      "sign_in_attempt: in time at expires_at itself and expired a microsecond after; paused until paused_until and not at it; signed in once a session is named",
      SLOW,
      async () => {
        const expiresAt = textOf(pausedAttempt.expires_at);
        const pausedUntil = textOf(pausedAttempt.paused_until);
        const found = await rolledBack(async (tx) => {
          await load(tx, seed());
          const bind = async (at: string) =>
            must(
              (
                await binding(tx, textOf(pausedAttempt.attempt_id), textOf(pausedAttempt.device_sha256), at)
              )[0],
            );
          const signed = must(
            (
              await binding(
                tx,
                textOf(signedInAttempt.attempt_id),
                textOf(signedInAttempt.device_sha256),
                later(textOf(signedInAttempt.started_at), 2 * MINUTE),
              )
            )[0],
          );
          return {
            atExpiry: (await bind(expiresAt)).expired,
            afterExpiry: (await bind(microAfter(expiresAt))).expired,
            beforePauseEnds: (await bind(microBefore(pausedUntil))).paused,
            atPauseEnd: (await bind(pausedUntil)).paused,
            signedIn: signed.signed_in,
            notSignedIn: (await bind(expiresAt)).signed_in,
          };
        });
        expect(found).toEqual({
          atExpiry: false,
          afterExpiry: true,
          beforePauseEnds: true,
          atPauseEnd: false,
          signedIn: true,
          notSignedIn: false,
        });
      },
    );

    it(
      "sign_in_attempt answers no row, one answer for all, to an unknown attempt id, another device, and each NULL argument",
      SLOW,
      async () => {
        const attemptId = textOf(pausedAttempt.attempt_id);
        const device = textOf(pausedAttempt.device_sha256);
        const otherDevice = textOf(signedInAttempt.device_sha256);
        expect(otherDevice).not.toBe(device);
        const at = later(textOf(pausedAttempt.started_at), 5 * MINUTE);
        const found = await rolledBack(async (tx) => {
          await load(tx, seed());
          return [
            await binding(tx, "attempt-probe-unknown", device, at),
            await binding(tx, attemptId, otherDevice, at),
            await binding(tx, null, device, at),
            await binding(tx, attemptId, null, at),
            await binding(tx, attemptId, device, null),
          ];
        });
        expect(found).toEqual([[], [], [], [], []]);
      },
    );

    it(
      "sign_in_attempt locks the attempt FOR UPDATE for the rest of the caller's transaction, so checks of one attempt run one at a time",
      SLOW,
      async () => {
        const probe = freshAttempt("lock");
        const id = textOf(probe.id);
        const other = db.connect({
          max: 1,
          onnotice: () => undefined,
          connection: { search_path: `${db.schema}, public` },
        });
        try {
          // The one committed row of this file: an attempt of no account, which names no other row; deleted below.
          await db.sql.begin(async (tx) => {
            await insertAsRuntime(tx, TABLE, [probe]);
          });
          const during = await rolledBack(async (tx) => {
            const bound = await binding(
              tx,
              textOf(probe.attempt_id),
              textOf(probe.device_sha256),
              later(textOf(probe.started_at), MINUTE),
            );
            let blocked: string | null = null;
            try {
              await other`select id from sign_in_attempts where id = ${id} for update nowait`;
            } catch (error) {
              blocked = refusalOf(error).sqlstate;
            }
            return { bound: bound.length, blocked };
          });
          expect(during).toEqual({ bound: 1, blocked: "55P03" });
          const free = await other`select id from sign_in_attempts where id = ${id} for update nowait`;
          expect(free.length).toBe(1);
        } finally {
          await db.sql`delete from sign_in_attempts where id = ${id}`;
          await other.end({ timeout: 5 });
        }
        const [left] = await db.sql<{ count: number }[]>`select count(*)::int as count from sign_in_attempts`;
        expect(must(left).count).toBe(0);
      },
    );

    it(
      "sign_in_attempt_tried: the look writes nothing; five wrong tries count to five and pause 15 minutes from the fifth; a repeat answers its first result; a sixth counts nothing",
      SLOW,
      async () => {
        const fresh = freshAttempt("five");
        const id = textOf(fresh.id);
        const start = textOf(fresh.started_at);
        const key = (n: number) => standIn(`check ${String(n)}`);
        const atTry = (n: number) => later(start, n * MINUTE);
        const found = await rolledBack(async (tx) => {
          await load(tx, seed());
          await insertAsRuntime(tx, TABLE, [fresh]);
          const look = await tried(tx, id, key(0), null, atTry(0));
          const afterLook = await stateOf(tx, id);
          const tries: { answer: Tried[]; state: AttemptState }[] = [];
          for (let n = 1; n <= 5; n += 1)
            tries.push({
              answer: await tried(tx, id, key(n), "wrong", atTry(n)),
              state: await stateOf(tx, id),
            });
          const repeat = await tried(tx, id, key(5), "wrong", atTry(6));
          const afterRepeat = await stateOf(tx, id);
          const lookPaused = await tried(tx, id, key(6), null, atTry(6));
          const sixth = await tried(tx, id, key(7), "wrong", atTry(7));
          const afterSixth = await stateOf(tx, id);
          return { look, afterLook, tries, repeat, afterRepeat, lookPaused, sixth, afterSixth };
        });
        const pause = new Date(later(atTry(5), 15 * MINUTE));
        expect(found.look).toEqual([
          { repeated: false, wrong_tries: 0, paused_until: null, last_outcome: null },
        ]);
        expect(found.afterLook).toEqual({
          wrong_tries: 0,
          last_wrong_at: null,
          paused_until: null,
          last_check_sha256: null,
          last_outcome: null,
          session_id: null,
          version: 1,
        });
        found.tries.forEach(({ answer, state }, index) => {
          const n = index + 1;
          expect(answer, `try ${String(n)}`).toEqual([
            {
              repeated: false,
              wrong_tries: n,
              paused_until: n === 5 ? pause : null,
              last_outcome: n === 5 ? "paused" : "wrong",
            },
          ]);
          expect(state, `try ${String(n)}`).toEqual({
            wrong_tries: n,
            last_wrong_at: new Date(atTry(n)),
            paused_until: n === 5 ? pause : null,
            last_check_sha256: key(n),
            last_outcome: n === 5 ? "paused" : "wrong",
            session_id: null,
            version: 1 + n,
          });
        });
        expect(found.repeat).toEqual([
          { repeated: true, wrong_tries: 5, paused_until: pause, last_outcome: "paused" },
        ]);
        expect(found.afterRepeat.version).toBe(6);
        expect(found.lookPaused).toEqual([
          { repeated: false, wrong_tries: 5, paused_until: pause, last_outcome: "paused" },
        ]);
        expect(found.sixth).toEqual([
          { repeated: false, wrong_tries: 5, paused_until: pause, last_outcome: "paused" },
        ]);
        expect(found.afterSixth).toEqual({
          wrong_tries: 5,
          last_wrong_at: new Date(atTry(5)),
          paused_until: pause,
          last_check_sha256: key(7),
          last_outcome: "paused",
          session_id: null,
          version: 7,
        });
      },
    );

    it(
      "sign_in_attempt_tried: a wrong try counts at expires_at itself and not a microsecond after (expired); after the pause and the 10 minutes, expired; any other K-21 label is recorded and counts nothing",
      SLOW,
      async () => {
        const labels = k21CheckLabels().filter((label) => label !== "wrong");
        const found = await rolledBack(async (tx) => {
          await load(tx, seed());
          const atEnd = freshAttempt("at-end");
          const pastEnd = freshAttempt("past-end");
          const others = labels.map((label, n) => ({ label, row: freshAttempt(`label-${String(n)}`) }));
          await insertAsRuntime(tx, TABLE, [atEnd, pastEnd, ...others.map(({ row }) => row)]);
          const expiry = textOf(atEnd.expires_at);
          const atExpiry = await tried(tx, textOf(atEnd.id), standIn("at expiry"), "wrong", expiry);
          const pastExpiry = await tried(
            tx,
            textOf(pastEnd.id),
            standIn("past expiry"),
            "wrong",
            microAfter(expiry),
          );
          const pastState = await stateOf(tx, textOf(pastEnd.id));
          const recorded: { label: string; answer: Tried[]; state: AttemptState }[] = [];
          for (const { label, row } of others) {
            const id = textOf(row.id);
            recorded.push({
              label,
              answer: await tried(
                tx,
                id,
                standIn(`label ${label}`),
                label,
                later(textOf(row.started_at), MINUTE),
              ),
              state: await stateOf(tx, id),
            });
          }
          // The five tries of a fresh attempt, then a wrong check once both the pause and the 10 minutes are over.
          const spent = freshAttempt("spent");
          await insertAsRuntime(tx, TABLE, [spent]);
          const start = textOf(spent.started_at);
          for (let n = 1; n <= 5; n += 1)
            await tried(
              tx,
              textOf(spent.id),
              standIn(`spent ${String(n)}`),
              "wrong",
              later(start, n * MINUTE),
            );
          const overAll = await tried(
            tx,
            textOf(spent.id),
            standIn("spent 6"),
            "wrong",
            later(start, 21 * MINUTE),
          );
          return { atExpiry, pastExpiry, pastState, recorded, overAll };
        });
        expect(found.atExpiry).toEqual([
          { repeated: false, wrong_tries: 1, paused_until: null, last_outcome: "wrong" },
        ]);
        expect(found.pastExpiry).toEqual([
          { repeated: false, wrong_tries: 0, paused_until: null, last_outcome: "expired" },
        ]);
        expect(found.pastState).toMatchObject({ wrong_tries: 0, last_wrong_at: null, version: 2 });
        for (const { label, answer, state } of found.recorded) {
          expect(answer, label).toEqual([
            { repeated: false, wrong_tries: 0, paused_until: null, last_outcome: label },
          ]);
          expect(state, label).toMatchObject({
            wrong_tries: 0,
            last_wrong_at: null,
            last_outcome: label,
            version: 2,
          });
        }
        expect(found.overAll).toEqual([
          {
            repeated: false,
            wrong_tries: 5,
            paused_until: new Date(later(textOf(noAccountAttempt.started_at), 20 * MINUTE)),
            last_outcome: "expired",
          },
        ]);
      },
    );

    it(
      "sign_in_attempt_tried answers no row and writes nothing to a NULL id, key or time, a key not in hash form, an unknown id, or an outcome that is no K-21 label",
      SLOW,
      async () => {
        const fresh = freshAttempt("refused-calls");
        const id = textOf(fresh.id);
        const at = later(textOf(fresh.started_at), MINUTE);
        const key = standIn("a check");
        const outsiders = CODE_ANSWERS.filter((answer) => !k21CheckLabels().includes(answer));
        expect(outsiders.length).toBeGreaterThan(0);
        const found = await rolledBack(async (tx) => {
          await load(tx, seed());
          await insertAsRuntime(tx, TABLE, [fresh]);
          const answers = [
            await tried(tx, null, key, "wrong", at),
            await tried(tx, id, null, "wrong", at),
            await tried(tx, id, key, "wrong", null),
            await tried(tx, id, key.toUpperCase(), "wrong", at),
            await tried(tx, id, key.slice(1), "wrong", at),
            await tried(tx, id, "482913", "wrong", at),
            await tried(tx, "sign-in-probe-unknown", key, "wrong", at),
          ];
          for (const outsider of outsiders) answers.push(await tried(tx, id, key, outsider, at));
          return { answers, state: await stateOf(tx, id) };
        });
        expect(found.answers).toEqual(found.answers.map(() => []));
        expect(found.answers.length).toBe(7 + outsiders.length);
        expect(found.state).toMatchObject({
          wrong_tries: 0,
          last_check_sha256: null,
          last_outcome: null,
          version: 1,
        });
      },
    );

    it(
      "sign_in_attempt_signed_in names the session of the attempt's own code and person once; anything else writes nothing and answers false",
      SLOW,
      async () => {
        const code = must(seedCodes.find((values) => values.id === signedInAttempt.proof_code_id));
        const session = must(seedSessions.find((values) => values.id === signedInAttempt.session_id));
        const newCode: Values = { ...code, id: "code-probe-sign-in", code_hash: standIn("code probe") };
        const newAttempt: Values = {
          ...freshAttempt("signed-in", signedInAttempt),
          proof_code_id: newCode.id ?? null,
          version: 2,
        };
        const newSession: Values = {
          ...session,
          id: "session-probe-sign-in",
          token_sha256: standIn("session probe"),
          proof_code_id: newCode.id ?? null,
        };
        const jordanSession: Values = {
          ...newSession,
          id: "session-probe-jordan",
          person_id: "person-jordan",
        };
        const attemptId = textOf(newAttempt.id);
        const sessionId = textOf(newSession.id);
        const first = await rolledBack(async (tx) => {
          await load(tx, seed());
          await insertAsRuntime(tx, "proof_codes", [newCode]);
          await insertAsRuntime(tx, TABLE, [newAttempt]);
          await insertAsRuntime(tx, "sessions", [newSession]);
          const refused = [
            await signedIn(tx, attemptId, textOf(session.id)),
            await signedIn(tx, textOf(noAccountAttempt.id), sessionId),
            await signedIn(tx, attemptId, "session-probe-unknown"),
            await signedIn(tx, "sign-in-probe-unknown", sessionId),
            await signedIn(tx, null, sessionId),
            await signedIn(tx, attemptId, null),
          ];
          const before = await stateOf(tx, attemptId);
          const once = await signedIn(tx, attemptId, sessionId);
          const afterOnce = await stateOf(tx, attemptId);
          const twice = await signedIn(tx, attemptId, sessionId);
          const afterTwice = await stateOf(tx, attemptId);
          return { refused, before, once, afterOnce, twice, afterTwice };
        });
        expect(first.refused).toEqual([false, false, false, false, false, false]);
        expect(first.before).toMatchObject({ session_id: null, version: 2 });
        expect(first.once).toBe(true);
        expect(first.afterOnce).toMatchObject({ session_id: sessionId, version: 3 });
        expect(first.twice).toBe(false);
        expect(first.afterTwice).toMatchObject({ session_id: sessionId, version: 3 });
        // A session that names the attempt's code but another person: the code's one session, so a transaction of its own.
        const ofJordan = await rolledBack(async (tx) => {
          await load(tx, seed());
          await insertAsRuntime(tx, "proof_codes", [newCode]);
          await insertAsRuntime(tx, TABLE, [newAttempt]);
          await insertAsRuntime(tx, "sessions", [jordanSession]);
          return {
            answer: await signedIn(tx, attemptId, textOf(jordanSession.id)),
            state: await stateOf(tx, attemptId),
          };
        });
        expect(ofJordan).toMatchObject({ answer: false, state: { session_id: null, version: 2 } });
      },
    );
  });

  // -------------------------------------------------------------------------------------------------------------
  // README line 222 lists last_wrong_at among the fields the two twins leave equal. On a live database each check
  // reads its own clock (here its `at` is the database's clock_timestamp() at that check, as a check's time is the
  // moment it runs), so there "equal" means equal counts, equal outcomes and answers, and the same pause rule
  // (paused_until = last_wrong_at + 15 minutes) on each attempt; the two attempts' timestamps themselves are equal only
  // on a fixture's own clock, which seed-sign-in-attempt's two attempts of Oct 28 share (sections 1 and 3 compare those
  // literally). T-1284's reviews read line 222 the same way; the lead records its wording as a question.
  describe("6, the check. DL-526: an attempt with a code and its twin with none count the same tries (README lines 213 to 222)", () => {
    it(
      "five wrong checks, the first timed before its code's sent_at (the race), then a sixth: the two attempts answer alike at every check and end equal in counts, outcomes and the pause rule",
      SLOW,
      async () => {
        const typed = (n: number) => standIn(`a wrong code, check ${String(n)}`);
        const found = await rolledBack(async (tx) => {
          await load(tx, seedFiles.map(fixturePath));
          // Two attempts started now, on the database's clock (README default 16): Sam's, whose code comes after the
          // start's answer, and its twin for a contact no account holds, with no person and no code.
          const withCode: Values = { ...freshAttempt("race-code", pausedAttempt), proof_code_id: null };
          const withNone: Values = freshAttempt("race-none");
          await tx`set local role rosie_job`;
          for (const row of [withCode, withNone]) {
            await tx`
            insert into sign_in_attempts (
              id, attempt_id, request_sha256, device_sha256, contact_hash, hash_key_name, way, person_id,
              owner_or_admin, expires_at
            ) values (
              ${textOf(row.id)}, ${textOf(row.attempt_id)}, ${textOf(row.request_sha256)},
              ${textOf(row.device_sha256)}, ${textOf(row.contact_hash)}, ${textOf(row.hash_key_name)},
              ${textOf(row.way)}, ${row.person_id as string | null}, ${row.owner_or_admin as boolean},
              now() + interval '10 minutes'
            )
          `;
          }
          await tx`reset role`;
          // The first check of Sam's attempt takes its time now, before the send writes the code (README line 222).
          const raceAt = await clockNow(tx);
          // sendSignInCode's write on the runtime side: the code, sent on the database's clock, and the attempt's id of it.
          const code = must(seedCodes.find((values) => values.id === pausedAttempt.proof_code_id));
          const codeId = "code-probe-race";
          await tx`set local role rosie_job`;
          await tx`
          insert into proof_codes (
            id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at,
            expires_at
          )
          select ${codeId}, ${textOf(code.purpose)}, ${textOf(code.person_id)}, null,
                 ${textOf(code.sent_to_handle_id)}, ${textOf(code.channel)}, ${standIn("the race's code")},
                 ${textOf(code.hash_key_name)}, t.at, t.at + interval '10 minutes'
          from (select clock_timestamp() as at) t
        `;
          await tx`
          update sign_in_attempts a set proof_code_id = ${codeId}, version = a.version + 1
          where a.id = ${textOf(withCode.id)}
        `;
          await tx`reset role`;

          // README rule 9, "The check" (lines 213 to 218), as the Tool API, for checks whose code is never right.
          const check = async (row: Values, n: number, at: string) => {
            const [bound] = await binding(tx, textOf(row.attempt_id), textOf(row.device_sha256), at);
            const attempt = must(bound, "the attempt's binding");
            const key = checkKeyOf(attempt.id, textOf(row.device_sha256), `request-${String(n)}`);
            const [look] = await tried(tx, attempt.id, key, null, at);
            if (must(look).repeated) throw new Error("a new check's key must not be a repeat");
            let codeAnswer: string | null = null;
            let label = attempt.signed_in
              ? "alreadySignedIn"
              : attempt.paused
                ? "paused"
                : attempt.expired
                  ? "expired"
                  : null;
            if (label === null) {
              codeAnswer = await checkCode(tx, attempt.proof_code_id, typed(n), at);
              if (codeAnswer === "right" || codeAnswer === "used")
                throw new Error("every typed code here is wrong");
              // wrong, paused, expired and unknown: one wrong try of the attempt (line 218; DL-526's ruling, line 222).
              label = "wrong";
            }
            const [answer] = await tried(tx, attempt.id, key, label, at);
            return { codeAnswer, answer: must(answer, "the check's answer") };
          };

          const rounds: {
            code: Awaited<ReturnType<typeof check>>;
            none: Awaited<ReturnType<typeof check>>;
          }[] = [];
          for (let n = 1; n <= 6; n += 1) {
            const codeAt = n === 1 ? raceAt : await clockNow(tx);
            const ofCode = await check(withCode, n, codeAt);
            const ofNone = await check(withNone, n, await clockNow(tx));
            rounds.push({ code: ofCode, none: ofNone });
          }
          const [raced] = await tx<{ before: boolean }[]>`
          select ${raceAt}::text::timestamptz < c.sent_at as before from proof_codes c where c.id = ${codeId}
        `;
          const ends = await tx<
            { id: string; wrong_tries: number; last_outcome: string; pauseRule: boolean; paused: boolean }[]
          >`
          select a.id, a.wrong_tries, a.last_outcome,
                 a.paused_until = a.last_wrong_at + interval '15 minutes' as "pauseRule",
                 a.paused_until is not null as paused
          from sign_in_attempts a where a.id in (${textOf(withCode.id)}, ${textOf(withNone.id)})
          order by a.id
        `;
          const [codeEnd] = await tx<
            { wrong_tries: number; used: boolean; paused: boolean; countedAfterSend: boolean }[]
          >`
          select c.wrong_tries, c.used_at is not null as used, c.paused_until is not null as paused,
                 c.last_wrong_at > c.sent_at as "countedAfterSend"
          from proof_codes c where c.id = ${codeId}
        `;
          return { rounds, raced: must(raced).before, ends: [...ends], codeEnd: { ...must(codeEnd) } };
        });

        expect(found.raced, "the first check's time is before its code's sent_at").toBe(true);
        expect(found.rounds.map((round) => round.code.codeAnswer)).toEqual([
          "expired",
          "wrong",
          "wrong",
          "wrong",
          "wrong",
          null,
        ]);
        expect(found.rounds.map((round) => round.none.codeAnswer)).toEqual([
          "unknown",
          "unknown",
          "unknown",
          "unknown",
          "unknown",
          null,
        ]);
        // Equal answers at every check: the same count, the same last answer, and paused alike; the pause's instant is
        // each check's own clock plus 15 minutes.
        const shape = (answer: Tried) => ({
          repeated: answer.repeated,
          wrong_tries: answer.wrong_tries,
          last_outcome: answer.last_outcome,
          paused: answer.paused_until !== null,
        });
        found.rounds.forEach((round, index) => {
          expect(shape(round.code.answer), `check ${String(index + 1)}`).toEqual(shape(round.none.answer));
        });
        expect(found.rounds.map((round) => shape(round.code.answer))).toEqual([
          { repeated: false, wrong_tries: 1, last_outcome: "wrong", paused: false },
          { repeated: false, wrong_tries: 2, last_outcome: "wrong", paused: false },
          { repeated: false, wrong_tries: 3, last_outcome: "wrong", paused: false },
          { repeated: false, wrong_tries: 4, last_outcome: "wrong", paused: false },
          { repeated: false, wrong_tries: 5, last_outcome: "paused", paused: true },
          { repeated: false, wrong_tries: 5, last_outcome: "paused", paused: true },
        ]);
        expect(
          found.ends.map(({ wrong_tries, last_outcome, pauseRule, paused }) => ({
            wrong_tries,
            last_outcome,
            pauseRule,
            paused,
          })),
        ).toEqual([
          { wrong_tries: 5, last_outcome: "paused", pauseRule: true, paused: true },
          { wrong_tries: 5, last_outcome: "paused", pauseRule: true, paused: true },
        ]);
        // The code counted only the four checks made after it was sent: the race's expired check counted nothing there.
        expect(found.codeEnd).toEqual({ wrong_tries: 4, used: false, paused: false, countedAfterSend: true });
      },
    );
  });

  // -------------------------------------------------------------------------------------------------------------
  describe("7. every v1 and v1.1 fixture still holds with v1.2 migrated (README line 17), and every seed loads together", () => {
    it("selects the earlier entries by their version: each earlier version has seeds and refused rows", () => {
      const earlierVersions = [...new Set(earlierEntries.map((entry) => entry.version))];
      expect(earlierVersions.length).toBeGreaterThan(0);
      for (const version of earlierVersions) {
        expect(
          earlierEntries.some((entry) => entry.version === version && entry.expect === "accept"),
          version,
        ).toBe(true);
        expect(
          earlierEntries.some((entry) => entry.version === version && entry.expect === "refuse"),
          version,
        ).toBe(true);
      }
    });

    for (const entry of earlierEntries) {
      if (entry.expect === "accept") {
        it(
          `loads ${entry.file} (${entry.version}) with its after chain, and ${entry.table ?? "(no table)"} gets rows`,
          SLOW,
          async () => {
            const table = must(entry.table, `${entry.file}'s table`);
            const count = await rolledBack(async (tx) => {
              await load(tx, [fixturePath(entry.file)]);
              const [row] = await tx<{ count: number }[]>`select count(*)::int as count from ${tx(table)}`;
              return must(row).count;
            });
            expect(count).toBeGreaterThan(0);
          },
        );
      } else {
        it(`refuses ${entry.file} (${entry.version}) as its expect says`, SLOW, async () => {
          const action = refusedActionOf(entry.file);
          expect(action.table).toBe(entry.table);
          const outcome = await rolledBack(async (tx) => {
            await load(tx, [fixturePath(entry.file)]);
            return attempt(tx, action);
          });
          expect(expectProblems(outcome, action.expect)).toEqual([]);
        });
      }
    }

    it(
      "loads every K-22 seed of every version together, each file once, and every table of the part gets rows",
      SLOW,
      async () => {
        const counts = await rolledBack(async (tx) => {
          await load(
            tx,
            entries.filter((entry) => entry.expect === "accept").map((entry) => fixturePath(entry.file)),
          );
          const found: Record<string, number> = {};
          for (const table of partTables) {
            const [row] = await tx<{ count: number }[]>`select count(*)::int as count from ${tx(table)}`;
            found[table] = must(row).count;
          }
          return found;
        });
        expect(Object.keys(counts)).toEqual(partTables);
        expect(Object.entries(counts).filter(([, count]) => count === 0)).toEqual([]);
      },
    );
  });
});

/** Objects sorted by their name, as the catalog reads are ordered. */
function sortedByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
