// gateAndCommit (C-087, T-305; K-09 v1; arch 02 line 121: "The gate checks limits 1 to 6 (section 06). One transaction
// writes state, one outbox row per message, clock rows and the event log, under the turn id"; arch 10 line 508: "The commit
// is unique on the turn id"; arch 04 line 223: "Gate and commit ≤ 300 ms"). For one turn, in this order:
//
//   1. the turn: a clock's firing and the planner's verbs are not built here (fail closed: notBuilt); the call must be the
//      turn's own, under its turn id and trace (hold.ts checkTurn; CQ-69: the id is the lease's, never made here);
//   2. the bundle: a context or decide result naming another bundle than the turn's pin answers bundleMismatch, before
//      any limit runs (CQ-72's default 2);
//   3. the holds: what is open on the handle is read now, at commit time (the safety holds and the turn's unread texts);
//      the turn's core actions run in order, each handed what is open in force (a safety outcome's hold binds what
//      follows it); a part commits only if every open hold lets it through and, unless it only protects, no text is
//      unread; every other part is held back before the gate (hold.ts; CQ-65 with its DL-127 and DL-128 addenda);
//   4. the gate (T-298): decide's output checked, then limits 1 to 6 on each part the holds let through; a refusal of the
//      whole call (decideRefused, valueFailsWords) comes back as it is, and a limit not built yet throws (notBuilt);
//   5. one question first: a passed part on the booking of a part decide ended in one question waits (CQ-73's default);
//   6. the writes: each core action's (runCore), then each passed part's (writesOf), in decide's order; a part the gate
//      stopped, held or asked writes no row of its own. A unit's writes carry its own clock rows (UnitWrites.clocks: a
//      threat's pause call-offs, T-319's escalations; T-1156), which the commit writes with the rest. Then, from K-09
//      v1.12 (T-1505; ask-again.ts), a turn whose parts decide ended in one question, with no part passed and exactly one
//      open question in its context, sends that question again once: one unit with no part answer, the quick reply
//      default 192 states and K-05 v1.21's raise of the question's ask count, read and checked as default 192 says, and
//      only where the binding hands in the question read (CommitDeps.askAgain); in every other case nothing (default 198);
//   7. one K-05 commitTurn request under the turn id (build.ts), sent once, asking K-05 v1.17 to name every phones row it
//      answers by its handle id (answerPhoneRowsBy: build.ts default 9; T-1419); K-05 v1.21's, with its one raise, when
//      the turn asks a question again (build.ts default 10), whose wrongState for that question, not live, refuses the
//      turn as wrongState does (fail closed; K-05 v1.21 default 193). A repeated turn id returns the first
//      commit and writes nothing (K-05 v1 item 1). A version or reservation conflict reloads once and gates again (arch 06
//      line 305; K-09 v1 gateAndCommit.request), its request built again from the turn's own reads, never from the rows
//      the answer named (an answered phones row id is a name, never a key: K-05 v1.17 item 71.4); a second one fails
//      closed (stillChanged, naming the rows the answer named: a phones row by its handle id). An answer that still names
//      a phones row by its number fails closed, naming no id (default 10). A parked turn, a database rule and a transient
//      failure come back as K-09's own errors;
//   8. the answer: each part as K-09 v1 partResult (partResultOf; held and waiting parts as below), the core results, what
//      K-05 wrote (`written` without the core actions' rows: default 9), the effect rows and the questions opened and
//      closed; the call's span keeps every row written (K-08 v1 rowRef: tables and ids, never a value; a phones row by
//      its handle id, as K-05 v1.17 answers it, never by its number).
//
// Nothing here logs; what it returns or throws names parts, limits, faults and row ids, never a quote's or a value's words
// (K-08 v1 README line 75).
//
// Defaults used (for ops/QUESTIONS.md), beside build.ts's and hold.ts's:
//   5. A part the holds keep back is answered `held`, its limits notChecked: no limit ran for it (K-09 v1 valueFailsWords).
//   6. A passed part that waits for the one question on its booking (CQ-73) is answered `asked` (K-09 v1 partResult: decide
//      ended it in one question; nothing changed), with the limits it passed.
//   7. A repeat answers what this run gated for each part, with nothing written: written as K-05 returns it (no rows,
//      the first commit's outbox rows), and no effects or questions, since the repeat's body may differ from the first's
//      (K-05 v1: "whatever the repeat's body"). The caller reads `repeated` first: no part of a repeat committed anything
//      new, and the turn's rows are the first commit's.
//   8. Only the parts the gate passed write. The rows a stopped part's outcome writes (a limit's question, read-back or
//      code: K-09 v1 limitNOutcome) are each limit's own (T-299 to T-304) and need a port of their own, not built here.
//   9. `written` lists the rows the walk and the parts wrote, as commit-s1-01.json's outcome does (K-09 v1.5 default 134;
//      T-1194, DL-376): a row a core action's writes name (build.ts rowsNamedBy) is left out, its response naming it
//      instead (the safety record's outcomeId and hold), although the one K-05 request writes it all the same. So are a
//      core action's own clock rows (a threat's pause call-offs: build.ts default 8), which the safety record's response
//      does not name; the call's span keeps them. Kept whole:
//      `outboxRows` (a core action's line among them, as K-09 v1 stop-recorded.json lists its stop reply; the actor leaves
//      a fixed line's row out of what it composes itself), `promoted` and the call's span (every row the call wrote).
//      A core action's phones row is kept in `written` too (T-1419; the architect's ruling on CQ-342, item 4; K-05 v1.17
//      README, its T-1419 line): the request names it by its number, the key it is written by, and so does rowsNamedBy,
//      while K-05 v1.17 answers it by its handle id, as every turn's request asks (build.ts default 9). So writtenOf's
//      filter never matches it, and `written` lists it as phones/<handle id>, exactly as K-09 v1 stop-recorded.json lists
//      a STOP's phone (phones/handle-ben, version 4): the frozen fixture wins over this default for that row.
//  10. Fail closed on a phones row named by its number (T-1419 round 2; the lead's ruling on its open question 1, DL-893):
//      every request asks for handle ids, so an answer that names a phones row by an id K-08 v1's safeId refuses (K-05
//      v1.17 phoneRowByHandleId: a number in any form, an address or words) comes from a producer that ignores the field,
//      and none of it reaches the span, K-09's answer or an error message. A versionChanged naming one refuses the turn
//      at once as stillChanged with no ids and no reload: it is the turn's refusal of a version conflict, and K-05 wrote
//      nothing. A committed answer naming one, a repeat's among them, throws a TypeError with a fixed message naming no
//      id (PHONE_ROW_BY_NUMBER) before the span is written, as build.ts default 7 throws for a clock row not in K-05's
//      form. It is no CommitRefusedError, whose message says nothing was written: K-05's commit is its own transaction
//      (pg/commit-turn.ts), which the call's rollback does not undo, and a rerun of the turn gets K-05's repeat, which
//      names no phones row (K-05 v1.17 default 151). CommitFault (errors.ts, outside this card) has no fault for it yet
//      (a follow-up: phoneRowByNumber, with a message of its own). reservationLost and wrongState name no phones row
//      (K-05 v1.17 commitTurn.exchange), and waitingChat never leaves the commit (K-09 v1 open gap 22).

