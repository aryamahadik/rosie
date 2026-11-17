// T-415: the Linq capability check (C-209; K-11 v1 capabilityCheck) against T-1121's live samples, K-11 v1's fixture and
// its vendor samples. Each test names what it replays:
//   recorded       T-1121's live run of Nov 17 to the roster iPhone (adapters/spikes/linq-live/samples): check_imessage
//                  and check_rcs both answered 200, available true, with address and available alone (FINDINGS.md
//                  answer 3; DL-923)
//   fixture-only   an Android or a landline: no such phone has answered a real check (no roster phone of either kind;
//                  Q-37 stays open), so these mappings come from K-11 v1's fixture capability.json and its vendor samples
//                  alone, or, where K-11 v1 has no fixture (a landline), from README 'Spike findings' row 13's documented
//                  fields alone
// No network and no real key: the HTTP call is a stub that records each request and answers with a recorded or documented
// response, the runtime's own fetch is replaced by one that refuses, and the key is a made-up string built here (rule 7).
// Every number is a fiction one (555-01xx: rule 9); the live samples' numbers are masked (***NN) and are read as recorded
// vendor answers.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadRecordedSample } from "../../shared/samples";
import { createLinqDouble } from "../double/double";
import {
  LINQ_API_TOKEN,
  NO_PHONE,
  createLinqCapabilityChecker,
  type LinqCapabilityCheckerOptions,
  type LinqCapabilityEnv,
} from "./capability";
import type { CapabilityCheckOutcome } from "./types";
import { CHECK_IMESSAGE_PATH, CHECK_RCS_PATH, LINQ_API_BASE, USER_AGENT, readCheck } from "./wire";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CONTRACTS = path.join(ROOT, "contracts");
const FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const VENDOR_SAMPLES = path.join(CONTRACTS, "port-linq", "vendor-samples");
const LIVE_SAMPLES = path.join(ROOT, "adapters", "spikes", "linq-live", "samples");
const K11_ID = "https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json";

// Made up here, not a key of any service, and not in a key's shape (rule 7).
const FAKE_KEY = "fake-linq-key-t415-0001";
const NOW = "2026-11-17T00:27:35Z";
// A fiction number standing in for the live run's roster iPhone, which the recorded samples mask as ***90: it ends in the
// same two digits, so the request it makes, masked the same way, is the recorded request.
const LIVE_RUN_PHONE = "+15555550190";
// Tomás, capability.json's number (no iMessage now, RCS).
const TOMAS = "+15555550105";
// A fiction number for the landline case, which K-11 v1 has no fixture for.
const LANDLINE = "+15555550109";
const LIVE_IMESSAGE = "live-2026-11-17T00-27-34Z-01-capability-check_imessage.json";
const LIVE_RCS = "live-2026-11-17T00-27-34Z-02-capability-check_rcs.json";
const IMESSAGE_URL = `${LINQ_API_BASE}${CHECK_IMESSAGE_PATH}`;
const RCS_URL = `${LINQ_API_BASE}${CHECK_RCS_PATH}`;

/** Every header of every check, as the stub sees them (names in lower case). */
const SENT_HEADERS = {
  accept: "application/json",
  authorization: `Bearer ${FAKE_KEY}`,
  "content-type": "application/json",
  "user-agent": USER_AGENT,
};

interface CapabilityExchange {
  call: string;
  given: { now: string; note: string };
  request: { phone: string };
  outcome: CapabilityCheckOutcome;
}

/** One file of the live run (FINDINGS.md 'The samples'). */
interface LiveSample {
  request: { method: string; path: string; body: Record<string, unknown> };
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> };
}

/** One request as the stub saw it. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

type Answer = (request: Request) => Response | Promise<Response>;

const parseJson = (text: string): unknown => JSON.parse(text);
const readJson = (file: string): unknown => parseJson(readFileSync(file, "utf8"));
const fixture = (name: string): CapabilityExchange =>
  readJson(path.join(FIXTURES, name)) as CapabilityExchange;
const vendorSample = (name: string): unknown => loadRecordedSample(VENDOR_SAMPLES, name);
const liveSample = (name: string): LiveSample => loadRecordedSample(LIVE_SAMPLES, name) as LiveSample;

/** Every number in a text as the live samples write it: *** and its last 2 digits. */
const maskNumbers = (text: string): string =>
  text.replace(/\+[1-9][0-9]{6,14}/g, (number) => `***${number.slice(-2)}`);

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A live sample's recorded answer: its status, its kept headers and its body. */
function recordedAnswer(name: string): Response {
  const { response } = liveSample(name);
  return json(response.status, response.body, response.headers);
}

