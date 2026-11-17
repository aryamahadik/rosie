// T-415: the Linq contacts registrar (C-208; K-11 v1 contactAdd), a stub that makes no network call (CQ-354), against
// K-11 v1's two contactAdd fixtures. There is no recorded Linq answer to map from: Linq's v3 API has no contacts/add (K-11
// README open gap 1; T-1121 FINDINGS.md answer 1), so each fixture's request is answered with K-11's failed result, never
// added, and the refusal when ENVIRONMENT is test stands (build prompt 9.4). No network and no real key: the runtime's own
// fetch is replaced by one that refuses, and no test may call it; the environment's key is a made-up string built here
// (rule 7). Every number is a fiction one (555-01xx: rule 9).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createLinqDouble } from "../double/double";
import { ENVIRONMENT, NO_PHONE, REASONS, createLinqContactRegistrar, type LinqContactsEnv } from "./contacts";
import type { ContactAddOutcome } from "./types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(HERE, "..", "..", "..", "..", "contracts");
const FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const K11_ID = "https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json";

// Made up here, not a key of any service, and not in a key's shape (rule 7).
const FAKE_KEY = "fake-linq-key-t415-0001";
const FIXTURE_NAMES = ["contact-add-failed.json", "contact-add-ok.json"];

interface ContactExchange {
  call: string;
  given: { now: string; note: string };
  request: { phone: string };
  outcome: ContactAddOutcome;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const fixture = (name: string): ContactExchange => readJson(path.join(FIXTURES, name)) as ContactExchange;

const registrar = (env: LinqContactsEnv) => createLinqContactRegistrar({ env });
// Each environment holds the key too, as the Worker's does: the stub must never read it.
const staging: Record<string, unknown> = { ENVIRONMENT: "staging", LINQ_API_TOKEN: FAKE_KEY };
const testEnvironment: Record<string, unknown> = { ENVIRONMENT: "test", LINQ_API_TOKEN: FAKE_KEY };
const keyOnly: Record<string, unknown> = { LINQ_API_TOKEN: FAKE_KEY };

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** Runs `body` with every console method recorded instead of written, and gives back each line it would have written. */
async function consoleLinesDuring(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }),
  );
  try {
    await body();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines;
}

let validateExchange: ValidateFunction;
let validateFailed: ValidateFunction;
let runtimeFetch: MockInstance<typeof fetch>;

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (as the Linq double's test loads them).
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name)))
      if (file.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)) as object);
  }
  const exchange = ajv.getSchema(`${K11_ID}#/$defs/contactAdd.exchange`);
  const errors = ajv.getSchema(`${K11_ID}#/$defs/contactAdd.errors`);
  if (exchange === undefined || errors === undefined) throw new Error("a contract schema is missing");
  validateExchange = exchange;
  validateFailed = errors;
});

// The stub makes no network call: the runtime's own fetch refuses, and every test checks that nothing called it.
beforeEach(() => {
  runtimeFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.reject(new Error("no network call in this test")));
});

