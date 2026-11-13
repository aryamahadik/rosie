// The turn loop, first half (T-251; C-046; arch 02 steps 3 to 6, architecture.txt lines 115 to 121): the work the lease
// (T-248) runs for each run of a turn, on the bundle pinned for it (T-249), whose commit the safety holds bind (T-1088).
// One turn at a time per handle is the lease's own rule: a batch that closes once this turn has begun its commit waits
// for the next turn, and this loop takes no lock of its own.
//
//   1. Open: the handle's directory names the handle (K-04) and the zone its dates resolve in; the turn opens its sealed
//      texts with the handle's key (the inbox never does) and reads each one as K-02's text.
//   2. Guard (T-250, ../guard): keyword texts by code alone, then the handle's targets for the rest.
//   3. Keyword texts (K-09 README defaults 10 and 35): T-267's `replyToKeywords` records them through `turnReplyCore`
//      (./keywords), and their core actions ride in this turn's one commit after each text's recordSafetyOutcome: alone,
//      input coreOnly; beside decided texts, with the decided input (step 6). When its result says rerun, the turn runs
//      them again (at most `KEYWORD_RUNS` in a run). A fixed line's row is never composed. They never wait for a missing
//      safety result (ADR-015 section 3): the run goes on with that text left out of the records. Nor does a STOP wait
//      for the decided part (DL-508, DL-521; arch 06 line 329: a change that only protects commits at once), since a park
//      records no core action (K-05 v1 parkTurn). So the keyword texts commit core-only on the run whose targets read,
//      frontier, decide or re-read fails while a result is missing or one of them is a stop word, and on the run whose
//      decided request the gate refuses on its tries when one of them is a stop word (`commitKeywords`). START and HELP
//      alone, with every result present, keep the lease's retry, which may find the decided part ready.
//   4. Frontier (K-09 buildFrontier): the other texts, with the guard's targets, give K-02's context. Its span is the
//      turn's, unless the turn face records the hop itself (`recordsFrontierSpan`, CQ-159: the Tool API base's span).
//   5. Decide (K-02, the AI layer's two reads). When the reads disagree on a part, or a part is unmapped, the one Sonnet
//      re-read runs before anything goes to the gate (Q-41's default: one re-read, then one question; never a commit on a
//      difference). When nothing fits, meaning search adds the closest entries (K-09 closestEntries) and the re-read runs
//      on them. The re-read runs at most once per run of the turn.
//   6. Gate and commit (K-09 gateAndCommit), through the lease's commit: the request goes out with the lease's
//      CommitContext (the holds open and the texts not read yet at commit time) on unchanged, and the gate holds what they
//      hold (CQ-65; T-305). A limit that fails stops only its own choice: the turn takes the commit as it comes. A
//      `valueFailsWords` refusal before the re-read (K-09 README default 25) sends the turn to the re-read, then to the
//      gate again; an answer lost on the way (`noAnswer`) or a `transient` one is sent again once, as the same request.
//
//   7. Reply (T-252, ./compose.ts; arch 02 step 7, line 123): once the turn has committed, each row the commit wrote is
//      composed, the rows in parallel (compose input, the composer, finalize with at most one rewrite, the fallback and
//      the passed-on line inside finalize), an email copy takes its text row's plan with no composer call, a fixed
//      line's row is never composed, and the dispatcher is woken once. A run no longer the turn's composes nothing: the
//      run that has the turn now does it.
//
// Fails closed: a run that cannot finish one of steps 1 to 6 commits nothing and ends, but for the keyword texts step 3
// commits core-only; the lease reruns the turn from its sealed texts when its 60 s lapse, and parks it after a third
// lapse with no commit (T-253, ./park.ts: K-05 v1 parkTurn, its one "nothing changed" row, the dispatcher woken). Never
// logged or put in a span: a text's words, a plan's words, a number, a key (K-08 README line 79); the spans hold counts,
// labels and ids only.
//
// The crash path after the commit (T-253; arch 11 line 576): the commit goes through the lease with `reply`, so the
// committed turn keeps its lease until step 7 has ended, when every row the commit wrote holds a plan or is closed and the
// dispatcher was woken (`replied`). A run that crashes before then, or whose rows did not all get a plan, leaves the lease
// to lapse: the turn reruns from its sealed texts, its commit answers repeated (K-05 v1 commitTurn), and step 7 composes
// only the rows with no plan (K-05 unplannedRows), from today's record; the dispatcher sends unsent parts under their
// stored keys (K-07), never a new key for a part it has.
//
// The AI provider down (T-271; C-174; arch 11 line 564; ../outage/ai): when decide or the one re-read answers that the
// models are down (the AI gateway's `modelsDown`, after its own retry and the other model, T-361) and nothing has
// committed, the run ends saying who waits (`aiDown`), and the lease's `runTurn` runs the turn through the AI-down path:
// each waiting text gets the outage line once, never to a stopped number, and the turn runs again every 30 s until it
// commits. Only a turn with no stop word waits there for the models' return. A turn holding one never does (DL-508,
// DL-521; arch 06 line 329): whatever the models answer, its keyword texts commit on the run, core-only on the run that
// finds the models down, with the safety records the run has (step 3). Such a turn waits only when that commit does not
// go through, and then for the core, not the models: on a later try it commits core-only while they are still down, or
// with the decided input once they are back (a run's first keyword commit carries it: `commitKeywords`). Either way its
// one commit carries the core actions in the return order (`coreOf`): every text's safety record, the danger texts'
// first, then the stop and start records, then the rest; the decided parts follow them (C-087). After the commit no
// outage line goes: a model call that fails then takes step 7's path for its row (./compose.ts).
//
// Not here: the planner after meaning search (C-117: `planner` is null); the safety read (T-246); wiring the real Tool
// API, AI, K-05 and dispatcher calls into the ports (D-017, T-552 onward).

import type {
  CommitAnswer,
  CommitContext,
  CommitTurnAnswer,
  CommitTurnRef,
  CommitTurnRequest,
  LeasedTurn,
  LeaseHooks,
} from "../actor";
import {
  actorNameOf,
  openWords,
  wordsOfEvent,
  type HandleRef,
  type SealedWords,
  type SealingKey,
} from "../gateway/seal";
import type { SealedEvent } from "../gateway/types";
import {
  guardTurn,
  replyToKeywords,
  type CoreCommitAnswer,
  type CoreCommitRequest,
  type GuardResult,
  type GuardText,
  type KeywordText,
  type RepliesResult,
  type ReplyCoreResult,
} from "../guard";
import {
  inReturnOrder,
  MODELS_DOWN,
  runThroughOutage,
  type OutageReport,
  type WaitingTurn,
} from "../outage/ai";
import { dangerOutcomes, isReadableEvent } from "../safety";
import type { SafetyResult } from "../safety/types";
import { isLabel, type Outcome, type SpanFacts, type TraceContext } from "../trace";
import type { LimitResult, ModelCall, RowRef } from "../trace/types";
import { composeCommitted, type ComposeReport } from "./compose";
import { withKeywordCommit } from "./keywords";
import { parkThroughRows } from "./park";
import type {
  BuildFrontierRequest,
  CoreAction,
  DecideAnswer,
  DecideContext,
  DecidedInput,
  DecideResult,
  GateAndCommitRequest,
  GateCommitted,
  PartResult,
  RecordSafetyOutcomeAction,
  RereadWhy,
  ToolApiError,
  TurnCaller,
  TurnDeps,
  TurnParty,
  TurnText,
} from "./types";

