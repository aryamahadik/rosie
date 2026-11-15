// T-525's proofs for the seeded test-state picker (C-205; build prompt 9.4 "Seeded state"; K-21 v1 test-roster.json;
// QUESTIONS Q-53, Q-54; CQ-14): with the listing call's fixture, the picker lists each seeded business and test phone,
// each phone with its role (owner, staff, customer, second customer, the STOP phone); choosing a phone sets it for the
// send side (each phone's link opens T-523's send page with that phone chosen, T-523's own routes run here); and before
// the F14 and F15 seeds land, businesses show as not yet signed up and phones as having no seeded customer. Beside them:
// the tester login the picker sits behind, the page of each other answer K-21 v1 gives, rows the answer shapes in other
// ways, every value escaped, and what no page of the picker holds. staging-only.test.ts holds the proof that the picker
// is absent in production (T-522).
//
// The page runs on the shell over the Tool API mock, which answers a frozen fixture's request alone and fails the test
// on any other (C-186), or over answers typed by K-21 v1 where no frozen fixture shows the case. Every value is made up
// or a K-21 fixture's own placeholder (rule 9); no phone number is written here, only the last four digits the fixture
// gives.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cookieNames } from "../../../auth/cookies";
import { startHref } from "../../../auth/pages";
import { hiddenFields } from "../../../auth/test-support";
import type { OutcomeOf, ResponseOf } from "../../../client/calls";
import { readWebConfig } from "../../../shell/config";
import { REFERENCE_LABEL } from "../../../shell/error-pages";
import { escapeHtml } from "../../../shell/frame";
import { contentSecurityPolicy } from "../../../shell/serve";
import { TRACE_ID, testVars } from "../../../shell/test-support";
import { REFUSED_STATUS, REFUSED_WORDS } from "../../guard";
import { WORDS as SEND_WORDS, testPhoneHref } from "../send/page";
import { sendFormOf } from "../send/test-support";
import { ROLE_WORDS, WORDS, pickerHref } from "./page";
import {
  LISTED,
  ROSTER,
  linksIn,
  mockPickerShell,
  open,
  rowsAfter,
  sessionOf,
  stubPickerShell,
} from "./test-support";

/** The fixture's page envelope: its request id, trace id and session token. */
const PAGE = ROSTER.request.page;

/** test-roster.json's barbershop, as the page writes its name. */
const BARBERSHOP = escapeHtml("Lee's Barbershop");

/** What the picker shows for each of test-roster.json's phones, in the answer's order, written out. */
const FIXTURE_PHONES = [
  {
    label: "Test owner 1",
    testPhoneId: "tp-01",
    role: "Owner",
    business: BARBERSHOP,
    customer: "No seeded customer",
  },
  {
    label: "Test staff 1",
    testPhoneId: "tp-02",
    role: "Staff",
    business: BARBERSHOP,
    customer: "No seeded customer",
  },
  {
    label: "Test customer 1",
    testPhoneId: "tp-03",
    role: "Customer",
    business: BARBERSHOP,
    customer: "Alex M.",
  },
  {
    label: "Test customer 2",
    testPhoneId: "tp-04",
    role: "Second customer",
    business: BARBERSHOP,
    customer: "No seeded customer",
  },
  {
    label: "STOP test phone",
    testPhoneId: "tp-05",
    role: "The STOP phone",
    business: "None",
    customer: "No seeded customer",
  },
] as const;

/** What the picker shows for each of test-roster.json's businesses, in the answer's order, written out. */
const FIXTURE_BUSINESSES = [
  {
    name: BARBERSHOP,
    state: "Signed up. Live.",
    flow: "A",
    kinds: "barber",
    zone: "America/New_York",
    hours: "08:00 to 20:00",
  },
  {
    name: "Lee Home Services",
    state: "Signed up. Live.",
    flow: "B",
    kinds: "plumber, electrician",
    zone: "America/New_York",
    hours: "08:00 to 20:00",
  },
] as const;

