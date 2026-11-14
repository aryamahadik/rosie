// Test values for signInStart's server side (T-1282): K-21 v1's and K-05 v1.13's fixtures as the frozen contracts hold
// them, a double of K-05 v1.13's send side, test random sources, the page entry's hand-off with a trace whose spans are
// kept, and every contract's schema through Ajv, so each answer and request is held to the contracts themselves.
//
// The double is written from K-05 v1.13 items 58 and 59 and K-22 v1.2 rule 9 as they stand (rules 0 to 5 by the
// double's own clock, with the contract's numbers: 100 starts an hour, 5 a day per contact, 10 minutes, and the
// (n - limit + 1)-th start's time for a window's end), never from the code under test, which counts nothing itself.
// Values come only from the fixtures (the master's sample cast, the 555-01xx range and the reserved .example and
// example.com domains: rule 9); the hashing key is T-322's fixed test pattern, not a secret. Not imported by any shipped
// module.

import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import { DEFAULT_BUNDLE_ID } from "../../../../runtime/src/gateway/answer";
import type { PageRequest } from "../../../../runtime/src/gateway";
import { openTrace, type Span } from "../../../../runtime/src/trace";
import type { RandomFill } from "../../domain/proof-codes";
import { TEST_KEY_BYTES } from "../../domain/proof-codes/test-support";
import type {
  SendSignInCodeOutcome,
  SendSignInCodeRequest,
  SignInSendStore,
  StartSignInOutcome,
  StartSignInRequest,
} from "./types";

export const CONTRACTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
  readonly given: { readonly now: string; readonly environment?: string; readonly note: string };
  readonly request: Record<string, unknown>;
  readonly outcome: Record<string, unknown>;
}

/** A K-21 v1 fixture by file name (`invalid/<name>` for a refused one, which is a request alone). */
export const k21Fixture = (name: string): Exchange => readJson("page-api", "fixtures", name) as Exchange;

/** A K-05 fixture by file name. */
export const k05Fixture = (name: string): Exchange => readJson("data-access", "fixtures", name) as Exchange;

/** S11-52 by email: Sam types his email on the portal (K-21 v1 sign-in-request.json). */
export const SIGN_IN_REQUEST = k21Fixture("sign-in-request.json");
/** S1-10's page: the text way for the link's own account (K-21 v1 sign-in-from-link-by-text.json). */
export const SIGN_IN_FROM_LINK = k21Fixture("sign-in-from-link-by-text.json");
/** A sign-in request naming whose account (K-21 v1 invalid/refuse-sign-in-names-person.json). */
export const REFUSE_NAMES_PERSON = readJson(
  "page-api",
  "fixtures",
  "invalid",
  "refuse-sign-in-names-person.json",
) as Record<string, unknown>;

/** Sam's address as the fixture's page typed it, and his person (K-09 v1 proof-code-email.json's forPersonId). */
export const SAM_TYPED = "sam@lees-barbershop.example";
export const SAM_PERSON = "person-sam";
/** An address no account holds, on the reserved .example domain. */
export const NOBODY_TYPED = "someone-new@lees-barbershop.example";

/** A start's request as the page sends it: sign-in-request.json's, with the fields given replaced. */
export function startRequest(
  changes: {
    readonly typed?: string;
    readonly kind?: "email" | "mobile";
    readonly requestId?: string;
    readonly deviceToken?: string;
    readonly way?: "email" | "text";
  } = {},
): Record<string, unknown> {
  const fixture = SIGN_IN_REQUEST.request as {
    page: Record<string, unknown>;
    account: Record<string, unknown>;
    way: string;
    deviceToken: string;
  };
  return {
    page: { ...fixture.page, requestId: changes.requestId ?? fixture.page.requestId },
    account: { from: "typed", kind: changes.kind ?? "email", typed: changes.typed ?? SAM_TYPED },
    way: changes.way ?? fixture.way,
    deviceToken: changes.deviceToken ?? fixture.deviceToken,
  };
}