/** How many times a run of a turn runs its keyword texts when the replies ask for it again. */
export const KEYWORD_RUNS = 3;

let deps: TurnDeps | null = null;

/** Sets what the turn reaches outside the actor for this Worker isolate; returns the function that puts the earlier one back. */
export function setTurnDeps(next: TurnDeps | null): () => void {
  const before = deps;
  deps = next;
  return () => {
    deps = before;
  };
}

// ---- what a run ends with -----------------------------------------------------------------------------------------

/** One of the turn's texts, opened: its words for the guard (never logged), and its K-02 form for the frontier. */
export interface OpenedText extends GuardText {
  /** K-02's text; null for an event K-02 has no text for (a vote taken back). */
  readonly text: TurnText | null;
  /** True when the safety read reads it, so it carries a recordSafetyOutcome in the turn's commit. */
  readonly readable: boolean;
}

/** The turn committed (first or repeated): the gate's answer, with each part's result (a stopped choice stops only itself). */
export interface TurnCommitted {
  readonly result: "committed";
  readonly answer: GateCommitted;
  /** True when the one re-read ran. */
  readonly reread: boolean;
  /** How many gateAndCommit calls the run made. */
  readonly gateCalls: number;
  /** The keyword texts' replies, when the turn had keyword texts. */
  readonly replies: RepliesResult<OpenedText> | null;
  /**
   * What the second half did after the commit (T-252): each row composed, copied, found planned or left, the fixed
   * lines' rows never composed, and the dispatcher woken once. Null when the run was no longer the turn's by then.
   */
  readonly composed: ComposeReport | null;
}

/** Nothing committed on this run (the lease reruns the turn when its lease lapses); `why` is a label. */
export interface TurnNotCommitted {
  readonly result: "notCommitted";
  readonly why: string;
  readonly gateCalls: number;
  readonly replies: RepliesResult<OpenedText> | null;
  /**
   * Set when the AI gateway reported the models down (decide or the one re-read answered `modelsDown`) and nothing
   * committed: who waits, for the AI-down path's outage line and retries (T-271, ../outage/ai).
   */
  readonly aiDown?: WaitingTurn;
}

export type TurnOutcome = TurnCommitted | TurnNotCommitted;

// ---- the commit through the lease -------------------------------------------------------------------------------

/**
 * What the turn hands the lease's commit in `writes`: K-09's gateAndCommit request and the turn's trace. The lease reads
 * only the request's turn id (and refuses a replaced or parked turn); its commit hook (`commitThroughToolApi`) sends the
 * request on with the lease's CommitContext. Only carriers this module made are taken (a WeakSet), so nothing else rides
 * into the gate this way.
 */
interface GateCommit {
  readonly via: "gateAndCommit";
  readonly request: GateAndCommitRequest;
  readonly trace: TraceContext;
}

const carriers = new WeakSet<GateCommit>();

function leaseRequestOf(request: GateAndCommitRequest, trace: TraceContext): CommitTurnRequest {
  const carrier: GateCommit = { via: "gateAndCommit", request, trace };
  carriers.add(carrier);
  // lease.ts's commit request was written for K-05's, before the gate moved into the Tool API (T-305): the turn, no
  // versions read by the turn itself (the gate reads them), and the gate's request.
  return { turn: request.turn, versionsRead: [], writes: carrier };
}

