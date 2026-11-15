// T-1288 (ADR-016 card F and section 5): staging's email port (./email.ts, the router), the claim's emailPurpose and
// notAfter mapped through, emailFor beside chatTargetOf and the email row's renewal (../real.ts), the email door
// (../email-door.ts) and the root's binding (../root.ts, ./options.ts), inside the Workers runtime. No database of its
// own, so no entry on the rig's list: K-05's answers are doubles that answer as the frozen fixtures state
// (claim-sam-sign-in-code.json, claim-in-order-with-port.json, renew-claim-first-send.json, send-state-customer.json),
// Resend is a fetch double that keeps each request and reaches no network, and the test-phone line is the pool's own
// TEST_PHONE_LINE (wrangler.jsonc env.staging: the TestPhoneLine the Worker exports), whose email double keeps what it
// accepts where the test-phone page lists it (sentEmails).
//
//   - the router: a code to a listed inbox reaches T-419's adapter once and nothing reaches the line; any other purpose
//     to it, and a code to any other address, reach the line's double, which lists them; with no list (unset, blank,
//     one entry that is no address) every request reaches the double; with no key a listed code is refused and sent no
//     other way; each log line names only the missing name; nothing is read to make it, the list and the key at sends;
//   - emailFor: the address for an email handle, none for a phone, none with no read or another recipient's read;
//   - the claim: claim-sam-sign-in-code.json's row keeps its purpose and its end; a v1.2 row has neither;
//   - the renewal: an email row this port claimed renews with no phone row; a text row, or an email row it did not
//     claim, does not (the phone row: notFound);
//   - through the root on staging: the code row's run sends one email to Resend in K-12 send-code.json's form and marks
//     it sent; anywhere but staging the root binds no email port (noEmailPort); a send that throws is K-12's no answer,
//     the key kept and never a rejected run; an address lookup that throws is no address;
//   - the part: no line, no port (DL-768), with nothing read; through stagingOptions every other part unbound, bound
//     only beside the test-phone part's line; production and staging with no Hyperdrive binding give none.
// Test values only (rule 9): the contracts' fixtures, the master's sample cast, made-up keys and ids, addresses on the
// reserved example domains, and one whole fiction-range number (555-0101, Alex's in the fixtures).
import { RESEND_EMAILS_URL } from "@rosie/adapters/email/resend-send";
import claimInOrderWithPort from "@rosie/contracts/data-access/fixtures/claim-in-order-with-port.json";
import claimSamSignInCode from "@rosie/contracts/data-access/fixtures/claim-sam-sign-in-code.json";
import renewClaimFirstSend from "@rosie/contracts/data-access/fixtures/renew-claim-first-send.json";
import sendStateCustomer from "@rosie/contracts/data-access/fixtures/send-state-customer.json";
import sendCode from "@rosie/contracts/port-email/fixtures/send-code.json";
import sendCopyOfText from "@rosie/contracts/port-email/fixtures/send-copy-of-text.json";
import type {
  ClaimedRowV12,
  ClaimOutboxV12Outcome,
  ClaimOutboxV114Outcome,
  MarkPartV12Outcome,
  MarkRowV12Outcome,
  RenewClaimOutcome,
} from "@rosie/db/repo/outbox";
import type { SendStateResponse } from "@rosie/db/repo/send-state";
import { env as poolEnv } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDispatch } from "../../dispatch/dispatcher";
import { traceCollector } from "../../dispatch/test-support";
import type { RecipientDirectory, SendStateReader } from "../../dispatch/types";
import {
  ASSISTANT_LINE,
  CODE_SUBJECT,
  ROSIE_FROM_ADDRESS,
  type EmailRowsDeps,
  type EmailSendOutcome,
  type EmailSendPort,
  type EmailSendRequest,
} from "../../email";
import { openTrace, type Span } from "../../trace";
import {
  answeringRecipients,
  EMAIL_SEND_THREW,
  EMAIL_SEND_TIMEOUT,
  emailDoor,
  type EmailNoAnswerLine,
} from "../email-door";
import { chatTargetOf, claimedRowOf, realOutbox, realSendState, type OutboxCalls } from "../real";
import { composeRoot, type Root } from "../root";
import { skeletonFakes } from "../test-support";
import type { TestPhoneInputs, TestPhoneLinePort } from "../test-phone";
import { stagingEmail, stagingEmailRouter, type EmailMissingLine } from "./email";
import { NO_RECEIPT_INPUTS } from "./k05-receipt";
import { NO_TURN_CALL_INPUTS } from "./k05-turn";
import { NO_MODEL_READER_INPUTS } from "./models";
import { NO_STAGING_INPUTS, stagingOptions, type StagingBuilders } from "./options";
import type { StagingDb, StagingEnv } from "./part";
import { NO_SEND_INPUTS } from "./send";
import { NO_DIRECTORY_INPUTS } from "./state-reads";
import { stagingLineOf } from "./test-phone";
import { NO_ROW_INPUTS } from "./tool-api-rows";

// ---- the values ---------------------------------------------------------------------------------------------------

