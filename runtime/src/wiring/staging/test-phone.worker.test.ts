// T-1305 (the D-017 path audit's P6b): staging binds RootOptions.testPhone (./test-phone.ts) over K-05 v1.12 items 53 to 55
// (item 53 as v1.15's item 68 widens it) and the roster's one list, through the job handle only (DL-557), inside the
// Workers runtime on T-1253's rig (infra/test-rig/files.mjs, key TEST_PHONE): this file's own database, migrated, with
// bundle v0 active and the rows ./test-phone.seed.ts lists (each roster phone in one state, each session in one standing),
// reached through its own pool pair only, HYPERDRIVE_JOB_TEST_PHONE and HYPERDRIVE_APP_TEST_PHONE, handed in as the env's
// HYPERDRIVE_JOB and HYPERDRIVE_APP behind doubles that count each read of a connection string. Each root here is built as
// the Worker's is (../root.ts workerRoot: composeRoot over stagingOptions(env)), through stagingOptions' two seams: its
// handle (./part.ts stagingDb), so a test reads T-1254's counts and each call's timing line, and its builders, every part
// but this card's stood in by its nothing-bound answer, so a test sees this card's binding alone whatever the other parts
// bind (DL-776). The root is handed the skeleton flag on and a made-up webhook secret, so testPhoneSend's signed text
// reaches the root's Linq route; nothing else. The one case through workerRoot itself, every part's own builder with it,
// asserts on this card's reads and answers alone.
//
//   - the mapping on each accepted fixture's own answer, as the README's bindings line maps it: the standing across
//     unchanged, a roster phone as { testPhoneId, number, email } or null, a phone row field by field and no row as a
//     chat closed and not stopped, the chat link in K-09 v1 issueChatLink's form (its two fixtures' links exactly), and
//     ROSIE_NUMBER checked as E.164 (DL-581: missing and each malformed form answer chatLink null); transient thrown;
//   - the three ports by direct call through the root's inputs: every fixture whose rows this file holds answers its own
//     outcome through db/repo's read, and the binding maps it; one job-side client per read;
//   - the page's two calls through the Worker's page entry: a tester (the check tester's team row, a human tester's
//     listing), a non-tester and no session; tp-01's number with no email and no phone row; tp-02 with no handle and an id
//     off the list (notTestPhone, nothing signed or posted); a stopped phone with its parts and its email; a START after a
//     STOP; an open chat with a chat link, with and without ROSIE_NUMBER and with each malformed value; testPhoneSend's
//     signed text verified by the root's Linq route;
//   - a transient answer gives 503: the phone read's connection cut under it on this database, and each read's transient
//     answer through a handle double; bound but failing (the guard's refusal, a database that is not there, DB_SCHEMA set)
//     gives 503 with nothing identifying; unbound (no HYPERDRIVE_JOB, no TEST_PHONE_LINE) and production;
//   - the build reads nothing but ENVIRONMENT and HYPERDRIVE_JOB's presence (DL-768); ROSIE_NUMBER and TEST_PHONE_LINE are
//     read at the calls that need them;
//   - HYPERDRIVE_APP is read 0 times throughout, opened equals ended after every test, no row count moves, and the span
//     and log capture holds no token, hash, number, email, short code, ready text or chat link's address.
// Test values only (rule 9): the contracts' fixtures, made-up tokens and ids, example.com addresses, and whole fiction-range
// numbers: the roster list's own and Rosie's made-up number below.
import testPhonePartsJson from "@rosie/contracts/page-api/fixtures/test-phone-parts.json";
import testPhoneSendJson from "@rosie/contracts/page-api/fixtures/test-phone-send.json";
import fixtureIndex from "@rosie/contracts/data-access/fixtures/index.json";
import phoneChatLink from "@rosie/contracts/data-access/fixtures/read-phone-state-chat-link.json";
import phoneChatOpen from "@rosie/contracts/data-access/fixtures/read-phone-state-chat-open.json";
import phoneNoRow from "@rosie/contracts/data-access/fixtures/read-phone-state-no-row.json";
import phoneStartedAgain from "@rosie/contracts/data-access/fixtures/read-phone-state-started-again.json";
import phoneStopped from "@rosie/contracts/data-access/fixtures/read-phone-state-stopped.json";
import rosterEmailOnFile from "@rosie/contracts/data-access/fixtures/read-roster-phone-email-on-file.json";
import rosterNotAPhone from "@rosie/contracts/data-access/fixtures/read-roster-phone-not-a-phone.json";
import rosterTp01 from "@rosie/contracts/data-access/fixtures/read-roster-phone-tp-01.json";
import rosterUnknown from "@rosie/contracts/data-access/fixtures/read-roster-phone-unknown.json";
import standingCheckTester from "@rosie/contracts/data-access/fixtures/read-tester-standing-check-tester.json";
import standingExpired from "@rosie/contracts/data-access/fixtures/read-tester-standing-expired.json";
import standingHumanTester from "@rosie/contracts/data-access/fixtures/read-tester-standing-human-tester.json";
import standingListingEnded from "@rosie/contracts/data-access/fixtures/read-tester-standing-listing-ended.json";
import standingNotTester from "@rosie/contracts/data-access/fixtures/read-tester-standing-not-tester.json";
import standingRemovedMember from "@rosie/contracts/data-access/fixtures/read-tester-standing-removed-member.json";
import standingSignedOut from "@rosie/contracts/data-access/fixtures/read-tester-standing-signed-out.json";
import standingUnknownToken from "@rosie/contracts/data-access/fixtures/read-tester-standing-unknown-token.json";
import sendCopyOfText from "@rosie/contracts/port-email/fixtures/send-copy-of-text.json";
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import chatLinkAfterContactAdd from "@rosie/contracts/tool-api/fixtures/chat-link-after-contact-add.json";
import staffJoinLink from "@rosie/contracts/tool-api/fixtures/staff-join-link.json";
import { DataAccessDatabaseError } from "@rosie/db/repo/clocks";
import type { Tx } from "@rosie/db/repo/scope";
import {
  readPhoneState,
  readRosterPhone,
  readTesterStanding,
  type ReadPhoneStateOutcome,
  type ReadRosterPhoneOutcome,
  type ReadTesterStandingOutcome,
} from "@rosie/db/repo/test-phone-reads";
import { ROSTER } from "@rosie/db/seeds/lib/roster";
import type { SendEmailRequest } from "@rosie/adapters/email/double";
import { sha256Hex } from "@rosie/actions/src/page-calls/staging/test-phone/index";
import { createExecutionContext, reset } from "cloudflare:test";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

