// The spike's second source (T-362; the lead note DL-860, item 2): staging's own K-08 spans of real model calls, from a
// `wrangler tail --format json` capture the lead took (labels only, as staging logs them). It reads every portCall span
// to provider anthropic of one staging version, keeps each model call's purpose, model, ms, outcome and cache counts
// (each span once, by its span id), and prints the tables FINDINGS.md shows: per purpose and model, with the warm calls
// apart (report.mjs says what warm and cold mean), and decide's reads, joined from their calls.
//
//   node ai/spikes/model-times/staging-spans.mjs <capture> [--version <commit prefix>] [--since <UTC time>]
//
// By default: deploy 43's version (main c244c38, DL-836: deployed 17:42Z Nov 15). The capture is never copied into the
// repository, and nothing of it is printed but labels, counts and times: no trace id, event id, handle or word.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { formatMarkdown } from "./report.mjs";
import { BUDGETS, cells, millis, summary } from "./stats.mjs";

/** Deploy 43's commit (DL-836: main c244c38, the first staging version to make real model calls end to end). */
export const DEPLOY_43_VERSION = "c244c38";

/** A span joins the read before it when it starts within this long of that read's last end (step 2 follows step 1). */
export const READ_GAP_MS = 1000;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every span a tail capture's log lines hold: one JSON event per chunk, each log's first message a span's JSON line. */
export function spansOf(text) {
  const spans = [];
  for (const chunk of text.split(/\n(?=\{\n)/u)) {
    if (!chunk.trim().startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(chunk);
    } catch {
      continue;
    }
    for (const log of Array.isArray(event?.logs) ? event.logs : []) {
      const first = Array.isArray(log?.message) ? log.message[0] : undefined;
      if (typeof first !== "string") continue;
      try {
        const span = JSON.parse(first);
        if (isRecord(span) && span.msg === "span") spans.push(span);
      } catch {
        // not a span's line
      }
    }
  }
  return spans;
}

/**
 * Each real model call of one staging version (by commit prefix), from `since` on: one row per model call of a portCall
 * span to anthropic, each span once.
 */
export function modelCallRows(spans, { version = DEPLOY_43_VERSION, since = null } = {}) {
  const from = since === null ? -Infinity : Date.parse(since);
  const seen = new Set();
  const rows = [];
  for (const span of spans) {
    if (span.hop !== "portCall" || span.provider !== "anthropic" || !Array.isArray(span.model_calls))
      continue;
    if (typeof span.version !== "string" || !span.version.startsWith(version)) continue;
    if (typeof span.span_id !== "string" || seen.has(span.span_id)) continue;
    const at = Date.parse(span.at);
    if (!Number.isFinite(at) || at < from) continue;
    seen.add(span.span_id);
    for (const call of span.model_calls) {
      rows.push({
        trace: span.trace_id,
        at: span.at,
        purpose: call.purpose,
        model: call.model,
        ms: call.ms,
        outcome: call.outcome,
        cacheWrite: call.cache_write_tokens ?? 0,
        cachedRead: call.cached_tokens ?? 0,
      });
    }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** A call that answered and read its prefix from the cache (report.mjs: warm); one with no answer has no usage. */
export const warmRow = (row) => row.outcome === "ok" && row.cacheWrite === 0;

/**
 * Decide's reads from its calls: within one trace and purpose (decideFirst, decideCheck, reread), a call that starts
 * within READ_GAP_MS of the read's last end is the same read (step 2 after step 1); a later one starts a new read (the
 * turn's next try). A read's time is its first start to its last end; it is warm when every call of it is.
 */
export function decideReads(rows) {
  const reads = [];
  const open = new Map();
  for (const row of rows.filter((entry) =>
    ["decideFirst", "decideCheck", "reread"].includes(entry.purpose),
  )) {
    const start = Date.parse(row.at);
    const end = start + row.ms;
    const key = `${String(row.trace)}|${String(row.purpose)}`;
    const read = open.get(key);
    if (read !== undefined && start <= read.end + READ_GAP_MS) {
      read.end = Math.max(read.end, end);
      read.calls += 1;
      read.warm = read.warm && warmRow(row);
      continue;
    }
    const next = {
      trace: row.trace,
      purpose: row.purpose,
      model: row.model,
      start,
      end,
      calls: 1,
      warm: warmRow(row),
    };
    open.set(key, next);
    reads.push(next);
  }
  return reads.map((read) => ({ ...read, ms: read.end - read.start }));
}

/**
 * Decide's stages from its reads: a first read and a check read of one trace whose times overlap ran side by side, as
 * one decide (ai/src/decide/two-reads.ts); the stage runs from the earlier start to the later end, warm when both are.
 */
export function decideStages(reads) {
  const firsts = reads.filter((read) => read.purpose === "decideFirst");
  const checks = reads.filter((read) => read.purpose === "decideCheck");
  const stages = [];
  for (const first of firsts) {
    const check = checks.find(
      (candidate) =>
        candidate.trace === first.trace && candidate.start < first.end && first.start < candidate.end,
    );
    if (check === undefined) continue;
    const start = Math.min(first.start, check.start);
    const end = Math.max(first.end, check.end);
    stages.push({ ms: end - start, warm: first.warm && check.warm, models: `${first.model}+${check.model}` });
  }
  return stages;
}

const shortModel = (model) => (typeof model === "string" ? model.replace(/^claude-/u, "") : "-");

const PURPOSE_ORDER = [
  "safetyRead",
  "decideFirst",
  "decideCheck",
  "reread",
  "planner",
  "compose",
  "rewrite",
].flatMap((purpose) => [`${purpose} · haiku-5-5`, `${purpose} · sonnet-5-5`]);

/** The tables: each model call by purpose and model, decide's reads, and the safety read against its 2 s try. */
export function renderStaging(rows, { version = DEPLOY_43_VERSION } = {}) {
  const lines = [];
  lines.push(
    `Staging's spans of version ${version}: ${String(rows.length)} model calls from ${rows[0]?.at ?? "-"} to ` +
      `${rows.at(-1)?.at ?? "-"} (warm: read the prompt cache; cold: wrote it).`,
  );
  lines.push("");
  lines.push(
    "| Purpose · model | n | p50 | p95 | max | warm n | warm p50 | warm p95 | cold | timed out | failed |",
  );
  lines.push("| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |");
  for (const cell of cells(rows, (row) => `${String(row.purpose)} · ${shortModel(row.model)}`, {
    order: PURPOSE_ORDER,
    flags: {
      cold: (row) => row.cacheWrite > 0,
      timedOut: (row) => row.outcome === "timedOut",
      failed: (row) => row.outcome === "failed",
    },
    warm: warmRow,
  })) {
    lines.push(
      `| ${cell.key} | ${String(cell.n)} | ${millis(cell.p50)} | ${millis(cell.p95)} | ${millis(cell.max)} | ` +
        `${String(cell.warm.n)} | ${millis(cell.warm.p50)} | ${millis(cell.warm.p95)} | ${String(cell.cold)} | ` +
        `${String(cell.timedOut)} | ${String(cell.failed)} |`,
    );
  }
  const reads = decideReads(rows);
  if (reads.length > 0) {
    lines.push("");
    lines.push(
      `Decide's reads joined from the spans (a call starting within ${String(READ_GAP_MS)} ms of the read's last end ` +
        "is its next step):",
    );
    lines.push("");
    lines.push("| Read · model | n | p50 | p95 | max | warm n | warm p50 | warm p95 | budget |");
    lines.push("| --- | --: | --: | --: | --: | --: | --: | --: | --- |");
    for (const cell of cells(reads, (read) => `${read.purpose} · ${shortModel(read.model)}`, {
      order: PURPOSE_ORDER,
      warm: (read) => read.warm,
    })) {
      const budget = cell.key.startsWith("reread") ? BUDGETS.reread : BUDGETS.decide;
      lines.push(
        `| ${cell.key} | ${String(cell.n)} | ${millis(cell.p50)} | ${millis(cell.p95)} | ${millis(cell.max)} | ` +
          `${String(cell.warm.n)} | ${millis(cell.warm.p50)} | ${millis(cell.warm.p95)} | ` +
          `${String(budget.lower / 1000)}–${String(budget.upper / 1000)} s |`,
      );
    }
    const stages = decideStages(reads);
    const all = summary(stages.map((stage) => stage.ms));
    const warm = summary(stages.filter((stage) => stage.warm).map((stage) => stage.ms));
    lines.push(
      `| decide stage (first and check read side by side) | ${String(all.n)} | ${millis(all.p50)} | ` +
        `${millis(all.p95)} | ${millis(all.max)} | ${String(warm.n)} | ${millis(warm.p50)} | ${millis(warm.p95)} | ` +
        `${String(BUDGETS.decide.lower / 1000)}–${String(BUDGETS.decide.upper / 1000)} s |`,
    );
  }
  const haiku = rows.filter((row) => row.purpose === "safetyRead" && row.model === "claude-haiku-5-5");
  const answered = summary(haiku.filter((row) => row.outcome === "ok").map((row) => row.ms));
  const timedOut = haiku.filter((row) => row.outcome === "timedOut");
  /** How long the version had made no safety-read call before this one started (none before it: "the first"). */
  const quietBefore = (row) => {
    const earlier = rows.filter(
      (other) => other.purpose === "safetyRead" && Date.parse(other.at) < Date.parse(row.at),
    );
    if (earlier.length === 0) return "the version's first";
    const lastEnd = Math.max(...earlier.map((other) => Date.parse(other.at) + other.ms));
    return `${String(Math.round((Date.parse(row.at) - lastEnd) / 60_000))} min after the last safety read`;
  };
  lines.push("");
  lines.push(
    `Safety read, Haiku: ${String(haiku.length)} tries, ${String(timedOut.length)} timed out at the 2 s try ` +
      `(${timedOut.map((row) => `${row.at}, ${quietBefore(row)}`).join("; ") || "none"}); the ` +
      `tries that answered: p50 ${millis(answered.p50)}, p95 ${millis(answered.p95)}, max ${millis(answered.max)} ` +
      `(n ${String(answered.n)}).`,
  );
  const firsts = rows
    .filter((row) => row.purpose === "safetyRead")
    .slice(0, 4)
    .map(
      (row) =>
        `${row.at} ${shortModel(row.model)} ${row.outcome} ${millis(row.ms)}${row.cacheWrite > 0 ? " cold" : ""}`,
    );
  lines.push(`The version's first safety-read calls: ${firsts.join("; ") || "none"}.`);
  return lines.join("\n");
}

/** The options a command line gives, or null for one this program does not take. */
export function parseArgs(argv) {
  const [capture, ...rest] = argv;
  if (capture === undefined || capture === "" || capture.startsWith("--")) return null;
  const options = { capture, version: DEPLOY_43_VERSION, since: null };
  for (let k = 0; k < rest.length; k += 2) {
    const [flag, value] = [rest[k], rest[k + 1]];
    if (flag === "--version" && /^[0-9a-f]{7,40}$/u.test(value ?? "")) options.version = value;
    else if (flag === "--since" && Number.isFinite(Date.parse(value ?? ""))) options.since = value;
    else return null;
  }
  return options;
}

function runAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(
      "usage: node ai/spikes/model-times/staging-spans.mjs <capture> [--version <commit prefix>] [--since <UTC time>]\n",
    );
    process.exitCode = 2;
  } else {
    const spans = spansOf(readFileSync(args.capture, "utf8"));
    const rows = modelCallRows(spans, { version: args.version, since: args.since });
    process.stdout.write(await formatMarkdown(renderStaging(rows, { version: args.version })));
  }
}
