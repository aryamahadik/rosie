// The paging service's test doubles (T-319): an in-memory world of the rows the service reads and writes (K-36's pages,
// recipients and hand-offs, K-37's review items, K-34's safety reads a handOff names (T-1447), K-04's clock rows, chats,
// owners, zones and business names, and the outbox rows written), a reader over it, the writes applied to it as K-05's
// commit would, a roster of staging test phones, and the ids a K-09 fixture names. Never a database: what the database
// itself refuses is the integration tests' (K-36 and K-37's contract tests, T-113 and T-114).
//
// The cast is fixture set v1's and the master's sample cast only (rule 9): Sam (the barbershop's owner), Alex, Pat (the
// person Sam named, K-36's seed), and Rosie's team as placeholder people with no name (person-rosie-team-1 and -2, as
// K-09's new-work-approved.json and control-team-decided.json name them; handle-team-1 and -2, as
// j3-safety-arrival-crisis-rows.json names their handles), each by handle id: no number or address is needed or held.

import { contractJson } from "../messages-consent/test-support";
import type { SafetyOutcome } from "../safety";
import type { PagingIds, PagingRow } from "./ids";
import { KEYED_PAGING_IDS } from "./ids";
import type {
  ChatState,
  PagingReader,
  PersonReach,
  SafetyHandOffKind,
  StoredClock,
  StoredHandOff,
  StoredPage,
  StoredReviewItem,
  StoredRow,
  StoredSafetyRead,
  TeamMember,
  TestRoster,
} from "./ports";
import type { PagingWrites } from "./writes";

export const BARBERSHOP = "biz-lees-barbershop";
export const HOME_SERVICES = "biz-lee-home-services";
export const NEW_YORK = "America/New_York";
export const TEAM_1 = "person-rosie-team-1";
export const TEAM_2 = "person-rosie-team-2";
export const SAM = "person-sam";
export const PAT = "person-pat";
export const ALEX = "person-alex";
/** Lee's Barbershop's name as texts show it (K-04 seed-business-head.json's display_name). */
export const BARBERSHOP_NAME = "Lee's Barbershop";

/** The K-02 outcome each safety hand-off kind is read from (K-36 rule 5). */
export const OUTCOME_OF_KIND: Readonly<Record<SafetyHandOffKind, SafetyOutcome>> = {
  crisis_words: "Crisis words",
  emergency: "An emergency",
  threat: "A threat to staff or others",
};

/** One of the frozen contracts' fixtures, a fresh copy, as parsed: each test names the shape it reads it as. */
export function fixture(file: string): unknown {
  return structuredClone(contractJson(file));
}

/** Everything the doubles hold, as the database would after each commit. */
export interface PagingWorld {
  readonly pages: Map<string, StoredPage>;
  readonly handOffs: Map<string, StoredHandOff>;
  readonly reviewItems: Map<string, StoredReviewItem>;
  /** K-34's safety reads by id, as a handOff reads them: business and outcomes, never words. */
  readonly safetyReads: Map<string, StoredSafetyRead>;
  members: TeamMember[];
  readonly chats: Map<string, ChatState>;
  readonly reach: Map<string, PersonReach>;
  readonly owners: Map<string, string>;
  readonly zones: Map<string, string>;
  /** K-04 businesses.display_name by business. */
  readonly names: Map<string, string>;
  readonly clocks: Map<string, StoredClock & { readonly dueAt: string | null }>;
  /**
   * Other rows by `<table>/<id>`, with their versions and businesses: a review's subject and the row a decision writes
   * back to.
   */
  readonly rows: Map<string, StoredRow>;
  /** Every outbox row written, by id, with its recipient handle and send class. */
  readonly outbox: Map<string, { readonly recipientHandleId: string; readonly sendClass: string }>;
}

/**
 * The world the tests start from: Rosie's team of two (each with an open iMessage chat, added before October), Sam the
 * barbershop's owner and Pat whom he named (each with an open chat), the two demo shops in New York's zone (the
 * barbershop's name as texts show it), the rows the review fixtures point at (K-24's tile-repair draft at version 2,
 * K-23's business_setup at 1, both Lee Home Services'), and Alex's safety reads at the barbershop that the hand-off tests
 * name: crisis words (0203, j3-safety-arrival-crisis-rows.json's; 0303) and a threat (0204, page-team.json's hand-off's).
 */
