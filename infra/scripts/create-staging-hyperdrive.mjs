// Staging's two Hyperdrive configurations, each storing one of the Worker's own logins (ADR-014 section 4's piece 2 and
// "The script's rules (piece 2)"; T-1252; T-1239's round 2 security review, notes b, c and d; hardened by T-1271, from
// T-1252's security review, notes a to e, and its database review, note a; T-1369's login check; T-1371's route, from
// CQ-225's ruling by the architect and the security reviewer, DL-733). The one Node process of
// create-staging-hyperdrive.sh (npm run hyperdrive:staging:create): run it through that file, never on its own.
// Its live run is the user's, while no agent runs (ADR-014 section 4, "Live steps"; DL-482, DL-486, DL-497): it sets
// each login's password in PostgreSQL, through one bound parameter, and stores it in Cloudflare.
//
//   rosie-staging-hyperdrive-job  stores rosie_worker_job, which inherits rosie_job (the runtime side, HYPERDRIVE_JOB)
//   rosie-staging-hyperdrive-app  stores rosie_worker_app, which inherits rosie_app (the Tool API, HYPERDRIVE_APP)
//
// A password lives in this process alone, from start to end. It is made here (32 random bytes from node's crypto, as 64
// hex characters). Neon takes a password only in plain text ("Hashed passwords are not supported": ADR-014 [N6]), so
// PostgreSQL is given it, but never in a statement's text (T-1371): it travels only as the second bound value of one
// call, `select pg_temp.rosie_set_login_password($1, $2)` (postgres.js sends Parse with $1 and $2, then Bind with the
// values), and that temporary function runs ALTER ROLE inside the server. So pg_stat_statements' track top keeps only
// the call's text, pg_stat_activity shows only the call, and step 4's stop rules keep every other place a bound value or
// the inner statement could be logged or kept out of the way. The password then serves one login as its login (step
// 7's check, over TLS checked as for the run's own connection) and goes to Cloudflare's API in the body of one HTTPS
// request (POST /accounts/{account_id}/hyperdrive/configs, whose origin.password is write-only), and is dropped. It is
// never in an argument, an environment variable, a file, a log or the output, and wrangler never sees it (no
// --origin-password, no --connection-string).
//
// In this order (each refusal exits 1 and says why, before anything after it is done):
//  1. NODE_TLS_REJECT_UNAUTHORIZED=0 is refused before anything: it would turn off the certificate check of the API
//     call, and of the database connection's TLS too.
//  2. STAGING_DATABASE_URL, by name: taken out of this process's environment at once, so nothing it starts finds it
//     there, and never shown. It is checked as infra/scripts/db-url.mjs checks the release scripts' URLs, and a pooled
//     host (Neon marks it "-pooler", read here in any letter case: Node keeps a postgres:// host's case) is refused: the
//     password's settings live in one session, and Cloudflare's Neon page gives Hyperdrive the direct host.
//  3. It lists first (cf.sh hyperdrive list, read by infra/scripts/hyperdrive-list.mjs) and makes only what is
//     missing. A configuration of either name that exists is left exactly as it is: "<name> already exists: id <id>,
//     caching <caching>", and its stored user must be that name's login; another user (never shown) stops the run.
//     With both present it connects to nothing and makes no password.
//  4. One database connection, as the migrations' role (postgres.js with debug off, no prepared statements, at most one
//     connection, TLS with the server's certificate and name checked whatever the URL's sslmode says). On it, before
//     any password: a server older than PostgreSQL 16 is refused; the server's version beside its postmaster's start
//     (pg_postmaster_start_time(), for T-1255's persistence proof), max_connections and each login's shape as it is
//     found (names and flags, never a value) are printed; then the logging. It first tries to set, for its own session
//     only, log_statement to none and log_min_error_statement to panic (each needs a superuser or the SET privilege on
//     it, so a refusal there changes nothing), debug_print_parse, debug_print_rewritten and debug_print_plan off, and
//     log_parameter_max_length_on_error to 0. Then it reads the session's values and refuses to make a password when any
//     would write the ALTER ROLE's text or the call's bound values to the server log or keep them: log_statement other
//     than none; log_min_error_statement other than fatal or panic (log too: QUIET_ERROR_LEVELS below);
//     log_min_duration_statement 0 or more; log_min_duration_sample 0 or more with log_statement_sample_rate above 0;
//     log_transaction_sample_rate above 0; debug_print_parse, debug_print_rewritten or debug_print_plan on;
//     log_parameter_max_length_on_error other than 0, read back after its own SET; pg_stat_statements.track all (top
//     and none go on: top keeps only the call's text, and track_utility is printed and decides nothing); anything that
//     could record the call's plan or values: auto_explain.log_min_duration set and not -1, any pg_stat_monitor or
//     pg_store_plans setting present (PLAN_KEEPERS below, each read with missing_ok), or log_statement_stats,
//     log_parser_stats, log_planner_stats or log_executor_stats on; pgaudit loaded with a pgaudit.log that names any
//     class but none (role, ddl, all and a class not known here keep T-1271's words: AUDIT_CLASSES below), or with
//     pgaudit.log_parameter on. It also refuses without the TEMPORARY privilege on its database or without plpgsql,
//     which the temporary function needs. Printed for the record, deciding nothing: log_min_messages,
//     log_error_verbosity, log_lock_waits, deadlock_timeout, log_parameter_max_length, password_encryption and, where
//     this role may read it, shared_preload_libraries (names only).
//  5. The API token: the Rosfield sign-in's, from `cf.sh auth token --json` (wrangler 4.158.0's auth token command),
//     read from that child's standard output, a pipe, and held in memory only. Only the type oauth is taken: wrangler
//     hands back CLOUDFLARE_API_TOKEN, or a key and an email, before the sign-in, so every child's environment goes
//     without those names (and their old CF_ spellings) and without the database URL.
//  6. Piece 1's file, infra/scripts/worker-logins.sql, on that connection: both logins made where missing, in their
//     shape, or the run stops.
//  7. For each missing configuration, in order: a fresh password, then one transaction on that connection (setPassword
//     below): the session's backend and every setting step 4 read, read again and unchanged; `set local plan_cache_mode
//     = force_generic_plan` (no plan holds a bound value as a constant) and `set local lock_timeout` to half of
//     deadlock_timeout (a lock wait is cancelled before it could log a line naming the inner statement), both read
//     back; create function pg_temp.rosie_set_login_password (FUNCTION_TEXT below, which holds no value), whose handler
//     re-raises any error, a cancel included, with its SQLSTATE and the script's own words only; the call, the login
//     and the password its two bound values; drop function; and at once one more statement of its own (pg_stat_activity
//     shows a session's most recent query until the next one); then the commit. Any error rolls back, so nothing is set
//     and no function is left, and stops the run: the line printed holds the SQLSTATE and the script's own words, never
//     the server's, and there is no retry of any kind. Then, before the create: the login's shape read again (by
//     member: exactly its one membership, inherit true, set false, admin false; LOGIN and none of SUPERUSER, CREATEDB,
//     CREATEROLE, REPLICATION and BYPASSRLS), anything else stopping the run; the login check (T-1369): one more
//     connection, as the login with the password, to the same server (STAGING_DATABASE_URL's host, port, database and
//     parameters, TLS checked as for the run's own connection), which runs `select current_user`, a refusal or another
//     name stopping the run, so Cloudflare never stores a password that cannot log in (its error printed scrubbed);
//     and, only where a pg_stat_statements view is readable in the database, the kept texts that name the login, read
//     into this process and compared with the password here, only the count that holds it printed (above 0 stops the
//     run; with no such view the count is "skipped", and the extension is never created). Then the API's create with
//     the host, port and database of STAGING_DATABASE_URL, the login as user, caching disabled; then "<name> created:
//     id <id>, caching disabled". A failure there stops the run, with Cloudflare's words printed with the password, the
//     token and the database URL's parts (its host among them) taken out of the whole text before it is cut to its
//     length (ERROR_TEXT_CUT), so a cut never leaves part of one standing. It is safe to repeat: the login then holds a
//     password nobody has, and the next run, finding no configuration, sets a fresh one; a create that reached
//     Cloudflare but did not answer is found by the next run's list, and no new password is set for it.
//  8. It ends the connection, lists again through cf.sh, and prints each name's id, caching and whether its stored
//     user is its login: the ids T-567 binds as HYPERDRIVE_JOB and HYPERDRIVE_APP.
// Exit: 0 both configurations exist, store their logins and have caching disabled (ADR-007); 1 refused, failed or
// not so (a configuration left as it was with caching on is printed so, and T-567 waits); 2 misuse (any argument).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { DatabaseUrlFault, checkDatabaseUrl, describeError, printStrayErrors, scrub } from "./db-url.mjs";
import { hyperdriveRow } from "./hyperdrive-list.mjs";

