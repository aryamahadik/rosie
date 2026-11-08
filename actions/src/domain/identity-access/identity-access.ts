// The identity-and-access service base (T-308; C-094; arch 02 diagram line 105, "Identity & access"): who a sender is
// for a business, the booker, the person served and the payer kept apart, and who decides a matter (S13-31; S13-45
// rows 2, 5 and 8; RULES 6.4, 6.6, 6.8).
//
// One service serves one Tool API call and is bound to the call's business scope (T-290: CallContext.businessId, read
// through CallContext.repo), so it never answers about another business: a role, an admin's power or a booking of
// another business never counts here, even from a reader that returns it. It reads K-04 v1 through the data-access
// calls (facts.ts) and never reads free text: ids and closed lists in, ids and closed lists out.
//
// Who decides (S13-31, "Who decides, and whose yes counts"):
//   - A visit: the person served ("The person served decides about their own visit"), or for a minor a parent or
//     guardian on file ("A minor: a parent or guardian decides"). That covers their own yes, private answers, consent,
//     another pro and a cancel (S13-31), seeing or changing the booking (S13-45 row 2) and a yes to a price, an extra or
//     a plan (row 5). Never the booker or the payer for being one ("The booker decides nothing for an adult served"; the
//     payer "decide[s] nothing about the visit"): either decides only when the record makes them the person served or a
//     minor's parent or guardian. Once a death is reported on the booking, the owner decides the rest (A7-81).
//   - Fees, refunds (beyond the terms, RULES 3.10), the team and settings: the account owner, or an admin the owner lets
//     ("Only the account owner, or an admin the owner lets, decides fees, refunds, the team and settings"); staff never.
//   - Closing, export, hand-over and removing the owner: the owner alone ("Admins never close the business, export, hand
//     it over, or remove the account owner": S13-45 row 8; RULES 6.8).
// When nobody on the record can decide, the answer names nobody and says why: "Silence decides nothing. When nobody
// allowed can decide in time, the step's safe default runs and a person is told" (S13-31).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The person served decides as an adult when no age band is on file (facts.ts NOTHING_ON_FILE): A4-24 "Plug-in
//      silent: the person served must be an adult"; S13-31 "Rosie never judges whether someone can decide".
//   2. A booking whose person served is not on the record yet names no decider, never the booker: A4-24's safe default
//      ("the booker is the person served") is the step's to write into the record when it runs, and "Never: let a booker
//      decide for an adult served" (A4-24) rules out reading it into a gap, such as A4-26's brother before his own yes.
//   3. A minor with no parent or guardian on file names no decider (A4-25: the family record names them).
//   4. On a booking flagged deceased (K-04 bookings.deceased) the owner alone decides the visit, as for an owner-only
//      matter: A7-81 "Sam decides the rest: a cancel, a refund, or who to speak with"; RULES 6.7 "the owner cancels and
//      refunds"; S13-31 "After a death, the business speaks with whoever has legal authority. Rosie never does".
//   5. Admins decide only with a live K-22 v1 power, asked through AdminPowers; with no such port, no admin decides.
//      Only a live admin role is asked: S13-31 and RULES 6.8 name an admin, never staff, whatever power a row gives.
//
// Not here: proof that a sender is who the record says (the one rule, S13-45; proof codes, T-322; limit 1, T-299); staff
// details, the ID upload and admins' powers from K-22 v1 (T-321, behind AdminPowers); the who home's papers on file for
// an adult, a teen deciding alone, an organization that books, someone added, and whose yes counts (T-589).

import type { BookingHead } from "../../../../db/repo/bookings-head";
import type { PersonRole, PersonRoleName } from "../../../../db/repo/people";
import {
  NOTHING_ON_FILE,
  NO_ADMIN_POWERS,
  type AdminPower,
  type AdminPowers,
  type IdentityReader,
  type ServedFactsReader,
} from "./facts";

/** A person's role at one business as K-04 v1 `person_roles` names it (FS line 723), in K-04's order. */
export type Role = PersonRoleName;
export const ROLES: readonly Role[] = ["owner", "admin", "staff", "own_business", "customer"];

/** The business matters an admin the owner lets may decide too (S13-31). */
export const BUSINESS_MATTERS = ["fee", "refund", "team", "settings"] as const;
export type BusinessMatter = (typeof BUSINESS_MATTERS)[number];

/** The matters only the account owner decides (S13-45 row 8; RULES 6.8). */
export const OWNER_ONLY_MATTERS = ["close", "export", "handOver", "removeOwner"] as const;
export type OwnerOnlyMatter = (typeof OWNER_ONLY_MATTERS)[number];

