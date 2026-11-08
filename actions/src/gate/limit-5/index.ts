// Limit 5, Reserved (C-085; arch 06 line 307): a reservation row holds the worker, room, vehicle or seat. Its rule is
// T-303's, which replaces this file. Until then the fail-closed stub (T-298): every part that reaches limit 5 is refused,
// never passed.

import { notBuiltLimit } from "../framework/stub";

export const limit5 = notBuiltLimit(5);
