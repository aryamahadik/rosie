// Fixtures and doubles for the walk's tests (T-1139). Never imported by the Worker. The one double is the bundles port,
// which hands the walk K-01 v1's bundle-v0-skeleton.json (the bundle commit-s1-01.json's turn pins) and writes down each
// read; it never stands in for the walk under test. Values come only from the contracts' fixtures (K-01, K-02, K-09:
// the master's sample cast, the 555-01xx range; rule 9).
//
// T-1461 adds the answer's doubles, none of them the walk: the bundles port over bundle v1 (bundles/v1, T-1460: the
// master's flow A steps S1-01, S1-02, S1-11, S1-04, S1-03 and S1-74), the question read over K-05 v1.2 openQuestionRead
// rows (db/repo/targets.ts's type, so the rows card F binds fit the walk's port as they are), and stand-ins for the step
// writers (T-633's and T-634's), each call written down. Their values come from K-09's commit-s1-01.json,
// commit-s1-02.json, commit-s1-02-unmapped-end.json and match-kinds.json.
//
// T-1491 adds the one-kind path's test graph (bundle v1's flow A with S1-08 and S1-09 in K-01 v1's shape, from the
// master's lines, since no bundle holds them until bundle v2), S1-08's writer's stand-in, and the stand-in rows of S1-04's
// one-kind settler (T-1492's), from K-09's commit-s1-04.json.
//
// T-1519 adds the chat read's double (K-05 v1.10 item 51 readChatHandle as the walk's WalkChats port takes it: the handle
// whose chat thread holds a chat id), each read written down; it never stands in for the walk.
//
// T-1479 adds K-05 v1.22's own schema (the walk's rows name their step and line: outboxRowNew, writes and
// commitTurn.request as v1.22 restates them), bundle v2's compiled S1-08 and S1-09 (bundles/v2, T-1477) placed in
// T-1491's test graph, and a stand-in writer that hands back rows as given, to show how the walk names their step and
// line.
//
// T-1480 adds the answered buttons step's doubles (K-09 README default 181): the bundles port over bundle v2 itself,
// K-09's commit-s1-04.json (the roster owner answers S1-04's question "All share one") pinned to bundle v2, S1-04's
// question as K-05 v1.2 openQuestionRead reads its row, and a stand-in for S1-04's writer (T-1481's) that hands back the
// fixture's stated state rows. None of them is the walk.
//
// T-1532 adds the wait at S1-10's doubles (K-09 README default 209): the bundles port over bundle v3 itself (bundles/v3,
// T-1526), a turn answering S1-09 pinned to it, S1-09's question as K-05 v1.2 openQuestionRead reads its row, and
// stand-ins for S1-09's writer (T-635a's) and S1-10's (S10-3's, not built), the latter giving mobile alone. None of them
// is the walk.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { OpenQuestionRead } from "../../../../db/repo/targets";
import { copy, gateRequest, modelFixture } from "../../gate/framework/test-support";
import type {
  Choice,
  DecidePart,
  DecideResult,
  Decided,
  GatedVerbPart,
  SetupKey,
} from "../../gate/framework";
import { formatProblems } from "../../tool-api";
import { contractFile, fixture } from "../../tool-api/test-support";
import { CONTRACTS_DIR } from "../../tool-api/validator";
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
import type {
  BundleIdOf,
  FlowLetter,
  StepRows,
  StepWriter,
  StepWriterCall,
  StepWriters,
  WalkBundles,
  WalkChats,
  WalkQuestions,
} from "./index";

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
  return pinnedBundles(skeleton().manifest.bundleId, graphs);
}

