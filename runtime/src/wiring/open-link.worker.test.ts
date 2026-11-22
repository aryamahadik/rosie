// T-1534 (S1-10 slice card S10-8; K-09 README defaults 211 to 213): staging serves a signed link's page, inside the Workers
// runtime, through the Worker's own routes (createWorker over a root built as workerRoot builds the Worker's: composeRoot
// over stagingOptions and ./open-link.ts stagingOpenLink, on one T-1254 handle), every call through the pool's Hyperdrive
// bindings, and web's real route lists (ROUTES = linkRoutes()).
//
// The database: this file has none of its own (infra/test-rig/files.mjs names none for it), so it reads T-1398's (key
// TOOL_API_GATE: migrated, bundle v0 active, seeded by ./staging/tool-api-gate.seed.ts, Lee's Barbershop and Sam among
// it) through that file's pair, as ./staging/keyword-door.worker.test.ts does. It commits nothing there: the one live link
// a case needs is inserted inside a transaction of its own that is always rolled back (and the case reads afterwards that
// no row of it stays), and every other case only reads. The rows it reads are that seed's and made-up hashes no row holds,
// so what that file reads and counts is never changed by this one.
//
//   - the route serves the page on staging's reads: a made code no link holds asks page_link_for_code once, on the runtime
//     side, and answers web's expired page (410), with each client ended and connectionsPeak at most 2 (it is 1); a code
//     not in its made form (a K-21 fixture's placeholder) answers the same page with no openLink read at all;
//   - a live link (inside the rolled-back transaction) opens S1-10's honest page on staging's SQL: "Secure ID upload",
//     "For Lee's Barbershop", idUpload's name, the two lines and the sign-in offer; the handler's answer is K-21's
//     fields alone; a session token no live session holds is proof none; the keys port answering given (a double) makes
//     that live link answer linkExpired; each read one at a time;
//   - each read alone on the real handle: the business's display name, no session for an unknown hash, no link for an
//     unknown hash, each on a client of its own;
//   - the addresses T-1534 moved to two segments still answer the Worker's 404;
//   - no line holds the code, its hash, a token or its hash, and no rejection is left unhandled.
// No test here fetches outside the Worker: the pool's outbound tripwire (T-1411) would fail one that did. Test values only
// (rule 9): made-up codes, tokens and ids, and the gate's seed's demo business and person.
import { sha256Hex } from "@rosie/actions/src/domain/proof-codes/index";
import openLinkSecurePage from "@rosie/contracts/page-api/fixtures/open-link-secure-page.json";
import type { Sql } from "@rosie/db/repo/scope";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { DEFAULT_BUNDLE_ID } from "../gateway/answer";
import type { PageRequest } from "../gateway/pages";
import { createWorker } from "../index";
import { openTrace } from "../trace";
import {
  LINK_EXPIRED,
  OPEN_LINK_CALLS,
  openLinkPage,
  stagingOpenLink,
  stagingOpenLinkReads,
  type OpenLinkInputs,
} from "./open-link";
import { composeRoot, type Root } from "./root";
import { stagingOptions } from "./staging/options";
import { stagingDb, type StagingDb, type StagingEnv } from "./staging/part";
import { BARBERSHOP, SAM } from "./staging/tool-api-gate.seed";

/** The database this file reads: T-1398's, by its key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "TOOL_API_GATE";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
const DATABASE = inject("rosieRigDatabases")?.[KEY];
/** A run through the Workers runtime's own steps and PostgreSQL: a resource guard above the project's default. */
const TEST_MS = 60_000;

/** A made code (default 211's form: 32 lowercase hex) that no row of this database holds, made up. */
const UNKNOWN_CODE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
/** The made code of the one live link a case inserts inside its rolled-back transaction, made up. */
const LIVE_CODE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** That link's row id (default 211's id form), made up, and never committed. */
const LIVE_LINK_ID = "link-s1-10-t1534-worker-1";
/** A session token in K-21's form that no session of this database holds, made up. */
const TOKEN = "t1534-worker-session-token-0001";

const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

// ---- what this file's isolate wrote and rejected ---------------------------------------------------------------------

const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** Every line written on the console and by a handle while this file's tests ran, and the running test's own. */
const everyLine: string[] = [];
let lines: string[] = [];
/** Every handle a test made: checked after each test. */
const HANDLES: StagingDb[] = [];

