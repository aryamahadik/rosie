// Staging's gate reads (the D-017 path audit's P4a: ops/reviews/D-017-path-audit/order_d017.txt line 35; T-1398). T-1257
// made this file with its final signature (DL-757); T-1398 binds it and edits nothing else.
//
// T-1398 gives RootOptions.gateReads (../real.ts GateReads) from @rosie/actions' PostgreSQL pieces: the Tool API's scope on
// a HYPERDRIVE_APP client (part.db.toolApi), readOpenHolds and K-05 v1.4's safety reads on its transaction, the owner's
// read and the read-only sealer on HYPERDRIVE_JOB clients (part.db.runtime), the sealer with the SEALING_WRAP_KEY-only
// resolver it is handed (./secrets.ts), and `words` from the one BundleSafety adapter ./bundle-safety.ts makes, handed in
// by ./options.ts (DL-757; one source of the fixed lines' words: actions ports.ts SafetyWords). Until then: null, as the
// Worker's root has always handed: every gate fails closed inside the Tool API base, before anything is read or written,
// and nothing commits. Nothing here reads a binding.

import type { WrappingKeys } from "@rosie/db/repo/sealing";

import type { BundleSafetyLines, GateReads } from "../real";
import type { StagingPart } from "./part";

/** What T-1398's builder is handed (DL-757): the env, the root's handle, the resolver and the one BundleSafety adapter. */
export interface GatePart extends StagingPart {
  /** The SEALING_WRAP_KEY-only resolver (./secrets.ts), for the read-only sealer. */
  readonly keys: WrappingKeys;
  /** The one BundleSafety adapter (./bundle-safety.ts), the same instance as RootOptions.bundleSafety: null until made. */
  readonly bundleSafety: BundleSafetyLines | null;
}

/** RootOptions.gateReads for staging: null until T-1398 binds it, so every gate fails closed. */
export const stagingGateReads: (part: GatePart) => GateReads | null = () => null;