import { pagePathOf, type PageCallName } from "../../gateway";
import { createWorker } from "../../index";
import type { Span } from "../../trace";
import { leaks } from "../../trace/hop-check";
import {
  composeRoot,
  environmentOf,
  SKELETON_FLAG,
  testPhoneLineOf,
  workerRoot,
  type Root,
  type TestPhoneInputs,
  type TestPhoneLineNamespace,
  type TestPhoneLinePort,
} from "../index";
import { NoTestPhoneLineError } from "../test-phone";
import { fakeFlags } from "../test-support";
import { dbHandle, DbClosedError, DbGuardRefusal, type DbHandle } from "./db";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { stagingOptions, type StagingBuilders, type StagingInputs } from "./options";
import { stagingDb, type DbCallLine, type StagingDb, type StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import {
  chatLinkOf,
  phoneStateOf,
  READ_PHONE_STATE_CALL,
  READ_ROSTER_PHONE_CALL,
  READ_TESTER_STANDING_CALL,
  rosieNumberOf,
  rosterPhoneOf,
  smsBodyOf,
  stagingLineOf,
  stagingTestPhone,
  standingOf,
  TestPhoneReadTransientError,
} from "./test-phone";
import {
  CHAT_LINK,
  NO_SESSION_TOKEN,
  PAGE_TOKENS,
  SEEDED_ROWS,
  STOPPED_AT,
  TP_01,
  TP_02,
  TP_03,
  TP_03_EMAIL,
  TP_04,
  TP_05,
} from "./test-phone.seed";
import { NO_ROW_INPUTS } from "./tool-api-rows";

/** This file's key in the rig's list (infra/test-rig/files.mjs). */
const KEY = "TEST_PHONE";
const JOB = `HYPERDRIVE_JOB_${KEY}`;
const APP = `HYPERDRIVE_APP_${KEY}`;
/** The pool's own job binding: its database, rosie_rig_none, is never made, so a connect through it fails. */
const POOL_OWN_JOB = "HYPERDRIVE_JOB";

/** The pool's Hyperdrive bindings, by name. */
const pool = poolEnv as unknown as Readonly<Record<string, Hyperdrive | undefined>>;

function poolBinding(name: string): Hyperdrive {
  const found = pool[name];
  if (found === undefined) throw new Error(`the pool has no Hyperdrive binding ${name}`);
  return found;
}

const DATABASE = inject("rosieRigDatabases")?.[KEY];

/** Rosie's own number for this file: made up, a whole number of the fiction range (never staging's real line). */
const ROSIE_NUMBER = "+15555550188";

/** ROSIE_NUMBER's malformed values (DL-581): each is no E.164 number by the K-04 and K-11 pattern, so no chat link. */
const MALFORMED_NUMBERS: readonly (readonly [string, unknown])[] = [
  ["empty", ""],
  ["no plus", "15555550188"],
  ["spaces", "+1 555 555 0188"],
  ["dashes", "+1-555-555-0188"],
  ["brackets", "+1 (555) 555-0188"],
  ["a space before", " +15555550188"],
  ["a space after", "+15555550188 "],
  ["a newline after", "+15555550188\n"],
  ["an sms address", "sms:+15555550188"],
  ["two numbers", "+15555550188+15555550199"],
  ["letters", "Rosie's line"],
  ["a number, not a string", 15555550188],
  ["null", null],
];

/** The made-up webhook secret the root's Linq verify reads (never staging's). */
const WEBHOOK_SECRET = `whsec_${btoa("t1305 made-up webhook secret")}`;

/** A time for a direct call that fails before any read: an instant in UTC, in whole seconds, as the handler gives it. */
const AT = "2026-11-14T08:00:00Z";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UTC_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/u;

// ---- the fixtures ---------------------------------------------------------------------------------------------------

interface Exchange<Request, Outcome> {
  readonly request: Request;
  readonly outcome: Outcome;
}
type StandingFixture = Exchange<{ tokenSha256: string; at: string }, ReadTesterStandingOutcome>;
type RosterFixture = Exchange<{ handleId: string }, ReadRosterPhoneOutcome>;
type PhoneFixture = Exchange<{ number: string }, ReadPhoneStateOutcome>;

/** Every accepted readTesterStanding fixture, v1.12's six and v1.15's two. */
const STANDING_FIXTURES = {
  "read-tester-standing-check-tester.json": standingCheckTester,
  "read-tester-standing-removed-member.json": standingRemovedMember,
  "read-tester-standing-not-tester.json": standingNotTester,
  "read-tester-standing-signed-out.json": standingSignedOut,
  "read-tester-standing-expired.json": standingExpired,
  "read-tester-standing-unknown-token.json": standingUnknownToken,
  "read-tester-standing-human-tester.json": standingHumanTester,
  "read-tester-standing-listing-ended.json": standingListingEnded,
} as unknown as Readonly<Record<string, StandingFixture>>;

/** Every accepted readRosterPhone fixture. */
const ROSTER_FIXTURES = {
  "read-roster-phone-tp-01.json": rosterTp01,
  "read-roster-phone-email-on-file.json": rosterEmailOnFile,
  "read-roster-phone-unknown.json": rosterUnknown,
  "read-roster-phone-not-a-phone.json": rosterNotAPhone,
} as unknown as Readonly<Record<string, RosterFixture>>;

/** Every accepted readPhoneState fixture. */
const PHONE_FIXTURES = {
  "read-phone-state-no-row.json": phoneNoRow,
  "read-phone-state-chat-open.json": phoneChatOpen,
  "read-phone-state-stopped.json": phoneStopped,
  "read-phone-state-started-again.json": phoneStartedAgain,
  "read-phone-state-chat-link.json": phoneChatLink,
} as unknown as Readonly<Record<string, PhoneFixture>>;

function fixtureOf<T>(fixtures: Readonly<Record<string, T>>, name: string): T {
  const found = fixtures[name];
  if (found === undefined) throw new Error(`this file holds no fixture ${name}`);
  return found;
}

/** The fixtures whose rows this file's database holds exactly (./test-phone.seed.ts): their own requests and answers. */
const EXACT_STANDINGS = [
  "read-tester-standing-check-tester.json",
  "read-tester-standing-not-tester.json",
  "read-tester-standing-signed-out.json",
  "read-tester-standing-expired.json",
  "read-tester-standing-human-tester.json",
  "read-tester-standing-listing-ended.json",
] as const;

/** The roster id whose handle id each roster fixture asks about, where the roster's list names that handle. */
const ROSTER_IDS: Readonly<Record<string, string>> = {
  "read-roster-phone-tp-01.json": TP_01.testPhoneId,
  "read-roster-phone-email-on-file.json": TP_01.testPhoneId,
  "read-roster-phone-unknown.json": TP_02.testPhoneId,
  // An entry put wrong (the fixture's own words): a roster id that names an email handle.
  "read-roster-phone-not-a-phone.json": "tp-put-wrong",
};

// ---- what the whole file captures: every log line and every span ------------------------------------------------------

/** Every line written to the console or as a call's timing, across the file, and the lines of the test that is running. */
const LOGGED: string[] = [];
let testLog: string[] = [];

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

// ---- the env a root is built over -------------------------------------------------------------------------------------

/** A double over a pool binding that counts the reads of its connection string, and gives the pool binding's. */
interface CountedBinding {
  readonly binding: { readonly connectionString: string };
  readonly reads: { n: number };
}

function counted(binding: Hyperdrive): CountedBinding {
  const reads = { n: 0 };
  return {
    binding: {
      get connectionString(): string {
        reads.n += 1;
        return binding.connectionString;
      },
    },
    reads,
  };
}

/** The pool's TestPhoneLine namespace (env.staging's TEST_PHONE_LINE binding). */
function poolLine(): DurableObjectNamespace {
  const namespace = poolEnv.TEST_PHONE_LINE;
  if (namespace === undefined) throw new Error("env.staging binds no TEST_PHONE_LINE");
  return namespace as unknown as DurableObjectNamespace;
}

/** The pool's line as a namespace whose stubs count each call this card's binding makes, then make it. */
function countingLine(calls: string[]): TestPhoneLineNamespace<DurableObjectId> {
  const namespace = poolLine();
  return {
    idFromName: (name) => namespace.idFromName(name),
    get(id): TestPhoneLinePort {
      // The stub's own type wraps the class's RPC methods, so it is typed here, as ../test-phone/pages.ts types it.
      const stub = namespace.get(id) as unknown as TestPhoneLinePort;
      return {
        sendPart: (request) => {
          calls.push("sendPart");
          return stub.sendPart(request);
        },
        partsTo: (number) => {
          calls.push("partsTo");
          return stub.partsTo(number);
        },
        sendEmail: (request) => {
          calls.push("sendEmail");
          return stub.sendEmail(request);
        },
        sentEmails: (request) => {
          calls.push("sentEmails");
          return stub.sentEmails(request);
        },
      };
    },
  };
}

interface TestEnv {
  readonly env: StagingEnv;
  /** The env's own values: a test may change ROSIE_NUMBER between calls. */
  readonly values: Record<string, unknown>;
  /** Every name read from the env, by a get or by an `in`, in order. */
  readonly names: string[];
  /** The counting double handed in as HYPERDRIVE_JOB; null where the env has none. */
  readonly job: CountedBinding | null;
  /** The counting double handed in as HYPERDRIVE_APP, in every env. */
  readonly app: CountedBinding;
  /** Each call of the line this card's binding made, by method. */
  readonly lineCalls: string[];
}

interface EnvOptions {
  readonly environment?: string;
  /** The pool binding handed in as HYPERDRIVE_JOB (default: this file's own); null for none. */
  readonly job?: string | null;
  readonly schema?: string;
  /** ROSIE_NUMBER's value (default: this file's made-up number); left out of the env entirely when `absent`. */
  readonly rosieNumber?: unknown;
  readonly absent?: readonly ("ROSIE_NUMBER" | "TEST_PHONE_LINE")[];
}

/** Every env a test built, the envs of the roots that bind this card's part alone, and every handle. */
const ENVS: TestEnv[] = [];
const OWN_PART_ENVS: TestEnv[] = [];
const HANDLES: Pick<DbHandle, "counts">[] = [];

/** The Worker's env as wrangler.jsonc's vars give it, with this file's pair behind counting doubles and the pool's line. */
function envOf(options: EnvOptions = {}): TestEnv {
  const names: string[] = [];
  const lineCalls: string[] = [];
  const jobName = options.job === undefined ? JOB : options.job;
  const job = jobName === null ? null : counted(poolBinding(jobName));
  const app = counted(poolBinding(APP));
  const absent = options.absent ?? [];
  const values: Record<string, unknown> = {
    ENVIRONMENT: options.environment ?? "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: options.schema ?? "",
    GIT_SHA: "test-sha",
    LINK_HOST: "rosfield.com",
    ...(job === null ? {} : { HYPERDRIVE_JOB: job.binding }),
    HYPERDRIVE_APP: app.binding,
    ...(absent.includes("TEST_PHONE_LINE") ? {} : { TEST_PHONE_LINE: countingLine(lineCalls) }),
    ...(absent.includes("ROSIE_NUMBER")
      ? {}
      : { ROSIE_NUMBER: "rosieNumber" in options ? options.rosieNumber : ROSIE_NUMBER }),
  };
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
  const made: TestEnv = { env: env as unknown as StagingEnv, values, names, job, app, lineCalls };
  ENVS.push(made);
  return made;
}

/** A handle of the test's own on this file's job binding (T-1254's), for a read, a count or a cut of its own. */
function ownHandle(): DbHandle {
  const handle = dbHandle({ ENVIRONMENT: "staging", DB_SCHEMA: "", HYPERDRIVE_JOB: poolBinding(JOB) });
  HANDLES.push(handle);
  return handle;
}

/**
 * Every part but this card's, stood in by its nothing-bound answer (each stub's own, as T-1257 made it), so a root built
 * with these shows this card's binding alone, whatever the other parts bind once their cards land (DL-776).
 */
const EVERY_OTHER_PART_UNBOUND: Partial<StagingBuilders> = {
  receipt: () => NO_RECEIPT_INPUTS,
  turn: () => NO_TURN_CALL_INPUTS,
  models: () => NO_MODEL_READER_INPUTS,
  bundleSafety: () => null,
  gate: () => null,
  rows: () => NO_ROW_INPUTS,
  directories: () => NO_DIRECTORY_INPUTS,
  send: () => NO_SEND_INPUTS,
  flags: () => null,
  copies: () => null,
};

interface Staged {
  /** The root's one handle (T-1254's, through ./part.ts): its counts are the root's. */
  readonly db: StagingDb;
  /** What stagingOptions gave: this card's input, every other part's null. */
  readonly inputs: StagingInputs;
  /** The test-phone input, which a staged env binds. */
  readonly testPhone: TestPhoneInputs;
  /** Each call's timing line the handle wrote, in order. */
  readonly lines: () => DbCallLine[];
}

/** The root's handle over the test's env (or the test's own double), and staging's inputs with this card's part alone. */
function stagedOver(testEnv: TestEnv, double?: StagingDb): Staged {
  const written: string[] = [];
  const db =
    double ??
    stagingDb(testEnv.env, {
      write: (line) => {
        written.push(line);
        LOGGED.push(line);
      },
    });
  HANDLES.push(db);
  OWN_PART_ENVS.push(testEnv);
  const inputs = stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
  if (inputs.testPhone === null) throw new Error("this card's part gave no input on a bound env");
  return {
    db,
    inputs,
    testPhone: inputs.testPhone,
    lines: () => written.map((line) => JSON.parse(line) as DbCallLine),
  };
}

/** A page call's POST as the page sends it, with its JSON body and its trace id (as ../test-phone.worker.test.ts's). */
function pagePost(path: string, body: unknown, traceId: string): Request {
  return new Request(`https://rosie.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trace-id": traceId },
    body: JSON.stringify(body),
  });
}

/** The Worker's vars where the page calls run: staging's, as wrangler.jsonc sets them. */
const WORKER_VARS = {
  ENVIRONMENT: "staging",
  BASE_PATH: "/test",
  DB_SCHEMA: "",
  GIT_SHA: "test-sha",
} as unknown as Cloudflare.Env;

/** One page call's answer: its status, its outcome when 200, its trace id and the page entry's span on that trace. */
interface Answer {
  readonly status: number;
  readonly outcome: Record<string, unknown>;
  readonly traceId: string;
  readonly span: Record<string, unknown> | undefined;
  /** The page entry's failure line on that trace, when the handler threw: the error's name alone. */
  readonly failure: Record<string, unknown> | undefined;
}

/** The page calls through the Worker's own route, {BASE_PATH}/page-api/<call>, to the gateway `gateway` holds. */
function pagesOf(gateway: () => Root["gateway"]): (call: PageCallName, request: unknown) => Promise<Answer> {
  const worker = createWorker(
    () => gateway(),
    () => null,
  );
  return async (call, request) => {
    const traceId = crypto.randomUUID();
    const response = await Promise.resolve(
      worker.fetch(
        pagePost(`/test${pagePathOf(call)}`, request, traceId),
        WORKER_VARS,
        createExecutionContext(),
      ),
    );
    const outcome = await response.json<Record<string, unknown>>();
    const onTrace = (msg: string) => jsonLinesOf(testLog, msg).filter((line) => line.trace_id === traceId);
    return {
      status: response.status,
      outcome,
      traceId,
      span: onTrace("span").find((line) => line.hop === "pageRequest"),
      failure: onTrace("gateway_failed").find((line) => line.stage === "pageHandler"),
    };
  };
}

interface Rooted extends Staged {
  readonly root: Root;
  readonly page: (call: PageCallName, request: unknown) => Promise<Answer>;
}

/**
 * A root built as workerRoot builds the Worker's (composeRoot over stagingOptions(env), on the Workers clock) with this
 * card's part alone bound, the skeleton flag on and a made-up webhook secret, so testPhoneSend's signed text reaches the
 * root's Linq route; and its page calls through the Worker's route.
 */
function rootOver(testEnv: TestEnv, double?: StagingDb): Rooted {
  const staged = stagedOver(testEnv, double);
  const root = composeRoot({
    environment: environmentOf(testEnv.env),
    actors: null,
    vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
    linq: { webhookSecret: () => WEBHOOK_SECRET },
    ...staged.inputs,
    flags: fakeFlags([SKELETON_FLAG]),
  });
  return { ...staged, root, page: pagesOf(() => root.gateway) };
}

// ---- the page's requests --------------------------------------------------------------------------------------------

/** K-21 v1 test-phone-send.json's request, under this session token, for this roster id. */
function sendRequest(sessionToken: string, testPhoneId: string): Record<string, unknown> {
  const { request } = testPhoneSendJson;
  return { ...request, page: { ...request.page, sessionToken }, testPhoneId };
}

/** K-21 v1 test-phone-parts.json's request, under this session token, for this roster id. */
function partsRequest(sessionToken: string, testPhoneId: string): Record<string, unknown> {
  const { request } = testPhonePartsJson;
  return { ...request, page: { ...request.page, sessionToken }, testPhoneId };
}

/** The phone a testPhoneParts answer shows for a roster phone: its id, its last four digits and its state. */
function shownPhone(
  phone: { readonly testPhoneId: string; readonly fakeNumber: string },
  state: { chatOpen: boolean; stopped: boolean; stoppedAt: string | null },
): Record<string, unknown> {
  return { testPhoneId: phone.testPhoneId, last4: phone.fakeNumber.slice(-4), ...state };
}

/** The calls named on the handle's timing lines, in order. */
const callsOf = (lines: readonly DbCallLine[]): (string | null)[] => lines.map((line) => line.call);

/** Each timing line is the runtime side's read: HYPERDRIVE_JOB, the login rosie_worker_job, on no trace. */
function expectJobSide(lines: readonly DbCallLine[]): void {
  for (const line of lines) {
    expect(line).toEqual({
      level: "info",
      msg: "dbCall",
      trace_id: null,
      call: expect.stringMatching(/^read(TesterStanding|RosterPhone|PhoneState)$/u) as string,
      side: "runtime",
      binding: "HYPERDRIVE_JOB",
      login: "rosie_worker_job",
      connect: { at: expect.stringMatching(UTC_TEXT) as string, ms: expect.any(Number) as number },
      guard: { at: expect.stringMatching(UTC_TEXT) as string, ms: expect.any(Number) as number },
      environment: "staging",
      version: "test-sha",
    });
  }
}

// ---- the database -----------------------------------------------------------------------------------------------------

/** The row count of each table the three reads read, in this file's database (rosie_job, no scope, sees every row). */
async function rowCounts(): Promise<Record<keyof typeof SEEDED_ROWS, number>> {
  const rows = await ownHandle().runtime(
    "rowCounts",
    (sql) => sql<Record<keyof typeof SEEDED_ROWS, number>[]>`
      select (select count(*) from persons)::int as persons,
             (select count(*) from handles)::int as handles,
             (select count(*) from person_handles)::int as person_handles,
             (select count(*) from team_page_recipients)::int as team_page_recipients,
             (select count(*) from staging_testers)::int as staging_testers,
             (select count(*) from proof_codes)::int as proof_codes,
             (select count(*) from sessions)::int as sessions,
             (select count(*) from phones)::int as phones,
             (select count(*) from chat_links)::int as chat_links`,
  );
  const [row] = rows;
  if (row === undefined) throw new Error("the row counts were not read");
  return { ...row };
}

/** What a promise settled with: kept, so a call started before a wait never rejects with nothing to catch it. */
type Settled<T> = { readonly answered: T } | { readonly failed: unknown };

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (answered) => ({ answered }),
    (failed: unknown) => ({ failed }),
  );
}

/**
 * A backend of this database, of this login, that waits on a lock: the read under way. Asked until there is one, each
 * time on a fresh reading (inside a transaction PostgreSQL keeps the first one it gave until the transaction ends).
 */
async function waitingBackend(tx: Tx): Promise<number> {
  for (let asked = 0; asked < 400; asked += 1) {
    await tx`select pg_stat_clear_snapshot()`;
    const waiting = await tx<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and usename = current_user and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`;
    const [only] = waiting;
    if (waiting.length === 1 && only !== undefined) return only.pid;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error("no read ever waited on the lock");
}

/**
 * Starts `read` and cuts the phone read's connection under it, as ./state-reads.worker.test.ts cuts its read: a job-side
 * client of the test's own locks phones (rosie_job may: it holds UPDATE on it), so item 55 waits at its first statement;
 * the one backend of this database that then waits on a lock is that read's, and it is ended (pg_terminate_backend,
 * which a login may send its own sessions; never a backend of another database). The read's statement fails with its
 * connection lost, which K-05 answers transient. Resolves with what `read` settled with, after the lock is gone.
 */
async function cutUnderPhoneRead<T>(read: () => Promise<T>): Promise<Settled<T>> {
  const started = await ownHandle().runtime("cutThePhoneRead", (sql) =>
    sql.begin(async (tx) => {
      await tx`lock table phones in access exclusive mode`;
      const reading = settled(read());
      const pid = await waitingBackend(tx);
      const ended = await tx<{ ended: boolean }[]>`select pg_terminate_backend(${pid}) as ended`;
      if (ended[0]?.ended !== true) throw new Error("the read's backend was not ended");
      // Handed out in an object, so the transaction ends without waiting for the read.
      return { reading };
    }),
  );
  return started.reading;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** Whether `text` holds `part` as a whole name (not inside a longer name, such as rosie inside rosie_job). */
function holds(text: string, part: string): boolean {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "u").test(text);
}

/** The texts an error gives away: its message, its stack but for the frames, its own fields and the error as a string. */
function textsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => !/^\s+at\s/u.test(line))
    .join("\n");
  const fields = error as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyNames(error)
    .filter((name) => name !== "stack")
    .map((name) => (JSON.stringify(fields[name]) as string | undefined) ?? "");
  return [error.message, stack, JSON.stringify(error), String(error), ...own];
}

