// T-306: the commit path on local PostgreSQL (C-087, C-084; `npm run db:up`, `npm run migrate`, then
// `npm run test:integration -- actions/src/commit`). T-305's gateAndCommit runs through the Tool API base (T-290) as the
// handle actor calls it: each call in its own business-scoped transaction as rosie_app, and the turn's one K-05 request
// sent through the commit's port on PostgreSQL (pg/commit-turn.ts) to T-195's commitTurn, which writes it in a transaction
// of its own on the runtime side as rosie_job (K-05 README "Scope"), over a fresh schema migrated with every migration
// (pg/test-support.ts; the public schema is never touched, and the schema is dropped when the file ends).
//
// Real here: the Tool API base and its K-09 checks, the commit (the holds, the gate, the request building and the one
// reload), the K-05 call, PostgreSQL with the core migrations, and the application roles. Doubles, because their tasks have
// not landed: limits 1 to 6 (the gate framework's scripted doubles, each passing), what is open on the handle (nothing),
// and what a passed part writes (the walk, writesOf), which hands the commit the writes K-05's own fixtures state, with the
// rows its decision rests on at the versions shown (UnitWrites.versionsRead), as limit 4's compareAndSetOf will once the
// walk is wired (T-302). The turns carry no core action. Each turn's decided texts are a K-09 gate exchange's (a text of
// Alex's, or one of Sam's, at Lee's Barbershop), under the turn row of the K-05 fixture whose writes it commits.
//
// The card's proofs: a commit failing on its last row leaves no row of the turn (all or nothing); 100 parallel commits of
// one turn id give one set of rows, and the other 99 answer the first commit (exactly once); of two turns on one booking
// version in parallel, exactly one commits (limit 4 under real compare-and-set).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBusiness, type Tx } from "../../../../db/repo/scope";
import type { GateRequest } from "../../gate/framework";
import {
  copy,
  decidedOf,
  gateExchange,
  gateRequest,
  scriptedLimits,
} from "../../gate/framework/test-support";
import {
  createToolApi,
  createToolApiValidator,
  notBuiltHandlers,
  type BusinessScope,
  type ToolApi,
} from "../../tool-api";
import { traceFor } from "../../tool-api/test-support";
import { CommitRefusedError, gateAndCommitHandler } from "../index";
import { contractChecks, k05Exchange, noWrites } from "../test-support";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnAnswer,
  CommitTurnRequest,
  CommitTurnResponse,
  Committed,
  OutboxRowNew,
  RowRef,
  UnitWrites,
} from "../types";
import { pgCommitDeps, pgCommitTurn } from "./index";
import {
  NO_FOOTPRINT,
  RUNTIME_ROLE,
  TOOL_API_ROLE,
  footprint,
  holdTime,
  insertJobEntry,
  lockWaiters,
  openCommitDatabase,
  rowOf,
  seed,
  snapshot,
  writesIn,
  type CommitDatabase,
} from "./test-support";

const SLOW = { timeout: 60_000 };
/** Connections per application client: modest, so 100 parallel calls queue for them as a busy Worker's would. */
const POOL = 10;

/** K-04's seeds every test loads: bundle v0, the three shops, their people, handles and phones, Alex's haircut (version 7). */
const SEEDS = ["seed-bundle-registry.json", "seed-reservation.json"];
const BUSINESS = "biz-lees-barbershop";
/** K-04 seed-booking-head.json: Alex's haircut at Lee's Barbershop, version 7. */
const HAIRCUT = "booking-alex-haircut";

/** K-05: Alex books Riley for Nov 14 on his exact yes, the calendar write pending in the same commit (after reserve-10-min). */
const BOOKS = "commit-writes-effect.json";
/** K-05: Alex cancels his haircut (A7-02); in the fixture his turn read it at version 6, after another chat moved it to 7. */
const CANCELS = "commit-version-changed.json";
/** K-09: a text of Alex's at Lee's Barbershop (his answer to A7-17), a turn's own call. */
const ALEX_TEXT = "commit-limit-2-owner-rule.json";
/** K-09: a text of Sam's at Lee's Barbershop (his answer to S2-22), a turn's own call. */
const SAM_TEXT = "commit-limit-4-changed.json";

