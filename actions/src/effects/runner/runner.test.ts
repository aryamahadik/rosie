// The effects runner's proofs (T-323, "Proves it with"; fake clock, fake port, fake repo with claim semantics):
//   1. 5 network errors in 10 minutes write the outage row and stop;
//   2. a decline is recorded once with no retry;
//   3. every port call carries the row's idempotency key;
//   4. a repeated claim of a finished row does nothing;
//   5. two runners claiming in parallel never call the port twice for one row.
// Every request the runner sends passes K-05 v1.1's schema (the fake repo refuses any other), every row's life passes
// K-07 v1's effectLife and its named rule lifeChain, and every span passes K-08 v1's span.

import { describe, expect, it } from "vitest";

import type { Span } from "../../../../runtime/src/trace";
import { kindsOf, type EffectKind, type EffectRow, type KindPorts } from "../kinds";
import {
  EFFECT_TRIES,
  EFFECT_WINDOW_MS,
  EffectsRunnerError,
  createEffectsRunner,
  type ClaimedEffect,
  type EffectRepo,
  type EffectsRunnerDeps,
  type SpanRefusedReport,
} from "./index";
import {
  FakeClock,
  FakeEffectRepo,
  FakeKindPort,
  after,
  calendarWrite,
  contactAdd,
  contractChecks,
  declined,
  depositCharge,
  diedClock,
  fixtureEffect,
  k07Rules,
  networkError,
  ok,
  portsFor,
  readContractJson,
  spanRecorder,
  variant,
  type Script,
} from "./test-support";

const START = "2026-11-07T15:06:33Z";
const COMMITTED = "2026-11-07T15:06:30Z";
const MINUTE = 60_000;
const ms = (instant: string): number => Date.parse(instant);

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}

interface Harness {
  clock: FakeClock;
  repo: FakeEffectRepo;
  spans: Span[];
  refused: SpanRefusedReport[];
  runner(
    claimer: string,
    kinds: KindPorts,
    extra?: Partial<EffectsRunnerDeps>,
  ): ReturnType<typeof createEffectsRunner>;
}

function harness(start = START): Harness {
  const clock = new FakeClock(start);
  const repo = new FakeEffectRepo();
  const { spans, traceOf } = spanRecorder(clock);
  const refused: SpanRefusedReport[] = [];
  return {
    clock,
    repo,
    spans,
    refused,
    runner: (claimer, kinds, extra = {}) =>
      createEffectsRunner({
        claimer,
        repo,
        kinds,
        traceOf,
        clock,
        zoneOf: () => Promise.resolve("America/New_York"),
        onSpanRefused: (report) => {
          refused.push(report);
        },
        ...extra,
      }),
  };
}

const calendarPorts = (port: FakeKindPort): KindPorts => portsFor(kindsOf("calendar"), port);
const stripePorts = (port: FakeKindPort): KindPorts => portsFor(kindsOf("stripe"), port);
const linqPorts = (port: FakeKindPort): KindPorts => portsFor(kindsOf("linq"), port);

async function expectLifeAccepted(repo: FakeEffectRepo, effectId: string): Promise<void> {
  const life = repo.life(effectId);
  expect(contractChecks().k07("effectLife", life)).toEqual([]);
  const { lifeChain } = await k07Rules();
  expect(lifeChain(life)).toEqual([]);
}

function expectSpansAccepted(spans: readonly Span[]): void {
  for (const span of spans) expect(contractChecks().span(span)).toEqual([]);
}

/** Every slot of a run whose first try went at `firstTryAt`: 0, 2, 4, 6 and 8 minutes after it. */
const slots = (firstTryAt: string): string[] =>
  [0, 2, 4, 6, 8].map((minutes) =>
    new Date(ms(firstTryAt) + minutes * MINUTE).toISOString().replace(".000Z", "Z"),
  );

// ---- 1 -------------------------------------------------------------------------------------------------------------

