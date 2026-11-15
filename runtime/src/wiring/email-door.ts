// The dispatcher's door to the email port (T-1288; ADR-016 card F; K-12 v1 sendEmail; T-1286's handoff and its
// security reviewer's note 2; the lead's note DL-802, item 3): what the composition root puts between the outbox
// dispatcher's email rows and the email port it is handed (RootOptions.emailRows: on staging, ./staging/email.ts's
// router), as ./linq-door.ts does between the dispatcher and Linq.
//
//   - A send that throws (a Durable Object call's error, staging's test-phone line not bound, any fault of the port),
//     or gives no answer within EMAIL_SEND_TIMEOUT_MS, far below the claim's 60 s (K-07 default 2), is answered as
//     K-12's no answer: failed, transient, with no status (code sendThrew or sendTimeout). Never a rejected run: the
//     dispatcher keeps the part pending under the same key (K-07 rule 1; ../dispatch/dispatcher.ts emailRetryRuleFor)
//     and sends it again under that key, which the port answers as the first send (Resend's Idempotency-Key; the email
//     double's record by key), so the person gets one email.
//   - An address lookup that throws (RecipientDirectory.emailFor) is no address known: none, so the row ends
//     noAddress with nothing sent and its claim left to lapse. Never a rejected run. The send-state port's own emailFor
//     reads only what its read kept (./real.ts realSendState) and makes no call; this holds for any directory the root
//     is handed.
//   - Each is one JSON line, labels only (K-12's rule; K-08 v1): the call, why, and the error's name when it is a
//     label. Never the request, an address, a code, the words, a key or the error's message.
//
// Worker code: no double, no fixture, no key.

import type { RecipientDirectory } from "../dispatch/types";
import type { EmailFailed, EmailSendOutcome, EmailSendPort } from "../email";
import { isLabel, type LogContext } from "../trace";

/** How long the door waits for the email port's answer to one send: far below the claim's 60 s (K-07 default 2). */
export const EMAIL_SEND_TIMEOUT_MS = 15_000;
/** The code of a send the email port threw on, answered as K-12's no answer (K-04 outbox_parts.error_code). */
export const EMAIL_SEND_THREW = "sendThrew";
/** The code of a send the email port did not answer within the door's time limit. */
export const EMAIL_SEND_TIMEOUT = "sendTimeout";

/** The calls the door stands in front of. */
export type EmailDoorCall = "sendEmail" | "emailFor";

/** The door's one line for a call with no answer: labels only. */
export interface EmailNoAnswerLine {
  readonly level: "warn";
  readonly msg: "emailNoAnswer";
  readonly call: EmailDoorCall;
  readonly why: "threw" | "timedOut";
  /** The error's name when it is a label (TypeError, NoTestPhoneLineError); null for any other. Never its message. */
  readonly error: string | null;
  readonly environment: string;
  readonly version: string;
}

export interface EmailDoorOptions {
  /** Where the Worker runs, for every line (ADR-009). */
  readonly log: LogContext;
  /** The send's time limit in milliseconds (EMAIL_SEND_TIMEOUT_MS when left out: a test's shorter wait). */
  readonly timeoutMs?: number;
  /** Where each line goes: console.log (Workers Logs) when left out. */
  readonly write?: (line: string) => void;
}

/** K-12's no answer for a send the door answers itself: transient, no status, the door's own fixed words. */
function noAnswer(code: typeof EMAIL_SEND_THREW | typeof EMAIL_SEND_TIMEOUT): EmailFailed {
  return {
    result: "failed",
    kind: "transient",
    httpStatus: null,
    code,
    reason:
      code === EMAIL_SEND_THREW
        ? "the email port gave no answer: the send threw"
        : "the email port gave no answer within the send's time limit",
    retryAfterSeconds: null,
  };
}

/** The error's name when it is a label, else null: never its message, which may hold what the call was handed. */
function errorNameOf(error: unknown): string | null {
  const name: unknown = error instanceof Error ? error.name : null;
  return isLabel(name) ? name : null;
}

/** Writes the door's one line for a call with no answer. */
type LineWriter = (call: EmailDoorCall, why: EmailNoAnswerLine["why"], error: unknown) => void;

function lineWriter(options: EmailDoorOptions): LineWriter {
  const write =
    options.write ??
    ((line: string) => {
      console.log(line);
    });
  return (call, why, error) => {
    const line: EmailNoAnswerLine = {
      level: "warn",
      msg: "emailNoAnswer",
      call,
      why,
      error: why === "threw" ? errorNameOf(error) : null,
      environment: options.log.environment,
      version: options.log.version,
    };
    write(JSON.stringify(line));
  };
}

/** How a send settled: the port's answer, a throw, or the door's time limit first. */
type Settled =
  { readonly answered: EmailSendOutcome } | { readonly threw: unknown } | { readonly timedOut: true };

/**
 * The email port as the dispatcher sends through it: each send answered as the port answers it, or, when it throws or
 * gives no answer in time, as K-12's no answer (see the top of this file).
 */
export function emailDoor(port: EmailSendPort, options: EmailDoorOptions): EmailSendPort {
  const timeoutMs = options.timeoutMs ?? EMAIL_SEND_TIMEOUT_MS;
  const line = lineWriter(options);
  return {
    async sendEmail(request) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<Settled>((resolve) => {
        timer = setTimeout(() => {
          resolve({ timedOut: true });
        }, timeoutMs);
      });
      // A port that throws as it is called, before it hands back a promise, is caught the same way.
      const sent: Promise<Settled> = Promise.resolve()
        .then(() => port.sendEmail(request))
        .then(
          (answered) => ({ answered }),
          (threw: unknown) => ({ threw }),
        );
      try {
        const settled = await Promise.race([sent, late]);
        if ("answered" in settled) return settled.answered;
        if ("threw" in settled) {
          line("sendEmail", "threw", settled.threw);
          return noAnswer(EMAIL_SEND_THREW);
        }
        line("sendEmail", "timedOut", null);
        return noAnswer(EMAIL_SEND_TIMEOUT);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The recipients' directory as the dispatcher reads it: the chat as the directory gives it, and the address, where an
 * emailFor that throws is none (no address known: noAddress, nothing sent), never a rejected run. A directory with no
 * emailFor knows no address, as the dispatcher reads one.
 */
export function answeringRecipients(
  recipients: RecipientDirectory,
  options: EmailDoorOptions,
): RecipientDirectory {
  const line = lineWriter(options);
  return {
    chatFor: (recipientHandleId) => recipients.chatFor(recipientHandleId),
    async emailFor(recipientHandleId) {
      try {
        return (await recipients.emailFor?.(recipientHandleId)) ?? null;
      } catch (error) {
        line("emailFor", "threw", error);
        return null;
      }
    },
  };
}
