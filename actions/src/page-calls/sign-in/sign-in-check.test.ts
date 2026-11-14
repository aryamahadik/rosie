// T-1285 (ADR-016 card B2): signInCheck's server side, against K-21 v1's fixtures and a double of K-05 v1.13's check
// side over the same attempts as T-1282's start, each answer and request held to the contracts' own schemas. The card's
// proofs, in its order (sign-out.json is sign-out.test.ts's; the spans and logs are sign-in-check-spans.test.ts's):
//   - sign-in-done.json, sign-in-wrong-five.json and sign-in-already-signed-in.json give their outcomes;
//   - a twin of sign-in-wrong-five.json for a contact with no account gives the same five answers (wrong with 4, 3, 2 and
//     1 tries left, then paused until 15:22:10Z), and the next start answers paused for both contacts;
//   - the sixth check answers paused with no cookie;
//   - a check from another device answers attemptNotFound;
//   - a code checked at 10 minutes 1 second answers expired;
//   - the token is in the first signedIn only;
//   - tester false outside staging;
//   - a failed standing read answers signedIn with empty roles and false flags;
// and the lead notes' own: DL-546 (the server's time, a wrong try counted at once, the attempt's standing), DL-610 (the
// second proof's ways; no entries without a code) and DL-686 (the code's id never leaves the server).

import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePageCall, unconfiguredPages } from "../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../runtime/src/gateway/answer";
import { hmacSha256Hash } from "../../domain/proof-codes";
import { TEST_KEY_BYTES, TEST_KEY_NAME, nodeCodeHash } from "../../domain/proof-codes/test-support";
import { SECOND_PROOF_WAYS, createSignInCheckHandlers, signInCheck, signInCheckHandler } from "./check";
import {
  CODE,
  CODE_DRAW,
  OTHER_DEVICE,
  SIGN_IN_ALREADY,
  SIGN_IN_DONE,
  SIGN_IN_WRONG_FIVE,
  WRONG_CODE,
  checkRequest,
  checkWorld,
  type CheckWorld,
} from "./check-test-support";
import { SignInError } from "./errors";
import { base64Url } from "./hashes";
import { createSignInHandlers, signInStartHandler } from "./start";
import {
  NOBODY_TYPED,
  SAM_PERSON,
  SAM_TYPED,
  capturedPage,
  k05Problems,
  k21Fixture,
  k21Problems,
  nodeContactHash,
  nodeSha256,
  spanSchemaProblems,
  startRequest,
  tripwire,
} from "./test-support";
import type { EntriesReport, SignInCheckDeps } from "./types";

const at = (time: string): number => Date.parse(time);
const MINUTE = 60_000;

/** Sam's laptop and the device of the browser that typed the address no account holds: placeholders. */
const SAM_DEVICE = "placeholder-device-token-sam-laptop";
const NOBODY_DEVICE = "placeholder-device-token-unknown-2";
const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_ID_FORM = /^session-[A-Za-z0-9_-]{22}$/u;

/** One check through this card's handler, as the page entry hands it on: its K-21 outcome. */
async function check(
  world: CheckWorld,
  request: Record<string, unknown>,
  environment = "staging",
): Promise<Record<string, unknown>> {
  return signInCheckHandler(capturedPage(request, { call: "signInCheck", environment }).page, world.deps);
}

/** Runs every entries work the handlers handed to `later`, in order, and gives their reports. */
async function runEntries(world: CheckWorld): Promise<EntriesReport[]> {
  const reports: EntriesReport[] = [];
  for (const work of world.entries.splice(0)) reports.push(await work());
  return reports;
}

/** A sign-in started through T-1282's handler at the double's now, its code sent: the attempt id the page holds. */
async function started(
  world: CheckWorld,
  typed: string,
  requestId: string,
  deviceToken: string,
): Promise<string> {
  const outcome = await signInStartHandler(
    capturedPage(startRequest({ typed, requestId, deviceToken })).page,
    world.startDeps,
  );
  for (const work of world.sends.splice(0)) await work();
  const { attemptId } = outcome as { attemptId?: unknown };
  if (typeof attemptId !== "string") throw new Error("the start gave no attempt id");
  return attemptId;
}

/** The five answers sign-in-wrong-five.json's attempt gives: 4, 3, 2 and 1 tries left, then the pause. */
const FIVE = [
  { result: "wrong", triesLeft: 4 },
  { result: "wrong", triesLeft: 3 },
  { result: "wrong", triesLeft: 2 },
  { result: "wrong", triesLeft: 1 },
  { result: "paused", until: "2026-10-28T15:22:10Z" },
];
/** When each of the five checks comes: the fifth at sign-in-wrong-five.json's own now. */
const FIVE_TIMES = ["15:05:30", "15:06:00", "15:06:30", "15:07:00", "15:07:10"].map((time) =>
  at(`2026-10-28T${time}Z`),
);

