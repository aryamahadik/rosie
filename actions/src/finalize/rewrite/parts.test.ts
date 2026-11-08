// Tests of the parts code builds from a filled plan (T-313; K-03 v1 finalParts; arch 07 lines 361 to 391): the words,
// then at most one poll or card; options word for word; the calendar file only when picked; a tapback alone; and what the
// plan asked that the parts cannot hold, as the fault of the check it breaks. Values are the master's sample cast.

import { describe, expect, it } from "vitest";

import { NOT_FILLED, problemFaults } from "./attempt";
import { buildParts, type PartsInput } from "./parts";
import { a717Row, fakeRepo, runFinalize, exchange } from "./test-support";
import type { FinalizeResponse } from "./types";

const OPTIONS = [
  { id: "A7-17/1", label: "Avery instead" },
  { id: "A7-17/2", label: "Cancel visit" },
  { id: "A7-17/3", label: "Call Lee's" },
];

function input(change: Partial<PartsInput> = {}): PartsInput {
  return {
    row: "outbox-a7-17-alex-text",
    channel: "imessage",
    formats: ["text"],
    threadReplyTo: null,
    lines: [{ text: "Riley can't be in on Sat Oct 24." }],
    question: { text: "Which would you like?", optionIds: ["A7-17/1", "A7-17/2"] },
    slotValues: [
      { slot: "pro.name", value: "Riley" },
      { slot: "day", value: "Sat Oct 24" },
    ],
    options: OPTIONS,
    typedOptions: null,
    calendarFile: "new",
    card: { slot: "biz.name", value: "Lee's Barbershop" },
    ...change,
  };
}

describe("the words", () => {
  it("are the lines, then the question, then the typed options, each on its own line; no file unless picked", () => {
    const built = buildParts(input({ typedOptions: "Reply 1 Avery instead, 2 Cancel visit." }));
    expect(built.parts.sends).toEqual([
      {
        kind: "words",
        text: "Riley can't be in on Sat Oct 24.\nWhich would you like?\nReply 1 Avery instead, 2 Cancel visit.",
        calendarFile: "none",
        options: [],
        link: null,
      },
    ]);
    expect(built.parts.fixedLines).toEqual([]);
    expect(built.faults).toEqual({});
  });

  it("carry the row's calendar file when the plan picks one (arch 07 line 383)", () => {
    const built = buildParts(input({ formats: ["text", "calendarFile"] }));
    expect(built.parts.sends[0].calendarFile).toBe("new");
  });

  it("with nothing to say, a message is a Values fault, so it blocks and never goes", () => {
    const built = buildParts(input({ lines: [], question: null }));
    expect(built.faults).toEqual({ values: ["The message has no words to send."] });
    expect(built.parts.sends).toEqual([
      { kind: "words", text: "", calendarFile: "none", options: [], link: null },
    ]);
  });
});

