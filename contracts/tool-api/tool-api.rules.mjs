// K-09's named rules (T-018; v1.1's givesJourneyKeys and arrivalTurn added by T-050): what an exchange states that
// one JSON Schema cannot check across its parts.
// `npm run contracts:check` runs the rule a fixtures/index.json entry names ("rule") on an exchange that has already
// passed its schema (contracts/scripts/check-fixtures.mjs). QA's contract test (T-088) and the Tool API mock (C-186)
// read the same statements. README "Named rules". Rules are only ever added: a later minor version adds a rule under a
// new name and never changes these.
//
// Each rule takes one exchange { call, given, request, outcome } and returns its problems, one line each; an empty list
// passes.

const PF_KEYS = Object.freeze([
  "pf.license",
  "pf.services",
  "pf.questions",
  "pf.safety",
  "pf.first_steps",
  "pf.visit",
  "pf.money",
  "pf.messages",
  "pf.staff",
  "pf.rules",
  "pf.edges",
]);

/**
 * The keys each step of journeys 1 and 2 gives, as the step index prints them (A-S1.md and A-S2.md, the gives column;
 * B-S1.md and B-S2.md give the same). S1-21's voice is left out: the phone-line row is out (C-236).
 */
export const STEP_GIVES = Object.freeze({
  "S1-01": ["thread"],
  "S1-02": ["kinds"],
  "S1-11": PF_KEYS,
  "S1-04": ["companies"],
  "S1-09": ["business"],
  "S1-10": ["id_checked", "mobile"],
  "S1-23": ["license"],
  "S1-61": ["license"],
  "S1-12": ["services"],
  "S1-13": ["ways", "stripe"],
  "S1-81": ["spaces"],
  "S1-21": ["booking_rules", "price_oks"],
  "S1-84": ["profile"],
  "S1-24": ["calendar"],
  "S1-27": ["stripe"],
  "S1-29": ["terms", "bill_card"],
  "S1-35": ["live"],
  "S2-02": ["added"],
  "S2-06": ["profile"],
  "S2-11": ["license_checked"],
  "S2-29": ["license_checked"],
  "S2-15": ["team"],
  "S2-27": ["on_call"],
  "S2-24": ["staff_live"],
});

/** Every key some step of journeys 1 and 2 gives. */
const ALL_KEYS = new Set(Object.values(STEP_GIVES).flat());

/** The decide result a gate exchange's request carries, or undefined for a clock's or a core-only turn. */
function decideOf(exchange) {
  const input = exchange.request?.input;
  return input?.kind === "decided" ? input.decided?.decide : undefined;
}

/**
 * Limit 6 only after decide's one Sonnet re-read (arch 02 line 119; arch 06 lines 289, 309; Q-41): a gate answer of
 * valueFailsWords needs a decide result with reread false, naming parts that went to the gate and fields those parts
 * carry; a part stopped by limit 6 needs reread true.
 */
function limit6AfterReread(exchange) {
  const problems = [];
  const decide = decideOf(exchange);
  const outcome = exchange.outcome ?? {};
  if (outcome.error === "valueFailsWords") {
    if (decide === undefined) return ["valueFailsWords needs a decided input"];
    if (decide.reread !== false)
      problems.push("valueFailsWords is answered only while decide.reread is false");
    for (const named of outcome.parts) {
      const resultPart = decide.parts[named.part];
      if (resultPart === undefined || resultPart.outcome !== "go") {
        problems.push(
          `valueFailsWords names part ${named.part}, which is not a part decide sent to the gate`,
        );
        continue;
      }
      const fieldNames = (resultPart.part.fields ?? []).map((field) => field.name);
      for (const name of named.fields) {
        if (!fieldNames.includes(name)) problems.push(`part ${named.part} has no field ${name}`);
      }
    }
  }
  if (Array.isArray(outcome.parts) && outcome.result === "committed") {
    for (const part of outcome.parts) {
      if (part.stoppedBy?.limit === 6 && decide?.reread !== true) {
        problems.push(`parts[${part.part}] is stopped by limit 6 although decide.reread is not true`);
      }
    }
  }
  return problems;
}

