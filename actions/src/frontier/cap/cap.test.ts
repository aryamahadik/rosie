// T-295's proofs for the 60-choice cap (arch 03 line 167: "Over 60 choices: each booking other than the target
// collapses to one 'which booking?' choice"; arch 01 line 69; K-02 v1 context.choices maxItems 60 and choice kind
// whichBooking; K-09 v1 buildFrontier's collapsedBookingIds and tooManyChoices):
//   - 75 candidate choices across 6 bookings collapse to at most 60, with one 'which booking?' choice per other booking,
//     each labelled with its business, date and time; the target booking and the choices about no booking stay whole;
//   - the same through buildFrontier on the Tool API base, from 25 open questions in Sam's stored state;
//   - 60 or fewer: nothing changes; still over 60 after the collapse: tooMany with the count.
// The steps and options are K-01 v1's sample bundles' (S1-02 in bundle-v0-skeleton, A6-02 in bundle-mini-a); the
// bookings are the master's sample cast's at Lee's Barbershop (rule 9).

import { describe, expect, it } from "vitest";

import { choiceIdOf } from "../assemble/assemble";
import {
  BUNDLE_V0,
  checks,
  fakeBundles,
  openQuestionRow,
  s102Exchange,
  samSeed,
  sampleBundle,
} from "../assemble/test-support";
import type { Choice, Context, OpenQuestion, StakesReason, Time } from "../assemble/types";
import { MINI_A, a602, callFrontier, responseOf } from "../facts/test-support";
import {
  MAX_CHOICES,
  WHICH_BOOKING_DEFINITION,
  capChoices,
  targetBookingOf,
  visitWords,
  whichBookingLabel,
} from "./cap";

const { validator, checker } = checks();

const ZONE = "America/New_York";
const BUSINESS = { businessId: "biz-lees-barbershop", businessName: "Lee's Barbershop" };

/** Six bookings at Lee's Barbershop, each with its visit and the words its which-booking label shows. */
const BOOKINGS: readonly { id: string; visit: Time; words: string }[] = [
  {
    id: "booking-alex-haircut",
    visit: { utc: "2026-10-24T15:00:00Z", zone: ZONE },
    words: "Sat Oct 24, 11:00am",
  },
  {
    id: "booking-ben-haircut",
    visit: { utc: "2026-10-24T17:30:00Z", zone: ZONE },
    words: "Sat Oct 24, 1:30pm",
  },
  {
    id: "booking-dee-haircut",
    visit: { utc: "2026-10-25T14:00:00Z", zone: ZONE },
    words: "Sun Oct 25, 10:00am",
  },
  {
    id: "booking-maya-haircut",
    visit: { utc: "2026-10-25T16:00:00Z", zone: ZONE },
    words: "Sun Oct 25, 12:00pm",
  },
  {
    id: "booking-tomas-haircut",
    visit: { utc: "2026-10-26T13:30:00Z", zone: ZONE },
    words: "Mon Oct 26, 9:30am",
  },
  {
    id: "booking-avery-haircut",
    visit: { utc: "2026-10-26T15:00:00Z", zone: ZONE },
    words: "Mon Oct 26, 11:00am",
  },
];

/** A6-02's options as bundle-mini-a's card defines them (label word for word, its Means line). */
const A602_OPTIONS = [
  { label: "1 Accept", definition: "Sam accepts." },
  { label: "2 Another time", definition: "Sam offers another time, read back first." },
  { label: "3 Decline", definition: "Sam declined." },
];

/** S1-02's options as context-s1-02.json gives them: about the business, no booking. */
function s102Options(): Choice[] {
  return s102Exchange().outcome.context.choices.filter(
    (choice) => choice.kind === "option",
  ) as unknown as Choice[];
}

function targetOf(booking: (typeof BOOKINGS)[number]): Choice["target"] {
  return { ...BUSINESS, bookingId: booking.id, visitAt: { ...booking.visit } };
}

