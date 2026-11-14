// Tests for infra/scripts/worker-logins-check.mjs, the deploy-time check of the Worker's two logins (ADR-014 piece 4;
// T-1093, with its lead notes DL-506 and DL-511), and for its place in deploy-staging.sh, run by
// `node --test "infra/ci/*.test.mjs"`:
//  - the judges against fixed catalog rows, bindings and Hyperdrive lists (no database): the right shape passes, and
//    each wrong one is refused with its reason;
//  - readCatalog on the local rosie-pg (npm run db:up), or DATABASE_URL's server, with roles of this run's own, the
//    logins made by worker-logins.sql (its names swapped) as a maker that is not a superuser, as on staging;
//  - the real check in a release root (release-harness.mjs), its four names swapped for this run's, run by a deploy
//    after step 1 and before step 2 against a throwaway database and a made-up Hyperdrive list.
// Logins are cluster-wide and the build Mac's one server is shared (worker-logins.test.mjs says why), so no test makes
// or touches rosie_worker_job, rosie_worker_app, rosie_job or rosie_app. Every role and schema a run makes is dropped
// after it, pass or fail, and another run's are never touched. No real host, user, password or database is here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import postgres from "postgres";

import {
  PAIRS,
  judgeBindings,
  judgeCatalog,
  judgeConfigurations,
  readCatalog,
  readWranglerConfig,
  tlsFor,
} from "../scripts/worker-logins-check.mjs";
import {
  BAD_DATABASE_URLS,
  assertNoUrlPart,
  createThrowawayDatabase,
  releaseRoot,
} from "./release-harness.mjs";
import { REPO, cleanEnv, tempDir } from "./script-harness.mjs";

const CHECK = path.join(REPO, "infra/scripts/worker-logins-check.mjs");
const LOCAL_URL = "postgres://rosie:rosie@127.0.0.1:54329/rosie";
const RUN = `t1093_${randomBytes(3).toString("hex")}`;
// A made-up name for staging's migrations' role, in fixed rows only.
const MAKER = "staging_migrator_t1093";
// env.staging's two bindings, as wrangler.jsonc holds them (T-567).
const STAGING = new Map(
  readWranglerConfig(readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8")).env.staging.hyperdrive.map(
    (entry) => [entry.binding, entry.id],
  ),
);
const OTHER_ID = "0123456789abcdef0123456789abcdef";