function gateCommitOf(request: CommitTurnRequest): GateCommit | null {
  const writes = request.writes as GateCommit;
  if (typeof writes !== "object" || !carriers.has(writes)) return null;
  return writes.request.turn.id === request.turn.id ? writes : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string";

/** K-09's committed answer, as far as the turn reads it; null when the answer is not one. */
function committedOf(value: unknown): GateCommitted | null {
  if (!isRecord(value) || value.result !== "committed") return null;
  if (!isText(value.turnId) || !isText(value.committedAt) || typeof value.repeated !== "boolean") return null;
  if (!Array.isArray(value.parts) || !Array.isArray(value.core)) return null;
  const written = value.written;
  if (!isRecord(written) || !Array.isArray(written.written) || !Array.isArray(written.outboxRows))
    return null;
  return value as GateCommitted;
}

function isToolApiError(value: unknown): value is ToolApiError {
  return isRecord(value) && isText(value.error);
}

/**
 * The lease's commit hook (`LeaseHooks.commit`): K-09 gateAndCommit through the Tool API, with the lease's CommitContext
 * passed on unchanged. A committed answer goes back to the lease as committed (its turn finishes and the next turn may
 * open), with K-09's answer in `committed`; an error goes back as it came (nothing written). A throw is the lease's
 * `noAnswer`: the turn may have committed, so the same request is sent again.
 */
export async function commitThroughToolApi(
  request: CommitTurnRequest,
  at: CommitContext,
): Promise<CommitTurnAnswer> {
  const carrier = gateCommitOf(request);
  if (carrier === null) return { error: "notGateAndCommit" };
  const set = deps;
  if (set === null) return { error: "unwired" };
  const answer: unknown = await set.toolApi.gateAndCommit(carrier.request, at, carrier.trace);
  const committed = committedOf(answer);
  if (committed !== null) {
    if (committed.turnId !== request.turn.id) return { error: "badAnswer" };
    return {
      result: "committed",
      turnId: committed.turnId,
      committedAt: committed.committedAt,
      repeated: committed.repeated,
      committed,
    };
  }
  return isToolApiError(answer) ? answer : { error: "badAnswer" };
}

// ---- one run of a turn ------------------------------------------------------------------------------------------

/** What one run of a turn holds while it goes. */
interface Run {
  readonly turn: LeasedTurn;
  readonly set: TurnDeps;
  readonly handle: HandleRef;
  readonly party: TurnParty;
  readonly opened: readonly OpenedText[];
  /** Each readable text's safety result, by event id. */
  readonly safety: ReadonlyMap<string, SafetyResult>;
  readonly caller: TurnCaller;
  readonly ref: CommitTurnRef;
  readonly trace: TraceContext;
  gateCalls: number;
  rereadRan: boolean;
  /** How many commits the keyword texts' replies asked for. */
  keywordCommits: number;
  /** The last committed answer, once the turn has committed. */
  committed: GateCommitted | null;
  /** The caller that commit went under (a turn of keyword texts alone covers every business): the second half's too. */
  committedCaller: TurnCaller | null;
  /** True once decide or the re-read answered that the models are down (`modelsDown`, T-271). */
  modelsDown: boolean;
  /**
   * True when one of the turn's keyword texts is a stop word: no outage line goes to the handle (T-271), and the keyword
   * texts never wait for the decided part, committing core-only on the run that cannot make it (DL-508, DL-521).
   */
  readonly stopAsked: boolean;
}

/**
 * True once this run is no longer the turn's: a restart replaced the turn, or its lapse started a rerun (the lease aborts
 * the run's signal). Read through a call, so it is read afresh after every wait.
 */
function replaced(turn: LeasedTurn): boolean {
  return turn.signal.aborted;
}

function notCommitted(
  run: Run | null,
  why: string,
  replies: RepliesResult<OpenedText> | null = null,
): TurnNotCommitted {
  const ended: TurnNotCommitted = { result: "notCommitted", why, gateCalls: run?.gateCalls ?? 0, replies };
  // The models were down and nothing committed: the AI-down path tells the waiting texts and runs the turn again (T-271).
  if (run !== null && run.modelsDown && run.committed === null) return { ...ended, aiDown: waitingOf(run) };
  return ended;
}

/**
 * The run's texts as the AI-down path reads them (T-271): the handle, and each text the person wrote (the kinds the safety
 * read reads), with its own trace id and whether the safety read's timeout rule gave it the outage line already.
 */
function waitingOf(run: Run): WaitingTurn {
  const traces = new Map(run.turn.entries.map((entry) => [entry.event.eventId, entry.traceId]));
  return {
    actorName: actorNameOf(run.handle),
    handleId: run.party.handleId,
    businessId: run.party.businessId,
    personId: run.party.personId,
    texts: run.opened
      .filter((text) => text.readable)
      .map((text) => ({
        eventId: text.eventId,
        traceId: traces.get(text.eventId) ?? run.turn.traceId,
        lined: outageLineWent(run.safety.get(text.eventId)),
      })),
    stopAsked: run.stopAsked,
  };
}

/**
 * True when a text's safety result is the timeout marker with no danger word (K-02 v1: `timedOut`, no read): the safety
 * read's timeout rule sent it the outage line (arch 02 line 111: "otherwise the outage line").
 */
function outageLineWent(result: SafetyResult | undefined): boolean {
  return result !== undefined && result.timedOut && result.dangerWords.length === 0;
}

/** Notes a decide stage's answer that the AI gateway gave up on both models (T-361's typed `modelsDown`). */
function noteModelsDown(run: Run, answer: DecideAnswer): void {
  if (!("result" in answer) && answer.error === MODELS_DOWN) run.modelsDown = true;
}

/**
 * Runs one run of a turn, steps 1 to 6 above, and says how it ended. Never throws for an outside failure: a step that
 * cannot finish ends the run with nothing committed (`notCommitted`, its label).
 */
export async function runTurnLoop(turn: LeasedTurn): Promise<TurnOutcome> {
  const set = deps;
  if (set === null) return notCommitted(null, "unwired");
  const first = turn.entries[0];
  if (first === undefined) return notCommitted(null, "noTexts");
  const handle = first.event.handle;

  let party: TurnParty | null;
  try {
    party = await set.directory.partyOf({ actorName: actorNameOf(handle), handle });
  } catch {
    return notCommitted(null, "noDirectory");
  }
  if (party === null) return notCommitted(null, "unknownHandle");
  if (replaced(turn)) return notCommitted(null, "replaced");

  let opened: OpenedText[];
  try {
    opened = await openTexts(turn, set, party.zone);
  } catch {
    return notCommitted(null, "unopened");
  }
  if (replaced(turn)) return notCommitted(null, "replaced");

  let guarded: GuardResult<OpenedText>;
  try {
    guarded = await guardTurn({
      handleId: party.handleId,
      texts: opened,
      bundle: turn.bundle,
      trace: turn.trace,
    });
  } catch {
    // The pinned bundle holds no keyword list the guard can read: nothing is split and nothing reaches decide.
    return notCommitted(null, "noKeywords");
  }
  if (replaced(turn)) return notCommitted(null, "replaced");

  let safety: Map<string, SafetyResult>;
  try {
    safety = await safetyOf(turn, opened);
  } catch {
    safety = new Map();
  }
  if (replaced(turn)) return notCommitted(null, "replaced");

  const caller: TurnCaller = {
    kind: "turn",
    turnId: turn.turnId,
    requestId: turn.turnId,
    businessId: party.businessId,
    personId: party.personId,
    traceId: turn.traceId,
  };
  const run: Run = {
    turn,
    set,
    handle,
    party,
    opened,
    safety,
    caller,
    ref: {
      id: turn.turnId,
      handleId: party.handleId,
      eventIds: [...turn.eventIds],
      bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      traceId: turn.traceId,
      joinedTraceIds: [...turn.joinedTraceIds],
      tries: turn.tries,
    },
    trace: turn.trace,
    gateCalls: 0,
    rereadRan: false,
    keywordCommits: 0,
    committed: null,
    committedCaller: null,
    modelsDown: false,
    stopAsked: guarded.keywords.some((found) => found.keyword.kind === "stop"),
  };

  const { keywords, onward } = guarded;
  // Keyword texts alone: their own core-only turn, which never waits on the frontier, decide or a re-read (default 35).
  if (onward === null) return keywordTurn(run, keywords, null);

  // The texts that go to decide, as K-02 reads them. None (only events K-02 has no text for): nothing is decided, and the
  // turn still commits once, closing it.
  const texts = onward.texts.map((text) => text.text).filter((text): text is TurnText => text !== null);
  if (texts.length === 0) {
    if (keywords.length > 0) return keywordTurn(run, keywords, null);
    return outcomeOf(run, await commitCoreOnly(run, run.caller, []), null);
  }

  // Every text of a turn that is decided carries its safety record in the commit (K-09 README default 5), so a turn with
  // no keyword texts ends here while a result is missing. Keyword texts never wait for one (ADR-015 section 3): the run
  // goes on with that text left out of the records, and the commit holds every routine part while it is unread.
  const missing = opened.some((text) => text.readable && !safety.has(text.eventId));
  if (missing && keywords.length === 0) return notCommitted(run, "noSafetyResult");
  // When the decided part cannot be made on this run, the keyword texts commit at once through `keywordTurn` with no
  // decided input (core-only, with the records the run has) if a result is missing, which a rerun would find missing
  // again, or if one of them is a stop (DL-508; arch 06 line 329: a change that only protects commits at once), since a
  // park records no core action (K-05 v1 parkTurn). Keyword texts that are START or HELP only, with every result
  // present, keep the lease's retry, which may find the decided part ready. (A decided request the gate refuses on its
  // tries is `commitKeywords`' to answer: a stop commits core-only there, DL-521.)
  const keywordsAtOnce = keywords.length > 0 && (missing || run.stopAsked);
  // The targets read failed: nothing may reach decide on this run (the frontier needs the targets).
  if (onward.read === "failed") {
    return keywordsAtOnce ? keywordTurn(run, keywords, null) : notCommitted(run, onward.errorCode);
  }

  const prepared = await prepareDecided(run, texts, onward.targets);
  if ("result" in prepared) return keywordsAtOnce ? keywordTurn(run, keywords, null) : prepared;
  // Keyword texts beside decided ones ride in the same one commit (K-09 README default 10).
  if (keywords.length > 0) return keywordTurn(run, keywords, prepared);
  return outcomeOf(run, await commitDecided(run, prepared, []), null);
}

/**
 * One run of a turn through the AI-down path (T-271, ../outage/ai): the turn loop, and while it ends with the models down
 * and nothing committed, the outage line once to each waiting text (never to a stopped number) and the turn again every
 * 30 s, for as long as its lease holds; the lease's lapse reruns it then. With the AI-down path unwired, one run.
 */
export function runTurnThroughOutage(turn: LeasedTurn): Promise<OutageReport<TurnOutcome>> {
  return runThroughOutage(turn, () => runTurnLoop(turn));
}

/** The lease's `runTurn`: a run of a turn (its outcome is the lease's to act on: committed, or a rerun at its lapse). */
export async function runTurn(turn: LeasedTurn): Promise<void> {
  await runTurnThroughOutage(turn);
}

/**
 * The turn loop as the lease's hooks: D-017 hands them to `setLeaseHooks` (and `turnReplyCore` to `setReplyDeps`). The park
 * after a third lapse with no commit goes through the turn's K-05 face (T-253, ./park.ts).
 */
export const turnHooks: Required<LeaseHooks> = {
  runTurn,
  commit: commitThroughToolApi,
  park: (turn) => parkThroughRows(deps, turn),
};

// ---- 1. opening the texts ---------------------------------------------------------------------------------------

/**
 * Opens each text's sealed words with the handle's key and reads its K-02 form, in arrival order. The words are read by
 * the box's form (K-06 v1.2 items 5 and 6, `wordsOfEvent`): a form 2 box gives every word, a vote's option words among
 * them, and only the box; an event kept before v1.2 gives its form 1 box's body and subject and a vote's plain option
 * words. A box that does not open, or whose members are not its form's, throws, and the run fails closed.
 */
async function openTexts(turn: LeasedTurn, set: TurnDeps, zone: string): Promise<OpenedText[]> {
  const keys = new Map<string, SealingKey>();
  const opened: OpenedText[] = [];
  for (const entry of turn.entries) {
    const event = entry.event;
    let box: SealedWords | null = null;
    if (event.sealed !== null) {
      const name = actorNameOf(event.handle);
      let key = keys.get(name);
      if (key === undefined) {
        key = await set.keys.getOrCreateKey(event.handle);
        keys.set(name, key);
      }
      box = await openWords(event.sealed, key, name, event.eventId);
    }
    const words = wordsOfEvent(event, box);
    opened.push({
      eventId: event.eventId,
      kind: event.kind,
      words,
      text: turnTextOf(event, words, zone),
      readable: isReadableEvent(event),
    });
  }
  return opened;
}

/** The words a text gives decide: its body, or an email's subject when the body has none (as the guard reads them). */
function wordsOf(words: SealedWords | null): string {
  const body = words?.body ?? null;
  if (body !== null && body !== "") return body;
  return words?.subject ?? body ?? "";
}

function attachmentsOf(value: unknown): TurnText["attachments"] {
  if (!Array.isArray(value)) return [];
  const attachments: TurnText["attachments"] = [];
  for (const item of value as unknown[]) {
    if (isRecord(item) && isText(item.attachmentId) && isText(item.mediaType)) {
      attachments.push({ attachmentId: item.attachmentId, mediaType: item.mediaType });
    }
  }
  return attachments;
}

/**
 * K-02's text for one stored event (K-06): a text, a photo's caption or an edit's new words is a text; a vote is a
 * pollVote with its option's words, as `wordsOfEvent` read them (from a form 2 box only; a vote kept before K-06 v1.2
 * from its plain poll.optionWords); a reaction is a tapback named by its reaction. Its send time is the sender's (K-06
 * sentAt), with the zone dates resolve in. Null for an event K-02 has no text for.
 */
function turnTextOf(event: SealedEvent, words: SealedWords | null, zone: string): TurnText | null {
  const utc = isText(event.sentAt) ? event.sentAt : isText(event.receivedAt) ? event.receivedAt : null;
  if (utc === null) return null;
  const sentAt = { utc, zone };
  const attachments = attachmentsOf(event.attachments);
  const base = { eventId: event.eventId, sentAt, attachments };
  switch (event.kind) {
    case "text":
    case "photo":
    case "edit":
      return { ...base, kind: "text", words: wordsOf(words), poll: null, tapback: null };
    case "pollVote": {
      const poll = event.poll;
      const optionWords = words?.optionWords ?? null;
      if (!isRecord(poll) || !isText(poll.pollId) || !isText(poll.optionId) || !isText(optionWords))
        return null;
      const vote = { pollId: poll.pollId, optionId: poll.optionId };
      return { ...base, kind: "pollVote", words: optionWords, poll: vote, tapback: null };
    }
    case "reaction": {
      const reaction = event.reaction;
      if (!isRecord(reaction) || !isText(reaction.reaction) || !isText(reaction.onMessageId)) return null;
      const tapback = { reaction: reaction.reaction, onMessageId: reaction.onMessageId };
      return { ...base, kind: "tapback", words: reaction.reaction, poll: null, tapback };
    }
    default:
      return null;
  }
}

/**
 * Each readable text's safety result, by event id, read through the run's leased turn from the handle's own actor, where
 * the read on arrival kept it (ADR-015 section 3); a result for another text is not taken.
 */
async function safetyOf(turn: LeasedTurn, opened: readonly OpenedText[]): Promise<Map<string, SafetyResult>> {
  const wanted = opened.filter((text) => text.readable).map((text) => text.eventId);
  const found = new Map<string, SafetyResult>();
  if (wanted.length === 0) return found;
  for (const result of await turn.resultsOf(wanted)) {
    if (wanted.includes(result.eventId) && !found.has(result.eventId)) found.set(result.eventId, result);
  }
  return found;
}

/**
 * Each text's recordSafetyOutcome under `caller` (K-09 README default 5), the danger texts' first, then the others, each
 * in arrival order (the return order: "danger words are read first", S12-12; T-271); a text with none is left out.
 */
function safetyRecords(run: Run, caller: TurnCaller): RecordSafetyOutcomeAction[] {
  const records: RecordSafetyOutcomeAction[] = [];
  for (const text of run.opened) {
    const result = run.safety.get(text.eventId);
    if (!text.readable || result === undefined) continue;
    records.push({
      call: "recordSafetyOutcome",
      request: {
        caller: { ...caller },
        safety: result,
        handleId: run.party.handleId,
        bookingId: null,
        sentByActor: null,
      },
    });
  }
  return inReturnOrder(records, (record) => (isDanger(record.request.safety) ? "danger" : "rest"));
}

/** True when a text's safety result found danger: an outcome other than No (a danger word's Unsure included). */
function isDanger(result: SafetyResult): boolean {
  const outcomes: unknown = result.outcomes;
  return Array.isArray(outcomes) && dangerOutcomes(outcomes as SafetyResult["outcomes"]).length > 0;
}

/**
 * The turn's core actions in the return order (arch 11 line 564; T-271): every text's safety record, the danger texts'
 * first; then the keyword texts' actions, the stop and start records first ("stops next", S12-12), each in its order. The
 * records always come first (K-09 README default 5), and the commit writes the decided parts after the core (C-087).
 */
function coreOf(run: Run, caller: TurnCaller, actions: readonly CoreAction[]): CoreAction[] {
  const keyword = inReturnOrder(actions, (action) => (action.call === "recordStopOrStart" ? "stop" : "rest"));
  return [...safetyRecords(run, caller), ...keyword];
}

// ---- 3. keyword texts ---------------------------------------------------------------------------------------------

/**
 * The guard's keyword texts through T-267's replies, their core actions committed by this turn (`commitKeywords`): alone,
 * input coreOnly (default 35); beside decided texts, in the same one commit (default 10), or core-only with no decided
 * input (`decided` null) when the run cannot make the decided part while a result is missing or one of them is a stop
 * word (ADR-015 section 3; DL-508). A turn holding a stop word whose decided request the gate refuses on its tries
 * commits them core-only on this run too (DL-521). When the replies ask for the turn to run again, they run again, at
 * most `KEYWORD_RUNS` times in this run. If no keyword text could become a core action at all (each one refused before
 * any commit, such as a STOP from a handle with no number), the turn commits what it has, so it still closes once. A
 * reply that recorded nothing (the replies not wired, or no commit answered) never lets the turn close without it: the
 * run ends with nothing committed, and the lease runs the turn again.
 */
async function keywordTurn(
  run: Run,
  keywords: readonly KeywordText<OpenedText>[],
  decided: DecidedInput | null,
): Promise<TurnOutcome> {
  const { turn, party, handle } = run;
  const committer = { commit: (request: CoreCommitRequest) => commitKeywords(run, request, decided) };
  const replies = await withKeywordCommit(turn.turnId, committer, async () => {
    let last: RepliesResult<OpenedText> | null = null;
    for (let runs = 1; runs <= KEYWORD_RUNS && !replaced(turn); runs += 1) {
      last = await replyToKeywords({
        turnId: turn.turnId,
        handleId: party.handleId,
        phoneNumber: handle.kind === "phone" ? handle.address : null,
        personId: party.personId,
        traceId: turn.traceId,
        keywords,
        bundle: turn.bundle,
        trace: turn.trace,
      });
      if (!last.rerun) break;
    }
    return last;
  });
  if (replies === null || replaced(turn)) return notCommitted(run, "replaced", replies);
  const noneRecordable = replies.replies.every((reply) => reply.outcome === "refused");
  if (run.keywordCommits === 0 && noneRecordable) {
    const sent =
      decided === null
        ? await commitCoreOnly(run, keywordCaller(run), [])
        : await commitDecided(run, decided, []);
    return outcomeOf(run, sent, replies);
  }
  if (run.committed !== null) return finishCommitted(run, run.committed, replies);
  return notCommitted(run, "notRecorded", replies);
}

/** The caller of a turn of keyword texts: a STOP, a START and HELP cover every business (RULES 7.2; stop-recorded.json). */
const keywordCaller = (run: Run): TurnCaller => ({ ...run.caller, businessId: null });

/**
 * The replies' commitCore for this turn: each text's recordSafetyOutcome first, then the keyword texts' core actions, in
 * one gateAndCommit through the lease, with the decided input when the turn has one. The replies are answered K-09's core
 * results for their own actions only.
 *
 * A turn holding a stop word never waits on the decided part (DL-521, after DL-508; arch 06 line 329): when the gate
 * refuses the decided request on its tries (its one resend, and for `valueFailsWords` the one re-read), the keyword
 * texts commit core-only on this run instead, under the replies' own caller, as a turn of keyword texts alone does,
 * since a park records no core action (K-05 v1 parkTurn). Such a turn sends its decided input on the run's first keyword
 * commit only: a later one (the replies' rerun) follows either that refusal, so it never waits on the decided part again,
 * or a commit, whose repeat answers the first commit whatever its body (K-05 v1 item 1); so it is core-only at once.
 * START and HELP alone keep the decided input on every commit, and the lease's retry.
 */
async function commitKeywords(
  run: Run,
  request: CoreCommitRequest,
  decided: DecidedInput | null,
): Promise<CoreCommitAnswer> {
  if (request.caller.turnId !== run.turn.turnId) return { error: "wrongTurn" };
  const coreOnly = (): Promise<Sent> => commitCoreOnly(run, { ...request.caller }, request.actions);
  const input = run.stopAsked && run.keywordCommits > 0 ? null : decided;
  run.keywordCommits += 1;
  const first = input === null ? await coreOnly() : await commitDecided(run, input, request.actions);
  const stopAtOnce = first.kind === "refused" && input !== null && run.stopAsked && !replaced(run.turn);
  const sent = stopAtOnce ? await coreOnly() : first;
  if (sent.kind === "refused") return { error: sent.error };
  // K-09 answers each core action's result at its place in the request (the return order: `coreOf`), and the replies
  // read them in the order of their own actions.
  const core = request.actions
    .map((action) => sent.answer.core[sent.request.core.indexOf(action)])
    .filter(isReplyResult);
  return { result: "committed", turnId: sent.answer.turnId, repeated: sent.answer.repeated, core };
}

/** A core result the replies read (K-09 recordStopOrStart or sendFixedLine); the replies check the rest of its shape. */
function isReplyResult(value: unknown): value is ReplyCoreResult {
  return (
    isRecord(value) &&
    (value.call === "recordStopOrStart" || value.call === "sendFixedLine") &&
    "response" in value &&
    "error" in value
  );
}

// ---- 4 and 5. frontier, decide, re-read ---------------------------------------------------------------------------

/** The decided input for the gate (steps 4 and 5), or how the run ended. */
async function prepareDecided(
  run: Run,
  texts: TurnText[],
  targets: BuildFrontierRequest["targets"],
): Promise<DecidedInput | TurnNotCommitted> {
  const frontier = await buildFrontier(run, {
    caller: { ...run.caller },
    turn: run.ref,
    texts,
    targets,
    now: run.set.now(),
  });
  if (isText(frontier)) return notCommitted(run, frontier);
  if (replaced(run.turn)) return notCommitted(run, "replaced");

  let context = frontier;
  const first = await decideOnce(run, context);
  if (isText(first)) return notCommitted(run, first);
  let decided = first;

  if (!decided.reread && (!decided.agreed || decided.parts.some((part) => part.outcome === "oneQuestion"))) {
    // The reads disagree, or a part is unmapped: the one re-read, before anything goes to the gate (Q-41).
    const again = await rereadOnce(run, context, decided, "disagreed", []);
    if (isText(again)) return notCommitted(run, again);
    decided = again;
  } else if (!decided.reread) {
    const quotes = decided.parts
      .filter((part) => part.part.verb === "none_fits" && part.outcome === "go")
      .map((part) => part.part.quote);
    if (quotes.length > 0) {
      // Nothing fits: meaning search adds the closest entries, and the turn's one re-read runs on them (arch 03 line 189).
      const searched = await closestEntries(run, context, quotes);
      if (searched !== null) {
        context = searched;
        const again = await rereadOnce(run, context, decided, "noneFits", []);
        if (isText(again)) return notCommitted(run, again);
        decided = again;
      }
    }
  }
  if (replaced(run.turn)) return notCommitted(run, "replaced");
  return { kind: "decided", decided: { context, decide: decided }, planner: null };
}

function isContextOf(value: unknown, turnId: string): value is DecideContext {
  return isRecord(value) && value.turnId === turnId && Array.isArray(value.choices);
}

/**
 * K-09 buildFrontier, with its span: the context, or why there is none (a label). A turn face that records the frontier
 * span itself (`recordsFrontierSpan`, CQ-159) gets no second one from the turn.
 */
async function buildFrontier(run: Run, request: BuildFrontierRequest): Promise<DecideContext | string> {
  const span = run.set.toolApi.recordsFrontierSpan === true ? null : run.trace.start("frontier");
  const got: SpanFacts = {
    texts: request.texts.length,
    roles: request.targets.roles.length,
    openQuestions: request.targets.openQuestionIds.length,
    bookings: request.targets.bookingIds.length,
  };
  let answer: unknown;
  try {
    answer = await run.set.toolApi.buildFrontier(request, run.trace);
  } catch {
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "noAnswer" });
    return "noAnswer";
  }
  if (isToolApiError(answer)) {
    const code = codeOf(answer.error);
    finish(span, { outcome: failedOrRefused(code), ...businessOf(run), got, errorCode: code });
    return code;
  }
  const context = isRecord(answer) ? answer.context : undefined;
  if (!isRecord(answer) || !isContextOf(context, run.turn.turnId)) {
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "badAnswer" });
    return "badAnswer";
  }
  finish(span, {
    outcome: "ok",
    ...businessOf(run),
    got,
    decided: {
      choices: context.choices.length,
      flagged: Array.isArray(answer.flagged) ? answer.flagged.length : 0,
      collapsed: Array.isArray(answer.collapsedBookingIds) ? answer.collapsedBookingIds.length : 0,
    },
  });
  return context;
}

