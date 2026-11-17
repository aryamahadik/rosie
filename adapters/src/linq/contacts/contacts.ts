// The Linq contacts registrar (T-415; C-208; K-11 v1 contactAdd; MC C9; arch 11 line 572; Q-03), built as a stub that
// makes no network call.
//
// Why a stub: Linq's v3 API has no contacts/add. Its API reference (docs.linqapp.com/api/, read Nov 17; DL-919) has no
// contacts resource and no contacts/add call (K-11 README open gap 1; adapters/spikes/linq-live/FINDINGS.md answer 1 and
// vendor fact 1), and a first send by number (POST /v3/chats) opens the chat; a first message in a new chat may not be a
// link (400, code 1005), which is Q-03's reason for adding a contact before any link. CQ-354 asks the architect whether a
// K-11 minor version drops contacts/add or defines it as opening the chat with a first text-only message. Until the
// architect rules on CQ-354, this stub (the lead's default, DL-922; T-415's lead note, item 3) answers every contact add
// with K-11 v1's failed result, and it never invents a Linq path.
//
// Its answers, in this order; none sends anything:
//   1. A request with no E.164 phone: the Linq double's answer (adapters/src/linq/double/double.ts contactAdd), code
//      1002 (Linq's code for a number in another form: K-11 $defs/phone) and its words, so the adapter refuses as the
//      double does, but naming NO_PHONE as the phone (see NO_PHONE).
//   2. ENVIRONMENT test: refused. Automated tests never add a contact on the real line (build prompt 9.4; the card's
//      "Proves it with"). ENVIRONMENT unset, blank, or any value but staging and production is refused the same way,
//      failing closed (a Worker's ENVIRONMENT is staging or production; only a test is test: runtime/src/wiring/picks.ts).
//   3. Otherwise (staging, production): not added, not retryable, code null, with the closest documented reason: K-11
//      v1's not-retryable failure, "Linq refused the number" (contactAdd.errors; contact-add-failed.json's retryable false
//      and code null), in the adapter's words: Linq's v3 API has no contacts/add call. Not retryable, because a retry on
//      the effect's key meets the same missing call (K-07's effect rules retry only a retryable failure: arch 10 line 542).
//      With no `added`, no chat link or QR code is shown, and the person uses the booking page, email or their own AI
//      (Q-03's default).
//
// It reads one name from the environment it is given, at each call: ENVIRONMENT. It never reads LINQ_API_TOKEN (no request
// is made), takes no fetch, and writes, logs and prints nothing.

import type { ContactAddFailed, ContactAddOutcome } from "./types";

/** The name the environment is read by (wrangler.jsonc vars; runtime/src/wiring/picks.ts ENVIRONMENTS). */
export const ENVIRONMENT = "ENVIRONMENT";

/** Where ENVIRONMENT is read at each call: the Worker's env. */
export interface LinqContactsEnv {
  readonly ENVIRONMENT?: unknown;
}

export interface LinqContactRegistrarOptions {
  /** Where ENVIRONMENT is read, by name, at each call. */
  readonly env: LinqContactsEnv;
}

/** K-11 v1's contact add, as this adapter answers it (the Linq double answers the same call: T-411). */
export interface LinqContactRegistrar {
  contactAdd(request: unknown): Promise<ContactAddOutcome>;
}

/** K-11's phone: a number in E.164 form ($defs/phone). */
const PHONE = /^\+[1-9][0-9]{6,14}$/;
/** The environments of a Worker on the real line (wrangler.jsonc: env.staging and env.production). */
const LINE_ENVIRONMENTS: readonly string[] = ["staging", "production"];

/** The adapter's fixed words for each answer (the first is the Linq double's, word for word). */
export const REASONS = {
  notE164: "The number is not in E.164 form.",
  testEnvironment:
    "Refused: ENVIRONMENT is test, and an automated test never adds a contact on the real line: nothing was sent.",
  otherEnvironment:
    "Refused: ENVIRONMENT is not staging or production, so no contact is added on the real line: nothing was sent.",
  noContactsCall: "Linq did not add the number: Linq's v3 API has no contacts/add call, so nothing was sent.",
} as const;

/**
 * The phone a failed answer names when the request holds none in E.164 form: K-11's failed result must name one, and
 * none was given. The Linq double names an all-zero placeholder there (double.ts contactAdd), which the repository's
 * phone scan takes at the double's own file alone (infra/ci/phone-scan-exceptions.mjs), so this adapter names the
 * fiction block's first number (555-0100, no one's line) instead.
 */
export const NO_PHONE = "+15555550100";

function failed(phone: string, code: string | null, reason: string): ContactAddFailed {
  return { result: "failed", phone, retryable: false, code, reason };
}

/** The request's phone when it is an E.164 number, read as the double reads it; else null. */
function phoneOf(request: unknown): string | null {
  const phone =
    typeof request === "object" && request !== null && "phone" in request ? request.phone : undefined;
  return typeof phone === "string" && PHONE.test(phone) ? phone : null;
}

/** One contact add's answer (see the top of this file). */
function answer(request: unknown, env: LinqContactsEnv): ContactAddFailed {
  const phone = phoneOf(request);
  if (phone === null) return failed(NO_PHONE, "1002", REASONS.notE164);
  const environment = env.ENVIRONMENT;
  if (environment === "test") return failed(phone, null, REASONS.testEnvironment);
  if (typeof environment !== "string" || !LINE_ENVIRONMENTS.includes(environment))
    return failed(phone, null, REASONS.otherEnvironment);
  // CQ-354: Linq's v3 API has no contacts/add, so no request is made; the architect rules what contacts/add becomes.
  return failed(phone, null, REASONS.noContactsCall);
}

export function createLinqContactRegistrar(options: LinqContactRegistrarOptions): LinqContactRegistrar {
  return {
    contactAdd(request: unknown): Promise<ContactAddOutcome> {
      return Promise.resolve(answer(request, options.env));
    },
  };
}
