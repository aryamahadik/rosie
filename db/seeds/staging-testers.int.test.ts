// T-1281: staging's human testers (db/seeds/staging-testers.ts; ADR-016 section 7's card H), against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/seeds/staging-testers`). Each block that needs a database migrates a
// fresh test schema of its own (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: two addresses give two proven accounts with standing; none gives no row; a second run adds
// nothing; no address in the repository or the output. With them, what K-22 v1.3 rule 10, default 29 and K-05 v1.15's
// "What the new tasks must hold to" bind this set to: a tester gets no role and no K-36 team row, shown here. Also: the
// list is read as the Resend adapter reads the same name; a sign-in by each address finds its tester's account; the
// listing of an inbox that leaves the list ends, and the inbox put back is listed again in a new row; each refusal
// writes nothing and names an entry by its place; a database error goes on with no address; two runs at once number
// each inbox once; T-201's runner prints counts alone.
//
// Every address here is at example.com (rule 9; the card: test addresses are example.com) and is handed to the set as
// STAGING_TEST_INBOXES in the env the set is given, as seed:staging hands the build Mac's list by name (T-1287); no test
// reads the environment's own list. Standings and the sign-in start run through db/repo's own calls as rosie_job, the
// runtime side, as K-05 v1.15 items 68 and 69 and v1.13 item 58 run; the tables' owner (the migrations' role) writes the
// states a refusal starts from and the stand-in sessions a standing is read with (each token's sha256 made at random,
// the hash of no token).
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readTestInboxes } from "../../adapters/src/email/resend-send/send";
import { resolvePrimaryUrl } from "../repo/client";
import { DataAccessDatabaseError } from "../repo/clocks";
import type { Sql } from "../repo/scope";
import { personStanding } from "../repo/sign-in-check";
import { startSignIn, type StartSignInRequest } from "../repo/sign-in-send";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { readTesterStanding } from "../repo/test-phone-reads";
import {
  emailHandleIdOf,
  INBOXES_VARIABLE,
  listingIdOf,
  personIdOf,
  seed,
  seedStagingTesters,
  type StagingTestersEnv,
  StagingTestersSeedError,
  type StagingTestersSeedResult,
  testInboxes,
} from "./staging-testers";

const RUNTIME_ROLE = "rosie_job";
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const SET_FILE = path.join(REPO, "db/seeds/staging-testers.ts");
const TEST_FILE = path.join(REPO, "db/seeds/staging-testers.int.test.ts");
// The set's tables, in the order its result names them and the runner prints them.
const TABLES = ["persons", "handles", "person_handles", "accounts", "staging_testers"] as const;
// The integration project's database, on this machine; the runner's line for it.
const LOCAL_URL = resolvePrimaryUrl();
const LOCAL = "the local database";
// The variables the runner and this set read: each child run sets only the ones it names.
const CHILD_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
  INBOXES_VARIABLE,
]);

// The testers' inboxes in this file: at example.com, a domain no inbox answers (RFC 2606).
const A = "t1281-tester-a@example.com";
const B = "t1281-tester-b@example.com";
const C = "t1281-tester-c@example.com";
const INBOXES = [A, B, C];

/** The list as seed:staging hands it: the addresses, comma-separated. */
const listOf = (...addresses: string[]): StagingTestersEnv => ({ [INBOXES_VARIABLE]: addresses.join(", ") });

/** The parts of an address no line, error or result may hold: the whole and its local part. */
const partsOf = (address: string): string[] => [address, address.slice(0, address.indexOf("@"))];

/** The parts of this file's addresses that `text` holds (none, when no address reached it). */
const addressPartsIn = (text: string): string[] =>
  INBOXES.flatMap(partsOf).filter((part) => text.toLowerCase().includes(part));

const counts = (rows: number, inserted: number) => ({ rows, inserted, kept: rows - inserted });

/** A run's table counts: `rows` in each of the set's five tables, `inserted` of them written. */
function tablesOf(rows: number, inserted: number): Record<string, unknown> {
  return Object.fromEntries(TABLES.map((table) => [table, counts(rows, inserted)]));
}

/** Rows in each of the set's five tables. */
async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    found[table] = row?.n ?? -1;
  }
  return found;
}

/** `n` rows in each of the set's five tables. */
const everyTable = (n: number): Record<string, number> =>
  Object.fromEntries(TABLES.map((table) => [table, n]));

/** Every row of the five tables, in key order, every column (versions and times included). */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    rows[table] = [...(await sql`select * from ${sql(table)} order by 1, 2`)];
  }
  return rows;
}

