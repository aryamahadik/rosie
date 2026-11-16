// T-320's terms snapshot (C-096; arch 09 line 457: "Terms snapshot: rules copied in"; K-30 v1 booking_terms and
// booking_terms_rules; S1-21: "A booking keeps the rules it was made with"): the cancel rule copied in, the K-26 rows in
// force named, and a snapshot immutable once taken. The bookings are K-30's own seeds (Dee's skin fade and haircut at
// Lee's Barbershop), read through the catalog's five reads over K-23's, K-25's and K-26's seeds.

import { describe, expect, it } from "vitest";

import {
  checkCatalogWrite,
  createCatalog,
  type CatalogDeps,
  type CatalogReads,
  type TermsSnapshot,
} from "./index";
import type { SnapshotInput } from "./terms";
import {
  BARBERSHOP,
  SEEDS,
  SKIN_FADE_WRITTEN,
  Store,
  ZONE,
  fixtureRows,
  minutesOf,
  readsOf,
  refusalOf,
  seedRows,
  type Row,
} from "./test-support";

const SKIN_FADE_TERMS = "bookings-changes/fixtures/seed-terms-snapshot.json";
const HAIRCUT_TERMS = "bookings-changes/fixtures/seed-booking-line-price-copied.json";

function catalogAt(store: Store, now: string, more: Partial<CatalogDeps> = {}) {
  return createCatalog({
    call: "gateAndCommit",
    businessId: BARBERSHOP,
    currency: "USD",
    now,
    turnKey: "turn-dee-0013",
    reads: readsOf(store),
    ...more,
  });
}

/** Dee's skin fade, booked with Riley at 10:00am Sat Oct 24 (K-30 seed-terms-snapshot). */
const skinFade: SnapshotInput = {
  bookingId: "booking-dee-skin-fade",
  flow: "A",
  serviceId: "svc-lees-skin-fade",
  serviceMoneyId: "way-lees-skin-fade-shop",
  termsConsentId: "consent-dee-ticked-terms-skin-fade",
  termsVersion: "2026-10-19.1",
  termsLanguage: "en",
  noticesShown: [],
  zone: ZONE,
};

/** A fixture's booking_terms row and its booking_terms_rules rows, as the seed holds them. */
function seededTerms(file: string, bookingId: string): { readonly terms: Row; readonly named: Row[] } {
  const rows = fixtureRows(file);
  const terms = rows.find((row) => row.table === "booking_terms" && row.values.booking_id === bookingId);
  if (terms === undefined) throw new Error(`${file} has no snapshot of ${bookingId}`);
  const named = rows
    .filter((row) => row.table === "booking_terms_rules" && row.values.booking_id === bookingId)
    .map((row) => ({ ...row.values }));
  return { terms: { ...terms.values }, named };
}

/** A snapshot's written rows, read back: the terms row (its span in minutes) and the named rows without their ids. */
function writtenTerms(snapshot: TermsSnapshot): { readonly terms: Row; readonly named: Row[] } {
  let terms: Row = {};
  const named: Row[] = [];
  for (const write of snapshot.writes.state) {
    if (write.op !== "insert") throw new Error("a snapshot write that is not an insert");
    if (write.table === "booking_terms") terms = { ...write.values };
    else named.push({ ...write.values });
  }
  return { terms, named };
}

const spanOf = (row: Row): number | null =>
  typeof row.cutoff_before === "string" ? minutesOf(row.cutoff_before) : null;

const withoutId = (row: Row): Row => ({ ...row, id: undefined });

const byRef = (a: Row, b: Row): number =>
  String(a.rule_id ?? a.price_ok_limit_id) < String(b.rule_id ?? b.price_ok_limit_id) ? -1 : 1;

