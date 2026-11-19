// T-1443's proofs for the commit core (the card's "Proves it with", `npm run test:unit -- actions/src/commit/core
// actions/src/domain/paging`): runCore dispatches handOff, answerHandOff, pageTeam, acknowledgePage and openReviewItem to
// T-319's paging service (domain/paging's five core functions) with the paging port the wiring binds, and a safety record
// tells through the paging telling port (telling.ts pagingTellingPort) built on the turn's own repo, never a database:
// T-319's in-memory paging world and its reader (domain/paging/test-support.ts) stand in for the runtime's PagingReader
// (T-1444), T-318's safety world for the record's own reads, and T-305's K-05 fake for the one commit. The doubles stand in
// for ports only, never for runCore, the services or the commit. The card's three lines:
//   - a crisis-words turn with the port given commits, and writes the owner's alert ('Urgent: a customer may need help')
//     and the team's page rows under the record's business;
//   - on staging, every recipient is a roster test phone or the console;
//   - with NOT_TOLD_YET the old answers are unchanged.
// Values come only from the contracts' fixtures and the master's sample cast, every recipient by handle id (rule 9).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import {
  acknowledgePageCore,
  answerHandOffCore,
  handOffCore,
  openReviewItemCore,
  pageTeamCore,
  type PagingDeps,
} from "../../domain/paging";
import {
  ALEX,
  PAT,
  SAM,
  TEAM_1,
  fixture,
  fixturePagingIds,
  pagingWorld,
  readerOn,
  rosterOf,
  type PagingWorld,
} from "../../domain/paging/test-support";
import { contractJson } from "../../domain/messages-consent/test-support";
import {
  NOT_TOLD_YET,
  recordSafetyOutcomeCore,
  tellingOn,
  type SafetyResult,
  type SafetyTelling,
  type TellRequest,
} from "../../domain/safety";
import { BARBERSHOP, safetyWorldOf } from "../../domain/safety/test-support";
import { callContext, copy, scriptedLimits } from "../../gate/framework/test-support";
import { NotBuiltError, createToolApiValidator, type CallName } from "../../tool-api";
import {
  CommitRefusedError,
  gateAndCommit,
  type Committed,
  type CoreAction,
  type CoreRun,
  type GateAndCommitRequest,
  type OpenHolds,
  type OutboxRowNew,
  type StateWrite,
} from "../index";
import { doublePorts, k05Fake, type K05Fake } from "../test-support";
import {
  CoreNotBuiltError,
  createRunCore,
  pagingDepsOf,
  pagingTellingPort,
  rosterOfHandles,
  type CoreDeps,
  type PagingTellingOptions,
} from "./index";
import { bundleV0, coreDoublesOn, s1_01Exchange, turnContextOf, withK05Turn } from "./test-support";

const validator = createToolApiValidator();

const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };

/** What the owner hears of crisis words, and all they hear (master A3-25; K-36 hand_offs.summary; DL-930). */
const URGENT_LINE = "Urgent: a customer may need help";

type Action<C extends CoreAction["call"]> = Extract<CoreAction, { call: C }>;

// ---- a turn of core actions at Lee's Barbershop -------------------------------------------------------------------

const TURN = "turn-t1443-core";
const TRACE = "trace-t1443-core";

/** The turn's own caller, as each of its core actions carries it. */
function turnCaller(personId: string | null): K09.Caller {
  return { kind: "turn", turnId: TURN, requestId: TURN, businessId: BARBERSHOP, personId, traceId: TRACE };
}

/** A core-only turn on `handleId` at the barbershop, bundle v0 pinned, carrying `core` at `now`. */
function turnWith(core: readonly CoreAction[], now: string, handleId = "handle-alex"): GateAndCommitRequest {
  return {
    caller: turnCaller(null),
    turn: {
      id: TURN,
      handleId,
      eventIds: ["evt-t1443-core"],
      bundleId: { ...bundleV0().bundleId },
      traceId: TRACE,
      joinedTraceIds: [],
      tries: 1,
    },
    input: { kind: "coreOnly" },
    core: [...core],
    now,
  };
}

/** One core action as its turn carries it, its request held to K-09 v1's. */
function actionOf<C extends CoreAction["call"]>(call: C, request: object): Action<C> {
  expect(validator.check(call, "request", request), call).toEqual([]);
  return { call, request } as unknown as Action<C>;
}

// ---- the paging world's rows the actions point at -----------------------------------------------------------------

