// T-1255: checks of the probe, its verdict, the run script's pieces and the Worker, behind stand-ins. Run:
//   node --test infra/spikes/hyperdrive-roles/probe.test.mjs
// Nothing here reaches Cloudflare or a database: the probe runs against standin-postgres.mjs. Every value is made up
// (no real id, host, user, password or time). Not part of npm test.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INSIDE_READS,
  OUTSIDE_READS,
  PROBE,
  ROUND_SIZE,
  SIDES,
  failedChecks,
  formatStart,
  guardQuery,
  makeRedactor,
  parseStart,
  printable,
  runProbe,
  shownNameOf,
  verdict,
} from "./probe.mjs";
import {
  ACCOUNT_ID,
  checkList,
  childEnvironment,
  liveVersion,
  makeScrub,
  outsideTexts,
  probeConfig,
} from "./run.mjs";
import { standinOpen } from "./standin-postgres.mjs";
import worker, { refusedBy } from "./worker.mjs";

const [JOB, APP] = SIDES;
const RUN_START = "2026-01-02 03:04:05.123456+00";
const RUN_START_US = parseStart(RUN_START);
const ONE_MICROSECOND_LATER = "2026-01-02 03:04:05.123457+00";
const ONE_MICROSECOND_EARLIER = "2026-01-02 03:04:05.123455+00";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_USER = "made_up_owner_t1255";
const PASSWORD = "made-up-password-t1255";
const HD_HOST = "made-up-hd-host-t1255.example.test";
const STRINGS = {
  HYPERDRIVE_JOB: `postgres://rosie_worker_job:${PASSWORD}@${HD_HOST}:5432/made_up_db?sslmode=disable`,
  HYPERDRIVE_APP: `postgres://rosie_worker_app:${PASSWORD}-app@${HD_HOST}:5432/made_up_db?sslmode=disable`,
};

/** A correct answer for a side, as answerOf gives it; `change` replaces fields. */
const answerFor = (side, change = {}) => ({
  session_user: side.login,
  current_user: side.login,
  memberships: [{ role: side.role, inherit: true, set: false, admin: false }],
  own_usage: true,
  other_member: false,
  row_security: true,
  current_schema: "public",
  ...change,
});

/** The listing wrangler 4.158.0 prints for these configurations (made-up rows). */
function listing(configs) {
  const line = (cells) => `│ ${cells.join(" │ ")} │`;
  const head = ["id", "name", "user", "host", "port", "scheme", "database", "caching", "mtls"];
  return [
    " ⛅️ wrangler 4.158.0",
    "┌────┬────┐",
    line(head),
    "├────┼────┤",
    ...configs.map((c) =>
      line([c.id, c.name, c.user, c.host, "5432", "PostgreSQL", "made_up_db", c.caching, "{}"]),
    ),
    "└────┴────┘",
  ].join("\n");
}
const ID_JOB = "0123456789abcdef0123456789abcdef";
const ID_APP = "fedcba9876543210fedcba9876543210";
const GOOD_CONFIGS = [
  { id: ID_JOB, name: JOB.name, user: JOB.login, host: "origin.example.test", caching: "disabled" },
  { id: ID_APP, name: APP.name, user: APP.login, host: "origin.example.test", caching: "disabled" },
];

test("the run's postmaster start is read to the microsecond, as PostgreSQL prints it or in ISO 8601", () => {
  const expected = BigInt(Date.UTC(2026, 0, 2, 3, 4, 5)) * 1000n + 123456n;
  assert.equal(parseStart(RUN_START), expected);
  assert.equal(parseStart("2026-01-02T03:04:05.123456Z"), expected);
  assert.equal(parseStart("2026-01-02 05:04:05.123456+02"), expected);
  assert.equal(parseStart("2026-01-01 22:34:05.123456-04:30"), expected);
  assert.equal(parseStart("2026-01-02 03:04:05+00"), expected - 123456n);
  assert.equal(parseStart("2026-01-02 03:04:05.1+00"), expected - 23456n);
  assert.equal(formatStart(expected), RUN_START);
  assert.equal(formatStart(parseStart("2026-01-02 03:04:05+00")), "2026-01-02 03:04:05.000000+00");
  assert.equal(parseStart(ONE_MICROSECOND_LATER) - parseStart(RUN_START), 1n);
});

