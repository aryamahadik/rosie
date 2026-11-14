// The deploy-time check of the Worker's two database logins (ADR-014 section 4's piece 4 and "T-1093's notes (piece
// 4)"; T-1093, with its lead notes DL-506 and DL-511). deploy-staging.sh runs it after step 1 (the migrations) and
// before step 2 (the code), so a refusal stops the deploy before any traffic reaches a Worker that opens a client
// through HYPERDRIVE_JOB or HYPERDRIVE_APP:
//
//   STAGING_DATABASE_URL=<the migrations' role's URL> node infra/scripts/worker-logins-check.mjs
//
// It only reads, and changes nothing. It runs once for each login, by name (PAIRS below):
//   rosie_worker_job  inherits rosie_job only, stored by rosie-staging-hyperdrive-job, bound as HYPERDRIVE_JOB
//   rosie_worker_app  inherits rosie_app only, stored by rosie-staging-hyperdrive-app, bound as HYPERDRIVE_APP
//
//  1. STAGING_DATABASE_URL, by name: taken out of this process's environment at once (with DATABASE_URL and
//     DATABASE_REPLICA_URL), so cf.sh, the one command it starts, never finds it, and checked by db-url.mjs before any
//     client is built. It is never printed, nor any part of it: no host, user, password or database name. A URL that is
//     not set is refused: without the catalog the check cannot pass, and a deploy never goes on unchecked.
//  2. wrangler.jsonc's env.staging hyperdrive list: exactly the two bindings, each with an id of 32 hex characters.
//  3. `cf.sh hyperdrive list` (the account's configurations, through the Rosfield sign-in), read by
//     hyperdrive-list.mjs (T-1252's parser): each binding's id is its configuration's, by name; the configuration
//     stores its login (the user cell, compared and never printed when it is another); caching is disabled (ADR-007).
//     The list's text names each origin's host and user, so it is read from a pipe and never shown.
//  4. The catalog, as the migrations' role (no login's password is needed), over one connection, with TLS and the
//     server's certificate and name checked whenever the URL asks for TLS at all (judgeCatalog below):
//      - the server is PostgreSQL 16 or later (a grant's INHERIT and SET options are new in 16);
//      - each login: LOGIN, and none of SUPERUSER, CREATEDB, CREATEROLE, REPLICATION and BYPASSRLS; its memberships,
//        read by member (the rows of pg_auth_members whose member is the login): exactly one, its role, with
//        inherit_option true, set_option false and admin_option false, so it inherits exactly one of rosie_app and
//        rosie_job and can switch to none. The maker's row PostgreSQL 16 adds on staging has the login as roleid and
//        is not read. A membership a host adds (Neon's neon_superuser) fails here;
//      - each login is named by no row of pg_shdepend, in any database: it owns nothing (no table, function, schema or
//        any other object), holds no grant of its own and no policy names it, as worker-logins.sql makes it;
//      - each role (rosie_app, rosie_job) is as 0012_core_rls.sql makes it: NOLOGIN, and none of SUPERUSER, CREATEDB,
//        CREATEROLE, REPLICATION and BYPASSRLS; a member of no role at all, read by member (DL-511: a membership the
//        role holds, pg_read_all_data say, would reach every login that inherits it), so neither is a member of the
//        migrations' role or of the other; and it owns nothing, in any database (a login that inherits an owner
//        bypasses row-level security on what it owns: T-191's architect note b). Its grants and the policies naming it
//        are 0012's and each later migration's, and are its own business.
// Every fault found is printed, one line each, on standard error, after the lines that passed on standard output.
// Exit: 0 every check passed; 1 refused (the lines say why); 2 misuse (any argument), found before anything is read.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";

import { DatabaseUrlFault, checkDatabaseUrl, describeError, printStrayErrors } from "./db-url.mjs";
import { hyperdriveRow } from "./hyperdrive-list.mjs";

