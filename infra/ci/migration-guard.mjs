#!/usr/bin/env node
// Migration guard: `npm run guard:migrations` (factory spec sections 3 and 5; build prompt 5.4).
// ES module, so strict mode is on. No dependencies; it runs git itself.
//
// Migrations only expand. For each .sql file under db/migrations/ that this branch adds or changes, compared
// with the merge-base of HEAD and origin/main, it fails on:
//   DROP TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|SCHEMA (also ALTER TABLE ... DROP <column> without COLUMN),
//   RENAME, ALTER ... TYPE, ALTER ... SET NOT NULL, ALTER ... DROP DEFAULT, TRUNCATE, DELETE FROM,
//   CREATE INDEX without CONCURRENTLY on a table this branch did not create,
//   and any change to, or removal of, a migration that is already on origin/main.
// A contracting change ships only in a file whose name contains _contract_. There the statement rules print a
// notice that the architect and the lead must review, instead of failing. Changing a merged migration fails
// even then.
//
// Comments and string literals are never checked. Function bodies (CREATE FUNCTION ... AS $$ ... $$) are not
// checked either, because they do not run during the migration; DO $$ ... $$ blocks are, because they do.
// A notice also flags a file migrate.mjs refuses: CREATE INDEX CONCURRENTLY mixed with other statements, or a
// `-- migrate:no-transaction` file with several statements that are not all CREATE INDEX CONCURRENTLY. A file of
// only CREATE INDEX CONCURRENTLY statements needs no marker (T-724, DL-061).
//
// Usage: node infra/ci/migration-guard.mjs [--base <ref>] [--dir <path>]
//        (defaults: origin/main, db/migrations)
// Exit code: 0 passed, 1 failed, 2 could not run (for example origin/main is missing).

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = "origin/main";
const DEFAULT_DIR = "db/migrations";
const TITLE = "Migration guard";
const USAGE =
  "Usage: node infra/ci/migration-guard.mjs [--base <ref>] [--dir <path>]   (defaults: origin/main, db/migrations)";

/** Stops the guard from running at all (exit code 2), as opposed to a failed check (exit code 1). */
export class GuardError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Reading SQL

/**
 * Blanks comments, string literals and dollar-quoted bodies (same length, newlines kept) and splits the SQL
 * into statements on semicolons.
 * @returns {{ start: number, text: string, bodies: { start: number, text: string }[] }[]}
 *   start: offset of the statement in `sql`; text: the blanked statement; bodies: its dollar-quoted bodies.
 */
export function splitStatements(sql) {
  const chars = sql.split("");
  const bodies = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (chars[k] !== "\n") chars[k] = " ";
  };
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      // PostgreSQL block comments nest.
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (sql[k] === "/" && sql[k + 1] === "*") {
          depth += 1;
          k += 2;
        } else if (sql[k] === "*" && sql[k + 1] === "/") {
          depth -= 1;
          k += 2;
        } else {
          k += 1;
        }
      }
      blank(i, k);
      i = k;
    } else if (ch === "'") {
      // E'...' strings take backslash escapes; every string doubles a quote to escape it.
      const backslashes = /[Ee]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      let k = i + 1;
      while (k < n) {
        if (backslashes && sql[k] === "\\") {
          k += 2;
        } else if (sql[k] === "'" && sql[k + 1] === "'") {
          k += 2;
        } else if (sql[k] === "'") {
          k += 1;
          break;
        } else {
          k += 1;
        }
      }
      blank(i, k);
      i = k;
    } else if (ch === '"') {
      // A quoted identifier stays readable, but a semicolon inside it does not end the statement.
      let k = i + 1;
      while (k < n) {
        if (sql[k] === '"' && sql[k + 1] === '"') {
          k += 2;
        } else if (sql[k] === '"') {
          k += 1;
          break;
        } else {
          k += 1;
        }
      }
      for (let j = i; j < k; j += 1) if (chars[j] === ";") chars[j] = " ";
      i = k;
    } else if (ch === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag === null) {
        i += 1;
      } else {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const bodyEnd = close === -1 ? n : close;
        bodies.push({ start: i + tag[0].length, end: bodyEnd });
        const stop = close === -1 ? n : close + tag[0].length;
        blank(i, stop);
        i = stop;
      }
    } else {
      i += 1;
    }
  }
  const blanked = chars.join("");
  const statements = [];
  let start = 0;
  for (let k = 0; k <= n; k += 1) {
    if (k < n && blanked[k] !== ";") continue;
    const text = blanked.slice(start, k);
    if (text.trim() !== "") {
      statements.push({
        start,
        text,
        bodies: bodies
          .filter((body) => body.start >= start && body.end <= k)
          .map((body) => ({ start: body.start, text: sql.slice(body.start, body.end) })),
      });
    }
    start = k + 1;
  }
  return statements;
}

