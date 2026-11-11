// The staging-only listing call (T-574; C-074, C-205; K-21 v1 testRoster; build prompt 9.4 'Seeded state' and 'The
// test-phone page'): what it answers and what it reaches. The K-21 shapes are mirrored here by hand, as the test-phone
// calls' are (../test-phone/types.ts), because the generated contract types are git-ignored (ADR-005); the tests hold
// every answer to K-21 v1's schema itself. Every port is handed in by the composition root (runtime/src/wiring, a later
// runtime card, as T-1186 was for the test-phone calls): nothing here opens a database, reads a key or logs.
//
// Two things are read, and only on staging, for a signed-in tester:
//   the roster      staging's config (Q-53; C-202): which businesses are the test businesses, and the test phones, each
//                   with its roster id, its number, its role in tests, its label and the business it is seated at;
//   the seeded rows what staging's seeds wrote for them (T-202, T-218, T-1148; CQ-14), read on the primary, uncached: each
//                   business's K-04 head, its kinds of work and whether it is signed up; each phone's K-04 row, its
//                   text-hours override row, the seeded person it texts as and its seeded customer.

import type { TesterAccess } from "../test-phone/types";

/** A test business's flow (K-21 v1 `RosterBusiness.flow`): A, a customer books a time; B, a pro quotes the job. */
export type RosterFlow = "A" | "B";

/** A test phone's role in tests (K-21 v1 `RosterPhone.role`; BP 9.4; Q-53). */
export type RosterRole = "owner" | "staff" | "customer" | "secondCustomer" | "stop";

/**
 * Who asks a read: the trace the page entry opened for this request and the call's moment. The trace id is always the
 * entry's own (`PageRequest.trace.traceId`), never the envelope's `page.traceId`, which is a browser value.
 */
export interface TestStateCaller {
  /** The page entry's trace id, for any span or K-05 call the read makes. */
  readonly traceId: string;
  /** The call's moment: RFC 3339 UTC, whole seconds, ending in Z. */
  readonly at: string;
}

/** One test business as staging's roster names it. */
export interface RosterBusinessEntry {
  /** K-04 v1 businesses.id of the seeded demo shop. */
  readonly businessId: string;
  /** The flow the shop is seeded for. */
  readonly flow: RosterFlow;
}

/** One test phone as staging's roster names it: staging's config, never a browser value. */
export interface RosterPhoneEntry {
  /** The roster's id for the phone: what the test calls name, never a number. */
  readonly testPhoneId: string;
  /** Its number in E.164 form: never logged, never put in a span, and in the answer only as its last four digits. */
  readonly number: string;
  /** Its role in tests. */
  readonly role: RosterRole;
  /** A plain name for the picker, such as "Test owner 1": what it acts as, never who holds it (rule 9). */
  readonly label: string;
  /** The test business it is seated at (one of the roster's own), or null (the phone named for STOP tests). */
  readonly businessId: string | null;
}

/** Staging's roster as the listing reads it: the test businesses and the test phones, each in the picker's order. */
export interface StagingRoster {
  readonly businesses: readonly RosterBusinessEntry[];
  readonly phones: readonly RosterPhoneEntry[];
}

/** Staging's roster (Q-53; C-202): the same config the test-phone calls' roster reads one phone of. */
export interface TestStateRoster {
  /** The whole roster. */
  listing(caller: TestStateCaller): Promise<StagingRoster>;
}

/**
 * A business's K-04 v1 `businesses` row, the columns the listing shows (db/repo/people.ts `Business` holds them all, so
 * `getBusiness` answers this as it is).
 */
export interface SeededBusiness {
  readonly id: string;
  /** businesses.name. */
  readonly name: string;
  /** businesses.status: offline, saved or live. */
  readonly status: string;
  /** businesses.time_zone: an IANA zone name. */
  readonly timeZone: string;
  /** businesses.text_hours_start, as PostgreSQL prints a time ("08:00:00") or as K-04's seeds write it ("08:00"). */
  readonly textHoursStart: string;
  /** businesses.text_hours_end, likewise. */
  readonly textHoursEnd: string;
}

/** A number's K-04 v1 `phones` row, the columns the listing shows (db/repo/phones.ts `Phone` holds them all). */
export interface SeededPhone {
  /** phones.stopped. */
  readonly stopped: boolean;
  /** phones.linq_contact_added_at: when the mobile was added as a Linq contact, or null. Only whether it is set is read. */
  readonly linqContactAddedAt: Date | string | null;
}

/**
 * A number's text-hours override row: K-04 v1 `release_flags`, name staging.text-hours-override, scope `phone:<number>`
 * (K-21 v1 `textHoursOverrideState`; db/repo/flags.ts `ReleaseFlag` holds both columns).
 */
