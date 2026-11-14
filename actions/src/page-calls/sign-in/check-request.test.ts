// T-1285: the hand-written K-21 v1 request checks of signInCheck and signOut (./request.ts), which run in workerd, held to
// Ajv's verdict on the schema itself (page-api.v1.schema.json `signInCheck.request` and `signOut.request`, whose page is
// a `signedInPage`): the fixtures' requests and each way of getting one field wrong that the schema names.

import { describe, expect, it } from "vitest";

import { SIGN_IN_ALREADY, SIGN_IN_DONE, SIGN_IN_WRONG_FIVE, SIGN_OUT } from "./check-test-support";
import { signInCheckProblems, signOutProblems } from "./request";
import { k21Fixture, k21Problems } from "./test-support";

const CHECK = SIGN_IN_WRONG_FIVE.request;
const CHECK_PAGE = CHECK.page as Record<string, unknown>;
const OUT = SIGN_OUT.request;
const OUT_PAGE = OUT.page as Record<string, unknown>;

function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

const astral = (count: number): string => "\u{1F600}".repeat(count);

/** signInCheck's own fields and its page envelope, right and wrong. */
const CHECKS: [string, unknown][] = [
  ["sign-in-wrong-five.json's request", CHECK],
  ["sign-in-done.json's request (code null)", SIGN_IN_DONE.request],
  ["sign-in-already-signed-in.json's request", SIGN_IN_ALREADY.request],
  [
    "refuse-already-signed-in-with-token.json's request",
    k21Fixture("invalid/refuse-already-signed-in-with-token.json").request,
  ],
  ["not an object", "signInCheck"],
  ["null", null],
  ["an array", [CHECK]],
  ["with a field K-21 does not name", { ...CHECK, personId: "person-sam" }],
  ["attemptId missing", without(CHECK, "attemptId")],
  ["attemptId empty", { ...CHECK, attemptId: "" }],
  ["attemptId a line end alone", { ...CHECK, attemptId: "\n" }],
  ["attemptId a number", { ...CHECK, attemptId: 7 }],
  ["code missing", without(CHECK, "code")],
  ["code null", { ...CHECK, code: null }],
  ["code of 4 digits", { ...CHECK, code: "4829" }],
  ["code of 8 digits", { ...CHECK, code: "48291300" }],
  ["code of 3 digits", { ...CHECK, code: "482" }],
  ["code of 9 digits", { ...CHECK, code: "482913000" }],
  ["code with a letter", { ...CHECK, code: "48291a" }],
  ["code with a space", { ...CHECK, code: "482 913" }],
  ["code with a line end after it", { ...CHECK, code: "482913\n" }],
  ["code of other digits", { ...CHECK, code: "٤٨٢٩١٣" }],
  ["code a number", { ...CHECK, code: 482913 }],
  ["deviceToken missing", without(CHECK, "deviceToken")],
  ["deviceToken 15 characters", { ...CHECK, deviceToken: "d".repeat(15) }],
  ["deviceToken 16 characters", { ...CHECK, deviceToken: "d".repeat(16) }],
  ["deviceToken 512 characters", { ...CHECK, deviceToken: "d".repeat(512) }],
  ["deviceToken 513 characters", { ...CHECK, deviceToken: "d".repeat(513) }],
  ["deviceToken 16 astral characters", { ...CHECK, deviceToken: astral(16) }],
  ["deviceToken null", { ...CHECK, deviceToken: null }],
  ["page missing", without(CHECK, "page")],
  ["page null", { ...CHECK, page: null }],
  ["page with a field K-21 does not name", { ...CHECK, page: { ...CHECK_PAGE, personId: "person-sam" } }],
  ["page.requestId missing", { ...CHECK, page: without(CHECK_PAGE, "requestId") }],
  ["page.traceId empty", { ...CHECK, page: { ...CHECK_PAGE, traceId: "" } }],
  [
    "page.sessionToken a token",
    { ...CHECK, page: { ...CHECK_PAGE, sessionToken: "placeholder-session-token-sam-0001" } },
  ],
  ["page.sessionToken missing", { ...CHECK, page: without(CHECK_PAGE, "sessionToken") }],
  ["page.sessionToken 15 characters", { ...CHECK, page: { ...CHECK_PAGE, sessionToken: "t".repeat(15) } }],
  ["page.linkCode a code", { ...CHECK, page: { ...CHECK_PAGE, linkCode: "s01-placeholder-sam" } }],
  ["page.linkCode with an underscore", { ...CHECK, page: { ...CHECK_PAGE, linkCode: "abc_def" } }],
  ["page.linkCode missing", { ...CHECK, page: without(CHECK_PAGE, "linkCode") }],
];

