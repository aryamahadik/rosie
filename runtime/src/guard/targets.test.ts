// The guard's targets (T-250): K-05 v1.2 `handleTargets` (a fake answering in K-05's shape, held to its schema) made K-09
// v1's `guardTargets` (held to its schema). The targets are the open questions and the bookings; none is the doors.

import { afterEach, describe, expect, it } from "vitest";

import { readTargets, setGuardDeps, targetsOf, type TargetsRead } from "./targets";
import {
  contractProblems,
  fakeTargets,
  K05_V1_2,
  K09_V1,
  responseOf,
  targetsExchange,
  type FakeTargets,
} from "./test-support";
import type { HandleTargetsResponse } from "./types";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function wired(): FakeTargets {
  const fake = fakeTargets();
  restore = setGuardDeps({ targets: fake.port });
  return fake;
}

function targetsIn(read: TargetsRead): Extract<TargetsRead, { result: "targets" }> {
  if (read.result !== "targets") throw new Error(`no targets: ${read.errorCode}`);
  return read;
}

/**
 * Alex with two live open questions and one booking: A7-03's question about his haircut (targets-alex.json's), and a
 * question the yoga studio asked before any booking there (no booking yet), with his customer roles at both businesses.
 */
function twoQuestionsOneBooking(): HandleTargetsResponse {
  const answer = responseOf(targetsExchange("targets-alex"));
  const [haircutQuestion] = answer.openQuestions;
  const [haircut] = answer.bookings;
  if (haircutQuestion === undefined || haircut === undefined) throw new Error("targets-alex changed");
  return {
    ...answer,
    openQuestions: [
      haircutQuestion,
      {
        ...haircutQuestion,
        id: "oq-a3-51-alex-yoga",
        businessId: "biz-yoga-studio",
        bookingId: null,
        turnId: "turn-alex-yoga-1",
        step: "A3-51",
        options: [
          { id: "A3-51/1", label: "Sat 9:00am" },
          { id: "A3-51/2", label: "Sun 10:00am" },
        ],
        versionsRead: [],
        sentAt: "2026-10-23T13:40:00Z",
        pollId: null,
        version: 1,
      },
    ],
    bookings: [haircut],
  };
}

