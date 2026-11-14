// Staging's K-05 calls at a turn's start (the D-017 path audit's P2b: ops/reviews/D-017-path-audit/order_d017.txt line 32;
// T-1395). T-1257 made this file with its final signature; T-1395 binds it and edits nothing else.
//
// T-1395 gives RootOptions.bundleReads (K-05 v1 item 7, db/repo/bundles.ts readActiveBundle and readBundleValue; the port
// carries no KV: KV stays the actor's BUNDLES binding), handleTargets (K-05 v1.2 item 27), frontierScope (K-05 v1.2 item
// 26's readTurnState under each call's business, @rosie/actions' pgFrontierScope over that call's own job client) and
// turnRows (K-05 v1.1 commitTurn and v1 parkTurn), every call on one job-side client (part.db.runtime). ./options.ts hands
// the bundle reads given here to the model readers (./models.ts: their manifest access, critic_collisions B6a) and to the
// bundle's safety lines (./bundle-safety.ts). Until then each is null, as the Worker's root has always handed: no turn's
// bundle is pinned, no targets are read, every frontier fails closed inside the Tool API base, every commit and park fails
// closed (../real.ts NoDatabaseError naming the call), and the gateway's trace names bundle v0's stand-in. Nothing here
// reads a binding.

import type { BundleReadCalls, FrontierScope, HandleTargetsCall, TurnRowCalls } from "../real";
import type { StagingPart } from "./part";

/** What T-1395's builder is handed: the env and the root's handle. */
export type TurnCallsPart = StagingPart;

/** The turn's four RootOptions inputs, each null where it is not bound. */
export interface TurnCallInputs {
  readonly bundleReads: BundleReadCalls | null;
  readonly handleTargets: HandleTargetsCall | null;
  readonly frontierScope: FrontierScope | null;
  readonly turnRows: TurnRowCalls | null;
}

/** None of the four bound: each fails closed as its port does with nothing bound. */
export const NO_TURN_CALL_INPUTS: TurnCallInputs = Object.freeze({
  bundleReads: null,
  handleTargets: null,
  frontierScope: null,
  turnRows: null,
});

/** RootOptions.bundleReads, handleTargets, frontierScope and turnRows for staging: all null until T-1395 binds them. */
export const stagingTurnCalls: (part: TurnCallsPart) => TurnCallInputs = () => NO_TURN_CALL_INPUTS;
