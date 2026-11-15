// T-1289 (ADR-016 card D): staging binds the sign-in calls (./sign-in.ts, ../sign-in.ts, ../root.ts), inside the Workers
// runtime on T-1253's rig (infra/test-rig/files.mjs, key SIGN_IN): this file's own database, migrated, with bundle v0
// active and the accounts and listings ./sign-in.seed.ts writes, reached through its own pool pair, HYPERDRIVE_JOB_SIGN_IN
// and HYPERDRIVE_APP_SIGN_IN, handed in as the env's HYPERDRIVE_JOB and HYPERDRIVE_APP. Each root is built as the
// Worker's is (../root.ts workerRoot: composeRoot over stagingOptions(env)); the end-to-end roots keep the parts the
// sign-in's path runs through (the send's outbox and send-state calls, the test-phone part's line and standing, the
// email part over a Resend double that reaches no network, and the turn part's bundle reads, so the page entry names
// the active bundle the code row is written under) and stand every other part in by its nothing-bound answer (DL-776);
// a case that counts what stagingOptions read stands every part but the email port unbound.
//
//   - on staging, K-21 v1's sign-in-request.json answers started, its code's send and ADR-016 section 2's dispatch are
//     handed to the request's waitUntil and run after the answer, and the email port gets one code, to Sam's proven
//     address, through Resend (his inbox is listed), on the page call's trace; the stored hash is the HMAC under the
//     env's PROOF_CODE_HASH_KEY; the right code answers signedIn as a tester, and that token passes testPhoneSend's
//     admission until signOut ends it; each call on its own side's client (ADR-014);
//   - through the web shell's own sign-in form, the page's in-process call hands the code's send to the page request's
//     waitUntil (runtime/src/index.ts);
//   - a link's start answers started and sends nothing;
//   - with PROOF_CODE_HASH_KEY missing (unset, empty, not base64, too short) signInStart and signInCheck answer 503 with
//     nothing written, and one line names the key alone; signOut never reads it;
//   - the part reads nothing at build and is bound only beside the email port (DL-768); with no Hyperdrive binding, and
//     in production, the three calls answer 503 (notConnected), the key never read;
//   - no span or log line holds a code, a token, the key, an address, a device token, an attempt id or a hash.
// Test values only (rule 9): the contracts' fixtures, made-up keys, tokens and ids, addresses on reserved domains, and no
// phone number at all.
import { RESEND_EMAILS_URL } from "@rosie/adapters/email/resend-send";
import { codeHashOf, hmacSha256Hash } from "@rosie/actions/src/domain/proof-codes/index";
import signInRequestJson from "@rosie/contracts/page-api/fixtures/sign-in-request.json";
import signOutJson from "@rosie/contracts/page-api/fixtures/sign-out.json";
import testPhoneSendJson from "@rosie/contracts/page-api/fixtures/test-phone-send.json";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { ASSISTANT_LINE, CODE_SUBJECT, ROSIE_FROM_ADDRESS, type EmailRowsDeps } from "../../email";
import { pagePathOf, type PageCallName } from "../../gateway";
import { createWorker } from "../../index";
import { composeRoot, environmentOf, workerRoot, type Root } from "../index";
import { dbHandle, type DbHandle } from "./db";
import { stagingEmail } from "./email";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS, stagingTurnCalls } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { PROOF_CODE_HASH_KEY, SIGN_IN_CALLS, signInKeyLine, stagingSignIn } from "./sign-in";
import { SAM, SEEDED_ROWS, TESTER_ONE } from "./sign-in.seed";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "SIGN_IN";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
const DATABASE = inject("rosieRigDatabases")?.[KEY];

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

/** A made-up hashing key: 32 bytes counting up from 0x41, as base64. Never a key of anything. */
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => 0x41 + index);
const MADE_UP_KEY = btoa(String.fromCharCode(...KEY_BYTES));
/** A made-up send-only key, and Resend's id for an email it took, made up. */
const MADE_UP_SEND_KEY = "t1289-made-up-send-only-key-0001";
const RESEND_ID = "t1289-resend-email-0001";

/** sign-in-request.json's device: the cookie a check must come from too (K-21 README line 117). */
const SAM_DEVICE = signInRequestJson.request.deviceToken;
/** A roster id the roster's list holds, whose handle no row of this database holds: admitted, then notTestPhone. */
const UNSEEDED_PHONE = "tp-02";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/u;
const ATTEMPT_ID = /^attempt-[A-Za-z0-9_-]{22}$/u;

// ---- what the whole file captures: every log line, every span, and every value none of them may hold ---------------

