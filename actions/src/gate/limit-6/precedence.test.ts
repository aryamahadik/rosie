// T-1133's proofs (the card's "Proves it with"; DL-259), with the real limit 6 and the real gate, limits 1 to 5 scripted
// (test-support's doubles), sent as the re-judge of T-1130's 31feec4 sent them (a move on Sat Oct 31 at 10:00am New
// York; a group on Mon Oct 19). The count reader and the time reader agree on which number is which, by one precedence
// rule (values/parties.ts, values/times.ts): a counted party is never an hour, and an hour only T-1130's reach finds is
// one only with its own time evidence. So every probe of the re-judge's security report (items 1, 1b and 2, with their
// controls) and of round 2's GAPs 1 and 2 is refused at limit 6 and at the gate, before and after the re-read, and each
// whole passes with its own reading or gives several. Each case carries main's outcome as the re-judge recorded it
// (6335016, before T-1130), and the comparison test holds that nothing main refused passes here.

import { describe, expect, it } from "vitest";

import { runGate, type GateRequest, type GatedPart, type GateVerdict } from "../framework";
import { callContext } from "../framework/test-support";
import { oneQuestionOutcome, type Limit6Outcome, type ValueFault, type ValuesDecision } from "./index";
import {
  NEW_YORK,
  afterReread,
  groupRequest,
  haircutMoveRequest,
  limitIn,
  partOf,
  registryWith,
  turnOf,
} from "./test-support";

/** Limit 6's decision on the request's first part. */
function decision(request: GateRequest): Promise<ValuesDecision> {
  return limitIn().decide(partOf(request), turnOf(request));
}

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** The failure with `outcome`, naming the one field with its fault. */
function failed(outcome: Limit6Outcome, name: string, why: ValueFault): ValuesDecision {
  return { result: "fail", outcome, fields: [name], faults: [{ field: name, why }] };
}

/** The call context of a request's own business. */
const contextOf = (request: GateRequest) => callContext(turnOf(request).businessId);

const ny = (utc: string) => ({ utc, zone: NEW_YORK });
const es = { language: "es" } as const;
// Sent Sat Oct 31 2026 at 10:00am EDT; the clocks fall back that night, so Sunday's hours are EST.
const SUNDAY = ny("2026-11-01T04:00:00Z"); // Sun Nov 1 at its start, 00:00 (still EDT)
const SUNDAY_1220 = ny("2026-11-01T18:20:00Z"); // Sun 1:20pm
const SUNDAY_2PM = ny("2026-11-01T19:00:00Z");
const SUNDAY_3PM = ny("2026-11-01T20:00:00Z");
const SUNDAY_4PM = ny("2026-11-01T21:00:00Z");
const SUNDAY_NOON = ny("2026-11-01T17:00:00Z");
const SUNDAY_7PM = ny("2026-11-02T00:00:00Z");
const SATURDAY_7PM = ny("2026-10-31T23:00:00Z"); // today's 7pm, EDT
const THURSDAY_3PM = ny("2026-11-05T20:00:00Z");
const THURSDAY_7PM = ny("2026-11-06T00:00:00Z");
const FRIDAY_2PM = ny("2026-11-06T19:00:00Z");
const FRIDAY_6PM = ny("2026-11-06T23:00:00Z");
const FRIDAY_7PM = ny("2026-11-07T00:00:00Z");

/**
 * Main's outcome for the cut, before T-1130 (the re-judge's run of 6335016; for the class probes, main's readers read the
 * same way): refused as several, differs or noText, or passed (round 2's GAPs 1 and 2, already on main, which had no step
 * 2b, so every count between a day and a time ended the day's phrase there).
 */
type MainOutcome = "several" | "differs" | "noText" | "pass";

/** One probe: the cut, its field, main's outcome, its fault here, and its whole with what the whole gives here. */
interface Probe {
  readonly name: string;
  readonly cut: () => GateRequest;
  readonly field: "people" | "time_saved";
  readonly main: MainOutcome;
  readonly fault: ValueFault;
  readonly whole: (() => GateRequest) | null;
  /** What the whole gives: null when it passes with its own reading, else its fault (several). */
  readonly wholeFault: ValueFault | null;
}

