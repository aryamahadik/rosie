// T-1396 (the D-017 path audit's P3a): staging binds RootOptions.safetyReaders, deciders and composers (./models.ts),
// inside the Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key MODELS): this file's own database, migrated,
// with bundle v0 published and active and nothing more (no seed module: these readers read no row but a bundle's values),
// reached through its own job pair only, HYPERDRIVE_JOB_MODELS, handed in as the env's HYPERDRIVE_JOB behind a double that
// counts each read of its connection string (ADR-014 section 4). Each root here is built as the Worker's is (../root.ts
// workerRoot: composeRoot over stagingOptions(env)), through the three seams stagingOptions names: its handle (./part.ts
// stagingDb), so a test reads each call's timing line; its fetch seam, behind which the recorded-model double answers
// every model call; and its builders. This card's part is built on two others, and a root here runs those two as they
// are and stands every other part in by its nothing-bound answer (DL-776), so each case holds as the other parts bind:
//   - P2b's own builder (./k05-turn.ts, T-1395): its bundle reads are the ones this card's part is handed, and every
//     PostgreSQL read here is K-05 readBundleValue through them;
//   - P3b's own builder (./bundle-safety.ts, T-1397), only where a case goes through the safety-read port, which awaits
//     that adapter's checked lines before it asks for a reader (../real.ts realSafetyRead). Such a case passes the
//     adapter's check first, as a pin does, and counts the bundle reads made after it: this card's own.
// The actor's BUNDLES KV is a double the test fills as a publish fills it, or leaves empty.
//
// No live model call (J-02; DL-027): the model key is made up for this file, the fetch seam is the double below, and a
// spy on the global fetch counts 0 after every test. The double answers as ../test-support.ts's model doubles do, from
// the recorded-model double (T-004), and tells each request apart on the wire alone: a safety read by its text (the hop
// tests' own recordings, ../test-support.ts skeletonSafetyDouble); a decide read by its per-turn part, which must be a
// recorded context's exactly as @rosie/ai's context builder lays it out on bundle v0 (ai/recordings' recording 2, the
// JOIN run's two reads: T-1145); a composer call by its message, which must be a recorded input's tagged text exactly
// (recording 4, the JOIN run's S1-02 row: T-1175). Anything else is a miss, answered 404.
//
//   - bundle v0, read from PostgreSQL's copy with the KV empty and again from a filled KV: through the ports, the safety
//     read of JOIN answers K-02's No, decide's two reads are recording 2's and the composer's call recording 4's, and each
//     request on the wire is bundle v0's own: its model id, its prompt (named by its version) and, for decide, its rules;
//   - a bundle with prompts of its own gets a reader of its own, whose requests carry that bundle's prompts, never code's;
//   - one build per bundle id; a read in flight is not shared; the key is read by name at each call, never kept;
//   - failing closed: nothing bound (each port's named error), the key left out (ANTHROPIC_API_KEY named, 0 fetches), the
//     bindings left out, a manifest of another bundle id, a manifest with no prompt for the reader, a model id the gateway
//     refuses (the factory rejects before any fetch, and a later call builds again); production builds none;
//   - no span, log line or error holds the text's words, a prompt, a plan's words or the key.
// Test values only (rule 9): the master's sample cast as the fixtures and recordings hold it, and made-up ids and keys.
import joinComposeInput from "@rosie/ai/recordings/composer-inputs/join-s1-02.json";
import composerRecordings from "@rosie/ai/recordings/composer.v1.1.json";
import joinRunContext from "@rosie/ai/recordings/contexts/join-s1-01.json";
import decideRecordings from "@rosie/ai/recordings/recordings.v1.1.json";
import {
  createPromptCache,
  messagesParams,
  sha256Hex,
  systemBlocks,
  type CacheBundle,
  type CacheFlow,
  type CachedPrompt,
  type PromptCache,
} from "@rosie/ai/src/cache/index";
import { composeInputText, type ComposeInput as AiComposeInput } from "@rosie/ai/src/composer/prompt";
import {
  buildContextPrompt,
  unescapeData,
  type DecideContext as AiDecideContext,
} from "@rosie/ai/src/context/index";
import { stageOneTail, stageTwoTail } from "@rosie/ai/src/decide/prompt";
import {
  API_URL,
  GatewayConfigError,
  HAIKU_MODEL,
  KEY_VARIABLE,
  MissingKeyError,
  SONNET_MODEL,
  type FetchLike,
} from "@rosie/ai/src/gateway/index";
import { COMPOSER_KIND } from "@rosie/ai/src/recorded-double/composer-types";
import { createRecordedComposer, createRecordedModel } from "@rosie/ai/src/recorded-double/double";
import { NoRecordingError } from "@rosie/ai/src/recorded-double/errors";
import { requestKey } from "@rosie/ai/src/recorded-double/key";
import { turnStakes, type RoutingContext } from "@rosie/ai/src/routing/index";
import { safetyReadTurn } from "@rosie/ai/src/safety/index";
import planS102 from "@rosie/contracts/message-plan/fixtures/plan-s1-02.json";
import decideS101Enter from "@rosie/contracts/model/fixtures/decide-s1-01-enter.json";
import safetyNo from "@rosie/contracts/model/fixtures/safety-no.json";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi, type Mock } from "vitest";

import bundleV0Kv from "../../../../bundles/v0/bundle.kv.json";
import { keyOf } from "../../bundle/values";
import type { SafetyReadRequest } from "../../safety/types";
import { openTrace, type BundleId, type Span, type TraceContext } from "../../trace";
import type {
  ComposeInput,
  ComposerAnswer,
  DecideAnswer,
  DecideContext,
  DecideResult,
  MessagePlan,
  RereadRequest,
  RewriteRequest,
} from "../../turn/types";
import {
  composeRoot,
  environmentOf,
  NoComposerError,
  NoDeciderError,
  NoSafetyReaderError,
  NotJoinedError,
  workerRoot,
  type BundleReadCalls,
  type Root,
} from "../index";
import { JOIN_TEXT, skeletonSafetyDouble } from "../test-support";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import {
  ModelReaderBundleError,
  NO_MODEL_READER_INPUTS,
  stagingModels,
  type ModelReaderInputs,
} from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { NO_ROW_INPUTS } from "./tool-api-rows";

type Json = Record<string, unknown>;

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "MODELS";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

/** The model key of this file's envs: made up for the run, never Anthropic's. */
const MODEL_KEY = `t1396-made-up-model-key-${crypto.randomUUID()}`;
/** Another made-up key, for the case that changes the key between two calls. */
const OTHER_MODEL_KEY = `t1396-other-made-up-key-${crypto.randomUUID()}`;

/** A trace id of K-08's form, made up: the safety read's text arrives on it. */
const TRACE = "4f1c2b7a-9d3e-4c5f-8a6b-1e2d3c4b5a69";

// ---- bundle v0, as bundles/v0 publishes it and the rig published it in this file's database ---------------------------

function partOfV0(suffix: string): { readonly key: string; readonly value: string } {
  const found = bundleV0Kv.find((part) => part.key.endsWith(suffix));
  if (found === undefined) throw new Error(`bundles/v0 holds no value ending in ${suffix}`);
  return found;
}

const MANIFEST = partOfV0("/manifest");
const FLOW_A = partOfV0("/flow/A");
const [, V0_HASH = "", V0_BUILD = ""] = MANIFEST.key.split("/");
/** Bundle v0's id, read from its manifest's key (K-01 v1: bundle/<hash>/<build>/manifest). */
const V0: BundleId = { hash: V0_HASH, build: Number(V0_BUILD) };
const V0_MANIFEST = JSON.parse(MANIFEST.value) as Json;
const V0_FLOW_A = JSON.parse(FLOW_A.value) as Json;

/** One bundle as a test holds it: its id, its manifest, and its stored values (key and text) as a publish writes them. */
interface TestBundle {
  readonly bundleId: BundleId;
  readonly manifest: Json;
  readonly values: readonly (readonly [string, string])[];
}

const V0_BUNDLE: TestBundle = {
  bundleId: V0,
  manifest: V0_MANIFEST,
  values: [
    [MANIFEST.key, MANIFEST.value],
    [FLOW_A.key, FLOW_A.value],
  ],
};

interface Prompt {
  readonly version: string;
  readonly sha256: string;
  readonly text: string;
}

const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"] as const;
type PromptKind = (typeof PROMPT_KINDS)[number];

/** A manifest's prompt of one kind, as the manifest itself holds it. */
function promptIn(manifest: Json, kind: PromptKind): Prompt {
  const prompt = (manifest.prompts as Partial<Record<PromptKind, Prompt>>)[kind];
  if (prompt === undefined) throw new Error(`the manifest holds no ${kind} prompt`);
  return prompt;
}

const modelsIn = (manifest: Json): { haiku: string; sonnet: string } =>
  manifest.models as { haiku: string; sonnet: string };

