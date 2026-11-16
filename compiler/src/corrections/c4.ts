// C4 (Master Corrections section 3; D96; RULES 10.1, 10.4, 10.5; `switches.verify` in both flow files): switch "verify"
// is off and not launched, so what only it lights is not built.
//
// The master lights these only with switch "verify" on, in both flows (MC C4; the switch's own `means` in master-A.json
// and master-B.json): S1-32's branch "The number isn't found" (S1-33); S2-11's branches "Doesn't match", "Expired" and
// "The lookup is down" (S2-12 to S2-14); S11-42's branch "The license holder leaves" (S11-99); and the steps S12-19,
// S13-41 and S13-43. What holds: switch "verify" is off and not launched (a lawyer confirms before launch). Licenses,
// insurance and documents are optional, shown as the business gave them and never checked; Rosie acts only on the
// business's own word.
//
// What this file changes (the card's steps): each of those branches and steps is switched off with C4's reason, as an
// `off` op does, so no path of any trade lights it, whatever switches the path has. A trade's own `off` of one stays as
// the trade wrote it (C8 keeps those D96 offs). Each is found by its place and its gate, never by its words: a branch by
// the step it holds (S1-33 ...), since a trade's rename pairs reach branch labels; and each must still be gated on switch
// "verify", else the master has changed under C4 and the build stops (VerifyGateError).
//
// What it leaves: S2-11 itself, which is not gated and is built. It keeps each license as added and gives
// `license_checked`, which S2-15 needs, and its words already say license checks are off (D96). Its branch "Matches"
// stays. The owner's ID at sign-up (S1-10, S1-32's ID half) is C10's; the trade files' D96 offs are C8's (c8.ts: its void
// ones are dropped before the applier, every other one stays); the out-of-scope markers for these branches and steps are
// T-147's.
import type { Gate } from "../graph/types.ts";
import type { Correction, EditContext } from "./framework";

/** The switch C4 keeps off. */
export const VERIFY = "verify";

/** Why each branch and step only switch "verify" lights is switched off, as an `off` op's `why`. */
export const VERIFY_OFF =
  'switch "verify" is off and not launched, so this is not built: licenses, insurance and documents are never checked (MC C4; D96)';

/**
 * The branches only switch "verify" lights (MC C4), by the step that holds each and the step the branch holds: S1-32's
 * "The number isn't found", S2-11's "Doesn't match", "Expired" and "The lookup is down", S11-42's "The license holder
 * leaves".
 */
export const VERIFY_BRANCHES: readonly (readonly [at: string, holds: string])[] = [
  ["S1-32", "S1-33"],
  ["S2-11", "S2-12"],
  ["S2-11", "S2-13"],
  ["S2-11", "S2-14"],
  ["S11-42", "S11-99"],
];

/** The steps only switch "verify" lights (MC C4). */
export const VERIFY_STEPS: readonly string[] = ["S12-19", "S13-41", "S13-43"];

/** The step C4 keeps built: not gated, it keeps each license as added and gives `license_checked` (S2-15 needs it). */
export const KEPT_STEP = "S2-11";

/** What S2-11 gives. */
export const LICENSE_CHECKED = "license_checked";

/** A branch or step C4 names is not where C4 finds it, or is no longer lit only with switch "verify" on. */
export class VerifyGateError extends Error {
  override name = "VerifyGateError";
}

/** Whether a `when` lights its branch or step only with switch "verify" on. */
export function onlyWithVerify(when: Gate | undefined): boolean {
  const on = when?.switchOn ?? [];
  return on.length > 0 && on.every((name) => name === VERIFY);
}

function branches(ctx: EditContext): void {
  for (const [at, holds] of VERIFY_BRANCHES) {
    ctx.need(holds);
    const list = ctx.need(at).branches ?? [];
    const k = list.findIndex((branch) => branch.steps.some((step) => step.id === holds));
    const branch = list[k];
    if (branch === undefined)
      throw new VerifyGateError(`MC:C4 flow ${ctx.flow}: ${at} has no branch that holds ${holds}`);
    if (!onlyWithVerify(branch.when))
      throw new VerifyGateError(
        `MC:C4 flow ${ctx.flow}: ${at}'s branch '${branch.label}' is not lit only with switch "verify" on`,
      );
    // A trade's own `off` of the branch stays as the trade wrote it.
    if (branch.off === undefined) ctx.set(at, ["branches", k, "off"], VERIFY_OFF);
  }
}

function steps(ctx: EditContext): void {
  for (const id of VERIFY_STEPS) {
    const step = ctx.need(id);
    if (!onlyWithVerify(step.when))
      throw new VerifyGateError(`MC:C4 flow ${ctx.flow}: ${id} is not lit only with switch "verify" on`);
    // A trade's own `off` of the step stays as the trade wrote it.
    if (step.off === undefined) ctx.switchOff(id, VERIFY_OFF);
  }
}

/** S2-11 stays built: not lit only with switch "verify" on, and giving `license_checked`, which S2-15 needs. */
function kept(ctx: EditContext): void {
  const step = ctx.need(KEPT_STEP);
  if (onlyWithVerify(step.when))
    throw new VerifyGateError(`MC:C4 flow ${ctx.flow}: ${KEPT_STEP} is lit only with switch "verify" on`);
  if (!(step.gives ?? []).includes(LICENSE_CHECKED))
    throw new VerifyGateError(`MC:C4 flow ${ctx.flow}: ${KEPT_STEP} no longer gives ${LICENSE_CHECKED}`);
}

/** C4: switch "verify" is off and not launched; what only it lights is switched off, and S2-11 stays built. */
export const c4: Correction = {
  id: "C4",
  title: 'Switch "verify" stays off: what only it lights is not built, and S2-11 stays',
  source:
    "Master Corrections C4; D96; RULES 10.1, 10.4, 10.5; switches.verify in master-A.json and master-B.json; MASTER-FLOW-A.md lines 1098, 1320-1357, 6030",
  apply(ctx) {
    kept(ctx);
    branches(ctx);
    steps(ctx);
  },
};
