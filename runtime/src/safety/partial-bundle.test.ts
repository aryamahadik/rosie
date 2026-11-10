// Bundle v0 pinned (T-1143; DL-325, DL-330). The walking skeleton's bundle (bundles/v0, T-163) holds only S1-01 and S1-02,
// so none of A3-22's outcome steps (A3-23 to A3-26, A3-48 to A3-50). Every danger outcome still gets a line to the person
// who wrote the text, in v0's own words (its K-01 v1 fixed lines), except a threat, whose writer gets none; No gets none.
//
// Then the actor's direct path (PostgreSQL down, arch 11 line 566): the real SafetyOnArrival runs in Node, with the Durable
// Object's SQL storage played by an in-memory SQLite database (node:sqlite) and the safety read's doubles of
// ./test-support. The line goes once, straight through Linq, past any opt-out; the hold is written; the record waits for
// the core's return, naming the line that went; and the safetyRead span names the line by its K-01 id, with no words.
// Test values only (rule 9).

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import fixedLinesFixture from "../../../contracts/bundle/fixtures/fixed-lines.json";
import skeletonFixture from "../../../contracts/bundle/fixtures/bundle-v0-skeleton.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyBusinessOwnLine from "../../../contracts/model/fixtures/safety-business-own-line.json";
import safetyChildOrElder from "../../../contracts/model/fixtures/safety-child-or-elder.json";
import safetyCrisisWords from "../../../contracts/model/fixtures/safety-crisis-words.json";
import safetyEmergencyNow from "../../../contracts/model/fixtures/safety-emergency-now.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import safetyThreat from "../../../contracts/model/fixtures/safety-threat.json";
import safetyTimeoutDangerWord from "../../../contracts/model/fixtures/safety-timeout-danger-word.json";
import safetyTimeoutSelfHarm from "../../../contracts/model/fixtures/safety-timeout-self-harm-word.json";
import safetyUnknownTense from "../../../contracts/model/fixtures/safety-unknown-tense.json";
import safetyUnsafeAtHome from "../../../contracts/model/fixtures/safety-unsafe-at-home.json";
import flowAV0 from "../../../bundles/v0/bundle/flow/A.json";
import manifestV0 from "../../../bundles/v0/bundle/manifest.json";
import { prepareHandoff } from "../gateway/hand-off";
import { fakeKeyStore } from "../gateway/test-support";
import type { Span } from "../trace";
import { SafetyOnArrival, setSafetyDeps, type ReturnedWrite } from "./arrival";
import { checkedLineFor, OUTCOME_LABEL } from "./rules";
import { fakeCore, fakeDirect, fakeRead, TEST_IDS, type FakeCore, type FakeDirect } from "./test-support";
import {
  SAFETY_OUTCOMES,
  type BundleSafety,
  type CheckedLine,
  type ReleaseRule,
  type SafetyClock,
  type SafetyOutcome,
  type SafetyResult,
  type Tense,
} from "./types";

// ---- bundle v0, as the actor reads its safety part --------------------------------------------------------------------

interface FixedLineEntry {
  id: string;
  text: string | null;
}

interface BundleManifest {
  bundleId: { hash: string; build: number };
  partial?: boolean;
  lists: { fixedLines: { lines: FixedLineEntry[] } };
}

interface FlowGraph {
  steps: Record<string, { say?: { from: string; to: string; text: string }[] }>;
}

const V0 = manifestV0 as unknown as BundleManifest;
const V0_FLOW_A = flowAV0 as unknown as FlowGraph;

/** Each outcome's step in flow A (A3-22's branches); bundle v0 has no flow B. */
const OUTCOME_STEP: Readonly<Partial<Record<SafetyOutcome, string>>> = {
  "Safety steps, then go on": "A3-23",
  "An emergency": "A3-24",
  "Crisis words": "A3-25",
  "Needs the business's own line": "A3-26",
  "A threat to staff or others": "A3-48",
  "Harm to a child or older adult": "A3-49",
  "Unsafe at home": "A3-50",
};

const linesOf = (entries: readonly FixedLineEntry[]): ReadonlyMap<string, string | null> =>
  new Map(entries.map((entry) => [entry.id, entry.text]));

const V0_LINES = linesOf(V0.lists.fixedLines.lines);

/**
 * Bundle v0's safety part as the actor reads it on arrival: its fixed lines by K-01 id, and an outcome step's checked line
 * (its first message from Rosie to someone other than the owner) where flow A holds that step. K-01 v1's shared lists carry
 * no danger-word list (contracts/bundle README; T-163's security note N3), so v0 has none.
 */