/**
 * A bundle of bundle v0's flow A under a build of its own, its manifest v0's with `change` applied: a K-01 id (the hash
 * is of the stored values' lines, so v0's, under a build no publish of v0 used) the tests hold in the KV double alone.
 */
function variantOf(build: number, change: (manifest: Json) => void): TestBundle {
  const bundleId: BundleId = { hash: V0.hash, build };
  const manifest = structuredClone(V0_MANIFEST);
  const storage = manifest.storage as { values: Json[] };
  manifest.bundleId = { ...bundleId };
  manifest.storage = {
    manifestKey: keyOf(bundleId, "manifest"),
    values: storage.values.map((value) => ({ ...value, key: keyOf(bundleId, "flow/A") })),
  };
  change(manifest);
  return {
    bundleId,
    manifest,
    values: [
      [keyOf(bundleId, "manifest"), JSON.stringify(manifest)],
      [keyOf(bundleId, "flow/A"), FLOW_A.value],
    ],
  };
}

/** Bundle v0 with prompts of its own: each of v0's with one line added, under its own version and sha256. */
const OWN_PROMPTS = variantOf(41, (manifest) => {
  manifest.prompts = Object.fromEntries(
    PROMPT_KINDS.map((kind) => {
      const prompt = promptIn(manifest, kind);
      const text = `${prompt.text}\n\n<bundle_note>t1396: this bundle's own ${kind} prompt.</bundle_note>`;
      return [kind, { version: `${prompt.version}-t1396`, sha256: sha256Hex(text), text }];
    }),
  );
});

/** Bundle v0 with one prompt left out of its manifest, by the prompt's kind. */
const withoutPrompt = (build: number, kind: PromptKind): TestBundle =>
  variantOf(build, (manifest) => {
    manifest.prompts = Object.fromEntries(
      PROMPT_KINDS.filter((each) => each !== kind).map((each) => [each, promptIn(manifest, each)]),
    );
  });

const NO_PROMPT: Readonly<Record<"safetyRead" | "decide" | "composer", TestBundle>> = {
  safetyRead: withoutPrompt(51, "safetyRead"),
  decide: withoutPrompt(52, "decide"),
  composer: withoutPrompt(53, "composer"),
};

/** Bundle v0 with a composer prompt of spaces alone, under that text's own sha256. */
const BLANK_COMPOSER_PROMPT = variantOf(54, (manifest) => {
  const text = "  \n";
  manifest.prompts = {
    ...(manifest.prompts as Json),
    composer: { version: "composer-blank-t1396", sha256: sha256Hex(text), text },
  };
});

/** A model id the AI gateway refuses: neither of its two. */
const REFUSED_MODEL = "model-t1396-not-allowed";
const REFUSED_MODEL_BUNDLE = variantOf(61, (manifest) => {
  manifest.models = { ...modelsIn(manifest), haiku: REFUSED_MODEL };
});

/** Bundle v0 with no models in its manifest. */
const NO_MODELS_BUNDLE = variantOf(62, (manifest) => {
  delete manifest.models;
});

/** A bundle the cases that swap a wrong copy for the right one use: v0's own parts, under a build of its own. */
const LATER_BUNDLE = variantOf(71, () => undefined);

// ---- the JOIN run's recordings (ai/recordings; T-1145, T-1175) ---------------------------------------------------------

/** Recording 2's request: the JOIN run's own context (K-02 README "v1.1"), on bundle v0's id and rules. */
const JOIN_CONTEXT = joinRunContext as unknown as DecideContext;
/** Recording 4's request: the JOIN run's S1-02 row. */
const JOIN_INPUT = joinComposeInput as unknown as ComposeInput;
/** K-03's plan-s1-02.json: recording 4's answer. */
const PLAN_S1_02 = planS102 as unknown as MessagePlan;

interface RecordingSpec {
  readonly id: string;
  readonly kind: string;
  readonly request: {
    readonly context?: { readonly file?: string };
    readonly role?: string;
    readonly file?: string;
  };
  readonly output?: unknown;
  readonly seed?: { readonly fixture: string };
}

/** Recording 2's two reads, as ai/recordings writes them: the first and the check read on the JOIN run's context. */
const JOIN_READS = (decideRecordings as unknown as { recordings: RecordingSpec[] }).recordings.filter(
  (spec) => spec.kind === "decideRead" && spec.request.context?.file === "contexts/join-s1-01.json",
);
/** Recording 4, as ai/recordings writes it: the JOIN run's composer input, seeded from plan-s1-02.json. */
const JOIN_PLAN = (composerRecordings as unknown as { recordings: RecordingSpec[] }).recordings.filter(
  (spec) =>
    spec.request.file === "composer-inputs/join-s1-02.json" && spec.seed?.fixture === "plan-s1-02.json",
);
const JOIN_READ_IDS = ["decide-s1-01-join-first", "decide-s1-01-join-check"];
const JOIN_PLAN_ID = "composer-join-s1-02";

// ---- what a request must be on the wire, laid out from the bundle's own files by @rosie/ai's own layout ----------------

/** A bundle's prompt layout, made here from the bundle's manifest and bundle v0's flow A: the oracle, never ./models.ts. */
const layoutOf = (bundle: TestBundle): PromptCache =>
  createPromptCache({
    manifest: bundle.manifest as unknown as CacheBundle["manifest"],
    flows: { A: V0_FLOW_A as unknown as CacheFlow },
  });

/** The part of a Messages API request these tests compare: the model asked, the system blocks and the user message. */
interface Wire {
  readonly model: unknown;
  readonly system: unknown;
  readonly messages: unknown;
}

const wireFor = (bundle: TestBundle, prompt: CachedPrompt, tail: string | null = null): Wire => ({
  model: modelsIn(bundle.manifest).haiku,
  system: systemBlocks(prompt),
  messages: [{ role: "user", content: tail === null ? prompt.turn : `${prompt.turn}\n\n${tail}` }],
});

/** The safety read of JOIN under a bundle: its safety read prompt as the cached system prompt, the text after it. */
function safetyWire(bundle: TestBundle): Wire {
  const turn = safetyReadTurn({ source: "text", text: JOIN_TEXT, subject: null });
  const prompt = layoutOf(bundle).layout({ purpose: "safetyRead", turn });
  expect(messagesParams(prompt).system).toEqual(systemBlocks(prompt));
  return wireFor(bundle, prompt);
}

/**
 * A context's decide read under a bundle: the decide prompt and the flow's rules as the cached system prompt, the
 * per-turn part with the step's tail after it. The context offers one choice, so every seed lists it the same way.
 */
function decidePrompt(bundle: TestBundle, context: DecideContext): CachedPrompt {
  expect(context.choices).toHaveLength(1);
  const built = buildContextPrompt(layoutOf(bundle), context as unknown as AiDecideContext, {
    purpose: "decideFirst",
    seed: 0,
  });
  return built.prompt;
}

/** A row's composer call under a bundle: the composer prompt as the cached system prompt, the row's tagged input after it. */
function composeWire(bundle: TestBundle, input: ComposeInput): Wire {
  const turn = composeInputText(input as unknown as AiComposeInput);
  return wireFor(bundle, layoutOf(bundle).layout({ purpose: "compose", turn }));
}

/** The JOIN run's per-turn part on bundle v0, as the context builder lays it out: what the double keys a decide read on. */
const JOIN_TURN = decidePrompt(V0_BUNDLE, JOIN_CONTEXT).turn;
/** Step 1's answer for recording 2's reads: the one part, entered. */
const JOIN_PARTS = [{ quote: "JOIN", verb: "enter" }] as const;

// ---- the recorded-model double behind the fetch seam -------------------------------------------------------------------

/** One Messages API request the double was sent, as it arrived. */
interface ModelRequest {
  readonly url: string;
  /** The x-api-key header's value. */
  readonly key: string | null;
  readonly kind: "safetyRead" | "decide" | "compose" | "unknown";
  /** A decide read's step (two-step wire form), else null. */
  readonly step: number | null;
  /** The recordings that answered it, by id (a safety read's by its text); none for a miss. */
  readonly recordings: string[];
  readonly wire: Wire;
}

interface ModelDouble {
  /** What stagingOptions is handed as its fetch seam. */
  readonly fetch: FetchLike;
  readonly requests: ModelRequest[];
  /** Every request the double holds no recording for. */
  readonly misses: string[];
}

/** The words of a safety read's <text> element (ai/src/safety/prompt.ts safetyReadTurn), escaped as data. */
const TEXT_ELEMENT = /^<text source="(?:text|page|agent)">([\s\S]*)<\/text>$/u;
/** The step a decide request asks for, from its user message's last tag (T-368's two-step wire form). */
const STEP_TAG = /<step n="([12])"(?: part="([0-9]+)")?><\/step>$/u;

