// T-1468's integration proof (card F1; DL-961 card F; DL-988; DL-994) on local PostgreSQL: `npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/turn-face`. An owner's whole second turn: "All on the list" to S1-02's
// question is saved, and S1-04's question is committed, composed and finalized.
//
// The world (a fresh schema, migrated with every migration and dropped when the file ends: commit/pg/test-support.ts):
//   - the roster-owner seed's (db/seeds/roster-owner.ts, run as it is for one number in the fiction range), never T-1148's
//     skeleton: a test business of its own with its business_setup row (control not proven), one person with no name and
//     no role, their handle, the company and its barber kind of work;
//   - that person's sealing key, made as the gateway makes it at first sight (K-05 v1.2 item 29), under a wrapping key
//     made for this run alone;
//   - the 243 trade-file kinds as the kinds seed plans them from fixture set v1 (T-212);
//   - the registry rows of bundle v0 as bundles/v0 publishes it (T-1146) and of bundle v1 (T-1460).
//
// Who runs what. The turn face is handed two clients of this file's own, each statement's text written down (never a
// value): `app`, whose connections run as rosie_app, 2 connections, and `job`, as rosie_job. The gate, the walk's question
// read, readOpenHolds and item 78 run on `app` (item 78 in a read-only transaction of its own beside the call's); K-05's
// commitTurn, item 79, the sealer and the row reads on `job`. Nothing the turn does runs on the schema owner's client,
// which only seeds the world, plays the send's receipt and reads what the turn left.
//
// Real here: the Tool API base, the gate and limits 1 to 6 as registered (limit 1 given the pinned bundle's step cards),
// the commit, T-1461's walk, the binding of T-1468 (pgTurnCalls' signUp: pgWalkQuestions and signUpStepWriters over
// pgKindsReads, no stop port, and the trade port over bundle v1's own overlays), T-633's and T-634's writers, T-632's
// matcher, runCore with the safety service, compose input and finalize, every data-access call, row-level security and
// the two application roles. Given: the bundles as the frontier's fake over bundles/v0's and bundles/v1's own files; the
// decided texts, K-09's commit-s1-01.json and commit-s1-02.json as this owner sends them (no model is called); S1-04's
// plan, written from compose input's own master text as a composer would give it. The send and its delivery receipt are
// played by one delivered part written as actions/src/gate/limit-1/pg/sign-up.int.test.ts writes one, then K-05's own
// armClock.
//
// The turns: turn 1, the JOIN, under bundle v0's id, opens S1-02's question; its row is composed, finalized and
// delivered, and armClock moves the question to open at version 2. Turn 2, under bundle v1's id: with the stop port left
// out, "One isn't on the list yet" and "Not a service we book" each answer notBuilt and write nothing; then "All on the
// list" with the words "Barbershop, plumbing, electrical" commits, and S1-04's row is composed and finalized.
//
// T-1502 (K-09 README default 191; DL-1018 card 4): a second world, built the same way in a schema of its own, whose
// binding also hands the walk S1-02's settler (pgTurnCalls' settleSignUp: signUpSteps, one catalog read per walk shared
// with S1-02's writer). The same turn 1 opens S1-02's question there; then a decision naming c-02 ("One isn't on the list
// yet") for "Barbershop, plumbing, electrical" still commits "All on the list"'s rows, since the words, not the option
// named, settle the branch; the part's choiceId stays c-02, and item 78 is read once for the call. The first world binds
// no settler, so everything above is the walk as before.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { armClock } from "../../../../../db/repo/clocks";
import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import type { Sql } from "../../../../../db/repo/scope";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import { kindsPlanOf, openTradeSet, verifyTradeSet } from "../../../../../db/seeds/kinds";
import { openFixtureSet, verifyFixtureSet } from "../../../../../db/seeds/lib/fixture-set";
import { ALLOWLIST_VARIABLE, rosterOwnerIds, seedRosterOwner } from "../../../../../db/seeds/roster-owner";
import type { GateAndCommitRequest } from "../../../commit";
import {
  NO_FOOTPRINT,
  RUNTIME_ROLE,
  TOOL_API_ROLE,
  footprint,
  openCommitDatabase,
  rowOf,
  snapshot,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { bundleV1Id, commitS1_02, decidedOf, turnTwoOnV1 } from "../../../commit/walk/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { bundleIdOf, captureLog, checks, fakeBundles } from "../../../frontier/assemble/test-support";
import type { DecidePart } from "../../../gate/framework";
import { matcherOf, pgKindsReads } from "../../journey-1/kinds";
import { GIFT_CARDS, PACK_HIKES } from "../../journey-1/kinds/test-support";
import { PF_TEXT_KEYS } from "../../journey-1/plug-ins";
import { overlayV1, tradesOverV1 } from "../../journey-1/plug-ins/test-support";
import { fixture, traceFor } from "../../test-support";
import { commitS101, composeS102, publishedBundleV0, publishedBundleV1 } from "../calls-test-support";
import { NOTHING_OPEN_AT } from "../commit";
import type { TurnFace } from "../turn-face";
import { pgTurnCalls, pgTurnFace } from "./index";

type Json = Record<string, unknown>;

const SLOW = { timeout: 120_000 };
/** The Tool API client's connections: the call's transaction, and the catalog read's own beside it (DL-931). */
const APP_POOL = 2;
const JOB_POOL = 4;

const { validator, checker } = checks();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };

