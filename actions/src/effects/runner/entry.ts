// One try's K-05 v1.1 recordEffectResult request, with its K-08 effect.result entry (T-323; K-05 v1.1 item 21: "Every
// result is logged in the same transaction ... at least one K-08 effect.result entry for the effect (actor job, the
// effects runner; old and new state, tries, runs and error; why the try's outcome, and on the run's 5th failed try the
// service's outage)"). The shapes are K-05 v1.1's own fixtures' (effect-result.json, effect-result-network-error.json,
// effect-try-2.json to effect-try-4.json, effect-fifth-try-outage.json), so the runner writes what the contract shows.
//
// The entry's ids and values are fixed by rule, so a result sent again after a transient answer is the same request.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. An entry's id is `log-<effect id>-run-<run>-try-<try>`, with `-ok` after a try the provider did and `-declined`
//      after a decline (K-05 v1.1 effect-result.json names its entry `...-try-1-ok`; the network errors' carry no ending).
//   2. New values name what the try changed: the state, tries and runs always; the error code after a network error or a
//      decline; the provider's object id and the ledger line after ok, each only when there is one.
//   3. `why` is the try and its outcome, with the next try's time after a network error and the port's name on the
//      outage, as K-05 v1.1's fixtures write it. K-08 v1's eventLogRow.why takes only a step, a choice, a limit, a safe
//      default, an outage path or a provider event (additionalProperties false), so these entries are K-05's shape, not
//      K-08's: a contract question for the architect (the runner's handoff names it).

import type { EffectRow, KindAnswer } from "../kinds";
import { utc } from "./clock";
import type { EffectResultRequest, EventEntry } from "./types";

/** What one try's result is built from. */
export interface TryRecord {
  readonly claimer: string;
  /** The row as claimed: its id, business, port and run. */
  readonly effect: Pick<EffectRow, "effectId" | "businessId" | "port" | "runs">;
  /** The row's version the result compares and sets (the claim's, then each result's). */
  readonly expectVersion: number;
  /** The run's tries before this one. */
  readonly triesBefore: number;
  /** When the try's answer came (epoch milliseconds). */
  readonly at: number;
  readonly answer: KindAnswer;
  /** For a network error before the run's 5th try, when the next try goes (epoch milliseconds); null otherwise. */
  readonly nextTryAt: number | null;
  /** The zone the entry is read in, or null (UTC). */
  readonly zone: string | null;
}

/** True when this try is a network error on the run's 5th try: K-05 moves the row to that service's outage row. */
export function endsInOutage(record: Pick<TryRecord, "answer" | "nextTryAt">): boolean {
  return record.answer.outcome === "networkError" && record.nextTryAt === null;
}

function newValuesOf(record: TryRecord, tries: number): Record<string, string | number> {
  const { answer, effect } = record;
  switch (answer.outcome) {
    case "ok":
      return {
        state: "succeeded",
        tries,
        runs: effect.runs,
        ...(answer.providerObjectId === null ? {} : { providerObjectId: answer.providerObjectId }),
        ...(answer.ledgerLineId === null ? {} : { ledgerLineId: answer.ledgerLineId }),
      };
    case "declined":
      return { state: "declined", tries, runs: effect.runs, errorCode: answer.errorCode };
    case "networkError":
      return {
        state: endsInOutage(record) ? "outage" : "running",
        tries,
        runs: effect.runs,
        errorCode: answer.errorCode,
      };
  }
}

function whyOf(record: TryRecord, tries: number): Record<string, string | number> {
  const { answer, nextTryAt } = record;
  if (answer.outcome !== "networkError") return { try: tries, outcome: answer.outcome };
  return nextTryAt === null
    ? { try: tries, outcome: "networkError", outage: record.effect.port }
    : { try: tries, outcome: "networkError", nextTryAt: utc(nextTryAt) };
}

function entryIdOf(record: TryRecord, tries: number): string {
  const base = `log-${record.effect.effectId}-run-${String(record.effect.runs)}-try-${String(tries)}`;
  if (record.answer.outcome === "ok") return `${base}-ok`;
  if (record.answer.outcome === "declined") return `${base}-declined`;
  return base;
}

/** The try's effect.result entry (K-05 v1 eventEntry, as K-05 v1.1's result fixtures write it). */
export function resultEntry(record: TryRecord): EventEntry {
  const tries = record.triesBefore + 1;
  return {
    id: entryIdOf(record, tries),
    kind: "effect.result",
    zone: record.zone,
    businessId: record.effect.businessId,
    actorKind: "job",
    actorPersonId: null,
    actorRole: null,
    tableName: "effects",
    rowId: record.effect.effectId,
    oldValues: { state: "running", tries: record.triesBefore, runs: record.effect.runs },
    newValues: newValuesOf(record, tries),
    sealed: null,
    why: whyOf(record, tries),
    approvedBy: null,
    proofs: null,
  };
}

/** The try's K-05 v1.1 recordEffectResult request. */
export function resultRequest(record: TryRecord): EffectResultRequest {
  const { answer } = record;
  return {
    effectId: record.effect.effectId,
    expectVersion: record.expectVersion,
    claimer: record.claimer,
    outcome: answer.outcome,
    at: utc(record.at),
    providerObjectId: answer.outcome === "ok" ? answer.providerObjectId : null,
    errorCode: answer.outcome === "ok" ? null : answer.errorCode,
    ledgerLineId: answer.outcome === "ok" ? answer.ledgerLineId : null,
    nextTryAt: answer.outcome === "networkError" && record.nextTryAt !== null ? utc(record.nextTryAt) : null,
    events: [resultEntry(record)],
  };
}
