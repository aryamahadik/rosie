// T-560's join, hop 9 of D-017 (C-046; build prompt section 10, D-017: "composer"; 02-contracts section 11, 'The composer
// returns that row's plan': K-09 compose input, K-03 plan; ADR-013 section 6), in the Workers runtime. The composition
// root is composed for the test environment as hop 8's tests compose it (the HandleActor namespace, the skeleton flag on,
// the actor's ports installed, every joined port fed its double), now with the two ports this hop joins: compose input,
// @rosie/actions' turn face's composeInput (T-1141: the Tool API base with K-09 v1.6's checks and the call's business
// scope, T-309's compose input with T-1174's term facts over T-1141's row binding), over a K-05 v1.6 readOutboxRow double
// over the rows the commit wrote and test owner 1's seeded rows (./test-support.ts fakeComposeReads), its inbound text the
// words the turn's gate request handed in, as the gate port's face holds them; and the composer, @rosie/ai's composer
// (T-373's call, T-374's one rewrite, T-375's reader checks) over a fake Messages API answered by the recorded-model
// double (fakeComposerModels: T-1175's recording 4, the JOIN run's S1-02 row, keyed on the runtime's ids, DL-347).
//
//   - The JOIN as recording 2 names it (evt-sam-0000, test owner 1, Sam's chat): hops 1 to 9 once each; one compose span
//     for the turn's one outbox row (S1-02, routine), its plan plan-s1-02.json's shape; the composer was given exactly
//     recording 4's input (no miss), which carries no frontier; its one model call (Haiku, compose) carries bundles/v0's
//     pinned id and the turn id T-248's hash of evt-sam-0000, on the compose span and on its own portCall span (DL-357);
//     compose input read the row once, under Lee's Barbershop's scope; the turn records the row's one fillAndChecks span
//     and the Tool API base records none for compose input (DL-376). No span or log line (console.log, info, warn or
//     error) holds a word, a number or the chat id, even inside a longer value (T-1200, from T-560's security review
//     note a).
//   - An input carrying the frontier (refuse-frontier-in-input.json) is refused by the root's composer port before any
//     model call.
//
// The Durable Objects' storage is not cleared between this file's tests, so each test's texts go to a handle no other test
// uses, or to a fresh rig whose K-05 has seen nothing. Test values only (rule 9): the master's sample cast, the fictional
// 555-01xx numbers and the fixtures' own words.
import joinComposeInput from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import { HAIKU_MODEL } from "@rosie/ai/src/gateway/index";
import traceSkeleton from "@rosie/contracts/event-trace/fixtures/trace-skeleton.json";
import textFixture from "@rosie/contracts/inbound-event/fixtures/text-imessage.json";
import refuseFrontierInInput from "@rosie/contracts/message-plan/fixtures/invalid/refuse-frontier-in-input.json";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { QUIET_MS, turnIdOf, type HandleActor } from "../actor";
import { actorNameOf } from "../gateway";
import { openTrace, type Hop, type Span, type Trace } from "../trace";
import { checkHops, hopsOfTrace, leaks, spansOfLogLines, spansOfTrace } from "../trace/hop-check";
import { flush } from "../turn/test-support";
import type { ComposeInput, MessagePlan } from "../turn/types";
import { composeRoot, SKELETON_FLAG, type HandleActors, type Root } from "./index";
import {
  BUNDLE_V0,
  fakeFlags,
  SAM_CHAT,
  skeletonFakes,
  TEST_OWNER_1,
  watchGate,
  type LinqInboundEvent,
  type SignedWebhook,
  type SkeletonFakes,
} from "./test-support";

type Json = Record<string, unknown>;
type Namespace = DurableObjectNamespace<HandleActor>;

/** A run through the Workers runtime's own steps: a resource guard above Vitest's 5 s default. */
const TEST_MS = 30_000;
/** How long a step of the actor's lent work may take before a wait gives up. */
const WAIT_MS = 15_000;

