// Tests of model routing by stakes (T-363; C-121, C-115). Offline, as every AI test (J-02: no live call; CI makes none).
// K-02 v1's contexts and decide fixtures come through the model-contract fixture loader (T-004) and are checked against
// K-02's own schema; the contexts K-02 does not give are decide's test-support's (T-368), each checked the same way.
// The reads a route makes run through decide's one read (T-368), the context bundle (T-367) and the real AI gateway
// (T-361), the model answering from the recorded-model double (T-004) through a fake Messages API with Anthropic's
// prompt cache (T-364's); the global fetch fails the file if anything reaches it. K-01 v1's manifests are its sample
// bundles' (V0, mini-a, mini-b, manifest.json), held to K-01's own schema. Names and values are the master's sample
// cast (rule 9).

import { readdirSync } from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildContextPrompt, type DecideContext } from "../context";
import type { DecideReadOk } from "../decide";
import {
  CARD_FIXTURES,
  K02_CONTEXTS,
  MINI_A,
  MINI_B,
  MORE_FIXTURES,
  REPO_ROOT,
  V0,
  WRITTEN_CONTEXTS,
  bundleOf,
  fakeDecideApi,
  promptsFor,
  readJson,
  readerFor,
  rolesOf,
  twoStep,
  userOf,
  writtenRecordings,
  type Bundle,
  type Raw,
} from "../decide/test-support";
import { ALLOWED_MODELS, GatewayConfigError, HAIKU_MODEL, SONNET_MODEL } from "../gateway";
import {
  buildRecordedModel,
  loadModelContract,
  loadRecordedModel,
  type JsonObject,
  type ModelContract,
  type RecordedModel,
} from "../recorded-double";
import { openTrace, type TraceContext } from "../../../runtime/src/trace";
import {
  MAX_SEED_STEPS,
  MODEL_ROLES,
  RoutingPolicyError,
  RoutingRefusedError,
  STAKES,
  choiceOrder,
  createRouter,
  policyProblems,
  turnStakes,
  type ModelRole,
  type RoutedRead,
  type Router,
  type RoutingBundle,
  type RoutingPolicy,
} from "./index";

interface DecideFixture {
  readonly turnId: string;
  readonly stakes: "low" | "high";
  readonly routing: { readonly first: ModelRole; readonly second: ModelRole };
  readonly reads: readonly { readonly model: ModelRole; readonly role: string; readonly output: unknown }[];
}

/** Every K-02 decide fixture with a context: the 13 decide's own tests read. */
const FIXTURE_FILES: readonly string[] = [...CARD_FIXTURES, ...MORE_FIXTURES];
const SAMPLE_BUNDLES: readonly Bundle[] = [V0, MINI_A, MINI_B];
const SEED_LIMIT = 0xffffffff;

/** Q-26's default (J-21's double: Sonnet first on high stakes), as every K-01 sample bundle carries it. */
const Q26_DEFAULT: RoutingPolicy = {
  low: { first: "haiku", second: "haiku" },
  high: { first: "sonnet", second: "haiku" },
  reread: "sonnet",
};
/** The other answer J-21 may give: Haiku first on high stakes, Sonnet checking. */
const HAIKU_FIRST: RoutingPolicy = { ...Q26_DEFAULT, high: { first: "haiku", second: "sonnet" } };

const ROLES: readonly ModelRole[] = ["haiku", "sonnet"];
/** Every policy K-01 v1 can write: each read pair's two models and the re-read's, haiku or sonnet (2^5 = 32). */
const ALL_POLICIES: readonly RoutingPolicy[] = ROLES.flatMap((lowFirst) =>
  ROLES.flatMap((lowSecond) =>
    ROLES.flatMap((highFirst) =>
      ROLES.flatMap((highSecond) =>
        ROLES.map((reread): RoutingPolicy => ({
          low: { first: lowFirst, second: lowSecond },
          high: { first: highFirst, second: highSecond },
          reread,
        })),
      ),
    ),
  ),
);

const idOf = (model: ModelRole): string => (model === "haiku" ? HAIKU_MODEL : SONNET_MODEL);

