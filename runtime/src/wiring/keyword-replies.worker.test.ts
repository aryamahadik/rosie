// T-1412 (DL-856, DL-864, DL-877, DL-896, DL-898): the root binds the guard's fixed replies (T-267) in install(), with
// setReplyDeps({ core: turnReplyCore, rows: the turn's own plan calls, rosieNumber }), so a bare STOP, START or HELP is
// recorded and answered instead of ending `unwired`. Inside the Workers runtime, through a root composed for the test
// environment as the hop tests compose it (the HandleActor namespace, the skeleton flag on, every joined port fed its
// double from ./test-support.ts, the actor's ports installed): the gate port is the real one (./real.ts realGate), so a
// keyword turn's call, which names no business, goes to T-1413's keyword door over the fake root's door pieces
// (fakeGateReads' keywordDoor, composed as staging's binding composes them: T-1415), its one commit through the real
// turn-row port to the K-05 commitTurn double, which answers a phones row by its handle id (K-05 v1.17, T-1419).
//
// What a test adds to the rig, beside it: test owner 1's phones row in the K-05 double (chat open by iMessage, not
// stopped), as his first text's chat open writes it on staging (T-1213); the safety read on arrival over the
// recorded-model double with STOP and START added to its texts, each read No as safety-no.json reads (every raw text is
// read, a keyword too); and a watch on the data-access port (each unplannedRows and writePlan handed on unchanged, the
// writePlan requests kept). The fake root's dispatcher reads the plans finalize writes, never the data-access port's, so
// no fixed line is claimed or sent here: a fixed line's words are proved at writePlan, and its send on staging.
//
//   - STOP, then START, each alone, from test owner 1's phone: each commits core-only through the keyword door (no business
//     scope opened), its fillAndChecks span answers replied (never unwired, noBusinessScope or notBuilt), the phone's
//     stopped flag set then cleared in the K-05 double, one K-29 texts row with no business each (revoked, then not), and
//     one quick_reply row each to his handle with no business, its words Q-01's default for the line (bundle v0's are
//     pendingJay), written by code; no frontier, decide, composer or model call after the guard;
//   - HELP alone with Rosie's number: one quick_reply row whose words are Q-01's HELP default with the number in; then a
//     STOP; then HELP from the stopped phone: phoneStopped, nothing written for it, nothing planned;
//   - HELP alone with no number handed in: its row is written by the commit but gets no words (noWords), so nothing is
//     planned and nothing can be sent;
//   - install() binds them: with no deps an isolate's reply answers unwired; with earlier deps they answer it; once the
//     root is installed its own answer it (turnReplyCore: a turn id no turn runs answers notInTurn); its restore puts the
//     earlier ones back. The rows are the turn's own, each request and answer handed on as it comes;
//   - Rosie's number is a reader called at each use, never as the root is built: RootOptions.rosieNumber, and staging's
//     hand-off (./staging/options.ts stagingRosieNumber: ROSIE_NUMBER when E.164 by the test-phone page's own check, else
//     blank; production none), which workerRoot hands in.
// No span or log line holds a number or a reply's words. Each test's texts come from test owner 1's number; the pool's
// storage is reset after each test. Test values only (rule 9): K-06's and K-02's fixtures, made-up ids, and whole
// fiction-range numbers (555-01xx): test owner 1's, and Rosie's line as K-11's vendor samples give it (555-0199).
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import safetyNo from "@rosie/contracts/model/fixtures/safety-no.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor, type TurnEntry } from "../actor";
import { actorNameOf } from "../gateway";
import {
  HELP_REPLY,
  Q01_DRAFTED,
  replyToKeywords,
  setReplyDeps,
  START_REPLY,
  STOP_REPLY,
  type KeywordReply,
  type ReplyDeps,
  type WritePlanRequest,
} from "../guard";
import { fakeCore, phone, pinnedManifest, turnTrace, typed } from "../guard/replies/test-support";
import type { GuardText } from "../guard/types";
import type { Hop, Span } from "../trace";
import { leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { turnReplyCore } from "../turn";
import { flush, SAM } from "../turn/test-support";
import type { RowsAnswer, WriteRowPlanAnswer, WriteRowPlanRequest } from "../turn/types";
import {
  composeRoot,
  SKELETON_FLAG,
  workerRoot,
  type HandleActors,
  type Root,
  type RootOptions,
} from "./index";
import { stagingRosieNumber } from "./staging/options";
import type { StagingEnv } from "./staging/part";
import {
  fakeFlags,
  fakeSafetyModels,
  SAM_CHAT,
  skeletonFakes,
  skeletonSafetyDouble,
  TEST_OWNER_1,
  type FakeSafetyModels,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
  type WrittenRow,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps, two or three turns of it: a resource guard, not part of any claim. */
const TEST_MS = 60_000;
/** How long a wait for the actor's own work may take on a machine busy with other builds. */
const WAIT_MS = 20_000;

/** Rosie's line as K-11's vendor samples give it, in E.164 (port-linq README: "+1 555 555 0199"). */
const ROSIE = "+15555550199";
/** Another whole fiction-range number, for a reader whose answer changes. */
const OTHER_ROSIE = "+15555550198";

/** The keyword texts' words, as typed: each one of bundle v0's keywords (K-01 lists.keywords). */
const STOP_TEXT = "STOP";
const START_TEXT = "START";
const HELP_TEXT = "HELP";

/** Q-01's drafted words for each reply (the bundle's lines are pendingJay), HELP's with Rosie's number in. */
const STOP_WORDS = Q01_DRAFTED[STOP_REPLY] ?? "";
const START_WORDS = Q01_DRAFTED[START_REPLY] ?? "";
const HELP_WORDS = (Q01_DRAFTED[HELP_REPLY] ?? "").replace("<rosieNumber>", ROSIE);

/** Every number of this file, in each form a number could leak in besides E.164 (leaks finds any +number itself). */
const NUMBERS = [SAM.handle.address, ROSIE, OTHER_ROSIE].flatMap((number) => [
  number.slice(1),
  number.slice(2),
]);
/** What no span or log line may hold: the numbers, and each reply's words. */
const SECRETS = [...NUMBERS, STOP_WORDS, START_WORDS, HELP_WORDS];

/** The hops a model is reached on after the guard: the frontier, decide's reads, the one re-read, meaning search, the composer. */
const MODEL_HOPS: readonly Hop[] = ["frontier", "decideReads", "reread", "search", "compose"];

const SAM_ACTOR = actorNameOf(SAM.handle);

// ---- the console ------------------------------------------------------------------------------------------------------

/** Every line written on the console while the running test ran. */
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(keep);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** The spans the running test's lines hold. */
const spans = (): Span[] => spansOfLogLines(lines);

/** Every line that holds a raw number or one of the secrets, ignoring case (as leaks reads a span). */
function linesHolding(secrets: readonly string[]): string[] {
  const parts = secrets.map((secret) => secret.trim().toLowerCase()).filter((part) => part.length >= 4);
  return lines.filter((line) => {
    const lower = line.toLowerCase();
    return /\+[0-9]{7,15}/u.test(lower) || parts.some((part) => lower.includes(part));
  });
}

// ---- the actor ------------------------------------------------------------------------------------------------------

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

/** The actor's calls over RPC, typed here. */
interface ActorRpc {
  readTurns(): Promise<TurnEntry[]>;
  safetyIdle(): Promise<void>;
  outageIdle(): Promise<void>;
  batchIdle(): Promise<void>;
}

function actorOf(actorName: string): ActorRpc {
  return namespace().get(namespace().idFromName(actorName));
}

/** Waits until the actor has read every text and run what its batch window and lease can. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await actorOf(SAM_ACTOR).safetyIdle();
    await actorOf(SAM_ACTOR).outageIdle();
    await actorOf(SAM_ACTOR).batchIdle();
  }
}

// ---- the texts ------------------------------------------------------------------------------------------------------

/** A text of K-06's text-imessage.json form from test owner 1's phone, with this event id and these words. */
function samText(eventId: string, body: string): LinqInboundEvent {
  return {
    ...(structuredClone(textFixture) as Json),
    eventId,
    handle: { ...SAM.handle },
    body,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${eventId}`,
  } as unknown as LinqInboundEvent;
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

// ---- the rig ----------------------------------------------------------------------------------------------------------

/** One writePlan the data-access port was handed, and what it answered. */
interface PlanCall {
  readonly request: WriteRowPlanRequest;
  readonly answer: WriteRowPlanAnswer;
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  /** The safety read on arrival's model calls, through the recorded-model double. */
  readonly models: FakeSafetyModels;
  /** Each writePlan the data-access port was handed, in order. */
  readonly plans: PlanCall[];
  /** One keyword text from test owner 1's phone, through the root's Linq route to its turn's end. */
  turn(eventId: string, words: string): Promise<{ traceId: string; turnId: string }>;
  restore(): void;
}

/**
 * The safety read's recorded answers: the skeleton's texts as they are, and STOP and START, each read No as
 * safety-no.json reads (the skeleton's double holds no read for them).
 */
function keywordSafetyReads(): Parameters<typeof fakeSafetyModels>[0] {
  const shipped = skeletonSafetyDouble();
  return {
    safetyRead: (request) =>
      request.text === STOP_TEXT || request.text === START_TEXT
        ? Promise.resolve(structuredClone(safetyNo.read) as Record<string, unknown>)
        : shipped.safetyRead(request),
  };
}

/** Test owner 1's phones row as the K-05 double holds it (K-04 columns): chat open by iMessage, not stopped, version 1. */
function samPhonesRow(): WrittenRow {
  return {
    table: "phones",
    id: TEST_OWNER_1.handleId,
    values: {
      number: TEST_OWNER_1.handle.address,
      handle_id: TEST_OWNER_1.handleId,
      chat_open: true,
      chat_open_at: "2026-11-16T14:00:00Z",
      chat_way: "imessage",
      stopped: false,
      stop_at: null,
      start_at: null,
      linq_contact_added_at: null,
      poll_voted_at: null,
      optout_line_delivered_at: null,
    },
    version: 1,
    turnId: "turn-t1412-seed",
  };
}

/** The K-05 double's phones row for test owner 1, as it stands. */
function samPhone(fakes: SkeletonFakes): Readonly<Record<string, unknown>> {
  const row = fakes.turnRows.rows.get("phones")?.get(TEST_OWNER_1.handleId);
  if (row === undefined) throw new Error("the K-05 double holds no phones row for test owner 1");
  return { ...row.values, version: row.version };
}

/** Every row the K-05 double holds in a table, written by a turn. */
function rowsOf(fakes: SkeletonFakes, table: string, turnId: string): WrittenRow[] {
  return [...(fakes.turnRows.rows.get(table)?.values() ?? [])].filter((row) => row.turnId === turnId);
}

/**
 * The root for "test" with the HandleActor namespace and the skeleton flag on, every joined port fed its double as
 * ./kept-results.worker.test.ts feeds them, the safety read's double reading STOP and START too, the data-access port
 * watched, test owner 1's phones row in the K-05 double, and Rosie's number as `rosieNumber` gives it; its ports installed.
 */
function rig(options: Pick<RootOptions, "rosieNumber"> = {}): Rig {
  const fakes = skeletonFakes();
  const models = fakeSafetyModels(keywordSafetyReads());
  const plans: PlanCall[] = [];
  const rows = fakes.ports.dataAccess.rows;
  const ports: SkeletonFakes["ports"] = {
    ...fakes.ports,
    dataAccess: {
      rows: {
        unplannedRows: (request): Promise<RowsAnswer> => rows.unplannedRows(request),
        writePlan: async (request) => {
          const answer = await rows.writePlan(request);
          plans.push({ request: structuredClone(request), answer: structuredClone(answer) });
          return answer;
        },
      },
    },
  };
  fakes.turnRows.rows.set("phones", new Map([[TEST_OWNER_1.handleId, samPhonesRow()]]));
  const root = composeRoot({
    environment: "test",
    sets: { fake: ports },
    actors: handleActors(),
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    outboxCalls: fakes.dispatch.outbox,
    sendStateCall: fakes.dispatch.sendState,
    linqSendCall: fakes.linq.call,
    armingCalls: fakes.arming.calls,
    flags: fakeFlags([SKELETON_FLAG]),
    ...(options.rosieNumber === undefined ? {} : { rosieNumber: options.rosieNumber }),
  });
  const restore = root.install();

  /** Waits until this turn has committed and its reply ended (its lease released); on a timeout, says what its trace shows. */
  const untilReplied = async (turnId: string, traceId: string): Promise<void> => {
    const started = Date.now();
    for (;;) {
      const turns = await actorOf(SAM_ACTOR).readTurns();
      if (
        turns.some((turn) => turn.turnId === turnId && turn.state === "committed" && turn.leaseUntil === null)
      ) {
        return;
      }
      if (Date.now() - started > WAIT_MS) {
        const seen = spansOfTrace(spans(), traceId).map(
          (span) => `${span.hop}:${span.outcome}:${span.error_code ?? "-"}`,
        );
        throw new Error(`gave up waiting for the turn's reply to end: the trace shows ${seen.join(", ")}`);
      }
      await flush(5);
    }
  };

  return {
    fakes,
    root,
    models,
    plans,
    async turn(eventId, words) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(samText(eventId, words))));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      await settle();
      // The batch window closes: the lease opens the turn, and the turn runs.
      await fakes.clock.advance(QUIET_MS);
      await runDurableObjectAlarm(namespace().get(namespace().idFromName(SAM_ACTOR)));
      const turnId = await turnIdOf([eventId]);
      await untilReplied(turnId, traceId);
      await settle();
      return { traceId, turnId };
    },
    restore,
  };
}

