// setRecordFlag (T-317; C-078; K-09 v1 setRecordFlag; arch 03 lines 175 to 177; A3-48, A3-50, A7-81; S11-62): set and
// clear the record flags private and deceased on a booking head, and paused on a person, a phone or an address (K-04 v1
// bookings, pauses). The stopped flag is recordStopOrStart's alone (stop-start.ts).
//
//   - Setting one is a change that only protects, so it takes anyone's word (limit 1; S13-57) and always lands on the row
//     as it is now; a flag already set answers `repeated` and writes nothing.
//   - Clearing: the person served clears private, the owner clears deceased and paused (arch 03 line 177); anyone else is
//     notAllowed (notDecider). A clear compares the row's version (limit 4): another version answers versionChanged.
//   - A pause arms one call-off clock per booked visit it covers, due 7pm the day before the visit in its zone, or 2 hours
//     before a same-day visit, or at once when both have passed (S11-62: "Still paused at 7pm the day before, or 2 hours
//     before a same-day visit, the visit is called off with no fee and prepaid visits refunded").
//
// What it writes is one compare-and-set state write per row and its event-log entry, never a number or an address in
// plain: a pause's phone number stays in the row, out of the entry; an address pause needs the sealer (K-04 rule 6).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. A set ignores the version it names: a protecting change always lands, on the version the row has now, which the
//      commit compares (limit 4), so a set made from an old read is never refused.
//   2. Each event-log entry's step is the master step that sets the flag: A3-50 (private), A3-48 (paused), A7-81
//      (deceased); the person who made the call is the actor, with their role at the business, or Rosie for a job.
//   3. A clear on a person or a phone clears the open pause on it at this business; with none, notFound (no row to name).
//   4. The owner is a person with a live owner role at the call's business; an admin does not clear (arch 03 line 177).
//   5. A pause's call-off clock is a step clock owned by the minute sweep (handle null: arch 10 line 540), naming S11-62's
//      call-off, the pause and the booking; its firing acts only while the pause still holds, so clearing a pause leaves
//      its clocks to their firing.
//   6. An address pause is not built until the sealer is given (K-04 pauses.address is sealed; the address is never
//      written in plain): the call answers notBuilt and writes nothing.
//   7. With no read of a visit's time (K-05 open gaps 25 and 27), a pause arms no call-off clock (NO_VISIT_TIMES).

import { DAY_BEFORE_HOUR, SAME_DAY_LEAD_MS } from "../../../../runtime/src/clocks/due";
import { instantAtLocal, isZone, localDateOf } from "../../../../runtime/src/clocks/zone";
import { NotBuiltError, type ErrorsOf, type RequestOf, type ResponseOf } from "../../tool-api";
import { FlagRefusedError } from "./errors";
import type { FlagIds } from "./ids";
import type { CoveredVisit, FlagsReader, Pause, PauseTargetRef, VisitsCovered } from "./reads";
import { eventEntry, noWrites, type DueClock, type EntryActor, type FlagWrites } from "./writes";

export type RecordFlagRequest = RequestOf<"setRecordFlag">;
export type RecordFlagResponse = ResponseOf<"setRecordFlag">;
export type RecordFlagError = ErrorsOf<"setRecordFlag">;
export type RecordFlagAnswer = RecordFlagResponse | RecordFlagError;

/** The master step that sets each flag (default 2; arch 03 line 175). */
export const FLAG_STEPS: Readonly<Record<RecordFlagRequest["flag"], string>> = {
  private: "A3-50",
  paused: "A3-48",
  deceased: "A7-81",
};

/** The step a call-off clock fires (S11-62). */
export const CALL_OFF_STEP = "S11-62";

/** Seals an address under one person's key (K-04 pauses.address; db/repo/sealing.ts), as base64 bytes: never kept in plain. */
export interface AddressSealer {
  seal(address: string, forPersonId: string): Promise<string>;
}

export interface RecordFlagCall {
  readonly request: RecordFlagRequest;
  /** The call's now, UTC ending in Z. */
  readonly now: string;
}

export interface RecordFlagPorts {
  /** K-04 reads on the call's transaction, under its business scope. */
  readonly reader: FlagsReader;
  readonly ids: FlagIds;
  /** The booked visits a pause covers. Default NO_VISIT_TIMES (default 7). */
  readonly visits: VisitsCovered;
  /** Seals an address pause's address. None: an address pause is not built (default 6). */
  readonly sealer?: AddressSealer | null;
}

export interface RecordFlagPlan {
  /** The key a repeat is known by: the turn, else the caller's request. */
  readonly key: string;
  readonly answer: RecordFlagAnswer;
  readonly writes: FlagWrites;
}

/**
 * When a pause's call-off clock is due for one visit (S11-62): 7pm the day before the visit in its zone; once that has
 * passed, 2 hours before the visit; once that has passed too, at once (`now`). UTC to the whole second.
 */
