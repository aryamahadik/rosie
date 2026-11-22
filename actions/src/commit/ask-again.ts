// An asked part's one row: the turn's one open question, sent again, once (C-087, T-1505; K-09 v1.12 defaults 192 to 198;
// K-05 v1.21 item 81; DL-1014, DL-1018 section C as its checker's card 6 narrowed it, DL-1030). On staging an owner's
// typed answer to S1-02 ended `asked` and Rosie sent nothing (DL-1014): the gate answers an asked part with no limit run
// (gate.ts default 2) and the commit writes nothing for it (commit.ts step 6). From K-09 v1.12, after the gate and before
// the request is built, the commit checks default 192's conditions, each as the commit reads it:
//
//   (a) at least one part decide ended in one question (verb `ask`, or outcome `oneQuestion`), so the gate answered it
//       `asked` with limits 1 to 6 notChecked, and every other part `asked` the same way or `noAction`: no part passed
//       (committed, or waiting for the one question: commit.ts default 6), stopped, depending on a stopped part or held;
//   (b) no unmapped end (K-02 v1.2 `end`: v1.8 keeps it silent) and no planner verb;
//   (c) exactly one open question in the turn's context, and each asked part about it: an `ask` names no other question
//       (its `questions` that one, or none), a `oneQuestion` part that chooses chooses one of its options, and a part of
//       any other verb ended in one question is not about it;
//   (f) nothing open holds a routine reply back (default 195): every core action is a text's safety outcome, and
//       isHeld("routine") is false on the holds and unread texts the commit holds after the core actions (a hold the
//       turn's own safety outcome opens among them). A safety outcome that was refused opens no hold and holds no
//       routine part back, so it does not silence the turn (default 198 does not list it);
//   (g) the request's turn carries its service (K-09 v1.5 default 135), the row's channel;
// and only then reads that question on the call's transaction (the walk's question read: AskAgainDeps.questions) for:
//   (d) live (the read answers only a waiting or open question sent to the turn's handle), of the call's business, asked
//       of the call's person (its person_id the caller's personId, compared as they are: a caller with none meets it
//       only on a question stored with none), about no booking, stored with no options as sent and no read-back
//       (default 193);
//   (e) asked once: ask_count 1 (default 194's cap: at 2 or more nothing is written).
// When all hold it hands the commit one unit with no part answer: the outbox row default 192 states, as the walk writes
// the row that first asked the question (walk/writes.ts `asked`): id `outbox-<the question's step>-<turn key>-1`
// (default 131, n 1: the turn's only row of that kind and step), to the turn's handle and the question's person, under
// the question's business, no booking, channel the turn's service, send class quick_reply, the question named, no copy,
// no versions read (open gap 177), no plan; and K-05 v1.21's raise of that question at the version read, with its
// `open_question.asked_again` entry (build.ts default 10). At most one a turn, however many parts decide ended in one
// question. No clock row, no stop read (default 196): the unit carries no ask, so build.ts makes no clock row for it. In
// every other case it hands back nothing, and the turn is answered as before v1.12, silent (default 198); an unmet
// condition never throws. A rerun runs it again before K-05 answers `repeated` (K-05 v1 item 1): it reads ask_count 2 by
// then and builds no unit, and K-05 answers the first commit whatever the body, so nothing is written twice.
//
// A split settler's "ask" (T-1528; K-09 README default 201 and open gap 179, carded by DL-1133, DL-1138): a part the gate
// passed whose walk asked its split's bound settler, which answered "ask" (walk/settle.ts SETTLER_ASKS), wrote nothing
// and was noted on the turn object by the walk (walk/settle.ts settlerAskedParts). Default 192 (a) and (c) take such a
// part as a part decide ended in one question: in (a) it counts as asked, beside parts asked the same way or `noAction`,
// and in (c) it is about the open question its option names, as a `oneQuestion` choose is. Conditions (b), (d) to (g)
// are unchanged, so the step's own question is sent again once with its own line (default 197), and a second "ask" for
// it, read at ask count 2, writes nothing (default 194's cap), as a second asked text does. A passed part the walk did
// not note is not asked, as before.
//
// It only reads (the request, what the commit holds, the walk's note and the one question read) and has no outside
// effect. Nothing here logs; what it throws names a fault, never a person's words: the unit's why names the step alone,
// and no word of the texts or of decide's `unclear` goes into the row (default 197: the row holds no words at commit).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The unit's why is the question's step alone (`{step}`, choice null), as K-05 v1.21's entry names it (its default
//      196: why `{"step": <the question's step>}`) and its commit-s1-02-sam-asks-again.json logs both entries, the
//      raise's and the row's; K-09 v1.12's "asked again" is the raise entry's kind, open_question.asked_again.
//   2. An empty turn key (a binding's fault, never a condition of default 192) refuses the turn (noTurnKey), as the walk
//      refuses one (walk/writes.ts noTurnKey), and is checked only once every condition holds.
//   3. (T-1528) A part whose settler answered "ask" is answered as the commit answers any passed part (commit.ts:
//      `committed`, with its limits as run and no key given), since commit.ts is not this card's: the README's open gap
//      179 says `asked`, and its unit writes nothing, so only the part's result differs. Its row and raise are this
//      file's one unit, built exactly as for a part decide ended in one question (the same id, row and entry).