interface PageTeamExchange {
  readonly given: { readonly now: string };
  readonly request: Record<string, unknown> & { readonly caller: K09.Caller };
  readonly outcome: Record<string, unknown>;
}

/** K-09 v1's page-team.json: the team paged for Alex's threat, unanswered after 5 minutes. */
const pageTeamExchange = (): PageTeamExchange =>
  fixture("tool-api/fixtures/page-team.json") as PageTeamExchange;

/** The ids page-team.json names (domain/paging's test of it names the same). */
const PAGE_TEAM_IDS = {
  "page|hand_off:handoff-alex-threat|": "page-alex-threat",
  "pageRow|page-alex-threat|1/person-rosie-team-1": "out-page-alex-threat-team-1",
  "pageRow|page-alex-threat|1/person-rosie-team-2": "out-page-alex-threat-team-2",
  "pageRow|page-alex-threat|1/person-pat": "out-page-alex-threat-pat",
  "pageClock|page-alex-threat|2": "clock-page-alex-threat-2",
};

/**
 * Alex's threat hand-off at Lee's Barbershop, told to Sam at 14:42:00Z, its escalation clock row armed and its alert to Sam
 * written (as domain/paging's test seeds it for page-team.json).
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

/** The team's page for that hand-off, paged once at 14:47:00Z, its next page's clock row armed for 14:52:00Z. */
function seedThreatPage(world: PagingWorld): void {
  world.pages.set("page-alex-threat", {
    id: "page-alex-threat",
    reason: "hand_off",
    businessId: BARBERSHOP,
    handOffId: "handoff-alex-threat",
    harmReportId: null,
    reviewItemId: null,
    safetyTimerId: null,
    turnId: null,
    namedPersonId: PAT,
    summary: "Hand-off handoff-alex-threat, a threat to staff, unanswered after 5 minutes.",
    openedAt: "2026-10-23T14:47:00Z",
    lastPagedAt: "2026-10-23T14:47:00Z",
    timesPaged: 1,
    repeatMinutes: 5,
    nextPageClockRowId: "clock-page-alex-threat-2",
    state: "open",
    acknowledgedAt: null,
    acknowledgedByPersonId: null,
    acknowledgedVia: null,
    version: 1,
  });
  world.clocks.set("clock-page-alex-threat-2", {
    id: "clock-page-alex-threat-2",
    state: "armed",
    version: 1,
    dueAt: "2026-10-23T14:52:00Z",
  });
}

/** The paging port over a world, as the wiring binds it: its reader, page-team.json's ids, production unless named. */
function pagingOn(world: PagingWorld, environment = "production"): PagingDeps<unknown> {
  return { reader: () => readerOn(world), ids: fixturePagingIds(PAGE_TEAM_IDS), environment };
}

/** runCore's deps: T-318's safety doubles (nobody told) and the paging port given. */
function coreWithPaging(paging: PagingDeps<unknown> | undefined): CoreDeps<unknown> {
  const { deps } = coreDoublesOn(safetyWorldOf(), { telling: NOT_TOLD_YET });
  return paging === undefined ? deps : { ...deps, paging };
}

/** One paging core action at the barbershop: the action, its turn's moment, and the world it points into. */
interface PagingCase {
  readonly action: CoreAction;
  readonly now: string;
  readonly world: PagingWorld;
}

/** A world with Alex's threat hand-off told to Sam (and, when asked, the team's page for it). */
function threatWorld(withPage = false): PagingWorld {
  const world = pagingWorld();
  seedThreatHandOff(world);
  if (withPage) seedThreatPage(world);
  return world;
}

