// T-1449 (DL-940; D-018), under Node (Vitest project "unit"): ./linq-line.ts's switch, its one rule for who is a test
// phone, the send by recipient over stand-ins (a recording test-phone line and a counting maker of the real sender, so
// nothing here reaches Linq or any network), and the Linq verify input the Worker's root is handed, each with every name
// read from the env counted. ./linq-line.worker.test.ts runs the real guarded sender against a stood-in Linq and the
// test-phone line's Durable Object, and the test-phone page's send through the Worker's route; ../linq.test.ts runs the
// two secrets through workerRoot's verify. Test values only (rule 9): every number a whole literal of the fiction range
// (555-01xx), a made-up key and made-up secrets.
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import { describe, expect, it } from "vitest";

import type { LinqAccepted, LinqFailed, LinqSendRequest } from "../../dispatch/types";
import {
  isTestPhone,
  linqLineSend,
  REAL_LINQ_LINE,
  realLinqLineOn,
  STAGING_LINQ_LINE,
  stagingLinqVerifyInputs,
  TEST_PHONE_WEBHOOK_SECRET,
  type LinqLineEnv,
} from "./linq-line";

/** The roster phone: on STAGING_LINQ_ALLOWLIST, as the user's own iPhone is on staging (here a fiction number). */
const ROSTER_PHONE = "+15555550150";
/** A test phone: send-text.json's own `to`, in the fiction range and off the list. */
const TEST_PHONE = "+15555550101";
/** A test phone with another area code: the range is any area code that is not toll-free. */
const OTHER_AREA_TEST_PHONE = "+12125550142";
/** Rosie's own line for these tests (the Linq double's made-up line). */
const ROSIE = "+15555550199";
/** Made-up secrets, in Linq's form: never Linq's, never staging's. */
const LINQ_SECRET = `whsec_${btoa("t1449 made-up linq webhook secret")}`;
const PAGE_SECRET = `whsec_${btoa("t1449 made-up test-phone page secret")}`;

/** The names this card adds, none of which is read anywhere while the real line is off. */
const NEW_NAMES = [
  "STAGING_LINQ_ALLOWLIST",
  "ROSIE_NUMBER",
  "LINQ_API_TOKEN",
  TEST_PHONE_WEBHOOK_SECRET,
] as const;

interface CountedEnv {
  readonly env: LinqLineEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
}

/** An env double holding `values`, whose every read is counted. */
function counted(values: Record<string, unknown>): CountedEnv {
  const names: string[] = [];
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  return { env: env as unknown as LinqLineEnv, names };
}

/** Staging with the real line on, the roster phone on the list, Rosie's line and both secrets set. */
const LINE_ON: Readonly<Record<string, unknown>> = {
  ENVIRONMENT: "staging",
  [STAGING_LINQ_LINE]: REAL_LINQ_LINE,
  STAGING_LINQ_ALLOWLIST: ROSTER_PHONE,
  ROSIE_NUMBER: ROSIE,
  LINQ_WEBHOOK_SECRET: LINQ_SECRET,
  [TEST_PHONE_WEBHOOK_SECRET]: PAGE_SECRET,
};

/** The values of the switch that leave the real line off: absent, the card's two, and near misses of "real". */
const OFF_VALUES: readonly (readonly [string, unknown])[] = [
  ["absent", undefined],
  ['"double"', "double"],
  ['""', ""],
  ['"REAL"', "REAL"],
  ['"Real"', "Real"],
  ['" real"', " real"],
  ['"real "', "real "],
  ['"real\\n"', "real\n"],
  ["true", true],
  ["1", 1],
  ["null", null],
  ['["real"]', ["real"]],
];

/** LINE_ON with the switch at `value` (left out of the env entirely when undefined). */
function withSwitch(value: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = { ...LINE_ON };
  if (value === undefined) Reflect.deleteProperty(values, STAGING_LINQ_LINE);
  else values[STAGING_LINQ_LINE] = value;
  return values;
}

/** send-text.json's request (K-11 v1 sendPart, the dispatcher's kinds), sent to `to`. */
function partTo(to: unknown): LinqSendRequest {
  return { ...(structuredClone(sendText.request) as unknown as LinqSendRequest), to: to as string };
}

/** The test-phone line's stand-in: it keeps each request and answers accepted, as the line's double does. */
function standInLine(): { send: (request: LinqSendRequest) => Promise<LinqAccepted>; got: string[] } {
  const got: string[] = [];
  return {
    got,
    send: (request) => {
      got.push(request.to);
      const accepted = structuredClone(sendText.outcome) as unknown as LinqAccepted;
      return Promise.resolve({ ...accepted, providerMessageId: "line-msg-t1449" });
    },
  };
}

