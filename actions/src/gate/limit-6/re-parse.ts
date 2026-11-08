// Limit 6, Values (C-086, T-304; arch 06 line 309): "Each value re-parses from its source words, or from the read-back
// the owner said yes to for a photo (S1-13, S1-83). Dates resolve from the text's send time in the visit's zone: the
// business's in flow A, the visit address's in flow B; video or phone visits show both (S13-03)." On failure: "One Sonnet
// re-read, then one question, then nothing changes": K-09 v1 limit6Outcome oneQuestion (ask), then nothingChanged
// (refuse). Before decide's one re-read the gate answers any failure here as valueFailsWords, naming the fields
// (framework/gate.ts; K-09 v1 rule rereadBeforeQuestion).
//
// For one gated part, each field decide gave (K-02 v1 field: name, value, words), in its choice's type (K-02 v1
// choice.fields; contracts/bundle answerField.type):
//   1. a part with no field (pass_on, hand_off, a choose or enter with none) has nothing to re-parse: notChecked;
//   2. a value read from a photo (the photo port, C-120's) passes only with the read-back of it the owner said yes to,
//      re-parsed from that read-back's words: never from a caption, never before the yes;
//   3. any other value re-parses from its words (actions/src/values reparse) as each text that carries them sent them:
//      a value no text carries fails. A text carries the words only where they stand in it whole, starting and ending
//      at a word edge of the text as the readers fold it (values foundAtWordEdges; DL-184, DL-189): "40" cut out of
//      "raise haircut to 140", "tomorrow at 1" out of "tomorrow at 10", "$1" out of "$1,200" or "$1，200", "Oct 2" out of
//      "Oct 24", "2" out of "12 people", "1" out of "10am" and "40" out of 140 with a zero-width space inside are carried
//      by no text, so they fail (noText) and never re-parse as a value the person did not say. A number's value (money,
//      a count, a date or time) is then re-read from its whole value phrase in each text that carries its words (values
//      wholePhraseFault; DL-189 item 2), and the phrase is the readers' own (DL-199): the person's whole text is read
//      with the same reader that read the field, and the value must hold on the reading whose span holds the cited
//      words, every number and zone word in it read. So a unit, currency, scale, day, part of the day or zone the words
//      leave out fails: "40" out of "40%" (noText), "40¢" or "40 euros" (differs), "$1" out of "$1 million" (differs),
//      "3 tomorrow" out of "quarter to 3 tomorrow", "tomorrow at 3pm" out of "the day after tomorrow at 3pm", "at 3" out
//      of "tomorrow afternoon at 3", "tomorrow" out of "tomorrow at noon" (differs), "tomorrow at 3pm" out of "tomorrow
//      at 3pm, PST" for a New York visit (wrongZone). A bare hour beside a day joins the day's phrase whatever other time
//      the text holds (DL-209): "Thursday" out of "my 2pm doesn't work. can we do Thursday, 3?" differs, as do
//      "tomorrow morning" out of "tomorrow morning, 9", "$40" out of "MXN $40" and "$1M" read as $1;
//   4. a date or time resolves from that text's send time in the visit's zone (visitZonesOf): the booking's own zone
//      (K-02 v1 target.visitAt, which the frontier fills from the record), else the business's in flow A (K-04 v1
//      business head), else the visit address's in flow B (CQ-08), else the business's (CQ-05); for a video or phone
//      visit also the other side's zone, since both are shown (S13-03): a value in either zone re-parses.
// Every field that fails is named, by its K-02 name; the part fails on any.
//
// The residual (DL-199 item 4; CQ-121): words no reader knows are not read, so a cut beside them is not caught here:
// "next week" ("Friday" out of "Friday next week"), "LA time", "UTC", "after next", "a week from", "around 3" with no
// cue the time reader knows, "$40 off", and a sentence mark (". ! ? ;") between a day and its time ("at 3pm" out of
// "tomorrow. at 3pm"), which the lead confirmed as part of the residual at round 5 (DL-209; values/phrase.ts).
// Limit 3's read-back shows the person every value before any commit, and limit 5 checks a time against the open times,
// so neither books on such a cut.
//
// Nothing here logs. What it returns names fields, labels and limits: never a value or a person's words.
//
// Defaults used (for ops/QUESTIONS.md):
//   1. "One question, then nothing changes": the one question is the part's question asked again (K-04 ask_count one
//      more, as limit 3's fresh read-back is: T-301 default 4), so a value that fails on a question asked twice or more
//      gives nothingChanged; any other failure gives oneQuestion. An option's question is the open question it answers;
//      a door's, an any-time row's, a hub case's (and a which-booking or entry step choice's) is the open question its
//      step asked about its target (K-02 v1 openQuestion: the same step, business and booking), the most asked when
//      several are, so a value failing on one of them is not asked again every turn either (DL-184 item 3).
//   2. A value re-parses when its words name exactly one value of its type and it is the model's (values/reparse.ts):
//      words naming two ("$40 deposit, $100 after", "3 or 4pm") fail, and so do words naming none (a price the model
//      gave with no amount in its words). An hour with no am or pm may be either; a time with no day is the next time
//      the clock reads it; a day with no time is its start (values/times.ts).
//   3. A bare number in a price's words is dollars when nothing else there is money ("raise haircut to 40": S11-20;
//      "75": S1-13); every amount is USD (values/money.ts DEFAULT_CURRENCY).
//   4. A text value re-parses when every one of its words is a word of its words, case, accents and punctuation aside
//      (K-09 commit-limit-6-value-fails.json: "Barbershop, plumbing" does not re-parse from "barbering and some other
//      stuff").
//   5. A time value must also name the zone it resolved in, and that zone must be the visit's (or, for a video or phone
//      visit, the other side's): the right instant shown in the wrong zone fails.
//   6. The visit's flow is its step's (A or B, K-01 stepId), else the context's (K-02 v1 context.flow).
//   7. Words several texts of the turn carry must re-parse as each one sent them.
//   8. The text's language (K-02 v1 decideResult.language) picks the number words read: English or Spanish, both when
//      decide gave none.
//   9. Words that stand whole at several places in a text must hold their value on the whole phrase at each place. What
//      joins a phrase (the time cues, the range words, a number right after a time or an amount) and a per-unit after an
//      amount being no part of its value ("$40/hr" is $40, as "$12 a foot" is $12) are values/phrase.ts's and
//      values/money.ts's (DL-189, DL-199). A currency sign the reader does not know is no dollar (ISO's XXX), "pesos"
//      are Mexican pesos, and "mil" is a thousand in a Spanish text and a million in an English one (values/money.ts).
//  10. Round 5 (DL-209): a bare hour beside a day or after a part-of-day word joins the phrase beside it when the time
//      reader takes it reading that phrase with the hour on its own, so "2" of "table for 2 tomorrow at 3pm" stays out
//      (values/phrase.ts step 3b); a comma not followed by a digit may end a bare hour ("3, tomorrow"); "M" or "MM" right
//      after an amount is a million and "B" or "bn" a billion, glued to the number only ("$1M"; "$1 M" is not read); a
//      currency code right before a sign names its currency ("MXN $40"), as does a currency word right after a sign
//      ("40$ CAD") (values/times.ts, values/money.ts).

