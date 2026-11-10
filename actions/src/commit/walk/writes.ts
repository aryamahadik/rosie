// What a passed part writes (T-1139, C-087): the commit's writesOf port (types.ts CommitPorts). It walks the turn's
// pinned flow graph from the part's choice (walk.ts; arch 03 line 191) and hands back the rows the walk writes as K-05 v1's
// commit writes (UnitWrites): the state the steps change with their event-log entries, the question the walk stops at
// with its safe default (the commit adds its clock row and the other entries: build.ts), and the outbox row that asks it,
// with no plan (words go in after the commit: arch 01 line 41). For turn 1 these are exactly commit-s1-01.json's
// given.stated.writes (K-09 v1.5 default 136; ADR-013 section 4): S1-01's thread, S1-02's question and
// outbox-s1-02-sam-1.
//
// It only reads (the pinned graph, through its own port, and the call's request) and has no outside effect, since a
// repeated turn runs it again before K-05 answers repeated (STATE note 1; types.ts CommitPorts). Nothing here logs; what
// it throws names faults, step ids and keys (errors.ts), never words or the chat id.
//
// What it writes, step by step (each journey's lane extends the writers; anything else is notBuilt, nothing written):
//   - a plain step's gives: `thread` (S1-01) only, the handle's chat with Rosie's number (K-04 threads: kind chat, no
//     booking, the Linq chat id of the turn's last text, no reply address), with its `thread.created` entry, whose values
//     name the kind alone, never the chat id (K-09 v1.5 defaults 134 and 135);
//   - the split it stops at, when Rosie asks it of the turn's own writer by text (S1-02): one open question (no options,
//     no read-back, step 9's default clock: K-09 v1.5 default 134) with the card's safe default for its clock row, and
//     one quick reply on the turn's service (defaults 132 and 133).
// While anything is open (a safety hold, or a text not yet read), the walk stops at its first routine row (STATE note 1;
// DL-128 note a): the rows before it are written, that row and every row after it are not. A protective step's rows pass
// every hold; a safety-flow step's (A3-24, A3-25 and their twins) pass only an after-safe hold (hold.ts's lists).
//
// Defaults used (for ops/QUESTIONS.md), beside walk.ts's:
//   3. The row ids are K-09 v1.5 default 131's: `<kind>-<step>-<turn key>-<n>`, the writing step in lower case, n from 1
//      per kind and step in the walk's order, the turn key the turn's own id unless the binding names another (a proof
//      on a fixture names the fixture's stand-in, `sam`). The thread's entry is `log-<row id>-created`, T-305's rule.
//   4. The writer of the turn is the lane of the step the part entered when that step is written to Rosie (S1-01:
//      "owner -> san"), and a question the walk stops at goes to the turn's own handle and person (the request's caller)
//      only when Rosie asks it of that lane by text (S1-02: "san -> owner", via msg): a reply in the same turn, so a quick
//      reply (default 133). A question to anyone else is another journey's.
//   5. The thread's event-log entry names no business (a thread is the handle's across every business: MC C1; K-04
//      threads has no business), and is Rosie's, with the unit's why, in the zone the turn's texts were read in (build.ts
//      default 4).
//   6. The unit's why is the step the part's choice names, with the branch it chose or else the choice's label, as the
//      frontier offered it from the bundle (never the person's words).
//   7. The question's and the outbox row's business and booking are the choice's target's (the call's business, checked;
//      no booking for the sign-up door). The versions read are none: the door's walk reads no row (K-09 v1.5 default 134).

import type { Choice, SetupKey } from "../../gate/framework";
import { PROTECTIVE_STEPS, SAFETY_FLOW_STEPS, holdClassOf, isHeld, type HoldClass } from "../hold";
import type {
  Ask,
  CommitPorts,
  CommitTurnContext,
  EventEntry,
  GateAndCommitRequest,
  OpenHolds,
  OpenQuestionNew,
  OutboxRowNew,
  PassedPart,
  StateWrite,
  TurnRow,
  UnitWrites,
  Why,
} from "../types";
import { WalkNotBuiltError, WalkRefusedError } from "./errors";
import { flowGraphOf, flowOfStep, type FlowGraph, type FlowLetter, type GraphStep } from "./graph";
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

