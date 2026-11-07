// Sample-value slotting (T-142; C-062): sample names, dates, times, prices and places in message lines become slots
// from K-03 v1's vocabulary (C6), Rosie's own fee terms ($2, $49 cap, 1%) excepted.
export {
  MalformedSlotError,
  UnknownSlotError,
  checkSlotNames,
  slotNames,
  slotRefs,
  slotVocabulary,
  writeSlot,
  type SlotEntry,
  type SlotRef,
} from "./vocabulary";
export {
  castPeople,
  sampleTable,
  type AmountField,
  type FlowHeader,
  type NameSlot,
  type SampleName,
  type SampleTable,
} from "./samples";
export {
  FEE_TERMS,
  countFeeTerms,
  eachStep,
  slotApplied,
  slotFlow,
  slotMessage,
  slotText,
  type SlottedTrade,
} from "./slotting";
export {
  checkLines,
  flowLines,
  leftovers,
  pathLines,
  recordLines,
  slotCounts,
  type Leftover,
  type LeftoverKind,
  type Line,
} from "./scan";