const fail = (what: string): never => {
  throw new Error(what);
};

// ---- the turns --------------------------------------------------------------------------------------------------------

/** A turn row's keys: its id, its handle, its one text's event and its trace. */
interface TurnKey {
  readonly id: string;
  readonly handleId: string;
  readonly eventId: string;
  readonly traceId: string;
}

function keyOf(turn: {
  readonly id: string;
  readonly handleId: string;
  readonly eventIds: readonly string[];
  readonly traceId: string;
}): TurnKey {
  const [eventId] = turn.eventIds;
  if (eventId === undefined) return fail("a turn joins at least one text");
  return { id: turn.id, handleId: turn.handleId, eventId, traceId: turn.traceId };
}

/** K-05 commit-writes-effect.json's turn: Alex's exact yes. */
const ALEX_BOOKS = keyOf(k05Exchange(BOOKS).request.turn);
/** K-05 commit-version-changed.json's turn: Alex's cancel. */
const ALEX_CANCELS = keyOf(k05Exchange(CANCELS).request.turn);
/** K-09 commit-limit-4-changed.json's own turn: Sam's text, from his chat. */
const SAM = keyOf(gateExchange(SAM_TEXT).request.turn ?? fail(`${SAM_TEXT} carries a turn`));

/**
 * A turn's gateAndCommit request as the handle actor sends it (gateRequest: a turn's caller under the business its choices
 * are for, acting for the writer, no core action): a K-09 gate exchange's decided texts under `key`'s turn row.
 */
function turnRequest(file: string, key: TurnKey): GateRequest {
  const decided = copy(decidedOf(gateExchange(file)));
  decided.context.turnId = key.id;
  decided.decide.turnId = key.id;
  const [text, ...more] = decided.context.texts;
  decided.context.texts = [{ ...text, eventId: key.eventId }, ...more];
  const request = gateRequest(decided);
  return {
    ...request,
    caller: { ...request.caller, traceId: key.traceId },
    turn: {
      id: key.id,
      handleId: key.handleId,
      eventIds: [key.eventId, ...more.map((each) => each.eventId)],
      bundleId: copy(decided.decide.bundleId),
      traceId: key.traceId,
      joinedTraceIds: [],
      tries: 1,
    },
  };
}

// ---- what each turn's one passed part writes (the walk's double) ---------------------------------------------------------

/**
 * K-05 commit-writes-effect.json's writes, as its turn's passed part hands them to the commit: the booking and its own
 * entry, the replies to Alex and to Sam, the held time confirmed and the calendar write, on the business row it read.
 */
function alexBooksRiley(): UnitWrites {
  const { request } = k05Exchange(BOOKS);
  const { writes } = request;
  const entry = writes.events.find((each) => each.tableName === "bookings");
  if (entry === undefined || writes.effects === undefined) return fail(`${BOOKS} changed`);
  return {
    ...noWrites({ step: "A6-14", choice: null }),
    versionsRead: request.versionsRead,
    state: writes.state,
    stateEvents: [entry],
    messages: writes.outboxRows,
    reservations: writes.reservations,
    effects: { write: writes.effects.write, letGo: [] },
  };
}

/** The haircut at `version`, as a turn's decision reads it (limit 4: every row the read-back showed). */
const haircutAt = (version: number): RowRef => ({ table: "bookings", rowId: HAIRCUT, version });

/** A reply about Alex's haircut to one handle, in K-05 commit-alex-cancels-while-sending.json's row form: no plan yet. */
function haircutReply(id: string, handleId: string, personId: string, version: number): OutboxRowNew {
  return {
    id,
    recipientHandleId: handleId,
    recipientPersonId: personId,
    businessId: BUSINESS,
    bookingId: HAIRCUT,
    channel: "imessage",
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [haircutAt(version)],
  };
}

