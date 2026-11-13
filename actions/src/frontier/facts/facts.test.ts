// T-295's proofs for the facts (arch 02 line 117: "the facts they need, each fact once, from its one home (S13-30).
// Decision reads go to the primary, uncached. A second value for one key is refused: the home's value goes in and the
// step is flagged for a fix"; K-02 v1 context.facts and fact; K-09 v1 buildFrontier's flagged):
//   - two homes giving two values for one key (fixtures/two-homes-one-key.json, mirroring K-09 v1's rule): the call
//     answers the home's value once and flags the step; the second value is refused before it is read;
//   - every fact carries its row id and version, as its home's row gave them;
//   - the read port is called with primary=true, cache=false, and the default port serves no other read;
//   - only the facts the context's choices need: a step's K-01 needs bring its facts, and nothing else does (no key a
//     step does not need, no frame fact, no person's name or contact, no other booking's fact); with no home listed,
//     the default, nothing is read and no fact is given (context-s1-02.json's facts).
// Values come only from the contracts' fixtures, the master's sample cast and fixture set v1's barber shop (rule 9).

import { describe, expect, it } from "vitest";

import { FrontierError } from "../assemble/handler";
import { openQuestionsSource } from "../sources/open-questions";
import {
  BUNDLE_V0,
  checks,
  fakeBundles,
  fakeRepo,
  s102Exchange,
  samSeed,
  type Called,
} from "../assemble/test-support";
import { factHomes, FactHomeError, type FactHome } from "./homes";
import {
  STRONG_READ,
  WeakReadError,
  isStrong,
  turnStateFactsPort,
  type FactsReadPort,
  type ReadMode,
} from "./read";
import {
  MINI_A,
  a602,
  callFrontier,
  callTwoHomes,
  placesSource,
  responseOf,
  samRequest,
  twoHomesFixture,
  twoHomesSeed,
} from "./test-support";

const { validator, checker } = checks();

/** The facts reads the repo saw after the turn's own state read: each one's request facts. */
function factReads(called: Called): unknown[][] {
  return called.repo.calls
    .filter((call) => call.call === "readTurnState")
    .slice(1)
    .map((call) => call.request.facts);
}

describe("each fact once, from its one home (fixtures/two-homes-one-key.json)", () => {
  it("two homes giving two values for one key: the home's value goes in once, and the step is flagged", async () => {
    const fixture = twoHomesFixture();
    const called = await callTwoHomes(fixture);
    const { context, flagged, collapsedBookingIds } = responseOf(called);

    expect(context.facts).toEqual(fixture.outcome.facts);
    expect(flagged).toEqual(fixture.outcome.flagged);
    expect(collapsedBookingIds).toEqual([]);
    expect(context.facts.filter((fact) => fact.name === "price")).toHaveLength(1);
    expect(checker.check("context", context)).toEqual([]);
    expect(validator.check("buildFrontier", "response", called.answer.ok && called.answer.value)).toEqual([]);
    expect(called.scope.events.at(-1)).toEqual({ what: "commit" });
  });

  it("the second value is refused before it is read: the request names the key once, from its home", async () => {
    const fixture = twoHomesFixture();
    const called = await callTwoHomes(fixture);
    expect(factReads(called)).toEqual([fixture.outcome.read]);
    const named = called.repo.calls.flatMap((call) =>
      call.call === "readTurnState"
        ? call.request.facts.map((fact) => `${String(fact.table)}/${fact.rowId}`)
        : [],
    );
    expect(named).not.toContain("services/svc-barber-haircut");
    expect(called.repo.calls.every((call) => call.scope === "biz-lees-barbershop")).toBe(true);
    // The service row's later list price never reaches decide.
    expect(JSON.stringify(responseOf(called).context)).not.toContain("4000");
  });

  it("every fact carries the row id and version its home's row gave, which the commit compares (limit 4)", async () => {
    const fixture = twoHomesFixture();
    const { context, flagged } = responseOf(await callTwoHomes(fixture));
    expect(context.facts.length).toBeGreaterThan(0);
    for (const fact of context.facts) {
      const row = fixture.rows[fact.table]?.[fact.rowId];
      expect(row, `${fact.name}'s row`).toBeDefined();
      expect(fact.rowId.length).toBeGreaterThan(0);
      expect(fact.version).toBe(row?.version);
    }
    for (const step of flagged) {
      expect(step.kept.version).toBe(fixture.rows[step.kept.table]?.[step.kept.rowId]?.version);
    }
  });

  it("the same place for one key from its home and a step: read once, given once, nothing flagged", async () => {
    const fixture = twoHomesFixture();
    const places = fixture.places.filter((place) => place.name === "booking.private");
    const called = await callTwoHomes(fixture, {
      facts: { homes: factHomes(fixture.homes), sources: [placesSource([...places, ...places])] },
    });
    const { context, flagged } = responseOf(called);
    expect(context.facts).toEqual(fixture.outcome.facts.filter((fact) => fact.name === "booking.private"));
    expect(flagged).toEqual([]);
  });
});

