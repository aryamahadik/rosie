// The seeded test-state picker (T-525; C-205; build prompt 9.4 "Seeded state" and "The test-phone page"; K-21 v1
// testRoster): HTML made on the Worker, with no script and no form, for the frame (shell/frame.ts). Staging only:
// routes.ts puts the folder's routes behind the staging-only guard (T-522), and web/src/routes.ts marks the folder
// staging only.
//
// The page is at /staging/test-phone/phones under BASE_PATH, under the test-phone page's own address (send/page.ts). It
// lists what K-21 v1 testRoster answers, in the answer's order:
//   - the roster's test phones, each with what it texts as (its label), its roster id, its role (owner, staff,
//     customer, second customer, the STOP phone), the last four digits of its number, its business and its seeded
//     customer, and a link that sends as it: the test-phone page with that phone chosen (send/page.ts testPhoneHref:
//     the address's `phone` field holds the roster id, which the send side reads). So choosing a phone here sets it
//     for the send side. The STOP phone is marked plainly, and so is a phone whose texts are stopped;
//   - the seeded test businesses, each signed up or not yet, live or not, with its flow, its kinds of work, its time
//     zone and its own text hours.
// Each row says what its own part of the answer gives, never guessed (CQ-14): before the F14 setup seeds a business
// shows as not yet signed up, and before the F15 customer seeds a phone shows no seeded customer.
//
// What the page never holds or shows: a phone number beyond the last four digits the answer gives, who holds a phone
// (rule 9), or the tester's session token (it rides in the HttpOnly cookie and the call's envelope alone:
// auth/cookies.ts). Every value from the answer is escaped with escapeHtml. No source gives these words beyond build
// prompt 9.4's on the STOP phone and K-21 v1's on a stopped phone; the rest are plain stand-ins.

import { startHref } from "../../../auth/pages";
import type { ResponseOf } from "../../../client/calls";
import type { WebConfig } from "../../../shell/config";
import { escapeHtml } from "../../../shell/frame";
import type { RoutePage } from "../../../shell/route";
import { TEST_PHONE_PATH, testPhoneHref } from "../send/page";

/** The picker's path under BASE_PATH: under the test-phone page's own. */
export const PICKER_PATH = `${TEST_PHONE_PATH}/phones`;

/** K-21 v1 testRoster's answer: staging's seeded test businesses and the roster's test phones. */
export type TestRoster = ResponseOf<"testRoster">;
/** One seeded test business (K-21 v1 `RosterBusiness`). */
export type RosterBusiness = TestRoster["businesses"][number];
/** One test phone (K-21 v1 `RosterPhone`). */
export type RosterPhone = TestRoster["phones"][number];
/** A test phone's role in tests (K-21 v1 `RosterPhone.role`; build prompt 9.4; Q-53). */
export type RosterRole = RosterPhone["role"];

/** Each role's words on the page, in K-21 v1's order. */
export const ROLE_WORDS: Readonly<Record<RosterRole, string>> = {
  owner: "Owner",
  staff: "Staff",
  customer: "Customer",
  secondCustomer: "Second customer",
  stop: "The STOP phone",
};

/** The page's words. */
export const WORDS = {
  title: "Test phones",
  intro:
    "Staging only. Staging's test phones and seeded test businesses, as staging holds them now. Pick the phone to text as: its link opens the test-phone page with that phone chosen.",
  phonesHeading: "Phones to send as",
  businessesHeading: "Seeded test businesses",
  noneListed: "None listed.",
  rosterId: "Roster id",
  role: "Role",
  number: "Number",
  ending: "Ending",
  business: "Business",
  noBusiness: "None",
  seededCustomer: "Seeded customer",
  noSeededCustomer: "No seeded customer",
  sendAs: "Send as this phone",
  stopMark: "The STOP phone.",
  stopLine:
    "Use it only for a test about STOP. A bare STOP, or any other opt-out word sent alone, stops Rosie's texts to that phone for every business, so the test always ends by texting START: one reply comes, and texts work again.",
  stoppedMark: "Stopped.",
  stoppedLine: "Rosie's texts to this phone are off for every business until it texts START.",
  signedUp: "Signed up.",
  notSignedUp: "Not yet signed up.",
  live: "Live.",
  notLive: "Not live.",
  flow: "Flow",
  kinds: "Kinds of work",
  noKinds: "None",
  zone: "Time zone",
  textHours: "Text hours",
  textHoursTo: "to",
  signInTitle: "Sign in first",
  signInLine: "Staging's test phones are for staging's testers and Rosie's team, signed in.",
  signIn: "Sign in",
  notTesterTitle: "Not a tester",
  notTesterLine:
    "This account is neither one of staging's testers nor on Rosie's team, so it cannot see staging's test phones.",
  signInAsOther: "Sign in with another account",
  tryAgainTitle: "Not read",
  tryAgainLine: "That did not go through, and nothing was read. Try again in a moment.",
  tryAgain: "Try again",
} as const;

/** The picker's address on this site: its path under BASE_PATH, never a host. */
export function pickerHref(config: WebConfig): string {
  return `${config.basePath}${PICKER_PATH}`;
}