describe("a terms snapshot copies the cancel rule and names the rules in force (K-30 v1; S1-21)", () => {
  it("Dee's skin fade copies the way's own 2 hours and names the four rows in force, not the no-show count from Oct 28", async () => {
    const store = new Store(seedRows(SEEDS));
    const snapshot = await catalogAt(store, SKIN_FADE_WRITTEN).takeTermsSnapshot(skinFade);
    const seeded = seededTerms(SKIN_FADE_TERMS, skinFade.bookingId);
    const written = writtenTerms(snapshot);

    expect({ ...written.terms, cutoff_before: spanOf(written.terms) }).toEqual({
      ...seeded.terms,
      cutoff_before: spanOf(seeded.terms),
    });
    expect(written.named.map(withoutId).sort(byRef)).toEqual(seeded.named.map(withoutId).sort(byRef));
    expect(snapshot.cutoff).toEqual({ from: "way", beforeMinutes: 120, dayBeforeAt: null, zone: null });
    expect(snapshot.ruleIds).not.toContain("rule-lees-barbershop-no-show-count");
    expect(snapshot.priceOkLimitIds).toEqual(["pok-lees-barbershop-quotes"]);
    // It rests on the rows it named and copied, at their versions (limit 4).
    expect(snapshot.writes.versionsRead).toEqual(
      expect.arrayContaining([
        { table: "service_money", rowId: "way-lees-skin-fade-shop", version: 1 },
        { table: "rules", rowId: "rule-lees-barbershop-ok-same-day", version: 1 },
        { table: "price_ok_limits", rowId: "pok-lees-barbershop-quotes", version: 1 },
      ]),
    );
  });

  it("Dee's haircut, whose way has no cancel rule of its own, copies the flow's default 24 hours", async () => {
    const store = new Store(seedRows(SEEDS));
    const snapshot = await catalogAt(store, "2026-10-23T14:05:00Z").takeTermsSnapshot({
      ...skinFade,
      bookingId: "booking-dee-haircut",
      serviceId: "svc-lees-haircut",
      serviceMoneyId: "way-lees-haircut-shop",
      termsConsentId: "consent-dee-ticked-terms-haircut",
    });
    const seeded = seededTerms(HAIRCUT_TERMS, "booking-dee-haircut");
    const written = writtenTerms(snapshot);
    expect({ ...written.terms, cutoff_before: spanOf(written.terms) }).toEqual({
      ...seeded.terms,
      cutoff_before: spanOf(seeded.terms),
    });
    expect(written.named.map(withoutId).sort(byRef)).toEqual(seeded.named.map(withoutId).sort(byRef));
    expect(snapshot.cutoff.from).toBe("flowDefault");
  });

  it("a clock time the day before names the zone it is read in", async () => {
    const store = new Store(seedRows(SEEDS));
    store.put("service_money", {
      ...(store.row("service_money", "way-lees-beard-trim-shop") ?? {}),
      cutoff_day_before_at: "18:00",
    });
    const snapshot = await catalogAt(store, SKIN_FADE_WRITTEN).takeTermsSnapshot({
      ...skinFade,
      bookingId: "booking-dee-beard-trim",
      serviceId: "svc-lees-beard-trim",
      serviceMoneyId: "way-lees-beard-trim-shop",
      termsConsentId: null,
    });
    expect(writtenTerms(snapshot).terms).toMatchObject({
      cutoff_before: null,
      cutoff_day_before_at: "18:00",
      cutoff_zone: ZONE,
    });
  });

  it("with no cancel rule on the way and no default for the flow, copies none (a job sent now)", async () => {
    const store = new Store(seedRows(SEEDS));
    const base = readsOf(store);
    const noDefault: CatalogReads = {
      ...base,
      termsSourcesOf: (businessId, flow, at) =>
        base.termsSourcesOf(businessId, flow, at).then((sources) => ({ ...sources, flowDefault: null })),
    };
    const snapshot = await catalogAt(store, SKIN_FADE_WRITTEN, { reads: noDefault }).takeTermsSnapshot({
      ...skinFade,
      bookingId: "booking-dee-haircut-sent-now",
      serviceId: "svc-lees-haircut",
      serviceMoneyId: "way-lees-haircut-shop",
      termsConsentId: null,
    });
    expect(snapshot.cutoff).toEqual({ from: "none", beforeMinutes: null, dayBeforeAt: null, zone: null });
    expect(writtenTerms(snapshot).terms).toMatchObject({ cutoff_before: null, cutoff_day_before_at: null });
  });

  it("refuses a rule of another business that a leaky read answers, and a way of another flow", async () => {
    const store = new Store(seedRows(SEEDS));
    const leaky = createCatalog({
      call: "gateAndCommit",
      businessId: BARBERSHOP,
      currency: "USD",
      now: SKIN_FADE_WRITTEN,
      turnKey: "turn-dee-0013",
      reads: readsOf(store, [], { scoped: false }),
    });
    await expect(leaky.takeTermsSnapshot(skinFade)).rejects.toMatchObject({ reason: "otherBusiness" });
    await expect(
      catalogAt(store, SKIN_FADE_WRITTEN).takeTermsSnapshot({ ...skinFade, flow: "B" }),
    ).rejects.toMatchObject({ reason: "badInput" });
  });
});

