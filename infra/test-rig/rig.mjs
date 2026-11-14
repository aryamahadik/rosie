// The Workers test rig over PostgreSQL (T-1253; ADR-014 section 4's piece 5 and "The Workers test pool, local runs and
// CI"; the D-017 path audit's P0, ops/reviews/D-017-path-audit/order_d017.txt line 28). Its globalSetup
// (global-setup.mjs) runs startRig at the start of every run of the workers and e2e-workers projects, locally and in CI,
// and `npm run db:logins` (db-logins.mjs) runs its logins step alone, for plain `wrangler dev`.
//
// startRig, on the server of DATABASE_URL, else the local default when CI is unset (vitest.config.ts's rule), connecting
// as that URL's login:
//   1. It refuses, before it connects, a URL whose host is not a loopback name (127.0.0.1, ::1 or localhost), and then,
//      before it makes anything, a login that is not a superuser: so it runs only on a local or CI server, where the
//      login is the container's first user (ADR-014 section 4, "The local passwords"). Staging's host is never loopback.
//   2. It refuses to start while a database named rosie_rig_none exists: the pool's own HYPERDRIVE_JOB and
//      HYPERDRIVE_APP name it so that a connect through them fails.
//   3. It makes rosie_rig_<run>_template (from template_postgis, else template1; <run> is 8 random hex digits, as
//      db/repo/test-db.ts names its schemas, so two runs on one server never share a database), migrates it with
//      infra/scripts/migrate.mjs (DB_SCHEMA empty: its public schema, as staging's) and publishes bundle v0 there, active,
//      with infra/scripts/publish-bundle.sh --env local (the publish script itself, so the code it uses).
//   4. The logins step: infra/scripts/worker-logins.sql (T-1252; it makes rosie_worker_job and rosie_worker_app when
//      missing and refuses one in another shape), then each login's local password, its own name, set only when the
//      login cannot already log in with it. So a second run, on a server that has them, changes nothing. It comes after
//      3 because the file grants rosie_job and rosie_app, which migration 0012 makes: a fresh CI server has neither
//      until the template's migration runs.
//   5. For each named file (files.mjs) whose test file exists: rosie_rig_<run>_<key> from the template, then the file's
//      seed module when it exists. For T-1254's file also ADR-014 section 2's wrong logins (files.mjs WRONG_LOGINS),
//      made only when missing, and in its database the table owner and the schema their cases need.
//   6. The pool's bindings (poolBindings): each file's pair on its database, rosie_rig_none's pair as the pool's own, and
//      the wrong logins' bindings, every string built by local-url.mjs.
// A failure on the way drops what the run made so far. stop() drops the databases the run made, and only those: each
// name is checked against rosie_rig_<run>_ before its drop, so another run's databases, rosie_rig_none and every t_
// schema or database are never touched. It prints database names and counts, never a connection string.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseUrlFault, checkDatabaseUrl, describeError, scrub } from "../scripts/db-url.mjs";
import { RIG_FILES, WRONG_LOGINS } from "./files.mjs";
import { localPassword, localString } from "./local-url.mjs";

// postgres.js's Node build, by Node's own resolution. Vitest loads the globalSetup through the Workers project's module
// runner, which resolves a package with workerd's conditions, and postgres.js's workerd build needs cloudflare:sockets,
// which Node has not.
const postgres = createRequire(import.meta.url)("postgres");

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** The local database of infra/docker-compose.yml (local only, not a secret), as vitest.config.ts names it. */
export const LOCAL_DATABASE_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
/** The loopback names a local string may use (ADR-014 section 4), as Node's URL gives them. */
export const LOOPBACK = Object.freeze(["127.0.0.1", "[::1]", "localhost"]);
/** The database the pool's own pair names: never made, so a connect through it fails. */
export const NONE_DATABASE = "rosie_rig_none";
/** Every database the rig makes starts with this, then the run's id and an underscore. */
export const RIG_PREFIX = "rosie_rig_";
/** The Worker's two logins (ADR-014 section 3). */
export const WORKER_LOGINS = Object.freeze({ job: "rosie_worker_job", app: "rosie_worker_app" });
/** What the globalSetup provides, by name (Vitest's provide and inject; infra/test-rig/provided.d.ts types them). */
export const PROVIDED = Object.freeze({ hyperdrives: "rosieRigHyperdrives", databases: "rosieRigDatabases" });

