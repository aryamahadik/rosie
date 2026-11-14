// T-1282: the hand-written K-21 v1 request checks (./request.ts), which run in workerd, held to Ajv's verdict on the
// schema itself (page-api.v1.schema.json `signInStart.request`): the fixtures' requests and each way of getting one
// field wrong that the schema names. Then how a typed contact is read for K-05 v1.13's signInContact, held to K-05's own
// definitions of an email on file and a mobile number.

import { describe, expect, it } from "vitest";

import { contactOf, emailOf, mobileOf, signInStartProblems, type SignInStartRequest } from "./request";
import {
  REFUSE_NAMES_PERSON,
  SIGN_IN_FROM_LINK,
  SIGN_IN_REQUEST,
  k05Problems,
  k21Problems,
  linkStartRequest,
} from "./test-support";

const REQUEST = SIGN_IN_REQUEST.request;
const PAGE = REQUEST.page as Record<string, unknown>;
const ACCOUNT = REQUEST.account as Record<string, unknown>;
const LINK_REQUEST = SIGN_IN_FROM_LINK.request;
const LINK_PAGE = LINK_REQUEST.page as Record<string, unknown>;

function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

const astral = (count: number): string => "\u{1F600}".repeat(count);

/** The page envelope, each way K-21 v1 `page` names, right and wrong. */
const PAGES: [string, unknown][] = [
  ["the fixture's page", PAGE],
  ["no page", undefined],
  ["page null", null],
  ["page an array", [PAGE]],
  ["page with a field K-21 does not name", { ...PAGE, personId: "person-sam" }],
  ["requestId missing", without(PAGE, "requestId")],
  ["requestId empty", { ...PAGE, requestId: "" }],
  ["requestId a line end alone", { ...PAGE, requestId: "\n" }],
  ["requestId a number", { ...PAGE, requestId: 7 }],
  ["traceId missing", without(PAGE, "traceId")],
  ["traceId empty", { ...PAGE, traceId: "" }],
  ["sessionToken a token", { ...PAGE, sessionToken: "placeholder-session-token-sam-0001" }],
  ["sessionToken missing", without(PAGE, "sessionToken")],
  ["sessionToken 15 characters", { ...PAGE, sessionToken: "t".repeat(15) }],
  ["sessionToken 512 characters", { ...PAGE, sessionToken: "t".repeat(512) }],
  ["sessionToken 513 characters", { ...PAGE, sessionToken: "t".repeat(513) }],
  ["sessionToken 16 astral characters", { ...PAGE, sessionToken: astral(16) }],
  ["sessionToken a number", { ...PAGE, sessionToken: 1234567890123456 }],
  ["linkCode missing", without(PAGE, "linkCode")],
  ["linkCode a code", { ...PAGE, linkCode: "s01-placeholder-sam" }],
  ["linkCode 2 characters", { ...PAGE, linkCode: "ab" }],
  ["linkCode 65 characters", { ...PAGE, linkCode: "a".repeat(65) }],
  ["linkCode with an underscore", { ...PAGE, linkCode: "abc_def" }],
];

/** The typed account, each way K-21 v1's oneOf names, right and wrong. */
const ACCOUNTS: [string, unknown][] = [
  ["the fixture's typed email", ACCOUNT],
  ["a typed mobile", { from: "typed", kind: "mobile", typed: "(555) 555-0111" }],
  ["no account", undefined],
  ["account null", null],
  ["account a string", "typed"],
  ["account with a field K-21 does not name", { ...ACCOUNT, personId: "person-sam" }],
  ["from missing", without(ACCOUNT, "from")],
  ["from another word", { ...ACCOUNT, from: "session" }],
  ["kind missing", without(ACCOUNT, "kind")],
  ["kind another word", { ...ACCOUNT, kind: "phone" }],
  ["typed missing", without(ACCOUNT, "typed")],
  ["typed empty", { ...ACCOUNT, typed: "" }],
  ["typed 254 characters", { ...ACCOUNT, typed: "a".repeat(254) }],
  ["typed 255 characters", { ...ACCOUNT, typed: "a".repeat(255) }],
  ["typed 254 astral characters", { ...ACCOUNT, typed: astral(254) }],
  ["typed a number", { ...ACCOUNT, typed: 5555550111 }],
  ["from link with a kind", { from: "link", kind: "email" }],
];