/** K-09 closestEntries, with its span (search): the context with the entries added, or null when it gave none. */
async function closestEntries(
  run: Run,
  context: DecideContext,
  quotes: string[],
): Promise<DecideContext | null> {
  const span = run.trace.start("search");
  const got: SpanFacts = { quotes: quotes.length, choices: context.choices.length };
  let answer: unknown;
  try {
    answer = await run.set.toolApi.closestEntries({ caller: { ...run.caller }, context, quotes }, run.trace);
  } catch {
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "noAnswer" });
    return null;
  }
  if (isToolApiError(answer)) {
    // indexUnavailable or searchedAlready: no entries added, and the turn goes on as decided (the planner is C-117's).
    const code = codeOf(answer.error);
    finish(span, { outcome: failedOrRefused(code), ...businessOf(run), got, errorCode: code });
    return null;
  }
  const searched = isRecord(answer) ? answer.context : undefined;
  if (!isRecord(answer) || !isContextOf(searched, run.turn.turnId)) {
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "badAnswer" });
    return null;
  }
  const added = Array.isArray(answer.added) ? (answer.added as unknown[]).filter(isLabel) : [];
  finish(span, {
    outcome: "ok",
    ...businessOf(run),
    got,
    decided: { added, choices: searched.choices.length },
  });
  return searched;
}

