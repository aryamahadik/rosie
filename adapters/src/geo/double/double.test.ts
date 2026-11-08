// T-439: the geo double against K-17 v1's fixtures and schema (contracts/port-geo). No network and no key. Every address,
// town and ZIP code here is one of K-17 v1's fixtures' (the master's sample cast, fixture set v1's demo shops and arch 05
// line 237's ZIP), never a real person's (rule 9). The points, states and zones are illustrations (MC C6), so no test
// checks a point against a real map; a zone is checked to be a name the IANA database knows, the code check that
// contracts/common's zone format leaves to code.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import type { GeoPort } from "../../../../runtime/src/clocks/types";
import { spanLogLine, type OutsideCallSpan } from "../../shared/spans";
import { createGeoDouble, DOUBLE_TRACE } from "./double";
import type { GeocodeError, GeocodeKind, GeocodeMatch, GeocodeOutcome, GeocodeRequest } from "./types";
import { TEST_ADDRESSES } from "./world";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-geo", "fixtures");
const SCHEMA_ID = "https://rosie.invalid/contracts/port-geo/port-geo.v1.schema.json";

interface Exchange {
  call: "geocode";
  request: GeocodeRequest;
  outcome: GeocodeOutcome;
}
interface IndexEntry {
  file: string;
  version: string;
  def: string;
  expect: "accept" | "refuse";
}
interface SpanFixture {
  trace_id: string;
  span_id: string;
  seq: number;
  at: string;
  bundle_id: { hash: string; build: number };
  turn_id: string | null;
  job_id: string | null;
  handle_ref: string | null;
  business_id: string | null;
  attempt: number;
  got: { step: string; kind: GeocodeKind };
}

const readJson = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(path.join(...parts), "utf8")) as unknown;
const fixture = (file: string): Exchange => readJson(FIXTURES, file) as Exchange;
const INDEX = (readJson(FIXTURES, "index.json") as { fixtures: IndexEntry[] }).fixtures;

/** K-17 v1's accepted exchange fixtures whose outcome is an answer (found or notFound), not an error. */
const ANSWER_FIXTURES = INDEX.filter(
  (entry) => entry.version === "v1" && entry.def === "geocode.exchange" && entry.expect === "accept",
)
  .map((entry) => entry.file)
  .filter((file) => "result" in fixture(file).outcome);

let ajv: Ajv2020;

beforeAll(() => {
  ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  const folders = readdirSync(CONTRACTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["scripts", "generated", "node_modules"].includes(entry.name))
    .map((entry) => entry.name);
  for (const folder of folders)
    for (const file of readdirSync(path.join(CONTRACTS, folder)))
      if (file.endsWith(".schema.json")) ajv.addSchema(readJson(CONTRACTS, folder, file) as object);
});

function validator(def: string): ValidateFunction {
  const check = ajv.getSchema(`${SCHEMA_ID}#/$defs/${def}`);
  if (check === undefined) throw new Error(`port-geo v1 has no ${def}`);
  return check;
}

/** The double's answer, as the exchange K-17 v1's schema checks. */
function expectExchange(request: GeocodeRequest, outcome: GeocodeOutcome): void {
  const check = validator("geocode.exchange");
  expect(check({ call: "geocode", request, outcome }), JSON.stringify(check.errors)).toBe(true);
}

function expectSpan(span: OutsideCallSpan): void {
  const check = validator("geocode.span");
  expect(check(span), JSON.stringify(check.errors)).toBe(true);
}

/** True when the IANA time zone database (through the platform's Intl) knows the name, as it is written. */
function isIanaZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone === zone;
  } catch {
    return false;
  }
}

function matchesOf(outcome: GeocodeOutcome): readonly GeocodeMatch[] {
  return "result" in outcome && outcome.result === "found" ? outcome.matches : [];
}

function errorOf(outcome: GeocodeOutcome): GeocodeError {
  if (!("error" in outcome)) throw new Error("the outcome is not an error");
  return outcome;
}

function only<T>(list: readonly T[]): T {
  expect(list).toHaveLength(1);
  const [item] = list;
  if (item === undefined) throw new Error("the list is empty");
  return item;
}

const LOG = { level: "info", environment: "staging", version: "test-sha" } as const;