/** The token counts each recorded answer reports. */
const USAGE = {
  input_tokens: 40,
  output_tokens: 60,
  cache_read_input_tokens: 1800,
  cache_creation_input_tokens: 0,
};

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One step's answer from a K-02 read, as the model splits it: step 1 the parts' quotes and verbs; step 2 a part's fields. */
function stepAnswer(read: unknown, step: number, part: number): unknown {
  const parts: unknown[] = isRecord(read) && Array.isArray(read.parts) ? (read.parts as unknown[]) : [];
  if (step === 1) {
    return {
      language: isRecord(read) ? read.language : null,
      parts: parts.map((each) => (isRecord(each) ? { quote: each.quote, verb: each.verb } : each)),
    };
  }
  const asked = parts[part - 1];
  if (!isRecord(asked) || asked.verb === "no_op") return undefined;
  return Object.fromEntries(Object.entries(asked).filter(([key]) => key !== "verb" && key !== "quote"));
}

/**
 * The recorded-model double as a fake Messages API (the top of this file): the hop tests' safety recordings, recording
 * 2's two decide reads and recording 4's plan, each keyed as T-004's loader keys it, each request told apart on the wire.
 */
function modelDouble(): ModelDouble {
  const requests: ModelRequest[] = [];
  const misses: string[] = [];
  const safety = skeletonSafetyDouble();
  const decideHeld = new Map<string, { output: unknown }>();
  const decideIds = new Map<string, string>();
  for (const spec of JOIN_READS) {
    const key = requestKey("decideRead", { context: joinRunContext, role: spec.request.role });
    decideHeld.set(key, { output: structuredClone(spec.output) });
    decideIds.set(key, spec.id);
  }
  const decide = createRecordedModel(decideHeld);
  const composerHeld = new Map<string, { output: unknown }>();
  const composing = new Map<string, { readonly id: string; readonly input: unknown }>();
  for (const spec of JOIN_PLAN) {
    composerHeld.set(requestKey(COMPOSER_KIND, joinComposeInput), { output: structuredClone(planS102) });
    composing.set(composeInputText(joinComposeInput as unknown as AiComposeInput), {
      id: spec.id,
      input: joinComposeInput,
    });
  }
  const composer = createRecordedComposer(composerHeld);
  const policy = V0_MANIFEST.policy as Record<
    string,
    { first: "haiku" | "sonnet"; second: "haiku" | "sonnet" }
  >;

  const answered = (output: unknown): Response =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: USAGE,
      }),
      { status: 200 },
    );
  const miss = (why: string): Response => {
    misses.push(why);
    return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error" } }), {
      status: 404,
    });
  };

  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Json;
    const model = typeof body.model === "string" ? body.model : "";
    const first: unknown = Array.isArray(body.messages) ? (body.messages as unknown[])[0] : undefined;
    const content = isRecord(first) && typeof first.content === "string" ? first.content : "";
    const step = STEP_TAG.exec(content);
    const text = TEXT_ELEMENT.exec(content);
    const row = composing.get(content);
    const recordings: string[] = [];
    // Kept as it arrives, before anything is awaited, so the requests are in the order they were sent.
    requests.push({
      url,
      key: new Headers(init.headers).get("x-api-key"),
      kind:
        step !== null ? "decide" : row !== undefined ? "compose" : text !== null ? "safetyRead" : "unknown",
      step: step === null ? null : Number(step[1]),
      recordings,
      wire: { model: body.model, system: body.system, messages: body.messages },
    });

    if (step !== null) {
      // A decide read: its per-turn part must be the recorded context's own, laid out on bundle v0.
      if (!content.startsWith(`${JOIN_TURN}\n\n`)) return miss("a decide request of no recorded context");
      const { stakes } = turnStakes(joinRunContext as unknown as RoutingContext);
      const pair = policy[stakes];
      const models = modelsIn(V0_MANIFEST);
      const roles = [
        ...(pair !== undefined && models[pair.first] === model ? ["first"] : []),
        ...(pair !== undefined && models[pair.second] === model ? ["check"] : []),
      ];
      if (roles.length === 0)
        return miss(`a decide request on ${model}, which the turn's route asks for no read`);
      const answers: unknown[] = [];
      for (const role of roles) {
        const request = { context: joinRunContext, role };
        try {
          const read = await decide.decide(request as Parameters<typeof decide.decide>[0]);
          answers.push(stepAnswer(read, Number(step[1]), Number(step[2] ?? "1")));
        } catch (error) {
          if (error instanceof NoRecordingError) return miss(`no ${role} read is recorded for the context`);
          throw error;
        }
        recordings.push(decideIds.get(requestKey("decideRead", request)) ?? "");
      }
      if (new Set(answers.map((answer) => JSON.stringify(answer ?? null))).size !== 1) {
        return miss("both reads ask alike, but their recordings answer otherwise");
      }
      return answers[0] === undefined
        ? miss("a step of a part its read does not have")
        : answered(answers[0]);
    }
    if (row !== undefined) {
      // A composer call: its message is exactly a recorded input's tagged text.
      const plan = await composer.composer(row.input as Parameters<typeof composer.composer>[0]);
      recordings.push(row.id);
      return answered(plan);
    }
    if (text !== null) {
      try {
        const words = unescapeData(text[1] ?? "");
        const read = await safety.safetyRead({ text: words });
        recordings.push(`safetyRead:${words}`);
        return answered(read);
      } catch (error) {
        if (error instanceof NoRecordingError) return miss("no safety read is recorded for the text");
        throw error;
      }
    }
    return miss("a request that is no safety read, decide read or composer call of a recording");
  };
  return { fetch, requests, misses };
}

/** The manifest prompt a request's system prompt starts with, by its text, as `<kind>@<version>`: the bundle's own. */
function promptNamed(request: ModelRequest, bundle: TestBundle): string | null {
  const blocks: unknown[] = Array.isArray(request.wire.system) ? (request.wire.system as unknown[]) : [];
  const [first] = blocks;
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
  for (const kind of PROMPT_KINDS) {
    const prompt = promptIn(bundle.manifest, kind);
    if (text.startsWith(prompt.text)) return `${kind}@${prompt.version}`;
  }
  return null;
}

// ---- the actor's BUNDLES KV, as a double --------------------------------------------------------------------------------

interface KvDouble {
  /** The double as the env's BUNDLES binding. */
  readonly binding: KVNamespace;
  readonly held: Map<string, string>;
  /** Each key asked, in order. */
  readonly gets: string[];
  /** Holds every value of these bundles, as a publish writes them. */
  fill(...bundles: readonly TestBundle[]): void;
}

function kvDouble(): KvDouble {
  const held = new Map<string, string>();
  const gets: string[] = [];
  const binding = {
    get(key: string): Promise<string | null> {
      gets.push(key);
      return Promise.resolve(held.get(key) ?? null);
    },
  };
  return {
    binding: binding as unknown as KVNamespace,
    held,
    gets,
    fill(...bundles) {
      for (const bundle of bundles) for (const [key, text] of bundle.values) held.set(key, text);
    },
  };
}

// ---- what the whole file captures: every span and every log line ------------------------------------------------------

/** Every span a test's trace wrote, and every line written to the console or as a call's timing, across the file. */
const SPANS: Span[] = [];
const LOGGED: string[] = [];
/** Every error a failing call threw, across the file. */
const THROWN: unknown[] = [];

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

// ---- the env a root is built over -------------------------------------------------------------------------------------

