// T-1282 inside the Workers runtime (workerd), where T-1289 joins signInStart to the Worker's page entry: with Web
// Crypto's own fill and T-322's hashing port over a fixed test key (bytes 0 to 31, no environment's key),
// sign-in-request.json answers started with an attempt id of 22 random URL-safe characters, the code's send is handed
// on and not made, and once run it sends one code row through K-05's sendSignInCode with the code's keyed hash. The K-21
// checks, the hashes, the ids and the code's words make no code from strings (workerd refuses Function and eval when it
// serves a request; this pool's workerd does not, so the test traps both, as validator.worker.test.ts does, and the trap
// counts no call). Values come only from the contracts' fixtures (rule 9).

import { afterEach, describe, expect, it, vi } from "vitest";

import signInRequest from "../../../../contracts/page-api/fixtures/sign-in-request.json";
import type { PageRequest } from "../../../../runtime/src/gateway";
import { DEFAULT_BUNDLE_ID } from "../../../../runtime/src/gateway/answer";
import { openTrace } from "../../../../runtime/src/trace";
import { hmacSha256Hash } from "../../domain/proof-codes";
import { createSignInHandlers } from "./start";
import type { AfterAnswer, SendSignInCodeRequest, SignInSendStore, StartSignInRequest } from "./types";

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

describe("signInStart inside workerd", () => {
  it("answers sign-in-request.json, hands the send on, and sends one code once it runs", async () => {
    const starts: StartSignInRequest[] = [];
    const sends: SendSignInCodeRequest[] = [];
    // K-05's answers as its own fixtures give them (start-sign-in-sam.json, send-sign-in-code-sam.json), by this request.
    const store: SignInSendStore = {
      startSignIn(request) {
        starts.push(request);
        return Promise.resolve({
          result: "started",
          id: request.id,
          attemptId: request.attemptId,
          expiresAt: signInRequest.outcome.expiresAt,
          repeated: false,
          personId: "person-sam",
        });
      },
      sendSignInCode(request) {
        sends.push(request);
        return Promise.resolve({
          result: "sent",
          proofCodeId: request.code.id,
          outboxRowId: request.emailRowId,
          commitSeq: 1,
          version: 2,
          expiresAt: "2026-10-26T13:10:01Z",
          entryIds: [
            `log-${request.emailRowId}-created`,
            `log-${request.emailRowId}-planned`,
            `log-${request.code.id}-sent`,
          ],
          repeated: false,
        });
      },
    };
    const later: AfterAnswer[] = [];
    const handlers = createSignInHandlers({
      store,
      hash: await hmacSha256Hash(
        "PROOF_CODE_HASH_KEY",
        Uint8Array.from({ length: 32 }, (_, index) => index),
      ),
      later: (work) => {
        later.push(work);
      },
    });
    const page: PageRequest = {
      call: "signInStart",
      request: signInRequest.request,
      trace: openTrace({ openedBy: "pageRequest", bundleId: DEFAULT_BUNDLE_ID, incomingTraceId: null }),
      environment: "staging",
    };

    const trap = trapCodeFromStrings();
    const outcome = await handlers.signInStart(page);
    expect(sends).toEqual([]);
    const reports = await Promise.all(later.map((work) => work()));
    expect(trap.calls).toEqual([]);

    const [start] = starts;
    expect(outcome).toEqual({ ...signInRequest.outcome, attemptId: start?.attemptId });
    expect(start?.attemptId).toMatch(/^attempt-[A-Za-z0-9_-]{22}$/u);
    expect(start?.id).toMatch(/^sign-in-[A-Za-z0-9_-]{22}$/u);
    expect(start?.contact).toEqual({ kind: "email", address: "sam@lees-barbershop.example" });
    expect(start?.contactHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.signInAttemptId).toBe(start?.id);
    expect(sends[0]?.code.codeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(sends[0]?.finalParts.sends[0]?.text).toMatch(
      /^Code [0-9]{6}: type it on the sign-in page\. It works for 10 minutes\.$/u,
    );
    expect(reports).toEqual([
      { result: "sent", outboxRowId: sends[0]?.emailRowId, proofCodeId: sends[0]?.code.id },
    ]);
  });
});
