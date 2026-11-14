// T-1282 (ADR-016 card B1): signInStart's server side, against K-21 v1's fixtures and a double of K-05 v1.13's send side,
// each answer and request held to the contracts' own schemas. The card's proofs, in its order:
//   - sign-in-request.json answers started;
//   - the answer has the same fields with or without an account and is given before the send's port is called;
//   - a repeated requestId sends no second code;
//   - a start during a pause, past the cap and past the hour's bound answer paused and send nothing;
//   - way text is refused (503) and writes nothing;
//   - account link answers started and sends nothing;
//   - no code, contact or attempt id in a span or log;
// and the lead notes' own (DL-546, DL-610): the 128-bit ids from Web Crypto's fill, and a link's start hashed by its link
// code. One send per contact at a time is K-05 sendSignInCode's own locks (db/repo, T-1280), the one send path here.

import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePageCall, unconfiguredPages } from "../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../runtime/src/gateway/answer";
import { spanProblems } from "../../../../runtime/src/trace";
import { KEYED_CODE_IDS, WEB_CRYPTO_FILL, hmacSha256Hash, type KeyedHash } from "../../domain/proof-codes";
import { TEST_KEY_BYTES, TEST_KEY_NAME, nodeCodeHash, testHash } from "../../domain/proof-codes/test-support";
import { SignInError } from "./errors";
import { ATTEMPT_ID_PREFIX, ATTEMPT_SERVER_ID_PREFIX, ID_RANDOM_BYTES, base64Url } from "./hashes";
import { createSignInHandlers, signInStart, signInStartHandler } from "./start";
import {
  NOBODY_TYPED,
  SAM_PERSON,
  SAM_TYPED,
  SIGN_IN_REQUEST,
  SignInDouble,
  capturedPage,
  k05Fixture,
  k05Problems,
  k21Problems,
  linkStartRequest,
  nodeContactHash,
  nodeSha256,
  spanSchemaProblems,
  startRequest,
  testFill,
  tripwire,
  type CapturedPage,
} from "./test-support";
import type { AfterAnswer, SendReport, SignInHandlerDeps, SignInSendStore, SignInStartDeps } from "./types";

const NOW = SIGN_IN_REQUEST.given.now;
const MINUTE = 60_000;
/** S11-52's example code; the 32-bit draw that gives it (below the top range, so taken at once). */
const CODE = "482913";
const CODE_DRAW = 482913;
const CODE_LINE = `Code ${CODE}: type it on the sign-in page. It works for 10 minutes.`;
const URL_SAFE_ID = /^(sign-in|attempt)-[A-Za-z0-9_-]{22}$/u;

/** The ports a call reaches, in order: the hashing port's calls and the store's. */
function recordingHash(hash: KeyedHash, calls: string[]): KeyedHash {
  return {
    keyName: hash.keyName,
    hmacHex(message) {
      calls.push("hmacHex");
      return hash.hmacHex(message);
    },
  };
}

/** One run's world: the double, the hashing port, the fill and the sends `later` was handed. */
interface World {
  readonly double: SignInDouble;
  readonly calls: string[];
  readonly fill: ReturnType<typeof testFill>;
  readonly deps: SignInHandlerDeps;
  readonly later: AfterAnswer[];
}

async function world(
  options: { readonly accounts?: [string, string][]; readonly draws?: number[] } = {},
): Promise<World> {
  const calls: string[] = [];
  const double = new SignInDouble(NOW, calls);
  const accounts: readonly [string, string][] = options.accounts ?? [[`email:${SAM_TYPED}`, SAM_PERSON]];
  for (const [key, person] of accounts) double.account(key, person);
  const fill = testFill(options.draws ?? [CODE_DRAW]);
  const later: AfterAnswer[] = [];
  const deps: SignInHandlerDeps = {
    store: double,
    hash: recordingHash(await testHash(), calls),
    random: fill.fill,
    later: (work) => {
      later.push(work);
    },
  };
  return { double, calls, fill, deps, later };
}

/** Runs every send `later` was handed, in order, and gives their reports. */
async function runLater(run: World): Promise<SendReport[]> {
  const reports: SendReport[] = [];
  for (const work of run.later.splice(0)) reports.push(await work());
  return reports;
}

