// The program infra/scripts/flags.sh runs (T-569; build prompt 5.4, deploy step 4; ADR-010; D-017). It reads the flag
// sets in this folder and writes the release_flags table through T-185's calls (db/repo/flags.ts) on the database that
// flags.sh names in DATABASE_URL and DB_SCHEMA (db/repo/client.ts reads them). Run it through flags.sh, which picks the
// database and refuses --env production.
//
//   apply [--record <file>]  sets every flag of the staging set (staging.json) at the global scope: a missing row is
//                            made, a row holding the other value is switched (compare-and-set on its version), a row
//                            already right is left as it is. --record appends the name of each flag it turned on, one
//                            per line, as soon as it is on, for deploy-staging.sh's undo.
//   off <flag>               turns the flag off in every scope it has a row in (global, a business's, a phone's), so it
//                            reads off for every request: D-017's rollback is `off skeleton`. A name that no flag set
//                            names and no row holds is refused, so a typo never passes for a flag turned off.
//   list                     every flag row: name, scope, on or off, version.
//
// A flag set is {"$comment", "environment", "flags": {<name>: true or false}}. Production's set names every flag of
// staging's, so production's value is always stated. There is no `on`: a flag goes on only through a flag set that an
// approved card changed (BP 5.4: "the flags the approved cards name"), and going forward after a rollback needs the
// normal approval. Never printed: a connection string or a phone number (a phone's scope shows without its number).
// Exit: 0 done; 1 refused or failed; 2 misuse.
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SETS = ["staging", "production"];
const SET_FIELDS = new Set(["$comment", "environment", "flags"]);
// release_flags_name_form (db/migrations/0006_core_bundle_registry_flags.sql).
const FLAG_NAME = /^[a-z][a-z0-9_.-]*$/;
const GLOBAL = "global";
const OFF_TRIES = 5;
const USAGE = "usage: flags.sh [--env staging|local] (apply [--record <file>] | off <flag> | list)";

/** A command line this program does not take (exit 2). */
class Misuse extends Error {}
/** A request refused, with nothing changed past what the lines before it say (exit 1). */
class Refusal extends Error {}

// db/repo/*.ts import each other without an extension, as the bundler resolves them; Node completes a relative import
// from a .ts file with `.ts` or `/index.ts` here, as compiler/src/cli/commands/publish.ts does for the same files.
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

/** Removes the database's connection string from a message; replaced by db/repo/client.ts's redact once loaded. */
let hide = (text) => text.split(process.env.DATABASE_URL || "\u0000").join("[redacted]");

function say(line) {
  console.log(`[${new Date().toISOString().replace(/\.\d+Z$/, "Z")}] flags: ${line}`);
}

/** A scope as it may be printed: a phone's number never is. */
function scopeLabel(scope) {
  return scope.startsWith("phone:") ? "phone (number not shown)" : scope;
}

const state = (enabled) => (enabled ? "on" : "off");

function parse(argv) {
  const [command, ...rest] = argv;
  if (command === "apply") {
    if (rest.length === 0) return { command, record: null };
    if (rest.length === 2 && rest[0] === "--record" && rest[1] !== "") return { command, record: rest[1] };
  } else if (command === "off") {
    if (rest.length === 1) return { command, flag: rest[0] };
  } else if (command === "list") {
    if (rest.length === 0) return { command };
  } else if (command === "on") {
    throw new Misuse(
      "there is no on: a flag goes on only through a flag set an approved card changed (flags.sh apply), and going forward after a rollback needs the normal approval (build prompt 5.4)",
    );
  }
  throw new Misuse(USAGE);
}

/** The flag set of `name` (staging or production), checked: {flag name: true or false}. */
function readSet(name) {
  const where = `infra/flags/${name}.json`;
  let set;
  try {
    set = JSON.parse(readFileSync(path.join(HERE, `${name}.json`), "utf8"));
  } catch (error) {
    throw new Refusal(`${where} cannot be read as JSON (${error.message})`);
  }
  if (typeof set !== "object" || set === null || Array.isArray(set))
    throw new Refusal(`${where} is not an object`);
  for (const field of Object.keys(set)) {
    if (!SET_FIELDS.has(field)) throw new Refusal(`${where}: unknown field "${field}"`);
  }
  if ("$comment" in set && typeof set.$comment !== "string")
    throw new Refusal(`${where}: $comment is not text`);
  if (set.environment !== name) throw new Refusal(`${where}: environment must be "${name}"`);
  const { flags } = set;
  if (typeof flags !== "object" || flags === null || Array.isArray(flags))
    throw new Refusal(`${where}: flags is not an object`);
  for (const [flag, enabled] of Object.entries(flags)) {
    if (!FLAG_NAME.test(flag))
      throw new Refusal(`${where}: "${flag}" is not a flag name ([a-z][a-z0-9_.-]*)`);
    if (typeof enabled !== "boolean") throw new Refusal(`${where}: ${flag} must be true or false`);
  }
  return flags;
}

