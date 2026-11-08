// The guard on a turn (T-250): keyword texts to the fixed-reply path by code alone, the other texts on with the handle's
// targets, or the doors. Hard invariant: a stop word never reaches the decide path. The pinned bundle is K-01's bundle v0
// (its manifest checked by the pin's own check); K-05 v1.2 `handleTargets` is a fake answering K-05's fixtures.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Manifest } from "../bundle";
import type { Span } from "../trace";
import { readContractJson, schemaErrors } from "../trace/test-support";
import { guardTurn } from "./guard";
import { setGuardDeps } from "./targets";
import {
  fakeTargets,
  pinnedManifest,
  responseOf,
  targetsExchange,
  turnTrace,
  typed,
  type FakeTargets,
} from "./test-support";
import { GuardError, type GuardResult, type GuardText } from "./types";

const KEYWORDS = readContractJson("bundle/fixtures/keywords.json") as {
  start: string;
  help: string;
  optOut: string[];
  flagsVisit: string[];
};

let manifest: Manifest;
let fake: FakeTargets;
let restore: () => void;
let spans: Span[];

beforeEach(async () => {
  manifest = await pinnedManifest();
  fake = fakeTargets();
  for (const name of ["targets-alex", "targets-sam-owner", "targets-first-text"]) {
    const exchange = targetsExchange(name);
    fake.answers.set(exchange.request.handleId, exchange.outcome);
  }
  restore = setGuardDeps({ targets: fake.port });
});

afterEach(() => {
  restore();
});

/** Runs the guard on one turn of these texts from this handle, on bundle v0, keeping the turn's spans. */
async function guard(texts: readonly GuardText[], handleId = "handle-alex"): Promise<GuardResult<GuardText>> {
  const traced = turnTrace();
  spans = traced.spans;
  return guardTurn({ handleId, texts, bundle: { manifest }, trace: traced.trace });
}

/** The one guard span of the last turn, checked against K-08 v1's span definition. */
function guardSpan(): Span {
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error("no guard span");
  expect(span.hop).toBe("guard");
  expect(schemaErrors("span", span)).toEqual([]);
  return span;
}

/** The decide path as the guard's caller reaches it: only after a targets read, and only with `onward.texts`. */
function decidePath(): { handed: GuardText[]; take: (result: GuardResult<GuardText>) => void } {
  const handed: GuardText[] = [];
  return {
    handed,
    take(result) {
      if (result.onward?.read === "targets") handed.push(...result.onward.texts);
    },
  };
}

describe("a text that is only a keyword goes to the fixed-reply path by code alone", () => {
  it("a bare STOP: one keyword text, nothing handed on, nothing read", async () => {
    const stop = typed("STOP");

    const result = await guard([stop]);

    expect(result).toEqual({
      keywords: [{ text: stop, keyword: { kind: "stop", word: "STOP", flagsVisit: false } }],
      onward: null,
    });
    expect(fake.calls).toEqual([]);
    const span = guardSpan();
    expect(span.outcome).toBe("ok");
    expect(span.got).toEqual({ texts: 1 });
    expect(span.decided).toEqual({ keyword: ["stop"], flagsVisit: false, toDecide: 0 });
  });

  it("START and HELP alone take the same path, with nothing read", async () => {
    const start = typed("Start");
    const help = typed("help?");

    const result = await guard([start, help]);

    expect(result.keywords).toEqual([
      { text: start, keyword: { kind: "start", word: KEYWORDS.start, flagsVisit: false } },
      { text: help, keyword: { kind: "help", word: KEYWORDS.help, flagsVisit: false } },
    ]);
    expect(result.onward).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(guardSpan().decided).toEqual({ keyword: ["start", "help"], flagsVisit: false, toDecide: 0 });
  });

  it.each(["CANCEL", "CANCELAR"])("a bare %s is a stop that also flags the visit", async (word) => {
    const cancel = typed(`${word.toLowerCase()}!`);

    const result = await guard([cancel]);

    expect(result.keywords).toEqual([{ text: cancel, keyword: { kind: "stop", word, flagsVisit: true } }]);
    expect(result.onward).toBeNull();
    expect(guardSpan().decided).toEqual({ keyword: ["stop"], flagsVisit: true, toDecide: 0 });
  });

  it("STOP then START in one turn: both keyword texts, in arrival order", async () => {
    const stop = typed("stop");
    const start = typed("START");

    const result = await guard([stop, start]);

    expect(result.keywords.map((found) => [found.text, found.keyword.kind])).toEqual([
      [stop, "stop"],
      [start, "start"],
    ]);
    expect(result.onward).toBeNull();
  });
});

