// The safety read's outage line wakes the recipient's dispatcher (T-1341; DL-669), run in Node: the real SafetyOnArrival,
// with the Durable Object's SQL storage played by an in-memory SQLite database (node:sqlite, as ./partial-bundle.test.ts
// does) and the safety read's doubles (./test-support.ts). Each text's read fails at once, so its timeout rule asks the
// core for the outage line at once; the core double writes the line's row and answers with its id; and the wake each test
// joins (`SafetyDeps.wake`) is a double that keeps what it is asked. The host's one reading (`SafetyHost.stopped`, the
// actor's) answers as each test sets it, ask by ask: before the stopped flag is read, right before the core's send, and
// right before the wake. The real actor and the real dispatcher are ../outage/ai/lease.worker.test.ts's (T-1337's rig).
// Test values only (rule 9).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import { prepareHandoff } from "../gateway/hand-off";
import { fakeKeyStore } from "../gateway/test-support";
import { SafetyOnArrival, setSafetyDeps, type SafetyEntry } from "./arrival";
import {
  fakeCore,
  fakeDirect,
  fixtureBundle,
  TEST_IDS,
  type FakeCore,
  type FakeDirect,
} from "./test-support";
import type { CoreError, SafetyClock, SafetyDeps, SendFixedLineResponse } from "./types";

const TRACE = "11111111-2222-4333-8444-555555555555";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const EVENT = "evt-alex-1341-1";
/** The row the core double writes for the text's outage line. */
const ROW = `out-fixed-safety:${EVENT}`;
/** When the text arrives, on the test clock. */
const ARRIVED = 1_000;
/** How long the core takes to answer the line, on the test clock: the line's hand-off time. */
const CORE_MS = 250;