// ---- the roster owner (db/seeds/roster-owner.ts, its first place) -------------------------------------------------------

/** A number in the fiction range (555-0100 to 555-0199), never a test phone's fixed fake handle, never a real phone's. */
const NUMBER = "+15555550188";
const IDS = rosterOwnerIds(1);
const BUSINESS = IDS.businessId;
const PERSON = IDS.personId;
const HANDLE = IDS.handleId;
/** The Linq chat of the owner's texts, a stand-in in K-06's form. */
const CHAT = "linq-chat-demo-roster-owner-1";

const V0 = bundleIdOf(publishedBundleV0());
const V1 = bundleV1Id();

/** The turns, and the rows the walk names from each turn's own id (K-09 v1.5 default 131). */
const TURN_1 = "turn-s1-01-roster-owner-1";
const TRACE_1 = "trace-roster-owner-1-0000";
const QUESTION_1 = `oq-s1-02-${TURN_1}-1`;
const ROW_1 = `outbox-s1-02-${TURN_1}-1`;
const TURN_2 = "turn-s1-02-roster-owner-1";
const TRACE_2 = "trace-roster-owner-1-0001";
const QUESTION_2 = `oq-s1-04-${TURN_2}-1`;
const ROW_2 = `outbox-s1-04-${TURN_2}-1`;
const pickId = (n: number): string => `pick-s1-02-${TURN_2}-${String(n)}`;

/** The moments: turn 1's commit, its row's finalize, send and delivery; then turn 2's text, commit and finalize. */
const NOW_1 = "2026-10-19T18:05:05Z";
const FINALIZED_1 = "2026-10-19T18:05:07Z";
const SENT_1 = "2026-10-19T18:05:08Z";
const DELIVERED_1 = "2026-10-19T18:05:09Z";
const TEXT_2 = "2026-10-19T18:07:00Z";
const NOW_2 = "2026-10-19T18:07:06Z";
const FINALIZED_2 = "2026-10-19T18:07:08Z";

/** The owner's words, exactly (commit-s1-02.json's). */
const WORDS = "Barbershop, plumbing, electrical";

/** The owner as the frontier names a person with no name and no role (frontier/assemble/frame.ts writerOf). */
const OWNER = { personId: PERSON, name: "", roles: [], language: null };

/** A copy of `value` with each whole text that `names` holds replaced by its new name. */
function renamed<T>(value: T, names: ReadonlyMap<string, string>): T {
  const walk = (each: unknown): unknown => {
    if (typeof each === "string") return names.get(each) ?? each;
    if (Array.isArray(each)) return each.map(walk);
    if (typeof each === "object" && each !== null) {
      return Object.fromEntries(Object.entries(each).map(([key, inner]) => [key, walk(inner)]));
    }
    return each;
  };
  return walk(value) as T;
}

/** The fixtures' sample names, as this owner's: Sam's business, person, handle, number and chat. */
const OWNER_NAMES: readonly (readonly [string, string])[] = [
  ["biz-lees-barbershop", BUSINESS],
  ["person-sam", PERSON],
  ["handle-sam", HANDLE],
  ["+15555550100", NUMBER],
  ["linq-chat-demo-sam", CHAT],
];

const TURN_1_NAMES = new Map<string, string>([
  ...OWNER_NAMES,
  ["turn-s1-01-sam", TURN_1],
  ["trace-sam-0000", TRACE_1],
  ["evt-sam-s1-01", "evt-roster-owner-1-0000"],
  ["outbox-s1-02-sam-1", ROW_1],
]);

/** Turn 1: commit-s1-01.json's request as this owner sends it, pinned to bundle v0 as published. */
function turnOne(): GateAndCommitRequest {
  const request = renamed(commitS101().request, TURN_1_NAMES);
  if (request.turn === null || request.input.kind !== "decided") throw new Error("turn 1 is a decided turn");
  const { decided } = request.input;
  request.turn.bundleId = { ...V0 };
  decided.context.bundleId = { ...V0 };
  decided.decide.bundleId = { ...V0 };
  decided.context.writer.people = [structuredClone(OWNER)];
  return request;
}

/**
 * Turn 2: commit-s1-02.json's request as this owner sends it, pinned to bundle v1 (T-1461's turnTwoOnV1), under the
 * turn id `turnId`, answering S1-02's question as turn 1 stored it, its one part choosing `choiceId` (c-01 "All on the
 * list", c-02 "One isn't on the list yet", c-03 "Not a service we book") in decide's agreed parts and both reads, with
 * `words` as the text, the part's quote and its kinds field.
 */