describe("a terms snapshot is immutable once taken (K-30 rule 6; S1-21; RULES 3.7)", () => {
  it("is frozen, writes inserts only, and is never taken twice", async () => {
    const store = new Store(seedRows(SEEDS));
    const catalog = catalogAt(store, SKIN_FADE_WRITTEN);
    const snapshot = await catalog.takeTermsSnapshot(skinFade);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.cutoff)).toBe(true);
    expect(Object.isFrozen(snapshot.ruleIds)).toBe(true);
    expect(snapshot.writes.state.every((write) => Object.isFrozen(write))).toBe(true);
    expect(() => {
      (snapshot as { termsVersion: string }).termsVersion = "2026-11-01.1";
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.ruleIds as string[]).push("rule-lees-barbershop-no-show-count");
    }).toThrow(TypeError);
    expect(snapshot.writes.state.map((write) => [write.op, write.table])).toEqual([
      ["insert", "booking_terms"],
      ["insert", "booking_terms_rules"],
      ["insert", "booking_terms_rules"],
      ["insert", "booking_terms_rules"],
      ["insert", "booking_terms_rules"],
    ]);

    const before = catalog.written();
    await expect(catalog.takeTermsSnapshot(skinFade)).rejects.toMatchObject({ reason: "snapshotTaken" });
    expect(catalog.written()).toEqual(before);
  });

  it("a later rule and a later change to the way leave a snapshot as taken; the next booking's names them", async () => {
    const store = new Store(seedRows(SEEDS));
    const first = await catalogAt(store, SKIN_FADE_WRITTEN).takeTermsSnapshot(skinFade);
    const asTaken = structuredClone(first);

    // Oct 29: Sam gives the skin fade 3 hours to cancel free (S11-56), with the no-show count on since Oct 28.
    const change = await catalogAt(store, "2026-10-29T15:00:00Z", { turnKey: "turn-sam-0400" }).updateWay({
      wayId: "way-lees-skin-fade-shop",
      serviceId: "svc-lees-skin-fade",
      cutoffBeforeMinutes: 180,
    });
    expect(change.writes.state).toEqual([
      {
        op: "update",
        table: "service_money",
        key: { id: "way-lees-skin-fade-shop" },
        expectVersion: 1,
        set: { cutoff_before: "180 minutes" },
      },
    ]);
    store.apply(change.writes.state);

    const next = await catalogAt(store, "2026-10-30T15:00:00Z", {
      turnKey: "turn-dee-0020",
    }).takeTermsSnapshot({
      ...skinFade,
      bookingId: "booking-dee-skin-fade-again",
      termsConsentId: null,
    });
    expect(next.cutoff.beforeMinutes).toBe(180);
    expect(next.ruleIds).toContain("rule-lees-barbershop-no-show-count");
    expect(first).toEqual(asTaken);
    expect(first.cutoff.beforeMinutes).toBe(120);
    expect(first.ruleIds).not.toContain("rule-lees-barbershop-no-show-count");
  });

  it("a way changed earlier in the same call is copied as changed, named at the version the commit compares", async () => {
    const store = new Store(seedRows(SEEDS));
    const catalog = catalogAt(store, "2026-10-29T15:00:00Z");
    const change = await catalog.updateWay({
      wayId: "way-lees-skin-fade-shop",
      serviceId: "svc-lees-skin-fade",
      cutoffBeforeMinutes: 180,
    });
    const snapshot = await catalog.takeTermsSnapshot({
      ...skinFade,
      bookingId: "booking-dee-skin-fade-again",
    });
    expect(snapshot.cutoff.beforeMinutes).toBe(180);
    // The commit compares every version before it writes: the way as read (1), which this call's update also names.
    expect(snapshot.writes.versionsRead).toContainEqual({
      table: "service_money",
      rowId: "way-lees-skin-fade-shop",
      version: 1,
    });
    expect(change.writes.state[0]).toMatchObject({ op: "update", expectVersion: 1 });
    expect(catalog.written().state.map((write) => write.table)).toEqual([
      "service_money",
      "booking_terms",
      "booking_terms_rules",
      "booking_terms_rules",
      "booking_terms_rules",
      "booking_terms_rules",
      "booking_terms_rules",
    ]);
  });

  it("the one gate to the commit refuses any update of a snapshot or its rules", () => {
    const update = (table: string, key: Row, set: Row) => () =>
      checkCatalogWrite({ op: "update", table, key, expectVersion: 1, set });
    expect(
      refusalOf(
        update("booking_terms", { booking_id: "booking-dee-skin-fade" }, { cutoff_before: "24 hours" }),
      ),
    ).toBe("snapshotImmutable");
    expect(
      refusalOf(update("booking_terms_rules", { id: "btr-dee-skin-fade-ok-same-day" }, { rule_id: null })),
    ).toBe("snapshotImmutable");
    expect(refusalOf(update("booking_lines", { id: "line-dee-haircut-1" }, { price_cents: 4000 }))).toBe(
      "notCatalogWrite",
    );
  });
});
