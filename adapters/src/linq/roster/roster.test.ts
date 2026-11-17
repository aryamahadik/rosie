// T-416: the staging roster allow-list in front of the real Linq line (C-210; Q-44's default; T-416's lead note), around
// T-414's real sender and T-415's real capability check and contacts stub, as the Worker wraps them. No network and no
// real key: each wrapped adapter's HTTP call is a stub that records each request and answers with K-11's recorded vendor
// samples (contracts/port-linq/vendor-samples), the runtime's own fetch is replaced by one that refuses (no test may call
// it), and the key is a made-up string of letters built here (rule 7). Every number is a whole fiction one (555-01xx:
// rule 9), the roster's and Rosie's line's among them; a roster written wrongly holds fiction numbers in another form.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { findPrivateValue } from "../../shared/redact";
import { loadRecordedSample } from "../../shared/samples";
import { NO_PHONE, createLinqCapabilityChecker, type LinqCapabilityChecker } from "../capability";
import {
  REASONS as CONTACT_REASONS,
  createLinqContactRegistrar,
  type LinqContactRegistrar,
} from "../contacts";
import { createLinqSender, type AttachFile, type LinqSender, type SendPartRequest } from "../send";
import {
  ENVIRONMENT,
  REASONS,
  ROSIE_NUMBER,
  STAGING_LINQ_ALLOWLIST,
  guardLinqCapabilityChecker,
  guardLinqContactRegistrar,
  guardLinqSender,
  type LinqRosterOptions,
} from "./roster";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CONTRACTS = path.join(ROOT, "contracts");
const FIXTURES = path.join(CONTRACTS, "port-linq", "fixtures");
const VENDOR = path.join(CONTRACTS, "port-linq", "vendor-samples");
const K11_ID = "https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json";

// Made up here, letters alone: not a key of any service, and in no key's or number's shape (rule 7).
const FAKE_KEY = "fakeLinqKeyRosterGuardLettersOnly";
const NOW = "2026-11-17T12:00:00Z";
// The roster's two phones: Alex and Tomás of K-11's fixtures.
const ALEX = "+15555550101";
const TOMAS = "+15555550105";
const ROSTER = `${ALEX},${TOMAS}`;
// A phone off the roster, and Rosie's own line as K-11's vendor samples write it (K-11 README 'Recorded vendor samples').
const OFF_ROSTER = "+15555550142";
const ROSIE_LINE = "+15555550199";
// The attachment id the recorded calendar send names (vendor-samples/send-message-request-calendar-file.json).
const ATTACHMENT = "linq-att-demo-0002";

const SENDS = [
  "send-text.json",
  "send-poll.json",
  "send-link-card.json",
  "send-calendar-file.json",
  "send-photo.json",
  "send-typing.json",
  "send-tapback.json",
  "send-threaded-reply.json",
  "send-override-optout.json",
  "error-403-2024.json",
  "error-4006.json",
  "error-rate-limit.json",
];

type CallName = "sendPart" | "contactAdd" | "capabilityCheck";
const CALLS: CallName[] = ["sendPart", "contactAdd", "capabilityCheck"];

/** The Worker's env as the adapters and the guard read it, by name. */
interface WorkerEnv {
  ENVIRONMENT?: unknown;
  STAGING_LINQ_ALLOWLIST?: unknown;
  ROSIE_NUMBER?: unknown;
  LINQ_API_TOKEN?: unknown;
}

/** The three adapters, as the Worker would hold them. */
interface Adapters {
  sender: LinqSender;
  checker: LinqCapabilityChecker;
  registrar: LinqContactRegistrar;
}

