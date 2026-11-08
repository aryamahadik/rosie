// The policy gate (C-080, T-298): gateAndCommit's first half, a Tool API call on the T-290 base (K-09 v1
// `gateAndCommit`; arch 02 line 121; arch 06 lines 295 to 309). For one turn of decided texts, in this order:
//
//   1. decide's output is checked before any limit runs (checks.ts): each part's verb, its quote word for word in the
//      turn's texts, its option offered, and every value with its source words (arch 03 line 185; arch 06 line 333). A
//      failure refuses the whole call with K-09's `decideRefused`: nothing is written and the AI layer treats it as a
//      failed read (arch 06 line 293);
//   2. each agreed part, in decide's order, takes limits 1 to 6 in order (limits.ts). The first limit that fails runs its
//      own outcome (ask, refuse or wait: K-09 `limitNOutcome`) and stops that part; the limits after it are notChecked;
//   3. a stopped part stops what depends on it, and only that: the other parts go on (arch 02 line 121);
//   4. limit 6 failing while decide has not re-read refuses the whole call with `valueFailsWords`, naming each part and
//      field, so C-116's one Sonnet re-read runs first; after it, limit 6's own outcome stops the part (K-09 v1 rule
//      rereadBeforeQuestion; arch 02 line 119; Q-41);
//   5. a limit not built yet (stub.ts) refuses every part that reaches it, and the gate then refuses the whole call
//      (LimitNotBuiltError, which the Tool API base answers as `notBuilt`, rolled back): it fails closed, never passed;
//   6. the gate span logs limits 1 to 6 (K-08 v1: the gate's limits).
//
// What the gate returns, throws or logs names rules, parts, limits, actions and field names: never a quote's or a value's
// words (K-08 v1 README: "never the raw number or words").
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A check that fails refuses the whole call, as K-09 v1's `decideRefused` does ("Nothing was written"); only a
//      failed limit stops a single part, since K-09's part results name limits 1 to 6 only. A verb none of the eight is
//      `optionOffered` (it takes no offered choice); a value with empty words is `quoteInText` (no source words). The
//      checks hold every read's parts as well as the agreed ones, as K-02's named rules do.
//   2. The verbs the limits gate are those whose part writes something in the commit: choose, enter, pass_on and
//      hand_off. A part decide ended in one question, or the verb ask, is `asked`; no_op, redact and none_fits are
//      `noAction` (K-09 v1 partResult); their limits are notChecked and no limit runs for them.
//   3. What depends on a part: neither K-02 v1 nor K-09 v1 names a link between parts, so two parts depend on each other
//      when both act on the same booking (their choices' targets name one business and one booking). A stopped part
//      stops every other part on its booking, before or after it in the text (`dependsOnStopped`, naming the lowest
//      stopped part); a part on another booking, or on none, goes on: "Parts about other bookings that both reads agree
//      on go ahead" (arch 02 line 119).
//   4. A limit not built yet refuses the whole call: K-09 v1 has no part result for it, and no part may pass.
//   5. The gate span logs one result per limit: fail when a part failed it (the first such part's outcome), else pass
//      when a part passed it, else notChecked.

import { isLabel } from "../../../../runtime/src/trace";
import type { CallContext } from "../../tool-api/tool-api";
import { checkDecideOutput } from "./checks";
import { GateLimitError, LimitNotBuiltError } from "./errors";
import type {
  Choice,
  DecidePart,
  Decided,
  GatePart,
  GateRequest,
  GateTurn,
  GateVerdict,
  GatedPart,
  GatedVerbPart,
  LimitNumber,
  LimitOutcome,
  LimitOutcomes,
  LimitRegistry,
  LimitResult,
  PartResult,
  SetupKey,
  ValueFailsWords,
} from "./types";

/** Limits 1 to 6, in the order the gate runs them (arch 06 lines 299 to 309). */
export const LIMIT_NUMBERS: readonly LimitNumber[] = [1, 2, 3, 4, 5, 6];