/** Linq's error body in its documented form (README 'Spike findings' row 14), with a code given here. */
function linqError(status: number, code: unknown, message = "Made up for a test."): unknown {
  return {
    success: false,
    error: { status, code, message, doc_url: "https://docs.linqapp.com/error/" },
    trace_id: "linq-trace-test-0001",
  };
}

/** A stub of the HTTP call: records each request and answers by its URL; a URL it has no answer for is a thrown error. */
function stubFetch(answers: Partial<Record<string, Answer>>): {
  fetch: (request: Request) => Promise<Response>;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
        redirect: request.redirect,
      });
      const answer = answers[request.url];
      if (answer === undefined) throw new Error("the stub has no answer for this URL");
      return answer(request);
    },
  };
}

function checker(env: LinqCapabilityEnv, rest: Omit<LinqCapabilityCheckerOptions, "env"> = {}) {
  return createLinqCapabilityChecker({ env, now: () => NOW, ...rest });
}

const withKey: LinqCapabilityEnv = { LINQ_API_TOKEN: FAKE_KEY };

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

beforeAll(() => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (as the Linq double's test loads them).
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name)))
      if (file.endsWith(".schema.json"))
        ajv.addSchema(readJson(path.join(CONTRACTS, folder.name, file)) as object);
  }
  const exchange = ajv.getSchema(`${K11_ID}#/$defs/capabilityCheck.exchange`);
  const errors = ajv.getSchema(`${K11_ID}#/$defs/capabilityCheck.errors`);
  if (exchange === undefined || errors === undefined) throw new Error("a contract schema is missing");
  validateExchange = exchange;
  validateFailed = errors;
});

// No test reaches the network: the runtime's own fetch refuses, unless a test gives it an answer of its own.
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.reject(new Error("no network call in this test")),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Holds an outcome, with its request, to K-11's capabilityCheck.exchange. */
function expectExchange(request: unknown, outcome: CapabilityCheckOutcome, now = NOW): void {
  const exchange = { call: "capabilityCheck", given: { now, note: "T-415" }, request, outcome };
  expect(validateExchange(exchange), JSON.stringify(validateExchange.errors)).toBe(true);
}

function expectFailed(outcome: unknown): void {
  expect(validateFailed(outcome), JSON.stringify(validateFailed.errors)).toBe(true);
}

describe("the K-11 v1 capability fixture", () => {
  it("tests every capabilityCheck fixture K-11 v1's index lists", () => {
    const index = readJson(path.join(FIXTURES, "index.json")) as {
      fixtures: { file: string; def: string }[];
    };
    const files = index.fixtures
      .filter((entry) => entry.def === "capabilityCheck.exchange")
      .map((entry) => entry.file);
    expect(files).toEqual(["capability.json"]);
  });
});

