// T-326: a Stripe effect row's K-14 v1 request is built from the row alone, and the code's checks are K-14's schema
// (held to it here with Ajv, as the Worker cannot run Ajv): every accepted K-14 fixture of the five effect calls builds
// exactly its request, every refused one whose fault is in the request is never built (refuse-card-hold.json first), and
// on thousands of variants of the fixtures' port requests the code and the schema agree.

import { describe, expect, it } from "vitest";

import { EFFECT_KINDS, kindsOf, type EffectRow } from "../kinds";
import { calendarWrite } from "../runner/test-support";
import { CALL_OF, STRIPE_KINDS, type StripeEffectCall } from "./port";
import {
  buildStripeRequest,
  isStripeAmount,
  isStripeEffectId,
  isStripeKey,
  portRequestFaults,
  refusedCode,
} from "./request";
import { ROSFIELD, SHOP, STRIPE_INDEX, depositRow, k14, readExchange, rowFromExchange } from "./test-support";

const EFFECT_CALLS: readonly StripeEffectCall[] = [
  "saveCard",
  "charge",
  "payLink",
  "refund",
  "disputeEvidence",
];

const callOfDef = (def: string): StripeEffectCall | null => {
  const call = def.replace(/[.]exchange$/u, "");
  return (EFFECT_CALLS as readonly string[]).includes(call) && def.endsWith(".exchange")
    ? (call as StripeEffectCall)
    : null;
};

const accepted = STRIPE_INDEX.filter((entry) => entry.expect === "accept" && callOfDef(entry.def) !== null);

describe("the Stripe kinds and their calls", () => {
  it("are K-07 v1's six Stripe kinds, each on the call kinds.ts names", () => {
    expect([...STRIPE_KINDS]).toEqual(kindsOf("stripe"));
    for (const kind of STRIPE_KINDS) expect(CALL_OF[kind]).toBe(EFFECT_KINDS[kind].call);
  });
});

describe("every accepted K-14 v1 fixture of an effect call builds exactly its request from its row", () => {
  it("covers the five calls that run from an effect row", () => {
    expect(new Set(accepted.map((entry) => callOfDef(entry.def)))).toEqual(new Set(EFFECT_CALLS));
  });

  for (const entry of accepted) {
    it(`builds ${entry.file}'s request, which K-14 accepts`, () => {
      const exchange = readExchange(entry.file);
      const built = buildStripeRequest(rowFromExchange(entry.file));
      expect(built).toEqual({ ok: true, built: { call: exchange.call, request: exchange.request } });
      if (!built.ok) return;
      expect(k14(`${built.built.call}.request`, built.built.request)).toEqual([]);
    });
  }
});

describe("a refused K-14 v1 request is never built from its row", () => {
  const cases: readonly { file: string; faults: string[] }[] = [
    { file: "invalid/refuse-card-hold.json", faults: ["port.captureMethod"] },
    { file: "invalid/refuse-charge-without-key.json", faults: ["effect.idempotencyKey"] },
    { file: "invalid/refuse-charge-without-effect-id.json", faults: ["effect.effectId"] },
    { file: "invalid/refuse-decimal-amount.json", faults: ["amount"] },
    { file: "invalid/refuse-monthly-bill-on-business-account.json", faults: ["port.account.kind"] },
    { file: "invalid/refuse-dispute-evidence-without-owner-yes.json", faults: ["port.ownerYes"] },
  ];

  it("covers every refused fixture of an effect call whose fault is in the request", () => {
    const refused = STRIPE_INDEX.filter(
      (entry) => entry.expect === "refuse" && callOfDef(entry.def) !== null,
    );
    // refuse-off-session-needs-authentication's fault is in its outcome: answer.test.ts holds it.
    expect(refused.map((entry) => entry.file).sort()).toEqual(
      [...cases.map((c) => c.file), "invalid/refuse-off-session-needs-authentication.json"].sort(),
    );
  });

  for (const { file, faults } of cases) {
    it(`refuses ${file}, naming ${faults.join(", ")}, as K-14 refuses the request it would be`, () => {
      const exchange = readExchange(file);
      expect(k14(`${exchange.call}.request`, exchange.request)).not.toEqual([]);
      expect(buildStripeRequest(rowFromExchange(file))).toEqual({ ok: false, faults });
    });
  }

  it("a card hold cannot be built: a row asking for one gets no request, only the field at fault", () => {
    const row = rowFromExchange("invalid/refuse-card-hold.json");
    const built = buildStripeRequest(row);
    expect(built.ok).toBe(false);
    expect(built).not.toHaveProperty("built");
    expect(refusedCode(built.ok ? [] : built.faults)).toBe("request_invalid:port.captureMethod");
    // Any other name for a later capture is refused the same way: K-14 has no field for a hold.
    for (const field of ["capture_method", "captureLater", "hold", "authorizeOnly"]) {
      const deposit = depositRow();
      const asked = { ...deposit, portRequest: { ...deposit.portRequest, [field]: "manual" } };
      expect(buildStripeRequest(asked)).toEqual({ ok: false, faults: [`port.${field}`] });
    }
  });
});

