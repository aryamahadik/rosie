// T-1285 (ADR-016 card B2): signOut's server side, against K-21 v1's sign-out.json and a double of K-05 v1.13's endSession
// and signInEntries, each answer and request held to the contracts' own schemas: sign-out.json gives its outcome; only
// the token's sha256 reaches K-05, and only that token's live session ends; an ended, expired or unknown session answers
// repeated and logs nothing; the session.ended entry goes after the answer, under the sign-out's own request id.

import { describe, expect, it } from "vitest";

import { signInCheckHandler } from "./check";
import {
  CODE,
  SIGN_IN_DONE,
  SIGN_OUT,
  checkWorld,
  signOutRequest,
  type CheckWorld,
} from "./check-test-support";
import { SignInError } from "./errors";
import { signOut, signOutHandler } from "./sign-out";
import {
  SAM_PERSON,
  capturedPage,
  k05Problems,
  k21Problems,
  nodeContactHash,
  nodeSha256,
  tripwire,
} from "./test-support";
import type { EntriesReport, SignOutDeps } from "./types";

const at = (time: string): number => Date.parse(time);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FIXTURE_TOKEN = (SIGN_OUT.request.page as { sessionToken: string }).sessionToken;
const SAM_PHONE = "placeholder-device-token-sam-phone";

async function signOutOf(
  world: CheckWorld,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return signOutHandler(capturedPage(request, { call: "signOut" }).page, world.deps);
}

async function runEntries(world: CheckWorld): Promise<EntriesReport[]> {
  const reports: EntriesReport[] = [];
  for (const work of world.entries.splice(0)) reports.push(await work());
  return reports;
}

describe("sign-out.json gives its outcome", () => {
  it("the fixture's request ends the live session its token names, and its session.ended goes after the answer", async () => {
    const world = await checkWorld({ now: SIGN_OUT.given.now });
    world.double.seedSession({
      id: "session-sam-s01",
      personId: SAM_PERSON,
      tokenSha256: nodeSha256(FIXTURE_TOKEN),
      deviceSha256: nodeSha256(SAM_PHONE),
      startedAt: at(SIGN_IN_DONE.given.now),
      expiresAt: at(SIGN_IN_DONE.given.now) + 30 * DAY,
    });
    const captured = capturedPage(SIGN_OUT.request, { call: "signOut" });
    const outcome = await signOutHandler(captured.page, world.deps);

    expect(outcome).toEqual(SIGN_OUT.outcome);
    expect(k21Problems(outcome, "signOut.response")).toEqual([]);
    expect(k21Problems({ ...SIGN_OUT, outcome }, "signOut.exchange")).toEqual([]);
    expect(world.double.ends).toEqual([{ tokenSha256: nodeSha256(FIXTURE_TOKEN) }]);
    expect(k05Problems(world.double.ends[0], "endSession.request")).toEqual([]);
    expect(k05Problems(world.double.checkAnswers[0], "endSession.response")).toEqual([]);
    expect(world.double.sessions.get("session-sam-s01")).toMatchObject({
      endedAt: at(SIGN_OUT.given.now),
      endedWhy: "signed_out",
    });

    // The entry waits for the answer, then goes under the sign-out's own request id and the call's own trace.
    expect(world.double.entryAsks).toEqual([]);
    expect(await runEntries(world)).toEqual([{ result: "logged", written: 1, found: 0 }]);
    expect(world.double.entryAsks).toEqual([
      {
        jobId: "req-signout-sam-1",
        traceId: captured.page.trace.traceId,
        entries: [{ kind: "session.ended", sessionId: "session-sam-s01" }],
      },
    ]);
    expect(k05Problems(world.double.entryAsks[0], "signInEntries.request")).toEqual([]);
    expect([...world.double.log.keys()]).toEqual(["log-session-sam-s01-ended"]);
    expect(captured.spans).toEqual([
      expect.objectContaining({ hop: "pageRequest", outcome: "ok", decided: { signInEntries: "logged" } }),
    ]);
  });

  it("after sign-in-done.json: the session it started ends by the token it gave, and its token is never sent to K-05", async () => {
    const world = await checkWorld({ now: SIGN_IN_DONE.given.now });
    const fixture = SIGN_IN_DONE.request as { attemptId: string; deviceToken: string };
    const attempt = world.double.seed({
      attemptId: fixture.attemptId,
      deviceSha256: nodeSha256(fixture.deviceToken),
      contactHash: nodeContactHash("link", "s01-placeholder-sam"),
      personId: SAM_PERSON,
      startedAt: at(SIGN_IN_DONE.given.now) - MINUTE,
    });
    world.double.seedCode(attempt, "code-sam-s01", CODE);
    world.double.provenByText.add(attempt.id);
    const signedIn = await signInCheckHandler(
      capturedPage(SIGN_IN_DONE.request, { call: "signInCheck" }).page,
      world.deps,
    );
    const token = signedIn.sessionToken as string;
    world.double.now = at(SIGN_OUT.given.now);

    const outcome = await signOutOf(world, signOutRequest({ sessionToken: token }));
    expect(outcome).toEqual(SIGN_OUT.outcome);
    const [session] = world.double.sessions.values();
    expect(session).toMatchObject({ personId: SAM_PERSON, endedWhy: "signed_out" });
    expect(world.double.ends).toEqual([{ tokenSha256: nodeSha256(token) }]);
    expect(JSON.stringify([...world.double.ends, ...world.double.proves])).not.toContain(token);
  });
});