/** sign-in-from-link-by-text.json's request on the email way: a link's own sign-in that K-21 accepts and B1 serves. */
export function linkStartRequest(): Record<string, unknown> {
  return { ...SIGN_IN_FROM_LINK.request, way: "email" };
}

// ---- the hashes, made apart from the code under test ---------------------------------------------------------------

/** sha256 of a text's UTF-8 bytes in lower-case hex, by Node's own crypto. */
export const nodeSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** K-22 rule 9's contact hash by Node's own HMAC under T-322's test key: "rosie-sign-in-contact" LF kind LF contact. */
export const nodeContactHash = (kind: "email" | "mobile" | "link", contact: string): string =>
  createHmac("sha256", TEST_KEY_BYTES)
    .update(`rosie-sign-in-contact\n${kind}\n${contact}`, "utf8")
    .digest("hex");

// ---- random sources ----------------------------------------------------------------------------------------------

/** A fill that records every array it was asked to fill: bytes from a counter, 32-bit draws from a script. */
export interface TestFill {
  readonly fill: RandomFill;
  readonly asked: { readonly kind: "uint8" | "uint32"; readonly length: number }[];
}

/**
 * Gives a Uint8Array the bytes firstByte, firstByte + 1, ... (mod 256) in order, and a Uint32Array the next of `draws`;
 * a draw past the last throws, so a test sees exactly how many codes were drawn. Two fills made alike give alike.
 */
export function testFill(draws: readonly number[] = [], firstByte = 0): TestFill {
  const asked: TestFill["asked"] = [];
  let byte = firstByte;
  let next = 0;
  return {
    asked,
    fill(array) {
      asked.push({ kind: array instanceof Uint32Array ? "uint32" : "uint8", length: array.length });
      for (let index = 0; index < array.length; index += 1) {
        if (array instanceof Uint32Array) {
          const draw = draws[next];
          if (draw === undefined) throw new Error("the test fill has no draw left");
          next += 1;
          array[index] = draw;
        } else {
          array[index] = byte & 0xff;
          byte += 1;
        }
      }
    },
  };
}

// ---- K-05 v1.13's send side, as a double -------------------------------------------------------------------------

/** One sign_in_attempts row of the double. */
export interface DoubleAttempt {
  readonly id: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly deviceSha256: string;
  readonly contactHash: string;
  readonly personId: string | null;
  readonly startedAt: number;
  readonly expiresAt: number;
  pausedUntil: number | null;
  proofCodeId: string | null;
  outboxRowId: string | null;
  codeExpiresAt: number | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const utc = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/u, "Z");

/** The account key the double finds a person by: a typed email's address or a typed mobile's number. */
export const accountKey = (contact: StartSignInRequest["contact"]): string | null =>
  contact.kind === "email"
    ? `email:${contact.address}`
    : contact.kind === "mobile"
      ? `mobile:${contact.number}`
      : null;

/**
 * K-05 v1.13 startSignIn and sendSignInCode over in-memory attempts, by the double's clock (`now`). Records each request
 * and, in `calls`, the order calls reached it (shared with other ports' records when `calls` is handed in).
 */
export class SignInDouble implements SignInSendStore {
  /** The database's clock, epoch milliseconds. */
  now: number;
  readonly attempts: DoubleAttempt[] = [];
  /** The accounts by their key (accountKey): the persons whose proven email or mobile it is. */
  readonly accounts = new Map<string, string[]>();
  readonly starts: StartSignInRequest[] = [];
  readonly sends: SendSignInCodeRequest[] = [];
  /** Each answer the double gave, in order. */
  readonly answers: (StartSignInOutcome | SendSignInCodeOutcome)[] = [];
  /** A scripted answer for the next sends, in place of the rule's (nothing is written for them). */
  readonly scriptedSends: SendSignInCodeOutcome[] = [];
  readonly calls: string[];
  private commits = 0;

  constructor(now: string, calls: string[] = []) {
    this.now = Date.parse(now);
    this.calls = calls;
  }