/** signOut's page, a signedInPage: its session token required, never null. */
const OUTS: [string, unknown][] = [
  ["sign-out.json's request", OUT],
  ["not an object", "signOut"],
  ["null", null],
  ["with a field K-21 does not name", { ...OUT, deviceToken: "placeholder-device-token-sam-phone" }],
  ["page missing", {}],
  ["page null", { page: null }],
  ["page.sessionToken null", { page: { ...OUT_PAGE, sessionToken: null } }],
  ["page.sessionToken missing", { page: without(OUT_PAGE, "sessionToken") }],
  ["page.sessionToken 15 characters", { page: { ...OUT_PAGE, sessionToken: "t".repeat(15) } }],
  ["page.sessionToken 16 characters", { page: { ...OUT_PAGE, sessionToken: "t".repeat(16) } }],
  ["page.sessionToken 513 characters", { page: { ...OUT_PAGE, sessionToken: "t".repeat(513) } }],
  ["page.sessionToken 16 astral characters", { page: { ...OUT_PAGE, sessionToken: astral(16) } }],
  ["page.sessionToken a number", { page: { ...OUT_PAGE, sessionToken: 1234567890123456 } }],
  ["page with a field K-21 does not name", { page: { ...OUT_PAGE, personId: "person-sam" } }],
  ["page.requestId empty", { page: { ...OUT_PAGE, requestId: "" } }],
  ["page.traceId missing", { page: without(OUT_PAGE, "traceId") }],
  ["page.linkCode a code", { page: { ...OUT_PAGE, linkCode: "s01-placeholder-sam" } }],
  ["page.linkCode 2 characters", { page: { ...OUT_PAGE, linkCode: "ab" } }],
  ["page.linkCode missing", { page: without(OUT_PAGE, "linkCode") }],
];

describe("the request checks give K-21 v1's own verdict", () => {
  it.each(CHECKS)("signInCheck.request, %s", (_name, request) => {
    const accepted = k21Problems(request, "signInCheck.request").length === 0;
    expect(signInCheckProblems(request).length === 0).toBe(accepted);
  });

  it.each(OUTS)("signOut.request, %s", (_name, request) => {
    const accepted = k21Problems(request, "signOut.request").length === 0;
    expect(signOutProblems(request).length === 0).toBe(accepted);
  });

  it("each table holds accepted and refused requests", () => {
    for (const [table, definition] of [
      [CHECKS, "signInCheck.request"],
      [OUTS, "signOut.request"],
    ] as const) {
      const verdicts = table.map(([, request]) => k21Problems(request, definition).length === 0);
      expect(verdicts).toContain(true);
      expect(verdicts).toContain(false);
    }
  });

  it("a problem names a field, never a value from the request", () => {
    const check = {
      ...CHECK,
      page: { ...CHECK_PAGE, sessionToken: "short-token", personId: "person-sam" },
      attemptId: "",
      code: "48291a",
      deviceToken: "short-device",
      forPersonId: "person-sam",
    };
    const out = { page: { ...OUT_PAGE, sessionToken: "short-token-2", personId: "person-sam" }, extra: 1 };
    const problems = [...signInCheckProblems(check), ...signOutProblems(out)].join("\n");
    expect(problems).not.toBe("");
    for (const value of [
      "short-token",
      "person-sam",
      "personId",
      "forPersonId",
      "48291a",
      "short-device",
      "extra",
    ])
      expect(problems).not.toContain(value);
  });
});