const BUNDLE_V0: BundleSafety = {
  fixedLine: (id) => {
    const text = V0_LINES.get(id) ?? null;
    return text === null ? null : { id, text };
  },
  outcomeLine: (outcome) => {
    const stepId = OUTCOME_STEP[outcome];
    if (stepId === undefined) return null;
    const say = V0_FLOW_A.steps[stepId]?.say?.find(
      (message) => message.from === "san" && message.to !== "owner",
    );
    return say === undefined ? null : { id: stepId, text: say.text };
  },
  dangerWords: () => [],
};

/** Bundle v0's words for a fixed line. */
function v0Line(id: string): CheckedLine {
  const line = BUNDLE_V0.fixedLine(id);
  if (line === null) throw new Error(`bundle v0 has no words for ${id}`);
  return line;
}

const withAsk = (line: CheckedLine): CheckedLine => ({
  id: line.id,
  text: `${line.text} ${v0Line("safetyAsk").text}`,
});

// ---- the results ------------------------------------------------------------------------------------------------------

const asResult = (fixture: unknown): SafetyResult => fixture as SafetyResult;

/** A verdict with one label and these words as its evidence, on K-02's safety-no.json shape. */
function verdict(eventId: string, outcome: SafetyOutcome, tense: Tense, words: string): SafetyResult {
  return {
    ...asResult(safetyNo),
    eventId,
    read: {
      labels: [{ outcome, tense, evidence: words, atRisk: "unknown", writer: "the person at the handle" }],
    },
    outcomes: [outcome],
  };
}

const SAFETY_STEPS = verdict(
  "evt-alex-1143-steps",
  "Safety steps, then go on",
  "now",
  "I nicked my ear shaving this morning, is Saturday still okay?",
);
const READ_UNSURE = verdict(
  "evt-alex-1143-unsure",
  "Unsure",
  "unknown",
  "not sure everyone here is okay tonight",
);

describe("bundle v0 pinned: no outcome step, so every danger outcome takes v0's fixed line", () => {
  it("v0 is partial: flow A holds S1-01 and S1-02, none of A3-22's outcome steps, and K-01 v1's safety lines", () => {
    expect(V0.partial).toBe(true);
    expect(Object.keys(V0_FLOW_A.steps).sort()).toEqual(["S1-01", "S1-02"]);
    for (const outcome of SAFETY_OUTCOMES) expect(BUNDLE_V0.outcomeLine(outcome)).toBeNull();
    // Its 911, 988 and danger-question lines are K-01 v1's words (fixed-lines.json; bundle-v0-skeleton.json's lists).
    const k01 = linesOf((fixedLinesFixture as { lines: FixedLineEntry[] }).lines);
    const skeleton = linesOf(
      (skeletonFixture as unknown as { manifest: BundleManifest }).manifest.lists.fixedLines.lines,
    );
    for (const id of ["safetyEmergency", "safetyCrisis", "safetyAsk"]) {
      expect(v0Line(id).text).toBe(k01.get(id));
      expect(v0Line(id).text).toBe(skeleton.get(id));
    }
  });

  it.each<[string, SafetyResult, CheckedLine | null]>([
    ["No (safety-no.json): nothing", asResult(safetyNo), null],
    ["Safety steps, then go on: 911", SAFETY_STEPS, v0Line("safetyEmergency")],
    [
      "An emergency (safety-emergency-now.json): 911",
      asResult(safetyEmergencyNow),
      v0Line("safetyEmergency"),
    ],
    [
      "Crisis words (safety-crisis-words.json): 988 and 911",
      asResult(safetyCrisisWords),
      v0Line("safetyCrisis"),
    ],
    ["A threat (safety-threat.json): nothing to its writer", asResult(safetyThreat), null],
    [
      "Harm to a child or older adult (safety-child-or-elder.json): 911",
      asResult(safetyChildOrElder),
      v0Line("safetyEmergency"),
    ],
    [
      "Unsafe at home (safety-unsafe-at-home.json): 911",
      asResult(safetyUnsafeAtHome),
      v0Line("safetyEmergency"),
    ],
    [
      "The business's own line (safety-business-own-line.json): 911",
      asResult(safetyBusinessOwnLine),
      v0Line("safetyEmergency"),
    ],
    [
      "Unsure on a danger word (safety-timeout-danger-word.json): 911",
      asResult(safetyTimeoutDangerWord),
      v0Line("safetyEmergency"),
    ],
    [
      "Unsure on a self-harm word (safety-timeout-self-harm-word.json): 988 and 911",
      asResult(safetyTimeoutSelfHarm),
      v0Line("safetyCrisis"),
    ],
    [
      "The read's own Unsure, tense unknown: 911 and the danger question",
      READ_UNSURE,
      withAsk(v0Line("safetyEmergency")),
    ],
  ])("%s", (_name, result, line) => {
    expect(checkedLineFor(result, BUNDLE_V0)).toEqual(line);
  });

  it("every danger outcome but a threat gets a line from v0", () => {
    for (const outcome of SAFETY_OUTCOMES) {
      const line = checkedLineFor(verdict("evt-alex-1143-each", outcome, "now", "x"), BUNDLE_V0);
      if (outcome === "No" || outcome === "A threat to staff or others") expect(line, outcome).toBeNull();
      else expect(line?.text, outcome).toContain("911");
    }
  });

  it("a label of unknown tense adds v0's danger question (safety-unknown-tense.json)", () => {
    expect(checkedLineFor(asResult(safetyUnknownTense), BUNDLE_V0)).toEqual(
      withAsk(v0Line("safetyEmergency")),
    );
    const harm = verdict("evt-alex-1143-harm", "Harm to a child or older adult", "unknown", "x");
    expect(checkedLineFor(harm, BUNDLE_V0)).toEqual(withAsk(v0Line("safetyEmergency")));
  });
});

