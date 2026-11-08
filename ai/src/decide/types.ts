// Types of decide's one read (T-368, C-115; arch 03 lines 183 to 187; arch 02 line 119). The K-02 v1 shapes
// (contracts/model/model.v1.schema.json: `decideRead`, `decidePart` and its eight verbs, `field`, `fieldValue`, `read`)
// are written by hand, as the safety read writes its own: the generated types are git-ignored (ADR-005) and the Worker
// must not depend on them. The tests hold every list here to the contract's own.

import type { AttemptFailure, CallOptions, FetchLike, GatewayBundle, ModelCall, ModelRole } from "../gateway";
import type { PromptCache } from "../cache";
import type { DecideContext } from "../context";
import type { SpanFacts } from "../../../runtime/src/trace";

export type { DecideContext, ModelCall, ModelRole };

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
