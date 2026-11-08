// Doubles for the safety read's tests (T-246). Not imported by the Worker. Each double answers as the frozen contracts
// state: the read answers K-02 v1's safety-*.json fixtures, the bundle double reads K-01 v1's fixture bundle, the core
// double answers K-09 v1's `recordSafetyOutcome` shape. Test values only (rule 9).

import fixedLines from "../../../contracts/bundle/fixtures/fixed-lines.json";
import bundleMiniA from "../../../contracts/bundle/fixtures/bundle-mini-a.json";
import { strictestHold } from "./rules";
import type {
  BundleSafety,
  CheckedLine,
  CoreError,
  DangerWordEntry,
  DirectLineRequest,
  HandleIds,
  RecordSafetyOutcomeRequest,
  RecordSafetyOutcomeResponse,
  ReleaseSafetyHoldRequest,
  SafetyClock,
  SafetyCore,
  SafetyDeps,
  SafetyOutcome,
  SafetyReadAnswer,
  SafetyReadPort,
  SafetyReadRequest,
  SafetyResult,
  SendFixedLineRequest,
  SendFixedLineResponse,
} from "./types";
import type { SealingKeyStore } from "../gateway/seal";

/** A clock that moves only when a test says so; `advance` runs every timer that falls due, in order. */
export interface FakeClock extends SafetyClock {
  advance(ms: number): Promise<void>;
}

/** Lets the Workers runtime's own steps (WebCrypto, the actor's RPC) and the polling timers run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 12));

/**
 * `after` is made by polling, never by a promise the test resolves: a promise made inside a Durable Object cannot be
 * settled from the test's own context in the Workers runtime. `advance` moves the clock to each due time in turn and
 * lets the waiters that wake run before it moves on, so a step that wakes at 1500 ms sees 1500 ms.
 */
export function fakeClock(start = 0): FakeClock {
  let current = start;
  const dues: number[] = [];
  return {
    now: () => current,
    async after(ms) {
      const at = current + ms;
      dues.push(at);
      while (current < at) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        dues.sort((a, b) => a - b);
        const next = dues[0];
        if (next === undefined || next > target) break;
        dues.shift();
        if (next > current) current = next;
        await flush();
      }
      current = target;
      await flush();
    },
  };
}

interface FixedLineFixture {
  id: string;
  text: string | null;
}

/** The danger words of the contracts' fixtures: the entries `dangerWords` shows in K-02 v1's safety-*.json, the bundle's stand-in. */
export const FIXTURE_DANGER_WORDS: readonly DangerWordEntry[] = [
  { words: "cut won't stop bleeding", list: "plugin", kind: "other" },
  { words: "lips are swelling", list: "plugin", kind: "other" },
  { words: "don't want to be alive", list: "general", kind: "selfHarm" },
  { words: "fire", list: "general", kind: "other" },
];

/** The bundle's safety part, read from K-01 v1's fixture bundle (mini-a): its fixed lines and the A3-24 step's checked `say`. */
export function fixtureBundle(dangerWords: readonly DangerWordEntry[] = FIXTURE_DANGER_WORDS): BundleSafety {
  const lines = new Map<string, CheckedLine>();
  for (const line of (fixedLines as { lines: FixedLineFixture[] }).lines) {
    if (line.text !== null) lines.set(line.id, { id: line.id, text: line.text });
  }
  const steps = bundleMiniA.flows.A.steps as Record<string, { say?: { text: string }[] }>;
  const emergency = steps["A3-24"]?.say?.[0]?.text ?? null;
  return {
    fixedLine: (id) => lines.get(id) ?? null,
    outcomeLine: (outcome) =>
      outcome === "An emergency" && emergency !== null ? { id: "safetyEmergency", text: emergency } : null,
    dangerWords: () => dangerWords,
  };
}

export interface FakeRead extends SafetyReadPort {
  /** Every request the actor made, in the order it made them. */
  readonly requests: SafetyReadRequest[];
}

/**
 * A safety read that answers each event with the fixture's result after `delayMs` on the fake clock, or never answers.
 * `answers` maps an event id to the result it gives; an event with no answer gets none.
 */
export function fakeRead(clock: SafetyClock, answers: Record<string, SafetyResult>, delayMs = 0): FakeRead {
  const requests: SafetyReadRequest[] = [];
  return {
    requests,
    async read(request) {
      requests.push(request);
      const answer = answers[request.eventId];
      if (answer === undefined) return new Promise<SafetyReadAnswer>(() => undefined);
      if (delayMs > 0) await clock.after(delayMs);
      return {
        result: answer,
        modelCalls: [
          {
            model: "claude-haiku-5-5",
            role: "haiku",
            purpose: "safetyRead",
            input_tokens: 400,
            cached_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 40,
            cost_micro_usd: 600,
            ms: Math.max(1, delayMs),
            outcome: "ok",
          },
        ],
      };
    },
  };
}

