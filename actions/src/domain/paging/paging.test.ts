// T-319's proofs (the card's "Proves it with"), on the frozen contracts' fixtures (K-09 v1 page-team.json, review-item.json,
// new-work-approved.json, control-team-review.json and control-team-decided.json; K-09 v1.10
// j3-safety-arrival-crisis-rows.json and j3-safety-arrival-threat-repeat.json; K-36 v1's and K-37 v1's tables), through an
// in-memory world and K-09's own validator, never a database:
//   - page-team.json opens a page and a clock row due in 5 minutes;
//   - firing it re-pages;
//   - an acknowledgement cancels the clock;
//   - on ENVIRONMENT=staging every page recipient resolves to the test console or a test phone (Q-18; build prompt 9.4);
//   - a hand-off unanswered by the owner for 2 days opens a team review item (its escalation clock opens the team's page,
//     which waits in the team console: K-36 v1, K-09 v1 handOff);
//   - a review item opened and decided as K-37 says.
// And around them: the telling port's rows for a crisis record and a threat's repeat (K-09 v1.10 defaults 174 to 176),
// each refusal K-09 lists, the defaults that fail closed, and no number, address or person's words in anything written.
// Round 2 (DL-930): a crisis-words hand-off's summary is A3-25's line alone (telling.ts default 25), and a decision
// writes back only to a row of the call's business (review.ts default 29).

import { describe, expect, it } from "vitest";

import type { CommitTurnContext, CoreAction } from "../../commit";
import { NotBuiltError, createToolApiValidator, type CallName, type CallPart } from "../../tool-api";
import { NO_ALONE_COMMIT, type AloneCommit, type AloneCommitRequest } from "../flags";
import type { TellRequest } from "../safety";
import { PagingRefusedError } from "./errors";
import {
  escalationRequest,
  planAnswerHandOff,
  planHandOff,
  type AnswerHandOffRequest,
  type HandOffRequest,
} from "./hand-off";
import {
  acknowledgePageAlone,
  decideReviewItemAlone,
  handOffAlone,
  openReviewItemCore,
  pageTeamAlone,
  pageTeamCore,
  pagingPortsOf,
} from "./handlers";
import { KEYED_PAGING_IDS } from "./ids";
import {
  planAcknowledgePage,
  planPageTeam,
  repeatPageRequest,
  type AcknowledgePageRequest,
  type PageTeamRequest,
  type PageTeamResponse,
  type PagingPorts,
} from "./page";
import { NO_TEST_PHONES, noPagingReads, type TestRoster } from "./ports";
import {
  dueAtOf,
  planDecideReviewItem,
  planOpenReviewItem,
  reviewKeyOf,
  type DecideReviewItemRequest,
  type OpenReviewItemRequest,
} from "./review";
import { createPagingTelling } from "./telling";
import {
  ALEX,
  BARBERSHOP,
  HOME_SERVICES,
  NEW_YORK,
  PAT,
  SAM,
  TEAM_1,
  TEAM_2,
  applyPagingWrites,
  fired,
  fixture,
  fixturePagingIds,
  pagingWorld,
  readerOn,
  rosterOf,
  type PagingWorld,
} from "./test-support";
import type { PagingWrites } from "./writes";

const validator = createToolApiValidator();

/** Each K-09 v1 answer and request a test makes is held to the frozen schema, as the Tool API base holds it. */
function valid(call: CallName, part: CallPart, value: unknown): void {
  expect(validator.check(call, part, value)).toEqual([]);
}

/** A value the test needs present. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
}

interface Exchange<Request, Outcome> {
  readonly given: { readonly now: string };
  readonly request: Request;
  readonly outcome: Outcome;
}

/** The ids K-09's page-team.json names. */
const PAGE_TEAM_IDS = {
  "page|hand_off:handoff-alex-threat|": "page-alex-threat",
  "pageRow|page-alex-threat|1/person-rosie-team-1": "out-page-alex-threat-team-1",
  "pageRow|page-alex-threat|1/person-rosie-team-2": "out-page-alex-threat-team-2",
  "pageRow|page-alex-threat|1/person-pat": "out-page-alex-threat-pat",
  "pageClock|page-alex-threat|2": "clock-page-alex-threat-2",
};

function portsOf(
  world: PagingWorld,
  options: { environment?: string; roster?: TestRoster; ids?: Readonly<Record<string, string>> } = {},
): PagingPorts {
  return {
    reader: readerOn(world),
    ids: fixturePagingIds(options.ids ?? {}),
    recipients: {
      environment: options.environment ?? "production",
      roster: options.roster ?? NO_TEST_PHONES,
    },
  };
}

/**
 * Alex's threat hand-off at Lee's Barbershop (K-09 safety-outcome-hold.json told Sam through it), handed at 14:42:00Z so
 * its 5 minutes end at page-team.json's now (the fixtures' times are examples; K-36 hand_offs_escalated_when_due holds the
 * page to escalate_at), its escalation clock row armed and its alert to Sam written.
 */
function seedThreatHandOff(world: PagingWorld): void {
  world.handOffs.set("handoff-alex-threat", {
    id: "handoff-alex-threat",
    businessId: BARBERSHOP,
    kind: "threat",
    safetyOutcomeId: "safety-outcome-alex-0204",
    turnId: "turn-alex-threat",
    bookingId: "booking-alex-riley-nov14",
    aboutPersonId: ALEX,
    toldPersonId: SAM,
    toldAs: "owner",
    alertOutboxRowId: "out-alert-handoff-alex-threat",
    handedAt: "2026-10-23T14:42:00Z",
    escalateAt: "2026-10-23T14:47:00Z",
    escalationClockRowId: "clock-handoff-alex-threat",
    answeredAt: null,
    answeredVia: null,
    answeredByPersonId: null,
    escalatedAt: null,
    version: 1,
  });
  world.clocks.set("clock-handoff-alex-threat", {
    id: "clock-handoff-alex-threat",
    state: "armed",
    version: 1,
    dueAt: "2026-10-23T14:47:00Z",
  });
  world.outbox.set("out-alert-handoff-alex-threat", { recipientHandleId: "handle-sam", sendClass: "safety" });
}

const pageTeamExchange = (): Exchange<PageTeamRequest, PageTeamResponse> =>
  fixture("tool-api/fixtures/page-team.json") as Exchange<PageTeamRequest, PageTeamResponse>;

type OpenExchange = Exchange<OpenReviewItemRequest, Record<string, unknown>>;
type DecideExchange = Exchange<DecideReviewItemRequest, unknown>;
/** One of K-09 v1's openReviewItem fixtures. */
const openExchange = (file: string): OpenExchange => fixture(`tool-api/fixtures/${file}`) as OpenExchange;
/** One of K-09 v1's decideReviewItem fixtures. */
const decideExchange = (file: string): DecideExchange =>
  fixture(`tool-api/fixtures/${file}`) as DecideExchange;

/** page-team.json's page, planned in a world with the threat's hand-off, under the given environment and roster. */
async function pageTeamPlan(options: { environment?: string; roster?: TestRoster } = {}) {
  const world = pagingWorld();
  seedThreatHandOff(world);
  const exchange = pageTeamExchange();
  const ports = portsOf(world, { ...options, ids: PAGE_TEAM_IDS });
  const plan = await planPageTeam({ request: exchange.request, now: exchange.given.now }, ports);
  return { world, exchange, ports, plan };
}

/** Rows' recipients and classes, as the commit writes them. */
const rowsOf = (writes: PagingWrites) =>
  writes.messages.map((row) => ({ id: row.id, to: row.recipientHandleId, sendClass: row.sendClass }));