/** One request as the stub saw it. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** The real adapters, each wrapped call noted with the request it was handed; the guarded ones; what the guard logged. */
interface Line {
  inner: Adapters;
  guarded: Adapters;
  seen: Seen[];
  wrappedCalls: { call: CallName; request: unknown }[];
  lines: string[];
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const parseLine = (text: string): unknown => JSON.parse(text);
const sendRequest = (name: string): SendPartRequest =>
  (readJson(path.join(FIXTURES, name)) as { request: SendPartRequest }).request;
const vendor = (name: string): unknown => loadRecordedSample(VENDOR, name);

/** The Worker's env on staging, with a good roster and Rosie's line, and any name given undefined left out (unset). */
function staging(changes: WorkerEnv = {}): WorkerEnv {
  const values: WorkerEnv = {
    ENVIRONMENT: "staging",
    STAGING_LINQ_ALLOWLIST: ROSTER,
    ROSIE_NUMBER: ROSIE_LINE,
    LINQ_API_TOKEN: FAKE_KEY,
    ...changes,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Linq's recorded answer for each path the adapters call (K-11's vendor samples), and 204 for typing dots. */
function vendorAnswer(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/typing")) return new Response(null, { status: 204 });
  if (pathname.endsWith("/polls")) return json(200, vendor("create-poll-response.json"));
  if (pathname.endsWith("/reactions")) return json(200, vendor("reaction-response.json"));
  if (pathname.endsWith("/messages")) return json(200, vendor("send-message-response.json"));
  if (pathname.endsWith("/capability/check_imessage"))
    return json(200, vendor("capability-check-imessage-response.json"));
  throw new Error("the stub has no answer for this path");
}

const attachFile: AttachFile = () => Promise.resolve({ result: "attached", attachmentId: ATTACHMENT });

/**
 * T-414's sender and T-415's capability check and registrar on `innerEnv` (the Worker's env unless given), with a stub
 * HTTP call, and each wrapped by the guard on `env`, whose log lines are kept.
 */
function line(env: WorkerEnv, innerEnv: WorkerEnv = env): Line {
  const seen: Seen[] = [];
  const fetch = async (request: Request): Promise<Response> => {
    seen.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.clone().text(),
    });
    return vendorAnswer(request);
  };
  const sender = createLinqSender({ env: innerEnv, fetch, now: () => NOW, attachFile });
  const checker = createLinqCapabilityChecker({ env: innerEnv, fetch, now: () => NOW });
  const registrar = createLinqContactRegistrar({ env: innerEnv });
  const wrappedCalls: Line["wrappedCalls"] = [];
  const inner: Adapters = {
    sender: {
      sendPart: (request) => {
        wrappedCalls.push({ call: "sendPart", request });
        return sender.sendPart(request);
      },
    },
    checker: {
      capabilityCheck: (request) => {
        wrappedCalls.push({ call: "capabilityCheck", request });
        return checker.capabilityCheck(request);
      },
    },
    registrar: {
      contactAdd: (request) => {
        wrappedCalls.push({ call: "contactAdd", request });
        return registrar.contactAdd(request);
      },
    },
  };
  const lines: string[] = [];
  const options: LinqRosterOptions = {
    env,
    log: (text) => {
      lines.push(text);
    },
  };
  return {
    inner,
    guarded: {
      sender: guardLinqSender(inner.sender, options),
      checker: guardLinqCapabilityChecker(inner.checker, options),
      registrar: guardLinqContactRegistrar(inner.registrar, options),
    },
    seen,
    wrappedCalls,
    lines,
  };
}

/** One of the three calls to `destination`: for a send, send-text.json's words to it. */
function callTo(adapters: Adapters, call: CallName, destination: unknown): Promise<unknown> {
  if (call === "sendPart")
    return adapters.sender.sendPart({ ...sendRequest("send-text.json"), to: destination });
  if (call === "contactAdd") return adapters.registrar.contactAdd({ phone: destination });
  return adapters.checker.capabilityCheck({ phone: destination });
}

/** K-11's failed result a refusal gives for each call; `phone` is the one contactAdd and capabilityCheck name. */
function refusal(call: CallName, reason: string, phone: string): unknown {
  if (call === "sendPart")
    return {
      result: "failed",
      kind: "refused",
      httpStatus: null,
      code: null,
      reason,
      retryAfterSeconds: null,
      providerMessageId: null,
    };
  if (call === "contactAdd") return { result: "failed", phone, retryable: false, code: null, reason };
  return { result: "failed", phone, code: null, reason };
}

/** The one log line a refusal writes, on staging unless `environment` says otherwise. */
function logged(
  call: CallName,
  why: string,
  destination: string,
  more: Record<string, unknown> = {},
  environment = "staging",
): unknown {
  return {
    level: "warn",
    msg: "linqRosterRefused",
    environment,
    call,
    why,
    list: STAGING_LINQ_ALLOWLIST,
    destination,
    ...more,
  };
}

/**
 * No number in `text`: no run of 3 digits (a destination shows its last 2 at most, ***01) and no private value. The
 * form's own name, E.164 (in the words and in the label notE164), is the one run of digits a refusal may hold.
 */
