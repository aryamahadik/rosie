// Staging's two Hyperdrive configurations, each storing one of the Worker's own logins (ADR-014 section 4's piece 2 and
// "The script's rules (piece 2)"; T-1252; T-1239's round 2 security review, notes b, c and d). The one Node process of
// create-staging-hyperdrive.sh (npm run hyperdrive:staging:create): run it through that file, never on its own.
// Its live run is the user's, while no agent runs (ADR-014 section 4, "Live steps"; DL-482, DL-486, DL-497): it sets
// each login's password in PostgreSQL and stores it in Cloudflare.
//
//   rosie-staging-hyperdrive-job  stores rosie_worker_job, which inherits rosie_job (the runtime side, HYPERDRIVE_JOB)
//   rosie-staging-hyperdrive-app  stores rosie_worker_app, which inherits rosie_app (the Tool API, HYPERDRIVE_APP)
//
// A password lives in this process alone, from start to end. It is made here (32 random bytes from node's crypto, as 64
// hex characters), sent to PostgreSQL in ALTER ROLE over this process's one database connection, then to Cloudflare's
// API in the body of one HTTPS request (POST /accounts/{account_id}/hyperdrive/configs, whose origin.password is
// write-only), and dropped. It is never in an argument, an environment variable, a file, a log or the output, and
// wrangler never sees it (no --origin-password, no --connection-string).
//
// In this order (each refusal exits 1 and says why, before anything after it is done):
//  1. NODE_TLS_REJECT_UNAUTHORIZED=0 is refused before anything: it would turn off the certificate check of the API
//     call, and of the database connection's TLS too.
//  2. STAGING_DATABASE_URL, by name: taken out of this process's environment at once, so nothing it starts finds it
//     there, and never shown. It is checked as infra/scripts/db-url.mjs checks the release scripts' URLs, and a pooled
//     host (Neon marks it "-pooler") is refused: the password's settings live in one session, and Cloudflare's Neon page
//     gives Hyperdrive the direct host.
//  3. It lists first (cf.sh hyperdrive list, read by infra/scripts/hyperdrive-list.mjs) and makes only what is
//     missing. A configuration of either name that exists is left exactly as it is: "<name> already exists: id <id>,
//     caching <caching>", and its stored user must be that name's login; another user (never shown) stops the run.
//     With both present it connects to nothing and makes no password.
//  4. One database connection, as the migrations' role (postgres.js with debug off, no prepared statements, at most one
//     connection, TLS with the server's certificate and name checked whatever the URL's sslmode says). On it, before
//     any password: a server older than PostgreSQL 16 is refused; max_connections and each login's shape as it
//     is found (names and flags, never a value) are printed; then the logging. It first tries to set, for its own
//     session only, log_statement to none and log_min_error_statement to panic (each needs a superuser or the SET
//     privilege on it, so a refusal there changes nothing), and debug_print_parse and debug_print_rewritten off. Then
//     it reads the session's values and refuses to make a password when any would write the ALTER ROLE's text to the
//     server log or keep it: log_statement other than none; log_min_error_statement error or lower; log_min_duration_
//     statement 0 or more; log_min_duration_sample 0 or more with log_statement_sample_rate above 0;
//     log_transaction_sample_rate above 0; debug_print_parse or debug_print_rewritten on; pg_stat_statements loaded
//     and tracking utility statements (its pg_stat_statements.track not none and track_utility on).
//  5. The API token: the Rosfield sign-in's, from `cf.sh auth token --json` (wrangler 4.158.0's auth token command),
//     read from that child's standard output, a pipe, and held in memory only. Only the type oauth is taken: wrangler
//     hands back CLOUDFLARE_API_TOKEN, or a key and an email, before the sign-in, so every child's environment goes
//     without those names (and their old CF_ spellings) and without the database URL.
//  6. Piece 1's file, infra/scripts/worker-logins.sql, on that connection: both logins made where missing, in their
//     shape, or the run stops.
//  7. For each missing configuration, in order: a fresh password; in one transaction on that connection, the session's
//     backend and log settings read again, ALTER ROLE <login> PASSWORD '<hex>', and at once one more statement of its
//     own (pg_stat_activity shows a session's most recent query until the next one); then the API's create with the
//     host, port and database of STAGING_DATABASE_URL, the login as user, caching disabled; then
//     "<name> created: id <id>, caching disabled". A failure there stops the run, with Cloudflare's words printed with
//     the password, the token and the database URL's parts (its host among them) taken out. It is safe to repeat: the
//     login then holds a password nobody has, and the next run, finding no configuration, sets a fresh one; a create
//     that reached Cloudflare but did not answer is found by the next run's list, and no new password is set for it.
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
// log_min_error_statement's levels above ERROR: a failing statement's text is logged at any other.
const QUIET_ERROR_LEVELS = new Set(["log", "fatal", "panic"]);
// The session's settings that decide whether a statement's text reaches the server log, and its backend.
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
  pg_catalog.pg_backend_pid()::pg_catalog.text as pid`;

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
printStrayErrors(PROGRAM, allSecrets);

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
  // wrangler's debug log leaves request bodies out and is not written to a file; no usage event is sent.
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

/** Why a session's settings would write the ALTER ROLE's text to the server log or keep it: none when it is safe. */
function loggingFaults(settings) {
  const faults = [];
  const rate = (value) => Number.parseFloat(value);
  if (settings.log_statement !== "none") {
    faults.push(`log_statement is ${settings.log_statement} (it logs ALTER statements at ddl, mod and all)`);
  }
  if (!QUIET_ERROR_LEVELS.has(settings.log_min_error_statement)) {
    faults.push(
      `log_min_error_statement is ${settings.log_min_error_statement} (a failing statement's text is logged at error and lower)`,
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
  const track = settings.pg_stat_statements_track;
  const utility = settings.pg_stat_statements_track_utility;
  if ((track !== null || utility !== null) && (track ?? "top") !== "none" && (utility ?? "on") !== "off") {
    faults.push(
      `pg_stat_statements is loaded and keeps utility statements' text (pg_stat_statements.track ${track ?? "(not shown)"}, track_utility ${utility ?? "(not shown)"})`,
    );
  }
  return faults;
}

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