import {
  partResultOf,
  runGate,
  type Choice,
  type Decided,
  type DecidePart,
  type GatedPart,
  type GatedVerbPart,
  type Limit,
  type LimitNumber,
  type LimitRegistry,
} from "../gate/framework";
import { LIMITS } from "../gate/limits";
import type { CallContext, Handler } from "../tool-api";
import { isLabel } from "../../../runtime/src/trace";
import type { RowRef as SpanRowRef } from "../../../runtime/src/trace/types";
import {
  buildCommitRequest,
  effectView,
  k05TurnRow,
  rowsNamedBy,
  type Answer,
  type CommitUnit,
  type RowName,
  type TurnActor,
  type TurnCommitRequest,
} from "./build";
import { askAgainUnit } from "./ask-again";
import { CommitNotBuiltError, CommitRefusedError } from "./errors";
import { askedBookings, bookingKey, bundleMismatchOf, checkTurn, choiceOf, heldParts } from "./hold";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnContext,
  CommitTurnResponse,
  Committed,
  CoreRun,
  GateAndCommitAnswer,
  GateAndCommitRequest,
  OpenHolds,
  PartResult,
  PassedPart,
  RowRef,
  SafetyHold,
  TurnRow,
  UnitWrites,
} from "./types";

/** Runs of the gate and commit: once, then once more after a version or reservation conflict (arch 06 line 305). */
export const GATE_RUNS = 2;