function expectNoNumber(text: string): void {
  expect(text.replace(/E[.]?164/g, "E")).not.toMatch(/[0-9]{3}/);
  expect(findPrivateValue(text)).toBeUndefined();
}

const validators = new Map<CallName, ValidateFunction>();

function expectValidFailure(call: CallName, outcome: unknown): void {
  const validate = validators.get(call);
  if (validate === undefined) throw new Error("a contract schema is missing");
  expect(validate(outcome), JSON.stringify(validate.errors)).toBe(true);
}

/**
 * Runs one call to `destination` through the guard on `env` and checks it was refused before any vendor call: K-11's
 * failed result with `reason`, no request to Linq, the wrapped call never run, and one log line with no number.
 */
async function expectRefused(
  env: WorkerEnv,
  call: CallName,
  destination: unknown,
  reason: string,
  log: { why: string; destination: string; more?: Record<string, unknown>; environment?: string },
): Promise<void> {
  const run = line(env);
  const outcome = await callTo(run.guarded, call, destination);
  const phone =
    typeof destination === "string" && /^\+[1-9][0-9]{6,14}$/.test(destination) ? destination : NO_PHONE;
  expect(outcome).toEqual(refusal(call, reason, phone));
  expectValidFailure(call, outcome);
  expect(run.seen).toEqual([]);
  expect(run.wrappedCalls).toEqual([]);
  expect(run.lines.map(parseLine)).toEqual([
    logged(call, log.why, log.destination, log.more, log.environment),
  ]);
  for (const text of [...run.lines, reason]) expectNoNumber(text);
}

/** Runs one call to `destination` through the guard on `env` and checks that it reached the wrapped call, unlogged. */
async function expectPassed(env: WorkerEnv, call: CallName, destination: string): Promise<void> {
  const run = line(env);
  const plain = line(env);
  const outcome = await callTo(run.guarded, call, destination);
  expect(outcome).toEqual(await callTo(plain.inner, call, destination));
  expect(run.wrappedCalls).toHaveLength(1);
  expect(run.seen).toEqual(plain.seen);
  expect(run.lines).toEqual([]);
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/** Runs `body` with every console method recorded instead of written: each line, with the method that wrote it. */
async function consoleDuring(body: () => Promise<void>): Promise<{ method: string; text: string }[]> {
  const written: { method: string; text: string }[] = [];
  const spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push({
        method,
        text: args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      });
    }),
  );
  try {
    await body();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return written;
}

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
  for (const call of CALLS) {
    const validate = ajv.getSchema(`${K11_ID}#/$defs/${call}.errors`);
    if (validate === undefined) throw new Error("a contract schema is missing");
    validators.set(call, validate);
  }
});

// No test reaches the network: the runtime's own fetch refuses, and every test checks that nothing called it.
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

describe("on staging, a number off the roster is refused before any vendor call and logged without the number", () => {
  it("refuses each K-11 send fixture's part to a number off the roster: no request, the wrapped send never runs", async () => {
    for (const name of SENDS) {
      const run = line(staging());
      const outcome = await run.guarded.sender.sendPart({ ...sendRequest(name), to: OFF_ROSTER });
      expect(outcome).toEqual(refusal("sendPart", REASONS.offRoster, ""));
      expectValidFailure("sendPart", outcome);
      expect(run.seen).toEqual([]);
      expect(run.wrappedCalls).toEqual([]);
      expect(run.lines.map(parseLine)).toEqual([logged("sendPart", "offRoster", "***42")]);
      expectNoNumber(JSON.stringify(outcome));
    }
  });

  it("refuses a contact add and a capability check for a number off the roster, as K-11's failed results", async () => {
    for (const call of ["contactAdd", "capabilityCheck"] as const)
      await expectRefused(staging(), call, OFF_ROSTER, REASONS.offRoster, {
        why: "offRoster",
        destination: "***42",
      });
  });

  it("logs the number by its last 2 digits alone, never more of it", async () => {
    for (const call of CALLS) {
      const run = line(staging());
      await callTo(run.guarded, call, OFF_ROSTER);
      expect(run.lines).toHaveLength(1);
      const [text = ""] = run.lines;
      expect(text).toContain('"destination":"***42"');
      for (const part of [OFF_ROSTER, OFF_ROSTER.slice(1), OFF_ROSTER.slice(-4), OFF_ROSTER.slice(-3)])
        expect(text).not.toContain(part);
      for (const entry of [ALEX, TOMAS, ROSIE_LINE]) expect(text).not.toContain(entry.slice(-4));
      expectNoNumber(text);
    }
  });
});

