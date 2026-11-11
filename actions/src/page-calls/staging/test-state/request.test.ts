// T-574: the hand-written K-21 v1 request check (./request.ts), which runs in workerd, held to Ajv's verdict on the
// schema itself (page-api.v1.schema.json `testRoster.request`): the fixture's request and each way of getting one field
// wrong that the schema names.

import { describe, expect, it } from "vitest";

import { ROSTER_FIXTURE, k21Problems } from "../test-phone/test-support";
import { testRosterProblems } from "./request";

const PAGE = ROSTER_FIXTURE.request.page as Record<string, unknown>;

function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

const astral = (count: number): string => "\u{1F600}".repeat(count);

/** The page envelope, each way K-21 v1 `signedInPage` names, right and wrong. */
const PAGES: [string, unknown][] = [
  ["the fixture's page", PAGE],
  ["no page", undefined],
  ["page null", null],
  ["page an array", [PAGE]],
  ["page a string", "page"],
  ["page with a field K-21 does not name", { ...PAGE, personId: "person-sam" }],
  ["requestId missing", without(PAGE, "requestId")],
  ["requestId empty", { ...PAGE, requestId: "" }],
  ["requestId a line end alone", { ...PAGE, requestId: "\n" }],
  ["requestId a number", { ...PAGE, requestId: 7 }],
  ["traceId missing", without(PAGE, "traceId")],
  ["traceId empty", { ...PAGE, traceId: "" }],
  ["traceId a UUID", { ...PAGE, traceId: "6f9619ff-8b86-d011-b42d-00c04fc964ff" }],
  ["sessionToken null", { ...PAGE, sessionToken: null }],
  ["sessionToken missing", without(PAGE, "sessionToken")],
  ["sessionToken 15 characters", { ...PAGE, sessionToken: "t".repeat(15) }],
  ["sessionToken 16 characters", { ...PAGE, sessionToken: "t".repeat(16) }],
  ["sessionToken 512 characters", { ...PAGE, sessionToken: "t".repeat(512) }],
  ["sessionToken 513 characters", { ...PAGE, sessionToken: "t".repeat(513) }],
  ["sessionToken 15 astral characters (30 code units)", { ...PAGE, sessionToken: astral(15) }],
  ["sessionToken 16 astral characters (32 code units)", { ...PAGE, sessionToken: astral(16) }],
  ["sessionToken 300 astral characters (600 code units)", { ...PAGE, sessionToken: astral(300) }],
  ["sessionToken a number", { ...PAGE, sessionToken: 1234567890123456 }],
  ["linkCode missing", without(PAGE, "linkCode")],
  ["linkCode a code", { ...PAGE, linkCode: "rosfield-v-s01" }],
  ["linkCode 3 characters", { ...PAGE, linkCode: "abc" }],
  ["linkCode 2 characters", { ...PAGE, linkCode: "ab" }],
  ["linkCode 64 characters", { ...PAGE, linkCode: "a".repeat(64) }],
  ["linkCode 65 characters", { ...PAGE, linkCode: "a".repeat(65) }],
  ["linkCode with an underscore", { ...PAGE, linkCode: "abc_def" }],
  ["linkCode with a line end after it", { ...PAGE, linkCode: "abc\n" }],
  ["linkCode a number", { ...PAGE, linkCode: 7 }],
];

/** K-21 v1 `testRoster.request`, right and wrong. */
const REQUESTS: [string, unknown][] = [
  ["the fixture's request", ROSTER_FIXTURE.request],
  ["not an object", "testRoster"],
  ["null", null],
  ["an array", [ROSTER_FIXTURE.request]],
  ["no field at all", {}],
  ["a field K-21 does not name", { ...ROSTER_FIXTURE.request, testPhoneId: "tp-03" }],
  ["a browser value naming a business", { ...ROSTER_FIXTURE.request, businessId: "biz-lees-barbershop" }],
  ...PAGES.map(([name, page]): [string, unknown] => [`page: ${name}`, { page }]),
];

describe("the request check gives K-21 v1's own verdict", () => {
  it.each(REQUESTS)("testRoster.request, %s", (_name, request) => {
    const accepted = k21Problems(request, "testRoster.request").length === 0;
    expect(testRosterProblems(request).length === 0).toBe(accepted);
  });

  it("the table holds accepted and refused requests", () => {
    const verdicts = REQUESTS.map(([, request]) => k21Problems(request, "testRoster.request").length === 0);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
    expect(testRosterProblems(ROSTER_FIXTURE.request)).toEqual([]);
  });

  it("a problem names a field, never a value from the request", () => {
    const request = {
      page: { ...PAGE, sessionToken: "short-token", personId: "person-sam", linkCode: "no" },
      number: "+15555550104",
    };
    const problems = testRosterProblems(request).join("\n");
    expect(problems).not.toBe("");
    for (const value of ["short-token", "person-sam", "personId", "+15555550104", "number"])
      expect(problems).not.toContain(value);
  });
});
