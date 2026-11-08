// The shared value reader (T-304): amounts, counts, dates and times read from a person's words in English and Spanish,
// and the re-parse limit 6 runs on each value. Words come from the contracts' fixtures and the master's own examples
// (K-02 decide-two-requests.json's "$12 a foot"; S11-20's "raise haircut to 40"; S1-13's "A at their home too, 75";
// S11-13's "BLOCK Thu 2-5"; A3-07's "Quiero un corte el sábado"), dates in October and November 2026 as the master writes
// them (S13-03: "like on Sun Nov 1").

import { describe, expect, it } from "vitest";

import {
  amountsIn,
  countsIn,
  foldWords,
  foundAtWordEdges,
  instantsAt,
  instantsFor,
  optionsNamedIn,
  readTimeWords,
  reparse,
  timeReadingOf,
  wholePhraseFault,
  zonesNamedIn,
  type FieldType,
  type FieldValue,
  type ReparseContext,
  type TimeWords,
} from "./index";

const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";

/** The one time the words name; fails the test for none or several. */
function timeIn(words: string, languages?: readonly ("en" | "es")[]): TimeWords {
  const read = readTimeWords(words, languages);
  if (read.kind !== "time") throw new Error(`no one time: ${read.kind}`);
  return read.time;
}

/** Every instant the words can mean, sent at `sent`, in `zone`, as UTC strings. */
function readings(words: string, sent: string, zone: string, languages?: readonly ("en" | "es")[]): string[] {
  return instantsFor(timeIn(words, languages), Date.parse(sent), zone).map((ms) =>
    new Date(ms).toISOString().replace(".000Z", "Z"),
  );
}

const cents = (words: string, languages?: readonly ("en" | "es")[]): number[] =>
  amountsIn(words, languages).map((amount) => amount.money.cents);

describe("amounts of money", () => {
  it.each([
    ["$12 a foot", [1200]],
    ["raise haircut to 40", [4000]],
    ["A at their home too, 75, paid when they book", [7500]],
    ["$1,200", [120000]],
    ["$12.50", [1250]],
    ["$12.5", [1250]],
    ["12 dollars", [1200]],
    ["12$", [1200]],
    ["twelve dollars", [1200]],
    ["forty bucks", [4000]],
    ["fifty cents", [50]],
    ["50 cents", [50]],
    ["Style consult · Free", [0]],
    ["$40 deposit, $100 after the visit", [4000, 10000]],
    ["$12-15", [1200, 1500]],
  ] as const)("'%s' holds %j", (words, expected) => {
    expect(cents(words)).toEqual(expected);
  });

  it("reads Spanish money words: 'doce dólares', 'treinta y cinco dólares'", () => {
    expect(cents("doce dólares", ["es"])).toEqual([1200]);
    expect(cents("treinta y cinco dólares", ["es"])).toEqual([3500]);
  });

  it.each([
    "3pm",
    "10:30",
    "10/24",
    "the 24th",
    "40 minutes",
    "10%",
    "tile",
    "barbering and some other stuff",
  ])("'%s' holds no amount", (words) => {
    expect(cents(words)).toEqual([]);
  });

  it("a bare number counts only when nothing else in the words is money", () => {
    expect(cents("$35 for 2")).toEqual([3500]);
    expect(amountsIn("40")[0]?.marked).toBe(false);
    expect(amountsIn("$40")[0]?.marked).toBe(true);
    expect(amountsIn("$40")[0]?.money.currency).toBe("USD");
  });
});

describe("counts", () => {
  it.each([
    ["a table for 4 at 7pm", [4]],
    ["two", [2]],
    ["twenty-five", [25]],
    ["a hundred and five", [105]],
    ["fifteen hundred", [1500]],
    ["12 booked", [12]],
    ["none", [0]],
    ["$35 for 2", [2]],
    ["2 adults and 1 child", [2, 1]],
    ["five twenty", [5, 20]],
  ] as const)("'%s' holds %j", (words, expected) => {
    expect(countsIn(words)).toEqual(expected);
  });

  it.each([
    ["dos", [2]],
    ["treinta y cinco", [35]],
    ["veintidós", [22]],
    ["doscientos", [200]],
    ["dos mil", [2000]],
    ["mesa para cuatro", [4]],
  ] as const)("Spanish '%s' holds %j", (words, expected) => {
    expect(countsIn(words, ["es"])).toEqual(expected);
  });

  it("'once' is eleven only in a Spanish text: in English it means one time", () => {
    expect(countsIn("once", ["es"])).toEqual([11]);
    expect(countsIn("once a week", ["en"])).toEqual([]);
    expect(countsIn("once", ["en", "es"])).toEqual([]);
  });
});

