// Doubles for the reservations service's tests (T-744). Never imported by the Worker. No database: an in-memory K-05 v1
// item 6 (reserve, release and extend as contracts/data-access/README.md items 8 to 10 say, with DL-173's extend rules),
// with item 8's saved-time clock rows and their firing, loaded from K-04 v1's seed fixtures, and a fake clock.
//
// The double answers each of K-05's item 6 fixtures exactly as the contract does (reservations.test.ts proves it), so
// the service's tests stand on the contract, not on the double's own word. It keeps T-1134's two rules, as K-05 keeps
// them (db/repo/reservations.ts): one row per holder per slot, so a save never waits behind its own holder's saved time,
// and a let-go lets the released holder's own waiting rows go and promotes the first other holder, or nobody. Its calls are atomic between their awaits, as
// the database's locks make reserve, release and extend on one slot or one holder run one after the other; the database
// itself (EXCLUDE, the cap's locks) is proven in reservations.int.test.ts and in db/repo's own integration tests.
//
// Values come only from the contracts' fixtures and the master's sample cast (fictional 555-01xx numbers, example
// tokens), never a real person (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EXTEND_MINUTES,
  STANDARD_HOLD_MINUTES,
  doorMinutes,
  type ExtendOutcome,
  type ExtendRequest,
  type ReleaseOutcome,
  type ReleaseRequest,
  type ReleaseWhy,
  type Reservation,
  type ReservationState,
  type ReserveOutcome,
  type ReserveRequest,
  type SavedFor,
} from "../../../../db/repo/reservation-rules";
import { CONTRACTS_DIR } from "../../tool-api";
import { createReservations } from "./service";
import type { LapseOutcome, ReservationData, Reservations } from "./types";

const MINUTE = 60_000;
const SAVED_TIME_CAP = 2;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const DOORS: ReadonlySet<string> = new Set(["standard", "ownAi", "planCheck", "document", "ownerOk"]);

/** The K-04 v1 seed fixtures the tests load (paths under contracts/db-schema/core/fixtures/). */
export const CORE_FIXTURES = path.join(CONTRACTS_DIR, "db-schema", "core", "fixtures");
/** K-05 v1's fixtures (contracts/data-access/fixtures/). */
export const ACCESS_FIXTURES = path.join(CONTRACTS_DIR, "data-access", "fixtures");

type Values = Readonly<Record<string, unknown>>;

interface SeedRow {
  readonly table: string;
  readonly values: Values;
}

/** The rows of K-04 seed fixtures, each file's `after` chain first and each file once, in load order. */
export function coreSeedRows(files: readonly string[]): SeedRow[] {
  const rows: SeedRow[] = [];
  const loaded = new Set<string>();
  const load = (file: string): void => {
    if (loaded.has(file)) return;
    loaded.add(file);
    const seed = JSON.parse(readFileSync(path.join(CORE_FIXTURES, file), "utf8")) as {
      after?: readonly string[];
      rows?: readonly SeedRow[];
    };
    for (const after of seed.after ?? []) load(after);
    rows.push(...(seed.rows ?? []));
  };
  for (const file of files) load(file);
  return rows;
}

/** One K-05 v1 exchange (a fixture): its seeds, the exchanges before it, its request and its outcome. */
export interface AccessExchange {
  readonly call: "reserve" | "release" | "extend";
  readonly given: { readonly k04Seeds: readonly string[]; readonly after: readonly string[] };
  readonly request: unknown;
  readonly outcome: unknown;
}

export function accessExchange(file: string): AccessExchange {
  return JSON.parse(readFileSync(path.join(ACCESS_FIXTURES, file), "utf8")) as AccessExchange;
}

// ---- the fake clock ------------------------------------------------------------------------------------------------

/** A clock the test moves: the service's `now` (never the platform's). */
export class FakeClock {
  private ms: number;

  constructor(at: string) {
    this.ms = Date.parse(at);
  }

