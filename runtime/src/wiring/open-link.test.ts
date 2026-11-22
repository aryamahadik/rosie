// T-1534's unit proofs for staging's openLink (./open-link.ts; S1-10 slice card S10-8; K-09 README defaults 211 to 213;
// T-728's security note e), over doubles of its reads, with the handler and the root's join as they are:
//   - a made code of a live link opens setupIdCheck with only K-21 v1's allowed fields (openLink.response, by Ajv) and
//     idUpload alone: the code's sha256 asks the link, then S1-10's keys, then the business's name, one read at a time;
//   - a code not in its made form (the K-21 fixtures' placeholders among them) answers linkExpired with no hash and no
//     read; an unknown made code answers linkExpired after the link's read alone;
//   - the keys port answering "given" (a double) makes a live link answer linkExpired, with nothing more read;
//   - proof only from a session of the link's own person; another person's session, or an unknown one, is proof none;
//   - a request that is not openLink's, a live link of another kind and a business with no name give no outcome (503),
//     each with nothing more read; the request checks agree with Ajv's verdict on K-21 v1's openLink.request;
//   - staging's reads: each on the runtime side, on a client of its own, ended before the next opens; the keys port reads
//     nothing; bound on staging with HYPERDRIVE_JOB only; the root joins openLink on staging only;
//   - nothing logs the code, its hash, a token, a person or the path: no line of the handler's own, and the page entry's
//     span holds labels alone.
// The database end to end is ./open-link.worker.test.ts's. Test values only (rule 9): made-up codes, tokens and ids, and
// the K-21 fixtures' placeholders.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "@rosie/actions/src/domain/proof-codes/index";
import openLinkExpired from "@rosie/contracts/page-api/fixtures/open-link-expired.json";
import openLinkSecurePage from "@rosie/contracts/page-api/fixtures/open-link-secure-page.json";
import openLinkSignedIn from "@rosie/contracts/page-api/fixtures/open-link-signed-in.json";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Sql } from "@rosie/db/repo/scope";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { DEFAULT_BUNDLE_ID } from "../gateway/answer";
import {
  handlePageCall,
  PageNotConnectedError,
  unconfiguredPages,
  type PageOutcome,
  type PageRequest,
} from "../gateway/pages";
import { openTrace } from "../trace";
import {
  isMadeCode,
  KEYS_NOT_GIVEN,
  LINK_EXPIRED,
  OPEN_LINK_CALLS,
  OpenLinkError,
  openLinkPage,
  openLinkProblems,
  stagingOpenLink,
  stagingOpenLinkReads,
  type LiveLink,
  type OpenLinkInputs,
} from "./open-link";
import { composeRoot } from "./root";
import type { StagingDb, StagingEnv } from "./staging/part";

// ---- K-21 v1, by Ajv (Node only) ---------------------------------------------------------------------------------------

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const PAGE_API = "https://rosie.invalid/contracts/page-api/page-api.v1.schema.json";

/** Every schema file under contracts/ (node_modules and generated left out), as the contract check loads them. */
function schemaFiles(relative = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(`${CONTRACTS}${relative}`, { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "generated")
      found.push(...schemaFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".schema.json")) found.push(child);
  }
  return found;
}

let ajv: Ajv2020 | undefined;