const SKELETON = traceSkeleton as unknown as Trace;
/** Hops 1 to 9 of a text's trace (K-08 trace-skeleton.json), in D-017's turn order: receive to the composer. */
const HOPS_1_TO_9: readonly Hop[] = hopsOfTrace(SKELETON).slice(
  0,
  hopsOfTrace(SKELETON).indexOf("compose") + 1,
);
/** Hops of those with no writer yet (T-260's gap b): the batch window writes no span until T-1108. Judged once written. */
const NO_WRITER_YET: readonly Hop[] = ["scrub", "batch"];

/** Recording 4's request (K-02 README "v1.1"; T-1175): the JOIN run's S1-02 row, keyed on the run's own ids (DL-347). */
const RECORDING_4 = joinComposeInput as unknown as ComposeInput & {
  readonly masterText: { readonly text: string };
  readonly facts: readonly { readonly value: string }[];
};
/** K-03's plan-s1-02.json: the plan recording 4 answers, and whose shape the JOIN row's plan has. */
const PLAN_S1_02 = planS102 as unknown as MessagePlan;

/** The JOIN run's own context (K-02 README "v1.1", recording 2; T-1145 round 2, DL-347). */
const JOIN_CONTEXT = joinRunContext as unknown as {
  readonly texts: readonly {
    readonly eventId: string;
    readonly words: string;
    readonly sentAt: { utc: string };
  }[];
};
const [JOIN_TEXT_OF_RECORDING] = JOIN_CONTEXT.texts;

/** The fictional numbers this file's texts come from, in each form a number could leak in. */
const CAST_NUMBERS = ["0100"].flatMap((line) => [`+1555555${line}`, `1555555${line}`, `555555${line}`]);

const OWNER_ACTOR = actorNameOf(TEST_OWNER_1.handle);

function namespace(): Namespace {
  return (exports as unknown as { HandleActor: Namespace }).HandleActor;
}

/** The HandleActor namespace as the root takes it (exports.HandleActor in the pool). */
function handleActors(): HandleActors<DurableObjectId> {
  const ns = namespace();
  return { idFromName: (name) => ns.idFromName(name), get: (id) => ns.get(id) };
}

function stubOf(actorName: string): DurableObjectStub<HandleActor> {
  return namespace().get(namespace().idFromName(actorName));
}

/** Waits until the actor has read every text and handed on, and run, what its batch window and lease can. */
async function settle(actorName: string): Promise<void> {
  await stubOf(actorName).safetyIdle();
  await stubOf(actorName).batchIdle();
}

/** Waits until a committed turn's reply has ended and its lease is released (T-253). */
async function untilReplied(actorName: string, turnId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const turn = (await stubOf(actorName).readTurns()).find((entry) => entry.turnId === turnId);
    if (turn?.state === "committed" && turn.leaseUntil === null) return;
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`gave up waiting for the turn's reply to end (state ${turn?.state ?? "none"})`);
    }
    await flush(5);
  }
}

/** The JOIN as recording 2 names it: K-06 text-imessage.json's form from test owner 1, on Sam's chat (imessage). */
function joinAsRecorded(): LinqInboundEvent {
  if (JOIN_TEXT_OF_RECORDING === undefined) throw new Error("recording 2's context holds its text");
  return {
    ...(structuredClone(textFixture) as Json),
    eventId: JOIN_TEXT_OF_RECORDING.eventId,
    handle: { ...TEST_OWNER_1.handle },
    body: JOIN_TEXT_OF_RECORDING.words,
    sentAt: JOIN_TEXT_OF_RECORDING.sentAt.utc,
    chatId: SAM_CHAT,
    messageId: `linq-msg-demo-in-${JOIN_TEXT_OF_RECORDING.eventId}`,
  } as unknown as LinqInboundEvent;
}