describe("sign-in-done.json, sign-in-wrong-five.json and sign-in-already-signed-in.json give their outcomes", () => {
  it("sign-in-wrong-five.json: after four wrong codes, the fixture's fifth answers paused until 15:22:10Z", async () => {
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const fixture = SIGN_IN_WRONG_FIVE.request as { attemptId: string; deviceToken: string };
    const attempt = world.double.seed({
      attemptId: fixture.attemptId,
      deviceSha256: nodeSha256(fixture.deviceToken),
      contactHash: nodeContactHash("email", SAM_TYPED),
      personId: SAM_PERSON,
      startedAt: at("2026-10-28T15:05:00Z"),
    });
    world.double.seedCode(attempt, "code-sam-sign-in-oct28-email", CODE);

    const answers: unknown[] = [];
    for (const [index, time] of FIVE_TIMES.slice(0, 4).entries()) {
      world.double.now = time;
      answers.push(
        await check(world, checkRequest({ requestId: `req-portal-signin-3-try${String(index + 1)}` })),
      );
    }
    world.double.now = at(SIGN_IN_WRONG_FIVE.given.now);
    const outcome = await check(world, SIGN_IN_WRONG_FIVE.request);

    expect(answers).toEqual(FIVE.slice(0, 4));
    expect(outcome).toEqual(SIGN_IN_WRONG_FIVE.outcome);
    expect(k21Problems(outcome, "signInCheck.response")).toEqual([]);
    expect(k21Problems({ ...SIGN_IN_WRONG_FIVE, outcome }, "signInCheck.exchange")).toEqual([]);
    for (const [index, request] of world.double.proves.entries()) {
      expect(k05Problems(request, "proveSignIn.request")).toEqual([]);
      expect(k05Problems(world.double.checkAnswers[index], "proveSignIn.response")).toEqual([]);
    }
  });

  it("sign-in-done.json: K-05 answers its check signedIn, and the page gets the fixture's answer with the session's token", async () => {
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
    // The fixture's story: Sam's ready text came from his own mobile and its turn proved the code (K-21's text way).
    world.double.provenByText.add(attempt.id);
    world.double.standings.set(SAM_PERSON, {
      roles: [{ role: "owner", businessId: "biz-lees-barbershop" }],
      team: false,
    });

    const outcome = await check(world, SIGN_IN_DONE.request);
    expect(typeof outcome.sessionToken).toBe("string");
    const token = outcome.sessionToken as string;
    expect(outcome).toEqual({ ...SIGN_IN_DONE.outcome, sessionToken: token });
    expect(k21Problems(outcome, "signInCheck.response")).toEqual([]);
    expect(k21Problems({ ...SIGN_IN_DONE, outcome }, "signInCheck.exchange")).toEqual([]);

    // The token is 32 random bytes in base64url, and only its sha256 reached K-05, which the session keeps.
    expect(token).toMatch(TOKEN_FORM);
    const [prove] = world.double.proves;
    expect(prove?.session.tokenSha256).toBe(nodeSha256(token));
    expect(world.double.sessions.get(prove?.session.id ?? "")?.tokenSha256).toBe(prove?.session.tokenSha256);
    expect(world.double.standingAsks).toEqual([{ personId: SAM_PERSON }]);
  });

  it("sign-in-already-signed-in.json: a later check of that attempt, and a repeat of sign-in-done.json, answer alreadySignedIn", async () => {
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
    expect(await check(world, SIGN_IN_DONE.request)).toMatchObject({ result: "signedIn" });

    // The lost answer's repeat (its own requestId, the attempt's last check), then a later poll under a new requestId.
    world.double.now = at(SIGN_IN_ALREADY.given.now);
    const again = await check(world, SIGN_IN_DONE.request);
    const later = await check(world, SIGN_IN_ALREADY.request);

    expect(again).toEqual(SIGN_IN_ALREADY.outcome);
    expect(later).toEqual(SIGN_IN_ALREADY.outcome);
    expect(k21Problems({ ...SIGN_IN_ALREADY, outcome: later }, "signInCheck.exchange")).toEqual([]);
    expect(world.double.checkAnswers.slice(-2)).toEqual([
      expect.objectContaining({ outcome: "alreadySignedIn", repeated: true }),
      expect.objectContaining({ outcome: "alreadySignedIn", repeated: false }),
    ]);
    expect(world.double.sessions.size).toBe(1);
    expect(world.entries).toHaveLength(1);
  });
});

