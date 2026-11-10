// Test support for decide's tests (T-368, T-369): the bundles they read on, with this task's decide prompt packed in; the
// K-02 v1 contexts the decide fixtures were read from; recordings for the recorded-model double (T-004); a fake Messages
// API that answers each step from the double's read, as the two-step wire form splits it; and, for the two reads, each
// bundle's routing policy and a fake that answers each read from its own answers. No network, no key, no live call
// (J-02; DL-027: CI makes none). Never imported by the Worker.
//
// K-02 v1 gives a context for two of its decide fixtures (context-s1-02.json, context-two-requests.json). For the others
// this file writes the context each one's reads were made from: its turn id and bundle id (the double refuses a seed
// fixture of another turn or bundle), a text holding every quote, and the choices each read names, so the double's
// loader accepts every read against it under K-02's schema and both named rules. The steps' words are the master's own
// (A7-17's options and the steps they lead to, A7-18 to A7-20; A6-02's card, as bundle-mini-a holds it; B6-04's
// options; S11-13's options and S11-14's first sentence); names and values are the master's sample cast (Alex, Sam Lee,
// Riley, Avery, Lin W., Lee's Barbershop, Lee Home Services; dates in October 2026), never a real person (rule 9).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptCache, type CacheBundle, type CacheFlow, type PromptCache } from "../cache";
import { fakeCachingApi, type FakeCachingApi } from "../cache/test-support";
import type { Choice, DecideContext, OpenQuestion, Target, TurnText } from "../context";
import { escapeData } from "../context";
import { KEY_VARIABLE, type FetchLike, type GatewayBundle } from "../gateway";
import type { JsonObject } from "../recorded-double";
import { createRouter, type RoutingBundle, type RoutingPolicy, type TurnRoute } from "../routing";
import { DECIDE_PROMPT } from "./prompt";
import { createDecideReader } from "./read";
import { createDecider } from "./two-reads";
import type { DecideReader, Decider } from "./types";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

export type Raw = Record<string, unknown>;

/** A K-01 v1 sample bundle, as the layout and the gateway read it. */
export type Bundle = CacheBundle & {
  manifest: CacheBundle["manifest"] & { models: GatewayBundle["models"] };
  flows: Partial<Record<"A" | "B", CacheFlow>>;
};

const bundleFile = (file: string): Bundle => readJson(`contracts/bundle/fixtures/${file}`) as Bundle;
export const V0 = bundleFile("bundle-v0-skeleton.json");
export const MINI_A = bundleFile("bundle-mini-a.json");
export const MINI_B = bundleFile("bundle-mini-b.json");
export const BUNDLES: readonly Bundle[] = [V0, MINI_A, MINI_B];

/** A bundle as the compiler will pack it: its own flows, with this task's decide prompt in its manifest. */
export function withDecidePrompt(bundle: Bundle): CacheBundle {
  return {
    manifest: {
      bundleId: bundle.manifest.bundleId,
      prompts: { ...bundle.manifest.prompts, decide: DECIDE_PROMPT },
      partial: true,
    },
    flows: bundle.flows,
  };
}

const prompts = new Map<Bundle, PromptCache>();
export function promptsFor(bundle: Bundle): PromptCache {
  let cache = prompts.get(bundle);
  if (cache === undefined) {
    cache = createPromptCache(withDecidePrompt(bundle));
    prompts.set(bundle, cache);
  }
  return cache;
}

export const gatewayBundle = (bundle: Bundle): GatewayBundle => ({
  bundleId: bundle.manifest.bundleId,
  models: bundle.manifest.models,
});

/** The bundle a context is on, by its bundle id. */
export function bundleOf(context: DecideContext): Bundle {
  const found = BUNDLES.find(
    (bundle) =>
      bundle.manifest.bundleId.hash === context.bundleId.hash &&
      bundle.manifest.bundleId.build === context.bundleId.build,
  );
  if (found === undefined) throw new Error(`no sample bundle is ${context.bundleId.hash}`);
  return found;
}

// An obviously fake key, long enough to be found anywhere it leaks (never the real key's prefix).
export const KEY = "FAKE-KEY-FOR-DECIDE-TESTS-ONLY-0123456789abcdef";
export const ENV = Object.freeze({ [KEY_VARIABLE]: KEY });

/** Decide's one read on a context's own bundle, sending through `fetch`. */
export function readerFor(context: DecideContext, fetch: FetchLike): DecideReader {
  const bundle = bundleOf(context);
  return createDecideReader({ bundle: gatewayBundle(bundle), prompts: promptsFor(bundle), env: ENV, fetch });
}

