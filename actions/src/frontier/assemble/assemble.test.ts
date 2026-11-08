// T-291's fail-closed proof: a source module that throws or is missing contributes nothing and is logged; so does one
// whose offer K-02 v1 refuses, and an option naming an open question the frontier does not list. The rest of the
// frontier is assembled in slot order with consecutive ids, and every line logged is a label: never a choice's words,
// a text, a name or a number. Through buildFrontier on the Tool API base, on build-frontier-s1-02.json's turn.

import { describe, expect, it } from "vitest";

import { isLabel } from "../../../../runtime/src/trace";
import { choiceIdOf } from "./assemble";
import { openQuestionsSource } from "../sources/open-questions";
import { callBuildFrontier, draftOf, s102Exchange, standIn, stringsIn, type Called } from "./test-support";
import type { Context, FrontierSource, SourceSlot } from "./types";

type Json = Record<string, unknown>;

function contextOf(called: Called): Context {
  if (!called.answer.ok) throw new Error("the call threw");
  return (called.answer.value as { context: Context }).context;
}

/** A source that throws, with words and a number in its message that must never reach the log. */
const throwing: FrontierSource = {
  name: "throwing",
  offer: () => {
    throw new TypeError("Sam Lee at +15555550100 broke it");
  },
};

/** A source that rejects. */
const rejecting: FrontierSource = {
  name: "rejecting",
  offer: () => Promise.reject(new RangeError("Barbershop, plumbing, electrical")),
};

describe("a source module that throws or is missing contributes nothing and is logged (fail closed)", () => {
  const exchange = s102Exchange();
  const choices = exchange.outcome.context.choices;
  const door = choices.filter((choice) => choice.kind === "door");
  const danger = choices.filter((choice) => choice.kind === "anytime");

  it("throwing, rejecting and missing sources offer nothing, each logged; the others keep their order and ids", async () => {
    const slots: SourceSlot[] = [
      { name: "openQuestions", source: openQuestionsSource },
      { name: "throwing", source: throwing },
      { name: "missing", source: null },
      { name: "hubsAndDoors", source: standIn("hubsAndDoors", door) },
      { name: "rejecting", source: rejecting },
      { name: "anyTime", source: standIn("anyTime", danger) },
    ];
    const called = await callBuildFrontier(exchange.request, { sources: slots });
    const context = contextOf(called);
    // The same five choices as the fixture: nothing of the failed slots, nothing skipped in the ids.
    expect(context.choices).toEqual(choices);

    // One line per slot that offered nothing, in slot order, whatever order the slots settled in.
    expect(called.log.lines.map(({ msg, source, error }) => ({ msg, source, error }))).toEqual([
      { msg: "frontier_source_failed", source: "throwing", error: "TypeError" },
      { msg: "frontier_source_missing", source: "missing", error: undefined },
      { msg: "frontier_source_failed", source: "rejecting", error: "RangeError" },
    ]);
    const logged = JSON.stringify(called.log.lines);
    for (const words of ["Sam Lee", "+15555550100", "Barbershop, plumbing"]) {
      expect(logged.includes(words), words).toBe(false);
    }
  });

  it("an offer K-02 v1 refuses offers nothing, logged with its count of problems, never with its words", async () => {
    const [option] = choices;
    if (option === undefined) throw new Error("no choice");
    const refused: FrontierSource[] = [
      // A choice of a kind K-02 does not have.
      {
        name: "badKind",
        offer: () => ({
          openQuestions: [],
          choices: [{ ...draftOf(danger[0] ?? {}), kind: "robot" as "door" }],
          cards: [],
        }),
      },
      // A choice with a field K-02 does not have, carrying a number.
      {
        name: "extraField",
        offer: () => ({
          openQuestions: [],
          choices: [{ ...draftOf(door[0] ?? {}), phone: "+15555550100" } as ReturnType<typeof draftOf>],
          cards: [],
        }),
      },
      // Not an offer at all.
      { name: "notAnOffer", offer: () => null as unknown as ReturnType<FrontierSource["offer"]> },
      // A good choice beside a high-stakes one with no reason: the whole offer goes.
      {
        name: "halfBad",
        offer: () => ({
          openQuestions: [],
          choices: [draftOf(door[0] ?? {}), { ...draftOf(danger[0] ?? {}), stakes: "high" as const }],
          cards: [],
        }),
      },
    ];
    const slots: SourceSlot[] = [
      { name: "openQuestions", source: openQuestionsSource },
      ...refused.map((source) => ({ name: source.name, source })),
    ];
    const called = await callBuildFrontier(exchange.request, { sources: slots });
    expect(contextOf(called).choices).toEqual(choices.filter((choice) => choice.kind === "option"));
    const lines = called.log.lines;
    expect(lines.map((line) => [line.msg, line.source])).toEqual(
      refused.map((source) => ["frontier_source_refused", source.name]),
    );
    expect(lines.every((line) => typeof line.problems === "number" && line.problems > 0)).toBe(true);
    expect(JSON.stringify(lines).includes("+15555550100")).toBe(false);
  });

  it("an option naming an open question the frontier does not list is left out and logged by its ids", async () => {
    const [option] = choices;
    if (option === undefined) throw new Error("no choice");
    const orphan: Json = { ...option, question: "oq-a7-03-alex" };
    const slots: SourceSlot[] = [
      { name: "openQuestions", source: openQuestionsSource },
      { name: "branchGates", source: standIn("branchGates", [orphan]) },
    ];
    const called = await callBuildFrontier(exchange.request, { sources: slots });
    expect(contextOf(called).choices.map((choice) => choice.question)).toEqual([
      "oq-s1-02",
      "oq-s1-02",
      "oq-s1-02",
    ]);
    expect(called.log.lines).toEqual([
      {
        level: "warn",
        msg: "frontier_option_orphaned",
        trace_id: "trace-sam-0001",
        turn_id: "turn-s1-02-sam-kinds",
        source: "branchGates",
        open_question_id: "oq-a7-03-alex",
      },
    ]);
  });

  it("the open questions' own source failing leaves its options out too: nothing about a question it did not list", async () => {
    const slots: SourceSlot[] = [
      { name: "openQuestions", source: throwing },
      { name: "branchGates", source: standIn("branchGates", choices.slice(0, 1)) },
      { name: "hubsAndDoors", source: standIn("hubsAndDoors", door) },
    ];
    const called = await callBuildFrontier(exchange.request, { sources: slots });
    const context = contextOf(called);
    expect(context.openQuestions).toEqual([]);
    expect(context.choices.map((choice) => [choice.choiceId, choice.kind])).toEqual([["c-01", "door"]]);
    expect(called.log.lines.map((line) => line.msg)).toEqual([
      "frontier_source_failed",
      "frontier_option_orphaned",
    ]);
  });

  it("every log line is labels and counts only (K-08's label rule)", async () => {
    const slots: SourceSlot[] = [
      { name: "openQuestions", source: openQuestionsSource },
      { name: "throwing", source: throwing },
      { name: "missing", source: null },
    ];
    const called = await callBuildFrontier(exchange.request, { sources: slots });
    expect(called.log.lines).toHaveLength(2);
    for (const line of called.log.lines) expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
  });
});

describe("choice ids", () => {
  it("are c-01 to c-60 in frontier order, two digits each", () => {
    expect([0, 1, 8, 9, 59].map((index) => choiceIdOf(index))).toEqual([
      "c-01",
      "c-02",
      "c-09",
      "c-10",
      "c-60",
    ]);
  });
});
