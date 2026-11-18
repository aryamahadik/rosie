// handOff and answerHandOff (T-319; C-104; K-09 v1; K-36 v1 hand_offs; arch 06 line 329; S11-19; S13-29 rules 53 to
// 57): a matter handed to the business's owner, then to Rosie's team if nobody answers in time, and the owner's answer,
// which cancels the escalation.
//
//   - Who is told (arch 06 line 329): crisis words, the owner and Rosie's team at once (escalate_at is handed_at, no
//     clock row, the team's page opened in the same commit: hand_offs_crisis_words_at_once, hand_offs_clock_unless_at_once);
//     an emergency or a threat, the owner, then after 5 minutes with no reply or console tap whoever they named and
//     Rosie's team, paged every 5 minutes until acknowledged; any other hand-off, the owner in text hours, then Rosie's
//     team after 2 days unanswered (S11-19: "Still no answer after 2 days ... Rosie's team checks first").
//   - The owner is told through the hand-off's alert, one outbox row to the owner's own open chat, else email (MC C9), of
//     send class safety for crisis words, an emergency or a threat and routine for any other (K-09 v1.10 default 176),
//     under the business (K-05 open gap 78).
//   - The escalation is a clock row (K-04 clock_rows, kind job, owned by the minute sweep, firing {"job":
//     "hand-off-escalation", "handOff": <id>}, as K-36's seeds write it), due at escalate_at, written once in the commit
//     (T-1156). When it fires with no answer, the sweep pages the team for the hand-off (escalationRequest, then
//     page.ts's pageTeam with reason hand_off), which opens the team's page and sets escalated_at.
//   - An answer (a reply or a console tap from the person told) records it and cancels the escalation's clock row while
//     it still waits; one that already fired stays as it is (the team was paged; K-36 open gap: the owner's late answer).
//   - A handOff's kind is its safety read's (K-36 rule 5; T-1447, DL-934), checked before anything is written or
//     answered (default 31), so its summary follows the read's real outcome: each safety kind writes its owner line
//     word for word, never the read's id, which stays in the team's page summary (README rule 4; defaults 32 to 34).
//
// Defaults used (for ops/QUESTIONS.md):
//  13. Who is told is the business's live owner, told_as owner: whoever the owner named to stand for them is K-22's
//      (not frozen; K-36 open gap), so no hand-off is told to a named person here; a page names whoever the owner named
//      only when its caller gives them (pageTeam's namedPersonId).
//  14. A hand-off for a safety read is keyed by the read (one hand-off per outcome: the telling port's and a handOff
//      call's for the same outcome are one row), any other by the caller's request id (K-09 v1: "the turn or request id
//      is the key").
//  15. A report about the owner or staff (handOff about ownerOrStaff: a K-34 harm report and the team's page that day,
//      never the person named) is not built here: it answers notBuilt (fail closed) until K-34's harm report for it has a
//      card of its own (its reporter, its named person and its day zone are the safety service's reads).
//  16. A hand-off's alert and its rows name no booking and read no version (as page.ts default 9); the escalation's clock
//      row is due in the business's zone, UTC with none.
//  17. The person told is the only one whose answer counts (K-36 hand_offs.told_person_id; notTold otherwise), whatever
//      the way; the answer's actor is that person, with the owner's role when told as owner.
//  31. (T-1447, DL-934: K-36 rule 5.) A handOff's kind is its safety read's: a read's kind is its most urgent outcome
//      that tells (telling.ts default 23: crisis words, else an emergency, else a threat), and kind other names no read
//      (hand_offs_safety_kind_has_outcome). Refused before anything is written or answered, a repeat included
//      (kindNotItsRead, naming the read's id): a read named under another kind than its own (a crisis read as an
//      emergency, a threat or other), a read whose outcomes tell nothing named under a safety kind, a safety kind that
//      names no read, and kind other naming one. A read the business's scope does not show answers notFound
//      (safety_outcomes), nothing written; a read of another business, or of none, is refused (otherBusiness).
//  32. Each safety kind's owner line, word for word: crisis words A3-25's; an emergency K-36's seed-page-acknowledged.json
//      summary (the master gives no owner line of its own: A3-24 says only "No booking" and that Sam is told at once);
//      a threat A3-48's (K-36's seed-page-open.json), with the business's name as texts show it (K-04
//      businesses.display_name, B02; RULES 4.6: with the sensitive switch on, texts show only it), the one value code
//      fills. None holds the read's id, its kind's name or the person's words.
//  33. A threat whose business's name is not read (no businesses row) writes A3-25's line, as telling.ts default 25 does
//      for an outcome whose owner line the master does not give: the owner is still told, and nothing on the safety path
//      is refused for it.
//  34. A handOff call's own summary is written only for a hand-off of kind other; each safety kind writes its owner line
//      whatever the caller gave (crisis words since T-319 round 2; an emergency and a threat since T-1447).