/** A sample bundle's K-01 v1 manifest as the router reads it: its id, its two model ids and its routing policy. */
export function routingBundle(bundle: Bundle): RoutingBundle {
  const manifest = bundle.manifest as Bundle["manifest"] & { policy?: RoutingPolicy };
  if (manifest.policy === undefined)
    throw new Error("a K-01 sample bundle's manifest holds its routing policy");
  return { bundleId: manifest.bundleId, models: manifest.models, policy: manifest.policy };
}

/** Decide's two reads on a context's own bundle, sending through `fetch` (T-369). */
export function deciderFor(context: DecideContext, fetch: FetchLike): Decider {
  const bundle = bundleOf(context);
  return createDecider({ bundle: routingBundle(bundle), prompts: promptsFor(bundle), env: ENV, fetch });
}

/** A seed source giving exactly these seeds, in order; a route that draws more fails the test. */
export function drawFrom(seeds: readonly number[]): () => number {
  let next = 0;
  return () => {
    const seed = seeds[next];
    if (seed === undefined)
      throw new Error(`the test gave ${String(seeds.length)} seeds and a route drew more`);
    next += 1;
    return seed;
  };
}

/** The route decide's two reads take for a context with these seeds: the router gives one route for one draw. */
export function routeOf(context: DecideContext, seeds: readonly number[]): TurnRoute {
  return createRouter(routingBundle(bundleOf(context))).route(context, { draw: drawFrom(seeds) });
}

// ---------------------------------------------------------------------------------------------------------------
// The contexts K-02 v1 does not give, one per decide fixture.

const ZONE = "America/New_York";
const at = (utc: string): { utc: string; zone: string } => ({ utc, zone: ZONE });

const BARBERSHOP = { businessId: "biz-lees-barbershop", businessName: "Lee's Barbershop" } as const;
const HOME_SERVICES = { businessId: "biz-lee-home-services", businessName: "Lee Home Services" } as const;
const noBooking = (business: typeof BARBERSHOP | typeof HOME_SERVICES): Target => ({
  ...business,
  bookingId: null,
  visitAt: null,
});

/** Alex's haircut with Riley, Sat Oct 24 at 11:00am (A7-17's "Your Sat 11:00am visit"). */
const ALEX_SATURDAY: Target = {
  ...BARBERSHOP,
  bookingId: "bk-alex-sat",
  visitAt: at("2026-10-24T15:00:00Z"),
};
/** Lin W.'s visit at Lee Home Services, Thu Oct 29, 12 to 2pm (S11-13 in flow B). */
const LIN_THURSDAY: Target = {
  ...HOME_SERVICES,
  bookingId: "bk-lin-thu",
  visitAt: at("2026-10-29T16:00:00Z"),
};

const ALEX = {
  handle: "+15555550101",
  people: [
    {
      personId: "person-alex",
      name: "Alex",
      roles: [{ role: "customer", businessId: BARBERSHOP.businessId }],
      language: "en",
    },
  ],
};
const SAM = {
  handle: "+15555550100",
  people: [
    {
      personId: "person-sam",
      name: "Sam Lee",
      roles: [
        { role: "owner", businessId: BARBERSHOP.businessId },
        { role: "owner", businessId: HOME_SERVICES.businessId },
      ],
      language: "en",
    },
  ],
};

function text(eventId: string, words: string, utc: string, kind: Partial<TurnText> = {}): TurnText {
  return {
    eventId,
    kind: "text",
    words,
    sentAt: at(utc),
    attachments: [],
    poll: null,
    tapback: null,
    ...kind,
  };
}

interface ChoiceSpec {
  readonly choiceId: string;
  readonly kind: Choice["kind"];
  readonly label: string;
  readonly definition: string;
  readonly step: string;
  readonly target: Target;
  readonly question?: string;
  readonly anytimeRow?: string;
  readonly door?: string;
  readonly fields?: Choice["fields"];
  readonly stakesFrom?: readonly { why: string; step: string | null; ref: string | null }[];
}

/** One K-02 choice: an option's branch is its label word for word; high stakes with its reasons, low with none. */
function choice(spec: ChoiceSpec): Choice {
  const stakesFrom = spec.stakesFrom ?? [];
  return {
    choiceId: spec.choiceId,
    kind: spec.kind,
    label: spec.label,
    definition: spec.definition,
    step: spec.step,
    question: spec.question ?? null,
    branch: spec.kind === "option" || spec.kind === "hub" ? spec.label : null,
    anytimeRow: spec.anytimeRow ?? null,
    door: spec.door ?? null,
    hub: null,
    target: spec.target,
    fields: spec.fields ?? [],
    stakes: stakesFrom.length > 0 ? "high" : "low",
    stakesFrom,
  };
}