/** The STOP phone's mark, as its row holds it. */
const STOP_MARK = `<p><strong>${WORDS.stopMark}</strong> ${escapeHtml(WORDS.stopLine)}</p>`;
/** A stopped phone's mark, as its row holds it. */
const STOPPED_MARK = `<p><strong>${WORDS.stoppedMark}</strong> ${escapeHtml(WORDS.stoppedLine)}</p>`;

/** The last four digits test-roster.json gives the phone with this roster id. */
function last4Of(testPhoneId: string): string {
  const phone = LISTED.phones.find((listed) => listed.testPhoneId === testPhoneId);
  if (phone === undefined) throw new Error(`test-roster.json lists no ${testPhoneId}`);
  return phone.last4;
}

/** A phone's description list as its row holds it. */
function phoneDetails(want: {
  testPhoneId: string;
  role: string;
  last4: string;
  business: string;
  customer: string;
}): string[] {
  return [
    "<dl>",
    `<dt>${WORDS.rosterId}</dt><dd><code>${want.testPhoneId}</code></dd>`,
    `<dt>${WORDS.role}</dt><dd>${want.role}</dd>`,
    `<dt>${WORDS.number}</dt><dd>${WORDS.ending} ${want.last4}</dd>`,
    `<dt>${WORDS.business}</dt><dd>${want.business}</dd>`,
    `<dt>${WORDS.seededCustomer}</dt><dd>${want.customer}</dd>`,
    "</dl>",
  ];
}

/** The picker as a signed-in tester opens it over the Tool API mock: test-roster.json's request and answer. */
async function openFixture(): Promise<
  ReturnType<typeof mockPickerShell> & { response: Response; html: string }
> {
  const made = mockPickerShell({ traceId: PAGE.traceId, requestIds: [PAGE.requestId] });
  const response = await made.shell.fetch(open(pickerHref(made.config), sessionOf(made.config)));
  return { ...made, response, html: await response.text() };
}

/** The picker as a signed-in tester opens it over `answer`, a K-21 v1 testRoster outcome no frozen fixture shows. */
async function openWith(
  answer: OutcomeOf<"testRoster">,
): Promise<ReturnType<typeof stubPickerShell> & { response: Response; html: string }> {
  const made = stubPickerShell(answer);
  const response = await made.shell.fetch(open(pickerHref(made.config), sessionOf(made.config)));
  return { ...made, response, html: await response.text() };
}