describe("sign-in-request.json answers started", () => {
  it("the fixture's request gives the fixture's answer, the attempt id drawn at random", async () => {
    const run = await world();
    const { page } = capturedPage(SIGN_IN_REQUEST.request);
    const outcome = await signInStartHandler(page, run.deps);

    const [start] = run.double.starts;
    expect(start).toBeDefined();
    expect(outcome).toEqual({ ...SIGN_IN_REQUEST.outcome, attemptId: start?.attemptId });
    expect(k21Problems(outcome, "signInStart.response")).toEqual([]);
    expect(k21Problems({ ...SIGN_IN_REQUEST, outcome }, "signInStart.exchange")).toEqual([]);
  });

  it("startSignIn gets K-05 v1.13's request: only hashes, the two ids, the contact read and way email", async () => {
    const run = await world();
    const { page } = capturedPage(SIGN_IN_REQUEST.request);
    await signInStartHandler(page, run.deps);

    const request = SIGN_IN_REQUEST.request as { page: { requestId: string }; deviceToken: string };
    const deviceSha256 = nodeSha256(request.deviceToken);
    const [start] = run.double.starts;
    expect(k05Problems(start, "startSignIn.request")).toEqual([]);
    expect(start).toEqual({
      id: `${ATTEMPT_SERVER_ID_PREFIX}${base64Url(Uint8Array.from({ length: 16 }, (_, index) => index))}`,
      attemptId: `${ATTEMPT_ID_PREFIX}${base64Url(Uint8Array.from({ length: 16 }, (_, index) => index + 16))}`,
      requestSha256: nodeSha256(`${deviceSha256}\n${request.page.requestId}`),
      deviceSha256,
      contact: { kind: "email", address: SAM_TYPED },
      contactHash: nodeContactHash("email", SAM_TYPED),
      hashKeyName: TEST_KEY_NAME,
      way: "email",
    });
    // K-05's own answer to it, as the double gave it, is K-05 v1.13's.
    expect(k05Problems(run.double.answers[0], "startSignIn.response")).toEqual([]);
  });

  it("a typed mobile on the email way is read in E.164, and its answer is the same started", async () => {
    const run = await world({ accounts: [["mobile:+15555550111", SAM_PERSON]] });
    const { page } = capturedPage(startRequest({ kind: "mobile", typed: "(555) 555-0111" }));
    const outcome = await signInStartHandler(page, run.deps);
    expect(outcome).toMatchObject({ result: "started", way: "email", readyText: null, textLink: null });
    expect(run.double.starts[0]?.contact).toEqual({ kind: "mobile", number: "+15555550111" });
    expect(run.double.starts[0]?.contactHash).toBe(nodeContactHash("mobile", "+15555550111"));
    expect(run.later).toHaveLength(1);
  });
});