import {
  foundAtWordEdges,
  isPhraseType,
  isZone,
  languagesOf,
  reparse,
  wholePhraseFault,
  type ChoiceOption,
  type FieldType,
  type FieldValue,
  type ReparseFault,
} from "../../values";
import type { Choice, Context, GatePart, GateTurn, LimitOutcomes } from "../framework";
import type { BusinessZones, PhotoReadings, ValueSource, VisitPlaces } from "./facts";

/** Limit 6's outcomes when it fails (K-09 v1 limit6Outcome). */
export type Limit6Outcome = LimitOutcomes[6];

/** One question; nothing changes for the part meanwhile (K-09 v1: ask). */
export function oneQuestionOutcome(): Limit6Outcome {
  return { limit: 6, outcome: "ask", action: "oneQuestion" };
}

/** Then nothing changes (K-09 v1: refuse). */
export function nothingChangedOutcome(): Limit6Outcome {
  return { limit: 6, outcome: "refuse", action: "nothingChanged" };
}

/** A question asked this many times has had its one question: a failure then changes nothing (default 1). */
export const ASKS_BEFORE_NOTHING_CHANGES = 2;

/**
 * Why one value fails, as a label: a re-parse fault (values/reparse.ts), or
 *   noText            no text of the turn carries its words whole (at word edges: values foundAtWordEdges);
 *   photoNotReadBack  read from a photo, and no read-back of it has gone out;
 *   photoNotApproved  read from a photo, and the owner has not said yes to its read-back.
 */
export type ValueFault = ReparseFault | "noText" | "photoNotReadBack" | "photoNotApproved";