test("a start without its time zone, a date that does not exist, or other text is refused", () => {
  for (const text of [
    "2026-01-02 03:04:05.123456",
    "2026-02-30 03:04:05+00",
    "2026-01-02 24:00:00+00",
    "2026-01-02 03:04:05+16",
    "1999-12-31 23:59:59+00",
    "2026-01-02 03:04:05.1234567+00",
    "postmaster started 2026-01-02 03:04:05+00",
    "",
  ]) {
    assert.throws(() => parseStart(text), Error, text);
  }
});

test("the guard's reads of ADR-014 section 2's table are one select, with the backend's pid and its postmaster's start", () => {
  for (const side of SIDES) {
    const query = guardQuery(side);
    assert.equal(query.includes(";"), false);
    assert.equal((query.match(/^select /gm) ?? []).length, 1);
    for (const part of [
      "session_user::pg_catalog.text",
      "current_user::pg_catalog.text",
      "from pg_catalog.pg_auth_members m",
      "where m.member = (select u.oid from pg_catalog.pg_roles u where u.rolname = current_user)",
      "m.inherit_option",
      "m.set_option",
      "m.admin_option",
      `pg_catalog.pg_has_role(current_user, '${side.role}', 'USAGE')`,
      `pg_catalog.pg_has_role(current_user, '${side.other}', 'MEMBER')`,
      "pg_catalog.row_security_active('businesses')",
      "pg_catalog.current_schema()",
      "pg_catalog.pg_backend_pid()",
      "pg_catalog.pg_postmaster_start_time() at time zone 'UTC'",
      "extract(epoch from pg_catalog.pg_postmaster_start_time())",
    ]) {
      assert.ok(query.includes(part), `${side.binding}'s query has no ${part}`);
    }
    // Memberships are read by member, never by role.
    assert.equal(/m\.roleid\s*=\s*\(/.test(query), false);
  }
  for (const role of ["rosie_job'); drop table x; --", "Rosie_Job", "1rosie", "rosie job", ""]) {
    assert.throws(() => guardQuery({ ...JOB, role }), /plain lower-case name/, role);
  }
});

test("each side's expected answers pass, and each wrong answer of the table is refused by its label", () => {
  assert.deepEqual(failedChecks(answerFor(JOB), JOB), []);
  assert.deepEqual(failedChecks(answerFor(APP), APP), []);
  const cases = [
    [{ session_user: OTHER_USER, current_user: OTHER_USER }, ["session_user", "current_user"]],
    [{ current_user: "rosie_job" }, ["current_user"]],
    [
      {
        memberships: [
          { role: "pg_read_all_data", inherit: true, set: false, admin: false },
          { role: "rosie_job", inherit: true, set: false, admin: false },
        ],
      },
      ["memberships"],
    ],
    [{ memberships: [] }, ["memberships"]],
    [{ memberships: [{ role: "rosie_job", inherit: false, set: false, admin: false }] }, ["memberships"]],
    [{ memberships: [{ role: "rosie_job", inherit: true, set: true, admin: false }] }, ["memberships"]],
    [{ memberships: [{ role: "rosie_job", inherit: true, set: false, admin: true }] }, ["memberships"]],
    [{ memberships: [{ role: "rosie_app", inherit: true, set: false, admin: false }] }, ["memberships"]],
    [{ memberships: null }, ["memberships"]],
    [{ own_usage: false }, ["pg_has_role(current_user, 'rosie_job', 'USAGE')"]],
    [{ other_member: true }, ["pg_has_role(current_user, 'rosie_app', 'MEMBER')"]],
    [{ row_security: false }, ["row_security_active('businesses')"]],
    [{ row_security: null }, ["row_security_active('businesses')"]],
    [{ current_schema: "rosie_worker_job" }, ["current_schema()"]],
  ];
  for (const [change, labels] of cases) {
    assert.deepEqual(failedChecks(answerFor(JOB, change), JOB), labels, JSON.stringify(change));
  }
  // Crossed: the job login's answers where the Tool API side's are expected.
  assert.deepEqual(failedChecks(answerFor(JOB, { own_usage: false, other_member: true }), APP), [
    "session_user",
    "current_user",
    "memberships",
    "pg_has_role(current_user, 'rosie_app', 'USAGE')",
    "pg_has_role(current_user, 'rosie_job', 'MEMBER')",
  ]);
});

test("the probe reads 50 times outside a transaction and 5 inside one through each binding, then crosses them", async () => {
  assert.equal(OUTSIDE_READS, 50);
  assert.equal(INSIDE_READS, 5);
  assert.equal(ROUND_SIZE, 5);
  const { open, clients } = standinOpen({ start: ONE_MICROSECOND_LATER });
  const result = await runProbe({ open });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.failed_steps, []);
  assert.equal(result.probe, PROBE);
  // Per binding: a client of at most 5 connections with 50 reads, at most 5 at once; a client of one with one
  // read-only transaction of 5 reads; then each binding once more for its crossed read.
  assert.deepEqual(
    clients.map((client) => [client.binding, client.options.max, client.reads, client.transactions]),
    [
      ["HYPERDRIVE_JOB", 5, 50, []],
      ["HYPERDRIVE_JOB", 1, 5, [{ mode: "read only", reads: 5 }]],
      ["HYPERDRIVE_APP", 5, 50, []],
      ["HYPERDRIVE_APP", 1, 5, [{ mode: "read only", reads: 5 }]],
      ["HYPERDRIVE_JOB", 1, 1, []],
      ["HYPERDRIVE_APP", 1, 1, []],
    ],
  );
  assert.equal(clients[0].mostAtOnce, 5);
  assert.ok(clients.every((client) => client.ended));
  for (const [index, side] of SIDES.entries()) {
    const got = result.sides[index];
    assert.equal(got.binding, side.binding);
    assert.equal(got.outside_transaction.answered, 50);
    assert.deepEqual(got.outside_transaction.backends.length, 5);
    assert.equal(got.inside_transaction.answered, 5);
    assert.equal(got.inside_transaction.backends.length, 1);
    assert.equal(got.answers.length, 1);
    assert.equal(got.answers[0].reads, 55);
    assert.deepEqual(got.answers[0].failed_checks, []);
    assert.equal(got.answers[0].session_user, side.login);
    assert.deepEqual(got.postmaster_starts, [
      { start: ONE_MICROSECOND_LATER, start_us: String(parseStart(ONE_MICROSECOND_LATER)), reads: 55 },
    ]);
  }
  assert.deepEqual(
    result.crossed.map((entry) => [entry.binding, entry.read_as, entry.refused, entry.failed_checks]),
    [
      [
        "HYPERDRIVE_JOB",
        "app",
        true,
        [
          "session_user",
          "current_user",
          "memberships",
          "pg_has_role(current_user, 'rosie_app', 'USAGE')",
          "pg_has_role(current_user, 'rosie_job', 'MEMBER')",
        ],
      ],
      [
        "HYPERDRIVE_APP",
        "job",
        true,
        [
          "session_user",
          "current_user",
          "memberships",
          "pg_has_role(current_user, 'rosie_job', 'USAGE')",
          "pg_has_role(current_user, 'rosie_app', 'MEMBER')",
        ],
      ],
    ],
  );
  const judged = verdict(printable(result), { runStartUs: RUN_START_US });
  assert.deepEqual(judged.problems, []);
  assert.equal(judged.persistence, "proved");
});

