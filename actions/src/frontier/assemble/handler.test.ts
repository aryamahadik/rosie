// T-291's proofs through the Tool API base (T-290): buildFrontier registered with its validation, business scope and
// span, its repo a fake answering K-05 v1.2 readTurnState from seeded rows, the bundles K-01 v1's sample bundles.
//   - build-frontier-s1-02.json gives exactly the fixture's choices: S1-02's three options with the registry's slots (the
//     open questions, and the hubs and doors, T-293's source wired by T-1147, which offer Sam nothing on bundle v0: it
//     holds no hub or door step of his), and all five once stand-ins fill the hubs-and-doors and any-time slots with the
//     fixture's own door and row;
//   - the output validates against K-02 v1's context schema (and the base holds it to K-09 v1's response);
//   - the slots not built are logged, by labels only; nothing is written; the span carries no words or number.
// Values come only from the contracts' fixtures and the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { isLabel, type Span } from "../../../../runtime/src/trace";
import { FrontierError, MAX_CHOICES } from "./handler";
import { FRONTIER_SOURCES, SLOT_NAMES } from "./registry";
import {
  BUNDLE_V0,
  callBuildFrontier as callFrontier,
  checks,
  contractFixture,
  fakeBundles,
  fakeRepo,
  s102Exchange,
  samSeed,
  standIn,
  stringsIn,
  type Called,
} from "./test-support";
import type { Context, SourceSlot } from "./types";

type Json = Record<string, unknown>;

const { validator, checker } = checks();

function contextOf(answer: Called["answer"]): Context {
  if (!answer.ok) throw new Error("the call threw");
  return (answer.value as { context: Context }).context;
}

function onlySpan(spans: readonly Span[]): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no span");
  return span;
}

/** The registry with stand-ins in the named slots. */
function withStandIns(stands: Record<string, readonly Json[]>): SourceSlot[] {
  return FRONTIER_SOURCES.map((slot) => {
    const choices = stands[slot.name];
    return choices === undefined ? slot : { name: slot.name, source: standIn(slot.name, choices) };
  });
}

/** Words the frontier must never log or put in a span: the texts, every choice's label and definition, who wrote. */
function wordsOf(exchange: { request: Json; outcome: Json }): string[] {
  const context = exchange.outcome.context as Context;
  const words = [
    ...context.texts.map((text) => text.words),
    ...context.choices.flatMap((choice) => [choice.label, choice.definition, choice.target.businessName]),
    context.writer.handle,
    ...context.writer.people.map((person) => person.name),
  ];
  return words.filter((each) => each.length >= 4);
}

describe("build-frontier-s1-02.json through the Tool API base", () => {
  it("with the registry's slots: exactly the fixture's three options of S1-02, the slots not built logged missing", async () => {
    const exchange = s102Exchange();
    const called = await callFrontier(exchange.request);
    const context = contextOf(called.answer);

    const options = exchange.outcome.context.choices.filter((choice) => choice.kind === "option");
    expect(options.map((choice) => choice.choiceId)).toEqual(["c-01", "c-02", "c-03"]);
    expect(context.choices).toEqual(options);
    expect(context.openQuestions).toEqual(exchange.outcome.context.openQuestions);
    expect(context.cards).toEqual(exchange.outcome.context.cards);
    expect(checker.check("context", context)).toEqual([]);

    // The hubs and doors are built (T-1147 wired T-293's source): only the branch gates and the any-time rows are not.
    expect(called.log.lines).toEqual(
      ["branchGates", "anyTime"].map((source) => ({
        level: "warn",
        msg: "frontier_source_missing",
        trace_id: "trace-sam-0001",
        turn_id: "turn-s1-02-sam-kinds",
        source,
      })),
    );
  });

  it("with the fixture's door and danger row in their slots: exactly the fixture's five choices, and its context", async () => {
    const exchange = s102Exchange();
    const choices = exchange.outcome.context.choices;
    const door = choices.filter((choice) => choice.kind === "door");
    const anytime = choices.filter((choice) => choice.kind === "anytime");
    expect([door.length, anytime.length]).toEqual([1, 1]);

    const called = await callFrontier(exchange.request, {
      sources: withStandIns({ hubsAndDoors: door, anyTime: anytime }),
    });
    const context = contextOf(called.answer);
    expect(context.choices).toEqual(choices);

    // The whole answer is the fixture's, but for the last 6 messages, which no frozen call reads yet (K-05 v1.2 open
    // gap 20): the frontier gives none until one does.
    expect(context.recentMessages).toEqual([]);
    expect(called.answer.ok && called.answer.value).toEqual({
      ...exchange.outcome,
      context: { ...exchange.outcome.context, recentMessages: [] },
    });
    expect(validator.check("buildFrontier", "response", called.answer.ok && called.answer.value)).toEqual([]);
    expect(checker.check("context", context)).toEqual([]);
    expect(called.log.lines.map((line) => [line.msg, line.source])).toEqual([
      ["frontier_source_missing", "branchGates"],
    ]);
  });

  it("the K-02 check is not vacuous: it refuses refuse-over-60-choices.json and a choice without its definition", () => {
    expect(
      checker.check("context", contractFixture("model/fixtures/invalid/refuse-over-60-choices.json")),
    ).not.toEqual([]);
    const context = structuredClone(s102Exchange().outcome.context);
    expect(checker.check("context", context)).toEqual([]);
    delete context.choices[0]?.definition;
    expect(checker.check("context", context)).not.toEqual([]);
  });

  it("reads once, under the call's business, through K-05 v1.2 readTurnState: the business, its zone, Sam's name", async () => {
    const exchange = s102Exchange();
    const called = await callFrontier(exchange.request);
    expect(called.repo.calls).toEqual([
      {
        call: "readTurnState",
        scope: "biz-lees-barbershop",
        request: {
          handleId: "handle-sam",
          businessId: "biz-lees-barbershop",
          bookingIds: [],
          facts: [
            { key: "biz.name", table: "businesses", rowId: "biz-lees-barbershop", column: "name" },
            { key: "biz.zone", table: "businesses", rowId: "biz-lees-barbershop", column: "time_zone" },
            { key: "person.name/person-sam", table: "persons", rowId: "person-sam", column: "name" },
          ],
        },
      },
    ]);
    // A read writes nothing (K-09 README: buildFrontier is safe to repeat): the transaction only reads, then ends.
    expect(called.scope.events).toEqual([
      { what: "begin" },
      { what: "scope", businessId: "biz-lees-barbershop" },
      { what: "commit" },
    ]);
    expect(called.bundles.reads).toEqual([`${BUNDLE_V0.hash}/1/manifest`, `${BUNDLE_V0.hash}/1/flow/A`]);
  });

  it("one K-08 span, hop frontier, with no words, number or name: the log too holds labels only", async () => {
    const exchange = s102Exchange();
    const called = await callFrontier(exchange.request);
    const span = onlySpan(called.spans);
    expect(span).toMatchObject({ hop: "frontier", outcome: "ok", trace_id: "trace-sam-0001" });
    expect(span.decided).toEqual({ answered: "response" });
    expect(validator.checkSpan(span)).toEqual([]);

    const words = wordsOf(exchange);
    expect(words).toContain("All on the list");
    expect(words).toContain("+15555550100");
    for (const line of [JSON.stringify(span), ...called.log.lines.map((each) => JSON.stringify(each))]) {
      for (const each of words) expect(line.includes(each), `"${each}" in ${line}`).toBe(false);
    }
    for (const line of called.log.lines) {
      expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
    }
  });
});

