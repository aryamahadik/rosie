// What a passed part writes (T-1139, C-087): the commit's writesOf port (types.ts CommitPorts). It walks the turn's
// pinned flow graph from the part's choice (walk.ts; arch 03 line 191) and hands back the rows the walk writes as K-05 v1's
// commit writes (UnitWrites): the state the steps change with their event-log entries, the question the walk stops at
// with its safe default (the commit adds its clock row and the other entries: build.ts), and the outbox row that asks it,
// with no plan (words go in after the commit: arch 01 line 41). For turn 1 these are exactly commit-s1-01.json's
// given.stated.writes (K-09 v1.5 default 136; ADR-013 section 4): S1-01's thread, S1-02's question and
// outbox-s1-02-sam-1.
//
// An answer (T-1461; the architect's ruling on the second turn, DL-961, and the lead's note, DL-965): a part that chooses
// an open question's option closes that question at the version its row is read at, never the request's (the question
// read, WalkDeps.questions, on the call's transaction), names that row in versionsRead, and walks from the chosen branch.
// Each walked step that writes something is written by its own read-only step writer, found by its step id
// (WalkDeps.writers: T-633's and T-634's, bound in the turn face by card F), and a step that writes something with no
// writer bound is refused (notBuilt), so the call fails closed with nothing written. For turn 2's "All on the list"
// (commit-s1-02.json) that is, up to row ids: S1-02's writer's three picked kinds, S1-11's writer's eleven pf keys,
// S1-04's question with its outbox row, and oq-s1-02 closed at its version. While no question read is bound, every
// answer is notBuilt, as before.
//
// A settled answer (T-1502; K-09 README default 191 as T-1499's round 2 corrects it; DL-1018 card 4, DL-1021): where the
// binding hands in a settler for the answered split (WalkDeps.settlers, settle.ts), the walk asks it once for the branch
// before it walks, and never reads the option decide named to find it: from there the walk is the walk of a chosen
// branch, with the settled branch in the chosen one's place (its writers handed it as the branch chosen, the unit's why
// naming it). A held answer asks no settler and writes nothing. With no settler bound the walk is exactly as above.
//
// A returning number's chat thread (T-1519; DL-1048, from T-1517's round 2): K-04 holds one chat thread per handle across
// every business (0005 threads_one_chat_per_handle; MC C1) and one thread per Linq chat id (threads_linq_chat_key), so
// S1-01's insert for a handle that already has its chat (a re-JOIN, the user's phone after T-1517's roster reset, a
// customer who later signs up) is refused by the database, commitTurn answers constraint and writes nothing, and JOIN
// gets no reply. Where the binding hands in the chat read (WalkDeps.chats: K-05 v1.10 item 51's readChatHandle, on the
// runtime side, since rosie_app holds no grant on threads: 0012), S1-01's thread write asks it once for the turn's Linq
// chat id: when the handle whose chat thread holds that chat id is the turn's own, the handle's chat thread already
// exists and is reused, so the walk writes no thread row and no `thread.created` entry, and the part still gives
// `thread`, as a new thread's would (nothing the turn writes names the thread's id: K-05 v1 outboxRowNew has no thread);
// for any other answer (no thread holds the chat id, or another handle's does) the thread is inserted exactly as before.
// With no chat read bound, the thread is inserted exactly as before.
//
// It only reads (the pinned graph through its own port; the answered question and what each step writer reads, on the
// call's transaction; the call's request) and has no outside effect, since a repeated turn runs it again before K-05
// answers repeated (STATE note 1; types.ts CommitPorts). Nothing here logs; what it throws names faults, step ids and
// keys (errors.ts), never words or the chat id.
//
// What it writes, step by step (each journey's lane extends the writers; anything else is notBuilt, nothing written):
//   - a plain step's gives with no writer bound: `thread` (S1-01) only, the handle's chat with Rosie's number (K-04
//     threads: kind chat, no booking, the Linq chat id of the turn's last text, no reply address), with its
//     `thread.created` entry, whose values name the kind alone, never the chat id (K-09 v1.5 defaults 134 and 135); or,
//     where the chat read finds the handle's own chat thread holding the turn's chat id, no row and no entry (default 12);
//   - the split it stops at, when Rosie asks it of the turn's own writer by text (S1-02): one open question (no options,
//     no read-back, step 9's default clock: K-09 v1.5 default 134) with the card's safe default for its clock row, and
//     one quick reply on the turn's service (defaults 132 and 133);
//   - the plain step it stops at whose message carries buttons (S1-04, DL-965's lead note), asked of the turn's own
//     writer by text: its question and its quick reply, as a split's are (default 10);
//   - the question an answer closes, answered at its row's version, with that row in versionsRead (default 11);
//   - every other row of a walked step, by that step's writer (default 9): the answered split's gives (S1-02's kinds),
//     each step of the chosen branch (S1-03's and S1-74's messages) and each plain step after it (S1-11's pf keys), in
//     the walk's order. A branch's effects are what its own steps write (compiler/src/branches/effects.ts: a message per
//     step that tells someone, a record write per gives key); any other effect (a clock, a charge, a refund, a calendar
//     write, a flag) is notBuilt.
// While anything is open (a safety hold, or a text not yet read), the walk stops at its first routine row (STATE note 1;
// DL-128 note a): the rows before it are written, that row and every row after it are not, and nothing is read for them.
// A protective step's rows pass every hold; a safety-flow step's (A3-24, A3-25 and their twins) pass only an after-safe
// hold (hold.ts's lists). An answer's first row is its question's close, so a held answer closes nothing.
//
// The walk reads the pinned bundle's flow graphs alone (WalkBundles.flow), never a trade overlay (K-01 v1's trade parts):
// before a kind is known no overlay applies, and S1-02's answer is where the kinds are picked, so it walks the master's
// steps alone, a trade's words ops at S1-02 and its offs of "One isn't on the list yet" included (DL-965's lead note 5).
// A later card that walks a step after a kind is known adds an overlay read.
//
// Not here: the answered question's clock row (`clock-<question id>`, build.ts default 2) is not cancelled, since its
// cancel names the clock row's version (K-05 v1 clockCancel.expectVersion), which no read the walk is given returns
// (T-1461's open question 1).
//
// Defaults used (for ops/QUESTIONS.md), beside walk.ts's:
//   3. The row ids are K-09 v1.5 default 131's: `<kind>-<step>-<turn key>-<n>`, the writing step in lower case, n from 1
//      per kind and step in the walk's order, the turn key the turn's own id unless the binding names another (a proof
//      on a fixture names the fixture's stand-in, `sam`). The thread's entry is `log-<row id>-created`, T-305's rule. A
//      step writer names its rows the same way (WriterContext.rowId), by a kind of its own.
//   4. The writer of the turn is the lane of the step the part entered when that step is written to Rosie (S1-01:
//      "owner -> san"), and a question the walk stops at goes to the turn's own handle and person (the request's caller)
//      only when Rosie asks it of that lane by text (S1-02: "san -> owner", via msg): a reply in the same turn, so a quick
//      reply (default 133). A question to anyone else is another journey's.
//   5. The thread's event-log entry names no business (a thread is the handle's across every business: MC C1; K-04
//      threads has no business), and is Rosie's, with the unit's why, in the zone the turn's texts were read in (build.ts
//      default 4).
//   6. The unit's why is the step the part's choice names, with the branch it chose or else the choice's label, as the
//      frontier offered it from the bundle (never the person's words). A settled answer's why names the step and the
//      settled branch (default 191); a settled answer held back names the step alone, since no branch was settled.
//   7. The question's and the outbox row's business and booking are the choice's target's (the call's business, checked;
//      no booking for the sign-up door). The versions read are none for a walk from a step: the door's walk reads no row
//      (K-09 v1.5 default 134); an answer reads its question's row (default 11).
//   8. (T-1461) The writer of an answer's turn is the lane Rosie asked the answered split of (S1-02: "san -> owner", so
//      the owner), as default 4 takes an entered step's lane when it is written to Rosie.
//   9. (T-1461) A step writes something when it gives a key or tells someone. The answered split's message went out when
//      it was asked, so only its gives are written when it is answered; the step the walk stops at is asked, and its
//      gives are written when it is answered (as S1-02's kinds are at turn 2, never at turn 1). A step that writes
//      nothing needs no writer, and none is called for it; a bound writer writes its step's rows in place of the walk's
//      own (S1-01's thread). Every writer is found before anything is read, so a missing one refuses the part with
//      nothing read. A writer gives only its step's own keys (K-01 v1 step.gives), else the part is refused.
//  10. (T-1461) A plain step's buttons question (S1-04) is opened as S1-02's is at turn 1 (the open question of default 7
//      and default 134): no options (the buttons' option ids are K-03's, and the next turn's options are a later card:
//      DL-965's lead note 3), no read-back, no versions read, and, with no card, no safe default and step 9's default
//      clock (clock null), as T-305's double of commit-s1-02.json writes oq-s1-04-sam (commit/test-support.ts
//      samKindsWrites). A card it has is read as a split's is (its Clock, its safe default); a split asked with buttons
//      stays notBuilt (buttons).
//  11. (T-1461) An answered question is the live question the option names (K-02 v1 choice.question), sent to the turn's
//      handle, at the chosen step, of the call's business, read on the call's transaction; any other is refused. It is
//      closed answered with no option id (K-05 v1 openQuestionClose.answeredOptionId null): S1-02 is asked with no
//      options (K-09 v1.5 default 134), so none went out; one that went out with options is notBuilt (buttons).
//  12. (T-1519) The handle's chat thread is found by the turn's Linq chat id (K-05 v1.10 item 51, readChatHandle: the
//      phone handle whose chat thread holds it), the only frozen K-05 read that names a chat thread's handle before any
//      outbox row exists (sendState, item 28, reads a handle's chat by an outbox row's id). The turn's own handle in the
//      answer is the handle's chat thread for this very chat: it is reused, with no row written, no row read into
//      versionsRead (a thread is never deleted, 0005's foreign keys restrict, and no call moves it to another handle), and
//      the part's gives unchanged. Any other answer keeps today's insert: none (no thread holds the chat id), so the
//      handle has no chat thread for it; or another handle's, which the database refuses (threads_linq_chat_key) as it
//      did before. Not covered, and left as it was: a handle whose chat thread holds another chat id, or none yet, since
//      no frozen K-05 read answers a handle's chat thread by the handle before an outbox row exists; its insert is still
//      refused (threads_one_chat_per_handle). The read is asked only for a thread the walk would write: never for an
//      email turn (threadByEmail) and never for a held step.

