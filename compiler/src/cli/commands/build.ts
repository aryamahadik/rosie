// `compiler build`: compiles fixture set v1 into a bundle directory that validates against K-01 v1 (T-149; C-058).
//
//   npm run cli --workspace compiler -- build --out <dir> [--trades <id,id,...>]
//                                           [--build <n> | --bundle-id <hash>/<build>]
//                                           [--built-at <utc>] [--prompts <file>] [--models <file>]
//
//   --out        the folder to write, new or empty; a relative path is read from the folder npm was run in (INIT_CWD).
//   --trades     the trades to compile, by id (default: every trade of fixture set v1).
//   --build      a numbered build (T-150; CQ-09; compiler/src/bundle-id): the bundle id is the content hash of the
//                compiled values, as K-01 v1 spells it, with build number n (a whole number from 1, counting publishes:
//                the publish picks it, T-152), and the manifest lists every input K-01 names with its sha256 (the two
//                flows, the trades, Master Corrections, LINES.md, the approved overlays, fixture set v1's manifest and
//                the reference scripts). After writing, the id is checked again from the files read back.
//                Without it, the bundle id and the inputs are the stand-ins (T-149) or the --bundle-id given.
//   --bundle-id  the bundle id, given whole (default: the stand-in, 64 zeros and build 1). Not with --build.
//   --built-at   when it was built, in UTC (default: the stand-in, the epoch: a build writes no clock time).
//   --prompts    a JSON file giving each prompt one turn runs on, safetyRead, decide, planner and composer, as
//                { "version": "...", "file": "<text file, from the JSON file's folder>" } or { "version", "text" }:
//                the AI engineer's (C-119). Default: the stand-in sample prompts.
//   --models     a JSON file { "models": { "haiku", "sonnet" }, "policy": { "low", "high", "reread" } }, the AI
//                engineer's (C-121). Default: the stand-in (arch 11 line 564; Q-26).
// It prints each stand-in it took, where each shared list came from, the size of the manifest, of each flow graph and of
// the trade overlays, and the tree's sha256: two builds from the same inputs print the same one.
//
// Node runs this file as TypeScript as it is (the CLI's note), and the compiler's modules import each other without a
// file extension, which Node's own resolver does not complete. So the emitter and the bundle id module are loaded only
// when the command runs, after a resolve hook that completes a relative import from a compiler .ts file with `.ts` or
// `/index.ts`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import type * as Ids from "../../bundle-id/index";
import type * as Emit from "../../emit/index";
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

/** The emitter, loaded once the resolve hook is in place. */
async function loadEmitter(): Promise<typeof Emit> {
  completeImports();
  return (await import(new URL("../../emit/index.ts", import.meta.url).href)) as typeof Emit;
}

/** The bundle id module (T-150), loaded once the resolve hook is in place. */
async function loadBundleIds(): Promise<typeof Ids> {
  completeImports();
  return (await import(new URL("../../bundle-id/index.ts", import.meta.url).href)) as typeof Ids;
}

/** A command line this command does not take. */
class UsageError extends Error {
  override name = "UsageError";
}

const USAGE =
  "usage: build --out <dir> [--trades <id,...>] [--build <n> | --bundle-id <hash>/<build>] [--built-at <utc>] [--prompts <file>] [--models <file>]";

const FLAGS = ["--out", "--trades", "--build", "--bundle-id", "--built-at", "--prompts", "--models"] as const;
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
  return out;
}