function openQuestion(
  id: string,
  step: string,
  target: Target,
  sentUtc: string,
  pollId: string | null = null,
): OpenQuestion {
  return { openQuestionId: id, step, target, sentAt: at(sentUtc), pollId, askCount: 1 };
}

interface ContextSpec {
  readonly turnId: string;
  readonly bundle: Bundle;
  readonly flow: "A" | "B";
  readonly texts: readonly TurnText[];
  readonly writer: DecideContext["writer"];
  readonly openQuestions?: readonly OpenQuestion[];
  readonly choices: readonly Choice[];
  readonly cards?: DecideContext["cards"];
}

function context(spec: ContextSpec): DecideContext {
  const flow = spec.bundle.flows[spec.flow];
  if (flow === undefined) throw new Error(`the bundle holds no flow ${spec.flow}`);
  return {
    turnId: spec.turnId,
    bundleId: spec.bundle.manifest.bundleId,
    flow: spec.flow,
    texts: spec.texts,
    writer: spec.writer,
    businessLanguage: "en",
    openQuestions: spec.openQuestions ?? [],
    choices: spec.choices,
    cards: spec.cards ?? [],
    facts: [],
    alwaysOn: { flow: spec.flow, prefixSha256: flow.routing.alwaysOn.prefixSha256 },
    recentMessages: [],
    meaningSearch: null,
  };
}

/** The danger row of each flow (A3-22, B3-17), as context-s1-02 and context-two-requests give it. */
const dangerRow = (choiceId: string, step: "A3-22" | "B3-17", target: Target): Choice =>
  choice({
    choiceId,
    kind: "anytime",
    anytimeRow: "danger-or-crisis",
    label: "Danger or crisis",
    definition: "Every message and every call is checked before any answer, every time, by meaning.",
    step,
    target,
  });

// A7-17 ("Alex replies?"): Riley is out for Alex's Saturday visit. Its options, word for word, with the first sentence
// of the step each leads to (A7-18, A7-19) or the branch's end text (A7-20).
const OQ_A7_17 = openQuestion("oq-a7-17", "A7-17", ALEX_SATURDAY, "2026-10-23T15:00:00Z");
const A7_17_CHOICES: readonly Choice[] = [
  choice({
    choiceId: "c-01",
    kind: "option",
    question: "oq-a7-17",
    label: "1 The stand-in instead",
    definition: "The stand-in comes in early, and is told.",
    step: "A7-17",
    target: ALEX_SATURDAY,
    stakesFrom: [{ why: "calendarWrite", step: "A7-18", ref: null }],
  }),
  choice({
    choiceId: "c-02",
    kind: "option",
    question: "oq-a7-17",
    label: "2 Another time",
    definition:
      "Riley's next open times, with no fee and the free cancel kept: the business changed the plan.",
    step: "A7-17",
    target: ALEX_SATURDAY,
    fields: [{ name: "time", type: "time" }],
    stakesFrom: [{ why: "question", step: null, ref: "c-01" }],
  }),
  choice({
    choiceId: "c-03",
    kind: "option",
    question: "oq-a7-17",
    label: "3 Cancel, no fee",
    definition: "Cancelled with no fee. Anything paid comes back.",
    step: "A7-17",
    target: ALEX_SATURDAY,
    stakesFrom: [{ why: "refund", step: "A7-20", ref: null }],
  }),
  dangerRow("c-09", "A3-22", noBooking(BARBERSHOP)),
];

/** Alex writes with nothing asked: a booking already made (A3-51's branch to A3-43) and the danger row. */
const ALEX_NOTHING_ASKED: readonly Choice[] = [
  choice({
    choiceId: "c-08",
    kind: "door",
    door: "existingBooking",
    label: "About a booking already made",
    definition: "a change, a question or a cancel for a visit already booked.",
    step: "A3-43",
    target: noBooking(BARBERSHOP),
  }),
  dangerRow("c-09", "A3-22", noBooking(BARBERSHOP)),
];

