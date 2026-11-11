// Doubles for the actor copies' tests (T-269). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - `fakeToolApi` is the Tool API behind the lease's commit hook, keeping K-34 v1 `safety_timers` rows in memory: each
//     commit writes the next row a test gives it (a timer started, moved or closed) and answers as K-09 v1's
//     gateAndCommit.committed does through the turn's commit hook (the lease's CommitTurnCommitted, with K-09's answer in
//     `committed`): the rows it wrote with their versions, the timer's and its core clock row's. A repeat of a turn id
//     writes nothing and answers its first commit, `repeated`, with no rows (K-05 v1 commitResult). Its `source` is the
//     reload of a handle's live timers from the same rows (running or missed, the pro's handle). With `timersByCore` set
//     (T-1198), a core action writes the timer rows instead: its result names them in its own words and `written` leaves
//     them out, as the commit answers since T-1194 (actions/src/commit default 9; K-09 v1.5 default 134). With
//     `loseNextAnswer` set (T-1203), the next first commit writes its rows but its answer is lost on the way back (the
//     call throws: the lease's `noAnswer`), so only the repeat of that turn id answers, with no rows. With `answerShape`
//     "k05" (T-1204), it answers as a K-05-shaped commit hook does instead: K-05 v1 commitTurn.response, K-05's own
//     commitResult in `committed` (every row the commit wrote; no core results, no flag inside it), and a repeat flagged on
//     the lease's answer alone, with no rows and the first commit's outbox rows (commit-repeat-same-turn.json). With
//     `stopWrites` (T-1206), a first commit in K-09's shape also records a STOP or a START: the K-04 phones row it keeps
//     (`phone`) takes the flag at its next version, and the answer's core results name it as K-09 v1 recordStopOrStart's
//     result does (stop-recorded.json's shape). Its `phones` is the re-read of that row's stopped flag, and its `park` is
//     K-05 v1 parkTurn as the lease's park hook answers it: alreadyCommitted (with its committedAt) for a turn id it
//     committed, whose answer may have been lost, else parked. With `slowNextAnswer` (T-1206 round 2), the next first
//     commit's answer comes back only once the test opens a hold, as a slow answer does.
//   - `SAM_TIMER` is K-34's seed timer (seed-safety-timer.json): Sam alone on Alex's move survey, due 11:20am New York
//     time, Morgan Lee the contact who said yes, the job's address sealed under Alex's key (stand-in bytes).
// Test values only: the master's sample cast and the frozen fixtures' ids (rule 9).

import seedSafetyTimer from "../../../../contracts/db-schema/safety-incidents/fixtures/seed-safety-timer.json";
import type { Hold } from "../../turn/test-support";
import type { CommitContext, CommitTurnAnswer, CommitTurnRequest, ParkAnswer, ParkingTurn } from "../lease";
import type {
  LiveTimersAnswer,
  SafetyTimerRow,
  SafetyTimerSource,
  StoppedFlagAnswer,
  StoppedFlagSource,
} from "./types";

type Json = Record<string, unknown>;

/** The values of the seed row for `table` in a K-34 seed fixture. */
function seedRow(fixture: { rows: { table: string; values: Json }[] }, table: string): Json {
  const row = fixture.rows.find((entry) => entry.table === table);
  if (row === undefined) throw new Error(`the seed has no ${table} row`);
  return structuredClone(row.values);
}

/** K-34's seed timer, as a K-34 safety_timers row. */
export const SAM_TIMER = seedRow(seedSafetyTimer, "safety_timers") as unknown as SafetyTimerRow;

/** The core clock row that fires its miss (the same seed's clock_rows row). */
export const SAM_TIMER_CLOCK = seedRow(seedSafetyTimer, "clock_rows");

/**
 * The call of a later core action that writes a K-34 timer row (T-1198): a stand-in, since K-09 v1 to v1.6 has no core
 * action that writes one (none of its 15 core actions names the table).
 */
export const LATER_TIMER_CALL = "startSafetyTimer";

