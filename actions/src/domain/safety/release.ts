// releaseSafetyHold (T-318; C-104; K-09 v1; K-34 v1 safety_holds; arch 06 lines 319 to 327; A3-24, A3-25, A3-48, A3-50;
// S13-10): a hold is released only by its rule, and only once:
//
//   - at once, after the outcome's message (outcome_message_sent);
//   - once the booking is made private (booking_private: A3-50), read from the booking head as it is now;
//   - after a clear "we're safe" (safe_readback: A3-24 "we're safe, it's handled", A3-25 "I'm safe right now"): the safety
//     read of a later text from the held handle's own chat (K-09 default 31), which holds no danger (rules.ts isClearSafe;
//     S13-10: "A fire, gas or a threat that could start again still gets the message");
//   - never, for a threat (A3-48): nothing books, and new requests wait for the owner.
//
// The release writes only the hold's release, compared on its version (limit 4). Nothing it held is committed by it: the
// held turn is named (`redecideTurnId`), and its routine actions are decided again from today's record, with the booking's
// own fresh read-back and exact yes (limit 3). A released hold is never un-released (CQ-80): a repeat answers the first
// release and writes nothing.
//
// Defaults used (for ops/QUESTIONS.md):
//  11. The rule that binds is the strictest of the stored rule and any open hold of the same id the call is handed (the
//      handle actor's, which can be stricter: STATE note 21). A reason must fit it; when the actor's rule is stricter than
//      K-34's, no reason can be written that fits both (K-34 safety_holds_why_fits_rule binds the stored rule), so the hold
//      stays and the call answers wrongRule with the binding rule.
//  12. Only safe_readback names an outcome: a releasedByOutcomeId given with another reason does not fit (wrongRule).
//  13. A "we're safe" must be read after the hold was set: an older text's read is not a release of a later hold, and
//      answers stillDanger (the hold stays and the message goes again). The text may be one this same turn records: the
//      turn's own recordSafetyOutcome action names it by the id the record will write.
//  14. A booking_private release reads the booking head as it is, or the turn's own setRecordFlag private for it; a booking
//      not yet private is refused (bookingNotPrivate), since K-09 v1 lists no answer for it.
//  15. released_at is the call's now, never before held_at (K-34 safety_holds_released_after_held).

import type { RowRef, SafetyHold } from "../../commit";
import type { ErrorsOf, RequestOf, ResponseOf } from "../../tool-api";
import { eventEntry, noWrites, type FlagsReader, type FlagWrites } from "../flags";
import { SafetyRefusedError } from "./errors";
import type { SafetyIds } from "./ids";
import type { SafetyReader, StoredOutcome } from "./ports";
import { carriedByTurn, type CarryingTurn } from "./record";
import { WHY_OF_RULE, isClearSafe, labelsOf, strictestOf } from "./rules";

export type ReleaseRequest = RequestOf<"releaseSafetyHold">;
export type ReleaseResponse = ResponseOf<"releaseSafetyHold">;
export type ReleaseError = ErrorsOf<"releaseSafetyHold">;
export type ReleaseAnswer = ReleaseResponse | ReleaseError;

/** The step a release's entry names: the danger check whose hold it releases (record.ts default 9). */
export const RELEASE_STEP = "A3-22";

export interface ReleaseCall {
  readonly request: ReleaseRequest;
  /** The turn whose commit carries it, or null for a call made alone. */
  readonly turn: CarryingTurn | null;
  /** The business the call runs under (its scope), or null on the runtime side. */
  readonly businessId: string | null;
  /** The call's now, UTC ending in Z. */
  readonly now: string;
  /** The holds open in force on the handle: an open hold of the same id carries the handle actor's rule (default 11). */
  readonly open: readonly SafetyHold[];
}

export interface ReleasePorts {
  readonly reader: SafetyReader;
  /** T-317's reads: the booking head, for booking_private. */
  readonly flagsReader: FlagsReader;
  /** The record's ids, to find an outcome this same turn records (default 13). */
  readonly ids: SafetyIds;
}

export interface ReleasePlan {
  /** The key a repeat is known by: the turn, else the caller's request. */
  readonly key: string;
  readonly answer: ReleaseAnswer;
  readonly writes: FlagWrites;
}

/** The later of two UTC instants. */
const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

/** The outcome a "we're safe" names: one this turn records (by the record's own id), else the stored row (default 13). */
async function outcomeNamed(
  call: ReleaseCall,
  ports: ReleasePorts,
  outcomeId: string,
): Promise<StoredOutcome | null> {
  const { turn } = call;
  for (const action of turn?.core ?? []) {
    if (action.call !== "recordSafetyOutcome") continue;
    const { request } = action;
    if ((await ports.ids.rowId("outcome", request.safety.eventId)) !== outcomeId) continue;
    const { safety } = request;
    const { labels, tenses } = labelsOf(safety);
    return {
      id: outcomeId,
      eventId: safety.eventId,
      source: safety.source,
      handleId: request.handleId,
      personId: request.caller.personId,
      businessId: call.businessId,
      bookingId: request.bookingId,
      turnId: safety.source === "text" && turn !== null ? turn.id : null,
      readAt: call.now,
      timedOut: safety.timedOut,
      labels,
      tenses,
      dangerWordKinds: safety.dangerWords.map((match) => match.kind),
      outcomes: [...safety.outcomes],
      liftedToUnsure: safety.liftedToUnsure,
    };
  }
  return ports.reader.outcome(outcomeId);
}

