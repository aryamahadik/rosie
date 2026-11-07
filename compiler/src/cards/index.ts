// Step cards and fallback text (T-144): per decision the question, each branch's Means line or its stand-in, the Never
// lines, the safe default and the Clock line or step 9's default; per step its fallback text (compiler/src/cards).
export {
  CardError,
  cardOf,
  compileCards,
  compileMasterCards,
  compileTradeCards,
  decisionsOf,
  lacksMeans,
  type CardBranch,
  type CardClock,
  type CardMeans,
  type CardStep,
  type Decision,
  type Leads,
  type MeansFrom,
  type StepCard,
} from "./card";
export { compileFallbackTexts, fallbackTextOf, fillRecordSlots } from "./fallback";
export {
  LineError,
  clockLineOf,
  firstSentence,
  hasMeansLine,
  meansOf,
  neverLines,
  safeDefaultOf,
  type MeansEntry,
} from "./lines";
