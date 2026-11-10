// Doubles for the safety service's tests (T-318). Never imported by the Worker. No database: an in-memory record built from
// the frozen contracts' seed fixtures (K-04 v1's people, phones, roles and booking heads through T-317's doubles; K-34
// v1's outcomes, holds and pauses: seed-outcome-crisis, seed-hold-released, seed-threat-pause), read the way the
// data-access calls would read it (under a business scope, that business's rows only), and written as K-05's commit would
// write the state rows: an insert adds the row, an update is compared and set on its version. Doubles stand in for ports
// only, never for the code under test. Values come only from the contracts' fixtures and the master's sample cast, in the
// 555-01xx range (rule 9); sealed bytes are short stand-ins, never real ciphertext.

import type { OutboxRowNew, StateWrite } from "../../commit";
import { applied, flagsRecordOf, FLAG_SEEDS, type FlagsRecord, type World } from "../flags/test-support";
import { seedRows } from "../messages-consent/test-support";
import { noWrites } from "../flags";
import type { SafetyIds, SafetyRow } from "./ids";
import { KEYED_SAFETY_IDS } from "./ids";
import {
  FIXED_SAFETY_LINES,
  type OwnerContact,
  type SafetyLineChoice,
  type SafetyLines,
  type SafetyReader,
  type SafetyTelling,
  type SafetyTold,
  type StoredHold,
  type StoredOutcome,
  type TellRequest,
  type WordsSealer,
} from "./ports";
import type { ReleaseRule, ReleasedWhy, SafetyOutcome, Tense } from "./rules";

export const BARBERSHOP = "biz-lees-barbershop";

/** K-34 v1's seeds this card reads (paths under contracts/). */
export const SAFETY_SEEDS = {
  crisis: "db-schema/safety-incidents/fixtures/seed-outcome-crisis.json",
  released: "db-schema/safety-incidents/fixtures/seed-hold-released.json",
  threat: "db-schema/safety-incidents/fixtures/seed-threat-pause.json",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// The record

export interface SafetyRecord {
  readonly outcomes: readonly StoredOutcome[];
  readonly holds: readonly StoredHold[];
  /** Outbox rows written, by id (a repeat's line). */
  readonly outboxRowIds: readonly string[];
  /** Harm reports written, as their values (no business reads them: K-34 rule 4; the team's side does). */
  readonly harmReports: readonly Readonly<Record<string, unknown>>[];
}

/** The world the doubles read and the fake commit writes: T-317's K-04 record and K-34's rows. */
export interface SafetyWorld {
  flags: World;
  safety: SafetyRecord;
  /** K-04 businesses.time_zone, by business. */
  readonly zones: Readonly<Record<string, string>>;
}

type Values = Readonly<Record<string, unknown>>;

const str = (values: Values, column: string): string => {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`column ${column} is not text`);
  return value;
};
const strOrNull = (values: Values, column: string): string | null => {
  const value = values[column];
  return typeof value === "string" ? value : null;
};
const list = <T extends string>(values: Values, column: string): T[] => {
  const value = values[column];
  return Array.isArray(value) ? (value as T[]) : [];
};

function outcomeOf(values: Values): StoredOutcome {
  return {
    id: str(values, "id"),
    eventId: str(values, "event_id"),
    source: str(values, "source") as StoredOutcome["source"],
    handleId: strOrNull(values, "handle_id"),
    personId: strOrNull(values, "person_id"),
    businessId: strOrNull(values, "business_id"),
    bookingId: strOrNull(values, "booking_id"),
    turnId: strOrNull(values, "turn_id"),
    readAt: str(values, "read_at"),
    timedOut: values.timed_out === true,
    labels: list<SafetyOutcome>(values, "labels"),
    tenses: list<Tense>(values, "tenses"),
    dangerWordKinds: list<"selfHarm" | "other">(values, "danger_word_kinds"),
    outcomes: list<SafetyOutcome>(values, "outcomes"),
    liftedToUnsure: values.lifted_to_unsure === true,
  };
}

function holdOf(values: Values): StoredHold {
  const version = values.version;
  return {
    id: str(values, "id"),
    safetyOutcomeId: str(values, "safety_outcome_id"),
    businessId: strOrNull(values, "business_id"),
    handleId: str(values, "handle_id"),
    personId: strOrNull(values, "person_id"),
    bookingId: strOrNull(values, "booking_id"),
    turnId: strOrNull(values, "turn_id"),
    releaseRule: str(values, "release_rule") as ReleaseRule,
    blocksBooking: values.blocks_booking === true,
    heldAt: str(values, "held_at"),
    releasedAt: strOrNull(values, "released_at"),
    releasedWhy: strOrNull(values, "released_why") as ReleasedWhy | null,
    releasedByTurnId: strOrNull(values, "released_by_turn_id"),
    releasedByOutcomeId: strOrNull(values, "released_by_outcome_id"),
    version: typeof version === "number" ? version : 1,
  };
}