describe("what buildFrontier answers when it cannot build the frontier", () => {
  it("the pinned bundle in neither KV nor PostgreSQL's copy: bundleNotFound, before any state is read", async () => {
    const exchange = s102Exchange();
    const called = await callFrontier(exchange.request, { bundles: fakeBundles() });
    expect(called.answer).toEqual({ ok: true, value: { error: "bundleNotFound", bundleId: BUNDLE_V0 } });
    expect(called.repo.calls).toEqual([]);
    expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
    expect(onlySpan(called.spans)).toMatchObject({ outcome: "refused", error_code: "bundleNotFound" });
  });

  it("readTurnState's notFound and transient are buildFrontier's own errors: answered as they are, rolled back", async () => {
    const exchange = s102Exchange();
    const answers = [
      { error: "notFound", table: "handles", rowId: "handle-sam" },
      { error: "transient", sqlstate: "40001" },
    ] as const;
    for (const error of answers) {
      const repo = fakeRepo(samSeed());
      repo.nextTurnState = error;
      const called = await callFrontier(exchange.request, { repo });
      expect(called.answer).toEqual({ ok: true, value: error });
      expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
      expect(onlySpan(called.spans)).toMatchObject({
        error_code: error.error,
        outcome: error.error === "transient" ? "failed" : "refused",
      });
    }
  });

  it("a handle whose state holds no choice at all: a FrontierError (noChoices), never an empty frontier", async () => {
    const exchange = s102Exchange();
    const seed = { ...samSeed(), openQuestions: [] };
    const called = await callFrontier(exchange.request, { seed });
    expect(called.answer.ok).toBe(false);
    const error = called.answer.ok ? undefined : called.answer.error;
    expect(error).toBeInstanceOf(FrontierError);
    expect((error as FrontierError).code).toBe("noChoices");
    expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
    expect(onlySpan(called.spans)).toMatchObject({ outcome: "failed", error_code: "FrontierError" });
  });

  it("still over 60 choices once every other booking collapsed (these rows are about no booking): tooManyChoices with the count", async () => {
    const exchange = s102Exchange();
    const danger = exchange.outcome.context.choices.filter((choice) => choice.kind === "anytime");
    const many = Array.from({ length: MAX_CHOICES }, () => danger).flat();
    const called = await callFrontier(exchange.request, { sources: withStandIns({ anyTime: many }) });
    expect(called.answer).toEqual({ ok: true, value: { error: "tooManyChoices", count: MAX_CHOICES + 3 } });
    expect(called.scope.events.at(-1)).toEqual({ what: "rollback" });
  });

  it("an unknownFact from the read is a builder fault (the frontier names its facts itself): a FrontierError", async () => {
    const exchange = s102Exchange();
    const repo = fakeRepo(samSeed());
    repo.nextTurnState = { error: "unknownFact", key: "biz.name", table: "businesses", column: "name" };
    const called = await callFrontier(exchange.request, { repo });
    expect(called.answer.ok).toBe(false);
    expect(called.answer.ok ? undefined : (called.answer.error as FrontierError).code).toBe("unknownFact");
  });
});

describe("the registry", () => {
  it("lists the four slots in frontier order; the open questions and the hubs and doors are built (T-292 and T-294 fill the rest)", () => {
    expect(FRONTIER_SOURCES.map((slot) => slot.name)).toEqual([...SLOT_NAMES]);
    expect(FRONTIER_SOURCES.map((slot) => slot.source?.name ?? null)).toEqual([
      "openQuestions",
      null,
      "hubsAndDoors",
      null,
    ]);
  });
});