describe("on staging, a roster number passes through to the wrapped call", () => {
  it("hands each K-11 send fixture's part to a roster number to T-414's sender: the same request to Linq, the same outcome", async () => {
    for (const name of SENDS) {
      for (const to of [ALEX, TOMAS]) {
        const request = { ...sendRequest(name), to };
        const run = line(staging());
        const plain = line(staging());
        const outcome = await run.guarded.sender.sendPart(request);
        expect(outcome).toEqual(await plain.inner.sender.sendPart(request));
        expect(run.seen).toHaveLength(1);
        expect(run.seen).toEqual(plain.seen);
        expect(run.wrappedCalls).toEqual([{ call: "sendPart", request }]);
        expect(run.lines).toEqual([]);
      }
    }
    // The answer read is Linq's recorded one: the words were accepted as send-text.json says.
    const run = line(staging());
    const text = sendRequest("send-text.json");
    expect(await run.guarded.sender.sendPart(text)).toEqual(
      (readJson(path.join(FIXTURES, "send-text.json")) as { outcome: unknown }).outcome,
    );
  });

  it("hands a roster number's capability check to T-415's check, and its contact add to T-415's registrar", async () => {
    for (const call of ["contactAdd", "capabilityCheck"] as const)
      for (const phone of [ALEX, TOMAS]) await expectPassed(staging(), call, phone);

    // The answer read is Linq's recorded one: capability.json's, for its own number (Tomás), at this test's clock.
    const run = line(staging());
    const capability = readJson(path.join(FIXTURES, "capability.json")) as {
      request: { phone: string };
      outcome: Record<string, unknown>;
    };
    expect(capability.request.phone).toBe(TOMAS);
    expect(await run.guarded.checker.capabilityCheck(capability.request)).toEqual({
      ...capability.outcome,
      checkedAt: NOW,
    });
    expect(run.seen.map((seen) => seen.body)).toEqual([JSON.stringify({ address: TOMAS })]);
    expect(await run.guarded.registrar.contactAdd({ phone: ALEX })).toEqual({
      result: "failed",
      phone: ALEX,
      retryable: false,
      code: null,
      reason: CONTACT_REASONS.noContactsCall,
    });
  });

  it("takes a roster of one number, and a roster that names a number twice", async () => {
    for (const roster of [ALEX, `${ALEX},${ALEX}`, `${TOMAS},${ALEX},${TOMAS}`])
      for (const call of CALLS) await expectPassed(staging({ STAGING_LINQ_ALLOWLIST: roster }), call, ALEX);
    for (const call of CALLS)
      await expectRefused(staging({ STAGING_LINQ_ALLOWLIST: ALEX }), call, TOMAS, REASONS.offRoster, {
        why: "offRoster",
        destination: "***05",
      });
  });
});