describe("effects runner: 5 network errors in 10 minutes write the outage row and stop", () => {
  it("tries a failing calendar write 5 times, at 0, 2, 4, 6 and 8 minutes, then records the outage row and stops", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => networkError("503"));
    const runner = h.runner("effects-runner-1", calendarPorts(port));

    const report = await h.clock.drive(runner.runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "outage", refusal: null, calls: EFFECT_TRIES },
    ]);
    expect(port.calls.map((call) => call.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(port.calls.map((call) => call.at)).toEqual(slots(START));
    const lastTry = ms(must(port.calls.at(-1)).at);
    expect(lastTry - ms(START)).toBeLessThanOrEqual(EFFECT_WINDOW_MS);

    const results = h.repo.results.map((result) => result.request);
    expect(results.map((request) => request.outcome)).toEqual(Array<string>(5).fill("networkError"));
    expect(results.map((request) => request.nextTryAt)).toEqual([...slots(START).slice(1), null]);
    expect(
      h.repo.results.map((result) => ("error" in result.answer ? result.answer.error : result.answer.state)),
    ).toEqual(["running", "running", "running", "running", "outage"]);
    const fifth = must(results[4]).events[0];
    expect(fifth.newValues).toEqual({ state: "outage", tries: 5, runs: 1, errorCode: "503" });
    expect(fifth.why).toEqual({ try: 5, outcome: "networkError", outage: "calendar" });

    const held = h.repo.held(row.effectId);
    expect(held.row).toMatchObject({
      state: "outage",
      tries: 5,
      runs: 1,
      errorCode: "503",
      firstTryAt: START,
    });
    expect(held.claimedBy).toBeNull();
    expect(held.claimLapsesAt).toBeNull();
    await expectLifeAccepted(h.repo, row.effectId);

    // It stops: an hour later nothing is claimed and no 6th call goes; the row waits for serviceBack.
    await h.clock.advanceTo(ms(START) + 60 * MINUTE);
    const later = await h.clock.drive(runner.runDue());
    expect(later.rows).toEqual([]);
    expect(port.calls).toHaveLength(EFFECT_TRIES);
    expect(h.clock.sleeping).toBe(0);
  });

  it("writes one effectRun span per try, the 5th naming the outage row, with labels and ids only", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => networkError("503"));
    await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(h.spans).toHaveLength(5);
    expectSpansAccepted(h.spans);
    expect(h.spans.map((span) => [span.hop, span.provider, span.call, span.attempt, span.outcome])).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ["effectRun", "google_calendar", "calendarWrite", attempt, "failed"]),
    );
    expect(must(h.spans.at(-1)).decided).toMatchObject({
      outageRow: true,
      recorded: "outage",
      nextTryAt: null,
    });
    expect(must(h.spans[0]).got).toEqual({
      effect: row.effectId,
      booking: row.bookingId,
      kind: "calendar_write",
      run: 1,
      previousTry: null,
    });
    expect(must(h.spans[0]).business_id).toBe(row.businessId);
    expect(h.refused).toEqual([]);
  });

  it("sends the 5th try's result exactly as K-05 v1.1 effect-fifth-try-outage.json does", async () => {
    const fixture = readContractJson("data-access/fixtures/effect-fifth-try-outage.json") as {
      request: unknown;
      outcome: unknown;
    };
    const h = harness("2026-11-07T15:14:11Z");
    const row: EffectRow = { ...calendarWrite(), state: "running", tries: 4, errorCode: "503" };
    h.repo.put(
      {
        row,
        version: 7,
        claimedBy: "effects-runner-2",
        claimLapsesAt: "2026-11-07T15:15:11Z",
        lastTryAt: "2026-11-07T15:11:11Z",
      },
      COMMITTED,
    );
    const claimed: ClaimedEffect = {
      effect: row as ClaimedEffect["effect"],
      version: 7,
      claimedFrom: "running",
      claimedBy: "effects-runner-2",
      claimLapsesAt: "2026-11-07T15:15:11Z",
    };
    const port = new FakeKindPort(h.clock, () => networkError("503"));

    const rows = await h.clock.drive(h.runner("effects-runner-2", calendarPorts(port)).run([claimed]));

    expect(rows).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "outage", refusal: null, calls: 1 },
    ]);
    expect(h.repo.results).toHaveLength(1);
    expect(must(h.repo.results[0]).request).toEqual(fixture.request);
    expect(must(h.repo.results[0]).answer).toEqual(fixture.outcome);
  });
});

// ---- 2 -------------------------------------------------------------------------------------------------------------

