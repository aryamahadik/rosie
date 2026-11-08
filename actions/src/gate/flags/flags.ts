// The gate's check of the record flags (T-317; C-078; arch 03 line 175: "Their effects are record flags, checked by the
// gate, the dispatcher, the charge job, clock firings and the crew day list"), run on each agreed part before limits 1 to
// 6 (T-298), registered in actions/src/gate/limits.ts. A flag forbids a part's work in two cases:
//   - paused (person, phone or address): "visits and requests wait for the owner" (A3-48; S11-62): a part that acts on a
//     booking, or opens one through the new-booking or booking-already-made door, when an open pause at the business holds
//     the person writing, their phone, or the booking's booker or person served;
//   - deceased (booking): "nothing new is charged, bills wait for the owner" (A7-81): a part on a deceased booking whose
//     choice charges or takes money (K-02 v1 stakesFrom charge or money).
// private narrows who is reached (A3-50: the claim check and the dispatcher) and stopped what is sent (limit 8, and the
// commit's invariant in actions/src/domain/flags/stopped.ts); neither forbids a part's work. A change that only protects
// (a STOP in any words, a death report, the A3-48 pause, A3-50's private booking: commit/hold.ts) commits at once, past
// every flag; and the owner's own part is the owner's decision, which every flag waits for (arch 03 line 177).
//
// A part a flag forbids is stopped before any limit runs, with limit 1's askedDecider outcome (K-09 v1 limit1Outcome):
// while the flag holds the owner decides that work, so the question goes to the decider's own chat; no other limit runs
// for it. Reads go through the call's database transaction, under its business scope, only for a part a flag could
// forbid; what is returned, thrown or logged names flags, limits and row ids, never a number, a name or anyone's words.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. K-09 v1 has no outcome of its own for a record flag (partResult names limits 1 to 6), so a part a flag forbids is
//      stopped with limit 1's askedDecider (ask): the flags hand the decision to the owner (arch 03 line 175: "wait for the
//      owner"; A3-48: "paused until Sam decides"). Limit 1's own check, and limits 2 to 6, do not run for that part.
//   2. The people a pause is checked on are everyone behind the writing handle, the caller's person, and the booking's
//      booker and person served (a shared phone fails closed); the phone is the writing handle when it is a mobile.
//   3. The owner is a person with an owner role at the choice's business in the turn's writer (K-02 v1 person roles).
//   4. A booking head the scope does not show (none, or another business's) holds no booking flag; the writer's pauses
//      still apply.

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1";
import { getBookingHead } from "../../../../db/repo/bookings-head";
import { listOpenPausesOfPerson, listOpenPausesOfPhone } from "../../../../db/repo/phones";
import type { Sql, Tx } from "../../../../db/repo/scope";
import { holdClassOf } from "../../commit/hold";
import type { GatePart, GateTurn, Limit, LimitRegistry, LimitVerdict } from "../framework";

/** A flag that forbids a part's work at the gate. */
export type GateFlag = "paused" | "deceased";

/** What the flags say about one part: it goes on to the limits, or a flag holds it (with the rows that hold it). */
export type FlagDecision =
  | { readonly result: "pass" }
  | { readonly result: "held"; readonly flag: GateFlag; readonly rowIds: readonly string[] };

/** An open pause as the gate reads it: its id and the business whose owner clears it (K-04 pauses). */
export interface PauseRef {
  readonly id: string;
  readonly businessId: string;
}

/** A booking head's flags and people, as the gate reads them (K-04 bookings). */
export interface BookingFlags {
  readonly id: string;
  readonly businessId: string;
  readonly bookerPersonId: string;
  readonly servedPersonId: string | null;
  readonly deceased: boolean;
}

/** The reads the flags check makes, each one data-access call on the call's transaction. */
export interface GateFlagReads {
  openPausesOfPerson(personId: string): Promise<readonly PauseRef[]>;
  openPausesOfPhone(number: string): Promise<readonly PauseRef[]>;
  bookingFlags(bookingId: string): Promise<BookingFlags | null>;
}

/** The reads over the data-access calls (db/repo), on the call's database transaction. */
export function gateFlagReadsOf(db: Sql | Tx): GateFlagReads {
  const ref = (pause: { id: string; businessId: string }): PauseRef => ({
    id: pause.id,
    businessId: pause.businessId,
  });
  return {
    openPausesOfPerson: async (personId) => (await listOpenPausesOfPerson(db, personId)).map(ref),
    openPausesOfPhone: async (number) => (await listOpenPausesOfPhone(db, number)).map(ref),
    bookingFlags: async (bookingId) => {
      const head = await getBookingHead(db, bookingId);
      return head === null
        ? null
        : {
            id: head.id,
            businessId: head.businessId,
            bookerPersonId: head.bookerPersonId,
            servedPersonId: head.servedPersonId,
            deceased: head.deceased,
          };
    },
  };
}

/**
 * The call's repo as the data-access calls take it: the Tool API's scoped transaction, a tagged-template function.
 * Anything else is not a database: the check throws, so the gate fails the whole call and nothing passes.
 */
export function flagsDatabaseOf(repo: unknown): Sql | Tx {
  if (typeof repo !== "function")
    throw new TypeError("the flags check reads through the call's database transaction");
  return repo as Sql | Tx;
}

