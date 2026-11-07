// The slot vocabulary the compiler writes into message lines (T-142; K-03 v1 contracts/message-plan/fixtures/slots.json).
//
// A slot is written in a line as the master writes it: `{{name}}`, `{{name:example}}` or `{{name:example|other words}}`
// (SPEC-master 5h; overlay-core.js SLOT_RE). K-03 v1 holds 52 names: the record's 16, the 8 auto-fill slots, the amounts,
// the ledger amounts, today and tomorrow, the 4 links, and the 11 slots the compiler makes from sample values (proposed
// names, CQ-17). Every slot the compiler writes must be one of them. A name outside the list is refused as
// UnknownSlotError (the lint rule `unknown-slot`, as contracts/bundle/fixtures/invalid/refuse-unknown-slot.json is), and
// `{{hold}}` as HoldSlotError (D66: nothing is held).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HoldSlotError } from "../record";

/** K-03 slots.json, as the compiler reads it. */
export interface SlotEntry {
  name: string;
  kind: string;
  status: string;
  valueType: string;
  filledBy: string;
}

/** A slot name outside the vocabulary (the bundle lint rule `unknown-slot`). */
export class UnknownSlotError extends Error {
  override name = "UnknownSlotError";
  /** The lint rule this refusal is: K-01's `unknown-slot`. */
  readonly code = "unknown-slot";
  readonly slot: string;
  readonly at: string;

  constructor(at: string, slot: string, known: number) {
    super(`${at}: the slot {{${slot}}} is not one of the vocabulary's ${String(known)} slots`);
    this.slot = slot;
    this.at = at;
  }
}

/** Braces that do not make a slot, such as `{{ }}` or an unclosed `{{`. */
export class MalformedSlotError extends Error {
  override name = "MalformedSlotError";
  readonly at: string;

  constructor(at: string, text: string) {
    super(`${at}: braces that are not a slot: "${text.slice(0, 60)}"`);
    this.at = at;
  }
}

const SLOTS_FILE = fileURLToPath(
  new URL("../../../contracts/message-plan/fixtures/slots.json", import.meta.url),
);

let cached: readonly SlotEntry[] | null = null;

/** The K-03 v1 vocabulary, read once from contracts/message-plan/fixtures/slots.json. */
export function slotVocabulary(): readonly SlotEntry[] {
  if (cached !== null) return cached;
  const raw = JSON.parse(readFileSync(SLOTS_FILE, "utf8")) as { slots?: unknown };
  if (!Array.isArray(raw.slots)) throw new Error(`${SLOTS_FILE}: no slots list`);
  cached = (raw.slots as SlotEntry[]).map((slot) => ({
    name: slot.name,
    kind: slot.kind,
    status: slot.status,
    valueType: slot.valueType,
    filledBy: slot.filledBy,
  }));
  return cached;
}

/** The vocabulary's slot names, in the file's order. */
export function slotNames(): string[] {
  return slotVocabulary().map((slot) => slot.name);
}

/** One slot as written in a line: `{{name:example|other}}`. */
export interface SlotRef {
  /** The whole `{{...}}`. */
  raw: string;
  name: string;
  example?: string;
  other?: string;
  index: number;
}

/** Any `{{ ... }}` with no brace inside. */
export const BRACES = /\{\{[^{}]*\}\}/g;
const SLOT_BODY = /^\{\{\s*([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?)\s*(?::([^{}|]*))?(?:\|([^{}]*))?\}\}$/;

/** The slots written in a text, in order. A `{{...}}` that is not a slot (no valid name) has name "". */
export function slotRefs(text: string): SlotRef[] {
  const out: SlotRef[] = [];
  for (const m of text.matchAll(BRACES)) {
    const body = SLOT_BODY.exec(m[0]);
    const ref: SlotRef = { raw: m[0], name: body?.[1] ?? "", index: m.index };
    if (body?.[2] !== undefined) ref.example = body[2];
    if (body?.[3] !== undefined) ref.other = body[3];
    out.push(ref);
  }
  return out;
}

/**
 * Checks every slot in a text against a vocabulary (default: K-03 v1). `at` names the place for the message. Throws
 * HoldSlotError for `{{hold}}`, UnknownSlotError for any other name outside the list, MalformedSlotError for braces
 * that do not make a slot.
 */
export function checkSlotNames(text: string, at: string, names: readonly string[] = slotNames()): void {
  if (!text.includes("{{") && !text.includes("}}")) return;
  for (const ref of slotRefs(text)) {
    if (ref.name === "") throw new MalformedSlotError(at, text);
    if (ref.name === "hold") throw new HoldSlotError(`${at}: {{hold}} is refused (D66: nothing is held)`);
    if (!names.includes(ref.name)) throw new UnknownSlotError(at, ref.name, names.length);
  }
  const rest = text.replace(BRACES, "");
  if (rest.includes("{{") || rest.includes("}}")) throw new MalformedSlotError(at, text);
}

/** `{{name}}`, the form the compiler writes (no example words: a sample value never stays in a line, MC C6). */
export function writeSlot(name: string): string {
  return `{{${name}}}`;
}