/**
 * statedOutcome: a gate exchange that states a limit's outcome stops exactly one part, by that limit, with that kind
 * of outcome and that action, and logs that limit as failed with that action on the part's limits (README "Limits 1 to
 * 6 at the gate"; 02-contracts K-09 "Contract test": each limit fixture gives its stated outcome). Limit 6 stops a
 * part only after decide's one re-read (limit6AfterReread).
 */
export function statedOutcome(exchange) {
  const stated = exchange.given?.stated;
  if (stated === null || stated === undefined || stated.limit === undefined) {
    return ["given.stated names no limit"];
  }
  const parts = exchange.outcome?.parts;
  if (exchange.call !== "gateAndCommit" || !Array.isArray(parts)) {
    return ["a stated outcome needs a gateAndCommit exchange that committed"];
  }
  const problems = [];
  const stopped = parts.filter((part) => part.result === "stopped");
  if (stopped.length !== 1) problems.push(`exactly one part must be stopped, not ${stopped.length}`);
  for (const part of stopped) {
    const by = part.stoppedBy;
    if (
      by === null ||
      by.limit !== stated.limit ||
      by.outcome !== stated.outcome ||
      by.action !== stated.action
    ) {
      problems.push(
        `parts[${part.part}] is stopped by ${JSON.stringify(by)}, not limit ${stated.limit} ${stated.outcome} ${stated.action}`,
      );
    }
    const logged = part.limits.find((entry) => entry.limit === stated.limit);
    if (logged === undefined || logged.result !== "fail" || logged.outcome !== stated.action) {
      problems.push(
        `parts[${part.part}].limits does not log limit ${stated.limit} as failed with ${stated.action}`,
      );
    }
  }
  return [...problems, ...limit6AfterReread(exchange)];
}

/**
 * rereadBeforeQuestion: a gate exchange on decided texts answers a value that fails its words with valueFailsWords,
 * refused before any write, while decide has not re-read, and with limit 6's outcome only after the re-read (README
 * "Limits 1 to 6 at the gate"; arch 02 line 119; arch 06 lines 289, 309; Q-41; the AI engineer's review of T-018).
 */
export function rereadBeforeQuestion(exchange) {
  if (exchange.call !== "gateAndCommit" || decideOf(exchange) === undefined) {
    return ["rereadBeforeQuestion needs a gateAndCommit exchange on decided texts"];
  }
  return limit6AfterReread(exchange);
}

/**
 * clockTurn: a clock's firing (gateAndCommit, input.kind clock) is a turn on the clock row's handle, or a firing with
 * no turn (QUESTIONS.md NQ-RT-4; K-05 v1 fireClock). With a turn: caller.kind turn, caller.turnId and caller.requestId
 * the turn's id, its one event id the clock row's id (K-05 v1 default 9), its trace id the caller's, the firing's own
 * (CQ-06). With none: caller.kind clockFiring, caller.turnId null, caller.requestId the clock row's id. A clock's turn
 * carries no text, so no safety outcome; its answer is fired, for that row and that turn, or one of the errors.
 */
export function clockTurn(exchange) {
  const request = exchange.request ?? {};
  const input = request.input;
  if (exchange.call !== "gateAndCommit" || input?.kind !== "clock") {
    return ["clockTurn needs a gateAndCommit exchange on a clock's firing"];
  }
  const problems = [];
  const { caller, turn } = request;
  if (turn === null) {
    if (caller.kind !== "clockFiring" || caller.turnId !== null) {
      problems.push("a firing with no turn is called with caller.kind clockFiring and caller.turnId null");
    }
    if (caller.requestId !== input.clockRowId) problems.push("its caller.requestId is the clock row's id");
  } else {
    if (caller.kind !== "turn" || caller.turnId !== turn.id || caller.requestId !== turn.id) {
      problems.push("a clock turn is called with caller.kind turn, and caller.turnId and requestId its id");
    }
    if (JSON.stringify(turn.eventIds) !== JSON.stringify([input.clockRowId])) {
      problems.push("a clock turn's one event id is the clock row's id (K-05 v1 default 9)");
    }
    if (turn.traceId !== caller.traceId) problems.push("a clock turn's trace id is the firing's own (CQ-06)");
  }
  if (request.core.some((action) => action.call === "recordSafetyOutcome")) {
    problems.push("a clock's turn has no text, so it carries no safety outcome");
  }
  const outcome = exchange.outcome ?? {};
  if (outcome.result === "committed") problems.push("a clock's firing answers fired, never committed");
  if (outcome.result === "fired") {
    if (outcome.clockRowId !== input.clockRowId) problems.push("fired names another clock row");
    if (outcome.turnId !== (turn === null ? null : turn.id)) problems.push("fired names another turn");
  }
  return problems;
}

