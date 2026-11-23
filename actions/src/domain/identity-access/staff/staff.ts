// Staff status and admins' powers (T-321; C-094; K-22 v1 `staff` and `team_powers`): who is on a business's team, in which
// status (invited, joined, stopped, removed), who may be offered to customers, and what each team member other than the
// account owner may OK or do (S13-45 rows 8 and 9; S2-02 to S2-24; RULES 6.8).
//
// One service serves one call and is bound to its business, as the identity-and-access base is (T-308; CallContext
// .businessId): a row of another business never counts here, even from a reader that returns it. It reads K-22 v1's rows
// through StaffReader and answers ids, closed lists and the owner's own amounts only: never a mobile, a language, a video
// link or a name (K-08 v1 "Never the raw number or words"; CQ-59), so nothing it answers can carry them into a log, a
// span or an error. Nothing here logs; an error names its argument or column, never a value.
//
// Status (K-22 v1 staff.status; FS line 723; README "Joining under C9"):
//   - invited: added after the owner's tick that they agreed to a text (S2-02), their chat link given to the owner (C9);
//   - joined: their own ready text came from the mobile the owner gave (S2-05, S2-06; Q-08);
//   - stopped: they replied STOP (S2-08; RULES 7.7); START returns them to joined, or invited;
//   - removed: taken off the team; core's person_roles.ended_at holds when, ended in the same commit.
//
// Bookable (S2-07 "can't be booked until Avery replies YES"; S2-22 "Nobody is offered to customers until Sam says yes";
// S2-24 staff_live; S2-08 "not offered for new bookings until START"): only a joined member whose owner said yes
// (bookable_at, with joined_at) is offered. Invited, stopped and removed members are never offered, whatever bookable_at
// holds, so a START that returns a member to joined offers them again on the owner's earlier yes.
//
// Powers (K-22 v1 team_powers.power, team_powers_power_known; S13-45 row 8 "Owner powers: money, the team and settings.
// Also cancels, closing, export and hand-over"; "Admins act only for what the owner lets them"; "Admins never close the
// business, export, hand it over, or remove the account owner"): prices (an OK of a price or quote, over an amount where
// the owner named one: S2-02 "for prices over $500"), money (fees and refunds), team, settings and cancels. Closing,
// export, hand-over and removing the owner are no power at all, so no row can give them. A power holds while its row is
// live (ended_at null) on a member's row of this business. teamAdminPowers gives the identity-and-access base (T-308) its
// AdminPowers port over these rows, so whoDecides names an admin for a fee, a refund (beyond the terms: RULES 3.10), the
// team or the settings only with the live power the matter needs.
//
// Defaults used (for ops/QUESTIONS.md):
//   S1. A stopped member keeps the powers the owner gave: a STOP stops Rosie's texts (RULES 7.7; S2-08) and ends no role
//       (K-22 README: "START returns them to joined"), and S13-45 row 8 ties an admin's powers to the owner's word alone.
//       A removed member holds none (their role ended: RULES 8.7).
//   S2. An invited member holds the powers the owner gave at adding (K-22 seed-staff-invited: Pat, not yet joined, OKs
//       prices over $500); whether the request really comes from them is the one proof rule's (S13-45; limit 1), not here.
//   S3. A row with a status or power outside K-22 v1's closed lists, or two rows of one person at one business (K-22
//       staff_business_person_key), is refused as unreadable (StaffReadError, naming the column): the service fails
//       closed rather than guess, and offers nobody and grants nothing from such a read.
//
// Not here: the supervisor rule ("offered only while the supervisor works": S2-15; scheduling); skills (K-22 staff_skills,
// search); who may OK which price at which amount (limit 2 and the quotes service read HeldPower.over); the steps that
// add, join, stop or remove a member (S2-02 to S2-24: journey 2's calls); the data-access calls that read these rows
// (no K-05 call reads staff or team_powers yet: the composition root hands a StaffReader).

import type { AdminPower, AdminPowers } from "../facts";

