// Doubles for the turn loop's tests (T-251). Not imported by the Worker. Each answers as the frozen contracts state:
//
//   - K-09 v1's turn face (`fakeTurnFace`): buildFrontier, closestEntries and gateAndCommit answer what the test gives
//     them, from the fixtures (build-frontier-s1-02.json, closest-entries.json, commit-s1-02.json, the limit fixtures,
//     stop-recorded.json), with the running turn's own ids where a test runs through the real lease (`retarget`);
//   - K-02 v1's decide and re-read (`fakeDecide`): the decide-*.json results, with the model calls a stage reports;
//   - the handle's directory, the safety results (safety-no.json under each text's event id) and a clock of the fixtures'
//     `now` values;
//   - K-05 v1.2 handleTargets for the guard (`targetsAnswer`), so the guard's targets are the fixtures' `targets`;
//   - a leased turn (`testTurn`) whose commit goes to the turn's own commit hook with a CommitContext the test gives, as
//     the lease does (the lease itself is tested in runtime/src/actor; the actor tests here run it for real).
// A double that waits (`hold`) polls a flag rather than waiting on a promise: a promise made inside a Durable Object
// cannot be settled from the test's own context (T-1128's findings). Test values only: the master's sample cast and the
// frozen fixtures' ids; phones in the fictional 555-01xx range (rule 9).

import buildFrontierS102 from "../../../contracts/tool-api/fixtures/build-frontier-s1-02.json";
import textImessage from "../../../contracts/inbound-event/fixtures/text-imessage.json";
import safetyNo from "../../../contracts/model/fixtures/safety-no.json";
import type { CommitAnswer, CommitContext, CommitTurnRequest, InboxEntry, LeasedTurn } from "../actor";
import { manifestOf, type Manifest, type PinnedBundle } from "../bundle";
import { prepareHandoff, type HandleRef, type InboundEvent, type SealingKeyStore } from "../gateway";
import type { HandleTargetsAnswer, Role, TargetRole } from "../guard";
import type { SafetyResult } from "../safety/types";
import { openTrace, type BundleId, type Span } from "../trace";
import type { ModelCall } from "../trace/types";
import { commitThroughToolApi } from "./turn";
import type {
  BuildFrontierAnswer,
  BuildFrontierRequest,
  ClosestEntriesAnswer,
  ClosestEntriesRequest,
  DecideAnswer,
  DecideContext,
  DecideResult,
  GateAndCommitAnswer,
  GateAndCommitRequest,
  RereadRequest,
  TurnDeps,
  TurnParty,
} from "./types";

type Json = Record<string, unknown>;

// ---- waiting -------------------------------------------------------------------------------------------------------

