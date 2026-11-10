// The step's master line (K-03 composeInput `masterText`; arch 07 line 401: "The step's master line is the model to
// follow, not a script"), read from the bundle the row was committed under (K-01 v1): the `text` of the step's message
// from Rosie (lane san) to the row's reader, with its slots left in (K-03 masterText.text: "The line's words with the
// bundle's slots left in"; K-01 message.text), and the page types the step allows (K-01 step.pageTypes). With it, the
// lines of that message's card and where they sit in the bundle (K-01 flows.<flow>.steps.<step>.say[<i>].elements.card
// .lines), which term-facts.ts reads (T-1174; K-09 README v1.6 defaults 137, 138).
//
// Never the message's plainText, and never its elements as words of the master text (DL-245). msgtext.js line 65 writes
// S13-02's opt-out line into plainText for any truthy stop marker, and a card's lines ride there too, Rosie's own fee
// terms among them, which reach the composer only as K-03 v1.1 term facts, each a card line word for word with its
// source line (term-facts.ts; DL-145, DL-355). The opt-out line reaches a text only through the fixed-line inserter
// (T-314, by the number's state, Q-30), and money words of the record only through the record's rows that T-310 fills
// (DL-182; STATE note 56). So the master text is the message's words alone, and the bundle's own opt-out line is taken
// out of every Rosie-written text the input carries (withoutOptOutLine): the master line, Rosie's messages in the
// conversation and the open questions' words as sent, which went out with the line when they were a number's first text.
//
// A row whose master line cannot be read is answered, never thrown (K-09 v1.6 masterLineMissing; README v1.6 default
// 140): its bundle in neither KV nor PostgreSQL's copy, a step the bundle does not hold, or no line from Rosie to this
// reader at the row's place. Never logged: a step's words.

import type { Reader } from "../finalize/claim-check";
import { OPT_OUT_LINE } from "../finalize/fixed-lines";
import { flowOfStep } from "../frontier";
import { flowsListed } from "../frontier/assemble/bundle";
import type { ComposeBundles, ComposeRow, FlowLetter, Missing } from "./types";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rosie's own lane (K-01 v1 lane san: "san is Rosie", MC R1). */
export const ROSIE_LANE = "san";

/** The lane each reader reads in (K-01 v1 lane; SPEC-master 4 'who / to'; K-03 v1 readerRole). */
export const READER_LANES: Readonly<Record<Reader, string>> = {
  owner: "owner",
  staff: "staff",
  customer: "cust",
};

/** What the input takes from the bundle for one row. */
export interface MasterLine {
  /** The step whose line it is (K-01 v1 stepId). */
  readonly step: string;
  /** The message's `text`, word for word, its slots left in. */
  readonly text: string;
  /** The page types the step allows (K-01 v1 step.pageTypes); free strings until K-21 (CQ-16). */
  readonly pageTypes: readonly string[];
  /** The bundle's opt-out line, in each language it holds it (K-01 v1 manifest lists.fixedLines, id optOutLine). */
  readonly optOutLines: readonly string[];
  /** The flow whose graph the step was read from (K-01 flows.<flow>): where its card lines sit. */
  readonly flow: FlowLetter;
  /** The message's place in the step's `say`, 0 for the first (K-01 step.say[<say>]), Rosie's or not. */
  readonly say: number;
  /**
   * The message's card lines in the card's order, as the bundle writes them (K-01 say[].elements.card.lines), each in
   * its place; a line that is not text is null. None when the message has no card.
   */
  readonly cardLines: readonly (string | null)[];
}

/** The row's master line, or what is missing (K-09 v1.6 masterLineMissing.missing). */
export type MasterLineRead = { readonly line: MasterLine } | { readonly missing: Missing };

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The bundle's opt-out line words: each fixed line with K-01's id optOutLine and words (a line for Jay has none). */
export function optOutLinesOf(manifest: unknown): string[] {
  const lists = isRecord(manifest) && isRecord(manifest.lists) ? manifest.lists : {};
  const fixedLines = isRecord(lists.fixedLines) ? lists.fixedLines : {};
  const lines: unknown[] = Array.isArray(fixedLines.lines) ? fixedLines.lines : [];
  return lines.flatMap((line): string[] =>
    isRecord(line) && line.id === OPT_OUT_LINE && typeof line.text === "string" && line.text.trim() !== ""
      ? [line.text]
      : [],
  );
}

