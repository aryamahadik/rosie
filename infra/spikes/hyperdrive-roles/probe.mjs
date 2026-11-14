// T-1255 (ADR-014 section 4's piece 7): the live check of staging's two Hyperdrive configurations. The probe's reads,
// the answers ADR-014 section 2's table expects, and the verdict run.mjs prints. worker.mjs runs runProbe() through the
// bindings HYPERDRIVE_JOB and HYPERDRIVE_APP; run.mjs rebuilds what it prints with printable() and judges it with
// verdict(); the tests run all of it against stand-ins. Nothing here is product code: no file outside this folder
// imports it.
//
// Through each binding: the guard's reads (the table, as one select) with pg_backend_pid() and
// pg_postmaster_start_time(), OUTSIDE_READS times outside a transaction (rounds of ROUND_SIZE at once, so the pool
// hands out several backends) and INSIDE_READS times inside one read-only transaction; then each binding read where
// the other side's answers are expected (crossed), which those answers must refuse. The probe only reads: no table, no
// setting, no role is changed. It never sees a password: worker.mjs hands it `open`, which makes the postgres.js
// clients from the bindings, and `redact`, which every error message passes through.

export const PROBE = "T-1255 hyperdrive-roles";
/** ADR-014 section 4's piece 7: at least 50 reads outside a transaction and 5 inside one, through each binding. */
export const OUTSIDE_READS = 50;
export const INSIDE_READS = 5;
/** Reads sent at once outside a transaction, on one client of at most this many connections (a Worker may hold 6). */
export const ROUND_SIZE = 5;

/**
 * The two sides (ADR-014 sections 1 and 3): each configuration, its binding, the login it stores and the one role
 * that login inherits; `other` is the other side's role.
 */
export const SIDES = Object.freeze([
  Object.freeze({
    side: "job",
    label: "the runtime side",
    name: "rosie-staging-hyperdrive-job",
    binding: "HYPERDRIVE_JOB",
    login: "rosie_worker_job",
    role: "rosie_job",
    other: "rosie_app",
  }),
  Object.freeze({
    side: "app",
    label: "the Tool API side",
    name: "rosie-staging-hyperdrive-app",
    binding: "HYPERDRIVE_APP",
    login: "rosie_worker_app",
    role: "rosie_app",
    other: "rosie_job",
  }),
]);

// A plain SQL name: it goes into the query's text between single quotes, so it may hold no quote or other sign.
const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The guard's reads of ADR-014 section 2's table for one side, as one select, with the backend's pid and its
 * postmaster's start (as text in UTC, and as microseconds since 1970, both read by the server). The login's
 * memberships are read by member, never by role. The role names are the side's constants, never input.
 */
export function guardQuery(side) {
  for (const name of [side.role, side.other]) {
    if (!PLAIN_NAME.test(name)) {
      throw new Error("a role name must be a plain lower-case name (letters, digits and underscores)");
    }
  }
  return `select session_user::pg_catalog.text as session_user_name,
  current_user::pg_catalog.text as current_user_name,
  (select pg_catalog.json_agg(pg_catalog.json_build_object('role', r.rolname::pg_catalog.text,
            'inherit', m.inherit_option, 'set', m.set_option, 'admin', m.admin_option) order by r.rolname)::pg_catalog.text
     from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.roleid
    where m.member = (select u.oid from pg_catalog.pg_roles u where u.rolname = current_user)) as memberships,
  pg_catalog.pg_has_role(current_user, '${side.role}', 'USAGE') as own_usage,
  pg_catalog.pg_has_role(current_user, '${side.other}', 'MEMBER') as other_member,
  pg_catalog.row_security_active('businesses') as row_security,
  pg_catalog.current_schema()::pg_catalog.text as schema_name,
  pg_catalog.pg_backend_pid() as pid,
  pg_catalog.to_char(pg_catalog.pg_postmaster_start_time() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as postmaster_start,
  ((extract(epoch from pg_catalog.pg_postmaster_start_time()) * 1000000)::pg_catalog.int8)::pg_catalog.text as postmaster_start_us`;
}