/** A sample bundle's K-01 v1 manifest, as the router reads it. */
const manifestOf = (bundle: Bundle): RoutingBundle => bundle.manifest as unknown as RoutingBundle;
const routerOf = (bundle: Bundle): Router => createRouter(manifestOf(bundle));
const routerWith = (bundle: Bundle, policy: RoutingPolicy): Router =>
  createRouter({ ...manifestOf(bundle), policy });

/** The whole manifest object of a sample bundle, every K-01 field, with another policy. */
const fullManifest = (bundle: Bundle, policy: unknown): Record<string, unknown> => ({
  ...(structuredClone(bundle.manifest) as unknown as Record<string, unknown>),
  policy,
});

/** A seed source giving exactly these seeds, in order; a test that draws more fails. */
function drawFrom(seeds: readonly number[]): () => number {
  let next = 0;
  return () => {
    const seed = seeds[next];
    if (seed === undefined)
      throw new Error(`the test gave ${String(seeds.length)} seeds and a route drew more`);
    next += 1;
    return seed;
  };
}

/** The choice ids of a per-turn part, as their attributes are written, in the order it lists them (T-367's form). */
const choiceIdsOf = (turn: string): string[] =>
  [...turn.matchAll(/<choice id="([^"]*)"/gu)].map((match) => match[1] ?? "");

