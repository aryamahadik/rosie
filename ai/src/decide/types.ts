// Types of decide's one read (T-368, C-115; arch 03 lines 183 to 187; arch 02 line 119). The K-02 v1 shapes
// (contracts/model/model.v1.schema.json: `decideRead`, `decidePart` and its eight verbs, `field`, `fieldValue`, `read`)
// are written by hand, as the safety read writes its own: the generated types are git-ignored (ADR-005) and the Worker
// must not depend on them. The tests hold every list here to the contract's own.

import type { AttemptFailure, CallOptions, FetchLike, GatewayBundle, ModelCall, ModelRole } from "../gateway";
import type { PromptCache } from "../cache";
import type { DecideContext } from "../context";
import type { ReadPair, RoutingBundle, Stakes } from "../routing";
import type { BundleId, SpanFacts } from "../../../runtime/src/trace";

export type { DecideContext, ModelCall, ModelRole, ReadPair, Stakes };

/** K-02 v1's eight verbs, one per part of the text (arch 03 line 183), in K-02's order. */
export const VERBS = [
  "choose",
  "enter",
  "ask",
  "none_fits",
  "pass_on",
  "hand_off",
  "redact",
  "no_op",
] as const;
export type Verb = (typeof VERBS)[number];

/** K-02 v1 `handOffAbout`: whom a hand-off is about, so the hand-off code routes it without reading the reason. */
export const HAND_OFF_ABOUT = ["ownerOrStaff", "other"] as const;
export type HandOffAbout = (typeof HAND_OFF_ABOUT)[number];

/** The shared `money` format (CQ-09): whole cents with the currency code. */
export interface Money {
  cents: number;
  currency: string;
}

/** The shared `time` format (CQ-09; S13-03): the instant in UTC with the IANA zone it is read in. */
export interface Time {
  utc: string;
  zone: string;
}

/** K-02 v1 `fieldValue`: text (also zone, id or choice), a whole number, a boolean, money or a time. */
export type FieldValue = string | number | boolean | Money | Time;

/** K-02 v1 `field`: one field of a choose or enter, with the exact words it comes from. */
export interface Field {
  name: string;
  value: FieldValue;
  words: string;
}

export interface ChoosePart {
  verb: "choose";
  quote: string;
  question: string;
  choice: string;
  fields: Field[];
}
export interface EnterPart {
  verb: "enter";
  quote: string;
  choice: string;
  fields: Field[];
}
export interface AskPart {
  verb: "ask";
  quote: string;
  questions: string[];
  unclear: string;
}
export interface NoneFitsPart {
  verb: "none_fits";
  quote: string;
  why: string;
}
export interface PassOnPart {
  verb: "pass_on";
  quote: string;
  words: string;
}
export interface HandOffPart {
  verb: "hand_off";
  quote: string;
  reason: string;
  about: HandOffAbout;
}
export interface RedactPart {
  verb: "redact";
  quote: string;
  words: string;
}
export interface NoOpPart {
  verb: "no_op";
  quote: string;
}

/** K-02 v1 `decidePart`: one verb for one part of the text. */
export type DecidePart =
  ChoosePart | EnterPart | AskPart | NoneFitsPart | PassOnPart | HandOffPart | RedactPart | NoOpPart;

/** K-02 v1 `decideRead`: what one decide read returns, the text's language and one verb per part, in the text's order. */
export interface DecideRead {
  language: string;
  parts: DecidePart[];
}

/** K-02 v1 `read.role`: the first read, the read that must agree with it, the one Sonnet re-read. */
export const READ_ROLES = ["first", "check", "reread"] as const;
export type ReadRole = (typeof READ_ROLES)[number];

/** K-02 v1 `read`: one decide read as the decide stage records it, with which model read it and in which role. */
export interface Read {
  model: ModelRole;
  role: ReadRole;
  output: DecideRead;
}

/** The model-call purposes a decide read is made for (K-08 v1), each reading the same context with its own seed. */
export const DECIDE_PURPOSES = ["decideFirst", "decideCheck", "reread"] as const;
export type DecidePurpose = (typeof DECIDE_PURPOSES)[number];

/** The K-02 role of a read made for each purpose. */
export const ROLE_OF: Readonly<Record<DecidePurpose, ReadRole>> = Object.freeze({
  decideFirst: "first",
  decideCheck: "check",
  reread: "reread",
});