import type { Choice, Decided, SetupKey } from "../../gate/framework";
import { PROTECTIVE_STEPS, SAFETY_FLOW_STEPS, holdClassOf, isHeld, type HoldClass } from "../hold";
import type {
  Ask,
  CommitPorts,
  CommitTurnContext,
  EventEntry,
  GateAndCommitRequest,
  OpenHolds,
  OpenQuestionClose,
  OpenQuestionNew,
  OutboxRowNew,
  PassedPart,
  RowRef,
  StateWrite,
  TurnRow,
  UnitWrites,
  Why,
} from "../types";
import { WalkNotBuiltError, WalkRefusedError } from "./errors";
import { flowGraphOf, flowOfStep, type FlowGraph, type FlowLetter, type GraphStep } from "./graph";
import { isSplitStep, settledBranch, type StepSettler, type StepSettlers } from "./settle";
import { walkFrom, type WalkStart, type Walked } from "./walk";

/** A bundle id as the turn row pins it (K-05 v1 turn.bundleId; K-01 v1 bundleId). */
export interface BundleIdOf {
  readonly hash: string;
  readonly build: number;
}

/**
 * The turn's pinned bundle's flow graphs (K-01 v1 flowGraph), each read under the bundle's id from KV, or PostgreSQL's
 * copy on a miss (arch 10 line 536), and handed over parsed; the walk checks the fields it reads itself. The frontier's
 * bundles port (frontier/assemble FrontierBundles.flow) has this shape, so T-1141 can bind the same one.
 */
