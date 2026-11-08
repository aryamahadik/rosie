// Test support for the composer's tests (T-373): the bundle they compose on, with T-372's composer prompt packed in;
// the composer inputs the recorded-model double (T-004) holds a plan for; and a fake Messages API (T-364's, with
// Anthropic's prompt cache) that answers each row's call with the plan given for exactly that row's input, as the
// double replays a plan for exactly its input. No network, no key, no live call (J-02; DL-027: CI makes none). Never
// imported by the Worker.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptCache, type CacheBundle, type CacheFlow, type PromptCache } from "../cache";
import { fakeCachingApi, type FakeCachingApi } from "../cache/test-support";
import { KEY_VARIABLE, type FetchLike, type GatewayBundle } from "../gateway";
import { createComposer } from "./compose";
import { COMPOSER_PROMPT, composeInputText, type ComposeInput } from "./prompt";
import type { Composer } from "./types";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

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
