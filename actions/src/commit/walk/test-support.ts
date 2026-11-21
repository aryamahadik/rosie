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
// T-1519 adds the chat read's double (K-05 v1.10 item 51 readChatHandle as the walk's WalkChats port takes it: the handle
// whose chat thread holds a chat id), each read written down; it never stands in for the walk.

import { readFileSync } from "node:fs";
import path from "node:path";

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