function turnTwo(turnId: string, choiceId: string, words: string): GateAndCommitRequest {
  const base = turnTwoOnV1(choiceId).exchange.request;
  const change = (part: DecidePart): void => {
    if (part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
    part.choice = choiceId;
    part.quote = words;
    for (const field of part.fields) {
      if (field.name === "kinds") {
        field.value = words;
        field.words = words;
      }
    }
  };
  const given = decidedOf(base);
  for (const entry of given.decide.parts) change(entry.part);
  for (const read of given.decide.reads) for (const part of read.output.parts) change(part);
  given.context.texts[0].words = words;

  const request = renamed(
    base,
    new Map<string, string>([
      ...OWNER_NAMES,
      ["turn-s1-02-sam-kinds", turnId],
      ["trace-sam-0001", TRACE_2],
      ["evt-sam-0001", `evt-${turnId}`],
      ["oq-s1-02", QUESTION_1],
    ]),
  );
  const { context } = decidedOf(request);
  context.writer.people = [structuredClone(OWNER)];
  // The times, after turn 1's: the text, the question it answers as it went out, and the commit.
  context.texts[0].sentAt.utc = TEXT_2;
  for (const question of context.openQuestions) question.sentAt.utc = SENT_1;
  for (const message of context.recentMessages) message.sentAt.utc = SENT_1;
  request.now = NOW_2;
  return request;
}

// ---- the schema, its clients and the face -------------------------------------------------------------------------------

let cdb: CommitDatabase;
/** The Tool API's client (rosie_app) and the runtime side's (rosie_job), each statement's text written down. */
let app: Sql;
let job: Sql;
const sent = { app: [] as string[], job: [] as string[] };
let face: TurnFace;
/** The commit's moment and finalize's, set before each call. */
const clock = { now: NOW_1, finalize: FINALIZED_1 };
const trades = tradesOverV1();

/** One world: its schema, its two clients with their statements written down, the trade port, and the face. */
interface World {
  readonly cdb: CommitDatabase;
  readonly app: Sql;
  readonly job: Sql;
  readonly sent: { readonly app: string[]; readonly job: string[] };
  readonly trades: ReturnType<typeof tradesOverV1>;
  readonly face: TurnFace;
}

/** How a world is built: its schema and clients' names, where its statements and trade reads go, and its settler. */
interface WorldGiven {
  readonly schema: string;
  readonly name: string;
  readonly sent: World["sent"];
  readonly trades: World["trades"];
  /** Bind S1-02's settler with the sign-up writers (T-1502; pgTurnCalls' settleSignUp). */
  readonly settleSignUp: boolean;
}

/** A world as the top of this file describes it, in a fresh schema of its own. */
async function openWorld(given: WorldGiven): Promise<World> {
  const database = await openCommitDatabase(given.schema, JOB_POOL);
  const { sql } = database.db;
  // The registry rows: bundle v0 as published, which turn 1 pins, and bundle v1, which turn 2 pins.
  await sql`
    insert into bundles (hash, build, manifest_key, built_at, published_at, active)
    values (${V0.hash}, ${V0.build}, ${`bundle/${V0.hash}/${String(V0.build)}/manifest`},
            '2026-11-10T08:00:00Z', '2026-11-10T08:05:00Z', false)
  `;
  await sql`
    insert into bundles (hash, build, manifest_key, built_at)
    values (${V1.hash}, ${V1.build}, ${`bundle/${V1.hash}/${String(V1.build)}/manifest`}, '2026-11-18T10:26:00Z')
  `;
  // The 243 trade-file kinds the kinds seed writes, planned from fixture set v1 (T-212's kindsPlanOf).
  const plan = kindsPlanOf(verifyFixtureSet(openFixtureSet()), verifyTradeSet(openTradeSet()));
  await sql.begin(async (tx) => {
    for (const row of plan.rows.kinds) {
      await tx`
        insert into kinds (id, name, style, pattern, facts, source)
        values (${row.id}, ${row.name}, ${row.style}, ${row.pattern}, ${[...row.facts]}, ${row.source})
      `;
    }
  });
  // The roster-owner seed, as it is, for one number: its own transaction as rosie_job.
  const seeded = await seedRosterOwner(sql, { env: { [ALLOWLIST_VARIABLE]: NUMBER } });
  expect(seeded.ranAs).toBe(RUNTIME_ROLE);
  expect(seeded.owners).toEqual([
    { place: 1, handleId: HANDLE, personId: PERSON, businessId: BUSINESS, companyId: IDS.companyId },
  ]);
  // The person's key, made as the gateway makes it at the first sight of the number (K-05 v1.2 item 29).
  const sighted = await handleSealingKey(database.runtime, KEYS, {
    handle: { kind: "phone", address: NUMBER },
    newHandleId: "handle-t1468-unused",
    newPersonId: "person-t1468-unused",
    wrappingKeyName: "SEALING_WRAP_KEY",
  });
  if (!("result" in sighted.outcome) || sighted.outcome.personId !== PERSON) {
    throw new Error("first sight did not give the roster owner's key");
  }

  const toolApi = database.client(TOOL_API_ROLE, `${given.name}-app`, APP_POOL, (text) => {
    given.sent.app.push(text.trim());
  });
  const runtime = database.client(RUNTIME_ROLE, `${given.name}-job`, JOB_POOL, (text) => {
    given.sent.job.push(text.trim());
  });
  const bundles = fakeBundles(publishedBundleV0(), publishedBundleV1());
  const turnFace = pgTurnFace(runtime, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
    calls: pgTurnCalls(runtime, toolApi, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      now: () => new Date(clock.now),
      finalizeNow: () => clock.finalize,
      finalizeLog: () => undefined,
      // T-1468's binding: items 78 and 79 on PostgreSQL, no stop port, and the trade port over bundle v1's overlays.
      signUp: {
        kinds: { reads: pgKindsReads(toolApi, runtime) },
        plugIns: { bundles: given.trades.bundles },
      },
      // T-1502: S1-02's settler beside the writers, in the second world alone.
      ...(given.settleSignUp ? { settleSignUp: true } : {}),
    }),
  });
  return {
    cdb: database,
    app: toolApi,
    job: runtime,
    sent: given.sent,
    trades: given.trades,
    face: turnFace,
  };
}

