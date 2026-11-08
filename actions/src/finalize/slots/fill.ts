// The slot filler (C-088): step 7 of a turn, after the composer and before the claim check and the message checks
// (arch 02 line 123: "Code inserts its options and fixed lines and fills its slots"; arch 07 line 409).
//
// Two moments:
//   fillPlan / fillText   when the plan is finalized: every slot is filled from the record and code facts, except
//                         'today' and 'tomorrow', which stay as {{today}} and {{tomorrow}} bound to the day each stands
//                         for (slotValues holds the day, YYYY-MM-DD in the reader's zone).
//   fillAtSend            when the row is sent: each send slot is worded against the send day in the reader's zone,
//                         so 'tomorrow' filled at 23:59 and sent at 00:01 reads 'today' (arch 07 line 409; slots.json
//                         today and tomorrow, filledBy "send"). A day already gone makes the row stale (K-07).
//
// The reader's zone is the visit's zone when the message is about a visit, else the business's (CQ-05's default).
// A plan with any unknown or unfilled slot fails: the slot stays as written, so '{{' is left in the text, and each
// problem carries the words the one rewrite is told (K-03 check-unfilled-slot.json; arch 02 line 123).

import { TimeFormatError, checkZone, isoDayIn, nextIsoDay } from "./clock";
import {
  FILLERS,
  type Binding,
  type DayRead,
  type FillContext,
  type NestedFill,
  type Outcome,
} from "./fillers";
import { pieces } from "./syntax";
import type { ReaderZones, SlotSource } from "./types";
import { isSlotName, type SendSlotName, type SlotName } from "./vocabulary";

/** A slot and the value it took (K-03 `fact`: finalParts.slotValues, which the Values check reads). */
export interface SlotValue {
  readonly slot: SlotName;
  readonly value: string;
}

/**
 * Why a text cannot go as it is: a slot outside the vocabulary or a '{{' that opens none (unknown), a slot with no
 * value (unfilled), or a send slot whose day has gone by (stale).
 */
export interface SlotProblem {
  readonly kind: "unknown" | "unfilled" | "stale";
  /** The slot's name as written; empty for a '{{' that opens no slot. */
  readonly slot: string;
  /** What failed, in the words the rewrite is told (K-03 checkOutcome.detail). */
  readonly detail: string;
  /** What was wrong with the fact behind it, for the log; null when there was simply none. */
  readonly why: string | null;
}

/** A text with its slots filled; when not ok, each slot that failed is left as written. */
export type TextFill =
  | { readonly ok: true; readonly text: string; readonly slotValues: readonly SlotValue[] }
  | {
      readonly ok: false;
      readonly text: string;
      readonly slotValues: readonly SlotValue[];
      readonly problems: readonly SlotProblem[];
    };

/** The plan's question (K-03 `question`): its words are filled, its option ids kept. */
export interface PlanQuestion {
  readonly text: string;
  readonly optionIds: readonly string[];
}

/** What fillPlan reads of a K-03 plan: its lines in order and its question. */
export interface PlanText<Line extends { readonly text: string }> {
  readonly lines: readonly Line[];
  readonly question: PlanQuestion | null;
}

/** A plan's lines and question with their slots filled, and every slot value in order of first use. */
export interface FilledPlan<Line extends { readonly text: string }> {
  readonly lines: readonly Line[];
  readonly question: PlanQuestion | null;
  readonly slotValues: readonly SlotValue[];
}

export type PlanFill<Line extends { readonly text: string }> =
  | (FilledPlan<Line> & { readonly ok: true })
  | (FilledPlan<Line> & { readonly ok: false; readonly problems: readonly SlotProblem[] });

/** When a row is sent, and the zones its reader's day is read in. */
export interface SendMoment {
  readonly sentAt: string;
  readonly zones: ReaderZones;
}

/** The reader's zone: the visit's zone when the message is about a visit, else the business's (CQ-05). */
export function readerZone(zones: ReaderZones): string {
  return zones.visit ?? zones.business;
}

/** A record row's slots are filled one level down; deeper than this is a loop in the rows. */
const MAX_DEPTH = 3;

function unfilled(slot: string, why: string | null): SlotProblem {
  return {
    kind: "unfilled",
    slot,
    detail: `The slot {{${slot}}} has no value, so '{{' is left in the text.`,
    why,
  };
}

function unknown(slot: string): SlotProblem {
  if (slot === "hold")
    return {
      kind: "unknown",
      slot,
      detail: "The slot {{hold}} is refused since D66 (nothing is held), so '{{' is left in the text.",
      why: null,
    };
  return {
    kind: "unknown",
    slot,
    detail: `The slot {{${slot}}} is not in the slot vocabulary, so '{{' is left in the text.`,
    why: null,
  };
}

