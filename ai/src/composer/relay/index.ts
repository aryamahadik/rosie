// The composer's relays, translation, sensitive work, tone tags and language (T-375, C-118): the reader's checks on a
// plan (check.ts, with quote.ts, sensitive.ts, tone.ts and language.ts), and private words as the model reads them
// (private.ts).

export { readerProblems } from "./check";
export {
  CHECKED_LANGUAGES,
  LEAST_OTHER_WORDS,
  SMALL_WORDS,
  languageProblems,
  smallWordCounts,
  type CheckedLanguage,
} from "./language";
export { PRIVATE_DETAIL, PRIVATE_TAGS, withPrivateDetails } from "./private";
export {
  CODE_READINGS,
  CRISIS_READINGS,
  QUOTE_RUN,
  QUOTE_SLOT,
  SECURE_PAGE_READING,
  SHORTEST_QUOTE,
  isCodeReading,
  quoteOf,
  quoteProblems,
} from "./quote";
export { PERSON_SLOTS, SERVICE_SLOTS, gentleRow, sensitiveProblems, serviceHidden } from "./sensitive";
export { EXCLAMATION, toneProblems } from "./tone";