/** The world the first describe block runs in: no settler bound, the walk as before. */
let main: World;

beforeAll(async () => {
  main = await openWorld({
    schema: "turn_face_sign_up",
    name: "rosie-turn-face-sign-up",
    sent,
    trades,
    settleSignUp: false,
  });
  ({ cdb, app, job, face } = main);
}, 240_000);

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), job.end({ timeout: 5 })]);
  await cdb.close();
});

// ---- what the turns left ------------------------------------------------------------------------------------------------

/** One open question's status and version, as the owner reads its row (in the first world, unless one is named). */
async function questionRow(
  id: string,
  db: CommitDatabase = cdb,
): Promise<{ status: string; version: number; step: string } | undefined> {
  const [row] = await db.db.sql<{ status: string; version: number; step: string }[]>`
    select status, version, step from open_questions where id = ${id}
  `;
  return row;
}

/** The row counts of K-24's kinds tables and K-37's review items, as the owner reads them (the first world's unless named). */
async function kindsRows(db: CommitDatabase = cdb): Promise<Record<string, number>> {
  const [row] = await db.db.sql<Record<string, number>[]>`
    select (select count(*)::int from kinds) as kinds,
           (select count(*)::int from picked_kinds) as picked_kinds,
           (select count(*)::int from picked_kind_texts) as picked_kind_texts,
           (select count(*)::int from new_work_drafts) as new_work_drafts,
           (select count(*)::int from review_items) as review_items
  `;
  if (row === undefined) throw new Error("kindsRows: no row");
  return row;
}

/** A statement that reads a table that spans businesses, which rosie_app holds no grant on (0012). */
const SPANS_BUSINESSES = /\b(from|join)\s+(handles|persons|phones|person_handles|turns)\b/u;

/** The caller of a call the turn `turnId` makes after its commit. */
const callerOf = (turnId: string, traceId: string): Json => ({
  kind: "turn",
  turnId,
  requestId: turnId,
  businessId: BUSINESS,
  personId: PERSON,
  traceId,
});

/** What finalize answers when it sends: its outcome and the final parts it wrote. */
interface Finalized extends Json {
  outcome: string;
  finalParts: {
    row: string;
    fixedLines: string[];
    sends: { kind: string; text: string; options: unknown[] }[];
  };
}

/**
 * Turn 1 in a world (the JOIN through the real turn face under bundle v0's id): S1-02's question opened; its row composed,
 * finalized and delivered; armClock moves the question to open at version 2. Answers the version it is open at.
 */
async function joinAndDeliver(world: World): Promise<number> {
  const { face: turnFace, cdb: database, job: runtime } = world;
  clock.now = NOW_1;
  clock.finalize = FINALIZED_1;
  const request = turnOne();
  const first = await turnFace.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  expect(first, JSON.stringify(first)).toMatchObject({
    result: "committed",
    turnId: TURN_1,
    repeated: false,
    parts: commitS101().outcome.parts,
    openQuestions: { opened: [QUESTION_1], closed: [] },
  });
  expect(await questionRow(QUESTION_1, database)).toEqual({ status: "waiting", version: 1, step: "S1-02" });

  // Its row composed and finalized through the face, on bundle v0.
  const names = TURN_1_NAMES;
  const compose = renamed(composeS102().request, names);
  const composed = await turnFace.composeInput(structuredClone(compose), traceFor(compose).trace);
  expect(composed, JSON.stringify(composed)).toMatchObject({
    result: "compose",
    input: { row: ROW_1, turn: TURN_1, masterText: { step: "S1-02" } },
  });
  const finalize = renamed((fixture("finalize-pass.json") as { request: Json }).request, names);
  const finalized = (await turnFace.finalizeMessage(
    structuredClone(finalize),
    traceFor(finalize).trace,
  )) as unknown as Finalized;
  expect(finalized.outcome, JSON.stringify(finalized)).toBe("send");
  expect(await rowOf(database, "outbox_rows", ROW_1, ["state"])).toEqual({ version: 2, state: "checked" });

  // The send and its delivery receipt, played: one delivered part, as limit-1's sign-up test writes one, then K-05's
  // own armClock at the receipt, on the runtime side.
  const { sql } = database.db;
  await sql`
    insert into outbox_parts (outbox_row_id, part_no, try_no, idempotency_key, attempts, kind, linq_message_id,
                              state, sent_at, delivered_at)
    values (${ROW_1}, 1, 1, ${`${ROW_1}/1/1`}, 1, 'words', 'linq-msg-roster-owner-1-0001', 'delivered',
            ${SENT_1}, ${DELIVERED_1})
  `;
  await sql`update outbox_rows set state = 'delivered', version = version + 1 where id = ${ROW_1}`;
  const armed = await armClock(runtime, {
    openQuestionId: QUESTION_1,
    deliveredAt: DELIVERED_1,
    dueAt: "2026-10-20T18:05:09Z",
    dueZone: "America/New_York",
  });
  expect(armed).toMatchObject({ result: "armed", repeated: false });

  const question = await questionRow(QUESTION_1, database);
  expect(question?.status).toBe("open");
  expect(question?.version).not.toBe(1);
  expect(question?.version).toBe(2);
  return question?.version ?? 0;
}