const PROGRAM = "create-staging-hyperdrive";
const HERE = import.meta.dirname;
const CF = path.join(HERE, "cf.sh");
const LOGINS_SQL = path.join(HERE, "worker-logins.sql");
// The Rosfield account: cf.sh pins the same id (ROSFIELD_ACCOUNT_ID) and refuses any other.
const ACCOUNT_ID = "ecb06e7bc9129fa81104d331e9652362";
const CREATE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/hyperdrive/configs`;
// Each configuration, the login it stores and the one role that login inherits (ADR-014 sections 1 and 3).
const PAIRS = [
  { name: "rosie-staging-hyperdrive-job", login: "rosie_worker_job", role: "rosie_job" },
  { name: "rosie-staging-hyperdrive-app", login: "rosie_worker_app", role: "rosie_app" },
];
// Names no child is given: the database URL's, and the ones wrangler would take as credentials before the sign-in.
const DROPPED_NAMES = [
  "STAGING_DATABASE_URL",
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
];
// log_min_error_statement's levels that are taken: fatal and panic only. PostgreSQL 17 logs the current statement "for
// any message of the specified severity or higher" and ranks the levels "... ERROR, LOG, FATAL, and PANIC" ("Error
// Reporting and Logging"; the server's own pg_settings.enumvals, which a test reads), so at log any LOG message during
// the ALTER ROLE (a lock wait with log_lock_waits on, a log_*_stats report) would log its text, password included.
// This is stricter than ADR-014 line 146's list, which names only error and the levels below it: T-1252's security
// review asked it (note a; T-1271). At fatal only a statement that ends its session is logged, at panic only a panic.
const QUIET_ERROR_LEVELS = new Set(["fatal", "panic"]);
// pgaudit's pgaudit.log, read as pg_stat_statements' settings are: null when the extension is not loaded. Its classes,
// as pgaudit 17.1's README.md and pgaudit.c give them (read on sources.debian.org, package pgaudit-17): a list split at
// commas, each class in any letter case, a "-" before one taking it out again. ROLE holds ALTER ROLE ("Statements
// related to roles and privileges: GRANT, REVOKE, CREATE/ALTER/DROP ROLE") and ALL holds every class. DDL ("All DDL
// that is not included in the ROLE class") does not, by pgaudit's own words, but is refused with them, as T-1252's
// security review asked (note b; T-1271): stricter. So is a list that names one, even when a later "-role" takes it
// out again, and a class not known here (pgaudit itself refuses an unknown one, so only a placeholder can hold it).
// Since T-1371 any class but none is refused too (auditLogsAnything below): READ and FUNCTION hold the call itself,
// and pgaudit logs the statements a function runs. pgaudit.log_parameter on, which logs a statement's bound values,
// is refused whatever the classes.
const AUDIT_CLASSES = new Set([
  "none",
  "read",
  "write",
  "function",
  "role",
  "ddl",
  "misc",
  "misc_set",
  "all",
]);
const AUDIT_REFUSED = new Set(["role", "ddl", "all"]);
// pg_stat_monitor's and pg_store_plans' settings (their READMEs: pg_stat_monitor 1.x and 2.x, pg_store_plans 1.x),
// each read with missing_ok: either module keeps statements' plans or texts, and with them could keep the call's values.
// A loaded module's settings are also found by their prefix in pg_settings, which lists no placeholder.
const PLAN_KEEPERS = [
  "pg_stat_monitor.pgsm_enable",
  "pg_stat_monitor.pgsm_max",
  "pg_stat_monitor.pgsm_query_max_len",
  "pg_stat_monitor.pgsm_track",
  "pg_stat_monitor.pgsm_track_utility",
  "pg_stat_monitor.pgsm_track_planning",
  "pg_stat_monitor.pgsm_normalized_query",
  "pg_stat_monitor.pgsm_enable_query_plan",
  "pg_stat_monitor.pgsm_extract_comments",
  "pg_stat_monitor.pgsm_max_buckets",
  "pg_stat_monitor.pgsm_bucket_time",
  "pg_stat_monitor.pgsm_histogram_min",
  "pg_stat_monitor.pgsm_histogram_max",
  "pg_stat_monitor.pgsm_histogram_buckets",
  "pg_stat_monitor.pgsm_query_shared_buffer",
  "pg_stat_monitor.pgsm_overflow_target",
  "pg_stat_monitor.pgsm_enable_overflow",
  "pg_stat_monitor.pgsm_enable_pgsm_query_id",
  "pg_store_plans.max",
  "pg_store_plans.track",
  "pg_store_plans.max_plan_length",
  "pg_store_plans.plan_storage",
  "pg_store_plans.plan_format",
  "pg_store_plans.min_duration",
  "pg_store_plans.log_analyze",
  "pg_store_plans.log_buffers",
  "pg_store_plans.log_timing",
  "pg_store_plans.log_triggers",
  "pg_store_plans.verbose",
  "pg_store_plans.save",
];
// How much of a text answer from Cloudflare's API a refusal shows, cut only after it is scrubbed (createConfiguration).
const ERROR_TEXT_CUT = 1000;
// The temporary function that sets each password (T-1371; CQ-225's ruling, DL-733). It lives in pg_temp, which is
// never searched for functions, so it is always named with its schema. Its body holds no value: the login and the
// password are its parameters, and EXECUTE runs the ALTER ROLE that format() builds from them inside the server. Its
// handler takes any error, a cancel included (OTHERS leaves out QUERY_CANCELED), and raises another with the same
// SQLSTATE and FUNCTION_FAULT's words, never the caught message, detail, hint or context: the context of an error
// raised inside EXECUTE names the statement it ran, password included.
const PASSWORD_FUNCTION = "rosie_set_login_password";
const FUNCTION_FAULT =
  "create-staging-hyperdrive: ALTER ROLE failed or was cancelled inside the temporary function; its own error is not passed on, since its context would name the statement, password included";
const FUNCTION_TEXT = `create function pg_temp.${PASSWORD_FUNCTION}(login text, secret text) returns void
language plpgsql set search_path = pg_catalog as $body$
begin
  execute pg_catalog.format('alter role %I password %L', login, secret);