/** A6-02 and B6-04 ("Sam replies?"): a request at each business, with A6-02's words (B6-04 shares its text). */
function requestOptions(first: number, question: string, step: string, target: Target): Choice[] {
  const id = (k: number): string => `c-${String(first + k).padStart(2, "0")}`;
  const options: [string, string][] = [
    ["1 Accept", "Sam accepts."],
    ["2 Another time", "Sam offers another time, read back first."],
    ["3 Decline", "Sam declined."],
  ];
  return options.map(([label, definition], k) =>
    choice({
      choiceId: id(k),
      kind: "option",
      question,
      label,
      definition,
      step,
      target,
      stakesFrom:
        k === 0 ? [{ why: "booked", step, ref: "booked" }] : [{ why: "question", step: null, ref: id(0) }],
    }),
  );
}
const ALEX_REQUEST: Target = {
  ...BARBERSHOP,
  bookingId: "bk-alex-request",
  visitAt: at("2026-10-24T15:00:00Z"),
};
const LIN_REQUEST: Target = {
  ...HOME_SERVICES,
  bookingId: "bk-lin-request",
  visitAt: at("2026-10-29T16:00:00Z"),
};

const A6_02_CARD = MINI_A.flows.A?.steps["A6-02"]?.card;
if (A6_02_CARD === undefined) throw new Error("bundle-mini-a holds A6-02's card");

// S11-13 ("Anyone booked then?"): Sam's BLOCK reads back, sent as a poll; its options word for word.
const OQ_S11_13 = openQuestion("oq-s11-13", "S11-13", LIN_THURSDAY, "2026-10-26T15:31:00Z", "poll-s11-13");
const S11_13_CHOICES: readonly Choice[] = [
  choice({
    choiceId: "c-01",
    kind: "option",
    question: "oq-s11-13",
    label: "1 Block; offer new times",
    definition:
      "The block can't hold a booked visit, so each customer is offered new times or a free call-off.",
    step: "S11-13",
    target: LIN_THURSDAY,
    stakesFrom: [{ why: "calendarWrite", step: "S11-14", ref: null }],
  }),
  choice({
    choiceId: "c-02",
    kind: "option",
    question: "oq-s11-13",
    label: "2 Block around it",
    definition: "the blocked time skips the booking, so it stays.",
    step: "S11-13",
    target: LIN_THURSDAY,
    stakesFrom: [{ why: "question", step: null, ref: "c-01" }],
  }),
  dangerRow("c-03", "B3-17", noBooking(HOME_SERVICES)),
];

/** An Alex turn with nothing asked: one text. */
const alexSays = (turnId: string, eventId: string, words: string): DecideContext =>
  context({
    turnId,
    bundle: MINI_A,
    flow: "A",
    texts: [text(eventId, words, "2026-10-23T18:00:00Z")],
    writer: ALEX,
    choices: ALEX_NOTHING_ASKED,
  });

