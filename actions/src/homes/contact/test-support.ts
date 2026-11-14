// Test sources for the contact home, for the tests only.
//
// The flows are fixture set v1's master flows as the merged bundle emitter compiles them (the home registry's
// emittedFlows): S13-19's words and the record's rows come from them. People are read by T-307's own reach() (the
// messages-and-consent service base) over the frozen contracts' seeds, through its test doubles: K-04 v1 core's people,
// phones and threads (Sam, Alex, Riley with open chats; Alex's email; Ben's stopped phone) and K-29 v1's consent rows and
// chat links (Ben's texts yes; Pat's phone, which never texted Rosie), plus the rows a test adds for its own example,
// each named where it is made. Nothing is invented and no real person is named (rule 9).

import { createMessagesConsent, type Reach, type ReachCard } from "../../domain/messages-consent";
import {
  cardsOf,
  phoneOf,
  readerOf,
  seedRecord,
  withRows,
  type ConsentRow,
  type TestRecord,
} from "../../domain/messages-consent/test-support";
import {
  AFTER_CHOICES,
  BEFORE_CHOICES,
  PRICE_CHOICES,
  type BookingValues,
  type RecordReading,
  type SlotRow,
} from "../../finalize/slots/record";
import { RECORD_SLOT_NAMES, type RecordSlotName } from "../../finalize/slots/vocabulary";
import type { FlowLetter } from "../registry";
import { emittedFlows, objAt, type EmittedFlows } from "../registry/test-support";
import { readContactRecord, type ContactRecord } from "./record";

/** The business every person is read at: Lee's Barbershop, K-04's seeded business. */
export const BUSINESS = "biz-lees-barbershop";

/** S13-19's example of the line, word for word (master-A.json and master-B.json S13-19 `more`, as compiled). */
export const S13_19_PRIVATE_EXAMPLE =
  "Like this: 'Private booking: reach them only by email, at the times they named. Never say why.'";

/** The line itself, as an owner or staff message about a private booking of a person reached by email carries it. */
export const PRIVATE_LINE_BY_EMAIL =
  "Private booking: reach them only by email, at the times they named. Never say why.";

/** S13-19's calls-only additions, word for word: unreachable (C-237), so never in a line this home gives. */
export const S13_19_CALLS_ONLY = [
  "Private and calls only adds: 'On a call: ask for them by first name.'",
  "'If anyone else or a machine answers, give only the plain display name and call back later. No voicemail.'",
];

/** S13-19's lines the module rules by, word for word (master-A.json and master-B.json S13-19 `more`, as compiled). */
export const S13_19_RULES = [
  "Booked by the business with no clear yes to messages (A3-30): they get none.",
  "Email: everything goes by email. The check-in code is on the secure page.",
  "A reply clock starts only once they were reached their way. No fee follows silence to a message they couldn't get.",
  "Nothing else is texted to that mobile until it texts in. No clock or fee runs on a message they didn't get.",
  "Every owner and staff message about a private booking carries one line:",
];

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Both flows: the emitted flow graphs and the contact home's part of each. */
export interface Sources {
  readonly flows: EmittedFlows;
  readonly records: Readonly<Record<FlowLetter, ContactRecord>>;
}

let cached: Sources | null = null;

export async function sources(): Promise<Sources> {
  if (cached !== null) return cached;
  const flows = await emittedFlows();
  cached = {
    flows,
    records: { A: readContactRecord("A", flows.A), B: readContactRecord("B", flows.B) },
  };
  return cached;
}

