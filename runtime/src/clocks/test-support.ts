// Doubles for the clocks' tests (T-254). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - K-05 v1 `dueClocks` over a store of clock rows (K-04 clock_rows: armed, fired): for a handle, its armed rows due by
//     `now`, earliest first, and `nextDueAt`, its earliest armed row after `now`; for the sweep, armed rows no handle owns
//     due by `now` and handle rows due before `missedBefore` (due-for-handle.json, due-for-sweep.json);
//   - K-09 v1 `gateAndCommit` with input.kind clock, which commits through K-05 v1 `fireClock` on the same store, with its
//     rules (README item 7): a fired row answers `repeated` with the first firing and writes nothing; a waiting or
//     cancelled row `notArmed`; another version `versionChanged`; a due time after `firedAt` `notDue`, unless by is
//     fireNow; else the row fires, once (fire-once.json, fire-repeat.json). With `slow` set it waits a moment before its
//     compare-and-set, as a call over the network does, so two firings can be in flight at once. A7-03's branch writes
//     fire-once.json's writes; the answer goes back in K-09's fired form (clock-staff-invite-48h.json's shape). Another
//     row's branch writes nothing.
//   - K-05 v1 `readActiveBundle`: active-bundle.json (bundle v0, the bundle fire-once.json's turn names);
//   - the directory: Alex's handle (handle-alex) is the actor phone:+15555550101.
//
// Test values only (rule 9).

import type { CommitContext } from "../actor/lease";
import activeBundle from "../../../contracts/data-access/fixtures/active-bundle.json";
import dueForHandle from "../../../contracts/data-access/fixtures/due-for-handle.json";
import dueForSweep from "../../../contracts/data-access/fixtures/due-for-sweep.json";
import fireOnceFixture from "../../../contracts/data-access/fixtures/fire-once.json";
import type { ActiveBundle } from "../bundle/types";
import type {
  ClockDeps,
  ClockGateAnswer,
  ClockGateRequest,
  ClockInput,
  DueClock,
  DueClocksRequest,
} from "./types";

/** A7-03's question clock on Alex's handle (due-for-handle.json's row): version 2, due 2026-10-24T14:05:04Z. */
export const A7_03 = dueForHandle.outcome.rows[0] as unknown as DueClock;
/** Monthly billing, which no handle owns (due-for-sweep.json's second row). */
export const MONTHLY = dueForSweep.outcome.rows[1] as unknown as DueClock;
export const ALEX_HANDLE = "handle-alex";
export const ALEX_ACTOR = "phone:+15555550101";

/** A row of Alex's handle due at `dueAt`, version 1, firing A7-03's step (its words must never reach a log). */
export function rowAt(clockRowId: string, dueAt: string, handleId: string | null = ALEX_HANDLE): DueClock {
  return {
    ...A7_03,
    fires: { ...A7_03.fires },
    clockRowId,
    version: 1,
    handleId,
    businessId: handleId === null ? null : A7_03.businessId,
    bookingId: null,
    openQuestionId: null,
    dueAt,
  };
}

type State = "armed" | "fired";

interface Firing {
  firedAt: string;
  turnId: string | null;
  written: unknown[];
  outboxRows: { id: string; commitSeq: number }[];
}

interface Stored {
  row: DueClock;
  state: State;
  firing: Firing | null;
}

type Json = Record<string, unknown>;

export interface FakeClocks {
  /** What `setClockDeps` takes. */
  readonly deps: ClockDeps;
  /** Every K-05 dueClocks request, in order. */
  readonly dueRequests: DueClocksRequest[];
  /** Every K-09 gateAndCommit request, in order, as sent. */
  readonly gateRequests: ClockGateRequest[];
  /** What each gateAndCommit was handed as the actor's holds and unread texts. */
  readonly contexts: CommitContext[];
  /** Every K-05 fireClock request the gate made, with K-05's answer. */
  readonly fireCalls: { request: Json; answer: Json }[];
  /** Every outbox row a firing wrote: once per row that fired, never on a repeat. */
  readonly writtenOutbox: string[];
  /** The directory: handle id to actor name. */
  readonly directory: Map<string, string>;
  /** When true, the gate waits a moment before its compare-and-set. */
  slow: boolean;
  /** When set, the gate answers this instead of firing (a refusal, or a failure). */
  gateAnswer: Json | null;
  /** Arms a row (a copy). */
  arm(row: DueClock): void;
  /** A row as the store holds it now (its current version). */
  rowOf(clockRowId: string): DueClock;
  /** The row's state: armed, fired, or null when unknown. */
  stateOf(clockRowId: string): State | null;
}

const NO_WRITES = {
  state: [],
  openQuestions: { open: [], close: [] },
  clockRows: { make: [], cancel: [] },
  outboxRows: [],
  reservations: { confirm: [], release: [] },
  events: [],
};

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

const dueMs = (stored: Stored): number => Date.parse(stored.row.dueAt);

const byDue = (a: Stored, b: Stored): number =>
  dueMs(a) - dueMs(b) || (a.row.clockRowId < b.row.clockRowId ? -1 : 1);