/** A hand-off's summary as its commit writes it: in hand_offs, and in its business-scoped hand_off.created entry. */
function summariesOf(writes: Pick<PagingWrites, "state" | "stateEvents">) {
  const insert = writes.state.find((write) => write.op === "insert" && write.table === "hand_offs");
  const entry = writes.stateEvents.find((each) => each.kind === "hand_off.created");
  const entryValues: Record<string, unknown> = entry?.newValues ?? {};
  return {
    row: insert?.op === "insert" ? insert.values.summary : "no hand_offs row",
    entry: entryValues.summary,
    entryBusinessId: entry?.businessId,
  };
}

/** What the owner hears of crisis words, and all they hear (master A3-25; DL-930). */
const URGENT_LINE = "Urgent: a customer may need help";

/** What a crisis-words summary never holds: the topic, the outcome's name, or the read's id (DL-930 item 6). */
function holdsNoCrisisDetail(summary: unknown, outcomeId: string): void {
  const lower = String(summary).toLowerCase();
  for (const word of ["crisis", "suicide", "self-harm", "harm", "crisis words", outcomeId.toLowerCase()]) {
    expect(lower).not.toContain(word);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

describe("page-team.json opens a page and a clock row due in 5 minutes", () => {
  it("answers the fixture's outcome, field for field", async () => {
    const { exchange, plan } = await pageTeamPlan();
    valid("pageTeam", "request", exchange.request);
    expect(plan.answer).toEqual(exchange.outcome);
    valid("pageTeam", "response", plan.answer);
  });

  it("writes the page, one safety row to each member and to Pat, and the next page's clock row due 5 minutes on", async () => {
    const { plan } = await pageTeamPlan();
    const { writes } = plan;
    expect(writes.state[0]).toEqual({
      op: "insert",
      table: "team_pages",
      values: {
        id: "page-alex-threat",
        reason: "hand_off",
        business_id: BARBERSHOP,
        hand_off_id: "handoff-alex-threat",
        harm_report_id: null,
        review_item_id: null,
        safety_timer_id: null,
        turn_id: null,
        named_person_id: PAT,
        summary: "Hand-off handoff-alex-threat, a threat to staff, unanswered after 5 minutes.",
        opened_at: "2026-10-23T14:47:00Z",
        last_paged_at: "2026-10-23T14:47:00Z",
        times_paged: 1,
        repeat_minutes: 5,
        next_page_clock_row_id: "clock-page-alex-threat-2",
        state: "open",
      },
    });
    expect(rowsOf(writes)).toEqual([
      { id: "out-page-alex-threat-team-1", to: "handle-team-1", sendClass: "safety" },
      { id: "out-page-alex-threat-team-2", to: "handle-team-2", sendClass: "safety" },
      { id: "out-page-alex-threat-pat", to: "handle-pat", sendClass: "safety" },
    ]);
    // Written under the record's business, so K-05 v1.16's read sees them (K-05 open gap 78).
    expect(writes.messages.every((row) => row.businessId === BARBERSHOP)).toBe(true);
    expect(writes.clocks).toEqual([
      {
        id: "clock-page-alex-threat-2",
        kind: "job",
        openQuestionId: null,
        reservationId: null,
        handleId: null,
        businessId: BARBERSHOP,
        bookingId: null,
        fires: { job: "team-page", page: "page-alex-threat" },
        due: { dueAt: "2026-10-23T14:52:00Z", dueZone: NEW_YORK },
      },
    ]);
  });

  it("sets the hand-off's escalated_at in the same commit, with the team-only page entry carrying no business", async () => {
    const { plan } = await pageTeamPlan();
    expect(plan.writes.state[1]).toEqual({
      op: "update",
      table: "hand_offs",
      key: { id: "handoff-alex-threat" },
      expectVersion: 1,
      set: { escalated_at: "2026-10-23T14:47:00Z" },
    });
    expect(plan.writes.stateEvents.map((entry) => [entry.kind, entry.businessId, entry.why])).toEqual([
      ["team_page.opened", null, { step: "A3-22" }],
      ["hand_off.escalated", BARBERSHOP, { step: "A3-22" }],
    ]);
  });

  it("answers the first page again, writing nothing, when the same escalation is fired again", async () => {
    const { world, exchange, ports, plan } = await pageTeamPlan();
    applyPagingWrites(world, plan.writes);
    const again = await planPageTeam({ request: exchange.request, now: "2026-10-23T14:47:30Z" }, ports);
    expect(again.answer).toEqual({ ...exchange.outcome, repeated: true });
    expect(again.writes.state).toEqual([]);
    expect(again.writes.messages).toEqual([]);
  });

  it("answers noRecipients, writing nothing, when no member is on the list", async () => {
    const world = pagingWorld();
    seedThreatHandOff(world);
    world.members = [];
    const exchange = pageTeamExchange();
    const plan = await planPageTeam({ request: exchange.request, now: exchange.given.now }, portsOf(world));
    expect(plan.answer).toEqual({ error: "noRecipients" });
    valid("pageTeam", "errors", plan.answer);
    expect(plan.writes.state).toEqual([]);
  });

  it("answers pointerMissing for a reason that points at a row and names none", async () => {
    const world = pagingWorld();
    const exchange = pageTeamExchange();
    const plan = await planPageTeam(
      { request: { ...exchange.request, pointerId: null }, now: exchange.given.now },
      portsOf(world),
    );
    expect(plan.answer).toEqual({ error: "pointerMissing", reason: "hand_off" });
    valid("pageTeam", "errors", plan.answer);
  });

  it("refuses a page before its hand-off's escalate_at (K-36 hand_offs_escalated_when_due)", async () => {
    const world = pagingWorld();
    seedThreatHandOff(world);
    const exchange = pageTeamExchange();
    await expect(
      planPageTeam({ request: exchange.request, now: "2026-10-23T14:46:59Z" }, portsOf(world)),
    ).rejects.toThrow(PagingRefusedError);
  });
});

describe("firing the page's clock row re-pages", () => {
  async function firstPage() {
    const setup = await pageTeamPlan();
    applyPagingWrites(setup.world, setup.plan.writes);
    fired(setup.world, "clock-page-alex-threat-2");
    return setup;
  }

  it("pages every member and Pat again with new rows, and arms the next page's clock row 5 minutes on", async () => {
    const { world, ports } = await firstPage();
    const page = world.pages.get("page-alex-threat");
    if (page === undefined) throw new Error("no page");
    const request = repeatPageRequest({
      page,
      clockRowId: "clock-page-alex-threat-2",
      traceId: "trace-clock-0102",
    });
    valid("pageTeam", "request", request);
    const plan = await planPageTeam({ request, now: "2026-10-23T14:52:00Z" }, ports);
    valid("pageTeam", "response", plan.answer);

    const second = await Promise.all(
      [TEAM_1, TEAM_2, PAT].map((person) =>
        KEYED_PAGING_IDS.rowId("pageRow", "page-alex-threat", `2/${person}`),
      ),
    );
    const third = await KEYED_PAGING_IDS.rowId("pageClock", "page-alex-threat", "3");
    expect(plan.answer).toEqual({
      pageId: "page-alex-threat",
      timesPaged: 2,
      outboxRowIds: second,
      nextPageClockRowId: third,
      repeated: false,
    });
    expect(rowsOf(plan.writes).map((row) => [row.to, row.sendClass])).toEqual([
      ["handle-team-1", "safety"],
      ["handle-team-2", "safety"],
      ["handle-pat", "safety"],
    ]);
    expect(plan.writes.state).toEqual([
      {
        op: "update",
        table: "team_pages",
        key: { id: "page-alex-threat" },
        expectVersion: 1,
        set: { last_paged_at: "2026-10-23T14:52:00Z", times_paged: 2, next_page_clock_row_id: third },
      },
    ]);
    expect(plan.writes.clocks.map((clock) => [clock.id, clock.due])).toEqual([
      [third, { dueAt: "2026-10-23T14:57:00Z", dueZone: NEW_YORK }],
    ]);
    expect(plan.writes.stateEvents.map((entry) => entry.kind)).toEqual(["team_page.paged_again"]);

    // The same firing run again (the sweep after the alarm: arch 10 line 540) answers the same page, writing nothing.
    applyPagingWrites(world, plan.writes);
    const again = await planPageTeam({ request, now: "2026-10-23T14:52:20Z" }, ports);
    expect(again.answer).toEqual({ ...plan.answer, repeated: true });
    expect(again.writes.messages).toEqual([]);
  });

  it("keeps paging every 5 minutes until acknowledged: the third page arms the fourth", async () => {
    const { world, ports } = await firstPage();
    const utc = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
    let at = Date.parse("2026-10-23T14:52:00Z");
    let clockRowId = "clock-page-alex-threat-2";
    for (const number of [2, 3, 4]) {
      const page = world.pages.get("page-alex-threat");
      if (page === undefined) throw new Error("no page");
      const plan = await planPageTeam(
        { request: repeatPageRequest({ page, clockRowId, traceId: "trace-clock" }), now: utc(at) },
        ports,
      );
      if ("error" in plan.answer) throw new Error(plan.answer.error);
      expect(plan.answer.timesPaged).toBe(number);
      applyPagingWrites(world, plan.writes);
      clockRowId = plan.answer.nextPageClockRowId ?? "";
      expect(world.clocks.get(clockRowId)?.dueAt).toBe(utc(at + 5 * 60_000));
      fired(world, clockRowId);
      at += 5 * 60_000;
    }
    expect(world.pages.get("page-alex-threat")?.timesPaged).toBe(4);
  });

  it("refuses a clock row that is not the page's own", async () => {
    const { world, ports } = await firstPage();
    const page = world.pages.get("page-alex-threat");
    if (page === undefined) throw new Error("no page");
    const request = repeatPageRequest({ page, clockRowId: "clock-someone-else", traceId: "trace-clock" });
    await expect(planPageTeam({ request, now: "2026-10-23T14:52:00Z" }, ports)).rejects.toThrow(
      PagingRefusedError,
    );
  });
});

describe("an acknowledgement cancels the clock", () => {
  async function pagedTwice() {
    const setup = await pageTeamPlan();
    const { world, ports } = setup;
    applyPagingWrites(world, setup.plan.writes);
    fired(world, "clock-page-alex-threat-2");
    const page = world.pages.get("page-alex-threat");
    if (page === undefined) throw new Error("no page");
    const second = await planPageTeam(
      {
        request: repeatPageRequest({ page, clockRowId: "clock-page-alex-threat-2", traceId: "trace-clock" }),
        now: "2026-10-23T14:52:00Z",
      },
      ports,
    );
    applyPagingWrites(world, second.writes);
    const next = await KEYED_PAGING_IDS.rowId("pageClock", "page-alex-threat", "3");
    return { world, ports, next };
  }

  const ack = (personId: string | null, expectVersion = 2): AcknowledgePageRequest => ({
    caller: {
      kind: "console",
      turnId: null,
      requestId: "req-console-team-0003",
      businessId: BARBERSHOP,
      personId,
      traceId: "trace-console-0003",
    },
    pageId: "page-alex-threat",
    expectVersion,
    via: "console_tap",
  });

  it("closes the page and cancels its armed next-page clock row, so no further page goes", async () => {
    const { world, ports, next } = await pagedTwice();
    valid("acknowledgePage", "request", ack(TEAM_1));
    const plan = await planAcknowledgePage({ request: ack(TEAM_1), now: "2026-10-23T14:53:10Z" }, ports);
    expect(plan.answer).toEqual({
      acknowledgedAt: "2026-10-23T14:53:10Z",
      cancelledClockRowId: next,
      repeated: false,
    });
    valid("acknowledgePage", "response", plan.answer);
    expect(plan.writes.clockCancels).toEqual([{ id: next, expectVersion: 1 }]);
    expect(plan.writes.state).toEqual([
      {
        op: "update",
        table: "team_pages",
        key: { id: "page-alex-threat" },
        expectVersion: 2,
        set: {
          state: "acknowledged",
          acknowledged_at: "2026-10-23T14:53:10Z",
          acknowledged_by_person_id: TEAM_1,
          acknowledged_via: "console_tap",
        },
      },
    ]);
    const [entry] = plan.writes.stateEvents;
    expect([entry?.kind, entry?.businessId, entry?.actorKind, entry?.actorPersonId]).toEqual([
      "team_page.acknowledged",
      null,
      "person",
      TEAM_1,
    ]);

    applyPagingWrites(world, plan.writes);
    expect(world.clocks.get(next)?.state).toBe("cancelled");
    // A late firing of the page's clock finds the page closed and sends nothing.
    const page = world.pages.get("page-alex-threat");
    if (page === undefined) throw new Error("no page");
    const late = await planPageTeam(
      {
        request: repeatPageRequest({ page, clockRowId: next, traceId: "trace-clock" }),
        now: "2026-10-23T14:57:00Z",
      },
      ports,
    );
    expect(late.answer).toEqual({ error: "pageClosed", pageId: "page-alex-threat" });
    expect(late.writes.messages).toEqual([]);
    // The same acknowledgement again answers repeated.
    const again = await planAcknowledgePage({ request: ack(TEAM_1, 3), now: "2026-10-23T14:54:00Z" }, ports);
    expect(again.answer).toEqual({
      acknowledgedAt: "2026-10-23T14:53:10Z",
      cancelledClockRowId: null,
      repeated: true,
    });
  });

  it("takes Pat's reply too, the person named; refuses anyone else, an old version and an unknown page", async () => {
    const { ports } = await pagedTwice();
    const pat = await planAcknowledgePage(
      { request: { ...ack(PAT), via: "reply" }, now: "2026-10-23T14:53:00Z" },
      ports,
    );
    expect("error" in pat.answer).toBe(false);

    const alex = await planAcknowledgePage({ request: ack(ALEX), now: "2026-10-23T14:53:00Z" }, ports);
    expect(alex.answer).toEqual({ error: "notPaged", pageId: "page-alex-threat" });
    const stale = await planAcknowledgePage({ request: ack(TEAM_1, 1), now: "2026-10-23T14:53:00Z" }, ports);
    expect(stale.answer).toEqual({
      error: "versionChanged",
      changed: [{ table: "team_pages", rowId: "page-alex-threat", readVersion: 1, currentVersion: 2 }],
    });
    const none = await planAcknowledgePage(
      { request: { ...ack(TEAM_1), pageId: "page-nobody" }, now: "2026-10-23T14:53:00Z" },
      ports,
    );
    expect(none.answer).toEqual({ error: "notFound", table: "team_pages", rowId: "page-nobody" });
    for (const each of [alex, stale, none]) {
      valid("acknowledgePage", "errors", each.answer);
      expect(each.writes.state).toEqual([]);
      expect(each.writes.clockCancels).toEqual([]);
    }
  });
});

describe("on ENVIRONMENT=staging every page recipient resolves to the test console or a test phone", () => {
  it("writes rows to roster test phones alone; every other member and the person named wait in the test console", async () => {
    const roster = rosterOf(["handle-team-1"]);
    const { plan } = await pageTeamPlan({ environment: "staging", roster });
    expect(rowsOf(plan.writes).map((row) => row.to)).toEqual(["handle-team-1"]);
    if ("error" in plan.answer) throw new Error(plan.answer.error);
    expect(plan.answer.outboxRowIds).toEqual(["out-page-alex-threat-team-1"]);
    // The page itself still opens, with its repeat: the test console lists it.
    expect(plan.writes.state[0]?.table).toBe("team_pages");
    expect(plan.writes.clocks).toHaveLength(1);
    expect(roster.asked).toEqual(["handle-team-1", "handle-team-2", "handle-pat"]);
  });

  it("with no roster bound, writes no row at all: everything waits in the test console", async () => {
    const { plan } = await pageTeamPlan({ environment: "staging" });
    expect(plan.writes.messages).toEqual([]);
    expect(plan.answer).toMatchObject({ pageId: "page-alex-threat", outboxRowIds: [], timesPaged: 1 });
  });

  it("treats any ENVIRONMENT but exactly production as staging (fail closed)", async () => {
    for (const environment of ["", "preview", "Staging", "PRODUCTION", "production "]) {
      const { plan } = await pageTeamPlan({ environment, roster: rosterOf(["handle-team-2"]) });
      expect(rowsOf(plan.writes).map((row) => row.to)).toEqual(["handle-team-2"]);
    }
    const { plan } = await pageTeamPlan({ environment: "production" });
    expect(plan.writes.messages).toHaveLength(3);
  });

  it("never pages an email address on staging: a member with no open chat waits in the console", async () => {
    const world = pagingWorld();
    seedThreatHandOff(world);
    world.chats.set("handle-team-1", { handleId: "handle-team-1", open: false, way: "imessage" });
    const exchange = pageTeamExchange();
    const roster = rosterOf(["handle-team-1", "handle-team-1-email", "handle-team-2"]);
    const staging = await planPageTeam(
      { request: exchange.request, now: exchange.given.now },
      portsOf(world, { environment: "staging", roster }),
    );
    expect(rowsOf(staging.writes).map((row) => row.to)).toEqual(["handle-team-2"]);
    // In production the same member is paged by email (QUESTIONS.md M3-M3b.5: "else by email").
    const production = await planPageTeam(
      { request: exchange.request, now: exchange.given.now },
      portsOf(world, { environment: "production" }),
    );
    expect(production.writes.messages.map((row) => [row.recipientHandleId, row.channel])).toEqual([
      ["handle-team-1-email", "email"],
      ["handle-team-2", "imessage"],
      ["handle-pat", "imessage"],
    ]);
  });

  it("holds the repeat page, the owner's alert and the crisis record's page to the roster as well", async () => {
    const roster = rosterOf(["handle-team-2"]);
    const { world, plan } = await pageTeamPlan({ environment: "staging", roster });
    applyPagingWrites(world, plan.writes);
    fired(world, "clock-page-alex-threat-2");
    const ports = portsOf(world, { environment: "staging", roster, ids: PAGE_TEAM_IDS });
    const page = world.pages.get("page-alex-threat");
    if (page === undefined) throw new Error("no page");
    const repeat = await planPageTeam(
      {
        request: repeatPageRequest({ page, clockRowId: "clock-page-alex-threat-2", traceId: "trace-clock" }),
        now: "2026-10-23T14:52:00Z",
      },
      ports,
    );
    expect(rowsOf(repeat.writes).map((row) => row.to)).toEqual(["handle-team-2"]);

    // A crisis record told on staging: Sam is not a test phone, so his alert waits on the console; the team's page goes
    // to the roster's phone alone.
    const telling = createPagingTelling(ports);
    const told = await telling.tell(crisisTell());
    expect(told.writes.messages.map((row) => row.recipientHandleId)).toEqual(["handle-team-2"]);
    const handOff = told.writes.state.find((write) => write.op === "insert" && write.table === "hand_offs");
    expect(handOff?.op === "insert" ? handOff.values.alert_outbox_row_id : "missing").toBeNull();
  });
});

describe("a hand-off unanswered by the owner for 2 days opens a team review item", () => {
  const handOffRequest = (kind: HandOffRequest["kind"]): HandOffRequest => ({
    caller: {
      kind: "turn",
      turnId: "turn-alex-0301",
      requestId: "turn-alex-0301",
      businessId: BARBERSHOP,
      personId: ALEX,
      traceId: "trace-alex-0301",
    },
    kind,
    about: "other",
    safetyOutcomeId: kind === "other" ? null : "safety-outcome-alex-0301",
    bookingId: null,
    aboutPersonId: ALEX,
    summary: "Alex asked for a person about a refund.",
  });
  const handedAt = "2026-10-26T15:00:00Z";

  async function handedOff(world: PagingWorld, kind: HandOffRequest["kind"]) {
    const ports = portsOf(world);
    const request = handOffRequest(kind);
    valid("handOff", "request", request);
    const plan = await planHandOff({ request, businessId: BARBERSHOP, now: handedAt }, ports);
    valid("handOff", "response", plan.answer);
    applyPagingWrites(world, plan.writes);
    return { ports, plan };
  }

  it("tells the owner in text hours, arms the escalation 2 days on, and at 2 days with no answer opens the team's page", async () => {
    const world = pagingWorld();
    const { ports, plan } = await handedOff(world, "other");
    if ("error" in plan.answer) throw new Error(plan.answer.error);
    const { escalationClockRowId } = plan.answer;
    const handOffId = must(plan.answer.handOffId);
    expect(plan.answer).toMatchObject({
      escalateAt: "2026-10-28T15:00:00Z",
      teamPageId: null,
      harmReportId: null,
      repeated: false,
    });
    // The owner's alert: routine (held for his text hours: K-09 v1.10 default 176), to his own open chat.
    expect(rowsOf(plan.writes).map((row) => [row.to, row.sendClass])).toEqual([["handle-sam", "routine"]]);
    expect(plan.writes.clocks.map((clock) => [clock.kind, clock.fires, clock.due])).toEqual([
      [
        "job",
        { job: "hand-off-escalation", handOff: handOffId },
        { dueAt: "2026-10-28T15:00:00Z", dueZone: NEW_YORK },
      ],
    ]);

    // Two days on, nobody answered: the escalation clock row fires.
    if (escalationClockRowId === null) throw new Error("no escalation clock");
    fired(world, escalationClockRowId);
    const handOff = world.handOffs.get(handOffId);
    if (handOff === undefined) throw new Error("no hand-off");
    const request = escalationRequest({
      handOff,
      clockRowId: escalationClockRowId,
      traceId: "trace-clock-0201",
      namedPersonId: PAT,
    });
    if (request === null) throw new Error("no escalation");
    valid("pageTeam", "request", request);
    expect(request).toMatchObject({
      reason: "hand_off",
      pointerId: handOffId,
      namedPersonId: null,
      repeating: false,
    });
    const page = await planPageTeam({ request, now: "2026-10-28T15:00:00Z" }, ports);
    valid("pageTeam", "response", page.answer);
    if ("error" in page.answer) throw new Error(page.answer.error);
    // Paged once: it waits in the team console for a person on Rosie's team (no next page, no repeat).
    expect(page.answer).toMatchObject({ timesPaged: 1, nextPageClockRowId: null, repeated: false });
    expect(page.writes.state[0]).toMatchObject({
      op: "insert",
      table: "team_pages",
      values: { reason: "hand_off", hand_off_id: handOffId, repeat_minutes: null, state: "open" },
    });
    expect(rowsOf(page.writes).map((row) => [row.to, row.sendClass])).toEqual([
      ["handle-team-1", "routine"],
      ["handle-team-2", "routine"],
    ]);
    expect(page.writes.clocks).toEqual([]);
    applyPagingWrites(world, page.writes);
    expect(world.handOffs.get(handOffId)?.escalatedAt).toBe("2026-10-28T15:00:00Z");
    expect(world.pages.get(page.answer.pageId)?.state).toBe("open");
  });

  it("opens nothing when the owner answered first: his answer cancels the escalation's clock row", async () => {
    const world = pagingWorld();
    const { ports, plan } = await handedOff(world, "other");
    if ("error" in plan.answer) throw new Error(plan.answer.error);
    const { escalationClockRowId } = plan.answer;
    const handOffId = must(plan.answer.handOffId);
    const answer: AnswerHandOffRequest = {
      caller: {
        kind: "page",
        turnId: null,
        requestId: "req-owner-sam-0301",
        businessId: BARBERSHOP,
        personId: SAM,
        traceId: "trace-page-sam-0301",
      },
      handOffId,
      expectVersion: 1,
      via: "console_tap",
    };
    valid("answerHandOff", "request", answer);
    const answered = await planAnswerHandOff({ request: answer, now: "2026-10-27T13:00:00Z" }, ports);
    expect(answered.answer).toEqual({
      answeredAt: "2026-10-27T13:00:00Z",
      cancelledClockRowId: escalationClockRowId,
      repeated: false,
    });
    valid("answerHandOff", "response", answered.answer);
    applyPagingWrites(world, answered.writes);
    if (escalationClockRowId === null) throw new Error("no escalation clock");
    expect(world.clocks.get(escalationClockRowId)?.state).toBe("cancelled");
    const handOff = world.handOffs.get(handOffId);
    if (handOff === undefined) throw new Error("no hand-off");
    expect(
      escalationRequest({ handOff, clockRowId: escalationClockRowId, traceId: "t", namedPersonId: null }),
    ).toBe(null);

    // Only the person told answers; a repeat answers repeated; an old version is refused.
    const again = await planAnswerHandOff(
      { request: { ...answer, expectVersion: 2 }, now: "2026-10-27T14:00:00Z" },
      ports,
    );
    expect(again.answer).toEqual({
      answeredAt: "2026-10-27T13:00:00Z",
      cancelledClockRowId: null,
      repeated: true,
    });
  });

  it("refuses an answer from anyone but the person told, and from an old version", async () => {
    const world = pagingWorld();
    const { ports, plan } = await handedOff(world, "other");
    if ("error" in plan.answer) throw new Error(plan.answer.error);
    const base: AnswerHandOffRequest = {
      caller: {
        kind: "page",
        turnId: null,
        requestId: "req-0302",
        businessId: BARBERSHOP,
        personId: PAT,
        traceId: "trace-0302",
      },
      handOffId: must(plan.answer.handOffId),
      expectVersion: 1,
      via: "reply",
    };
    const pat = await planAnswerHandOff({ request: base, now: "2026-10-27T13:00:00Z" }, ports);
    expect(pat.answer).toEqual({ error: "notTold", handOffId: must(plan.answer.handOffId) });
    const stale = await planAnswerHandOff(
      {
        request: { ...base, caller: { ...base.caller, personId: SAM }, expectVersion: 7 },
        now: "2026-10-27T13:00:00Z",
      },
      ports,
    );
    expect(stale.answer).toMatchObject({ error: "versionChanged" });
    for (const each of [pat, stale]) valid("answerHandOff", "errors", each.answer);
  });

  it("an emergency escalates after 5 minutes, repeating, with whoever the owner named", async () => {
    const world = pagingWorld();
    const { ports, plan } = await handedOff(world, "emergency");
    if ("error" in plan.answer) throw new Error(plan.answer.error);
    expect(plan.answer.escalateAt).toBe("2026-10-26T15:05:00Z");
    expect(rowsOf(plan.writes).map((row) => row.sendClass)).toEqual(["safety"]);
    const handOff = world.handOffs.get(must(plan.answer.handOffId));
    if (handOff === undefined || plan.answer.escalationClockRowId === null) throw new Error("no hand-off");
    const request = escalationRequest({
      handOff,
      clockRowId: plan.answer.escalationClockRowId,
      traceId: "trace-clock",
      namedPersonId: PAT,
    });
    if (request === null) throw new Error("no escalation");
    const page = await planPageTeam({ request, now: "2026-10-26T15:05:00Z" }, ports);
    if ("error" in page.answer) throw new Error(page.answer.error);
    expect(page.answer.nextPageClockRowId).not.toBeNull();
    expect(rowsOf(page.writes).map((row) => [row.to, row.sendClass])).toEqual([
      ["handle-team-1", "safety"],
      ["handle-team-2", "safety"],
      ["handle-pat", "safety"],
    ]);
  });

  it("crisis words tell the owner and Rosie's team at once: no clock row, the page opened in the same commit", async () => {
    const world = pagingWorld();
    const { plan } = await handedOff(world, "crisis_words");
    if ("error" in plan.answer) throw new Error(plan.answer.error);
    expect(plan.answer.escalateAt).toBe(handedAt);
    expect(plan.answer.escalationClockRowId).toBeNull();
    expect(plan.answer.teamPageId).not.toBeNull();
    expect(plan.writes.state.map((write) => write.table)).toEqual(["hand_offs", "team_pages"]);
    expect(world.handOffs.get(must(plan.answer.handOffId))?.escalatedAt).toBe(handedAt);
  });

  it("answers repeated for the same request, and fails closed for a report about the owner or staff", async () => {
    const world = pagingWorld();
    const { ports, plan } = await handedOff(world, "other");
    const again = await planHandOff(
      { request: handOffRequest("other"), businessId: BARBERSHOP, now: "2026-10-26T15:00:05Z" },
      ports,
    );
    expect(again.answer).toEqual({ ...plan.answer, repeated: true });
    await expect(
      planHandOff(
        {
          request: { ...handOffRequest("other"), about: "ownerOrStaff" },
          businessId: BARBERSHOP,
          now: handedAt,
        },
        ports,
      ),
    ).rejects.toThrow(NotBuiltError);
  });
});

describe("review items are opened and decided as K-37 says", () => {
  const reviewIds = (request: OpenReviewItemRequest, id: string) => ({
    [`reviewItem|${reviewKeyOf(request)}|`]: id,
  });

  it("review-item.json opens S1-03's new-work review, due in 1 business day; new-work-approved.json writes the draft back", async () => {
    const world = pagingWorld();
    const open = openExchange("review-item.json");
    const ports = portsOf(world, { ids: reviewIds(open.request, "review-lee-tile-repair") });
    valid("openReviewItem", "request", open.request);
    const opened = await planOpenReviewItem({ request: open.request, now: open.given.now }, ports);
    expect(opened.answer).toEqual(open.outcome);
    valid("openReviewItem", "response", opened.answer);
    expect(opened.writes.state).toEqual([
      {
        op: "insert",
        table: "review_items",
        values: {
          id: "review-lee-tile-repair",
          kind: "new_work",
          business_id: HOME_SERVICES,
          subject_table: "new_work_drafts",
          subject_row_id: "draft-lee-tile-repair",
          turn_id: null,
          raised_by_person_id: SAM,
          summary: "New work drafted for Lee Home Services: tile repair (S1-03).",
          opened_at: "2026-10-19T14:40:00Z",
          due_at: "2026-10-20T14:40:00Z",
          state: "open",
        },
      },
    ]);
    expect(opened.writes.stateEvents.map((entry) => [entry.kind, entry.businessId, entry.why])).toEqual([
      ["review_item.opened", null, { step: "S1-03" }],
    ]);
    applyPagingWrites(world, opened.writes);
    const again = await planOpenReviewItem({ request: open.request, now: "2026-10-19T14:41:00Z" }, ports);
    expect(again.answer).toEqual({ ...open.outcome, repeated: true });

    const decide = decideExchange("new-work-approved.json");
    valid("decideReviewItem", "request", decide.request);
    const decided = await planDecideReviewItem({ request: decide.request, now: decide.given.now }, ports);
    expect(decided.answer).toEqual(decide.outcome);
    valid("decideReviewItem", "response", decided.answer);
    expect(decided.writes.state).toEqual([
      {
        op: "update",
        table: "review_items",
        key: { id: "review-lee-tile-repair" },
        expectVersion: 1,
        set: {
          state: "done",
          decided_at: "2026-10-20T13:00:00Z",
          decided_by_person_id: TEAM_1,
          outcome: "Tile repair checked against the official rules for that work: approved (S1-03).",
        },
      },
      {
        op: "update",
        table: "new_work_drafts",
        key: { id: "draft-lee-tile-repair" },
        expectVersion: 2,
        set: { state: "approved" },
      },
    ]);
    applyPagingWrites(world, decided.writes);
    // Decided again with the same outcome: repeated, nothing written; with another: alreadyDone.
    const repeat = await planDecideReviewItem(
      { request: decide.request, now: "2026-10-20T13:05:00Z" },
      ports,
    );
    expect(repeat.answer).toEqual({
      state: "done",
      decidedAt: "2026-10-20T13:00:00Z",
      written: [],
      repeated: true,
    });
    const other = await planDecideReviewItem(
      {
        request: {
          ...decide.request,
          decision: {
            state: "done",
            outcome: "Kept offline.",
            writeBack: { table: "new_work_drafts", state: "kept_offline" },
          },
        },
        now: "2026-10-20T13:05:00Z",
      },
      ports,
    );
    expect(other.answer).toEqual({ error: "alreadyDone", reviewItemId: "review-lee-tile-repair" });
  });

  it("control-team-review.json, then control-team-decided.json writes control proven by the team to business_setup", async () => {
    const world = pagingWorld();
    const open = openExchange("control-team-review.json");
    const ports = portsOf(world, { ids: reviewIds(open.request, "review-lee-home-control") });
    const opened = await planOpenReviewItem({ request: open.request, now: open.given.now }, ports);
    // Due 1 business day on, the same local time on Tuesday (time.ts default 4); the fixture's dueAt is an example
    // K-09 says code computes ("As code computes it from the kind"), and K-37's README calls every due time one.
    expect(opened.answer).toEqual({ ...open.outcome, dueAt: "2026-10-20T15:10:00Z" });
    applyPagingWrites(world, opened.writes);

    const decide = decideExchange("control-team-decided.json");
    const decided = await planDecideReviewItem({ request: decide.request, now: decide.given.now }, ports);
    expect(decided.answer).toEqual(decide.outcome);
    expect(decided.writes.state[1]).toEqual({
      op: "update",
      table: "business_setup",
      key: { business_id: HOME_SERVICES },
      expectVersion: 1,
      set: { control_proven_at: "2026-10-20T15:00:00Z", control_proven_via: "team_check" },
    });
  });

  it("refuses a decider not on Rosie's team, a write-back that does not fit the kind, and sets a wait", async () => {
    const world = pagingWorld();
    const open = openExchange("review-item.json");
    const ports = portsOf(world, { ids: reviewIds(open.request, "review-lee-tile-repair") });
    applyPagingWrites(
      world,
      (await planOpenReviewItem({ request: open.request, now: open.given.now }, ports)).writes,
    );
    const decide = decideExchange("new-work-approved.json");

    const sam = await planDecideReviewItem(
      {
        request: { ...decide.request, caller: { ...decide.request.caller, personId: SAM } },
        now: decide.given.now,
      },
      ports,
    );
    expect(sam.answer).toEqual({ error: "notTeam" });
    const wrongBack = await planDecideReviewItem(
      {
        request: {
          ...decide.request,
          decision: {
            state: "done",
            outcome: "Checked.",
            writeBack: { table: "business_setup", controlProven: true },
          },
        },
        now: decide.given.now,
      },
      ports,
    );
    expect(wrongBack.answer).toEqual({ error: "writeBackNotForKind", kind: "new_work" });
    for (const each of [sam, wrongBack]) {
      valid("decideReviewItem", "errors", each.answer);
      expect(each.writes.state).toEqual([]);
    }

    const waiting = await planDecideReviewItem(
      {
        request: { ...decide.request, decision: { state: "waiting", waitUntil: "2026-10-23T13:00:00Z" } },
        now: decide.given.now,
      },
      ports,
    );
    expect(waiting.answer).toEqual({
      state: "waiting",
      decidedAt: null,
      written: [{ table: "review_items", rowId: "review-lee-tile-repair", version: 2 }],
      repeated: false,
    });
    expect(waiting.writes.stateEvents.map((entry) => entry.kind)).toEqual(["review_item.waiting"]);
  });

  it("answers notFound for a subject that is not there", async () => {
    const world = pagingWorld();
    const open = openExchange("review-item.json");
    const request = { ...open.request, subject: { table: "new_work_drafts", rowId: "draft-nowhere" } };
    const plan = await planOpenReviewItem({ request, now: open.given.now }, portsOf(world));
    expect(plan.answer).toEqual({ error: "notFound", table: "new_work_drafts", rowId: "draft-nowhere" });
    valid("openReviewItem", "errors", plan.answer);
  });

  it("refuses deciding new work whose draft is another business's (otherBusiness), with nothing written", async () => {
    const world = pagingWorld();
    const open = openExchange("review-item.json");
    const ids = reviewIds(open.request, "review-lee-tile-repair");
    applyPagingWrites(
      world,
      (await planOpenReviewItem({ request: open.request, now: open.given.now }, portsOf(world, { ids })))
        .writes,
    );
    const decide = decideExchange("new-work-approved.json");
    const committed: AloneCommitRequest[] = [];
    const commitAlone: AloneCommit<null> = {
      commit(request) {
        committed.push(request);
        return Promise.resolve({ committed: true, repeated: false });
      },
    };
    const deps = {
      reader: () => readerOn(world),
      ids: fixturePagingIds(ids),
      now: () => decide.given.now,
      commitAlone,
    };
    const draft = "new_work_drafts/draft-lee-tile-repair";
    // The item and the caller are Lee Home Services'. The draft is Lee's Barbershop's, then of no business; and a
    // console caller with no business is held to the item's.
    const cases = [
      { draftBusiness: BARBERSHOP, callerBusiness: HOME_SERVICES },
      { draftBusiness: null, callerBusiness: HOME_SERVICES },
      { draftBusiness: BARBERSHOP, callerBusiness: null },
    ];
    for (const { draftBusiness, callerBusiness } of cases) {
      world.rows.set(draft, { version: 2, businessId: draftBusiness });
      const request = { ...decide.request, caller: { ...decide.request.caller, businessId: callerBusiness } };
      const refused = await decideReviewItemAlone(request, null, callerBusiness, deps).then(
        () => "answered",
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PagingRefusedError);
      expect(refused).toMatchObject({
        fault: "otherBusiness",
        rowIds: ["review-lee-tile-repair", "draft-lee-tile-repair"],
      });
    }
    // Nothing written: no commit was made, the item is still open at version 1 and the draft still at version 2.
    expect(committed).toEqual([]);
    expect(world.reviewItems.get("review-lee-tile-repair")).toMatchObject({ state: "open", version: 1 });
    expect(world.rows.get(draft)?.version).toBe(2);

    // The draft Lee Home Services' again: the same decision commits once and writes it back.
    world.rows.set(draft, { version: 2, businessId: HOME_SERVICES });
    expect(await decideReviewItemAlone(decide.request, null, HOME_SERVICES, deps)).toEqual(decide.outcome);
    expect(committed).toHaveLength(1);
  });

  it("refuses a control decision that writes back to a setup of another business than the caller's (default 29)", async () => {
    const world = pagingWorld();
    const open = openExchange("control-team-review.json");
    // An item opened about Lee Home Services' setup with no business of its own, decided under Lee's Barbershop.
    const request = { ...open.request, caller: { ...open.request.caller, businessId: null } };
    const ports = portsOf(world, { ids: reviewIds(request, "review-lee-home-control") });
    applyPagingWrites(world, (await planOpenReviewItem({ request, now: open.given.now }, ports)).writes);
    const decide = decideExchange("control-team-decided.json");
    const refused = await planDecideReviewItem(
      {
        request: { ...decide.request, caller: { ...decide.request.caller, businessId: BARBERSHOP } },
        now: decide.given.now,
      },
      ports,
    ).then(
      () => "answered",
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      fault: "otherBusiness",
      rowIds: ["review-lee-home-control", HOME_SERVICES],
    });
    expect(world.rows.get(`business_setup/${HOME_SERVICES}`)?.version).toBe(1);
  });

  it("dues: 1 business day skips the weekend and keeps the local time across a clock change; same-day kinds end at midnight", () => {
    // Friday Oct 30, 10:00 New York (EDT) is due Monday Nov 2, 10:00 New York (EST): one more hour in UTC.
    expect(dueAtOf("control", "2026-10-30T14:00:00Z", NEW_YORK)).toBe("2026-11-02T15:00:00Z");
    // Saturday Oct 24, 12:10 New York, as K-37's booking cap seed: due Monday.
    expect(dueAtOf("booking_cap", "2026-10-24T16:10:00Z", NEW_YORK)).toBe("2026-10-26T16:10:00Z");
    // A harm report at 9:00 on Thursday Oct 22 is due by midnight, as K-37's seed has it.
    expect(dueAtOf("harm_report", "2026-10-22T13:00:00Z", NEW_YORK)).toBe("2026-10-23T04:00:00Z");
    // A missed deadline on Tuesday Nov 3 (EST), as K-37's seed has it.
    expect(dueAtOf("missed_deadline", "2026-11-03T14:00:00Z", NEW_YORK)).toBe("2026-11-04T05:00:00Z");
  });
});

/** j3-safety-arrival-crisis-rows.json's record, as the safety service asks the telling port. */
function crisisTell(): TellRequest {
  return {
    eventId: "evt-alex-0203",
    outcomeId: "safety-outcome-alex-0203",
    outcomes: ["Crisis words"],
    businessId: BARBERSHOP,
    handleId: "handle-alex",
    personId: ALEX,
    bookingId: null,
    turnId: "6e21c94aa9b3a4b46ee177d6caed733ec5c0343ba64f203f27b428ce46427756",
    now: "2026-10-23T14:30:03Z",
    repeated: false,
  };
}

interface SafetyRow {
  readonly outboxRowId: string;
  readonly recipientHandleId: string;
  readonly sendClass: string;
  readonly writtenFor: "line" | "handOff" | "teamPage";
}

/** A K-09 v1.10 recordSafetyOutcome fixture, as these tests read its outcome. */
interface RecordWithRows {
  readonly outcome: { readonly told: unknown[]; readonly safetyRows: SafetyRow[] };
}

describe("the telling port (T-318's SafetyTelling) writes and names its rows as K-09 v1.10 says", () => {
  const CRISIS_IDS = {
    "handOff|outcome:safety-outcome-alex-0203|": "handoff-alex-crisis",
    "alert|handoff-alex-crisis|": "out-alert-handoff-alex-crisis",
    "page|hand_off:handoff-alex-crisis|": "page-alex-crisis",
    "pageRow|page-alex-crisis|1/person-rosie-team-1": "out-page-alex-crisis-team-1",
    "pageRow|page-alex-crisis|1/person-rosie-team-2": "out-page-alex-crisis-team-2",
  };
  const THREAT_IDS = {
    "handOff|outcome:safety-outcome-alex-0204|": "handoff-alex-threat",
    "alert|handoff-alex-threat|": "out-alert-handoff-alex-threat",
  };

  it("crisis words: Sam's alert, then one row to each member, all send class safety, as j3-safety-arrival-crisis-rows.json", async () => {
    const crisis = fixture("tool-api/fixtures/j3-safety-arrival-crisis-rows.json") as RecordWithRows;
    const world = pagingWorld();
    const telling = createPagingTelling(portsOf(world, { ids: CRISIS_IDS }));
    const plan = await telling.tell(crisisTell());
    expect(plan.told).toEqual(crisis.outcome.told);
    const told = crisis.outcome.safetyRows.filter((row) => row.writtenFor !== "line");
    expect(
      plan.writes.messages.map((row) => ({
        outboxRowId: row.id,
        recipientHandleId: row.recipientHandleId,
        sendClass: row.sendClass,
        writtenFor: row.id.startsWith("out-alert-") ? "handOff" : "teamPage",
      })),
    ).toEqual(told);
    expect(plan.rowIds).toEqual(told.map((row) => row.outboxRowId));
    // Under the record's business (K-05 open gap 78), in the record's why, with the hand-off before its page.
    expect(plan.writes.messages.every((row) => row.businessId === BARBERSHOP)).toBe(true);
    expect(plan.writes.why).toEqual({ step: "A3-22", choice: null });
    expect(plan.writes.state.map((write) => write.table)).toEqual(["hand_offs", "team_pages"]);
    expect(plan.writes.clocks).toEqual([]);
  });

  it("a threat's repeat names the first record's hand-off and alert, writing nothing, as j3-safety-arrival-threat-repeat.json", async () => {
    const repeat = fixture("tool-api/fixtures/j3-safety-arrival-threat-repeat.json") as RecordWithRows;
    const world = pagingWorld();
    const telling = createPagingTelling(portsOf(world, { ids: THREAT_IDS }));
    const threat: TellRequest = {
      ...crisisTell(),
      eventId: "evt-alex-0204",
      outcomeId: "safety-outcome-alex-0204",
      outcomes: ["A threat to staff or others"],
      bookingId: "booking-alex-riley-nov14",
      turnId: "6fc1c513c069a30c23e91be4a9ae548433d793acb32cb68db621eb0dfbe20989",
      now: "2026-10-23T14:42:02Z",
    };
    const first = await telling.tell(threat);
    expect(first.writes.clocks).toHaveLength(1);
    applyPagingWrites(world, { ...first.writes, clockCancels: [] });

    const again = await telling.tell({ ...threat, now: "2026-10-23T14:42:32Z", repeated: true });
    expect(again.told).toEqual(repeat.outcome.told);
    expect(again.rowIds).toEqual(
      repeat.outcome.safetyRows.filter((row) => row.writtenFor !== "line").map((row) => row.outboxRowId),
    );
    expect(again.writes.state).toEqual([]);
    expect(again.writes.messages).toEqual([]);
  });

  it("crisis words: the hand-off's summary is A3-25's line alone, in hand_offs and in its hand_off.created entry", async () => {
    const telling = createPagingTelling(portsOf(pagingWorld(), { ids: CRISIS_IDS }));
    const plan = await telling.tell(crisisTell());
    const written = summariesOf(plan.writes);
    expect(written).toEqual({ row: URGENT_LINE, entry: URGENT_LINE, entryBusinessId: BARBERSHOP });
    holdsNoCrisisDetail(written.row, "safety-outcome-alex-0203");
    holdsNoCrisisDetail(written.entry, "safety-outcome-alex-0203");
    // The kind and the read stay in the team's page summary, which no business reads (K-36 rule 2; README rule 4).
    const page = plan.writes.state.find((write) => write.op === "insert" && write.table === "team_pages");
    expect(page?.op === "insert" ? page.values.summary : "no page").toBe(
      "Hand-off handoff-alex-crisis at biz-lees-barbershop: crisis words, read from safety-outcome-alex-0203; " +
        "Rosie's team and the owner are told at once.",
    );
  });

  it("a handOff call for crisis words writes A3-25's line too, whatever summary its caller gave", async () => {
    const request: HandOffRequest = {
      caller: {
        kind: "turn",
        turnId: "turn-alex-0303",
        requestId: "turn-alex-0303",
        businessId: BARBERSHOP,
        personId: ALEX,
        traceId: "trace-alex-0303",
      },
      kind: "crisis_words",
      about: "other",
      safetyOutcomeId: "safety-outcome-alex-0303",
      bookingId: null,
      aboutPersonId: ALEX,
      summary: "A safety read (safety-outcome-alex-0303) found crisis words: self-harm.",
    };
    valid("handOff", "request", request);
    const plan = await planHandOff(
      { request, businessId: BARBERSHOP, now: "2026-10-26T15:00:00Z" },
      portsOf(pagingWorld()),
    );
    const written = summariesOf(plan.writes);
    expect(written).toEqual({ row: URGENT_LINE, entry: URGENT_LINE, entryBusinessId: BARBERSHOP });
    holdsNoCrisisDetail(written.row, "safety-outcome-alex-0303");
    holdsNoCrisisDetail(written.entry, "safety-outcome-alex-0303");
  });

  it("an emergency's and a threat's hand-offs keep their owner lines, unchanged", async () => {
    const cases = [
      ["An emergency", "an emergency"],
      ["A threat to staff or others", "a threat to staff or others"],
    ] as const;
    for (const [outcome, words] of cases) {
      const telling = createPagingTelling(portsOf(pagingWorld()));
      const plan = await telling.tell({
        ...crisisTell(),
        outcomeId: "safety-outcome-alex-0204",
        outcomes: [outcome],
      });
      const line = `A safety read (safety-outcome-alex-0204) found ${words}.`;
      expect(summariesOf(plan.writes)).toEqual({ row: line, entry: line, entryBusinessId: BARBERSHOP });
    }
  });

  it("answers notBuilt for a record with no turn (K-09 v1.10 default 178: its clock turn is not built)", async () => {
    const telling = createPagingTelling(portsOf(pagingWorld()));
    await expect(telling.tell({ ...crisisTell(), turnId: null })).rejects.toThrow(NotBuiltError);
  });
});

describe("the calls fail closed and write no number, address or person's words", () => {
  it("answers notBuilt with no reads bound, and made alone with no commit with no turn", async () => {
    const exchange = pageTeamExchange();
    await expect(
      planPageTeam(
        { request: exchange.request, now: exchange.given.now },
        {
          reader: noPagingReads("pageTeam"),
          ids: KEYED_PAGING_IDS,
          recipients: { environment: "", roster: NO_TEST_PHONES },
        },
      ),
    ).rejects.toThrow(NotBuiltError);

    const world = pagingWorld();
    seedThreatHandOff(world);
    const deps = { reader: () => readerOn(world), environment: "production", now: () => exchange.given.now };
    await expect(
      pageTeamAlone(exchange.request, null, BARBERSHOP, { ...deps, commitAlone: NO_ALONE_COMMIT }),
    ).rejects.toThrow(NotBuiltError);
  });

  it("commits a call made alone once, under its caller's key, with every row's entry", async () => {
    const exchange = pageTeamExchange();
    const world = pagingWorld();
    seedThreatHandOff(world);
    const committed: AloneCommitRequest[] = [];
    const commitAlone: AloneCommit<null> = {
      commit(request) {
        committed.push(request);
        return Promise.resolve({ committed: true, repeated: false });
      },
    };
    const answer = await pageTeamAlone(exchange.request, null, BARBERSHOP, {
      reader: () => readerOn(world),
      environment: "production",
      now: () => exchange.given.now,
      commitAlone,
    });
    expect("error" in answer).toBe(false);
    expect(committed).toHaveLength(1);
    const [request] = committed;
    expect(request?.key).toBe("pageTeam:clock-handoff-alex-threat");
    expect(request?.writes.outboxRows).toHaveLength(3);
    expect(request?.writes.clockRows.make).toHaveLength(1);
    expect(request?.writes.events.map((entry) => entry.kind)).toEqual([
      "team_page.opened",
      "hand_off.escalated",
      "clock_row.created",
      "outbox_row.created",
      "outbox_row.created",
      "outbox_row.created",
    ]);

    // A turn's call never commits alone; a page's console tap does.
    await expect(
      handOffAlone(
        {
          caller: {
            kind: "turn",
            turnId: "t",
            requestId: "t",
            businessId: BARBERSHOP,
            personId: null,
            traceId: "tr",
          },
          kind: "other",
          about: "other",
          safetyOutcomeId: null,
          bookingId: null,
          aboutPersonId: null,
          summary: "s",
        },
        null,
        BARBERSHOP,
        { reader: () => readerOn(world), commitAlone },
      ),
    ).rejects.toThrow(PagingRefusedError);
    const ack = await acknowledgePageAlone(
      {
        caller: {
          kind: "console",
          turnId: null,
          requestId: "r",
          businessId: BARBERSHOP,
          personId: TEAM_1,
          traceId: "tr",
        },
        pageId: "page-none",
        expectVersion: 1,
        via: "console_tap",
      },
      null,
      BARBERSHOP,
      { reader: () => readerOn(world), commitAlone },
    );
    expect(ack).toEqual({ error: "notFound", table: "team_pages", rowId: "page-none" });
  });

  it("rides in a turn's commit as a core action, its clock rows in the unit's own list", async () => {
    const world = pagingWorld();
    seedThreatHandOff(world);
    const exchange = pageTeamExchange();
    const turnId = "turn-team-0001";
    const turn = {
      request: { now: exchange.given.now },
      turn: { id: turnId, traceId: "trace-turn-0001" },
      repo: null,
      businessId: BARBERSHOP,
    } as unknown as CommitTurnContext<null>;
    const caller = {
      ...exchange.request.caller,
      kind: "turn" as const,
      turnId,
      requestId: turnId,
      traceId: "trace-turn-0001",
    };
    const action = { call: "pageTeam", request: { ...exchange.request, caller } } as Extract<
      CoreAction,
      { call: "pageTeam" }
    >;
    const run = await pageTeamCore(action, turn, {
      reader: () => readerOn(world),
      environment: "production",
    });
    expect(run.result).toMatchObject({ call: "pageTeam", error: null, response: { timesPaged: 1 } });
    expect(run.writes.clocks).toHaveLength(1);
    expect(run.writes.messages).toHaveLength(3);
    // A review item in a turn (S1-03's, as T-633 opens it), and a caller that is not the turn's own refused.
    const open = openExchange("review-item.json");
    const review = await openReviewItemCore(
      {
        call: "openReviewItem",
        request: {
          ...open.request,
          caller: {
            ...open.request.caller,
            kind: "turn",
            turnId,
            requestId: turnId,
            traceId: "trace-turn-0001",
            businessId: BARBERSHOP,
          },
        },
      },
      turn,
      { reader: () => readerOn(world) },
    );
    expect(review.result).toMatchObject({ call: "openReviewItem", error: null });
    expect(review.writes.state.map((write) => write.table)).toEqual(["review_items"]);
    await expect(pageTeamCore({ ...action, request: exchange.request }, turn, {})).rejects.toThrow(
      PagingRefusedError,
    );
  });

  it("holds handles' ids alone: no number, no address and no person's words in anything a call writes", async () => {
    const { plan } = await pageTeamPlan();
    const world = pagingWorld();
    const crisis = await createPagingTelling(portsOf(world)).tell(crisisTell());
    const ports = pagingPortsOf({ reader: () => readerOn(pagingWorld()) }, null, "pageTeam");
    expect(ports.recipients.environment).toBe("");
    for (const written of [plan.writes, crisis.writes]) {
      const text = JSON.stringify(written);
      // No number in E.164 or a 555-01xx form, and no email address: every recipient is a handle's id.
      expect(text).not.toMatch(/\+\d{7,15}/u);
      expect(text).not.toMatch(/555-?01\d\d/u);
      expect(text).not.toMatch(/@/u);
      for (const row of written.messages) expect(row.recipientHandleId).toMatch(/^handle-/u);
    }
  });
});
