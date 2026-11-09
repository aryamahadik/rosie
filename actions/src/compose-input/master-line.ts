// The step's master line (K-03 v1 composeInput `masterText`; arch 07 line 401: "The step's master line is the model to
// follow, not a script"), read from the bundle the row was committed under (K-01 v1): the `text` of the step's message
// from Rosie (lane san) to the row's reader, with its slots left in (K-03 masterText.text: "The line's words with the
// bundle's slots left in"; K-01 message.text), and the page types the step allows (K-01 step.pageTypes).
//
// Never the message's plainText and never its elements (DL-245). msgtext.js line 65 writes S13-02's opt-out line into
// plainText for any truthy stop marker, and a card's lines ride there too, Rosie's own fee terms among them, for which
// K-03 v1 has no fact (term facts are v1.1's: DL-145). The opt-out line reaches a text only through the fixed-line
// inserter (T-314, by the number's state, Q-30), and money words only through the record's rows that T-310 fills
// (DL-182; STATE note 56). So the master text is the message's words alone, and the bundle's own opt-out line is taken
// out of every Rosie-written text the input carries (withoutOptOutLine): the master line, Rosie's messages in the
// conversation and the open questions' words as sent, which went out with the line when they were a number's first text.
// Never logged: a step's words.

import type { Reader } from "../finalize/claim-check";
import { OPT_OUT_LINE } from "../finalize/fixed-lines";
import { flowOfStep } from "../frontier";
import { flowsListed } from "../frontier/assemble/bundle";
import { ComposeInputRefusedError } from "./errors";
import type { ComposeBundles, ComposeRow, FlowLetter } from "./types";

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
}

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

/** The step's message from Rosie to this reader at the row's index, its `text` alone; refused when there is none. */
function lineOf(step: Json, reader: Reader, line: number): string {
  const say: unknown[] = Array.isArray(step.say) ? step.say : [];
  const lines = say.filter(
    (message): message is Json =>
      isRecord(message) && message.from === ROSIE_LANE && message.to === READER_LANES[reader],
  );
  const message = Number.isSafeInteger(line) && line >= 0 ? lines[line] : undefined;
  if (message === undefined || typeof message.text !== "string") {
    throw new ComposeInputRefusedError("noMasterLine");
  }
  return message.text;
}

/**
 * The row's master line, page types and the bundle's opt-out line, read from the bundle the row was committed under: an
 * A or B step in its own flow's graph, a shared step in the row's flow first, then the other (as the frontier finds a
 * step: findStep), each only where the manifest lists that flow. Refused (thrown) when the bundle, the step or the
 * reader's line is missing: there is no master text to give, so nothing goes.
 */
export async function readMasterLine(
  bundles: ComposeBundles,
  row: Pick<ComposeRow, "bundleId" | "flow" | "step" | "line">,
  reader: Reader,
): Promise<MasterLine> {
  const manifest = await bundles.manifest(row.bundleId);
  if (!isRecord(manifest)) throw new ComposeInputRefusedError("bundleMissing");
  const listed = flowsListed(manifest);
  const own = flowOfStep(row.step);
  const order: FlowLetter[] = own === null ? [row.flow, row.flow === "A" ? "B" : "A"] : [own];
  for (const flow of order.filter((letter) => listed.includes(letter))) {
    const step = stepIn(await bundles.flow(row.bundleId, flow), flow, row.step);
    if (step === null) continue;
    return {
      step: row.step,
      text: lineOf(step, reader, row.line),
      pageTypes: stringsOf(step.pageTypes),
      optOutLines: optOutLinesOf(manifest),
    };
  }
  throw new ComposeInputRefusedError("stepMissing");
}