/** K-05 commit-version-changed.json's cancel and its entry, as a turn that read the haircut at version 7 makes it, with Alex's reply. */
function alexCancels(): UnitWrites {
  const { request } = k05Exchange(CANCELS);
  const [write] = request.writes.state;
  const [entry] = request.writes.events;
  if (write?.op !== "update" || entry === undefined) return fail(`${CANCELS} changed`);
  return {
    ...noWrites({ step: "A7-02", choice: null }),
    versionsRead: [haircutAt(7)],
    state: [{ ...write, expectVersion: 7 }],
    stateEvents: [entry],
    messages: [haircutReply("out-alex-haircut-cancelled", "handle-alex", "person-alex", 8)],
  };
}

/** From Sam's chat, on the same version 7: Sam marks the haircut done (the owner hub, S11-12), with Sam's reply. */
function samMarksDone(): UnitWrites {
  const cancel = alexCancels();
  const [write] = cancel.state;
  const [entry] = cancel.stateEvents;
  if (write?.op !== "update" || entry === undefined) return fail("alexCancels changed");
  return {
    ...cancel,
    why: { step: "S11-12", choice: null },
    state: [{ ...write, set: { stage: "done" } }],
    stateEvents: [
      {
        ...entry,
        id: "log-booking-alex-haircut-done",
        kind: "booking.stage_changed",
        actorPersonId: "person-sam",
        actorRole: "owner",
        newValues: { stage: "done" },
        why: { step: "S11-12" },
        approvedBy: null,
      },
    ],
    messages: [haircutReply("out-sam-haircut-done", "handle-sam", "person-sam", 8)],
  };
}

/** Sam's reply about the haircut, decided on its version 7: no booking row written, so only what it read names the booking. */
function samReplies(): UnitWrites {
  return {
    ...noWrites({ step: "S11-12", choice: null }),
    versionsRead: [haircutAt(7)],
    messages: [haircutReply("out-sam-haircut-reply", "handle-sam", "person-sam", 7)],
  };
}

// ---- the commit's ports, the Tool API base and the database ---------------------------------------------------------------

let cdb: CommitDatabase;

beforeAll(async () => {
  cdb = await openCommitDatabase("t306_commit", POOL);
}, 60_000);

afterAll(async () => {
  await cdb.close();
});

/** One K-05 exchange of the port on PostgreSQL, as sent and as answered. */
interface Exchange {
  readonly turnId: string;
  readonly request: CommitTurnRequest;
  readonly answer: CommitTurnAnswer;
}

/** The port on PostgreSQL, every exchange written down (an observer: the request goes on unchanged). */
function recorded(port: CommitPorts<Tx>["commitTurn"], exchanges: Exchange[]): CommitPorts<Tx>["commitTurn"] {
  return async (request, call) => {
    const sent = copy(request);
    const answer = await port(request, call);
    exchanges.push({ turnId: sent.turn.id, request: sent, answer: copy(answer) });
    return answer;
  };
}

/** How many calls of a port were in flight at once: now, and at most. */
interface InFlight {
  now: number;
  peak: number;
}

/** The port, its calls in flight counted (an observer: each call goes on unchanged). */
function counted(port: CommitPorts<Tx>["commitTurn"], inFlight: InFlight): CommitPorts<Tx>["commitTurn"] {
  return async (request, call) => {
    inFlight.now += 1;
    inFlight.peak = Math.max(inFlight.peak, inFlight.now);
    try {
      return await port(request, call);
    } finally {
      inFlight.now -= 1;
    }
  };
}

/**
 * The commit's deps: limits 1 to 6 as doubles that pass, nothing open on the handle, each turn's passed part writing
 * `writes[turn id]` (no core action in these turns), and K-05 on PostgreSQL.
 */