describe("a missing, empty or ill-formed roster refuses every send, contact add and capability check (fail closed)", () => {
  const MISSING: [string, unknown][] = [
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["a line break alone", "\n"],
    ["null", null],
    ["true", true],
    ["a list of the numbers", [ALEX, TOMAS]],
    ["an object", { roster: ALEX }],
  ];

  it.each(MISSING)("roster %s: every call is refused", async (_, roster) => {
    for (const call of CALLS)
      for (const destination of [ALEX, TOMAS, OFF_ROSTER])
        await expectRefused(
          staging({ STAGING_LINQ_ALLOWLIST: roster }),
          call,
          destination,
          REASONS.rosterMissing,
          { why: "rosterMissing", destination: `***${destination.slice(-2)}` },
        );
  });

  /**
   * A roster written wrongly: its name, its text, how many entries it holds, the places of those that are not E.164,
   * and the words the reason names them with.
   */
  const ILL_FORMED: [string, string, number, number[], string][] = [
    ["a space after a comma", "+15555550101, +15555550105", 2, [2], "entry 2 of 2 is"],
    ["a space at the end", "+15555550101,+15555550105 ", 2, [2], "entry 2 of 2 is"],
    ["a space at the start", " +15555550101,+15555550105", 2, [1], "entry 1 of 2 is"],
    ["an empty entry", "+15555550101,,+15555550105", 3, [2], "entry 2 of 3 is"],
    ["a comma at the end", "+15555550101,+15555550105,", 3, [3], "entry 3 of 3 is"],
    ["a comma at the start", ",+15555550101", 2, [1], "entry 1 of 2 is"],
    ["a comma alone", ",", 2, [1, 2], "entries 1, 2 of 2 are"],
    ["no plus", "+15555550101,15555550105", 2, [2], "entry 2 of 2 is"],
    ["spaces in a number", "+1 555 555 0105", 1, [1], "entry 1 of 1 is"],
    ["dashes in a number", "+1-555-555-0105,+15555550101", 2, [1], "entry 1 of 2 is"],
    ["a national form", "(555) 555-0105", 1, [1], "entry 1 of 1 is"],
    ["semicolons", "+15555550101;+15555550105", 1, [1], "entry 1 of 1 is"],
    ["a line break between", "+15555550101\n+15555550105", 1, [1], "entry 1 of 1 is"],
    ["a line break at the end", "+15555550101,+15555550105\n", 2, [2], "entry 2 of 2 is"],
    ["words", "+15555550101,the user's iPhone", 2, [2], "entry 2 of 2 is"],
    ["a letter after a number", "+15555550101x", 1, [1], "entry 1 of 1 is"],
    [
      "twelve words",
      "a,b,c,d,e,f,g,h,i,j,k,l",
      12,
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      "entries 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and 2 more of 12 are",
    ],
  ];

  it.each(ILL_FORMED)("roster with %s: every call is refused", async (_, roster, entries, bad, which) => {
    const reason = `${STAGING_LINQ_ALLOWLIST}: ${which} not an E.164 number (+, then 7 to 15 digits, joined by commas with no space); no part of it is shown, and nothing was sent to Linq.`;
    const more = { entries, badEntries: bad.slice(0, 10), badCount: bad.length };
    for (const call of CALLS)
      for (const destination of [ALEX, TOMAS, OFF_ROSTER])
        await expectRefused(staging({ STAGING_LINQ_ALLOWLIST: roster }), call, destination, reason, {
          why: "rosterIllFormed",
          destination: `***${destination.slice(-2)}`,
          more,
        });
  });

  it("never shows an entry of the roster, whole or in part, in a reason or a log line", async () => {
    for (const [, roster] of ILL_FORMED) {
      const run = line(staging({ STAGING_LINQ_ALLOWLIST: roster }));
      const outcomes: unknown[] = [];
      for (const call of CALLS) outcomes.push(await callTo(run.guarded, call, OFF_ROSTER));
      const shown = [...run.lines, ...outcomes.map((outcome) => (outcome as { reason: string }).reason)];
      expect(shown).toHaveLength(6);
      const entries = roster
        .split(/[,;\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 1);
      for (const text of shown) {
        expectNoNumber(text);
        for (const entry of entries) expect(text).not.toContain(entry);
      }
    }
  });
});

describe("Rosie's own line is never a destination", () => {
  it("refuses every call to Rosie's own line, even when the roster holds it", async () => {
    for (const roster of [`${ALEX},${ROSIE_LINE}`, ROSIE_LINE, ROSTER])
      for (const call of CALLS)
        await expectRefused(staging({ STAGING_LINQ_ALLOWLIST: roster }), call, ROSIE_LINE, REASONS.ownLine, {
          why: "ownLine",
          destination: "***99",
        });
  });

  it("still passes a roster number when the roster also holds Rosie's own line", async () => {
    for (const call of CALLS)
      await expectPassed(staging({ STAGING_LINQ_ALLOWLIST: `${ALEX},${ROSIE_LINE}` }), call, ALEX);
  });

  const LINE_UNKNOWN: [string, unknown][] = [
    ["unset", undefined],
    ["empty", ""],
    ["spaces in it", "+1 555 555 0199"],
    ["no plus", "15555550199"],
    ["a space at the end", "+15555550199 "],
    ["null", null],
    ["true", true],
  ];

  // Rosie's own line cannot then be told from a destination, so nothing goes, even to a roster number.
  it.each(LINE_UNKNOWN)("ROSIE_NUMBER %s: every call is refused", async (_, rosieNumber) => {
    for (const call of CALLS)
      for (const destination of [ALEX, OFF_ROSTER])
        await expectRefused(staging({ ROSIE_NUMBER: rosieNumber }), call, destination, REASONS.lineUnknown, {
          why: "lineUnknown",
          destination: `***${destination.slice(-2)}`,
        });
  });
});

describe("on staging, a destination that is not an E.164 number is refused", () => {
  const OTHER_FORMS: [string, unknown, string][] = [
    ["no plus", "5555550101", "***01"],
    ["spaces", "+1 555 555 0101", "***01"],
    ["a space at the end", "+15555550101 ", "***01"],
    ["empty", "", "***"],
    ["words", "Alex's phone", "***"],
    ["null", null, "***"],
    ["a number", 42, "***"],
    ["missing", undefined, "***"],
  ];

  // K-11's failed result for a contact add or a check names NO_PHONE then, as T-415's adapters do.
  it.each(OTHER_FORMS)("a destination with %s: every call is refused", async (_, to, shown) => {
    for (const call of CALLS)
      await expectRefused(staging(), call, to, REASONS.notE164, { why: "notE164", destination: shown });
  });

  it("refuses a send or a check that is not an object with fields at all", async () => {
    for (const request of [null, "a part", 42, [], [ALEX]]) {
      const run = line(staging());
      expect(await run.guarded.sender.sendPart(request)).toEqual(refusal("sendPart", REASONS.notE164, ""));
      expect(await run.guarded.checker.capabilityCheck(request)).toEqual(
        refusal("capabilityCheck", REASONS.notE164, NO_PHONE),
      );
      expect(await run.guarded.registrar.contactAdd(request)).toEqual(
        refusal("contactAdd", REASONS.notE164, NO_PHONE),
      );
      expect(run.seen).toEqual([]);
      expect(run.wrappedCalls).toEqual([]);
      expect(run.lines.map(parseLine)).toEqual([
        logged("sendPart", "notE164", "***"),
        logged("capabilityCheck", "notE164", "***"),
        logged("contactAdd", "notE164", "***"),
      ]);
    }
  });

  it("refuses a request whose number is under another name", async () => {
    const run = line(staging());
    expect(await run.guarded.checker.capabilityCheck({ number: ALEX })).toEqual(
      refusal("capabilityCheck", REASONS.notE164, NO_PHONE),
    );
    const noTo: Record<string, unknown> = { ...sendRequest("send-text.json"), phone: ALEX };
    delete noTo.to;
    expect(await run.guarded.sender.sendPart(noTo)).toEqual(refusal("sendPart", REASONS.notE164, ""));
    expect(run.seen).toEqual([]);
    expect(run.wrappedCalls).toEqual([]);
  });
});

describe("the guard hands on the very request it checked", () => {
  it("reads the destination once: a number that changes on a second read cannot reach Linq", async () => {
    let reads = 0;
    const request = {};
    Object.defineProperty(request, "phone", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? ALEX : OFF_ROSTER;
      },
    });
    const run = line(staging());
    const outcome = await run.guarded.checker.capabilityCheck(request);
    expect(reads).toBe(1);
    expect(outcome).toMatchObject({ result: "checked", phone: ALEX });
    expect(run.seen.map((seen) => seen.body)).toEqual([JSON.stringify({ address: ALEX })]);
    expect(run.wrappedCalls).toHaveLength(1);
    expect(run.wrappedCalls[0]?.request).not.toBe(request);
    expect(Object.getOwnPropertyDescriptor(run.wrappedCalls[0]?.request, "phone")).toMatchObject({
      value: ALEX,
    });
  });

  it("hands T-414's sender a plain copy of the part, whose to is the number the guard passed", async () => {
    let reads = 0;
    const request: Record<string, unknown> = { ...sendRequest("send-text.json") };
    Object.defineProperty(request, "to", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? TOMAS : OFF_ROSTER;
      },
    });
    const run = line(staging());
    const outcome = await run.guarded.sender.sendPart(request);
    expect(reads).toBe(1);
    expect(outcome).toMatchObject({ result: "accepted" });
    const handed = run.wrappedCalls[0]?.request;
    expect(Object.getOwnPropertyDescriptor(handed, "to")).toMatchObject({ value: TOMAS });
    expect(handed).toEqual({ ...sendRequest("send-text.json"), to: TOMAS });
  });

  it("refuses a request whose fields cannot be read, and sends nothing", async () => {
    const request = { ...sendRequest("send-text.json") };
    Object.defineProperty(request, "to", {
      enumerable: true,
      get: () => {
        throw new Error("this field cannot be read");
      },
    });
    const run = line(staging());
    expect(await run.guarded.sender.sendPart(request)).toEqual(refusal("sendPart", REASONS.notE164, ""));
    expect(run.seen).toEqual([]);
    expect(run.wrappedCalls).toEqual([]);
    expect(run.lines.map(parseLine)).toEqual([logged("sendPart", "notE164", "***")]);
  });
});