/** Every line written to the console or as a call's timing, across the file, and the lines of the test that runs. */
const LOGGED: string[] = [];
let testLog: string[] = [];

/** Codes, tokens, attempt ids: each value a test met that no line may hold, beside the file's own below. */
const MET: string[] = [];

/** Every unhandled rejection this isolate reports while this file runs. */
const rejections: unknown[] = [];
addEventListener("unhandledrejection", (event) => {
  rejections.push(event.reason);
});

/** The JSON lines among some lines whose `msg` is this one, in order. */
function jsonLinesOf(lines: readonly string[], msg: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === "object" && value !== null && (value as { msg?: unknown }).msg === msg) {
      found.push(value as Record<string, unknown>);
    }
  }
  return found;
}

/** The spans of the file's log on one trace, in order. */
const spansOn = (traceId: string): Record<string, unknown>[] =>
  jsonLinesOf(LOGGED, "span").filter((span) => span.trace_id === traceId);

beforeEach(() => {
  testLog = [];
  const keep = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
    testLog.push(line);
    LOGGED.push(line);
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

/** Every handle a test made: each client a call opened is ended. */
const HANDLES: Pick<DbHandle, "counts">[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
});

// ---- the env a root is built over -------------------------------------------------------------------------------------

interface TestEnv {
  readonly env: StagingEnv;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
}

/**
 * Staging's env as wrangler.jsonc's vars give it, with this file's pair, the pool's test-phone line, the made-up hashing
 * and send-only keys, and the named inboxes (Sam's and tester one's), each read counted; `changes` laid over them
 * (undefined: the name is not in the env at all).
 */
function envOf(changes: Record<string, unknown> = {}): TestEnv {
  const names: string[] = [];
  const values: Record<string, unknown> = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    LINK_HOST: "rosfield.com",
    HYPERDRIVE_JOB: poolBinding(JOB),
    HYPERDRIVE_APP: poolBinding(APP),
    TEST_PHONE_LINE: poolEnv.TEST_PHONE_LINE,
    PROOF_CODE_HASH_KEY: MADE_UP_KEY,
    RESEND_API_KEY: MADE_UP_SEND_KEY,
    STAGING_TEST_INBOXES: `${SAM.address},${TESTER_ONE.address}`,
  };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(values, name);
    else values[name] = value;
  }
  const env = new Proxy(values, {
    get(target, name, receiver): unknown {
      if (typeof name === "string") names.push(name);
      return Reflect.get(target, name, receiver);
    },
    has(target, name): boolean {
      if (typeof name === "string") names.push(name);
      return Reflect.has(target, name);
    },
  });
  return { env: env as unknown as StagingEnv, names };
}

/** How often the env was asked for a name. */
const readsOf = (testEnv: TestEnv, name: string): number =>
  testEnv.names.filter((read) => read === name).length;

// ---- the order things happened in ----------------------------------------------------------------------------------------

/** One count shared by the file: an answer's arrival and each send take the next number, so their order can be read. */
let ticks = 0;
const tick = (): number => {
  ticks += 1;
  return ticks;
};

// ---- Resend, as a double that keeps each request and reaches no network ------------------------------------------------

/** One request Resend's send call got: what of it a test reads, and when (`tick`). */
interface ResendCall {
  readonly at: number;
  readonly url: string;
  readonly method: string;
  readonly keyed: boolean;
  readonly body: {
    readonly from: string;
    readonly to: string[];
    readonly subject: string;
    readonly text: string;
  };
}

interface ResendDouble {
  readonly calls: ResendCall[];
  readonly fetch: (request: Request) => Promise<Response>;
}

