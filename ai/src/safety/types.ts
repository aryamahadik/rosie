// Types of the safety read (T-365, C-113; arch 02 step S, line 111, and step Q, line 129; arch 06 line 283). The K-02 v1
// shapes (contracts/model/model.v1.schema.json: `safetyRead`, `safetyLabel`, `safetyOutcome`, `tense`, `safetyResult`)
// are written by hand, as runtime/src/safety/types.ts writes them for the actor (T-246): the generated types are
// git-ignored (ADR-005) and the Worker must not depend on them. The tests hold every list here to the contract's own.
//
// The arrays are plain (not readonly) so an answer is the actor's `SafetyReadAnswer` as it is (T-246's port).

import type { FetchLike, GatewayBundle } from "../gateway";
import type { PromptCache } from "../cache";
import type { ModelCall } from "../../../runtime/src/trace/types";
import type { TraceContext } from "../../../runtime/src/trace";

export type { ModelCall };

/** K-02 v1 `safetyOutcome`: the 8 outcomes of A3-22 and B3-17, as their branch labels give them word for word, and Unsure. */
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

/** K-02 v1 `tense` (arch 06 line 329). */
export const TENSES = ["now", "could restart", "over", "joke", "unknown"] as const;
export type Tense = (typeof TENSES)[number];

/** The tenses that are not danger: "Over and joke are not danger" (arch 06 line 329). */
export const NOT_DANGER_TENSES: readonly Tense[] = ["over", "joke"];

/** K-02 v1 `safetyLabel`: one label, with its tense, evidence words, who is at risk and who wrote it (arch 03 line 183). */
export interface SafetyLabel {
  outcome: SafetyOutcome;
  tense: Tense;
  evidence: string;
  atRisk: string;
  writer: string;
}

/** K-02 v1 `safetyRead`: what one model read returns for one raw text, several labels at once allowed. */
export interface SafetyRead {
  labels: SafetyLabel[];
}

/** Where a text to read comes from (K-02 v1 `safetyResult.source`; arch 02 lines 111 and 129). */
export const SAFETY_SOURCES = ["text", "page", "agent"] as const;
export type SafetySource = (typeof SAFETY_SOURCES)[number];

/** One model try (K-02 v1 `safetyResult.tries[]`): Haiku, then Sonnet, 2 s each. */
export interface SafetyTry {
  model: "haiku" | "sonnet";
  result: "verdict" | "timeout" | "error";
}

/** K-02 v1 `safetyResult.dangerWords[]`: a danger word code matched. Matching them is T-366's; this read leaves none. */
export interface DangerWordMatch {
  words: string;
  list: "general" | "plugin";
  kind: "selfHarm" | "other";
}

/**
 * K-02 v1 `safetyResult`: the read's output for one raw text, as the actor hands it on (C-047, T-246), and as free text
 * from a secure page or an outside AI gets it (arch 02 line 129).
 */
export interface SafetyResult {
  eventId: string;
  source: SafetySource;
  tries: SafetyTry[];
  read: SafetyRead | null;
  timedOut: boolean;
  dangerWords: DangerWordMatch[];
  outcomes: SafetyOutcome[];
  liftedToUnsure: boolean;
}

/** One text to read. */
export interface SafetyReadInput {
  /** The raw text's event id, or the page or agent call's id (K-02 v1 `safetyResult.eventId`). */
  readonly eventId: string;
  /** text: a text or email on arrival, before batching; page: free text from a secure page; agent: from an outside AI. */
  readonly source: SafetySource;
  /** The words, plain, as they came (after the edge scrub): a text's or email's body, or the free text sent. */
  readonly text: string;
  /** An email's subject, read with its body (the actor's opened `SealedWords` hold both); null or absent otherwise. */
  readonly subject?: string | null;
}

/**
 * What a finished read gives back: the K-02 result and the model calls it made (K-08 v1 `model_calls`). It is the
 * actor's `SafetyReadAnswer` (runtime/src/safety/types.ts, T-246) field for field.
 */
export interface SafetyReadAnswer {
  result: SafetyResult;
  modelCalls: ModelCall[];
}

/** What the safety read is built with: one bundle's id, models and safety read prompt, and the key's environment. */
export interface SafetyReaderOptions {
  /** The bundle id and its two model ids (K-01 v1 manifest), checked as the AI gateway checks them (T-361). */
  readonly bundle: GatewayBundle;
  /** The same bundle's prompt layout (T-364): its safety read prompt is the call's cached system prompt. */
  readonly prompts: PromptCache;
  /** The environment the key is read from, by name (ANTHROPIC_API_KEY), at the moment of each call. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the global `fetch`. Tests pass a fake Messages API. */
  readonly fetch?: FetchLike;
}

/** Where one read's spans go. */
export interface SafetyReadCallOptions {
  /** The text's trace (K-08 v1); its bundle id must be the reader's. No trace: no span is written. */
  readonly trace?: TraceContext;
  /** The business, when known, for the spans. */
  readonly businessId?: string | null;
}

/** The safety read (C-113): Haiku, then Sonnet if Haiku fails or times out, 2 s each, outside the AI gateway. */
export interface SafetyReader {
  /**
   * Reads one text. A verdict comes as soon as a try gives one. Never rejects for a failed model call: a read that
   * gets no verdict answers with no verdict (`read` null, `timedOut` true) 4 s after the call, when both 2 s tries
   * have timed out, and then too when they failed sooner (no verdict in 4 s: arch 02 line 111). It rejects
   * only for a call that cannot be made at all, before any model call: no key, or a trace of another bundle (a set-up
   * fault, loud; the actor then applies its own no-verdict rule).
   */
  read(input: SafetyReadInput, options?: SafetyReadCallOptions): Promise<SafetyReadAnswer>;
}