export function callOffDueAt(visit: CoveredVisit, now: string): string {
  if (!isZone(visit.zone)) throw new TypeError("a visit's zone must be an IANA zone");
  const starts = Date.parse(visit.startsAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(starts) || !Number.isFinite(nowMs)) throw new TypeError("times must be instants");
  const dayBefore = instantAtLocal(visit.zone, localDateOf(starts, visit.zone), -1, DAY_BEFORE_HOUR);
  const sameDay = starts - SAME_DAY_LEAD_MS;
  const due = dayBefore > nowMs ? dayBefore : sameDay > nowMs ? sameDay : nowMs;
  return new Date(Math.floor(due / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

type Target = RecordFlagRequest["target"];

const isBooking = (target: Target): target is { bookingId: string } => "bookingId" in target;
const isPerson = (target: Target): target is { personId: string } => "personId" in target;
const isPhone = (target: Target): target is { phoneNumber: string } => "phoneNumber" in target;
const isPauseRow = (target: Target): target is { pauseId: string } => "pauseId" in target;
const isAddress = (target: Target): target is { address: string; sealedForPersonId: string } =>
  "address" in target;

/** Plans one setRecordFlag call: what it answers and what its commit writes. Reads only. */
export async function planRecordFlag(call: RecordFlagCall, ports: RecordFlagPorts): Promise<RecordFlagPlan> {
  const { request, now } = call;
  const { caller, flag, action, target, expectVersion } = request;
  const { reader } = ports;
  const businessId = caller.businessId;
  if (businessId === null) throw new FlagRefusedError("noBusiness");
  const key = caller.turnId ?? caller.requestId;
  const step = FLAG_STEPS[flag];
  const why = { step, choice: null };
  const answerOnly = (answer: RecordFlagAnswer): RecordFlagPlan => ({ key, answer, writes: noWrites(step) });

  // Who acts: the caller's person with their live role here (default 2), or Rosie for a call that acts for no one.
  const roles = caller.personId === null ? [] : await reader.liveRoles(caller.personId);
  const roleHere =
    roles.find((role) => role.businessId === businessId && role.endedAt === null)?.role ?? null;
  const actor: EntryActor | null =
    caller.personId === null ? null : { personId: caller.personId, role: roleHere };
  const isOwner = roles.some(
    (role) => role.businessId === businessId && role.role === "owner" && role.endedAt === null,
  );
  const notDecider = (): RecordFlagPlan => answerOnly({ error: "notAllowed", why: "notDecider" });
  const versionChanged = (table: string, rowId: string, read: number, current: number): RecordFlagPlan =>
    answerOnly({
      error: "versionChanged",
      changed: [{ table, rowId, readVersion: read, currentVersion: current }],
    });

  // ---- private and deceased: the booking head ---------------------------------------------------------------------
  if (flag === "private" || flag === "deceased") {
    if (!isBooking(target)) throw new FlagRefusedError("targetNotOfFlag");
    const head = await reader.bookingHead(target.bookingId);
    if (head?.businessId !== businessId) {
      return answerOnly({ error: "notFound", table: "bookings", rowId: target.bookingId });
    }
    const wanted = action === "set";
    if (!wanted) {
      const decider =
        flag === "private"
          ? head.servedPersonId !== null && caller.personId === head.servedPersonId
          : isOwner;
      if (!decider) return notDecider();
    }
    if (head[flag] === wanted) {
      return answerOnly({ rowId: head.id, version: head.version, callOffClockRowIds: [], repeated: true });
    }
    if (!wanted) {
      if (expectVersion === null) throw new FlagRefusedError("versionNotRead");
      if (expectVersion !== head.version)
        return versionChanged("bookings", head.id, expectVersion, head.version);
    }
    const set = { [flag]: wanted };
    return {
      key,
      answer: { rowId: head.id, version: head.version + 1, callOffClockRowIds: [], repeated: false },
      writes: {
        ...noWrites(step),
        versionsRead: [{ table: "bookings", rowId: head.id, version: head.version }],
        state: [{ op: "update", table: "bookings", key: { id: head.id }, expectVersion: head.version, set }],
        stateEvents: [
          eventEntry({
            id: `log-${head.id}-${flag}-${wanted ? "set" : "cleared"}-v${String(head.version + 1)}`,
            kind: "booking.flagged",
            zone: null,
            businessId,
            actor,
            table: "bookings",
            rowId: head.id,
            old: { [flag]: head[flag] },
            new: set,
            why,
          }),
        ],
      },
    };
  }

  // ---- paused: a pause row on a person, a phone or an address ------------------------------------------------------
  const openHere = (pauses: readonly Pause[], kind: Pause["target"]): Pause | undefined =>
    pauses.find(
      (pause) => pause.businessId === businessId && pause.target === kind && pause.clearedAt === null,
    );

  if (action === "clear") {
    if (!isOwner) return notDecider();
    let pause: Pause | null | undefined;
    if (isPauseRow(target)) pause = await reader.pause(target.pauseId);
    else if (isPerson(target)) pause = openHere(await reader.openPausesOfPerson(target.personId), "person");
    else if (isPhone(target)) pause = openHere(await reader.openPausesOfPhone(target.phoneNumber), "phone");
    else throw new FlagRefusedError("targetNotOfFlag");
    if (pause?.businessId !== businessId) {
      // The row a clear names, by id: the pause, the person, or the phone's handle (never its number).
      const rowId = isPauseRow(target)
        ? target.pauseId
        : isPerson(target)
          ? target.personId
          : ((await reader.handleOfAddress(target.phoneNumber))?.id ?? "phone");
      return answerOnly({ error: "notFound", table: "pauses", rowId });
    }
    if (pause.clearedAt !== null) {
      return answerOnly({ rowId: pause.id, version: pause.version, callOffClockRowIds: [], repeated: true });
    }
    if (expectVersion === null) throw new FlagRefusedError("versionNotRead");
    if (expectVersion !== pause.version)
      return versionChanged("pauses", pause.id, expectVersion, pause.version);
    const set = { cleared_at: now, cleared_by_person_id: caller.personId };
    return {
      key,
      answer: { rowId: pause.id, version: pause.version + 1, callOffClockRowIds: [], repeated: false },
      writes: {
        ...noWrites(step),
        versionsRead: [{ table: "pauses", rowId: pause.id, version: pause.version }],
        state: [{ op: "update", table: "pauses", key: { id: pause.id }, expectVersion: pause.version, set }],
        stateEvents: [
          eventEntry({
            id: `log-${pause.id}-cleared`,
            kind: "pause.cleared",
            zone: null,
            businessId,
            actor,
            table: "pauses",
            rowId: pause.id,
            old: { cleared_at: null },
            new: set,
            why,
          }),
        ],
      },
    };
  }

  // A set: the target's own columns (K-04 pauses_one_target), and what finds the visits it covers.
  let columns: Record<string, unknown>;
  let covered: PauseTargetRef | null;
  let existing: Pause | undefined;
  if (isPerson(target)) {
    if (!(await reader.personExists(target.personId))) {
      return answerOnly({ error: "notFound", table: "persons", rowId: target.personId });
    }
    existing = openHere(await reader.openPausesOfPerson(target.personId), "person");
    columns = { target: "person", person_id: target.personId };
    covered = { personId: target.personId };
  } else if (isPhone(target)) {
    const handle = await reader.handleOfAddress(target.phoneNumber);
    if (handle?.kind !== "phone") throw new FlagRefusedError("noSuchPhone");
    if ((await reader.phone(target.phoneNumber))?.handleId !== handle.id) {
      return answerOnly({ error: "notFound", table: "phones", rowId: handle.id });
    }
    existing = openHere(await reader.openPausesOfPhone(target.phoneNumber), "phone");
    columns = { target: "phone", phone_number: target.phoneNumber };
    covered = { phoneNumber: target.phoneNumber };
  } else if (isAddress(target)) {
    const sealer = ports.sealer ?? null;
    if (sealer === null) throw new NotBuiltError("setRecordFlag");
    columns = {
      target: "address",
      address: await sealer.seal(target.address, target.sealedForPersonId),
      sealed_for_person_id: target.sealedForPersonId,
    };
    // Address pauses stay unread (K-05 v1.2 open gap 17): no visit is found by an address.
    covered = null;
  } else {
    throw new FlagRefusedError("targetNotOfFlag");
  }
  if (existing !== undefined) {
    return answerOnly({
      rowId: existing.id,
      version: existing.version,
      callOffClockRowIds: [],
      repeated: true,
    });
  }

  const pauseId = await ports.ids.rowId("pause", key, JSON.stringify(columns));
  const visits = covered === null ? [] : await ports.visits.visitsOf(businessId, covered);
  const clocks: DueClock[] = [];
  for (const visit of [...visits].sort((a, b) => (a.bookingId < b.bookingId ? -1 : 1))) {
    clocks.push({
      id: await ports.ids.rowId("callOff", key, `${pauseId}/${visit.bookingId}`),
      kind: "step",
      openQuestionId: null,
      reservationId: null,
      handleId: null,
      businessId,
      bookingId: visit.bookingId,
      fires: { step: CALL_OFF_STEP, branch: "callOff", pause_id: pauseId, no_fee: true },
      due: { dueAt: callOffDueAt(visit, now), dueZone: visit.zone },
    });
  }
  const values = {
    id: pauseId,
    business_id: businessId,
    ...columns,
    set_by_turn_id: caller.kind === "turn" ? caller.turnId : null,
    set_at: now,
  };
  // The entry names what the pause is on and when, never the number or the address (K-08 v1 plainValue).
  const logged: Record<string, unknown> = { target: columns.target, business_id: businessId, set_at: now };
  if (isPerson(target)) logged.person_id = target.personId;
  if (isAddress(target)) logged.sealed_for_person_id = target.sealedForPersonId;
  return {
    key,
    answer: {
      rowId: pauseId,
      version: 1,
      callOffClockRowIds: clocks.map((clock) => clock.id),
      repeated: false,
    },
    writes: {
      ...noWrites(step),
      state: [{ op: "insert", table: "pauses", values }],
      stateEvents: [
        eventEntry({
          id: `log-${pauseId}-set`,
          kind: "pause.set",
          zone: null,
          businessId,
          actor,
          table: "pauses",
          rowId: pauseId,
          old: null,
          new: logged,
          why,
        }),
      ],
      clocks,
    },
  };
}
