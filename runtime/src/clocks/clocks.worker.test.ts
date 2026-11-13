// The clock rows, run inside the Workers runtime (T-254). The handle actor is the real Durable Object
// (`exports.HandleActor`, its alarm fired with `runDurableObjectAlarm`); the minute sweep is the Worker's own scheduled
// handler (runtime/src/index.ts), handed the actor namespace (env.staging also binds HANDLE_ACTOR since T-566); the fake
// clock is the actor's stored schedule's (`setBatchHooks`), so "due" is tested against it, and the sweep's now is the
// cron's scheduled time. Doubles: src/clocks/test-support.ts (K-05 dueClocks, K-09 gateAndCommit over K-05 fireClock's
// rules, readActiveBundle, the directory). Test method: T-1128's (runtime/src/spikes/do-test-pool/FINDINGS.md). Test
// values only (rule 9).
import {
  createExecutionContext,
  createScheduledController,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import dueForSweep from "../../../contracts/data-access/fixtures/due-for-sweep.json";
import fireOnceFixture from "../../../contracts/data-access/fixtures/fire-once.json";
import fireRepeat from "../../../contracts/data-access/fixtures/fire-repeat.json";
import { setBatchHooks, turnIdOf, type HandleActor } from "../actor";
import { unconfiguredGateway } from "../gateway";
import { createWorker } from "../index";
import {
  CLOCK_RETRY_MS,
  fireNow,
  setClockDeps,
  SCHEDULE_CLOCK,
  type ClockActors,
  type ClockGateRequest,
  type DueClock,
  type FireBy,
  type FireReport,
} from "./index";
import { A7_03, ALEX_ACTOR, ALEX_HANDLE, fakeClocks, MONTHLY, rowAt, type FakeClocks } from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOG = { environment: "staging", version: "test-sha" };

let now = 0;
let undo: (() => void)[] = [];

/** Sets the actor's fake clock. */
function at(utc: string): void {
  now = Date.parse(utc);
}

beforeEach(() => {
  undo.push(setBatchHooks({ clock: { now: () => now } }));
});

afterEach(async () => {
  for (const restore of undo.reverse()) restore();
  undo = [];
  vi.restoreAllMocks();
  await reset();
});

/** The doubles, set as the clocks' ports for this test. */
function wire(): FakeClocks {
  const fake = fakeClocks();
  undo.push(setClockDeps(fake.deps));
  return fake;
}

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

function stubOf(name: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(name));
}

/** The actor's clock calls over RPC, typed here. */
interface ClockRpc {
  syncClocks(handleId: string): Promise<FireReport[]>;
  fireClockRow(request: { row: DueClock; by: FireBy }): Promise<FireReport>;
}

function clocksOf(name: string): ClockRpc {
  return stubOf(name);
}

/** The namespace as the sweep and Fire now reach an actor. */
function actors(): ClockActors<DurableObjectId> {
  const ns = namespace();
  return {
    idFromName: (name) => ns.idFromName(name),
    get: (id) => ns.get(id),
  };
}

/** The clock entry of the actor's stored schedule (on the actor's clock), or null. */
function clockEntry(name: string): Promise<number | null> {
  return runInDurableObject(
    stubOf(name),
    (_instance: HandleActor, state) =>
      state.storage.sql
        .exec<{ due_ms: number }>("SELECT due_ms FROM batch_schedule WHERE kind = ?", SCHEDULE_CLOCK)
        .toArray()[0]?.due_ms ?? null,
  );
}

function alarmOf(name: string): Promise<number | null> {
  return runInDurableObject(stubOf(name), (_instance: HandleActor, state) => state.storage.getAlarm());
}