describe("recorded: T-1121's live run to the roster iPhone (Nov 17)", () => {
  it("holds what the samples say: both checks POST, 200, available true, with address and available alone", () => {
    for (const name of [LIVE_IMESSAGE, LIVE_RCS]) {
      const { request, response } = liveSample(name);
      expect(request.method).toBe("POST");
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(["address", "available"]);
      expect(response.body.available).toBe(true);
    }
  });

  it("check_imessage's recorded answer reads as checked: iMessage, service imessage, kept 600 s; check_rcs is not asked", async () => {
    const stub = stubFetch({ [IMESSAGE_URL]: () => recordedAnswer(LIVE_IMESSAGE) });
    const request = { phone: LIVE_RUN_PHONE };
    const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck(request);

    expect(outcome).toEqual({
      result: "checked",
      phone: LIVE_RUN_PHONE,
      imessage: true,
      service: "imessage",
      checkedAt: NOW,
      cacheSeconds: 600,
    });
    expectExchange(request, outcome);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL]);
    const [seen] = stub.seen;
    if (seen === undefined) throw new Error("no request was sent");
    const recorded = liveSample(LIVE_IMESSAGE).request;
    expect(seen.method).toBe(recorded.method);
    expect(new URL(seen.url).pathname).toBe(recorded.path);
    expect(seen.body).toBe(JSON.stringify({ address: LIVE_RUN_PHONE }));
    expect(parseJson(maskNumbers(seen.body))).toEqual(recorded.body);
    expect(seen.headers).toEqual(SENT_HEADERS);
    expect(seen.redirect).toBe("manual");

    // The Linq double's own answer for a number it has not been told about is this one, imessage with service imessage
    // (T-411): on the recorded answer the adapter and the double give the same port-level result (K-11 README
    // 'Producers and consumers').
    expect(outcome).toEqual(createLinqDouble({ now: () => NOW }).capabilityCheck(request));
  });

  it("check_rcs's recorded answer, asked when check_imessage says not available and names no service, reads as RCS", async () => {
    // The check_imessage answer here is row 13's documented fields with no selected_service, which no real phone has
    // sent (the roster iPhone's said available); the check_rcs request and answer are the recorded ones.
    const stub = stubFetch({
      [IMESSAGE_URL]: () => json(200, { address: LIVE_RUN_PHONE, available: false, reason: "not_supported" }),
      [RCS_URL]: () => recordedAnswer(LIVE_RCS),
    });
    const request = { phone: LIVE_RUN_PHONE };
    const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck(request);

    expect(outcome).toEqual({
      result: "checked",
      phone: LIVE_RUN_PHONE,
      imessage: false,
      service: "rcs",
      checkedAt: NOW,
      cacheSeconds: 600,
    });
    expectExchange(request, outcome);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL, RCS_URL]);
    const rcs = stub.seen[1];
    if (rcs === undefined) throw new Error("no RCS check was sent");
    const recorded = liveSample(LIVE_RCS).request;
    expect(rcs.method).toBe(recorded.method);
    expect(new URL(rcs.url).pathname).toBe(recorded.path);
    expect(parseJson(maskNumbers(rcs.body))).toEqual(recorded.body);
    expect(rcs.headers).toEqual(SENT_HEADERS);
    expect(rcs.redirect).toBe("manual");
  });

  it("reads both recorded answers as Linq's available flag alone, with no service named", () => {
    const checks = [
      ["imessage", LIVE_IMESSAGE],
      ["rcs", LIVE_RCS],
    ] as const;
    for (const [check, name] of checks) {
      const { response } = liveSample(name);
      expect(readCheck(check, response.status, JSON.stringify(response.body))).toEqual({
        answered: true,
        available: true,
        selectedService: null,
      });
    }
  });
});

describe("fixture-only: an Android, which no real phone has answered (Q-37 stays open)", () => {
  it("capability.json from K-11's vendor samples: not available, selected_service RCS, is the fixture's outcome; check_rcs is not asked", async () => {
    const exchange = fixture("capability.json");
    const stub = stubFetch({
      [IMESSAGE_URL]: () => json(200, vendorSample("capability-check-imessage-response.json")),
    });
    const outcome = await checker(withKey, {
      fetch: stub.fetch,
      now: () => exchange.given.now,
    }).capabilityCheck(exchange.request);

    expect(outcome).toEqual(exchange.outcome);
    expect(validateExchange({ ...exchange, outcome }), JSON.stringify(validateExchange.errors)).toBe(true);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL]);
    expect(stub.seen[0]?.body).toBe(JSON.stringify(vendorSample("capability-check-request.json")));

    // The Linq double, told the same of Tomás's number, gives the same port-level answer (K-11 README 'Producers and
    // consumers': the double and the adapter give the same results).
    const double = createLinqDouble({ now: () => exchange.given.now });
    double.setCapability(TOMAS, { result: "checked", imessage: false, service: "rcs" });
    expect(outcome).toEqual(double.capabilityCheck(exchange.request));
  });

  it("capability.json when check_imessage names no service: check_rcs says available, and the outcome is the fixture's", async () => {
    // Row 13's documented fields for both answers (no selected_service), with capability.json's number.
    const exchange = fixture("capability.json");
    const stub = stubFetch({
      [IMESSAGE_URL]: () => json(200, { address: TOMAS, available: false, reason: "not_supported" }),
      [RCS_URL]: () => json(200, { address: TOMAS, available: true }),
    });
    const outcome = await checker(withKey, {
      fetch: stub.fetch,
      now: () => exchange.given.now,
    }).capabilityCheck(exchange.request);

    expect(outcome).toEqual(exchange.outcome);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL, RCS_URL]);
    for (const seen of stub.seen) {
      expect(seen.body).toBe(JSON.stringify(vendorSample("capability-check-request.json")));
      expect(seen.headers).toEqual(SENT_HEADERS);
    }
  });
});