/** No text of the error holds the binding's string, host, user, password or database, nor any value this file holds. */
function expectNothingOf(binding: { readonly connectionString: string }, error: unknown): void {
  const url = new URL(binding.connectionString);
  const parts = [
    binding.connectionString,
    url.host,
    url.hostname,
    decodeURIComponent(url.username),
    decodeURIComponent(url.password),
    decodeURIComponent(url.pathname.slice(1)),
  ].filter((part) => part !== "");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const text of textsOf(error)) {
    for (const part of parts)
      expect(holds(text, part), "a text holds a part of the binding's string").toBe(false);
    for (const value of FORBIDDEN)
      expect(text.includes(value), "a text holds a value it must not").toBe(false);
  }
}

// ---- what no span, log line or error may hold --------------------------------------------------------------------------

/** Every number this file's rows or env hold, each whole literal sliced into the forms a number could leak in. */
const NUMBER_FORMS = [...ROSTER.map((phone) => phone.fakeNumber), ROSIE_NUMBER].flatMap((number) => [
  number,
  number.slice(1),
  number.slice(2),
  `${number.slice(5, 8)}-${number.slice(8)}`,
]);

/** The tokens, the hashes the page's sessions and the fixtures' sessions hold, the emails, the short code and the texts. */
const FORBIDDEN: string[] = [];