function resendDouble(): ResendDouble {
  const calls: ResendCall[] = [];
  return {
    calls,
    async fetch(request) {
      calls.push({
        at: tick(),
        url: request.url,
        method: request.method,
        keyed: request.headers.get("Authorization") === `Bearer ${MADE_UP_SEND_KEY}`,
        body: await request.json<ResendCall["body"]>(),
      });
      return new Response(JSON.stringify({ id: RESEND_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** The six digits of the code in a code email's text: kept, so no line may hold them. */
function codeIn(text: string): string {
  const found = /Code ([0-9]{6}): type it on the sign-in page\. It works for 10 minutes\./u.exec(text);
  const code = found?.[1];
  if (code === undefined) throw new Error("the email holds no code");
  MET.push(code);
  return code;
}

// ---- the roots ----------------------------------------------------------------------------------------------------------

/**
 * Every part off the sign-in's path, stood in by its nothing-bound answer (DL-776). The turn part keeps its bundle reads
 * alone (T-1395, its own builder's): the page entry reads the active bundle at receipt, and the code's email row names
 * that bundle (T-1282's default 6; K-04 outbox_rows_bundle_fk), as on staging.
 */
const OFF_THE_PATH: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  turn: (part) => ({ ...NO_TURN_CALL_INPUTS, bundleReads: stagingTurnCalls(part).bundleReads }),
  models: () => NO_MODEL_READER_INPUTS,
  bundleSafety: () => null,
  gate: () => null,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  flags: () => null,
  copies: () => null,
};

/** Every part but this card's stood in unbound, the email port and the test-phone part's line with them (DL-776). */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  ...OFF_THE_PATH,
  turn: () => NO_TURN_CALL_INPUTS,
  send: () => NO_SEND_INPUTS,
  testPhone: () => null,
  email: () => null,
};

/** The Worker's vars where the page calls run: staging's, as wrangler.jsonc sets them. */
const WORKER_VARS = {
  ENVIRONMENT: "staging",
  BASE_PATH: "/test",
  DB_SCHEMA: "",
  GIT_SHA: "test-sha",
  LINK_HOST: "rosfield.com",
} as unknown as Cloudflare.Env;

/**
 * One page call's answer: when it reached the caller (`tick`, taken as the Worker's answer arrives), its status, its
 * outcome, its trace id, and the page entry's span on that trace.
 */
interface Answer {
  readonly answeredAt: number;
  readonly status: number;
  readonly outcome: Record<string, unknown>;
  readonly traceId: string;
  readonly span: Record<string, unknown> | undefined;
}

/** A page call's POST as the page sends it, with its JSON body and its trace id. */
function pagePost(path: string, body: unknown, traceId: string): Request {
  return new Request(`https://rosie.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trace-id": traceId },
    body: JSON.stringify(body),
  });
}

/** The page calls through the Worker's own route, {BASE_PATH}/page-api/<call>, to the gateway `gateway` gives. */
function pagesOf(
  gateway: () => Root["gateway"],
  vars: Cloudflare.Env = WORKER_VARS,
): (call: PageCallName, request: unknown, context?: ExecutionContext) => Promise<Answer> {
  const worker = createWorker(
    () => gateway(),
    () => null,
  );
  return async (call, request, context = createExecutionContext()) => {
    const traceId = crypto.randomUUID();
    const response = await Promise.resolve(
      worker.fetch(pagePost(`${vars.BASE_PATH}${pagePathOf(call)}`, request, traceId), vars, context),
    );
    const answeredAt = tick();
    const outcome = await response.json<Record<string, unknown>>();
    return {
      answeredAt,
      status: response.status,
      outcome,
      traceId,
      span: spansOn(traceId).find((span) => span.hop === "pageRequest"),
    };
  };
}

interface Staged {
  readonly root: Root;
  readonly inputs: StagingInputs;
  readonly resend: ResendDouble;
  readonly page: (call: PageCallName, request: unknown, context?: ExecutionContext) => Promise<Answer>;
}

/**
 * A root built as workerRoot builds the Worker's, over the test's env: the sign-in's path bound by each part's own
 * builder (the send's calls, the test-phone part, this card's part), the email part's own over the Resend double, and
 * every other part stood in unbound; and its page calls through the Worker's route.
 */
function staged(testEnv: TestEnv): Staged {
  const resend = resendDouble();
  const db = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
  HANDLES.push(db);
  const inputs = stagingOptions(testEnv.env, {
    db,
    builders: { ...OFF_THE_PATH, email: (part) => stagingEmail(part, { fetch: resend.fetch }) },
  });
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    ...inputs,
  });
  return { root, inputs, resend, page: pagesOf(() => root.gateway) };
}

/** A context whose waitUntil keeps each promise it is handed, then hands it to the pool's own context. */
function recordingContext(): {
  context: ExecutionContext;
  handed: Promise<unknown>[];
  done: () => Promise<void>;
} {
  const ctx = createExecutionContext();
  const handed: Promise<unknown>[] = [];
  const context = {
    waitUntil: (work: Promise<unknown>) => {
      handed.push(work);
      ctx.waitUntil(work);
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return { context, handed, done: () => waitOnExecutionContext(ctx) };
}

// ---- the page's requests ------------------------------------------------------------------------------------------------

const envelope = (requestId: string, sessionToken: string | null = null, linkCode: string | null = null) => ({
  requestId,
  traceId: `trace-${requestId}`,
  sessionToken,
  linkCode,
});

/** K-21 v1 signInCheck's request for an attempt, a code as typed and a device. */
function checkRequest(attemptId: string, code: string | null, device: string, requestId: string) {
  return { page: envelope(requestId), attemptId, code, deviceToken: device };
}

/** K-21 v1 test-phone-send.json's request under a session token, for a roster id. */
function sendRequest(sessionToken: string | null, testPhoneId: string): Record<string, unknown> {
  const { request } = testPhoneSendJson;
  return { ...request, page: { ...request.page, sessionToken }, testPhoneId };
}

/** K-21 v1 sign-out.json's request under a session token. */
function signOutRequest(sessionToken: string, requestId: string): Record<string, unknown> {
  return { page: { ...signOutJson.request.page, requestId, sessionToken } };
}

/** A text value of an outcome, or a broken test. */
function textOf(outcome: Record<string, unknown>, field: string): string {
  const value = outcome[field];
  if (typeof value !== "string") throw new Error(`the outcome's ${field} is not text`);
  return value;
}

// ---- the database -------------------------------------------------------------------------------------------------------

/** A handle of the test's own on this file's job binding (T-1254's), for a read of its own. */
function ownHandle(): DbHandle {
  const handle = dbHandle({ ENVIRONMENT: "staging", DB_SCHEMA: "", HYPERDRIVE_JOB: poolBinding(JOB) });
  HANDLES.push(handle);
  return handle;
}

type Counts = Record<keyof typeof SEEDED_ROWS | "event_log", number>;

/** The row count of each table the sign-in calls write, in this file's database (rosie_job sees every row). */
async function counts(): Promise<Counts> {
  const rows = await ownHandle().runtime(
    "t1289Counts",
    (sql) => sql<Counts[]>`
      select (select count(*) from sign_in_attempts)::int as sign_in_attempts,
             (select count(*) from proof_codes)::int as proof_codes,
             (select count(*) from sessions)::int as sessions,
             (select count(*) from outbox_rows)::int as outbox_rows,
             (select count(*) from outbox_parts)::int as outbox_parts,
             (select count(*) from event_log)::int as event_log`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error("the row counts were not read");
  return { ...row };
}

/** The code rows to one email handle, newest first: the row's state, its turn and job, and its code's stored hash. */
async function codeRowsTo(handleId: string): Promise<
  {
    state: string;
    turn_id: string | null;
    has_job: boolean;
    email_purpose: string | null;
    code_hash: string;
    hash_key_name: string;
  }[]
> {
  return ownHandle().runtime(
    "t1289CodeRows",
    (sql) => sql<
      {
        state: string;
        turn_id: string | null;
        has_job: boolean;
        email_purpose: string | null;
        code_hash: string;
        hash_key_name: string;
      }[]
    >`
      select o.state, o.turn_id, o.job_id is not null as has_job, o.email_purpose, p.code_hash, p.hash_key_name
      from outbox_rows o
      join sign_in_attempts a on a.id = o.job_id
      join proof_codes p on p.id = a.proof_code_id
      where o.recipient_handle_id = ${handleId}
      order by o.commit_seq desc`,
  );
}

/** The non-null inputs of what stagingOptions gave, by name. */
const boundOf = (inputs: StagingInputs): string[] =>
  Object.entries(inputs)
    .filter(([, input]) => input !== null)
    .map(([name]) => name)
    .sort();

/** An email port that is never called here: the email part's stand-in, so the sign-in part has a way out. */
const EMAIL_STAND_IN: EmailRowsDeps = {
  port: { sendEmail: () => Promise.reject(new Error("no email is sent here")) },
  fromAddress: ROSIE_FROM_ADDRESS,
};

/** A handle that reaches no database: a builder makes no call. */
const NO_DB: StagingDb = {
  runtime: () => Promise.reject(new Error("a builder made a database call")),
  toolApi: () => Promise.reject(new Error("a builder made a database call")),
  counts: () => ({
    opened: 0,
    ended: 0,
    connectionsOpen: 0,
    connectionsPeak: 0,
    quietReads: 0,
    quietWrites: 0,
  }),
};

// ---- the rig ------------------------------------------------------------------------------------------------------------

describe("this file's database on the rig", () => {
  it("is this run's own, seeded with Sam's and the testers' accounts and nothing a call wrote", async () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_sign_in$/u);
    const now = await counts();
    expect({ ...now, event_log: 0 }).toEqual({ ...SEEDED_ROWS, event_log: 0 });
  });
});

// ---- end to end ---------------------------------------------------------------------------------------------------------

describe("on staging, the three calls through the Worker's page entry (ADR-016 card D)", () => {
  it("sign-in-request.json answers started; after the answer its code's send and the dispatch run in the request's waitUntil and the email port gets one code; the right code answers signedIn; that token passes testPhoneSend's admission until signOut ends it", async () => {
    const testEnv = envOf();
    const run = staged(testEnv);
    const before = await counts();
    const start = recordingContext();

    const started = await run.page("signInStart", signInRequestJson.request, start.context);

    // The fixture's answer: started, by email, no ready text; the attempt id and its expiry are the server's.
    expect(started.status).toBe(200);
    expect(started.outcome).toEqual({
      ...signInRequestJson.outcome,
      attemptId: expect.stringMatching(ATTEMPT_ID) as string,
      expiresAt: expect.stringMatching(UTC_TEXT) as string,
    });
    const attemptId = textOf(started.outcome, "attemptId");
    MET.push(attemptId);
    const expiresIn = Date.parse(textOf(started.outcome, "expiresAt")) - Date.now();
    expect(expiresIn).toBeGreaterThan(9 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);
    // The code's send is handed to the request's waitUntil, once: the answer waited on nothing of it.
    expect(start.handed).toHaveLength(1);

    await start.done();

    // One code, to Sam's proven address, through Resend (his inbox is listed), in K-12 send-code.json's form, sent after
    // the answer had reached the caller.
    expect(run.resend.calls).toHaveLength(1);
    const [sent] = run.resend.calls;
    if (sent === undefined) throw new Error("no code was sent");
    expect(sent.at).toBeGreaterThan(started.answeredAt);
    expect(sent).toMatchObject({
      url: RESEND_EMAILS_URL,
      method: "POST",
      keyed: true,
      body: { from: `Rosie <${ROSIE_FROM_ADDRESS}>`, to: [SAM.address], subject: CODE_SUBJECT },
    });
    expect(sent.body.text.startsWith(ASSISTANT_LINE)).toBe(true);
    const code = codeIn(sent.body.text);
    // One attempt, one code, one email row with its part, and the code's three entries; the row sent, with no turn.
    expect(await counts()).toEqual({
      ...before,
      sign_in_attempts: before.sign_in_attempts + 1,
      proof_codes: before.proof_codes + 1,
      outbox_rows: before.outbox_rows + 1,
      outbox_parts: before.outbox_parts + 1,
      event_log: before.event_log + 3,
    });
    const [row] = await codeRowsTo(SAM.emailHandleId);
    expect(row).toMatchObject({ state: "sent", turn_id: null, has_job: true, email_purpose: "code" });
    // The hashing port is the env's PROOF_CODE_HASH_KEY, by name: the stored hash is the HMAC of the code under it.
    const keyed = await hmacSha256Hash(PROOF_CODE_HASH_KEY, KEY_BYTES);
    expect(row?.hash_key_name).toBe(PROOF_CODE_HASH_KEY);
    expect(row?.code_hash).toBe(await codeHashOf(keyed, code));
    // The dispatch ran on the page call's trace, which the code row carries: one trace id from the page to the send.
    expect(spansOn(started.traceId).map((span) => span.hop)).toContain("dispatch");
    expect(jsonLinesOf(LOGGED, "signInWakeFailed")).toEqual([]);

    // The right code, from the same device: signedIn, a tester (listed, on staging), the token in this answer alone.
    const check = recordingContext();
    const checked = await run.page(
      "signInCheck",
      checkRequest(attemptId, code, SAM_DEVICE, "req-t1289-check-1"),
      check.context,
    );
    expect(checked.outcome).toEqual({
      result: "signedIn",
      sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) as string,
      sessionExpiresAt: expect.stringMatching(UTC_TEXT) as string,
      person: { personId: SAM.personId, roles: [], team: false, tester: true },
    });
    const token = textOf(checked.outcome, "sessionToken");
    MET.push(token);
    // The check's entries go after the answer, in its waitUntil: the code's use and the session's start.
    expect(check.handed).toHaveLength(1);
    await check.done();
    expect(await counts()).toMatchObject({
      sessions: before.sessions + 1,
      event_log: before.event_log + 5,
    });

    // That token passes testPhoneSend's admission: past the standing to the roster, where tp-02 has no phone.
    const admitted = await run.page("testPhoneSend", sendRequest(token, UNSEEDED_PHONE));
    expect(admitted.outcome).toEqual({ error: "notTestPhone", testPhoneId: UNSEEDED_PHONE });
    // No token, or one no session holds, is refused at the standing.
    expect((await run.page("testPhoneSend", sendRequest(null, UNSEEDED_PHONE))).outcome).toEqual({
      error: "signInNeeded",
    });
    expect(
      (await run.page("testPhoneSend", sendRequest(`${"t1289-no-session-".repeat(2)}token`, UNSEEDED_PHONE)))
        .outcome,
    ).toEqual({ error: "signInNeeded" });

    // A second check of the same attempt: alreadySignedIn, no token.
    expect(
      (await run.page("signInCheck", checkRequest(attemptId, code, SAM_DEVICE, "req-t1289-check-2"))).outcome,
    ).toEqual({ result: "alreadySignedIn" });

    // signOut ends that session, its entry after the answer; the token is then refused at the standing.
    const out = recordingContext();
    const signedOut = await run.page("signOut", signOutRequest(token, "req-t1289-signout-1"), out.context);
    expect(signedOut.outcome).toEqual({ result: "signedOut", repeated: false });
    expect(out.handed).toHaveLength(1);
    await out.done();
    expect(await counts()).toMatchObject({ event_log: before.event_log + 6 });
    expect((await run.page("testPhoneSend", sendRequest(token, UNSEEDED_PHONE))).outcome).toEqual({
      error: "signInNeeded",
    });

    // No second code went anywhere.
    expect(run.resend.calls).toHaveLength(1);
  });

  it("runs each call on its own side's client (ADR-014): the start, the send, the recipient read, the standing and the entries as rosie_worker_job, the check and the sign-out as rosie_worker_app; the send's timing on the page call's trace", () => {
    const sides = (jsonLinesOf(LOGGED, "dbCall") as unknown as DbCallLine[]).filter((line) =>
      (Object.values(SIGN_IN_CALLS) as string[]).includes(String(line.call)),
    );
    const sideOf = (call: string): [string, string, string | null][] =>
      sides
        .filter((line) => line.call === call)
        .map((line) => [line.side, line.binding, line.login] as [string, string, string | null]);
    const job: [string, string, string | null] = ["runtime", "HYPERDRIVE_JOB", "rosie_worker_job"];
    const app: [string, string, string | null] = ["toolApi", "HYPERDRIVE_APP", "rosie_worker_app"];
    for (const call of [
      SIGN_IN_CALLS.startSignIn,
      SIGN_IN_CALLS.sendSignInCode,
      SIGN_IN_CALLS.sendState,
      SIGN_IN_CALLS.personStanding,
      SIGN_IN_CALLS.signInEntries,
    ]) {
      expect(sideOf(call).length, call).toBeGreaterThanOrEqual(1);
      for (const each of sideOf(call)) expect(each, call).toEqual(job);
    }
    for (const call of [SIGN_IN_CALLS.proveSignIn, SIGN_IN_CALLS.endSession]) {
      expect(sideOf(call).length, call).toBeGreaterThanOrEqual(1);
      for (const each of sideOf(call)) expect(each, call).toEqual(app);
    }
    // The send names the page call's trace; its timing line is on it.
    for (const line of sides.filter((each) => each.call === SIGN_IN_CALLS.sendSignInCode)) {
      expect(line.trace_id).toMatch(UUID);
    }
  });

  it("through the web shell's own sign-in form, the page's in-process signInStart hands the code's send to the page request's waitUntil: the code goes once that request's work is done", async () => {
    const testEnv = envOf();
    const run = staged(testEnv);
    const worker = createWorker(
      () => run.root.gateway,
      () => null,
    );
    const page = recordingContext();
    const traceId = crypto.randomUUID();

    const response = await Promise.resolve(
      worker.fetch(
        new Request("https://rosfield.com/test/sign-in", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://rosfield.com",
            "x-trace-id": traceId,
          },
          body: new URLSearchParams({
            requestId: "t1289-shell-start-0001",
            way: "email",
            account: TESTER_ONE.address,
          }).toString(),
        }),
        WORKER_VARS,
        page.context,
      ),
    );
    const answeredAt = tick();

    // The shell's next page, the code page; the page entry's span on the page request's own trace.
    expect(response.status).toBe(200);
    expect(spansOn(traceId).find((span) => span.hop === "pageRequest")).toMatchObject({
      got: { pageCall: "signInStart" },
      outcome: "ok",
    });
    // The page call's work after its answer went to the page request's own context, once.
    expect(page.handed).toHaveLength(1);

    await page.done();

    // The code went once the page had answered, kept alive by that page request's own waitUntil.
    expect(run.resend.calls.map((call) => call.body.to)).toEqual([[TESTER_ONE.address]]);
    const [sent] = run.resend.calls;
    if (sent === undefined) throw new Error("no code was sent");
    expect(sent.at).toBeGreaterThan(answeredAt);
    codeIn(sent.body.text);
    expect((await codeRowsTo(TESTER_ONE.emailHandleId))[0]).toMatchObject({ state: "sent", turn_id: null });
  });

  it("a link's start answers started and sends nothing: no code, no row, no work handed on, nothing to Resend", async () => {
    const testEnv = envOf();
    const run = staged(testEnv);
    const before = await counts();
    const start = recordingContext();
    const request = {
      ...signInRequestJson.request,
      page: envelope("req-t1289-link-1", null, "s01-placeholder-sam"),
      account: { from: "link" },
    };

    const started = await run.page("signInStart", request, start.context);
    await start.done();

    expect(started.outcome).toEqual({
      result: "started",
      attemptId: expect.stringMatching(ATTEMPT_ID) as string,
      way: "email",
      expiresAt: expect.stringMatching(UTC_TEXT) as string,
      readyText: null,
      textLink: null,
    });
    MET.push(textOf(started.outcome, "attemptId"));
    expect(start.handed).toEqual([]);
    expect(run.resend.calls).toEqual([]);
    // Its attempt alone: no person, so no code, no row and no entry.
    expect(await counts()).toEqual({ ...before, sign_in_attempts: before.sign_in_attempts + 1 });
    // The key was read by name once, at this call's start.
    expect(readsOf(testEnv, PROOF_CODE_HASH_KEY)).toBe(1);
  });
});

// ---- the key ------------------------------------------------------------------------------------------------------------

describe("PROOF_CODE_HASH_KEY, read by name at each call, never logged", () => {
  it.each([
    ["missing", undefined, "unset"],
    ["empty", "", "unset"],
    ["blank", "   ", "unset"],
    ["not base64", "t1289 not base64 at all!", "unreadable"],
    ["16 bytes, short of 32", btoa("t1289-sixteen-by"), "unreadable"],
  ] as const)(
    "%s: signInStart and signInCheck answer 503 with nothing written or counted, and one line names the key and why, and nothing else",
    async (_name, value, why) => {
      const testEnv = envOf({ PROOF_CODE_HASH_KEY: value });
      const run = staged(testEnv);
      const before = await counts();

      const started = await run.page("signInStart", signInRequestJson.request);
      const checked = await run.page(
        "signInCheck",
        checkRequest("attempt-t1289-none", "123456", SAM_DEVICE, "req-t1289-nokey-check"),
      );

      for (const answer of [started, checked]) {
        expect(answer.status).toBe(503);
        expect(answer.outcome).toEqual({ ok: false, error: "unavailable", trace_id: answer.traceId });
        expect(answer.span).toMatchObject({ outcome: "failed", error_code: "handlerFailed" });
        // The key's line on the call's trace: its name and why, and nothing else.
        expect(
          jsonLinesOf(testLog, "signInKeyMissing").filter((line) => line.trace_id === answer.traceId),
        ).toEqual([signInKeyLine(why, answer.traceId, testEnv.env)]);
        // The page entry's line names the handler's error alone (T-1282's and T-1285's noHashKey).
        expect(
          jsonLinesOf(testLog, "gateway_failed").filter((line) => line.trace_id === answer.traceId),
        ).toEqual([
          {
            level: "error",
            msg: "gateway_failed",
            trace_id: answer.traceId,
            stage: "pageHandler",
            error: "SignInError",
          },
        ]);
      }
      expect(await counts()).toEqual(before);
      expect(run.resend.calls).toEqual([]);
      expect(readsOf(testEnv, PROOF_CODE_HASH_KEY)).toBe(2);
      if (typeof value === "string" && value.trim() !== "") {
        for (const line of testLog) expect(line.includes(value), "a line holds the key's value").toBe(false);
      }
    },
  );

  it("signOut needs no key and never reads it: with none set, a sign-out of no session answers signedOut, repeated", async () => {
    const testEnv = envOf({ PROOF_CODE_HASH_KEY: undefined });
    const run = staged(testEnv);

    const answer = await run.page(
      "signOut",
      signOutRequest(`${"t1289-made-up-".repeat(2)}session-token`, "req-t1289-signout-none"),
    );

    expect(answer.outcome).toEqual({ result: "signedOut", repeated: true });
    expect(readsOf(testEnv, PROOF_CODE_HASH_KEY)).toBe(0);
    expect(jsonLinesOf(testLog, "signInKeyMissing")).toEqual([]);
  });
});

// ---- nothing bound stays closed -----------------------------------------------------------------------------------------

describe("the part (./sign-in.ts stagingSignIn) and its place in stagingOptions (DL-768, DL-776)", () => {
  it("with no email port it gives null, and with one its inputs; it reads nothing either way and makes no call", () => {
    const testEnv = envOf();

    expect(stagingSignIn({ env: testEnv.env, db: NO_DB, email: null })).toBeNull();
    const bound = stagingSignIn({ env: testEnv.env, db: NO_DB, email: EMAIL_STAND_IN });

    expect(Object.keys(bound ?? {}).sort()).toEqual(
      ["afterCheck", "check", "hash", "recipientOf", "send"].sort(),
    );
    expect(testEnv.names).toEqual([]);
  });

  it("through stagingOptions, every other part unbound: bound beside the email port alone, which it is handed, and null where none is; nothing read but ENVIRONMENT", () => {
    const testEnv = envOf();
    const handed: (EmailRowsDeps | null)[] = [];

    const bound = stagingOptions(testEnv.env, {
      db: NO_DB,
      builders: {
        ...EVERY_OTHER_PART_UNBOUND,
        email: () => EMAIL_STAND_IN,
        signIn: (part) => {
          handed.push(part.email);
          return stagingSignIn(part);
        },
      },
    });
    const unbound = stagingOptions(testEnv.env, { db: NO_DB, builders: EVERY_OTHER_PART_UNBOUND });

    expect(handed).toEqual([EMAIL_STAND_IN]);
    expect(boundOf(bound)).toEqual(["emailRows", "signIn"]);
    expect(unbound.signIn).toBeNull();
    expect(boundOf(unbound)).toEqual([]);
    expect(testEnv.names).toEqual(["ENVIRONMENT", "ENVIRONMENT"]);
  });

  it("on staging with no Hyperdrive binding, through the Worker's own root (every part's own builder): no line, no email port, no sign-in; the three calls answer 503 (notConnected) and the key is never read", async () => {
    const testEnv = envOf({ HYPERDRIVE_JOB: undefined, HYPERDRIVE_APP: undefined });

    const root = workerRoot(testEnv.env);

    expect(root.gateway.pages).toBeUndefined();
    const page = pagesOf(() => root.gateway);
    for (const [call, request] of [
      ["signInStart", signInRequestJson.request],
      ["signInCheck", checkRequest("attempt-t1289-none", "123456", SAM_DEVICE, "req-t1289-unbound")],
      ["signOut", signOutRequest(`${"t1289-made-up-".repeat(2)}token`, "req-t1289-unbound-out")],
    ] as const) {
      const answer = await page(call, request);
      expect(answer.status, call).toBe(503);
      expect(answer.span, call).toMatchObject({ outcome: "failed", error_code: "notConnected" });
    }
    expect(readsOf(testEnv, PROOF_CODE_HASH_KEY)).toBe(0);
    expect(testEnv.names.filter((name) => name.endsWith("_KEY") || name.includes("INBOXES"))).toEqual([]);
  });

  it("production: stagingOptions gives no input, and through the Worker's own root signInStart answers 503 (notConnected) with no binding or key read", async () => {
    const testEnv = envOf({ ENVIRONMENT: "production" });

    expect(stagingOptions(testEnv.env, { db: NO_DB })).toBe(NO_STAGING_INPUTS);
    const root = workerRoot(testEnv.env);
    expect(root.gateway.pages).toBeUndefined();
    const page = pagesOf(() => root.gateway, { ...WORKER_VARS, ENVIRONMENT: "production", BASE_PATH: "" });
    for (const [call, request] of [
      ["signInStart", signInRequestJson.request],
      ["signInCheck", checkRequest("attempt-t1289-none", "123456", SAM_DEVICE, "req-t1289-prod")],
      ["signOut", signOutRequest(`${"t1289-made-up-".repeat(2)}token`, "req-t1289-prod-out")],
    ] as const) {
      const answer = await page(call, request);
      expect(answer.status, call).toBe(503);
      expect(answer.span, call).toMatchObject({ outcome: "failed", error_code: "notConnected" });
    }
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect(readsOf(testEnv, PROOF_CODE_HASH_KEY)).toBe(0);
  });
});

// ---- nothing leaks ------------------------------------------------------------------------------------------------------

describe("the span and log capture of every test above", () => {
  it("holds no code, token, key, address, device token or attempt id, and no hash of the key; no unhandled rejection", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The capture is not empty: the page entry's spans, the dispatch's, and every call's timing line are in it.
    expect(jsonLinesOf(LOGGED, "span").length).toBeGreaterThanOrEqual(20);
    expect(jsonLinesOf(LOGGED, "dbCall").length).toBeGreaterThanOrEqual(10);
    expect(MET.length).toBeGreaterThanOrEqual(5);
    const forbidden = [
      ...MET,
      MADE_UP_KEY,
      MADE_UP_SEND_KEY,
      SAM.address,
      TESTER_ONE.address,
      SAM_DEVICE,
      signInRequestJson.request.account.typed,
    ];
    for (const value of forbidden) {
      expect(
        LOGGED.filter((line) => line.includes(value)),
        "a log line holds a value it must not",
      ).toEqual([]);
    }
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
