// T-1289 (ADR-016 card D, section 2): the sign-in calls as the root binds them (./sign-in.ts signInPages), over doubles
// of K-05's sign-in calls, the root's dispatcher wake and a made-up hashing key, with T-1282's and T-1285's handlers as
// they are. The database end to end is ./staging/sign-in.worker.test.ts's; here, each way the dispatch after the code's
// commit can go:
//   - the work a handler hands on starts after its answer (a turn later) and goes to the request's waitUntil, or runs
//     with none when the page entry had no context to hand on;
//   - a code row written (sent) or written before (repeated) wakes the dispatcher once, for the recipient K-05 names by
//     the row's id, on the page call's own trace; a send that wrote nothing (notSent, constraint) wakes nothing;
//   - a recipient K-05 does not name, a read that throws and a wake that fails each write one line of labels, and the
//     answer and the code row stand;
//   - the hashing port is asked once per start and per check, by the call's trace id, and never by a sign-out; with none,
//     the start writes nothing (T-1282's noHashKey).
// Test values only (rule 9): the contracts' fixtures and made-up ids and key.
import signInRequestJson from "@rosie/contracts/page-api/fixtures/sign-in-request.json";
import signOutJson from "@rosie/contracts/page-api/fixtures/sign-out.json";
import { hmacSha256Hash, type KeyedHash } from "@rosie/actions/src/domain/proof-codes/index";
import type {
  SendSignInCodeOutcome,
  SendSignInCodeRequest,
  SignInAfterCheckStore,
  SignInCheckStore,
  SignInSendStore,
  StartSignInRequest,
} from "@rosie/actions/src/page-calls/sign-in/index";
import { describe, expect, it } from "vitest";

import { DEFAULT_BUNDLE_ID } from "../gateway/answer";
import type { PageCallName, PageRequest } from "../gateway/pages";
import { openTrace, type TraceContext } from "../trace";
import { signInPages, type SignInInputs, type SignInWakeLine } from "./sign-in";

/** A made-up hashing key: 32 bytes counting down from 0x7f. Never a key of anything. */
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => 0x7f - index);
const RECIPIENT = "handle-sam-email";
const LOG = { environment: "staging", version: "test-sha" };

/** What one world recorded: each K-05 call's request, each recipient read, each wake, and each line. */
interface World {
  readonly starts: StartSignInRequest[];
  readonly sends: SendSignInCodeRequest[];
  readonly recipientReads: [string, string][];
  readonly wakes: [string, TraceContext][];
  readonly hashAsks: string[];
  readonly lines: SignInWakeLine[];
  readonly inputs: SignInInputs;
  readonly wake: (recipientHandleId: string, trace: TraceContext) => Promise<void>;
}

interface WorldOptions {
  /** K-05's answer to the send, from its request (default: sent). */
  readonly send?: (request: SendSignInCodeRequest) => SendSignInCodeOutcome;
  /** K-05 sendState's recipient for the row (default: Sam's email handle), or a throw. */
  readonly recipient?: () => Promise<string | null>;
  /** The root's wake (default: it records and resolves). */
  readonly wake?: () => Promise<void>;
  /** The hashing port (default: over the made-up key). */
  readonly hash?: KeyedHash | null;
}

const sentOf = (request: SendSignInCodeRequest): SendSignInCodeOutcome => ({
  result: "sent",
  proofCodeId: request.code.id,
  outboxRowId: request.emailRowId,
  commitSeq: 1,
  version: 2,
  expiresAt: "2026-11-15T13:10:01Z",
  entryIds: [
    `log-${request.emailRowId}-created`,
    `log-${request.emailRowId}-planned`,
    `log-${request.code.id}-sent`,
  ],
  repeated: false,
});