// Identifiers, matched in upper-cased text.
const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Z_][A-Z0-9_$]*)`;
const QUALIFIED_NAME = String.raw`${NAME}(?:\s*\.\s*${NAME})?`;

const RULES = [
  {
    id: "drop",
    pattern: /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|SCHEMA)\b/g,
    what: (m) => `DROP ${m[1]}`,
  },
  {
    // ALTER TABLE t DROP c: the COLUMN keyword is optional in PostgreSQL.
    id: "drop",
    statement: /^\s*ALTER\s+TABLE\b/,
    pattern:
      /\bDROP\s+(?!(?:COLUMN|CONSTRAINT|DEFAULT|NOT|EXPRESSION|IDENTITY)\b)(?:IF\s+EXISTS\s+)?(?=["A-Z_])/g,
    what: () => "DROP COLUMN",
  },
  { id: "rename", pattern: /\bRENAME\b/g, what: () => "RENAME" },
  {
    id: "alter-type",
    pattern: new RegExp(
      String.raw`\bALTER\s+(?:(?:COLUMN|ATTRIBUTE)\s+)?${NAME}\s+(?:SET\s+DATA\s+)?TYPE\b`,
      "g",
    ),
    what: () => "ALTER ... TYPE",
  },
  { id: "set-not-null", pattern: /\bSET\s+NOT\s+NULL\b/g, what: () => "ALTER ... SET NOT NULL" },
  { id: "drop-default", pattern: /\bDROP\s+DEFAULT\b/g, what: () => "ALTER ... DROP DEFAULT" },
  // Not GRANT TRUNCATE ON ..., nor a trigger's BEFORE TRUNCATE ON / OR ...
  { id: "truncate", pattern: /\bTRUNCATE\b(?!\s*(?:ON\b|OR\b|,|\)|$))/g, what: () => "TRUNCATE" },
  { id: "delete", pattern: /\bDELETE\s+FROM\b/g, what: () => "DELETE FROM" },
];
const CREATE_INDEX = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(\s+CONCURRENTLY\b)?[\s\S]*?\bON\s+(?:ONLY\s+)?(${QUALIFIED_NAME})`,
  "g",
);
const CREATED_RELATION = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})`,
  "g",
);

const ADVICE = new Map([
  ["drop", "Drop it later, in its own file named NNNN_contract_<slug>.sql, once no live code uses it."],
  ["rename", "Add the new name next to the old one; remove the old one later in a _contract_ file."],
  ["alter-type", "Add a new column of the new type instead."],
  ["set-not-null", "Ship it later in a _contract_ file, once every live writer fills the column."],
  ["drop-default", "Live code may rely on the default: ship it later in a _contract_ file."],
  ["truncate", "Removing rows is a contracting change: ship it in a _contract_ file."],
  ["delete", "Removing rows is a contracting change: ship it in a _contract_ file."],
  [
    "create-index",
    "Use CREATE INDEX CONCURRENTLY (it does not block writes): either in a file of only CREATE INDEX CONCURRENTLY statements (no marker needed), or in a file whose first line is -- migrate:no-transaction that holds that one statement or several that are all CREATE INDEX CONCURRENTLY.",
  ],
]);
// migrate.mjs also runs a file outside a transaction when its first line is this marker.
const NO_TRANSACTION = /^--\s*migrate:no-transaction\s*$/;
const CONCURRENT_INDEX = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/;

// The table name used to match a CREATE INDEX with a CREATE TABLE: last part, unquoted, lower case.
function relationKey(name) {
  const parts = name.split(".");
  return (parts[parts.length - 1] ?? "").trim().replace(/^"|"$/g, "").replace(/""/g, '"').toLowerCase();
}

/** Tables and materialized views a migration creates (keys as relationKey gives them). */
export function createdRelations(sql) {
  const keys = [];
  for (const statement of splitStatements(sql)) {
    for (const match of statement.text.toUpperCase().matchAll(CREATED_RELATION)) {
      keys.push(relationKey(match[1]));
    }
  }
  return keys;
}

function lineFinder(sql) {
  const starts = [0];
  for (let k = 0; k < sql.length; k += 1) if (sql.charCodeAt(k) === 10) starts.push(k + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * Checks one migration's SQL.
 * @param {{ newTables?: Set<string> }} options newTables: tables created by this branch's migrations
 * @returns {{ rule: string, what: string, line: number }[]}
 */
export function checkSql(sql, { newTables = new Set() } = {}) {
  const lineAt = lineFinder(sql);
  const findings = [];
  for (const statement of splitStatements(sql)) {
    const upper = statement.text.toUpperCase();
    for (const rule of RULES) {
      if (rule.statement !== undefined && !rule.statement.test(upper)) continue;
      for (const match of upper.matchAll(rule.pattern)) {
        findings.push({ rule: rule.id, what: rule.what(match), line: lineAt(statement.start + match.index) });
      }
    }
    for (const match of upper.matchAll(CREATE_INDEX)) {
      if (match[1] !== undefined) continue;
      const nameStart = match.index + match[0].length - match[2].length;
      const table = statement.text.slice(nameStart, match.index + match[0].length).trim();
      if (newTables.has(relationKey(table))) continue;
      findings.push({
        rule: "create-index",
        what: `CREATE INDEX without CONCURRENTLY on the existing table ${table}`,
        line: lineAt(statement.start + match.index),
      });
    }
    // A DO block runs during the migration, so its body is checked too.
    if (/^\s*DO\b/.test(upper)) {
      for (const body of statement.bodies) {
        const offset = lineAt(body.start) - 1;
        for (const finding of checkSql(body.text, { newTables })) {
          findings.push({ ...finding, line: finding.line + offset });
        }
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Compares the migration files at the base with those on the branch.
 * @param {Map<string, string>} base path -> blob id at the base
 * @param {Map<string, { sha: string, content: string }>} branch path -> blob id and text on the branch
 * @returns {{ added: string[], changed: string[], removed: string[], errors: object[], notices: object[] }}
 */
export function checkMigrations(base, branch, baseName = DEFAULT_BASE) {
  const errors = [];
  const notices = [];
  const changed = [];
  const removed = [];
  for (const [file, sha] of base) {
    const now = branch.get(file);
    if (now === undefined) removed.push(file);
    else if (now.sha !== sha) changed.push(file);
  }
  const added = [...branch.keys()].filter((file) => !base.has(file)).sort();
  for (const file of changed) {
    errors.push({
      file,
      message: `${file} is already on ${baseName}: a merged migration never changes (migrate refuses a changed checksum). Put the change in a new migration.`,
    });
  }
  for (const file of removed) {
    errors.push({
      file,
      message: `${file} is on ${baseName} but not on this branch: a merged migration is never removed or renamed.`,
    });
  }
  const newTables = new Set(added.flatMap((file) => createdRelations(branch.get(file)?.content ?? "")));
  for (const file of added) {
    const name = path.posix.basename(file);
    if (!/^\d{4}_/.test(name)) {
      notices.push({
        file,
        message: `${name}: name new migrations 9999_<slug>.sql on a task branch (the lead renumbers them at merge)`,
      });
    }
    const content = branch.get(file)?.content ?? "";
    const statements = splitStatements(content);
    const concurrentCount = statements.filter((statement) =>
      CONCURRENT_INDEX.test(statement.text.toUpperCase()),
    ).length;
    const marked = NO_TRANSACTION.test((content.split(/\r?\n/, 1)[0] ?? "").trim());
    // The runner (migrate.mjs) accepts: only CREATE INDEX CONCURRENTLY statements (marker or not), or a marker
    // file with exactly one statement. It refuses a mix, and a marker file with several other statements.
    const onlyConcurrent = statements.length > 0 && concurrentCount === statements.length;
    const refused = !onlyConcurrent && statements.length > 1 && (concurrentCount > 0 || marked);
    if (refused) {
      notices.push({
        file,
        message: `${name}: migrate refuses this file: a file of only CREATE INDEX CONCURRENTLY statements needs no marker; a file whose first line is "-- migrate:no-transaction" holds one statement of any kind, or several that are all CREATE INDEX CONCURRENTLY; CREATE INDEX CONCURRENTLY cannot be mixed with other statements`,
      });
    }
    const contract = name.includes("_contract_");
    for (const finding of checkSql(content, { newTables })) {
      if (contract) {
        notices.push({
          file,
          line: finding.line,
          message: `${finding.what}: a contracting change in a _contract_ file; the architect and the lead must review it`,
        });
      } else {
        errors.push({
          file,
          line: finding.line,
          message:
            `${finding.what} is not expand-only (build prompt 5.4). ${ADVICE.get(finding.rule) ?? ""}`.trim(),
        });
      }
    }
  }
  return { added, changed, removed, errors, notices };
}

// ---------------------------------------------------------------------------------------------------------
// git

function git(cwd, args, { input, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 1024 ** 3 });
  if (result.error) throw new GuardError(`could not run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr).trim() || `exit code ${result.status}`;
    throw new GuardError(`git ${args[0]} failed: ${detail}`);
  }
  return result;
}