describe("off staging the guard changes nothing", () => {
  const OFF_STAGING = ["production", "test"];

  // With no roster and no line set: each part goes to the wrapped send as it came, Rosie's own line and a bad number too.
  it.each(OFF_STAGING)("ENVIRONMENT %s: every send fixture's part passes as it came", async (environment) => {
    const env = { ENVIRONMENT: environment, LINQ_API_TOKEN: FAKE_KEY };
    for (const name of SENDS)
      for (const to of [OFF_ROSTER, ALEX, ROSIE_LINE, "not a number"]) {
        const request = { ...sendRequest(name), to };
        const run = line(env);
        const plain = line(env);
        const outcome = await run.guarded.sender.sendPart(request);
        expect(outcome).toEqual(await plain.inner.sender.sendPart(request));
        expect(run.seen).toEqual(plain.seen);
        expect(run.wrappedCalls).toHaveLength(1);
        expect(run.wrappedCalls[0]?.request).toBe(request);
        expect(run.lines).toEqual([]);
      }
  });

  // With no roster, a good one or an empty one, the call goes to the wrapped call as it came.
  it.each(OFF_STAGING)(
    "ENVIRONMENT %s: every contact add and check passes as it came",
    async (environment) => {
      for (const env of [
        { ENVIRONMENT: environment, LINQ_API_TOKEN: FAKE_KEY },
        { ...staging(), ENVIRONMENT: environment },
        { ...staging({ STAGING_LINQ_ALLOWLIST: "" }), ENVIRONMENT: environment },
      ])
        for (const call of ["contactAdd", "capabilityCheck"] as const)
          for (const phone of [OFF_ROSTER, TOMAS, ROSIE_LINE]) {
            const request = { phone };
            const run = line(env);
            const plain = line(env);
            const outcome =
              call === "contactAdd"
                ? await run.guarded.registrar.contactAdd(request)
                : await run.guarded.checker.capabilityCheck(request);
            expect(outcome).toEqual(await callTo(plain.inner, call, phone));
            expect(run.seen).toEqual(plain.seen);
            expect(run.wrappedCalls).toEqual([{ call, request }]);
            expect(run.wrappedCalls[0]?.request).toBe(request);
            expect(run.lines).toEqual([]);
          }
    },
  );

  it("reads ENVIRONMENT alone off staging, and only the guard's three names on staging: never the key", async () => {
    for (const environment of ["production", "test", "staging"]) {
      const read: string[] = [];
      const values: WorkerEnv = staging({ ENVIRONMENT: environment });
      const env = new Proxy(values, {
        get(target, name, receiver) {
          read.push(String(name));
          return Reflect.get(target, name, receiver) as unknown;
        },
      });
      // The adapters read the key from an env of their own, so the record holds the guard's reads alone.
      const run = line(env, { ...values });
      expect(read).toEqual([]);
      for (const call of CALLS) await callTo(run.guarded, call, OFF_ROSTER);
      expect([...new Set(read)].sort()).toEqual(
        environment === "staging" ? [ENVIRONMENT, ROSIE_NUMBER, STAGING_LINQ_ALLOWLIST] : [ENVIRONMENT],
      );
    }
  });
});

