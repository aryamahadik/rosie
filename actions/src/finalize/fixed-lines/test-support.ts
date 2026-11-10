// Doubles for the fixed-line inserter's tests (T-314). Never imported by the Worker. The row is T-313's A7-17 row (Lee's
// Barbershop's text to Alex M., the customer) and the finalize call runs through the Tool API base on T-313's fake repo;
// the send-state facts come from a double of this module's port. Names and values are the master's sample cast (Sam,
// Lee's Barbershop, Alex M., Riley) and the shop's own words, never a real person (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CheckLists, FixedLine } from "../checks";
import { contractFile, type RecordingRepo } from "../../tool-api/test-support";
import type { CallContext } from "../../tool-api";
import type { FinalParts, FinalizePorts, FinalizeRow, Send } from "../rewrite";
import { a717Row, bundleLists, fakeRepo, type FakeRepo } from "../rewrite/test-support";
import { fixedLineInserter } from "./index";
import type { AnsweredText, FixedLineFacts, FixedLinePorts } from "./types";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The master's msgtext.js (fixture set v1's copy), read as text only: its WORDS lines hold the opt-out line's parts. */
export function msgtextSource(): string {
  return readFileSync(path.join(REPO_ROOT, "fixtures/master/engine/work/build/msgtext.js"), "utf8");
}

/** K-01 v1's opener for Lee's Barbershop (fixed-lines.json opener, <business> filled). */
export const OPENER = "This is Rosie, the automated booking assistant for Lee's Barbershop.";

/** K-01 v1's STOP, HELP and rates line (fixed-lines.json optOutLine; msgtext.js line 14). */
export const OPT_OUT = "Reply STOP to opt out. Msg & data rates may apply. Reply HELP for help.";

/**
 * msgtext.js's Spanish opt-out line: WORDS.es stop, rates and help (line 32), joined by one space as stopLine joins them
 * (line 45), for a text that says none of them yet.
 */
export const OPT_OUT_ES =
  "Responda STOP para no recibir más. Pueden aplicarse tarifas de mensajes y datos. Responda HELP para recibir ayuda.";

/**
 * Stand-in words of the privacy-notice link, test data only: K-01 v1 has no line for it yet and no source gives its words
 * (Q-30, for Jay); the fixed lines' compiler module gives the real line.
 */
export const PRIVACY = "Privacy notice: rosfield.com/privacy";

/** The privacy link and the Spanish opt-out line as K-01 lines, as the fixed lines' compiler module would add them. */
export const PRIVACY_LINE: FixedLine = { id: "privacyLink", text: PRIVACY, lang: "en" };
export const OPT_OUT_ES_LINE: FixedLine = { id: "optOutLine", text: OPT_OUT_ES, lang: "es" };

/**
 * More lines a row can carry, for the tests: S13-45's code text and S13-19's handling line for a private booking, in the
 * master's own words (MASTER-FLOW-A.md S13-45 "The code text", S13-19 "Like this"), under ids the fixed lines' compiler
 * module would name; K-01 v1's safetyAsk is in its sample list.
 */
export const CODE_TEXT_LINE: FixedLine = {
  id: "codeText",
  text: "Type it only where you asked for it: on rosfield.com, in your own chat with <business>, or on your keypad. We never call or text you to ask for it.",
  lang: "en",
};
export const HANDLING_LINE: FixedLine = {
  id: "handlingPrivate",
  text: "Private booking: reach them only by email, at the times they named. Never say why.",
  lang: "en",
};
export const SAFETY_ASK = "Is anyone in danger right now?";

/** K-01 v1's safety lines (fixed-lines.json safetyCrisis, A3-25; safetyEmergency, A3-24), word for word. */
export const SAFETY_CRISIS =
  "If you're thinking about harming yourself, call or text 988 now. If you're in danger right now, call 911.";
export const SAFETY_EMERGENCY =
  "This sounds like an emergency. If anyone is in danger, get to safety and call 911 now.";

/** K-02 v1 `safetyOutcome` and `tense`, as readOutboxRow's answered text holds them. */
type Outcome = NonNullable<AnsweredText["outcomes"]>[number];
export type Tense = NonNullable<AnsweredText["tenses"]>[number];

/** The part of a K-02 v1 safetyResult fixture readOutboxRow's answered text is made from (K-34 v1 safety_outcomes). */
interface SafetyResultFixture {
  readonly eventId: string;
  readonly read: { readonly labels: readonly { readonly tense: Tense }[] } | null;
  readonly outcomes: readonly Outcome[];
}