function depsFor(
  commitTurn: CommitPorts<Tx>["commitTurn"],
  writes: Readonly<Record<string, UnitWrites>>,
): CommitDeps<Tx> {
  return {
    limits: scriptedLimits(),
    ports: {
      commitTurn,
      writesOf: (_part, turn) => {
        const unit = writes[turn.turn.id];
        return unit === undefined
          ? Promise.reject(new Error("no writes for this turn"))
          : Promise.resolve(copy(unit));
      },
      runCore: () => Promise.reject(new Error("these turns carry no core action")),
      openHolds: () => Promise.resolve({ holds: [], unreadEventIds: [] }),
    },
  };
}

const validator = createToolApiValidator();

/** The Tool API base with gateAndCommit on `deps`: each call in one transaction scoped to its business, as rosie_app. */
function toolApi(deps: CommitDeps<Tx>): ToolApi {
  const scope: BusinessScope<Tx> = {
    withBusiness: (businessId, work) => withBusiness(cdb.toolApi, businessId, work),
  };
  return createToolApi<Tx>({
    validator,
    scope,
    handlers: { ...notBuiltHandlers(), gateAndCommit: gateAndCommitHandler(deps) },
  });
}

/** One gateAndCommit call through the base, on its own trace. */
function gateAndCommitCall(api: ToolApi, request: GateRequest): Promise<unknown> {
  return api.call("gateAndCommit", request, traceFor(request).trace);
}

/** A committed K-09 answer (the base held it to K-09 v1 before it came back). */
function committed(answer: unknown): Committed {
  expect(answer).toMatchObject({ result: "committed" });
  return answer as Committed;
}

/** A K-05 answer that committed. */
function k05Committed(answer: CommitTurnAnswer): CommitTurnResponse {
  return "error" in answer ? fail(`expected a commit, got ${answer.error}`) : answer;
}

/** The port on PostgreSQL, at the K-05 fixture's moment (its `given.now`). */
function portAt(file: string, exchanges: Exchange[], runtime = cdb.runtime): CommitPorts<Tx>["commitTurn"] {
  const now = new Date(k05Exchange(file).given.now);
  return recorded(pgCommitTurn<Tx>(runtime, { now: () => now }), exchanges);
}

/** What a turn that read the haircut at 7 meets once it is at 8 (limit 4: K-05 versionChanged). */
const HAIRCUT_CHANGED = {
  error: "versionChanged",
  changed: [{ table: "bookings", rowId: HAIRCUT, readVersion: 7, currentVersion: 8 }],
};

// ---- the tests ---------------------------------------------------------------------------------------------------------