describe("the poll and the card: at most one, after the words", () => {
  it("a poll carries the question's options, each the step's label word for word, in the plan's order", () => {
    const built = buildParts(
      input({ formats: ["text", "poll"], question: { text: "Which?", optionIds: ["A7-17/2", "A7-17/1"] } }),
    );
    expect(built.parts.sends[1]).toEqual({
      kind: "poll",
      text: null,
      calendarFile: "none",
      options: [OPTIONS[1], OPTIONS[0]],
      link: null,
    });
    expect(built.faults).toEqual({});
  });

  it("an option id the step does not hold is a Fixed lines fault, and a poll of fewer than 2 is a Format fault", () => {
    const built = buildParts(
      input({ formats: ["text", "poll"], question: { text: "Which?", optionIds: ["A7-17/1", "A7-17/9"] } }),
    );
    expect(built.faults).toEqual({
      fixedLines: ["The option A7-17/9 is not one of the step's options."],
      format: ["A poll carries 2 to 5 options, not 1."],
    });
    expect(built.parts.sends.map((send) => send.kind)).toEqual(["words"]);
  });

  it("a link card carries the first link slot's value and previews the business name, which joins the slot values", () => {
    const built = buildParts(
      input({
        formats: ["text", "linkCard"],
        question: null,
        lines: [{ text: "Change the time: rosfield.com/v/s03" }],
        slotValues: [{ slot: "link.secure", value: "rosfield.com/v/s03" }],
      }),
    );
    expect(built.parts.sends[1]).toEqual({
      kind: "linkCard",
      text: "Lee's Barbershop",
      calendarFile: "none",
      options: [],
      link: "rosfield.com/v/s03",
    });
    expect(built.parts.slotValues).toEqual([
      { slot: "link.secure", value: "rosfield.com/v/s03" },
      { slot: "biz.name", value: "Lee's Barbershop" },
    ]);
  });

  it("a card with no link slot is a Format fault; a second poll or card is dropped with one", () => {
    expect(buildParts(input({ formats: ["text", "linkCard"] })).faults).toEqual({
      format: ["A link card needs the action line's link as its slot, and a business to show."],
    });
    const both = buildParts(input({ formats: ["text", "poll", "linkCard"] }));
    expect(both.parts.sends.map((send) => send.kind)).toEqual(["words", "poll"]);
    expect(both.faults).toEqual({ format: ["A message goes as the words, then at most one poll or card."] });
  });

  it("a tapback goes alone; beside words it is dropped with a Format fault", () => {
    const alone = buildParts(input({ formats: ["tapback"], lines: [], question: null }));
    expect(alone.parts.sends).toEqual([
      { kind: "tapback", text: null, calendarFile: "none", options: [], link: null },
    ]);
    expect(alone.faults).toEqual({});
    const beside = buildParts(input({ formats: ["text", "tapback"] }));
    expect(beside.parts.sends.map((send) => send.kind)).toEqual(["words"]);
    expect(beside.faults).toEqual({ format: ["A tapback goes alone, never with words, a poll or a card."] });
  });
});

describe("a two-send message through the finalize call", () => {
  it("A6-14's shape for Alex: the words carry the calendar file, then the link card, written as one K-09 answer", async () => {
    const base = exchange("finalize-rewrite.json").request;
    const request = {
      ...base,
      plan: {
        ...base.plan,
        plan: {
          ...base.plan.plan,
          formats: ["text", "calendarFile", "linkCard"] as ["text", "calendarFile", "linkCard"],
          lines: [
            { role: "first" as const, text: "You're booked with {{pro.name}} on {{day}}." },
            { role: "action" as const, text: "Change the time or call off the visit: {{link.secure}}" },
          ],
        },
      },
    };
    const repo = fakeRepo({ ...a717Row(), calendarFile: "new" });
    const run = await runFinalize(request, repo.ports);
    const response = run.answer as FinalizeResponse;

    expect(response.outcome).toBe("send");
    expect(response.finalParts?.sends).toEqual([
      {
        kind: "words",
        text: "You're booked with Riley on Sat Oct 24.\nChange the time or call off the visit: rosfield.com/v/s03",
        calendarFile: "new",
        options: [],
        link: null,
      },
      {
        kind: "linkCard",
        text: "Lee's Barbershop",
        calendarFile: "none",
        options: [],
        link: "rosfield.com/v/s03",
      },
    ]);
    expect(repo.calls.writes).toHaveLength(1);
  });
});

describe("a text limit 7 or the fill failed always fails Values (fail closed)", () => {
  it("names each problem once by its slot, and a failure with no problem named still fails", () => {
    const unfilled = {
      kind: "unfilled",
      slot: "ask.by",
      detail: "The slot {{ask.by}} has no value.",
      why: null,
    } as const;
    expect(problemFaults([unfilled, unfilled])).toEqual(["The slot {{ask.by}} has no value."]);
    expect(problemFaults([])).toEqual([NOT_FILLED]);
  });
});
