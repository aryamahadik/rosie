// The seed of staging's send's test file (T-1401; ./send.worker.test.ts; key SEND in infra/test-rig/files.mjs): the rows
// its calls claim, read, mark and arm. The rig's globalSetup (infra/test-rig/rig.mjs) runs it once, in Node, on this
// file's database, after the migrations and bundle v0, with a client of the connecting login.
//
// One database holds one world, the walking skeleton's (D-017's own, the one staging holds), as it stands once turn 1 has
// committed and its reply is planned, with the rows three more fixtures' notes list:
//
//   test owner 1   T-1148's rows (db/seeds/skeleton.ts): Lee's Barbershop's head, Sam, his handle at tp-01's fictional
//                  number, their link, the barbershop's company and its one kind of work.
//   the chat       tp-01's phone row as K-05's open-chat-first-text-sam.json writes it, through db/repo's openChatOnText
//                  at the fixture's time: inserted, not stopped, its chat open by iMessage since the text's receipt.
//   the JOIN       K-05's commit-s1-01-sam.json through db/repo's commitTurn, its turn pinned to bundle v0 as the rig
//                  publishes it (the one bundle this database holds; nothing else changed): S1-02's question to Sam, its
//                  question clock row waiting for the first delivery receipt, and outbox-s1-02-sam-1, the row that asks
//                  it. Then that row's plan and final parts as K-09's finalize-pass.json gives them (its request's plan,
//                  its outcome's final parts), through db/repo's writePlan: the row checked at version 2, one part.
//   the thread     S1-01's thread as K-05's read-chat-handle-sam.json's note lists it (K-09 v1.5's turn 1 commit writes
//                  it; K-05's commit-s1-01-sam leaves it out): handle-sam's chat, with the Linq chat id the send goes to.
//   A7-03          Alex's question about his haircut, for read-question-facts-a7-03.json (a question with a visit): the
//                  rows of K-04's seeds that K-05's commit-opens-question.json and the read need, each as its fixture
//                  holds it and no other row of those seeds (so Sam keeps no role here, as T-1148 leaves him): Alex,
//                  Riley, Alex's handle and their link, their roles at the barbershop, Alex's phone row, Riley's
//                  resource, the haircut's booking and its one booked reservation; then commit-opens-question.json
//                  through commitTurn, pinned to bundle v0 the same way.
//   the danger     the two rows K-05's claim-safety-past-routine-live-claim.json's note lists, "as commit-alex-safety's
//   line           and write-plan-alex-safety's requests write Alex's, with Sam's ids": turn-sam-safety-0062 and its one
//                  row out-sam-safety-0062, send class safety, checked at version 2 with the fixed line safetyEmergency
//                  as its plan and final parts, through commitTurn and writePlan, after the JOIN's row in commit order.
//
// The picked rows and the thread are written in one transaction as the runtime side's role, rosie_job, with no business
// scope, as the skeleton seed writes its own; each db/repo call runs as the connecting login, one transaction of its own.
// Test values only (rule 9): the master's sample cast, the fixtures' ids and the fiction range's numbers, none of them
// written here but the thread's row, which is its note's.
//
// What the test file imports from here is constants, which load inside the Workers runtime; T-1148's seed is loaded at
// `seed`, in Node, since db/seeds reads the fixture set from disk as it loads.
import commitAlexSafety from "../../../../contracts/data-access/fixtures/commit-alex-safety.json";
import commitOpensQuestion from "../../../../contracts/data-access/fixtures/commit-opens-question.json";
import commitS101Sam from "../../../../contracts/data-access/fixtures/commit-s1-01-sam.json";
import openChatFirstTextSam from "../../../../contracts/data-access/fixtures/open-chat-first-text-sam.json";
import writePlanAlexSafety from "../../../../contracts/data-access/fixtures/write-plan-alex-safety.json";
import seedBookingHead from "../../../../contracts/db-schema/core/fixtures/seed-booking-head.json";
import seedPersonRoles from "../../../../contracts/db-schema/core/fixtures/seed-person-roles.json";
import seedPhoneChatOpen from "../../../../contracts/db-schema/core/fixtures/seed-phone-chat-open.json";
import seedReservation from "../../../../contracts/db-schema/core/fixtures/seed-reservation.json";
import seedResources from "../../../../contracts/db-schema/core/fixtures/seed-resources.json";
import finalizePass from "../../../../contracts/tool-api/fixtures/finalize-pass.json";
import { openChatOnText, type OpenChatOnTextRequest } from "../../../../db/repo/chat-open";
import { commitTurn, type CommitTurnRequest } from "../../../../db/repo/commit-turn";
import { writePlan, type WritePlanRequest } from "../../../../db/repo/outbox";
import { SCOPE_SETTING, type Sql, type Tx } from "../../../../db/repo/scope";

type Values = Readonly<Record<string, unknown>>;

interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