describe("a handle's targets: K-05 v1.2 handleTargets made K-09 v1 guardTargets", () => {
  it("a handle with two open questions and one booking lists three targets", async () => {
    const fake = wired();
    const answer = twoQuestionsOneBooking();
    expect(contractProblems(K05_V1_2, "handleTargets.response", answer)).toEqual([]);
    // The schema check is not empty: the same answer with a phone K-05 does not allow is refused.
    expect(contractProblems(K05_V1_2, "handleTargets.response", { ...answer, phone: "on" })).not.toEqual([]);
    fake.answers.set("handle-alex", answer);

    const read = targetsIn(await readTargets("handle-alex"));

    expect(read.targets).toEqual({
      roles: [
        { businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" },
        { businessId: "biz-yoga-studio", personId: "person-alex", role: "customer" },
      ],
      openQuestionIds: ["oq-a7-03-alex", "oq-a3-51-alex-yoga"],
      bookingIds: ["booking-alex-haircut"],
      noTarget: false,
    });
    expect(read.targets.openQuestionIds.length + read.targets.bookingIds.length).toBe(3);
    expect(read.counts).toEqual({ roles: 2, openQuestions: 2, bookings: 1 });
    expect(contractProblems(K09_V1, "guardTargets", read.targets)).toEqual([]);
    expect(contractProblems(K09_V1, "guardTargets", { ...read.targets, noTarget: "no" })).not.toEqual([]);
    expect(fake.calls).toEqual([{ handleId: "handle-alex" }]);
  });

  it("one with none lists none: the doors (targets-first-text, S1-01)", async () => {
    const fake = wired();
    const exchange = targetsExchange("targets-first-text");
    fake.answers.set(exchange.request.handleId, exchange.outcome);

    const read = targetsIn(await readTargets(exchange.request.handleId));

    expect(read.targets).toEqual({ roles: [], openQuestionIds: [], bookingIds: [], noTarget: true });
    expect(read.counts).toEqual({ roles: 0, openQuestions: 0, bookings: 0 });
    expect(contractProblems(K09_V1, "guardTargets", read.targets)).toEqual([]);
  });

  it("an owner with roles and no open question or booking gets the doors, with the roles that pick them (targets-sam-owner)", async () => {
    const fake = wired();
    const exchange = targetsExchange("targets-sam-owner");
    fake.answers.set(exchange.request.handleId, exchange.outcome);

    const read = targetsIn(await readTargets("handle-sam"));

    expect(read.targets).toEqual({
      roles: [
        { businessId: "biz-lees-barbershop", personId: "person-sam", role: "owner" },
        { businessId: "biz-movers", personId: "person-sam", role: "owner" },
        { businessId: "biz-yoga-studio", personId: "person-sam", role: "owner" },
      ],
      openQuestionIds: [],
      bookingIds: [],
      noTarget: true,
    });
    expect(contractProblems(K09_V1, "guardTargets", read.targets)).toEqual([]);
  });

  it.each([
    ["targets-alex", ["oq-a7-03-alex"], ["booking-alex-haircut", "booking-alex-workshop"]],
    ["targets-poll-failed-plain", ["oq-a7-03-alex"], ["booking-alex-haircut", "booking-alex-workshop"]],
  ])(
    "%s: every open question and booking, every business's, in K-05's order",
    async (name, questions, bookings) => {
      const fake = wired();
      const exchange = targetsExchange(name);
      fake.answers.set(exchange.request.handleId, exchange.outcome);

      const read = targetsIn(await readTargets(exchange.request.handleId));

      expect(read.targets.openQuestionIds).toEqual(questions);
      expect(read.targets.bookingIds).toEqual(bookings);
      expect(read.targets.noTarget).toBe(false);
      expect(contractProblems(K09_V1, "guardTargets", read.targets)).toEqual([]);
    },
  );

  it("each person on a shared handle keeps their own roles (one handle can be several people: arch 01 line 55)", () => {
    const answer = responseOf(targetsExchange("targets-alex"));
    answer.persons.push({
      personId: "person-riley",
      roles: [{ roleId: "role-riley-barber", businessId: "biz-lees-barbershop", role: "staff", version: 1 }],
    });
    expect(contractProblems(K05_V1_2, "handleTargets.response", answer)).toEqual([]);

    const read = targetsIn(targetsOf(answer, "handle-alex"));

    expect(read.targets.roles).toEqual([
      { businessId: "biz-lees-barbershop", personId: "person-alex", role: "customer" },
      { businessId: "biz-yoga-studio", personId: "person-alex", role: "customer" },
      { businessId: "biz-lees-barbershop", personId: "person-riley", role: "staff" },
    ]);
  });
});

describe("no targets unless K-05 answered them for this handle (fail closed)", () => {
  it("K-05's notFound and transient answers give no targets", async () => {
    const fake = wired();
    fake.answers.set("handle-alex", { error: "transient", sqlstate: "40001" });

    expect(await readTargets("handle-alex")).toEqual({ result: "failed", errorCode: "transient" });
    expect(await readTargets("handle-nobody")).toEqual({ result: "failed", errorCode: "notFound" });
  });

  it("a read that fails with no answer, or no read set yet, gives no targets", async () => {
    expect(await readTargets("handle-alex")).toEqual({ result: "failed", errorCode: "unwired" });
    const fake = wired();
    fake.failing = true;
    expect(await readTargets("handle-alex")).toEqual({ result: "failed", errorCode: "noAnswer" });
  });

  it("an answer that is not K-05's response for this handle is refused (badAnswer)", () => {
    const good = responseOf(targetsExchange("targets-alex"));
    const [person] = good.persons;
    if (person === undefined) throw new Error("targets-alex changed");
    const bad: unknown[] = [
      null,
      "targets",
      [],
      { ...good, result: "target" },
      { ...good, handleId: "handle-sam" },
      { ...good, persons: undefined },
      { ...good, persons: [{ ...person, personId: "" }] },
      { ...good, persons: [{ ...person, roles: [{ ...person.roles[0], role: "manager" }] }] },
      { ...good, persons: [{ ...person, roles: [{ ...person.roles[0], businessId: 7 }] }] },
      { ...good, openQuestions: [{ businessId: "biz-lees-barbershop" }] },
      { ...good, openQuestions: "oq-a7-03-alex" },
      { ...good, bookings: [{ id: "" }] },
      { ...good, bookings: null },
    ];
    for (const answer of bad) {
      expect(targetsOf(answer, "handle-alex"), JSON.stringify(answer)).toEqual({
        result: "failed",
        errorCode: "badAnswer",
      });
    }
  });
});