  readonly now = (): number => this.ms;

  set(at: string): void {
    this.ms = Date.parse(at);
  }

  advance(minutes: number): void {
    this.ms += minutes * MINUTE;
  }

  /** Now as K-05 writes it: UTC to the whole second. */
  utc(): string {
    return utcOf(this.ms);
  }
}

function utcOf(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const plusMinutes = (at: string, minutes: number): string => utcOf(Date.parse(at) + minutes * MINUTE);

// ---- the record ----------------------------------------------------------------------------------------------------

interface Resource {
  readonly id: string;
  readonly businessId: string;
  readonly kind: Reservation["resourceKind"];
  readonly personId: string | null;
  readonly active: boolean;
}

type Row = { -readonly [K in keyof Reservation]: Reservation[K] };

/** A saved-time clock row (K-04 v1 clock_rows, kind saved_time; K-05 item 8). */
export interface SavedTimeClockRow {
  readonly id: string;
  readonly reservationId: string;
  readonly businessId: string;
  /** The mobile's handle for a mobile's saved time; null for an agent token's or a booking's: the sweep fires it. */
  readonly handleId: string | null;
  dueAt: string;
  readonly dueZone: string;
  state: "armed" | "fired" | "cancelled";
  version: number;
  readonly fires: { readonly release: string; readonly why: "expired" };
}

function text(values: Values, column: string): string {
  const value = values[column];
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text`);
  return value;
}

function textOrNull(values: Values, column: string): string | null {
  const value = values[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`seed column ${column} is not text or null`);
  return value;
}

function utcOrNull(values: Values, column: string): string | null {
  const value = textOrNull(values, column);
  return value === null ? null : utcOf(Date.parse(value));
}

/** K-04's `[start,end)` as written in the seeds. */
function duringOf(value: string): { start: string; end: string } {
  const match = /^\[([^,]+),([^)]+)\)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("seed during is not [start,end)");
  return { start: utcOf(Date.parse(match[1])), end: utcOf(Date.parse(match[2])) };
}

function rowOf(values: Values): Row {
  const state = text(values, "state") as ReservationState;
  return {
    id: text(values, "id"),
    businessId: text(values, "business_id"),
    resourceId: text(values, "resource_id"),
    resourceKind: text(values, "resource_kind") as Reservation["resourceKind"],
    workerPersonId: textOrNull(values, "worker_person_id"),
    during: duringOf(text(values, "during")),
    state,
    queuedAt: utcOrNull(values, "queued_at") ?? "2026-01-01T00:00:00Z",
    seats: typeof values.seats === "number" ? values.seats : 1,
    heldUntil: utcOrNull(values, "held_until"),
    extended: values.extended === true,
    forPhoneNumber: textOrNull(values, "for_phone_number"),
    forAgentToken: textOrNull(values, "for_agent_token"),
    bookingId: textOrNull(values, "booking_id"),
    releasedAt: utcOrNull(values, "released_at"),
    releasedWhy: textOrNull(values, "released_why") as ReleaseWhy | null,
    version: typeof values.version === "number" ? values.version : 1,
  };
}

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function savedForOf(row: Row): SavedFor {
  if (row.forPhoneNumber !== null) return { phoneNumber: row.forPhoneNumber };
  if (row.forAgentToken !== null) return { agentToken: row.forAgentToken };
  return { bookingId: row.bookingId ?? "" };
}

/**
 * Who holds a saved time, as K-05's cap counts it (T-1134's holderOf): a mobile, the same at every business, or an agent
 * token at one business. A time saved for a booking has no holder, so neither of T-1134's rules applies to it.
 */
type Holder = { readonly phone: string } | { readonly agentToken: string; readonly businessId: string };

function holderOf(who: SavedFor, businessId: string): Holder | null {
  if ("phoneNumber" in who) return { phone: who.phoneNumber };
  if ("agentToken" in who) return { agentToken: who.agentToken, businessId };
  return null;
}

const holderOfRow = (row: Row): Holder | null => holderOf(savedForOf(row), row.businessId);

/** Whether two holders are one: the same mobile, or the same agent token at the same business. No holder is nobody's. */
function sameHolder(a: Holder | null, b: Holder | null): boolean {
  if (a === null || b === null) return false;
  if ("phone" in a) return "phone" in b && a.phone === b.phone;
  return "agentToken" in b && a.agentToken === b.agentToken && a.businessId === b.businessId;
}

function assertUtc(value: unknown, what: string): void {
  if (typeof value !== "string" || !UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${what} must be a UTC time such as 2026-11-07T15:05:00Z`);
  }
}