exception
  when others or query_canceled then
    raise exception using errcode = sqlstate, message = '${FUNCTION_FAULT}';
end
$body$`;
// The one statement that carries a password: the call, with the login as $1 and the password as $2, bound values.
const CALL_TEXT = `select pg_temp.${PASSWORD_FUNCTION}($1, $2)`;
const DROP_TEXT = `drop function pg_temp.${PASSWORD_FUNCTION}(text, text)`;
// The session's settings that decide whether a statement's text, a plan or a bound value reaches the server log or is
// kept, whether the temporary function can be made, and its backend: read before any password, and again, unchanged,
// inside each password's transaction. Every value is text, or null where a setting is not there (missing_ok).
const SESSION_QUERY = `select
  pg_catalog.current_setting('log_statement') as log_statement,
  pg_catalog.current_setting('log_min_error_statement') as log_min_error_statement,
  pg_catalog.current_setting('log_min_duration_statement') as log_min_duration_statement,
  pg_catalog.current_setting('log_min_duration_sample') as log_min_duration_sample,
  pg_catalog.current_setting('log_statement_sample_rate') as log_statement_sample_rate,
  pg_catalog.current_setting('log_transaction_sample_rate') as log_transaction_sample_rate,
  pg_catalog.current_setting('debug_print_parse') as debug_print_parse,
  pg_catalog.current_setting('debug_print_rewritten') as debug_print_rewritten,
  pg_catalog.current_setting('pg_stat_statements.track', true) as pg_stat_statements_track,
  pg_catalog.current_setting('pg_stat_statements.track_utility', true) as pg_stat_statements_track_utility,
  pg_catalog.current_setting('pgaudit.log', true) as pgaudit_log,
  pg_catalog.current_setting('pgaudit.log_parameter', true) as pgaudit_log_parameter,
  pg_catalog.current_setting('debug_print_plan') as debug_print_plan,
  pg_catalog.current_setting('log_parameter_max_length_on_error') as log_parameter_max_length_on_error,
  pg_catalog.current_setting('log_statement_stats') as log_statement_stats,
  pg_catalog.current_setting('log_parser_stats') as log_parser_stats,
  pg_catalog.current_setting('log_planner_stats') as log_planner_stats,
  pg_catalog.current_setting('log_executor_stats') as log_executor_stats,
  pg_catalog.current_setting('auto_explain.log_min_duration', true) as auto_explain_log_min_duration,
  (select pg_catalog.string_agg(k.name, ', ' order by k.name)
     from (select n.name from pg_catalog.unnest(array[${PLAN_KEEPERS.map((name) => `'${name}'`).join(", ")}]::pg_catalog.text[]) as n(name)
             where pg_catalog.current_setting(n.name, true) is not null
           union
           select s.name from pg_catalog.pg_settings s
             where pg_catalog.starts_with(s.name, 'pg_stat_monitor.') or pg_catalog.starts_with(s.name, 'pg_store_plans.')) as k
  ) as plan_keepers,
  pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMPORARY')::pg_catalog.text as temporary,
  (select pg_catalog.has_language_privilege(l.oid, 'USAGE')::pg_catalog.text
     from pg_catalog.pg_language l where l.lanname = 'plpgsql') as plpgsql,
  pg_catalog.pg_backend_pid()::pg_catalog.text as pid`;
// Printed for the record, deciding nothing (T-1371): each read only where this role may see it (pg_settings lists no
// setting a role may not read), else null.
const RECORD_SETTINGS = [
  "log_min_messages",
  "log_error_verbosity",
  "log_lock_waits",
  "deadlock_timeout",
  "log_parameter_max_length",
  "password_encryption",
  "shared_preload_libraries",
];
const RECORD_QUERY = `select ${RECORD_SETTINGS.map(
  (name) =>
    `(select pg_catalog.current_setting(s.name) from pg_catalog.pg_settings s where s.name = '${name}') as ${name}`,
).join(",\n  ")},
  (select s.setting from pg_catalog.pg_settings s where s.name = 'deadlock_timeout') as deadlock_timeout_ms`;
// Read inside each password's transaction, after its two SET LOCALs.
const TRANSACTION_QUERY = `select
  pg_catalog.current_setting('plan_cache_mode') as plan_cache_mode,
  (select s.setting from pg_catalog.pg_settings s where s.name = 'lock_timeout') as lock_timeout_ms,
  (select s.setting from pg_catalog.pg_settings s where s.name = 'deadlock_timeout') as deadlock_timeout_ms`;

/** A run stopped on purpose: its message says why and holds no value (outside text in it was scrubbed as put in). */
class Refusal extends Error {}
/** A command line it does not take (exit 2). */
class Misuse extends Error {}

// What no printed line may hold: the database URL's parts, the token, and the password while one is held. Every text
// that comes from outside (an error, wrangler's words, Cloudflare's) is scrubbed of them where it is put into a line;
// the script's own lines hold names, ids, flags and settings only. `copies`: the URL as given and as Node writes it,
// and its password, which no child's environment may hold under any name.
const secrets = { url: [], copies: [], token: "", password: "" };
const allSecrets = () => [...secrets.url, secrets.token, secrets.password].filter((part) => part !== "");
// Run as the program, and not imported: only then does it catch stray errors.
const AS_PROGRAM = process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;
if (AS_PROGRAM) printStrayErrors(PROGRAM, allSecrets);

const say = (line) => {
  process.stdout.write(`${line}\n`);
};
const note = (line) => {
  say(`${PROGRAM}: ${line}`);
};

/** The environment of every child: this one's, without the database URL and the credential names wrangler reads. */
function childEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || DROPPED_NAMES.includes(name)) continue;
    // A copy of the database URL, or of its password, under any other name stays here too.
    if (secrets.copies.some((part) => value.includes(part))) continue;
    env[name] = value;
  }
  // wrangler 4.158.0 writes no log file: a line it logs goes to its log file only when its shouldLogToDisk() holds,
  // which reads WRANGLER_WRITE_LOGS and is false for "false" or "0" (its cli.js, pinned by a test; T-1271, T-1252's
  // security review, note e), so the list's table, with each origin's host and user, is kept nowhere. Its debug output
  // leaves request bodies out (WRANGLER_LOG_SANITIZE), and no usage event is sent (WRANGLER_SEND_METRICS).
  env.WRANGLER_LOG_SANITIZE = "true";
  env.WRANGLER_WRITE_LOGS = "false";
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}

/** Runs `bash cf.sh <args>`: standard output is kept (a pipe), standard error goes to the terminal or is kept. */
function cf(args, { keepStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [CF, ...args], {
      env: childEnvironment(),
      stdio: ["ignore", "pipe", keepStderr ? "pipe" : "inherit"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        status: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/** The account's Hyperdrive list, through cf.sh. Its text names each origin's host and user, so it is never shown. */
async function listConfigurations(when) {
  const listed = await cf(["hyperdrive", "list"]);
  if (listed.status !== 0) {
    throw new Refusal(
      `${when}: cf.sh hyperdrive list failed (exit ${String(listed.status)}, for the reason above), so which configurations exist is not known; nothing more was done`,
    );
  }
  return listed.stdout;
}

/** One configuration's row of a list, or null. */
function rowOf(listing, name, when) {
  try {
    return hyperdriveRow(listing, name);
  } catch (error) {
    if (error.exitCode === 3) {
      throw new Refusal(
        `${when}: more than one Hyperdrive configuration is named ${name}; nothing more was done`,
      );
    }
    throw new Refusal(
      `${when}: the Hyperdrive list could not be read (${String(error.message)}; its text is not shown: it names each origin's host and user); nothing more was done`,
    );
  }
}

