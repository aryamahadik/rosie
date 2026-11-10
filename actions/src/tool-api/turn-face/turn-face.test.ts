// T-315's unit proof, round 4 (DL-346 rulings 1 and 2; ADR-013 section 6's T-315 lines): the turn face's buildFrontier
// on turn 1, Sam's first text (K-09 v1.5 build-frontier-s1-01.json), through the Tool API base with the frontier's
// sources as main's registry has them. Its answer is the fixture's frontier as far as main's sources give it
// (test-support.ts asFarAsMain): the fixture's frontier less the choices named as waiting, each with its task
// (test-support.ts WAITING), never stood in for. Since T-1147 wired turn 1's one choice, the sign-up door, into the
// frontier, none waits (DL-365): the same tests expect the fixture's whole frontier, its span ok and its transaction
// committed. With no choice left, the call would fail closed with FrontierError noChoices, its frontier span failed
// (error_code FrontierError) and its transaction rolled back.
//
// No database: the stored state is the frontier's fake K-05 v1.2 readTurnState over T-1148's seed rows (test owner 1,
// Sam, with no role, no open question, no booking and no phone row: test-support.ts firstTextSeed), each request and
// answer held to K-05 v1.2's frozen schema, behind a scope that records each transaction; the bundle is K-01 v1's
// bundle-v0-skeleton.json, which the fixture's turn pins. The same call on local PostgreSQL, on T-1148's seed itself under
// the call's business scope as rosie_job, is pg/turn-face.int.test.ts. Values come only from the contracts' fixtures and
// the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { isLabel, type Span } from "../../../../runtime/src/trace";
import { FrontierError } from "../../frontier";
import { frameFacts } from "../../frontier/assemble/frame";
import {
  BUNDLE_V0,
  captureLog,
  checks,
  fakeBundles,
  fakeRepo,
  frontierScope,
  sampleBundle,
  stringsIn,
  type FakeBundles,
  type FakeRepo,
  type FrontierScope,
  type LogCapture,
} from "../../frontier/assemble/test-support";
import type { Context } from "../../frontier/assemble/types";
import { traceFor } from "../test-support";
import {
  WAITING,
  asFarAsMain,
  firstTextSeed,
  s101Exchange,
  slotsNotBuilt,
  type AsFarAsMain,
} from "./test-support";
import { createTurnFace, type BuildFrontierCallAnswer } from "./turn-face";

type Json = Record<string, unknown>;

const BARBERSHOP = "biz-lees-barbershop";
const TRACE = "trace-sam-0000";
const TURN = "turn-s1-01-sam";
/** Every bundle read of the call is of the turn's pinned bundle (BUNDLE_V0 by its key). */
const PINNED = `${BUNDLE_V0.hash}/${String(BUNDLE_V0.build)}/`;

const { validator, checker } = checks();

/** What one call through the turn face left: its answer or what it threw, the reads, the transaction, log and spans. */
interface Called {
  answer: BuildFrontierCallAnswer | undefined;
  thrown: unknown;
  repo: FakeRepo;
  scope: FrontierScope;
  bundles: FakeBundles;
  log: LogCapture;
  spans: Span[];
}

/** One buildFrontier call through a turn face over turn 1's stored state (T-1148's rows) and bundle v0. */
async function callTurnFace(request: unknown): Promise<Called> {
  const repo = fakeRepo(firstTextSeed());
  const scope = frontierScope(repo);
  const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  const log = captureLog();
  const face = createTurnFace<FakeRepo>({ scope, bundles, validator, checker, log: log.sink });
  const { trace, spans } = traceFor(request);
  const settled = await face.buildFrontier(structuredClone(request), trace).then(
    (answer) => ({ answer, thrown: undefined }),
    (thrown: unknown) => ({ answer: undefined, thrown }),
  );
  return { ...settled, repo, scope, bundles, log, spans };
}

/** The choices the call gave: none when it answered no context. */
function givenChoices(called: Called): string[] {
  if (called.answer === undefined || "error" in called.answer) return [];
  return called.answer.context.choices.map((choice) => choice.choiceId);
}

/** How the call's one transaction ends: committed with its answer, rolled back when the frontier fails closed. */
function transactionEnd(expected: AsFarAsMain): "commit" | "rollback" {
  return expected.ends === "answer" ? "commit" : "rollback";
}

/** The frontier span's ending: ok with K-09's response, or failed with the thrown FrontierError. */
function spanEnding(expected: AsFarAsMain): Partial<Span> {
  return expected.ends === "answer"
    ? { outcome: "ok", error_code: null, decided: { answered: "response" } }
    : { outcome: "failed", error_code: "FrontierError", decided: { answered: "thrown" } };
}

/** The call answered as far as main gives the fixture's frontier, or failed closed with noChoices when that is none. */
function expectAsFarAsMain(called: Called, expected: AsFarAsMain): void {
  if (expected.ends === "answer") {
    expect(called.thrown).toBeUndefined();
    expect(called.answer).toEqual(expected.answer);
    expect(validator.check("buildFrontier", "response", called.answer)).toEqual([]);
    expect(checker.check("context", (called.answer as { context: Context }).context)).toEqual([]);
  } else {
    expect(called.answer).toBeUndefined();
    expect(called.thrown).toBeInstanceOf(FrontierError);
    // A builder fault, never a refusal of the caller: K-09's buildFrontier.errors names no error for an empty frontier
    // (CQ-167), so the call throws and the actor maps it to noAnswer. Its message is its code, never a value.
    expect((called.thrown as FrontierError).code).toBe("noChoices");
    expect((called.thrown as FrontierError).message).toBe("noChoices");
  }
}

