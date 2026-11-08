// The money home (T-593; S13-55), on T-137's compiled record as the merged emitter writes it (fixture set v1's master
// flows). Proofs of the card:
//   - each pay.* row of A-record.json is chosen for its when conditions: on every money path the master walks, read
//     alone, with each booking value the money rows read and riding each record fixture, before the money step, after
//     it and before the write, the module's record values, ledger and row of each money slot are the master's own
//     reading of the same record (the vendored recordOf() and slotRow()); and every row of every pay.* slot of the A
//     record is the row some booking takes;
//   - a deposit booking's fee never exceeds the deposit;
//   - a card-saved booking with no fee says nothing about a fee;
//   - a message naming a card hold or a charge on silence fails the check.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { isLabel } from "../../../../runtime/src/trace";
import { createHomeRegistry, type HomeLogLine } from "../registry";
import {
  A7_11_CLAIMS,
  A7_11_CONTRADICTING,
  contactStandIn,
  contradictingA711,
  objAt,
  type HomeContext,
} from "../registry/test-support";
import {
  FOUR_WAYS,
  MONEY_POINTS,
  MoneyHomeError,
  approvedMoneyLines,
  checkMoneyLine,
  checkMoneyText,
  gateMoneyText,
  readApprovedLines,
  sentencesOf,
  type ApprovedMoneyLines,
  type MoneyGate,
  firstFit,
  fourWays,
  ledgerFacts,
  linesForBooking,
  moneyClaims,
  moneyHome,
  moneyLines,
  moneyTaken,
  readMoney,
  readMoneyRecord,
  recordReading,
  type MoneyBooking,
  type MoneyHomeContext,
  type MoneyReading,
  type MoneyRecord,
} from "./index";
import {
  CURRENCY,
  PATH_VARIANTS,
  S13_55_LINES,
  STAMPS,
  amountsOf,
  bookingOf,
  laundryB,
  moneyPathsOf,
  pathOf,
  referenceOf,
  sources,
  usd,
  type Sources,
} from "./test-support";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FLOWS = ["A", "B"] as const;
type Flow = (typeof FLOWS)[number];

let src: Sources;

beforeAll(async () => {
  src = await sources();
});

function record(flow: Flow): MoneyRecord {
  return src.records[flow];
}

/** A booking of one service on a flow's money path, its amounts from the flow's own amount table. */
function oneService(flow: Flow, money: string, took = true): MoneyBooking {
  const path = pathOf(src, flow, money);
  if (path === null) throw new Error(`${flow} ${money} is not a path`);
  return bookingOf(src, flow, path, { took });
}

/** A booking from a path text, as the master reads it. */
function bookingAt(flow: Flow, text: string, took = true): MoneyBooking {
  const path = pathOf(src, flow, text);
  if (path === null) throw new Error(`${flow} ${text} is not a path`);
  return bookingOf(src, flow, path, { took });
}

interface Compared {
  readonly flow: Flow;
  readonly label: string;
  readonly money: MoneyReading;
  readonly rows: Readonly<Record<string, number | null>>;
}

/** Every reading compared with the master's own, per flow, made once by the first test that asks for it. */
const comparedSoFar: Record<Flow, Compared[] | null> = { A: null, B: null };

/** The flow's readings, each held to the master's own reading of the same path (the comparison runs once per flow). */
function comparedOf(flow: Flow): readonly Compared[] {
  const done = comparedSoFar[flow];
  if (done !== null) return done;
  const made: Compared[] = [];
  compareFlow(flow, made);
  comparedSoFar[flow] = made;
  return made;
}

function compareFlow(flow: Flow, out: Compared[]): void {
  const money = record(flow);
  const slots = money.moneySlots;
  for (const combo of moneyPathsOf(src, flow))
    for (const variant of PATH_VARIANTS) {
      const text = `${combo} ${variant}`.trim();
      const path = pathOf(src, flow, text);
      if (path === null) continue;
      for (const stamps of STAMPS) {
        const label = `${flow} ${text} ${JSON.stringify(stamps)}`;
        const booking = bookingOf(src, flow, path, stamps);
        const reading = readMoney(booking, money);
        const expected = referenceOf(src, flow, path, stamps, slots);
        expect([...reading.values].sort(), label).toEqual([...expected.values].sort());
        const ledger = Object.fromEntries(
          (["paidnow", "due", "keep", "back", "later", "backlate"] as const).map((name) => [
            name,
            reading.ledger[name]?.cents ?? null,
          ]),
        );
        expect(ledger, label).toEqual(expected.ledger);
        const reader = recordReading(reading, money);
        const rows = Object.fromEntries(slots.map((slot) => [slot, firstFit(reader, slot)]));
        expect(rows, label).toEqual(expected.rows);
        out.push({ flow, label, money: reading, rows });
      }
    }
}

describe("the money home reads T-137's compiled record", () => {
  it("both flows: the money home's step S13-55, its 11 pay.* slots, the four ways and credit, one fee", () => {
    for (const flow of FLOWS) {
      const money = record(flow);
      expect(money.home).toBe("S13-55");
      expect(money.moneySlots).toEqual([
        "pay.asks",
        "pay.price",
        "pay.took",
        "pay.left",
        "pay.cancel",
        "pay.late",
        "pay.noshow",
        "pay.back",
        "pay.after",
        "pay.staff",
        "pay.failed",
      ]);
      expect(Object.keys(money.ways)).toEqual(["none", "card", "deposit", "full", "credit"]);
      expect(money.ways).toEqual(objAt(src.flows[flow], ["record", "ways"]));
    }
  });

  it("refuses a record that is not one fee per booking, holds a card or misses a way, naming each problem", () => {
    const base = structuredClone(src.flows.A.record) as Record<string, unknown>;
    const problemsOf = (change: (raw: Record<string, unknown>) => void): readonly string[] => {
      const raw = structuredClone(base);
      change(raw);
      try {
        readMoneyRecord("A", raw);
        return [];
      } catch (error) {
        if (error instanceof MoneyHomeError) return error.problems;
        throw error;
      }
    };
    expect(problemsOf(() => undefined)).toEqual([]);
    expect(problemsOf((raw) => (raw.onefee = false))).toEqual([
      "onefee is not true: the record does not hold one fee per booking (S13-55)",
    ]);
    expect(
      problemsOf((raw) => {
        (raw.ways as Record<string, unknown>).hold = { now: "0", card: true, fee: "fee", back: "0" };
      }),
    ).toEqual(["way hold is refused (D66: nothing is held on a card)"]);
    expect(
      problemsOf((raw) => {
        const slots = raw.slots as Record<string, { rows: { text: string }[] }>;
        slots["pay.took"]?.rows.unshift({ text: "{{hold:$40}} is held on your card" });
      }),
    ).toEqual(["slot pay.took row 1 holds a card hold slot (D66: nothing is held)"]);
    expect(
      problemsOf((raw) => {
        delete (raw.ways as Record<string, unknown>).deposit;
      }),
    ).toEqual(["way deposit is missing"]);
  });
});