/** Every named slot's rows, as the slot filler reads them (K-01 record.slots.<slot>.rows). */
function slotRows(graph: Obj): Partial<Record<RecordSlotName, readonly SlotRow[]>> {
  const slots = objAt(graph, ["record", "slots"]);
  const rows: Partial<Record<RecordSlotName, readonly SlotRow[]>> = {};
  for (const slot of RECORD_SLOT_NAMES) {
    const raw = slots[slot];
    const list: unknown = isObj(raw) ? raw.rows : undefined;
    if (!Array.isArray(list)) throw new Error(`slot ${slot} has no rows`);
    rows[slot] = (list as readonly unknown[]).map((row) => {
      if (!isObj(row) || typeof row.text !== "string")
        throw new Error(`slot ${slot} has a row with no words`);
      return isObj(row.when) ? { when: row.when, text: row.text } : { text: row.text };
    });
  }
  return rows;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T {
  const found = list.find((item) => item === value);
  if (found === undefined) throw new Error(`${String(value)} is not one of ${list.join(", ")}`);
  return found;
}

/**
 * A booking's record, as the slot filler reads it, on its flow's main path (record.main: flow A list|card|counter,
 * flow B list|card|bill) with these booking values (a group left out reads its first value: K-01 bookingValues).
 */
export function bookingOf(src: Sources, flow: FlowLetter, booking: Partial<BookingValues>): RecordReading {
  const graph = src.flows[flow];
  const main = objAt(graph, ["record", "main"])[flow];
  if (typeof main !== "string") throw new Error(`flow ${flow}'s record has no main path`);
  const [price, before, after] = main.split("|");
  return {
    price: oneOf(PRICE_CHOICES, price),
    before: oneOf(BEFORE_CHOICES, before),
    after: oneOf(AFTER_CHOICES, after),
    booking,
    switches: [],
    facts: null,
    values: [],
    rows: slotRows(graph),
  };
}

/** A reach card for one person at the business. */
export function cardOf(
  way: ReachCard["way"],
  mobileHandleId: string | null,
  emailHandleId: string | null,
): ReachCard {
  return { way, mobileHandleId, emailHandleId };
}

/** How a person is reached at the business, read by T-307's reach() over the record (default: the seeds). */
export async function reachOf(
  personId: string,
  options: { readonly card?: ReachCard; readonly record?: TestRecord } = {},
): Promise<Reach> {
  const record = options.record ?? seedRecord();
  const cards = options.card === undefined ? [] : [{ ...options.card, businessId: BUSINESS, personId }];
  const service = createMessagesConsent({
    businessId: BUSINESS,
    reader: readerOf(record, BUSINESS),
    reachCards: cardsOf(cards),
  });
  const reach = await service.reach(personId);
  if (reach === null) throw new Error(`${personId} is not a person of the record`);
  return reach;
}

/**
 * The seeds with Alex's mobile as it is before its first text to Rosie's number (K-04: chat not open, no chat_open_at,
 * no chat thread): this test's own example of a mobile on the card that has not texted in (MC C9).
 */
export function alexNotTextedIn(record: TestRecord = seedRecord()): TestRecord {
  const phone = phoneOf(record, "handle-alex");
  const changed = withRows(record, { phones: [{ ...phone, chatOpen: false, chatOpenAt: null }] });
  return { ...changed, threads: changed.threads.filter((thread) => thread.handleId !== "handle-alex") };
}

/**
 * The seeds with Ben's chat thread: his phone texted Rosie's number on Oct 5 (K-04 seed-phone-stopped: chat_open_at), a
 * thread K-04's seeds leave out. This test's own example row, so his stopped phone is one that once opened its chat.
 */
export function benWithThread(record: TestRecord = seedRecord()): TestRecord {
  return {
    ...record,
    threads: [
      ...record.threads,
      {
        id: "thread-ben-chat",
        handleId: "handle-ben",
        kind: "chat",
        bookingId: null,
        linqChatId: null,
        replyAddress: null,
        version: 1,
      },
    ],
  };
}

/**
 * A K-29 texts row for one of a person's contacts at the business: a yes (`revoked` false), or a withdrawal (`revoked`
 * true, as when updates move to another contact: RULES 9.1, D75). This test's own example row; its hash is the seed
 * chat link's, since no read here compares it to its words.
 */
export function textsRow(
  id: string,
  personId: string,
  handleId: string,
  revoked: boolean,
  at: string,
): ConsentRow {
  return {
    id,
    personId,
    businessId: BUSINESS,
    kind: "texts",
    revoked,
    handleId,
    bookingId: null,
    wordsSha256: "6787b8ed87e3d9d839bbfe158d1aaeaafd1b945cac4ae704933e78649be5208d",
    at: new Date(at),
    channel: "text",
    chatLinkId: null,
    turnId: null,
    exactWords: "Hey, send me further updates about my booking. Ref 4K7Q",
  };
}
