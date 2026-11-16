// The real model times spike's Node half (T-362; DL-860's lead note on the card). Run it through run.sh, which reads the
// key by name and hands it over on standard input; this program takes no key from its arguments or its environment.
//
//   bash ai/spikes/model-times/run.sh --dry-run [--out <folder>]
//       every unit against the local stub on 127.0.0.1 (stub.mjs): no key, no network. Prints the tables; writes the
//       results file only into --out.
//   bash ai/spikes/model-times/run.sh --live
//       the one live run: every unit against Anthropic's Messages endpoint, through the AI gateway's client and spans,
//       at most 40 calls in all (counting every call an earlier live run logged in runs/), never in CI. Writes its
//       results to runs/live-<time>.json and prints its tables for FINDINGS.md (report.mjs prints them again from the
//       file).
//
// Exit: 0 the run ran (a live run, whatever Anthropic answered); 1 a dry run's unit did not answer; 2 refused to start
// (misuse, CI set, no key, the cap, a file that cannot be read). Nothing printed or written holds the key, a prompt or
// an answer's words: labels, counts and times only.

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ANSWERED, formatMarkdown, renderRun } from "./report.mjs";
import { DRY_KEY, fixtureAnswers, startStub } from "./stub.mjs";
import {
  CALL_LIMIT,
  HERE,
  UNIT_KINDS,
  buildReaders,
  classifier,
  composerCases,
  decideContext,
  loadProduction,
  plannedCalls,
  readBundleV0,
  runUnit,
  safetyTexts,
  schedule,
} from "./units.mjs";
import { API_URL, createWire } from "./wire.mjs";

export const RUNS_DIR = join(HERE, "runs");
const USAGE = "usage: bash ai/spikes/model-times/run.sh --dry-run [--out <folder>] | --live";

/** Live calls the earlier live runs in `dir` logged (each runs/live-*.json's calls that went out). Throws if unreadable. */
export function liveCallsLogged(dir = RUNS_DIR) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let calls = 0;
  for (const name of names.filter((file) => /^live-.*\.json$/u.test(file))) {
    const results = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (!Array.isArray(results.wire)) throw new Error(`${name} holds no wire list`);
    calls += results.wire.filter((record) => record.local === undefined).length;
  }
  return calls;
}

/** The first line of standard input (the key, from run.sh), or "" from a terminal or an empty pipe. */
async function firstLine(stdin) {
  if (stdin === undefined || stdin === null || stdin.isTTY) return "";
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text.split("\n")[0].replace(/\r$/u, "");
}

/** The options a command line gives, or null for one this program does not take. */
export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--live") return { mode: "live", out: null };
  if (argv.length === 1 && argv[0] === "--dry-run") return { mode: "dry", out: null };
  if (argv.length === 3 && argv[0] === "--dry-run" && argv[1] === "--out" && argv[2] !== "")
    return { mode: "dry", out: argv[2] };
  return null;
}

async function formatJson(text, filePath) {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(filePath)) ?? {};
  return prettier.format(text, { ...options, parser: "json" });
}

const stamp = (iso) => iso.replace(/[:.]/gu, "-");