/** The keys an exchange's outcome wrote: saveSetupStep's gives, or the gives of a commit's committed parts. */
function keysWritten(exchange) {
  const outcome = exchange.outcome ?? {};
  if (Array.isArray(outcome.gives)) return outcome.gives;
  if (Array.isArray(outcome.parts)) {
    return outcome.parts.filter((part) => part.result === "committed").flatMap((part) => part.gives);
  }
  return [];
}

/**
 * givesStepKeys: an exchange that states a step writes every key that step gives (A-keys.md, B-keys.md), and the keys
 * its outcome wrote are exactly the stated ones; a stated key beyond the step's own is one an automatic step its walk
 * passes gives (arch 03 line 191: code walks to the first step that asks someone), so it must be a key of journeys 1
 * and 2 (02-contracts K-09: every journey 1 and 2 call writes the key its step gives).
 */
export function givesStepKeys(exchange) {
  const stated = exchange.given?.stated;
  if (stated === null || stated === undefined || stated.step === undefined) {
    return ["given.stated names no step"];
  }
  const own = STEP_GIVES[stated.step] ?? [];
  const problems = [];
  for (const key of own) {
    if (!stated.gives.includes(key))
      problems.push(`${stated.step} gives ${key}, which given.stated.gives leaves out`);
  }
  for (const key of stated.gives) {
    if (!ALL_KEYS.has(key)) problems.push(`${key} is no key a step of journeys 1 and 2 gives`);
  }
  const written = [...keysWritten(exchange)].sort();
  const expected = [...stated.gives].sort();
  if (JSON.stringify(written) !== JSON.stringify(expected)) {
    problems.push(`the outcome wrote [${written.join(", ")}], not the stated [${expected.join(", ")}]`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// v1.1 (T-050): journey 3. Added beside the rules above, which stay as they are.

/**
 * The keys each step of journey 3 gives, as the step index prints them (A-J3.md and B-J3.md, the gives column; the
 * call-only steps A3-06 and A3-14 are out: C-231). In flow B the door's request is B3-01's (B3-02 and B3-07 give none).
 */
export const J3_STEP_GIVES = Object.freeze({
  "A3-01": ["request"],
  "A3-02": ["request"],
  "A3-04": ["request"],
  "A3-19": ["request"],
  "A3-22": ["safe"],
  "A3-30": ["who_for", "reach_by", "times", "customer"],
  "B3-01": ["request"],
  "B3-17": ["safe"],
  "B3-08": ["who_for", "reach_by", "times", "customer"],
});

/**
 * The one call that writes each key journey 3 gives (02-contracts section 8 names each key's home; README "v1.1",
 * "Each key's one call"). In a turn the same write is the chosen choice's effect inside gateAndCommit, whose committed
 * part names the keys (partResult.gives).
 */
export const KEY_CALL = Object.freeze({
  request: "openRequest",
  safe: "recordSafetyOutcome",
  who_for: "confirmBusinessBooking",
  reach_by: "confirmBusinessBooking",
  times: "confirmBusinessBooking",
  customer: "confirmBusinessBooking",
});

/**
 * givesJourneyKeys: an exchange that states a journey 3 step writes exactly the keys that step gives (J3_STEP_GIVES),
 * its outcome wrote exactly the stated keys, and, made alone, its call is the one call that writes each of them
 * (KEY_CALL; the card's "each key written by exactly one call").
 */
export function givesJourneyKeys(exchange) {
  const stated = exchange.given?.stated;
  if (stated === null || stated === undefined || stated.step === undefined) {
    return ["given.stated names no step"];
  }
  const own = J3_STEP_GIVES[stated.step];
  if (own === undefined) return [`${stated.step} is no step of journey 3 that gives a key`];
  const problems = [];
  const expected = [...own].sort();
  if (JSON.stringify([...stated.gives].sort()) !== JSON.stringify(expected)) {
    problems.push(
      `${stated.step} gives [${expected.join(", ")}], not the stated [${stated.gives.join(", ")}]`,
    );
  }
  const written = [...keysWritten(exchange)].sort();
  if (JSON.stringify(written) !== JSON.stringify(expected)) {
    problems.push(`the outcome wrote [${written.join(", ")}], not [${expected.join(", ")}]`);
  }
  if (exchange.call !== "gateAndCommit") {
    for (const key of written) {
      if (KEY_CALL[key] !== exchange.call) {
        problems.push(`${key} is written by ${KEY_CALL[key] ?? "no journey 3 call"}, not ${exchange.call}`);
      }
    }
  }
  return problems;
}

/** Whether a K-02 safety result holds danger (any outcome but No) or timed out (arch 02 line 111). */
const dangerOrTimeout = (safety) =>
  safety?.timedOut === true || (safety?.outcomes ?? []).some((outcome) => outcome !== "No");

/**
 * arrivalTurn: the handle actor's record on arrival (recordSafetyOutcome, caller.kind actorOnArrival) commits under
 * the text's own arrival turn: caller.turnId and requestId the turn's id, its one event id the text's, its handle the
 * text's, its trace id the caller's (CQ-06, CQ-09; K-34 v1 safety_outcomes_text_has_handle_and_turn); only a text
 * whose read holds danger or timed out has one (a No rides in the turn its text joins: README default 5); a first
 * record gives safe and writes its hold at version 1 (K-34 v1 rule 2). An at-once release on arrival
 * (releaseSafetyHold, caller.kind actorOnArrival) runs under the same arrival turn's id.
 */
export function arrivalTurn(exchange) {
  const request = exchange.request ?? {};
  const caller = request.caller ?? {};
  if (caller.kind !== "actorOnArrival")
    return ["arrivalTurn needs a call made by caller.kind actorOnArrival"];
  const problems = [];
  if (caller.requestId !== caller.turnId) problems.push("caller.requestId is the arrival turn's id");
  if (exchange.call === "releaseSafetyHold") return problems;
  if (exchange.call !== "recordSafetyOutcome")
    return ["arrivalTurn applies to recordSafetyOutcome and releaseSafetyHold"];
  const { turn, safety } = request;
  if (turn?.id !== caller.turnId) problems.push("caller.turnId is the arrival turn's id");
  if (JSON.stringify(turn?.eventIds) !== JSON.stringify([safety?.eventId])) {
    problems.push("the arrival turn's one event id is the text's own");
  }
  if (turn?.handleId !== request.handleId) problems.push("the arrival turn's handle is the text's");
  if (turn?.traceId !== caller.traceId)
    problems.push("the arrival turn's trace id is the text's own (CQ-06)");
  if (safety?.source !== "text") problems.push("only a text arrives at the handle actor");
  if (!dangerOrTimeout(safety)) {
    problems.push(
      "a read of No has no arrival record: it rides in the turn its text joins (README default 5)",
    );
  }
  const outcome = exchange.outcome ?? {};
  if (outcome.outcomeId !== undefined) {
    if (JSON.stringify(outcome.gives) !== JSON.stringify(["safe"])) problems.push("the record gives safe");
    if (outcome.repeated === false && outcome.hold !== null && outcome.hold?.version !== 1) {
      problems.push("a hold the record wrote is at version 1 (K-34 v1 rule 2)");
    }
  }
  return problems;
}

export const rules = Object.freeze({
  statedOutcome,
  givesStepKeys,
  rereadBeforeQuestion,
  clockTurn,
  givesJourneyKeys,
  arrivalTurn,
});