describe("fixture-only: a landline, which no real phone has answered (Q-37 stays open; K-11 v1 has no landline fixture)", () => {
  it("neither check says available and neither names a service: checked, no iMessage, service null (Linq cannot tell)", async () => {
    const stub = stubFetch({
      [IMESSAGE_URL]: () => json(200, { address: LANDLINE, available: false, reason: "not_supported" }),
      [RCS_URL]: () => json(200, { address: LANDLINE, available: false, reason: "not_supported" }),
    });
    const request = { phone: LANDLINE };
    const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck(request);

    expect(outcome).toEqual({
      result: "checked",
      phone: LANDLINE,
      imessage: false,
      service: null,
      checkedAt: NOW,
      cacheSeconds: 600,
    });
    expectExchange(request, outcome);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL, RCS_URL]);
  });

  it("a service a check names in selected_service is the service, SMS included", async () => {
    const notAvailable = { address: LANDLINE, available: false, reason: "not_supported" };
    const cases: [Partial<Record<string, Answer>>, string[]][] = [
      [{ [IMESSAGE_URL]: () => json(200, { ...notAvailable, selected_service: "SMS" }) }, [IMESSAGE_URL]],
      [
        {
          [IMESSAGE_URL]: () => json(200, notAvailable),
          [RCS_URL]: () => json(200, { ...notAvailable, selected_service: "SMS" }),
        },
        [IMESSAGE_URL, RCS_URL],
      ],
    ];
    for (const [answers, urls] of cases) {
      const stub = stubFetch(answers);
      const request = { phone: LANDLINE };
      const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck(request);
      expect(outcome).toMatchObject({ result: "checked", imessage: false, service: "sms" });
      expectExchange(request, outcome);
      expect(stub.seen.map((seen) => seen.url)).toEqual(urls);
    }
  });
});

describe("readCheck: one check's answer", () => {
  it("names the service selected_service names, in any case, and none for a name Linq does not use", () => {
    const cases: [unknown, string | null][] = [
      ["iMessage", "imessage"],
      ["RCS", "rcs"],
      ["rcs", "rcs"],
      ["SMS", "sms"],
      ["WhatsApp", null],
      ["", null],
      [7, null],
      [null, null],
    ];
    for (const [given, service] of cases) {
      const body = { address: TOMAS, available: false, selected_service: given };
      expect(readCheck("imessage", 200, JSON.stringify(body))).toEqual({
        answered: true,
        available: false,
        selectedService: service,
      });
    }
  });
});

