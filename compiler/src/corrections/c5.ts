// C5 (Master Corrections section 3; SPEC-prof.md lines 116-118 and 127; S1-03; FRONTEND-SPEC.md rows H06, H07, lines
// 106-107): the typed plug-in values a trade file leaves out.
//
// The master says nothing for them: insurance.json is the only trade of 243 with no pf.facts, so every fact-gated branch
// would show for it ("No pf.facts list at all: you see every fact-gated branch", SPEC-prof.md lines 116-118); and 12
// trades have no pf.settings. What holds:
//   - insurance's facts are video, forms, firststeps and documents, the list cpa.json has (DD; Jay kept this list, Nov 4),
//     written in cpa.json's order (QUESTIONS CQ-129 (a)'s default: forms, firststeps, documents, video);
//   - the 12 trades with no pf.settings (art-classes, band, clown, coding-classes, comedian, cooking-classes, dance, dj,
//     inspector, insurance, language-school, party-characters) start with the arrival setting at "window", the master's
//     default (SPEC-prof.md line 127), and the free-cancel time empty; the owner confirms both at sign-up
//     (FRONTEND-SPEC.md rows H06, H07: each starts from pf.settings).
//
// These are values of the trade, read by name (MC R3), not words of a step, so the correction changes no step. What this
// file gives:
//   correctTrade()  the trade with C5's facts in it (insurance), and every value C5 fills, each tagged MC:C5: insurance's
//                   pf.facts, and for each trade with no pf.settings, both flows' arrive and cutoff (K-01 tradeSettings:
//                   arrive "window", cutoff null for "empty"). A file that writes the value keeps its own.
//   renderFills()   the fills as diff lines, each starting with its tag, as framework.ts renderDiff() writes a step's.
//   c5              the correction in the frame's list: it changes no step.
// The trade loader leaves the files as they are (insurance's facts null, the 12 trades' settings null), so the stages
// that keep parity with step.js before the corrections read what step.js reads.
import type { FlowLetter, Name } from "../graph/types.ts";
import type { Arrive, LoadedTrade, TradeId } from "../load/trade";
import type { Correction, CorrectionTag } from "./framework";

/** The trade whose missing facts C5 fills. */
export const INSURANCE: TradeId = "insurance";

/** The trade whose list insurance takes (MC C5: "the list cpa.json has"). */
export const FACTS_FROM: TradeId = "cpa";

/** Insurance's facts: cpa.json's list, in cpa.json's order (CQ-129 (a)'s default). */
export const INSURANCE_FACTS: readonly Name[] = ["forms", "firststeps", "documents", "video"];

/** The 12 trades MC C5 names as having no pf.settings. */
export const NO_SETTINGS: readonly TradeId[] = [
  "art-classes",
  "band",
  "clown",
  "coding-classes",
  "comedian",
  "cooking-classes",
  "dance",
  "dj",
  "inspector",
  "insurance",
  "language-school",
  "party-characters",
];

/** Where a trade with no pf.settings starts, in each flow (K-01 tradeSettings): arrive "window", the cutoff empty. */
export const START_SETTINGS: { readonly arrive: Arrive; readonly cutoff: null } = {
  arrive: "window",
  cutoff: null,
};

const FLOWS: readonly FlowLetter[] = ["A", "B"];

/** One value C5 fills in a trade. */
export interface Fill {
  tag: CorrectionTag;
  trade: TradeId;
  /** The plug-in key filled: pf.facts, or a setting of one flow. */
  key: "pf.facts" | "pf.settings.arrive" | "pf.settings.cutoff";
  /** The flow, for a setting. */
  flow?: FlowLetter;
  /** The value from then on: the facts, the arrive setting, or the cutoff (null: empty). */
  value: Name[] | Arrive | null;
}

/** A trade with C5's values: the loaded trade with its facts filled, and every value C5 filled. */
export interface CorrectedTradeValues {
  /** The loaded trade, with insurance's facts in pf.facts; its pf.settings as the file writes them (null for the 12). */
  trade: LoadedTrade;
  filled: Fill[];
}

const TAG: CorrectionTag = "MC:C5";

/**
 * The trade with C5's values. Insurance with no pf.facts gets cpa.json's list; a trade with no pf.settings starts each
 * flow at arrive "window" and an empty cutoff, which the compiled overlay holds as its settings (emit/trade.ts
 * settingsFor). The trade given is not changed; one C5 fills nothing in is given back as it is.
 */
export function correctTrade(trade: LoadedTrade): CorrectedTradeValues {
  const filled: Fill[] = [];
  let out = trade;
  if (trade.id === INSURANCE && trade.facts === null) {
    out = { ...trade, facts: [...INSURANCE_FACTS] };
    filled.push({ tag: TAG, trade: trade.id, key: "pf.facts", value: [...INSURANCE_FACTS] });
  }
  if (trade.settings === null)
    for (const flow of FLOWS) {
      filled.push({
        tag: TAG,
        trade: trade.id,
        key: "pf.settings.arrive",
        flow,
        value: START_SETTINGS.arrive,
      });
      filled.push({
        tag: TAG,
        trade: trade.id,
        key: "pf.settings.cutoff",
        flow,
        value: START_SETTINGS.cutoff,
      });
    }
  return { trade: out, filled };
}

/** The fills as diff lines: `MC:C5 + <trade> <key> [<flow>]: <value>`, each starting with its tag. */
export function renderFills(filled: readonly Fill[]): string[] {
  return filled.map(
    (fill) =>
      `${fill.tag} + ${fill.trade} ${fill.key}${fill.flow === undefined ? "" : ` ${fill.flow}`}: ${JSON.stringify(fill.value)}`,
  );
}

/** C5: the values a trade file leaves out. They are the trade's, not a step's, so the correction changes no step. */
export const c5: Correction = {
  id: "C5",
  title:
    "Insurance's facts (cpa.json's list); the 12 trades with no settings start at window and an empty cutoff",
  source:
    "Master Corrections C5; SPEC-prof.md lines 116-118, 127; S1-03; FRONTEND-SPEC.md rows H06, H07; QUESTIONS CQ-129 (a) default",
  apply() {
    // No step changes: C5's values are the trade's (correctTrade).
  },
};