const p = (words: string): string => `<p>${escapeHtml(words)}</p>`;
const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;
/** One term of a description list and its value, the value already HTML. */
const pair = (term: string, valueHtml: string): string => `<dt>${escapeHtml(term)}</dt><dd>${valueHtml}</dd>`;
/** A plain mark on a row: its words in bold, then what it means. */
const mark = (marked: string, line: string): string =>
  `<p><strong>${escapeHtml(marked)}</strong> ${escapeHtml(line)}</p>`;
/** A list of rows, each row's lines; a line that says so when there is none. */
const listOf = (rows: readonly string[][]): string[] =>
  rows.length === 0 ? [p(WORDS.noneListed)] : ["<ul>", ...rows.flat(), "</ul>"];

/** The business a phone is seated at: its name, by the answer's own businesses; its id when they name none. */
function businessOf(phone: RosterPhone, names: ReadonlyMap<string, string>): string {
  if (phone.businessId === null) return escapeHtml(WORDS.noBusiness);
  const name = names.get(phone.businessId);
  return name === undefined ? code(phone.businessId) : escapeHtml(name);
}

/** One test phone's row, with its link to the test-phone page with that phone chosen. */
function phoneRow(config: WebConfig, phone: RosterPhone, names: ReadonlyMap<string, string>): string[] {
  const customer = phone.seededCustomer;
  return [
    "<li>",
    `<h3>${escapeHtml(phone.label)}</h3>`,
    ...(phone.role === "stop" ? [mark(WORDS.stopMark, WORDS.stopLine)] : []),
    ...(phone.stopped ? [mark(WORDS.stoppedMark, WORDS.stoppedLine)] : []),
    "<dl>",
    pair(WORDS.rosterId, code(phone.testPhoneId)),
    pair(WORDS.role, escapeHtml(ROLE_WORDS[phone.role])),
    pair(WORDS.number, `${escapeHtml(WORDS.ending)} ${escapeHtml(phone.last4)}`),
    pair(WORDS.business, businessOf(phone, names)),
    pair(WORDS.seededCustomer, escapeHtml(customer === null ? WORDS.noSeededCustomer : customer.name)),
    "</dl>",
    `<p><a href="${escapeHtml(testPhoneHref(config, phone.testPhoneId))}">${escapeHtml(WORDS.sendAs)}</a></p>`,
    "</li>",
  ];
}

/** One seeded test business's row. */
function businessRow(business: RosterBusiness): string[] {
  const { start, end } = business.textHours;
  return [
    "<li>",
    `<h3>${escapeHtml(business.name)}</h3>`,
    p(
      `${business.signedUp ? WORDS.signedUp : WORDS.notSignedUp} ${business.live ? WORDS.live : WORDS.notLive}`,
    ),
    "<dl>",
    pair(WORDS.flow, escapeHtml(business.flow)),
    pair(
      WORDS.kinds,
      escapeHtml(business.kindIds.length === 0 ? WORDS.noKinds : business.kindIds.join(", ")),
    ),
    pair(WORDS.zone, escapeHtml(business.zone)),
    pair(WORDS.textHours, escapeHtml(`${start} ${WORDS.textHoursTo} ${end}`)),
    "</dl>",
    "</li>",
  ];
}

/** The picker (see the top of this file), for K-21 v1 testRoster's answer. */
export function pickerPage(config: WebConfig, roster: TestRoster): RoutePage {
  const names = new Map(roster.businesses.map((business) => [business.businessId, business.name]));
  const main = [
    `<h1>${escapeHtml(WORDS.title)}</h1>`,
    p(WORDS.intro),
    `<h2>${escapeHtml(WORDS.phonesHeading)}</h2>`,
    ...listOf(roster.phones.map((phone) => phoneRow(config, phone, names))),
    `<h2>${escapeHtml(WORDS.businessesHeading)}</h2>`,
    ...listOf(roster.businesses.map(businessRow)),
  ].join("\n");
  return { title: WORDS.title, main };
}

/**
 * The page that asks for sign-in first: the picker sits behind the tester login (T-520). 200 when the browser sent no
 * session; 403 when the server answered that no live session came (K-21 v1 signInNeeded).
 */
export function signInFirstPage(config: WebConfig, refused: boolean): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.signInTitle)}</h1>`,
    p(WORDS.signInLine),
    `<p><a href="${escapeHtml(startHref(config, null))}">${escapeHtml(WORDS.signIn)}</a></p>`,
  ].join("\n");
  return { title: WORDS.signInTitle, main, status: refused ? 403 : 200 };
}

/** The page for a signed-in person who is neither a tester nor on Rosie's team (K-21 v1 notTester): nothing was read. */
export function notTesterPage(config: WebConfig): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.notTesterTitle)}</h1>`,
    p(WORDS.notTesterLine),
    `<p><a href="${escapeHtml(startHref(config, null))}">${escapeHtml(WORDS.signInAsOther)}</a></p>`,
  ].join("\n");
  return { title: WORDS.notTesterTitle, main, status: 403 };
}

/** The page for K-21 v1's transient answer: nothing was read; the link opens the picker again. */
export function tryAgainPage(config: WebConfig): RoutePage {
  const main = [
    `<h1>${escapeHtml(WORDS.tryAgainTitle)}</h1>`,
    `<p role="alert">${escapeHtml(WORDS.tryAgainLine)}</p>`,
    `<p><a href="${escapeHtml(pickerHref(config))}">${escapeHtml(WORDS.tryAgain)}</a></p>`,
  ].join("\n");
  return { title: WORDS.tryAgainTitle, main, status: 503 };
}
