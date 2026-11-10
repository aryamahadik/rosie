// Test values for the test-phone calls (T-565): K-21 v1's fixtures as the frozen contracts hold them, staging's roster as
// test-roster.json lists it, the ports as fakes over those values, a webhook secret made up for each run (never Linq's
// or Resend's: rule 7), and every contract's schema through Ajv, so each answer is held to K-21 v1 itself. Test values
// only: fixture set v1's demo shop, the master's sample cast, the fictional 555-01xx numbers and the reserved example
// domains (rule 9). Not imported by any shipped module.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type { RecordedEmail as K12RecordedEmail, SendEmailRequest } from "@rosie/adapters/email/double";
import type { SendPartOutcome, SendPartRequest } from "@rosie/adapters/linq/double";
import {
  createLinqWebhookVerifier,
  type InboundEvent,
  type VerifyWebhookResult,
} from "@rosie/adapters/linq/webhook";

import { DEFAULT_BUNDLE_ID } from "../../../../../runtime/src/gateway/answer";
import type { PageCallName, PageRequest } from "../../../../../runtime/src/gateway";
import { openTrace } from "../../../../../runtime/src/trace";
import type { RecordedLinqDouble } from "./parts";
import type {
  LinqWebhookEntry,
  PhoneState,
  RosterPhone,
  TesterAccess,
  TesterStanding,
  TestPhoneRoster,
} from "./types";

export const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "contracts",
);

const readJson = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(path.join(CONTRACTS, ...parts), "utf8"));

// ---- the fixtures ---------------------------------------------------------------------------------------------------

export interface Exchange {
  readonly call: string;
  readonly given: { readonly now: string; readonly environment: string; readonly note: string };
  readonly request: Record<string, unknown>;
  readonly outcome: Record<string, unknown>;
}

/** A K-21 v1 fixture by file name (`invalid/<name>` for a refused one). */
export const k21Fixture = (name: string): Exchange => readJson("page-api", "fixtures", name) as Exchange;

export const SEND_FIXTURE = k21Fixture("test-phone-send.json");
export const PARTS_FIXTURE = k21Fixture("test-phone-parts.json");
export const ROSTER_FIXTURE = k21Fixture("test-roster.json");
export const FIRE_NOW_IN_PRODUCTION = k21Fixture("fire-now-in-production.json");

/** K-06 v1 test-phone-page.json: the event test-phone-send.json's server builds and the gateway gets back. */
export const TEST_PHONE_EVENT = readJson("inbound-event", "fixtures", "test-phone-page.json") as InboundEvent;

/** K-11 v1 double-signed-webhook.json: the webhook the Linq double signs for that event. */
export const DOUBLE_SIGNED_WEBHOOK = readJson("port-linq", "fixtures", "double-signed-webhook.json") as {
  readonly request: { readonly event: InboundEvent; readonly partKey: null };
  readonly outcome: {
    readonly webhook: { readonly webhookId: string; readonly timestamp: string; readonly raw: string };
  };
};

interface SendPartExchange {
  readonly given: { readonly now: string };
  readonly request: SendPartRequest;
  readonly outcome: SendPartOutcome;
}

/** A K-11 v1 sendPart fixture (send-text.json, send-poll.json, ...). */
export const k11Fixture = (name: string): SendPartExchange =>
  readJson("port-linq", "fixtures", name) as SendPartExchange;

/** A K-12 v1 sendEmail fixture's request. */
export const k12SendRequest = (name: string): SendEmailRequest =>
  (readJson("port-email", "fixtures", name) as { request: SendEmailRequest }).request;

/** The tester's session token in K-21 v1's staging fixtures: a placeholder. */
export const TESTER_TOKEN = "placeholder-session-token-tester-0001";

interface RosterFixturePhone {
  readonly testPhoneId: string;
  readonly last4: string;
}

/** The address of the first customer's own person, as test-phone-parts.json's email went to it. */
export const ALEX_EMAIL = (PARTS_FIXTURE.outcome.emails as { to: string }[])[0]?.to ?? "";

/**
 * Staging's roster as test-roster.json lists it: each phone at the fictional 555-01xx number its last four digits name
 * (test-phone-page.json's +15555550104 for tp-04; send-text.json's +15555550101 for tp-03), and the first customer's
 * person with the email test-phone-parts.json's copy went to.
 */