/** The world of T-317's K-04 seeds and these K-34 seeds (paths under contracts/). */
export function safetyWorldOf(safetySeeds: readonly string[] = []): SafetyWorld {
  const rows = seedRows(safetySeeds);
  const flags: FlagsRecord = flagsRecordOf([...FLAG_SEEDS, ...safetySeeds]);
  return {
    flags: { record: flags },
    safety: {
      outcomes: rows.filter((row) => row.table === "safety_outcomes").map((row) => outcomeOf(row.values)),
      holds: rows.filter((row) => row.table === "safety_holds").map((row) => holdOf(row.values)),
      outboxRowIds: [],
      harmReports: [],
    },
    // K-34 seed-harm-report.json's day zone for the barbershop.
    zones: { [BARBERSHOP]: "America/New_York" },
  };
}

/** Whether a row is seen under a scope: on the runtime side (null) every row, else that business's only. */
const seen = (scope: string | null, businessId: string | null): boolean =>
  scope === null || businessId === scope;

/** K-34's reads over the world, as the data-access calls would answer them under the scope. */
export function safetyReaderOn(world: SafetyWorld, scope: string | null): SafetyReader {
  const record = (): SafetyRecord => world.safety;
  const flags = (): FlagsRecord => world.flags.record;
  return {
    outcomeOfEvent: (eventId) =>
      Promise.resolve(
        record().outcomes.find((row) => row.eventId === eventId && seen(scope, row.businessId)) ?? null,
      ),
    outcome: (outcomeId) =>
      Promise.resolve(
        record().outcomes.find((row) => row.id === outcomeId && seen(scope, row.businessId)) ?? null,
      ),
    hold: (holdId) =>
      Promise.resolve(record().holds.find((row) => row.id === holdId && seen(scope, row.businessId)) ?? null),
    holdOfOutcome: (outcomeId) =>
      Promise.resolve(
        record().holds.find((row) => row.safetyOutcomeId === outcomeId && seen(scope, row.businessId)) ??
          null,
      ),
    outboxRowWritten: (rowId) => Promise.resolve(record().outboxRowIds.includes(rowId)),
    ownerOf: (businessId) => {
      const role = flags().roles.find(
        (each) => each.businessId === businessId && each.role === "owner" && each.endedAt === null,
      );
      if (role === undefined) return Promise.resolve(null);
      const link = flags().personHandles.find((each) => each.personId === role.personId);
      const owner: OwnerContact | null =
        link === undefined ? null : { personId: role.personId, handleId: link.handleId };
      return Promise.resolve(owner);
    },
    businessZone: (businessId) => Promise.resolve(world.zones[businessId] ?? null),
  };
}

/** A K-05 refusal the fake gives for a stale compare-and-set (limit 4). */
export class StaleHoldError extends Error {
  constructor(
    readonly rowId: string,
    readonly readVersion: number,
    readonly currentVersion: number,
  ) {
    super("version changed");
  }
}

/**
 * The world with a commit's writes applied as K-05 would apply them: K-34's rows here (an insert adds the row, an update
 * of a hold is compared and set on its version, raising it), K-04's through T-317's fake (pauses, bookings), and the
 * outbox rows' ids. The hand-off stand-ins of the telling double are T-319's tables, left out.
 */
export function applySafetyWrites(
  world: SafetyWorld,
  state: readonly StateWrite[],
  outboxRows: readonly OutboxRowNew[] = [],
): void {
  let safety = world.safety;
  const others: StateWrite[] = [];
  for (const write of state) {
    if (write.op === "insert" && write.table === "safety_outcomes") {
      if (
        safety.outcomes.some((row) => row.id === write.values.id || row.eventId === write.values.event_id)
      ) {
        throw new Error("safety_outcomes_event_key: one outcome row per text");
      }
      safety = { ...safety, outcomes: [...safety.outcomes, outcomeOf(write.values)] };
    } else if (write.op === "insert" && write.table === "safety_holds") {
      safety = { ...safety, holds: [...safety.holds, holdOf(write.values)] };
    } else if (write.op === "insert" && write.table === "harm_reports") {
      safety = { ...safety, harmReports: [...safety.harmReports, { ...write.values }] };
    } else if (write.op === "update" && write.table === "safety_holds") {
      const hold = safety.holds.find((row) => row.id === write.key.id);
      if (hold === undefined) throw new Error("no such hold");
      if (hold.version !== write.expectVersion) {
        throw new StaleHoldError(hold.id, write.expectVersion, hold.version);
      }
      const moved = holdOf({
        ...holdValues(hold),
        ...write.set,
        version: hold.version + 1,
      });
      safety = { ...safety, holds: safety.holds.map((row) => (row.id === hold.id ? moved : row)) };
    } else if (write.table === "hand_offs" || write.table === "team_pages") {
      continue;
    } else {
      others.push(write);
    }
  }
  world.flags.record = applied(world.flags.record, others);
  world.safety = { ...safety, outboxRowIds: [...safety.outboxRowIds, ...outboxRows.map((row) => row.id)] };
}