/** The context each K-02 decide fixture without one of its own was read from, by fixture file. */
export const WRITTEN_CONTEXTS: Readonly<Record<string, DecideContext>> = {
  "decide-bare-2.json": context({
    turnId: "turn-a7-17-alex-2",
    bundle: MINI_A,
    flow: "A",
    texts: [text("evt-alex-0701", "2", "2026-10-23T15:04:00Z")],
    writer: ALEX,
    openQuestions: [OQ_A7_17],
    choices: A7_17_CHOICES,
  }),
  "decide-tapback-asks-which.json": context({
    turnId: "turn-a7-17-alex-tapback",
    bundle: MINI_A,
    flow: "A",
    texts: [
      text("evt-alex-0702", "Liked", "2026-10-23T15:06:00Z", {
        kind: "tapback",
        tapback: { reaction: "Liked", onMessageId: "msg-a7-17" },
      }),
    ],
    writer: ALEX,
    openQuestions: [OQ_A7_17],
    choices: A7_17_CHOICES,
  }),
  "decide-reads-disagree.json": context({
    turnId: "turn-a7-17-alex-either",
    bundle: MINI_A,
    flow: "A",
    texts: [
      text("evt-alex-0703", "can Avery do it, or I'll just come Saturday at 2", "2026-10-23T15:08:00Z"),
    ],
    writer: ALEX,
    openQuestions: [OQ_A7_17],
    choices: A7_17_CHOICES,
  }),
  "decide-poll-vote.json": context({
    turnId: "turn-s11-13-sam-vote",
    bundle: MINI_B,
    flow: "B",
    texts: [
      text("evt-sam-0104", "Block around it", "2026-10-26T15:32:00Z", {
        kind: "pollVote",
        poll: { pollId: "poll-s11-13", optionId: "poll-s11-13-2" },
      }),
    ],
    writer: SAM,
    openQuestions: [OQ_S11_13],
    choices: S11_13_CHOICES,
  }),
  "decide-ask.json": context({
    turnId: "turn-sam-1-two-requests",
    bundle: MINI_A,
    flow: "A",
    texts: [text("evt-sam-0105", "1", "2026-10-21T13:10:00Z")],
    writer: SAM,
    openQuestions: [
      openQuestion("oq-a6-02", "A6-02", ALEX_REQUEST, "2026-10-21T13:00:00Z"),
      openQuestion("oq-b6-04", "B6-04", LIN_REQUEST, "2026-10-21T13:05:00Z"),
    ],
    choices: [
      ...requestOptions(1, "oq-a6-02", "A6-02", ALEX_REQUEST),
      ...requestOptions(4, "oq-b6-04", "B6-04", LIN_REQUEST),
      dangerRow("c-09", "A3-22", noBooking(BARBERSHOP)),
    ],
    cards: [{ step: "A6-02", card: A6_02_CARD }],
  }),
  "decide-no-op-thanks.json": alexSays("turn-alex-thanks", "evt-alex-0704", "thanks!"),
  "decide-none-fits.json": alexSays("turn-alex-gift-card", "evt-alex-0705", "do you sell gift cards?"),
  "decide-pass-on.json": alexSays(
    "turn-alex-thanks-riley",
    "evt-alex-0706",
    "please tell Riley thanks for the great fade last time",
  ),
  "decide-hand-off.json": alexSays(
    "turn-alex-wants-sam",
    "evt-alex-0707",
    "can I talk to Sam directly please",
  ),
  "decide-hand-off-owner-or-staff.json": alexSays(
    "turn-alex-reports-riley",
    "evt-alex-0708",
    "Riley grabbed my arm during my cut and I want someone to know",
  ),
  "decide-redact.json": alexSays(
    "turn-alex-skin-test",
    "evt-alex-0709",
    "my skin test for the beard color came back fine, no reaction",
  ),
};

/** The K-02 v1 context fixture of each decide fixture that has one. */
export const K02_CONTEXTS: Readonly<Record<string, string>> = {
  "decide-s1-02-choose.json": "context-s1-02.json",
  "decide-two-requests.json": "context-two-requests.json",
};

/** The decide fixtures the card reads (its "Reads"), and the two more this file gives contexts for. */
export const CARD_FIXTURES = [
  "decide-s1-02-choose.json",
  "decide-two-requests.json",
  "decide-bare-2.json",
  "decide-poll-vote.json",
  "decide-tapback-asks-which.json",
  "decide-no-op-thanks.json",
  "decide-none-fits.json",
  "decide-ask.json",
  "decide-pass-on.json",
  "decide-hand-off.json",
  "decide-redact.json",
] as const;
export const MORE_FIXTURES = ["decide-hand-off-owner-or-staff.json", "decide-reads-disagree.json"] as const;

/** A copy of a K-02 context with another turn id and its one text's words: a made-up turn for a made-up read. */
export function retold(base: DecideContext, turnId: string, words: string): DecideContext {
  const [first] = base.texts;
  if (first === undefined) throw new Error("the base context has a text");
  return { ...structuredClone(base), turnId, texts: [{ ...structuredClone(first), words }] };
}

/** The roles each fixture's reads were made in. */
export const rolesOf = (fixture: { reads: { role: string }[] }): string[] =>
  fixture.reads.map((read) => read.role);

/**
 * The double's recordings for the written contexts, each read seeded from its K-02 fixture, and the made-up reads given
 * as `output` (a live recording's form), each against its own context.
 */