describe("with the listing call's fixture, the picker lists each seeded business and test phone with its role", () => {
  it("opening the picker sends test-roster.json's request, a read under the page request's trace id, and answers 200", async () => {
    const { response, transport, lines } = await openFixture();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-trace-id")).toBe(PAGE.traceId);
    expect(transport.sent).toEqual([{ call: "testRoster", request: ROSTER.request, traceId: PAGE.traceId }]);
    expect(lines()).toEqual([
      { level: "info", msg: "page", trace_id: PAGE.traceId, route: "testPhone.phones", status: 200 },
    ]);
  });

  it("lists each test phone in the answer's order: what it texts as, its roster id, its role, its last four digits, its business, its seeded customer and its link", async () => {
    const { html } = await openFixture();
    expect(html).toContain(`<h1>${WORDS.title}</h1>`);
    const rows = rowsAfter(html, WORDS.phonesHeading);
    expect(rows).toEqual(
      FIXTURE_PHONES.map((want) =>
        [
          `<h3>${want.label}</h3>`,
          ...(want.testPhoneId === "tp-05" ? [STOP_MARK] : []),
          ...phoneDetails({ ...want, last4: last4Of(want.testPhoneId) }),
          `<p><a href="/test/staging/test-phone?phone=${want.testPhoneId}">${WORDS.sendAs}</a></p>`,
        ].join("\n"),
      ),
    );
  });

  it("names every role K-21 v1 gives, each once: owner, staff, customer, second customer and the STOP phone", async () => {
    expect(LISTED.phones.map((phone) => phone.role)).toEqual([
      "owner",
      "staff",
      "customer",
      "secondCustomer",
      "stop",
    ]);
    expect(ROLE_WORDS).toEqual({
      owner: "Owner",
      staff: "Staff",
      customer: "Customer",
      secondCustomer: "Second customer",
      stop: "The STOP phone",
    });
    const { html } = await openFixture();
    const roles = rowsAfter(html, WORDS.phonesHeading).map(
      (row) => new RegExp(`<dt>${WORDS.role}</dt><dd>([^<]*)</dd>`).exec(row)?.[1],
    );
    expect(roles).toEqual(["Owner", "Staff", "Customer", "Second customer", "The STOP phone"]);
  });

  it("marks the STOP phone plainly, and no other; none of the fixture's phones is stopped", async () => {
    const { html } = await openFixture();
    const rows = rowsAfter(html, WORDS.phonesHeading);
    const marked = rows.filter((row) => row.includes(STOP_MARK));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("<code>tp-05</code>");
    expect(rows.filter((row) => row.includes(WORDS.stopMark))).toEqual(marked);
    expect(WORDS.stopLine).toContain("texting START");
    expect(html).not.toContain(WORDS.stoppedMark);
  });

  it("lists each seeded test business in the answer's order: signed up and live, as the fixture has both, with its flow, kinds of work, time zone and text hours", async () => {
    const { html } = await openFixture();
    expect(rowsAfter(html, WORDS.businessesHeading)).toEqual(
      FIXTURE_BUSINESSES.map((want) =>
        [
          `<h3>${want.name}</h3>`,
          `<p>${want.state}</p>`,
          "<dl>",
          `<dt>${WORDS.flow}</dt><dd>${want.flow}</dd>`,
          `<dt>${WORDS.kinds}</dt><dd>${want.kinds}</dd>`,
          `<dt>${WORDS.zone}</dt><dd>${want.zone}</dd>`,
          `<dt>${WORDS.textHours}</dt><dd>${want.hours}</dd>`,
          "</dl>",
        ].join("\n"),
      ),
    );
  });
});

describe("choosing a phone sets it for the send side", () => {
  it("each phone's link opens the test-phone page with that phone chosen: T-523's own routes answer it, ready to send as that phone", async () => {
    const { shell, config, transport, html } = await openFixture();
    const links = rowsAfter(html, WORDS.phonesHeading).map(linksIn);
    expect(links).toHaveLength(FIXTURE_PHONES.length);
    for (const [at, { testPhoneId }] of FIXTURE_PHONES.entries()) {
      // One link per row, to the test-phone page with the phone's roster id in the address and nothing else.
      expect(links[at], testPhoneId).toEqual([
        { href: `/test/staging/test-phone?phone=${testPhoneId}`, words: WORDS.sendAs },
      ]);
      const href = links[at]?.[0]?.href ?? "";
      expect(href, testPhoneId).toBe(testPhoneHref(config, testPhoneId));

      // Following it, as the tester's browser does, opens the send page with that phone chosen.
      const response = await shell.fetch(open(href, sessionOf(config)));
      expect(response.status, testPhoneId).toBe(200);
      const page = await response.text();
      const form = sendFormOf(page);
      // The send form holds that phone beside its own request id (a random one: T-523's routes as the Worker makes them).
      const fields = hiddenFields(form);
      expect(Object.keys(fields), testPhoneId).toEqual(["requestId", "phone"]);
      expect(fields.phone, testPhoneId).toBe(testPhoneId);
      expect(form, testPhoneId).not.toContain("disabled");
      expect(form, testPhoneId).toContain(`<button>${SEND_WORDS.sendAs} ${testPhoneId}</button>`);
      expect(page, testPhoneId).toContain(`<p>${SEND_WORDS.sendingAs} <code>${testPhoneId}</code>.</p>`);
    }
    // Opening the send page makes no call: the picker's one read is the only call.
    expect(transport.sent.map((sent) => sent.call)).toEqual(["testRoster"]);
  });

  it("a roster id with characters an address or HTML must escape comes through the link as it is", async () => {
    const testPhoneId = 'tp-<b>&"0?#';
    const phone = LISTED.phones[0];
    if (phone === undefined) throw new Error("test-roster.json lists a phone");
    const { shell, config, html } = await openWith({ ...LISTED, phones: [{ ...phone, testPhoneId }] });
    const [row] = rowsAfter(html, WORDS.phonesHeading);
    expect(row).toContain(`<dt>${WORDS.rosterId}</dt><dd><code>${escapeHtml(testPhoneId)}</code></dd>`);
    const [link] = linksIn(row ?? "");
    expect(link?.href).toBe(testPhoneHref(config, testPhoneId));
    const page = await (await shell.fetch(open(link?.href ?? "", sessionOf(config)))).text();
    expect(hiddenFields(sendFormOf(page)).phone).toBe(testPhoneId);
  });
});