describe("dates and times, from the send time in a zone", () => {
  // Sun Oct 25 2026 at 11:30pm in New York (EDT): already Mon Oct 26 03:30 in UTC, still Sun 8:30pm in Los Angeles.
  const LATE_SUNDAY = "2026-10-26T03:30:00Z";

  it("'tomorrow at 3' sent 23:30 New York resolves on the zone's own calendar: either 3am or 3pm", () => {
    expect(readings("tomorrow at 3", LATE_SUNDAY, LOS_ANGELES)).toEqual([
      "2026-10-26T10:00:00Z",
      "2026-10-26T22:00:00Z",
    ]);
    expect(readings("tomorrow at 3", LATE_SUNDAY, NEW_YORK)).toEqual([
      "2026-10-26T07:00:00Z",
      "2026-10-26T19:00:00Z",
    ]);
  });

  it("across the fall-back change (Sun Nov 1 2026) a wall time keeps its wall time", () => {
    // Sat Oct 31 at 10:00am EDT: tomorrow at 3pm is 3pm EST, 20:00 UTC, never 24 hours on (19:00 UTC).
    expect(readings("tomorrow at 3pm", "2026-10-31T14:00:00Z", NEW_YORK)).toEqual(["2026-11-01T20:00:00Z"]);
    expect(readings("Sun Nov 1 at 11:00am", "2026-10-31T14:00:00Z", NEW_YORK)).toEqual([
      "2026-11-01T16:00:00Z",
    ]);
  });

  it("across the spring-forward change (Sun Mar 8 2026) too, and a skipped hour has no instant", () => {
    expect(readings("tomorrow at 3pm", "2026-03-07T15:00:00Z", NEW_YORK)).toEqual(["2026-03-08T19:00:00Z"]);
    expect(readings("tomorrow at 2:30am", "2026-03-07T15:00:00Z", NEW_YORK)).toEqual([]);
    expect(instantsAt(NEW_YORK, { year: 2026, month: 3, day: 8, hour: 2, minute: 30 })).toEqual([]);
  });

  it("an hour the fall-back change repeats has both instants", () => {
    expect(readings("tomorrow at 1:30am", "2026-10-31T14:00:00Z", NEW_YORK)).toEqual([
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:30:00Z",
    ]);
  });

  it("an hour with am, pm, or morning or afternoon words has one reading", () => {
    const sent = "2026-10-19T14:05:00Z";
    expect(readings("tomorrow at 3pm", sent, NEW_YORK)).toEqual(["2026-10-20T19:00:00Z"]);
    expect(readings("tomorrow at 9 in the morning", sent, NEW_YORK)).toEqual(["2026-10-20T13:00:00Z"]);
    expect(readings("tomorrow at noon", sent, NEW_YORK)).toEqual(["2026-10-20T16:00:00Z"]);
    expect(readings("tonight at 8", sent, NEW_YORK)).toEqual(["2026-10-20T00:00:00Z"]);
    expect(readings("tomorrow 15:30", sent, NEW_YORK)).toEqual(["2026-10-20T19:30:00Z"]);
  });

  it("reads Spanish: 'mañana a las 3 de la tarde', 'el sábado a las 11', 'mañana por la mañana a las 9'", () => {
    const monday = "2026-10-19T14:05:00Z";
    expect(readings("mañana a las 3 de la tarde", monday, NEW_YORK, ["es"])).toEqual([
      "2026-10-20T19:00:00Z",
    ]);
    expect(readings("Quiero un corte el sábado a las 11", monday, NEW_YORK, ["es"])).toEqual([
      "2026-10-24T15:00:00Z",
      "2026-10-25T03:00:00Z",
    ]);
    expect(readings("mañana por la mañana a las 9", monday, NEW_YORK, ["es"])).toEqual([
      "2026-10-20T13:00:00Z",
    ]);
  });

  it("reads the master's own dates: 'Sat Oct 24 · 11:00am', '10/24 at 2pm', 'the 24th at 2pm'", () => {
    const sent = "2026-10-19T14:05:00Z";
    expect(readings("Sat Oct 24 · 11:00am", sent, NEW_YORK)).toEqual(["2026-10-24T15:00:00Z"]);
    expect(readings("10/24 at 2pm", sent, NEW_YORK)).toEqual(["2026-10-24T18:00:00Z"]);
    expect(readings("the 24th at 2pm", sent, NEW_YORK)).toEqual(["2026-10-24T18:00:00Z"]);
    expect(readings("24 de octubre a las 2 de la tarde", sent, NEW_YORK, ["es"])).toEqual([
      "2026-10-24T18:00:00Z",
    ]);
  });

  it("a weekday that does not fall on the date named gives nothing", () => {
    expect(readings("Fri Oct 24 at 11am", "2026-10-19T14:05:00Z", NEW_YORK)).toEqual([]);
  });

  it("a weekday is the next one on or after the send date; 'next' the coming one or the one after", () => {
    // Mon Oct 26 2026 at 11:30am EDT (S11-13's BLOCK, sent then).
    const monday = "2026-10-26T15:30:00Z";
    expect(readings("Thu at 2pm", monday, NEW_YORK)).toEqual(["2026-10-29T18:00:00Z"]);
    expect(readings("next Thursday at 2pm", monday, NEW_YORK)).toEqual([
      "2026-10-29T18:00:00Z",
      "2026-11-05T19:00:00Z",
    ]);
    expect(readings("Monday at 2pm", monday, NEW_YORK)).toEqual([
      "2026-10-26T18:00:00Z",
      "2026-11-02T19:00:00Z",
    ]);
  });

  it("a time with no day is the next time the clock reads it; a day with no time is its start", () => {
    const sent = "2026-10-19T14:05:00Z"; // 10:05am EDT
    expect(readings("at 9am", sent, NEW_YORK)).toEqual(["2026-10-20T13:00:00Z"]);
    expect(readings("at 2pm", sent, NEW_YORK)).toEqual(["2026-10-19T18:00:00Z"]);
    expect(readings("tomorrow", sent, NEW_YORK)).toEqual(["2026-10-20T04:00:00Z"]);
  });

  it("'in 2 hours' is elapsed time from the send", () => {
    expect(readings("in 2 hours", "2026-10-19T14:05:00Z", NEW_YORK)).toEqual(["2026-10-19T16:05:00Z"]);
    expect(readings("in 3 days at 4pm", "2026-10-19T14:05:00Z", NEW_YORK)).toEqual(["2026-10-22T20:00:00Z"]);
  });

  it.each([
    "BLOCK Thu 2-5",
    "3 or 4pm",
    "tomorrow or Friday at 3pm",
    "in 2 hours or tomorrow",
    "Thu 2pm-5pm",
  ])("'%s' names several times, never one", (words) => {
    expect(readTimeWords(words).kind).toBe("several");
  });

  it("a bare number is an hour only right beside its day: 'BLOCK Thu 2', never 'tomorrow, party of 6'", () => {
    const monday = "2026-10-26T15:30:00Z";
    expect(readings("BLOCK Thu 2", monday, NEW_YORK)).toEqual([
      "2026-10-29T06:00:00Z",
      "2026-10-29T18:00:00Z",
    ]);
    expect(readings("tomorrow, party of 6", monday, NEW_YORK)).toEqual(["2026-10-27T04:00:00Z"]);
    expect(readTimeWords("party of 6").kind).toBe("none");
  });

  it.each(["the usual", "barbering and some other stuff", "1"])("'%s' names no time", (words) => {
    expect(readTimeWords(words).kind).toBe("none");
  });
});

describe("words found in a text only whole, at word edges (DL-184)", () => {
  it.each([
    ["raise haircut to 140", "40", "140"],
    ["can we do tomorrow at 10", "tomorrow at 1", "tomorrow at 10"],
    ["raise haircut to $1,200", "$1", "$1,200"],
    ["can I come in Oct 24", "Oct 2", "Oct 24"],
    ["can you fit 12 people tomorrow", "2 people", "12 people"],
    ["can you fit 12 people tomorrow", "2", "12"],
    ["10am works", "1", "10am"],
    ["yesterday was better", "yes", "yesterday"],
    ["you know", "no", "know"],
  ])("in '%s', '%s' is cut out of a longer word or number and not found; '%s' is", (text, cut, whole) => {
    expect(text.includes(cut)).toBe(true);
    expect(foundAtWordEdges(text, cut)).toBe(false);
    expect(foundAtWordEdges(text, whole)).toBe(true);
  });

  it.each([
    ["$1,200", "200"],
    ["at 10:30", "30"],
    ["at 10:30", "at 10"],
    ["10/24 at 2pm", "24 at 2pm"],
    ["10/24 at 2pm", "10"],
    ["$12.50", "$12"],
    ["$12.50", "50"],
    ["about .5 hours", "5 hours"],
  ])("a number's own marks join it: in '%s', '%s' is not found", (text, cut) => {
    expect(foundAtWordEdges(text, cut)).toBe(false);
  });

  it.each([
    ["twenty-five people", "twenty"],
    ["twenty-five people", "five people"],
    ["tile is $12-15 a foot", "$12"],
    ["BLOCK Thu 2-5", "Thu 2"],
    ["2–5pm", "5pm"],
    ["I can't make it", "I can"],
    ["I can’t make it", "I can"],
    ["Sam's price board", "Sam"],
  ])("a hyphen, dash or apostrophe joins words: in '%s', '%s' is not found", (text, cut) => {
    expect(foundAtWordEdges(text, cut)).toBe(false);
  });

  it.each([
    ["tile is $12 a foot from now on", "$12 a foot"],
    ["yes, 2", "yes"],
    ["yes, 2", "2"],
    ["2, you know", "2"],
    ["move me to tomorrow at 3.", "tomorrow at 3"],
    ["(3pm) works", "3pm"],
    ["'yes' please", "yes"],
    ["Sat Oct 24 · 11:00am", "Sat Oct 24 · 11:00am"],
    ["BLOCK Thu 2-5", "Thu 2-5"],
    ["tomorrow - 3pm", "tomorrow"],
    ["I can't make it", "I can't"],
    ["I said yesterday, and yes I meant it", "yes"],
  ])(
    "words with spaces, punctuation or the text's end around them are found: in '%s', '%s'",
    (text, whole) => {
      expect(foundAtWordEdges(text, whole)).toBe(true);
    },
  );

  it("is word for word otherwise: case and spacing count, and empty words or spaces are never found", () => {
    expect(foundAtWordEdges("yes please", "Yes")).toBe(false);
    expect(foundAtWordEdges("yes  please", "yes please")).toBe(false);
    expect(foundAtWordEdges("yes please", "")).toBe(false);
    expect(foundAtWordEdges("yes please", " ")).toBe(false);
    expect(foundAtWordEdges("", "yes")).toBe(false);
  });

  it("an accent typed apart, or a letter outside the basic plane, is part of its word", () => {
    expect(foundAtWordEdges("café at 3", "cafe")).toBe(false);
    expect(foundAtWordEdges("café at 3", "café")).toBe(true);
    expect(foundAtWordEdges("𝐀yes", "yes")).toBe(false);
    expect(foundAtWordEdges("👍 yes", "yes")).toBe(true);
    expect(foundAtWordEdges("yes👍", "yes")).toBe(true);
  });
});