/** The five paging core actions at the barbershop, in K-09 v1's coreAction order of the paging calls. */
function pagingCases(): readonly PagingCase[] {
  const page = pageTeamExchange();
  const review = fixture("tool-api/fixtures/review-item.json") as {
    given: { now: string };
    request: Record<string, unknown> & { caller: K09.Caller };
  };
  return [
    // page-team.json's page for the threat, as a core action of a turn (a passed-on reply's page, say).
    {
      action: actionOf("pageTeam", { ...page.request, caller: turnCaller(null) }),
      now: page.given.now,
      world: threatWorld(),
    },
    // The planner's hand-off of Alex's crisis words (K-36 rule 5: the read's own kind).
    {
      action: actionOf("handOff", {
        caller: turnCaller(ALEX),
        kind: "crisis_words",
        about: "other",
        safetyOutcomeId: "safety-outcome-alex-0303",
        bookingId: null,
        aboutPersonId: ALEX,
        summary: "Alex's text was read.",
      }),
      now: "2026-10-26T15:00:00Z",
      world: pagingWorld(),
    },
    // Sam's reply to the threat's hand-off, before its 5 minutes are up.
    {
      action: actionOf("answerHandOff", {
        caller: turnCaller(SAM),
        handOffId: "handoff-alex-threat",
        expectVersion: 1,
        via: "reply",
      }),
      now: "2026-10-23T14:45:00Z",
      world: threatWorld(),
    },
    // Member 1's reply to the team's page.
    {
      action: actionOf("acknowledgePage", {
        caller: turnCaller(TEAM_1),
        pageId: "page-alex-threat",
        expectVersion: 1,
        via: "reply",
      }),
      now: "2026-10-23T14:49:00Z",
      world: threatWorld(true),
    },
    // review-item.json's item, opened in a turn (S1-03's, as T-633 opens it).
    {
      action: actionOf("openReviewItem", {
        ...review.request,
        caller: turnCaller(review.request.caller.personId),
      }),
      now: review.given.now,
      world: pagingWorld(),
    },
  ];
}

/** The paging service's own run of a core action, as its *Core function gives it with this port. */
function serviceRun(
  action: CoreAction,
  request: GateAndCommitRequest,
  paging: PagingDeps<unknown>,
): Promise<CoreRun> {
  const turn = turnContextOf(request);
  switch (action.call) {
    case "pageTeam":
      return pageTeamCore(action, turn, paging);
    case "handOff":
      return handOffCore(action, turn, paging);
    case "answerHandOff":
      return answerHandOffCore(action, turn, paging);
    case "acknowledgePage":
      return acknowledgePageCore(action, turn, paging);
    case "openReviewItem":
      return openReviewItemCore(action, turn, paging);
    default:
      throw new Error(`${action.call} is not a paging core action`);
  }
}

// ---- the one commit -----------------------------------------------------------------------------------------------

/** The one K-05 request a commit sent, as T-305's fake keeps it. */
type Sent = K05Fake["requests"][number];

/** One gateAndCommit through the commit (T-305), runCore as built, limits as passing doubles, K-05 as T-305's fake. */
async function committed(
  request: GateAndCommitRequest,
  deps: CoreDeps<unknown>,
): Promise<{ answer: Committed; sent: Sent }> {
  const k05 = k05Fake();
  const doubles = doublePorts({ k05 });
  const answer = await gateAndCommit(request, callContext(BARBERSHOP), {
    limits: scriptedLimits(),
    ports: { ...doubles.ports, runCore: createRunCore(deps) },
  });
  if ("error" in answer || answer.result !== "committed") {
    throw new Error(`not committed: ${JSON.stringify(answer)}`);
  }
  expect(validator.check("gateAndCommit", "response", answer)).toEqual([]);
  expect(k05.requests).toHaveLength(1);
  const [sent] = k05.requests;
  if (sent === undefined) throw new Error("one commit was sent");
  return { answer, sent };
}

/** The values of the first insert into `table`. */
function insertOf(state: readonly StateWrite[], table: string): Record<string, unknown> {
  const write = state.find((each) => each.op === "insert" && each.table === table);
  if (write?.op !== "insert") throw new Error(`no ${table} insert`);
  return write.values;
}

/** A row as these tests read it: its recipient's handle, its send class and its business. */
const rowView = (row: OutboxRowNew) => ({
  to: row.recipientHandleId,
  sendClass: row.sendClass,
  businessId: row.businessId,
});

let warn: MockInstance;
let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing runCore or the paging service does writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// -------------------------------------------------------------------------------------------------------------------

/** Each paging case run through runCore with the paging port over its own world, by call name. */
async function runsOf(environment = "production"): Promise<Map<string, CoreRun>> {
  const runs = new Map<string, CoreRun>();
  for (const { action, now, world } of pagingCases()) {
    const runCore = createRunCore(coreWithPaging(pagingOn(world, environment)));
    runs.set(action.call, await runCore(action, turnContextOf(turnWith([action], now)), copy(NOTHING_OPEN)));
  }
  return runs;
}

