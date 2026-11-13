// T-563's port, under Node (Vitest project "unit"): the root's real Linq send port (./real.ts realLinqSend), K-11 v1
// sendPart for each part the dispatcher sends, over the Linq line the root is handed (RootOptions.linqSendCall). Each
// request goes to the line field for field and its answer comes back as K-11's (send-text.json; the error fixtures
// error-4006.json, error-403-2024.json and error-rate-limit.json); an answer K-11 does not name is no answer, so the
// dispatcher keeps the part under its own key; with no line bound, every send fails closed before anything leaves. Over
// @rosie/adapters' Linq double (T-411; ./test-support.ts FakeLinqLine), a part sent again under its key is the one message
// the double recorded. Test values only (rule 9): K-11's fixtures and the fictional 555-01xx numbers.
import error403 from "@rosie/contracts/port-linq/fixtures/error-403-2024.json";
import error4006 from "@rosie/contracts/port-linq/fixtures/error-4006.json";
import errorRateLimit from "@rosie/contracts/port-linq/fixtures/error-rate-limit.json";
import sendText from "@rosie/contracts/port-linq/fixtures/send-text.json";
import { describe, expect, it } from "vitest";

import type { LinqAccepted, LinqFailed, LinqSendRequest } from "../dispatch/types";
import { NoLinqLineError, realLinqSend, type LinqSendCall } from "./index";
import { FakeLinqLine, testClock } from "./test-support";

/** A K-11 fixture's request, as the dispatcher builds one. */
const requestOf = (fixture: { readonly request: unknown }): LinqSendRequest =>
  structuredClone(fixture.request) as LinqSendRequest;

/** A K-11 fixture's answer, as the line gives one. */
const answerOf = (fixture: { readonly outcome: unknown }): LinqAccepted | LinqFailed =>
  structuredClone(fixture.outcome) as LinqAccepted | LinqFailed;

/** A line that answers each request with `answer`, keeping every request it was handed. */
function line(answer: unknown): { call: LinqSendCall; requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    call: (request) => {
      requests.push(request);
      return Promise.resolve(structuredClone(answer) as LinqAccepted | LinqFailed);
    },
  };
}

describe("the root's real Linq send port (T-563): K-11 v1 sendPart over the Linq line", () => {
  it("hands the line send-text.json's request field for field, a copy, and gives back its acceptance as K-11's", async () => {
    const request = requestOf(sendText);
    const bound = line(sendText.outcome);

    await expect(realLinqSend({ call: bound.call }).parts.sendPart(request)).resolves.toEqual(
      answerOf(sendText),
    );
    expect(bound.requests).toEqual([request]);
    expect(bound.requests[0]).not.toBe(request);
  });

  it.each([
    ["4006, which may still deliver", error4006],
    ["403 with code 2024, the stop Linq keeps", error403],
    ["a rate limit with its Retry-After", errorRateLimit],
  ])("gives back the line's failure as K-11 names it: %s", async (_name, fixture) => {
    const bound = line(fixture.outcome);

    await expect(realLinqSend({ call: bound.call }).parts.sendPart(requestOf(fixture))).resolves.toEqual(
      answerOf(fixture),
    );
  });

  it.each([
    ["no answer at all", undefined],
    ["an answer K-11 has no result for", { result: "queued" }],
    ["an acceptance with no time", { ...sendText.outcome, acceptedAt: undefined }],
    ["a failure of a kind K-11 does not name", { ...error4006.outcome, kind: "lost" }],
  ])(
    "reads %s as no answer (K-11 transient with no status), so the part waits under its own key",
    async (_name, answer) => {
      const bound = line(answer);

      await expect(realLinqSend({ call: bound.call }).parts.sendPart(requestOf(sendText))).resolves.toEqual({
        result: "failed",
        kind: "transient",
        httpStatus: null,
        code: "noAnswer",
        reason: "the Linq line gave no answer K-11 names",
        retryAfterSeconds: null,
        providerMessageId: null,
      });
    },
  );

  it("fails every send closed with no Linq line bound: nothing leaves", async () => {
    await expect(realLinqSend({ call: null }).parts.sendPart(requestOf(sendText))).rejects.toThrow(
      new NoLinqLineError(),
    );
  });

  it("over @rosie/adapters' Linq double: the same key sent again is the double's first message, recorded once", async () => {
    const clock = testClock();
    const linq = new FakeLinqLine(() => clock.utc());
    const port = realLinqSend({ call: linq.call }).parts;
    const request = requestOf(sendText);

    const first = await port.sendPart(request);
    const again = await port.sendPart(request);

    expect(first).toMatchObject({ result: "accepted", chatId: request.chatId, service: "imessage" });
    expect(again).toEqual(first);
    expect(linq.double.sentRequests()).toEqual([request]);
    expect(linq.requests.map((sent) => sent.idempotencyKey)).toEqual([
      request.idempotencyKey,
      request.idempotencyKey,
    ]);
  });

  it("over the Linq double, a lost answer is no answer to the port while the double keeps the part it took", async () => {
    const clock = testClock();
    const linq = new FakeLinqLine(() => clock.utc());
    const port = realLinqSend({ call: linq.call }).parts;
    const request = requestOf(sendText);
    linq.loseNextAnswers(1);

    await expect(port.sendPart(request)).resolves.toMatchObject({
      result: "failed",
      kind: "transient",
      httpStatus: null,
    });
    const retried = await port.sendPart(request);

    expect(retried).toMatchObject({ result: "accepted" });
    expect(linq.accepted.get(request.idempotencyKey)).toEqual(retried);
    expect(linq.double.sentRequests()).toEqual([request]);
  });
});