describe("build-frontier-s1-01.json, turn 1, through the turn face", () => {
  it("gives the fixture's frontier as far as main's frontier sources give it, and fails closed (noChoices) when that is none", async () => {
    const exchange = s101Exchange();
    const expected = asFarAsMain(exchange);
    const called = await callTurnFace(exchange.request);

    expectAsFarAsMain(called, expected);
    expect(called.scope.events.at(-1)).toEqual({ what: transactionEnd(expected) });
    expect(called.spans).toHaveLength(1);
    expect(called.spans[0]).toMatchObject({ hop: "frontier", ...spanEnding(expected) });

    // Each slot main has not built is logged on the call (fail closed), by labels only.
    expect(
      called.log.lines
        .filter((line) => line.msg === "frontier_source_missing")
        .map((line) => [line.trace_id, line.turn_id, line.source]),
    ).toEqual(slotsNotBuilt().map((source) => [TRACE, TURN, source]));
  });

  it("names each choice main cannot give yet with the task it waits for: not in the answer, its slot still empty", async () => {
    const exchange = s101Exchange();
    const called = await callTurnFace(exchange.request);
    const given = givenChoices(called);
    const fixtureChoices = exchange.outcome.context.choices;

    for (const waiting of WAITING) {
      const choice = fixtureChoices.find((each) => each.choiceId === waiting.choiceId);
      expect(choice, `${waiting.choiceId} is one of the fixture's choices`).toMatchObject({
        kind: waiting.kind,
        door: waiting.door,
        step: waiting.step,
      });
      expect(given, `${waiting.choiceId} waits for ${waiting.task}`).not.toContain(waiting.choiceId);
      expect(
        slotsNotBuilt(),
        `${waiting.task} has filled the ${waiting.slot} slot: ${waiting.choiceId} no longer waits, so take it off WAITING`,
      ).toContain(waiting.slot);
      expect(called.log.lines.map((line) => line.source)).toContain(waiting.slot);
    }
    // Every choice of the fixture is either given or named as waiting: none is left out silently.
    expect([...given, ...WAITING.map((each) => each.choiceId)].sort()).toEqual(
      fixtureChoices.map((choice) => String(choice.choiceId)).sort(),
    );
  });

  it("reads the stored state once, under the call's business, through K-05 v1.2 readTurnState, and writes nothing", async () => {
    const exchange = s101Exchange();
    const expected = asFarAsMain(exchange);
    const called = await callTurnFace(exchange.request);

    // One read, under Lee's Barbershop's scope, naming that business, Sam's handle, no booking, and the facts of the
    // frame: the business's name and zone, and the caller's name (Sam has no role for the guard to list).
    expect(called.repo.calls).toEqual([
      {
        call: "readTurnState",
        scope: BARBERSHOP,
        request: {
          handleId: "handle-sam",
          businessId: BARBERSHOP,
          bookingIds: [],
          facts: frameFacts(BARBERSHOP, ["person-sam"]),
        },
      },
    ]);
    // One transaction, scoped before the read, that only reads (K-09 README: buildFrontier is safe to repeat).
    expect(called.scope.events).toEqual([
      { what: "begin" },
      { what: "scope", businessId: BARBERSHOP },
      { what: transactionEnd(expected) },
    ]);
    // The turn's pinned bundle, as the request names it: its manifest first, then flow A's graph.
    expect(called.bundles.reads.slice(0, 2)).toEqual([`${PINNED}manifest`, `${PINNED}flow/A`]);
    expect(called.bundles.reads.every((read) => read.startsWith(PINNED))).toBe(true);
  });

  it("records one K-08 span, hop frontier, with labels only: no text, number, name or choice's words", async () => {
    const exchange = s101Exchange();
    const expected = asFarAsMain(exchange);
    const called = await callTurnFace(exchange.request);
    expect(called.spans).toHaveLength(1);
    const [span] = called.spans;
    expect(span).toMatchObject({
      hop: "frontier",
      trace_id: TRACE,
      turn_id: TURN,
      business_id: BARBERSHOP,
      got: { toolCall: "buildFrontier", callerKind: "turn" },
      ...spanEnding(expected),
    });
    expect(validator.checkSpan(span)).toEqual([]);

    const context = exchange.outcome.context as unknown as Context;
    const words = [
      ...context.texts.map((text) => text.words),
      ...context.choices.flatMap((choice) => [choice.label, choice.definition, choice.target.businessName]),
      context.writer.handle,
      ...context.writer.people.map((person) => person.name),
    ];
    const thrown = called.thrown instanceof Error ? [called.thrown.message] : [];
    for (const line of [
      JSON.stringify(span),
      ...called.log.lines.map((each) => JSON.stringify(each)),
      ...thrown,
    ]) {
      for (const each of words) expect(line.includes(each), `"${each}" in ${line}`).toBe(false);
    }
    for (const line of called.log.lines) expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
  });

  it("refuses before any read: a request naming no business, and one K-09 refuses", async () => {
    const exchange = s101Exchange();
    const unscoped = structuredClone(exchange.request) as Json & { caller: Json };
    unscoped.caller.businessId = null;
    const noScope = await callTurnFace(unscoped);
    expect(noScope.answer).toEqual({ error: "noBusinessScope", call: "buildFrontier" });

    const broken = structuredClone(exchange.request) as Json;
    delete broken.targets;
    const invalid = await callTurnFace(broken);
    expect(invalid.answer).toMatchObject({ error: "invalidRequest", call: "buildFrontier" });

    for (const called of [noScope, invalid]) {
      expect(called.thrown).toBeUndefined();
      expect(called.repo.calls).toEqual([]);
      expect(called.scope.events).toEqual([]);
      expect(called.bundles.reads).toEqual([]);
      expect(called.spans).toHaveLength(1);
      expect(called.spans[0]).toMatchObject({ hop: "frontier", outcome: "refused" });
    }
  });
});
