// The spike's tables (T-362): a run's results as FINDINGS.md shows them, beside arch 04's budgets, with Q-41's reply
// path and DL-836's question about the safety read's 2 s try. Labels and numbers only.
//
//   node ai/spikes/model-times/report.mjs <results.json>
//       prints a run's tables again from its results file (runs/live-<time>.json), formatted as the repository's
//       Prettier formats Markdown, ready to paste into FINDINGS.md.
//
// Warm and cold: a call that wrote the prompt cache (cache_write_tokens above 0) found its prefix uncached, so the model
// read the whole prompt: a cold call. A call that answered and wrote nothing read its prefix from the cache: a warm one.
// A call with no answer (timed out, failed) has no usage, so it is neither. A read or stage is warm when every call of
// it that went out is. The cache lives 5 minutes from its last read (ai/src/cache/rules.ts), so a busy bundle runs warm
// and a quiet one cold.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUDGETS,
  againstBudget,
  cells,
  millis,
  pageBudgetPath,
  replyPath,
  seconds,
  summary,
} from "./stats.mjs";
import { HERE, warmCall, wroteCache } from "./units.mjs";

/** `markdown` as the repository's Prettier formats it (its tables aligned), for printing. */
export async function formatMarkdown(markdown) {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(join(HERE, "FINDINGS.md"))) ?? {};
  return prettier.format(markdown, { ...options, parser: "markdown" });
}

const STAGE_ORDER = ["safety read", "decide", "re-read", "compose", "rewrite"];
const shortModel = (model) => (typeof model === "string" ? model.replace(/^claude-/u, "") : "-");

/** The rows of the stage table: which reads each takes, and the budget it is held to (arch 04). */
export const STAGE_ROWS = Object.freeze([
  {
    key: "safety-haiku",
    label: "Safety read, Haiku (its one try)",
    budget: BUDGETS.safetyRead,
    pick: (unit, read) => unit.kind === "safety-haiku" && read.purpose === "safetyRead",
  },
  {
    key: "safety-sonnet",
    label: "Safety read, Sonnet (after Haiku's try failed)",
    budget: BUDGETS.safetyRead,
    pick: (unit, read) => unit.kind === "safety-sonnet" && read.purpose === "safetyRead",
  },
  {
    key: "decide-haiku",
    label: "Decide read, Haiku (step 1, then step 2)",
    budget: BUDGETS.decide,
    pick: (unit, read) => unit.kind === "decide-pair" && read.stage === "decide",
  },
  {
    key: "decide-sonnet",
    label: "Decide read, Sonnet (a high-stakes first read)",
    budget: BUDGETS.decide,
    pick: (unit, read) => unit.kind === "decide-sonnet" && read.stage === "decide",
  },
  {
    key: "decide-stage",
    label: "Decide stage: two Haiku reads side by side (low stakes)",
    budget: BUDGETS.decide,
    wall: "decide-pair",
  },
  {
    key: "reread-sonnet",
    label: "Sonnet re-read (step 1, then step 2)",
    budget: BUDGETS.reread,
    pick: (unit, read) => unit.kind === "reread-sonnet" && read.purpose === "reread",
  },
  {
    key: "compose-haiku",
    label: "Composer call, Haiku",
    budget: BUDGETS.write,
    pick: (unit, read) => unit.kind === "compose-haiku" && read.purpose === "compose",
  },
  {
    key: "compose-sonnet",
    label: "Composer call, Sonnet (the gateway's fallback)",
    budget: BUDGETS.write,
    pick: (unit, read) => unit.kind === "compose-sonnet" && read.purpose === "compose",
  },
  {
    key: "rewrite-haiku",
    label: "One rewrite, Haiku",
    budget: BUDGETS.write,
    pick: (unit, read) => unit.kind === "rewrite-haiku" && read.purpose === "rewrite",
  },
]);

/** What a unit's production call answers when every call answered (any other unit is listed, never timed). */
export const ANSWERED = new Set(["verdict", "decided", "ok"]);

/**
 * Each stage row's times, `{ ms, warm }` each: its reads' (for the decide stage, its units' wall times, warm when both
 * reads are), from the units that answered.
 */