describe("each pay.* row of A-record.json is chosen for its when conditions", () => {
  it("the emitted A record's money rows are A-record.json's own, row for row, the sample names slots (T-142)", () => {
    const raw = JSON.parse(
      readFileSync(`${ROOT}fixtures/master/engine/work/master/master-A.json`, "utf8"),
    ) as { record: { slots: Record<string, { rows: { when?: unknown; text: string }[] }> } };
    // The emitted words are the master's, each slot the master does not hold standing for its sample words.
    const slottedFrom = (emitted: string, master: string): boolean => {
      const source = emitted
        .split(/(\{\{[^{}]*\}\})/)
        .map((part) =>
          /^\{\{[^{}]*\}\}$/.test(part) && !master.includes(part)
            ? "(.+?)"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      return new RegExp(`^${source}$`).test(master);
    };
    let changed = 0;
    for (const slot of record("A").moneySlots) {
      const master = raw.record.slots[slot]?.rows ?? [];
      const emitted = record("A").rows[slot] ?? [];
      expect(
        emitted.map((row) => row.when),
        slot,
      ).toEqual(master.map((row) => row.when));
      expect(emitted.length, slot).toBe(master.length);
      emitted.forEach((row, index) => {
        const words = master[index]?.text ?? "";
        expect(slottedFrom(row.text, words), `${slot} ${String(index)}`).toBe(true);
        if (row.text !== words) changed += 1;
      });
    }
    expect(changed).toBeGreaterThan(0);
  });

  it.each(FLOWS)(
    "flow %s: on every money path, booking value and fixture, before and after the money step, the module reads the master's record values, ledger and rows",
    (flow) => {
      expect(comparedOf(flow).length).toBeGreaterThan(500);
    },
  );

  it("every row of every pay.* slot of the A record is the row some booking takes, and only where its when fits", () => {
    const money = record("A");
    // Flow A's own bookings take every row but the six that read the after 'own' (the business bills its own way),
    // which only flow B's paths have (lib.js AFTER_IN); flow B's bookings take those, read on the A record's rows.
    const takenBy = (readings: readonly Compared[]): Map<string, Set<number>> => {
      const taken = new Map<string, Set<number>>();
      for (const { money: reading } of readings) {
        const reader = recordReading(reading, money);
        for (const slot of money.moneySlots) {
          const row = firstFit(reader, slot);
          if (row === null) continue;
          taken.set(slot, (taken.get(slot) ?? new Set<number>()).add(row));
        }
      }
      return taken;
    };
    const byA = takenBy(comparedOf("A"));
    const byBoth = takenBy([...comparedOf("A"), ...comparedOf("B")]);
    const missedByA: string[] = [];
    for (const slot of money.moneySlots) {
      const count = money.rows[slot]?.length ?? 0;
      expect(count, slot).toBeGreaterThan(0);
      const all = Array.from({ length: count }, (_, row) => row);
      expect(
        [...(byBoth.get(slot) ?? [])].sort((a, b) => a - b),
        slot,
      ).toEqual(all);
      for (const row of all)
        if (!(byA.get(slot)?.has(row) ?? false)) missedByA.push(`${slot} ${String(row)}`);
    }
    expect(missedByA).toEqual([
      "pay.price 6",
      "pay.price 12",
      "pay.left 7",
      "pay.staff 6",
      "pay.staff 11",
      "pay.staff 16",
    ]);
    for (const missed of missedByA) {
      const [slot = "", row = ""] = missed.split(" ");
      expect(money.rows[slot as keyof typeof money.rows]?.[Number(row)]?.text, missed).toMatch(/own way$/);
    }
    // A row is taken only where its own when fits and no earlier row's does: the reader on that row alone agrees.
    for (const { label, money: reading, rows } of comparedOf("A").slice(0, 400)) {
      const reader = recordReading(reading, money);
      for (const [slot, row] of Object.entries(rows)) {
        if (row === null) continue;
        const all = reader.rows[slot as keyof typeof reader.rows] ?? [];
        for (let earlier = 0; earlier <= row; earlier += 1) {
          const alone = { ...reader, rows: { ...reader.rows, [slot]: [all[earlier]] } };
          expect(
            firstFit(alone, slot as keyof typeof reader.rows),
            `${label} ${slot} ${String(earlier)}`,
          ).toBe(earlier === row ? 0 : null);
        }
      }
    }
  });

  it("a money slot's line is its first-fit row, refused only where the row claims what the booking did not take", () => {
    const refusedRows = new Set<string>();
    const refusedOnceTaken = new Set<string>();
    for (const flow of FLOWS)
      for (const { money: reading, rows } of comparedOf(flow)) {
        for (const line of moneyLines(reading, record(flow))) {
          expect(line.row).toBe(rows[line.slot]);
          if (line.ok) {
            expect(line.text).toBe(record(flow).rows[line.slot]?.[line.row]?.text);
            expect(checkMoneyLine(line.text, reading).ok).toBe(true);
            continue;
          }
          expect(line.why).toBe("claims");
          expect(line.refused.length).toBeGreaterThan(0);
          for (const refusal of line.refused) expect(refusal.why).toBe("notTaken");
          refusedRows.add(`${flow} ${line.slot} ${String(line.row)}`);
          if (reading.took) refusedOnceTaken.add(`${flow} ${line.slot} ${String(line.row)}`);
          else if (!(line.slot === "pay.late" && line.row === 3))
            for (const refusal of line.refused)
              expect(["depositPaid", "paidInFull"]).toContain(refusal.claim);
        }
      }
    // pay.late's last row names a fee and a saved card; it has no row for a booking with no fee (pay.noshow has one,
    // "won't charge anything"), so a booking with no card or no fee is refused it. From the money step on, it is the
    // only row refused.
    expect([...refusedOnceTaken].sort()).toEqual(["A pay.late 3", "B pay.late 3"]);
    // Round 3 (DL-182, 2): before the money step, the records' statement rows ("{{deposit}} deposit paid, ...", "Paid in
    // full · nothing to collect") would say money was taken that was only asked for, so they are refused there too.
    expect([...refusedRows].sort()).toEqual([
      "A pay.late 3",
      "A pay.staff 10",
      "A pay.staff 12",
      "A pay.staff 8",
      "A pay.staff 9",
      "A pay.took 7",
      "A pay.took 8",
      "B pay.late 3",
      "B pay.staff 10",
      "B pay.staff 11",
      "B pay.staff 12",
      "B pay.staff 9",
      "B pay.took 7",
      "B pay.took 8",
    ]);
    const late = record("A").rows["pay.late"]?.[3]?.text ?? "";
    expect(moneyClaims(late)).toEqual(["cardSaved", "fee"]);
  });
});

describe("the one fee: the largest service fee, never above what was paid now", () => {
  it("a deposit booking's fee never exceeds the deposit, on every deposit booking of both flows", () => {
    let deposits = 0;
    for (const flow of FLOWS)
      for (const { label, money: reading } of comparedOf(flow)) {
        const paidNow = reading.ledger.paidnow;
        const fee = reading.oneFee.amount;
        if (paidNow !== null && paidNow.cents > 0 && fee !== null)
          expect(fee.cents, label).toBeLessThanOrEqual(paidNow.cents);
        for (const service of reading.services) {
          if (service.way !== "deposit" || !service.paysNow) continue;
          deposits += 1;
          const deposit = service.now;
          if (fee === null || deposit === null) continue;
          if (reading.services.every((other) => other === service || !other.paysNow))
            expect(fee.cents, label).toBeLessThanOrEqual(deposit.cents);
        }
      }
    expect(deposits).toBeGreaterThan(50);
  });

  it("a deposit of $40 with a service whose fee is $89 (flow B, two-card): the fee is the $40 deposit, capped", () => {
    const reading = readMoney(bookingAt("B", "list|deposit|bill +two-card"), record("B"));
    expect(reading.services.map((service) => [service.id, service.way, service.fee?.cents])).toEqual([
      ["own", "deposit", 4000],
      ["b-add", "card", 8900],
    ]);
    expect(reading.ledger.paidnow).toEqual(usd(4000));
    expect(reading.oneFee).toEqual({ applies: true, amount: usd(4000), capped: true, from: "paidNow" });
    expect(reading.ledger.backlate).toEqual(usd(0));
  });

  it("two services' fees differ: the largest counts (flow A list|deposit|counter with two-card: $40 over $20)", () => {
    const reading = readMoney(bookingAt("A", "list|deposit|counter +two-card"), record("A"));
    expect(reading.services.map((service) => service.fee?.cents)).toEqual([4000, 2000]);
    expect(reading.oneFee).toEqual({ applies: true, amount: usd(4000), capped: false, from: "paidNow" });
  });

  it("a deposit service with no fee of its own: its deposit is the fee", () => {
    const amounts = amountsOf({ price: "$140", deposit: "$40", rest: "$100" });
    const booking: MoneyBooking = {
      flow: "A",
      currency: CURRENCY,
      services: [{ id: "own", price: "list", before: "deposit", after: "counter", paidBy: "money", amounts }],
      took: true,
    };
    expect(readMoney(booking, record("A")).oneFee).toEqual({
      applies: true,
      amount: usd(4000),
      capped: false,
      from: "paidNow",
    });
  });

  it("nothing taken and no card: no fee; a card saved and nothing paid now: the saved card, only with the owner's yes", () => {
    const none = readMoney(oneService("A", "list|none|counter"), record("A"));
    expect(none.oneFee).toEqual({ applies: false, amount: usd(0), capped: false, from: "none" });
    expect(none.values).toEqual(["nothing", "rest", "written"]);
    const card = readMoney(oneService("A", "list|card|counter"), record("A"));
    expect(card.oneFee).toEqual({ applies: true, amount: usd(2000), capped: false, from: "savedCard" });
    expect(ledgerFacts(card)).toEqual({
      paidnow: usd(0),
      due: usd(3500),
      keep: usd(2000),
      back: usd(0),
      later: usd(0),
      backlate: usd(0),
    });
  });
});

describe("the four ways' effects", () => {
  it("nothing, a card saved, a deposit, the full price: what each takes now, saves, may keep and gives back", () => {
    const table = src.table("A");
    const at = (money: string) => {
      const [price, before, after] = money.split("|");
      return amountsOf(src.ref.amountRow(table, { price, before, after }));
    };
    expect(FOUR_WAYS).toEqual(["none", "card", "deposit", "full"]);
    const effects = {
      none: fourWays(record("A"), at("list|none|counter"), CURRENCY).none,
      card: fourWays(record("A"), at("list|card|counter"), CURRENCY).card,
      deposit: fourWays(record("A"), at("list|deposit|counter"), CURRENCY).deposit,
      full: fourWays(record("A"), at("list|full|none"), CURRENCY).full,
    };
    expect(effects).toEqual({
      none: { way: "none", now: usd(0), card: false, fee: usd(0), back: usd(0) },
      card: { way: "card", now: usd(0), card: true, fee: usd(2000), back: usd(0) },
      deposit: { way: "deposit", now: usd(4000), card: true, fee: usd(4000), back: usd(4000) },
      full: { way: "full", now: usd(5500), card: false, fee: usd(2000), back: usd(5500) },
    });
    // Each way's effect is what the booking of that one service reads.
    for (const [way, money] of [
      ["none", "list|none|counter"],
      ["card", "list|card|counter"],
      ["deposit", "list|deposit|counter"],
      ["full", "list|full|none"],
    ] as const) {
      const [service] = readMoney(oneService("A", money), record("A")).services;
      expect(
        service && {
          way: service.way,
          now: service.now,
          card: service.card,
          fee: service.fee,
          back: service.back,
        },
      ).toEqual(effects[way]);
    }
  });

  it("a pack credit adds nothing to what is due or paid now; a way the record does not have is refused", () => {
    const reading = readMoney(bookingAt("A", "list|card|counter +credit-plus"), record("A"));
    const credit = reading.services.find((service) => service.credit);
    expect(credit && [credit.way, credit.now, credit.due]).toEqual(["credit", usd(0), usd(0)]);
    const ways = Object.fromEntries(Object.entries(record("A").ways).filter(([name]) => name !== "card"));
    expect(() => fourWays({ ...record("A"), ways }, {}, CURRENCY)).toThrow(
      "the record has no money way card",
    );
  });

  it("refuses amounts that are not whole cents in the booking's currency, naming no amount", () => {
    const booking = oneService("A", "list|card|counter");
    const [own] = booking.services;
    if (own === undefined) throw new Error("no service");
    const bad = (amounts: object): MoneyBooking => ({ ...booking, services: [{ ...own, amounts }] });
    expect(() => readMoney(bad({ fee: { cents: 20.5, currency: CURRENCY } }), record("A"))).toThrow(
      "the fee amount of service own is not whole cents",
    );
    expect(() => readMoney(bad({ fee: { cents: 2000, currency: "EUR" } }), record("A"))).toThrow(
      "the fee amount of service own is not in the booking's currency",
    );
    expect(() => readMoney(booking, record("B"))).toThrow("a flow A booking was given the flow B record");
    // An error never carries words or an amount: an id or a point that is not a label is not named.
    expect(() =>
      readMoney({ ...booking, services: [{ ...own, id: "Alex's $35 haircut" }] }, record("A")),
    ).toThrow("a service's id is not a label");
    expect(() => moneyHome().rule("the fee is $20", { money: readMoney(booking, record("A")) })).toThrow(
      "the point given is not a point of the money home",
    );
  });
});

describe("a card-saved booking with no fee says nothing about a fee", () => {
  it("the laundry trade's flow B (list|card|card, $35, fee free): no line names a fee; pay.late's fee line is refused", () => {
    const laundry = laundryB();
    expect(laundry.main).toBe("list|card|card");
    expect(laundry.example).toContain("A card is saved, with no fee.");
    for (const took of [false, true]) {
      const booking: MoneyBooking = {
        flow: "B",
        currency: CURRENCY,
        services: [
          {
            id: "own",
            price: "list",
            before: "card",
            after: "card",
            paidBy: "money",
            amounts: laundry.amounts,
          },
        ],
        took,
      };
      const reading = readMoney(booking, record("B"));
      expect(reading.values).toEqual(took ? ["card", "rest", "written"] : ["card", "rest"]);
      expect(reading.oneFee).toEqual({ applies: false, amount: usd(0), capped: false, from: "none" });
      const lines = linesForBooking(booking, record("B"));
      for (const line of lines) {
        if (!line.ok) continue;
        expect(line.claims, line.slot).not.toContain("fee");
        expect(line.text, line.slot).not.toMatch(/\{\{\s*keep\s*\}\}/);
      }
      const bySlot = Object.fromEntries(lines.map((line) => [line.slot, line]));
      expect(bySlot["pay.late"]).toEqual({
        slot: "pay.late",
        ok: false,
        row: 3,
        refused: [{ claim: "fee", why: "notTaken" }],
        why: "claims",
      });
      expect(bySlot["pay.asks"]).toMatchObject({ ok: true, text: "A card is saved when you book" });
      expect(bySlot["pay.took"]).toMatchObject({ ok: true, text: "The card is saved" });
      expect(bySlot["pay.noshow"]).toMatchObject({
        ok: true,
        text: "won't charge anything",
        claims: ["noFee"],
      });
      expect(bySlot["pay.cancel"]).toMatchObject({ ok: true, claims: ["noFee"] });
      // With the master's $89 fee the same booking does name it.
      const [own] = booking.services;
      if (own === undefined) throw new Error("the laundry booking has no service");
      const withFee = readMoney(
        { ...booking, services: [{ ...own, amounts: { ...laundry.amounts, fee: usd(8900) } }] },
        record("B"),
      );
      expect(moneyLines(withFee, record("B")).find((line) => line.slot === "pay.took")).toMatchObject({
        ok: true,
        text: "The card is saved for a {{keep}} fee",
        claims: ["cardSaved", "fee"],
      });
    }
  });

  it("a message that names a fee for that booking fails the check; one that says there is none passes", () => {
    const laundry = laundryB();
    const reading = readMoney(
      {
        flow: "B",
        currency: CURRENCY,
        services: [
          {
            id: "own",
            price: "list",
            before: "card",
            after: "card",
            paidBy: "money",
            amounts: laundry.amounts,
          },
        ],
        took: true,
      },
      record("B"),
    );
    expect(
      checkMoneyLine("Free to cancel until Fri 11am, then a $89 fee may apply.", reading).refused,
    ).toEqual([{ claim: "fee", why: "notTaken" }]);
    expect(checkMoneyLine("No fee to cancel or miss. The card is saved.", reading)).toEqual({
      ok: true,
      claims: ["cardSaved", "noFee"],
      refused: [],
    });
  });
});

describe("a message naming a card hold or a charge on silence fails the check", () => {
  const HOLDS = [
    "A $40 hold is placed on your card until the visit.",
    "We hold {{deposit}} on your saved card until Sat 11:00am.",
    "Your card hold is released after the visit.",
    "{{hold}} is held on your card",
    "We pre-authorize your card for the haircut.",
  ];
  const SILENCES = [
    A7_11_CONTRADICTING,
    "If you don't reply by Fri 11am, we'll charge the $20 fee to your card.",
    "Not answered by 7pm: the visit is cancelled and the deposit is kept.",
  ];

  function readings(): MoneyReading[] {
    return [
      readMoney(oneService("A", "list|card|counter"), record("A")),
      readMoney(oneService("A", "list|deposit|counter"), record("A")),
      readMoney(oneService("A", "list|full|none"), record("A")),
      readMoney(oneService("B", "list|none|bill"), record("B")),
      readMoney(bookingAt("A", "list|card|counter +credit-plus"), record("A")),
    ];
  }

  it("a card hold fails the check on every booking", () => {
    for (const reading of readings())
      for (const text of HOLDS) {
        const check = checkMoneyLine(text, reading);
        expect(check.ok, text).toBe(false);
        expect(check.refused, text).toContainEqual({ claim: "cardHold", why: "neverHold" });
      }
  });

  it("a charge on silence fails the check on every booking (the registry's A7-11 fixture line among them)", () => {
    for (const reading of readings())
      for (const text of SILENCES) {
        const check = checkMoneyLine(text, reading);
        expect(check.ok, text).toBe(false);
        expect(check.refused, text).toContainEqual({ claim: "chargeOnSilence", why: "neverChargeOnSilence" });
      }
  });

  it("S13-55's own lines, the master's silence words and every row of both records name neither", () => {
    const words = [
      ...S13_55_LINES,
      "Cancelled late. Any fee is Sam's call (S11-22); silence charges nothing.",
      "No fee follows silence to a message they couldn't get.",
      "Your spot is held for you. Hold on to this text",
      "If you don't answer, nothing is charged.",
      "If you don't reply, the bill comes after the visit.",
      "We never place a hold on your card.",
    ];
    for (const text of words) {
      expect(moneyClaims(text), text).not.toContain("cardHold");
      expect(moneyClaims(text), text).not.toContain("chargeOnSilence");
    }
    for (const flow of FLOWS)
      for (const rows of Object.values(record(flow).rows))
        for (const row of rows) {
          expect(moneyClaims(row.text), row.text).not.toContain("cardHold");
          expect(moneyClaims(row.text), row.text).not.toContain("chargeOnSilence");
          expect(moneyClaims(row.text), row.text).not.toContain("feePerService");
        }
  });

  it("a money line the booking did not take fails; the same line on a booking that took it passes", () => {
    const card = readMoney(oneService("A", "list|card|counter"), record("A"));
    const deposit = readMoney(oneService("A", "list|deposit|counter"), record("A"));
    const full = readMoney(oneService("A", "list|full|none"), record("A"));
    expect(checkMoneyLine("Your $40 deposit was paid.", card).refused).toEqual([
      { claim: "depositPaid", why: "notTaken" },
    ]);
    expect(checkMoneyLine("Your $40 deposit was paid.", deposit).ok).toBe(true);
    expect(checkMoneyLine("Paid in full when you book: $55", deposit).refused).toEqual([
      { claim: "paidInFull", why: "notTaken" },
    ]);
    expect(checkMoneyLine("Paid in full when you book: $55", full).ok).toBe(true);
    expect(checkMoneyLine("Nothing taken, no card saved", card).refused).toEqual([
      { claim: "noCardSaved", why: "notTaken" },
    ]);
    expect(checkMoneyLine("The $40 you paid goes back to the card it was paid with.", card).refused).toEqual([
      { claim: "paidNow", why: "notTaken" },
      { claim: "backToCard", why: "notTaken" },
    ]);
    expect(checkMoneyLine("Each service's own terms apply.", deposit).refused).toEqual([
      { claim: "feePerService", why: "oneFeePerBooking" },
    ]);
  });

  // Round 2 (DL-179, GAP 1): holds and charges on silence read by meaning, after the Values check's apostrophe folding.

  /** The security reviewer's lines (a) to (e) on round 1, each with the claim it makes. */
  const REVIEWER_LINES = [
    ["Your card will be held for $40 until the visit.", "cardHold"],
    ["Your saved card is held for {{deposit}} until Sat 11:00am.", "cardHold"],
    ["If you don't reply by Fri 11am, we'll charge the $20 fee to your card.", "chargeOnSilence"],
    [
      "If you haven't answered within 24 hours, the late-cancel fee is charged to the saved card.",
      "chargeOnSilence",
    ],
    ["If we don't get a reply by 7pm, we'll charge your card.", "chargeOnSilence"],
  ] as const;
  const WHY = { cardHold: "neverHold", chargeOnSilence: "neverChargeOnSilence" } as const;

  /** A line with straight apostrophes, then curly ones (’, and ‘ as some keyboards type it). */
  function apostropheForms(line: string): string[] {
    return [line, line.replaceAll("'", "’"), line.replaceAll("'", "‘")];
  }

  it("the security reviewer's lines (a) to (e), with straight or curly apostrophes, each fail on every booking", () => {
    const all = readings();
    let curly = 0;
    for (const [line, claim] of REVIEWER_LINES)
      for (const text of apostropheForms(line)) {
        if (text.includes("’")) curly += 1;
        for (const reading of all) {
          const check = checkMoneyLine(text, reading);
          expect(check.ok, text).toBe(false);
          expect(check.refused, text).toContainEqual({ claim, why: WHY[claim] });
        }
      }
    // Lines (c), (d) and (e) hold apostrophes, so each was also read in its curly form.
    expect(curly).toBe(3);
  });

  it("a hold word said of a card or an amount fails in any order and either voice; a charge tied to silence fails in any order", () => {
    const holdsAnyOrder = [
      "$40 is held on your card until the visit.",
      "On your saved card, we'll hold {{deposit}} until Sat 11:00am.",
      "We'll put a {{deposit}} hold on the card you saved.",
      "Your card is authorised for $40 before the visit.",
      "We authorize $40 on your card.",
      "{{deposit}} is reserved on your card.",
      "We block $40 on your card until the visit.",
      "Your saved card will be frozen for {{deposit}}.",
      "The deposit is held until the visit.",
    ];
    const silencesAnyOrder = [
      "We'll charge your card if you don't reply by 7pm.",
      "No reply means we charge.",
      "If there's no response by 7pm, we debit your card.",
      "We take payment if we don't hear back by Fri 11am.",
      "Silence means we bill your saved card.",
      "No reply by 7pm? We'll charge the saved card.",
      "The $20 fee is charged to your card unless you reply by 7pm.",
      "If you stay silent, the deposit is kept.",
      "If you don't reply by 7 p.m. we'll charge your card.",
    ];
    for (const reading of readings()) {
      for (const line of holdsAnyOrder)
        for (const text of apostropheForms(line))
          expect(checkMoneyLine(text, reading).refused, text).toContainEqual({
            claim: "cardHold",
            why: "neverHold",
          });
      for (const line of silencesAnyOrder)
        for (const text of apostropheForms(line))
          expect(checkMoneyLine(text, reading).refused, text).toContainEqual({
            claim: "chargeOnSilence",
            why: "neverChargeOnSilence",
          });
    }
  });

  it("a denied clause still makes no claim: we never hold, nothing is held, we won't charge, no charge without your yes", () => {
    const denied = [
      "We never hold your card.",
      "Nothing is held on your card.",
      "No $40 hold is ever placed on your card.",
      "If you don't reply, we won't charge your card.",
      "No charge without your yes.",
      "If you haven't answered within 24 hours, nothing is charged to the saved card.",
      "If we don't get a reply by 7pm, there's no charge.",
      // The master's own rule lines (S11-17 more, S13-26 more, S11-25 rule): a denial heading, one denial over a list
      // of verbs, a silence that is itself denied.
      "Never: book, charge or decide a fee on silence.",
      "Silence never books, charges or signs.",
      "Rosie's rule: only the owner's yes takes a fee, and silence never does.",
    ];
    for (const line of denied)
      for (const text of apostropheForms(line)) {
        expect(moneyClaims(text), text).not.toContain("cardHold");
        expect(moneyClaims(text), text).not.toContain("chargeOnSilence");
      }
  });

  it("a hold of a time or a place is no card hold; a money word with no silence tied to it is no charge on silence", () => {
    const words = [
      "Your spot is held for 15 minutes.",
      "Pay the $40 deposit to hold your time.",
      "The page holds your time until {{ask.by}}.",
      "Hold on to this text: your $40 deposit is paid.",
      // S13-55 more: "isn't confirmed" is said of the booking, not of a person who did not answer.
      "The charge fails as the booking is written: it isn't confirmed yet.",
      "If you don't reply, the bill comes after the visit.",
    ];
    for (const text of words) {
      expect(moneyClaims(text), text).not.toContain("cardHold");
      expect(moneyClaims(text), text).not.toContain("chargeOnSilence");
    }
  });

  it("no message of either master flow names a card hold or a charge on silence: the master never says either", () => {
    const stringsIn = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(stringsIn);
      if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsIn);
      return [];
    };
    const texts = new Set<string>();
    for (const flow of FLOWS)
      for (const step of Object.values(objAt(src.flows[flow], ["steps"])))
        if (typeof step === "object" && step !== null && "say" in step)
          for (const text of stringsIn(step.say)) texts.add(text);
    expect(texts.size).toBeGreaterThan(1000);
    const naming = [...texts].filter((text) => {
      const claims = moneyClaims(text);
      return claims.includes("cardHold") || claims.includes("chargeOnSilence");
    });
    expect(naming).toEqual([]);
  });
});