export function fakeClocks(): FakeClocks {
  const store = new Map<string, Stored>();

  const firedK05 = (stored: Stored, firing: Firing, repeated: boolean): Json => ({
    result: "fired",
    clockRowId: stored.row.clockRowId,
    version: stored.row.version,
    firedAt: firing.firedAt,
    turnId: firing.turnId,
    repeated,
    committed: { written: repeated ? [] : firing.written, outboxRows: firing.outboxRows, promoted: [] },
  });

  /** K-05 v1 fireClock's rules (README item 7), as one synchronous compare-and-set. */
  const fireClock = (input: ClockInput, turnId: string | null): Json => {
    const stored = store.get(input.clockRowId);
    if (stored === undefined) return { error: "notFound", table: "clock_rows", rowId: input.clockRowId };
    if (stored.firing !== null) return firedK05(stored, stored.firing, true);
    if (stored.row.version !== input.expectVersion) {
      return {
        error: "versionChanged",
        changed: [
          {
            table: "clock_rows",
            rowId: input.clockRowId,
            readVersion: input.expectVersion,
            currentVersion: stored.row.version,
          },
        ],
      };
    }
    if (dueMs(stored) > Date.parse(input.firedAt) && input.by !== "fireNow") {
      return { error: "notDue", clockRowId: input.clockRowId, dueAt: stored.row.dueAt };
    }
    const a703 = input.clockRowId === A7_03.clockRowId;
    const firing: Firing = {
      firedAt: input.firedAt,
      turnId,
      written: a703 ? [...fireOnceFixture.outcome.committed.written] : [],
      outboxRows: a703 ? [...fireOnceFixture.outcome.committed.outboxRows] : [],
    };
    stored.state = "fired";
    stored.row = { ...stored.row, version: stored.row.version + 1 };
    stored.firing = firing;
    fake.writtenOutbox.push(...firing.outboxRows.map((row) => row.id));
    return firedK05(stored, firing, false);
  };

  /** K-05's answer in K-09's fired form; K-05's errors are K-09's. */
  const toolApiOf = (answer: Json, a703: boolean): Json => {
    if (answer.result !== "fired") return answer;
    const repeated = answer.repeated === true;
    return {
      result: "fired",
      clockRowId: answer.clockRowId,
      version: answer.version,
      firedAt: answer.firedAt,
      turnId: answer.turnId,
      repeated,
      core: [],
      written: answer.committed,
      effects: [],
      openQuestions: { opened: [], closed: a703 && !repeated ? [A7_03.openQuestionId] : [] },
    };
  };

  const fake: FakeClocks = {
    dueRequests: [],
    gateRequests: [],
    contexts: [],
    fireCalls: [],
    writtenOutbox: [],
    directory: new Map([[ALEX_HANDLE, ALEX_ACTOR]]),
    slow: false,
    gateAnswer: null,
    arm(row) {
      store.set(row.clockRowId, { row: { ...row, fires: { ...row.fires } }, state: "armed", firing: null });
    },
    rowOf(clockRowId) {
      const stored = store.get(clockRowId);
      if (stored === undefined) throw new Error(`no clock row ${clockRowId}`);
      return { ...stored.row, fires: { ...stored.row.fires } };
    },
    stateOf(clockRowId) {
      return store.get(clockRowId)?.state ?? null;
    },
    deps: {
      data: {
        dueClocks(request) {
          fake.dueRequests.push({ ...request });
          const now = Date.parse(request.now);
          const armed = [...store.values()].filter((stored) => stored.state === "armed").sort(byDue);
          const copy = (stored: Stored): DueClock => ({ ...stored.row, fires: { ...stored.row.fires } });
          if (request.for === "handle") {
            const mine = armed.filter((stored) => stored.row.handleId === request.handleId);
            const due = mine.filter((stored) => dueMs(stored) <= now);
            const next = mine.find((stored) => dueMs(stored) > now);
            return Promise.resolve({
              result: "due",
              rows: due.slice(0, request.limit).map(copy),
              nextDueAt: next?.row.dueAt ?? null,
            });
          }
          const missedBefore = Date.parse(request.missedBefore);
          const due = armed.filter((stored) =>
            stored.row.handleId === null ? dueMs(stored) <= now : dueMs(stored) < missedBefore,
          );
          return Promise.resolve({
            result: "due",
            rows: due.slice(0, request.limit).map(copy),
            nextDueAt: null,
          });
        },
      },
      gate: {
        async gateAndCommit(request, at) {
          fake.gateRequests.push(structuredClone(request));
          fake.contexts.push(structuredClone(at));
          if (fake.slow) await pause();
          if (fake.gateAnswer !== null) return fake.gateAnswer as unknown as ClockGateAnswer;
          const input = request.input;
          const a703 = input.clockRowId === A7_03.clockRowId;
          const k05Request: Json = {
            clockRowId: input.clockRowId,
            expectVersion: input.expectVersion,
            firedAt: input.firedAt,
            by: input.by,
            jobId: input.jobId,
            turn: request.turn,
            versionsRead: a703 ? fireOnceFixture.request.versionsRead : [],
            writes: a703 ? fireOnceFixture.request.writes : NO_WRITES,
          };
          const answer = fireClock(input, request.turn?.id ?? null);
          fake.fireCalls.push({ request: structuredClone(k05Request), answer: structuredClone(answer) });
          return toolApiOf(answer, a703) as unknown as ClockGateAnswer;
        },
      },
      registry: {
        readActiveBundle() {
          return Promise.resolve(structuredClone(activeBundle.outcome) as ActiveBundle);
        },
      },
      directory: {
        actorNameOf(handleId) {
          return Promise.resolve(fake.directory.get(handleId) ?? null);
        },
      },
    },
  };
  return fake;
}