export interface WalkDeps {
  /** The pinned bundle's graphs: the walk's own dependency (DL-322 ruling 4), bound by T-1141. */
  readonly bundles: WalkBundles;
  /** Default 131's turn key, from the turn row. Default: the turn's own id. */
  readonly turnKey?: (turn: TurnRow) => string;
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

/** One step whose rows the walk writes: a plain step walked, or the split it stops at. */
interface Writing {
  readonly step: GraphStep;
  readonly as: "step" | "asks" | "waits";
}

/** The steps whose rows the walk writes, in order (a walk from a step: its plain steps, then the split it stops at). */
function writingOf(walked: Walked): Writing[] {
  const writing = walked.moves.map((move): Writing => {
    if (move.kind === "branch") throw new WalkNotBuiltError("answer", [move.split.id]);
    return { step: move.step, as: "step" };
  });
  const { stop } = walked;
  if (stop.kind === "asks" || stop.kind === "waits") writing.push({ step: stop.step, as: stop.kind });
  return writing;
}

/** The writer's lane (default 4): who the entered step is from, when it is written to Rosie (S1-01: owner). */
function writerLaneOf(graph: FlowGraph, start: WalkStart): string | null {
  const entered = graph.step(start.step);
  return entered !== null && entered.to === "san" ? entered.who : null;
}

/** Default 131's row ids for one walk: `<kind>-<step>-<turn key>-<n>`. */
function rowIds(turnKey: string): (kind: "thread" | "oq" | "outbox", stepId: string) => string {
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
interface Writer {
  readonly context: CommitTurnContext;
  readonly choice: Choice;
  readonly why: Why;
  /** The zone the turn's texts were read in (build.ts default 4). */
  readonly zone: string | null;
  readonly nextId: ReturnType<typeof rowIds>;
  /** The lane of the turn's writer (default 4), or null when the entered step names none. */
  readonly writerLane: string | null;
}

/** The part's writes, built row by row as the walk goes: every list present, empty when it has none. */
interface Built {
  readonly state: StateWrite[];
  readonly stateEvents: EventEntry[];
  readonly asks: Ask[];
  readonly messages: OutboxRowNew[];
  readonly gives: SetupKey[];
}

/** The rows of the steps a walk writes, in order; the turn's service and chat id are read once, when a row needs them. */
function writeRows(writer: Writer, writing: readonly Writing[]): Built {
  const built: Built = { state: [], stateEvents: [], asks: [], messages: [], gives: [] };
  const { context, choice } = writer;
  let source: TextSource | undefined;
  const text = (): TextSource => (source ??= textSourceOf(context.request));

  /** S1-01 gives thread: the handle's chat with Rosie's number, and its entry (defaults 134, 135; default 5). */
  const thread = (step: GraphStep): void => {
    const { service, chatId } = text();
    if (!LINQ_SERVICES.includes(service)) throw new WalkNotBuiltError("threadByEmail", [step.id]);
    const id = writer.nextId("thread", step.id);
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
      zone: writer.zone,
      businessId: null,
      actorKind: "rosie",
      actorPersonId: null,
      actorRole: null,
      tableName: "threads",
      rowId: id,
      oldValues: null,
      newValues: { kind: "chat" },
      sealed: null,
      why: whyEntry(writer.why),
      approvedBy: null,
      proofs: null,
    });
    if (!built.gives.includes(THREAD)) built.gives.push(THREAD);
  };

  /** A plain step's rows: its gives (the thread alone); a message no question carries is not built. */
  const plain = (step: GraphStep): void => {
    if (step.tells.length > 0) throw new WalkNotBuiltError("tells", [step.id]);
    for (const key of step.gives) {
      if (key !== THREAD) throw new WalkNotBuiltError("gives", [step.id, key]);
      thread(step);
    }
  };

