// T-1176's proofs (the card's "Proves it with"; CQ-172's default, DL-355; arch 06 line 329; S13-24 rule 10): the core's
// own danger line, a send class safety row that finalize's inserter never reads (T-1164's review), carries K-01's
// safetyAsk itself in the handle actor's cases (runtime/src/safety/rules.ts checkedLineFor, T-1143): a label of unknown
// tense whose outcome is not No, read from the record's own labels, the question on the same line after a space. Never
// after No, a known tense or a timed-out read; a threat's writer still gets no line; a bundle with no safetyAsk words
// fails closed. On K-02 v1's own safety reads (Alex's texts to Lee's Barbershop: the master's sample cast, rule 9), bundle
// v0 pinned on both paths (T-163: its own manifest's words, and T-1140's line double under the core's line rule, as runCore
// hands them to the service), and T-318's in-memory world, never a database. The service's earlier tests (safety.test.ts,
// harm-line.test.ts) run as they were.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type * as K09 from "../../../../contracts/generated/tool-api/tool-api.v1.5";
import { checkedLineFor } from "../../../../runtime/src/safety/rules";
import type { BundleSafety } from "../../../../runtime/src/safety/types";
import {
  gateAndCommit,
  type CommitPorts,
  type CommitTurnContext,
  type CoreAction,
  type CoreRun,
  type GateAndCommitRequest,
  type OpenHolds,
} from "../../commit";
import { CoreNotBuiltError, coreSafetyLines, createRunCore, type CoreDeps } from "../../commit/core";
import { bundleV0, coreDoublesOn } from "../../commit/core/test-support";
import { doublePorts } from "../../commit/test-support";
import { callContext, copy, scriptedLimits } from "../../gate/framework/test-support";
import { NotBuiltError, createToolApiValidator } from "../../tool-api";
import { stringsIn } from "../flags/test-support";
import { contractJson } from "../messages-consent/test-support";
import { SafetyRefusedError } from "./errors";
import { recordSafetyOutcomeCore, type RecordSafetyCoreRun, type SafetyDeps } from "./handlers";
import { lineWordsOf, type RecordLine, type RecordResponse } from "./record";
import {
  SAFETY_ASK_LINE,
  asksIfInDanger,
  storedLabels,
  type LabelTense,
  type SafetyOutcome,
  type SafetyResult,
  type Tense,
} from "./rules";
import {
  BARBERSHOP,
  applySafetyWrites,
  bundleV0Words,
  safetyWorldOf,
  wordsDouble,
  type SafetyWorld,
  type WordsDouble,
} from "./test-support";

const validator = createToolApiValidator();

type RecordAction = Extract<CoreAction, { call: "recordSafetyOutcome" }>;

const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };
const NOW = "2026-10-26T21:40:02Z";

/** Bundle v0's words for K-01's fixed lines (its own manifest). */
const V0 = bundleV0Words();

/** A K-01 line's words in bundle v0; fails the test when it holds none. */
function v0(id: string): string {
  const text = V0.lines.get(id);
  if (text === undefined) throw new Error(`bundle v0 holds no words for ${id}`);
  return text;
}

const SAFETY_ASK = v0(SAFETY_ASK_LINE);
const SAFETY_EMERGENCY = v0("safetyEmergency");
const SAFETY_CRISIS = v0("safetyCrisis");

/** A K-02 v1 safety read (contracts/model/fixtures), a fresh copy; with `tense`, every label of it reads that tense. */
function k02(file: string, tense?: Tense): SafetyResult {
  const read = copy(contractJson(`model/fixtures/${file}`) as SafetyResult);
  if (tense === undefined || read.read === null) return read;
  const [first, ...rest] = read.read.labels;
  const labels: Labels = [{ ...first, tense }, ...rest.map((label) => ({ ...label, tense }))];
  return { ...read, read: { ...read.read, labels } };
}

/** A K-02 read's labels, as K-09 carries them (at least one). */
type Labels = NonNullable<SafetyResult["read"]>["labels"];

/** K-02's own unknown tense: "there was a fire in the back room", An emergency, no time given (Alex, evt-alex-0209). */
const emergencyUnknown = (): SafetyResult => k02("safety-unknown-tense.json");

