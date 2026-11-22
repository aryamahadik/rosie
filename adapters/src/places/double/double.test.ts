// T-434: the Places double against K-15 v1's fixtures and schema (contracts/port-places). No network and no key. Every
// name, address, phone and reference here is one of K-15 v1's fixtures' (the master's sample cast and fixture set v1's
// demo shops, their phones in the 555-0100 to 555-0199 fiction range), never a real person's or a real business's
// (rule 9). The listings are illustrations, so no test checks one against Google.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { spanLogLine, type OutsideCallSpan } from "../../shared/spans";
import { createPlacesDouble, DOUBLE_TRACE, type PlacesDouble } from "./double";
import type {
  DetailsOutcome,
  DetailsRequest,
  Listing,
  ListingCandidate,
  PlacesCall,
  PlacesCallName,
  PlacesError,
  PlacesPort,
  SearchOutcome,
  SearchRequest,
} from "./types";
import { DEMO_LISTINGS, DEMO_SEARCHES } from "./world";

const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
);
const FIXTURES = path.join(CONTRACTS, "port-places", "fixtures");
const SCHEMA_ID = "https://rosie.invalid/contracts/port-places/port-places.v1.schema.json";

interface SearchExchange {
  call: "search";
  request: SearchRequest;
  outcome: SearchOutcome;
}
interface DetailsExchange {
  call: "details";
  request: DetailsRequest;
  outcome: DetailsOutcome;
}
type Exchange = SearchExchange | DetailsExchange;
type Outcome = SearchOutcome | DetailsOutcome;

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
  got: { step: string };
}

const readJson = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(path.join(...parts), "utf8")) as unknown;
const exchange = (file: string): Exchange => readJson(FIXTURES, file) as Exchange;
const INDEX = (readJson(FIXTURES, "index.json") as { fixtures: IndexEntry[] }).fixtures;

function searchFixture(file: string): SearchExchange {
  const fx = exchange(file);
  if (fx.call !== "search") throw new Error(`${file} is not a search`);
  return fx;
}
function detailsFixture(file: string): DetailsExchange {
  const fx = exchange(file);
  if (fx.call !== "details") throw new Error(`${file} is not a details call`);
  return fx;
}

const v1 = INDEX.filter((entry) => entry.version === "v1");
const ACCEPTED_EXCHANGES = v1
  .filter((entry) => entry.expect === "accept" && entry.def.endsWith(".exchange"))
  .map((entry) => entry.file);
/** K-15 v1's accepted exchange fixtures whose outcome is an answer (found, noMatch or notFound). */
const ANSWER_FIXTURES = ACCEPTED_EXCHANGES.filter((file) => "result" in exchange(file).outcome);
/** K-15 v1's accepted exchange fixtures whose outcome is an error. */
const ERROR_FIXTURES = ACCEPTED_EXCHANGES.filter((file) => "error" in exchange(file).outcome);
const SPAN_FIXTURES = v1
  .filter((entry) => entry.expect === "accept" && entry.def.endsWith(".span"))
  .map((entry) => entry.file);
const REFUSED_FIXTURES = v1.filter((entry) => entry.expect === "refuse");

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
  if (check === undefined) throw new Error(`port-places v1 has no ${def}`);
  return check;
}