describe("a twin of sign-in-wrong-five.json for a contact with no account gives the same five answers, and the next start answers paused for both", () => {
  it("the fixture's own request, on Sam's attempt and on its twin with no account and no code, gives the same five answers", async () => {
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const fixture = SIGN_IN_WRONG_FIVE.request as { attemptId: string; deviceToken: string };
    const sam = world.double.seed({
      attemptId: fixture.attemptId,
      deviceSha256: nodeSha256(fixture.deviceToken),
      contactHash: nodeContactHash("email", SAM_TYPED),
      personId: SAM_PERSON,
      startedAt: at("2026-10-28T15:05:00Z"),
    });
    world.double.seedCode(sam, "code-sam-sign-in-oct28-email", CODE);
    world.double.seed({
      attemptId: "attempt-no-account-signin-1",
      deviceSha256: nodeSha256(NOBODY_DEVICE),
      contactHash: nodeContactHash("email", NOBODY_TYPED),
      startedAt: at("2026-10-28T15:05:00Z"),
    });

    const answers = { sam: [] as unknown[], twin: [] as unknown[] };
    for (const [index, time] of FIVE_TIMES.entries()) {
      world.double.now = time;
      const requestId = `req-portal-signin-try${String(index + 1)}`;
      answers.sam.push(await check(world, checkRequest({ requestId })));
      answers.twin.push(
        await check(
          world,
          checkRequest({ requestId, attemptId: "attempt-no-account-signin-1", deviceToken: NOBODY_DEVICE }),
        ),
      );
    }
    expect(answers.sam).toEqual(FIVE);
    expect(answers.twin).toEqual(FIVE);
    expect(answers.twin[4]).toEqual(SIGN_IN_WRONG_FIVE.outcome);
    // K-05's answers differ only in the code's id, which the page never gets (DL-686).
    const k05 = world.double.checkAnswers as { proofCodeId?: unknown }[];
    expect(k05.filter((_, index) => index % 2 === 0).map((answer) => answer.proofCodeId)).toEqual(
      Array.from({ length: 5 }, () => "code-sam-sign-in-oct28-email"),
    );
    expect(k05.filter((_, index) => index % 2 === 1).map((answer) => answer.proofCodeId)).toEqual(
      Array.from({ length: 5 }, () => null),
    );
  });

  it("through T-1282's start and send: five wrong codes each give the same answers, and the next start of either contact answers paused", async () => {
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const sam = await started(world, SAM_TYPED, "req-portal-signin-3", SAM_DEVICE);
    const nobody = await started(world, NOBODY_TYPED, "req-portal-signin-4", NOBODY_DEVICE);
    expect(world.double.sends).toHaveLength(1);
    expect(world.double.attemptOf(sam).proofCodeId).not.toBeNull();
    expect(world.double.attemptOf(nobody).proofCodeId).toBeNull();

    const answers = { sam: [] as unknown[], nobody: [] as unknown[] };
    for (const [index, time] of FIVE_TIMES.entries()) {
      world.double.now = time;
      const try_ = String(index + 1);
      answers.sam.push(
        await check(
          world,
          checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, requestId: `sam-${try_}` }),
        ),
      );
      answers.nobody.push(
        await check(
          world,
          checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: `nobody-${try_}` }),
        ),
      );
    }
    expect(answers.sam).toEqual(FIVE);
    expect(answers.nobody).toEqual(FIVE);

    world.double.now = at("2026-10-28T15:08:30Z");
    for (const typed of [SAM_TYPED, NOBODY_TYPED]) {
      const captured = capturedPage(startRequest({ typed, requestId: `req-portal-next-${typed}` }));
      const outcome = await signInStartHandler(captured.page, world.startDeps);
      expect(outcome).toEqual({ error: "paused", until: "2026-10-28T15:22:10Z" });
      expect(k21Problems(outcome, "signInStart.errors")).toEqual([]);
    }
    expect(world.double.answers.slice(-2)).toEqual([
      expect.objectContaining({ result: "paused", by: "contactPause" }),
      expect.objectContaining({ result: "paused", by: "contactPause" }),
    ]);
    expect(world.sends).toEqual([]);
    expect(world.double.sends).toHaveLength(1);
  });
});

describe("the sixth check answers paused with no cookie", () => {
  it("a fresh check after five wrong codes (a new requestId, no session, even the right code) answers paused and counts nothing", async () => {
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const sam = await started(world, SAM_TYPED, "req-portal-signin-3", SAM_DEVICE);
    const nobody = await started(world, NOBODY_TYPED, "req-portal-signin-4", NOBODY_DEVICE);
    for (const [index, time] of FIVE_TIMES.entries()) {
      world.double.now = time;
      await check(
        world,
        checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, requestId: `s${String(index)}` }),
      );
      await check(
        world,
        checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: `n${String(index)}` }),
      );
    }

    // The page's own 15-minute hold is a cookie the server never sees (STATE note 74): this check carries nothing of it.
    world.double.now = at("2026-10-28T15:08:00Z");
    const sixth = [
      await check(
        world,
        checkRequest({
          attemptId: sam,
          deviceToken: SAM_DEVICE,
          requestId: "sam-6",
          code: CODE,
          sessionToken: null,
        }),
      ),
      await check(
        world,
        checkRequest({
          attemptId: nobody,
          deviceToken: NOBODY_DEVICE,
          requestId: "nobody-6",
          code: CODE,
          sessionToken: null,
        }),
      ),
    ];
    expect(sixth).toEqual([
      { result: "paused", until: "2026-10-28T15:22:10Z" },
      { result: "paused", until: "2026-10-28T15:22:10Z" },
    ]);
    for (const attemptId of [sam, nobody])
      expect(world.double.stateOf(world.double.attemptOf(attemptId)).wrongTries).toBe(5);
    const samCode = world.double.codes.get(world.double.attemptOf(sam).proofCodeId ?? "");
    expect(samCode?.usedAt).toBeNull();
    expect(world.double.sessions.size).toBe(0);
    expect(sixth.some((answer) => "sessionToken" in answer)).toBe(false);
  });
});

