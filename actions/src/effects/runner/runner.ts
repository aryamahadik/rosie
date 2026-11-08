// The effects runner (C-109, C-036; T-323): Stripe, calendar and contacts calls run after the commit, from the effect rows
// it wrote, once each (arch 10 line 508; tour line 420), on each row's one idempotency key, with network errors tried
// again up to 5 times in 10 minutes before the row becomes that service's outage row, and a card decline never tried
// again (arch 10 line 542; RULES 3.11).
//
// One run (runDue):
//   1. claim due rows of the ports this runner serves (K-05 v1.1 claimEffects, item 20): pending rows, and running rows
//      whose claim lapsed (a runner that died); the database hands each row to one claimer (SKIP LOCKED, compare and set),
//      so two runners never hold one row;
//   2. run every claimed row at once, each to its end, so no row's waits hold another's first try past its claim:
//      a. a row that cannot run as it stands is never called (refused): no idempotency key (K-07 v1
//         refuse-effect-without-key), a kind or port that is not K-07's, a calendar that names no calendar, a kind with
//         no port here;
//      b. a try starts only while the claim leaves the port call its whole budget, so a call never runs past the claim
//         into another runner's (schedule.ts); the port gets the row's one idempotency key, the try's number and when it
//         must answer, and is stopped waiting for then (a network error, "timeout");
//      c. the try's outcome is recorded (K-05 v1.1 recordEffectResult, item 21) with its effect.result entry, in one
//         transaction; ok and a decline end the row; a network error keeps it running and claimed until 60 s past the
//         next try, which goes at its 2-minute slot from the run's first try (sooner on a shorter Retry-After), and on the
//         run's 5th the call moves the row to that service's outage row, where it waits for serviceBack;
//      d. any K-05 refusal ends the row for this runner (claimLost: another runner holds it now), so a try is never
//         doubled; a transient answer sends the same result again, at most 3 times in all;
//   3. report each row's end, by labels and counts.
// Each try is one K-08 v1 effectRun span on the trace the caller opens for the effect (provider, the port contract's call,
// the try), carrying ids, labels and counts only: never the idempotency key, the port request, an amount or a card.
//
// Not here: what starts the runner (C-056: the queue consumer after a commit and the minute sweep for missed rows,
// QUESTIONS.md M2-action-adapters.4), serviceBack after an outage (C-174 to C-176; its claimed rows run through `run`),
// and each kind's port (contacts/add T-324, Stripe T-326, calendars T-327).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. Spacing: a try every 2 minutes from the run's first try, at 0, 2, 4, 6 and 8 minutes, sooner on a shorter
//      Retry-After (QUESTIONS.md M2-action-adapters.4, the CTO's).
//   2. A port call's budget is half a claim, 30 s (K-05 v1.1 open gap 12 asks for port calls under 60 s): no try starts
//      with less of the claim left, and a port that has not answered by then is a network error with code "timeout".
//   3. A port that throws, or answers outside its three outcomes, is a network error with code "port_threw" or
//      "port_answer_invalid": tried again on the same key, so a fault ends in the outage row the team sees, never in a
//      silent stop or an endless claim (K-07 v1 open gap 5 gives no state for any other refusal).
//   4. A transient answer to a result sends the same request again at once, 3 sends in all (K-05: "the same request may
//      be sent again"); still transient, the row is left to its claim, which lapses, and it is run again on its key.
//   5. A row this runner called a port for is remembered with the version it last knew, the last 1,000 rows, so the same
//      claim handed again (a redelivered message) does nothing; a later claim of the row (after its claim lapsed, or
//      serviceBack's) has a higher version and runs.
//   6. A refused row is left to its claim (K-05 v1.1 has no call to let a claim go), so it is claimed and refused again
//      each time its claim lapses, and shows in each report until its fault is fixed.