/** Alex's crisis words (evt-alex-0203), read with a tense of unknown: now, or over? */
const crisisUnknown = (): SafetyResult => k02("safety-crisis-words.json", "unknown");

/** One of Alex's texts alone in its turn on his handle at the barbershop, bundle v0 pinned, as the commit hands it on. */
function alexTurn(read: SafetyResult): { readonly turn: CommitTurnContext; readonly action: RecordAction } {
  const turnId = `turn-${read.eventId}`;
  const caller: K09.Caller = {
    kind: "turn",
    turnId,
    requestId: turnId,
    businessId: BARBERSHOP,
    personId: "person-alex",
    traceId: `trace-${turnId}`,
  };
  const turn = {
    id: turnId,
    handleId: "handle-alex",
    eventIds: [read.eventId] as [string, ...string[]],
    bundleId: { ...bundleV0().bundleId },
    traceId: caller.traceId,
    joinedTraceIds: [],
    tries: 1,
  };
  const action: RecordAction = {
    call: "recordSafetyOutcome",
    request: { caller, safety: read, handleId: "handle-alex", bookingId: null, sentByActor: null },
  };
  const request: GateAndCommitRequest = {
    caller,
    turn,
    input: { kind: "coreOnly" },
    core: [action],
    now: NOW,
  };
  return { turn: { request, turn, repo: { name: "safety-ask-test-repo" }, businessId: BARBERSHOP }, action };
}

/** runCore's ports over the world (T-1140's doubles: bundle v0's lines, the same-bytes sealer), with this words port. */
function runCoreDeps(world: SafetyWorld, words: WordsDouble | null): CoreDeps<unknown> {
  return coreDoublesOn(world, words === null ? {} : { words }).deps;
}

/** The safety service's ports as runCore hands them on (core.ts createRunCore: the core's line rule on top). */
function serviceDeps(world: SafetyWorld, words: WordsDouble | null): SafetyDeps<unknown> {
  const { safety } = runCoreDeps(world, words);
  return { ...safety, lines: coreSafetyLines(safety.lines) };
}

/** One of Alex's texts recorded as its turn's core action, with bundle v0's words unless another words port is named. */
async function recorded(
  read: SafetyResult,
  words: WordsDouble | null = bundleV0Words(),
  world: SafetyWorld = safetyWorldOf(),
): Promise<RecordSafetyCoreRun> {
  const { turn, action } = alexTurn(read);
  return recordSafetyOutcomeCore(action, turn, NOTHING_OPEN, serviceDeps(world, words));
}

/** The answer of a record's core result, refused by nothing and held to K-09 v1's response. */
function responseOf(result: CoreRun["result"]): RecordResponse {
  if (result.call !== "recordSafetyOutcome" || result.response === null) {
    throw new Error(`not recorded: ${JSON.stringify(result.error)}`);
  }
  expect(validator.check("recordSafetyOutcome", "response", result.response)).toEqual([]);
  return result.response;
}

/** The record's line; fails the test when it has none. */
function lineOf(recordedRun: RecordSafetyCoreRun): RecordLine {
  if (recordedRun.line === null) throw new Error("the record writes a line");
  return recordedRun.line;
}

/** How many times `piece` stands in `text`. */
const timesIn = (text: string, piece: string): number => text.split(piece).length - 1;