/** The one span of a hop in a trace. */
function onlySpan(trace: readonly Span[], hop: Hop): Span {
  const found = trace.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

/** A planned fixed line's row: its id, the line it names and its parts (K-03 finalParts), and its plan's own lines. */
function plannedLine(call: PlanCall): {
  row: string;
  line: readonly string[];
  sends: readonly unknown[];
  planLines: readonly unknown[];
} {
  return {
    row: call.request.outboxRowId,
    line: call.request.finalParts.fixedLines,
    sends: call.request.finalParts.sends,
    planLines: call.request.plan.plan.lines,
  };
}

/** A fixed line's one part, as the replies write it (../guard/replies/replies.ts fixedLinePlan): its words, no options. */
const wordsPart = (text: string): Json => ({
  kind: "words",
  text,
  calendarFile: "none",
  options: [],
  link: null,
});

/**
 * What a keyword turn reached after its guard: no frontier, decide, re-read, meaning search or composer, no model call
 * but its text's own safety read on arrival, and nothing claimed or sent.
 */
function expectNoModelAfterGuard(run: Rig, trace: readonly Span[]): void {
  expect(trace.filter((span) => MODEL_HOPS.includes(span.hop))).toEqual([]);
  const guard = onlySpan(trace, "guard");
  for (const span of trace.filter((each) => (each.model_calls?.length ?? 0) > 0)) {
    expect(Date.parse(span.at) + span.ms).toBeLessThanOrEqual(Date.parse(guard.at));
  }
  expect(run.fakes.frontier.reads).toEqual([]);
  expect(run.fakes.decide.decideCalls).toEqual([]);
  expect(
    run.fakes.face.log.filter(
      (entry) => ["frontier", "decide", "reread", "search"].includes(entry) || entry.startsWith("compose"),
    ),
  ).toEqual([]);
}

// ---- STOP, START and HELP through a turn ----------------------------------------------------------------------------

describe("the root binds the guard's fixed replies: a bare STOP, START or HELP is recorded and answered through the keyword door", () => {
  it(
    "STOP, then START, each alone: recorded core-only through the door, the stopped flag set then cleared, one quick_reply row each with Q-01's words written by code, no model after the guard",
    { timeout: TEST_MS },
    async () => {
      const run = rig({ rosieNumber: () => ROSIE });
      try {
        // ---- STOP ----
        const stop = await run.turn("evt-t1412-0101", STOP_TEXT);
        const stopTrace = spansOfTrace(spans(), stop.traceId);
        // The reply answered recorded and replied: never unwired, noBusinessScope or notBuilt.
        expect(onlySpan(stopTrace, "fillAndChecks")).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: stop.turnId,
          got: { keyword: "stop", flagsVisit: false },
          decided: {
            result: "replied",
            line: STOP_REPLY,
            words: "q01Default",
            stopped: true,
            told: 0,
            rowsWritten: 1,
          },
        });
        expect(onlySpan(stopTrace, "guard")).toMatchObject({
          outcome: "ok",
          decided: { keyword: ["stop"], toDecide: 0 },
        });
        // Core-only, through the keyword door: no business scope opened, every read on the door's transaction naming none.
        expect(run.fakes.gate.doors).toEqual(["gateAndCommit"]);
        expect(run.fakes.gate.scopes).toEqual([]);
        expect(run.fakes.gate.seen.filter((read) => read.businessId !== null)).toEqual([]);
        // One K-05 commit under the turn id, asking for phones rows by handle id (K-05 v1.17): the phone stopped, its chat
        // closed, by its handle id; one texts row with no business that withdraws texts; one quick_reply row to his handle.
        expect(
          run.fakes.turnRows.commits.map((commit) => [commit.turn.id, commit.answerPhoneRowsBy]),
        ).toEqual([[stop.turnId, "handleId"]]);
        expect(samPhone(run.fakes)).toMatchObject({ stopped: true, chat_open: false, version: 2 });
        expect(rowsOf(run.fakes, "consents", stop.turnId).map((row) => row.values)).toMatchObject([
          {
            person_id: TEST_OWNER_1.personId,
            business_id: null,
            kind: "texts",
            revoked: true,
            handle_id: TEST_OWNER_1.handleId,
            channel: "text",
            turn_id: stop.turnId,
          },
        ]);
        const stopRows = rowsOf(run.fakes, "outbox_rows", stop.turnId);
        expect(stopRows.map((row) => row.values)).toMatchObject([
          {
            recipientHandleId: TEST_OWNER_1.handleId,
            businessId: null,
            sendClass: "quick_reply",
            channel: "imessage",
          },
        ]);
        // Its words, written by code into that row with a plan of no lines of its own: the stop reply's, word for word,
        // naming the line limit 8 lets through to a stopped phone.
        expect(run.plans.map(plannedLine)).toEqual([
          { row: stopRows[0]?.id, line: [STOP_REPLY], sends: [wordsPart(STOP_WORDS)], planLines: [] },
        ]);
        expect(run.plans.map((call) => call.answer)).toMatchObject([{ result: "written" }]);
        expectNoModelAfterGuard(run, stopTrace);
        expect(run.models.calls).toEqual([{ model: HAIKU_MODEL, text: STOP_TEXT }]);

        // ---- START, from the stopped phone ----
        const start = await run.turn("evt-t1412-0102", START_TEXT);
        const startTrace = spansOfTrace(spans(), start.traceId);
        expect(onlySpan(startTrace, "fillAndChecks")).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: start.turnId,
          got: { keyword: "start", flagsVisit: false },
          decided: {
            result: "replied",
            line: START_REPLY,
            words: "q01Default",
            stopped: false,
            told: 0,
            rowsWritten: 1,
          },
        });
        expect(run.fakes.gate.doors).toEqual(["gateAndCommit", "gateAndCommit"]);
        expect(run.fakes.gate.scopes).toEqual([]);
        expect(samPhone(run.fakes)).toMatchObject({ stopped: false, chat_open: true, version: 3 });
        expect(rowsOf(run.fakes, "consents", start.turnId).map((row) => row.values)).toMatchObject([
          { person_id: TEST_OWNER_1.personId, business_id: null, kind: "texts", revoked: false },
        ]);
        const startRows = rowsOf(run.fakes, "outbox_rows", start.turnId);
        expect(startRows.map((row) => row.values)).toMatchObject([
          { recipientHandleId: TEST_OWNER_1.handleId, businessId: null, sendClass: "quick_reply" },
        ]);
        expect(run.plans.slice(1).map(plannedLine)).toEqual([
          { row: startRows[0]?.id, line: [START_REPLY], sends: [wordsPart(START_WORDS)], planLines: [] },
        ]);
        expectNoModelAfterGuard(run, startTrace);
        expect(run.models.calls.map((call) => call.text)).toEqual([STOP_TEXT, START_TEXT]);

        // The fake root's dispatcher claims only the rows finalize planned: nothing went to Linq here.
        expect(run.fakes.linq.requests).toEqual([]);
        expect(leaks(spans(), SECRETS)).toEqual([]);
        expect(linesHolding(SECRETS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "HELP alone with Rosie's number: one quick_reply row with Q-01's words, the number in; then a STOP; then HELP from the stopped phone answers phoneStopped, with nothing written or planned for it",
    { timeout: TEST_MS },
    async () => {
      const run = rig({ rosieNumber: () => ROSIE });
      try {
        // ---- HELP, the phone not stopped ----
        const help = await run.turn("evt-t1412-0201", HELP_TEXT);
        const helpTrace = spansOfTrace(spans(), help.traceId);
        expect(onlySpan(helpTrace, "fillAndChecks")).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: help.turnId,
          got: { keyword: "help", flagsVisit: false },
          decided: {
            result: "replied",
            line: HELP_REPLY,
            words: "q01Default",
            stopped: null,
            told: 0,
            rowsWritten: 1,
          },
        });
        expect(run.fakes.gate.doors).toEqual(["gateAndCommit"]);
        expect(run.fakes.gate.scopes).toEqual([]);
        const helpRows = rowsOf(run.fakes, "outbox_rows", help.turnId);
        expect(helpRows.map((row) => row.values)).toMatchObject([
          {
            recipientHandleId: TEST_OWNER_1.handleId,
            businessId: null,
            sendClass: "quick_reply",
            channel: "imessage",
          },
        ]);
        expect(run.plans.map(plannedLine)).toEqual([
          { row: helpRows[0]?.id, line: [HELP_REPLY], sends: [wordsPart(HELP_WORDS)], planLines: [] },
        ]);
        expect(HELP_WORDS).toContain(ROSIE);
        // HELP records nothing of the phone's: no consent row, the phone as it was.
        expect(rowsOf(run.fakes, "consents", help.turnId)).toEqual([]);
        expect(samPhone(run.fakes)).toMatchObject({ stopped: false, chat_open: true, version: 1 });
        expectNoModelAfterGuard(run, helpTrace);
        expect(run.models.calls).toEqual([{ model: HAIKU_MODEL, text: HELP_TEXT }]);

        // ---- STOP ----
        const stop = await run.turn("evt-t1412-0202", STOP_TEXT);
        expect(onlySpan(spansOfTrace(spans(), stop.traceId), "fillAndChecks")).toMatchObject({
          outcome: "ok",
          decided: { result: "replied", line: STOP_REPLY, stopped: true },
        });
        expect(samPhone(run.fakes)).toMatchObject({ stopped: true, chat_open: false });

        // ---- HELP from the stopped phone ----
        const after = await run.turn("evt-t1412-0203", HELP_TEXT);
        const afterTrace = spansOfTrace(spans(), after.traceId);
        expect(onlySpan(afterTrace, "fillAndChecks")).toMatchObject({
          outcome: "refused",
          error_code: "phoneStopped",
          turn_id: after.turnId,
          got: { keyword: "help" },
          decided: { result: "refused", line: null, words: null, rowsWritten: 0 },
        });
        // Its turn committed core-only through the door (its text's record), and wrote no row and no plan for the HELP.
        expect(run.fakes.gate.doors).toEqual(["gateAndCommit", "gateAndCommit", "gateAndCommit"]);
        expect(run.fakes.turnRows.turns.get(after.turnId)?.state).toBe("committed");
        expect(rowsOf(run.fakes, "outbox_rows", after.turnId)).toEqual([]);
        expect(run.plans.map((call) => call.request.finalParts.fixedLines)).toEqual([
          [HELP_REPLY],
          [STOP_REPLY],
        ]);
        expect(samPhone(run.fakes)).toMatchObject({ stopped: true, chat_open: false });
        expectNoModelAfterGuard(run, afterTrace);
        expect(run.fakes.linq.requests).toEqual([]);
        expect(leaks(spans(), SECRETS)).toEqual([]);
        expect(linesHolding(SECRETS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );

  it(
    "HELP alone with no number handed in: its row is written by the commit but gets no words (noWords), so nothing is planned or sent",
    { timeout: TEST_MS },
    async () => {
      const run = rig();
      try {
        expect(run.root.replies.rosieNumber).toBe("");
        const help = await run.turn("evt-t1412-0301", HELP_TEXT);
        const helpTrace = spansOfTrace(spans(), help.traceId);
        expect(onlySpan(helpTrace, "fillAndChecks")).toMatchObject({
          outcome: "failed",
          error_code: "noWords",
          turn_id: help.turnId,
          got: { keyword: "help" },
          decided: { result: "noWords", line: HELP_REPLY, words: null, rowsWritten: 0 },
        });
        // Recorded through the door, its row written with no plan: no words, so the dispatcher can never claim it.
        expect(run.fakes.gate.doors).toEqual(["gateAndCommit"]);
        expect(run.fakes.turnRows.turns.get(help.turnId)?.state).toBe("committed");
        expect(rowsOf(run.fakes, "outbox_rows", help.turnId).map((row) => row.values)).toMatchObject([
          { recipientHandleId: TEST_OWNER_1.handleId, businessId: null, sendClass: "quick_reply" },
        ]);
        expect(run.plans).toEqual([]);
        expect(run.fakes.finalize.plans.size).toBe(0);
        expect(run.fakes.linq.requests).toEqual([]);
        expectNoModelAfterGuard(run, helpTrace);
        expect(leaks(spans(), SECRETS)).toEqual([]);
        expect(linesHolding(SECRETS)).toEqual([]);
      } finally {
        run.restore();
      }
    },
  );
});

// ---- the binding itself -------------------------------------------------------------------------------------------------

/** One bare STOP from test owner 1's phone, through the guard's replies alone (no turn runs it): its one reply. */
async function replyAlone(turnId: string): Promise<KeywordReply<GuardText>> {
  const { trace } = turnTrace(turnId);
  const result = await replyToKeywords({
    turnId,
    handleId: SAM.party.handleId,
    phoneNumber: SAM.handle.address,
    personId: SAM.party.personId,
    traceId: trace.traceId,
    keywords: [
      {
        text: typed(`evt-${turnId}`, STOP_TEXT),
        keyword: { kind: "stop", word: STOP_TEXT, flagsVisit: false },
      },
    ],
    bundle: { manifest: await pinnedManifest() },
    trace,
  });
  const [reply] = result.replies;
  if (reply === undefined) throw new Error("the replies answered no keyword text");
  return reply;
}

/** A root for "test" on the skeleton's fakes, with no actor namespace: enough to install and read its replies. */
function plainRoot(extra: Partial<RootOptions> = {}): { root: Root; fakes: SkeletonFakes } {
  const fakes = skeletonFakes();
  const root = composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors: null,
    vars: env,
    clock: fakes.clock,
    ...extra,
  });
  return { root, fakes };
}

describe("install() binds the replies: turnReplyCore over the turn's own plan calls, put back by its restore", () => {
  it("with no deps an isolate's reply answers unwired; earlier deps answer it; once installed, the root's own do (turnReplyCore: notInTurn for a turn no turn runs); restore puts the earlier ones back", async () => {
    const { root } = plainRoot();
    const earlier = fakeCore("2026-11-16T15:00:00Z", [
      phone(SAM.handle.address, SAM.party.handleId, SAM.party.personId),
    ]);
    const earlierDeps: ReplyDeps = { core: earlier.core, rows: earlier.rows, rosieNumber: "" };
    const restores: (() => void)[] = [];
    try {
      // An isolate the root never wired: the replies record nothing and say so.
      restores.push(setReplyDeps(null));
      expect(await replyAlone("turn-t1412-unwired")).toMatchObject({
        outcome: "notRecorded",
        errorCode: "unwired",
      });

      // Earlier deps answer, through their own core.
      restores.push(setReplyDeps(earlierDeps));
      expect(await replyAlone("turn-t1412-earlier-1")).toMatchObject({ outcome: "replied", errorCode: null });
      expect(earlier.commits.map((commit) => commit.caller.turnId)).toEqual(["turn-t1412-earlier-1"]);

      // install(): the root's own replies, the turn loop's keyword commit. No turn runs under this id, so it answers
      // notInTurn and records nothing; the earlier core is never asked.
      expect(root.replies.core).toBe(turnReplyCore);
      const restoreRoot = root.install();
      try {
        expect(await replyAlone("turn-t1412-installed")).toMatchObject({
          outcome: "notRecorded",
          errorCode: "notInTurn",
        });
        expect(earlier.commits).toHaveLength(1);
      } finally {
        restoreRoot();
      }

      // restore(): the earlier deps are back, and answer again.
      expect(await replyAlone("turn-t1412-earlier-2")).toMatchObject({ outcome: "replied", errorCode: null });
      expect(earlier.commits.map((commit) => commit.caller.turnId)).toEqual([
        "turn-t1412-earlier-1",
        "turn-t1412-earlier-2",
      ]);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
  });

  it("the replies' rows are the turn's own plan calls: each request handed on and each answer handed back as it comes, an error among them", async () => {
    const fakes = skeletonFakes();
    const seen: unknown[] = [];
    const unplanned = { error: "transient", sqlstate: "40001" } as const;
    const written = { result: "written", outboxRowId: "out-t1412-0401", version: 2 } as const;
    const root = composeRoot({
      environment: "test",
      sets: {
        fake: {
          ...fakes.ports,
          dataAccess: {
            rows: {
              unplannedRows: (request) => {
                seen.push(["unplannedRows", request]);
                return Promise.resolve(unplanned);
              },
              writePlan: (request) => {
                seen.push(["writePlan", request]);
                return Promise.resolve(written);
              },
            },
          },
        },
      },
      actors: null,
      vars: env,
      clock: fakes.clock,
    });
    const plan = {
      outboxRowId: "out-t1412-0401",
      expectVersion: 1,
      plan: {
        row: "out-t1412-0401",
        channel: "imessage",
        copyOf: null,
        plan: { formats: ["text"], lines: [], question: null, pageType: null, threadReplyTo: null },
      },
      finalParts: {
        row: "out-t1412-0401",
        channel: "imessage",
        sends: [{ kind: "words", text: STOP_WORDS, calendarFile: "none", options: [], link: null }],
        fixedLines: [STOP_REPLY],
        slotValues: [],
        threadReplyTo: null,
      },
    } satisfies WritePlanRequest;

    expect(await root.replies.rows.unplannedRows({ turnId: "turn-t1412-0401" })).toEqual(unplanned);
    expect(await root.replies.rows.writePlan(plan)).toEqual(written);
    expect(seen).toEqual([
      ["unplannedRows", { turnId: "turn-t1412-0401" }],
      ["writePlan", plan],
    ]);
  });
});

// ---- Rosie's number, read at each use ------------------------------------------------------------------------------

describe("Rosie's number for HELP's words is a reader called at each use, never as the root is built", () => {
  it("RootOptions.rosieNumber: read at each use, not at build or install; blank with none, for a reader that throws, and for one that answers no string", () => {
    let reads = 0;
    let current = ROSIE;
    const { root } = plainRoot({
      rosieNumber: () => {
        reads += 1;
        return current;
      },
    });
    const restore = root.install();
    try {
      expect(reads).toBe(0);
      expect(root.replies.rosieNumber).toBe(ROSIE);
      current = OTHER_ROSIE;
      expect(root.replies.rosieNumber).toBe(OTHER_ROSIE);
      expect(reads).toBe(2);
    } finally {
      restore();
    }

    expect(plainRoot().root.replies.rosieNumber).toBe("");
    expect(plainRoot({ rosieNumber: null }).root.replies.rosieNumber).toBe("");
    const throwing = plainRoot({
      rosieNumber: () => {
        throw new Error("no number to read");
      },
    });
    expect(throwing.root.replies.rosieNumber).toBe("");
    const notAString = plainRoot({ rosieNumber: () => 42 as unknown as string });
    expect(notAString.root.replies.rosieNumber).toBe("");
  });

  /**
   * A Worker env double for `environment`, with ROSIE_NUMBER as given, whose every read is counted; `values` is what it
   * holds, which a test may change after the root is built.
   */
  function countingEnv(
    environment: string,
    rosieNumber: string | undefined,
  ): { env: StagingEnv; values: Record<string, unknown>; reads: string[] } {
    const reads: string[] = [];
    const values: Record<string, unknown> = {
      ENVIRONMENT: environment,
      BASE_PATH: environment === "staging" ? "/test" : "",
      GIT_SHA: "test-sha",
      ...(rosieNumber === undefined ? {} : { ROSIE_NUMBER: rosieNumber }),
    };
    const counted = new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === "string") reads.push(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { env: counted as unknown as StagingEnv, values, reads };
  }

  it("staging's hand-off: ROSIE_NUMBER when E.164 by the test-phone page's check, read at each call and never at build; blank when missing or malformed; none anywhere but staging, with nothing read but ENVIRONMENT", () => {
    const staging = countingEnv("staging", ROSIE);
    const reader = stagingRosieNumber(staging.env);
    if (reader === null) throw new Error("staging hands no reader");
    expect(staging.reads).toEqual(["ENVIRONMENT"]);
    expect(reader()).toBe(ROSIE);
    expect(staging.reads).toEqual(["ENVIRONMENT", "ROSIE_NUMBER"]);
    // Read again at the next call: a changed var is the one HELP's words get.
    staging.values.ROSIE_NUMBER = OTHER_ROSIE;
    expect(reader()).toBe(OTHER_ROSIE);

    for (const malformed of [undefined, "", "+1 555-555-0199", "15555550199", ` ${ROSIE}`]) {
      const read = stagingRosieNumber(countingEnv("staging", malformed).env);
      expect(read?.(), String(malformed)).toBe("");
    }

    for (const environment of ["production", "test", "preview", ""]) {
      const elsewhere = countingEnv(environment, ROSIE);
      expect(stagingRosieNumber(elsewhere.env), environment).toBeNull();
      expect(elsewhere.reads, environment).toEqual(["ENVIRONMENT"]);
    }
  });

  it("workerRoot hands staging's reader in: on staging the root's replies read ROSIE_NUMBER at each use, never as the root is built; in production none, and ROSIE_NUMBER is never read", () => {
    const staging = countingEnv("staging", ROSIE);
    const stagingRoot = workerRoot(staging.env);
    expect(staging.reads).not.toContain("ROSIE_NUMBER");
    expect(stagingRoot.replies.rosieNumber).toBe(ROSIE);
    expect(staging.reads.filter((read) => read === "ROSIE_NUMBER")).toHaveLength(1);
    expect(stagingRoot.replies.core).toBe(turnReplyCore);

    const production = countingEnv("production", ROSIE);
    const productionRoot = workerRoot(production.env);
    expect(productionRoot.replies.rosieNumber).toBe("");
    expect(productionRoot.replies.core).toBe(turnReplyCore);
    expect(production.reads).not.toContain("ROSIE_NUMBER");
  });
});
