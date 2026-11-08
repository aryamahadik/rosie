// The safety read on arrival (T-246; C-047; arch 02 step S, line 111). The handle actor sends each raw text to the safety
// read as it arrives, before batching. It touches six outside things, each through an interface the runtime owns, so it
// is tested against fakes that answer as the frozen fixtures state (BP 5.2):
//
// - the safety read itself (K-02 v1 `safetyResult`): Haiku then Sonnet, 2 s each, is the AI engineer's (C-113, T-365);
// - the bundle's checked lines and shared lists (K-01 v1): the outcome steps' checked lines, the fixed lines by id and the
//   danger words;
// - the shared core (K-09 v1): `recordSafetyOutcome`, `sendFixedLine` and `releaseSafetyHold`, by their frozen names;
// - the handle's own sealing key store (the actor opens the box to read its words, and only here);
// - the direct send through Linq, which is used only while PostgreSQL is down (arch 11 line 566; NQ-RT-9);
// - a clock, so a 4 s deadline is tested without waiting.
//
// The shapes are written by hand (the generated types are git-ignored, ADR-005, and the Worker must not depend on them).
// Never logged or put in a span: a text's words, an evidence quote, a phone number, a key.

import type { SealedWords, SealingKeyStore } from "../gateway/seal";
import type { BundleId } from "../trace";
import type { ModelCall } from "../trace/types";

/** K-02 v1 `safetyOutcome`: the 8 outcomes of A3-22 and B3-17, word for word, and Unsure. */
export const SAFETY_OUTCOMES = [
  "No",
  "Safety steps, then go on",
  "An emergency",
  "Crisis words",
  "A threat to staff or others",
  "Harm to a child or older adult",
  "Unsafe at home",
  "Needs the business's own line",
  "Unsure",
] as const;
export type SafetyOutcome = (typeof SAFETY_OUTCOMES)[number];

export type Tense = "now" | "could restart" | "over" | "joke" | "unknown";

/** K-02 v1 `safetyLabel`. */
export interface SafetyLabel {
  outcome: SafetyOutcome;
  tense: Tense;
  evidence: string;
  atRisk: string;
  writer: string;
}

/** K-02 v1 `safetyRead`: what the model answers. */
export interface SafetyRead {
  labels: SafetyLabel[];
}

/** K-02 v1 `safetyResult.dangerWords[]`: the words code matched, the list they came from and the line they get on a timeout. */
export interface DangerWordMatch {
  words: string;
  list: "general" | "plugin";
  kind: "selfHarm" | "other";
}

/** K-02 v1 `safetyResult`: the read's output as the actor hands it on. */
export interface SafetyResult {
  eventId: string;
  source: "text" | "page" | "agent";
  tries: { model: "haiku" | "sonnet"; result: "verdict" | "timeout" | "error" }[];
  read: SafetyRead | null;
  timedOut: boolean;
  dangerWords: DangerWordMatch[];
  outcomes: SafetyOutcome[];
  liftedToUnsure: boolean;
}

/** What the actor gives the safety read for one raw text. The words are plain here and nowhere else. */
export interface SafetyReadRequest {
  eventId: string;
  source: "text";
  traceId: string;
  bundleId: BundleId;
  words: SealedWords;
}

/** What a finished read gives back: the K-02 result, and the model calls it made (K-08's `model_calls`, for the span). */
export interface SafetyReadAnswer {
  result: SafetyResult;
  modelCalls: ModelCall[];
}

/**
 * The safety read (C-113, T-365): one 2 s try per model, then a K-02 `safetyResult`. It must answer a read it finished
 * (a verdict, or its own timeout marker). The actor does not wait past 4 s from arrival, whatever it does.
 */
export interface SafetyReadPort {
  read(request: SafetyReadRequest): Promise<SafetyReadAnswer>;
}

/** One entry of the bundle's danger-word list (K-01 shared lists; the general check's and the plug-in's). */
export interface DangerWordEntry {
  words: string;
  list: "general" | "plugin";
  kind: "selfHarm" | "other";
}

/** A checked line of the bundle (K-01 v1 `fixedLine`, or an outcome step's checked `say`). */
export interface CheckedLine {
  /** K-09 `fixedLineId`. */
  id: string;
  text: string;
}

/**
 * What the safety read takes from the pinned bundle (K-01 v1), read at arrival. The bundle-backed adapter joins at D-017;
 * the list of danger words is the bundle's, never the runtime's own.
 */
export interface BundleSafety {
  /** A K-01 fixed line by id: `safetyEmergency` (911), `safetyCrisis` (988 and 911), `safetyAsk`, `outage`. Null: not in the bundle, or no words yet. */
  fixedLine(id: string): CheckedLine | null;
  /** The checked line of an outcome's step (A3-24, A3-25, A3-48, A3-49, A3-50, A3-26, B3-17's), or null when it has none. */
  outcomeLine(outcome: SafetyOutcome): CheckedLine | null;
  /** The danger words the bundle's shared lists hold. */
  dangerWords(): readonly DangerWordEntry[];
}

/** The clock, so tests run a 4 s deadline with a fake one. */
export interface SafetyClock {
  now(): number;
  /** Resolves after `ms` milliseconds. */
  after(ms: number): Promise<void>;
}

