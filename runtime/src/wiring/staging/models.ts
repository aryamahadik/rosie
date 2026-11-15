// Staging's model readers (the D-017 path audit's P3a: ops/reviews/D-017-path-audit/order_d017.txt line 33; T-1396; the
// lead's notes DL-414, DL-757 (its ruling R7: deciders too) and DL-768). T-1257 made this file with its final signature;
// T-1396 binds it and edits nothing else.
//
// The three model readers' RootOptions inputs, each the factory per bundle id that ../real.ts types, each reader
// @rosie/ai's own, built from the bundle its call names and from nothing in code:
//
//   safetyReaders  createSafetyReader (T-365, with T-366's danger-word rules; C-113) over the manifest's id, its two models
//                  and its own safety read prompt (K-01 v1 manifest.prompts.safetyRead: the prompt layout is made from the
//                  manifest's prompts alone, with no flow graph, as the test environment's is, but never with a prompt
//                  from code: critic_size N4).
//   deciders       createDecider (T-369's two reads, with T-370's one Sonnet re-read; C-115, C-116; R7) over the
//                  manifest's id, models and routing policy, its decide prompt, and every flow graph the manifest lists
//                  (the always-on rules and the step cards the layout reads), as the test environment's decideBundleOf
//                  builds them, rebuilt here from the values read.
//   composers      createComposer (T-373, with T-374's one rewrite and T-375's reader checks; C-118; DL-414) over the
//                  manifest's id, models and composer prompt.
//
// The manifest and the flow graphs are read as the pin reads them (../../bundle/values.ts: BundleReader, readManifest,
// asListed, flowOf): the actor's BUNDLES KV first, read from the env at that call, then PostgreSQL's copy through P2b's
// bundle reads (./k05-turn.ts: K-05 v1 item 7 on the job handle; handed in by ./options.ts, never imported from there),
// each value checked against the bundle id and the manifest's listing. A bundle's keys are written once and never
// overwritten (K-01 v1 "Storage"), so a reader built once is its bundle's for as long as the isolate lives.
//
// One reader per bundle id: each factory keeps the readers it has built, by bundle id, for its root (one decider serves
// decide and its re-read, so the once-per-run ledger of the re-read sees every call of a turn). A build that fails is not
// kept, so the next call asks again. A read in flight is never shared between callers (two handles' actors run in two
// request contexts): each caller whose bundle is not kept yet makes its own reads, and the first reader kept is the one
// every later call gets. A reader holds no connection, socket or request: the bundle's texts, the env and the fetch seam.
//
// The model key (J-02): each reader is handed an env of one name, ANTHROPIC_API_KEY (../root.ts WorkerSecrets), which
// reads the Worker's env by that name at each access. So the AI gateway and the safety read take the key at the moment
// of each model call (ai/src/gateway/gateway.ts, ai/src/safety/read.ts), never a copy made when the root or a reader
// was built (critic_collisions N4); with none set, each call fails before any fetch (MissingKeyError, naming the
// variable only). Every model call goes through the fetch seam ./options.ts names (critic_size B9): the global fetch in
// the Worker, a test's double in a test.
//
// Failing closed. Unbound (any environment but staging; P2b's bundle reads null: no HYPERDRIVE_JOB, DL-768): each input
// is null, as the Worker's root has always handed, so each call fails as ../real.ts's nulls do (NoSafetyReaderError,
// NoDeciderError, NoComposerError). Nothing is read to build them but ENVIRONMENT. Bound, the factory rejects, before
// any model call, for a bundle it cannot build a reader from:
//   - the bundle id asked for is not K-01's, the manifest or a listed flow graph cannot be read, or what is read is not
//     the bundle's own (another bundle id's manifest, a size or sha256 that is not the listed one): ModelReaderBundleError,
//     with the bundle reads' own code (../../bundle/types.ts BundleErrorCode) and the part (manifest, flow/A);
//   - the manifest holds no two model ids, not K-01 v1's four prompts, or no words for the reader's own prompt:
//     ModelReaderBundleError (noModels; noPrompt with the prompt's kind);
//   - @rosie/ai's own set-up refuses it: a model id the AI gateway refuses (GatewayConfigError), a prompt whose text is
//     not its sha256's or rules that are not their hash's (CacheLayoutError), a routing policy that is not K-01 v1's
//     (RoutingPolicyError). Those go back as they are: they name ids, kinds and fields, never a prompt's words.
// So the actor applies its no-verdict rule, nothing decided commits and no row gets a plan.
//
// Nothing here logs or writes a span: the model calls' portCall spans are the AI gateway's and the safety read's own
// (labels and counts only), on the trace each port hands in. No error here holds a text's words, a prompt, a plan's
// words or the key. Staging only: production builds none (./options.ts), and ../picks.ts keeps the three ports closed.