/** The URL of the server the tests run on: DATABASE_URL, else the local rosie-pg (never when CI is set). */
function serverUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.CI)
    throw new Error("DATABASE_URL is not set, and with CI set the local database is never used");
  return LOCAL_URL;
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** A text with the four names swapped for a run's own (as worker-logins.test.mjs swaps them); fails if one is left. */
function swapped(text, names) {
  let out = text;
  for (const [from, to] of [
    ["rosie_worker_job", names.worker_job],
    ["rosie_worker_app", names.worker_app],
    ["rosie_job", names.job],
    ["rosie_app", names.app],
  ]) {
    assert.match(out, new RegExp(`\\b${from}\\b`), `the text no longer names ${from}`);
    out = out.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  assert.doesNotMatch(out, /\brosie_(worker_)?(job|app)\b/, "the swap left one of the four names");
  return out;
}

/** A run's own four names under a prefix. */
const namesOf = (prefix) => ({
  worker_job: `${prefix}_worker_job`,
  worker_app: `${prefix}_worker_app`,
  job: `${prefix}_job`,
  app: `${prefix}_app`,
});

/** PAIRS with the run's own logins and roles. */
const pairsOf = (names) =>
  PAIRS.map((pair) =>
    pair.binding === "HYPERDRIVE_JOB"
      ? { ...pair, login: names.worker_job, role: names.job }
      : { ...pair, login: names.worker_app, role: names.app },
  );

/** Drops every role whose name starts with the prefix (and what it owns), then checks none is left. */
async function dropRoles(admin, prefix) {
  const roles =
    await admin`select rolname from pg_roles where starts_with(rolname, ${prefix}) order by rolname`;
  for (const { rolname } of roles) {
    await admin.unsafe(`drop owned by ${quote(rolname)}`);
    await admin.unsafe(`drop role ${quote(rolname)}`);
  }
  const [{ left }] =
    await admin`select count(*)::int as left from pg_roles where starts_with(rolname, ${prefix})`;
  assert.equal(left, 0, `roles of this run are left on the server (${prefix}*)`);
}

// --- Fixed catalog rows -------------------------------------------------------------------------------------------

const LOGIN = {
  rolcanlogin: true,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
};
const ROLE = { ...LOGIN, rolcanlogin: false };
const member = (who, role, { inherit = true, set = false, admin = false } = {}) => ({
  member: who,
  role,
  inherit_option: inherit,
  set_option: set,
  admin_option: admin,
});
const dep = (rolname, deptype, catalog, howMany = 1) => ({ rolname, deptype, catalog, how_many: howMany });

/** The rows readCatalog gives for the right shape on staging: 0012's grants and policies name the two roles. */
function rightCatalog() {
  return {
    serverVersionNum: "170012",
    roles: [
      { rolname: "rosie_app", ...ROLE },
      { rolname: "rosie_job", ...ROLE },
      { rolname: "rosie_worker_app", ...LOGIN },
      { rolname: "rosie_worker_job", ...LOGIN },
    ],
    memberships: [member("rosie_worker_app", "rosie_app"), member("rosie_worker_job", "rosie_job")],
    dependencies: [
      dep("rosie_app", "a", "pg_class", 13),
      dep("rosie_app", "a", "pg_proc", 2),
      dep("rosie_app", "r", "pg_policy", 13),
      dep("rosie_job", "a", "pg_class", 24),
      dep("rosie_job", "a", "pg_proc", 2),
      dep("rosie_job", "r", "pg_policy", 13),
    ],
  };
}
const withRole = (catalog, name, changes) => ({
  ...catalog,
  roles: catalog.roles.map((row) => (row.rolname === name ? { ...row, ...changes } : row)),
});
const withMemberships = (catalog, memberships) => ({ ...catalog, memberships });
const withDependency = (catalog, row) => ({ ...catalog, dependencies: [...catalog.dependencies, row] });

const shown = (role, inherit, set, admin) => `${role} (inherit ${inherit}, set ${set}, admin ${admin})`;
const loginMemberships = (login, role, listed) =>
  `${login}'s memberships are ${listed} where its one is ${role} (inherit true, set false, admin false): it must inherit exactly one of the two roles, and be able to switch to none`;
const roleMemberships = (role, listed) =>
  `${role} is a member of ${listed}, where it must be a member of no role: every login that inherits ${role} would gain it`;
const loginNamed = (login, what) => `${login}: ${what} (it must own and be named by nothing)`;
const roleOwns = (role, what) =>
  `${role}: ${what} (it must own nothing: a login that inherits an owner bypasses row-level security there)`;

describe("judgeCatalog: the logins and their roles, against fixed catalog rows", () => {
  it("the right shape passes, each login and role described by names, attributes and counts alone", () => {
    const { lines, faults } = judgeCatalog(rightCatalog());
    assert.deepEqual(faults, []);
    assert.deepEqual(lines, [
      "the server: server_version_num 170012 (PostgreSQL 16 or later)",
      "rosie_worker_job: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; memberships of its own: rosie_job (inherit true, set false, admin false); pg_shdepend names it: nowhere",
      "rosie_job: NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; memberships of its own: none; owns: nothing",
      "rosie_worker_app: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; memberships of its own: rosie_app (inherit true, set false, admin false); pg_shdepend names it: nowhere",
      "rosie_app: NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; memberships of its own: none; owns: nothing",
    ]);
  });

  it("rows whose member is the maker are never read: PostgreSQL 16's maker's row (the login as roleid) and 0035's SET row pass", () => {
    const catalog = withMemberships(rightCatalog(), [
      member(MAKER, "rosie_job", { inherit: false, set: true }),
      member(MAKER, "rosie_worker_job", { inherit: false, admin: true }),
      ...rightCatalog().memberships,
    ]);
    assert.deepEqual(judgeCatalog(catalog).faults, []);
  });

  // [title, the rows, the faults, in the order judged: the job side's login then role, then the app side's].
  const CASES = [
    [
      "the login inherits both roles",
      withMemberships(rightCatalog(), [
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "rosie_app"),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [
        loginMemberships(
          "rosie_worker_job",
          "rosie_job",
          `${shown("rosie_app", true, false, false)}, ${shown("rosie_job", true, false, false)}`,
        ),
      ],
    ],
    [
      "the login inherits the other side's role instead of its own",
      withMemberships(rightCatalog(), [
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "rosie_app"),
      ]),
      [loginMemberships("rosie_worker_job", "rosie_job", shown("rosie_app", true, false, false))],
    ],
    [
      "the login holds a second membership (pg_read_all_data, which a host might add)",
      withMemberships(rightCatalog(), [
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "pg_read_all_data", { set: true }),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [
        loginMemberships(
          "rosie_worker_job",
          "rosie_job",
          `${shown("pg_read_all_data", true, true, false)}, ${shown("rosie_job", true, false, false)}`,
        ),
      ],
    ],
    [
      "the login's one membership has SET TRUE",
      withMemberships(rightCatalog(), [
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "rosie_job", { set: true }),
      ]),
      [loginMemberships("rosie_worker_job", "rosie_job", shown("rosie_job", true, true, false))],
    ],
    [
      "the login's one membership has ADMIN TRUE",
      withMemberships(rightCatalog(), [
        member("rosie_worker_app", "rosie_app", { admin: true }),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [loginMemberships("rosie_worker_app", "rosie_app", shown("rosie_app", true, false, true))],
    ],
    [
      "the login's one membership has INHERIT FALSE",
      withMemberships(rightCatalog(), [
        member("rosie_worker_app", "rosie_app", { inherit: false }),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [loginMemberships("rosie_worker_app", "rosie_app", shown("rosie_app", false, false, false))],
    ],
    [
      "the login was made but never granted",
      withMemberships(rightCatalog(), [member("rosie_worker_job", "rosie_job")]),
      [loginMemberships("rosie_worker_app", "rosie_app", "none")],
    ],
    [
      "the login owns a table",
      withDependency(rightCatalog(), dep("rosie_worker_job", "o", "pg_class")),
      [loginNamed("rosie_worker_job", "it owns 1 table(s) or other relation(s)")],
    ],
    [
      "the login owns a function",
      withDependency(rightCatalog(), dep("rosie_worker_app", "o", "pg_proc")),
      [loginNamed("rosie_worker_app", "it owns 1 function(s)")],
    ],
    [
      "the login owns a schema",
      withDependency(rightCatalog(), dep("rosie_worker_job", "o", "pg_namespace")),
      [loginNamed("rosie_worker_job", "it owns 1 schema(s)")],
    ],
    [
      "the login holds a grant of its own",
      withDependency(rightCatalog(), dep("rosie_worker_app", "a", "pg_class", 2)),
      [loginNamed("rosie_worker_app", "it holds 2 grant(s) of its own (on objects of pg_class)")],
    ],
    [
      "a policy names the login",
      withDependency(rightCatalog(), dep("rosie_worker_job", "r", "pg_policy")),
      [loginNamed("rosie_worker_job", "1 policy(ies) name it")],
    ],
    [
      "the login is a superuser",
      withRole(rightCatalog(), "rosie_worker_job", { rolsuper: true }),
      ["rosie_worker_job is SUPERUSER"],
    ],
    [
      "the login has BYPASSRLS",
      withRole(rightCatalog(), "rosie_worker_app", { rolbypassrls: true }),
      ["rosie_worker_app is BYPASSRLS"],
    ],
    [
      "the login has CREATEDB, CREATEROLE and REPLICATION",
      withRole(rightCatalog(), "rosie_worker_job", {
        rolcreatedb: true,
        rolcreaterole: true,
        rolreplication: true,
      }),
      ["rosie_worker_job is CREATEDB", "rosie_worker_job is CREATEROLE", "rosie_worker_job is REPLICATION"],
    ],
    [
      "the login cannot log in",
      withRole(rightCatalog(), "rosie_worker_app", { rolcanlogin: false }),
      ["rosie_worker_app is NOLOGIN"],
    ],
    [
      "a role is a member of the migrations' role (its login would inherit the tables' owner)",
      withMemberships(rightCatalog(), [
        member("rosie_job", MAKER),
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [roleMemberships("rosie_job", shown(MAKER, true, false, false))],
    ],
    [
      "rosie_app is a member of rosie_job",
      withMemberships(rightCatalog(), [
        member("rosie_app", "rosie_job"),
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [roleMemberships("rosie_app", shown("rosie_job", true, false, false))],
    ],
    [
      "a role holds pg_read_all_data (DL-511: every login that inherits it gains it)",
      withMemberships(rightCatalog(), [
        member("rosie_job", "pg_read_all_data", { set: true }),
        member("rosie_worker_app", "rosie_app"),
        member("rosie_worker_job", "rosie_job"),
      ]),
      [roleMemberships("rosie_job", shown("pg_read_all_data", true, true, false))],
    ],
    [
      "a role owns a table",
      withDependency(rightCatalog(), dep("rosie_job", "o", "pg_class")),
      [roleOwns("rosie_job", "it owns 1 table(s) or other relation(s)")],
    ],
    [
      "a role can log in and has BYPASSRLS",
      withRole(rightCatalog(), "rosie_app", { rolcanlogin: true, rolbypassrls: true }),
      ["rosie_app is LOGIN (0012 makes it NOLOGIN)", "rosie_app is BYPASSRLS (0012 makes it NOBYPASSRLS)"],
    ],
    [
      "a role is a superuser",
      withRole(rightCatalog(), "rosie_job", { rolsuper: true }),
      ["rosie_job is SUPERUSER (0012 makes it NOSUPERUSER)"],
    ],
    [
      "the login is missing",
      {
        ...withMemberships(rightCatalog(), [member("rosie_worker_job", "rosie_job")]),
        roles: rightCatalog().roles.filter((row) => row.rolname !== "rosie_worker_app"),
      },
      [
        "rosie_worker_app is not on the server (worker-logins.sql makes it; HYPERDRIVE_APP's configuration stores it)",
      ],
    ],
    [
      "a role is missing",
      { ...rightCatalog(), roles: rightCatalog().roles.filter((row) => row.rolname !== "rosie_app") },
      ["rosie_app is not on the server (0012_core_rls.sql makes it)"],
    ],
    [
      "the server is older than PostgreSQL 16",
      { ...rightCatalog(), serverVersionNum: "150008" },
      [
        "the server reports server_version_num 150008: PostgreSQL 16 or later is needed (a login's one grant is WITH INHERIT TRUE, SET FALSE, read back from pg_auth_members' inherit_option and set_option)",
      ],
    ],
  ];
  for (const [title, catalog, faults] of CASES) {
    it(`refused, with its reason: ${title}`, () => {
      assert.deepEqual(judgeCatalog(catalog).faults, faults);
    });
  }
});

describe("judgeBindings: env.staging's hyperdrive list", () => {
  const config = (list) => ({ env: { staging: { hyperdrive: list } } });
  const job = { binding: "HYPERDRIVE_JOB", id: STAGING.get("HYPERDRIVE_JOB") };
  const app = { binding: "HYPERDRIVE_APP", id: STAGING.get("HYPERDRIVE_APP") };

  it("wrangler.jsonc binds exactly the two, each with its id", () => {
    const { bindings, faults } = judgeBindings(
      readWranglerConfig(readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8")),
    );
    assert.deepEqual(faults, []);
    assert.deepEqual([...bindings.keys()].sort(), ["HYPERDRIVE_APP", "HYPERDRIVE_JOB"]);
    for (const id of bindings.values()) assert.match(id, /^[0-9a-f]{32}$/);
  });

  for (const [title, list, faults] of [
    ["a binding missing", [job], ["wrangler.jsonc's env.staging does not bind HYPERDRIVE_APP"]],
    [
      "a third binding (HYPERDRIVE)",
      [job, app, { binding: "HYPERDRIVE", id: OTHER_ID }],
      [
        "wrangler.jsonc's env.staging binds HYPERDRIVE, which is not one of HYPERDRIVE_JOB and HYPERDRIVE_APP: the check cannot say which login its configuration stores",
      ],
    ],
    [
      "a binding twice",
      [job, app, job],
      ["wrangler.jsonc's env.staging binds HYPERDRIVE_JOB more than once"],
    ],
    [
      "an id that is not 32 hex characters",
      [job, { binding: "HYPERDRIVE_APP", id: "not-an-id" }],
      ["wrangler.jsonc's env.staging HYPERDRIVE_APP has no id of 32 hex characters"],
    ],
    [
      "no list at all",
      undefined,
      [
        "wrangler.jsonc's env.staging has no hyperdrive list (it must bind HYPERDRIVE_JOB and HYPERDRIVE_APP)",
      ],
    ],
  ]) {
    it(`refused: ${title}`, () => {
      assert.deepEqual(judgeBindings(config(list)).faults, faults);
    });
  }
});

// The shape wrangler 4.158.0's `hyperdrive list` prints (hyperdrive-list.test.mjs): made-up hosts and databases.
const HEAD = [
  "id",
  "name",
  "user",
  "host",
  "port",
  "scheme",
  "database",
  "caching",
  "mtls",
  "origin_connection_limit",
];
const ORIGIN_HOST = "origin-host-t1093.example.invalid";
const ORIGIN_DATABASE = "made_up_database_t1093";
const OTHER_USER = "t1093_other_user_made_up";
function listing(rows) {
  const line = (cells) => `│ ${cells.join(" │ ")} │`;
  return [
    " ⛅️ wrangler 4.158.0",
    "📋 Listing Hyperdrive configs",
    "┌────┬────┐",
    line(HEAD),
    "├────┼────┤",
    ...rows.map((row) =>
      line([
        row.id,
        row.name,
        row.user,
        ORIGIN_HOST,
        "5432",
        "PostgreSQL",
        ORIGIN_DATABASE,
        row.caching,
        "{}",
        "",
      ]),
    ),
    "└────┴────┘",
    "",
  ].join("\n");
}
/** The two configurations as the user's run made them (DL-754), storing the given logins. */
const rightRows = (jobLogin = "rosie_worker_job", appLogin = "rosie_worker_app") => [
  {
    id: STAGING.get("HYPERDRIVE_JOB"),
    name: "rosie-staging-hyperdrive-job",
    user: jobLogin,
    caching: "disabled",
  },
  {
    id: STAGING.get("HYPERDRIVE_APP"),
    name: "rosie-staging-hyperdrive-app",
    user: appLogin,
    caching: "disabled",
  },
];

describe("judgeConfigurations: the configuration behind each binding", () => {
  const judge = (rows) => {
    const judged = judgeConfigurations(listing(rows), STAGING);
    for (const text of [...judged.lines, ...judged.faults]) {
      for (const hidden of [ORIGIN_HOST, ORIGIN_DATABASE, OTHER_USER]) {
        assert.ok(!text.includes(hidden), `a line holds ${hidden}: ${text}`);
      }
    }
    return judged;
  };

  it("each stores its login with caching disabled, under the id its binding names", () => {
    const { lines, faults } = judge(rightRows());
    assert.deepEqual(faults, []);
    assert.deepEqual(lines, [
      `HYPERDRIVE_JOB: rosie-staging-hyperdrive-job, id ${STAGING.get("HYPERDRIVE_JOB")}, caching disabled, stores rosie_worker_job: yes`,
      `HYPERDRIVE_APP: rosie-staging-hyperdrive-app, id ${STAGING.get("HYPERDRIVE_APP")}, caching disabled, stores rosie_worker_app: yes`,
    ]);
  });

  for (const [title, rows, faults] of [
    [
      "a configuration stores another user, never shown (the migrations' role, say)",
      rightRows("rosie_worker_job", OTHER_USER),
      ["rosie-staging-hyperdrive-app stores another user (not shown), not its login rosie_worker_app"],
    ],
    [
      "the two logins crossed",
      rightRows("rosie_worker_app", "rosie_worker_job"),
      [
        "rosie-staging-hyperdrive-job stores another user (not shown), not its login rosie_worker_job",
        "rosie-staging-hyperdrive-app stores another user (not shown), not its login rosie_worker_app",
      ],
    ],
    [
      "caching is on",
      rightRows().map((row, at) =>
        at === 0 ? { ...row, caching: "max_age: 60, stale_while_revalidate: 15" } : row,
      ),
      [
        "rosie-staging-hyperdrive-job's caching is max_age: 60, stale_while_revalidate: 15, not disabled (ADR-007: both sides make decision reads)",
      ],
    ],
    [
      "the binding names another configuration's id",
      rightRows().map((row, at) => (at === 1 ? { ...row, id: OTHER_ID } : row)),
      [
        `HYPERDRIVE_APP binds the id ${STAGING.get("HYPERDRIVE_APP")}, which is not rosie-staging-hyperdrive-app's (${OTHER_ID})`,
      ],
    ],
    [
      "a configuration is missing",
      rightRows().slice(0, 1),
      [
        "no Hyperdrive configuration is named rosie-staging-hyperdrive-app (the one HYPERDRIVE_APP must bind)",
      ],
    ],
    [
      "two configurations have the name",
      [...rightRows(), { ...rightRows()[0], id: OTHER_ID }],
      ["more than one Hyperdrive configuration is named rosie-staging-hyperdrive-job"],
    ],
  ]) {
    it(`refused: ${title}`, () => {
      assert.deepEqual(judge(rows).faults, faults);
    });
  }

  it("a list it cannot read is refused without showing its text", () => {
    const text = `${ORIGIN_HOST} rosie-staging-hyperdrive-job rosie-staging-hyperdrive-app ${OTHER_USER}\n`;
    const { faults } = judgeConfigurations(text, STAGING);
    assert.equal(faults.length, 2);
    for (const fault of faults) {
      assert.match(
        fault,
        /^the Hyperdrive list could not be read \(the list names the configuration, but not in a table;/,
      );
      assert.ok(!fault.includes(ORIGIN_HOST) && !fault.includes(OTHER_USER), fault);
    }
  });
});

describe("tlsFor and readWranglerConfig", () => {
  it("TLS with the certificate and name checked whenever the URL asks for TLS; as the URL says when it asks for none", () => {
    const base = "postgres://u:p@db.example.invalid:5432/d";
    for (const query of [
      "?sslmode=require",
      "?sslmode=prefer",
      "?sslmode=verify-full",
      "?ssl=true",
      "?sslrootcert=system",
    ]) {
      assert.deepEqual(tlsFor(`${base}${query}`), { rejectUnauthorized: true }, query);
    }
    for (const query of ["", "?sslmode=disable"]) assert.equal(tlsFor(`${base}${query}`), false, query);
  });

  it("reads wrangler.jsonc as cf.sh does, and an unreadable text is refused without quoting it", () => {
    assert.deepEqual(readWranglerConfig('{ // a comment\n "a": [1, 2,], /* b */ "c": "//x", }'), {
      a: [1, 2],
      c: "//x",
    });
    assert.throws(() => readWranglerConfig('{ "secret-ish": 1 /* open'), {
      message: "a /* comment is not closed",
    });
    assert.throws(() => readWranglerConfig('{ "secret-ish": }'), { message: "it does not parse" });
  });
});

// --- The catalog read, on the server -------------------------------------------------------------------------------

describe("readCatalog on the server, as a maker that is not a superuser (roles of this run's own)", () => {
  const prefix = `${RUN}b`;
  const names = namesOf(prefix);
  const pairs = pairsOf(names);
  const schema = `${prefix}_objects`;
  const makerName = `${prefix}_maker`;
  let admin;
  let maker;

  before(async () => {
    admin = postgres(serverUrl(), { max: 2, onnotice: () => undefined, connect_timeout: 15 });
    const [server] = await admin`
      select current_setting('server_version_num')::int as version, rolsuper from pg_roles where rolname = current_user`;
    assert.ok(
      server.rolsuper,
      "the tests' login must be a superuser, as the local and CI containers' first user is",
    );
    assert.ok(
      server.version >= 160000,
      `the test server is older than PostgreSQL 16 (${String(server.version)})`,
    );
    await admin.unsafe(`create schema ${quote(schema)}`);
    for (const role of [names.job, names.app]) {
      await admin.unsafe(
        `create role ${quote(role)} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
      );
    }
    // As staging's migrations' role: CREATEROLE, no superuser, with ADMIN on the two roles it grants.
    const password = randomBytes(16).toString("hex");
    await admin.unsafe(`create role ${quote(makerName)} login createrole password '${password}'`);
    await admin.unsafe(
      `grant ${quote(names.job)}, ${quote(names.app)} to ${quote(makerName)} with admin option`,
    );
    const url = new URL(serverUrl());
    url.username = makerName;
    url.password = password;
    maker = postgres(url.href, { max: 1, onnotice: () => undefined, connect_timeout: 15 });
    await maker.unsafe(
      swapped(readFileSync(path.join(REPO, "infra/scripts/worker-logins.sql"), "utf8"), names),
    );
  });

  after(async () => {
    if (admin === undefined) return;
    try {
      await maker?.end({ timeout: 5 });
      await admin.unsafe(`drop schema if exists ${quote(schema)} cascade`);
      await dropRoles(admin, prefix);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  const judged = async () => judgeCatalog(await readCatalog(maker, pairs), pairs).faults;

  it("worker-logins.sql's logins pass, read by member: the maker's own rows (the logins as roleid) are never read", async () => {
    const catalog = await readCatalog(maker, pairs);
    assert.deepEqual(judgeCatalog(catalog, pairs).faults, []);
    assert.deepEqual(catalog.memberships, [
      member(names.worker_app, names.app),
      member(names.worker_job, names.job),
    ]);
    // The rows the read leaves out are there: PostgreSQL 16 granted each new login back to its maker.
    const [{ rows }] = await admin`
      select count(*)::int as rows from pg_auth_members m
      join pg_roles granted on granted.oid = m.roleid join pg_roles holder on holder.oid = m.member
      where holder.rolname = ${makerName} and granted.rolname = any(${[names.worker_job, names.worker_app]})`;
    assert.equal(rows, 2);
  });

  it("a role that holds pg_read_all_data is refused (DL-511), and passes again once it is revoked", async () => {
    await admin.unsafe(`grant pg_read_all_data to ${quote(names.job)}`);
    try {
      assert.deepEqual(await judged(), [
        roleMemberships(names.job, shown("pg_read_all_data", true, true, false)),
      ]);
    } finally {
      await admin.unsafe(`revoke pg_read_all_data from ${quote(names.job)}`);
    }
    assert.deepEqual(await judged(), []);
  });

  it("a login that holds a second role, or both, is refused", async () => {
    await admin.unsafe(
      `grant ${quote(names.app)} to ${quote(names.worker_job)} with inherit true, set false`,
    );
    try {
      assert.deepEqual(await judged(), [
        loginMemberships(
          names.worker_job,
          names.job,
          `${shown(names.app, true, false, false)}, ${shown(names.job, true, false, false)}`,
        ),
      ]);
    } finally {
      await admin.unsafe(`revoke ${quote(names.app)} from ${quote(names.worker_job)}`);
    }
    assert.deepEqual(await judged(), []);
  });

  it("a table a login owns, a function a role owns and a grant of a login's own are each refused", async () => {
    const table = `${quote(schema)}.${quote("owned_by_login")}`;
    const fn = `${quote(schema)}.${quote("owned_by_role")}()`;
    const seen = `${quote(schema)}.${quote("seen_by_login")}`;
    await admin.unsafe(`create table ${table} (id int)`);
    await admin.unsafe(`alter table ${table} owner to ${quote(names.worker_app)}`);
    await admin.unsafe(`create function ${fn} returns int language sql as 'select 1'`);
    await admin.unsafe(`alter function ${fn} owner to ${quote(names.job)}`);
    await admin.unsafe(`create table ${seen} (id int)`);
    await admin.unsafe(`grant select on ${seen} to ${quote(names.worker_job)}`);
    try {
      assert.deepEqual(await judged(), [
        loginNamed(names.worker_job, "it holds 1 grant(s) of its own (on objects of pg_class)"),
        roleOwns(names.job, "it owns 1 function(s)"),
        loginNamed(names.worker_app, "it owns 1 table(s) or other relation(s)"),
      ]);
    } finally {
      await admin.unsafe(`drop table ${table}, ${seen}`);
      await admin.unsafe(`drop function ${fn}`);
    }
    assert.deepEqual(await judged(), []);
  });
});

// --- The program, and its place in the deploy ---------------------------------------------------------------------

describe("worker-logins-check.mjs as a program", () => {
  const runCheck = (t, args, extra) => {
    const home = tempDir(t, "logins-check-home");
    const result = spawnSync(process.execPath, [CHECK, ...args], {
      cwd: REPO,
      env: cleanEnv(home, extra),
      encoding: "utf8",
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };

  it("an argument is misuse (exit 2), before anything is read", (t) => {
    const result = runCheck(t, ["--env", "production"], {});
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /it takes no arguments \(they are never echoed\)/);
    assert.ok(!result.output.includes("production"), result.output);
  });

  it("a URL that does not parse is refused (exit 1) with no part of it printed, before anything is listed or read", (t) => {
    for (const name of ["hash", "hashAfterDigits"]) {
      const bad = BAD_DATABASE_URLS[name];
      const result = runCheck(t, [], { STAGING_DATABASE_URL: bad.env });
      assert.equal(result.status, 1, result.output);
      assert.match(
        result.stderr,
        /^worker-logins-check: refused: STAGING_DATABASE_URL does not parse: .+; nothing was read$/m,
      );
      assertNoUrlPart(result, bad, bad.name);
    }
  });
});

// The deploy's variables (deploy-staging.test.mjs's): the commit, the fake wrangler's live version, the fake check's
// answer, the base URL.
const SHA = "1093000000000000000000000000000000001093";
const LIVE = "00000000-0000-4000-8000-000000001093";
const DEPLOY_ENV = {
  GIT_SHA: SHA,
  FAKE_VERSION: SHA,
  FAKE_LIVE_VERSION: LIVE,
  STAGING_BASE_URL: "https://rosie-staging.example.invalid/test",
  CHECK_ATTEMPTS: "1",
};

describe("deploy-staging.sh runs the real check after step 1 and before step 2 (names of this run's own)", () => {
  const cleanups = [];
  const t = { after: (fn) => cleanups.push(fn) };
  const prefix = `${RUN}d`;
  const names = namesOf(prefix);
  let admin;
  let db;
  let rig;
  let listFile;

  before(async () => {
    admin = postgres(serverUrl(), { max: 2, onnotice: () => undefined, connect_timeout: 15 });
    for (const role of [names.job, names.app]) {
      await admin.unsafe(
        `create role ${quote(role)} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
      );
    }
    for (const [login, role] of [
      [names.worker_job, names.job],
      [names.worker_app, names.app],
    ]) {
      await admin.unsafe(
        `create role ${quote(login)} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
      );
      await admin.unsafe(`grant ${quote(role)} to ${quote(login)} with inherit true, set false`);
    }
    db = await createThrowawayDatabase("logins");
    rig = releaseRoot(t, { loginsCheck: swapped(readFileSync(CHECK, "utf8"), names) });
    listFile = path.join(rig.dir, "hyperdrive-list.txt");
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    await db?.drop();
    if (admin === undefined) return;
    try {
      await dropRoles(admin, prefix);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  /** Runs the deploy with the list `rows` and the variables `extra`; calls: this run's own. */
  const deploy = (rows, extra) => {
    writeFileSync(listFile, listing(rows));
    const from = rig.calls().length;
    const result = rig.run("deploy-staging.sh", [], {
      ...DEPLOY_ENV,
      FAKE_HYPERDRIVE_LIST: listFile,
      ...extra,
    });
    return { ...result, calls: rig.calls().slice(from) };
  };
  /** The deploy's lines that name a step, the logins' check, the post-deploy check or the end, without their times. */
  const stepLines = (stdout) =>
    stdout
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]+\] /, ""))
      .filter((line) =>
        /^(step \d\/4|logins:|check:|deploy-staging:|worker-logins-check:|rollback:)/.test(line),
      );
  const deploys = (calls) => calls.filter((call) => call.tool === "wrangler" && call.args.includes("deploy"));
  const hidden = () => [db.url, new URL(db.url).pathname.slice(1), ORIGIN_HOST, ORIGIN_DATABASE, OTHER_USER];
  const assertHidden = (result, what) => {
    for (const text of hidden())
      assert.ok(!result.output.includes(text), `${what}: the output holds ${text}`);
  };

  it("in their shape: the check passes after the migrations and before the code, and the deploy goes on; cf.sh got no database URL", () => {
    const result = deploy(rightRows(names.worker_job, names.worker_app), { STAGING_DATABASE_URL: db.url });
    assert.equal(result.status, 0, result.output);
    const lines = stepLines(result.stdout);
    const order = [
      "step 1/4 migrate: done",
      "logins: the check of the Worker's two logins and their Hyperdrive configurations: start",
      `worker-logins-check: ${names.worker_job}: LOGIN NOSUPERUSER`,
      "worker-logins-check: passed:",
      "logins: done, both logins and both configurations are in their shape",
      "step 2/4 code: wrangler deploy --env staging",
      "deploy-staging: done",
    ].map((start) => lines.findIndex((line) => line.startsWith(start)));
    assert.ok(
      order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])),
      lines.join("\n"),
    );
    assert.equal(deploys(result.calls).length, 1);
    assert.deepEqual(
      result.calls
        .filter((call) => call.tool === "hyperdrive-list")
        .map((call) => ({ databaseNames: call.databaseNames, urlHolders: call.urlHolders })),
      [{ databaseNames: [], urlHolders: [] }],
      "cf.sh hyperdrive list was given a database URL",
    );
    assertHidden(result, "in their shape");
  });

  it("a role holding pg_read_all_data (DL-511): refused after step 1, before step 2; nothing deployed, nothing rolled back", async () => {
    await admin.unsafe(`grant pg_read_all_data to ${quote(names.job)}`);
    try {
      const result = deploy(rightRows(names.worker_job, names.worker_app), { STAGING_DATABASE_URL: db.url });
      assert.equal(result.status, 1, result.output);
      assert.ok(
        result.stderr.includes(
          `worker-logins-check: refused: ${roleMemberships(names.job, shown("pg_read_all_data", true, true, false))}\n`,
        ),
        result.stderr,
      );
      assert.match(
        result.stderr,
        /deploy-staging\.sh: logins: refused \(the lines above say why\): nothing was deployed, and staging runs the version it ran/,
      );
      const lines = stepLines(result.stdout);
      assert.ok(lines.includes("step 1/4 migrate: done"), lines.join("\n"));
      assert.ok(
        !lines.some((line) => /^(step [234]\/4|rollback:|check:|deploy-staging: (done|FAILED))/.test(line)),
        lines.join("\n"),
      );
      assert.deepEqual(deploys(result.calls), []);
      assertHidden(result, "a role holding pg_read_all_data");
    } finally {
      await admin.unsafe(`revoke pg_read_all_data from ${quote(names.job)}`);
    }
  });

  it("a configuration that stores another user, and one with caching on: refused before step 2, the user never printed", () => {
    const rows = rightRows(names.worker_job, OTHER_USER).map((row, at) =>
      at === 0 ? { ...row, caching: "max_age: 60, stale_while_revalidate: 15" } : row,
    );
    const result = deploy(rows, { STAGING_DATABASE_URL: db.url });
    assert.equal(result.status, 1, result.output);
    for (const fault of [
      "rosie-staging-hyperdrive-job's caching is max_age: 60, stale_while_revalidate: 15, not disabled (ADR-007: both sides make decision reads)",
      `rosie-staging-hyperdrive-app stores another user (not shown), not its login ${names.worker_app}`,
    ]) {
      assert.ok(result.stderr.includes(`worker-logins-check: refused: ${fault}\n`), result.stderr);
    }
    assert.ok(!stepLines(result.stdout).some((line) => line.startsWith("step 2/4")), result.stdout);
    assert.deepEqual(deploys(result.calls), []);
    assertHidden(result, "another user");
  });

  it("without STAGING_DATABASE_URL: step 1 is skipped, and the check refuses before anything is listed or deployed", () => {
    const result = deploy(rightRows(names.worker_job, names.worker_app), {});
    assert.equal(result.status, 1, result.output);
    assert.ok(
      stepLines(result.stdout).includes(
        "step 1/4 migrate: skipped (NOTICE: STAGING_DATABASE_URL is not set)",
      ),
      result.stdout,
    );
    assert.match(
      result.stderr,
      /worker-logins-check: refused: STAGING_DATABASE_URL is not set \(from the environment, else from \.dev\.vars by name\)/,
    );
    assert.deepEqual(
      result.calls.filter((call) => call.tool === "hyperdrive-list" || deploys([call]).length > 0),
      [],
    );
  });
});
