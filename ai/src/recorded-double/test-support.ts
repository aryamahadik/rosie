// Test support for the double's tests (T-1145 round 2, DL-347): the walking skeleton's JOIN run's own ids, each computed
// here by the rule the runtime and the commit use, never typed by hand, and bundle v0 as bundles/v0 publishes it.
// Recordings 2 and 4 of K-02 README "v1.1" are keyed on them: the files in ai/recordings pin the values, and the tests
// hold each file to what this file gives. Not imported by the Worker.
//
//   - the event id: evt-sam-0000, the JOIN that tests/e2e/skeleton sends (K-08 trace-skeleton.json's receive span), its
//     text JOIN sent 2026-10-19T14:01:49Z;
//   - the turn id: T-248's rule (runtime/src/actor/lease.ts turnIdOf): SHA-256, in lowercase hex, over the turn's event
//     ids, each once, sorted, each written as a JSON string, joined by line breaks;
//   - the bundle: bundle v0 as bundles/v0/bundle.kv.json publishes it, the bundle the runtime's bundle port pins for the
//     turn (T-556): its manifest under its own id, and its flow A graph, whose always-on rules' hash the frontier copies
//     into the context (actions/src/frontier/assemble/handler.ts, step 8);
//   - the row id: ADR-013 default 131, `<kind>-<step>-<turn key>-<n>`, the step in lower case and the turn's own id as the
//     turn key (actions/src/commit/walk/writes.ts rowIds);
//   - S1-02's master line and card lines, as that bundle publishes them (K-01 flows.A.steps.S1-02.say[0]): the row's
//     compose input carries the line as its masterText and the card's four lines as its term facts (K-09 v1.6; K-03
//     v1.1 README "v1.1"), which recording 4 is keyed on (T-1175).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CacheBundle, CacheFlow } from "../cache";

/** The repository root: this file is ai/src/recorded-double/test-support.ts. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Bundle v0's KV bulk file, as its publish writes it (T-163; bundles/v0/build.mjs). */
export const BUNDLE_V0_KV_FILE = path.join(REPO_ROOT, "bundles", "v0", "bundle.kv.json");

/** The JOIN of tests/e2e/skeleton: its K-06 event id, its words and when it was sent. */
export const JOIN_EVENT_ID = "evt-sam-0000";
export const JOIN_WORDS = "JOIN";
export const JOIN_SENT_UTC = "2026-10-19T14:01:49Z";

/**
 * A turn's id by T-248's rule (runtime/src/actor/lease.ts turnIdOf; CQ-09; arch 01 line 59): SHA-256, in lowercase hex,
 * over the event ids, each once, sorted, each written as a JSON string, joined by line breaks.
 */
export function turnIdOf(eventIds: readonly string[]): string {
  if (eventIds.length === 0) throw new Error("a turn has at least one text");
  const lines = [...new Set(eventIds)].sort().map((eventId) => JSON.stringify(eventId));
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** A row id by ADR-013 default 131: `<kind>-<step>-<turn key>-<n>`, the step in lower case. */
export function rowIdOf(kind: string, step: string, turnKey: string, n: number): string {
  return `${kind}-${step.toLowerCase()}-${turnKey}-${String(n)}`;
}

/** The JOIN run's turn id: T-248's hash of its one event id. */
export const JOIN_TURN_ID = turnIdOf([JOIN_EVENT_ID]);
/** The JOIN run's one outbox row, S1-02's question: default 131's id with the turn's own id as the turn key. */
export const JOIN_ROW_ID = rowIdOf("outbox", "S1-02", JOIN_TURN_ID, 1);

/** A bundle id (K-01 v1 manifest.bundleId). */
export interface BundleIdValue {
  readonly hash: string;
  readonly build: number;
}

/** Bundle v0 as published: its id, the parts the prompt layout reads, and its flow A always-on rules' hash. */
export interface PublishedBundle {
  readonly bundleId: BundleIdValue;
  /** Its manifest and its flow A graph, as T-364's prompt cache reads a bundle. */
  readonly cache: CacheBundle;
  /** Flow A's routing.alwaysOn.prefixSha256: the rules prefix a context on this bundle names (K-02 context.alwaysOn). */
  readonly prefixSha256: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A K-01 v1 KV key: bundle/<hash>/<build>/<part>. */
const keyOf = (bundleId: BundleIdValue, part: string): string =>
  `bundle/${bundleId.hash}/${String(bundleId.build)}/${part}`;

/**
 * Bundle v0 as bundles/v0/bundle.kv.json publishes it: the id its manifest names under its own manifest key (as the
 * runtime's bundle port double reads it: runtime/src/wiring/test-support.ts BUNDLE_V0), and that bundle's flow A graph.
 */
export function bundleV0(): PublishedBundle {
  const raw = JSON.parse(readFileSync(BUNDLE_V0_KV_FILE, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("bundles/v0/bundle.kv.json is not a list of KV parts");
  const list: readonly unknown[] = raw;
  const parts = new Map<string, string>();
  for (const part of list) {
    if (isRecord(part) && typeof part.key === "string" && typeof part.value === "string")
      parts.set(part.key, part.value);
  }
  for (const [key, text] of parts) {
    if (!key.endsWith("/manifest")) continue;
    const manifest = JSON.parse(text) as unknown;
    const named = isRecord(manifest) && isRecord(manifest.bundleId) ? manifest.bundleId : null;
    if (named === null || typeof named.hash !== "string" || typeof named.build !== "number") continue;
    const bundleId: BundleIdValue = { hash: named.hash, build: named.build };
    if (key !== keyOf(bundleId, "manifest")) continue;
    const flowText = parts.get(keyOf(bundleId, "flow/A"));
    if (flowText === undefined) throw new Error("bundle v0 holds no flow A graph under its own id");
    const flow = JSON.parse(flowText) as CacheFlow;
    return {
      bundleId,
      cache: { manifest: manifest as CacheBundle["manifest"], flows: { A: flow } },
      prefixSha256: flow.routing.alwaysOn.prefixSha256,
    };
  }
  throw new Error("bundles/v0/bundle.kv.json holds no manifest under its own bundle id");
}

/** What a step says first (K-01 step say[0]): the master's line, and its card's lines, each word for word. */
export interface FirstSay {
  readonly text: string;
  readonly cardLines: readonly string[];
}

/**
 * What `stepId` says first in a published bundle's flow A graph, read under the bundle's own id (K-01
 * flows.A.steps.<id>.say[0]): the master's line, which a row's compose input carries as its masterText, and its card's
 * lines, which it carries as term facts, word for word (K-09 v1.6; K-03 v1.1 README "v1.1").
 */
export function firstSayOf(bundle: PublishedBundle, stepId: string): FirstSay {
  const steps: unknown = bundle.cache.flows.A?.steps;
  const step = isRecord(steps) ? steps[stepId] : undefined;
  const says: unknown = isRecord(step) ? step.say : undefined;
  const first: unknown = Array.isArray(says) ? (says as readonly unknown[])[0] : undefined;
  const elements: unknown = isRecord(first) ? first.elements : undefined;
  const card: unknown = isRecord(elements) ? elements.card : undefined;
  const lines: unknown = isRecord(card) ? card.lines : undefined;
  if (!isRecord(first) || typeof first.text !== "string" || !Array.isArray(lines))
    throw new Error(`bundle v0's flow A says nothing with a card at ${stepId}`);
  const cardLines: string[] = [];
  for (const line of lines as readonly unknown[]) {
    if (typeof line !== "string") throw new Error(`a card line of ${stepId} in bundle v0 is not words`);
    cardLines.push(line);
  }
  return { text: first.text, cardLines };
}