async function world(options: WorldOptions = {}): Promise<World> {
  const starts: StartSignInRequest[] = [];
  const sends: SendSignInCodeRequest[] = [];
  const recipientReads: [string, string][] = [];
  const wakes: [string, TraceContext][] = [];
  const hashAsks: string[] = [];
  const lines: SignInWakeLine[] = [];
  const hash =
    options.hash === undefined ? await hmacSha256Hash("PROOF_CODE_HASH_KEY", KEY_BYTES) : options.hash;
  const send: SignInSendStore = {
    startSignIn(request) {
      starts.push(request);
      return Promise.resolve({
        result: "started",
        id: request.id,
        attemptId: request.attemptId,
        expiresAt: "2026-11-15T13:10:00Z",
        repeated: false,
        personId: "person-sam",
      });
    },
    sendSignInCode(request) {
      sends.push(request);
      return Promise.resolve((options.send ?? sentOf)(request));
    },
  };
  const check: SignInCheckStore = {
    proveSignIn: () => Promise.resolve({ error: "attemptNotFound" }),
    endSession: () => Promise.resolve({ result: "signedOut", repeated: true }),
  };
  const afterCheck: SignInAfterCheckStore = {
    personStanding: () => Promise.reject(new Error("no standing is read here")),
    signInEntries: () => Promise.reject(new Error("no entry is written here")),
  };
  const inputs: SignInInputs = {
    send,
    check,
    afterCheck,
    hash: (traceId) => {
      hashAsks.push(traceId);
      return Promise.resolve(hash);
    },
    recipientOf: (outboxRowId, traceId) => {
      recipientReads.push([outboxRowId, traceId]);
      return options.recipient === undefined ? Promise.resolve(RECIPIENT) : options.recipient();
    },
  };
  const wake = (recipientHandleId: string, trace: TraceContext): Promise<void> => {
    wakes.push([recipientHandleId, trace]);
    return options.wake === undefined ? Promise.resolve() : options.wake();
  };
  return { starts, sends, recipientReads, wakes, hashAsks, lines, inputs, wake };
}

/** The three calls over a world, its lines kept. */
function pagesOver(made: World) {
  return signInPages({
    inputs: made.inputs,
    wake: made.wake,
    log: LOG,
    write: (line) => made.lines.push(JSON.parse(line) as SignInWakeLine),
  });
}

/** A page call as the page entry hands it on, with a waitUntil that keeps what it is handed (or none). */
function pageOf(
  call: PageCallName,
  request: Readonly<Record<string, unknown>>,
  options: { waitUntil?: boolean } = {},
): { page: PageRequest; handed: Promise<unknown>[] } {
  const handed: Promise<unknown>[] = [];
  const trace = openTrace({
    openedBy: "pageRequest",
    bundleId: DEFAULT_BUNDLE_ID,
    incomingTraceId: null,
    sink: () => undefined,
  });
  const page: PageRequest = {
    call,
    request,
    trace,
    environment: "staging",
    ...(options.waitUntil === false
      ? {}
      : {
          waitUntil: (work: Promise<unknown>) => {
            handed.push(work);
          },
        }),
  };
  return { page, handed };
}

