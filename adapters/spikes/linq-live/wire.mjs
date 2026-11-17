// Linq's wire, as far as the repository records it, for the outbound probe (T-1121; K-11 v1). Only the probe and its
// local stand-in read this file: the vendor's format stays inside adapters/ (Depends on: T-020), and the probe names each
// answer in the port's own terms (readCapability, readContactAdd, readSend).
//
// Sources: contracts/port-linq/README.md "Spike findings" rows 1 (the API base, a bearer token; a first send by number),
// 10 (the send body: message.parts, message.idempotency_key, top-level override_optout), 13 (the capability checks) and
// 14 (the error body and codes), its "Outcomes of a send" table, its open gap 1 (no documented contacts/add), and the
// recorded vendor samples in contracts/port-linq/vendor-samples/. Round 2 (Nov 17; DL-918 to DL-920; FINDINGS.md):
// CHAT_CREATE_PATH and chatCreateBody are confirmed by Linq's create-chat page and the live runs (samples/), while
// CONTACT_ADD_PATH and contactAddBody stay a placeholder, since Linq's v3 API has no contacts/add (K-11 open gap 1).

/** Linq's API host: the live run's only origin (README spike row 1). */
export const LINQ_ORIGIN = "https://api.linqapp.com";

/** The partner API's path on that host (README spike row 1). The local stand-in serves the same paths. */
export const API_PATH = "/api/partner/v3";

/** iMessage capability for one address (README spike row 13): available, reason, selected_service. */
export const CHECK_IMESSAGE_PATH = "/capability/check_imessage";

/** RCS capability for one address (README spike row 13). */
export const CHECK_RCS_PATH = "/capability/check_rcs";

/**
 * contacts/add. TODO(K-11 open gap 1, for the architect; T-415): Linq's v3 API has no such call. Its API reference
 * (docs.linqapp.com/api/, read by the lead Nov 17, DL-919) has no contacts resource and no contacts/add; the closest
 * are POST /v3/chats/{chatId}/participants, POST /v3/chats and the contact card. A send by number needed no add first:
 * the live send was accepted (201, samples/live-2026-11-17T00-27-34Z-03-send-send.json). So this path and
 * contactAddBody are a placeholder that only the dry run's stand-in answers, and no live run took the contact step.
 * The Nov 5 kit's `linq contacts add` (Linq's command-line tool) and v2's CRM-style POST /api/partner/v2/contacts, with
 * another auth header, stay unconfirmed; the architect rules what T-415's contacts/add becomes.
 */
export const CONTACT_ADD_PATH = "/contacts";

/**
 * A send by number, Linq's create-chat call. Confirmed in round 2 (Nov 17, DL-918 to DL-920): Linq's create-chat page
 * (docs.linqapp.com/api/resources/chats/methods/create/) gives POST /v3/chats with from, to (a list), message.parts (a
 * text part), message.idempotency_key and override_optout, the body chatCreateBody builds, and says a first message in
 * a new chat may not be a link (400, code 1005); the probe's words hold none. The live send was accepted (201,
 * samples/live-2026-11-17T00-27-34Z-03-send-send.json). Its answer is the chat, with the message under it
 * (chat.message, beside chat.service, chat.handles and chat.health_status), not at the top as a send into a chat
 * answers (vendor sample send-message-response.json); and the chat was the one the line already had with that phone
 * (the same chat id in both live runs). Rosie's product never opens a chat (arch 07 line 369); only this probe does,
 * to reach the one test phone.
 */
export const CHAT_CREATE_PATH = "/chats";

/** The body of a capability check (README spike row 13; vendor sample capability-check-request.json). */
export function capabilityBody(address) {
  return { address };
}

/** The body of contacts/add: a placeholder, since Linq's v3 API has no contacts/add (see CONTACT_ADD_PATH). */
export function contactAddBody(phone) {
  return { phone_number: phone };
}

/**
 * The body of a send by number: one text part, its idempotency key (Linq dedupes by it: README row 10), and
 * override_optout for that one request. Confirmed by Linq's create-chat page and the live runs (see CHAT_CREATE_PATH).
 */
export function chatCreateBody({ from, to, text, idempotencyKey, overrideOptout }) {
  return {
    from,
    to: [to],
    message: { parts: [{ type: "text", value: text }], idempotency_key: idempotencyKey },
    override_optout: overrideOptout,
  };
}

/** Linq's service names in K-11's terms (README spike row 6: iMessage, RCS, SMS), else null. */
export function serviceOf(value) {
  if (value === "iMessage") return "imessage";
  if (value === "RCS") return "rcs";
  if (value === "SMS") return "sms";
  return null;
}

/** An error body's code as text (README spike row 14: error.code), else null. */
export function codeOf(body) {
  const code = body !== null && typeof body === "object" ? body.error?.code : undefined;
  return typeof code === "number" || typeof code === "string" ? String(code) : null;
}

const isSuccess = (status) => status !== null && status >= 200 && status < 300;

/**
 * A capability check's answer in K-11's capabilityCheck terms: checked, with what the check says and the service a
 * message would go by (selected_service), or failed. `which` is imessage or rcs: K-11 has no RCS field, so the RCS
 * check's answer is the probe's own reading beside it.
 */
export function readCapability(which, status, body) {
  if (isSuccess(status) && body !== null && typeof body === "object" && typeof body.available === "boolean") {
    return {
      call: "capabilityCheck",
      check: which,
      result: "checked",
      available: body.available,
      reason: typeof body.reason === "string" ? body.reason : null,
      service: serviceOf(body.selected_service),
    };
  }
  return { call: "capabilityCheck", check: which, result: "failed", httpStatus: status, code: codeOf(body) };
}

/**
 * contacts/add's answer in K-11's contactAdd terms, read from the status alone (no live answer exists: Linq's v3 API
 * has no contacts/add, see CONTACT_ADD_PATH): added, or failed, retryable for a server error or no answer (K-11:
 * `failed` with `retryable`).
 */
export function readContactAdd(status, body) {
  if (isSuccess(status)) return { call: "contactAdd", result: "added", alreadyContact: null };
  return {
    call: "contactAdd",
    result: "failed",
    retryable: status === null || status >= 500 || status === 429,
    httpStatus: status,
    code: codeOf(body),
  };
}

/**
 * A send's answer in K-11's sendPart terms (README "Outcomes of a send"): accepted, with the service Linq reports, or
 * failed by kind: optedOut (403 with code 2024), mayStillDeliver (4001 or 4006), rateLimited (429, Linq's 1007, with
 * retry_after), transient (a server error or no answer), refused (any other request error).
 */
export function readSend(status, body) {
  if (isSuccess(status)) {
    const message = body !== null && typeof body === "object" ? body.message : undefined;
    const service = message !== null && typeof message === "object" ? message.service : undefined;
    return { call: "sendPart", result: "accepted", service: serviceOf(service) };
  }
  const code = codeOf(body);
  const failed = (kind, extra = {}) => ({
    call: "sendPart",
    result: "failed",
    kind,
    httpStatus: status,
    code,
    ...extra,
  });
  if (status === 403 && code === "2024") return failed("optedOut");
  if (code === "4001" || code === "4006") return failed("mayStillDeliver");
  if (status === 429 || code === "1007") {
    const after = body?.error?.retry_after;
    return failed("rateLimited", { retryAfterSeconds: typeof after === "number" ? after : null });
  }
  if (status === null || status >= 500) return failed("transient");
  return failed("refused");
}