describe("re-parse", () => {
  const sentAt = "2026-10-26T15:30:00Z";
  const context: ReparseContext = { sentAt, zones: [NEW_YORK] };

  it("text: every word of the value is a word of theirs (K-02's S1-02 fixtures)", () => {
    const words = "Barbershop, plumbing, electrical";
    expect(reparse("text", "Barbershop, plumbing, electrical", words, context)).toEqual({ ok: true });
    expect(reparse("text", "Barbershop, plumbing", "barbering and some other stuff", context)).toEqual({
      ok: false,
      why: "differs",
    });
    expect(reparse("text", "thursday afternoon", "thursday afternoon", context)).toEqual({ ok: true });
  });

  it("money: the one amount, in cents and its currency; a price with no amount in its words is refused", () => {
    const price = { cents: 1200, currency: "USD" };
    expect(reparse("money", price, "$12 a foot", context)).toEqual({ ok: true });
    expect(reparse("money", price, "tile", context)).toEqual({ ok: false, why: "noValue" });
    expect(reparse("money", { cents: 1500, currency: "USD" }, "$12 a foot", context)).toEqual({
      ok: false,
      why: "differs",
    });
    expect(reparse("money", { cents: 1200, currency: "EUR" }, "$12 a foot", context)).toEqual({
      ok: false,
      why: "differs",
    });
    expect(reparse("money", { cents: 4000, currency: "USD" }, "$40 deposit, $100 after", context)).toEqual({
      ok: false,
      why: "several",
    });
    expect(reparse("money", "$12", "$12 a foot", context)).toEqual({ ok: false, why: "typeMismatch" });
  });

  it("integer, boolean, zone, id and choice", () => {
    expect(reparse("integer", 4, "a table for 4 at 7pm", context)).toEqual({ ok: true });
    expect(reparse("integer", 3, "a table for 4", context)).toEqual({ ok: false, why: "differs" });
    expect(reparse("integer", 2, "2 adults and 1 child", context)).toEqual({ ok: false, why: "several" });
    expect(reparse("boolean", true, "yes", context)).toEqual({ ok: true });
    expect(reparse("boolean", true, "not yet", context)).toEqual({ ok: false, why: "differs" });
    expect(reparse("zone", LOS_ANGELES, "Pacific time", context)).toEqual({ ok: true });
    expect(zonesNamedIn("america/los_angeles")).toEqual(["america/los_angeles"]);
    expect(reparse("id", "R7K2", "my code is r7k2", context)).toEqual({ ok: true });
    const options = [
      { id: "A7-31/1", label: "1 Add it" },
      { id: "A7-31/2", label: "2 No thanks" },
    ];
    expect(optionsNamedIn("b)", options)).toEqual(["A7-31/2"]);
    expect(reparse("choice", "A7-31/2", "no thanks", { ...context, options })).toEqual({ ok: true });
    expect(reparse("choice", "A7-31/1", "2", { ...context, options })).toEqual({ ok: false, why: "differs" });
  });

  it("time: the instant must be one the words can mean in the value's zone, a zone the visit allows", () => {
    const at = (utc: string, zone = NEW_YORK) => ({ utc, zone });
    expect(reparse("time", at("2026-10-29T18:00:00Z"), "Thu at 2pm", context)).toEqual({ ok: true });
    expect(reparse("time", at("2026-10-29T19:00:00Z"), "Thu at 2pm", context)).toEqual({
      ok: false,
      why: "differs",
    });
    expect(reparse("time", at("2026-10-29T21:00:00Z", LOS_ANGELES), "Thu at 2pm", context)).toEqual({
      ok: false,
      why: "wrongZone",
    });
    expect(
      reparse("time", at("2026-10-29T21:00:00Z", LOS_ANGELES), "Thu at 2pm", {
        ...context,
        zones: [NEW_YORK, LOS_ANGELES],
      }),
    ).toEqual({ ok: true });
    expect(reparse("time", at("2026-10-29T18:00:00Z"), "Thu at 2pm", { ...context, zones: [] })).toEqual({
      ok: false,
      why: "noZone",
    });
    expect(reparse("time", at("2026-10-29T18:00:00Z"), "the usual", context)).toEqual({
      ok: false,
      why: "noValue",
    });
    expect(reparse("time", at("not a time"), "Thu at 2pm", context)).toEqual({
      ok: false,
      why: "unreadable",
    });
  });
});

// ---- round 3 (DL-189): fold first, and the whole value phrase --------------------------------------------------------

const ZERO_WIDTH_SPACE = "​";
const SOFT_HYPHEN = "­";
const WORD_JOINER = "⁠";

describe("fold first: word edges are judged on the folded text the readers read (DL-189 item 1)", () => {
  it("the readers' fold takes out what shows nothing and reads every apostrophe as one", () => {
    expect(foldWords(`raise haircut to 1${ZERO_WIDTH_SPACE}40`)).toBe("raise haircut to 140");
    expect(foldWords(`1${SOFT_HYPHEN}40`)).toBe("140");
    expect(foldWords(`1${WORD_JOINER}40`)).toBe("140");
    expect(foldWords("I can´t make it")).toBe("i can't make it");
    expect(foldWords("$1，200 at 10：30")).toBe("$1,200 at 10:30");
    expect(cents(`raise haircut to 1${ZERO_WIDTH_SPACE}40`)).toEqual([14000]);
  });

  it.each([
    ["raise haircut to $1，200", "$1", "$1，200"],
    ["can you move me to tomorrow at 10：30", "tomorrow at 10", "tomorrow at 10：30"],
    ["$12．50 a foot", "$12", "$12．50"],
    ["table for 9：30 tomorrow", "9", "9：30"],
    ["raise haircut to $1﹐200", "$1", "$1﹐200"],
    ["at 10﹕30", "at 10", "at 10﹕30"],
    ["on 10／24", "10", "10／24"],
    ["tile is $12－15 a foot", "$12", "$12－15"],
    ["BLOCK Thu 2〜5", "Thu 2", "Thu 2〜5"],
    ["2−5pm", "2", "2−5pm"],
  ])(
    "a compatibility form is its mark: in '%s', '%s' is cut out and not found; '%s' is",
    (text, cut, whole) => {
      expect(text.includes(cut)).toBe(true);
      expect(foundAtWordEdges(text, cut)).toBe(false);
      expect(foundAtWordEdges(text, whole)).toBe(true);
    },
  );

  it.each([
    ["I can´t make it", "I can", "I can´t"],
    ["I can`t make it", "I can", "I can`t"],
    ["I can‛t make it", "I can", "I can‛t"],
    ["I can′t make it", "I can", "I can′t"],
    ["I can＇t make it", "I can", "I can＇t"],
    ["twenty－five people", "twenty", "twenty－five"],
  ])(
    "every mark read as an apostrophe or a dash joins words: in '%s', '%s' is not found; '%s' is",
    (text, cut, whole) => {
      expect(foundAtWordEdges(text, cut)).toBe(false);
      expect(foundAtWordEdges(text, whole)).toBe(true);
    },
  );

  it.each([
    [`raise haircut to 1${ZERO_WIDTH_SPACE}40`, "40"],
    [`raise haircut to 1${SOFT_HYPHEN}40`, "40"],
    [`raise haircut to 1${WORD_JOINER}40`, "40"],
    ["raise haircut to 1﻿40", "40"],
    [`raise haircut to 1${ZERO_WIDTH_SPACE}40`, "1"],
  ])("what shows nothing is taken out first: in %j, '%s' is cut out of 140", (text, cut) => {
    expect(text.includes(cut)).toBe(true);
    expect(foundAtWordEdges(text, cut)).toBe(false);
  });

  it("the whole number is found, with or without the character that shows nothing", () => {
    const text = `raise haircut to 1${ZERO_WIDTH_SPACE}40`;
    expect(foundAtWordEdges(text, `1${ZERO_WIDTH_SPACE}40`)).toBe(true);
    expect(foundAtWordEdges(text, "140")).toBe(true);
    expect(foundAtWordEdges(text, ZERO_WIDTH_SPACE)).toBe(false);
  });

  it.each([
    ["no.reply@example.com", "no"],
    ["no.reply@example.com", "reply"],
    ["no.reply@example.com", "example"],
    ["no.reply@example.com", "com"],
    ["ok,yes", "ok"],
    ["ok,yes", "yes"],
    ["see you at 3.Thanks", "see you at 3"],
  ])(
    "a . , : or / with a letter or digit right after it is no word edge: in '%s', '%s' is not found",
    (text, cut) => {
      expect(foundAtWordEdges(text, cut)).toBe(false);
    },
  );

  it.each([
    ["no.reply@example.com", "no.reply@example.com"],
    ["well...yes", "yes"],
    ["yes. 3pm works", "yes"],
    ["yes, 3pm works", "3pm works"],
    ["see you at 3. Thanks", "see you at 3"],
  ])("a mark with a space or nothing after it is an edge: in '%s', '%s' is found", (text, whole) => {
    expect(foundAtWordEdges(text, whole)).toBe(true);
  });
});