/** Step 1's answer, mapped: each part's quote (in the text's own characters) and verb, and the text's language. */
export interface PartHead {
  readonly quote: string;
  readonly verb: Verb;
}

/** What decide's one read is built with: one bundle's id, models and prompt layout, and the key's environment. */
export interface DecideReaderOptions {
  /** The bundle id and its two model ids (K-01 v1 manifest), checked as the AI gateway checks them (T-361). */
  readonly bundle: GatewayBundle;
  /** The same bundle's prompt layout (T-364): its decide prompt, rules and cards are the calls' cached system prompt. */
  readonly prompts: PromptCache;
  /** The environment the key is read from, by name (ANTHROPIC_API_KEY), at the moment of each call. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch`. Tests pass a fake Messages API. */
  readonly fetch?: FetchLike;
}

/** Which read of the turn this is, and the model asked first (routing by stakes is T-363's and T-369's). */
export interface DecideReadRequest {
  readonly purpose: DecidePurpose;
  readonly model: ModelRole;
  /** The seed that orders this read's choices (T-367); drawn for the read when not given. */
  readonly seed?: number;
}

/** Where the read's spans go: the turn's trace, as the AI gateway takes it (one portCall span per attempt). */
export type DecideCallOptions = CallOptions;

interface AnswerBase {
  readonly turnId: string;
  readonly purpose: DecidePurpose;
  /** The read's seed: with the context, it lays the read's prompt out again exactly (T-367). */
  readonly seed: number;
  /** The choice ids in the order this read listed them. */
  readonly choiceOrder: readonly string[];
  /** The read's span facts (T-367: its seed under its purpose's name and the context's counts; never words). */
  readonly span: Readonly<SpanFacts>;
  /** Every attempt's model call, stage 1's first, then each stage-2 call's in the parts' order (K-08 v1). */
  readonly modelCalls: readonly ModelCall[];
}

/** A read that is a K-02 `read`: valid against `decideRead` and the named rules against its context. */
export interface DecideReadOk extends AnswerBase {
  readonly status: "ok";
  /** K-02 v1 `read`: which model read it (the one that answered step 1), its role and its output. */
  readonly read: Read;
  /** The text's language as this read sees it (CQ-07 default; `read.output.language`). */
  readonly language: string;
  /** True when a call of the read was answered by the other model than the one asked first (the gateway's fallback). */
  readonly fallback: boolean;
}

/**
 * The model answered, but its answer is not a K-02 read: refused by the AI layer's validator before it is returned (an
 * unmapped read, arch 02 line 119: the turn's one re-read follows). Problems name fields, parts and rules, never words.
 */
export interface DecideReadRefused extends AnswerBase {
  readonly status: "refused";
  /** 1: step 1's answer (the parts, their verbs and quotes); 2: a step-2 answer or the read they make. */
  readonly stage: 1 | 2;
  readonly problems: readonly string[];
  /** The parts (0-based, in step 1's order) that failed; empty when step 1's answer failed as a whole. */
  readonly unmappedParts: readonly number[];
}

/** A call of the read failed on both models (the gateway's typed `modelsDown`); what follows is T-271's. */
export interface DecideReadDown extends AnswerBase {
  readonly status: "modelsDown";
  readonly stage: 1 | 2;
  readonly failures: readonly AttemptFailure[];
}

export type DecideReadAnswer = DecideReadOk | DecideReadRefused | DecideReadDown;

/** Decide's one read (C-115): step 1, then step 2 for each part side by side, through the AI gateway. */
export interface DecideReader {
  /**
   * Reads one turn's context once. Never rejects for a failed model call or a bad answer: those are `modelsDown` and
   * `refused`. Rejects, before any call, only for a call that cannot be made: a purpose that is not decide's, a context
   * the context bundle refuses (ContextRefusedError) or another bundle's (CacheLayoutError), no key (MissingKeyError).
   */
  read(
    context: DecideContext,
    request: DecideReadRequest,
    options?: DecideCallOptions,
  ): Promise<DecideReadAnswer>;
}

// ---- Decide, two reads, and their agreement (T-369, C-115) --------------------------------------------------------

/** K-02 v1 `resultPart.outcome`: go to the gate, or one question with nothing changed for the part (arch 02 line 119). */
export const RESULT_OUTCOMES = ["go", "oneQuestion"] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/** K-02 v1 `resultPart`: one part as decide hands it to the gate, with what happens to it. */
export interface ResultPart {
  readonly part: DecidePart;
  readonly outcome: ResultOutcome;
}

