// Limit 4, Versions (C-084; arch 06 line 305): compare-and-set on every row the read-back showed. Its rule is T-302's,
// which replaces this file. Until then the fail-closed stub (T-298): every part that reaches limit 4 is refused, never
// passed.

import { notBuiltLimit } from "../framework/stub";

export const limit4 = notBuiltLimit(4);