/**
 * Why a session's settings would write the ALTER ROLE's text, a plan or the call's bound values to the server log or
 * keep them: none when it is safe.
 */
function loggingFaults(settings) {
  const faults = [];
  const rate = (value) => Number.parseFloat(value);
  if (settings.log_statement !== "none") {
    faults.push(`log_statement is ${settings.log_statement} (it logs ALTER statements at ddl, mod and all)`);
  }
  if (!QUIET_ERROR_LEVELS.has(settings.log_min_error_statement)) {
    faults.push(
      `log_min_error_statement is ${settings.log_min_error_statement} (the statement's text is logged with any message at that level or above, and log ranks above error: only fatal and panic are taken)`,
    );
  }
  if (settings.log_min_duration_statement !== "-1") {
    faults.push(
      `log_min_duration_statement is ${settings.log_min_duration_statement} (0 or more logs statements)`,
    );
  }
  if (settings.log_min_duration_sample !== "-1" && !(rate(settings.log_statement_sample_rate) <= 0)) {
    faults.push(
      `log_min_duration_sample is ${settings.log_min_duration_sample} with log_statement_sample_rate ${settings.log_statement_sample_rate}`,
    );
  }
  if (!(rate(settings.log_transaction_sample_rate) <= 0)) {
    faults.push(`log_transaction_sample_rate is ${settings.log_transaction_sample_rate}`);
  }
  for (const setting of ["debug_print_parse", "debug_print_rewritten"]) {
    if (settings[setting] !== "off") faults.push(`${setting} is ${settings[setting]}`);
  }
  // T-1371: what could record the call's plan or its bound values, or keep the statement its function runs.
  if (settings.debug_print_plan !== "off") {
    faults.push(`debug_print_plan is ${settings.debug_print_plan} (each plan is logged)`);
  }
  if (settings.log_parameter_max_length_on_error !== "0") {
    faults.push(
      `log_parameter_max_length_on_error is ${settings.log_parameter_max_length_on_error} after this session set it to 0 (an error's context would carry the call's bound values, the password among them)`,
    );
  }
  if (settings.pg_stat_statements_track === "all") {
    faults.push(
      "pg_stat_statements.track is all (it keeps the text of the statements a function runs, the ALTER ROLE among them: only top or none is taken)",
    );
  }
  const explain = settings.auto_explain_log_min_duration;
  if (explain !== null && explain !== "-1") {
    faults.push(
      `auto_explain.log_min_duration is ${explain} (auto_explain would log the call's plan and values)`,
    );
  }
  if (settings.plan_keepers !== null) {
    faults.push(
      `pg_stat_monitor or pg_store_plans is there (${settings.plan_keepers}): either could keep the call's plan or values`,
    );
  }
  for (const setting of [
    "log_statement_stats",
    "log_parser_stats",
    "log_planner_stats",
    "log_executor_stats",
  ]) {
    if (settings[setting] !== "off") {
      faults.push(
        `${setting} is ${settings[setting]} (each report is logged with the context of the statement it measures, the ALTER ROLE among them)`,
      );
    }
  }
  if (typeof settings.pgaudit_log === "string" && auditNamesAlterRole(settings.pgaudit_log)) {
    faults.push(
      `pgaudit is loaded and pgaudit.log is ${settings.pgaudit_log} (it names role, ddl or all, or a class not known here: its audit log could keep the ALTER ROLE's text)`,
    );
  } else if (typeof settings.pgaudit_log === "string" && auditLogsAnything(settings.pgaudit_log)) {
    faults.push(
      `pgaudit is loaded and pgaudit.log is ${settings.pgaudit_log} (any class but none could log the call, or the statements its function runs)`,
    );
  }
  const parameters = settings.pgaudit_log_parameter;
  if (parameters !== null && parameters !== "off") {
    faults.push(`pgaudit.log_parameter is ${parameters} (pgaudit would log the call's bound values)`);
  }
  return faults;
}

/** Why the temporary function cannot be made in this session: none when it can. */
function functionFaults(settings) {
  const faults = [];
  if (settings.temporary !== "true") {
    faults.push("this role has no TEMPORARY privilege on its database (the function lives in pg_temp)");
  }
  if (settings.plpgsql === null) faults.push("plpgsql is not in its database");
  else if (settings.plpgsql !== "true") faults.push("this role may not use plpgsql (no USAGE on it)");
  return faults;
}