function repositoryRoot(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.status !== 0) throw new GuardError("this is not inside a git repository");
  return result.stdout.trim();
}

function resolveBase(root, ref) {
  const found = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  if (found.status !== 0) {
    throw new GuardError(
      `${ref} was not found. Run "git fetch origin main" first (CI checks out with fetch-depth: 0).`,
    );
  }
  const sha = found.stdout.trim();
  const mergeBase = git(root, ["merge-base", "HEAD", sha], { allowFailure: true });
  const common = mergeBase.status === 0 ? mergeBase.stdout.trim() : "";
  return { ref, sha, compare: common || sha, usedMergeBase: common !== "" };
}

const isSqlFile = (file) => /\.sql$/i.test(file);

function baseMigrations(root, rev, dir) {
  const out = git(root, ["ls-tree", "-r", "-z", "--full-tree", rev, "--", dir]).stdout;
  const files = new Map();
  for (const entry of out.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [, type, sha] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    if (type === "blob" && isSqlFile(file)) files.set(file, sha);
  }
  return files;
}

function branchMigrations(root, dir) {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", dir]).stdout;
  const paths = [...new Set(out.split("\0").filter(Boolean))]
    .filter(isSqlFile)
    .filter((file) => !file.includes("\n"))
    .filter((file) => statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile() ?? false)
    .sort();
  const files = new Map();
  if (paths.length === 0) return files;
  // Blob ids as git would store these files (same filters), to compare with the base exactly.
  const shas = git(root, ["hash-object", "--stdin-paths"], { input: `${paths.join("\n")}\n` })
    .stdout.trim()
    .split("\n");
  paths.forEach((file, k) => {
    files.set(file, { sha: shas[k] ?? "", content: readFileSync(path.join(root, file), "utf8") });
  });
  return files;
}