describe("a check from another device answers attemptNotFound", () => {
  it("the right code from another browser answers attemptNotFound, counts nothing and leaves the attempt to its own device", async () => {
    const world = await checkWorld({ now: "2026-10-26T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-signin-1", SAM_DEVICE);
    world.double.now += MINUTE;

    const other = await check(world, checkRequest({ attemptId, deviceToken: OTHER_DEVICE, code: CODE }));
    const unknown = await check(
      world,
      checkRequest({ attemptId: "attempt-sam-signin-unknown", deviceToken: SAM_DEVICE, code: CODE }),
    );
    expect(other).toEqual({ error: "attemptNotFound" });
    expect(unknown).toEqual(other);
    expect(k21Problems(other, "signInCheck.errors")).toEqual([]);
    expect(world.entries).toEqual([]);
    expect(world.double.stateOf(world.double.attemptOf(attemptId))).toMatchObject({
      wrongTries: 0,
      lastOutcome: null,
    });

    const own = await check(
      world,
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE, requestId: "r" }),
    );
    expect(own).toMatchObject({ result: "signedIn", person: { personId: SAM_PERSON } });
  });
});

describe("a code checked at 10 minutes 1 second answers expired", () => {
  it("the right code at 13:10:01 for a start at 13:00:00 answers expired: no session, the code unused, no try counted", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    world.double.now = at("2026-11-02T13:10:01Z");

    const outcome = await check(world, checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE }));
    expect(outcome).toEqual({ result: "expired" });
    expect(k21Problems(outcome, "signInCheck.response")).toEqual([]);
    expect(world.double.checkAnswers.at(-1)).toMatchObject({ outcome: "expired", repeated: false });
    expect(world.double.sessions.size).toBe(0);
    const attempt = world.double.attemptOf(attemptId);
    expect(world.double.codes.get(attempt.proofCodeId ?? "")?.usedAt).toBeNull();
    expect(world.double.stateOf(attempt).wrongTries).toBe(0);
  });

  it("at 10 minutes exactly the attempt and its code are still in time, so the right code signs in", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    world.double.now = at("2026-11-02T13:10:00Z");
    expect(
      await check(world, checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE })),
    ).toMatchObject({
      result: "signedIn",
      sessionExpiresAt: "2026-12-02T13:10:00Z",
    });
  });
});

describe("the token is in the first signedIn only", () => {
  it("a wrong code, the right one, its repeat and a later check: one answer of the four holds a token, and it is the session's", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    const ask = (requestId: string, code: string): Record<string, unknown> =>
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, requestId, code });

    world.double.now = at("2026-11-02T13:00:40Z");
    const wrong = await check(world, ask("req-check-0", WRONG_CODE));
    world.double.now = at("2026-11-02T13:01:30Z");
    const right = await check(world, ask("req-check-1", CODE));
    world.double.now = at("2026-11-02T13:01:32Z");
    const repeat = await check(world, ask("req-check-1", CODE));
    const later = await check(world, ask("req-check-2", CODE));

    expect(wrong).toEqual({ result: "wrong", triesLeft: 4 });
    expect(right).toMatchObject({ result: "signedIn", sessionExpiresAt: "2026-12-02T13:01:30Z" });
    expect(repeat).toEqual({ result: "alreadySignedIn" });
    expect(later).toEqual({ result: "alreadySignedIn" });
    const answers = [wrong, right, repeat, later];
    for (const answer of answers) expect(k21Problems(answer, "signInCheck.response")).toEqual([]);
    expect(answers.filter((answer) => "sessionToken" in answer)).toEqual([right]);
    // K-21's refused twin (a later check answered with the token again) is refused; this run's later answer is accepted.
    const refused = k21Fixture("invalid/refuse-already-signed-in-with-token.json");
    expect(k21Problems(refused, "signInCheck.exchange")).not.toEqual([]);
    expect(k21Problems({ ...refused, outcome: later }, "signInCheck.exchange")).toEqual([]);

    // Each check drew a session of its own; the right one's token is the one that started, and no other left.
    const hashes = world.double.proves.map((prove) => prove.session.tokenSha256);
    expect(new Set(hashes).size).toBe(4);
    const token = right.sessionToken as string;
    expect(token).toMatch(TOKEN_FORM);
    expect(nodeSha256(token)).toBe(hashes[1]);
    expect([...world.double.sessions.values()].map((session) => session.tokenSha256)).toEqual([hashes[1]]);
    expect(JSON.stringify([wrong, repeat, later])).not.toContain(token);
  });
});