/** The four A6-02 questions asked about one booking, each with its three options (ids given later). */
function bookingOptions(booking: (typeof BOOKINGS)[number]): Omit<Choice, "choiceId">[] {
  return [1, 2, 3, 4].flatMap((n) =>
    A602_OPTIONS.map((option) => ({
      kind: "option" as const,
      question: `oq-a6-02-${booking.id}-${String(n)}`,
      branch: option.label,
      anytimeRow: null,
      door: null,
      hub: null,
      label: option.label,
      definition: option.definition,
      step: "A6-02",
      target: targetOf(booking),
      fields: [],
      stakes: "low" as const,
      stakesFrom: [],
    })),
  );
}

/** Each booking's four questions, sent in booking order, an hour apart: Avery's last question is the newest. */
function openQuestionsOf(): OpenQuestion[] {
  return BOOKINGS.flatMap((booking, index) =>
    [1, 2, 3, 4].map((n) => ({
      openQuestionId: `oq-a6-02-${booking.id}-${String(n)}`,
      step: "A6-02",
      target: targetOf(booking),
      sentAt: { utc: `2026-10-22T${String(10 + index)}:0${String(n)}:00Z`, zone: ZONE },
      pollId: null,
      askCount: 1,
    })),
  );
}

/** A choice without its id, as a source offers it. */
function withoutId(choice: Choice): Omit<Choice, "choiceId"> {
  const copy: Partial<Choice> = { ...choice };
  delete copy.choiceId;
  return copy as Omit<Choice, "choiceId">;
}

/** 75 candidate choices: S1-02's three about the business, then 72 across 6 bookings, numbered c-01 to c-75. */
function seventyFive(): Choice[] {
  const drafts = [...s102Options().map(withoutId), ...BOOKINGS.flatMap(bookingOptions)];
  return drafts.map((draft, index) => ({ ...draft, choiceId: choiceIdOf(index) }));
}

/** context-s1-02.json with these choices and open questions, for K-02 v1's check. */
function contextWith(choices: Choice[], openQuestions: OpenQuestion[]): Context {
  const context = structuredClone(s102Exchange().outcome.context) as unknown as Context;
  return { ...context, choices: choices as Context["choices"], openQuestions };
}