import type { OutboxRowNew } from "../../commit";
import { NotBuiltError, type ErrorsOf, type RequestOf, type ResponseOf } from "../../tool-api";
import type { SafetyOutcome } from "../safety";
import { PagingRefusedError } from "./errors";
import {
  handOffPageSummary,
  handOffStep,
  openPage,
  type PageTeamRequest,
  type PagingPlan,
  type PagingPorts,
} from "./page";
import type { HandOffKind, PagingReader, SafetyHandOffKind, StoredHandOff } from "./ports";
import { resolvePerson } from "./recipients";
import { laterOf, plusMinutes } from "./time";
import { joinPaging, noPagingWrites, pagingEntry, type JobClock, type PagingWrites } from "./writes";

export type HandOffRequest = RequestOf<"handOff">;
export type HandOffResponse = ResponseOf<"handOff">;
export type HandOffError = ErrorsOf<"handOff">;
export type HandOffAnswer = HandOffResponse | HandOffError;
export type AnswerHandOffRequest = RequestOf<"answerHandOff">;
export type AnswerHandOffResponse = ResponseOf<"answerHandOff">;
export type AnswerHandOffError = ErrorsOf<"answerHandOff">;
export type AnswerHandOffAnswer = AnswerHandOffResponse | AnswerHandOffError;

/** What a hand-off's escalation clock row fires, as K-36's seeds write it. */
export const ESCALATION_JOB = "hand-off-escalation";

/** The hand-off a safety read's outcomes call for (telling.ts default 23), or null when none tells. */
export function tellingKindOf(outcomes: readonly SafetyOutcome[]): SafetyHandOffKind | null {
  if (outcomes.includes("Crisis words")) return "crisis_words";
  if (outcomes.includes("An emergency")) return "emergency";
  if (outcomes.includes("A threat to staff or others")) return "threat";
  return null;
}

/**
 * All the owner hears of crisis words (master A3-25: "Rosie's team, and Sam with 'Urgent: a customer may need help'. Never
 * the words."; K-36 v1 hand_offs.summary, audience owner).
 */
export const CRISIS_OWNER_LINE = "Urgent: a customer may need help";

/** All the owner hears of an emergency, word for word (K-36 v1 seed-page-acknowledged.json's summary; default 32). */
export const EMERGENCY_OWNER_LINE =
  "Urgent: a customer may need help. This sounded like an emergency: they were told to get to safety and call 911. Nothing was booked.";

/**
 * All the owner hears of a threat, word for word (master A3-48's line to Sam; K-36 v1 seed-page-open.json's summary),
 * with the business's name as texts show it, the one value code fills (default 32).
 */
export function threatOwnerLine(businessName: string): string {
  return (
    `Urgent: a message to ${businessName} threatened harm to someone on your team. Nothing was booked. ` +
    "Visits with this person are paused until you decide. Details on the secure page."
  );
}

/**
 * A safety kind's owner line (default 32): A3-25's for crisis words, the emergency's, and A3-48's for a threat, or A3-25's
 * for a threat whose business's name is not read (default 33). Never the read's id or the person's words.
 */
export function ownerLineOf(kind: SafetyHandOffKind, businessName: string | null): string {
  switch (kind) {
    case "crisis_words":
      return CRISIS_OWNER_LINE;
    case "emergency":
      return EMERGENCY_OWNER_LINE;
    case "threat":
      return businessName === null ? CRISIS_OWNER_LINE : threatOwnerLine(businessName);
  }
}

