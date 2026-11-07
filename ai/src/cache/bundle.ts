// The parts of a K-01 v1 bundle the prompt layout reads (contracts/bundle/bundle.v1.schema.json), written by hand: the
// generated types are git-ignored (ADR-005) and the Worker must not depend on them. A turn reads the manifest and its
// flow's graph from KV (arch 10 line 536); this is the K-01 root's shape, so a whole sample bundle fits it too.
//
//   - manifest.bundleId and manifest.prompts (safetyRead, decide, planner, composer: version, sha256, text);
//   - flows.<A|B>.routing.alwaysOn: the always-on rules as the cached prefix (prefixText, prefixSha256; arch 03 line 181);
//   - flows.<A|B>.steps.<id>.card: a step's card (question, Means, Never, safe default; arch 03 line 181).

import { createHash } from "node:crypto";

import type { BundleId } from "../../../runtime/src/trace";

export const FLOW_LETTERS = ["A", "B"] as const;
/** A flow (SPEC-master 1): A, the customer comes to the business; B, the business goes to the customer. */
export type FlowLetter = (typeof FLOW_LETTERS)[number];

/** The prompts a bundle ships (K-01 v1 manifest.prompts). */
export const PROMPT_KINDS = ["safetyRead", "decide", "planner", "composer"] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

/** One prompt (K-01 v1 `prompt`): its owner's version, the sha256 of its text's UTF-8 bytes, and the text. */
export interface BundlePrompt {
  readonly version: string;
  readonly sha256: string;
  readonly text: string;
}

/** One branch's definition on a card (K-01 v1 `card.means`); no text when `from` is none. */
export interface CardMeaning {
  readonly branch: string;
  readonly text?: string;
  readonly from: string;
}

/** A step's card (K-01 v1 `card`, which K-02 v1's `stepCard` reuses). The clock is code's, not the model's. */
export interface StepCard {
  readonly question: string;
  readonly means: readonly CardMeaning[];
  readonly never: readonly string[];
  readonly safeDefault?: string;
  readonly clock?: unknown;
}

/** The always-on rules of one flow (K-01 v1 `routingTables.alwaysOn`). */
export interface AlwaysOnRules {
  readonly steps: readonly string[];
  readonly prefixText: string;
  readonly prefixSha256: string;
}

/** The part of one flow graph (K-01 v1 `flowGraph`) the layout reads. */
export interface CacheFlow {
  readonly flow: FlowLetter;
  readonly steps: Readonly<Record<string, { readonly card?: StepCard }>>;
  readonly routing: { readonly alwaysOn: AlwaysOnRules };
}

/** The part of a bundle the layout reads: its manifest, and the flow graphs at hand (one or both). */
export interface CacheBundle {
  readonly manifest: {
    readonly bundleId: BundleId;
    readonly prompts: Readonly<Record<PromptKind, BundlePrompt>>;
    /** true: the bundle holds only some steps (K-01 v1 `manifest.partial`), as the sample bundles do. */
    readonly partial?: boolean;
  };
  readonly flows: Partial<Readonly<Record<FlowLetter, CacheFlow>>>;
}

/** The sha256 of a text's UTF-8 bytes, in lowercase hex (K-01's form, Q-36). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Two bundle ids are one id. */
export function sameBundleId(a: BundleId, b: BundleId): boolean {
  return a.hash === b.hash && a.build === b.build;
}

/** A bundle id as it is written in a message: `<hash>/<build>`. */
export function bundleIdText(id: BundleId): string {
  return `${id.hash}/${String(id.build)}`;
}

/** JSON text with every object's keys sorted, so two copies of one card compare equal whatever their key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