describe("the request is the committed row's, and nothing else", () => {
  it("copies the row's effect id, key, amount and port request, and nothing the row does not hold", () => {
    const row = depositRow();
    const built = buildStripeRequest(row);
    if (!built.ok || built.built.call !== "charge") throw new Error("the deposit builds a charge");
    const { request } = built.built;
    expect(request).toEqual({
      effect: { effectId: row.effectId, idempotencyKey: row.idempotencyKey },
      amount: row.amount,
      port: row.portRequest,
    });
    // A copy: what happens to the row afterwards never changes what was built.
    const before = structuredClone(request);
    if (row.amount !== null) row.amount.cents = 1;
    row.portRequest.description = "changed";
    expect(request).toEqual(before);
  });

  it("never gives a money row an amount it does not hold, and never sends one with a card save or evidence", () => {
    const charge = { ...depositRow(), amount: null };
    expect(buildStripeRequest(charge)).toEqual({ ok: false, faults: ["amount"] });
    const zero = { ...depositRow(), amount: { cents: 0, currency: "USD" } };
    expect(buildStripeRequest(zero)).toEqual({ ok: false, faults: ["amount"] });
    const save = { ...rowFromExchange("save-card.json"), amount: { cents: 2000, currency: "USD" } };
    expect(buildStripeRequest(save)).toEqual({ ok: false, faults: ["amount"] });
    const evidence = {
      ...rowFromExchange("dispute-evidence-owner-yes.json"),
      amount: { cents: 3500, currency: "USD" },
    };
    expect(buildStripeRequest(evidence)).toEqual({ ok: false, faults: ["amount"] });
  });

  it("keeps the monthly bill's kind and purpose together (default 1)", () => {
    const bill = rowFromExchange("monthly-charge.json");
    expect(bill.kind).toBe("rosfield_monthly_charge");
    expect(buildStripeRequest(bill).ok).toBe(true);
    expect(buildStripeRequest({ ...bill, kind: "stripe_charge" })).toEqual({
      ok: false,
      faults: ["port.purpose"],
    });
    const customers = {
      ...depositRow(),
      kind: "rosfield_monthly_charge" as const,
      turnId: null,
      jobId: "job-x",
    };
    expect(buildStripeRequest(customers)).toEqual({ ok: false, faults: ["port.purpose"] });
  });

  it("refuses a row no turn or job wrote, or both did (K-07 v1: a turn or a job, never both or neither)", () => {
    expect(buildStripeRequest({ ...depositRow(), turnId: null, jobId: null })).toEqual({
      ok: false,
      faults: ["turnId"],
    });
    expect(buildStripeRequest({ ...depositRow(), jobId: "job-x" })).toEqual({
      ok: false,
      faults: ["turnId"],
    });
  });

  it("refuses a row whose port request is not an object, without throwing", () => {
    for (const portRequest of [null, [], "deposit", 4000]) {
      const row = { ...depositRow(), portRequest: portRequest as unknown as EffectRow["portRequest"] };
      expect(buildStripeRequest(row)).toEqual({ ok: false, faults: ["port"] });
    }
  });

  it("refuses a row of another port", () => {
    expect(buildStripeRequest(calendarWrite())).toEqual({ ok: false, faults: ["kind"] });
    expect(buildStripeRequest({ ...depositRow(), port: "linq" })).toEqual({ ok: false, faults: ["kind"] });
  });

  it("names fields, never values: an odd key is named unnamed, and the code is always a label", () => {
    const row = depositRow();
    const odd = { ...row, portRequest: { ...row.portRequest, "card 4242 4242 4242 4242": "x" } };
    expect(buildStripeRequest(odd)).toEqual({ ok: false, faults: ["port.unnamed"] });
    const digits = { ...row, portRequest: { ...row.portRequest, x4242424242424242: "x" } };
    expect(buildStripeRequest(digits)).toEqual({ ok: false, faults: ["port.unnamed"] });
    expect(refusedCode([])).toBe("request_invalid");
    expect(refusedCode(["port.unnamed"])).toBe("request_invalid:port.unnamed");
    expect(refusedCode(["port with space"])).toBe("request_invalid");
  });
});