/** The bundles port over one bundle: `graphs`' flow graph for the bundle id `pin`, else null; each read written down. */
function pinnedBundles(pin: BundleIdOf, graphs: Partial<Record<FlowLetter, unknown>>): SkeletonBundles {
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

// ---------------------------------------------------------------------------------------------------------------
// Bundle v1 (T-1460: bundles/v1, flow A's S1-01, S1-02, S1-11, S1-04, S1-03 and S1-74, with every trade's overlay)

/** A flow graph as parsed: its steps keyed by id, to change in a test's copy. */
export type GraphValue = Record<string, unknown> & { steps: Record<string, Record<string, unknown>> };

/** bundles/v1/bundle/: bundle v1's parts as T-1460 built them. */
const BUNDLE_V1 = path.join(CONTRACTS_DIR, "..", "bundles", "v1", "bundle");

/** One of bundle v1's parts, freshly parsed. */
function bundleV1Part(file: string): unknown {
  return JSON.parse(readFileSync(path.join(BUNDLE_V1, ...file.split("/")), "utf8")) as unknown;
}

/** Bundle v1's id, as its manifest names it (K-01 v1 manifest.bundleId). */
export function bundleV1Id(): BundleIdOf {
  const { bundleId } = bundleV1Part("manifest.json") as { bundleId: BundleIdOf };
  return { hash: bundleId.hash, build: bundleId.build };
}

/** Bundle v1's flow A graph, freshly parsed: the master's steps, with no trade's overlay applied. */
export function flowAV1(): GraphValue {
  return bundleV1Part("flow/A.json") as GraphValue;
}

/** One trade's overlay in bundle v1 (K-01 v1's trade part), freshly parsed. */
export function tradeOverlayV1(trade: string): unknown {
  return bundleV1Part(`trade/${trade}.json`);
}

/** The bundles port over bundle v1: its flow graph for bundle v1's id (or `graphs`' own, given in its place), else null. */
export function bundleV1Bundles(
  graphs: Partial<Record<FlowLetter, unknown>> = { A: flowAV1() },
): SkeletonBundles {
  return pinnedBundles(bundleV1Id(), graphs);
}

// ---------------------------------------------------------------------------------------------------------------
// Turn 2: K-09 commit-s1-02.json, Sam's answer to S1-02's question, on bundle v1

export const COMMIT_S1_02 = "commit-s1-02.json";

/** commit-s1-02.json as the answer's tests read it: what it states, its request and its outcome. */
export interface CommitS1_02 {
  given: { after: string[]; stated: { step: string; gives: SetupKey[] } };
  request: GateAndCommitRequest;
  outcome: {
    parts: { choiceId: string; gives: SetupKey[] }[];
    written: {
      written: { table: string; rowId: string; version: number }[];
      outboxRows: { id: string; commitSeq: number }[];
    };
    openQuestions: { opened: string[]; closed: string[] };
  };
}

/** commit-s1-02.json, freshly parsed. */
export function commitS1_02(): CommitS1_02 {
  return fixture(COMMIT_S1_02) as CommitS1_02;
}

/**
 * Turn 2 as the commit hands it to writesOf on bundle v1: commit-s1-02.json's request (K-09 v1's, whose turn carries
 * no service or chat id), its turn given the service and chat id the same turn carries in
 * commit-s1-02-unmapped-end.json (K-09 v1.8; default 135), pinned to bundle v1 (the turn's, the context's and decide's
 * bundle: v1 holds S1-01 and S1-02 as v0 does, DL-961 ruling 1), its one part choosing `choiceId`: c-01 "All on the
 * list" (the fixture's own), c-02 "One isn't on the list yet" or c-03 "Not a service we book".
 */
export function turnTwoOnV1(choiceId = "c-01"): {
  exchange: CommitS1_02;
  part: PassedPart;
  context: CommitTurnContext<WalkTestRepo>;
  choice: Choice;
} {
  const exchange = commitS1_02();
  const { request } = exchange;
  const same = fixture("commit-s1-02-unmapped-end.json") as { request: GateAndCommitRequest };
  const given = requestTurnFields(same.request);
  const turn = requestTurnFields(request);
  turn.service = given.service;
  turn.chatId = given.chatId;
  const pin = bundleV1Id();
  turn.bundleId = { ...pin };
  const decided = decidedOf(request);
  decided.context.bundleId = { ...pin };
  decided.decide.bundleId = { ...pin };
  const [entry] = decided.decide.parts;
  if (entry.part.verb !== "choose") throw new Error("commit-s1-02.json's part chooses");
  entry.part.choice = choiceId;
  const part = passedPartOf(request);
  if (part.choice === null) throw new Error(`commit-s1-02.json offers ${choiceId}`);
  return { exchange, part, context: contextOf(request), choice: part.choice };
}

// ---------------------------------------------------------------------------------------------------------------
// The question read (K-05 v1.2 openQuestionRead, as db/repo/targets.ts reads it)

/**
 * S1-02's open question as K-05 v1.2 openQuestionRead reads its row on turn 2: the id, business and send commit-s1-02.json's
 * context names (oq-s1-02, Lee's Barbershop, asked once at 14:02, as text), what commit-s1-01.json's commit opened it
 * with (Sam's, at S1-02, no options, no read-back, no versions read, step 9's default clock) in turn 1 under its bundle,
 * open at version 2: K-04's first version, raised once by armClock at its first delivery receipt (db/repo/clocks.ts
 * default 2 and line 610).
 */
export function s1_02QuestionRow(): OpenQuestionRead {
  const first = commitS1_01();
  const [opened] = first.given.stated.writes.openQuestions;
  if (opened === undefined) throw new Error("commit-s1-01.json opens S1-02's question");
  const { openQuestions } = decidedOf(commitS1_02().request).context;
  const [asked] = openQuestions;
  if (asked === undefined) throw new Error("commit-s1-02.json's context names S1-02's question");
  const { turn } = first.request;
  if (turn === null) throw new Error("commit-s1-01.json carries its turn");
  return {
    id: asked.openQuestionId,
    businessId: asked.target.businessId,
    bookingId: asked.target.bookingId,
    personId: opened.personId,
    turnId: turn.id,
    step: asked.step,
    status: "open",
    options: [...opened.options],
    readback: opened.readback,
    versionsRead: [...opened.versionsRead],
    clock: opened.clock,
    sentAt: asked.sentAt.utc,
    pollId: asked.pollId,
    askCount: asked.askCount,
    bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
    version: 2,
  };
}

/** One read the question read was asked for. */
export interface QuestionReadCall {
  readonly repo: WalkTestRepo;
  readonly handleId: string;
  readonly openQuestionId: string;
}

export interface FakeQuestions {
  readonly questions: WalkQuestions<WalkTestRepo>;
  /** Every read, in order. */
  readonly reads: QuestionReadCall[];
}

/**
 * The question read over K-05 v1.2 openQuestionRead rows (db/repo/targets.ts's type, as card F binds its read): the row
 * of that id when it was sent to `sentTo`, else null. Each read is written down, and each row handed over as a copy.
 */
export function questionsOver(
  rows: readonly OpenQuestionRead[] = [s1_02QuestionRow()],
  sentTo = "handle-sam",
): FakeQuestions {
  const reads: QuestionReadCall[] = [];
  return {
    reads,
    questions: {
      liveQuestion(repo, handleId, openQuestionId) {
        reads.push({ repo, handleId, openQuestionId });
        const found = handleId === sentTo ? rows.find((row) => row.id === openQuestionId) : undefined;
        return Promise.resolve(found === undefined ? null : copy(found));
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The chat read (T-1519: K-05 v1.10 item 51 readChatHandle, the phone handle whose chat thread holds a Linq chat id)

export interface FakeChats {
  readonly chats: WalkChats;
  /** Every chat id the read was asked for, in order. */
  readonly reads: string[];
}

/**
 * The chat read over one stored chat thread: `holder`, the handle whose chat thread holds the chat id `chatId`, answered
 * for that chat id alone, and null for any other (no thread holds it), or for every chat id when `holder` is null. Each
 * read is written down. Its values are commit-s1-01.json's (handle-sam, linq-chat-demo-sam) or the master's sample cast.
 */
export function chatsOver(holder: string | null, chatId = "linq-chat-demo-sam"): FakeChats {
  const reads: string[] = [];
  return {
    reads,
    chats: {
      chatHandle(linqChatId) {
        reads.push(linqChatId);
        return Promise.resolve(linqChatId === chatId ? holder : null);
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins for the step writers (S1-02, S1-03, S1-74: T-633's; S1-11 and S1-04: T-634's)

/** One call a stand-in step writer was given, as a test reads it. */
export interface WriterCall {
  readonly stepId: string;
  readonly repo: WalkTestRepo;
  readonly part: number;
  readonly choiceId: string;
  readonly writerLane: string | null;
}

export interface FakeWriters {
  readonly writers: StepWriters<WalkTestRepo>;
  /** Every call, in order. */
  readonly calls: WriterCall[];
}

/** The step writers `bound` by step id, each call written down before it runs; any other step has none. */
export function writersOf(bound: Readonly<Record<string, StepWriter<WalkTestRepo>>>): FakeWriters {
  const calls: WriterCall[] = [];
  const byStep = new Map(Object.entries(bound));
  return {
    calls,
    writers: (stepId) => {
      const writer = byStep.get(stepId);
      if (writer === undefined) return null;
      return (call: StepWriterCall<WalkTestRepo>) => {
        calls.push({
          stepId: call.step.id,
          repo: call.repo,
          part: call.part.index,
          choiceId: call.choice.choiceId,
          writerLane: call.writer.writerLane,
        });
        return writer(call);
      };
    },
  };
}

/** match-kinds.json's outcome: the matcher's kinds for Sam's words, part by part. */
interface MatchKinds {
  outcome: { parts: { words: string; outcome: string; kinds: { kindId: string; name: string }[] }[] };
}

/**
 * A stand-in for S1-02's writer (T-633's, which runs the matcher over the kinds catalog on the call's transaction): the
 * kinds match-kinds.json's matcher gives Sam's words, one K-24 picked_kinds insert each in their order, not placed yet
 * (business_id null until S1-04: K-24 README), giving kinds. It reads nothing.
 */
export const s1_02Writer: StepWriter<WalkTestRepo> = (call) => {
  const { outcome } = fixture("match-kinds.json") as MatchKinds;
  const { request } = call.writer.turn;
  const state = outcome.parts.map((each, index): StateWrite => ({
    op: "insert",
    table: "picked_kinds",
    values: {
      id: call.writer.rowId("pick"),
      owner_person_id: request.caller.personId,
      position: index + 1,
      words: each.words,
      outcome: each.outcome,
      kind_id: each.kinds[0]?.kindId ?? null,
      business_id: null,
      picked_at: request.now,
    },
  }));
  const rows: StepRows = { state, stateEvents: [], gives: ["kinds"], asks: [], messages: [] };
  return Promise.resolve(rows);
};

/**
 * A stand-in for S1-11's writer (T-634's, which loads each picked kind's plug-in blocks): it gives S1-11's eleven pf
 * keys, as commit-s1-02.json states them beside S1-02's kinds, and writes no row. It reads nothing.
 */
export const s1_11Writer: StepWriter<WalkTestRepo> = () => {
  const gives = commitS1_02().given.stated.gives.filter((key) => key !== "kinds");
  const rows: StepRows = { state: [], stateEvents: [], gives, asks: [], messages: [] };
  return Promise.resolve(rows);
};

/**
 * A stand-in for the writer of a step that tells the turn's writer (S1-03's and S1-74's: T-633's): one quick reply to the
 * turn's own handle and person on the turn's service, about the call's business, with no plan and no question.
 */
export const tellingWriter: StepWriter<WalkTestRepo> = (call) => {
  const { turn } = call.writer;
  const { target } = call.choice;
  const message: OutboxRowNew = {
    id: call.writer.rowId("outbox"),
    recipientHandleId: turn.turn.handleId,
    recipientPersonId: turn.request.caller.personId,
    businessId: target.businessId,
    bookingId: target.bookingId,
    channel: call.writer.text().service,
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
  };
  const rows: StepRows = { state: [], stateEvents: [], gives: [], asks: [], messages: [message] };
  return Promise.resolve(rows);
};

/** The stand-ins by step id: S1-02's and S1-11's, and S1-03's and S1-74's messages (S1-04's question is the walk's). */
export function allWriters(): Record<string, StepWriter<WalkTestRepo>> {
  return { "S1-02": s1_02Writer, "S1-11": s1_11Writer, "S1-03": tellingWriter, "S1-74": tellingWriter };
}

// ---------------------------------------------------------------------------------------------------------------
// T-1491: the one-kind path's test graph (K-09 README default 199), bundle v1's flow A with S1-08 and S1-09

/** S1-09's safe default (MASTER-FLOW-A.md line 124), as its card states it in T-1491's test graph. */
export const S1_09_SAFE_DEFAULT = "not yet an owner. Setup goes on, saved, and nothing goes live.";

/** S1-09's three branches, by the master's Means lines (MASTER-FLOW-A.md lines 118 to 120). */
export const S1_09_BRANCHES = [
  "An owner; the listing matches",
  "Helps run it; not an owner",
  "No match, or already listed",
];

/**
 * T-1491's test graph: bundle v1's flow A (S1-04 a plain step whose message carries three buttons, next S1-08), with the
 * two steps no bundle holds until bundle v2 (T-1477) added in K-01 v1's shape, the fields the walk reads alone:
 *   - S1-08 (MASTER-FLOW-A.md lines 101 to 111): Rosie lays out the plan to the owner by text, a message with no
 *     question and no buttons; it needs companies and pf.rules, gives nothing and tells the owner; next S1-09;
 *   - S1-09 (lines 112 to 129): a split Rosie asks the owner by text, its three message branches merging, with a card of
 *     step 9's default clock and its safe default; it needs companies and gives business; next S1-10, which it does not
 *     hold. Its message carries no buttons here, as before T-1479; flowAWithCompiledPlan places bundle v2's compiled
 *     S1-09, whose message carries two buttons (writes.ts default 10).
 */
export function flowAWithPlan(): GraphValue {
  const graph = flowAV1();
  graph.steps["S1-08"] = {
    id: "S1-08",
    section: 1,
    who: "san",
    to: "owner",
    via: "msg",
    title: "Lays out the plan",
    say: [{ from: "san", to: "owner" }],
    needs: ["companies", "pf.rules"],
    gives: [],
    tells: ["owner"],
    next: "S1-09",
  };
  graph.steps["S1-09"] = {
    id: "S1-09",
    section: 1,
    who: "san",
    to: "owner",
    via: "msg",
    title: "Reads the card or listing; asks: an owner?",
    say: [{ from: "san", to: "owner" }],
    needs: ["companies"],
    gives: ["business"],
    tells: ["owner"],
    type: "split",
    branches: S1_09_BRANCHES.map((label) => ({
      label,
      tag: "message",
      steps: [],
      rejoinAt: null,
      effects: [],
      end: "merge",
    })),
    card: { clock: { from: "step9Default" }, safeDefault: S1_09_SAFE_DEFAULT },
    next: "S1-10",
  };
  return graph;
}

/** The stand-ins by step id on T-1491's test graph: allWriters' and S1-08's message (T-1482's writer's stand-in). */
export function planWriters(): Record<string, StepWriter<WalkTestRepo>> {
  return { ...allWriters(), "S1-08": tellingWriter };
}

/** commit-s1-04.json as T-1491's stand-in settler reads it: the rows it states S1-04's answer writes. */
interface CommitS1_04 {
  given: { stated: { writes: { state: StateWrite[] } } };
}

/**
 * A stand-in for the rows S1-04's one-kind settler answers (T-1492's): commit-s1-04.json's first stated state row, the
 * plumber company kind under the roster owner's company (K-23 company_kinds, inserted), giving companies. It reads
 * nothing, and is never the walk under test.
 */
export function s1_04SettledRows(): StepRows {
  const { given } = fixture("commit-s1-04.json") as CommitS1_04;
  const [first] = given.stated.writes.state;
  if (first === undefined) throw new Error("commit-s1-04.json states its rows");
  return { state: [first], stateEvents: [], gives: ["companies"], asks: [], messages: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// T-1479: K-05 v1.22 (a row's step and line), bundle v2's compiled S1-08 and S1-09, and a writer of given rows

const DATA_ACCESS_V1_22_FILE = "data-access/data-access.v1.22.schema.json";
const DATA_ACCESS_V1_22 = `https://rosie.invalid/contracts/${DATA_ACCESS_V1_22_FILE}`;

/** Every file a schema's $refs name, relative to contracts/ (a $ref inside the schema itself names none). */
function referencedFiles(file: string, schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item) => referencedFiles(file, item));
  if (!isRecord(schema)) return [];
  return Object.entries(schema).flatMap(([key, inner]) => {
    if (key !== "$ref" || typeof inner !== "string") return referencedFiles(file, inner);
    const target = inner.split("#")[0] ?? "";
    return target === "" ? [] : [path.posix.join(path.posix.dirname(file), target)];
  });
}

let v1dot22: ((definition: string, value: unknown) => string[]) | undefined;

/**
 * Problems K-05 v1.22 `$defs/<definition>` finds, one line each (a path and what it wants, never a value), on one strict
 * Ajv 2020 instance holding data-access.v1.22.schema.json and every file its $refs reach (K-05 v1 to v1.21 among them),
 * each once: outboxRowNew with its optional step and lineNo (both or neither), writes, commitTurn.request and
 * commitTurn.rowLineExchange (README item 82).
 */
export function k05v122(definition: string, value: unknown): string[] {
  if (v1dot22 === undefined) {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    const held = new Set<string>();
    const queue = [DATA_ACCESS_V1_22_FILE];
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (held.has(file)) continue;
      const schema = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, ...file.split("/")), "utf8")) as object;
      ajv.addSchema(schema);
      held.add(file);
      queue.push(...referencedFiles(file, schema));
    }
    v1dot22 = (name, checked) => {
      const validate: ValidateFunction | undefined = ajv.getSchema(`${DATA_ACCESS_V1_22}#/$defs/${name}`);
      if (validate === undefined) throw new Error(`no definition ${name}`);
      return validate(checked) ? [] : formatProblems(validate.errors);
    };
  }
  return v1dot22(definition, value);
}

/** One of bundle v2's parts (bundles/v2/bundle/, T-1477), freshly parsed. */
function bundleV2Part(file: string): unknown {
  const root = path.join(CONTRACTS_DIR, "..", "bundles", "v2", "bundle");
  return JSON.parse(readFileSync(path.join(root, ...file.split("/")), "utf8")) as unknown;
}

/** Bundle v2's flow A graph, freshly parsed: the master's steps S1-01 to S1-09 as T-1477 compiled them. */
export function flowAV2(): GraphValue {
  return bundleV2Part("flow/A.json") as GraphValue;
}

/**
 * T-1491's test graph with bundle v2's compiled S1-08 and S1-09 in place of its own (a double of S1-09's compiled shape,
 * under bundle v1's pin): S1-09 a split whose message carries two buttons ("Yes, an owner", "No, I help run it"), its
 * card's Clock step 9's default and its safe default MASTER-FLOW-A.md line 124's, as in flowAWithPlan.
 */
export function flowAWithCompiledPlan(): GraphValue {
  const graph = flowAWithPlan();
  const compiled = flowAV2();
  for (const id of ["S1-08", "S1-09"]) graph.steps[id] = stepIn(compiled, id);
  return graph;
}

/**
 * A stand-in writer that hands back `messages` (and nothing else) as given, each a copy, to show how the walk names a
 * writer's rows' step and line. It reads nothing.
 */
export function rowsWriter(messages: readonly OutboxRowNew[]): StepWriter<WalkTestRepo> {
  return () =>
    Promise.resolve({ state: [], stateEvents: [], gives: [], asks: [], messages: copy([...messages]) });
}

// ---------------------------------------------------------------------------------------------------------------
// T-1480: an answered buttons step (K-09 README default 181), commit-s1-04.json on bundle v2

export const COMMIT_S1_04 = "commit-s1-04.json";

/** The turn key commit-s1-04.json's ids are built from (K-09 v1.5 default 131: the fixture's stand-in, roster). */
export const ROSTER = "roster";

/** The handle commit-s1-04.json's turn and S1-04's question name (a fictional one: the fixture's note). */
export const ROSTER_HANDLE = "handle-roster-owner-1";

/** commit-s1-04.json as the answered buttons step's tests read it: what it states, its request and its outcome. */
export interface CommitS1_04Exchange {
  given: { stated: { step: string; gives: SetupKey[]; writes: StatedWrites } };
  request: GateAndCommitRequest;
  outcome: {
    parts: { choiceId: string; gives: SetupKey[] }[];
    written: {
      written: { table: string; rowId: string; version: number }[];
      outboxRows: { id: string; commitSeq: number }[];
    };
    openQuestions: { opened: string[]; closed: string[] };
  };
}

/** commit-s1-04.json, freshly parsed. */
export function commitS1_04(): CommitS1_04Exchange {
  return fixture(COMMIT_S1_04) as CommitS1_04Exchange;
}

/** Bundle v2's id, as its manifest names it (K-01 v1 manifest.bundleId). */
export function bundleV2Id(): BundleIdOf {
  const { bundleId } = bundleV2Part("manifest.json") as { bundleId: BundleIdOf };
  return { hash: bundleId.hash, build: bundleId.build };
}

/** The bundles port over bundle v2: its flow graph for bundle v2's id (or `graphs`' own, given in its place), else null. */
export function bundleV2Bundles(
  graphs: Partial<Record<FlowLetter, unknown>> = { A: flowAV2() },
): SkeletonBundles {
  return pinnedBundles(bundleV2Id(), graphs);
}

/**
 * The turn that answers S1-04 as the commit hands it to writesOf on bundle v2: commit-s1-04.json's request (the roster
 * owner's "They all share one company"), pinned to bundle v2 (the turn's, the context's and decide's bundle: v2 keeps
 * S1-04's buttons byte for byte from v1, K-09 README default 188, and holds S1-08 and S1-09), its one part choosing
 * `choiceId`: c-01 "Some share one", c-02 "All share one" (the fixture's own) or c-03 "Each is its own".
 */
export function turnS1_04OnV2(choiceId = "c-02"): {
  exchange: CommitS1_04Exchange;
  part: PassedPart;
  context: CommitTurnContext<WalkTestRepo>;
  choice: Choice;
} {
  const exchange = commitS1_04();
  const { request } = exchange;
  const pin = bundleV2Id();
  requestTurnFields(request).bundleId = { ...pin };
  const decided = decidedOf(request);
  decided.context.bundleId = { ...pin };
  decided.decide.bundleId = { ...pin };
  const [entry] = decided.decide.parts;
  if (entry.part.verb !== "choose") throw new Error("commit-s1-04.json's part chooses");
  entry.part.choice = choiceId;
  const part = passedPartOf(request);
  if (part.choice === null) throw new Error(`commit-s1-04.json offers ${choiceId}`);
  return { exchange, part, context: contextOf(request), choice: part.choice };
}

/**
 * S1-04's open question as K-05 v1.2 openQuestionRead reads its row on the answering turn: the id, business, step and
 * send commit-s1-04.json's context names (oq-s1-04-roster-1, asked once at 14:05:10, as text), asked of the turn's
 * person as the walk asks a plain step's buttons question (writes.ts default 10: no options, no read-back, no versions
 * read, step 9's default clock), under bundle v2, open at version 1 (the fixture's note). The turn that asked it is a
 * stand-in id: the fixture names none, and the walk reads none.
 */
export function s1_04QuestionRow(): OpenQuestionRead {
  const { request } = commitS1_04();
  const [asked] = decidedOf(request).context.openQuestions;
  if (asked === undefined) throw new Error("commit-s1-04.json's context names S1-04's question");
  return {
    id: asked.openQuestionId,
    businessId: asked.target.businessId,
    bookingId: asked.target.bookingId,
    personId: request.caller.personId,
    turnId: "turn-s1-02-roster",
    step: asked.step,
    status: "open",
    options: [],
    readback: null,
    versionsRead: [],
    clock: null,
    sentAt: asked.sentAt.utc,
    pollId: asked.pollId,
    askCount: asked.askCount,
    bundleId: bundleV2Id(),
    version: 1,
  };
}

/**
 * A stand-in for S1-04's writer (T-1481's, which places the owner's kept picks by the button chosen): commit-s1-04.json's
 * stated state rows for "All share one" (two company kinds, both picks placed, the first pick's eleven text rows given
 * the business), giving companies, with no event-log entry (K-09 README default 182) and no message. It reads nothing.
 */
export const s1_04Writer: StepWriter<WalkTestRepo> = () => {
  const { state } = commitS1_04().given.stated.writes;
  const rows: StepRows = { state, stateEvents: [], gives: ["companies"], asks: [], messages: [] };
  return Promise.resolve(rows);
};

/** The stand-ins by step id for an answered S1-04: S1-04's and S1-08's (T-1482's writer's stand-in: one quick reply). */
export function buttonAnswerWriters(): Record<string, StepWriter<WalkTestRepo>> {
  return { "S1-04": s1_04Writer, "S1-08": tellingWriter };
}

// ---------------------------------------------------------------------------------------------------------------
// T-1532: bundle v3 (bundles/v3, T-1526) and the wait at S1-10 (K-09 README default 209)

/** One of bundle v3's parts (bundles/v3/bundle/, T-1526), freshly parsed. */
function bundleV3Part(file: string): unknown {
  const root = path.join(CONTRACTS_DIR, "..", "bundles", "v3", "bundle");
  return JSON.parse(readFileSync(path.join(root, ...file.split("/")), "utf8")) as unknown;
}

/** Bundle v3's id, as its manifest names it (K-01 v1 manifest.bundleId). */
export function bundleV3Id(): BundleIdOf {
  const { bundleId } = bundleV3Part("manifest.json") as { bundleId: BundleIdOf };
  return { hash: bundleId.hash, build: bundleId.build };
}

/**
 * Bundle v3's flow A graph, freshly parsed: bundle v2's eight steps byte for byte, plus S1-77, S1-76 and S1-10 as
 * T-1526 compiled them (S1-10 a plain message step giving id_checked and mobile, next S1-75, which v3 does not hold).
 */
export function flowAV3(): GraphValue {
  return bundleV3Part("flow/A.json") as GraphValue;
}

/** The bundles port over bundle v3: its flow graph for bundle v3's id (or `graphs`' own, given in its place), else null. */
export function bundleV3Bundles(
  graphs: Partial<Record<FlowLetter, unknown>> = { A: flowAV3() },
): SkeletonBundles {
  return pinnedBundles(bundleV3Id(), graphs);
}

/** S1-09's open question's id on the S1-09 turn (a stand-in id, as T-1528's s1_09Part names it). */
export const S1_09_QUESTION = "oq-s1-09-sam";

/**
 * The turn answering S1-09 as the commit hands it to writesOf on bundle v3: commit-s1-02.json's request (Sam's turn,
 * with the service and chat id of commit-s1-02-unmapped-end.json's same turn: default 135), pinned to bundle v3 (the
 * turn's, the context's and decide's bundle), its one part an option of S1-09's question that names `branch` (one of
 * S1_09_BRANCHES), as T-1528's s1_09Part moves turn 2's option to S1-09. Nothing in it is a person's but the fixture's.
 */
export function turnS1_09OnV3(branch: string): {
  part: PassedPart;
  context: CommitTurnContext<WalkTestRepo>;
  choice: Choice;
} {
  const { request } = commitS1_02();
  const same = fixture("commit-s1-02-unmapped-end.json") as { request: GateAndCommitRequest };
  const given = requestTurnFields(same.request);
  const turn = requestTurnFields(request);
  turn.service = given.service;
  turn.chatId = given.chatId;
  const pin = bundleV3Id();
  turn.bundleId = { ...pin };
  const decided = decidedOf(request);
  decided.context.bundleId = { ...pin };
  decided.decide.bundleId = { ...pin };
  const named = passedPartOf(request);
  if (named.choice === null) throw new Error("commit-s1-02.json's part names an option");
  const choice: Choice = { ...named.choice, step: "S1-09", question: S1_09_QUESTION, branch, label: branch };
  return { part: { ...named, choice }, context: contextOf(request), choice };
}

/**
 * S1-09's open question as K-05 v1.2 openQuestionRead reads its row on the S1-09 turn: S1-02's row (s1_02QuestionRow:
 * Sam's, the business commit-s1-02.json names, no options, as writes.ts default 10 asks S1-09), at S1-09 under bundle
 * v3, open at version 1.
 */
export function s1_09QuestionRow(): OpenQuestionRead {
  return { ...s1_02QuestionRow(), id: S1_09_QUESTION, step: "S1-09", bundleId: bundleV3Id(), version: 1 };
}

/**
 * A stand-in for S1-09's writer (T-635a's, default 204, which reads the typed name and the listing on the call's
 * transaction): it gives business, as S1-09's gives name it, and writes no row. It reads nothing.
 */
export const s1_09Writer: StepWriter<WalkTestRepo> = () => {
  const rows: StepRows = { state: [], stateEvents: [], gives: ["business"], asks: [], messages: [] };
  return Promise.resolve(rows);
};

/**
 * A stand-in for S1-10's writer (S10-3's, README default 210, not built): `mobile` alone, never id_checked, and one quick
 * reply to the turn's own handle and person on the turn's service, about the call's business, naming line 2 (S1-10's
 * secure-link line), with no question and no plan. It writes no accounts or page_links row and reads nothing.
 */
export const s1_10Writer: StepWriter<WalkTestRepo> = (call) => {
  const { turn } = call.writer;
  const { target } = call.choice;
  const message: OutboxRowNew = {
    id: call.writer.rowId("outbox"),
    recipientHandleId: turn.turn.handleId,
    recipientPersonId: turn.request.caller.personId,
    businessId: target.businessId,
    bookingId: target.bookingId,
    channel: call.writer.text().service,
    sendClass: "quick_reply",
    openQuestionId: null,
    copyOfRowId: null,
    versionsRead: [],
    lineNo: 2,
  };
  const rows: StepRows = { state: [], stateEvents: [], gives: ["mobile"], asks: [], messages: [message] };
  return Promise.resolve(rows);
};

/** The stand-ins by step id on bundle v3 past S1-09: S1-09's, S1-76's message (tellingWriter) and S1-10's. S1-77 has none. */
export function waitWriters(): Record<string, StepWriter<WalkTestRepo>> {
  return { "S1-09": s1_09Writer, "S1-76": tellingWriter, "S1-10": s1_10Writer };
}