/** Runs the Worker's scheduled handler at the cron time `utc`, as T-278's trigger would, and waits for its work. */
async function sweepAt(utc: string): Promise<void> {
  const worker = createWorker(
    () => unconfiguredGateway(),
    () => actors(),
  );
  const ctx = createExecutionContext();
  worker.scheduled(
    createScheduledController({ scheduledTime: Date.parse(utc), cron: "* * * * *" }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
}

const ids = (requests: ClockGateRequest[]): [string, FireBy][] =>
  requests.map((request) => [request.input.clockRowId, request.input.by]);

/** A clock turn on a handle, as one builder makes it for every caller (K-09 README "A clock's firing"; clockTurn). */
async function expectClockTurn(request: ClockGateRequest | undefined, clockRowId: string): Promise<void> {
  const turnId = await turnIdOf([clockRowId]);
  expect(request?.caller).toEqual({
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: A7_03.businessId,
    personId: null,
    traceId: request?.turn?.traceId,
  });
  expect(request?.turn).toMatchObject({
    id: turnId,
    handleId: ALEX_HANDLE,
    eventIds: [clockRowId],
    bundleId: fireOnceFixture.request.turn.bundleId,
    joinedTraceIds: [],
    tries: 1,
  });
  expect(request?.input).toMatchObject({ kind: "clock", clockRowId, jobId: `job-fire-${clockRowId}` });
  expect(request?.core).toEqual([]);
  expect(request?.now).toBe(request?.input.firedAt);
  expect(Object.keys(request ?? {}).sort()).toEqual(["caller", "core", "input", "now", "turn"]);
}

describe("each actor's one alarm at its earliest clock row", () => {
  it("rows due at 10:00 and 09:00: the alarm is set for 09:00, fires that row, and re-arms for 10:00", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-1000", "2026-10-24T10:00:00Z"));
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    at("2026-10-24T08:00:00Z");

    expect(await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE)).toEqual([]);
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse("2026-10-24T09:00:00Z"));
    expect(await alarmOf(ALEX_ACTOR)).not.toBeNull();
    expect(fake.gateRequests).toEqual([]);

    at("2026-10-24T09:00:00Z");
    expect(await runDurableObjectAlarm(stubOf(ALEX_ACTOR))).toBe(true);
    expect(ids(fake.gateRequests)).toEqual([["clock-alex-0900", "alarm"]]);
    expect(fake.stateOf("clock-alex-0900")).toBe("fired");
    expect(fake.stateOf("clock-alex-1000")).toBe("armed");
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse("2026-10-24T10:00:00Z"));
    expect(await alarmOf(ALEX_ACTOR)).not.toBeNull();

    at("2026-10-24T10:00:00Z");
    expect(await runDurableObjectAlarm(stubOf(ALEX_ACTOR))).toBe(true);
    expect(ids(fake.gateRequests)).toEqual([
      ["clock-alex-0900", "alarm"],
      ["clock-alex-1000", "alarm"],
    ]);
    expect(await clockEntry(ALEX_ACTOR)).toBeNull();
    expect(await alarmOf(ALEX_ACTOR)).toBeNull();
  });

  it("an alarm that comes before the clock entry is due fires nothing and keeps the entry", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    at("2026-10-24T08:00:00Z");
    await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);

    at("2026-10-24T08:30:00Z");
    await runDurableObjectAlarm(stubOf(ALEX_ACTOR));
    expect(fake.gateRequests).toEqual([]);
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse("2026-10-24T09:00:00Z"));
  });

  it("a firing the gate cannot take leaves the row armed and looks again in 60 s; unwired, no entry is kept", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    at("2026-10-24T09:00:00Z");
    fake.gateAnswer = { error: "transient", sqlstate: "40001" };

    const [report] = await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);
    expect(report).toMatchObject({
      clockRowId: "clock-alex-0900",
      outcome: "failed",
      errorCode: "transient",
    });
    expect(fake.stateOf("clock-alex-0900")).toBe("armed");
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse("2026-10-24T09:00:00Z") + CLOCK_RETRY_MS);

    // The ports taken away (a deploy before D-017's join): the alarm drops the entry instead of coming back for it.
    for (const restore of undo.splice(1).reverse()) restore();
    at("2026-10-24T09:01:00Z");
    await runDurableObjectAlarm(stubOf(ALEX_ACTOR));
    expect(await clockEntry(ALEX_ACTOR)).toBeNull();
  });

  it("a row of another handle is refused by the actor, with nothing sent", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    at("2026-10-24T08:00:00Z");
    await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);

    const other = rowAt("clock-sam-0900", "2026-10-24T08:00:00Z", "handle-sam");
    fake.arm(other);
    const report = await clocksOf(ALEX_ACTOR).fireClockRow({ row: other, by: "sweep" });
    expect(report).toMatchObject({ outcome: "refused", errorCode: "wrongHandle" });
    expect(fake.gateRequests).toEqual([]);
    expect(fake.stateOf("clock-sam-0900")).toBe("armed");
  });
});

