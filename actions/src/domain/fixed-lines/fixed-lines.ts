// sendFixedLine (T-1414; K-09 v1 sendFixedLine; C-052's HELP; the CQ-335 ruling's NEW-2, DL-864; DL-871): a fixed line
// sent word for word (arch 07 line 361), as one outbox row in the turn's one commit. In a turn it is the guard's HELP
// reply (RULES 7.6: "HELP gets Rosie's name and number and how to stop"): each HELP text its own sendFixedLine of
// helpReply, send class quick_reply, to the turn's own handle, its caller naming no business
// (runtime/src/guard/replies/replies.ts actionFor).
//
//   - The row: one outbox row of the request's send class to recipientHandleId, built by T-307's outboxRows the way
//     recordStopOrStart builds the stop reply (domain/flags/stop-start.ts replyRow): back on the handle the text came
//     from, with no business (Rosie's own line, for every business: K-09 README default 6; words.ts), no booking, no
//     question and no versions read. It holds no words: the replies write the line's words into it after the commit
//     (K-05 v1 writePlan, its final parts naming the line: replies.ts fixedLinePlan). K-05 v1 outboxRowNew has no column
//     for the fixed line (K-09 v1.6 open gap 128), so the line rides in the call's request, and its answer names the row.
//   - A stopped phone answers phoneStopped and nothing is written, whatever the send class (RULES 7.2; K-09
//     sendFixedLine.errors: "only stop replies and safety lines go", and the outage line goes "never to a stopped
//     number"): this call sends neither a stop reply nor a safety line. The flag is read through the wiring's port
//     alone (CoreDeps.flags.messagesReader, on the side a phone's one row shows on: DL-864), never through a default
//     reader on the call's transaction: with no reader given, the call is not built (NotBuiltError).
//   - Once per text: the caller's turn is the key (K-09 v1: "once per text (the caller's turn or request id); a repeat
//     answers repeated"), with the fixed line and the recipient (DL-871). The row's id is made from the key, so the turn
//     run again builds the same row, which K-05's commit, unique on the turn id, writes once. Two actions with one key in
//     one commit (two HELP texts in one keyword turn) write one row: the first in the request's order writes it, and each
//     later one answers {outboxRowId: the first's, repeated: true} and writes nothing, so the commit never holds one row
//     id twice (commit/build.ts checkUnits would refuse the whole turn as idTwice, a STOP beside it too).
//   - A call made alone answers notBuilt (QUESTIONS.md CQ-44's default: K-05 has no commit with no turn, and an outbox
//     row needs its turn: K-04 outbox_rows.turn_id is not null), reading nothing.
//
// Nothing here logs; what it answers or throws carries ids and labels, never a number, an address or anyone's words.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The one line this call sends in a turn is HELP's reply (helpReply), in send class quick_reply (K-09
//      sendFixedLine.request.sendClass: "quick_reply for a guard reply in its turn"; README default 6), its row's entry
//      under S13-32 (RULES 7.6 sits in RULES 7, "STOP (S13-32)"; K-01's helpReply names S13-32). The outage line goes
//      alone (runtime/src/outage: a job's call, notBuilt by CQ-44), and the PostgreSQL-down line is the actor's, written
//      on return. Any other line in a turn, HELP's in any other send class (a safety row would pass a STOP in the same
//      commit: limit 8 sends every safety row to a stopped phone, and the stopped flag's invariant lets it through), and
//      any request carrying an actor's send (sentByActor: T-269's and T-270's record on return) is not built here (runCore
//      answers notBuilt, noService): no source sends it in a turn, and nothing here records an actor's send.
//   2. In a turn the line answers the turn's own handle (K-09 sendFixedLine.request.sendClass: "a guard reply in its
//      turn"; Q-15: a reply in the same turn): a request for any other recipient is refused before anything is read
//      (FixedLineRefusedError notTheTurnsHandle, which K-09 has no answer for, so the turn fails with nothing written),
//      so the line never reaches a number that did not text in this turn (MC C9; RULES 7.1).
//   3. The row's person is the caller's person when they are behind the recipient handle (as the stop reply names the
//      person behind the phone), else none: HELP is answered to everyone (QUESTIONS.md M3-M3b.2's default), a handle
//      nobody is known behind included (K-04 outbox_rows.recipient_person_id null).
//   4. A recipient handle that does not exist answers notFound (handles, its id); a phone handle with no phone row answers
//      notFound (phones, named by its handle id, never its number: K-08 v1).
//   5. A phone that is not stopped and whose chat is not open gets no row (MC C9: Rosie never writes first; T-307's
//      outboxRows chatNotOpen): the call answers outboxRowId null, repeated false, with nothing written, as
//      recordStopOrStart answers a reply it could not build (stop-start.ts replyRow); the replies read it as no row
//      (replies.ts: recordedNoReply, noRow).
//   6. An email handle has no stopped flag: its row is built, and limit 8 drops it at send while the address's newest
//      texts row withdraws texts (runtime/src/dispatch/limit8 emailStopped; T-1283).
//   7. Across commits the call cannot tell a rerun of its turn from the first run: no read the flags port holds shows an
//      outbox row (T-1163's lead note 1: no other member). The rerun builds the same row under the same id, and K-05's
//      commit, unique on the turn id, answers the whole turn repeated and writes nothing (K-05 v1 item 1; commit.ts
//      default 7: the caller reads repeated first). The call's own answer says repeated for a later action with the
//      same key in the same commit.
//   8. An action's place in its commit is where the turn's request holds it, by reference: the commit runs the request's
//      own core actions in its order (commit.ts runCoreActions), the turn face hands each on as it is, and the runtime
//      maps the answers back the same way (runtime/src/turn/turn.ts commitKeywords). An action the request does not hold
//      has nothing before it.
//   9. What is open does not hold a fixed line back: K-09 v1 gives sendFixedLine no held answer, the guard answers HELP in
//      code alone, before any decide (arch 02 line 115), and the line changes nothing a hold protects (CQ-65).
//  10. A HELP beside a STOP of the same phone in one keyword turn reads the phone as the database holds it (the STOP's
//      writes are in the same commit; the turn puts the stop record first: turn.ts coreOf), so its row is written; the
//      stopped flag's invariant over the commit (domain/flags/stopped.ts keepStop: T-317's note b, CQ-336 (4), not yet
//      called by the commit) and limit 8 at send (a stopped phone gets only a safety line and a stop reply) take it
//      out, so the phone gets only the stop reply.

