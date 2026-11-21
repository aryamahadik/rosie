// T-1519's integration proof (DL-1048, from T-1517's round 2) on local PostgreSQL: `npm run db:up`, then
// `npm run test:integration -- actions/src/tool-api/turn-face/pg`. A JOIN from a number whose chat thread already exists
// gets S1-02's question committed, and the number still has one chat thread afterwards: S1-01 reuses it (commit/walk
// writes.ts default 12) where it used to insert a second one, which K-04's threads_one_chat_per_handle (0005) refused, so
// commitTurn answered constraint, wrote nothing, and JOIN got no reply.
//
// The world (a fresh schema, migrated with every migration and dropped when the file ends: commit/pg/test-support.ts):
//   - the roster-owner seed's (db/seeds/roster-owner.ts, run as it is) for two numbers in the fiction range, each a test
//     business of its own with its business_setup row, one person with no name and no role, the handle, the company and
//     its barber kind of work; each person's sealing key made as the gateway makes it at first sight (K-05 v1.2 item 29),
//     under a wrapping key made for this run alone;
//   - the registry row of bundle v0 as bundles/v0 publishes it (T-1146), which every JOIN here pins.
// Place 1, a returning number: its chat thread stored as S1-01's commit wrote it on Nov 18 (K-09 v1.5 default 135: kind
// chat, no booking, the Linq chat id of its text, no reply address, version 1), and nothing else of an earlier sign-up.
// Place 2, the roster-reset world in db/seeds/roster-reset's int-test shape (T-1517, rounds 1 to 3, DL-1043 and DL-1048):
// its JOIN through this face writes its chat thread and S1-02's question; then, as the user's phone stood on Nov 20
// (DL-1032), S1-02 answered with one plumbing pick and one text block, S1-04's question open with its clock armed; then
// the reset, statement for statement as db/seeds/roster-reset.ts makes it in one transaction as rosie_job with no business
// scope (questions withdrawn and clocks cancelled, versions raised; a fresh head of generation 2: business, setup row,
// person, company, and no company_kinds row since round 3; the handle's one link moved to the new person), then the
// gateway's first sight of the number's next text (the new person's key). The reset keeps every thread (roster-reset.ts
// lines 32 to 35), so the handle's chat thread is the one its first JOIN wrote.
//
// Who runs what: as sign-up.int.test.ts, two clients of this file's own, each statement's text written down (never a
// value): `app` as rosie_app (the call's transaction: the gate, readOpenHolds, the safety reads) and `job` as rosie_job
// (commitTurn, the sealer, and the walk's chat read: K-05 v1.10 item 51 readChatHandle, threads being the runtime's
// table). The schema owner's client only seeds the world and reads what the turns left.
//
// Real here: the Tool API base, the gate and limits 1 to 6 as registered, the commit, the walk, pgTurnCalls' binding
// with its chat read, runCore with the safety service, every data-access call, row-level security and the two roles.
// Given: the bundle as the frontier's fake over bundles/v0's own files, and the decided texts, K-09's commit-s1-01.json as
// each owner sends it (no model is called).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleSealingKey } from "../../../../../db/repo/handle-keys";
import type { Sql } from "../../../../../db/repo/scope";
import type { WrappingKeys } from "../../../../../db/repo/sealing";
import { ALLOWLIST_VARIABLE, rosterOwnerIds, seedRosterOwner } from "../../../../../db/seeds/roster-owner";
import { SKELETON_ROWS } from "../../../../../db/seeds/skeleton";
import type { GateAndCommitRequest } from "../../../commit";
import {
  RUNTIME_ROLE,
  TOOL_API_ROLE,
  footprint,
  openCommitDatabase,
  snapshot,
  type CommitDatabase,
} from "../../../commit/pg/test-support";
import { NOT_TOLD_YET, PLUGIN_LISTS_NO_STOP_WORDS } from "../../../domain/safety";
import { bundleIdOf, captureLog, checks, fakeBundles } from "../../../frontier/assemble/test-support";
import { traceFor } from "../../test-support";
import { commitS101, publishedBundleV0 } from "../calls-test-support";
import { NOTHING_OPEN_AT } from "../commit";
import type { TurnFace } from "../turn-face";
import { pgTurnCalls, pgTurnFace } from "./index";

