// Doubles for the clock arming's tests (T-255). Not imported by the Worker. They answer as the frozen contracts state:
//
//   - K-05 v1 `armClock` and `cancelClock` (README item 5) over a store of clock rows (K-04 clock_rows: waiting, armed,
//     fired, cancelled): armClock finds the row, or the question's `question` row, and moves waiting to armed with the
//     due time, its question to open; an armed row answers `repeated` with its first arming; a fired or cancelled one
//     `clockClosed`; an unknown one `notFound` (arm-clock.json). cancelClock moves a waiting or armed row to cancelled,
//     compared on its version; a cancelled row answers `repeated`, a fired one `alreadyFired` (cancel-clock.json).
//     A7-03's question row starts as commit-opens-question.json made it: waiting, version 1, on Alex's handle.
//   - The question's facts: A7-03's from K-04 v1's seeds (seed-open-question.json's clock "24 h", seed-business-head.json's
//     zone, seed-booking-head.json's flow, seed-reservation.json's visit start). Its first delivery receipt is
//     mark-a7-03-delivered-by-key.json's answer and time, as the dispatcher hands a delivered part on.
//   - K-17 v1 `geocode`: the double's answers, the port-geo fixtures; any other request `notFound`.
//   - The HandleActor namespace and the directory: each actor's `syncClocks` calls, in order.
//
// Test values only (rule 9).

import armClockFixture from "../../../contracts/data-access/fixtures/arm-clock.json";
import commitOpensQuestion from "../../../contracts/data-access/fixtures/commit-opens-question.json";
import markA703Delivered from "../../../contracts/data-access/fixtures/mark-a7-03-delivered-by-key.json";
import seedBookingHead from "../../../contracts/db-schema/core/fixtures/seed-booking-head.json";
import seedBusinessHead from "../../../contracts/db-schema/core/fixtures/seed-business-head.json";
import seedOpenQuestion from "../../../contracts/db-schema/core/fixtures/seed-open-question.json";
import seedReservation from "../../../contracts/db-schema/core/fixtures/seed-reservation.json";
import geocodeDemoShop from "../../../contracts/port-geo/fixtures/geocode-demo-shop.json";
import geocodeStreet from "../../../contracts/port-geo/fixtures/geocode-street.json";
import geocodeStreetPartial from "../../../contracts/port-geo/fixtures/geocode-street-partial.json";
import geocodeTown from "../../../contracts/port-geo/fixtures/geocode-town.json";
import { ArmingMemory, type ArmingOptions, type DeliveredPart } from "./arming";
import type {
  ArmClockAnswer,
  ArmClockRequest,
  ArmingData,
  CancelClockAnswer,
  CancelClockRequest,
  ClockActors,
  ClockDirectory,
  FireReport,
  GeocodeAnswer,
  GeocodeRequest,
  GeoPort,
  QuestionFacts,
  QuestionFactsReader,
  TransientError,
} from "./types";

type Json = Record<string, unknown>;

/** A fixture list's first item, or a thrown error naming what is missing. */
function firstOf<T>(list: readonly T[], what: string): T {
  const item = list[0];
  if (item === undefined) throw new Error(`${what} is missing`);
  return item;
}

const QUESTION_ROW = firstOf(
  commitOpensQuestion.request.writes.clockRows.make,
  "commit-opens-question.json's clock row",
);
const OPEN_QUESTION = firstOf(seedOpenQuestion.rows, "seed-open-question.json's open question").values;

/** A7-03's open question (seed-open-question.json; commit-opens-question.json). */
export const A7_03_QUESTION = OPEN_QUESTION.id;
/** A7-03's question clock row, as commit-opens-question.json makes it. */
export const A7_03_CLOCK_ROW = QUESTION_ROW.id;
export const ALEX_HANDLE = QUESTION_ROW.handleId;
export const ALEX_ACTOR = "phone:+15555550101";

function valuesOf(rows: readonly { table: string; values: Json }[], id: string): Json {
  const found = rows.find((row) => row.values.id === id);
  if (found === undefined) throw new Error(`no seed row ${id}`);
  return found.values;
}