/** A count cut out of `words` and its whole, which is several: two counts. */
const count = (
  name: string,
  words: string,
  cut: string,
  value: number,
  whole: string,
  main: MainOutcome = "several",
): Probe => ({
  name,
  cut: () => groupRequest(value, cut, words),
  field: "people",
  main,
  fault: "several",
  whole: () => groupRequest(value, whole, words),
  wholeFault: "several",
});

/** A time cut out of `words` and its whole, which passes unless `wholeFault` says it is several. */
const time = (
  name: string,
  words: string,
  cut: string,
  cutValue: ReturnType<typeof ny>,
  fault: ValueFault,
  main: MainOutcome,
  whole: readonly [string, ReturnType<typeof ny>] | null,
  options: { readonly language?: string; readonly wholeFault?: ValueFault } = {},
): Probe => {
  const sent = options.language === undefined ? {} : { language: options.language };
  return {
    name,
    cut: () => haircutMoveRequest(cutValue, cut, words, sent),
    field: "time_saved",
    main,
    fault,
    whole: whole === null ? null : () => haircutMoveRequest(whole[1], whole[0], words, sent),
    wholeFault: options.wholeFault ?? null,
  };
};

// Item 1 of the re-judge's security report: T-1130's reach (an approximate word or a mark after a cue, or three digits
// after one) took a number from the count reader, so the last count of a choice passed alone. Main gives several.
const ITEM_1: readonly Probe[] = [
  count(
    "item 1: '150 guests' out of \"we're at 120, maybe 150 guests\"",
    "we're at 120, maybe 150 guests",
    "150 guests",
    150,
    "120, maybe 150 guests",
  ),
  count(
    "item 1: '150' out of 'catering at 120, maybe 150'",
    "catering at 120, maybe 150",
    "150",
    150,
    "120, maybe 150",
  ),
  count(
    "item 1: '12 people' out of \"we're at around 10, maybe 12 people\"",
    "we're at around 10, maybe 12 people",
    "12 people",
    12,
    "10, maybe 12 people",
  ),
  count(
    "item 1: '12 of us' out of 'at about 10, maybe 12 of us'",
    "at about 10, maybe 12 of us",
    "12 of us",
    12,
    "10, maybe 12 of us",
  ),
  count(
    "item 1: '8 people' out of \"we're at ~6, maybe 8 people\"",
    "we're at ~6, maybe 8 people",
    "8 people",
    8,
    "6, maybe 8 people",
  ),
  count(
    "item 1: '12 guests' out of \"we're at approx. 10, maybe 12 guests\"",
    "we're at approx. 10, maybe 12 guests",
    "12 guests",
    12,
    "10, maybe 12 guests",
  ),
  count(
    "item 1's control: '12 people' out of \"we're 10, maybe 12 people\"",
    "we're 10, maybe 12 people",
    "12 people",
    12,
    "10, maybe 12 people",
  ),
  // The same class with no unit and with a mark alone: the hour has no time evidence, so the count reader keeps it.
  count("item 1's class: '8' out of \"we're at ~6, maybe 8\"", "we're at ~6, maybe 8", "8", 8, "6, maybe 8"),
  count(
    "item 1's class: '8 people' out of \"we're at ~6, 8 people\"",
    "we're at ~6, 8 people",
    "8 people",
    8,
    "6, 8 people",
  ),
  count(
    "item 1's class: '12' out of 'at around 10, maybe 12'",
    "at around 10, maybe 12",
    "12",
    12,
    "10, maybe 12",
  ),
];

// Item 1b: three digits after a cue with a word no reader reads after them are no time (rule 2). Main says differs.
const ITEM_1B: readonly Probe[] = [
  time(
    "item 1b: 'tomorrow at 120' (Sun 1:20pm) out of 'tomorrow at 120 Oak St at 3pm'",
    "tomorrow at 120 Oak St at 3pm",
    "tomorrow at 120",
    SUNDAY_1220,
    "differs",
    "differs",
    // The whole, meant as Sun 3pm, touches the day's phrase and the time's, an address no reader reads between: several.
    ["tomorrow at 120 Oak St at 3pm", SUNDAY_3PM],
    { wholeFault: "several" },
  ),
];