/** Lets other calls in flight run, as a call waits on the database between its statements. */
const yieldNow = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

// ---- the double ----------------------------------------------------------------------------------------------------

/**
 * K-05 v1 item 6 in memory, every call scoped to its request's business as row-level security scopes it (another
 * business's row is not found), with the saved-time clock rows K-05 items 8 and 9 write.
 */
export class ReservationsDouble {
  private readonly resources = new Map<string, Resource>();
  private readonly zones = new Map<string, string>();
  private readonly handles = new Map<string, string>();
  private readonly rows = new Map<string, Row>();
  private readonly clockRows = new Map<string, SavedTimeClockRow>();

  /** Loads K-04 seed fixtures: businesses, resources, phones and reservations (other tables are not read). */
  constructor(seeds: readonly string[]) {
    for (const { table, values } of coreSeedRows(seeds)) {
      if (table === "businesses") this.zones.set(text(values, "id"), text(values, "time_zone"));
      if (table === "phones") this.handles.set(text(values, "number"), text(values, "handle_id"));
      if (table === "resources") {
        this.resources.set(text(values, "id"), {
          id: text(values, "id"),
          businessId: text(values, "business_id"),
          kind: text(values, "kind") as Resource["kind"],
          personId: textOrNull(values, "person_id"),
          active: values.active !== false,
        });
      }
      if (table === "reservations") {
        const row = rowOf(values);
        this.rows.set(row.id, row);
      }
    }
  }

  /** The K-05 calls as the service reads them: each one scoped to its own business (pg.ts reservationDataOn's shape). */
  readonly data: ReservationData = {
    reserve: (request) => this.reserve(request),
    release: (request) => this.release(request),
    extend: (request) => this.extend(request),
    reservation: async (businessId, reservationId) => {
      await yieldNow();
      const row = this.visible(businessId, reservationId);
      return row === undefined ? null : structuredClone(row);
    },
  };