let warn: MockInstance;
let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing the safety calls do writes a log line (K-08 v1: never a person's words, a number or an address).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------

describe("the core's emergency and crisis lines with a label of unknown tense carry safetyAsk once (CQ-172)", () => {
  it("bundle v0 holds K-01's three safety lines and the question with their words", () => {
    expect(SAFETY_ASK).toBe("Is anyone in danger right now?");
    expect(SAFETY_EMERGENCY).toContain("911");
    expect(SAFETY_CRISIS).toContain("988");
  });

  it("K-02's own unknown tense (a fire, no time given): the 911 line to Alex with the question after it, once", async () => {
    const read = emergencyUnknown();
    expect(read.read?.labels.map((label) => [label.outcome, label.tense])).toEqual([
      ["An emergency", "unknown"],
    ]);
    const run = await recorded(read);
    const answer = responseOf(run.run.result);
    const line = lineOf(run);

    expect(line).toEqual({
      fixedLineId: "safetyEmergency",
      to: "writer",
      outboxRowId: answer.safetyLine?.outboxRowId,
      fixedLines: ["safetyEmergency", "safetyAsk"],
      ask: SAFETY_ASK,
    });
    // On the same line after a space, as the actor's direct path places it.
    const words = lineWordsOf(SAFETY_EMERGENCY, line);
    expect(words).toBe(`${SAFETY_EMERGENCY} ${SAFETY_ASK}`);
    expect(words).not.toContain("\n");
    expect(timesIn(words, SAFETY_ASK)).toBe(1);
    // K-09 v1 still names the line by its own id, and its row goes to Alex as a safety row.
    expect(answer.safetyLine?.fixedLineId).toBe("safetyEmergency");
    expect(run.run.writes.messages.map((row) => [row.id, row.recipientHandleId, row.sendClass])).toEqual([
      [line.outboxRowId, "handle-alex", "safety"],
    ]);
  });

  it("Alex's crisis words of unknown tense: the 988 and 911 line to Alex with the question after it, once", async () => {
    const run = await recorded(crisisUnknown());
    const answer = responseOf(run.run.result);
    const line = lineOf(run);

    expect(line).toEqual({
      fixedLineId: "safetyCrisis",
      to: "writer",
      outboxRowId: answer.safetyLine?.outboxRowId,
      fixedLines: ["safetyCrisis", "safetyAsk"],
      ask: SAFETY_ASK,
    });
    const words = lineWordsOf(SAFETY_CRISIS, line);
    expect(words).toBe(`${SAFETY_CRISIS} ${SAFETY_ASK}`);
    expect(timesIn(words, SAFETY_ASK)).toBe(1);
    expect(line.fixedLines.filter((id) => id === SAFETY_ASK_LINE)).toHaveLength(1);
  });

  it("the record reads only the question's words, and its commit's rows still hold no words (they go in after it)", async () => {
    const words = bundleV0Words();
    const run = await recorded(emergencyUnknown(), words);
    expect(words.asked).toEqual([SAFETY_ASK_LINE]);
    const everything = stringsIn({ writes: run.run.writes, answer: run.run.result });
    expect(everything.some((each) => each.includes(SAFETY_ASK))).toBe(false);
    expect(everything.some((each) => each.includes(SAFETY_EMERGENCY))).toBe(false);
  });

  it("through runCore and gateAndCommit, the turn commits its record, hold and 911 row as before, the words port handed through", async () => {
    const read = emergencyUnknown();
    const { turn, action } = alexTurn(read);
    const words = bundleV0Words();
    const deps = runCoreDeps(safetyWorldOf(), words);
    // runCore runs the same record the service plans with its ports: the same result and writes. It hands the words port
    // through to the service, which reads the question's words from it (with none wired it answers notBuilt: below).
    const direct = await recordSafetyOutcomeCore(
      action,
      turn,
      NOTHING_OPEN,
      serviceDeps(safetyWorldOf(), bundleV0Words()),
    );
    expect(await createRunCore(deps)(action, turn, copy(NOTHING_OPEN))).toEqual(direct.run);
    expect(words.asked).toEqual([SAFETY_ASK_LINE]);

    const doubles = doublePorts();
    const ports: CommitPorts = { ...doubles.ports, runCore: createRunCore(deps) };
    const answer = await gateAndCommit(turn.request, callContext(BARBERSHOP), {
      limits: scriptedLimits(),
      ports,
    });
    if ("error" in answer || answer.result !== "committed") throw new Error("the turn commits");
    const [core] = answer.core;
    if (core?.call !== "recordSafetyOutcome") throw new Error("its core action is the safety record");
    expect(responseOf(core)).toMatchObject({
      outcomes: ["An emergency"],
      hold: { releaseRule: "after_safe" },
      safetyLine: { fixedLineId: "safetyEmergency", outboxRowId: lineOf(direct).outboxRowId },
    });
    const [sent] = doubles.k05.requests;
    expect(sent?.writes.outboxRows.map((row) => [row.id, row.recipientHandleId, row.sendClass])).toEqual([
      [lineOf(direct).outboxRowId, "handle-alex", "safety"],
    ]);
  });

  it("the same action twice, nothing committed between, gives the same line", async () => {
    const world = safetyWorldOf();
    const first = await recorded(emergencyUnknown(), bundleV0Words(), world);
    const again = await recorded(emergencyUnknown(), bundleV0Words(), world);
    expect(again.line).toEqual(first.line);
    expect(again.run).toEqual(first.run);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the same lines with an over, now, could restart, joke or No label carry none, and so do timed-out reads", () => {
  it.each<[string, Tense]>([
    ["over (the past tense)", "over"],
    ["now", "now"],
    ["could restart", "could restart"],
    ["joke", "joke"],
  ])("a label that reads %s: the 911 and the 988 and 911 lines go with no question", async (_name, tense) => {
    const cases: [SafetyResult, string][] = [
      [k02("safety-unknown-tense.json", tense), "safetyEmergency"],
      [k02("safety-crisis-words.json", tense), "safetyCrisis"],
    ];
    for (const [read, lineId] of cases) {
      const words = bundleV0Words();
      const run = await recorded(read, words);
      const line = lineOf(run);
      expect(line, read.eventId).toMatchObject({ fixedLineId: lineId, fixedLines: [lineId], ask: null });
      expect(lineWordsOf(v0(lineId), line), read.eventId).toBe(v0(lineId));
      // A line that asks nothing reads no words.
      expect(words.asked, read.eventId).toEqual([]);
    }
  });

  it("No: a No label of unknown tense, K-02's plain No and the gas leak fixed in March send no line at all", async () => {
    const reads = [k02("safety-no.json", "unknown"), k02("safety-no.json"), k02("safety-over-gas-leak.json")];
    for (const read of reads) {
      expect(read.outcomes, read.eventId).toEqual(["No"]);
      const run = await recorded(read);
      expect(run.line, read.eventId).toBeNull();
      expect(responseOf(run.run.result).safetyLine, read.eventId).toBeNull();
      expect(run.run.writes.messages, read.eventId).toEqual([]);
    }
  });

  it("a No label of unknown tense beside a danger label asks nothing: the question reads each label's own outcome", async () => {
    // A danger label of a known tense and [No, unknown]: the danger holds, and its line goes with no question, as the
    // actor's path asks none (its labels hold no danger label of unknown tense). T-1164's inserter, which reads no label's
    // own outcome, asks here (its default 1); the record reads its own labels, so it follows the actor exactly.
    const cases: [string, string][] = [
      ["safety-emergency-now.json", "safetyEmergency"],
      ["safety-crisis-words.json", "safetyCrisis"],
      ["safety-child-or-elder.json", "safetyEmergency"],
    ];
    for (const [file, lineId] of cases) {
      const read = k02(file);
      const [label] = read.read?.labels ?? [];
      if (label === undefined) throw new Error(`${file} holds a label`);
      const mixed: SafetyResult = {
        ...read,
        read: {
          labels: [label, { ...label, outcome: "No", tense: "unknown", evidence: "", atRisk: "nobody" }],
        },
      };
      const words = bundleV0Words();
      const line = lineOf(await recorded(mixed, words));
      expect(line, file).toMatchObject({ fixedLineId: lineId, fixedLines: [lineId], ask: null });
      expect(checkedLineFor(mixed, actorBundle()), file).toEqual({ id: lineId, text: v0(lineId) });
      expect(words.asked, file).toEqual([]);
    }
  });

  it("a read that timed out has no label (CQ-163 b): its danger words' line goes with no question", async () => {
    const cases: [string, string][] = [
      ["safety-timeout-danger-word.json", "safetyEmergency"],
      ["safety-timeout-self-harm-word.json", "safetyCrisis"],
    ];
    for (const [file, lineId] of cases) {
      const read = k02(file);
      expect(read.read, file).toBeNull();
      const words = bundleV0Words();
      const line = lineOf(await recorded(read, words));
      expect(line, file).toMatchObject({
        fixedLineId: lineId,
        to: "writer",
        fixedLines: [lineId],
        ask: null,
      });
      expect(words.asked, file).toEqual([]);
    }
  });

  it("a timeout with no danger word: the outage line, a quick_reply row, never carries the question", async () => {
    const read: SafetyResult = {
      ...k02("safety-timeout-danger-word.json"),
      dangerWords: [],
      outcomes: [],
      liftedToUnsure: false,
    };
    const run = await recorded(read);
    expect(lineOf(run)).toMatchObject({ fixedLineId: "outage", fixedLines: ["outage"], ask: null });
    expect(run.run.writes.messages.map((row) => row.sendClass)).toEqual(["quick_reply"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a threat's writer still gets no line, and the owner's line asks nothing", () => {
  it("a threat of unknown tense: its line goes to the owner (A3-48) with no question, and nothing goes to Alex", async () => {
    const read = k02("safety-threat.json", "unknown");
    const words = bundleV0Words();
    const run = await recorded(read, words);
    const line = lineOf(run);
    expect(line).toMatchObject({ to: "owner", fixedLines: [line.fixedLineId], ask: null });
    expect(
      run.run.writes.messages.map((row) => [
        row.id,
        row.recipientPersonId,
        row.recipientHandleId,
        row.sendClass,
      ]),
    ).toEqual([[line.outboxRowId, "person-sam", "handle-sam", "safety"]]);
    expect(words.asked).toEqual([]);
  });

  it("an emergency now beside a threat of unknown tense: the 911 line to Alex asks, as the actor's does (CQ-163 a)", async () => {
    const emergency = k02("safety-emergency-now.json");
    const [emergencyLabel] = emergency.read?.labels ?? [];
    const [threatLabel] = k02("safety-threat.json", "unknown").read?.labels ?? [];
    if (emergencyLabel === undefined || threatLabel === undefined) throw new Error("each read holds a label");
    const both: SafetyResult = {
      ...emergency,
      read: { labels: [emergencyLabel, threatLabel] },
      outcomes: ["An emergency", "A threat to staff or others"],
    };
    const line = lineOf(await recorded(both));
    expect(line).toMatchObject({
      fixedLineId: "safetyEmergency",
      to: "writer",
      fixedLines: ["safetyEmergency", "safetyAsk"],
      ask: SAFETY_ASK,
    });
    expect(checkedLineFor(both, actorBundle())).toEqual({
      id: "safetyEmergency",
      text: lineWordsOf(SAFETY_EMERGENCY, line),
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a bundle with no safetyAsk words fails closed, as finalize's inserter refuses such a row (T-1164)", () => {
  /** Bundle v0's words without the danger question's. */
  const withoutAsk = (): WordsDouble => wordsDouble([...V0.lines].filter(([id]) => id !== SAFETY_ASK_LINE));

  it("a line that must ask is refused (noSafetyAsk), naming only the text's event: nothing is written for it", async () => {
    const refused = recorded(emergencyUnknown(), withoutAsk());
    await expect(refused).rejects.toThrow(new SafetyRefusedError("noSafetyAsk", ["evt-alex-0209"]));
    await expect(recorded(crisisUnknown(), withoutAsk())).rejects.toMatchObject({
      name: "SafetyRefusedError",
      fault: "noSafetyAsk",
      rowIds: ["evt-alex-0203"],
    });
    // Blank words, or another line's words given for it, are no question either.
    const blank = wordsDouble([...withoutAsk().lines, [SAFETY_ASK_LINE, "  "]]);
    await expect(recorded(emergencyUnknown(), blank)).rejects.toMatchObject({ fault: "noSafetyAsk" });
    const wrongLine: WordsDouble = {
      ...V0,
      fixedLine: (id) => (id === SAFETY_ASK_LINE ? { id: "safetyEmergency", text: SAFETY_EMERGENCY } : null),
    };
    await expect(recorded(emergencyUnknown(), wrongLine)).rejects.toMatchObject({ fault: "noSafetyAsk" });
  });

  it("through runCore the refusal fails the turn unchanged, and K-05 gets nothing", async () => {
    const { turn, action } = alexTurn(emergencyUnknown());
    const deps = runCoreDeps(safetyWorldOf(), withoutAsk());
    await expect(createRunCore(deps)(action, turn, copy(NOTHING_OPEN))).rejects.toBeInstanceOf(
      SafetyRefusedError,
    );
    const doubles = doublePorts();
    const ports: CommitPorts = { ...doubles.ports, runCore: createRunCore(deps) };
    await expect(
      gateAndCommit(turn.request, callContext(BARBERSHOP), { limits: scriptedLimits(), ports }),
    ).rejects.toMatchObject({ fault: "noSafetyAsk" });
    expect(doubles.k05.requests).toEqual([]);
  });

  it("with no words port wired, a line that must ask is not built: runCore answers notBuilt (portNotWired)", async () => {
    await expect(recorded(emergencyUnknown(), null)).rejects.toThrow(NotBuiltError);
    const { turn, action } = alexTurn(emergencyUnknown());
    const refused = await createRunCore(runCoreDeps(safetyWorldOf(), null))(
      action,
      turn,
      copy(NOTHING_OPEN),
    ).catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(CoreNotBuiltError);
    expect(refused).toMatchObject({ core: "recordSafetyOutcome", gap: "portNotWired" });
    expect((refused as Error).cause).toBeInstanceOf(NotBuiltError);
  });

  it("a line that asks nothing needs no words: with none for the question, or no port at all, it goes", async () => {
    for (const words of [withoutAsk(), null]) {
      const run = await recorded(k02("safety-emergency-now.json"), words);
      expect(lineOf(run)).toMatchObject({
        fixedLineId: "safetyEmergency",
        fixedLines: ["safetyEmergency"],
        ask: null,
      });
      expect(words?.asked ?? []).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("a repeat names the first record's line, its question read again from the stored labels and tenses", () => {
  it("once the first is committed, the same text's record answers it as repeated, with the same line, writing nothing", async () => {
    const world = safetyWorldOf();
    const first = await recorded(emergencyUnknown(), bundleV0Words(), world);
    applySafetyWrites(world, first.run.writes.state, first.run.writes.messages);
    const stored = world.safety.outcomes.find((outcome) => outcome.eventId === "evt-alex-0209");
    if (stored === undefined) throw new Error("the first record is stored");
    expect(storedLabels(stored)).toEqual([{ outcome: "An emergency", tense: "unknown" }]);

    const again = await recorded(emergencyUnknown(), bundleV0Words(), world);
    expect(responseOf(again.run.result)).toEqual({ ...responseOf(first.run.result), repeated: true });
    expect(again.line).toEqual(first.line);
    expect(lineOf(again).ask).toBe(SAFETY_ASK);
    expect(again.run.writes.state).toEqual([]);
    expect(again.run.writes.messages).toEqual([]);
    // Its words are the pinned bundle's as for the first: with none for the question it is refused the same way.
    await expect(recorded(emergencyUnknown(), wordsDouble([]), world)).rejects.toMatchObject({
      fault: "noSafetyAsk",
    });
  });

  it("a repeat of a line that asked nothing reads no words", async () => {
    const world = safetyWorldOf();
    const first = await recorded(k02("safety-emergency-now.json"), bundleV0Words(), world);
    applySafetyWrites(world, first.run.writes.state, first.run.writes.messages);
    const again = await recorded(k02("safety-emergency-now.json"), null, world);
    expect(again.line).toEqual(first.line);
    expect(lineOf(again).ask).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the rule, from the record's own labels (rules.ts asksIfInDanger, storedLabels)", () => {
  const label = (outcome: SafetyOutcome, tense: Tense): LabelTense => ({ outcome, tense });

  it("asks for a label of unknown tense whose outcome is not No; never otherwise", () => {
    expect(asksIfInDanger([label("An emergency", "unknown")])).toBe(true);
    expect(asksIfInDanger([label("Crisis words", "unknown")])).toBe(true);
    expect(asksIfInDanger([label("Unsure", "unknown")])).toBe(true);
    expect(asksIfInDanger([label("An emergency", "now"), label("Crisis words", "unknown")])).toBe(true);

    expect(asksIfInDanger([label("No", "unknown")])).toBe(false);
    expect(asksIfInDanger([label("Harm to a child or older adult", "now"), label("No", "unknown")])).toBe(
      false,
    );
    for (const tense of ["now", "could restart", "over", "joke"] as const) {
      expect(asksIfInDanger([label("An emergency", tense)]), tense).toBe(false);
    }
    expect(asksIfInDanger([])).toBe(false);
  });

  it("pairs K-34's stored labels and tenses in order; a label with no tense beside it reads as unknown", () => {
    expect(storedLabels({ labels: ["An emergency", "No"], tenses: ["now", "unknown"] })).toEqual([
      label("An emergency", "now"),
      label("No", "unknown"),
    ]);
    expect(storedLabels({ labels: ["Crisis words"], tenses: [] })).toEqual([
      label("Crisis words", "unknown"),
    ]);
    expect(storedLabels({ labels: [], tenses: [] })).toEqual([]);
  });

  it("places the question as the actor does: on the line's own line, after a space, once", () => {
    expect(lineWordsOf(SAFETY_CRISIS, { ask: null })).toBe(SAFETY_CRISIS);
    expect(lineWordsOf(SAFETY_CRISIS, { ask: SAFETY_ASK })).toBe(`${SAFETY_CRISIS} ${SAFETY_ASK}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Bundle v0 as the handle actor's direct path reads it: K-01's fixed lines with their words, and no step's own line. */
function actorBundle(): BundleSafety {
  return { fixedLine: (id) => V0.fixedLine(id), outcomeLine: () => null, dangerWords: () => [] };
}

describe("parity with the handle actor's checkedLineFor (T-1143) on K-02 v1's eleven safety reads and their unknown-tense versions", () => {
  /** K-02 v1's accepted safety reads (contracts/model/fixtures/index.json). */
  const SAFETY_READS = (
    contractJson("model/fixtures/index.json") as {
      fixtures: readonly { file: string; version: string; def: string; expect: string }[];
    }
  ).fixtures
    .filter((entry) => entry.version === "v1" && entry.def === "safetyResult" && entry.expect === "accept")
    .map((entry) => entry.file);

  /** Each read as it is, and again with every tense unknown where that changes one (a timeout has no label). */
  const READS = SAFETY_READS.flatMap((file) => {
    const asRead = k02(file);
    const changes = asRead.read?.labels.some((label) => label.tense !== "unknown") ?? false;
    return changes ? [asRead, k02(file, "unknown")] : [asRead];
  });

  const nameOf = (read: SafetyResult): string => {
    const labels = (read.read?.labels ?? []).map((label) => `${label.outcome} (${label.tense})`);
    return `${read.eventId}: ${labels.join(", ") || "timed out"}`;
  };

  it("covers K-02's eleven safety reads and eight unknown-tense versions; lines that ask and lines that do not", () => {
    expect(SAFETY_READS).toHaveLength(11);
    expect(READS).toHaveLength(19);
    const lines = READS.map((read) => checkedLineFor(read, actorBundle()));
    const asking = lines.filter((line) => line?.text.endsWith(` ${SAFETY_ASK}`) ?? false);
    // The actor sends no line for No (four reads) and a threat (two); of its 13 lines, the six unknown-tense danger reads ask.
    expect(lines.filter((line) => line !== null)).toHaveLength(13);
    expect(asking).toHaveLength(6);
  });

  it.each(READS.map((read) => [nameOf(read), read] as const))(
    "%s: the core's line is the actor's, word for word, the question included or not alike",
    async (_name, read) => {
      const actor = checkedLineFor(read, actorBundle());
      const run = await recorded(read);
      const answer = responseOf(run.run.result);
      const toAlex = run.run.writes.messages.filter((row) => row.recipientHandleId === "handle-alex");

      if (actor === null) {
        if (read.outcomes.includes("A threat to staff or others")) {
          // The actor sends a threat's writer nothing; the core's line goes only to the owner, and asks nothing.
          expect(lineOf(run)).toMatchObject({ to: "owner", ask: null });
          expect(toAlex).toEqual([]);
        } else {
          // No: nothing to send on either path.
          expect(read.outcomes).toEqual(["No"]);
          expect(run.line).toBeNull();
          expect(answer.safetyLine).toBeNull();
        }
        return;
      }
      const line = lineOf(run);
      expect(line.to).toBe("writer");
      expect({ id: line.fixedLineId, text: lineWordsOf(v0(line.fixedLineId), line) }).toEqual(actor);
      const asks = actor.text !== v0(actor.id);
      expect(line.fixedLines).toEqual(asks ? [actor.id, SAFETY_ASK_LINE] : [actor.id]);
      expect(asksIfInDanger(read.read?.labels ?? [])).toBe(asks);
      expect(answer.safetyLine).toEqual({ fixedLineId: actor.id, outboxRowId: line.outboxRowId });
      expect(toAlex.map((row) => [row.id, row.sendClass])).toEqual([[line.outboxRowId, "safety"]]);
    },
  );
});