beforeEach(async () => {
  if (FORBIDDEN.length === 0) {
    const tokens = [...Object.values(PAGE_TOKENS), NO_SESSION_TOKEN];
    FORBIDDEN.push(
      ...tokens,
      ...(await Promise.all(tokens.map((token) => sha256Hex(token)))),
      ...Object.values(STANDING_FIXTURES).map((fixture) => fixture.request.tokenSha256),
      ...NUMBER_FORMS,
      TP_03_EMAIL,
      "check-tester@example.com",
      "tester-one@example.com",
      "tester-two@example.com",
      CHAT_LINK.shortCode,
      CHAT_LINK.readyText,
      smsBodyOf(CHAT_LINK.readyText),
      WEBHOOK_SECRET,
    );
  }
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

afterEach(async () => {
  vi.restoreAllMocks();
  // T-1254's counter: every client a call opened was ended.
  for (const db of HANDLES) {
    const counts = db.counts();
    expect(counts.ended).toBe(counts.opened);
    expect(counts.connectionsOpen).toBe(0);
  }
  // The job side only: HYPERDRIVE_APP's connection string is never read, and this card's part never reads HYPERDRIVE_APP
  // by its name either; no binding named HYPERDRIVE is read at all.
  for (const made of ENVS) {
    expect(made.app.reads.n).toBe(0);
    expect(made.names).not.toContain("HYPERDRIVE");
  }
  for (const made of OWN_PART_ENVS) expect(made.names).not.toContain("HYPERDRIVE_APP");
  // The line keeps what a test recorded in its own storage: each test starts from an empty line.
  await reset();
});

// ---- the rig ----------------------------------------------------------------------------------------------------------

describe("this file's database on the rig", () => {
  it("is this run's own, and every accepted fixture of the three reads is one this file maps", () => {
    expect(DATABASE).toMatch(/^rosie_rig_[0-9a-f]{8}_test_phone$/u);
    const accepted = (def: string): string[] =>
      (fixtureIndex as unknown as { fixtures: { file: string; def?: string; expect: string }[] }).fixtures
        .filter((entry) => entry.expect === "accept" && entry.def === def)
        .map((entry) => entry.file)
        .sort();
    expect(Object.keys(STANDING_FIXTURES).sort()).toEqual(accepted("readTesterStanding.exchange"));
    expect(Object.keys(ROSTER_FIXTURES).sort()).toEqual(accepted("readRosterPhone.exchange"));
    expect(Object.keys(PHONE_FIXTURES).sort()).toEqual(accepted("readPhoneState.exchange"));
    // Each roster phone's number is a whole one of the fiction range, as the list holds it.
    for (const phone of ROSTER) expect(phone.fakeNumber).toMatch(/^\+1[0-9]{10}$/u);
    expect(rosieNumberOf(ROSIE_NUMBER)).toBe(ROSIE_NUMBER);
  });

  it("holds the rows the seed's header lists, and nothing a call wrote", async () => {
    expect(await rowCounts()).toEqual(SEEDED_ROWS);
  });
});

// ---- the mapping ------------------------------------------------------------------------------------------------------

describe("the mapping on each accepted fixture's own answer, as K-05 v1.12's bindings line maps it", () => {
  it("access: the standing across unchanged, for every readTesterStanding fixture", () => {
    for (const [name, fixture] of Object.entries(STANDING_FIXTURES)) {
      if ("error" in fixture.outcome) throw new Error(`${name} answers an error`);
      expect(standingOf(fixture.outcome), name).toBe(fixture.outcome.standing);
    }
    expect(new Set(Object.values(STANDING_FIXTURES).map((fixture) => standingOf(fixture.outcome)))).toEqual(
      new Set(["tester", "notTester", "noSession"]),
    );
  });

  it("roster: { testPhoneId, number, email } as the answer holds them, or null for phone null, for every readRosterPhone fixture", () => {
    const mapped = Object.fromEntries(
      Object.entries(ROSTER_FIXTURES).map(([name, fixture]) => [
        name,
        rosterPhoneOf(fixtureOf(ROSTER_IDS, name), fixture.request.handleId, fixture.outcome),
      ]),
    );

    expect(mapped).toEqual({
      "read-roster-phone-tp-01.json": {
        testPhoneId: "tp-01",
        number: rosterTp01.outcome.phone.number,
        email: null,
      },
      "read-roster-phone-email-on-file.json": {
        testPhoneId: "tp-01",
        number: rosterEmailOnFile.outcome.phone.number,
        email: rosterEmailOnFile.outcome.phone.email,
      },
      "read-roster-phone-unknown.json": null,
      "read-roster-phone-not-a-phone.json": null,
    });
    // The number is the database's, never the list's: tp-01's fixture holds the number the list falls back to.
    expect(mapped["read-roster-phone-tp-01.json"]?.number).toBe(TP_01.fakeNumber);
    // Its three fields alone.
    expect(Object.keys(mapped["read-roster-phone-email-on-file.json"] ?? {}).sort()).toEqual([
      "email",
      "number",
      "testPhoneId",
    ]);
  });

  it("phones: no row as a chat closed and not stopped, a row field by field, and the chat link in K-09's form only with Rosie's number, for every readPhoneState fixture", () => {
    const withNumber = (fixture: PhoneFixture) => phoneStateOf(fixture.outcome, () => ROSIE_NUMBER);
    const without = (fixture: PhoneFixture) => phoneStateOf(fixture.outcome, () => null);

    expect(withNumber(fixtureOf(PHONE_FIXTURES, "read-phone-state-no-row.json"))).toEqual({
      chatOpen: false,
      stopped: false,
      stoppedAt: null,
      chatLink: null,
    });
    expect(withNumber(fixtureOf(PHONE_FIXTURES, "read-phone-state-chat-open.json"))).toEqual({
      chatOpen: true,
      stopped: false,
      stoppedAt: null,
      chatLink: null,
    });
    expect(withNumber(fixtureOf(PHONE_FIXTURES, "read-phone-state-stopped.json"))).toEqual({
      chatOpen: false,
      stopped: true,
      stoppedAt: "2026-11-07T15:06:36Z",
      chatLink: null,
    });
    expect(withNumber(fixtureOf(PHONE_FIXTURES, "read-phone-state-started-again.json"))).toEqual({
      chatOpen: true,
      stopped: false,
      stoppedAt: null,
      chatLink: null,
    });
    expect(withNumber(fixtureOf(PHONE_FIXTURES, "read-phone-state-chat-link.json"))).toEqual({
      chatOpen: false,
      stopped: false,
      stoppedAt: null,
      chatLink: {
        link: "sms:+15555550188&body=YES.%20Ref%20P5J3",
        readyText: "YES. Ref P5J3",
        shortCode: "P5J3",
      },
    });
    // Without Rosie's number (default 109) the same answers, with no chat link.
    for (const [name, fixture] of Object.entries(PHONE_FIXTURES)) {
      expect(without(fixture), name).toEqual({ ...withNumber(fixture), chatLink: null });
    }
    // Rosie's number is read only for an answer that holds a link.
    const asked = vi.fn(() => ROSIE_NUMBER);
    for (const fixture of Object.values(PHONE_FIXTURES)) phoneStateOf(fixture.outcome, asked);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("the chat link's address is K-09 v1 issueChatLink's: its two fixtures' links exactly, from their ready texts and their number", () => {
    for (const fixture of [chatLinkAfterContactAdd, staffJoinLink]) {
      const { link, readyText, shortCode } = fixture.outcome;
      // The number each fixture's link names: the fiction-range placeholder its note gives Rosie (Q-51).
      const number = link.slice("sms:".length, link.indexOf("&"));

      expect(rosieNumberOf(number), fixture.call).toBe(number);
      expect(chatLinkOf({ shortCode, readyText }, number), fixture.call).toEqual({
        link,
        readyText,
        shortCode,
      });
    }
    // The apostrophe and the comma are encoded as K-09 writes them; RFC 3986's unreserved characters are not.
    expect(smsBodyOf("Join Lee's Barbershop on Rosie JOIN7R")).toBe(
      "Join%20Lee%27s%20Barbershop%20on%20Rosie%20JOIN7R",
    );
    expect(smsBodyOf("a-b.c_d~e!f*g(h)")).toBe("a-b.c_d~e%21f%2Ag%28h%29");
    expect(chatLinkOf(null, ROSIE_NUMBER)).toBeNull();
  });

  it("ROSIE_NUMBER is checked as E.164 at the call (DL-581): missing, and each malformed value, gives no Rosie's number, so no chat link", () => {
    expect(rosieNumberOf(undefined)).toBeNull();
    for (const [what, value] of MALFORMED_NUMBERS) {
      expect(rosieNumberOf(value), what).toBeNull();
      expect(
        phoneStateOf(fixtureOf(PHONE_FIXTURES, "read-phone-state-chat-link.json").outcome, () =>
          rosieNumberOf(value),
        ).chatLink,
        what,
      ).toBeNull();
    }
  });

  it("transient, and an error K-05 does not name, are thrown with the call's name and the SQLSTATE alone; a roster answer for another handle is thrown", () => {
    const transient = { error: "transient", sqlstate: "40001" } as const;
    const cases: readonly [string, () => unknown][] = [
      [READ_TESTER_STANDING_CALL, () => standingOf(transient)],
      [READ_ROSTER_PHONE_CALL, () => rosterPhoneOf("tp-01", TP_01.handleId, transient)],
      [READ_PHONE_STATE_CALL, () => phoneStateOf(transient, () => ROSIE_NUMBER)],
    ];
    for (const [call, map] of cases) {
      let thrown: unknown;
      try {
        map();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, call).toBeInstanceOf(TestPhoneReadTransientError);
      expect(thrown, call).toMatchObject({
        name: "TestPhoneReadTransientError",
        call,
        sqlstate: "40001",
        message: `${call}: the database could not answer now (transient, SQLSTATE 40001)`,
      });
      expect(Object.getOwnPropertyNames(thrown).sort(), call).toEqual([
        "call",
        "message",
        "name",
        "sqlstate",
        "stack",
      ]);
    }
    // Whatever stands where a SQLSTATE should is never handed on.
    const odd = new TestPhoneReadTransientError(READ_PHONE_STATE_CALL, TP_05.fakeNumber);
    expect(odd.sqlstate).toBeNull();
    expect(odd.message).toBe("readPhoneState: the database could not answer now (transient)");
    const unnamed = { error: "notFound", table: "handles", rowId: TP_01.handleId } as unknown;
    expect(() => standingOf(unnamed as ReadTesterStandingOutcome)).toThrow(TestPhoneReadTransientError);
    expect(() => phoneStateOf(unnamed as ReadPhoneStateOutcome, () => null)).toThrow(
      TestPhoneReadTransientError,
    );
    // A roster answer that names another handle than the one the list gave is no roster phone of that id.
    expect(() =>
      rosterPhoneOf("tp-01", TP_01.handleId, rosterUnknown.outcome as ReadRosterPhoneOutcome),
    ).toThrow(new TypeError("readRosterPhone: the answer names another handle than the one asked for"));
  });
});

// ---- the three ports by direct call -----------------------------------------------------------------------------------

describe("the three ports through the root's inputs, on this file's rows: K-05 v1.12 items 53 to 55 through the job handle", () => {
  it.each(EXACT_STANDINGS)(
    "access: %s answers its own outcome on this file's rows, and the port the standing alone",
    async (name) => {
      const fixture = fixtureOf(STANDING_FIXTURES, name);
      const testEnv = envOf();
      const { testPhone, db, lines } = stagedOver(testEnv);
      // Nothing was read to build the inputs but the environment and the binding's presence: no connection string.
      expect(testEnv.job?.reads.n).toBe(0);

      const own = await ownHandle().runtime(READ_TESTER_STANDING_CALL, (sql) =>
        readTesterStanding(sql, fixture.request),
      );
      const standing = await testPhone.access?.standing(fixture.request.tokenSha256, fixture.request.at);

      expect(own, name).toEqual(fixture.outcome);
      expect(standing, name).toBe((fixture.outcome as { standing: string }).standing);
      // One short-lived client for the call, its connection string read at that call, on the job side.
      expect(callsOf(lines())).toEqual([READ_TESTER_STANDING_CALL]);
      expectJobSide(lines());
      expect(testEnv.job?.reads.n).toBe(1);
      expect(db.counts()).toMatchObject({ opened: 1, ended: 1, connectionsOpen: 0, connectionsPeak: 1 });
    },
  );

  it("roster: tp-01 and tp-02 answer read-roster-phone-tp-01's and read-roster-phone-unknown's own outcomes through the list's handle ids; an id the list does not hold reads nothing", async () => {
    const { testPhone, lines } = stagedOver(envOf());
    const own = (handleId: string) =>
      ownHandle().runtime(READ_ROSTER_PHONE_CALL, (sql) => readRosterPhone(sql, { handleId }));

    expect(TP_01.handleId).toBe(rosterTp01.request.handleId);
    expect(TP_02.handleId).toBe(rosterUnknown.request.handleId);
    expect(await own(TP_01.handleId)).toEqual(rosterTp01.outcome);
    expect(await own(TP_02.handleId)).toEqual(rosterUnknown.outcome);

    expect(await testPhone.roster?.phone("tp-01")).toEqual({
      testPhoneId: "tp-01",
      number: TP_01.fakeNumber,
      email: null,
    });
    expect(await testPhone.roster?.phone("tp-02")).toBeNull();
    expect(callsOf(lines())).toEqual([READ_ROSTER_PHONE_CALL, READ_ROSTER_PHONE_CALL]);
    // Off the list, compared exactly: no read at all.
    for (const id of ["tp-06", "TP-01", " tp-01", "tp-01 ", "handle-sam", TP_01.fakeNumber, ""]) {
      expect(await testPhone.roster?.phone(id), id).toBeNull();
    }
    expect(callsOf(lines())).toHaveLength(2);
    expectJobSide(lines());
  });

  it("phones: tp-01 and tp-03 answer read-phone-state-no-row's and read-phone-state-stopped's own outcomes by their numbers, and the port maps each", async () => {
    const { testPhone, lines } = stagedOver(envOf());
    const own = (number: string) =>
      ownHandle().runtime(READ_PHONE_STATE_CALL, (sql) => readPhoneState(sql, { number }));

    expect(TP_01.fakeNumber).toBe(phoneNoRow.request.number);
    expect(TP_03.fakeNumber).toBe(phoneStopped.request.number);
    expect(await own(TP_01.fakeNumber)).toEqual(phoneNoRow.outcome);
    expect(await own(TP_03.fakeNumber)).toEqual(phoneStopped.outcome);

    expect(await testPhone.phones?.state(TP_01.fakeNumber)).toEqual({
      chatOpen: false,
      stopped: false,
      stoppedAt: null,
      chatLink: null,
    });
    expect(await testPhone.phones?.state(TP_03.fakeNumber)).toEqual({
      chatOpen: false,
      stopped: true,
      stoppedAt: STOPPED_AT,
      chatLink: null,
    });
    expect(callsOf(lines())).toEqual([READ_PHONE_STATE_CALL, READ_PHONE_STATE_CALL]);
    expectJobSide(lines());
  });

  it("each call reads the rows again on a client of its own: nothing is remembered for a root", async () => {
    const testEnv = envOf();
    const { testPhone, db, lines } = stagedOver(testEnv);

    const first = await testPhone.phones?.state(TP_05.fakeNumber);
    const second = await testPhone.phones?.state(TP_05.fakeNumber);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(callsOf(lines())).toEqual([READ_PHONE_STATE_CALL, READ_PHONE_STATE_CALL]);
    expect(testEnv.job?.reads.n).toBe(2);
    expect(db.counts()).toMatchObject({ opened: 2, ended: 2, connectionsOpen: 0, connectionsPeak: 1 });
  });
});

// ---- the page's two calls ---------------------------------------------------------------------------------------------

describe("the page's two calls through the Worker's page entry, with answers shaped as the v1.12 fixtures", () => {
  it("a tester by the check tester's live team row (read-tester-standing-check-tester's shape): testPhoneParts shows tp-01, its number with no email and no phone row (read-roster-phone-tp-01, read-phone-state-no-row), and reads no email", async () => {
    const testEnv = envOf();
    const { page, lines } = rootOver(testEnv);

    const answer = await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-01"));

    expect(answer.status).toBe(200);
    expect(answer.outcome).toEqual({
      result: "parts",
      phone: shownPhone(TP_01, { chatOpen: false, stopped: false, stoppedAt: null }),
      chatLink: null,
      parts: [],
      emails: [],
    });
    expect(answer.span).toMatchObject({ outcome: "ok", decided: { answered: 200, answer: "response" } });
    // The standing, the roster phone and its state, each on a job-side client of its own; the line's parts to the
    // number, and no email read, since the phone's person has none on file.
    expect(callsOf(lines())).toEqual([
      READ_TESTER_STANDING_CALL,
      READ_ROSTER_PHONE_CALL,
      READ_PHONE_STATE_CALL,
    ]);
    expectJobSide(lines());
    expect(testEnv.lineCalls).toEqual(["partsTo"]);
  });

  it("a tester by a human tester's live listing (read-tester-standing-human-tester's shape): testPhoneParts shows tp-04 after a START that followed a STOP (read-phone-state-started-again's shape): no STOP in force", async () => {
    const { page } = rootOver(envOf());

    const answer = await page("testPhoneParts", partsRequest(PAGE_TOKENS.humanTester, "tp-04"));

    expect(answer.status).toBe(200);
    expect(answer.outcome).toEqual({
      result: "parts",
      phone: shownPhone(TP_04, { chatOpen: true, stopped: false, stoppedAt: null }),
      chatLink: null,
      parts: [],
      emails: [],
    });
  });

  it("a non-tester (read-tester-standing-not-tester's shape: test owner 1's live session) gets notTester from both calls, and nothing but the standing is read", async () => {
    const testEnv = envOf();
    const { page, lines } = rootOver(testEnv);

    const parts = await page("testPhoneParts", partsRequest(PAGE_TOKENS.owner, "tp-01"));
    const sent = await page("testPhoneSend", sendRequest(PAGE_TOKENS.owner, "tp-01"));

    for (const answer of [parts, sent]) {
      expect(answer.status).toBe(200);
      expect(answer.outcome).toEqual({ error: "notTester" });
    }
    expect(callsOf(lines())).toEqual([READ_TESTER_STANDING_CALL, READ_TESTER_STANDING_CALL]);
    expect(testEnv.lineCalls).toEqual([]);
    expect(jsonLinesOf(testLog, "span").filter((line) => line.hop === "receive")).toEqual([]);
  });

  it("no session (read-tester-standing-unknown-token's shape: a token whose sha256 no session holds) gets signInNeeded from both calls, and nothing but the standing is read", async () => {
    const testEnv = envOf();
    const { page, lines } = rootOver(testEnv);

    const parts = await page("testPhoneParts", partsRequest(NO_SESSION_TOKEN, "tp-01"));
    const sent = await page("testPhoneSend", sendRequest(NO_SESSION_TOKEN, "tp-01"));

    for (const answer of [parts, sent]) {
      expect(answer.status).toBe(200);
      expect(answer.outcome).toEqual({ error: "signInNeeded" });
    }
    expect(callsOf(lines())).toEqual([READ_TESTER_STANDING_CALL, READ_TESTER_STANDING_CALL]);
    expect(testEnv.lineCalls).toEqual([]);
  });

  it("no roster phone by the id: tp-02, whose handle no row holds (read-roster-phone-unknown), and an id off the list, answer notTestPhone with nothing signed, posted or read from the line", async () => {
    const testEnv = envOf();
    const { page, lines } = rootOver(testEnv);

    const answers = [
      await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-02")),
      await page("testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-02")),
      await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-06")),
      await page("testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-06")),
    ];

    expect(answers.map((answer) => [answer.status, answer.outcome])).toEqual([
      [200, { error: "notTestPhone", testPhoneId: "tp-02" }],
      [200, { error: "notTestPhone", testPhoneId: "tp-02" }],
      [200, { error: "notTestPhone", testPhoneId: "tp-06" }],
      [200, { error: "notTestPhone", testPhoneId: "tp-06" }],
    ]);
    // tp-02's handle is asked for; tp-06 is on no list, so nothing is read for it but the standing.
    expect(callsOf(lines())).toEqual([
      READ_TESTER_STANDING_CALL,
      READ_ROSTER_PHONE_CALL,
      READ_TESTER_STANDING_CALL,
      READ_ROSTER_PHONE_CALL,
      READ_TESTER_STANDING_CALL,
      READ_TESTER_STANDING_CALL,
    ]);
    expect(testEnv.lineCalls).toEqual([]);
    // Nothing was signed or posted: the root's Linq route opened no trace.
    expect(jsonLinesOf(testLog, "span").filter((line) => line.hop === "receive")).toEqual([]);
  });

  it("a stopped phone (read-phone-state-stopped, exactly): tp-03 shows the STOP in force with its chat closed, the part the line recorded to its number and the email its person's one email handle got (read-roster-phone-email-on-file's shape)", async () => {
    const testEnv = envOf();
    const { page } = rootOver(testEnv);
    // What staging's send paths recorded through the line: K-11's send-text.json to tp-03's number, as it stands, and
    // K-12's send-copy-of-text.json to its person's email, as it stands.
    const line = testPhoneLineOf(poolLine());
    expect(sendText.request.to).toBe(TP_03.fakeNumber);
    expect(await line.sendPart(sendText.request)).toMatchObject({ result: "accepted" });
    expect(await line.sendEmail(sendCopyOfText.request as unknown as SendEmailRequest)).toMatchObject({
      result: "accepted",
    });

    const answer = await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-03"));

    expect(answer.status).toBe(200);
    const outcome = answer.outcome as {
      phone: unknown;
      chatLink: unknown;
      parts: { at: string; sent: unknown; outcome: Record<string, unknown> }[];
      emails: unknown[];
    };
    expect(outcome.phone).toEqual(
      shownPhone(TP_03, { chatOpen: false, stopped: true, stoppedAt: STOPPED_AT }),
    );
    expect(outcome.chatLink).toBeNull();
    expect(outcome.parts.map((part) => part.sent)).toEqual([sendText.request]);
    expect(outcome.parts[0]?.outcome).toMatchObject({ result: "accepted", chatId: sendText.request.chatId });
    expect(outcome.emails).toEqual([
      {
        at: expect.stringMatching(UTC_TEXT) as string,
        to: TP_03_EMAIL,
        subject: sendCopyOfText.request.subject,
        text: sendCopyOfText.request.text,
      },
    ]);
    expect(testEnv.lineCalls).toEqual(["partsTo", "sentEmails"]);
  });

  it("an open chat with a chat link (read-phone-state-chat-open's and read-phone-state-chat-link's shapes): tp-05's link in K-09's form from ROSIE_NUMBER, read at the call; with none, or a malformed one, chatLink is null and the rest unchanged", async () => {
    const testEnv = envOf({ absent: ["ROSIE_NUMBER"] });
    const { page } = rootOver(testEnv);
    const tp05 = async () => {
      const answer = await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-05"));
      expect(answer.status).toBe(200);
      return answer.outcome;
    };
    const shown = {
      result: "parts",
      phone: shownPhone(TP_05, { chatOpen: true, stopped: false, stoppedAt: null }),
      parts: [],
      emails: [],
    };
    // Nothing was read at build but the environment and the binding's presence.
    expect(testEnv.names).not.toContain("ROSIE_NUMBER");

    // None set (staging before T-1304's value: default 109).
    expect(await tp05()).toEqual({ ...shown, chatLink: null });
    // Set after the root was built: read at the next call.
    testEnv.values.ROSIE_NUMBER = ROSIE_NUMBER;
    expect(await tp05()).toEqual({
      ...shown,
      chatLink: {
        link: "sms:+15555550188&body=YES.%20Ref%20P5J3",
        readyText: CHAT_LINK.readyText,
        shortCode: CHAT_LINK.shortCode,
      },
    });
    // Each malformed value (DL-581): no link, the phone's state as before.
    for (const [what, value] of MALFORMED_NUMBERS) {
      testEnv.values.ROSIE_NUMBER = value;
      expect(await tp05(), what).toEqual({ ...shown, chatLink: null });
    }
    Reflect.deleteProperty(testEnv.values, "ROSIE_NUMBER");
    expect(await tp05()).toEqual({ ...shown, chatLink: null });
  });

  it("testPhoneSend for a tester on tp-01: the text is signed as the number the database holds and posted to the root's Linq route, which verifies it; the page answers sent with the gateway's trace and status", async () => {
    const testEnv = envOf();
    const { page, lines } = rootOver(testEnv);

    const answer = await page("testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-01"));

    expect(answer.status).toBe(200);
    expect(answer.outcome).toEqual({
      result: "sent",
      eventId: expect.any(String) as string,
      traceId: expect.stringMatching(UUID) as string,
      gatewayStatus: 503,
    });
    expect(answer.outcome.traceId).not.toBe(answer.traceId);
    // The gateway's own trace for the webhook: the signature verified, and the key call, which this root binds to no
    // database (every other part unbound), failed closed, so the gateway answered 503 and Linq would send it again.
    const receive = jsonLinesOf(testLog, "span").find(
      (line) => line.trace_id === answer.outcome.traceId && line.hop === "receive",
    );
    expect(receive?.decided).toMatchObject({ signatureValid: true, answered: 503 });
    // The standing and the roster phone; no phone state and no line for a send.
    expect(callsOf(lines())).toEqual([READ_TESTER_STANDING_CALL, READ_ROSTER_PHONE_CALL]);
    expect(testEnv.lineCalls).toEqual([]);
  });

  it("through the Worker's own root (workerRoot, every part's own builder): testPhoneParts binds this card's reads and answers tp-05 with its chat link", async () => {
    const testEnv = envOf();

    const answer = await pagesOf(() => workerRoot(testEnv.env).gateway)(
      "testPhoneParts",
      partsRequest(PAGE_TOKENS.checkTester, "tp-05"),
    );

    expect(answer.status).toBe(200);
    expect(answer.outcome).toMatchObject({
      result: "parts",
      phone: shownPhone(TP_05, { chatOpen: true, stopped: false, stoppedAt: null }),
      chatLink: { link: "sms:+15555550188&body=YES.%20Ref%20P5J3", shortCode: CHAT_LINK.shortCode },
    });
    // This card's three reads, among whatever else the other parts read on the page's trace.
    const ownCalls = (jsonLinesOf(testLog, "dbCall") as unknown as DbCallLine[]).filter((line) =>
      [READ_TESTER_STANDING_CALL, READ_ROSTER_PHONE_CALL, READ_PHONE_STATE_CALL].includes(String(line.call)),
    );
    expect(callsOf(ownCalls)).toEqual([
      READ_TESTER_STANDING_CALL,
      READ_ROSTER_PHONE_CALL,
      READ_PHONE_STATE_CALL,
    ]);
    expectJobSide(ownCalls);
    expect(testEnv.lineCalls).toEqual(["partsTo"]);
  });
});

// ---- a transient answer, and bound but failing ------------------------------------------------------------------------

/**
 * A handle double that answers each read's call with K-05's answer given for it (never reaching a database), and refuses
 * any other call; every call it takes is kept, by its side and name.
 */
function answeringDb(answers: Readonly<Record<string, unknown>>): { db: StagingDb; calls: string[] } {
  const calls: string[] = [];
  const answer = <T>(side: string, call: string): Promise<T> => {
    calls.push(`${side}:${call}`);
    if (side === "runtime" && Object.hasOwn(answers, call)) return Promise.resolve(answers[call] as T);
    return Promise.reject(new Error(`the double has no answer for ${side}:${call}`));
  };
  return {
    db: {
      runtime: (call) => answer("runtime", call),
      toolApi: (call) => answer("toolApi", call),
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
  };
}

describe("a transient answer gives 503", () => {
  it("the phone read's connection cut under it on this database: the port throws K-05's transient answer by the call's name and SQLSTATE alone, and testPhoneParts answers 503", async () => {
    const before = await rowCounts();
    const testEnv = envOf();
    const { testPhone, page, db } = rootOver(testEnv);
    const { phones } = testPhone;
    if (phones === null) throw new Error("the binding gave no phones port");

    const direct = await cutUnderPhoneRead(() => phones.state(TP_05.fakeNumber));

    if (!("failed" in direct)) throw new Error("the read answered though its connection was cut");
    expect(direct.failed).toBeInstanceOf(TestPhoneReadTransientError);
    const { sqlstate } = direct.failed as TestPhoneReadTransientError;
    // PostgreSQL's own word for an ended backend, or a connection lost before it arrived.
    expect(["57P01", "08006"]).toContain(sqlstate);
    expect(direct.failed).toMatchObject({
      call: READ_PHONE_STATE_CALL,
      message: `readPhoneState: the database could not answer now (transient, SQLSTATE ${String(sqlstate)})`,
    });
    expectNothingOf(poolBinding(JOB), direct.failed);

    const cut = await cutUnderPhoneRead(() =>
      page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-05")),
    );

    if (!("answered" in cut)) throw new Error("the page call threw");
    expect(cut.answered.status).toBe(503);
    expect(cut.answered.outcome).toEqual({ ok: false, error: "unavailable", trace_id: cut.answered.traceId });
    expect(cut.answered.span).toMatchObject({ outcome: "failed", error_code: "handlerFailed" });
    expect(cut.answered.failure).toMatchObject({ error: "TestPhoneReadTransientError" });
    expect(db.counts()).toMatchObject({ connectionsOpen: 0 });
    expect(await rowCounts()).toEqual(before);
    // The rows are read again at the next call: nothing of the failure is kept.
    expect((await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-05"))).status).toBe(200);
  });

  it("each read's transient answer through a handle double: both calls answer 503 and no read after it is made", async () => {
    const tester = { standing: "tester" };
    const tp05 = { handleId: TP_05.handleId, phone: { number: TP_05.fakeNumber, email: null } };
    const transient = { error: "transient", sqlstate: "40001" };
    const cases: readonly [string, Record<string, unknown>, PageCallName[]][] = [
      [
        READ_TESTER_STANDING_CALL,
        { [READ_TESTER_STANDING_CALL]: transient },
        ["testPhoneSend", "testPhoneParts"],
      ],
      [
        READ_ROSTER_PHONE_CALL,
        { [READ_TESTER_STANDING_CALL]: tester, [READ_ROSTER_PHONE_CALL]: transient },
        ["testPhoneSend", "testPhoneParts"],
      ],
      [
        READ_PHONE_STATE_CALL,
        {
          [READ_TESTER_STANDING_CALL]: tester,
          [READ_ROSTER_PHONE_CALL]: tp05,
          [READ_PHONE_STATE_CALL]: transient,
        },
        ["testPhoneParts"],
      ],
    ];
    const order = [READ_TESTER_STANDING_CALL, READ_ROSTER_PHONE_CALL, READ_PHONE_STATE_CALL];
    for (const [read, answers, calls] of cases) {
      for (const call of calls) {
        const what = `${read} in ${call}`;
        const { db, calls: made } = answeringDb(answers);
        const { page } = rootOver(envOf(), db);
        const request =
          call === "testPhoneSend"
            ? sendRequest(PAGE_TOKENS.checkTester, "tp-05")
            : partsRequest(PAGE_TOKENS.checkTester, "tp-05");

        const answer = await page(call, request);

        expect(answer.status, what).toBe(503);
        expect(answer.span, what).toMatchObject({ outcome: "failed", error_code: "handlerFailed" });
        expect(answer.failure, what).toMatchObject({ error: "TestPhoneReadTransientError" });
        // The reads up to the transient one, in order, on the runtime side alone.
        const upTo = order.slice(0, order.indexOf(read) + 1);
        expect(made, what).toEqual(upTo.map((name) => `runtime:${name}`));
      }
    }
  });
});

describe("bound but failing: every failure is thrown, by a name, a call or a SQLSTATE alone, and both calls answer 503", () => {
  it("the file's two bindings crossed (HYPERDRIVE_JOB holding the Tool API's login): the guard refuses the read before it runs, so it never runs as rosie_app", async () => {
    const testEnv = envOf({ job: APP });
    const { testPhone, page, lines, db } = rootOver(testEnv);

    const refused = await rejectionOf(
      testPhone.access?.standing(await sha256Hex(PAGE_TOKENS.checkTester), AT) ?? Promise.resolve(),
    );

    expect(refused).toBeInstanceOf(DbGuardRefusal);
    expect(refused).toMatchObject({ side: "runtime", binding: "HYPERDRIVE_JOB" });
    expect((refused as DbGuardRefusal).checks).toContain("session_user");
    expectNothingOf(poolBinding(APP), refused);
    for (const [call, request] of [
      ["testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-01")],
      ["testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-01")],
    ] as const) {
      const answer = await page(call, request);
      expect(answer.status, call).toBe(503);
      expect(answer.failure, call).toMatchObject({ error: "DbGuardRefusal" });
    }
    // Each refusal's one log line: the side, the binding's name and the failed checks' labels (T-1254); no timing line.
    expect(jsonLinesOf(testLog, "dbGuardRefused")).toHaveLength(3);
    expect(lines()).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 3, ended: 3, connectionsOpen: 0 });
  });

  it("a database that is not there (the pool's own HYPERDRIVE_JOB, on rosie_rig_none) and DB_SCHEMA set: thrown by the call's name and its SQLSTATE or reason alone", async () => {
    const notThere = rootOver(envOf({ job: POOL_OWN_JOB }));
    const schemaSet = envOf({ schema: "preview_t1305" });
    const withSchema = rootOver(schemaSet);
    const hash = await sha256Hex(PAGE_TOKENS.checkTester);

    const noDatabase = await rejectionOf(notThere.testPhone.access?.standing(hash, AT) ?? Promise.resolve());
    const closed = await rejectionOf(withSchema.testPhone.access?.standing(hash, AT) ?? Promise.resolve());

    expect(noDatabase).toBeInstanceOf(DataAccessDatabaseError);
    expect(noDatabase).toMatchObject({
      call: READ_TESTER_STANDING_CALL,
      code: "3D000",
      table: null,
      constraint: null,
    });
    expectNothingOf(poolBinding(POOL_OWN_JOB), noDatabase);
    expect(closed).toBeInstanceOf(DbClosedError);
    expect(closed).toMatchObject({
      call: READ_TESTER_STANDING_CALL,
      side: "runtime",
      binding: "HYPERDRIVE_JOB",
      reason: "dbSchemaSet",
    });
    // No client is opened through the binding while DB_SCHEMA is set: its string is read 0 times.
    expect(schemaSet.job?.reads.n).toBe(0);
    for (const { page } of [notThere, withSchema]) {
      const answer = await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-01"));
      expect(answer.status).toBe(503);
      expect(answer.span).toMatchObject({ outcome: "failed", error_code: "handlerFailed" });
    }
    expect(notThere.lines()).toEqual([]);
    expect(withSchema.lines()).toEqual([]);
    expect(withSchema.db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });

  it("with no TEST_PHONE_LINE bound, read at the call: testPhoneParts answers 503 (NoTestPhoneLineError) after the reads that admit it, and testPhoneSend, which never reaches the line, still sends", async () => {
    const testEnv = envOf({ absent: ["TEST_PHONE_LINE"] });
    const { testPhone, page, lines } = rootOver(testEnv);

    await expect(testPhone.line?.partsTo(TP_01.fakeNumber)).rejects.toThrow(new NoTestPhoneLineError());
    const parts = await page("testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-01"));
    const sent = await page("testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-01"));

    expect(parts.status).toBe(503);
    expect(parts.failure).toMatchObject({ error: "NoTestPhoneLineError" });
    expect(sent.status).toBe(200);
    expect(sent.outcome).toMatchObject({ result: "sent" });
    expect(callsOf(lines())).toEqual([
      READ_TESTER_STANDING_CALL,
      READ_ROSTER_PHONE_CALL,
      READ_TESTER_STANDING_CALL,
      READ_ROSTER_PHONE_CALL,
    ]);
    // The line is read at each call, and each found none.
    expect(testEnv.names.filter((name) => name === "TEST_PHONE_LINE")).toHaveLength(2);
  });
});

