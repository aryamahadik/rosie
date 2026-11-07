// Types of the recorded-model double (T-004, C-123). The double works at K-02 v1's level (contracts/model/README.md):
// it replays the three model-facing outputs, decideRead, safetyRead and plannerOutput, and nothing else. The outputs
// are typed as plain JSON here; their one definition is contracts/model/model.v1.schema.json, which the double checks
// every recording against at load.

export type JsonObject = Record<string, unknown>;

/** `$defs/decideRead`: what one decide read returns. */
export type DecideRead = JsonObject;
/** `$defs/safetyRead`: what one safety read returns for one raw text. */
export type SafetyRead = JsonObject;
/** `$defs/plannerOutput`: what the planner returns. */
export type PlannerOutput = JsonObject;
/** `$defs/context`: what decide and the planner are given. */
export type Context = JsonObject;

/** The three kinds of recorded answer (K-02's model-facing payloads). */
export const RECORDING_KINDS = ["safetyRead", "decideRead", "plannerOutput"] as const;
export type RecordingKind = (typeof RECORDING_KINDS)[number];

/** The role of one decide read in a turn (`$defs/read`.role): the first read, the check read, the one re-read. */
export const DECIDE_ROLES = ["first", "check", "reread"] as const;
export type DecideRole = (typeof DECIDE_ROLES)[number];

/** A safety read's request: the raw text it reads. */
export interface SafetyReadRequest {
  readonly text: string;
}

/** A decide read's request: the context it is given and which read of the turn it is. */
export interface DecideRequest {
  readonly context: Context;
  readonly role: DecideRole;
}

/** The planner's request: the context it is given (the same one decide reads, after meaning search). */
export interface PlannerRequest {
  readonly context: Context;
}

/**
 * The double. Each call replays the recorded answer for exactly that request, or rejects (NoRecordingError): there is
 * no fallback answer. Each call returns a fresh copy, so a caller changing it changes no later answer.
 */
export interface RecordedModel {
  /** The safety read of one raw text (C-113). */
  safetyRead(request: SafetyReadRequest): Promise<SafetyRead>;
  /** One decide read of a turn's context, by its role (C-115, C-116). */
  decide(request: DecideRequest): Promise<DecideRead>;
  /** The planner's answer for a context (C-117). */
  planner(request: PlannerRequest): Promise<PlannerOutput>;
  /** How many recordings it holds. */
  readonly size: number;
}
