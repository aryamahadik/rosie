// The email rows (T-1286; C-129): the K-12 request an email outbox row goes as, and the email port's send call as the
// dispatcher makes it. See rows.ts and types.ts.

export {
  ASSISTANT_LINE,
  CODE_SUBJECT,
  ROSIE_FROM_ADDRESS,
  ROSIE_NAME,
  codeEmailRequest,
  emailAddressOf,
  emailWordsOf,
  type CodeEmailInput,
  type NotBuilt,
} from "./rows";
export type * from "./types";
