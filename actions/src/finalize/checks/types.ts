// What the message checks read and give (C-092), written by hand: the generated contract types are git-ignored
// (ADR-005) and the Worker must not depend on them. The tests hold these shapes to the contracts' own fixtures.
//   - K-03 v1 (contracts/message-plan/message-plan.v1.schema.json): $defs finalParts, send, option, fact, format,
//     checkName and checkOutcome.
//   - K-01 v1 (contracts/bundle/bundle.v1.schema.json): $defs sharedLists, keywords and fixedLine, the lists "the guard,
//     the lint and the message checks all read" from the bundle.

/** A format (K-03 `format`; arch 07 lines 373 to 393). */
export type Format = "text" | "poll" | "linkCard" | "calendarFile" | "tapback";

/** What one send is (K-03 `sendKind`; arch 07 line 367). */
export type SendKind = "words" | "poll" | "linkCard" | "tapback";

/** The calendar file the words carry (K-03 `calendarFile`; arch 07 line 383). */
export type CalendarFile = "none" | "new" | "move" | "cancel";

/** The channel a row goes on (K-03 `channel`; arch 07 lines 365, 371). */
export type Channel = "imessage" | "rcs" | "sms" | "email";

/** An option with the label code inserts word for word (K-03 `option`; arch 07 lines 361, 379). */
export interface Option {
  readonly id: string;
  readonly label: string;
}

/** A slot and the code-supplied value it took (K-03 `fact`; arch 07 line 409). */
export interface SlotValue {
  readonly slot: string;
  readonly value: string;
}

/** One send of the final message (K-03 `send`; arch 07 line 367). */
export interface Send {
  readonly kind: SendKind;
  readonly text: string | null;
  readonly calendarFile: CalendarFile;
  readonly options: readonly Option[];
  readonly link: string | null;
}

/** The message after code: options inserted, fixed lines added, slots filled (K-03 `finalParts`; arch 02 line 123). */
export interface FinalParts {
  readonly row: string;
  readonly channel: Channel;
  readonly sends: readonly Send[];
  readonly fixedLines: readonly string[];
  readonly slotValues: readonly SlotValue[];
  readonly threadReplyTo: string | null;
}

/** A check on every message (K-03 `checkName`; arch 07 lines 405 to 417). */
export type CheckName =
  "fixedLines" | "values" | "oneQuestion" | "neverInMessage" | "shape" | "lengthAndReading" | "format";

/** One check's result (K-03 `checkOutcome`): `detail` says what failed, in the words the rewrite is told. */
export interface CheckOutcome {
  readonly check: CheckName;
  readonly passed: boolean;
  readonly detail: string | null;
}

/** One fixed line of the bundle (K-01 `fixedLine`): its words, with <business> its one placeholder; null for Jay. */
export interface FixedLine {
  readonly id: string;
  readonly text: string | null;
  readonly lang: string;
}

/** The parts of the bundle's shared lists the checks read (K-01 `sharedLists`: `keywords.optOut`, `fixedLines`). */
export interface CheckLists {
  /** The guard's keywords: `optOut` is msgtext.js's 16 opt-out words (msgtext.js OPTOUT, line 29). */
  readonly keywords: { readonly optOut: readonly string[] };
  /** The fixed lines word for word (arch 07 line 361). */
  readonly fixedLines: { readonly lines: readonly FixedLine[] };
}

/** What the checks need beside the final parts: the bundle's lists and the row's composer input (K-03 `composeInput`). */
export interface CheckContext {
  /** The bundle's shared lists (K-01 `sharedLists`), which the guard, the lint and the message checks all read. */
  readonly lists: CheckLists;
  /** The reader's language (K-03 `language`): fixed lines in it, else in English; the grade reads English only. */
  readonly language: string;
  /** The business that fills a fixed line's <business> (arch 07 line 361), or null before there is one (S1-02). */
  readonly businessName: string | null;
  /** The step's options with their labels (K-03 composeInput `options`), the words each poll option must have. */
  readonly options: readonly Option[];
  /** The options as the words carry them in msgtext.js's text form until the handle has voted (arch 07 line 379), or null. */
  readonly typedOptions: string | null;
  /** What this phone allows right now (K-03 composeInput `allowedFormats`; arch 07 line 365). */
  readonly allowedFormats: readonly Format[];
  /** The facts the composer was given (K-03 composeInput `facts`, after limit 7): a value may match one. */
  readonly facts: readonly SlotValue[];
  /**
   * Rosie's own fixed terms the row's step card states, or none: each line of the step's compiled card that names no
   * slot, word for word (K-03 v1.1 term facts; CQ-86's default). Code-supplied words like slot values: where one stands
   * whole in the words send, Shape and Length count none of its words (arch 07 line 417; DL-158), while the Values check
   * still reads them against the facts.
   */
  readonly terms: readonly string[];
  /** The reader's name as Rosie addresses them (K-03 composeInput `audience.name`), or null: a name may match it. */
  readonly readerName: string | null;
  /**
   * The step's master line (K-03 composeInput `masterText.text`), or null. Its words outside the slots are the step's
   * own checked words, so a number or name they state counts as code-supplied (arch 12 line 592: Rosie's own fee terms
   * stay words); a slot's example words never do (S13-28 rule 51: "never the example").
   */
  readonly masterText: string | null;
}

/** The checks' result on one attempt: each check once, in K-03's order. */
export interface MessageCheckResult {
  readonly checks: readonly CheckOutcome[];
  /** Every check passed: the message sends. */
  readonly passed: boolean;
  /** A blocking check missed: fixed lines, values, one question or never in a message (arch 07 line 417). */
  readonly blocked: boolean;
}
