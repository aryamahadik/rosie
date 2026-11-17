// The real Linq capability check (T-415; C-209; K-11 v1 capabilityCheck; arch 07 line 365). It asks Linq what a number
// supports now, with Linq's two checks (./wire.ts), and answers K-11's result: `checked` with whether the number takes
// iMessage and the service a message to it would go by, cached by the caller for 10 minutes (cacheSeconds 600), or
// `failed`, which means the reply goes as text alone. It caches nothing itself: the 10 minutes are the caller's (runtime
// C-128; the card's "Not here"). One call is at most two requests, one after the other; it never tries a request again
// itself, and it writes, logs and prints nothing.
//
// It reads one name from the environment it is given, at each call, and nothing else:
//   LINQ_API_TOKEN  Linq's key (K-11 README default 1). Sent only as the Authorization header's bearer, to Linq's API
//                   alone (no redirect is followed); never kept, returned, logged or put in an outcome.
//
// Before any request, in this order, a check is refused (K-11 `failed`; a reason names at most the variable's name):
//   1. a request with no E.164 phone: the Linq double's answer (adapters/src/linq/double/double.ts capabilityCheck),
//      code 1002 (Linq's code for a number in another form: K-11 $defs/phone) and its words, so the adapter refuses as
//      the double does, but naming NO_PHONE as the phone (see NO_PHONE);
//   2. no key, or a key that cannot go in a header (a space, a control character or one past ASCII): no code.
//
// Then the checks, mapped to K-11's result (README 'Spike findings' row 13; T-1121's live run, FINDINGS.md answer 3):
//   check_imessage says available        checked: imessage true, and the service is the one Linq names in
//                                        selected_service, else imessage. The recorded answer to the roster iPhone holds
//                                        address and available alone, and the text that followed went by iMessage (its
//                                        chat's service iMessage, a blue bubble); the one documented answer that names
//                                        selected_service is a check that says not available (the vendor sample: not
//                                        available, selected_service RCS). So an available check is read as naming the
//                                        checked service itself (a default named in T-415's report).
//   it says not available, and names     checked: imessage false, that service (capability.json from the vendor sample;
//   a service in selected_service        fixture-only: no Android has answered a real check, Q-37)
//   it says not available, names none    check_rcs, then: the service it names, else rcs when it says available, else
//                                        null (Linq cannot tell: K-11 `service`); fixture-only (Q-37)
//   either check not answered            failed: Linq's code and the adapter's reason (./wire.ts readCheck), so the reply
//                                        goes as text alone (arch 07 line 365, DD)
// check_rcs is asked only when check_imessage says not available and names no service: otherwise its answer cannot
// change K-11's result, which has no field for RCS. checkedAt is the clock's time once the last answer came.

import type {
  CapabilityCheckChecked,
  CapabilityCheckFailed,
  CapabilityCheckOutcome,
  LinqService,
} from "./types";
import {
  CHECK_PATHS,
  LINQ_API_BASE,
  USER_AGENT,
  checkBody,
  noAnswer,
  readCheck,
  type CheckAnswer,
  type CheckName,
} from "./wire";

/** The name Linq's key is read by (K-11 README default 1). */
export const LINQ_API_TOKEN = "LINQ_API_TOKEN";

/** How long the caller keeps a checked answer: 10 minutes (K-11 cacheSeconds; arch 07 line 365). */
export const CACHE_SECONDS = 600;

/** How long each of the two requests may take before it counts as no answer, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Where LINQ_API_TOKEN is read at each call: the Worker's env. */
export interface LinqCapabilityEnv {
  readonly LINQ_API_TOKEN?: unknown;
}