/**
 * A hand-off's summary as written, only what the owner may hear (K-36 v1 hand_offs.summary; its README rule 4): a safety
 * kind's owner line, whatever the caller gave, so no outcome name, read id or person's words reaches the owner's row or
 * its business-scoped entry (telling.ts default 25; default 34); a hand-off of kind other's as given.
 */
export function ownerSummaryOf(kind: HandOffKind, summary: string, businessName: string | null): string {
  return kind === "other" ? summary : ownerLineOf(kind, businessName);
}

/** An emergency's or a threat's owner has 5 minutes to reply or tap (arch 06 line 329). */
export const OWNER_MINUTES = 5;

/** Any other hand-off waits 2 days unanswered before Rosie's team (S11-19; arch 06 line 329; time.ts default 6). */
export const OTHER_MINUTES = 2 * 24 * 60;

/** When Rosie's team is paged if nobody answers (K-36 v1 hand_offs.escalate_at). */
export function escalateAtOf(kind: HandOffKind, handedAt: string): string {
  switch (kind) {
    case "crisis_words":
      return handedAt;
    case "emergency":
    case "threat":
      return plusMinutes(handedAt, OWNER_MINUTES);
    case "other":
      return plusMinutes(handedAt, OTHER_MINUTES);
  }
}

/** A hand-off's key (default 14): its safety read's, else the caller's request id. */
export function handOffKeyOf(safetyOutcomeId: string | null, requestId: string): string {
  return safetyOutcomeId === null ? `request:${requestId}` : `outcome:${safetyOutcomeId}`;
}

/** The key of the one page a hand-off escalates to (page.ts pageKeyOf for reason hand_off). */
export function handOffPageKey(handOffId: string): string {
  return `hand_off:${handOffId}`;
}

/** A new hand-off, as handOff and the telling port (telling.ts) open it. */
export interface NewHandOff {
  readonly handOffId: string;
  readonly businessId: string;
  readonly kind: HandOffKind;
  readonly safetyOutcomeId: string | null;
  readonly turnId: string | null;
  readonly bookingId: string | null;
  readonly aboutPersonId: string | null;
  /**
   * What its caller says is handed off: written as given for a hand-off of kind other; each safety kind writes its owner
   * line instead, whatever is given (ownerSummaryOf; K-36 v1 hand_offs.summary; default 34).
   */
  readonly summary: string;
  readonly now: string;
  /** For crisis words, whether the team's page opened at once repeats every 5 minutes until acknowledged. */
  readonly pageRepeats: boolean;
}

/** A hand-off opened: what its commit writes and what its answer names. */
export interface OpenedHandOff {
  readonly writes: PagingWrites;
  readonly alertOutboxRowId: string | null;
  readonly escalateAt: string;
  readonly escalationClockRowId: string | null;
  /** The team's page opened at once (crisis words), or null. */
  readonly teamPageId: string | null;
  /** Every outbox row it writes, in commit order: the alert, then the page's rows. */
  readonly rows: readonly OutboxRowNew[];
}

/**
 * Opens one hand-off: its row, its alert to the owner, its escalation's clock row, and for crisis words the team's page at
 * once. Reads only. Its writes go in commit order: the hand-off, then the page that points at it (team_pages_hand_off_fk).
 */