describe("over 60 choices: each booking other than the target collapses to one 'which booking?' choice", () => {
  it("75 candidate choices across 6 bookings collapse to at most 60, one 'which booking?' per other booking", () => {
    const choices = seventyFive();
    expect(choices).toHaveLength(75);
    expect(new Set(choices.flatMap((choice) => choice.target.bookingId ?? []))).toEqual(
      new Set(BOOKINGS.map((booking) => booking.id)),
    );
    const questions = openQuestionsOf();
    // The candidates themselves are refused by K-02 v1 (refuse-over-60-choices.json's rule).
    expect(checker.check("context", contextWith(choices, questions))).not.toEqual([]);

    const capped = capChoices(choices, questions);
    if (capped.result !== "capped") throw new Error("not capped");
    expect(capped.choices.length).toBeLessThanOrEqual(MAX_CHOICES);
    expect(capped.target).toBe("booking-avery-haircut");

    const others = BOOKINGS.filter((booking) => booking.id !== "booking-avery-haircut");
    expect(capped.collapsedBookingIds).toEqual(others.map((booking) => booking.id));
    const which = capped.choices.filter((choice) => choice.kind === "whichBooking");
    expect(which.map((choice) => choice.question)).toEqual(others.map((booking) => booking.id));
    for (const booking of others) {
      expect(capped.choices.filter((choice) => choice.target.bookingId === booking.id)).toHaveLength(1);
    }

    // S1-02's three, the five which-booking choices where each booking's first choice stood, Avery's twelve.
    expect(capped.choices.map((choice) => choice.kind)).toEqual([
      ...Array.from({ length: 3 }, () => "option"),
      ...Array.from({ length: 5 }, () => "whichBooking"),
      ...Array.from({ length: 12 }, () => "option"),
    ]);
    expect(capped.choices.slice(0, 3).map(withoutId)).toEqual(choices.slice(0, 3).map(withoutId));
    expect(capped.choices.slice(8).map(withoutId)).toEqual(choices.slice(63).map(withoutId));
    // Numbered again in frontier order: each id once.
    expect(capped.choices.map((choice) => choice.choiceId)).toEqual(
      capped.choices.map((_choice, index) => choiceIdOf(index)),
    );
    expect(checker.check("context", contextWith(capped.choices, questions))).toEqual([]);
  });

  it("each 'which booking?' choice stands for its booking: labelled by business, date and time, no field", () => {
    const capped = capChoices(seventyFive(), openQuestionsOf());
    if (capped.result !== "capped") throw new Error("not capped");
    const which = capped.choices.filter((choice) => choice.kind === "whichBooking");
    BOOKINGS.slice(0, 5).forEach((booking, index) => {
      expect(which[index]).toEqual({
        choiceId: choiceIdOf(3 + index),
        kind: "whichBooking",
        label: `Which booking? Lee's Barbershop, ${booking.words}`,
        definition: WHICH_BOOKING_DEFINITION,
        step: "A6-02",
        question: booking.id,
        branch: null,
        anytimeRow: null,
        door: null,
        hub: null,
        target: targetOf(booking),
        fields: [],
        stakes: "low",
        stakesFrom: [],
      });
    });
  });

  it("a stand-in is high when a choice it stands for is high, with their reasons; kept siblings' refs follow", () => {
    const choices = seventyFive();
    const booked: StakesReason = { why: "booked", step: "A6-10", ref: "booked" };
    /** The first question's options of the booking at `first`: the first high by its walk, the others by it. */
    const highQuestion = (first: number): void => {
      const [accept, other, decline] = [choices[first], choices[first + 1], choices[first + 2]];
      if (accept === undefined || other === undefined || decline === undefined) throw new Error("no options");
      accept.stakes = "high";
      accept.stakesFrom = [booked];
      for (const sibling of [other, decline]) {
        sibling.stakes = "high";
        sibling.stakesFrom = [{ why: "question", step: null, ref: accept.choiceId }];
      }
    };
    highQuestion(3); // Alex's first question: collapsed.
    highQuestion(63); // Avery's first question: the target's, kept.
    const capped = capChoices(choices, openQuestionsOf());
    if (capped.result !== "capped") throw new Error("not capped");

    const alex = capped.choices.find((choice) => choice.question === "booking-alex-haircut");
    expect(alex?.stakes).toBe("high");
    expect(alex?.stakesFrom).toEqual([booked]);
    expect(capped.choices.find((choice) => choice.question === "booking-ben-haircut")?.stakes).toBe("low");

    const [accept, other, decline] = capped.choices.slice(8, 11);
    expect(accept?.choiceId).toBe("c-09");
    expect(other?.stakesFrom).toEqual([{ why: "question", step: null, ref: "c-09" }]);
    expect(decline?.stakesFrom).toEqual([{ why: "question", step: null, ref: "c-09" }]);
    expect(checker.check("context", contextWith(capped.choices, openQuestionsOf()))).toEqual([]);
  });

  it("the target: the booking of the newest open question with choices, else the first booking listed", () => {
    const choices = seventyFive();
    const questions = openQuestionsOf();
    expect(targetBookingOf(choices, questions)).toBe("booking-avery-haircut");
    const older = questions.map((question) =>
      question.target.bookingId === "booking-dee-haircut"
        ? { ...question, sentAt: { utc: "2026-10-22T23:00:00Z", zone: ZONE } }
        : question,
    );
    expect(targetBookingOf(choices, older)).toBe("booking-dee-haircut");
    expect(targetBookingOf(choices, [])).toBe("booking-alex-haircut");
    expect(targetBookingOf(s102Options(), [])).toBeNull();
  });
});

describe("at 60 choices or fewer nothing changes; still over 60 after the collapse: tooMany", () => {
  it("60 choices: the same list, the same ids, nothing collapsed", () => {
    const sixty = seventyFive().slice(0, MAX_CHOICES);
    const capped = capChoices(sixty, openQuestionsOf());
    expect(capped).toEqual({
      result: "capped",
      choices: sixty,
      collapsedBookingIds: [],
      target: "booking-tomas-haircut",
    });
  });

  it("61 choices about no booking cannot collapse: tooMany with the count (K-09 v1 tooManyChoices)", () => {
    const [first] = s102Options();
    if (first === undefined) throw new Error("no option");
    const many = Array.from({ length: MAX_CHOICES + 1 }, (_each, index) => ({
      ...first,
      choiceId: choiceIdOf(index),
    }));
    expect(capChoices(many, [])).toEqual({ result: "tooMany", count: MAX_CHOICES + 1 });
  });

  it("the target's own choices over 60 stay over 60 after the others collapse: tooMany", () => {
    const avery = BOOKINGS[5];
    if (avery === undefined) throw new Error("no booking");
    const many = Array.from({ length: 21 }, () => bookingOptions(avery)).flat();
    const choices = [...many, ...bookingOptions(BOOKINGS[0] ?? avery)].map((draft, index) => ({
      ...draft,
      choiceId: choiceIdOf(index),
    }));
    expect(capChoices(choices, openQuestionsOf())).toEqual({ result: "tooMany", count: 21 * 12 + 1 });
  });
});