/** Limit 1's askedDecider (K-09 v1 Limit1Outcome_askedDecider): the outcome of a part a flag holds (default 1). */
export const ASKED_DECIDER: K09.Limit1OutcomeAskedDecider = {
  limit: 1,
  outcome: "ask",
  action: "askedDecider",
};

/** The doors that open a booking (K-02 v1 choice.door): a new booking, and a booking already made after a code check. */
const BOOKING_DOORS: readonly string[] = ["newBooking", "existingBooking"];

/** The stakes reasons that charge or take money (K-02 v1 stakesReason.why). */
const CHARGE_REASONS: readonly string[] = ["charge", "money"];

/** A mobile number in E.164 form (K-04 phones_number_form): the writing handle, when it is a phone. */
const E164 = /^\+[1-9][0-9]{6,14}$/u;

const PASS: FlagDecision = { result: "pass" };

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether the caller's person is an owner of the business in the turn's writer (default 3). */
function ownerActs(turn: GateTurn, businessId: string): boolean {
  const personId = turn.request.caller.personId;
  if (personId === null) return false;
  const person = turn.context.writer.people.find((each) => each.personId === personId);
  return person?.roles.some((role) => role.role === "owner" && role.businessId === businessId) === true;
}

/** What the flags say about one agreed part (the module note), reading only when a flag could forbid it. */
export async function decideFlags(
  part: GatePart,
  turn: GateTurn,
  reads: () => GateFlagReads,
): Promise<FlagDecision> {
  const { part: verbPart, choice } = part;
  if ((verbPart.verb !== "choose" && verbPart.verb !== "enter") || choice === null) return PASS;
  if (holdClassOf(verbPart, choice) === "protective") return PASS;
  const { businessId, bookingId } = choice.target;
  const opensBooking = choice.door !== null && BOOKING_DOORS.includes(choice.door);
  if (bookingId === null && !opensBooking) return PASS;
  if (ownerActs(turn, businessId)) return PASS;

  const db = reads();
  const head = bookingId === null ? null : await db.bookingFlags(bookingId);
  const shown = head !== null && head.businessId === businessId ? head : null;
  const charges = choice.stakesFrom.some((reason) => CHARGE_REASONS.includes(reason.why));
  if (charges && shown?.deceased === true) return { result: "held", flag: "deceased", rowIds: [shown.id] };

  const people = new Set(turn.context.writer.people.map((person) => person.personId));
  if (turn.request.caller.personId !== null) people.add(turn.request.caller.personId);
  if (shown !== null) {
    people.add(shown.bookerPersonId);
    if (shown.servedPersonId !== null) people.add(shown.servedPersonId);
  }
  const pauses: PauseRef[] = [];
  for (const personId of [...people].sort(byId)) pauses.push(...(await db.openPausesOfPerson(personId)));
  const handle = turn.context.writer.handle;
  if (E164.test(handle)) pauses.push(...(await db.openPausesOfPhone(handle)));
  const holding = [
    ...new Set(
      pauses
        .filter((pause) => pause.businessId === businessId || pause.businessId === turn.businessId)
        .map((pause) => pause.id),
    ),
  ].sort(byId);
  return holding.length === 0 ? PASS : { result: "held", flag: "paused", rowIds: holding };
}

export interface GateFlagsDeps {
  /** The reads on the call's repo. Default: the data-access calls on the call's database transaction. */
  readonly reads?: (repo: unknown) => GateFlagReads;
}

/** Slot 1 of the registry with the flags check before limit 1: the decision the commit's outcome writer may read. */
export interface FlagsFirstLimit<Repo> extends Limit<1, Repo> {
  flags(part: GatePart, turn: GateTurn<Repo>): Promise<FlagDecision>;
}

/** The registry with the flags first: slot 1 checks them before limit 1; slots 2 to 6 are the limits as given. */
export type FlagsFirstRegistry<Repo> = readonly [
  FlagsFirstLimit<Repo>,
  Limit<2, Repo>,
  Limit<3, Repo>,
  Limit<4, Repo>,
  Limit<5, Repo>,
  Limit<6, Repo>,
];

/**
 * Limits 1 to 6 with the flags checked first (the module note): slot 1 asks the flags before limit 1, and a part a flag
 * forbids fails there with ASKED_DECIDER, so no limit runs for it; every other part takes limit 1 as it is. Slots 2 to 6
 * are the limits themselves, unchanged.
 */
export function flagsFirst<Repo>(
  limits: LimitRegistry<Repo>,
  deps: GateFlagsDeps = {},
): FlagsFirstRegistry<Repo> {
  const [one, two, three, four, five, six] = limits;
  const readsOf = deps.reads ?? ((repo: unknown) => gateFlagReadsOf(flagsDatabaseOf(repo)));
  const flags = (part: GatePart, turn: GateTurn<Repo>): Promise<FlagDecision> => {
    let made: GateFlagReads | null = null;
    return decideFlags(part, turn, () => (made ??= readsOf(turn.repo)));
  };
  const held: LimitVerdict<1> = { result: "fail", outcome: ASKED_DECIDER };
  const first: FlagsFirstLimit<Repo> = {
    limit: 1,
    flags,
    async check(part, turn) {
      const decision = await flags(part, turn);
      return decision.result === "held" ? { ...held, outcome: { ...ASKED_DECIDER } } : one.check(part, turn);
    },
  };
  return [first, two, three, four, five, six];
}
