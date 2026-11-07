#!/usr/bin/env node
// Frozen-contract guard: `node infra/ci/contract-freeze-guard.mjs` (T-005; ops/plan/02-contracts.md section 2
// item 10; build prompt 3.3). ES module, no dependencies; it runs git itself.
//
// A contract folder contracts/<name>/ may hold a frozen.json that marks versions frozen. Accepted shapes:
//   { "frozen": ["v1", "v1.1"] }     { "frozen": { "v1": { ...freeze record... } } }     ["v1"]
// A file takes its frozen versions from the NEAREST frozen.json between its own folder and contracts/<name>/.
// So contracts/db-schema/<part>/frozen.json governs that part alone (a part freezes on its own turn), while
// every other contract reads contracts/<name>/frozen.json as before.
// A branch fails when, compared with the merge-base of HEAD and origin/main, it edits or removes
//   - a schema or tables file whose name carries a frozen version (<name>.v1.schema.json, <part>.v1.tables.json),
//   - a fixture that fixtures/index.json lists for a frozen version (or, if unlisted, whose name carries one),
//   - an entry of fixtures/index.json for a frozen version, or
//   - a version in frozen.json (unfreezing).
// Adding files passes, and so does editing anything of a version that is not frozen. Which versions are frozen
// is read from frozen.json AS IT IS ON THE BASE, so one branch cannot unfreeze and edit together.
// A frozen version changes only by a new minor version: add <name>.v1.1.schema.json and new fixtures.
//
// Usage: node infra/ci/contract-freeze-guard.mjs [--base <ref>]   (default: origin/main)
// Exit code: 0 passed, 1 failed, 2 could not run (for example origin/main is missing).

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = "origin/main";
const USAGE = "Usage: node infra/ci/contract-freeze-guard.mjs [--base <ref>]   (default: origin/main)";

/** Stops the guard from running at all (exit code 2), as opposed to a failed check (exit code 1). */
export class GuardError extends Error {}

/** "v1.1" or "1.1" -> "1.1". */
export const normalizeVersion = (text) => String(text).trim().replace(/^v/i, "");

/** The version a file name carries: contracts/x/x.v1.1.schema.json -> "1.1"; undefined if none. */
export function versionOfFile(file) {
  const match = /\.v(\d+(?:\.\d+)*)\.[^/]*$/.exec(path.posix.basename(file));
  return match === null ? undefined : match[1];
}

/** The set of frozen versions in a frozen.json text (see the shapes above). Throws GuardError if unreadable. */
export function parseFrozen(text, where = "frozen.json") {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new GuardError(`${where} is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(data) ? data : data?.frozen;
  const versions = Array.isArray(list)
    ? list.map(normalizeVersion)
    : list !== null && typeof list === "object"
      ? Object.keys(list).map(normalizeVersion)
      : null;
  if (versions === null)
    throw new GuardError(`${where} must hold "frozen": [versions] or an object keyed by version`);
  return new Set(versions);
}

/** Version -> entry for each file listed in a fixtures/index.json text (shapes: array, or {fixtures: array|map}). */
export function parseFixtureIndex(text) {
  const entries = new Map();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return entries;
  }
  const list = Array.isArray(data) ? data : (data?.fixtures ?? data?.files ?? data);
  const add = (file, item) => {
    if (typeof file !== "string") return;
    const raw = item?.version ?? item?.for ?? item?.v;
    entries.set(file, { version: raw === undefined ? undefined : normalizeVersion(raw), item });
  };
  if (Array.isArray(list)) {
    for (const item of list) add(item?.file ?? item?.name ?? item?.path, item);
  } else if (list !== null && typeof list === "object") {
    for (const [file, item] of Object.entries(list)) add(file, item);
  }
  return entries;
}

/**
 * Decides which changed files break a freeze.
 * @param {{ status: string, file: string }[]} changes  git name-status entries against the base (A, M, D, T)
 * @param {(file: string) => string | undefined} readBase  text of a file at the base, undefined if absent
 * @returns {{ file: string, message: string }[]}
 */
export function checkFreeze(changes, readBase, readBranch = () => undefined) {
  const errors = [];
  const folderCache = new Map();
  // A folder's own frozen.json at the base: { path, versions }, or undefined when it has none.
  const frozenIn = (folder) => {
    if (!folderCache.has(folder)) {
      const text = readBase(`${folder}/frozen.json`);
      folderCache.set(
        folder,
        text === undefined
          ? undefined
          : { path: `${folder}/frozen.json`, versions: parseFrozen(text, `${folder}/frozen.json`) },
      );
    }
    return folderCache.get(folder);
  };
  // The frozen.json that governs a file: the nearest one at the base, looking from the file's own folder up to
  // contracts/<name>/. So contracts/db-schema/<part>/frozen.json governs that part alone, and a contract
  // without parts reads contracts/<name>/frozen.json as always.
  const governing = (file) => {
    const parts = file.split("/");
    for (let depth = parts.length - 1; depth >= 2; depth -= 1) {
      const found = frozenIn(parts.slice(0, depth).join("/"));
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const indexCache = new Map();
  const indexOf = (dir) => {
    if (!indexCache.has(dir)) {
      const text = readBase(`${dir}/fixtures/index.json`);
      indexCache.set(dir, text === undefined ? new Map() : parseFixtureIndex(text));
    }
    return indexCache.get(dir);
  };

  for (const { status, file } of changes) {
    if (status.startsWith("A")) continue;
    const parts = file.split("/");
    if (parts[0] !== "contracts" || parts.length < 3) continue;
    const folder = `contracts/${parts[1]}`;
    const governs = governing(file);
    if (governs === undefined || governs.versions.size === 0) continue;
    const frozen = governs.versions;
    const verb = status.startsWith("D") ? "removes" : "edits";
    const rest = parts.slice(2);

    if (parts[parts.length - 1] === "frozen.json" && governs.path === file) {
      const now = readBranch(file);
      let after = new Set();
      try {
        after = now === undefined ? new Set() : parseFrozen(now, file);
      } catch {
        // an unreadable frozen.json after the change is reported as an unfreeze below
      }
      for (const version of frozen) {
        if (!after.has(version)) {
          errors.push({
            file,
            message: `${file}: v${version} is frozen on the base; a freeze is never lifted`,
          });
        }
      }
      continue;
    }

    const fixturesAt = rest.indexOf("fixtures");
    if (fixturesAt !== -1) {
      const dir = [folder, ...rest.slice(0, fixturesAt)].join("/");
      const name = rest.slice(fixturesAt + 1).join("/");
      if (name === "index.json") {
        const before = indexOf(dir);
        const nowText = readBranch(file);
        const after = nowText === undefined ? new Map() : parseFixtureIndex(nowText);
        for (const [fixture, entry] of before) {
          const version = entry.version ?? versionOfFile(fixture);
          if (version === undefined || !frozen.has(version)) continue;
          const kept = after.get(fixture);
          if (kept === undefined || JSON.stringify(kept.item) !== JSON.stringify(entry.item)) {
            errors.push({
              file,
              message: `${file}: the index entry for ${fixture} (v${version}, frozen) changes or goes. Add fixtures for a new minor version instead.`,
            });
          }
        }
        continue;
      }
      const entry = indexOf(dir).get(name);
      const version = entry?.version ?? versionOfFile(name);
      if (version !== undefined && frozen.has(version)) {
        errors.push({
          file,
          message: `${file}: ${verb} a fixture of v${version}, which ${governs.path} marks frozen. Add a new minor version instead.`,
        });
      }
      continue;
    }

    const version = versionOfFile(file);
    if (version !== undefined && frozen.has(version) && /\.json$/i.test(file)) {
      errors.push({
        file,
        message: `${file}: ${verb} a file of v${version}, which ${governs.path} marks frozen. Add a new minor version file instead.`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------
// git

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 ** 3 });
  if (result.error) throw new GuardError(`could not run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr).trim() || `exit code ${result.status}`;
    throw new GuardError(`git ${args[0]} failed: ${detail}`);
  }
  return result;
}