/** K-21 v1's problems with `value` against `$defs/<definition>`; empty when it accepts it. */
function k21Problems(definition: string, value: unknown): string[] {
  if (ajv === undefined) {
    // The contract check's own settings (contracts/scripts/lib.mjs createAjv).
    const made = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    for (const file of schemaFiles())
      made.addSchema(JSON.parse(readFileSync(`${CONTRACTS}${file}`, "utf8")) as object);
    ajv = made;
  }
  const validate = ajv.getSchema(`${PAGE_API}#/$defs/${definition}`);
  if (validate === undefined) throw new Error(`K-21 v1 has no definition ${definition}`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

// ---- made-up values ---------------------------------------------------------------------------------------------------

/** A code in its made form (default 211: 32 lowercase hex), made up. */
const CODE = "5f0c1e2d3b4a69788796a5b4c3d2e1f0";
/** A session token in K-21's opaqueToken form, made up. */
const TOKEN = "t1534-made-up-session-token-0001";
const OWNER = "person-t1534-owner";
const STRANGER = "person-t1534-stranger";
const BUSINESS = "biz-t1534-barbershop";
const EXPIRES = "2026-11-29T14:20:00Z";

const LIVE: LiveLink = {
  businessId: BUSINESS,
  personId: OWNER,
  purpose: "setup_id_check",
  stepId: "S1-10",
  expiresAt: EXPIRES,
};

/** The answer a live link opens with, before proof: K-21's allowed fields and nothing more (default 212 (5)). */
const OPEN_NO_PROOF = {
  result: "open",
  pageKind: "setupIdCheck",
  stepId: "S1-10",
  businessName: "Lee's Barbershop",
  proof: "none",
  acting: null,
  securePageOnly: false,
  sections: ["idUpload"],
  signIn: { ways: ["text", "email"] },
  expiresAt: EXPIRES,
} as const;

/** Every value no line, span or error may hold, beside the code's and the token's hashes (added at the start). */
const SECRETS: string[] = [CODE, TOKEN, OWNER, STRANGER, BUSINESS];

// ---- the reads, as a double ---------------------------------------------------------------------------------------------

type ReadName = keyof OpenLinkInputs;

interface ReadsDouble {
  readonly inputs: OpenLinkInputs;
  /** Each read asked, in order, with what it was handed. */
  readonly asked: [ReadName, string, string][];
  /** The most reads in flight at once. */
  readonly peak: () => number;
}

interface ReadsAnswers {
  readonly link?: LiveLink | null;
  readonly keysGiven?: boolean;
  readonly sessionPerson?: string | null;
  readonly businessName?: string | null;
  readonly throwing?: ReadName;
}

/** The four reads, each answering after a turn of the event loop, counting how many run at once. */
function readsDouble(answers: ReadsAnswers = {}): ReadsDouble {
  const asked: [ReadName, string, string][] = [];
  let running = 0;
  let most = 0;
  const read =
    <T>(name: ReadName, answer: T) =>
    async (value: string, traceId: string): Promise<T> => {
      asked.push([name, value, traceId]);
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 0));
      running -= 1;
      if (answers.throwing === name)
        throw new DataAccessDatabaseError(OPEN_LINK_CALLS.pageLinkForCode, "08006", null, null);
      return answer;
    };
  return {
    inputs: {
      link: read("link", answers.link === undefined ? LIVE : answers.link),
      keysGiven: read("keysGiven", answers.keysGiven ?? false),
      sessionPerson: read(
        "sessionPerson",
        answers.sessionPerson === undefined ? OWNER : answers.sessionPerson,
      ),
      businessName: read(
        "businessName",
        answers.businessName === undefined ? "Lee's Barbershop" : answers.businessName,
      ),
    },
    asked,
    peak: () => most,
  };
}

/** An openLink request: K-21's linkPage envelope with the code and the token given. */
function requestOf(linkCode: string, sessionToken: string | null = null): Record<string, unknown> {
  return { page: { requestId: "req-t1534-open-1", traceId: "trace-t1534-page-1", sessionToken, linkCode } };
}

/** A page call as the page entry hands it on, on a trace of its own (its spans kept). */
function pageOf(request: Readonly<Record<string, unknown>>): PageRequest {
  return {
    call: "openLink",
    request,
    trace: openTrace({
      openedBy: "pageRequest",
      bundleId: DEFAULT_BUNDLE_ID,
      incomingTraceId: null,
      sink: () => undefined,
    }),
    environment: "staging",
  };
}

// ---- what the whole file captures --------------------------------------------------------------------------------------

const LINES: string[] = [];
let digests: MockInstance | null = null;