  /** A reservation as stored, whatever its business (the tests' own look, as the tables' owner). */
  stored(id: string): Reservation | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : structuredClone(row);
  }

  /** Every reservation of a resource whose time overlaps `during`, in id order. */
  onSlot(resourceId: string, during: { start: string; end: string }): Reservation[] {
    return [...this.rows.values()]
      .filter((row) => row.resourceId === resourceId && overlaps(row.during, during))
      .sort((a, b) => byText(a.id, b.id))
      .map((row) => structuredClone(row));
  }

  /** A saved-time clock row, as stored. */
  clockRow(id: string): SavedTimeClockRow | undefined {
    const row = this.clockRows.get(id);
    return row === undefined ? undefined : structuredClone(row);
  }

  /** Armed rows due by `nowMs`, earliest first, a tie by id (K-05 dueClocks). */
  due(nowMs: number): SavedTimeClockRow[] {
    return [...this.clockRows.values()]
      .filter((row) => row.state === "armed" && Date.parse(row.dueAt) <= nowMs)
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || byText(a.id, b.id))
      .map((row) => structuredClone(row));
  }

  /**
   * The commit's confirm of a held time (K-05 commitTurn writes.reservations.confirm): booked, with its booking, and its
   * saved-time clock row cancelled. Not a call the service makes: the booking writer's (C-133), for a test's set-up.
   */
  confirm(id: string, bookingId: string): void {
    const row = this.rows.get(id);
    if (row?.state !== "held") throw new Error("the double confirms only a held time");
    row.state = "booked";
    row.bookingId = bookingId;
    row.version += 1;
    const clock = this.clockRows.get(`${id}/saved-time`);
    if (clock?.state === "armed") {
      clock.state = "cancelled";
      clock.version += 1;
    }
  }

  /** Fires an armed row once, compared and set on its version (K-05 fireClock): a second firing finds it fired. */
  fire(id: string, expectVersion: number): "fired" | "repeated" | "notArmed" | "versionChanged" {
    const row = this.clockRows.get(id);
    if (row === undefined || row.state === "cancelled") return "notArmed";
    if (row.state === "fired") return "repeated";
    if (row.version !== expectVersion) return "versionChanged";
    row.state = "fired";
    row.version += 1;
    return "fired";
  }

  private visible(businessId: string, id: string): Row | undefined {
    const row = this.rows.get(id);
    return row?.businessId === businessId ? row : undefined;
  }

  /** K-05 item 8: a held row's saved-time clock row, armed and due at held_until in the business's zone. */
  private arm(row: Row): void {
    const id = `${row.id}/saved-time`;
    this.clockRows.set(id, {
      id,
      reservationId: row.id,
      businessId: row.businessId,
      handleId: row.forPhoneNumber === null ? null : (this.handles.get(row.forPhoneNumber) ?? null),
      dueAt: row.heldUntil ?? "",
      dueZone: this.zones.get(row.businessId) ?? "UTC",
      state: "armed",
      version: 1,
      fires: { release: row.id, why: "expired" },
    });
  }

  /** The holder's saved times at `at`: held, ending after it (a mobile at every business, a token at one). */
  private savedTimes(who: SavedFor, businessId: string, at: string): Row[] {
    const after = Date.parse(at);
    return [...this.rows.values()]
      .filter((row) => {
        if (row.state !== "held" || row.heldUntil === null || Date.parse(row.heldUntil) <= after)
          return false;
        if ("phoneNumber" in who) return row.forPhoneNumber === who.phoneNumber;
        if ("agentToken" in who) return row.forAgentToken === who.agentToken && row.businessId === businessId;
        return false;
      })
      .sort((a, b) => Date.parse(a.heldUntil ?? "") - Date.parse(b.heldUntil ?? "") || byText(a.id, b.id));
  }

  /** The held or booked rows EXCLUDE would refuse `row` beside: the same resource, or the same worker anywhere. */
  private blocking(candidate: {
    id: string;
    resourceId: string;
    workerPersonId: string | null;
    during: { start: string; end: string };
  }): Row[] {
    return [...this.rows.values()].filter(
      (row) =>
        row.id !== candidate.id &&
        (row.state === "held" || row.state === "booked") &&
        overlaps(row.during, candidate.during) &&
        (row.resourceId === candidate.resourceId ||
          (candidate.workerPersonId !== null && row.workerPersonId === candidate.workerPersonId)),
    );
  }

  private repeatOf(row: Row, request: ReserveRequest): ReserveOutcome {
    const who = savedForOf(row);
    const same =
      row.resourceId === request.resourceId &&
      Date.parse(row.during.start) === Date.parse(request.during.start) &&
      Date.parse(row.during.end) === Date.parse(request.during.end) &&
      row.seats === request.seats &&
      JSON.stringify(who) === JSON.stringify(request.for);
    if (!same || (row.state !== "held" && row.state !== "waiting")) {
      return { error: "idConflict", reservationId: request.reservationId };
    }
    return this.answeredAgain(row);
  }

  /**
   * A held or waiting row's save, answered again with nothing written (repeated): held with its end, or waiting with its
   * place in line, as it stands now. A repeat of the same request answers this way, and so does T-1134's rule (1).
   */
  private answeredAgain(row: Row): ReserveOutcome {
    if (row.state === "held" && row.heldUntil !== null) {
      return {
        result: "held",
        reservationId: row.id,
        version: row.version,
        resourceId: row.resourceId,
        during: { ...row.during },
        heldUntil: row.heldUntil,
        savedTimeClockId: `${row.id}/saved-time`,
        repeated: true,
      };
    }
    return {
      result: "waiting",
      reservationId: row.id,
      version: row.version,
      resourceId: row.resourceId,
      during: { ...row.during },
      queuedAt: row.queuedAt,
      repeated: true,
    };
  }

  /**
   * T-1134 rule (1): the holder's own row on the asked slot, when it already holds or waits on it: its held or waiting row
   * of the same resource whose time overlaps the asked one, a held one first, then the earliest in line, a tie to the
   * lower id (K-05 ownRowOnSlot).
   */
  private ownRowOnSlot(request: ReserveRequest, holder: Holder): Row | undefined {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.resourceId === request.resourceId &&
          (row.state === "held" || row.state === "waiting") &&
          overlaps(row.during, request.during) &&
          sameHolder(holderOfRow(row), holder),
      )
      .sort(
        (a, b) =>
          Number(b.state === "held") - Number(a.state === "held") ||
          Date.parse(a.queuedAt) - Date.parse(b.queuedAt) ||
          byText(a.id, b.id),
      )[0];
  }

  private async reserve(request: ReserveRequest): Promise<ReserveOutcome> {
    const minutes = doorMinutes(request.door, request.holdMinutes);
    assertUtc(request.at, "at");
    assertUtc(request.during.start, "during.start");
    assertUtc(request.during.end, "during.end");
    if (!Number.isInteger(request.seats) || request.seats < 1)
      throw new TypeError("seats is a positive integer");
    await yieldNow();

    const known = this.rows.get(request.reservationId);
    if (known !== undefined) {
      return known.businessId === request.businessId
        ? this.repeatOf(known, request)
        : { error: "idConflict", reservationId: request.reservationId };
    }
    const resource = this.resources.get(request.resourceId);
    if (resource?.businessId !== request.businessId || !resource.active) {
      return { error: "notBookable", resourceId: request.resourceId };
    }
    if (resource.kind === "class_session") throw new Error("the reservations double keeps no class seats");

    // T-1134 rule (1), read before the cap: a holder that already holds or waits on this slot, asking to wait if it is
    // saved, gets its own row back as its first save got it, and nothing is written.
    const holder = holderOf(request.for, request.businessId);
    if (request.waitIfSaved && holder !== null) {
      const own = this.ownRowOnSlot(request, holder);
      if (own !== undefined) return this.answeredAgain(own);
    }
    const saved = this.savedTimes(request.for, request.businessId, request.at);
    if (saved.length >= SAVED_TIME_CAP) {
      return {
        error: "savedTimeCap",
        saved: saved
          .slice(0, SAVED_TIME_CAP)
          .map((row) => ({ reservationId: row.id, heldUntil: row.heldUntil ?? "" })),
      };
    }
    const who: SavedFor = request.for;
    const row: Row = {
      id: request.reservationId,
      businessId: request.businessId,
      resourceId: resource.id,
      resourceKind: resource.kind,
      workerPersonId: resource.personId,
      during: { start: utcOf(Date.parse(request.during.start)), end: utcOf(Date.parse(request.during.end)) },
      state: "held",
      queuedAt: request.at,
      seats: request.seats,
      heldUntil: plusMinutes(request.at, minutes),
      extended: false,
      forPhoneNumber: "phoneNumber" in who ? who.phoneNumber : null,
      forAgentToken: "agentToken" in who ? who.agentToken : null,
      bookingId: "bookingId" in who ? who.bookingId : null,
      releasedAt: null,
      releasedWhy: null,
      version: 1,
    };
    const blocking = this.blocking(row);
    if (blocking.length === 0) {
      this.rows.set(row.id, row);
      this.arm(row);
      return {
        result: "held",
        reservationId: row.id,
        version: 1,
        resourceId: row.resourceId,
        during: { ...row.during },
        heldUntil: row.heldUntil ?? "",
        savedTimeClockId: `${row.id}/saved-time`,
        repeated: false,
      };
    }
    if (!request.waitIfSaved || blocking.some((other) => other.state === "booked")) {
      return { error: "overlap", resourceId: request.resourceId };
    }
    // Someone has saved the time: wait next in line, the place in line `at` (A4-18).
    const waiting: Row = { ...row, state: "waiting", heldUntil: null };
    this.rows.set(waiting.id, waiting);
    return {
      result: "waiting",
      reservationId: waiting.id,
      version: 1,
      resourceId: waiting.resourceId,
      during: { ...waiting.during },
      queuedAt: waiting.queuedAt,
      repeated: false,
    };
  }

  private async release(request: ReleaseRequest): Promise<ReleaseOutcome> {
    assertUtc(request.at, "at");
    if (request.expectVersion === null && request.why !== "expired") {
      throw new TypeError(`a ${request.why} release needs the version read`);
    }
    await yieldNow();
    const row = this.visible(request.businessId, request.reservationId);
    if (row === undefined) return { error: "notFound", table: "reservations", rowId: request.reservationId };
    if (row.state === "released" && row.releasedAt !== null && row.releasedWhy !== null) {
      return {
        result: "released",
        reservationId: row.id,
        version: row.version,
        releasedAt: row.releasedAt,
        why: row.releasedWhy,
        promoted: null,
        skipped: [],
        repeated: true,
      };
    }
    if (request.why === "expired") {
      if (row.state !== "held" || row.heldUntil === null)
        throw new Error("an expired release needs a held row");
      if (Date.parse(row.heldUntil) > Date.parse(request.at)) {
        return { error: "notExpired", reservationId: row.id, heldUntil: row.heldUntil };
      }
    }
    if (request.expectVersion !== null && request.expectVersion !== row.version) {
      return {
        error: "versionChanged",
        changed: [
          {
            table: "reservations",
            rowId: row.id,
            readVersion: request.expectVersion,
            currentVersion: row.version,
          },
        ],
      };
    }
    const tookTime = row.state === "held" || row.state === "booked";
    row.state = "released";
    row.releasedAt = request.at;
    row.releasedWhy = request.why;
    row.version += 1;
    const own = this.clockRows.get(`${row.id}/saved-time`);
    if (own?.state === "armed") {
      own.state = "cancelled";
      own.version += 1;
    }

    let promoted: Extract<ReleaseOutcome, { result: "released" }>["promoted"] = null;
    const skipped: { reservationId: string; reason: "overlap" | "savedTimeCap" }[] = [];
    if (tookTime) {
      const line = [...this.rows.values()]
        .filter(
          (other) =>
            other.state === "waiting" &&
            other.resourceId === row.resourceId &&
            overlaps(other.during, row.during),
        )
        .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt) || byText(a.id, b.id));
      // T-1134 rule (2): the released holder's own waiting rows, wherever they stand in the line, are let go with it and
      // never promoted; the first other holder is promoted, or nobody.
      const releasedHolder = holderOfRow(row);
      const own = line.filter((waiting) => sameHolder(holderOfRow(waiting), releasedHolder));
      for (const waiting of own) {
        waiting.state = "released";
        waiting.releasedAt = request.at;
        waiting.releasedWhy = "let_go";
        waiting.version += 1;
      }
      for (const waiting of line.filter((other) => !own.includes(other))) {
        if (this.savedTimes(savedForOf(waiting), waiting.businessId, request.at).length >= SAVED_TIME_CAP) {
          skipped.push({ reservationId: waiting.id, reason: "savedTimeCap" });
          continue;
        }
        if (this.blocking(waiting).length > 0) {
          skipped.push({ reservationId: waiting.id, reason: "overlap" });
          continue;
        }
        waiting.state = "held";
        waiting.heldUntil = plusMinutes(request.at, STANDARD_HOLD_MINUTES);
        waiting.version += 1;
        this.arm(waiting);
        promoted = {
          reservationId: waiting.id,
          version: waiting.version,
          heldUntil: waiting.heldUntil,
          forPhoneNumber: waiting.forPhoneNumber,
          forAgentToken: waiting.forAgentToken,
          bookingId: waiting.bookingId,
          savedTimeClockId: `${waiting.id}/saved-time`,
        };
        break;
      }
    }
    return {
      result: "released",
      reservationId: row.id,
      version: row.version,
      releasedAt: request.at,
      why: request.why,
      promoted,
      skipped,
      repeated: false,
    };
  }

  private async extend(request: ExtendRequest): Promise<ExtendOutcome> {
    if (!DOORS.has(request.door)) throw new TypeError("extend: door is one of the five");
    if (!Number.isSafeInteger(request.expectVersion) || request.expectVersion < 1) {
      throw new TypeError("extend: expectVersion is a positive integer");
    }
    assertUtc(request.at, "at");
    await yieldNow();
    const row = this.visible(request.businessId, request.reservationId);
    if (row === undefined) return { error: "notFound", table: "reservations", rowId: request.reservationId };
    if (
      row.state !== "held" ||
      row.heldUntil === null ||
      Date.parse(row.heldUntil) <= Date.parse(request.at)
    ) {
      return { error: "notHeld", reservationId: row.id, state: row.state };
    }
    if (request.door === "ownAi" || row.forAgentToken !== null) {
      return { error: "neverExtended", reservationId: row.id, door: "ownAi" };
    }
    if (row.extended) return { error: "alreadyExtended", reservationId: row.id, heldUntil: row.heldUntil };
    if (row.version !== request.expectVersion) {
      return {
        error: "versionChanged",
        changed: [
          {
            table: "reservations",
            rowId: row.id,
            readVersion: request.expectVersion,
            currentVersion: row.version,
          },
        ],
      };
    }
    const others = this.savedTimes(savedForOf(row), row.businessId, request.at).filter(
      (other) => other.id !== row.id,
    );
    if (others.length >= SAVED_TIME_CAP) return { error: "notHeld", reservationId: row.id, state: row.state };
    row.heldUntil = plusMinutes(row.heldUntil, EXTEND_MINUTES);
    row.extended = true;
    row.version += 1;
    const clock = this.clockRows.get(`${row.id}/saved-time`);
    if (clock?.state === "armed") {
      clock.dueAt = row.heldUntil;
      clock.version += 1;
    }
    return { result: "extended", reservationId: row.id, version: row.version, heldUntil: row.heldUntil };
  }
}

// ---- the service on the double, and the firing ------------------------------------------------------------------

/** The service on a fresh double of `seeds` and a fake clock at `at`. */
export function serviceOn(
  seeds: readonly string[],
  at: string,
): { double: ReservationsDouble; clock: FakeClock; service: Reservations } {
  const double = new ReservationsDouble(seeds);
  const clock = new FakeClock(at);
  return { double, clock, service: createReservations({ data: double.data, now: clock.now }) };
}

/**
 * What the handle actor's alarm and the minute sweep do at the clock's now (runtime/src/clocks; K-05 fireClock): each
 * saved-time clock row due fires once, compared and set on its version, and its firing lets its time go (the service's
 * lapse). Returns each firing's lapse, in due order.
 */
export async function fireDue(
  double: ReservationsDouble,
  clock: FakeClock,
  service: Reservations,
): Promise<LapseOutcome[]> {
  const lapses: LapseOutcome[] = [];
  for (const row of double.due(clock.now())) {
    if (double.fire(row.id, row.version) !== "fired") continue;
    lapses.push(await service.lapse({ reservationId: row.fires.release, businessId: row.businessId }));
  }
  return lapses;
}
