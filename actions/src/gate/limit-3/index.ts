// Limit 3, Exact yes (C-083; arch 06 line 303): the decider's own yes, bound to the read-back's exact text and versions.
// Its rule is T-301's, which replaces this file. Until then the fail-closed stub (T-298): every part that reaches limit 3
// is refused, never passed.

import { notBuiltLimit } from "../framework/stub";

export const limit3 = notBuiltLimit(3);