// ---- unbound, production, and what the build reads ---------------------------------------------------------------------

describe("unbound and production: null, so both page calls stay as they were", () => {
  it("HYPERDRIVE_JOB not bound and HYPERDRIVE_APP bound: null, both calls stay unconfigured (503, notConnected), and nothing is read but the binding's presence", async () => {
    const testEnv = envOf({ job: null });
    const db = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(db);
    OWN_PART_ENVS.push(testEnv);

    expect(stagingTestPhone({ env: testEnv.env, db })).toBeNull();
    const inputs = stagingOptions(testEnv.env, { db, builders: EVERY_OTHER_PART_UNBOUND });
    expect(inputs.testPhone).toBeNull();
    const root = composeRoot({
      environment: environmentOf(testEnv.env),
      actors: null,
      vars: { ENVIRONMENT: "staging", GIT_SHA: "test-sha" },
      ...inputs,
    });
    expect(root.gateway.pages).toBeUndefined();
    const page = pagesOf(() => root.gateway);
    for (const [call, request] of [
      ["testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-01")],
      ["testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-01")],
    ] as const) {
      const answer = await page(call, request);
      expect(answer.status, call).toBe(503);
      expect(answer.span, call).toMatchObject({ outcome: "failed", error_code: "notConnected" });
    }
    expect(new Set(testEnv.names)).toEqual(new Set(["ENVIRONMENT", "HYPERDRIVE_JOB"]));
    expect(testEnv.lineCalls).toEqual([]);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
  });

  it("production: the builder gives null and reads ENVIRONMENT alone, and through the Worker's own root both calls answer stagingOnly with nothing read", async () => {
    const testEnv = envOf({ environment: "production" });
    const db = stagingDb(testEnv.env, { write: (line) => LOGGED.push(line) });
    HANDLES.push(db);

    expect(stagingTestPhone({ env: testEnv.env, db })).toBeNull();
    expect(testEnv.names).toEqual(["ENVIRONMENT"]);
    const root = workerRoot(testEnv.env);
    expect(root.gateway.pages).toBeUndefined();
    const worker = createWorker(() => root.gateway);
    for (const [call, request] of [
      ["testPhoneSend", sendRequest(PAGE_TOKENS.checkTester, "tp-01")],
      ["testPhoneParts", partsRequest(PAGE_TOKENS.checkTester, "tp-01")],
    ] as const) {
      const response = await Promise.resolve(
        worker.fetch(
          pagePost(pagePathOf(call), request, crypto.randomUUID()),
          { ...WORKER_VARS, ENVIRONMENT: "production", BASE_PATH: "" },
          createExecutionContext(),
        ),
      );
      expect(response.status, call).toBe(200);
      expect(await response.json(), call).toEqual({ error: "stagingOnly" });
    }
    expect(testEnv.names.filter((name) => name.startsWith("HYPERDRIVE"))).toEqual([]);
    expect([testEnv.job?.reads.n, testEnv.app.reads.n]).toEqual([0, 0]);
    expect(testEnv.lineCalls).toEqual([]);
    expect(jsonLinesOf(testLog, "dbCall")).toEqual([]);
  });

  it("on staging the build reads ENVIRONMENT and HYPERDRIVE_JOB's presence alone, every other part unbound (DL-768, DL-776): no connection string, no ROSIE_NUMBER, no TEST_PHONE_LINE", () => {
    const testEnv = envOf();
    const { db } = stagedOver(testEnv);

    // stagingOptions' own check, then this part's: the environment and the binding's presence.
    expect(testEnv.names).toEqual(["ENVIRONMENT", "ENVIRONMENT", "HYPERDRIVE_JOB"]);
    expect(testEnv.job?.reads.n).toBe(0);
    expect(db.counts()).toMatchObject({ opened: 0, ended: 0 });
    // The line, made at build, reads its binding at each call alone.
    stagingLineOf(testEnv.env);
    expect(testEnv.names).toHaveLength(3);
  });
});

