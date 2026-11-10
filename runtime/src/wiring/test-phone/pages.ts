// The test-phone page's two calls on the Worker (T-1186; C-040, C-205; K-21 v1 testPhoneSend and testPhoneParts; build
// prompt 9.4 'The test-phone page'): T-565's handlers (@rosie/actions, createTestPhoneHandlers) over the ports the root
// holds, for the gateway's page entry (GatewayDeps.pages, T-266). The root binds them only where ENVIRONMENT is staging;
// everywhere else the entry answers stagingOnly before any handler runs, and nothing here is built (DL-373).
//
//   access        K-22 session_for_token by the token's sha256, with the roster's testers and K-36's team rows, handed in
//                 with its database bound (TestPhoneInputs.access); none bound (the Worker until T-567), every call fails
//                 closed, so both calls answer 503
//   roster        staging's test-phone roster, id to E.164 number and the person's email (Q-53): handed in the same way; its
//                 numbers are the fictional 555-01xx, the only ones the Linq double signs as (DL-373 gap (b))
//   phones        K-04 state and the chat link: handed in the same way
//   linqWebhooks  the Linq double's signer (T-412) under the webhook secret the gateway's Linq verify reads, read at each
//                 send (LINQ_WEBHOOK_SECRET in the Worker, the run's made-up secret in a test): none set, no send
//   gateway       the root's Linq webhook route (root.linqWebhook), behind the skeleton flag: off, it answers 404, and the
//                 send answers 503 (DL-373 gap (c))
//   parts, emails staging's test-phone line (./line.ts), the one store every isolate shares (DL-373 gap (a)): the parts the
//                 dispatcher sent through it from an actor's isolate, and the emails the email rows sent through it. None
//                 bound, testPhoneParts answers 503. T-565's record read (PartsRecord.partsTo) is synchronous, so the
//                 line's parts are read once the roster has found the phone, which T-565 asks only after the session's
//                 tester check: a refused call reads nothing.
//
// Neither call makes a K-09 call: the signed event names the trace the entry opened (trace.traceId), as T-565 builds it.
// Nothing here logs or writes a span.

import { createLinqWebhookDouble, type LinqWebhookDouble } from "@rosie/adapters/linq/double-webhooks";
import type {
  DoubleSentEmailsOutcome,
  SendEmailOutcome,
  SendEmailRequest,
} from "@rosie/adapters/email/double";
import type { SendPartOutcome } from "@rosie/adapters/linq/double";
import {
  createTestPhoneHandlers,
  type PhoneStates,
  type RecordedPart,
  type TestPhoneDeps,
  type TestPhoneRoster,
  type TesterAccess,
} from "@rosie/actions/src/page-calls/staging/test-phone/index";

import type { LinqPort as LinqSendCall } from "../../dispatch/types";
import type { PageHandlers } from "../../gateway/pages";
import { LINQ_WEBHOOK_SECRET, MissingSecretError, NoDatabaseError } from "../real";
import type { TestPhoneLine } from "./line";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Staging's test-phone line (./line.ts), where it is bound (wrangler.jsonc env.staging); production binds none. */
      TEST_PHONE_LINE?: DurableObjectNamespace<TestPhoneLine>;
    }
  }
}

/** The one TestPhoneLine every staging isolate names (`idFromName`): one line for the whole roster. */
export const TEST_PHONE_LINE_NAME = "test-phone-line";

/** Staging's test-phone line (./line.ts) as its callers reach it: a Durable Object stub, or anything that answers the same. */
export interface TestPhoneLinePort {
  sendPart(request: unknown): Promise<SendPartOutcome>;
  partsTo(number: string): Promise<RecordedPart[]>;
  sendEmail(request: SendEmailRequest): Promise<SendEmailOutcome>;
  /** K-12 v1 doubleSentEmails (`{ to }`: an address, or null for every email), as the email double takes it. */
  sentEmails(request: unknown): Promise<DoubleSentEmailsOutcome>;
}

/** A TestPhoneLine namespace, as the Worker's binding (or a test's) gives it. */
export interface TestPhoneLineNamespace<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): unknown;
}

/**
 * The one TestPhoneLine (TEST_PHONE_LINE_NAME) as a port: each call takes a new stub of it, as the gateway's door to a
 * handle's actor does, so no stub outlives the request it serves.
 */