describe("the answer has the same fields with or without an account and is given before the send's port is called", () => {
  async function answerOf(typed: string): Promise<{ run: World; outcome: unknown; ports: string[] }> {
    const run = await world();
    const { page } = capturedPage(startRequest({ typed }));
    const outcome = await signInStartHandler(page, run.deps);
    return { run, outcome, ports: [...run.calls] };
  }

  it("Sam's address and an address no account holds give the same answer, field for field and value for value", async () => {
    const withAccount = await answerOf(SAM_TYPED);
    const without = await answerOf(NOBODY_TYPED);
    expect(withAccount.run.double.answers[0]).toMatchObject({ result: "started", personId: SAM_PERSON });
    expect(without.run.double.answers[0]).toMatchObject({ result: "started", personId: null });

    expect(Object.keys(withAccount.outcome as object)).toEqual(Object.keys(without.outcome as object));
    expect(withAccount.outcome).toEqual(without.outcome);
    for (const { outcome } of [withAccount, without])
      expect(k21Problems(outcome, "signInStart.response")).toEqual([]);
  });

  it("before the answer both reach the same ports in the same order: the contact's hash, then startSignIn", async () => {
    const withAccount = await answerOf(SAM_TYPED);
    const without = await answerOf(NOBODY_TYPED);
    expect(withAccount.ports).toEqual(["hmacHex", "startSignIn"]);
    expect(without.ports).toEqual(withAccount.ports);
    // Nothing of the code exists yet on either path: no 32-bit draw, no code hash, no send.
    for (const { run } of [withAccount, without]) {
      expect(run.fill.asked).toEqual([
        { kind: "uint8", length: ID_RANDOM_BYTES },
        { kind: "uint8", length: ID_RANDOM_BYTES },
      ]);
      expect(run.double.sends).toEqual([]);
    }
  });

  it("with an account the send runs after the answer: the code is drawn, hashed and sent only then, once", async () => {
    const { run } = await answerOf(SAM_TYPED);
    expect(run.double.sends).toEqual([]);
    expect(run.later).toHaveLength(1);

    const reports = await runLater(run);
    expect(run.calls).toEqual(["hmacHex", "startSignIn", "hmacHex", "sendSignInCode"]);
    expect(run.fill.asked.filter((asked) => asked.kind === "uint32")).toEqual([
      { kind: "uint32", length: 1 },
    ]);
    expect(run.double.sends).toHaveLength(1);
    expect(reports).toEqual([
      {
        result: "sent",
        outboxRowId: run.double.sends[0]?.emailRowId,
        proofCodeId: run.double.sends[0]?.code.id,
      },
    ]);
  });

  it("without an account nothing is handed on to send, and nothing is sent", async () => {
    const { run } = await answerOf(NOBODY_TYPED);
    expect(run.later).toEqual([]);
    expect(run.double.sends).toEqual([]);
    expect(run.fill.asked.filter((asked) => asked.kind === "uint32")).toEqual([]);
  });

  it("the send is K-05 v1.13's request: the attempt's server id, the code's keyed hash, T-322's words, the trace's bundle", async () => {
    const { run } = await answerOf(SAM_TYPED);
    await runLater(run);
    const [send] = run.double.sends;
    const [start] = run.double.starts;
    expect(k05Problems(send, "sendSignInCode.request")).toEqual([]);
    const codeId = await KEYED_CODE_IDS.codeId(start?.id ?? "");
    const rowId = await KEYED_CODE_IDS.emailRowId(start?.id ?? "");
    expect(send).toMatchObject({
      signInAttemptId: start?.id,
      bundle: DEFAULT_BUNDLE_ID,
      code: { id: codeId, codeHash: nodeCodeHash(CODE), hashKeyName: TEST_KEY_NAME },
      emailRowId: rowId,
    });
    // K-05's own fixture's plan and final parts, with this row's id and this code.
    const fixture = k05Fixture("send-sign-in-code-sam.json").request as {
      plan: { row: string };
      finalParts: { row: string; sends: { text: string }[] };
    };
    expect(send?.plan).toEqual({ ...fixture.plan, row: rowId });
    expect(send?.finalParts).toEqual({
      ...fixture.finalParts,
      row: rowId,
      sends: [{ ...fixture.finalParts.sends[0], text: CODE_LINE }],
    });
    expect(k05Problems(run.double.answers[1], "sendSignInCode.response")).toEqual([]);
  });

  it("through the page entry, the two answers are the same bytes, and the send comes after the entry has answered", async () => {
    // The entry's span lines (and the send's) are read in the "span or log" tests; here they are kept off the output.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bodies: string[] = [];
    let withAccount: World | undefined;
    for (const typed of [SAM_TYPED, NOBODY_TYPED]) {
      const run = await world();
      withAccount ??= run;
      const response = await handlePageCall(
        new Request("https://rosfield.example/test/page-api/signInStart", {
          method: "POST",
          body: JSON.stringify(startRequest({ typed })),
        }),
        "signInStart",
        {
          handlers: { ...unconfiguredPages(), ...createSignInHandlers(run.deps) },
          bundleId: () => DEFAULT_BUNDLE_ID,
        },
        { environment: "staging", version: "test" },
      );
      expect(response.status).toBe(200);
      bodies.push(await response.text());
      expect(run.double.sends).toEqual([]);
    }
    expect(bodies[0]).toBe(bodies[1]);
    expect(withAccount?.later).toHaveLength(1);
    if (withAccount !== undefined) await runLater(withAccount);
    log.mockRestore();
    expect(withAccount?.double.sends).toHaveLength(1);
  });
});