describe("the minute sweep", () => {
  it("fires a missed row through its handle's actor and a row no handle owns as a job (due-for-sweep.json)", async () => {
    const fake = wire();
    for (const row of dueForSweep.outcome.rows) fake.arm(row as unknown as DueClock);
    at(dueForSweep.request.now);

    await sweepAt(dueForSweep.request.now);

    expect(fake.dueRequests[0]).toEqual(dueForSweep.request);
    const byRow = new Map(fake.gateRequests.map((request) => [request.input.clockRowId, request]));
    expect([...byRow.keys()].sort()).toEqual([MONTHLY.clockRowId, A7_03.clockRowId].sort());

    // Monthly billing, which no handle owns: a firing with no turn (caller clockFiring, the clock row's id as the key).
    const billing = byRow.get(MONTHLY.clockRowId);
    expect(billing?.turn).toBeNull();
    expect(billing?.caller).toMatchObject({
      kind: "clockFiring",
      turnId: null,
      requestId: MONTHLY.clockRowId,
      businessId: null,
      personId: null,
    });
    expect(billing?.input).toMatchObject({
      kind: "clock",
      expectVersion: 1,
      by: "sweep",
      jobId: `job-fire-${MONTHLY.clockRowId}`,
    });

    // A7-03's row, missed by Alex's actor: a clock turn on Alex's handle, fired by that actor, which now names it.
    const missed = byRow.get(A7_03.clockRowId);
    await expectClockTurn(missed, A7_03.clockRowId);
    expect(missed?.input).toMatchObject({ expectVersion: 2, by: "sweep" });
    const named = await runInDurableObject(stubOf(ALEX_ACTOR), (_instance: HandleActor, state) =>
      state.storage.sql.exec<{ handle_id: string }>("SELECT handle_id FROM clock_handle").toArray(),
    );
    expect(named).toEqual([{ handle_id: ALEX_HANDLE }]);

    expect(fake.stateOf(MONTHLY.clockRowId)).toBe("fired");
    expect(fake.stateOf(A7_03.clockRowId)).toBe("fired");
    expect(fake.fireCalls.map((call) => call.answer.repeated)).toEqual([false, false]);
  });

  it("leaves a handle's row armed when no actor can be named for it, and fires nothing unwired", async () => {
    const fake = wire();
    fake.arm(A7_03);
    fake.directory.clear();
    at("2026-10-24T14:06:30Z");
    await sweepAt("2026-10-24T14:06:30Z");
    expect(fake.gateRequests).toEqual([]);
    expect(fake.stateOf(A7_03.clockRowId)).toBe("armed");

    for (const restore of undo.splice(1).reverse()) restore();
    await sweepAt("2026-10-24T14:07:30Z");
    expect(fake.dueRequests).toHaveLength(1);
  });
});