describe("decision reads are strong: the primary, uncached (arch 10 line 538)", () => {
  it("the read port is called with primary=true, cache=false", async () => {
    const fixture = twoHomesFixture();
    const modes: ReadMode[] = [];
    const recording = (port: FactsReadPort): FactsReadPort => ({
      readFacts(refs, mode) {
        modes.push({ ...mode });
        return port.readFacts(refs, mode);
      },
    });
    const called = await callTwoHomes(fixture, {
      facts: {
        homes: factHomes(fixture.homes),
        sources: [placesSource(fixture.places)],
        port: (repo, scope) => recording(turnStateFactsPort(repo, scope)),
      },
    });
    expect(modes).toEqual([{ primary: true, cache: false }]);
    expect(STRONG_READ).toEqual({ primary: true, cache: false });
    expect(responseOf(called).context.facts).toEqual(fixture.outcome.facts);
  });

  it("the default port serves no other read: never the replica, never a cache", async () => {
    const repo = fakeRepo(samSeed());
    const port = turnStateFactsPort(repo, { handleId: "handle-sam", businessId: "biz-lees-barbershop" });
    for (const mode of [
      { primary: false, cache: false },
      { primary: true, cache: true },
      { primary: false, cache: true },
    ]) {
      expect(isStrong(mode)).toBe(false);
      await expect(port.readFacts([], mode)).rejects.toBeInstanceOf(WeakReadError);
    }
    expect(repo.calls).toEqual([]);
    expect(isStrong(STRONG_READ)).toBe(true);
  });
});

