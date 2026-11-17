// pageTeam and acknowledgePage (T-319; C-104; K-09 v1; K-36 v1 team_pages and team_page_recipients; arch 06 line 329;
// QUESTIONS.md M3-M3b.5; Q-18): a page to Rosie's team, paged every 5 minutes until acknowledged when it repeats (an
// emergency or a threat, DD), and its acknowledgement, which cancels the next page's clock row.
//
//   - A new page writes its team_pages row, one outbox row to each person it reaches (recipients.ts: every member live on
//     the list, and for a hand_off page whoever the owner named), and, when it repeats, the clock row of its next page due
//     5 minutes on (K-04 clock_rows, kind job, owned by the minute sweep, firing {"job": "team-page", "page": <id>}, as
//     K-36's seeds write it), written once in the call's commit (T-1156's clocks rule). A hand_off page also sets the
//     hand-off's escalated_at (K-36: "when it fires, the team page is opened and escalated_at set"; K-08 README default
//     21: hand_off.escalated is pageTeam's write).
//   - A repeat page (repeatOfPageId), fired by the page's own clock row, pages every live member again with new rows,
//     moves times_paged and last_paged_at, and arms the next page's clock row: a clock row fires once (K-05 item 5), so
//     each page arms a new one and next_page_clock_row_id moves to it.
//   - An acknowledgement (a reply or a console tap from a person paged) closes the page and cancels its next page's clock
//     row while it is still waiting or armed; one that already fired is left as it is.
//
// It only reads, through its ports, and hands back what the commit is to write: a repeated turn or firing runs it again
// before K-05 answers `repeated`. Nothing here logs; what it returns or throws names rows, rules and faults, never a
// person's words, a number or an address (K-08 v1).
//
// Defaults used (for ops/QUESTIONS.md):
//   7. A page's rows are send class safety when it is about crisis words, an emergency or a threat (a hand_off page whose
//      hand-off is of those kinds), and routine otherwise, as K-09 v1 pageTeam.response.outboxRowIds and K-09 v1.10
//      default 176 state; so a harm report's, a missed timer's or a breach's page waits for text hours (arch 08 line 447
//      says a breach pages "at once": for the architect, with K-36's open gap "Which pages repeat").
//   8. A page's key is what it points at: one page per hand-off (team_pages_one_per_hand_off), per harm report, review
//      item, missed timer or passed-on turn; a page that points at nothing is keyed by the caller's request id. A repeat
//      page is keyed by the clock row that fired it (K-09 v1 pageTeam: "for a repeat page, the clock row").
//   9. A page's rows and its clock rows name no booking and no question, read no version, and are written under the
//      page's business (K-05 open gap 78: so K-05 v1.16's readOutboxRowWritten sees them under the record's business);
//      its clock rows are due in the business's zone, UTC with no business or no zone (the zone only says how the due
//      time reads).
//  10. A repeat names the rows the first call wrote: one row per person paged, keyed by the page, its number and the
//      person, among the members live while the page was open and the person named, each kept only when K-05 says it is
//      written (PagingReader.outboxRowWritten).
//  11. Who may acknowledge: a member live on the list while the page was open, or the person named (K-36 rule 5: "a page
//      acknowledged by reply comes from one of the people paged"); notPaged otherwise. The acknowledgement's time is the
//      call's now, or the last page's when the clocks disagree (team_pages_acknowledged_after_paged).
//  12. A page's why is the step whose rule pages: S11-19 for a hand-off of kind other and for word the owner cannot act,
//      A3-22 (the danger check) for a hand-off of crisis words, an emergency or a threat, A3-49 for a harm report, S13-10
//      for a missed safety timer; a review item's, a passed-on reply's and a breach's page names none (K-08 why null),
//      and so rides in no turn's commit (handlers.ts).

