// Doubles and scenarios for limit 4's tests (T-302). Never imported by the Worker. The doubles stand in for limit 4's
// ports (the open questions' read, today's versions and booking heads), for limits 1 to 3, 5 and 6 (T-299 to T-301,
// T-303, T-304), for the commit's other ports (a passed part's walk, the core calls, the holds' read), and for K-05 v1's
// commitTurn (a fake that compares and sets versions as K-05 v1 item 1 says), never for limit 4 or the commit itself.
// Values come only from the contracts' fixtures and the master's sample cast: K-04 v1's seed-booking-head.json (Alex's
// haircut), K-35's seed-license-as-given.json (Riley's license), K-05 v1's commit-version-changed.json, K-09 v1's
// commit-limit-4-changed.json (S2-22's question to Sam, Avery's license), and the master's own read-backs (A7-05, A7-23,
// A7-31, A7-66) word for word; phone numbers in the 555-01xx range (rule 9). K-30 (bookings and visits) is not frozen,
// so what a move or an add-on writes besides the booking head is its walk's: here each walk raises the head's version,
// as every change to a booking does (K-04 v1 bookings.version).

import type * as K05 from "../../../../contracts/generated/data-access/data-access.v1.1";
import {
  contractChecks,
  doublePorts,
  k05Exchange,
  noWrites,
  whyOfChoice,
  type K05Fake,
  type PortCalls,
} from "../../commit/test-support";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnAnswer,
  CommitTurnRequest,
  CommitTurnResponse,
  CoreRun,
  PassedPart,
  StateWrite,
  UnitWrites,
} from "../../commit/types";
import type { Choice, Context, GateRequest, Limit, LimitRegistry } from "../framework";
import {
  copy,
  scriptedLimits,
  type LimitCall,
  type PartScript,
  type Script,
} from "../framework/test-support";
import type { AskedQuestion, RowRef } from "../limit-3/facts";
import {
  ALEX,
  BARBERSHOP,
  BEARD_TRIM_READ_BACK_TODAY,
  HAIRCUT,
  SAM,
  TEAM_OPTIONS,
  TEAM_READ_BACK,
  ZONE,
  barbershopTarget,
  beardTrimRequest,
  beardTrimRow,
  option,
  questionsOf,
  requestFor,
  rowFor,
  typed,
} from "../limit-3/test-support";
import type { BookingStage, TodayReader } from "./facts";
import { compareAndSetOf, createLimit4, type VersionsLimit } from "./index";

export type StepCard = Context["cards"][number];

// ---------------------------------------------------------------------------------------------------------------
// Limit 4 over doubles of its ports

/** What limit 4 reads in a test: the open questions live on their handles, and today's facts. */
export interface World {
  /** The live open questions; a test may change the list, and the limit reads it as it stands. */
  readonly questions: AskedQuestion[];
  readonly today: TodayReader;
}

/** What limit 4 asked today's facts for. */
export interface TodayReads {
  readonly versions: RowRef[][];
  readonly bookings: string[];
}

/** Today's facts over a reader, every read written down. */
export function counted(today: TodayReader, reads: TodayReads): TodayReader {
  return {
    currentVersions(rows) {
      reads.versions.push(rows.map((row) => ({ ...row })));
      return today.currentVersions(rows);
    },
    booking(bookingId) {
      reads.bookings.push(bookingId);
      return today.booking(bookingId);
    },
  };
}

/** Limit 4 itself, over doubles of its ports. */
export function limitIn(world: World): VersionsLimit {
  return createLimit4({ questions: () => questionsOf(world.questions), today: () => world.today });
}

/** Limits 1 to 3, 5 and 6 as the gate framework's scripted doubles, with `limit` in slot 4 (each call written down). */
export function registryWith(
  limit: VersionsLimit,
  script: Script = {},
  calls: LimitCall[] = [],
): LimitRegistry {
  const [one, two, three, , five, six] = scriptedLimits(script, calls);
  const four: Limit<4> = {
    limit: 4,
    check(part, turn) {
      calls.push({ limit: 4, part: part.index });
      return limit.check(part, turn);
    },
  };
  return [one, two, three, four, five, six];
}