describe("Linq's other answers: failed, so the reply goes as text alone", () => {
  const refused = "Linq refused the iMessage check.";
  const serverError = "A server error at Linq answered the iMessage check.";
  const unreadable = "Linq's answer to the iMessage check could not be read.";
  const cases: [string, Answer, { code: string | null; reason: string }][] = [
    [
      "429 with code 1007 (the vendor sample error-1007-rate-limit.json)",
      () =>
        json(429, vendorSample("error-1007-rate-limit.json"), {
          "content-type": "application/json",
          "retry-after": "65",
        }),
      { code: "1007", reason: "Linq's rate limit: the iMessage check was not answered." },
    ],
    [
      "400 with code 1002 (a number in another form)",
      () => json(400, linqError(400, 1002)),
      { code: "1002", reason: refused },
    ],
    [
      "403 with code 2008 (not in the allowed list)",
      () => json(403, linqError(403, 2008)),
      { code: "2008", reason: refused },
    ],
    ["401 with no body", () => new Response(null, { status: 401 }), { code: null, reason: refused }],
    [
      "403 that is not JSON",
      () => new Response("error code: 1010", { status: 403 }),
      { code: null, reason: refused },
    ],
    [
      "500 with its code as text",
      () => json(500, linqError(500, "4001")),
      { code: "4001", reason: serverError },
    ],
    [
      "503 with a code that is not a number",
      () => json(503, linqError(503, "unavailable")),
      { code: null, reason: serverError },
    ],
    ["200 with no available flag", () => json(200, { address: TOMAS }), { code: null, reason: unreadable }],
    [
      "200 with available as a word",
      () => json(200, { address: TOMAS, available: "true" }),
      { code: null, reason: unreadable },
    ],
    [
      "200 that is not JSON",
      () => new Response("<html></html>", { status: 200 }),
      { code: null, reason: unreadable },
    ],
    [
      "302, a redirect not followed",
      () => new Response(null, { status: 302, headers: { location: "https://example.com/" } }),
      { code: null, reason: unreadable },
    ],
    [
      "a network error",
      () => Promise.reject(new TypeError(`fetch failed for Bearer ${FAKE_KEY}`)),
      { code: null, reason: "No answer came to the iMessage check: a timeout or a network error." },
    ],
  ];

  it.each(cases)("reads %s", async (_label, answer, expected) => {
    const stub = stubFetch({ [IMESSAGE_URL]: answer });
    const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck({ phone: TOMAS });
    expect(outcome).toEqual({ result: "failed", phone: TOMAS, ...expected });
    expectFailed(outcome);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL]);
    expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
  });

  it("fails the check when check_rcs, asked after check_imessage names no service, is not answered", async () => {
    const stub = stubFetch({
      [IMESSAGE_URL]: () => json(200, { address: TOMAS, available: false }),
      [RCS_URL]: () => new Response(null, { status: 502 }),
    });
    const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck({ phone: TOMAS });
    expect(outcome).toEqual({
      result: "failed",
      phone: TOMAS,
      code: null,
      reason: "A server error at Linq answered the RCS check.",
    });
    expectFailed(outcome);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL, RCS_URL]);
  });

  it("fails the check with no code when no answer comes in time", async () => {
    const stub = stubFetch({
      [IMESSAGE_URL]: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });
    const outcome = await checker(withKey, { fetch: stub.fetch, timeoutMs: 20 }).capabilityCheck({
      phone: TOMAS,
    });
    expect(outcome).toEqual({
      result: "failed",
      phone: TOMAS,
      code: null,
      reason: "No answer came to the iMessage check: a timeout or a network error.",
    });
  });
});

describe("refused before any request", () => {
  it("a request with no E.164 phone gets the Linq double's code and words, naming NO_PHONE, and nothing is sent", async () => {
    const requests: unknown[] = [
      null,
      "a check",
      42,
      [],
      {},
      { phone: null },
      { phone: 15555550105 },
      { phone: "5555550105" },
      { phone: "+1 555 555 0105" },
      { phone: `${TOMAS} ` },
      { number: TOMAS },
    ];
    for (const request of requests) {
      const stub = stubFetch({});
      const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck(request);
      expect(outcome).toEqual({
        result: "failed",
        phone: NO_PHONE,
        code: "1002",
        reason: "The number is not in E.164 form.",
      });
      // The double's answer in every field but the phone, where the double names its own placeholder.
      expect({ ...outcome, phone: "" }).toEqual({
        ...createLinqDouble().capabilityCheck(request),
        phone: "",
      });
      expectFailed(outcome);
      expect(stub.seen).toEqual([]);
    }
  });

  it("no key, or a key no header can carry, fails the check naming LINQ_API_TOKEN alone, and nothing is sent", async () => {
    const notSet = `${LINQ_API_TOKEN} is not set: nothing was sent.`;
    const badForm = `${LINQ_API_TOKEN} holds a space or a character a header cannot carry: nothing was sent.`;
    const cases: [LinqCapabilityEnv, string][] = [
      [{}, notSet],
      [{ LINQ_API_TOKEN: "" }, notSet],
      [{ LINQ_API_TOKEN: "   " }, notSet],
      [{ LINQ_API_TOKEN: 42 }, notSet],
      [{ LINQ_API_TOKEN: null }, notSet],
      [{ LINQ_API_TOKEN: `${FAKE_KEY}\n` }, badForm],
      [{ LINQ_API_TOKEN: `${FAKE_KEY} 2` }, badForm],
      [{ LINQ_API_TOKEN: `${FAKE_KEY}é` }, badForm],
    ];
    for (const [env, reason] of cases) {
      const stub = stubFetch({ [IMESSAGE_URL]: () => recordedAnswer(LIVE_IMESSAGE) });
      const outcome = await checker(env, { fetch: stub.fetch }).capabilityCheck({ phone: TOMAS });
      expect(outcome).toEqual({ result: "failed", phone: TOMAS, code: null, reason });
      expectFailed(outcome);
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
      expect(stub.seen).toEqual([]);
    }
  });
});