import type { OutboxRowNew, StateWrite } from "../../commit";
import type { Caller, ErrorsOf, RequestOf, ResponseOf } from "../../tool-api";
import { PagingRefusedError } from "./errors";
import type { PagingIds } from "./ids";
import type { HandOffKind, PageReason, PagingReader, StoredHandOff, StoredPage, TeamMember } from "./ports";
import { pageRecipients, type RecipientContext, type Resolution } from "./recipients";
import { laterOf, plusMinutes } from "./time";
import { noPagingWrites, pagingEntry, type JobClock, type PagingWrites } from "./writes";

export type PageTeamRequest = RequestOf<"pageTeam">;
export type PageTeamResponse = ResponseOf<"pageTeam">;
export type PageTeamError = ErrorsOf<"pageTeam">;
export type PageTeamAnswer = PageTeamResponse | PageTeamError;
export type AcknowledgePageRequest = RequestOf<"acknowledgePage">;
export type AcknowledgePageResponse = ResponseOf<"acknowledgePage">;
export type AcknowledgePageError = ErrorsOf<"acknowledgePage">;
export type AcknowledgePageAnswer = AcknowledgePageResponse | AcknowledgePageError;
/** K-05 v1 outboxRowNew.sendClass. */
export type SendClass = OutboxRowNew["sendClass"];

/** What the paging calls read with. */
export interface PagingPorts {
  readonly reader: PagingReader;
  readonly ids: PagingIds;
  readonly recipients: RecipientContext;
}

/** One call's plan: the key a repeat is known by, its answer, and what its commit writes (nothing for a refusal). */
export interface PagingPlan<Answer> {
  readonly key: string;
  readonly answer: Answer;
  readonly writes: PagingWrites;
}

/** A repeating page is paged again every 5 minutes until acknowledged (arch 06 line 329, DD; K-36 repeat_minutes). */
export const REPEAT_MINUTES = 5;

/** What a page's clock row fires, as K-36's seeds write it. */
export const PAGE_CLOCK_JOB = "team-page";

/** The step whose rule pages for each reason (default 12); a hand_off page takes its hand-off's (handOffStep). */
export const PAGE_STEP: Readonly<Record<PageReason, string | null>> = {
  hand_off: "S11-19",
  owner_cannot_act: "S11-19",
  harm_report: "A3-49",
  review_item: null,
  safety_timer_missed: "S13-10",
  passed_on: null,
  hard_invariant_breach: null,
};

/** A hand-off's step: S11-19 for any other hand-off, A3-22 (the danger check) for crisis words, an emergency or a threat. */
export function handOffStep(kind: HandOffKind): string {
  return kind === "other" ? "S11-19" : "A3-22";
}

/** A page's send class (default 7): safety about crisis words, an emergency or a threat; routine otherwise. */
export function pageClassOf(reason: PageReason, handOffKind: HandOffKind | null): SendClass {
  return reason === "hand_off" && handOffKind !== null && handOffKind !== "other" ? "safety" : "routine";
}

/** The reasons that point at a row, and the request field that names it (K-36 v1 team_pages pointer CHECKs). */
const POINTED: readonly PageReason[] = ["hand_off", "harm_report", "review_item", "safety_timer_missed"];

/** A page's key (default 8). */
export function pageKeyOf(reason: PageReason, pointerId: string | null, caller: Caller): string {
  if (pointerId !== null) return `${reason}:${pointerId}`;
  if (reason === "passed_on" && caller.turnId !== null) return `passed_on:${caller.turnId}`;
  return `request:${caller.requestId}`;
}

/** What a new page points at, column by column (K-36 v1 team_pages). */
export interface PagePointers {
  readonly handOffId: string | null;
  readonly harmReportId: string | null;
  readonly reviewItemId: string | null;
  readonly safetyTimerId: string | null;
  readonly turnId: string | null;
}

/** The pointer column a stored page holds for its reason, as a request names it (pointerId). */
export function pointerOf(page: Pick<StoredPage, "reason" | keyof PagePointers>): string | null {
  switch (page.reason) {
    case "hand_off":
      return page.handOffId;
    case "harm_report":
      return page.harmReportId;
    case "review_item":
      return page.reviewItemId;
    case "safety_timer_missed":
      return page.safetyTimerId;
    default:
      return null;
  }
}

