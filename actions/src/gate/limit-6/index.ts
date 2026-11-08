// Limit 6, Values (C-086; arch 06 line 309): each value re-parses from its source words; dates resolve in the visit's
// zone. Its rule is T-304's, which replaces this file; a value that fails its words is a fail naming its fields, which
// the gate answers as valueFailsWords until decide's one re-read ran. Until then the fail-closed stub (T-298): every part
// that reaches limit 6 is refused, never passed.

import { notBuiltLimit } from "../framework/stub";

export const limit6 = notBuiltLimit(6);