describe("the card's four fixtures (T-439 Proves it with)", () => {
  it("geocode-zip.json: a ZIP code gives one match at ZIP precision, with an IANA zone", async () => {
    const fx = fixture("geocode-zip.json");
    const outcome = await createGeoDouble().geocode(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expectExchange(fx.request, outcome);
    const match = only(matchesOf(outcome));
    expect(match.precision).toBe("zip");
    expect(isIanaZone(match.timeZone), match.timeZone).toBe(true);
  });

  it("geocode-street.json: Alex's street address gives one exact match, normalized, with an IANA zone", async () => {
    const fx = fixture("geocode-street.json");
    const outcome = await createGeoDouble().geocode(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expectExchange(fx.request, outcome);
    const match = only(matchesOf(outcome));
    expect(match.precision).toBe("exact");
    expect(match.normalizedAddress).not.toBe(fx.request.text);
    expect(isIanaZone(match.timeZone), match.timeZone).toBe(true);
  });

  it("geocode-town.json: the town in Alex's request gives one match at town precision, with an IANA zone", async () => {
    const fx = fixture("geocode-town.json");
    const outcome = await createGeoDouble().geocode(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expectExchange(fx.request, outcome);
    const match = only(matchesOf(outcome));
    expect(match.precision).toBe("town");
    expect(isIanaZone(match.timeZone), match.timeZone).toBe(true);
  });

  it("not-found.json: 'the mall' answers notFound with no match, not an error", async () => {
    const fx = fixture("not-found.json");
    const outcome = await createGeoDouble().geocode(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expect(outcome).toEqual({ result: "notFound" });
    expectExchange(fx.request, outcome);
  });
});

describe("the double's world (K-17 v1 README, 'The double')", () => {
  it("answers every accepted answer fixture of K-17 v1 with exactly its outcome", async () => {
    expect(ANSWER_FIXTURES).toHaveLength(TEST_ADDRESSES.length + 1);
    const double = createGeoDouble();
    for (const file of ANSWER_FIXTURES) {
      const fx = fixture(file);
      const outcome = await double.geocode(fx.request);
      expect(outcome, file).toEqual(fx.outcome);
      expectExchange(fx.request, outcome);
    }
  });

  it("holds one test address per found fixture, asked by that fixture's own request", () => {
    const found = ANSWER_FIXTURES.filter((file) => matchesOf(fixture(file).outcome).length > 0);
    expect(TEST_ADDRESSES.map((entry) => entry.fixture).sort()).toEqual([...found].sort());
    for (const entry of TEST_ADDRESSES) {
      const fx = fixture(entry.fixture);
      expect(fx.request, entry.fixture).toEqual({ kind: entry.kind, text: entry.text });
      expect(fx.outcome, entry.fixture).toEqual({ result: "found", matches: [entry.match] });
    }
  });

  it("gives each match a precision no finer than its kind allows, a two-letter state or null, and an IANA zone", () => {
    const allowed: Record<GeocodeKind, readonly string[]> = {
      zip: ["zip", "town"],
      town: ["town"],
      streetAddress: ["exact", "interpolated", "street", "zip", "town"],
    };
    for (const entry of TEST_ADDRESSES) {
      expect(allowed[entry.kind], entry.fixture).toContain(entry.match.precision);
      if (entry.match.state !== null) expect(entry.match.state, entry.fixture).toMatch(/^[A-Z]{2}$/);
      expect(isIanaZone(entry.match.timeZone), entry.fixture).toBe(true);
    }
    // The zone check refuses what the IANA database does not know.
    expect(isIanaZone("America/Springfield")).toBe(false);
    expect(isIanaZone("Springfield")).toBe(false);
  });

  it("tells a partial match by its precision, never by an error (geocode-street-partial.json)", async () => {
    const fx = fixture("geocode-street-partial.json");
    const outcome = await createGeoDouble().geocode(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expect(fx.request.kind).toBe("streetAddress");
    expect(only(matchesOf(outcome)).precision).toBe("town");
  });

  it("keeps the state key on every match: null on Anytown's town answer (geocode-town-no-state.json)", async () => {
    const fx = fixture("geocode-town-no-state.json");
    const match = only(matchesOf(await createGeoDouble().geocode(fx.request)));
    expect(Object.keys(match)).toContain("state");
    expect(match.state).toBeNull();
  });
});

describe("not found", () => {
  it("answers any other request notFound, never an error: the words must be a fixture's, under its kind", async () => {
    const double = createGeoDouble();
    const others: GeocodeRequest[] = [
      { kind: "town", text: "the mall" },
      { kind: "streetAddress", text: "42 Oak St, Springfield" },
      { kind: "town", text: "springfield" },
      { kind: "town", text: "Springfield " },
      { kind: "zip", text: "Springfield" },
      { kind: "streetAddress", text: "Springfield" },
      { kind: "town", text: "02139" },
      { kind: "zip", text: "00000" },
    ];
    for (const request of others) {
      const outcome = await double.geocode(request);
      expect(outcome, JSON.stringify(request)).toEqual({ result: "notFound" });
      expectExchange(request, outcome);
    }
    expect(double.spans().map((span) => span.decided)).toEqual(
      others.map(() => ({ result: "notFound", matches: 0 })),
    );
  });
});

describe("errors the test sets (K-17 v1 README, 'An error')", () => {
  async function errorThenAnswer(errorFile: string, answerFile: string): Promise<void> {
    const failing = fixture(errorFile);
    const answer = fixture(answerFile);
    expect(failing.request).toEqual(answer.request);
    const error = errorOf(failing.outcome);
    const double = createGeoDouble();
    double.failNext(error);

    const first = await double.geocode(failing.request, { step: "B4-77" });
    expect(first).toEqual(failing.outcome);
    expectExchange(failing.request, first);
    const second = await double.geocode(failing.request, { step: "B4-77", attempt: 2 });
    expect(second).toEqual(answer.outcome);

    const [failed, answered] = double.spans();
    if (failed === undefined || answered === undefined) throw new Error("two spans were not written");
    for (const span of [failed, answered]) expectSpan(span);
    expect(failed).toMatchObject({
      attempt: 1,
      got: { step: "B4-77", kind: failing.request.kind },
      outcome: "failed",
      error_code: error.error,
    });
    expect("decided" in failed).toBe(false);
    expect(answered).toMatchObject({
      attempt: 2,
      outcome: "ok",
      error_code: null,
      decided: { result: "found", matches: 1, precision: only(matchesOf(answer.outcome)).precision },
    });
  }

  it("error-unavailable.json: the next call returns the error and writes its span; later calls answer", async () => {
    await errorThenAnswer("error-unavailable.json", "geocode-town.json");
  });

  it("error-rate-limited.json: the error with its Retry-After, then the ZIP's answer", async () => {
    await errorThenAnswer("error-rate-limited.json", "geocode-zip.json");
  });

  it("badRequest: the provider refusing a request the contract has the shape of is a call, with its span", async () => {
    const double = createGeoDouble();
    double.failNext({ error: "badRequest", retryAfterSeconds: null });
    const request = fixture("geocode-street.json").request;
    const outcome = await double.geocode(request);
    expect(outcome).toEqual({ error: "badRequest", retryAfterSeconds: null });
    expectExchange(request, outcome);
    expect(only(double.spans())).toMatchObject({ outcome: "failed", error_code: "badRequest" });
    expect(double.requests()).toEqual([request]);
  });

  it("fails as many calls as `times` says, then answers as before", async () => {
    const double = createGeoDouble();
    const town = fixture("geocode-town.json");
    double.failNext({ error: "unavailable", retryAfterSeconds: null }, { times: 2 });
    const outcomes = [
      await double.geocode(town.request),
      await double.geocode(town.request),
      await double.geocode(town.request),
    ];
    expect(outcomes).toEqual([
      { error: "unavailable", retryAfterSeconds: null },
      { error: "unavailable", retryAfterSeconds: null },
      town.outcome,
    ]);
  });

  it("refuses an error K-17 v1 does not define, naming the field and never a value", async () => {
    const double = createGeoDouble();
    const undefinedErrors: unknown[] = [
      { error: "partialMatch", retryAfterSeconds: null },
      { error: "notFound", retryAfterSeconds: null },
      { error: "rateLimited", retryAfterSeconds: -1 },
      { error: "rateLimited", retryAfterSeconds: 1.5 },
      { error: "unavailable" },
      { error: "unavailable", retryAfterSeconds: null, matches: [] },
      "unavailable",
    ];
    for (const error of undefinedErrors)
      expect(() => {
        double.failNext(error as GeocodeError);
      }, JSON.stringify(error)).toThrow(TypeError);
    expect(() => {
      double.failNext({ error: "unavailable", retryAfterSeconds: null }, { times: 0 });
    }).toThrow(/times/);
    let message = "";
    try {
      double.failNext({ error: "Springfield" } as unknown as GeocodeError);
    } catch (thrown) {
      message = thrown instanceof Error ? thrown.message : "";
    }
    expect(message).toMatch(/error\.error/);
    expect(message).not.toContain("Springfield");
    // None of them was set: the next call answers.
    const town = fixture("geocode-town.json");
    expect(await double.geocode(town.request)).toEqual(town.outcome);
  });
});

describe("a request the contract has no shape for", () => {
  it("answers badRequest before any call: no span, no request taken, the fields at fault kept, never the words", async () => {
    const double = createGeoDouble();
    const refused: [unknown, string][] = [
      ["Springfield", "the request is not an object"],
      [["town", "Springfield"], "the request is not an object"],
      [{ kind: "town" }, "request.text is missing"],
      [{ text: "Springfield" }, "request.kind is missing"],
      [{ kind: "county", text: "Springfield" }, "request.kind is not zip, town or streetAddress"],
      [{ kind: "town", text: "" }, "request.text is not words"],
      [{ kind: "town", text: "   " }, "request.text is not words"],
      [{ kind: "town", text: "Springfield", near: "1200 Main St" }, "request.near is not a field of v1"],
      [{ kind: "town", text: "Springfield", fail: "unavailable" }, "request.fail is not a field of v1"],
    ];
    for (const [request] of refused) {
      const outcome = await double.geocode(request);
      expect(outcome, JSON.stringify(request)).toEqual({ error: "badRequest", retryAfterSeconds: null });
      expect(validator("geocode.errors")(outcome)).toBe(true);
    }
    expect(double.spans()).toEqual([]);
    expect(double.requests()).toEqual([]);
    const problems = double.rejectedRequests().map((entry) => entry.problems);
    expect(problems).toEqual(refused.map(([, problem]) => [problem]));
    const written = JSON.stringify(problems);
    for (const words of ["Springfield", "Main St", "county", "unavailable"])
      expect(written).not.toContain(words);
  });

  it("leaves an error the test set for the next call the double takes", async () => {
    const double = createGeoDouble();
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    await double.geocode({ kind: "town" });
    const town = fixture("geocode-town.json");
    expect(await double.geocode(town.request)).toEqual({ error: "unavailable", retryAfterSeconds: null });
    expect(await double.geocode(town.request)).toEqual(town.outcome);
  });
});

describe("the call's span (K-08 v1 portCall; K-17 v1 geocode.span)", () => {
  it("rebuilds span-geocode.json from B4-77's town check for Alex", async () => {
    const fx = readJson(FIXTURES, "span-geocode.json") as SpanFixture & Record<string, unknown>;
    const double = createGeoDouble({ now: () => fx.at });
    await double.geocode(fixture("geocode-town.json").request, {
      trace: {
        traceId: fx.trace_id,
        spanId: fx.span_id,
        seq: fx.seq,
        bundleId: fx.bundle_id,
        turnId: fx.turn_id,
        jobId: fx.job_id,
        handleRef: fx.handle_ref,
        businessId: fx.business_id,
      },
      step: fx.got.step,
      attempt: fx.attempt,
    });
    const span = only(double.spans());
    expectSpan(span);
    // The double answers at once and names no inbound event; everything else is the fixture's.
    expect(span).toEqual({ ...fx, ms: 0, event_id: null });
  });

  it("writes one span per call that geocode.span accepts, and no span or log line holds the words or an address", async () => {
    const double = createGeoDouble();
    double.failNext({ error: "rateLimited", retryAfterSeconds: 30 });
    const asked: GeocodeRequest[] = [
      fixture("error-rate-limited.json").request,
      ...TEST_ADDRESSES.map(({ kind, text }) => ({ kind, text })),
      fixture("not-found.json").request,
    ];
    for (const request of asked) await double.geocode(request, { step: "B4-30" });
    const spans = double.spans();
    expect(spans).toHaveLength(asked.length);
    for (const span of spans) expectSpan(span);
    const written = spans.map((span) => spanLogLine(span, LOG)).join("\n");
    const words = [
      ...asked.map((request) => request.text),
      ...TEST_ADDRESSES.map((entry) => entry.match.normalizedAddress),
      "Springfield",
      "Riverton",
      "Anytown",
      "Oak",
      "Main St",
      "Demo St",
      "mall",
    ];
    for (const word of words) expect(written).not.toContain(word);
  });

  it("puts a span given no trace on the double's own: numbered in call order, bundle v0's id, no step", async () => {
    const double = createGeoDouble();
    await double.geocode(fixture("geocode-town.json").request);
    await double.geocode(fixture("not-found.json").request);
    const bundle = (
      readJson(CONTRACTS, "bundle", "fixtures", "bundle-v0-skeleton.json") as {
        manifest: { bundleId: unknown };
      }
    ).manifest.bundleId;
    expect(DOUBLE_TRACE.bundleId).toEqual(bundle);
    const spans = double.spans();
    expect(spans.map((span) => [span.trace_id, span.span_id, span.seq])).toEqual([
      [DOUBLE_TRACE.traceId, "span-geo-double-0001", 1],
      [DOUBLE_TRACE.traceId, "span-geo-double-0002", 2],
    ]);
    for (const span of spans) {
      expectSpan(span);
      expect(span).toMatchObject({ bundle_id: bundle, turn_id: null, handle_ref: null, attempt: 1 });
      expect(span.got).toEqual({ kind: "town" });
    }
  });

  it("refuses a call its span cannot be written for, and leaves nothing behind", async () => {
    const double = createGeoDouble();
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    const request = fixture("geocode-town.json").request;
    await expect(double.geocode(request, { attempt: 0 })).rejects.toThrow(/attempt/);
    await expect(createGeoDouble({ now: () => "not a time" }).geocode(request)).rejects.toThrow(TypeError);
    expect(double.requests()).toEqual([]);
    expect(double.spans()).toEqual([]);
    expect(await double.geocode(request)).toEqual({ error: "unavailable", retryAfterSeconds: null });
  });
});

describe("the port's callers", () => {
  it("is the clock arming's K-17 port (runtime/src/clocks GeoPort), so D-017 can join it", async () => {
    const port: GeoPort = createGeoDouble();
    const street = fixture("geocode-street.json");
    const answer = await port.geocode(street.request);
    expect(answer).toEqual(street.outcome);
    const zone = "result" in answer && answer.result === "found" ? answer.matches[0]?.timeZone : undefined;
    expect(zone).toBe(only(matchesOf(street.outcome)).timeZone);
  });

  it("gives copies: changing an answer or a request changes no later answer and no record", async () => {
    const double = createGeoDouble();
    const town = fixture("geocode-town.json");
    const request = { ...town.request };
    const first = only(matchesOf(await double.geocode(request)));
    first.point.lat = 0;
    request.text = "Riverton";
    expect(await double.geocode(town.request)).toEqual(town.outcome);
    expect(double.requests()).toEqual([town.request, town.request]);
  });

  it("records each request it took, in order, and reset clears every record and every error set", async () => {
    const double = createGeoDouble();
    const zip = fixture("geocode-zip.json");
    const asked = [zip.request, fixture("not-found.json").request];
    for (const request of asked) await double.geocode(request);
    await double.geocode({ kind: "county", text: "Springfield" });
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    expect(double.requests()).toEqual(asked);
    expect(double.rejectedRequests()).toHaveLength(1);
    expect(double.spans()).toHaveLength(2);

    double.reset();
    expect(double.requests()).toEqual([]);
    expect(double.rejectedRequests()).toEqual([]);
    expect(double.spans()).toEqual([]);
    expect(await double.geocode(zip.request)).toEqual(zip.outcome);
    expect(only(double.spans()).seq).toBe(1);
  });
});