/** K-22 v1 `staff.status` (staff_status_known), in its order. */
export const STAFF_STATUSES = ["invited", "joined", "stopped", "removed"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** K-22 v1 `team_powers.power` (team_powers_power_known), in its order. */
export const TEAM_POWERS = ["prices", "money", "team", "settings", "cancels"] as const;
export type TeamPower = (typeof TEAM_POWERS)[number];

/** K-22 v1 `staff`, the columns the service reads: ids, the status and its times. Never the mobile or any words. */
export interface StaffOnFile {
  readonly id: string;
  readonly businessId: string;
  readonly personId: string;
  readonly status: StaffStatus;
  /** When their own ready text came (S2-05); null: not joined. UTC. */
  readonly joinedAt: string | null;
  /** When they last replied STOP (S2-08); kept after START. UTC. */
  readonly stoppedAt: string | null;
  /** When the owner let them take bookings (S2-22); null: nobody offers them. UTC. */
  readonly bookableAt: string | null;
  readonly version: number;
}

/** K-22 v1 `team_powers`, the columns the service reads. */
export interface TeamPowerOnFile {
  readonly id: string;
  readonly staffId: string;
  readonly businessId: string;
  readonly power: TeamPower;
  /** prices only: the amount over which it applies, in whole cents (S2-02: over $500 is 50000); null: any amount. */
  readonly overCents: number | null;
  /** The amount's currency code, set with overCents. */
  readonly overCurrency: string | null;
  /** When the owner took it back; null while it holds. UTC. */
  readonly endedAt: string | null;
}

/**
 * K-22 v1's team rows of one business, read on the call's transaction (row-level security scopes both tables by
 * business_id: K-22 v1 rule 4); the service checks the business itself as well.
 */
export interface StaffReader {
  /** The business's staff rows, every status. */
  staffOfBusiness(businessId: string): Promise<readonly StaffOnFile[]>;
  /** The business's team power rows, ended ones too. */
  powersOfBusiness(businessId: string): Promise<readonly TeamPowerOnFile[]>;
}

/** A power a member holds now, as the owner named it. */
export interface HeldPower {
  readonly power: TeamPower;
  /** For prices, the amount over which it applies (code fills it from the row: rule 4); null: any amount. */
  readonly over: { readonly cents: number; readonly currency: string } | null;
}

/** A member of this business's team, as the record holds them now. */
export interface TeamMember {
  readonly staffId: string;
  readonly personId: string;
  readonly status: StaffStatus;
  /** Offered to customers: joined, and the owner said yes (S2-07, S2-22, S2-24; never while stopped: S2-08). */
  readonly bookable: boolean;
  /** The live powers the owner gave them, in K-22's order; none once removed. */
  readonly powers: readonly HeldPower[];
}

export interface StaffAccess {
  /** The business every answer is about: the call's business scope. */
  readonly businessId: string;
  /** Every member of this business's team, every status, by person id. */
  team(): Promise<TeamMember[]>;
  /** One person's membership here, or null when they have no staff row here (an owner without one, a customer). */
  member(personId: string): Promise<TeamMember | null>;
  /** One person's status here, or null with no staff row here. */
  statusOf(personId: string): Promise<StaffStatus | null>;
  /** The people who may be offered to customers now, by person id. */
  bookable(): Promise<string[]>;
  /** Whether one person may be offered to customers now. */
  isBookable(personId: string): Promise<boolean>;
  /** One person's live powers here, in K-22's order; none for a removed member or a person with no staff row. */
  powersOf(personId: string): Promise<HeldPower[]>;
  /** Whether one person holds a power here now. */
  holds(personId: string, power: TeamPower): Promise<boolean>;
}

export interface StaffAccessOptions {
  /** The business the call runs under: the Tool API call's scope (CallContext.businessId). */
  readonly businessId: string;
  /** K-22 v1's team rows, on the call's transaction. */
  readonly reader: StaffReader;
}

/** A team row the service cannot read: refused, naming the column, never a value (default S3). */
export class StaffReadError extends Error {
  override name = "StaffReadError";

  constructor(readonly column: string) {
    super(`unreadable team row: ${column}`);
  }
}

/** Ids are opaque strings (CQ-09); the message names the argument, never its value. */
function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${what} must be a non-empty id`);
  }
}

function isStaffStatus(value: unknown): value is StaffStatus {
  return (STAFF_STATUSES as readonly unknown[]).includes(value);
}

function isTeamPower(value: unknown): value is TeamPower {
  return (TEAM_POWERS as readonly unknown[]).includes(value);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Joined, with the owner's yes, and never while stopped, invited or removed (the top of this file). */
function isOffered(row: StaffOnFile): boolean {
  return row.status === "joined" && row.joinedAt !== null && row.bookableAt !== null;
}

/** The powers a member holds now, in K-22's order, from the live power rows of their own staff row here. */
function heldPowers(row: StaffOnFile, powers: readonly TeamPowerOnFile[]): HeldPower[] {
  if (row.status === "removed") return [];
  const live = powers.filter(
    (power) => power.staffId === row.id && power.businessId === row.businessId && power.endedAt === null,
  );
  const held: HeldPower[] = [];
  for (const name of TEAM_POWERS) {
    const power = live.find((candidate) => candidate.power === name);
    if (power === undefined) continue;
    const over =
      name === "prices" && power.overCents !== null && power.overCurrency !== null
        ? { cents: power.overCents, currency: power.overCurrency }
        : null;
    held.push({ power: name, over });
  }
  return held;
}

export function createStaffAccess(options: StaffAccessOptions): StaffAccess {
  const { businessId, reader } = options;
  assertId(businessId, "businessId");

  /** This business's staff rows by person, each checked (default S3), so a reader without row-level security widens nothing. */
  const rowsHere = async (): Promise<Map<string, StaffOnFile>> => {
    const byPerson = new Map<string, StaffOnFile>();
    for (const row of await reader.staffOfBusiness(businessId)) {
      if (row.businessId !== businessId) continue;
      if (!isStaffStatus(row.status)) throw new StaffReadError("staff.status");
      if (byPerson.has(row.personId)) throw new StaffReadError("staff.person_id");
      byPerson.set(row.personId, row);
    }
    return byPerson;
  };

  /** This business's power rows, each checked (default S3). */
  const powersHere = async (): Promise<TeamPowerOnFile[]> => {
    const rows = (await reader.powersOfBusiness(businessId)).filter((row) => row.businessId === businessId);
    for (const row of rows) {
      if (!isTeamPower(row.power)) throw new StaffReadError("team_powers.power");
    }
    return rows;
  };

  const memberOf = (row: StaffOnFile, powers: readonly TeamPowerOnFile[]): TeamMember => ({
    staffId: row.id,
    personId: row.personId,
    status: row.status,
    bookable: isOffered(row),
    powers: heldPowers(row, powers),
  });

  const team = async (): Promise<TeamMember[]> => {
    const rows = [...(await rowsHere()).values()];
    const powers = await powersHere();
    return rows.sort((a, b) => byText(a.personId, b.personId)).map((row) => memberOf(row, powers));
  };

  const member = async (personId: string): Promise<TeamMember | null> => {
    assertId(personId, "personId");
    const row = (await rowsHere()).get(personId);
    if (row === undefined) return null;
    return memberOf(row, await powersHere());
  };

  return {
    businessId,

    team,

    member,

    async statusOf(personId) {
      return (await member(personId))?.status ?? null;
    },

    async bookable() {
      return (await team()).filter((one) => one.bookable).map((one) => one.personId);
    },

    async isBookable(personId) {
      return (await member(personId))?.bookable ?? false;
    },

    async powersOf(personId) {
      return [...((await member(personId))?.powers ?? [])];
    },

    async holds(personId, power) {
      if (!isTeamPower(power)) throw new TypeError("power must be one of K-22 v1's team powers");
      return ((await member(personId))?.powers ?? []).some((held) => held.power === power);
    },
  };
}

/**
 * The identity-and-access base's AdminPowers port (T-308 facts.ts) over K-22 v1's team rows: whether the owner lets a
 * person decide with a power at a business, by a live power row on that person's staff row there, never once removed.
 * The base asks it only of a live admin (S13-31; RULES 6.8), so staff never decide a business matter whatever row they
 * hold, and an owner-only matter is never asked.
 */
export function teamAdminPowers(reader: StaffReader): AdminPowers {
  return {
    async holds(businessId: string, personId: string, power: AdminPower): Promise<boolean> {
      return createStaffAccess({ businessId, reader }).holds(personId, power);
    },
  };
}
