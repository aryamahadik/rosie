// Data-access v1.11: the handle's party for a turn (K-05 v1.11 item 52; T-1269, the D-017 path audit's D1a; DL-499,
// DL-511; QUESTIONS.md CQ-220). Its callers are the handle actor's turn and its park (C-046, C-180), through the turn's
// directory (runtime/src/turn/types.ts TurnDirectory.partyOf; the seam runtime/src/wiring/real.ts holds for it,
// StateReadInputs.turnDirectory), which the runtime engineer's own card binds.
//
//   readTurnParty  from the handle a turn's texts came from (K-06 v1 handle: its kind and its address), the handle's K-04
//                  id, the business the turn's calls run under, the person and the zone its texts' dates resolve in. In
//                  one read-only transaction it reads, in item 52's order:
//                    1. the handle, by the request's address (handles_address_key): its id and kind. None, or one of
//                       another kind, answers unknown, every field null (default 96), and nothing more is read;
//                    2. its people (person_handles by handle_id, in person_id order): personId is the one person when
//                       there is exactly one, else null (default 97);
//                    3. their roles (person_roles by person_id), live or ended: each one's business, role and ended_at;
//                    4. their companies (companies by owner_person_id): each one's business, null for none yet;
//                    5. for the businesses their companies name, the live owner roles there and whose they are
//                       (person_roles by business_id, role owner, ended_at null: person_roles_business_role_idx);
//                    6. the zone of the one business it answers (businesses.time_zone by id).
//                  The scopes the rows name are the business of each live role of the handle's people (live is
//                  ended_at null: a role whose ended_at is set is ended, whatever its time, default 98) and the business
//                  of each company they own, a company with no business yet naming "no business yet". The answer is
//                  default 100's rule, the first case that applies:
//                    anotherOwner       (businessUndecided) a company one of them owns names a business whose live
//                                       owner role is held by a person who does not write from the handle (default 99;
//                                       default 1 below);
//                    roleEnded          (businessUndecided) a company one of them owns names a business at which none
//                                       of them holds the live owner role and one of them holds a role that ended
//                                       (default 99);
//                    severalBusinesses  (businessUndecided) the scopes are more than one: live roles or companies at two
//                                       businesses or more, or a business beside a company with no business yet
//                                       (default 98);
//                    atBusiness         the scopes are one business: the turn runs under it, with its zone;
//                    noBusiness         there is no scope, or the only one is "no business yet": no business and no
//                                       zone, which the consumer reads as UTC (defaults 98 and 101).
//                  The reasons are checked in that order over every business the companies name, so a reason is named
//                  by default 100's order, never by which business sorts first.
//
// Role and scope (item 52; K-04 v1 rule 4: the jobs that work across businesses by handle). The read runs on the client it
// is handed, the runtime side's, as rosie_job (the role is the connection's: nothing here checks it), in one read-only
// transaction at repeatable read on the primary, uncached (targets.ts inRuntimeTransaction, which clears the business
// scope at its start), so the answer is one moment's and nothing is written. It uses no definer function and no table
// owner's rights: rosie_job reads handles and person_handles through its own grants (0012), and every business's
// person_roles, businesses and companies behind their runtime policies, which with no scope show every row, a company
// with no business yet included (0012, 0019; K-23 README rule 5). rosie_app, the Tool API's role, holds no grant on
// handles (0012), so its call is refused by PostgreSQL's privilege check (42501, thrown as DataAccessDatabaseError).
//
// What it reads and answers (item 52's consumers line: "What the new tasks must hold to"; default 102). Each statement
// reads one table, joins none and selects no `*` and no whole row: handles.id and kind (never the address back: the
// address is the request's, bound as step 1's one parameter and named nowhere else), person_handles.person_id,
// person_roles.business_id, person_id, role and ended_at, companies.business_id and businesses.time_zone, and no other
// column. No statement names sealing_keys, phones, threads, messages, bookings or consents. The answer is a party (the
// handle's id, one business or none, the person or none, that business's zone or none) or an undecided business's reason
// with the handle's id and the person: never the address, a role, a company, another business, another person or the
// businesses found. The integration test reads every statement the read sends and checks it.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with only its SQLSTATE. Any other database error is thrown scrubbed, as DataAccessDatabaseError with its
// SQLSTATE and names alone (clocks.ts transientOrScrubbed: PostgreSQL's own error can hold a row's values). A request of
// the wrong shape throws a TypeError before any statement is sent, and a record the answer would have to guess around a
// BrokenRecordError (default 3); each names the call, a field or a rule, never a value or an id. Nothing here logs, and
// nothing is written on any of them.
//
// Defaults used (for ops/QUESTIONS.md; each where no source decides):
//   1. Two live owner roles at a company's business, one of them held by one of the handle's people (the lead's note,
//      DL-511, from T-1249's security review, note a): anotherOwner, the closed reading. Item 52's anotherOwner ("a live
//      owner role is held by a person who does not write from the handle") and default 99's last sentence ("A company
//      whose business's live owner role one of the handle's people holds agrees with that role and is not checked
//      further") read differently here; the read takes item 52's wording, as v1.4 default 61's moreThanOneOwner fails
//      closed. The architect names the case at K-05's next minor version (CQ-235).
//   2. A request is refused before any statement for its shape alone: a field beside the handle
//      (refuse-turn-party-caller-business), a handle with another field, a kind that is neither phone nor email, or an
//      address in neither of K-06 v1's two forms (an E.164 number, or an email address in lower case). An address in the
//      other kind's form (an E.164 number named as an email handle, an email address named as a phone) is not refused:
//      it reaches step 1, where the stored handle's kind differs from the request's, so it answers unknown, every field
//      null (item 52 step 1; default 96: "a kind that differs is a request no handle answers").
//   3. A business the rows give as the one, whose businesses row the read cannot see, throws BrokenRecordError and
//      nothing is answered (turn-face-reads.ts default 2's rule: fail closed rather than answer half): a party at a
//      business always carries that business's zone, never one made up (refuse-turn-party-business-zone-null). K-04's
//      foreign keys keep the row, so only a policy that hides it from rosie_job meets this.
//   4. A handle that no person writes from (no person_handles row: an erasure that removed the link, open gaps 28 and
//      60) has no role and no company to read, so steps 3 to 5 send nothing, and it answers noBusiness with personId
//      null (item 52: "there is no scope"; default 97: "with none or several personId is null").
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.11";
import { transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, inRuntimeTransaction } from "./targets";
import { BrokenRecordError } from "./turn-face-reads";

