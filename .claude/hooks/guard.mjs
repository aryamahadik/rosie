#!/usr/bin/env node
// Rosie D-000 PreToolUse guard (build prompt 2, 5.6; factory spec section 9).
//
// A backup to the permission allow/deny rules in settings.json. Hooks can be
// bypassed through other commands, so this is never the only control (hard-rule
// table in build prompt 2).
//
// Contract (spec 9):
//   - Reads the hook JSON on stdin: { tool_name, tool_input, cwd, ... }.
//   - On a positive match: exit 2 with a one-line reason on stderr (Claude Code
//     treats PreToolUse exit 2 as "deny" and shows stderr to Claude).
//   - Otherwise: exit 0 with no output.
//   - Fails OPEN, never closed, on anything it cannot parse or an internal
//     error: exit 0 with a short stderr note, so a broken guard never locks the
//     CTO out of his own machine.
//
// Fast, no network, no dependencies (Node core only). Node strict mode is
// implicit in an ES module.

import fs from "node:fs";
import path from "node:path";

// The handover folder is read-only reference (hard rule 1). Its folder name is
// distinctive, so matching the name segment catches it on any machine without a
// hard-coded absolute prefix. ROSIE_HANDOVER_DIR can override for a non-standard
// layout or for tests.
const HANDOVER_NAME = "rosfield main handover";
const HANDOVER_OVERRIDE = (process.env.ROSIE_HANDOVER_DIR || "").toLowerCase().replace(/\\/g, "/");

function namesHandover(s) {
  if (!s) return false;
  const l = String(s).toLowerCase().replace(/\\/g, "/");
  if (l.includes(HANDOVER_NAME)) return true;
  if (HANDOVER_OVERRIDE && l.includes(HANDOVER_OVERRIDE)) return true;
  return false;
}

// --- secret / key files and wholesale environment dumps (spec 9.2) ----------