describe("tester false outside staging", () => {
  it.each([
    ["staging", true],
    ["production", false],
    ["Staging", false],
    ["", false],
  ])(
    "on %j, a person on the team signs in with tester %s, and team true everywhere",
    async (environment, tester) => {
      const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
      world.double.standings.set(SAM_PERSON, { roles: [], team: true });
      const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
      const outcome = await check(
        world,
        checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE }),
        environment,
      );
      expect(world.double.checkAnswers.at(-1)).toMatchObject({ tester: true, team: true });
      expect(outcome).toMatchObject({
        result: "signedIn",
        person: { personId: SAM_PERSON, team: true, tester },
      });
      expect(k21Problems(outcome, "signInCheck.response")).toEqual([]);
    },
  );
});

describe("a failed standing read answers signedIn with empty roles and false flags", () => {
  it.each<[string, (world: CheckWorld) => void, string]>([
    [
      "K-05 answers transient",
      (world) => world.double.scriptedStandings.push({ error: "transient", sqlstate: "40001" }),
      "transient",
    ],
    [
      "the read throws an error whose message holds the person",
      (world) => world.double.scriptedStandings.push(new Error(`boom ${SAM_PERSON}`)),
      "Error",
    ],
    [
      "the read answers for another person",
      (world) =>
        world.double.scriptedStandings.push({
          personId: "person-riley",
          roles: [{ role: "owner", businessId: "biz-lees-barbershop" }],
          team: true,
          tester: true,
        }),
      "otherPerson",
    ],
  ])(
    "when %s: signedIn with the token, no roles, team and tester false, and a span says so",
    async (_name, script, why) => {
      const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
      world.double.standings.set(SAM_PERSON, {
        roles: [{ role: "owner", businessId: "biz-lees-barbershop" }],
        team: true,
      });
      const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
      script(world);
      const captured = capturedPage(checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE }), {
        call: "signInCheck",
      });
      const outcome = await signInCheckHandler(captured.page, world.deps);

      expect(outcome).toEqual({
        result: "signedIn",
        sessionToken: expect.stringMatching(TOKEN_FORM) as unknown,
        sessionExpiresAt: "2026-12-02T13:00:00Z",
        person: { personId: SAM_PERSON, roles: [], team: false, tester: false },
      });
      expect(k21Problems(outcome, "signInCheck.response")).toEqual([]);
      expect(world.double.sessions.size).toBe(1);
      expect(captured.spans).toEqual([
        expect.objectContaining({
          hop: "pageRequest",
          outcome: "failed",
          decided: { standing: "failed" },
          error_code: why,
        }),
      ]);
      expect(spanSchemaProblems(captured.spans[0])).toEqual([]);
      expect(JSON.stringify(captured.spans)).not.toContain(SAM_PERSON);
    },
  );

  it("a standing that reads lists the person's live roles in K-21's names, as K-05 gives them", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const roles = [
      { role: "owner", businessId: "biz-lees-barbershop" },
      { role: "ownBusiness", businessId: "biz-lee-home-services" },
      { role: "staff", businessId: "biz-yoga-studio" },
    ];
    world.double.standings.set(SAM_PERSON, { roles, team: false });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    const captured = capturedPage(checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE }), {
      call: "signInCheck",
    });
    const outcome = await signInCheckHandler(captured.page, world.deps);
    expect(outcome).toMatchObject({ person: { personId: SAM_PERSON, roles, team: false, tester: false } });
    expect(k05Problems(world.double.checkAnswers.at(-1), "personStanding.response")).toEqual([]);
    expect(captured.spans).toEqual([]);
  });
});

