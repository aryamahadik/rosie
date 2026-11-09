// What the compose-input call reads and gives (C-090, T-309; K-09 v1 composeInput; K-03 v1 composeInput; arch 07 line
// 397: "After the commit, each outbox row gets its own composer call, in parallel, with its committed choices and only
// what limit 7 lets its recipient see, never the frontier; an email copy takes its text row's plan instead").
//
// K-09 v1's request and answer, and the K-03 v1 composer input inside it, are the generated contract types (`npm run
// contracts:types`; ADR-005), reached through the Tool API's call types, so the call and the base read one shape. What
// code knows about the row is a port, another task's: no K-05 v1 call reads an outbox row with its step and its reader
// (T-313's readRow is the same seam for the finalize call). So the call is tested with doubles, and it fails closed
// (notBuilt, nothing read) until the port is built.

import type { Role } from "../domain/identity-access";
import type { ClaimContext } from "../finalize/claim-check";
import type { SlotName, SlotSource } from "../finalize/slots";
import type { BundleId, FlowLetter, FrontierBundles } from "../frontier/assemble/types";
import type { AnswerOf, CallContext, ErrorsOf, RequestOf, ResponseOf } from "../tool-api";

// ---- K-09 v1 composeInput (contracts/tool-api), through the Tool API's call types ------------------------------------

export type ComposeInputRequest = RequestOf<"composeInput">;
export type ComposeInputResponse = ResponseOf<"composeInput">;
/** K-09 v1 `composeInput.errors`: each "Refused, nothing written". */
export type ComposeInputError = ErrorsOf<"composeInput">;
export type ComposeInputAnswer = AnswerOf<"composeInput">;

/** K-03 v1 `composeInput`: the composer's input for one outbox row. */
export type ComposeInput = Extract<ComposeInputResponse, { result: "compose" }>["input"];
/** K-03 v1 `conversationMessage`: one of the reader's last messages with this business, redacted. */
export type ConversationMessage = ComposeInput["conversation"][number];
/** K-03 v1 `fact`: a slot name and its value as this reader may see it. */
export type Fact = ComposeInput["facts"][number];
/** K-03 v1 `audience`. */
export type Audience = ComposeInput["audience"];
/** K-03 v1 `situation`: code's tone tag (arch 07 line 357; C-090). */
export type Situation = ComposeInput["situation"];
/** K-03 v1 `channel`. */
export type Channel = ComposeInput["channel"];
/** K-03 v1 `format`. */
export type Format = ComposeInput["allowedFormats"][number];
/** K-03 v1 `linkSlot`. */
export type LinkSlot = ComposeInput["allowedLinks"][number];
/** K-03 v1 `option`: one option of the open question, its label word for word. */
export type Option = ComposeInput["options"][number];
/** K-03 v1 `openQuestion`: a question still open with this reader, its words as sent. */
export type OpenQuestion = ComposeInput["openQuestions"][number];
/** K-03 v1 `inbound`. */
export type Inbound = NonNullable<ComposeInput["inbound"]>;
/** K-03 v1 `reach`: how this reader is reached. */
export type Reach = Audience["way"];

/** K-07 v1 `rowState`, as K-09 v1's rowClosed names it. */
export type RowState = Extract<ComposeInputError, { error: "rowClosed" }>["state"];
/** K-05 v1 `notFoundError`, as K-09 v1 answers it. */
export type NotFound = Extract<ComposeInputError, { error: "notFound" }>;
/** K-05 v1 `transientError`: nothing read; the same request may be sent again. */
export type Transient = Extract<ComposeInputError, { error: "transient" }>;

// ---- the situation tag's facts (C-090; arch 07 line 357) -----------------------------------------------------------

/**
 * What the committed turn says a row is about, in arch 07 line 357's own words, each a closed label:
 *   - deathReport: a death report (grief, gentle);
 *   - gettingWorse, paymentProblem, complaint, damage, lateness, businessCannotMakeIt, platformFailure: a problem;
 *   - readBack, charge, refund, fee: money or consent.
 * A safety outcome is not a label here (SituationFacts.safetyOutcomes), nor is the sensitive switch, which the row's
 * slot source holds (RULES 4.6; S13-22).
 */
export type Concern =
  | "deathReport"
  | "gettingWorse"
  | "paymentProblem"
  | "complaint"
  | "damage"
  | "lateness"
  | "businessCannotMakeIt"
  | "platformFailure"
  | "readBack"
  | "charge"
  | "refund"
  | "fee";

/** What sets the row's tone that only the committed turn knows (C-090). */
export interface SituationFacts {
  /**
   * The safety outcomes of the texts the row answers (K-34 v1 safety_outcomes.outcome; K-02 v1 safetyOutcome), or none.
   * Any outcome other than No makes the row gentle ("a safety outcome other than No": arch 07 line 357).
   */
  readonly safetyOutcomes: readonly string[];
  /** What the row is about, each label once. */
  readonly about: readonly Concern[];
}

// ---- what code knows about the row ---------------------------------------------------------------------------------

/** The text the row replies to, with the handle it came from, so code gives it only to its own sender. */
export interface InboundText {
  /** Its words after the edge scrub, private words given as 'a private detail' (arch 07 line 397; RULES 4.5). */
  readonly text: string;
  readonly sentAt: Inbound["sentAt"];
  /** The handle it came from (K-04 v1 handles id). */
  readonly fromHandleId: string;
}

