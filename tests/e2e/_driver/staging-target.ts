// The staging target (T-465; C-148): the same run on staging, asked for by name only. It never runs in CI (DL-024: CI has
// no Cloudflare access), and before anything else it calls GET {BASE_PATH}/health (d000-factory-spec section 6) and
// refuses to go on unless the answer is ok with environment "staging".
//
// It sends only through K-21 v1's staging-only testPhoneSend: the server builds the K-06 event for the roster phone and
// signs it through the Linq double, so this side holds no webhook secret and reads no key. It reads what the phone got
// through testPhoneParts. Each request is checked against K-21 v1 before it goes, and each answer when it comes back.
//
// The session token is the signed-in tester's, handed in by the caller: it goes only into K-21's page envelope, and is
// never logged or put in an error. Nor are a text's words. The page calls' route is the gateway's page entry (T-266),
// which K-21 v1 does not name, so the caller gives it (pageCallPath).

import type {
  TestPhoneParts,
  TestPhonePartsRequest,
  TestPhoneSendRequest,
  TestPhoneSent,
} from "../../../contracts/generated/page-api/page-api.v1";
import { K21, schemaProblems } from "./contracts";
import type { SentPart } from "./parts";
import { settle, type CollectOptions, type Collected, type SentText } from "./run";
import { spansOfLogLines, traceOf, type SpanReader } from "./trace";

/** The K-21 v1 calls the staging target makes, both staging only. */
export type StagingPageCall = "testPhoneSend" | "testPhoneParts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface StagingTargetOptions {
  /** The staging Worker's address with its BASE_PATH, as check:staging takes it: https://<host>/test. */
  readonly baseUrl: string;
  /** The signed-in tester's session (K-21 v1 signedInPage.sessionToken), from the caller. */
  readonly sessionToken: string;
  /** Where each K-21 call is posted, under baseUrl (the gateway's page entry, T-266), such as "/<route>/testPhoneSend". */
  readonly pageCallPath: (call: StagingPageCall) => string;
  /** Default: the global fetch. */
  readonly fetch?: Fetch;
  /** The environment variables read: only CI. Default: this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Span log lines from Workers Logs, read on the build Mac (DL-024). Without one, no trace is collected. */
  readonly spans?: SpanReader;
  /** New request and trace ids. Default crypto.randomUUID. */
  readonly newId?: () => string;
}

export type StagingRefusal = "ci" | "health" | "notStaging";

/** The staging target would not start: in CI, /health failed, or the Worker is not staging's. Nothing was sent. */
export class StagingRefusedError extends Error {
  override readonly name = "StagingRefusedError";
  readonly reason: StagingRefusal;
  /** The environment /health reported, or null. */
  readonly environment: string | null;

  constructor(reason: StagingRefusal, environment: string | null, message: string) {
    super(message);
    this.reason = reason;
    this.environment = environment;
  }
}

/** A K-21 call answered with one of its errors, or with something K-21 v1 does not define. */
export class StagingCallError extends Error {
  override readonly name = "StagingCallError";
  readonly call: StagingPageCall;
  readonly status: number;
  /** K-21's error label (stagingOnly, signInNeeded, notTester, notTestPhone, transient), or null. */
  readonly error: string | null;

  constructor(call: StagingPageCall, status: number, error: string | null, message: string) {
    super(message);
    this.call = call;
    this.status = status;
    this.error = error;
  }
}

export interface StagingHealth {
  readonly environment: "staging";
  readonly version: string | null;
  readonly traceId: string | null;
}

export interface StagingText {
  readonly testPhoneId: string;
  readonly words: string;
  readonly threadedReplyTo?: string | null;
}

export interface StagingTarget {
  readonly name: "staging";
  /** What /health answered before anything was sent. */
  readonly health: StagingHealth;
  /** Sends a text as a roster test phone through K-21's testPhoneSend; the only way this target sends. */
  sendText(text: StagingText): Promise<SentText>;
  /** K-21's testPhoneParts for one roster test phone. */
  phoneParts(testPhoneId: string, since?: string | null): Promise<TestPhoneParts>;
  /** The trace by its id (when a span reader was given), and the parts the double sent to the test phone. */
  collect(
    traceId: string,
    testPhoneId: string,
    options?: CollectOptions & { readonly since?: string | null },
  ): Promise<Collected>;
}

/** True when CI is set (GitHub Actions sets CI=true): the staging target never runs there (DL-024). */
export function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return null;
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

