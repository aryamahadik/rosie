// Doubles and scenarios for limit 5's tests (T-303). Never imported by the Worker. The doubles stand in for limit 5's
// ports (the walk that names a part's saved times, the saved times' read, C-131's next open times), for limits 1 to 4
// and 6 (T-299 to T-302, T-304), for the commit's other ports, and for K-05 v1's data-access calls (a fake that holds
// reservations as K-05 v1 items 1 and 9 say), never for limit 5 or the commit itself. Values come only from the contracts'
// fixtures and the master's sample cast: K-04 v1's seed-reservation.json (Alex's saved time with Avery, the two agent
// tokens waiting for it), K-05 v1's reservation exchanges (Tomás next in line, the clock letting Alex's time go, the
// refused commit), K-09 v1's exchanges (A4-14's times card), A6-11's next times; phone numbers in the 555-01xx range
// (rule 9). Open times the steps do not print are examples (K-09 v1.1 README open gap 48).

import type * as K05 from "../../../../contracts/generated/data-access/data-access.v1.1";
import {
  contractChecks,
  doublePorts,
  noWrites,
  whyOfChoice,
  type K05Fake,
  type PortCalls,
} from "../../commit/test-support";
import type {
  CommitDeps,
  CommitPorts,
  CommitTurnAnswer,
  CommitTurnRequest,
  CommitTurnResponse,
  ReservationConfirm,
  RowRef,
  StateWrite,
  UnitWrites,
} from "../../commit/types";
import { contractFile } from "../../tool-api/test-support";
import type {
  Choice,
  Context,
  DecidePart,
  GatePart,
  GateRequest,
  GateTurn,
  GatedVerbPart,
  Limit,
  LimitRegistry,
} from "../framework";
import {
  copy,
  gateExchange,
  scriptedLimits,
  type LimitCall,
  type PartScript,
  type Script,
} from "../framework/test-support";
import {
  ALEX,
  BARBERSHOP,
  ZONE,
  barbershopTarget,
  option,
  requestFor,
  typed,
  type Someone,
} from "../limit-3/test-support";
import { createLimit5, type ReservedLimit } from "./index";
import type {
  BookedTimes,
  LostTime,
  OpenTime,
  OpenTimesFinder,
  OpenTimesQuery,
  ReservationReader,
  SavedTime,
} from "./types";
import { utcOf } from "./window";

export type StepCard = Context["cards"][number];

/** The repo a test hands the limit: the doubles never read it. */
export const TEST_REPO = { name: "limit-5-test-repo" } as const;

const MINUTE = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// The gate's view of a request

/** The gate turn one request gives a limit (as runGate makes it), in the request's business scope. */
export function turnOf(request: GateRequest, repo: unknown = TEST_REPO): GateTurn {
  const { input, caller } = request;
  if (input.kind !== "decided") throw new Error("limit 5's tests gate decided texts");
  if (caller.businessId === null) throw new Error("a gated request names its business");
  return {
    request,
    context: input.decided.context,
    decide: input.decided.decide,
    repo,
    businessId: caller.businessId,
  };
}

function isGated(part: DecidePart): part is GatedVerbPart {
  return (
    part.verb === "choose" || part.verb === "enter" || part.verb === "pass_on" || part.verb === "hand_off"
  );
}

/** Part `index` of a request as the gate hands it to a limit, with the offered choice it names (as runGate finds it). */
export function partOf(request: GateRequest, index = 0): GatePart {
  const { input } = request;
  if (input.kind !== "decided") throw new Error("limit 5's tests gate decided texts");
  const entry = input.decided.decide.parts[index];
  if (entry === undefined || !isGated(entry.part)) throw new Error(`no gated part ${String(index)}`);
  const { part } = entry;
  const choiceId = part.verb === "choose" || part.verb === "enter" ? part.choice : null;
  const choice = input.decided.context.choices.find((each) => each.choiceId === choiceId) ?? null;
  return { index, part, choice };
}

