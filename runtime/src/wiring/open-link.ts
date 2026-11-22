// Staging's openLink: a signed link's server side (T-1534; S1-10 slice card S10-8; K-21 v1 openLink; K-09 README
// defaults 211 to 213 and open gap 201; T-728's security note e; DL-1130, DL-1153). The root joins it on staging only,
// beside the sign-in calls (./root.ts joinedPages; RootOptions.openLink); anywhere else openLink stays unconfigured (503).
//
// One request, in default 212's order:
//   1. The request must be K-21 v1's openLink.request (a linkPage envelope), or the handler throws (503) with nothing
//      hashed or read. Then the code's made form, before any hash or read: exactly 32 lowercase hexadecimal characters
//      (default 211's code, T-728 note e). Any other code answers linkExpired, the one answer an unknown code gets, so a
//      seeded stand-in code, whose text is public, never opens a page.
//   2. The code's sha256 (UTF-8, 64 lowercase hex, as page_links.code_sha256 holds it) asks K-22 v1.1 page_link_for_code
//      on the runtime side; no row answers linkExpired. Only a setup_id_check link of S1-10 is served on this slice: a
//      live link of any other kind throws (503), since no page of its kind is built here.
//   3. S1-10's keys: the port answers whether all of S1-10's gives (id_checked and mobile) are given for the link's person;
//      given answers linkExpired (K-21 default 19). Staging binds it to "not given" (KEYS_NOT_GIVEN, which reads nothing)
//      until open gap 201's reads are frozen: nothing on staging writes an id_uploads row, so no link's keys are all given.
//   4. A session token that came is checked by K-22 v1 session_for_token (its sha256, on the runtime side); the call acts
//      for the session's person only when that person is the link's own. With no session, or another person's, proof is
//      none and it acts for no one: a link is never the proof (K-21 "A link is never the proof"; S13-45).
//   5. The answer: setupIdCheck, S1-10, the business's public name (businesses.display_name, else name), idUpload alone
//      (D5: the owner's email is left off), securePageOnly false (nothing secure is on the page while the upload is not
//      open), both sign-in ways with proof none, and the link's expiresAt.
// Each read opens its client and ends it before the next read opens one (ADR-014; ./sign-in.ts's calls), so a call holds
// 1 connection at a time; openLink takes no GATE_CLIENTS_AT_ONCE slot.
//
// Never logged, put in a span or in an error: the code, its hash, a session token or its hash, the link's person, the
// session's person, the business or the link's id. This file writes no line of its own; an error carries a fixed label
// (OpenLinkError.reason, a read's call name and a SQLSTATE) and nothing from the request or a row.

import { sha256Hex } from "@rosie/actions/src/domain/proof-codes/index";
import { scrubbed } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";

import type { PageHandler, PageOutcome } from "../gateway/pages";
import { environmentOf } from "./picks";
import type { StagingDb, StagingPart } from "./staging/part";

/** Default 211's made form: 16 random bytes as 32 lowercase hexadecimal characters, the one form a made code has. */
export const MADE_CODE = /^[0-9a-f]{32}$/u;

/** K-21 v1 `linkCode`: what the request's code must be for the request to be openLink's at all. */
const LINK_CODE = /^[A-Za-z0-9-]{3,64}$/u;
/** common/formats.v1 `id`: a string with a character that is not a line end. */
const ID = /./u;
/** K-21 v1 `opaqueToken`'s lengths. */
const TOKEN_LENGTH = { min: 16, max: 512 } as const;
const REQUEST_FIELDS = ["page"] as const;
const PAGE_FIELDS = ["requestId", "traceId", "sessionToken", "linkCode"] as const;

/** K-21 v1's one answer for an unknown, lapsed or ended link, and for a setup link whose step has given its keys. */
export const LINK_EXPIRED: PageOutcome = Object.freeze({ error: "linkExpired" });

/** The one link this slice serves: S1-10's setup_id_check (K-22 v1.1 page_links_purpose_step) and its page. */
export const SETUP_ID_CHECK = Object.freeze({
  purpose: "setup_id_check",
  stepId: "S1-10",
  pageKind: "setupIdCheck",
  sections: Object.freeze(["idUpload"] as const),
});

/** Both sign-in ways, always offered with proof none, so the page hints at nothing on file (K-21 openLink.signIn). */
export const SIGN_IN_WAYS = Object.freeze(["text", "email"] as const);

/** A live link as page_link_for_code answers it: never its code or hash. */
export interface LiveLink {
  readonly businessId: string;
  readonly personId: string;
  readonly purpose: string;
  readonly stepId: string;
  /** page_links.expires_at, in UTC ending in Z. */
  readonly expiresAt: string;
}

/**
 * What staging's openLink reads, each on a client of its own (RootOptions.openLink): the trace id names the line each
 * read's timing goes on. A read that cannot be made throws, and the page entry answers 503.
 */