beforeEach(() => {
  lines = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    lines.push(line);
    everyLine.push(line);
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(keep);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended, its sockets with it.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
});

type Json = Record<string, unknown>;

/** The JSON lines among `written` whose msg is `msg`. */
function jsonLinesOf(written: readonly string[], msg: string): Json[] {
  const found: Json[] = [];
  for (const line of written) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === "object" && value !== null && (value as { msg?: unknown }).msg === msg)
      found.push(value as Json);
  }
  return found;
}

// ---- the env and the Worker ------------------------------------------------------------------------------------------

/** Staging's env as wrangler.jsonc's vars give it, over the gate's database pair. */
function stagingEnv(): StagingEnv {
  return {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    LINK_HOST: "rosfield.com",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
  };
}

/** The root's handle over `env` (its timing lines go to the console, which the file keeps), checked after the test. */
function handleOver(env: StagingEnv): StagingDb {
  const db = stagingDb(env);
  HANDLES.push(db);
  return db;
}

/** A root as workerRoot builds the Worker's on staging (stagingOptions and stagingOpenLink on one handle). */
function deployedRoot(env: StagingEnv, db: StagingDb): Root {
  return composeRoot({
    environment: "staging",
    actors: null,
    vars: env,
    ...stagingOptions(env, { db }),
    openLink: stagingOpenLink({ env, db }),
  });
}

/** A root on staging whose openLink reads are `reads`, and nothing else bound. */
function rootOver(env: StagingEnv, reads: OpenLinkInputs): Root {
  return composeRoot({ environment: "staging", actors: null, vars: env, openLink: reads });
}

/** A GET of `path` through the Worker over `root`, with its context run to its end. */
async function get(
  root: Root,
  env: StagingEnv,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const worker = createWorker(() => root.gateway);
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://rosfield.com${path}`, { headers }), env, context);
  const text = await response.text();
  await waitOnExecutionContext(context);
  return { status: response.status, text };
}

/** The dbCall lines of the running test whose call is one of openLink's reads. */
function openLinkReads(): Json[] {
  const names = new Set<unknown>(Object.values(OPEN_LINK_CALLS));
  return jsonLinesOf(lines, "dbCall").filter((line) => names.has(line.call));
}

/** A page call as the page entry hands it on, on a trace of its own. */
function pageOf(linkCode: string, sessionToken: string | null = null): PageRequest {
  return {
    call: "openLink",
    request: {
      page: { requestId: "req-t1534-worker-1", traceId: "trace-t1534-worker-1", sessionToken, linkCode },
    },
    trace: openTrace({
      openedBy: "pageRequest",
      bundleId: DEFAULT_BUNDLE_ID,
      incomingTraceId: null,
      sink: () => undefined,
    }),
    environment: "staging",
  };
}

/** web's expired page and S1-10's honest page, by the words they hold (web/src/link/pages.ts, kinds.ts). */
const EXPIRED_TITLE = "<h1>This link has expired</h1>";
const HONEST = [
  "<h1>Secure ID upload</h1>",
  "<p>For Lee&#39;s Barbershop</p>",
  "<li>Upload a photo of an ID document</li>",
  "<p>The ID upload is not open yet.</p>",
  "<p>Nothing goes live until your ID is uploaded.</p>",
  "<h2>Sign in to open this page</h2>",
];

/** Values no line may hold: the codes, the token and their hashes. */
async function secrets(): Promise<string[]> {
  return [
    UNKNOWN_CODE,
    LIVE_CODE,
    TOKEN,
    await sha256Hex(UNKNOWN_CODE),
    await sha256Hex(LIVE_CODE),
    await sha256Hex(TOKEN),
  ];
}

describe("the rig's database", () => {
  it("is T-1398's, whose pair this file reads", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[a-z0-9_]+_tool_api_gate$/u);
  });
});