/** A path from the command line: relative paths are read from the folder npm was run in. */
function fromCaller(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function readJson(file: string, flag: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new UsageError(`${flag} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function prompts(file: string, kinds: readonly Emit.PromptKind[]): Emit.PromptTexts {
  const raw = readJson(file, "--prompts");
  if (typeof raw !== "object" || raw === null)
    throw new UsageError(`--prompts ${file}: expected a JSON object`);
  const out = {} as Emit.PromptTexts;
  for (const kind of kinds) {
    const entry = (raw as Record<string, unknown>)[kind] as Record<string, unknown> | undefined;
    if (entry === undefined || typeof entry.version !== "string")
      throw new UsageError(`--prompts ${file}: ${kind} needs a version and a file or a text`);
    let text: string;
    if (typeof entry.file === "string") text = readFileSync(resolve(dirname(file), entry.file), "utf8");
    else if (typeof entry.text === "string") text = entry.text;
    else throw new UsageError(`--prompts ${file}: ${kind} needs a file or a text`);
    out[kind] = { version: entry.version, text };
  }
  return out;
}

function bundleId(text: string): Emit.BundleId {
  const match = /^([0-9a-f]{64})\/([1-9][0-9]*)$/.exec(text);
  if (match === null) throw new UsageError(`--bundle-id ${text}: expected <64 lowercase hex>/<build number>`);
  return { hash: match[1] ?? "", build: Number(match[2]) };
}

function buildNumber(ids: typeof Ids, text: string): number {
  try {
    return ids.parseBuildNumber(text);
  } catch (error) {
    if (!(error instanceof ids.BundleIdError)) throw error;
    throw new UsageError(`--build ${text}: expected a build number, a whole number from 1`);
  }
}

/** The manifest's inputs counted by kind, in K-01's order, with each version written (Master Corrections'). */
function inputCounts(ids: typeof Ids, inputs: readonly Emit.InputFile[]): string {
  return ids.INPUT_KINDS.map((kind) => {
    const listed = inputs.filter((input) => input.kind === kind);
    const versions = listed.flatMap((input) => (input.version === undefined ? [] : [input.version]));
    return `${kind} ${String(listed.length)}${versions.length > 0 ? ` (${versions.join("; ")})` : ""}`;
  }).join(", ");
}

async function run(args: string[], io: CliIo): Promise<number> {
  let given: Partial<Record<Flag, string>>;
  try {
    given = parse(args);
    if (given["--out"] === undefined) throw new UsageError("--out <dir> is required");
    if (given["--build"] !== undefined && given["--bundle-id"] !== undefined)
      throw new UsageError(
        "--build and --bundle-id are given together: a numbered build makes its own bundle id",
      );
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.message);
    io.err(USAGE);
    return 2;
  }
  const emit = await loadEmitter();
  const ids = await loadBundleIds();
  const options: Emit.BuildOptions = {};
  let build: number | undefined;
  try {
    if (given["--trades"] !== undefined)
      options.trades = given["--trades"].split(",").filter((id) => id !== "");
    if (given["--build"] !== undefined) build = buildNumber(ids, given["--build"]);
    if (given["--bundle-id"] !== undefined) options.bundleId = bundleId(given["--bundle-id"]);
    if (given["--built-at"] !== undefined) options.builtAt = given["--built-at"];
    if (given["--prompts"] !== undefined)
      options.prompts = prompts(fromCaller(given["--prompts"]), emit.PROMPT_KINDS);
    if (given["--models"] !== undefined)
      options.routing = readJson(fromCaller(given["--models"]), "--models") as Emit.ModelRouting;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.message);
    return 2;
  }

  const out = fromCaller(given["--out"]);
  if (existsSync(out) && readdirSync(out).length > 0) {
    io.err(
      `--out ${given["--out"]}: the folder is not empty; a bundle is written into a new or empty folder`,
    );
    return 2;
  }
  const numbered = build === undefined ? null : await ids.buildNumberedBundle({ ...options, build });
  const built = numbered ?? (await emit.buildBundle(options));
  emit.writeBundle(out, built.files);
  const problems = emit.checkBundleDir(out);
  if (numbered !== null && problems.length === 0) {
    // The id again, from the files on disk: the content hash of the values read back is the id's hash.
    const back = emit.readBundleDir(out);
    problems.push(...ids.bundleIdProblems(back.bundle.manifest));
    const hash = ids.contentHashOfFiles(back.files);
    if (hash !== numbered.bundleId.hash)
      problems.push(`the content hash of the files read back is ${hash}, not ${numbered.bundleId.hash}`);
  }
  if (problems.length > 0) {
    io.err(`the bundle written to ${given["--out"]} is not sound:`);
    for (const problem of problems.slice(0, 40)) io.err(`  ${problem}`);
    return 1;
  }

  for (const standIn of built.standIns)
    io.out(`stand-in: ${standIn.what} from ${standIn.from} (the real one: ${standIn.owner})`);
  for (const [list, sources] of Object.entries(built.listSources))
    for (const source of sources) io.out(`list ${list}: ${source}`);
  if (numbered !== null) {
    const { hash, build: number } = numbered.bundleId;
    io.out(
      `bundle id: ${hash}/${String(number)}, the content hash of the ${String(built.files.length - 1)} stored values (K-01 v1) with build ${String(number)}`,
    );
    const inputs = built.bundle.manifest.inputs as Emit.InputFile[];
    io.out(`inputs: ${String(inputs.length)}, each with its sha256: ${inputCounts(ids, inputs)}`);
  }
  const sizes = built.files.map((file) => ({ path: file.path, bytes: emit.byteLength(file.text) }));
  const trades = sizes.filter((file) => file.path.startsWith("trade/"));
  for (const file of sizes)
    if (!file.path.startsWith("trade/")) io.out(`wrote ${file.path} (${String(file.bytes)} bytes)`);
  const largest = trades.reduce<(typeof trades)[number] | null>(
    (best, file) => (best === null || file.bytes > best.bytes ? file : best),
    null,
  );
  const total = trades.reduce((sum, file) => sum + file.bytes, 0);
  const most = largest === null ? "" : `; the largest ${largest.path}, ${String(largest.bytes)} bytes`;
  io.out(`wrote ${String(trades.length)} trade overlays in trade/ (${String(total)} bytes${most})`);
  const lint = built.bundle.manifest.lint as { rules: { rule: string; failures: number }[] };
  io.out(
    `lint marks K-01 v1's step checks ask for (the full lint is T-153 to T-160's): ${lint.rules
      .map((entry) => `${entry.rule} ${String(entry.failures)}`)
      .join(", ")}`,
  );
  io.out(
    `read back from ${given["--out"]} and validated against K-01 v1 (Ajv 2020-12, strict): the manifest, 2 flow graphs and ${String(trades.length)} trade overlays; each file's size and sha256 as the manifest's storage lists them`,
  );
  if (numbered !== null)
    io.out(
      `bundle id read back from ${given["--out"]}: the content hash of the stored values on disk is the id's hash`,
    );
  io.out(
    `tree sha256: ${emit.treeSha256(built.files)} (${String(built.files.length)} files in ${given["--out"]})`,
  );
  return 0;
}

export const command: Command = {
  name: "build",
  summary: "Compile fixture set v1 into a bundle directory that validates against K-01 v1",
  run,
};