describe("the which-booking label: business, date and time in the visit's zone (S13-03)", () => {
  it("writes the visit as the master writes a time, and leaves out a time it cannot read", () => {
    expect(visitWords({ utc: "2026-10-19T18:05:00Z", zone: ZONE })).toBe("Mon Oct 19, 2:05pm");
    expect(visitWords({ utc: "2026-10-24T04:00:00Z", zone: ZONE })).toBe("Sat Oct 24, 12:00am");
    expect(visitWords({ utc: "2026-10-24T15:00:00Z", zone: "America/Los_Angeles" })).toBe(
      "Sat Oct 24, 8:00am",
    );
    expect(visitWords({ utc: "not a time", zone: ZONE })).toBeNull();
    expect(visitWords({ utc: "2026-10-24T15:00:00Z", zone: "Nowhere/Never" })).toBeNull();
    expect(whichBookingLabel({ ...BUSINESS, bookingId: "booking-alex-haircut", visitAt: null })).toBe(
      "Which booking? Lee's Barbershop",
    );
  });
});

describe("the collapse through buildFrontier on the Tool API base", () => {
  it("25 open questions in Sam's state give 75 choices across 6 bookings: 20 reach decide, 5 bookings collapsed", async () => {
    const v0 = sampleBundle("bundle-v0-skeleton.json");
    const rows = [
      openQuestionRow({ id: "oq-s1-02", step: "S1-02" }),
      ...BOOKINGS.flatMap((booking, index) =>
        [1, 2, 3, 4].map((n) =>
          a602(
            `oq-a6-02-${booking.id}-${String(n)}`,
            booking.id,
            `2026-10-22T${String(10 + index)}:0${String(n)}:00Z`,
          ),
        ),
      ),
    ];
    const exchange = s102Exchange();
    const request = {
      ...exchange.request,
      targets: {
        ...exchange.request.targets,
        openQuestionIds: rows.map((row) => row.id),
        bookingIds: BOOKINGS.map((booking) => booking.id),
      },
    };
    const called = await callFrontier(request, {
      seed: {
        ...samSeed(),
        openQuestions: rows,
        visits: Object.fromEntries(BOOKINGS.map((booking) => [booking.id, booking.visit])),
      },
      bundles: fakeBundles(v0, MINI_A),
    });
    const { context, flagged, collapsedBookingIds } = responseOf(called);
    expect(context.bundleId).toEqual(BUNDLE_V0);
    expect(context.openQuestions).toHaveLength(25);

    const others = BOOKINGS.slice(0, 5).map((booking) => booking.id);
    expect(collapsedBookingIds).toEqual(others);
    expect(flagged).toEqual([]);
    expect(context.choices).toHaveLength(20);
    expect(context.choices.map((choice) => [choice.kind, choice.question])).toEqual([
      ...["oq-s1-02", "oq-s1-02", "oq-s1-02"].map((question) => ["option", question]),
      ...others.map((booking) => ["whichBooking", booking]),
      ...[1, 2, 3, 4].flatMap((n) =>
        A602_OPTIONS.map(() => ["option", `oq-a6-02-booking-avery-haircut-${String(n)}`]),
      ),
    ]);
    expect(
      context.choices.filter((choice) => choice.kind === "whichBooking").map((choice) => choice.label),
    ).toEqual(BOOKINGS.slice(0, 5).map((booking) => `Which booking? Lee's Barbershop, ${booking.words}`));
    expect(checker.check("context", context)).toEqual([]);
    expect(validator.check("buildFrontier", "response", called.answer.ok && called.answer.value)).toEqual([]);
    expect(called.scope.events.at(-1)).toEqual({ what: "commit" });
  });
});
