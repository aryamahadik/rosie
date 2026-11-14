// The contact home's part of the bundle (T-588; C-102; S13-19): the handling line that every owner and staff message
// about a private booking carries, read from the home step's own words and the record's reach.way rows.
//
// S13-19 as the bundle compiles it (with Master Corrections C2 and C9): "Every owner and staff message about a private
// booking carries one line: Like this: 'Private booking: reach them only by email, at the times they named. Never say
// why.'" The example is the line for a person reached by email; "by email" in it is the record's reach.way phrase for the
// email way (K-01 record.slots["reach.way"], "A phrase: how this person is reached now": by text, by text only, by
// email). So the line for any way is the example with that way's reach.way row in its place, read by the slot filler's
// own row reader (T-310 pickRow) on the booking's record. No word of the line is written here: the words are the
// bundle's, read once per flow (readContactRecord), and refused when they are not as this home reads them.
//
// Not given: "Private and calls only adds: 'On a call: ask for them by first name.'" and the call lines after it. Calls
// only is never offered (MC C2; Q-07's default) and S13-19's calls-only lines are unreachable (inventory C-237), so a
// booking whose way is calls only is refused, never given a line. "Texts only and email only carry their own owner and
// staff lines, private or not": no source gives those lines' words, so none is given here (an open question, not a
// guess).

import { isLabel } from "../../../../runtime/src/trace";
import {
  bookingValue,
  pickRow,
  readingProblem,
  type RecordReading,
  type SlotRow,
} from "../../finalize/slots/record";
import type { FlowLetter } from "../registry";

/** The contact home cannot read this bundle, this person or this message. Its message names a fault, never a value. */
export class ContactHomeError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}: ${problems.join("; ")}`);
    this.name = "ContactHomeError";
    this.problems = problems;
  }
}

/** The handling line's label: the one line S13-19 gives every owner and staff message about a private booking. */
export const PRIVATE_BOOKING_LINE = "privateBooking";

/** The line an owner or staff message about a private booking carries (S13-19). */
export interface HandlingLine {
  readonly line: typeof PRIVATE_BOOKING_LINE;
  /** S13-19's own line, with the person served's way as the booking record's reach.way phrase. */
  readonly text: string;
}

/** The contact home's part of one flow's bundle. */
export interface ContactRecord {
  readonly flow: FlowLetter;
  /** The contact home's step (record.homes.contact; S13-19). */
  readonly home: string;
  /** S13-19's private booking line around its reach.way phrase: the words before it and after it. */
  readonly privateLine: { readonly before: string; readonly after: string };
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const items: readonly unknown[] = value;
  return items.every((item) => typeof item === "string") ? items : null;
}

/** The named slot whose words say how a person is reached (K-01 record.slots; K-03 slots.json). */
const REACH_WAY_SLOT = "reach.way";

/** A line of the home step's `more` that gives an example in quotes: "Like this: '<the line>'". */
const EXAMPLE = /^Like this: '(.+)'$/;

/** The reach.way rows as the slot filler reads them; null with a problem when one is not a row it can read. */
function reachWayRows(raw: unknown, home: string, problems: string[]): readonly SlotRow[] | null {
  if (!isObj(raw) || raw.home !== home) {
    problems.push(`slot ${REACH_WAY_SLOT} is not the contact home's`);
    return null;
  }
  const rows: unknown = raw.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    problems.push(`slot ${REACH_WAY_SLOT} has no rows`);
    return null;
  }
  const list: readonly unknown[] = rows;
  const out: SlotRow[] = [];
  for (const [index, row] of list.entries()) {
    const at = `slot ${REACH_WAY_SLOT} row ${String(index + 1)}`;
    if (!isObj(row) || typeof row.text !== "string") {
      problems.push(`${at} has no words`);
      return null;
    }
    const when: unknown = row.when;
    if (when === undefined) {
      out.push({ text: row.text });
      continue;
    }
    // The way is a booking value: a row that reads anything else could not be read on the way alone.
    if (!isObj(when) || Object.keys(when).some((key) => key !== "booking")) {
      problems.push(`${at} reads more than the booking's values`);
      return null;
    }
    out.push({ when, text: row.text });
  }
  return out;
}

