// Staging's release flags (the D-017 path audit's P1c: ops/reviews/D-017-path-audit/order_d017.txt line 30; T-1393).
// T-1257 made this file with its final signature; T-1393 binds it and edits nothing else (./options.ts hands it its part).
//
// T-1393 gives RootOptions.flags (../skeleton.ts ReleaseFlags) over T-185's readFlag (db/repo/flags.ts), on one job-side
// client per read (part.db.runtime; release_flags is rosie_job's alone), answering `{ enabled }` alone. Until then: null,
// as the Worker's root has always handed, so the skeleton flag reads off and the Linq route answers 404 with nothing read,
// verified or reached (../skeleton.ts). Nothing here reads a binding.

import type { ReleaseFlags } from "../skeleton";
import type { StagingPart } from "./part";

/** What T-1393's builder is handed: the env (HYPERDRIVE_JOB, read by the handle at each call) and the root's handle. */
export type FlagsPart = StagingPart;

/** RootOptions.flags for staging: null until T-1393 binds it, so the skeleton flag reads off. */
export const stagingFlags: (part: FlagsPart) => ReleaseFlags | null = () => null;