describe("runCore dispatches the paging service's five core actions to its *Core functions (T-1443)", () => {
  it("each of handOff, answerHandOff, pageTeam, acknowledgePage and openReviewItem runs as its *Core function runs it with the port bound", async () => {
    const ran: string[] = [];
    for (const { action, now, world } of pagingCases()) {
      const paging = pagingOn(world);
      const request = turnWith([action], now);
      const run = await createRunCore(coreWithPaging(paging))(
        action,
        turnContextOf(request),
        copy(NOTHING_OPEN),
      );
      ran.push(action.call);
      // The same result and writes as the service's own core function gives with the same port: nothing added, nothing
      // dropped, its clock rows and cancels where it put them.
      expect(run, action.call).toEqual(await serviceRun(action, request, paging));
      expect(run.result, action.call).toMatchObject({ call: action.call, error: null });
      const { response } = run.result as { response: unknown };
      expect(validator.check(action.call as CallName, "response", response), action.call).toEqual([]);
      expect(run.writes.state.length, action.call).toBeGreaterThan(0);
    }
    expect(ran).toEqual(["pageTeam", "handOff", "answerHandOff", "acknowledgePage", "openReviewItem"]);
  });

  it("their rows go under the turn's business, their clock rows and cancels in the unit's own lists, written once", async () => {
    const runs = await runsOf();
    // The page: its row to each member and to Pat, and its next page's clock row due 5 minutes on, each under the barbershop.
    const page = runs.get("pageTeam");
    expect(page?.writes.messages.map(rowView)).toEqual([
      { to: "handle-team-1", sendClass: "safety", businessId: BARBERSHOP },
      { to: "handle-team-2", sendClass: "safety", businessId: BARBERSHOP },
      { to: "handle-pat", sendClass: "safety", businessId: BARBERSHOP },
    ]);
    expect(page?.writes.clocks?.map((clock) => [clock.businessId, clock.fires])).toEqual([
      [BARBERSHOP, { job: "team-page", page: "page-alex-threat" }],
    ]);
    // Crisis words: the owner's alert and the team's page at once, the hand-off's summary A3-25's line alone.
    const handOff = runs.get("handOff");
    expect(insertOf(handOff?.writes.state ?? [], "hand_offs")).toMatchObject({
      business_id: BARBERSHOP,
      kind: "crisis_words",
      summary: URGENT_LINE,
    });
    expect(handOff?.writes.messages.map(rowView)).toEqual([
      { to: "handle-sam", sendClass: "safety", businessId: BARBERSHOP },
      { to: "handle-team-1", sendClass: "safety", businessId: BARBERSHOP },
      { to: "handle-team-2", sendClass: "safety", businessId: BARBERSHOP },
    ]);
    // An answer and an acknowledgement each cancel their own clock row.
    expect(runs.get("answerHandOff")?.writes.clockCancels).toEqual([
      { id: "clock-handoff-alex-threat", expectVersion: 1 },
    ]);
    expect(runs.get("acknowledgePage")?.writes.clockCancels).toEqual([
      { id: "clock-page-alex-threat-2", expectVersion: 1 },
    ]);
    expect(runs.get("openReviewItem")?.writes.state.map((write) => write.table)).toEqual(["review_items"]);
  });

  it("on staging the page's rows go to roster test phones alone: with none bound, every member waits in the console", async () => {
    const staged = await runsOf("staging");
    // No roster bound: no test phone, so no row to anyone; the page and the hand-off's own rows are written all the same.
    for (const call of ["pageTeam", "handOff"]) {
      expect(staged.get(call)?.writes.messages, call).toEqual([]);
      expect(staged.get(call)?.writes.state.length, call).toBeGreaterThan(0);
    }
    const [pageCase] = pagingCases();
    if (pageCase === undefined) throw new Error("the page");
    const roster = rosterOf(["handle-team-2", "handle-pat"]);
    const run = await createRunCore(coreWithPaging({ ...pagingOn(pageCase.world, "staging"), roster }))(
      pageCase.action,
      turnContextOf(turnWith([pageCase.action], pageCase.now)),
      copy(NOTHING_OPEN),
    );
    expect(run.writes.messages.map((row) => row.recipientHandleId)).toEqual(["handle-team-2", "handle-pat"]);
  });

  it("through the turn's one commit: a crisis-words hand-off's alert and page rows, and a page's next clock row, go in one K-05 request", async () => {
    const [pageCase, handOffCase] = pagingCases();
    if (pageCase === undefined || handOffCase === undefined) throw new Error("both cases");
    // One world holding both what the page points at and the read the hand-off names.
    const world = threatWorld();
    const request = turnWith([handOffCase.action, pageCase.action], pageCase.now);
    const { answer, sent } = await committed(request, coreWithPaging(pagingOn(world)));
    expect(answer.core.map((result) => [result.call, result.error])).toEqual([
      ["handOff", null],
      ["pageTeam", null],
    ]);
    expect(sent.writes.state.map((write) => write.table)).toEqual([
      "hand_offs",
      "team_pages",
      "team_pages",
      "hand_offs",
    ]);
    expect(sent.writes.outboxRows.map((row) => [row.recipientHandleId, row.businessId])).toEqual([
      ["handle-sam", BARBERSHOP],
      ["handle-team-1", BARBERSHOP],
      ["handle-team-2", BARBERSHOP],
      ["handle-team-1", BARBERSHOP],
      ["handle-team-2", BARBERSHOP],
      ["handle-pat", BARBERSHOP],
    ]);
    // The page's next clock row, once, with its entry (T-1156: no clock is ever dropped, none written twice).
    expect(sent.writes.clockRows.make.map((clock) => clock.fires)).toEqual([
      { job: "team-page", page: "page-alex-threat" },
    ]);
  });

  it("with no paging port bound, or one bound with no reader, each answers notBuilt (portNotWired) before anything is read", async () => {
    const cases = pagingCases();
    const roster = rosterOf(["handle-team-1"]);
    for (const paging of [undefined, { environment: "production", roster } satisfies PagingDeps<unknown>]) {
      const runCore = createRunCore(coreWithPaging(paging));
      for (const { action, now } of cases) {
        const refused = await runCore(
          action,
          turnContextOf(turnWith([action], now)),
          copy(NOTHING_OPEN),
        ).catch((thrown: unknown) => thrown);
        expect(refused, action.call).toBeInstanceOf(CoreNotBuiltError);
        expect(refused, action.call).toMatchObject({
          core: action.call,
          gap: "portNotWired",
          seam: "runCore",
        });
      }
    }
    expect(roster.asked).toEqual([]);
  });

  it("each is the turn's own call: another caller is refused before anything is read", async () => {
    const reader = readerOn(threatWorld(true));
    const runCore = createRunCore(coreWithPaging({ reader: () => reader, environment: "production" }));
    const callers: [Partial<K09.Caller>, string][] = [
      [{ kind: "job", turnId: null }, "callerNotTurn"],
      [{ turnId: "turn-another" }, "turnIdMismatch"],
      [{ traceId: "trace-another" }, "traceIdMismatch"],
    ];
    for (const { action, now } of pagingCases()) {
      for (const [changed, why] of callers) {
        const request = turnWith([action], now);
        const other = {
          call: action.call,
          request: { ...action.request, caller: { ...action.request.caller, ...changed } },
        } as CoreAction;
        const refused = await runCore(other, turnContextOf(request), copy(NOTHING_OPEN)).catch(
          (thrown: unknown) => thrown,
        );
        expect(refused, `${action.call} ${why}`).toBeInstanceOf(CommitRefusedError);
        expect(refused, `${action.call} ${why}`).toMatchObject({ fault: why });
      }
    }
    expect(reader.asked).toEqual([]);
  });

  it("a refused paging core action stops only itself: its error is its result, it writes nothing, and the turn commits", async () => {
    const world = pagingWorld();
    const action = actionOf("answerHandOff", {
      caller: turnCaller(SAM),
      handOffId: "handoff-none",
      expectVersion: 1,
      via: "reply",
    });
    const { answer, sent } = await committed(
      turnWith([action], "2026-10-26T15:00:00Z"),
      coreWithPaging(pagingOn(world)),
    );
    expect(answer.core).toEqual([
      {
        call: "answerHandOff",
        response: null,
        error: { error: "notFound", table: "hand_offs", rowId: "handoff-none" },
      },
    ]);
    expect(sent.writes.state).toEqual([]);
    expect(sent.writes.outboxRows).toEqual([]);
    expect(sent.writes.clockRows.make).toEqual([]);
    expect(sent.turn.id).toBe(TURN);
  });
});