/** Whether a pgaudit.log value names role, ddl or all, or a class not known here (AUDIT_CLASSES above). */
function auditNamesAlterRole(value) {
  if (value.trim() === "") return false;
  return value.split(",").some((entry) => {
    const token = entry.trim();
    const taken = token.startsWith("-");
    const name = (taken ? token.slice(1) : token).toLowerCase();
    return !AUDIT_CLASSES.has(name) || (!taken && AUDIT_REFUSED.has(name));
  });
}

/** Whether a pgaudit.log value holds any entry but none (T-1371): a "-" entry is refused as well. */
const auditLogsAnything = (value) =>
  value.split(",").some((entry) => entry.trim() !== "" && entry.trim().toLowerCase() !== "none");

/** pgaudit's part of a session's logging, as it is read. */
const describeAudit = (settings) =>
  typeof settings.pgaudit_log === "string" || settings.pgaudit_log_parameter !== null
    ? [
        `pgaudit.log ${String(settings.pgaudit_log)}`,
        ...(settings.pgaudit_log_parameter === null
          ? []
          : [`pgaudit.log_parameter ${settings.pgaudit_log_parameter}`]),
      ].join(", ")
    : "pgaudit not loaded";

const describeSettings = (settings) =>
  [
    "log_statement",
    "log_min_error_statement",
    "log_min_duration_statement",
    "log_min_duration_sample",
    "log_statement_sample_rate",
    "log_transaction_sample_rate",
    "debug_print_parse",
    "debug_print_rewritten",
  ]
    .map((setting) => `${setting} ${String(settings[setting])}`)
    .concat(
      settings.pg_stat_statements_track === null && settings.pg_stat_statements_track_utility === null
        ? ["pg_stat_statements not loaded"]
        : [
            `pg_stat_statements.track ${String(settings.pg_stat_statements_track)}`,
            `pg_stat_statements.track_utility ${String(settings.pg_stat_statements_track_utility)}`,
          ],
    )
    .join(", ");

/** What could record a plan or a bound value, as it is read (T-1371). */
const describePlans = (settings) =>
  [
    "debug_print_plan",
    "log_parameter_max_length_on_error",
    "log_statement_stats",
    "log_parser_stats",
    "log_planner_stats",
    "log_executor_stats",
  ]
    .map((setting) => `${setting} ${String(settings[setting])}`)
    .concat(
      settings.auto_explain_log_min_duration === null
        ? ["auto_explain not loaded"]
        : [`auto_explain.log_min_duration ${settings.auto_explain_log_min_duration}`],
      settings.plan_keepers === null
        ? ["no pg_stat_monitor or pg_store_plans setting"]
        : [`pg_stat_monitor or pg_store_plans: ${settings.plan_keepers}`],
    )
    .join(", ");

/** What the temporary function needs, as it is read (T-1371). */
const describeFunction = (settings) =>
  `TEMPORARY on its database ${settings.temporary === "true" ? "yes" : "no"}, plpgsql ${
    settings.plpgsql === null ? "not in its database" : settings.plpgsql === "true" ? "usable" : "not usable"
  }`;

/** The record's settings as printed: each value, or "(not readable)"; shared_preload_libraries by library name only. */
function describeRecord(record) {
  return RECORD_SETTINGS.map((name) => {
    const value = record[name];
    if (typeof value !== "string") return `${name} (not readable)`;
    if (name !== "shared_preload_libraries") return `${name} ${value}`;
    const libraries = value
      .split(",")
      .map((entry) => entry.trim().replaceAll('"', "").split("/").pop() ?? "")
      .filter((entry) => /^[A-Za-z0-9_.$-]{1,64}$/.test(entry));
    return `${name} ${libraries.length === 0 ? "(none)" : libraries.join(" ")}`;
  }).join(", ");
}

/**
 * A login's shape as it is found: its flags and its memberships by member, never a value; and, against ADR-014's
 * shape (LOGIN, none of SUPERUSER, CREATEDB, CREATEROLE, REPLICATION and BYPASSRLS, exactly one membership: its role,
 * inherit true, set false, admin false), what is wrong with it.
 */
async function loginShape(conn, pair) {
  const [role] = await conn`
    select r.oid::pg_catalog.text as oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
           r.rolbypassrls
    from pg_catalog.pg_roles r where r.rolname = ${pair.login}`;
  if (role === undefined) {
    return { text: `${pair.login}: not on the server yet`, faults: ["it is not on the server"] };
  }
  const own = await conn`
    select r.rolname, m.inherit_option, m.set_option, m.admin_option
    from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.roleid
    where m.member = ${role.oid}::pg_catalog.oid order by r.rolname`;
  const flags = [
    role.rolcanlogin ? "LOGIN" : "NOLOGIN",
    role.rolsuper ? "SUPERUSER" : "NOSUPERUSER",
    role.rolcreatedb ? "CREATEDB" : "NOCREATEDB",
    role.rolcreaterole ? "CREATEROLE" : "NOCREATEROLE",
    role.rolreplication ? "REPLICATION" : "NOREPLICATION",
    role.rolbypassrls ? "BYPASSRLS" : "NOBYPASSRLS",
  ];
  const memberships = own
    .map(
      (row) =>
        `${String(row.rolname)} (inherit ${String(row.inherit_option)}, set ${String(row.set_option)}, admin ${String(row.admin_option)})`,
    )
    .join(", ");
  const faults = flags.filter((flag) =>
    ["NOLOGIN", "SUPERUSER", "CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"].includes(flag),
  );
  const [only] = own;
  if (
    own.length !== 1 ||
    only.rolname !== pair.role ||
    only.inherit_option !== true ||
    only.set_option !== false ||
    only.admin_option !== false
  ) {
    faults.push(
      `its memberships are ${memberships === "" ? "none" : memberships} where its one is ${pair.role} (inherit true, set false, admin false)`,
    );
  }
  return {
    text: `${pair.login}: ${flags.join(" ")}; memberships of its own: ${memberships === "" ? "none" : memberships}`,
    faults,
  };
}

/** The API token of the Rosfield sign-in, through cf.sh: type oauth only. It is never shown. */
async function signInToken() {
  const got = await cf(["auth", "token", "--json"], { keepStderr: true });
  let answer;
  try {
    answer = JSON.parse(got.stdout);
  } catch {
    answer = undefined;
  }
  // What the child printed on standard output, and any credential inside it, never reaches a printed line.
  const printed = [got.stdout.trim(), ...["token", "key", "email"].map((field) => answer?.[field])].filter(
    (part) => typeof part === "string" && part !== "",
  );
  const words = (text) => scrub(text, [...printed, ...allSecrets()]).trim();
  if (got.status !== 0) {
    if (words(got.stderr) !== "") process.stderr.write(`${words(got.stderr)}\n`);
    throw new Refusal(
      `cf.sh auth token --json failed (exit ${String(got.status)}, for the reason above, with anything it printed on standard output taken out): there is no API token, so no password was made`,
    );
  }
  if (answer === undefined) {
    throw new Refusal(
      "what cf.sh auth token --json printed is not JSON (it is not shown): there is no API token, so no password was made",
    );
  }
  const type =
    typeof answer?.type === "string" && /^[a-z_]{1,20}$/.test(answer.type) ? answer.type : "(not one)";
  if (type !== "oauth") {
    throw new Refusal(
      `cf.sh auth token --json gave a credential of type ${type}, and only the sign-in's oauth token is taken (an API token or a key and email in the environment are never used); no password was made`,
    );
  }
  const token = answer.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token)) {
    throw new Refusal(
      "cf.sh auth token --json gave no token in a bearer token's form (what it gave is not shown); no password was made",
    );
  }
  if (words(got.stderr) !== "") process.stderr.write(`${words(got.stderr)}\n`);
  return token;
}

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/** An error's code as printed: a SQLSTATE, or a code such as CONNECTION_CLOSED; never its message or other fields. */
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : "no code";

