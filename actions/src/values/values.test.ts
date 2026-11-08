// The shared value reader (T-304): amounts, counts, dates and times read from a person's words in English and Spanish,
// and the re-parse limit 6 runs on each value. Words come from the contracts' fixtures and the master's own examples
// (K-02 decide-two-requests.json's "$12 a foot"; S11-20's "raise haircut to 40"; S1-13's "A at their home too, 75";
// S11-13's "BLOCK Thu 2-5"; A3-07's "Quiero un corte el sábado"), dates in October and November 2026 as the master writes
// them (S13-03: "like on Sun Nov 1").

import { describe, expect, it } from "vitest";

import {
  amountsIn,
  countsIn,
  foundAtWordEdges,
  instantsAt,
  instantsFor,
  optionsNamedIn,
  readTimeWords,
  reparse,
  zonesNamedIn,
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