beforeEach(async () => {
  if (SECRETS.length === 5) SECRETS.push(await sha256Hex(CODE), await sha256Hex(TOKEN));
  const keep = (...args: unknown[]): void => {
    LINES.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation(keep);
  digests = vi.spyOn(crypto.subtle, "digest");
});

afterEach(() => {
  vi.restoreAllMocks();
  digests = null;
});

/** How many hashes were made since the test began. */
const hashesMade = (): number => digests?.mock.calls.length ?? 0;

// ---- the handler ---------------------------------------------------------------------------------------------------------

describe("a made code of a live link opens setupIdCheck with only K-21's allowed fields and idUpload alone", () => {
  it("answers the page before proof: exactly default 212 (5)'s fields, accepted by K-21 v1's openLink.response", async () => {
    const reads = readsDouble();
    const page = pageOf(requestOf(CODE));
    const answer = await openLinkPage(reads.inputs)(page);

    expect(answer).toEqual(OPEN_NO_PROOF);
    expect(Object.keys(answer)).toEqual([
      "result",
      "pageKind",
      "stepId",
      "businessName",
      "proof",
      "acting",
      "securePageOnly",
      "sections",
      "signIn",
      "expiresAt",
    ]);
    expect(k21Problems("openLink.response", answer)).toEqual([]);
    expect(k21Problems("openLink.request", page.request)).toEqual([]);
  });

  it("asks the link by the code's sha256, then S1-10's keys for its person, then its business's name: one read at a time, on the page's trace", async () => {
    const reads = readsDouble();
    const page = pageOf(requestOf(CODE));
    await openLinkPage(reads.inputs)(page);
    const traceId = page.trace.traceId;

    expect(reads.asked).toEqual([
      ["link", await sha256Hex(CODE), traceId],
      ["keysGiven", OWNER, traceId],
      ["businessName", BUSINESS, traceId],
    ]);
    expect(reads.asked[0]?.[1]).toMatch(/^[0-9a-f]{64}$/u);
    expect(reads.peak()).toBe(1);
  });

  it("acts for the session's person only when that person is the link's own: proof session, acting, no sign-in offer", async () => {
    const reads = readsDouble({ sessionPerson: OWNER });
    const page = pageOf(requestOf(CODE, TOKEN));
    const answer = await openLinkPage(reads.inputs)(page);

    expect(answer).toEqual({ ...OPEN_NO_PROOF, proof: "session", acting: { personId: OWNER }, signIn: null });
    expect(k21Problems("openLink.response", answer)).toEqual([]);
    expect(reads.asked.map(([name]) => name)).toEqual(["link", "keysGiven", "sessionPerson", "businessName"]);
    expect(reads.asked[2]?.[1]).toBe(await sha256Hex(TOKEN));
    expect(reads.peak()).toBe(1);
  });

  it.each([
    ["another person's session", STRANGER],
    ["a session token no live session holds", null],
  ])(
    "is proof none with %s: the same answer as with no session, acting for no one",
    async (_what, person) => {
      const reads = readsDouble({ sessionPerson: person });
      const answer = await openLinkPage(reads.inputs)(pageOf(requestOf(CODE, TOKEN)));

      expect(answer).toEqual(OPEN_NO_PROOF);
      expect(k21Problems("openLink.response", answer)).toEqual([]);
    },
  );

  it("never takes the link as the proof: with no session, the session read is never made", async () => {
    const reads = readsDouble({ sessionPerson: OWNER });
    await openLinkPage(reads.inputs)(pageOf(requestOf(CODE)));
    expect(reads.asked.map(([name]) => name)).not.toContain("sessionPerson");
  });
});

describe("a code not in its made form answers the constant expired page with no hash and no read", () => {
  it.each([
    ["open-link-secure-page.json's placeholder", openLinkSecurePage.request.page.linkCode],
    ["open-link-signed-in.json's placeholder", openLinkSignedIn.request.page.linkCode],
    ["open-link-expired.json's placeholder", openLinkExpired.request.page.linkCode],
    ["upper-case hex", CODE.toUpperCase()],
    ["31 hex characters", CODE.slice(1)],
    ["33 hex characters", `${CODE}0`],
    ["a dash inside", `${CODE.slice(0, 16)}-${CODE.slice(17)}`],
    ["the master's sample", "s01"],
    ["64 hex characters", `${CODE}${CODE}`],
  ])("%s: linkExpired, nothing hashed or read", async (_what, linkCode) => {
    const reads = readsDouble();
    const request = requestOf(linkCode);
    expect(k21Problems("openLink.request", request)).toEqual([]);
    expect(isMadeCode(linkCode)).toBe(false);

    const answer = await openLinkPage(reads.inputs)(pageOf(request));

    expect(answer).toEqual({ error: "linkExpired" });
    expect(answer).toBe(LINK_EXPIRED);
    expect(k21Problems("openLink.errors", answer)).toEqual([]);
    expect(reads.asked).toEqual([]);
    expect(hashesMade()).toBe(0);
  });

  it("holds the fixtures' own requests to it: their codes are no made code, so they never open a page here", async () => {
    for (const fixture of [openLinkSecurePage, openLinkSignedIn, openLinkExpired]) {
      const reads = readsDouble();
      expect(await openLinkPage(reads.inputs)(pageOf(fixture.request))).toEqual({ error: "linkExpired" });
      expect(reads.asked).toEqual([]);
    }
    expect(hashesMade()).toBe(0);
  });
});

describe("an unknown made code answers linkExpired; the keys port answering given makes a live link answer linkExpired", () => {
  it("an unknown made code (no live link: unknown, lapsed or ended alike): linkExpired after the link's read alone", async () => {
    const reads = readsDouble({ link: null });
    const answer = await openLinkPage(reads.inputs)(pageOf(requestOf(CODE, TOKEN)));

    expect(answer).toEqual({ error: "linkExpired" });
    expect(reads.asked.map(([name]) => name)).toEqual(["link"]);
  });

  it("a live link whose S1-10 keys are all given (the port's double answers given): linkExpired, with no session or name read", async () => {
    const reads = readsDouble({ keysGiven: true });
    const answer = await openLinkPage(reads.inputs)(pageOf(requestOf(CODE, TOKEN)));

    expect(answer).toEqual({ error: "linkExpired" });
    expect(reads.asked.map(([name, value]) => [name, value])).toEqual([
      ["link", await sha256Hex(CODE)],
      ["keysGiven", OWNER],
    ]);
  });

  it("staging's binding of the keys port answers not given and reads nothing", async () => {
    expect(await KEYS_NOT_GIVEN(OWNER, "trace-t1534-page-1")).toBe(false);
  });
});

describe("no outcome (the page entry answers 503), each with nothing more read", () => {
  it.each([
    ["no page", {}],
    ["a field K-21 does not name", { ...requestOf(CODE), personId: OWNER }],
    ["a page field K-21 does not name", { page: { ...(requestOf(CODE).page as object), proof: "session" } }],
    ["no code", { page: { requestId: "req-1", traceId: "trace-1", sessionToken: null } }],
    ["a null code", { page: { requestId: "r", traceId: "t", sessionToken: null, linkCode: null } }],
    ["a code K-21's pattern refuses", requestOf("bad_code")],
    ["a session token too short", requestOf(CODE, "short")],
    ["an empty request id", { page: { requestId: "", traceId: "t", sessionToken: null, linkCode: CODE } }],
  ])(
    "a request that is not openLink's (%s): OpenLinkError badRequest, no hash, no read",
    async (_what, request) => {
      const reads = readsDouble();
      expect(k21Problems("openLink.request", request)).not.toEqual([]);
      expect(openLinkProblems(request)).not.toEqual([]);

      const answered = openLinkPage(reads.inputs)(pageOf(request));

      await expect(answered).rejects.toThrow(OpenLinkError);
      await expect(answered).rejects.toMatchObject({ name: "OpenLinkError", reason: "badRequest" });
      expect(reads.asked).toEqual([]);
      expect(hashesMade()).toBe(0);
    },
  );

  it("agrees with Ajv on K-21 v1's openLink.request for every request this file sends", () => {
    for (const request of [
      requestOf(CODE),
      requestOf(CODE, TOKEN),
      requestOf("abc"),
      requestOf("ab"),
      requestOf(`${CODE}${CODE}0`),
      requestOf(CODE, "x".repeat(513)),
      requestOf(CODE, "\u{1F600}".repeat(16)),
      openLinkSecurePage.request,
      openLinkSignedIn.request,
    ])
      expect(openLinkProblems(request).length === 0, JSON.stringify(request)).toBe(
        k21Problems("openLink.request", request).length === 0,
      );
  });

  it("a live link of a kind this slice does not serve (S1-77's owner_confirm): OpenLinkError pageNotServed, nothing more read", async () => {
    const reads = readsDouble({ link: { ...LIVE, purpose: "owner_confirm", stepId: "S1-77" } });
    await expect(openLinkPage(reads.inputs)(pageOf(requestOf(CODE, TOKEN)))).rejects.toMatchObject({
      reason: "pageNotServed",
    });
    expect(reads.asked.map(([name]) => name)).toEqual(["link"]);
  });

  it("a business with no public name: OpenLinkError noBusinessName", async () => {
    const reads = readsDouble({ businessName: null });
    await expect(openLinkPage(reads.inputs)(pageOf(requestOf(CODE)))).rejects.toMatchObject({
      reason: "noBusinessName",
    });
  });

  it.each<ReadName>(["link", "sessionPerson", "businessName"])(
    "a %s read that throws: the handler rejects with it, and nothing after it is read",
    async (throwing) => {
      const reads = readsDouble({ throwing });
      await expect(openLinkPage(reads.inputs)(pageOf(requestOf(CODE, TOKEN)))).rejects.toBeInstanceOf(
        DataAccessDatabaseError,
      );
      expect(reads.asked.at(-1)?.[0]).toBe(throwing);
    },
  );
});

describe("nothing logs the code, its hash, a token, a person or the path", () => {
  it("the handler writes no line of its own, and its errors name no value", async () => {
    const errors: unknown[] = [];
    for (const answers of [
      {},
      { link: null },
      { keysGiven: true },
      { businessName: null },
    ] as ReadsAnswers[]) {
      const reads = readsDouble(answers);
      await openLinkPage(reads.inputs)(pageOf(requestOf(CODE, TOKEN))).catch((error: unknown) => {
        errors.push(error);
      });
    }
    for (const request of [{ page: { linkCode: CODE } }, requestOf(CODE, "short")])
      await openLinkPage(readsDouble().inputs)(pageOf(request)).catch((error: unknown) => {
        errors.push(error);
      });
    expect(LINES).toEqual([]);
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      const shown = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const secret of SECRETS) expect(shown, secret).not.toContain(secret);
    }
  });

  it("through the page entry, the span and every line hold labels alone: no code, hash, token, person, business or path", async () => {
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    for (const [code, token] of [
      [CODE, TOKEN],
      [CODE, null],
      ["s01-placeholder-sam", TOKEN],
    ] as const) {
      const reads = readsDouble();
      const response = await handlePageCall(
        new Request(`https://rosfield.com/test/page-api/openLink`, {
          method: "POST",
          body: JSON.stringify(requestOf(code, token)),
          headers: { "content-type": "application/json" },
        }),
        "openLink",
        {
          handlers: { ...unconfiguredPages(), openLink: openLinkPage(reads.inputs) },
          bundleId: () => DEFAULT_BUNDLE_ID,
        },
        { environment: "staging", version: "test-sha" },
      );
      expect(response.status).toBe(200);
    }
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    for (const secret of [...SECRETS, "s01-placeholder-sam", "/test/"])
      expect(all, secret).not.toContain(secret);
  });
});