describe("money taken, not asked: 'charged', 'you paid' and a signed schedule's share need money the booking took", () => {
  // Round 2 (DL-179, GAP 2): before the money step the record value "paid" only means the money is asked for.

  it("'You were charged $55.' on A list|full|none fails before the money step and before the write, and passes once taken", () => {
    const asked = readMoney(oneService("A", "list|full|none", false), record("A"));
    expect(asked.values).toContain("paid");
    expect(moneyTaken(asked)).toBe(false);
    expect(checkMoneyLine("You were charged $55.", asked)).toEqual({
      ok: false,
      claims: ["charged"],
      refused: [{ claim: "charged", why: "notTaken" }],
    });
    expect(checkMoneyLine("You’ve been charged $55.", asked).refused).toEqual([
      { claim: "charged", why: "notTaken" },
    ]);
    const unwritten = readMoney({ ...oneService("A", "list|full|none"), written: false }, record("A"));
    expect(moneyTaken(unwritten)).toBe(false);
    expect(checkMoneyLine("You were charged $55.", unwritten).refused).toEqual([
      { claim: "charged", why: "notTaken" },
    ]);
    const taken = readMoney(oneService("A", "list|full|none"), record("A"));
    expect(moneyTaken(taken)).toBe(true);
    expect(checkMoneyLine("You were charged $55.", taken)).toEqual({
      ok: true,
      claims: ["charged"],
      refused: [],
    });
  });

  it("'You paid $55.' alike; money named in a term or a refund line ('from what you paid') still reads before the money step", () => {
    const asked = readMoney(oneService("A", "list|full|none", false), record("A"));
    const taken = readMoney(oneService("A", "list|full|none"), record("A"));
    const card = readMoney(oneService("A", "list|card|counter"), record("A"));
    for (const text of ["You paid $55.", "You’ve already paid {{paidnow}}."]) {
      expect(checkMoneyLine(text, asked).refused, text).toEqual([{ claim: "youPaid", why: "notTaken" }]);
      expect(checkMoneyLine(text, card).refused, text).toEqual([{ claim: "youPaid", why: "notTaken" }]);
      expect(checkMoneyLine(text, taken).ok, text).toBe(true);
    }
    // pay.late's row for money paid now, which the master reads before the money step on a deposit booking.
    const deposit = readMoney(oneService("A", "list|deposit|counter", false), record("A"));
    const late = record("A").rows["pay.late"]?.[1]?.text ?? "";
    expect(moneyClaims(late)).toEqual(["paidNow", "backToCard", "fee"]);
    expect(moneyLines(deposit, record("A")).find((line) => line.slot === "pay.late")).toMatchObject({
      ok: true,
      row: 1,
      text: late,
    });
  });

  it("a signed schedule keeps no share on A list|deposit|counter before the money step or the write: nothing was taken", () => {
    const home = moneyHome();
    const asked = readMoney(oneService("A", "list|deposit|counter", false), record("A"));
    expect(asked.values).toContain("paid");
    expect(home.rule("chargeOnSilence", { money: asked, signedSchedule: true })).toBe("none");
    const unwritten = readMoney({ ...oneService("A", "list|deposit|counter"), written: false }, record("A"));
    expect(home.rule("chargeOnSilence", { money: unwritten, signedSchedule: true })).toBe("none");
    const taken = readMoney(oneService("A", "list|deposit|counter"), record("A"));
    expect(home.rule("chargeOnSilence", { money: taken, signedSchedule: true })).toBe("keepSignedShare");
    expect([home.rule("charged", { money: asked }), home.rule("youPaid", { money: asked })]).toEqual([
      "no",
      "no",
    ]);
    expect([home.rule("charged", { money: taken }), home.rule("youPaid", { money: taken })]).toEqual([
      "yes",
      "yes",
    ]);
  });
});

