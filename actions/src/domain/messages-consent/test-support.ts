// Doubles for the messages-and-consent tests (T-307). Never imported by the Worker. No database: an in-memory record built
// from the frozen contracts' seed fixtures (K-04 v1 core: people, handles, phones, threads; K-29 v1: consent rows and
// chat links), read the way the data-access calls read it, plus rows a test adds for its own example. Values come only
// from the contracts' fixtures and the master's sample cast, never a real person (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { ConsentChannel, ConsentKind, ConsentRead } from "../../../../db/repo/consent";
import type { Person } from "../../../../db/repo/people";
import type { ChatWay, Handle, HandleKind, Phone } from "../../../../db/repo/phones";
import type { Thread, ThreadKind } from "../../../../db/repo/threads";
import { CONTRACTS_DIR, SCHEMA_FILES, formatProblems } from "../../tool-api";
import type { MessagesReader, ReachCard, ReachCards } from "./reads";

type Values = Readonly<Record<string, unknown>>;

interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

interface SeedFile {
  readonly after?: readonly string[];
  readonly rows?: readonly SeedRow[];
}

/** A contract file, parsed (path under contracts/); the caller states the shape it reads. */
export function contractJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as unknown;
}

/**
 * The seeds the tests read: K-04's people and phones (chat open, and Ben's stopped phone) with Alex's threads, and K-29's
 * fee OK and chat links (Ben's texts yes, Avery's and Pat's invites, Pat's phone with no open chat). Ben's STOP row is
 * left out: the tests build it and compare it with K-29's seed-consent-stop-row.json.
 */
export const SEEDS = [
  "db-schema/core/fixtures/seed-person-roles.json",
  "db-schema/core/fixtures/seed-phone-chat-open.json",
  "db-schema/core/fixtures/seed-phone-stopped.json",
  "db-schema/core/fixtures/seed-thread-messages.json",
  "db-schema/conversations-consent/fixtures/seed-consent-fee-ok.json",
  "db-schema/conversations-consent/fixtures/seed-chat-link.json",
] as const;

/**
 * The rows of seed fixtures (paths under contracts/), each file's `after` chain first and each file once, as K-04 v1's
 * README loads them ("Seed and refused-row fixtures"; K-29's `after` paths are relative to the file that names them).
 */