/** A stored hold as its column values. */
function holdValues(hold: StoredHold): Record<string, unknown> {
  return {
    id: hold.id,
    safety_outcome_id: hold.safetyOutcomeId,
    business_id: hold.businessId,
    handle_id: hold.handleId,
    person_id: hold.personId,
    booking_id: hold.bookingId,
    turn_id: hold.turnId,
    release_rule: hold.releaseRule,
    blocks_booking: hold.blocksBooking,
    held_at: hold.heldAt,
    released_at: hold.releasedAt,
    released_why: hold.releasedWhy,
    released_by_turn_id: hold.releasedByTurnId,
    released_by_outcome_id: hold.releasedByOutcomeId,
    version: hold.version,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The other ports' doubles

export interface FakeSealer extends WordsSealer {
  /** Every seal asked for, in order: the plaintext, whose key, and the stand-in bytes given back. */
  readonly calls: { readonly plaintext: string; readonly forPersonId: string; readonly bytes: Uint8Array }[];
}

/**
 * A sealer whose bytes stand in for db/repo/sealing.ts's sealed form: a format byte, the call's number and the person's
 * id, never the plaintext, so a test can find exactly where the sealed value went.
 */
export function fakeSealer(): FakeSealer {
  const calls: { plaintext: string; forPersonId: string; bytes: Uint8Array }[] = [];
  const encoder = new TextEncoder();
  return {
    calls,
    seal(plaintext, forPersonId) {
      const bytes = Uint8Array.from([0x01, calls.length + 1, ...encoder.encode(`stand-in:${forPersonId}`)]);
      calls.push({ plaintext, forPersonId, bytes });
      return Promise.resolve(bytes);
    },
  };
}

/** The ids a K-09 fixture names for an event's rows; any other row takes the Worker's keyed id. */
export function fixtureSafetyIds(
  named: Readonly<Record<string, Partial<Record<SafetyRow, string>>>>,
): SafetyIds {
  return {
    rowId(row, eventId) {
      const id = named[eventId]?.[row];
      return id === undefined ? KEYED_SAFETY_IDS.rowId(row, eventId) : Promise.resolve(id);
    },
  };
}

/**
 * The pinned bundle's checked lines as a double: K-01 v1's fixed lines (FIXED_SAFETY_LINES) and stand-in ids for the
 * step cards' lines the K-09 fixtures name (threatSafetyLine, safetyOwnLine) or that no fixture names yet (the hotline
 * and unsafe-at-home lines). A threat's line goes to the owner (A3-48: san to owner).
 */
export const TEST_LINES: SafetyLines = {
  lineOf(outcome, wordKinds) {
    const writer = (fixedLineId: string, hotline: SafetyLineChoice["hotline"] = null): SafetyLineChoice => ({
      fixedLineId,
      to: "writer",
      hotline,
    });
    switch (outcome) {
      case "A threat to staff or others":
        return { fixedLineId: "threatSafetyLine", to: "owner", hotline: null };
      case "Harm to a child or older adult":
        return writer("safetyHotlineLine", "elder_care");
      case "Unsafe at home":
        return writer("safetyUnsafeAtHomeLine", "family_violence");
      case "Needs the business's own line":
        return writer("safetyOwnLine");
      case "Safety steps, then go on":
        return null;
      default:
        return FIXED_SAFETY_LINES.lineOf(outcome, wordKinds);
    }
  },
  outageLine: () => "outage",
};

export interface FakeTelling extends SafetyTelling {
  /** Every request, in order. */
  readonly requests: TellRequest[];
}

/**
 * T-319's hand-offs and pages as a double: the owner through a hand-off (`handoff-<event id>`, or the id named), and for
 * crisis words Rosie's team through a page too (arch 06 line 329), each written as a stand-in row of K-36's tables.
 */
export function fakeTelling(named: Readonly<Record<string, string>> = {}): FakeTelling {
  const requests: TellRequest[] = [];
  return {
    requests,
    tell(request) {
      requests.push(structuredClone(request));
      const handOffId = named[request.eventId] ?? `handoff-${request.eventId}`;
      const told: SafetyTold[] = [{ who: "owner", via: "handOff", id: handOffId }];
      const crisis = request.outcomes.includes("Crisis words");
      if (crisis) told.push({ who: "team", via: "teamPage", id: `page-${request.eventId}` });
      const writes = noWrites("A3-22");
      return Promise.resolve({
        told,
        writes: request.repeated
          ? writes
          : {
              ...writes,
              state: [
                {
                  op: "insert" as const,
                  table: "hand_offs",
                  values: { id: handOffId, safety_outcome_id: request.outcomeId },
                },
                ...(crisis
                  ? [
                      {
                        op: "insert" as const,
                        table: "team_pages",
                        values: { id: `page-${request.eventId}`, safety_outcome_id: request.outcomeId },
                      },
                    ]
                  : []),
              ],
            },
      });
    },
  };
}