/** Each table's rows as the set writes them, in key order, with the columns that say what a tester is. */
async function testerRows(sql: Sql): Promise<Record<string, unknown[]>> {
  return {
    persons: [...(await sql`select id, name, language, version from persons order by id collate "C"`)],
    handles: [...(await sql`select id, kind, address from handles order by id collate "C"`)],
    person_handles: [
      ...(await sql`select person_id, handle_id from person_handles order by person_id collate "C"`),
    ],
    accounts: [
      ...(await sql`
        select person_id, mobile, mobile_proven_at, email, email_proven_at, version
        from accounts order by person_id collate "C"
      `),
    ],
    staging_testers: [
      ...(await sql`
        select id, person_id, added_at, removed_at, version from staging_testers order by id collate "C"
      `),
    ],
  };
}

/** Empties every table a block writes (truncating the heads cascades to the rest). */
async function empty(sql: Sql): Promise<void> {
  await sql`truncate businesses, persons, handles cascade`;
}

/** What a refused call threw. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the seed ran; it should have refused");
}

/** Connections that run as rosie_job, the runtime side's role, with `schema` first and no business scope. */
function runtimeClient(schema: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1281-staging-testers",
      search_path: `${schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/**
 * A live session for tester `n`, as a sign-in by a code to their own inbox leaves one (K-22 v1.3's
 * seed-staging-tester.json): a sign-in code sent to the tester's email handle and used at once, and a 30-day session
 * that names it. Written by the tables' owner; answers the stand-in token's sha256.
 */
async function signedIn(sql: Sql, n: number): Promise<string> {
  const tokenSha256 = randomBytes(32).toString("hex");
  const codeId = `code-t1281-${String(n)}-${tokenSha256.slice(0, 8)}`;
  await sql`
    insert into proof_codes (id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash,
                             hash_key_name, sent_at, expires_at, used_at, version)
    values (${codeId}, 'sign_in', ${personIdOf(n)}, null, ${emailHandleIdOf(n)}, 'email', ${"0".repeat(64)},
            'PROOF_CODE_HASH_KEY', now(), now() + interval '10 minutes', now(), 2)
  `;
  await sql`
    insert into sessions (id, person_id, token_sha256, device_sha256, proven_via, proof_code_id, started_at,
                          last_seen_at, expires_at)
    values (${`session-${codeId}`}, ${personIdOf(n)}, ${tokenSha256}, null, 'code', ${codeId}, now(), now(),
            now() + interval '30 days')
  `;
  return tokenSha256;
}

/** K-05 v1.15 item 68 for a session's token at this moment, on the runtime side. */
async function standingOf(runtime: Sql, tokenSha256: string): Promise<unknown> {
  return readTesterStanding(runtime, { tokenSha256, at: new Date().toISOString() });
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A sign-in start by `address`, as the page call would send it, its ids drawn from 128 random bits. */
function startRequest(address: string): StartSignInRequest {
  const nonce = randomBytes(16).toString("hex");
  return {
    id: `sign-in-t1281-${nonce}`,
    attemptId: `attempt-t1281-${nonce}`,
    requestSha256: sha256(`t1281:request:${nonce}`),
    deviceSha256: sha256(`t1281:device:${nonce}`),
    contact: { kind: "email", address },
    contactHash: sha256(`t1281:contact:${nonce}`),
    hashKeyName: "PROOF_CODE_HASH_KEY",
    way: "email",
  };
}

// ---- the runner, run as seed:staging runs it ------------------------------------------------------------------------

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node db/seeds/run.mjs --set staging-testers` with this environment's variables, less the child's own, plus `env`. */
function runSeed(env: Readonly<Record<string, string>>): Promise<Run> {
  const childEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CHILD_VARIABLES.has(name)) {
      childEnv[name] = value;
    }
  }
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RUNNER, "--set", "staging-testers"],
      { cwd: REPO, env: childEnv, timeout: 110_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        if (typeof code === "number") {
          resolve({ code, stdout, stderr });
        } else {
          reject(error ?? new Error("the runner ended with no exit code"));
        }
      },
    );
  });
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

/** The lines a successful run prints: the target, one line of row counts per table, and the totals. */
function seededLines(schema: string, rows: number, inserted: number): string[] {
  const plural = (n: number): string => `${String(n)} ${n === 1 ? "row" : "rows"}`;
  const kept = rows - inserted;
  return [
    `seed: set staging-testers into schema ${schema} on ${LOCAL}`,
    ...TABLES.map(
      (table) => `seed: ${table}: ${plural(rows)} (${String(inserted)} inserted, ${String(kept)} kept)`,
    ),
    `seed: done: set staging-testers into schema ${schema}: ${plural(rows * TABLES.length)} in 5 tables ` +
      `(${String(inserted * TABLES.length)} inserted, ${String(kept * TABLES.length)} kept)`,
  ];
}