// ---------------------------------------------------------------------------------------------------------
// Output: plain lines, or GitHub annotations when running in GitHub Actions.

const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

function createReporter(env, write) {
  const github = env.GITHUB_ACTIONS === "true";
  const emit = (level, label, message, where = {}) => {
    if (github) {
      const props = [];
      if (where.file) props.push(`file=${escapeProperty(where.file)}`);
      if (where.file && where.line) props.push(`line=${where.line}`);
      props.push(`title=${escapeProperty(TITLE)}`);
      write(`::${level} ${props.join(",")}::${escapeData(message)}`);
    } else {
      const location = where.file ? `${where.file}${where.line ? `:${where.line}` : ""}  ` : "";
      write(`${label} ${location}${message}`);
    }
  };
  return {
    error: (message, where) => emit("error", "FAIL", message, where),
    notice: (message, where) => emit("notice", "NOTE", message, where),
    info: (message) => write(message),
  };
}

/** Runs the guard; returns the exit code. */
export function main(
  argv,
  { cwd = process.cwd(), env = process.env, write = (line) => console.log(line) } = {},
) {
  const report = createReporter(env, write);
  let baseRef = DEFAULT_BASE;
  let dir = DEFAULT_DIR;
  for (let k = 0; k < argv.length; k += 1) {
    const arg = argv[k];
    if (arg === "--help" || arg === "-h") {
      write(USAGE);
      return 0;
    }
    if ((arg === "--base" || arg === "--dir") && argv[k + 1] !== undefined) {
      if (arg === "--base") baseRef = argv[k + 1];
      else dir = argv[k + 1];
      k += 1;
    } else if (arg.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length);
    } else if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else {
      report.error(`unknown argument "${arg}". ${USAGE}`);
      return 2;
    }
  }
  try {
    if (baseRef === "" || baseRef.startsWith("-")) throw new GuardError(`"${baseRef}" is not a git ref`);
    dir = path.posix.normalize(dir.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (dir === "" || dir === "." || dir.startsWith("..") || dir.startsWith("/") || dir.startsWith("-")) {
      throw new GuardError(`--dir must be a folder inside the repository, not "${dir}"`);
    }
    const root = repositoryRoot(cwd);
    const base = resolveBase(root, baseRef);
    const result = checkMigrations(
      baseMigrations(root, base.compare, dir),
      branchMigrations(root, dir),
      baseRef,
    );

    const against = base.usedMergeBase
      ? `the merge-base of HEAD and ${baseRef} (${base.compare.slice(0, 10)})`
      : `${baseRef} (${base.compare.slice(0, 10)}; no merge-base found)`;
    report.info(`migration guard: ${dir} on this branch against ${against}`);
    report.info(`  new:     ${result.added.length > 0 ? result.added.join(", ") : "none"}`);
    if (result.changed.length > 0) report.info(`  changed: ${result.changed.join(", ")}`);
    if (result.removed.length > 0) report.info(`  removed: ${result.removed.join(", ")}`);
    for (const notice of result.notices) report.notice(notice.message, notice);
    for (const error of result.errors) report.error(error.message, error);
    if (result.errors.length === 0) {
      report.info("migration guard: passed");
      return 0;
    }
    report.info(
      `migration guard: FAILED (${result.errors.length} problem${result.errors.length === 1 ? "" : "s"})`,
    );
    return 1;
  } catch (error) {
    if (error instanceof GuardError) {
      report.error(`migration guard could not run: ${error.message}`);
      return 2;
    }
    throw error;
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