describe("a repeated requestId sends no second code", () => {
  it("a start sent again answers the first attempt, and only the first sends a code", async () => {
    const run = await world();
    const first = await signInStartHandler(capturedPage(startRequest()).page, run.deps);
    await runLater(run);
    run.double.now += 5_000;
    const again = await signInStartHandler(capturedPage(startRequest()).page, run.deps);

    expect(again).toEqual(first);
    expect(run.double.answers[2]).toMatchObject({ result: "started", repeated: true, personId: null });
    expect(run.later).toEqual([]);
    await runLater(run);
    expect(run.double.sends).toHaveLength(1);
    expect(run.double.attempts).toHaveLength(1);
    // The repeat drew new ids and sent the same repeat key.
    expect(run.double.starts[1]?.attemptId).not.toBe(run.double.starts[0]?.attemptId);
    expect(run.double.starts[1]?.requestSha256).toBe(run.double.starts[0]?.requestSha256);
  });

  it("a repeat whose store still names a person sends nothing: only a start that is not a repeat sends", async () => {
    const run = await world();
    const lying: SignInSendStore = {
      startSignIn: () =>
        Promise.resolve({
          result: "started",
          id: "sign-in-first",
          attemptId: "attempt-first",
          expiresAt: "2026-10-26T13:10:00Z",
          repeated: true,
          personId: SAM_PERSON,
        }),
      sendSignInCode: (request) => run.double.sendSignInCode(request),
    };
    const result = await signInStart(capturedPage(startRequest()).page, { ...run.deps, store: lying });
    expect(result.afterAnswer).toBeNull();
    expect(result.outcome).toMatchObject({ result: "started", attemptId: "attempt-first" });
  });

  it("the same requestId from another browser is its own start, not a repeat", async () => {
    const run = await world({ draws: [CODE_DRAW, CODE_DRAW + 1] });
    await signInStartHandler(capturedPage(startRequest()).page, run.deps);
    const other = await signInStartHandler(
      capturedPage(startRequest({ deviceToken: "placeholder-device-token-sam-phone" })).page,
      run.deps,
    );
    expect(run.double.attempts).toHaveLength(2);
    expect(other).toMatchObject({ result: "started", attemptId: run.double.attempts[1]?.attemptId });
    await runLater(run);
    expect(run.double.sends).toHaveLength(2);
  });
});