import type { CommitTurnContext, CoreAction, CoreRun, OutboxRowNew, UnitWrites } from "../../commit";
import { NotBuiltError, type ErrorsOf, type Handler, type RequestOf, type ResponseOf } from "../../tool-api";
import { EVERY_BUSINESS } from "../flags";
import { createMessagesConsent, type MessagesReader } from "../messages-consent";

export type SendFixedLineRequest = RequestOf<"sendFixedLine">;
export type SendFixedLineResponse = ResponseOf<"sendFixedLine">;
export type SendFixedLineError = ErrorsOf<"sendFixedLine">;
export type SendFixedLineAnswer = SendFixedLineResponse | SendFixedLineError;

/** sendFixedLine as a core action of a turn (K-09 v1 coreAction). */
export type FixedLineAction = Extract<CoreAction, { call: "sendFixedLine" }>;

/** The K-01 fixed line of the guard's HELP reply (contracts/bundle fixed-lines.json; replies' words.ts HELP_REPLY). */
export const HELP_REPLY = "helpReply";

/** The stop home's step (S13-32), whose RULES section 7 holds HELP's reply (RULES 7.6): the step its row's entry names. */
export const HELP_STEP = "S13-32";

/** A line this call sends in a turn: the step its row's entry names (K-08 v1 why), and the one send class it goes in. */
export interface TurnLine {
  readonly step: string;
  readonly sendClass: SendFixedLineRequest["sendClass"];
}

/** The fixed lines this call sends in a turn (default 1): HELP's reply, a guard reply in its turn (quick_reply). */
export const TURN_LINES: ReadonlyMap<string, TurnLine> = new Map<string, TurnLine>([
  [HELP_REPLY, { step: HELP_STEP, sendClass: "quick_reply" }],
]);

/** Why a sendFixedLine is refused before anything is read, where K-09 v1 has no answer for it (a label, never a value). */
export type FixedLineFault =
  /** In a turn the line answers the turn's own handle (default 2). */
  "notTheTurnsHandle";