// ---- the repository scan's helpers -----------------------------------------------------------------------------------

// Anything written like an email address, and the domains kept for examples, where no inbox answers (RFC 2606 and
// RFC 6761: example.com, example.net and example.org, and the names under .example, .invalid, .test and .localhost).
const ADDRESS_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RESERVED_DOMAIN = /^(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/;

/** Every file under a folder of the repository, recursively. */
function filesIn(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const file = path.join(folder, name);
    return statSync(file).isDirectory() ? filesIn(file) : [file];
  });
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

// ---- the tests -------------------------------------------------------------------------------------------------------

/** Lists the set refuses, and the place of the entry its refusal names. Each entry it refuses holds "t1281". */
const BAD_LISTS: readonly (readonly [string, number])[] = [
  ["t1281-not-an-address", 1],
  [`${A}, t1281-not-an-address`, 2],
  [`${A},,t1281-two@at@example.com`, 2],
  [`@t1281.example.com ${A}`, 1],
  [`${A} ${B}\nt1281-no-domain@`, 3],
];

describe("STAGING_TEST_INBOXES, read at run time as the Resend adapter reads the same name", () => {
  it("unset, blank or only separators: no inbox", () => {
    for (const value of [undefined, "", "   ", " , ,\n\t,"]) {
      expect(testInboxes(value), JSON.stringify(value)).toEqual([]);
    }
  });

  it("set: its addresses in lower case, separated by commas or white space, in the list's order, each once with the place of its first entry", () => {
    const value = ` ${A.toUpperCase()} , ${B}\n${C}\t${A} `;
    expect(testInboxes(value)).toEqual([
      { address: A, place: 1 },
      { address: B, place: 2 },
      { address: C, place: 3 },
    ]);
    expect(testInboxes(`${B},${A}`)).toEqual([
      { address: B, place: 1 },
      { address: A, place: 2 },
    ]);
  });

  it("refuses an entry that is not an address, naming its place and no part of the value", () => {
    for (const [value, place] of BAD_LISTS) {
      let error: unknown;
      try {
        testInboxes(value);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, value).toBeInstanceOf(StagingTestersSeedError);
      const message = (error as Error).message;
      expect(message, value).toContain(`${INBOXES_VARIABLE} entry ${String(place)} is not an email address`);
      expect(message, value).toContain("(no part of its value is shown)");
      expect(message.includes("t1281"), value).toBe(false);
      expect(message.includes("example"), value).toBe(false);
    }
  });

  it("names the inboxes the adapter's allow-list holds (one source for both: ADR-016 section 5), and refuses each list the adapter fails closed on", () => {
    for (const value of [A, `${B},${A}`, ` ${A.toUpperCase()} , ${B}\n${C}\t${A} `]) {
      const adapter = readTestInboxes(value);
      if (!adapter.ok) {
        throw new Error(`the adapter refused ${value}`);
      }
      expect(
        testInboxes(value).map((inbox) => inbox.address),
        value,
      ).toEqual([...adapter.inboxes]);
    }
    for (const [value] of BAD_LISTS) {
      expect(readTestInboxes(value), value).toEqual({ ok: false });
      expect(() => testInboxes(value), value).toThrow(StagingTestersSeedError);
    }
    // A list with no entry: the adapter allows no address, and the set seeds no tester.
    for (const value of ["", "  ", ", ,"]) {
      expect(readTestInboxes(value)).toEqual({ ok: false });
      expect(testInboxes(value)).toEqual([]);
    }
  });
});