describe("an ENVIRONMENT the guard cannot tell from staging keeps it on (fail closed)", () => {
  const NOT_KNOWN: [string, unknown][] = [
    ["unset", undefined],
    ["empty", ""],
    ["blank", "  "],
    ["staging after a space", " staging"],
    ["Staging", "Staging"],
    ["PRODUCTION", "PRODUCTION"],
    ["prod", "prod"],
    ["Test", "Test"],
    ["local", "local"],
    ["a number", 1],
    ["null", null],
  ];

  // A number off the roster is refused, and a roster number passes, as on staging.
  it.each(NOT_KNOWN)("ENVIRONMENT %s: the guard stays on", async (_, environment) => {
    for (const call of CALLS) {
      await expectRefused(staging({ ENVIRONMENT: environment }), call, OFF_ROSTER, REASONS.offRoster, {
        why: "offRoster",
        destination: "***42",
        environment: "unknown",
      });
      await expectPassed(staging({ ENVIRONMENT: environment }), call, ALEX);
    }
  });
});

describe("the names are read at each call, never when the guard is made", () => {
  it("follows the roster, Rosie's line and ENVIRONMENT as they change between calls", async () => {
    const env: WorkerEnv = { ENVIRONMENT: "staging", LINQ_API_TOKEN: FAKE_KEY };
    const run = line(env);
    const sendTo = (to: string) => run.guarded.sender.sendPart({ ...sendRequest("send-text.json"), to });

    expect(await sendTo(ALEX)).toEqual(refusal("sendPart", REASONS.rosterMissing, ""));
    env.STAGING_LINQ_ALLOWLIST = ALEX;
    expect(await sendTo(ALEX)).toEqual(refusal("sendPart", REASONS.lineUnknown, ""));
    env.ROSIE_NUMBER = ROSIE_LINE;
    expect(await sendTo(ALEX)).toMatchObject({ result: "accepted" });
    expect(await sendTo(TOMAS)).toEqual(refusal("sendPart", REASONS.offRoster, ""));
    env.STAGING_LINQ_ALLOWLIST = TOMAS;
    expect(await sendTo(TOMAS)).toMatchObject({ result: "accepted" });
    expect(await sendTo(ALEX)).toEqual(refusal("sendPart", REASONS.offRoster, ""));
    env.ENVIRONMENT = "production";
    expect(await sendTo(ALEX)).toMatchObject({ result: "accepted" });
    env.ENVIRONMENT = "staging";
    expect(await sendTo(ALEX)).toEqual(refusal("sendPart", REASONS.offRoster, ""));

    expect(run.seen).toHaveLength(3);
    expect(run.lines.map((text) => (parseLine(text) as { why: string }).why)).toEqual([
      "rosterMissing",
      "lineUnknown",
      "offRoster",
      "offRoster",
      "offRoster",
    ]);
  });
});

