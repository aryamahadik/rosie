// A question without a safe default or a clock (T-155; C-066; K-01 v1 lint rule `no-safe-default-or-clock`; arch 12
// line 592; arch 02 line 127, step 9's default; QUESTIONS NQ-PB-3's default).
//
// Every decision of a flow (a split, T-144's decisionsOf) has a card (T-144, compiler/src/cards): its question, its safe
// default (the words of its `Safe default` line, left out when it has none) and its clock (its own `Clock` line word for
// word, or step 9's default). The rule reads each card as T-144 gives it:
//
//   - a card with neither a safe default nor a clock: an error (arch 12 line 592: "The lint fails a step when a question
//     lacks a safe default or a clock"). Nothing then says what happens when nobody answers, nor when that is. It is
//     K-01's own step check: a card with neither field, `safeDefault` nor `clock` (K-01 card.clock: "Left out, with no
//     safeDefault either, the step fails the lint rule no-safe-default-or-clock"). T-144 gives every card a clock, so on a
//     flow it compiles none fails; a card made elsewhere can, such as a K-01 step's
//     (contracts/bundle/fixtures/invalid/refuse-no-safe-default-or-clock.json: A6-02 with neither);
//   - a card whose clock is not its own Clock line: a warning, as the decision relies on step 9's default (arch 02 line
//     127: "It is due at the step's Clock line. Without one: ..."). NQ-PB-3's default: such a decision passes and is
//     listed as a warning; the rule fails only a question with no safe default and no clock at all. Only 13 of the
//     master's 210 decisions state a Clock line (arch 12 line 592): the other 197 are listed. The warning also says when
//     the card has no safe default, as step 9's default is then all that keeps the question from failing;
//   - a card with its own Clock line: no hit.
//
// A card is read from the step as written, never per path: T-144 proves the path's words change none of its lines
// (cards.test.ts), so the rule walks no path. A rule that reads cards from somewhere else, such as a K-01 step, is made
// with noDefaultOrClockRule(cardsOf).
import { compileCards, compileTradeCards, type CardClock, type CardStep, type StepCard } from "../cards";
import type { StepId } from "../graph/types.ts";
import type { LintContext, LintHit, LintRule } from "./runner";

/** The rule's id: K-01 lintRule `no-safe-default-or-clock` (arch 12 line 592). */
export const NO_DEFAULT_OR_CLOCK_RULE = "no-safe-default-or-clock";

/**
 * A card as the rule reads it: T-144's StepCard, or a K-01 step's card, whose clock may be left out (K-01 card: "A card's
 * clock is optional ... so a failing card can be written down and marked").
 */
export interface ClockCard {
  readonly question: string;
  readonly safeDefault?: string;
  readonly clock?: CardClock;
}

/** The cards the rule reads, by step id: one per decision. */
export type ClockCards = Readonly<Record<StepId, ClockCard>>;

/**
 * The cards of the flow linted, as the compiler builds them (T-144): a trade's from its applied flow
 * (compileTradeCards), the master's from the flow's main path (compileCards).
 */
export function compiledCardsOf(ctx: LintContext): Record<StepId, StepCard> {
  if (ctx.overlay !== null) return compileTradeCards(ctx.overlay.applied);
  // masterInput() hands the rules FlowGraph.path, the very list compileMasterCards() compiles.
  return compileCards(ctx.steps as unknown as readonly CardStep[]);
}

const ERROR_FIX =
  "give its card a safe default (a 'Safe default: ...' line) or a clock (its own 'Clock: ...' line, or step 9's default): with neither, nothing says what happens when nobody answers, or when";
const DEFAULT_FIX =
  "relies on step 9's default (no Clock line of its own; arch 02 line 127): it passes, listed (NQ-PB-3)";
const DEFAULT_ONLY_FIX =
  "relies on step 9's default alone (no Clock line of its own, and no safe default on its card; arch 02 line 127): it passes, listed (NQ-PB-3)";

/**
 * The rule's hits for one decision's card: an error with neither a safe default nor a clock, a warning when its clock is
 * not its own Clock line (step 9's default applies), none with its own Clock line. Neither is read as K-01 reads it:
 * the field left out.
 */
export function cardHits(step: StepId, card: ClockCard): LintHit[] {
  const safe = card.safeDefault !== undefined;
  const at = { rule: NO_DEFAULT_OR_CLOCK_RULE, step, field: "q", text: card.question };
  if (!safe && card.clock === undefined) return [{ ...at, level: "error", fix: ERROR_FIX }];
  if (card.clock?.from === "clockLine") return [];
  return [{ ...at, level: "warning", fix: safe ? DEFAULT_FIX : DEFAULT_ONLY_FIX }];
}

/**
 * The rule, reading the flow's cards with `cardsOf` (compiledCardsOf by default: T-144's compiler on the flow linted).
 * Cards from elsewhere, such as a K-01 fixture's steps, are read by handing them in.
 */
export function noDefaultOrClockRule(cardsOf: (ctx: LintContext) => ClockCards = compiledCardsOf): LintRule {
  return {
    id: NO_DEFAULT_OR_CLOCK_RULE,
    name: "no safe default or clock",
    source:
      "arch 12 line 592 ('when a question lacks a safe default or a clock'); arch 02 line 127 (step 9's default); K-01 v1 card.safeDefault and card.clock; NQ-PB-3's default",
    run(ctx: LintContext): LintHit[] {
      return Object.entries(cardsOf(ctx)).flatMap(([step, card]) => cardHits(step, card));
    },
  };
}

/** The rule on the flow's own cards. */
export const noDefaultOrClock: LintRule = noDefaultOrClockRule();