/** A K-09 gate fixture's script without limit 4's verdict: the real limit 4 gives its own. */
export function withoutLimit4(script: Script): Script {
  const out: Record<number, PartScript> = {};
  for (const [part, verdicts] of Object.entries(script)) {
    if (verdicts === undefined) continue;
    const rest: PartScript = { ...verdicts };
    Reflect.deleteProperty(rest, 4);
    out[Number(part)] = rest;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// K-05 v1's commitTurn with its compare-and-set, as a fake

/** A versioned row as the fake holds it; a booking head also has its stage. */
export interface FakeRow {
  readonly table: string;
  readonly rowId: string;
  readonly version: number;
  /** A booking head's stage (K-04 v1 bookings.stage); null for any other row. */
  readonly stage: BookingStage | null;
}

export interface VersionsFake extends K05Fake {
  /** Every row as it stands now. */
  readonly rows: ReadonlyMap<string, FakeRow>;
  /** Every answer given, in order. */
  readonly answers: CommitTurnAnswer[];
  /** Adds rows as they are. */
  seed(rows: readonly FakeRow[]): void;
  /** Another chat's commit on one row: its version raised by one, a booking given `stage` when named. */
  commitElsewhere(table: string, rowId: string, stage?: BookingStage): void;
  /** Runs before each commit that is not a repeat, with the request: the moment another turn or chat races this one. */
  beforeCommit: ((request: CommitTurnRequest) => Promise<void> | void) | null;
  /** Today's facts as limit 4 reads them, on the fake's rows. */
  readonly today: TodayReader;
}

const keyOf = (table: string, rowId: string): string => JSON.stringify([table, rowId]);

const STAGES: readonly BookingStage[] = ["entry", "booked", "checked_in", "done", "cancelled"];
const stageOf = (value: unknown): BookingStage | null => STAGES.find((stage) => stage === value) ?? null;

/** The id of the row a state write names (the fake keys every row by a text id). */
function rowIdOf(write: StateWrite): string {
  const id = write.op === "insert" ? write.values.id : write.key.id;
  if (typeof id !== "string") throw new Error("the fake keys every row by a text id");
  return id;
}

/**
 * K-05 v1.1 commitTurn on an in-memory store, as K-05 v1 item 1 says (db/repo/commit-turn.ts): a request the schema
 * refuses throws; a turn id committed before writes nothing and returns the first commit with `repeated` true; every row
 * read (versionsRead) or written (a state update, a question closed, a clock row cancelled) is compared at the version the
 * turn saw, and any that moved refuses the whole commit with versionChanged, each changed row listed once per version
 * read, the reads first, then the writes in the request's order (commit-turn.ts default 7); a row named that the fake does
 * not hold throws (default 1); else everything is written at once, an update raising its row's version by one, and each
 * commit runs in one step, so commits never interleave. Reservations are limit 5's, not this fake's.
 */
export function versionsFake(options: { now?: string } = {}): VersionsFake {
  const now = options.now ?? "2026-10-23T14:06:04Z";
  const rows = new Map<string, FakeRow>();
  const firsts = new Map<string, CommitTurnResponse>();
  const requests: CommitTurnRequest[] = [];
  const answers: CommitTurnAnswer[] = [];
  const commits: { turnId: string; written: K05.RowRef[] }[] = [];
  let nextSeq = 1;

  const mustRow = (table: string, rowId: string): FakeRow => {
    const row = rows.get(keyOf(table, rowId));
    if (row === undefined) throw new Error(`the fake holds no ${table} row ${rowId}`);
    return row;
  };

  const commit = (request: CommitTurnRequest): CommitTurnAnswer => {
    const { writes } = request;
    if (writes.reservations.confirm.length > 0 || writes.reservations.release.length > 0) {
      throw new Error("reservations are limit 5's, not this fake's");
    }
    const expected: K05.RowRef[] = [
      ...request.versionsRead,
      ...writes.state.flatMap((write) =>
        write.op === "update"
          ? [{ table: write.table, rowId: rowIdOf(write), version: write.expectVersion }]
          : [],
      ),
      ...writes.openQuestions.close.map((close) => ({
        table: "open_questions",
        rowId: close.id,
        version: close.expectVersion,
      })),
      ...writes.clockRows.cancel.map((cancel) => ({
        table: "clock_rows",
        rowId: cancel.id,
        version: cancel.expectVersion,
      })),
    ];
    const changed: K05.ChangedRow[] = [];
    const listed = new Set<string>();
    for (const each of expected) {
      const current = mustRow(each.table, each.rowId).version;
      const key = JSON.stringify([each.table, each.rowId, each.version]);
      if (current !== each.version && !listed.has(key)) {
        listed.add(key);
        changed.push({
          table: each.table,
          rowId: each.rowId,
          readVersion: each.version,
          currentVersion: current,
        });
      }
    }
    const [first, ...more] = changed;
    if (first !== undefined) return { error: "versionChanged", changed: [first, ...more] };

    const written: K05.RowRef[] = [];
    const put = (row: FakeRow): void => {
      rows.set(keyOf(row.table, row.rowId), row);
      written.push({ table: row.table, rowId: row.rowId, version: row.version });
    };
    const raise = (table: string, rowId: string): void => {
      const before = mustRow(table, rowId);
      put({ ...before, version: before.version + 1 });
    };
    for (const write of writes.state) {
      const rowId = rowIdOf(write);
      if (write.op === "insert") {
        const stage = write.table === "bookings" ? (stageOf(write.values.stage) ?? "entry") : null;
        put({ table: write.table, rowId, version: 1, stage });
      } else {
        const before = mustRow(write.table, rowId);
        put({ ...before, version: before.version + 1, stage: stageOf(write.set.stage) ?? before.stage });
      }
    }
    for (const question of writes.openQuestions.open) {
      put({ table: "open_questions", rowId: question.id, version: 1, stage: null });
    }
    for (const close of writes.openQuestions.close) raise("open_questions", close.id);
    for (const clock of writes.clockRows.make) {
      put({ table: "clock_rows", rowId: String(clock.id), version: 1, stage: null });
    }
    for (const cancel of writes.clockRows.cancel) raise("clock_rows", cancel.id);
    const outboxRows = writes.outboxRows.map((row) => ({ id: row.id, commitSeq: nextSeq++ }));
    const answer: CommitTurnResponse = {
      result: "committed",
      turnId: request.turn.id,
      committedAt: now,
      repeated: false,
      committed: { written, outboxRows, promoted: [] },
    };
    firsts.set(answer.turnId, copy(answer));
    commits.push({ turnId: answer.turnId, written: copy(written) });
    return answer;
  };

  const fake: VersionsFake = {
    rows,
    requests,
    commits,
    answers,
    beforeCommit: null,
    seed(seeded) {
      for (const row of seeded) rows.set(keyOf(row.table, row.rowId), { ...row });
    },
    commitElsewhere(table, rowId, stage) {
      const before = mustRow(table, rowId);
      rows.set(keyOf(table, rowId), { ...before, version: before.version + 1, stage: stage ?? before.stage });
    },
    today: {
      currentVersions(asked) {
        return Promise.resolve(
          asked.flatMap((ref) => {
            const row = rows.get(keyOf(ref.table, ref.rowId));
            return row === undefined ? [] : [{ table: row.table, rowId: row.rowId, version: row.version }];
          }),
        );
      },
      booking(bookingId) {
        const row = rows.get(keyOf("bookings", bookingId));
        const stage = row?.stage ?? null;
        return Promise.resolve(
          row === undefined || stage === null ? null : { id: bookingId, stage, version: row.version },
        );
      },
    },
    async commitTurn(request) {
      requests.push(copy(request));
      const problems = contractChecks().k05("commitTurn.request", request);
      if (problems.length > 0) throw new Error(`K-05 v1.1 refuses the request: ${problems.join("; ")}`);
      const first = firsts.get(request.turn.id);
      if (first !== undefined) {
        const repeat: CommitTurnResponse = {
          ...copy(first),
          repeated: true,
          committed: { written: [], outboxRows: copy(first.committed.outboxRows), promoted: [] },
        };
        answers.push(copy(repeat));
        return repeat;
      }
      if (fake.beforeCommit !== null) await fake.beforeCommit(copy(request));
      const answer = commit(request);
      answers.push(copy(answer));
      return answer;
    },
  };
  return fake;
}

/** The row the fake holds for `table` and `rowId`, as it stands. */
export function rowOf(fake: VersionsFake, table: string, rowId: string): FakeRow | undefined {
  return fake.rows.get(keyOf(table, rowId));
}

/** A booking head row at `version` (K-04 v1 seed-booking-head.json holds Alex's haircut at 7, booked). */
export function bookingRow(bookingId: string, version: number, stage: BookingStage = "booked"): FakeRow {
  return { table: "bookings", rowId: bookingId, version, stage };
}

/** Any other versioned row. */
export function plainRow(ref: RowRef): FakeRow {
  return { table: ref.table, rowId: ref.rowId, version: ref.version, stage: null };
}

/** A promise held until `count` callers reach it, for a test to hold two turns at one point. */
export function barrier(count: number): () => Promise<void> {
  let waiting = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    waiting += 1;
    if (waiting >= count) open();
    return opened;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The gate and commit end to end

export interface Ran {
  readonly deps: CommitDeps;
  readonly calls: PortCalls;
  readonly limitCalls: LimitCall[];
}

/**
 * The gate and commit's deps for one turn against the fake: limit 4 in its slot over `world`, limits 1 to 3, 5 and 6
 * passing, the K-05 port the fake, each core action's run as given, and a passed part's writes as its walk builds them
 * when the commit asks (each gate run asks again).
 */
export function depsFor(
  world: World,
  fake: VersionsFake,
  walk: (part: PassedPart) => UnitWrites,
  core: readonly CoreRun[] = [],
): Ran {
  const limitCalls: LimitCall[] = [];
  const base = doublePorts({ k05: fake, core });
  const ports: CommitPorts = {
    ...base.ports,
    async writesOf(part, turn, open) {
      await base.ports.writesOf(part, turn, open);
      return walk(part);
    },
  };
  return {
    deps: { limits: registryWith(limitIn(world), {}, limitCalls), ports },
    calls: base.calls,
    limitCalls,
  };
}

/**
 * What a passed part's walk writes on its booking: the head updated from the version its question showed (`set` as the
 * walk gives it), with the rows limit 4 compares and sets (compareAndSetOf) and any other row the walk itself read.
 */
export function headWrites(
  choice: Choice | null,
  question: AskedQuestion,
  set: Readonly<Record<string, unknown>>,
  walkRead: readonly RowRef[] = [],
): UnitWrites {
  const bookingId = choice?.target.bookingId ?? question.bookingId;
  const shown = question.versionsRead.find((row) => row.table === "bookings" && row.rowId === bookingId);
  if (bookingId === null || shown === undefined)
    throw new Error("the walk writes the booking its question showed");
  return {
    ...noWrites(whyOfChoice(choice)),
    versionsRead: [...compareAndSetOf(question), ...walkRead.map((row) => ({ ...row }))],
    state: [
      {
        op: "update",
        table: "bookings",
        key: { id: bookingId },
        expectVersion: shown.version,
        set: { ...set },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// K-09 v1 commit-limit-4-changed.json: S2-22's question to Sam

export const LIMIT_4_FIXTURE = "commit-limit-4-changed.json";
export const S2_22 = "oq-s2-22-sam";
/** Riley's barber license as K-35's seed holds it (seed-license-as-given.json): version 1. */
export const RILEY_LICENSE: RowRef = { table: "documents", rowId: "doc-riley-barber-license", version: 1 };
/** Avery's barber license, the row the fixture says changed after S2-22 went out (a new end date kept as given, S2-11). */
export const AVERY_LICENSE: RowRef = { table: "documents", rowId: "doc-avery-barber-license", version: 1 };

/** S2-22's open question to Sam as K-04 holds it: the read-back built from Riley's and Avery's licenses at version 1. */
export function teamRow(request: GateRequest, askCount?: number): AskedQuestion {
  return rowFor(request, S2_22, {
    readback: TEAM_READ_BACK,
    options: TEAM_OPTIONS,
    versionsRead: [RILEY_LICENSE, AVERY_LICENSE],
    ...(askCount === undefined ? {} : { askCount }),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// K-05 v1 commit-version-changed.json: Alex cancels his haircut (A7-05, MASTER-FLOW-A lines 3417 to 3438)

export const VERSION_CHANGED_FIXTURE = "commit-version-changed.json";
export const CANCEL_QUESTION = "oq-a7-05-alex";
/** A7-05's read-back to Alex, word for word (MASTER-FLOW-A line 3432): Rosie asks once more before a cancel. */
export const CANCEL_READ_BACK =
  "Cancel your Sat 11:00am visit with Riley? It's free. / Reply 1 Keep it, 2 Call it off.";
export const CANCEL_SENT = "2026-10-23T14:04:00Z";
/** The fixture's turn: its id, Alex's text and its trace. */
export const CANCEL_TURN = "turn-alex-cancel-1";
const CANCEL_EVENT = "evt-alex-0013";
const CANCEL_TRACE = "trace-alex-0013";

/** A7-05's card (K-02 v1 stepCard): Means 1 and 2, its Never line, clock and safe default, word for word. */
export const CANCEL_CARD: StepCard = {
  step: "A7-05",
  card: {
    question: "Cancel your Sat 11:00am visit with Riley?",
    means: [
      { branch: "1 Keep it", text: "keep it.", from: "meansLine" },
      { branch: "2 Cancel it", text: "cancel it.", from: "meansLine" },
    ],
    never: ["Never: cancel on a single tap or a slip, without the second yes."],
    safeDefault: "the visit stays booked.",
    clock: { from: "clockLine", text: "one more ask before free cancel ends; silence keeps the visit." },
  },
};

/** Alex's "2" to A7-05's read-back: the fixture's turn, text and trace. */
export function cancelRequest(): GateRequest {
  const target = barbershopTarget(HAIRCUT);
  const request = requestFor({
    who: ALEX,
    role: "customer",
    question: {
      openQuestionId: CANCEL_QUESTION,
      step: "A7-05",
      target,
      sentAt: { utc: CANCEL_SENT, zone: ZONE },
      pollId: null,
      askCount: 1,
    },
    choices: [
      option("A7-05/1", CANCEL_QUESTION, "A7-05", "1 Keep it", "keep it.", target),
      option("A7-05/2", CANCEL_QUESTION, "A7-05", "2 Cancel it", "cancel it.", target, [
        { why: "cancelRow", step: null, ref: null },
      ]),
    ],
    card: CANCEL_CARD,
    texts: [typed(CANCEL_EVENT, "2", "2026-10-23T14:06:00Z")],
    choiceId: "A7-05/2",
    quote: "2",
    turnId: CANCEL_TURN,
  });
  request.caller.traceId = CANCEL_TRACE;
  if (request.turn !== null) request.turn.traceId = CANCEL_TRACE;
  return request;
}

/** A7-05's open question to Alex as K-04 holds it: the read-back built from his haircut at `version` (the fixture's 6). */
export function cancelRow(version = 6): AskedQuestion {
  return {
    openQuestionId: CANCEL_QUESTION,
    handleId: ALEX.handleId,
    personId: ALEX.personId,
    businessId: BARBERSHOP,
    bookingId: HAIRCUT,
    step: "A7-05",
    options: [
      { id: "A7-05/1", label: "Keep it" },
      { id: "A7-05/2", label: "Call it off" },
    ],
    readback: CANCEL_READ_BACK,
    versionsRead: [{ table: "bookings", rowId: HAIRCUT, version }],
    sentAt: CANCEL_SENT,
    pollId: null,
    askCount: 1,
  };
}

/** K-05 v1's commit-version-changed.json, freshly parsed. */
export function versionChangedExchange(): K05.CommitTurnExchange {
  return k05Exchange(VERSION_CHANGED_FIXTURE);
}

/** What Alex's cancel writes, as the fixture's request writes it: the head cancelled from version 6, with its entry. */
export function cancelWrites(choice: Choice | null, question: AskedQuestion): UnitWrites {
  const { request } = versionChangedExchange();
  return {
    ...noWrites(whyOfChoice(choice)),
    versionsRead: compareAndSetOf(question),
    state: copy(request.writes.state),
    stateEvents: copy(request.writes.events),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Two chats on Alex's haircut: Alex's beard trim (A7-31), Sam's move (A7-23) and Sam's call-off (A7-66)

/** The haircut's version every read-back below was built from (K-04 v1 seed-booking-head.json). */
export const SEEDED_VERSION = 7;

/** Alex's own "1" to A7-31's read-back (limit 3's scenario), a minute after it went out. */
export function trimRequest(): GateRequest {
  return beardTrimRequest({ texts: [typed("evt-alex-0031-1", "1", "2026-10-23T14:05:00Z")], quote: "1" });
}

/** A7-31's read-back asked again from the haircut at 8 (the fresh yes), and Alex's "1" to it. */
export const FRESH_TRIM_SENT = "2026-10-23T14:30:00Z";
export function freshTrimRequest(): GateRequest {
  return beardTrimRequest({
    texts: [typed("evt-alex-0031-2", "1", "2026-10-23T14:31:00Z")],
    quote: "1",
    sentAt: FRESH_TRIM_SENT,
    askCount: 2,
  });
}
export function freshTrimRow(): AskedQuestion {
  return beardTrimRow({
    readback: BEARD_TRIM_READ_BACK_TODAY,
    versionsRead: [{ table: "bookings", rowId: HAIRCUT, version: SEEDED_VERSION + 1 }],
    sentAt: FRESH_TRIM_SENT,
    askCount: 2,
  });
}
export { beardTrimRow as trimRow };

export const MOVE_QUESTION = "oq-a7-23-sam";
/** A7-23's read-back of Sam's command, word for word (MASTER-FLOW-A line 3695). */
export const MOVE_READ_BACK = "Move Alex M. to Sat Oct 24 at 1:00pm? / Reply 1 Yes, move it.";
const MOVE_SENT = "2026-10-23T14:02:00Z";

/** A7-23's card for Sam's read-back (K-02 v1 stepCard): its Never line and safe default, word for word. */
export const MOVE_CARD: StepCard = {
  step: "A7-23",
  card: {
    question: "Move Alex M. to Sat Oct 24 at 1:00pm?",
    means: [{ branch: "1 Yes, move it", text: "Sam's command is read back first.", from: "meansLine" }],
    never: ["Never: move them to the new time, or charge a fee, on silence."],
    safeDefault: "nothing moves to the new time; no fee.",
    clock: { from: "step9Default" },
  },
};

/** Sam's "1" from his own chat to A7-23's read-back of his move. */
export function moveRequest(): GateRequest {
  const target = barbershopTarget(HAIRCUT);
  return requestFor({
    who: SAM,
    role: "owner",
    question: {
      openQuestionId: MOVE_QUESTION,
      step: "A7-23",
      target,
      sentAt: { utc: MOVE_SENT, zone: ZONE },
      pollId: null,
      askCount: 1,
    },
    choices: [
      option(
        "A7-23/1",
        MOVE_QUESTION,
        "A7-23",
        "1 Yes, move it",
        "Sam's command is read back first.",
        target,
        [{ why: "moveRow", step: null, ref: null }],
      ),
    ],
    card: MOVE_CARD,
    texts: [typed("evt-sam-a7-23", "1", "2026-10-23T14:05:00Z")],
    choiceId: "A7-23/1",
    quote: "1",
    turnId: "turn-sam-a7-23",
  });
}

/** A7-23's open question to Sam as K-04 holds it: the read-back built from the haircut at 7. */
export function moveRow(): AskedQuestion {
  return {
    openQuestionId: MOVE_QUESTION,
    handleId: SAM.handleId,
    personId: SAM.personId,
    businessId: BARBERSHOP,
    bookingId: HAIRCUT,
    step: "A7-23",
    options: [{ id: "A7-23/1", label: "Yes, move it" }],
    readback: MOVE_READ_BACK,
    versionsRead: [{ table: "bookings", rowId: HAIRCUT, version: SEEDED_VERSION }],
    sentAt: MOVE_SENT,
    pollId: null,
    askCount: 1,
  };
}