/** K-01 v1's schema for one definition: the shared formats and the bundle schema, as the contract harness loads them. */
function k01(def: string): (value: unknown) => string[] {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  for (const folder of ["common", "bundle"]) {
    for (const file of readdirSync(path.join(REPO_ROOT, "contracts", folder))) {
      if (file.endsWith(".schema.json")) ajv.addSchema(readJson(`contracts/${folder}/${file}`) as object);
    }
  }
  const validate = ajv.getSchema(
    `https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/${def}`,
  );
  if (validate === undefined) throw new Error(`K-01 v1 has no definition ${def}`);
  return (value) =>
    validate(value)
      ? []
      : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? "is invalid"}`);
}

const globalFetch = vi.fn(() => {
  throw new Error("no network in a routing test: the global fetch was called");
});

let contract: ModelContract;
let shipped: RecordedModel;
let written: RecordedModel;
let k01Manifest: (value: unknown) => string[];
const fixtures = new Map<string, DecideFixture>();
const contexts = new Map<string, DecideContext>();
/** The model id of every request any test sent through the gateway. */
const everySent: string[] = [];

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}
const fixtureOf = (file: string): DecideFixture => must(fixtures.get(file), file);
const contextOf = (file: string): DecideContext => must(contexts.get(file), `the context of ${file}`);

/** A K-02 context changed for a test, still one K-02 v1 accepts. */
function stillK02(context: DecideContext): DecideContext {
  expect(contract.validate("context", context)).toEqual([]);
  return context;
}

/** The context with the given choices made high, for a reason the frontier builder gives when it cannot walk one. */
function madeHigh(context: DecideContext, ids: readonly string[]): DecideContext {
  return stillK02({
    ...structuredClone(context),
    choices: context.choices.map((choice) =>
      ids.includes(choice.choiceId)
        ? {
            ...structuredClone(choice),
            stakes: "high",
            stakesFrom: [{ why: "unknown", step: null, ref: null }],
          }
        : structuredClone(choice),
    ),
  });
}

/** The context with only its first n choices. */
const firstChoices = (context: DecideContext, n: number): DecideContext =>
  stillK02({ ...structuredClone(context), choices: context.choices.slice(0, n) });

beforeAll(async () => {
  vi.stubGlobal("fetch", globalFetch);
  contract = await loadModelContract();
  shipped = await loadRecordedModel();
  k01Manifest = k01("manifest");
  for (const file of FIXTURE_FILES) {
    const fixture = contract.fixtures.read(file);
    expect(contract.validate("decideResult", fixture), file).toEqual([]);
    fixtures.set(file, fixture as DecideFixture);
    const k02 = K02_CONTEXTS[file];
    const context = k02 === undefined ? WRITTEN_CONTEXTS[file] : contract.fixtures.read(k02);
    expect(contract.validate("context", context), file).toEqual([]);
    contexts.set(file, context as DecideContext);
  }
  const roles = Object.fromEntries(
    [...fixtures].map(([file, fixture]) => [file, rolesOf({ reads: [...fixture.reads] })]),
  );
  written = await buildRecordedModel(writtenRecordings(roles, []));
});
afterEach(() => {
  // Whatever a test routed, every request it sent went to one of the two models.
  for (const model of everySent) expect(ALLOWED_MODELS as readonly string[]).toContain(model);
  everySent.length = 0;
});
afterAll(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** The double's read of a context in a role: the shipped recordings for K-02's own contexts, else the written ones. */
async function recorded(context: DecideContext, role: RoutedRead["role"]): Promise<Raw> {
  const shippedTurns = Object.values(K02_CONTEXTS).map(
    (file) => (contract.fixtures.read(file) as DecideContext).turnId,
  );
  const double = shippedTurns.includes(context.turnId) ? shipped : written;
  return await double.decide({ context: context as unknown as JsonObject, role });
}

interface WireRead {
  readonly answer: DecideReadOk;
  /** The model id of each request the read sent, in order. */
  readonly models: readonly string[];
  /** The choice ids each request's per-turn part listed, in order. */
  readonly orders: readonly (readonly string[])[];
}

/** One routed read through decide's one read and the AI gateway, the model answering as the double recorded it. */
async function readOnWire(context: DecideContext, read: RoutedRead, trace?: TraceContext): Promise<WireRead> {
  const api = fakeDecideApi(twoStep(await recorded(context, read.role)));
  const answer = await readerFor(context, api.fetch).read(
    context,
    read,
    trace === undefined ? {} : { trace },
  );
  everySent.push(...api.calls.map((call) => call.model));
  if (answer.status !== "ok") throw new Error(`the ${read.role} read is ${answer.status}`);
  return {
    answer,
    models: api.calls.map((call) => call.model),
    orders: api.calls.map((call) => choiceIdsOf(userOf(call.body))),
  };
}

function traceOf(context: DecideContext): TraceContext {
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: context.bundleId,
    handleRef: "handle-routing",
  });
  trace.setTurn(context.turnId);
  return trace;
}

describe("a turn with any high-stakes choice routes Sonnet then Haiku", () => {
  it("each K-02 decide fixture's context routes to the fixture's stakes and routing, and its reads to the models they were made on", () => {
    const counted = { high: 0, low: 0 };
    for (const file of FIXTURE_FILES) {
      const fixture = fixtureOf(file);
      const context = contextOf(file);
      const route = routerOf(bundleOf(context)).route(context);
      expect({ turnId: route.turnId, stakes: route.stakes, routing: route.routing }, file).toEqual({
        turnId: fixture.turnId,
        stakes: fixture.stakes,
        routing: fixture.routing,
      });
      const modelOf = new Map(fixture.reads.map((read) => [read.role, read.model]));
      expect(
        route.reads.map((read) => [read.purpose, read.role, read.model]),
        file,
      ).toEqual([
        ["decideFirst", "first", modelOf.get("first")],
        ["decideCheck", "check", modelOf.get("check")],
      ]);
      // decide-reads-disagree.json's re-read was Sonnet's: the policy's re-read model.
      expect(route.reread.model).toBe(modelOf.get("reread") ?? "sonnet");
      const high = context.choices
        .filter((choice) => choice.stakes === "high")
        .map((choice) => choice.choiceId);
      expect(route.highChoices).toEqual([...high].sort());
      expect(route.stakes).toBe(high.length > 0 ? "high" : "low");
      counted[route.stakes] += 1;
    }
    // Five turns offer a high choice (a refund, a calendar write, a booking, or another option of their question).
    expect(counted).toEqual({ high: 5, low: 8 });
  });

  it("one high choice is enough, wherever it sits: an all-low turn with any one of its choices made high routes Sonnet then Haiku", () => {
    for (const file of ["decide-s1-02-choose.json", "decide-two-requests.json"]) {
      const base = contextOf(file);
      const router = routerOf(bundleOf(base));
      expect(router.route(base).routing).toEqual({ first: "haiku", second: "haiku" });
      for (const choice of base.choices) {
        // The frontier builder would mark the other options of its question high too (K-02 README "Stakes"); one is enough.
        const route = router.route(madeHigh(base, [choice.choiceId]));
        expect(route.stakes).toBe("high");
        expect(route.highChoices).toEqual([choice.choiceId]);
        expect(route.routing).toEqual({ first: "sonnet", second: "haiku" });
        expect(route.reads.map((read) => [read.purpose, read.model, read.modelId])).toEqual([
          ["decideFirst", "sonnet", SONNET_MODEL],
          ["decideCheck", "haiku", HAIKU_MODEL],
        ]);
      }
      const all = router.route(
        madeHigh(
          base,
          base.choices.map((choice) => choice.choiceId),
        ),
      );
      expect(all.highChoices).toHaveLength(base.choices.length);
      expect(all.routing).toEqual({ first: "sonnet", second: "haiku" });
    }
  });

  it("turnStakes reads only each choice's stakes: high with the high choices' ids, sorted, else low", () => {
    const base = contextOf("decide-two-requests.json");
    expect(turnStakes(base)).toEqual({ stakes: "low", highChoices: [] });
    expect(turnStakes(madeHigh(base, ["c-07", "c-02"]))).toEqual({
      stakes: "high",
      highChoices: ["c-02", "c-07"],
    });
    expect(turnStakes(contextOf("decide-ask.json"))).toEqual({
      stakes: "high",
      highChoices: ["c-01", "c-02", "c-03", "c-04", "c-05", "c-06"],
    });
  });

  it("through the AI gateway: the first read's calls go to claude-sonnet-5-5 and the check's to claude-haiku-5-5, each read the double's", async () => {
    for (const file of ["decide-ask.json", "decide-bare-2.json", "decide-poll-vote.json"]) {
      const context = contextOf(file);
      const route = routerOf(bundleOf(context)).route(context);
      const trace = traceOf(context);
      const first = await readOnWire(context, route.reads[0], trace);
      const check = await readOnWire(context, route.reads[1], trace);
      expect(first.models.length, file).toBeGreaterThan(0);
      expect(new Set(first.models), file).toEqual(new Set([SONNET_MODEL]));
      expect(new Set(check.models), file).toEqual(new Set([HAIKU_MODEL]));
      expect([first.answer.read, check.answer.read]).toEqual(
        fixtureOf(file).reads.filter((read) => read.role !== "reread"),
      );
      // The gateway wrote one span per attempt: Sonnet's for the first read, then Haiku's for the check.
      expect(
        trace.spans
          .flatMap((span) => span.model_calls ?? [])
          .map((call) => [call.role, call.purpose, call.model]),
      ).toEqual([
        ...first.models.map(() => ["sonnet", "decideFirst", SONNET_MODEL]),
        ...check.models.map(() => ["haiku", "decideCheck", HAIKU_MODEL]),
      ]);
      // Each read was laid out with its route's seed: the order the route says.
      expect([first.answer.seed, check.answer.seed]).toEqual(route.reads.map((read) => read.seed));
      expect([first.answer.choiceOrder, check.answer.choiceOrder]).toEqual(
        route.reads.map((read) => read.choiceOrder),
      );
    }
  });
});

describe("an all-low turn routes Haiku twice with two different shuffles", () => {
  it("context-s1-02 and context-two-requests: both reads on Haiku, their two seeds listing every choice in two different orders", () => {
    for (const file of ["decide-s1-02-choose.json", "decide-two-requests.json"]) {
      const context = contextOf(file);
      expect(context.choices.every((choice) => choice.stakes === "low")).toBe(true);
      const route = routerOf(bundleOf(context)).route(context);
      expect(route.stakes).toBe("low");
      expect(route.highChoices).toEqual([]);
      expect(route.routing).toEqual({ first: "haiku", second: "haiku" });
      expect(route.reads.map((read) => [read.purpose, read.role, read.model, read.modelId])).toEqual([
        ["decideFirst", "first", "haiku", HAIKU_MODEL],
        ["decideCheck", "check", "haiku", HAIKU_MODEL],
      ]);
      const [first, check] = route.reads;
      expect(first.seed).not.toBe(check.seed);
      expect(first.choiceOrder).not.toEqual(check.choiceOrder);
      const ids = context.choices.map((choice) => choice.choiceId).sort();
      expect([...first.choiceOrder].sort()).toEqual(ids);
      expect([...check.choiceOrder].sort()).toEqual(ids);
    }
  });

  it("through the AI gateway: every call of both reads goes to claude-haiku-5-5, each read's prompt listing the choices in its own route's order", async () => {
    const context = contextOf("decide-two-requests.json");
    const route = routerOf(MINI_B).route(context);
    const first = await readOnWire(context, route.reads[0]);
    const check = await readOnWire(context, route.reads[1]);
    // Step 1, then one step-2 call per part (two parts), for each read.
    expect([...first.models, ...check.models]).toEqual(Array<string>(6).fill(HAIKU_MODEL));
    for (const order of first.orders) expect(order).toEqual(route.reads[0].choiceOrder);
    for (const order of check.orders) expect(order).toEqual(route.reads[1].choiceOrder);
    expect(first.orders[0]).not.toEqual(check.orders[0]);
    expect([first.answer.read, check.answer.read]).toEqual(fixtureOf("decide-two-requests.json").reads);
    expect([first.answer.seed, check.answer.seed]).toEqual(route.reads.map((read) => read.seed));
  });

  it("each read's order is the one the context bundle (T-367) lays its prompt out in for that seed, whatever order the frontier lists", () => {
    for (const file of ["decide-s1-02-choose.json", "decide-two-requests.json", "decide-ask.json"]) {
      const context = contextOf(file);
      const prompts = promptsFor(bundleOf(context));
      const ids = context.choices.map((choice) => choice.choiceId);
      for (let seed = 0; seed < 300; seed += 1) {
        expect(choiceOrder(ids, seed)).toEqual(
          buildContextPrompt(prompts, context, { purpose: "decideFirst", seed }).choiceOrder,
        );
      }
      expect(choiceOrder([...ids].reverse(), 2026)).toEqual(choiceOrder(ids, 2026));
      const route = routerOf(bundleOf(context)).route(context);
      for (const read of route.reads) expect(read.choiceOrder).toEqual(choiceOrder(ids, read.seed));
    }
  });

  it("over 3,000 routes with drawn seeds, the two reads never list the choices in one order, even with two choices", () => {
    const base = contextOf("decide-s1-02-choose.json");
    const router = routerOf(V0);
    for (const n of [2, 3, 5]) {
      const context = firstChoices(base, n);
      const firsts = new Set<string>();
      for (let k = 0; k < 1000; k += 1) {
        const route = router.route(context);
        expect(route.reads[0].choiceOrder).not.toEqual(route.reads[1].choiceOrder);
        expect(route.reads[0].seed).not.toBe(route.reads[1].seed);
        firsts.add(route.reads[0].choiceOrder.join(" "));
      }
      // The first read keeps its drawn seed's order: both orders of two choices turn up, and all six of three.
      if (n <= 3) expect(firsts.size).toBe(n === 2 ? 2 : 6);
    }
  });

  it("a check seed listing the first read's order is stepped on until it does not, wrapping at 2^32; a source stuck on one seed still gets two orders", () => {
    const context = firstChoices(contextOf("decide-s1-02-choose.json"), 2);
    const ids = context.choices.map((choice) => choice.choiceId);
    const router = routerOf(V0);

    const first = 7;
    let same = first + 1;
    while (choiceOrder(ids, same).join() !== choiceOrder(ids, first).join()) same += 1;
    const stepped = router.route(context, { draw: drawFrom([first, same]) });
    expect(stepped.reads[0].seed).toBe(first);
    expect(stepped.reads[1].seed).toBeGreaterThan(same);
    expect(stepped.reads[1].seed - same).toBeLessThanOrEqual(MAX_SEED_STEPS);
    expect(stepped.reads[1].choiceOrder).not.toEqual(stepped.reads[0].choiceOrder);
    for (let seed = same; seed < stepped.reads[1].seed; seed += 1) {
      expect(choiceOrder(ids, seed)).toEqual(stepped.reads[0].choiceOrder);
    }

    let atTop = 0;
    while (choiceOrder(ids, atTop).join() !== choiceOrder(ids, SEED_LIMIT).join()) atTop += 1;
    const wrapped = router.route(context, { draw: drawFrom([atTop, SEED_LIMIT]) });
    expect(wrapped.reads[1].seed).toBeLessThanOrEqual(MAX_SEED_STEPS);
    expect(wrapped.reads[1].choiceOrder).not.toEqual(wrapped.reads[0].choiceOrder);

    const stuck = router.route(context, { draw: () => first });
    expect(stuck.reads[0].seed).toBe(first);
    expect(stuck.reads[1].seed).not.toBe(first);
    expect(stuck.reads[1].choiceOrder).not.toEqual(stuck.reads[0].choiceOrder);
  });

  it("a turn with one choice has one order: its two reads still get two seeds, and there is nothing else to shuffle", () => {
    const context = firstChoices(contextOf("decide-s1-02-choose.json"), 1);
    const route = routerOf(V0).route(context, { draw: () => 7 });
    expect(route.reads.map((read) => [read.model, read.seed, read.choiceOrder])).toEqual([
      ["haiku", 7, ["c-01"]],
      ["haiku", 8, ["c-01"]],
    ]);
  });
});

describe("a bundle whose manifest says Haiku first on high stakes is honoured (the Q-26 switch is data, not code)", () => {
  it("every K-01 sample manifest carries Q-26's default, Sonnet first; the switched manifest is still K-01 v1's, one field apart", () => {
    const sampleManifest = readJson("contracts/bundle/fixtures/manifest.json") as Record<string, unknown>;
    expect(k01Manifest(sampleManifest)).toEqual([]);
    expect(sampleManifest.policy).toEqual(Q26_DEFAULT);
    expect(k01Manifest({ ...sampleManifest, policy: HAIKU_FIRST })).toEqual([]);
    for (const bundle of SAMPLE_BUNDLES) {
      const manifest = fullManifest(bundle, manifestOf(bundle).policy);
      expect(k01Manifest(manifest)).toEqual([]);
      expect(manifest.policy).toEqual(Q26_DEFAULT);
      const switched = fullManifest(bundle, HAIKU_FIRST);
      expect(k01Manifest(switched)).toEqual([]);
      // One field apart: the high-stakes pair.
      expect({ ...switched, policy: { ...HAIKU_FIRST, high: Q26_DEFAULT.high } }).toEqual(manifest);
    }
  });

  it("routes every high-stakes fixture Haiku then Sonnet, and every low-stakes one Haiku twice as before, with the same stakes and seeds", () => {
    for (const file of FIXTURE_FILES) {
      const context = contextOf(file);
      const seeds = [11, 12];
      const before = routerOf(bundleOf(context)).route(context, { draw: drawFrom(seeds) });
      const after = routerWith(bundleOf(context), HAIKU_FIRST).route(context, { draw: drawFrom(seeds) });
      expect(after.routing, file).toEqual(
        before.stakes === "high" ? { first: "haiku", second: "sonnet" } : { first: "haiku", second: "haiku" },
      );
      expect(before.routing, file).toEqual(
        before.stakes === "high" ? { first: "sonnet", second: "haiku" } : { first: "haiku", second: "haiku" },
      );
      expect(after.reads.map((read) => read.model)).toEqual([after.routing.first, after.routing.second]);
      // Only the models differ: the turn's stakes, its high choices, the seeds and the orders are the same.
      const rest = (route: typeof before): unknown => ({
        stakes: route.stakes,
        highChoices: route.highChoices,
        reads: route.reads.map((read) => [read.purpose, read.seed, read.choiceOrder]),
        reread: route.reread,
      });
      expect(rest(after)).toEqual(rest(before));
    }
  });

  it("through the AI gateway: a high-stakes turn's first read calls claude-haiku-5-5 and its check claude-sonnet-5-5", async () => {
    const context = contextOf("decide-ask.json");
    const route = routerWith(MINI_A, HAIKU_FIRST).route(context);
    const trace = traceOf(context);
    const first = await readOnWire(context, route.reads[0], trace);
    const check = await readOnWire(context, route.reads[1], trace);
    expect(new Set(first.models)).toEqual(new Set([HAIKU_MODEL]));
    expect(new Set(check.models)).toEqual(new Set([SONNET_MODEL]));
    expect([first.answer.read.model, check.answer.read.model]).toEqual(["haiku", "sonnet"]);
    expect([first.answer.read.role, check.answer.read.role]).toEqual(["first", "check"]);
    expect(
      trace.spans.flatMap((span) => span.model_calls ?? []).map((call) => [call.role, call.purpose]),
    ).toEqual([
      ...first.models.map(() => ["haiku", "decideFirst"]),
      ...check.models.map(() => ["sonnet", "decideCheck"]),
    ]);
  });

  it("the router keeps the policy it was built with: a manifest changed afterwards changes no route", () => {
    const high: { first: ModelRole; second: ModelRole } = { first: "sonnet", second: "haiku" };
    const router = createRouter({ ...manifestOf(MINI_A), policy: { ...Q26_DEFAULT, high } });
    high.first = "haiku";
    expect(router.policy).toEqual(Q26_DEFAULT);
    expect(router.route(contextOf("decide-ask.json")).routing).toEqual({ first: "sonnet", second: "haiku" });
  });
});

describe("no route ever names a model outside the two ids", () => {
  it("the router's model roles and stakes are K-01's modelRole and K-02's stakes", () => {
    const bundleSchema = readJson("contracts/bundle/bundle.v1.schema.json") as {
      $defs: { modelRole: { enum: string[] } };
    };
    const modelSchema = readJson("contracts/model/model.v1.schema.json") as {
      $defs: { stakes: { enum: string[] } };
    };
    expect([...MODEL_ROLES].sort()).toEqual([...bundleSchema.$defs.modelRole.enum].sort());
    expect([...STAKES].sort()).toEqual([...modelSchema.$defs.stakes.enum].sort());
    expect(ALLOWED_MODELS).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("every route of every policy K-01 can write (all 32) over every fixture names haiku or sonnet, as claude-haiku-5-5 or claude-sonnet-5-5", () => {
    expect(ALL_POLICIES).toHaveLength(32);
    let routes = 0;
    for (const policy of ALL_POLICIES) {
      expect(k01Manifest(fullManifest(MINI_A, policy))).toEqual([]);
      for (const file of FIXTURE_FILES) {
        const context = contextOf(file);
        const route = routerWith(bundleOf(context), policy).route(context);
        expect(route.routing).toEqual(policy[route.stakes]);
        expect(route.reads.map((read) => read.model)).toEqual([
          policy[route.stakes].first,
          policy[route.stakes].second,
        ]);
        expect(route.reread.model).toBe(policy.reread);
        for (const named of [...route.reads, route.reread]) {
          expect(MODEL_ROLES).toContain(named.model);
          expect(named.modelId).toBe(idOf(named.model));
          expect(ALLOWED_MODELS as readonly string[]).toContain(named.modelId);
        }
        routes += 1;
      }
    }
    expect(routes).toBe(32 * FIXTURE_FILES.length);
  });

  it("a policy naming any other model, or not shaped as K-01's, is refused before any route, as K-01's own schema refuses it", () => {
    const refused: [string, unknown][] = [
      ["Opus first", { ...Q26_DEFAULT, high: { first: "opus", second: "haiku" } }],
      ["a model id for a role", { ...Q26_DEFAULT, high: { first: "claude-sonnet-5-5", second: "haiku" } }],
      ["another provider's model", { ...Q26_DEFAULT, low: { first: "haiku", second: "gpt-5" } }],
      ["a re-read off the list", { ...Q26_DEFAULT, reread: "claude-opus-4-1" }],
      ["a role in capitals", { ...Q26_DEFAULT, high: { first: "Sonnet", second: "haiku" } }],
      ["an empty role", { ...Q26_DEFAULT, low: { first: "", second: "haiku" } }],
      ["a pair with no check", { ...Q26_DEFAULT, low: { first: "haiku" } }],
      ["a third read", { ...Q26_DEFAULT, high: { first: "sonnet", second: "haiku", third: "haiku" } }],
      ["no re-read", { low: Q26_DEFAULT.low, high: Q26_DEFAULT.high }],
      ["a field K-01 does not have", { ...Q26_DEFAULT, planner: "sonnet" }],
      ["a pair that is a list", { ...Q26_DEFAULT, high: ["sonnet", "haiku"] }],
      ["no policy", null],
    ];
    for (const [why, policy] of refused) {
      expect(policyProblems(policy), why).not.toEqual([]);
      expect(k01Manifest(fullManifest(MINI_A, policy)), why).not.toEqual([]);
      expect(() => createRouter({ ...manifestOf(MINI_A), policy: policy as RoutingPolicy }), why).toThrow(
        RoutingPolicyError,
      );
    }
    // Every problem is named, with the field and the value.
    expect(
      policyProblems({ low: { first: "opus", second: "haiku" }, high: { first: "sonnet" }, reread: "gpt-5" }),
    ).toEqual([
      'policy.low.first is "opus", not haiku or sonnet',
      "policy.high.second is missing, not haiku or sonnet",
      'policy.reread is "gpt-5", not haiku or sonnet',
    ]);
    expect(policyProblems(Q26_DEFAULT)).toEqual([]);
  });

  it("a bundle whose model ids are not the two, or are swapped, or whose id is not K-01's, is refused as the AI gateway refuses it", () => {
    for (const models of [
      { haiku: "claude-opus-4-1", sonnet: SONNET_MODEL },
      { haiku: HAIKU_MODEL, sonnet: "gpt-5" },
      { haiku: SONNET_MODEL, sonnet: HAIKU_MODEL },
      { haiku: "deepinfra/meta-llama", sonnet: SONNET_MODEL },
    ]) {
      expect(() => createRouter({ ...manifestOf(MINI_A), models })).toThrow(GatewayConfigError);
    }
    expect(() => createRouter({ ...manifestOf(MINI_A), bundleId: { hash: "nope", build: 0 } })).toThrow(
      GatewayConfigError,
    );
  });

  it("a route cannot be changed once it is made", () => {
    const route = routerOf(MINI_A).route(contextOf("decide-ask.json"));
    for (const part of [route, route.bundleId, route.routing, route.highChoices, route.reads, route.reread]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    for (const read of route.reads) {
      expect(Object.isFrozen(read)).toBe(true);
      expect(Object.isFrozen(read.choiceOrder)).toBe(true);
    }
    expect(() => {
      (route.reads[0] as { model: string }).model = "opus";
    }).toThrow(TypeError);
    expect(route.reads[0].model).toBe("sonnet");
  });
});

describe("what the router refuses before any call, and what a route holds", () => {
  it("a turn pinned to another bundle: a turn is routed by its own bundle's policy", () => {
    const context = contextOf("decide-ask.json");
    expect(() => routerOf(MINI_B).route(context)).toThrow(RoutingRefusedError);
    expect(() => routerOf(MINI_B).route(context)).toThrow(/another bundle/u);
    expect(() => routerOf(MINI_A).route(context)).not.toThrow();
  });

  it("a turn with no choice, a choice with no stakes or stakes K-02 does not have, or no turn id", () => {
    const base = contextOf("decide-s1-02-choose.json");
    const router = routerOf(V0);
    const broken = (choices: unknown[]): DecideContext =>
      ({ ...structuredClone(base), choices }) as unknown as DecideContext;
    expect(() => router.route(broken([]))).toThrow(/no choice/u);
    const [c01, ...rest] = structuredClone(base.choices) as unknown as Record<string, unknown>[];
    expect(() => router.route(broken([{ ...c01, stakes: "medium" }, ...rest]))).toThrow(
      /choice c-01 has no stakes/u,
    );
    expect(() => router.route(broken([...rest, { ...c01, stakes: undefined }]))).toThrow(
      /choice c-01 has no stakes/u,
    );
    expect(() => router.route(broken([{ ...c01, choiceId: "" }, ...rest]))).toThrow(RoutingRefusedError);
    expect(() => router.route({ ...base, turnId: "" })).toThrow(/no turn id/u);
  });

  it("a seed source that gives a value that is not a seed, first or second", () => {
    const context = contextOf("decide-s1-02-choose.json");
    const router = routerOf(V0);
    for (const bad of [-1, 0.5, SEED_LIMIT + 1, Number.NaN]) {
      expect(() => router.route(context, { draw: () => bad })).toThrow(RoutingRefusedError);
      expect(() => router.route(context, { draw: drawFrom([3, bad]) })).toThrow(RoutingRefusedError);
    }
    expect(() => choiceOrder(["c-01", "c-02"], -1)).toThrow(RoutingRefusedError);
  });

  it("a route holds ids, roles, seeds and stakes: no word of the turn, no name, handle or definition", () => {
    const context = contextOf("decide-hand-off-owner-or-staff.json");
    const route = routerOf(MINI_A).route(context);
    const held = JSON.stringify(route);
    const never = [
      ...context.texts.map((text) => text.words),
      ...context.writer.people.map((person) => person.name),
      context.writer.handle,
      ...context.choices.flatMap((choice) => [choice.label, choice.definition, choice.target.businessName]),
    ];
    for (const value of never) expect(held).not.toContain(value);
  });
});