import { isLabel, type Provider, type SpanFacts } from "../../../../runtime/src/trace";
import {
  EFFECT_KINDS,
  EFFECT_PORTS,
  isEffectKind,
  providerOf,
  servedPorts,
  type EffectKind,
  type EffectPortName,
  type EffectRow,
  type KindAnswer,
  type KindCall,
  type KindPort,
} from "../kinds";
import { epochOf, systemClock, utc } from "./clock";
import { endsInOutage, resultRequest, type TryRecord } from "./entry";
import { EffectsRunnerConfigError, EffectsRunnerError, type RowFailure } from "./errors";
import { EFFECT_TRIES, PORT_CALL_BUDGET_MS, claimLeavesBudget, nextTryAt } from "./schedule";
import type {
  ClaimEffectsRequest,
  ClaimedEffect,
  EffectResultRequest,
  EffectSpans,
  EffectsRunner,
  EffectsRunnerDeps,
  RecordEffectResultError,
  RecordEffectResultResponse,
  Refusal,
  RowEnd,
  RowReport,
  RunnerClock,
  SpanRefusedReport,
} from "./types";

/** Rows per claim when the caller names no limit (K-05 v1.1 claim-effects.json claims with 10). */
export const DEFAULT_CLAIM_LIMIT = 10;
/** Sends of one result while K-05 answers transient (default 4). */
export const RESULT_SENDS = 3;
/** Rows remembered after a call, so the same claim handed again does nothing (default 5). */
export const ENDED_MEMORY = 1_000;

/** What a claimed row needs to run: its kind, its kind's port, the provider its spans name, its run's first try. */
interface Runnable {
  readonly kind: EffectKind;
  readonly port: KindPort;
  readonly provider: Provider;
  /** Epoch milliseconds. */
  readonly firstTryAt: number;
}

/** What one try's span is written from. */
interface TrySpan {
  readonly effect: EffectRow;
  readonly record: TryRecord;
  readonly answer: KindAnswer;
  readonly provider: Provider;
  readonly call: string;
  readonly kind: EffectKind;
  readonly attempt: number;
  /** The run's previous try's outcome, or null for its first. */
  readonly previous: string | null;
  /** Where K-05 says the row stands after the result, or its refusal's code, or "thrown". */
  readonly recorded: string;
}

/** How one try's port call came back. */
type PortSettled =
  | { readonly kind: "answered"; readonly answer: unknown }
  | { readonly kind: "threw" }
  | { readonly kind: "timedOut" };

type Timing = ReturnType<EffectSpans["start"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

/** A port's answer held to the three outcomes and their fields (kinds.ts KindAnswer), or null when it is not one. */
function answerOf(value: unknown): KindAnswer | null {
  if (!isRecord(value)) return null;
  if (value.outcome === "ok" && isTextOrNull(value.providerObjectId) && isTextOrNull(value.ledgerLineId)) {
    return { outcome: "ok", providerObjectId: value.providerObjectId, ledgerLineId: value.ledgerLineId };
  }
  if (value.outcome === "declined" && isText(value.errorCode)) {
    return { outcome: "declined", errorCode: value.errorCode };
  }
  const retryAfterMs = value.retryAfterMs;
  if (
    value.outcome === "networkError" &&
    isText(value.errorCode) &&
    (retryAfterMs === null || typeof retryAfterMs === "number")
  ) {
    return { outcome: "networkError", errorCode: value.errorCode, retryAfterMs };
  }
  return null;
}

/** What a try counts as, from how its port call came back (defaults 2 and 3). */
function tryAnswer(settled: PortSettled): KindAnswer {
  if (settled.kind === "timedOut")
    return { outcome: "networkError", errorCode: "timeout", retryAfterMs: null };
  if (settled.kind === "threw")
    return { outcome: "networkError", errorCode: "port_threw", retryAfterMs: null };
  return (
    answerOf(settled.answer) ?? {
      outcome: "networkError",
      errorCode: "port_answer_invalid",
      retryAfterMs: null,
    }
  );
}

/** A label for a span, or the fallback when the value is not one (a span refuses anything else: K-08 v1). */
function labelOr(value: string | null, fallback: string): string {
  return value !== null && isLabel(value) ? value : fallback;
}

function reportToConsole(report: SpanRefusedReport): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "effects_span_refused",
      effect_id: labelOr(report.effectId, "unlabeled"),
      attempt: report.attempt,
      error: report.error,
    }),
  );
}

