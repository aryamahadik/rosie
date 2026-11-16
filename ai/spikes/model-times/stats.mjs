// The spike's maths (T-362): percentiles, per-cell summaries, arch 04's budgets beside them, and Q-41's reply path.
// Pure functions over numbers and labels; nothing here reads a file, the network or a key.
//
// Percentiles are nearest-rank: the p-th percentile of n values is the ceil(p/100 * n)-th smallest, so it is always a
// time that was measured, never one made up between two. With n under 20, the p95 is the largest value (n = 5: the 5th
// of 5), which is what at most 40 smoke-size calls can show; FINDINGS.md says so beside every p95.

/** The nearest-rank p-th percentile of `values` (0 < p <= 100), or null when there are none. */
export function percentile(values, p) {
  if (typeof p !== "number" || !(p > 0 && p <= 100))
    throw new RangeError("p is a percentage above 0, at most 100");
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** n, min, p50, p95 and max of `values` (each null when there are none). */
export function summary(values) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    n: numbers.length,
    min: numbers.length === 0 ? null : Math.min(...numbers),
    p50: percentile(numbers, 50),
    p95: percentile(numbers, 95),
    max: numbers.length === 0 ? null : Math.max(...numbers),
  };
}

/**
 * Arch 04 "Latency budget targets" (architecture.txt lines 203 to 231), in milliseconds. `upper` is the budget's upper
 * end; `lower` the lower end of a range ("Decide | 2–4 s"); `timeoutMs` what each model call of the stage times out at
 * (line 231: twice the stage's upper budget, except the safety read at 2 s per model; ai/src/gateway STAGE_TIMEOUT_MS).
 */
export const BUDGETS = Object.freeze({
  ack: { line: 207, label: "Acknowledge the webhook", upper: 1000 },
  safetyRead: { line: 209, label: "Safety read, on arrival", upper: 2000, timeoutMs: 2000 },
  safetyLine: { line: 211, label: "Safety line, from arrival", upper: 5000 },
  batch: { line: 213, label: "Batch of texts (after the last)", upper: 3000 },
  frontier: { line: 215, label: "Build the frontier", upper: 150 },
  search: { line: 217, label: "Search, one indexed query (DD)", upper: 200 },
  decide: { line: 219, label: "Decide", lower: 2000, upper: 4000, timeoutMs: 8000 },
  reread: { line: 221, label: "Sonnet re-read, on disagreement", lower: 3000, upper: 6000, timeoutMs: 12000 },
  gate: { line: 223, label: "Gate and commit", upper: 300 },
  write: { line: 225, label: "Write the reply, or one rewrite", lower: 2000, upper: 3000, timeoutMs: 6000 },
  send: { line: 227, label: "Send", upper: 1000 },
  reply: { line: 229, label: "Reply, end to end", p50: 10000, p95: 18000 },
});

/** "within" when `ms` is at most the budget's upper end, "over" when above it, null with no measure. */
export function againstBudget(ms, upper) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return ms <= upper ? "within" : "over";
}

/**
 * Q-41's reply path, from the last text's arrival (Q-41's default: "Reply time is measured from the last text's arrival,
 * and a rewrite counts on top"): the fixed stages at their page budgets, the model stages as measured. `measured` holds
 * the model stages' times in ms (decide, reread, compose, rewrite), each a number or null when not measured. `search`
 * counts the one indexed query of a search turn (Q-41's own sum counts it; a turn with no search does not run it).
 */
export function replyPath(measured, { search = true, ack = false } = {}) {
  const fixed = [
    ["batch", BUDGETS.batch.upper],
    ["frontier", BUDGETS.frontier.upper],
    ...(search ? [["search", BUDGETS.search.upper]] : []),
    ["gate", BUDGETS.gate.upper],
    ["send", BUDGETS.send.upper],
    ...(ack ? [["ack", BUDGETS.ack.upper]] : []),
  ];
  const model = ["decide", "reread", "compose", "rewrite"].map((stage) => [stage, measured[stage] ?? null]);
  const missing = model.filter(([, ms]) => typeof ms !== "number").map(([stage]) => stage);
  const fixedMs = fixed.reduce((sum, [, ms]) => sum + ms, 0);
  const modelMs = missing.length > 0 ? null : model.reduce((sum, [, ms]) => sum + ms, 0);
  return {
    fixed: Object.fromEntries(fixed),
    model: Object.fromEntries(model),
    missing,
    fixedMs,
    modelMs,
    totalMs: modelMs === null ? null : fixedMs + modelMs,
  };
}

/** The page's own sum, as Q-41 makes it (every stage at its upper budget; the ack and the search counted). */
export function pageBudgetPath({ reread = true, rewrite = true } = {}) {
  return replyPath(
    {
      decide: BUDGETS.decide.upper,
      reread: reread ? BUDGETS.reread.upper : 0,
      compose: BUDGETS.write.upper,
      rewrite: rewrite ? BUDGETS.write.upper : 0,
    },
    { search: true, ack: true },
  );
}

/** Seconds with one decimal for a table ("2.4 s"), or "-" for no measure. */
export function seconds(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "-";
}

/** Whole milliseconds for a table ("2,412 ms"), or "-" for no measure. */
export function millis(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? `${Math.round(ms).toLocaleString("en-US")} ms` : "-";
}

/**
 * Groups `rows` by the cell `keyOf` names, keeping the cells in the order `order` lists (then any others, sorted), each
 * with the summary of its rows' `ms`, the count of rows each of `flags` marks (a timeout, a cold call), and, with `warm`,
 * the summary of the rows it holds warm (`warm`: n, p50, p95 and max of those alone).
 */
export function cells(rows, keyOf, { order = [], flags = {}, warm } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keys = [
    ...order.filter((key) => groups.has(key)),
    ...[...groups.keys()].filter((key) => !order.includes(key)).sort(),
  ];
  return keys.map((key) => {
    const group = groups.get(key);
    const counted = Object.fromEntries(
      Object.entries(flags).map(([name, test]) => [name, group.filter((row) => test(row)).length]),
    );
    const warmPart =
      warm === undefined ? {} : { warm: summary(group.filter((row) => warm(row)).map((row) => row.ms)) };
    return { key, ...summary(group.map((row) => row.ms)), ...counted, ...warmPart };
  });
}
