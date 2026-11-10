// Types of the composer's side of the recorded-model double (T-1071, C-123). The composer works at K-03's level
// (contracts/message-plan/README.md), not K-02's: its input is `$defs/composeInput` and its answer `$defs/plan`. Both are
// typed as plain JSON here; their one definition is K-03's schema at the version each recordings file names
// (message-plan.v1.schema.json, or message-plan.v1.1.schema.json for an input with term facts: T-1175), which the
// double checks every recording against at load.

import type { JsonObject, RecordedModel } from "./types";

/** `$defs/composeInput`: what the composer is given, one per outbox row. */
export type ComposeInput = JsonObject;
/** `$defs/plan`: the composer's structured output. */
export type MessagePlan = JsonObject;

/** The one kind of composer recording: the plan the composer returns for an input. */
export const COMPOSER_KIND = "composerPlan";

/**
 * The composer's double. It replays the recorded plan for exactly that input (keyed by the sha256 of its canonical JSON),
 * or rejects (NoRecordingError): there is no fallback plan. Each call returns a fresh copy.
 */
export interface RecordedComposer {
  /** The composer's plan for one outbox row's input (C-118). */
  composer(input: ComposeInput): Promise<MessagePlan>;
  /** How many composer recordings it holds. */
  readonly size: number;
}

/** Both doubles in one: the three K-02 reads and the composer. `size` counts every recording. */
export type RecordedDouble = RecordedModel & RecordedComposer;
