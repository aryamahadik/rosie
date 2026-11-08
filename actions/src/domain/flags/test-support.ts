// Doubles for the flags tests (T-317). Never imported by the Worker. No database: an in-memory record built from the
// frozen contracts' seed fixtures (K-04 v1's people, roles, phones, booking heads and pauses; K-29 v1's consent rows),
// read the way the data-access calls read it (on the runtime side every row; under a business scope that business's),
// and written by a fake of K-05's commit that applies the state writes as K-05 would: an insert adds the row, an update
// is compared and set on its version. Doubles stand in for ports only, never for the code under test. Values come only
// from the contracts' fixtures and the master's sample cast, in the 555-01xx range (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import type { BookingFlow, BookingHead, BookingStage } from "../../../../db/repo/bookings-head";
import type { PersonRole, PersonRoleName } from "../../../../db/repo/people";
import type { Pause, PauseTarget, Phone } from "../../../../db/repo/phones";
import type { Ask, StateWrite } from "../../commit";
import { CONTRACTS_DIR } from "../../tool-api";
import type { MessagesReader } from "../messages-consent";
import {
  SEEDS,
  readerOf,
  recordOf,
  seedRows,
  type ConsentRow,
  type TestRecord,
} from "../messages-consent/test-support";
import type { AloneCommit, AloneCommitRequest } from "./handlers";
import { KEYED_IDS, type FlagIds, type FlagRow } from "./ids";
import type { FlagsReader } from "./reads";
import type { EventSources } from "./stop-start";

export { BARBERSHOP, YOGA_STUDIO, phoneRow, stringsIn, k05Problems } from "../messages-consent/test-support";

/** T-307's seeds with K-04's booking heads. */
export const FLAG_SEEDS = [...SEEDS, "db-schema/core/fixtures/seed-booking-head.json"] as const;

/** An open question as K-04 open_questions holds it, with the columns the flags reads use. */
export interface QuestionRow {
  readonly id: string;
  /** The turn that asked it (open_questions.turn_id: the commit's turn). */
  readonly turnId: string;
  readonly handleId: string;
  readonly businessId: string | null;
  readonly step: string;
  readonly status: "waiting" | "open" | "answered" | "defaulted" | "withdrawn";
}

/** The record the flags doubles read: T-307's, with roles, booking heads, pauses and open questions. */
export interface FlagsRecord extends TestRecord {
  readonly roles: readonly PersonRole[];
  readonly bookings: readonly BookingHead[];
  readonly pauses: readonly Pause[];
  readonly questions: readonly QuestionRow[];
}

type Values = Readonly<Record<string, unknown>>;

const str = (values: Values, column: string): string => {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
};
const strOrNull = (values: Values, column: string): string | null => {
  const value = values[column];
  return typeof value === "string" ? value : null;
};
const num = (values: Values, column: string, fallback: number): number => {
  const value = values[column];
  return typeof value === "number" ? value : fallback;
};
const dateOrNull = (values: Values, column: string): Date | null => {
  const value = strOrNull(values, column);
  return value === null ? null : new Date(value);
};

/** The record of seed rows (paths under contracts/). */
export function flagsRecordOf(files: readonly string[]): FlagsRecord {
  const rows = seedRows(files);
  const base = recordOf(rows);
  const roles: PersonRole[] = [];
  const bookings: BookingHead[] = [];
  const pauses: Pause[] = [];
  for (const { table, values } of rows) {
    if (table === "person_roles") {
      roles.push({
        id: str(values, "id"),
        personId: str(values, "person_id"),
        businessId: str(values, "business_id"),
        role: str(values, "role") as PersonRoleName,
        endedAt: dateOrNull(values, "ended_at"),
        version: num(values, "version", 1),
      });
    } else if (table === "bookings") {
      bookings.push({
        id: str(values, "id"),
        businessId: str(values, "business_id"),
        flow: str(values, "flow") as BookingFlow,
        stage: (strOrNull(values, "stage") ?? "entry") as BookingStage,
        bookerPersonId: str(values, "booker_person_id"),
        servedPersonId: strOrNull(values, "served_person_id"),
        payerPersonId: strOrNull(values, "payer_person_id"),
        private: values.private === true,
        deceased: values.deceased === true,
        version: num(values, "version", 1),
      });
    } else if (table === "pauses") {
      pauses.push(pauseOf(values));
    }
  }
  return { ...base, roles, bookings, pauses, questions: [] };
}