describe("the readers' own phrase words: quarter to, half past, y media (DL-189 item 2)", () => {
  // Sat Oct 31 2026 at 10:00am EDT: tomorrow is Sun Nov 1, after the clocks fall back (EST).
  const SATURDAY = "2026-10-31T14:00:00Z";

  it.each([
    ["quarter to 3 tomorrow", ["2026-11-01T07:45:00Z", "2026-11-01T19:45:00Z"]],
    ["a quarter to 3pm tomorrow", ["2026-11-01T19:45:00Z"]],
    ["quarter past 3pm tomorrow", ["2026-11-01T20:15:00Z"]],
    ["tomorrow at half past three in the afternoon", ["2026-11-01T20:30:00Z"]],
    ["tomorrow at quarter to 1pm", ["2026-11-01T17:45:00Z"]],
    ["tomorrow at quarter to 12pm", ["2026-11-01T16:45:00Z"]],
  ])("'%s' reads as %j in New York", (words, expected) => {
    expect(readings(words, SATURDAY, NEW_YORK)).toEqual(expected);
  });

  it.each([
    ["mañana a las 3 y media", ["2026-11-01T08:30:00Z", "2026-11-01T20:30:00Z"]],
    ["mañana a las tres y cuarto de la tarde", ["2026-11-01T20:15:00Z"]],
    ["mañana a las 4 menos cuarto de la tarde", ["2026-11-01T20:45:00Z"]],
  ])("Spanish '%s' reads as %j in New York", (words, expected) => {
    expect(readings(words, SATURDAY, NEW_YORK, ["es"])).toEqual(expected);
  });
});

describe("a zone the time's own words name is the zone it is in (DL-189 item 2)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] };
  const at = (utc: string, zone = NEW_YORK) => ({ utc, zone });

  it("'tomorrow at 3pm PST' for a New York visit is the wrong zone, whichever instant is given", () => {
    const pst = "tomorrow at 3pm PST";
    expect(reparse("time", at("2026-11-01T20:00:00Z"), pst, context)).toEqual({
      ok: false,
      why: "wrongZone",
    });
    expect(reparse("time", at("2026-11-01T23:00:00Z"), pst, context)).toEqual({
      ok: false,
      why: "wrongZone",
    });
    expect(reparse("time", at("2026-11-01T20:00:00Z"), "tomorrow at 3pm EST", context)).toEqual({ ok: true });
    expect(reparse("time", at("2026-11-01T20:00:00Z"), "tomorrow at 3pm (Eastern time)", context)).toEqual({
      ok: true,
    });
  });

  it("for a visit that shows Los Angeles too, 3pm Pacific passes only in Los Angeles' zone", () => {
    const both: ReparseContext = { ...context, zones: [NEW_YORK, LOS_ANGELES] };
    const pst = "tomorrow at 3pm PST";
    expect(reparse("time", at("2026-11-01T23:00:00Z", LOS_ANGELES), pst, both)).toEqual({ ok: true });
    expect(reparse("time", at("2026-11-01T23:00:00Z"), pst, both)).toEqual({ ok: false, why: "wrongZone" });
  });

  it("a zone word away from the time names no zone for it ('PT session')", () => {
    expect(reparse("time", at("2026-11-01T20:00:00Z"), "PT session, tomorrow at 3pm", context)).toEqual({
      ok: true,
    });
  });
});

