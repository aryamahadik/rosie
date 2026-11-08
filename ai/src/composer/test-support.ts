// Test support for the composer's tests (T-373): the bundle they compose on, with T-372's composer prompt packed in;
// the composer inputs the recorded-model double (T-004) holds a plan for; and a fake Messages API (T-364's, with
// Anthropic's prompt cache) that answers each row's call with the plan given for exactly that row's input, as the
// double replays a plan for exactly its input. No network, no key, no live call (J-02; DL-027: CI makes none). Never
// imported by the Worker.
//
// K-03 v1.1 (T-373 round 2): the double and its contract loader (T-1071) read K-03 v1 only, so v1.1's fixtures are read
// here, each by its entry in K-03's shared index, selected by version (DL-125); an independent Ajv checks documents
// against message-plan.v1.1.schema.json as T-082's contract test builds its validator; and the named rule
// numbersHeldByFacts is read from message-plan.rules.mjs, as `npm run contracts:check` reads it, to compare the
// composer's own literal check with it (the rule is the contract's statement, never the check's implementation).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { createPromptCache, type CacheBundle, type CacheFlow, type PromptCache } from "../cache";
import { fakeCachingApi, type FakeCachingApi } from "../cache/test-support";
import { KEY_VARIABLE, type FetchLike, type GatewayBundle } from "../gateway";
import { createComposer } from "./compose";
import { COMPOSER_PROMPT, composeInputText, type ComposeInput, type MessagePlan } from "./prompt";
import type { Composer } from "./types";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

/** One entry of K-03's fixtures index, shared by v1 and v1.1. */
export interface PlanIndexEntry {
  readonly file: string;
  readonly version: string;
  readonly def: string;
  readonly expect: "accept" | "refuse";
  readonly rule?: string;
}

const PLAN_FIXTURES = "contracts/message-plan/fixtures";

/** K-03's index entry for `file`, which must be a v1.1 entry (DL-125: each version's entries, selected by version). */
export function v1dot1Entry(file: string): PlanIndexEntry {
  const index = readJson(`${PLAN_FIXTURES}/index.json`) as { fixtures: PlanIndexEntry[] };
  const entry = index.fixtures.find((candidate) => candidate.file === file);
  if (entry === undefined) throw new Error(`${file} is not listed in K-03's fixtures/index.json`);
  if (entry.version !== "v1.1") throw new Error(`${file} is a ${entry.version} fixture, not v1.1`);
  return entry;
}

/** A K-03 v1.1 fixture, fresh each call: only a file its index lists for v1.1 can be read. */
export function v1dot1Fixture(file: string): unknown {
  v1dot1Entry(file);
  return readJson(`${PLAN_FIXTURES}/${file}`);
}

/** K-03 v1.1's `inputAndPlan`: an input and the plan made from it, side by side (the named rule's form). */
export interface InputAndPlan {
  readonly input: ComposeInput;
  readonly plan: MessagePlan;
}

const V1_1_SCHEMA_ID = "https://rosie.invalid/contracts/message-plan/message-plan.v1.1.schema.json";
let v1dot1Ajv: Ajv2020 | undefined;