import {
  createPromptCache,
  PROMPT_KINDS,
  type BundlePrompt,
  type CacheBundle,
  type CacheFlow,
  type PromptKind,
} from "@rosie/ai/src/cache/index";
import { createComposer } from "@rosie/ai/src/composer/compose";
import { createDecider } from "@rosie/ai/src/decide/two-reads";
import { KEY_VARIABLE } from "@rosie/ai/src/gateway/gateway";
import type { BundleModels, FetchLike } from "@rosie/ai/src/gateway/types";
import type { RoutingPolicy } from "@rosie/ai/src/routing/types";
import { createSafetyReader } from "@rosie/ai/src/safety/read";

import {
  BundleError,
  type BundleErrorCode,
  type BundleKv,
  type FlowLetter,
  type Manifest,
} from "../../bundle/types";
import { asListed, BundleReader, bundleIdOf, flowOf, readManifest } from "../../bundle/values";
import type { BundleId } from "../../trace";
import { environmentOf } from "../picks";
import {
  realBundles,
  type BundleReadCalls,
  type Composers,
  type Deciders,
  type SafetyReaders,
} from "../real";
import type { StagingPart } from "./part";

/** What T-1396's builder is handed (DL-757): the env, the root's handle, P2b's bundle reads, BUNDLES and the fetch seam. */
export interface ModelsPart extends StagingPart {
  /** P2b's bundle reads (./k05-turn.ts), as ./options.ts got them: null where they are not bound. */
  readonly bundleReads: BundleReadCalls | null;
  /** The actor's BUNDLES KV, read from the env at each call; null where the env binds none. */
  readonly kv: () => BundleKv | null;
  /** Every model call's fetch (the AI gateway's FetchLike). */
  readonly fetch: FetchLike;
}

/** The three model readers' RootOptions inputs, each null where it is not bound. */
export interface ModelReaderInputs {
  readonly safetyReaders: SafetyReaders | null;
  readonly deciders: Deciders | null;
  readonly composers: Composers | null;
}

/** None of the three bound: each fails closed before any model call. */
export const NO_MODEL_READER_INPUTS: ModelReaderInputs = Object.freeze({
  safetyReaders: null,
  deciders: null,
  composers: null,
});

/** The three readers, by the name an error gives one. */
export type ModelReaderName = "safetyRead" | "decide" | "composer";

/**
 * Why no reader can be built from a bundle, as a label: the bundle reads' own code for a value that cannot be read or is
 * not the bundle's own; badBundleId for an id that is not K-01's; noModels and noPrompt for a manifest that does not hold
 * what the reader is built from.
 */
export type ModelReaderBundleCode = BundleErrorCode | "badBundleId" | "noModels" | "noPrompt";

/**
 * A bundle no reader can be built from (the top of this file): the reader, the code and the part it names (manifest,
 * flow/A, models, or a prompt's kind). Labels only: never a value of the bundle, a key or a word.
 */
export class ModelReaderBundleError extends Error {
  readonly reader: ModelReaderName;
  readonly code: ModelReaderBundleCode;
  readonly part: string | null;

  constructor(reader: ModelReaderName, code: ModelReaderBundleCode, part: string | null) {
    super(`no ${reader} reader can be built from the bundle: ${code}${part === null ? "" : ` (${part})`}`);
    this.name = "ModelReaderBundleError";
    this.reader = reader;
    this.code = code;
    this.part = part;
  }
}

/** The manifest prompt each reader's calls are laid out on (ai/src/cache/layout.ts PROMPT_OF). */
const OWN_PROMPT: Readonly<Record<ModelReaderName, PromptKind>> = {
  safetyRead: "safetyRead",
  decide: "decide",
  composer: "composer",
};

