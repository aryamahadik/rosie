// The claim check, limit 7 (C-091; T-311): "Each slot's field may be seen by this recipient: customer, staff, owner,
// or secure page only (RULES 4.5); with the sensitive switch on, the service and reason are secure page only and staff
// see initials (RULES 4.6, S13-22). | A secure-page-only field reads 'Read it on the secure page'; one this recipient may
// never see is cut, with its sentence (RULES 4.5; DD)" (arch 06 line 311).
//
// Step 7 of a turn (arch 02 line 123): the composer's plan is claimed, then filled. Each slot of the plan's lines and
// question is judged for the reader before code fills it (slots/fill.ts), so a value the reader may not see is never
// written into the text at all:
//   show           the reader is in every audience that covers the slot: it is filled as it is;
//   sensitiveForm  shown in its sensitive form under the switch: initials, the display name, or for the service nothing
//                  (or the words after '|'), since the service is secure page only (K-03 v1 `sensitiveForm`);
//   securePage     the field is secure page only: the slot reads "Read it on the secure page";
//   cut            the reader may never see it, or its audience cannot be read: its sentence is cut.
// A slot outside the vocabulary is left as written, so the fill refuses the plan (K-03 refuse-hold-slot.json). The
// claims carry slot names and closed reasons only, never a value, so they may be logged (the value never is).

import {
  FILLERS,
  RECORD_SLOT_NAMES,
  fillPlan,
  fillText,
  isSlotName,
  pickRow,
  type PlanFill,
  type PlanQuestion,
  type PlanText,
  type SlotName,
  type SlotSource,
  type SlotValue,
  type TextFill,
} from "../slots";
import { pieces, type Piece } from "../slots/syntax";
import { narrowest, type Reader } from "./audience";
import { QUOTE_SLOT, SLOT_FIELDS, fieldAudience, slotAudienceOf } from "./fields";

/** The words a secure-page-only field reads in a text, word for word (arch 06 line 311; RULES 4.5; A7-12). */
export const SECURE_PAGE_WORDS = "Read it on the secure page";

/** What limit 7 does with one slot for this reader. */
export type Verdict = "show" | "sensitiveForm" | "securePage" | "cut";

/** Why: closed reasons only, never a value. */
export type ClaimWhy =
  /** The reader is in every audience that covers the slot. */
  | "inAudience"
  /** An audience that covers the slot leaves this reader out. */
  | "notInAudience"
  /** A field no message may show. */
  | "never"
  /** A field or audience the claim check cannot read: never shown (fail closed). */
  | "unknownField"
  /** A field only the secure page shows. */
  | "securePageOnly"
  /** A person's own words that hold something private, or were not read clear (RULES 4.5). */
  | "privateWords"
  /** The sensitive switch: the service and the reason only on the secure page, names as initials (RULES 4.6). */
  | "sensitive"
  /** A slot inside the record row this slot fills (K-01 record.slots) is cut or secure page only. */
  | "nested";

/** Limit 7's answer for one slot of the plan. */
export interface SlotClaim {
  readonly slot: SlotName;
  readonly verdict: Verdict;
  readonly why: ClaimWhy;
}

/** What the claim check reads besides the plan and the slot source. */
export interface ClaimContext {
  /** Who reads this row (K-03 composeInput `audience.role`): readerOf() of the recipient's role at this business. */
  readonly reader: Reader;
  /**
   * The fields a slot's value was read from, where they are not SLOT_FIELDS' (part.table.column of a frozen table list),
   * such as visit.place: ["business-setup.locations.address"] for a flow A visit. A list naming no field, or a field no
   * table list holds, is never shown.
   */
  readonly fields?: Readonly<Partial<Record<SlotName, readonly string[]>>>;
  /**
   * True only when the relayed words (relay.quote) were read and hold nothing private (RULES 4.5: health, a child's
   * details, money details beyond an amount, ID numbers, legal or immigration status, door codes and keys, why a person
   * was turned away). Anything else, unset included, keeps them on the secure page: "When unsure, treat it as private."
   */
  readonly quoteClear?: boolean;
}

/** The slots the filler fills inside a record row, and the depth it stops at (slots/fill.ts MAX_DEPTH). */
const MAX_DEPTH = 3;

type RecordSlotName = (typeof RECORD_SLOT_NAMES)[number];

const RECORD_SLOTS: ReadonlySet<string> = new Set<string>(RECORD_SLOT_NAMES);

function isRecordSlot(slot: SlotName): slot is RecordSlotName {
  return RECORD_SLOTS.has(slot);
}

/** How far each verdict keeps a field back; a sensitive form inside a row is the filler's, so it ranks as shown. */
const RANK: Readonly<Record<Verdict, number>> = { show: 0, sensitiveForm: 0, securePage: 1, cut: 2 };