describe("two addresses on a fresh schema", () => {
  let db: TestDatabase;
  let runtime: Sql;
  let first: StagingTestersSeedResult;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_testers" });
    runtime = runtimeClient(db.schema);
    first = await seedStagingTesters(db.sql, { env: listOf(A.toUpperCase(), B) });
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedStagingTesters);
  });

  it("writes as the job role, rosie_job: per address, a person, an email handle, its link, an account and a listing; the result names ids and counts, never an address", () => {
    expect(first).toEqual({
      ranAs: RUNTIME_ROLE,
      tables: tablesOf(2, 2),
      testers: [1, 2].map((n) => ({
        personId: personIdOf(n),
        emailHandleId: emailHandleIdOf(n),
        listingId: listingIdOf(n, 1),
      })),
      listingsEnded: 0,
    });
    expect(addressPartsIn(JSON.stringify(first))).toEqual([]);
  });

  it("two proven accounts: each address, in lower case, on its tester's email handle and account, proven when the tester was listed; no mobile", async () => {
    const at = expect.any(Date) as Date;
    const account = (n: number, email: string) => ({
      person_id: personIdOf(n),
      mobile: null,
      mobile_proven_at: null,
      email,
      email_proven_at: at,
      version: 1,
    });
    expect(await testerRows(db.sql)).toEqual({
      persons: [1, 2].map((n) => ({ id: personIdOf(n), name: null, language: null, version: 1 })),
      handles: [
        { id: emailHandleIdOf(1), kind: "email", address: A },
        { id: emailHandleIdOf(2), kind: "email", address: B },
      ],
      person_handles: [1, 2].map((n) => ({ person_id: personIdOf(n), handle_id: emailHandleIdOf(n) })),
      accounts: [account(1, A), account(2, B)],
      staging_testers: [1, 2].map((n) => ({
        id: listingIdOf(n, 1),
        person_id: personIdOf(n),
        added_at: at,
        removed_at: null,
        version: 1,
      })),
    });
    const [same] = await db.sql<{ n: number }[]>`
      select count(*)::int as n from accounts a join staging_testers t on t.person_id = a.person_id
      where a.email_proven_at = t.added_at
    `;
    expect(same?.n).toBe(2);
  }, 120_000);

  it("no role and no K-36 team row for a tester (K-22 v1.3 rule 10, default 29), and no company, phone, code or session of the set's", async () => {
    const ids = [personIdOf(1), personIdOf(2)];
    const [found] = await db.sql<Record<string, number>[]>`
      select
        (select count(*)::int from person_roles where person_id = any(${ids}::text[])) as roles,
        (select count(*)::int from team_page_recipients where person_id = any(${ids}::text[])) as team_rows,
        (select count(*)::int from companies where owner_person_id = any(${ids}::text[])) as companies,
        (select count(*)::int from phones p join person_handles l on l.handle_id = p.handle_id
          where l.person_id = any(${ids}::text[])) as phones,
        (select count(*)::int from proof_codes where person_id = any(${ids}::text[])) as codes,
        (select count(*)::int from sessions where person_id = any(${ids}::text[])) as sessions
    `;
    expect(found).toEqual({ roles: 0, team_rows: 0, companies: 0, phones: 0, codes: 0, sessions: 0 });
  }, 120_000);

  it("with standing: personStanding (K-05 v1.15 item 69) answers tester, no team and no role, and readTesterStanding (item 68) a live session of each tester's tester", async () => {
    for (const n of [1, 2]) {
      expect(await personStanding(runtime, { personId: personIdOf(n) })).toEqual({
        personId: personIdOf(n),
        roles: [],
        team: false,
        tester: true,
      });
      expect(await standingOf(runtime, await signedIn(db.sql, n))).toEqual({ standing: "tester" });
    }
  }, 120_000);

  it("a sign-in by each address finds its tester's account (K-05 v1.13 startSignIn, ADR-016 rule 4), and the code would go to the tester's own email handle", async () => {
    for (const [n, address] of [
      [1, A],
      [2, B],
    ] as const) {
      expect(await startSignIn(runtime, startRequest(address))).toMatchObject({
        result: "started",
        repeated: false,
        personId: personIdOf(n),
      });
      // sendSignInCode's step 3: the person's proven email and its handle, never the caller's.
      const handles = await runtime<{ handle_id: string }[]>`
        select h.id as handle_id from accounts a join handles h on h.address = a.email and h.kind = 'email'
        where a.person_id = ${personIdOf(n)} and a.email_proven_at is not null
      `;
      expect(handles).toEqual([{ handle_id: emailHandleIdOf(n) }]);
    }
  }, 120_000);

  it("a second run adds nothing: every row stays as it was, version and times included", async () => {
    const before = await snapshot(db.sql);
    const second = await seedStagingTesters(db.sql, { env: listOf(A, B) });
    expect(second).toEqual({ ...first, tables: tablesOf(2, 0) });
    expect(await snapshot(db.sql)).toEqual(before);
  }, 120_000);

  it("writes a row that went missing again, and changes nothing else", async () => {
    const before = await snapshot(db.sql);
    await db.sql`delete from person_handles where person_id = ${personIdOf(2)}`;
    await db.sql`delete from accounts where person_id = ${personIdOf(2)}`;
    const third = await seedStagingTesters(db.sql, { env: listOf(A, B) });
    expect(third.tables).toEqual({
      ...tablesOf(2, 0),
      person_handles: counts(2, 1),
      accounts: counts(2, 1),
    });
    const after = await snapshot(db.sql);
    expect({ ...after, accounts: [] }).toEqual({ ...before, accounts: [] });
    expect(await testerRows(db.sql)).toMatchObject({
      accounts: [
        { person_id: personIdOf(1), email: A },
        { person_id: personIdOf(2), email: B, email_proven_at: expect.any(Date) as Date },
      ],
    });
  }, 120_000);
});