export async function openHandOff(handOff: NewHandOff, ports: PagingPorts): Promise<OpenedHandOff> {
  const { reader, ids } = ports;
  const owner = await reader.ownerOf(handOff.businessId);
  if (owner === null) throw new PagingRefusedError("noOwner", [handOff.businessId]);
  const step = handOffStep(handOff.kind);
  const atOnce = handOff.kind === "crisis_words";

  // The alert to the owner (K-09 v1 handOff.response.alertOutboxRowId; K-09 v1.10 default 176).
  const told = await resolvePerson(owner, reader, ports.recipients);
  const alert: OutboxRowNew | null =
    told.to === "row"
      ? {
          id: await ids.rowId("alert", handOff.handOffId),
          recipientHandleId: told.reached.handleId,
          recipientPersonId: owner,
          businessId: handOff.businessId,
          bookingId: null,
          channel: told.reached.channel,
          sendClass: handOff.kind === "other" ? "routine" : "safety",
          openQuestionId: null,
          copyOfRowId: null,
          versionsRead: [],
        }
      : null;

  // The escalation: at once for crisis words (no clock row), else its clock row due at escalate_at.
  const escalateAt = escalateAtOf(handOff.kind, handOff.now);
  const clock: JobClock | null = atOnce
    ? null
    : {
        id: await ids.rowId("escalation", handOff.handOffId),
        kind: "job",
        openQuestionId: null,
        reservationId: null,
        handleId: null,
        businessId: handOff.businessId,
        bookingId: handOff.bookingId,
        fires: { job: ESCALATION_JOB, handOff: handOff.handOffId },
        due: { dueAt: escalateAt, dueZone: (await reader.businessZone(handOff.businessId)) ?? "UTC" },
      };

  // Crisis words: Rosie's team at once, through the page that points at the hand-off.
  const stored: StoredHandOff = {
    id: handOff.handOffId,
    businessId: handOff.businessId,
    kind: handOff.kind,
    safetyOutcomeId: handOff.safetyOutcomeId,
    turnId: handOff.turnId,
    bookingId: handOff.bookingId,
    aboutPersonId: handOff.aboutPersonId,
    toldPersonId: owner,
    toldAs: "owner",
    alertOutboxRowId: alert?.id ?? null,
    handedAt: handOff.now,
    escalateAt,
    escalationClockRowId: clock?.id ?? null,
    answeredAt: null,
    answeredVia: null,
    answeredByPersonId: null,
    escalatedAt: null,
    version: 1,
  };
  const page = atOnce
    ? await openPage(
        {
          pageId: await ids.rowId("page", handOffPageKey(handOff.handOffId)),
          reason: "hand_off",
          businessId: handOff.businessId,
          pointers: {
            handOffId: handOff.handOffId,
            harmReportId: null,
            reviewItemId: null,
            safetyTimerId: null,
            turnId: handOff.turnId,
          },
          namedPersonId: null,
          summary: handOffPageSummary(stored, "atOnce"),
          repeating: handOff.pageRepeats,
          sendClass: "safety",
          step,
          now: handOff.now,
        },
        ports,
      )
    : null;
  const escalatedAt = page === null ? null : handOff.now;

  // The business's name, which a threat's owner line names (default 32).
  const businessName = handOff.kind === "threat" ? await reader.businessName(handOff.businessId) : null;
  const created = {
    kind: handOff.kind,
    safety_outcome_id: handOff.safetyOutcomeId,
    turn_id: handOff.turnId,
    booking_id: handOff.bookingId,
    about_person_id: handOff.aboutPersonId,
    told_person_id: owner,
    told_as: "owner",
    alert_outbox_row_id: alert?.id ?? null,
    summary: ownerSummaryOf(handOff.kind, handOff.summary, businessName),
    handed_at: handOff.now,
    escalate_at: escalateAt,
    escalation_clock_row_id: clock?.id ?? null,
  };
  const entries = [
    pagingEntry({
      kind: "hand_off.created",
      move: "created",
      table: "hand_offs",
      rowId: handOff.handOffId,
      businessId: handOff.businessId,
      actor: null,
      old: null,
      new: created,
      step,
    }),
  ];
  if (escalatedAt !== null) {
    entries.push(
      pagingEntry({
        kind: "hand_off.escalated",
        move: "escalated",
        table: "hand_offs",
        rowId: handOff.handOffId,
        businessId: handOff.businessId,
        actor: null,
        old: { escalated_at: null },
        new: { escalated_at: escalatedAt },
        step,
      }),
    );
  }
  let writes: PagingWrites = {
    ...noPagingWrites(step),
    state: [
      {
        op: "insert",
        table: "hand_offs",
        values: {
          id: handOff.handOffId,
          business_id: handOff.businessId,
          ...created,
          escalated_at: escalatedAt,
        },
      },
    ],
    stateEvents: entries,
    messages: alert === null ? [] : [alert],
    clocks: clock === null ? [] : [clock],
  };
  if (page !== null) writes = joinPaging(writes, page.writes);
  return {
    writes,
    alertOutboxRowId: alert?.id ?? null,
    escalateAt,
    escalationClockRowId: clock?.id ?? null,
    teamPageId: page === null ? null : await ids.rowId("page", handOffPageKey(handOff.handOffId)),
    rows: writes.messages,
  };
}

// ---- handOff --------------------------------------------------------------------------------------------------------