export const ROSTER: readonly RosterPhone[] = (ROSTER_FIXTURE.outcome.phones as RosterFixturePhone[]).map(
  (phone) => ({
    testPhoneId: phone.testPhoneId,
    number: `+1555555${phone.last4}`,
    email: phone.testPhoneId === "tp-03" ? ALEX_EMAIL : null,
  }),
);

export function rosterPhone(testPhoneId: string): RosterPhone {
  const phone = ROSTER.find((each) => each.testPhoneId === testPhoneId);
  if (phone === undefined) throw new Error(`no roster phone ${testPhoneId}`);
  return phone;
}

// ---- the ports, as fakes --------------------------------------------------------------------------------------------

/** A webhook secret made up for one run, in Linq's form ("whsec_" and 32 random bytes in base64): never a real one. */
export function testWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

/** Who each session token's sha256 is, as K-22's session read and the roster's testers would answer. */
export function fakeAccess(standings: ReadonlyMap<string, TesterStanding>): TesterAccess & {
  readonly asked: { tokenSha256: string; at: string }[];
} {
  const asked: { tokenSha256: string; at: string }[] = [];
  return {
    asked,
    standing(tokenSha256, at) {
      asked.push({ tokenSha256, at });
      return Promise.resolve(standings.get(tokenSha256) ?? "noSession");
    },
  };
}

/** Staging's roster over these phones. */
export function fakeRoster(
  phones: readonly RosterPhone[] = ROSTER,
): TestPhoneRoster & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    phone(testPhoneId) {
      asked.push(testPhoneId);
      return Promise.resolve(phones.find((phone) => phone.testPhoneId === testPhoneId) ?? null);
    },
  };
}

/** A phone with no K-04 row yet: no chat, not stopped, no chat link. */
export const NO_PHONE_ROW: PhoneState = { chatOpen: false, stopped: false, stoppedAt: null, chatLink: null };

/** The phones' state by number. */
export function fakePhoneStates(states: ReadonlyMap<string, PhoneState>): {
  state(number: string): Promise<PhoneState>;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    state(number) {
      asked.push(number);
      return Promise.resolve(states.get(number) ?? NO_PHONE_ROW);
    },
  };
}

/** One webhook the gateway got: its headers and body as posted, and what the Linq adapter's verify made of them. */
export interface PostedWebhook {
  readonly method: string;
  readonly url: string;
  readonly webhookId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly raw: string;
  readonly verified: VerifyWebhookResult;
}

export interface FakeGatewayOptions {
  /** The secret the gateway's verify reads (the root's LINQ_WEBHOOK_SECRET on staging). */
  readonly secret: string;
  /** The gateway's receipt time and the trace it opens at receipt (its answer's x-trace-id). */
  readonly receivedAt: string;
  readonly traceId: string;
  /** The status it answers: by default 401 for a rejected signature and 200 otherwise. */
  readonly status?: number;
  /** Leaves x-trace-id out of the answer. */
  readonly noTraceHeader?: boolean;
}

/**
 * The gateway's Linq entry as the test stands it in: T-413's verify (the real adapter) on the three signature headers and
 * the body, at the gateway's receipt time and under the trace it opens, answering as the gateway answers.
 */
export function fakeGateway(options: FakeGatewayOptions): {
  readonly entry: LinqWebhookEntry;
  readonly posted: PostedWebhook[];
} {
  const verifier = createLinqWebhookVerifier({ secret: () => options.secret });
  const posted: PostedWebhook[] = [];
  const entry: LinqWebhookEntry = async (request) => {
    const header = (name: string): string => request.headers.get(name) ?? "";
    const raw = await request.text();
    const verified = await verifier.verifyWebhook({
      webhookId: header("webhook-id"),
      timestamp: header("webhook-timestamp"),
      signature: header("webhook-signature"),
      raw,
      receivedAt: options.receivedAt,
      traceId: options.traceId,
    });
    posted.push({
      method: request.method,
      url: request.url,
      webhookId: header("webhook-id"),
      timestamp: header("webhook-timestamp"),
      signature: header("webhook-signature"),
      raw,
      verified,
    });
    const status = options.status ?? (verified.result === "rejected" ? 401 : 200);
    return new Response(JSON.stringify({ ok: status === 200 }), {
      status,
      headers: {
        "content-type": "application/json",
        ...(options.noTraceHeader === true ? {} : { "x-trace-id": options.traceId }),
      },
    });
  };
  return { entry, posted };
}

/**
 * A Linq double scripted with K-11 v1's own fixture answers, in order: it records each request it takes, as the Linq
 * double does, and answers the next scripted outcome (so a part's answer is the fixture's, word for word).
 */