describe("none gives no row", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_testers_none" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("with the list unset, blank or only separators: nothing written, every table at 0 rows", async () => {
    for (const value of [undefined, "", "   ", " , ,\n\t,"]) {
      const result = await seedStagingTesters(db.sql, { env: { [INBOXES_VARIABLE]: value } });
      expect(result, JSON.stringify(value)).toEqual({
        ranAs: RUNTIME_ROLE,
        tables: tablesOf(0, 0),
        testers: [],
        listingsEnded: 0,
      });
      expect(await rowCounts(db.sql)).toEqual(everyTable(0));
    }
  }, 120_000);

  it("with testers listed, a run with the list missing writes nothing and ends no listing", async () => {
    await seedStagingTesters(db.sql, { env: listOf(A, B) });
    const before = await snapshot(db.sql);
    for (const env of [{}, { [INBOXES_VARIABLE]: "" }]) {
      const result = await seedStagingTesters(db.sql, { env });
      expect(result).toEqual({ ranAs: RUNTIME_ROLE, tables: tablesOf(0, 0), testers: [], listingsEnded: 0 });
    }
    expect(await snapshot(db.sql)).toEqual(before);
  }, 120_000);
});

describe("an inbox that leaves the list, and comes back", () => {
  let db: TestDatabase;
  let runtime: Sql;
  const tokens = new Map<number, string>();

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_testers_ends" });
    runtime = runtimeClient(db.schema);
    // A person this set did not make, listed by the tables' owner: never ended by the set.
    await db.sql`insert into persons (id) values ('person-t1281-listed-elsewhere')`;
    await db.sql`
      insert into staging_testers (id, person_id, added_at)
      values ('listing-t1281-elsewhere', 'person-t1281-listed-elsewhere', now())
    `;
    await seedStagingTesters(db.sql, { env: listOf(A, B) });
    for (const n of [1, 2]) {
      tokens.set(n, await signedIn(db.sql, n));
    }
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  /** The listings, by id: whose, whether live, and the version. */
  async function listings(): Promise<unknown[]> {
    return [
      ...(await db.sql`
        select id, person_id, removed_at is null as live, version from staging_testers order by id collate "C"
      `),
    ];
  }

  const listing = (id: string, personId: string, live: boolean, version: number) => ({
    id,
    person_id: personId,
    live,
    version,
  });
  const elsewhere = listing("listing-t1281-elsewhere", "person-t1281-listed-elsewhere", true, 1);

  it("its tester's listing ends (removed_at set, the version raised by one), so the standing ends at once; the person, handle, account and session stay", async () => {
    const result = await seedStagingTesters(db.sql, { env: listOf(A) });
    expect(result).toEqual({
      ranAs: RUNTIME_ROLE,
      tables: tablesOf(1, 0),
      testers: [{ personId: personIdOf(1), emailHandleId: emailHandleIdOf(1), listingId: listingIdOf(1, 1) }],
      listingsEnded: 1,
    });
    expect(await listings()).toEqual([
      elsewhere,
      listing(listingIdOf(1, 1), personIdOf(1), true, 1),
      listing(listingIdOf(2, 1), personIdOf(2), false, 2),
    ]);
    expect(await personStanding(runtime, { personId: personIdOf(2) })).toEqual({
      personId: personIdOf(2),
      roles: [],
      team: false,
      tester: false,
    });
    expect(await standingOf(runtime, tokens.get(2) ?? "")).toEqual({ standing: "notTester" });
    expect(await standingOf(runtime, tokens.get(1) ?? "")).toEqual({ standing: "tester" });
    expect(await rowCounts(db.sql)).toEqual({
      persons: 3,
      handles: 2,
      person_handles: 2,
      accounts: 2,
      staging_testers: 3,
    });
    const [ended] = await db.sql<{ ended: boolean }[]>`
      select removed_at >= added_at as ended from staging_testers where id = ${listingIdOf(2, 1)}
    `;
    expect(ended?.ended).toBe(true);
  }, 120_000);

  it("put back on the list, the inbox lists its person again in a new row; the ended one is never reopened", async () => {
    const [endedBefore] = await db.sql<{ removed_at: Date }[]>`
      select removed_at from staging_testers where id = ${listingIdOf(2, 1)}
    `;
    const result = await seedStagingTesters(db.sql, { env: listOf(A, B) });
    expect(result.tables).toEqual({ ...tablesOf(2, 0), staging_testers: counts(2, 1) });
    expect(result.testers.map((tester) => tester.listingId)).toEqual([listingIdOf(1, 1), listingIdOf(2, 2)]);
    expect(result.listingsEnded).toBe(0);
    expect(await listings()).toEqual([
      elsewhere,
      listing(listingIdOf(1, 1), personIdOf(1), true, 1),
      listing(listingIdOf(2, 1), personIdOf(2), false, 2),
      listing(listingIdOf(2, 2), personIdOf(2), true, 1),
    ]);
    const [endedAfter] = await db.sql<{ removed_at: Date }[]>`
      select removed_at from staging_testers where id = ${listingIdOf(2, 1)}
    `;
    expect(endedAfter).toEqual(endedBefore);
    expect(await standingOf(runtime, tokens.get(2) ?? "")).toEqual({ standing: "tester" });
  }, 120_000);

  it("a new inbox takes the next number; the one that left the list ends; a listing of a person the set did not make never ends", async () => {
    const result = await seedStagingTesters(db.sql, { env: listOf(C, B) });
    expect(result).toEqual({
      ranAs: RUNTIME_ROLE,
      tables: tablesOf(2, 1),
      testers: [
        { personId: personIdOf(3), emailHandleId: emailHandleIdOf(3), listingId: listingIdOf(3, 1) },
        { personId: personIdOf(2), emailHandleId: emailHandleIdOf(2), listingId: listingIdOf(2, 2) },
      ],
      listingsEnded: 1,
    });
    expect(await listings()).toEqual([
      elsewhere,
      listing(listingIdOf(1, 1), personIdOf(1), false, 2),
      listing(listingIdOf(2, 1), personIdOf(2), false, 2),
      listing(listingIdOf(2, 2), personIdOf(2), true, 1),
      listing(listingIdOf(3, 1), personIdOf(3), true, 1),
    ]);
    expect(await standingOf(runtime, tokens.get(1) ?? "")).toEqual({ standing: "notTester" });
  }, 120_000);
});