// ---- staging's reads -------------------------------------------------------------------------------------------------------

interface DbDouble {
  readonly db: StagingDb;
  /** Each call: its name, side, trace id, the statement's text and its values. */
  readonly calls: {
    name: string;
    side: string;
    traceId: string | null | undefined;
    text: string;
    values: unknown[];
  }[];
  readonly peak: () => number;
}

/** A handle whose each call runs its code on a statement double answering `rows(name)`, counting calls at once. */
function dbDouble(rows: (name: string) => unknown[] | Error): DbDouble {
  const calls: DbDouble["calls"] = [];
  let running = 0;
  let most = 0;
  const run =
    (side: string) =>
    async <T>(name: string, fn: (sql: Sql) => Promise<T>, traceId?: string | null): Promise<T> => {
      running += 1;
      most = Math.max(most, running);
      try {
        const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          calls.push({ name, side, traceId, text: strings.join("$").replace(/\s+/gu, " ").trim(), values });
          const answer = rows(name);
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        }) as unknown as Sql;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return await fn(sql);
      } finally {
        running -= 1;
      }
    };
  return {
    db: {
      runtime: run("runtime"),
      toolApi: run("toolApi"),
      counts: () => ({
        opened: 0,
        ended: 0,
        connectionsOpen: 0,
        connectionsPeak: 0,
        quietReads: 0,
        quietWrites: 0,
      }),
    },
    calls,
    peak: () => most,
  };
}

