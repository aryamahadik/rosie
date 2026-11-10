// T-315's unit proof (DL-319 ruling 2; DL-322 ruling 8): the turn face's buildFrontier on K-09 v1's
// build-frontier-s1-02.json, as main has it (T-1142's turn 1 fixture has not merged), through the Tool API base with the
// frontier's sources as main's registry has them. Its answer is the fixture's frontier as far as main's sources give it,
// and each choice they cannot give yet is named, with the task it waits for (test-support.ts WAITING), never stood in for.
//
// No database: the stored state is the frontier's fake K-05 v1.2 readTurnState (Sam's state at S1-02: his handle, person,
// owner role, and S1-02's question sent at 14:02 under bundle v0), each request and answer held to K-05 v1.2's frozen
// schema, behind a scope that records each transaction; the bundle is K-01 v1's bundle-v0-skeleton.json. The same call on
// local PostgreSQL, under the call's business scope as rosie_job, is pg/turn-face.int.test.ts. Values come only from the
// contracts' fixtures and the master's sample cast (rule 9).

import { describe, expect, it } from "vitest";

import { isLabel, type Span } from "../../../../runtime/src/trace";
import { FRONTIER_SOURCES, SLOT_NAMES } from "../../frontier";
import {
  BUNDLE_V0,
  captureLog,
  checks,
  fakeBundles,
  fakeRepo,
  frontierScope,
  s102Exchange,
  sampleBundle,
  samSeed,
  stringsIn,
  type FakeBundles,
  type FakeRepo,
  type FrontierScope,
  type LogCapture,
} from "../../frontier/assemble/test-support";
import type { Context } from "../../frontier/assemble/types";
import { traceFor } from "../test-support";
import { SLOTS_NOT_BUILT, WAITING, asFarAsMain } from "./test-support";
import { createTurnFace, type BuildFrontierCallAnswer } from "./turn-face";

type Json = Record<string, unknown>;

const { validator, checker } = checks();

/** What one call through the turn face left: its answer, the reads, the transaction, the bundle reads, log and spans. */
interface Called {
  answer: BuildFrontierCallAnswer;
  repo: FakeRepo;
  scope: FrontierScope;
  bundles: FakeBundles;
  log: LogCapture;
  spans: Span[];
}

/** One buildFrontier call through a turn face over Sam's stored state at S1-02 and bundle v0. */
async function callTurnFace(request: unknown): Promise<Called> {
  const repo = fakeRepo(samSeed());
  const scope = frontierScope(repo);
  const bundles = fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  const log = captureLog();
  const face = createTurnFace<FakeRepo>({ scope, bundles, validator, checker, log: log.sink });
  const { trace, spans } = traceFor(request);
  const answer = await face.buildFrontier(structuredClone(request), trace);
  return { answer, repo, scope, bundles, log, spans };
}

function contextOf(answer: BuildFrontierCallAnswer): Context {
  if ("error" in answer) throw new Error(`the turn face answered ${answer.error}`);
  return answer.context;
}