/** Each limit's actions with their kind of outcome (K-09 v1 `limit1Outcome` to `limit6Outcome`; README table). */
export const LIMIT_ACTIONS: {
  readonly [N in LimitNumber]: Readonly<Record<LimitOutcomes[N]["action"], LimitOutcomes[N]["outcome"]>>;
} = {
  1: { proofCodeSent: "wait", askedDecider: "ask" },
  2: { saidWhatRuleAllows: "refuse" },
  3: { freshReadBack: "ask", safeDefault: "refuse" },
  4: { freshYes: "ask", saidWhatChanged: "refuse", toPerson: "wait" },
  5: { nextOpenTimes: "ask", nothingBooked: "refuse" },
  6: { oneQuestion: "ask", nothingChanged: "refuse" },
};

/** The label a limit not built yet logs as its outcome. */
export const NOT_BUILT = "notBuilt";
/** The label limit 6 logs when it fails before decide's one re-read (K-09 v1 `valueFailsWords`). */
export const VALUE_FAILS_WORDS = "valueFailsWords";

const notChecked = (limit: LimitNumber): LimitResult => ({ limit, result: "notChecked", outcome: null });

/** Limits 1 to 6, none checked: what a part no limit ran for logs. */
function noneChecked(): LimitResult[] {
  return LIMIT_NUMBERS.map(notChecked);
}

/**
 * The booking a part's choice acts on, as one key (its target's business and booking: K-02 v1 `target`), or null when it
 * acts on no booking. Two parts with one key depend on each other (default 3).
 */
export function bookingOf(choice: Choice | null): string | null {
  if (choice === null) return null;
  const { businessId, bookingId } = choice.target;
  return bookingId === null ? null : JSON.stringify([businessId, bookingId]);
}

/** The verbs the limits gate (default 2). */
function isGated(part: DecidePart): part is GatedVerbPart {
  return (
    part.verb === "choose" || part.verb === "enter" || part.verb === "pass_on" || part.verb === "hand_off"
  );
}

/** The one offered choice a choose or enter names (the checks found it once), or null for another verb. */
function choiceOf(decided: Decided, part: DecidePart): Choice | null {
  if (part.verb !== "choose" && part.verb !== "enter") return null;
  const choice = decided.context.choices.find((offered) => offered.choiceId === part.choice);
  if (choice === undefined) throw new Error("the gate ran on a choice the checks did not find");
  return choice;
}

/** Each slot holds its own limit, 1 to 6 in order (limits.ts); anything else is never run. */
function checkSlots<Repo>(limits: LimitRegistry<Repo>): void {
  limits.forEach((slot, index) => {
    const expected = LIMIT_NUMBERS[index];
    if (expected !== undefined && slot.limit !== expected)
      throw new GateLimitError(expected, null, "wrongSlot");
  });
}

/** How limits 1 to 6 ended for one part. */
type PartRun =
  | { readonly status: "passed"; readonly limits: LimitResult[] }
  | { readonly status: "stopped"; readonly limits: LimitResult[]; readonly stoppedBy: LimitOutcome }
  | { readonly status: "refused"; readonly limits: LimitResult[]; readonly refusedBy: LimitNumber }
  | {
      readonly status: "valueFailsWords";
      readonly limits: LimitResult[];
      readonly stoppedBy: LimitOutcome;
      readonly fields: [string, ...string[]];
    };

/** A failed limit's outcome must be its own, with the kind its action has (K-09 v1); else the limit is at fault. */
function checkOutcome(limit: LimitNumber, part: number, outcome: LimitOutcome): void {
  if (outcome.limit !== limit) throw new GateLimitError(limit, part, "wrongLimit");
  const kinds: Readonly<Partial<Record<string, string>>> = LIMIT_ACTIONS[limit];
  if (!isLabel(outcome.action) || kinds[outcome.action] !== outcome.outcome) {
    throw new GateLimitError(limit, part, "wrongAction");
  }
}

/** The fields a failed limit names: each one the part carries, by name (K-02 v1 `field.name`), once. */
function fieldsNamed(limit: LimitNumber, gatePart: GatePart, named: readonly string[] | undefined): string[] {
  const carried = new Set(
    gatePart.part.verb === "choose" || gatePart.part.verb === "enter"
      ? gatePart.part.fields.map((field) => field.name)
      : [],
  );
  const fields = [...new Set(named ?? [])];
  if (!fields.every((field) => carried.has(field))) {
    throw new GateLimitError(limit, gatePart.index, "fieldNotCarried");
  }
  return fields;
}