/** The real sender's stand-in and a maker that counts each sender it makes; each part it gets is kept. */
function countingMaker(): {
  make: (env: LinqLineEnv) => { sendPart: (request: unknown) => Promise<LinqFailed> };
  made: LinqLineEnv[];
  got: unknown[];
} {
  const made: LinqLineEnv[] = [];
  const got: unknown[] = [];
  const answer: LinqFailed = {
    result: "failed",
    kind: "refused",
    httpStatus: null,
    code: null,
    reason: "the real sender's stand-in",
    retryAfterSeconds: null,
    providerMessageId: null,
  };
  return {
    made,
    got,
    make: (env) => {
      made.push(env);
      return {
        sendPart: (request) => {
          got.push(request);
          return Promise.resolve(answer);
        },
      };
    },
  };
}

describe("the switch (DL-940): the real line is on only where ENVIRONMENT is staging and STAGING_LINQ_LINE is exactly real", () => {
  it("staging and real: on, read ENVIRONMENT first, then the switch", () => {
    const line = counted({ ...LINE_ON });

    expect(realLinqLineOn(line.env)).toBe(true);
    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
  });

  it.each(OFF_VALUES)("staging with the switch %s: off", (_name, value) => {
    const line = counted(withSwitch(value));

    expect(realLinqLineOn(line.env)).toBe(false);
    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
  });

  it.each(["production", "test", "preview", "", "Staging", "staging "])(
    "ENVIRONMENT %j with the switch real: off, and the switch is never read",
    (environment) => {
      const line = counted({ ...LINE_ON, ENVIRONMENT: environment });

      expect(realLinqLineOn(line.env)).toBe(false);
      expect(line.names).toEqual(["ENVIRONMENT"]);
    },
  );
});

describe("who is a test phone: in the fiction range, off STAGING_LINQ_ALLOWLIST (read as T-416's guard reads it), and not ROSIE_NUMBER", () => {
  const list = (allowlist: unknown, rosie: unknown = ROSIE): CountedEnv =>
    counted({ STAGING_LINQ_ALLOWLIST: allowlist, ROSIE_NUMBER: rosie });

  it("a fiction-range number off the list is a test phone, any area code that is not toll-free; the list's own and Rosie's line are not", () => {
    const line = list(ROSTER_PHONE);

    for (const number of [TEST_PHONE, OTHER_AREA_TEST_PHONE, "+15555550100", "+15555550198"])
      expect(isTestPhone(line.env, number), number).toBe(true);
    expect(isTestPhone(line.env, ROSTER_PHONE)).toBe(false);
    expect(isTestPhone(line.env, ROSIE)).toBe(false);
    // Rosie's own line is never a test phone, on the list or not.
    expect(isTestPhone(list(`${ROSTER_PHONE},${ROSIE}`).env, ROSIE)).toBe(false);
  });

  it("a number written any other way is no test phone, and nothing is read for it", () => {
    const line = list(ROSTER_PHONE);
    const written: unknown[] = [
      "+1 555 555 0101",
      "+1-555-555-0101",
      "+1 (555) 555-0101",
      "15555550101",
      " +15555550101",
      "+15555550101 ",
      "+15555550101\n",
      "tel:+15555550101",
      "+15555550101,+15555550142",
      15555550101,
      null,
      undefined,
      { number: TEST_PHONE },
      [TEST_PHONE],
    ];

    for (const number of written) expect(isTestPhone(line.env, number), String(number)).toBe(false);
    expect(line.names).toEqual([]);
  });

  it("a list with several entries: each is a roster phone, and every other fiction-range number a test phone", () => {
    const line = list(`${ROSTER_PHONE},+15555550142,+12125550143`);

    expect(isTestPhone(line.env, "+15555550142")).toBe(false);
    expect(isTestPhone(line.env, "+12125550143")).toBe(false);
    expect(isTestPhone(line.env, ROSTER_PHONE)).toBe(false);
    expect(isTestPhone(line.env, TEST_PHONE)).toBe(true);
    expect(isTestPhone(line.env, "+12125550142")).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 15555550150],
  ])(
    "a list %s names no number: every fiction-range number but Rosie's line is a test phone",
    (_name, value) => {
      const line = list(value);

      expect(isTestPhone(line.env, TEST_PHONE)).toBe(true);
      expect(isTestPhone(line.env, ROSTER_PHONE)).toBe(true);
      expect(isTestPhone(line.env, ROSIE)).toBe(false);
    },
  );

  it.each([
    ["a space after an entry", `${ROSTER_PHONE} `],
    ["a space after the comma", `${ROSTER_PHONE}, +15555550142`],
    ["an empty entry at the end", `${ROSTER_PHONE},`],
    ["an empty entry at the start", `,${ROSTER_PHONE}`],
    ["another separator", `${ROSTER_PHONE};+15555550142`],
    ["an entry with spaces", "+1 555 555 0150"],
    ["a line break", `${ROSTER_PHONE}\n`],
  ])(
    "a list that cannot be read (%s): no number is taken for a test phone, as the guard refuses every send then",
    (_name, value) => {
      const line = list(value);

      for (const number of [TEST_PHONE, OTHER_AREA_TEST_PHONE, ROSTER_PHONE, "+15555550142"])
        expect(isTestPhone(line.env, number), number).toBe(false);
    },
  );

  it("reads the list, then Rosie's line, at each call: a changed list is the one the next call reads", () => {
    const values: Record<string, unknown> = { STAGING_LINQ_ALLOWLIST: ROSTER_PHONE, ROSIE_NUMBER: ROSIE };
    const line = counted(values);

    expect(isTestPhone(line.env, TEST_PHONE)).toBe(true);
    expect(line.names).toEqual(["STAGING_LINQ_ALLOWLIST", "ROSIE_NUMBER"]);
    values.STAGING_LINQ_ALLOWLIST = `${ROSTER_PHONE},${TEST_PHONE}`;
    expect(isTestPhone(line.env, TEST_PHONE)).toBe(false);
  });
});