/** test-roster.json's answer as it stands before the F14 setup seeds and the F15 customer seeds (CQ-14). */
const BEFORE_SEEDS: ResponseOf<"testRoster"> = {
  ...LISTED,
  businesses: LISTED.businesses.map((business) => ({ ...business, signedUp: false, live: false })),
  phones: LISTED.phones.map((phone) => ({ ...phone, seededCustomer: null })),
};

describe("before the F14 and F15 seeds land, businesses show as not yet signed up and phones as having no seeded customer (CQ-14)", () => {
  const NO_CUSTOMER = `<dt>${WORDS.seededCustomer}</dt><dd>${WORDS.noSeededCustomer}</dd>`;

  it("test-roster.json's own second customer, whose F15 seed has not landed, shows no seeded customer", async () => {
    expect(LISTED.phones.map((phone) => phone.seededCustomer?.name ?? null)).toEqual([
      null,
      null,
      "Alex M.",
      null,
      null,
    ]);
    const { html } = await openFixture();
    const rows = rowsAfter(html, WORDS.phonesHeading);
    expect(rows[3]).toContain("<code>tp-04</code>");
    expect(rows[3]).toContain(NO_CUSTOMER);
    expect(rows[2]).toContain(`<dt>${WORDS.seededCustomer}</dt><dd>Alex M.</dd>`);
  });

  it("the fixture's answer before both seeds: every business not yet signed up, every phone with no seeded customer, each still a phone to send as", async () => {
    const { response, html, sent, config } = await openWith(BEFORE_SEEDS);
    expect(response.status).toBe(200);
    expect(sent.map((call) => call.call)).toEqual(["testRoster"]);
    const businesses = rowsAfter(html, WORDS.businessesHeading);
    expect(businesses).toHaveLength(BEFORE_SEEDS.businesses.length);
    for (const row of businesses) {
      expect(row).toContain(`<p>${WORDS.notSignedUp} ${WORDS.notLive}</p>`);
      expect(row).not.toContain(`<p>${WORDS.signedUp}`);
    }
    const phones = rowsAfter(html, WORDS.phonesHeading);
    expect(phones).toHaveLength(BEFORE_SEEDS.phones.length);
    for (const [at, row] of phones.entries()) {
      expect(row).toContain(NO_CUSTOMER);
      const testPhoneId = BEFORE_SEEDS.phones[at]?.testPhoneId ?? "";
      expect(linksIn(row)).toEqual([{ href: testPhoneHref(config, testPhoneId), words: WORDS.sendAs }]);
    }
    expect(html).not.toContain("Alex M.");
  });

  it("each row shows its own state as the answer gives it, never another row's", async () => {
    const mixed: ResponseOf<"testRoster"> = {
      ...LISTED,
      businesses: LISTED.businesses.map((business, at) => ({
        ...business,
        signedUp: at === 1,
        live: at === 1,
      })),
      phones: LISTED.phones.map((phone) => ({
        ...phone,
        seededCustomer:
          phone.testPhoneId === "tp-04"
            ? { customerId: "customer-dummy-0001", name: "Dummy Customer" }
            : null,
      })),
    };
    const { html } = await openWith(mixed);
    const businesses = rowsAfter(html, WORDS.businessesHeading);
    expect(businesses[0]).toContain(`<p>${WORDS.notSignedUp} ${WORDS.notLive}</p>`);
    expect(businesses[1]).toContain(`<p>${WORDS.signedUp} ${WORDS.live}</p>`);
    const customers = rowsAfter(html, WORDS.phonesHeading).map(
      (row) => new RegExp(`<dt>${WORDS.seededCustomer}</dt><dd>([^<]*)</dd>`).exec(row)?.[1],
    );
    expect(customers).toEqual([
      WORDS.noSeededCustomer,
      WORDS.noSeededCustomer,
      WORDS.noSeededCustomer,
      "Dummy Customer",
      WORDS.noSeededCustomer,
    ]);
  });
});