// ---- the request and the answers (data-access.v1.11.schema.json) ----------------------------------------------------

/** K-05 v1.11 readTurnParty.request: the handle a turn's texts came from (K-06 v1 handle), and nothing else. */
export type ReadTurnPartyRequest = K05.ReadTurnPartyRequest;
/** K-05 v1.11 readTurnParty.atBusiness: the handle's id, the one business, the person or null, the business's zone. */
export type ReadTurnPartyAtBusiness = K05.ReadTurnPartyAtBusiness;
/** K-05 v1.11 readTurnParty.noBusiness: the handle's id, no business, the person or null, no zone. */
export type ReadTurnPartyNoBusiness = K05.ReadTurnPartyNoBusiness;
/** K-05 v1.11 readTurnParty.unknown: no K-04 handle has the request's kind and address; every field null. */
export type ReadTurnPartyUnknown = K05.ReadTurnPartyUnknown;
export type ReadTurnPartyResponse = K05.ReadTurnPartyResponse;
/** K-05 v1.11 businessUndecidedError: the reason, the handle's id and the person; never a business. */
export type BusinessUndecidedError = K05.BusinessUndecidedError;
/** K-05 v1.11 readTurnParty.errors: businessUndecided or transient. */
export type ReadTurnPartyError = K05.ReadTurnPartyErrors;
export type ReadTurnPartyOutcome = ReadTurnPartyResponse | ReadTurnPartyError;

type HandleKind = ReadTurnPartyRequest["handle"]["kind"];
type UndecidedReason = BusinessUndecidedError["reason"];

