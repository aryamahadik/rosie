// T-1466: the roster-owner set's business_setup rows alone (db/seeds/roster-owner-setup.ts), against local PostgreSQL
// (`npm run db:up`; `npm run test:integration -- db/seeds/roster-owner-setup`). Each block that needs a database
// migrates a fresh test schema of its own (db/repo/test-db.ts) and drops it at the end; the shared public schema is never
// touched.
//
// The card's proofs (DL-978): a roster business the roster-owner set seeded before T-1462 (so with no business_setup
// row), whose handle has a live open question (its JOIN committed S1-02's question: K-09 v1.5 commit-s1-01.json's) and
// whose phone row that reply's STOP, HELP and rates line changed, so that the roster-owner set refuses it as it did on
// staging at 08:18:19Z Nov 19, gets its row (business_id alone, control not proven), and no other row is written or
// changed; the runtime side reads it, and the Tool API (rosie_app) under that business's scope its own. A second run
// writes nothing; a row already there, a proven one included, is kept as it is and counted as kept; a place whose
// business does not exist yet is refused, writing nothing for any place. The list is read as the roster-owner set reads
// it: each of its refusals, word for word, before anything is read or written. The runner finds the set by its name and
// prints counts alone. The roster-owner set's own cases are its own test's (roster-owner.int.test.ts, unchanged); here,
// after this set has run, that set still refuses the handle with the live question word for word, and over a set seeded
// before T-1462 with no live question it keeps this set's row as its own, counts it as kept and writes nothing more.
//
// The live question is made as the roster-owner set's own test makes it (its turn and question rows from the frozen
// commit-s1-01.json, its bundle from K-04's seed-bundle-registry.json), and the handle, key and phone row by the
// gateway's own calls (handleSealingKey, openChatOnText). Every number here is a whole literal in the fiction range
// 555-0100 to 555-0199 (rule 9), and the wrapping key the first sight wraps its key under is made at random in the run,
// never written down.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openChatOnText } from "../repo/chat-open";
import { resolvePrimaryUrl } from "../repo/client";
import { handleSealingKey } from "../repo/handle-keys";
import { recordOptoutLineDelivered } from "../repo/phones";
import { type Sql, withBusiness } from "../repo/scope";
import { createTestDatabase, type TestDatabase } from "../repo/test-db";
import { ALLOWLIST_VARIABLE, rosterOwnerIds, RosterOwnerSeedError, seedRosterOwner } from "./roster-owner";
import { RosterOwnerSetupSeedError, seed, seedRosterOwnerSetup } from "./roster-owner-setup";

const SLOW = { timeout: 120_000 };
const RUNTIME_ROLE = "rosie_job";
const SET = "roster-owner-setup";
const REPO = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUNNER = path.join(REPO, "db/seeds/run.mjs");
const CONTRACTS = new URL("../../contracts/", import.meta.url);
// The roster phones of these tests: whole literals in the fiction range, none a test phone's fixed fake handle.
const PHONE_A = "+15555550150";
const PHONE_B = "+15555550151";
const PHONE_C = "+15555550152";
// The roster-owner set's seven tables (T-1450, T-1462).
const ROSTER_TABLES = [
  "businesses",
  "business_setup",
  "persons",
  "handles",
  "person_handles",
  "companies",
  "company_kinds",
] as const;
// Every table whose rows decide a roster phone's targets and party, the rows the roster-owner set writes, the keys it
// never writes, and the rows a committed turn leaves: this set may change business_setup alone.
const WATCHED = [
  "businesses",
  "business_setup",
  "persons",
  "person_roles",
  "handles",
  "person_handles",
  "companies",
  "company_kinds",
  "phones",
  "sealing_keys",
  "bookings",
  "bundles",
  "turns",
  "open_questions",
] as const;
// The wrapping key a first sight wraps its new key under: made here at random, for this run alone.
const WRAP_NAME = "SEALING_WRAP_KEY";
const wrappingKey = new Uint8Array(randomBytes(32));
const KEYS = {
  resolve: (name: string): Uint8Array | undefined => (name === WRAP_NAME ? wrappingKey : undefined),
};
// When the roster phone's first text reached the gateway, and when the reply to its JOIN, with the STOP, HELP and rates
// line, was delivered; S1-75's two proofs of a business's control (K-23 v1 control_proven_via).
const FIRST_TEXT_AT = "2026-11-18T13:13:58Z";
const DELIVERED_AT = new Date("2026-11-19T08:23:42Z");
const CODE_CAME_BACK_AT = new Date("2026-11-19T09:00:00Z");
const TEAM_CHECKED_AT = new Date("2026-11-19T09:30:00Z");

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Values = Record<string, Json>;

