// T-1302: staging's check tester (db/seeds/check-tester.ts; K-05 v1.12 default 105), without a database: the refusals
// that come before the database is reached, the rows' names against K-05 v1.12's frozen read-tester-standing-check-tester
// .json (read here with node:fs), and the card's files holding no token, no hash of one, no real number and no email but
// example.com's (rule 9). Every hash here is made at random when the test runs (the hash of no token), and every database
// URL is made up: it names no user, password or real host (.invalid never resolves, RFC 6761).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Sql } from "../repo/scope";
import {
  CHECK_TESTER,
  type CheckTesterEnv,
  CheckTesterSeedError,
  CODE_HASH_KEY_NAME,
  NO_CODE_HASH,
  requireStagingTarget,
  seed,
  seedCheckTester,
  SESSION_DAYS,
  TOKEN_HASH_VARIABLE,
  tokenSha256Of,
} from "./check-tester";

const REPO = new URL("../../", import.meta.url);
const STAGING_URL = "postgres://staging-t1302.example.invalid/rosie_staging";
const OTHER_URL = "postgres://other-t1302.example.invalid/rosie_other";
const LOCAL_URL = "postgres://127.0.0.1:54329/rosie";
const DAY_MS = 24 * 60 * 60 * 1000;
const WRONG_FORM = `${TOKEN_HASH_VARIABLE} is not 64 lower-case hex characters`;

/** A stand-in for the token's sha256: 64 lower-case hex characters made at random, the hash of no token. */
const standInHash = (): string => randomBytes(32).toString("hex");

/** The variables seed:staging hands the set on staging, with `hash` as the token's sha256 (undefined: unset). */
const onStaging = (hash: string | undefined): CheckTesterEnv => ({
  DATABASE_URL: STAGING_URL,
  STAGING_DATABASE_URL: STAGING_URL,
  DB_SCHEMA: "public",
  [TOKEN_HASH_VARIABLE]: hash,
});

/** What a call threw, or null. */
function thrown(run: () => unknown): Error | null {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  return null;
}

/** A database handle that records any use, so a refusal is shown to come before the set reaches the database. */
function tripwire(): { sql: Sql; reached: () => boolean } {
  let reached = false;
  const trip = (): never => {
    reached = true;
    throw new Error("the set reached the database");
  };
  const handle = new Proxy(() => undefined, { apply: trip, get: trip });
  return { sql: handle as unknown as Sql, reached: () => reached };
}

/** The parts of a made-up URL no message may hold. */
const partsOf = (url: string): string[] => {
  const parsed = new URL(url);
  return [url, parsed.hostname, parsed.pathname.slice(1)];
};

describe("the target: staging's own schema, by the runner's and seed-staging.sh's signals", () => {
  it("takes DATABASE_URL equal to STAGING_DATABASE_URL with DB_SCHEMA unset, blank or public", () => {
    for (const schema of [undefined, "", "  ", "public", " public "]) {
      const env = { DATABASE_URL: STAGING_URL, STAGING_DATABASE_URL: STAGING_URL, DB_SCHEMA: schema };
      expect(
        thrown(() => {
          requireStagingTarget(env);
        }),
        JSON.stringify(schema),
      ).toBeNull();
    }
  });

  it("refuses any other target, naming no part of either URL: no DATABASE_URL, no staging database named, another database (a local one, production or any other), and a preview's schema", () => {
    const cases: readonly [string, CheckTesterEnv, string][] = [
      ["nothing set", {}, "DATABASE_URL does not name the staging database"],
      [
        "no DATABASE_URL",
        { STAGING_DATABASE_URL: STAGING_URL },
        "DATABASE_URL does not name the staging database",
      ],
      ["both empty", { DATABASE_URL: "", STAGING_DATABASE_URL: "" }, "DATABASE_URL does not name"],
      ["a local database", { DATABASE_URL: LOCAL_URL }, "DATABASE_URL does not name the staging database"],
      [
        "a local database, another named staging",
        { DATABASE_URL: LOCAL_URL, STAGING_DATABASE_URL: STAGING_URL },
        "DATABASE_URL does not name the staging database",
      ],
      [
        "another database",
        { DATABASE_URL: OTHER_URL, STAGING_DATABASE_URL: STAGING_URL },
        "DATABASE_URL does not name the staging database",
      ],
      [
        "staging's URL with a space",
        { DATABASE_URL: `${STAGING_URL} `, STAGING_DATABASE_URL: STAGING_URL },
        "DATABASE_URL does not name the staging database",
      ],
      [
        "a preview's schema on the staging database",
        { DATABASE_URL: STAGING_URL, STAGING_DATABASE_URL: STAGING_URL, DB_SCHEMA: "preview_t1302" },
        "DB_SCHEMA names a schema other than public",
      ],
    ];
    for (const [what, env, says] of cases) {
      const error = thrown(() => {
        requireStagingTarget(env);
      });
      expect(error, what).toBeInstanceOf(CheckTesterSeedError);
      expect(error?.message, what).toContain(`the check tester seed refused, writing nothing: ${says}`);
      for (const part of [
        ...partsOf(STAGING_URL),
        ...partsOf(OTHER_URL),
        "127.0.0.1",
        "54329",
        "preview_t1302",
      ]) {
        expect(error?.message.includes(part), `${what}: ${part}`).toBe(false);
      }
    }
  });
});

