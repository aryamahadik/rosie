// Fallback text (T-144; K-01 v1 `fallbackText`; arch 02 step 7): the words the step sends when the composer's rewrite fails
// its checks twice, until Jay's reviewed text replaces them: the step's master line.
//
// The master line is the text of the first message the step has from Rosie (lane `san`). A step that has none (the person
// speaks, or a page does) has no fallback text. The line is word for word: its slots stay as written (`{{alex.staff}}`,
// `{{price}}`, `{{pay.took}}`) for the slot filler to fill from the booking at send time, and the fallback goes through
// the same checks as any message, including the unfilled-slot check (arch 02 step 7; K-03).
//
// Filling the record's slots ahead of time is possible: `fillRecordSlots` puts into each of the 16 named record slots
// (`pay.took`, `clock.pay`, `who.ok` ...) the text of the first row of the compiled record that fits a path (T-137's
// slotRowIndex, which runs the master's own slotRow). It is not the default, because the row a booking gets depends on the
// booking, which the compiler does not know: with no path, the flow's main path reads.
import type { StepId } from "../graph/types.ts";
import type { TradePath } from "../path";
import { SLOT_NAMES, slotRowIndex, type CompiledRecordView, type RowStamps, type SlotName } from "../record";
import type { CardStep } from "./card";

/** The master line of a step: the text of its first message from Rosie, or null when it has none. */
export function fallbackTextOf(step: CardStep): string | null {
  for (const message of step.say ?? []) {
    if (!Array.isArray(message)) continue;
    const [from, , text] = message as unknown[];
    if (from === "san" && typeof text === "string" && text.trim() !== "") return text;
  }
  return null;
}

/** The fallback text of every step of a flow that has one, by step id (branch steps included, the steps an `off` op removed left out). */
export function compileFallbackTexts(list: readonly CardStep[]): Record<StepId, string> {
  const out: Record<StepId, string> = {};
  const visit = (steps: readonly CardStep[]): void => {
    for (const step of steps) {
      if (step.off !== undefined) continue;
      const text = fallbackTextOf(step);
      if (text !== null) out[step.id] = text;
      for (const branch of step.branches ?? []) {
        if (branch.off === undefined) visit(branch.steps);
      }
    }
  };
  visit(list);
  return out;
}

/** A slot as the master writes it in a line: `{{name}}`, `{{name:sample}}` or `{{name|words}}` (overlay-core.js AMOUNT_RE). */
const SLOT_TOKEN = /\{\{\s*([a-z][a-z.]*)\s*(?:[:|][^}]*)?\}\}/g;

function isRecordSlot(name: string): name is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(name);
}

/**
 * The text with each record slot replaced by the first row of that slot that fits the path (T-137 slotRowIndex), on the
 * record of `view`. `path` null is the flow's main path. `stamps` is what the step is stamped with (`took`, `ev`, `wr`):
 * the master's slotRow reads them. Other slots (`{{price}}`, `{{alex.staff}}`) stay as written, and so do the slots inside
 * a row's own text.
 */
export function fillRecordSlots(
  text: string,
  view: CompiledRecordView,
  path: TradePath | null,
  stamps: RowStamps = {},
): string {
  return text.replace(SLOT_TOKEN, (token: string, name: string) => {
    if (!isRecordSlot(name)) return token;
    const index = slotRowIndex(view, name, path, stamps);
    if (index === null) return token;
    return view.record.slots[name].rows[index]?.text ?? token;
  });
}
