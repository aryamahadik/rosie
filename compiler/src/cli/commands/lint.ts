// `compiler lint`: lints fixture set v1's master flows and trades as the build reads them, and writes the lint report
// K-01 v1 holds, every hit, and the manifest's journey ship list (T-160; C-065 to C-070; arch 12 line 592).
//
//   npm run cli --workspace compiler -- lint --out <dir> [--trades <id,id,...>]
//
//   --out     the folder to write, new or empty; a relative path is read from the folder npm was run in (INIT_CWD).
//   --trades  the trades to lint, by id (default: every trade of fixture set v1). The master's two flows are always linted.
//
// Each flow is linted with Master Corrections applied, by every lint rule (compiler/src/lint/report.ts lintRules). The
// folder then holds, each as UTF-8 JSON:
//   lint-report.json    K-01 v1 lintReport (contracts/bundle/fixtures/lint-report.json's shape): each rule run with its
//                       count of failing steps, and every failing step with its rule, flow, step, trade and, in its
//                       message, each hit's field, words and fix hint. Only an error that is not allowed fails a step.
//   lint-findings.json  every hit with its rule, level, flow, trade, step, field, words, fix hint and allowed: K-01's
//                       lintFailure holds no level, field, fix or allowed, so they ride beside the report.
//   journeys.json       K-01 v1 manifest.journeys, the ship list: each journey's steps and failing steps, and whether it
//                       may ship (only with none).
// The files are read back, and lint-report.json and each journey are validated against K-01 v1 (Ajv 2020-12, strict).
// It prints each rule's count, the hits by level, each journey's gate, and any failing step that no journey holds. It
// exits 0 once the files are written and sound, whatever the lint found: a failing step stays in the bundle and says so
// (contracts/bundle/README.md, "The lint in the bundle"); 1 when they are not sound; 2 for a command line it does not take.
//
// Node runs this file as TypeScript as it is (the CLI's note), and the compiler's modules import each other without a
// file extension, which Node's own resolver does not complete. So the lint and the validator are loaded only when the
// command runs, after a resolve hook that completes a relative import from a compiler .ts file with `.ts` or
// `/index.ts` (as cli/commands/build.ts does).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import type * as Validate from "../../emit/validate";
import type * as Trades from "../../load/trade";
import type * as Report from "../../lint/report";
import type { CliIo, Command } from "../index.ts";

let hooked = false;

/** Lets Node complete the compiler's extensionless relative imports (`./core` is `./core.ts`, `../path` `../path/index.ts`). */
function completeImports(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL ?? "";
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
        for (const suffix of [".ts", "/index.ts"]) {
          try {
            return nextResolve(`${specifier}${suffix}`, context);
          } catch {
            // not this form: try the next one
          }
        }
        throw error;
      }
    },
  });
}

/** The lint report module, the validator and the trade loader, loaded once the resolve hook is in place. */
async function loadModules(): Promise<{
  report: typeof Report;
  validate: typeof Validate;
  trades: typeof Trades;
}> {
  completeImports();
  const at = (path: string): string => new URL(path, import.meta.url).href;
  return {
    report: (await import(at("../../lint/report.ts"))) as typeof Report,
    validate: (await import(at("../../emit/validate.ts"))) as typeof Validate,
    trades: (await import(at("../../load/trade.ts"))) as typeof Trades,
  };
}

/** A command line this command does not take. */
class UsageError extends Error {
  override name = "UsageError";
}

const USAGE = "usage: lint --out <dir> [--trades <id,...>]";

const FLAGS = ["--out", "--trades"] as const;
type Flag = (typeof FLAGS)[number];

function parse(args: readonly string[]): Partial<Record<Flag, string>> {
  const out: Partial<Record<Flag, string>> = {};
  for (let k = 0; k < args.length; k += 2) {
    const flag = args[k] ?? "";
    const value = args[k + 1];
    if (!(FLAGS as readonly string[]).includes(flag)) throw new UsageError(`unknown argument "${flag}"`);
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (out[flag as Flag] !== undefined) throw new UsageError(`${flag} is given twice`);
    out[flag as Flag] = value;
  }
  if (out["--out"] === undefined) throw new UsageError("--out <dir> is required");
  return out;
}