const PROGRAM = "worker-logins-check";
const HERE = import.meta.dirname;
const CF = path.join(HERE, "cf.sh");
const WRANGLER_CONFIG = path.join(HERE, "..", "..", "wrangler.jsonc");

/** Each binding, the configuration behind it, the login it stores and the one role that login inherits (ADR-014). */
export const PAIRS = [
  {
    binding: "HYPERDRIVE_JOB",
    configuration: "rosie-staging-hyperdrive-job",
    login: "rosie_worker_job",
    role: "rosie_job",
  },
  {
    binding: "HYPERDRIVE_APP",
    configuration: "rosie-staging-hyperdrive-app",
    login: "rosie_worker_app",
    role: "rosie_app",
  },
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
// A role's attributes, as pg_roles names them, with the word each is written with when it is on and when it is off.
const ATTRIBUTES = [
  ["rolcanlogin", "LOGIN", "NOLOGIN"],
  ["rolsuper", "SUPERUSER", "NOSUPERUSER"],
  ["rolcreatedb", "CREATEDB", "NOCREATEDB"],
  ["rolcreaterole", "CREATEROLE", "NOCREATEROLE"],
  ["rolreplication", "REPLICATION", "NOREPLICATION"],
  ["rolbypassrls", "BYPASSRLS", "NOBYPASSRLS"],
];
// What an owned object is, by the catalog pg_shdepend names (classid).
const OWNED = {
  pg_class: "table(s) or other relation(s)",
  pg_proc: "function(s)",
  pg_namespace: "schema(s)",
  pg_type: "type(s)",
  pg_database: "database(s)",
};

/** A run stopped on purpose: its message says why and holds no part of the database URL. */
class Refusal extends Error {}
/** A command line it does not take (exit 2). */
class Misuse extends Error {}

// What no printed line may hold: the database URL's parts (db-url.mjs), once it is known.
let secrets = [];
const AS_PROGRAM = process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;
if (AS_PROGRAM) printStrayErrors(PROGRAM, () => secrets);

/** A role's attributes as written, e.g. "LOGIN NOSUPERUSER ...". */
const attributesOf = (role) => ATTRIBUTES.map(([key, on, off]) => (role[key] === true ? on : off)).join(" ");

/** A membership as written: "<role> (inherit <b>, set <b>, admin <b>)". */
const membershipText = (row) =>
  `${String(row.role)} (inherit ${String(row.inherit_option)}, set ${String(row.set_option)}, admin ${String(row.admin_option)})`;

/** A catalog's name as the server gave it, or "a catalog" when it is not a plain name. */
const catalogName = (text) => (/^[a-z_][a-z0-9_]{0,62}$/.test(String(text)) ? String(text) : "a catalog");

/** What a group of pg_shdepend rows says about a role, in words. */
function dependencyText(row) {
  const count = String(row.how_many);
  const catalog = catalogName(row.catalog);
  switch (row.deptype) {
    case "o":
      return `it owns ${count} ${OWNED[catalog] ?? `object(s) of ${catalog}`}`;
    case "a":
      return `it holds ${count} grant(s) of its own (on objects of ${catalog})`;
    case "r":
      return `${count} policy(ies) name it`;
    default:
      return `${count} other row(s) of pg_shdepend name it (kind ${/^[a-z]$/.test(String(row.deptype)) ? String(row.deptype) : "?"}, objects of ${catalog})`;
  }
}

/**
 * The catalog rows the check judges, read as the connection's role (on staging, the migrations' role), for the logins
 * and roles of `pairs`. Read-only: plain SELECTs of pg_catalog. Returns { serverVersionNum, roles, memberships,
 * dependencies }; on a server older than PostgreSQL 16 only the version (pg_auth_members has no inherit_option or
 * set_option there).
 *  - roles: pg_roles' rows for those names: rolname and the six attributes.
 *  - memberships: pg_auth_members' rows whose member is one of those names (read by member, never by roleid):
 *    { member, role, inherit_option, set_option, admin_option }.
 *  - dependencies: pg_shdepend's rows that name one of them, in any database, counted by kind and catalog:
 *    { rolname, deptype, catalog, how_many }.
 */
export async function readCatalog(sql, pairs = PAIRS) {
  const names = [...pairs.map((pair) => pair.login), ...pairs.map((pair) => pair.role)];
  const [server] = await sql`select pg_catalog.current_setting('server_version_num') as server_version_num`;
  const serverVersionNum = String(server.server_version_num);
  if (!(Number(serverVersionNum) >= 160000)) {
    return { serverVersionNum, roles: [], memberships: [], dependencies: [] };
  }
  const roles = await sql`
    select r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
    from pg_catalog.pg_roles r
    where r.rolname = any(${names})
    order by r.rolname`;
  const memberships = await sql`
    select holder.rolname as member, granted.rolname as role, m.inherit_option, m.set_option, m.admin_option
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles holder on holder.oid = m.member
    join pg_catalog.pg_roles granted on granted.oid = m.roleid
    where holder.rolname = any(${names})
    order by holder.rolname, granted.rolname`;
  const dependencies = await sql`
    select r.rolname, d.deptype::pg_catalog.text as deptype,
           d.classid::pg_catalog.regclass::pg_catalog.text as catalog, pg_catalog.count(*)::pg_catalog.int4 as how_many
    from pg_catalog.pg_shdepend d
    join pg_catalog.pg_roles r on r.oid = d.refobjid
    where d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass and r.rolname = any(${names})
    group by r.rolname, d.deptype, d.classid
    order by r.rolname, d.deptype, d.classid::pg_catalog.regclass::pg_catalog.text`;
  return {
    serverVersionNum,
    roles: Array.from(roles, (row) => ({ ...row })),
    memberships: Array.from(memberships, (row) => ({ ...row })),
    dependencies: Array.from(dependencies, (row) => ({ ...row })),
  };
}

/**
 * Judges the catalog rows (readCatalog's shape) against ADR-014's shape for each pair (the top of this file). Returns
 * { lines, faults }: what was found, in words (names, attributes and counts only), and every fault, each naming the
 * login or role and why. No faults: the catalog part of the check passed.
 */
export function judgeCatalog(catalog, pairs = PAIRS) {
  const lines = [];
  const faults = [];
  const version = Number(catalog.serverVersionNum);
  if (!Number.isInteger(version) || version < 160000) {
    faults.push(
      `the server reports server_version_num ${String(catalog.serverVersionNum)}: PostgreSQL 16 or later is needed (a login's one grant is WITH INHERIT TRUE, SET FALSE, read back from pg_auth_members' inherit_option and set_option)`,
    );
    return { lines, faults };
  }
  lines.push(`the server: server_version_num ${String(version)} (PostgreSQL 16 or later)`);
  const roleRow = (name) => catalog.roles.find((row) => row.rolname === name);
  const membershipsOf = (name) => catalog.memberships.filter((row) => row.member === name);
  const dependenciesOf = (name) => catalog.dependencies.filter((row) => row.rolname === name);
  const listed = (rows) => (rows.length === 0 ? "none" : rows.map(membershipText).join(", "));

  for (const pair of pairs) {
    // The login: LOGIN and nothing else; one membership, its role, inherit only; named by nothing.
    const login = roleRow(pair.login);
    if (login === undefined) {
      faults.push(
        `${pair.login} is not on the server (worker-logins.sql makes it; ${pair.binding}'s configuration stores it)`,
      );
    } else {
      const own = membershipsOf(pair.login);
      const named = dependenciesOf(pair.login);
      lines.push(
        `${pair.login}: ${attributesOf(login)}; memberships of its own: ${listed(own)}; pg_shdepend names it: ${named.length === 0 ? "nowhere" : named.map(dependencyText).join(", ")}`,
      );
      if (login.rolcanlogin !== true) faults.push(`${pair.login} is NOLOGIN`);
      for (const [key, on] of ATTRIBUTES.slice(1)) {
        if (login[key] !== false) faults.push(`${pair.login} is ${on}`);
      }
      const [only] = own;
      if (
        own.length !== 1 ||
        only.role !== pair.role ||
        only.inherit_option !== true ||
        only.set_option !== false ||
        only.admin_option !== false
      ) {
        faults.push(
          `${pair.login}'s memberships are ${listed(own)} where its one is ${pair.role} (inherit true, set false, admin false): it must inherit exactly one of the two roles, and be able to switch to none`,
        );
      }
      for (const row of named)
        faults.push(`${pair.login}: ${dependencyText(row)} (it must own and be named by nothing)`);
    }

    // Its role: as 0012 makes it; a member of nothing; owning nothing.
    const role = roleRow(pair.role);
    if (role === undefined) {
      faults.push(`${pair.role} is not on the server (0012_core_rls.sql makes it)`);
    } else {
      const own = membershipsOf(pair.role);
      const owned = dependenciesOf(pair.role).filter((row) => row.deptype === "o");
      lines.push(
        `${pair.role}: ${attributesOf(role)}; memberships of its own: ${listed(own)}; owns: ${owned.length === 0 ? "nothing" : owned.map(dependencyText).join(", ")}`,
      );
      if (role.rolcanlogin !== false) faults.push(`${pair.role} is LOGIN (0012 makes it NOLOGIN)`);
      for (const [key, on] of ATTRIBUTES.slice(1)) {
        if (role[key] !== false) faults.push(`${pair.role} is ${on} (0012 makes it NO${on})`);
      }
      if (own.length > 0) {
        faults.push(
          `${pair.role} is a member of ${own.map(membershipText).join(", ")}, where it must be a member of no role: every login that inherits ${pair.role} would gain it`,
        );
      }
      for (const row of owned) {
        faults.push(
          `${pair.role}: ${dependencyText(row)} (it must own nothing: a login that inherits an owner bypasses row-level security there)`,
        );
      }
    }
  }
  return { lines, faults };
}

/**
 * Judges wrangler.jsonc's env.staging hyperdrive list: exactly the pairs' bindings, once each, each with an id of 32
 * hex characters. Returns { bindings: Map(binding -> id), faults }.
 */
export function judgeBindings(config, pairs = PAIRS) {
  const bindings = new Map();
  const faults = [];
  const list = config?.env?.staging?.hyperdrive;
  if (!Array.isArray(list)) {
    faults.push(
      `wrangler.jsonc's env.staging has no hyperdrive list (it must bind ${pairs.map((pair) => pair.binding).join(" and ")})`,
    );
    return { bindings, faults };
  }
  const known = new Set(pairs.map((pair) => pair.binding));
  const seen = new Set();
  for (const entry of list) {
    const name =
      typeof entry?.binding === "string" && /^[A-Za-z0-9_]{1,64}$/.test(entry.binding) ? entry.binding : null;
    if (name === null || !known.has(name)) {
      faults.push(
        `wrangler.jsonc's env.staging binds ${name ?? "a binding with no plain name"}, which is not one of ${[...known].join(" and ")}: the check cannot say which login its configuration stores`,
      );
      continue;
    }
    if (seen.has(name)) {
      faults.push(`wrangler.jsonc's env.staging binds ${name} more than once`);
      continue;
    }
    seen.add(name);
    if (typeof entry.id !== "string" || !/^[0-9a-f]{32}$/.test(entry.id)) {
      faults.push(`wrangler.jsonc's env.staging ${name} has no id of 32 hex characters`);
      continue;
    }
    bindings.set(name, entry.id);
  }
  for (const pair of pairs) {
    if (!seen.has(pair.binding)) faults.push(`wrangler.jsonc's env.staging does not bind ${pair.binding}`);
  }
  return { bindings, faults };
}

/**
 * Judges the account's Hyperdrive list (the text `cf.sh hyperdrive list` printed) for each pair: its configuration
 * is listed once, its id is the one the binding names, it stores the pair's login, and its caching is disabled.
 * Returns { lines, faults }; neither ever holds a configuration's host, database or another user's name.
 */
export function judgeConfigurations(listing, bindings, pairs = PAIRS) {
  const lines = [];
  const faults = [];
  for (const pair of pairs) {
    let row;
    try {
      row = hyperdriveRow(listing, pair.configuration);
    } catch (error) {
      faults.push(
        error.exitCode === 3
          ? `more than one Hyperdrive configuration is named ${pair.configuration}`
          : `the Hyperdrive list could not be read (${String(error.message)}; its text is not shown: it names each origin's host and user)`,
      );
      continue;
    }
    if (row === null) {
      faults.push(
        `no Hyperdrive configuration is named ${pair.configuration} (the one ${pair.binding} must bind)`,
      );
      continue;
    }
    const stores = row.user === pair.login;
    lines.push(
      `${pair.binding}: ${pair.configuration}, id ${row.id}, caching ${row.caching}, stores ${pair.login}: ${stores ? "yes" : "no"}`,
    );
    const id = bindings.get(pair.binding);
    if (id !== undefined && id !== row.id) {
      faults.push(`${pair.binding} binds the id ${id}, which is not ${pair.configuration}'s (${row.id})`);
    }
    if (!stores) {
      faults.push(
        `${pair.configuration} stores ${row.user === null ? "a user the list does not show" : "another user (not shown)"}, not its login ${pair.login}`,
      );
    }
    if (row.caching !== "disabled") {
      faults.push(
        `${pair.configuration}'s caching is ${row.caching}, not disabled (ADR-007: both sides make decision reads)`,
      );
    }
  }
  return { lines, faults };
}

/**
 * wrangler.jsonc's text as an object: comments and trailing commas dropped outside strings, as cf.sh's check reads it,
 * the rest JSON. Throws an error whose message quotes none of the text.
 */
export function readWranglerConfig(text) {
  let json = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      json += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("a /* comment is not closed");
      json += " ";
      i = end + 1;
    } else if (c === "}" || c === "]") {
      json = json.replace(/,\s*$/, "") + c;
    } else {
      json += c;
    }
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("it does not parse");
  }
}