interface Handle {
  readonly kind: HandleKind;
  readonly address: string;
}

const CALL = "readTurnParty";
const HANDLE_KINDS: ReadonlySet<string> = new Set<HandleKind>(["phone", "email"]);
/** K-06 v1 handle.address: an E.164 number, or an email address in lower case (K-04 handles_address_form). */
const ADDRESS = /^(\+[1-9][0-9]{6,14}|[^@\sA-Z]+@[^@\sA-Z]+)$/;

// ---- the request's shape (default 2) --------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request's handle, or a TypeError before any statement, naming the field and never a value: the request names the
 * handle alone (refuse-turn-party-caller-business), as K-06 v1's handle, a kind and an address in one of its two forms.
 */
function handleOf(request: unknown): Handle {
  assertRequestShape(request, CALL, ["handle"]);
  const handle = (request as Record<string, unknown>).handle;
  if (!isRecord(handle)) {
    throw new TypeError(`${CALL}: the request needs handle, an object`);
  }
  if (Object.keys(handle).some((key) => key !== "kind" && key !== "address")) {
    throw new TypeError(`${CALL}: handle takes only kind and address`);
  }
  const { kind, address } = handle;
  if (typeof kind !== "string" || !HANDLE_KINDS.has(kind)) {
    throw new TypeError(`${CALL}: handle.kind is phone or email`);
  }
  if (typeof address !== "string" || !ADDRESS.test(address)) {
    throw new TypeError(`${CALL}: handle.address is an E.164 number or an email address in lower case`);
  }
  return { kind: kind as HandleKind, address };
}

// ---- item 52's rule (default 100) ------------------------------------------------------------------------------------

/** Step 3: a role of one of the handle's people, live (ended_at null) or ended; its id is never read. */
interface RoleRow {
  business_id: string;
  person_id: string;
  role: string;
  ended_at: Date | null;
}

/** Step 4: a company of one of the handle's people, by its business alone (null: none yet). */
interface CompanyRow {
  business_id: string | null;
}

/** Step 5: a live owner role at a business a company names, and whose it is. */
interface OwnerRow {
  business_id: string;
  person_id: string;
}

/** The business the rows give (null: none), or why they give none. */
type Decision = { readonly businessId: string | null } | { readonly reason: UndecidedReason };

/**
 * Default 100's rule over the rows steps 2 to 5 read: anotherOwner, then roleEnded, each over every business a company
 * names, then the scopes (severalBusinesses, one business, or none). Ids are compared whole, never parsed (CQ-09).
 */
function decide(
  people: ReadonlySet<string>,
  roles: readonly RoleRow[],
  companies: readonly CompanyRow[],
  owners: readonly OwnerRow[],
): Decision {
  const companyBusinesses = new Set(
    companies.flatMap((company) => (company.business_id === null ? [] : [company.business_id])),
  );
  // anotherOwner (default 99; default 1): a live owner role at a business a company names, held by a person who does
  // not write from the handle, whether or not one of the handle's people holds one there too.
  if (owners.some((owner) => companyBusinesses.has(owner.business_id) && !people.has(owner.person_id))) {
    return { reason: "anotherOwner" };
  }
  // roleEnded (default 99): a business a company names, where none of them holds the live owner role and one of them
  // holds a role that ended. One of them holding the live owner role there agrees with the company.
  for (const businessId of companyBusinesses) {
    const ownerHere = roles.some(
      (role) => role.business_id === businessId && role.role === "owner" && role.ended_at === null,
    );
    const endedHere = roles.some((role) => role.business_id === businessId && role.ended_at !== null);
    if (!ownerHere && endedHere) {
      return { reason: "roleEnded" };
    }
  }
  // The scopes (default 98): each live role's business and each company's, with "no business yet" for a company with
  // none. More than one is severalBusinesses; one business is the party's; none, or "no business yet" alone, is none.
  const businesses = new Set(companyBusinesses);
  for (const role of roles) {
    if (role.ended_at === null) {
      businesses.add(role.business_id);
    }
  }
  const noBusinessYet = companies.some((company) => company.business_id === null);
  const [only, ...more] = [...businesses];
  if (only === undefined) {
    return { businessId: null };
  }
  if (more.length > 0 || noBusinessYet) {
    return { reason: "severalBusinesses" };
  }
  return { businessId: only };
}