type Json = Record<string, unknown>;

const SLOW = { timeout: 120_000 };
const APP_POOL = 2;
const JOB_POOL = 4;
const ZONE = "America/New_York";

const { validator, checker } = checks();

/** A wrapping key made for this run alone (never a real key: it wraps only this schema's test keys). */
const WRAP_BYTES = crypto.getRandomValues(new Uint8Array(32));
const KEYS: WrappingKeys = { resolve: () => WRAP_BYTES };
const WRAP_NAME = "SEALING_WRAP_KEY";

/** Two numbers in the fiction range (555-0100 to 555-0199), never a test phone's fixed fake handle or a real phone's. */
const RETURNING_NUMBER = "+15555550184";
const RESET_NUMBER = "+15555550185";

/** Place 1, the returning number: its roster ids, its Linq chat (a stand-in in K-06's form) and its Nov 18 thread. */
const RETURNING = rosterOwnerIds(1);
const RETURNING_CHAT = "linq-chat-demo-t1519-returning";
const NOV_18_THREAD = "thread-s1-01-turn-t1519-returning-nov18-1";

/** Place 2, the roster-reset world: its roster ids (generation 1), its Linq chat, and the fresh head of generation 2. */
const RESET = rosterOwnerIds(2);
const RESET_CHAT = "linq-chat-demo-t1519-reset";
const FRESH = {
  businessId: `${RESET.businessId}-g2`,
  companyId: `${RESET.companyId}-g2`,
  personId: `${RESET.personId}-g2`,
} as const;

const V0 = bundleIdOf(publishedBundleV0());

/** The JOINs, each under its own turn id; the rows the walk names from each turn's own id (K-09 v1.5 default 131). */
const TURN_RETURNING = "turn-t1519-returning-join";
const TURN_RESET_FIRST = "turn-t1519-reset-join-1";
const TURN_RESET_KINDS = "turn-t1519-reset-kinds";
const TURN_RESET_AGAIN = "turn-t1519-reset-join-2";
const questionOf = (turnId: string): string => `oq-s1-02-${turnId}-1`;
const rowOf = (turnId: string): string => `outbox-s1-02-${turnId}-1`;
const threadOf = (turnId: string): string => `thread-s1-01-${turnId}-1`;

/** What the user's phone held on Nov 20 (DL-1032), written as T-1517's int test writes it: made-up ids of this file's own. */
const S1_04_QUESTION = "oq-t1519-reset-s1-04";
const S1_04_CLOCK = "clock-t1519-reset-s1-04";
const PICK = "pick-t1519-reset-plumbing";

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

/** The owner a JOIN comes from: the business it is about, the person, the handle, the number and the Linq chat. */
interface Owner {
  readonly businessId: string;
  readonly personId: string;
  readonly handleId: string;
  readonly number: string;
  readonly chat: string;
}

const RETURNING_OWNER: Owner = {
  businessId: RETURNING.businessId,
  personId: RETURNING.personId,
  handleId: RETURNING.handleId,
  number: RETURNING_NUMBER,
  chat: RETURNING_CHAT,
};
const RESET_OWNER: Owner = {
  businessId: RESET.businessId,
  personId: RESET.personId,
  handleId: RESET.handleId,
  number: RESET_NUMBER,
  chat: RESET_CHAT,
};
/** The reset phone after the reset: the same handle, number and chat, under the fresh head. */
const FRESH_OWNER: Owner = { ...RESET_OWNER, businessId: FRESH.businessId, personId: FRESH.personId };

