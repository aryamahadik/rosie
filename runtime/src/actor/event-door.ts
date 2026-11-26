// The handle actor's event door (T-1563; ruling T-1543 card A18; K-09 v1.14 defaults 221, 222 and 230 to 233, README
// "Who reads v1.14", line 2011). An event reaches the person's own chat handle outside a text: the owner's ID upload
// landing on the secure page (`id_checked`, handed by A12's page call) or Rosie's team's decision that proves control
// (`control_proven`, handed by E10's staging decision). The actor runs it as a turn of its own (../turn/turn.ts
// `runEventTurn`): no texts, so no safety read, batch window, guard, frontier or decide; one gateAndCommit with input event.
//
// The door has two halves, as a text's has (the gateway seals, the actor stores: ../gateway/hand-off.ts):
//
//   1. `handEvent`, on the caller's side (A12's and E10's Worker, which hold the root's sealing key store): checks the
//      hand-off ({eventId, key, step, ref}, the hand-off's own trace id, the handle and the bundle id), and refuses with
//      nothing stored a key outside K-09 v1.14's event table, a step that is not its key's, an event id not made by
//      `eventIdOf` from the key and the ref, a trace id that is not a UUID, a handle that is no phone, or a bundle id that is
//      not K-01's; then seals the key, the step and the ref under the handle's sealing key (../gateway/seal.ts `sealWords`,
//      unchanged: a form 1 box whose body is their JSON) and hands the sealed hand-off to the actor (`acceptEvent`).
//   2. The actor's `acceptEvent` (./handle-actor.ts): checks the clear fields again, then stores the entry in its ordered
//      inbox and queues it for the lease in one step (`writeEventToInbox`), or answers "duplicate" with nothing stored for a
//      known event id, as a text's is (./inbox.ts `writeToInbox`).
//
// The entry (`DoorEvent`): the event id, its kind (EVENT_KIND, which no K-06 event takes), the handle and the trace id stay
// in the clear, for ordering, dropping a known id, routing and the park (../turn/park.ts reads the handle from
// entries[0].event.handle; ./lease.ts reads the trace from entries[0].traceId); the key, the step and the ref are sealed.
// It carries no K-06 service and no chat id (K-09 v1.14 refuses both on an event's turn), so the root's turnChats, which
// copies the last entry's pair onto a run's request only when its `service` is a string (../wiring/turn-chats.ts lines
// 34-45), puts neither on an event turn's request. The handle's phone service and the directory's zone are read once, at
// the event turn's first run, sealed and kept on the entry (`keepEventFirsts`), so a rerun carries the first run's values
// (default 222).
//
// The event id (default 222; the security reviewer's T-1547 note 1): EVENT_ID_PREFIX, which no provider's event id takes,
// then the SHA-256 in lowercase hex of the key and the ref, so one source gives one id, the ref never shows in a span's
// eventId, and the id never equals a Linq message's in the inbox or in the lease's `turnIdOf`. A12 and E10 make it with
// `eventIdOf`.
//
// The bundle id (K-01 v1.1; K-08 v1 default 1): the hand-off passes the active bundle id it read once at hand-off, as the
// gateway's receipt reads it for a text (../gateway/answer.ts readBundleId); the door checks its form. A run of the event
// turn pins its bundle as any run does (./lease.ts, ../bundle/pin.ts), the entry's bundle id being its `arrivedUnder`.
//
// Never logged or put in a span: the ref, an object key, a person, a number, a key. The key and the step are labels.

import { bundleIdOf } from "../bundle/values";
import {
  actorNameOf,
  openWords,
  sealWords,
  type HandleRef,
  type SealedBox,
  type SealingKey,
  type SealingKeyStore,
} from "../gateway/seal";
import type { StoreAnswer } from "../gateway/types";
import { isValidTraceId, type BundleId } from "../trace";
import type { InboxEntry } from "./inbox";

// ---- the event table (K-09 v1.14 eventKey; default 223) -------------------------------------------------------------