describe("the money home in the registry (T-586)", () => {
  function a711Booking(): MoneyBooking {
    return oneService("A", "list|card|counter");
  }

  it("is the money home's one module: A7-11's words of a charge on silence get the home's 'none', logged by label", () => {
    const lines: HomeLogLine[] = [];
    const registry = createHomeRegistry<MoneyHomeContext & HomeContext>({
      flows: { A: contradictingA711(src.flows.A), B: src.flows.B },
      modules: [moneyHome(), contactStandIn()],
      log: (line) => {
        lines.push(line);
      },
    });
    expect(registry.entry("money")).toMatchObject({
      built: true,
      module: "actions/src/homes/money",
      step: "S13-55",
    });
    const money = readMoney(a711Booking(), record("A"));
    const settled = registry.settle({
      flow: "A",
      step: "A7-11",
      claims: [...A7_11_CLAIMS, { home: "money", point: "depositPaid", value: "yes" }],
      context: { money, signedSchedule: false },
    });
    expect(settled.run).toBe(true);
    if (!settled.run) return;
    expect(settled.rulings).toMatchObject({
      chargeOnSilence: "none",
      cardHold: "never",
      feeFrom: "savedCard",
      depositPaid: "no",
      cardSaved: "yes",
      fee: "yes",
      noFee: "no",
    });
    expect(
      settled.differences.map((difference) => [difference.point, difference.stepSaid, difference.homeSaid]),
    ).toEqual([
      ["chargeOnSilence", "charge", "none"],
      ["depositPaid", "yes", "no"],
    ]);
    expect(lines.map((line) => [line.msg, line.home, line.point])).toEqual([
      ["home_wins", "money", "chargeOnSilence"],
      ["home_wins", "money", "depositPaid"],
    ]);
    for (const line of lines)
      for (const value of Object.values(line)) expect(isLabel(value), String(value)).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/[ $]/);
  });

  it("a signed schedule keeps its share only of money already taken: never a new charge on silence", () => {
    const home = moneyHome();
    const card = readMoney(oneService("A", "list|card|counter"), record("A"));
    const deposit = readMoney(oneService("A", "list|deposit|counter"), record("A"));
    expect(home.rule("chargeOnSilence", { money: card, signedSchedule: true })).toBe("none");
    expect(home.rule("chargeOnSilence", { money: deposit, signedSchedule: true })).toBe("keepSignedShare");
    expect(home.rule("chargeOnSilence", { money: deposit })).toBe("none");
    expect(() => home.rule("tipWord", { money: card })).toThrow("tipWord is not a point of the money home");
  });

  it("rules every point with a label on every booking compared", () => {
    const module = moneyHome();
    expect(module.points).toEqual(MONEY_POINTS);
    for (const point of MONEY_POINTS) expect(isLabel(point), point).toBe(true);
    for (const flow of FLOWS)
      for (const { money } of comparedOf(flow).slice(0, 300))
        for (const point of module.points) expect(isLabel(module.rule(point, { money })), point).toBe(true);
  });
});