/** A JOIN: commit-s1-01.json's request as `owner` sends it under the turn id `turnId`, pinned to bundle v0 as published. */
function join(owner: Owner, turnId: string): GateAndCommitRequest {
  const request = renamed(
    commitS101().request,
    new Map<string, string>([
      ["biz-lees-barbershop", owner.businessId],
      ["person-sam", owner.personId],
      ["handle-sam", owner.handleId],
      ["+15555550100", owner.number],
      ["linq-chat-demo-sam", owner.chat],
      ["turn-s1-01-sam", turnId],
      ["trace-sam-0000", `trace-${turnId}`],
      ["evt-sam-s1-01", `evt-${turnId}`],
    ]),
  );
  if (request.turn === null || request.input.kind !== "decided") throw new Error("a JOIN is a decided turn");
  const { decided } = request.input;
  request.turn.bundleId = { ...V0 };
  decided.context.bundleId = { ...V0 };
  decided.decide.bundleId = { ...V0 };
  // The owner as the frontier names a person with no name and no role (frontier/assemble/frame.ts writerOf).
  decided.context.writer.people = [{ personId: owner.personId, name: "", roles: [], language: null }];
  return request;
}

// ---- the schema, its clients and the face -------------------------------------------------------------------------------

let cdb: CommitDatabase;
let app: Sql;
let job: Sql;
const sent = { app: [] as string[], job: [] as string[] };
let face: TurnFace;
const clock = { now: commitS101().given.now };

/** The gateway's first sight of a number (K-05 v1.2 item 29): the handle's person with no key gets one. Answers it. */
async function firstSight(number: string, tag: string): Promise<string> {
  const sighted = await handleSealingKey(cdb.runtime, KEYS, {
    handle: { kind: "phone", address: number },
    newHandleId: `handle-t1519-unused-${tag}`,
    newPersonId: `person-t1519-unused-${tag}`,
    wrappingKeyName: WRAP_NAME,
  });
  if (!("result" in sighted.outcome)) throw new Error("the first sight made no key");
  return sighted.outcome.personId;
}

beforeAll(async () => {
  cdb = await openCommitDatabase("turn_face_thread", JOB_POOL);
  const { sql } = cdb.db;
  // The registry row of bundle v0 as published, which every JOIN pins.
  await sql`
    insert into bundles (hash, build, manifest_key, built_at, published_at, active)
    values (${V0.hash}, ${V0.build}, ${`bundle/${V0.hash}/${String(V0.build)}/manifest`},
            '2026-11-10T08:00:00Z', '2026-11-10T08:05:00Z', false)
  `;
  // The roster-owner seed, as it is, for the two numbers: its own transaction as rosie_job.
  const seeded = await seedRosterOwner(sql, {
    env: { [ALLOWLIST_VARIABLE]: `${RETURNING_NUMBER},${RESET_NUMBER}` },
  });
  expect(seeded.ranAs).toBe(RUNTIME_ROLE);
  expect(seeded.owners.map((owner) => [owner.place, owner.handleId, owner.personId])).toEqual([
    [1, RETURNING.handleId, RETURNING.personId],
    [2, RESET.handleId, RESET.personId],
  ]);
  expect(await firstSight(RETURNING_NUMBER, "1")).toBe(RETURNING.personId);
  expect(await firstSight(RESET_NUMBER, "2")).toBe(RESET.personId);

  app = cdb.client(TOOL_API_ROLE, "rosie-turn-face-thread-app", APP_POOL, (text) => {
    sent.app.push(text.trim());
  });
  job = cdb.client(RUNTIME_ROLE, "rosie-turn-face-thread-job", JOB_POOL, (text) => {
    sent.job.push(text.trim());
  });
  const bundles = fakeBundles(publishedBundleV0());
  face = pgTurnFace(job, {
    bundles,
    validator,
    checker,
    log: captureLog().sink,
    calls: pgTurnCalls(job, app, {
      bundles,
      wrappingKeys: KEYS,
      stopWords: PLUGIN_LISTS_NO_STOP_WORDS,
      telling: NOT_TOLD_YET,
      now: () => new Date(clock.now),
    }),
  });
}, 240_000);

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), job.end({ timeout: 5 })]);
  await cdb.close();
});