// The server's maintenance database, which initdb makes on every server: the rig's own statements run there, so none
// holds a snapshot in a database other runs migrate (db/repo/test-db.ts says why).
const MAINTENANCE_DATABASE = "postgres";
const POSTGIS_TEMPLATE = "template_postgis";
const PLAIN_TEMPLATE = "template1";
const WORKER_LOGINS_SQL = path.join(REPO, "infra/scripts/worker-logins.sql");
const MIGRATE = path.join(REPO, "infra/scripts/migrate.mjs");
const PUBLISH = path.join(REPO, "infra/scripts/publish-bundle.sh");
const BUNDLE_V0 = path.join(REPO, "bundles/v0");
const KEY = /^[A-Z][A-Z0-9_]{0,39}$/;
const RESERVED_KEYS = new Set(["TEMPLATE", "NONE"]);
const RUN_ID = /^[0-9a-z]{4,16}$/;

/** A run refused before anything was made. Its message names the fault and holds no part of the URL. */
export class RigRefusal extends Error {}

/**
 * A step that failed, as the rig reports it: what failed and the error's code and message, scrubbed of every part of the
 * URL (db-url.mjs describeError). It carries no cause on purpose: a database's or a socket's error may name the host,
 * port, user or database in its other fields, and Node and Vitest print a cause whole.
 */
export class RigError extends Error {}

const quiet = { onnotice: () => undefined };

/** DATABASE_URL, else the local default when CI is unset; refused when CI is set and DATABASE_URL is not. */
export function serverUrl(env = process.env) {
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== "") return env.DATABASE_URL;
  if (env.CI !== undefined && env.CI !== "") {
    throw new RigRefusal(
      "refused: DATABASE_URL is not set, and with CI set the local default is never used; nothing was made",
    );
  }
  return LOCAL_DATABASE_URL;
}

/**
 * Refuses, before any connection, a URL that is not one database URL or whose host is not a loopback name. Returns the
 * URL's parts (db-url.mjs), which no printed line may hold.
 */
export function checkLocalUrl(url) {
  let parts;
  try {
    parts = checkDatabaseUrl(url);
  } catch (error) {
    if (error instanceof DatabaseUrlFault) {
      throw new RigRefusal(`refused: DATABASE_URL does not parse: ${error.message}; nothing was made`);
    }
    throw error;
  }
  if (!LOOPBACK.includes(new URL(url).hostname)) {
    throw new RigRefusal(
      "refused: the rig runs only on a local or CI server, and DATABASE_URL's host is not a loopback name " +
        "(127.0.0.1, ::1 or localhost); nothing was made",
    );
  }
  return parts;
}

/** The URL of database `name` on the server `url` names: its path changed, nothing else (as test-db.ts does). */
export function urlOfDatabase(url, name) {
  const other = new URL(url);
  other.pathname = `/${name}`;
  return other.href;
}

/** A run's database for a key, and its template. */
export const databaseOf = (run, key) => `${RIG_PREFIX}${run}_${key.toLowerCase()}`;
export const templateOf = (run) => `${RIG_PREFIX}${run}_template`;

/** Fails when the list is not as files.mjs says: keys, uniqueness, and paths inside the repository. */
export function checkFiles(files = RIG_FILES, wrong = WRONG_LOGINS) {
  const keys = new Set();
  for (const entry of files) {
    if (!KEY.test(entry.key) || RESERVED_KEYS.has(entry.key) || keys.has(entry.key)) {
      throw new Error(
        `the rig's list: the key ${JSON.stringify(entry.key)} is not a new one of [A-Z][A-Z0-9_]*`,
      );
    }
    keys.add(entry.key);
    for (const file of [entry.test, entry.seed]) {
      if (typeof file !== "string" || path.isAbsolute(file) || path.normalize(file).startsWith("..")) {
        throw new Error(
          `the rig's list: ${entry.key}'s ${JSON.stringify(file)} is not a path in the repository`,
        );
      }
    }
  }
  if (!keys.has(wrong.key)) throw new Error(`the rig's list names no file ${wrong.key} for the wrong logins`);
}

/** Runs a command and resolves with its output; rejects naming `what` and its output, with the URLs taken out. */
function runChild(command, args, env, urls, what) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => reject(new Error(`${what} could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${what} failed (exit ${String(code)}):\n${scrub(output, urls)}`));
    });
  });
}

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (text) => `'${text.replaceAll("'", "''")}'`;

/** A client on the server's maintenance database, as the URL's login, for one step. */
export function adminOf(url) {
  return postgres(urlOfDatabase(url, MAINTENANCE_DATABASE), { max: 1, connect_timeout: 15, ...quiet });
}

