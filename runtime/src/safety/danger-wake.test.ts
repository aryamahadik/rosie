// The danger line's row is woken by its writer at once (T-1352; DL-687; RULES 4.12), run in Node: the real
// SafetyOnArrival, with the Durable Object's SQL storage played by an in-memory SQLite database (node:sqlite, as
// ./outage-wake.test.ts does) and the safety read's doubles (./test-support.ts). Each text's read answers at once with a
// danger verdict (K-02's safety-child-or-elder.json, whose hold is released at once after the line); the core double
// records the outcome, writes the line's row and answers with its id; and the danger wake each test joins
// (`SafetyDeps.wakeSafety`) is a double that keeps what it is asked, with the text's row and hold as they stood when it
// was made. The host's reading and the deps' stopped flag answer as each test sets them, and are kept if asked. The real
// actor and the real dispatcher are ../outage/ai/lease.worker.test.ts's (T-1337's rig). Test values only (rule 9).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyChildOrElder from "../../../contracts/model/fixtures/safety-child-or-elder.json";
import { prepareHandoff } from "../gateway/hand-off";
import { fakeKeyStore } from "../gateway/test-support";
import { SafetyOnArrival, setSafetyDeps, type HoldEntry, type SafetyEntry } from "./arrival";
import {
  fakeCore,
  fakeDirect,
  fakeRead,
  fixtureBundle,
  TEST_IDS,
  type FakeCore,
  type FakeDirect,
} from "./test-support";
import type {
  CoreError,
  HandleIds,
  RecordSafetyOutcomeResponse,
  SafetyClock,
  SafetyDeps,
  SafetyResult,
} from "./types";

const TRACE = "11111111-2222-4333-8444-555555555555";
const BUNDLE = { hash: "a".repeat(64), build: 1 };
const EVENT = "evt-alex-1352-1";
/** The row the core double writes for the text's danger line. */
const ROW = `out-${EVENT}`;
/** When the text arrives, on the test clock. */
const ARRIVED = 1_000;
/** How long the core takes to answer the record, on the test clock: the line's hand-off time. */
const CORE_MS = 250;
/** The read's verdict for the text: Harm to a child or older adult, now (its hold is released at once). */
const VERDICT: SafetyResult = { ...(safetyChildOrElder as unknown as SafetyResult), eventId: EVENT };

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

/** What the host's reading and the deps' stopped flag say, if they are asked: a value, or a throw. */
type Stopped = boolean | "throws";

interface Wake {
  request: unknown;
  /** The text's row as it stood when the wake was made. */
  entry: SafetyEntry | undefined;
  /** Its holds as they stood then. */
  holds: HoldEntry[];
  /** How many holds the core had released by then. */
  released: number;
  at: number;
}

interface Run {
  safety: SafetyOnArrival;
  core: FakeCore;
  direct: FakeDirect;
  wakes: Wake[];
  /** The calls made, in order: the core's record and release, each wake, and each ask of a reading or flag. */
  calls: string[];
  /** The text's safety entry once its work has ended. */
  entry: SafetyEntry | undefined;
  /** Ends a held wake's run (`wake: "held"`). */
  release(): void;
}