/**
 * A K-02 v1 safety fixture's text as K-05 v1.3 readOutboxRow answers it: its event id, the result's outcomes and each
 * label's tense in the labels' order (K-34 v1 safety_outcomes outcomes and tenses; a timeout has no label), with `change`
 * laid over it. The fixtures are Alex's texts to Lee's Barbershop (the master's sample cast).
 */
export function answeredFrom(file: string, change: Partial<AnsweredText> = {}): AnsweredText {
  const result = contractFile(`model/fixtures/${file}`) as SafetyResultFixture;
  return {
    eventId: result.eventId,
    outcomes: [...result.outcomes],
    tenses: (result.read?.labels ?? []).map((label) => label.tense),
    ...change,
  };
}

/** K-01 v1's sample lists with the lines above added (the privacy link, the Spanish opt-out line, the two lines). */
export function listsWithFirstText(): CheckLists {
  const lists = bundleLists();
  return {
    keywords: lists.keywords,
    fixedLines: {
      lines: [...lists.fixedLines.lines, PRIVACY_LINE, OPT_OUT_ES_LINE, CODE_TEXT_LINE, HANDLING_LINE],
    },
  };
}

/** T-313's A7-17 row with the lists above, and any other change to its checks' context. */
export function firstTextRow(
  change: Partial<FinalizeRow> = {},
  checks: Partial<FinalizeRow["checks"]> = {},
): FinalizeRow {
  const row = a717Row();
  return {
    ...row,
    ...change,
    checks: { ...row.checks, lists: listsWithFirstText(), ...checks },
  };
}

/**
 * Rosie's first text to a new handle about the row's business: nothing texted before, no opt-out line delivered. No text
 * it answers has a safety read here (T-1164's tests give the texts their reads), so the danger question never applies.
 */
export const FIRST_TEXT: FixedLineFacts = {
  textedAboutBusiness: false,
  optOutLineDeliveredAt: null,
  lines: [],
  answeredTexts: [],
};

/** The second text: the first was delivered, with the opt-out line on it (phones.optout_line_delivered_at set). */
export const SECOND_TEXT: FixedLineFacts = {
  textedAboutBusiness: true,
  optOutLineDeliveredAt: "2026-10-23T13:00:21Z",
  lines: [],
  answeredTexts: [],
};

/** A slot and the value it took, as K-03 v1's final parts hold it (`fact`: a slot of the vocabulary). */
export type SlotValue = FinalParts["slotValues"][number];

export const RILEY: SlotValue = { slot: "pro.name", value: "Riley" };
export const DAY: SlotValue = { slot: "day", value: "Sat Oct 24" };

export const wordsSend = (text: string): Send => ({
  kind: "words",
  text,
  calendarFile: "none",
  options: [],
  link: null,
});

/** One attempt's parts as rewrite/parts.ts builds them, before any fixed line: the sends and their slot values. */
export function partsOf(
  sends: FinalParts["sends"],
  slotValues: readonly SlotValue[] = [RILEY, DAY],
  fixedLines: readonly string[] = [],
): FinalParts {
  return {
    row: "outbox-a7-17-alex-text",
    channel: "imessage",
    sends,
    fixedLines: [...fixedLines],
    slotValues: [...slotValues],
    threadReplyTo: null,
  };
}

/** The port's double: the same facts for every row, each read written down (the row's id: a label). */
export interface FactsPort extends FixedLinePorts<RecordingRepo> {
  readonly reads: string[];
}

export function factsPort(facts: FixedLineFacts): FactsPort {
  const reads: string[] = [];
  return {
    reads,
    readFixedLines(row: FinalizeRow, call: CallContext<RecordingRepo>) {
      reads.push(`${row.outboxRowId}@${call.businessId}`);
      return Promise.resolve(structuredClone(facts));
    },
  };
}

/** T-313's fake repo for `row`, with this module's inserter as the finalize call's insertFixedLines port. */
export function repoWithInserter(
  row: FinalizeRow,
  port: FixedLinePorts<RecordingRepo>,
): { repo: FakeRepo; ports: FinalizePorts<RecordingRepo> } {
  const repo = fakeRepo(row);
  return { repo, ports: { ...repo.ports, insertFixedLines: fixedLineInserter(port) } };
}
