// T-1133 (DL-259): the count reader and the time reader agree on which number is which, by one precedence rule. A
// counted party (parties.ts: a count with its unit or party lead words, and every number a range or choice word joins
// to one) is never an hour; an hour only T-1130's reach finds (an approximate word or a mark after a cue, three or four
// digits or tenths of an hour after one, a mark main did not take beside a day) is one only with its own time evidence;
// main's own reach reads as main read it, a counted party there declined. The readings T-1130 kept ('3:30', '3.5',
// '10/24', '1,200', '$3.50', 'at 1530', 'at 3.5', 'tomorrow for 2 at 7pm') keep theirs.

import { describe, expect, it } from "vitest";

import {
  amountsIn,
  countsIn,
  foldWords,
  instantsFor,
  readTimeWords,
  timeReadingOf,
  wholePhraseFault,
  type ReparseContext,
  type TimeWords,
} from "./index";
import { partiesIn } from "./parties";
import { BOTH_LANGUAGES } from "./words";

const NEW_YORK = "America/New_York";
const SENT = "2026-10-31T14:00:00Z"; // Sat Oct 31, 10:00am EDT
const context: ReparseContext = { sentAt: SENT, zones: [NEW_YORK] };

/** The words of each counted party in `words`, folded. */
function partiesOf(words: string): string[] {
  const folded = foldWords(words);
  return partiesIn(folded, BOTH_LANGUAGES).map(({ at, end }) => folded.slice(at, end));
}

/** The one time the words name; fails the test for none or several. */
function timeIn(words: string, languages?: readonly ("en" | "es")[]): TimeWords {
  const read = readTimeWords(words, languages);
  if (read.kind !== "time") throw new Error(`no one time: ${read.kind}`);
  return read.time;
}

/** Every instant the words can mean, sent at SENT in New York, as UTC strings. */
function readings(words: string, languages?: readonly ("en" | "es")[]): string[] {
  return instantsFor(timeIn(words, languages), Date.parse(SENT), NEW_YORK).map((ms) =>
    new Date(ms).toISOString().replace(".000Z", "Z"),
  );
}

/** The clock the words name, or null for none (a day alone, nothing, or several). */
function clockOf(words: string): TimeWords["clock"] {
  const read = readTimeWords(words);
  return read.kind === "time" ? read.time.clock : null;
}

/** The words of each span in `words`, folded. */
function wordsAt(words: string, spans: readonly { at: number; end: number }[]): string[] {
  const folded = foldWords(words);
  return spans.map(({ at, end }) => folded.slice(at, end));
}

describe("T-1133: a counted party is a count with its unit or party lead words, and every number a range or choice word joins to one", () => {
  it.each([
    ["4 people", ["4"]],
    ["150 guests", ["150"]],
    ["12 of us", ["12"]],
    ["two adults", ["two"]],
    ["party of 4", ["4"]],
    ["for 2", ["2"]],
    ["mesa para 4", ["4"]],
    ["for 4 to 6 people", ["4", "6"]],
    ["10, maybe 12 people", ["10", "12"]],
    ["6, maybe 8 people", ["6", "8"]],
    ["para 4 tal vez 5", ["4", "5"]],
    ["4-6 guests", ["4", "6"]],
    ["4 (or 5 people)", ["4", "5"]],
    ["for 4 or maybe 5", ["4", "5"]],
  ] as const)("in '%s' the parties are %j", (words, expected) => {
    expect(partiesOf(words)).toEqual(expected);
  });

  it("a mark alone or an adding word carries no unit, and a number with no unit or lead words, or no whole number, is none", () => {
    expect(partiesOf("at 3, 4 people")).toEqual(["4"]);
    expect(partiesOf("at 3 and 4 people")).toEqual(["4"]);
    expect(partiesOf("2 adults and 1 child")).toEqual(["2", "1"]);
    for (const words of [
      "at 3",
      "tomorrow 120 at 7pm",
      "at 120, maybe 150",
      "Friday - 2 weeks",
      "3.30 people",
      "4 dogs",
    ]) {
      expect(partiesOf(words)).toEqual([]);
    }
  });
});