/** Every port of the commit not built yet: each throws CommitNotBuiltError, so the call answers notBuilt (fail closed). */
export function notBuiltPorts<Repo = unknown>(): CommitPorts<Repo> {
  return {
    commitTurn: () => Promise.reject(new CommitNotBuiltError("commitTurn")),
    writesOf: () => Promise.reject(new CommitNotBuiltError("writesOf")),
    runCore: () => Promise.reject(new CommitNotBuiltError("runCore")),
    openHolds: () => Promise.reject(new CommitNotBuiltError("openHolds")),
  };
}

const copy = <T>(value: T): T => structuredClone(value);

/** The turn row this call commits, once the call is checked to be the turn's own (step 1). */
function turnRowOf(request: GateAndCommitRequest): TurnRow {
  const { input } = request;
  if (input.kind === "clock") throw new CommitNotBuiltError("clockFiring");
  if (input.kind === "decided" && input.planner !== null) throw new CommitNotBuiltError("plannerVerbs");
  const turn = request.turn;
  if (turn === null) throw new CommitRefusedError("callerNotTurn");
  checkTurn(request, turn);
  return k05TurnRow(turn);
}

/**
 * Limits 1 to 6 as the gate runs them for this turn: a part the holds keep back is never checked (each slot answers
 * notChecked for it), so it is held, not gated; every other part takes its limits as they are. The slots stay in order.
 */
export function holdingBack<Repo>(
  limits: LimitRegistry<Repo>,
  held: ReadonlySet<number>,
): LimitRegistry<Repo> {
  if (held.size === 0) return limits;
  const slot = <N extends LimitNumber>(limit: Limit<N, Repo>): Limit<N, Repo> => ({
    limit: limit.limit,
    check: (part, turn) =>
      held.has(part.index) ? Promise.resolve({ result: "notChecked" } as const) : limit.check(part, turn),
  });
  const [one, two, three, four, five, six] = limits;
  return [slot(one), slot(two), slot(three), slot(four), slot(five), slot(six)];
}

/** The hold a core action opens: a safety outcome's (K-09 v1 recordSafetyOutcome.response.hold), or null. */
function holdOpenedBy({ result }: CoreRun): SafetyHold | null {
  if (result.call !== "recordSafetyOutcome" || result.response === null) return null;
  return result.response.hold;
}

/**
 * The turn's core actions, run in the request's order, each handed what is open in force: the holds open on the handle
 * and those the core actions before it opened, and the turn's unread texts. Returns the runs and what is open after them.
 */
async function runCoreActions<Repo>(
  ports: CommitPorts<Repo>,
  context: CommitTurnContext<Repo>,
  stored: OpenHolds,
): Promise<{ runs: CoreRun[]; open: OpenHolds }> {
  const holds: SafetyHold[] = [...stored.holds];
  const unreadEventIds = [...stored.unreadEventIds];
  const runs: CoreRun[] = [];
  for (const action of context.request.core) {
    const run = await ports.runCore(action, context, copy({ holds, unreadEventIds }));
    runs.push(run);
    const opened = holdOpenedBy(run);
    if (opened !== null) holds.push(opened);
  }
  return { runs, open: { holds, unreadEventIds } };
}

const GATED_VERBS: readonly string[] = ["choose", "enter", "pass_on", "hand_off"];

