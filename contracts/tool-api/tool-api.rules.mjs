// K-09's named rules (T-018; v1.1's givesJourneyKeys and arrivalTurn added by T-050; v1.2's givesJourneyFourKeys
// added by T-051): what an exchange states that one JSON Schema cannot check across its parts.

import { createHash } from "node:crypto";
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
 * The marker an arrival turn's hash input starts with (README default 36). A batch turn's id is the hash of its sorted
 * event ids alone (CQ-09; T-248), so an arrival turn's input, the marker and then the event id, is never a batch's, as
 * a clock turn's input is its clock row's id (K-05 v1 default 9).
 */
export const ARRIVAL_MARK = "arrival:";

/**
 * The arrival turn's id for a text's event id: the SHA-256 of the UTF-8 bytes of ARRIVAL_MARK followed by the event
 * id, in lowercase hex (README default 36). The handle actor (C-047) and QA (T-117) compute it with this function.
 */
export function arrivalTurnId(eventId) {
  return createHash("sha256").update(`${ARRIVAL_MARK}${eventId}`, "utf8").digest("hex");
}

/** A batch turn of texts that had an arrival record: its id is never one of its texts' arrival turn ids. */
function batchAfterArrival(exchange) {
  const request = exchange.request ?? {};
  const { caller = {}, turn } = request;
  const problems = [];
  if (caller.kind !== "turn" || turn === null || turn === undefined) {
    return ["a batch turn after an arrival record is called with caller.kind turn and its turn"];
  }
  if (caller.turnId !== turn.id || caller.requestId !== turn.id) {
    problems.push("a batch turn is called with caller.turnId and requestId its id");
  }
  for (const eventId of turn.eventIds ?? []) {
    if (turn.id === arrivalTurnId(eventId)) {
      problems.push(
        `the batch turn's id is ${eventId}'s arrival turn id: the two turns must never share one`,
      );
    }
  }
  const records = (request.core ?? []).filter((action) => action.call === "recordSafetyOutcome");
  if (records.length === 0) problems.push("the batch carries its texts' safety records as core actions");
  const outcome = exchange.outcome ?? {};
  if (outcome.result !== "committed" || outcome.repeated !== false || outcome.turnId !== turn.id) {
    problems.push("the batch commits under its own id, never as a repeat of the arrival turn");
  }
  for (const result of outcome.core ?? []) {
    if (result.call === "recordSafetyOutcome" && result.response?.repeated !== true) {
      problems.push(
        "a text recorded on arrival answers repeated in its batch turn (the event id is the key)",
      );
    }
  }
  return problems;
}

/**
 * arrivalTurn: the handle actor's record on arrival (recordSafetyOutcome, caller.kind actorOnArrival) commits under
 * the text's own arrival turn: its id arrivalTurnId(the text's event id), never a batch turn's; caller.turnId and
 * requestId that id; its one event id the text's, its handle the text's, its trace id the caller's (CQ-06, CQ-09;
 * K-34 v1 safety_outcomes_text_has_handle_and_turn); only a text whose read holds danger or timed out has one (a No
 * rides in the turn its text joins: README default 5); a first record gives safe and writes its hold at version 1
 * (K-34 v1 rule 2). An at-once release on arrival (releaseSafetyHold, caller.kind actorOnArrival) runs under the same
 * arrival turn's id. The batch turn the same text joins (gateAndCommit) has an id of its own, never an arrival turn's,
 * so it commits, its record answering repeated (README "The safety record on arrival").
 */
