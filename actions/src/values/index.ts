// Values in a person's words (T-304): dates, times, money, counts and the rest, read in English and Spanish and re-parsed
// against the value the model gave (arch 03 line 185; arch 06 line 309). Limit 6 (actions/src/gate/limit-6) is its first
// caller; finalize's separate Values check may share it (T-1107). foundAtWordEdges is the one rule for words found in a
// text, judged on the folded text the readers read, which limit 6 and the gate's quote check
// (actions/src/gate/framework/checks.ts) both use (DL-184, DL-189); wholePhraseFault re-reads a number's whole value phrase
// around its words (DL-189). Pure code: no clock, no I/O, no log.

export { DEFAULT_CURRENCY, amountsIn, distinctMoney, sameMoney, type FoundAmount, type Money } from "./money";
export { numberPhrasesIn, numberWordsOf, type NumberPhrase } from "./numbers";
export { isPhraseType, wholePhraseFault, type PhraseFault, type PhraseType } from "./phrase";
export {
  FIELD_TYPES,
  countSpansIn,
  countsIn,
  isMoney,
  isZonedTime,
  optionsNamedIn,
  reparse,
  yesOrNoIn,
  zoneWordSpansIn,
  zonesNamedIn,
  type ChoiceOption,
  type FieldType,
  type FieldValue,
  type FoundCount,
  type Reparse,
  type ReparseContext,
  type ReparseFault,
  type ZoneWord,
  type ZonedTime,
} from "./reparse";
export {
  instantsFor,
  readTimeWords,
  timeReadingOf,
  timeSpansIn,
  type ClockWords,
  type DayWords,
  type TimeRead,
  type TimeReading,
  type TimeWords,
  type WeekdayWords,
} from "./times";
export {
  BOTH_LANGUAGES,
  foldWords,
  foundAtWordEdges,
  languagesOf,
  visibleWords,
  wholeAt,
  wordsOf,
  type Span,
  type ValueLanguage,
} from "./words";
export {
  addDays,
  daysInMonth,
  instantsAt,
  isDate,
  isZone,
  wallOf,
  weekdayOf,
  type LocalDate,
  type WallTime,
} from "./zone";