describe("refuses, writing nothing", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_testers_refusals" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  beforeEach(async () => {
    await empty(db.sql);
  });

  /** The set refuses `env` for `reason`, naming no part of an address, and the five tables stay as they were. */
  async function expectRefused(env: StagingTestersEnv, reason: string): Promise<void> {
    const before = await snapshot(db.sql);
    const error = await refusal(seedStagingTesters(db.sql, { env }));
    expect(error).toBeInstanceOf(StagingTestersSeedError);
    expect(error.message).toContain(reason);
    expect(addressPartsIn(error.message)).toEqual([]);
    expect(await snapshot(db.sql)).toEqual(before);
  }

  it("a list with an entry that is not an address, before the database is reached", async () => {
    const unreachable = {
      begin: () => {
        throw new Error("the database was reached");
      },
    } as unknown as Sql;
    for (const [value, place] of BAD_LISTS) {
      const error = await refusal(seedStagingTesters(unreachable, { env: { [INBOXES_VARIABLE]: value } }));
      expect(error, value).toBeInstanceOf(StagingTestersSeedError);
      expect(error.message, value).toContain(
        `${INBOXES_VARIABLE} entry ${String(place)} is not an email address`,
      );
      expect(error.message.includes("t1281"), value).toBe(false);
    }
  });

  it("when another handle holds an inbox's address: the list's other inboxes are not seeded either", async () => {
    await db.sql`insert into handles (id, kind, address) values ('handle-t1281-someone', 'email', ${A})`;
    await expectRefused(listOf(B, A), `another handle holds the address of ${INBOXES_VARIABLE} entry 2`);
  }, 120_000);

  it("when another account holds a tester's address, so a sign-in by it would name no person (ADR-016 open point 14)", async () => {
    await seedStagingTesters(db.sql, { env: listOf(A) });
    await db.sql`insert into persons (id) values ('person-t1281-other')`;
    await db.sql`
      insert into accounts (person_id, email, email_proven_at) values ('person-t1281-other', ${A}, now())
    `;
    await expectRefused(listOf(A, B), `${INBOXES_VARIABLE} entry 1: another account holds its address`);
  }, 120_000);

  it("when a tester holds a live role (K-22 v1.3 rule 10)", async () => {
    await seedStagingTesters(db.sql, { env: listOf(A) });
    await db.sql`
      insert into businesses (id, name, display_name, time_zone)
      values ('biz-t1281', 'T1281 Shop', 'T1281 Shop', 'America/New_York')
    `;
    await db.sql`
      insert into person_roles (id, person_id, business_id, role)
      values ('role-t1281-owner', ${personIdOf(1)}, 'biz-t1281', 'owner')
    `;
    await expectRefused(listOf(A, B), `${INBOXES_VARIABLE} entry 1: its tester holds a live role`);
  }, 120_000);

  it("when a tester holds a live K-36 team row (build prompt 9.4)", async () => {
    await seedStagingTesters(db.sql, { env: listOf(A) });
    await db.sql`
      insert into team_page_recipients (id, person_id, chat_handle_id, email_handle_id, added_at)
      values ('team-t1281', ${personIdOf(1)}, null, ${emailHandleIdOf(1)}, now())
    `;
    await expectRefused(listOf(B, A), `${INBOXES_VARIABLE} entry 2: its tester holds a live team row`);
  }, 120_000);

  it("when another person writes from a tester's email handle", async () => {
    await seedStagingTesters(db.sql, { env: listOf(A) });
    await db.sql`insert into persons (id) values ('person-t1281-other')`;
    await db.sql`
      insert into person_handles (person_id, handle_id) values ('person-t1281-other', ${emailHandleIdOf(1)})
    `;
    await expectRefused(
      listOf(A),
      `${INBOXES_VARIABLE} entry 1: its tester is not the one person who writes from its email handle`,
    );
  }, 120_000);

  it("when a tester's account no longer holds its address proven", async () => {
    await seedStagingTesters(db.sql, { env: listOf(A) });
    await db.sql`
      update accounts set email_proven_at = null, version = version + 1 where person_id = ${personIdOf(1)}
    `;
    await expectRefused(
      listOf(A),
      `${INBOXES_VARIABLE} entry 1: its tester's account does not hold its address, proven`,
    );
  }, 120_000);

  it("a database error goes on as its SQLSTATE and names alone: no detail, statement or value, so no address", async () => {
    // A rule the tables' owner adds to this schema alone, which the account's insert breaks: PostgreSQL's own error
    // would carry the row, address included, in its detail and the statement's values in its parameters.
    await db.sql`alter table accounts add constraint t1281_no_email check (email is null) not valid`;
    try {
      const before = await snapshot(db.sql);
      const error = await refusal(seedStagingTesters(db.sql, { env: listOf(A) }));
      expect(error).toBeInstanceOf(DataAccessDatabaseError);
      expect(error).toMatchObject({ code: "23514", table: "accounts", constraint: "t1281_no_email" });
      const shown = `${inspect(error, { depth: 5 })} ${JSON.stringify(error)} ${error.message}`;
      expect(addressPartsIn(shown)).toEqual([]);
      expect(await snapshot(db.sql)).toEqual(before);
    } finally {
      await db.sql`alter table accounts drop constraint t1281_no_email`;
    }
  }, 120_000);

  it("and seeds an emptied schema with no such state, so each refusal above had its one reason", async () => {
    const result = await seedStagingTesters(db.sql, { env: listOf(A, B) });
    expect(result.tables).toEqual(tablesOf(2, 2));
  }, 120_000);
});