/** The AI layer's decide (two reads), with its decideReads span: K-02's result for this turn, or why there is none. */
async function decideOnce(run: Run, context: DecideContext): Promise<DecideResult | string> {
  const span = run.trace.start("decideReads");
  const got: SpanFacts = { choices: context.choices.length };
  let answer: DecideAnswer;
  try {
    answer = await run.set.ai.decide(context, run.trace);
  } catch {
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "noAnswer" });
    return "noAnswer";
  }
  noteModelsDown(run, answer);
  const decided = decidedOf(run, span, got, answer, null);
  // A decide stage that ran the re-read itself has used the turn's one re-read.
  if (!isText(decided) && decided.reread) run.rereadRan = true;
  return decided;
}

/**
 * The turn's one Sonnet re-read, with its span: K-02's result with the re-read run, or why there is none. A second
 * request in the same run is refused here (`rereadDone`), and a result that says the re-read did not run is not taken
 * (never a commit on a difference).
 */
async function rereadOnce(
  run: Run,
  context: DecideContext,
  decide: DecideResult,
  why: RereadWhy,
  failing: readonly { part: number; fields: readonly string[] }[],
): Promise<DecideResult | string> {
  if (run.rereadRan) return "rereadDone";
  run.rereadRan = true;
  const span = run.trace.start("reread");
  const got: SpanFacts = { why, choices: context.choices.length, failingParts: failing.length };
  let answer: DecideAnswer;
  try {
    answer = await run.set.ai.reread({ context, decide, why, failing }, run.trace);
  } catch {
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "noAnswer" });
    return "noAnswer";
  }
  noteModelsDown(run, answer);
  return decidedOf(run, span, got, answer, true);
}