describe("the picker sits behind the tester login (T-520)", () => {
  /** Holds a page to the one that asks for sign-in, listing nothing. */
  function expectSignInFirst(html: string, signIn: string): void {
    expect(html).toContain(`<h1>${WORDS.signInTitle}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.signInLine)}</p>`);
    expect(html).toContain(`<p><a href="${signIn}">${WORDS.signIn}</a></p>`);
    expect(html).not.toContain(WORDS.phonesHeading);
    expect(html).not.toContain(WORDS.sendAs);
  }

  it("opened with no session cookie: the page asks for sign-in, lists nothing and makes no call", async () => {
    const { shell, config, transport } = mockPickerShell();
    const response = await shell.fetch(open(pickerHref(config)));
    expect(response.status).toBe(200);
    expectSignInFirst(await response.text(), startHref(config, null));
    expect(transport.sent).toEqual([]);
  });

  it("a cookie that does not read as a token, or production's own cookie: the same, with no call", async () => {
    const { shell, config, transport } = mockPickerShell();
    const production = readWebConfig(testVars("production"));
    expect(cookieNames(production).session).not.toBe(cookieNames(config).session);
    for (const cookie of [sessionOf(config, "dummy-short"), sessionOf(production)]) {
      const response = await shell.fetch(open(pickerHref(config), cookie));
      expect(response.status).toBe(200);
      expectSignInFirst(await response.text(), startHref(config, null));
    }
    expect(transport.sent).toEqual([]);
  });

  it("signInNeeded (no live session came): the page asks for sign-in again, 403, listing nothing", async () => {
    const { response, html, config, sent } = await openWith({ error: "signInNeeded" });
    expect(response.status).toBe(403);
    expectSignInFirst(html, startHref(config, null));
    expect(sent).toHaveLength(1);
  });
});

describe("each other answer K-21 v1 gives testRoster has its page", () => {
  it("notTester: the account is neither a tester nor on Rosie's team, 403, listing nothing", async () => {
    const { response, html, config } = await openWith({ error: "notTester" });
    expect(response.status).toBe(403);
    expect(html).toContain(`<h1>${WORDS.notTesterTitle}</h1>`);
    expect(html).toContain(`<p>${escapeHtml(WORDS.notTesterLine)}</p>`);
    expect(html).toContain(`<p><a href="${startHref(config, null)}">${WORDS.signInAsOther}</a></p>`);
    expect(html).not.toContain(WORDS.phonesHeading);
  });

  it("stagingOnly (the server is not on staging): the staging-only guard's refused page, never a list", async () => {
    const { response, html } = await openWith({ error: "stagingOnly" });
    expect(response.status).toBe(REFUSED_STATUS);
    expect(html).toContain(`<h1>${REFUSED_WORDS.title}</h1>`);
    for (const line of REFUSED_WORDS.lines) expect(html).toContain(`<p>${escapeHtml(line)}</p>`);
    expect(html).toContain(`<p>${REFERENCE_LABEL}: <code>${TRACE_ID}</code></p>`);
    expect(html).not.toContain(WORDS.phonesHeading);
  });

  it("transient: nothing was read; 503, said plainly, with a link that opens the picker again", async () => {
    const { response, html, config } = await openWith({ error: "transient", sqlstate: "40001" });
    expect(response.status).toBe(503);
    expect(html).toContain(`<p role="alert">${escapeHtml(WORDS.tryAgainLine)}</p>`);
    expect(linksIn(html)).toContainEqual({ href: pickerHref(config), words: WORDS.tryAgain });
    expect(pickerHref(config)).toBe("/test/staging/test-phone/phones");
    expect(html).not.toContain(WORDS.phonesHeading);
  });
});

