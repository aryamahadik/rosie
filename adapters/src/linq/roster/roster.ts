// The staging roster allow-list in front of the real Linq line (T-416; C-210; Q-44's default: once the line serves
// staging, staging sends only to roster phones, enforced in code; build prompt 5.3, 9.4; K-11 v1 sendPart.request.to and
// README open gap 7: "C-210's allow-list in the adapter, not a port field"). It wraps, without changing them, the three
// real Linq calls that name a number: T-414's sendPart (adapters/src/linq/send), T-415's contactAdd
// (adapters/src/linq/contacts, a stub that sends nothing until CQ-354, so the guard stands before a real contacts/add
// does) and T-415's capabilityCheck (adapters/src/linq/capability). The capability check is guarded too, though it is a
// read: on staging no number off the roster goes to Linq at all (the lead's default, T-416's lead note item 4).
//
// Whether it is on: ENVIRONMENT, read by name at each call (wrangler.jsonc vars).
//   production, test  off: each call goes to the wrapped call exactly as it came, and nothing more is read (production's
//                     real line is the launch cut-over's, Q-44; a test runs on doubles).
//   staging           on.
//   anything else     on: unset, blank, another word or another spelling cannot be told from staging, so the guard
//                     fails closed (the stricter side for the line, as runtime/src/wiring/picks.ts takes the stricter
//                     side for its ports).
//
// Where it is on, it reads two more names at each call, never when it is made; no number is written in code:
//   STAGING_LINQ_ALLOWLIST  the roster: E.164 numbers joined by commas with no space (the name the T-1121 probe and
//                           .dev.vars use: DL-841, DL-919; adapters/spikes/linq-live/lib.mjs). Where staging sets it is
//                           T-572's (the release engineer).
//   ROSIE_NUMBER            Rosie's own line in E.164 form, as staging's deploy hands it to the Worker by name (T-1304;
//                           runtime/src/index.ts Env): never a destination.
// A call is refused, in this order (as the probe refuses: lib.mjs lines 245 to 258, and 274 to 300 for the line):
//   1. the roster missing, not text, empty or blank: every call (fail closed);
//   2. any entry of the roster not E.164 (+, then 7 to 15 digits: an entry with a space, an empty entry, another
//      separator...): every call, the reason naming each such entry by its place alone;
//   3. ROSIE_NUMBER missing or not E.164: every call, since Rosie's own line cannot then be told from a destination
//      (the probe refuses a run with no sending line too);
//   4. a destination that is not an E.164 number: no such number is on the roster;
//   5. a destination that is Rosie's own line, even one the roster holds;
//   6. a destination off the roster.
// Only a call past all six reaches the wrapped call, so a refused call makes no request to Linq. The destination is
// K-11's `to` for sendPart (the mobile the chat is with) and `phone` for contactAdd and capabilityCheck. The guard reads
// the request's own fields once, into a plain copy, checks that copy and hands that copy on, so the wrapped call gets the
// very number the guard passed: a getter cannot show the guard one number and the wrapped call another.
//
// A refusal is K-11 v1's failed result, built here:
//   sendPart         refused, no status, no code (the dispatcher sends a refused part again plain, arch 07 line 367,
//                    and the guard refuses that too while the roster is unchanged)
//   contactAdd       failed, not retryable, no code (a retry meets the same refusal until the roster changes)
//   capabilityCheck  failed, no code (the reply goes as text alone: arch 07 line 365)
// naming the request's phone where K-11 names one (NO_PHONE, the adapters' placeholder, when it holds none in E.164
// form). The reason names a variable at most, never a number or an entry. Each refusal writes one JSON log line (Workers
// Logs): the call, why, the roster's name and the destination as its last 2 digits at most (***01, as the probe masks);
// never a number, an entry or a key. A call that passes, and every call where the guard is off, writes nothing.

import { NO_PHONE as NO_CAPABILITY_PHONE } from "../capability";
import type { CapabilityCheckFailed, CapabilityCheckOutcome, LinqCapabilityChecker } from "../capability";
import { NO_PHONE as NO_CONTACT_PHONE } from "../contacts";
import type { ContactAddFailed, ContactAddOutcome, LinqContactRegistrar } from "../contacts";
import type { LinqSender, SendPartFailed, SendPartOutcome } from "../send";

/** The names the guard reads from the Worker's env, at each call. */
export const ENVIRONMENT = "ENVIRONMENT";
export const STAGING_LINQ_ALLOWLIST = "STAGING_LINQ_ALLOWLIST";
export const ROSIE_NUMBER = "ROSIE_NUMBER";