export function scriptedLinqDouble(outcomes: readonly SendPartOutcome[]): RecordedLinqDouble {
  const sent: SendPartRequest[] = [];
  return {
    sendPart(request) {
      const outcome = outcomes[sent.length];
      if (outcome === undefined) throw new Error("the scripted Linq double has no answer left");
      sent.push(structuredClone(request as SendPartRequest));
      return structuredClone(outcome);
    },
    sentRequests() {
      return structuredClone(sent);
    },
  };
}

/** The email double's doubleSentEmails over a fixed record (K-12 v1 doubleSentEmails.response), filtered by `to`. */
export function recordedEmails(emails: readonly K12RecordedEmail[]): {
  doubleSentEmails(request: unknown): Promise<{ result: "recorded"; emails: K12RecordedEmail[] }>;
  readonly asked: unknown[];
} {
  const asked: unknown[] = [];
  return {
    asked,
    doubleSentEmails(request) {
      asked.push(request);
      const to = (request as { to: string | null }).to;
      return Promise.resolve({
        result: "recorded",
        emails: structuredClone(emails.filter((email) => to === null || email.request.to === to)),
      });
    },
  };
}

/**
 * A port the call must not reach, standing in for any port: any property read is recorded and throws. Used where a call
 * must answer before it reads its request or reaches a port (staging only; not a seeded test phone).
 */
export function tripwire(name: string, touched: string[]): never {
  return new Proxy<Record<string, never>>(
    {},
    {
      get(_target, key) {
        touched.push(`${name}.${String(key)}`);
        throw new Error(`${name} was reached`);
      },
      has(_target, key) {
        touched.push(`${name} has ${String(key)}`);
        throw new Error(`${name} was reached`);
      },
      ownKeys() {
        touched.push(`${name} keys`);
        throw new Error(`${name} was reached`);
      },
    },
  ) as never;
}

/** The page entry's hand-off of one call (runtime/src/gateway/pages PageRequest): a fresh pageRequest trace. */
export function pageRequest(
  call: PageCallName,
  request: Readonly<Record<string, unknown>>,
  environment = "staging",
): PageRequest {
  return {
    call,
    request,
    trace: openTrace({ openedBy: "pageRequest", bundleId: DEFAULT_BUNDLE_ID, incomingTraceId: null }),
    environment,
  };
}

// ---- the contracts' own schemas (Ajv 2020, strict), as the contract tests hold them ----------------------------------

const K21_ID = "https://rosie.invalid/contracts/page-api/page-api.v1.schema.json";
const K11_ID = "https://rosie.invalid/contracts/port-linq/port-linq.v1.schema.json";
const K12_ID = "https://rosie.invalid/contracts/port-email/port-email.v1.schema.json";

let ajv: InstanceType<typeof Ajv2020> | undefined;

function schemas(): InstanceType<typeof Ajv2020> {
  if (ajv !== undefined) return ajv;
  const loaded = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (K-21 v1 refers to K-05, K-08, K-09, K-11 and others).
  for (const folder of readdirSync(CONTRACTS, { withFileTypes: true })) {
    if (!folder.isDirectory() || ["scripts", "generated", "node_modules"].includes(folder.name)) continue;
    for (const file of readdirSync(path.join(CONTRACTS, folder.name)))
      if (file.endsWith(".schema.json")) loaded.addSchema(readJson(folder.name, file) as object);
  }
  ajv = loaded;
  return loaded;
}

function validator(ref: string): ValidateFunction {
  const validate = schemas().getSchema(ref);
  if (validate === undefined) throw new Error(`no schema ${ref}`);
  return validate;
}

/** Ajv's problems with a value, one line per error by place and rule, never the value itself. */
function problemsOf(ref: string, value: unknown): string[] {
  const validate = validator(ref);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.keyword}`);
}

/** Problems K-21 v1 finds: its root (any exchange) when no definition is named, else `$defs/<definition>`. */
export const k21Problems = (value: unknown, definition?: string): string[] =>
  problemsOf(definition === undefined ? K21_ID : `${K21_ID}#/$defs/${definition}`, value);

/** Problems K-11 v1 `$defs/<definition>` finds. */
export const k11Problems = (definition: string, value: unknown): string[] =>
  problemsOf(`${K11_ID}#/$defs/${definition}`, value);

/** Problems K-12 v1 `$defs/<definition>` finds. */
export const k12Problems = (definition: string, value: unknown): string[] =>
  problemsOf(`${K12_ID}#/$defs/${definition}`, value);