describe("a start during a pause, past the cap and past the hour's bound answer paused and send nothing", () => {
  it.each([
    ["Sam's address, with an account", SAM_TYPED],
    ["an address no account holds", NOBODY_TYPED],
  ])("during the contact's pause: %s answers paused until the pause's end", async (_name, typed) => {
    const run = await world();
    const startedAt = Date.parse(NOW) - 4 * MINUTE;
    run.double.seed({
      contactHash: nodeContactHash("email", typed),
      startedAt,
      pausedUntil: startedAt + 15 * MINUTE,
    });
    const captured = capturedPage(startRequest({ typed }));
    const outcome = await signInStartHandler(captured.page, run.deps);
    expect(outcome).toEqual({ error: "paused", until: "2026-10-26T13:11:00Z" });
    expect(k21Problems(outcome, "signInStart.errors")).toEqual([]);
    expect(run.double.answers[0]).toMatchObject({ result: "paused", by: "contactPause" });
    expect(run.later).toEqual([]);
    expect(run.double.sends).toEqual([]);
    // The rule is the server's span's alone (K-05 v1.13 default 127), and the span holds no contact or id.
    expect(captured.spans).toEqual([
      expect.objectContaining({
        hop: "pageRequest",
        outcome: "refused",
        decided: { signInStart: "paused", by: "contactPause" },
      }),
    ]);
    expect(spanSchemaProblems(captured.spans[0])).toEqual([]);
    const spanText = JSON.stringify(captured.spans);
    const [start] = run.double.starts;
    for (const secret of [typed, start?.contactHash ?? "?", start?.attemptId ?? "?", start?.id ?? "?"])
      expect(spanText).not.toContain(secret);
  });

  it("a start that is not paused writes no span of its own before the answer", async () => {
    const run = await world();
    const captured = capturedPage(startRequest());
    await signInStartHandler(captured.page, run.deps);
    expect(captured.spans).toEqual([]);
  });

  it("past the day's cap: five starts send five codes, the sixth answers paused until the first's 24 hours end", async () => {
    const run = await world({ draws: [100_001, 100_002, 100_003, 100_004, 100_005, 100_006] });
    const answers: unknown[] = [];
    for (let start = 1; start <= 6; start += 1) {
      answers.push(
        await signInStartHandler(
          capturedPage(startRequest({ requestId: `req-portal-sam-signin-${String(start)}` })).page,
          run.deps,
        ),
      );
      await runLater(run);
      run.double.now += MINUTE;
    }
    expect(answers.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () => expect.objectContaining({ result: "started" }) as unknown),
    );
    expect(answers[5]).toEqual({ error: "paused", until: "2026-10-27T13:00:00Z" });
    expect(run.double.answers.at(-1)).toMatchObject({ result: "paused", by: "dayCap" });
    expect(run.double.sends).toHaveLength(5);
    expect(run.fill.asked.filter((asked) => asked.kind === "uint32")).toHaveLength(5);
  });

  it("past the hour's bound: 100 starts of other contacts in the hour pause every contact, and nothing is sent", async () => {
    const run = await world();
    const oldest = Date.parse(NOW) - 50 * MINUTE;
    for (let index = 0; index < 100; index += 1)
      run.double.seed({
        contactHash: nodeSha256(`another contact ${String(index)}`),
        startedAt: oldest + index * 1_000,
      });
    for (const typed of [SAM_TYPED, NOBODY_TYPED]) {
      const captured = capturedPage(startRequest({ typed }));
      const outcome = await signInStartHandler(captured.page, run.deps);
      expect(outcome).toEqual({ error: "paused", until: "2026-10-26T13:10:00Z" });
      expect(captured.spans.map((span) => span.decided)).toEqual([
        { signInStart: "paused", by: "hourBound" },
      ]);
    }
    expect(run.double.answers.map((answer) => (answer as { by?: string }).by)).toEqual([
      "hourBound",
      "hourBound",
    ]);
    expect(run.later).toEqual([]);
    expect(run.double.sends).toEqual([]);
  });
});

describe("way text is refused (503) and writes nothing", () => {
  it.each([
    ["a typed email on the text way", startRequest({ way: "text" })],
    [
      "a link's own start on the text way (sign-in-from-link-by-text.json)",
      { ...linkStartRequest(), way: "text" },
    ],
  ])("%s: no outcome, and no port is reached", async (_name, request) => {
    const touched: string[] = [];
    const deps: SignInStartDeps = { store: tripwire("store", touched), hash: tripwire("hash", touched) };
    await expect(signInStart(capturedPage(request).page, deps)).rejects.toEqual(
      new SignInError("textWayNotServed"),
    );
    expect(touched).toEqual([]);
  });

  it("through the page entry it answers 503, the edge's own answer, and only the error's name is logged", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const touched: string[] = [];
    const later: AfterAnswer[] = [];
    const response = await handlePageCall(
      new Request("https://rosfield.example/test/page-api/signInStart", {
        method: "POST",
        body: JSON.stringify(startRequest({ way: "text" })),
      }),
      "signInStart",
      {
        handlers: {
          ...unconfiguredPages(),
          ...createSignInHandlers({
            store: tripwire("store", touched),
            hash: tripwire("hash", touched),
            later: (work) => {
              later.push(work);
            },
          }),
        },
        bundleId: () => DEFAULT_BUNDLE_ID,
      },
      { environment: "staging", version: "test" },
    );
    log.mockRestore();
    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: false, error: "unavailable" });
    expect(touched).toEqual([]);
    expect(later).toEqual([]);
    expect(lines.join("\n")).toContain('"error":"SignInError"');
    expect(lines.join("\n")).not.toContain(SAM_TYPED);
  });
});