export interface OpenLinkInputs {
  /** K-22 v1.1 page_link_for_code by the code's sha256, at the database's now: the live link, or null for none. */
  readonly link: (codeSha256: string, traceId: string) => Promise<LiveLink | null>;
  /**
   * Whether all of S1-10's gives (id_checked, mobile) are given for the link's person (default 212 (3)). Staging binds
   * KEYS_NOT_GIVEN until open gap 201's reads are frozen.
   */
  readonly keysGiven: (personId: string, traceId: string) => Promise<boolean>;
  /** K-22 v1 session_for_token by the token's sha256, at the database's now: the live session's person, or null. */
  readonly sessionPerson: (tokenSha256: string, traceId: string) => Promise<string | null>;
  /** The business's public name: businesses.display_name, else name; null when neither holds a word. */
  readonly businessName: (businessId: string, traceId: string) => Promise<string | null>;
}

/** Why openLink gave no outcome: a label, never a value. */
export type OpenLinkRefusal = "badRequest" | "pageNotServed" | "noBusinessName";

const REFUSAL_WORDS: Readonly<Record<OpenLinkRefusal, string>> = {
  badRequest: "the request is not K-21 v1's openLink.request",
  pageNotServed: "the link opens a page this slice does not serve",
  noBusinessName: "the link's business has no public name",
};

/** openLink gave no outcome (the page entry answers 503): its reason is a label, and its message names no value. */
export class OpenLinkError extends Error {
  override name = "OpenLinkError";
  readonly reason: OpenLinkRefusal;