test("a backend that answers as another login fails its binding, and that login is never in the result", async () => {
  const { open } = standinOpen({
    start: ONE_MICROSECOND_LATER,
    change: ({ binding, read, row }) =>
      binding === "HYPERDRIVE_JOB" && read === 17
        ? { ...row, session_user_name: OTHER_USER, current_user_name: OTHER_USER, memberships: null }
        : row,
  });
  const result = await runProbe({ open });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed_steps, ["HYPERDRIVE_JOB's reads"]);
  const [job] = result.sides;
  const wrong = job.answers.filter((group) => group.failed_checks.length > 0);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].reads, 1);
  assert.equal(wrong[0].session_user, "(not shown)");
  assert.deepEqual(wrong[0].failed_checks, ["session_user", "current_user", "memberships"]);
  assert.equal(JSON.stringify(result).includes(OTHER_USER), false);
  const judged = verdict(printable(result), { runStartUs: RUN_START_US });
  assert.equal(judged.problems.length, 1);
  assert.match(
    judged.problems[0],
    /^HYPERDRIVE_JOB: 1 read\(s\) on 1 backend\(s\) \(pid \d+\) answered as another login: \(not shown\), failing the table's checks: session_user, current_user, memberships$/,
  );
});

test("when both bindings answer as one login, the crossed read is not refused and the run fails", async () => {
  const { open } = standinOpen({
    start: ONE_MICROSECOND_LATER,
    logins: { HYPERDRIVE_JOB: "rosie_worker_job", HYPERDRIVE_APP: "rosie_worker_job" },
  });
  const result = await runProbe({ open });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed_steps, ["HYPERDRIVE_APP's reads", "HYPERDRIVE_APP crossed (read as job)"]);
  const judged = verdict(printable(result), { runStartUs: RUN_START_US });
  assert.ok(
    judged.problems.includes(
      "HYPERDRIVE_APP crossed: read where the runtime side's answers are expected, it was NOT refused: it answered as rosie_worker_job",
    ),
    judged.problems.join("\n"),
  );
});