describe("effects runner: a decline is recorded once with no retry", () => {
  it("records a declined deposit once, calls the port once, and never claims the row again", async () => {
    const h = harness("2026-11-07T15:30:01Z");
    const row = depositCharge();
    h.repo.seed(row, "2026-11-07T15:30:00Z");
    const port = new FakeKindPort(h.clock, () => declined("card_declined"));
    const runner = h.runner("effects-runner-1", stripePorts(port));

    const report = await h.clock.drive(runner.runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "stripe_charge", end: "declined", refusal: null, calls: 1 },
    ]);
    expect(port.calls).toHaveLength(1);
    expect(h.repo.results).toHaveLength(1);
    const request = must(h.repo.results[0]).request;
    expect(request).toMatchObject({
      outcome: "declined",
      errorCode: "card_declined",
      nextTryAt: null,
      providerObjectId: null,
      ledgerLineId: null,
    });
    expect(request.events[0]).toMatchObject({
      id: `log-${row.effectId}-run-1-try-1-declined`,
      kind: "effect.result",
      actorKind: "job",
      oldValues: { state: "running", tries: 0, runs: 1 },
      newValues: { state: "declined", tries: 1, runs: 1, errorCode: "card_declined" },
      why: { try: 1, outcome: "declined" },
    });
    expect(h.repo.held(row.effectId)).toMatchObject({ claimedBy: null, claimLapsesAt: null });
    expect(h.repo.held(row.effectId).row.state).toBe("declined");
    await expectLifeAccepted(h.repo, row.effectId);
    expect(must(h.spans[0])).toMatchObject({
      provider: "stripe",
      call: "charge",
      attempt: 1,
      outcome: "refused",
    });
    expect(must(h.spans[0]).error_code).toBe("card_declined");

    await h.clock.advanceTo(ms("2026-11-08T15:30:01Z"));
    const later = await h.clock.drive(runner.runDue());
    expect(later.rows).toEqual([]);
    expect(port.calls).toHaveLength(1);
    expect(h.repo.results).toHaveLength(1);
  });

  it("stops at a decline that follows network errors: no try after it", async () => {
    const h = harness("2026-11-07T15:30:01Z");
    const row = depositCharge();
    h.repo.seed(row, "2026-11-07T15:30:00Z");
    const port = new FakeKindPort(h.clock, (_call, nth) => (nth < 3 ? networkError("network") : declined()));

    const report = await h.clock.drive(h.runner("effects-runner-1", stripePorts(port)).runDue());

    expect(must(report.rows[0]).end).toBe("declined");
    expect(port.calls.map((call) => call.attempt)).toEqual([1, 2, 3]);
    expect(h.repo.results.map((result) => result.request.outcome)).toEqual([
      "networkError",
      "networkError",
      "declined",
    ]);
    expect(h.clock.sleeping).toBe(0);
    await expectLifeAccepted(h.repo, row.effectId);
  });
});

// ---- 3 -------------------------------------------------------------------------------------------------------------

describe("effects runner: every port call carries the row's idempotency key", () => {
  it("gives each kind's port the row's own key on every try, retries and every port included", async () => {
    const h = harness();
    const rows = [
      variant(calendarWrite(), "a"),
      variant(calendarWrite(), "b"),
      variant(depositCharge(), "c"),
      variant(contactAdd(), "d"),
    ];
    for (const row of rows) h.repo.seed(row, COMMITTED);
    const flaky: Script = (_call, nth) => (nth < 3 ? networkError("503") : ok("provider-object-demo"));
    const calendar = new FakeKindPort(h.clock, flaky);
    const stripe = new FakeKindPort(h.clock, flaky);
    const linq = new FakeKindPort(h.clock, flaky);
    const runner = h.runner("effects-runner-1", {
      ...calendarPorts(calendar),
      ...stripePorts(stripe),
      ...linqPorts(linq),
    });

    const report = await h.clock.drive(runner.runDue());

    expect(report.rows.map((row) => row.end)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    const calls = [...calendar.calls, ...stripe.calls, ...linq.calls];
    expect(calls).toHaveLength(12);
    for (const call of calls) {
      const key = h.repo.held(call.effectId).row.idempotencyKey;
      expect(key).toBe(`key-${call.effectId}`);
      expect(call.idempotencyKey).toBe(key);
      expect(call.rowKey).toBe(key);
    }
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(4);
    for (const row of rows) await expectLifeAccepted(h.repo, row.effectId);
  });

  it("never calls a port for a row with no idempotency key (K-07 v1 refuse-effect-without-key)", async () => {
    // K-05 v1.1's claim never answers such a row (its schema refuses it, so the fake repo cannot), while the table's
    // text column would hold an empty key: the runner holds the line itself, for a row handed to it by any path.
    const h = harness("2026-11-07T15:20:01Z");
    const keyless = fixtureEffect("outbox-effects/fixtures/invalid/refuse-effect-without-key.json");
    const emptyKey: EffectRow = { ...variant(depositCharge(), "empty"), idempotencyKey: "" };
    const claimed = [keyless, emptyKey].map((row): ClaimedEffect => ({
      effect: { ...row, state: "running", tries: 0, firstTryAt: "2026-11-07T15:20:01Z" },
      version: 2,
      claimedFrom: "pending",
      claimedBy: "effects-runner-1",
      claimLapsesAt: "2026-11-07T15:21:01Z",
    }));
    expect("idempotencyKey" in keyless).toBe(false);
    const port = new FakeKindPort(h.clock, () => ok());

    const rows = await h.clock.drive(h.runner("effects-runner-1", stripePorts(port)).run(claimed));

    expect(rows).toEqual(
      [keyless, emptyKey].map((row) => ({
        effectId: row.effectId,
        kind: "stripe_charge",
        end: "refused",
        refusal: "noIdempotencyKey",
        calls: 0,
      })),
    );
    expect(port.calls).toEqual([]);
    expect(h.repo.results).toEqual([]);
  });

  it("keeps no key in a span: ids, labels and counts only, never the key, the port request or an amount", async () => {
    const h = harness();
    const rows = [variant(depositCharge(), "e"), variant(contactAdd(), "f")];
    for (const row of rows) h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => ok("provider-object-demo"));
    await h.clock.drive(h.runner("effects-runner-1", { ...stripePorts(port), ...linqPorts(port) }).runDue());

    expect(h.spans).toHaveLength(2);
    expectSpansAccepted(h.spans);
    const logged = JSON.stringify(h.spans);
    for (const row of rows) expect(logged).not.toContain(row.idempotencyKey);
    for (const secret of ["card-demo-alex", "+15555550101", "savedCard", "purpose", "cents"]) {
      expect(logged).not.toContain(secret);
    }
    expect(h.spans.map((span) => [span.provider, span.call])).toEqual([
      ["stripe", "charge"],
      ["linq", "contactAdd"],
    ]);
  });
});