describe("two runs at once", () => {
  let db: TestDatabase;
  let one: Sql;
  let two: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_testers_together" });
    const options = {
      max: 1,
      onnotice: () => undefined,
      connection: { search_path: `${db.schema}, public` },
    };
    one = db.connect(options);
    two = db.connect(options);
  }, 120_000);

  afterAll(async () => {
    await one.end({ timeout: 5 });
    await two.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  it("number each inbox once, whichever lists it first (the set's advisory lock): both runs pass and agree", async () => {
    const [ab, ba] = await Promise.all([
      seedStagingTesters(one, { env: listOf(A, B) }),
      seedStagingTesters(two, { env: listOf(B, A) }),
    ]);
    const byAddress = (result: StagingTestersSeedResult, addresses: readonly string[]) =>
      new Map(addresses.map((address, index) => [address, result.testers[index]]));
    expect(byAddress(ab, [A, B])).toEqual(byAddress(ba, [B, A]));
    expect(await rowCounts(db.sql)).toEqual(everyTable(2));
  }, 120_000);
});

describe("node db/seeds/run.mjs --set staging-testers", () => {
  let db: TestDatabase;
  const local = (): Record<string, string> => ({ DATABASE_URL: LOCAL_URL, DB_SCHEMA: db.schema });

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_staging_testers_run" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it("with two inboxes on a fresh schema: a line of row counts per table, and no line holds any part of an address", async () => {
    const run = await runSeed({ ...local(), [INBOXES_VARIABLE]: `${A}, ${B}` });
    expect(run.code, run.stderr).toBe(0);
    expect(lines(run.stdout)).toEqual(seededLines(db.schema, 2, 2));
    expect(run.stderr).toBe("");
    expect(addressPartsIn(`${run.stdout}${run.stderr}`)).toEqual([]);
    expect(await rowCounts(db.sql)).toEqual(everyTable(2));
  }, 120_000);

  it("a second run adds nothing", async () => {
    const before = await snapshot(db.sql);
    const run = await runSeed({ ...local(), [INBOXES_VARIABLE]: `${B} ${A}` });
    expect(run.code, run.stderr).toBe(0);
    expect(lines(run.stdout)).toEqual(seededLines(db.schema, 2, 0));
    expect(addressPartsIn(`${run.stdout}${run.stderr}`)).toEqual([]);
    expect(await snapshot(db.sql)).toEqual(before);
  }, 120_000);

  it("with the list missing: 0 rows in every table, nothing written and no listing ended", async () => {
    const before = await snapshot(db.sql);
    const run = await runSeed(local());
    expect(run.code, run.stderr).toBe(0);
    expect(lines(run.stdout)).toEqual(seededLines(db.schema, 0, 0));
    expect(run.stderr).toBe("");
    expect(await snapshot(db.sql)).toEqual(before);
  }, 120_000);

  it("refuses an entry that is not an address: exit 1, naming the entry by its place and no part of the value, nothing written", async () => {
    await empty(db.sql);
    const run = await runSeed({ ...local(), [INBOXES_VARIABLE]: `${A}, t1281-not-an-address` });
    expect(run.code).toBe(1);
    expect(lines(run.stdout)).toEqual([`seed: set staging-testers into schema ${db.schema} on ${LOCAL}`]);
    expect(lines(run.stderr)).toEqual([
      `seed: failed: the staging testers seed refused, writing nothing: ${INBOXES_VARIABLE} entry 2 ` +
        "is not an email address (one @ with text on each side; entries are separated by commas or white " +
        "space) (no part of its value is shown)",
    ]);
    expect(addressPartsIn(`${run.stdout}${run.stderr}`)).toEqual([]);
    expect(run.stderr.includes("t1281")).toBe(false);
    expect(await rowCounts(db.sql)).toEqual(everyTable(0));
  }, 120_000);
});