  /** The split the walk stops at, asking the turn's writer (default 4): its question and the quick reply asking it. */
  const asked = (step: GraphStep): void => {
    if (
      step.who !== "san" ||
      step.via !== "msg" ||
      writer.writerLane === null ||
      step.to !== writer.writerLane
    ) {
      throw new WalkNotBuiltError("recipient", [step.id]);
    }
    if (step.buttons > 0) throw new WalkNotBuiltError("buttons", [step.id]);
    const { card } = step;
    if (card === null) throw new WalkRefusedError("stepNotWellFormed", [step.id]);
    if (card.clock?.from !== "step9Default") throw new WalkNotBuiltError("clock", [step.id]);
    const { service } = text();
    const { target } = choice;
    const { personId } = context.request.caller;
    const question: OpenQuestionNew = {
      id: writer.nextId("oq", step.id),
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
    built.asks.push({ question, safeDefault: card.safeDefault });
    built.messages.push({
      id: writer.nextId("outbox", step.id),
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

  for (const each of writing) {
    if (each.as === "waits") throw new WalkNotBuiltError("waits", [each.step.id]);
    if (each.as === "asks") asked(each.step);
    else plain(each.step);
  }
  return built;
}

/** writesOf for one passed part (createWritesOf). */
async function walkWrites(
  deps: WalkDeps,
  part: PassedPart,
  context: CommitTurnContext,
  open: OpenHolds,
): Promise<UnitWrites> {
  const { request } = context;
  if (request.input.kind !== "decided") throw new WalkRefusedError("notDecided");
  const { decided } = request.input;
  const { choice } = part;
  if (choice === null) throw new WalkNotBuiltError("verb", [part.part.verb]);
  if (choice.target.businessId !== context.businessId) throw new WalkRefusedError("businessNotInScope");
  const start = startOf(choice);

  // The walk, on the turn's pinned graph, read afresh on every run: a step or branch it lacks is refused here.
  const flow = flowOfStep(choice.step, decided.context.flow);
  const pin = { hash: context.turn.bundleId.hash, build: context.turn.bundleId.build };
  const graph = flowGraphOf(await deps.bundles.flow(pin, flow), flow);
  const walked = walkFrom(graph, start);
  if (start.kind === "branch") throw new WalkNotBuiltError("answer", [start.step]);

  // What is open stops the walk at its first routine row (STATE note 1).
  const writing = writingOf(walked);
  const heldAt = firstHeld(
    writing.map((each) => each.step.id),
    holdClassOf(part.part, choice),
    open,
  );

  const turnKey = (deps.turnKey ?? ((turn: TurnRow) => turn.id))(context.turn);
  if (turnKey === "") throw new WalkRefusedError("noTurnKey");
  const why: Why = { step: choice.step, choice: choice.branch ?? choice.label };
  const writer: Writer = {
    context,
    choice,
    why,
    zone: decided.context.texts[0].sentAt.zone,
    nextId: rowIds(turnKey),
    writerLane: writerLaneOf(graph, start),
  };
  const built = writeRows(writer, heldAt === null ? writing : writing.slice(0, heldAt));
  return {
    why,
    versionsRead: [],
    state: built.state,
    stateEvents: built.stateEvents,
    asks: built.asks,
    closes: [],
    clockCancels: [],
    messages: built.messages,
    reservations: { confirm: [], release: [] },
    effects: { write: [], letGo: [] },
    gives: built.gives,
  };
}

/**
 * The commit's writesOf port on the walk (types.ts CommitPorts): what a passed part writes, inside the call's business
 * scope, with no outside effect. Throws WalkRefusedError (refused, never guessed) or WalkNotBuiltError (notBuilt), so the
 * call fails closed with nothing written.
 */
export function createWritesOf<Repo = unknown>(deps: WalkDeps): CommitPorts<Repo>["writesOf"] {
  return (part, turn, open) => walkWrites(deps, part, turn, open);
}