// Round 3 (DL-182): the money-topic gate. A money sentence passes only as an approved line (the records' rows, S13-55's
// own lines, a message text of either master flow), a denial included; approved lines then go through the claim check.

/** A line with straight apostrophes, then curly ones (’, and ‘ as some keyboards type it). */
function threeForms(line: string): string[] {
  return [line, line.replaceAll("'", "’"), line.replaceAll("'", "‘")];
}

const HOLD = { claim: "cardHold", why: "neverHold" } as const;
const SILENCE = { claim: "chargeOnSilence", why: "neverChargeOnSilence" } as const;
const NOT_FROM_RECORD = { claim: "moneySentence", why: "moneyNotFromRecord" } as const;
const BY_WHY = {
  neverHold: HOLD,
  neverChargeOnSilence: SILENCE,
  moneyNotFromRecord: NOT_FROM_RECORD,
} as const;
type GateWhy = keyof typeof BY_WHY;

let approvedSoFar: ApprovedMoneyLines | null = null;

/** The approved lines read from both emitted flows: their records' rows, S13-55's lines and every message text. */
function approved(): ApprovedMoneyLines {
  approvedSoFar ??= readApprovedLines(src.flows);
  return approvedSoFar;
}

function gate(slotValues?: readonly { slot: string; value: string }[]): MoneyGate {
  return slotValues === undefined ? { approved: approved() } : { approved: approved(), slotValues };
}