/** The decided pair a request carries. */
export function decidedIn(
  request: GateRequest,
): Extract<GateRequest["input"], { kind: "decided" }>["decided"] {
  if (request.input.kind !== "decided") throw new Error("not decided texts");
  return request.input.decided;
}

/** A K-09 gate exchange's request, freshly parsed. */
export function exchangeRequest(file: string): GateRequest {
  return copy(gateExchange(file).request);
}

/** Limits 1 to 4 and 6 as the gate framework's scripted doubles, with `limit` in slot 5 (each call written down). */
export function registryWith(
  limit: ReservedLimit,
  script: Script = {},
  calls: LimitCall[] = [],
): LimitRegistry {
  const [one, two, three, four, , six] = scriptedLimits(script, calls);
  const five: Limit<5> = {
    limit: 5,
    check(part, turn) {
      calls.push({ limit: 5, part: part.index });
      return limit.check(part, turn);
    },
  };
  return [one, two, three, four, five, six];
}

/** A K-09 gate fixture's script without limit 5's verdict: the real limit 5 gives its own. */
export function withoutLimit5(script: Script): Script {
  const out: Record<number, PartScript> = {};
  for (const [part, verdicts] of Object.entries(script)) {
    if (verdicts === undefined) continue;
    const rest: PartScript = { ...verdicts };
    Reflect.deleteProperty(rest, 5);
    out[Number(part)] = rest;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Limit 5's ports as doubles

/** One question the walk was asked: which turn's part. */
export interface WalkAsked {
  readonly turnId: string;
  readonly part: number;
}

/** The walk after each turn's part (by the context's turn id): the saved times it books; none for any other. */
export function walkOf(
  byTurn: Readonly<Partial<Record<string, readonly string[]>>>,
  asked: WalkAsked[] = [],
): BookedTimes {
  return {
    savedTimesOf(part, turn) {
      asked.push({ turnId: turn.context.turnId, part: part.index });
      return Promise.resolve([...(byTurn[turn.context.turnId] ?? [])]);
    },
  };
}

/** Saved times read from a fixed list: a row answers by its id; any other id is gone. */
export function readerOf(rows: readonly SavedTime[], read: string[] = []): ReservationReader {
  return {
    reservation(id) {
      read.push(id);
      const row = rows.find((each) => each.id === id);
      return Promise.resolve(row === undefined ? null : copy(row));
    },
  };
}

/** One search C-131 was asked for: which part, and the saved times that no longer hold it. */
export interface FinderAsked {
  readonly part: number;
  readonly lost: readonly LostTime[];
}

/** C-131's search as a double: the same open times for every query, each query written down. */
export function finderOf(times: readonly OpenTime[], queries: FinderAsked[] = []): OpenTimesFinder {
  return {
    nextOpenTimes(query: OpenTimesQuery) {
      queries.push({ part: query.part.index, lost: copy([...query.lost]) });
      return Promise.resolve(times.map((time) => copy(time)));
    },
  };
}

export interface World {
  /** The saved times each turn's part books, by the context's turn id. */
  readonly walk: Readonly<Partial<Record<string, readonly string[]>>>;
  /** The saved times as they stand, or a reader over a K-05 fake. */
  readonly rows: readonly SavedTime[] | ReservationReader;
  /** The next open times C-131 would find. */
  readonly times: readonly OpenTime[];
}

/** What a limit's doubles were asked. */
export interface Asked {
  readonly walk: WalkAsked[];
  readonly read: string[];
  readonly queries: FinderAsked[];
  /** How many times the saved times' reader was made. */
  readers: number;
}

export function asked(): Asked {
  return { walk: [], read: [], queries: [], readers: 0 };
}

/** Limit 5 itself, over doubles of its ports. */
export function limitIn(world: World, seen: Asked = asked()): ReservedLimit {
  const reader = Array.isArray(world.rows)
    ? readerOf(world.rows as readonly SavedTime[], seen.read)
    : (world.rows as ReservationReader);
  return createLimit5({
    bookedTimes: walkOf(world.walk, seen.walk),
    reservations: () => {
      seen.readers += 1;
      return reader;
    },
    openTimes: finderOf(world.times, seen.queries),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// K-05 v1's reservations, as a fake

/** A reservation row as the fake holds it: limit 5's view, and the two times the fake's own moves read. */
export interface FakeReservation extends SavedTime {
  /** When it was written; for a waiting row, its place in line (K-04 v1 reservations.queued_at; A4-18). */
  readonly queuedAt: string;
  readonly releasedAt: string | null;
}

/** K-05 v1's reservation calls on an in-memory table, with commitTurn as the commit's port calls it. */
export interface ReservationsFake extends K05Fake {
  /** The database's now(): a held row reaches its end at it (K-05 v1 item 1). */
  now: string;
  /** Every row as it stands now, by id. */
  readonly rows: ReadonlyMap<string, FakeReservation>;
  /** Adds rows as they are. */
  seed(rows: readonly FakeReservation[]): void;
  /** K-05 v1 release (item 9): the row let go, the next in line promoted. */
  release(request: K05.ReleaseRequest): K05.ReleaseResponse | K05.ReleaseErrors;
  /** The rows as limit 5 reads them, on the fake's table. */
  readonly reader: ReservationReader;
}

/** A saved time's standard length: 10 minutes (S12-01; K-05 v1 item 9's promotion). */
export const STANDARD_HOLD_MINUTES = 10;
/** At most 2 saved times per mobile, and per agent token at one business (arch 05 line 247). */
const SAVED_TIME_CAP = 2;

const overlaps = (a: SavedTime["during"], b: SavedTime["during"]): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

const byQueue = (a: FakeReservation, b: FakeReservation): number => {
  const byTime = Date.parse(a.queuedAt) - Date.parse(b.queuedAt);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** The view limit 5 reads of a fake row: its K-04 v1 columns, without the fake's own times. */
export function savedTimeOfFake(row: FakeReservation): SavedTime {
  return {
    id: row.id,
    businessId: row.businessId,
    resourceId: row.resourceId,
    during: { ...row.during },
    state: row.state,
    heldUntil: row.heldUntil,
    forPhoneNumber: row.forPhoneNumber,
    forAgentToken: row.forAgentToken,
    bookingId: row.bookingId,
    releasedWhy: row.releasedWhy,
    version: row.version,
  };
}

/**
 * K-05 v1's reservation calls, holding rows in memory as K-05 v1 says:
 *   - commitTurn (item 1): a request K-05 v1.1's schema refuses throws; a turn id committed before writes nothing and
 *     returns the first commit with `repeated` true; every reservation to confirm is checked first, and one that is not
 *     held, or held past its end at the fake's now, refuses the whole commit with reservationLost (limit 5, "checked
 *     before its version"); then each reservation confirmed or released at a version other than its own refuses it with
 *     versionChanged, as does a row of `versionsRead` the fake holds (reservations, and the versions it was given); else
 *     everything is written at once: a confirm moves the row to booked with its booking, a release lets it go and promotes
 *     the next in line (item 9). Each commit runs in one step, so commits never interleave, as one transaction each;
 *   - release (item 9): expired needs a held row past its end, else the version is compared; the row is released, and
 *     when it was held or booked, the waiting rows of its resource whose time overlaps it are taken in queued_at order (a
 *     tie to the lower id): the first under its mobile's or token's cap of 2 that no held or booked row overlaps is held
 *     for the standard 10 minutes and promoted.
 */
export function reservationsFake(options: { now: string; versions?: readonly RowRef[] }): ReservationsFake {
  const rows = new Map<string, FakeReservation>();
  const versions = [...(options.versions ?? [])];
  const firsts = new Map<string, CommitTurnResponse>();
  const requests: CommitTurnRequest[] = [];
  const commits: { turnId: string; written: RowRef[] }[] = [];
  let nextSeq = 1;

  const holds = (row: FakeReservation, now: string): boolean =>
    row.state === "held" && row.heldUntil !== null && Date.parse(row.heldUntil) > Date.parse(now);

  const atCap = (waiting: FakeReservation, at: string): boolean => {
    const held = [...rows.values()].filter((row) => holds(row, at));
    if (waiting.forPhoneNumber !== null) {
      return held.filter((row) => row.forPhoneNumber === waiting.forPhoneNumber).length >= SAVED_TIME_CAP;
    }
    if (waiting.forAgentToken !== null) {
      return (
        held.filter(
          (row) => row.forAgentToken === waiting.forAgentToken && row.businessId === waiting.businessId,
        ).length >= SAVED_TIME_CAP
      );
    }
    return false;
  };

  const blocked = (waiting: FakeReservation): boolean =>
    [...rows.values()].some(
      (row) =>
        row.id !== waiting.id &&
        row.resourceId === waiting.resourceId &&
        (row.state === "held" || row.state === "booked") &&
        overlaps(row.during, waiting.during),
    );

  const promoteAfter = (
    released: FakeReservation,
    at: string,
  ): { promoted: K05.Promotion | null; skipped: K05.SkippedInLine[] } => {
    const line = [...rows.values()]
      .filter(
        (row) =>
          row.state === "waiting" &&
          row.resourceId === released.resourceId &&
          overlaps(row.during, released.during),
      )
      .sort(byQueue);
    const skipped: K05.SkippedInLine[] = [];
    for (const waiting of line) {
      if (atCap(waiting, at)) {
        skipped.push({ reservationId: waiting.id, reason: "savedTimeCap" });
        continue;
      }
      if (blocked(waiting)) {
        skipped.push({ reservationId: waiting.id, reason: "overlap" });
        continue;
      }
      const held: FakeReservation = {
        ...waiting,
        state: "held",
        heldUntil: utcOf(Date.parse(at) + STANDARD_HOLD_MINUTES * MINUTE),
        version: waiting.version + 1,
      };
      rows.set(held.id, held);
      return {
        promoted: {
          reservationId: held.id,
          version: held.version,
          heldUntil: held.heldUntil ?? at,
          forPhoneNumber: held.forPhoneNumber,
          forAgentToken: held.forAgentToken,
          bookingId: held.bookingId,
          savedTimeClockId: `${held.id}/saved-time`,
        },
        skipped,
      };
    }
    return { promoted: null, skipped };
  };

  const letGo = (row: FakeReservation, why: K05.ReleaseRequest["why"], at: string) => {
    const holding = row.state === "held" || row.state === "booked";
    const released: FakeReservation = {
      ...row,
      state: "released",
      releasedWhy: why,
      releasedAt: at,
      version: row.version + 1,
    };
    rows.set(released.id, released);
    const next = holding ? promoteAfter(released, at) : { promoted: null, skipped: [] };
    return { released, ...next };
  };

  const mustRow = (id: string): FakeReservation => {
    const row = rows.get(id);
    if (row === undefined) throw new Error(`the fake holds no reservation ${id}`);
    return row;
  };

  const commit = (request: CommitTurnRequest, now: string): CommitTurnAnswer => {
    const { writes } = request;
    // Limit 5 first: every reservation to confirm still held, before any version (K-05 v1 item 1).
    const lost = writes.reservations.confirm.flatMap((confirm) => {
      const row = mustRow(confirm.id);
      return holds(row, now)
        ? []
        : [{ id: row.id, state: row.state, heldUntil: row.heldUntil, releasedWhy: row.releasedWhy }];
    });
    const [firstLost, ...moreLost] = lost;
    if (firstLost !== undefined) return { error: "reservationLost", reservations: [firstLost, ...moreLost] };

    // Limit 4: the reservations at the versions given, and every row read that the fake holds.
    const changed: K05.ChangedRow[] = [];
    const compare = (table: string, rowId: string, read: number, current: number | undefined): void => {
      if (current !== undefined && current !== read) {
        changed.push({ table, rowId, readVersion: read, currentVersion: current });
      }
    };
    for (const each of [...writes.reservations.confirm, ...writes.reservations.release]) {
      compare("reservations", each.id, each.expectVersion, mustRow(each.id).version);
    }
    for (const read of request.versionsRead) {
      const current =
        read.table === "reservations"
          ? rows.get(read.rowId)?.version
          : versions.find((row) => row.table === read.table && row.rowId === read.rowId)?.version;
      compare(read.table, read.rowId, read.version, current);
    }
    const [firstChanged, ...moreChanged] = changed;
    if (firstChanged !== undefined)
      return { error: "versionChanged", changed: [firstChanged, ...moreChanged] };

    // The writes, all at once.
    const written: RowRef[] = [];
    const row = (table: string, rowId: string, version: number): void => {
      written.push({ table, rowId, version });
    };
    for (const write of writes.state) {
      if (write.op === "insert") row(write.table, String(write.values.id), 1);
      else row(write.table, String(write.key.id), write.expectVersion + 1);
    }
    for (const question of writes.openQuestions.open) row("open_questions", question.id, 1);
    for (const close of writes.openQuestions.close) row("open_questions", close.id, close.expectVersion + 1);
    for (const clock of writes.clockRows.make) row("clock_rows", String(clock.id), 1);
    for (const cancel of writes.clockRows.cancel) row("clock_rows", cancel.id, cancel.expectVersion + 1);
    for (const confirm of writes.reservations.confirm) {
      const before = mustRow(confirm.id);
      const booked: FakeReservation = {
        ...before,
        state: "booked",
        bookingId: confirm.bookingId,
        version: before.version + 1,
      };
      rows.set(booked.id, booked);
      row("reservations", booked.id, booked.version);
      row("clock_rows", `${booked.id}/saved-time`, 2);
    }
    const promoted: K05.Promotion[] = [];
    for (const release of writes.reservations.release) {
      const done = letGo(mustRow(release.id), release.why, now);
      row("reservations", done.released.id, done.released.version);
      if (done.promoted !== null) promoted.push(done.promoted);
    }
    const outboxRows = writes.outboxRows.map((outbox) => ({ id: outbox.id, commitSeq: nextSeq++ }));
    const answer: CommitTurnResponse = {
      result: "committed",
      turnId: request.turn.id,
      committedAt: now,
      repeated: false,
      committed: { written, outboxRows, promoted },
    };
    firsts.set(answer.turnId, copy(answer));
    commits.push({ turnId: answer.turnId, written: copy(written) });
    return answer;
  };

  const fake: ReservationsFake = {
    now: options.now,
    rows,
    requests,
    commits,
    seed(seeded) {
      for (const each of seeded) rows.set(each.id, copy(each));
    },
    release(request) {
      const row = rows.get(request.reservationId);
      if (row === undefined)
        return { error: "notFound", table: "reservations", rowId: request.reservationId };
      if (row.state === "released") {
        return {
          result: "released",
          reservationId: row.id,
          version: row.version,
          releasedAt: row.releasedAt ?? request.at,
          why: row.releasedWhy ?? request.why,
          promoted: null,
          skipped: [],
          repeated: true,
        };
      }
      if (request.why === "expired") {
        if (
          row.state !== "held" ||
          row.heldUntil === null ||
          Date.parse(row.heldUntil) > Date.parse(request.at)
        ) {
          return { error: "notExpired", reservationId: row.id, heldUntil: row.heldUntil ?? request.at };
        }
      } else if (request.expectVersion !== row.version) {
        return {
          error: "versionChanged",
          changed: [
            {
              table: "reservations",
              rowId: row.id,
              readVersion: request.expectVersion ?? 0,
              currentVersion: row.version,
            },
          ],
        };
      }
      const done = letGo(row, request.why, request.at);
      return {
        result: "released",
        reservationId: done.released.id,
        version: done.released.version,
        releasedAt: request.at,
        why: request.why,
        promoted: done.promoted,
        skipped: done.skipped,
        repeated: false,
      };
    },
    reader: {
      reservation(id) {
        const row = rows.get(id);
        return Promise.resolve(row === undefined ? null : savedTimeOfFake(row));
      },
    },
    commitTurn(request) {
      requests.push(copy(request));
      const problems = contractChecks().k05("commitTurn.request", request);
      if (problems.length > 0) {
        return Promise.reject(new Error(`K-05 v1.1 refuses the request: ${problems.join("; ")}`));
      }
      const first = firsts.get(request.turn.id);
      if (first !== undefined) {
        return Promise.resolve({
          ...copy(first),
          repeated: true,
          committed: { written: [], outboxRows: copy(first.committed.outboxRows), promoted: [] },
        });
      }
      return Promise.resolve(commit(request, fake.now));
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------------------------------------------
// K-04 v1's seeds and K-05 v1's exchanges

interface SeedRows {
  readonly rows: readonly { readonly table: string; readonly values: Readonly<Record<string, unknown>> }[];
}

const DURING = /^\[([^,]+),([^)]+)\)$/u;

function text(values: Readonly<Record<string, unknown>>, column: string): string {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

function textOrNull(values: Readonly<Record<string, unknown>>, column: string): string | null {
  const value = values[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

/** A K-04 seed's reservations row, as the fake holds it (a column left out takes K-04's default). */
export function reservationOfSeed(values: Readonly<Record<string, unknown>>): FakeReservation {
  const during = DURING.exec(text(values, "during"));
  if (during?.[1] === undefined || during[2] === undefined) throw new Error("a seed's during is not a range");
  const state = text(values, "state");
  if (state !== "held" && state !== "waiting" && state !== "booked" && state !== "released") {
    throw new Error("a seed's state is not one of K-04's");
  }
  const releasedWhy = textOrNull(values, "released_why");
  if (
    releasedWhy !== null &&
    releasedWhy !== "expired" &&
    releasedWhy !== "let_go" &&
    releasedWhy !== "cancelled"
  ) {
    throw new Error("a seed's released_why is not one of K-04's");
  }
  const version = values.version;
  if (typeof version !== "number") throw new Error("a seed's version is not a number");
  return {
    id: text(values, "id"),
    businessId: text(values, "business_id"),
    resourceId: text(values, "resource_id"),
    during: { start: during[1], end: during[2] },
    state,
    heldUntil: textOrNull(values, "held_until"),
    forPhoneNumber: textOrNull(values, "for_phone_number"),
    forAgentToken: textOrNull(values, "for_agent_token"),
    bookingId: textOrNull(values, "booking_id"),
    releasedWhy,
    version,
    // K-04 v1 queued_at defaults to now(): a seed row with none was written before any it is compared with.
    queuedAt: textOrNull(values, "queued_at") ?? "2026-01-01T00:00:00Z",
    releasedAt: textOrNull(values, "released_at"),
  };
}

/** K-04 v1's seed-reservation.json, row by row, as the fake holds them. */
export function seededReservations(): FakeReservation[] {
  const seed = contractFile("db-schema/core/fixtures/seed-reservation.json") as SeedRows;
  return seed.rows.filter((row) => row.table === "reservations").map((row) => reservationOfSeed(row.values));
}

/** One K-05 v1 exchange (contracts/data-access/fixtures), freshly parsed. */
function k05Fixture(file: string): unknown {
  return contractFile(`data-access/fixtures/${file}`);
}

/** A K-05 v1 release exchange, freshly parsed. */
export function releaseExchange(file: string): K05.ReleaseExchange {
  return k05Fixture(file) as K05.ReleaseExchange;
}

/** A K-05 v1 commitTurn exchange, freshly parsed. */
export function commitExchange(file: string): K05.CommitTurnExchange {
  return k05Fixture(file) as K05.CommitTurnExchange;
}

/** Tomás next in line for Avery's 10:00am (K-05 reserve-next-in-line.json), as its request and outcome write the row. */
export function tomasWaiting(): FakeReservation {
  const exchange = k05Fixture("reserve-next-in-line.json") as K05.ReserveExchange;
  const { request, outcome } = exchange;
  if (!("result" in outcome) || outcome.result !== "waiting") throw new Error("Tomás waits next in line");
  // K-05 v1's reserve request is typed loosely by the generator (its `for` is one of three shapes).
  const saved: unknown = request.for;
  const phoneNumber =
    typeof saved === "object" && saved !== null ? (saved as { phoneNumber?: unknown }).phoneNumber : null;
  if (typeof phoneNumber !== "string" || typeof request.businessId !== "string") {
    throw new Error("Tomás's time is saved for his mobile at the barbershop");
  }
  return {
    id: outcome.reservationId,
    businessId: request.businessId,
    resourceId: outcome.resourceId,
    during: { ...outcome.during },
    state: "waiting",
    heldUntil: null,
    forPhoneNumber: phoneNumber,
    forAgentToken: null,
    bookingId: null,
    releasedWhy: null,
    version: outcome.version,
    queuedAt: outcome.queuedAt,
    releasedAt: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The people and the times cards

/** Tomás (K-05 v1's reserve-overlap-refused.json and reserve-next-in-line.json: his mobile +15555550105). */
export const TOMAS: Someone = {
  personId: "person-tomas",
  handleId: "handle-tomas",
  address: "+15555550105",
  name: "Tomás",
};

/** Alex as K-04 v1's seeds hold him: his mobile is the one his saved times are for. */
export { ALEX, BARBERSHOP, ZONE };

/** A4-14's card (K-09 commit-limit-5-taken.json): which time works, nothing booked by default. */
export function timesCard(labels: readonly string[], definition: string): StepCard {
  return {
    step: "A4-14",
    card: {
      question: "Which time works?",
      means: labels.map((label) => ({ branch: label, text: definition, from: "meansLine" as const })),
      never: [],
      safeDefault: "nothing is booked.",
      clock: { from: "step9Default" },
    },
  };
}

export interface TimesPick {
  readonly who: Someone;
  readonly role?: "owner" | "staff" | "customer";
  readonly turnId: string;
  readonly traceId: string;
  readonly eventId: string;
  /** The text's words, which decide quotes whole. */
  readonly words: string;
  /** When the text was sent (UTC); the gate's now unless `now` is given. */
  readonly sentAt: string;
  readonly now?: string;
  /** The times card's question, sent to the person's handle. */
  readonly question: string;
  readonly questionSentAt: string;
  /** The times offered, in order; the first is the one picked unless `pick` says otherwise. */
  readonly labels: readonly string[];
  readonly definition: string;
  readonly pick?: string;
  readonly bookingId?: string | null;
  /** The picked choice's stakes reasons (K-02 v1 stakesReason); none by default, as A4-14's times are low. */
  readonly stakesFrom?: Choice["stakesFrom"];
}

/**
 * A turn picking a time from a times card borrowed from A4-14 (as K-09 commit-limit-5-taken.json borrows it: "The gate is
 * the same for every journey"), both reads agreeing: the request under the turn and trace ids given.
 */
export function timesPickRequest(pick: TimesPick): GateRequest {
  const bookingId = pick.bookingId ?? null;
  const target = barbershopTarget(bookingId);
  const choices = pick.labels.map((label, index) =>
    option(
      `c-${String(index + 1).padStart(2, "0")}`,
      pick.question,
      "A4-14",
      label,
      pick.definition,
      target,
      label === (pick.pick ?? pick.labels[0]) ? (pick.stakesFrom ?? []) : [],
    ),
  );
  const picked = choices.find((choice) => choice.label === (pick.pick ?? pick.labels[0]));
  if (picked === undefined) throw new Error("the pick is one of the times offered");
  const request = requestFor({
    who: pick.who,
    role: pick.role ?? "customer",
    question: {
      openQuestionId: pick.question,
      step: "A4-14",
      target,
      sentAt: { utc: pick.questionSentAt, zone: ZONE },
      pollId: null,
      askCount: 1,
    },
    choices,
    card: timesCard(pick.labels, pick.definition),
    texts: [typed(pick.eventId, pick.words, pick.sentAt)],
    choiceId: picked.choiceId,
    quote: pick.words,
    turnId: pick.turnId,
  });
  request.caller.traceId = pick.traceId;
  if (request.turn !== null) request.turn.traceId = pick.traceId;
  request.now = pick.now ?? pick.sentAt;
  return request;
}

// ---------------------------------------------------------------------------------------------------------------
// The commit's other ports, for the gate and commit end to end

/** What a passed booking part writes: its saved times confirmed for its booking, with any state writes and rows read. */
export function bookingWrites(
  choice: Choice | null,
  confirm: readonly ReservationConfirm[],
  state: readonly StateWrite[] = [],
  versionsRead: readonly RowRef[] = [],
): UnitWrites {
  return {
    ...noWrites(whyOfChoice(choice)),
    versionsRead: copy([...versionsRead]),
    state: copy([...state]),
    reservations: { confirm: copy([...confirm]), release: [] },
  };
}

export interface BookingRun {
  /** The turn's request. */
  readonly request: GateRequest;
  /** The booking its passed part books the saved times for. */
  readonly bookingId: string;
  /** The saved times its part books, which the walk names and its writes confirm at their versions read then. */
  readonly savedTimes: readonly string[];
  /** Runs when the part has passed the gate, before its writes are built: the moment a clock or another turn races it. */
  readonly beforeWrites?: () => Promise<void> | void;
}

export interface BookingDeps {
  readonly deps: CommitDeps;
  readonly calls: PortCalls;
  readonly limitCalls: LimitCall[];
  readonly seen: Asked;
}

/**
 * The gate and commit's deps for one booking turn against the fake: limit 5 in its slot over the walk, the fake's rows
 * and the next open times; limits 1 to 4 and 6 passing; the K-05 port the fake; a passed part's writes confirm its saved
 * times for its booking at the versions the fake holds when they are built.
 */
export function bookingDeps(
  fake: ReservationsFake,
  run: BookingRun,
  times: readonly OpenTime[],
): BookingDeps {
  const seen = asked();
  const contextTurnId = decidedIn(run.request).context.turnId;
  const limit = limitIn({ walk: { [contextTurnId]: run.savedTimes }, rows: fake.reader, times }, seen);
  const limitCalls: LimitCall[] = [];
  const base = doublePorts({ k05: fake });
  const ports: CommitPorts = {
    ...base.ports,
    async writesOf(part, turn, open) {
      await run.beforeWrites?.();
      await base.ports.writesOf(part, turn, open);
      const confirm = run.savedTimes.map((id) => {
        const row = fake.rows.get(id);
        if (row === undefined) throw new Error(`the fake holds no reservation ${id}`);
        return { id, expectVersion: row.version, bookingId: run.bookingId };
      });
      return bookingWrites(part.choice, confirm);
    },
  };
  return {
    deps: { limits: registryWith(limit, {}, limitCalls), ports },
    calls: base.calls,
    limitCalls,
    seen,
  };
}

/** A promise and its resolve, for a test to hold two turns at one point until both reach it. */
export function barrier(count: number): () => Promise<void> {
  let waiting = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    waiting += 1;
    if (waiting >= count) open();
    return opened;
  };
}