export interface WalkBundles {
  /** The flow graph of `flow` in the bundle `bundleId`, or null when the bundle holds no such flow. */
  flow(bundleId: BundleIdOf, flow: FlowLetter): Promise<unknown>;
}

/**
 * An open question as the walk reads it to close it: the fields of K-05 v1.2 openQuestionRead it reads, so the rows
 * db/repo/targets.ts reads (OpenQuestionRead, its version read from the row at targets.ts:564) bind as they are.
 */
export interface LiveQuestion {
  readonly id: string;
  readonly step: string;
  /** The business it is about (open_questions.business_id), or null before there is one. */
  readonly businessId: string | null;
  /** The options as they went out (K-04 open_questions.options); empty for a question asked with none (S1-02). */
  readonly options: readonly unknown[];
  /** The row's version, which the close compares and sets (K-05 v1 openQuestionClose.expectVersion; limit 4). */
  readonly version: number;
}

/** Where an answer reads the open question it closes: the call's transaction (default 11). */
export interface WalkQuestions<Repo = unknown> {
  /**
   * The open question `openQuestionId` when it is live (waiting or open) and was sent to the handle `handleId`, as its
   * row stands on the call's transaction `repo`; else null. Card F binds K-05 v1.2's read of a handle's live questions
   * (db/repo/targets.ts liveOpenQuestionsOfHandle, as limit 3 reads them), whose rows carry their versions.
   */
  liveQuestion(repo: Repo, handleId: string, openQuestionId: string): Promise<LiveQuestion | null>;
}

/**
 * Where S1-01's thread write finds the handle's chat thread (T-1519; default 12): K-05 v1.10 item 51's readChatHandle,
 * which the binding runs on the runtime side in a read-only transaction of its own (threads and handles are scoped none,
 * and rosie_app holds no grant on either: 0012), never on the call's transaction.
 */
export interface WalkChats {
  /**
   * The id of the phone handle whose chat thread (K-04 threads of kind chat) holds the Linq chat id `linqChatId`
   * (threads_linq_chat_key: one thread at most), or null when no chat thread of a phone handle holds it. The number the
   * read also answers is never handed to the walk. A read that answers an error throws, and the call fails closed.
   */
  chatHandle(linqChatId: string): Promise<string | null>;
}

/** What one step's writer hands the walk: its rows in its own order, each list present (empty when it has none). */
export interface StepRows {
  /** State writes (K-05 v1 stateWrite), with their event-log entries, since only the domain knows their kind (types.ts). */
  readonly state: readonly StateWrite[];
  readonly stateEvents: readonly EventEntry[];
  /** The keys these rows give (K-09 v1.5 partResult.gives): each one of its step's own (K-01 v1 step.gives). */
  readonly gives: readonly SetupKey[];
  /** The questions it opens, each with its safe default (the commit adds each one's clock row: build.ts). */
  readonly asks: readonly Ask[];
  /** One outbox row per message, with no plan: words go in after the commit (arch 01 line 41). */
  readonly messages: readonly OutboxRowNew[];
}

