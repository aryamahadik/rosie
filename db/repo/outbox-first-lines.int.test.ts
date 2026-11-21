// T-1513: K-05 v1.21 defaults 200 to 204, the two writers that switch Rosie's first-text lines off, against local
// PostgreSQL (`npm run db:up`; `npm run test:integration -- db/repo/outbox`): writePlan writes K-04's opener mark for a
// row with a business and a turn whose final parts carry an opener (`opener` or `signUpOpener`), once, its sent_at the
// turn's committed_at (defaults 200, 201 and 204); readFixedLineFacts reads past a mark whose row never went, and its
// no-business branch counts no such row (default 202); markPart sets the phone's optout_line_delivered_at on the first
// delivered words part of a row whose final parts carry `optOutLine`, the phone's version raised once (default 203).
// DL-1032, DL-1033 ruling 4 and 5, DL-1045; ops/reviews/live-reply-faults/check-repeat.json card B.
//
// Every call runs as K-05 states it: through a client whose connections run as rosie_job with no business scope (the
// fixed-line read sets its own scope). The tables' owner loads K-04's seeds and the rows a test adds for itself: an
// outbox row as a commit writes it (planned, no plan), a row already sent with its parts sent, a parked turn, and the
// state a row ended in (withdrawn, failed, dropped_stopped, superseded), which only the dispatcher and the commit write.
//
// The world: K-04's seed-bundle-registry, seed-booking-head and seed-phone-chat-open, then commit-opens-question.json
// committed for real (turn-alex-move-1, committed at 14:05:02Z, and A7-03's row to Alex with its question and clock row),
// with Alex's phone's optout_line_delivered_at cleared (version 4), as for a number Rosie never delivered the line to.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { armClock } from "./clocks";
import { commitTurn, type CommitTurnOutcome, type CommitTurnRequest } from "./commit-turn";
import {
  claimOutboxV12,
  markPart,
  type MarkPartOutcome,
  markPartV12,
  type MarkPartV12Outcome,
  type MarkPartV12Request,
  writePlan,
  type WritePlanOutcome,
  type WritePlanRequest,
} from "./outbox";
import type { Sql, Tx } from "./scope";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { readFixedLineFacts, type ReadFixedLineFactsOutcome } from "./turn-face-reads";

type Db = Sql | Tx;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CONTRACTS = new URL("../../contracts/", import.meta.url);
const ACCESS_DIR = new URL("data-access/fixtures/", CONTRACTS);
const CORE_DIR = new URL("db-schema/core/fixtures/", CONTRACTS);
const RUNTIME_ROLE = "rosie_job";
const SLOW = { timeout: 60_000 };
const PARALLEL = { timeout: 240_000 };
/** K-01's bundle-v0-skeleton id, the bundle K-04's seed-bundle-registry registers. */
const BUNDLE_HASH = "93c00d14a6100d34e6b78556ba6561d8c327ca269cc48885662a302f20c76037";
const BARBERSHOP = "biz-lees-barbershop";
const ALEX = "handle-alex";
const ALEX_EMAIL = "handle-alex-email";
const ALEX_NUMBER = "+15555550101";
/** commit-opens-question.json's turn, and its commit time: every row a test adds is under it unless it says. */
const TURN = "turn-alex-move-1";
const COMMITTED_AT = "2026-10-23T14:05:02Z";
/** commit-opens-question.json's row, which asks A7-03's question. */
const A7_03_ROW = "out-a7-03-alex";
const A7_03_QUESTION = "oq-a7-03-alex";
/** K-07's ends of a row that did not go, or never will (K-05 v1.21 default 202). */
const NEVER_WENT = ["withdrawn", "failed", "dropped_stopped", "superseded"] as const;
/** The three lines of Rosie's first text to a number about a business (arch 07 line 361; Q-30). */
const FIRST_TEXT_LINES = ["opener", "optOutLine", "privacyLink"];

interface Exchange {
  call: string;
  given: { k04Seeds: string[]; after: string[]; now: string };
  request: Record<string, Json>;
  outcome: Record<string, Json>;
}