/** The reach.way phrase for a way, by the slot filler's own first-fit reader, on rows that read the booking alone. */
function phraseOfWay(rows: readonly SlotRow[], reach: "email"): string | null {
  const reading: RecordReading = {
    price: "list",
    before: "none",
    after: "none",
    booking: { reach },
    switches: [],
    facts: null,
    values: [],
    rows: { [REACH_WAY_SLOT]: rows },
  };
  const row = pickRow(reading, REACH_WAY_SLOT);
  return row.ok ? row.text : null;
}

/**
 * Reads the contact home's part of one flow (a bundle's flows.<flow> value, K-01 v1 flowGraph): the home step
 * (record.homes.contact), its one example line, which must be one of the record's own contact lines
 * (record.lint.phrases.contact) and hold the email way's reach.way phrase exactly once. Throws ContactHomeError, naming
 * every problem, when the flow is not one the contact home can read.
 */
export function readContactRecord(flow: FlowLetter, graph: unknown): ContactRecord {
  const problems: string[] = [];
  if (!isObj(graph) || !isObj(graph.record) || !isObj(graph.steps))
    throw new ContactHomeError(`flow ${flow} is not a flow graph with a record and steps`);
  const record = graph.record;
  const home = isObj(record.homes) ? record.homes.contact : undefined;
  if (!isLabel(home)) throw new ContactHomeError(`flow ${flow}'s record.homes has no contact home step`);

  const step = graph.steps[home];
  const more = isObj(step) ? strings(step.more) : null;
  const examples = (more ?? []).flatMap((line) => {
    const found = EXAMPLE.exec(line)?.[1];
    return found === undefined ? [] : [found];
  });
  const [example] = examples;
  if (examples.length !== 1 || example === undefined)
    problems.push(`step ${home} does not give one example line`);

  const lint = isObj(record.lint) && isObj(record.lint.phrases) ? record.lint.phrases : {};
  const phrases = strings(lint.contact) ?? [];
  if (phrases.length === 0) problems.push("record.lint.phrases has no contact lines");
  const isContactLine = (line: string): boolean =>
    phrases.some((phrase) => {
      try {
        return new RegExp(phrase).test(line);
      } catch {
        return false;
      }
    });
  if (example !== undefined && phrases.length > 0 && !isContactLine(example))
    problems.push(`step ${home}'s example is not one of the record's contact lines`);

  const slots = isObj(record.slots) ? record.slots : {};
  const rows = reachWayRows(slots[REACH_WAY_SLOT], home, problems);
  const phrase = rows === null ? null : phraseOfWay(rows, "email");
  if (rows !== null && phrase === null) problems.push(`slot ${REACH_WAY_SLOT} has no row for the email way`);

  const parts = example !== undefined && phrase !== null ? example.split(phrase) : [];
  const [before, after] = parts;
  if (example !== undefined && phrase !== null && parts.length !== 2)
    problems.push(
      `step ${home}'s example does not hold the email way's ${REACH_WAY_SLOT} phrase exactly once`,
    );

  if (problems.length > 0 || before === undefined || after === undefined)
    throw new ContactHomeError(`flow ${flow} cannot be read by the contact home`, problems);
  return { flow, home, privateLine: { before, after } };
}

/**
 * The line an owner or staff message about a private booking carries: S13-19's line with the booking record's
 * reach.way phrase for the person served's way. Throws ContactHomeError for a way that is calls only (MC C2; Q-07;
 * C-237), or a booking whose record cannot be read.
 */
export function handlingLineFor(record: ContactRecord, booking: RecordReading): HandlingLine {
  const problem = readingProblem(booking);
  if (problem !== null) throw new ContactHomeError("the booking's record cannot be read", [problem]);
  if (bookingValue(booking, "reach") === "callsonly")
    throw new ContactHomeError(
      "calls only is never offered (MC C2; Q-07), and S13-19's calls-only lines are unreachable (C-237)",
    );
  const row = pickRow(booking, REACH_WAY_SLOT);
  if (!row.ok) throw new ContactHomeError(`the booking's ${REACH_WAY_SLOT} phrase cannot be read`, [row.why]);
  return {
    line: PRIVATE_BOOKING_LINE,
    text: `${record.privateLine.before}${row.text}${record.privateLine.after}`,
  };
}