describe("the commit path on PostgreSQL: gateAndCommit through the Tool API base, its K-05 port on T-195's commitTurn", () => {
  it("the runtime client runs as rosie_job and the Tool API's as rosie_app, on this file's schema", async () => {
    const roles = await Promise.all(
      [cdb.runtime, cdb.toolApi].map(async (sql) => {
        const [row] = await sql<{ who: string; path: string }[]>`
          select current_user as who, current_setting('search_path') as path
        `;
        return row;
      }),
    );
    const path = `${cdb.db.schema}, public`;
    expect(roles).toEqual([
      { who: RUNTIME_ROLE, path },
      { who: TOOL_API_ROLE, path },
    ]);
  });

  it(
    "Alex's booking: T-305's one request, sent to T-195's commitTurn, answers K-05's own outcome for that turn",
    SLOW,
    async () => {
      await seed(cdb, SEEDS);
      await holdTime(cdb);
      const exchange = k05Exchange(BOOKS);
      const fixture = k05Committed(exchange.outcome);
      const exchanges: Exchange[] = [];
      const api = toolApi(depsFor(portAt(BOOKS, exchanges), { [ALEX_BOOKS.id]: alexBooksRiley() }));

      const answer = committed(await gateAndCommitCall(api, turnRequest(ALEX_TEXT, ALEX_BOOKS)));

      // One K-05 request: the fixture's turn row and the row it read, and its writes with an entry for each row written.
      expect(exchanges).toHaveLength(1);
      const [sent] = exchanges;
      if (sent === undefined) return fail("no exchange");
      expect(contractChecks().k05("commitTurn.request", sent.request)).toEqual([]);
      expect(sent.request.turn).toEqual(exchange.request.turn);
      expect(sent.request.versionsRead).toEqual(exchange.request.versionsRead);
      expect(sent.request.writes.events.map((entry) => entry.id)).toEqual([
        "log-booking-alex-riley-nov14",
        "log-out-alex-booked-riley-created",
        "log-out-sam-booked-riley-created",
        "log-rsv-alex-riley-nov14-booked",
        "log-eff-cal-riley-alex-nov14-write-created",
      ]);
      // K-05's answer on PostgreSQL is the fixture's own outcome, and K-09's answer carries it.
      expect(sent.answer).toEqual(exchange.outcome);
      expect(contractChecks().k05("commitTurn.response", sent.answer)).toEqual([]);
      expect(answer).toMatchObject({
        turnId: ALEX_BOOKS.id,
        committedAt: fixture.committedAt,
        repeated: false,
        parts: [{ part: 0, result: "committed" }],
        written: fixture.committed,
        effects: [{ effectId: "eff-cal-riley-alex-nov14-write", kind: "calendar_write" }],
        openQuestions: { opened: [], closed: [] },
      });

      // The rows, each under the turn id, every entry with the turn's trace and bundle.
      expect(await footprint(cdb, ALEX_BOOKS.id)).toEqual({
        ...NO_FOOTPRINT,
        turns: 1,
        outbox: 2,
        events: 5,
        effects: 1,
      });
      expect(await rowOf(cdb, "bookings", "booking-alex-riley-nov14", ["stage"])).toEqual({
        version: 1,
        stage: "booked",
      });
      expect(await rowOf(cdb, "reservations", "rsv-alex-riley-nov14", ["state", "booking_id"])).toEqual({
        version: 2,
        state: "booked",
        booking_id: "booking-alex-riley-nov14",
      });
      expect(await rowOf(cdb, "clock_rows", "rsv-alex-riley-nov14/saved-time", ["state"])).toEqual({
        version: 2,
        state: "cancelled",
      });
      const entries = await cdb.db.sql<{ trace_id: string; bundle_hash: string; bundle_build: number }[]>`
        select distinct trace_id, bundle_hash, bundle_build from event_log where turn_id = ${ALEX_BOOKS.id}
      `;
      expect(entries).toEqual([
        {
          trace_id: ALEX_BOOKS.traceId,
          bundle_hash: exchange.request.turn.bundleId.hash,
          bundle_build: exchange.request.turn.bundleId.build,
        },
      ]);
    },
  );
});