// -------------------------------------------------------------------------------------------------------------------

/** A K-02 v1 safety read (contracts/model/fixtures). */
function safetyRead(file: string): SafetyResult {
  return copy(contractJson(`model/fixtures/${file}`) as SafetyResult);
}

/** Alex's crisis words (K-02 v1 safety-crisis-words.json, evt-alex-0203), recorded in a turn of its own at the barbershop. */
function crisisTurn(): GateAndCommitRequest {
  const safety = safetyRead("safety-crisis-words.json");
  const caller = turnCaller(ALEX);
  const request = turnWith(
    [
      {
        call: "recordSafetyOutcome",
        request: { caller, safety, handleId: "handle-alex", bookingId: null, sentByActor: null },
      },
    ],
    "2026-10-23T14:30:03Z",
  );
  return {
    ...request,
    caller,
    turn: request.turn === null ? null : { ...request.turn, eventIds: [safety.eventId] },
  };
}

/** runCore's deps with T-318's safety doubles and who is told as given. */
function coreTelling(telling: CoreDeps<unknown>["safety"]["telling"]): CoreDeps<unknown> {
  return coreDoublesOn(safetyWorldOf(), { telling }).deps;
}

/** The paging telling port over a fresh paging world (Sam the owner; Rosie's team of two), with these options. */
function portOver(world: PagingWorld, options: Omit<PagingTellingOptions<unknown>, "reader"> = {}) {
  return pagingTellingPort<unknown>({ ...options, reader: () => readerOn(world) });
}