describe("the route serves a link's page on staging's reads", () => {
  it(
    "a made code no link holds: page_link_for_code once on the runtime side, web's expired page (410), every client ended, connectionsPeak at most 2",
    async () => {
      const env = stagingEnv();
      const db = handleOver(env);
      const root = deployedRoot(env, db);

      const page = await get(root, env, `/test/${UNKNOWN_CODE}`);

      expect(page.status).toBe(410);
      expect(page.text).toContain(EXPIRED_TITLE);
      expect(openLinkReads().map((line) => [line.call, line.side, line.binding])).toEqual([
        [OPEN_LINK_CALLS.pageLinkForCode, "runtime", "HYPERDRIVE_JOB"],
      ]);
      const counts = db.counts();
      expect(counts.ended).toBe(counts.opened);
      expect(counts.connectionsPeak).toBeLessThanOrEqual(2);
      expect(counts.connectionsPeak).toBe(1);
      // The page entry's span and the shell's line: labels alone.
      expect(jsonLinesOf(lines, "page")).toMatchObject([{ route: "link.open", status: 410 }]);
    },
    TEST_MS,
  );

  it(
    "a code not in its made form (open-link-secure-page.json's placeholder): the same expired page, with no openLink read at all",
    async () => {
      const env = stagingEnv();
      const db = handleOver(env);
      const root = deployedRoot(env, db);
      const expired = await get(root, env, `/test/${UNKNOWN_CODE}`);
      lines = [];

      const page = await get(root, env, `/test/${openLinkSecurePage.request.page.linkCode}`);

      expect(page.status).toBe(410);
      expect(page.text.replace(/[0-9a-f-]{36}/gu, "")).toBe(expired.text.replace(/[0-9a-f-]{36}/gu, ""));
      expect(openLinkReads()).toEqual([]);
    },
    TEST_MS,
  );

  it(
    "the addresses T-1534 moved to two segments still answer the Worker's 404, with no openLink read",
    async () => {
      const env = stagingEnv();
      const db = handleOver(env);
      const root = deployedRoot(env, db);
      for (const path of ["/test/unknown/page", "/test/v1/page-api", "/test/dummy-unknown-address/page"]) {
        const page = await get(root, env, path);
        expect(page.status, path).toBe(404);
        expect(JSON.parse(page.text), path).toMatchObject({ ok: false, error: "not_found" });
      }
      expect(openLinkReads()).toEqual([]);
    },
    TEST_MS,
  );
});

// ---- a live link, inside a transaction that is always rolled back ---------------------------------------------------------

/** Thrown to roll the case's transaction back: nothing it inserted is ever committed. */
class RolledBack extends Error {
  override name = "RolledBack";
}

/** A handle whose every runtime-side call runs on the case's transaction `tx`, counted; the Tool API is never reached. */
function onTransaction(tx: Sql): { db: StagingDb; calls: string[]; peak: () => number } {
  const calls: string[] = [];
  let running = 0;
  let most = 0;
  const db: StagingDb = {
    async runtime<T>(call: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
      calls.push(call);
      running += 1;
      most = Math.max(most, running);
      try {
        return await fn(tx);
      } finally {
        running -= 1;
      }
    },
    toolApi: () => Promise.reject(new Error("openLink reads nothing on the Tool API's side")),
    counts: () => ({
      opened: 0,
      ended: 0,
      connectionsOpen: 0,
      connectionsPeak: 0,
      quietReads: 0,
      quietWrites: 0,
    }),
  };
  return { db, calls, peak: () => most };
}