function pauseOf(values: Values): Pause {
  return {
    id: str(values, "id"),
    businessId: str(values, "business_id"),
    target: str(values, "target") as PauseTarget,
    personId: strOrNull(values, "person_id"),
    phoneNumber: strOrNull(values, "phone_number"),
    address: null,
    sealedForPersonId: strOrNull(values, "sealed_for_person_id"),
    setByTurnId: strOrNull(values, "set_by_turn_id"),
    setAt: new Date(str(values, "set_at")),
    clearedAt: dateOrNull(values, "cleared_at"),
    clearedByPersonId: strOrNull(values, "cleared_by_person_id"),
    version: num(values, "version", 1),
  };
}

/** The record of FLAG_SEEDS. */
export function flagsSeedRecord(): FlagsRecord {
  return flagsRecordOf(FLAG_SEEDS);
}

/** A contract file, parsed (path under contracts/). */
export function contractJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as unknown;
}

/** A K-09 v1 fixture (contracts/tool-api/fixtures), parsed; the caller states the shape it reads. */
export function k09Fixture(file: string): unknown {
  return contractJson(`tool-api/fixtures/${file}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The world: one record the doubles read and the fake commit writes

export interface World {
  record: FlagsRecord;
}

export function worldOf(record: FlagsRecord): World {
  return { record };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The record with a handle's address changed (a K-09 fixture names a number its K-04 seed does not). */
export function withHandleAddress(record: FlagsRecord, handleId: string, address: string): FlagsRecord {
  return {
    ...record,
    handles: record.handles.map((handle) => (handle.id === handleId ? { ...handle, address } : handle)),
  };
}

/** The record with these phones in place of any phone of the same handle. */
export function withPhones(record: FlagsRecord, phones: readonly Phone[]): FlagsRecord {
  const replaced = new Set(phones.map((phone) => phone.handleId));
  return {
    ...record,
    phones: [...record.phones.filter((phone) => !replaced.has(phone.handleId)), ...phones],
  };
}

/** The record with more roles, bookings or consents. */
export function withMore(
  record: FlagsRecord,
  more: {
    roles?: readonly PersonRole[];
    bookings?: readonly BookingHead[];
    consents?: readonly ConsentRow[];
    pauses?: readonly Pause[];
  },
): FlagsRecord {
  return {
    ...record,
    roles: [...record.roles, ...(more.roles ?? [])],
    bookings: [...record.bookings, ...(more.bookings ?? [])],
    consents: [...record.consents, ...(more.consents ?? [])],
    pauses: [...record.pauses, ...(more.pauses ?? [])],
  };
}

/** The record with these open questions added. */
export function withQuestions(record: FlagsRecord, questions: readonly QuestionRow[]): FlagsRecord {
  return { ...record, questions: [...record.questions, ...questions] };
}

/** The questions a turn's commit opens for its asks (waiting, under that turn's id), as K-05's commit writes them. */
export function questionsAsked(asks: readonly Ask[], turnId: string): QuestionRow[] {
  return asks.map(({ question }) => ({
    id: question.id,
    turnId,
    handleId: question.handleId,
    businessId: question.businessId,
    step: question.step,
    status: "waiting",
  }));
}

/** Whether a row is seen under a scope: on the runtime side (null) every row, else that business's only (K-04 rule 4). */
const seen = (scope: string | null, businessId: string | null): boolean =>
  scope === null || businessId === scope;

/** The flags reads over the world, as db/repo answers them under the scope (null: the runtime side). */
export function flagsReaderOn(world: World, scope: string | null): FlagsReader {
  const record = (): FlagsRecord => world.record;
  const messages = (): MessagesReader => readerOf(world.record, scope);
  return {
    handleOfAddress: (address) =>
      Promise.resolve(record().handles.find((handle) => handle.address === address) ?? null),
    handle: (handleId) => messages().handle(handleId),
    phone: (number) => Promise.resolve(record().phones.find((phone) => phone.number === number) ?? null),
    personIdsOfHandle: (handleId) =>
      Promise.resolve(
        record()
          .personHandles.filter((link) => link.handleId === handleId)
          .map((link) => link.personId)
          .sort(byId),
      ),
    handleIdsOfPerson: (personId) => messages().handleIdsOfPerson(personId),
    personExists: (personId) => Promise.resolve(record().persons.some((person) => person.id === personId)),
    liveRoles: (personId) =>
      Promise.resolve(
        record()
          .roles.filter(
            (role) => role.personId === personId && role.endedAt === null && seen(scope, role.businessId),
          )
          .sort((a, b) => byId(a.id, b.id)),
      ),
    consentWritten: (id) =>
      Promise.resolve(record().consents.some((row) => row.id === id && seen(scope, row.businessId))),
    consentsOfPersons: (personIds) => messages().consentsOfPersons(personIds),
    bookingHead: (bookingId) =>
      Promise.resolve(
        record().bookings.find((head) => head.id === bookingId && seen(scope, head.businessId)) ?? null,
      ),
    bookingsOfPerson: (personId) =>
      Promise.resolve(
        record()
          .bookings.filter(
            (head) =>
              (head.bookerPersonId === personId || head.servedPersonId === personId) &&
              seen(scope, head.businessId),
          )
          .sort((a, b) => byId(a.id, b.id)),
      ),
    pause: (pauseId) =>
      Promise.resolve(
        record().pauses.find((pause) => pause.id === pauseId && seen(scope, pause.businessId)) ?? null,
      ),
    openPausesOfPerson: (personId) =>
      Promise.resolve(
        record().pauses.filter(
          (pause) => pause.personId === personId && pause.clearedAt === null && seen(scope, pause.businessId),
        ),
      ),
    openPausesOfPhone: (number) =>
      Promise.resolve(
        record().pauses.filter(
          (pause) =>
            pause.phoneNumber === number && pause.clearedAt === null && seen(scope, pause.businessId),
        ),
      ),
    // As db/repo/targets.ts liveOpenQuestionsOfHandle: the handle's waiting or open questions, in id order.
    openQuestionsOfHandle: (handleId) =>
      Promise.resolve(
        record()
          .questions.filter(
            (question) =>
              question.handleId === handleId &&
              (question.status === "waiting" || question.status === "open") &&
              (scope === null || question.businessId === scope),
          )
          .sort((a, b) => byId(a.id, b.id))
          .map(({ id, turnId, step }) => ({ id, turnId, step })),
      ),
  };
}

/** T-307's reads over the world, under the scope (null: the runtime side). */
export function messagesReaderOn(world: World, scope: string | null): MessagesReader {
  return {
    person: (personId) => readerOf(world.record, scope).person(personId),
    handleIdsOfPerson: (personId) => readerOf(world.record, scope).handleIdsOfPerson(personId),
    handle: (handleId) => readerOf(world.record, scope).handle(handleId),
    phoneOfHandle: (handleId) => readerOf(world.record, scope).phoneOfHandle(handleId),
    chatThreadOf: (handleId) => readerOf(world.record, scope).chatThreadOf(handleId),
    consentsOfPersons: (personIds) => readerOf(world.record, scope).consentsOfPersons(personIds),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The fake of K-05's commit

/** A K-05 refusal the fake gives for a stale compare-and-set (limit 4), naming the row and both versions. */
export class StaleWriteError extends Error {
  constructor(
    readonly table: string,
    readonly rowId: string,
    readonly readVersion: number,
    readonly currentVersion: number,
  ) {
    super("version changed");
  }
}

const iso = (value: unknown): Date | null => (typeof value === "string" ? new Date(value) : null);

/** The record with state writes applied as K-05 would: inserts added, updates compared and set (raising the version). */
export function applied(record: FlagsRecord, state: readonly StateWrite[]): FlagsRecord {
  let next = record;
  for (const write of state) {
    if (write.op === "insert") {
      const { values } = write;
      if (write.table === "consents") {
        if (next.consents.some((row) => row.id === values.id)) throw new Error("consents_pkey: id taken");
        next = {
          ...next,
          consents: [
            ...next.consents,
            {
              id: str(values, "id"),
              personId: str(values, "person_id"),
              businessId: strOrNull(values, "business_id"),
              kind: str(values, "kind") as ConsentRow["kind"],
              revoked: values.revoked === true,
              handleId: strOrNull(values, "handle_id"),
              bookingId: strOrNull(values, "booking_id"),
              wordsSha256: str(values, "words_sha256"),
              at: new Date(str(values, "at")),
              channel: str(values, "channel") as ConsentRow["channel"],
              chatLinkId: strOrNull(values, "chat_link_id"),
              turnId: strOrNull(values, "turn_id"),
              exactWords: str(values, "exact_words"),
            },
          ],
        };
      } else if (write.table === "pauses") {
        next = { ...next, pauses: [...next.pauses, pauseOf(values)] };
      } else {
        throw new Error(`the fake commit has no insert for ${write.table}`);
      }
      continue;
    }
    const { set, expectVersion } = write;
    if (write.table === "phones") {
      const phone = next.phones.find((each) => each.number === write.key.number);
      if (phone === undefined) throw new Error("no such phone");
      if (phone.version !== expectVersion)
        throw new StaleWriteError("phones", phone.handleId, expectVersion, phone.version);
      const moved: Phone = {
        ...phone,
        stopped: typeof set.stopped === "boolean" ? set.stopped : phone.stopped,
        chatOpen: typeof set.chat_open === "boolean" ? set.chat_open : phone.chatOpen,
        chatOpenAt: "chat_open_at" in set ? iso(set.chat_open_at) : phone.chatOpenAt,
        stopAt: "stop_at" in set ? iso(set.stop_at) : phone.stopAt,
        startAt: "start_at" in set ? iso(set.start_at) : phone.startAt,
        version: phone.version + 1,
      };
      next = withPhones(next, [moved]);
    } else if (write.table === "bookings") {
      const head = next.bookings.find((each) => each.id === write.key.id);
      if (head === undefined) throw new Error("no such booking");
      if (head.version !== expectVersion)
        throw new StaleWriteError("bookings", head.id, expectVersion, head.version);
      const moved: BookingHead = {
        ...head,
        private: typeof set.private === "boolean" ? set.private : head.private,
        deceased: typeof set.deceased === "boolean" ? set.deceased : head.deceased,
        version: head.version + 1,
      };
      next = { ...next, bookings: next.bookings.map((each) => (each.id === head.id ? moved : each)) };
    } else if (write.table === "pauses") {
      const pause = next.pauses.find((each) => each.id === write.key.id);
      if (pause === undefined) throw new Error("no such pause");
      if (pause.version !== expectVersion)
        throw new StaleWriteError("pauses", pause.id, expectVersion, pause.version);
      const moved: Pause = {
        ...pause,
        clearedAt: "cleared_at" in set ? iso(set.cleared_at) : pause.clearedAt,
        clearedByPersonId:
          typeof set.cleared_by_person_id === "string" ? set.cleared_by_person_id : pause.clearedByPersonId,
        version: pause.version + 1,
      };
      next = { ...next, pauses: next.pauses.map((each) => (each.id === pause.id ? moved : each)) };
    } else {
      throw new Error(`the fake commit has no update for ${write.table}`);
    }
  }
  return next;
}

export interface FakeAloneCommit extends AloneCommit<unknown> {
  /** Every request the fake was given, in order. */
  readonly requests: AloneCommitRequest[];
  /** The keys it wrote, in order: a key written once is never written again. */
  readonly keys: string[];
}

/** K-05's commit with no turn, as a fake over the world: unique on its key, all or nothing, once. */
export function fakeAloneCommit(world: World): FakeAloneCommit {
  const requests: AloneCommitRequest[] = [];
  const keys: string[] = [];
  return {
    requests,
    keys,
    commit(request) {
      requests.push(structuredClone(request));
      if (keys.includes(request.key)) return Promise.resolve({ committed: true, repeated: true });
      try {
        world.record = applied(world.record, request.writes.state);
      } catch (error) {
        if (error instanceof StaleWriteError) {
          return Promise.resolve({
            error: "versionChanged",
            changed: [
              {
                table: error.table,
                rowId: error.rowId,
                readVersion: error.readVersion,
                currentVersion: error.currentVersion,
              },
            ],
          });
        }
        throw error;
      }
      keys.push(request.key);
      return Promise.resolve({ committed: true, repeated: false });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Ids and event sources

/** The ids a K-09 fixture names, by row, key and part; any other row takes the Worker's keyed id. */
export function fixtureIds(named: readonly (readonly [FlagRow, string, string | null, string])[]): FlagIds {
  return {
    rowId(row, key, part) {
      const found = named.find(
        ([kind, namedKey, namedPart]) => kind === row && namedKey === key && namedPart === (part ?? null),
      );
      return found === undefined ? KEYED_IDS.rowId(row, key, part) : Promise.resolve(found[3]);
    },
  };
}

/** The handle actor's own record of each event's handle (T-269's queue), as a fake. */
export function eventSourcesOf(events: Readonly<Record<string, string>>): EventSources {
  return { handleOf: (eventId) => Promise.resolve(events[eventId] ?? null) };
}