/** A few turns of the event loop: enough for work with no waitUntil, whose doubles answer at once, to end. */
async function turns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("signInStart: the code's send, then one dispatch for its row's recipient, after the answer", () => {
  it("answers first and hands the send to the request's waitUntil, which has not begun it; once run, the code row's recipient is read by its id and woken once, on the page call's trace", async () => {
    const made = await world();
    const { page, handed } = pageOf("signInStart", signInRequestJson.request);

    const outcome = await pagesOver(made).signInStart(page);

    expect(outcome).toMatchObject({ result: "started", way: "email" });
    expect(made.starts).toHaveLength(1);
    expect(handed).toHaveLength(1);
    // The send starts a turn after the answer: nothing of it has run yet.
    expect(made.sends).toEqual([]);

    await Promise.all(handed);

    const [send] = made.sends;
    expect(made.sends).toHaveLength(1);
    expect(made.recipientReads).toEqual([[send?.emailRowId, page.trace.traceId]]);
    expect(made.wakes).toEqual([[RECIPIENT, page.trace]]);
    expect(made.lines).toEqual([]);
    expect(made.hashAsks).toEqual([page.trace.traceId]);
  });

  it("a send that answers repeated (the attempt's code row written before) wakes its recipient too", async () => {
    const made = await world({
      send: (request) => ({
        result: "sent",
        proofCodeId: request.code.id,
        outboxRowId: request.emailRowId,
        expiresAt: "2026-11-15T13:10:01Z",
        repeated: true,
      }),
    });
    const { page, handed } = pageOf("signInStart", signInRequestJson.request);

    await pagesOver(made).signInStart(page);
    await Promise.all(handed);

    expect(made.wakes.map(([recipient]) => recipient)).toEqual([RECIPIENT]);
  });

  it.each([
    ["notSent", (): SendSignInCodeOutcome => ({ result: "notSent", why: "dayCap" })],
    [
      "constraint",
      (): SendSignInCodeOutcome => ({
        error: "constraint",
        sqlstate: "23503",
        constraint: "outbox_rows_bundle_fk",
      }),
    ],
    ["transient", (): SendSignInCodeOutcome => ({ error: "transient", sqlstate: "40001" })],
  ])("a send that wrote nothing (%s) reads no recipient and wakes nothing", async (_name, answer) => {
    const made = await world({ send: answer });
    const { page, handed } = pageOf("signInStart", signInRequestJson.request);

    await pagesOver(made).signInStart(page);
    await Promise.all(handed);

    expect(made.sends).toHaveLength(1);
    expect(made.recipientReads).toEqual([]);
    expect(made.wakes).toEqual([]);
    expect(made.lines).toEqual([]);
  });

  it.each([
    ["K-05 names no recipient", () => Promise.resolve(null), "noRecipient", null],
    [
      "the read throws",
      () =>
        Promise.reject(
          Object.assign(new Error("sendState: the database call failed"), {
            name: "DataAccessDatabaseError",
          }),
        ),
      "recipientRead",
      "DataAccessDatabaseError",
    ],
    [
      "the read throws with a name that is no label",
      () => Promise.reject(Object.assign(new Error("x"), { name: "sam@lees-barbershop.example" })),
      "recipientRead",
      "error",
    ],
  ] as const)(
    "%s: nothing is woken, and one line names the stage and the error's label alone, on the call's trace",
    async (_name, recipient, stage, error) => {
      const made = await world({ recipient });
      const { page, handed } = pageOf("signInStart", signInRequestJson.request);

      await pagesOver(made).signInStart(page);
      await Promise.all(handed);

      expect(made.wakes).toEqual([]);
      expect(made.lines).toEqual([
        {
          level: "warn",
          msg: "signInWakeFailed",
          trace_id: page.trace.traceId,
          stage,
          error,
          environment: "staging",
          version: "test-sha",
        },
      ]);
    },
  );

  it("a wake that fails writes one line of its stage and label; the work handed on still ends, never rejected", async () => {
    const made = await world({
      wake: () => Promise.reject(Object.assign(new Error("no claim"), { name: "NoDatabaseError" })),
    });
    const { page, handed } = pageOf("signInStart", signInRequestJson.request);

    await pagesOver(made).signInStart(page);
    const settled = await Promise.allSettled(handed);

    expect(settled.map((each) => each.status)).toEqual(["fulfilled"]);
    expect(made.wakes).toHaveLength(1);
    expect(made.lines.map((line) => [line.stage, line.error])).toEqual([["dispatch", "NoDatabaseError"]]);
  });

  it("with no waitUntil handed on (no execution context), the send and the wake still run, after the answer", async () => {
    const made = await world();
    const { page } = pageOf("signInStart", signInRequestJson.request, { waitUntil: false });

    await pagesOver(made).signInStart(page);
    expect(made.sends).toEqual([]);
    await turns();

    expect(made.sends).toHaveLength(1);
    expect(made.wakes.map(([recipient]) => recipient)).toEqual([RECIPIENT]);
  });

  it("with no hashing port (no usable PROOF_CODE_HASH_KEY) the start gives no outcome, writes nothing and hands nothing on", async () => {
    const made = await world({ hash: null });
    const { page, handed } = pageOf("signInStart", signInRequestJson.request);

    await expect(pagesOver(made).signInStart(page)).rejects.toMatchObject({
      name: "SignInError",
      code: "noHashKey",
    });

    expect(made.starts).toEqual([]);
    expect(handed).toEqual([]);
  });
});

describe("signInCheck and signOut", () => {
  it("a check asks the hashing port once, by its trace id; a sign-out never asks for it", async () => {
    const made = await world();
    const check = pageOf("signInCheck", {
      page: {
        requestId: "req-t1289-check",
        traceId: "trace-t1289-check",
        sessionToken: null,
        linkCode: null,
      },
      attemptId: "attempt-t1289-unknown",
      code: "123456",
      deviceToken: signInRequestJson.request.deviceToken,
    });
    const out = pageOf("signOut", signOutJson.request);
    const pages = pagesOver(made);

    expect(await pages.signInCheck(check.page)).toEqual({ error: "attemptNotFound" });
    expect(await pages.signOut(out.page)).toEqual({ result: "signedOut", repeated: true });

    expect(made.hashAsks).toEqual([check.page.trace.traceId]);
    // Neither answer names anything to log, so nothing is handed on.
    expect([check.handed, out.handed]).toEqual([[], []]);
  });
});