describe("rows the answer shapes in other ways show as it gives them", () => {
  it("a phone whose texts are stopped is marked plainly as stopped", async () => {
    const { html } = await openWith({
      ...LISTED,
      phones: LISTED.phones.map((phone) => ({ ...phone, stopped: phone.role === "stop" })),
    });
    const rows = rowsAfter(html, WORDS.phonesHeading);
    expect(rows.map((row) => row.includes(STOPPED_MARK))).toEqual([false, false, false, false, true]);
    expect(rows[4]).toContain(`${STOP_MARK}\n${STOPPED_MARK}\n<dl>`);
  });

  it("a phone seated at a business the answer does not list shows that business's id as given; one seated nowhere shows none", async () => {
    const [first, ...rest] = LISTED.phones;
    if (first === undefined) throw new Error("test-roster.json lists a phone");
    const { html } = await openWith({
      ...LISTED,
      phones: [{ ...first, businessId: "biz-dummy-unlisted" }, ...rest],
    });
    const businessOf = (row: string | undefined): string | undefined =>
      new RegExp(`<dt>${WORDS.business}</dt><dd>(.*?)</dd>`).exec(row ?? "")?.[1];
    const rows = rowsAfter(html, WORDS.phonesHeading);
    expect(businessOf(rows[0])).toBe("<code>biz-dummy-unlisted</code>");
    expect(businessOf(rows[1])).toBe(BARBERSHOP);
    expect(businessOf(rows[4])).toBe(WORDS.noBusiness);
  });

  it("an answer that lists no phone and no business says so under each heading; a business with no kind of work shows none", async () => {
    const empty = await openWith({ result: "testRoster", businesses: [], phones: [] });
    expect(empty.response.status).toBe(200);
    for (const heading of [WORDS.phonesHeading, WORDS.businessesHeading]) {
      expect(rowsAfter(empty.html, heading)).toEqual([]);
      expect(empty.html).toContain(`<h2>${heading}</h2>\n<p>${WORDS.noneListed}</p>`);
    }
    const [business] = LISTED.businesses;
    if (business === undefined) throw new Error("test-roster.json lists a business");
    const { html } = await openWith({ ...LISTED, businesses: [{ ...business, kindIds: [] }] });
    expect(rowsAfter(html, WORDS.businessesHeading)[0]).toContain(
      `<dt>${WORDS.kinds}</dt><dd>${WORDS.noKinds}</dd>`,
    );
  });

  it("every value from the answer shows as text, never as markup", async () => {
    const { html } = await openWith({
      result: "testRoster",
      businesses: [
        {
          businessId: "biz-<b>",
          name: '<script>alert("dummy")</script> & Co',
          flow: "A",
          kindIds: ["kind-<i>"],
          signedUp: true,
          live: false,
          zone: "Zone/<u>",
          textHours: { start: "<s>", end: "&lt;" },
        },
      ],
      phones: [
        {
          testPhoneId: "tp-<em>",
          last4: "<i>",
          role: "customer",
          label: "Label <u>dummy</u>",
          businessId: "biz-<b>",
          personId: null,
          seededCustomer: { customerId: "customer-<b>", name: "<em>Dummy</em>" },
          linqContact: true,
          stopped: false,
          textHoursOverride: { on: false, version: null },
        },
      ],
    });
    for (const markup of ["<script", "<b>", "<i>", "<u>", "<s>", "<em>"]) expect(html).not.toContain(markup);
    expect(html).toContain("<h3>&lt;script&gt;alert(&quot;dummy&quot;)&lt;/script&gt; &amp; Co</h3>");
    expect(html).toContain("<h3>Label &lt;u&gt;dummy&lt;/u&gt;</h3>");
    expect(html).toContain(`<dd><code>tp-&lt;em&gt;</code></dd>`);
    expect(html).toContain(`<dd>${WORDS.ending} &lt;i&gt;</dd>`);
    expect(html).toContain("<dd>&lt;script&gt;alert(&quot;dummy&quot;)&lt;/script&gt; &amp; Co</dd>");
    expect(html).toContain("<dd>&lt;em&gt;Dummy&lt;/em&gt;</dd>");
    expect(html).toContain("<dd>kind-&lt;i&gt;</dd>");
    expect(html).toContain("<dd>Zone/&lt;u&gt;</dd>");
    expect(html).toContain(`<dd>&lt;s&gt; ${WORDS.textHoursTo} &amp;lt;</dd>`);
  });
});