/**
 * K-02 v1 `decideResult`: what decide hands the gate for one turn: the turn's stakes and read pair, the reads in the order
 * they ran, whether the first and check reads agreed, whether the one re-read ran, the language they agreed on (or null)
 * and each part of the text with its outcome.
 */
export interface DecideResult {
  readonly turnId: string;
  readonly bundleId: BundleId;
  readonly stakes: Stakes;
  readonly routing: ReadPair;
  readonly reads: readonly Read[];
  readonly agreed: boolean;
  readonly reread: boolean;
  readonly language: string | null;
  readonly parts: readonly ResultPart[];
}

/**
 * What the two reads of one part can differ on, as labels (never words): one read has no part there (`missing`), the
 * verb, choose's question, the choice, the fields (how many, or a name), a field's value, the questions an ask names,
 * and whom a hand-off is about. In K-02's order of a part's keys; a K-08 span may hold them.
 */
export const DIFFERENCES = [
  "missing",
  "verb",
  "question",
  "choice",
  "fields",
  "value",
  "questions",
  "about",
] as const;
export type Difference = (typeof DIFFERENCES)[number];

/**
 * How one part came out of the comparison:
 *   agreed       both reads give it the same verb, choice and every field value: it may go to the gate;
 *   notAgreed    low stakes, and the reads differ on it: the turn's one Sonnet re-read settles it (T-370), and until
 *                then nothing changes for it (arch 02 line 119; arch 06 line 289);
 *   oneQuestion  high stakes, and the reads differ on it: it ends in one question and nothing changes for it (arch 06
 *                line 287), after the re-read (Q-41's default: the re-read runs before the one question).
 */
export const PART_MARKS = ["agreed", "notAgreed", "oneQuestion"] as const;
export type PartMark = (typeof PART_MARKS)[number];

/** One part of the text, as the two reads give it, compared. */
export interface PartAgreement {
  /** Its place in the text's order: the index of the part in each read that has one there. */
  readonly index: number;
  /** The first read's part there, or null when the first read has fewer parts. */
  readonly first: DecidePart | null;
  /** The check read's part there, or null when the check read has fewer parts. */
  readonly check: DecidePart | null;
  readonly mark: PartMark;
  /** What the two differ on, in DIFFERENCES' order; empty when agreed. */
  readonly differences: readonly Difference[];
}

/** A turn's first and check reads compared part by part (arch 02 line 119; arch 06 lines 285 to 287; CQ-07). */
export interface Agreement {
  /** The turn's stakes the comparison was made on: they decide what a part that differs comes to. */
  readonly stakes: Stakes;
  /** K-02 `decideResult.agreed`: as many parts in each read, every one agreed, and one language. */
  readonly agreed: boolean;
  /** K-02 `decideResult.language`: the language both reads give, or null when they differ (CQ-07's default). */
  readonly language: string | null;
  /** One entry per part, in the text's order: as many as the read with more parts gives. */
  readonly parts: readonly PartAgreement[];
}

/** What decide's two reads are built with: one bundle's K-01 v1 manifest (id, models, routing policy) and its prompts. */
export interface DeciderOptions {
  /** The bundle id, its two model ids and its routing policy (K-01 v1 manifest), checked as the router checks them. */
  readonly bundle: RoutingBundle;
  /** The same bundle's prompt layout (T-364), as decide's one read takes it. */
  readonly prompts: PromptCache;
  /** The environment the key is read from, by name (ANTHROPIC_API_KEY), at the moment of each call. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch`. Tests pass a fake Messages API. */
  readonly fetch?: FetchLike;
}

/** Where the reads' spans go (the turn's trace), and where their seeds come from. */
export interface DecideTurnOptions extends DecideCallOptions {
  /** A 32-bit unsigned seed per call (the router's `draw`). Defaults to drawSeed; tests pass their own. */
  readonly draw?: () => number;
}

interface TurnAnswerBase {
  readonly turnId: string;
  readonly bundleId: BundleId;
  /** The turn's stakes as routed, before any read (T-363: high when any choice it offers is high). */
  readonly stakes: Stakes;
  /** The ids of the choices that made it high, sorted; empty on low stakes. */
  readonly highChoices: readonly string[];
  /** The bundle policy's read pair for those stakes: which model each read asked first (K-02 `decideResult.routing`). */
  readonly routing: ReadPair;
  /** Each read's own answer, in the route's order: the first read, then the check read. */
  readonly answers: readonly [DecideReadAnswer, DecideReadAnswer];
  /** Every model call of both reads, the first read's first, each read's in its own order (K-08 v1). */
  readonly modelCalls: readonly ModelCall[];
  /** The decideReads span's facts: each read's seed under its purpose's name and the context's counts (T-367). */
  readonly span: Readonly<SpanFacts>;
}