/** The safety rows a record's commit wrote: the line's, then who is told's, as the K-05 request carries them. */
function rowsOf(sent: Sent) {
  return sent.writes.outboxRows.map((row) => rowView(row));
}

/** The hand_off.created entry of a commit: its summary and its business. */
function createdEntry(sent: Sent): { summary: unknown; businessId: unknown } {
  const entry = sent.writes.events.find((each) => each.kind === "hand_off.created");
  const values: Record<string, unknown> = entry?.newValues ?? {};
  return { summary: values.summary, businessId: entry?.businessId };
}

/** The writer's own line (T-307's, back on the handle the text came from), which no roster filters: it answers the text. */
const LINE_TO_ALEX = { to: "handle-alex", sendClass: "safety", businessId: BARBERSHOP };

describe("the paging telling port in place of NOT_TOLD_YET: a crisis-words turn commits who is told (T-1443)", () => {
  it("in production: the turn commits the owner's alert ('Urgent: a customer may need help') and the team's page rows, under the record's business", async () => {
    const { answer, sent } = await committed(
      crisisTurn(),
      coreTelling(portOver(pagingWorld(), { environment: "production" })),
    );
    const [core] = answer.core;
    if (core?.call !== "recordSafetyOutcome" || core.response === null) throw new Error("recorded");
    expect(core.response).toMatchObject({
      outcomes: ["Crisis words"],
      hold: { releaseRule: "after_safe", blocksBooking: false },
      safetyLine: { fixedLineId: "safetyCrisis" },
      told: [
        { who: "owner", via: "handOff" },
        { who: "team", via: "teamPage" },
      ],
      repeated: false,
    });
    expect(sent.writes.state.map((write) => write.table)).toEqual([
      "safety_outcomes",
      "safety_holds",
      "hand_offs",
      "team_pages",
    ]);
    // The hand-off, told to Sam under the barbershop, its summary A3-25's line alone, in its row and in its entry.
    const handOff = insertOf(sent.writes.state, "hand_offs");
    expect(handOff).toMatchObject({
      id: core.response.told[0]?.id,
      business_id: BARBERSHOP,
      kind: "crisis_words",
      safety_outcome_id: core.response.outcomeId,
      turn_id: TURN,
      told_person_id: SAM,
      told_as: "owner",
      summary: URGENT_LINE,
    });
    expect(createdEntry(sent)).toEqual({ summary: URGENT_LINE, businessId: BARBERSHOP });
    expect(insertOf(sent.writes.state, "team_pages")).toMatchObject({
      id: core.response.told[1]?.id,
      reason: "hand_off",
      business_id: BARBERSHOP,
      hand_off_id: handOff.id,
    });
    // The line first (the safety message first), then the owner's alert, then one row to each member: all safety rows,
    // each under the record's business (K-05 open gap 78), the alert the one the hand-off names.
    expect(rowsOf(sent)).toEqual([
      LINE_TO_ALEX,
      { to: "handle-sam", sendClass: "safety", businessId: BARBERSHOP },
      { to: "handle-team-1", sendClass: "safety", businessId: BARBERSHOP },
      { to: "handle-team-2", sendClass: "safety", businessId: BARBERSHOP },
    ]);
    expect(handOff.alert_outbox_row_id).toBe(sent.writes.outboxRows[1]?.id);
    // Nothing the commit writes holds a number, an address or the person's words: every recipient is a handle's id.
    const text = JSON.stringify(sent.writes);
    expect(text).not.toMatch(/\+\d{7,15}/u);
    expect(text).not.toContain("alive");
  });

  it("on staging, every alert and page row goes to a roster test phone, and everyone else waits in the test console", async () => {
    const cases: [readonly string[], (typeof LINE_TO_ALEX)[]][] = [
      // Only member 1's phone is on the roster: Sam's alert and member 2's page wait in the console.
      [
        ["handle-team-1"],
        [LINE_TO_ALEX, { to: "handle-team-1", sendClass: "safety", businessId: BARBERSHOP }],
      ],
      // Sam's phone and member 2's: the alert and member 2's row; member 1 waits.
      [
        ["handle-sam", "handle-team-2"],
        [
          LINE_TO_ALEX,
          { to: "handle-sam", sendClass: "safety", businessId: BARBERSHOP },
          { to: "handle-team-2", sendClass: "safety", businessId: BARBERSHOP },
        ],
      ],
    ];
    for (const [roster, rows] of cases) {
      for (const given of [roster, rosterOfHandles(roster)]) {
        const { answer, sent } = await committed(
          crisisTurn(),
          coreTelling(portOver(pagingWorld(), { environment: "staging", roster: given })),
        );
        expect(rowsOf(sent), roster.join(",")).toEqual(rows);
        // Every row the telling port wrote (after the writer's own line) is to a roster test phone.
        for (const row of sent.writes.outboxRows.slice(1)) expect(roster).toContain(row.recipientHandleId);
        // The hand-off and the page are written all the same: who waits is in the console, never lost.
        expect(answer.core[0]).toMatchObject({
          response: { told: [{ who: "owner" }, { who: "team" }] },
        });
        const handOff = insertOf(sent.writes.state, "hand_offs");
        expect(handOff.alert_outbox_row_id === null, roster.join(",")).toBe(!roster.includes("handle-sam"));
      }
    }
  });

  it("fails closed: any ENVIRONMENT but exactly production is staging, no roster is no test phone, and an email never counts as one", async () => {
    // Member 1 with no open chat is reached by email: in production a row to the email; on staging never.
    const emailOnly = (): PagingWorld => {
      const world = pagingWorld();
      world.chats.set("handle-team-1", { handleId: "handle-team-1", open: false, way: "imessage" });
      return world;
    };
    const production = await committed(
      crisisTurn(),
      coreTelling(portOver(emailOnly(), { environment: "production" })),
    );
    expect(rowsOf(production.sent).map((row) => row.to)).toEqual([
      "handle-alex",
      "handle-sam",
      "handle-team-1-email",
      "handle-team-2",
    ]);
    const environments = [undefined, null, "", "staging", "Production", "production ", " production", "prod"];
    for (const environment of environments) {
      for (const roster of [undefined, null, [], ["handle-team-1-email"], ["+15555550101"]] as const) {
        const options: Omit<PagingTellingOptions<unknown>, "reader"> = {
          ...(environment === undefined ? {} : { environment }),
          ...(roster === undefined ? {} : { roster }),
        };
        const { sent } = await committed(crisisTurn(), coreTelling(portOver(emailOnly(), options)));
        // Only the writer's own line: no alert, no page row, no email; the hand-off and the page wait in the console.
        expect(rowsOf(sent), `${String(environment)} ${JSON.stringify(roster)}`).toEqual([LINE_TO_ALEX]);
        expect(sent.writes.state.map((write) => write.table)).toContain("team_pages");
      }
    }
  });

  it("with no reads bound the port answers notBuilt, as NOT_TOLD_YET does: nothing is written", async () => {
    const request = crisisTurn();
    for (const telling of [
      pagingTellingPort<unknown>({ environment: "production", roster: ["handle-sam"] }),
      NOT_TOLD_YET,
    ]) {
      const runCore = createRunCore(coreTelling(telling));
      const [action] = request.core;
      if (action === undefined) throw new Error("the record");
      const refused = await runCore(action, turnContextOf(request), copy(NOTHING_OPEN)).catch(
        (thrown: unknown) => thrown,
      );
      expect(refused).toBeInstanceOf(CoreNotBuiltError);
      expect(refused).toMatchObject({ core: "recordSafetyOutcome", gap: "portNotWired" });
      const { cause } = refused as Error;
      expect(cause).toBeInstanceOf(NotBuiltError);
      expect((cause as NotBuiltError).call).toBe("handOff");
    }
  });
});