/** The ends a recorded result can give: where K-05 says the row now stands. */
function recordedEnd(state: RecordEffectResultResponse["state"]): RowEnd | null {
  if (state === "succeeded" || state === "declined" || state === "outage") return state;
  return null;
}

export function createEffectsRunner(deps: EffectsRunnerDeps): EffectsRunner {
  const { claimer, repo, kinds } = deps;
  const clock: RunnerClock = deps.clock ?? systemClock();
  const limit = deps.limit ?? DEFAULT_CLAIM_LIMIT;
  const zoneOf = (effect: EffectRow): Promise<string | null> =>
    deps.zoneOf === undefined ? Promise.resolve(null) : deps.zoneOf(effect);
  const onSpanRefused = (report: SpanRefusedReport): void => {
    if (deps.onSpanRefused === undefined) reportToConsole(report);
    else deps.onSpanRefused(report);
  };

  const problems: string[] = [];
  if (!isLabel(claimer)) problems.push("the claimer is not a label");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) problems.push("the claim limit is not 1 to 100");
  if (problems.length > 0) throw new EffectsRunnerConfigError(problems);

  /** Rows being run by this runner now, by effect id. */
  const inFlight = new Set<string>();
  /** Rows this runner called a port for, by effect id, with the version it last knew of each (default 5). */
  const ended = new Map<string, number>();

  const remember = (effectId: string, version: number): void => {
    ended.delete(effectId);
    ended.set(effectId, version);
    if (ended.size > ENDED_MEMORY) {
      const oldest = ended.keys().next();
      if (oldest.done !== true) ended.delete(oldest.value);
    }
  };
  const isRepeat = (claimed: ClaimedEffect): boolean => {
    const endedAt = ended.get(claimed.effect.effectId);
    return inFlight.has(claimed.effect.effectId) || (endedAt !== undefined && claimed.version <= endedAt);
  };

  /** What a row needs to run, or why it cannot run as it stands (step 2a). */
  const runnableOf = (claimed: ClaimedEffect, kind: EffectKind | null): Runnable | Refusal => {
    const effect: EffectRow = claimed.effect;
    const state: EffectRow["state"] = effect.state;
    if (state !== "running") return "notRunning";
    if (claimed.claimedBy !== claimer) return "notOurs";
    if (!isText(effect.idempotencyKey)) return "noIdempotencyKey";
    if (kind === null) return "unknownKind";
    if (EFFECT_KINDS[kind].port !== effect.port) return "portMismatch";
    const provider = providerOf(effect);
    if (provider === null) return "noCalendarProvider";
    const port = kinds[kind];
    if (port === undefined) return "noKindPort";
    const firstTryAt = effect.firstTryAt === null ? Number.NaN : Date.parse(effect.firstTryAt);
    if (Number.isNaN(firstTryAt)) return "noFirstTry";
    return { kind, port, provider, firstTryAt };
  };

  /** The effect's trace, or null when the caller could not open it (its spans are then reported, never its run). */
  const spansOf = (effect: EffectRow, attempt: number): EffectSpans | null => {
    try {
      return deps.traceOf(effect);
    } catch (error) {
      onSpanRefused({
        effectId: effect.effectId,
        attempt,
        error: error instanceof Error ? labelOr(error.name, "error") : "error",
      });
      return null;
    }
  };

  const startSpan = (spans: EffectSpans | null, effectId: string, attempt: number): Timing | null => {
    if (spans === null) return null;
    try {
      return spans.start("effectRun");
    } catch (error) {
      onSpanRefused({
        effectId,
        attempt,
        error: error instanceof Error ? labelOr(error.name, "error") : "error",
      });
      return null;
    }
  };

  /** One port call, stopped waiting for at `answerBy` (step 2b). */
  const callPort = async (
    port: KindPort,
    call: Omit<KindCall, "signal">,
    answerBy: number,
  ): Promise<KindAnswer> => {
    const portAbort = new AbortController();
    const waitAbort = new AbortController();
    const answered: Promise<PortSettled> = Promise.resolve()
      .then(() => port.run({ ...call, signal: portAbort.signal }))
      .then(
        (answer: unknown): PortSettled => ({ kind: "answered", answer }),
        (): PortSettled => ({ kind: "threw" }),
      );
    const timedOut = clock
      .sleepUntil(answerBy, waitAbort.signal)
      .then((): PortSettled => ({ kind: "timedOut" }));
    const settled = await Promise.race([answered, timedOut]);
    waitAbort.abort();
    if (settled.kind === "timedOut") portAbort.abort();
    return tryAnswer(settled);
  };

  /** Sends one result, again while K-05 answers transient (default 4). */
  const recordResult = async (
    request: EffectResultRequest,
  ): Promise<RecordEffectResultResponse | RecordEffectResultError> => {
    let answer = await repo.recordEffectResult(request);
    for (let send = 1; send < RESULT_SENDS && "error" in answer && answer.error === "transient"; send += 1) {
      answer = await repo.recordEffectResult(request);
    }
    return answer;
  };

  /**
   * Ends one try's effectRun span (K-08 v1): the provider, the port contract's call and the try; what it got and decided
   * as ids, labels and counts. A span the trace refuses is reported, and the run goes on.
   */
  const finishSpan = (timing: Timing | null, tryRun: TrySpan): void => {
    if (timing === null) return;
    const { effect, record, answer } = tryRun;
    try {
      timing.finish({
        outcome:
          answer.outcome === "ok"
            ? "ok"
            : answer.outcome === "declined"
              ? "refused"
              : answer.errorCode === "timeout"
                ? "timedOut"
                : "failed",
        businessId: effect.businessId === null ? null : labelOr(effect.businessId, "unlabeled"),
        provider: tryRun.provider,
        call: tryRun.call,
        attempt: tryRun.attempt,
        got: {
          effect: labelOr(effect.effectId, "unlabeled"),
          booking: effect.bookingId === null ? null : labelOr(effect.bookingId, "unlabeled"),
          kind: tryRun.kind,
          run: effect.runs,
          previousTry: tryRun.previous,
        } satisfies SpanFacts,
        decided: {
          result: answer.outcome,
          recorded: tryRun.recorded,
          outageRow: endsInOutage(record),
          nextTryAt: record.nextTryAt === null ? null : utc(record.nextTryAt),
        } satisfies SpanFacts,
        errorCode: answer.outcome === "ok" ? null : labelOr(answer.errorCode, "unlabeled"),
      });
    } catch (error) {
      onSpanRefused({
        effectId: effect.effectId,
        attempt: tryRun.attempt,
        error: error instanceof Error ? labelOr(error.name, "error") : "error",
      });
    }
  };

  /** Runs one row this runner may run, try by try, to its end (steps 2b to 2d). */
  const runTries = async (claimed: ClaimedEffect, runnable: Runnable): Promise<RowReport> => {
    const effect: EffectRow = claimed.effect;
    const { kind, port, provider, firstTryAt } = runnable;
    const { call } = EFFECT_KINDS[kind];
    let version = claimed.version;
    let tries = effect.tries;
    let lapsesAt = epochOf(claimed.claimLapsesAt);
    let previous: string | null = tries > 0 ? "networkError" : null;
    let calls = 0;
    /** The row's end; once a call went, the version this runner last knew is kept, so the same claim is a repeat. */
    const end = (rowEnd: RowEnd, knownVersion = version): RowReport => {
      if (calls > 0) remember(effect.effectId, knownVersion);
      return { effectId: effect.effectId, kind, end: rowEnd, refusal: null, calls };
    };

    const zone = await zoneOf(effect);
    const spans = spansOf(effect, tries + 1);
    for (;;) {
      if (tries >= EFFECT_TRIES) return end("triesSpent");
      const startedAt = clock.now();
      if (!claimLeavesBudget(startedAt, lapsesAt)) return end("claimLapsed");
      const attempt = tries + 1;
      const timing = startSpan(spans, effect.effectId, attempt);
      const answerBy = startedAt + PORT_CALL_BUDGET_MS;
      calls += 1;
      const answer = await callPort(
        port,
        { effect, idempotencyKey: effect.idempotencyKey, attempt, answerBy: utc(answerBy) },
        answerBy,
      );
      const at = clock.now();
      const next =
        answer.outcome === "networkError" ? nextTryAt(firstTryAt, attempt, at, answer.retryAfterMs) : null;
      const record: TryRecord = {
        claimer,
        effect,
        expectVersion: version,
        triesBefore: tries,
        at,
        answer,
        nextTryAt: next,
        zone,
      };
      const span = { effect, record, answer, provider, call, kind, attempt, previous };
      let recorded: RecordEffectResultResponse | RecordEffectResultError;
      try {
        recorded = await recordResult(resultRequest(record));
      } catch (error) {
        finishSpan(timing, { ...span, recorded: "thrown" });
        throw error;
      }
      finishSpan(timing, {
        ...span,
        recorded: "error" in recorded ? labelOr(recorded.error, "error") : recorded.state,
      });

      if ("error" in recorded) return end(recorded.error);
      const recordedAs = recordedEnd(recorded.state);
      if (recordedAs !== null) return end(recordedAs, recorded.version);
      // Still running: only a network error before the run's 5th try leaves it so. Anything else is not where this try
      // put it, so the runner stops rather than call again.
      if (answer.outcome !== "networkError" || next === null) return end("wrongState", recorded.version);
      version = recorded.version;
      tries = recorded.tries;
      lapsesAt = recorded.claimLapsesAt === null ? at : epochOf(recorded.claimLapsesAt);
      previous = "networkError";
      await clock.sleepUntil(next);
    }
  };

  /** One claimed row: refused, a repeat, or run to its end. */
  const runRow = async (claimed: ClaimedEffect): Promise<RowReport> => {
    const effect = claimed.effect;
    const kind = isEffectKind(effect.kind) ? effect.kind : null;
    if (isRepeat(claimed)) return { effectId: effect.effectId, kind, end: "repeat", refusal: null, calls: 0 };
    const runnable = runnableOf(claimed, kind);
    if (typeof runnable === "string") {
      return { effectId: effect.effectId, kind, end: "refused", refusal: runnable, calls: 0 };
    }
    inFlight.add(effect.effectId);
    try {
      return await runTries(claimed, runnable);
    } finally {
      inFlight.delete(effect.effectId);
    }
  };

  const run = async (claimed: readonly ClaimedEffect[]): Promise<RowReport[]> => {
    const settled = await Promise.allSettled(claimed.map((row) => runRow(row)));
    const rows: RowReport[] = [];
    const failures: RowFailure[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") rows.push(result.value);
      else failures.push({ effectId: claimed[index]?.effect.effectId ?? "unknown", error: result.reason });
    });
    if (failures.length > 0) throw new EffectsRunnerError(rows, failures);
    return rows;
  };

  return {
    run,
    async runDue() {
      const ports = servedPorts(kinds);
      const [first, ...rest] = ports;
      if (first === undefined) return { claim: "noPortServed", ports, rows: [] };
      const only: [EffectPortName, ...EffectPortName[]] = [first, ...rest];
      const request: ClaimEffectsRequest = {
        claimer,
        now: utc(clock.now()),
        limit,
        ...(ports.length === EFFECT_PORTS.length ? {} : { ports: only }),
      };
      const answer = await repo.claimEffects(request);
      if ("error" in answer) return { claim: "transient", ports, rows: [] };
      return { claim: "claimed", ports, rows: await run(answer.claimed) };
    },
  };
}