const NOTHING_APPROVED: MoneyGate = { approved: approvedMoneyLines([]) };

/** The bookings the gate is read on: a card, a deposit, the full price, nothing (B), a credit, a deposit only asked. */
function gateReadings(): MoneyReading[] {
  return [
    readMoney(oneService("A", "list|card|counter"), record("A")),
    readMoney(oneService("A", "list|deposit|counter"), record("A")),
    readMoney(oneService("A", "list|full|none"), record("A")),
    readMoney(oneService("B", "list|none|bill"), record("B")),
    readMoney(bookingAt("A", "list|card|counter +credit-plus"), record("A")),
    readMoney(oneService("A", "list|deposit|counter", false), record("A")),
  ];
}

/** A text with each slot that was given a value written as that value, as the slot filler writes it. */
function filledWith(text: string, values: readonly { slot: string; value: string }[]): string {
  return text.replace(
    /\{\{\s*([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?)\s*(?::[^{}|]*)?(?:\|[^{}]*)?\}\}/g,
    (raw, name: string) => values.find((given) => given.slot === name)?.value ?? raw,
  );
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsOf);
  return [];
}

describe("round 3 (DL-182): a money sentence passes only as an approved line, and a denial no longer exempts it", () => {
  /** Every line the security reviewer gave in rounds 1 and 2, with the label it fails with. */
  const REVIEWER: readonly (readonly [string, GateWhy])[] = [
    // Round 1, (a) to (e).
    ["Your card will be held for $40 until the visit.", "neverHold"],
    ["Your saved card is held for {{deposit}} until Sat 11:00am.", "neverHold"],
    ["If you don't reply by Fri 11am, we'll charge the $20 fee to your card.", "neverChargeOnSilence"],
    [
      "If you haven't answered within 24 hours, the late-cancel fee is charged to the saved card.",
      "neverChargeOnSilence",
    ],
    ["If we don't get a reply by 7pm, we'll charge your card.", "neverChargeOnSilence"],
    // Round 2, items 1 to 3.
    ["We'll place a $40 hold on your card but won't charge it unless you cancel late.", "neverHold"],
    ["We'll place a temporary $40 hold on your card that won't be charged.", "neverHold"],
    ["If you don't reply by 7pm, we'll charge the fee with no further notice.", "neverChargeOnSilence"],
    ["No reply by 7pm means we charge the fee and can't refund it.", "neverChargeOnSilence"],
    ["A hold (not a charge) goes on your card for $40.", "neverHold"],
    ["Not replying by 7pm means we'll charge your card.", "neverChargeOnSilence"],
    ["Without hearing from you by 7pm, we'll charge the fee.", "neverChargeOnSilence"],
    // Round 2, notes 2 to 5.
    ["Your card has now been charged $55.", "moneyNotFromRecord"],
    ["We've now charged your card.", "moneyNotFromRecord"],
    ["The $55 you paid is confirmed.", "moneyNotFromRecord"],
    ["We'll hold onto $40 on your card.", "neverHold"],
    ["We'll hold the money until the visit.", "neverHold"],
  ];

  it("every line the security reviewer gave in rounds 1 and 2 fails with its label, straight or curly, on every booking", () => {
    let checked = 0;
    for (const [line, why] of REVIEWER)
      for (const text of threeForms(line))
        for (const reading of gateReadings()) {
          const check = checkMoneyText(text, reading, gate());
          expect(check.ok, text).toBe(false);
          expect(check.refused, text).toContainEqual(BY_WHY[why]);
          expect(gateMoneyText(text, gate()).refused, text).toContainEqual(BY_WHY[why]);
          // The claim check alone refuses the hold and the silence topics too, with no line approved.
          if (why !== "moneyNotFromRecord")
            expect(checkMoneyLine(text, reading).refused, text).toContainEqual(BY_WHY[why]);
          checked += 1;
        }
    expect(checked).toBe(REVIEWER.length * 3 * 6);
  });

  it("a denial no longer exempts a money sentence: round 2's denied clauses now fail with their labels", () => {
    const denied: readonly (readonly [string, GateWhy])[] = [
      ["We never hold your card.", "neverHold"],
      ["Nothing is held on your card.", "neverHold"],
      ["No $40 hold is ever placed on your card.", "neverHold"],
      ["We never place a hold on your card.", "neverHold"],
      ["If you don't reply, we won't charge your card.", "neverChargeOnSilence"],
      [
        "If you haven't answered within 24 hours, nothing is charged to the saved card.",
        "neverChargeOnSilence",
      ],
      ["If we don't get a reply by 7pm, there's no charge.", "neverChargeOnSilence"],
      ["If you don't answer, nothing is charged.", "neverChargeOnSilence"],
      ["If you don't reply, the bill comes after the visit.", "neverChargeOnSilence"],
    ];
    for (const [line, why] of denied)
      for (const text of threeForms(line))
        for (const reading of gateReadings()) {
          expect(checkMoneyText(text, reading, gate()).refused, text).toContainEqual(BY_WHY[why]);
          expect(checkMoneyLine(text, reading).refused, text).toContainEqual(BY_WHY[why]);
        }
  });

  it("a model's rewording of an approved money line fails with moneyNotFromRecord; the line itself passes", () => {
    const rows = Object.values(record("A").rows).flatMap((list) => list.map((row) => row.text));
    const reworded: readonly (readonly [string, string])[] = [
      ["The card is saved for a {{keep}} fee", "Your card is saved for a {{keep}} fee"],
      [
        "may keep its {{keep}} fee from what you paid; anything above it goes back",
        "may keep the {{keep}} fee from what you paid; the rest goes back",
      ],
      ["Paid in full when you book: {{paid}}", "You pay in full when you book: {{paid}}"],
      [
        "{{deposit}} deposit paid, toward the {{price}}",
        "Your {{deposit}} deposit is paid, toward the {{price}}",
      ],
      [
        "The {{back}} you paid goes back to the card it was paid with.",
        "The {{back}} you paid goes back to your card.",
      ],
      [
        "Nothing was charged, and the saved card won't be used.",
        "Nothing was charged, and your saved card won't be used.",
      ],
      ["may charge its {{keep}} fee to the saved card", "will charge its {{keep}} fee to the saved card"],
      [
        "The {{due}} rest, charged to the saved card at the end",
        "The {{due}} rest is charged to your saved card at the end",
      ],
    ];
    for (const [line, words] of reworded) {
      expect(rows, line).toContain(line);
      expect(gateMoneyText(line, gate()), line).toEqual({ ok: true, refused: [] });
      expect(gateMoneyText(line, NOTHING_APPROVED).ok, line).toBe(false);
      expect(gateMoneyText(words, gate()), words).toEqual({ ok: false, refused: [NOT_FROM_RECORD] });
      for (const reading of gateReadings())
        expect(checkMoneyText(words, reading, gate()).refused, words).toContainEqual(NOT_FROM_RECORD);
    }
  });

  it("every row of both records that is a money sentence passes as written and fails once reworded", () => {
    let money = 0;
    for (const flow of FLOWS)
      for (const rows of Object.values(record(flow).rows))
        for (const { text } of rows) {
          const alone = gateMoneyText(text, NOTHING_APPROVED);
          if (alone.ok || sentencesOf(text).length !== 1) continue;
          money += 1;
          expect(gateMoneyText(text, gate()).ok, text).toBe(true);
          const words = `${text.replace(/[.!?]$/u, "")} for you`;
          expect(gateMoneyText(words, gate()).refused, words).toEqual(alone.refused);
        }
    expect(money).toBeGreaterThan(20);
  });

  it("slots stand for the values the slot filler gave: a filled line passes only with those values, as its own words", () => {
    const keep = [{ slot: "keep", value: "$20" }];
    expect(gateMoneyText("The card is saved for a {{keep}} fee.", gate()).ok).toBe(true);
    expect(gateMoneyText("The card is saved for a $20 fee.", gate(keep)).ok).toBe(true);
    expect(gateMoneyText("The card is saved for a $20 fee.", gate()).refused).toEqual([NOT_FROM_RECORD]);
    expect(gateMoneyText("The card is saved for a $30 fee.", gate(keep)).refused).toEqual([NOT_FROM_RECORD]);
    // A value stands for its slot alone: the words around it are still the line's own.
    expect(gateMoneyText("We hold $40, and the card is saved for a $20 fee.", gate(keep)).refused).toEqual([
      HOLD,
    ]);
    expect(gateMoneyText("The card is saved for a $20 fee unless you reply.", gate(keep)).refused).toEqual([
      SILENCE,
    ]);
  });

  it("the records' rows pass on the bookings that pick them, as written and filled with the booking's ledger amounts", () => {
    const seen = new Set<string>();
    for (const flow of FLOWS)
      for (const { money: reading, rows } of comparedOf(flow)) {
        const values = Object.entries(ledgerFacts(reading)).map(([slot, amount]) => ({
          slot,
          value: `$${String(amount.cents / 100)}`,
        }));
        for (const [slot, row] of Object.entries(rows)) {
          if (row === null) continue;
          const text = record(flow).rows[slot as keyof MoneyRecord["rows"]]?.[row]?.text ?? "";
          const filled = filledWith(text, values);
          const key = `${text}|${filled}`;
          if (seen.has(key)) continue;
          seen.add(key);
          expect(gateMoneyText(text, gate()).ok, text).toBe(true);
          expect(gateMoneyText(filled, gate(values)).ok, filled).toBe(true);
          const others = checkMoneyText(filled, reading, gate(values)).refused.filter(
            (refusal) => refusal.why !== "notTaken",
          );
          expect(others, filled).toEqual([]);
        }
      }
    expect(seen.size).toBeGreaterThan(100);
  }, 120_000);

  it("S13-55's own lines pass as approved lines; with nothing approved, their money sentences fail with their labels", () => {
    for (const line of S13_55_LINES)
      expect(gateMoneyText(line, gate()), line).toEqual({ ok: true, refused: [] });
    expect(gateMoneyText(S13_55_LINES[0] ?? "", NOTHING_APPROVED).refused).toEqual([HOLD]);
    expect(gateMoneyText(S13_55_LINES[1] ?? "", NOTHING_APPROVED).refused).toEqual([SILENCE]);
  });

  it("the master corpus, every string of both flows (round 2's probe): each message text, row and S13-55 line passes; a note is no message", () => {
    const all = new Set<string>();
    const sendable = new Set<string>();
    for (const flow of FLOWS) {
      const graph = src.flows[flow];
      for (const text of stringsOf(graph)) all.add(text);
      for (const rows of Object.values(record(flow).rows)) for (const row of rows) sendable.add(row.text);
      const steps = objAt(graph, ["steps"]);
      const home = objAt(steps, [record(flow).home]);
      for (const text of [...stringsOf(home.does), ...stringsOf(home.more), ...stringsOf(home.rule)])
        sendable.add(text);
      for (const step of Object.values(steps)) {
        if (typeof step !== "object" || step === null) continue;
        const fields = step as Record<string, unknown>;
        for (const text of stringsOf(fields.say)) sendable.add(text);
        if (typeof fields.vary === "object" && fields.vary !== null)
          for (const patch of Object.values(fields.vary as Record<string, unknown>)) {
            const words = patch as Record<string, unknown>;
            for (const text of [...stringsOf(words.say), ...stringsOf(words.addSay)]) sendable.add(text);
          }
        if (typeof fields.fallbackText === "string") sendable.add(fields.fallbackText);
      }
    }
    expect(all.size).toBeGreaterThan(10_000);
    expect(sendable.size).toBeGreaterThan(1000);
    expect([...sendable].filter((text) => !gateMoneyText(text, gate()).ok)).toEqual([]);
    // What the gate refuses is the master's own notes and rules, which are never sent: S11-13's note among them.
    const refused = [...all].filter((text) => !sendable.has(text) && !gateMoneyText(text, gate()).ok);
    expect(refused.length).toBeGreaterThan(0);
    const note = "Silence: charged as their terms say.";
    expect(refused.some((text) => text.includes(note))).toBe(true);
    expect(gateMoneyText(note, gate()).refused).toEqual([SILENCE]);
  }, 120_000);

  it("a money action word with no money object passes: 'We'll hold your 10am'", () => {
    const passing = [
      "We'll hold your 10am.",
      "We’ll hold your 10am.",
      "We'll keep your spot until Fri 11am.",
      "Riley will block off Sat morning for you.",
      "Take a seat when you get here.",
    ];
    for (const text of passing) {
      expect(gateMoneyText(text, gate()), text).toEqual({ ok: true, refused: [] });
      expect(gateMoneyText(text, NOTHING_APPROVED), text).toEqual({ ok: true, refused: [] });
      for (const reading of gateReadings())
        expect(checkMoneyText(text, reading, gate()), text).toEqual({ ok: true, claims: [], refused: [] });
    }
  });

  it("a sentence ends only at . ! ? or a line break: a comma, dash, parenthesis, quote or semicolon never parts a money word from its object", () => {
    for (const text of [
      "Your card, as agreed, will be held for $40.",
      "Your card (as agreed) will be held.",
      "Your card — as agreed — will be held.",
      "We'll hold it; it goes on your card.",
      "We'll place a “hold” on your card.",
    ])
      expect(gateMoneyText(text, gate()).refused, text).toEqual([HOLD]);
    expect(gateMoneyText("If you don't reply by 7pm; we'll charge it.", gate()).refused).toEqual([SILENCE]);
    // A line break ends a sentence: the card with an amount is still a money sentence of its own.
    expect(gateMoneyText("We'll hold it.\nYour card, $40.", gate()).refused).toEqual([NOT_FROM_RECORD]);
  });
});