interface Spec {
  /**
   * The danger wake joined, how it ends; null: none joined. "held": its run stays out until the test releases it, and the
   * text's work is not waited past its own end (no `idle`).
   */
  wake: "resolves" | "throws" | "rejects" | "held" | null;
  /** What the host's reading (the actor's) and the deps' stopped flag say if asked; neither is ever asked here. */
  stopped?: Stopped;
  /** What the core answers the record with, from its written answer. */
  answer?: (written: RecordSafetyOutcomeResponse) => RecordSafetyOutcomeResponse | CoreError;
  /** The handle's ids the directory gives (TEST_IDS's when left out; null: not known). */
  ids?: HandleIds | null;
  /** The core not answering: PostgreSQL down, so the line goes straight through Linq. */
  coreDown?: boolean;
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** One text whose read finds danger at once, with the core's answer, the wake and the readings as `spec` says. */
async function run(spec: Spec): Promise<Run> {
  let now = ARRIVED;
  const clock: SafetyClock = { now: () => now, after: () => new Promise<void>(() => undefined) };
  const keys = fakeKeyStore();
  const core = fakeCore(clock);
  core.down = spec.coreDown === true;
  const direct = fakeDirect(clock);
  const wakes: Wake[] = [];
  const calls: string[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stopped = spec.stopped ?? false;
  const ask = (who: string): boolean => {
    calls.push(who);
    if (stopped === "throws") throw new Error("the actor's storage failed");
    return stopped;
  };
  const safety: SafetyOnArrival = new SafetyOnArrival({
    storage: sqlStorage(),
    spanSink: () => () => undefined,
    storedTexts: () => [],
    returns: { enqueue: () => undefined },
    stopped: () => ask("reading"),
  });
  const deps: SafetyDeps = {
    read: fakeRead(clock, { [EVENT]: VERDICT }),
    bundle: fixtureBundle(),
    core: {
      async recordSafetyOutcome(request) {
        calls.push("core");
        const written = await core.recordSafetyOutcome(request);
        now += CORE_MS;
        if ("error" in written) return written;
        return spec.answer === undefined ? written : spec.answer(written);
      },
      releaseSafetyHold(request) {
        calls.push("release");
        return core.releaseSafetyHold(request);
      },
      sendFixedLine: (request) => core.sendFixedLine(request),
    },
    directory: { idsOf: () => Promise.resolve(spec.ids === undefined ? TEST_IDS : spec.ids) },
    keys,
    direct,
    clock,
    isStopped: () => ask("isStopped"),
    ...(spec.wake === null
      ? {}
      : {
          wakeSafety: (request) => {
            calls.push("wake");
            wakes.push({
              request: structuredClone(request),
              entry: safety.readSafety().find((entry) => entry.eventId === EVENT),
              holds: safety.readHolds(),
              released: core.released.length,
              at: now,
            });
            // The run takes a while: the line's hand-off time was taken before it.
            now += 1_000;
            // A throw at the call itself, a run that rejects, or a run held until the test releases it.
            if (spec.wake === "throws") throw new Error("the dispatcher's run failed");
            if (spec.wake === "held") return held;
            return spec.wake === "rejects"
              ? Promise.reject(new Error("the safety claim failed"))
              : Promise.resolve();
          },
        }),
  };
  restores.push(setSafetyDeps(deps));
  const prepared = await prepareHandoff(
    {
      event: {
        ...textImessage,
        eventId: EVENT,
        body: "Test words: my mom's carer leaves her alone",
        traceId: TRACE,
      },
      partKey: null,
      traceId: TRACE,
      bundleId: BUNDLE,
    },
    keys,
  );
  if (prepared.door !== "actor") throw new Error("not an actor event");
  await safety.arrive(prepared.handoff);
  if (spec.wake !== "held") await safety.idle();
  return {
    safety,
    core,
    direct,
    wakes,
    calls,
    entry: safety.readSafety().find((entry) => entry.eventId === EVENT),
    release,
  };
}

/**
 * The danger line went through the core's row and its result stands: path outbox, its hand-off time (taken before any
 * wake), done; the core's hold is written in place of the one from the read's outcomes and released at once after the line,
 * as before; nothing went straight through Linq.
 */
function lineStands(done: Run): void {
  expect(done.core.recorded.map((call) => call.request.caller.requestId)).toEqual([`safety:${EVENT}`]);
  expect(done.entry).toMatchObject({
    state: "done",
    danger: true,
    path: "outbox",
    lineId: "outcomeLine",
    handedAfterMs: CORE_MS,
  });
  expect(done.safety.readHolds()).toEqual([
    { eventId: EVENT, holdId: `hold-${EVENT}`, rule: "at_once", blocksBooking: false, released: true },
  ]);
  expect(done.core.released.map((released) => released.holdId)).toEqual([`hold-${EVENT}`]);
  expect(done.direct.sent).toEqual([]);
}

/** The one wake, made in the step right after the core's answer: before the core's hold, the line's end and the release. */
const WOKEN: Wake = {
  request: { handleId: TEST_IDS.handleId, outboxRowIds: [ROW] },
  // The text's row is not finished yet (the line's result is written after the line), and its hold is still the one
  // written from the read's outcomes before the core was called: the core's hold, with its id, comes after the wake.
  entry: {
    eventId: EVENT,
    state: "reading",
    danger: true,
    path: null,
    lineId: null,
    handedAfterMs: null,
  },
  holds: [{ eventId: EVENT, holdId: null, rule: "at_once", blocksBooking: false, released: false }],
  released: 0,
  at: ARRIVED + CORE_MS,
};

describe("the danger line's row is woken by its writer once the core names it (T-1352; DL-687)", () => {
  it("the core's answer names the line's row: the danger wake is made once, for the text's recipient, right after the hand-off time is taken and before the core's hold is written, the line is marked done and the hold released at once; no reading or stopped flag is asked", async () => {
    const done = await run({ wake: "resolves" });

    lineStands(done);
    expect(done.wakes).toEqual([WOKEN]);
    expect(done.calls).toEqual(["core", "wake", "release"]);
  });

  it.each([
    ["true (a STOP the actor holds, not committed)", true],
    ["a throw (the actor's storage failed)", "throws"],
  ] as const)(
    "is never gated (RULES 4.12; arch 02 line 111: past any opt-out): with the host's reading and the deps' stopped flag answering %s, the wake is made all the same, and neither is asked",
    async (_how, stopped) => {
      const done = await run({ wake: "resolves", stopped });

      lineStands(done);
      expect(done.wakes).toEqual([WOKEN]);
      expect(done.calls).toEqual(["core", "wake", "release"]);
    },
  );

  it("is started, never awaited (DL-679): while its run is still out, the text's work (the promise the actor lends to waitUntil) has ended with the line's result, the core's hold and its release in place, and the run is kept with the in-flight safety work: idle waits for it until it ends", async () => {
    // `run` returns once the text's work has ended: with the wake awaited, it would wait for the held run.
    const done = await run({ wake: "held" });

    lineStands(done);
    expect(done.wakes).toEqual([WOKEN]);
    expect(done.calls).toEqual(["core", "wake", "release"]);

    let idle = false;
    const idling = done.safety.idle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);
    done.release();
    await idling;
    expect(idle).toBe(true);
    expect(done.wakes).toHaveLength(1);
  });

  it("a repeated answer names a row an earlier application wrote: it is woken all the same", async () => {
    const done = await run({ wake: "resolves", answer: (written) => ({ ...written, repeated: true }) });

    lineStands(done);
    expect(done.wakes).toEqual([WOKEN]);
  });

  it.each([
    ["throws", "throws"],
    ["rejects", "rejects"],
  ] as const)(
    "a wake that %s is caught by the writer: the line's result stands (path outbox, the hand-off time taken before the wake, not lineFailed), the hold is written and released as before, nothing goes straight through Linq, and the wake is not tried again",
    async (_how, wake) => {
      const done = await run({ wake });

      lineStands(done);
      expect(done.wakes).toEqual([WOKEN]);
      expect(done.calls).toEqual(["core", "wake", "release"]);
    },
  );

  it("no wake joined (a test's own deps): the line's result is the same, and the row waits for the recipient's next run", async () => {
    const done = await run({ wake: null });

    lineStands(done);
    expect(done.calls).toEqual(["core", "release"]);
  });

  it.each([
    [
      "names no row (outboxRowId null)",
      (written: RecordSafetyOutcomeResponse) => ({
        ...written,
        safetyLine: written.safetyLine === null ? null : { ...written.safetyLine, outboxRowId: null },
      }),
    ],
    [
      "names an empty row id",
      (written: RecordSafetyOutcomeResponse) => ({
        ...written,
        safetyLine: written.safetyLine === null ? null : { ...written.safetyLine, outboxRowId: "" },
      }),
    ],
  ] as const)("a core answer that %s wakes nothing; the line's result stands", async (_how, answer) => {
    const done = await run({ wake: "resolves", answer });

    lineStands(done);
    expect(done.wakes).toEqual([]);
  });

  it("a core answer with no line (none needed) wakes nothing", async () => {
    const done = await run({ wake: "resolves", answer: (written) => ({ ...written, safetyLine: null }) });

    expect(done.entry).toMatchObject({ state: "done", danger: true, path: "none", lineId: null });
    expect(done.wakes).toEqual([]);
  });

  it("the handle's ids not known: no recipient to wake, so nothing is woken; the line's result stands", async () => {
    const done = await run({ wake: "resolves", ids: null });

    lineStands(done);
    expect(done.wakes).toEqual([]);
  });

  it("unchanged: with the core not answering (PostgreSQL down) the line goes straight through Linq, writes no row and wakes nothing", async () => {
    const done = await run({ wake: "resolves", coreDown: true });

    // The bundle has no line of the outcome's own step, so it goes with 911's fixed line (rules.ts FIXED_LINE_OF).
    expect(done.entry).toMatchObject({
      state: "done",
      danger: true,
      path: "direct",
      lineId: "safetyEmergency",
    });
    expect(done.direct.sent.map((sent) => [sent.idempotencyKey, sent.overrideOptout])).toEqual([
      [`safety:${EVENT}:safetyEmergency`, true],
    ]);
    expect(done.wakes).toEqual([]);
  });
});