/** Plans one releaseSafetyHold call: what it answers and what its commit writes. Reads only. */
export async function planReleaseSafetyHold(call: ReleaseCall, ports: ReleasePorts): Promise<ReleasePlan> {
  const { request, businessId, now } = call;
  const { caller, holdId, expectVersion, why, releasedByOutcomeId } = request;
  if (businessId !== null && caller.businessId !== null && caller.businessId !== businessId) {
    throw new SafetyRefusedError("otherBusiness");
  }
  const key = caller.turnId ?? caller.requestId;
  const nothing = (answer: ReleaseAnswer): ReleasePlan => ({ key, answer, writes: noWrites(RELEASE_STEP) });

  const hold = await ports.reader.hold(holdId);
  if (hold === null || (businessId !== null && hold.businessId !== businessId)) {
    return nothing({ error: "notFound", table: "safety_holds", rowId: holdId });
  }
  // Released once, never un-released (CQ-80): a repeat answers the first release.
  if (hold.releasedAt !== null) {
    return nothing({ holdId, releasedAt: hold.releasedAt, redecideTurnId: hold.turnId, repeated: true });
  }

  const actors = call.open.filter((open) => open.holdId === holdId).map((open) => open.releaseRule);
  const binding = strictestOf([hold.releaseRule, ...actors]) ?? hold.releaseRule;
  if (binding === "never") return nothing({ error: "neverReleased", holdId });
  const fits = WHY_OF_RULE[binding] === why && binding === hold.releaseRule;
  if (!fits || (why !== "safe_readback" && releasedByOutcomeId !== null)) {
    return nothing({ error: "wrongRule", releaseRule: binding });
  }
  if (expectVersion !== hold.version) {
    return nothing({
      error: "versionChanged",
      changed: [
        { table: "safety_holds", rowId: holdId, readVersion: expectVersion, currentVersion: hold.version },
      ],
    });
  }

  let releasedByTurnId: string | null = caller.turnId;
  if (why === "booking_private") {
    const bookingId = hold.bookingId;
    if (bookingId === null) throw new SafetyRefusedError("bookingNotPrivate", [holdId]);
    const head = await ports.flagsReader.bookingHead(bookingId);
    const privateNow =
      head?.private === true || carriedByTurn(call.turn, "private", { bookingId: bookingId });
    if (!privateNow) throw new SafetyRefusedError("bookingNotPrivate", [holdId]);
  } else if (why === "safe_readback") {
    if (releasedByOutcomeId === null) return nothing({ error: "wrongRule", releaseRule: binding });
    const safe = await outcomeNamed(call, ports, releasedByOutcomeId);
    if (safe === null)
      return nothing({ error: "notFound", table: "safety_outcomes", rowId: releasedByOutcomeId });
    // A text from the held handle's own chat, in a turn (K-09 default 31; K-34 safety_holds_safe_release_has_read).
    if (safe.source !== "text" || safe.handleId !== hold.handleId || safe.turnId === null) {
      return nothing({ error: "notAllowed", why: "notDecider" });
    }
    const fresh = safe.id !== hold.safetyOutcomeId && Date.parse(safe.readAt) >= Date.parse(hold.heldAt);
    if (!fresh || !isClearSafe(safe)) return nothing({ error: "stillDanger", outcomeId: safe.id });
    releasedByTurnId = safe.turnId;
  }

  const releasedAt = later(now, hold.heldAt);
  const set = {
    released_at: releasedAt,
    released_why: why,
    released_by_turn_id: releasedByTurnId,
    released_by_outcome_id: why === "safe_readback" ? releasedByOutcomeId : null,
  };
  const read: RowRef = { table: "safety_holds", rowId: holdId, version: hold.version };
  const writes: FlagWrites = {
    ...noWrites(RELEASE_STEP),
    versionsRead: [read],
    state: [{ op: "update", table: "safety_holds", key: { id: holdId }, expectVersion: hold.version, set }],
    stateEvents: [
      eventEntry({
        id: `log-${holdId}-released`,
        kind: "safety_hold.released",
        zone: null,
        businessId: hold.businessId,
        actor: null,
        table: "safety_holds",
        rowId: holdId,
        old: { released_at: null },
        new: set,
        why: { step: RELEASE_STEP, choice: null },
      }),
    ],
  };
  return {
    key,
    answer: { holdId, releasedAt, redecideTurnId: hold.turnId, repeated: false },
    writes,
  };
}