describe("the token's sha256, handed in by name", () => {
  it(`reads ${TOKEN_HASH_VARIABLE}: 64 lower-case hex characters, as K-22 keeps a token's sha256`, () => {
    const hash = standInHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenSha256Of({ [TOKEN_HASH_VARIABLE]: hash })).toBe(hash);
  });

  it("refuses it absent (unset or empty) and in the wrong form, showing no part of the value", () => {
    const hash = standInHash();
    const token = randomBytes(32).toString("base64url");
    const cases: readonly [string, string | undefined, string][] = [
      ["unset", undefined, `${TOKEN_HASH_VARIABLE} is not set`],
      ["empty", "", `${TOKEN_HASH_VARIABLE} is not set`],
      ["63 characters", hash.slice(1), WRONG_FORM],
      ["65 characters", `${hash}0`, WRONG_FORM],
      ["upper-case hex", hash.toUpperCase(), WRONG_FORM],
      ["a letter past f", `${hash.slice(0, 63)}g`, WRONG_FORM],
      ["a space before it", ` ${hash.slice(1)}`, WRONG_FORM],
      ["a new line after it", `${hash}\n`, WRONG_FORM],
      ["the token in its place (32 bytes in base64url)", token, WRONG_FORM],
      ["blank", " ".repeat(64), WRONG_FORM],
    ];
    for (const [what, value, says] of cases) {
      const error = thrown(() => tokenSha256Of({ [TOKEN_HASH_VARIABLE]: value }));
      expect(error, what).toBeInstanceOf(CheckTesterSeedError);
      expect(error?.message, what).toContain(`the check tester seed refused, writing nothing: ${says}`);
      for (const part of [hash, hash.slice(0, 8), hash.slice(-8), token, token.slice(0, 8)]) {
        expect(error?.message.includes(part), `${what}: a part of the value`).toBe(false);
      }
    }
  });
});

describe("the set refuses before it reaches the database", () => {
  it("is the set T-201's runner finds by its file name: `seed` is this seed", () => {
    expect(seed).toBe(seedCheckTester);
  });

  it("an absent hash, a hash in the wrong form and any target that is not staging's: each refused with the database never reached", async () => {
    const valid = onStaging(standInHash());
    const cases: readonly [string, CheckTesterEnv, string][] = [
      ["an absent hash", onStaging(undefined), `${TOKEN_HASH_VARIABLE} is not set`],
      ["an empty hash", onStaging(""), `${TOKEN_HASH_VARIABLE} is not set`],
      ["a hash in the wrong form", onStaging(standInHash().toUpperCase()), WRONG_FORM],
      [
        "a local database",
        { ...valid, DATABASE_URL: LOCAL_URL },
        "DATABASE_URL does not name the staging database",
      ],
      [
        "another database",
        { ...valid, DATABASE_URL: OTHER_URL },
        "DATABASE_URL does not name the staging database",
      ],
      [
        "no staging database named",
        { ...valid, STAGING_DATABASE_URL: undefined },
        "DATABASE_URL does not name the staging database",
      ],
      ["a preview's schema", { ...valid, DB_SCHEMA: "preview_t1302" }, "DB_SCHEMA names a schema other"],
      // The target is judged first: with both wrong, the refusal names the target.
      [
        "a local database and no hash",
        { DATABASE_URL: LOCAL_URL, [TOKEN_HASH_VARIABLE]: undefined },
        "DATABASE_URL does not name the staging database",
      ],
    ];
    for (const [what, env, says] of cases) {
      const { sql, reached } = tripwire();
      const error = await seedCheckTester(sql, { env }).then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      expect(error, what).toBeInstanceOf(CheckTesterSeedError);
      expect(error?.message, what).toContain(says);
      expect(reached(), what).toBe(false);
    }
  });

  it("and with staging's target and a hash in form, it does reach the database (the tripwire above is live)", async () => {
    const { sql, reached } = tripwire();
    await expect(seedCheckTester(sql, { env: onStaging(standInHash()) })).rejects.toThrow(
      "the set reached the database",
    );
    expect(reached()).toBe(true);
  });
});