/** The slot's own claim: its K-03 audience and every field it reads, then the quote rule and the sensitive switch. */
function ownClaim(slot: SlotName, sensitive: boolean, context: ClaimContext): SlotClaim {
  const claim = (verdict: Verdict, why: ClaimWhy): SlotClaim => ({ slot, verdict, why });
  const named = context.fields?.[slot];
  const fields = named ?? SLOT_FIELDS[slot];
  const reach = narrowest([
    slotAudienceOf(slot),
    ...(fields.length === 0 && named !== undefined ? [null] : fields.map(fieldAudience)),
  ]);
  if (reach.kind === "unknown") return claim("cut", "unknownField");
  if (reach.kind === "never") return claim("cut", "never");
  if (!reach.readers.has(context.reader)) return claim("cut", "notInAudience");
  if (reach.securePageOnly) return claim("securePage", "securePageOnly");
  if (slot === QUOTE_SLOT) {
    if (context.quoteClear !== true) return claim("securePage", "privateWords");
    if (sensitive) return claim("securePage", "sensitive");
  }
  if (sensitive) {
    switch (FILLERS[slot].sensitiveForm) {
      case "initials":
      case "displayName":
      case "emptyOrAlternate":
        return claim("sensitiveForm", "sensitive");
      case "securePageOnly":
        return claim("securePage", "sensitive");
      case "asIs":
        break;
    }
  }
  return claim("show", "inAudience");
}

/** The vocabulary slots a text names, each once, in order. */
function slotsIn(text: string): SlotName[] {
  const out: SlotName[] = [];
  for (const piece of pieces(text)) {
    if (piece.kind === "slot" && isSlotName(piece.ref.name) && !out.includes(piece.ref.name))
      out.push(piece.ref.name);
  }
  return out;
}

/**
 * A slot's claim at a depth of record rows: a record slot (K-01 record.slots) fills the row whose `when` fits, with the
 * slots inside it, so it is kept back as far as the furthest of them is (a slot inside a row is never shown to a reader
 * the row's slot may not show it to).
 */
function claimAt(slot: SlotName, source: SlotSource, context: ClaimContext, depth: number): SlotClaim {
  const own = ownClaim(slot, source.sensitive, context);
  if (own.verdict === "cut" || depth > MAX_DEPTH || source.record === null || !isRecordSlot(slot)) return own;
  const row = pickRow(source.record, slot);
  if (!row.ok) return own;
  let claim = own;
  for (const inner of slotsIn(row.text)) {
    const nested = claimAt(inner, source, context, depth + 1);
    if (RANK[nested.verdict] > RANK[claim.verdict]) claim = { slot, verdict: nested.verdict, why: "nested" };
  }
  return claim;
}

/** The sensitive switch's name among the record's live switches (K-01 record.live: sensitive, no2, welfare, ...). */
const SENSITIVE_SWITCH = "sensitive";

/**
 * The slot source with the sensitive switch on when either the source or the record's live switches say so (fail
 * closed: RULES 4.6, S13-22), so limit 7 and the filler apply the same switch.
 */
function switched(source: SlotSource): SlotSource {
  if (source.sensitive) return source;
  return source.record?.switches.includes(SENSITIVE_SWITCH) === true
    ? { ...source, sensitive: true }
    : source;
}

/** Limit 7's answer for one slot, for this reader and this slot source (its sensitive switch and its record rows). */
export function claimSlot(slot: SlotName, source: SlotSource, context: ClaimContext): SlotClaim {
  return claimAt(slot, switched(source), context, 0);
}

/** Each slot's claim, worked out once, in order of first use. */
interface Claims {
  of(slot: SlotName): SlotClaim;
  list(): SlotClaim[];
}

/** The claims of one text or plan, on a source whose switch is already applied (switched). */
function claimsFor(source: SlotSource, context: ClaimContext): Claims {
  const known = new Map<SlotName, SlotClaim>();
  return {
    of(slot) {
      const claimed = known.get(slot) ?? claimAt(slot, source, context, 0);
      known.set(slot, claimed);
      return claimed;
    },
    list: () => [...known.values()],
  };
}