describe("account link answers started and sends nothing", () => {
  it("a link's own start is counted by its link code, answers started, and hands nothing on to send", async () => {
    const run = await world();
    const request = linkStartRequest();
    const outcome = await signInStartHandler(capturedPage(request).page, run.deps);
    const linkCode = (request.page as { linkCode: string }).linkCode;

    expect(outcome).toMatchObject({ result: "started", way: "email", readyText: null, textLink: null });
    expect(k21Problems(outcome, "signInStart.response")).toEqual([]);
    expect(run.double.starts[0]?.contact).toEqual({ kind: "link" });
    expect(run.double.starts[0]?.contactHash).toBe(nodeContactHash("link", linkCode));
    expect(k05Problems(run.double.starts[0], "startSignIn.request")).toEqual([]);
    expect(run.later).toEqual([]);
    expect(run.double.sends).toEqual([]);
  });

  it("even a store that names a person for a link's start sends nothing (ADR-016 section 5)", async () => {
    const run = await world();
    const naming: SignInSendStore = {
      startSignIn: async (request) =>
        ({
          ...(await run.double.startSignIn(request)),
          personId: SAM_PERSON,
        }) as Awaited<ReturnType<SignInSendStore["startSignIn"]>>,
      sendSignInCode: (request) => run.double.sendSignInCode(request),
    };
    const result = await signInStart(capturedPage(linkStartRequest()).page, { ...run.deps, store: naming });
    expect(result.outcome).toMatchObject({ result: "started" });
    expect(result.afterAnswer).toBeNull();
  });
});

describe("no code, contact or attempt id in a span or log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every value of one sign-in that must never be logged or put in a span. */
  function secretsOf(run: World, typed: string): string[] {
    const [start] = run.double.starts;
    const [send] = run.double.sends;
    const request = startRequest({ typed }) as { page: { requestId: string }; deviceToken: string };
    return [
      CODE,
      CODE_LINE,
      typed,
      typed.trim().toLowerCase(),
      request.deviceToken,
      request.page.requestId,
      start?.id ?? "",
      start?.attemptId ?? "",
      start?.contactHash ?? "",
      start?.deviceSha256 ?? "",
      start?.requestSha256 ?? "",
      send?.code.codeHash ?? "",
    ].filter((value) => value !== "");
  }

  it("a whole sign-in through the page entry, its send included, logs and spans none of them", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const typed = "  Sam@Lees-Barbershop.EXAMPLE ";
    const run = await world();
    const response = await handlePageCall(
      new Request("https://rosfield.example/test/page-api/signInStart", {
        method: "POST",
        body: JSON.stringify(startRequest({ typed })),
      }),
      "signInStart",
      {
        handlers: { ...unconfiguredPages(), ...createSignInHandlers(run.deps) },
        bundleId: () => DEFAULT_BUNDLE_ID,
      },
      { environment: "staging", version: "test" },
    );
    expect(response.status).toBe(200);
    expect(await runLater(run)).toEqual([expect.objectContaining({ result: "sent" })]);

    const spans = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "span");
    expect(spans.map((span) => span.hop)).toEqual(["pageRequest", "pageRequest"]);
    expect(spans[1]).toMatchObject({ decided: { codeSend: "sent" }, outcome: "ok", error_code: null });
    for (const span of spans) {
      // The span's own fields, without the log line's (ADR-009: level, msg, environment, version).
      const fields = Object.fromEntries(
        Object.entries(span).filter(([key]) => !["level", "msg", "environment", "version"].includes(key)),
      );
      expect(spanProblems(fields)).toEqual([]);
      expect(spanSchemaProblems(fields)).toEqual([]);
    }
    const logged = lines.join("\n");
    expect(secretsOf(run, typed).length).toBeGreaterThanOrEqual(11);
    for (const secret of secretsOf(run, typed)) expect(logged).not.toContain(secret);
  });

  it.each<[string, (double: SignInDouble) => void, string, Record<string, unknown>]>([
    [
      "K-05 answers notSent",
      (double) => double.scriptedSends.push({ result: "notSent", why: "dayCap" }),
      "refused",
      { codeSend: "notSent", why: "dayCap" },
    ],
    [
      "K-05 answers transient",
      (double) => double.scriptedSends.push({ error: "transient", sqlstate: "40001" }),
      "failed",
      { codeSend: "failed" },
    ],
    [
      "the store throws an error whose message holds the code and the contact",
      (double) => {
        double.sendSignInCode = () => Promise.reject(new Error(`boom ${CODE} ${SAM_TYPED}`));
      },
      "failed",
      { codeSend: "failed" },
    ],
  ])(
    "when %s, the send's span says so in labels, and the report never rejects",
    async (_name, script, outcome, decided) => {
      const run = await world();
      script(run.double);
      const captured: CapturedPage = capturedPage(startRequest());
      await signInStartHandler(captured.page, run.deps);
      const reports = await runLater(run);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.result).toBe(decided.codeSend);
      const span = captured.spans.at(-1);
      expect(span).toMatchObject({ hop: "pageRequest", outcome, decided });
      expect(spanSchemaProblems(span)).toEqual([]);
      const spanText = JSON.stringify(captured.spans);
      for (const secret of [...secretsOf(run, SAM_TYPED), "boom"]) expect(spanText).not.toContain(secret);
    },
  );

  it("a binding that cannot run the send still gives the same answer, and its span names only the failure", async () => {
    const run = await world();
    const captured = capturedPage(startRequest());
    const outcome = await signInStartHandler(captured.page, {
      ...run.deps,
      later: () => {
        throw new Error(`no waitUntil for ${SAM_TYPED}`);
      },
    });
    const without = await signInStartHandler(capturedPage(startRequest({ typed: NOBODY_TYPED })).page, {
      ...(await world()).deps,
    });
    expect(outcome).toEqual(without);
    expect(captured.spans).toEqual([
      expect.objectContaining({
        hop: "pageRequest",
        outcome: "failed",
        error_code: "notScheduled",
        decided: { codeSend: "failed" },
      }),
    ]);
    expect(JSON.stringify(captured.spans)).not.toContain(SAM_TYPED);
    expect(run.double.sends).toEqual([]);
  });
});