/** A double over a pool binding that counts the reads of its connection string, and gives the pool binding's. */
interface CountedBinding {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

function counted(binding: Hyperdrive): CountedBinding {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

interface TestEnv {
  readonly env: StagingEnv;
  /** The env's own values, which a test may change between two calls (a binding taken out, the key changed). */
  readonly values: Record<string, unknown>;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
  /** The counting double handed in as HYPERDRIVE_JOB; null where the env has none. */
  readonly job: CountedBinding | null;
  /** The counting double handed in as HYPERDRIVE_APP, in every env. */
  readonly app: CountedBinding;
  readonly kv: KvDouble | null;
}

interface EnvOptions {
  readonly environment?: string;
  /** False: no HYPERDRIVE_JOB. Default: this file's own. */
  readonly job?: boolean;
  /** The BUNDLES double (default: an empty one); null for no BUNDLES binding. */
  readonly kv?: KvDouble | null;
  /** The model key (default: this file's made-up one); null for none set. */
  readonly key?: string | null;
}

/** Every env a test built and every handle: checked after each test. */
const ENVS: TestEnv[] = [];
const HANDLES: StagingDb[] = [];

/** The Worker's env as wrangler.jsonc's vars give it, with this file's pair behind counting doubles. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const job = options.job === false ? null : counted(poolBinding(JOB));
  const app = counted(poolBinding(APP));
  const kv = options.kv === undefined ? kvDouble() : options.kv;
  const key = options.key === undefined ? MODEL_KEY : options.key;
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    HYPERDRIVE_APP: app.binding,
    ...(kv === null ? {} : { BUNDLES: kv.binding }),
    ...(key === null ? {} : { [KEY_VARIABLE]: key }),
  };
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  const made: TestEnv = { env: env as unknown as StagingEnv, values, names, job, app, kv };
  ENVS.push(made);
  return made;
}

/** How often a name was read from an env. */
const readsOf = (testEnv: TestEnv, name: string): number =>
  testEnv.names.filter((each) => each === name).length;

/**
 * Every part but this card's and the two it is built on, stood in by its nothing-bound answer (each stub's own, as T-1257
 * made it): a root built with these runs P2b's bundle reads and this card's readers, whatever the other parts bind.
 */
const OTHER_PARTS_UNBOUND: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  gate: () => null,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  testPhone: () => null,
  copies: () => null,
};

interface Rooted {
  readonly root: Root;
  /** What stagingOptions gave the root: each part's input. */
  readonly inputs: StagingInputs;
  readonly testEnv: TestEnv;
  readonly models: ModelDouble;
  /** Each call's timing line the handle wrote, in order. */
  readonly lines: () => DbCallLine[];
  /** Where the bundle reads stand now, and the bundle reads made since a mark: the KV's keys asked and K-05's calls. */
  readonly mark: () => ReadMark;
  readonly since: (mark: ReadMark) => BundleReads;
}

interface ReadMark {
  readonly gets: number;
  readonly lines: number;
}

interface BundleReads {
  readonly kv: string[];
  readonly postgres: (string | null)[];
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env)), over the test's env, its handle's
 * timing lines kept and the recorded-model double behind its fetch seam. `safetyLines`: P3b's own builder too, for a case
 * through the safety-read port; else no safety lines, and the root shows this card's readers over P2b's reads alone.
 */
function rootOver(testEnv: TestEnv, options: { readonly safetyLines?: boolean } = {}): Rooted {
  const written: string[] = [];
  const db = stagingDb(testEnv.env, {
    write: (line) => {
      written.push(line);
      LOGGED.push(line);
    },
  });
  HANDLES.push(db);
  const models = modelDouble();
  const inputs = stagingOptions(testEnv.env, {
    db,
    fetch: models.fetch,
    builders:
      options.safetyLines === true
        ? OTHER_PARTS_UNBOUND
        : { ...OTHER_PARTS_UNBOUND, bundleSafety: () => null },
  });
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: testEnv.env,
    ...inputs,
  });
  const lines = (): DbCallLine[] => written.map((line) => JSON.parse(line) as DbCallLine);
  return {
    root,
    inputs,
    testEnv,
    models,
    lines,
    mark: () => ({ gets: testEnv.kv?.gets.length ?? 0, lines: written.length }),
    since: (mark) => ({
      kv: testEnv.kv?.gets.slice(mark.gets) ?? [],
      postgres: lines()
        .slice(mark.lines)
        .map((line) => line.call),
    }),
  };
}

/** An input stagingOptions bound, or the test fails naming it. */
function boundOf<T>(input: T | null | undefined, name: string): T {
  if (input === null || input === undefined) throw new Error(`staging bound no ${name}`);
  return input;
}

/**
 * Passes P3b's check of a bundle on a root, as a pin does, so the safety-read port has its lines; the bundle reads made
 * from the mark it answers are this card's own.
 */
async function withCheckedLines(rooted: Rooted, bundleId: BundleId): Promise<ReadMark> {
  await boundOf(rooted.inputs.bundleSafety, "bundleSafety").checkPin({
    bundleId,
    bundles: rooted.root.ports.bundles,
  });
  return rooted.mark();
}

// ---- the calls --------------------------------------------------------------------------------------------------------

/** The safety read's request for the JOIN text, under a bundle. */
function safetyRequest(bundleId: BundleId): SafetyReadRequest {
  return {
    eventId: "evt-sam-0000",
    source: "text",
    traceId: TRACE,
    bundleId: { ...bundleId },
    words: { body: JOIN_TEXT, subject: null },
  };
}

/** A turn's trace under a bundle, its spans kept. */
function traceUnder(bundleId: BundleId, turnId: string, spans: Span[] = []): TraceContext {
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: { ...bundleId },
    sink: (span) => {
      spans.push(span);
      SPANS.push(span);
    },
  });
  trace.setTurn(turnId);
  return trace;
}

/** The JOIN run's context, under a bundle. */
const contextUnder = (bundleId: BundleId): DecideContext => ({
  ...structuredClone(JOIN_CONTEXT),
  bundleId: { ...bundleId },
});

/** decide-s1-01-enter.json's result for a turn of its own, its reads' quote the turn's own words (recording 2's answer). */
function enterResultFor(context: DecideContext, quote: string): DecideResult {
  const enter = structuredClone(decideS101Enter) as unknown as DecideResult;
  const requoted = <T extends { readonly quote: string }>(part: T): T => ({ ...part, quote });
  return {
    ...enter,
    turnId: context.turnId,
    bundleId: context.bundleId,
    reads: enter.reads.map((read) => {
      const output = read.output as { parts: { quote: string }[] };
      return { ...read, output: { ...output, parts: output.parts.map(requoted) } };
    }),
    parts: enter.parts.map((part) => ({ ...part, part: requoted(part.part) })),
  };
}

function decidedOf(answer: DecideAnswer): Extract<DecideAnswer, { result: "decided" }> {
  if (!("result" in answer)) throw new Error(`decide answered ${answer.error}`);
  return answer;
}

function plannedOf(answer: ComposerAnswer): Extract<ComposerAnswer, { result: "planned" }> {
  if (!("result" in answer)) throw new Error(`the composer answered ${answer.error}`);
  return answer;
}

/** A model call's own span: a portCall to provider anthropic, one per attempt (the AI gateway's and the safety read's). */
const modelCall = (span: Span): boolean => span.hop === "portCall" && span.provider === "anthropic";

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    THROWN.push(error);
    return error;
  }
  throw new Error("expected the call to fail");
}

/** Each of the three port calls on a root, under a bundle: the safety read, decide and the composer's call. */
function portCalls(root: Root, bundleId: BundleId): readonly (readonly [string, () => Promise<unknown>])[] {
  const context = contextUnder(bundleId);
  const input = structuredClone(JOIN_INPUT);
  return [
    ["safetyRead", () => root.ports.safetyRead.read(safetyRequest(bundleId))],
    ["decide", () => root.ports.decide.decide(context, traceUnder(bundleId, context.turnId))],
    ["composer", () => root.ports.composer.compose(input, traceUnder(bundleId, input.turn))],
  ];
}

/** Each of the three factories, by its reader's name, with the bundle parts its build reads. */
function factoriesOf(
  inputs: ModelReaderInputs,
): readonly (readonly ["safetyRead" | "decide" | "composer", (bundleId: BundleId) => Promise<unknown>])[] {
  const safetyReaders = boundOf(inputs.safetyReaders, "safetyReaders");
  const deciders = boundOf(inputs.deciders, "deciders");
  const composers = boundOf(inputs.composers, "composers");
  return [
    ["safetyRead", (bundleId) => Promise.resolve(safetyReaders(bundleId))],
    ["decide", (bundleId) => Promise.resolve(deciders(bundleId))],
    ["composer", (bundleId) => Promise.resolve(composers(bundleId))],
  ];
}

/**
 * The texts an error gives away: its message, its stack but for the frames (code locations), its own fields as JSON, each
 * own property's value, and the error as a string.
 */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  const fields = error as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyNames(error)
    .filter((name) => name !== "stack")
    .map((name) => {
      const text = JSON.stringify(fields[name]) as string | undefined;
      return text ?? "";
    });
  return [error.message, stack, JSON.stringify(error), String(error), ...own];
}

/** Every string of several words in a JSON value: a plan's lines, an input's facts and master text. */
function wordsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim().includes(" ") && value.length >= 12) into.push(value);
  } else if (Array.isArray(value)) {
    for (const each of value as unknown[]) wordsIn(each, into);
  } else if (isRecord(value)) {
    for (const each of Object.values(value)) wordsIn(each, into);
  }
  return into;
}

/**
 * What no span, log line or error may hold: the model keys; the text's words; the start of each prompt of each bundle
 * here and of bundle v0's rules; and the words of the plan and of the composer's input.
 */
const NEVER_LOGGED: readonly string[] = [
  MODEL_KEY,
  OTHER_MODEL_KEY,
  JOIN_TEXT,
  ...[V0_BUNDLE, OWN_PROMPTS].flatMap((bundle) =>
    PROMPT_KINDS.flatMap((kind) => {
      const { text } = promptIn(bundle.manifest, kind);
      return [text.slice(0, 60), text.slice(-60)];
    }),
  ),
  (V0_FLOW_A.routing as { alwaysOn: { prefixText: string } }).alwaysOn.prefixText.slice(0, 60),
  ...wordsIn(planS102),
  ...wordsIn(joinComposeInput),
];