describe("otherwise the guard lists the handle's roles, open questions and bookings as targets", () => {
  it("'cancel my 2pm haircut' is not a keyword (BP 9.4): it goes on with Alex's targets", async () => {
    const text = typed("cancel my 2pm haircut");

    const result = await guard([text]);

    expect(result.keywords).toEqual([]);
    expect(result.onward).toEqual({
      read: "targets",
      texts: [text],
      targets: {
        roles: [
          { businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" },
          { businessId: "biz-yoga-studio", personId: "person-alex", role: "customer" },
        ],
        openQuestionIds: ["oq-a7-03-alex"],
        bookingIds: ["booking-alex-haircut", "booking-alex-workshop"],
        noTarget: false,
      },
    });
    expect(fake.calls).toEqual([{ handleId: "handle-alex" }]);
    const span = guardSpan();
    expect(span.got).toEqual({ texts: 1, roles: 2, openQuestions: 1, bookings: 2 });
    expect(span.decided).toEqual({ keyword: null, flagsVisit: false, toDecide: 1, targets: 3, doors: false });
  });

  it("a handle with two open questions and one booking lists three targets", async () => {
    const answer = responseOf(targetsExchange("targets-alex"));
    const [question] = answer.openQuestions;
    const [haircut] = answer.bookings;
    if (question === undefined || haircut === undefined) throw new Error("targets-alex changed");
    answer.openQuestions = [
      question,
      {
        ...question,
        id: "oq-a3-51-alex-yoga",
        businessId: "biz-yoga-studio",
        bookingId: null,
        step: "A3-51",
      },
    ];
    answer.bookings = [haircut];
    fake.answers.set("handle-alex", answer);

    const result = await guard([typed("Is Saturday still OK?")]);

    if (result.onward?.read !== "targets") throw new Error("no targets");
    expect(result.onward.targets.openQuestionIds).toEqual(["oq-a7-03-alex", "oq-a3-51-alex-yoga"]);
    expect(result.onward.targets.bookingIds).toEqual(["booking-alex-haircut"]);
    expect(result.onward.targets.noTarget).toBe(false);
    expect(guardSpan().decided).toMatchObject({ targets: 3, doors: false });
  });

  it("one with none lists none: the doors (S1-01, a new owner's first text)", async () => {
    const text = typed("JOIN");

    const result = await guard([text], "handle-gw-0108");

    expect(result.keywords).toEqual([]);
    expect(result.onward).toEqual({
      read: "targets",
      texts: [text],
      targets: { roles: [], openQuestionIds: [], bookingIds: [], noTarget: true },
    });
    const span = guardSpan();
    expect(span.got).toEqual({ texts: 1, roles: 0, openQuestions: 0, bookings: 0 });
    expect(span.decided).toEqual({ keyword: null, flagsVisit: false, toDecide: 1, targets: 0, doors: true });
  });

  it("an owner with roles and no open question or booking: the doors, with his roles (targets-sam-owner)", async () => {
    const result = await guard([typed("Close Saturday at 3")], "handle-sam");

    if (result.onward?.read !== "targets") throw new Error("no targets");
    expect(result.onward.targets.noTarget).toBe(true);
    expect(result.onward.targets.roles.map((role) => role.role)).toEqual(["owner", "owner", "owner"]);
    expect(guardSpan().decided).toMatchObject({ targets: 0, doors: true });
  });

  it("a keyword text beside other texts: the keyword to its path, the others on with the targets, in order", async () => {
    const question = typed("what time is my haircut?");
    const cancel = typed("Cancel");
    const thanks = typed("thanks");

    const result = await guard([question, cancel, thanks]);

    expect(result.keywords).toEqual([
      { text: cancel, keyword: { kind: "stop", word: "CANCEL", flagsVisit: true } },
    ]);
    expect(result.onward?.texts).toEqual([question, thanks]);
    expect(result.onward?.read).toBe("targets");
    expect(guardSpan().decided).toEqual({
      keyword: ["stop"],
      flagsVisit: true,
      toDecide: 2,
      targets: 3,
      doors: false,
    });
  });

  it("a reaction and a poll vote are not keywords: they go on with the targets", async () => {
    const vote: GuardText = { eventId: "evt-alex-0008", kind: "pollVote", words: null };
    const reaction: GuardText = { eventId: "evt-alex-0009", kind: "reaction", words: null };

    const result = await guard([vote, reaction]);

    expect(result.keywords).toEqual([]);
    expect(result.onward?.texts).toEqual([vote, reaction]);
  });
});

describe("fails closed", () => {
  it("a bundle with no keyword list it can read stops the run: nothing is split, nothing read (noKeywords)", async () => {
    const stop = typed("STOP");
    const traced = turnTrace();
    const bundle = { manifest: { ...manifest, lists: { ...(manifest.lists as object), keywords: null } } };

    const run = guardTurn({ handleId: "handle-alex", texts: [stop], bundle, trace: traced.trace });

    await expect(run).rejects.toThrow(GuardError);
    await expect(run).rejects.toMatchObject({ code: "noKeywords" });
    expect(fake.calls).toEqual([]);
    expect(traced.spans).toHaveLength(1);
    expect(traced.spans[0]).toMatchObject({ hop: "guard", outcome: "failed", error_code: "noKeywords" });
    expect(schemaErrors("span", traced.spans[0])).toEqual([]);
  });

  it.each([
    ["transient", { error: "transient", sqlstate: "40001" }],
    ["notFound", { error: "notFound", table: "handles", rowId: "handle-alex" }],
    ["badAnswer", { result: "targets", handleId: "handle-sam" }],
  ])(
    "a targets read answering %s hands nothing to decide; the keyword texts still go to their path",
    async (code, answer) => {
      fake.answers.set("handle-alex", answer);
      const stop = typed("Stop.");
      const question = typed("can I move to 3pm?");

      const result = await guard([stop, question]);

      expect(result.keywords).toEqual([
        { text: stop, keyword: { kind: "stop", word: "STOP", flagsVisit: false } },
      ]);
      expect(result.onward).toEqual({ read: "failed", texts: [question], errorCode: code });
      const span = guardSpan();
      expect(span.outcome).toBe("failed");
      expect(span.error_code).toBe(code);
    },
  );

  it("no targets read set yet (before D-017): nothing goes to decide", async () => {
    restore();
    restore = setGuardDeps(null);

    const result = await guard([typed("hello")]);

    expect(result.onward).toMatchObject({ read: "failed", errorCode: "unwired" });
  });
});

describe("hard invariant: a stop word never reaches the decide path", () => {
  const forms = (word: string): string[] => [
    word,
    word.toLowerCase(),
    `${word.charAt(0)}${word.slice(1).toLowerCase()}`,
    `${word}!`,
    `${word.toLowerCase()}.`,
    `${word.toLowerCase()}?!`,
    ` ${word} \n`,
    `¡${word.toLowerCase()}!`,
  ];
  const ordinary = ["cancel my 2pm haircut", "what time is my haircut?", "Please stop texting me at night"];

  it.each(KEYWORDS.optOut)(
    "%s, in any form, alone or among other texts, is never handed on",
    async (word) => {
      for (const form of forms(word)) {
        const layouts: string[][] = [
          [form],
          [form, ...ordinary],
          [...ordinary, form],
          [ordinary[0] ?? "", form, ordinary[1] ?? ""],
          [form, "START", form],
        ];
        for (const layout of layouts) {
          fake.calls.length = 0;
          const texts = layout.map((words) => typed(words));
          const stops = texts.filter((text) => text.words?.body === form);
          const decide = decidePath();

          const result = await guard(texts);
          decide.take(result);

          const handedIds = decide.handed.map((text) => text.eventId);
          const onwardIds = (result.onward?.texts ?? []).map((text) => text.eventId);
          for (const stop of stops) {
            expect(handedIds, JSON.stringify(layout)).not.toContain(stop.eventId);
            expect(onwardIds, JSON.stringify(layout)).not.toContain(stop.eventId);
            expect(
              result.keywords.find((found) => found.text.eventId === stop.eventId)?.keyword,
              JSON.stringify(layout),
            ).toEqual({ kind: "stop", word, flagsVisit: KEYWORDS.flagsVisit.includes(word) });
          }
          // Every text is in exactly one place: the fixed-reply path or the way on, in arrival order.
          expect([
            ...result.keywords.map((found) => found.text),
            ...(result.onward?.texts ?? []),
          ]).toHaveLength(texts.length);
          // A turn of keyword texts alone reads nothing: the stop never waits on the database.
          const keywordsOnly = result.onward === null;
          expect(fake.calls.length, JSON.stringify(layout)).toBe(keywordsOnly ? 0 : 1);
        }
      }
    },
  );

  it("even when the targets read fails, the stop is a keyword text and nothing is handed to decide", async () => {
    fake.failing = true;
    for (const word of KEYWORDS.optOut) {
      const stop = typed(word.toLowerCase());
      const decide = decidePath();

      const result = await guard([typed("hi"), stop]);
      decide.take(result);

      expect(decide.handed).toEqual([]);
      expect(result.onward).toMatchObject({ read: "failed", errorCode: "noAnswer" });
      expect(result.keywords.map((found) => found.text)).toEqual([stop]);
    }
  });

  it("the guard span holds counts and labels only, never a text's words", async () => {
    const texts = [typed("cancel my 2pm haircut"), typed("¡Basta!"), typed("Opt Out")];

    await guard(texts);

    const line = JSON.stringify(guardSpan());
    for (const fragment of ["haircut", "2pm", "Basta", "BASTA", "Opt Out", "OPT OUT"]) {
      expect(line).not.toContain(fragment);
    }
  });
});
