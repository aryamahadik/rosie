// Linq's wire format for the two capability checks (T-415; C-209), kept in this folder (K-11 README: "Linq's paths,
// headers, field names and codes stay inside the adapter"; 02-contracts section 5). Sources: K-11 README 'Spike findings'
// rows 1 (the API base and a bearer token), 6 (Linq's service names iMessage, RCS and SMS), 13 (POST
// /capability/check_imessage and /capability/check_rcs with {address}, answering available, reason (not_supported) and
// selected_service) and 14 (the error body: {success: false, error: {status, code, message, doc_url}, trace_id}); its
// vendor samples capability-check-request.json and capability-check-imessage-response.json; and T-1121's live run of
// Nov 17 (adapters/spikes/linq-live/samples/live-2026-11-17T00-27-34Z-01-capability-check_imessage.json and
// -02-capability-check_rcs.json; FINDINGS.md answer 3 and vendor fact 3), where both checks answered the roster iPhone 200
// with address and available alone: no reason and no selected_service.
//
// One check's request: POST <LINQ_API_BASE><path>, the body {"address": <the E.164 number>}, with the headers
// Authorization (Bearer and the key), Content-Type and Accept (application/json, as the live probe sent them) and
// User-Agent (a plain name, no contact).
//
// One check's answer, read by readCheck into what the adapter's flow needs (./capability.ts):
//   2xx with a boolean `available`   answered: `available`, and the service Linq names in `selected_service` (iMessage,
//                                    RCS or SMS, in any case), else none. `address` and `reason` are not read: the
//                                    address is the request's own (the recorded answers mask it), and K-11 has no field
//                                    for the reason.
//   429                              not answered: Linq's rate limit, with Linq's error code (1007) as the code
//   any other 4xx                    not answered: refused, with Linq's error code
//   5xx                              not answered: a server error, with Linq's error code
//   anything else                    not answered, no code: an answer the adapter cannot read (1xx, 3xx, a 2xx that is
//                                    not JSON or holds no boolean available)
// The code is Linq's error.code as text, or null when it gave none. The reason is the adapter's own fixed words for each
// case, never Linq's message, so it holds no key and no number.

import type { LinqService } from "./types";

/** Linq's partner API (README 'Spike findings' row 1; the live run's paths start /api/partner/v3). */
export const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";
/** iMessage capability for one address (README row 13). */
export const CHECK_IMESSAGE_PATH = "/capability/check_imessage";
/** RCS capability for one address (README row 13). */
export const CHECK_RCS_PATH = "/capability/check_rcs";
/** The client name sent as User-Agent: a plain name, no contact. */
export const USER_AGENT = "rosie-linq-adapter/1";

/** Which of Linq's two checks. */
export type CheckName = "imessage" | "rcs";

/** The path of each check. */
export const CHECK_PATHS: Readonly<Record<CheckName, string>> = {
  imessage: CHECK_IMESSAGE_PATH,
  rcs: CHECK_RCS_PATH,
};

/** A check's body, as Linq takes it (vendor sample capability-check-request.json). */
export interface CheckBody {
  address: string;
}

/** The body of one check for a number. */
export function checkBody(phone: string): CheckBody {
  return { address: phone };
}

/** One check's answer: what Linq said, or why there is nothing to read. */
export type CheckAnswer =
  | { readonly answered: true; readonly available: boolean; readonly selectedService: LinqService | null }
  | { readonly answered: false; readonly code: string | null; readonly reason: string };

/** Each check's name in a reason. */
const SHOWN: Readonly<Record<CheckName, string>> = { imessage: "iMessage", rcs: "RCS" };

/** The adapter's fixed words for each case, by check. */
export const REASONS = {
  noAnswer: (check: CheckName): string =>
    `No answer came to the ${SHOWN[check]} check: a timeout or a network error.`,
  unreadable: (check: CheckName): string => `Linq's answer to the ${SHOWN[check]} check could not be read.`,
  rateLimited: (check: CheckName): string => `Linq's rate limit: the ${SHOWN[check]} check was not answered.`,
  refused: (check: CheckName): string => `Linq refused the ${SHOWN[check]} check.`,
  serverError: (check: CheckName): string => `A server error at Linq answered the ${SHOWN[check]} check.`,
} as const;

/** Linq's service names (README row 6), in any case, as K-11 names them. */
const SERVICES: Readonly<Record<string, LinqService>> = { imessage: "imessage", rcs: "rcs", sms: "sms" };

/** The service a `selected_service` value names, or null for a missing or unknown one. */
export function serviceOf(value: unknown): LinqService | null {
  return typeof value === "string" ? (SERVICES[value.toLowerCase()] ?? null) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** Linq's error code (README row 14: error.code) as text, when it is a whole number; else null. */
export function codeOf(body: unknown): string | null {
  const code = field(field(body, "error"), "code");
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) return String(code);
  if (typeof code === "string" && /^[0-9]{1,9}$/.test(code)) return code;
  return null;
}

const unanswered = (code: string | null, reason: string): CheckAnswer => ({ answered: false, code, reason });

/** The answer when no answer came: a timeout or a network error. */
export const noAnswer = (check: CheckName): CheckAnswer => unanswered(null, REASONS.noAnswer(check));

/** One check's answer, by its HTTP status and body text (see the top of this file). */
export function readCheck(check: CheckName, status: number, text: string): CheckAnswer {
  const body = parseJson(text);
  if (status >= 200 && status <= 299) {
    const available = field(body, "available");
    return typeof available === "boolean"
      ? { answered: true, available, selectedService: serviceOf(field(body, "selected_service")) }
      : unanswered(null, REASONS.unreadable(check));
  }
  const code = codeOf(body);
  if (status === 429) return unanswered(code, REASONS.rateLimited(check));
  if (status >= 400 && status <= 499) return unanswered(code, REASONS.refused(check));
  if (status >= 500 && status <= 599) return unanswered(code, REASONS.serverError(check));
  return unanswered(null, REASONS.unreadable(check));
}
