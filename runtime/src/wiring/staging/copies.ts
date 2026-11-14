// Staging's sources for the actor's copies (the D-017 path audit's P6c: ops/reviews/D-017-path-audit/order_d017.txt line
// 59; T-1306). T-1257 made this file with its final signature, and the copy deps' seam in ../root.ts install()
// (RootOptions.copies: install() sets them with the actor's other ports, `setCopyDeps`, whenever they are handed in), so
// T-1306 binds this file and edits nothing else (critic_collisions B6c).
//
// T-1306 gives the copies' two sources (../../actor/copies/types.ts CopyDeps): the live timers' reload (K-05 v1.12 item 56)
// and the stopped flag's re-read (item 57), each on one job-side client per call (part.db.runtime), from the primary,
// never a cache (DL-427). Until then: null, as the Worker's root has always left them, so install() sets nothing: each
// reload and re-read answers unwired, and the copy keeps the stricter reading. Nothing here reads a binding.

import type { CopyDeps } from "../../actor/copies/types";
import type { StagingPart } from "./part";

/** What T-1306's builder is handed: the env and the root's handle. */
export type CopiesPart = StagingPart;

/** RootOptions.copies for staging: null until T-1306 binds it, so install() sets no copy deps. */
export const stagingCopies: (part: CopiesPart) => CopyDeps | null = () => null;