// A sentence ends after '.', '!' or '?' (with any closing quote or bracket) and the spaces after it, or after a line
// break; the spaces or the break stay with the sentence they end. A slot is one piece, so its example words never end
// a sentence.
const SENTENCE_END = /[.!?]+["'”’)\]]*[ \t]+|\r?\n/g;

/** A text's pieces, sentence by sentence (slots/syntax.ts pieces: the filler's own reading of the slots). */
function sentencesOf(text: string): Piece[][] {
  const sentences: Piece[][] = [];
  let sentence: Piece[] = [];
  for (const piece of pieces(text)) {
    if (piece.kind !== "words") {
      sentence.push(piece);
      continue;
    }
    let from = 0;
    for (const match of piece.text.matchAll(SENTENCE_END)) {
      const end = match.index + match[0].length;
      sentence.push({ kind: "words", text: piece.text.slice(from, end) });
      sentences.push(sentence);
      sentence = [];
      from = end;
    }
    if (from < piece.text.length) sentence.push({ kind: "words", text: piece.text.slice(from) });
  }
  if (sentence.length > 0) sentences.push(sentence);
  return sentences;
}

interface Claimed {
  readonly text: string;
  /** A sentence was cut. */
  readonly cut: boolean;
}

/**
 * A text with limit 7 applied, its slots still to fill: a sentence with a slot the reader may never see is cut, a
 * secure-page-only slot becomes "Read it on the secure page", every other slot stays for the fill.
 */
function claimWords(text: string, claims: Claims): Claimed {
  const kept: string[] = [];
  let cut = false;
  for (const sentence of sentencesOf(text)) {
    const words: string[] = [];
    let dropped = false;
    for (const piece of sentence) {
      if (piece.kind !== "slot") {
        words.push(piece.text);
        continue;
      }
      const { ref } = piece;
      // A slot outside the vocabulary stays as written: the fill refuses it, so the text never goes as it is.
      if (!isSlotName(ref.name)) {
        words.push(ref.raw);
        continue;
      }
      const claim = claims.of(ref.name);
      if (claim.verdict === "cut") dropped = true;
      words.push(claim.verdict === "securePage" ? SECURE_PAGE_WORDS : ref.raw);
    }
    if (dropped) cut = true;
    else kept.push(words.join(""));
  }
  const joined = kept.join("");
  return { text: cut ? joined.trim() : joined, cut };
}

/** A plan's lines and question after limit 7, filled; with each slot's claim. */
export type ClaimedPlan<Line extends { readonly text: string }> = PlanFill<Line> & {
  /** Each slot of the plan's lines and question, in order of first use. */
  readonly claims: readonly SlotClaim[];
  /**
   * The question's words were cut whole, so the message asks nothing and its option ids go with it: the plan named a
   * field this reader may never see in its question, which the rewrite is told (arch 02 line 123).
   */
  readonly questionCut: boolean;
};

/**
 * Limit 7 on a plan, then the fill (arch 02 line 123): each line and the question claimed for this reader, a line left
 * with no words removed, every remaining slot filled from the slot source (T-310), whose sensitive switch is the one
 * limit 7 applies, so the filler writes the sensitive forms the claims name.
 */
export function claimPlan<Line extends { readonly text: string }>(
  plan: PlanText<Line>,
  source: SlotSource,
  context: ClaimContext,
): ClaimedPlan<Line> {
  const sourced = switched(source);
  const claims = claimsFor(sourced, context);
  const lines: Line[] = [];
  for (const line of plan.lines) {
    const claimed = claimWords(line.text, claims);
    if (claimed.cut && claimed.text === "") continue;
    lines.push({ ...line, text: claimed.text });
  }
  let question: PlanQuestion | null = null;
  if (plan.question !== null) {
    const claimed = claimWords(plan.question.text, claims);
    if (!claimed.cut || claimed.text !== "")
      question = { text: claimed.text, optionIds: [...plan.question.optionIds] };
  }
  const filled = fillPlan({ lines, question }, sourced);
  return { ...filled, claims: claims.list(), questionCut: plan.question !== null && question === null };
}

/** One text after limit 7, filled, with each slot's claim: the step's fallback text, its master line (arch 02 line 123). */
export type ClaimedText = TextFill & { readonly claims: readonly SlotClaim[] };

/** Limit 7 on one text, then the fill: the step's fallback text goes through the same checks (arch 02 line 123). */
export function claimText(text: string, source: SlotSource, context: ClaimContext): ClaimedText {
  const sourced = switched(source);
  const claims = claimsFor(sourced, context);
  const claimed = claimWords(text, claims);
  return { ...fillText(claimed.text, sourced), claims: claims.list() };
}

/**
 * The composer's facts for this reader (K-03 v1 composeInput `facts`: "only what limit 7 lets this reader see, each as
 * a slot name and its value"; `fact.value`): each slot filled by code and claimed. A secure-page-only field, the service
 * under the sensitive switch among them, reads "Read it on the secure page"; a field this reader may never see is not
 * given at all, nor is one code cannot fill; under the switch a name is given as initials and the business by its
 * display name.
 */
export function claimFacts(
  slots: readonly SlotName[],
  source: SlotSource,
  context: ClaimContext,
): SlotValue[] {
  const sourced = switched(source);
  const facts: SlotValue[] = [];
  for (const slot of slots) {
    if (!isSlotName(slot) || facts.some((fact) => fact.slot === slot)) continue;
    const claim = claimAt(slot, sourced, context, 0);
    if (claim.verdict === "cut") continue;
    const onPage =
      claim.verdict === "securePage" ||
      (claim.verdict === "sensitiveForm" && FILLERS[slot].sensitiveForm === "emptyOrAlternate");
    if (onPage) {
      facts.push({ slot, value: SECURE_PAGE_WORDS });
      continue;
    }
    const filled = fillText(`{{${slot}}}`, sourced);
    const value = filled.slotValues.find((known) => known.slot === slot)?.value;
    if (filled.ok && value !== undefined) facts.push({ slot, value });
  }
  return facts;
}