const business = valuesOf(seedBusinessHead.rows, OPEN_QUESTION.business_id);
const booking = valuesOf(seedBookingHead.rows, OPEN_QUESTION.booking_id);
const reservation = seedReservation.rows.find((row) => row.values.booking_id === OPEN_QUESTION.booking_id);
if (reservation === undefined) throw new Error("no seed reservation for A7-03's booking");
const businessZone = business.time_zone;
if (typeof businessZone !== "string") throw new Error("seed-business-head.json gives the barbershop no zone");
/** The lower bound of a K-04 tstzrange written `[start,end)`. */
const startOf = (during: string): string => during.slice(1, during.indexOf(","));

/** A7-03's facts from K-04 v1's seeds: the Clock line "24 h", the barbershop's zone, a flow A visit Sat Oct 24, 11am. */
export const A7_03_FACTS: QuestionFacts = {
  openQuestionId: A7_03_QUESTION,
  clockLine: OPEN_QUESTION.clock,
  businessZone,
  visit: {
    startsAt: startOf(reservation.values.during),
    flow: booking.flow === "B" ? "B" : "A",
    addressZone: null,
    address: null,
  },
  neverDelivered: null,
};

/** The request arm-clock.json makes for A7-03's first delivery receipt. */
export const A7_03_ARM_REQUEST = armClockFixture.request;

/** A7-03's first delivery receipt as the dispatcher hands it on (mark-a7-03-delivered-by-key.json's answer and time). */
export const A7_03_DELIVERED: DeliveredPart = {
  outboxRowId: markA703Delivered.outcome.outboxRowId,
  partNo: markA703Delivered.outcome.partNo === 2 ? 2 : 1,
  tryNo: markA703Delivered.outcome.tryNo,
  firstDelivery: markA703Delivered.outcome.firstDelivery,
  openQuestionId: markA703Delivered.outcome.openQuestionId,
  deliveredAt: markA703Delivered.request.at,
};

type RowState = "waiting" | "armed" | "fired" | "cancelled";

interface StoredRow {
  clockRowId: string;
  kind: string;
  openQuestionId: string | null;
  handleId: string | null;
  state: RowState;
  version: number;
  armedAt: string | null;
  dueAt: string | null;
  dueZone: string | null;
  firedAt: string | null;
  cancelledAt: string | null;
}

export interface FakeArmingData {
  readonly data: ArmingData;
  /** Every armClock request, in order, as sent. */
  readonly armRequests: ArmClockRequest[];
  /** Every cancelClock request, in order, as sent. */
  readonly cancelRequests: CancelClockRequest[];
  /** Every answer armClock gave, in order. */
  readonly armAnswers: ArmClockAnswer[];
  /** The question each opened (K-05 default 8: waiting to open with its arming). */
  readonly openedQuestions: string[];
  /** Answers given before the store is reached, one per call, first in first out (a transient, a throw). */
  readonly armScript: (ArmClockAnswer | "throw")[];
  readonly cancelScript: (CancelClockAnswer | "throw")[];
  /** When true, armClock waits a moment before its compare-and-set, as a call over the network does. */
  slow: boolean;
  /** Makes a row: waiting, or armed at once with `due` (K-05 clockNew: a commit that knows the due time). */
  make(row: {
    clockRowId: string;
    kind: string;
    openQuestionId: string | null;
    handleId: string | null;
    due?: { armedAt: string; dueAt: string; dueZone: string };
  }): void;
  /** Sets a row's state, as a firing or a cancel elsewhere would (its version rises by one). */
  move(clockRowId: string, state: "fired" | "cancelled", at: string): void;
  /** A row as the store holds it now. */
  rowOf(clockRowId: string): Readonly<StoredRow>;
}

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

export const TRANSIENT: TransientError = { error: "transient", sqlstate: "40001" };

