// Staging's model readers (the D-017 path audit's P3a: ops/reviews/D-017-path-audit/order_d017.txt line 33; T-1396).
// T-1257 made this file with its final signature (DL-757); T-1396 binds it and edits nothing else.
//
// T-1396 gives RootOptions.safetyReaders, deciders and composers: @rosie/ai's safety read, decide with its one re-read, and
// composer, one per bundle id, each built from that bundle's own manifest (and flow graphs), the model key read by name
// (ANTHROPIC_API_KEY, ../root.ts WorkerSecrets) from part.env at each call. Its part (DL-757) holds what that needs, so no
// other file is edited for it:
//   - bundleReads: P2b's bundle reads (./k05-turn.ts), handed in by ./options.ts, never imported from there: the manifest
//     access for the model readers (critic_collisions B6a), null until T-1395 binds them;
//   - kv: the actor's BUNDLES KV (../../bundle/kv.ts), read from the env at each call, null where none is bound: read first,
//     PostgreSQL's copy on a miss, as the pin reads (../../bundle/values.ts);
//   - fetch: the seam every model call goes through (critic_size B9), named in stagingOptions' signature: the global fetch
//     in the Worker, a test's double in a test.
// Until then each is null, as the Worker's root has always handed: every safety read, decide, re-read, compose and rewrite
// fails closed before any model call (../real.ts NoSafetyReaderError, NoDeciderError, NoComposerError). Nothing here reads
// a binding or a secret, and nothing calls fetch.

import type { FetchLike } from "@rosie/ai/src/gateway/types";

import type { BundleKv } from "../../bundle/types";
import type { BundleReadCalls, Composers, Deciders, SafetyReaders } from "../real";
import type { StagingPart } from "./part";

/** What T-1396's builder is handed (DL-757): the env, the root's handle, P2b's bundle reads, BUNDLES and the fetch seam. */
export interface ModelsPart extends StagingPart {
  /** P2b's bundle reads (./k05-turn.ts), as ./options.ts got them: null until T-1395 binds them. */
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

/** RootOptions.safetyReaders, deciders and composers for staging: all null until T-1396 binds them. */
export const stagingModels: (part: ModelsPart) => ModelReaderInputs = () => NO_MODEL_READER_INPUTS;