/** A new page, as planPageTeam and the telling port (telling.ts) open it. */
export interface NewPage {
  readonly pageId: string;
  readonly reason: PageReason;
  readonly businessId: string | null;
  readonly pointers: PagePointers;
  readonly namedPersonId: string | null;
  readonly summary: string;
  readonly repeating: boolean;
  readonly sendClass: SendClass;
  /** The step its entries name, or null (default 12). */
  readonly step: string | null;
  readonly now: string;
}

/** A page opened: what its commit writes, its rows' ids and its next page's clock row (null when it does not repeat). */
export interface OpenedPage {
  readonly writes: PagingWrites;
  readonly rowIds: readonly string[];
  readonly nextPageClockRowId: string | null;
}

/** The zone a page's clock rows are due in (default 9). */
async function zoneOf(businessId: string | null, reader: PagingReader): Promise<string> {
  if (businessId === null) return "UTC";
  return (await reader.businessZone(businessId)) ?? "UTC";
}

/** One outbox row per person a page reaches (to "row"), keyed by the page, its number and the person (default 10). */
async function pageRows(
  page: { readonly pageId: string; readonly businessId: string | null; readonly sendClass: SendClass },
  number: number,
  resolved: readonly Resolution[],
  ids: PagingIds,
): Promise<OutboxRowNew[]> {
  const rows: OutboxRowNew[] = [];
  for (const each of resolved) {
    if (each.to !== "row") continue;
    const { reached } = each;
    rows.push({
      id: await ids.rowId("pageRow", page.pageId, `${String(number)}/${reached.personId}`),
      recipientHandleId: reached.handleId,
      recipientPersonId: reached.personId,
      businessId: page.businessId,
      bookingId: null,
      channel: reached.channel,
      sendClass: page.sendClass,
      openQuestionId: null,
      copyOfRowId: null,
      versionsRead: [],
    });
  }
  return rows;
}

/** The clock row that sends a page's `number`-th page, due 5 minutes after `now` (K-36's seeds). */
async function pageClock(
  page: { readonly pageId: string; readonly businessId: string | null },
  number: number,
  now: string,
  zone: string,
  ids: PagingIds,
): Promise<JobClock> {
  return {
    id: await ids.rowId("pageClock", page.pageId, String(number)),
    kind: "job",
    openQuestionId: null,
    reservationId: null,
    handleId: null,
    businessId: page.businessId,
    bookingId: null,
    fires: { job: PAGE_CLOCK_JOB, page: page.pageId },
    due: { dueAt: plusMinutes(now, REPEAT_MINUTES), dueZone: zone },
  };
}

/**
 * Opens one page: its row, one outbox row per person it reaches and, when it repeats, its next page's clock row. Null
 * when no member is live on the list (pageTeam's noRecipients), with nothing written.
 */
export async function openPage(page: NewPage, ports: PagingPorts): Promise<OpenedPage | null> {
  const { members, resolved } = await pageRecipients(
    { at: page.now, namedPersonId: page.namedPersonId },
    ports.reader,
    ports.recipients,
  );
  if (members.length === 0) return null;
  const rows = await pageRows(page, 1, resolved, ports.ids);
  const clock = page.repeating
    ? await pageClock(page, 2, page.now, await zoneOf(page.businessId, ports.reader), ports.ids)
    : null;
  const values = {
    reason: page.reason,
    business_id: page.businessId,
    hand_off_id: page.pointers.handOffId,
    harm_report_id: page.pointers.harmReportId,
    review_item_id: page.pointers.reviewItemId,
    safety_timer_id: page.pointers.safetyTimerId,
    turn_id: page.pointers.turnId,
    named_person_id: page.namedPersonId,
    summary: page.summary,
    opened_at: page.now,
    last_paged_at: page.now,
    times_paged: 1,
    repeat_minutes: page.repeating ? REPEAT_MINUTES : null,
    next_page_clock_row_id: clock?.id ?? null,
    state: "open",
  };
  const writes: PagingWrites = {
    ...noPagingWrites(page.step ?? ""),
    state: [{ op: "insert", table: "team_pages", values: { id: page.pageId, ...values } }],
    stateEvents: [
      pagingEntry({
        kind: "team_page.opened",
        move: "opened",
        table: "team_pages",
        rowId: page.pageId,
        businessId: null,
        actor: null,
        old: null,
        new: values,
        step: page.step,
      }),
    ],
    messages: rows,
    clocks: clock === null ? [] : [clock],
  };
  return { writes, rowIds: rows.map((row) => row.id), nextPageClockRowId: clock?.id ?? null };
}