interface SeedFile {
  rows: { table: string; values: Values }[];
}

interface CommitExchange {
  request: {
    turn: {
      id: string;
      eventIds: string[];
      bundleId: { hash: string; build: number };
      traceId: string;
      joinedTraceIds: string[];
      tries: number;
    };
  };
  given: {
    stated: {
      writes: { openQuestions: { id: string; step: string; options: Json[]; versionsRead: Json[] }[] };
    };
  };
  outcome: { committedAt: string };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(new URL(file, CONTRACTS), "utf8"));
const TURN_1_COMMIT = readJson("tool-api/fixtures/commit-s1-01.json") as CommitExchange;

/** One row of a K-04 seed fixture: the one of `table` whose values match `where`. */
function k04Row(file: string, table: string, where: Values): Values {
  const rows = (readJson(`db-schema/core/fixtures/${file}`) as SeedFile).rows.filter(
    (row) =>
      row.table === table && Object.entries(where).every(([column, value]) => row.values[column] === value),
  );
  expect(rows, `${file}: one ${table} row`).toHaveLength(1);
  return rows[0]?.values ?? {};
}

/** The list as the build Mac's .dev.vars holds it: E.164 numbers joined by commas with no space. */
const listOf = (...numbers: string[]): Record<string, string> => ({
  [ALLOWLIST_VARIABLE]: numbers.join(","),
});

