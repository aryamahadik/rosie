// T-565: the hand-written K-21 v1 request checks (./request.ts), which run in workerd, held to Ajv's verdict on the
// schema itself (page-api.v1.schema.json `testPhoneSend.request`, `testPhoneParts.request`): the fixtures' requests and
// each way of getting one field wrong that the schema names. The one check that is code's alone (`since` names a real
// instant: common/formats.v1 utc) is shown apart.

import { describe, expect, it } from "vitest";

import { isRealInstant, lacksSessionToken, testPhonePartsProblems, testPhoneSendProblems } from "./request";
import { PARTS_FIXTURE, SEND_FIXTURE, k21Problems } from "./test-support";

const PAGE = SEND_FIXTURE.request.page as Record<string, unknown>;

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
];

/** K-21 v1 `testPhoneSend.request`'s own fields, right and wrong. */
const SENDS: [string, unknown][] = [
  ["the fixture's request", SEND_FIXTURE.request],
  ["not an object", "testPhoneSend"],
  ["null", null],
  ["an array", [SEND_FIXTURE.request]],
  ["a field K-21 does not name", { ...SEND_FIXTURE.request, number: "+15555550104" }],
  ["testPhoneId missing", without(SEND_FIXTURE.request, "testPhoneId")],
  ["testPhoneId empty", { ...SEND_FIXTURE.request, testPhoneId: "" }],
  ["testPhoneId a number", { ...SEND_FIXTURE.request, testPhoneId: 4 }],
  ["words missing", without(SEND_FIXTURE.request, "words")],
  ["words empty", { ...SEND_FIXTURE.request, words: "" }],
  ["words one character", { ...SEND_FIXTURE.request, words: "?" }],
  ["words 10000 characters", { ...SEND_FIXTURE.request, words: "w".repeat(10_000) }],
  ["words 10001 characters", { ...SEND_FIXTURE.request, words: "w".repeat(10_001) }],
  ["words 10000 astral characters", { ...SEND_FIXTURE.request, words: astral(10_000) }],
  ["words 10001 astral characters", { ...SEND_FIXTURE.request, words: astral(10_001) }],
  ["words a number", { ...SEND_FIXTURE.request, words: 7 }],
  ["threadedReplyTo null", { ...SEND_FIXTURE.request, threadedReplyTo: null }],
  ["threadedReplyTo missing", without(SEND_FIXTURE.request, "threadedReplyTo")],
  ["threadedReplyTo empty", { ...SEND_FIXTURE.request, threadedReplyTo: "" }],
  ["threadedReplyTo a number", { ...SEND_FIXTURE.request, threadedReplyTo: 7 }],
  ...PAGES.map(([name, page]): [string, unknown] => [`page: ${name}`, { ...SEND_FIXTURE.request, page }]),
];

/** K-21 v1 `testPhoneParts.request`'s own fields, right and wrong. */
const PARTS: [string, unknown][] = [
  ["the fixture's request", PARTS_FIXTURE.request],
  ["not an object", 7],
  ["a field K-21 does not name", { ...PARTS_FIXTURE.request, words: "hello" }],
  ["testPhoneId missing", without(PARTS_FIXTURE.request, "testPhoneId")],
  ["testPhoneId a line end alone", { ...PARTS_FIXTURE.request, testPhoneId: "\n" }],
  ["since missing", without(PARTS_FIXTURE.request, "since")],
  ["since a time", { ...PARTS_FIXTURE.request, since: "2026-10-23T14:05:04Z" }],
  ["since a time with a fraction", { ...PARTS_FIXTURE.request, since: "2026-10-23T14:05:04.250Z" }],
  ["since with a space", { ...PARTS_FIXTURE.request, since: "2026-10-23 14:05:04Z" }],
  ["since with an offset", { ...PARTS_FIXTURE.request, since: "2026-10-23T14:05:04+00:00" }],
  ["since without seconds", { ...PARTS_FIXTURE.request, since: "2026-10-23T14:05Z" }],
  ["since empty", { ...PARTS_FIXTURE.request, since: "" }],
  ["since a number", { ...PARTS_FIXTURE.request, since: 1_792_501_201 }],
  ...PAGES.map(([name, page]): [string, unknown] => [`page: ${name}`, { ...PARTS_FIXTURE.request, page }]),
];

describe("the request checks give K-21 v1's own verdict", () => {
  it.each(SENDS)("testPhoneSend.request, %s", (_name, request) => {
    const accepted = k21Problems(request, "testPhoneSend.request").length === 0;
    expect(testPhoneSendProblems(request).length === 0).toBe(accepted);
  });

  it.each(PARTS)("testPhoneParts.request, %s", (_name, request) => {
    const accepted = k21Problems(request, "testPhoneParts.request").length === 0;
    expect(testPhonePartsProblems(request).length === 0).toBe(accepted);
  });

  it("the tables hold accepted and refused requests for both calls", () => {
    const verdicts = (cases: [string, unknown][], definition: string): boolean[] =>
      cases.map(([, request]) => k21Problems(request, definition).length === 0);
    expect(verdicts(SENDS, "testPhoneSend.request")).toContain(true);
    expect(verdicts(SENDS, "testPhoneSend.request")).toContain(false);
    expect(verdicts(PARTS, "testPhoneParts.request")).toContain(true);
    expect(verdicts(PARTS, "testPhoneParts.request")).toContain(false);
  });

  it("a problem names a field, never a value from the request", () => {
    const request = {
      ...SEND_FIXTURE.request,
      page: { ...PAGE, sessionToken: "short-token", personId: "person-sam" },
      testPhoneId: "",
      words: "",
      threadedReplyTo: "",
      number: "+15555550104",
    };
    const problems = testPhoneSendProblems(request).join("\n");
    expect(problems).not.toBe("");
    for (const value of ["short-token", "person-sam", "personId", "+15555550104", "number"])
      expect(problems).not.toContain(value);
  });
});

describe("code's own check: since names a real instant", () => {
  it.each([
    ["2026-10-23T14:05:04Z", true],
    ["2026-10-23T14:05:04.250Z", true],
    ["2028-02-29T00:00:00Z", true],
    ["0000-01-01T00:00:00Z", true],
    ["2026-02-29T00:00:00Z", false],
    ["2026-02-30T14:05:04Z", false],
    ["2026-13-01T00:00:00Z", false],
    ["2026-00-10T00:00:00Z", false],
    ["2026-10-23T24:00:00Z", false],
    ["2026-10-23T23:60:00Z", false],
    ["2026-10-23T23:59:60Z", false],
  ])("%s: %s", (since, real) => {
    expect(isRealInstant(since)).toBe(real);
    // The schema leaves it to code: it accepts each of them.
    expect(k21Problems({ ...PARTS_FIXTURE.request, since }, "testPhoneParts.request")).toEqual([]);
    expect(testPhonePartsProblems({ ...PARTS_FIXTURE.request, since }).length === 0).toBe(real);
  });
});

describe("no session token: signInNeeded, whatever else the request holds", () => {
  it.each([
    ["a null token", { page: { ...PAGE, sessionToken: null } }, true],
    ["no token at all", { page: without(PAGE, "sessionToken") }, true],
    ["a token", { page: PAGE }, false],
    ["a token too short to be one", { page: { ...PAGE, sessionToken: "short" } }, false],
    ["no page", {}, false],
    ["a page that is no object", { page: "page" }, false],
    ["a request that is no object", null, false],
  ])("%s", (_name, request, lacks) => {
    expect(lacksSessionToken(request)).toBe(lacks);
  });
});
