// The terms snapshot (C-096, T-320; arch 09 line 457: "Terms snapshot: rules copied in"; K-30 v1 booking_terms and
// booking_terms_rules; S1-21: "A booking keeps the rules it was made with"; RULES 3.7). Taken once, in the commit that
// writes the booking, and never changed:
//   - it copies the cancel rule in: the way's own free-cancel time (K-25 service_money), else the business's default for
//     the flow (K-23 flow_defaults, H06), else none (a job sent now); a clock time the day before names the zone it is
//     read in (K-30 booking_terms.cutoff_zone);
//   - it names, never copies, every K-26 rule and price OK limit in force at the instant it is written whose scope covers
//     the booking's flow and kind of work (K-26 never edits a row in place, so naming the row in force is an exact copy:
//     K-30 default 11), in id order, so a repeated turn builds the same rows;
//   - its writes are inserts only (rows.ts checkCatalogWrite refuses any update of booking_terms or booking_terms_rules),
//     and the snapshot handed back is frozen, writes included: a later change to a way, a default or a rule opens or
//     changes those rows, never a snapshot already taken.

import type { RowRef, StateWrite } from "../../commit";
import { refuse } from "./errors";
import { inEffectAt } from "./prices";
import { insert, interval, msOf, requireMinutes, requireClock } from "./rows";
import type { Flow, ScopedRow, ServiceRow, TermsSnapshot, TermsSources, WayRow } from "./types";

/** What the booking writer hands in for its snapshot (K-30 v1 booking_terms). */
export interface SnapshotInput {
  /** K-04 bookings.id: one snapshot per booking. */
  readonly bookingId: string;
  readonly flow: Flow;
  /** The booking's key service (its first line: A4-81, B4-114): its kind of work scopes the rules named (default 6). */
  readonly serviceId: string;
  /** The way the key service is booked at (K-25 service_money.id): its own cancel rule wins over the flow's default. */
  readonly serviceMoneyId: string;
  /** K-29 consents.id of kind ticked_terms for this booking; null when nothing was ticked (A5-05; a business's booking). */
  readonly termsConsentId: string | null;
  /** The checked terms text's version, as code names it (K-30 open gaps). */
  readonly termsVersion: string;
  /** The language the terms were shown in, a BCP 47 tag such as en. */
  readonly termsLanguage: string;
  /** Each notice said at booking, word for word as shown, in order; empty: none. */
  readonly noticesShown: readonly string[];
  /** The IANA zone a day-before cancel time is read in: the business's (K-30 booking_terms.cutoff_zone; CQ-05). */
  readonly zone: string;
}