describe("the key: read by name at each call, sent only as the bearer, never logged", () => {
  it("sends the key only as the Authorization header's bearer: no URL, body or outcome holds it", async () => {
    const stub = stubFetch({
      [IMESSAGE_URL]: () => json(200, { address: TOMAS, available: false }),
      [RCS_URL]: () => json(200, { address: TOMAS, available: true }),
    });
    const outcome = await checker(withKey, { fetch: stub.fetch }).capabilityCheck({ phone: TOMAS });
    expect(outcome).toMatchObject({ result: "checked", service: "rcs" });
    expect(stub.seen).toHaveLength(2);
    for (const seen of stub.seen) {
      expect(Object.entries(seen.headers).filter(([, value]) => value.includes(FAKE_KEY))).toEqual([
        ["authorization", `Bearer ${FAKE_KEY}`],
      ]);
      expect(seen.url).not.toContain(FAKE_KEY);
      expect(seen.body).not.toContain(FAKE_KEY);
    }
    expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
  });

  it("reads no name but LINQ_API_TOKEN from the environment it is given, and reads it at each call", async () => {
    const read: string[] = [];
    // An environment that holds other names too, and records every name read from it.
    const values: Record<string, unknown> = {
      LINQ_WEBHOOK_SECRET: "fake-webhook-secret",
      ENVIRONMENT: "staging",
    };
    const env = new Proxy(values, {
      get(target, name, receiver) {
        read.push(String(name));
        return Reflect.get(target, name, receiver) as unknown;
      },
    });
    const stub = stubFetch({ [IMESSAGE_URL]: () => recordedAnswer(LIVE_IMESSAGE) });
    const check = checker(env, { fetch: stub.fetch });
    const request = { phone: LIVE_RUN_PHONE };

    expect(await check.capabilityCheck(request)).toMatchObject({ result: "failed", code: null });
    values.LINQ_API_TOKEN = FAKE_KEY;
    expect(await check.capabilityCheck(request)).toMatchObject({ result: "checked", imessage: true });
    // A rotated key takes effect at the next call.
    values.LINQ_API_TOKEN = "fake-linq-key-t415-0002";
    expect(await check.capabilityCheck(request)).toMatchObject({ result: "checked", imessage: true });

    expect(stub.seen.map((seen) => seen.headers.authorization)).toEqual([
      `Bearer ${FAKE_KEY}`,
      "Bearer fake-linq-key-t415-0002",
    ]);
    expect([...new Set(read)]).toEqual([LINQ_API_TOKEN]);
    for (const seen of stub.seen) expect(seen.body).not.toContain("fake-webhook-secret");
  });

  it("writes no log line on any path, so the key reaches none", async () => {
    const answers: Answer[] = [
      () => recordedAnswer(LIVE_IMESSAGE),
      () => json(200, vendorSample("capability-check-imessage-response.json")),
      () => json(200, { address: TOMAS, available: false }),
      () => json(429, vendorSample("error-1007-rate-limit.json")),
      // An error body that echoes the key back.
      () => json(401, linqError(401, 1001, `Bad token: Bearer ${FAKE_KEY}`)),
      () => new Response("<html></html>", { status: 200 }),
      () => Promise.reject(new TypeError(`fetch failed for Bearer ${FAKE_KEY}`)),
    ];
    const outcomes: CapabilityCheckOutcome[] = [];
    const lines = await consoleLinesDuring(async () => {
      for (const answer of answers) {
        const stub = stubFetch({
          [IMESSAGE_URL]: answer,
          [RCS_URL]: () => json(200, { address: TOMAS, available: true }),
        });
        outcomes.push(await checker(withKey, { fetch: stub.fetch }).capabilityCheck({ phone: TOMAS }));
      }
      const none = stubFetch({});
      outcomes.push(
        await checker({ LINQ_API_TOKEN: `${FAKE_KEY} 2` }, { fetch: none.fetch }).capabilityCheck({
          phone: TOMAS,
        }),
      );
      outcomes.push(await checker(withKey, { fetch: none.fetch }).capabilityCheck({ phone: FAKE_KEY }));
      expect(none.seen).toEqual([]);
    });
    expect(lines).toEqual([]);
    expect(outcomes).toHaveLength(answers.length + 2);
    for (const outcome of outcomes) expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
  });
});