describe("a number's value is re-read from its whole value phrase (DL-189 item 2)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] };
  const at = (utc: string) => ({ utc, zone: NEW_YORK });
  const usd = (amount: number) => ({ cents: amount, currency: "USD" });
  const THREE_PM = at("2026-11-01T20:00:00Z");
  // [case, the field's type, the value, the person's text, the words cited, the fault or null]
  const cases: [string, FieldType, FieldValue, string, string, string | null][] = [
    ["'40' out of '40%'", "money", usd(4000), "raise haircut to 40%", "40", "noText"],
    ["'40' out of '40 per cent'", "money", usd(4000), "raise haircut 40 per cent", "40", "noText"],
    ["'40' out of '40¢'", "money", usd(4000), "raise haircut to 40¢", "40", "differs"],
    ["the whole '40¢' is 40 cents", "money", usd(40), "raise haircut to 40¢", "40¢", null],
    ["the whole '$40/hr' is $40 an hour", "money", usd(4000), "handyman is $40/hr now", "$40/hr", null],
    // Round 4 (DL-199 item 2): the reader reads scale words, so these two give another value (differs), not noText.
    ["'$2k', whose k is read: $2,000, not $2", "money", usd(200), "raise it to $2k", "$2k", "differs"],
    ["'$40' out of '$40 thousand'", "money", usd(4000), "raise it to $40 thousand", "$40", "differs"],
    ["'$12' out of '$12 to 15'", "money", usd(1200), "tile is $12 to 15 a foot", "$12", "several"],
    [
      "K-02's '$12 a foot', whole",
      "money",
      usd(1200),
      "block thursday afternoon and also tile is $12 a foot from now on",
      "$12 a foot",
      null,
    ],
    ["'$12 dollars', whole", "money", usd(1200), "tile is $12 dollars a foot", "$12 dollars", null],
    ["'$1' out of '$1 200', thousands spaced", "money", usd(100), "raise haircut to $1 200", "$1", "noText"],
    [
      "'200' out of '$1 200', thousands spaced",
      "money",
      usd(20000),
      "raise haircut to $1 200",
      "200",
      "differs",
    ],
    // Round 4 (DL-199 item 2): the count reader reads a dozen, so the whole is 24 (differs), not noText.
    ["'2' out of '2 dozen'", "integer", 2, "2 dozen cupcakes", "2", "differs"],
    [
      "'35 dólares' out of '35 dólares y 50 centavos'",
      "money",
      usd(3500),
      "35 dólares y 50 centavos",
      "35 dólares",
      "several",
    ],
    [
      "'12 dollars' out of '12 dollars and 50 cents'",
      "money",
      usd(1200),
      "12 dollars and 50 cents",
      "12 dollars",
      "several",
    ],
    [
      "'3pm' out of '3pm tomorrow', as today's 3pm",
      "time",
      at("2026-10-31T19:00:00Z"),
      "can you do 3pm tomorrow",
      "3pm",
      "differs",
    ],
    [
      "'3pm' out of 'tomorrow at 3pm', as today's",
      "time",
      at("2026-10-31T19:00:00Z"),
      "tomorrow at 3pm works",
      "3pm",
      "differs",
    ],
    [
      "'tomorrow at 12' out of 'tomorrow at 12 midnight'",
      "time",
      at("2026-11-01T17:00:00Z"),
      "tomorrow at 12 midnight",
      "tomorrow at 12",
      "several",
    ],
    [
      "'3pm today' out of '3pm today or tomorrow'",
      "time",
      at("2026-10-31T19:00:00Z"),
      "3pm today or tomorrow",
      "3pm today",
      "several",
    ],
    [
      "'forty' out of 'a hundred and forty'",
      "integer",
      40,
      "a table for a hundred and forty",
      "forty",
      "differs",
    ],
    ["'twenty' out of 'twenty five'", "integer", 20, "twenty five people", "twenty", "differs"],
    ["'6 people' out of '4 to 6 people'", "integer", 6, "4 to 6 people", "6 people", "several"],
    ["'9' out of '9 pm'", "integer", 9, "table at 9 pm", "9", "noText"],
    [
      "'3 tomorrow' out of 'quarter to 3 tomorrow'",
      "time",
      THREE_PM,
      "quarter to 3 tomorrow",
      "3 tomorrow",
      "differs",
    ],
    [
      "the whole 'quarter to 3 tomorrow' is 2:45",
      "time",
      at("2026-11-01T19:45:00Z"),
      "quarter to 3 tomorrow",
      "quarter to 3 tomorrow",
      null,
    ],
    [
      "'tomorrow at 3' out of 'tomorrow at 3 pm', as 3am",
      "time",
      at("2026-11-01T08:00:00Z"),
      "tomorrow at 3 pm",
      "tomorrow at 3",
      "differs",
    ],
    [
      "'tomorrow at three' out of '... three thirty'",
      "time",
      THREE_PM,
      "tomorrow at three thirty",
      "tomorrow at three",
      "noText",
    ],
    [
      "'tomorrow at 3' out of 'tomorrow at 3 30'",
      "time",
      THREE_PM,
      "tomorrow at 3 30",
      "tomorrow at 3",
      "noText",
    ],
    [
      "'3 tomorrow' out of 'twenty to 3 tomorrow'",
      "time",
      THREE_PM,
      "twenty to 3 tomorrow",
      "3 tomorrow",
      "noText",
    ],
    [
      "'tomorrow at 3pm' out of '... 3pm or 4pm'",
      "time",
      THREE_PM,
      "tomorrow at 3pm or 4pm",
      "tomorrow at 3pm",
      "several",
    ],
    [
      "'tomorrow at 3pm' out of '... 3pm PST'",
      "time",
      THREE_PM,
      "tomorrow at 3pm PST",
      "tomorrow at 3pm",
      "wrongZone",
    ],
    [
      "'tomorrow at 3' with nothing more beside it",
      "time",
      THREE_PM,
      "can we do tomorrow at 3 instead",
      "tomorrow at 3",
      null,
    ],
  ];

  it.each(cases)("%s", (_case, type, value, text, words, expected) => {
    expect(text.includes(words)).toBe(true);
    expect(wholePhraseFault(type, value, text, words, context)).toBe(expected);
  });

  it("Spanish: 'mañana a las 3' out of 'mañana a las 3 y media' differs; the whole is 3:30", () => {
    const spanish: ReparseContext = { ...context, languages: ["es"] };
    const text = "¿me puede cambiar a mañana a las 3 y media?";
    expect(wholePhraseFault("time", THREE_PM, text, "mañana a las 3", spanish)).toBe("differs");
    expect(
      wholePhraseFault("time", at("2026-11-01T20:30:00Z"), text, "mañana a las 3 y media", spanish),
    ).toBeNull();
  });

  it("types not written as numbers have no value phrase; words standing nowhere whole are noText", () => {
    expect(wholePhraseFault("text", "haircut", "raise haircut to 40%", "haircut", context)).toBeNull();
    expect(wholePhraseFault("money", usd(4000), "raise haircut to 140", "40", context)).toBe("noText");
  });
});

// ---- round 4 (DL-199): the readers define the phrase -----------------------------------------------------------------

describe("the readers read an amount whole: currency, scale, per-unit and range (DL-199 item 2)", () => {
  const money = (words: string, languages?: readonly ("en" | "es")[]) =>
    amountsIn(words, languages).map((amount) => amount.money);

  it.each([
    ["40 euros", [{ cents: 4000, currency: "EUR" }]],
    ["40 pesos", [{ cents: 4000, currency: "MXN" }]],
    ["€40", [{ cents: 4000, currency: "EUR" }]],
    ["£40", [{ cents: 4000, currency: "GBP" }]],
    ["₿40", [{ cents: 4000, currency: "XXX" }]],
    ["40 canadian dollars", [{ cents: 4000, currency: "CAD" }]],
    ["$40 pesos", [{ cents: 4000, currency: "MXN" }]],
    ["$1 million", [{ cents: 100_000_000, currency: "USD" }]],
    ["$2k", [{ cents: 200_000, currency: "USD" }]],
    ["$1.5k", [{ cents: 150_000, currency: "USD" }]],
    ["$40 thousand", [{ cents: 4_000_000, currency: "USD" }]],
    ["2 grand", [{ cents: 200_000, currency: "USD" }]],
    ["two million dollars", [{ cents: 200_000_000, currency: "USD" }]],
    [
      "$12～15 a foot",
      [
        { cents: 1200, currency: "USD" },
        { cents: 1500, currency: "USD" },
      ],
    ],
    [
      "$12 or 15",
      [
        { cents: 1200, currency: "USD" },
        { cents: 1500, currency: "USD" },
      ],
    ],
  ] as const)("'%s' reads as %j", (words, expected) => {
    expect(money(words)).toEqual(expected);
  });

  it("Spanish scale and currency words: '2 mil pesos' is 2,000 pesos, '40 euros' is in euros", () => {
    expect(money("2 mil pesos", ["es"])).toEqual([{ cents: 200_000, currency: "MXN" }]);
    expect(money("40 euros", ["es"])).toEqual([{ cents: 4000, currency: "EUR" }]);
    expect(money("40 quetzales", ["es"])).toEqual([{ cents: 4000, currency: "GTQ" }]);
  });

  it("more scale and currency words: '40 quid', '$1 billion', and 'mil' as a million in an English text", () => {
    expect(money("40 quid")).toEqual([{ cents: 4000, currency: "GBP" }]);
    expect(money("$1 billion")).toEqual([{ cents: 100_000_000_000, currency: "USD" }]);
    expect(money("$2 mil", ["en"])).toEqual([{ cents: 200_000_000, currency: "USD" }]);
    expect(money("$2 mil", ["es"])).toEqual([{ cents: 200_000, currency: "USD" }]);
  });

  it("an amount's span holds its per-unit, which is no part of its value: '$40/hr', '$12 a foot', '$35 each'", () => {
    for (const [words, end] of [
      ["$40/hr", 6],
      ["$12 a foot", 10],
      ["$35 each", 8],
      ["40 dolares la hora", 18],
    ] as const) {
      const [amount] = amountsIn(words);
      expect(amount?.at).toBe(0);
      expect(amount?.end).toBe(end);
    }
    expect(money("40 per cent")).toEqual([]);
  });
});