/** Runs the spike; returns the exit code. Every dependency can be handed in, for the tests. */
export async function main({
  argv,
  stdin,
  write = (line) => process.stdout.write(`${line}\n`),
  env = process.env,
  transport = globalThis.fetch,
  runsDir = RUNS_DIR,
  delays,
  clock = () => Date.now(),
}) {
  const args = parseArgs(argv);
  if (args === null) {
    write(`misuse (arguments are never echoed). ${USAGE}`);
    return 2;
  }
  if (env.CI !== undefined && env.CI !== "") {
    write("refused: CI is set; this spike never runs in CI (T-362, J-02).");
    return 2;
  }

  let key = DRY_KEY;
  let already = 0;
  if (args.mode === "live") {
    key = await firstLine(stdin);
    if (key.trim() === "") {
      write(
        "refused: no ANTHROPIC_API_KEY in the environment or .dev.vars (read by name in run.sh; never printed).",
      );
      return 2;
    }
    try {
      already = liveCallsLogged(runsDir);
    } catch {
      write(
        "refused: an earlier live run's results file cannot be read, so the calls made cannot be counted.",
      );
      return 2;
    }
    if (already + plannedCalls() > CALL_LIMIT) {
      write(
        `refused: earlier live runs logged ${String(already)} calls; this run plans ${String(plannedCalls())} ` +
          `and the card allows ${String(CALL_LIMIT)} in all.`,
      );
      return 2;
    }
  }
  // Defence in depth: no line this program writes can hold the key, even if a service ever echoed it.
  const say = (line) => write(key.length >= 8 ? String(line).split(key).join("[redacted]") : String(line));

  const production = await loadProduction();
  if (production.gateway.API_URL !== API_URL) {
    say("refused: the gateway's endpoint is not the one this spike allows.");
    return 2;
  }
  const bundle = readBundleV0();
  const cases = composerCases(production);
  const classify = classifier(production);
  const stub =
    args.mode === "dry"
      ? await startStub({ classify, answers: fixtureAnswers(production, cases), ...(delays && { delays }) })
      : null;
  try {
    const wire = createWire({
      mode: args.mode,
      transport,
      transportUrl: stub === null ? API_URL : stub.url,
      limit: CALL_LIMIT,
      already,
      classify,
    });
    const readers = buildReaders(production, bundle, {
      fetch: wire.fetch,
      env: Object.freeze({ [production.gateway.KEY_VARIABLE]: key }),
    });
    const inputs = {
      safetyTexts: safetyTexts(),
      context: (unit) => decideContext(bundle, `turn-spike-${unit.unit}`),
      composeInput: cases.composeInput,
      rewriteRequest: cases.rewriteRequest,
    };
    const startedAt = new Date(clock()).toISOString();
    say(
      `${args.mode} run: ${String(schedule().length)} units, ${String(plannedCalls())} calls planned; ` +
        `${String(already)} logged before; the cap is ${String(CALL_LIMIT)}.`,
    );
    const units = [];
    for (const unit of schedule()) {
      if (wire.left() < UNIT_KINDS[unit.kind].calls) {
        say(`stopped before ${unit.unit}: ${String(wire.left())} calls left under the cap.`);
        break;
      }
      const result = await runUnit({ production, bundle, readers, inputs, wire, unit });
      units.push(result);
      say(
        `${result.unit}: ${result.status} in ${String(result.wallMs)} ms (${String(wire.sent())} calls out)`,
      );
    }
    await wire.settle();
    const records = wire.records();
    const results = {
      spike: "T-362",
      mode: args.mode,
      startedAt,
      endedAt: new Date(clock()).toISOString(),
      bundle: { ...bundle.bundleId, promptVersions: bundle.promptVersions },
      models: bundle.models,
      limit: CALL_LIMIT,
      callsBefore: already,
      callsMade: wire.sent(),
      answeredHere: {
        injected: records.filter((record) => record.local === "injected").length,
        capped: records.filter((record) => record.local === "capped").length,
      },
      units: units.map((unit) => ({
        unit: unit.unit,
        kind: unit.kind,
        stage: unit.stage,
        status: unit.status,
        wallMs: unit.wallMs,
        reads: unit.reads,
      })),
      calls: units.flatMap((unit) => unit.rows),
      wire: records,
    };
    say("");
    for (const line of (await formatMarkdown(renderRun(results))).trimEnd().split("\n")) say(line);

    const text = `${JSON.stringify(results, null, 2)}\n`;
    if (args.mode === "live") {
      mkdirSync(runsDir, { recursive: true });
      const name = `live-${stamp(startedAt)}.json`;
      writeFileSync(join(runsDir, name), await formatJson(text, join(runsDir, name)));
      say(`written: runs/${name} (node ai/spikes/model-times/report.mjs <it> prints these tables again)`);
      return 0;
    }
    if (args.out !== null) {
      mkdirSync(args.out, { recursive: true });
      writeFileSync(join(args.out, "dry-run.json"), text);
    }
    const unanswered = units.filter((unit) => !ANSWERED.has(unit.status));
    say(unanswered.length === 0 ? "dry run: passed" : `dry run: FAILED (${String(unanswered.length)} units)`);
    return unanswered.length === 0 && units.length === schedule().length ? 0 : 1;
  } finally {
    await stub?.close();
  }
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
  process.exitCode = await main({ argv: process.argv.slice(2), stdin: process.stdin });
}