/**
 * TLS as the URL asks for it, except that when it asks for any (sslmode require, prefer, allow, verify-ca or
 * verify-full, or ssl, or sslrootcert=system) the server's certificate and name are always checked: postgres.js would
 * take sslmode=require without a check. A URL that asks for none (the local server) connects as it says.
 */
export function tlsFor(raw) {
  const params = new URL(raw).searchParams;
  if (params.get("sslrootcert") === "system") return { rejectUnauthorized: true };
  const mode = (params.get("sslmode") ?? params.get("ssl") ?? "").toLowerCase();
  return mode === "" || mode === "disable" || mode === "false" ? false : { rejectUnauthorized: true };
}

/** The environment of cf.sh: this one's, without the database URL (or a copy of it) and the credential names. */
function childEnvironment(copies) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || DROPPED_NAMES.includes(name)) continue;
    if (copies.some((part) => value.includes(part))) continue;
    env[name] = value;
  }
  // The list's table names each origin's host and user: wrangler keeps no log file of it, and sends no usage event.
  env.WRANGLER_LOG_SANITIZE = "true";
  env.WRANGLER_WRITE_LOGS = "false";
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}

/** `bash cf.sh hyperdrive list`: standard output kept (a pipe, never shown), standard error to the terminal. */
function listConfigurations(copies) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [CF, "hyperdrive", "list"], {
      env: childEnvironment(copies),
      stdio: ["ignore", "pipe", "inherit"],
    });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ status: code ?? (signal === null ? 1 : 128), stdout: Buffer.concat(out).toString("utf8") });
    });
  });
}

