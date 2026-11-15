// Staging's email port (ADR-016 card F and section 5; T-1288; build prompt 9.4; the lead's notes DL-549, DL-552, DL-768,
// DL-776 and DL-802): RootOptions.emailRows, the port and the From address the dispatcher's email rows go by
// (DispatchDeps.email; T-1286), as ./options.ts builds it beside the test-phone part, whose line it is handed.
//
// The router decides, at each send, where one K-12 sendEmail request goes:
//   Resend      T-419's adapter (@rosie/adapters/email/resend-send), only for a request of purpose `code` whose
//               address is on the named-inbox list, STAGING_TEST_INBOXES, read at that send with the adapter's own
//               readTestInboxes, so the router and the adapter read the list alike (DL-549; DL-552: in lower case,
//               and one entry that is no address voids the whole list). The adapter holds the same list as its own
//               allow-list (K-12 default 19): two locks. It reads RESEND_API_KEY at the send; with none it refuses
//               the email (K-12 refused, 401 missing_api_key), and the router never sends it another way.
//   the double  every other request: any other purpose, a code to any other address, and every request while the
//               list is missing, blank or not a list of addresses (a missing list is an empty one). It goes to
//               staging's test-phone line (./test-phone.ts stagingLineOf: TEST_PHONE_LINE read at each call), whose
//               email double answers it as Resend would and keeps it where the test-phone page lists it (T-1186;
//               K-21 README line 155).
// So no real person is alerted from staging (build prompt 9.4): only a code reaches a real inbox, a listed one.
//
// Two log lines, each one JSON line that names only the missing name (ADR-016 section 5): STAGING_TEST_INBOXES when a
// code request meets no list (it goes to the double), and RESEND_API_KEY when a listed code request is refused for want
// of the key. Never logged, put in an error or kept here: an address, the list, the key, the code, the words or the
// request.
//
// Nothing bound stays closed (DL-768): the part is handed the test-phone part's line, which is null anywhere but
// staging and wherever no HYPERDRIVE_JOB is bound (./test-phone.ts stagingTestPhone); with none it gives null, so every
// email row ends noEmailPort with nothing sent. At build it reads nothing at all: the key and the list are read at each
// send, the line at each call, and the From address is K-12 default 2's config value, ROSIE_FROM_ADDRESS (no var names
// another: wrangler.jsonc). The root puts its email door in front (../email-door.ts), so a send that throws or gives no
// answer in time is K-12's no answer, never a rejected run, and binds the port on staging alone. Production binds no
// email port: ./options.ts builds no part there (STATE note 72).

import {
  createResendSender,
  readTestInboxes,
  RESEND_API_KEY,
  TEST_INBOXES,
} from "@rosie/adapters/email/resend-send";

import { ROSIE_FROM_ADDRESS, type EmailRowsDeps, type EmailSendPort } from "../../email";
import type { TestPhoneLinePort } from "../test-phone";
import type { StagingEnv, StagingPart } from "./part";

/** What T-1288's builder is handed: the env (RESEND_API_KEY, STAGING_TEST_INBOXES), the root's handle, and the line. */
export interface EmailPart extends StagingPart {
  /**
   * Staging's test-phone line, as the test-phone part binds it (RootOptions.testPhone.line): where every email that is
   * not a listed code goes. Null where that part binds none.
   */
  readonly line: TestPhoneLinePort | null;
}

/** What a test may stand in: Resend's HTTP call and clock, and where the log lines go. */
export interface EmailSeams {
  /** The adapter's one request to Resend. Left out: the runtime's fetch, read at each send. */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** The adapter's clock for acceptedAt. Left out: its own. */
  readonly now?: () => string;
  /** Where each log line goes. Left out: console.log (Workers Logs). */
  readonly write?: (line: string) => void;
}

/** The two names a log line may name, each as the one that is missing. */
export type EmailMissingName = typeof RESEND_API_KEY | typeof TEST_INBOXES;

/** One log line: the missing name and where the Worker runs (ADR-009), nothing else. */
export interface EmailMissingLine {
  readonly level: "warn";
  readonly msg: "emailPortMissing";
  readonly missing: EmailMissingName;
  readonly environment: string;
  readonly version: string;
}

/** Resend's error name for a send with no key, as the adapter answers it (K-12 refused, 401). */
const MISSING_API_KEY = "missing_api_key";

/** The line for one missing name, read where the Worker runs at the moment it is written. */
export function emailMissingLine(missing: EmailMissingName, env: StagingEnv): EmailMissingLine {
  return {
    level: "warn",
    msg: "emailPortMissing",
    missing,
    environment: env.ENVIRONMENT,
    version: env.GIT_SHA ?? "unknown",
  };
}

/**
 * Staging's email port: one K-12 sendEmail request to Resend when it is a code to a listed inbox, else to the line's
 * email double, each answer as its side gives it (see the top of this file). Reads nothing as it is made.
 */
export function stagingEmailRouter(
  env: StagingEnv,
  line: TestPhoneLinePort,
  seams: EmailSeams = {},
): EmailSendPort {
  const write =
    seams.write ??
    ((text: string) => {
      console.log(text);
    });
  const missing = (name: EmailMissingName): void => {
    write(JSON.stringify(emailMissingLine(name, env)));
  };
  // The adapter reads its two names from the env at each send, never as it is made.
  const resend = createResendSender({
    env,
    ...(seams.fetch === undefined ? {} : { fetch: seams.fetch }),
    ...(seams.now === undefined ? {} : { now: seams.now }),
  });
  return {
    async sendEmail(request) {
      if (request.purpose !== "code") return line.sendEmail(request);
      const list = readTestInboxes(env.STAGING_TEST_INBOXES);
      if (!list.ok) {
        // A missing list is an empty one: the code goes to the double, where the test-phone page lists it.
        missing(TEST_INBOXES);
        return line.sendEmail(request);
      }
      if (!list.inboxes.has(request.to)) return line.sendEmail(request);
      const answer = await resend.sendEmail(request);
      // Refused for want of the key: answered as refused, and never sent another way.
      if (answer.result === "failed" && answer.code === MISSING_API_KEY) missing(RESEND_API_KEY);
      return answer;
    },
  };
}

/**
 * RootOptions.emailRows for staging: the router over the test-phone part's line, with the From address. Null where that
 * part binds no line (anywhere but staging, or no HYPERDRIVE_JOB), so every email row ends noEmailPort. Reads nothing.
 */
export function stagingEmail(part: EmailPart, seams: EmailSeams = {}): EmailRowsDeps | null {
  const { env, line } = part;
  if (line === null) return null;
  return { port: stagingEmailRouter(env, line, seams), fromAddress: ROSIE_FROM_ADDRESS };
}