/**
 * The rows the `number`-th page of a stored page wrote (default 10): one id per person who could have been paged while
 * it was open (members live at some time between its opening and its last page, and the person named), kept when written.
 */
export async function rowsOfPage(page: StoredPage, number: number, ports: PagingPorts): Promise<string[]> {
  const from = Date.parse(page.openedAt);
  const to = Date.parse(page.lastPagedAt);
  const people: string[] = [];
  const members = [...(await ports.reader.members())].sort((a, b) =>
    a.addedAt === b.addedAt ? (a.id < b.id ? -1 : 1) : Date.parse(a.addedAt) - Date.parse(b.addedAt),
  );
  for (const member of members) {
    const live =
      Date.parse(member.addedAt) <= to && (member.removedAt === null || Date.parse(member.removedAt) > from);
    if (live && !people.includes(member.personId)) people.push(member.personId);
  }
  if (page.namedPersonId !== null && !people.includes(page.namedPersonId)) people.push(page.namedPersonId);
  const written: string[] = [];
  for (const personId of people) {
    const id = await ports.ids.rowId("pageRow", page.id, `${String(number)}/${personId}`);
    if (await ports.reader.outboxRowWritten(id)) written.push(id);
  }
  return written;
}

/** Whether a person was paged by a stored page: a member live while it was open, or the person named (default 11). */
export function wasPaged(page: StoredPage, personId: string, members: readonly TeamMember[]): boolean {
  if (page.namedPersonId === personId) return true;
  const from = Date.parse(page.openedAt);
  const to = Date.parse(page.lastPagedAt);
  return members.some(
    (member) =>
      member.personId === personId &&
      Date.parse(member.addedAt) <= to &&
      (member.removedAt === null || Date.parse(member.removedAt) > from),
  );
}

/** Words for a hand-off's kind in a team summary: kinds, never a person's words (K-36 v1 team_pages.summary). */
const KIND_WORDS: Readonly<Record<HandOffKind, string>> = {
  crisis_words: "crisis words",
  emergency: "an emergency",
  threat: "a threat to staff or others",
  other: "a hand-off",
};

/** The team's summary of a hand-off's page: its id, kind, business and safety read, ids and kinds alone. */
export function handOffPageSummary(
  handOff: StoredHandOff,
  after: "atOnce" | "fiveMinutes" | "twoDays",
): string {
  const read = handOff.safetyOutcomeId === null ? "" : `, read from ${handOff.safetyOutcomeId}`;
  const when =
    after === "atOnce"
      ? "Rosie's team and the owner are told at once"
      : `no reply or console tap from the person told in ${after === "fiveMinutes" ? "5 minutes" : "2 days"}`;
  return `Hand-off ${handOff.id} at ${handOff.businessId}: ${KIND_WORDS[handOff.kind]}${read}; ${when}.`;
}

// ---- pageTeam -------------------------------------------------------------------------------------------------------

/** One pageTeam call: its request and the call's now. */
export interface PageTeamCall {
  readonly request: PageTeamRequest;
  /** The call's now, UTC ending in Z. */
  readonly now: string;
}