describe("DL-546: the server's time, a wrong try counted at once, and the attempt's standing", () => {
  it("(a) the check sends K-05 no time and nothing of the page but its ids: the device's sha256, the code's keyed hash and a session", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    await check(
      world,
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: WRONG_CODE, requestId: "req-0" }),
    );
    const [prove] = world.double.proves;
    expect(Object.keys(prove ?? {}).sort()).toEqual([
      "attemptId",
      "deviceSha256",
      "requestId",
      "session",
      "typedHash",
    ]);
    expect(prove).toEqual({
      attemptId,
      deviceSha256: nodeSha256(SAM_DEVICE),
      requestId: "req-0",
      typedHash: nodeCodeHash(WRONG_CODE),
      session: {
        id: expect.stringMatching(SESSION_ID_FORM) as unknown,
        tokenSha256: expect.any(String) as unknown,
      },
    });
    expect(k05Problems(prove, "proveSignIn.request")).toEqual([]);
  });

  it("(c) a wrong try counts at once: the entries run only after the answer, and when they fail the try still stands", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    world.double.scriptedEntries.push(
      { error: "transient", sqlstate: "40001" },
      new Error("the entries' connection broke"),
    );
    const ask = (requestId: string): Record<string, unknown> =>
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: WRONG_CODE, requestId });

    const first = await check(world, ask("req-0"));
    expect(first).toEqual({ result: "wrong", triesLeft: 4 });
    expect(world.calls.filter((call) => call === "signInEntries")).toEqual([]);
    expect(await runEntries(world)).toEqual([{ result: "failed", error: "transient" }]);
    const second = await check(world, ask("req-1"));
    expect(second).toEqual({ result: "wrong", triesLeft: 3 });
    expect(await runEntries(world)).toEqual([{ result: "failed", error: "Error" }]);
    expect(world.double.stateOf(world.double.attemptOf(attemptId)).wrongTries).toBe(2);

    // A later check's entries write what the lost calls left unlogged.
    await check(world, ask("req-2"));
    expect(await runEntries(world)).toEqual([{ result: "logged", written: 3, found: 0 }]);
    const codeId = world.double.attemptOf(attemptId).proofCodeId ?? "";
    expect([...world.double.log.keys()]).toEqual([1, 2, 3].map((k) => `log-${codeId}-wrong-${String(k)}`));
  });

  it("(d) every answer to a code that is not right is K-05's, read from the attempt: this call counts nothing itself", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    // K-05 says 2 tries left at the first check: the page says the same, with no count of its own.
    world.double.scriptedChecks.push({
      outcome: "wrong",
      signInAttemptId: world.double.attemptOf(attemptId).id,
      triesLeft: 2,
      proofCodeId: null,
      repeated: false,
    });
    expect(
      await check(
        world,
        checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: WRONG_CODE, requestId: "r" }),
      ),
    ).toEqual({ result: "wrong", triesLeft: 2 });
  });
});

describe("the same steps and the same answers with or without an account (ADR-016 section 4; DL-686)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("before the answer both paths reach the same ports in the same order and draw the same randomness", async () => {
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const sam = await started(world, SAM_TYPED, "req-portal-signin-3", SAM_DEVICE);
    const nobody = await started(world, NOBODY_TYPED, "req-portal-signin-4", NOBODY_DEVICE);
    world.calls.splice(0);
    world.checkFill.asked.splice(0);

    await check(world, checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, requestId: "s-1" }));
    const samPorts = world.calls.splice(0);
    const samDraws = world.checkFill.asked.splice(0);
    await check(world, checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: "n-1" }));
    expect(samPorts).toEqual(["hmacHex", "proveSignIn"]);
    expect(world.calls).toEqual(samPorts);
    expect(samDraws).toEqual([
      { kind: "uint8", length: 32 },
      { kind: "uint8", length: 16 },
    ]);
    expect(world.checkFill.asked).toEqual(samDraws);
  });

  it("through the page entry, the five checks of each give the same bytes, and no answer holds the code's id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const sam = await started(world, SAM_TYPED, "req-portal-signin-3", SAM_DEVICE);
    const nobody = await started(world, NOBODY_TYPED, "req-portal-signin-4", NOBODY_DEVICE);
    const handlers = {
      ...unconfiguredPages(),
      ...createSignInHandlers(world.startDeps),
      ...createSignInCheckHandlers(world.deps),
    };
    const post = async (request: Record<string, unknown>): Promise<string> => {
      const response = await handlePageCall(
        new Request("https://rosfield.example/test/page-api/signInCheck", {
          method: "POST",
          body: JSON.stringify(request),
        }),
        "signInCheck",
        { handlers, bundleId: () => DEFAULT_BUNDLE_ID },
        { environment: "staging", version: "test" },
      );
      expect(response.status).toBe(200);
      return response.text();
    };
    const bodies = { sam: [] as string[], nobody: [] as string[] };
    for (const [index, time] of FIVE_TIMES.entries()) {
      world.double.now = time;
      bodies.sam.push(
        await post(checkRequest({ attemptId: sam, deviceToken: SAM_DEVICE, requestId: `s${String(index)}` })),
      );
      bodies.nobody.push(
        await post(
          checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: `n${String(index)}` }),
        ),
      );
    }
    expect(bodies.sam).toEqual(bodies.nobody);
    expect(bodies.sam.map((body) => JSON.parse(body) as unknown)).toEqual(FIVE);
    const codeId = world.double.attemptOf(sam).proofCodeId ?? "";
    expect(codeId).not.toBe("");
    for (const body of bodies.sam) {
      expect(body).not.toContain(codeId);
      expect(body).not.toContain(world.double.attemptOf(sam).id);
    }
  });
});