/** A sendFixedLine refused before anything is read: the turn fails, and nothing of it is written. */
export class FixedLineRefusedError extends Error {
  override name = "FixedLineRefusedError";
  readonly fault: FixedLineFault;

  constructor(fault: FixedLineFault) {
    super(`sendFixedLine refused: ${fault}`);
    this.fault = fault;
  }
}

/**
 * The line a request sends in a turn (default 1), or null: a line this call sends there, in its own send class, with no
 * actor's send to record.
 */
export function turnLineOf(request: SendFixedLineRequest): TurnLine | null {
  const line = TURN_LINES.get(request.fixedLineId);
  return request.sentByActor === null && line?.sendClass === request.sendClass ? line : null;
}

/** Whether this call sends the request in a turn (default 1). */
export function sendsInTurn(request: SendFixedLineRequest): boolean {
  return turnLineOf(request) !== null;
}

/** The key a repeat is known by: the caller's turn, with the fixed line and the recipient (DL-871). */
export function fixedLineKey(
  turnId: string,
  request: Pick<SendFixedLineRequest, "fixedLineId" | "recipientHandleId">,
): string {
  return JSON.stringify([turnId, request.fixedLineId, request.recipientHandleId]);
}

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The row's id, made from its key as the flags service makes its own (domain/flags/ids.ts KEYED_IDS): a prefix and the
 * first 32 hex digits of the SHA-256 of the key, so it carries no key, number or name and is a K-08 v1 safe id. Ids are
 * opaque: code compares them and never parses them (CQ-09).
 */
export async function fixedLineRowId(key: string): Promise<string> {
  const hash = await sha256Hex(JSON.stringify(["fixedLine", key]));
  return `out-fixed-line-${hash.slice(0, 32)}`;
}

// ---- one call in a turn -----------------------------------------------------------------------------------------------

/** What the call reads: T-307's reads, on the side a phone's one row shows on (the wiring's flags port: DL-864). */
export interface FixedLinePorts {
  readonly messages: MessagesReader;
}

/** One sendFixedLine in a turn. */
export interface FixedLineCall {
  readonly request: SendFixedLineRequest;
  /** The turn whose one commit carries it (K-05 v1 turn): its id and its handle. */
  readonly turn: { readonly id: string; readonly handleId: string };
  /** Whether an action before it in the same commit carries the same key (default 8). */
  readonly sentEarlier: boolean;
}

/** What one sendFixedLine answers, and the one row its commit writes, or none. */
export interface FixedLinePlan {
  readonly key: string;
  readonly answer: SendFixedLineAnswer;
  /** Null for a refusal, a row an earlier action of the same commit writes, or no row built (default 5). */
  readonly row: OutboxRowNew | null;
}

/** The caller's person when they are behind the recipient handle, else none (default 3). */
async function personBehind(
  personId: string | null,
  handleId: string,
  reader: MessagesReader,
): Promise<string | null> {
  if (personId === null) return null;
  return (await reader.handleIdsOfPerson(personId)).includes(handleId) ? personId : null;
}

/**
 * Plans one sendFixedLine in a turn: what it answers, and the row its commit writes. Reads only; nothing is written here.
 * Throws FixedLineRefusedError for a recipient that is not the turn's handle (default 2), before anything is read.
 */