describe("all or nothing: a commit failing on its last row leaves no row of the turn (arch 01 line 39)", () => {
  it(
    "the database refuses the commit's last row: the call answers constraint, and the rows written before it are gone",
    SLOW,
    async () => {
      await seed(cdb, SEEDS);
      await holdTime(cdb);
      // The commit's last row: T-195 writes the request's entries last, and T-305 writes them in K-05's list order, so
      // the last is the entry of the turn's last row, its calendar write. A job's entry already holds that id.
      const last = "log-eff-cal-riley-alex-nov14-write-created";
      await insertJobEntry(cdb, last, "effect.created");
      const before = await snapshot(cdb);
      const statements: string[] = [];
      const watched = cdb.client(RUNTIME_ROLE, "rosie-t306-last-row", 1, (text) => {
        statements.push(text);
      });
      const exchanges: Exchange[] = [];
      let answer: unknown;
      try {
        const api = toolApi(
          depsFor(portAt(BOOKS, exchanges, watched), { [ALEX_BOOKS.id]: alexBooksRiley() }),
        );
        answer = await gateAndCommitCall(api, turnRequest(ALEX_TEXT, ALEX_BOOKS));
      } finally {
        await watched.end({ timeout: 5 });
      }

      expect(answer).toEqual({ error: "constraint", sqlstate: "23505", constraint: "event_log_pkey" });
      expect(exchanges.map((each) => each.request.writes.events.at(-1)?.id)).toEqual([last]);
      // Every other row of the turn was written in the commit's transaction before its last row was refused, and the
      // transaction then rolled back (the statements as sent, their text only).
      expect(writesIn(statements)).toEqual([
        "turns",
        "bookings",
        "outbox_rows",
        "outbox_rows",
        "reservations",
        "clock_rows",
        "effects",
        "event_log",
        "event_log",
        "event_log",
        "event_log",
        "event_log",
      ]);
      expect(statements.at(-1)?.trim()).toBe("rollback");
      // No row of the turn is left, and every other row is as it was.
      expect(await snapshot(cdb)).toEqual(before);
      expect(await footprint(cdb, ALEX_BOOKS.id)).toEqual(NO_FOOTPRINT);
      expect(await rowOf(cdb, "bookings", "booking-alex-riley-nov14", [])).toBeUndefined();
      expect(await rowOf(cdb, "reservations", "rsv-alex-riley-nov14", ["state"])).toEqual({
        version: 1,
        state: "held",
      });
      expect(await rowOf(cdb, "clock_rows", "rsv-alex-riley-nov14/saved-time", ["state"])).toEqual({
        version: 1,
        state: "armed",
      });
    },
  );
});

describe("exactly once: the commit is unique on the turn id (K-05 v1 item 1; arch 10 line 508)", () => {
  it(
    "100 parallel commits of one turn id: one set of rows, and the other 99 answer the first commit (repeated)",
    SLOW,
    async () => {
      await seed(cdb, SEEDS);
      await holdTime(cdb);
      const exchange = k05Exchange(BOOKS);
      const exchanges: Exchange[] = [];
      const inFlight: InFlight = { now: 0, peak: 0 };
      const api = toolApi(
        depsFor(counted(portAt(BOOKS, exchanges), inFlight), { [ALEX_BOOKS.id]: alexBooksRiley() }),
      );

      const answers = (
        await Promise.all(
          Array.from({ length: 100 }, () => gateAndCommitCall(api, turnRequest(ALEX_TEXT, ALEX_BOOKS))),
        )
      ).map(committed);

      // The commits ran side by side, not one after another.
      expect(inFlight.peak).toBeGreaterThan(1);
      const firsts = answers.filter((each) => !each.repeated);
      const repeats = answers.filter((each) => each.repeated);
      expect(firsts).toHaveLength(1);
      expect(repeats).toHaveLength(99);
      const [first] = firsts;
      if (first === undefined) return fail("no first commit");
      // K-05: one commit, the fixture's own outcome; 99 repeats of it that wrote nothing.
      expect(exchanges).toHaveLength(100);
      const k05Answers = exchanges.map((each) => k05Committed(each.answer));
      expect(k05Answers.filter((each) => !each.repeated)).toEqual([exchange.outcome]);
      for (const each of exchanges) {
        expect(contractChecks().k05("commitTurn.request", each.request)).toEqual([]);
        expect(contractChecks().k05("commitTurn.response", each.answer)).toEqual([]);
      }
      for (const each of k05Answers.filter((answer) => answer.repeated)) {
        expect(each).toEqual({
          result: "committed",
          turnId: first.turnId,
          committedAt: first.committedAt,
          repeated: true,
          committed: { written: [], outboxRows: first.written.outboxRows, promoted: [] },
        });
      }
      // K-09: each repeat names the first commit, with nothing written, no effect and no question.
      for (const each of repeats) {
        expect(each).toMatchObject({
          turnId: first.turnId,
          committedAt: first.committedAt,
          repeated: true,
          written: { written: [], outboxRows: first.written.outboxRows, promoted: [] },
          effects: [],
          openQuestions: { opened: [], closed: [] },
        });
      }

      // One set of rows.
      expect(await footprint(cdb, ALEX_BOOKS.id)).toEqual({
        ...NO_FOOTPRINT,
        turns: 1,
        outbox: 2,
        events: 5,
        effects: 1,
      });
      expect(await rowOf(cdb, "bookings", "booking-alex-riley-nov14", ["stage"])).toEqual({
        version: 1,
        stage: "booked",
      });
      expect(await rowOf(cdb, "reservations", "rsv-alex-riley-nov14", ["state"])).toEqual({
        version: 2,
        state: "booked",
      });
      expect(await rowOf(cdb, "clock_rows", "rsv-alex-riley-nov14/saved-time", ["state"])).toEqual({
        version: 2,
        state: "cancelled",
      });
    },
  );
});