describe("only the facts the context's choices need", () => {
  it("no home listed (the default): no fact and no read beyond T-291's, so context-s1-02.json's facts stay empty", async () => {
    const exchange = s102Exchange();
    const called = await callFrontier(exchange.request);
    const { context, flagged } = responseOf(called);
    expect(context.facts).toEqual(exchange.outcome.context.facts);
    expect(context.facts).toEqual([]);
    expect(flagged).toEqual([]);
    expect(called.repo.calls.map((call) => call.call)).toEqual(["readTurnState"]);
    expect(called.bundles.reads).toEqual([`${BUNDLE_V0.hash}/1/manifest`, `${BUNDLE_V0.hash}/1/flow/A`]);
  });

  it("a step's K-01 needs bring its facts: S1-02 needs thread, whose home gives Sam's chat", async () => {
    const thread: FactHome = {
      name: "thread",
      home: "contact",
      table: "threads",
      column: "kind",
      row: { of: "row", rowId: "thread-sam" },
    };
    const unneeded: FactHome = {
      name: "booking.private",
      home: "record",
      table: "bookings",
      column: "private",
      row: { of: "row", rowId: "booking-alex-haircut" },
    };
    const seed = samSeed();
    seed.rows.threads = {
      "thread-sam": { id: "thread-sam", handle_id: "handle-sam", kind: "chat", version: 1 },
    };
    const called = await callFrontier(s102Exchange().request, {
      seed,
      facts: { homes: factHomes([unneeded, thread]) },
    });
    const { context, flagged } = responseOf(called);
    expect(context.facts).toEqual([
      {
        name: "thread",
        value: "chat",
        home: "contact",
        table: "threads",
        rowId: "thread-sam",
        version: 1,
        forSteps: ["S1-02"],
      },
    ]);
    expect(flagged).toEqual([]);
    // Only the key S1-02 needs is read; the one no step needs is not, though it has a home.
    expect(factReads(called)).toEqual([
      [{ key: "thread", table: "threads", rowId: "thread-sam", column: "kind" }],
    ]);
    expect(checker.check("context", context)).toEqual([]);
  });

  it("no frame fact and no person's name or contact: Sam's name is read for the writer, never given as a fact", async () => {
    const fixture = twoHomesFixture();
    const called = await callTwoHomes(fixture);
    const { context } = responseOf(called);
    const first = called.repo.calls[0];
    expect(first?.call === "readTurnState" && first.request.facts.map((fact) => fact.key)).toContain(
      "person.name/person-sam",
    );
    expect(context.writer.people[0].name).toBe("Sam Lee");
    expect(context.facts.map((fact) => fact.name)).toEqual(["price", "booking.private"]);
    expect(JSON.stringify(context.facts)).not.toContain("Sam Lee");
    expect(JSON.stringify(context.facts)).not.toContain("+1555555");

    const refused: FactHome[] = [
      {
        name: "pro.name",
        home: "who",
        table: "persons",
        column: "name",
        row: { of: "row", rowId: "person-riley" },
      },
      {
        name: "reach.to",
        home: "contact",
        table: "phones",
        column: "number",
        row: { of: "row", rowId: "x" },
      },
      {
        name: "reach.to",
        home: "contact",
        table: "handles",
        column: "address",
        row: { of: "row", rowId: "x" },
      },
      {
        name: "staff",
        home: "who",
        table: "resources",
        column: "name",
        row: { of: "row", rowId: "res-riley" },
      },
    ];
    for (const home of refused) expect(() => factHomes([home])).toThrow(FactHomeError);
  });

  it("questions about other bookings add only their options: the facts are the target booking's", async () => {
    const fixture = twoHomesFixture();
    const alex = a602("oq-a6-02-alex", "booking-alex-haircut", "2026-10-22T15:02:00Z");
    const ben = a602("oq-a6-02-ben", "booking-ben-haircut", "2026-10-22T16:40:00Z");
    const seed = twoHomesSeed(fixture);
    const alexRow = fixture.rows.bookings?.["booking-alex-haircut"];
    if (alexRow === undefined) throw new Error("no booking row");
    seed.openQuestions = [alex, ben];
    seed.visits = {
      ...seed.visits,
      "booking-ben-haircut": { utc: "2026-10-24T17:30:00Z", zone: "America/New_York" },
    };
    seed.rows.bookings = {
      ...seed.rows.bookings,
      "booking-ben-haircut": { ...alexRow, id: "booking-ben-haircut", private: true, version: 4 },
    };
    const homes = factHomes(fixture.homes.filter((home) => home.name === "booking.private"));
    const called = await callFrontier(
      samRequest([alex.id, ben.id], ["booking-alex-haircut", "booking-ben-haircut"]),
      {
        seed,
        bundles: fakeBundles(MINI_A),
        // The open questions' slot alone (DL-361): this test is about their options' facts, not the doors T-1147 wired.
        sources: [{ name: "openQuestions", source: openQuestionsSource }],
        facts: {
          homes,
          sources: [
            placesSource([
              {
                name: "booking.private",
                step: "A6-02",
                table: "bookings",
                rowId: "booking-ben-haircut",
                column: "private",
              },
            ]),
          ],
        },
      },
    );
    const { context, flagged } = responseOf(called);
    // Both questions' options are offered, each labelled with its booking; Ben's, the newest, is the target's.
    expect(new Set(context.choices.map((choice) => choice.target.bookingId))).toEqual(
      new Set(["booking-alex-haircut", "booking-ben-haircut"]),
    );
    expect(context.facts).toEqual([
      {
        name: "booking.private",
        value: true,
        home: "record",
        table: "bookings",
        rowId: "booking-ben-haircut",
        version: 4,
        forSteps: ["A6-02"],
      },
    ]);
    expect(flagged).toEqual([]);
    expect(JSON.stringify(factReads(called))).not.toContain("booking-alex-haircut");
  });
});