type Timer = ReturnType<TraceContext["start"]>;

/**
 * Checks a decide stage's answer and records its span: K-02's result for this turn with at least one part (and, for the
 * re-read, the re-read run), or why it is not taken (a label).
 */
function decidedOf(
  run: Run,
  span: Timer,
  got: SpanFacts,
  answer: DecideAnswer,
  mustReread: boolean | null,
): DecideResult | string {
  if (!("result" in answer)) {
    const code = codeOf(answer.error);
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: code });
    return code;
  }
  const decide: unknown = answer.decide;
  const modelCalls = modelCallsOf(answer.modelCalls);
  if (!isResultOf(decide, run.turn.turnId) || (mustReread !== null && decide.reread !== mustReread)) {
    // Another turn's result, no parts, or a re-read whose result says it did not run.
    finish(span, { outcome: "failed", ...businessOf(run), got, errorCode: "badAnswer", modelCalls });
    return "badAnswer";
  }
  finish(span, {
    outcome: "ok",
    ...businessOf(run),
    got,
    decided: {
      agreed: decide.agreed,
      reread: decide.reread,
      parts: decide.parts.length,
      oneQuestion: decide.parts.filter((part) => part.outcome === "oneQuestion").length,
      verbs: decide.parts.map((part) => part.part.verb).filter(isLabel),
      stakes: isLabel(decide.stakes) ? decide.stakes : null,
      language: isLabel(decide.language) ? decide.language : null,
    },
    modelCalls,
  });
  return decide;
}