/**
 * Sets the login's password on the one connection, in one transaction (T-1371; CQ-225's ruling, DL-733): the password
 * reaches PostgreSQL only as the second bound value of CALL_TEXT, never in a statement's text. postgres.js keeps a
 * transaction on its one connection and never reconnects inside it, so the statements below run on one backend: first
 * that backend and every setting step 4 read, read again and unchanged (T-1369's re-read); plan_cache_mode and
 * lock_timeout set for the transaction and read back; the function made; the call; the function dropped; at once one
 * more statement; the commit. Any error rolls back: nothing is set and no function is left. The refusal holds the
 * error's code and the script's own words only, and nothing is ever tried again. Returns what the read-back gave.
 */
async function setPassword(sql, pair, password, checked, lockMs) {
  if (!/^[0-9a-f]{64}$/.test(password)) {
    throw new Refusal(
      `the password made for ${pair.login} is not 64 hex characters (it is not shown); none was set`,
    );
  }
  let step = "its transaction's start";
  let held;
  try {
    await sql.begin(async (tx) => {
      const run = (what, text, values) => {
        step = what;
        return values === undefined ? tx.unsafe(text) : tx.unsafe(text, values);
      };
      const [now] = await run("the session's re-read", SESSION_QUERY);
      if (now.pid !== checked.pid) {
        throw new Refusal(
          `the database session is not the one whose log settings were checked (another backend), so no password was set for ${pair.login}`,
        );
      }
      const changed = Object.keys(checked).filter((key) => now[key] !== checked[key]);
      if (changed.length > 0) {
        throw new Refusal(
          `the session's settings changed before ${pair.login}'s password (${changed.join(", ")}); no password was set`,
        );
      }
      const faults = loggingFaults(now);
      if (faults.length > 0) {
        throw new Refusal(
          `the session's log settings changed before ${pair.login}'s password: ${faults.join("; ")}; no password was set`,
        );
      }
      await run("set local plan_cache_mode", "set local plan_cache_mode = force_generic_plan");
      await run("set local lock_timeout", `set local lock_timeout = '${String(lockMs)}ms'`);
      [held] = await run("the read-back of plan_cache_mode and lock_timeout", TRANSACTION_QUERY);
      const lock = Number(held.lock_timeout_ms);
      const deadlock = Number(held.deadlock_timeout_ms);
      if (
        held.plan_cache_mode !== "force_generic_plan" ||
        !Number.isInteger(lock) ||
        !Number.isInteger(deadlock) ||
        !(lock > 0 && lock < deadlock)
      ) {
        throw new Refusal(
          `inside ${pair.login}'s transaction plan_cache_mode reads ${String(held.plan_cache_mode)} and lock_timeout ${String(held.lock_timeout_ms)} ms against deadlock_timeout ${String(held.deadlock_timeout_ms)} ms (force_generic_plan, and above 0 and below deadlock_timeout, are taken); no password was set`,
        );
      }
      await run("create function", FUNCTION_TEXT);
      await run("the call", CALL_TEXT, [pair.login, password]);
      await run("drop function", DROP_TEXT);
      // pg_stat_activity shows a session's most recent query until the next one: after the call, drop function is
      // that next one, and this the last of the transaction.
      await run("the follow-up or commit", "select pg_catalog.pg_backend_pid()::pg_catalog.text as pid");
    });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(
      `${pair.login}'s password was not set (${codeOf(error)}, at ${step}; the server's own words are not shown). Its transaction rolled back, so nothing was set and no function is left, and Cloudflare was given nothing. Nothing is tried again, and the password is never put in a statement's text`,
    );
  }
  return held;
}

/**
 * The login's shape read again right after its password's commit (T-1371): anything but ADR-014's shape stops the run
 * before the login check and the create. Nothing is repaired here.
 */
async function checkShapeAfter(sql, pair) {
  const shape = await loginShape(sql, pair);
  if (shape.faults.length > 0) {
    throw new Refusal(
      `${pair.login} is not in its shape after its password's commit: ${shape.faults.join("; ")}. ${pair.name} was not created, and Cloudflare was given nothing; the login is left as it is (never repaired here)`,
    );
  }
}

/**
 * The login check (T-1369): one connection as the login, with its password, to the server the run's own connection
 * reached (STAGING_DATABASE_URL's host, port, database and parameters, its user and password replaced; TLS with the
 * certificate and name checked, as for the run's own), and `select current_user`. Anything but the login's own name
 * stops the run before the API's create, so Cloudflare never stores a password that cannot log in. Its error is
 * printed scrubbed of the password, the token and the URL's parts.
 */
async function checkLogin(raw, pair, password) {
  const login = postgres(raw, {
    username: pair.login,
    password,
    max: 1,
    ssl: { rejectUnauthorized: true },
    prepare: false,
    fetch_types: false,
    debug: false,
    onnotice: () => undefined,
    connect_timeout: 30,
    connection: { application_name: "rosie-create-staging-hyperdrive-login-check" },
  });
  let who;
  try {
    const [row] = await login.unsafe("select current_user::pg_catalog.text as who");
    who = row?.who;
  } catch (error) {
    throw new Refusal(
      `the login check of ${pair.login} failed${describeError(error, allSecrets())}. ${pair.name} was not created, so Cloudflare holds no password that cannot log in. ${pair.login} now holds a password nobody has, so this is safe to repeat: the next run, finding no configuration, sets a fresh one`,
    );
  } finally {
    await login.end({ timeout: 5 });
  }
  if (who !== pair.login) {
    throw new Refusal(
      `the login check of ${pair.login} answered another role (not shown) as current_user. ${pair.name} was not created, and nothing more was done`,
    );
  }
}

/**
 * The kept-text count (T-1371): only where a pg_stat_statements view is readable in this database, the texts it keeps
 * that name the login are read into this process (the login a bound value) and compared with the password here, so
 * the password is never sent in a statement; only the count that holds it is printed, and above 0 stops the run
 * before the create. With no readable view it prints "skipped". The extension is never created here.
 */