/** The memberships cell (json_agg's text, null for none) as a list, or null when it cannot be read. */
function membershipsOf(cell) {
  if (cell === null || cell === undefined) return [];
  try {
    const list = typeof cell === "string" ? JSON.parse(cell) : cell;
    if (!Array.isArray(list)) return null;
    return list.map((entry) => ({
      role: typeof entry?.role === "string" ? entry.role : null,
      inherit: entry?.inherit,
      set: entry?.set,
      admin: entry?.admin,
    }));
  } catch {
    return null;
  }
}

/** One row of guardQuery as an answer: the fields failedChecks() reads. */
export function answerOf(row) {
  return {
    session_user: typeof row?.session_user_name === "string" ? row.session_user_name : null,
    current_user: typeof row?.current_user_name === "string" ? row.current_user_name : null,
    memberships: membershipsOf(row?.memberships),
    own_usage: row?.own_usage,
    other_member: row?.other_member,
    row_security: row?.row_security,
    current_schema: typeof row?.schema_name === "string" ? row.schema_name : null,
  };
}

/**
 * The checks of ADR-014 section 2's table that an answer fails for a side: none when it is that side's login with the
 * table's expected answers. Each label names the read, never a value.
 */
export function failedChecks(answer, side) {
  const failed = [];
  if (answer?.session_user !== side.login) failed.push("session_user");
  if (answer?.current_user !== side.login) failed.push("current_user");
  const own = answer?.memberships;
  const only = Array.isArray(own) && own.length === 1 ? own[0] : null;
  if (
    only === null ||
    only.role !== side.role ||
    only.inherit !== true ||
    only.set !== false ||
    only.admin !== false
  ) {
    failed.push("memberships");
  }
  if (answer?.own_usage !== true) failed.push(`pg_has_role(current_user, '${side.role}', 'USAGE')`);
  if (answer?.other_member !== false) failed.push(`pg_has_role(current_user, '${side.other}', 'MEMBER')`);
  if (answer?.row_security !== true) failed.push("row_security_active('businesses')");
  if (answer?.current_schema !== "public") failed.push("current_schema()");
  return failed;
}

/** The answers a side expects, in words (the table's row for it), for the printed lines. */
export const expectedWords = (side) =>
  `session_user and current_user ${side.login}; memberships by member: ${side.role} (inherit true, set false, admin false) only; pg_has_role(current_user, '${side.role}', 'USAGE') true; pg_has_role(current_user, '${side.other}', 'MEMBER') false; row_security_active('businesses') true; current_schema() public`;

/**
 * The names a printed answer may hold: the logins and roles of the sides, PostgreSQL's predefined pg_ roles and
 * Neon's neon_superuser (no login can use any of these). Any other name, a user above all, prints as "(not shown)".
 */
export function shownNameOf(sides = SIDES) {
  const known = new Set(sides.flatMap((side) => [side.login, side.role]));
  return (name) => {
    if (name === null || name === undefined) return null;
    if (typeof name !== "string") return "(not shown)";
    if (known.has(name) || name === "neon_superuser" || /^pg_[a-z_]{1,60}$/.test(name)) return name;
    return "(not shown)";
  };
}

const truth = (value) => (value === true || value === false ? value : null);

/** An answer as it may be printed: every name through shownNameOf, every flag true, false or null. */
export function shownAnswer(answer, sides = SIDES) {
  const shown = shownNameOf(sides);
  return {
    session_user: shown(answer.session_user),
    current_user: shown(answer.current_user),
    memberships: Array.isArray(answer.memberships)
      ? answer.memberships.map((entry) => ({
          role: shown(entry.role),
          inherit: truth(entry.inherit),
          set: truth(entry.set),
          admin: truth(entry.admin),
        }))
      : "(unreadable)",
    own_usage: truth(answer.own_usage),
    other_member: truth(answer.other_member),
    row_security: truth(answer.row_security),
    current_schema: answer.current_schema === "public" ? "public" : shown(answer.current_schema),
  };
}