  /** Gives `personId` an account the start finds by `key` (accountKey's form: a proven email or a mobile). */
  account(key: string, personId: string): this {
    this.accounts.set(key, [...(this.accounts.get(key) ?? []), personId]);
    return this;
  }

  /** Seeds an attempt as an earlier start (and its checks) would have left it. */
  seed(attempt: Partial<DoubleAttempt> & Pick<DoubleAttempt, "contactHash" | "startedAt">): DoubleAttempt {
    const index = this.attempts.length + 1;
    const row: DoubleAttempt = {
      id: `sign-in-seed-${String(index)}`,
      attemptId: `attempt-seed-${String(index)}`,
      requestSha256: nodeSha256(`seed ${String(index)}`),
      deviceSha256: nodeSha256(`seed device ${String(index)}`),
      personId: null,
      expiresAt: attempt.startedAt + 10 * MINUTE,
      pausedUntil: null,
      proofCodeId: null,
      outboxRowId: null,
      codeExpiresAt: null,
      ...attempt,
    };
    this.attempts.push(row);
    return row;
  }

  /** The attempts that pass `test`, by started_at and then id (K-22 rule 9's window order). */
  private window(test: (attempt: DoubleAttempt) => boolean): DoubleAttempt[] {
    return this.attempts
      .filter(test)
      .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private answered<T extends StartSignInOutcome | SendSignInCodeOutcome>(answer: T): Promise<T> {
    this.answers.push(structuredClone(answer));
    return Promise.resolve(answer);
  }

  startSignIn(request: StartSignInRequest): Promise<StartSignInOutcome> {
    this.calls.push("startSignIn");
    this.starts.push(structuredClone(request));
    const paused = (
      until: number,
      by: "hourBound" | "contactPause" | "dayCap",
    ): Promise<StartSignInOutcome> => this.answered({ result: "paused", until: utc(until), by });
    // Rule 0: every contact's starts in the hour, before any lock or account.
    const hour = this.window((attempt) => attempt.startedAt > this.now - HOUR);
    const hourFirst = hour[hour.length - 100];
    if (hour.length >= 100 && hourFirst !== undefined) return paused(hourFirst.startedAt + HOUR, "hourBound");
    // Rule 1: the repeat, by the request's key: the first attempt, no person, nothing written.
    const repeat = this.attempts.find((attempt) => attempt.requestSha256 === request.requestSha256);
    if (repeat !== undefined) {
      return this.answered({
        result: "started",
        id: repeat.id,
        attemptId: repeat.attemptId,
        expiresAt: utc(repeat.expiresAt),
        repeated: true,
        personId: null,
      });
    }
    // Rule 2: the contact's latest pause.
    const pauses = this.attempts
      .filter((attempt) => attempt.contactHash === request.contactHash)
      .map((attempt) => attempt.pausedUntil ?? 0)
      .filter((until) => until > this.now);
    if (pauses.length > 0) return paused(Math.max(...pauses), "contactPause");
    // Rule 3: the contact's starts in a rolling 24 hours.
    const day = this.window(
      (attempt) => attempt.contactHash === request.contactHash && attempt.startedAt > this.now - DAY,
    );
    const dayFirst = day[day.length - 5];
    if (day.length >= 5 && dayFirst !== undefined) return paused(dayFirst.startedAt + DAY, "dayCap");
    // Rule 4: exactly one account names a person; a link reads none.
    const key = accountKey(request.contact);
    const persons = key === null ? [] : (this.accounts.get(key) ?? []);
    const personId = persons.length === 1 ? (persons[0] ?? null) : null;
    // Rule 5: the attempt.
    const attempt = this.seed({
      id: request.id,
      attemptId: request.attemptId,
      requestSha256: request.requestSha256,
      deviceSha256: request.deviceSha256,
      contactHash: request.contactHash,
      personId,
      startedAt: this.now,
    });
    return this.answered({
      result: "started",
      id: attempt.id,
      attemptId: attempt.attemptId,
      expiresAt: utc(attempt.expiresAt),
      repeated: false,
      personId,
    });
  }

  sendSignInCode(request: SendSignInCodeRequest): Promise<SendSignInCodeOutcome> {
    this.calls.push("sendSignInCode");
    this.sends.push(structuredClone(request));
    const scripted = this.scriptedSends.shift();
    if (scripted !== undefined) return this.answered(scripted);
    const attempt = this.attempts.find((each) => each.id === request.signInAttemptId);
    if (attempt === undefined) {
      return this.answered({ error: "notFound", table: "sign_in_attempts", rowId: request.signInAttemptId });
    }
    if (attempt.proofCodeId !== null) {
      return this.answered({
        result: "sent",
        proofCodeId: attempt.proofCodeId,
        outboxRowId: attempt.outboxRowId ?? "",
        expiresAt: utc(attempt.codeExpiresAt ?? 0),
        repeated: true,
      });
    }
    if (attempt.personId === null) return this.answered({ result: "notSent", why: "noPerson" });
    if (attempt.expiresAt < this.now) return this.answered({ result: "notSent", why: "attemptExpired" });
    attempt.proofCodeId = request.code.id;
    attempt.outboxRowId = request.emailRowId;
    attempt.codeExpiresAt = this.now + 10 * MINUTE;
    this.commits += 1;
    return this.answered({
      result: "sent",
      proofCodeId: request.code.id,
      outboxRowId: request.emailRowId,
      commitSeq: this.commits,
      version: 2,
      expiresAt: utc(attempt.codeExpiresAt),
      entryIds: [
        `log-${request.emailRowId}-created`,
        `log-${request.emailRowId}-planned`,
        `log-${request.code.id}-sent`,
      ],
      repeated: false,
    });
  }
}

// ---- the page entry's hand-off --------------------------------------------------------------------------------------

/** One call as the page entry hands it on, with the spans its trace keeps. */
export interface CapturedPage {
  readonly page: PageRequest;
  readonly spans: Span[];
}

/** The page entry's hand-off of one signInStart call: a fresh pageRequest trace whose spans are kept here. */
export function capturedPage(
  request: Readonly<Record<string, unknown>>,
  options: { readonly call?: PageRequest["call"]; readonly environment?: string } = {},
): CapturedPage {
  const spans: Span[] = [];
  const trace = openTrace({
    openedBy: "pageRequest",
    bundleId: DEFAULT_BUNDLE_ID,
    incomingTraceId: null,
    sink: (span) => spans.push(span),
  });
  return {
    page: {
      call: options.call ?? "signInStart",
      request,
      trace,
      environment: options.environment ?? "staging",
    },
    spans,
  };
}

/**
 * A port the call must not reach: any property read is recorded and throws. Used where a call must answer before it
 * reaches a port (a request that is not K-21's; way text; no hashing key).
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
    },
  ) as never;
}

// ---- the contracts' own schemas (Ajv 2020, strict), as the contract tests hold them ----------------------------------

const K21_ID = "https://rosie.invalid/contracts/page-api/page-api.v1.schema.json";
const K05_ID = "https://rosie.invalid/contracts/data-access/data-access.v1.13.schema.json";
const K08_ID = "https://rosie.invalid/contracts/event-trace/event-trace.v1.schema.json";

let ajv: InstanceType<typeof Ajv2020> | undefined;

function schemas(): InstanceType<typeof Ajv2020> {
  if (ajv !== undefined) return ajv;
  const loaded = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  // Every contract's schemas, so the $refs between them resolve (K-21 refers to K-05, K-08, K-09 and others).
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

/** Problems K-21 v1 `$defs/<definition>` finds. */
export const k21Problems = (value: unknown, definition: string): string[] =>
  problemsOf(`${K21_ID}#/$defs/${definition}`, value);

/** Problems K-05 v1.13 `$defs/<definition>` finds. */
export const k05Problems = (value: unknown, definition: string): string[] =>
  problemsOf(`${K05_ID}#/$defs/${definition}`, value);

/** Problems K-08 v1 `$defs/span` finds. */
export const spanSchemaProblems = (value: unknown): string[] => problemsOf(`${K08_ID}#/$defs/span`, value);