describe("the count reader reads a dozen (DL-199 item 2)", () => {
  it.each([
    ["2 dozen cupcakes", [24]],
    ["a dozen roses", [12]],
    ["half a dozen", [6]],
    ["one dozen", [12]],
  ] as const)("'%s' holds %j", (words, expected) => {
    expect(countsIn(words)).toEqual(expected);
  });

  it.each([
    ["dos docenas", [24]],
    ["una docena", [12]],
    ["media docena", [6]],
  ] as const)("Spanish '%s' holds %j", (words, expected) => {
    expect(countsIn(words, ["es"])).toEqual(expected);
  });
});

describe("an underscore and the fullwidth range mark join words (DL-199 item 2, N3 and N4)", () => {
  it.each([
    ["no_reply@example.com", "no", "no_reply@example.com"],
    ["raise it to $40_000", "$40", "$40_000"],
    ["can you do 3～5pm", "5pm", "3～5pm"],
    ["can you do 3～5pm", "3", "3～5pm"],
    ["tile is $12～15 a foot", "$12", "$12～15"],
  ])("in '%s', '%s' is not found; '%s' is", (text, cut, whole) => {
    expect(text.includes(cut)).toBe(true);
    expect(foundAtWordEdges(text, cut)).toBe(false);
    expect(foundAtWordEdges(text, whole)).toBe(true);
  });

  it("the time reader reads '3～5pm' as a range, two times, never one", () => {
    expect(foldWords("3～5pm")).toBe("3-5pm");
    expect(readTimeWords("3～5pm").kind).toBe("several");
  });
});

describe("the zone reader reads a zone after a comma (DL-199 item 2)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] };
  const at = (utc: string, zone = NEW_YORK) => ({ utc, zone });

  it("'tomorrow at 3pm, PST' is 3pm Pacific: the wrong zone for New York, right for Los Angeles", () => {
    const words = "tomorrow at 3pm, PST";
    expect(reparse("time", at("2026-11-01T20:00:00Z"), words, context)).toEqual({
      ok: false,
      why: "wrongZone",
    });
    expect(
      reparse("time", at("2026-11-01T23:00:00Z", LOS_ANGELES), words, { ...context, zones: [LOS_ANGELES] }),
    ).toEqual({ ok: true });
    expect(reparse("time", at("2026-11-01T20:00:00Z"), "PST, tomorrow at 3pm", context)).toEqual({
      ok: false,
      why: "wrongZone",
    });
  });
});

describe("the whole phrase is the readers' own: G1 to G10 and N1 to N3 of the round 3 review (DL-199)", () => {
  const SATURDAY = "2026-10-31T14:00:00Z"; // Sat Oct 31 2026, 10:00am in New York (EDT)
  const FRIDAY = "2026-10-30T14:00:00Z"; // Fri Oct 30 2026, 10:00am in New York (EDT)
  const at = (utc: string) => ({ utc, zone: NEW_YORK });
  const usd = (amount: number) => ({ cents: amount, currency: "USD" });
  interface Given {
    readonly languages?: readonly ("en" | "es")[];
    readonly sentAt?: string;
  }
  const es: Given = { languages: ["es"] };
  // [case, the field's type, the value, the person's text, the words cited, the fault or null, the reading's context]
  const cases: [string, FieldType, FieldValue, string, string, string | null, Given][] = [
    [
      "G1: 'tomorrow at 3pm' out of 'the day after tomorrow at 3pm'",
      "time",
      at("2026-11-01T20:00:00Z"),
      "can you move me to the day after tomorrow at 3pm",
      "tomorrow at 3pm",
      "differs",
      {},
    ],
    [
      "G1 whole: the day after tomorrow at 3pm is Mon Nov 2 at 3pm",
      "time",
      at("2026-11-02T20:00:00Z"),
      "can you move me to the day after tomorrow at 3pm",
      "the day after tomorrow at 3pm",
      null,
      {},
    ],
    [
      "G2: 'mañana a las 3' out of 'pasado mañana a las 3'",
      "time",
      at("2026-11-01T20:00:00Z"),
      "¿me puede cambiar a pasado mañana a las 3?",
      "mañana a las 3",
      "differs",
      es,
    ],
    [
      "G2 whole: pasado mañana a las 3 is Mon Nov 2",
      "time",
      at("2026-11-02T20:00:00Z"),
      "¿me puede cambiar a pasado mañana a las 3?",
      "pasado mañana a las 3",
      null,
      es,
    ],
    [
      "G3: 'at 3' out of 'tomorrow afternoon at 3', as today's 3pm",
      "time",
      at("2026-10-31T19:00:00Z"),
      "can you do tomorrow afternoon at 3",
      "at 3",
      "differs",
      {},
    ],
    [
      "G3 whole: tomorrow afternoon at 3 is Sun Nov 1 at 3pm",
      "time",
      at("2026-11-01T20:00:00Z"),
      "can you do tomorrow afternoon at 3",
      "tomorrow afternoon at 3",
      null,
      {},
    ],
    [
      "G4: 'a las 3' out of 'mañana en la tarde a las 3'",
      "time",
      at("2026-10-31T19:00:00Z"),
      "mañana en la tarde a las 3",
      "a las 3",
      "differs",
      es,
    ],
    [
      "G4 whole: Sun Nov 1 at 3pm",
      "time",
      at("2026-11-01T20:00:00Z"),
      "mañana en la tarde a las 3",
      "mañana en la tarde a las 3",
      null,
      es,
    ],
    [
      "G5: 'at 9' out of 'tomorrow night at 9', as tonight's 9pm",
      "time",
      at("2026-11-01T01:00:00Z"),
      "tomorrow night at 9 works",
      "at 9",
      "differs",
      {},
    ],
    [
      "G5 whole: Sun Nov 1 at 9pm",
      "time",
      at("2026-11-02T02:00:00Z"),
      "tomorrow night at 9 works",
      "tomorrow night at 9",
      null,
      {},
    ],
    [
      "G6: 'tomorrow' (its start) out of 'tomorrow at noon'",
      "time",
      at("2026-11-01T04:00:00Z"),
      "can you do tomorrow at noon",
      "tomorrow",
      "differs",
      {},
    ],
    [
      "G6 whole: Sun Nov 1 at noon",
      "time",
      at("2026-11-01T17:00:00Z"),
      "can you do tomorrow at noon",
      "tomorrow at noon",
      null,
      {},
    ],
    [
      "G7: 'mañana' (its start) out of 'mañana al mediodía'",
      "time",
      at("2026-11-01T04:00:00Z"),
      "mañana al mediodía",
      "mañana",
      "differs",
      es,
    ],
    [
      "G7 whole: Sun Nov 1 at noon",
      "time",
      at("2026-11-01T17:00:00Z"),
      "mañana al mediodía",
      "mañana al mediodía",
      null,
      es,
    ],
    [
      "G8: 'tomorrow' (its start) out of 'tomorrow, 3pm'",
      "time",
      at("2026-11-01T04:00:00Z"),
      "tomorrow, 3pm",
      "tomorrow",
      "differs",
      {},
    ],
    [
      "G8 whole: Sun Nov 1 at 3pm",
      "time",
      at("2026-11-01T20:00:00Z"),
      "tomorrow, 3pm",
      "tomorrow, 3pm",
      null,
      {},
    ],
    [
      "G9: 'tomorrow at 3pm' out of 'tomorrow at 3pm, PST' for a New York visit",
      "time",
      at("2026-11-01T20:00:00Z"),
      "tomorrow at 3pm, PST",
      "tomorrow at 3pm",
      "wrongZone",
      {},
    ],
    [
      "G9 whole, read for a New York visit, is the wrong zone too",
      "time",
      at("2026-11-01T20:00:00Z"),
      "tomorrow at 3pm, PST",
      "tomorrow at 3pm, PST",
      "wrongZone",
      {},
    ],
    [
      "G10: 'Friday at 3' out of 'next Friday at 3', sent Fri Oct 30",
      "time",
      at("2026-10-30T19:00:00Z"),
      "can you do next Friday at 3",
      "Friday at 3",
      "differs",
      { sentAt: FRIDAY },
    ],
    [
      "G10 whole: next Friday at 3 is Fri Nov 6 at 3pm",
      "time",
      at("2026-11-06T20:00:00Z"),
      "can you do next Friday at 3",
      "next Friday at 3",
      null,
      { sentAt: FRIDAY },
    ],
    ["N1: '40' out of '40 euros'", "money", usd(4000), "raise haircut to 40 euros", "40", "differs", {}],
    [
      "N1 whole: 40 euros",
      "money",
      { cents: 4000, currency: "EUR" },
      "raise haircut to 40 euros",
      "40 euros",
      null,
      {},
    ],
    ["N1: '40' out of '40 pesos'", "money", usd(4000), "raise haircut to 40 pesos", "40", "differs", {}],
    [
      "N1 whole: 40 pesos",
      "money",
      { cents: 4000, currency: "MXN" },
      "raise haircut to 40 pesos",
      "40 pesos",
      null,
      {},
    ],
    ["N2: '$1' out of '$1 million'", "money", usd(100), "the budget is $1 million", "$1", "differs", {}],
    ["N2 whole: $1 million", "money", usd(100_000_000), "the budget is $1 million", "$1 million", null, {}],
    ["N3: '$12' out of '$12～15'", "money", usd(1200), "tile is $12～15 a foot", "$12", "noText", {}],
    [
      "N3 whole: '$12～15' is a range, several",
      "money",
      usd(1200),
      "tile is $12～15 a foot",
      "$12～15",
      "several",
      {},
    ],
    [
      "N3: '5pm' out of '3～5pm'",
      "time",
      at("2026-10-31T21:00:00Z"),
      "can you do 3～5pm",
      "5pm",
      "noText",
      {},
    ],
    [
      "N3 whole: '3～5pm' is a range, several",
      "time",
      at("2026-10-31T21:00:00Z"),
      "can you do 3～5pm",
      "3～5pm",
      "several",
      {},
    ],
  ];

  it.each(cases)("%s", (_case, type, value, text, words, expected, given) => {
    const context: ReparseContext = {
      sentAt: given.sentAt ?? SATURDAY,
      zones: [NEW_YORK],
      ...(given.languages === undefined ? {} : { languages: given.languages }),
    };
    expect(text.includes(words)).toBe(true);
    expect(wholePhraseFault(type, value, text, words, context)).toBe(expected);
  });

  it("G9 whole passes for a Los Angeles visit: 3pm Pacific, read in its zone", () => {
    const context: ReparseContext = { sentAt: SATURDAY, zones: [LOS_ANGELES] };
    const value = { utc: "2026-11-01T23:00:00Z", zone: LOS_ANGELES };
    expect(
      wholePhraseFault("time", value, "tomorrow at 3pm, PST", "tomorrow at 3pm, PST", context),
    ).toBeNull();
    expect(wholePhraseFault("time", value, "tomorrow at 3pm, PST", "tomorrow at 3pm", context)).toBeNull();
  });
});