// ---- what the turns left ------------------------------------------------------------------------------------------------

/** Every thread of a handle, as the owner reads them, in id order. */
async function threadsOf(handleId: string): Promise<Json[]> {
  const rows = await cdb.db.sql<Json[]>`
    select id, handle_id, kind, booking_id, linq_chat_id, reply_address, version from threads
    where handle_id = ${handleId} order by id
  `;
  return [...rows];
}

/** One open question's row, as the owner reads it. */
async function questionRow(id: string): Promise<Json | undefined> {
  const [row] = await cdb.db.sql<Json[]>`
    select step, status, handle_id, person_id, business_id, options, version from open_questions where id = ${id}
  `;
  return row;
}

/** The kinds of the event-log entries a turn wrote, in id order. */
async function entryKindsOf(turnId: string): Promise<string[]> {
  const rows = await cdb.db.sql<{ kind: string }[]>`
    select kind from event_log where turn_id = ${turnId} order by id
  `;
  return rows.map((row) => row.kind);
}

/** The committed answer, held to K-09 v1.5's response. */
function committedOf(answer: unknown): Json & {
  parts: Json[];
  written: { written: Json[]; outboxRows: Json[]; promoted: Json[] };
  openQuestions: { opened: string[]; closed: string[] };
} {
  expect(answer, JSON.stringify(answer)).toMatchObject({ result: "committed", repeated: false });
  expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
  return answer as ReturnType<typeof committedOf>;
}

/** A statement that reads K-04's threads table. */
const READS_THREADS = /\b(from|join)\s+threads\b/u;

/** One JOIN through the face: its answer, and the statements each client sent for it. */
async function joinThrough(request: GateAndCommitRequest): Promise<{
  answer: unknown;
  app: string[];
  job: string[];
}> {
  const before = { app: sent.app.length, job: sent.job.length };
  const answer = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
  return { answer, app: sent.app.slice(before.app), job: sent.job.slice(before.job) };
}

/**
 * What S1-01 and S1-02 commit for a JOIN under `turnId` whose handle's chat thread already exists: commit-s1-01.json's
 * part (S1-01 gives thread), S1-02's question opened, and its question, clock row and outbox row written, with no thread.
 */
function expectJoinWithItsThread(committed: ReturnType<typeof committedOf>, turnId: string): void {
  expect(committed.parts).toEqual(commitS101().outcome.parts);
  expect(committed.parts[0]?.gives).toEqual(["thread"]);
  expect(committed.openQuestions).toEqual({ opened: [questionOf(turnId)], closed: [] });
  expect(committed.written.written).toEqual([
    { table: "open_questions", rowId: questionOf(turnId), version: 1 },
    { table: "clock_rows", rowId: `clock-${questionOf(turnId)}`, version: 1 },
  ]);
  expect(committed.written.outboxRows.map((row) => row.id)).toEqual([rowOf(turnId)]);
}

// ---- place 1: a returning number ----------------------------------------------------------------------------------------