/** Sam's proven address, his email handle's (K-05 v1.13's sign-in fixtures), on the list here: a tester's inbox. */
const SAM_ADDRESS = "sam@example.com";
/** Another tester's inbox on the list. */
const RILEY_ADDRESS = "riley@example.net";
/** An address on no list. */
const DEE_ADDRESS = "dee@example.org";
/** The named inboxes as put-staging-secrets.sh puts them: joined by commas with no space (DL-549). */
const INBOXES = `${SAM_ADDRESS},${RILEY_ADDRESS}`;
/** A made-up send-only key: never a key of anything. */
const MADE_UP_KEY = "t1288-made-up-send-only-key-0001";
/** Resend's id for an email it took, made up. */
const RESEND_ID = "t1288-resend-email-0001";

/** Sam's sign-in code row as K-05 v1.13 claims it (claim-sam-sign-in-code.json), its email handle and its words. */
const SAM_ROW = claimSamSignInCode.outcome.claimed[0] as unknown as ClaimedRowV12;
const ROW_ID = "out-sam-sign-in-nov02-code";
const PART_KEY = `${ROW_ID}/1/1`;
const SAM_EMAIL = "handle-sam-email";
const CODE_WORDS = "Code 482913: type it on the sign-in page. It works for 10 minutes.";
/** The code's six digits: never in a span or a log line. */
const CODE = "482913";
/** The fixture's own now: the claim right after the code's commit, inside the code's 10 minutes. */
const CLAIMED_AT = "2026-11-02T13:00:02Z";
const NOT_AFTER = "2026-11-02T13:10:01Z";

/** Alex's confirmation as K-05 v1.2 claims it (claim-in-order-with-port.json): a text row, by the linq port. */
const ALEX_ROW = claimInOrderWithPort.outcome.claimed[0] as unknown as ClaimedRowV12;

/** Every address and the key: never in a log line or a span. */
const NEVER_LOGGED = [SAM_ADDRESS, RILEY_ADDRESS, DEE_ADDRESS, INBOXES, MADE_UP_KEY, CODE];

// ---- the env, the line and Resend ---------------------------------------------------------------------------------

/** The pool's test-phone line (env.staging's TEST_PHONE_LINE). */
function poolLine(): NonNullable<typeof poolEnv.TEST_PHONE_LINE> {
  const line = poolEnv.TEST_PHONE_LINE;
  if (line === undefined) throw new Error("env.staging binds no TEST_PHONE_LINE");
  return line;
}

interface CountedEnv {
  readonly env: StagingEnv;
  /** The env's own values: a test may change one between sends. */
  readonly values: Record<string, unknown>;
  /** Every name read from the env, by a get or an `in`, in order. */
  readonly names: string[];
}

/**
 * The Worker's env on staging as the router reads it, each read counted: the vars, the pool's test-phone line, the
 * made-up key and the inbox list, with `changes` laid over them (undefined: the name is not in the env at all).
 */