/**
 * A function that removes each connection string from a text, with its password, user and host on their own (as
 * written and percent-decoded), but for the names in `keep` (the two logins, which may be printed). From the spike
 * T-1124's probe.mjs, copied so that no file outside that spike imports it.
 */
export function makeRedactor(urls, keep = []) {
  const kept = new Set(keep);
  const secrets = new Set();
  const add = (part) => {
    if (part !== "" && !kept.has(part)) secrets.add(part);
  };
  for (const url of urls) {
    if (typeof url !== "string" || url === "") continue;
    add(url);
    try {
      const parsed = new URL(url);
      for (const part of [parsed.password, parsed.username, parsed.hostname]) {
        add(part);
        try {
          add(decodeURIComponent(part));
        } catch {
          // Not percent-encoded text: the part as written is still removed.
        }
      }
    } catch {
      // Not a parsable URL: the whole string is still removed.
    }
  }
  // Longest first, so a password that contains the user name is removed whole.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const secret of ordered) out = out.split(secret).join("[redacted]");
    return out;
  };
}

/** An error as the result holds it: its code (a SQLSTATE or the client's own code) and its redacted message. */
function describe(error, redact) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 200);
  return { code, message };
}

const CANONICAL_START = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00$/;

/** The postmaster's start as a read gave it, or null when either form is missing or malformed. */
function startOf(row) {
  const text = row?.postmaster_start;
  const us = row?.postmaster_start_us;
  if (typeof text !== "string" || !CANONICAL_START.test(text)) return null;
  if (typeof us !== "string" || !/^\d{1,20}$/.test(us)) return null;
  return { start: text, start_us: us };
}

/** What one binding's reads gave: the answers grouped as printed, the backends of each phase, starts and errors. */
function tally(side, sides, redact) {
  const groups = new Map();
  const starts = new Map();
  const errors = new Map();
  const phases = {
    outside_transaction: { answered: 0, backends: new Set() },
    inside_transaction: { answered: 0, backends: new Set() },
  };
  return {
    phases,
    answer(phase, row) {
      const answer = answerOf(row);
      const shown = shownAnswer(answer, sides);
      const failed = failedChecks(answer, side);
      const pid = Number.isInteger(row?.pid) ? row.pid : null;
      const key = JSON.stringify([shown, failed]);
      const group = groups.get(key) ?? { reads: 0, backends: new Set(), ...shown, failed_checks: failed };
      group.reads += 1;
      if (pid !== null) group.backends.add(pid);
      groups.set(key, group);
      phases[phase].answered += 1;
      if (pid !== null) phases[phase].backends.add(pid);
      const start = startOf(row);
      const startKey = start === null ? "(unreadable)" : start.start_us;
      const seen = starts.get(startKey) ?? { ...(start ?? { start: null, start_us: null }), reads: 0 };
      seen.reads += 1;
      starts.set(startKey, seen);
    },
    error(phase, error) {
      const described = describe(error, redact);
      const key = JSON.stringify([phase, described]);
      const seen = errors.get(key) ?? { phase, ...described, count: 0 };
      seen.count += 1;
      errors.set(key, seen);
    },
    groups: () =>
      [...groups.values()].map((group) => ({
        ...group,
        backends: [...group.backends].sort((a, b) => a - b),
      })),
    starts: () => [...starts.values()],
    errors: () => [...errors.values()],
  };
}

async function end(sql) {
  try {
    await sql.end({ timeout: 5 });
  } catch {
    // A client that cannot end cleanly changes nothing the probe reports.
  }
}