/** Refuses a login that is not a superuser, before anything is made. */
export async function refuseUnlessSuperuser(admin) {
  const [me] = await admin`select rolsuper from pg_catalog.pg_roles where rolname = current_user`;
  if (me?.rolsuper !== true) {
    throw new RigRefusal(
      "refused: the rig runs only on a local or CI server, where DATABASE_URL's login is a superuser (the " +
        "container's first user), and this login is not one; nothing was made",
    );
  }
}

/** Refuses to start while the database the pool's own pair names exists. */
export async function refuseIfNoneExists(admin, none = NONE_DATABASE) {
  const [found] =
    await admin`select exists (select 1 from pg_catalog.pg_database where datname = ${none}) as present`;
  if (found?.present === true) {
    throw new RigRefusal(
      `refused: a database named ${none} exists on this server; the pool's own HYPERDRIVE_JOB and HYPERDRIVE_APP ` +
        `name it so that a connect through them fails, so it is never made: drop it, then run again; nothing was made`,
    );
  }
}

/** Whether the string's login logs in (true), or is refused its password (false); any other failure throws. */
async function logsIn(string, parts) {
  const sql = postgres(string, { max: 1, connect_timeout: 15, ...quiet });
  try {
    await sql`select 1`;
    return true;
  } catch (error) {
    if (error?.code === "28P01") return false;
    throw new RigError(`a login check failed${describeError(error, [...parts, string])}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Sets the login's local password only when it cannot log in with it already: "kept" or "set". */
async function ensureLocalPassword(admin, url, parts, login) {
  const password = localPassword(login);
  const string = localString(url, { login, password, database: MAINTENANCE_DATABASE });
  if (await logsIn(string, parts)) return "kept";
  await admin.unsafe(`alter role ${quoteIdent(login)} password ${quoteLiteral(password)}`);
  if (!(await logsIn(string, parts)))
    throw new Error(`${login} cannot log in with its local password once set`);
  return "set";
}

/** A login's shape, read as worker-logins.sql reads it: its flags, its memberships by member, what names it. */
export async function shapeOf(admin, login) {
  const [row] = await admin`
    select r.rolcanlogin as login, r.rolsuper as superuser, r.rolcreatedb as createdb,
           r.rolcreaterole as createrole, r.rolreplication as replication, r.rolbypassrls as bypassrls,
           coalesce((
             select pg_catalog.string_agg(pg_catalog.format('%s (inherit %s, set %s, admin %s)', g.rolname,
                      m.inherit_option::text, m.set_option::text, m.admin_option::text), ', ' order by g.rolname)
             from pg_catalog.pg_auth_members m join pg_catalog.pg_roles g on g.oid = m.roleid
             where m.member = r.oid), 'none') as memberships,
           (select pg_catalog.count(*)::int from pg_catalog.pg_shdepend s
             where s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and s.refobjid = r.oid) as named_by
    from pg_catalog.pg_roles r where r.rolname = ${login}`;
  return row === undefined ? null : { ...row };
}

/**
 * The logins step, the same for the rig and `npm run db:logins`: worker-logins.sql, then each login's local password.
 * Returns, for each login, its shape read back and whether its password was kept or set.
 */
export async function makeWorkerLogins(admin, url, parts) {
  try {
    await admin.unsafe(readFileSync(WORKER_LOGINS_SQL, "utf8"));
  } catch (error) {
    const hint =
      error?.code === "42704"
        ? " (rosie_job and rosie_app are made by migration 0012: run npm run migrate on this server first)"
        : "";
    throw new RigError(`worker-logins.sql failed${describeError(error, parts)}${hint}`);
  }
  const logins = [];
  for (const login of [WORKER_LOGINS.job, WORKER_LOGINS.app]) {
    const password = await ensureLocalPassword(admin, url, parts, login);
    logins.push({ login, password, shape: await shapeOf(admin, login) });
  }
  return logins;
}

// The wrong logins' memberships (files.mjs WRONG_LOGINS): [role, inherit] pairs, each granted WITH SET FALSE; and the
// rest of the shape, the same for every one.
const WRONG_MEMBERSHIPS = Object.freeze({
  rosie_rig_both_roles: [
    ["rosie_app", true],
    ["rosie_job", true],
  ],
  rosie_rig_other_role: [
    ["rosie_app", false],
    ["rosie_job", true],
  ],
  rosie_rig_owner: [["rosie_job", true]],
  rosie_rig_second_membership: [
    ["pg_read_all_data", true],
    ["rosie_job", true],
  ],
  rosie_rig_login_schema: [["rosie_job", true]],
});
const RIGHT_FLAGS = { login: true, superuser: false, createdb: false, createrole: false, replication: false };

/**
 * T-1254's wrong logins, each made only when missing, in one block with its grants (a duplicate from a run beside it is
 * skipped, as worker-logins.sql skips one), then read back and refused in any other shape (never repaired), then given
 * its local password.
 */
export async function makeWrongLogins(admin, url, parts, cases = WRONG_LOGINS.cases) {
  for (const { login } of cases) {
    if (login === null) continue;
    const memberships = WRONG_MEMBERSHIPS[login];
    if (memberships === undefined) throw new Error(`the rig has no shape for the wrong login ${login}`);
    const grants = memberships
      .map(
        ([role, inherit]) =>
          `grant ${quoteIdent(role)} to ${quoteIdent(login)} with inherit ${inherit}, set false;`,
      )
      .join("\n        ");
    await admin.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(login)}) then
          begin
            create role ${quoteIdent(login)} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
            ${grants}
          exception
            when duplicate_object or unique_violation then
              null;
          end;
        end if;
      end
      $$`);
    const shape = await shapeOf(admin, login);
    const wanted = memberships
      .map(([role, inherit]) => `${role} (inherit ${String(inherit)}, set false, admin false)`)
      .join(", ");
    const flagsRight =
      shape !== null && Object.entries(RIGHT_FLAGS).every(([flag, value]) => shape[flag] === value);
    if (!flagsRight || shape.bypassrls !== false || shape.memberships !== wanted) {
      throw new Error(
        `the rig's wrong login ${login} is not in its shape (LOGIN and no other attribute; memberships ${wanted}): ` +
          `it is left as it is`,
      );
    }
    await ensureLocalPassword(admin, url, parts, login);
  }
}