describe("with NOT_TOLD_YET the old answers are unchanged (T-1443)", () => {
  it("a crisis-words turn still answers notBuilt through NOT_TOLD_YET, naming handOff, and a turn that tells no one commits the same either way", async () => {
    const crisis = crisisTurn();
    const [record] = crisis.core;
    if (record === undefined) throw new Error("the record");
    const refused = await createRunCore(coreTelling(NOT_TOLD_YET))(
      record,
      turnContextOf(crisis),
      copy(NOTHING_OPEN),
    ).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(CoreNotBuiltError);
    expect(refused).toMatchObject({ core: "recordSafetyOutcome", gap: "portNotWired" });
    expect((refused as Error).cause).toBeInstanceOf(NotBuiltError);
    expect(((refused as Error).cause as NotBuiltError).call).toBe("handOff");

    // commit-s1-01.json (Sam's text, No): nobody is told, so the port is never asked and nothing it reads is read.
    const s1 = withK05Turn(s1_01Exchange().request);
    const world = pagingWorld();
    const reader = readerOn(world);
    const withPort = await committed(
      s1,
      coreTelling(pagingTellingPort<unknown>({ environment: "production", reader: () => reader })),
    );
    const withNotToldYet = await committed(s1, coreTelling(NOT_TOLD_YET));
    expect(withPort.answer).toEqual(withNotToldYet.answer);
    expect(withPort.sent).toEqual(withNotToldYet.sent);
    expect(reader.asked).toEqual([]);
  });
});