/** The webhook as Linq posts it to {BASE_PATH}/webhooks/linq: the three headers and the raw body. */
function webhookRequest(webhook: SignedWebhook): Request {
  return new Request(`https://rosie.test${env.BASE_PATH}/webhooks/linq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": webhook.webhookId,
      "webhook-timestamp": webhook.timestamp,
      "webhook-signature": webhook.signature,
    },
    body: webhook.raw,
  });
}

/** The handle actor's own receive span, beside the gateway's (T-1108). */
const actorReceive = (span: Span): boolean => span.hop === "receive" && span.got?.door === "handleActor";

/** A model call's own span beside the hops: a portCall to provider anthropic, one per attempt. */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

/**
 * A part a console method was handed, as text: a string as it is, and anything else as JSON writes it, every own field
 * at any depth. An Error, at any depth, is read by its name, its message and its cause, which JSON leaves out, and
 * beside them by its own fields as JSON writes them (a class field, a database error's detail), so none escapes
 * (T-1200 round 2, DL-444).
 */
function textOf(part: unknown): string {
  if (typeof part === "string") return part;
  // JSON hands its replacer the part itself first, under the key "": an Error part's own fields are read there.
  const json = JSON.stringify(part, (_key, value: unknown) =>
    value instanceof Error && value !== part ? textOf(value) : value,
  );
  if (!(part instanceof Error)) return json;
  const cause = part.cause === undefined ? [] : [textOf(part.cause)];
  return [`${part.name}: ${part.message}`, ...cause, json].join(" ");
}

/** One line as a console method was handed it, as text. */
const lineOf = (parts: readonly unknown[]): string => parts.map(textOf).join(" ");

/** Every line a console method was handed, as text. */
const linesOf = (spy: MockInstance): string[] => spy.mock.calls.map((call: unknown[]) => lineOf(call));

/**
 * Every text a value holds, at any depth: each string, and each number as its digits (T-087's checkNoRawNumberOrText
 * shapes: a number inside a label, and a number as a count).
 */
function textsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (typeof value === "number") into.push(String(value));
  else if (Array.isArray(value)) for (const item of value as unknown[]) textsOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) textsOf(item, into);
  return into;
}

/**
 * Each item that holds a secret, even inside a longer value, at any depth (textsOf), named by `name` and its place, and
 * by the secret's place in `secrets`, never the secret (K-08 v1 README). Each line of a secret, of 4 characters or more
 * as leaks() reads one, is matched as written: K-08's own labels, such as the outcome joinedTurn, hold the letters of
 * JOIN in another case and are no words.
 */
function holdersOf(items: readonly unknown[], secrets: readonly string[], name: string): string[] {
  const lines = secrets.map((secret) =>
    secret
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 4),
  );
  return items.flatMap((item, index) => {
    const texts = textsOf(item);
    return lines.flatMap((parts, at) =>
      parts.some((part) => texts.some((text) => text.includes(part)))
        ? [`${name} ${String(index + 1)} holds secret ${String(at + 1)}`]
        : [],
    );
  });
}

/** What holdersOf answers when the item `name` holds each of `held`: a damaged copy's expected lines. */
function holding(name: string, secrets: readonly string[], ...held: readonly string[]): string[] {
  return held.map((secret) => `${name} holds secret ${String(secrets.indexOf(secret) + 1)}`);
}

/** The root for "test", every joined port fed its double (compose input's reads and the composer among them). */
function testRoot(fakes: SkeletonFakes, actors: HandleActors<DurableObjectId> | null): Root {
  return composeRoot({
    environment: "test",
    sets: { fake: fakes.ports },
    actors,
    vars: env,
    clock: fakes.clock,
    linq: fakes.linqInputs,
    handleKey: fakes.handleKeys.call,
    // The chat-open port (T-1213) over the dispatch double: each text opens its number's chat before the actor.
    chatOpenCall: fakes.dispatch.openChat,
    safetyReaders: fakes.models.readers,
    turnRows: fakes.turnRows.calls,
    bundleReads: fakes.bundleReads.calls,
    handleTargets: fakes.handleTargets.call,
    frontierScope: fakes.frontier.scope,
    deciders: fakes.decide.deciders,
    gateReads: fakes.gate.reads,
    composeReads: fakes.compose.reads,
    composers: fakes.composer.composers,
    finalizeData: fakes.finalize.data,
    flags: fakeFlags([SKELETON_FLAG]),
  });
}

interface Rig {
  readonly fakes: SkeletonFakes;
  readonly root: Root;
  post(event: LinqInboundEvent): Promise<string>;
  spans(): Span[];
  traceOf(traceId: string): Span[];
  restore(): void;
}

/**
 * The root for "test" with the HandleActor namespace and its actor ports installed. Since T-561 joined finalize, the turn's
 * finalize calls go to the real finalize port, kept on the fake face on their way as the stand-in face kept them.
 */
function rig(log: MockInstance): Rig {
  const fakes = skeletonFakes();
  const root = testRoot(fakes, handleActors());
  const restoreRoot = root.install();
  const watched = watchGate(root, fakes.face);
  const spans = (): Span[] => spansOfLogLines(log.mock.calls.map((call: unknown[]) => call[0]));
  return {
    fakes,
    root,
    async post(event) {
      const response = await root.linqWebhook(webhookRequest(await fakes.sign(event)));
      if (response.status !== 200) throw new Error(`the gateway answered ${String(response.status)}`);
      const traceId = response.headers.get("x-trace-id");
      if (traceId === null) throw new Error("the gateway answered with no trace id");
      return traceId;
    },
    spans,
    traceOf: (traceId) => spansOfTrace(spans(), traceId),
    restore: () => {
      watched.restore();
      restoreRoot();
    },
  };
}

/** The JOIN's turn, run on `run` to its reply: its turn id and trace id. */
async function runJoin(run: Rig): Promise<{ turnId: string; traceId: string }> {
  const join = joinAsRecorded();
  run.fakes.known(join.eventId);
  const traceId = await run.post(join);
  await settle(OWNER_ACTOR);
  await run.fakes.clock.advance(QUIET_MS);
  await runDurableObjectAlarm(stubOf(OWNER_ACTOR));
  const turnId = await turnIdOf([join.eventId]);
  try {
    await untilReplied(OWNER_ACTOR, turnId);
  } catch (error) {
    const seen = run.traceOf(traceId).map((span) => `${span.hop}:${span.outcome}:${span.error_code ?? ""}`);
    throw new Error(
      `${error instanceof Error ? error.message : "no reply"}; the trace shows ${seen.join(", ")}; misses ${run.fakes.composer.misses.join("; ")}`,
      { cause: error },
    );
  }
  await settle(OWNER_ACTOR);
  return { turnId, traceId };
}

/** The one span of a hop in a trace. */
function onlySpan(spans: readonly Span[], hop: Hop): Span {
  const found = spans.filter((span) => span.hop === hop);
  expect(found.map((span) => span.hop)).toEqual([hop]);
  const [span] = found;
  if (span === undefined) throw new Error(`no ${hop} span`);
  return span;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

describe("hop 9 joined: compose input through @rosie/actions' turn face, and the composer returns that row's plan through @rosie/ai", () => {
  it(
    "the JOIN: hops 1 to 9 once each; one compose span for the one outbox row (S1-02, routine), its plan plan-s1-02.json's shape; the composer was given recording 4's input exactly, with no frontier; its one model call carries bundle v0's pinned id and the JOIN's hashed turn id; compose input read the row once under Lee's Barbershop's scope; no span or log line (console.log, info, warn or error) holds a word, a number or the chat id, even inside a longer value",
    { timeout: TEST_MS },
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const run = rig(log);
      try {
        const { turnId, traceId } = await runJoin(run);
        const trace = run.traceOf(traceId);
        const row = `outbox-s1-02-${turnId}-1`;

        // Hops 1 to 9 once each, in turn order, under the trace id and one bundle id; the model calls set aside.
        const unwritten = NO_WRITER_YET.filter((hop) => !trace.some((span) => span.hop === hop));
        const report = checkHops(trace, {
          traceId,
          expected: HOPS_1_TO_9,
          notWritten: unwritten,
          extra: (span) => actorReceive(span) || modelCall(span) || !HOPS_1_TO_9.includes(span.hop),
        });
        expect(report.problems).toEqual([]);
        expect(report.judged).toEqual(expect.arrayContaining(["gate", "commit", "compose"]));

        // The turn: T-248's hash of the JOIN's event id (recording 4 is keyed on it, DL-347).
        expect(turnId).toBe(await turnIdOf(["evt-sam-0000"]));
        expect(RECORDING_4.turn).toBe(turnId);
        expect(RECORDING_4.row).toBe(row);

        // One compose span for the one outbox row, the turn's: S1-02's row, routine, on imessage, with S1-02's four card
        // terms as its facts and the JOIN as its inbound text; its plan plan-s1-02.json's shape (labels and counts).
        const compose = onlySpan(trace, "compose");
        expect(compose).toMatchObject({
          outcome: "ok",
          error_code: null,
          turn_id: turnId,
          bundle_id: BUNDLE_V0,
          business_id: TEST_OWNER_1.businessId,
          got: {
            row,
            channel: "imessage",
            situation: "routine",
            allowedFormats: ["text"],
            facts: 4,
            options: 0,
            inbound: true,
          },
          decided: {
            formats: PLAN_S1_02.formats,
            lines: PLAN_S1_02.lines.length,
            question: true,
            optionIds: 0,
          },
        });
        expect(Date.parse(compose.at)).toBeGreaterThanOrEqual(Date.parse(onlySpan(trace, "commit").at));

        // The composer was given recording 4's input exactly (no frontier among it), and answered from recording 4.
        expect(run.fakes.composer.misses).toEqual([]);
        expect(run.fakes.composer.inputs).toEqual([RECORDING_4]);
        expect(run.fakes.composer.inputs[0]).not.toHaveProperty("frontier");
        expect(run.fakes.composer.calls).toEqual([{ model: HAIKU_MODEL, recording: "composer-join-s1-02" }]);
        expect(run.fakes.composer.rewrites).toEqual([]);
        // The plan the turn handed finalize is recording 4's: plan-s1-02.json, on the row and its channel.
        expect(
          run.fakes.face.finalizeCalls.map((call) => [call.outboxRowId, call.attempt, call.plan]),
        ).toEqual([[row, "composed", { row, channel: "imessage", copyOf: null, plan: PLAN_S1_02 }]]);

        // The compose span's one model call, and the AI gateway's own portCall span for it: Haiku, compose, at its
        // first attempt, under bundles/v0's pinned id and the JOIN's hashed turn id (DL-357).
        expect(
          compose.model_calls?.map((call) => [call.model, call.role, call.purpose, call.outcome]),
        ).toEqual([[HAIKU_MODEL, "haiku", "compose", "ok"]]);
        const composeCalls = trace.filter(
          (span) => modelCall(span) && (span.model_calls ?? []).some((call) => call.purpose === "compose"),
        );
        expect(
          composeCalls.map((span) => [span.bundle_id, span.turn_id, span.attempt, span.outcome]),
        ).toEqual([[BUNDLE_V0, turnId, 1, "ok"]]);
        // The same call on both: a sum of tokens or cost counts the portCall spans only (DL-357; CQ-174's default).
        expect(composeCalls[0]?.model_calls).toEqual(compose.model_calls);

        // Compose input read the row once, under Lee's Barbershop's scope (the Tool API's own) and its business.
        expect(run.fakes.compose.scopes).toEqual([TEST_OWNER_1.businessId]);
        expect(run.fakes.compose.rowReads).toEqual([
          { outboxRowId: row, businessId: TEST_OWNER_1.businessId },
        ]);
        // The turn owns the row's fillAndChecks span (around its finalize); the base records none for compose input.
        expect(trace.filter((span) => span.hop === "fillAndChecks")).toHaveLength(1);

        // No span or log line holds a word, a number or the chat id: the master line, the card's terms, the plan's
        // words, the JOIN.
        const words = [
          "JOIN",
          RECORDING_4.masterText.text,
          ...RECORDING_4.facts.map((fact) => fact.value),
          ...PLAN_S1_02.lines.map((line) => line.text),
          PLAN_S1_02.question?.text ?? "",
        ];
        expect(leaks(run.spans(), [SAM_CHAT, ...CAST_NUMBERS, ...words])).toEqual([]);
        // No line handed to console.log, info, warn or error holds one either, even inside a longer value (T-1200).
        const secrets = [SAM_CHAT, ...CAST_NUMBERS, ...words];
        const lines = { log: linesOf(log), info: linesOf(info), warn: linesOf(warn), error: linesOf(error) };
        const lineHolders = (by: Readonly<Record<string, readonly string[]>>): string[] =>
          Object.entries(by).flatMap(([method, written]) =>
            holdersOf(written, secrets, `console.${method} line`),
          );
        // The check fires on a damaged copy of this run's lines that holds one inside a longer line: the number in
        // the message of an Error handed to console.error, the plan's question in a line handed to console.info,
        // and the JOIN in a warning.
        const question = PLAN_S1_02.question?.text;
        if (question === undefined) throw new Error("plan-s1-02.json asks a question");
        expect(
          lineHolders({ ...lines, error: [lineOf([new Error("refused +15555550100")]), ...lines.error] }),
        ).toEqual(holding("console.error line 1", secrets, "+15555550100", "15555550100", "5555550100"));
        expect(
          lineHolders({
            ...lines,
            info: [lineOf(["finalize_attempt", { said: `Rosie: ${question}` }]), ...lines.info],
          }),
        ).toEqual(holding("console.info line 1", secrets, question));
        expect(lineHolders({ ...lines, warn: [lineOf(["Sam texted JOIN"]), ...lines.warn] })).toEqual(
          holding("console.warn line 1", secrets, "JOIN"),
        );
        // An Error that holds the chat id and the number in fields of its own (a class field, a database error's
        // detail), never in its message, fires too, bare and nested in an object, handed to console.error and
        // console.info (T-1200 round 2, DL-444).
        const refused = Object.assign(new Error("refused"), {
          chatId: SAM_CHAT,
          detail: "Key (phone)=(+15555550100) already exists.",
        });
        const nested = ["compose_failed", { step: "compose", error: refused }];
        const ownFields = [SAM_CHAT, "+15555550100", "15555550100", "5555550100"];
        expect(lineHolders({ ...lines, error: [lineOf([refused]), ...lines.error] })).toEqual(
          holding("console.error line 1", secrets, ...ownFields),
        );
        expect(lineHolders({ ...lines, info: [lineOf([refused]), ...lines.info] })).toEqual(
          holding("console.info line 1", secrets, ...ownFields),
        );
        expect(lineHolders({ ...lines, error: [lineOf(nested), ...lines.error] })).toEqual(
          holding("console.error line 1", secrets, ...ownFields),
        );
        expect(lineHolders({ ...lines, info: [lineOf(nested), ...lines.info] })).toEqual(
          holding("console.info line 1", secrets, ...ownFields),
        );
        // Then none holds one in the run.
        expect(lineHolders(lines)).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        run.restore();
      }
    },
  );

  it(
    "an input carrying the frontier (refuse-frontier-in-input.json) is refused by the root's composer port before any model call",
    { timeout: TEST_MS },
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const fakes = skeletonFakes();
      const root = testRoot(fakes, null);
      const spans: Span[] = [];
      const trace = openTrace({
        openedBy: "textWebhook",
        bundleId: BUNDLE_V0,
        sink: (span) => spans.push(span),
        now: () => Date.now(),
      });
      const input = structuredClone(refuseFrontierInInput) as unknown as ComposeInput;
      trace.setTurn(input.turn);

      expect(await root.turn.composer.compose(input, trace)).toEqual({ error: "frontier", modelCalls: [] });
      expect(fakes.composer.inputs).toEqual([input]);
      expect(fakes.composer.calls).toEqual([]);
      expect(fakes.composer.misses).toEqual([]);
      expect(spans).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