/** K-21 v1 `signInStart.request`'s own fields, right and wrong. */
const STARTS: [string, unknown][] = [
  ["the fixture's request", REQUEST],
  ["the fixture's request on the text way", { ...REQUEST, way: "text" }],
  ["a link's own start on the email way", linkStartRequest()],
  ["a link's own start on the text way", LINK_REQUEST],
  ["a link's own start with no link code", { ...LINK_REQUEST, page: { ...LINK_PAGE, linkCode: null } }],
  ["a link's own start with no link code field", { ...LINK_REQUEST, page: without(LINK_PAGE, "linkCode") }],
  ["a typed start with a link code", { ...REQUEST, page: { ...PAGE, linkCode: "s01-placeholder-sam" } }],
  ["a request naming whose account (refuse-sign-in-names-person.json)", REFUSE_NAMES_PERSON],
  ["not an object", "signInStart"],
  ["null", null],
  ["an array", [REQUEST]],
  ["way missing", without(REQUEST, "way")],
  ["way another word", { ...REQUEST, way: "sms" }],
  ["deviceToken missing", without(REQUEST, "deviceToken")],
  ["deviceToken 15 characters", { ...REQUEST, deviceToken: "d".repeat(15) }],
  ["deviceToken 16 characters", { ...REQUEST, deviceToken: "d".repeat(16) }],
  ["deviceToken 513 characters", { ...REQUEST, deviceToken: "d".repeat(513) }],
  ["deviceToken null", { ...REQUEST, deviceToken: null }],
  ...PAGES.map(([name, page]): [string, unknown] => [`page: ${name}`, { ...REQUEST, page }]),
  ...ACCOUNTS.map(([name, account]): [string, unknown] => [`account: ${name}`, { ...REQUEST, account }]),
];

describe("the request checks give K-21 v1's own verdict", () => {
  it.each(STARTS)("signInStart.request, %s", (_name, request) => {
    const accepted = k21Problems(request, "signInStart.request").length === 0;
    expect(signInStartProblems(request).length === 0).toBe(accepted);
  });

  it("the table holds accepted and refused requests", () => {
    const verdicts = STARTS.map(([, request]) => k21Problems(request, "signInStart.request").length === 0);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("refuse-sign-in-names-person.json is refused, and accepted without its one fault", () => {
    expect(signInStartProblems(REFUSE_NAMES_PERSON)).not.toEqual([]);
    expect(signInStartProblems(without(REFUSE_NAMES_PERSON, "forPersonId"))).toEqual([]);
  });

  it("a problem names a field, never a value from the request", () => {
    const request = {
      ...REQUEST,
      page: { ...PAGE, sessionToken: "short-token", personId: "person-sam" },
      account: { from: "typed", kind: "phone", typed: "sam@lees-barbershop.example" },
      deviceToken: "short-device",
      forPersonId: "person-sam",
    };
    const problems = signInStartProblems(request).join("\n");
    expect(problems).not.toBe("");
    for (const value of [
      "short-token",
      "person-sam",
      "personId",
      "forPersonId",
      "sam@lees-barbershop.example",
      "short-device",
      "phone",
    ])
      expect(problems).not.toContain(value);
  });
});

describe("the typed contact, read as K-05 v1.13's signInContact", () => {
  it.each([
    ["sam@lees-barbershop.example", "sam@lees-barbershop.example"],
    ["  Sam@Lees-Barbershop.EXAMPLE ", "sam@lees-barbershop.example"],
    ["SAM@EXAMPLE.COM", "sam@example.com"],
    ["sam@example.com\n", "sam@example.com"],
  ])("the email %j is read as %s, an email on file", (typed, address) => {
    expect(emailOf(typed)).toBe(address);
    expect(k05Problems(address, "emailOnFile")).toEqual([]);
  });

  it.each(["sam", "sam@", "@example.com", "sam@@example.com", "sam @example.com", "sam@exam ple.com", " "])(
    "%j is no email",
    (typed) => {
      expect(emailOf(typed)).toBeNull();
    },
  );

  it.each([
    ["+15555550111", "+15555550111"],
    ["(555) 555-0111", "+15555550111"],
    ["555.555.0111", "+15555550111"],
    ["1 555 555 0111", "+15555550111"],
    ["+1 (555) 555-0112", "+15555550112"],
    [" 5555550111 ", "+15555550111"],
  ])("the mobile %j is read as %s, in E.164", (typed, number) => {
    expect(mobileOf(typed)).toBe(number);
    expect(k05Problems(number, "phoneNumber")).toEqual([]);
  });

  it.each([
    "555-0111",
    "0555550111",
    "15555550",
    "+05555550111",
    "555 555 0111 ext 2",
    "sam@example.com",
    "+1555",
  ])("%j is no mobile", (typed) => {
    expect(mobileOf(typed)).toBeNull();
  });

  it("an account from the link is counted by the page's link code as presented (K-22 default 15)", () => {
    const request = linkStartRequest() as unknown as SignInStartRequest;
    expect(contactOf(request)).toEqual({ kind: "link", hashed: LINK_PAGE.linkCode });
  });

  it("a typed contact that cannot be read gives none", () => {
    const typed = (kind: "email" | "mobile", text: string): SignInStartRequest =>
      ({ ...REQUEST, account: { from: "typed", kind, typed: text } }) as unknown as SignInStartRequest;
    expect(contactOf(typed("email", "not an address"))).toBeNull();
    expect(contactOf(typed("mobile", "555-0111"))).toBeNull();
    expect(contactOf(typed("email", "Sam@Example.com"))).toEqual({
      kind: "email",
      address: "sam@example.com",
      hashed: "sam@example.com",
    });
    expect(contactOf(typed("mobile", "(555) 555-0111"))).toEqual({
      kind: "mobile",
      number: "+15555550111",
      hashed: "+15555550111",
    });
  });
});
