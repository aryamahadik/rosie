// Page types and layer lines (T-145; K-01 v1 step.pageTypes and flowGraph.layerLines).
//
// Page types: the page types a step allows, one of which the composer's plan may pick, or none (arch 01 line 97). No source
// lists them (CQ-16): K-01's pageTypes holds free strings until K-03 or K-21 names the closed list, so this file takes the
// default of the only structured sign the master gives, the elements of the step's own messages (msgtext.js KEYS):
//   pay      a message carries a pay element (an amount and a payment link);
//   photos   a message carries a photo link (photoLink);
//   form     a message carries a form element (the rows a page asks for);
//   link     a message's card carries a link (a page the customer, the owner or the staff opens).
// In that order, each once. A step whose messages carry none of these allows none: a step that is only `via: "page"` does
// not, since its own messages do not point to a page (bundle-mini-a.json's A5-05 and A5-07 say [] and are `via: "page"`).
//
// Layer lines (private, privatecall, textsonly, emailonly): the flow's `layerLines` as written, and for each step the ids
// of the lines stamped on it (`layerAdd`).
import type { LayerLine } from "../graph/types.ts";

export type PageType = "pay" | "photos" | "form" | "link";

/** The part of a step the page types read. */
export interface PageStep {
  say?: readonly unknown[];
  layerAdd?: readonly { id: string }[];
}

function elementsOf(step: PageStep): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const message of step.say ?? []) {
    if (!Array.isArray(message)) continue;
    const elements: unknown = message[3];
    if (typeof elements === "object" && elements !== null && !Array.isArray(elements))
      out.push(elements as Record<string, unknown>);
  }
  return out;
}

/** The page types a step allows, from its messages' elements (see the top of this file). */
export function pageTypesOf(step: PageStep): PageType[] {
  const all = elementsOf(step);
  const out: PageType[] = [];
  if (all.some((el) => el.pay !== undefined)) out.push("pay");
  if (all.some((el) => el.photoLink !== undefined)) out.push("photos");
  if (all.some((el) => el.form !== undefined)) out.push("form");
  const linked = all.some((el) => {
    const card = el.card;
    return (
      typeof card === "object" &&
      card !== null &&
      typeof (card as { link?: unknown }).link === "string" &&
      (card as { link: string }).link !== ""
    );
  });
  if (linked) out.push("link");
  return out;
}

/** The ids of the layer lines stamped on a step, in the master's order (K-01 step.layerLines). */
export function layerIdsOf(step: PageStep): string[] {
  return (step.layerAdd ?? []).map((line) => line.id);
}

/** A flow's layer lines (K-01 flowGraph.layerLines), copied as written. */
export function compileLayerLines(lines: readonly LayerLine[]): LayerLine[] {
  return structuredClone([...lines]);
}