export interface FakeCore extends SafetyCore {
  readonly recorded: {
    at: number;
    request: RecordSafetyOutcomeRequest;
    response: RecordSafetyOutcomeResponse | CoreError;
  }[];
  readonly fixed: { at: number; request: SendFixedLineRequest }[];
  readonly released: ReleaseSafetyHoldRequest[];
  /** While true every call throws, as a core with PostgreSQL down does. */
  down: boolean;
}

const OUTCOME_LINE_ID: Partial<Record<SafetyOutcome, string>> = {
  "An emergency": "safetyEmergency",
  "Crisis words": "safetyCrisis",
  "A threat to staff or others": "threatSafetyLine",
};

/** A shared core that answers K-09 v1's `recordSafetyOutcome` as safety-outcome-hold.json shows it: the hold by the strictest rule and the line as an outbox row. */
export function fakeCore(clock: SafetyClock): FakeCore {
  const core: FakeCore = {
    recorded: [],
    fixed: [],
    released: [],
    down: false,
    recordSafetyOutcome(request) {
      if (core.down) return Promise.reject(new Error("PostgreSQL is down"));
      const outcomes = request.safety.outcomes;
      const rule = strictestHold(outcomes);
      const crisis =
        outcomes.includes("Crisis words") ||
        (outcomes.includes("Unsure") && request.safety.dangerWords.some((word) => word.kind === "selfHarm"));
      const lineKey = outcomes.find((outcome) => outcome !== "No" && outcome !== "Unsure");
      const lineId = crisis
        ? "safetyCrisis"
        : lineKey === undefined
          ? "safetyEmergency"
          : (OUTCOME_LINE_ID[lineKey] ?? "outcomeLine");
      const response: RecordSafetyOutcomeResponse = {
        outcomeId: `outcome-${request.safety.eventId}`,
        outcomes,
        hold:
          rule === null
            ? null
            : {
                holdId: `hold-${request.safety.eventId}`,
                releaseRule: rule,
                blocksBooking: request.safety.dangerWords.some((word) => word.list === "plugin"),
              },
        safetyLine: { fixedLineId: lineId, outboxRowId: `out-${request.safety.eventId}` },
        told: [],
        nothingBooks: true,
        repeated: false,
      };
      core.recorded.push({ at: clock.now(), request, response });
      return Promise.resolve(response);
    },
    sendFixedLine(request): Promise<SendFixedLineResponse | CoreError> {
      if (core.down) return Promise.reject(new Error("PostgreSQL is down"));
      core.fixed.push({ at: clock.now(), request });
      return Promise.resolve({ outboxRowId: `out-fixed-${request.caller.requestId}`, repeated: false });
    },
    releaseSafetyHold(request) {
      if (core.down) return Promise.reject(new Error("PostgreSQL is down"));
      core.released.push(request);
      return Promise.resolve({
        holdId: request.holdId,
        releasedAt: new Date(clock.now()).toISOString(),
        redecideTurnId: null,
        repeated: false,
      });
    },
  };
  return core;
}

export interface FakeDirect {
  readonly sent: (DirectLineRequest & { at: number })[];
  /** True to make every send fail. */
  fail: boolean;
  send(request: DirectLineRequest): Promise<{ linqMessageId: string }>;
}

export function fakeDirect(clock: SafetyClock): FakeDirect {
  const direct: FakeDirect = {
    sent: [],
    fail: false,
    send(request) {
      if (direct.fail) return Promise.reject(new Error("Linq refused"));
      direct.sent.push({ ...request, at: clock.now() });
      return Promise.resolve({ linqMessageId: `linq-${String(direct.sent.length)}` });
    },
  };
  return direct;
}

export const TEST_IDS: HandleIds = {
  handleId: "handle-alex",
  businessId: "biz-lees-barbershop",
  personId: "person-alex",
  bookingId: null,
};

export interface Harness {
  clock: FakeClock;
  core: FakeCore;
  direct: FakeDirect;
  read: FakeRead;
  stopped: { value: boolean };
  deps: SafetyDeps;
}

/** The whole set of doubles for one test. `answers` is what the safety read says for each event id. */
export function harness(
  keys: SealingKeyStore,
  answers: Record<string, SafetyResult>,
  options: { delayMs?: number; ids?: HandleIds | null } = {},
): Harness {
  const clock = fakeClock();
  const core = fakeCore(clock);
  const direct = fakeDirect(clock);
  const read = fakeRead(clock, answers, options.delayMs ?? 0);
  const stopped = { value: false };
  const ids = options.ids === undefined ? TEST_IDS : options.ids;
  const deps: SafetyDeps = {
    read,
    bundle: fixtureBundle(),
    core,
    directory: { idsOf: () => Promise.resolve(ids) },
    keys,
    direct,
    clock,
    isStopped: () => stopped.value,
  };
  return { clock, core, direct, read, stopped, deps };
}
