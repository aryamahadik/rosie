// T-1302: staging's check tester (db/seeds/check-tester.ts; K-05 v1.12 default 105), against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/seeds`). Each block migrates a fresh test schema of its own
// (db/repo/test-db.ts) and drops it at the end; the shared public schema is never touched.
//
// The card's proofs: the staging set loads on a fresh database with a stand-in hash; session_for_token(<that hash>,
// now()) answers the check tester's person, and its team row is live; the set refuses an absent hash, a hash in the wrong
// form and any target that is not staging's, each before any write (db/seeds/check-tester.test.ts shows each comes before
// the database is reached). Also: the session is bounded (SESSION_DAYS), a second run with one hash writes nothing, a new
// token replaces the old one, the check tester shares no handle with any roster phone (so the skeleton seed's refusal is
// kept), and T-201's runner, run as seed:staging runs it, refuses it on a database or schema that is not staging's.
//
// The set is told it runs on staging as the runner tells it, DATABASE_URL equal to STAGING_DATABASE_URL, here a made-up
// URL naming no real host (.invalid never resolves, RFC 6761) handed in as the set's env, while its client is this file's
// test schema. Reads that stand for K-05 v1.12 item 53 run as rosie_job with no business scope, as item 53 does; the
// tables' owner (the migrations' role) writes the states a refusal starts from. Every hash is made at random when the test
// runs, the hash of no token; every address is at example.com and every number in the fiction range (rule 9).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePrimaryUrl } from "../repo/client";
import type { Sql } from "../repo/scope";
import { handleTargets } from "../repo/targets";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import {
  CHECK_TESTER,
  type CheckTesterEnv,
  CheckTesterSeedError,
  type CheckTesterSeedResult,
  CODE_HASH_KEY_NAME,
  NO_CODE_HASH,
  seedCheckTester,
  SESSION_DAYS,
  TOKEN_HASH_VARIABLE,
} from "./check-tester";
import { ROSTER } from "./lib/roster";
import { seedSkeleton, TEST_OWNER_1 } from "./skeleton";
import { seedStagingCore } from "./staging-core";

const SLOW = { timeout: 120_000 };
const RUNTIME_ROLE = "rosie_job";
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER = fileURLToPath(new URL("./run.mjs", import.meta.url));
// Made up (see the top of this file).
const STAGING_URL = "postgres://staging-t1302.example.invalid/rosie_staging";
// The integration project's database, on this machine; the runner's lines for it.
const LOCAL_URL = resolvePrimaryUrl();
const LOCAL = "the local database";
const STAGING = "the staging database (STAGING_DATABASE_URL)";
const TABLES = [
  "persons",
  "handles",
  "person_handles",
  "team_page_recipients",
  "proof_codes",
  "sessions",
] as const;
// The variables the runner and this set read: each child run sets only the ones it names.
const CHILD_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
  TOKEN_HASH_VARIABLE,
]);

const { personId, emailHandleId, email, teamRowId } = CHECK_TESTER;

/** A stand-in for the token's sha256: 64 lower-case hex characters made at random, the hash of no token. */
const standInHash = (): string => randomBytes(32).toString("hex");

/** The variables seed:staging hands the set on staging, with `hash` as the token's sha256 (undefined: unset). */
const onStaging = (hash: string | undefined): CheckTesterEnv => ({
  DATABASE_URL: STAGING_URL,
  STAGING_DATABASE_URL: STAGING_URL,
  DB_SCHEMA: "public",
  [TOKEN_HASH_VARIABLE]: hash,
});

const counts = (rows: number, inserted: number) => ({ rows, inserted, kept: rows - inserted });

/** A run's table counts: one row in each table, `fixed` of the four fixed rows and `session` of the session's two written. */
function tablesOf(fixed: number, session: number): Record<string, unknown> {
  return {
    persons: counts(1, fixed),
    handles: counts(1, fixed),
    person_handles: counts(1, fixed),
    team_page_recipients: counts(1, fixed),
    proof_codes: counts(1, session),
    sessions: counts(1, session),
  };
}