/** No text holds a key, the text's words, a prompt's or a plan's words. */
function expectNoWords(texts: readonly string[]): void {
  for (const text of texts) {
    for (const words of NEVER_LOGGED) {
      expect(text.includes(words), "a text holds a key, the text's words, a prompt or a plan's words").toBe(
        false,
      );
    }
  }
}

let globalFetch: Mock;

beforeEach(() => {
  const keep = (...args: unknown[]): void => {
    LOGGED.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  // A root's own spans (the safety read's model calls) and P3b's check lines go to console.log.
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  // No live call, ever: every model call goes through the fetch seam, so the global fetch is never reached.
  globalFetch = vi.fn(() => Promise.reject(new Error("a live call was made")));
  vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // T-1254's counter: every client a bundle read opened was ended.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // The job side only: HYPERDRIVE_APP's connection string is never read for a bundle read, and no binding named
  // HYPERDRIVE is read at all.
  for (const made of ENVS) {
    expect(made.app.reads.n).toBe(0);
    expect(made.names).not.toContain("HYPERDRIVE");
  }
});

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database on the rig, and the recordings", () => {
  it("is this run's own; bundle v0's id is the JOIN run's, and the recordings are recording 2's two reads and recording 4", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_models$/u);
    expect(V0.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(MANIFEST.key).toBe(keyOf(V0, "manifest"));
    expect(FLOW_A.key).toBe(keyOf(V0, "flow/A"));
    expect(bundleV0Kv.map((part) => part.key).sort()).toEqual([FLOW_A.key, MANIFEST.key].sort());
    // The recordings are keyed on bundle v0 as bundles/v0 publishes it: the JOIN run's context names its id and rules.
    expect(JOIN_CONTEXT.bundleId).toEqual(V0);
    expect(JOIN_READS.map((spec) => [spec.id, spec.request.role])).toEqual([
      ["decide-s1-01-join-first", "first"],
      ["decide-s1-01-join-check", "check"],
    ]);
    expect(JOIN_PLAN.map((spec) => spec.id)).toEqual([JOIN_PLAN_ID]);
    // Bundle v0's manifest holds what the readers are built from: the gateway's two model ids and its own prompts.
    expect(modelsIn(V0_MANIFEST)).toEqual({ haiku: HAIKU_MODEL, sonnet: SONNET_MODEL });
    for (const kind of PROMPT_KINDS) {
      const prompt = promptIn(V0_MANIFEST, kind);
      expect(prompt.version, kind).toMatch(/\S/u);
      expect(sha256Hex(prompt.text), kind).toBe(prompt.sha256);
    }
    // The made-up key is in no bundle and no recording.
    expect(MANIFEST.value.includes(MODEL_KEY) || FLOW_A.value.includes(MODEL_KEY)).toBe(false);
  });
});

// ---- bundle v0 through the ports, from each copy ------------------------------------------------------------------------

describe.each([
  ["PostgreSQL's copy, with the KV empty", "postgres"],
  ["a filled KV", "kv"],
] as const)("bundle v0, read from %s", (_from, source) => {
  /** A root over a KV that holds bundle v0 (a filled KV) or nothing (every value from PostgreSQL's copy). */
  function made(options: { readonly safetyLines?: boolean } = {}): Rooted {
    const kv = kvDouble();
    if (source === "kv") kv.fill(V0_BUNDLE);
    return rootOver(envOf({ kv }), options);
  }

  /** The bundle reads a build made for these parts: the KV asked first for each, then K-05 on a miss. */
  const readsFor = (...keys: string[]): BundleReads => ({
    kv: keys,
    postgres: source === "postgres" ? keys.map(() => "readBundleValue") : [],
  });

  it("the safety read of the JOIN text, through the port over P3b's checked lines, answers K-02's No as the hop tests' recording gives it; its one request is bundle v0's: Haiku's id, its safety read prompt, the text after it, the key in x-api-key", async () => {
    const rooted = made({ safetyLines: true });
    const mark = await withCheckedLines(rooted, V0);

    const answer = await rooted.root.ports.safetyRead.read(safetyRequest(V0));

    expect(answer.result).toEqual({
      eventId: "evt-sam-0000",
      source: "text",
      tries: [{ model: "haiku", result: "verdict" }],
      read: safetyNo.read,
      timedOut: false,
      dangerWords: [],
      outcomes: ["No"],
      liftedToUnsure: false,
    });
    expect(answer.modelCalls.map((call) => [call.model, call.role, call.purpose, call.outcome])).toEqual([
      [HAIKU_MODEL, "haiku", "safetyRead", "ok"],
    ]);
    // The one model call, through the fetch seam to the double, answered from the recording of the text it carried.
    const { requests, misses } = rooted.models;
    expect(misses).toEqual([]);
    expect(requests.map((request) => [request.url, request.kind, request.recordings])).toEqual([
      [API_URL, "safetyRead", [`safetyRead:${JOIN_TEXT}`]],
    ]);
    expect(requests.map((request) => request.key)).toEqual([MODEL_KEY]);
    // Bundle v0's own: its Haiku id and its safety read prompt, named by its version, exactly as its layout writes it.
    expect(requests.map((request) => request.wire)).toEqual([safetyWire(V0_BUNDLE)]);
    expect(requests.map((request) => [request.wire.model, promptNamed(request, V0_BUNDLE)])).toEqual([
      [modelsIn(V0_MANIFEST).haiku, `safetyRead@${promptIn(V0_MANIFEST, "safetyRead").version}`],
    ]);
    // This card's own bundle read for the reader: the manifest alone, the KV first.
    expect(rooted.since(mark)).toEqual(readsFor(MANIFEST.key));
  });

  it("decide, through the port: the JOIN run's context is decided by recording 2's two reads, each request the context's own layout on bundle v0 with its decide prompt and rules, on Haiku; K-02's result agrees with no re-read", async () => {
    const rooted = made();
    const context = contextUnder(V0);
    const spans: Span[] = [];
    const mark = rooted.mark();

    const answer = decidedOf(
      await rooted.root.ports.decide.decide(context, traceUnder(V0, context.turnId, spans)),
    );

    expect(answer.decide).toEqual(enterResultFor(context, "JOIN"));
    expect(answer.decide).toMatchObject({ agreed: true, reread: false, stakes: "low" });
    expect(answer.modelCalls.map((call) => [call.model, call.role, call.purpose])).toEqual([
      [HAIKU_MODEL, "haiku", "decideFirst"],
      [HAIKU_MODEL, "haiku", "decideFirst"],
      [HAIKU_MODEL, "haiku", "decideCheck"],
      [HAIKU_MODEL, "haiku", "decideCheck"],
    ]);
    // Each read is decide's one read: step 1, then step 2 of its one part, each answered from recording 2's two reads.
    const { requests, misses } = rooted.models;
    expect(misses).toEqual([]);
    expect(requests.map((request) => [request.url, request.kind, request.step, request.recordings])).toEqual([
      [API_URL, "decide", 1, JOIN_READ_IDS],
      [API_URL, "decide", 1, JOIN_READ_IDS],
      [API_URL, "decide", 2, JOIN_READ_IDS],
      [API_URL, "decide", 2, JOIN_READ_IDS],
    ]);
    expect(new Set(requests.map((request) => request.key))).toEqual(new Set([MODEL_KEY]));
    // Each request on the wire equals the recording's: the JOIN run's context laid out on bundle v0, under v0's decide
    // prompt and flow A's rules, with the step's tail.
    const prompt = decidePrompt(V0_BUNDLE, context);
    const stepOne = wireFor(V0_BUNDLE, prompt, stageOneTail());
    const stepTwo = wireFor(V0_BUNDLE, prompt, stageTwoTail(JOIN_PARTS, 0));
    expect(requests.map((request) => request.wire)).toEqual([stepOne, stepOne, stepTwo, stepTwo]);
    expect(new Set(requests.map((request) => promptNamed(request, V0_BUNDLE)))).toEqual(
      new Set([`decide@${promptIn(V0_MANIFEST, "decide").version}`]),
    );
    expect(new Set(requests.map((request) => request.wire.model))).toEqual(
      new Set([modelsIn(V0_MANIFEST).haiku]),
    );
    // The reads for the decider: the manifest and the flow graph it lists.
    expect(rooted.since(mark)).toEqual(readsFor(MANIFEST.key, FLOW_A.key));
    // The spans: the AI gateway's portCall per attempt, on the turn's trace and bundle; nothing else.
    expect(spans.filter((span) => !modelCall(span))).toEqual([]);
    expect(spans.map((span) => [span.bundle_id, span.turn_id, span.outcome])).toEqual(
      Array.from({ length: 4 }, () => [V0, context.turnId, "ok"]),
    );
  });

  it("the composer, through the port: the JOIN run's S1-02 row is composed by one Haiku call whose request equals recording 4's, under bundle v0's composer prompt, and answers plan-s1-02.json's plan (DL-414)", async () => {
    const rooted = made();
    const input = structuredClone(JOIN_INPUT);
    const spans: Span[] = [];
    const mark = rooted.mark();

    const answer = plannedOf(
      await rooted.root.ports.composer.compose(input, traceUnder(V0, input.turn, spans)),
    );

    expect(answer.plan).toEqual(PLAN_S1_02);
    expect(answer.modelCalls.map((call) => [call.model, call.role, call.purpose, call.outcome])).toEqual([
      [HAIKU_MODEL, "haiku", "compose", "ok"],
    ]);
    const { requests, misses } = rooted.models;
    expect(misses).toEqual([]);
    expect(requests.map((request) => [request.url, request.kind, request.recordings, request.key])).toEqual([
      [API_URL, "compose", [JOIN_PLAN_ID], MODEL_KEY],
    ]);
    expect(requests.map((request) => request.wire)).toEqual([composeWire(V0_BUNDLE, input)]);
    expect(requests.map((request) => [request.wire.model, promptNamed(request, V0_BUNDLE)])).toEqual([
      [modelsIn(V0_MANIFEST).haiku, `composer@${promptIn(V0_MANIFEST, "composer").version}`],
    ]);
    // The reads for the composer: the manifest alone.
    expect(rooted.since(mark)).toEqual(readsFor(MANIFEST.key));
    expect(spans.filter((span) => !modelCall(span))).toEqual([]);
    expect(spans.map((span) => [span.bundle_id, span.turn_id, span.outcome])).toEqual([
      [V0, input.turn, "ok"],
    ]);
  });
});

