// The messages-and-consent service base (T-307; C-102): the commit's outbox rows (one message, one recipient, one
// channel, a send class and every version the read-back showed) and consent rows (a yes bound to its read-back, a STOP
// or a START as a new row, never an edit), and how each person is reached. A Tool API handler makes one per call:
// createMessagesConsent({ businessId: context.businessId, reader: messagesReaderOf(context.repo) }).

export {
  CONSENTS_TABLE,
  CONSENT_CHANNELS,
  CONSENT_KINDS,
  ConsentRefusedError,
  assertConsentsAppendOnly,
  checkConsentValues,
  newestDecides,
  stateWriteOf,
  textsStanding,
  wordsSha256,
  type ConsentChannel,
  type ConsentFault,
  type ConsentKind,
  type ConsentValues,
  type ConsentWrite,
} from "./consent";
export {
  createMessagesConsent,
  type EmailContact,
  type Medium,
  type MessageRequest,
  type MessageRows,
  type MessagesConsent,
  type MessagesConsentOptions,
  type Mobile,
  type NotBuilt,
  type NotBuiltWhy,
  type Reach,
  type Recipient,
  type StopRequest,
  type TextsStanding,
  type YesRequest,
} from "./messages-consent";
export {
  CHANNELS,
  OUTBOX_ROW_FIELDS,
  OutboxRefusedError,
  SEND_CLASSES,
  checkChannelAndPort,
  emailCopyId,
  portOf,
  versionsReadOf,
  type Channel,
  type ChannelAndPort,
  type OutboxFault,
  type Port,
  type SendClass,
} from "./outbox";
export {
  NO_REACH_CARDS,
  REACH_WAYS,
  messagesReaderOf,
  type MessagesReader,
  type ReachCard,
  type ReachCards,
  type ReachWay,
} from "./reads";