function namesSecret(s) {
  if (!s) return null;
  const l = String(s).toLowerCase().replace(/\\/g, "/");
  if (/(^|[\s'"=(/])\.dev\.vars\b/.test(l)) return ".dev.vars";
  if (/(^|[\s'"=(/])\.env($|[\s'".)/])/.test(l)) return ".env";
  if (l.includes(".config/rosfield")) return ".config/rosfield";
  if (l.includes(".wrangler/config")) return ".wrangler/config";
  if (l.includes(".ssh/")) return ".ssh";
  if (/\bid_rsa\b/.test(l)) return "id_rsa";
  if (/\bid_ed25519\b/.test(l)) return "id_ed25519";
  if (/\.pem($|[\s'")./])/.test(l)) return ".pem";
  return null;
}

function dumpsEnv(cmd) {
  if (/(^|[\n;&|]\s*)printenv\b/.test(cmd)) return "printenv";
  if (/(^|[\n;&|]\s*)env(\s+-\S+)*\s*($|[\n;&|])/.test(cmd)) return "env";
  if (/(^|[\n;&|]\s*)set\s*($|[\n;&|])/.test(cmd)) return "set";
  if (/\bexport\s+-p\b/.test(cmd)) return "export -p";
  if (/\/proc\/[^/\s]+\/environ\b/.test(cmd)) return "/proc/*/environ";
  return null;
}

// --- a small, quote-aware shell tokenizer ----------------------------------
// Good enough to read branch refspecs, flags and destination paths. It is not a
// full shell parser; it strips single/double quotes and backslash escapes so a
// quoted path with spaces becomes one token.

function tokenize(s) {
  const out = [];
  let cur = "";
  let started = false;
  let q = 0; // 0 none, 1 single, 2 double
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === 1) {
      if (c === "'") q = 0;
      else cur += c;
      continue;
    }
    if (q === 2) {
      if (c === '"') q = 0;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'") {
      q = 1;
      started = true;
      continue;
    }
    if (c === '"') {
      q = 2;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

function splitSegments(s) {
  return s.split(/&&|\|\||;|\n|\|/);
}

// rsync deletes the files it sent with --remove-source-files (older name: --remove-sent-files). getopt
// accepts any unambiguous prefix, so "--rem" and longer prefixes count too.
const RSYNC_REMOVES_SOURCES = ["--remove-source-files", "--remove-sent-files"];
const removesSources = (x) => x.length >= 5 && RSYNC_REMOVES_SOURCES.some((o) => o.startsWith(x));

// --- rule 1: writes into the handover folder (spec 9.1) ---------------------

function handoverBashWrite(cmd) {
  if (!namesHandover(cmd)) return false;
  // Redirections '>' / '>>' whose target is inside the handover folder. A fd
  // duplication like 2>&1 or a write to /dev/null is not a file write.
  const redir = /(^|[^0-9&>])>>?\s*("[^"]*"|'[^']*'|[^\s&|;<>]+)/g;
  let m;
  while ((m = redir.exec(cmd))) {
    const tgt = m[2].replace(/^["']|["']$/g, "");
    if (tgt && !tgt.startsWith("/dev/") && namesHandover(tgt)) return true;
  }
  for (const seg of splitSegments(cmd)) {
    const t = tokenize(seg);
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      const rest = t.slice(i + 1);
      // Commands that modify the file(s) they name: any operand in the handover. mv counts: moving a file
      // out of the handover removes it from there.
      if (/^(rm|mv|chmod|chown|touch)$/.test(c) && rest.some(namesHandover)) return true;
      // rsync that removes the files it sent: a source in the handover is a write too.
      if (c === "rsync" && rest.some(removesSources) && rest.some(namesHandover)) return true;
      // tee writes the files it is given.
      if (c === "tee" && rest.some(namesHandover)) return true;
      // sed -i edits in place.
      if (c === "sed" && rest.some((x) => x === "-i" || /^-i/.test(x)) && rest.some(namesHandover)) {
        return true;
      }
      // cp / ln / plain rsync: only the destination (last positional) is a write; naming the handover
      // as a source is a read and is allowed (hard rule 2's copy into scratch/master-copy/).
      if (/^(cp|ln|rsync)$/.test(c)) {
        const pos = rest.filter((x) => !x.startsWith("-"));
        const dest = pos[pos.length - 1];
        if (dest && namesHandover(dest)) return true;
      }
    }
  }
  return false;
}

// --- rule 3: git push to a protected branch (spec 9.3) ----------------------

const GIT_GLOBAL_VALUE_OPT = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function pushArgs(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "git") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (GIT_GLOBAL_VALUE_OPT.has(t)) {
        j += 2;
        continue;
      }
      if (t.startsWith("-")) {
        j++;
        continue;
      }
      break;
    }
    if (j < tokens.length && tokens[j] === "push") return tokens.slice(j + 1);
  }
  return null;
}

const isTask = (b) => /^task\//.test(b || "");
const isProtected = (b) => b === "main" || b === "master";

function destOf(refspec, current) {
  let r = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  if (r.includes(":")) r = r.split(":").pop();
  r = r.replace(/^refs\/heads\//, "");
  if (r === "HEAD") return current || "HEAD";
  return r;
}

function checkPush(tokens, current) {
  const args = pushArgs(tokens);
  if (args === null) return null;
  const flags = args.filter((a) => a.startsWith("-"));
  const positionals = args.filter((a) => !a.startsWith("-"));
  const refspecs = positionals.slice(1); // positionals[0] is the remote
  const forced =
    flags.some((f) => f === "-f" || f === "--force" || /^--force(-with-lease|-if-includes)/.test(f)) ||
    refspecs.some((r) => r.startsWith("+"));

  if (flags.includes("--all")) return "git push --all pushes main";
  if (flags.includes("--mirror")) return "git push --mirror pushes main";

  const targets = refspecs.map((r) => destOf(r, current));
  if (targets.some(isProtected)) return "git push targets main/master";
  if (targets.length === 0 && isProtected(current)) return "bare git push while on main/master";

  if (forced) {
    const confirmedTask = targets.length ? targets.every(isTask) : isTask(current);
    if (!confirmedTask) return "force push to a non-task branch";
  }
  return null;
}

// --- rule 4: production deploys (spec 9.4; DL-024) --------------------------
// wrangler and the cf.sh wrapper are read the same way, as cf.sh itself reads its arguments: `wrangler` (npx
// wrangler, a node_modules/.bin path, wrangler@<version>), `npm run cf [--] ...`, and
// `[bash] [./]infra/scripts/cf.sh ...`, also inside `bash -c '...'` or `eval`. Blocked: an option that picks
// another Worker or config (--name, --worker-name, --config/-c, --cwd, --env-file, --experimental-new-config,
// --route(s), --domain(s), in any spelling, and combined short options such as -yc), any --env other than
// staging, delete, and a command that changes a Worker (deploy, upload, rollback, secret, preview) without
// --env staging. A command that sets WRANGLER_CI_OVERRIDE_NAME (wrangler's Worker-name override, which cf.sh
// refuses, as it refuses any WRANGLER_*_NAME) is blocked whatever it runs, and so is CLOUDFLARE_ENV other than
// staging beside wrangler or cf.sh.

const REFUSED_OPTIONS = new Map([
  ["name", "another Worker"],
  ["worker-name", "another Worker"],
  ["config", "another config file"],
  ["cwd", "another folder, so another config"],
  ["experimental-new-config", "another config file"],
  ["x-new-config", "another config file"],
  ["env-file", "a variables file, which can set WRANGLER_CI_OVERRIDE_NAME"],
  ["route", "a route not in wrangler.jsonc"],
  ["routes", "a route not in wrangler.jsonc"],
  ["domain", "a custom domain not in wrangler.jsonc"],
  ["domains", "a custom domain not in wrangler.jsonc"],
]);

// Options whose value is the next argument, skipped so that it is never read as a command word.
const WRANGLER_VALUE_OPTIONS = new Set([
  "--var",
  "--define",
  "--alias",
  "--preview-alias",
  "--message",
  "--tag",
  "--outdir",
  "--outfile",
  "--profile",
  "--compatibility-date",
  "--compatibility-flag",
  "--compatibility-flags",
  "--format",
  "--search",
  "--status",
  "--header",
  "--method",
  "--sampling-rate",
  "--ip",
  "--binding",
  "--namespace-id",
  "--secrets-file",
]);

const CHANGES_A_WORKER = new Set(["deploy", "upload", "rollback", "secret", "preview"]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const SHELL = /^(.*\/)?(bash|sh|zsh|dash|ksh)$/;

const isWrangler = (t) => /^wrangler(@[^/]*)?(\.[cm]?js)?$/.test(path.posix.basename(t));
const isCfScript = (t) => /(^|\/)cf\.sh$/.test(t);

// Why one wrangler argument is refused, or null. Long options are read as wrangler's parser (yargs) reads
// them: without =value or .key, camelCase as kebab case, and without the no- of a negation.
function refusedOption(arg) {
  if (!arg.startsWith("-") || arg === "-" || arg === "--") return null;
  if (arg.startsWith("--")) {
    const name = arg
      .replace(/^-+/, "")
      .split("=")[0]
      .split(".")[0]
      .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      .replace(/^-/, "")
      .replace(/^no-/, "");
    const why = REFUSED_OPTIONS.get(name);
    return why ? `${arg} (${why})` : null;
  }
  if (arg.startsWith("-c")) return `${arg} (another config file)`;
  if (arg.length === 2 || arg.startsWith("-e=")) return null;
  return `${arg} (combined or attached short options)`;
}

// The wrangler or cf.sh call of one command segment: what it is and the wrangler arguments after it.
function wranglerCall(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isWrangler(t)) return { label: "wrangler", args: tokens.slice(i + 1) };
    if (isCfScript(t)) return { label: "cf.sh", args: tokens.slice(i + 1) };
    if (t === "npm") {
      const run = tokens.findIndex((x, k) => k > i && NPM_RUN.has(x));
      if (run < 0) continue;
      let j = run + 1;
      while (j < tokens.length && tokens[j].startsWith("-")) j++;
      if (tokens[j] === "cf") {
        const args = tokens.slice(j + 1);
        return { label: "npm run cf", args: args[0] === "--" ? args.slice(1) : args };
      }
    }
  }
  return null;
}

function checkWranglerArgs(label, args) {
  for (const arg of args) {
    const why = refusedOption(arg);
    if (why) return `${label} with ${why}`;
  }
  let env = null;
  let envCount = 0;
  const words = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ended) {
      words.push(a);
      continue;
    }
    const m = /^(?:--env|-e)=(.*)$/s.exec(a);
    if (a === "--") ended = true;
    else if (a === "--env" || a === "-e") {
      envCount++;
      env = args[i + 1] ?? "";
      i++;
    } else if (m) {
      envCount++;
      env = m[1];
    } else if (WRANGLER_VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith("-")) words.push(a);
  }
  if (envCount > 1) return `${label} with --env given more than once`;
  if (envCount === 1 && env !== "staging") {
    return `${label} with --env ${env || "(empty: the production Worker)"} (only --env staging)`;
  }
  if (words.includes("delete")) return `${label} delete (nothing is deleted through wrangler or cf.sh)`;
  const changes = words.find((w) => CHANGES_A_WORKER.has(w));
  if (changes && env !== "staging") {
    return `production-capable ${label} command without --env staging (${changes})`;
  }
  return null;
}

// Commands a segment runs through a shell: `bash -c '<script>'` (or -lc, -ec, ...) and `eval <words>`.
function nestedScripts(tokens) {
  const scripts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "eval") {
      scripts.push(tokens.slice(i + 1).join(" "));
    } else if (SHELL.test(tokens[i])) {
      for (let j = i + 1; j < tokens.length && tokens[j].startsWith("-"); j++) {
        if (/^-[a-z]*c[a-z]*$/.test(tokens[j]) && j + 1 < tokens.length) {
          scripts.push(tokens[j + 1]);
          break;
        }
      }
    }
  }
  return scripts;
}

// Ways a command sets WRANGLER_CI_OVERRIDE_NAME (or any other WRANGLER_*_NAME, as cf.sh refuses them all):
// NAME=x (inline, export, env, a profile line), NAME+=x, ${NAME:=x}, env["NAME"] = x; {"NAME": x}; and a
// builtin that sets a named variable (export, declare, read, printf -v, setenv, ...) at the start of a command.
const SETS_OVERRIDE = [
  /WRANGLER_\w*_NAME["'\]\s]*[+:]?=/,
  /WRANGLER_\w*_NAME["']\s*:/,
  /(^|[\n;&|(`]|\$\()\s*(export|declare|typeset|local|readonly|read|readarray|mapfile|printf|setenv|launchctl)\b[^\n;&|]*\bWRANGLER_\w*_NAME\b/,
];
const setsWranglerOverride = (cmd) => SETS_OVERRIDE.some((pattern) => pattern.test(cmd));

// The last value a command gives CLOUDFLARE_ENV, or null.
function cloudflareEnv(cmd) {
  let value = null;
  for (const m of cmd.matchAll(/\bCLOUDFLARE_ENV\s*=\s*("([^"]*)"|'([^']*)'|[^\s;&|]*)/g)) {
    value = m[2] ?? m[3] ?? m[1];
  }
  return value;
}

function checkWranglerCalls(cmd, depth) {
  for (const segment of splitSegments(cmd)) {
    const tokens = tokenize(segment);
    const call = wranglerCall(tokens);
    if (call) {
      const env = cloudflareEnv(cmd);
      if (env && env !== "staging") return `${call.label} with CLOUDFLARE_ENV=${env} (only staging)`;
      const why = checkWranglerArgs(call.label, call.args);
      if (why) return why;
    }
    if (depth < 3) {
      for (const script of nestedScripts(tokens)) {
        const why = checkWranglerCalls(script, depth + 1);
        if (why) return why;
      }
    }
  }
  return null;
}

const GH_VALUE_FLAGS = new Set([
  "-f",
  "--field",
  "-F",
  "--raw-field",
  "--ref",
  "-r",
  "--repo",
  "-R",
  "--json",
  "--input",
]);

function ghWorkflowName(tokens) {
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i] === "gh" && tokens[i + 1] === "workflow" && tokens[i + 2] === "run") {
      let j = i + 3;
      while (j < tokens.length) {
        const t = tokens[j];
        if (GH_VALUE_FLAGS.has(t)) {
          j += 2;
          continue;
        }
        if (t.startsWith("-")) {
          j++;
          continue;
        }
        return t;
      }
      return "";
    }
  }
  return null;
}

function checkDeploy(tokens, cmd) {
  // Any explicit production target (covers wrangler and the cf.sh wrapper).
  if (/--env(=|\s+)production\b/.test(cmd)) return "targets the production environment (--env production)";
  if (setsWranglerOverride(cmd)) {
    return "sets WRANGLER_CI_OVERRIDE_NAME or another WRANGLER_*_NAME (a Worker-name override; cf.sh refuses it)";
  }

  const r = checkWranglerCalls(cmd, 0);
  if (r) return r;

  if (/\bnpm\s+run\s+deploy:production\b/.test(cmd)) return "npm run deploy:production";

  const wf = ghWorkflowName(tokens);
  if (wf !== null) {
    if (!/^merge-check(\.ya?ml)?$/.test(wf)) {
      return `gh workflow run of a non-allowlisted workflow (${wf || "none"})`;
    }
  }
  return null;
}

// --- current branch (only needed for a bare / unqualified push) -------------

function currentBranch(input) {
  if (process.env.GUARD_CURRENT_BRANCH) return process.env.GUARD_CURRENT_BRANCH;
  try {
    const cwd = (input && input.cwd) || process.cwd();
    let gitEntry = path.join(cwd, ".git");
    let headPath = path.join(gitEntry, "HEAD");
    const st = fs.statSync(gitEntry);
    if (st.isFile()) {
      const c = fs.readFileSync(gitEntry, "utf8");
      const m = c.match(/gitdir:\s*(.+)/);
      if (m) headPath = path.join(cwd, m[1].trim(), "HEAD");
    }
    const head = fs.readFileSync(headPath, "utf8");
    const m = head.match(/ref:\s*refs\/heads\/(.+)/);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// --- the decision ----------------------------------------------------------

function decide(input) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (tool === "Agent" || tool === "Task") {
    if (String(ti.subagent_type || "").toLowerCase() === "fork")
      return "Agent/Task fork is forbidden (spec 9.5)";
    return null;
  }

  if (tool === "Read") {
    const s = namesSecret(ti.file_path);
    if (s) return `reads a protected key/secret file (${s})`;
    return null;
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const p = ti.file_path || ti.notebook_path;
    if (p) {
      if (namesHandover(p)) return "writes into the read-only handover folder (spec 9.1)";
      const s = namesSecret(p);
      if (s) return `writes a protected key/secret file (${s})`;
    }
    return null;
  }

  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    const tokens = tokenize(cmd);

    const s = namesSecret(cmd);
    if (s) return `names a protected key/secret file (${s})`;
    const d = dumpsEnv(cmd);
    if (d) return `dumps the environment wholesale (${d})`;
    if (handoverBashWrite(cmd)) return "writes into the read-only handover folder (spec 9.1)";

    const r3 = checkPush(tokens, currentBranch(input));
    if (r3) return r3;

    const r4 = checkDeploy(tokens, cmd);
    if (r4) return r4;

    return null;
  }

  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch {
    process.stderr.write("guard: could not read hook input; allowing\n");
    process.exit(0);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write("guard: unparseable hook input; allowing (fail open)\n");
    process.exit(0);
  }
  let reason;
  try {
    reason = decide(input);
  } catch (e) {
    process.stderr.write(`guard: internal error, allowing (fail open): ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
  if (reason) {
    process.stderr.write(`guard: blocked — ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

main();