describe("with no BUNDLES binding at all", () => {
  it("every value is read from PostgreSQL's copy through P2b's bundle reads, on the job side, and the three readers are built", async () => {
    const rooted = rootOver(envOf({ kv: null }));

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      expect(await factory(V0), name).toBeDefined();
    }

    // The safety reader's manifest, the decider's manifest and flow A, the composer's manifest.
    const lines = rooted.lines();
    expect(lines.map((line) => line.call)).toEqual(Array.from({ length: 4 }, () => "readBundleValue"));
    expect(new Set(lines.map((line) => [line.side, line.binding, line.login].join()))).toEqual(
      new Set(["runtime,HYPERDRIVE_JOB,rosie_worker_job"]),
    );
    expect(rooted.testEnv.job?.reads.n).toBe(4);
    expect(rooted.models.requests).toEqual([]);
  });
});

// ---- each reader is its bundle's own ------------------------------------------------------------------------------------

describe("a bundle with prompts of its own", () => {
  it("gets readers of its own: the safety read and the composer's call under it carry that bundle's prompts, named by their versions, while bundle v0's carry v0's; never a prompt from code", async () => {
    const kv = kvDouble();
    kv.fill(V0_BUNDLE, OWN_PROMPTS);
    const rooted = rootOver(envOf({ kv }), { safetyLines: true });
    const { root, models } = rooted;
    await withCheckedLines(rooted, V0);
    await withCheckedLines(rooted, OWN_PROMPTS.bundleId);
    const input = structuredClone(JOIN_INPUT);

    const underV0 = await root.ports.safetyRead.read(safetyRequest(V0));
    const underOwn = await root.ports.safetyRead.read(safetyRequest(OWN_PROMPTS.bundleId));
    const composed = plannedOf(
      await root.ports.composer.compose(input, traceUnder(OWN_PROMPTS.bundleId, input.turn)),
    );

    expect(underV0.result.outcomes).toEqual(["No"]);
    expect(underOwn.result.outcomes).toEqual(["No"]);
    expect(composed.plan).toEqual(PLAN_S1_02);
    expect(models.misses).toEqual([]);
    expect(models.requests.map((request) => request.wire)).toEqual([
      safetyWire(V0_BUNDLE),
      safetyWire(OWN_PROMPTS),
      composeWire(OWN_PROMPTS, input),
    ]);
    const ownVersion = (kind: PromptKind): string =>
      `${kind}@${promptIn(OWN_PROMPTS.manifest, kind).version}`;
    expect(models.requests.map((request) => promptNamed(request, OWN_PROMPTS))).toEqual([
      null,
      ownVersion("safetyRead"),
      ownVersion("composer"),
    ]);
    // The two bundles' prompts differ, so a prompt taken from code, or from the other bundle, would not pass above.
    expect(promptIn(OWN_PROMPTS.manifest, "safetyRead").text).not.toBe(
      promptIn(V0_MANIFEST, "safetyRead").text,
    );
    expect(ownVersion("safetyRead")).toBe(`safetyRead@${promptIn(V0_MANIFEST, "safetyRead").version}-t1396`);
    // Every value came from the KV: K-05 was never asked.
    expect(rooted.lines()).toEqual([]);
  });
});

// ---- one build per bundle id ------------------------------------------------------------------------------------------

describe("one reader per bundle id", () => {
  it("each factory builds once across two calls and gives the same reader again, with nothing read for the second call", async () => {
    const rooted = rootOver(envOf());
    const expected: Readonly<Record<string, number>> = { safetyRead: 1, decide: 2, composer: 1 };

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      const before = rooted.mark();
      const first = await factory(V0);
      const afterFirst = rooted.since(before);
      const again = rooted.mark();
      const second = await factory({ ...V0 });

      expect(second, name).toBe(first);
      expect(afterFirst.postgres, name).toHaveLength(expected[name] ?? 0);
      expect(rooted.since(again), name).toEqual({ kv: [], postgres: [] });
    }
    // BUNDLES was read from the env once for each build, never when the root was built and never for a kept reader.
    expect(readsOf(rooted.testEnv, "BUNDLES")).toBe(3);
    expect(rooted.models.requests).toEqual([]);
  });

  it("through the ports, two safety reads, two decides and two composer calls under one bundle build each reader once", async () => {
    const kv = kvDouble();
    kv.fill(V0_BUNDLE);
    const rooted = rootOver(envOf({ kv }), { safetyLines: true });
    const { root } = rooted;
    const mark = await withCheckedLines(rooted, V0);

    for (const [, call] of portCalls(root, V0)) await call();
    const first = rooted.since(mark);
    const again = rooted.mark();
    for (const [, call] of portCalls(root, V0)) await call();

    // The first round: the safety reader's manifest, the decider's manifest and flow A, the composer's manifest.
    expect(first.kv).toEqual([MANIFEST.key, MANIFEST.key, FLOW_A.key, MANIFEST.key]);
    // The second round reads no bundle value at all, and each call is answered as the first was.
    expect(rooted.since(again)).toEqual({ kv: [], postgres: [] });
    expect(rooted.models.misses).toEqual([]);
    expect(rooted.models.requests.map((request) => request.kind)).toEqual([
      "safetyRead",
      ...Array.from({ length: 4 }, () => "decide"),
      "compose",
      "safetyRead",
      ...Array.from({ length: 4 }, () => "decide"),
      "compose",
    ]);
  });

  it("a read in flight is not shared: two callers at once each make their own reads, and both, and every later call, get the one reader kept", async () => {
    const kv = kvDouble();
    kv.fill(V0_BUNDLE);
    const rooted = rootOver(envOf({ kv }));

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      const before = readsOf(rooted.testEnv, "BUNDLES");
      const [one, other] = await Promise.all([factory(V0), factory(V0)]);

      expect(readsOf(rooted.testEnv, "BUNDLES") - before, name).toBe(2);
      expect(other, name).toBe(one);
      expect(await factory(V0), name).toBe(one);
      expect(readsOf(rooted.testEnv, "BUNDLES") - before, name).toBe(2);
    }
  });
});

// ---- the key, read by name at each call ---------------------------------------------------------------------------------

describe("the model key", () => {
  it("left out of the env: each of the three calls fails before any fetch, its error naming ANTHROPIC_API_KEY and nothing else; set later, the same readers call with it; changed, the next call carries the new one", async () => {
    const kv = kvDouble();
    kv.fill(V0_BUNDLE);
    const rooted = rootOver(envOf({ kv, key: null }), { safetyLines: true });
    const { root, models, testEnv } = rooted;
    await withCheckedLines(rooted, V0);
    // Nothing read the key to build the root.
    expect(readsOf(testEnv, KEY_VARIABLE)).toBe(0);

    for (const value of [undefined, ""]) {
      if (value !== undefined) testEnv.values[KEY_VARIABLE] = value;
      for (const [name, call] of portCalls(root, V0)) {
        const failed = await rejectionOf(call());
        expect(failed, name).toBeInstanceOf(MissingKeyError);
        expect((failed as MissingKeyError).variable, name).toBe("ANTHROPIC_API_KEY");
        expect((failed as Error).message, name).toBe("ANTHROPIC_API_KEY is not set in the environment");
        expectNoWords(textsOf(failed));
      }
    }
    expect(models.requests).toEqual([]);
    // The readers were built all the same (the key is no part of a build), and are kept.
    const built = readsOf(testEnv, "BUNDLES");

    testEnv.values[KEY_VARIABLE] = MODEL_KEY;
    for (const [, call] of portCalls(root, V0)) await call();
    testEnv.values[KEY_VARIABLE] = OTHER_MODEL_KEY;
    for (const [, call] of portCalls(root, V0)) await call();

    expect(models.misses).toEqual([]);
    expect(models.requests.map((request) => request.key)).toEqual([
      ...Array.from({ length: 6 }, () => MODEL_KEY),
      ...Array.from({ length: 6 }, () => OTHER_MODEL_KEY),
    ]);
    // No reader was built again for the key: each read it from the env at its call.
    expect(readsOf(testEnv, "BUNDLES")).toBe(built);
    expect(readsOf(testEnv, KEY_VARIABLE)).toBeGreaterThanOrEqual(12);
  });
});