// ---- 4 -------------------------------------------------------------------------------------------------------------

describe("effects runner: a repeated claim of a finished row does nothing", () => {
  it("claims nothing again for a succeeded row, by the same runner or another, and calls no port", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => after(h.clock, 1_000, ok("gcal-event-demo-0001")));
    const first = h.runner("effects-runner-1", calendarPorts(port));
    const second = h.runner("effects-runner-2", calendarPorts(port));

    expect(must((await h.clock.drive(first.runDue())).rows[0]).end).toBe("succeeded");
    const claimed = must(h.repo.claims[0]).answer;
    expect((await h.clock.drive(first.runDue())).rows).toEqual([]);
    expect((await h.clock.drive(second.runDue())).rows).toEqual([]);

    // The same claim handed to the runner again (a redelivered message): a repeat, nothing called or sent.
    const again = "error" in claimed ? [] : claimed.claimed;
    expect(await h.clock.drive(first.run(again))).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "repeat", refusal: null, calls: 0 },
    ]);
    // The row as it stands, handed to another runner: not running, so never called.
    const finished: ClaimedEffect = {
      effect: h.repo.held(row.effectId).row as ClaimedEffect["effect"],
      version: h.repo.held(row.effectId).version,
      claimedFrom: "pending",
      claimedBy: "effects-runner-2",
      claimLapsesAt: "2026-11-07T15:07:34Z",
    };
    expect(await h.clock.drive(second.run([finished]))).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "refused", refusal: "notRunning", calls: 0 },
    ]);
    expect(port.calls).toHaveLength(1);
    expect(h.repo.results).toHaveLength(1);
  });

  it("does nothing for a row handed twice in one claim, or for a row already in its outage row", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => networkError("503"));
    const runner = h.runner("effects-runner-1", calendarPorts(port));
    await h.clock.drive(runner.runDue());
    expect(h.repo.held(row.effectId).row.state).toBe("outage");

    await h.clock.advanceTo(ms(START) + 30 * MINUTE);
    expect((await h.clock.drive(runner.runDue())).rows).toEqual([]);

    const h2 = harness();
    h2.repo.seed(row, COMMITTED);
    const port2 = new FakeKindPort(h2.clock, () => ok("gcal-event-demo-0001"));
    const claim = await h2.repo.claimEffects({ claimer: "effects-runner-1", now: START, limit: 10 });
    const claimedRows = "error" in claim ? [] : claim.claimed;
    const rows = await h2.clock.drive(
      h2.runner("effects-runner-1", calendarPorts(port2)).run([...claimedRows, ...claimedRows]),
    );
    expect(rows.map((each) => each.end).sort()).toEqual(["repeat", "succeeded"]);
    expect(port2.calls).toHaveLength(1);
  });

  it("does nothing for the same claim handed again after K-05 refused its result (claimLost)", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    h.repo.answerNextResults({
      error: "claimLost",
      table: "effects",
      rowId: row.effectId,
      claimer: "effects-runner-2",
      claimNo: null,
      state: "running",
    });
    const port = new FakeKindPort(h.clock, () => ok("gcal-event-demo-0001"));
    const runner = h.runner("effects-runner-1", calendarPorts(port));
    expect(must((await h.clock.drive(runner.runDue())).rows[0]).end).toBe("claimLost");
    const claim = must(h.repo.claims[0]).answer;

    const rows = await h.clock.drive(runner.run("error" in claim ? [] : claim.claimed));

    expect(rows).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "repeat", refusal: null, calls: 0 },
    ]);
    expect(port.calls).toHaveLength(1);
  });
});

