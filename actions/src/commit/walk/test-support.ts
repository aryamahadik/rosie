// Fixtures and doubles for the walk's tests (T-1139). Never imported by the Worker. The one double is the bundles port,
// which hands the walk K-01 v1's bundle-v0-skeleton.json (the bundle commit-s1-01.json's turn pins) and writes down each
// read; it never stands in for the walk under test. Values come only from the contracts' fixtures (K-01, K-02, K-09:
// the master's sample cast, the 555-01xx range; rule 9).

import { copy, gateRequest, modelFixture } from "../../gate/framework/test-support";
import type {
  Choice,
  DecidePart,
  DecideResult,
  Decided,
  GatedVerbPart,
  SetupKey,
} from "../../gate/framework";
import { contractFile, fixture } from "../../tool-api/test-support";
import { choiceOf } from "../hold";
import type {
  CommitTurnContext,
  GateAndCommitRequest,
  OpenHolds,
  OpenQuestionNew,
  OutboxRowNew,
  PassedPart,
  SafetyHold,
  StateWrite,
  TurnRow,
} from "../types";
import type { BundleIdOf, FlowLetter, WalkBundles } from "./index";

/** The turn key commit-s1-01.json's ids are built from (K-09 v1.5 default 131: the handle's sample name). */
export const SAM = "sam";