// ---- failing closed -----------------------------------------------------------------------------------------------------

describe("nothing bound", () => {
  it("with no HYPERDRIVE_JOB, P2b's bundle reads are null and so are the three inputs: each port fails with its named error, as a root with nothing bound does, and nothing is fetched", async () => {
    const rooted = rootOver(envOf({ job: false }), { safetyLines: true });
    const { root, inputs, models } = rooted;
    const context = contextUnder(V0);
    const input = structuredClone(JOIN_INPUT);
    const trace = traceUnder(V0, context.turnId);

    expect(inputs.bundleReads).toBeNull();
    expect([inputs.safetyReaders, inputs.deciders, inputs.composers]).toEqual([null, null, null]);

    expect(await rejectionOf(root.ports.safetyRead.read(safetyRequest(V0)))).toEqual(
      new NoSafetyReaderError(),
    );
    expect(await rejectionOf(root.ports.decide.decide(context, trace))).toEqual(new NoDeciderError());
    const reread = { context, decide: enterResultFor(context, "JOIN"), why: "disagreed", failing: [] };
    expect(await rejectionOf(root.ports.decide.reread(reread as unknown as RereadRequest, trace))).toEqual(
      new NoDeciderError(),
    );
    expect(await rejectionOf(root.ports.composer.compose(input, trace))).toEqual(new NoComposerError());
    const rewrite = { input, plan: PLAN_S1_02, failed: [] };
    expect(
      await rejectionOf(root.ports.composer.rewrite(rewrite as unknown as RewriteRequest, trace)),
    ).toEqual(new NoComposerError());

    expect(models.requests).toEqual([]);
    expect(rooted.testEnv.kv?.gets).toEqual([]);
    expect(rooted.lines()).toEqual([]);
    // Neither the key nor BUNDLES was read.
    expect(readsOf(rooted.testEnv, KEY_VARIABLE) + readsOf(rooted.testEnv, "BUNDLES")).toBe(0);
  });

  it("the builder alone: with the bundle reads null it gives its nothing-bound input; bound, it reads nothing but ENVIRONMENT to build the three factories: no KV, no bundle read, no key, no fetch", async () => {
    const testEnv = envOf();
    const db = stagingDb(testEnv.env);
    HANDLES.push(db);
    const models = modelDouble();
    let kvAsked = 0;
    const kv = (): null => {
      kvAsked += 1;
      return null;
    };
    const made: string[] = [];
    const bundleReads: BundleReadCalls = {
      readActiveBundle: () => {
        made.push("readActiveBundle");
        return Promise.reject(new Error("not read here"));
      },
      readBundleValue: () => {
        made.push("readBundleValue");
        return Promise.reject(new Error("not read here"));
      },
    };
    const part = { env: testEnv.env, db, kv, fetch: models.fetch };

    expect(stagingModels({ ...part, bundleReads: null })).toBe(NO_MODEL_READER_INPUTS);
    const bound = stagingModels({ ...part, bundleReads });

    expect(Object.keys(bound).sort()).toEqual(["composers", "deciders", "safetyReaders"]);
    expect(Object.values(bound).map((input) => typeof input)).toEqual(["function", "function", "function"]);
    expect(testEnv.names).toEqual(["ENVIRONMENT", "ENVIRONMENT"]);
    expect([kvAsked, made, models.requests, db.counts().opened]).toEqual([0, [], [], 0]);

    // A build asks BUNDLES and the bundle reads, then; and reads no key.
    const failed = await rejectionOf(Promise.resolve(boundOf(bound.safetyReaders, "safetyReaders")(V0)));
    expect(failed).toBeInstanceOf(ModelReaderBundleError);
    expect([kvAsked, made]).toEqual([1, ["readBundleValue"]]);
    expect(readsOf(testEnv, KEY_VARIABLE)).toBe(0);
  });
});