export function fakeArmingData(): FakeArmingData {
  const store = new Map<string, StoredRow>();

  const find = (request: ArmClockRequest): StoredRow | undefined => {
    if ("clockRowId" in request) return store.get(request.clockRowId);
    return [...store.values()].find(
      (row) => row.kind === "question" && row.openQuestionId === request.openQuestionId,
    );
  };

  const armed = (row: StoredRow, repeated: boolean): ArmClockAnswer => ({
    result: "armed",
    repeated,
    clock: {
      clockRowId: row.clockRowId,
      version: row.version,
      armedAt: row.armedAt ?? "",
      dueAt: row.dueAt ?? "",
      dueZone: row.dueZone ?? "",
      handleId: row.handleId,
    },
  });

  /** K-05 v1 armClock's rules (README item 5), as one synchronous step under the row's lock. */
  const armClock = (request: ArmClockRequest): ArmClockAnswer => {
    const row = find(request);
    if (row === undefined) {
      const rowId = "clockRowId" in request ? request.clockRowId : request.openQuestionId;
      return { error: "notFound", table: "clock_rows", rowId };
    }
    if (row.state === "armed") return armed(row, true);
    if (row.state === "fired" || row.state === "cancelled") {
      return { error: "clockClosed", clockRowId: row.clockRowId, state: row.state };
    }
    row.state = "armed";
    row.version += 1;
    row.armedAt = request.deliveredAt;
    row.dueAt = request.dueAt;
    row.dueZone = request.dueZone;
    if (row.openQuestionId !== null) fake.openedQuestions.push(row.openQuestionId);
    return armed(row, false);
  };

  /** K-05 v1 cancelClock's rules (README item 5). */
  const cancelClock = (request: CancelClockRequest): CancelClockAnswer => {
    const row = store.get(request.clockRowId);
    if (row === undefined) return { error: "notFound", table: "clock_rows", rowId: request.clockRowId };
    if (row.state === "fired") {
      return { error: "alreadyFired", clockRowId: row.clockRowId, firedAt: row.firedAt ?? "" };
    }
    if (row.state === "cancelled") {
      return {
        result: "cancelled",
        clockRowId: row.clockRowId,
        version: row.version,
        cancelledAt: row.cancelledAt ?? "",
        repeated: true,
      };
    }
    if (row.version !== request.expectVersion) {
      return {
        error: "versionChanged",
        changed: [
          {
            table: "clock_rows",
            rowId: row.clockRowId,
            readVersion: request.expectVersion,
            currentVersion: row.version,
          },
        ],
      };
    }
    row.state = "cancelled";
    row.version += 1;
    row.cancelledAt = request.at;
    return {
      result: "cancelled",
      clockRowId: row.clockRowId,
      version: row.version,
      cancelledAt: request.at,
      repeated: false,
    };
  };

  const fake: FakeArmingData = {
    armRequests: [],
    cancelRequests: [],
    armAnswers: [],
    openedQuestions: [],
    armScript: [],
    cancelScript: [],
    slow: false,
    make(row) {
      store.set(row.clockRowId, {
        clockRowId: row.clockRowId,
        kind: row.kind,
        openQuestionId: row.openQuestionId,
        handleId: row.handleId,
        state: row.due === undefined ? "waiting" : "armed",
        version: 1,
        armedAt: row.due?.armedAt ?? null,
        dueAt: row.due?.dueAt ?? null,
        dueZone: row.due?.dueZone ?? null,
        firedAt: null,
        cancelledAt: null,
      });
    },
    move(clockRowId, state, at) {
      const row = store.get(clockRowId);
      if (row === undefined) throw new Error(`no clock row ${clockRowId}`);
      row.state = state;
      row.version += 1;
      if (state === "fired") row.firedAt = at;
      else row.cancelledAt = at;
    },
    rowOf(clockRowId) {
      const row = store.get(clockRowId);
      if (row === undefined) throw new Error(`no clock row ${clockRowId}`);
      return { ...row };
    },
    data: {
      async armClock(request) {
        fake.armRequests.push(structuredClone(request));
        const scripted = fake.armScript.shift();
        if (scripted === "throw") throw new Error("no answer");
        if (fake.slow) await pause();
        const answer = scripted ?? armClock(request);
        fake.armAnswers.push(structuredClone(answer));
        return answer;
      },
      cancelClock(request) {
        fake.cancelRequests.push(structuredClone(request));
        const scripted = fake.cancelScript.shift();
        if (scripted === "throw") return Promise.reject(new Error("no answer"));
        return Promise.resolve(scripted ?? cancelClock(request));
      },
    },
  };
  // A7-03's question row, as its commit made it (commit-opens-question.json): waiting, version 1.
  fake.make({
    clockRowId: QUESTION_ROW.id,
    kind: QUESTION_ROW.kind,
    openQuestionId: QUESTION_ROW.openQuestionId,
    handleId: QUESTION_ROW.handleId,
  });
  return fake;
}