describe("a live link opens S1-10's honest page on staging's SQL (inside a rolled-back transaction)", () => {
  it(
    "the page, the handler's answer, proof none for an unknown session, linkExpired once the keys port answers given; nothing stays",
    async () => {
      const env = stagingEnv();
      const db = handleOver(env);
      const seen: {
        page?: { status: number; text: string };
        given?: { status: number; text: string };
        answer?: unknown;
        expiresAt?: string;
        calls?: string[];
        peak?: number;
      } = {};

      await db
        .runtime("t1534LiveLink", (sql) =>
          sql.begin(async (tx) => {
            const inserted = await tx<{ expires_at: Date }[]>`
              insert into page_links (
                id, business_id, person_id, purpose, step_id, code_sha256, sent_to_handle_id, issued_at, expires_at
              ) values (
                ${LIVE_LINK_ID}, ${BARBERSHOP}, ${SAM.personId}, 'setup_id_check', 'S1-10',
                ${await sha256Hex(LIVE_CODE)}, ${SAM.handleId}, now(), now() + interval '7 days'
              )
              returning expires_at
            `;
            const [row] = inserted;
            if (row === undefined) throw new Error("the case's link row was not inserted");
            // K-21's utc as the read gives it: whole seconds without their fraction.
            seen.expiresAt = row.expires_at.toISOString().replace(/\.000Z$/u, "Z");
            const made = onTransaction(tx as unknown as Sql);
            const reads = stagingOpenLinkReads(made.db);

            seen.answer = await openLinkPage(reads)(pageOf(LIVE_CODE, TOKEN));
            seen.page = await get(rootOver(env, reads), env, `/test/${LIVE_CODE}`);
            seen.given = await get(
              rootOver(env, { ...reads, keysGiven: () => Promise.resolve(true) }),
              env,
              `/test/${LIVE_CODE}`,
            );
            seen.calls = made.calls;
            seen.peak = made.peak();
            throw new RolledBack("always rolled back");
          }),
        )
        .catch((error: unknown) => {
          if (!(error instanceof RolledBack)) throw error;
        });

      expect(seen.answer).toEqual({
        result: "open",
        pageKind: "setupIdCheck",
        stepId: "S1-10",
        businessName: "Lee's Barbershop",
        proof: "none",
        acting: null,
        securePageOnly: false,
        sections: ["idUpload"],
        signIn: { ways: ["text", "email"] },
        expiresAt: seen.expiresAt,
      });
      expect(seen.page?.status).toBe(200);
      for (const words of HONEST) expect(seen.page?.text, words).toContain(words);
      expect(seen.page?.text).toContain(`href="/test/sign-in?link=${LIVE_CODE}"`);
      for (const absent of ["<form", "<input", "<script", "The owner&#39;s email", "S1-10", "person-"])
        expect(seen.page?.text, absent).not.toContain(absent);
      expect(seen.given?.status).toBe(410);
      expect(seen.given?.text).toContain(EXPIRED_TITLE);
      // The handler's call: link, session, name; the page: link, name; the given case: link alone. One at a time.
      expect(seen.calls).toEqual([
        OPEN_LINK_CALLS.pageLinkForCode,
        OPEN_LINK_CALLS.sessionForToken,
        OPEN_LINK_CALLS.businessName,
        OPEN_LINK_CALLS.pageLinkForCode,
        OPEN_LINK_CALLS.businessName,
        OPEN_LINK_CALLS.pageLinkForCode,
      ]);
      expect(seen.peak).toBe(1);

      // Nothing of the case stays: the link row was never committed.
      const left = await db.runtime(
        "t1534LinkLeft",
        (sql) => sql<{ n: number }[]>`select count(*)::int as n from page_links where id = ${LIVE_LINK_ID}`,
      );
      expect(left[0]?.n).toBe(0);
      expect(
        await stagingOpenLinkReads(db).link(await sha256Hex(LIVE_CODE), "trace-t1534-worker-1"),
      ).toBeNull();
    },
    TEST_MS,
  );
});

describe("each read alone on the real handle: one client each, ended before the next", () => {
  it(
    "the business's display name, no session for an unknown token's hash, no link for an unknown code's hash",
    async () => {
      const env = stagingEnv();
      const db = handleOver(env);
      const reads = stagingOpenLinkReads(db);
      const traceId = crypto.randomUUID();

      expect(await reads.businessName(BARBERSHOP, traceId)).toBe("Lee's Barbershop");
      expect(await reads.sessionPerson(await sha256Hex(TOKEN), traceId)).toBeNull();
      expect(await reads.link(await sha256Hex(UNKNOWN_CODE), traceId)).toBeNull();
      expect(await reads.keysGiven(SAM.personId, traceId)).toBe(false);

      const counts = db.counts();
      expect(counts.opened).toBe(3);
      expect(counts.ended).toBe(3);
      expect(counts.connectionsPeak).toBe(1);
      expect(openLinkReads().map((line) => [line.call, line.side, line.login, line.trace_id])).toEqual([
        [OPEN_LINK_CALLS.businessName, "runtime", "rosie_worker_job", traceId],
        [OPEN_LINK_CALLS.sessionForToken, "runtime", "rosie_worker_job", traceId],
        [OPEN_LINK_CALLS.pageLinkForCode, "runtime", "rosie_worker_job", traceId],
      ]);
      // The pair's Tool API side is never asked for: no line names HYPERDRIVE_APP.
      expect(jsonLinesOf(lines, "dbCall").some((line) => line.binding === "HYPERDRIVE_APP")).toBe(false);
      expect(LINK_EXPIRED).toEqual({ error: "linkExpired" });
    },
    TEST_MS,
  );
});

describe("what this file wrote", () => {
  it("holds no code, hash or token in any line, and left no rejection unhandled", async () => {
    const all = everyLine.join("\n");
    for (const secret of await secrets()) expect(all, secret).not.toContain(secret);
    expect(rejections).toEqual([]);
  });
});