const HAS_TEXT = /\S/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The manifest's two model ids (K-01 v1 manifest.models), or null where it holds none. The AI gateway checks the ids. */
function modelsOf(manifest: Manifest): BundleModels | null {
  const models = manifest.models;
  if (!isRecord(models) || typeof models.haiku !== "string" || typeof models.sonnet !== "string") return null;
  return { haiku: models.haiku, sonnet: models.sonnet };
}

/**
 * The manifest's four prompts as K-01 v1 writes each (its version, its sha256 and its text), or the kind of the first one
 * it does not hold so. The prompt layout checks each text against its sha256.
 */
function promptsOf(manifest: Manifest): Readonly<Record<PromptKind, BundlePrompt>> | PromptKind {
  const held = isRecord(manifest.prompts) ? manifest.prompts : {};
  const prompts: Partial<Record<PromptKind, BundlePrompt>> = {};
  for (const kind of PROMPT_KINDS) {
    const prompt = Object.hasOwn(held, kind) ? held[kind] : undefined;
    if (
      !isRecord(prompt) ||
      typeof prompt.version !== "string" ||
      typeof prompt.sha256 !== "string" ||
      typeof prompt.text !== "string"
    ) {
      return kind;
    }
    prompts[kind] = { version: prompt.version, sha256: prompt.sha256, text: prompt.text };
  }
  return prompts as Record<PromptKind, BundlePrompt>;
}

/**
 * The parts of a flow graph the prompt layout reads (ai/src/cache/bundle.ts CacheFlow): its always-on rules, and each
 * step's card under the step's id. Null for a value that is not K-01's flow `flow` or holds no always-on rules. The rest
 * of the graph is not kept.
 */
function cacheFlowOf(text: string, flow: FlowLetter): CacheFlow | null {
  const graph = flowOf(text, flow);
  if (graph === null || !isRecord(graph.steps) || !isRecord(graph.routing)) return null;
  const alwaysOn = graph.routing.alwaysOn;
  if (
    !isRecord(alwaysOn) ||
    typeof alwaysOn.prefixText !== "string" ||
    typeof alwaysOn.prefixSha256 !== "string"
  ) {
    return null;
  }
  const steps = Object.fromEntries(
    Object.entries(graph.steps).map(([id, step]) => [
      id,
      isRecord(step) && step.card !== undefined ? { card: step.card } : {},
    ]),
  );
  // K-01 v1's flow graph in two hand-written forms: the pin's (parsed JSON) and the prompt layout's, which reads these.
  return { flow, steps, routing: { alwaysOn } } as unknown as CacheFlow;
}

/** What a reader is built from: the bundle's id, its two models, its routing policy as written, and its layout's parts. */
interface BundleParts {
  readonly bundleId: BundleId;
  readonly models: BundleModels;
  /** K-01 v1 manifest.policy as the manifest holds it: the router checks it before any route. */
  readonly policy: unknown;
  readonly cache: CacheBundle;
}

/** ModelsPart with P2b's bundle reads bound. */
type BoundModelsPart = ModelsPart & { readonly bundleReads: BundleReadCalls };

/** A bundle id as the kept readers are keyed: `<hash>/<build>`. */
const keyOfBundle = (bundleId: BundleId): string => `${bundleId.hash}/${String(bundleId.build)}`;

/**
 * One reader per bundle id (the top of this file): the reader kept for the bundle, else a build of this caller's own,
 * kept once it has finished unless another caller's finished first. A build that rejects keeps nothing. An id that is
 * not K-01's (a 64-hex hash and a build from 1) is refused before anything is looked up or read.
 */
function onePerBundle<T>(
  name: ModelReaderName,
  build: (bundleId: BundleId) => Promise<T>,
): (bundleId: BundleId) => Promise<T> {
  const kept = new Map<string, T>();
  return async (asked) => {
    const bundleId = bundleIdOf(asked);
    if (bundleId === null) throw new ModelReaderBundleError(name, "badBundleId", null);
    const key = keyOfBundle(bundleId);
    const known = kept.get(key);
    if (known !== undefined) return known;
    const made = await build(bundleId);
    const first = kept.get(key);
    if (first !== undefined) return first;
    kept.set(key, made);
    return made;
  };
}