describe("no address in the repository: the inboxes come from the environment at run time", () => {
  it("every address-like string in the seed sets (db/seeds, this set and its test included) is at a domain kept for examples, and this set holds none", () => {
    const files = filesIn(path.join(REPO, "db/seeds"));
    expect(files).toContain(SET_FILE);
    expect(files).toContain(TEST_FILE);
    const foreign: string[] = [];
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(ADDRESS_LIKE)) {
        if (!RESERVED_DOMAIN.test(domainOf(match[0]))) {
          foreign.push(`${path.relative(REPO, file)}: ${match[0]}`);
        }
      }
    }
    expect(foreign).toEqual([]);
    expect([...readFileSync(SET_FILE, "utf8").matchAll(ADDRESS_LIKE)].map((match) => match[0])).toEqual([]);
    for (const address of INBOXES) {
      expect(domainOf(address)).toBe("example.com");
    }

    // The scan catches an address written any common way, and tells a domain kept for examples from any other. The
    // samples are built here from parts, so this file holds no address outside those domains.
    const outside = ["t1281-probe", "probe-mail.org"].join("@");
    const inside = ["t1281-probe", "Example.COM"].join("@");
    for (const [written, reserved] of [
      [outside, false],
      [`<${outside}>`, false],
      [`mailto:${outside}`, false],
      [inside, true],
    ] as const) {
      const matches = [...written.matchAll(ADDRESS_LIKE)].map((match) => match[0]);
      expect(matches, written).toHaveLength(1);
      expect(RESERVED_DOMAIN.test(domainOf(matches[0] ?? "")), written).toBe(reserved);
    }
  });
});