/** The hand-off a hand_off page points at, read under the call's business. */
async function handOffOf(request: PageTeamRequest, reader: PagingReader): Promise<StoredHandOff> {
  const id = request.pointerId;
  const handOff = id === null ? null : await reader.handOff(id);
  if (handOff === null) throw new PagingRefusedError("pointerNotFound", id === null ? [] : [id]);
  if (request.caller.businessId !== null && handOff.businessId !== request.caller.businessId) {
    throw new PagingRefusedError("otherBusiness", [handOff.id]);
  }
  return handOff;
}

/** The answer a page's repeat gives: the page and its `number`-th page's rows (default 10). */
async function repeatedAnswer(
  page: StoredPage,
  number: number,
  ports: PagingPorts,
): Promise<PageTeamResponse> {
  return {
    pageId: page.id,
    timesPaged: number,
    outboxRowIds: await rowsOfPage(page, number, ports),
    nextPageClockRowId:
      page.repeatMinutes === null ? null : await ports.ids.rowId("pageClock", page.id, String(number + 1)),
    repeated: true,
  };
}

/** Plans one pageTeam call: a new page, or the next page of a repeating one. Reads only. */
export async function planPageTeam(
  call: PageTeamCall,
  ports: PagingPorts,
): Promise<PagingPlan<PageTeamAnswer>> {
  const { request, now } = call;
  const { reason, pointerId, caller } = request;
  const key = request.repeatOfPageId === null ? pageKeyOf(reason, pointerId, caller) : caller.requestId;
  const nothing = (answer: PageTeamAnswer): PagingPlan<PageTeamAnswer> => ({
    key,
    answer,
    writes: noPagingWrites(PAGE_STEP[reason] ?? ""),
  });

  // The pointer each reason needs (K-36 v1 team_pages CHECKs), before anything is read.
  const pointed = POINTED.includes(reason);
  if (pointed && pointerId === null) return nothing({ error: "pointerMissing", reason });
  if (reason === "passed_on" && caller.turnId === null) return nothing({ error: "pointerMissing", reason });
  if (reason === "owner_cannot_act" && caller.businessId === null) {
    return nothing({ error: "pointerMissing", reason });
  }
  if (!pointed && pointerId !== null) throw new PagingRefusedError("pointerNotForReason", [pointerId]);
  if (request.namedPersonId !== null && reason !== "hand_off") {
    throw new PagingRefusedError("namedOnlyForHandOff");
  }

  if (request.repeatOfPageId !== null) return planRepeatPage(call, key, ports);

  const pageId = await ports.ids.rowId("page", key);
  const stored = await ports.reader.page(pageId);
  if (stored !== null) return nothing(await repeatedAnswer(stored, 1, ports));

  const handOff = reason === "hand_off" ? await handOffOf(request, ports.reader) : null;
  const step = handOff === null ? PAGE_STEP[reason] : handOffStep(handOff.kind);
  const opened = await openPage(
    {
      pageId,
      reason,
      businessId: handOff?.businessId ?? caller.businessId,
      pointers: {
        handOffId: reason === "hand_off" ? pointerId : null,
        harmReportId: reason === "harm_report" ? pointerId : null,
        reviewItemId: reason === "review_item" ? pointerId : null,
        safetyTimerId: reason === "safety_timer_missed" ? pointerId : null,
        turnId: caller.turnId,
      },
      namedPersonId: request.namedPersonId,
      summary: request.summary,
      repeating: request.repeating,
      sendClass: pageClassOf(reason, handOff?.kind ?? null),
      step,
      now,
    },
    ports,
  );
  if (opened === null) return nothing({ error: "noRecipients" });

  // A hand_off page sets its hand-off's escalated_at (K-36; K-08 README default 21), never before its escalate_at.
  let writes = opened.writes;
  if (handOff !== null && handOff.escalatedAt === null) {
    if (Date.parse(now) < Date.parse(handOff.escalateAt)) {
      throw new PagingRefusedError("handOffNotDue", [handOff.id]);
    }
    const escalated: StateWrite = {
      op: "update",
      table: "hand_offs",
      key: { id: handOff.id },
      expectVersion: handOff.version,
      set: { escalated_at: now },
    };
    writes = {
      ...writes,
      state: [...writes.state, escalated],
      stateEvents: [
        ...writes.stateEvents,
        pagingEntry({
          kind: "hand_off.escalated",
          move: "escalated",
          table: "hand_offs",
          rowId: handOff.id,
          businessId: handOff.businessId,
          actor: null,
          old: { escalated_at: null },
          new: { escalated_at: now },
          step,
        }),
      ],
    };
  }
  return {
    key,
    answer: {
      pageId,
      timesPaged: 1,
      outboxRowIds: [...opened.rowIds],
      nextPageClockRowId: opened.nextPageClockRowId,
      repeated: false,
    },
    writes,
  };
}