import type { Decided, GatedPart } from "../gate/framework";
import type { CommitUnit } from "./build";
import { CommitRefusedError } from "./errors";
import { choiceOf, isHeld } from "./hold";
import type {
  AskAgainDeps,
  CommitTurnContext,
  CoreRun,
  LiveQuestion,
  OpenHolds,
  OutboxRowNew,
  TurnRow,
  UnitWrites,
} from "./types";
import { settlerAskedParts } from "./walk/settle";
import { SERVICES } from "./walk/writes";

/**
 * The one ask count at which an open question is sent again (K-09 v1.12 default 192 (e) and default 194: asked once; at
 * 2 or more, its rules' ASKS_BEFORE_SILENT, nothing is written, and K-04 keeps ask_count at least 1).
 */
export const ASKED_ONCE = 1;

/** What the commit holds of the turn once the gate has answered, as the asked turn's check reads it. */
export interface AskedTurn<Repo = unknown> {
  /** The turn as the commit's ports read it: the request, the turn row, the call's repo and business. */
  readonly context: CommitTurnContext<Repo>;
  /** The gate's answer for each part (runGate's verdict parts), in decide's order. */
  readonly gated: readonly GatedPart[];
  /** The parts the holds kept back, by index (hold.ts heldParts). */
  readonly held: ReadonlySet<number>;
  /** The turn's core actions as they ran (commit.ts runCoreActions). */
  readonly core: readonly CoreRun[];
  /** What is open after the core actions: the handle's holds, those the core actions opened, and the unread texts. */
  readonly open: OpenHolds;
}