/** The walk's writer context, as a step's writer reads it. */
export interface WriterContext<Repo = unknown> {
  /** The turn as the commit hands it to writesOf: the request, the turn row, the call's repo and its business. */
  readonly turn: CommitTurnContext<Repo>;
  /** The unit's why (default 6), which every entry of its rows carries. */
  readonly why: Why;
  /** The zone the turn's texts were read in (build.ts default 4), for the entries of the state rows it writes. */
  readonly zone: string | null;
  /** The lane of the turn's writer (defaults 4 and 8), or null when the walk names none. */
  readonly writerLane: string | null;
  /** Default 131's next row id of `kind` that this step writes, in the walk's order: `<kind>-<step>-<turn key>-<n>`. */
  rowId(kind: string): string;
  /** The service and Linq chat id of the turn's last text (default 135): refused (noServiceOrChatId) without them. */
  text(): TextSource;
}

/** One call of a step's writer: on the call's transaction, with the part, its choice and the walk's writer context. */
export interface StepWriterCall<Repo = unknown> {
  /** The call's repo, inside its transaction and business scope (CommitTurnContext.repo): read through, never written. */
  readonly repo: Repo;
  /** The step written, as the walk reads it from the turn's pinned graph. */
  readonly step: GraphStep;
  readonly part: PassedPart;
  /** The offered choice the part chose or entered (an answer's: its option, with the branch it chose). */
  readonly choice: Choice;
  readonly writer: WriterContext<Repo>;
}

/**
 * One step's own writer (DL-961 ruling 2): what that step writes when the walk walks it. It only reads, and never
 * writes: the commit writes what writesOf returns. What it throws fails the call closed, as the walk's own refusals do.
 */
export type StepWriter<Repo = unknown> = (call: StepWriterCall<Repo>) => Promise<StepRows>;

/** The read-only step writers, by step id: the writer bound to `stepId`, or null when none is. */
export type StepWriters<Repo = unknown> = (stepId: string) => StepWriter<Repo> | null;

export interface WalkDeps<Repo = unknown> {
  /** The pinned bundle's graphs: the walk's own dependency (DL-322 ruling 4), bound by T-1141. */
  readonly bundles: WalkBundles;
  /** Default 131's turn key, from the turn row. Default: the turn's own id. */
  readonly turnKey?: (turn: TurnRow) => string;
  /** Where an answer reads the question it closes (default 11). Left out, every answer is notBuilt (answer). */
  readonly questions?: WalkQuestions<Repo>;
  /** The read-only step writers by step id (default 9). Left out, no writer is bound. */
  readonly writers?: StepWriters<Repo>;
  /**
   * The read-only settlers by step id (K-09 README default 191; T-1502; settle.ts), handed in as `questions` and
   * `writers` are. The walk asks one only at a split step, for a passed part that chooses an option of that step's open
   * question and that no hold keeps back. Left out, no settler is bound and the walk is exactly as before.
   */
  readonly settlers?: StepSettlers<Repo>;
  /**
   * Where S1-01's thread write finds the handle's chat thread (T-1519; default 12), handed in as `questions` is. Left
   * out, S1-01's thread is inserted exactly as before.
   */
  readonly chats?: WalkChats;
}

/** The service and Linq chat id of the turn's last text (K-09 v1.5 gateAndCommit.turn; default 135). */
export interface TextSource {
  readonly service: OutboxRowNew["channel"];
  readonly chatId: string;
}

/** K-06 v1 service: the channel of a reply's outbox row (K-05 v1 outboxRowNew.channel; default 132). */
const SERVICES: readonly OutboxRowNew["channel"][] = ["imessage", "rcs", "sms", "email"];

/** The services that come through Linq, whose chat is K-04 threads kind chat with its Linq chat id. */
const LINQ_SERVICES: readonly OutboxRowNew["channel"][] = ["imessage", "rcs", "sms"];

/** The keys the walk writes (S1-01 gives thread). */
const THREAD: SetupKey = "thread";