afterEach(() => {
  try {
    expect(runtimeFetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

function expectExchange(exchange: ContactExchange, outcome: ContactAddOutcome): void {
  const checked = { ...exchange, outcome };
  expect(validateExchange(checked), JSON.stringify(validateExchange.errors)).toBe(true);
}

function expectFailed(outcome: unknown): void {
  expect(validateFailed(outcome), JSON.stringify(validateFailed.errors)).toBe(true);
}

describe("the K-11 v1 contactAdd fixtures", () => {
  it("tests every contactAdd fixture K-11 v1's index lists", () => {
    const index = readJson(path.join(FIXTURES, "index.json")) as {
      fixtures: { file: string; def: string }[];
    };
    const files = index.fixtures
      .filter((entry) => entry.def === "contactAdd.exchange")
      .map((entry) => entry.file);
    expect(files.sort()).toEqual(FIXTURE_NAMES);
  });
});

describe("the fixtures' requests: K-11's failed result, with no network call (CQ-354)", () => {
  it("contact-add-failed.json: its request gets the fixture's failed result, not retryable, no code, in the stub's words", async () => {
    const exchange = fixture("contact-add-failed.json");
    const outcome = await registrar(staging).contactAdd(exchange.request);

    expect(outcome).toEqual({
      result: "failed",
      phone: exchange.request.phone,
      retryable: false,
      code: null,
      reason: REASONS.noContactsCall,
    });
    // Field for field the fixture's outcome, but for the reason: no Linq answer exists to read a reason from.
    expect({ ...outcome, reason: "" }).toEqual({ ...exchange.outcome, reason: "" });
    expectExchange(exchange, outcome);
  });

  it("contact-add-ok.json: no Linq answer can map to added (CQ-354), so its request gets failed, never added", async () => {
    const exchange = fixture("contact-add-ok.json");
    expect(exchange.outcome.result).toBe("added");
    const outcome = await registrar(staging).contactAdd(exchange.request);

    expect(outcome).toEqual({
      result: "failed",
      phone: exchange.request.phone,
      retryable: false,
      code: null,
      reason: REASONS.noContactsCall,
    });
    expectExchange(exchange, outcome);
  });

  it("answers the same in production, and the same again for a mobile asked before", async () => {
    for (const name of FIXTURE_NAMES) {
      const exchange = fixture(name);
      const production = registrar({ ENVIRONMENT: "production" });
      const first = await production.contactAdd(exchange.request);
      const again = await production.contactAdd(exchange.request);
      expect(first).toEqual(await registrar(staging).contactAdd(exchange.request));
      expect(again).toEqual(first);
      expectExchange(exchange, first);
    }
  });
});

describe("refused when ENVIRONMENT is test: automated tests never add a contact on the real line (build prompt 9.4)", () => {
  it("refuses each fixture's request when ENVIRONMENT is test, sending nothing", async () => {
    for (const name of FIXTURE_NAMES) {
      const exchange = fixture(name);
      const outcome = await registrar(testEnvironment).contactAdd(exchange.request);
      expect(outcome).toEqual({
        result: "failed",
        phone: exchange.request.phone,
        retryable: false,
        code: null,
        reason: REASONS.testEnvironment,
      });
      expect(REASONS.testEnvironment).toContain("ENVIRONMENT is test");
      expect(outcome).not.toEqual(await registrar(staging).contactAdd(exchange.request));
      expectExchange(exchange, outcome);
    }
  });

  it("refuses the same way, failing closed, when ENVIRONMENT is unset, blank or not staging or production", async () => {
    const request = fixture("contact-add-ok.json").request;
    const envs: LinqContactsEnv[] = [
      {},
      { ENVIRONMENT: "" },
      { ENVIRONMENT: "   " },
      { ENVIRONMENT: "Test" },
      { ENVIRONMENT: "local" },
      { ENVIRONMENT: "Staging" },
      { ENVIRONMENT: 1 },
      { ENVIRONMENT: null },
    ];
    for (const env of envs) {
      const outcome = await registrar(env).contactAdd(request);
      expect(outcome).toEqual({
        result: "failed",
        phone: request.phone,
        retryable: false,
        code: null,
        reason: REASONS.otherEnvironment,
      });
      expectFailed(outcome);
    }
  });

  it("reads ENVIRONMENT at each call", async () => {
    const request = fixture("contact-add-ok.json").request;
    const env: { ENVIRONMENT?: string } = { ENVIRONMENT: "test" };
    const contacts = registrar(env);
    expect(await contacts.contactAdd(request)).toMatchObject({ reason: REASONS.testEnvironment });
    env.ENVIRONMENT = "staging";
    expect(await contacts.contactAdd(request)).toMatchObject({ reason: REASONS.noContactsCall });
    env.ENVIRONMENT = "test";
    expect(await contacts.contactAdd(request)).toMatchObject({ reason: REASONS.testEnvironment });
  });
});

describe("a request with no E.164 phone", () => {
  it("gets the Linq double's code and words, naming NO_PHONE, in every environment", async () => {
    const requests: unknown[] = [
      null,
      "a contact",
      42,
      [],
      {},
      { phone: null },
      { phone: 15555550101 },
      { phone: "5555550101" },
      { phone: "+1 555 555 0101" },
      { phone: "+15555550101 " },
      { number: "+15555550101" },
    ];
    for (const request of requests) {
      const double = createLinqDouble().contactAdd(request);
      for (const env of [staging, testEnvironment, keyOnly]) {
        const outcome = await registrar(env).contactAdd(request);
        expect(outcome).toEqual({
          result: "failed",
          phone: NO_PHONE,
          retryable: false,
          code: "1002",
          reason: REASONS.notE164,
        });
        // The double's answer in every field but the phone, where the double names its own placeholder.
        expect({ ...outcome, phone: "" }).toEqual({ ...double, phone: "" });
        expectFailed(outcome);
      }
    }
  });
});

describe("no network, no key, no log line", () => {
  it("reads no name but ENVIRONMENT from the environment it is given: never LINQ_API_TOKEN", async () => {
    const read: string[] = [];
    const values: Record<string, unknown> = {
      ENVIRONMENT: "staging",
      LINQ_API_TOKEN: FAKE_KEY,
      LINQ_WEBHOOK_SECRET: "fake-webhook-secret",
    };
    const env = new Proxy(values, {
      get(target, name, receiver) {
        read.push(String(name));
        return Reflect.get(target, name, receiver) as unknown;
      },
    });
    const contacts = registrar(env);
    for (const name of FIXTURE_NAMES) await contacts.contactAdd(fixture(name).request);
    values.ENVIRONMENT = "test";
    for (const name of FIXTURE_NAMES) await contacts.contactAdd(fixture(name).request);
    await contacts.contactAdd({ phone: "not a number" });
    expect([...new Set(read)]).toEqual([ENVIRONMENT]);
  });

  it("writes no log line on any path, so the key reaches none", async () => {
    const outcomes: ContactAddOutcome[] = [];
    const lines = await consoleLinesDuring(async () => {
      for (const env of [staging, testEnvironment, keyOnly]) {
        const contacts = registrar(env);
        for (const name of FIXTURE_NAMES) outcomes.push(await contacts.contactAdd(fixture(name).request));
        outcomes.push(await contacts.contactAdd({ phone: FAKE_KEY }));
      }
    });
    expect(lines).toEqual([]);
    expect(outcomes).toHaveLength(9);
    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
      expectFailed(outcome);
    }
  });
});