/** Every page the picker answers with, each with what it is: signed out, each answer's page and each list. */
async function everyPage(): Promise<{ what: string; response: Response }[]> {
  const pages: { what: string; response: Response }[] = [];
  const { shell, config } = mockPickerShell({ traceId: PAGE.traceId, requestIds: [PAGE.requestId] });
  pages.push({ what: "signed out", response: await shell.fetch(open(pickerHref(config))) });
  pages.push({
    what: "the fixture",
    response: await shell.fetch(open(pickerHref(config), sessionOf(config))),
  });
  const answers: { what: string; answer: OutcomeOf<"testRoster"> }[] = [
    { what: "before the seeds", answer: BEFORE_SEEDS },
    {
      what: "stopped",
      answer: { ...LISTED, phones: LISTED.phones.map((phone) => ({ ...phone, stopped: true })) },
    },
    { what: "empty", answer: { result: "testRoster", businesses: [], phones: [] } },
    { what: "stagingOnly", answer: { error: "stagingOnly" } },
    { what: "signInNeeded", answer: { error: "signInNeeded" } },
    { what: "notTester", answer: { error: "notTester" } },
    { what: "transient", answer: { error: "transient", sqlstate: "40001" } },
  ];
  for (const { what, answer } of answers) {
    const stub = stubPickerShell(answer);
    pages.push({
      what,
      response: await stub.shell.fetch(open(pickerHref(stub.config), sessionOf(stub.config))),
    });
  }
  return pages;
}

describe("what no page of the picker holds", () => {
  it("no form, script, session token or phone number beyond the last four digits the answer gives; no cookie set; no form may post", async () => {
    const pages = await everyPage();
    expect(pages).toHaveLength(9);
    expect([...new Set(pages.map((page) => page.response.status))].sort((a, b) => a - b)).toEqual([
      200, 403, 503,
    ]);
    for (const { what, response } of pages) {
      expect(response.headers.has("set-cookie"), what).toBe(false);
      expect(response.headers.get("content-security-policy"), what).toBe(contentSecurityPolicy());
      const html = await response.text();
      for (const held of ["<form", "<input", "<button", "<script", PAGE.sessionToken])
        expect(html, what).not.toContain(held);
      // No run of more than four digits: a number shows as the last four digits the answer gives, never more.
      expect(html, what).not.toMatch(/[0-9]{5}/);
    }
  });

  it("its code reaches no number, signer or secret: the folder's own files import only the web app's shell, client, sign-in, staging guard and the send page's address", () => {
    const folder = fileURLToPath(new URL("./", import.meta.url));
    const shipped = readdirSync(folder)
      .filter((name) => !name.endsWith(".test.ts") && name !== "test-support.ts")
      .sort();
    expect(shipped).toEqual(["page.ts", "picker.ts", "routes.ts"]);
    const allowed = [
      "../../../auth/cookies",
      "../../../auth/pages",
      "../../../client/calls",
      "../../../shell/config",
      "../../../shell/frame",
      "../../../shell/route",
      "../../guard",
      "../send/page",
      "./page",
      "./picker",
    ];
    const imported = new Set<string>();
    for (const name of shipped) {
      const source = readFileSync(`${folder}${name}`, "utf8");
      for (const match of source.matchAll(/^import [^;]* from "([^"]+)";$/gm)) imported.add(match[1] ?? "");
      // No other way in: no dynamic import, no require, no Worker env.
      expect(source, name).not.toMatch(/\bimport\(|\brequire\(|\bprocess\.env\b|cloudflare:workers/);
    }
    expect([...imported].sort()).toEqual(allowed);
  });
});