function envOf(changes: Record<string, unknown> = {}): CountedEnv {
  const names: string[] = [];
  const values: Record<string, unknown> = {
    ENVIRONMENT: "staging",
    BASE_PATH: "/test",
    DB_SCHEMA: "",
    GIT_SHA: "test-sha",
    TEST_PHONE_LINE: poolLine(),
    RESEND_API_KEY: MADE_UP_KEY,
    STAGING_TEST_INBOXES: INBOXES,
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
  return { env: env as unknown as StagingEnv, values, names };
}

/** One request Resend's send call got: where it went and what of it a test reads. */
interface ResendCall {
  readonly url: string;
  readonly method: string;
  readonly idempotencyKey: string | null;
  readonly keyed: boolean;
  readonly body: {
    readonly from: string;
    readonly to: string[];
    readonly subject: string;
    readonly text: string;
  };
}

/** Resend's send call as a double: it keeps each request and answers 200 with an id, as Resend takes an email. */
function resendDouble(): { fetch: (request: Request) => Promise<Response>; calls: ResendCall[] } {
  const calls: ResendCall[] = [];
  return {
    calls,
    async fetch(request) {
      calls.push({
        url: request.url,
        method: request.method,
        idempotencyKey: request.headers.get("Idempotency-Key"),
        keyed: request.headers.get("Authorization") === `Bearer ${MADE_UP_KEY}`,
        body: await request.json<ResendCall["body"]>(),
      });
      return new Response(JSON.stringify({ id: RESEND_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** The emails the line keeps to an address under one key: what the test-phone page would list for this send. */
async function listed(line: TestPhoneLinePort, address: string, key: string): Promise<EmailSendRequest[]> {
  const kept = await line.sentEmails({ to: address });
  return kept.emails.map((email) => email.request).filter((request) => request.idempotencyKey === key);
}

/** K-12 send-code.json's request (a code about no booking), to this address under a key of this test's own. */
function codeTo(address: string, key: string): EmailSendRequest {
  return { ...(structuredClone(sendCode.request) as EmailSendRequest), to: address, idempotencyKey: key };
}

/** K-12 send-copy-of-text.json's request (purpose copy), to this address under a key of this test's own. */
function copyTo(address: string, key: string): EmailSendRequest {
  return {
    ...(structuredClone(sendCopyOfText.request) as EmailSendRequest),
    to: address,
    idempotencyKey: key,
  };
}

/** A handle that reaches no database: the email part makes no call. */
const NO_DB: StagingDb = {
  runtime: () => Promise.reject(new Error("the email part made a database call")),
  toolApi: () => Promise.reject(new Error("the email part made a database call")),
  counts: () => ({
    opened: 0,
    ended: 0,
    connectionsOpen: 0,
    connectionsPeak: 0,
    quietReads: 0,
    quietWrites: 0,
  }),
};

// ---- the log ------------------------------------------------------------------------------------------------------

/** Every line the console got in the test that runs, as written. */
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  const keep = (...args: unknown[]): void => {
    logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
  // No line the console got, of any test here, holds an address, the list, the key or the code.
  for (const line of logged) {
    for (const value of NEVER_LOGGED) expect(line.includes(value), "a log line holds a value").toBe(false);
  }
});

/** The JSON lines the console got whose msg is this one. */
function linesOf(msg: string): Record<string, unknown>[] {
  return logged
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (line): line is Record<string, unknown> =>
        typeof line === "object" && line !== null && (line as { msg?: unknown }).msg === msg,
    );
}

/** The line that names one missing name, as the router writes it. */
const missingLine = (missing: EmailMissingLine["missing"]): EmailMissingLine => ({
  level: "warn",
  msg: "emailPortMissing",
  missing,
  environment: "staging",
  version: "test-sha",
});

// ---- the router ---------------------------------------------------------------------------------------------------

describe("the router: a code to a listed inbox through Resend, everything else to the test-phone line's double", () => {
  it("a code to a listed inbox reaches T-419's adapter once, one request to Resend's send call under the part's key with the key read by name, and nothing reaches the line", async () => {
    const { env } = envOf();
    const line = stagingLineOf(env);
    const resend = resendDouble();
    const router = stagingEmailRouter(env, line, { fetch: resend.fetch });
    const request = codeTo(SAM_ADDRESS, "t1288-code-listed/1/1");

    const answer = await router.sendEmail(request);

    expect(answer).toMatchObject({ result: "accepted", providerMessageId: RESEND_ID });
    expect(resend.calls).toEqual([
      {
        url: RESEND_EMAILS_URL,
        method: "POST",
        idempotencyKey: request.idempotencyKey,
        keyed: true,
        body: {
          from: `Rosie <${ROSIE_FROM_ADDRESS}>`,
          to: [SAM_ADDRESS],
          subject: request.subject,
          text: request.text,
        },
      },
    ]);
    expect(await listed(line, SAM_ADDRESS, request.idempotencyKey)).toEqual([]);
    expect(linesOf("emailPortMissing")).toEqual([]);
  });

  it("reads the list as the adapter does: in lower case, so a listed address put in capitals is listed", async () => {
    const { env } = envOf({ STAGING_TEST_INBOXES: INBOXES.toUpperCase() });
    const resend = resendDouble();
    const router = stagingEmailRouter(env, stagingLineOf(env), { fetch: resend.fetch });

    expect(await router.sendEmail(codeTo(RILEY_ADDRESS, "t1288-code-capitals/1/1"))).toMatchObject({
      result: "accepted",
    });
    expect(resend.calls.map((call) => call.body.to)).toEqual([[RILEY_ADDRESS]]);
  });

  it("any other purpose to a listed inbox, and a code to any other address, reach the line's double, which lists them; nothing reaches Resend and no line is logged", async () => {
    const { env } = envOf();
    const line = stagingLineOf(env);
    const resend = resendDouble();
    const router = stagingEmailRouter(env, line, { fetch: resend.fetch });
    const copy = copyTo(SAM_ADDRESS, "t1288-copy-listed/1/1");
    const code = codeTo(DEE_ADDRESS, "t1288-code-not-listed/1/1");

    expect(await router.sendEmail(copy)).toMatchObject({ result: "accepted" });
    expect(await router.sendEmail(code)).toMatchObject({ result: "accepted" });

    expect(resend.calls).toEqual([]);
    expect(await listed(line, SAM_ADDRESS, copy.idempotencyKey)).toEqual([copy]);
    expect(await listed(line, DEE_ADDRESS, code.idempotencyKey)).toEqual([code]);
    expect(logged).toEqual([]);
  });

  it.each([
    ["not in the env", undefined],
    ["empty", ""],
    ["blank", "  "],
    ["one entry that is no address", `${SAM_ADDRESS},not-an-address`],
  ])(
    "with the list %s, every request reaches the double, a code to a would-be listed address among them, and each code's one line names STAGING_TEST_INBOXES alone",
    async (_how, list) => {
      const { env } = envOf({ STAGING_TEST_INBOXES: list });
      const line = stagingLineOf(env);
      const resend = resendDouble();
      const router = stagingEmailRouter(env, line, { fetch: resend.fetch });
      const tag = `t1288-no-list-${String(list?.length ?? "none")}`;
      const code = codeTo(SAM_ADDRESS, `${tag}-code/1/1`);
      const copy = copyTo(RILEY_ADDRESS, `${tag}-copy/1/1`);

      expect(await router.sendEmail(code)).toMatchObject({ result: "accepted" });
      expect(await router.sendEmail(copy)).toMatchObject({ result: "accepted" });

      expect(resend.calls).toEqual([]);
      expect(await listed(line, SAM_ADDRESS, code.idempotencyKey)).toEqual([code]);
      expect(await listed(line, RILEY_ADDRESS, copy.idempotencyKey)).toEqual([copy]);
      // Only the code's route hangs on the list: one line, for it.
      expect(logged.map((text) => JSON.parse(text) as unknown)).toEqual([
        missingLine("STAGING_TEST_INBOXES"),
      ]);
    },
  );

  it.each([
    ["not in the env", undefined],
    ["empty", ""],
  ])(
    "with the key %s, a code to a listed inbox is refused (K-12 refused, 401 missing_api_key), sent no other way, and one line names RESEND_API_KEY alone",
    async (_how, key) => {
      const { env } = envOf({ RESEND_API_KEY: key });
      const line = stagingLineOf(env);
      const resend = resendDouble();
      const router = stagingEmailRouter(env, line, { fetch: resend.fetch });
      const code = codeTo(SAM_ADDRESS, `t1288-no-key-${String(key?.length ?? "none")}/1/1`);

      const answer = await router.sendEmail(code);

      expect(answer).toMatchObject({
        result: "failed",
        kind: "refused",
        httpStatus: 401,
        code: "missing_api_key",
      });
      // Not to Resend, and not to the double either: refused is the row's answer.
      expect(resend.calls).toEqual([]);
      expect(await listed(line, SAM_ADDRESS, code.idempotencyKey)).toEqual([]);
      expect(logged.map((text) => JSON.parse(text) as unknown)).toEqual([missingLine("RESEND_API_KEY")]);
    },
  );

  it("reads nothing as it is made; a copy reads the line alone, and a code reads the list at its send and, listed, the key", async () => {
    const counted = envOf();
    const resend = resendDouble();

    const router = stagingEmailRouter(counted.env, stagingLineOf(counted.env), { fetch: resend.fetch });
    expect(counted.names).toEqual([]);

    await router.sendEmail(copyTo(RILEY_ADDRESS, "t1288-reads-copy/1/1"));
    expect(new Set(counted.names)).toEqual(new Set(["TEST_PHONE_LINE"]));

    counted.names.length = 0;
    await router.sendEmail(codeTo(SAM_ADDRESS, "t1288-reads-code/1/1"));
    expect(new Set(counted.names)).toEqual(new Set(["STAGING_TEST_INBOXES", "RESEND_API_KEY"]));

    // Read at each send: Sam's inbox taken off the list, his next code goes to the double.
    counted.values.STAGING_TEST_INBOXES = RILEY_ADDRESS;
    const next = codeTo(SAM_ADDRESS, "t1288-reads-code-2/1/1");
    await router.sendEmail(next);
    expect(resend.calls).toHaveLength(1);
    expect(await listed(stagingLineOf(counted.env), SAM_ADDRESS, next.idempotencyKey)).toEqual([next]);
  });
});

// ---- emailFor -------------------------------------------------------------------------------------------------------

/** K-05's send state for Sam's code row: his email handle (no phone row, no chat), no texts row and no business. */
const SAM_STATE = {
  ...(structuredClone(sendStateCustomer.outcome) as unknown as SendStateResponse),
  outboxRowId: ROW_ID,
  recipient: { handleId: SAM_EMAIL, kind: "email", address: SAM_ADDRESS, personId: "person-sam" },
  phone: null,
  chat: null,
  textsConsent: null,
  zone: null,
  businessZone: null,
  textHours: null,
  textHoursOverride: false,
  currentVersions: [],
  booking: null,
} as unknown as SendStateResponse;

/** Alex's, as send-state-customer.json gives it: a phone, his chat open with Linq's chat id. */
const ALEX_STATE = structuredClone(sendStateCustomer.outcome) as unknown as SendStateResponse;

describe("emailFor beside chatFor, from the same send-state read (../real.ts emailTargetOf)", () => {
  it("answers the address for an email handle and no chat; the chat for a phone and no address; none before a read, and none for a read that named another recipient", async () => {
    const answers: Record<string, SendStateResponse> = {
      [ROW_ID]: SAM_STATE,
      [ALEX_ROW.outboxRowId]: ALEX_STATE,
    };
    const port = realSendState({
      call: (request) => {
        const answer = answers[request.outboxRowId];
        return answer === undefined
          ? Promise.reject(new Error("no answer for the row"))
          : Promise.resolve(structuredClone(answer));
      },
    });
    const sam = claimedRowOf(SAM_ROW);
    const alex = claimedRowOf(ALEX_ROW);

    expect(await port.recipients.emailFor?.(SAM_EMAIL)).toBeNull();
    await port.sendState.sendStateFor(sam);
    await port.sendState.sendStateFor(alex);

    expect(await port.recipients.emailFor?.(SAM_EMAIL)).toBe(SAM_ADDRESS);
    expect(await port.recipients.chatFor(SAM_EMAIL)).toBeNull();
    expect(await port.recipients.emailFor?.(alex.recipientHandleId)).toBeNull();
    expect(await port.recipients.chatFor(alex.recipientHandleId)).toEqual(chatTargetOf(ALEX_STATE));

    // A read whose recipient is another handle than the row's gives the row's recipient nothing (fails closed).
    await port.sendState.sendStateFor({ ...sam, recipientHandleId: "handle-sam-other" });
    expect(await port.recipients.emailFor?.("handle-sam-other")).toBeNull();
  });
});

// ---- the claim and the renewal ----------------------------------------------------------------------------------------

/** One call the K-05 double was asked, by name (markPart and markRow with their outcome). */
type K05Call = string;

/**
 * K-05's outbox calls as a double, over one claim's answer (v1.14's, in v1.13's form): the rows are handed out at the
 * first claim with this claimer, none after; a renewal answers renewed with the phone row `phone` gives (null: none read);
 * a mark answers marked. Each call is kept by its name.
 */
function k05Outbox(
  rows: readonly ClaimedRowV12[],
  phone: (outboxRowId: string) => unknown = () => null,
): { calls: OutboxCalls; made: K05Call[] } {
  const made: K05Call[] = [];
  let handedOut = false;
  const claimed = (claimer: string) =>
    ({
      result: "claimed",
      claimed: handedOut
        ? []
        : rows.map((row) => ({ ...structuredClone(row), claim: { ...row.claim, claimer } })),
      passedHeld: [],
    }) as unknown as ClaimOutboxV114Outcome;
  return {
    made,
    calls: {
      claimOutboxV12: () => {
        made.push("claimOutboxV12");
        return Promise.resolve({ result: "claimed", claimed: [], passedHeld: [] } as ClaimOutboxV12Outcome);
      },
      claimOutboxV114: (request) => {
        made.push("claimOutboxV114");
        const answer = claimed(request.claimer);
        handedOut = true;
        return Promise.resolve(answer);
      },
      renewClaim: (request) => {
        made.push("renewClaim");
        return Promise.resolve({
          ...structuredClone(renewClaimFirstSend.outcome),
          outboxRowId: request.outboxRowId,
          claim: { ...renewClaimFirstSend.outcome.claim, claimer: request.claimer, firstTryAt: request.at },
          recipient: phone(request.outboxRowId),
        } as unknown as RenewClaimOutcome);
      },
      markPartV12: (request) => {
        made.push(`markPart:${request.outcome}`);
        return Promise.resolve({
          result: "marked",
          outboxRowId: ROW_ID,
          partNo: 1,
          tryNo: 1,
          attempts: 1,
          repeated: false,
          firstDelivery: false,
          openQuestionId: null,
          nextKey: null,
          row: { state: "sent", version: 4 },
          repeatedDelivery: null,
        } as unknown as MarkPartV12Outcome);
      },
      markRowV12: (request) => {
        made.push(`markRow:${request.outcome}`);
        return Promise.resolve({
          result: "marked",
          outboxRowId: request.outboxRowId,
          version: request.expectVersion + 1,
          outcome: request.outcome,
        } as unknown as MarkRowV12Outcome);
      },
    },
  };
}

/** The renewal the dispatcher makes for a row's first part, as its claimer, at the fixture's now. */
const renewalOf = (row: ClaimedRowV12) => ({
  outboxRowId: row.outboxRowId,
  claimer: "dispatcher-t1288",
  claimNo: 1,
  idempotencyKey: `${row.outboxRowId}/1/1`,
  at: CLAIMED_AT,
});

describe("the claim's emailPurpose and notAfter, mapped through (K-05 v1.13 item 64)", () => {
  it("claimedRowOf keeps claim-sam-sign-in-code.json's purpose and end as stored; a v1.2 row has neither field", () => {
    const sam = claimedRowOf(SAM_ROW);
    const alex = claimedRowOf(ALEX_ROW);

    expect(sam).toMatchObject({ port: "email", channel: "email", emailPurpose: "code", notAfter: NOT_AFTER });
    expect("emailPurpose" in alex || "notAfter" in alex).toBe(false);
    // A v1.13 text row names none: its nulls go across as they are.
    const nulls = claimedRowOf({ ...ALEX_ROW, emailPurpose: null, notAfter: null });
    expect([nulls.emailPurpose, nulls.notAfter]).toEqual([null, null]);
  });

  it("the outbox port hands the dispatcher the code row with its purpose and end, through v1.14's claim", async () => {
    const k05 = k05Outbox([SAM_ROW]);
    const store = realOutbox({ calls: k05.calls });

    const answer = await store.claimOutbox({ claimer: "dispatcher-t1288", now: CLAIMED_AT, limit: 10 });

    if ("error" in answer) throw new Error("the claim answered an error");
    expect(answer.claimed.map((row) => [row.outboxRowId, row.emailPurpose, row.notAfter])).toEqual([
      [ROW_ID, "code", NOT_AFTER],
    ]);
    expect(k05.made).toEqual(["claimOutboxV114"]);
  });
});

describe("the renewal of an email row: an email address has no phone row (K-05 item 32)", () => {
  it("an email row this port claimed is renewed though its renewal read no phone row", async () => {
    const k05 = k05Outbox([SAM_ROW]);
    const store = realOutbox({ calls: k05.calls });
    await store.claimOutbox({ claimer: "dispatcher-t1288", now: CLAIMED_AT, limit: 10 });

    expect(await store.renewClaim(renewalOf(SAM_ROW))).toMatchObject({
      result: "renewed",
      outboxRowId: ROW_ID,
    });
  });

  it("a text row whose renewal read no phone row is not renewed (notFound, the phone row), nor an email row this port did not claim", async () => {
    const k05 = k05Outbox([ALEX_ROW]);
    const store = realOutbox({ calls: k05.calls });
    await store.claimOutbox({ claimer: "dispatcher-t1288", now: CLAIMED_AT, limit: 10 });

    expect(await store.renewClaim(renewalOf(ALEX_ROW))).toEqual({
      error: "notFound",
      table: "phones",
      rowId: ALEX_ROW.outboxRowId,
    });
    // A port that never claimed Sam's row: its port not known here, so its renewal is refused as a text row's.
    const other = realOutbox({ calls: k05Outbox([SAM_ROW]).calls });
    expect(await other.renewClaim(renewalOf(SAM_ROW))).toEqual({
      error: "notFound",
      table: "phones",
      rowId: ROW_ID,
    });
  });
});

// ---- through the root ---------------------------------------------------------------------------------------------

interface Rooted {
  readonly root: Root;
  readonly k05: ReturnType<typeof k05Outbox>;
  readonly resend: ReturnType<typeof resendDouble>;
  readonly line: TestPhoneLinePort;
  readonly spans: Span[];
  /** The code's dispatch, as the code's commit wakes it for Sam's email handle (ADR-016 section 2). */
  wake(): Promise<void>;
}

/**
 * A root as the Worker composes one (composeRoot), its ports on the test environment's picks: K-05's outbox calls and
 * sendState over the doubles here (the code row, Sam's email handle's state), and the email port staging's own builder
 * makes over `env`, with Resend's double. `environment` is the Worker's ENVIRONMENT var.
 */
function rootOver(counted: CountedEnv, environment = "staging"): Rooted {
  const k05 = k05Outbox([SAM_ROW]);
  const resend = resendDouble();
  const line = stagingLineOf(counted.env);
  const emailRows = stagingEmail({ env: counted.env, db: NO_DB, line }, { fetch: resend.fetch });
  const spans: Span[] = [];
  const root = composeRoot({
    environment: "test",
    sets: { fake: skeletonFakes().ports },
    actors: null,
    vars: { ENVIRONMENT: environment, GIT_SHA: "test-sha" },
    clock: { now: () => Date.parse(CLAIMED_AT), after: () => Promise.resolve() },
    outboxCalls: k05.calls,
    sendStateCall: () => Promise.resolve(structuredClone(SAM_STATE)),
    emailRows,
  });
  const trace = openTrace({
    openedBy: "pageRequest",
    bundleId: { hash: "0123456789abcdef".repeat(4), build: 1 },
    sink: (span) => spans.push(span),
  });
  return {
    root,
    k05,
    resend,
    line,
    spans,
    // The sign-in's own wake is T-1289's: the turn's wake stands in, naming the recipient (its turn id is not read).
    wake: () =>
      root.dispatcher.wake({ turnId: "t1288-no-turn", handleId: SAM_EMAIL, outboxRowIds: [ROW_ID] }, trace),
  };
}

/** The dispatch span's outcome, result and error code. */
const dispatchOf = (spans: readonly Span[]): unknown[] =>
  spans
    .filter((span) => span.hop === "dispatch")
    .map((span) => [
      span.outcome,
      (span.decided as { result?: unknown } | undefined)?.result,
      span.error_code,
    ]);

describe("through the root: the code row's dispatch on staging", () => {
  it("claims the code with its purpose and end, reads Sam's address from the send state, renews with no phone row, and sends one email through the router to Resend in K-12 send-code.json's form with the sign-in line; the part is marked sent and nothing reaches the line", async () => {
    const run = rootOver(envOf());

    await run.wake();

    expect(run.k05.made).toEqual(["claimOutboxV114", "renewClaim", "markPart:sent"]);
    expect(run.resend.calls).toEqual([
      {
        url: RESEND_EMAILS_URL,
        method: "POST",
        idempotencyKey: PART_KEY,
        keyed: true,
        body: {
          from: `Rosie <${ROSIE_FROM_ADDRESS}>`,
          to: [SAM_ADDRESS],
          subject: CODE_SUBJECT,
          text: `${ASSISTANT_LINE}\n\n${CODE_WORDS}`,
        },
      },
    ]);
    expect(await listed(run.line, SAM_ADDRESS, PART_KEY)).toEqual([]);
    expect(dispatchOf(run.spans)).toEqual([["ok", "sent", null]]);
    expect(run.spans.find((span) => span.hop === "providerAccepted")).toMatchObject({ provider: "resend" });
    expect(linesOf("emailPortMissing")).toEqual([]);
    expect(linesOf("emailNoAnswer")).toEqual([]);
    for (const span of run.spans) {
      for (const value of NEVER_LOGGED) expect(JSON.stringify(span).includes(value)).toBe(false);
    }
  });

  it.each(["production", "test", "Staging"])(
    "with ENVIRONMENT %s the root binds no email port, whatever it is handed: the code row ends noEmailPort, with nothing renewed, sent or marked",
    async (environment) => {
      const run = rootOver(envOf(), environment);

      await run.wake();

      expect(run.k05.made).toEqual(["claimOutboxV114"]);
      expect(run.resend.calls).toEqual([]);
      expect(await listed(run.line, SAM_ADDRESS, PART_KEY)).toEqual([]);
      expect(dispatchOf(run.spans)).toEqual([["refused", "noEmailPort", null]]);
    },
  );

  it("a send that throws (staging's test-phone line not bound, for a code to an address off the list) is K-12's no answer: the run ends, never rejected, the part left pending under its key for its retry, and one line names labels only", async () => {
    const run = rootOver(envOf({ TEST_PHONE_LINE: undefined, STAGING_TEST_INBOXES: RILEY_ADDRESS }));

    await expect(run.wake()).resolves.toBeUndefined();

    // Claimed and renewed, then no answer: nothing is marked, so the part stays pending under its key (K-07 rule 1).
    expect(run.k05.made).toEqual(["claimOutboxV114", "renewClaim"]);
    expect(run.resend.calls).toEqual([]);
    expect(dispatchOf(run.spans)).toEqual([["timedOut", "failed", EMAIL_SEND_THREW]]);
    expect(run.spans.find((span) => span.hop === "dispatch")?.decided).toMatchObject({ retry: "sameKey" });
    expect(linesOf("emailNoAnswer")).toEqual([
      {
        level: "warn",
        msg: "emailNoAnswer",
        call: "sendEmail",
        why: "threw",
        error: "NoTestPhoneLineError",
        environment: "staging",
        version: "test-sha",
      } satisfies EmailNoAnswerLine,
    ]);
  });
});

// ---- the email door ---------------------------------------------------------------------------------------------------

describe("the email door (../email-door.ts): no answer is K-12's no answer, never a rejected run", () => {
  const log = { environment: "staging", version: "test-sha" };
  const code = (): EmailSendRequest => codeTo(SAM_ADDRESS, "t1288-door/1/1");

  it("hands on the port's own answer as it is, and writes nothing", async () => {
    const answer: EmailSendOutcome = {
      result: "accepted",
      providerMessageId: RESEND_ID,
      acceptedAt: CLAIMED_AT,
    };
    const door = emailDoor({ sendEmail: () => Promise.resolve(answer) }, { log });

    expect(await door.sendEmail(code())).toBe(answer);
    expect(logged).toEqual([]);
  });

  it("a send that throws as it is called, or rejects, is answered transient with no status (sendThrew); its line names the error's name alone, never its message", async () => {
    const throwing: EmailSendPort = {
      sendEmail: (request) => {
        throw new TypeError(`no way to reach ${request.to}`);
      },
    };
    const rejecting: EmailSendPort = { sendEmail: () => Promise.reject(new Error(`gone: ${SAM_ADDRESS}`)) };
    // An error whose name is no label (here it holds an address): no name is written for it either.
    const oddName = Object.assign(new Error("no answer"), { name: `gone ${SAM_ADDRESS}` });
    const notALabel: EmailSendPort = { sendEmail: () => Promise.reject(oddName) };
    const written: string[] = [];
    const write = (line: string): void => {
      written.push(line);
    };

    for (const port of [throwing, rejecting, notALabel]) {
      expect(await emailDoor(port, { log, write }).sendEmail(code())).toEqual({
        result: "failed",
        kind: "transient",
        httpStatus: null,
        code: EMAIL_SEND_THREW,
        reason: "the email port gave no answer: the send threw",
        retryAfterSeconds: null,
      });
    }
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual(
      ["TypeError", "Error", null].map((error) => ({
        level: "warn",
        msg: "emailNoAnswer",
        call: "sendEmail",
        why: "threw",
        error,
        environment: "staging",
        version: "test-sha",
      })),
    );
    expect(written.join("\n")).not.toContain(SAM_ADDRESS);
  });

  it("a send with no answer within the time limit is answered transient with no status (sendTimeout)", async () => {
    const hanging: EmailSendPort = { sendEmail: () => new Promise<never>(() => undefined) };
    const written: string[] = [];

    const answer = await emailDoor(hanging, {
      log,
      timeoutMs: 5,
      write: (line) => written.push(line),
    }).sendEmail(code());

    expect(answer).toMatchObject({
      result: "failed",
      kind: "transient",
      httpStatus: null,
      code: EMAIL_SEND_TIMEOUT,
    });
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({ msg: "emailNoAnswer", call: "sendEmail", why: "timedOut", error: null }),
    ]);
  });

  it("an address lookup that throws is no address known: the run ends noAddress with nothing sent or renewed, never rejected, and its line names labels only", async () => {
    const k05 = k05Outbox([SAM_ROW]);
    const sent: EmailSendRequest[] = [];
    const written: string[] = [];
    const directory: RecipientDirectory = {
      chatFor: () => Promise.resolve(null),
      emailFor: () => Promise.reject(new TypeError(`no address read for ${SAM_ADDRESS}`)),
    };
    const sendState: SendStateReader = realSendState({
      call: () => Promise.resolve(structuredClone(SAM_STATE)),
    }).sendState;
    const email: EmailRowsDeps = {
      port: {
        sendEmail: (request) => {
          sent.push(request);
          return Promise.resolve({
            result: "accepted",
            providerMessageId: RESEND_ID,
            acceptedAt: CLAIMED_AT,
          });
        },
      },
      fromAddress: ROSIE_FROM_ADDRESS,
    };
    const spans: Span[] = [];

    const report = await runDispatch(
      {
        store: realOutbox({ calls: k05.calls }),
        linq: { sendPart: () => Promise.reject(new Error("an email row never reaches Linq")) },
        email,
        recipients: answeringRecipients(directory, { log, write: (line) => written.push(line) }),
        sendState,
        environment: "staging",
        traceFor: traceCollector(spans),
        now: () => CLAIMED_AT,
        claimer: "dispatcher-t1288",
      },
      { recipientHandleId: SAM_EMAIL },
    );

    expect(report.rows.map((row) => row.outcome)).toEqual(["noAddress"]);
    expect(sent).toEqual([]);
    expect(k05.made).toEqual(["claimOutboxV114"]);
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({ msg: "emailNoAnswer", call: "emailFor", why: "threw", error: "TypeError" }),
    ]);
    expect(written.join("\n")).not.toContain(SAM_ADDRESS);
  });

  it("a directory with no emailFor knows no address, and its chats pass through as it gives them", async () => {
    const chat = { to: "+15555550101", chatId: "linq-chat-demo-alex", service: "imessage" as const };
    const recipients = answeringRecipients({ chatFor: () => Promise.resolve(chat) }, { log });

    expect(await recipients.emailFor?.(SAM_EMAIL)).toBeNull();
    expect(await recipients.chatFor("handle-alex")).toBe(chat);
  });
});

// ---- the part ---------------------------------------------------------------------------------------------------------

/**
 * Every part but this card's and the test-phone part's, stood in by its nothing-bound answer (DL-776): the sign-in part
 * (T-1289) too, which is bound beside the email port.
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
  signIn: () => null,
};

/** The test-phone part's input with a line and nothing else: the one input this card's part is handed. */
const testPhoneWith = (line: TestPhoneLinePort | null): TestPhoneInputs => ({
  access: null,
  roster: null,
  phones: null,
  line,
});

describe("the part (./email.ts stagingEmail) and its place in stagingOptions (DL-768, DL-776)", () => {
  it("with no line it gives null, and with one the router and the From address; it reads nothing either way", () => {
    const counted = envOf();
    const line = stagingLineOf(counted.env);

    expect(stagingEmail({ env: counted.env, db: NO_DB, line: null })).toBeNull();
    const bound = stagingEmail({ env: counted.env, db: NO_DB, line });

    expect(bound?.fromAddress).toBe(ROSIE_FROM_ADDRESS);
    expect(typeof bound?.port.sendEmail).toBe("function");
    expect(counted.names).toEqual([]);
  });

  it("through stagingOptions, every other part unbound: bound beside the test-phone part's line, which it is handed, and null where that part binds none; nothing read but ENVIRONMENT", async () => {
    const counted = envOf();
    const line = stagingLineOf(counted.env);
    const handed: (TestPhoneLinePort | null)[] = [];

    const bound = stagingOptions(counted.env, {
      db: NO_DB,
      builders: {
        ...EVERY_OTHER_PART_UNBOUND,
        testPhone: () => testPhoneWith(line),
        email: (part) => {
          handed.push(part.line);
          return stagingEmail(part);
        },
      },
    });
    const unbound = stagingOptions(counted.env, {
      db: NO_DB,
      builders: { ...EVERY_OTHER_PART_UNBOUND, testPhone: () => null },
    });

    expect(handed).toEqual([line]);
    expect(bound.emailRows?.fromAddress).toBe(ROSIE_FROM_ADDRESS);
    expect(
      Object.entries(bound)
        .filter(([, input]) => input !== null)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["emailRows", "testPhone"]);
    expect(unbound.emailRows).toBeNull();
    expect(counted.names).toEqual(["ENVIRONMENT", "ENVIRONMENT"]);
    // The bound port is the router over that line: a copy goes there.
    const copy = copyTo(RILEY_ADDRESS, "t1288-options-copy/1/1");
    expect(await bound.emailRows?.port.sendEmail(copy)).toMatchObject({ result: "accepted" });
    expect(await listed(line, RILEY_ADDRESS, copy.idempotencyKey)).toEqual([copy]);
  });

  it("on staging with no Hyperdrive binding, and anywhere but staging, stagingOptions gives no email port, with no read of the key or the list", () => {
    const noBinding = envOf();
    const production = envOf({ ENVIRONMENT: "production" });

    expect(stagingOptions(noBinding.env, { db: NO_DB }).emailRows).toBeNull();
    expect(stagingOptions(production.env, { db: NO_DB })).toBe(NO_STAGING_INPUTS);

    expect(production.names).toEqual(["ENVIRONMENT"]);
    for (const names of [noBinding.names, production.names]) {
      expect(names).not.toContain("RESEND_API_KEY");
      expect(names).not.toContain("STAGING_TEST_INBOXES");
    }
  });
});