/** The effects of a branch that its own steps' writers write: a message per step that tells, a record write per key. */
const WRITTEN_EFFECTS: readonly string[] = ["message", "recordWrite"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The service and chat id of the turn's last text, from the request's turn, which the runtime caller copies from that
 * text's K-06 event (K-09 v1.5 default 135). v1.5's request type names them since T-1150 (DL-340), but a turn may carry
 * neither (a v1 caller's, or a clock's) and the chat id may be null (email, or none reported), so the turn is still read
 * with a runtime check: both non-empty strings, the service one of K-06's, or the part fails closed (noServiceOrChatId),
 * never guessed. Never logged, and never in an error.
 */
export function textSourceOf(request: GateAndCommitRequest): TextSource {
  const turn: unknown = request.turn;
  if (!isRecord(turn)) throw new WalkRefusedError("noServiceOrChatId");
  const service = SERVICES.find((each) => each === turn.service);
  const { chatId } = turn;
  if (service === undefined || typeof chatId !== "string" || chatId === "") {
    throw new WalkRefusedError("noServiceOrChatId");
  }
  return { service, chatId };
}

/** What a step is to what is open, by its id: protective, the safety flow, or routine (hold.ts's lists). */
export function stepHoldClass(stepId: string): HoldClass {
  if (PROTECTIVE_STEPS.includes(stepId)) return "protective";
  if (SAFETY_FLOW_STEPS.includes(stepId)) return "safetyFlow";
  return "routine";
}

/**
 * Where the walk stops for what is open (STATE note 1; DL-128 note a): the index of the first step whose rows the open
 * holds or an unread text keep back, or null when none is. The first step is the part's own, of the class hold.ts gives
 * the part (a protective any-time row's included); each after it is of its own step's class.
 */
export function firstHeld(stepIds: readonly string[], partClass: HoldClass, open: OpenHolds): number | null {
  for (const [index, id] of stepIds.entries()) {
    const holdClass = index === 0 ? partClass : stepHoldClass(id);
    if (isHeld(holdClass, open.holds, open.unreadEventIds)) return index;
  }
  return null;
}

/** Where the part's choice starts the walk (K-02 v1 choiceKind). */
function startOf(choice: Choice): WalkStart {
  switch (choice.kind) {
    case "door":
    case "anytime":
    case "searchEntry":
      return { kind: "step", step: choice.step };
    case "option":
    case "hub":
      if (choice.branch === null) throw new WalkRefusedError("branchNotInBundle", [choice.step]);
      return { kind: "branch", step: choice.step, branch: choice.branch };
    case "whichBooking":
      throw new WalkNotBuiltError("whichBooking", [choice.step]);
  }
}

/**
 * Where an answer reads the question it closes (default 11): an option's, once a question read is bound. A hub's case,
 * or an option while none is bound, is not built: the close needs the version the question's row is read at.
 */
function questionsOf<Repo>(deps: WalkDeps<Repo>, choice: Choice, stepId: string): WalkQuestions<Repo> {
  if (choice.kind !== "option" || deps.questions === undefined) {
    throw new WalkNotBuiltError("answer", [stepId]);
  }
  return deps.questions;
}

/**
 * The settler bound to the step an open question's option names (default 191), found by step id alone: null for any
 * other choice, or when none is bound. Whether it is asked waits for the pinned graph (a split step) and the holds.
 */
function settlerFor<Repo>(deps: WalkDeps<Repo>, choice: Choice): StepSettler<Repo> | null {
  if (deps.settlers === undefined || choice.kind !== "option") return null;
  return deps.settlers(choice.step);
}

/**
 * One step whose rows the walk writes: the split an answer answers, a step walked (on a list, or on the chosen branch),
 * or the step the walk stops at.
 */
interface Writing {
  readonly step: GraphStep;
  readonly as: "answer" | "step" | "asks" | "waits";
}

/**
 * The steps whose rows the walk writes, in order: an answer's split, the steps walked, then the step it stops at. An
 * answer writes each step of its chosen branch through that step's writer, so a branch step the bundle does not hold
 * (walk.ts default 1) is refused here, and an effect no step writes is not built (effect).
 */
function writingOf(graph: FlowGraph, walked: Walked): Writing[] {
  const writing = walked.moves.map((move): Writing => {
    if (move.kind === "step") return { step: move.step, as: "step" };
    const { split, branch } = move;
    for (const id of branch.steps) {
      if (graph.step(id) === null) throw new WalkRefusedError("stepNotInBundle", [id]);
    }
    const other = branch.effects.find((effect) => !WRITTEN_EFFECTS.includes(effect.kind));
    if (other !== undefined) throw new WalkNotBuiltError("effect", [split.id, other.kind]);
    return { step: split, as: "answer" };
  });
  const { stop } = walked;
  if (stop.kind === "asks" || stop.kind === "waits") writing.push({ step: stop.step, as: stop.kind });
  return writing;
}

/**
 * The writer's lane (defaults 4 and 8): who the entered step is from, when it is written to Rosie (S1-01: owner); for an
 * answer, whom Rosie asked the answered split of (S1-02: owner).
 */
function writerLaneOf(graph: FlowGraph, start: WalkStart): string | null {
  const entered = graph.step(start.step);
  if (entered === null) return null;
  if (start.kind === "branch") return entered.who === "san" ? entered.to : null;
  return entered.to === "san" ? entered.who : null;
}

/** Default 131's row ids for one walk: `<kind>-<step>-<turn key>-<n>`. */
function rowIds(turnKey: string): (kind: string, stepId: string) => string {
  const counts = new Map<string, number>();
  return (kind, stepId) => {
    const step = stepId.toLowerCase();
    const counted = `${kind}-${step}`;
    const n = (counts.get(counted) ?? 0) + 1;
    counts.set(counted, n);
    return `${kind}-${step}-${turnKey}-${String(n)}`;
  };
}

/** The unit's why (default 6), in build.ts's spelling for an entry's `why`. */
function whyEntry(why: Why): Record<string, unknown> {
  return why.choice === null ? { step: why.step } : { step: why.step, choice: why.choice };
}

/** What the rows of one walk are written from. */
interface WalkRun<Repo> {
  readonly context: CommitTurnContext<Repo>;
  readonly part: PassedPart;
  readonly choice: Choice;
  readonly why: Why;
  /** The zone the turn's texts were read in (build.ts default 4). */
  readonly zone: string | null;
  readonly nextId: ReturnType<typeof rowIds>;
  /** The lane of the turn's writer (defaults 4 and 8), or null when the walk names none. */
  readonly writerLane: string | null;
  /** Where an answer reads its question (default 11); null for a walk from a step. */
  readonly questions: WalkQuestions<Repo> | null;
  readonly writers: StepWriters<Repo> | null;
  /** Where S1-01's thread write finds the handle's chat thread (default 12); null when none is bound. */
  readonly chats: WalkChats | null;
}

/** Who writes one step's rows: the writer bound to its id, or the walk itself (S1-01's thread, a question, or none). */
type WrittenBy<Repo> = StepWriter<Repo> | "walk";

/**
 * Who writes one step's rows (default 9). A step that gives a key or tells someone (the answered split: gives a key) is
 * written by the writer bound to its id; with none bound, the walk writes S1-01's thread alone, and any other is
 * notBuilt (tells, gives). A step that writes nothing, and the step the walk stops at, are the walk's own.
 */
function writtenBy<Repo>(writers: StepWriters<Repo> | null, each: Writing): WrittenBy<Repo> {
  if (each.as === "asks" || each.as === "waits") return "walk";
  const { step } = each;
  // The answered split's message went out when it was asked: only its gives are written now.
  const tells = each.as === "answer" ? [] : step.tells;
  if (step.gives.length === 0 && tells.length === 0) return "walk";
  const writer = writers?.(step.id) ?? null;
  if (writer !== null) return writer;
  if (tells.length > 0) throw new WalkNotBuiltError("tells", [step.id]);
  const other = step.gives.find((key) => key !== THREAD);
  if (other !== undefined) throw new WalkNotBuiltError("gives", [step.id, other]);
  return "walk";
}

/** The part's writes, built row by row as the walk goes: every list present, empty when it has none. */
interface Built {
  readonly versionsRead: RowRef[];
  readonly state: StateWrite[];
  readonly stateEvents: EventEntry[];
  readonly asks: Ask[];
  readonly closes: OpenQuestionClose[];
  readonly messages: OutboxRowNew[];
  readonly gives: SetupKey[];
}

/**
 * The rows of the steps a walk writes, in order. Every step's writer is found first, so a step with none refuses the part
 * before anything is read; the turn's service and chat id are read once, when a row needs them.
 */
async function writeRows<Repo>(run: WalkRun<Repo>, writing: readonly Writing[]): Promise<Built> {
  const built: Built = {
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    closes: [],
    messages: [],
    gives: [],
  };
  const { context, choice } = run;
  let source: TextSource | undefined;
  const text = (): TextSource => (source ??= textSourceOf(context.request));

  /**
   * S1-01 gives thread: the handle's chat with Rosie's number, and its entry (defaults 134, 135; default 5); or, where the
   * chat read finds the handle's own chat thread holding the turn's chat id, that thread, reused with nothing written
   * (default 12).
   */
  const thread = async (step: GraphStep): Promise<void> => {
    const { service, chatId } = text();
    if (!LINQ_SERVICES.includes(service)) throw new WalkNotBuiltError("threadByEmail", [step.id]);
    if (run.chats !== null && (await run.chats.chatHandle(chatId)) === context.turn.handleId) {
      if (!built.gives.includes(THREAD)) built.gives.push(THREAD);
      return;
    }
    const id = run.nextId("thread", step.id);
    built.state.push({
      op: "insert",
      table: "threads",
      values: {
        id,
        handle_id: context.turn.handleId,
        kind: "chat",
        booking_id: null,
        linq_chat_id: chatId,
        reply_address: null,
      },
    });
    built.stateEvents.push({
      id: `log-${id}-created`,
      kind: "thread.created",
      zone: run.zone,
      businessId: null,
      actorKind: "rosie",
      actorPersonId: null,
      actorRole: null,
      tableName: "threads",
      rowId: id,
      oldValues: null,
      newValues: { kind: "chat" },
      sealed: null,
      why: whyEntry(run.why),
      approvedBy: null,
      proofs: null,
    });
    if (!built.gives.includes(THREAD)) built.gives.push(THREAD);
  };

  /**
   * The step the walk stops at, asking the turn's writer (default 4): a split's question with its card's safe default,
   * or a plain step's buttons' question (default 10), and the quick reply asking it.
   */
  const asked = (step: GraphStep): void => {
    if (step.who !== "san" || step.via !== "msg" || run.writerLane === null || step.to !== run.writerLane) {
      throw new WalkNotBuiltError("recipient", [step.id]);
    }
    const { card } = step;
    if (step.split && step.buttons > 0) throw new WalkNotBuiltError("buttons", [step.id]);
    if (step.split && card === null) throw new WalkRefusedError("stepNotWellFormed", [step.id]);
    if (card !== null && card.clock?.from !== "step9Default") throw new WalkNotBuiltError("clock", [step.id]);
    const { service } = text();
    const { target } = choice;
    const { personId } = context.request.caller;
    const question: OpenQuestionNew = {
      id: run.nextId("oq", step.id),
      handleId: context.turn.handleId,
      personId,
      businessId: target.businessId,
      bookingId: target.bookingId,
      step: step.id,
      options: [],
      readback: null,
      versionsRead: [],
      clock: null,
    };
    built.asks.push({ question, safeDefault: card?.safeDefault ?? null });
    built.messages.push({
      id: run.nextId("outbox", step.id),
      recipientHandleId: context.turn.handleId,
      recipientPersonId: personId,
      businessId: target.businessId,
      bookingId: target.bookingId,
      channel: service,
      sendClass: "quick_reply",
      openQuestionId: question.id,
      copyOfRowId: null,
      versionsRead: [],
    });
  };

  /**
   * The question an answer closes (default 11): the live question the option names, as the question read finds its row
   * on the call's transaction, closed answered at that row's version, and the row named in versionsRead.
   */
  const answered = async (step: GraphStep): Promise<void> => {
    const { questions } = run;
    const id = choice.question;
    if (questions === null || id === null) throw new WalkRefusedError("questionNotLive", [step.id]);
    const row = await questions.liveQuestion(context.repo, context.turn.handleId, id);
    if (row?.id !== id || row.step !== step.id) throw new WalkRefusedError("questionNotLive", [step.id]);
    if (row.businessId !== context.businessId) throw new WalkRefusedError("businessNotInScope");
    if (row.options.length > 0) throw new WalkNotBuiltError("buttons", [step.id]);
    built.versionsRead.push({ table: "open_questions", rowId: row.id, version: row.version });
    built.closes.push({ id: row.id, expectVersion: row.version, status: "answered", answeredOptionId: null });
  };

  /** A step's rows by its own writer (default 9), added in the walk's order; a key its step does not give is refused. */
  const written = async (step: GraphStep, writer: StepWriter<Repo>): Promise<void> => {
    const rows = await writer({
      repo: context.repo,
      step,
      part: run.part,
      choice,
      writer: {
        turn: context,
        why: run.why,
        zone: run.zone,
        writerLane: run.writerLane,
        rowId: (kind) => run.nextId(kind, step.id),
        text,
      },
    });
    const other = rows.gives.find((key) => !step.gives.includes(key));
    if (other !== undefined) throw new WalkRefusedError("givesNotStep", [step.id, other]);
    built.state.push(...rows.state);
    built.stateEvents.push(...rows.stateEvents);
    built.asks.push(...rows.asks);
    built.messages.push(...rows.messages);
    for (const key of rows.gives) if (!built.gives.includes(key)) built.gives.push(key);
  };

  const planned = writing.map((each) => ({ each, by: writtenBy(run.writers, each) }));
  for (const { each, by } of planned) {
    const { step } = each;
    if (each.as === "waits") throw new WalkNotBuiltError("waits", [step.id]);
    if (each.as === "asks") {
      asked(step);
      continue;
    }
    if (each.as === "answer") await answered(step);
    if (by === "walk") {
      for (const key of step.gives) if (key === THREAD) await thread(step);
    } else {
      await written(step, by);
    }
  }
  return built;
}

/** The decided texts a turn read. */
type DecidedTexts = Decided["context"]["texts"];

/** A unit that writes nothing, with its why: a settled answer whose first row is held back (default 191). */
function nothingWritten(why: Why): UnitWrites {
  return {
    why,
    versionsRead: [],
    state: [],
    stateEvents: [],
    asks: [],
    closes: [],
    clockCancels: [],
    messages: [],
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: [],
  };
}

/** One walk, once its start is known: what the part's rows are written from. */
interface Walking<Repo> {
  readonly part: PassedPart;
  readonly context: CommitTurnContext<Repo>;
  readonly open: OpenHolds;
  /** The decided texts the turn read (the zone of their first). */
  readonly texts: DecidedTexts;
  /** The choice the writers are handed: the part's own, or, settled, the part's with the settled branch as its branch. */
  readonly choice: Choice;
  readonly graph: FlowGraph;
  readonly start: WalkStart;
  readonly walked: Walked;
  readonly questions: WalkQuestions<Repo> | null;
  readonly why: Why;
}

/** The part's writes from its walk: what is open stops the walk at its first routine row (STATE note 1). */
async function unitOf<Repo>(deps: WalkDeps<Repo>, walking: Walking<Repo>): Promise<UnitWrites> {
  const { part, context, open, choice, graph, start, walked, questions, why } = walking;
  const writing = writingOf(graph, walked);
  const heldAt = firstHeld(
    writing.map((each) => each.step.id),
    holdClassOf(part.part, choice),
    open,
  );

  const turnKey = (deps.turnKey ?? ((turn: TurnRow) => turn.id))(context.turn);
  if (turnKey === "") throw new WalkRefusedError("noTurnKey");
  const run: WalkRun<Repo> = {
    context,
    part,
    choice,
    why,
    zone: walking.texts[0].sentAt.zone,
    nextId: rowIds(turnKey),
    writerLane: writerLaneOf(graph, start),
    questions,
    writers: deps.writers ?? null,
    chats: deps.chats ?? null,
  };
  const built = await writeRows(run, heldAt === null ? writing : writing.slice(0, heldAt));
  return {
    why,
    versionsRead: built.versionsRead,
    state: built.state,
    stateEvents: built.stateEvents,
    asks: built.asks,
    closes: built.closes,
    clockCancels: [],
    messages: built.messages,
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: built.gives,
  };
}

/** What a settled answer is walked from (default 191): the part, its turn, the pinned graph and the split's settler. */
interface Settling<Repo> {
  readonly part: PassedPart;
  readonly context: CommitTurnContext<Repo>;
  readonly open: OpenHolds;
  readonly texts: DecidedTexts;
  /** The choice decide named: of it, only what every option of its question shares is read here. */
  readonly choice: Choice;
  readonly graph: FlowGraph;
  /** The answered split, as the pinned graph holds it, with its branches. */
  readonly split: GraphStep;
  readonly settler: StepSettler<Repo>;
}

/**
 * A settled answer (default 191): the question read is bound (else notBuilt, nothing asked); a held answer asks no
 * settler and writes nothing; else the settler is asked once, its label checked against the split's branches in the
 * pinned graph, and the walk of that branch is written, each writer handed it as the branch chosen.
 */
async function settledWrites<Repo>(deps: WalkDeps<Repo>, settling: Settling<Repo>): Promise<UnitWrites> {
  const { part, context, open, choice, graph, split } = settling;
  // An answer closes its question at the version the question's row is read at: with no read bound, it is not built.
  const questions = questionsOf(deps, choice, split.id);
  // The answer's first row is its question's close (the part's own class): held back, nothing is read for the part.
  if (firstHeld([split.id], holdClassOf(part.part, choice), open) === 0) {
    return nothingWritten({ step: split.id, choice: null });
  }
  const branch = await settledBranch(settling.settler, {
    repo: context.repo,
    businessId: context.businessId,
    step: split,
    part,
    choice,
    turn: context,
  });
  const start: WalkStart = { kind: "branch", step: split.id, branch };
  return unitOf(deps, {
    part,
    context,
    open,
    texts: settling.texts,
    choice: { ...choice, branch },
    graph,
    start,
    walked: walkFrom(graph, start),
    questions,
    why: { step: split.id, choice: branch },
  });
}

/** writesOf for one passed part (createWritesOf). */
async function walkWrites<Repo>(
  deps: WalkDeps<Repo>,
  part: PassedPart,
  context: CommitTurnContext<Repo>,
  open: OpenHolds,
): Promise<UnitWrites> {
  const { request } = context;
  if (request.input.kind !== "decided") throw new WalkRefusedError("notDecided");
  const { decided } = request.input;
  const { choice } = part;
  if (choice === null) throw new WalkNotBuiltError("verb", [part.part.verb]);
  if (choice.target.businessId !== context.businessId) throw new WalkRefusedError("businessNotInScope");
  // With no settler bound to the step an option names, the start is the choice's own, found before any read.
  const settler = settlerFor(deps, choice);
  const named = settler === null ? startOf(choice) : null;

  // The walk, on the turn's pinned graph, read afresh on every run: a step or branch it lacks is refused here.
  const flow = flowOfStep(choice.step, decided.context.flow);
  const pin = { hash: context.turn.bundleId.hash, build: context.turn.bundleId.build };
  const graph = flowGraphOf(await deps.bundles.flow(pin, flow), flow);
  const texts = decided.context.texts;
  if (settler !== null) {
    // Default 191 asks a settler only at a split step; one bound at a step with no branches is never asked.
    const split = graph.step(choice.step);
    if (isSplitStep(split)) {
      return settledWrites(deps, { part, context, open, texts, choice, graph, split, settler });
    }
  }
  const start = named ?? startOf(choice);
  const walked = walkFrom(graph, start);
  // An answer closes its question at the version the question's row is read at: with no read bound, it is not built.
  const questions = start.kind === "branch" ? questionsOf(deps, choice, start.step) : null;
  const why: Why = { step: choice.step, choice: choice.branch ?? choice.label };
  return unitOf(deps, { part, context, open, texts, choice, graph, start, walked, questions, why });
}

/**
 * The commit's writesOf port on the walk (types.ts CommitPorts): what a passed part writes, inside the call's business
 * scope, with no outside effect. Throws WalkRefusedError (refused, never guessed) or WalkNotBuiltError (notBuilt), so the
 * call fails closed with nothing written.
 */
export function createWritesOf<Repo = unknown>(deps: WalkDeps<Repo>): CommitPorts<Repo>["writesOf"] {
  return (part, turn, open) => walkWrites(deps, part, turn, open);
}