/** The reads through one binding: OUTSIDE_READS outside a transaction, then INSIDE_READS inside one. */
async function probeSide({ open, side, sides, redact }) {
  const query = guardQuery(side);
  const seen = tally(side, sides, redact);

  // Outside a transaction: rounds of ROUND_SIZE reads at once on one client, so the pool serves them from several
  // backends at a time.
  const pool = open(side.binding, { max: ROUND_SIZE });
  try {
    for (let done = 0; done < OUTSIDE_READS; done += ROUND_SIZE) {
      const round = Math.min(ROUND_SIZE, OUTSIDE_READS - done);
      const reads = await Promise.allSettled(Array.from({ length: round }, () => pool.unsafe(query)));
      for (const read of reads) {
        if (read.status === "fulfilled") seen.answer("outside_transaction", read.value[0]);
        else seen.error("outside_transaction", read.reason);
      }
    }
  } finally {
    await end(pool);
  }

  // Inside one transaction (read only: the probe writes nothing), on a client of its own.
  const single = open(side.binding, { max: 1 });
  try {
    await single.begin("read only", async (tx) => {
      for (let read = 0; read < INSIDE_READS; read += 1) {
        const rows = await tx.unsafe(query);
        seen.answer("inside_transaction", rows[0]);
      }
    });
  } catch (error) {
    seen.error("inside_transaction", error);
  } finally {
    await end(single);
  }

  const { outside_transaction: outside, inside_transaction: inside } = seen.phases;
  const answers = seen.groups();
  const errors = seen.errors();
  const ok =
    outside.answered === OUTSIDE_READS &&
    inside.answered === INSIDE_READS &&
    inside.backends.size === 1 &&
    errors.length === 0 &&
    answers.every((group) => group.failed_checks.length === 0);
  return {
    side: side.side,
    name: side.name,
    binding: side.binding,
    login: side.login,
    outside_transaction: {
      answered: outside.answered,
      backends: [...outside.backends].sort((a, b) => a - b),
    },
    inside_transaction: {
      answered: inside.answered,
      backends: [...inside.backends].sort((a, b) => a - b),
    },
    answers,
    postmaster_starts: seen.starts(),
    errors,
    ok,
  };
}

/** One binding read where another side's answers are expected: those answers must refuse it. */
async function crossedRead({ open, side, expected, sides, redact }) {
  const entry = { binding: side.binding, read_as: expected.side, expected_login: expected.login };
  const sql = open(side.binding, { max: 1 });
  try {
    const rows = await sql.unsafe(guardQuery(expected));
    const row = rows[0];
    const answer = answerOf(row);
    const failed = failedChecks(answer, expected);
    const start = startOf(row);
    return {
      ...entry,
      answered: true,
      refused: failed.length > 0,
      failed_checks: failed,
      backend: Number.isInteger(row?.pid) ? row.pid : null,
      answer: shownAnswer(answer, sides),
      postmaster_start: start?.start ?? null,
      postmaster_start_us: start?.start_us ?? null,
      ok: failed.length > 0,
    };
  } catch (error) {
    return { ...entry, answered: false, refused: false, error: describe(error, redact), ok: false };
  } finally {
    await end(sql);
  }
}

/**
 * Runs the whole probe and returns its result: one entry per side, one per crossed read, and `ok` for the run.
 *   open(binding, options)  a postgres.js client through that binding (HYPERDRIVE_JOB or HYPERDRIVE_APP)
 *   redact(text)            removes the bindings' connection strings and their parts from an error message
 *   sides                   SIDES; the tests alone pass others
 */