/** The one open question default 192 (a) to (c), (f) and (g) leave to read, and the row's channel. */
interface Candidate {
  readonly questionId: string;
  readonly channel: OutboxRowNew["channel"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * (a): a part the gate answered `asked` for decide's one question, or a passed part whose split's settler answered "ask"
 * (`settled`: T-1528), every other `noAction`, none held; null otherwise.
 */
function askedParts(turn: AskedTurn, settled: ReadonlySet<number>): number[] | null {
  const asked: number[] = [];
  for (const gated of turn.gated) {
    if (turn.held.has(gated.part)) return null;
    const settlerAsked = gated.result === "passed" && settled.has(gated.part);
    if (gated.result === "asked" || settlerAsked) asked.push(gated.part);
    else if (gated.result !== "noAction") return null;
  }
  return asked.length === 0 ? null : asked;
}

/** (b): decide's result carries no unmapped end (K-02 v1.2 `end`, which K-09 v1.5's type does not name). */
function endsUnmapped(decided: Decided): boolean {
  const decide: unknown = decided.decide;
  return isRecord(decide) && Object.hasOwn(decide, "end");
}

/**
 * (c): the part at `index`, ended in one question, is about the open question `questionId`; a choose whose split's
 * settler answered "ask" (`settled`: T-1528) is, when its option is one of that question's, as a `oneQuestion` one is.
 */
function isAbout(decided: Decided, index: number, questionId: string, settled: ReadonlySet<number>): boolean {
  const entry = decided.decide.parts[index];
  if (entry === undefined) return false;
  const { part } = entry;
  if (part.verb === "ask") return part.questions.every((id) => id === questionId);
  const endedAsked = entry.outcome === "oneQuestion" || settled.has(index);
  if (!endedAsked || part.verb !== "choose") return false;
  const choice = choiceOf(decided, part);
  return choice?.kind === "option" && choice.question === questionId;
}

/**
 * (f): every core action is a text's safety outcome, recorded or refused (K-09 v1.12 defaults 192 (f) and 195: only a
 * core action other than a text's safety outcome, or an open hold, silences), and nothing open holds a routine reply back.
 */
function nothingHolds(turn: AskedTurn): boolean {
  const safetyOnly = turn.core.every(({ result }) => result.call === "recordSafetyOutcome");
  return safetyOnly && !isHeld("routine", turn.open.holds, turn.open.unreadEventIds);
}

/** (g): the turn's service, read without a throw (never textSourceOf, which needs a chat id): one of K-06's, or null. */
function serviceOf(request: CommitTurnContext["request"]): OutboxRowNew["channel"] | null {
  const given: unknown = request.turn;
  if (!isRecord(given)) return null;
  return SERVICES.find((each) => each === given.service) ?? null;
}

/** Default 192 (a) to (c), (f) and (g), before anything is read: the one open question and the channel, or null. */
function candidateOf(turn: AskedTurn): Candidate | null {
  const { request } = turn.context;
  if (request.input.kind !== "decided" || request.input.planner !== null) return null;
  const { decided } = request.input;
  // The parts whose split settler answered "ask", as the walk noted them on this turn object (T-1528).
  const settled = settlerAskedParts(turn.context);
  const asked = askedParts(turn, settled);
  if (asked === null || endsUnmapped(decided)) return null;
  const [only, ...more] = decided.context.openQuestions;
  if (only === undefined || more.length > 0) return null;
  const questionId = only.openQuestionId;
  if (!asked.every((index) => isAbout(decided, index, questionId, settled))) return null;
  if (!nothingHolds(turn)) return null;
  const channel = serviceOf(request);
  return channel === null ? null : { questionId, channel };
}

/** Default 192 (d) and (e) on the question as read on the call's transaction (default 193; default 194's cap). */
function covered(
  question: LiveQuestion | null,
  candidate: Candidate,
  turn: AskedTurn,
): question is LiveQuestion {
  const { context } = turn;
  return (
    question !== null &&
    question.id === candidate.questionId &&
    question.businessId === context.businessId &&
    question.personId === context.request.caller.personId &&
    question.bookingId === null &&
    question.options.length === 0 &&
    question.readback === null &&
    question.askCount === ASKED_ONCE
  );
}

/** The unit: default 192's row and K-05 v1.21's raise of the question at the version read, with no part answer. */
function unitOf(question: LiveQuestion, candidate: Candidate, turn: AskedTurn, turnKey: string): CommitUnit {
  const { context } = turn;
  const row: OutboxRowNew = {
    id: `outbox-${question.step.toLowerCase()}-${turnKey}-1`,
    recipientHandleId: context.turn.handleId,
    recipientPersonId: question.personId,
    businessId: question.businessId,
    bookingId: null,
    channel: candidate.channel,
    sendClass: "quick_reply",
    openQuestionId: question.id,
    copyOfRowId: null,
    versionsRead: [],
  };
  const writes: UnitWrites = {
    why: { step: question.step, choice: null },
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages: [row],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
    askAgain: {
      raise: { id: question.id, expectVersion: question.version },
      step: question.step,
      businessId: question.businessId,
      askCount: question.askCount,
    },
  };
  return { writes, answer: null };
}

/**
 * The asked turn's one unit (K-09 v1.12 default 192): the turn's one open question sent again in one quick reply, with
 * K-05 v1.21's raise of its ask count, when every condition of default 192 holds; else null, and the turn stays silent as
 * before v1.12 (default 198). The question is read only once the conditions that need no read hold, and never when
 * `deps` is left out (no read bound: silent, as before). A failed read throws as it is, so the call fails closed with
 * nothing written, as every read of the commit does.
 */
export async function askAgainUnit<Repo>(
  deps: AskAgainDeps<Repo> | undefined,
  turn: AskedTurn<Repo>,
): Promise<CommitUnit | null> {
  if (deps === undefined) return null;
  const candidate = candidateOf(turn);
  if (candidate === null) return null;
  const { context } = turn;
  const question = await deps.questions.liveQuestion(
    context.repo,
    context.turn.handleId,
    candidate.questionId,
  );
  if (!covered(question, candidate, turn)) return null;
  const turnKey = (deps.turnKey ?? ((row: TurnRow) => row.id))(context.turn);
  if (turnKey === "") throw new CommitRefusedError("noTurnKey");
  return unitOf(question, candidate, turn, turnKey);
}