test("an error keeps its code, and its message loses the connection strings' password, host and other users", async () => {
  const { open } = standinOpen({
    start: ONE_MICROSECOND_LATER,
    change: ({ binding, row }) => {
      if (binding !== "HYPERDRIVE_APP") return row;
      throw Object.assign(
        new Error(
          `connect to ${STRINGS.HYPERDRIVE_APP} failed: password ${PASSWORD}-app for rosie_worker_app at ${HD_HOST}`,
        ),
        { code: "28P01" },
      );
    },
  });
  const redact = makeRedactor(
    Object.values(STRINGS),
    SIDES.map((side) => side.login),
  );
  const result = await runProbe({ open, redact });
  const text = JSON.stringify(result);
  for (const secret of [STRINGS.HYPERDRIVE_APP, PASSWORD, HD_HOST]) {
    assert.equal(text.includes(secret), false, `the result holds ${secret}`);
  }
  const [, app] = result.sides;
  assert.equal(app.ok, false);
  assert.equal(app.outside_transaction.answered, 0);
  assert.deepEqual(
    app.errors.map((error) => [error.phase, error.code, error.count]),
    [
      ["outside_transaction", "28P01", 50],
      ["inside_transaction", "28P01", 1],
    ],
  );
  assert.equal(
    app.errors[0].message,
    "connect to [redacted] failed: password [redacted] for rosie_worker_app at [redacted]",
  );
  const judged = verdict(printable(result), { runStartUs: RUN_START_US });
  assert.equal(judged.persistence, "unknown");
  assert.ok(
    judged.problems.some((problem) =>
      problem.startsWith(
        "HYPERDRIVE_APP: 50 read(s) outside a transaction failed: 28P01: connect to [redacted]",
      ),
    ),
    judged.problems.join("\n"),
  );
});

test("the printed result shows no name but the logins, their roles and PostgreSQL's own, and scrubs other text", () => {
  const shown = shownNameOf();
  for (const name of [
    "rosie_worker_job",
    "rosie_worker_app",
    "rosie_job",
    "rosie_app",
    "pg_read_all_data",
    "neon_superuser",
  ]) {
    assert.equal(shown(name), name);
  }
  for (const name of [OTHER_USER, "neondb_owner", "Rosie_Job", ""]) assert.equal(shown(name), "(not shown)");
  const printed = printable(
    {
      probe: PROBE,
      sides: [
        {
          binding: "HYPERDRIVE_JOB",
          name: "made-up-config",
          answers: [
            {
              session_user: OTHER_USER,
              current_user: "rosie_worker_job",
              memberships: [{ role: "neondb_owner", inherit: true }, { role: "pg_write_all_data" }],
              current_schema: OTHER_USER,
            },
          ],
          errors: [
            { phase: "outside_transaction", code: "08006", message: `lost ${HD_HOST} and ${OTHER_USER}` },
          ],
          Unexpected_Key: "dropped",
          deeper: [[[[[[[[[["too deep"]]]]]]]]]],
        },
      ],
    },
    { scrub: makeScrub([HD_HOST, OTHER_USER]) },
  );
  const [side] = printed.sides;
  assert.equal(side.name, "(unknown)");
  assert.equal(side.answers[0].session_user, "(not shown)");
  assert.equal(side.answers[0].current_user, "rosie_worker_job");
  assert.deepEqual(side.answers[0].memberships, [
    { role: "(not shown)", inherit: true },
    { role: "pg_write_all_data" },
  ]);
  assert.equal(side.answers[0].current_schema, "(not shown)");
  assert.equal(side.errors[0].message, "lost [redacted] and [redacted]");
  assert.equal("Unexpected_Key" in side, false);
  assert.equal(JSON.stringify(printed).includes("too deep"), false);
  assert.equal(JSON.stringify(printed).includes(OTHER_USER), false);
});

