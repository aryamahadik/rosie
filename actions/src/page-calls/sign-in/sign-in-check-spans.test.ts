// T-1285 (ADR-016 card B2): no code, token, device token or attempt id in a span or log. Every way a check and a sign-out
// can go, through the gateway's page entry with its own log sink on console.log, and the work each hands to `later`:
// each span holds K-08 v1's fields and fixed labels alone, and no log line holds any value of the sign-in (the codes as
// typed, the session's token and its sha256, the device tokens and their sha256, the page's and the server's attempt
// ids, the session's and the code's ids, the typed code's hash, the request ids, the person, the contacts typed).
// The page entry opens each trace under a fixed x-trace-id with no run of digits, so no span id or trace id can hold a
// code by chance.

import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePageCall, unconfiguredPages } from "../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../runtime/src/gateway/answer";
import type { PageCallName } from "../../../../runtime/src/gateway/pages/calls";
import { spanProblems } from "../../../../runtime/src/trace";
import { createSignInCheckHandlers } from "./check";
import {
  CODE,
  OTHER_DEVICE,
  WRONG_CODE,
  checkRequest,
  checkWorld,
  signOutRequest,
  type CheckWorld,
} from "./check-test-support";
import { createSignInHandlers } from "./start";
import { NOBODY_TYPED, SAM_PERSON, SAM_TYPED, spanSchemaProblems, startRequest } from "./test-support";
import type { EntriesReport, SignInCheckDeps } from "./types";

const TRACE_ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const SAM_DEVICE = "placeholder-device-token-sam-laptop";
const NOBODY_DEVICE = "placeholder-device-token-unknown-2";
const at = (time: string): number => Date.parse(time);

afterEach(() => {
  vi.restoreAllMocks();
});

/** console.log's lines while a test runs. */
function logLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