describe("DL-610: the second proof's ways, and no entries for an attempt with no code", () => {
  it("note 1: an owner on a new device after an earlier session gets secondProofNeeded with K-21's two ways, no token and no session", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:20:00Z" });
    const attemptId = await started(
      world,
      SAM_TYPED,
      "req-portal-sam-nov02-phone",
      "placeholder-device-token-sam-phone",
    );
    world.double.stateOf(world.double.attemptOf(attemptId)).ownerOrAdmin = true;
    world.double.seedSession({
      id: "session-sam-oct26",
      personId: SAM_PERSON,
      tokenSha256: nodeSha256("placeholder-session-token-sam-oct26"),
      deviceSha256: nodeSha256(SAM_DEVICE),
    });
    world.double.now = at("2026-11-02T13:21:00Z");

    const outcome = await check(
      world,
      checkRequest({ attemptId, deviceToken: "placeholder-device-token-sam-phone", code: CODE }),
    );
    expect(outcome).toEqual({ result: "secondProofNeeded", ways: ["emailCode", "idReCheck"] });
    expect(SECOND_PROOF_WAYS).toEqual(["emailCode", "idReCheck"]);
    expect(k21Problems(outcome, "signInCheck.response")).toEqual([]);
    expect(world.double.sessions.size).toBe(1);
    expect(world.double.standingAsks).toEqual([]);
    // Its entries: the code's use, and no session.
    expect(await runEntries(world)).toEqual([{ result: "logged", written: 1, found: 0 }]);
    expect(world.double.entryAsks.map((ask) => ask.entries.map((entry) => entry.kind))).toEqual([
      ["proof_code.checked"],
    ]);
  });

  it("note 2: wrong and paused checks of an attempt with no code hand nothing on, so signInEntries is never asked", async () => {
    const world = await checkWorld({ now: "2026-10-28T15:05:00Z" });
    const nobody = await started(world, NOBODY_TYPED, "req-portal-signin-4", NOBODY_DEVICE);
    for (const [index, time] of FIVE_TIMES.entries()) {
      world.double.now = time;
      await check(
        world,
        checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: `n${String(index)}` }),
      );
    }
    world.double.now = at("2026-10-28T15:08:00Z");
    await check(world, checkRequest({ attemptId: nobody, deviceToken: NOBODY_DEVICE, requestId: "n-6" }));
    expect(world.entries).toEqual([]);
    expect(world.calls).not.toContain("signInEntries");
  });

  it("with a code, each check's entries go under the attempt's server id and the call's own trace, after the answer", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    const captured = capturedPage(
      checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE, requestId: "req-right" }),
      { call: "signInCheck" },
    );
    const outcome = await signInCheckHandler(captured.page, world.deps);
    expect(outcome).toMatchObject({ result: "signedIn" });
    expect(world.double.entryAsks).toEqual([]);
    expect(await runEntries(world)).toEqual([{ result: "logged", written: 2, found: 0 }]);

    const attempt = world.double.attemptOf(attemptId);
    const [prove] = world.double.proves;
    expect(world.double.entryAsks).toEqual([
      {
        jobId: attempt.id,
        traceId: captured.page.trace.traceId,
        entries: [
          { kind: "proof_code.checked", proofCodeId: attempt.proofCodeId },
          { kind: "session.started", sessionId: prove?.session.id },
        ],
      },
    ]);
    expect(k05Problems(world.double.entryAsks[0], "signInEntries.request")).toEqual([]);
    expect([...world.double.log.keys()]).toEqual([
      `log-${attempt.proofCodeId ?? ""}-used`,
      `log-${prove?.session.id ?? ""}-started`,
    ]);
    expect(captured.spans).toEqual([
      expect.objectContaining({ hop: "pageRequest", outcome: "ok", decided: { signInEntries: "logged" } }),
    ]);
    expect(spanSchemaProblems(captured.spans[0])).toEqual([]);
  });
});