/** Limits 1 to 6 on one agreed part, in order, until one fails or is not built. */
async function runLimits<Repo>(
  limits: LimitRegistry<Repo>,
  gatePart: GatePart,
  turn: GateTurn<Repo>,
): Promise<PartRun> {
  const logged = noneChecked();
  for (const slot of limits) {
    const verdict = await slot.check(gatePart, turn);
    const at = slot.limit - 1;
    switch (verdict.result) {
      case "pass":
        logged[at] = { limit: slot.limit, result: "pass", outcome: null };
        break;
      case "notChecked":
        break;
      case "notBuilt":
        logged[at] = { limit: slot.limit, result: "fail", outcome: NOT_BUILT };
        return { status: "refused", limits: logged, refusedBy: slot.limit };
      case "fail": {
        checkOutcome(slot.limit, gatePart.index, verdict.outcome);
        const fields = fieldsNamed(slot.limit, gatePart, verdict.fields);
        if (slot.limit === 6 && !turn.decide.reread) {
          const [first, ...rest] = fields;
          if (first === undefined) throw new GateLimitError(6, gatePart.index, "noFields");
          logged[at] = { limit: 6, result: "fail", outcome: VALUE_FAILS_WORDS };
          return {
            status: "valueFailsWords",
            limits: logged,
            stoppedBy: verdict.outcome,
            fields: [first, ...rest],
          };
        }
        logged[at] = { limit: slot.limit, result: "fail", outcome: verdict.outcome.action };
        return { status: "stopped", limits: logged, stoppedBy: verdict.outcome };
      }
      default:
        throw new GateLimitError(slot.limit, gatePart.index, "unknownVerdict");
    }
  }
  return { status: "passed", limits: logged };
}

/** One part's working result while the gate runs. */
interface Working {
  part: number;
  choice: Choice | null;
  choiceId: string | null;
  booking: string | null;
  result: GatedPart["result"];
  limits: LimitResult[];
  stoppedBy: LimitOutcome | null;
  refusedBy: LimitNumber | null;
  dependsOnPart: number | null;
  /** For a value that failed its words before the re-read, the fields at fault. */
  failedWords: [string, ...string[]] | null;
}

/** A part a limit stopped or refused: it stops the parts on its booking. */
const stopsOthers = (working: Working): boolean =>
  working.result === "stopped" || working.result === "refused";

/** The lowest part on `booking` that a limit stopped or refused, other than `self`; null when none. */
function stoppedOn(parts: readonly Working[], booking: string | null, self: number): number | null {
  if (booking === null) return null;
  const root = parts.find((other) => other.part !== self && other.booking === booking && stopsOthers(other));
  return root?.part ?? null;
}

/** The gate span's limits: one per limit across the parts (default 5). */
function spanLimits(parts: readonly Working[]): LimitResult[] {
  return LIMIT_NUMBERS.map((limit) => {
    const entries = parts.flatMap((part) => part.limits.filter((entry) => entry.limit === limit));
    const failed = entries.find((entry) => entry.result === "fail");
    if (failed !== undefined) return { limit, result: "fail", outcome: failed.outcome };
    if (entries.some((entry) => entry.result === "pass")) return { limit, result: "pass", outcome: null };
    return notChecked(limit);
  });
}

function gatedPart(working: Working): GatedPart {
  return {
    part: working.part,
    choiceId: working.choiceId,
    result: working.result,
    limits: working.limits,
    stoppedBy: working.stoppedBy,
    refusedBy: working.refusedBy,
    dependsOnPart: working.dependsOnPart,
  };
}

/**
 * Gates one turn: decide's output checked, then limits 1 to 6 on each agreed part (`limits`, the registry of
 * actions/src/gate/limits.ts), inside the call's business scope. A turn with no decided texts (a clock's firing, a
 * core-only turn) has no part to gate. Throws LimitNotBuiltError when a limit not built yet refused a part, and
 * GateLimitError when a limit answers outside its interface; a limit's own throw passes through. Either way the call
 * rolls back and no part passes.
 */