// ---- the direct path ---------------------------------------------------------------------------------------------------

const TRACE = "11111111-2222-4333-8444-555555555555";

/**
 * The Durable Object's SQL storage for a Node test: an in-memory SQLite database. `exec` runs the statement at once, and
 * its cursor hands back the rows it read. The actor's safety read uses only `sql.exec(...).toArray()`.
 */
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

/** No deadline ever comes: the read's answer always lands first. */
const clock: SafetyClock = { now: () => 0, after: () => new Promise<void>(() => undefined) };

interface DirectRun {
  safety: SafetyOnArrival;
  core: FakeCore;
  direct: FakeDirect;
  spans: Span[];
  queued: ReturnedWrite[];
}

/**
 * One text whose read gives `result`, with bundle v0 pinned and the core down (PostgreSQL down), on the actor's own safety
 * read; `then` runs once the text's safety work is done, with the doubles still set.
 */
async function withDirectPath(
  result: SafetyResult,
  words: string,
  then: (run: DirectRun) => Promise<void> | void,
): Promise<void> {
  const keys = fakeKeyStore();
  const core = fakeCore(clock);
  core.down = true;
  const direct = fakeDirect(clock);
  const spans: Span[] = [];
  const queued: ReturnedWrite[] = [];
  const safety = new SafetyOnArrival({
    storage: sqlStorage(),
    spanSink: () => (span) => spans.push(span),
    storedTexts: () => [],
    returns: {
      enqueue: (write) => {
        queued.push(write);
      },
    },
  });
  const restore = setSafetyDeps({
    read: fakeRead(clock, { [result.eventId]: result }),
    bundle: BUNDLE_V0,
    core,
    directory: { idsOf: () => Promise.resolve(TEST_IDS) },
    keys,
    direct,
    clock,
    isStopped: () => false,
  });
  try {
    const prepared = await prepareHandoff(
      {
        event: { ...textImessage, eventId: result.eventId, body: words, traceId: TRACE },
        partKey: null,
        traceId: TRACE,
        bundleId: V0.bundleId,
      },
      keys,
    );
    if (prepared.door !== "actor") throw new Error("not an actor event");
    await safety.arrive(prepared.handoff);
    await safety.idle();
    await then({ safety, core, direct, spans, queued });
  } finally {
    restore();
  }
}

/** The text's words, as the K-02 fixture's evidence quotes them. */
const wordsOf = (result: SafetyResult): string => result.read?.labels[0]?.evidence ?? "x";