/** A login's shape as it is found: its flags and its memberships by member, never a value. */
async function loginShape(conn, pair) {
  const [role] = await conn`
    select r.oid::pg_catalog.text as oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
           r.rolbypassrls
    from pg_catalog.pg_roles r where r.rolname = ${pair.login}`;
  if (role === undefined) return `${pair.login}: not on the server yet`;
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
  ].join(" ");
  const memberships = own
    .map(
      (row) =>
        `${String(row.rolname)} (inherit ${String(row.inherit_option)}, set ${String(row.set_option)}, admin ${String(row.admin_option)})`,
    )
    .join(", ");
  return `${pair.login}: ${flags}; memberships of its own: ${memberships === "" ? "none" : memberships}`;
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

/**
 * Sets the login's password on the one connection, in one transaction: postgres.js keeps a transaction on its one
 * connection and never reconnects inside it, so the statements below run on one backend. First that backend and its
 * log settings are read again (it must be the backend whose settings were read before, and they must still be safe),
 * then ALTER ROLE, then at once one more statement. A refusal or an error rolls back and sets nothing.
 */
async function setPassword(sql, pair, password, pid) {
  if (!/^[0-9a-f]{64}$/.test(password)) {
    throw new Refusal(
      `the password made for ${pair.login} is not 64 hex characters (it is not shown); none was set`,
    );
  }
  await sql.begin(async (tx) => {
    const [now] = await tx.unsafe(SESSION_QUERY);
    if (now.pid !== pid) {
      throw new Refusal(
        `the database session is not the one whose log settings were checked (another backend), so no password was set for ${pair.login}`,
      );
    }
    const faults = loggingFaults(now);
    if (faults.length > 0) {
      throw new Refusal(
        `the session's log settings changed before ${pair.login}'s password: ${faults.join("; ")}; no password was set`,
      );
    }
    await tx.unsafe(`alter role ${quoteIdent(pair.login)} password '${password}'`);
    // pg_stat_activity shows a session's most recent query until the next one: this is that next one.
    await tx.unsafe("select pg_catalog.pg_backend_pid()::pg_catalog.text as pid");
  });
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
    const errors = Array.isArray(answer?.errors)
      ? answer.errors.map((error) => `${String(error?.code)}: ${String(error?.message)}`).join("; ")
      : text.slice(0, 1000);
    throw new Refusal(
      `Cloudflare's API did not create ${pair.name} (HTTP ${String(response.status)}: ${scrub(errors, [password, ...allSecrets()])}). ${pair.login} now holds a password nobody has, so this is safe to repeat: the next run, finding no configuration, sets a fresh one`,
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
  if (url.hostname.includes("-pooler.")) {
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
      `the database: server_version_num ${String(version)}, max_connections ${String(server.max_connections)}`,
    );
    for (const pair of PAIRS) note(await loginShape(sql, pair));

    for (const [setting, value] of [
      ["log_statement", "none"],
      ["log_min_error_statement", "panic"],
      ["debug_print_parse", "off"],
      ["debug_print_rewritten", "off"],
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
    note(`this session's logging: ${describeSettings(settings)}`);
    const faults = loggingFaults(settings);
    if (faults.length > 0) {
      throw new Refusal(
        `this session would write the ALTER ROLE's text, password included, to the server log or keep it: ${faults.join("; ")}. No password was made (ADR-014, open question 3)`,
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

    // 7. Each missing configuration, in order.
    for (const pair of missing) {
      secrets.password = randomBytes(32).toString("hex");
      try {
        await setPassword(sql, pair, secrets.password, settings.pid);
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

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
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