describe("no cache here: runtime C-128 keeps a checked answer for its 10 minutes", () => {
  it("asks Linq again at every call, for the same number too", async () => {
    const stub = stubFetch({ [IMESSAGE_URL]: () => recordedAnswer(LIVE_IMESSAGE) });
    const check = checker(withKey, { fetch: stub.fetch });
    const first = await check.capabilityCheck({ phone: LIVE_RUN_PHONE });
    const second = await check.capabilityCheck({ phone: LIVE_RUN_PHONE });
    expect(second).toEqual(first);
    expect(stub.seen.map((seen) => seen.url)).toEqual([IMESSAGE_URL, IMESSAGE_URL]);
  });
});

describe("the clock, the default fetch and the time limit", () => {
  it("stamps checkedAt once the last answer came; the default clock writes whole seconds in UTC", async () => {
    const order: string[] = [];
    const stub = stubFetch({
      [IMESSAGE_URL]: () => {
        order.push("iMessage answered");
        return json(200, { address: TOMAS, available: false });
      },
      [RCS_URL]: () => {
        order.push("RCS answered");
        return json(200, { address: TOMAS, available: true });
      },
    });
    const outcome = await createLinqCapabilityChecker({
      env: withKey,
      fetch: stub.fetch,
      now: () => {
        order.push("clock read");
        return NOW;
      },
    }).capabilityCheck({ phone: TOMAS });
    expect(outcome).toMatchObject({ result: "checked", checkedAt: NOW });
    expect(order).toEqual(["iMessage answered", "RCS answered", "clock read"]);

    const plain = stubFetch({ [IMESSAGE_URL]: () => recordedAnswer(LIVE_IMESSAGE) });
    const request = { phone: LIVE_RUN_PHONE };
    const stamped = await createLinqCapabilityChecker({ env: withKey, fetch: plain.fetch }).capabilityCheck(
      request,
    );
    expect(stamped.result === "checked" ? stamped.checkedAt : "").toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/,
    );
    expectExchange(request, stamped);
  });

  it("uses the runtime's fetch when none is given", async () => {
    const runtimeFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(recordedAnswer(LIVE_IMESSAGE)));
    const outcome = await createLinqCapabilityChecker({ env: withKey, now: () => NOW }).capabilityCheck({
      phone: LIVE_RUN_PHONE,
    });
    expect(outcome).toMatchObject({ result: "checked", imessage: true, service: "imessage" });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    const sent = runtimeFetch.mock.calls[0]?.[0];
    expect(sent instanceof Request ? sent.url : "").toBe(IMESSAGE_URL);
  });

  it("refuses, when it is made, a time limit that is not a whole number of milliseconds above 0", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => createLinqCapabilityChecker({ env: {}, timeoutMs })).toThrow(RangeError);
  });
});