const BROKEN: SlotProblem = {
  kind: "unknown",
  slot: "",
  detail: "A '{{' opens no slot, so '{{' is left in the text.",
  why: null,
};

type Segment = { readonly kind: "words"; readonly text: string } | { readonly kind: "empty" };

const SEPARATOR_BEFORE = /(\s+·\s+|,\s+|\s+[–—-]\s+)$/;
const SEPARATOR_AFTER = /^(\s+·\s+|,\s+|\s+[–—-]\s+)/;
const SPACE_BEFORE = /\s$/;

/**
 * Joins the pieces. An emptied slot takes one separator next to it, " · ", ", " or a dash, the one before it first,
 * else one space before it ("Lee's Barbershop · Sat 11am"; overlay-core.js fillText line 1406).
 */
function join(segments: readonly Segment[]): string {
  const out = segments.map((segment) => (segment.kind === "words" ? segment.text : ""));
  segments.forEach((segment, index) => {
    if (segment.kind !== "empty") return;
    const before = out[index - 1];
    const after = out[index + 1];
    if (before !== undefined && SEPARATOR_BEFORE.test(before))
      out[index - 1] = before.replace(SEPARATOR_BEFORE, "");
    else if (after !== undefined && SEPARATOR_AFTER.test(after))
      out[index + 1] = after.replace(SEPARATOR_AFTER, "");
    else if (before !== undefined && SPACE_BEFORE.test(before))
      out[index - 1] = before.replace(SPACE_BEFORE, "");
  });
  return out.join("");
}

function addValue(values: SlotValue[], slot: SlotName, value: string): void {
  if (!values.some((known) => known.slot === slot && known.value === value)) values.push({ slot, value });
}

function addProblem(problems: SlotProblem[], problem: SlotProblem): void {
  if (!problems.some((known) => known.kind === problem.kind && known.slot === problem.slot))
    problems.push(problem);
}

interface Filled {
  readonly text: string;
  readonly values: readonly SlotValue[];
  readonly bound: readonly Binding[];
  readonly problems: readonly SlotProblem[];
}

function readDay(read: () => string): DayRead {
  try {
    return { ok: true, day: read() };
  } catch (error) {
    if (error instanceof TimeFormatError) return { ok: false, why: error.message };
    throw error;
  }
}

function contextFor(source: SlotSource, depth: number): FillContext {
  const zone = (): string => {
    const name = readerZone(source.zones);
    checkZone(name);
    return name;
  };
  return {
    source,
    sendDay: (slot: SendSlotName) =>
      readDay(() => {
        const today = isoDayIn(source.filledAt, zone());
        return slot === "today" ? today : nextIsoDay(today);
      }),
    dayOf: (utc: string) => readDay(() => isoDayIn(utc, zone())),
    nested: (text: string): NestedFill => {
      const inner = fillAt(text, source, depth + 1);
      return { text: inner.text, missing: inner.problems.map((problem) => problem.slot), bound: inner.bound };
    },
  };
}

function fillAt(text: string, source: SlotSource, depth: number): Filled {
  const ctx = contextFor(source, depth);
  const segments: Segment[] = [];
  const values: SlotValue[] = [];
  const bound: Binding[] = [];
  const problems: SlotProblem[] = [];
  for (const piece of pieces(text)) {
    if (piece.kind === "words") {
      segments.push({ kind: "words", text: piece.text });
      continue;
    }
    if (piece.kind === "broken") {
      segments.push({ kind: "words", text: piece.text });
      addProblem(problems, BROKEN);
      continue;
    }
    const { ref } = piece;
    if (!isSlotName(ref.name)) {
      segments.push({ kind: "words", text: ref.raw });
      addProblem(problems, unknown(ref.name));
      continue;
    }
    const outcome: Outcome =
      depth > MAX_DEPTH
        ? { kind: "missing", why: "record rows name each other" }
        : FILLERS[ref.name].fill(ref, ctx);
    switch (outcome.kind) {
      case "value":
        segments.push({ kind: "words", text: outcome.value });
        addValue(values, ref.name, outcome.value);
        for (const binding of outcome.bound) {
          bound.push(binding);
          addValue(values, binding.slot, binding.day);
        }
        break;
      case "own":
        segments.push({ kind: "words", text: outcome.text });
        break;
      case "empty":
        segments.push({ kind: "empty" });
        addValue(values, ref.name, "");
        break;
      case "send":
        segments.push({ kind: "words", text: `{{${outcome.slot}}}` });
        bound.push({ slot: outcome.slot, day: outcome.day });
        addValue(values, outcome.slot, outcome.day);
        break;
      case "missing":
        segments.push({ kind: "words", text: ref.raw });
        addProblem(problems, unfilled(ref.name, outcome.why));
        break;
    }
  }
  return { text: join(segments), values, bound, problems };
}