describe("the ids: 128 bits each from Web Crypto's generator (DL-546, DL-610)", () => {
  it("each id is a fixed word and the base64url of 16 fresh bytes from the fill, each id drawn on its own", async () => {
    const run = await world();
    const fill = testFill([], 200);
    await signInStartHandler(capturedPage(startRequest()).page, { ...run.deps, random: fill.fill });
    const [start] = run.double.starts;
    const bytes = (first: number): Uint8Array =>
      Uint8Array.from({ length: 16 }, (_, index) => (first + index) & 0xff);
    expect(fill.asked).toEqual([
      { kind: "uint8", length: 16 },
      { kind: "uint8", length: 16 },
    ]);
    expect(start?.id).toBe(`sign-in-${base64Url(bytes(200))}`);
    expect(start?.attemptId).toBe(`attempt-${base64Url(bytes(216))}`);
  });

  it("with Web Crypto's own fill, every id has 22 URL-safe random characters, and no two are alike", async () => {
    const run = await world();
    const deps: SignInHandlerDeps = { ...run.deps, random: WEB_CRYPTO_FILL };
    for (let start = 0; start < 100; start += 1)
      await signInStartHandler(
        capturedPage(
          startRequest({ requestId: `req-${String(start)}`, typed: `tester-${String(start)}@example.com` }),
        ).page,
        deps,
      );
    const ids = run.double.starts.flatMap((start) => [start.id, start.attemptId]);
    expect(ids).toHaveLength(200);
    for (const id of ids) expect(id).toMatch(URL_SAFE_ID);
    // "sign-in-" and "attempt-" are both 8 characters: the rest is the 22 random ones, each part its own.
    expect(new Set(ids.map((id) => id.slice(8))).size).toBe(200);
    expect(new Set(ids).size).toBe(200);
  });

  it("left out, the fill is Web Crypto's", async () => {
    const run = await world();
    const deps: SignInHandlerDeps = { store: run.deps.store, hash: run.deps.hash, later: run.deps.later };
    const spy = vi.spyOn(crypto, "getRandomValues");
    await signInStartHandler(capturedPage(startRequest()).page, deps);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect(run.double.starts[0]?.id).toMatch(URL_SAFE_ID);
    expect(run.double.starts[0]?.attemptId).toMatch(URL_SAFE_ID);
  });
});