/** The power an admin needs for each business matter (K-22 v1 team_powers: "money: fees and refunds"). */
const POWER_OF: Readonly<Record<BusinessMatter, AdminPower>> = {
  fee: "money",
  refund: "money",
  team: "team",
  settings: "settings",
};

/** What is to be decided: a booking's visit, or a matter of the business. */
export type Matter =
  | { readonly kind: "visit"; readonly bookingId: string }
  | { readonly kind: BusinessMatter }
  | { readonly kind: OwnerOnlyMatter };

/** Why a person decides: the standing S13-31 gives them, never their part as booker or payer. */
export type DecidesAs = "served" | "parentOrGuardian" | "owner" | "admin";

export interface Decider {
  readonly personId: string;
  readonly as: DecidesAs;
}

/** Why nobody on the record decides a matter: the caller asks, or runs the step's safe default (S13-31). */
export type NoDecider =
  /** No such booking at this business; another business's booking is never answered. */
  | "bookingNotFound"
  /** Who the visit is for is not on the record yet (asked at A4-80, routed at A4-24). */
  | "servedNotOnRecord"
  /** The person served is a minor and no parent or guardian is on file (A4-25). */
  | "noParentOrGuardian"
  /** No live owner, and no admin the owner lets for this matter. */
  | "nobodyAllowed";

/** Who decides a matter: any one of the deciders (S13-31: "The first answer from someone allowed counts"), or nobody. */
export type WhoDecides =
  | { readonly ok: true; readonly deciders: readonly Decider[] }
  | { readonly ok: false; readonly why: NoDecider };

/** A person behind a handle, with their live roles at this business. */
export interface SenderPerson {
  readonly personId: string;
  readonly roles: readonly Role[];
}

/** Who a sender is for this business, by the record: never proof that the sender is that person (S13-45). */
export interface Sender {
  readonly handleId: string;
  /** The people the handle belongs to, by id (one handle can be several people: arch 01 line 55; S13-27 rule 28). */
  readonly people: readonly SenderPerson[];
  /**
   * Every role that fits, in K-04's order. The role comes from what the message is about, never the phone alone, and
   * when two fit the sender is asked which (S13-31): that is the caller's, since this service never reads the message.
   */
  readonly roles: readonly Role[];
}

/** A booking's booker, person served and payer, kept apart: none is ever filled in from another (A4-24). */
export interface Parties {
  readonly bookingId: string;
  readonly booker: string;
  /** Null until known. */
  readonly served: string | null;
  /** Null until known. */
  readonly payer: string | null;
}

export type Part = "booker" | "served" | "payer";

/** The parts one person plays on a booking, each on its own: being the booker or the payer never makes the served. */
export function partsOf(parties: Parties, personId: string): Part[] {
  const parts: Part[] = [];
  if (parties.booker === personId) parts.push("booker");
  if (parties.served === personId) parts.push("served");
  if (parties.payer === personId) parts.push("payer");
  return parts;
}

export interface IdentityAccess {
  /** The business every answer is about: the call's business scope. */
  readonly businessId: string;
  /** Who a sender is for this business: the people its handle belongs to, and each one's live roles here. */
  sender(handleId: string): Promise<Sender>;
  /** A person's live roles at this business, in K-04's order. */
  rolesOf(personId: string): Promise<Role[]>;
  /** A booking's three parties, kept apart; null when this business has no such booking. */
  parties(bookingId: string): Promise<Parties | null>;
  /** Who decides a matter at this business. */
  whoDecides(matter: Matter): Promise<WhoDecides>;
  /** Whether a person is one of those who decide a matter. */
  decides(matter: Matter, personId: string): Promise<boolean>;
}

export interface IdentityAccessOptions {
  /** The business the call runs under: the Tool API call's scope (CallContext.businessId). */
  readonly businessId: string;
  /** The K-04 v1 reads, on the call's transaction: identityReaderOf(context.repo). */
  readonly reader: IdentityReader;
  /** Admins' powers (K-22 v1, T-321). Default NO_ADMIN_POWERS: the owner alone decides business matters. */
  readonly adminPowers?: AdminPowers;
  /** The person served's age band and parents or guardians. Default NOTHING_ON_FILE: they decide as an adult. */
  readonly servedFacts?: ServedFactsReader;
}