export function writtenRecordings(
  roles: Readonly<Record<string, readonly string[]>>,
  madeUp: readonly { id: string; context: DecideContext; output: JsonObject }[],
): JsonObject {
  return {
    version: "v1",
    contract: "model.v1",
    recordings: [
      ...Object.entries(WRITTEN_CONTEXTS).flatMap(([fixture, written]) =>
        (roles[fixture] ?? []).map((role) => ({
          id: `${fixture.replace(/\.json$/u, "")}-${role}`,
          kind: "decideRead",
          request: { context: written as unknown as JsonObject, role },
          seed: { fixture },
        })),
      ),
      ...madeUp.map(({ id, context: own, output }) => ({
        id,
        kind: "decideRead",
        request: { context: own as unknown as JsonObject, role: "first" },
        output,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The fake Messages API: each step answered from a K-02 read, as the model would split it.

/** A K-02 read as the two steps' answers (lib.mjs's toTwoStep): step 2 of part k is null for no_op. */
export interface StepAnswers {
  readonly step1: unknown;
  readonly step2: readonly unknown[];
}

export function twoStep(read: Raw): StepAnswers {
  const parts = read.parts as Raw[];
  return {
    step1: { language: read.language, parts: parts.map((part) => ({ quote: part.quote, verb: part.verb })) },
    step2: parts.map((part) => {
      if (part.verb === "no_op") return null;
      return Object.fromEntries(Object.entries(part).filter(([key]) => key !== "verb" && key !== "quote"));
    }),
  };
}

const STEP_TAG = /<step n="([12])"(?: part="([0-9]+)")?><\/step>$/u;

/** The step a request asks for, from its user message's last tag: 1, or 2 with its part (1-based). */
export function stepOf(body: Raw): { n: 1 } | { n: 2; part: number } {
  const messages = body.messages as { content: string }[];
  const match = STEP_TAG.exec(messages[0]?.content ?? "");
  if (match === null) throw new Error("the user message does not end with a step tag");
  return match[1] === "1" ? { n: 1 } : { n: 2, part: Number(match[2]) };
}

/** The user message a request sent. */
export const userOf = (body: Raw): string => (body.messages as { content: string }[])[0]?.content ?? "";

/** Every string in an answer as a model copying the escaped data would write it (context/tags.ts's escape). */
export function copiedEscaped(value: unknown): unknown {
  if (typeof value === "string") return escapeData(value);
  if (Array.isArray(value)) return value.map(copiedEscaped);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, copiedEscaped(inner)]));
  return value;
}

export interface FakeDecideOptions {
  /** An HTTP status to fail a call with, or null to answer it (n counts every call from 0). */
  readonly fail?: (body: Raw, n: number) => number | null;
  /** Changes each answer before it is sent, as a model might write it. */
  readonly write?: (answer: unknown) => unknown;
}

/** The answer to one request from a read's step answers: step 1's, or step 2's for its part. */
function stepAnswer(answers: StepAnswers, body: Raw): unknown {
  const step = stepOf(body);
  if (step.n === 1) return answers.step1;
  const answer = answers.step2[step.part - 1];
  if (answer === undefined || answer === null) throw new Error(`no step 2 for part ${String(step.part)}`);
  return answer;
}

/** A fake Messages API with Anthropic's prompt cache (T-364's), answering each step from `answers`. */
export function fakeDecideApi(answers: StepAnswers, options: FakeDecideOptions = {}): FakeCachingApi {
  const write = options.write ?? ((answer: unknown): unknown => answer);
  return fakeCachingApi({
    answer: (body) => write(stepAnswer(answers, body)),
    ...(options.fail !== undefined && { fail: options.fail }),
  });
}

/** The choice ids a request's per-turn part lists, in its order (T-367 writes each as `<choice id="...">`). */
export const choiceIdsOf = (user: string): string[] =>
  [...user.matchAll(/<choice id="([^"]*)"/gu)].map((match) => match[1] ?? "");

/**
 * Which of a route's two reads a request is for, told by the order its per-turn part lists the choices in: each read's
 * own seed's order, which the router keeps apart for two choices or more (T-363). Throws for a request in neither.
 */
export function readOfRequest(route: TurnRoute, body: Raw): "first" | "check" {
  const order = choiceIdsOf(userOf(body)).join(" ");
  const [first, check] = route.reads;
  const isFirst = order === first.choiceOrder.join(" ");
  const isCheck = order === check.choiceOrder.join(" ");
  if (isFirst === isCheck)
    throw new Error("the request lists the choices in neither read's order, or in both");
  return isFirst ? "first" : "check";
}

/** The step answers of each of a turn's two reads. */
export interface TwoReadAnswers {
  readonly first: StepAnswers;
  readonly check: StepAnswers;
}

/** A fake Messages API with Anthropic's prompt cache, answering each request from the answers of the read it is for. */
export function fakeTwoReadApi(
  route: TurnRoute,
  answers: TwoReadAnswers,
  options: FakeDecideOptions = {},
): FakeCachingApi {
  const write = options.write ?? ((answer: unknown): unknown => answer);
  return fakeCachingApi({
    answer: (body) => write(stepAnswer(answers[readOfRequest(route, body)], body)),
    ...(options.fail !== undefined && { fail: options.fail }),
  });
}