export interface FakeFacts {
  readonly reader: QuestionFactsReader;
  /** The facts each question reads; a question not here answers notFound. */
  readonly facts: Map<string, QuestionFacts>;
  /** Every read, in order. */
  readonly reads: string[];
  /** Answers given before the facts, one per read (a transient). */
  readonly script: TransientError[];
}

export function fakeFacts(): FakeFacts {
  const fake: FakeFacts = {
    facts: new Map([[A7_03_QUESTION, structuredClone(A7_03_FACTS)]]),
    reads: [],
    script: [],
    reader: {
      questionFacts(openQuestionId) {
        fake.reads.push(openQuestionId);
        const scripted = fake.script.shift();
        if (scripted !== undefined) return Promise.resolve(scripted);
        const facts = fake.facts.get(openQuestionId);
        return Promise.resolve(
          facts === undefined
            ? { error: "notFound", table: "open_questions", rowId: openQuestionId }
            : structuredClone(facts),
        );
      },
    },
  };
  return fake;
}

/** The geo double's answers (K-17 v1 README "The double"): the port-geo fixtures. */
const GEO_ANSWERS = [geocodeStreet, geocodeStreetPartial, geocodeDemoShop, geocodeTown];

export interface FakeGeo {
  readonly geo: GeoPort;
  /** Every request, in order. */
  readonly requests: GeocodeRequest[];
  /** When set, the next call answers this (an error fixture's outcome) or throws. */
  next: GeocodeAnswer | "throw" | null;
}

export function fakeGeo(): FakeGeo {
  const fake: FakeGeo = {
    requests: [],
    next: null,
    geo: {
      geocode(request) {
        fake.requests.push({ ...request });
        const next = fake.next;
        fake.next = null;
        if (next === "throw") return Promise.reject(new Error("no answer"));
        if (next !== null) return Promise.resolve(next);
        const known = GEO_ANSWERS.find(
          (fixture) => fixture.request.kind === request.kind && fixture.request.text === request.text,
        );
        return Promise.resolve((known?.outcome ?? { result: "notFound" }) as GeocodeAnswer);
      },
    },
  };
  return fake;
}

export interface WiredArming {
  data: FakeArmingData;
  facts: FakeFacts;
  geo: FakeGeo;
  actors: FakeActors;
  /** What armAtDelivery and clockArming take, joined to the doubles above. */
  options: ArmingOptions;
}

/** The arming's ports as doubles, with a memory of armed parts of its own (one isolate's). */
export function wireArming(memory: ArmingMemory = new ArmingMemory()): WiredArming {
  const data = fakeArmingData();
  const facts = fakeFacts();
  const geo = fakeGeo();
  const actors = fakeActors();
  return {
    data,
    facts,
    geo,
    actors,
    options: {
      data: data.data,
      facts: facts.reader,
      geo: geo.geo,
      directory: actors.directory,
      actors: actors.actors,
      log: { environment: "staging", version: "test-sha" },
      memory,
    },
  };
}

export interface FakeActors {
  readonly actors: ClockActors<string>;
  readonly directory: ClockDirectory;
  /** The directory: handle id to actor name. */
  readonly names: Map<string, string>;
  /** Every syncClocks call: the actor reached and the handle it was given. */
  readonly syncs: { actor: string; handleId: string }[];
  /** When true, syncClocks throws (an actor that cannot be reached). */
  failing: boolean;
}

export function fakeActors(): FakeActors {
  const fake: FakeActors = {
    names: new Map([[ALEX_HANDLE, ALEX_ACTOR]]),
    syncs: [],
    failing: false,
    directory: {
      actorNameOf(handleId) {
        return Promise.resolve(fake.names.get(handleId) ?? null);
      },
    },
    actors: {
      idFromName: (name) => name,
      get: (actor) => ({
        fireClockRow: () => Promise.reject(new Error("not used by the arming")),
        syncClocks(handleId): Promise<FireReport[]> {
          if (fake.failing) return Promise.reject(new Error("unreachable"));
          fake.syncs.push({ actor, handleId });
          return Promise.resolve([]);
        },
      }),
    },
  };
  return fake;
}