export function arrivalTurn(exchange) {
  const request = exchange.request ?? {};
  const caller = request.caller ?? {};
  if (exchange.call === "gateAndCommit") return batchAfterArrival(exchange);
  if (caller.kind !== "actorOnArrival")
    return ["arrivalTurn needs a call made by caller.kind actorOnArrival, or the batch turn after it"];
  const problems = [];
  if (caller.requestId !== caller.turnId) problems.push("caller.requestId is the arrival turn's id");
  if (!/^[0-9a-f]{64}$/.test(caller.turnId ?? "")) {
    problems.push("the arrival turn's id is a SHA-256 in lowercase hex (arrivalTurnId)");
  }
  if (exchange.call === "releaseSafetyHold") return problems;
  if (exchange.call !== "recordSafetyOutcome")
    return ["arrivalTurn applies to recordSafetyOutcome, releaseSafetyHold and the batch turn after them"];
  const { turn, safety } = request;
  if (turn?.id !== caller.turnId) problems.push("caller.turnId is the arrival turn's id");
  const expectedId = arrivalTurnId(safety?.eventId);
  if (turn?.id !== expectedId) {
    problems.push(`the arrival turn's id is arrivalTurnId(${safety?.eventId}), ${expectedId}`);
  }
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

// ---------------------------------------------------------------------------------------------------------------
// v1.2 (T-051): journey 4. Added beside the rules above, which stay as they are.

/**
 * The keys each step of journey 4 gives, as the step index prints them (A-J4.md and B-J4.md, the gives column; A-keys.md
 * and B-keys.md, section 4). A key journey 3 also gives (who_for, reach_by, times, customer) is journey 4's here only
 * at journey 4's own steps; at A3-30 and B3-08 it stays confirmBusinessBooking's (J3_STEP_GIVES, KEY_CALL).
 */
export const J4_STEP_GIVES = Object.freeze({
  "A4-81": ["service"],
  "B4-114": ["service"],
  "A4-80": ["who_for"],
  "B4-92": ["who_for"],
  "B4-77": ["place"],
  "A4-82": ["reach_by"],
  "B4-93": ["reach_by"],
  "A4-23": ["customer"],
  "B4-25": ["customer"],
  "A4-06": ["price_known"],
  "A4-12": ["price_known"],
  "B4-07": ["price_known"],
  "B4-13": ["price_known"],
  "A4-13": ["visit_fee"],
  "B4-14": ["visit_fee"],
  "B4-09": ["quote"],
  "A4-14": ["times"],
  "A4-33": ["times"],
  "A4-62": ["times"],
  "A4-68": ["times"],
  "B4-15": ["times"],
  "B4-84": ["times"],
  "B4-85": ["times"],
  "B4-89": ["times"],
  "B4-16": ["choice"],
  "A4-21": ["time_saved"],
  "B4-23": ["time_saved"],
  "A4-42": ["contact"],
  "B4-29": ["link"],
  "B4-30": ["address"],
  "A4-65": ["answers"],
  "B4-34": ["access", "answers"],
});

/**
 * The automatic steps one call's own commit passes after the step it answers, whose keys that call gives: the pick
 * and the save, both saveTime's (A4-15 then A4-21; B4-16 then B4-23).
 */
export const J4_CALL_PASSES = Object.freeze({
  "A4-15": ["A4-21"],
  "B4-16": ["B4-23"],
});

/**
 * The automatic steps a turn's walk may pass right after a step that asks (arch 03 line 191: code walks to the first
 * step that asks someone), whose keys the same commit may give (round 2: the action-layer engineer's note a, the QA
 * and eval engineer's note a): after the pick, the save, the who's-who and plan steps, the secure link and its forms
 * and approval (flow A's A4-21 to A4-42 when the AI's chat is a turn; flow B's B4-23, B4-32, B4-63 to B4-29, as
 * j4-save-time-turn.json and j4-secure-link-turn.json share one turn); after the owner's '1 Send it' or the read-back's
 * yes, the quote sent (A4-09, A4-10 to A4-12; B4-10, B4-11 to B4-13, as j4-quote-send-turn.json rides B4-10's answer).
 * A turn's part gives its step's own keys and may give those of the steps listed here; a call made alone gives only
 * its own (J4_CALL_PASSES).
 */
export const J4_WALK_PASSES = Object.freeze({
  "A4-15": ["A4-21", "A4-42"],
  "B4-16": ["B4-23", "B4-29"],
  "A4-09": ["A4-12"],
  "A4-10": ["A4-12"],
  "B4-10": ["B4-13"],
  "B4-11": ["B4-13"],
});

/** The one call that writes each key journey 4 gives (README "v1.2", "Each key's one call"; 02-contracts section 8). */
export const J4_KEY_CALL = Object.freeze({
  service: "matchService",
  who_for: "setWhoFor",
  place: "checkPlace",
  reach_by: "setReachWay",
  customer: "addCustomer",
  price_known: "setPrice",
  visit_fee: "setPrice",
  quote: "quoteFromPhotos",
  times: "showTimes",
  choice: "saveTime",
  time_saved: "saveTime",
  contact: "sendSecureLink",
  link: "sendSecureLink",
  address: "checkPlace",
  access: "saveSecurePage",
  answers: "saveSecurePage",
});

/** The keys the given steps give (J4_STEP_GIVES), each once. */
const keysOfSteps = (steps) => [...new Set(steps.flatMap((step) => J4_STEP_GIVES[step] ?? []))];

/**
 * givesJourneyFourKeys: an exchange that states a journey 4 step writes the keys that step gives, and its outcome wrote
 * exactly the stated keys (J4_STEP_GIVES). Made alone, it states exactly its step's keys with those of the automatic
 * steps its own call passes (J4_CALL_PASSES: the pick then the save), less time_saved for 'Send someone now', which
 * saves no time (B4-91: saveTime answers choice alone; README open gap 61), and its call is the one call that writes
 * each key (J4_KEY_CALL; the card's "each key written by exactly one call"). In a turn (gateAndCommit) the committed
 * parts' gives are the keys written: its step's own keys, and any of those the automatic steps its walk passes give
 * (J4_WALK_PASSES; arch 03 line 191; round 2: action-layer note a, QA and eval note a), as givesStepKeys allows.
 */
export function givesJourneyFourKeys(exchange) {
  const stated = exchange.given?.stated;
  if (stated === null || stated === undefined || stated.step === undefined) {
    return ["given.stated names no step"];
  }
  const ownKeys = J4_STEP_GIVES[stated.step] ?? [];
  const inTurn = exchange.call === "gateAndCommit";
  const passes = (inTurn ? J4_WALK_PASSES : J4_CALL_PASSES)[stated.step] ?? [];
  const passedKeys = keysOfSteps(passes);
  if (ownKeys.length === 0 && passedKeys.length === 0) {
    return [`${stated.step} is no step of journey 4 that gives a key`];
  }
  const problems = [];
  const statedKeys = [...stated.gives].sort();
  let expected;
  if (inTurn) {
    expected = statedKeys;
    for (const key of ownKeys) {
      if (!statedKeys.includes(key))
        problems.push(`${stated.step} gives ${key}, which given.stated.gives leaves out`);
    }
    for (const key of statedKeys) {
      if (!ownKeys.includes(key) && !passedKeys.includes(key)) {
        problems.push(`${key} is given neither by ${stated.step} nor by a step its walk passes`);
      }
    }
  } else {
    const sentNow = exchange.call === "saveTime" && exchange.outcome?.timing === "sentnow";
    const own = [...new Set([...ownKeys, ...passedKeys])].filter((key) => !(sentNow && key === "time_saved"));
    expected = own.sort();
    if (JSON.stringify(statedKeys) !== JSON.stringify(expected)) {
      problems.push(
        `${stated.step} gives [${expected.join(", ")}], not the stated [${stated.gives.join(", ")}]`,
      );
    }
  }
  const written = [...keysWritten(exchange)].sort();
  if (JSON.stringify(written) !== JSON.stringify(expected)) {
    problems.push(`the outcome wrote [${written.join(", ")}], not [${expected.join(", ")}]`);
  }
  if (!inTurn) {
    for (const key of written) {
      if (J4_KEY_CALL[key] !== exchange.call) {
        problems.push(
          `${key} is written by ${J4_KEY_CALL[key] ?? "no journey 4 call"}, not ${exchange.call}`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// v1.3 (T-052): journey 5. Added beside the rules above, which stay as they are.

/**
 * The keys each step of journey 5 gives, as the step index prints them (A-J5.md and B-J5.md, the gives column; A-keys.md
 * and B-keys.md, section 5): every branch of A5-04 (B5-02) gives money_before; a card saved and a deposit give
 * card_saved; a deposit gives deposit_paid; the full price gives paid_full (SPEC-master section 5, "Keys the money path
 * gives"). No other step of journey 5 gives a key.
 */
export const J5_STEP_GIVES = Object.freeze({
  "A5-05": ["money_before"],
  "A5-07": ["money_before", "card_saved"],
  "A5-13": ["money_before", "card_saved", "deposit_paid"],
  "A5-16": ["money_before", "paid_full"],
  "B5-03": ["money_before"],
  "B5-05": ["money_before", "card_saved"],
  "B5-11": ["money_before", "card_saved", "deposit_paid"],
  "B5-13": ["money_before", "paid_full"],
});

/**
 * The owner's '1 Book it' (A5-08, B5-06) books it with nothing taken (K-30 booking_details.taken 'nothing'; SPEC-master
 * 5e), A5-04's 'Nothing taken', so its commit gives that branch's key, money_before (README "v1.3" default 99); its
 * '2 Let it go' gives none and states no step. Card_saved, deposit_paid and paid_full are never owed after a booking
 * that took nothing (SPEC-master line 291).
 */
export const J5_OWNER_BOOKS = Object.freeze({
  "A5-08": "A5-05",
  "B5-06": "B5-03",
});

/**
 * The keys a step gives that, on C3's door, come from the payment's success, never from the yes (README "v1.3" default
 * 104; round 2, DL-252 ruling 2): a yes on the pay page (takeMoneyBefore yes with payBy payLink) comes before Stripe's
 * form confirms the payment, and K-14's paymentSucceeded with saveCardForLater writes the deposit's K-32 saved_cards row
 * (saved_from_payment_id), so that yes gives its step's other keys.
 */
export const J5_PAY_LINK_LATER = Object.freeze(["card_saved"]);

/** The one call that writes each key journey 5 gives (README "v1.3", "Each key's one call"; 02-contracts section 8). */
export const J5_KEY_CALL = Object.freeze({
  money_before: "takeMoneyBefore",
  card_saved: "takeMoneyBefore",
  deposit_paid: "takeMoneyBefore",
  paid_full: "takeMoneyBefore",
});

/**
 * givesJourneyFiveKeys: an exchange that states a journey 5 step states exactly the keys that step gives (J5_STEP_GIVES;
 * for the owner's '1 Book it', the 'Nothing taken' branch's: J5_OWNER_BOOKS), less, for a yes on C3's pay page, those
 * the payment's success writes (J5_PAY_LINK_LATER), and its outcome wrote exactly those keys. Made alone, its call is the
 * one call that writes each key (J5_KEY_CALL; the card's "each key written by exactly one call"). In a turn
 * (gateAndCommit) the committed parts' gives are the keys written; no automatic step of journey 5 gives a key, so a part
 * gives exactly its step's.
 */
export function givesJourneyFiveKeys(exchange) {
  const stated = exchange.given?.stated;
  if (stated === null || stated === undefined || stated.step === undefined) {
    return ["given.stated names no step"];
  }
  const keyStep = J5_OWNER_BOOKS[stated.step] ?? stated.step;
  const ownKeys = J5_STEP_GIVES[keyStep] ?? [];
  if (ownKeys.length === 0) return [`${stated.step} is no step of journey 5 that gives a key`];
  const problems = [];
  const stage = exchange.call === "takeMoneyBefore" ? exchange.request?.stage : undefined;
  const onPayPage = stage?.kind === "yes" && stage.payBy === "payLink";
  const expected = ownKeys.filter((key) => !(onPayPage && J5_PAY_LINK_LATER.includes(key))).sort();
  const statedKeys = [...stated.gives].sort();
  if (JSON.stringify(statedKeys) !== JSON.stringify(expected)) {
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
      if (J5_KEY_CALL[key] !== exchange.call) {
        problems.push(
          `${key} is written by ${J5_KEY_CALL[key] ?? "no journey 5 call"}, not ${exchange.call}`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// v1.4 (T-053): journey 6. Added beside the rules above, which stay as they are.

/**
 * The keys each step of journey 6 gives, as the step index prints them (A-J6.md and B-J6.md, the gives column; A-keys.md
 * and B-keys.md, section 6): the booking written gives booked (A6-10, B6-10), the confirmation with its new check-in
 * code gives code (A6-14, B6-13), and the pro's job row, once delivered, gives staff_told (A6-15, B6-14). No other step
 * of journey 6 gives a key.
 */
export const J6_STEP_GIVES = Object.freeze({
  "A6-10": ["booked"],
  "B6-10": ["booked"],
  "A6-14": ["code"],
  "B6-13": ["code"],
  "A6-15": ["staff_told"],
  "B6-14": ["staff_told"],
});

/**
 * The steps whose keys one call's own commit gives beside its stated step (README "v1.4", default 111): the booking
 * written then its confirmation (A6-10 then A6-14; B6-10 then B6-13), A6-12's write at a new time ("The same steps, at
 * the new time"), and A6-32's (B6-35's) 'Paid in time', which gives A6-10's booked that waited for the payment and the
 * confirmation's code.
 */
export const J6_CALL_PASSES = Object.freeze({
  "A6-10": ["A6-14"],
  "A6-12": ["A6-10", "A6-14"],
  "A6-32": ["A6-10", "A6-14"],
  "B6-10": ["B6-13"],
  "B6-35": ["B6-10", "B6-13"],
});

/**
 * In a turn (gateAndCommit), the steps a part's walk may pass right after a step that asks (arch 03 line 191), whose
 * keys the same commit may give: the owner's '1 Accept' (A6-02 to A6-03, A6-10 and A6-14), the customer's '1 Take it'
 * (A6-17), a pick of the next times (A6-11 to A6-12), and the on-call pro's '1 Take it' (B6-16 to B6-10 and B6-13).
 */
export const J6_WALK_PASSES = Object.freeze({
  "A6-02": ["A6-10", "A6-14"],
  "B6-04": ["B6-10", "B6-13"],
  "A6-17": ["A6-10", "A6-14"],
  "B6-29": ["B6-10", "B6-13"],
  "A6-11": ["A6-10", "A6-14"],
  "B6-11": ["B6-10", "B6-13"],
  "B6-16": ["B6-10", "B6-13"],
});

/** The one call that writes each key journey 6 gives (README "v1.4", "Each key's one call"; 02-contracts section 8). */
export const J6_KEY_CALL = Object.freeze({
  booked: "writeBooking",
  code: "writeBooking",
  staff_told: "recordStaffTold",
});

/** The confirmation steps, whose key code no visit gives when none has a code (nobody home: B4-105). */
const J6_CODE_STEPS = new Set(["A6-14", "B6-13"]);

/** Whether an outcome wrote visits and none of them has a check-in code (K-30 booking_visits.code_for_person_id null). */
function visitsWithoutCode(exchange) {
  const visits = exchange.outcome?.visits;
  return (
    Array.isArray(visits) && visits.length > 0 && visits.every((visit) => visit.codeForPersonId === null)
  );
}

/**
 * givesJourneySixKeys: an exchange that states a journey 6 step writes the keys that step gives (J6_STEP_GIVES), and
 * its outcome wrote exactly the stated keys. Made alone, it states exactly its step's keys with those of the steps its
 * own commit passes (J6_CALL_PASSES), less code when no visit it wrote has a code, and its call is the one call that
 * writes each key (J6_KEY_CALL; the card's "each key written by exactly one call"). In a turn (gateAndCommit) the
 * committed parts' gives are the keys written: its step's own keys, and any of those the steps its walk passes give
 * (J6_WALK_PASSES; arch 03 line 191), as givesJourneyFourKeys allows.
 */
export function givesJourneySixKeys(exchange) {
  const stated = exchange.given?.stated;
  if (stated === null || stated === undefined || stated.step === undefined) {
    return ["given.stated names no step"];
  }
  const inTurn = exchange.call === "gateAndCommit";
  const noCode = visitsWithoutCode(exchange);
  const ownKeys = J6_STEP_GIVES[stated.step] ?? [];
  const passes = ((inTurn ? J6_WALK_PASSES : J6_CALL_PASSES)[stated.step] ?? []).filter(
    (step) => !(noCode && J6_CODE_STEPS.has(step)),
  );
  const passedKeys = [...new Set(passes.flatMap((step) => J6_STEP_GIVES[step] ?? []))];
  if (ownKeys.length === 0 && passedKeys.length === 0) {
    return [`${stated.step} is no step of journey 6 that gives a key`];
  }
  const problems = [];
  const statedKeys = [...stated.gives].sort();
  let expected;
  if (inTurn) {
    expected = statedKeys;
    for (const key of ownKeys) {
      if (!statedKeys.includes(key))
        problems.push(`${stated.step} gives ${key}, which given.stated.gives leaves out`);
    }
    for (const key of statedKeys) {
      if (!ownKeys.includes(key) && !passedKeys.includes(key)) {
        problems.push(`${key} is given neither by ${stated.step} nor by a step its walk passes`);
      }
    }
  } else {
    expected = [...new Set([...ownKeys, ...passedKeys])].sort();
    if (JSON.stringify(statedKeys) !== JSON.stringify(expected)) {
      problems.push(
        `${stated.step} gives [${expected.join(", ")}], not the stated [${stated.gives.join(", ")}]`,
      );
    }
  }
  const written = [...keysWritten(exchange)].sort();
  if (JSON.stringify(written) !== JSON.stringify(expected)) {
    problems.push(`the outcome wrote [${written.join(", ")}], not [${expected.join(", ")}]`);
  }
  if (!inTurn) {
    for (const key of written) {
      if (J6_KEY_CALL[key] !== exchange.call) {
        problems.push(
          `${key} is written by ${J6_KEY_CALL[key] ?? "no journey 6 call"}, not ${exchange.call}`,
        );
      }
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
  givesJourneyFourKeys,
  givesJourneyFiveKeys,
  givesJourneySixKeys,
});