function isGatedVerb(part: DecidePart): part is GatedVerbPart {
  return GATED_VERBS.includes(part.verb);
}

/** A part the gate passed, as writesOf reads it. */
function passedPart(decided: Decided, gated: GatedPart): PassedPart {
  const entry = decided.decide.parts[gated.part];
  if (entry === undefined || !isGatedVerb(entry.part)) throw new CommitRefusedError("partNotGated");
  return { index: gated.part, part: entry.part, choice: choiceOf(decided, entry.part) };
}

/** The text that carries a part's quote (the gate's checks found it there), else the turn's first text. */
function textOf(decided: Decided, quote: string): Decided["context"]["texts"][number] {
  const { texts } = decided.context;
  return texts.find((text) => text.words.includes(quote)) ?? texts[0];
}

/**
 * The answer a passed choose gave to an open question sent to this handle (an option of it: K-02 v1 choice kind option),
 * with the option its writes close the question with; null for any other part (a hub case, a door, an any-time row).
 */
function answerOf(decided: Decided, passed: PassedPart, writes: UnitWrites): Answer | null {
  const { part, choice } = passed;
  if (part.verb !== "choose" || choice?.kind !== "option") return null;
  const questionId: Choice["question"] = choice.question;
  const asked = decided.context.openQuestions.some((question) => question.openQuestionId === questionId);
  if (questionId === null || !asked) return null;
  const close = writes.closes.find((each) => each.id === questionId && each.status === "answered");
  const eventId = textOf(decided, part.quote).eventId;
  return { openQuestionId: questionId, optionId: close?.answeredOptionId ?? null, eventId };
}

/** The person the turn acts for and their roles (K-02 v1 writer), for the entries of their own acts. */
function actorOf(request: GateAndCommitRequest): TurnActor {
  const personId = request.caller.personId;
  const people = request.input.kind === "decided" ? request.input.decided.context.writer.people : [];
  const person = people.find((each) => each.personId === personId);
  return {
    personId,
    roleAt: (businessId) => person?.roles.find((role) => role.businessId === businessId)?.role ?? null,
  };
}

/** The zone the turn's texts were read in (build.ts default 4). */
function zoneOf(request: GateAndCommitRequest): string | null {
  return request.input.kind === "decided" ? request.input.decided.context.texts[0].sentAt.zone : null;
}

/** A part the holds kept back (default 5): no limit ran for it, and it depends on nothing. */
function heldResult(gated: GatedPart): PartResult {
  const result = partResultOf({ ...gated, result: "noAction", stoppedBy: null, dependsOnPart: null });
  return { ...result, result: "held" };
}

/** A passed part that waits for the one question on its booking (default 6), with the limits it passed. */
function waitingResult(gated: GatedPart): PartResult {
  return partResultOf({ ...gated, result: "asked" });
}

const rowKey = (row: RowName): string => JSON.stringify([row.table, row.rowId]);

/**
 * The rows K-05 wrote that `written` lists (default 9): every one but the rows the turn's core actions' writes name, which
 * their responses name instead (K-09 v1.5 default 134). They are written all the same, in the same K-05 request. A core
 * action's phones row is not filtered: rowsNamedBy names it by its number, K-05 v1.17 answers it by its handle id
 * (default 9's T-1419 note), so it stays, named by its handle id.
 */
function writtenOf(rows: readonly RowRef[], core: readonly CoreRun[]): RowRef[] {
  const coreRows = new Set(core.flatMap((run) => rowsNamedBy(run.writes)).map(rowKey));
  return rows.filter((row) => !coreRows.has(rowKey(row))).map(copy);
}

