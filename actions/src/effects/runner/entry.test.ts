// One try's result request (entry.ts, T-323) against K-05 v1.1's own result fixtures: given what each fixture's try was
// (its runner, version, tries before, answer, time, next try and zone), the request is the fixture's, entry included.

import { describe, expect, it } from "vitest";

import type { KindAnswer } from "../kinds";
import { endsInOutage, resultEntry, resultRequest, type TryRecord } from "./entry";
import { calendarWrite, contractChecks, depositCharge, readContractJson } from "./test-support";
import type { EffectResultRequest } from "./types";

const FIXTURES = [
  "effect-result.json",
  "effect-result-network-error.json",
  "effect-try-2.json",
  "effect-try-3.json",
  "effect-try-4.json",
  "effect-fifth-try-outage.json",
];

function answerOf(request: EffectResultRequest): KindAnswer {
  if (request.outcome === "ok") {
    return { outcome: "ok", providerObjectId: request.providerObjectId, ledgerLineId: request.ledgerLineId };
  }
  if (request.outcome === "declined") return { outcome: "declined", errorCode: request.errorCode ?? "" };
  return { outcome: "networkError", errorCode: request.errorCode ?? "", retryAfterMs: null };
}

describe("a try's K-05 v1.1 recordEffectResult request", () => {
  it.each(FIXTURES)("is %s's request, given that try", (file) => {
    const fixture = readContractJson(`data-access/fixtures/${file}`) as { request: EffectResultRequest };
    const { request } = fixture;
    const triesBefore = Number(request.events[0].oldValues?.tries);
    const record: TryRecord = {
      claimer: request.claimer,
      effect: calendarWrite(),
      expectVersion: request.expectVersion,
      triesBefore,
      at: Date.parse(request.at),
      answer: answerOf(request),
      nextTryAt: request.nextTryAt === null ? null : Date.parse(request.nextTryAt),
      zone: request.events[0].zone,
    };

    expect(resultRequest(record)).toEqual(request);
    expect(contractChecks().k05("recordEffectResult.request", resultRequest(record))).toEqual([]);
  });

  it("writes a decline as declined, never to be tried again, with its error code", () => {
    const record: TryRecord = {
      claimer: "effects-runner-1",
      effect: depositCharge(),
      expectVersion: 2,
      triesBefore: 0,
      at: Date.parse("2026-11-07T15:30:02Z"),
      answer: { outcome: "declined", errorCode: "card_declined" },
      nextTryAt: null,
      zone: "America/New_York",
    };

    const request = resultRequest(record);

    expect(request).toMatchObject({
      outcome: "declined",
      at: "2026-11-07T15:30:02Z",
      errorCode: "card_declined",
      providerObjectId: null,
      ledgerLineId: null,
      nextTryAt: null,
    });
    expect(resultEntry(record)).toMatchObject({
      id: "log-eff-alex-grooms-deposit-declined-run-1-try-1-declined",
      newValues: { state: "declined", tries: 1, runs: 1, errorCode: "card_declined" },
      why: { try: 1, outcome: "declined" },
    });
    expect(endsInOutage(record)).toBe(false);
    expect(contractChecks().k05("recordEffectResult.request", request)).toEqual([]);
  });

  it("names a ledger line in an ok try's new values only when there is one", () => {
    const base: TryRecord = {
      claimer: "effects-runner-1",
      effect: depositCharge(),
      expectVersion: 2,
      triesBefore: 0,
      at: Date.parse("2026-11-07T15:20:02Z"),
      answer: {
        outcome: "ok",
        providerObjectId: "stripe-charge-demo-0001",
        ledgerLineId: "ledger-alex-grooms-deposit",
      },
      nextTryAt: null,
      zone: null,
    };
    expect(resultEntry(base).newValues).toEqual({
      state: "succeeded",
      tries: 1,
      runs: 1,
      providerObjectId: "stripe-charge-demo-0001",
      ledgerLineId: "ledger-alex-grooms-deposit",
    });
    expect(resultRequest(base).ledgerLineId).toBe("ledger-alex-grooms-deposit");
    const bare: TryRecord = {
      ...base,
      answer: { outcome: "ok", providerObjectId: null, ledgerLineId: null },
    };
    expect(resultEntry(bare).newValues).toEqual({ state: "succeeded", tries: 1, runs: 1 });
    expect(resultEntry(bare).zone).toBeNull();
  });
});