describe("an owner's whole second turn on local PostgreSQL: the gate as rosie_app, the commit as rosie_job (T-1468)", () => {
  /** S1-02's question's version once its first delivery receipt armed its clock: what turn 2 closes it at. */
  let openAt = 0;

  it("the two clients run as the Tool API's role and the runtime side's", SLOW, async () => {
    const [asApp] = await app<{ role: string }[]>`select current_user as role`;
    const [asJob] = await job<{ role: string }[]>`select current_user as role`;
    expect([asApp?.role, asJob?.role]).toEqual([TOOL_API_ROLE, RUNTIME_ROLE]);
    expect(app.options.max).toBe(APP_POOL);
    expect(APP_POOL).toBeGreaterThanOrEqual(2);
  });

  it(
    "turn 1: JOIN through the real turn face under bundle v0's id opens S1-02's question; its row is composed, finalized and delivered, and armClock moves the question to open at version 2",
    SLOW,
    async () => {
      openAt = await joinAndDeliver(main);
    },
  );

  it(
    "the words: the real matcher over the catalog as item 78 answers it, as rosie_app, lists each word of 'Barbershop, plumbing, electrical' with exactly one kind",
    SLOW,
    async () => {
      const before = sent.app.length;
      const { matcher } = await matcherOf(pgKindsReads(app, job));
      expect(
        matcher.match(WORDS).map((part) => [part.words, part.outcome, part.kinds.map((kind) => kind.kindId)]),
      ).toEqual([
        ["Barbershop", "listed", ["barber"]],
        ["plumbing", "listed", ["plumber"]],
        ["electrical", "listed", ["electrician"]],
      ]);
      // Item 78 ran on the Tool API's client, and names the kinds table alone.
      const statements = sent.app.slice(before).filter((text) => /\bfrom\b/u.test(text));
      expect(statements.length).toBeGreaterThan(0);
      for (const text of statements) expect(text).toMatch(/\bfrom kinds\b/u);
    },
  );

  it(
    "with the stop port left out, 'One isn't on the list yet' and 'Not a service we book' each answer notBuilt: nothing is written, and the question stays open at its version",
    SLOW,
    async () => {
      clock.now = NOW_2;
      const before = { core: await snapshot(cdb), kinds: await kindsRows() };
      for (const [turnId, choiceId, words] of [
        [`${TURN_2}-new-work`, "c-02", `Barbershop, ${PACK_HIKES}`],
        [`${TURN_2}-not-booked`, "c-03", GIFT_CARDS],
      ] as const) {
        const request = turnTwo(turnId, choiceId, words);
        const answer = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
        expect(answer, choiceId).toEqual({ error: "notBuilt", call: "gateAndCommit" });
        expect(await footprint(cdb, turnId), choiceId).toEqual(NO_FOOTPRINT);
        expect(await questionRow(QUESTION_1), choiceId).toEqual({
          status: "open",
          version: openAt,
          step: "S1-02",
        });
      }
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(before);
      expect(before.kinds).toEqual({
        kinds: 243,
        picked_kinds: 0,
        picked_kind_texts: 0,
        new_work_drafts: 0,
        review_items: 0,
      });
    },
  );

  it(
    "'All on the list' with the words 'Barbershop, plumbing, electrical' commits: three picks, the first pick's 11 text blocks, S1-02's question closed at its row's own version, S1-04's question with its clock row and one outbox row; a replay writes nothing",
    SLOW,
    async () => {
      clock.now = NOW_2;
      const exchange = commitS1_02();
      const before = await snapshot(cdb);
      const appBefore = sent.app.length;
      const request = turnTwo(TURN_2, "c-01", WORDS);
      const answer = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: TURN_2,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
      const committed = answer as unknown as {
        parts: Json[];
        written: { written: Json[]; outboxRows: Json[]; promoted: Json[] };
        openQuestions: { opened: string[]; closed: string[] };
      };
      // The part as commit-s1-02.json answers it: limits 1 to 4 and 6 pass, 5 not checked, and its 12 keys in order.
      expect(committed.parts).toEqual(exchange.outcome.parts);
      expect(committed.parts[0]?.gives).toEqual(exchange.given.stated.gives);
      expect(exchange.given.stated.gives).toHaveLength(12);

      // K-05's own answer: every row the commit wrote, each with its version after it.
      expect(committed.written.written).toEqual([
        { table: "picked_kinds", rowId: pickId(1), version: 1 },
        { table: "picked_kinds", rowId: pickId(2), version: 1 },
        { table: "picked_kinds", rowId: pickId(3), version: 1 },
        ...PF_TEXT_KEYS.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${pickId(1)}/${key}`,
          version: 1,
        })),
        { table: "open_questions", rowId: QUESTION_2, version: 1 },
        { table: "open_questions", rowId: QUESTION_1, version: openAt + 1 },
        { table: "clock_rows", rowId: `clock-${QUESTION_2}`, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([ROW_2]);
      expect(committed.openQuestions).toEqual({ opened: [QUESTION_2], closed: [QUESTION_1] });

      // The stored rows. S1-02's question, answered, one version past the one its row was read at.
      expect(await questionRow(QUESTION_1)).toEqual({
        status: "answered",
        version: openAt + 1,
        step: "S1-02",
      });
      const { sql } = cdb.db;
      // Three picks, positions 1 to 3, listed, with no company and no business.
      const picks = await sql<Json[]>`
        select id, owner_person_id, position, words, outcome, kind_id, company_id, business_id, version
        from picked_kinds order by position
      `;
      expect(picks).toEqual(
        [
          ["Barbershop", "barber"],
          ["plumbing", "plumber"],
          ["electrical", "electrician"],
        ].map(([words, kindId], index) => ({
          id: pickId(index + 1),
          owner_person_id: PERSON,
          position: index + 1,
          words,
          outcome: "listed",
          kind_id: kindId,
          company_id: null,
          business_id: null,
          version: 1,
        })),
      );
      // Exactly 11 text blocks, all the first pick's, each as bundle v1's barber overlay holds it.
      const texts = await sql<
        { picked_kind_id: string; pf_key: string; business_id: string | null; block: string }[]
      >`
        select picked_kind_id, pf_key, business_id, block from picked_kind_texts
      `;
      const overlay = overlayV1("barber") as { pluginText: Record<string, string> };
      expect(texts).toHaveLength(11);
      expect(
        [...texts].sort(
          (a, b) => PF_TEXT_KEYS.indexOf(a.pf_key as never) - PF_TEXT_KEYS.indexOf(b.pf_key as never),
        ),
      ).toEqual(
        PF_TEXT_KEYS.map((key) => ({
          picked_kind_id: pickId(1),
          pf_key: key,
          business_id: null,
          block: overlay.pluginText[key],
        })),
      );
      expect(trades.reads).toEqual([{ bundleId: V1, tradeId: "barber" }]);
      // S1-04's question to the owner, waiting, its clock row, and one outbox row with no plan yet.
      const [asked] = await sql<Json[]>`
        select step, status, handle_id, person_id, business_id, options, version from open_questions
        where id = ${QUESTION_2}
      `;
      expect(asked).toEqual({
        step: "S1-04",
        status: "waiting",
        handle_id: HANDLE,
        person_id: PERSON,
        business_id: BUSINESS,
        options: [],
        version: 1,
      });
      const clocks = await sql<Json[]>`
        select id, kind, state, open_question_id from clock_rows where created_by_turn_id = ${TURN_2} order by id
      `;
      expect(clocks).toContainEqual({
        id: `clock-${QUESTION_2}`,
        kind: "question",
        state: "waiting",
        open_question_id: QUESTION_2,
      });
      const outbox = await sql<Json[]>`
        select id, state, channel, send_class, open_question_id, recipient_handle_id, recipient_person_id,
               business_id, bundle_hash, bundle_build
        from outbox_rows where turn_id = ${TURN_2}
      `;
      expect(outbox).toEqual([
        {
          id: ROW_2,
          state: "planned",
          channel: "imessage",
          send_class: "quick_reply",
          open_question_id: QUESTION_2,
          recipient_handle_id: HANDLE,
          recipient_person_id: PERSON,
          business_id: BUSINESS,
          bundle_hash: V1.hash,
          bundle_build: V1.build,
        },
      ]);
      expect(await footprint(cdb, TURN_2)).toMatchObject({ turns: 1, outbox: 1, questions: 1, effects: 0 });
      expect(await kindsRows()).toEqual({
        kinds: 243,
        picked_kinds: 3,
        picked_kind_texts: 11,
        new_work_drafts: 0,
        review_items: 0,
      });

      // As rosie_app the turn sent no statement on a table that spans businesses, so none could answer 42501.
      const statements = sent.app.slice(appBefore);
      expect(statements.length).toBeGreaterThan(0);
      for (const text of statements) expect(text).not.toMatch(SPANS_BUSINESSES);
      // The walk's question read (through 0037), the commit's open-holds read and item 78 ran on the Tool API's client.
      expect(statements.some((text) => text.includes("open_questions_went_out("))).toBe(true);
      expect(statements.some((text) => /\bfrom safety_holds\b/u.test(text))).toBe(true);
      expect(statements.some((text) => /\bfrom kinds\b/u.test(text))).toBe(true);

      // A replay of the same turn answers the first commit and writes nothing.
      const written = { core: await snapshot(cdb), kinds: await kindsRows() };
      expect(written.core).not.toEqual(before);
      const again = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
      // The caller reads `repeated` first (commit.ts default 7): the replay gates the part again, against a question
      // that is closed by now, so its part's own answer is not the first run's and is not asserted here.
      expect(again).toMatchObject({ result: "committed", turnId: TURN_2, repeated: true });
      expect((again as unknown as typeof committed).written).toEqual({
        written: [],
        outboxRows: committed.written.outboxRows,
        promoted: [],
      });
      expect({ core: await snapshot(cdb), kinds: await kindsRows() }).toEqual(written);
    },
  );

  it(
    "then composeInput and finalizeMessage for the committed S1-04 row on bundle v1 succeed: S1-04's line, the reader by the sign-up line, no option, and its final parts written",
    SLOW,
    async () => {
      clock.finalize = FINALIZED_2;
      const caller = callerOf(TURN_2, TRACE_2);
      const compose = { caller, outboxRowId: ROW_2 };
      const composed = (await face.composeInput(
        structuredClone(compose),
        traceFor(compose).trace,
      )) as unknown as {
        result: string;
        input: Json & { masterText: { step: string; text: string }; audience: Json; options: unknown[] };
      };
      expect(composed, JSON.stringify(composed)).toMatchObject({ result: "compose" });
      expect(validator.check("composeInput", "response", composed)).toEqual([]);
      // S1-04's line as bundle v1 holds it, for a reader with no role, read by the sign-up line's audience: the owner.
      const step = (publishedBundleV1().flows.A as { steps: Record<string, { say: { text: string }[] }> })
        .steps["S1-04"];
      const line = step?.say[0]?.text ?? "";
      expect(line).not.toBe("");
      expect(composed.input).toMatchObject({
        row: ROW_2,
        turn: TURN_2,
        masterText: { step: "S1-04", text: line },
        audience: { role: "owner", name: null, way: "texts", handlingLine: null },
        situation: "routine",
        channel: "imessage",
        options: [],
        inbound: { text: WORDS },
      });

      // The plan a composer would give for it: the master text's question as the row's one question, with no option,
      // and its other sentence as the first line.
      const asks = line.slice(0, line.indexOf("?") + 1);
      const rest = line.slice(asks.length).trim();
      expect([asks, rest].every((part) => part.length > 0)).toBe(true);
      const finalize = {
        caller,
        outboxRowId: ROW_2,
        expectVersion: 1,
        attempt: "composed",
        plan: {
          row: ROW_2,
          channel: "imessage",
          copyOf: null,
          plan: {
            formats: ["text"],
            lines: [{ role: "first", text: rest }],
            question: { text: asks, optionIds: [] },
            pageType: null,
            threadReplyTo: null,
          },
        },
      };
      const finalized = (await face.finalizeMessage(
        structuredClone(finalize),
        traceFor(finalize).trace,
      )) as unknown as Finalized;
      expect(finalized.outcome, JSON.stringify(finalized)).toBe("send");
      expect(validator.check("finalizeMessage", "response", finalized)).toEqual([]);
      expect(finalized.finalParts.row).toBe(ROW_2);
      expect(finalized.finalParts.sends).toHaveLength(1);
      expect(finalized.finalParts.sends[0]).toMatchObject({ kind: "words", options: [] });
      // One text: the plan's line and its one question, each whole, inside the fixed lines code adds. This world holds
      // no phone row and no opener mark (the roster-owner seed writes none, and the send was played by a written part,
      // never by the outbox runner), so K-05's fixed-line facts read as before a first text, and the opener, the
      // opt-out line and the privacy link ride again.
      const lines = (finalized.finalParts.sends[0]?.text ?? "").split("\n");
      expect(lines[0]?.endsWith(rest)).toBe(true);
      expect(lines[1]).toBe(asks);
      expect(finalized.finalParts.fixedLines).toEqual(["opener", "optOutLine", "privacyLink"]);
      // The final parts are written with the plan, by K-05's writePlan on the runtime side.
      expect(await rowOf(cdb, "outbox_rows", ROW_2, ["turn_id", "state", "final_parts"])).toEqual({
        version: 2,
        turn_id: TURN_2,
        state: "checked",
        final_parts: finalized.finalParts,
      });
      // The row reads and the plan's write ran on the runtime side's client; as rosie_app nothing read a table that
      // spans businesses anywhere in this file.
      expect(sent.job.some((text) => /\boutbox_rows\b/u.test(text))).toBe(true);
      for (const text of sent.app) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );
});

// ---- T-1502: the second world, with S1-02's settler bound ------------------------------------------------------------

/** A statement that reads K-24's kinds table: item 78's read. */
const READS_KINDS = /\bfrom kinds\b/u;

describe("with S1-02's settler bound, a decision naming c-02 for the owner's words still writes 'All on the list''s rows (T-1502)", () => {
  const settledSent = { app: [] as string[], job: [] as string[] };
  const settledTrades = tradesOverV1();
  let settled: World;
  let openAt = 0;

  beforeAll(async () => {
    settled = await openWorld({
      schema: "turn_face_sign_up_settled",
      name: "rosie-turn-face-sign-up-settled",
      sent: settledSent,
      trades: settledTrades,
      settleSignUp: true,
    });
  }, 240_000);

  afterAll(async () => {
    await Promise.all([settled.app.end({ timeout: 5 }), settled.job.end({ timeout: 5 })]);
    await settled.cdb.close();
  });

  it("turn 1 opens S1-02's question in this world as in the first", SLOW, async () => {
    openAt = await joinAndDeliver(settled);
    expect(openAt).toBe(2);
  });

  it(
    "c-02 ('One isn't on the list yet') named for 'Barbershop, plumbing, electrical' commits 'All on the list''s rows: three listed picks, the first pick's 11 blocks, S1-02's question closed, S1-04's asked; the part's choiceId stays c-02; item 78 read once",
    SLOW,
    async () => {
      clock.now = NOW_2;
      const exchange = commitS1_02();
      // One read of item 78 on its own, as the settler and S1-02's writer share it: the statements it sends.
      const perRead = settledSent.app.length;
      await matcherOf(pgKindsReads(settled.app, settled.job));
      const oneRead = settledSent.app.slice(perRead).filter((text) => READS_KINDS.test(text)).length;
      expect(oneRead).toBeGreaterThan(0);

      const appBefore = settledSent.app.length;
      const request = turnTwo(TURN_2, "c-02", WORDS);
      const answer = await settled.face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
      expect(answer, JSON.stringify(answer)).toMatchObject({
        result: "committed",
        turnId: TURN_2,
        repeated: false,
      });
      expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
      const committed = answer as unknown as {
        parts: Json[];
        written: { written: Json[]; outboxRows: Json[] };
        openQuestions: { opened: string[]; closed: string[] };
      };
      // The part as commit-s1-02.json answers it, but for its choice: the option decide named, c-02 (default 191).
      expect(committed.parts).toEqual(exchange.outcome.parts.map((part) => ({ ...part, choiceId: "c-02" })));
      expect(committed.parts[0]?.gives).toEqual(exchange.given.stated.gives);

      // "All on the list"'s rows, as the first world's c-01 commit wrote them.
      expect(committed.written.written).toEqual([
        { table: "picked_kinds", rowId: pickId(1), version: 1 },
        { table: "picked_kinds", rowId: pickId(2), version: 1 },
        { table: "picked_kinds", rowId: pickId(3), version: 1 },
        ...PF_TEXT_KEYS.map((key) => ({
          table: "picked_kind_texts",
          rowId: `${pickId(1)}/${key}`,
          version: 1,
        })),
        { table: "open_questions", rowId: QUESTION_2, version: 1 },
        { table: "open_questions", rowId: QUESTION_1, version: openAt + 1 },
        { table: "clock_rows", rowId: `clock-${QUESTION_2}`, version: 1 },
      ]);
      expect(committed.written.outboxRows.map((row) => row.id)).toEqual([ROW_2]);
      expect(committed.openQuestions).toEqual({ opened: [QUESTION_2], closed: [QUESTION_1] });
      expect(await questionRow(QUESTION_1, settled.cdb)).toEqual({
        status: "answered",
        version: openAt + 1,
        step: "S1-02",
      });
      const picks = await settled.cdb.db.sql<Json[]>`
        select id, position, words, outcome, kind_id, company_id, business_id from picked_kinds order by position
      `;
      expect(picks).toEqual(
        [
          ["Barbershop", "barber"],
          ["plumbing", "plumber"],
          ["electrical", "electrician"],
        ].map(([words, kindId], index) => ({
          id: pickId(index + 1),
          position: index + 1,
          words,
          outcome: "listed",
          kind_id: kindId,
          company_id: null,
          business_id: null,
        })),
      );
      expect(settledTrades.reads).toEqual([{ bundleId: V1, tradeId: "barber" }]);
      expect(await kindsRows(settled.cdb)).toEqual({
        kinds: 243,
        picked_kinds: 3,
        picked_kind_texts: 11,
        new_work_drafts: 0,
        review_items: 0,
      });

      // The settler and S1-02's writer read one catalog: item 78's statements once, on the Tool API's client, and no
      // statement on a table that spans businesses.
      const statements = settledSent.app.slice(appBefore);
      expect(statements.filter((text) => READS_KINDS.test(text))).toHaveLength(oneRead);
      for (const text of statements) expect(text).not.toMatch(SPANS_BUSINESSES);
    },
  );
});