/** The model calls a decide stage reports, for its span (K-08 v1 `modelCall`; the trace checks each one). */
function modelCallsOf(value: unknown): ModelCall[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((call): call is ModelCall => isRecord(call) && isText(call.model));
}

function isResultOf(value: unknown, turnId: string): value is DecideResult {
  if (!isRecord(value) || value.turnId !== turnId) return false;
  if (typeof value.agreed !== "boolean" || typeof value.reread !== "boolean") return false;
  const parts = value.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  return (parts as unknown[]).every(
    (part) =>
      isRecord(part) &&
      (part.outcome === "go" || part.outcome === "oneQuestion") &&
      isRecord(part.part) &&
      isText(part.part.verb) &&
      isText(part.part.quote),
  );
}

// ---- 6. gate and commit -----------------------------------------------------------------------------------------

/** What one commit call gave: committed, or refused with its code (nothing written by this call). */
type Sent =
  | { readonly kind: "committed"; readonly answer: GateCommitted; readonly request: GateAndCommitRequest }
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly answer: unknown;
      readonly request: GateAndCommitRequest;
    };

/** A core-only commit: each text's safety record under `caller`, then the keyword texts' core actions (`coreOf`). */
function commitCoreOnly(run: Run, caller: TurnCaller, actions: readonly CoreAction[]): Promise<Sent> {
  return sendWithResend(run, {
    caller,
    turn: run.ref,
    input: { kind: "coreOnly" },
    core: coreOf(run, caller, actions),
    now: run.set.now(),
  });
}

/**
 * The decided turn's commit: each text's safety record, then any keyword texts' core actions. A `valueFailsWords`
 * refusal before the re-read sends the turn to the one re-read, then to the gate again (K-09 README default 25).
 */
async function commitDecided(run: Run, input: DecidedInput, actions: readonly CoreAction[]): Promise<Sent> {
  let current = input;
  for (;;) {
    const sent = await sendWithResend(run, {
      caller: { ...run.caller },
      turn: run.ref,
      input: current,
      core: coreOf(run, run.caller, actions),
      now: run.set.now(),
    });
    if (sent.kind === "committed" || sent.error !== "valueFailsWords") return sent;
    const { context, decide } = current.decided;
    if (decide.reread || run.rereadRan || replaced(run.turn)) return sent;
    const again = await rereadOnce(run, context, decide, "valueFailsWords", failingOf(sent.answer));
    if (isText(again)) return sent;
    current = { ...current, decided: { context, decide: again } };
  }
}

/** The parts and fields a `valueFailsWords` answer names (K-09 v1 gateAndCommit.errors). */
function failingOf(answer: unknown): { part: number; fields: string[] }[] {
  if (!isRecord(answer) || !Array.isArray(answer.parts)) return [];
  const failing: { part: number; fields: string[] }[] = [];
  for (const entry of answer.parts as unknown[]) {
    if (!isRecord(entry) || typeof entry.part !== "number" || !Array.isArray(entry.fields)) continue;
    failing.push({ part: entry.part, fields: (entry.fields as unknown[]).filter(isText) });
  }
  return failing;
}

/** Sends a commit; an answer lost on the way (`noAnswer`) or a `transient` one is sent again, once, as the same request. */
async function sendWithResend(run: Run, request: GateAndCommitRequest): Promise<Sent> {
  const sent = await sendCommit(run, request);
  if (sent.kind === "committed" || (sent.error !== "noAnswer" && sent.error !== "transient")) return sent;
  if (replaced(run.turn)) return sent;
  return sendCommit(run, request);
}

/**
 * One gateAndCommit through the lease (`LeasedTurn.commit`), with its gate and commit spans. A run that is no longer the
 * turn's sends nothing: a lapsed turn's rerun has the turn now, and a replaced turn's texts are in its restart. The run
 * replies after its commit, so the lease holds a committed turn until the reply has ended (T-253).
 */
async function sendCommit(run: Run, request: GateAndCommitRequest): Promise<Sent> {
  if (replaced(run.turn)) return { kind: "refused", error: "replaced", answer: null, request };
  run.gateCalls += 1;
  const gateSpan = run.trace.start("gate");
  const commitSpan = run.trace.start("commit");
  let answer: CommitAnswer;
  try {
    answer = await run.turn.commit(leaseRequestOf(request, run.trace), { reply: true });
  } catch {
    answer = { error: "noAnswer" };
  }
  const input = request.input;
  const got: SpanFacts = {
    input: input.kind,
    parts: input.kind === "decided" ? input.decided.decide.parts.length : 0,
    core: request.core.length,
    reread: input.kind === "decided" && input.decided.decide.reread,
  };
  const committed = "result" in answer ? committedOf(answer.committed) : null;
  if (committed !== null) {
    run.committed = committed;
    run.committedCaller = request.caller;
    recordGate(run, gateSpan, got, committed);
    finish(commitSpan, {
      outcome: "ok",
      ...businessOf(run),
      got,
      decided: {
        repeated: committed.repeated,
        parts: committed.parts.length,
        committedParts: committed.parts.filter((part) => part.result === "committed").length,
        core: committed.core.length,
        outboxRows: committed.written.outboxRows.length,
      },
      rows: rowsOf(committed),
    });
    return { kind: "committed", answer: committed, request };
  }
  const code = "error" in answer ? codeOf(answer.error) : "badAnswer";
  const outcome = failedOrRefused(code);
  finish(gateSpan, { outcome, ...businessOf(run), got, limits: NOT_CHECKED, errorCode: code });
  finish(commitSpan, { outcome, ...businessOf(run), got, errorCode: code });
  return { kind: "refused", error: code, answer, request };
}