describe("two turns on one booking version: limit 4 under real compare-and-set (arch 06 line 305; arch 10 line 506)", () => {
  it(
    "Alex's cancel and Sam's 'done', both on version 7 and inside their commits at once: exactly one commits; the other is refused, reloads once, fails closed and writes nothing",
    SLOW,
    async () => {
      await seed(cdb, SEEDS);
      expect(await rowOf(cdb, "bookings", HAIRCUT, ["stage"])).toEqual({ version: 7, stage: "booked" });
      const exchanges: Exchange[] = [];
      const api = toolApi(
        depsFor(portAt(CANCELS, exchanges), {
          [ALEX_CANCELS.id]: alexCancels(),
          [SAM.id]: samMarksDone(),
        }),
      );

      // A third connection holds the booking row, so both commits reach it and wait on it inside their transactions at
      // once (two backends waiting on a lock); then it lets go, changing nothing.
      const { both } = await cdb.db.sql.begin(async (tx) => {
        await tx`select version from bookings where id = ${HAIRCUT} for update`;
        const calls = Promise.allSettled([
          gateAndCommitCall(api, turnRequest(ALEX_TEXT, ALEX_CANCELS)),
          gateAndCommitCall(api, turnRequest(SAM_TEXT, SAM)),
        ]);
        await lockWaiters(cdb, cdb.runtimeApplication, 2);
        return { both: calls };
      });
      const settled = await both;

      const won = settled.flatMap((each) => (each.status === "fulfilled" ? [committed(each.value)] : []));
      const lost = settled.flatMap((each) => (each.status === "rejected" ? [each.reason as unknown] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const [winner] = won;
      if (winner === undefined) return fail("no turn committed");
      const alexWon = winner.turnId === ALEX_CANCELS.id;
      const loser = alexWon ? SAM.id : ALEX_CANCELS.id;
      expect(winner).toMatchObject({ repeated: false, parts: [{ part: 0, result: "committed" }] });
      expect(lost[0]).toBeInstanceOf(CommitRefusedError);
      expect(lost[0]).toMatchObject({ fault: "stillChanged", ids: [HAIRCUT] });

      // K-05: the winner committed once, raising the haircut to 8; the other was refused twice (the commit's one
      // reload), each time with the row that changed under it, and wrote nothing.
      const winnerAnswers = exchanges
        .filter((each) => each.turnId === winner.turnId)
        .map((each) => k05Committed(each.answer));
      expect(winnerAnswers.map((each) => [each.repeated, each.committed.written])).toEqual([
        [false, [{ table: "bookings", rowId: HAIRCUT, version: 8 }]],
      ]);
      expect(exchanges.filter((each) => each.turnId === loser).map((each) => each.answer)).toEqual([
        HAIRCUT_CHANGED,
        HAIRCUT_CHANGED,
      ]);
      for (const each of exchanges) {
        expect(contractChecks().k05("commitTurn.request", each.request)).toEqual([]);
        const definition = "error" in each.answer ? "commitTurn.errors" : "commitTurn.response";
        expect(contractChecks().k05(definition, each.answer)).toEqual([]);
      }

      // The haircut moved once, to the winner's stage; the winner's turn, reply and entries are there, the other's not.
      expect(await rowOf(cdb, "bookings", HAIRCUT, ["stage"])).toEqual({
        version: 8,
        stage: alexWon ? "cancelled" : "done",
      });
      expect(await footprint(cdb, winner.turnId)).toEqual({
        ...NO_FOOTPRINT,
        turns: 1,
        outbox: 1,
        events: 2,
      });
      expect(await footprint(cdb, loser)).toEqual(NO_FOOTPRINT);
    },
  );

  it(
    "a turn that read the haircut at 7, committing after another chat's commit moved it to 8, is refused by the compare-and-set on what it read alone",
    SLOW,
    async () => {
      await seed(cdb, SEEDS);
      const exchanges: Exchange[] = [];
      const api = toolApi(
        depsFor(portAt(CANCELS, exchanges), { [ALEX_CANCELS.id]: alexCancels(), [SAM.id]: samReplies() }),
      );
      committed(await gateAndCommitCall(api, turnRequest(ALEX_TEXT, ALEX_CANCELS)));
      expect(await rowOf(cdb, "bookings", HAIRCUT, ["stage"])).toEqual({ version: 8, stage: "cancelled" });
      const before = await snapshot(cdb);

      await expect(gateAndCommitCall(api, turnRequest(SAM_TEXT, SAM))).rejects.toMatchObject({
        name: "CommitRefusedError",
        fault: "stillChanged",
        ids: [HAIRCUT],
      });

      // Sam's request wrote no booking row: only the row it read named the haircut, at 7. K-05 refused it on that read,
      // twice (the one reload), and nothing of Sam's turn was written.
      const sams = exchanges.filter((each) => each.turnId === SAM.id);
      expect(sams.map((each) => [each.request.writes.state, each.request.versionsRead])).toEqual([
        [[], [haircutAt(7)]],
        [[], [haircutAt(7)]],
      ]);
      expect(sams.map((each) => each.answer)).toEqual([HAIRCUT_CHANGED, HAIRCUT_CHANGED]);
      expect(await snapshot(cdb)).toEqual(before);
      expect(await footprint(cdb, SAM.id)).toEqual(NO_FOOTPRINT);

      // The same reply decided on today's version commits: what refused it was the version it read.
      const today = toolApi(
        depsFor(portAt(CANCELS, exchanges), { [SAM.id]: { ...samReplies(), versionsRead: [haircutAt(8)] } }),
      );
      committed(await gateAndCommitCall(today, turnRequest(SAM_TEXT, SAM)));
      expect(await footprint(cdb, SAM.id)).toEqual({ ...NO_FOOTPRINT, turns: 1, outbox: 1, events: 1 });
      expect(await rowOf(cdb, "bookings", HAIRCUT, ["stage"])).toEqual({ version: 8, stage: "cancelled" });
    },
  );
});

describe("the Worker's wiring (pgCommitDeps): the K-05 port on PostgreSQL, the other ports not built yet", () => {
  it("a turn answers notBuilt and nothing is written (fail closed)", SLOW, async () => {
    await seed(cdb, SEEDS);
    const before = await snapshot(cdb);
    const answer = await gateAndCommitCall(
      toolApi(pgCommitDeps<Tx>(cdb.runtime)),
      turnRequest(ALEX_TEXT, ALEX_CANCELS),
    );
    expect(answer).toEqual({ error: "notBuilt", call: "gateAndCommit" });
    expect(await snapshot(cdb)).toEqual(before);
    expect(await footprint(cdb, ALEX_CANCELS.id)).toEqual(NO_FOOTPRINT);
  });
});