// ---- the code's checks against K-14 v1's schema, on variants ---------------------------------------------------------

type Json = Record<string, unknown>;

const ODD: readonly unknown[] = [
  null,
  "",
  " ",
  0,
  1,
  4000.5,
  -1,
  true,
  false,
  {},
  [],
  "4242424242424242",
  "4242 4242 4242 4242",
  "x".repeat(501),
  "ok-id",
  "Lee's Barbershop",
  "requestedByCustomer",
  "duplicate",
  "rosfieldMonthlyBill",
  "deposit",
  "owner",
  "staff",
  "ownerYes",
  "2026-10-24",
  "Oct 24",
  "5555550101",
  "person sam",
  "business",
  "rosfield",
  SHOP,
  ROSFIELD,
  { kind: "business" },
  { kind: "rosfield", accountId: "stripe-acct-demo-lees-barbershop" },
  { kind: "business", accountId: "stripe-acct-demo-lees-barbershop", extra: 1 },
  { kind: "business", accountId: "4242424242424242" },
];

/** Every path to a value inside `value`, objects included, to depth 2. */
function pathsOf(value: unknown, prefix: string[] = []): string[][] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || prefix.length >= 2) return [];
  return Object.entries(value as Json).flatMap(([key, item]) => [
    [...prefix, key],
    ...pathsOf(item, [...prefix, key]),
  ]);
}

function changed(base: Json, path: readonly string[], change: (holder: Json, key: string) => void): Json {
  const copy = structuredClone(base);
  let holder: Json = copy;
  for (const key of path.slice(0, -1)) holder = holder[key] as Json;
  const last = path.at(-1);
  if (last !== undefined) change(holder, last);
  return copy;
}

/** The fixture's port request with one thing changed: each value dropped, replaced or added to, one at a time. */
function variantsOf(base: Json): unknown[] {
  const variants: unknown[] = [base, null, [], "port", 5];
  for (const path of pathsOf(base)) {
    variants.push(
      changed(base, path, (holder, key) => {
        Reflect.deleteProperty(holder, key);
      }),
    );
    for (const odd of ODD) {
      variants.push(
        changed(base, path, (holder, key) => {
          holder[key] = structuredClone(odd);
        }),
      );
    }
  }
  for (const objectPath of [
    [],
    ...pathsOf(base).filter((path) => typeof pathValue(base, path) === "object"),
  ]) {
    variants.push(
      objectPath.length === 0
        ? { ...base, captureMethod: "manual" }
        : changed(base, objectPath, (holder, key) => {
            const inner = holder[key];
            if (typeof inner === "object" && inner !== null && !Array.isArray(inner))
              holder[key] = { ...(inner as Json), extra: "x" };
          }),
    );
  }
  return variants;
}