describe("a number whose chat thread exists sends JOIN: S1-02's question is committed, with one chat thread afterwards (T-1519)", () => {
  /** The thread as the Nov 18 S1-01 wrote it (K-09 v1.5 default 135), version 1. */
  const nov18Thread = {
    id: NOV_18_THREAD,
    handle_id: RETURNING.handleId,
    kind: "chat",
    booking_id: null,
    linq_chat_id: RETURNING_CHAT,
    reply_address: null,
    version: 1,
  };

  beforeAll(async () => {
    const { sql } = cdb.db;
    await sql`
      insert into threads (id, handle_id, kind, booking_id, linq_chat_id, reply_address)
      values (${NOV_18_THREAD}, ${RETURNING.handleId}, 'chat', null, ${RETURNING_CHAT}, null)
    `;
    expect(await threadsOf(RETURNING.handleId)).toEqual([nov18Thread]);
  }, 60_000);

  it(
    "JOIN commits S1-01 (it gives thread) and S1-02's question, its clock row and its quick reply; no thread is inserted, and the Nov 18 thread is the handle's one chat thread, unchanged",
    SLOW,
    async () => {
      const turn = await joinThrough(join(RETURNING_OWNER, TURN_RETURNING));
      const committed = committedOf(turn.answer);
      expect(committed.turnId).toBe(TURN_RETURNING);
      expectJoinWithItsThread(committed, TURN_RETURNING);

      // The handle's one chat thread is the Nov 18 one, as it was; no thread row and no thread.created entry is new.
      expect(await threadsOf(RETURNING.handleId)).toEqual([nov18Thread]);
      expect(await entryKindsOf(TURN_RETURNING)).not.toContain("thread.created");
      expect(await footprint(cdb, TURN_RETURNING)).toMatchObject({
        turns: 1,
        outbox: 1,
        questions: 1,
        clocks: 1,
        effects: 0,
      });
      // S1-02's question to the owner, waiting, at the owner's business.
      expect(await questionRow(questionOf(TURN_RETURNING))).toEqual({
        step: "S1-02",
        status: "waiting",
        handle_id: RETURNING.handleId,
        person_id: RETURNING.personId,
        business_id: RETURNING.businessId,
        options: [],
        version: 1,
      });
      const [row] = await cdb.db.sql<Json[]>`
        select state, channel, send_class, open_question_id, recipient_handle_id, recipient_person_id, business_id
        from outbox_rows where id = ${rowOf(TURN_RETURNING)}
      `;
      expect(row).toEqual({
        state: "planned",
        channel: "imessage",
        send_class: "quick_reply",
        open_question_id: questionOf(TURN_RETURNING),
        recipient_handle_id: RETURNING.handleId,
        recipient_person_id: RETURNING.personId,
        business_id: RETURNING.businessId,
      });

      // The chat read ran on the runtime side's client (K-05 v1.10 item 51), and as rosie_app no statement read threads.
      expect(turn.job.some((text) => READS_THREADS.test(text))).toBe(true);
      expect(turn.app.length).toBeGreaterThan(0);
      for (const text of turn.app) expect(text).not.toMatch(READS_THREADS);
    },
  );

  it("a replay of the same JOIN answers the first commit and writes nothing", SLOW, async () => {
    const before = await snapshot(cdb);
    const request = join(RETURNING_OWNER, TURN_RETURNING);
    const again = await face.gateAndCommit(request, NOTHING_OPEN_AT, traceFor(request).trace);
    expect(again).toMatchObject({ result: "committed", turnId: TURN_RETURNING, repeated: true });
    expect(await snapshot(cdb)).toEqual(before);
    expect(await threadsOf(RETURNING.handleId)).toEqual([nov18Thread]);
  });
});

// ---- place 2: the roster-reset world, then JOIN -------------------------------------------------------------------------