function accepts(def: string, value: unknown): void {
  const check = validator(def);
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

/** The double's answer, as the exchange K-15 v1's schema checks. */
function expectExchange(call: PlacesCallName, request: unknown, outcome: Outcome): void {
  accepts(`${call}.exchange`, { call, request, outcome });
}

function expectSpan(span: OutsideCallSpan): void {
  accepts(`${span.call}.span`, span);
}

/** Asks the double the fixture's own call with the fixture's own request. */
function ask(double: PlacesDouble, fx: Exchange, call?: PlacesCall): Promise<Outcome> {
  return fx.call === "search" ? double.search(fx.request, call) : double.details(fx.request, call);
}

function candidatesOf(outcome: Outcome): readonly ListingCandidate[] {
  return "result" in outcome && outcome.result === "found" && "candidates" in outcome
    ? outcome.candidates
    : [];
}

function listingOf(outcome: Outcome): Listing {
  if (!("result" in outcome) || outcome.result !== "found" || !("listing" in outcome))
    throw new Error("the outcome is not a found listing");
  return outcome.listing;
}

function errorOf(outcome: Outcome): PlacesError {
  if (!("error" in outcome)) throw new Error("the outcome is not an error");
  return outcome;
}

function only<T>(list: readonly T[]): T {
  expect(list).toHaveLength(1);
  const [item] = list;
  if (item === undefined) throw new Error("the list is empty");
  return item;
}

/** Every key at any depth of a value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => keysOf(item));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, inner]: [string, unknown]) => [key, ...keysOf(inner)]);
  return [];
}

/** Minutes after midnight of an HH:MM time, 24:00 included. */
function minutes(time: string): number {
  const [hours = "", mins = ""] = time.split(":");
  return Number(hours) * 60 + Number(mins);
}

/** The +1 fiction range: an area code, then 555-0100 to 555-0199 (infra/ci/phone-scan.mjs). */
const FICTION_PHONE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
/** Fields K-15 v1 never gives: Google's ratings and reviews, an email, a map point, Google's own hours. */
const NEVER_GIVEN = ["rating", "userRatingCount", "reviews", "email", "location", "periods", "open", "close"];

const LOG = { level: "info", environment: "staging", version: "test-sha" } as const;

describe("the card's fixtures (T-434 Proves it with)", () => {
  it("search-by-name.json: Lee's Barbershop by name and town gives its one candidate, as the read-back shows it", async () => {
    const fx = searchFixture("search-by-name.json");
    const outcome = await createPlacesDouble().search(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expectExchange("search", fx.request, outcome);
    expect(only(candidatesOf(outcome))).toEqual({
      listingRef: "places-demo-lees-barbershop",
      name: "Lee's Barbershop LLC",
      address: "88 Elm St, Springfield",
      phone: "+15555550177",
      website: "https://example.com",
    });
  });

  it("search-by-photo-text.json: the text read from Sam's photo gives the same one candidate", async () => {
    const fx = searchFixture("search-by-photo-text.json");
    const outcome = await createPlacesDouble().search(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expectExchange("search", fx.request, outcome);
    expect(fx.request.by).toBe("photoText");
    expect(candidatesOf(outcome)).toEqual(candidatesOf(searchFixture("search-by-name.json").outcome));
  });

  it("details.json: Lee's Barbershop's listing, its hours, its category and three credited photos", async () => {
    const fx = detailsFixture("details.json");
    const outcome = await createPlacesDouble().details(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expectExchange("details", fx.request, outcome);
    const listing = listingOf(outcome);
    expect(listing.listingRef).toBe(fx.request.listingRef);
    expect(listing.categories).toEqual(["Barber"]);
    expect(listing.openingHours).toHaveLength(6);
    expect(listing.photos).toHaveLength(3);
    for (const photo of listing.photos) expect(photo.authors).toEqual([{ name: listing.name, uri: null }]);
  });

  it("no-match.json: Test Mixed Shop A in Anytown answers noMatch, not an error", async () => {
    const fx = searchFixture("no-match.json");
    const outcome = await createPlacesDouble().search(fx.request);
    expect(outcome).toEqual(fx.outcome);
    expect(outcome).toEqual({ result: "noMatch" });
    expectExchange("search", fx.request, outcome);
  });

  it("refuse-reviews-field.json is refused by K-15 v1, and the double answers its request with no review", async () => {
    const refused = detailsFixture("invalid/refuse-reviews-field.json");
    expect(validator("details.exchange")(refused)).toBe(false);
    expect(validator("listing")(listingOf(refused.outcome))).toBe(false);
    const outcome = await createPlacesDouble().details(refused.request);
    expect(outcome).not.toEqual(refused.outcome);
    expect(outcome).toEqual(detailsFixture("details.json").outcome);
    expect(keysOf(outcome)).not.toContain("reviews");
    expect(keysOf(outcome)).not.toContain("rating");
    expectExchange("details", refused.request, outcome);
  });
});

describe("every K-15 v1 fixture", () => {
  it("sorts each fixture of the index into answers, errors, spans or refused ones", () => {
    expect(v1).toHaveLength(INDEX.length);
    const sorted = [
      ...ANSWER_FIXTURES,
      ...ERROR_FIXTURES,
      ...SPAN_FIXTURES,
      ...REFUSED_FIXTURES.map((e) => e.file),
    ];
    expect([...sorted].sort()).toEqual(INDEX.map((entry) => entry.file).sort());
    expect([
      ANSWER_FIXTURES.length,
      ERROR_FIXTURES.length,
      SPAN_FIXTURES.length,
      REFUSED_FIXTURES.length,
    ]).toEqual([8, 2, 2, 6]);
  });

  it("answers every accepted answer fixture with exactly its outcome, on one double", async () => {
    const double = createPlacesDouble();
    for (const file of ANSWER_FIXTURES) {
      const fx = exchange(file);
      const outcome = await ask(double, fx);
      expect(outcome, file).toEqual(fx.outcome);
      expectExchange(fx.call, fx.request, outcome);
    }
    expect(double.spans()).toHaveLength(ANSWER_FIXTURES.length);
  });

  it("gives each error fixture's outcome on its request with the error set, then the answer fixture that shares it", async () => {
    const twins: Record<string, string> = {};
    for (const file of ERROR_FIXTURES) {
      const failing = exchange(file);
      const twin = ANSWER_FIXTURES.find((answer) => {
        const fx = exchange(answer);
        return fx.call === failing.call && JSON.stringify(fx.request) === JSON.stringify(failing.request);
      });
      if (twin === undefined) throw new Error(`${file} shares its request with no answer fixture`);
      twins[file] = twin;
      const double = createPlacesDouble();
      double.failNext(errorOf(failing.outcome));
      const first = await ask(double, failing);
      expect(first, file).toEqual(failing.outcome);
      expectExchange(failing.call, failing.request, first);
      expect(await ask(double, failing), file).toEqual(exchange(twin).outcome);
    }
    expect(twins).toEqual({
      "error-unavailable.json": "search-by-name.json",
      "error-rate-limited.json": "details.json",
    });
  });

  it("refuses every refused fixture by its def, and never gives a refused outcome for its request", async () => {
    const double = createPlacesDouble();
    for (const entry of REFUSED_FIXTURES) {
      const value = readJson(FIXTURES, entry.file);
      expect(validator(entry.def)(value), entry.file).toBe(false);
      if (!entry.def.endsWith(".exchange")) continue;
      const fx = value as Exchange;
      const outcome = await ask(double, fx);
      expect(outcome, entry.file).not.toEqual(fx.outcome);
      expectExchange(fx.call, fx.request, outcome);
      for (const key of NEVER_GIVEN) expect(keysOf(outcome), entry.file).not.toContain(key);
    }
  });
});

describe("the double's world (K-15 v1 README, 'The double')", () => {
  it("holds one listing per found details fixture and one search per found search fixture, each its fixture's own", () => {
    const found = ANSWER_FIXTURES.filter((file) => {
      const outcome = exchange(file).outcome;
      return "result" in outcome && outcome.result === "found";
    });
    const owned = [
      ...DEMO_LISTINGS.map((entry) => entry.fixture),
      ...DEMO_SEARCHES.map((entry) => entry.fixture),
    ];
    expect([...owned].sort()).toEqual([...found].sort());
    for (const entry of DEMO_LISTINGS) {
      const fx = detailsFixture(entry.fixture);
      expect(fx.request, entry.fixture).toEqual({ listingRef: entry.listing.listingRef });
      expect(fx.outcome, entry.fixture).toEqual({ result: "found", listing: entry.listing });
    }
    for (const entry of DEMO_SEARCHES) {
      const fx = searchFixture(entry.fixture);
      expect(fx.request, entry.fixture).toEqual(entry.request);
      expect(candidatesOf(fx.outcome).map((candidate) => candidate.listingRef)).toEqual(entry.listingRefs);
    }
  });

  it("holds the three demo listings of the README, each candidate the listing's own fields", async () => {
    expect(DEMO_LISTINGS.map((entry) => entry.listing.listingRef)).toEqual([
      "places-demo-lees-barbershop",
      "places-demo-lee-home-services",
      "places-demo-yoga-studio",
    ]);
    const double = createPlacesDouble();
    for (const entry of DEMO_SEARCHES) {
      for (const candidate of candidatesOf(await double.search(entry.request))) {
        const listing = listingOf(await double.details({ listingRef: candidate.listingRef }));
        const { listingRef, name, address, phone, website } = listing;
        expect(candidate).toEqual({ listingRef, name, address, phone, website });
      }
    }
  });

  it("gives listings K-15 v1 accepts, with the checks it leaves to code: hours in order, no overlap, fiction phones", () => {
    for (const { listing, fixture } of DEMO_LISTINGS) {
      accepts("listing", listing);
      if (listing.phone !== null) expect(listing.phone, fixture).toMatch(FICTION_PHONE);
      expect(listing.website, fixture).toBe("https://example.com");
      const hours = listing.openingHours ?? [];
      for (const span of hours) expect(minutes(span.opensAt), fixture).toBeLessThan(minutes(span.closesAt));
      for (const [k, span] of hours.entries()) {
        const next = hours[k + 1];
        if (next === undefined) continue;
        // In day and time order, and a span of the same day opens after the one before it closes.
        expect(next.weekday, fixture).toBeGreaterThanOrEqual(span.weekday);
        if (next.weekday === span.weekday)
          expect(minutes(next.opensAt), fixture).toBeGreaterThanOrEqual(minutes(span.closesAt));
      }
      expect(listing.photos.length, fixture).toBeLessThanOrEqual(10);
      for (const key of NEVER_GIVEN) expect(keysOf(listing), fixture).not.toContain(key);
    }
    // The fiction check takes only E.164: the national form never crosses the port.
    expect("(555) 010-0177").not.toMatch(FICTION_PHONE);
  });
});

describe("no match and not found", () => {
  it("answers any other search noMatch, never an error: the request must be a fixture's, exactly", async () => {
    const double = createPlacesDouble();
    const others: SearchRequest[] = [
      { by: "nameAndTown", name: "lee's barbershop", town: "Springfield" },
      { by: "nameAndTown", name: "Lee's Barbershop ", town: "Springfield" },
      { by: "nameAndTown", name: "Lee's Barbershop LLC", town: "Springfield" },
      { by: "nameAndTown", name: "Lee's Barbershop", town: "Anytown" },
      { by: "nameAndTown", name: "Springfield", town: "Lee's Barbershop" },
      // S1-38's second company has a details fixture and no search fixture, so its search is no match.
      { by: "nameAndTown", name: "Lee Home Services", town: "Springfield" },
      { by: "nameAndTown", name: "Yoga studio", town: "Springfield" },
      { by: "photoText", text: "Lee's Barbershop" },
      { by: "photoText", text: "Yoga studio, Anytown" },
      { by: "nameAndTown", name: "Test Mixed Shop A", town: "Anytown" },
    ];
    for (const request of others) {
      const outcome = await double.search(request);
      expect(outcome, JSON.stringify(request)).toEqual({ result: "noMatch" });
      expectExchange("search", request, outcome);
    }
    const spans = double.spans();
    for (const span of spans) expectSpan(span);
    expect(spans.map((span) => span.decided)).toEqual(others.map(() => ({ candidates: 0 })));
  });

  it("answers any other reference notFound, never an error", async () => {
    const double = createPlacesDouble();
    const others = [
      detailsFixture("details-not-found.json").request.listingRef,
      // K-09 v1's stand-in candidate, which the double does not give.
      "places-double-lees-barbershop",
      "places-demo-lees-barbershop/photos/shop-front",
      "Places-Demo-Lees-Barbershop",
      "places-demo-lees-barbershop-2",
      "an-obsolete-place-id",
    ];
    for (const listingRef of others) {
      const outcome = await double.details({ listingRef });
      expect(outcome, listingRef).toEqual({ result: "notFound" });
      expectExchange("details", { listingRef }, outcome);
    }
    const spans = double.spans();
    for (const span of spans) expectSpan(span);
    expect(spans.map((span) => [span.got, span.decided])).toEqual(
      others.map((listing) => [{ listing }, { result: "notFound" }]),
    );
  });
});

describe("errors the test sets (K-15 v1 README, 'An error')", () => {
  it("error-unavailable.json: the next search returns the error and writes its span; the next one answers", async () => {
    const failing = searchFixture("error-unavailable.json");
    const answer = searchFixture("search-by-name.json");
    const double = createPlacesDouble();
    double.failNext(errorOf(failing.outcome));
    expect(await double.search(failing.request, { step: "S1-09" })).toEqual(failing.outcome);
    expect(await double.search(failing.request, { step: "S1-09", attempt: 2 })).toEqual(answer.outcome);
    const [failed, answered] = double.spans();
    if (failed === undefined || answered === undefined) throw new Error("two spans were not written");
    for (const span of [failed, answered]) expectSpan(span);
    expect(failed).toMatchObject({
      call: "search",
      attempt: 1,
      got: { step: "S1-09", searchBy: "nameAndTown" },
      outcome: "failed",
      error_code: "unavailable",
    });
    expect("decided" in failed).toBe(false);
    expect(answered).toMatchObject({
      attempt: 2,
      outcome: "ok",
      error_code: null,
      decided: { candidates: 1, listing: "places-demo-lees-barbershop" },
    });
  });

  it("error-rate-limited.json: the details call returns the error with its Retry-After, then the listing", async () => {
    const failing = detailsFixture("error-rate-limited.json");
    const answer = detailsFixture("details.json");
    const double = createPlacesDouble();
    double.failNext(errorOf(failing.outcome));
    const first = await double.details(failing.request, { step: "S1-84" });
    expect(first).toEqual({ error: "rateLimited", retryAfterSeconds: 30 });
    expect(await double.details(failing.request, { step: "S1-84", attempt: 2 })).toEqual(answer.outcome);
    const [failed, answered] = double.spans();
    if (failed === undefined || answered === undefined) throw new Error("two spans were not written");
    for (const span of [failed, answered]) expectSpan(span);
    expect(failed).toMatchObject({
      call: "details",
      got: { step: "S1-84", listing: "places-demo-lees-barbershop" },
      outcome: "failed",
      error_code: "rateLimited",
    });
    expect("decided" in failed).toBe(false);
    expect(answered.decided).toEqual({ result: "found", photos: 3 });
  });

  it("badRequest: the provider refusing a request the contract has the shape of is a call, with its span", async () => {
    const double = createPlacesDouble();
    double.failNext({ error: "badRequest", retryAfterSeconds: null });
    const request = searchFixture("search-yoga-studio.json").request;
    const outcome = await double.search(request);
    expect(outcome).toEqual({ error: "badRequest", retryAfterSeconds: null });
    expectExchange("search", request, outcome);
    expect(only(double.spans())).toMatchObject({ outcome: "failed", error_code: "badRequest" });
    expect(double.requests()).toEqual([{ call: "search", request }]);
  });

  it("gives the error to the next call of either kind, and fails as many calls as `times` says", async () => {
    const double = createPlacesDouble();
    const search = searchFixture("search-by-name.json");
    const details = detailsFixture("details-lee-home-services.json");
    double.failNext({ error: "unavailable", retryAfterSeconds: null }, { times: 2 });
    const outcomes = [
      await double.details(details.request),
      await double.search(search.request),
      await double.details(details.request),
    ];
    expect(outcomes).toEqual([
      { error: "unavailable", retryAfterSeconds: null },
      { error: "unavailable", retryAfterSeconds: null },
      details.outcome,
    ]);
  });

  it("refuses an error K-15 v1 does not define, naming the field and never a value", async () => {
    const double = createPlacesDouble();
    const undefinedErrors: unknown[] = [
      { error: "noMatch", retryAfterSeconds: null },
      { error: "notFound", retryAfterSeconds: null },
      { error: "rateLimited", retryAfterSeconds: -1 },
      { error: "rateLimited", retryAfterSeconds: 1.5 },
      { error: "unavailable" },
      { error: "unavailable", retryAfterSeconds: null, candidates: [] },
      "unavailable",
    ];
    for (const error of undefinedErrors)
      expect(() => {
        double.failNext(error as PlacesError);
      }, JSON.stringify(error)).toThrow(TypeError);
    expect(() => {
      double.failNext({ error: "unavailable", retryAfterSeconds: null }, { times: 0 });
    }).toThrow(/times/);
    let message = "";
    try {
      double.failNext({ error: "Springfield" } as unknown as PlacesError);
    } catch (thrown) {
      message = thrown instanceof Error ? thrown.message : "";
    }
    expect(message).toMatch(/error\.error/);
    expect(message).not.toContain("Springfield");
    // None of them was set: the next call answers.
    const fx = searchFixture("search-by-name.json");
    expect(await double.search(fx.request)).toEqual(fx.outcome);
  });
});

describe("a request the contract has no shape for", () => {
  it("answers a search badRequest before any call: no span, no request taken, the fields at fault kept, never the words", async () => {
    const double = createPlacesDouble();
    const refused: [unknown, string[]][] = [
      ["Lee's Barbershop", ["the request is not an object"]],
      [["nameAndTown", "Lee's Barbershop"], ["the request is not an object"]],
      [{}, ["request.by is missing"]],
      [{ by: "address", text: "88 Elm St" }, ["request.by is not nameAndTown or photoText"]],
      [{ by: "nameAndTown", name: "Lee's Barbershop" }, ["request.town is missing"]],
      [{ by: "nameAndTown", town: "Springfield" }, ["request.name is missing"]],
      [{ by: "nameAndTown", name: "  ", town: "Springfield" }, ["request.name is not words"]],
      [{ by: "photoText", text: "" }, ["request.text is not words"]],
      [
        { by: "photoText", name: "Lee's Barbershop" },
        ["request.text is missing", "request.name is not a field of v1"],
      ],
      [
        { by: "nameAndTown", name: "Lee's Barbershop", town: "Springfield", fail: "unavailable" },
        ["request.fail is not a field of v1"],
      ],
    ];
    for (const [request] of refused) {
      const outcome = await double.search(request);
      expect(outcome, JSON.stringify(request)).toEqual({ error: "badRequest", retryAfterSeconds: null });
      accepts("search.errors", outcome);
    }
    expect(double.spans()).toEqual([]);
    expect(double.requests()).toEqual([]);
    const rejected = double.rejectedRequests();
    expect(rejected.map((entry) => entry.call)).toEqual(refused.map(() => "search"));
    expect(rejected.map((entry) => entry.problems)).toEqual(refused.map(([, problems]) => problems));
    const written = JSON.stringify(rejected.map((entry) => entry.problems));
    for (const words of ["Barbershop", "Springfield", "Elm St", "address", "unavailable"])
      expect(written).not.toContain(words);
  });

  it("answers a details request badRequest before any call when its reference is not a K-08 label", async () => {
    const double = createPlacesDouble();
    const refused: [unknown, string[]][] = [
      ["places-demo-lees-barbershop", ["the request is not an object"]],
      [{}, ["request.listingRef is missing"]],
      [{ listingRef: "" }, ["request.listingRef is not a K-08 label"]],
      [{ listingRef: "Lee's Barbershop" }, ["request.listingRef is not a K-08 label"]],
      [{ listingRef: "0123456" }, ["request.listingRef is not a K-08 label"]],
      [{ listingRef: 42 }, ["request.listingRef is not a K-08 label"]],
      [
        { listingRef: "places-demo-lees-barbershop", fields: ["rating", "reviews"] },
        ["request.fields is not a field of v1"],
      ],
    ];
    for (const [request] of refused) {
      const outcome = await double.details(request);
      expect(outcome, JSON.stringify(request)).toEqual({ error: "badRequest", retryAfterSeconds: null });
      accepts("details.errors", outcome);
    }
    expect(double.spans()).toEqual([]);
    expect(double.requests()).toEqual([]);
    const rejected = double.rejectedRequests();
    expect(rejected.map((entry) => entry.call)).toEqual(refused.map(() => "details"));
    expect(rejected.map((entry) => entry.problems)).toEqual(refused.map(([, problems]) => problems));
    const written = JSON.stringify(rejected.map((entry) => entry.problems));
    for (const words of ["places-demo", "Barbershop", "0123456", "rating"])
      expect(written).not.toContain(words);
  });

  it("leaves an error the test set for the next call the double takes", async () => {
    const double = createPlacesDouble();
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    await double.search({ by: "nameAndTown" });
    await double.details({});
    const fx = detailsFixture("details.json");
    expect(await double.details(fx.request)).toEqual({ error: "unavailable", retryAfterSeconds: null });
    expect(await double.details(fx.request)).toEqual(fx.outcome);
  });
});

describe("the call's span (K-08 v1 portCall; K-15 v1 search.span and details.span)", () => {
  function traceOf(fx: SpanFixture): PlacesCall {
    return {
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
    };
  }

  it("rebuilds span-search.json from S1-09's search for Sam's shop by name and town", async () => {
    const fx = readJson(FIXTURES, "span-search.json") as SpanFixture & Record<string, unknown>;
    const double = createPlacesDouble({ now: () => fx.at });
    await double.search(searchFixture("search-by-name.json").request, traceOf(fx));
    const span = only(double.spans());
    expectSpan(span);
    // The double answers at once and names no inbound event; everything else is the fixture's.
    expect(span).toEqual({ ...fx, ms: 0, event_id: null });
  });

  it("rebuilds span-details.json from S1-84's details call for Lee's Barbershop's listing", async () => {
    const fx = readJson(FIXTURES, "span-details.json") as SpanFixture & Record<string, unknown>;
    const double = createPlacesDouble({ now: () => fx.at });
    await double.details(detailsFixture("details.json").request, traceOf(fx));
    const span = only(double.spans());
    expectSpan(span);
    expect(span).toEqual({ ...fx, ms: 0, event_id: null });
  });

  it("writes one span per call that its def accepts, and no span or log line holds a name, address, phone or words", async () => {
    const double = createPlacesDouble();
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    const asked = [...ANSWER_FIXTURES, ...ERROR_FIXTURES].map(exchange);
    for (const fx of asked) await ask(double, fx, { step: "S1-09" });
    const spans = double.spans();
    expect(spans).toHaveLength(asked.length);
    for (const span of spans) expectSpan(span);
    const written = spans.map((span) => spanLogLine(span, LOG)).join("\n");
    const words = [
      ...DEMO_SEARCHES.flatMap(({ request }) =>
        request.by === "nameAndTown" ? [request.name, request.town] : [request.text],
      ),
      ...DEMO_LISTINGS.flatMap(({ listing }) => [
        listing.name,
        listing.address,
        ...(listing.phone === null ? [] : [listing.phone, listing.phone.slice(-4)]),
        ...listing.categories,
        ...listing.photos.flatMap((photo) => [photo.photoRef, ...photo.authors.map((author) => author.name)]),
      ]),
      "Test Mixed Shop A",
      "Springfield",
      "Anytown",
      "Elm St",
      "Main St",
      "Demo St",
      "example.com",
    ];
    for (const word of words) expect(written).not.toContain(word);
  });

  it("puts a span given no trace on the double's own: numbered in call order, bundle v0's id, no step", async () => {
    const double = createPlacesDouble();
    await double.search(searchFixture("search-by-name.json").request);
    await double.details(detailsFixture("details-not-found.json").request);
    const bundle = (
      readJson(CONTRACTS, "bundle", "fixtures", "bundle-v0-skeleton.json") as {
        manifest: { bundleId: unknown };
      }
    ).manifest.bundleId;
    expect(DOUBLE_TRACE.bundleId).toEqual(bundle);
    const spans = double.spans();
    expect(spans.map((span) => [span.trace_id, span.span_id, span.seq, span.call])).toEqual([
      [DOUBLE_TRACE.traceId, "span-places-double-0001", 1, "search"],
      [DOUBLE_TRACE.traceId, "span-places-double-0002", 2, "details"],
    ]);
    for (const span of spans) {
      expectSpan(span);
      expect(span).toMatchObject({ bundle_id: bundle, turn_id: null, handle_ref: null, attempt: 1 });
      expect(span.provider).toBe("google_places");
      expect(span.got === undefined ? [] : Object.keys(span.got)).not.toContain("step");
    }
  });

  it("refuses a call its span cannot be written for, and leaves nothing behind", async () => {
    const double = createPlacesDouble();
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    const search = searchFixture("search-by-name.json").request;
    const details = detailsFixture("details.json").request;
    await expect(double.search(search, { attempt: 0 })).rejects.toThrow(/attempt/);
    await expect(double.details(details, { attempt: 1.5 })).rejects.toThrow(/attempt/);
    await expect(createPlacesDouble({ now: () => "not a time" }).search(search)).rejects.toThrow(TypeError);
    expect(double.requests()).toEqual([]);
    expect(double.spans()).toEqual([]);
    expect(await double.search(search)).toEqual({ error: "unavailable", retryAfterSeconds: null });
  });
});

describe("the port's callers", () => {
  it("is K-15's PlacesPort: a search's best candidate, then its details by the reference it gave", async () => {
    const port: PlacesPort = createPlacesDouble();
    const best = candidatesOf(await port.search(searchFixture("search-by-name.json").request))[0];
    if (best === undefined) throw new Error("the search found nothing");
    expect(await port.details({ listingRef: best.listingRef })).toEqual(
      detailsFixture("details.json").outcome,
    );
  });

  it("gives copies: changing an answer or a request changes no later answer and no record", async () => {
    const double = createPlacesDouble();
    const details = detailsFixture("details.json");
    const search = searchFixture("search-by-name.json");
    const listing = listingOf(await double.details({ ...details.request }));
    Object.assign(listing, { name: "changed", photos: [] });
    const candidate = only(candidatesOf(await double.search(search.request)));
    Object.assign(candidate, { phone: null });
    const request = { ...search.request };
    await double.search(request);
    Object.assign(request, { name: "changed" });
    expect(await double.details(details.request)).toEqual(details.outcome);
    expect(await double.search(search.request)).toEqual(search.outcome);
    expect(double.requests().map((record) => record.request)).toEqual([
      details.request,
      search.request,
      search.request,
      details.request,
      search.request,
    ]);
  });

  it("records each request it took with its call, in order, and reset clears every record and every error set", async () => {
    const double = createPlacesDouble();
    const search = searchFixture("search-yoga-studio.json");
    const details = detailsFixture("details-yoga-studio.json");
    await double.search(search.request);
    await double.details(details.request);
    await double.details({ listingRef: "not a label" });
    double.failNext({ error: "unavailable", retryAfterSeconds: null });
    expect(double.requests()).toEqual([
      { call: "search", request: search.request },
      { call: "details", request: details.request },
    ]);
    expect(double.rejectedRequests()).toHaveLength(1);
    expect(double.spans()).toHaveLength(2);

    double.reset();
    expect(double.requests()).toEqual([]);
    expect(double.rejectedRequests()).toEqual([]);
    expect(double.spans()).toEqual([]);
    expect(await double.details(details.request)).toEqual(details.outcome);
    expect(only(double.spans()).seq).toBe(1);
  });
});