describe("T-1133 rule 1: a counted party is never an hour, whatever cue, mark or approximate word stands before it", () => {
  it("no bare hour beside a day is a counted party (GAP 2): 'tomorrow 4 people', 'tomorrow: 4 people at 7pm', 'Friday 6 guests'", () => {
    for (const words of [
      "tomorrow 4 people",
      "can we do tomorrow 4 people at 7pm",
      "can we do tomorrow: 4 people at 7pm",
      "can we do tomorrow (4 people) at 7pm",
      "Thursday: 3 people at 7pm",
      "Friday 6 guests at 7pm",
      "tomorrow, 4 people, 7pm",
      "tmrw. 3 of us at 7pm",
      "tomorrow 👍 4 people at 7pm",
      "tomorrow 4 to 6 people at 7pm",
    ]) {
      expect(timeReadingOf(words).bareHours, words).toEqual([]);
    }
    expect(timeReadingOf("mañana 4 personas a las 7", ["es"]).bareHours).toEqual([]);
  });

  it("where main's reach read one (spaces and commas, or a cue and one space), the party is declined, for the phrase builder to keep as a piece", () => {
    expect(wordsAt("tomorrow 4 people", timeReadingOf("tomorrow 4 people").declined)).toEqual(["4"]);
    expect(wordsAt("tomorrow, 4 people", timeReadingOf("tomorrow, 4 people").declined)).toEqual(["4"]);
    expect(wordsAt("tomorrow at 4 people", timeReadingOf("tomorrow at 4 people").declined)).toEqual(["at 4"]);
    // A mark main did not take stands no hour main read, so nothing is declined there.
    expect(timeReadingOf("tomorrow: 4 people").declined).toEqual([]);
    expect(clockOf("tomorrow at 4 people")).toBeNull();
  });

  it("the count reader keeps every counted party a cue or a mark stood before: 'we're at ~6, maybe 8 people' holds 6 and 8", () => {
    expect(countsIn("we're at 120, maybe 150 guests")).toEqual([120, 150]);
    expect(countsIn("we're at around 10, maybe 12 people")).toEqual([10, 12]);
    expect(countsIn("at about 10, maybe 12 of us")).toEqual([10, 12]);
    expect(countsIn("we're at ~6, maybe 8 people")).toEqual([6, 8]);
    expect(countsIn("we're at approx. 10, maybe 12 guests")).toEqual([10, 12]);
    expect(countsIn("we're at 4 people")).toEqual([4]);
  });
});

describe("T-1133 rule 2: an hour only T-1130's reach finds is one only with its own time evidence", () => {
  it("three or four digits after a cue are an hour with nothing beside them but a day, part-of-day or time word, or am or pm", () => {
    for (const words of [
      "tomorrow at 1530",
      "at 1530 tomorrow",
      "tomorrow at 1530.",
      "tomorrow at 1530?",
      "tomorrow at 1530 :)",
      "at 1530 on Sunday",
      "tomorrow at 1530 in the afternoon",
    ]) {
      expect(clockOf(words), words).toEqual({ kind: "clock", hour: 15, minute: 30, meridiem: null });
    }
    expect(clockOf("tomorrow at 330pm")).toEqual({ kind: "clock", hour: 3, minute: 30, meridiem: "pm" });
    expect(readings("mañana a las 1530 de la tarde", ["es"])).toEqual(["2026-11-01T20:30:00Z"]);
  });

  it("a word no reader reads, a count or another number after it makes it no time, and the count reader keeps the number", () => {
    for (const words of [
      "tomorrow at 120 Oak St",
      "at 120, maybe 150 guests",
      "catering at 120, maybe 150",
      "tomorrow at 1530 please",
      "tomorrow at 1530 for 2",
      // A zone word is no time word here (default): "at 1530 PST" stays unread, as on main.
      "tomorrow at 1530 PST",
    ]) {
      expect(clockOf(words), words).toBeNull();
    }
    // The address's number is no time, so the one time is 3pm.
    expect(clockOf("tomorrow at 120 Oak St at 3pm")).toEqual({
      kind: "clock",
      hour: 3,
      minute: 0,
      meridiem: "pm",
    });
    expect(countsIn("catering at 120, maybe 150")).toEqual([120, 150]);
    expect(countsIn("tomorrow at 120 Oak St")).toEqual([120]);
  });

  it("an approximate word or a mark after a cue, or a mark main did not take beside a day, takes an hour only with its evidence", () => {
    for (const words of [
      "at ~6, maybe 8",
      "at around 10, maybe 12",
      "at ~6, 8 people",
      "tomorrow at ~3 if possible",
    ]) {
      expect(clockOf(words), words).toBeNull();
    }
    expect(countsIn("we're at ~6, maybe 8")).toEqual([6, 8]);
    expect(countsIn("we're at ~6, 8 people")).toEqual([6, 8]);
    for (const words of [
      "Friday - 2 weeks from now",
      "tomorrow: 4 dogs at 7pm",
      "tmrw. 3 dogs",
      "Thursday: 3 works",
    ]) {
      expect(timeReadingOf(words).bareHours, words).toEqual([]);
    }
    for (const words of [
      "Thursday: 3",
      "Thursday: 3?",
      "can we do Thursday - 3",
      "tmrw. 3",
      "3 - Thursday",
    ]) {
      expect(timeReadingOf(words).bareHours, words).toHaveLength(1);
    }
  });

  it("main's own reach reads as main read it: 'tomorrow at 3, 4 people' is 3, 'Thursday 3 works' is Thursday at 3", () => {
    expect(clockOf("tomorrow at 3, 4 people")).toEqual({ kind: "clock", hour: 3, minute: 0, meridiem: null });
    expect(countsIn("tomorrow at 3, 4 people")).toEqual([4]);
    expect(timeReadingOf("Thursday 3 works").bareHours).toHaveLength(1);
    expect(clockOf("tomorrow at 7pm, at 120 Oak St")).toEqual({
      kind: "clock",
      hour: 7,
      minute: 0,
      meridiem: "pm",
    });
  });
});