const say = (line) => process.stdout.write(`${PROGRAM}: ${line}\n`);

async function main(args) {
  if (args.length > 0) throw new Misuse("it takes no arguments (they are never echoed)");

  // 1. The database URL: out of this process's environment at once, so cf.sh never finds it.
  const raw = process.env.STAGING_DATABASE_URL ?? "";
  delete process.env.STAGING_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_REPLICA_URL;
  if (raw === "") {
    throw new Refusal(
      "STAGING_DATABASE_URL is not set (from the environment, else from .dev.vars by name), so the catalog cannot be read as the migrations' role: the check cannot pass without it",
    );
  }
  secrets = [raw];
  try {
    secrets = checkDatabaseUrl(raw);
  } catch (error) {
    if (!(error instanceof DatabaseUrlFault)) throw error;
    throw new Refusal(`STAGING_DATABASE_URL does not parse: ${error.message}; nothing was read`);
  }
  const url = new URL(raw);
  const copies = [raw, url.href, url.password, decodeURIComponent(url.password)].filter(
    (part) => part.length >= 6,
  );

  const lines = [];
  const faults = [];
  // 2. The bindings.
  let config;
  try {
    config = readWranglerConfig(readFileSync(WRANGLER_CONFIG, "utf8"));
  } catch (error) {
    faults.push(`wrangler.jsonc cannot be read (${error instanceof Error ? error.message : "unknown"})`);
  }
  const { bindings, faults: bindingFaults } =
    config === undefined ? { bindings: new Map(), faults: [] } : judgeBindings(config);
  faults.push(...bindingFaults);

  // 3. The configurations behind them.
  const listed = await listConfigurations(copies);
  if (listed.status !== 0) {
    faults.push(
      `cf.sh hyperdrive list failed (exit ${String(listed.status)}, for the reason above), so which login each configuration stores is not known`,
    );
  } else {
    const judged = judgeConfigurations(listed.stdout, bindings);
    lines.push(...judged.lines);
    faults.push(...judged.faults);
  }

  // 4. The catalog, as the migrations' role.
  const sql = postgres(raw, {
    max: 1,
    ssl: tlsFor(raw),
    debug: false,
    connect_timeout: 30,
    onnotice: () => undefined,
    connection: { application_name: "rosie-worker-logins-check" },
  });
  try {
    let catalog;
    try {
      catalog = await readCatalog(sql);
    } catch (error) {
      throw new Refusal(
        `the catalog could not be read as the migrations' role${describeError(error, secrets)}`,
      );
    }
    const judged = judgeCatalog(catalog);
    lines.push(...judged.lines);
    faults.push(...judged.faults);
  } finally {
    await sql.end({ timeout: 5 });
  }

  for (const line of lines) say(line);
  const unique = [...new Set(faults)];
  if (unique.length > 0) {
    for (const fault of unique) process.stderr.write(`${PROGRAM}: refused: ${fault}\n`);
    process.stderr.write(
      `${PROGRAM}: refused: ${String(unique.length)} fault(s) above; nothing was changed (ADR-014 piece 4)\n`,
    );
    return 1;
  }
  say(
    `passed: ${PAIRS.map((pair) => `${pair.login} inherits ${pair.role} alone and owns nothing, behind ${pair.binding}`).join("; ")}`,
  );
  return 0;
}

if (AS_PROGRAM) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Misuse) {
      process.stderr.write(
        `${PROGRAM}: ${error.message}\nusage: node infra/scripts/worker-logins-check.mjs\n`,
      );
      process.exitCode = 2;
    } else if (error instanceof Refusal) {
      process.stderr.write(`${PROGRAM}: refused: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`${PROGRAM}: failed${describeError(error, secrets)}\n`);
      process.exitCode = 1;
    }
  }
}