/** Connections that run as rosie_job, the runtime side's role, with `schema` first and no business scope. */
function runtimeClient(schema: string): Sql {
  return postgres(resolvePrimaryUrl(), {
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1302-check-tester",
      search_path: `${schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/**
 * K-05 v1.12 item 53's two steps, as rosie_job in one read-only transaction: the live session the hash names now
 * through session_for_token, then a live team row of its person.
 */
async function standingOf(runtime: Sql, tokenSha256: string): Promise<string> {
  return runtime.begin("read only", async (tx) => {
    const [session] = await tx<{ person_id: string }[]>`
      select person_id from session_for_token(${tokenSha256}, now())
    `;
    if (session === undefined) {
      return "noSession";
    }
    const [team] = await tx<{ n: number }[]>`
      select count(*)::int as n from team_page_recipients where person_id = ${session.person_id} and removed_at is null
    `;
    return team?.n === 1 ? "tester" : "notTester";
  });
}

/** Rows in each of the six tables. */
async function rowCounts(sql: Sql): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const table of TABLES) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    found[table] = row?.n ?? -1;
  }
  return found;
}

/** Every row of the six tables, in key order, every column (versions and times included). */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    rows[table] = [...(await sql`select * from ${sql(table)} order by 1, 2`)];
  }
  return rows;
}

/** Empties every table of a test schema (truncating the heads cascades to the rest). */
async function empty(sql: Sql): Promise<void> {
  await sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
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

/** The set refuses `hash` for `reason`, never naming the hash, and every row of the six tables stays as it was. */
async function expectRefused(sql: Sql, hash: string, reason: string): Promise<void> {
  const before = await snapshot(sql);
  const error = await refusal(seedCheckTester(sql, { env: onStaging(hash) }));
  expect(error).toBeInstanceOf(CheckTesterSeedError);
  expect(error.message).toContain(reason);
  expect(error.message.includes(hash)).toBe(false);
  expect(await snapshot(sql)).toEqual(before);
}

describe("the staging set on a fresh database, with a stand-in hash", () => {
  let db: TestDatabase;
  let runtime: Sql;
  const hash = standInHash();
  let first: CheckTesterSeedResult;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_check_tester" });
    runtime = runtimeClient(db.schema);
    first = await seedCheckTester(db.sql, { env: onStaging(hash) });
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  it("loads as the job role, rosie_job, with no business scope: one row in each of its six tables", async () => {
    expect(first).toEqual({
      ranAs: RUNTIME_ROLE,
      tables: tablesOf(1, 1),
      checkTester: {
        personId,
        emailHandleId,
        teamRowId,
        sessionId: "session-check-tester-1",
        proofCodeId: "code-check-tester-1",
        sessionExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as string,
      },
      sessionsEnded: 0,
    });
    expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 1])));
  });

  it("writes default 105's rows: a person with no name, its email handle at example.com, a live team row reaching that handle alone, a used sign-in code by email whose hash is of no code, and a live session holding the hash, proven by code, with no device", async () => {
    expect([...(await db.sql`select id, name, language, version from persons`)]).toEqual([
      { id: personId, name: null, language: null, version: 1 },
    ]);
    expect([...(await db.sql`select id, kind, address from handles`)]).toEqual([
      { id: emailHandleId, kind: "email", address: email },
    ]);
    expect([...(await db.sql`select person_id, handle_id from person_handles`)]).toEqual([
      { person_id: personId, handle_id: emailHandleId },
    ]);
    expect([
      ...(await db.sql`
        select id, person_id, chat_handle_id, email_handle_id, removed_at, version from team_page_recipients
      `),
    ]).toEqual([
      {
        id: teamRowId,
        person_id: personId,
        chat_handle_id: null,
        email_handle_id: emailHandleId,
        removed_at: null,
        version: 1,
      },
    ]);
    expect([
      ...(await db.sql`
        select id, purpose, person_id, business_id, sent_to_handle_id, channel, code_hash, hash_key_name,
               expires_at = sent_at + interval '10 minutes' as ten_minutes, used_at = sent_at as used_at_once,
               wrong_tries, last_wrong_at, paused_until, version
        from proof_codes
      `),
    ]).toEqual([
      {
        id: "code-check-tester-1",
        purpose: "sign_in",
        person_id: personId,
        business_id: null,
        sent_to_handle_id: emailHandleId,
        channel: "email",
        code_hash: NO_CODE_HASH,
        hash_key_name: CODE_HASH_KEY_NAME,
        ten_minutes: true,
        used_at_once: true,
        wrong_tries: 0,
        last_wrong_at: null,
        paused_until: null,
        version: 2,
      },
    ]);
    expect([
      ...(await db.sql`
        select id, person_id, token_sha256 = ${hash} as holds_the_hash, device_sha256, proven_via, proof_code_id,
               last_seen_at = started_at as seen_at_start, ended_at, ended_why, version
        from sessions
      `),
    ]).toEqual([
      {
        id: "session-check-tester-1",
        person_id: personId,
        holds_the_hash: true,
        device_sha256: null,
        proven_via: "code",
        proof_code_id: "code-check-tester-1",
        seen_at_start: true,
        ended_at: null,
        ended_why: null,
        version: 1,
      },
    ]);
  });

  it("session_for_token(<that hash>, now()) answers the check tester's person, and its team row is live: K-05 item 53 reads tester", async () => {
    expect([...(await runtime`select session_id, person_id from session_for_token(${hash}, now())`)]).toEqual(
      [{ session_id: "session-check-tester-1", person_id: personId }],
    );
    expect([
      ...(await runtime`
        select id, removed_at from team_page_recipients where person_id = ${personId} and removed_at is null
      `),
    ]).toEqual([{ id: teamRowId, removed_at: null }]);
    expect(await standingOf(runtime, hash)).toBe("tester");
    expect(await standingOf(runtime, standInHash())).toBe("noSession");
  });

  it(`the session is bounded: it ends ${String(SESSION_DAYS)} days after it starts, so session_for_token finds it a second before that end and not at it`, async () => {
    const [session] = await db.sql<{ expires_at: Date; bounded: boolean; started_now: boolean }[]>`
      select expires_at, expires_at = started_at + make_interval(days => ${SESSION_DAYS}) as bounded,
             started_at between now() - interval '10 minutes' and now() as started_now
      from sessions
    `;
    expect(SESSION_DAYS).toBe(30);
    expect(session?.bounded).toBe(true);
    expect(session?.started_now).toBe(true);
    expect(first.checkTester.sessionExpiresAt).toBe(session?.expires_at.toISOString());
    // At the stored end itself, read in SQL: it holds microseconds, which a JavaScript Date cuts to milliseconds.
    const [edges] = await runtime<{ before: number; at: number }[]>`
      select (select count(*)::int from session_for_token(${hash}, s.expires_at - interval '1 second')) as before,
             (select count(*)::int from session_for_token(${hash}, s.expires_at)) as at
      from sessions s where s.id = 'session-check-tester-1'
    `;
    expect(edges).toEqual({ before: 1, at: 0 });
  });

  it("the check tester is no roster phone's person: no role, no company, no phone; its one handle is its own email handle", async () => {
    const [links] = await db.sql<{ roles: number; companies: number; handles: string[]; phones: number }[]>`
      select (select count(*)::int from person_roles where person_id = ${personId}) as roles,
             (select count(*)::int from companies where owner_person_id = ${personId}) as companies,
             (select array_agg(h.kind || ':' || h.id order by h.id) from person_handles l join handles h on h.id = l.handle_id
              where l.person_id = ${personId}) as handles,
             (select count(*)::int from phones where handle_id = ${emailHandleId}) as phones
    `;
    expect(links).toEqual({ roles: 0, companies: 0, handles: [`email:${emailHandleId}`], phones: 0 });
  });

  it(
    "runs twice with one hash: the second run writes nothing, and every row stays as it was, version included",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      const second = await seedCheckTester(db.sql, { env: onStaging(hash) });
      expect(second).toEqual({ ...first, tables: tablesOf(0, 0) });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "writes a fixed row that went missing again, as the first run wrote it, and changes nothing else",
    SLOW,
    async () => {
      const before = await snapshot(db.sql);
      await db.sql`delete from person_handles where person_id = ${personId}`;
      const third = await seedCheckTester(db.sql, { env: onStaging(hash) });
      expect(third.tables).toEqual({ ...tablesOf(0, 0), person_handles: counts(1, 1) });
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "a new token replaces the old: its sign-in code and session are written, the old session ends signed out in the same run, and the old hash opens nothing",
    SLOW,
    async () => {
      const next = standInHash();
      const replaced = await seedCheckTester(db.sql, { env: onStaging(next) });
      expect(replaced).toMatchObject({
        tables: tablesOf(0, 1),
        checkTester: { sessionId: "session-check-tester-2", proofCodeId: "code-check-tester-2" },
        sessionsEnded: 1,
      });
      expect([
        ...(await db.sql`
          select id, ended_why, ended_at = (select started_at from sessions where id = 'session-check-tester-2')
                 as ended_at_the_new_start, version
          from sessions order by id
        `),
      ]).toEqual([
        { id: "session-check-tester-1", ended_why: "signed_out", ended_at_the_new_start: true, version: 2 },
        { id: "session-check-tester-2", ended_why: null, ended_at_the_new_start: null, version: 1 },
      ]);
      expect(await standingOf(runtime, hash)).toBe("noSession");
      expect(await standingOf(runtime, next)).toBe("tester");
      expect(await rowCounts(db.sql)).toEqual({
        ...Object.fromEntries(TABLES.map((t) => [t, 1])),
        proof_codes: 2,
        sessions: 2,
      });
    },
  );

  it(
    "refuses the replaced token's hash: a session is never brought back, and nothing is written",
    SLOW,
    async () => {
      await expectRefused(db.sql, hash, "the check tester's session for the hash has ended or lapsed");
    },
  );
});

describe("refuses, writing nothing", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_check_tester_refusals" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  beforeEach(async () => {
    await empty(db.sql);
  });

  it(
    "an absent hash, a hash in the wrong form and any target that is not staging's: each refused before any write",
    SLOW,
    async () => {
      const valid = onStaging(standInHash());
      const cases: readonly [string, CheckTesterEnv, string][] = [
        ["an absent hash", onStaging(undefined), `${TOKEN_HASH_VARIABLE} is not set`],
        ["an empty hash", onStaging(""), `${TOKEN_HASH_VARIABLE} is not set`],
        ["upper-case hex", onStaging(standInHash().toUpperCase()), "is not 64 lower-case hex characters"],
        ["63 characters", onStaging(standInHash().slice(1)), "is not 64 lower-case hex characters"],
        [
          "a database on this machine",
          { ...valid, DATABASE_URL: LOCAL_URL },
          "does not name the staging database",
        ],
        [
          "no staging database named",
          { ...valid, STAGING_DATABASE_URL: undefined },
          "does not name the staging database",
        ],
        ["no database named", { ...valid, DATABASE_URL: undefined }, "does not name the staging database"],
        [
          "a preview's schema",
          { ...valid, DB_SCHEMA: "preview_t1302" },
          "DB_SCHEMA names a schema other than public",
        ],
      ];
      for (const [what, env, says] of cases) {
        const error = await refusal(seedCheckTester(db.sql, { env }));
        expect(error, what).toBeInstanceOf(CheckTesterSeedError);
        expect(error.message, what).toContain(says);
      }
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );

  it("a hash whose session lapsed: the token is replaced, never its session renewed", SLOW, async () => {
    const hash = standInHash();
    await seedCheckTester(db.sql, { env: onStaging(hash) });
    await db.sql`
      update sessions set started_at = now() - interval '31 days', last_seen_at = now() - interval '31 days',
                          expires_at = now() - interval '1 day', version = version + 1
    `;
    await expectRefused(db.sql, hash, "the check tester's session for the hash has ended or lapsed");
  });

  it("a hash another person's session holds", SLOW, async () => {
    const hash = standInHash();
    await db.sql.begin(async (tx) => {
      await tx`insert into persons (id) values ('person-other')`;
      await tx`insert into handles (id, kind, address) values ('handle-other-email', 'email', 'other@example.com')`;
      await tx`insert into person_handles (person_id, handle_id) values ('person-other', 'handle-other-email')`;
      await tx`
        insert into proof_codes (id, purpose, person_id, sent_to_handle_id, channel, code_hash, hash_key_name, sent_at,
                                 expires_at, used_at, version)
        values ('code-other', 'sign_in', 'person-other', 'handle-other-email', 'email', ${NO_CODE_HASH},
                ${CODE_HASH_KEY_NAME}, now(), now() + interval '10 minutes', now(), 2)
      `;
      await tx`
        insert into sessions (id, person_id, token_sha256, proven_via, proof_code_id, started_at, last_seen_at, expires_at)
        values ('session-other', 'person-other', ${hash}, 'code', 'code-other', now(), now(), now() + interval '1 day')
      `;
    });
    await expectRefused(db.sql, hash, "another person's session holds the hash");
  });

  it("another handle holding the check tester's address", SLOW, async () => {
    await db.sql`insert into handles (id, kind, address) values ('handle-other-email', 'email', ${email})`;
    await expectRefused(db.sql, standInHash(), "another handle holds the check tester's address");
  });

  it(
    "the check tester's person on a roster phone's handle, or holding a role: it must stay no roster phone's and no business's person",
    SLOW,
    async () => {
      const hash = standInHash();
      await seedCheckTester(db.sql, { env: onStaging(hash) });
      const [tp02] = ROSTER.filter((phone) => phone.testPhoneId === "tp-02");
      await db.sql`
        insert into handles (id, kind, address) values (${tp02?.handleId ?? ""}, 'phone', ${tp02?.fakeNumber ?? ""})
      `;
      await db.sql`insert into person_handles (person_id, handle_id) values (${personId}, ${tp02?.handleId ?? ""})`;
      await expectRefused(
        db.sql,
        hash,
        "the check tester's person holds a role, a company or another handle",
      );

      await empty(db.sql);
      await seedCheckTester(db.sql, { env: onStaging(hash) });
      await db.sql`
        insert into businesses (id, name, display_name, time_zone)
        values ('biz-t1302', 'A test business', 'A test business', 'America/New_York')
      `;
      await db.sql`
        insert into person_roles (id, person_id, business_id, role) values ('role-t1302', ${personId}, 'biz-t1302', 'customer')
      `;
      await expectRefused(
        db.sql,
        hash,
        "the check tester's person holds a role, a company or another handle",
      );
    },
  );

  it("its team row removed: a removed member is never re-added", SLOW, async () => {
    const hash = standInHash();
    await seedCheckTester(db.sql, { env: onStaging(hash) });
    await db.sql`update team_page_recipients set removed_at = now(), version = version + 1`;
    await expectRefused(db.sql, hash, "the check tester's team row was removed or changed");
  });
});

describe("with D-017's test-phone sets: the check tester shares no handle with any roster phone, so the skeleton seed's refusal is kept", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_check_tester_with_sets" });
    runtime = runtimeClient(db.schema);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  }, 120_000);

  it(
    "skeleton, staging-core and this set load together; no roster handle has the check tester's person; skeleton runs again, and tp-01's JOIN is still a first text",
    SLOW,
    async () => {
      const hash = standInHash();
      await seedSkeleton(db.sql);
      await seedStagingCore(db.sql, { env: {} });
      expect((await seedCheckTester(db.sql, { env: onStaging(hash) })).tables).toEqual(tablesOf(1, 1));

      // Every roster handle the two sets wrote is there, and none of them has the check tester's person.
      const rosterHandles = ROSTER.map((phone) => phone.handleId);
      const [shared] = await db.sql<{ handles: number; checkTester: number }[]>`
        select (select count(*)::int from handles where id in ${db.sql(rosterHandles)}) as handles,
               (select count(*)::int from person_handles
                where person_id = ${personId} and handle_id in ${db.sql(rosterHandles)}) as "checkTester"
      `;
      expect(shared).toEqual({ handles: ROSTER.length, checkTester: 0 });
      expect(rosterHandles).not.toContain(emailHandleId);

      // The skeleton seed's refusal ("never on top of" other rows for tp-01) does not fire: its second run passes.
      await expect(seedSkeleton(db.sql)).resolves.toMatchObject({ ranAs: RUNTIME_ROLE });
      expect(await handleTargets(runtime, { handleId: TEST_OWNER_1.handleId })).toMatchObject({
        result: "targets",
        persons: [{ personId: TEST_OWNER_1.personId, roles: [] }],
        openQuestions: [],
        bookings: [],
        phone: null,
      });
      expect(await standingOf(runtime, hash)).toBe("tester");
    },
  );
});

// ---- the runner, run as seed:staging runs it ------------------------------------------------------------------------

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node db/seeds/run.mjs --set check-tester` with this environment's variables, less the child's own, plus `env`. */
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
      [RUNNER, "--set", "check-tester"],
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

describe("node db/seeds/run.mjs --set check-tester: the set refuses wherever the runner seeds but staging's own schema", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_check_tester_run" });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  }, 120_000);

  it(
    "on a database on this machine: the runner loads the set, which refuses (exit 1), writing nothing and showing no part of the hash",
    SLOW,
    async () => {
      const hash = standInHash();
      const run = await runSeed({
        DATABASE_URL: LOCAL_URL,
        DB_SCHEMA: db.schema,
        [TOKEN_HASH_VARIABLE]: hash,
      });
      expect(run.code, run.stderr).toBe(1);
      expect(lines(run.stdout)).toEqual([`seed: set check-tester into schema ${db.schema} on ${LOCAL}`]);
      expect(lines(run.stderr)).toEqual([
        "seed: failed: the check tester seed refused, writing nothing: DATABASE_URL does not name the staging " +
          "database (the one STAGING_DATABASE_URL names): the check tester is staging's alone, never a local " +
          "database's, production's or any other's (no part of either URL is shown)",
      ]);
      expect(`${run.stdout}${run.stderr}`.includes(hash)).toBe(false);
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );

  it(
    "on the staging database (here this machine's, as STAGING_DATABASE_URL names it) in a schema that is not public, as a preview's: refused, writing nothing",
    SLOW,
    async () => {
      const hash = standInHash();
      const run = await runSeed({
        DATABASE_URL: LOCAL_URL,
        STAGING_DATABASE_URL: LOCAL_URL,
        DB_SCHEMA: db.schema,
        [TOKEN_HASH_VARIABLE]: hash,
      });
      expect(run.code, run.stderr).toBe(1);
      expect(lines(run.stdout)).toEqual([`seed: set check-tester into schema ${db.schema} on ${STAGING}`]);
      expect(lines(run.stderr)).toEqual([
        "seed: failed: the check tester seed refused, writing nothing: DB_SCHEMA names a schema other than public: " +
          "the check tester is seeded only into the schema staging's Worker reads, never a preview's",
      ]);
      expect(`${run.stdout}${run.stderr}`.includes(hash)).toBe(false);
      expect(await rowCounts(db.sql)).toEqual(Object.fromEntries(TABLES.map((table) => [table, 0])));
    },
  );
});