  constructor(reason: OpenLinkRefusal) {
    super(`openLink: ${REFUSAL_WORDS[reason]}`);
    this.reason = reason;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The object's own value for a field, never one it inherits. */
const own = (value: Record<string, unknown>, field: string): unknown =>
  Object.hasOwn(value, field) ? value[field] : undefined;

/** Characters as Ajv counts them for minLength and maxLength: code points. */
const lengthOf = (text: string): number => Array.from(text).length;

/**
 * Problems K-21 v1 finds in an openLink.request (its page a linkPage: the code required); none when it is one. A problem
 * names a field, never a value.
 */
export function openLinkProblems(request: unknown): string[] {
  if (!isRecord(request)) return ["the request is not an object"];
  const problems: string[] = [];
  if (Object.keys(request).some((key) => !(REQUEST_FIELDS as readonly string[]).includes(key)))
    problems.push("the request has a field K-21 v1 does not name");
  const page = own(request, "page");
  if (!isRecord(page)) return [...problems, "page is not an object"];
  if (Object.keys(page).some((key) => !(PAGE_FIELDS as readonly string[]).includes(key)))
    problems.push("page has a field K-21 v1 does not name");
  const requestId = own(page, "requestId");
  if (!(typeof requestId === "string" && ID.test(requestId))) problems.push("page.requestId is not an id");
  const traceId = own(page, "traceId");
  if (!(typeof traceId === "string" && ID.test(traceId))) problems.push("page.traceId is not a trace id");
  const token = own(page, "sessionToken");
  if (
    token !== null &&
    !(typeof token === "string" && lengthOf(token) >= TOKEN_LENGTH.min && lengthOf(token) <= TOKEN_LENGTH.max)
  )
    problems.push("page.sessionToken is not a session token or null");
  const code = own(page, "linkCode");
  if (!(typeof code === "string" && LINK_CODE.test(code))) problems.push("page.linkCode is not a link code");
  return problems;
}

/** True when `code` is in default 211's made form: exactly 32 lowercase hexadecimal characters. */
export function isMadeCode(code: string): boolean {
  return MADE_CODE.test(code);
}

/** staging's openLink handler over its reads (see the top of this file). */
export function openLinkPage(inputs: OpenLinkInputs): PageHandler {
  return async (page) => {
    // 1. K-21's request, then the made form: no hash and no read before both.
    if (openLinkProblems(page.request).length > 0) throw new OpenLinkError("badRequest");
    const envelope = page.request.page as {
      readonly sessionToken: string | null;
      readonly linkCode: string;
    };
    if (!isMadeCode(envelope.linkCode)) return LINK_EXPIRED;
    const traceId = page.trace.traceId;

    // 2. The live link by the code's sha256.
    const link = await inputs.link(await sha256Hex(envelope.linkCode), traceId);
    if (link === null) return LINK_EXPIRED;
    if (link.purpose !== SETUP_ID_CHECK.purpose || link.stepId !== SETUP_ID_CHECK.stepId)
      throw new OpenLinkError("pageNotServed");

    // 3. S1-10's keys, all given: the link has done its work.
    if (await inputs.keysGiven(link.personId, traceId)) return LINK_EXPIRED;

    // 4. Proof only from a session of the link's own person.
    const sessionPerson =
      envelope.sessionToken === null
        ? null
        : await inputs.sessionPerson(await sha256Hex(envelope.sessionToken), traceId);
    const proven = sessionPerson !== null && sessionPerson === link.personId;

    // 5. The answer.
    const businessName = await inputs.businessName(link.businessId, traceId);
    if (businessName === null) throw new OpenLinkError("noBusinessName");
    return {
      result: "open",
      pageKind: SETUP_ID_CHECK.pageKind,
      stepId: SETUP_ID_CHECK.stepId,
      businessName,
      proof: proven ? "session" : "none",
      acting: proven ? { personId: link.personId } : null,
      securePageOnly: false,
      sections: [...SETUP_ID_CHECK.sections],
      signIn: proven ? null : { ways: [...SIGN_IN_WAYS] },
      expiresAt: link.expiresAt,
    };
  };
}

// ---- staging's reads --------------------------------------------------------------------------------------------------

/** Each read's name on the handle: on its timing line, and on every error that leaves it. Labels. */
export const OPEN_LINK_CALLS = Object.freeze({
  pageLinkForCode: "pageLinkForCode",
  sessionForToken: "sessionForToken",
  businessName: "businessName",
} as const);

/** Default 212 (3)'s binding on staging: S1-10's keys are never all given here, and nothing is read for it. */
export const KEYS_NOT_GIVEN: OpenLinkInputs["keysGiven"] = () => Promise.resolve(false);

/** A timestamptz as postgres.js gives it (a Date), in UTC ending in Z, whole seconds without their fraction. */
function utcOf(value: unknown): string {
  const at = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(at.getTime())) throw new TypeError("page_link_for_code answered a time that is not one");
  return at.toISOString().replace(/\.000Z$/u, "Z");
}

/** A word a name holds, or null when it holds none. */
const wordsOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** One read on its own runtime-side client of the root's handle, its throw scrubbed to the call's name and a SQLSTATE. */
async function onRuntime<T>(
  db: StagingDb,
  call: string,
  fn: (sql: Sql) => Promise<T>,
  traceId: string,
): Promise<T> {
  try {
    return await db.runtime(call, fn, traceId);
  } catch (error) {
    throw scrubbed(call, error);
  }
}

/**
 * Staging's openLink reads over the root's handle (open gap 201's, named here: default in use), each on the runtime
 * side (rosie_worker_job, which inherits rosie_job: EXECUTE on page_link_for_code and session_for_token, and the
 * businesses row with no scope, migration 0012), on a client of its own, ended before the next read opens one. S1-10's
 * keys are KEYS_NOT_GIVEN. Reads nothing as it is made.
 */
export function stagingOpenLinkReads(db: StagingDb): OpenLinkInputs {
  const calls = OPEN_LINK_CALLS;
  return {
    async link(codeSha256, traceId) {
      const rows = await onRuntime(
        db,
        calls.pageLinkForCode,
        (sql) => sql<
          {
            business_id: string;
            person_id: string;
            purpose: string;
            step_id: string;
            expires_at: unknown;
          }[]
        >`
          select business_id, person_id, purpose, step_id, expires_at
            from page_link_for_code(${codeSha256}, now())
        `,
        traceId,
      );
      const [row] = rows;
      if (row === undefined) return null;
      return {
        businessId: row.business_id,
        personId: row.person_id,
        purpose: row.purpose,
        stepId: row.step_id,
        expiresAt: utcOf(row.expires_at),
      };
    },
    keysGiven: KEYS_NOT_GIVEN,
    async sessionPerson(tokenSha256, traceId) {
      const rows = await onRuntime(
        db,
        calls.sessionForToken,
        (sql) => sql<{ person_id: string }[]>`
          select person_id from session_for_token(${tokenSha256}, now())
        `,
        traceId,
      );
      return rows[0]?.person_id ?? null;
    },
    async businessName(businessId, traceId) {
      const rows = await onRuntime(
        db,
        calls.businessName,
        (sql) => sql<{ display_name: unknown; name: unknown }[]>`
          select display_name, name from businesses where id = ${businessId}
        `,
        traceId,
      );
      const [row] = rows;
      if (row === undefined) return null;
      return wordsOf(row.display_name) ?? wordsOf(row.name);
    },
  };
}

const isBound = (binding: unknown): boolean => typeof binding === "object" && binding !== null;

/**
 * RootOptions.openLink for the Worker: staging's reads over the root's handle where ENVIRONMENT is staging and
 * HYPERDRIVE_JOB is bound (checked in that order, so no binding is read anywhere else); null otherwise, and openLink
 * stays unconfigured (503). Reads nothing else as it is made: the handle reads the binding's string at each call.
 */
export function stagingOpenLink(part: StagingPart): OpenLinkInputs | null {
  if (environmentOf(part.env) !== "staging" || !isBound(part.env.HYPERDRIVE_JOB)) return null;
  return stagingOpenLinkReads(part.db);
}