test("the persistence proof holds only when every read came from a postmaster started after the run's", async () => {
  const judge = async (start, runStart = RUN_START) => {
    const { open } = standinOpen({ start });
    return verdict(printable(await runProbe({ open })), { runStartUs: parseStart(runStart) });
  };
  const later = await judge(ONE_MICROSECOND_LATER);
  assert.equal(later.persistence, "proved");
  assert.deepEqual(later.problems, []);
  assert.ok(
    later.lines.includes(
      `postmaster: HYPERDRIVE_JOB: started ${ONE_MICROSECOND_LATER} (56 reads); HYPERDRIVE_APP: started ${ONE_MICROSECOND_LATER} (56 reads)`,
    ),
    later.lines.join("\n"),
  );

  const same = await judge(RUN_START);
  assert.equal(same.persistence, "not yet proved");
  assert.deepEqual(same.problems, []);
  assert.ok(
    same.lines.some(
      (line) => line.startsWith("persistence: NOT YET PROVED:") && line.includes("This is not a pass"),
    ),
  );
  assert.equal(
    same.lines.some((line) => line.startsWith("persistence: proved")),
    false,
  );

  const earlier = await judge(ONE_MICROSECOND_EARLIER);
  assert.equal(earlier.persistence, "contradicted");
  assert.equal(earlier.problems.length, 1);
  assert.match(earlier.problems[0], /^persistence: a read came from a postmaster started before the run's/);

  // A restart in the middle of the probe: some reads from the run's postmaster, the rest from a later one.
  const { open } = standinOpen({
    start: RUN_START,
    change: ({ binding, row }) =>
      binding === "HYPERDRIVE_APP"
        ? {
            ...row,
            postmaster_start: ONE_MICROSECOND_LATER,
            postmaster_start_us: String(parseStart(ONE_MICROSECOND_LATER)),
          }
        : row,
  });
  const mixed = verdict(printable(await runProbe({ open })), { runStartUs: RUN_START_US });
  assert.equal(mixed.persistence, "not yet proved");
});

test("a postmaster start whose two forms disagree is a problem, never a proof", async () => {
  const { open } = standinOpen({
    start: ONE_MICROSECOND_LATER,
    change: ({ binding, read, row }) =>
      binding === "HYPERDRIVE_JOB" && read === 3
        ? { ...row, postmaster_start_us: String(RUN_START_US + 2n) }
        : row,
  });
  const judged = verdict(printable(await runProbe({ open })), { runStartUs: RUN_START_US });
  assert.ok(
    judged.problems.includes(
      "HYPERDRIVE_JOB: a read gave its postmaster's start in a form that cannot be read",
    ),
  );
});

test("the verdict counts again: fewer than 50 and 5 reads, or a transaction over two backends, fails", async () => {
  const { open } = standinOpen({ start: ONE_MICROSECOND_LATER });
  const good = printable(await runProbe({ open }));
  const fewer = structuredClone(good);
  fewer.sides[0].outside_transaction.answered = 49;
  fewer.sides[0].answers[0].reads = 54;
  fewer.sides[1].inside_transaction.answered = 4;
  fewer.sides[1].answers[0].reads = 54;
  assert.deepEqual(verdict(fewer, { runStartUs: RUN_START_US }).problems, [
    "HYPERDRIVE_JOB: 49 reads outside a transaction answered, where 50 are needed",
    "HYPERDRIVE_APP: 4 reads inside a transaction answered, where 5 are needed",
  ]);
  const split = structuredClone(good);
  split.sides[0].inside_transaction.backends = [5001, 5002];
  assert.deepEqual(verdict(split, { runStartUs: RUN_START_US }).problems, [
    "HYPERDRIVE_JOB: the transaction's reads came from 2 backend(s) (pid 5001, 5002), where one backend is needed",
  ]);
  const unaccounted = structuredClone(good);
  unaccounted.sides[1].answers[0].reads = 50;
  assert.deepEqual(verdict(unaccounted, { runStartUs: RUN_START_US }).problems, [
    "HYPERDRIVE_APP: the answers printed cover 50 reads, not the 55 answered",
  ]);
  // The session's own ok and failed_checks are never trusted.
  const claimed = structuredClone(good);
  claimed.sides[0].answers[0].own_usage = false;
  claimed.sides[0].ok = true;
  claimed.sides[0].answers[0].failed_checks = [];
  assert.equal(verdict(claimed, { runStartUs: RUN_START_US }).problems.length, 1);
  assert.equal(
    verdict({ ...good, probe: "another probe" }, { runStartUs: RUN_START_US }).problems[0],
    "the session's answer is not this probe's result",
  );
});

test("the list check takes both configurations only with caching disabled and each storing its own login", () => {
  const rows = checkList(listing(GOOD_CONFIGS));
  assert.deepEqual(
    rows.map((row) => [row.side.binding, row.id, row.caching]),
    [
      ["HYPERDRIVE_JOB", ID_JOB, "disabled"],
      ["HYPERDRIVE_APP", ID_APP, "disabled"],
    ],
  );
  const refused = (configs, pattern) => {
    assert.throws(() => checkList(listing(configs)), pattern);
  };
  refused([GOOD_CONFIGS[1]], /^Error: rosie-staging-hyperdrive-job is not in the Hyperdrive list/);
  refused([GOOD_CONFIGS[0]], /rosie-staging-hyperdrive-app is not in the Hyperdrive list/);
  refused(
    [GOOD_CONFIGS[0], { ...GOOD_CONFIGS[1], caching: "max_age: 60, stale_while_revalidate: 15" }],
    /rosie-staging-hyperdrive-app \(id fedcba9876543210fedcba9876543210\) has caching max_age: 60, stale_while_revalidate: 15, not disabled/,
  );
  assert.throws(
    () => checkList(listing([{ ...GOOD_CONFIGS[0], user: OTHER_USER }, GOOD_CONFIGS[1]])),
    (error) =>
      /stores another user \(not shown\), not its login rosie_worker_job; nothing was started$/.test(
        error.message,
      ) && !error.message.includes(OTHER_USER),
  );
  refused(
    [GOOD_CONFIGS[0], GOOD_CONFIGS[0], GOOD_CONFIGS[1]],
    /more than one Hyperdrive configuration is named rosie-staging-hyperdrive-job/,
  );
  refused([], /rosie-staging-hyperdrive-job is not in the Hyperdrive list/);
});

test("the temporary config binds the two configurations by their ids, and nothing else, for staging's name", () => {
  const rows = checkList(listing(GOOD_CONFIGS));
  const config = probeConfig({ main: "/made/up/worker.mjs", rows });
  assert.equal(config.account_id, ACCOUNT_ID);
  assert.equal(config.main, "/made/up/worker.mjs");
  assert.notEqual(config.name, "rosie");
  assert.deepEqual(config.env, {
    staging: {
      name: "rosie-staging",
      hyperdrive: [
        { binding: "HYPERDRIVE_JOB", id: ID_JOB },
        { binding: "HYPERDRIVE_APP", id: ID_APP },
      ],
    },
  });
  // No variable, route, trigger or other binding: the Worker gets the two configurations and nothing else.
  assert.deepEqual(Object.keys(config).sort(), [
    "account_id",
    "compatibility_date",
    "compatibility_flags",
    "env",
    "main",
    "name",
    "preview_urls",
    "workers_dev",
  ]);
});

test("outside text loses every host and every user of the list but the two logins", () => {
  const texts = outsideTexts(
    listing([
      ...GOOD_CONFIGS,
      {
        id: "11111111111111111111111111111111",
        name: "made-up-spike",
        user: OTHER_USER,
        host: "other-origin.example.test",
        caching: "disabled",
      },
    ]),
  );
  assert.deepEqual(texts.sort(), ["origin.example.test", OTHER_USER, "other-origin.example.test"].sort());
  const scrub = makeScrub(texts);
  assert.equal(
    scrub(`${OTHER_USER} at other-origin.example.test, not rosie_worker_job`),
    "[redacted] at [redacted], not rosie_worker_job",
  );
  assert.deepEqual(outsideTexts("no table here"), []);
});

test("no child gets a database URL or a Cloudflare credential, and wrangler keeps no log on disk", () => {
  const env = childEnvironment({
    PATH: "/made/up/bin",
    STAGING_DATABASE_URL: "x",
    DATABASE_URL: "x",
    CLOUDFLARE_API_TOKEN: "x",
    CF_API_KEY: "x",
    CF_BUILD_DIR: "/made/up/folder",
    HOME: "/made/up/home",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "HOME",
    "PATH",
    "WRANGLER_LOG_SANITIZE",
    "WRANGLER_SEND_METRICS",
    "WRANGLER_WRITE_LOGS",
  ]);
  assert.equal(env.WRANGLER_WRITE_LOGS, "false");
});

test("the serving version is the one with the most traffic, or nothing when the text does not say", () => {
  const live = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const status = {
    versions: [
      { version_id: "11111111-2222-4333-8444-555555555555", percentage: 10 },
      { version_id: live, percentage: 90 },
    ],
  };
  assert.equal(liveVersion(` ⛅️ wrangler 4.158.0\n${JSON.stringify(status, null, 2)}\n`), live);
  assert.equal(
    liveVersion(JSON.stringify({ versions: [{ version_id: "not-a-version", percentage: 100 }] })),
    "",
  );
  assert.equal(liveVersion("wrangler could not tell"), "");
});

test("the Worker refuses every request without the run's token, and says which bindings it has", async () => {
  const request = (pathname, token, method = "GET") =>
    new Request(`http://probe.invalid${pathname}`, {
      method,
      ...(token === undefined ? {} : { headers: { "x-probe-token": token } }),
    });
  assert.equal(refusedBy(request("/probe", TOKEN), {}), "no probe token is configured");
  assert.equal(
    refusedBy(request("/probe", "short"), { PROBE_TOKEN: "short" }),
    "no probe token is configured",
  );
  assert.equal(refusedBy(request("/probe"), { PROBE_TOKEN: TOKEN }), "the probe token is missing or wrong");
  assert.equal(
    refusedBy(request("/probe", `${TOKEN}x`), { PROBE_TOKEN: TOKEN }),
    "the probe token is missing or wrong",
  );
  assert.equal(refusedBy(request("/probe", TOKEN), { PROBE_TOKEN: TOKEN }), null);

  assert.equal((await worker.fetch(request("/probe"), { PROBE_TOKEN: TOKEN })).status, 403);
  const env = { PROBE_TOKEN: TOKEN, HYPERDRIVE_JOB: { connectionString: STRINGS.HYPERDRIVE_JOB } };
  const ready = await worker.fetch(request("/ready", TOKEN), env);
  assert.deepEqual(await ready.json(), {
    ready: true,
    probe: PROBE,
    bindings: { HYPERDRIVE_JOB: true, HYPERDRIVE_APP: false },
  });
  const unbound = await worker.fetch(request("/probe", TOKEN), env);
  assert.equal(unbound.status, 500);
  assert.deepEqual(await unbound.json(), { ok: false, error: "no HYPERDRIVE_APP binding" });
  assert.equal((await worker.fetch(request("/cleanup", TOKEN), env)).status, 404);
  assert.equal((await worker.fetch(request("/probe", TOKEN, "POST"), env)).status, 405);
});