/** Where the guard reads its three names, by name, at each call: the Worker's env. */
export interface LinqRosterEnv {
  readonly ENVIRONMENT?: unknown;
  readonly STAGING_LINQ_ALLOWLIST?: unknown;
  readonly ROSIE_NUMBER?: unknown;
}

export interface LinqRosterOptions {
  /** Where ENVIRONMENT, STAGING_LINQ_ALLOWLIST and ROSIE_NUMBER are read, by name, at each call. */
  readonly env: LinqRosterEnv;
  /** Where a refusal's one log line goes. Default: console.log (Workers Logs). */
  readonly log?: (line: string) => void;
}

/** Why a call was refused, as its log line names it. */
export type RosterRefusal =
  "rosterMissing" | "rosterIllFormed" | "lineUnknown" | "notE164" | "ownLine" | "offRoster";

/** A guarded call, as K-11 names it. */
type GuardedCall = "sendPart" | "contactAdd" | "capabilityCheck";

/** K-11's phone ($defs/phone): the form of every roster entry, of ROSIE_NUMBER and of a destination. */
const E164 = /^\+[1-9][0-9]{6,14}$/;
/** The environments where the guard changes nothing. */
const GUARD_OFF: readonly unknown[] = ["production", "test"];
/** How many places of entries that are not E.164 a reason or a log line names; past that, how many more. */
const PLACES_NAMED = 10;

/** The guard's fixed words for each refusal; an ill-formed roster's are illFormedReason's. */
export const REASONS = {
  rosterMissing: `${STAGING_LINQ_ALLOWLIST} is not set, or is empty: on staging nothing goes to Linq for a number off that list, so nothing goes at all; nothing was sent to Linq.`,
  lineUnknown: `${ROSIE_NUMBER} is not set, or is not an E.164 number: on staging Rosie's own line must be known, since it is never a destination; nothing was sent to Linq.`,
  notE164: `The destination is not an E.164 number, so it is not on ${STAGING_LINQ_ALLOWLIST}: nothing was sent to Linq.`,
  ownLine: `The destination is Rosie's own line (${ROSIE_NUMBER}), which is never a destination: nothing was sent to Linq.`,
  offRoster: `The destination is not on ${STAGING_LINQ_ALLOWLIST}: on staging nothing goes to Linq for a number off that list; nothing was sent to Linq.`,
} as const;

/** One refusal: why, its reason, and for an ill-formed roster how many entries it holds and which are not E.164. */
interface Refused {
  readonly why: RosterRefusal;
  readonly reason: string;
  readonly entries?: number;
  /** The places (from 1) of the entries that are not E.164. */
  readonly badPlaces?: readonly number[];
}

/** The reason for a roster holding entries that are not E.164: each named by its place alone, never shown. */
function illFormedReason(badPlaces: readonly number[], entries: number): string {
  const named = badPlaces.slice(0, PLACES_NAMED).join(", ");
  const more = badPlaces.length > PLACES_NAMED ? ` and ${String(badPlaces.length - PLACES_NAMED)} more` : "";
  const which =
    badPlaces.length === 1
      ? `entry ${named} of ${String(entries)} is`
      : `entries ${named}${more} of ${String(entries)} are`;
  return `${STAGING_LINQ_ALLOWLIST}: ${which} not an E.164 number (+, then 7 to 15 digits, joined by commas with no space); no part of it is shown, and nothing was sent to Linq.`;
}

/** Why a call to `destination` is refused where the guard is on (see the top of this file), or null when it passes. */
function refusalOf(env: LinqRosterEnv, destination: unknown): Refused | null {
  const roster = env.STAGING_LINQ_ALLOWLIST;
  if (typeof roster !== "string" || roster.trim() === "")
    return { why: "rosterMissing", reason: REASONS.rosterMissing };
  const entries = roster.split(",");
  const badPlaces = entries.flatMap((entry, index) => (E164.test(entry) ? [] : [index + 1]));
  if (badPlaces.length > 0)
    return {
      why: "rosterIllFormed",
      reason: illFormedReason(badPlaces, entries.length),
      entries: entries.length,
      badPlaces,
    };
  const line = env.ROSIE_NUMBER;
  if (typeof line !== "string" || !E164.test(line))
    return { why: "lineUnknown", reason: REASONS.lineUnknown };
  if (typeof destination !== "string" || !E164.test(destination))
    return { why: "notE164", reason: REASONS.notE164 };
  if (destination === line) return { why: "ownLine", reason: REASONS.ownLine };
  if (!entries.includes(destination)) return { why: "offRoster", reason: REASONS.offRoster };
  return null;
}

