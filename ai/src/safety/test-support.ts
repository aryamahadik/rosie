// Test support for the safety read's tests: the bundle they read on, the K-02 fixtures with the texts the recorded-model
// double holds for them, and a fake Messages API whose answers come from the double (T-004) or are written by a test.
// No network, no key, no live call (J-02; DL-027: CI makes none). Never imported by the Worker.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptCache, type CacheBundle, type PromptCache } from "../cache";
import { unescapeData } from "../context/tags";
import type { FetchLike, GatewayBundle } from "../gateway";
import type { RecordedModel } from "../recorded-double";
import { SAFETY_READ_PROMPT } from "./prompt";
import type { SafetyResult } from "./types";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as unknown;

interface Manifest {
  bundleId: { hash: string; build: number };
  models: { haiku: string; sonnet: string };
  prompts: CacheBundle["manifest"]["prompts"];
}

/** K-01 v1's sample manifest: its bundle id and its two model ids (claude-haiku-5-5 and claude-sonnet-5-5). */
export const MANIFEST = readJson("contracts/bundle/fixtures/manifest.json") as Manifest;
export const BUNDLE: GatewayBundle = { bundleId: MANIFEST.bundleId, models: MANIFEST.models };

/** A bundle as the compiler will pack it: the sample manifest with this task's safety read prompt in it. */
export function cacheBundleWith(safetyRead: { version: string; sha256: string; text: string }): CacheBundle {
  return {
    manifest: {
      bundleId: MANIFEST.bundleId,
      prompts: { ...MANIFEST.prompts, safetyRead },
      partial: true,
    },
    flows: {},
  };
}

export const PROMPTS: PromptCache = createPromptCache(cacheBundleWith(SAFETY_READ_PROMPT));

/** The K-02 v1 safety fixtures this card reads (the safety read's output, one per outcome it shows). */
export const CARD_FIXTURES = [
  "safety-no.json",
  "safety-emergency-now.json",
  "safety-crisis-words.json",
  "safety-threat.json",
  "safety-child-or-elder.json",
  "safety-unsafe-at-home.json",
  "safety-business-own-line.json",
  "safety-unknown-tense.json",
] as const;

/** A K-02 v1 fixture of `safetyResult`. */
export const k02 = (file: string): SafetyResult =>
  readJson(`contracts/model/fixtures/${file}`) as SafetyResult;

interface RecordingSpec {
  id: string;
  kind: string;
  request: { text?: string };
  seed?: { fixture: string };
  output?: unknown;
}

/** ai/recordings/recordings.v1.json, as written. */
export const RECORDINGS = readJson("ai/recordings/recordings.v1.json") as {
  version: string;
  contract: string;
  recordings: RecordingSpec[];
};

/** The safety recordings of the double: each raw text with the K-02 fixture its answer comes from. */
export const SAFETY_RECORDINGS = RECORDINGS.recordings.filter((recording) => recording.kind === "safetyRead");

/** The raw text the double holds for a K-02 safety fixture (its synthetic stand-in, ai/recordings). */
export function textOf(fixture: string): string {
  const found = SAFETY_RECORDINGS.find((recording) => recording.seed?.fixture === fixture);
  if (found?.request.text === undefined) throw new Error(`the double holds no text for ${fixture}`);
  return found.request.text;
}

const TEXT_ELEMENT = /<text source="(?:text|page|agent)">([\s\S]*)<\/text>$/u;

/** The words of the <text> element of a safety read's user message, as the person wrote them. */
export function textOfTurn(content: string): string {
  const match = TEXT_ELEMENT.exec(content);
  if (match?.[1] === undefined) throw new Error("the user message holds no <text> element");
  return unescapeData(match[1]);
}

export type Raw = Record<string, unknown>;

/** What the fake API does with one call. */
export type Behavior =
  /** Answers with the double's recording for the text in the user message. */
  | { kind: "double"; usage?: Raw }
  /** Answers with this output (as the answer's JSON text) and stop reason. */
  | { kind: "ok"; output: unknown; usage?: Raw; stop?: string }
  /** Answers 200 with a text block that is this text. */
  | { kind: "text"; text: string }
  | { kind: "status"; status: number }
  /** Never answers until the call is aborted, as a real fetch does. */
  | { kind: "hang" }
  | { kind: "throw"; message: string };

export interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Raw;
  readonly model: string;
  /** The user message's words, as the person wrote them. */
  readonly text: string;
}

export const USAGE: Raw = {
  input_tokens: 40,
  output_tokens: 60,
  cache_read_input_tokens: 1800,
  cache_creation_input_tokens: 0,
};

function messageResponse(output: string, usage: Raw, stop: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      stop_reason: stop,
      content: [{ type: "text", text: output }],
      usage,
    }),
    { status: 200 },
  );
}

/**
 * A fake Messages API. `behave` decides each call's answer from what was sent and how many came before. A "double"
 * answer for a text the double holds no recording for fails the call with a 500 and is listed in `misses`.
 */
export function fakeMessagesApi(
  recorded: RecordedModel,
  behave: (seen: Seen, n: number) => Behavior,
): { fetch: FetchLike; seen: Seen[]; misses: string[] } {
  const seen: Seen[] = [];
  const misses: string[] = [];
  const fetchFake: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body as string) as Raw;
    const messages = body.messages as { content: string }[];
    const entry: Seen = {
      url,
      headers: init.headers as Record<string, string>,
      body,
      model: body.model as string,
      text: textOfTurn(messages[0]?.content ?? ""),
    };
    seen.push(entry);
    const behavior = behave(entry, seen.length - 1);
    switch (behavior.kind) {
      case "double": {
        let output: unknown;
        try {
          output = await recorded.safetyRead({ text: entry.text });
        } catch {
          misses.push(entry.text);
          return new Response(JSON.stringify({ error: { message: "no recording" } }), { status: 500 });
        }
        return messageResponse(JSON.stringify(output), behavior.usage ?? USAGE, "end_turn");
      }
      case "ok":
        return messageResponse(
          JSON.stringify(behavior.output),
          behavior.usage ?? USAGE,
          behavior.stop ?? "end_turn",
        );
      case "text":
        return messageResponse(behavior.text, USAGE, "end_turn");
      case "status":
        return new Response(JSON.stringify({ error: { message: "failed on purpose" } }), {
          status: behavior.status,
        });
      case "throw":
        throw new Error(behavior.message);
      case "hang":
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
    }
  };
  return { fetch: fetchFake, seen, misses };
}

/** The same behavior for every call. */
export const always =
  (behavior: Behavior): (() => Behavior) =>
  () =>
    behavior;