/** Both reads are K-02 reads: compared, and handed on as K-02's decide result before any re-read. */
export interface DecideTurnDecided extends TurnAnswerBase {
  readonly status: "decided";
  readonly agreement: Agreement;
  /** K-02 v1 `decideResult`, the re-read not run: agreed parts go, every other part holds one question. */
  readonly result: DecideResult;
}

/**
 * A read the AI layer's validator refused (an unmapped read): never compared; the turn's one re-read follows inside the
 * AI layer (T-370: `reread` with why `unmapped`, CQ-162 (a)).
 */
export interface DecideTurnUnmapped extends TurnAnswerBase {
  readonly status: "unmapped";
  /** The role of each read that was refused, first before check. */
  readonly refused: readonly ReadRole[];
}

/** A read the AI gateway got from neither model (`modelsDown`): never compared; what follows is T-271's. */
export interface DecideTurnDown extends TurnAnswerBase {
  readonly status: "modelsDown";
}

export type DecideTurnAnswer = DecideTurnDecided | DecideTurnUnmapped | DecideTurnDown;

// ---- The turn's one Sonnet re-read (T-370, C-116) -----------------------------------------------------------------

/**
 * Why the turn's one re-read runs (arch 02 line 119; arch 06 line 289; K-02 `decideResult.reread`):
 *   disagreed        the first and check reads differ on a part or on the text's language (the turn loop asks);
 *   valueFailsWords  the gate found a value failing its words before the re-read (the turn loop asks with the parts and
 *                    fields the gate named: K-09 v1 `valueFailsWords`, K-09 README default 25);
 *   unmapped         a read the AI layer's validator refused: the AI layer asks itself, as the turn has no K-02 result to
 *                    hand the turn loop (CQ-162 (a)).
 * The re-read after meaning search (the turn loop's `noneFits`, arch 03 line 189) is not this card's, and is refused.
 */
export const REREAD_WHYS = ["disagreed", "valueFailsWords", "unmapped"] as const;
export type RereadWhy = (typeof REREAD_WHYS)[number];

/** One part the gate named, with the fields whose values fail their words (K-09 v1 `gateAndCommit` valueFailsWords). */
export interface FailingPart {
  /** The part's place in the result's parts, 0-based. */
  readonly part: number;
  /** The names of its fields whose values fail their words. */
  readonly fields: readonly string[];
}

/** The re-read the turn loop asks for (T-251's `RereadRequest`): decide's K-02 result before any re-read, and why. */
export interface RereadAfterReads {
  readonly why: "disagreed" | "valueFailsWords";
  /** The context decide read (the turn's K-02 v1 context). */
  readonly context: DecideContext;
  /** K-02 v1 `decideResult` of the turn's first and check reads, exactly as decide gave it (reread false). */
  readonly decide: DecideResult;
  /** valueFailsWords: the parts and fields the gate named; disagreed: none. */
  readonly failing: readonly FailingPart[];
}

/** The re-read the AI layer asks for itself, for a turn decide answered `unmapped` (CQ-162 (a)). */
export interface RereadUnmappedTurn {
  readonly why: "unmapped";
  /** The context decide read. */
  readonly context: DecideContext;
  /** Decide's answer for it, exactly as decide gave it. */
  readonly unmapped: DecideTurnUnmapped;
}

export type RereadRequest = RereadAfterReads | RereadUnmappedTurn;

/**
 * What became of one part at the turn's re-read (labels, never words):
 *   untouched  the first and check reads agreed on it and the gate named none of its values: it goes as decide gave it
 *              (the first read's part), whatever the re-read says of it;
 *   confirmed  the gate named a value of it failing its words, and the re-read gives the part both reads agreed on: it
 *              goes again as decide gave it, and the gate's limit 6 checks it once more, now after the re-read (K-09
 *              commit-limit-6-value-fails.json);
 *   settled    low stakes, the first and check reads differ on it, and the re-read gives the part one of them gives (the
 *              same verb, choice and every field value): two reads agree, the re-read one of them, so the re-read's
 *              part goes;
 *   unclear    anything else: one question, and nothing changes for it (arch 02 line 119; Q-41); it holds the
 *              re-read's part there, or the last read's that has one, kept for the trace and the question. On high
 *              stakes every part the first and check reads differ on ends here (arch 06 line 287).
 */