describe("round 3 (DL-182, 2): 'deposit paid', 'paid in full' and 'refunded' said as statements need money the booking took", () => {
  it("'deposit paid' and 'paid in full' said as statements fail before the money step and pass once taken; a term stays a term", () => {
    const asked = readMoney(oneService("A", "list|deposit|counter", false), record("A"));
    const taken = readMoney(oneService("A", "list|deposit|counter"), record("A"));
    for (const text of [
      "Your $40 deposit was paid.",
      "Your deposit is paid.",
      "Deposit paid: $40.",
      "You paid the $40 deposit.",
    ]) {
      expect(checkMoneyLine(text, asked).refused, text).toEqual([{ claim: "depositPaid", why: "notTaken" }]);
      expect(checkMoneyLine(text, taken).ok, text).toBe(true);
    }
    const askedFull = readMoney(oneService("A", "list|full|none", false), record("A"));
    const takenFull = readMoney(oneService("A", "list|full|none"), record("A"));
    const unwrittenFull = readMoney({ ...oneService("A", "list|full|none"), written: false }, record("A"));
    for (const text of ["Paid in full.", "Your visit is paid in full.", "You've paid in full: $55."]) {
      for (const reading of [askedFull, unwrittenFull])
        expect(checkMoneyLine(text, reading).refused, text).toContainEqual({
          claim: "paidInFull",
          why: "notTaken",
        });
      expect(checkMoneyLine(text, takenFull).ok, text).toBe(true);
    }
    // The record's term row (pay.asks): what the booking asks when it is booked, before the money step too.
    expect(checkMoneyLine("Paid in full when you book: $55", askedFull)).toEqual({
      ok: true,
      claims: ["paidInFull"],
      refused: [],
    });
    expect(moneyLines(askedFull, record("A")).find((line) => line.slot === "pay.asks")).toMatchObject({
      ok: true,
      text: "Paid in full when you book: {{paid}}",
    });
  });

  it("'refunded', 'was refunded' and 'we refunded' fail before the money step and pass once taken; 'goes back to the card' stays a term", () => {
    const asked = readMoney(oneService("A", "list|deposit|counter", false), record("A"));
    const taken = readMoney(oneService("A", "list|deposit|counter"), record("A"));
    for (const text of [
      "Your $40 deposit was refunded.",
      "We refunded your $40.",
      "Refunded to your card: $40.",
      "We've already refunded the deposit.",
      "The $40 has been refunded to your card.",
    ]) {
      expect(checkMoneyLine(text, asked).refused, text).toEqual([{ claim: "backToCard", why: "notTaken" }]);
      expect(checkMoneyLine(text, taken).ok, text).toBe(true);
    }
    expect(checkMoneyLine("The $40 you paid goes back to the card it was paid with.", asked)).toEqual({
      ok: true,
      claims: ["paidNow", "backToCard"],
      refused: [],
    });
  });

  it("the record's statement rows ('{{deposit}} deposit paid, toward the {{price}}') are refused before the money step and pass once taken", () => {
    const took = (reading: MoneyReading) =>
      moneyLines(reading, record("A")).find((line) => line.slot === "pay.took");
    expect(took(readMoney(oneService("A", "list|deposit|counter", false), record("A")))).toEqual({
      slot: "pay.took",
      ok: false,
      row: 8,
      refused: [{ claim: "depositPaid", why: "notTaken" }],
      why: "claims",
    });
    expect(took(readMoney(oneService("A", "list|deposit|counter"), record("A")))).toMatchObject({
      ok: true,
      row: 8,
      text: "{{deposit}} deposit paid, toward the {{price}}",
    });
  });
});