/** Nothing open on the handle: no hold, every text read. */
export const NOTHING_OPEN: OpenHolds = { holds: [], unreadEventIds: [] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------------
// Bundle v0 (K-01 v1 bundle-v0-skeleton.json: S1-01 and S1-02 of flow A)

interface Skeleton {
  manifest: { bundleId: { hash: string; build: number } };
  flows: Partial<Record<FlowLetter, Record<string, unknown>>>;
}

/** K-01 v1's bundle-v0-skeleton.json, freshly parsed (a test may change its copy). */
export function skeleton(): Skeleton {
  return contractFile("bundle/fixtures/bundle-v0-skeleton.json") as Skeleton;
}

/** Bundle v0's flow A graph, freshly parsed: its steps keyed by id, to change in a copy. */
export function flowA(): Record<string, unknown> & { steps: Record<string, Record<string, unknown>> } {
  const graph = skeleton().flows.A;
  if (graph === undefined) throw new Error("bundle v0 holds flow A");
  return graph as Record<string, unknown> & { steps: Record<string, Record<string, unknown>> };
}

/** A graph's step by id, as parsed, to change in a test's copy. */
export function stepIn(
  graph: { steps: Record<string, Record<string, unknown>> },
  id: string,
): Record<string, unknown> {
  const step = graph.steps[id];
  if (step === undefined) throw new Error(`the graph holds ${id}`);
  return step;
}

/** A split's branch by label, as parsed, to change in a test's copy. */
export function branchIn(
  graph: { steps: Record<string, Record<string, unknown>> },
  id: string,
  label: string,
): Record<string, unknown> {
  const { branches } = stepIn(graph, id);
  const listed: unknown[] = Array.isArray(branches) ? branches : [];
  const found = listed.find((branch) => isRecord(branch) && branch.label === label);
  if (!isRecord(found)) throw new Error(`${id} has the branch`);
  return found;
}

/** One read of the bundles port: the bundle and the flow asked for. */
export interface FlowRead {
  readonly bundleId: BundleIdOf;
  readonly flow: FlowLetter;
}

export interface SkeletonBundles {
  readonly bundles: WalkBundles;
  /** Every read, in order. */
  readonly reads: FlowRead[];
}

/**
 * The bundles port over bundle v0: the flow graph asked for when the bundle id is bundle v0's (or `graphs`' own, given
 * in its place), else null. Each read hands over a fresh copy and is written down.
 */
export function skeletonBundles(
  graphs: Partial<Record<FlowLetter, unknown>> = { A: flowA() },
): SkeletonBundles {
  const pin = skeleton().manifest.bundleId;
  const reads: FlowRead[] = [];
  return {
    reads,
    bundles: {
      flow(bundleId, flow) {
        reads.push({ bundleId: copy(bundleId), flow });
        const same = bundleId.hash === pin.hash && bundleId.build === pin.build;
        return Promise.resolve(same ? copy(graphs[flow] ?? null) : null);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Turn 1: K-09 v1.5 commit-s1-01.json

export const COMMIT_S1_01 = "commit-s1-01.json";

/** The rows a fixture states its part writes (K-09 v1.5 statedWrites; default 136). */
export interface StatedWrites {
  state: StateWrite[];
  openQuestions: OpenQuestionNew[];
  outboxRows: OutboxRowNew[];
}

/** commit-s1-01.json as the walk's tests read it: its request, what it states and its outcome. */
export interface CommitS1_01 {
  given: { stated: { step: string; gives: SetupKey[]; writes: StatedWrites } };
  /**
   * K-09 v1.5's request: its turn carries `service` and `chatId` and its door is K-02 v1.1's signUp, which K-09 v1's
   * generated type (CommitTurnContext.request until T-1150) does not name; the walk reads both at run time.
   */
  request: GateAndCommitRequest;
  outcome: {
    parts: { gives: SetupKey[] }[];
    written: {
      written: { table: string; rowId: string; version: number }[];
      outboxRows: { id: string; commitSeq: number }[];
    };
  };
}

/** commit-s1-01.json, freshly parsed. */
export function commitS1_01(): CommitS1_01 {
  return fixture(COMMIT_S1_01) as CommitS1_01;
}

/** The request's turn as a plain record, with the service and chat id K-06's event gave it (default 135). */
export function requestTurnFields(request: GateAndCommitRequest): Record<string, unknown> {
  const turn: unknown = request.turn;
  if (!isRecord(turn)) throw new Error("the request carries its turn");
  return turn;
}

/** A part whose verb the limits gate (gate.ts default 2), as the commit hands it to writesOf. */
function gatedPart(part: DecidePart): GatedVerbPart {
  if (
    part.verb === "choose" ||
    part.verb === "enter" ||
    part.verb === "pass_on" ||
    part.verb === "hand_off"
  ) {
    return part;
  }
  throw new Error("not a gated verb");
}

/** The decided pair a request carries. */
export function decidedOf(request: GateAndCommitRequest): Decided {
  if (request.input.kind !== "decided") throw new Error("the request carries decided texts");
  return request.input.decided;
}

/** The passed part at `index`, as the commit's passedPart builds it: its part and the offered choice it names. */
export function passedPartOf(request: GateAndCommitRequest, index = 0): PassedPart {
  const decided = decidedOf(request);
  const entry = decided.decide.parts[index];
  if (entry === undefined) throw new Error(`no part ${String(index)}`);
  const part = gatedPart(entry.part);
  return { index, part, choice: choiceOf(decided, part) };
}

/**
 * The turn row the commit writes for a request (K-05 v1 turn's seven fields alone: K-09 v1.5 default 135, as T-1150
 * makes the commit write it), never the request turn's service and chat id.
 */
export function turnRowOf(request: GateAndCommitRequest): TurnRow {
  const { turn } = request;
  if (turn === null) throw new Error("the request carries its turn");
  const { id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries } = turn;
  return copy({ id, handleId, eventIds, bundleId, traceId, joinedTraceIds, tries });
}

/** The repo the walk's tests hand it: the walk reads nothing through it. */
export interface WalkTestRepo {
  readonly name: "walk-test-repo";
}

/** The commit's context for a request, inside its caller's business scope, as gateAndCommitOnce builds it. */
export function contextOf(request: GateAndCommitRequest): CommitTurnContext<WalkTestRepo> {
  const businessId = request.caller.businessId;
  if (businessId === null) throw new Error("the request names its business");
  return { request, turn: turnRowOf(request), repo: { name: "walk-test-repo" }, businessId };
}

/** Turn 1 as the commit hands it to writesOf: commit-s1-01.json's one part (enter c-01, the sign-up door). */
export function turnOne(): {
  exchange: CommitS1_01;
  part: PassedPart;
  context: CommitTurnContext<WalkTestRepo>;
} {
  const exchange = commitS1_01();
  return { exchange, part: passedPartOf(exchange.request), context: contextOf(exchange.request) };
}

// ---------------------------------------------------------------------------------------------------------------
// Turn 2's S1-02 options (K-02 v1's context-s1-02.json; the same bundle v0)

/**
 * A turn on K-02's context-s1-02.json (Sam's answer to S1-02, pinned to bundle v0) whose one part chooses `choiceId`:
 * decide-s1-02-choose.json's part with its choice set to it. Its turn carries no service or chat id (K-09 v1).
 */
export function turnTwo(choiceId: string): {
  part: PassedPart;
  context: CommitTurnContext<WalkTestRepo>;
  choice: Choice;
} {
  const decided: Decided = {
    context: modelFixture("context-s1-02.json") as Decided["context"],
    decide: modelFixture("decide-s1-02-choose.json") as DecideResult,
  };
  const [entry] = decided.decide.parts;
  if (entry.part.verb !== "choose") throw new Error("decide-s1-02-choose.json chooses");
  entry.part.choice = choiceId;
  const request = gateRequest(decided);
  const part = passedPartOf(request);
  if (part.choice === null) throw new Error(`context-s1-02.json offers ${choiceId}`);
  return { part, context: contextOf(request), choice: part.choice };
}

// ---------------------------------------------------------------------------------------------------------------
// Holds (K-09 v1 safety-outcome-hold.json)

/** The threat's hold safety-outcome-hold.json opens (release rule never), with another release rule when given. */
export function hold(releaseRule?: SafetyHold["releaseRule"]): SafetyHold {
  const { outcome } = fixture("safety-outcome-hold.json") as { outcome: { hold: SafetyHold } };
  return releaseRule === undefined ? outcome.hold : { ...outcome.hold, releaseRule };
}