// ---- 5 -------------------------------------------------------------------------------------------------------------

describe("effects runner: two runners claiming in parallel never call the port twice for one row", () => {
  it("splits 20 rows between two runners claiming at once, and calls each row's port once", async () => {
    const h = harness();
    const rows = Array.from({ length: 20 }, (_unused, index) =>
      variant(calendarWrite(), `p${String(index)}`),
    );
    for (const row of rows) h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => after(h.clock, 500, ok("gcal-event-demo")));
    const one = h.runner("effects-runner-1", calendarPorts(port), { limit: 7 });
    const two = h.runner("effects-runner-2", calendarPorts(port), { limit: 7 });

    let rounds = 0;
    while (rows.some((row) => h.repo.held(row.effectId).row.state === "pending")) {
      rounds += 1;
      const [a, b] = await h.clock.drive(Promise.all([one.runDue(), two.runDue()]));
      const mine = new Set(a.rows.map((row) => row.effectId));
      expect(b.rows.filter((row) => mine.has(row.effectId))).toEqual([]);
      expect(a.rows.length + b.rows.length).toBeGreaterThan(0);
    }

    expect(rounds).toBe(2);
    expect(port.overlaps).toEqual([]);
    for (const row of rows) {
      expect(port.callsFor(row.effectId)).toHaveLength(1);
      expect(h.repo.held(row.effectId).row.state).toBe("succeeded");
    }
    const byRunner = new Map<string, number>();
    for (const claim of h.repo.claims) {
      const count = "error" in claim.answer ? 0 : claim.answer.claimed.length;
      byRunner.set(claim.request.claimer, (byRunner.get(claim.request.claimer) ?? 0) + count);
    }
    expect(byRunner.get("effects-runner-1")).toBeGreaterThan(0);
    expect(byRunner.get("effects-runner-2")).toBeGreaterThan(0);
  });

  it("never overlaps two calls for one row while both runners retry network errors at once", async () => {
    const h = harness();
    const rows = Array.from({ length: 12 }, (_unused, index) =>
      variant(depositCharge(), `r${String(index)}`),
    );
    for (const row of rows) h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, (_call, nth) =>
      after(h.clock, 2_000, nth < 3 ? networkError("503") : ok("stripe-charge-demo")),
    );
    const one = h.runner("effects-runner-1", stripePorts(port), { limit: 6 });
    const two = h.runner("effects-runner-2", stripePorts(port), { limit: 6 });

    const [a, b] = await h.clock.drive(Promise.all([one.runDue(), two.runDue()]));

    expect(a.rows).toHaveLength(6);
    expect(b.rows).toHaveLength(6);
    expect(port.overlaps).toEqual([]);
    for (const row of rows) {
      expect(port.callsFor(row.effectId).map((call) => call.attempt)).toEqual([1, 2, 3]);
      expect(new Set(port.callsFor(row.effectId).map((call) => call.idempotencyKey))).toEqual(
        new Set([row.idempotencyKey]),
      );
      await expectLifeAccepted(h.repo, row.effectId);
    }
  });

  it("takes over a row whose runner died mid-wait only after its claim lapsed, on the same key, with no call doubled", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, (_call, nth) =>
      nth === 1 ? networkError("503") : ok("gcal-event-demo-0001"),
    );
    const dead = h.runner("effects-runner-1", calendarPorts(port), { clock: diedClock(h.clock) });
    const live = h.runner("effects-runner-2", calendarPorts(port));

    // effects-runner-1 claims, tries once, is told to try again at 15:08:33 and never wakes.
    void dead.runDue();
    await h.clock.advanceTo(ms(START));
    expect(port.calls).toHaveLength(1);
    expect(h.repo.held(row.effectId)).toMatchObject({
      claimedBy: "effects-runner-1",
      claimLapsesAt: "2026-11-07T15:09:33Z",
    });

    // While its claim lives, the other runner claims nothing.
    await h.clock.advanceTo(ms("2026-11-07T15:09:32Z"));
    expect((await h.clock.drive(live.runDue())).rows).toEqual([]);
    expect(port.calls).toHaveLength(1);

    // Once it lapsed, the other runner takes the row as it stands and makes try 2 on the same key.
    await h.clock.advanceTo(ms("2026-11-07T15:09:33Z"));
    const report = await h.clock.drive(live.runDue());
    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "succeeded", refusal: null, calls: 1 },
    ]);
    expect(port.calls.map((call) => [call.attempt, call.at, call.idempotencyKey])).toEqual([
      [1, START, row.idempotencyKey],
      [2, "2026-11-07T15:09:33Z", row.idempotencyKey],
    ]);
    expect(port.overlaps).toEqual([]);
    expect(must(h.repo.claims.at(-1)).answer).toMatchObject({ claimed: [{ claimedFrom: "running" }] });
    await expectLifeAccepted(h.repo, row.effectId);
  });

  it("never calls the port on a claim with too little time left for the call", async () => {
    const h = harness();
    const row: EffectRow = { ...calendarWrite(), state: "running", firstTryAt: START };
    const port = new FakeKindPort(h.clock, () => ok());
    const claimed: ClaimedEffect = {
      effect: row as ClaimedEffect["effect"],
      version: 2,
      claimedFrom: "pending",
      claimedBy: "effects-runner-1",
      claimLapsesAt: "2026-11-07T15:06:50Z",
    };

    const rows = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).run([claimed]));

    expect(rows).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "claimLapsed", refusal: null, calls: 0 },
    ]);
    expect(port.calls).toEqual([]);
  });

  it("stops at once when K-05 says another runner holds the row (claimLost)", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    h.repo.answerNextResults({
      error: "claimLost",
      table: "effects",
      rowId: row.effectId,
      claimer: "effects-runner-2",
      claimNo: null,
      state: "running",
    });
    const port = new FakeKindPort(h.clock, () => networkError("503"));

    const report = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(report.rows).toEqual([
      { effectId: row.effectId, kind: "calendar_write", end: "claimLost", refusal: null, calls: 1 },
    ]);
    expect(port.calls).toHaveLength(1);
    expect(h.clock.sleeping).toBe(0);
  });
});