describe("the send by recipient (./send.ts's linqSendCall), over stand-ins: nothing here reaches Linq", () => {
  it.each(OFF_VALUES)(
    "the switch %s: every part, a roster phone's too, goes to the test-phone line; the real sender is never made, and no name this card adds is read",
    async (_name, value) => {
      const line = counted(withSwitch(value));
      const testPhoneLine = standInLine();
      const maker = countingMaker();
      const send = linqLineSend(line.env, testPhoneLine.send, { realSender: maker.make });

      for (const to of [ROSTER_PHONE, TEST_PHONE, ROSIE, "+1 555 555 0150"]) {
        expect(await send(partTo(to))).toMatchObject({
          result: "accepted",
          providerMessageId: "line-msg-t1449",
        });
      }

      expect(testPhoneLine.got).toEqual([ROSTER_PHONE, TEST_PHONE, ROSIE, "+1 555 555 0150"]);
      expect(maker.made).toEqual([]);
      expect(maker.got).toEqual([]);
      expect(new Set(line.names)).toEqual(new Set(["ENVIRONMENT", STAGING_LINQ_LINE]));
      for (const name of NEW_NAMES) expect(line.names, name).not.toContain(name);
    },
  );

  it("production with the switch real: every part to the line, the switch never read", async () => {
    const line = counted({ ...LINE_ON, ENVIRONMENT: "production" });
    const testPhoneLine = standInLine();
    const maker = countingMaker();
    const send = linqLineSend(line.env, testPhoneLine.send, { realSender: maker.make });

    await send(partTo(ROSTER_PHONE));

    expect(testPhoneLine.got).toEqual([ROSTER_PHONE]);
    expect(maker.made).toEqual([]);
    expect(line.names).toEqual(["ENVIRONMENT"]);
  });

  it("the real line on: a test phone's part goes to the test-phone line; every other part to the real sender, made once, at its first part, over the Worker's env", async () => {
    const line = counted({ ...LINE_ON });
    const testPhoneLine = standInLine();
    const maker = countingMaker();

    const send = linqLineSend(line.env, testPhoneLine.send, { realSender: maker.make });
    // Nothing is read or made as it is built.
    expect(line.names).toEqual([]);
    expect(maker.made).toEqual([]);

    const toTestPhone = await send(partTo(TEST_PHONE));
    expect(toTestPhone).toMatchObject({ result: "accepted", providerMessageId: "line-msg-t1449" });
    expect(maker.made).toEqual([]);

    // The roster phone, Rosie's own line and an ill-formed `to`: each to the real sender (whose guard refuses the last two).
    const others = [ROSTER_PHONE, ROSIE, "+1 555 555 0150", "15555550150"];
    for (const to of others) {
      expect(await send(partTo(to))).toMatchObject({
        result: "failed",
        reason: "the real sender's stand-in",
      });
    }

    // Read at each part: the switch, then (for a number in the range) the list and Rosie's line; never a key or a secret
    // (the real sender's own reads are its stand-in's here).
    expect(new Set(line.names)).toEqual(
      new Set(["ENVIRONMENT", STAGING_LINQ_LINE, "STAGING_LINQ_ALLOWLIST", "ROSIE_NUMBER"]),
    );
    expect(testPhoneLine.got).toEqual([TEST_PHONE]);
    // One sender, made over the Worker's env itself (by identity: nothing of the env is read to compare it).
    expect(maker.made).toHaveLength(1);
    expect(maker.made[0]).toBe(line.env);
    expect(maker.got.map((request) => (request as LinqSendRequest).to)).toEqual(others);
    // The request goes to the real sender as it came.
    expect(maker.got[0]).toEqual(partTo(ROSTER_PHONE));
  });

  it("the switch is read at each part: turned off, the next part to a roster phone goes to the test-phone line", async () => {
    const values: Record<string, unknown> = { ...LINE_ON };
    const testPhoneLine = standInLine();
    const maker = countingMaker();
    const send = linqLineSend(counted(values).env, testPhoneLine.send, { realSender: maker.make });

    await send(partTo(ROSTER_PHONE));
    values[STAGING_LINQ_LINE] = "double";
    await send(partTo(ROSTER_PHONE));

    expect(maker.got).toHaveLength(1);
    expect(testPhoneLine.got).toEqual([ROSTER_PHONE]);
  });
});

