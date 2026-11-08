// What the fixed-line inserter throws (T-314). Inside the finalize call a throw rolls the call's transaction back (the
// Tool API base), so nothing is written and nothing is sent: a text that cannot carry its fixed lines word for word never
// goes (fail closed). Each message names a fault and a K-01 line id, both labels code made: never a value, a business's
// name or a line's words.

/**
 * Why a row's fixed lines could not be added:
 *   - lineNotInBundle: the bundle holds no line of that id in the reader's language or in English (K-01 v1 fixedLine);
 *   - lineWaitsForJay: the line's words wait for Jay (K-01 v1 status pendingJay; Q-01);
 *   - noBusiness: the line names <business> and the row has no business for it (the row read's businessName is null);
 *   - businessNotClaimed: the line names <business>, and the name limit 7 lets this reader see (biz.name, the display
 *     name under the sensitive switch: RULES 4.6, S13-22) is not the row read's businessName, the one the Fixed lines
 *     check fills it with (STATE note 26);
 *   - stopReplyLine: the port asked for stopReply, which no composed message carries (T-267's security note b);
 *   - firstTextLineListed: the port asked for the opener, the opt-out line or the privacy link, which only the first-text
 *     rule adds (RULES 4.3: "No other message carries it");
 *   - lineListedTwice: the port asked for one line twice;
 *   - tapbackAlone: the parts are a tapback, which goes alone and carries no words (arch 07 line 391);
 *   - noRoomForWords: the parts have two sends and neither is the words, so a words send would make three (arch 07 line
 *     367: at most two sends).
 */
export type FixedLineFault =
  | "lineNotInBundle"
  | "lineWaitsForJay"
  | "noBusiness"
  | "businessNotClaimed"
  | "stopReplyLine"
  | "firstTextLineListed"
  | "lineListedTwice"
  | "tapbackAlone"
  | "noRoomForWords";

/** A K-01 fixed line id (bundle.v1.schema.json fixedLine.id); anything else is never echoed. */
const LINE_ID = /^[a-z][A-Za-z0-9]*$/;

/** The fixed lines could not be added word for word: nothing is written. */
export class FixedLineRefusedError extends Error {
  override name = "FixedLineRefusedError";
  readonly fault: FixedLineFault;
  /** The K-01 line id it concerns, when it is one (a label), or null. */
  readonly line: string | null;

  constructor(fault: FixedLineFault, line: string | null = null) {
    const id = line !== null && LINE_ID.test(line) ? line : null;
    super(
      id === null
        ? `insertFixedLines: refused (${fault}); nothing was written`
        : `insertFixedLines: refused (${fault}: ${id}); nothing was written`,
    );
    this.fault = fault;
    this.line = id;
  }
}