export function stageTimes(results) {
  const answered = results.units.filter((unit) => ANSWERED.has(unit.status));
  return Object.fromEntries(
    STAGE_ROWS.map((row) => {
      const times =
        row.wall === undefined
          ? answered.flatMap((unit) =>
              unit.reads
                .filter((read) => row.pick(unit, read))
                .map((read) => ({ ms: read.ms, warm: read.warm })),
            )
          : answered
              .filter((unit) => unit.kind === row.wall)
              .map((unit) => ({ ms: unit.wallMs, warm: unit.reads.every((read) => read.warm) }));
      return [row.key, times];
    }),
  );
}

/** Per stage and model, from the calls' spans that went out (never one answered here), with the warm ones apart. */
export function callCells(results) {
  return cells(
    results.calls.filter((row) => !row.injected && !row.capped),
    (row) => `${row.stage} · ${shortModel(row.model)}`,
    {
      order: STAGE_ORDER.flatMap((stage) => [`${stage} · haiku-5-5`, `${stage} · sonnet-5-5`]),
      flags: {
        timedOut: (row) => row.outcome === "timedOut",
        failed: (row) => row.outcome === "failed",
        cold: (row) => wroteCache(row),
      },
      warm: (row) => warmCall(row),
    },
  );
}

const budgetText = (budget) =>
  budget.lower === undefined
    ? `≤ ${seconds(budget.upper)}`
    : `${seconds(budget.lower)}–${seconds(budget.upper)}`;

const msOf = (times, { warmOnly = false } = {}) =>
  (times ?? []).filter((time) => !warmOnly || time.warm).map((time) => time.ms);

/** Q-41's reply path at a percentile of the measured stages (all reads, or the warm ones alone). */
export function q41Path(times, p, { warmOnly = false } = {}) {
  const at = (key) => summary(msOf(times[key], { warmOnly }))[p];
  return replyPath({
    decide: at("decide-stage"),
    reread: at("reread-sonnet"),
    compose: at("compose-haiku"),
    rewrite: at("rewrite-haiku"),
  });
}

/** DL-836: the safety read's Haiku try against its 2 s limit. */
export function safetyVerdict(results, times) {
  const haiku = summary(msOf(times["safety-haiku"]));
  const timedOut = results.calls.filter(
    (row) => row.purpose === "safetyRead" && !row.injected && !row.capped && row.outcome === "timedOut",
  ).length;
  return { ...haiku, timedOut, fits: haiku.p95 === null ? null : haiku.p95 <= BUDGETS.safetyRead.timeoutMs };
}

const pathLine = (name, value, target) =>
  value.totalMs === null
    ? `- ${name}: not measured (${value.missing.join(", ")} missing).`
    : `- ${name}: decide ${seconds(value.model.decide)} + re-read ${seconds(value.model.reread)} + compose ` +
      `${seconds(value.model.compose)} + one rewrite ${seconds(value.model.rewrite)} = ${seconds(value.modelMs)} of ` +
      `model time, plus ${seconds(value.fixedMs)} of fixed stages at their budgets (batch 3 s, frontier 0.15 s, ` +
      `search 0.2 s, gate 0.3 s, send 1 s) = **${seconds(value.totalMs)}** against ${seconds(target)}: ` +
      `${value.totalMs <= target ? "fits" : "does not fit"}.`;

