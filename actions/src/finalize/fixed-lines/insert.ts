// The fixed-line inserter (C-089, T-314; arch 07 line 361; arch 02 line 123: "Code inserts its options and fixed lines
// and fills its slots, then the claim check runs limit 7 and the message checks"). The finalize call (T-313) calls it on
// each attempt's parts, after limit 7, the fill and the parts, before the seven message checks (its insertFixedLines
// port), and on the passed-on line, which is written as it is.
//
// What it adds, each word for word as the bundle writes it (K-01 v1 `sharedLists.fixedLines`) in the reader's language,
// else in English, as the Fixed lines check reads it (T-312's fixedLineWords, called here, so the two never differ):
//   - on Rosie's first text to a handle about one business (DD): the opener before the first line, as finalize-pass.json
//     places it ("This is Rosie, the automated booking assistant for <business>."; S13-01; RULES 1.11), and the
//     privacy-notice link alone on the last line (RULES 4.3; arch 12 line 644; Q-30);
//   - on a number's texts until one that carried it is delivered: the STOP, HELP and rates line, S13-02's (RULES 4.3;
//     msgtext.js line 14; Q-30: "Rosie's first reply in a chat the person opened, which is now the first text that
//     number gets"), just above the privacy link, the whole line as the bundle writes it (msgtext.js's stopLine leaves
//     out a part the text already says; a fixed line is matched whole). Never on an email row: it is a number's line
//     (RULES 4.3: "The first text a number ever gets"), and no other message carries it;
//   - the row's other fixed lines, each on its own line after the words, in the port's order: the code text, safety
//     lines, checked terms and lines RULES quotes, the handling line (S13-45, arch 06, S13-19);
//   - the danger question, K-01's safetyAsk ("Is anyone in danger right now?"), on its own line right after the row's
//     safety line, once, when a text the row answers holds a label of unknown tense other than No (arch 06 line 329;
//     S13-24 rule 10; T-1164, CQ-164 d): the rule the handle actor's direct path follows (runtime/src/safety/rules.ts
//     checkedLineFor, T-1143), since the core's safety record does not choose it (T-1140's handoff 4). See
//     asksIfInDanger for what readOutboxRow's facts can tell, and dangerQuestionAfter for its place.
// Poll options are inserted with the parts (rewrite/parts.ts: the step's labels word for word), and the typed options
// end the words; both stay as they are.
//
// Every added line's id goes into `fixedLines`, which is what keeps its words out of the Shape and Length counts (the
// 260 or 320 characters, the 22 words, the grade) and out of the Values check (checks/reading.ts insertedWords). The
// parts' slot values are kept as they are (STATE note 34: finalize scrubs every check detail by them), and nothing is
// added to them: a fixed line fills no slot.
//
// A line that names <business> is filled with the business's name as limit 7 lets this reader see it: biz.name through
// the claim check, the display name under the sensitive switch (RULES 4.6, S13-22; STATE note 26). That must be the row
// read's businessName, the name the Fixed lines check fills it with; when it is not, or there is none, the text is
// refused whole. So is a line the bundle has no words for: a text that cannot carry its fixed lines word for word never
// goes (fail closed). Nothing here logs, and a refusal names only a fault and a line id.

import { claimText } from "../claim-check";
import type { CheckContext, FixedLine } from "../checks";
import { fixedLineWords } from "../checks/reading";
import type { Channel, FinalParts, FinalizeRow, Send } from "../rewrite";
import { FixedLineRefusedError } from "./errors";
import {
  FIRST_TEXT_LINES,
  OPENER_LINE,
  OPT_OUT_LINE,
  PRIVACY_LINK_LINE,
  SAFETY_ASK_LINE,
  SAFETY_LINES,
  STOP_REPLY_LINE,
  type AnsweredText,
  type FirstTextLines,
  type FixedLineFacts,
} from "./types";

/** The business's name slot (K-03 v1 slots.json biz.name; sensitive form displayName). */
const BIZ_NAME = "biz.name";

