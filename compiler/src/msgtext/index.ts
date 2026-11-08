// Element plain-text forms and the guard's keyword list (T-134; C-064): msgtext.js smsText(), OPTOUT and KEYS, wrapped.
export {
  TEXT_FORM_KINDS,
  bareLinks,
  bundleMessage,
  elementKeys,
  elementTexts,
  flowMessages,
  plainText,
  typedOptions,
  type BundleMessage,
  type ElementText,
  type FlowMessage,
  type MessageList,
  type TextFormKind,
} from "./forms";
export { buildKeywords, keywordsJson, type Keywords } from "./keywords";
export {
  MSGTEXT_FILE,
  loadMsgText,
  parseOptOut,
  readOptOut,
  type MsgTextScript,
  type OptOutSource,
} from "./script";