export function testPhoneLineOf<Id>(namespace: TestPhoneLineNamespace<Id>): TestPhoneLinePort {
  // The stub's own type wraps the class's RPC methods (its methods are the class's, in ./line.ts), so it is typed here.
  const line = (): TestPhoneLinePort =>
    namespace.get(namespace.idFromName(TEST_PHONE_LINE_NAME)) as TestPhoneLinePort;
  return {
    sendPart: (request) => line().sendPart(request),
    partsTo: (number) => line().partsTo(number),
    sendEmail: (request) => line().sendEmail(request),
    sentEmails: (request) => line().sentEmails(request),
  };
}

/** No test-phone line is bound here (the Worker until the TEST_PHONE_LINE binding exists). The message names nothing else. */
export class NoTestPhoneLineError extends Error {
  constructor() {
    super("no test-phone line is bound here");
    this.name = "NoTestPhoneLineError";
  }
}

/**
 * What the root is handed for the test-phone calls (RootOptions.testPhone): each port with its database bound, and the
 * line; null where none is bound, so each call through it fails closed and the page entry answers 503.
 */
export interface TestPhoneInputs {
  readonly access: TesterAccess | null;
  readonly roster: TestPhoneRoster | null;
  readonly phones: PhoneStates | null;
  readonly line: TestPhoneLinePort | null;
}

/** What the two calls reach besides their inputs: the Linq verify's secret, the root's Linq route and the clock. */
export interface TestPhonePageDeps {
  readonly inputs: TestPhoneInputs;
  /** The webhook secret the gateway's Linq verify reads, read at each send ("whsec_" and base64; undefined or "" when unset). */
  readonly webhookSecret: () => string | undefined | Promise<string | undefined>;
  /** The root's Linq webhook route (root.linqWebhook), which the signed webhook is posted to. */
  readonly linqWebhook: (request: Request) => Promise<Response>;
  /** Epoch milliseconds: the root's clock. */
  readonly now: () => number;
}

const noDatabase = (call: string): Promise<never> => Promise.reject(new NoDatabaseError(call));

/** The line, or one whose every call fails closed. */
function lineOf(line: TestPhoneLinePort | null): TestPhoneLinePort {
  if (line !== null) return line;
  const none = (): Promise<never> => Promise.reject(new NoTestPhoneLineError());
  return { sendPart: none, partsTo: none, sendEmail: none, sentEmails: none };
}

/** testPhoneSend and testPhoneParts over the root's ports, for {...unconfiguredPages(), ...} on staging. */
export function testPhonePages(
  deps: TestPhonePageDeps,
): Pick<PageHandlers, "testPhoneSend" | "testPhoneParts"> {
  const { inputs } = deps;
  const line = lineOf(inputs.line);
  const roster: TestPhoneRoster = inputs.roster ?? { phone: () => noDatabase("testPhoneRoster") };
  const signer: Pick<LinqWebhookDouble, "sign"> = {
    async sign(request, options) {
      const secret = await deps.webhookSecret();
      if (secret === undefined || secret === "") throw new MissingSecretError(LINQ_WEBHOOK_SECRET);
      return createLinqWebhookDouble({ secret }).sign(request, options);
    },
  };
  const shared: Omit<TestPhoneDeps, "roster" | "parts"> = {
    access: inputs.access ?? { standing: () => noDatabase("sessionForToken") },
    phones: inputs.phones ?? { state: () => noDatabase("phoneState") },
    linqWebhooks: signer,
    gateway: (request) => deps.linqWebhook(request),
    emails: { doubleSentEmails: (request) => line.sentEmails(request) },
    now: deps.now,
  };

  return {
    testPhoneSend: (page) =>
      createTestPhoneHandlers({ ...shared, roster, parts: { partsTo: () => [] } }).testPhoneSend(page),
    testPhoneParts: (page) => {
      // The line's parts to the phone, read once the roster has found it (after the tester check), for the synchronous read.
      let kept: readonly RecordedPart[] = [];
      const readingRoster: TestPhoneRoster = {
        async phone(testPhoneId) {
          const phone = await roster.phone(testPhoneId);
          if (phone !== null) kept = await line.partsTo(phone.number);
          return phone;
        },
      };
      return createTestPhoneHandlers({
        ...shared,
        roster: readingRoster,
        parts: { partsTo: (number) => kept.filter((part) => part.sent.to === number) },
      }).testPhoneParts(page);
    },
  };
}

/**
 * K-11 sendPart through staging's test-phone line (the dispatcher's LinqPort): each part goes to the line's Linq double,
 * which keeps what it recorded where the page reads it, and its answer comes back as the double gave it.
 */
export function lineLinqSend(line: TestPhoneLinePort): LinqSendCall {
  // The Linq double checks each request against K-11 itself, and its answer is K-11's, as the dispatcher reads it.
  return { sendPart: (request) => line.sendPart(request) };
}
