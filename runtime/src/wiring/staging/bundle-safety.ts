// Staging's bundle-backed safety lines (the D-017 path audit's P3b: ops/reviews/D-017-path-audit/order_d017.txt line 34;
// T-1397). T-1257 made this file with its final signature (DL-757); T-1397 binds it, and edits beside it only its ruled
// seam (DL-757 option (c): ../real.ts realSafetyRead and ../root.ts composeRoot's safetyRead input).
//
// T-1397 makes the one BundleSafety adapter (../real.ts BundleSafetyLines: fixedLine, outcomeLine and dangerWords, with
// checkPin), which ./options.ts puts in two places, so neither is edited for it:
//   - RootOptions.bundleSafety, which the root hooks at the pin (../root.ts Root.pin: checkedPin, where the state reads bind
//     real) and reads as the safety read's lines and danger words (../real.ts realStateReads);
//   - the gate's SafetyDeps.words (./tool-api-gate.ts, T-1398: one source of the fixed lines' words; actions ports.ts
//     SafetyWords; T-1242's note N3).
// Its part holds the reads a check needs besides the pin's own request: the actor's BUNDLES KV and P2b's bundle reads
// (./k05-turn.ts), the same ./models.ts is handed. Until then: null, as the Worker's root has always handed: each line read
// throws NoStateReadError, so the safety read fails before any model call and the actor applies its no-verdict rule, and
// the pin refuses every bundle (../real.ts checkedPin). Nothing here reads a binding.

import type { BundleKv } from "../../bundle/types";
import type { BundleReadCalls, BundleSafetyLines } from "../real";
import type { StagingPart } from "./part";

/** What T-1397's builder is handed: the env, the root's handle, the actor's BUNDLES KV and P2b's bundle reads. */
export interface BundleSafetyPart extends StagingPart {
  /** The actor's BUNDLES KV, read from the env at each call; null where the env binds none. */
  readonly kv: () => BundleKv | null;
  /** P2b's bundle reads (./k05-turn.ts), as ./options.ts got them: null until T-1395 binds them. */
  readonly bundleReads: BundleReadCalls | null;
}

/** RootOptions.bundleSafety for staging, the one adapter instance: null until T-1397 makes it. */
export const stagingBundleSafety: (part: BundleSafetyPart) => BundleSafetyLines | null = () => null;
