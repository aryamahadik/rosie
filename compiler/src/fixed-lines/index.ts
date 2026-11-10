// The bundle's fixed lines (T-1146; C-089; K-01 v1 `fixedLines`): K-01 v1's accepted lines, optOutLine in Spanish from
// msgtext.js line 32, and the privacy-notice link as Q-30's default stand-in.
export {
  OPT_OUT_LINE,
  PRIVACY_LINK_LINE,
  PRIVACY_NOTICE,
  WRANGLER_FILE,
  FixedLinesError,
  basePathIn,
  buildFixedLines,
  composeFixedLines,
  k01FixedLines,
  privacyLinkLine,
  privacyNoticeAddress,
  readBasePath,
  readStopLines,
  spanishOptOutLine,
  type Environment,
  type FixedLine,
  type FixedLines,
  type FixedLinesOptions,
  type MsgTextStopLines,
} from "./lines";