async function countKeptTexts(sql, pair, password) {
  const views = await sql`
    select n.nspname::pg_catalog.text as schema
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'pg_stat_statements' and c.relkind = 'v'
      and pg_catalog.has_schema_privilege(n.oid, 'USAGE') and pg_catalog.has_table_privilege(c.oid, 'SELECT')
    order by 1`;
  if (views.length === 0) {
    note(
      `${pair.login}: the kept-text count: skipped (no pg_stat_statements view is readable in this database)`,
    );
    return;
  }
  let holding = 0;
  for (const { schema } of views) {
    let kept;
    try {
      kept = await sql.unsafe(
        `select s.query::pg_catalog.text as query from ${quoteIdent(schema)}.pg_stat_statements s where pg_catalog.strpos(s.query::pg_catalog.text, $1) > 0`,
        [pair.login],
      );
    } catch (error) {
      throw new Refusal(
        `the texts pg_stat_statements keeps could not be read${describeError(error, allSecrets())}, so whether one holds ${pair.login}'s password is not known: ${pair.name} was not created, and Cloudflare was given nothing`,
      );
    }
    holding += kept.filter((row) => typeof row.query === "string" && row.query.includes(password)).length;
  }
  note(`${pair.login}: kept texts in pg_stat_statements that hold its password: ${String(holding)}`);
  if (holding > 0) {
    throw new Refusal(
      `pg_stat_statements keeps ${String(holding)} text(s) that hold ${pair.login}'s password (none is shown): ${pair.name} was not created, and Cloudflare was given nothing. This goes back to the architect and the security reviewer (CQ-225) before any other run`,
    );
  }
}