/** A PostgreSQL error as postgres.js throws one, its message and detail holding values that must never leave. */
function postgresError(code: string): Error {
  const error = new Error(`dummy message naming ${CODE}`) as Error & { code: string; detail: string };
  error.name = "PostgresError";
  error.code = code;
  error.detail = `detail ${OWNER}`;
  return error;
}

describe("staging's reads: each on the runtime side, on a client of its own, ended before the next opens", () => {
  const ROWS: Record<string, unknown[]> = {
    pageLinkForCode: [
      {
        business_id: BUSINESS,
        person_id: OWNER,
        purpose: "setup_id_check",
        step_id: "S1-10",
        expires_at: new Date(EXPIRES),
      },
    ],
    sessionForToken: [{ person_id: OWNER }],
    businessName: [{ display_name: "Lee's Barbershop", name: "Lee's" }],
  };

  it("opens a live link through all four reads in default 212's order, each a runtime-side call on the page's trace, one at a time", async () => {
    const made = dbDouble((name) => ROWS[name] ?? []);
    const page = pageOf(requestOf(CODE, TOKEN));
    const answer = await openLinkPage(stagingOpenLinkReads(made.db))(page);

    expect(answer).toEqual({ ...OPEN_NO_PROOF, proof: "session", acting: { personId: OWNER }, signIn: null });
    expect(made.calls.map(({ name, side, traceId }) => [name, side, traceId])).toEqual([
      [OPEN_LINK_CALLS.pageLinkForCode, "runtime", page.trace.traceId],
      [OPEN_LINK_CALLS.sessionForToken, "runtime", page.trace.traceId],
      [OPEN_LINK_CALLS.businessName, "runtime", page.trace.traceId],
    ]);
    expect(made.peak()).toBe(1);
    expect(made.calls[0]?.text).toBe(
      "select business_id, person_id, purpose, step_id, expires_at from page_link_for_code($, now())",
    );
    expect(made.calls[0]?.values).toEqual([await sha256Hex(CODE)]);
    expect(made.calls[1]?.text).toBe("select person_id from session_for_token($, now())");
    expect(made.calls[1]?.values).toEqual([await sha256Hex(TOKEN)]);
    expect(made.calls[2]?.text).toBe("select display_name, name from businesses where id = $");
    expect(made.calls[2]?.values).toEqual([BUSINESS]);
    // No statement holds the code or the token itself.
    expect(JSON.stringify(made.calls)).not.toContain(CODE);
    expect(JSON.stringify(made.calls)).not.toContain(TOKEN);
  });

  it("binds S1-10's keys to not given, so no read is made for them", () => {
    expect(stagingOpenLinkReads(dbDouble(() => []).db).keysGiven).toBe(KEYS_NOT_GIVEN);
  });

  it("gives the link's end in UTC ending in Z, and none for no row", async () => {
    const reads = stagingOpenLinkReads(
      dbDouble((name) => (name === OPEN_LINK_CALLS.pageLinkForCode ? (ROWS[name] ?? []) : [])).db,
    );
    expect(await reads.link("a".repeat(64), "trace-1")).toEqual(LIVE);
    const none = stagingOpenLinkReads(dbDouble(() => []).db);
    expect(await none.link("a".repeat(64), "trace-1")).toBeNull();
    expect(await none.sessionPerson("b".repeat(64), "trace-1")).toBeNull();
    expect(await none.businessName(BUSINESS, "trace-1")).toBeNull();
  });

  it.each([
    [{ display_name: "Lee's Barbershop", name: "Lee's" }, "Lee's Barbershop"],
    [{ display_name: "", name: "Lee's" }, "Lee's"],
    [{ display_name: "   ", name: "Lee's" }, "Lee's"],
    [{ display_name: "", name: " " }, null],
  ])("names the business by its display name, else its name (%j)", async (row, name) => {
    const reads = stagingOpenLinkReads(dbDouble(() => [row]).db);
    expect(await reads.businessName(BUSINESS, "trace-1")).toBe(name);
  });

  it("scrubs a read's failure to its call's name and SQLSTATE: no message, detail, code, hash or person leaves", async () => {
    const reads = stagingOpenLinkReads(dbDouble(() => postgresError("57P01")).db);
    const failed = await reads.link(await sha256Hex(CODE), "trace-1").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(DataAccessDatabaseError);
    expect(failed).toMatchObject({ call: OPEN_LINK_CALLS.pageLinkForCode, code: "57P01" });
    const shown = `${(failed as Error).message} ${JSON.stringify(failed)}`;
    for (const secret of SECRETS) expect(shown, secret).not.toContain(secret);
  });
});