describe("what gives no outcome (503) writes nothing, and every K-05 answer maps to K-21's", () => {
  it.each<[string, Record<string, unknown>, SignInError]>([
    [
      "a request that is not K-21's",
      { ...startRequest(), forPersonId: SAM_PERSON },
      new SignInError("badRequest"),
    ],
    [
      "a typed email that is no address",
      startRequest({ typed: "not an address" }),
      new SignInError("contactNotReadable"),
    ],
    [
      "a typed mobile that is no number",
      startRequest({ kind: "mobile", typed: "555-0111" }),
      new SignInError("contactNotReadable"),
    ],
  ])("%s: no port is reached", async (_name, request, error) => {
    const touched: string[] = [];
    const deps: SignInStartDeps = { store: tripwire("store", touched), hash: await testHash() };
    await expect(signInStart(capturedPage(request).page, deps)).rejects.toMatchObject({ code: error.code });
    expect(touched).toEqual([]);
  });

  it("another call's request is a wiring fault", async () => {
    const touched: string[] = [];
    const deps: SignInStartDeps = { store: tripwire("store", touched), hash: await testHash() };
    await expect(
      signInStart(capturedPage(startRequest(), { call: "signInCheck" }).page, deps),
    ).rejects.toMatchObject({
      code: "wrongCall",
    });
    expect(touched).toEqual([]);
  });

  it("no hashing key bound, or one that names no secret or gives no hash: no outcome, nothing written", async () => {
    const touched: string[] = [];
    const store = tripwire("store", touched);
    await expect(signInStart(capturedPage(startRequest()).page, { store, hash: null })).rejects.toMatchObject(
      {
        code: "noHashKey",
      },
    );
    const unnamed = await hmacSha256Hash(TEST_KEY_NAME, TEST_KEY_BYTES);
    for (const hash of [
      { keyName: "proof code key", hmacHex: unnamed.hmacHex.bind(unnamed) },
      { keyName: TEST_KEY_NAME, hmacHex: () => Promise.resolve("not-a-hash") },
    ])
      await expect(signInStart(capturedPage(startRequest()).page, { store, hash })).rejects.toMatchObject({
        code: "noHashKey",
      });
    expect(touched).toEqual([]);
  });

  it("K-05's transient answers K-21's transient, and nothing is sent", async () => {
    const run = await world();
    const store: SignInSendStore = {
      startSignIn: () => Promise.resolve({ error: "transient", sqlstate: "40001" }),
      sendSignInCode: (request) => run.double.sendSignInCode(request),
    };
    const result = await signInStart(capturedPage(startRequest()).page, { ...run.deps, store });
    expect(result).toEqual({ outcome: { error: "transient", sqlstate: "40001" }, afterAnswer: null });
    expect(k21Problems(result.outcome, "signInStart.errors")).toEqual([]);
  });

  it("K-05's constraint gives no outcome (idTaken), and nothing is handed on to send", async () => {
    const run = await world();
    const store: SignInSendStore = {
      startSignIn: () =>
        Promise.resolve({ error: "constraint", sqlstate: "23505", constraint: "sign_in_attempts_pkey" }),
      sendSignInCode: (request) => run.double.sendSignInCode(request),
    };
    await expect(
      signInStart(capturedPage(startRequest()).page, { ...run.deps, store }),
    ).rejects.toMatchObject({
      code: "idTaken",
    });
  });

  it("a send for an attempt K-05 does not hold reports failed notFound, and the attempt's 10 minutes are K-05's", async () => {
    const run = await world();
    await signInStartHandler(capturedPage(startRequest()).page, run.deps);
    run.double.attempts.splice(0);
    expect(await runLater(run)).toEqual([{ result: "failed", error: "notFound" }]);

    const late = await world();
    await signInStartHandler(capturedPage(startRequest()).page, late.deps);
    late.double.now += 11 * MINUTE;
    expect(await runLater(late)).toEqual([{ result: "notSent", why: "attemptExpired" }]);
    expect(late.double.sends).toHaveLength(1);
  });
});