/**
 * The request's own fields, read once into a plain object (each getter runs once), which the guard checks and hands on;
 * null for anything that is not an object with fields (null, text, a number, a list), or whose fields cannot be read.
 */
function fieldsOf(request: unknown): Record<string, unknown> | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
  try {
    return { ...(request as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** A destination as the log line shows it: its last 2 digits at most (***01), as the probe masks (lib.mjs masked). */
function masked(destination: unknown): string {
  const digits = typeof destination === "string" ? destination.replace(/[^0-9]/g, "") : "";
  return `***${digits.slice(-2)}`;
}

/** A refusal's one log line: fixed labels, the list's name and the masked destination; never a number or an entry. */
function refusalLine(
  call: GuardedCall,
  environment: unknown,
  refused: Refused,
  destination: unknown,
): string {
  const places = refused.badPlaces;
  return JSON.stringify({
    level: "warn",
    msg: "linqRosterRefused",
    environment: environment === "staging" ? "staging" : "unknown",
    call,
    why: refused.why,
    list: STAGING_LINQ_ALLOWLIST,
    destination: masked(destination),
    ...(places === undefined
      ? {}
      : { entries: refused.entries, badEntries: places.slice(0, PLACES_NAMED), badCount: places.length }),
  });
}

const writeLine = (line: string): void => {
  console.log(line);
};

/** The request's phone where it is an E.164 number, else the adapter's placeholder (K-11's failed result names one). */
const phoneOr = (destination: unknown, placeholder: string): string =>
  typeof destination === "string" && E164.test(destination) ? destination : placeholder;

/** One guarded call: its name, the request field its destination is in, the wrapped call and its refusal. */
interface Guarded<Outcome> {
  readonly call: GuardedCall;
  readonly field: "to" | "phone";
  readonly wrapped: (request: unknown) => Promise<Outcome>;
  readonly refused: (reason: string, destination: unknown) => Outcome;
}

async function guarded<Outcome>(
  options: LinqRosterOptions,
  guard: Guarded<Outcome>,
  request: unknown,
): Promise<Outcome> {
  const environment = options.env.ENVIRONMENT;
  if (GUARD_OFF.includes(environment)) return await guard.wrapped(request);
  const fields = fieldsOf(request);
  const destination = fields === null ? undefined : fields[guard.field];
  const refused = refusalOf(options.env, destination);
  // Past every check, the destination is an E.164 number read from `fields`, the copy the wrapped call gets.
  if (refused === null) return await guard.wrapped(fields);
  (options.log ?? writeLine)(refusalLine(guard.call, environment, refused, destination));
  return guard.refused(refused.reason, destination);
}

/** T-414's sender (createLinqSender), guarded: on staging, a part to a number off the roster is refused before Linq. */
export function guardLinqSender(sender: LinqSender, options: LinqRosterOptions): LinqSender {
  const guard: Guarded<SendPartOutcome> = {
    call: "sendPart",
    field: "to",
    wrapped: (request) => sender.sendPart(request),
    refused: (reason): SendPartFailed => ({
      result: "failed",
      kind: "refused",
      httpStatus: null,
      code: null,
      reason,
      retryAfterSeconds: null,
      providerMessageId: null,
    }),
  };
  return { sendPart: (request) => guarded(options, guard, request) };
}

/** T-415's registrar (createLinqContactRegistrar), guarded: on staging, a number off the roster is never added. */
export function guardLinqContactRegistrar(
  registrar: LinqContactRegistrar,
  options: LinqRosterOptions,
): LinqContactRegistrar {
  const guard: Guarded<ContactAddOutcome> = {
    call: "contactAdd",
    field: "phone",
    wrapped: (request) => registrar.contactAdd(request),
    refused: (reason, destination): ContactAddFailed => ({
      result: "failed",
      phone: phoneOr(destination, NO_CONTACT_PHONE),
      retryable: false,
      code: null,
      reason,
    }),
  };
  return { contactAdd: (request) => guarded(options, guard, request) };
}

/** T-415's capability check (createLinqCapabilityChecker), guarded: on staging, no number off the roster is asked about. */
export function guardLinqCapabilityChecker(
  checker: LinqCapabilityChecker,
  options: LinqRosterOptions,
): LinqCapabilityChecker {
  const guard: Guarded<CapabilityCheckOutcome> = {
    call: "capabilityCheck",
    field: "phone",
    wrapped: (request) => checker.capabilityCheck(request),
    refused: (reason, destination): CapabilityCheckFailed => ({
      result: "failed",
      phone: phoneOr(destination, NO_CAPABILITY_PHONE),
      code: null,
      reason,
    }),
  };
  return { capabilityCheck: (request) => guarded(options, guard, request) };
}