describe("a bundle no reader can be built from: the factory rejects before any fetch, and a later call builds again", () => {
  it("the bindings left out (no BUNDLES, and HYPERDRIVE_JOB gone when the read is made): each factory rejects, naming the manifest and no value; asked again it reads again; with the binding back it builds", async () => {
    const rooted = rootOver(envOf({ kv: null }));
    const { testEnv, models } = rooted;
    const job = testEnv.values.HYPERDRIVE_JOB;
    delete testEnv.values.HYPERDRIVE_JOB;

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      const before = readsOf(testEnv, "BUNDLES");
      for (const attempt of [1, 2]) {
        const failed = await rejectionOf(factory(V0));
        expect(failed, name).toBeInstanceOf(ModelReaderBundleError);
        expect(failed, name).toMatchObject({ reader: name, code: "noAnswer", part: "manifest" });
        expect((failed as Error).message, name).toBe(
          `no ${name} reader can be built from the bundle: noAnswer (manifest)`,
        );
        expectNoWords(textsOf(failed));
        // Not kept: each call made its own attempt.
        expect(readsOf(testEnv, "BUNDLES") - before, name).toBe(attempt);
      }
    }
    expect(testEnv.job?.reads.n).toBe(0);
    expect(rooted.lines()).toEqual([]);

    testEnv.values.HYPERDRIVE_JOB = job;
    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      expect(await factory(V0), name).toBeDefined();
    }
    expect(rooted.lines().map((line) => line.call)).toEqual(
      Array.from({ length: 4 }, () => "readBundleValue"),
    );
    expect(models.requests).toEqual([]);
  });

  it("a manifest of another bundle id (bundle v0's, under the asked bundle's key): no copy is the bundle's own, so each factory rejects; once the bundle's own manifest is there, the next call builds", async () => {
    const kv = kvDouble();
    const rooted = rootOver(envOf({ kv }));
    const asked = LATER_BUNDLE.bundleId;
    const [[manifestKey], [flowKey, flowText]] = LATER_BUNDLE.values as [
      readonly [string, string],
      readonly [string, string],
    ];
    // The KV's copy under the asked bundle's manifest key is another bundle's manifest; PostgreSQL holds none for it.
    kv.held.set(manifestKey, MANIFEST.value);
    kv.held.set(flowKey, flowText);

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      const failed = await rejectionOf(factory(asked));
      expect(failed, name).toBeInstanceOf(ModelReaderBundleError);
      expect(failed, name).toMatchObject({ reader: name, code: "notFound", part: "manifest" });
      expectNoWords(textsOf(failed));
    }
    // Each attempt asked the KV, refused its copy and asked PostgreSQL's: three attempts, none kept.
    expect(kv.gets).toEqual([manifestKey, manifestKey, manifestKey]);
    expect(rooted.lines().map((line) => line.call)).toEqual(
      Array.from({ length: 3 }, () => "readBundleValue"),
    );
    // Through the ports the same refusal comes back, before any model call.
    for (const [name, call] of portCalls(rooted.root, asked).slice(1)) {
      expect(await rejectionOf(call()), name).toMatchObject({ code: "notFound", part: "manifest" });
    }
    expect(rooted.models.requests).toEqual([]);

    kv.fill(LATER_BUNDLE);
    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      expect(await factory(asked), name).toBeDefined();
    }
    expect(rooted.models.requests).toEqual([]);
  });

  it("a flow graph that is not the one the manifest lists: the decider is not built (the manifest alone builds the safety reader and the composer)", async () => {
    const kv = kvDouble();
    kv.fill(LATER_BUNDLE);
    kv.held.set(keyOf(LATER_BUNDLE.bundleId, "flow/A"), `${FLOW_A.value} `);
    const rooted = rootOver(envOf({ kv }));

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      if (name !== "decide") {
        expect(await factory(LATER_BUNDLE.bundleId), name).toBeDefined();
        continue;
      }
      const failed = await rejectionOf(factory(LATER_BUNDLE.bundleId));
      expect(failed).toBeInstanceOf(ModelReaderBundleError);
      expect(failed).toMatchObject({ reader: "decide", code: "notFound", part: "flow/A" });
    }
    expect(rooted.models.requests).toEqual([]);
  });

  it("a bundle id that is not K-01's: each factory rejects with nothing read", async () => {
    const kv = kvDouble();
    const rooted = rootOver(envOf({ kv }));

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      for (const bad of [
        { hash: "not-a-hash", build: 1 },
        { hash: V0.hash, build: 0 },
      ] as BundleId[]) {
        const failed = await rejectionOf(factory(bad));
        expect(failed, name).toMatchObject({ reader: name, code: "badBundleId", part: null });
      }
    }
    expect(kv.gets).toEqual([]);
    expect(rooted.lines()).toEqual([]);
  });

  it("a manifest with no prompt for the reader (no safetyRead prompt for the safety read, and so for each): the factory rejects, naming the prompt's kind and none of its words; a prompt of spaces alone is no prompt", async () => {
    const kv = kvDouble();
    kv.fill(V0_BUNDLE, NO_PROMPT.safetyRead, NO_PROMPT.decide, NO_PROMPT.composer, BLANK_COMPOSER_PROMPT);
    const rooted = rootOver(envOf({ kv }), { safetyLines: true });
    const { root, models } = rooted;

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      const bundle = NO_PROMPT[name];
      for (const attempt of [1, 2]) {
        const before = kv.gets.length;
        const failed = await rejectionOf(factory(bundle.bundleId));
        expect(failed, name).toBeInstanceOf(ModelReaderBundleError);
        expect(failed, name).toMatchObject({ reader: name, code: "noPrompt", part: name });
        expect((failed as Error).message, name).toBe(
          `no ${name} reader can be built from the bundle: noPrompt (${name})`,
        );
        expectNoWords(textsOf(failed));
        // Asked again, it reads again: the failed build was not kept.
        expect(kv.gets.length - before, `${name}, attempt ${String(attempt)}`).toBeGreaterThanOrEqual(1);
      }
    }
    const [, , [, composers]] = factoriesOf(rooted.inputs) as [
      unknown,
      unknown,
      readonly [string, (bundleId: BundleId) => Promise<unknown>],
    ];
    expect(await rejectionOf(composers(BLANK_COMPOSER_PROMPT.bundleId))).toMatchObject({
      reader: "composer",
      code: "noPrompt",
      part: "composer",
    });

    // Through the ports: the safety read under the bundle with no safetyRead prompt has its checked lines (P3b's check
    // reads no prompt) and fails at the reader's build; decide and the composer fail the same way; no model is called.
    await withCheckedLines(rooted, NO_PROMPT.safetyRead.bundleId);
    for (const [name, call] of portCalls(root, NO_PROMPT.safetyRead.bundleId)) {
      const failed = await rejectionOf(call());
      expect(failed, name).toBeInstanceOf(ModelReaderBundleError);
      expect(failed, name).toMatchObject({ code: "noPrompt", part: "safetyRead" });
    }
    expect(models.requests).toEqual([]);
    // Bundle v0, beside them, still builds: each failure was its own bundle's.
    for (const [name, factory] of factoriesOf(rooted.inputs)) expect(await factory(V0), name).toBeDefined();
  });

  it("a model id the gateway refuses, and a manifest with no models: each factory rejects before any fetch, the gateway's refusal naming the id it expects; asked again it builds again and is refused again", async () => {
    const kv = kvDouble();
    kv.fill(REFUSED_MODEL_BUNDLE, NO_MODELS_BUNDLE);
    const rooted = rootOver(envOf({ kv }), { safetyLines: true });
    const { root, models } = rooted;

    for (const [name, factory] of factoriesOf(rooted.inputs)) {
      for (const attempt of [1, 2]) {
        const before = kv.gets.length;
        const failed = await rejectionOf(factory(REFUSED_MODEL_BUNDLE.bundleId));
        expect(failed, name).toBeInstanceOf(GatewayConfigError);
        expect((failed as Error).message, name).toBe(
          `the bundle cannot be used: models.haiku is not ${HAIKU_MODEL}`,
        );
        expectNoWords(textsOf(failed));
        expect(kv.gets.length - before, `${name}, attempt ${String(attempt)}`).toBeGreaterThanOrEqual(1);
      }
      const none = await rejectionOf(factory(NO_MODELS_BUNDLE.bundleId));
      expect(none, name).toMatchObject({ reader: name, code: "noModels", part: "models" });
    }

    await withCheckedLines(rooted, REFUSED_MODEL_BUNDLE.bundleId);
    for (const [name, call] of portCalls(root, REFUSED_MODEL_BUNDLE.bundleId)) {
      expect(await rejectionOf(call()), name).toBeInstanceOf(GatewayConfigError);
    }
    expect(models.requests).toEqual([]);
  });
});

// ---- production ---------------------------------------------------------------------------------------------------------

describe("production", () => {
  it("stagingOptions builds none of the three and reads ENVIRONMENT alone; the builder itself gives nothing there; the Worker's root keeps the three ports closed, with no binding, KV or key read and nothing fetched", async () => {
    const kv = kvDouble();
    kv.fill(V0_BUNDLE);
    const testEnv = envOf({ environment: "production", kv });
    const models = modelDouble();
    const built: string[] = [];

    const inputs = stagingOptions(testEnv.env, {
      fetch: models.fetch,
      builders: {
        ...OTHER_PARTS_UNBOUND,
        turn: () => {
          built.push("turn");
          throw new Error("no part is built in production");
        },
        bundleSafety: () => null,
        models: (part) => {
          built.push("models");
          return stagingModels(part);
        },
      },
    });

    expect(inputs).toBe(NO_STAGING_INPUTS);
    expect([inputs.safetyReaders, inputs.deciders, inputs.composers]).toEqual([null, null, null]);
    expect(built).toEqual([]);
    expect(testEnv.names).toEqual(["ENVIRONMENT"]);

    // The builder on its own, were it handed bound reads there: nothing.
    const db = stagingDb(testEnv.env);
    HANDLES.push(db);
    const bundleReads: BundleReadCalls = {
      readActiveBundle: () => Promise.reject(new Error("not read here")),
      readBundleValue: () => Promise.reject(new Error("not read here")),
    };
    expect(stagingModels({ env: testEnv.env, db, bundleReads, kv: () => null, fetch: models.fetch })).toBe(
      NO_MODEL_READER_INPUTS,
    );
    expect(testEnv.names).toEqual(["ENVIRONMENT", "ENVIRONMENT"]);

    // The Worker's own root: ../picks.ts keeps the three ports closed in production.
    const root = workerRoot(testEnv.env);
    expect(root.environment).toBe("production");
    const [safetyRead, decide, composer] = portCalls(root, V0);
    expect(await rejectionOf(boundOf(safetyRead, "call")[1]())).toEqual(new NotJoinedError("safetyRead"));
    expect(await rejectionOf(boundOf(decide, "call")[1]())).toEqual(new NotJoinedError("decide"));
    expect(await rejectionOf(boundOf(composer, "call")[1]())).toEqual(new NotJoinedError("composer"));

    // T-1257's counting double: 0 reads of a binding's connection string, of BUNDLES or of the key.
    expect(testEnv.job?.reads.n).toBe(0);
    expect(testEnv.app.reads.n).toBe(0);
    expect(kv.gets).toEqual([]);
    for (const name of ["HYPERDRIVE_JOB", "HYPERDRIVE_APP", "BUNDLES", KEY_VARIABLE]) {
      expect(readsOf(testEnv, name), name).toBe(0);
    }
    expect(models.requests).toEqual([]);
  });
});

// ---- nothing leaks ----------------------------------------------------------------------------------------------------

describe("the span and log capture of every test above", () => {
  it("holds no word of the text, no prompt text, no plan words and no key: labels, ids and counts only; nor does any error thrown; and no unhandled rejection reached this isolate", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The capture is not empty: the model calls' portCall spans (the turn's traces and the safety read's, which the
    // root logs), every bundle read's timing line and every refusal thrown are in it.
    expect(SPANS.filter(modelCall).length).toBeGreaterThanOrEqual(20);
    expect(SPANS.filter((span) => !modelCall(span))).toEqual([]);
    expect(
      LOGGED.filter((line) => line.includes('"portCall"') && line.includes('"anthropic"')).length,
    ).toBeGreaterThanOrEqual(6);
    expect(LOGGED.filter((line) => line.includes('"dbCall"')).length).toBeGreaterThanOrEqual(10);
    expect(THROWN.length).toBeGreaterThanOrEqual(30);

    expectNoWords([JSON.stringify(SPANS), ...LOGGED, ...THROWN.flatMap(textsOf)]);
    // A model call's span holds its labels and counts: never a request's system prompt or message.
    for (const span of SPANS) {
      expect(Object.keys(span).filter((name) => /system|messages|prompt|content|body/iu.test(name))).toEqual(
        [],
      );
    }
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