/** K-09 v1.14's event table: each key and the one step that waits for it. */
export const EVENT_TABLE = { id_checked: "S1-10", control_proven: "S1-32" } as const;

/** A key of the event table (K-09 v1.14 `eventKey`). */
export type EventKey = keyof typeof EVENT_TABLE;

/** True when `key` is in the event table and `step` is its step. */
export function inEventTable(key: unknown, step: unknown): key is EventKey {
  return typeof key === "string" && Object.hasOwn(EVENT_TABLE, key) && EVENT_TABLE[key as EventKey] === step;
}

// ---- the event id (default 222) --------------------------------------------------------------------------------------

/** The event id's namespace: no provider's event id starts so (Linq's are its message ids; an email's the gateway's). */
export const EVENT_ID_PREFIX = "rosie-event:v1:";

/**
 * The event id of one source handed (default 222): EVENT_ID_PREFIX, then SHA-256 in lowercase hex over the key and the ref
 * as a JSON array. The same key and ref always give the same id, so a source handed again is dropped as a known id; the
 * ref is never readable from it. A12 and E10 make their event ids with this function.
 */
export async function eventIdOf(key: EventKey, ref: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([key, ref])));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${EVENT_ID_PREFIX}${hex}`;
}

const EVENT_ID = /^rosie-event:v1:[0-9a-f]{64}$/u;

/** True when `value` has the event id's form (the namespace and a hash); a text's event id never has it. */
export function isEventIdForm(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID.test(value);
}

// ---- the hand-off ----------------------------------------------------------------------------------------------------

/** What A12's page call and E10's decision hand the door: the event, its own trace id, the handle and the bundle id. */
export interface EventHandoff {
  readonly eventId: string;
  readonly key: EventKey;
  readonly step: string;
  /** The id of the key's own source (the upload's id, or the review item's): never an object key, a code or a name. */
  readonly ref: string;
  /** The hand-off's own trace id (the page call's, or the decision's): the event turn's trace (CQ-06). */
  readonly traceId: string;
  /** The person's own chat handle (K-04 handles: kind and address), whose actor runs the turn. */
  readonly handle: HandleRef;
  /** The active bundle id the hand-off read (K-08 v1 default 1): the entry's, as a text's is the gateway's. */
  readonly bundleId: BundleId;
  /** How many places on the trace the caller took before the actor (K-08 `seq`), as a text's hand-off's `seqBefore`. */
  readonly seqBefore?: number;
}

/** The kind an event's entry is stored under in the inbox (./inbox.ts `kind`): no K-06 event takes it. */
export const EVENT_KIND = "turnEvent";

/**
 * An event as the inbox keeps it (A18's entry): the event id, the kind, the handle and the trace id in the clear; the key,
 * the step and the ref sealed (`sealed`, a form 1 box under the handle's key, the actor's name and the event id); once its
 * turn has first run, the handle's phone service and the directory's zone sealed beside them (`firsts`). No service and
 * no chat id: an event's turn carries neither (K-09 v1.14).
 */
export interface DoorEvent {
  readonly eventId: string;
  readonly kind: typeof EVENT_KIND;
  readonly handle: HandleRef;
  readonly traceId: string;
  readonly sealed: SealedBox;
  readonly firsts?: SealedBox;
  /** Never on an event's entry (K-09 v1.14: no service on an event's turn). */
  readonly service?: never;
  /** Never on an event's entry (K-09 v1.14: no chat id on an event's turn). */
  readonly chatId?: never;
}

/** The sealed hand-off the actor's `acceptEvent` takes. */
export interface SealedEventHandoff {
  readonly event: DoorEvent;
  readonly bundleId: BundleId;
  readonly seqBefore?: number;
}

/** One stored event, in the inbox's arrival order beside the texts (./inbox.ts InboxEntry's shape). */
export interface EventInboxEntry {
  seq: number;
  event: DoorEvent;
  partKey: null;
  traceId: string;
  bundleId: BundleId;
  startsTurn: true;
}

/** An entry of a leased turn: a text's (K-06, sealed by the gateway) or an event's (A18). */
export type LeasedEntry = InboxEntry | EventInboxEntry;

/** True for an event's entry. */
export function isEventEntry(entry: LeasedEntry): entry is EventInboxEntry {
  return entry.event.kind === EVENT_KIND;
}

/** A hand-off the door refuses, with nothing stored; `code` is a label and the message never holds a value. */
export class EventDoorRefusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "EventDoorRefusal";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Why a handle cannot take an event, or null: an event's handle is the person's own mobile (K-09 v1.14 `service`). */
function handleProblem(handle: unknown): string | null {
  if (!isRecord(handle) || handle.kind !== "phone" || !isText(handle.address)) return "notAPhone";
  return null;
}

/** Why the clear fields cannot be stored (the trace, the handle, the bundle id), or null. */
function clearProblem(traceId: unknown, handle: unknown, bundleId: unknown): string | null {
  if (typeof traceId !== "string" || !isValidTraceId(traceId)) return "badTrace";
  const handled = handleProblem(handle);
  if (handled !== null) return handled;
  if (bundleIdOf(bundleId) === null) return "badBundle";
  return null;
}

/**
 * Why the door refuses this hand-off, or null (checked before anything is sealed or stored): a key outside the event table
 * or a step that is not its key's (`notInEventTable`, so the gate is never sent a request the schema refuses), a ref that is
 * no id, an event id not made from this key and ref (`badEventId`), then the clear fields.
 */
export async function eventHandoffProblem(handoff: EventHandoff): Promise<string | null> {
  const given: unknown = handoff;
  if (!isRecord(given)) return "notAnEvent";
  if (!inEventTable(given.key, given.step)) return "notInEventTable";
  if (!isText(given.ref)) return "badRef";
  if (given.eventId !== (await eventIdOf(given.key, given.ref))) return "badEventId";
  return clearProblem(given.traceId, given.handle, given.bundleId);
}

/** Why the actor refuses a sealed hand-off (its clear fields and its box's form), or null. */
export function sealedEventProblem(handoff: SealedEventHandoff): string | null {
  const given: unknown = handoff;
  if (!isRecord(given) || !isRecord(given.event)) return "notAnEvent";
  const event = given.event;
  if (event.kind !== EVENT_KIND) return "notAnEvent";
  if (!isEventIdForm(event.eventId)) return "badEventId";
  const sealed = event.sealed;
  if (
    !isRecord(sealed) ||
    sealed.v !== 1 ||
    sealed.alg !== "A256GCM" ||
    !isText(sealed.iv) ||
    !isText(sealed.ct)
  ) {
    return "notSealed";
  }
  if (event.firsts !== undefined || "service" in event || "chatId" in event) return "notAnEvent";
  return clearProblem(event.traceId, event.handle, given.bundleId);
}

// ---- the sealed body and the first run's values ---------------------------------------------------------------------

/** What an event's box holds: its key, the step that waits for it and the ref of the key's own source. */
export interface EventBody {
  readonly key: EventKey;
  readonly step: string;
  readonly ref: string;
}

/** The handle's phone service and the directory's zone, read at the event turn's first run (default 221). */
export interface EventFirsts {
  readonly service: string;
  readonly zone: string;
}

/** Seals `value`'s JSON in a form 1 box under the handle's key, the actor's name and the event id (seal.ts, unchanged). */
function sealJson(value: unknown, key: SealingKey, actorName: string, eventId: string): Promise<SealedBox> {
  return sealWords({ body: JSON.stringify(value), subject: null }, key, actorName, eventId);
}

/** Opens a form 1 box sealed by `sealJson` and gives its JSON; throws for any other box or form. */
async function openJson(
  box: SealedBox,
  key: SealingKey,
  actorName: string,
  eventId: string,
): Promise<unknown> {
  // A stored box is read as stored: its form is checked, whatever its type says.
  const form: unknown = box.v;
  if (form !== 1) throw new Error("an event's box is of form 1");
  const words = await openWords(box, key, actorName, eventId);
  if (typeof words.body !== "string" || words.subject !== null) throw new Error("not an event's box");
  return JSON.parse(words.body) as unknown;
}

/** Opens an event's box: its key, step and ref, checked against the event table; throws for anything else. */
export async function openEventBody(event: DoorEvent, key: SealingKey): Promise<EventBody> {
  const opened = await openJson(event.sealed, key, actorNameOf(event.handle), event.eventId);
  if (!isRecord(opened) || Object.keys(opened).length !== 3) throw new Error("not an event's body");
  const { key: given, step, ref } = opened;
  if (!inEventTable(given, step) || !isText(ref) || typeof step !== "string") {
    throw new Error("not an event's body");
  }
  return { key: given, step, ref };
}

/** Seals the first run's service and zone for the entry (`keepEventFirsts`). */
export function sealEventFirsts(event: DoorEvent, key: SealingKey, firsts: EventFirsts): Promise<SealedBox> {
  return sealJson(
    { service: firsts.service, zone: firsts.zone },
    key,
    actorNameOf(event.handle),
    event.eventId,
  );
}

/** Opens the first run's service and zone; throws for anything else. */
export async function openEventFirsts(
  event: DoorEvent,
  box: SealedBox,
  key: SealingKey,
): Promise<EventFirsts> {
  const opened = await openJson(box, key, actorNameOf(event.handle), event.eventId);
  if (!isRecord(opened) || Object.keys(opened).length !== 2) throw new Error("not an event's first values");
  const { service, zone } = opened;
  if (!isText(service) || !isText(zone)) throw new Error("not an event's first values");
  return { service, zone };
}

// ---- the caller's half: check, seal, hand ----------------------------------------------------------------------------

/** The actor's half of the door, as the caller reaches it (the handle's Durable Object stub). */
export interface EventDoorStub {
  acceptEvent(handoff: SealedEventHandoff): Promise<StoreAnswer>;
}

/**
 * The door, on the caller's side: checks the hand-off (`eventHandoffProblem`), seals its key, step and ref under the
 * handle's sealing key, and hands the sealed entry to the handle's actor, which answers "written" or "duplicate". A
 * refused hand-off throws EventDoorRefusal naming its fault, with nothing sealed, sent or stored; a key store or an actor
 * that fails rejects, and nothing is kept.
 */
export async function handEvent(
  actor: EventDoorStub,
  handoff: EventHandoff,
  keys: SealingKeyStore,
): Promise<StoreAnswer> {
  const problem = await eventHandoffProblem(handoff);
  if (problem !== null) throw new EventDoorRefusal(problem);
  const handle: HandleRef = { kind: handoff.handle.kind, address: handoff.handle.address };
  const key = await keys.getOrCreateKey(handle);
  const body: EventBody = { key: handoff.key, step: handoff.step, ref: handoff.ref };
  const sealed = await sealJson(body, key, actorNameOf(handle), handoff.eventId);
  const seqBefore = handoff.seqBefore;
  return actor.acceptEvent({
    event: { eventId: handoff.eventId, kind: EVENT_KIND, handle, traceId: handoff.traceId, sealed },
    bundleId: { hash: handoff.bundleId.hash, build: handoff.bundleId.build },
    ...(typeof seqBefore === "number" ? { seqBefore } : {}),
  });
}

// ---- the actor's storage ---------------------------------------------------------------------------------------------

interface LeasedRow extends Record<string, SqlStorageValue> {
  seq: number;
  kind: string;
  event_json: string;
  part_key: string | null;
  trace_id: string;
  bundle_hash: string;
  bundle_build: number;
  starts_turn: number;
}

/**
 * Stores the event in the inbox, in arrival order beside the texts, inside the caller's transaction, unless its event id is
 * already known: "duplicate" then, with nothing changed. Answers the entry's seq when written.
 */
export function writeEventToInbox(
  storage: DurableObjectStorage,
  handoff: SealedEventHandoff,
): { answer: "written"; seq: number } | { answer: "duplicate" } {
  const { event } = handoff;
  const known = storage.sql.exec("SELECT 1 FROM inbox WHERE event_id = ?", event.eventId).toArray();
  if (known.length > 0) return { answer: "duplicate" };
  const stored: DoorEvent = {
    eventId: event.eventId,
    kind: EVENT_KIND,
    handle: { kind: event.handle.kind, address: event.handle.address },
    traceId: event.traceId,
    sealed: { v: 1, alg: "A256GCM", iv: event.sealed.iv, ct: event.sealed.ct },
  };
  const row = storage.sql
    .exec<{ seq: number }>(
      `INSERT INTO inbox (event_id, kind, starts_turn, part_key, trace_id, bundle_hash, bundle_build, event_json)
       VALUES (?, ?, 1, NULL, ?, ?, ?, ?) RETURNING seq`,
      stored.eventId,
      EVENT_KIND,
      stored.traceId,
      handoff.bundleId.hash,
      handoff.bundleId.build,
      JSON.stringify(stored),
    )
    .one();
  return { answer: "written", seq: row.seq };
}

function leasedEntryOf(row: LeasedRow): LeasedEntry {
  const bundleId = { hash: row.bundle_hash, build: row.bundle_build };
  if (row.kind === EVENT_KIND) {
    return {
      seq: row.seq,
      event: JSON.parse(row.event_json) as DoorEvent,
      partKey: null,
      traceId: row.trace_id,
      bundleId,
      startsTurn: true,
    };
  }
  return {
    seq: row.seq,
    event: JSON.parse(row.event_json) as InboxEntry["event"],
    partKey: row.part_key,
    traceId: row.trace_id,
    bundleId,
    startsTurn: row.starts_turn === 1,
  };
}

/** The stored entries with these event ids, texts and events, in arrival order (an id the inbox does not hold left out). */
export function readLeasedEntries(sql: SqlStorage, eventIds: readonly string[]): LeasedEntry[] {
  if (eventIds.length === 0) return [];
  return sql
    .exec<LeasedRow>(
      `SELECT seq, kind, event_json, part_key, trace_id, bundle_hash, bundle_build, starts_turn
       FROM inbox WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
      JSON.stringify(eventIds),
    )
    .toArray()
    .map(leasedEntryOf);
}