/**
 * In T-1254's database, for the cases that need it: businesses owned by rosie_rig_owner, and a schema named after
 * rosie_rig_login_schema, owned by the connecting login, which rosie_rig_login_schema may use.
 */
async function makeWrongObjects(url, database, cases) {
  const logins = new Set(cases.map((wrongCase) => wrongCase.login));
  const sql = postgres(urlOfDatabase(url, database), { max: 1, connect_timeout: 15, ...quiet });
  try {
    if (logins.has("rosie_rig_owner")) {
      await sql.unsafe(`alter table public.businesses owner to ${quoteIdent("rosie_rig_owner")}`);
    }
    if (logins.has("rosie_rig_login_schema")) {
      await sql.unsafe(`create schema ${quoteIdent("rosie_rig_login_schema")}`);
      await sql.unsafe(
        `grant usage on schema ${quoteIdent("rosie_rig_login_schema")} to ${quoteIdent("rosie_rig_login_schema")}`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * The pool's Hyperdrive bindings, every string built by local-url.mjs: the pool's own pair on `none`; each named file's
 * pair on its database, or on `none` while it has none; and the wrong logins' bindings on T-1254's database.
 */
export function poolBindings(
  url,
  databases,
  { none = NONE_DATABASE, files = RIG_FILES, wrong = WRONG_LOGINS } = {},
) {
  const parsed = new URL(url);
  const pair = (database) => ({
    job: localString(url, { login: WORKER_LOGINS.job, password: localPassword(WORKER_LOGINS.job), database }),
    app: localString(url, { login: WORKER_LOGINS.app, password: localPassword(WORKER_LOGINS.app), database }),
  });
  const bindings = {};
  const own = pair(none);
  bindings.HYPERDRIVE_JOB = own.job;
  bindings.HYPERDRIVE_APP = own.app;
  for (const entry of files) {
    const filePair = pair(databases[entry.key] ?? none);
    bindings[`HYPERDRIVE_JOB_${entry.key}`] = filePair.job;
    bindings[`HYPERDRIVE_APP_${entry.key}`] = filePair.app;
  }
  const wrongDatabase = databases[wrong.key] ?? none;
  for (const { binding, login } of wrong.cases) {
    bindings[`HYPERDRIVE_${wrong.key}_${binding}`] =
      login === null
        ? localString(url, {
            login: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
            database: wrongDatabase,
          })
        : localString(url, { login, password: localPassword(login), database: wrongDatabase });
  }
  return bindings;
}

/** Drops each database named, only when it is one of the run's own; in parallel, so their checkpoints are shared. */
export async function dropRunDatabases(url, run, names) {
  const own = `${RIG_PREFIX}${run}_`;
  const strangers = names.filter((name) => !name.startsWith(own));
  if (strangers.length > 0) {
    throw new Error(`the rig drops only its run's databases (${own}*), never ${strangers.join(", ")}`);
  }
  const results = await Promise.allSettled(
    names.map(async (name) => {
      const sql = adminOf(url);
      try {
        await sql`drop database if exists ${sql(name)} with (force)`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }),
  );
  const failed = results.flatMap((result, i) =>
    result.status === "rejected" ? [`${names[i]}${describeError(result.reason, checkDatabaseUrl(url))}`] : [],
  );
  if (failed.length > 0) throw new Error(`the rig could not drop: ${failed.join("; ")}`);
}

/**
 * Starts the rig (see the top of this file). Options, for its tests: env (default process.env), files and wrong (default
 * files.mjs), none (default rosie_rig_none), run (default 8 random hex digits), importSeed (default a dynamic import),
 * log (default none). Resolves with { run, databases, hyperdrives, made, stop }: databases maps each key that has one to
 * its database's name; made lists every database the run made; stop() drops them.
 */
export async function startRig(options = {}) {
  const env = options.env ?? process.env;
  const files = options.files ?? RIG_FILES;
  const wrong = options.wrong ?? WRONG_LOGINS;
  const none = options.none ?? NONE_DATABASE;
  const run = options.run ?? randomBytes(4).toString("hex");
  const importSeed = options.importSeed ?? ((file) => import(file));
  const log = options.log ?? (() => undefined);
  checkFiles(files, wrong);
  if (!RUN_ID.test(run)) throw new Error("the rig's run id is 4 to 16 lower-case letters and digits");

  const url = serverUrl(env);
  const parts = checkLocalUrl(url);
  const made = [];
  const stop = async () => {
    const names = [...made];
    made.length = 0;
    if (names.length === 0) return;
    await dropRunDatabases(url, run, names);
    log(`Workers test rig ${run}: dropped ${names.join(", ")}`);
  };

  const admin = adminOf(url);
  try {
    await refuseUnlessSuperuser(admin);
    await refuseIfNoneExists(admin, none);

    const template = templateOf(run);
    const [found] = await admin`
      select exists (select 1 from pg_catalog.pg_database where datname = ${POSTGIS_TEMPLATE} and datistemplate) as postgis`;
    await admin`create database ${admin(template)} template ${admin(found?.postgis === true ? POSTGIS_TEMPLATE : PLAIN_TEMPLATE)}`;
    made.push(template);
    const templateUrl = urlOfDatabase(url, template);
    const urls = [url, new URL(url).href, templateUrl];
    await runChild(
      process.execPath,
      [MIGRATE],
      { DATABASE_URL: templateUrl, DB_SCHEMA: "" },
      urls,
      "migrating the template",
    );
    await runChild(
      "bash",
      [PUBLISH, "--env", "local", BUNDLE_V0],
      { DATABASE_URL: templateUrl, DB_SCHEMA: "" },
      urls,
      "publishing bundle v0 in the template",
    );

    await makeWorkerLogins(admin, url, parts);

    const databases = {};
    for (const entry of files) {
      if (!existsSync(path.join(REPO, entry.test))) continue;
      const database = databaseOf(run, entry.key);
      await admin`create database ${admin(database)} template ${admin(template)}`;
      made.push(database);
      databases[entry.key] = database;
      const seedFile = path.join(REPO, entry.seed);
      if (existsSync(seedFile)) {
        const module = await importSeed(seedFile);
        if (typeof module.seed !== "function") throw new Error(`${entry.seed} exports no seed function`);
        const sql = postgres(urlOfDatabase(url, database), { max: 1, connect_timeout: 15, ...quiet });
        try {
          await module.seed(sql);
        } finally {
          await sql.end({ timeout: 5 });
        }
      }
    }
    if (databases[wrong.key] !== undefined) {
      await makeWrongLogins(admin, url, parts, wrong.cases);
      await makeWrongObjects(url, databases[wrong.key], wrong.cases);
    }

    const hyperdrives = poolBindings(url, databases, { none, files, wrong });
    log(
      `Workers test rig ${run}: made ${made.join(", ")} (migrated, bundle v0 active); ` +
        `${String(Object.keys(databases).length)} of ${String(files.length)} named files have a database; ` +
        `logins ${WORKER_LOGINS.job} and ${WORKER_LOGINS.app} ready`,
    );
    return { run, databases, hyperdrives, made: [...made], stop };
  } catch (error) {
    try {
      await stop();
    } catch (dropError) {
      log(`Workers test rig ${run}: ${dropError instanceof Error ? dropError.message : String(dropError)}`);
    }
    // The rig's own errors name no part of the URL; a database's or a socket's (they carry a code) may name its host,
    // port, user or database, so it goes on as its code and message, scrubbed, and no other field.
    if (error instanceof Error && (error instanceof RigRefusal || error.code === undefined)) throw error;
    throw new RigError(`the Workers test rig failed${describeError(error, parts)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