export const SETTLEMENTS = ["untouched", "confirmed", "settled", "unclear"] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

/** One part of the turn at its re-read. */
export interface PartSettlement {
  /** Its place in the text's order, as the reads give it. */
  readonly index: number;
  /** Its mark from the first and check reads (T-369), or null for a part only the re-read gives. */
  readonly mark: PartMark | null;
  /** True when the gate named a value of the part failing its words. */
  readonly failed: boolean;
  /** The re-read's part at this place, or null when the re-read gives fewer parts. */
  readonly reread: DecidePart | null;
  readonly settlement: Settlement;
}

interface RereadAnswerBase {
  readonly turnId: string;
  readonly bundleId: BundleId;
  /** The turn's stakes, as decide routed them. */
  readonly stakes: Stakes;
  /** The turn's read pair (K-02 `decideResult.routing`). */
  readonly routing: ReadPair;
  readonly why: RereadWhy;
  /** The model the bundle's policy names for the re-read (K-01 v1 `policy.reread`), asked first. */
  readonly model: ModelRole;
  /** The re-read's model calls (K-08 v1), its step 1's first, each with the purpose reread. */
  readonly modelCalls: readonly ModelCall[];
  /** The reread span's facts: the re-read's seed (`rereadSeed`) and the context's counts (T-367); never words. */
  readonly span: Readonly<SpanFacts>;
}

/** The re-read is a K-02 read: K-02 v1's decideResult with it (reread true), the turn's final result. */
export interface RereadDecided extends RereadAnswerBase {
  readonly status: "decided";
  /** The re-read's own answer (decide's one read, T-368, purpose reread). */
  readonly reread: DecideReadOk;
  /** What became of each part, in the result's order. */
  readonly settlement: readonly PartSettlement[];
  /** K-02 v1 `decideResult` with the re-read: go only on untouched, confirmed and settled parts. */
  readonly result: DecideResult;
}

/**
 * A read of the turn is refused (an unmapped read): the re-read itself, or the first or check read decide answered
 * `unmapped` for. K-02 v1's decideResult holds only K-02 reads, so it cannot hold this turn (CQ-162 (a), open for the
 * architect): the turn ends in one question and nothing changes for any part. The re-read's answer is kept for the
 * trace and the question.
 */
export interface RereadUnmapped extends RereadAnswerBase {
  readonly status: "unmapped";
  readonly reread: DecideReadOk | DecideReadRefused;
  /** The role of every read of the turn the AI layer's validator refused, in the order they ran. */
  readonly refused: readonly ReadRole[];
  /** How the turn ends: one question, with nothing changed. */
  readonly end: "oneQuestion";
}

/** The re-read got neither model (`modelsDown`): no result, and nothing commits; what follows is T-271's. */
export interface RereadDown extends RereadAnswerBase {
  readonly status: "modelsDown";
  readonly reread: DecideReadDown;
}

export type RereadAnswer = RereadDecided | RereadUnmapped | RereadDown;

/** Decide (C-115, C-116): two reads routed by stakes, read side by side and compared part by part; the one re-read. */
export interface Decider {
  readonly bundleId: BundleId;
  /**
   * Decides one turn's K-02 v1 context. Never rejects for a failed model call or a bad answer: those are `modelsDown`
   * and `unmapped`. Rejects, before any call, for a turn it cannot route (RoutingRefusedError: another bundle's, no
   * choice, stakes K-02 does not have) and for a read that cannot be made (as decide's one read rejects). Each decide of
   * a turn is a new run of it: its one re-read is not yet used.
   */
  decide(context: DecideContext, options?: DecideTurnOptions): Promise<DecideTurnAnswer>;
  /**
   * The turn's one Sonnet re-read (C-116): at most one per decide of the turn, whatever asks for it. Never rejects for a
   * failed model call or a bad answer: those are `modelsDown` and `unmapped`. Rejects, before any call, a second request
   * (RereadRefusedError), and a request it cannot serve (DecideRequestError: a why that is not its, a result that is not
   * its two reads' own for this context and bundle, nothing to re-read, a failing part or field the result does not
   * have), as well as what decide's one read rejects. `options.draw` gives the re-read's seed.
   */
  reread(request: RereadRequest, options?: DecideTurnOptions): Promise<RereadAnswer>;
}
