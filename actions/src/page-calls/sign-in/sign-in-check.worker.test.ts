// T-1285 inside the Workers runtime (workerd), where T-1289 joins signInCheck and signOut to the Worker's page entry:
// with Web Crypto's own fill and T-322's hashing port over a fixed test key (bytes 0 to 31, no environment's key), the
// check of sign-in-done.json's request answers its outcome with a session token of 43 URL-safe characters, of which
// only the sha256 reached K-05, and hands its entries on; sign-out.json's request reaches K-05 as its token's sha256
// alone. The K-21 checks, the hashes and the session make no code from strings (workerd refuses Function and eval when it
// serves a request; this pool's workerd does not, so the test traps both, as T-1282's worker test does, and the trap
// counts no call). Values come only from the contracts' fixtures (rule 9).

import { afterEach, describe, expect, it, vi } from "vitest";

import signInDone from "../../../../contracts/page-api/fixtures/sign-in-done.json";
import signOutFixture from "../../../../contracts/page-api/fixtures/sign-out.json";
import type { PageRequest } from "../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../runtime/src/gateway/answer";
import { openTrace } from "../../../../runtime/src/trace";
import { hmacSha256Hash, sha256Hex } from "../../domain/proof-codes";
import { createSignInCheckHandlers } from "./check";
import type {
  EndSessionRequest,
  EntriesAfterAnswer,
  ProveSignInRequest,
  SignInAfterCheckStore,
  SignInCheckStore,
  SignInEntriesRequest,
} from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Traps Function and eval until the test ends: each call is counted, then made. */
function trapCodeFromStrings(): { readonly calls: string[] } {
  const calls: string[] = [];
  const realFunction = globalThis.Function;
  const realEval = globalThis.eval;
  vi.stubGlobal(
    "Function",
    new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push("new Function");
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, self, args) {
        calls.push("Function()");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  vi.stubGlobal(
    "eval",
    new Proxy(realEval, {
      apply(target, self, args) {
        calls.push("eval");
        return Reflect.apply(target, self, args) as unknown;
      },
    }),
  );
  return { calls };
}

function pageOf(call: PageRequest["call"], request: Readonly<Record<string, unknown>>): PageRequest {
  return {
    call,
    request,
    trace: openTrace({ openedBy: "pageRequest", bundleId: DEFAULT_BUNDLE_ID, incomingTraceId: null }),
    environment: "staging",
  };
}

describe("signInCheck and signOut inside workerd", () => {
  it("sign-in-done.json answers its outcome with the session's token, and sign-out.json ends it by the token's sha256", async () => {
    const proves: ProveSignInRequest[] = [];
    const ends: EndSessionRequest[] = [];
    const asks: SignInEntriesRequest[] = [];
    // K-05's answers as its own fixtures give them (prove-sign-in-sam-right.json, end-session-sam.json), by this request.
    const check: SignInCheckStore = {
      proveSignIn(request) {
        proves.push(request);
        return Promise.resolve({
          outcome: "signedIn",
          signInAttemptId: "sign-in-sam-s01",
          personId: "person-sam",
          sessionId: request.session.id,
          sessionExpiresAt: signInDone.outcome.sessionExpiresAt,
          proofCodeId: "code-sam-s01",
          repeated: false,
        });
      },
      endSession(request) {
        ends.push(request);
        return Promise.resolve({
          result: "signedOut",
          repeated: false,
          sessionId: "session-sam-s01",
          personId: "person-sam",
        });
      },
    };
    const afterCheck: SignInAfterCheckStore = {
      personStanding(request) {
        return Promise.resolve({
          personId: request.personId,
          roles: [{ role: "owner", businessId: "biz-lees-barbershop" }],
          team: false,
          tester: false,
        });
      },
      signInEntries(request) {
        asks.push(request);
        return Promise.resolve({
          result: "logged",
          entries: request.entries.map((entry) => ({
            id: `log-${entry.kind === "proof_code.checked" ? entry.proofCodeId : entry.sessionId}-entry`,
            kind: entry.kind,
            written: true,
          })),
        });
      },
    };
    const later: EntriesAfterAnswer[] = [];
    const handlers = createSignInCheckHandlers({
      check,
      afterCheck,
      hash: await hmacSha256Hash(
        "PROOF_CODE_HASH_KEY",
        Uint8Array.from({ length: 32 }, (_, index) => index),
      ),
      later: (work) => {
        later.push(work);
      },
    });

    const trap = trapCodeFromStrings();
    const outcome = await handlers.signInCheck(pageOf("signInCheck", signInDone.request));
    expect(asks).toEqual([]);
    const reports = await Promise.all(later.splice(0).map((work) => work()));
    const signedOut = await handlers.signOut(pageOf("signOut", signOutFixture.request));
    expect(trap.calls).toEqual([]);

    const token = outcome.sessionToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(outcome).toEqual({ ...signInDone.outcome, sessionToken: token });
    const [prove] = proves;
    expect(prove?.session.tokenSha256).toBe(await sha256Hex(token));
    expect(prove?.session.id).toMatch(/^session-[A-Za-z0-9_-]{22}$/u);
    expect(prove?.typedHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(prove?.deviceSha256).toBe(await sha256Hex(signInDone.request.deviceToken));
    expect(JSON.stringify(proves)).not.toContain(token);
    expect(reports).toEqual([{ result: "logged", written: 2, found: 0 }]);
    expect(asks[0]?.jobId).toBe("sign-in-sam-s01");

    expect(signedOut).toEqual(signOutFixture.outcome);
    expect(ends).toEqual([{ tokenSha256: await sha256Hex(signOutFixture.request.page.sessionToken) }]);
  });
});