describe("build-frontier-s1-02.json through the turn face", () => {
  it("gives the fixture's frontier as far as main's frontier sources give it: S1-02's three options and card", async () => {
    const exchange = s102Exchange();
    const called = await callTurnFace(exchange.request);

    expect(called.answer).toEqual(asFarAsMain(exchange));
    const context = contextOf(called.answer);
    expect(context.choices.map((choice) => [choice.choiceId, choice.kind, choice.step])).toEqual([
      ["c-01", "option", "S1-02"],
      ["c-02", "option", "S1-02"],
      ["c-03", "option", "S1-02"],
    ]);
    expect(context.recentMessages).toEqual([]);
    expect(validator.check("buildFrontier", "response", called.answer)).toEqual([]);
    expect(checker.check("context", context)).toEqual([]);

    // Each slot main has not built is logged on the call (fail closed), by labels only.
    expect(called.log.lines).toEqual(
      SLOTS_NOT_BUILT.map((source) => ({
        level: "warn",
        msg: "frontier_source_missing",
        trace_id: "trace-sam-0001",
        turn_id: "turn-s1-02-sam-kinds",
        source,
      })),
    );
  });

  it("names each choice main cannot give yet with the task it waits for: not in the answer, its slot still empty", async () => {
    const exchange = s102Exchange();
    const called = await callTurnFace(exchange.request);
    const given = contextOf(called.answer).choices.map((choice) => choice.choiceId);
    const fixtureChoices = exchange.outcome.context.choices;

    for (const waiting of WAITING) {
      const choice = fixtureChoices.find((each) => each.choiceId === waiting.choiceId);
      expect(choice, `${waiting.choiceId} is one of the fixture's choices`).toMatchObject({
        kind: waiting.kind,
        step: waiting.step,
      });
      expect(given, `${waiting.choiceId} waits for ${waiting.task}`).not.toContain(waiting.choiceId);
      const slot = FRONTIER_SOURCES.find((each) => each.name === waiting.slot);
      expect(slot, `${waiting.slot} is a slot of the frontier`).toBeDefined();
      expect(
        slot?.source ?? null,
        `${waiting.task} has filled the ${waiting.slot} slot: ${waiting.choiceId} no longer waits, so take it off WAITING`,
      ).toBeNull();
      expect(called.log.lines.map((line) => line.source)).toContain(waiting.slot);
    }
    // Every choice of the fixture is either given or named as waiting: none is left out silently.
    expect([...given, ...WAITING.map((each) => each.choiceId)].sort()).toEqual(
      fixtureChoices.map((choice) => String(choice.choiceId)).sort(),
    );
    expect(
      SLOT_NAMES.filter((name) =>
        FRONTIER_SOURCES.some((slot) => slot.name === name && slot.source === null),
      ),
    ).toEqual([...SLOTS_NOT_BUILT]);
  });

  it("reads the stored state once, under the call's business, through K-05 v1.2 readTurnState, and writes nothing", async () => {
    const exchange = s102Exchange();
    const called = await callTurnFace(exchange.request);

    expect(called.repo.calls).toHaveLength(1);
    expect(called.repo.calls[0]).toMatchObject({
      call: "readTurnState",
      scope: "biz-lees-barbershop",
      request: { handleId: "handle-sam", businessId: "biz-lees-barbershop", bookingIds: [] },
    });
    // One transaction, scoped before the read, that only reads (K-09 README: buildFrontier is safe to repeat).
    expect(called.scope.events).toEqual([
      { what: "begin" },
      { what: "scope", businessId: "biz-lees-barbershop" },
      { what: "commit" },
    ]);
    // The turn's pinned bundle, as the request names it.
    expect(called.bundles.reads).toEqual([`${BUNDLE_V0.hash}/1/manifest`, `${BUNDLE_V0.hash}/1/flow/A`]);
  });

  it("records one K-08 span, hop frontier, with labels only: no text, number, name or choice's words", async () => {
    const exchange = s102Exchange();
    const called = await callTurnFace(exchange.request);
    expect(called.spans).toHaveLength(1);
    const [span] = called.spans;
    expect(span).toMatchObject({
      hop: "frontier",
      outcome: "ok",
      trace_id: "trace-sam-0001",
      business_id: "biz-lees-barbershop",
    });
    expect(validator.checkSpan(span)).toEqual([]);

    const context = exchange.outcome.context as unknown as Context;
    const words = [
      ...context.texts.map((text) => text.words),
      ...context.choices.flatMap((choice) => [choice.label, choice.definition, choice.target.businessName]),
      context.writer.handle,
      ...context.writer.people.map((person) => person.name),
    ];
    for (const line of [JSON.stringify(span), ...called.log.lines.map((each) => JSON.stringify(each))]) {
      for (const each of words) expect(line.includes(each), `"${each}" in ${line}`).toBe(false);
    }
    for (const line of called.log.lines) expect(stringsIn(line).every((value) => isLabel(value))).toBe(true);
  });

  it("refuses before any read: a request naming no business, and one K-09 v1 refuses", async () => {
    const exchange = s102Exchange();
    const unscoped = structuredClone(exchange.request) as Json & { caller: Json };
    unscoped.caller.businessId = null;
    const noScope = await callTurnFace(unscoped);
    expect(noScope.answer).toEqual({ error: "noBusinessScope", call: "buildFrontier" });

    const broken = structuredClone(exchange.request) as Json;
    delete broken.targets;
    const invalid = await callTurnFace(broken);
    expect(invalid.answer).toMatchObject({ error: "invalidRequest", call: "buildFrontier" });

    for (const called of [noScope, invalid]) {
      expect(called.repo.calls).toEqual([]);
      expect(called.scope.events).toEqual([]);
      expect(called.bundles.reads).toEqual([]);
    }
  });
});
