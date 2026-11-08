// The slot filler (C-088, T-310): every number, date, price, code, name and link a person reads, filled by code from
// the record and code facts (arch 01 line 35; arch 02 line 123; arch 07 line 409; build prompt rule 4).

export {
  fillAtSend,
  fillPlan,
  fillText,
  readerZone,
  type FilledPlan,
  type PlanFill,
  type PlanQuestion,
  type PlanText,
  type SendMoment,
  type SlotProblem,
  type SlotValue,
  type TextFill,
} from "./fill";
export { FILLERS, initials, type SlotFiller } from "./fillers";
export { MoneyFormatError, formatMoney } from "./money";
export {
  AFTER_CHOICES,
  BEFORE_CHOICES,
  BOOKING_GROUPS,
  PRICE_CHOICES,
  RECORD_VALUES,
  pickRow,
  type AfterChoice,
  type BeforeChoice,
  type BookingValues,
  type PriceChoice,
  type RecordReading,
  type RecordValue,
  type SlotRow,
} from "./record";
export type {
  AmountFacts,
  BusinessFacts,
  ChangeFacts,
  Channel,
  LedgerFacts,
  LinkFacts,
  Money,
  ReaderZones,
  SlotFacts,
  SlotSource,
  Time,
  TimeRange,
  VisitFacts,
} from "./types";
export { RECORD_SLOT_NAMES, SLOT_NAMES, VOCABULARY, isSlotName, type SlotName } from "./vocabulary";