/** One handOff call: its request, the business it runs under and the call's now. */
export interface HandOffCall {
  readonly request: HandOffRequest;
  /** The business the call runs under (its scope). */
  readonly businessId: string;
  readonly now: string;
}

/** The answer a stored hand-off gives a repeat. */
async function repeatAnswer(handOff: StoredHandOff, ports: PagingPorts): Promise<HandOffResponse> {
  const pageId = await ports.ids.rowId("page", handOffPageKey(handOff.id));
  const page = handOff.kind === "crisis_words" ? await ports.reader.page(pageId) : null;
  return {
    handOffId: handOff.id,
    harmReportId: null,
    alertOutboxRowId: handOff.alertOutboxRowId,
    escalateAt: handOff.escalateAt,
    escalationClockRowId: handOff.escalationClockRowId,
    teamPageId: page === null ? null : page.id,
    repeated: true,
  };
}

/**
 * A handOff's kind, checked against its safety read (K-36 rule 5; hand_offs_safety_kind_has_outcome; default 31): other
 * for a hand-off that names no read, else its read's own kind (default 23), which must be the kind it names. A read the
 * business's scope does not show answers notFound; any other mismatch throws before anything is written. Reads only.
 */
async function kindOfItsRead(
  request: HandOffRequest,
  businessId: string,
  reader: PagingReader,
): Promise<HandOffKind | HandOffError> {
  const outcomeId = request.safetyOutcomeId;
  if (outcomeId === null) {
    if (request.kind !== "other") throw new PagingRefusedError("kindNotItsRead");
    return "other";
  }
  if (request.kind === "other") throw new PagingRefusedError("kindNotItsRead", [outcomeId]);
  const read = await reader.safetyRead(outcomeId);
  if (read === null) return { error: "notFound", table: "safety_outcomes", rowId: outcomeId };
  if (read.businessId !== businessId) throw new PagingRefusedError("otherBusiness", [outcomeId]);
  if (tellingKindOf(read.outcomes) !== request.kind)
    throw new PagingRefusedError("kindNotItsRead", [outcomeId]);
  return request.kind;
}

/** Plans one handOff call: the hand-off, its alert and its escalation. Reads only. */
export async function planHandOff(call: HandOffCall, ports: PagingPorts): Promise<PagingPlan<HandOffAnswer>> {
  const { request, businessId, now } = call;
  // A report about the owner or staff goes to Rosie's team as a harm report, never to the person named: not built here.
  if (request.about === "ownerOrStaff") throw new NotBuiltError("handOff");
  if (request.caller.businessId !== null && request.caller.businessId !== businessId) {
    throw new PagingRefusedError("otherBusiness");
  }
  const key = handOffKeyOf(request.safetyOutcomeId, request.caller.requestId);
  const step = handOffStep(request.kind);
  // K-36 rule 5 before anything is written or answered, a repeat included: the kind is the read's (default 31).
  const kind = await kindOfItsRead(request, businessId, ports.reader);
  if (typeof kind !== "string") return { key, answer: kind, writes: noPagingWrites(step) };
  const handOffId = await ports.ids.rowId("handOff", key);
  const stored = await ports.reader.handOff(handOffId);
  if (stored !== null)
    return { key, answer: await repeatAnswer(stored, ports), writes: noPagingWrites(step) };

  const opened = await openHandOff(
    {
      handOffId,
      businessId,
      kind,
      safetyOutcomeId: request.safetyOutcomeId,
      turnId: request.caller.turnId,
      bookingId: request.bookingId,
      aboutPersonId: request.aboutPersonId,
      summary: request.summary,
      now,
      pageRepeats: false,
    },
    ports,
  );
  return {
    key,
    answer: {
      handOffId,
      harmReportId: null,
      alertOutboxRowId: opened.alertOutboxRowId,
      escalateAt: opened.escalateAt,
      escalationClockRowId: opened.escalationClockRowId,
      teamPageId: opened.teamPageId,
      repeated: false,
    },
    writes: opened.writes,
  };
}

// ---- answerHandOff --------------------------------------------------------------------------------------------------

/** One answerHandOff call: its request and the call's now. */
export interface AnswerHandOffCall {
  readonly request: AnswerHandOffRequest;
  readonly now: string;
}