describe("the refusal's words and its log line", () => {
  it("names the roster or Rosie's line by name in every fixed reason, with no number in any", () => {
    expect(REASONS.rosterMissing).toContain(STAGING_LINQ_ALLOWLIST);
    expect(REASONS.notE164).toContain(STAGING_LINQ_ALLOWLIST);
    expect(REASONS.offRoster).toContain(STAGING_LINQ_ALLOWLIST);
    expect(REASONS.lineUnknown).toContain(ROSIE_NUMBER);
    expect(REASONS.ownLine).toContain(ROSIE_NUMBER);
    for (const reason of Object.values(REASONS)) {
      expectNoNumber(reason);
      expect(reason).toMatch(/nothing was sent to Linq[.]$/);
    }
  });

  it("writes a refusal's one line to console.log when no log is given, and nothing for a call that passes", async () => {
    const env = staging();
    const run = line(env);
    const written = await consoleDuring(async () => {
      const sender = guardLinqSender(run.inner.sender, { env });
      await sender.sendPart({ ...sendRequest("send-text.json"), to: OFF_ROSTER });
      await sender.sendPart({ ...sendRequest("send-text.json"), to: ALEX });
      await guardLinqSender(run.inner.sender, { env: { ...env, ENVIRONMENT: "production" } }).sendPart({
        ...sendRequest("send-text.json"),
        to: OFF_ROSTER,
      });
    });
    expect(written.map(({ method, text }) => ({ method, line: parseLine(text) }))).toEqual([
      { method: "log", line: logged("sendPart", "offRoster", "***42") },
    ]);
    expect(run.seen).toHaveLength(2);
  });

  it("writes nothing to the console when a log is given", async () => {
    const written = await consoleDuring(async () => {
      const run = line(staging());
      for (const call of CALLS) await callTo(run.guarded, call, OFF_ROSTER);
      expect(run.lines).toHaveLength(3);
    });
    expect(written).toEqual([]);
  });

  it("never puts the key in an outcome or a log line", async () => {
    const run = line(staging());
    const outcomes: unknown[] = [];
    for (const call of CALLS)
      for (const destination of [OFF_ROSTER, ROSIE_LINE, "not a number"])
        outcomes.push(await callTo(run.guarded, call, destination));
    for (const text of [...run.lines, ...outcomes.map((outcome) => JSON.stringify(outcome))])
      expect(text.toLowerCase()).not.toContain(FAKE_KEY.toLowerCase());
    expect(run.lines).toHaveLength(9);
  });
});