/** Freezes a value and everything in it, so a snapshot once taken cannot be changed through any reference to it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    const inner: unknown[] = Object.values(value);
    for (const each of inner) deepFreeze(each);
  }
  return value;
}

/** The K-26 rows in force at `at` whose scope covers the booking's flow and kind of work, in id order. */
export function inForce(
  rows: readonly ScopedRow[],
  businessId: string,
  flow: Flow,
  kindId: string,
  at: string,
  field: string,
): ScopedRow[] {
  const instant = msOf(at);
  for (const row of rows) if (row.businessId !== businessId) refuse("otherBusiness", [field]);
  return rows
    .filter(
      (row) =>
        (row.flow === null || row.flow === flow) &&
        (row.kindId === null || row.kindId === kindId) &&
        inEffectAt(row, instant),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The cancel rule a snapshot copies: the way's own, else the flow's default, else none. */
function cutoffOf(way: WayRow, sources: TermsSources, businessId: string, flow: Flow, zone: string) {
  const fromParts = (before: number | null, dayBeforeAt: string | null) => ({
    beforeMinutes: before === null ? null : requireMinutes(before, "cutoff.beforeMinutes"),
    dayBeforeAt: dayBeforeAt === null ? null : requireClock(dayBeforeAt, "cutoff.dayBeforeAt"),
    zone: dayBeforeAt === null ? null : zone,
  });
  const defaults = sources.flowDefault;
  if (defaults !== null && defaults.businessId !== businessId) refuse("otherBusiness", ["flowDefault"]);
  if (defaults !== null && defaults.flow !== flow) refuse("badRead", ["flowDefault"]);
  if (way.cutoffBeforeMinutes !== null || way.cutoffDayBeforeAt !== null) {
    if (way.cutoffBeforeMinutes !== null && way.cutoffDayBeforeAt !== null) refuse("twoCutoffs", ["way"]);
    return { from: "way" as const, ...fromParts(way.cutoffBeforeMinutes, way.cutoffDayBeforeAt) };
  }
  if (defaults === null) return { from: "none" as const, beforeMinutes: null, dayBeforeAt: null, zone: null };
  if (defaults.cutoffBeforeMinutes !== null && defaults.cutoffDayBeforeAt !== null)
    refuse("twoCutoffs", ["flowDefault"]);
  return {
    from: "flowDefault" as const,
    ...fromParts(defaults.cutoffBeforeMinutes, defaults.cutoffDayBeforeAt),
  };
}

/**
 * The snapshot of one booking, written at `writtenAt` (the commit that writes the booking), from its key service and
 * way as read and the sources read at that instant. Pure: the service makes the reads.
 */
export function snapshotOf(args: {
  readonly input: SnapshotInput;
  readonly businessId: string;
  readonly writtenAt: string;
  readonly service: ServiceRow;
  readonly way: WayRow;
  readonly sources: TermsSources;
  /** The way's and the service's versions as read, when committed rows (limit 4). */
  readonly versionsRead: readonly RowRef[];
}): TermsSnapshot {
  const { input, businessId, writtenAt, service, way, sources } = args;
  if (way.flow !== input.flow) refuse("badInput", ["flow"]);
  const cutoff = cutoffOf(way, sources, businessId, input.flow, input.zone);
  const rules = inForce(sources.rules, businessId, input.flow, service.kindId, writtenAt, "rules");
  const limits = inForce(
    sources.priceOkLimits,
    businessId,
    input.flow,
    service.kindId,
    writtenAt,
    "priceOkLimits",
  );

  const state: StateWrite[] = [
    insert("booking_terms", {
      booking_id: input.bookingId,
      business_id: businessId,
      terms_consent_id: input.termsConsentId,
      terms_version: input.termsVersion,
      terms_language: input.termsLanguage,
      notices_shown: [...input.noticesShown],
      cutoff_before: cutoff.beforeMinutes === null ? null : interval(cutoff.beforeMinutes),
      cutoff_day_before_at: cutoff.dayBeforeAt,
      cutoff_zone: cutoff.zone,
      written_at: writtenAt,
    }),
    ...rules.map((rule) =>
      insert("booking_terms_rules", {
        id: `btr-${input.bookingId}-rule-${rule.id}`,
        booking_id: input.bookingId,
        business_id: businessId,
        rule_id: rule.id,
        price_ok_limit_id: null,
      }),
    ),
    ...limits.map((limit) =>
      insert("booking_terms_rules", {
        id: `btr-${input.bookingId}-limit-${limit.id}`,
        booking_id: input.bookingId,
        business_id: businessId,
        rule_id: null,
        price_ok_limit_id: limit.id,
      }),
    ),
  ];
  // The snapshot rests on the rows it named at their versions: one closed before the commit is refused (limit 4).
  const versionsRead: RowRef[] = [
    ...args.versionsRead,
    ...rules.map((rule) => ({ table: "rules", rowId: rule.id, version: rule.version })),
    ...limits.map((limit) => ({ table: "price_ok_limits", rowId: limit.id, version: limit.version })),
  ];
  return deepFreeze({
    bookingId: input.bookingId,
    flow: input.flow,
    kindId: service.kindId,
    writtenAt,
    termsConsentId: input.termsConsentId,
    termsVersion: input.termsVersion,
    termsLanguage: input.termsLanguage,
    noticesShown: [...input.noticesShown],
    cutoff,
    ruleIds: rules.map((rule) => rule.id),
    priceOkLimitIds: limits.map((limit) => limit.id),
    writes: { versionsRead, state },
  });
}