export async function planSendFixedLine(call: FixedLineCall, ports: FixedLinePorts): Promise<FixedLinePlan> {
  const { request, turn } = call;
  const key = fixedLineKey(turn.id, request);
  const answerOnly = (answer: SendFixedLineAnswer): FixedLinePlan => ({ key, answer, row: null });
  const recipient = request.recipientHandleId;
  if (recipient !== turn.handleId) throw new FixedLineRefusedError("notTheTurnsHandle");

  const handle = await ports.messages.handle(recipient);
  if (handle?.id !== recipient) return answerOnly({ error: "notFound", table: "handles", rowId: recipient });
  if (handle.kind === "phone") {
    const phone = await ports.messages.phoneOfHandle(recipient);
    if (phone?.handleId !== recipient) {
      return answerOnly({ error: "notFound", table: "phones", rowId: recipient });
    }
    if (phone.stopped) return answerOnly({ error: "phoneStopped", recipientHandleId: recipient });
  }

  // T-307's service is bound to one business; a row for every business is built under EVERY_BUSINESS and names none
  // (stop-start.ts default 7). It reads no reach card here: the line goes back where the text came from.
  const messages = createMessagesConsent({ businessId: EVERY_BUSINESS, reader: ports.messages });
  const rowId = await fixedLineRowId(key);
  const built = await messages.outboxRows({
    id: rowId,
    to: { personId: await personBehind(request.caller.personId, recipient, ports.messages), via: recipient },
    bookingId: null,
    openQuestionId: null,
    sendClass: request.sendClass,
    versionsRead: [],
  });
  const row = built.rows.find((each) => each.id === rowId && each.recipientHandleId === recipient);
  if (row === undefined) return answerOnly({ outboxRowId: null, repeated: false });
  if (call.sentEarlier) return answerOnly({ outboxRowId: row.id, repeated: true });
  return { key, answer: { outboxRowId: row.id, repeated: false }, row: { ...row, businessId: null } };
}

/**
 * Whether an action before this one in the turn's request carries the same key (default 8): the request's own order,
 * the place of each action where the request holds it.
 */
export function sentEarlierInTurn(action: FixedLineAction, turn: CommitTurnContext): boolean {
  const core: readonly CoreAction[] = turn.request.core;
  const key = fixedLineKey(turn.turn.id, action.request);
  return core
    .slice(0, Math.max(core.indexOf(action), 0))
    .some((each) => each.call === "sendFixedLine" && fixedLineKey(turn.turn.id, each.request) === key);
}

/** What one call writes in the turn's commit: its one row, or nothing, under the line's step (default 1). */
function unitWritesOf(step: string, row: OutboxRowNew | null): UnitWrites {
  return {
    why: { step, choice: null },
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages: row === null ? [] : [row],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  };
}

/** What the call runs with in a turn: T-307's reads as the wiring binds them (CoreDeps.flags.messagesReader). */
export interface FixedLineDeps<Repo> {
  /** None given: the call is not built (NotBuiltError), never read through a default reader on the call's transaction. */
  readonly messagesReader?: (repo: Repo) => MessagesReader;
}

/**
 * sendFixedLine as a core action of a turn (gateAndCommit's runCore): its result and what the turn's commit writes. Throws
 * NotBuiltError for a request this call does not send in a turn (default 1) or with no reader given, and
 * FixedLineRefusedError for a recipient that is not the turn's handle (default 2), each before anything is read.
 */
export async function sendFixedLineCore<Repo>(
  action: FixedLineAction,
  turn: CommitTurnContext<Repo>,
  deps: FixedLineDeps<Repo>,
): Promise<CoreRun> {
  const { request } = action;
  const line = turnLineOf(request);
  const reader = deps.messagesReader;
  if (line === null || reader === undefined) throw new NotBuiltError("sendFixedLine");
  // Before the reader is even made (planSendFixedLine holds the same rule for a caller of its own).
  if (request.recipientHandleId !== turn.turn.handleId) throw new FixedLineRefusedError("notTheTurnsHandle");
  const plan = await planSendFixedLine(
    {
      request,
      turn: { id: turn.turn.id, handleId: turn.turn.handleId },
      sentEarlier: sentEarlierInTurn(action, turn),
    },
    { messages: reader(turn.repo) },
  );
  return {
    result: {
      call: "sendFixedLine",
      response: "error" in plan.answer ? null : plan.answer,
      error: "error" in plan.answer ? plan.answer : null,
    },
    writes: unitWritesOf(line.step, plan.row),
  };
}

// ---- made alone -------------------------------------------------------------------------------------------------------

/**
 * sendFixedLine made alone (a job's outage line, an actor's line written on return, a page's or an agent's call): K-05
 * has no commit with no turn, and an outbox row needs its turn, so it answers notBuilt (CQ-44's default), reading and
 * writing nothing.
 */
export function sendFixedLineAlone(): Promise<never> {
  return Promise.reject(new NotBuiltError("sendFixedLine"));
}

/** sendFixedLine as the Tool API base's handler (a call made alone): notBuilt, with its transaction rolled back. */
export function sendFixedLineHandler<Repo>(): Handler<"sendFixedLine", Repo> {
  return () => sendFixedLineAlone();
}