export interface FakeToolApi {
  /** K-34 safety_timers rows, by id, as the shared core keeps them. */
  readonly timers: Map<string, SafetyTimerRow>;
  /** Every commit request, in order. */
  readonly commits: CommitTurnRequest[];
  /** Every answer the commit gave, in order (a repeat's among them). */
  readonly answers: CommitTurnAnswer[];
  /** What the next commits write, in order: a timer row (inserted, or put in place of the row with its id), or nothing. */
  readonly writes: (SafetyTimerRow | null)[];
  /**
   * Who writes the next commits' timer rows: null (the default), the turn's walk, so `written` lists them; or a core
   * action, by its call, whose result (gone through) names them in its own words while `written` leaves them out
   * (actions/src/commit default 9). The rows are written all the same.
   */
  timersByCore: string | null;
  /**
   * True: the next first commit goes through (its rows are written) but its answer is lost on the way back, as the call
   * throws (the lease's `noAnswer`); the answer is not in `answers`. Set back to false once used.
   */
  loseNextAnswer: boolean;
  /**
   * Set (T-1206 round 2): the next first commit goes through (its rows and flag are written at once) but its answer is
   * slow: it comes back, and joins `answers`, only once the test opens this hold. Set back to null once used.
   */
  slowNextAnswer: Hold | null;
  /**
   * How the next first commits answer (T-1204): "k09" (the default), K-09 gateAndCommit.committed through the turn's commit
   * hook; or "k05", K-05 v1 commitTurn.response, whose commitResult lists every row the commit wrote (`timersByCore` is not
   * read: K-05 has no core results). A repeat answers in its first commit's shape.
   */
  answerShape: "k09" | "k05";
  /** Every reload's handle id, in order. */
  readonly reloads: string[];
  /** While true the reload throws (no answer), as a core with PostgreSQL down does. */
  reloadDown: boolean;
  /** The lease's commit hook: K-09 gateAndCommit through the turn's commit hook. */
  commit(request: CommitTurnRequest, at: CommitContext): Promise<CommitTurnAnswer>;
  /** The reload of a handle's live timers, from the same rows. */
  readonly source: SafetyTimerSource;
  /** The K-04 phones row of Sam's phone as the shared core keeps it (T-1206): its handle, stopped flag and version. */
  readonly phone: { readonly handleId: string; stopped: boolean; version: number };
  /**
   * What the next first commits in K-09's shape record for the phone, in order (T-1206): a STOP (true), a START (false),
   * or nothing (null). The phone row takes it at its next version; the answer's core results name it.
   */
  readonly stopWrites: (boolean | null)[];
  /** Every re-read of the stopped flag's handle id, in order. */
  readonly phoneReads: string[];
  /** While true the re-read throws (no answer), as a core with PostgreSQL down does. */
  phoneDown: boolean;
  /** The re-read of a handle's stopped flag, from the same phone row (T-1206). */
  readonly phones: StoppedFlagSource;
  /** Every park's turn id, in order. */
  readonly parks: string[];
  /** The lease's park hook: K-05 v1 parkTurn, alreadyCommitted for a turn id committed here, else parked (T-1206). */
  park(turn: ParkingTurn): Promise<ParkAnswer>;
}