describe("bound on staging with HYPERDRIVE_JOB only, and joined by the root on staging only", () => {
  /** An env that records every name read from it. */
  function envOf(values: Record<string, unknown>): { env: StagingEnv; names: string[] } {
    const names: string[] = [];
    const env = new Proxy(values, {
      get(target, name, receiver): unknown {
        if (typeof name === "string") names.push(name);
        return Reflect.get(target, name, receiver);
      },
    });
    return { env: env as unknown as StagingEnv, names };
  }

  it("binds staging's reads where ENVIRONMENT is staging and HYPERDRIVE_JOB is bound, reading nothing else and calling nothing", () => {
    const made = dbDouble(() => []);
    const { env, names } = envOf({ ENVIRONMENT: "staging", HYPERDRIVE_JOB: {} });
    expect(stagingOpenLink({ env, db: made.db })).not.toBeNull();
    expect(names).toEqual(["ENVIRONMENT", "HYPERDRIVE_JOB"]);
    expect(made.calls).toEqual([]);
  });

  it("binds none in production (no binding read) or on staging with no HYPERDRIVE_JOB", () => {
    const made = dbDouble(() => []);
    const production = envOf({ ENVIRONMENT: "production", HYPERDRIVE_JOB: {} });
    expect(stagingOpenLink({ env: production.env, db: made.db })).toBeNull();
    expect(production.names).toEqual(["ENVIRONMENT"]);
    expect(stagingOpenLink({ env: envOf({ ENVIRONMENT: "staging" }).env, db: made.db })).toBeNull();
  });

  const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };

  it("joins openLink into the page entry on staging, over the reads it is handed", async () => {
    const reads = readsDouble();
    const root = composeRoot({ environment: "staging", actors: null, vars: VARS, openLink: reads.inputs });
    const answer: PageOutcome | undefined = await root.gateway.pages?.openLink(pageOf(requestOf(CODE)));
    expect(answer).toEqual(OPEN_NO_PROOF);
    // Nothing else is joined for it: the upload and the email code stay unconfigured (D4, D5).
    for (const call of ["signedUpload", "finishUpload", "codeStart", "codeCheck"] as const)
      await expect(root.gateway.pages?.[call](pageOf({}))).rejects.toBeInstanceOf(PageNotConnectedError);
  });

  it("leaves openLink unconfigured with no reads, and anywhere but staging whatever it is handed", () => {
    const reads = readsDouble();
    const none = composeRoot({ environment: "staging", actors: null, vars: VARS, openLink: null });
    expect(none.gateway.pages).toBeUndefined();
    const production = composeRoot({
      environment: "production",
      actors: null,
      vars: { ENVIRONMENT: "production", GIT_SHA: "test-sha" },
      openLink: reads.inputs,
    });
    expect(production.gateway.pages).toBeUndefined();
    expect(reads.asked).toEqual([]);
  });
});