describe("an ended, expired or unknown session answers repeated, ends nothing and logs nothing", () => {
  it("a second sign-out, an unknown token and an expired session each answer signedOut repeated", async () => {
    const world = await checkWorld({ now: SIGN_OUT.given.now });
    world.double.seedSession({
      id: "session-sam-s01",
      personId: SAM_PERSON,
      tokenSha256: nodeSha256(FIXTURE_TOKEN),
      deviceSha256: nodeSha256(SAM_PHONE),
    });
    const expiredToken = "placeholder-session-token-sam-0002";
    world.double.seedSession({
      id: "session-sam-old",
      personId: SAM_PERSON,
      tokenSha256: nodeSha256(expiredToken),
      deviceSha256: nodeSha256(SAM_PHONE),
      startedAt: at(SIGN_OUT.given.now) - 31 * DAY,
      expiresAt: at(SIGN_OUT.given.now) - DAY,
    });
    expect(await signOutOf(world, signOutRequest())).toEqual({ result: "signedOut", repeated: false });
    await runEntries(world);

    const repeats = [
      await signOutOf(world, signOutRequest({ requestId: "req-signout-sam-2" })),
      await signOutOf(world, signOutRequest({ sessionToken: "placeholder-session-token-unknown" })),
      await signOutOf(world, signOutRequest({ sessionToken: expiredToken })),
    ];
    for (const outcome of repeats) {
      expect(outcome).toEqual({ result: "signedOut", repeated: true });
      expect(k21Problems(outcome, "signOut.response")).toEqual([]);
    }
    expect(world.entries).toEqual([]);
    expect(world.double.sessions.get("session-sam-old")?.endedAt).toBeNull();
    expect([...world.double.log.keys()]).toEqual(["log-session-sam-s01-ended"]);
  });
});

describe("what gives no outcome (503) changes nothing, and K-05's transient answers K-21's", () => {
  it.each<[string, Record<string, unknown>]>([
    [
      "a session token null (signOut's page is a signedInPage)",
      { page: { ...(SIGN_OUT.request.page as Record<string, unknown>), sessionToken: null } },
    ],
    ["a field K-21 does not name", { ...signOutRequest(), personId: SAM_PERSON }],
    ["a session token too short", signOutRequest({ sessionToken: "short" })],
  ])("%s: badRequest, and no port is reached", async (_name, request) => {
    const touched: string[] = [];
    const deps: SignOutDeps = {
      check: tripwire("check", touched),
      afterCheck: tripwire("afterCheck", touched),
      later: tripwire("later", touched),
    };
    await expect(signOut(capturedPage(request, { call: "signOut" }).page, deps)).rejects.toMatchObject({
      code: "badRequest",
    });
    expect(touched).toEqual([]);
  });

  it("another call's request is a wiring fault; K-05's transient is K-21's; a thrown error gives no outcome", async () => {
    const world = await checkWorld({ now: SIGN_OUT.given.now });
    await expect(
      signOut(capturedPage(signOutRequest(), { call: "signInCheck" }).page, world.deps),
    ).rejects.toEqual(new SignInError("wrongCall"));

    world.double.endSession = () => Promise.resolve({ error: "transient", sqlstate: "40P01" });
    const transient = await signOut(capturedPage(signOutRequest(), { call: "signOut" }).page, world.deps);
    expect(transient).toEqual({ outcome: { error: "transient", sqlstate: "40P01" }, afterAnswer: null });
    expect(k21Problems(transient.outcome, "signOut.errors")).toEqual([]);

    world.double.endSession = () => Promise.reject(new TypeError("endSession: tokenSha256 is a sha256"));
    await expect(
      signOut(capturedPage(signOutRequest(), { call: "signOut" }).page, world.deps),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("a failed session.ended entry, or a `later` that throws, leaves the answer as it was", async () => {
    const world = await checkWorld({ now: SIGN_OUT.given.now });
    world.double.seedSession({
      id: "session-sam-s01",
      personId: SAM_PERSON,
      tokenSha256: nodeSha256(FIXTURE_TOKEN),
      deviceSha256: nodeSha256(SAM_PHONE),
    });
    world.double.scriptedEntries.push({ error: "notFound", table: "sessions", rowId: "session-sam-s01" });
    expect(await signOutOf(world, signOutRequest())).toEqual(SIGN_OUT.outcome);
    expect(await runEntries(world)).toEqual([{ result: "failed", error: "notFound" }]);

    world.double.seedSession({
      id: "session-sam-s02",
      personId: SAM_PERSON,
      tokenSha256: nodeSha256("placeholder-session-token-sam-0003"),
      deviceSha256: nodeSha256(SAM_PHONE),
    });
    const captured = capturedPage(signOutRequest({ sessionToken: "placeholder-session-token-sam-0003" }), {
      call: "signOut",
    });
    const outcome = await signOutHandler(captured.page, {
      ...world.deps,
      later: () => {
        throw new Error("no waitUntil");
      },
    });
    expect(outcome).toEqual(SIGN_OUT.outcome);
    expect(captured.spans).toEqual([
      expect.objectContaining({
        outcome: "failed",
        decided: { signInEntries: "failed" },
        error_code: "notScheduled",
      }),
    ]);
  });
});