/** The answer of a committed turn (step 8), from K-05's answer and the request it answered. */
function committedOf(
  answer: CommitTurnResponse,
  request: TurnCommitRequest,
  parts: readonly PartResult[],
  core: readonly CoreRun[],
): Committed {
  const fresh = !answer.repeated;
  const { written, outboxRows, promoted } = answer.committed;
  const effects = fresh
    ? (request.writes.effects?.write ?? []).map((effect) => {
        const view = effectView(effect);
        return { effectId: view.effectId, kind: view.kind };
      })
    : [];
  return {
    result: "committed",
    turnId: answer.turnId,
    committedAt: answer.committedAt,
    repeated: answer.repeated,
    parts: [...parts],
    planner: null,
    core: core.map((run) => copy(run.result)),
    // K-09 v1 answers K-05 v1's commitResult, without K-05 v1.1's waitingChat (K-09 v1 open gap 22), and `written` without
    // the core actions' rows (default 9).
    written: { written: writtenOf(written, core), outboxRows: copy(outboxRows), promoted: copy(promoted) },
    effects,
    openQuestions: fresh
      ? {
          opened: request.writes.openQuestions.open.map((question) => question.id),
          closed: request.writes.openQuestions.close.map((close) => close.id),
        }
      : { opened: [], closed: [] },
  };
}

/**
 * The rows a commit wrote, for its span: tables and ids only (K-08 v1 rowRef), as K-05 v1.17 answered them, so a phones
 * row by its handle id (the request asks: build.ts default 9), never by its number.
 */
function spanRowsOf(answer: CommitTurnResponse): SpanRowRef[] {
  return [
    ...answer.committed.written.map((row) => ({ table: row.table, id: row.rowId })),
    ...answer.committed.outboxRows.map((row) => ({ table: "outbox_rows", id: row.id })),
  ];
}

/**
 * Whether K-05's answer names a phones row by an id K-08 v1's safeId refuses: a number in any form (a +, a run of seven or
 * more digits and phone punctuation), an address or words. Every request asks for a phones row's handle id (build.ts
 * default 9), which K-05 v1.17 answers as a K-08 v1 handleRef, never in phoneNumber's shape (phoneRowByHandleId); a
 * producer that ignores the field answers the number, as v1.16 does, and the commit fails closed on it (default 10).
 */
function namesPhoneByNumber(rows: readonly { readonly table: string; readonly rowId: string }[]): boolean {
  return rows.some((row) => row.table === "phones" && !isLabel(row.rowId));
}

/**
 * The message of the TypeError a committed answer that names a phones row by its number throws (default 10): no id and
 * no value, and never "nothing was written", since K-05's commit is its own transaction (pg/commit-turn.ts).
 */
export const PHONE_ROW_BY_NUMBER =
  "gateAndCommit: K-05 answered a phones row by its number, not by the handle id the request asked for; the answer is refused";

type Ran =
  | { readonly kind: "answer"; readonly answer: GateAndCommitAnswer }
  | { readonly kind: "conflict"; readonly rows: string[] };