describe("the telling port as a binding names it (domain/safety TellingPort; telling.ts)", () => {
  const request: TellRequest = {
    eventId: "evt-alex-0203",
    outcomeId: "safety-outcome-alex-0203",
    outcomes: ["Crisis words"],
    businessId: BARBERSHOP,
    handleId: "handle-alex",
    personId: ALEX,
    bookingId: null,
    turnId: TURN,
    now: "2026-10-23T14:30:03Z",
    repeated: false,
  };

  it("tellingOn gives a SafetyTelling as it is, and puts the paging port on the repo it is handed", async () => {
    expect(tellingOn(NOT_TOLD_YET, { name: "repo" })).toBe(NOT_TOLD_YET);
    const repos: unknown[] = [];
    const world = pagingWorld();
    const port = pagingTellingPort<{ name: string }>({
      environment: "production",
      reader: (repo) => {
        repos.push(repo);
        return readerOn(world);
      },
    });
    const telling: SafetyTelling = tellingOn(port, { name: "the turn's repo" });
    const plan = await telling.tell(request);
    expect(plan.told.map((told) => told.via)).toEqual(["handOff", "teamPage"]);
    expect(repos).toEqual([{ name: "the turn's repo" }]);
  });

  it("the port is a SafetyTelling itself: told before it is put on a call's repo, it answers notBuilt (handOff) and reads nothing", async () => {
    const reader = readerOn(pagingWorld());
    const port = pagingTellingPort<unknown>({ environment: "production", reader: () => reader });
    const told = await port.tell(request).catch((thrown: unknown) => thrown);
    expect(told).toBeInstanceOf(NotBuiltError);
    expect((told as NotBuiltError).call).toBe("handOff");
    // So the safety service's own SafetyDeps takes it as it is, and a record told through it fails closed, as through
    // NOT_TOLD_YET: the commit core is what puts it on the turn's repo.
    const crisis = crisisTurn();
    const [record] = crisis.core;
    if (record?.call !== "recordSafetyOutcome") throw new Error("the record");
    const { deps } = coreDoublesOn(safetyWorldOf(), { telling: port });
    await expect(
      recordSafetyOutcomeCore(record, turnContextOf(crisis), copy(NOTHING_OPEN), deps.safety),
    ).rejects.toThrow(NotBuiltError);
    expect(reader.asked).toEqual([]);
  });

  it("pagingDepsOf spells out each fail-closed default: staging, no test phone, no reads, keyed ids", async () => {
    const deps = pagingDepsOf<unknown>();
    expect(deps.environment).toBe("");
    expect(deps.reader).toBeUndefined();
    expect(deps.ids).toBeUndefined();
    expect(await deps.roster?.isTestPhone("handle-team-1")).toBe(false);
    const listed = pagingDepsOf<unknown>({ environment: null, roster: ["handle-team-1"] });
    expect(listed.environment).toBe("");
    expect(await listed.roster?.isTestPhone("handle-team-1")).toBe(true);
    expect(await listed.roster?.isTestPhone("HANDLE-TEAM-1")).toBe(false);
    expect(await listed.roster?.isTestPhone(" handle-team-1")).toBe(false);
    // With no reads bound the port, put on a repo, answers notBuilt for anything that tells, writing nothing.
    await expect(pagingTellingPort<unknown>().on(null).tell(request)).rejects.toThrow(NotBuiltError);
  });
});