/** The next page of a repeating page, fired by its own clock row (the call's key). */
async function planRepeatPage(
  call: PageTeamCall,
  key: string,
  ports: PagingPorts,
): Promise<PagingPlan<PageTeamAnswer>> {
  const { request, now } = call;
  const pageId = request.repeatOfPageId ?? "";
  const nothing = (answer: PageTeamAnswer): PagingPlan<PageTeamAnswer> => ({
    key,
    answer,
    writes: noPagingWrites(PAGE_STEP[request.reason] ?? ""),
  });
  const page = await ports.reader.page(pageId);
  if (page?.reason !== request.reason || pointerOf(page) !== request.pointerId) {
    throw new PagingRefusedError("notThePage", [pageId]);
  }
  if (page.state === "acknowledged") return nothing({ error: "pageClosed", pageId: page.id });
  if (page.repeatMinutes === null) throw new PagingRefusedError("pageNotRepeating", [page.id]);

  if (page.nextPageClockRowId !== key) {
    // An earlier firing of one of this page's clock rows, run again: the page it sent, as first answered.
    for (let number = 2; number <= page.timesPaged; number += 1) {
      if ((await ports.ids.rowId("pageClock", page.id, String(number))) === key) {
        return nothing(await repeatedAnswer(page, number, ports));
      }
    }
    throw new PagingRefusedError("notThePagesClock", [page.id]);
  }

  const handOff =
    page.reason === "hand_off" && page.handOffId !== null ? await ports.reader.handOff(page.handOffId) : null;
  const step = handOff === null ? PAGE_STEP[page.reason] : handOffStep(handOff.kind);
  const number = page.timesPaged + 1;
  const { members, resolved } = await pageRecipients(
    { at: now, namedPersonId: page.namedPersonId },
    ports.reader,
    ports.recipients,
  );
  if (members.length === 0) return nothing({ error: "noRecipients" });
  const sendClass = pageClassOf(page.reason, handOff?.kind ?? null);
  const rows = await pageRows(
    { pageId: page.id, businessId: page.businessId, sendClass },
    number,
    resolved,
    ports.ids,
  );
  const clock = await pageClock(
    { pageId: page.id, businessId: page.businessId },
    number + 1,
    now,
    await zoneOf(page.businessId, ports.reader),
    ports.ids,
  );
  const set = { last_paged_at: now, times_paged: number, next_page_clock_row_id: clock.id };
  return {
    key,
    answer: {
      pageId: page.id,
      timesPaged: number,
      outboxRowIds: rows.map((row) => row.id),
      nextPageClockRowId: clock.id,
      repeated: false,
    },
    writes: {
      ...noPagingWrites(step ?? ""),
      state: [{ op: "update", table: "team_pages", key: { id: page.id }, expectVersion: page.version, set }],
      stateEvents: [
        pagingEntry({
          kind: "team_page.paged_again",
          move: `paged-${String(number)}`,
          table: "team_pages",
          rowId: page.id,
          businessId: null,
          actor: null,
          old: {
            last_paged_at: page.lastPagedAt,
            times_paged: page.timesPaged,
            next_page_clock_row_id: page.nextPageClockRowId,
          },
          new: { ...set, business_id: page.businessId },
          step,
        }),
      ],
      messages: rows,
      clocks: [clock],
    },
  };
}