/** Steps 3 to 8, once. */
async function gateAndCommitOnce<Repo>(
  request: GateAndCommitRequest,
  turn: TurnRow,
  call: CallContext<Repo>,
  deps: CommitDeps<Repo>,
): Promise<Ran> {
  const { ports } = deps;
  const context: CommitTurnContext<Repo> = { request, turn, repo: call.repo, businessId: call.businessId };

  const stored = await ports.openHolds(context);
  const { runs: core, open } = await runCoreActions(ports, context, stored);
  const held = heldParts(request, open);

  // The gate gets its own copy: a limit reads the turn, and what it reads cannot change what is committed.
  const verdict = await runGate(copy(request), call, holdingBack(deps.limits, held));
  if (verdict.verdict === "refused") return { kind: "answer", answer: verdict.error };

  const decided = request.input.kind === "decided" ? request.input.decided : null;
  const waiting = decided === null ? new Set<string>() : askedBookings(decided);
  const units: CommitUnit[] = core.map((run) => ({ writes: run.writes, answer: null }));
  const parts: PartResult[] = [];
  for (const gated of verdict.parts) {
    if (held.has(gated.part)) {
      parts.push(heldResult(gated));
      continue;
    }
    if (gated.result !== "passed" || decided === null) {
      parts.push(partResultOf(gated));
      continue;
    }
    const passed = passedPart(decided, gated);
    const booking = passed.choice === null ? null : bookingKey(passed.choice.target);
    if (booking !== null && waiting.has(booking)) {
      parts.push(waitingResult(gated));
      continue;
    }
    const writes = await ports.writesOf(passed, context, copy(open));
    units.push({ writes, answer: answerOf(decided, passed, writes) });
    parts.push(partResultOf(gated, writes.gives));
  }

  // An asked turn's one row: its one open question sent again, with its ask count raised (K-09 v1.12; ask-again.ts).
  const again = await askAgainUnit(deps.askAgain, {
    context,
    gated: verdict.parts,
    held,
    core,
    open: copy(open),
  });
  if (again !== null) units.push(again);

  const commitRequest = buildCommitRequest({
    turn,
    zone: zoneOf(request),
    businessId: call.businessId,
    actor: actorOf(request),
    units,
  });
  const answer = await ports.commitTurn(commitRequest, call);
  if ("error" in answer) {
    switch (answer.error) {
      // The rows that changed, by name only (a phones row by its handle id: the request asks), for stillChanged's
      // message; the reload reads the turn again and never puts a row named here into its request. A phones row named
      // by its number refuses the turn at once, naming no row, with no reload (default 10).
      case "versionChanged":
        if (namesPhoneByNumber(answer.changed)) throw new CommitRefusedError("stillChanged");
        return { kind: "conflict", rows: answer.changed.map((row) => row.rowId) };
      case "reservationLost":
        return { kind: "conflict", rows: answer.reservations.map((row) => row.id) };
      case "wrongState":
        throw new CommitRefusedError("wrongState", [answer.rowId]);
      default:
        return { kind: "answer", answer };
    }
  }
  // A phones row named by its number, a repeat's too, never reaches the span or K-09's answer (default 10).
  if (namesPhoneByNumber(answer.committed.written)) throw new TypeError(PHONE_ROW_BY_NUMBER);
  // The span keeps the rows this call wrote: none on a repeat.
  if (!answer.repeated) call.span.rows.splice(0, call.span.rows.length, ...spanRowsOf(answer));
  return { kind: "answer", answer: committedOf(answer, commitRequest, parts, core) };
}

/**
 * gateAndCommit for one turn (K-09 v1), inside the call's business scope: the gate, then one K-05 commit of what may go,
 * under the turn id. Answers committed (a repeat with `repeated` true), or one of K-09 v1's errors with nothing written.
 * Throws when it must fail closed: CommitNotBuiltError and the gate's LimitNotBuiltError (notBuilt), CommitRefusedError,
 * and a TypeError when K-05's committed answer names a phones row by its number (PHONE_ROW_BY_NUMBER; default 10).
 */
export async function gateAndCommit<Repo>(
  request: GateAndCommitRequest,
  call: CallContext<Repo>,
  deps: CommitDeps<Repo>,
): Promise<GateAndCommitAnswer> {
  const turn = turnRowOf(request);
  const mismatch = bundleMismatchOf(request, turn);
  if (mismatch !== null) return mismatch;
  let changed: readonly string[] = [];
  for (let run = 0; run < GATE_RUNS; run += 1) {
    const ran = await gateAndCommitOnce(request, turn, call, deps);
    if (ran.kind === "answer") return ran.answer;
    changed = ran.rows;
  }
  throw new CommitRefusedError("stillChanged", changed);
}

/** gateAndCommit as the Tool API base's handler (T-290): `createToolApi({ handlers: { gateAndCommit: ... } })`. */
export function gateAndCommitHandler<Repo>(deps: CommitDeps<Repo>): Handler<"gateAndCommit", Repo> {
  return (request, context) => gateAndCommit(request, context, deps);
}

/**
 * What the Worker runs today: the registry of limits 1 to 6 (../gate/limits.ts, each the fail-closed stub until its task
 * lands) and no port built. Every turn answers notBuilt and nothing is written, until each lands.
 */
export function defaultCommitDeps<Repo = unknown>(): CommitDeps<Repo> {
  return { limits: LIMITS, ports: notBuiltPorts<Repo>() };
}
