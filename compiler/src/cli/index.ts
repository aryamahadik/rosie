// The compiler's command line (T-132). Run it with the workspace script:
//
//   npm run cli --workspace compiler -- <command> [arguments]
//
// It runs the command files in src/cli/commands/, one file per command, so a later command (the loader's check, the
// compile, the lint, the publish) joins by adding a file there and nothing here changes. A command file exports a
// `command`:
//
//   import type { Command } from "../index.ts";
//   export const command: Command = {
//     name: "check-master",
//     summary: "Load both master flows and print their counts",
//     run(args, io) { io.out("..."); return 0; },
//   };
//
// `run` returns the exit code (0 is success). A file whose name starts with "_" or "." or that ends in ".test.ts" is
// not a command. Node 22 runs this file as TypeScript directly (it strips the types), so a command file that imports
// a value from another compiler file uses the `.ts` extension in the import path.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where a command writes: one line at a time, to the output or the error stream. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** One command of the CLI: its name on the command line, a one-line summary for `help`, and what it runs. */
export interface Command {
  name: string;
  summary: string;
  run(args: string[], io: CliIo): number | Promise<number>;
}

/** The folder the CLI reads its commands from. */
export const COMMANDS_DIR = fileURLToPath(new URL("./commands/", import.meta.url));

const COMMAND_FILE = /^[^_.].*\.(ts|mts|js|mjs)$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.run === "function"
  );
}

/** The command files of `dir`, in name order. A missing folder has none. */
export function commandFiles(dir: string = COMMANDS_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => COMMAND_FILE.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .sort()
    .map((name) => `${dir.replace(/\/+$/, "")}/${name}`);
}

/** Loads every command file of `dir` and returns the commands by name. A file with no valid `command` is an error. */
export async function loadCommands(dir: string = COMMANDS_DIR): Promise<Map<string, Command>> {
  const commands = new Map<string, Command>();
  for (const file of commandFiles(dir)) {
    const loaded = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const command = loaded.command;
    if (!isCommand(command))
      throw new Error(
        `${file}: expected an export named "command" with a name, a summary and a run function`,
      );
    if (!COMMAND_NAME.test(command.name))
      throw new Error(
        `${file}: "${command.name}" is not a command name (lowercase letters, digits and dashes)`,
      );
    const clash = commands.get(command.name);
    if (clash) throw new Error(`${file}: the command "${command.name}" is already defined by another file`);
    commands.set(command.name, command);
  }
  return commands;
}

function listCommands(commands: Map<string, Command>, io: CliIo): void {
  io.out("usage: npm run cli --workspace compiler -- <command> [arguments]");
  if (commands.size === 0) {
    io.out("No commands yet. A command is a file in compiler/src/cli/commands/ that exports `command`.");
    return;
  }
  io.out("commands:");
  const width = Math.max(...[...commands.keys()].map((name) => name.length));
  for (const command of commands.values()) io.out(`  ${command.name.padEnd(width)}  ${command.summary}`);
}

/** Runs the CLI for `argv` (the arguments after the script) and returns the exit code: 0 done, 1 failed, 2 misuse. */
export async function main(argv: string[], io: CliIo = STDIO, dir: string = COMMANDS_DIR): Promise<number> {
  try {
    const commands = await loadCommands(dir);
    const [name, ...args] = argv;
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      listCommands(commands, io);
      return 0;
    }
    const command = commands.get(name);
    if (!command) {
      io.err(`unknown command "${name}"`);
      listCommands(commands, io);
      return 2;
    }
    return await command.run(args, io);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const STDIO: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