/**
 * Which of a first text's lines this row carries: the opener and the privacy link on Rosie's first text to the handle
 * about the row's business; the opt-out line on a number's texts until one that carried it is delivered, never on email.
 */
export function firstTextLines(channel: Channel, facts: FixedLineFacts): FirstTextLines {
  const firstAboutBusiness = !facts.textedAboutBusiness;
  return {
    opener: firstAboutBusiness,
    optOut: channel !== "email" && facts.optOutLineDeliveredAt === null,
    privacyLink: firstAboutBusiness,
  };
}

/**
 * The business's name as limit 7 lets this reader see it (biz.name through the claim check and the fill: the display
 * name under the sensitive switch), or null when there is none to show.
 */
export function claimedBusiness(row: FinalizeRow): string | null {
  const claimed = claimText(`{{${BIZ_NAME}}}`, row.source, { ...row.claim, reader: row.reader });
  if (!claimed.ok) return null;
  const name = claimed.slotValues.find((fact) => fact.slot === BIZ_NAME)?.value ?? "";
  return name.trim() === "" ? null : name;
}

/** The bundle's line `id` the Fixed lines check reads: in the reader's language, else in English. */
function sourceLine(id: string, context: CheckContext): FixedLine | undefined {
  const lines = context.lists.fixedLines.lines.filter((line) => line.id === id);
  return lines.find((line) => line.lang === context.language) ?? lines.find((line) => line.lang === "en");
}

/**
 * One fixed line's words, word for word as the Fixed lines check holds them (fixedLineWords on the row read's context),
 * <business> filled; refused when the bundle has none, or when the business it names is not the one limit 7 lets this
 * reader see (`business`, from claimedBusiness).
 */
export function fixedLineText(id: string, context: CheckContext, business: string | null): string {
  const line = sourceLine(id, context);
  if (line === undefined) throw new FixedLineRefusedError("lineNotInBundle", id);
  if (line.text === null) throw new FixedLineRefusedError("lineWaitsForJay", id);
  const checked = fixedLineWords(id, context);
  if (!("words" in checked)) throw new FixedLineRefusedError("noBusiness", id);
  const claimed = fixedLineWords(id, { ...context, businessName: business });
  if (!("words" in claimed) || claimed.words !== checked.words)
    throw new FixedLineRefusedError("businessNotClaimed", id);
  return checked.words;
}

/** The port's lines, each once, never a first text's line nor stopReply. */
function listedLines(lines: readonly string[]): string[] {
  const seen: string[] = [];
  for (const id of lines) {
    if (id === STOP_REPLY_LINE) throw new FixedLineRefusedError("stopReplyLine", id);
    if (FIRST_TEXT_LINES.includes(id)) throw new FixedLineRefusedError("firstTextLineListed", id);
    if (seen.includes(id)) throw new FixedLineRefusedError("lineListedTwice", id);
    seen.push(id);
  }
  return seen;
}

/**
 * Whether a text the row answers holds a label of unknown tense other than No, which adds the danger question (arch 06
 * line 329: "unknown reads as danger and adds 'Is anyone in danger right now?'"; S13-24 rule 10), as the handle actor's
 * direct path asks it: a label whose tense is unknown and whose outcome is not No (runtime/src/safety/rules.ts
 * checkedLineFor, T-1143).
 *
 * readOutboxRow gives each text's tenses, one per label, and what holds after code's rules, but not each label's own
 * outcome (K-34 v1 labels). What holds is each label's danger outcome but an over or joke one, else No, and a trade's
 * danger word lifts that No to Unsure (ai/src/safety read.ts heldOutcomes, lift.ts afterVerdict). So a label of unknown
 * tense other than No is always among what holds, and a text asks when one of its tenses is unknown and something other
 * than No holds (default 1). The one case these facts cannot tell apart, a No label of unknown tense beside a danger
 * outcome that another label or a danger word gave, asks too, where the actor's path, which reads the labels, asks
 * nothing: unknown reads as danger (arch 06 line 329; A3-22: "Safe default: unsure is read as danger"). No asks nothing,
 * nor do known tenses, a read that timed out (no label: CQ-163 b) and a text whose read the scope does not show (null),
 * as the actor's path asks nothing with no label.
 */