/** One field that failed, by its K-02 name, and why. */
export interface FieldFault {
  readonly field: string;
  readonly why: ValueFault;
}

export type ValuesDecision =
  | { readonly result: "pass" }
  | { readonly result: "notChecked" }
  | {
      readonly result: "fail";
      readonly outcome: Limit6Outcome;
      /** Each field whose value failed, by its K-02 name, once, in the part's order. */
      readonly fields: readonly [string, ...string[]];
      readonly faults: readonly FieldFault[];
    };

/** What the rule reads, made only when it needs them. */
export interface ValuesPorts {
  readonly businessZones: () => BusinessZones;
  readonly places: VisitPlaces;
  readonly photos: PhotoReadings;
}

const PASS: ValuesDecision = { result: "pass" };
const NOT_CHECKED: ValuesDecision = { result: "notChecked" };

type Text = Context["texts"][number];
type Field = Extract<GatePart["part"], { verb: "choose" | "enter" }>["fields"][number];

// ---- the visit's zone (S13-03; CQ-05; CQ-08) --------------------------------------------------------------------------

/** Where the zone a date resolves in came from. */
export type ZoneFrom = "booking" | "business" | "visitAddress" | "none";

export interface VisitZones {
  /** The zones a date may resolve in: the visit's first, then for a video or phone visit the other side's. */
  readonly zones: readonly string[];
  readonly from: ZoneFrom;
}

/** The visit's flow: its step's letter (K-01 stepId: A4-14, B7-07), else the turn's (K-02 v1 context.flow) (default 6). */
export function flowOf(choice: Choice, context: Context): "A" | "B" {
  const letter = choice.step.charAt(0);
  return letter === "A" || letter === "B" ? letter : context.flow;
}

/** The zones a part's dates resolve in (S13-03): the visit's own, and for a video or phone visit the other side's. */
export async function visitZonesOf(choice: Choice, turn: GateTurn, ports: ValuesPorts): Promise<VisitZones> {
  const { target } = choice;
  const flow = flowOf(choice, turn.context);
  const place = await ports.places.placeOf(
    { businessId: target.businessId, bookingId: target.bookingId, flow },
    turn,
  );
  let zone: string | null = null;
  let from: ZoneFrom = "none";
  if (target.visitAt !== null && isZone(target.visitAt.zone)) {
    zone = target.visitAt.zone;
    from = "booking";
  } else if (flow === "B" && isZone(place.addressZone)) {
    zone = place.addressZone;
    from = "visitAddress";
  } else {
    const business = await ports.businessZones().zoneOf(target.businessId);
    if (isZone(business)) {
      zone = business;
      from = "business";
    }
  }
  if (zone === null) return { zones: [], from };
  const both = place.remote && isZone(place.otherZone) && place.otherZone !== zone;
  return { zones: both ? [zone, place.otherZone] : [zone], from };
}

// ---- one field --------------------------------------------------------------------------------------------------------

/** The options a choice field picks among: the offered choices that answer the part's own question, in order. */
function optionsOf(choice: Choice, context: Context): ChoiceOption[] {
  if (choice.question === null) return [];
  return context.choices
    .filter((offered) => offered.question === choice.question && offered.kind === choice.kind)
    .map((offered) => ({ id: offered.choiceId, label: offered.branch ?? offered.label }));
}

interface FieldRun {
  readonly part: GatePart;
  readonly choice: Choice;
  readonly turn: GateTurn;
  readonly ports: ValuesPorts;
  /** The visit's zones, read once and only for a date or time. */
  readonly zones: () => Promise<VisitZones>;
}

/** The type the part's choice gives the field (K-02 v1 choice.fields); the gate's checks made sure it carries it. */
function typeOf(choice: Choice, field: Field): FieldType {
  const carried = choice.fields.find((each) => each.name === field.name);
  if (carried === undefined) throw new TypeError("limit 6 got a field its choice does not carry");
  return carried.type;
}

/** Re-parses one value from `words`, sent at each of `sentAts`: null when it does, else the first fault. */
async function reparsed(
  type: FieldType,
  value: FieldValue,
  words: string,
  sentAts: readonly string[],
  run: FieldRun,
): Promise<ValueFault | null> {
  const zones = type === "time" ? (await run.zones()).zones : [];
  const options = type === "choice" ? optionsOf(run.choice, run.turn.context) : [];
  const languages = languagesOf(run.turn.decide.language);
  for (const sentAt of sentAts) {
    const result = reparse(type, value, words, { sentAt, zones, languages, options });
    if (!result.ok) return result.why;
  }
  return null;
}