/** A path from the command line: relative paths are read from the folder npm was run in. */
function fromCaller(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/** The files the command writes, in this order. */
const FILES = ["lint-report.json", "lint-findings.json", "journeys.json"] as const;

/** A value as the command writes it: JSON, two spaces, a newline at the end. */
function written(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

async function run(args: string[], io: CliIo): Promise<number> {
  let given: Partial<Record<Flag, string>>;
  try {
    given = parse(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.message);
    io.err(USAGE);
    return 2;
  }
  const outArg = given["--out"] ?? "";
  const out = fromCaller(outArg);
  if (existsSync(out) && readdirSync(out).length > 0) {
    io.err(`--out ${outArg}: the folder is not empty; the lint writes into a new or empty folder`);
    return 2;
  }
  const { report, validate, trades } = await loadModules();
  let ids: string[] | undefined;
  if (given["--trades"] !== undefined) {
    ids = given["--trades"].split(",").filter((id) => id !== "");
    const known = new Set(trades.listTradeIds());
    const unknown = ids.filter((id) => !known.has(id));
    if (ids.length === 0 || unknown.length > 0) {
      io.err(
        ids.length === 0
          ? "--trades names no trade"
          : `--trades: no trade ${unknown.join(", ")} in fixture set v1`,
      );
      return 2;
    }
  }

  const lintRun = report.lintFixtureSet(ids);
  const lint = report.lintReport(lintRun.results);
  const findings = report.lintFindings(lintRun);
  const gates = report.journeyGates(report.journeySteps(lintRun.steps), lint);
  const values: Record<(typeof FILES)[number], unknown> = {
    "lint-report.json": lint,
    "lint-findings.json": findings,
    "journeys.json": gates,
  };
  const texts = FILES.map((file) => ({ file, text: written(values[file]) }));
  mkdirSync(out, { recursive: true });
  for (const { file, text } of texts) writeFileSync(join(out, file), text, "utf8");

  // Read back: lint-report.json against K-01 v1 lintReport, each journey against journeyGate.
  const back = Object.fromEntries(
    FILES.map((file) => [file, JSON.parse(readFileSync(join(out, file), "utf8")) as unknown]),
  ) as Record<(typeof FILES)[number], unknown>;
  const problems = validate
    .checkBundlePart(back["lint-report.json"], "lintReport")
    .map((problem) => `lint-report.json ${problem}`);
  const journeys = back["journeys.json"];
  if (!Array.isArray(journeys)) problems.push("journeys.json is not a list of journeys");
  else
    (journeys as unknown[]).forEach((gate, k) => {
      for (const problem of validate.checkBundlePart(gate, "journeyGate"))
        problems.push(`journeys.json journey ${String(k + 1)} ${problem}`);
    });
  if (problems.length > 0) {
    io.err(`the lint files written to ${outArg} are not sound against K-01 v1:`);
    for (const problem of problems.slice(0, 40)) io.err(`  ${problem}`);
    return 1;
  }

  const tradeCount = (lintRun.results.length - 2) / 2;
  io.out(
    `linted the master's flows A and B and ${plural(tradeCount, "trade")} (${plural(lintRun.results.length, "flow")}), Master Corrections ${lintRun.corrections.join(", ")} applied, with ${plural(lintRun.rules.length, "rule")}: ${lintRun.rules.map((rule) => rule.check).join(", ")}`,
  );
  for (const rule of lint.rules) io.out(`rule ${rule.rule}: ${plural(rule.failures, "failing step")}`);
  const errors = findings.hits.filter((hit) => !hit.allowed && hit.level === "error").length;
  const warnings = findings.hits.filter((hit) => !hit.allowed && hit.level === "warning").length;
  const allowed = findings.hits.filter((hit) => hit.allowed).length;
  io.out(
    `hits: ${plural(errors, "error")} (${plural(lint.failures.length, "failing step")}, ${String(lint.failures.filter((failure) => failure.trade === null).length)} of the master's own), ${plural(warnings, "warning")}, ${String(allowed)} allowed; ${plural(findings.inherited, "trade hit")} the master's flow also has, reported once, at the master`,
  );
  for (const gate of gates)
    io.out(
      gate.ships
        ? `journey ${String(gate.journey)}: ships (${plural(gate.steps.length, "step")}, none failing)`
        : `journey ${String(gate.journey)}: does not ship (${plural(gate.failingSteps.length, "failing step")} of ${String(gate.steps.length)}: ${gate.failingSteps.slice(0, 12).join(", ")}${gate.failingSteps.length > 12 ? ", ..." : ""})`,
    );
  const held = new Set(gates.flatMap((gate) => gate.steps));
  const outside = [...new Set(lint.failures.map((failure) => failure.step))].filter((id) => !held.has(id));
  if (outside.length > 0)
    io.out(
      `failing steps no journey holds (section 13, S12-09 to S12-14, a trade's own steps): ${outside.slice(0, 20).join(", ")}${outside.length > 20 ? ", ..." : ""}`,
    );
  for (const { file, text } of texts)
    io.out(`wrote ${file} (${String(new TextEncoder().encode(text).length)} bytes)`);
  io.out(
    `read back from ${outArg} and validated against K-01 v1 (Ajv 2020-12, strict): lint-report.json as lintReport, each of the ${plural(gates.length, "journey")} in journeys.json as journeyGate`,
  );
  return 0;
}

export const command: Command = {
  name: "lint",
  summary:
    "Lint the master and the trades as the build reads them; write K-01's lint report and the ship list",
  run,
};