/** The problems an independent strict Ajv finds in `value` against K-03 v1.1's `$defs/<def>`; empty when accepted. */
export function v1dot1Errors(def: string, value: unknown): string[] {
  if (v1dot1Ajv === undefined) {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const folder of ["common", "bundle", "message-plan"]) {
      for (const name of readdirSync(path.join(REPO_ROOT, "contracts", folder))) {
        if (name.endsWith(".schema.json")) ajv.addSchema(readJson(`contracts/${folder}/${name}`) as object);
      }
    }
    v1dot1Ajv = ajv;
  }
  const validate: ValidateFunction | undefined = v1dot1Ajv.getSchema(`${V1_1_SCHEMA_ID}#/$defs/${def}`);
  if (validate === undefined) throw new Error(`K-03 v1.1 has no definition ${def}`);
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${String(error.message)}`);
}

/** K-03 v1.1's named rules (message-plan.rules.mjs): each takes { input, plan } and gives its problems, one line each. */
export interface PlanRules {
  numbersHeldByFacts(pair: { input: unknown; plan: unknown }): string[];
}

/** Loads K-03 v1.1's named rules from the contract file, as `npm run contracts:check` runs them. */
export async function loadPlanRules(): Promise<PlanRules> {
  const file = path.join(REPO_ROOT, "contracts", "message-plan", "message-plan.rules.mjs");
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as PlanRules;
}

/** A K-01 v1 sample bundle, as the layout and the gateway read it. */
type Bundle = CacheBundle & {
  manifest: CacheBundle["manifest"] & { models: GatewayBundle["models"] };
  flows: Partial<Record<"A" | "B", CacheFlow>>;
};

export const V0 = readJson("contracts/bundle/fixtures/bundle-v0-skeleton.json") as Bundle;

/** Bundle v0 as the compiler will pack it (C-072): its own flows, with T-372's composer prompt in its manifest. */
export function withComposerPrompt(bundle: Bundle): CacheBundle {
  return {
    manifest: {
      bundleId: bundle.manifest.bundleId,
      prompts: { ...bundle.manifest.prompts, composer: COMPOSER_PROMPT },
      partial: true,
    },
    flows: bundle.flows,
  };
}

export const PROMPTS: PromptCache = createPromptCache(withComposerPrompt(V0));
export const GATEWAY_BUNDLE: GatewayBundle = { bundleId: V0.manifest.bundleId, models: V0.manifest.models };

// An obviously fake key, long enough to be found anywhere it leaks (never the real key's prefix).
export const KEY = "FAKE-KEY-FOR-COMPOSER-TESTS-ONLY-0123456789abcdef";
export const ENV = Object.freeze({ [KEY_VARIABLE]: KEY });

/** The composer on bundle v0, sending through `fetch`. */
export function composerOn(fetch: FetchLike): Composer {
  return createComposer({ bundle: GATEWAY_BUNDLE, prompts: PROMPTS, env: ENV, fetch });
}

/** The composer inputs the double holds a plan for besides K-03's own input-s1-02.json (ai/recordings/composer-inputs). */
export const RECORDED_INPUTS = [
  "block-readback-poll",
  "confirmation-a6-14",
  "relay-private-a7-12",
  "sensitive-a6-15",
  "tapback-thanks",
] as const;
export type RecordedInput = (typeof RECORDED_INPUTS)[number];

export const recordedInput = (name: RecordedInput): ComposeInput =>
  readJson(`ai/recordings/composer-inputs/${name}.json`) as ComposeInput;

/** One row and the plan the fake model answers for it. */
export interface RowAnswer {
  readonly input: ComposeInput;
  readonly plan: unknown;
}

export interface FakeComposerOptions {
  /** An HTTP status to fail a call with, or null to answer it (n counts every call from 0). */
  readonly fail?: (body: Record<string, unknown>, n: number) => number | null;
}

/**
 * A fake Messages API with Anthropic's prompt cache, answering a call with the plan given for the row whose tagged
 * input is the call's user message; a call for any other row fails the attempt (the double has no fallback plan).
 */
export function fakeComposerApi(
  rows: readonly RowAnswer[],
  options: FakeComposerOptions = {},
): FakeCachingApi {
  const byTurn = new Map(rows.map(({ input, plan }) => [composeInputText(input), plan]));
  return fakeCachingApi({
    answer: (body) => {
      const messages = body.messages as { content: string }[];
      const turn = messages[0]?.content ?? "";
      if (!byTurn.has(turn)) throw new Error("the fake model holds no plan for this row's input");
      return byTurn.get(turn);
    },
    ...(options.fail !== undefined && { fail: options.fail }),
  });
}