/** Why one value fails, or null when it re-parses. */
async function faultOf(field: Field, run: FieldRun): Promise<ValueFault | null> {
  const type = typeOf(run.choice, field);
  const texts: Text[] = run.turn.context.texts.filter((text) => foundAtWordEdges(text.words, field.words));
  const source: ValueSource = await run.ports.photos.sourceOf(
    {
      part: run.part.index,
      field: field.name,
      attachmentIds: texts.flatMap((text) => text.attachments.map((each) => each.attachmentId)),
    },
    run.turn,
  );
  if (source.from === "photo") {
    if (source.readBack === null) return "photoNotReadBack";
    if (!source.readBack.ownerSaidYes) return "photoNotApproved";
    return reparsed(type, field.value, source.readBack.words, [source.readBack.sentAt], run);
  }
  if (texts.length === 0) return "noText";
  const cited = await reparsed(
    type,
    field.value,
    field.words,
    texts.map((text) => text.sentAt.utc),
    run,
  );
  return cited ?? (await wholeReparsed(type, field.value, field.words, texts, run));
}

/**
 * Re-reads a number's value (money, a count, a date or time) from the whole value phrase its words stand in, in each text
 * that carries them (values wholePhraseFault; DL-189 item 2): null when every one gives the same value, else the fault.
 */
async function wholeReparsed(
  type: FieldType,
  value: FieldValue,
  words: string,
  texts: readonly Text[],
  run: FieldRun,
): Promise<ValueFault | null> {
  if (!isPhraseType(type)) return null;
  const zones = type === "time" ? (await run.zones()).zones : [];
  const languages = languagesOf(run.turn.decide.language);
  for (const text of texts) {
    const context = { sentAt: text.sentAt.utc, zones, languages };
    const why = wholePhraseFault(type, value, text.words, words, context);
    if (why !== null) return why;
  }
  return null;
}

type OpenQuestion = Context["openQuestions"][number];

/**
 * Whether an open question is the part's own (default 1): an option's is the open question it answers; any other
 * choice's (a door, an any-time row, a hub case) is the one its step asked about its target, the same business and booking.
 */
function isPartQuestion(choice: Choice, question: OpenQuestion): boolean {
  if (choice.kind === "option") return question.openQuestionId === choice.question;
  return (
    question.step === choice.step &&
    question.target.businessId === choice.target.businessId &&
    question.target.bookingId === choice.target.bookingId
  );
}

/** How many times the part's question has been asked: the most of its open questions, 1 when none is open. */
export function askCountOf(choice: Choice, context: Context): number {
  let asked = 1;
  for (const question of context.openQuestions) {
    if (isPartQuestion(choice, question)) asked = Math.max(asked, question.askCount);
  }
  return asked;
}

/** The outcome of a failure: one question, or nothing changes once the part's question was asked again (default 1). */
function outcomeFor(choice: Choice, context: Context): Limit6Outcome {
  return askCountOf(choice, context) >= ASKS_BEFORE_NOTHING_CHANGES
    ? nothingChangedOutcome()
    : oneQuestionOutcome();
}

// ---- the rule ---------------------------------------------------------------------------------------------------------

/** Limit 6 on one agreed part: pass, notChecked, or the failure naming each field whose value failed. */
export async function decideValues(
  part: GatePart,
  turn: GateTurn,
  ports: ValuesPorts,
): Promise<ValuesDecision> {
  const { part: said, choice } = part;
  if (said.verb !== "choose" && said.verb !== "enter") return NOT_CHECKED;
  if (said.fields.length === 0) return NOT_CHECKED;
  if (choice === null) throw new TypeError("limit 6 got a choose or enter part without its offered choice");
  let zones: Promise<VisitZones> | null = null;
  const run: FieldRun = {
    part,
    choice,
    turn,
    ports,
    zones: () => (zones ??= visitZonesOf(choice, turn, ports)),
  };
  const faults: FieldFault[] = [];
  for (const field of said.fields) {
    const why = await faultOf(field, run);
    if (why !== null) faults.push({ field: field.name, why });
  }
  const [first, ...rest] = [...new Set(faults.map((each) => each.field))];
  if (first === undefined) return PASS;
  return { result: "fail", outcome: outcomeFor(choice, turn.context), fields: [first, ...rest], faults };
}