export function pagingWorld(): PagingWorld {
  const chat = (handleId: string): ChatState => ({ handleId, open: true, way: "imessage" });
  const read = (id: string, outcome: SafetyOutcome): [string, StoredSafetyRead] => [
    id,
    { id, businessId: BARBERSHOP, outcomes: [outcome] },
  ];
  return {
    pages: new Map(),
    handOffs: new Map(),
    reviewItems: new Map(),
    safetyReads: new Map([
      read("safety-outcome-alex-0203", "Crisis words"),
      read("safety-outcome-alex-0204", "A threat to staff or others"),
      read("safety-outcome-alex-0303", "Crisis words"),
    ]),
    members: [
      {
        id: "recipient-team-1",
        personId: TEAM_1,
        chatHandleId: "handle-team-1",
        emailHandleId: "handle-team-1-email",
        addedAt: "2026-10-01T12:00:00Z",
        removedAt: null,
      },
      {
        id: "recipient-team-2",
        personId: TEAM_2,
        chatHandleId: "handle-team-2",
        emailHandleId: null,
        addedAt: "2026-10-01T12:00:00Z",
        removedAt: null,
      },
    ],
    chats: new Map([
      ["handle-team-1", chat("handle-team-1")],
      ["handle-team-2", chat("handle-team-2")],
    ]),
    reach: new Map([
      [SAM, { personId: SAM, chats: [chat("handle-sam")], emails: ["handle-sam-email"] }],
      [PAT, { personId: PAT, chats: [chat("handle-pat")], emails: [] }],
    ]),
    owners: new Map([
      [BARBERSHOP, SAM],
      [HOME_SERVICES, SAM],
    ]),
    zones: new Map([
      [BARBERSHOP, NEW_YORK],
      [HOME_SERVICES, NEW_YORK],
    ]),
    names: new Map([[BARBERSHOP, BARBERSHOP_NAME]]),
    clocks: new Map(),
    rows: new Map([
      ["new_work_drafts/draft-lee-tile-repair", { version: 2, businessId: HOME_SERVICES }],
      ["business_setup/biz-lee-home-services", { version: 1, businessId: HOME_SERVICES }],
    ]),
    outbox: new Map(),
  };
}

/** Puts one of Alex's K-34 safety reads in the world, with these outcomes, at the barbershop unless another is named. */
export function seedRead(
  world: PagingWorld,
  id: string,
  outcomes: readonly SafetyOutcome[],
  businessId: string | null = BARBERSHOP,
): void {
  world.safetyReads.set(id, { id, businessId, outcomes });
}

/** The reader over a world: every read as the binding gives it, with nothing scoped away (the scopes are the binding's). */
export function readerOn(world: PagingWorld): PagingReader & { readonly asked: string[] } {
  const asked: string[] = [];
  const read = <T>(what: string, value: T): Promise<T> => {
    asked.push(what);
    return Promise.resolve(structuredClone(value));
  };
  return {
    asked,
    page: (pageId) => read("page", world.pages.get(pageId) ?? null),
    members: () => read("members", world.members),
    chat: (handleId) => read("chat", world.chats.get(handleId) ?? null),
    reachOf: (personId) => read("reachOf", world.reach.get(personId) ?? null),
    handOff: (handOffId) => read("handOff", world.handOffs.get(handOffId) ?? null),
    safetyRead: (outcomeId) => read("safetyRead", world.safetyReads.get(outcomeId) ?? null),
    ownerOf: (businessId) => read("ownerOf", world.owners.get(businessId) ?? null),
    businessZone: (businessId) => read("businessZone", world.zones.get(businessId) ?? null),
    businessName: (businessId) => read("businessName", world.names.get(businessId) ?? null),
    clock: (clockRowId) => {
      const clock = world.clocks.get(clockRowId);
      return read(
        "clock",
        clock === undefined ? null : { id: clock.id, state: clock.state, version: clock.version },
      );
    },
    reviewItem: (reviewItemId) => read("reviewItem", world.reviewItems.get(reviewItemId) ?? null),
    row: (table, rowId) => read("row", world.rows.get(`${table}/${rowId}`) ?? null),
    outboxRowWritten: (rowId) => read("outboxRowWritten", world.outbox.has(rowId)),
  };
}

