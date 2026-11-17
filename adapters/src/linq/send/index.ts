// The real Linq send adapter (T-414; C-206; K-11 v1 sendPart).
export {
  DEFAULT_TIMEOUT_MS,
  LINQ_API_TOKEN,
  createLinqSender,
  type LinqSendEnv,
  type LinqSender,
  type LinqSenderOptions,
} from "./send";
export type {
  AttachFile,
  CalendarFile,
  LinqAttachOutcome,
  LinqFile,
  LinqFileAttached,
  LinqService,
  PhotoRef,
  SendFailureKind,
  SendKind,
  SendPartAccepted,
  SendPartFailed,
  SendPartOutcome,
  SendPartRequest,
  TapbackRef,
} from "./types";
export { sendPartProblems } from "./validate";
export { LINQ_API_BASE, USER_AGENT } from "./wire";