/**
 * The row as the compose-input call reads it, on the primary, uncached (K-09 v1 composeInput.request: "the row and
 * today's record"). Every value a person reads comes from here or from the bundle, never from the frontier.
 */
export interface ComposeRow {
  readonly outboxRowId: string;
  /** The turn that committed the row (K-03 v1 composeInput `turn`). */
  readonly turnId: string;
  readonly state: RowState;
  /** Whether the row holds a plan already (K-04 v1 outbox_rows.plan): then nothing is composed (arch 11 line 576). */
  readonly hasPlan: boolean;
  readonly channel: Channel;
  /** For an email copy, the text row whose plan it takes (K-04 v1 outbox_rows.copy_of_row_id); else null. */
  readonly copyOfRowId: string | null;
  /**
   * The fixed line code writes into this row word for word, or null: the guard's STOP, START and HELP replies, a safety
   * line, the outage line. Such a row is never composed (STATE note 17; K-09 v1 open gap 16).
   */
  readonly fixedLineId: string | null;
  /** The handle the row goes to (K-04 v1 outbox_rows.recipient_handle_id). */
  readonly recipientHandleId: string;
  /** The bundle the row was committed under (K-04 v1 outbox_rows.bundle_id): its step's line is read there. */
  readonly bundleId: BundleId;
  /** The flow the row's turn ran in (K-02 v1 context.flow): a shared step's line is read in it first. */
  readonly flow: FlowLetter;
  /** The step whose line the row carries (K-01 v1 stepId; K-09 README default 112). */
  readonly step: string;
  /**
   * Which of the step's lines from Rosie to this reader the row carries, in the step's `say` order: 0 for the first. Most
   * steps print one line to each reader.
   */
  readonly line: number;
  /**
   * The recipient's role at this business, the one the message is for, taken for one person (identity and access, T-308:
   * K-04 v1 person_roles; S13-31), read as limit 7's reader (readerOf).
   */
  readonly role: Role;
  /** The reader's name as Rosie addresses them, or null when none is known (K-03 v1 audience.name). */
  readonly name: string | null;
  /** How this reader is reached (K-03 v1 audience.way). */
  readonly way: Reach;
  /** The handling line word for word, or null (K-03 v1 audience.handlingLine; S13-19; K-01 layerLines). */
  readonly handlingLine: string | null;
  /** The reader's language (K-03 v1 `language`; arch 06: the text's, else the person's stored one, else the business's). */
  readonly language: string;
  /** What the row's facts are filled from (T-310): the record and the code facts for this reader. */
  readonly source: SlotSource;
  /**
   * The rest of limit 7's context: the field each value was actually read from, where it is not the slot's own (STATE
   * note 12), and whether the relayed words were read clear (RULES 4.5).
   */
  readonly claim: Omit<ClaimContext, "reader">;
  /**
   * The slots the row is about: the committed values this message states, in order. With the slots of the step's line,
   * each becomes a fact only as limit 7 lets this reader see it (claimFacts); never a link (allowedLinks) or a slot
   * filled at send.
   */
  readonly factSlots: readonly SlotName[];
  /**
   * The reader's last messages with this business, oldest first, redacted as <inbound> is (arch 07 line 397; RULES 4.5:
   * private words as 'a private detail'); code keeps the last 6.
   */
  readonly conversation: readonly ConversationMessage[];
  /** What this phone allows right now (arch 07 line 365; C-128, the runtime engineer's): at least one format. */
  readonly allowedFormats: readonly Format[];
  /** The link slots the step's message may carry (K-03 v1 allowedLinks); each kept only as limit 7 lets the reader see it. */
  readonly allowedLinks: readonly LinkSlot[];
  /** The open question's options as sent, in order, each label word for word (K-04 v1 open_questions.options). */
  readonly options: readonly Option[];
  /** The questions still open with this reader, each with its words as sent (arch 07 line 389). */
  readonly openQuestions: readonly OpenQuestion[];
  /** The text the row replies to, or null; given to the composer only when it came from the row's own recipient. */
  readonly inbound: InboundText | null;
  readonly situation: SituationFacts;
}

/** The row read: the row, or K-05's notFound or transient (nothing read). */
export type ComposeRowRead = ComposeRow | NotFound | Transient;

// ---- the ports and what the call runs with -------------------------------------------------------------------------

/**
 * What the compose-input call reads through, each another task's:
 *   - readRow: the row as above, inside the call's own transaction and business scope (the Tool API base), on the
 *     primary, uncached (K-09 README, "Reads, repeats and time budgets").
 */
export interface ComposeInputPorts<Repo = unknown> {
  readRow(outboxRowId: string, call: CallContext<Repo>): Promise<ComposeRowRead>;
}

/**
 * The bundles a row's step line is read from (K-01 v1): its manifest and its flow graphs, by bundle id, from KV or
 * PostgreSQL's copy on a miss (arch 10 line 536). The frontier's own port (T-291), so one reader serves both.
 */
export type ComposeBundles = FrontierBundles;

export type { BundleId, FlowLetter };