describe("fire once", () => {
  it("the alarm and the sweep firing one row at the same moment fire it once (fire-once.json)", async () => {
    const fake = wire();
    fake.arm(A7_03);
    at("2026-10-24T14:05:00Z");
    await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse(A7_03.dueAt));

    // Over a minute late, so the sweep counts the row as missed while the alarm fires it: both at once.
    at(fireRepeat.given.now);
    fake.slow = true;
    await Promise.all([runDurableObjectAlarm(stubOf(ALEX_ACTOR)), sweepAt(fireRepeat.given.now)]);

    expect(fake.writtenOutbox).toEqual(["out-sam-a7-03-defaulted"]);
    expect(fake.stateOf(A7_03.clockRowId)).toBe("fired");
    const [first, ...repeats] = fake.fireCalls;
    const turnId = await turnIdOf([A7_03.clockRowId]);
    // The one firing: fire-once.json's request and outcome, by whichever came first, under the clock turn's own id and
    // trace, at the moment both fired.
    expect(first?.request).toMatchObject({
      clockRowId: fireOnceFixture.request.clockRowId,
      expectVersion: fireOnceFixture.request.expectVersion,
      firedAt: fireRepeat.given.now,
      jobId: fireOnceFixture.request.jobId,
      versionsRead: fireOnceFixture.request.versionsRead,
      writes: fireOnceFixture.request.writes,
    });
    const turn = first?.request.turn as Json | undefined;
    expect(turn).toEqual({ ...fireOnceFixture.request.turn, id: turnId, traceId: turn?.traceId });
    expect(turn?.traceId).toMatch(UUID);
    expect(first?.answer).toEqual({ ...fireOnceFixture.outcome, firedAt: fireRepeat.given.now, turnId });
    // Any second call that reached the gate came back as fire-repeat.json: the first firing, nothing written.
    for (const repeat of repeats) {
      expect(repeat.answer).toEqual({ ...fireRepeat.outcome, firedAt: fireRepeat.given.now, turnId });
    }
    expect(await clockEntry(ALEX_ACTOR)).toBeNull();
  });

  it("a row fired once answers repeated when it is fired again, and writes nothing (fire-repeat.json)", async () => {
    const fake = wire();
    fake.arm(A7_03);
    at(fireOnceFixture.request.firedAt);
    const row = fake.rowOf(A7_03.clockRowId);

    const once = await clocksOf(ALEX_ACTOR).fireClockRow({ row, by: "sweep" });
    const again = await clocksOf(ALEX_ACTOR).fireClockRow({ row, by: "sweep" });

    expect(once).toMatchObject({ outcome: "fired", repeated: false });
    expect(again).toMatchObject({ outcome: "fired", repeated: true, turnId: once.turnId });
    expect(fake.writtenOutbox).toEqual(["out-sam-a7-03-defaulted"]);
    expect(fake.fireCalls[0]?.answer).toEqual({ ...fireOnceFixture.outcome, turnId: once.turnId });
    expect(fake.fireCalls[1]?.answer).toEqual({
      ...fireRepeat.outcome,
      firedAt: fireOnceFixture.request.firedAt,
      turnId: once.turnId,
    });
  });
});