export async function runProbe({ open, redact = (text) => String(text), sides = SIDES }) {
  const started = Date.now();
  const result = { probe: PROBE, ok: false, failed_steps: [], sides: [], crossed: [] };
  for (const side of sides) {
    result.sides.push(await probeSide({ open, side, sides, redact }));
  }
  for (const side of sides) {
    for (const expected of sides.filter((other) => other !== side)) {
      result.crossed.push(await crossedRead({ open, side, expected, sides, redact }));
    }
  }
  result.failed_steps = [
    ...result.sides.filter((entry) => !entry.ok).map((entry) => `${entry.binding}'s reads`),
    ...result.crossed
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.binding} crossed (read as ${entry.read_as})`),
  ];
  result.ok = result.failed_steps.length === 0;
  result.elapsed_ms = Date.now() - started;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// The postmaster's start: the run's (an argument) and the probe's (read through each binding), to the microsecond.

const START_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)$/;

/**
 * A timestamp with its time zone, as PostgreSQL prints a timestamptz ("2026-01-02 03:04:05.123456+00") or in ISO 8601
 * ("2026-01-02T03:04:05.123456Z"), as microseconds since 1970 (a BigInt). Throws on anything else: a time without a
 * zone, a date that does not exist, a year before 2000.
 */
export function parseStart(text) {
  const match = START_INPUT.exec(String(text).trim());
  if (match === null) throw new Error("not a timestamp with its time zone");
  const [, year, month, day, hour, minute, second, fraction = "", zulu, sign, offsetHours, offsetMinutes] =
    match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = parts;
  if (y < 2000) throw new Error("a year before 2000");
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  ) {
    throw new Error("a date or time that does not exist");
  }
  let offset = 0n;
  if (zulu === undefined) {
    const hours = Number(offsetHours);
    const minutes = Number(offsetMinutes ?? "0");
    if (hours > 15 || minutes > 59) throw new Error("a time zone offset that does not exist");
    offset = BigInt((hours * 60 + minutes) * (sign === "-" ? -1 : 1)) * 60_000_000n;
  }
  return BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, "0")) - offset;
}

/** Microseconds since 1970 as PostgreSQL prints a timestamptz in UTC: "2026-01-02 03:04:05.123456+00". */
export function formatStart(us) {
  const seconds = us / 1_000_000n;
  const micro = us % 1_000_000n;
  const date = new Date(Number(seconds) * 1000);
  const two = (value) => String(value).padStart(2, "0");
  return `${String(date.getUTCFullYear())}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}.${String(micro).padStart(6, "0")}+00`;
}

// ---------------------------------------------------------------------------------------------------------------------
// What run.mjs prints, and its verdict.

/** The keys whose text is a role or user name: printed only through shownNameOf. */
const NAME_KEYS = new Set([
  "session_user",
  "current_user",
  "role",
  "current_schema",
  "login",
  "expected_login",
]);

/** The keys whose text is one of the probe's own words: printed only when it is one, else "(unknown)". */
const WORD_KEYS = (sides) =>
  new Map([
    ["probe", new Set([PROBE])],
    ["binding", new Set(sides.map((side) => side.binding))],
    ["name", new Set(sides.map((side) => side.name))],
    ["side", new Set(sides.map((side) => side.side))],
    ["read_as", new Set(sides.map((side) => side.side))],
    ["phase", new Set(["outside_transaction", "inside_transaction"])],
  ]);

/**
 * The session's answer rebuilt for printing: every name through shownNameOf, each of the probe's own words only when
 * it is one, every other text through scrub (the run's token and the origins' hosts and users, which run.mjs knows),
 * numbers, flags and nulls as they are; anything else, and anything deeper than the result's shape, is dropped.
 */
export function printable(value, { scrub = (text) => text, sides = SIDES } = {}, key = "", depth = 0) {
  const shown = shownNameOf(sides);
  if (depth > 8) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (NAME_KEYS.has(key) && !(key === "current_schema" && value === "public")) return shown(value);
    const words = WORD_KEYS(sides).get(key);
    if (words !== undefined) return words.has(value) ? value : "(unknown)";
    return scrub(value).slice(0, 300);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => printable(item, { scrub, sides }, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .filter(([name]) => /^[a-z_]{1,40}$/.test(name))
        .map(([name, item]) => [name, printable(item, { scrub, sides }, name, depth + 1)]),
    );
  }
  return null;
}

const listOf = (value) => (Array.isArray(value) ? value : []);
const pidsOf = (value) => listOf(value).filter((pid) => Number.isInteger(pid));
const pidWords = (pids) =>
  pids.length === 0 ? "no backend" : `${String(pids.length)} backend(s) (pid ${pids.join(", ")})`;

/** The postmaster starts one binding's reads gave, each checked: its two forms agree, to the microsecond. */
function startsOf(entries) {
  const starts = [];
  const faults = [];
  for (const entry of entries) {
    const text = entry?.start;
    const us = entry?.start_us;
    let value = null;
    try {
      if (
        typeof text === "string" &&
        CANONICAL_START.test(text) &&
        typeof us === "string" &&
        /^\d+$/.test(us)
      ) {
        value = parseStart(text) === BigInt(us) ? BigInt(us) : null;
      }
    } catch {
      value = null;
    }
    if (value === null) faults.push(entry);
    else starts.push({ us: value, reads: Number.isInteger(entry?.reads) ? entry.reads : 1 });
  }
  return { starts, faults };
}

/**
 * The verdict on a printable() result: the role checks, recomputed here from what is printed (the session's own `ok`
 * and `failed_checks` are never trusted), and the persistence proof against the run's postmaster start (DL-733).
 * Returns { problems, lines, persistence }: persistence is "proved" (every read came from a postmaster started after
 * the run's), "not yet proved" (a read came from the run's own postmaster), "contradicted" (one started before it) or
 * "unknown" (a binding gave no readable start).
 */
export function verdict(result, { runStartUs, sides = SIDES }) {
  const problems = [];
  const lines = [];
  if (result?.probe !== PROBE) problems.push("the session's answer is not this probe's result");
  const startsByBinding = new Map(sides.map((side) => [side.binding, []]));

  for (const side of sides) {
    const got = listOf(result?.sides).find((entry) => entry?.binding === side.binding);
    if (got === undefined) {
      problems.push(`${side.binding}: the result has no reads through it`);
      continue;
    }
    const outside = got.outside_transaction ?? {};
    const inside = got.inside_transaction ?? {};
    const outsidePids = pidsOf(outside.backends);
    const insidePids = pidsOf(inside.backends);
    const before = problems.length;
    if (outside.answered !== OUTSIDE_READS) {
      problems.push(
        `${side.binding}: ${String(outside.answered)} reads outside a transaction answered, where ${String(OUTSIDE_READS)} are needed`,
      );
    }
    if (inside.answered !== INSIDE_READS) {
      problems.push(
        `${side.binding}: ${String(inside.answered)} reads inside a transaction answered, where ${String(INSIDE_READS)} are needed`,
      );
    }
    if (insidePids.length !== 1) {
      problems.push(
        `${side.binding}: the transaction's reads came from ${pidWords(insidePids)}, where one backend is needed`,
      );
    }
    let counted = 0;
    for (const group of listOf(got.answers)) {
      const reads = Number.isInteger(group?.reads) ? group.reads : 0;
      counted += reads;
      const failed = failedChecks(group, side);
      if (failed.length > 0) {
        const who =
          group?.session_user === side.login && group?.current_user === side.login
            ? `as ${side.login}`
            : `as another login: ${String(group?.current_user)}`;
        problems.push(
          `${side.binding}: ${String(reads)} read(s) on ${pidWords(pidsOf(group?.backends))} answered ${who}, failing the table's checks: ${failed.join(", ")}`,
        );
      }
    }
    if (counted !== Number(outside.answered) + Number(inside.answered)) {
      problems.push(
        `${side.binding}: the answers printed cover ${String(counted)} reads, not the ${String(Number(outside.answered) + Number(inside.answered))} answered`,
      );
    }
    for (const error of listOf(got.errors)) {
      const where =
        error?.phase === "inside_transaction" ? "inside the transaction" : "outside a transaction";
      problems.push(
        `${side.binding}: ${String(error?.count)} read(s) ${where} failed: ${String(error?.code)}: ${String(error?.message)}`,
      );
    }
    startsByBinding.get(side.binding).push(...listOf(got.postmaster_starts));
    if (problems.length === before) {
      lines.push(
        `roles: ${side.binding} (${side.name}): ${String(OUTSIDE_READS)} reads outside a transaction on ${pidWords(outsidePids)} and ${String(INSIDE_READS)} inside one on ${pidWords(insidePids)}: every one answered as ${side.login} with the table's expected answers (${expectedWords(side)})`,
      );
    } else {
      lines.push(`roles: ${side.binding} (${side.name}): FAILED (the problems are listed below)`);
    }
  }

  for (const side of sides) {
    for (const expected of sides.filter((other) => other !== side)) {
      const got = listOf(result?.crossed).find(
        (entry) => entry?.binding === side.binding && entry?.read_as === expected.side,
      );
      if (got === undefined) {
        problems.push(`${side.binding} crossed: no read where ${expected.label}'s answers are expected`);
        continue;
      }
      if (got.answered !== true) {
        problems.push(
          `${side.binding} crossed: the read where ${expected.label}'s answers are expected failed: ${String(got.error?.code)}: ${String(got.error?.message)}`,
        );
        continue;
      }
      const failed = failedChecks(got.answer, expected);
      if (failed.length === 0) {
        problems.push(
          `${side.binding} crossed: read where ${expected.label}'s answers are expected, it was NOT refused: it answered as ${expected.login}`,
        );
        continue;
      }
      startsByBinding
        .get(side.binding)
        .push({ start: got.postmaster_start, start_us: got.postmaster_start_us, reads: 1 });
      lines.push(
        `crossed: ${side.binding} read where ${expected.label}'s answers are expected: refused (${failed.join(", ")})`,
      );
    }
  }

  // The persistence proof (DL-733): the postmaster's start read through each binding against the run's.
  const runStart = formatStart(runStartUs);
  const all = [];
  const startWords = [];
  let unread = false;
  for (const side of sides) {
    const { starts, faults } = startsOf(startsByBinding.get(side.binding));
    if (faults.length > 0) {
      problems.push(`${side.binding}: a read gave its postmaster's start in a form that cannot be read`);
    }
    if (starts.length === 0) {
      unread = true;
      startWords.push(`${side.binding}: no readable start`);
      continue;
    }
    all.push(...starts);
    const reads = new Map();
    for (const start of starts) reads.set(start.us, (reads.get(start.us) ?? 0) + start.reads);
    startWords.push(
      `${side.binding}: started ${[...reads].map(([us, count]) => `${formatStart(us)} (${String(count)} reads)`).join(", ")}`,
    );
  }
  lines.push(`postmaster: ${startWords.join("; ")}`);
  let persistence;
  if (unread) {
    persistence = "unknown";
    problems.push(
      "persistence: a binding gave no readable postmaster start, so nothing is known (a login refused after a compute restart looks so: then Neon did not keep the password)",
    );
    lines.push("persistence: NOT KNOWN (below)");
  } else if (all.some((start) => start.us < runStartUs)) {
    persistence = "contradicted";
    problems.push(
      `persistence: a read came from a postmaster started before the run's (${runStart}): the time given is not the run's, or a binding reaches another server`,
    );
    lines.push("persistence: FAILED (below)");
  } else if (all.some((start) => start.us === runStartUs)) {
    persistence = "not yet proved";
    lines.push(
      `persistence: NOT YET PROVED: a read came from the postmaster that started at ${runStart}, the run's own, so the compute has not suspended or restarted since the passwords were set. This is not a pass: run the probe again once the compute has suspended`,
    );
  } else {
    persistence = "proved";
    lines.push(
      `persistence: proved: every read through both bindings came from a postmaster started after the run's (${runStart}), so the compute has suspended or restarted since the passwords were set, and both logins still log in`,
    );
  }
  return { problems, lines, persistence };
}