// Item 2: a joining mark main did not take stood a counted party beside a day as its bare hour, so the wrong hour passed.
// Main says differs. A counted party is never the day's bare hour (rule 1), and stands between day and time (step 2b).
const ITEM_2: readonly Probe[] = [
  time(
    "item 2: 'tomorrow: 4' (Sun 4pm) out of 'can we do tomorrow: 4 people at 7pm'",
    "can we do tomorrow: 4 people at 7pm",
    "tomorrow: 4",
    SUNDAY_4PM,
    "differs",
    "differs",
    ["tomorrow: 4 people at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2: 'tomorrow - 4' (Sun 4pm) out of 'can we do tomorrow - 4 people at 7pm'",
    "can we do tomorrow - 4 people at 7pm",
    "tomorrow - 4",
    SUNDAY_4PM,
    "differs",
    "differs",
    ["tomorrow - 4 people at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2: 'tomorrow (4' (Sun 4pm) out of 'can we do tomorrow (4 people) at 7pm'",
    "can we do tomorrow (4 people) at 7pm",
    "tomorrow (4",
    SUNDAY_4PM,
    "differs",
    "differs",
    ["tomorrow (4 people) at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2: 'Thursday (3' (Thu 3pm) out of 'can we do Thursday (3 people) at 7pm'",
    "can we do Thursday (3 people) at 7pm",
    "Thursday (3",
    THURSDAY_3PM,
    "differs",
    "differs",
    ["Thursday (3 people) at 7pm", THURSDAY_7PM],
  ),
  time(
    "item 2: 'Thursday: 3' (Thu 3pm) out of 'can we do Thursday: 3 people at 7pm'",
    "can we do Thursday: 3 people at 7pm",
    "Thursday: 3",
    THURSDAY_3PM,
    "differs",
    "differs",
    ["Thursday: 3 people at 7pm", THURSDAY_7PM],
  ),
  time(
    "item 2: 'tomorrow / 4' (Sun 4pm) out of 'can we do tomorrow / 4 adults at 7pm'",
    "can we do tomorrow / 4 adults at 7pm",
    "tomorrow / 4",
    SUNDAY_4PM,
    "differs",
    "differs",
    ["tomorrow / 4 adults at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2: 'Friday - 6' (Fri 6pm) out of 'can we do Friday - 6 guests at 7pm'",
    "can we do Friday - 6 guests at 7pm",
    "Friday - 6",
    FRIDAY_6PM,
    "differs",
    "differs",
    ["Friday - 6 guests at 7pm", FRIDAY_7PM],
  ),
  time(
    "item 2: 'tomorrow: 2' (Sun 2pm) out of 'can we do tomorrow: 2 adults at 7pm'",
    "can we do tomorrow: 2 adults at 7pm",
    "tomorrow: 2",
    SUNDAY_2PM,
    "differs",
    "differs",
    ["tomorrow: 2 adults at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2 (Spanish): 'mañana: 4' (Sun 4pm) out of 'puedo mañana: 4 personas a las 7'",
    "puedo mañana: 4 personas a las 7",
    "mañana: 4",
    SUNDAY_4PM,
    "differs",
    "differs",
    ["mañana: 4 personas a las 7", SUNDAY_7PM],
    es,
  ),
  time(
    "item 2: 'tmrw. 3' (Sun 3pm) out of 'table tmrw. 3 of us at 7pm'",
    "table tmrw. 3 of us at 7pm",
    "tmrw. 3",
    SUNDAY_3PM,
    "differs",
    "differs",
    ["tmrw. 3 of us at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2: 'tomorrow 👍 4' (Sun 4pm) out of 'can we do tomorrow 👍 4 people at 7pm'",
    "can we do tomorrow 👍 4 people at 7pm",
    "tomorrow 👍 4",
    SUNDAY_4PM,
    "differs",
    "differs",
    ["tomorrow 👍 4 people at 7pm", SUNDAY_7PM],
  ),
  time(
    "item 2: 'tomorrow - 12' (Sun 00:00) out of 'can we do tomorrow - 12 guests - noon'",
    "can we do tomorrow - 12 guests - noon",
    "tomorrow - 12",
    SUNDAY,
    "differs",
    // Main reads "tomorrow - 12" as Sun 00:00 with its 12 unread.
    "noText",
    ["tomorrow - 12 guests - noon", SUNDAY_NOON],
  ),
  // The cut's own reading takes the party for an hour where the whole text holds none, so it is no reading of the text,
  // even with the value the whole names (step 4's agreement).
  time(
    "item 2: 'tomorrow - 12' (Sun noon) out of 'can we do tomorrow - 12 guests - noon'",
    "can we do tomorrow - 12 guests - noon",
    "tomorrow - 12",
    SUNDAY_NOON,
    "noText",
    "differs",
    null,
  ),
  // A number with no unit and no time evidence after a mark main did not take is no hour (rule 2): its cut, read on its
  // own, takes it for one, which the whole text does not (noText).
  time(
    "item 2: 'Friday - 2' (Fri 2pm) out of 'can we do Friday - 2 weeks from now'",
    "can we do Friday - 2 weeks from now",
    "Friday - 2",
    FRIDAY_2PM,
    "noText",
    "differs",
    null,
  ),
  time(
    "item 2's class: 'tomorrow: 4' (Sun 4pm) out of 'can we do tomorrow: 4 dogs at 7pm'",
    "can we do tomorrow: 4 dogs at 7pm",
    "tomorrow: 4",
    SUNDAY_4PM,
    "differs",
    "differs",
    null,
  ),
  time(
    "item 2's class: 'tomorrow - 4' (Sun 4pm) out of 'can we do tomorrow - 4 dogs'",
    "can we do tomorrow - 4 dogs",
    "tomorrow - 4",
    SUNDAY_4PM,
    "noText",
    "differs",
    null,
  ),
];

// Round 2's GAP 1: a count range or choice between a day and a time is blanked whole with its joining words, so the day
// alone differs (main passed it), and the whole passes with the range read as the party.
const GAP_1: readonly Probe[] = [
  time(
    "GAP 1: 'tomorrow' out of 'can we book a table tomorrow for 4 to 6 people at 7pm'",
    "can we book a table tomorrow for 4 to 6 people at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["tomorrow for 4 to 6 people at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 1: 'tomorrow' out of 'table tomorrow for 4 to 5 at 7pm'",
    "table tomorrow for 4 to 5 at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["tomorrow for 4 to 5 at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 1: 'tomorrow' out of 'can we book a table tomorrow for 4 perhaps 5 at 7pm'",
    "can we book a table tomorrow for 4 perhaps 5 at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["tomorrow for 4 perhaps 5 at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 1: 'tomorrow' out of 'can we book a table tomorrow for 4 possibly 5 at 7pm'",
    "can we book a table tomorrow for 4 possibly 5 at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["tomorrow for 4 possibly 5 at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 1 (Spanish): 'mañana' out of 'mesa mañana para 4 tal vez 5 a las 7'",
    "mesa mañana para 4 tal vez 5 a las 7",
    "mañana",
    SUNDAY,
    "differs",
    "pass",
    ["mañana para 4 tal vez 5 a las 7", SUNDAY_7PM],
    es,
  ),
  time(
    "GAP 1: 'tomorrow' out of 'at 7pm for 4 to 6 people tomorrow'",
    "at 7pm for 4 to 6 people tomorrow",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["at 7pm for 4 to 6 people tomorrow", SUNDAY_7PM],
  ),
  time(
    "GAP 1: 'at 7pm' (Sat 7pm) out of 'at 7pm for 4 to 6 people tomorrow'",
    "at 7pm for 4 to 6 people tomorrow",
    "at 7pm",
    SATURDAY_7PM,
    "differs",
    "pass",
    null,
  ),
  time(
    "GAP 1's control: 'tomorrow' out of 'can we book a table tomorrow for 4 or 5 at 7pm'",
    "can we book a table tomorrow for 4 or 5 at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    // The controls differ on T-1130's code; main, with no step 2b, passed them too.
    "pass",
    ["tomorrow for 4 or 5 at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 1's control: 'tomorrow' out of 'can we book a table tomorrow for 4-5 at 7pm'",
    "can we book a table tomorrow for 4-5 at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["tomorrow for 4-5 at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 1's control: 'tomorrow' out of 'can we book a table tomorrow for 4 maybe 5 at 7pm'",
    "can we book a table tomorrow for 4 maybe 5 at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "pass",
    ["tomorrow for 4 maybe 5 at 7pm", SUNDAY_7PM],
  ),
];

// Round 2's GAP 2: a counted party beside a day is never the day's bare hour (main passed the wrong hour).
const GAP_2: readonly Probe[] = [
  time(
    "GAP 2: 'tomorrow 4' (Sun 4pm) out of 'can we do tomorrow 4 people at 7pm'",
    "can we do tomorrow 4 people at 7pm",
    "tomorrow 4",
    SUNDAY_4PM,
    "differs",
    "pass",
    ["tomorrow 4 people at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 2: 'tomorrow' (Sun 00:00) out of 'can we do tomorrow 4 people at 7pm'",
    "can we do tomorrow 4 people at 7pm",
    "tomorrow",
    SUNDAY,
    "differs",
    "differs",
    null,
  ),
  time(
    "GAP 2: 'tomorrow 2' (Sun 2pm) out of 'table tomorrow 2 adults at 7pm'",
    "table tomorrow 2 adults at 7pm",
    "tomorrow 2",
    SUNDAY_2PM,
    "differs",
    "pass",
    ["tomorrow 2 adults at 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 2: 'Friday 6' (Fri 6pm) out of 'Friday 6 guests at 7pm'",
    "Friday 6 guests at 7pm",
    "Friday 6",
    FRIDAY_6PM,
    "differs",
    "pass",
    ["Friday 6 guests at 7pm", FRIDAY_7PM],
  ),
  time(
    "GAP 2 (Spanish): 'mañana 4' (Sun 4pm) out of 'mañana 4 personas a las 7'",
    "mañana 4 personas a las 7",
    "mañana 4",
    SUNDAY_4PM,
    "differs",
    "pass",
    ["mañana 4 personas a las 7", SUNDAY_7PM],
    es,
  ),
  time(
    "GAP 2: 'tomorrow, 4' (Sun 4pm) out of 'tomorrow, 4 people, 7pm'",
    "tomorrow, 4 people, 7pm",
    "tomorrow, 4",
    SUNDAY_4PM,
    "differs",
    "pass",
    ["tomorrow, 4 people, 7pm", SUNDAY_7PM],
  ),
  time(
    "GAP 2: 'tomorrow 4' (Sun 4pm) out of 'can we do tomorrow 4 people'",
    "can we do tomorrow 4 people",
    "tomorrow 4",
    SUNDAY_4PM,
    "noText",
    "pass",
    null,
  ),
];

const PROBES: readonly Probe[] = [...ITEM_1, ...ITEM_1B, ...ITEM_2, ...GAP_1, ...GAP_2];
const table = PROBES.map((probe) => [probe.name, probe] as const);

describe("T-1133: every probe of the re-judge's items 1, 1b and 2 and of round 2's GAPs 1 and 2 is refused at limit 6", () => {
  it.each(table)("%s: limit 6 fails the cut, before and after the re-read", async (_name, probe) => {
    const expected = failed(oneQuestionOutcome(), probe.field, probe.fault);
    expect(await decision(probe.cut())).toEqual(expected);
    expect(await decision(afterReread(probe.cut()))).toEqual(expected);
  });

  it.each(table)(
    "%s: at the gate the cut is refused naming the field before the re-read, and one question after it",
    async (_name, probe) => {
      const request = probe.cut();
      expect(await runGate(request, contextOf(request), registryWith(limitIn()))).toEqual({
        verdict: "refused",
        error: { error: "valueFailsWords", parts: [{ part: 0, fields: [probe.field] }] },
      });
      const [part] = gatedParts(
        await runGate(afterReread(request), contextOf(request), registryWith(limitIn())),
      );
      expect(part?.result).toBe("stopped");
      expect(part?.stoppedBy).toEqual(oneQuestionOutcome());
    },
  );

  const wholes = PROBES.filter((probe) => probe.whole !== null).map((probe) => [probe.name, probe] as const);

  it.each(wholes)(
    "%s: the whole passes with its own reading, or is several, at limit 6 and the gate, before and after the re-read",
    async (_name, probe) => {
      const request = (probe.whole ?? probe.cut)();
      if (probe.wholeFault === null) {
        expect(await decision(request)).toEqual({ result: "pass" });
        expect(await decision(afterReread(request))).toEqual({ result: "pass" });
        const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
        expect(passed?.result).toBe("passed");
        expect(passed?.limits[5]).toEqual({ limit: 6, result: "pass", outcome: null });
      } else {
        const expected = failed(oneQuestionOutcome(), probe.field, probe.wholeFault);
        expect(await decision(request)).toEqual(expected);
        expect(await decision(afterReread(request))).toEqual(expected);
        expect(await runGate(request, contextOf(request), registryWith(limitIn()))).toEqual({
          verdict: "refused",
          error: { error: "valueFailsWords", parts: [{ part: 0, fields: [probe.field] }] },
        });
      }
    },
  );
});

describe("T-1133's comparison: the same requests against main's readers, before T-1130 (the re-judge's run of 6335016)", () => {
  it("nothing main refused passes here: every cut main refused is refused, before and after the re-read and at the gate", async () => {
    const refusedOnMain = PROBES.filter((probe) => probe.main !== "pass");
    expect(refusedOnMain.length).toBeGreaterThan(0);
    for (const probe of refusedOnMain) {
      expect((await decision(probe.cut())).result, probe.name).toBe("fail");
      expect((await decision(afterReread(probe.cut()))).result, probe.name).toBe("fail");
      const request = probe.cut();
      const verdict = await runGate(request, contextOf(request), registryWith(limitIn()));
      expect(verdict.verdict, probe.name).toBe("refused");
    }
  });

  it("the cuts main passed (round 2's GAPs 1 and 2, already on main) are refused here too", async () => {
    const passedOnMain = PROBES.filter((probe) => probe.main === "pass");
    expect(passedOnMain.length).toBeGreaterThan(0);
    for (const probe of passedOnMain) {
      expect(probe.name).toMatch(/^GAP [12]/);
      expect((await decision(probe.cut())).result, probe.name).toBe("fail");
    }
  });
});

describe("T-1133 keeps T-1130's readings: each whole passes at limit 6 and the gate with its own reading", () => {
  const SUNDAY_330PM = ny("2026-11-01T20:30:00Z");
  // [case, the text, the words cited, the value]
  const wholes: readonly (readonly [string, string, string, ReturnType<typeof ny> | number])[] = [
    ["'tomorrow at 3:30' is Sun 3:30", "can you do tomorrow at 3:30", "tomorrow at 3:30", SUNDAY_330PM],
    ["'tomorrow at 1530' is Sun 15:30", "can you do tomorrow at 1530", "tomorrow at 1530", SUNDAY_330PM],
    ["'tomorrow at 3.5' is Sun 3:30", "can you do tomorrow at 3.5", "tomorrow at 3.5", SUNDAY_330PM],
    [
      "'tomorrow for 2 at 7pm' is Sun 7pm",
      "table tomorrow for 2 at 7pm",
      "tomorrow for 2 at 7pm",
      SUNDAY_7PM,
    ],
    ["'tomorrow at ~3' is Sun 3", "can you do tomorrow at ~3", "tomorrow at ~3", SUNDAY_3PM],
    ["'Thursday: 3' is Thu 3", "can we do Thursday: 3", "Thursday: 3", THURSDAY_3PM],
    [
      "'at 1530 tomorrow' is Sun 15:30 (its day is its evidence)",
      "at 1530 tomorrow",
      "at 1530 tomorrow",
      SUNDAY_330PM,
    ],
    ["'1,200' out of 'a party of 1,200' is 1,200", "a party of 1,200", "1,200", 1200],
    ["'2' out of 'table tomorrow for 2 at 7pm' is the party", "table tomorrow for 2 at 7pm", "2", 2],
    ["'4' out of 'table for 4 at 1530' is the party", "table for 4 at 1530", "4", 4],
  ];

  it.each(wholes)("%s", async (_case, words, cited, value) => {
    const request =
      typeof value === "number" ? groupRequest(value, cited, words) : haircutMoveRequest(value, cited, words);
    expect(await decision(request)).toEqual({ result: "pass" });
    expect(await decision(afterReread(request))).toEqual({ result: "pass" });
    const [passed] = gatedParts(await runGate(request, contextOf(request), registryWith(limitIn())));
    expect(passed?.result).toBe("passed");
  });
});