/** The markdown block for a run: what was run, each call, each stage beside its budget, Q-41 and DL-836. */
export function renderRun(results) {
  const times = stageTimes(results);
  const lines = [];
  const wentOut = results.wire.filter((record) => record.local === undefined);
  lines.push(
    `Run: ${results.mode}, ${results.startedAt} to ${results.endedAt}; ${String(results.callsMade)} calls went out ` +
      `(${String(results.callsBefore)} before this run; the cap is ${String(results.limit)} in all); ` +
      `${String(results.answeredHere.injected)} answered here as overloaded (the fallback on purpose), ` +
      `${String(results.answeredHere.capped)} past the cap. Bundle ${results.bundle.hash.slice(0, 12)}…/` +
      `${String(results.bundle.build)}; prompts ${Object.entries(results.bundle.promptVersions)
        .map(([kind, version]) => `${kind} ${version}`)
        .join(", ")}.`,
  );
  const notAnswered = results.units.filter((unit) => !ANSWERED.has(unit.status));
  lines.push(
    notAnswered.length === 0
      ? `Every unit answered (${String(results.units.length)} units).`
      : `Units that did not answer, left out of the stage table: ${notAnswered
          .map((unit) => `${unit.unit} (${unit.status})`)
          .join(", ")}.`,
  );
  lines.push("");
  lines.push(
    "**Each model call** (its K-08 span's ms, as the gateway, or the safety read's own path, records it; warm: read " +
      "the prompt cache, cold: wrote it):",
  );
  lines.push("");
  lines.push(
    "| Stage · model | n | p50 | p95 | max | warm n | warm p50 | warm p95 | cold | timed out | failed |",
  );
  lines.push("| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |");
  for (const cell of callCells(results)) {
    lines.push(
      `| ${cell.key} | ${String(cell.n)} | ${millis(cell.p50)} | ${millis(cell.p95)} | ${millis(cell.max)} | ` +
        `${String(cell.warm.n)} | ${millis(cell.warm.p50)} | ${millis(cell.warm.p95)} | ${String(cell.cold)} | ` +
        `${String(cell.timedOut)} | ${String(cell.failed)} |`,
    );
  }
  const wire = summary(wentOut.map((record) => record.wireMs));
  lines.push("");
  lines.push(
    `Wire times (each call that went out, to its last byte, never cut by a stage's timer): n ${String(wire.n)}, ` +
      `p50 ${millis(wire.p50)}, p95 ${millis(wire.p95)}, max ${millis(wire.max)}.`,
  );
  lines.push("");
  lines.push(
    "**Each stage as a turn runs it**, beside arch 04's budget (architecture.txt lines 203 to 231):",
  );
  lines.push("");
  lines.push("| Stage | n | p50 | p95 | max | warm n | warm p50 | warm p95 | budget | p95 | warm p95 |");
  lines.push("| --- | --: | --: | --: | --: | --: | --: | --: | --- | --- | --- |");
  for (const row of STAGE_ROWS) {
    const all = summary(msOf(times[row.key]));
    const warm = summary(msOf(times[row.key], { warmOnly: true }));
    lines.push(
      `| ${row.label} | ${String(all.n)} | ${millis(all.p50)} | ${millis(all.p95)} | ${millis(all.max)} | ` +
        `${String(warm.n)} | ${millis(warm.p50)} | ${millis(warm.p95)} | ${budgetText(row.budget)} | ` +
        `${againstBudget(all.p95, row.budget.upper) ?? "-"} | ${againstBudget(warm.p95, row.budget.upper) ?? "-"} |`,
    );
  }
  lines.push("");
  lines.push(
    "**Q-41** (reply time from the last text's arrival: the low-stakes decide stage, the Sonnet re-read, one Haiku " +
      "composer call and one Haiku rewrite; a p95 line adds each stage's p95, an upper bound on the path's own p95):",
  );
  lines.push("");
  lines.push(pathLine("p50, every read", q41Path(times, "p50"), BUDGETS.reply.p50));
  lines.push(pathLine("p95, every read", q41Path(times, "p95"), BUDGETS.reply.p95));
  lines.push(pathLine("p95, warm reads alone", q41Path(times, "p95", { warmOnly: true }), BUDGETS.reply.p95));
  const page = pageBudgetPath();
  lines.push(
    `- The page's own budgets, every stage at its upper end with the ack: ${seconds(page.totalMs)} (before any ` +
      `rewrite: ${seconds(page.totalMs - BUDGETS.write.upper)}, Q-41's "about 18.5 s with a re-read").`,
  );
  const safety = safetyVerdict(results, times);
  lines.push("");
  lines.push(
    `**DL-836** (the safety read's 2 s try): Haiku's safety read p50 ${millis(safety.p50)}, p95 ` +
      `${millis(safety.p95)}, max ${millis(safety.max)} over ${String(safety.n)} reads; ${String(safety.timedOut)} ` +
      "safety-read calls timed out at 2 s in this run. " +
      (safety.fits === null
        ? "Not measured."
        : safety.fits
          ? "The p95 is inside the 2 s try."
          : "The p95 is past the 2 s try."),
  );
  return lines.join("\n");
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
  const [file, ...rest] = process.argv.slice(2);
  if (file === undefined || rest.length > 0) {
    process.stderr.write("usage: node ai/spikes/model-times/report.mjs <results.json>\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(await formatMarkdown(renderRun(JSON.parse(readFileSync(file, "utf8")))));
  }
}