/** Connections that run as rosie_job, the runtime's role, with `db`'s schema first and no business scope. */
function runtimeClient(db: TestDatabase): Sql {
  return db.connect({
    max: 2,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1466-roster-owner-setup",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
}

/** The gateway's first sight of a number (K-05 handleSealingKey): a handle, a person with no name, their link, a key. */
async function firstSight(
  runtime: Sql,
  address: string,
  tag: string,
): Promise<{ handleId: string; personId: string }> {
  const result = await handleSealingKey(runtime, KEYS, {
    handle: { kind: "phone", address },
    newHandleId: `handle-t1466-${tag}`,
    newPersonId: `person-t1466-${tag}`,
    wrappingKeyName: WRAP_NAME,
  });
  if (!("result" in result.outcome)) {
    throw new Error("the first sight made no key");
  }
  expect(result.outcome.created).toEqual({ handle: true, person: true, key: true });
  return { handleId: result.outcome.handleId, personId: result.outcome.personId };
}

/** The gateway's receipt of a number's first text (K-05 v1.7 openChatOnText): the phone row it inserts, chat open. */
async function openChat(runtime: Sql, handleId: string, tag: string): Promise<void> {
  const opened = await openChatOnText(runtime, {
    eventId: `evt-t1466-${tag}`,
    handleId,
    service: "imessage",
    receivedAt: FIRST_TEXT_AT,
    traceId: `trace-t1466-${tag}`,
  });
  if (!("result" in opened) || opened.result !== "inserted") {
    throw new Error("the first text's receipt inserted no phone row");
  }
}

/**
 * The roster phone's turn 1 committed (K-09 v1.5 commit-s1-01.json's turn): S1-02's question is open on its handle,
 * asked of its person at its business, and waits for its answer, as the roster-owner set's own test writes it.
 */
async function openQuestion(sql: Sql, handleId: string, personId: string, businessId: string): Promise<void> {
  const { turn } = TURN_1_COMMIT.request;
  const [question] = TURN_1_COMMIT.given.stated.writes.openQuestions;
  if (question === undefined) {
    throw new Error("commit-s1-01.json states no open question");
  }
  const bundle = k04Row("seed-bundle-registry.json", "bundles", {
    hash: turn.bundleId.hash,
    build: turn.bundleId.build,
  });
  await sql.begin(async (tx) => {
    await tx`insert into bundles ${tx(bundle as Record<string, never>)}`;
    await tx`
      insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, joined_trace_ids,
                         tries, committed_at)
      values ('turn-t1466-s1-01', ${handleId}, ${turn.eventIds}, 'committed', ${turn.bundleId.hash},
              ${turn.bundleId.build}, ${turn.traceId}, ${turn.joinedTraceIds}, ${turn.tries},
              ${TURN_1_COMMIT.outcome.committedAt})
    `;
    await tx`
      insert into open_questions (id, turn_id, handle_id, person_id, business_id, booking_id, step, options,
                                  readback, versions_read, bundle_hash, bundle_build, clock)
      values ('oq-t1466-s1-02', 'turn-t1466-s1-01', ${handleId}, ${personId}, ${businessId}, null,
              ${question.step}, ${tx.json(question.options)}, null, ${tx.json(question.versionsRead)},
              ${turn.bundleId.hash}, ${turn.bundleId.build}, null)
    `;
  });
}

/**
 * K-23 v1.1 business_setup's row, every column, as the roster-owner set writes it for a business (T-1462) and this set
 * does: its business_id alone, and every other column null or its default (no_money false, version 1). So control is
 * not proven, and it holds no contact value, no About us or profile, no Stripe account, no terms and no sign-up claim.
 */
function setupRowOf(businessId: string): Record<string, unknown> {
  return {
    business_id: businessId,
    listing_phone: null,
    listing_email: null,
    website: null,
    about: null,
    profile_confirmed_at: null,
    stripe_account_id: null,
    no_money: false,
    terms_accepted_at: null,
    terms_accepted_by_person_id: null,
    control_proven_at: null,
    control_proven_via: null,
    version: 1,
    signup_claim: null,
    claimed_by_person_id: null,
  };
}

/** The control state limit 1's default 14 reads (DL-961 (d)) of a business whose control is not proven. */
const notProven = (businessId: string): Record<string, unknown> => ({
  business_id: businessId,
  control_proven_at: null,
  control_proven_via: null,
});

/** This set's counts for a run over `rows` places, `inserted` of whose rows it wrote. */
const setupCounts = (rows: number, inserted: number) => ({
  business_setup: { rows, inserted, kept: rows - inserted },
});

/** Each place's business, as the set answers it, for places 1 to `places`. */
const placesOf = (places: number): { place: number; businessId: string }[] =>
  Array.from({ length: places }, (_, index) => ({
    place: index + 1,
    businessId: rosterOwnerIds(index + 1).businessId,
  }));

/** Every row of the watched tables, in key order. */
async function snapshot(sql: Sql): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of WATCHED) {
    rows[table] = [...(await sql`select * from ${sql(table)} order by 1, 2`)];
  }
  return rows;
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

/** No number of these tests, nor any part of one, is in a text: no 555 and no run of four digits. */
function expectNoNumber(text: string, what: string): void {
  expect(text, what).not.toMatch(/555|[0-9]{4}/);
}

/**
 * This set refuses `env`'s list, naming each of `reasons`, no number and no business's id, and leaves every watched row
 * as it was: nothing is written for any place. Gives back what it threw.
 */
async function expectSetupRefused(
  sql: Sql,
  env: Record<string, string>,
  reasons: readonly string[],
): Promise<Error> {
  const before = await snapshot(sql);
  const error = await refusal(seedRosterOwnerSetup(sql, { env }));
  expect(error).toBeInstanceOf(RosterOwnerSetupSeedError);
  expect(error.message).toMatch(/^the roster owner setup seed refused, writing nothing: /);
  for (const reason of reasons) {
    expect(error.message).toContain(reason);
  }
  expect(error.message).not.toContain("biz-");
  expectNoNumber(error.message, "the refusal");
  expect(await snapshot(sql)).toEqual(before);
  return error;
}

/** The roster-owner set refuses `env`'s list, naming each of `reasons`, writing nothing. Gives back what it threw. */
async function expectRosterOwnerRefused(
  sql: Sql,
  env: Record<string, string>,
  reasons: readonly string[],
): Promise<Error> {
  const before = await snapshot(sql);
  const error = await refusal(seedRosterOwner(sql, { env }));
  expect(error).toBeInstanceOf(RosterOwnerSeedError);
  expect(error.message).toMatch(/^the roster owner seed refused, writing nothing: /);
  for (const reason of reasons) {
    expect(error.message).toContain(reason);
  }
  expect(await snapshot(sql)).toEqual(before);
  return error;
}

/** Empties every table of this file's schema (truncating the heads cascades to the rest). */
async function emptied(sql: Sql): Promise<void> {
  await sql`truncate businesses, persons, handles, bundles, release_flags cascade`;
}

/** What a run of the roster-owner set from before T-1462 left: its rows, and no business_setup row (it wrote none). */
async function asBeforeT1462(sql: Sql): Promise<void> {
  await sql`delete from business_setup`;
  expect([...(await sql`select business_id from business_setup`)]).toEqual([]);
}

// The variables the runner and this set read: each child run sets only the ones it names.
const CHILD_VARIABLES = new Set([
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DB_SCHEMA",
  "STAGING_DATABASE_URL",
  "CI",
  ALLOWLIST_VARIABLE,
]);

/** Runs `node db/seeds/run.mjs --set roster-owner-setup` with this environment, less CHILD_VARIABLES, plus `env`. */
function runSet(env: Readonly<Record<string, string>>): Promise<Run> {
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
      [RUNNER, "--set", SET],
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

describe("a roster business the roster-owner set wrote gets its business_setup row alone, even once its handle has a live open question (T-1466; DL-978)", () => {
  let db: TestDatabase;
  let runtime: Sql;

  beforeAll(async () => {
    db = await createTestDatabase({ name: "seeds_roster_owner_setup" });
    runtime = runtimeClient(db);
  }, 120_000);

  afterAll(async () => {
    await runtime.end({ timeout: 5 });
    await db.drop();
  });

  beforeEach(async () => {
    await emptied(db.sql);
  });

  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedRosterOwnerSetup);
  });

  it(
    "staging's state (DL-978): seeded before T-1462, its handle made at first sight with a live open question (S1-02's, its JOIN committed) and a phone row its reply changed, so the roster-owner set refuses; this set writes its row, business_id alone, as rosie_job, and no other row; the runtime side reads its control as not proven, and rosie_app under its scope its own row; a second run writes nothing; the roster-owner set still refuses, word for word",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_A, "question");
      await openChat(runtime, sight.handleId, "question");
      const env = listOf(PHONE_A);
      await seedRosterOwner(db.sql, { env });
      await asBeforeT1462(db.sql);
      const { businessId } = rosterOwnerIds(1);
      await openQuestion(db.sql, sight.handleId, sight.personId, businessId);
      expect((await recordOptoutLineDelivered(db.sql, PHONE_A, 1, DELIVERED_AT)).ok).toBe(true);
      const reasons = [
        "entry 1's handle has 1 live open question",
        "entry 1's phone row has optout_line_delivered_at set",
      ];
      const refusedBefore = await expectRosterOwnerRefused(db.sql, env, reasons);

      const before = await snapshot(db.sql);
      expect(before.business_setup).toEqual([]);
      expect(before.open_questions).toHaveLength(1);
      const first = await seedRosterOwnerSetup(db.sql, { env });
      expect(first).toEqual({
        ranAs: RUNTIME_ROLE,
        tables: setupCounts(1, 1),
        businesses: [{ place: 1, businessId }],
      });
      expect(await snapshot(db.sql)).toEqual({ ...before, business_setup: [setupRowOf(businessId)] });
      expect([
        ...(await runtime`select business_id, control_proven_at, control_proven_via from business_setup`),
      ]).toEqual([notProven(businessId)]);
      const seen = await withBusiness(db.sql, businessId, async (tx) => {
        await tx`set local role rosie_app`;
        return [...(await tx`select business_id, control_proven_at, control_proven_via from business_setup`)];
      });
      expect(seen).toEqual([notProven(businessId)]);

      const after = await snapshot(db.sql);
      const second = await seedRosterOwnerSetup(db.sql, { env });
      expect(second.tables).toEqual(setupCounts(1, 0));
      expect(second.businesses).toEqual(first.businesses);
      expect(await snapshot(db.sql)).toEqual(after);

      const refusedAfter = await expectRosterOwnerRefused(db.sql, env, reasons);
      expect(refusedAfter.message).toBe(refusedBefore.message);
    },
  );

  it(
    "a row already there is kept as it is and counted as kept, never updated, reset or deleted, a proven one included (S1-75: the listing's code came back right, or Rosie's team checked); a business that lacks its row gets it; a second run writes nothing",
    SLOW,
    async () => {
      const env = listOf(PHONE_A, PHONE_B, PHONE_C);
      await seedRosterOwner(db.sql, { env });
      const byCode = rosterOwnerIds(1).businessId;
      const byTeam = rosterOwnerIds(2).businessId;
      const missing = rosterOwnerIds(3).businessId;
      await db.sql`
        update business_setup
        set control_proven_at = ${CODE_CAME_BACK_AT}, control_proven_via = 'listing_code', version = version + 1
        where business_id = ${byCode}
      `;
      await db.sql`
        update business_setup
        set control_proven_at = ${TEAM_CHECKED_AT}, control_proven_via = 'team_check', version = version + 1
        where business_id = ${byTeam}
      `;
      await db.sql`delete from business_setup where business_id = ${missing}`;
      const proven = [
        {
          ...setupRowOf(byCode),
          control_proven_at: CODE_CAME_BACK_AT,
          control_proven_via: "listing_code",
          version: 2,
        },
        {
          ...setupRowOf(byTeam),
          control_proven_at: TEAM_CHECKED_AT,
          control_proven_via: "team_check",
          version: 2,
        },
      ];
      const before = await snapshot(db.sql);
      expect(before.business_setup).toEqual(proven);

      const run = await seedRosterOwnerSetup(db.sql, { env });
      expect(run.tables).toEqual(setupCounts(3, 1));
      expect(run.businesses).toEqual(placesOf(3));
      expect(await snapshot(db.sql)).toEqual({ ...before, business_setup: [...proven, setupRowOf(missing)] });

      const after = await snapshot(db.sql);
      expect((await seedRosterOwnerSetup(db.sql, { env })).tables).toEqual(setupCounts(3, 0));
      expect(await snapshot(db.sql)).toEqual(after);
    },
  );

  it(
    "refused, writing nothing for any place, while a place's business does not exist yet (none seeded; the list grown past the places the roster-owner set wrote), naming places alone; with the list as that set ran it, the row is written",
    SLOW,
    async () => {
      await expectSetupRefused(db.sql, listOf(PHONE_A), ["entry 1's business does not exist yet"]);
      await expectSetupRefused(db.sql, listOf(PHONE_A, PHONE_B), [
        "entry 1's business does not exist yet; entry 2's business does not exist yet; ",
      ]);

      await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      await asBeforeT1462(db.sql);
      const grown = await expectSetupRefused(db.sql, listOf(PHONE_A, PHONE_B, PHONE_C), [
        "entry 2's business does not exist yet; entry 3's business does not exist yet; ",
        "this set adds the business_setup row alone, to a roster business the roster-owner set has written",
      ]);
      expect(grown.message).not.toContain("entry 1");

      const run = await seedRosterOwnerSetup(db.sql, { env: listOf(PHONE_A) });
      expect(run.tables).toEqual(setupCounts(1, 1));
      expect([...(await db.sql`select * from business_setup`)]).toEqual([
        setupRowOf(rosterOwnerIds(1).businessId),
      ]);
    },
  );

  it(
    "reads STAGING_LINQ_ALLOWLIST by name as the roster-owner set reads it: unset, blank, an entry not E.164, a number twice and a test phone's fake handle are refused with that set's words, before anything is read or written",
    SLOW,
    async () => {
      await seedRosterOwner(db.sql, { env: listOf(PHONE_A) });
      await asBeforeT1462(db.sql);
      const before = await snapshot(db.sql);
      const lists: Record<string, string>[] = [
        {},
        { [ALLOWLIST_VARIABLE]: "" },
        { [ALLOWLIST_VARIABLE]: "   " },
        { [ALLOWLIST_VARIABLE]: `${PHONE_A}, ${PHONE_B}` },
        { [ALLOWLIST_VARIABLE]: `${PHONE_A};${PHONE_B}` },
        listOf(PHONE_A, PHONE_B, PHONE_A),
        listOf(PHONE_A, "+15555550100"),
      ];
      for (const env of lists) {
        const what = JSON.stringify(Object.values(env));
        const setup = await refusal(seedRosterOwnerSetup(db.sql, { env }));
        const rosterOwner = await refusal(seedRosterOwner(db.sql, { env }));
        expect(setup, what).toBeInstanceOf(RosterOwnerSeedError);
        expect(setup.message, what).toBe(rosterOwner.message);
        expect(setup.message, what).toContain(`${ALLOWLIST_VARIABLE} `);
        expect(setup.message, what).toContain("(no part of its value is shown)");
        expectNoNumber(setup.message, what);
      }
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "the roster-owner set after this one, over a set seeded before T-1462 with no live question yet: this set's row is the one that set writes, so it keeps it, counts every row of its seven tables as kept and writes nothing more",
    SLOW,
    async () => {
      const sight = await firstSight(runtime, PHONE_B, "full-after");
      const env = listOf(PHONE_A, PHONE_B);
      await seedRosterOwner(db.sql, { env });
      await asBeforeT1462(db.sql);
      expect((await seedRosterOwnerSetup(db.sql, { env })).tables).toEqual(setupCounts(2, 2));
      const before = await snapshot(db.sql);
      expect(before.business_setup).toEqual(placesOf(2).map(({ businessId }) => setupRowOf(businessId)));

      const full = await seedRosterOwner(db.sql, { env });
      expect(full.tables).toEqual(
        Object.fromEntries(ROSTER_TABLES.map((table) => [table, { rows: 2, inserted: 0, kept: 2 }])),
      );
      const one = rosterOwnerIds(1);
      const two = rosterOwnerIds(2);
      expect(full.owners).toEqual([
        {
          place: 1,
          handleId: one.handleId,
          personId: one.personId,
          businessId: one.businessId,
          companyId: one.companyId,
        },
        {
          place: 2,
          handleId: sight.handleId,
          personId: sight.personId,
          businessId: two.businessId,
          companyId: two.companyId,
        },
      ]);
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );

  it(
    "the runner (T-201) finds the set by its name, reads the list by name and prints counts alone, never a number; a refused run exits 1 with nothing written",
    SLOW,
    async () => {
      const local = { DATABASE_URL: resolvePrimaryUrl(), DB_SCHEMA: db.schema };
      await seedRosterOwner(db.sql, { env: listOf(PHONE_A, PHONE_B) });
      await asBeforeT1462(db.sql);
      const run = await runSet({ ...local, ...listOf(PHONE_A, PHONE_B) });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      expect(lines(run.stdout)).toEqual([
        `seed: set ${SET} into schema ${db.schema} on the local database`,
        "seed: business_setup: 2 rows (2 inserted, 0 kept)",
        `seed: done: set ${SET} into schema ${db.schema}: 2 rows in 1 table (2 inserted, 0 kept)`,
      ]);
      expectNoNumber(`${run.stdout}${run.stderr}`.replaceAll(db.schema, ""), "the runner's output");

      const before = await snapshot(db.sql);
      const refused = await runSet({ ...local, ...listOf(PHONE_A, PHONE_B, PHONE_C) });
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe(`seed: set ${SET} into schema ${db.schema} on the local database\n`);
      const [failure, ...more] = lines(refused.stderr);
      expect(more).toEqual([]);
      expect(failure).toMatch(
        /^seed: failed: the roster owner setup seed refused, writing nothing: entry 3's business does not exist yet; this set adds /,
      );
      expectNoNumber(`${refused.stdout}${refused.stderr}`.replaceAll(db.schema, ""), "the refusal's output");
      expect(await snapshot(db.sql)).toEqual(before);
    },
  );
});