export function seedRows(files: readonly string[]): SeedRow[] {
  const rows: SeedRow[] = [];
  const loaded = new Set<string>();
  const load = (file: string): void => {
    if (loaded.has(file)) return;
    loaded.add(file);
    const seed = JSON.parse(readFileSync(file, "utf8")) as SeedFile;
    for (const after of seed.after ?? []) load(path.resolve(path.dirname(file), after));
    rows.push(...(seed.rows ?? []));
  };
  for (const file of files) load(path.join(CONTRACTS_DIR, ...file.split("/")));
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// The record

export interface PersonHandle {
  readonly personId: string;
  readonly handleId: string;
}

/** A K-29 consent row as read without its words (db/repo/consent.ts ConsentRead), with its words kept beside it. */
export interface ConsentRow extends ConsentRead {
  readonly exactWords: string;
}

export interface TestRecord {
  readonly persons: readonly Person[];
  readonly handles: readonly Handle[];
  readonly personHandles: readonly PersonHandle[];
  readonly phones: readonly Phone[];
  readonly threads: readonly Thread[];
  readonly consents: readonly ConsentRow[];
  /** Every name, number, address and message's words in the rows: what no read or row answer may carry (K-08; CQ-59). */
  readonly privateValues: readonly string[];
}

/** Columns that hold a person's or a business's name, a number, an address or someone's words, in any table. */
const PRIVATE_COLUMNS: readonly string[] = [
  "name",
  "display_name",
  "address",
  "number",
  "phone_number",
  "words",
  "exact_words",
  "ready_text",
  "reply_address",
];

const HANDLE_KINDS: readonly HandleKind[] = ["phone", "email"];
const CHAT_WAYS: readonly ChatWay[] = ["imessage", "rcs", "sms"];
const THREAD_KINDS: readonly ThreadKind[] = ["chat", "email"];
const CONSENT_KINDS: readonly ConsentKind[] = [
  "texts",
  "photos_shown",
  "ticked_terms",
  "plan_terms",
  "fee_ok",
  "health_agreement",
];
const CONSENT_CHANNELS: readonly ConsentChannel[] = ["text", "email", "page", "ai"];

function text(values: Values, column: string): string {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

function textOrNull(values: Values, column: string): string | null {
  const value = values[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

function dateOrNull(values: Values, column: string): Date | null {
  const value = textOrNull(values, column);
  return value === null ? null : new Date(value);
}

function oneOf<T extends string>(values: Values, column: string, allowed: readonly T[]): T {
  const found = allowed.find((item) => item === values[column]);
  if (found === undefined) throw new Error(`seed column ${column} is not one of its values`);
  return found;
}

function oneOfOrNull<T extends string>(values: Values, column: string, allowed: readonly T[]): T | null {
  return values[column] === undefined || values[column] === null ? null : oneOf(values, column, allowed);
}

function flag(values: Values, column: string): boolean {
  const value = values[column] ?? false;
  if (typeof value !== "boolean") throw new Error(`seed column ${column} is not a boolean`);
  return value;
}

function version(values: Values): number {
  const value = values.version ?? 1;
  if (typeof value !== "number") throw new Error("seed column version is not a number");
  return value;
}

/** The record the doubles read, from seed rows (a column left out takes its K-04 or K-29 default). */
export function recordOf(rows: readonly SeedRow[]): TestRecord {
  const persons: Person[] = [];
  const handles: Handle[] = [];
  const personHandles: PersonHandle[] = [];
  const phones: Phone[] = [];
  const threads: Thread[] = [];
  const consents: ConsentRow[] = [];
  const privateValues: string[] = [];
  for (const { table, values } of rows) {
    for (const column of PRIVATE_COLUMNS) {
      const value = values[column];
      if (typeof value === "string") privateValues.push(value);
    }
    switch (table) {
      case "persons":
        persons.push({
          id: text(values, "id"),
          name: textOrNull(values, "name"),
          language: textOrNull(values, "language"),
          version: version(values),
        });
        break;
      case "handles":
        handles.push({
          id: text(values, "id"),
          kind: oneOf(values, "kind", HANDLE_KINDS),
          address: text(values, "address"),
        });
        break;
      case "person_handles":
        personHandles.push({ personId: text(values, "person_id"), handleId: text(values, "handle_id") });
        break;
      case "phones":
        phones.push({
          number: text(values, "number"),
          handleId: text(values, "handle_id"),
          chatOpen: flag(values, "chat_open"),
          chatOpenAt: dateOrNull(values, "chat_open_at"),
          chatWay: oneOfOrNull(values, "chat_way", CHAT_WAYS),
          stopped: flag(values, "stopped"),
          stopAt: dateOrNull(values, "stop_at"),
          startAt: dateOrNull(values, "start_at"),
          linqContactAddedAt: dateOrNull(values, "linq_contact_added_at"),
          pollVotedAt: dateOrNull(values, "poll_voted_at"),
          optoutLineDeliveredAt: dateOrNull(values, "optout_line_delivered_at"),
          version: version(values),
        });
        break;
      case "threads":
        threads.push({
          id: text(values, "id"),
          handleId: text(values, "handle_id"),
          kind: oneOf(values, "kind", THREAD_KINDS),
          bookingId: textOrNull(values, "booking_id"),
          linqChatId: textOrNull(values, "linq_chat_id"),
          replyAddress: textOrNull(values, "reply_address"),
          version: version(values),
        });
        break;
      case "consents":
        consents.push({
          id: text(values, "id"),
          personId: text(values, "person_id"),
          businessId: textOrNull(values, "business_id"),
          kind: oneOf(values, "kind", CONSENT_KINDS),
          revoked: flag(values, "revoked"),
          handleId: textOrNull(values, "handle_id"),
          bookingId: textOrNull(values, "booking_id"),
          wordsSha256: text(values, "words_sha256"),
          at: new Date(text(values, "at")),
          channel: oneOf(values, "channel", CONSENT_CHANNELS),
          chatLinkId: textOrNull(values, "chat_link_id"),
          turnId: textOrNull(values, "turn_id"),
          exactWords: text(values, "exact_words"),
        });
        break;
      default:
        break;
    }
  }
  return { persons, handles, personHandles, phones, threads, consents, privateValues };
}

/** The record of SEEDS. */
export function seedRecord(): TestRecord {
  return recordOf(seedRows(SEEDS));
}

/** The record with more rows, or with phones replaced by number, for a test's own example. */
export function withRows(
  record: TestRecord,
  more: {
    persons?: readonly Person[];
    handles?: readonly Handle[];
    personHandles?: readonly PersonHandle[];
    phones?: readonly Phone[];
    consents?: readonly ConsentRow[];
  },
): TestRecord {
  const replaced = new Set((more.phones ?? []).map((phone) => phone.number));
  return {
    ...record,
    persons: [...record.persons, ...(more.persons ?? [])],
    handles: [...record.handles, ...(more.handles ?? [])],
    personHandles: [...record.personHandles, ...(more.personHandles ?? [])],
    phones: [...record.phones.filter((phone) => !replaced.has(phone.number)), ...(more.phones ?? [])],
    consents: [...record.consents, ...(more.consents ?? [])],
  };
}

/** A phone of the record, by its handle (the tests read the seeds' own rows). */
export function phoneOf(record: TestRecord, handleId: string): Phone {
  const phone = record.phones.find((each) => each.handleId === handleId);
  if (phone === undefined) throw new Error(`no phone for ${handleId}`);
  return phone;
}

// ---------------------------------------------------------------------------------------------------------------
// The doubles

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const readOf = (row: ConsentRow): ConsentRead => ({
  id: row.id,
  personId: row.personId,
  businessId: row.businessId,
  kind: row.kind,
  revoked: row.revoked,
  handleId: row.handleId,
  bookingId: row.bookingId,
  wordsSha256: row.wordsSha256,
  at: row.at,
  channel: row.channel,
  chatLinkId: row.chatLinkId,
  turnId: row.turnId,
});

/**
 * The data-access reads over the record as db/repo answers them. Consents as the call's business scope shows them
 * (K-29 rule 4: that business's rows only, never a STOP or START row), or every row with `scope` null (the runtime side).
 */
export function readerOf(record: TestRecord, scope: string | null): MessagesReader {
  return {
    person: (personId) => Promise.resolve(record.persons.find((person) => person.id === personId) ?? null),
    handleIdsOfPerson: (personId) =>
      Promise.resolve(
        record.personHandles
          .filter((link) => link.personId === personId)
          .map((link) => link.handleId)
          .sort(byId),
      ),
    handle: (handleId) => Promise.resolve(record.handles.find((handle) => handle.id === handleId) ?? null),
    phoneOfHandle: (handleId) =>
      Promise.resolve(record.phones.find((phone) => phone.handleId === handleId) ?? null),
    chatThreadOf: (handleId) =>
      Promise.resolve(
        record.threads.find((thread) => thread.handleId === handleId && thread.kind === "chat") ?? null,
      ),
    consentsOfPersons: (personIds) =>
      Promise.resolve(
        record.consents
          .filter((row) => personIds.includes(row.personId) && (scope === null || row.businessId === scope))
          .sort((a, b) => a.at.getTime() - b.at.getTime() || byId(a.id, b.id))
          .map(readOf),
      ),
  };
}

export interface CardAsked {
  readonly businessId: string;
  readonly personId: string;
}

/** Reach cards on file, by business and person; none for anyone else. Each question is written down in `asked`. */
export function cardsOf(cards: readonly (ReachCard & CardAsked)[], asked: CardAsked[] = []): ReachCards {
  return {
    cardOf(businessId, personId) {
      asked.push({ businessId, personId });
      const card = cards.find((each) => each.businessId === businessId && each.personId === personId);
      return Promise.resolve(
        card === undefined
          ? null
          : { way: card.way, mobileHandleId: card.mobileHandleId, emailHandleId: card.emailHandleId },
      );
    },
  };
}

/** Every string anywhere in a value, keys excluded. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// The contracts' own schemas (Ajv 2020, strict), as the contract tests hold them

const DATA_ACCESS_V1_1 = "https://rosie.invalid/contracts/data-access/data-access.v1.1.schema.json";
const OUTBOX_EFFECTS_V1 = "https://rosie.invalid/contracts/outbox-effects/outbox-effects.v1.schema.json";

let ajv: InstanceType<typeof Ajv2020> | undefined;

function schemas(): InstanceType<typeof Ajv2020> {
  if (ajv !== undefined) return ajv;
  ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const file of [...SCHEMA_FILES, "data-access/data-access.v1.1.schema.json"]) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as object);
  }
  return ajv;
}

function problemsOf(ref: string, value: unknown): string[] {
  const validate: ValidateFunction | undefined = schemas().getSchema(ref);
  if (validate === undefined) throw new Error(`no schema ${ref}`);
  return validate(value) ? [] : formatProblems(validate.errors);
}

/** Problems K-05 v1.1 `$defs/<definition>` finds (outboxRowNew, stateWrite), one line each, never a value. */
export function k05Problems(definition: string, value: unknown): string[] {
  return problemsOf(`${DATA_ACCESS_V1_1}#/$defs/${definition}`, value);
}

/** Problems K-07 v1's root finds in one record (an outbox row's life, an effect row's life or a provider event). */
export function k07Problems(value: unknown): string[] {
  return problemsOf(OUTBOX_EFFECTS_V1, value);
}

// ---------------------------------------------------------------------------------------------------------------
// The businesses and the master's own examples

/** K-04 seed-business-head's demo shops. */
export const BARBERSHOP = "biz-lees-barbershop";
export const YOGA_STUDIO = "biz-yoga-studio";

/** Alex's reach card at Lee's Barbershop: texts to his mobile, and his email on file (RULES 4.8; S13-19). */
export const ALEX_CARD: ReachCard & CardAsked = {
  businessId: BARBERSHOP,
  personId: "person-alex",
  way: "texts",
  mobileHandleId: "handle-alex",
  emailHandleId: "handle-alex-email",
};

/** A handle and phone row for a test's example, in the 555-01xx range (rule 9). */
export function phoneRow(handleId: string, number: string, fields: Partial<Phone> = {}): Phone {
  return {
    number,
    handleId,
    chatOpen: false,
    chatOpenAt: null,
    chatWay: null,
    stopped: false,
    stopAt: null,
    startAt: null,
    linqContactAddedAt: null,
    pollVotedAt: null,
    optoutLineDeliveredAt: null,
    version: 1,
    ...fields,
  };
}