/** Plans one answerHandOff call: the answer recorded and the escalation's clock row cancelled. Reads only. */
export async function planAnswerHandOff(
  call: AnswerHandOffCall,
  ports: PagingPorts,
): Promise<PagingPlan<AnswerHandOffAnswer>> {
  const { request, now } = call;
  const key = `answer:${request.handOffId}`;
  const handOff = await ports.reader.handOff(request.handOffId);
  const nothing = (answer: AnswerHandOffAnswer, step: string): PagingPlan<AnswerHandOffAnswer> => ({
    key,
    answer,
    writes: noPagingWrites(step),
  });
  if (handOff === null) {
    return nothing({ error: "notFound", table: "hand_offs", rowId: request.handOffId }, "S11-19");
  }
  const step = handOffStep(handOff.kind);
  if (request.caller.businessId !== null && request.caller.businessId !== handOff.businessId) {
    throw new PagingRefusedError("otherBusiness", [handOff.id]);
  }
  if (handOff.answeredAt !== null) {
    return nothing({ answeredAt: handOff.answeredAt, cancelledClockRowId: null, repeated: true }, step);
  }
  if (handOff.version !== request.expectVersion) {
    return nothing(
      {
        error: "versionChanged",
        changed: [
          {
            table: "hand_offs",
            rowId: handOff.id,
            readVersion: request.expectVersion,
            currentVersion: handOff.version,
          },
        ],
      },
      step,
    );
  }
  const personId = request.caller.personId;
  if (personId !== handOff.toldPersonId) return nothing({ error: "notTold", handOffId: handOff.id }, step);

  const answeredAt = laterOf(now, handOff.handedAt);
  const clock =
    handOff.escalationClockRowId === null ? null : await ports.reader.clock(handOff.escalationClockRowId);
  const cancel = clock !== null && (clock.state === "waiting" || clock.state === "armed") ? clock : null;
  const set = { answered_at: answeredAt, answered_via: request.via, answered_by_person_id: personId };
  return {
    key,
    answer: { answeredAt, cancelledClockRowId: cancel?.id ?? null, repeated: false },
    writes: {
      ...noPagingWrites(step),
      state: [
        { op: "update", table: "hand_offs", key: { id: handOff.id }, expectVersion: handOff.version, set },
      ],
      stateEvents: [
        pagingEntry({
          kind: "hand_off.answered",
          move: "answered",
          table: "hand_offs",
          rowId: handOff.id,
          businessId: handOff.businessId,
          actor: { personId, role: handOff.toldAs === "owner" ? "owner" : null },
          old: { answered_at: null },
          new: set,
          step,
        }),
      ],
      clockCancels: cancel === null ? [] : [{ id: cancel.id, expectVersion: cancel.version }],
    },
  };
}

// ---- the escalation's firing ----------------------------------------------------------------------------------------

/**
 * The pageTeam request a hand-off's escalation clock row makes when it fires with no answer (the minute sweep's, no
 * handle: caller clockFiring, keyed by the clock row; K-09 page-team.json): reason hand_off, its hand-off the pointer,
 * repeating every 5 minutes for an emergency or a threat and paged once for any other, which then waits in the team
 * console. Null when the hand-off was answered first: nobody is paged (arch 06 line 329: "with no reply or console tap").
 * Whoever the owner named is paged with the team for an emergency or a threat (arch 06 line 329), when the caller knows
 * them (default 13).
 */
export function escalationRequest(input: {
  readonly handOff: StoredHandOff;
  readonly clockRowId: string;
  readonly traceId: string;
  readonly namedPersonId: string | null;
}): PageTeamRequest | null {
  const { handOff } = input;
  if (handOff.answeredAt !== null) return null;
  const repeating = handOff.kind === "emergency" || handOff.kind === "threat";
  return {
    caller: {
      kind: "clockFiring",
      turnId: null,
      requestId: input.clockRowId,
      businessId: handOff.businessId,
      personId: null,
      traceId: input.traceId,
    },
    reason: "hand_off",
    pointerId: handOff.id,
    namedPersonId: repeating ? input.namedPersonId : null,
    summary: handOffPageSummary(handOff, handOff.kind === "other" ? "twoDays" : "fiveMinutes"),
    repeating,
    repeatOfPageId: null,
  };
}