/** A value that must be there: a fixture or a row this seed is written against. */
function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the send seed: ${what} is missing`);
  return value;
}

/** One row of a K-04 seed, by its table and the value of one of its columns. */
function pick(
  fixture: { readonly rows: readonly unknown[] },
  table: string,
  column: string,
  value: string,
): SeedRow {
  return need(
    (fixture.rows as readonly SeedRow[]).find((row) => row.table === table && row.values[column] === value),
    `K-04's ${table} row ${value}`,
  );
}

// ---- the JOIN's turn (K-05 commit-s1-01-sam.json) ------------------------------------------------------------------------

const JOIN_REQUEST = commitS101Sam.request;
const JOIN_QUESTION = need(JOIN_REQUEST.writes.openQuestions.open[0], "the JOIN's question");
const JOIN_CLOCK = need(JOIN_REQUEST.writes.clockRows.make[0], "the JOIN's clock row");
const JOIN_ROW = need(JOIN_REQUEST.writes.outboxRows[0], "the JOIN's outbox row");

/** Turn 1 as K-05's commit-s1-01-sam.json commits it: its ids, its recipient and when it committed. */
export const JOIN = Object.freeze({
  turnId: JOIN_REQUEST.turn.id,
  traceId: JOIN_REQUEST.turn.traceId,
  handleId: JOIN_ROW.recipientHandleId,
  personId: JOIN_ROW.recipientPersonId,
  businessId: JOIN_ROW.businessId,
  /** S1-02's question, its question clock row, and the row that asks it. */
  question: JOIN_QUESTION.id,
  clock: JOIN_CLOCK.id,
  row: JOIN_ROW.id,
  /** The row's one part, as K-07 keys it: <row>/<part>/<try>. */
  partKey: `${JOIN_ROW.id}/1/1`,
  /** The commit's moment (K-05 given.now): 2:05pm in New York, inside the barbershop's text hours. */
  committedAt: commitS101Sam.given.now,
});

/** The words of the JOIN's reply, as K-09's finalize-pass.json's final parts hold them: never in a span or a log line. */
export const JOIN_REPLY_TEXT = need(finalizePass.outcome.finalParts.sends[0], "the reply's one send").text;

// ---- the chat (K-05 open-chat-first-text-sam.json; read-chat-handle-sam.json's note) -----------------------------------

/** S1-01's thread, column by column as read-chat-handle-sam.json's note lists it. */
export const SAM_THREAD = Object.freeze({
  id: "thread-s1-01-sam-1",
  handle_id: "handle-sam",
  kind: "chat",
  booking_id: null,
  linq_chat_id: "linq-chat-demo-sam",
  reply_address: null,
  version: 1,
});

// ---- A7-03 (K-05 commit-opens-question.json; read-question-facts-a7-03.json) ------------------------------------------

const A7_QUESTION = need(commitOpensQuestion.request.writes.openQuestions.open[0], "A7-03's question");

/** A7-03's question to Alex, about his haircut: the question read-question-facts-a7-03.json reads. */
export const A7_03 = Object.freeze({
  question: A7_QUESTION.id,
  handleId: A7_QUESTION.handleId,
  bookingId: A7_QUESTION.bookingId,
  committedAt: commitOpensQuestion.given.now,
});

/**
 * The rows of K-04's seeds that A7-03's commit and its facts' read need, in the order their foreign keys need, each as
 * its fixture holds it: no other row of those seeds is written.
 */
const A7_ROWS: readonly SeedRow[] = [
  pick(seedPersonRoles, "persons", "id", "person-alex"),
  pick(seedPersonRoles, "persons", "id", "person-riley"),
  pick(seedPersonRoles, "handles", "id", A7_03.handleId),
  pick(seedPersonRoles, "person_handles", "handle_id", A7_03.handleId),
  pick(seedPersonRoles, "person_roles", "id", "role-alex-barber"),
  pick(seedPersonRoles, "person_roles", "id", "role-riley-barber"),
  pick(seedPhoneChatOpen, "phones", "handle_id", A7_03.handleId),
  pick(seedResources, "resources", "id", "res-riley"),
  pick(seedBookingHead, "bookings", "id", A7_03.bookingId),
  pick(seedReservation, "reservations", "id", "rsv-alex-haircut"),
];

// ---- the danger line (K-05 claim-safety-past-routine-live-claim.json's note) -------------------------------------------

const FIRST_LINE = commitAlexSafety.request;
const FIRST_LINE_ROW = need(FIRST_LINE.writes.outboxRows[0], "the first danger line's row");

/** Sam's danger line, with the ids and the time claim-safety-past-routine-live-claim.json's note gives it. */
export const DANGER_LINE = Object.freeze({
  turnId: "turn-sam-safety-0062",
  eventId: "evt-sam-0062",
  traceId: "trace-sam-0062",
  row: "out-sam-safety-0062",
  partKey: "out-sam-safety-0062/1/1",
  committedAt: "2026-11-07T15:06:36Z",
});