describe("T-1133 at the phrase: a count range between day and time is blanked whole (GAP 1), and no reading takes an hour the text does not", () => {
  const at = (utc: string) => ({ utc, zone: NEW_YORK });
  const SUNDAY = at("2026-11-01T04:00:00Z");
  const SUNDAY_4PM = at("2026-11-01T21:00:00Z");
  const SUNDAY_7PM = at("2026-11-02T00:00:00Z");

  it.each([
    ["can we book a table tomorrow for 4 to 6 people at 7pm", "tomorrow for 4 to 6 people at 7pm"],
    ["table tomorrow for 4 to 5 at 7pm", "tomorrow for 4 to 5 at 7pm"],
    ["table tomorrow for 4 perhaps 5 at 7pm", "tomorrow for 4 perhaps 5 at 7pm"],
    ["table tomorrow for 4 or maybe 5 at 7pm", "tomorrow for 4 or maybe 5 at 7pm"],
    ["table tomorrow for 2 adults and 1 child at 7pm", "tomorrow for 2 adults and 1 child at 7pm"],
    ["can we do tomorrow 4 to 6 people at 7pm", "tomorrow 4 to 6 people at 7pm"],
  ] as const)("in '%s' the day alone differs and '%s' passes", (text, whole) => {
    expect(wholePhraseFault("time", SUNDAY, text, "tomorrow", context)).toBe("differs");
    expect(wholePhraseFault("time", SUNDAY_7PM, text, whole, context)).toBeNull();
  });

  it("a range with a count that is no party stays unread between day and time: 'tomorrow for 2 or 3.30 at 7pm' is refused whole", () => {
    const text = "tomorrow for 2 or 3.30 at 7pm";
    expect(wholePhraseFault("time", SUNDAY_7PM, text, text, context)).toBe("noText");
  });

  it("the cut's own reading, or the phrase's, takes no hour the whole text does not (noText), with or without another value", () => {
    expect(
      wholePhraseFault("time", SUNDAY_4PM, "can we do tomorrow - 4 people", "tomorrow - 4", context),
    ).toBe("noText");
    expect(wholePhraseFault("time", SUNDAY, "can we do tomorrow - 4 people", "tomorrow", context)).toBe(
      "differs",
    );
    expect(wholePhraseFault("time", SUNDAY_4PM, "can we do tomorrow 4 people", "tomorrow 4", context)).toBe(
      "noText",
    );
    // Main's reach there kept the party a piece of the day's phrase, so the day alone is refused as main refused it.
    expect(wholePhraseFault("time", SUNDAY, "can we do tomorrow, 4 people", "tomorrow", context)).toBe(
      "differs",
    );
    expect(wholePhraseFault("time", SUNDAY, "can we do tomorrow at 4 people", "tomorrow", context)).toBe(
      "differs",
    );
    expect(
      wholePhraseFault(
        "time",
        at("2026-11-01T20:00:00Z"),
        "can we do tomorrow at 3, 4 people",
        "tomorrow at 3",
        context,
      ),
    ).toBeNull();
    expect(
      wholePhraseFault("integer", 4, "can we do tomorrow at 3, 4 people", "4 people", context),
    ).toBeNull();
    expect(wholePhraseFault("integer", 4, "we're at 4 people", "4 people", context)).toBeNull();
    expect(
      wholePhraseFault("time", SUNDAY_7PM, "tomorrow at 7pm, at 120 Oak St", "tomorrow at 7pm", context),
    ).toBeNull();
  });
});

describe("T-1133 keeps T-1130's readings: '3:30', '3.5', '10/24', '1,200', '$3.50', 'at 1530', 'at 3.5', 'tomorrow for 2 at 7pm'", () => {
  it("each keeps its reading", () => {
    expect(timeIn("3:30").clock).toEqual({ kind: "clock", hour: 3, minute: 30, meridiem: null });
    expect(readTimeWords("3.5").kind).toBe("none");
    expect(countsIn("3.5")).toEqual([3.5]);
    expect(timeIn("10/24").day).toEqual({ kind: "date", month: 10, day: 24, year: null });
    expect(countsIn("10/24")).toEqual([]);
    expect(countsIn("1,200")).toEqual([1200]);
    expect(amountsIn("$3.50").map((amount) => amount.money.cents)).toEqual([350]);
    expect(readings("tomorrow at 1530")).toEqual(["2026-11-01T20:30:00Z"]);
    expect(readings("tomorrow at 3.5")).toEqual(["2026-11-01T08:30:00Z", "2026-11-01T20:30:00Z"]);
    expect(readings("tomorrow for 2 at 7pm")).toEqual(["2026-11-02T00:00:00Z"]);
    expect(countsIn("table for 4 at 1530")).toEqual([4]);
    expect(countsIn("table for 4 at 3.5")).toEqual([4]);
    expect(countsIn("table tomorrow for 2 at 7pm")).toEqual([2]);
  });
});