export interface LinqCapabilityCheckerOptions {
  /** Where LINQ_API_TOKEN is read, by name, at each call. */
  readonly env: LinqCapabilityEnv;
  /** The HTTP call. Default: the runtime's fetch. */
  readonly fetch?: (request: Request) => Promise<Response>;
  /** The clock for checkedAt, an RFC 3339 UTC time. Default: the real clock, whole seconds. */
  readonly now?: () => string;
  /** How long each request may take, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
}

/** K-11 v1's capability check, as this adapter answers it (the Linq double answers the same call: T-411). */
export interface LinqCapabilityChecker {
  capabilityCheck(request: unknown): Promise<CapabilityCheckOutcome>;
}

/** K-11's phone: a number in E.164 form ($defs/phone). */
const PHONE = /^\+[1-9][0-9]{6,14}$/;
/** A key a header can carry: visible ASCII alone. */
const KEY_FORM = /^[\x21-\x7e]+$/;

/**
 * The phone a failed answer names when the request holds none in E.164 form: K-11's failed result must name one, and
 * none was given. The Linq double names an all-zero placeholder there (double.ts capabilityCheck), which the
 * repository's phone scan takes at the double's own file alone (infra/ci/phone-scan-exceptions.mjs), so this adapter
 * names the fiction block's first number (555-0100, no one's line) instead.
 */
export const NO_PHONE = "+15555550100";

/** The answer to a request with no E.164 phone: the Linq double's code and words (double.ts capabilityCheck). */
export const NOT_E164: Readonly<CapabilityCheckFailed> = {
  result: "failed",
  phone: NO_PHONE,
  code: "1002",
  reason: "The number is not in E.164 form.",
};

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");
const defaultFetch = (request: Request): Promise<Response> => fetch(request);

/** The request's phone when it is an E.164 number, read as the double reads it; else null. */
function phoneOf(request: unknown): string | null {
  const phone =
    typeof request === "object" && request !== null && "phone" in request ? request.phone : undefined;
  return typeof phone === "string" && PHONE.test(phone) ? phone : null;
}

function failed(phone: string, code: string | null, reason: string): CapabilityCheckFailed {
  return { result: "failed", phone, code, reason };
}

function checked(
  phone: string,
  imessage: boolean,
  service: LinqService | null,
  checkedAt: string,
): CapabilityCheckChecked {
  return { result: "checked", phone, imessage, service, checkedAt, cacheSeconds: CACHE_SECONDS };
}

export function createLinqCapabilityChecker(options: LinqCapabilityCheckerOptions): LinqCapabilityChecker {
  const now = options.now ?? defaultNow;
  const send = options.fetch ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A setup fault, found when the adapter is made rather than at a check.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("timeoutMs is not a whole number of milliseconds above 0");

  /** One check for one number: one request, read by ./wire.ts. A request that cannot be made or answered is no answer. */
  async function check(name: CheckName, phone: string, key: string): Promise<CheckAnswer> {
    let answer: Response;
    try {
      answer = await send(
        new Request(`${LINQ_API_BASE}${CHECK_PATHS[name]}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify(checkBody(phone)),
          // Never follow a redirect: the key goes to Linq's API and nowhere else.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch {
      // The error is dropped whole: its message may hold the URL or a header.
      return noAnswer(name);
    }
    let text: string;
    try {
      text = await answer.text();
    } catch {
      // The body did not come: a 2xx is then unreadable, and an error is read by its status alone.
      text = "";
    }
    return readCheck(name, answer.status, text);
  }

  return {
    async capabilityCheck(request: unknown): Promise<CapabilityCheckOutcome> {
      const phone = phoneOf(request);
      if (phone === null) return { ...NOT_E164 };

      const key = options.env.LINQ_API_TOKEN;
      if (typeof key !== "string" || key.trim() === "")
        return failed(phone, null, `${LINQ_API_TOKEN} is not set: nothing was sent.`);
      if (!KEY_FORM.test(key))
        return failed(
          phone,
          null,
          `${LINQ_API_TOKEN} holds a space or a character a header cannot carry: nothing was sent.`,
        );

      const imessage = await check("imessage", phone, key);
      if (!imessage.answered) return failed(phone, imessage.code, imessage.reason);
      if (imessage.available) return checked(phone, true, imessage.selectedService ?? "imessage", now());
      if (imessage.selectedService !== null) return checked(phone, false, imessage.selectedService, now());

      const rcs = await check("rcs", phone, key);
      if (!rcs.answered) return failed(phone, rcs.code, rcs.reason);
      return checked(phone, false, rcs.selectedService ?? (rcs.available ? "rcs" : null), now());
    },
  };
}