// ---- nothing leaks, nothing written -----------------------------------------------------------------------------------

describe("the span and log capture of every test above", () => {
  it("holds no token, hash, number, email, short code, ready text or chat link's address; every timing line is the job side's; no row count moved; no unhandled rejection", async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    // The capture is not empty: the page entry's spans, the gateway's, and every read's timing line are in it.
    const spans = jsonLinesOf(LOGGED, "span") as unknown as Span[];
    expect(spans.length).toBeGreaterThanOrEqual(20);
    const reads = (jsonLinesOf(LOGGED, "dbCall") as unknown as DbCallLine[]).filter((line) =>
      [READ_TESTER_STANDING_CALL, READ_ROSTER_PHONE_CALL, READ_PHONE_STATE_CALL].includes(String(line.call)),
    );
    expect(reads.length).toBeGreaterThanOrEqual(40);
    expectJobSide(reads);

    expect(leaks(spans, FORBIDDEN)).toEqual([]);
    const lowered = LOGGED.map((line) => line.toLowerCase());
    for (const value of FORBIDDEN) {
      expect(
        lowered.filter((line) => line.includes(value.toLowerCase())),
        "a log line holds a value it must not",
      ).toEqual([]);
    }
    expect(lowered.filter((line) => /\+[0-9]{7,15}/u.test(line) || line.includes("@example.com"))).toEqual(
      [],
    );
    expect(lowered.filter((line) => line.includes("sms:"))).toEqual([]);
    expect(await rowCounts()).toEqual(SEEDED_ROWS);
    expect(rejections.map((reason) => String(reason))).toEqual([]);
  });
});