export interface SeededOverride {
  readonly enabled: boolean;
  readonly version: number;
}

/** A phone's seeded customer: its K-28 v1 `customers` row at the business it is seated at. */
export interface SeededCustomer {
  /** customers.id. */
  readonly id: string;
  /** customers.name. */
  readonly name: string;
}

/** The seeded rows, read on the primary, uncached (K-21 v1 README "Who may call": every call). */
export interface SeededState {
  /** The K-04 business row with this id, or null when there is none. */
  business(businessId: string, caller: TestStateCaller): Promise<SeededBusiness | null>;
  /** The business's kinds of work (K-23 v1 company_kinds.kind_id; K-24 v1 kinds.id), in the order the picker shows. */
  kindIds(businessId: string, caller: TestStateCaller): Promise<readonly string[]>;
  /** Whether the business is signed up (BP 9.4 'Seeded state'; false before the F14 setup seeds: CQ-14). */
  signedUp(businessId: string, caller: TestStateCaller): Promise<boolean>;
  /** The K-04 phone row of this number, or null while it has none (a number that has not texted yet). */
  phone(number: string, caller: TestStateCaller): Promise<SeededPhone | null>;
  /** The number's text-hours override row, or null while it has none. */
  textHoursOverride(number: string, caller: TestStateCaller): Promise<SeededOverride | null>;
  /**
   * The id of the one seeded person who writes from this number (K-04 v1 handles by address, then person_handles), or
   * null when no person, or more than one, does. Asked only for a phone that texts as an owner or a staff member.
   */
  person(number: string, caller: TestStateCaller): Promise<string | null>;
  /**
   * The seeded customer of this number at this business (K-28 v1 customers, by the number's handle as
   * mobile_handle_id), or null when there is none (before the F15 customer seeds: CQ-14).
   */
  customer(number: string, businessId: string, caller: TestStateCaller): Promise<SeededCustomer | null>;
}

/** What the handler reaches. */
export interface TestStateDeps {
  /** Who is signed in, and whether they may use staging's test tools: the port the test-phone calls take. */
  readonly access: TesterAccess;
  /** Staging's roster. */
  readonly roster: TestStateRoster;
  /** The seeded rows. */
  readonly seeded: SeededState;
  /** Epoch milliseconds. Default Date.now. */
  readonly now?: () => number;
}

// ---- K-21 v1's answers (page-api.v1.schema.json) -------------------------------------------------------------------
// The handler builds each answer as an object literal that satisfies one of these, so it is also the page entry's
// PageOutcome (runtime/src/gateway/pages/types.ts).

/** `stagingOnlyError`: a staging-only call outside staging; nothing was read or done. */
export interface StagingOnly {
  readonly error: "stagingOnly";
}

/** `signInNeededError`: no live session came. */
export interface SignInNeeded {
  readonly error: "signInNeeded";
}

/** `notTesterError`: the session's person is neither a roster tester nor on Rosie's team. */
export interface NotTester {
  readonly error: "notTester";
}

/** `textHours`: a business's own text hours, each as HH:MM. */
export interface TextHours {
  readonly start: string;
  readonly end: string;
}

/** `testRoster.response`'s business. */
export interface RosterBusiness {
  readonly businessId: string;
  readonly name: string;
  readonly flow: RosterFlow;
  readonly kindIds: readonly string[];
  readonly signedUp: boolean;
  readonly live: boolean;
  readonly zone: string;
  readonly textHours: TextHours;
}

/** `testRoster.response`'s seeded customer. */
export interface RosterCustomer {
  readonly customerId: string;
  readonly name: string;
}

/** `textHoursOverrideState`: on or off, with the row's version; off with version null while the phone has no row. */
export interface TextHoursOverrideState {
  readonly on: boolean;
  readonly version: number | null;
}

/** `testRoster.response`'s phone: its last four digits and what it acts as, never its number or who holds it. */
export interface RosterPhone {
  readonly testPhoneId: string;
  readonly last4: string;
  readonly role: RosterRole;
  readonly label: string;
  readonly businessId: string | null;
  readonly personId: string | null;
  readonly seededCustomer: RosterCustomer | null;
  readonly linqContact: boolean;
  readonly stopped: boolean;
  readonly textHoursOverride: TextHoursOverrideState;
}

/** `testRoster.response`: the seeded test businesses and the roster's test phones. */
export interface TestRoster {
  readonly result: "testRoster";
  readonly businesses: readonly RosterBusiness[];
  readonly phones: readonly RosterPhone[];
}