/** The first run's sealed service and zone kept on the event's entry, or null before its first run kept them. */
export function readEventFirsts(sql: SqlStorage, eventId: string): SealedBox | null {
  const row = sql
    .exec<{ firsts: string | null }>(
      "SELECT json_extract(event_json, '$.firsts') AS firsts FROM inbox WHERE event_id = ? AND kind = ?",
      eventId,
      EVENT_KIND,
    )
    .toArray()[0];
  return typeof row?.firsts === "string" ? (JSON.parse(row.firsts) as SealedBox) : null;
}

/**
 * Keeps the first run's sealed service and zone on the event's entry, once: a run that comes second keeps nothing, and
 * every run is answered the box kept first (default 222: a rerun carries the first run's values).
 */
export function keepEventFirsts(sql: SqlStorage, eventId: string, box: SealedBox): SealedBox {
  const kept: SealedBox = { v: 1, alg: "A256GCM", iv: box.iv, ct: box.ct };
  sql.exec(
    `UPDATE inbox SET event_json = json_set(event_json, '$.firsts', json(?))
     WHERE event_id = ? AND kind = ? AND json_extract(event_json, '$.firsts') IS NULL`,
    JSON.stringify(kept),
    eventId,
    EVENT_KIND,
  );
  const first = readEventFirsts(sql, eventId);
  if (first === null) throw new Error("no such event");
  return first;
}