describe("what joins a phrase, and what does not (DL-199 items 1 and 3)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] };
  const at = (utc: string) => ({ utc, zone: NEW_YORK });
  const usd = (amount: number) => ({ cents: amount, currency: "USD" });

  it("a count before a day is no part of its time: 'tomorrow at 3pm' of 'table for 2 tomorrow at 3pm' passes", () => {
    const text = "table for 2 tomorrow at 3pm";
    expect(wholePhraseFault("time", at("2026-11-01T20:00:00Z"), text, "tomorrow at 3pm", context)).toBeNull();
    expect(wholePhraseFault("integer", 2, text, "2", context)).toBeNull();
  });

  it("a number a range word joins to an amount is part of it: '$15' of '10 - $15' leaves 10 unread", () => {
    expect(wholePhraseFault("money", usd(1500), "it was 10 - $15 a foot", "$15", context)).toBe("noText");
    expect(wholePhraseFault("money", usd(1200), "tile is $12 or 15 a foot", "$12", context)).toBe("several");
  });

  it("a count is read with its unit, and counts a range, choice or hedge joins are several", () => {
    expect(wholePhraseFault("integer", 2, "2 adults and 1 child", "2 adults", context)).toBe("several");
    expect(wholePhraseFault("integer", 4, "party of 4, maybe 5", "4", context)).toBe("several");
    expect(
      wholePhraseFault("integer", 12, "can you fit 12 people tomorrow", "12 people", context),
    ).toBeNull();
  });

  it("words that touch two phrases are several; a bare number apart from a marked amount is none of it", () => {
    const text = "$40 deposit, $100 after the visit";
    expect(wholePhraseFault("money", usd(4000), text, "$40 deposit, $100", context)).toBe("several");
    expect(wholePhraseFault("money", usd(4000), text, "$40", context)).toBeNull();
    expect(wholePhraseFault("money", usd(200), "$35 for 2", "2", context)).toBe("noText");
  });

  it("a day and its time joined by the readers' cues are one phrase: the day alone differs", () => {
    const sunday3pm = at("2026-11-01T20:00:00Z");
    for (const text of [
      "tomorrow at around 3pm",
      "tomorrow, say 3pm",
      "tomorrow by 3pm",
      "tomorrow · 3pm",
      "tomorrow at 3 in the afternoon",
    ]) {
      expect(wholePhraseFault("time", sunday3pm, text, text, context)).toBeNull();
      expect(wholePhraseFault("time", at("2026-11-01T04:00:00Z"), text, "tomorrow", context)).toBe("differs");
    }
  });
});

// ---- round 5 (DL-209): a bare hour beside a day joins its phrase whatever other time the text holds -------------------