describe("the direct path with bundle v0 pinned (PostgreSQL down)", () => {
  it.each<[string, SafetyResult, CheckedLine, ReleaseRule]>([
    ["Safety steps, then go on", SAFETY_STEPS, v0Line("safetyEmergency"), "at_once"],
    [
      "An emergency (safety-emergency-now.json)",
      asResult(safetyEmergencyNow),
      v0Line("safetyEmergency"),
      "after_safe",
    ],
    [
      "Crisis words (safety-crisis-words.json)",
      asResult(safetyCrisisWords),
      v0Line("safetyCrisis"),
      "after_safe",
    ],
    [
      "Harm to a child or older adult (safety-child-or-elder.json)",
      asResult(safetyChildOrElder),
      v0Line("safetyEmergency"),
      "at_once",
    ],
    [
      "Unsafe at home (safety-unsafe-at-home.json)",
      asResult(safetyUnsafeAtHome),
      v0Line("safetyEmergency"),
      "when_private",
    ],
    [
      "The business's own line (safety-business-own-line.json)",
      asResult(safetyBusinessOwnLine),
      v0Line("safetyEmergency"),
      "at_once",
    ],
    ["The read's own Unsure, tense unknown", READ_UNSURE, withAsk(v0Line("safetyEmergency")), "after_safe"],
  ])(
    "%s: the line goes once, straight through Linq, and the span names it with no words",
    async (_name, result, line, rule) => {
      const eventId = result.eventId;
      const words = wordsOf(result);
      await withDirectPath(result, words, async ({ safety, core, direct, spans, queued }) => {
        // Once, past any opt-out, keyed to the text and the line so a repeat is one message at Linq.
        expect(direct.sent).toHaveLength(1);
        expect(direct.sent[0]).toMatchObject({
          actorName: "phone:+15555550101",
          fixedLineId: line.id,
          text: line.text,
          overrideOptout: true,
          idempotencyKey: `safety:${eventId}:${line.id}`,
        });
        expect(safety.readSafety()).toEqual([
          { eventId, state: "done", danger: true, path: "direct", lineId: line.id, handedAfterMs: 0 },
        ]);
        expect(safety.readHolds()).toMatchObject([{ eventId, holdId: null, rule, released: false }]);
        expect(safety.routineHeld()).toBe(true);

        // One safetyRead span: the outcome's label and the line's K-01 id, never the line's or the text's words.
        const read = spans.filter((span) => span.hop === "safetyRead");
        expect(read).toHaveLength(1);
        expect(read[0]).toMatchObject({
          trace_id: TRACE,
          bundle_id: V0.bundleId,
          event_id: eventId,
          outcome: "ok",
          got: { via: "verdict", outcomes: result.outcomes.map((outcome) => OUTCOME_LABEL[outcome]) },
          decided: { danger: true, path: "direct", line: line.id, lineFor: null },
        });
        const logged = JSON.stringify(spans);
        expect(logged).not.toContain(line.text);
        expect(logged).not.toContain("911");
        expect(logged).not.toContain(words);
        expect(logged).not.toContain("+15555550101");

        // The record waits for the core's return, sealed, and names the line the actor sent; nothing is sent again.
        expect(queued).toMatchObject([
          { key: `recordSafetyOutcome:${eventId}`, call: "recordSafetyOutcome" },
        ]);
        expect(queued[0]?.box).not.toContain(words);
        core.down = false;
        const write = queued[0];
        if (write === undefined) throw new Error("no record queued");
        expect(await safety.replayOnReturn(write)).toBe("written");
        expect(core.recorded).toHaveLength(1);
        expect(core.recorded[0]?.request.caller.kind).toBe("actorOnReturn");
        expect(core.recorded[0]?.request.sentByActor).toEqual({
          at: "1970-01-01T00:00:00.000Z",
          fixedLineId: line.id,
          linqMessageId: "linq-1",
        });
        expect(direct.sent).toHaveLength(1);
      });
    },
  );

  it("a threat (safety-threat.json): no line to its writer, the hold is written and never released, and the record waits for the core", async () => {
    const result = asResult(safetyThreat);
    const eventId = result.eventId;
    await withDirectPath(result, wordsOf(result), async ({ safety, core, direct, spans, queued }) => {
      expect(direct.sent).toEqual([]);
      expect(safety.readHolds()).toEqual([
        { eventId, holdId: null, rule: "never", blocksBooking: false, released: false },
      ]);
      expect(safety.readSafety()).toEqual([
        { eventId, state: "done", danger: true, path: "none", lineId: null, handedAfterMs: null },
      ]);
      expect(spans.filter((span) => span.hop === "safetyRead")).toMatchObject([
        { got: { outcomes: ["threat"] }, decided: { danger: true, path: "none", line: null } },
      ]);

      // On return the core gets the record with nothing sent by the actor: the core tells the owner (DL-330).
      expect(queued).toMatchObject([{ key: `recordSafetyOutcome:${eventId}`, call: "recordSafetyOutcome" }]);
      core.down = false;
      const write = queued[0];
      if (write === undefined) throw new Error("no record queued");
      expect(await safety.replayOnReturn(write)).toBe("written");
      expect(core.recorded[0]?.request.sentByActor).toBeNull();
      expect(core.recorded[0]?.request.safety.outcomes).toEqual(["A threat to staff or others"]);
      expect(direct.sent).toEqual([]);
      expect(safety.markHoldReleased(`hold-${eventId}`)).toBe("neverReleased");
    });
  });

  it("No (safety-no.json): nothing is sent, held or recorded", async () => {
    const result = asResult(safetyNo);
    await withDirectPath(
      result,
      "Can I get a haircut on Thursday afternoon?",
      ({ safety, direct, queued }) => {
        expect(direct.sent).toEqual([]);
        expect(queued).toEqual([]);
        expect(safety.readHolds()).toEqual([]);
        expect(safety.readSafety()).toMatchObject([
          { state: "done", danger: false, path: "none", lineId: null },
        ]);
        expect(safety.routineHeld()).toBe(false);
      },
    );
  });
});