describe("the roster-reset world followed by JOIN commits S1-01 and S1-02 (T-1519; T-1517's reset)", () => {
  /** The thread the phone's first JOIN writes, through this face, as S1-01 has always written it. */
  const firstThread = {
    id: threadOf(TURN_RESET_FIRST),
    handle_id: RESET.handleId,
    kind: "chat",
    booking_id: null,
    linq_chat_id: RESET_CHAT,
    reply_address: null,
    version: 1,
  };

  it(
    "the phone's first JOIN, with no chat thread yet, inserts its thread exactly as before: the read finds none",
    SLOW,
    async () => {
      expect(await threadsOf(RESET.handleId)).toEqual([]);
      const committed = committedOf((await joinThrough(join(RESET_OWNER, TURN_RESET_FIRST))).answer);
      expect(committed.parts).toEqual(commitS101().outcome.parts);
      expect(committed.written.written).toEqual([
        { table: "threads", rowId: threadOf(TURN_RESET_FIRST), version: 1 },
        { table: "open_questions", rowId: questionOf(TURN_RESET_FIRST), version: 1 },
        { table: "clock_rows", rowId: `clock-${questionOf(TURN_RESET_FIRST)}`, version: 1 },
      ]);
      expect(await threadsOf(RESET.handleId)).toEqual([firstThread]);
      expect(await entryKindsOf(TURN_RESET_FIRST)).toContain("thread.created");
    },
  );

  it(
    "as the phone stood on Nov 20 (S1-02 answered with one plumbing pick, S1-04 open with its clock armed), the reset withdraws and cancels what is live and moves the handle to a fresh head, keeping the thread",
    SLOW,
    async () => {
      const { sql } = cdb.db;
      // Turn 2 as T-1517's int test writes it: S1-02 answered, one plumbing pick with no company and one text block,
      // and S1-04's question open with its clock armed at delivery.
      await sql.begin(async (tx) => {
        await tx`
          insert into turns (id, handle_id, event_ids, state, bundle_hash, bundle_build, trace_id, committed_at)
          values (${TURN_RESET_KINDS}, ${RESET.handleId}, ${[`evt-${TURN_RESET_KINDS}`]}, 'committed', ${V0.hash},
                  ${V0.build}, ${`trace-${TURN_RESET_KINDS}`}, '2026-11-20T22:15:13Z')
        `;
        await tx`
          update open_questions set status = 'answered', closed_at = '2026-11-20T22:15:13Z', version = version + 1
          where id = ${questionOf(TURN_RESET_FIRST)}
        `;
        await tx`
          insert into kinds (id, name, style, pattern, source)
          values ('plumbing', 'Plumbing', 'trade', 'fix', 'trade_file') on conflict do nothing
        `;
        await tx`
          insert into picked_kinds (id, owner_person_id, position, words, outcome, kind_id, picked_at)
          values (${PICK}, ${RESET.personId}, 1, 'Plumbing', 'listed', 'plumbing', '2026-11-20T22:15:13Z')
        `;
        await tx`
          insert into picked_kind_texts (picked_kind_id, pf_key, block) values (${PICK}, 'pf.license', '"none"')
        `;
        await tx`
          insert into open_questions (id, turn_id, handle_id, person_id, business_id, step, options, versions_read,
                                      bundle_hash, bundle_build, status)
          values (${S1_04_QUESTION}, ${TURN_RESET_KINDS}, ${RESET.handleId}, ${RESET.personId}, ${RESET.businessId},
                  'S1-04', '[]', '[]', ${V0.hash}, ${V0.build}, 'open')
        `;
        await tx`
          insert into clock_rows (id, kind, open_question_id, handle_id, business_id, due_at, due_zone, state, armed_at,
                                  fires, created_by_turn_id)
          values (${S1_04_CLOCK}, 'question', ${S1_04_QUESTION}, ${RESET.handleId}, ${RESET.businessId},
                  '2026-11-22T01:00:00Z', ${ZONE}, 'armed', '2026-11-20T22:15:34Z', '{}', ${TURN_RESET_KINDS})
        `;
      });

      // The reset, statement for statement as db/seeds/roster-reset.ts makes it (rounds 1 to 3): one transaction as
      // rosie_job with no business scope.
      const [business] = SKELETON_ROWS.businesses;
      const [company] = SKELETON_ROWS.companies;
      if (business === undefined || company === undefined) throw new Error("the skeleton seed's head rows");
      const closed = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${RUNTIME_ROLE}`);
        await tx`select set_config('rosie.business_id', '', true)`;
        const questions = await tx`
          update open_questions set status = 'withdrawn', closed_at = now(), version = version + 1
          where handle_id = ${RESET.handleId} and status in ('waiting', 'open')
        `;
        const clocks = await tx`
          update clock_rows set state = 'cancelled', cancelled_at = now(), version = version + 1
          where state in ('waiting', 'armed')
            and (handle_id = ${RESET.handleId}
                 or open_question_id in (select id from open_questions where handle_id = ${RESET.handleId}))
        `;
        await tx`
          insert into businesses (id, name, display_name, status, time_zone, text_hours_start, text_hours_end, version)
          values (${FRESH.businessId}, ${business.name}, ${business.display_name}, ${business.status},
                  ${business.time_zone}, ${business.text_hours_start}, ${business.text_hours_end}, ${business.version})
        `;
        await tx`insert into business_setup (business_id) values (${FRESH.businessId})`;
        await tx`insert into persons (id, name, language) values (${FRESH.personId}, null, null)`;
        await tx`
          insert into companies (id, owner_person_id, name, business_id, version)
          values (${FRESH.companyId}, ${FRESH.personId}, ${company.name}, ${FRESH.businessId}, ${company.version})
        `;
        const unlinked = await tx`
          delete from person_handles where person_id = ${RESET.personId} and handle_id = ${RESET.handleId}
        `;
        await tx`insert into person_handles (person_id, handle_id) values (${FRESH.personId}, ${RESET.handleId})`;
        return { questions: questions.count, clocks: clocks.count, unlinked: unlinked.count };
      });
      // S1-04's question withdrawn; its clock and S1-02's (never cancelled by the answer: T-1461's open question 1)
      // cancelled; the one link moved.
      expect(closed).toEqual({ questions: 1, clocks: 2, unlinked: 1 });
      expect(await questionRow(S1_04_QUESTION)).toMatchObject({ status: "withdrawn", version: 2 });

      // The next text's first sight gives the fresh person, who has none, a key (K-05 v1.2 item 29, step 3).
      expect(await firstSight(RESET_NUMBER, "2-again")).toBe(FRESH.personId);
      // The reset kept the handle's chat thread: the one the first JOIN wrote.
      expect(await threadsOf(RESET.handleId)).toEqual([firstThread]);
    },
  );

  it(
    "JOIN under the fresh head commits S1-01 (it gives thread) and S1-02's question to the fresh person at the fresh business, with the first JOIN's thread still the handle's one chat thread",
    SLOW,
    async () => {
      const turn = await joinThrough(join(FRESH_OWNER, TURN_RESET_AGAIN));
      const committed = committedOf(turn.answer);
      expect(committed.turnId).toBe(TURN_RESET_AGAIN);
      expectJoinWithItsThread(committed, TURN_RESET_AGAIN);

      expect(await threadsOf(RESET.handleId)).toEqual([firstThread]);
      expect(await entryKindsOf(TURN_RESET_AGAIN)).not.toContain("thread.created");
      expect(await questionRow(questionOf(TURN_RESET_AGAIN))).toEqual({
        step: "S1-02",
        status: "waiting",
        handle_id: RESET.handleId,
        person_id: FRESH.personId,
        business_id: FRESH.businessId,
        options: [],
        version: 1,
      });
      const [row] = await cdb.db.sql<Json[]>`
        select state, send_class, open_question_id, recipient_handle_id, recipient_person_id, business_id
        from outbox_rows where id = ${rowOf(TURN_RESET_AGAIN)}
      `;
      expect(row).toEqual({
        state: "planned",
        send_class: "quick_reply",
        open_question_id: questionOf(TURN_RESET_AGAIN),
        recipient_handle_id: RESET.handleId,
        recipient_person_id: FRESH.personId,
        business_id: FRESH.businessId,
      });
      // The old sign-up stays as it ended: S1-02 answered, S1-04 withdrawn, the pick with the old person.
      expect(await questionRow(questionOf(TURN_RESET_FIRST))).toMatchObject({ status: "answered" });
      expect(await questionRow(S1_04_QUESTION)).toMatchObject({ status: "withdrawn" });
      const [pick] = await cdb.db.sql<Json[]>`select owner_person_id from picked_kinds where id = ${PICK}`;
      expect(pick).toEqual({ owner_person_id: RESET.personId });

      expect(turn.job.some((text) => READS_THREADS.test(text))).toBe(true);
      for (const text of turn.app) expect(text).not.toMatch(READS_THREADS);
    },
  );
});