/** Ids are opaque strings (CQ-09); the message names the argument, never its value. */
function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${what} must be a non-empty id`);
  }
}

/** Ids compared, never parsed (CQ-09; K-05 v1.2 item 41), each once. */
function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => id.trim() !== "").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function inRoleOrder(roles: Iterable<Role>): Role[] {
  const held = new Set(roles);
  return ROLES.filter((role) => held.has(role));
}

function isBusinessMatter(kind: string): kind is BusinessMatter {
  return (BUSINESS_MATTERS as readonly string[]).includes(kind);
}

function isOwnerOnlyMatter(kind: string): kind is OwnerOnlyMatter {
  return (OWNER_ONLY_MATTERS as readonly string[]).includes(kind);
}

const decided = (deciders: readonly Decider[]): WhoDecides => ({ ok: true, deciders });
const nobody = (why: NoDecider): WhoDecides => ({ ok: false, why });

export function createIdentityAccess(options: IdentityAccessOptions): IdentityAccess {
  const { businessId, reader } = options;
  assertId(businessId, "businessId");
  const adminPowers = options.adminPowers ?? NO_ADMIN_POWERS;
  const servedFacts = options.servedFacts ?? NOTHING_ON_FILE;

  /** Live rows of this business only, so a reader without row-level security cannot widen an answer. */
  const liveHere = (rows: readonly PersonRole[]): PersonRole[] =>
    rows.filter((row) => row.businessId === businessId && row.endedAt === null);

  const rolesOf = async (personId: string): Promise<Role[]> => {
    assertId(personId, "personId");
    const rows = liveHere(await reader.liveRolesOfPerson(personId));
    return inRoleOrder(rows.filter((row) => row.personId === personId).map((row) => row.role));
  };

  /** This business's live owners or admins, by id. */
  const holders = async (role: "owner" | "admin"): Promise<string[]> => {
    const rows = liveHere(await reader.liveRolesOfBusiness(businessId, role));
    return sortedIds(rows.filter((row) => row.role === role).map((row) => row.personId));
  };

  /** The booking's head when it is this business's, else null. */
  const headHere = async (bookingId: string): Promise<BookingHead | null> => {
    assertId(bookingId, "bookingId");
    const head = await reader.bookingHead(bookingId);
    return head !== null && head.id === bookingId && head.businessId === businessId ? head : null;
  };

  /** The owner, and for a power the admins the owner lets with it (S13-31; S13-45 row 8). */
  const businessSide = async (power: AdminPower | null): Promise<WhoDecides> => {
    const deciders: Decider[] = (await holders("owner")).map((personId) => ({ personId, as: "owner" }));
    if (power !== null) {
      for (const personId of await holders("admin")) {
        if (deciders.some((decider) => decider.personId === personId)) continue;
        if (await adminPowers.holds(businessId, personId, power)) deciders.push({ personId, as: "admin" });
      }
    }
    return deciders.length > 0 ? decided(deciders) : nobody("nobodyAllowed");
  };

  /**
   * The person served, or a minor's parents or guardians on file; never the booker or the payer for being one. After a
   * death is reported on the booking, the owner (A7-81).
   */
  const visit = async (bookingId: string): Promise<WhoDecides> => {
    const head = await headHere(bookingId);
    if (head === null) return nobody("bookingNotFound");
    if (head.deceased) return businessSide(null);
    const served = head.servedPersonId;
    if (served === null) return nobody("servedNotOnRecord");
    const facts = await servedFacts.servedFacts(businessId, head.id, served);
    if (facts.ageBand !== "under_18") return decided([{ personId: served, as: "served" }]);
    const parents = sortedIds(facts.parentOrGuardianIds).filter((personId) => personId !== served);
    if (parents.length === 0) return nobody("noParentOrGuardian");
    return decided(parents.map((personId) => ({ personId, as: "parentOrGuardian" })));
  };

  const whoDecides = (matter: Matter): Promise<WhoDecides> => {
    const kind: string = matter.kind;
    if (matter.kind === "visit") return visit(matter.bookingId);
    if (isBusinessMatter(kind)) return businessSide(POWER_OF[kind]);
    if (isOwnerOnlyMatter(kind)) return businessSide(null);
    return Promise.reject(new TypeError("a matter is a visit, a business matter or an owner-only matter"));
  };

  return {
    businessId,

    async sender(handleId) {
      assertId(handleId, "handleId");
      const people: SenderPerson[] = [];
      for (const personId of sortedIds(await reader.personIdsOfHandle(handleId))) {
        people.push({ personId, roles: await rolesOf(personId) });
      }
      return { handleId, people, roles: inRoleOrder(people.flatMap((person) => person.roles)) };
    },

    rolesOf,

    async parties(bookingId) {
      const head = await headHere(bookingId);
      if (head === null) return null;
      return {
        bookingId: head.id,
        booker: head.bookerPersonId,
        served: head.servedPersonId,
        payer: head.payerPersonId,
      };
    },

    whoDecides,

    async decides(matter, personId) {
      assertId(personId, "personId");
      const answer = await whoDecides(matter);
      return answer.ok && answer.deciders.some((decider) => decider.personId === personId);
    },
  };
}