// ---- the contract's own examples -------------------------------------------------------------------------------------

describe("effects runner: K-05 v1.1's fixtures", () => {
  it("claims as claim-effects.json does when it serves every port, and records try 1 as effect-result.json does", async () => {
    const claimFixture = readContractJson("data-access/fixtures/claim-effects.json") as {
      request: unknown;
      outcome: unknown;
    };
    const resultFixture = readContractJson("data-access/fixtures/effect-result.json") as {
      request: unknown;
      outcome: unknown;
    };
    const h = harness();
    h.repo.seed(calendarWrite(), COMMITTED);
    const port = new FakeKindPort(h.clock, () => after(h.clock, 1_000, ok("gcal-event-demo-0001")));
    const unused = new FakeKindPort(h.clock, () => ok());
    const runner = h.runner("effects-runner-1", {
      ...calendarPorts(port),
      ...stripePorts(unused),
      ...linqPorts(unused),
    });

    await h.clock.drive(runner.runDue());

    expect(must(h.repo.claims[0]).request).toEqual(claimFixture.request);
    expect(must(h.repo.claims[0]).answer).toEqual(claimFixture.outcome);
    expect(must(h.repo.results[0]).request).toEqual(resultFixture.request);
    expect(must(h.repo.results[0]).answer).toEqual(resultFixture.outcome);
  });

  it("claims only the rows of the ports whose every kind it has, and claims nothing with none", async () => {
    const h = harness();
    const calendarRow = calendarWrite();
    const stripeRow = depositCharge();
    h.repo.seed(calendarRow, COMMITTED);
    h.repo.seed(stripeRow, COMMITTED);
    const port = new FakeKindPort(h.clock, () => ok("provider-object-demo"));

    const report = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(report.ports).toEqual(["calendar"]);
    expect(must(h.repo.claims[0]).request.ports).toEqual(["calendar"]);
    expect(report.rows.map((row) => row.effectId)).toEqual([calendarRow.effectId]);
    expect(h.repo.held(stripeRow.effectId).row.state).toBe("pending");

    const partial: KindPorts = { stripe_charge: port, stripe_refund: port };
    const none = await h.clock.drive(h.runner("effects-runner-2", partial).runDue());
    expect(none).toEqual({ claim: "noPortServed", ports: [], rows: [] });
    expect(h.repo.claims).toHaveLength(1);
  });

  it("runs nothing when the claim answers transient", async () => {
    const h = harness();
    h.repo.seed(calendarWrite(), COMMITTED);
    h.repo.answerNextClaims({ error: "transient", sqlstate: "40001" });
    const port = new FakeKindPort(h.clock, () => ok());

    const report = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(report).toEqual({ claim: "transient", ports: ["calendar"], rows: [] });
    expect(port.calls).toEqual([]);
  });
});