describe("a bare hour beside a day joins the day's phrase whatever other time the text holds: H1 to H3 (DL-209)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] }; // Sat Oct 31, 10:00am EDT
  const spanish: ReparseContext = { ...context, languages: ["es"] };
  const at = (utc: string) => ({ utc, zone: NEW_YORK });
  const H1 = "my 2pm doesn't work. can we do Thursday, 3?";
  const H2 = "can't make my 2pm, 3 tomorrow?";
  const H3 = "a las 2 no puedo. ¿el jueves, 3?";
  const THURSDAY = at("2026-11-05T05:00:00Z"); // Thu Nov 5 at its start (EST)
  const SUNDAY = at("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start (still EDT)

  it("the reading takes no bare hour when the text names another time; bareHours gives the hour beside the day anyway", () => {
    const reading = timeReadingOf(H1);
    expect(reading.read.kind).toBe("time");
    const hour = foldWords(H1).indexOf("3?");
    expect(reading.bareHours).toEqual([{ at: hour, end: hour + 1 }]);
    expect(reading.spans.some((span) => span.at === hour)).toBe(false);
    expect(readings("Thursday, 3", context.sentAt, NEW_YORK)).toEqual([
      "2026-11-05T08:00:00Z",
      "2026-11-05T20:00:00Z",
    ]);
  });

  it.each([
    ["H1: 'Thursday' out of '... Thursday, 3?'", H1, "Thursday", THURSDAY, context],
    ["H2: 'tomorrow' out of '... 3 tomorrow?'", H2, "tomorrow", SUNDAY, context],
    ["H3: 'el jueves' out of '... ¿el jueves, 3?'", H3, "el jueves", THURSDAY, spanish],
  ] as const)(
    "%s, read at its start, differs: the hour is part of the day's phrase",
    (_case, text, words, value, given) => {
      expect(reparse("time", value, words, given)).toEqual({ ok: true });
      expect(wholePhraseFault("time", value, text, words, given)).toBe("differs");
    },
  );

  it("the whole 'Thursday, 3' and 'el jueves, 3' pass as 3pm or 3am (CQ-119's default: either reading passes)", () => {
    for (const utc of ["2026-11-05T20:00:00Z", "2026-11-05T08:00:00Z"]) {
      expect(wholePhraseFault("time", at(utc), H1, "Thursday, 3", context)).toBeNull();
      expect(wholePhraseFault("time", at(utc), H3, "el jueves, 3", spanish)).toBeNull();
    }
    expect(wholePhraseFault("time", at("2026-11-05T21:00:00Z"), H1, "Thursday, 3", context)).toBe("differs");
  });

  it("in H2 the hour joins '2pm' by its comma too (DL-199's join), so '3 tomorrow' is refused as well: never a pass", () => {
    expect(wholePhraseFault("time", at("2026-11-01T20:00:00Z"), H2, "3 tomorrow", context)).toBe("differs");
    expect(wholePhraseFault("time", at("2026-10-31T18:00:00Z"), H2, "2pm", context)).toBe("differs");
    expect(
      wholePhraseFault("time", at("2026-11-01T20:00:00Z"), "can we do 3 tomorrow?", "3 tomorrow", context),
    ).toBeNull();
  });

  it("an hour before the day, after a comma, or with the other time first: each cut of the day differs", () => {
    for (const text of [
      "2pm is out. 3 tomorrow?",
      "2pm is out. tomorrow, 3?",
      "2pm is out. tomorrow 3?",
      "tomorrow, 3? my 2pm is out",
      "3, tomorrow? 2pm is out",
    ]) {
      expect(wholePhraseFault("time", SUNDAY, text, "tomorrow", context)).toBe("differs");
    }
  });

  it("an hour beside a day whose phrase names its own time of day stays out of it: 'table for 2 tomorrow at 3pm'", () => {
    const text = "table for 2 tomorrow at 3pm, my 11am is out";
    expect(wholePhraseFault("time", at("2026-11-01T20:00:00Z"), text, "tomorrow at 3pm", context)).toBeNull();
    expect(wholePhraseFault("time", SUNDAY, text, "tomorrow", context)).toBe("differs");
  });
});

describe("the readers learn a bare hour after a part-of-day word (DL-209, the round 4 review's N2)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] };
  const at = (utc: string) => ({ utc, zone: NEW_YORK });
  const SUNDAY = at("2026-11-01T04:00:00Z");

  it.each([
    ["tomorrow morning, 9", ["2026-11-01T14:00:00Z"]],
    ["tomorrow morning 9", ["2026-11-01T14:00:00Z"]],
    ["tomorrow afternoon, 3", ["2026-11-01T20:00:00Z"]],
    ["tomorrow evening at 7", ["2026-11-02T00:00:00Z"]],
    ["tomorrow night, 9", ["2026-11-02T02:00:00Z"]],
  ] as const)("'%s' reads with its part of the day: %j", (words, expected) => {
    expect(readings(words, context.sentAt, NEW_YORK)).toEqual(expected);
  });

  it("Spanish: 'mañana por la tarde, 3' is Sun Nov 1 at 3pm; 'mañana por la mañana, 9' at 9am", () => {
    expect(readings("mañana por la tarde, 3", context.sentAt, NEW_YORK, ["es"])).toEqual([
      "2026-11-01T20:00:00Z",
    ]);
    expect(readings("mañana por la mañana, 9", context.sentAt, NEW_YORK, ["es"])).toEqual([
      "2026-11-01T14:00:00Z",
    ]);
  });

  it.each([
    ["can you do tomorrow morning, 9", "tomorrow morning", "tomorrow morning, 9", "2026-11-01T14:00:00Z"],
    ["can you do tomorrow evening at 7", "tomorrow evening", "tomorrow evening at 7", "2026-11-02T00:00:00Z"],
    ["tomorrow night 9 works", "tomorrow night", "tomorrow night 9", "2026-11-02T02:00:00Z"],
    [
      "my 2pm is out. tomorrow morning, 9?",
      "tomorrow morning",
      "tomorrow morning, 9",
      "2026-11-01T14:00:00Z",
    ],
  ] as const)("in '%s', '%s' alone differs; '%s' passes", (text, cut, whole, utc) => {
    expect(wholePhraseFault("time", SUNDAY, text, cut, context)).toBe("differs");
    expect(wholePhraseFault("time", at(utc), text, whole, context)).toBeNull();
  });

  it("a count after a part-of-day word that names its time stays a count: 'tomorrow afternoon at 3, 2 of us'", () => {
    const text = "tomorrow afternoon at 3, 2 of us";
    expect(readTimeWords(text).kind).toBe("time");
    expect(
      wholePhraseFault("time", at("2026-11-01T20:00:00Z"), text, "tomorrow afternoon at 3", context),
    ).toBeNull();
  });
});

describe("the money reader learns a currency code beside an amount and 'M' as million (DL-209, the round 4 review's N1)", () => {
  const context: ReparseContext = { sentAt: "2026-10-31T14:00:00Z", zones: [NEW_YORK] };
  const money = (words: string) => amountsIn(words).map((amount) => amount.money);
  const usd = (amount: number) => ({ cents: amount, currency: "USD" });

  it.each([
    ["MXN $40", [{ cents: 4000, currency: "MXN" }]],
    ["CAD$40", [{ cents: 4000, currency: "CAD" }]],
    ["usd $40", [{ cents: 4000, currency: "USD" }]],
    ["40$ CAD", [{ cents: 4000, currency: "CAD" }]],
    ["40 $ pesos", [{ cents: 4000, currency: "MXN" }]],
    ["$1M", [{ cents: 100_000_000, currency: "USD" }]],
    ["$1.5m", [{ cents: 150_000_000, currency: "USD" }]],
    ["$1MM", [{ cents: 100_000_000, currency: "USD" }]],
    ["$2B", [{ cents: 200_000_000_000, currency: "USD" }]],
    ["$3bn", [{ cents: 300_000_000_000, currency: "USD" }]],
    ["40m", [{ cents: 4_000_000_000, currency: "USD" }]],
  ] as const)("'%s' reads as %j", (words, expected) => {
    expect(money(words)).toEqual(expected);
  });

  it.each([
    ["raise haircut to MXN $40", "$40", usd(4000), "MXN $40", { cents: 4000, currency: "MXN" }],
    ["raise haircut to 40$ CAD", "40$", usd(4000), "40$ CAD", { cents: 4000, currency: "CAD" }],
  ] as const)(
    "in '%s', '%s' as dollars differs; the whole '%s' passes in its own currency",
    (text, cut, value, whole, own) => {
      expect(reparse("money", value, cut, context)).toEqual({ ok: true });
      expect(wholePhraseFault("money", value, text, cut, context)).toBe("differs");
      expect(wholePhraseFault("money", own, text, whole, context)).toBeNull();
      expect(wholePhraseFault("money", value, text, whole, context)).toBe("differs");
    },
  );

  it("'$1M' is a million: as $1 it differs, '$1' is cut out of it, and the whole passes as $1,000,000", () => {
    const text = "raise haircut to $1M";
    expect(reparse("money", usd(100), "$1M", context)).toEqual({ ok: false, why: "differs" });
    expect(wholePhraseFault("money", usd(100), text, "$1M", context)).toBe("differs");
    expect(wholePhraseFault("money", usd(100), text, "$1", context)).toBe("noText");
    expect(wholePhraseFault("money", usd(100_000_000), text, "$1M", context)).toBeNull();
  });
});