/** The ids K-09 calls name for a handle (K-04 rows), as the actor knows them. Null: not known yet. */
export interface HandleIds {
  handleId: string;
  businessId: string | null;
  personId: string | null;
  bookingId: string | null;
}

export interface HandleDirectory {
  idsOf(actorName: string): Promise<HandleIds | null>;
}

/** K-09 `caller`, for a call the handle actor makes (kind job: a call alone, with no turn; see the card's open question). */
export interface CoreCaller {
  kind: "job" | "actorOnReturn";
  turnId: null;
  requestId: string;
  businessId: string | null;
  personId: string | null;
  traceId: string;
}

/** K-09 `sentByActor`. */
export interface SentByActor {
  at: string;
  fixedLineId: string;
  linqMessageId: string;
}

export interface RecordSafetyOutcomeRequest {
  caller: CoreCaller;
  safety: SafetyResult;
  handleId: string | null;
  bookingId: string | null;
  sentByActor: SentByActor | null;
}

export interface SafetyHold {
  holdId: string;
  releaseRule: ReleaseRule;
  blocksBooking: boolean;
}

export interface RecordSafetyOutcomeResponse {
  outcomeId: string;
  outcomes: SafetyOutcome[];
  hold: SafetyHold | null;
  safetyLine: { fixedLineId: string; outboxRowId: string | null } | null;
  told: { who: "owner" | "named" | "team"; via: "handOff" | "teamPage" | "harmReport"; id: string }[];
  nothingBooks: boolean;
  repeated: boolean;
}

export interface SendFixedLineRequest {
  caller: CoreCaller;
  fixedLineId: string;
  recipientHandleId: string;
  sendClass: "safety" | "quick_reply";
  sentByActor: SentByActor | null;
}

export interface SendFixedLineResponse {
  outboxRowId: string | null;
  repeated: boolean;
}

export interface ReleaseSafetyHoldRequest {
  caller: CoreCaller;
  holdId: string;
  expectVersion: number;
  why: "outcome_message_sent" | "booking_private" | "safe_readback";
  releasedByOutcomeId: string | null;
}

export interface ReleaseSafetyHoldResponse {
  holdId: string;
  releasedAt: string;
  redecideTurnId: string | null;
  repeated: boolean;
}

/** A K-09 error: a JSON object with its own `error` code (`transient`: nothing was written and the call may be repeated). */
export interface CoreError {
  error: string;
}

/**
 * The K-09 v1 shared-core calls the safety read makes (the action layer's C-104, served by T-220; a fake answers here).
 * A throw, a `transient` answer or any other error counts as "the core is not answering": the checked line still goes,
 * straight through Linq (arch 11 line 566), and the record is written on return.
 */
export interface SafetyCore {
  recordSafetyOutcome(request: RecordSafetyOutcomeRequest): Promise<RecordSafetyOutcomeResponse | CoreError>;
  sendFixedLine(request: SendFixedLineRequest): Promise<SendFixedLineResponse | CoreError>;
  releaseSafetyHold(request: ReleaseSafetyHoldRequest): Promise<ReleaseSafetyHoldResponse | CoreError>;
}

/** A line the actor sends straight through Linq (only while the core is down): the number and chat are the sender's. */
export interface DirectLineRequest {
  actorName: string;
  fixedLineId: string;
  text: string;
  /** True for a safety line (past any opt-out, at any hour, RULES 4.3); false for the outage line (never to a stopped number). */
  overrideOptout: boolean;
  /** Stable per (event, line): a repeat of the send is one message at Linq. */
  idempotencyKey: string;
}

export interface DirectLineSender {
  send(request: DirectLineRequest): Promise<{ linqMessageId: string }>;
}

/** The release rule of a hold (K-34 v1 `safety_holds.release_rule`). */
export type ReleaseRule = "at_once" | "when_private" | "after_safe" | "never";

/** Everything the safety read needs from outside. Set once per Worker isolate (`setSafetyDeps`); joins at D-017. */
export interface SafetyDeps {
  read: SafetyReadPort;
  bundle: BundleSafety;
  core: SafetyCore;
  directory: HandleDirectory;
  keys: SealingKeyStore;
  direct: DirectLineSender;
  clock: SafetyClock;
  /** The handle's stopped flag, which the actor keeps (arch 11 line 566). Only the outage line asks it. */
  isStopped(actorName: string): boolean | Promise<boolean>;
}

/** How long the actor waits for a verdict: 2 s a model, 4 s in all, from arrival (arch 02 line 111). */
export const VERDICT_DEADLINE_MS = 4000;
/** The checked line goes within 5 s of arrival (arch 04 latency table; K-09 `recordSafetyOutcome` time budget). */
export const SAFETY_LINE_BUDGET_MS = 5000;
/**
 * While a text's safety work runs past its 4 s deadline (its line is being handed on), how often the actor's alarm comes
 * back until the line's 5 s budget is spent, so an eviction in that time cannot leave the text unread (T-1088).
 */
export const SAFETY_RETRY_MS = 1000;
/**
 * How often a text with no verdict yet (its unread hold open) is read again, and how often the actor's alarm comes back
 * for safety work that still hangs once the line's 5 s budget is spent (arch 11 line 564: "The turn retries every 30 s";
 * T-1088 round 2, DL-127).
 */
export const REREAD_MS = 30_000;