interface SeedFile {
  after: string[];
  rows: { table: string; values: Record<string, Json> }[];
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const exchangeOf = (file: string): Exchange => readJson(new URL(file, ACCESS_DIR)) as Exchange;
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

// ---- the database and its clients -----------------------------------------------------------------------------------

let db: TestDatabase;
/** Connections that run as rosie_job, the runtime side, with this file's schema first. */
let runtime: Sql;
let typedColumns: Map<string, string>;

beforeAll(async () => {
  db = await createTestDatabase({ name: "outbox_first_lines" });
  runtime = db.connect({
    max: 20,
    onnotice: () => undefined,
    connection: {
      application_name: "rosie-t1513-first-lines",
      search_path: `${db.schema}, public`,
      role: RUNTIME_ROLE,
    },
  });
  const typed = await db.sql<{ key: string; type: string }[]>`
    select table_name || '.' || column_name as key, data_type as type from information_schema.columns
    where table_schema = ${db.schema} and data_type in ('jsonb', 'bytea')
  `;
  typedColumns = new Map(typed.map((column) => [column.key, column.type]));
}, 60_000);

afterAll(async () => {
  await runtime.end({ timeout: 5 });
  await db.drop();
});

async function insertRow(sql: Db, table: string, row: Record<string, Json>): Promise<void> {
  const values: Record<string, never> = {};
  for (const [column, value] of Object.entries(row)) {
    const type = typedColumns.get(`${table}.${column}`);
    let converted: unknown = value;
    if (type === "jsonb" && value !== null) {
      converted = sql.json(value);
    } else if (type === "bytea" && typeof value === "string") {
      converted = fromHex(value.replace(/^\\x/, ""));
    }
    values[column] = converted as never;
  }
  await sql`insert into ${sql(table)} ${sql(values)}`;
}

function seedRows(file: string, seen: Set<string>): SeedFile["rows"] {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const seed = readJson(new URL(file, CORE_DIR)) as SeedFile;
  return [...seed.after.flatMap((before) => seedRows(before, seen)), ...seed.rows];
}

/**
 * The world every test starts from (the top of this file): every table emptied, K-04's seeds loaded, the question's
 * commit made for real, and Alex's phone with no opt-out line delivered (version 4).
 */
async function world(): Promise<void> {
  await db.sql`truncate businesses, persons, handles, bundles, release_flags restart identity cascade`;
  const seen = new Set<string>();
  const rows = ["seed-bundle-registry.json", "seed-booking-head.json", "seed-phone-chat-open.json"].flatMap(
    (seed) => seedRows(seed, seen),
  );
  await db.sql.begin(async (tx) => {
    for (const row of rows) {
      await insertRow(tx, row.table, row.values);
    }
  });
  const commit = exchangeOf("commit-opens-question.json");
  expect(
    await commitTurn(runtime, structuredClone(commit.request) as unknown as CommitTurnRequest, {
      now: new Date(commit.given.now),
    }),
  ).toEqual(commit.outcome);
  await db.sql`
    update phones set optout_line_delivered_at = null, version = version + 1 where handle_id = ${ALEX}
  `;
  expect(await phoneNow()).toMatchObject({ optout_line_delivered_at: null, version: 4, stopped: false });
}

// ---- rows a test adds -----------------------------------------------------------------------------------------------

const WORDS: Json = {
  kind: "words",
  text: "Your visit is confirmed.",
  calendarFile: "none",
  options: [],
  link: null,
};
const POLL: Json = {
  kind: "poll",
  text: null,
  calendarFile: "none",
  options: [
    { id: "opt-1", label: "Sat 12:00pm" },
    { id: "opt-2", label: "Sat 2:00pm" },
  ],
  link: null,
};
const PLAN_BODY: Json = {
  formats: ["text"],
  lines: [{ role: "first", text: "Your visit is confirmed." }],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

interface RowOf {
  readonly handle?: string;
  readonly business?: string | null;
  readonly channel?: string;
  /** The row's turn; null for a row with no turn (K-04 v1.1's job row). */
  readonly turn?: string | null;
}

/** An outbox row as a commit writes it (planned, no plan), as the owner: to Alex at the barbershop, under TURN. */
async function addRow(id: string, row: RowOf = {}): Promise<void> {
  const turn = row.turn === undefined ? TURN : row.turn;
  await insertRow(db.sql, "outbox_rows", {
    id,
    turn_id: turn,
    job_id: turn === null ? `job-${id}` : null,
    recipient_handle_id: row.handle ?? ALEX,
    business_id: row.business === undefined ? BARBERSHOP : row.business,
    channel: row.channel ?? "imessage",
    send_class: "routine",
    versions_read: [],
    bundle_hash: BUNDLE_HASH,
    bundle_build: 1,
    trace_id: "trace-alex-0007",
  });
}

/** The final parts of row `id` with these fixed line ids and sends (K-03 v1 finalParts). */
function partsOf(
  id: string,
  fixedLines: readonly string[],
  sends: Json[] = [WORDS],
  channel = "imessage",
): Json {
  return { row: id, channel, sends, fixedLines: [...fixedLines], slotValues: [], threadReplyTo: null };
}

/** A writePlan request for row `id` at `expectVersion`, its final parts carrying `fixedLines`. */
function planRequest(
  id: string,
  fixedLines: readonly string[],
  options: { expectVersion?: number; sends?: Json[]; channel?: string } = {},
): WritePlanRequest {
  const channel = options.channel ?? "imessage";
  const request: Json = {
    outboxRowId: id,
    expectVersion: options.expectVersion ?? 1,
    plan: { row: id, channel, copyOf: null, plan: PLAN_BODY },
    finalParts: partsOf(id, fixedLines, options.sends, channel),
  };
  return request as unknown as WritePlanRequest;
}

async function plan(request: WritePlanRequest): Promise<WritePlanOutcome> {
  return writePlan(runtime, request);
}

const written = (id: string, version = 2): WritePlanOutcome => ({
  result: "written",
  outboxRowId: id,
  version,
});

/** A row added and planned at once, its final parts carrying `fixedLines`. */
async function plannedRow(id: string, fixedLines: readonly string[], row: RowOf = {}): Promise<void> {
  await addRow(id, row);
  expect(await plan(planRequest(id, fixedLines, { channel: row.channel ?? "imessage" }))).toEqual(
    written(id),
  );
}

/** The row's end, as the dispatcher (failed, withdrawn, dropped_stopped) or a commit (superseded) writes it. */
async function rowEnded(id: string, state: string): Promise<void> {
  await db.sql`update outbox_rows set state = ${state}, version = version + 1 where id = ${id}`;
}

/**
 * A row already sent, as the owner writes it: state sent, these sends and fixed lines, each part's try 1 sent under the
 * message id `<row>-m<part>`. With `retried`, that part's try 1 was refused (failed, 4001) and its try 2, a plain words
 * retry (K-07; outbox.ts default 8), was sent under the message id `<row>-m<part>`.
 */
async function sentRow(
  id: string,
  fixedLines: readonly string[],
  options: RowOf & { sends?: Json[]; retried?: number } = {},
): Promise<void> {
  const channel = options.channel ?? "imessage";
  const sends = options.sends ?? [WORDS];
  await insertRow(db.sql, "outbox_rows", {
    id,
    turn_id: TURN,
    recipient_handle_id: options.handle ?? ALEX,
    business_id: options.business === undefined ? BARBERSHOP : options.business,
    channel,
    send_class: "routine",
    versions_read: [],
    plan: { row: id, channel, copyOf: null, plan: PLAN_BODY },
    final_parts: partsOf(id, fixedLines, sends, channel),
    state: "sent",
    bundle_hash: BUNDLE_HASH,
    bundle_build: 1,
    trace_id: "trace-alex-0007",
    version: 4,
  });
  for (const [index, send] of sends.entries()) {
    const partNo = index + 1;
    const kind = (send as { kind: string }).kind;
    const retried = options.retried === partNo;
    await insertRow(db.sql, "outbox_parts", {
      outbox_row_id: id,
      part_no: partNo,
      try_no: 1,
      idempotency_key: `${id}/${String(partNo)}/1`,
      attempts: 1,
      kind,
      linq_message_id: retried ? `${id}-m${String(partNo)}-refused` : `${id}-m${String(partNo)}`,
      state: retried ? "failed" : "sent",
      sent_at: "2026-10-23T14:05:03Z",
      failed_at: retried ? "2026-10-23T14:05:03Z" : null,
      error_code: retried ? "4001" : null,
    });
    if (retried) {
      await insertRow(db.sql, "outbox_parts", {
        outbox_row_id: id,
        part_no: partNo,
        try_no: 2,
        idempotency_key: `${id}/${String(partNo)}/2`,
        attempts: 1,
        kind: "words",
        linq_message_id: `${id}-m${String(partNo)}`,
        state: "sent",
        sent_at: "2026-10-23T14:05:04Z",
      });
    }
  }
}

/** A delivery receipt for the part Linq knows as `providerMessageId`, at `at`. */
const receipt = (providerMessageId: string, at: string): MarkPartV12Request => ({
  outcome: "delivered",
  providerMessageId,
  at,
});

async function delivered(providerMessageId: string, at: string): Promise<MarkPartV12Outcome> {
  return markPartV12(runtime, receipt(providerMessageId, at));
}

// ---- what the database holds ----------------------------------------------------------------------------------------

/** Every opener mark, as stored. */
async function marksNow(): Promise<Record<string, unknown>[]> {
  return [
    ...(await db.sql<Record<string, unknown>[]>`
      select handle_id, business_id, sent_at, outbox_row_id from openers_sent
      order by handle_id collate "C", business_id collate "C"
    `),
  ];
}

const markOf = (
  outboxRowId: string,
  sentAt = COMMITTED_AT,
  businessId = BARBERSHOP,
): Record<string, unknown> => ({
  handle_id: ALEX,
  business_id: businessId,
  sent_at: new Date(sentAt),
  outbox_row_id: outboxRowId,
});

/** Alex's phone's flags, its opt-out time and its version: never its number. */
async function phoneNow(handleId = ALEX): Promise<Record<string, unknown> | undefined> {
  const [phone] = await db.sql<Record<string, unknown>[]>`
    select stopped, stop_at, chat_open, optout_line_delivered_at, version from phones where handle_id = ${handleId}
  `;
  return phone;
}

/** Every phone row but its number: equal before and after = no phone was written. */
async function phonesNow(): Promise<unknown> {
  return [
    ...(await db.sql`
      select handle_id, stopped, stop_at, chat_open, optout_line_delivered_at, version from phones
      order by handle_id collate "C"
    `),
  ];
}

/** The fixed-line facts of row `id` (K-05 v1.3 item 36): textedAboutBusiness and openerRowId. */
async function factsOf(
  id: string,
  businessId: string | null = BARBERSHOP,
): Promise<[boolean, string | null]> {
  const outcome: ReadFixedLineFactsOutcome = await readFixedLineFacts(runtime, {
    outboxRowId: id,
    businessId,
  });
  if (!("result" in outcome)) {
    throw new Error(`readFixedLineFacts answered ${outcome.error}`);
  }
  return [outcome.textedAboutBusiness, outcome.openerRowId];
}

/** A call retried while it answers transient (a deadlock or a serialization failure): its answer, and its tries. */
async function untilNotTransient<T>(call: () => Promise<T>): Promise<{ answer: T; transients: number }> {
  for (let transients = 0; transients < 20; transients += 1) {
    const answer = await call();
    const isTransient =
      typeof answer === "object" && answer !== null && (answer as { error?: unknown }).error === "transient";
    if (!isTransient) {
      return { answer, transients };
    }
  }
  throw new Error("twenty transient answers in a row");
}

// ---- writePlan: the opener mark (defaults 200, 201 and 204) -----------------------------------------------------------

describe("writePlan writes K-04's opener mark, once (K-05 v1.21 defaults 200, 201 and 204; T-1513)", () => {
  it(
    "the first row planned with the opener writes one mark (this handle, this business, the turn's commit time, this row); its own re-read says false, the next row's true; a later row never moves it",
    SLOW,
    async () => {
      await world();
      await addRow("out-t1513-first");
      await addRow("out-t1513-next");
      expect(await factsOf("out-t1513-first")).toEqual([false, null]);
      expect(await marksNow()).toEqual([]);

      expect(await plan(planRequest("out-t1513-first", FIRST_TEXT_LINES))).toEqual(
        written("out-t1513-first"),
      );
      expect(await marksNow()).toEqual([markOf("out-t1513-first")]);
      // The marked row is the first text: it carries the opener whenever it is finalized again (default 50).
      expect(await factsOf("out-t1513-first")).toEqual([false, "out-t1513-first"]);
      expect(await factsOf("out-t1513-next")).toEqual([true, "out-t1513-first"]);

      // A repeat answers alreadyPlanned and writes nothing; a later row with the opener never moves the mark.
      expect(await plan(planRequest("out-t1513-first", FIRST_TEXT_LINES))).toEqual({
        error: "alreadyPlanned",
        outboxRowId: "out-t1513-first",
        version: 2,
      });
      expect(await plan(planRequest("out-t1513-next", ["opener"]))).toEqual(written("out-t1513-next"));
      expect(await marksNow()).toEqual([markOf("out-t1513-first")]);
      expect(await factsOf("out-t1513-next")).toEqual([true, "out-t1513-first"]);
    },
  );

  it("the sign-up opener writes the mark as the opener does (default 204)", SLOW, async () => {
    await world();
    await addRow("out-t1513-sign-up");
    await addRow("out-t1513-after");
    expect(await plan(planRequest("out-t1513-sign-up", ["signUpOpener", "privacyLink"]))).toEqual(
      written("out-t1513-sign-up"),
    );
    expect(await marksNow()).toEqual([markOf("out-t1513-sign-up")]);
    expect(await factsOf("out-t1513-after")).toEqual([true, "out-t1513-sign-up"]);
  });

  it(
    "no mark for a row with no business, no turn, no opener, or a turn with no commit time; none on alreadyPlanned, versionChanged, notFound or a refusal",
    SLOW,
    async () => {
      await world();
      // No business: the no-business read finds an earlier row by its final parts (item 36).
      await plannedRow("out-t1513-no-business", ["signUpOpener"], { business: null });
      await plannedRow("out-t1513-no-business-2", ["opener"], { business: null });
      // No turn (K-04 v1.1's job row): its commit has no turn time (default 200).
      await plannedRow("out-t1513-job", ["opener"], { turn: null });
      // No opener among the fixed lines.
      await plannedRow("out-t1513-lines", ["optOutLine", "privacyLink"]);
      await plannedRow("out-t1513-none", []);
      // A parked turn's row: no committed_at, so no time and no mark (outbox.ts default 27).
      await insertRow(db.sql, "turns", {
        id: "turn-t1513-parked",
        handle_id: ALEX,
        event_ids: ["evt-t1513-parked"],
        state: "parked",
        bundle_hash: BUNDLE_HASH,
        bundle_build: 1,
        trace_id: "trace-t1513-parked",
        parked_at: "2026-10-23T14:06:00Z",
        version: 2,
      });
      await plannedRow("out-t1513-parked", ["opener"], { turn: "turn-t1513-parked" });
      expect(await marksNow()).toEqual([]);

      // Answers that write nothing, each with the opener in its final parts.
      await addRow("out-t1513-refused");
      expect(await plan(planRequest("out-t1513-lines", ["opener"]))).toEqual({
        error: "alreadyPlanned",
        outboxRowId: "out-t1513-lines",
        version: 2,
      });
      expect(await plan(planRequest("out-t1513-refused", ["opener"], { expectVersion: 3 }))).toEqual({
        error: "versionChanged",
        changed: [{ table: "outbox_rows", rowId: "out-t1513-refused", readVersion: 3, currentVersion: 1 }],
      });
      expect(await plan(planRequest("out-t1513-missing", ["opener"]))).toEqual({
        error: "notFound",
        table: "outbox_rows",
        rowId: "out-t1513-missing",
      });
      // A plan whose channel is not the row's is refused, thrown with nothing written (outbox.ts default 3).
      await expect(plan(planRequest("out-t1513-refused", ["opener"], { channel: "rcs" }))).rejects.toThrow(
        TypeError,
      );
      expect(await marksNow()).toEqual([]);
      // So the business's first row with the opener is still the one marked.
      expect(await factsOf("out-t1513-refused")).toEqual([false, null]);
      expect(await plan(planRequest("out-t1513-refused", ["opener"]))).toEqual(written("out-t1513-refused"));
      expect(await marksNow()).toEqual([markOf("out-t1513-refused")]);
    },
  );

  it("100 writePlans of 100 rows of one handle and business at once give one mark", PARALLEL, async () => {
    await world();
    const ids = Array.from({ length: 100 }, (_, n) => `out-t1513-par-${String(n).padStart(3, "0")}`);
    for (const id of ids) {
      await addRow(id);
    }
    const answers = await Promise.all(
      ids.map((id) => untilNotTransient(() => plan(planRequest(id, FIRST_TEXT_LINES)))),
    );
    expect(answers.map(({ answer }) => answer)).toEqual(ids.map((id) => written(id)));
    const marks = await marksNow();
    expect(marks).toHaveLength(1);
    const [mark] = marks;
    expect(ids).toContain(mark?.outbox_row_id);
    expect(mark).toEqual(markOf(String(mark?.outbox_row_id)));
    // Every row but the marked one reads that it was texted before.
    const facts = await Promise.all(ids.map((id) => factsOf(id)));
    expect(facts.filter(([texted]) => !texted)).toEqual([[false, mark?.outbox_row_id]]);
  });
});

// ---- readFixedLineFacts: a row that never went never counts (default 202) ----------------------------------------------

describe("readFixedLineFacts counts no earlier row that never went, in either branch (K-05 v1.21 default 202; T-1513)", () => {
  for (const state of NEVER_WENT) {
    it(
      `a mark naming a row that ended ${state}: the next row carries the opener, and the row after it does not`,
      SLOW,
      async () => {
        await world();
        await addRow("out-t1513-lost");
        await addRow("out-t1513-real-first");
        await addRow("out-t1513-third");
        expect(await plan(planRequest("out-t1513-lost", FIRST_TEXT_LINES))).toEqual(
          written("out-t1513-lost"),
        );
        expect(await marksNow()).toEqual([markOf("out-t1513-lost")]);
        // While the marked row may still go, the next row reads it.
        expect(await factsOf("out-t1513-real-first")).toEqual([true, "out-t1513-lost"]);

        await rowEnded("out-t1513-lost", state);
        // It never went: the next row is the first text that goes, so it carries the opener.
        expect(await factsOf("out-t1513-real-first")).toEqual([false, null]);
        expect(await plan(planRequest("out-t1513-real-first", FIRST_TEXT_LINES))).toEqual(
          written("out-t1513-real-first"),
        );
        // The mark is written once and stays; the read falls back to the row that carries it.
        expect(await marksNow()).toEqual([markOf("out-t1513-lost")]);
        expect(await factsOf("out-t1513-third")).toEqual([true, "out-t1513-real-first"]);
        // Read again, the next row still carries the opener, and the marked row reads itself as today.
        expect(await factsOf("out-t1513-real-first")).toEqual([false, null]);
        expect(await factsOf("out-t1513-lost")).toEqual([false, "out-t1513-lost"]);
      },
    );
  }

  for (const state of NEVER_WENT) {
    it(
      `no business: a first row carrying the sign-up opener that ended ${state} never counts; the next row carries the opener, and the row after it does not`,
      SLOW,
      async () => {
        await world();
        const noBusiness: RowOf = { business: null };
        await addRow("out-t1513-sign-up-lost", noBusiness);
        await addRow("out-t1513-sign-up-real", noBusiness);
        await addRow("out-t1513-sign-up-third", noBusiness);
        expect(await plan(planRequest("out-t1513-sign-up-lost", ["signUpOpener", "optOutLine"]))).toEqual(
          written("out-t1513-sign-up-lost"),
        );
        // Either opener id counts (default 204): while the row may still go, the next row reads it.
        expect(await factsOf("out-t1513-sign-up-real", null)).toEqual([true, "out-t1513-sign-up-lost"]);

        await rowEnded("out-t1513-sign-up-lost", state);
        expect(await factsOf("out-t1513-sign-up-real", null)).toEqual([false, null]);
        expect(await plan(planRequest("out-t1513-sign-up-real", ["signUpOpener", "optOutLine"]))).toEqual(
          written("out-t1513-sign-up-real"),
        );
        expect(await factsOf("out-t1513-sign-up-third", null)).toEqual([true, "out-t1513-sign-up-real"]);
        expect(await factsOf("out-t1513-sign-up-real", null)).toEqual([false, null]);
        // No mark is ever written with no business.
        expect(await marksNow()).toEqual([]);
      },
    );
  }
});

// ---- markPart: the opt-out line's first delivery (default 203) --------------------------------------------------------

describe("markPart writes the opt-out line's first delivery time on the phone, its version raised once (K-05 v1.21 default 203; T-1513)", () => {
  it(
    "the first delivered words part of a row with the line sets the receipt's time, the version raised by one; a repeat and a second line-carrying delivery write nothing; the receipt's clock still arms",
    SLOW,
    async () => {
      await world();
      // A7-03's row, as finalize writes it with the STOP, HELP and rates line; claimed, sent and delivered for real.
      expect(await plan(planRequest(A7_03_ROW, ["optOutLine"]))).toEqual(written(A7_03_ROW));
      const claimed = await claimOutboxV12(runtime, {
        claimer: "dispatcher-1",
        recipientHandleId: ALEX,
        now: "2026-10-23T14:05:03Z",
        limit: 10,
      });
      expect(claimed).toMatchObject({ result: "claimed", claimed: [{ outboxRowId: A7_03_ROW, version: 3 }] });
      expect(
        await markPartV12(runtime, {
          outcome: "sent",
          idempotencyKey: `${A7_03_ROW}/1/1`,
          providerMessageId: "linq-t1513-a7-03",
          providerOptionIds: null,
          at: "2026-10-23T14:05:03Z",
        }),
      ).toMatchObject({ result: "marked", repeated: false, row: { state: "sent", version: 4 } });
      // A part sent is no delivery: the phone is as it was.
      expect(await phoneNow()).toMatchObject({ optout_line_delivered_at: null, version: 4 });

      const deliveredAt = "2026-10-23T14:05:04Z";
      const first = await delivered("linq-t1513-a7-03", deliveredAt);
      expect(first).toEqual({
        result: "marked",
        outboxRowId: A7_03_ROW,
        partNo: 1,
        tryNo: 1,
        attempts: 1,
        repeated: false,
        firstDelivery: true,
        openQuestionId: A7_03_QUESTION,
        nextKey: null,
        row: { state: "delivered", version: 5 },
        repeatedDelivery: null,
      });
      expect(await phoneNow()).toEqual({
        stopped: false,
        stop_at: null,
        chat_open: true,
        optout_line_delivered_at: new Date(deliveredAt),
        version: 5,
      });

      // Linq's retry of the receipt, and a later report of it: repeats, nothing written.
      const phone = await phoneNow();
      expect(await delivered("linq-t1513-a7-03", deliveredAt)).toMatchObject({
        repeated: true,
        firstDelivery: false,
      });
      expect(await delivered("linq-t1513-a7-03", "2026-10-23T14:09:00Z")).toMatchObject({ repeated: true });
      expect(await phoneNow()).toEqual(phone);

      // The dispatcher's clock path is unchanged: firstDelivery arms the question's clock 24 h from the delivery.
      expect(
        await armClock(runtime, {
          openQuestionId: A7_03_QUESTION,
          deliveredAt,
          dueAt: "2026-10-24T14:05:04Z",
          dueZone: "America/New_York",
        }),
      ).toEqual({
        result: "armed",
        repeated: false,
        clock: {
          clockRowId: "clock-oq-a7-03-alex",
          version: 2,
          armedAt: deliveredAt,
          dueAt: "2026-10-24T14:05:04Z",
          dueZone: "America/New_York",
          handleId: ALEX,
        },
      });

      // A second row that carried the line, delivered later: the first time stays, the version does not move.
      await sentRow("out-t1513-second-line", ["optOutLine"]);
      expect(await delivered("out-t1513-second-line-m1", "2026-10-23T15:00:00Z")).toMatchObject({
        repeated: false,
        firstDelivery: true,
        row: { state: "delivered", version: 5 },
      });
      expect(await phoneNow()).toEqual(phone);
    },
  );

  it(
    "a row without the line, an email row, a delivered poll part and a poll's plain retry write nothing; the words part then sets it, through markPart as through markPartV12",
    SLOW,
    async () => {
      await world();
      const before = await phonesNow();
      // A row without the line.
      await sentRow("out-t1513-no-line", ["opener", "privacyLink"]);
      expect(await delivered("out-t1513-no-line-m1", "2026-10-23T14:10:00Z")).toMatchObject({
        firstDelivery: true,
      });
      // An email row (no phones row), its final parts holding the line.
      await sentRow("out-t1513-email", ["optOutLine"], { handle: ALEX_EMAIL, channel: "email" });
      expect(await delivered("out-t1513-email-m1", "2026-10-23T14:10:01Z")).toMatchObject({
        firstDelivery: true,
      });
      // A row with a words part and a poll: the poll's delivery first, then the poll's plain words retry of another
      // row (outbox.ts default 29), neither of which carries the line.
      await sentRow("out-t1513-poll", ["optOutLine"], { sends: [WORDS, POLL] });
      expect(await delivered("out-t1513-poll-m2", "2026-10-23T14:10:02Z")).toMatchObject({
        partNo: 2,
        firstDelivery: true,
        row: { state: "sent", version: 5 },
      });
      await sentRow("out-t1513-retry", ["optOutLine"], { sends: [WORDS, POLL], retried: 2 });
      expect(await delivered("out-t1513-retry-m2", "2026-10-23T14:10:03Z")).toMatchObject({
        partNo: 2,
        tryNo: 2,
        firstDelivery: true,
      });
      expect(await phonesNow()).toEqual(before);

      // The words part of the poll's row, through K-05 v1's markPart: the line's first delivery.
      const answer: MarkPartOutcome = await markPart(runtime, {
        outcome: "delivered",
        providerMessageId: "out-t1513-poll-m1",
        at: "2026-10-23T14:10:04Z",
      });
      expect(answer).toMatchObject({ result: "marked", partNo: 1, repeated: false, firstDelivery: false });
      expect(await phoneNow()).toEqual({
        stopped: false,
        stop_at: null,
        chat_open: true,
        optout_line_delivered_at: new Date("2026-10-23T14:10:04Z"),
        version: 5,
      });
      // The retried row's words part is the line's second delivery: nothing moves.
      expect(await delivered("out-t1513-retry-m1", "2026-10-23T14:10:05Z")).toMatchObject({ partNo: 1 });
      expect(await phoneNow()).toMatchObject({
        optout_line_delivered_at: new Date("2026-10-23T14:10:04Z"),
        version: 5,
      });
    },
  );

  it(
    "a stopped phone stays stopped: only the opt-out time is written, never STOP's fields",
    SLOW,
    async () => {
      await world();
      await db.sql`
      update phones set stopped = true, stop_at = ${"2026-10-23T14:06:00Z"}, chat_open = false, version = version + 1
      where handle_id = ${ALEX}
    `;
      // A receipt for a text sent before the STOP, coming after it.
      await sentRow("out-t1513-before-stop", ["optOutLine"]);
      expect(await delivered("out-t1513-before-stop-m1", "2026-10-23T14:06:30Z")).toMatchObject({
        firstDelivery: true,
      });
      expect(await phoneNow()).toEqual({
        stopped: true,
        stop_at: new Date("2026-10-23T14:06:00Z"),
        chat_open: false,
        optout_line_delivered_at: new Date("2026-10-23T14:06:30Z"),
        version: 6,
      });
    },
  );
});

// ---- the phone's raised version and STOP ------------------------------------------------------------------------------

/** A STOP for Alex as the guard commits it (commit-alex-stop.json's phone write alone), at the version it read. */
function stopRequest(turnId: string, expectVersion: number, at: string): CommitTurnRequest {
  const request: Json = {
    turn: {
      id: turnId,
      handleId: ALEX,
      eventIds: [`evt-${turnId}`],
      bundleId: { hash: BUNDLE_HASH, build: 1 },
      traceId: `trace-${turnId}`,
      joinedTraceIds: [],
      tries: 1,
    },
    versionsRead: [{ table: "phones", rowId: ALEX_NUMBER, version: expectVersion }],
    writes: {
      state: [
        {
          op: "update",
          table: "phones",
          key: { number: ALEX_NUMBER },
          expectVersion,
          set: { stopped: true, stop_at: at, chat_open: false },
        },
      ],
      openQuestions: { open: [], close: [] },
      clockRows: { make: [], cancel: [] },
      outboxRows: [],
      reservations: { confirm: [], release: [] },
      events: [],
    },
  };
  return request as unknown as CommitTurnRequest;
}

async function phoneVersion(): Promise<number> {
  const phone = await phoneNow();
  if (phone === undefined) {
    throw new Error("Alex's phone is missing");
  }
  return phone.version as number;
}

describe("the raised version and STOP (K-05 v1.21 default 203; check-repeat card B (5), (6); T-1513)", () => {
  it(
    "a turn that read the phone before the receipt is refused versionChanged, and nothing is written",
    SLOW,
    async () => {
      await world();
      await sentRow("out-t1513-race-read", ["optOutLine"]);
      const read = await phoneVersion();
      expect(await delivered("out-t1513-race-read-m1", "2026-10-23T14:07:00Z")).toMatchObject({
        firstDelivery: true,
      });
      const after = await phonesNow();
      const stop: CommitTurnOutcome = await commitTurn(
        runtime,
        stopRequest("turn-t1513-stale-stop", read, "2026-10-23T14:07:01Z"),
        { now: new Date("2026-10-23T14:07:01Z") },
      );
      expect(stop).toMatchObject({ error: "versionChanged" });
      expect(await phonesNow()).toEqual(after);
      expect(await db.sql`select id from turns where id = 'turn-t1513-stale-stop'`).toHaveLength(0);
      // The turn reloads (limit 4) and its STOP is written at the version it reads now.
      expect(
        await commitTurn(runtime, stopRequest("turn-t1513-stale-stop", read + 1, "2026-10-23T14:07:02Z"), {
          now: new Date("2026-10-23T14:07:02Z"),
        }),
      ).toMatchObject({ result: "committed", repeated: false });
      expect(await phoneNow()).toMatchObject({ stopped: true, version: read + 2 });
    },
  );

  it(
    "a STOP commit and a delivery racing on one phone, 200 times: the STOP is never lost and the first delivery's time is kept; a retried 40P01 is transient",
    PARALLEL,
    async () => {
      await world();
      for (let n = 0; n < 200; n += 1) {
        const id = `out-t1513-race-${String(n).padStart(3, "0")}`;
        const turnId = `turn-t1513-stop-${String(n).padStart(3, "0")}`;
        // A START before each round, as the owner writes it: the phone open, not stopped, no line delivered.
        await db.sql`
          update phones set stopped = false, stop_at = null, chat_open = true, optout_line_delivered_at = null,
                            version = version + 1
          where handle_id = ${ALEX}
        `;
        await sentRow(id, ["optOutLine"]);
        const start = await phoneVersion();
        const at = new Date(Date.parse("2026-10-23T15:00:00Z") + n * 1000)
          .toISOString()
          .replace(".000Z", "Z");

        // Each side retried while it answers transient (a 40P01 or a serialization failure rolled it back whole).
        const delivery = untilNotTransient(() => delivered(`${id}-m1`, at));
        const stop = (async (): Promise<{ answer: CommitTurnOutcome; reloads: number }> => {
          let version = start;
          for (let reloads = 0; reloads < 20; reloads += 1) {
            const { answer } = await untilNotTransient(() =>
              commitTurn(runtime, stopRequest(turnId, version, at), { now: new Date(at) }),
            );
            if (!("error" in answer) || answer.error !== "versionChanged") {
              return { answer, reloads };
            }
            // Limit 4: the turn reloads the phone and commits at the version it reads now.
            version = await phoneVersion();
          }
          throw new Error("the STOP was refused twenty times");
        })();
        const [marked, stopped] = await Promise.all([delivery, stop]);
        expect(marked.answer, id).toMatchObject({ result: "marked", repeated: false, firstDelivery: true });
        expect(stopped.answer, turnId).toMatchObject({ result: "committed", repeated: false });
        // The delivery moves the version once, so a STOP that read the phone before it is refused at most once.
        expect(stopped.reloads, turnId).toBeLessThanOrEqual(1);
        // Both written, each once: the STOP's three fields and the line's time, the version raised by two.
        expect(await phoneNow(), id).toEqual({
          stopped: true,
          stop_at: new Date(at),
          chat_open: false,
          optout_line_delivered_at: new Date(at),
          version: start + 2,
        });
      }
    },
  );
});