describe("what gives no outcome (503) counts nothing, and every K-05 answer maps to K-21's", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a request that is not K-21's", { ...checkRequest(), forPersonId: SAM_PERSON }],
    ["a code that is not 4 to 8 digits", checkRequest({ code: "48291a" })],
    ["no device token", { ...checkRequest(), deviceToken: null }],
  ])("%s: badRequest, and no port is reached", async (_name, request) => {
    const touched: string[] = [];
    const deps: SignInCheckDeps = {
      check: tripwire("check", touched),
      afterCheck: tripwire("afterCheck", touched),
      hash: tripwire("hash", touched),
      later: tripwire("later", touched),
    };
    await expect(
      signInCheck(capturedPage(request, { call: "signInCheck" }).page, deps),
    ).rejects.toMatchObject({
      code: "badRequest",
    });
    expect(touched).toEqual([]);
  });

  it("another call's request is a wiring fault, and no hashing key bound gives noHashKey: nothing is checked", async () => {
    const touched: string[] = [];
    const deps: SignInCheckDeps = {
      check: tripwire("check", touched),
      afterCheck: tripwire("afterCheck", touched),
      hash: null,
      later: tripwire("later", touched),
    };
    await expect(
      signInCheck(capturedPage(checkRequest(), { call: "signInStart" }).page, deps),
    ).rejects.toEqual(new SignInError("wrongCall"));
    await expect(
      signInCheck(capturedPage(checkRequest(), { call: "signInCheck" }).page, deps),
    ).rejects.toEqual(new SignInError("noHashKey"));
    const unnamed = await hmacSha256Hash(TEST_KEY_NAME, TEST_KEY_BYTES);
    for (const hash of [
      { keyName: "proof code key", hmacHex: unnamed.hmacHex.bind(unnamed) },
      { keyName: TEST_KEY_NAME, hmacHex: () => Promise.resolve("not-a-hash") },
    ])
      await expect(
        signInCheck(capturedPage(checkRequest(), { call: "signInCheck" }).page, { ...deps, hash }),
      ).rejects.toMatchObject({ code: "noHashKey" });
    expect(touched).toEqual([]);
  });

  it("K-05's transient answers K-21's transient; its constraint gives no outcome (idTaken); a thrown error gives none", async () => {
    const world = await checkWorld();
    const page = (): ReturnType<typeof capturedPage>["page"] =>
      capturedPage(checkRequest(), { call: "signInCheck" }).page;
    world.double.scriptedChecks.push({ error: "transient", sqlstate: "40001" });
    const transient = await signInCheck(page(), world.deps);
    expect(transient).toEqual({ outcome: { error: "transient", sqlstate: "40001" }, afterAnswer: null });
    expect(k21Problems(transient.outcome, "signInCheck.errors")).toEqual([]);

    world.double.scriptedChecks.push({ error: "constraint", sqlstate: "23505", constraint: "sessions_pkey" });
    await expect(signInCheck(page(), world.deps)).rejects.toEqual(new SignInError("idTaken"));

    world.double.proveSignIn = () =>
      Promise.reject(new TypeError("proveSignIn: attemptId is a non-empty id"));
    await expect(signInCheck(page(), world.deps)).rejects.toBeInstanceOf(TypeError);
  });

  it("a session the database refuses (its token's hash taken) counts nothing, and the resend draws another and signs in", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    const ask = checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: CODE, requestId: "req-1" });
    // The checks' counter fill starts at byte 128: the first check's token is those 32 bytes, already some session's.
    const takenToken = base64Url(Uint8Array.from({ length: 32 }, (_, index) => 128 + index));
    world.double.seedSession({
      id: "session-riley-oct26",
      personId: "person-riley",
      tokenSha256: nodeSha256(takenToken),
      deviceSha256: nodeSha256(OTHER_DEVICE),
    });
    await expect(check(world, ask)).rejects.toEqual(new SignInError("idTaken"));
    expect(world.double.codes.get(world.double.attemptOf(attemptId).proofCodeId ?? "")?.usedAt).toBeNull();
    expect(await check(world, ask)).toMatchObject({ result: "signedIn" });
  });

  it("default 1: a check with code null is a code that is not right: its hash is the code's prefix over no digits, a wrong try", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z" });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    const outcome = await check(world, checkRequest({ attemptId, deviceToken: SAM_DEVICE, code: null }));
    expect(outcome).toEqual({ result: "wrong", triesLeft: 4 });
    expect(world.double.proves[0]?.typedHash).toBe(nodeCodeHash(""));
    expect(world.double.proves[0]?.typedHash).not.toBe(nodeCodeHash(CODE));
  });
});

describe("the session's token and id: from Web Crypto's generator (card A; DL-610)", () => {
  it("left out, the fill is Web Crypto's: the token is 32 bytes and the id 128 bits, each check's its own", async () => {
    const world = await checkWorld({ now: "2026-11-02T13:00:00Z", draws: [CODE_DRAW] });
    const attemptId = await started(world, SAM_TYPED, "req-portal-sam-nov02", SAM_DEVICE);
    const deps: SignInCheckDeps = {
      check: world.deps.check,
      afterCheck: world.deps.afterCheck,
      hash: world.deps.hash,
      later: world.deps.later,
    };
    const spy = vi.spyOn(crypto, "getRandomValues");
    for (let index = 0; index < 3; index += 1)
      await signInCheckHandler(
        capturedPage(
          checkRequest({
            attemptId,
            deviceToken: SAM_DEVICE,
            code: WRONG_CODE,
            requestId: `r${String(index)}`,
          }),
          { call: "signInCheck" },
        ).page,
        deps,
      );
    expect(spy.mock.calls.map(([array]) => (array as Uint8Array).length)).toEqual([32, 16, 32, 16, 32, 16]);
    spy.mockRestore();
    const sessions = world.double.proves.map((prove) => prove.session);
    for (const session of sessions) expect(session.id).toMatch(SESSION_ID_FORM);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(3);
    expect(new Set(sessions.map((session) => session.tokenSha256)).size).toBe(3);
  });
});