describe("the homes list, checked when it is made", () => {
  it("refuses a second home for one key, a name that is not a K-02 fact name, and what K-05 never reads", () => {
    const price: FactHome = {
      name: "price",
      home: "money",
      table: "booking_lines",
      column: "price",
      row: { of: "row", rowId: "line-alex-haircut" },
    };
    expect(factHomes([price]).get("price")).toEqual(price);
    expect(() => factHomes([price, { ...price, table: "services", row: { of: "business" } }])).toThrow(
      /second home/u,
    );
    expect(() => factHomes([{ ...price, name: "Price" }])).toThrow(FactHomeError);
    expect(() => factHomes([{ ...price, name: "person.name/person-sam" }])).toThrow(FactHomeError);
    expect(() => factHomes([{ ...price, table: "sealing_keys", column: "wrapped_key" }])).toThrow(
      FactHomeError,
    );
    expect(() => factHomes([{ ...price, table: "sessions", column: "token_sha256" }])).toThrow(FactHomeError);
    expect(() => factHomes([{ ...price, row: { of: "row", rowId: "" } }])).toThrow(FactHomeError);
  });
});

describe("what buildFrontier answers when the facts cannot be read", () => {
  /** The fixture's call with a port answering `answer` for the facts read. */
  function withPort(answer: Awaited<ReturnType<FactsReadPort["readFacts"]>>): Promise<Called> {
    const fixture = twoHomesFixture();
    return callTwoHomes(fixture, {
      facts: {
        homes: factHomes(fixture.homes),
        sources: [placesSource(fixture.places)],
        port: () => ({ readFacts: () => Promise.resolve(answer) }),
      },
    });
  }

  it("the read's notFound and transient are buildFrontier's own errors, answered as they are, rolled back", async () => {
    const errors: Awaited<ReturnType<FactsReadPort["readFacts"]>>[] = [
      { error: "notFound", table: "booking_lines", rowId: "line-alex-haircut" },
      { error: "transient", sqlstate: "40001" },
    ];
    for (const error of errors) {
      const called = await withPort(error);
      expect(called.answer).toEqual({ ok: true, value: error });
      expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
    }
  });

  it("a fact the read refuses, another business's read, or a fact not given: a FrontierError, never a guess", async () => {
    const answers: Awaited<ReturnType<FactsReadPort["readFacts"]>>[] = [
      { error: "unknownFact", key: "price", table: "booking_lines", column: "price" },
      { result: "facts", businessId: "biz-yoga-studio", facts: [] },
      { result: "facts", businessId: "biz-lees-barbershop", facts: [] },
    ];
    for (const answer of answers) {
      const called = await withPort(answer);
      expect(called.answer.ok).toBe(false);
      const error = called.answer.ok ? undefined : called.answer.error;
      expect(error).toBeInstanceOf(FrontierError);
      expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
    }
  });

  it("with no step needing a listed key, nothing is read: the port is never called", async () => {
    const fixture = twoHomesFixture();
    let calls = 0;
    const called = await callTwoHomes(fixture, {
      facts: {
        homes: factHomes(fixture.homes),
        port: () => ({
          readFacts: () => {
            calls += 1;
            return Promise.reject(new Error("not to be called"));
          },
        }),
      },
    });
    expect(calls).toBe(0);
    expect(responseOf(called).context.facts).toEqual([]);
  });
});