function pathValue(base: Json, path: readonly string[]): unknown {
  let value: unknown = base;
  for (const key of path) value = (value as Json)[key];
  return value;
}

describe("the code's port request checks are K-14 v1's schema", () => {
  for (const call of EFFECT_CALLS) {
    it(`judges every variant of ${call}'s fixtures' port requests as the schema does`, () => {
      const bases = accepted
        .filter((entry) => callOfDef(entry.def) === call)
        .map((entry) => readExchange(entry.file).request.port as Json);
      let judged = 0;
      for (const base of bases) {
        for (const variant of variantsOf(base)) {
          const schemaTakes = k14(`${call}.portRequest`, variant).length === 0;
          const codeTakes = portRequestFaults(call, variant).length === 0;
          expect(codeTakes, `${call}: ${JSON.stringify(variant)}`).toBe(schemaTakes);
          judged += 1;
        }
      }
      expect(judged).toBeGreaterThan(200);
    });
  }

  it("judges a card save, a pay link that saves its card, and the bill's own rules as the schema does", () => {
    const payLink = readExchange("charge-failed-pay-link.json").request.port as Json;
    const cases: [StripeEffectCall, unknown][] = [
      ["payLink", { ...payLink, customerId: null }],
      ["payLink", { ...payLink, customerId: null, saveCardForLater: false }],
      ["payLink", { ...payLink, purpose: "rosfieldMonthlyBill" }],
      ["payLink", { ...payLink, purpose: "rosfieldMonthlyBill", account: ROSFIELD }],
      ["charge", { ...(readExchange("monthly-charge.json").request.port as Json), customerPresent: true }],
      ["charge", { ...(readExchange("deposit.json").request.port as Json), account: ROSFIELD }],
      ["saveCard", { account: ROSFIELD, customerId: null }],
      ["saveCard", { account: SHOP, customerId: "stripe-customer-demo-alex" }],
      [
        "disputeEvidence",
        { ...(readExchange("dispute-evidence-owner-yes.json").request.port as Json), account: ROSFIELD },
      ],
    ];
    for (const [call, port] of cases) {
      expect(portRequestFaults(call, port).length === 0, JSON.stringify(port)).toBe(
        k14(`${call}.portRequest`, port).length === 0,
      );
    }
  });

  it("judges the effect id, the key and the amount as the schema does, counting characters as it does", () => {
    const ids = ["", "\n", "x", "x".repeat(500), "x".repeat(501), "😀".repeat(500), "😀".repeat(501)];
    const keys = ["", "k", "k".repeat(255), "k".repeat(256), "😀".repeat(255), "😀".repeat(256)];
    for (const effectId of ids) {
      for (const idempotencyKey of keys) {
        const schemaTakes = k14("effectRef", { effectId, idempotencyKey }).length === 0;
        expect(
          isStripeEffectId(effectId) && isStripeKey(idempotencyKey),
          `${effectId}|${idempotencyKey}`,
        ).toBe(schemaTakes);
      }
    }
    const amounts: unknown[] = [
      { cents: 4000, currency: "USD" },
      { cents: 1, currency: "EUR" },
      { cents: 0, currency: "USD" },
      { cents: -5, currency: "USD" },
      { cents: 4000.5, currency: "USD" },
      { cents: "4000", currency: "USD" },
      { cents: 4000, currency: "usd" },
      { cents: 4000, currency: "USDX" },
      { cents: 4000 },
      { currency: "USD" },
      { cents: 4000, currency: "USD", extra: 1 },
      null,
      [],
      4000,
    ];
    for (const amount of amounts) {
      expect(isStripeAmount(amount), JSON.stringify(amount)).toBe(k14("amount", amount).length === 0);
    }
  });
});
