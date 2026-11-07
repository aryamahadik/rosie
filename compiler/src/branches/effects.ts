// A branch's effects (T-145; K-01 v1 `effect`): what code runs once when the choice is made; the model never names one
// (arch 01 line 77). Read from the steps the branch carries and from the branch itself, with the rules below. Every rule
// reads a structured field of the master where there is one; a few read the words of a label, an ending or a title, named
// here. The sample bundles (bundle-mini-a.json and bundle-mini-b.json) are the shape: a message is `ref` the step and `to`
// the lanes told; a flag is `ref` the step that sets it.
//
// Per step of the branch (its own steps, not the steps of a split nested inside it):
//   message       the step tells someone (`tells`): ref the step id, `to` the lanes told. (A5-04's `Nothing taken` leads to
//                 A5-05, which tells the customer.) A step with no `tells` sends nothing.
//   recordWrite   each `gives` key, ref the key (A5-13 gives money_before, card_saved, deposit_paid).
//   charge        a message of the step carries a pay element (an amount and a payment link), or the step's title starts
//                 with Charged: ref the step id.
//   calendarWrite the step gives `booked`, or its title names the calendar: ref the step id.
// Then for the branch:
//   flag          private when `sets` holds privacy private; stopped when `sets` holds contact stopped or the label is
//                 STOP; deceased when the label says the person dies; paused when its ending says visits pause (A3-48,
//                 the core paused flag of arch 03 line 175; S11-15's owner pause is a recordWrite of `paused`, not this).
//                 ref: the branch's first step (the step that sets it), else the flag's name.
//   refund        the label or the ending says money comes back or is refunded, and not `no fee or refund`: ref pay.back.
// Not an effect here: the branch's `sets` (they are on the branch, K-01 sets) and a clock (the clock of a question is armed
// from its card, K-01 card.clock; the sample bundles show no clock effect on a branch that leads to a question with a Clock
// line, A7-02 `Something needed first`). The kind stays in K-01's list for the runtime.
// The same kind and ref once only, in the order found.
import type { Lane } from "../graph/types.ts";

export type EffectKind = "recordWrite" | "message" | "clock" | "charge" | "refund" | "calendarWrite" | "flag";

export type FlagName = "deceased" | "stopped" | "private" | "paused";

/** One effect (K-01 effect). */
export interface Effect {
  kind: EffectKind;
  ref: string;
  to?: Lane[];
  flag?: FlagName;
}

/** The part of a step the effects read. */
export interface EffectStep {
  id: string;
  title?: string;
  say?: readonly unknown[];
  tells?: readonly Lane[];
  gives?: readonly string[];
}

/** The part of a branch the effects read. */
export interface EffectBranch {
  label: string;
  endText?: string;
  sets?: Readonly<Record<string, string>>;
}

const REFUND_WORDS = /\brefund|comes? back|goes? back|paid\b.{0,24}\bback|\breturned\b/i;
const NO_REFUND = /\bno (?:fee or )?refund/i;

/** Does one of the step's messages carry a pay element (elements.pay: msgtext.js KEYS)? */
function hasPayElement(step: EffectStep): boolean {
  return (step.say ?? []).some((message) => {
    if (!Array.isArray(message)) return false;
    const elements: unknown = message[3];
    return typeof elements === "object" && elements !== null && "pay" in elements;
  });
}

/**
 * Whom the step's messages go to: the recipients of the messages Rosie (`san`) sends in its `say`, each once, in the order
 * they come (B3-19 sends to the customer's AI and to the owner, and its `tells` names the customer and owner: the sample
 * bundles follow the messages); with no message of Rosie's, the step's `tells`.
 */
function recipientsOf(step: EffectStep): Lane[] {
  const out: Lane[] = [];
  for (const message of step.say ?? []) {
    if (!Array.isArray(message) || message[0] !== "san") continue;
    const to = message[1] as Lane;
    if (!out.includes(to)) out.push(to);
  }
  return out.length > 0 ? out : [...(step.tells ?? [])];
}

function stepEffects(step: EffectStep): Effect[] {
  const out: Effect[] = [];
  const to = recipientsOf(step);
  if (to.length > 0) out.push({ kind: "message", ref: step.id, to });
  for (const key of step.gives ?? []) out.push({ kind: "recordWrite", ref: key });
  const title = step.title ?? "";
  if (hasPayElement(step) || /^charged\b/i.test(title)) out.push({ kind: "charge", ref: step.id });
  if ((step.gives ?? []).includes("booked") || /\bcalendar\b/i.test(title))
    out.push({ kind: "calendarWrite", ref: step.id });
  return out;
}

function branchOwnEffects(branch: EffectBranch, first: string | undefined): Effect[] {
  const out: Effect[] = [];
  const sets = branch.sets ?? {};
  const label = branch.label;
  const ending = branch.endText ?? "";
  const flag = (name: FlagName): void => {
    out.push({ kind: "flag", ref: first ?? name, flag: name });
  };
  if (sets.privacy === "private") flag("private");
  if (sets.contact === "stopped" || /^STOP\b/.test(label)) flag("stopped");
  if (/\bdies\b/i.test(label)) flag("deceased");
  if (/\bpause/i.test(ending)) flag("paused");
  const words = `${label} ${ending}`;
  if (REFUND_WORDS.test(words) && !NO_REFUND.test(words)) out.push({ kind: "refund", ref: "pay.back" });
  return out;
}

/** The effects of a branch: its steps' effects in order, then its own; the same kind and ref once. */
export function branchEffects(branch: EffectBranch, steps: readonly EffectStep[]): Effect[] {
  const seen = new Set<string>();
  const out: Effect[] = [];
  for (const effect of [...steps.flatMap(stepEffects), ...branchOwnEffects(branch, steps[0]?.id)]) {
    const key = `${effect.kind}\u0000${effect.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(effect);
  }
  return out;
}
