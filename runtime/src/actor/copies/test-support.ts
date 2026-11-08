// Doubles for the actor copies' tests (T-269). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - `fakeToolApi` is the Tool API behind the lease's commit hook, keeping K-34 v1 `safety_timers` rows in memory: each
//     commit writes the next row a test gives it (a timer started, moved or closed) and answers as K-09 v1's
//     gateAndCommit.committed does through the turn's commit hook (the lease's CommitTurnCommitted, with K-09's answer in
//     `committed`): the rows it wrote with their versions, the timer's and its core clock row's. A repeat of a turn id
//     writes nothing and answers its first commit, `repeated`, with no rows (K-05 v1 commitResult). Its `source` is the
//     reload of a handle's live timers from the same rows (running or missed, the pro's handle).
//   - `SAM_TIMER` is K-34's seed timer (seed-safety-timer.json): Sam alone on Alex's move survey, due 11:20am New York
//     time, Morgan Lee the contact who said yes, the job's address sealed under Alex's key (stand-in bytes).
// Test values only: the master's sample cast and the frozen fixtures' ids (rule 9).

import seedSafetyTimer from "../../../../contracts/db-schema/safety-incidents/fixtures/seed-safety-timer.json";
import type { CommitContext, CommitTurnAnswer, CommitTurnRequest } from "../lease";
import type { LiveTimersAnswer, SafetyTimerRow, SafetyTimerSource } from "./types";

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

export interface FakeToolApi {
  /** K-34 safety_timers rows, by id, as the shared core keeps them. */
  readonly timers: Map<string, SafetyTimerRow>;
  /** Every commit request, in order. */
  readonly commits: CommitTurnRequest[];
  /** What the next commits write, in order: a timer row (inserted, or put in place of the row with its id), or nothing. */
  readonly writes: (SafetyTimerRow | null)[];
  /** Every reload's handle id, in order. */
  readonly reloads: string[];
  /** While true the reload throws (no answer), as a core with PostgreSQL down does. */
  reloadDown: boolean;
  /** The lease's commit hook: K-09 gateAndCommit through the turn's commit hook. */
  commit(request: CommitTurnRequest, at: CommitContext): Promise<CommitTurnAnswer>;
  /** The reload of a handle's live timers, from the same rows. */
  readonly source: SafetyTimerSource;
}

export function fakeToolApi(committedAt = "2026-10-27T13:20:02Z"): FakeToolApi {
  const first = new Map<string, CommitTurnAnswer>();
  const fake: FakeToolApi = {
    timers: new Map(),
    commits: [],
    writes: [],
    reloads: [],
    reloadDown: false,
    commit(request) {
      fake.commits.push(structuredClone(request));
      const known = first.get(request.turn.id);
      if (known !== undefined) {
        // A repeat writes nothing: its rows are empty, and the first commit comes back.
        const again = structuredClone(known) as CommitTurnAnswer & { committed: Json };
        const committed = again.committed;
        return Promise.resolve({
          ...again,
          repeated: true,
          committed: {
            ...committed,
            repeated: true,
            written: { written: [], outboxRows: [], promoted: [] },
          },
        } as CommitTurnAnswer);
      }
      const write = fake.writes.shift() ?? null;
      const written: { table: string; rowId: string; version: number }[] = [];
      if (write !== null) {
        fake.timers.set(write.id, structuredClone(write));
        written.push({ table: "safety_timers", rowId: write.id, version: write.version });
        if (write.version === 1) {
          written.push({ table: "clock_rows", rowId: write.clock_row_id, version: 1 });
        }
      }
      const answer: CommitTurnAnswer = {
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
          core: [],
          written: { written, outboxRows: [], promoted: [] },
          effects: [],
          openQuestions: { opened: [], closed: [] },
        },
      };
      first.set(request.turn.id, structuredClone(answer));
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
  };
  return fake;
}
