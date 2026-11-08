// What the fixed-line inserter reads (C-089, T-314; arch 07 line 361: "Fixed lines are added by code, match their source
// word for word in section 06's language, and sit outside the Shape and Length counts").
//
// The words of every fixed line are the bundle's (K-01 v1 `sharedLists.fixedLines`), which the row read carries as
// `row.checks.lists` for the message checks to read too (T-312), so the words code adds and the words the Fixed lines
// check holds them to are one list. Which lines a row carries is not in the row read (T-313's FinalizeRow): it is what
// the send state says about the row's handle and business, read through this module's own port, FixedLinePorts. Its
// real reader is another task's: K-05 has no call that answers it inside the Tool API's business scope (T-220's
// sendState, which reads phones.optout_line_delivered_at, runs only on the runtime side and refuses under a business
// scope; no K-05 call reads whether Rosie texted a handle about a business before). Until it lands the port fails closed
// (notBuiltFixedLinePorts), and the tests use a double.

import type { CallContext } from "../../tool-api";
import type { FinalizeRow } from "../rewrite";

/** K-01 v1's opener: "This is Rosie, the automated booking assistant for <business>." (arch 07 line 361; S13-01). */
export const OPENER_LINE = "opener";

/** K-01 v1's STOP, HELP and rates line, S13-02's (RULES 4.3; msgtext.js line 14; Q-30). */
export const OPT_OUT_LINE = "optOutLine";

/**
 * The privacy-notice link, alone on the last line (RULES 1.11, 4.3: "Every page and first text links to a plain privacy
 * notice"; arch 12 line 644; Q-30). K-01 v1's sample list has no line for it yet, so this id is the one proposed for the
 * fixed lines' compiler module; until the bundle carries it, a first text is refused whole (fail closed).
 */
export const PRIVACY_LINK_LINE = "privacyLink";

/** The lines Rosie's first texts carry, each by the rule below (firstTextLines), never asked for by the port. */
export const FIRST_TEXT_LINES: readonly string[] = [OPENER_LINE, OPT_OUT_LINE, PRIVACY_LINK_LINE];

/**
 * The one line besides a safety row that limit 8 lets past the stopped flag (T-267's security note b): a composed
 * message never carries it, so the inserter refuses it, as the finalize call does (T-313).
 */
export const STOP_REPLY_LINE = "stopReply";

/** What the send state says about the row's handle and business, and the other fixed lines the row carries. */
export interface FixedLineFacts {
  /**
   * Whether Rosie has texted this handle about the row's business before. When not, this is Rosie's first text to the
   * handle about that business (DD), so it carries the opener and the privacy-notice link (arch 07 line 361; RULES 1.11,
   * 4.3; S13-01; Q-30).
   */
  readonly textedAboutBusiness: boolean;
  /**
   * When the STOP, HELP and rates line was first delivered to this number (K-04 core phones.optout_line_delivered_at,
   * as T-220's sendState reads it into K-05 v1.2 phoneRead.optoutLineDeliveredAt), or null while none of its texts that
   * carried it was delivered, and for a handle with no phone row. The line rides on a number's texts until one is
   * delivered (arch 07 line 361; core.v1's column), and no other message carries it (RULES 4.3).
   */
  readonly optOutLineDeliveredAt: string | null;
  /**
   * The row's other fixed lines, by K-01 id, in the order they go after the words: the code text (S13-45), safety lines
   * (arch 06 line 329: "unknown reads as danger and adds 'Is anyone in danger right now?'"), checked terms and lines
   * RULES quotes (arch 06 line 341), the handling line on owner and staff messages about a private booking or a
   * texts-only or email-only customer (S13-19). Never a first text's line, never stopReply, each once.
   */
  readonly lines: readonly string[];
}

/**
 * The inserter's port: the send-state facts of one row, read in the finalize call's own transaction and business scope
 * (the Tool API base), so an error rolls the whole call back.
 */
export interface FixedLinePorts<Repo = unknown> {
  readFixedLines(row: FinalizeRow, call: CallContext<Repo>): Promise<FixedLineFacts>;
}

/** Which of a first text's lines one row carries (firstTextLines). */
export interface FirstTextLines {
  readonly opener: boolean;
  readonly optOut: boolean;
  readonly privacyLink: boolean;
}
