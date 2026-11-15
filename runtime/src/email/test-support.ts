// Doubles for the email rows' tests (T-1286; BP 5.2: tests use fakes, never an outside service). Used only by the
// *.test.ts files; never imported by the Worker.
//
// `RecordingEmailPort` is the email port as the dispatcher calls it (./types.ts EmailSendPort), over the email double
// (T-418; C-213's double, adapters/src/email/double), which answers K-12 v1 sendEmail as the Resend adapter does: it
// refuses a request K-12 refuses for its shape (the adapter's own checks, which T-419's tests hold to the double's), records
// each email it accepts once per key, answers a repeated key with the same email with its first answer (Resend's
// Idempotency-Key), and answers any failure K-12 defines when the test chooses one (`double.failNextSend`). The recorder
// keeps every request the dispatcher made, a failed or refused one included, in order, with the clock's time of each.

import { createEmailDouble, type EmailDouble } from "@rosie/adapters/email/double";
import type { EmailSendOutcome, EmailSendPort, EmailSendRequest } from "./types";

export class RecordingEmailPort implements EmailSendPort {
  /** Every request the port was handed, in order (a failed or refused one included). */
  readonly requests: EmailSendRequest[] = [];
  /** The clock's time of each request, in the same order. */
  readonly times: string[] = [];
  /** The email double behind the port: a test chooses its next failure here (failNextSend). */
  readonly double: EmailDouble;
  /** Runs before each answer: a test holds a send in the air here. */
  beforeAnswer: ((request: EmailSendRequest) => Promise<void>) | null = null;

  constructor(private readonly now: () => string) {
    this.double = createEmailDouble({ now });
  }

  async sendEmail(request: EmailSendRequest): Promise<EmailSendOutcome> {
    this.requests.push(structuredClone(request));
    this.times.push(this.now());
    if (this.beforeAnswer !== null) await this.beforeAnswer(request);
    return this.double.sendEmail(request);
  }

  /** The emails the double accepted, oldest first, each once (K-12 doubleSentEmails). */
  async sent(): Promise<EmailSendRequest[]> {
    return (await this.double.doubleSentEmails({ to: null })).emails.map((email) => email.request);
  }

  /** The idempotency keys of the requests, in order. */
  get keys(): string[] {
    return this.requests.map((request) => request.idempotencyKey);
  }
}