// ---- what the claim and the budget hold --------------------------------------------------------------------------------

describe("effects runner: the port call's budget, faults and transient results", () => {
  it("counts a port that has not answered in 30 s as a network error, recorded before its claim lapses", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, (call, nth) =>
      nth === 1
        ? new Promise((_resolve, reject) => {
            call.signal.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted"));
              },
              { once: true },
            );
          })
        : ok("gcal-event-demo-0001"),
    );

    const report = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(must(report.rows[0]).end).toBe("succeeded");
    expect(must(port.calls[0]).signal.aborted).toBe(true);
    expect(must(port.calls[0]).answerBy).toBe("2026-11-07T15:07:03Z");
    const first = must(h.repo.results[0]).request;
    expect(first).toMatchObject({
      outcome: "networkError",
      errorCode: "timeout",
      at: "2026-11-07T15:07:03Z",
    });
    expect(ms(first.at)).toBeLessThan(ms("2026-11-07T15:07:33Z"));
    expect(port.calls.map((call) => call.at)).toEqual([START, "2026-11-07T15:08:33Z"]);
    expect(must(h.spans[0]).outcome).toBe("timedOut");
  });

  it("counts a port that throws, or answers outside its three outcomes, as a network error, tried again on the key", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, (_call, nth) => {
      if (nth === 1) return Promise.reject(new TypeError("fetch failed"));
      if (nth === 2) return { outcome: "maybe" } as unknown as ReturnType<typeof ok>;
      return ok("gcal-event-demo-0001");
    });

    const report = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(must(report.rows[0]).end).toBe("succeeded");
    expect(h.repo.results.map((result) => result.request.errorCode)).toEqual([
      "port_threw",
      "port_answer_invalid",
      null,
    ]);
    expect(new Set(port.calls.map((call) => call.idempotencyKey))).toEqual(new Set([row.idempotencyKey]));
  });

  it("goes sooner on a provider's shorter Retry-After, never later than the 2-minute slot", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, (_call, nth) => {
      if (nth === 1) return networkError("429", 20_000);
      if (nth === 2) return networkError("429", 10 * MINUTE);
      return ok("gcal-event-demo-0001");
    });

    await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(port.calls.map((call) => call.at)).toEqual([
      START,
      "2026-11-07T15:06:53Z",
      "2026-11-07T15:10:33Z",
    ]);
  });

  it("sends a result again after a transient answer, the same request, and at most 3 times", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    h.repo.answerNextResults(
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40P01" },
    );
    const port = new FakeKindPort(h.clock, () => ok("gcal-event-demo-0001"));

    const report = await h.clock.drive(h.runner("effects-runner-1", calendarPorts(port)).runDue());

    expect(must(report.rows[0]).end).toBe("succeeded");
    expect(h.repo.results).toHaveLength(3);
    const [one, two, three] = h.repo.results.map((result) => result.request);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
    expect(port.calls).toHaveLength(1);

    const h2 = harness();
    h2.repo.seed(row, COMMITTED);
    h2.repo.answerNextResults(
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40001" },
      { error: "transient", sqlstate: "40001" },
    );
    const port2 = new FakeKindPort(h2.clock, () => ok("gcal-event-demo-0001"));
    const left = await h2.clock.drive(h2.runner("effects-runner-1", calendarPorts(port2)).runDue());
    expect(must(left.rows[0]).end).toBe("transient");
    expect(h2.repo.results).toHaveLength(3);
    expect(h2.repo.held(row.effectId).row.state).toBe("running");
  });
});

// ---- refusals, spans and the runner's own errors ---------------------------------------------------------------------

