// The final parts code builds from a filled plan (K-03 v1 `finalParts`; arch 02 line 123: "Code inserts its options";
// arch 07 lines 365 to 391): the words first, carrying any calendar file, then at most one poll or card (arch 07 line
// 367); a tapback alone (line 391). The fixed lines are added after, by their own port (T-314), and the checks run on
// the result.
//
//   words     the plan's lines in order, then its question, each on its own line (arch 07 line 353), then the options in
//             msgtext.js's text form while the words carry them (arch 07 line 379: the row read gives them);
//   poll      the question's option ids, each with the step's label word for word (arch 07 lines 361, 379);
//   link card the action line's link, filled from its link slot, previewing only the business name as this reader may
//             see it (arch 07 line 381);
//   calendar  the row's calendar file on the words, when the plan picks one (arch 07 line 383).
//
// What code cannot build as the plan asks becomes a fault of the check it breaks, in the words the rewrite is told
// (naming slots, option ids and formats, never a value): an option id that is not the step's (Fixed lines: poll options
// are fixed lines, arch 07 line 361), a message with no words (Values, so it blocks), and a format the parts cannot hold
// (Format: a second poll or card, a tapback beside words, a poll without 2 to 5 options, a card with no link). So the
// parts always fit K-03's shape (one or two sends; a poll of 2 to 5 options; a card with its link).

import type { CheckName, Option } from "../checks";
import type { SlotValue } from "../slots";
import type { CalendarFile, Channel, FinalParts, Plan, Send } from "./types";

/** The link slots a link card carries (K-03 v1 `linkSlot`; link.chatqr is the chat link's QR, never a card's link). */
const CARD_LINK_SLOTS: ReadonlySet<string> = new Set(["link.secure", "link.pay", "link.chat"]);

/** A poll carries 2 to 5 options (arch 07 line 379; K-03 v1 `send`). */
const POLL_OPTIONS = { min: 2, max: 5 } as const;

/** The faults code found building the parts, by the check each breaks. */
export type PartFaults = Partial<Record<CheckName, string[]>>;

/** What the parts are built from: the plan's lines and question after limit 7 and the fill. */
export interface PartsInput {
  readonly row: string;
  readonly channel: Channel;
  /** The plan's formats (K-03 v1 `plan.formats`) and its thread target, kept (arch 07 line 389). */
  readonly formats: Plan["formats"];
  readonly threadReplyTo: string | null;
  readonly lines: readonly { readonly text: string }[];
  readonly question: { readonly text: string; readonly optionIds: readonly string[] } | null;
  /** Each slot filled and its value, in order of first use (T-310). */
  readonly slotValues: readonly SlotValue[];
  /** The step's options with their labels (K-03 v1 composeInput `options`). */
  readonly options: readonly Option[];
  /** The options in msgtext.js's text form while the words carry them (arch 07 line 379), or null. */
  readonly typedOptions: string | null;
  /** The calendar file the row's booking carries (arch 07 line 383). */
  readonly calendarFile: CalendarFile;
  /**
   * A link card's preview: the business name as this reader may see it, filled and claimed (biz.name; its display name
   * under the sensitive switch: arch 07 line 381, S13-22), with its slot value; null when there is none to show.
   */
  readonly card: SlotValue | null;
}

/** The parts and the faults code found building them. */
export interface Built {
  readonly parts: FinalParts;
  readonly faults: PartFaults;
}

function add(faults: PartFaults, check: CheckName, fault: string): void {
  const list = faults[check] ?? [];
  if (!list.includes(fault)) list.push(fault);
  faults[check] = list;
}

/** The poll the question's option ids make: each the step's option, word for word; null when the plan asks none. */
function pollOf(input: PartsInput, faults: PartFaults): Send | null {
  const ids = input.question?.optionIds ?? [];
  const options: Option[] = [];
  for (const id of ids) {
    const option = input.options.find((candidate) => candidate.id === id);
    if (option === undefined) add(faults, "fixedLines", `The option ${id} is not one of the step's options.`);
    else options.push({ id: option.id, label: option.label });
  }
  if (options.length < POLL_OPTIONS.min || options.length > POLL_OPTIONS.max) {
    add(faults, "format", `A poll carries 2 to 5 options, not ${String(options.length)}.`);
    return null;
  }
  return { kind: "poll", text: null, calendarFile: "none", options, link: null };
}

/** The link card: the first card link slot the words were filled with, previewing the business name. */
function cardOf(input: PartsInput, faults: PartFaults): Send | null {
  const link = input.slotValues.find((fact) => CARD_LINK_SLOTS.has(fact.slot) && fact.value !== "");
  if (link === undefined || input.card === null || input.card.value === "") {
    add(faults, "format", "A link card needs the action line's link as its slot, and a business to show.");
    return null;
  }
  return { kind: "linkCard", text: input.card.value, calendarFile: "none", options: [], link: link.value };
}

/** The slot values with one more, unless it is there already (T-310: each slot and value once, in order of first use). */
function withValue(values: readonly SlotValue[], value: SlotValue | null): SlotValue[] {
  const list = [...values];
  if (value !== null && !list.some((known) => known.slot === value.slot && known.value === value.value))
    list.push(value);
  return list;
}

/**
 * Builds the final parts of one attempt from its filled lines and question (no fixed line yet: T-314's port adds them),
 * and the faults of what the plan asked that the parts cannot hold.
 */
export function buildParts(input: PartsInput): Built {
  const faults: PartFaults = {};
  const words = [
    ...input.lines.map((line) => line.text),
    input.question?.text ?? "",
    input.typedOptions ?? "",
  ]
    .filter((text) => text.trim() !== "")
    .join("\n");

  // At most one poll or card, the first the plan names (arch 07 line 367).
  let element: Send | null = null;
  let cardShown = false;
  for (const format of input.formats) {
    if (format !== "poll" && format !== "linkCard") continue;
    if (element !== null) {
      add(faults, "format", "A message goes as the words, then at most one poll or card.");
      continue;
    }
    element = format === "poll" ? pollOf(input, faults) : cardOf(input, faults);
    cardShown = element?.kind === "linkCard";
  }

  const sends: Send[] = [];
  if (words !== "") {
    const calendarFile = input.formats.includes("calendarFile") ? input.calendarFile : "none";
    sends.push({ kind: "words", text: words, calendarFile, options: [], link: null });
  }
  if (element !== null) sends.push(element);
  if (input.formats.includes("tapback")) {
    if (sends.length === 0)
      sends.push({ kind: "tapback", text: null, calendarFile: "none", options: [], link: null });
    else add(faults, "format", "A tapback goes alone, never with words, a poll or a card.");
  }
  const [first, second] = sends;
  if (first === undefined) {
    // Nothing to say: it may not go, so it blocks (arch 07 line 353: the first line says what happened or is needed).
    add(faults, "values", "The message has no words to send.");
  }
  const kept: FinalParts["sends"] =
    first === undefined
      ? [{ kind: "words", text: "", calendarFile: "none", options: [], link: null }]
      : second === undefined
        ? [first]
        : [first, second];
  return {
    parts: {
      row: input.row,
      channel: input.channel,
      sends: kept,
      fixedLines: [],
      slotValues: withValue(
        input.slotValues.map((fact) => ({ slot: fact.slot, value: fact.value })),
        cardShown ? input.card : null,
      ),
      threadReplyTo: input.threadReplyTo,
    },
    faults,
  };
}