describe("the rows are K-05 v1.12 default 105's, as read-tester-standing-check-tester.json shows them", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("contracts/data-access/fixtures/read-tester-standing-check-tester.json", REPO),
      "utf8",
    ),
  ) as { call: string; given: { note: string } };
  const { note } = fixture.given;

  it("the person, its email handle at example.com, the link and the team row by the fixture's ids, the team row reaching that email handle alone", () => {
    expect(fixture.call).toBe("readTesterStanding");
    const { personId, emailHandleId, email, teamRowId } = CHECK_TESTER;
    expect(email).toMatch(/^[a-z0-9-]+@example\.com$/);
    for (const part of [
      `persons ${personId} (name and language null`,
      `handles ${emailHandleId} (email, ${email})`,
      `person_handles (${personId}, ${emailHandleId})`,
      `team_page_recipients ${teamRowId} (person_id ${personId}, chat_handle_id null, email_handle_id ${emailHandleId}`,
      "removed_at null",
    ]) {
      expect(note).toContain(part);
    }
  });

  it("a used sign-in code by email under the code key's name, its hash the hash of no code; a session proven by code, with no device", () => {
    expect(NO_CODE_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(NO_CODE_HASH).size).toBe(1);
    for (const part of [
      "purpose sign_in",
      `sent_to_handle_id ${CHECK_TESTER.emailHandleId}, channel email`,
      `hash_key_name ${CODE_HASH_KEY_NAME}`,
      "wrong_tries 0",
      "version 2); sessions",
      `person_id ${CHECK_TESTER.personId}, token_sha256`,
      "device_sha256 null, proven_via code",
      "ended_at and ended_why null, version 1",
    ]) {
      expect(note).toContain(part);
    }
  });

  it(`the session is bounded: ${String(SESSION_DAYS)} days from its start to its end, as the fixture's session runs (CQ-238's length)`, () => {
    expect(SESSION_DAYS).toBe(30);
    const times = /started_at and last_seen_at (\S+), expires_at (\S+?),/.exec(note);
    const started = Date.parse(times?.[1] ?? "");
    const expires = Date.parse(times?.[2] ?? "");
    expect(Number.isFinite(started) && Number.isFinite(expires)).toBe(true);
    expect((expires - started) / DAY_MS).toBe(SESSION_DAYS);
  });
});

describe("the card's files hold no token, no hash of one, no real number and no email but example.com's (rule 9)", () => {
  // The files T-1302 writes or changes, the seed sets' tests among them.
  const CARD_FILES = [
    "db/seeds/check-tester.ts",
    "db/seeds/check-tester.test.ts",
    "db/seeds/check-tester.int.test.ts",
    "db/seeds/lib/roster.ts",
    "db/seeds/lib/roster.test.ts",
    "db/seeds/lib/roster.int.test.ts",
    "db/seeds/staging-core.ts",
    "db/seeds/staging-core.int.test.ts",
    "db/seeds/skeleton.ts",
  ];
  // Written like a North American phone number (staging-core.int.test.ts's grep), and the fiction range 555-0100 to 0199.
  const PHONE_LIKE = /(?<![\w+])(?:\+?1[\s.-]?)?\(?[2-9][0-9]{2}\)?[\s.-]?[0-9]{3}[\s.-]?[0-9]{4}(?!\w)/g;
  const FICTIONAL = /^[2-9][0-9]{2}55501[0-9]{2}$/;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  // A key, a token or a hash of one: 32 or more hex characters in a row, or a run as long as a 32-byte base64url token
  // (43 characters) that mixes upper case, lower case and digits.
  const HEX_RUN = /[0-9a-fA-F]{32,}/g;
  const TOKEN_RUN = /[A-Za-z0-9_-]{43,}/g;
  const mixed = (run: string): boolean => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);

  it("every phone-like string is in the fiction range, every email address is example.com's, and no run looks like a key, a token or a hash", () => {
    const problems: string[] = [];
    for (const file of CARD_FILES) {
      const text = readFileSync(new URL(file, REPO), "utf8");
      for (const [match] of text.matchAll(PHONE_LIKE)) {
        const digits = match.replace(/[^0-9]/g, "");
        if (!FICTIONAL.test(digits.length === 11 ? digits.slice(1) : digits)) {
          problems.push(`${file}: a number outside the fiction range`);
        }
      }
      for (const [match] of text.matchAll(EMAIL)) {
        if (!match.endsWith("@example.com")) {
          problems.push(`${file}: an email address not at example.com`);
        }
      }
      if ([...text.matchAll(HEX_RUN)].length > 0) {
        problems.push(`${file}: a run of 32 or more hex characters`);
      }
      if ([...text.matchAll(TOKEN_RUN)].some(([run]) => mixed(run))) {
        problems.push(`${file}: a run shaped like a token`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("and the checks catch what they look for: a number outside the fiction range, another domain, a hash and a token", () => {
    // Built from parts, as staging-core.int.test.ts builds its samples: area code 555 serves no one.
    const number = ["+1", "555", "123", "4567"].join("");
    const address = ["someone", "elsewhere.test"].join("@");
    expect([...number.matchAll(PHONE_LIKE)]).toHaveLength(1);
    expect(FICTIONAL.test(number.slice(2))).toBe(false);
    expect([...address.matchAll(EMAIL)].map(([match]) => match)).toEqual([address]);
    expect([...standInHash().matchAll(HEX_RUN)]).toHaveLength(1);
    const token = `Ab1${"x".repeat(40)}`;
    expect([...token.matchAll(TOKEN_RUN)].some(([run]) => mixed(run))).toBe(true);
  });
});