/** Both flag sets, checked, and production's naming every flag of staging's. */
function readSets() {
  const sets = Object.fromEntries(SETS.map((name) => [name, readSet(name)]));
  const unstated = Object.keys(sets.staging).filter((flag) => !(flag in sets.production));
  if (unstated.length > 0)
    throw new Refusal(
      `infra/flags/production.json does not name ${unstated.join(", ")}: it states production's value of every staging flag`,
    );
  return sets;
}

/** Sets each flag of `flags` at the global scope (see the top of this file). */
async function apply(sql, calls, flags, record) {
  const names = Object.keys(flags);
  if (names.length === 0) say("the staging flag set names no flag: nothing to set");
  for (const name of names) {
    const enabled = flags[name];
    const row = await calls.getFlag(sql, name, GLOBAL);
    if (row === null) {
      const made = await calls.createFlag(sql, { name, scope: GLOBAL, enabled });
      if (enabled && record !== null) appendFileSync(record, `${name}\n`);
      say(`${name}: ${state(enabled)} (a new global row, version ${made.version})`);
    } else if (row.enabled === enabled) {
      say(`${name}: ${state(enabled)}, unchanged (version ${row.version})`);
    } else {
      const result = await calls.updateFlag(sql, name, GLOBAL, row.version, { enabled });
      if (!result.ok)
        throw new Refusal(`${name}: its row changed while this ran (another caller); run apply again`);
      if (enabled && record !== null) appendFileSync(record, `${name}\n`);
      say(`${name}: ${state(enabled)}, was ${state(row.enabled)} (version ${result.row.version})`);
    }
  }
}

/** One row turned off, compare-and-set on its version, read again when another caller changed it meanwhile. */
async function rowOff(sql, calls, first) {
  let row = first;
  for (let tries = 1; row !== null; tries += 1) {
    const where = `${row.name} ${scopeLabel(row.scope)}`;
    if (!row.enabled) {
      say(`${where}: off already (version ${row.version})`);
      return;
    }
    if (tries > OFF_TRIES)
      throw new Refusal(
        `${where}: changed by another caller ${OFF_TRIES} times while turning it off; run off again`,
      );
    const result = await calls.updateFlag(sql, row.name, row.scope, row.version, { enabled: false });
    if (result.ok) {
      say(`${where}: off, was on (version ${result.row.version})`);
      return;
    }
    row = result.current;
  }
}

/** Turns `name` off in every scope (see the top of this file). */
async function turnOff(sql, calls, sets, name) {
  if (!FLAG_NAME.test(name)) throw new Misuse(`"${name}" is not a flag name ([a-z][a-z0-9_.-]*)`);
  const rows = await calls.listFlags(sql, name);
  if (rows.length === 0) {
    if (!SETS.some((set) => name in sets[set]))
      throw new Refusal(
        `no flag "${name}": no row holds it and no flag set names it (a typo?); nothing changed`,
      );
    say(`${name}: off, with no row, so it reads off for every request`);
    return;
  }
  for (const row of rows) await rowOff(sql, calls, row);
  const still = (await calls.listFlags(sql, name)).filter((row) => row.enabled);
  if (still.length > 0)
    throw new Refusal(`${name}: still on in ${still.length} scope(s) after turning it off; run off again`);
  say(`${name}: off in every scope (${rows.length} ${rows.length === 1 ? "row" : "rows"})`);
}

async function list(sql, calls) {
  const rows = await calls.listFlags(sql);
  if (rows.length === 0) say("no flag rows: every flag reads off");
  for (const row of rows)
    say(`${row.name} ${scopeLabel(row.scope)}: ${state(row.enabled)} (version ${row.version})`);
}

async function main() {
  const given = parse(process.argv.slice(2));
  const sets = readSets();
  const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
  const client = await load("db/repo/client.ts");
  hide = (text) => client.redact(text, [client.resolvePrimaryUrl()]);
  const calls = await load("db/repo/flags.ts");
  const db = client.createClient({ max: 1 });
  try {
    if (given.command === "apply") await apply(db.primary, calls, sets.staging, given.record);
    else if (given.command === "off") await turnOff(db.primary, calls, sets, given.flag);
    else await list(db.primary, calls);
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof Misuse) {
    console.error(`flags.sh: ${error.message}`);
    process.exitCode = 2;
  } else if (error instanceof Refusal) {
    console.error(`flags.sh: refused: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`flags.sh: failed: ${hide(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