export function asksIfInDanger(texts: readonly AnsweredText[]): boolean {
  return texts.some(
    ({ outcomes, tenses }) =>
      (tenses?.includes("unknown") ?? false) && (outcomes?.some((outcome) => outcome !== "No") ?? false),
  );
}

/**
 * The listed lines with the danger question right after the last safety line, once, when the texts the row answers call
 * for it (asksIfInDanger); a place the port gave it is dropped for this one. Otherwise the lines as listed: no safety
 * line, or no such label, adds none, and a port that lists the question keeps it where it put it (T-314).
 */
export function dangerQuestionAfter(
  lines: readonly string[],
  texts: readonly AnsweredText[],
): readonly string[] {
  let last = -1;
  lines.forEach((id, at) => {
    if (SAFETY_LINES.includes(id)) last = at;
  });
  if (last === -1 || !asksIfInDanger(texts)) return lines;
  const others = (part: readonly string[]): string[] => part.filter((id) => id !== SAFETY_ASK_LINE);
  return [...others(lines.slice(0, last + 1)), SAFETY_ASK_LINE, ...others(lines.slice(last + 1))];
}

/** The words with the opener before the first line and each line after on its own line, the last one last. */
function placed(text: string, before: readonly string[], after: readonly string[]): string {
  const opener = before.join(" ");
  const first = opener === "" ? text : text === "" ? opener : `${opener} ${text}`;
  return [first, ...after].filter((line) => line !== "").join("\n");
}

/** The sends with the lines in the words send; a poll or card alone gets a words send before it (arch 07 line 367). */
function withLines(
  sends: FinalParts["sends"],
  before: readonly string[],
  after: readonly string[],
): FinalParts["sends"] {
  const [first, second] = sends;
  if (first.kind === "words") {
    const words: Send = { ...first, text: placed(first.text ?? "", before, after) };
    return second === undefined ? [words] : [words, second];
  }
  if (first.kind === "tapback") throw new FixedLineRefusedError("tapbackAlone");
  if (second !== undefined) throw new FixedLineRefusedError("noRoomForWords");
  const words: Send = {
    kind: "words",
    text: placed("", before, after),
    calendarFile: "none",
    options: [],
    link: null,
  };
  return [words, first];
}

/**
 * The parts with this row's fixed lines added (see the top of this file); the parts as they are when the row carries
 * none, or carries them already. Throws FixedLineRefusedError when a line cannot go word for word.
 */
export function insertFixedLines(parts: FinalParts, row: FinalizeRow, facts: FixedLineFacts): FinalParts {
  const first = firstTextLines(parts.channel, facts);
  const listed = dangerQuestionAfter(listedLines(facts.lines), facts.answeredTexts);
  const carried = new Set(parts.fixedLines);
  const before = (first.opener ? [OPENER_LINE] : []).filter((id) => !carried.has(id));
  const after = [
    ...listed,
    ...(first.optOut ? [OPT_OUT_LINE] : []),
    ...(first.privacyLink ? [PRIVACY_LINK_LINE] : []),
  ].filter((id) => !carried.has(id));
  if (before.length === 0 && after.length === 0) return parts;

  const business = claimedBusiness(row);
  const words = (id: string): string => fixedLineText(id, row.checks, business);
  return {
    row: parts.row,
    channel: parts.channel,
    sends: withLines(parts.sends, before.map(words), after.map(words)),
    fixedLines: [...parts.fixedLines, ...before, ...after],
    slotValues: parts.slotValues,
    threadReplyTo: parts.threadReplyTo,
  };
}