/**
 * The pageTeam request a page's own clock row makes when it fires (the minute sweep's, no handle: caller clockFiring,
 * keyed by the clock row), for the page it names (K-36's seeds: fires {"job": "team-page", "page": <id>}).
 */
export function repeatPageRequest(input: {
  readonly page: StoredPage;
  readonly clockRowId: string;
  readonly traceId: string;
}): PageTeamRequest {
  const { page } = input;
  return {
    caller: {
      kind: "clockFiring",
      turnId: null,
      requestId: input.clockRowId,
      businessId: page.businessId,
      personId: null,
      traceId: input.traceId,
    },
    reason: page.reason,
    pointerId: pointerOf(page),
    namedPersonId: page.namedPersonId,
    summary: page.summary,
    repeating: true,
    repeatOfPageId: page.id,
  };
}

// ---- acknowledgePage ------------------------------------------------------------------------------------------------

/** One acknowledgePage call: its request and the call's now. */
export interface AcknowledgePageCall {
  readonly request: AcknowledgePageRequest;
  readonly now: string;
}

/** Plans one acknowledgePage call: the page closed and its next page's clock row cancelled. Reads only. */
export async function planAcknowledgePage(
  call: AcknowledgePageCall,
  ports: PagingPorts,
): Promise<PagingPlan<AcknowledgePageAnswer>> {
  const { request, now } = call;
  const key = `acknowledge:${request.pageId}`;
  const page = await ports.reader.page(request.pageId);
  const nothing = (
    answer: AcknowledgePageAnswer,
    step: string | null,
  ): PagingPlan<AcknowledgePageAnswer> => ({
    key,
    answer,
    writes: noPagingWrites(step ?? ""),
  });
  if (page === null) {
    return nothing({ error: "notFound", table: "team_pages", rowId: request.pageId }, null);
  }
  const step = PAGE_STEP[page.reason];
  if (page.state === "acknowledged") {
    return nothing(
      { acknowledgedAt: page.acknowledgedAt ?? page.lastPagedAt, cancelledClockRowId: null, repeated: true },
      step,
    );
  }
  if (page.version !== request.expectVersion) {
    return nothing(
      {
        error: "versionChanged",
        changed: [
          {
            table: "team_pages",
            rowId: page.id,
            readVersion: request.expectVersion,
            currentVersion: page.version,
          },
        ],
      },
      step,
    );
  }
  const personId = request.caller.personId;
  if (personId === null || !wasPaged(page, personId, await ports.reader.members())) {
    return nothing({ error: "notPaged", pageId: page.id }, step);
  }

  const acknowledgedAt = laterOf(now, page.lastPagedAt);
  const clock = page.nextPageClockRowId === null ? null : await ports.reader.clock(page.nextPageClockRowId);
  const cancel = clock !== null && (clock.state === "waiting" || clock.state === "armed") ? clock : null;
  const set = {
    state: "acknowledged",
    acknowledged_at: acknowledgedAt,
    acknowledged_by_person_id: personId,
    acknowledged_via: request.via,
  };
  return {
    key,
    answer: { acknowledgedAt, cancelledClockRowId: cancel?.id ?? null, repeated: false },
    writes: {
      ...noPagingWrites(step ?? ""),
      state: [{ op: "update", table: "team_pages", key: { id: page.id }, expectVersion: page.version, set }],
      stateEvents: [
        pagingEntry({
          kind: "team_page.acknowledged",
          move: "acknowledged",
          table: "team_pages",
          rowId: page.id,
          businessId: null,
          actor: { personId, role: null },
          old: { state: "open" },
          new: { ...set, business_id: page.businessId },
          step,
        }),
      ],
      clockCancels: cancel === null ? [] : [{ id: cancel.id, expectVersion: cancel.version }],
    },
  };
}