describe("effects runner: rows it cannot run, spans it cannot write, and its own errors", () => {
  const claimedAs = (
    row: EffectRow,
    claimer = "effects-runner-1",
    firstTryAt: string | null = START,
  ): ClaimedEffect => ({
    effect: { ...row, state: "running", firstTryAt },
    version: 2,
    claimedFrom: "pending",
    claimedBy: claimer,
    claimLapsesAt: "2026-11-07T15:07:33Z",
  });

  it("refuses, and never calls, a row that is not its own, not a K-07 kind or port, names no calendar, or has no port", async () => {
    const h = harness();
    const port = new FakeKindPort(h.clock, () => ok());
    const runner = h.runner("effects-runner-1", calendarPorts(port));
    const base = calendarWrite();
    const odd = { kind: "calendar_fax" };
    const cases: [ClaimedEffect, string][] = [
      [claimedAs(variant(base, "theirs"), "effects-runner-2"), "notOurs"],
      [claimedAs({ ...variant(base, "kind"), kind: odd.kind as EffectKind }), "unknownKind"],
      [claimedAs({ ...variant(base, "port"), port: "stripe" }), "portMismatch"],
      [claimedAs({ ...variant(base, "provider"), calendarProvider: null }), "noCalendarProvider"],
      [claimedAs(variant(depositCharge(), "noport")), "noKindPort"],
      [claimedAs(variant(base, "first"), "effects-runner-1", null), "noFirstTry"],
    ];

    const rows = await h.clock.drive(runner.run(cases.map(([claimed]) => claimed)));

    expect(rows.map((row) => [row.end, row.refusal, row.calls])).toEqual(
      cases.map(([, refusal]) => ["refused", refusal, 0]),
    );
    expect(port.calls).toEqual([]);
  });

  it("runs the row when its trace cannot be opened, and reports the span by labels only", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const port = new FakeKindPort(h.clock, () => ok("gcal-event-demo-0001"));
    const runner = h.runner("effects-runner-1", calendarPorts(port), {
      traceOf: () => {
        throw new RangeError("no bundle in force");
      },
    });

    const report = await h.clock.drive(runner.runDue());

    expect(must(report.rows[0]).end).toBe("succeeded");
    expect(h.refused).toEqual([{ effectId: row.effectId, attempt: 1, error: "RangeError" }]);
  });

  it("lets every other row end when one row's run throws, then throws naming that row; the row's port is never called", async () => {
    const h = harness();
    const good = variant(calendarWrite(), "good");
    const bad = variant(calendarWrite(), "bad");
    h.repo.seed(good, COMMITTED);
    h.repo.seed(bad, COMMITTED);
    const port = new FakeKindPort(h.clock, () => ok("gcal-event-demo"));
    const runner = h.runner("effects-runner-1", calendarPorts(port), {
      zoneOf: (effect) =>
        effect.effectId === bad.effectId
          ? Promise.reject(new Error("zone read failed"))
          : Promise.resolve(null),
    });

    const failure = await h.clock.drive(runner.runDue()).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      name: "EffectsRunnerError",
      rows: [{ effectId: good.effectId, end: "succeeded" }],
      failures: [{ effectId: bad.effectId }],
    });
    expect(port.calls.map((call) => call.effectId)).toEqual([good.effectId]);
    expect(must(h.repo.results[0]).request.events[0].zone).toBeNull();
  });

  it("throws, never swallows, a result call that throws, and still ends the try's span", async () => {
    const h = harness();
    const row = calendarWrite();
    h.repo.seed(row, COMMITTED);
    const throwing: EffectRepo = {
      claimEffects: (request) => h.repo.claimEffects(request),
      recordEffectResult: () => Promise.reject(new Error("connection lost")),
    };
    const port = new FakeKindPort(h.clock, () => ok("gcal-event-demo-0001"));
    const runner = h.runner("effects-runner-1", calendarPorts(port), { repo: throwing });

    const failure = await h.clock.drive(runner.runDue()).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(EffectsRunnerError);
    expect(failure).toMatchObject({ rows: [], failures: [{ effectId: row.effectId }] });
    expect(port.calls).toHaveLength(1);
    expect(h.spans).toHaveLength(1);
    expect(must(h.spans[0]).decided).toMatchObject({ result: "ok", recorded: "thrown" });
  });

  it("refuses to be made with a claimer that is not a label, or a claim limit outside 1 to 100", () => {
    const h = harness();
    expect(() => h.runner("effects runner 1", {})).toThrow(/claimer is not a label/u);
    expect(() => h.runner("effects-runner-1", {}, { limit: 0 })).toThrow(/claim limit/u);
    expect(() => h.runner("effects-runner-1", {}, { limit: 101 })).toThrow(/claim limit/u);
  });
});