/** The words of the danger line (K-01's fixed line safetyEmergency, as the plan's request holds them). */
export const DANGER_LINE_TEXT = need(
  writePlanAlexSafety.request.finalParts.sends[0],
  "the line's one send",
).text;

/** Alex's first danger line's ids, each swapped for Sam's line's wherever a request names it as a whole string. */
function withSamsIds<T>(request: T): T {
  const pairs: readonly (readonly [string, string])[] = [
    [FIRST_LINE.turn.id, DANGER_LINE.turnId],
    [FIRST_LINE.turn.handleId, JOIN.handleId],
    [FIRST_LINE_ROW.recipientPersonId, JOIN.personId],
    [need(FIRST_LINE.turn.eventIds[0], "the first danger line's text"), DANGER_LINE.eventId],
    [FIRST_LINE.turn.traceId, DANGER_LINE.traceId],
    [FIRST_LINE_ROW.id, DANGER_LINE.row],
  ];
  let text = JSON.stringify(request);
  for (const [from, to] of pairs) text = text.replaceAll(JSON.stringify(from), JSON.stringify(to));
  return JSON.parse(text) as T;
}

// ---- the seed ---------------------------------------------------------------------------------------------------------

/** A bundle id as K-05 names it. */
interface BundleId {
  readonly hash: string;
  readonly build: number;
}

/** A commit's request pinned to `bundleId`, nothing else changed. */
function pinnedTo(request: { readonly turn: object }, bundleId: BundleId): CommitTurnRequest {
  const pinned = structuredClone(request) as { turn: { bundleId: BundleId } };
  pinned.turn.bundleId = { hash: bundleId.hash, build: bundleId.build };
  return pinned as unknown as CommitTurnRequest;
}

/** One commit through db/repo's commitTurn at its fixture's time; anything but a first commit is a broken seed. */
async function commit(sql: Sql, what: string, request: CommitTurnRequest, at: string): Promise<void> {
  const committed = await commitTurn(sql, request, { now: new Date(at) });
  if (!("result" in committed) || committed.repeated) {
    throw new Error(`the send seed: the commit of ${what} was not taken`);
  }
}

/** One plan through db/repo's writePlan; anything but written is a broken seed. */
async function plan(sql: Sql, what: string, request: WritePlanRequest): Promise<void> {
  const written = await writePlan(sql, request);
  if (!("result" in written)) throw new Error(`the send seed: the plan of ${what} was not written`);
}

/** One row as its fixture gives it. */
async function insertRow(tx: Tx, row: SeedRow): Promise<void> {
  await tx`insert into ${tx(row.table)} ${tx(row.values as Record<string, never>)}`;
}

/** Seeds this file's database (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  // T-1148's rows, loaded here, in Node: db/seeds opens the fixture set from disk as it loads.
  const { seedSkeleton } = await import("../../../../db/seeds/skeleton");
  await seedSkeleton(sql);

  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    for (const row of A7_ROWS) await insertRow(tx, row);
  });

  // tp-01's chat, opened by Sam's first text at the gateway's receipt (K-05 v1.7 item 46).
  const opened = await openChatOnText(sql, openChatFirstTextSam.request as OpenChatOnTextRequest, {
    now: new Date(openChatFirstTextSam.given.now),
  });
  if (!("result" in opened) || opened.result !== "inserted") {
    throw new Error("the send seed: tp-01's phone row was not inserted");
  }

  // Bundle v0 as the rig published it: the one bundle here, active, which every turn of this seed is pinned to.
  const bundles = await sql<{ hash: string; build: number }[]>`select hash, build from bundles where active`;
  const [bundleId] = bundles;
  if (bundleId === undefined || bundles.length !== 1) {
    throw new Error("the send seed: this database holds no one active bundle");
  }

  // Turn 1, then its reply's plan and final parts as finalize wrote them.
  await commit(sql, "the JOIN's turn", pinnedTo(JOIN_REQUEST, bundleId), JOIN.committedAt);
  await plan(sql, "the JOIN's reply", {
    outboxRowId: finalizePass.request.outboxRowId,
    expectVersion: finalizePass.request.expectVersion,
    plan: finalizePass.request.plan,
    finalParts: finalizePass.outcome.finalParts,
  } as unknown as WritePlanRequest);

  // S1-01's thread, which K-09 v1.5's turn 1 commit writes and K-05's commit-s1-01-sam leaves out.
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role rosie_job");
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    await insertRow(tx, { table: "threads", values: SAM_THREAD });
  });

  // A7-03's question to Alex, with its 24-hour Clock line and its booked visit.
  await commit(sql, "A7-03's turn", pinnedTo(commitOpensQuestion.request, bundleId), A7_03.committedAt);

  // Sam's danger line: its turn and its one row, checked, after the JOIN's row in commit order.
  await commit(
    sql,
    "the danger line's turn",
    pinnedTo(withSamsIds(FIRST_LINE), bundleId),
    DANGER_LINE.committedAt,
  );
  await plan(sql, "the danger line", withSamsIds(writePlanAlexSafety.request) as unknown as WritePlanRequest);
}