/** One call through the page entry, under the fixed trace id: its status and its body. */
async function post(
  world: CheckWorld,
  call: PageCallName,
  request: Record<string, unknown>,
  deps: SignInCheckDeps = world.deps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handlePageCall(
    new Request(`https://rosfield.example/test/page-api/${call}`, {
      method: "POST",
      headers: { "x-trace-id": TRACE_ID },
      body: JSON.stringify(request),
    }),
    call,
    {
      handlers: {
        ...unconfiguredPages(),
        ...createSignInHandlers(world.startDeps),
        ...createSignInCheckHandlers(deps),
      },
      bundleId: () => DEFAULT_BUNDLE_ID,
    },
    { environment: "staging", version: "test" },
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** Runs the sends and the entries every handler handed to `later`, in order. */
async function runLater(world: CheckWorld): Promise<EntriesReport[]> {
  for (const work of world.sends.splice(0)) await work();
  const reports: EntriesReport[] = [];
  for (const work of world.entries.splice(0)) reports.push(await work());
  return reports;
}

/** Every value of the run that must never be logged or put in a span, from the double's records and the answers. */
function secretsOf(world: CheckWorld, answers: readonly Record<string, unknown>[]): string[] {
  const { double } = world;
  const values = [
    CODE,
    WRONG_CODE,
    SAM_TYPED,
    NOBODY_TYPED,
    SAM_DEVICE,
    NOBODY_DEVICE,
    OTHER_DEVICE,
    SAM_PERSON,
    ...answers.flatMap((answer) => (typeof answer.sessionToken === "string" ? [answer.sessionToken] : [])),
    ...double.proves.flatMap((prove) => [
      prove.attemptId,
      prove.deviceSha256,
      prove.requestId,
      prove.typedHash,
      prove.session.id,
      prove.session.tokenSha256,
    ]),
    ...double.ends.map((end) => end.tokenSha256),
    ...double.attempts.flatMap((attempt) => [
      attempt.id,
      attempt.attemptId,
      attempt.contactHash,
      attempt.deviceSha256,
      attempt.requestSha256,
    ]),
    ...double.codes.keys(),
    ...double.sessions.keys(),
    ...double.log.keys(),
    ...double.entryAsks.map((ask) => ask.jobId),
  ];
  return [...new Set(values)];
}

describe("no code, token, device token or attempt id in a span or log", () => {
  it("every way a check and a sign-out go, their entries included, logs and spans none of the sign-in's values", async () => {
    const lines = logLines();
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    world.double.standings.set(SAM_PERSON, {
      roles: [{ role: "owner", businessId: "biz-lees-barbershop" }],
      team: true,
    });
    const answers: Record<string, unknown>[] = [];
    const call = async (
      name: PageCallName,
      request: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const { status, body } = await post(world, name, request);
      expect(status).toBe(200);
      answers.push(body);
      return body;
    };

    // Two starts: Sam's (his code sent) and an address no account holds.
    const sam = (await call("signInStart", startRequest({ requestId: "req-a", deviceToken: SAM_DEVICE })))
      .attemptId as string;
    const nobody = (
      await call(
        "signInStart",
        startRequest({ typed: NOBODY_TYPED, requestId: "req-b", deviceToken: NOBODY_DEVICE }),
      )
    ).attemptId as string;
    await runLater(world);

    // A wrong code, a check from another device, and five wrong codes then a sixth on the attempt with no account.
    world.double.now = at("2026-10-28T15:05:30Z");
    await call("signInCheck", checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, requestId: "req-c" }));
    await call(
      "signInCheck",
      checkRequest({ attemptId: sam, deviceToken: OTHER_DEVICE, code: CODE, requestId: "req-d" }),
    );
    for (let index = 0; index < 6; index += 1)
      await call(
        "signInCheck",
        checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: `req-n${String(index)}` }),
      );

    // The right code, whose standing read fails with an error that quotes the code and the device; then its repeat.
    world.double.scriptedStandings.push(new Error(`boom ${CODE} ${SAM_DEVICE}`));
    const signedIn = await call(
      "signInCheck",
      checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, code: CODE, requestId: "req-e" }),
    );
    expect(signedIn).toMatchObject({ result: "signedIn", person: { roles: [], team: false, tester: false } });
    await call(
      "signInCheck",
      checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, code: CODE, requestId: "req-e" }),
    );
    // The check's entries, the first lost to a fault that quotes the code, then logged by the next.
    world.double.scriptedEntries.push(new Error(`entries ${CODE}`));
    expect(await runLater(world)).toEqual([
      { result: "failed", error: "Error" },
      expect.objectContaining({ result: "logged" }),
    ]);

    // Sign out with the token, its entry, and the sign-out again.
    const token = signedIn.sessionToken as string;
    world.double.now = at("2026-10-28T15:30:00Z");
    expect(await call("signOut", signOutRequest({ sessionToken: token, requestId: "req-f" }))).toEqual({
      result: "signedOut",
      repeated: false,
    });
    expect(await runLater(world)).toEqual([{ result: "logged", written: 1, found: 0 }]);
    expect(await call("signOut", signOutRequest({ sessionToken: token, requestId: "req-g" }))).toEqual({
      result: "signedOut",
      repeated: true,
    });
    // A check past its 10 minutes.
    await call(
      "signInCheck",
      checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: "req-h" }),
    );

    const spans = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "span");
    expect(spans.length).toBeGreaterThanOrEqual(answers.length);
    for (const span of spans) {
      // The span's own fields, without the log line's (ADR-009: level, msg, environment, version).
      const fields = Object.fromEntries(
        Object.entries(span).filter(([key]) => !["level", "msg", "environment", "version"].includes(key)),
      );
      expect(spanProblems(fields)).toEqual([]);
      expect(spanSchemaProblems(fields)).toEqual([]);
    }
    expect(spans.map((span) => span.decided)).toContainEqual({ standing: "failed" });
    expect(spans.map((span) => span.decided)).toContainEqual({ signInEntries: "failed" });
    expect(spans.map((span) => span.decided)).toContainEqual({ signInEntries: "logged" });

    const logged = lines.join("\n");
    const secrets = secretsOf(world, answers);
    expect(secrets.length).toBeGreaterThanOrEqual(30);
    for (const secret of [...secrets, "boom"]) expect(logged).not.toContain(secret);
  });

  it("a store that throws, and a binding that cannot run the entries, log only labels", async () => {
    const lines = logLines();
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const { body } = await post(
      world,
      "signInStart",
      startRequest({ requestId: "req-a", deviceToken: SAM_DEVICE }),
    );
    const attemptId = body.attemptId as string;
    await runLater(world);

    // proveSignIn throws an error that quotes the attempt and the code: the entry answers 503 and logs its name alone.
    const prove = world.double.proveSignIn.bind(world.double);
    world.double.proveSignIn = () => Promise.reject(new TypeError(`kaboom ${attemptId} ${CODE}`));
    const failed = await post(
      world,
      "signInCheck",
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE, requestId: "req-b" }),
    );
    expect(failed).toEqual({
      status: 503,
      body: expect.objectContaining({ ok: false, error: "unavailable" }) as unknown,
    });
    world.double.proveSignIn = prove;

    // A `later` that throws: the answer stands, and one span names the failure.
    const right = await post(
      world,
      "signInCheck",
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE, requestId: "req-c" }),
      {
        ...world.deps,
        later: () => {
          throw new Error(`no waitUntil ${attemptId}`);
        },
      },
    );
    expect(right.body).toMatchObject({ result: "signedIn" });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toContainEqual(
      expect.objectContaining({ msg: "gateway_failed", stage: "pageHandler", error: "TypeError" }),
    );
    expect(parsed).toContainEqual(
      expect.objectContaining({
        msg: "span",
        decided: { signInEntries: "failed" },
        error_code: "notScheduled",
      }),
    );
    const logged = lines.join("\n");
    for (const secret of [...secretsOf(world, [right.body]), "kaboom", "waitUntil"])
      expect(logged).not.toContain(secret);
  });
});