/** Limits 1 to 6, not checked: the gate span of a call that never reached the limits (K-08 v1 lists them on the gate). */
const NOT_CHECKED: LimitResult[] = [1, 2, 3, 4, 5, 6].map((limit) => ({
  limit,
  result: "notChecked",
  outcome: null,
}));

/**
 * One gate span per part, with that part's limits (a limit that fails stops only its choice); one for a core-only commit,
 * which says whether it was answered as a repeat. A later commit of the turn id writes nothing and answers the first
 * (K-05 v1 item 1), so a repeat's no parts are this call's, never a turn that committed nothing.
 */
function recordGate(run: Run, first: Timer, got: SpanFacts, committed: GateCommitted): void {
  if (committed.parts.length === 0) {
    finish(first, {
      outcome: "ok",
      ...businessOf(run),
      got,
      limits: NOT_CHECKED,
      decided: { parts: 0, repeated: committed.repeated },
    });
    return;
  }
  committed.parts.forEach((part, index) => {
    const span = index === 0 ? first : run.trace.start("gate");
    finish(span, {
      outcome: PART_OUTCOME.get(part.result) ?? "refused",
      ...businessOf(run),
      got,
      limits: limitsOf(part),
      decided: {
        part: part.part,
        result: isLabel(part.result) ? part.result : null,
        choice: isLabel(part.choiceId) ? part.choiceId : null,
      },
    });
  });
}

/** A part's result as a span's outcome: committed and asked are ok; stopped and dependsOnStopped refused; held held. */
const PART_OUTCOME: ReadonlyMap<string, Outcome> = new Map<string, Outcome>([
  ["committed", "ok"],
  ["asked", "ok"],
  ["noAction", "ok"],
  ["stopped", "refused"],
  ["dependsOnStopped", "refused"],
  ["held", "held"],
]);

function limitsOf(part: PartResult): LimitResult[] {
  const listed: unknown = part.limits;
  const limits: LimitResult[] = [];
  for (const entry of Array.isArray(listed) ? (listed as unknown[]) : []) {
    if (!isRecord(entry) || typeof entry.limit !== "number") continue;
    const result = entry.result;
    if (result !== "pass" && result !== "fail" && result !== "notChecked") continue;
    limits.push({ limit: entry.limit, result, outcome: isLabel(entry.outcome) ? entry.outcome : null });
  }
  return limits.length > 0 ? limits : NOT_CHECKED;
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/u;

/** The rows a commit wrote, for its span: tables and ids only (K-08 v1 rowRef); none on a repeat. */
function rowsOf(committed: GateCommitted): RowRef[] {
  if (committed.repeated) return [];
  const rows: RowRef[] = [];
  for (const row of committed.written.written) {
    if (TABLE_NAME.test(row.table) && isLabel(row.rowId)) rows.push({ table: row.table, id: row.rowId });
  }
  for (const row of committed.written.outboxRows) {
    if (isLabel(row.id)) rows.push({ table: "outbox_rows", id: row.id });
  }
  return rows;
}

const businessOf = (run: Run): { businessId?: string } =>
  isLabel(run.caller.businessId) ? { businessId: run.caller.businessId } : {};

// ---- outcomes and spans -------------------------------------------------------------------------------------------

/**
 * The turn has committed (first or repeated): step 7, the second half (./compose.ts), composes the rows the commit wrote
 * that hold no plan and wakes the dispatcher once, then the run ends committed. A run no longer the turn's by then (a
 * lapse's rerun took it) composes nothing and wakes no one: the run that has the turn now commits as a repeat and does
 * both. Once the reply has ended (`replyEnded`), the lease is told and released (T-253); otherwise it lapses, and the
 * rerun composes the rows still with no plan.
 */
async function finishCommitted(
  run: Run,
  answer: GateCommitted,
  replies: RepliesResult<OpenedText> | null,
): Promise<TurnCommitted> {
  const composed = replaced(run.turn)
    ? null
    : await composeCommitted({
        set: run.set,
        turnId: run.turn.turnId,
        handleId: run.party.handleId,
        caller: { ...(run.committedCaller ?? run.caller) },
        trace: run.trace,
        answer,
        wordsWritten: replies?.replies.flatMap((reply) => reply.rowsWritten) ?? [],
      });
  if (composed !== null && replyEnded(composed) && !replaced(run.turn)) {
    try {
      await run.turn.replied();
    } catch {
      // The lease was not told: it lapses, and the rerun finds every row planned.
    }
  }
  return { result: "committed", answer, reread: run.rereadRan, gateCalls: run.gateCalls, replies, composed };
}

/**
 * True when step 7 has ended for the commit (T-253): the turn's rows with no plan were read, and none of them was left
 * with no plan (each was composed, copied, found planned or closed). The dispatcher's wake counts as given either way: a
 * wake not taken leaves the rows for the recipient's next dispatcher run (no sweep runs).
 */
export function replyEnded(report: ComposeReport): boolean {
  return report.rowsError === null && report.rows.every((row) => row.result !== "left");
}

function outcomeOf(run: Run, sent: Sent, replies: RepliesResult<OpenedText> | null): Promise<TurnOutcome> {
  if (sent.kind === "committed") return finishCommitted(run, sent.answer, replies);
  return Promise.resolve(notCommitted(run, sent.error, replies));
}

/** An error code as a span may carry it: the code when it is a label, else badAnswer. */
function codeOf(error: unknown): string {
  return isLabel(error) ? error : "badAnswer";
}

/** Errors that say a call could not run (failed) rather than that it was refused. */
const FAILED_CODES: ReadonlySet<string> = new Set(["noAnswer", "transient", "badAnswer", "unwired"]);

const failedOrRefused = (code: string): Outcome => (FAILED_CODES.has(code) ? "failed" : "refused");

/**
 * Records a span; a span the trace refuses is not kept, and the turn goes on. No span (null): the hop's port records it
 * itself (CQ-159).
 */
function finish(span: Timer | null, fields: Parameters<Timer["finish"]>[0]): void {
  if (span === null) return;
  try {
    span.finish(fields);
  } catch {
    // No span for this step; what the step did stands.
  }
}