const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** Runs the guard; returns the exit code. */
export function main(
  argv,
  { cwd = process.cwd(), env = process.env, write = (line) => console.log(line) } = {},
) {
  const github = env.GITHUB_ACTIONS === "true";
  const error = (message, file) =>
    write(
      github
        ? `::error ${file ? `file=${escapeProperty(file)},` : ""}title=Contract freeze guard::${escapeData(message)}`
        : `FAIL ${message}`,
    );
  let baseRef = DEFAULT_BASE;
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--help" || arg === "-h") {
      write(USAGE);
      return 0;
    }
    if (arg === "--base" && argv[k + 1] !== undefined) {
      baseRef = argv[k + 1];
      k += 1;
    } else if (arg.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length);
    } else {
      error(`unknown argument "${arg}". ${USAGE}`);
      return 2;
    }
  }
  try {
    if (baseRef === "" || baseRef.startsWith("-")) throw new GuardError(`"${baseRef}" is not a git ref`);
    const top = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (top.status !== 0) throw new GuardError("this is not inside a git repository");
    const root = top.stdout.trim();
    const found = git(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      allowFailure: true,
    });
    if (found.status !== 0) {
      throw new GuardError(
        `${baseRef} was not found. Run "git fetch origin main" first (CI checks out with fetch-depth: 0).`,
      );
    }
    const sha = found.stdout.trim();
    const mb = git(root, ["merge-base", "HEAD", sha], { allowFailure: true });
    const compare = mb.status === 0 && mb.stdout.trim() !== "" ? mb.stdout.trim() : sha;

    // Branch against the base, working tree included (so an uncommitted edit is caught too).
    const out = git(root, ["diff", "--name-status", "--no-renames", "-z", compare, "--", "contracts"]).stdout;
    const fields = out.split("\0").filter(Boolean);
    const changes = [];
    for (let k = 0; k + 1 < fields.length; k += 2) changes.push({ status: fields[k], file: fields[k + 1] });

    const readBase = (file) => {
      const shown = git(root, ["show", `${compare}:${file}`], { allowFailure: true });
      return shown.status === 0 ? shown.stdout : undefined;
    };
    const errors = checkFreeze(changes, readBase, (file) => readWorking(root, file));
    write(
      `contract freeze guard: ${changes.length} changed path(s) under contracts/ against ${compare.slice(0, 10)}`,
    );
    for (const e of errors) error(e.message, e.file);
    if (errors.length === 0) {
      write("contract freeze guard: passed");
      return 0;
    }
    write(`contract freeze guard: FAILED (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
    return 1;
  } catch (caught) {
    if (caught instanceof GuardError) {
      error(`contract freeze guard could not run: ${caught.message}`);
      return 2;
    }
    throw caught;
  }
}

function readWorking(root, file) {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return undefined;
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

if (runAsScript()) process.exitCode = main(process.argv.slice(2));