function textFill(
  text: string,
  slotValues: readonly SlotValue[],
  problems: readonly SlotProblem[],
): TextFill {
  return problems.length === 0 ? { ok: true, text, slotValues } : { ok: false, text, slotValues, problems };
}

/** Fills one text's slots (a line, a question, or the step's fallback text: its master line with slots filled). */
export function fillText(text: string, source: SlotSource): TextFill {
  const filled = fillAt(text, source, 0);
  return textFill(filled.text, filled.values, filled.problems);
}

/**
 * Fills every slot of a plan's lines and question from the record and code facts. Fails when any slot is unknown or
 * has no value; the lines then keep each such slot as written, as the message checks will see it.
 */
export function fillPlan<Line extends { readonly text: string }>(
  plan: PlanText<Line>,
  source: SlotSource,
): PlanFill<Line> {
  const slotValues: SlotValue[] = [];
  const problems: SlotProblem[] = [];
  const take = (text: string): string => {
    const filled = fillAt(text, source, 0);
    for (const { slot, value } of filled.values) addValue(slotValues, slot, value);
    for (const problem of filled.problems) addProblem(problems, problem);
    return filled.text;
  };
  const lines = plan.lines.map((line): Line => ({ ...line, text: take(line.text) }));
  const question =
    plan.question === null
      ? null
      : { text: take(plan.question.text), optionIds: [...plan.question.optionIds] };
  return problems.length === 0
    ? { ok: true, lines, question, slotValues }
    : { ok: false, lines, question, slotValues, problems };
}

const ISO_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const SENTENCE_START = /(^\s*$|[.!?]\s+$|\n\s*$)/;

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/**
 * Words the send slots of one send's text at the moment it goes: {{today}} and {{tomorrow}} read 'today' or
 * 'tomorrow' against the send day in the reader's zone, from the day each was bound to when the plan was filled
 * (`slotValues`), capitalized where a sentence starts. Fails when a send slot has no bound day, when its day has gone
 * by (the row is stale and is composed again: K-07), or when any other slot is still in the text.
 */
export function fillAtSend(text: string, slotValues: readonly SlotValue[], send: SendMoment): TextFill {
  const sendDay = readDay(() => {
    const zone = readerZone(send.zones);
    checkZone(zone);
    return isoDayIn(send.sentAt, zone);
  });
  const out: string[] = [];
  const used: SlotValue[] = [];
  const problems: SlotProblem[] = [];
  for (const piece of pieces(text)) {
    if (piece.kind !== "slot") {
      out.push(piece.text);
      if (piece.kind === "broken") addProblem(problems, BROKEN);
      continue;
    }
    const { ref } = piece;
    if (ref.name !== "today" && ref.name !== "tomorrow") {
      out.push(ref.raw);
      addProblem(
        problems,
        isSlotName(ref.name)
          ? unfilled(ref.name, "only today and tomorrow are filled at send")
          : unknown(ref.name),
      );
      continue;
    }
    const slot: SendSlotName = ref.name;
    const day = slotValues.find((known) => known.slot === slot)?.value;
    if (day === undefined || !ISO_DAY.test(day) || !sendDay.ok) {
      out.push(ref.raw);
      addProblem(
        problems,
        unfilled(slot, sendDay.ok ? "no day was bound to it when the plan was filled" : sendDay.why),
      );
      continue;
    }
    const word = day === sendDay.day ? "today" : day === nextIsoDay(sendDay.day) ? "tomorrow" : null;
    if (word === null) {
      out.push(ref.raw);
      addProblem(
        problems,
        day < sendDay.day
          ? {
              kind: "stale",
              slot,
              detail: `The day {{${slot}}} stood for has gone by, so the message is composed again.`,
              why: `bound to ${day}, sent on ${sendDay.day}`,
            }
          : unfilled(slot, `bound to ${day}, more than a day after the send day ${sendDay.day}`),
      );
      continue;
    }
    out.push(SENTENCE_START.test(out.join("")) ? capitalized(word) : word);
    addValue(used, slot, word);
  }
  return textFill(out.join(""), used, problems);
}
