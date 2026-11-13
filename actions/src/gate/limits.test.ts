// T-1183's proofs through the shipped registry (the card's "Proves it with"; DL-364, T-1141's Need 1). limits.ts holds
// the record flags, then limits 1 to 6, each over its shipped ports, as gateAndCommit's gate runs them; no limit is a
// double here:
//   - turn 1's sign-up door part, as K-09 v1.5's commit-s1-01.json gives it, passes all six limits with exactly the
//     fixture's answers (1, 4 and 6 pass; 2, 3 and 5 are not checked), and the gate span logs them as K-08 v1's
//     trace-skeleton.json's gate span does (ADR-013 section 2). Nothing is read: the call's repo here is no database, so
//     any read would fail the call;
//   - a door the gate does not know still answers unknown at limit 1, so nobody decides it: the part stops there with
//     limit 1's askedDecider, and no limit after it is checked.
// Each of K-01's five doors answers as before in each limit's own tests (limit-1, limit-2, limit-4 and limit-6).

import { describe, expect, it } from "vitest";

import { contractFile } from "../tool-api/test-support";
import { partResultOf, runGate, type GateVerdict, type GatedPart, type LimitResult } from "./framework";
import { callContext, gateExchange } from "./framework/test-support";
import { askedDeciderOutcome } from "./limit-1";
import {
  BARBERSHOP,
  SIGN_UP_FIXTURE,
  TEST_REPO,
  enteringDoor,
  exchangeRequest,
  partOf,
  turnOf,
  unknownDoor,
} from "./limit-1/test-support";
import { limit2 } from "./limit-2";
import { limit3 } from "./limit-3";
import { limit4 } from "./limit-4";
import { limit5 } from "./limit-5";
import { limit6 } from "./limit-6";
import { LIMITS } from "./limits";

/** Turn 1's six limit answers as ADR-013 section 2 and the card state them: 1, 4 and 6 pass; 2, 3 and 5 not checked. */
const TURN_ONE: readonly LimitResult[] = [
  { limit: 1, result: "pass", outcome: null },
  { limit: 2, result: "notChecked", outcome: null },
  { limit: 3, result: "notChecked", outcome: null },
  { limit: 4, result: "pass", outcome: null },
  { limit: 5, result: "notChecked", outcome: null },
  { limit: 6, result: "pass", outcome: null },
];

/** The parts of a gated verdict; fails the test for a refused one. */
function gatedParts(verdict: GateVerdict): readonly GatedPart[] {
  if (verdict.verdict !== "gated") throw new Error(`refused: ${JSON.stringify(verdict.error)}`);
  return verdict.parts;
}

/** A K-09 exchange's committed outcome; fails the test for any other. */
function committedOf(file: string) {
  const { outcome } = gateExchange(file);
  if ("error" in outcome || outcome.result !== "committed") throw new Error(`${file} is not committed`);
  return outcome;
}

/** The limits K-08 v1's trace-skeleton.json logs on its gate span: the skeleton's turn 1. */
function skeletonGateLimits(): unknown {
  const trace = contractFile("event-trace/fixtures/trace-skeleton.json") as {
    spans: { hop: string; limits?: unknown }[];
  };
  const gate = trace.spans.find((span) => span.hop === "gate");
  if (gate === undefined) throw new Error("trace-skeleton.json has no gate span");
  return gate.limits;
}

describe("T-1183: turn 1's sign-up door part through the shipped registry (DL-364)", () => {
  it("commit-s1-01.json: Sam's part passes all six limits with exactly the fixture's answers, nothing read, and the gate span logs them as trace-skeleton.json's gate span does", async () => {
    const call = callContext(BARBERSHOP);
    const verdict = await runGate(exchangeRequest(SIGN_UP_FIXTURE), call, LIMITS);
    const stated = committedOf(SIGN_UP_FIXTURE).parts;
    expect(gatedParts(verdict).map((part, index) => partResultOf(part, stated[index]?.gives ?? []))).toEqual(
      stated,
    );
    expect(stated.map((part) => part.limits)).toEqual([TURN_ONE]);
    expect(call.span.limits).toEqual(TURN_ONE);
    expect(call.span.limits).toEqual(skeletonGateLimits());
  });

  it("each slot's own answer on the part: the flags hold nothing; limit 1 passes it on anyone's word; limit 4 passes with no row to compare and set; limit 6 passes with no value; limits 2, 3 and 5 have nothing to check", async () => {
    const request = exchangeRequest(SIGN_UP_FIXTURE);
    const part = partOf(request);
    const turn = turnOf(request, TEST_REPO);
    const [slotOne] = LIMITS;
    expect(await slotOne.flags(part, turn)).toEqual({ result: "pass" });
    const verdicts: { limit: number; result: string }[] = [];
    for (const slot of LIMITS)
      verdicts.push({ limit: slot.limit, result: (await slot.check(part, turn)).result });
    expect(verdicts).toEqual(TURN_ONE.map(({ limit, result }) => ({ limit, result })));
    expect([
      await slotOne.decide(part, turn),
      await limit2.decide(part, turn),
      await limit3.decide(part, turn),
      await limit4.decide(part, turn),
      await limit5.decide(part, turn),
      await limit6.decide(part, turn),
    ]).toEqual([
      { result: "pass", why: "anyone" },
      { result: "notChecked" },
      { result: "notChecked" },
      { result: "pass", compareAndSet: [] },
      { result: "notChecked" },
      { result: "pass" },
    ]);
  });

  it("a door the gate does not know still answers unknown at limit 1, then nobodyDecides: the part stops there with askedDecider, and no limit after it is checked", async () => {
    const request = enteringDoor(unknownDoor());
    const call = callContext(BARBERSHOP);
    const parts = gatedParts(await runGate(request, call, LIMITS));
    const stopped = [
      { limit: 1, result: "fail", outcome: "askedDecider" },
      ...TURN_ONE.slice(1).map(({ limit }) => ({ limit, result: "notChecked", outcome: null })),
    ];
    expect(parts).toEqual([
      {
        part: 0,
        choiceId: "c-01",
        result: "stopped",
        limits: stopped,
        stoppedBy: askedDeciderOutcome(),
        refusedBy: null,
        dependsOnPart: null,
      },
    ]);
    expect(call.span.limits).toEqual(stopped);
    expect(await LIMITS[0].decide(partOf(request), turnOf(request, TEST_REPO))).toEqual({
      result: "fail",
      why: "nobodyDecides",
      outcome: askedDeciderOutcome(),
      next: { kind: "nobodyDecides", why: "unknownChange", step: "S1-01" },
    });
  });
});