describe("staging's Fire now", () => {
  it("calls the same function the alarm calls: one request builder, by fireNow, before the row is due", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-1000", "2026-10-24T10:00:00Z"));
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    at("2026-10-24T08:00:00Z");
    await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);

    // Two hours early: K-05 fireClock lets fireNow fire before the due time, on staging only (BP 9.4).
    const early = await fireNow({
      row: fake.rowOf("clock-alex-1000"),
      actors: actors(),
      environment: "staging",
      log: LOG,
    });
    expect(early).toMatchObject({
      clockRowId: "clock-alex-1000",
      by: "fireNow",
      outcome: "fired",
      repeated: false,
    });
    expect(await clockEntry(ALEX_ACTOR)).toBe(Date.parse("2026-10-24T09:00:00Z"));

    at("2026-10-24T09:00:00Z");
    await runDurableObjectAlarm(stubOf(ALEX_ACTOR));

    expect(ids(fake.gateRequests)).toEqual([
      ["clock-alex-1000", "fireNow"],
      ["clock-alex-0900", "alarm"],
    ]);
    await expectClockTurn(fake.gateRequests[0], "clock-alex-1000");
    await expectClockTurn(fake.gateRequests[1], "clock-alex-0900");
    // Both read the actor's holds and unread texts at commit time, through the same host.
    expect(fake.contexts).toEqual([
      { holds: [], unread: [] },
      { holds: [], unread: [] },
    ]);
    // Nothing is left: the row Fire now fired never fires again.
    expect(await clockEntry(ALEX_ACTOR)).toBeNull();
  });

  it("Fire now and the alarm on one row at the same moment share one firing (the same in-flight guard)", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    at("2026-10-24T08:59:00Z");
    await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);

    at("2026-10-24T09:00:00Z");
    fake.slow = true;
    const [, byNow] = await Promise.all([
      runDurableObjectAlarm(stubOf(ALEX_ACTOR)),
      fireNow({ row: fake.rowOf("clock-alex-0900"), actors: actors(), environment: "staging", log: LOG }),
    ]);
    expect(byNow.outcome).toBe("fired");
    expect(fake.fireCalls.filter((call) => call.answer.repeated === false)).toHaveLength(1);
    expect(fake.stateOf("clock-alex-0900")).toBe("fired");
  });

  it("is refused anywhere but staging, before anything is read or sent", async () => {
    const fake = wire();
    fake.arm(rowAt("clock-alex-1000", "2026-10-24T10:00:00Z"));
    at("2026-10-24T08:00:00Z");

    const answer = await fireNow({
      row: fake.rowOf("clock-alex-1000"),
      actors: actors(),
      environment: "production",
      log: LOG,
    });
    expect(answer).toMatchObject({ outcome: "refused", errorCode: "notStaging" });
    expect(fake.gateRequests).toEqual([]);
    expect(fake.dueRequests).toEqual([]);
    expect(fake.stateOf("clock-alex-1000")).toBe("armed");
  });
});

describe("traces", () => {
  it("each firing opens its own trace id (CQ-06), under its job id, and no row's words reach a log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fake = wire();
    fake.arm(rowAt("clock-alex-0900", "2026-10-24T09:00:00Z"));
    fake.arm(rowAt("clock-alex-0900b", "2026-10-24T09:00:00Z"));
    fake.arm(rowAt("clock-billing-0900", "2026-10-24T09:00:00Z", null));
    at("2026-10-24T09:00:30Z");

    await clocksOf(ALEX_ACTOR).syncClocks(ALEX_HANDLE);
    await sweepAt("2026-10-24T09:00:30Z");

    const lines = log.mock.calls.map((call) => String(call[0]));
    const spans = lines
      .map((line) => JSON.parse(line) as Json)
      .filter((line) => line.msg === "span" && line.hop === "clockFired");
    expect(spans).toHaveLength(3);
    const traceIds = spans.map((span) => span.trace_id as string);
    expect(new Set(traceIds).size).toBe(3);
    for (const traceId of traceIds) expect(traceId).toMatch(UUID);
    expect(spans.map((span) => span.job_id).sort()).toEqual([
      "job-fire-clock-alex-0900",
      "job-fire-clock-alex-0900b",
      "job-fire-clock-billing-0900",
    ]);
    expect(spans.every((span) => span.outcome === "ok")).toBe(true);
    // Each request names its firing's trace, on the caller and on the clock turn alike.
    expect(fake.gateRequests.map((request) => request.caller.traceId).sort()).toEqual([...traceIds].sort());
    for (const request of fake.gateRequests) {
      if (request.turn !== null) expect(request.turn.traceId).toBe(request.caller.traceId);
      const span = spans.find((line) => line.trace_id === request.caller.traceId);
      expect(span?.turn_id).toBe(request.turn?.id ?? null);
    }
    const everything = lines.join("\n");
    expect(everything).not.toContain("the time stays as booked");
    expect(everything).not.toContain("+15555550101");
    expect(lines.some((line) => line.includes('"msg":"clockSweep"'))).toBe(true);
  });
});
