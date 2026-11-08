// A choice without a definition (T-156; C-067; K-01 v1 lint rule `choice-without-definition`; arch 12 line 592;
// QUESTIONS NQ-PB-3's default).
//
// Every decision of a flow (a split, T-144's decisionsOf) has a card (T-144, compiler/src/cards) that gives each of its
// choices (the branches an answer can pick, switched-off branches left out) a definition: the step's own
// `Means '<label>': ...` line (from meansLine); else the first sentence of the step the choice leads to, or of its ending
// words when it ends with no step (from firstSentence: a stand-in); else none. The rule reads each card as T-144 gives it:
//
//   - a choice with no definition (from none: no Means line, and no led-to step or ending words whose first sentence can
//     stand in): an error, one per choice, named by its label (arch 12 line 592: "The lint fails a step ... when a choice
//     lacks a definition"). The model would be handed the label with nothing saying what it means. It is K-01's own step
//     check: a card.means entry with from "none" (contracts/bundle/README.md, "The lint in the bundle"). T-144 gives
//     every choice of the master a definition, so on the master none fails; a card made elsewhere can, such as a K-01
//     step's (contracts/bundle/fixtures/invalid/refuse-choice-without-definition.json: A6-02's '2 Another time');
//   - a decision that states no Means line at all, so that its choices stand on the first sentence of the step each
//     leads to: a warning, one per decision, named by its question (arch 12 line 592: "48 lack a Means line; the first
//     sentence of the step it leads to stands in"). NQ-PB-3's default: such choices pass with their stand-in and are
//     listed as warnings. The 48 are decisions (T-144's lacksMeans; specs.md section 6: "48 decisions lack a 'Means'
//     line"), counted over both master flows with the shared S-steps once; their choices number 173;
//   - otherwise no hit. A decision that states a Means line is not listed, even where its lines leave a choice to a
//     stand-in (S1-02's 'All on the list', or A7-93's one line for every case): arch 12 counts the decisions that state
//     none.
//
// A card is read from the step as written, never per path (T-144's cards.test.ts proves the path's words change none
// of its lines), so the rule walks no path. A rule that reads its decisions from somewhere else, such as K-01 steps
// (their card, and their `more` for the Means lines), is made with noDefinitionRule(readDecisions).
import { cardOf, decisionsOf, lacksMeans, type CardMeans, type CardStep } from "../cards";
import type { StepId } from "../graph/types.ts";
import type { LintContext, LintHit, LintRule } from "./runner";

/** The rule's id: K-01 lintRule `choice-without-definition` (arch 12 line 592). */
export const CHOICE_WITHOUT_DEFINITION_RULE = "choice-without-definition";

/** A card as the rule reads it: T-144's StepCard, or a K-01 step's card (whose means may hold from "none"). */
export interface DefinitionCard {
  readonly question: string;
  readonly means: readonly CardMeans[];
}

/** One decision as the rule reads it. */
export interface DefinedDecision {
  readonly step: StepId;
  readonly card: DefinitionCard;
  /** Does the step state any Means line (a `more` line that starts with Means: T-144 hasMeansLine)? */
  readonly statesMeans: boolean;
}

/**
 * The decisions of the flow linted, each with its card as the compiler builds it (T-144: decisionsOf, then cardOf, as
 * compileCards does) and whether its step states a Means line (T-144's lacksMeans). A trade's are read from its applied
 * flow (the list compileTradeCards compiles), the master's from the flow's main path.
 */
export function compiledDecisionsOf(ctx: LintContext): DefinedDecision[] {
  // masterInput() hands the rules FlowGraph.path, the very list compileMasterCards() compiles.
  const list: readonly CardStep[] =
    ctx.overlay !== null ? ctx.overlay.applied.flow.steps : (ctx.steps as unknown as readonly CardStep[]);
  return decisionsOf(list).map((decision) => ({
    step: decision.step.id,
    card: cardOf(decision),
    statesMeans: !lacksMeans(decision.step),
  }));
}

const ERROR_FIX =
  "write its Means line on the step (Means '<its label>': ...), or lead it to a step or ending words whose first sentence can stand in: with neither, the model is handed the choice with no definition";

/** The warning's words for a decision that states no Means line, `standing` of whose `total` choices take a stand-in. */
function standInFix(standing: number, total: number): string {
  const which =
    standing === total
      ? `its ${String(total)} ${total === 1 ? "choice takes" : "choices take"}`
      : `${String(standing)} of its ${String(total)} choices ${standing === 1 ? "takes" : "take"}`;
  return `relies on stand-ins: it states no Means line, so ${which} the first sentence of the step each leads to, or of its ending words (arch 12 line 592): it passes, listed (NQ-PB-3)`;
}

/**
 * The rule's hits for one decision: a warning when its step states no Means line and a choice takes a stand-in, then an
 * error for each choice with no definition, in the card's order.
 */
export function decisionHits(decision: DefinedDecision): LintHit[] {
  const { step, card, statesMeans } = decision;
  const hits: LintHit[] = [];
  const standing = card.means.filter((entry) => entry.from === "firstSentence").length;
  if (!statesMeans && standing > 0)
    hits.push({
      rule: CHOICE_WITHOUT_DEFINITION_RULE,
      level: "warning",
      step,
      field: "q",
      text: card.question,
      fix: standInFix(standing, card.means.length),
    });
  for (const entry of card.means) {
    if (entry.from !== "none") continue;
    hits.push({
      rule: CHOICE_WITHOUT_DEFINITION_RULE,
      level: "error",
      step,
      field: `branch '${entry.branch}'`,
      text: entry.branch,
      fix: ERROR_FIX,
    });
  }
  return hits;
}

/**
 * The rule, reading the flow's decisions with `readDecisions` (compiledDecisionsOf by default: T-144's cards of the flow
 * linted). Decisions from elsewhere, such as a K-01 fixture's steps, are read by handing them in.
 */
export function noDefinitionRule(
  readDecisions: (ctx: LintContext) => readonly DefinedDecision[] = compiledDecisionsOf,
): LintRule {
  return {
    id: CHOICE_WITHOUT_DEFINITION_RULE,
    name: "choice without a definition",
    source:
      "arch 12 line 592 ('when a choice lacks a definition (48 lack a Means line; the first sentence of the step it leads to stands in)'); K-01 v1 card.means; T-144's cards; NQ-PB-3's default",
    run(ctx: LintContext): LintHit[] {
      return readDecisions(ctx).flatMap(decisionHits);
    },
  };
}

/** The rule on the flow's own cards. */
export const noDefinition: LintRule = noDefinitionRule();