describe("the Linq verify input the Worker's root is handed (../root.ts workerRoot)", () => {
  it("production: LINQ_WEBHOOK_SECRET alone, read at each call, and nothing read to make it but ENVIRONMENT", () => {
    const line = counted({ ...LINE_ON, ENVIRONMENT: "production" });

    const inputs = stagingLinqVerifyInputs(line.env);

    expect(Object.keys(inputs)).toEqual(["webhookSecret"]);
    expect(line.names).toEqual(["ENVIRONMENT"]);
    expect(inputs.webhookSecret()).toBe(LINQ_SECRET);
    expect(line.names).toEqual(["ENVIRONMENT", "LINQ_WEBHOOK_SECRET"]);
  });

  it.each(OFF_VALUES)(
    "staging with the switch %s: LINQ_WEBHOOK_SECRET alone, as before; nothing more read",
    (_name, value) => {
      const line = counted(withSwitch(value));

      const inputs = stagingLinqVerifyInputs(line.env);

      expect(Object.keys(inputs)).toEqual(["webhookSecret"]);
      expect(inputs.pageSecret).toBeUndefined();
      expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
      expect(inputs.webhookSecret()).toBe(LINQ_SECRET);
    },
  );

  it("the real line on: the test-phone page's own secret beside it, named, read at each call, which speaks for a test phone alone", () => {
    const values: Record<string, unknown> = { ...LINE_ON };
    const line = counted(values);

    const inputs = stagingLinqVerifyInputs(line.env);
    const page = inputs.pageSecret;
    if (page === undefined) throw new Error("the real line gave no page secret");

    expect(line.names).toEqual(["ENVIRONMENT", STAGING_LINQ_LINE]);
    expect(page.name).toBe(TEST_PHONE_WEBHOOK_SECRET);
    expect(inputs.webhookSecret()).toBe(LINQ_SECRET);
    expect(page.secret()).toBe(PAGE_SECRET);
    // Read at each call: a missing or non-text value is no secret.
    Reflect.deleteProperty(values, TEST_PHONE_WEBHOOK_SECRET);
    expect(page.secret()).toBeUndefined();
    values[TEST_PHONE_WEBHOOK_SECRET] = 12345;
    expect(page.secret()).toBeUndefined();

    expect(page.speaksFor({ kind: "phone", address: TEST_PHONE })).toBe(true);
    expect(page.speaksFor({ kind: "phone", address: OTHER_AREA_TEST_PHONE })).toBe(true);
    expect(page.speaksFor({ kind: "phone", address: ROSTER_PHONE })).toBe(false);
    expect(page.speaksFor({ kind: "phone", address: ROSIE })).toBe(false);
    expect(page.speaksFor({ kind: "email", address: TEST_PHONE })).toBe(false);
    expect(page.speaksFor({ kind: "email", address: "tester@example.com" })).toBe(false);
  });
});