/** The Durable Object's SQL storage for a Node test: `exec` runs at once, and its cursor hands back the rows it read. */
function sqlStorage(): DurableObjectStorage {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: SQLInputValue[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  return { sql } as unknown as DurableObjectStorage;
}

/** One answer of the host's reading: a value, or a throw. */
type Reading = boolean | "throws" | "notABoolean" | "noAnswer";

interface Run {
  safety: SafetyOnArrival;
  core: FakeCore;
  direct: FakeDirect;
  /** Each wake the writer made, with the text's state and the clock when it was made. */
  wakes: { request: unknown; state: string | undefined; at: number }[];
  /** The calls the writer made, in order: each ask of the reading, the core's send and each wake. */
  calls: string[];
  /** The text's safety entry once its work has ended. */
  entry: SafetyEntry | undefined;
}

interface Spec {
  /** The reading's answers, ask by ask (before the flag read, before the core's send, before the wake); null: no reading. */
  readings: readonly Reading[] | null;
  /** The wake joined, how it ends; null: none joined. */
  wake: "resolves" | "throws" | "rejects" | null;
  /** What the core answers the line with, from its written answer. */
  answer?: (written: SendFixedLineResponse) => SendFixedLineResponse | CoreError;
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** One text whose read fails at once, with the host's reading, the core's answer and the wake as `spec` says. */
async function run(spec: Spec): Promise<Run> {
  let now = ARRIVED;
  const clock: SafetyClock = { now: () => now, after: () => new Promise<void>(() => undefined) };
  const keys = fakeKeyStore();
  const core = fakeCore(clock);
  const direct = fakeDirect(clock);
  const wakes: Run["wakes"] = [];
  const calls: string[] = [];
  const readings = spec.readings === null ? null : [...spec.readings];
  const safety: SafetyOnArrival = new SafetyOnArrival({
    storage: sqlStorage(),
    spanSink: () => () => undefined,
    storedTexts: () => [],
    returns: { enqueue: () => undefined },
    ...(readings === null
      ? {}
      : {
          stopped: (): boolean => {
            calls.push("reading");
            const answer = readings.shift() ?? false;
            if (answer === "throws") throw new Error("the actor's storage failed");
            if (answer === "notABoolean") return "false" as unknown as boolean;
            if (answer === "noAnswer") return undefined as unknown as boolean;
            return answer;
          },
        }),
  });
  const deps: SafetyDeps = {
    read: { read: () => Promise.reject(new Error("the models are down")) },
    bundle: fixtureBundle(),
    core: {
      recordSafetyOutcome: (request) => core.recordSafetyOutcome(request),
      releaseSafetyHold: (request) => core.releaseSafetyHold(request),
      async sendFixedLine(request) {
        calls.push("core");
        const written = await core.sendFixedLine(request);
        now += CORE_MS;
        if ("error" in written) return written;
        return spec.answer === undefined ? written : spec.answer(written);
      },
    },
    directory: { idsOf: () => Promise.resolve(TEST_IDS) },
    keys,
    direct,
    clock,
    isStopped: () => false,
    ...(spec.wake === null
      ? {}
      : {
          wake: (request) => {
            calls.push("wake");
            wakes.push({
              request: structuredClone(request),
              state: safety.readSafety().find((entry) => entry.eventId === EVENT)?.state,
              at: now,
            });
            // The run takes a while: the line's hand-off time was taken before it.
            now += 1_000;
            // A throw at the call itself, or a run that rejects.
            if (spec.wake === "throws") throw new Error("the dispatcher's run failed");
            return spec.wake === "rejects"
              ? Promise.reject(new Error("the claim failed"))
              : Promise.resolve();
          },
        }),
  };
  restores.push(setSafetyDeps(deps));
  const prepared = await prepareHandoff(
    {
      event: { ...textImessage, eventId: EVENT, body: "Test words: is Saturday open?", traceId: TRACE },
      partKey: null,
      traceId: TRACE,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  await safety.arrive(prepared.handoff);
  await safety.idle();
  return {
    safety,
    core,
    direct,
    wakes,
    calls,
    entry: safety.readSafety().find((entry) => entry.eventId === EVENT),
  };
}

/** The outage line went through the core's row and its result stands: path outbox, its hand-off time, done. */
function lineStands(done: Run): void {
  expect(done.core.fixed.map((sent) => [sent.request.caller.requestId, sent.request.fixedLineId])).toEqual([
    [`safety:${EVENT}`, "outage"],
  ]);
  expect(done.entry).toMatchObject({
    state: "done",
    danger: false,
    path: "outbox",
    lineId: "outage",
    handedAfterMs: CORE_MS,
  });
  expect(done.direct.sent).toEqual([]);
}

describe("the safety read's outage line wakes the recipient's dispatcher once the core names its row (T-1341; DL-669)", () => {
  it("the reading says exactly false right before the wake: the row is woken once for the text's recipient, after the line's hand-off time is taken and before the text's work ends, with the reading asked right before it", async () => {
    const done = await run({ readings: [false, false, false], wake: "resolves" });

    lineStands(done);
    expect(done.wakes).toEqual([
      {
        request: { handleId: TEST_IDS.handleId, outboxRowIds: [ROW] },
        state: "reading",
        at: ARRIVED + CORE_MS,
      },
    ]);
    expect(done.calls).toEqual(["reading", "reading", "core", "reading", "wake"]);
  });

  it("a repeated answer names a row an earlier ask wrote (a rerun, or the resume of a cut-off read): it is woken all the same", async () => {
    const done = await run({
      readings: [false, false, false],
      wake: "resolves",
      answer: (written) => ({ ...written, repeated: true }),
    });

    lineStands(done);
    expect(done.wakes.map((wake) => wake.request)).toEqual([
      { handleId: TEST_IDS.handleId, outboxRowIds: [ROW] },
    ]);
  });

  it.each([
    ["true (a STOP the actor took while the core was asked)", true],
    ["a throw (the actor's storage failed)", "throws"],
    ["an answer that is not a boolean", "notABoolean"],
    ["no answer at all", "noAnswer"],
  ] as const)(
    "the gate fails closed: the reading right before the wake answers %s, so no wake is made and the row waits for the recipient's next run; the line's result stands",
    async (_how, last) => {
      const done = await run({ readings: [false, false, last], wake: "resolves" });

      lineStands(done);
      expect(done.wakes).toEqual([]);
      expect(done.calls).toEqual(["reading", "reading", "core", "reading"]);
    },
  );

  it("a host with no reading makes no wake, stricter than the line's own asks, which let the line go", async () => {
    const done = await run({ readings: null, wake: "resolves" });

    lineStands(done);
    expect(done.wakes).toEqual([]);
  });

  it("a core answer that names no row (outboxRowId null) wakes nothing", async () => {
    const done = await run({
      readings: [false, false, false],
      wake: "resolves",
      answer: (written) => ({ ...written, outboxRowId: null }),
    });

    expect(done.entry).toMatchObject({ state: "done", path: "outbox", lineId: "outage" });
    expect(done.wakes).toEqual([]);
  });

  it.each([
    ["throws", "throws"],
    ["rejects", "rejects"],
  ] as const)(
    "a wake that %s is caught by the writer: the line's result stands (path outbox, the hand-off time taken before the wake, not lineFailed), nothing goes straight through Linq, and the wake is not tried again",
    async (_how, wake) => {
      const done = await run({ readings: [false, false, false], wake });

      lineStands(done);
      expect(done.wakes).toHaveLength(1);
      expect(done.calls.filter((call) => call === "wake")).toEqual(["wake"]);
    },
  );

  it("no wake joined (a test's own deps): the line's result is the same, and the row waits for the recipient's next run", async () => {
    const done = await run({ readings: [false, false, false], wake: null });

    lineStands(done);
    expect(done.calls).toEqual(["reading", "reading", "core"]);
  });

  it("unchanged (T-1336): the reading's word before the core's send holds the line, so no row is written and nothing is woken", async () => {
    const done = await run({ readings: [false, true], wake: "resolves" });

    expect(done.core.fixed).toEqual([]);
    expect(done.direct.sent).toEqual([]);
    expect(done.entry).toMatchObject({ state: "done", path: "none", lineId: "outage" });
    expect(done.wakes).toEqual([]);
  });
});