// ---- readTurnParty (item 52) -------------------------------------------------------------------------------------

/** The party inside the read's own transaction, on the runtime side: item 52's six reads in order, each as needed. */
async function partyIn(tx: Sql, handle: Handle): Promise<ReadTurnPartyResponse | BusinessUndecidedError> {
  // Step 1: the handle by its address; none, or one of another kind, is unknown (default 96; default 2).
  const [found] = await tx<{ id: string; kind: string }[]>`
    select id, kind from handles where address = ${handle.address}
  `;
  if (found?.kind !== handle.kind) {
    return { handleId: null, businessId: null, personId: null, zone: null };
  }
  const handleId = found.id;

  // Step 2: its people, in person_id order; the person is the one person, else null (default 97).
  const links = await tx<{ person_id: string }[]>`
    select person_id from person_handles where handle_id = ${handleId} order by person_id collate "C"
  `;
  const people = links.map((link) => link.person_id);
  const [first, ...others] = people;
  const personId = first !== undefined && others.length === 0 ? first : null;
  if (first === undefined) {
    // No one writes from the handle: no role and no company to read (default 4).
    return { handleId, businessId: null, personId: null, zone: null };
  }

  // Step 3: their roles, live or ended.
  const roles = await tx<RoleRow[]>`
    select business_id, person_id, role, ended_at from person_roles where person_id in ${tx(people)}
  `;
  // Step 4: their companies, by business (null: none yet).
  const companies = await tx<CompanyRow[]>`
    select business_id from companies where owner_person_id in ${tx(people)}
  `;
  // Step 5: for each business a company names, its live owner roles and whose they are.
  const companyBusinesses = [
    ...new Set(companies.flatMap((company) => (company.business_id === null ? [] : [company.business_id]))),
  ];
  const owners =
    companyBusinesses.length === 0
      ? []
      : await tx<OwnerRow[]>`
          select business_id, person_id from person_roles
          where business_id in ${tx(companyBusinesses)} and role = 'owner' and ended_at is null
        `;

  const decision = decide(new Set(people), roles, companies, owners);
  if ("reason" in decision) {
    return { error: "businessUndecided", reason: decision.reason, handleId, personId };
  }
  if (decision.businessId === null) {
    return { handleId, businessId: null, personId, zone: null };
  }

  // Step 6: the zone of the one business (default 101); a row the read cannot see is never guessed (default 3).
  const [business] = await tx<{ time_zone: string }[]>`
    select time_zone from businesses where id = ${decision.businessId}
  `;
  if (business === undefined) {
    throw new BrokenRecordError(`${CALL}: the business the rows give is missing`);
  }
  return { handleId, businessId: decision.businessId, personId, zone: business.time_zone };
}

/**
 * The handle's party for a turn (K-05 v1.11 item 52): from the handle a turn's texts came from, its K-04 id, the business
 * the turn's calls run under, the person and that business's zone, or businessUndecided with its reason wherever the
 * rows do not give one business the handle may act for (default 100's rule), or every field null for a handle K-04 does
 * not hold. One read-only transaction at repeatable read on the primary, uncached, writing nothing. Pass the runtime
 * side's client (rosie_job): the role is the connection's. transient on a serialization failure, a deadlock or a lost
 * connection. Throws a TypeError for a request of the wrong shape, a BrokenRecordError for a record it would have to guess
 * around (default 3), and any other database error scrubbed (DataAccessDatabaseError); nothing is written on any of
 * them. The address is a person's number or email address: it is never answered, logged or put in an error.
 */
export async function readTurnParty(sql: Sql, request: ReadTurnPartyRequest): Promise<ReadTurnPartyOutcome> {
  const handle = handleOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => partyIn(tx, handle));
  } catch (error) {
    return transientOrScrubbed(CALL, error);
  }
}