/** The three factories over bound bundle reads (the top of this file). Nothing is read until a factory is called. */
function modelReaders(part: BoundModelsPart): ModelReaderInputs {
  // P2b's reads as the bundle port hands them to the pin's reader (../real.ts realBundles: the key alone goes to K-05).
  const { registry } = realBundles({ calls: part.bundleReads });

  // The key's environment: one name, read from the Worker's env at each access, so each model call takes the key then.
  const env: Readonly<Record<string, string | undefined>> = Object.freeze({
    get [KEY_VARIABLE](): string | undefined {
      const key: unknown = part.env[KEY_VARIABLE];
      return typeof key === "string" ? key : undefined;
    },
  });

  /** Reads the bundle's manifest, and with `withFlows` every flow graph it lists, and takes from them what a reader needs. */
  const read = async (
    name: ModelReaderName,
    bundleId: BundleId,
    withFlows: boolean,
  ): Promise<BundleParts> => {
    // The actor's BUNDLES KV first, read from the env now; PostgreSQL's copy on a miss and where no KV is bound.
    const reader = new BundleReader(registry, part.kv());
    const flows: Partial<Record<FlowLetter, CacheFlow>> = {};
    let reading = "manifest";
    let manifest: Manifest;
    try {
      manifest = await readManifest(reader, bundleId);
      if (withFlows) {
        for (const listed of manifest.storage.values) {
          const flow = listed.flow;
          if (listed.kind !== "flow" || flow === undefined) continue;
          reading = `flow/${flow}`;
          flows[flow] = await reader.read(listed.key, "flow", (value) =>
            Promise.resolve(asListed(value, listed) ? cacheFlowOf(value.text, flow) : null),
          );
        }
      }
    } catch (error) {
      throw new ModelReaderBundleError(name, error instanceof BundleError ? error.code : "noAnswer", reading);
    }
    const models = modelsOf(manifest);
    if (models === null) throw new ModelReaderBundleError(name, "noModels", "models");
    const prompts = promptsOf(manifest);
    if (typeof prompts === "string") throw new ModelReaderBundleError(name, "noPrompt", prompts);
    const own = OWN_PROMPT[name];
    if (!HAS_TEXT.test(prompts[own].text)) throw new ModelReaderBundleError(name, "noPrompt", own);
    return {
      bundleId,
      models,
      policy: manifest.policy,
      cache: { manifest: { bundleId, prompts, partial: manifest.partial === true }, flows },
    };
  };

  return {
    safetyReaders: onePerBundle("safetyRead", async (asked) => {
      const { bundleId, models, cache } = await read("safetyRead", asked, false);
      return createSafetyReader({
        bundle: { bundleId, models },
        prompts: createPromptCache(cache),
        env,
        fetch: part.fetch,
      });
    }),
    deciders: onePerBundle("decide", async (asked) => {
      const { bundleId, models, policy, cache } = await read("decide", asked, true);
      return createDecider({
        // The policy as the manifest writes it: the router refuses, before any route, one that is not K-01 v1's.
        bundle: { bundleId, models, policy: policy as RoutingPolicy },
        prompts: createPromptCache(cache),
        env,
        fetch: part.fetch,
      });
    }),
    composers: onePerBundle("composer", async (asked) => {
      const { bundleId, models, cache } = await read("composer", asked, false);
      return createComposer({
        bundle: { bundleId, models },
        prompts: createPromptCache(cache),
        env,
        fetch: part.fetch,
      });
    }),
  };
}

/**
 * RootOptions.safetyReaders, deciders and composers for staging: @rosie/ai's readers, one per bundle id, each built from
 * that bundle's own manifest through P2b's bundle reads. All null anywhere but staging, and while those reads are null.
 */
export const stagingModels: (part: ModelsPart) => ModelReaderInputs = (part) => {
  const bundleReads = part.bundleReads;
  if (environmentOf(part.env) !== "staging" || bundleReads === null) return NO_MODEL_READER_INPUTS;
  return modelReaders({ ...part, bundleReads });
};