export async function runGate<Repo>(
  request: GateRequest,
  call: CallContext<Repo>,
  limits: LimitRegistry<Repo>,
): Promise<GateVerdict> {
  const { input } = request;
  if (input.kind !== "decided") return { verdict: "gated", parts: [] };
  const { decided } = input;
  const refusal = checkDecideOutput(decided);
  if (refusal !== null) return { verdict: "refused", error: refusal };
  checkSlots(limits);

  const turn: GateTurn<Repo> = {
    request,
    context: decided.context,
    decide: decided.decide,
    repo: call.repo,
    businessId: call.businessId,
  };
  const parts: Working[] = decided.decide.parts.map((entry, index) => {
    const choice = choiceOf(decided, entry.part);
    return {
      part: index,
      choice,
      choiceId: choice?.choiceId ?? null,
      booking: bookingOf(choice),
      result: "passed",
      limits: noneChecked(),
      stoppedBy: null,
      refusedBy: null,
      dependsOnPart: null,
      failedWords: null,
    };
  });

  for (const working of parts) {
    const entry = decided.decide.parts[working.part];
    if (entry === undefined) continue;
    const { part } = entry;
    if (entry.outcome === "oneQuestion" || part.verb === "ask") {
      working.result = "asked";
      continue;
    }
    if (!isGated(part)) {
      working.result = "noAction";
      continue;
    }
    const root = stoppedOn(parts.slice(0, working.part), working.booking, working.part);
    if (root !== null) {
      working.result = "dependsOnStopped";
      working.dependsOnPart = root;
      continue;
    }
    const run = await runLimits(limits, { index: working.part, part, choice: working.choice }, turn);
    working.limits = run.limits;
    if (run.status === "refused") {
      working.result = "refused";
      working.refusedBy = run.refusedBy;
    } else if (run.status !== "passed") {
      working.result = "stopped";
      working.stoppedBy = run.stoppedBy;
      if (run.status === "valueFailsWords") working.failedWords = run.fields;
    }
  }

  // A part on the booking of a part stopped after it stops too (default 3).
  for (const working of parts) {
    if (working.result !== "passed") continue;
    const root = stoppedOn(parts, working.booking, working.part);
    if (root !== null) {
      working.result = "dependsOnStopped";
      working.dependsOnPart = root;
    }
  }

  call.span.limits.splice(0, call.span.limits.length, ...spanLimits(parts));

  const refusedBy = [
    ...new Set(parts.flatMap((working) => (working.refusedBy === null ? [] : [working.refusedBy]))),
  ].sort((a, b) => a - b);
  if (refusedBy.length > 0) throw new LimitNotBuiltError(refusedBy, parts.map(gatedPart));

  const failedWords = parts.flatMap((working) =>
    working.failedWords === null ? [] : [{ part: working.part, fields: working.failedWords }],
  );
  const [firstFailed, ...moreFailed] = failedWords;
  if (firstFailed !== undefined) {
    const error: ValueFailsWords = { error: "valueFailsWords", parts: [firstFailed, ...moreFailed] };
    return { verdict: "refused", error };
  }
  return { verdict: "gated", parts: parts.map(gatedPart) };
}

/**
 * One gated part as gateAndCommit answers it (K-09 v1 `partResult`), once the commit has written the passed parts: a
 * passed part is `committed`, with the keys its step gave (`gives`, the commit's); every other part gives none. A part a
 * limit not built yet refused is never answered: it throws LimitNotBuiltError.
 */
export function partResultOf(part: GatedPart, gives: readonly SetupKey[] = []): PartResult {
  if (part.result === "refused") {
    throw new LimitNotBuiltError(part.refusedBy === null ? [] : [part.refusedBy], [part]);
  }
  return {
    part: part.part,
    choiceId: part.choiceId,
    result: part.result === "passed" ? "committed" : part.result,
    limits: part.limits.map((entry) => ({ ...entry })),
    stoppedBy: part.stoppedBy,
    gives: part.result === "passed" ? [...gives] : [],
    dependsOnPart: part.dependsOnPart,
  };
}