/** Opens the staging target: refuses in CI, then calls /health and refuses unless it reports staging. */
export async function openStagingTarget(options: StagingTargetOptions): Promise<StagingTarget> {
  if (inCi(options.env ?? process.env)) {
    throw new StagingRefusedError(
      "ci",
      null,
      "the staging target never runs in CI (DL-024: CI has no Cloudflare access); run it by name from the build Mac",
    );
  }
  const send: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const newId = options.newId ?? (() => crypto.randomUUID());
  const base = options.baseUrl.replace(/\/+$/, "");

  let response: Response;
  try {
    response = await send(`${base}/health`, { method: "GET", headers: { "x-trace-id": newId() } });
  } catch (error) {
    throw new StagingRefusedError(
      "health",
      null,
      `GET /health failed (${errorName(error)}): nothing was sent`,
    );
  }
  const body = await jsonOf(response);
  const reported = field(body, "environment");
  const environment = typeof reported === "string" ? reported : null;
  if (response.status !== 200 || field(body, "ok") !== true) {
    throw new StagingRefusedError(
      "health",
      environment,
      `GET /health answered ${String(response.status)} without ok: true: nothing was sent`,
    );
  }
  if (environment !== "staging") {
    throw new StagingRefusedError(
      "notStaging",
      environment,
      `GET /health reports environment ${environment ?? "(none)"}: the staging target runs only on staging; nothing was sent`,
    );
  }
  const version = field(body, "version");
  const traceId = field(body, "trace_id");
  const health: StagingHealth = {
    environment: "staging",
    version: typeof version === "string" ? version : null,
    traceId: typeof traceId === "string" ? traceId : null,
  };

  const page = (): TestPhoneSendRequest["page"] => ({
    requestId: newId(),
    traceId: newId(),
    sessionToken: options.sessionToken,
    linkCode: null,
  });

  async function call(name: "testPhoneSend", request: TestPhoneSendRequest): Promise<TestPhoneSent>;
  async function call(name: "testPhoneParts", request: TestPhonePartsRequest): Promise<TestPhoneParts>;
  async function call(
    name: StagingPageCall,
    request: TestPhoneSendRequest | TestPhonePartsRequest,
  ): Promise<TestPhoneSent | TestPhoneParts> {
    const refused = schemaProblems(K21, `${name}.request`, request);
    if (refused.length > 0) {
      throw new Error(`${name}: the request is not K-21 v1's, so it was not sent:\n${refused.join("\n")}`);
    }
    const path = options.pageCallPath(name);
    if (!path.startsWith("/")) throw new Error(`${name}: pageCallPath must give a path that starts with /`);
    const answer = await send(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace-id": request.page.traceId },
      body: JSON.stringify(request),
    });
    const answered = await jsonOf(answer);
    if (schemaProblems(K21, `${name}.response`, answered).length === 0) {
      return answered as TestPhoneSent | TestPhoneParts;
    }
    if (schemaProblems(K21, `${name}.errors`, answered).length === 0) {
      const label = String(field(answered, "error"));
      throw new StagingCallError(name, answer.status, label, `${name} answered ${label}`);
    }
    throw new StagingCallError(
      name,
      answer.status,
      null,
      `${name} answered ${String(answer.status)} with no K-21 v1 answer:\n${schemaProblems(K21, `${name}.response`, answered).join("\n")}`,
    );
  }

  const phoneParts = (testPhoneId: string, since: string | null = null): Promise<TestPhoneParts> =>
    call("testPhoneParts", { page: page(), testPhoneId, since });

  return {
    name: "staging",
    health,
    async sendText(text) {
      const sent = await call("testPhoneSend", {
        page: page(),
        testPhoneId: text.testPhoneId,
        words: text.words,
        threadedReplyTo: text.threadedReplyTo ?? null,
      });
      return {
        target: "staging",
        eventId: sent.eventId,
        traceId: sent.traceId,
        gatewayStatus: sent.gatewayStatus,
      };
    },
    phoneParts,
    collect(traceId, testPhoneId, collectOptions = {}) {
      const read = async (): Promise<Collected> => {
        const got = await phoneParts(testPhoneId, collectOptions.since ?? null);
        const { trace, problems } =
          options.spans === undefined
            ? {
                trace: null,
                problems: [
                  `no span reader: trace ${traceId} is in Workers Logs, read on the build Mac (DL-024)`,
                ],
              }
            : traceOf(traceId, spansOfLogLines(await options.spans(traceId)));
        return {
          target: "staging",
          traceId,
          trace,
          traceProblems: problems,
          // K-21 v1 RecordedPart is K-11 v1 sendPart's request and outcome, as checked above.
          parts: got.parts as unknown as SentPart[],
          outbox: null,
        };
      };
      return settle(read, collectOptions);
    },
  };
}