/** A version mismatch the double's commit refuses, as K-05 would with versionChanged. */
export class StaleRowError extends Error {
  constructor(table: string, rowId: string) {
    super(`version moved: ${table}/${rowId}`);
    this.name = "StaleRowError";
  }
}

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new TypeError("a text column the double needs is not a string");
  return value;
};
const textOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : text(value);

/** Applies one call's writes to the world, as K-05's one commit would: state, clock rows made and cancelled, outbox rows. */
export function applyPagingWrites(world: PagingWorld, writes: PagingWrites): void {
  for (const write of writes.state) {
    if (write.op === "insert") {
      const v = write.values;
      const id = text(v.id);
      if (write.table === "team_pages") {
        if (world.pages.has(id)) throw new Error("team_pages_pkey");
        world.pages.set(id, {
          id,
          reason: text(v.reason) as StoredPage["reason"],
          businessId: textOrNull(v.business_id),
          handOffId: textOrNull(v.hand_off_id),
          harmReportId: textOrNull(v.harm_report_id),
          reviewItemId: textOrNull(v.review_item_id),
          safetyTimerId: textOrNull(v.safety_timer_id),
          turnId: textOrNull(v.turn_id),
          namedPersonId: textOrNull(v.named_person_id),
          summary: text(v.summary),
          openedAt: text(v.opened_at),
          lastPagedAt: text(v.last_paged_at),
          timesPaged: v.times_paged as number,
          repeatMinutes: v.repeat_minutes as 5 | null,
          nextPageClockRowId: textOrNull(v.next_page_clock_row_id),
          state: "open",
          acknowledgedAt: null,
          acknowledgedByPersonId: null,
          acknowledgedVia: null,
          version: 1,
        });
      } else if (write.table === "hand_offs") {
        if (world.handOffs.has(id)) throw new Error("hand_offs_pkey");
        world.handOffs.set(id, {
          id,
          businessId: text(v.business_id),
          kind: text(v.kind) as StoredHandOff["kind"],
          safetyOutcomeId: textOrNull(v.safety_outcome_id),
          turnId: textOrNull(v.turn_id),
          bookingId: textOrNull(v.booking_id),
          aboutPersonId: textOrNull(v.about_person_id),
          toldPersonId: text(v.told_person_id),
          toldAs: text(v.told_as) as StoredHandOff["toldAs"],
          alertOutboxRowId: textOrNull(v.alert_outbox_row_id),
          handedAt: text(v.handed_at),
          escalateAt: text(v.escalate_at),
          escalationClockRowId: textOrNull(v.escalation_clock_row_id),
          answeredAt: null,
          answeredVia: null,
          answeredByPersonId: null,
          escalatedAt: textOrNull(v.escalated_at),
          version: 1,
        });
      } else if (write.table === "review_items") {
        if (world.reviewItems.has(id)) throw new Error("review_items_pkey");
        world.reviewItems.set(id, {
          id,
          kind: text(v.kind) as StoredReviewItem["kind"],
          businessId: textOrNull(v.business_id),
          subjectTable: textOrNull(v.subject_table),
          subjectRowId: textOrNull(v.subject_row_id),
          turnId: textOrNull(v.turn_id),
          raisedByPersonId: textOrNull(v.raised_by_person_id),
          openedAt: text(v.opened_at),
          dueAt: text(v.due_at),
          state: "open",
          waitUntil: null,
          decidedAt: null,
          decidedByPersonId: null,
          outcome: null,
          version: 1,
        });
      } else {
        throw new Error(`the double has no table ${write.table}`);
      }
    } else {
      const id = text(Object.values(write.key)[0]);
      const set = write.set;
      if (write.table === "team_pages") {
        const page = world.pages.get(id);
        if (page?.version !== write.expectVersion) throw new StaleRowError(write.table, id);
        world.pages.set(id, {
          ...page,
          ...("last_paged_at" in set ? { lastPagedAt: text(set.last_paged_at) } : {}),
          ...("times_paged" in set ? { timesPaged: set.times_paged as number } : {}),
          ...("next_page_clock_row_id" in set
            ? { nextPageClockRowId: textOrNull(set.next_page_clock_row_id) }
            : {}),
          ...("state" in set ? { state: text(set.state) as StoredPage["state"] } : {}),
          ...("acknowledged_at" in set ? { acknowledgedAt: text(set.acknowledged_at) } : {}),
          ...("acknowledged_by_person_id" in set
            ? { acknowledgedByPersonId: text(set.acknowledged_by_person_id) }
            : {}),
          ...("acknowledged_via" in set
            ? { acknowledgedVia: text(set.acknowledged_via) as StoredPage["acknowledgedVia"] }
            : {}),
          version: page.version + 1,
        });
      } else if (write.table === "hand_offs") {
        const handOff = world.handOffs.get(id);
        if (handOff?.version !== write.expectVersion) throw new StaleRowError(write.table, id);
        world.handOffs.set(id, {
          ...handOff,
          ...("escalated_at" in set ? { escalatedAt: text(set.escalated_at) } : {}),
          ...("answered_at" in set ? { answeredAt: text(set.answered_at) } : {}),
          ...("answered_via" in set
            ? { answeredVia: text(set.answered_via) as StoredHandOff["answeredVia"] }
            : {}),
          ...("answered_by_person_id" in set ? { answeredByPersonId: text(set.answered_by_person_id) } : {}),
          version: handOff.version + 1,
        });
      } else if (write.table === "review_items") {
        const item = world.reviewItems.get(id);
        if (item?.version !== write.expectVersion) throw new StaleRowError(write.table, id);
        world.reviewItems.set(id, {
          ...item,
          state: text(set.state) as StoredReviewItem["state"],
          ...("wait_until" in set ? { waitUntil: text(set.wait_until) } : {}),
          ...("decided_at" in set ? { decidedAt: text(set.decided_at) } : {}),
          ...("decided_by_person_id" in set ? { decidedByPersonId: text(set.decided_by_person_id) } : {}),
          ...("outcome" in set ? { outcome: text(set.outcome) } : {}),
          version: item.version + 1,
        });
      } else {
        const name = `${write.table}/${id}`;
        const row = world.rows.get(name);
        if (row?.version !== write.expectVersion) throw new StaleRowError(write.table, id);
        world.rows.set(name, { ...row, version: row.version + 1 });
      }
    }
  }
  for (const cancel of writes.clockCancels) {
    const clock = world.clocks.get(cancel.id);
    if (clock?.version !== cancel.expectVersion) throw new StaleRowError("clock_rows", cancel.id);
    world.clocks.set(cancel.id, { ...clock, state: "cancelled", version: clock.version + 1 });
  }
  for (const made of writes.clocks) {
    const id = text(made.id);
    if (world.clocks.has(id)) throw new Error("clock_rows_pkey");
    const due = made.due as { dueAt: string } | undefined;
    world.clocks.set(id, {
      id,
      state: due === undefined ? "waiting" : "armed",
      version: 1,
      dueAt: due?.dueAt ?? null,
    });
  }
  for (const row of writes.messages) {
    if (world.outbox.has(row.id)) throw new Error("outbox_rows_pkey");
    world.outbox.set(row.id, { recipientHandleId: row.recipientHandleId, sendClass: row.sendClass });
  }
}

/** A clock row fired, as K-05's fireClock moves it (fired once). */
export function fired(world: PagingWorld, clockRowId: string): void {
  const clock = world.clocks.get(clockRowId);
  if (clock?.state !== "armed") throw new Error(`clock ${clockRowId} is not armed`);
  world.clocks.set(clockRowId, { ...clock, state: "fired", version: clock.version + 1 });
}

/** A staging roster that lists these handles as its test phones, and records each handle asked about. */
export function rosterOf(handles: readonly string[]): TestRoster & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isTestPhone(handleId) {
      asked.push(handleId);
      return Promise.resolve(handles.includes(handleId));
    },
  };
}

/** The ids a K-09 fixture names, by `<row>|<key>|<part>`; any other row takes the Worker's keyed id. */
export function fixturePagingIds(named: Readonly<Record<string, string>>): PagingIds {
  return {
    rowId(row: PagingRow, key: string, part?: string) {
      const id = named[`${row}|${key}|${part ?? ""}`];
      return id === undefined ? KEYED_PAGING_IDS.rowId(row, key, part) : Promise.resolve(id);
    },
  };
}