/** Lets the Workers runtime's own steps (WebCrypto, RPC, lent work) run. */
export const flush = (ms = 2): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready` holds, polling; throws, naming `what`, after `limitMs`. */
export async function until(ready: () => boolean, what: string, limitMs = 3000): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > limitMs) throw new Error(`gave up waiting for ${what}`);
    await flush();
  }
}

/** A gate a double waits behind while `closed` is true (polled, so it can be opened from the test's own context). */
export interface Hold {
  closed: boolean;
  wait(): Promise<void>;
}

export function hold(closed = true): Hold {
  const gate: Hold = {
    closed,
    async wait() {
      while (gate.closed) await flush(1);
    },
  };
  return gate;
}

// ---- the fixtures' parties ----------------------------------------------------------------------------------------

const ZONE = "America/New_York";

/** Sam Lee, owner of Lee's Barbershop and Lee Home Services (the fixtures' handle-sam). */
export const SAM = {
  handle: { kind: "phone", address: "+15555550100" } as HandleRef,
  party: {
    handleId: "handle-sam",
    businessId: "biz-lees-barbershop",
    personId: "person-sam",
    zone: ZONE,
  } satisfies TurnParty,
};

/** Ben T., who texts STOP (stop-recorded.json's handle-ben). */
export const BEN = {
  handle: { kind: "phone", address: "+15555550131" } as HandleRef,
  party: {
    handleId: "handle-ben",
    businessId: "biz-lees-barbershop",
    personId: "person-ben",
    zone: ZONE,
  } satisfies TurnParty,
};

/** Alex M., a customer of Lee's Barbershop (the decide fixtures' Alex). */
export const ALEX = {
  handle: { kind: "phone", address: "+15555550101" } as HandleRef,
  party: {
    handleId: "handle-alex",
    businessId: "biz-lees-barbershop",
    personId: "person-alex",
    zone: ZONE,
  } satisfies TurnParty,
};

// ---- the stored texts -----------------------------------------------------------------------------------------------

export interface TextSpec {
  eventId: string;
  body: string;
  sentAt: string;
  traceId: string;
}

/**
 * A text as the actor's inbox keeps it: K-06's text-imessage.json with this event's id, words, send time and trace,
 * scrubbed and sealed by the gateway's own hand-off under the handle's key (the turn opens it with the same key store).
 */
export async function storedText(
  spec: TextSpec,
  handle: HandleRef,
  keys: SealingKeyStore,
  bundleId: BundleId,
  seq: number,
): Promise<InboxEntry> {
  const overrides: Json = {
    eventId: spec.eventId,
    handle,
    body: spec.body,
    sentAt: spec.sentAt,
    traceId: spec.traceId,
  };
  const event = { ...(textImessage as Json), ...overrides } as InboundEvent;
  const prepared = await prepareHandoff({ event, partKey: null, traceId: spec.traceId, bundleId }, keys);
  if (prepared.door !== "actor") throw new Error("not an actor event");
  return {
    seq,
    event: prepared.handoff.event,
    partKey: null,
    traceId: spec.traceId,
    bundleId,
    startsTurn: true,
  };
}

// ---- a leased turn, as the lease hands it ---------------------------------------------------------------------

/** A K-01 bundle's manifest, checked against its id as the pin checks it. */
export async function checkedManifest(whole: { manifest: unknown }, bundleId: BundleId): Promise<Manifest> {
  const manifest = await manifestOf(JSON.stringify(whole.manifest), bundleId);
  if (manifest === null) throw new Error("the sample manifest is not its id's");
  return manifest;
}

export interface TestTurn {
  readonly turn: LeasedTurn;
  /** Every span the turn's trace kept, in order. */
  readonly spans: Span[];
  /** What the commit hook was handed beside each request, as the lease hands it: this object, unchanged. */
  readonly context: CommitContext;
  /** Every commit the turn sent through its lease, with the answer it got, in order. */
  readonly commits: { request: CommitTurnRequest; answer: CommitAnswer }[];
  /** Ends this run as the lease does when a restart replaces it or a lapse reruns it. */
  abort(): void;
}

export interface TestTurnSpec {
  turnId: string;
  traceId: string;
  bundleId: BundleId;
  manifest: Manifest;
  entries: InboxEntry[];
  context?: CommitContext;
}

/**
 * A run of a turn as the lease hands it (LeasedTurn), with the fixture's own ids. Its commit is the lease's, emulated: the
 * turn id must be this turn's, the commit hook (`commitThroughToolApi`) gets the request with this test's CommitContext,
 * and a hook that throws is `noAnswer`.
 */
export function testTurn(spec: TestTurnSpec): TestTurn {
  const spans: Span[] = [];
  let clock = Date.parse("2026-10-19T14:05:01Z");
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: spec.bundleId,
    sink: (span) => spans.push(span),
    now: () => (clock += 7),
  });
  trace.setTurn(spec.turnId);
  const controller = new AbortController();
  const context: CommitContext = spec.context ?? { holds: [], unread: [] };
  const commits: TestTurn["commits"] = [];
  const bundle: PinnedBundle = {
    bundleId: spec.bundleId,
    manifest: spec.manifest,
    flow: () => Promise.reject(new Error("the turn reads no flow here")),
    trade: () => Promise.reject(new Error("the turn reads no trade here")),
    reads: () => [],
  };
  const eventIds = spec.entries.map((entry) => entry.event.eventId);
  const turn: LeasedTurn = {
    turnId: spec.turnId,
    eventIds,
    entries: spec.entries,
    traceId: spec.traceId,
    joinedTraceIds: [],
    tries: 1,
    restart: false,
    leaseUntil: 60_000,
    signal: controller.signal,
    async commit(request) {
      let answer: CommitAnswer;
      if (request.turn.id !== spec.turnId) answer = { error: "wrongTurn" };
      else {
        try {
          answer = await commitThroughToolApi(request, context);
        } catch {
          answer = { error: "noAnswer" };
        }
      }
      commits.push({ request, answer });
      return answer;
    },
    bundleId: spec.bundleId,
    bundle,
    trace,
    holds: context.holds,
  };
  return {
    turn,
    spans,
    context,
    commits,
    abort: () => {
      controller.abort();
    },
  };
}

// ---- K-09 v1's turn face -------------------------------------------------------------------------------------------

export interface GateCall {
  request: GateAndCommitRequest;
  /** The CommitContext the gate was handed: the very object the lease handed the commit hook. */
  at: CommitContext;
}

export interface FakeTurnFace {
  readonly frontierCalls: BuildFrontierRequest[];
  readonly searchCalls: ClosestEntriesRequest[];
  readonly gateCalls: GateCall[];
  /** Each call by name, in the order it was made, then `<name>:answered` once it answered. */
  readonly log: string[];
  frontier: (request: BuildFrontierRequest) => BuildFrontierAnswer;
  search: (request: ClosestEntriesRequest) => ClosestEntriesAnswer;
  /** What each gateAndCommit answers, from the request and the call's place (0 first); null: K-09 is not wired. */
  gate:
    | ((request: GateAndCommitRequest, index: number) => GateAndCommitAnswer | Promise<GateAndCommitAnswer>)
    | null;
  /** While closed, gateAndCommit waits before it answers. */
  gateHold: Hold;
  /** Throw instead of answering (the answer lost on its way) for these gate calls, by place from 0. */
  readonly loseGate: Set<number>;
}

export function fakeTurnFace(): FakeTurnFace {
  const fake: FakeTurnFace = {
    frontierCalls: [],
    searchCalls: [],
    gateCalls: [],
    log: [],
    frontier: () => ({ error: "notFound", table: "handles", rowId: "none" }),
    search: () => ({ error: "indexUnavailable" }),
    gate: null,
    gateHold: hold(false),
    loseGate: new Set(),
  };
  return fake;
}

/** The fake as K-09's turn face (the port the turn calls). */
export function turnFaceOf(fake: FakeTurnFace): TurnDeps["toolApi"] {
  return {
    buildFrontier(request) {
      fake.frontierCalls.push(structuredClone(request));
      fake.log.push("frontier");
      return Promise.resolve(fake.frontier(request));
    },
    closestEntries(request) {
      fake.searchCalls.push(structuredClone(request));
      fake.log.push("search");
      return Promise.resolve(fake.search(request));
    },
    async gateAndCommit(request, at) {
      const index = fake.gateCalls.length;
      fake.gateCalls.push({ request: structuredClone(request), at });
      fake.log.push("gate");
      await fake.gateHold.wait();
      if (fake.loseGate.has(index)) throw new Error("the answer was lost");
      const gate = fake.gate;
      if (gate === null) return { error: "unwired" };
      fake.log.push("gate:answered");
      return gate(request, index);
    },
  };
}

/** Answers each gate call with the next of these answers (the last one again for any later call). */
export function answersInTurn(
  ...answers: unknown[]
): (request: GateAndCommitRequest, index: number) => GateAndCommitAnswer {
  return (_request, index) =>
    structuredClone(answers[Math.min(index, answers.length - 1)]) as GateAndCommitAnswer;
}

// ---- K-02 v1's decide and its re-read ------------------------------------------------------------------------------

const call = (model: "haiku" | "sonnet", purpose: ModelCall["purpose"]): ModelCall => ({
  model: model === "haiku" ? "claude-haiku-5-5" : "claude-sonnet-5-5",
  role: model,
  purpose,
  input_tokens: 2100,
  cached_tokens: 1800,
  cache_write_tokens: 0,
  output_tokens: 60,
  cost_micro_usd: 900,
  ms: 410,
  outcome: "ok",
});

/** The model calls of two Haiku reads, and of the one Sonnet re-read (K-08 v1 model calls; test values). */
export const TWO_READS: readonly ModelCall[] = [call("haiku", "decideFirst"), call("haiku", "decideCheck")];
export const ONE_REREAD: readonly ModelCall[] = [call("sonnet", "reread")];

export interface FakeDecide {
  readonly decideCalls: DecideContext[];
  readonly rereadCalls: RereadRequest[];
  /** What decide answers for a context. */
  decide: (context: DecideContext) => DecideAnswer;
  /** What the re-read answers. */
  reread: (request: RereadRequest) => DecideAnswer;
  /** While closed, decide waits before it answers. */
  decideHold: Hold;
  readonly log: string[];
}

export function fakeDecide(log: string[] = []): FakeDecide {
  return {
    decideCalls: [],
    rereadCalls: [],
    decide: () => ({ error: "modelsDown" }),
    reread: () => ({ error: "modelsDown" }),
    decideHold: hold(false),
    log,
  };
}

export function decideOf(fake: FakeDecide): TurnDeps["ai"] {
  return {
    async decide(context) {
      fake.decideCalls.push(structuredClone(context));
      fake.log.push("decide");
      await fake.decideHold.wait();
      return fake.decide(context);
    },
    reread(request) {
      fake.rereadCalls.push(structuredClone(request));
      fake.log.push("reread");
      return Promise.resolve(fake.reread(request));
    },
  };
}

/** A decide stage's answer: K-02's result (a copy) with its model calls. */
export function decided(result: unknown, modelCalls: readonly ModelCall[] = TWO_READS): DecideAnswer {
  return { result: "decided", decide: structuredClone(result) as DecideResult, modelCalls: [...modelCalls] };
}

// ---- the turn's own facts ---------------------------------------------------------------------------------------

/** The safety read's result for each text: safety-no.json under the text's own event id (what the read on arrival gave). */
export function safetyNoFor(eventId: string): SafetyResult {
  return { ...(structuredClone(safetyNo) as unknown as SafetyResult), eventId };
}

export interface FakeFacts {
  /** What the directory answers for every handle (null: not known). */
  party: TurnParty | null;
  /** Each event's safety result. */
  readonly safety: Map<string, SafetyResult>;
  /** The `now` each K-09 request names, in order (the last one again after). */
  readonly times: string[];
  readonly asked: string[];
}

export function fakeFacts(party: TurnParty | null, times: string[]): FakeFacts {
  return { party, safety: new Map(), times, asked: [] };
}

/** Every port the turn reaches, over these doubles. */
export function turnDeps(
  facts: FakeFacts,
  face: FakeTurnFace,
  ai: FakeDecide,
  keys: SealingKeyStore,
): TurnDeps {
  let next = 0;
  return {
    directory: {
      partyOf: () => Promise.resolve(facts.party),
    },
    keys,
    safety: {
      resultsOf(eventIds) {
        facts.asked.push(...eventIds);
        return Promise.resolve(
          eventIds.flatMap((eventId) => {
            const result = facts.safety.get(eventId);
            return result === undefined ? [] : [structuredClone(result)];
          }),
        );
      },
    },
    toolApi: turnFaceOf(face),
    ai: decideOf(ai),
    now() {
      const at = facts.times[Math.min(next, facts.times.length - 1)] ?? "2026-10-19T14:05:00Z";
      next += 1;
      return at;
    },
  };
}

// ---- K-05 v1.2 handleTargets, for the guard ---------------------------------------------------------------------

/**
 * K-05 v1.2 `handleTargets.response` that gives the guard these K-09 targets: one person with each role, the open
 * questions and bookings by id (a K-05 openQuestionRead and bookingHead carry more, which the guard does not read).
 */
export function targetsAnswer(
  handleId: string,
  targets: {
    roles: { businessId: string; personId: string; role: string }[];
    openQuestionIds: string[];
    bookingIds: string[];
  },
): HandleTargetsAnswer {
  const people = new Map<string, { personId: string; roles: TargetRole[] }>();
  targets.roles.forEach((role, index) => {
    const person = people.get(role.personId) ?? { personId: role.personId, roles: [] };
    person.roles.push({
      roleId: `role-${String(index + 1)}`,
      businessId: role.businessId,
      role: role.role as Role,
      version: 1,
    });
    people.set(role.personId, person);
  });
  return {
    result: "targets",
    handleId,
    readAt: "2026-10-19T14:05:02Z",
    persons: [...people.values()],
    openQuestions: targets.openQuestionIds.map((id) => ({ id })),
    bookings: targets.bookingIds.map((id) => ({ id })),
    phone: { stopped: false, chatOpen: true, version: 2 },
  };
}

/** Sam's targets in build-frontier-s1-02.json: his two owner roles and S1-02's open question. */
export const SAM_S1_02_TARGETS = buildFrontierS102.request.targets;

// ---- the turn's own ids, where a test runs through the real lease ---------------------------------------------

/**
 * A copy of a fixture with its turn id and trace id replaced by the running turn's: the lease hashes the turn id from the
 * event ids (CQ-09) and the trace id is the text's (a UUID), where the fixture writes readable ones.
 */
export function retarget<T>(value: T, ids: { turnId: [string, string]; traceId: [string, string] }): T {
  const text = JSON.stringify(value)
    .replaceAll(JSON.stringify(ids.turnId[0]), JSON.stringify(ids.turnId[1]))
    .replaceAll(JSON.stringify(ids.traceId[0]), JSON.stringify(ids.traceId[1]));
  return JSON.parse(text) as T;
}

// ---- K-02 contexts the fixtures do not give -----------------------------------------------------------------------

/**
 * The context decide-reads-disagree.json's reads were made from (K-02 v1 gives contexts for two of its decide fixtures):
 * A7-17 ("Alex replies?"), Riley out for Alex's Saturday visit, its options word for word as the master writes them, on
 * bundle-mini-a (its bundle id). Its turn and bundle ids are the fixture's.
 */
export function a7_17Context(bundleId: BundleId, prefixSha256: string): Json {
  const target = {
    businessId: "biz-lees-barbershop",
    businessName: "Lee's Barbershop",
    bookingId: "bk-alex-sat",
    visitAt: { utc: "2026-10-24T15:00:00Z", zone: ZONE },
  };
  const option = (
    choiceId: string,
    label: string,
    definition: string,
    stakesFrom: Json[],
    fields: Json[] = [],
  ): Json => ({
    choiceId,
    kind: "option",
    label,
    definition,
    step: "A7-17",
    question: "oq-a7-17",
    branch: label,
    anytimeRow: null,
    door: null,
    hub: null,
    target,
    fields,
    stakes: "high",
    stakesFrom,
  });
  return {
    turnId: "turn-a7-17-alex-either",
    bundleId,
    flow: "A",
    texts: [
      {
        eventId: "evt-alex-0417",
        kind: "text",
        words: "can Avery do it, or I'll just come Saturday at 2",
        sentAt: { utc: "2026-10-23T15:20:00Z", zone: ZONE },
        attachments: [],
        poll: null,
        tapback: null,
      },
    ],
    writer: {
      handle: "+15555550101",
      people: [
        {
          personId: "person-alex",
          name: "Alex",
          roles: [{ role: "customer", businessId: "biz-lees-barbershop" }],
          language: "en",
        },
      ],
    },
    businessLanguage: "en",
    openQuestions: [
      {
        openQuestionId: "oq-a7-17",
        step: "A7-17",
        target,
        sentAt: { utc: "2026-10-23T15:00:00Z", zone: ZONE },
        pollId: null,
        askCount: 1,
      },
    ],
    choices: [
      option("c-01", "1 The stand-in instead", "The stand-in comes in early, and is told.", [
        { why: "calendarWrite", step: "A7-18", ref: null },
      ]),
      option(
        "c-02",
        "2 Another time",
        "Riley's next open times, with no fee and the free cancel kept: the business changed the plan.",
        [{ why: "question", step: null, ref: "c-01" }],
        [{ name: "time", type: "time" }],
      ),
      option("c-03", "3 Cancel, no fee", "Cancelled with no fee. Anything paid comes back.", [
        { why: "refund", step: "A7-20", ref: null },
      ]),
    ],
    cards: [],
    facts: [],
    alwaysOn: { flow: "A", prefixSha256 },
    recentMessages: [],
    meaningSearch: null,
  };
}
