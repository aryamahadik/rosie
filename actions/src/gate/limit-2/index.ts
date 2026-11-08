// Limit 2, Owner rules (C-082; arch 06 line 301): one rule evaluator, shared with search, passes every typed rule. Its
// rule is T-300's, which replaces this file. Until then the fail-closed stub (T-298): every part that reaches limit 2 is
// refused, never passed.

import { notBuiltLimit } from "../framework/stub";

export const limit2 = notBuiltLimit(2);