/** The API's create for one configuration: its id. The password goes in the request body and nowhere else. */
async function createConfiguration(pair, password, token, origin) {
  const body = JSON.stringify({
    name: pair.name,
    origin: { ...origin, user: pair.login, password },
    caching: { disabled: true },
  });
  let response;
  let text;
  try {
    response = await fetch(CREATE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    text = await response.text();
  } catch (error) {
    throw new Refusal(
      `Cloudflare's API did not answer the create of ${pair.name}${describeError(error, [password, ...allSecrets()])}. ${pair.login} now holds a password nobody has, so this is safe to repeat: the next run lists first, finds ${pair.name} if the create reached Cloudflare (and sets no new password for it), or else sets a fresh password and creates it`,
    );
  }
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  const id = answer?.result?.id;
  if (!response.ok || answer?.success !== true || typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) {
    // Scrubbed whole, and only then cut: a cut first could leave part of the password, the token or the host standing
    // where scrub looks for the whole of each (T-1271; T-1252's security review, note c).
    const parts = [password, ...allSecrets()];
    const errors = Array.isArray(answer?.errors)
      ? scrub(
          answer.errors.map((error) => `${String(error?.code)}: ${String(error?.message)}`).join("; "),
          parts,
        )
      : scrub(text, parts).slice(0, ERROR_TEXT_CUT);
    throw new Refusal(
      `Cloudflare's API did not create ${pair.name} (HTTP ${String(response.status)}: ${errors}). ${pair.login} now holds a password nobody has, so this is safe to repeat: the next run, finding no configuration, sets a fresh one`,
    );
  }
  const caching = answer.result?.caching?.disabled === true ? "disabled" : "not disabled (check it)";
  return { id, caching };
}

async function main(args) {
  if (args.length > 0) throw new Misuse("it takes no arguments (they are never echoed)");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Refusal(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 would turn off the certificate check of the API call and of the database connection (unset it); nothing was listed, read or made",
    );
  }

  // The database URL: out of this process's environment at once, so no child is ever given it.
  const raw = process.env.STAGING_DATABASE_URL ?? "";
  delete process.env.STAGING_DATABASE_URL;
  if (raw === "") {
    throw new Refusal(
      "STAGING_DATABASE_URL is not set (from the environment, else from .dev.vars by name): staging's database is not known; nothing was listed, read or made",
    );
  }
  secrets.url = [raw];
  try {
    secrets.url = checkDatabaseUrl(raw);
  } catch (error) {
    if (!(error instanceof DatabaseUrlFault)) throw error;
    throw new Refusal(
      `STAGING_DATABASE_URL does not parse: ${error.message}; nothing was listed, read or made`,
    );
  }
  const url = new URL(raw);
  secrets.copies = [raw, url.href, url.password, decodeURIComponent(url.password)].filter(
    (part) => part.length >= 6,
  );
  // In lower case first: Node keeps a postgres:// host's letter case, and a host name is read in any case (T-1271).
  if (url.hostname.toLowerCase().includes("-pooler.")) {
    throw new Refusal(
      "STAGING_DATABASE_URL names a pooled host (-pooler): the password's log settings hold for one session only, and Cloudflare's Neon page gives Hyperdrive the direct host. Give the direct connection string; nothing was listed, read or made",
    );
  }
  const origin = {
    scheme: url.protocol.slice(0, -1),
    host: url.hostname,
    port: Number(url.port === "" ? "5432" : url.port),
    database: decodeURIComponent(url.pathname.slice(1)),
  };

  // 3. The list first: only what is missing is made, and what exists is left as it is.
  const listing = await listConfigurations("the list before anything is made");
  const rows = new Map(PAIRS.map((pair) => [pair.name, rowOf(listing, pair.name, "the list")]));
  for (const pair of PAIRS) {
    const row = rows.get(pair.name);
    if (row) say(`${pair.name} already exists: id ${row.id}, caching ${row.caching}`);
  }
  for (const pair of PAIRS) {
    const row = rows.get(pair.name);
    if (row && row.user !== pair.login) {
      throw new Refusal(
        `${pair.name} exists and stores ${row.user === null ? "a user the list does not show" : "another user (not shown)"}, not its login ${pair.login}: it is left as it is (a configuration is never replaced from here), and nothing was connected to or made. Its user is fixed in Cloudflare's dashboard or by a card of its own`,
      );
    }
  }
  const missing = PAIRS.filter((pair) => !rows.get(pair.name));
  if (missing.length === 0) {
    note(
      "both configurations exist and store their logins: nothing was connected to, and no password was made",
    );
    return summarize(rows);
  }

  // 4. The one connection that will send each password: max 1, so every statement goes over it. (No sql.reserve():
  // postgres.js 3.4.9 never hands over a reserved connection that opens with fetch_types off.) Each password's
  // statements run in one transaction, which checks that its backend is the one read here (setPassword).
  const sql = postgres(raw, {
    max: 1,
    ssl: { rejectUnauthorized: true },
    prepare: false,
    fetch_types: false,
    debug: false,
    onnotice: () => undefined,
    connect_timeout: 30,
    connection: { application_name: "rosie-create-staging-hyperdrive" },
  });
  try {
    let server;
    try {
      [server] = await sql.unsafe(`select
        pg_catalog.current_setting('server_version_num') as version_num,
        pg_catalog.pg_postmaster_start_time()::pg_catalog.text as started,
        pg_catalog.current_setting('max_connections') as max_connections,
        pg_catalog.pg_backend_pid()::pg_catalog.text as pid`);
    } catch (error) {
      throw new Refusal(
        `could not connect to STAGING_DATABASE_URL's server with its certificate checked, or read its version${describeError(error, allSecrets())}; no password was made`,
      );
    }
    const version = Number(server.version_num);
    if (!Number.isInteger(version) || version < 160000) {
      throw new Refusal(
        `the database is older than PostgreSQL 16 (server_version_num ${String(server.version_num)}): a grant WITH INHERIT TRUE, SET FALSE needs 16 or later; no password was made`,
      );
    }
    note(
      `the database: server_version_num ${String(version)}, postmaster started ${String(server.started)}, max_connections ${String(server.max_connections)}`,
    );
    for (const pair of PAIRS) note((await loginShape(sql, pair)).text);

    for (const [setting, value] of [
      ["log_statement", "none"],
      ["log_min_error_statement", "panic"],
      ["debug_print_parse", "off"],
      ["debug_print_rewritten", "off"],
      ["debug_print_plan", "off"],
      ["log_parameter_max_length_on_error", "0"],
    ]) {
      try {
        await sql.unsafe(`set ${setting} = '${value}'`);
      } catch {
        note(
          `${setting} could not be set to ${value} for this session (no SET privilege on it); its value is read next`,
        );
      }
    }
    const [settings] = await sql.unsafe(SESSION_QUERY);
    const [record] = await sql.unsafe(RECORD_QUERY);
    note(`this session's logging: ${describeSettings(settings)}`);
    note(`this session's plans and bound values: ${describePlans(settings)}`);
    note(`this session's audit logging: ${describeAudit(settings)}`);
    note(`this session's temporary function: ${describeFunction(settings)}`);
    note(`for the record: ${describeRecord(record)}`);
    const faults = loggingFaults(settings);
    if (faults.length > 0) {
      throw new Refusal(
        `this session would write the ALTER ROLE's text, password included, to the server log or keep it: ${faults.join("; ")}. No password was made (ADR-014, open question 3)`,
      );
    }
    const missingForFunction = functionFaults(settings);
    if (missingForFunction.length > 0) {
      throw new Refusal(
        `this session cannot make the temporary function that sets each password: ${missingForFunction.join("; ")}. No password was made`,
      );
    }
    // lock_timeout, set inside each password's transaction, at half of deadlock_timeout: a lock wait is cancelled
    // before deadlock_timeout, after which log_lock_waits would log a line whose context names the inner statement.
    const deadlockMs = Number(record.deadlock_timeout_ms);
    const lockMs = Math.floor(deadlockMs / 2);
    if (!Number.isInteger(deadlockMs) || lockMs < 1) {
      throw new Refusal(
        `deadlock_timeout reads ${String(record.deadlock_timeout_ms)} ms, so no lock_timeout above 0 and below it can be set; no password was made`,
      );
    }

    // 5. The token, then 6. piece 1's file.
    secrets.token = await signInToken();
    note("the API token: the Rosfield sign-in's, type oauth (not shown)");
    try {
      await sql.unsafe(readFileSync(LOGINS_SQL, "utf8"));
    } catch (error) {
      throw new Refusal(
        `worker-logins.sql stopped${describeError(error, allSecrets())}; no password was made`,
      );
    }
    note(`worker-logins.sql: ${PAIRS.map((pair) => pair.login).join(" and ")} are in their shape`);

    // 7. Each missing configuration, in order: its password set through the call, its shape read again, its login
    // checked, the kept texts counted, then its create.
    for (const pair of missing) {
      secrets.password = randomBytes(32).toString("hex");
      try {
        const held = await setPassword(sql, pair, secrets.password, settings, lockMs);
        note(
          `${pair.login}: its transaction held plan_cache_mode ${String(held.plan_cache_mode)} and lock_timeout ${String(held.lock_timeout_ms)} ms, below deadlock_timeout ${String(held.deadlock_timeout_ms)} ms`,
        );
        await checkShapeAfter(sql, pair);
        note(
          `${pair.login}: its password is set (the second bound value of one call of pg_temp.${PASSWORD_FUNCTION}, never a statement's text), and its shape after the commit is its own`,
        );
        await checkLogin(raw, pair, secrets.password);
        note(`${pair.login}: a connection as it with its password answered current_user ${pair.login}`);
        await countKeptTexts(sql, pair, secrets.password);
        const made = await createConfiguration(pair, secrets.password, secrets.token, origin);
        say(`${pair.name} created: id ${made.id}, caching ${made.caching}`);
      } catch (error) {
        // A refusal's outside text was scrubbed as it was put in; anything else is scrubbed here, while the password
        // is still known.
        if (error instanceof Refusal) throw error;
        throw new Refusal(`${pair.name} was not made${describeError(error, allSecrets())}`);
      } finally {
        secrets.password = "";
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  // 8. The end: the list again, and each name's id, caching and stored user.
  const after = await listConfigurations("the list after the run");
  return summarize(
    new Map(PAIRS.map((pair) => [pair.name, rowOf(after, pair.name, "the list after the run")])),
  );
}

/** Prints each name's id, caching and whether it stores its login; 0 when both do with caching disabled, else 1. */
function summarize(rows) {
  let complete = true;
  for (const pair of PAIRS) {
    const row = rows.get(pair.name);
    if (!row) {
      complete = false;
      say(`${pair.name}: not in the list`);
      continue;
    }
    const stores = row.user === pair.login;
    complete &&= stores && row.caching === "disabled";
    say(`${pair.name}: id ${row.id}, caching ${row.caching}, stores ${pair.login}: ${stores ? "yes" : "no"}`);
    if (row.caching !== "disabled") {
      note(
        `${pair.name}'s caching is not disabled, as ADR-007 needs: it is left as it is here; turn it off in Cloudflare's dashboard before T-567 binds it`,
      );
    }
  }
  return complete ? 0 : 1;
}

if (AS_PROGRAM) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Misuse) {
      process.stderr.write(`${PROGRAM}: ${error.message}\nusage: npm run hyperdrive:staging:create\n`);
      process.exitCode = 2;
    } else if (error instanceof Refusal) {
      process.stderr.write(`${PROGRAM}: refused: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`${PROGRAM}: failed${describeError(error, allSecrets())}\n`);
      process.exitCode = 1;
    }
  } finally {
    secrets.token = "";
    secrets.password = "";
  }
}