/**
 * A text with the opt-out line taken out wherever it stands whole, with the line break or space that joined it to the
 * words; the text as it is when it holds none.
 */
export function withoutOptOutLine(text: string, optOutLines: readonly string[]): string {
  let out = text;
  for (const line of optOutLines) {
    if (line === "" || !out.includes(line)) continue;
    out = out
      .split(`\n${line}`)
      .join("")
      .split(`${line}\n`)
      .join("")
      .split(` ${line}`)
      .join("")
      .split(line)
      .join("")
      .trim();
  }
  return out;
}

/** The step in one flow graph, when the value is K-01 v1's graph of that flow and holds it. */
function stepIn(graph: unknown, flow: FlowLetter, step: string): Json | null {
  if (!isRecord(graph) || graph.contract !== "bundle.v1" || graph.flow !== flow || !isRecord(graph.steps)) {
    return null;
  }
  if (!Object.hasOwn(graph.steps, step)) return null;
  const found = graph.steps[step];
  if (!isRecord(found) || (found.id !== undefined && found.id !== step)) return null;
  return found;
}

/** The card lines of a message, each in its place (null for one that is not text); none when it has no card. */
function cardLinesOf(message: Json): (string | null)[] {
  const elements = isRecord(message.elements) ? message.elements : {};
  const card = isRecord(elements.card) ? elements.card : {};
  const lines: unknown[] = Array.isArray(card.lines) ? card.lines : [];
  return lines.map((line) => (typeof line === "string" ? line : null));
}

/**
 * The step's message from Rosie to this reader at the row's index, with its place in the step's `say`; null when the
 * step prints none there, or its `text` is not words.
 */
function lineOf(
  step: Json,
  reader: Reader,
  line: number,
): { message: Json; text: string; say: number } | null {
  const say: unknown[] = Array.isArray(step.say) ? step.say : [];
  const lines = say.flatMap((message, index): { message: Json; say: number }[] =>
    isRecord(message) && message.from === ROSIE_LANE && message.to === READER_LANES[reader]
      ? [{ message, say: index }]
      : [],
  );
  const found = Number.isSafeInteger(line) && line >= 0 ? lines[line] : undefined;
  const text = found?.message.text;
  if (found === undefined || typeof text !== "string") return null;
  return { ...found, text };
}

/**
 * The row's master line, page types, card lines and the bundle's opt-out line, read from the bundle the row was
 * committed under: an A or B step in its own flow's graph, a shared step in the row's flow first, then the other (as the
 * frontier finds a step: findStep), each only where the manifest lists that flow. When the bundle, the step or the
 * reader's line is missing, that is what it answers: there is no master text to give, so nothing goes.
 */
export async function readMasterLine(
  bundles: ComposeBundles,
  row: Pick<ComposeRow, "bundleId" | "flow" | "step" | "line">,
  reader: Reader,
): Promise<MasterLineRead> {
  const manifest = await bundles.manifest(row.bundleId);
  if (!isRecord(manifest)) return { missing: "bundle" };
  const listed = flowsListed(manifest);
  const own = flowOfStep(row.step);
  const order: FlowLetter[] = own === null ? [row.flow, row.flow === "A" ? "B" : "A"] : [own];
  for (const flow of order.filter((letter) => listed.includes(letter))) {
    const step = stepIn(await bundles.flow(row.bundleId, flow), flow, row.step);
    if (step === null) continue;
    const found = lineOf(step, reader, row.line);
    if (found === null) return { missing: "line" };
    return {
      line: {
        step: row.step,
        text: found.text,
        pageTypes: stringsOf(step.pageTypes),
        optOutLines: optOutLinesOf(manifest),
        flow,
        say: found.say,
        cardLines: cardLinesOf(found.message),
      },
    };
  }
  return { missing: "step" };
}