export function fakeToolApi(committedAt = "2026-10-27T13:20:02Z"): FakeToolApi {
  const first = new Map<string, CommitTurnAnswer>();
  const fake: FakeToolApi = {
    timers: new Map(),
    commits: [],
    answers: [],
    writes: [],
    timersByCore: null,
    loseNextAnswer: false,
    slowNextAnswer: null,
    answerShape: "k09",
    reloads: [],
    reloadDown: false,
    phone: { handleId: SAM_TIMER.worker_handle_id, stopped: false, version: 2 },
    stopWrites: [],
    phoneReads: [],
    phoneDown: false,
    parks: [],
    commit(request) {
      fake.commits.push(structuredClone(request));
      const known = first.get(request.turn.id);
      if (known !== undefined) {
        // A repeat writes nothing: its rows are empty, and the first commit comes back.
        const again = structuredClone(known) as CommitTurnAnswer & { committed: Json };
        const committed = again.committed;
        // K-05's commitResult (its rows a list) has no flag inside it: the lease's answer alone says repeated, and the
        // turn's outbox rows are read back by turn id (K-05 v1 commitResult; commit-repeat-same-turn.json).
        const repeat = (
          Array.isArray(committed.written)
            ? { ...again, repeated: true, committed: { ...committed, written: [], promoted: [] } }
            : {
                ...again,
                repeated: true,
                committed: {
                  ...committed,
                  repeated: true,
                  written: { written: [], outboxRows: [], promoted: [] },
                },
              }
        ) as CommitTurnAnswer;
        fake.answers.push(structuredClone(repeat));
        return Promise.resolve(repeat);
      }
      const write = fake.writes.shift() ?? null;
      const rows: { table: string; rowId: string; version: number }[] = [];
      const core: Json[] = [];
      if (write !== null) {
        fake.timers.set(write.id, structuredClone(write));
        rows.push({ table: "safety_timers", rowId: write.id, version: write.version });
        if (write.version === 1) {
          rows.push({ table: "clock_rows", rowId: write.clock_row_id, version: 1 });
        }
        if (fake.timersByCore !== null && fake.answerShape === "k09") {
          core.push({
            call: fake.timersByCore,
            response: { timerId: write.id, version: write.version },
            error: null,
          });
        }
      }
      const stop = fake.stopWrites.shift() ?? null;
      if (stop !== null && fake.answerShape === "k09") {
        // K-09 recordStopOrStart, gone through: the phone row's flag at its next version (stop-recorded.json's shape).
        fake.phone.stopped = stop;
        fake.phone.version += 1;
        core.push({
          call: "recordStopOrStart",
          response: {
            consentRowIds: [],
            stopped: stop,
            chatOpen: false,
            phoneVersion: fake.phone.version,
            reply: null,
            askedWhichTexts: null,
            flaggedBookingIds: [],
            repeated: false,
          },
          error: null,
        });
      }
      // A core action's rows are left out of `written` (default 9): only the walk's are listed.
      const written = fake.timersByCore !== null && fake.answerShape === "k09" ? [] : rows;
      const answer: CommitTurnAnswer =
        fake.answerShape === "k05"
          ? {
              result: "committed",
              turnId: request.turn.id,
              committedAt,
              repeated: false,
              committed: { written: rows, outboxRows: [], promoted: [] },
            }
          : {
              result: "committed",
              turnId: request.turn.id,
              committedAt,
              repeated: false,
              committed: {
                result: "committed",
                turnId: request.turn.id,
                committedAt,
                repeated: false,
                parts: [],
                planner: null,
                core,
                written: { written, outboxRows: [], promoted: [] },
                effects: [],
                openQuestions: { opened: [], closed: [] },
              },
            };
      first.set(request.turn.id, structuredClone(answer));
      if (fake.loseNextAnswer) {
        // Committed, rows and all, but the answer never comes back.
        fake.loseNextAnswer = false;
        return Promise.reject(new Error("the answer was lost on the way back"));
      }
      const slow = fake.slowNextAnswer;
      if (slow !== null) {
        // Committed, rows and flag and all, but the answer comes back only once the test opens the hold.
        fake.slowNextAnswer = null;
        return slow.wait().then(() => {
          fake.answers.push(structuredClone(answer));
          return answer;
        });
      }
      fake.answers.push(structuredClone(answer));
      return Promise.resolve(answer);
    },
    source: {
      liveTimers({ handleId }): Promise<LiveTimersAnswer> {
        fake.reloads.push(handleId);
        if (fake.reloadDown) return Promise.reject(new Error("PostgreSQL is down"));
        const timers = [...fake.timers.values()]
          .filter(
            (row) => row.worker_handle_id === handleId && (row.state === "running" || row.state === "missed"),
          )
          .map((row) => structuredClone(row));
        return Promise.resolve({ result: "timers", timers });
      },
    },
    phones: {
      stoppedFlag({ handleId }): Promise<StoppedFlagAnswer> {
        fake.phoneReads.push(handleId);
        if (fake.phoneDown) return Promise.reject(new Error("PostgreSQL is down"));
        if (handleId !== fake.phone.handleId) return Promise.resolve({ error: "unknownHandle" });
        return Promise.resolve({
          result: "phone",
          stopped: fake.phone.stopped,
          phoneVersion: fake.phone.version,
        });
      },
    },
    park(turn): Promise<ParkAnswer> {
      fake.parks.push(turn.turnId);
      const known = (first.get(turn.turnId) as { committedAt?: unknown } | undefined)?.committedAt;
      if (typeof known === "string") {
        // The turn's commit went through (its answer maybe lost): K-05 never parks it.
        return Promise.resolve({ error: "alreadyCommitted", committedAt: known });
      }
      return Promise.resolve({ result: "parked", parkedAt: committedAt, repeated: false });
    },
  };
  return fake;
}
